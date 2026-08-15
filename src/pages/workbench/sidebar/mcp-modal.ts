/**
 * MCP 设置弹窗 —— 服务器卡片「更多 → MCP」入口（servers.ts 调用）。
 * 内容：设备主开关（启用 = 加入 MCP 可发现设备列表）+ 分组功能开关 + 接入信息
 * （Endpoint URL / Bearer 令牌 / 服务状态 / 客户端配置 JSON）。
 * 交互契约：开关即时保存（对齐「数据库连接」弹窗：change → setMcpDevice → 失败回滚）；
 * 服务器被锁定（locked=true，不允许 AI 访问）时入口禁用且弹窗内兜底显示锁定横幅。
 * 接口点：src/api.ts 的 mcp 段（setMcpDevice / getMcpStatus / mcpEnsureToken / mcpResetToken）；
 * 数据模型 src/types.ts（McpFeatures / McpDeviceConfig / McpStatus）。
 * 样式：布局在 mcp.css，开关复用 servers.css 的 .db-switch 滑块。
 */
import type { McpDeviceConfig, McpFeatures, Server } from '../../../types';
import { getMcpStatus, getState, mcpEnsureToken, mcpResetToken, setMcpDevice } from '../../../api';
import { bus } from '../core';
import { confirmDialog, copyText, toast } from '../../../ui';
import { icon } from '../../../icons';
import './mcp.css';

const esc = (s: string | number): string =>
  String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);

/** 功能开关分组（与 store.rs McpFeatures / 后端工具一一对应） */
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

