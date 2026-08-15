/**
 * MCP 设置弹窗 —— React 版,逐行对照 legacy/pages/workbench/sidebar/mcp-modal.ts。
 * 服务器卡片「更多 → MCP」入口(ServersPanel 调用);openMcpModal 签名与旧版一致,
 * 命令式实现:createRoot 挂载到 body,关闭(淡出 160ms)后卸载。
 * 内容:设备主开关(启用 = 加入 MCP 可发现设备列表)+ 分组功能开关 + 接入信息
 * (Endpoint URL / Bearer 令牌 / 服务状态 / 客户端配置 JSON)。
 * 交互契约:开关即时保存(change → setMcpDevice → 失败回滚);服务器被锁定(locked=true,
 * 不允许 AI 访问)时入口禁用且弹窗内兜底显示锁定横幅;打开期间 project-changed 实时跟随。
 * 接口点:src/api.ts 的 mcp 段(setMcpDevice / getMcpStatus / mcpEnsureToken / mcpResetToken);
 * 数据模型 src/types.ts(McpFeatures / McpDeviceConfig / McpStatus)。
 * 样式:mcp.css 布局,开关复用 servers.css 的 .db-switch(由 ServersPanel 引入)。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { McpDeviceConfig, McpFeatures, Server } from '../../../types';
import { getMcpStatus, getState, mcpEnsureToken, mcpResetToken, setMcpDevice } from '../../../api';
import { wbEvents } from '../../../stores/workbench';
import { confirmDialog, copyText, toast } from '../../../ui';
import { Icon } from '../../../shared/Icon';
import './mcp.css';

/** 功能开关分组(与 store.rs McpFeatures / 后端工具一一对应) */
const FEATURE_GROUPS: { title: string; hint?: string; items: { key: keyof McpFeatures; label: string; hint?: string; danger?: boolean }[] }[] = [
  {
    title: 'SFTP 文件管理',
    items: [
      { key: 'sftpList', label: '目录查询', hint: 'sftp_list：列目录与文件属性' },
      { key: 'sftpUpload', label: '上传', hint: 'sftp_upload：从本机 MCP 传输目录上传到远端' },
      { key: 'sftpDownload', label: '下载', hint: 'sftp_download：下载到本机 MCP 传输目录' },
      { key: 'sftpRename', label: '重命名 / 移动', hint: 'sftp_rename：目标已存在时报错' },
      { key: 'sftpDelete', label: '删除', hint: 'sftp_delete：目录递归删除', danger: true },
    ],
  },
  {
    title: '远程文件内容',
    items: [
      { key: 'fileRead', label: '读取', hint: 'read_file：文本内容直接返回给 agent（>5MB/二进制拒绝）' },
      { key: 'fileWrite', label: '写入', hint: 'write_file：整体覆写，支持新建与冲突检测' },
      { key: 'fileEdit', label: '编辑', hint: 'edit_file：oldText→newText 精确替换（不新建文件）' },
    ],
  },
  {
    title: '命令执行',
    hint: '危险：MCP 工具调用不经 AI 审批流程',
    items: [
      { key: 'exec', label: '执行远程命令', hint: 'exec_command：默认 30 秒超时，仅授信 agent 启用', danger: true },
    ],
  },
  {
    title: '数据库',
    items: [
      { key: 'dbQuery', label: '数据库管道查询', hint: 'db_query：仅暴露已启用的连接，命令白名单与 AI 通道一致，凭据系统代管' },
    ],
  },
];

function emptyFeatures(): McpFeatures {
  return {
    sftpList: false, sftpUpload: false, sftpDownload: false, sftpRename: false, sftpDelete: false,
    fileRead: false, fileWrite: false, fileEdit: false, exec: false, dbQuery: false,
  };
}