export function openMcpModal(server: Server): void {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const root = document.createElement('div');
  root.className = 'modal mcp-modal';
  mask.appendChild(root);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  let offProjectChanged: (() => void) | null = null; // 关闭时反注册（bus 监听随弹窗销毁）
  const close = (): void => {
    offProjectChanged?.();
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
  };
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });

  /* ---------- 状态 ---------- */
  let deviceId = server.id;
  let cfg: McpDeviceConfig | null = null;   // 当前设备配置（null = 后端无记录）
  let locked = server.locked;               // 打开期间实时跟随（bus project-changed）
  let port = 8945;
  let tokenShown = false;                   // 令牌是否已显式展示
  let token: string | null = null;
  let busy = false;                         // 保存中防抖

  /** 从后端拉最新服务器/设备配置/端口 */
  async function refresh(): Promise<void> {
    try {
      const state = await getState();
      const fresh = state.servers.find((s) => s.id === deviceId);
      locked = fresh?.locked ?? true;
      port = state.mcp?.port ?? 8945;
      cfg = state.mcpDevices[deviceId] ?? { enabled: false, features: emptyFeatures() };
    } catch (err) {
      toast(`读取状态失败: ${String(err)}`, 'error');
    }
    render();
  }

  /** 渲染整个弹窗（保持简单：每次全量重建 body） */
  function render(): void {
    const enabled = cfg?.enabled ?? false;
    const features = cfg?.features ?? emptyFeatures();
    root.innerHTML = `
      <div class="modal-head">
        <h3>MCP 服务 · ${esc(server.name)}</h3>
        <button class="icon-btn" data-act="close" title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">
        ${locked ? `
          <div class="mcp-lock-banner">${icon('lock')} 该服务器已被 AI 锁定（不允许 AI 访问），MCP 不可用。请先解锁服务器。</div>` : ''}
        <div class="mcp-master-row">
          <label class="db-switch" title="${enabled ? '点击停用：从 MCP 可发现设备列表移除' : '点击启用：加入 MCP 可发现设备列表'}">
            <input type="checkbox" data-act="master" ${enabled ? 'checked' : ''} ${locked ? 'disabled' : ''}>
            <span class="db-switch-track"></span>
          </label>
          <div class="mcp-master-text">
            <div class="mcp-master-title">启用 MCP（加入可发现设备列表）</div>
            <div class="mcp-master-hint">启用后，外部 agent 工具可经本机 MCP 端点发现并操作该服务器（受下方功能开关约束）</div>
          </div>
        </div>
        <div class="mcp-features${enabled && !locked ? '' : ' muted'}">
          ${FEATURE_GROUPS.map((g) => `
            <div class="mcp-feature-group">
              <div class="mcp-feature-title">${esc(g.title)}${g.hint ? `<span class="mcp-feature-danger-hint">${esc(g.hint)}</span>` : ''}</div>
              ${g.items.map((it) => `
                <div class="mcp-feature-row${it.danger ? ' danger' : ''}">
                  <label class="db-switch">
                    <input type="checkbox" data-feature="${it.key}" ${features[it.key] ? 'checked' : ''} ${enabled && !locked ? '' : 'disabled'}>
                    <span class="db-switch-track"></span>
                  </label>
                  <div class="mcp-feature-text">
                    <div class="mcp-feature-label">${esc(it.label)}</div>
                    <div class="mcp-feature-hint">${esc(it.hint ?? '')}</div>
                  </div>
                </div>`).join('')}
            </div>`).join('')}
        </div>
        <div class="mcp-access${enabled && !locked ? '' : ' hidden'}">
          <div class="mcp-section-title">接入信息（其他 agent 工具配置用）</div>
          <div class="mcp-status-row" data-status></div>
          <div class="mcp-field">
            <div class="mcp-field-label">Endpoint URL</div>
            <div class="mcp-field-row">
              <input class="input mono" readonly value="http://127.0.0.1:${port}/mcp">
              <button class="btn small" data-act="copy-url">${icon('copy')} 复制</button>
            </div>
          </div>
          <div class="mcp-field">
            <div class="mcp-field-label">Bearer 令牌（每次请求鉴权；重置后旧令牌立即失效）</div>
            <div class="mcp-field-row">
              ${tokenShown && token
                ? `<input class="input mono" readonly value="${esc(token)}">`
                : '<input class="input mono" readonly value="••••••••••••••••••••••••••••••••">'}
              <button class="btn small" data-act="toggle-token">${tokenShown ? icon('eyeOff') : icon('eye')} ${tokenShown ? '隐藏' : '显示'}</button>
              ${tokenShown && token ? `<button class="btn small" data-act="copy-token">${icon('copy')} 复制</button>` : ''}
              <button class="btn small" data-act="reset-token">${icon('refresh')} 重新生成</button>
            </div>
          </div>
          <div class="mcp-field">
            <div class="mcp-field-label">客户端配置示例（JSON）</div>
            <div class="mcp-field-row">
              <input class="input mono" readonly value='{ "url": "http://127.0.0.1:${port}/mcp", "headers": { "Authorization": "Bearer <令牌>" } }'>
              <button class="btn small" data-act="copy-example">${icon('copy')} 复制</button>
            </div>
          </div>
          <div class="mcp-hint">仅监听本机回环（127.0.0.1），不对外网开放。传输目录（上传源/下载落地）：工作区 .aishell/mcp-transfer 或应用配置目录。</div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="close">关闭</button>
      </div>`;
    void renderStatus();
    bindEvents();
  }

  /** 服务状态行（监听中/端口占用/无启用设备） */
  async function renderStatus(): Promise<void> {
    const el = root.querySelector('[data-status]') as HTMLElement | null;
    if (!el) return;
    try {
      const st = await getMcpStatus();
      if (st.running) {
        el.innerHTML = `${icon('circle')} 服务运行中：127.0.0.1:${st.boundPort ?? st.port}（已启用设备 ${st.deviceCount} 台）`;
        el.className = 'mcp-status-row ok';
      } else if (st.error) {
        el.innerHTML = `${icon('alert')} 服务启动失败：${esc(st.error)}`;
        el.className = 'mcp-status-row err';
      } else {
        el.innerHTML = `${icon('circle')} 服务未运行（当前无已启用设备）`;
        el.className = 'mcp-status-row';
      }
    } catch {
      el.innerHTML = `${icon('alert')} 无法获取服务状态`;
      el.className = 'mcp-status-row err';
    }
  }

  function bindEvents(): void {
    // 头部 × 与底部「关闭」两个按钮共用 data-act=close，必须全部绑定（querySelector 只取第一个）
    root.querySelectorAll('[data-act=close]').forEach((el) => el.addEventListener('click', close));
    const master = root.querySelector('[data-act=master]') as HTMLInputElement | null;
    master?.addEventListener('change', () => {
      if (!cfg) return;
      const next: McpDeviceConfig = { ...cfg, enabled: master.checked };
      void save(next);
    });
    root.querySelectorAll<HTMLInputElement>('[data-feature]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!cfg) return;
        const key = input.dataset.feature as keyof McpFeatures;
        const next: McpDeviceConfig = {
          ...cfg,
          features: { ...cfg.features, [key]: input.checked },
        };
        void save(next);
      });
    });
    root.querySelector('[data-act=copy-url]')?.addEventListener('click', () => {
      void copyText(`http://127.0.0.1:${port}/mcp`).then(() => toast('已复制 Endpoint URL', 'success'));
    });
    root.querySelector('[data-act=toggle-token]')?.addEventListener('click', () => {
      if (tokenShown) {
        tokenShown = false;
        render();
        return;
      }
      void mcpEnsureToken()
        .then((t) => { token = t; tokenShown = true; render(); })
        .catch((err) => toast(`读取令牌失败: ${String(err)}`, 'error'));
    });
    root.querySelector('[data-act=copy-token]')?.addEventListener('click', () => {
      if (token) void copyText(token).then(() => toast('已复制令牌', 'success'));
    });
    root.querySelector('[data-act=reset-token]')?.addEventListener('click', () => {
      void confirmDialog({
        title: '重新生成 MCP 令牌',
        message: '重新生成后，已配置到其他工具的旧令牌将立即失效，需要更新客户端配置。确定继续吗？',
        danger: true,
        okText: '重新生成',
      }).then((ok) => {
        if (!ok) return;
        void mcpResetToken()
          .then((t) => { token = t; tokenShown = true; toast('令牌已重新生成', 'success'); render(); })
          .catch((err) => toast(`重新生成失败: ${String(err)}`, 'error'));
      });
    });
    root.querySelector('[data-act=copy-example]')?.addEventListener('click', () => {
      const json = JSON.stringify({
        url: `http://127.0.0.1:${port}/mcp`,
        headers: { Authorization: `Bearer ${token ?? '<令牌>'}` },
      }, null, 2);
      void copyText(json).then(() => toast('已复制客户端配置', 'success'));
    });
  }

  /** 即时保存；失败回滚开关状态并提示 */
  async function save(next: McpDeviceConfig): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await setMcpDevice(deviceId, next);
      cfg = next;
      toast(next.enabled ? '已启用，服务器加入 MCP 可发现设备列表' : '已停用 MCP', 'success');
      bus.emit('project-changed'); // 卡片标签同步
      render();
    } catch (err) {
      toast(`保存 MCP 设置失败: ${String(err)}`, 'error');
      render(); // 回滚到后端实际状态
    } finally {
      busy = false;
    }
  }

  function emptyFeatures(): McpFeatures {
    return {
      sftpList: false, sftpUpload: false, sftpDownload: false, sftpRename: false, sftpDelete: false,
      fileRead: false, fileWrite: false, fileEdit: false, exec: false, dbQuery: false,
    };
  }

  offProjectChanged = bus.on('project-changed', () => { void refresh(); });
  void refresh();
}