function McpModal({ server, onClosed }: { server: Server; onClosed: () => void }): JSX.Element {
  /* 打开期间状态(初始值与 legacy 一致:cfg=null 按未启用渲染,refresh 后覆盖) */
  const [cfg, setCfg] = useState<McpDeviceConfig | null>(null);
  const [locked, setLocked] = useState(server.locked);
  const [port, setPort] = useState(8945);
  const [tokenShown, setTokenShown] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<{ icon: 'circle' | 'alert'; text: string; cls: string } | null>(null);
  const [open, setOpen] = useState(false);
  /** 保存中防抖(与 legacy busy 同语义;用 ref 避免闭包过期) */
  const busyRef = useRef(false);

  /* 淡入 */
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  /* 服务状态行(监听中/端口占用/无启用设备) */
  const refreshStatus = async (): Promise<void> => {
    try {
      const st = await getMcpStatus();
      if (st.running) {
        setStatus({ icon: 'circle', text: `服务运行中：127.0.0.1:${st.boundPort ?? st.port}（已启用设备 ${st.deviceCount} 台）`, cls: 'ok' });
      } else if (st.error) {
        setStatus({ icon: 'alert', text: `服务启动失败：${st.error}`, cls: 'err' });
      } else {
        setStatus({ icon: 'circle', text: '服务未运行（当前无已启用设备）', cls: '' });
      }
    } catch {
      setStatus({ icon: 'alert', text: '无法获取服务状态', cls: 'err' });
    }
  };

  /** 从后端拉最新服务器/设备配置/端口;project-changed 实时跟随锁定态 */
  const refresh = async (): Promise<void> => {
    try {
      const state = await getState();
      const fresh = state.servers.find((s) => s.id === server.id);
      setLocked(fresh?.locked ?? true);
      setPort(state.mcp?.port ?? 8945);
      setCfg(state.mcpDevices[server.id] ?? { enabled: false, features: emptyFeatures() });
    } catch (err) {
      toast(`读取状态失败: ${String(err)}`, 'error');
    }
    void refreshStatus();
  };

  /* 打开即拉取最新状态;打开期间 project-changed(锁定/配置/端口变化)实时跟随 */
  useEffect(() => {
    void refresh();
    return wbEvents.on('project-changed', () => void refresh());
  }, []);

  /** 即时保存;失败回滚开关状态并提示(React 版回滚 = cfg 状态不更新,受控开关自动弹回) */
  const save = async (next: McpDeviceConfig): Promise<void> => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await setMcpDevice(server.id, next);
      setCfg(next);
      toast(next.enabled ? '已启用，服务器加入 MCP 可发现设备列表' : '已停用 MCP', 'success');
      wbEvents.emit('project-changed'); // 卡片标签同步
      void refreshStatus();
    } catch (err) {
      toast(`保存 MCP 设置失败: ${String(err)}`, 'error');
      void refreshStatus();
    } finally {
      busyRef.current = false;
    }
  };

  const close = (): void => {
    setOpen(false);
    setTimeout(onClosed, 160); // 淡出后再卸载
  };

  const enabled = cfg?.enabled ?? false;
  const features = cfg?.features ?? emptyFeatures();
  const masterTitle = enabled
    ? '点击停用：从 MCP 可发现设备列表移除'
    : '点击启用：加入 MCP 可发现设备列表';
  const tokenValue = tokenShown && token ? token : '••••••••••••••••••••••••••••••••';
  const clientExample = `{ "url": "http://127.0.0.1:${port}/mcp", "headers": { "Authorization": "Bearer <令牌>" } }`;

  return (
    <div
      className={`modal-mask${open ? ' open' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="modal mcp-modal">
        <div className="modal-head">
          <h3>MCP 服务 · {server.name}</h3>
          <button className="icon-btn" title="关闭" onClick={close}><Icon name="x" /></button>
        </div>
        <div className="modal-body">
          {locked ? (
            <div className="mcp-lock-banner"><Icon name="lock" /> 该服务器已被 AI 锁定（不允许 AI 访问），MCP 不可用。请先解锁服务器。</div>
          ) : null}
          <div className="mcp-master-row">
            <label className="db-switch" title={masterTitle}>
              <input
                type="checkbox"
                checked={enabled}
                disabled={locked}
                onChange={(e) => { if (cfg) void save({ ...cfg, enabled: e.currentTarget.checked }); }}
              />
              <span className="db-switch-track"></span>
            </label>
            <div className="mcp-master-text">
              <div className="mcp-master-title">启用 MCP（加入可发现设备列表）</div>
              <div className="mcp-master-hint">启用后，外部 agent 工具可经本机 MCP 端点发现并操作该服务器（受下方功能开关约束）</div>
            </div>
          </div>
          <div className={`mcp-features${enabled && !locked ? '' : ' muted'}`}>
            {FEATURE_GROUPS.map((g) => (
              <div className="mcp-feature-group" key={g.title}>
                <div className="mcp-feature-title">
                  {g.title}
                  {g.hint ? <span className="mcp-feature-danger-hint">{g.hint}</span> : null}
                </div>
                {g.items.map((it) => (
                  <div className={`mcp-feature-row${it.danger ? ' danger' : ''}`} key={it.key}>
                    <label className="db-switch">
                      <input
                        type="checkbox"
                        checked={features[it.key]}
                        disabled={!enabled || locked}
                        onChange={(e) => {
                          if (!cfg) return;
                          void save({ ...cfg, features: { ...cfg.features, [it.key]: e.currentTarget.checked } });
                        }}
                      />
                      <span className="db-switch-track"></span>
                    </label>
                    <div className="mcp-feature-text">
                      <div className="mcp-feature-label">{it.label}</div>
                      <div className="mcp-feature-hint">{it.hint ?? ''}</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className={`mcp-access${enabled && !locked ? '' : ' hidden'}`}>
            <div className="mcp-section-title">接入信息（其他 agent 工具配置用）</div>
            <div className={`mcp-status-row${status?.cls ? ` ${status.cls}` : ''}`}>
              {status ? <><Icon name={status.icon} /> {status.text}</> : null}
            </div>
            <div className="mcp-field">
              <div className="mcp-field-label">Endpoint URL</div>
              <div className="mcp-field-row">
                <input className="input mono" readOnly value={`http://127.0.0.1:${port}/mcp`} />
                <button className="btn small" onClick={() => {
                  void copyText(`http://127.0.0.1:${port}/mcp`).then(() => toast('已复制 Endpoint URL', 'success'));
                }}><Icon name="copy" /> 复制</button>
              </div>
            </div>
            <div className="mcp-field">
              <div className="mcp-field-label">Bearer 令牌（每次请求鉴权；重置后旧令牌立即失效）</div>
              <div className="mcp-field-row">
                <input className="input mono" readOnly value={tokenValue} />
                <button className="btn small" onClick={() => {
                  if (tokenShown) {
                    setTokenShown(false);
                    return;
                  }
                  void mcpEnsureToken()
                    .then((t) => { setToken(t); setTokenShown(true); })
                    .catch((err) => toast(`读取令牌失败: ${String(err)}`, 'error'));
                }}>{tokenShown ? <Icon name="eyeOff" /> : <Icon name="eye" />} {tokenShown ? '隐藏' : '显示'}</button>
                {tokenShown && token ? (
                  <button className="btn small" onClick={() => {
                    if (token) void copyText(token).then(() => toast('已复制令牌', 'success'));
                  }}><Icon name="copy" /> 复制</button>
                ) : null}
                <button className="btn small" onClick={() => {
                  void confirmDialog({
                    title: '重新生成 MCP 令牌',
                    message: '重新生成后，已配置到其他工具的旧令牌将立即失效，需要更新客户端配置。确定继续吗？',
                    danger: true,
                    okText: '重新生成',
                  }).then((ok) => {
                    if (!ok) return;
                    void mcpResetToken()
                      .then((t) => { setToken(t); setTokenShown(true); toast('令牌已重新生成', 'success'); })
                      .catch((err) => toast(`重新生成失败: ${String(err)}`, 'error'));
                  });
                }}><Icon name="refresh" /> 重新生成</button>
              </div>
            </div>
            <div className="mcp-field">
              <div className="mcp-field-label">客户端配置示例（JSON）</div>
              <div className="mcp-field-row">
                <input className="input mono" readOnly value={clientExample} />
                <button className="btn small" onClick={() => {
                  const json = JSON.stringify({
                    url: `http://127.0.0.1:${port}/mcp`,
                    headers: { Authorization: `Bearer ${token ?? '<令牌>'}` },
                  }, null, 2);
                  void copyText(json).then(() => toast('已复制客户端配置', 'success'));
                }}><Icon name="copy" /> 复制</button>
              </div>
            </div>
            <div className="mcp-hint">仅监听本机回环（127.0.0.1），不对外网开放。传输目录（上传源/下载落地）：工作区 .aishell/mcp-transfer 或应用配置目录。</div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={close}>关闭</button>
        </div>
      </div>
    </div>
  );
}

/**
 * MCP 设置弹窗命令式入口(与 legacy 同签名):createRoot 挂载到 body,
 * 组件淡出后卸载并移除宿主节点;调用方签名与交互不变。
 */
export function openMcpModal(server: Server): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<McpModal server={server} onClosed={() => { root.unmount(); host.remove(); }} />);
}
