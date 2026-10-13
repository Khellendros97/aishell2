/**
 * 底栏 MCP 角标 + 管理弹层 —— 三页共用（由 components/Statusbar.tsx 渲染在右侧，无 .proto 对照）。
 * 角标：已启用 MCP（加入可发现设备列表）的服务器数量；为 0 时整个角标不渲染。
 * 点击角标展开管理弹层（fixed 定位锚在角标上方，规避状态栏祖先 overflow 裁剪）：
 * 仅列出已启用的服务器，每行一个启停开关（关 = setMcpDevice enabled:false，功能开关配置保留）
 * + 齿轮进入完整 MCP 设置弹窗（复用 sidebar/McpModal 的 openMcpModal）。
 * 数据与刷新：getState().servers × mcpDevices 推导列表，getMcpStatus() 取服务运行状态；
 * 挂载拉一次 + wbEvents 'project-changed' 驱动刷新（McpModal / 本面板保存后都会广播），
 * 本面板保存成功后同样 emit 'project-changed' 让 ServersPanel 卡片标签同步。
 * 接口点：src/api.ts 的 getState / getMcpStatus / setMcpDevice；
 * 数据模型 src/types.ts（Server / McpDeviceConfig / McpStatus）。
 * 样式：statusbar.css 的 .statusbar-mcp* / .sb-mcp-*（开关滑块自带，不依赖 ServersPanel 的 servers.css）。
 */
import { useEffect, useRef, useState } from 'react';
import { getMcpStatus, getState, setMcpDevice } from '../api';
import type { McpDeviceConfig, McpStatus, Server } from '../types';
import { wbEvents } from '../stores/workbench';
import { toast } from '../ui';
import { Icon } from '../shared/Icon';
import { openMcpModal } from '../pages/workbench/sidebar/McpModal';

/** 一行 = 一台已启用 MCP 的服务器（cfg 取自 AppState.mcpDevices，enabled 恒为 true） */
interface McpDeviceRow {
  server: Server;
  cfg: McpDeviceConfig;
}

export function StatusbarMcp(): JSX.Element | null {
  const [rows, setRows] = useState<McpDeviceRow[]>([]);
  const [svc, setSvc] = useState<McpStatus | null>(null);
  const [open, setOpen] = useState(false);
  /** 弹层 fixed 坐标（角标上方右对齐），open 时从角标矩形现算 */
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  /** 保存中的服务器 id（防重复点击，与 McpModal busy 同语义） */
  const [busyId, setBusyId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  /** 拉最新列表 + 服务状态，返回启用数（0 也可能来自拉取失败，调用方不得据此清 UI） */
  const refresh = async (): Promise<number> => {
    let count = 0;
    try {
      const state = await getState();
      const next: McpDeviceRow[] = [];
      for (const s of state.servers) {
        const cfg = state.mcpDevices[s.id];
        if (cfg?.enabled) next.push({ server: s, cfg });
      }
      setRows(next);
      count = next.length;
    } catch {
      /* 后端未就绪静默，下次 project-changed 再刷 */
    }
    try {
      setSvc(await getMcpStatus());
    } catch {
      /* 同上，状态行保持上次值 */
    }
    return count;
  };

  /* 挂载拉一次 + project-changed 跟随（McpModal 保存 / 本面板保存 / 服务器增删改都会广播） */
  useEffect(() => {
    void refresh();
    return wbEvents.on('project-changed', () => void refresh());
  }, []);

  /* 弹层打开期间：点击外部 / Escape 关闭 */
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const togglePanel = (): void => {
    if (open) {
      setOpen(false);
      return;
    }
    const r = wrapRef.current?.getBoundingClientRect();
    if (r) setPos({ right: window.innerWidth - r.right, bottom: window.innerHeight - r.top + 6 });
    setOpen(true);
  };

  /** 停用该服务器的 MCP（本面板只做停用：停用后移出列表，重新启用走服务器卡片「更多 → MCP」） */
  const disableServer = async (row: McpDeviceRow): Promise<void> => {
    if (busyId) return;
    setBusyId(row.server.id);
    try {
      await setMcpDevice(row.server.id, { ...row.cfg, enabled: false });
      toast(`已停用「${row.server.name}」的 MCP（功能开关配置已保留）`, 'success');
      wbEvents.emit('project-changed'); // ServersPanel 卡片标签同步 + 本组件刷新
      const left = await refresh();
      if (left === 0) setOpen(false); // 最后一台停用 → 角标即将隐藏，弹层随之收起
    } catch (err) {
      toast(`保存 MCP 设置失败: ${String(err)}`, 'error');
    } finally {
      setBusyId(null);
    }
  };

  /* 无启用设备 → 不渲染角标与弹层 */
  if (rows.length === 0) return null;

  const names = rows.map((r) => r.server.name).join('、');
  const statusCls = svc?.running ? ' ok' : svc?.error ? ' err' : '';
  const statusText = svc?.running
    ? `服务运行中 · 127.0.0.1:${svc.boundPort ?? svc.port}`
    : svc?.error
      ? `启动失败 · ${svc.error}`
      : '服务未运行';

  return (
    <div className="statusbar-mcp" ref={wrapRef}>
      <button
        type="button"
        className="statusbar-item statusbar-mcp-badge"
        title={`MCP 已启用服务器（${rows.length}）：${names}（点击管理）`}
        aria-expanded={open}
        onClick={togglePanel}
      >
        <Icon name="plug" />{rows.length}
      </button>
      {open && pos && (
        <div
          className="statusbar-mcp-panel"
          style={{ right: pos.right, bottom: pos.bottom }}
          role="dialog"
          aria-label="MCP 服务管理"
        >
          <div className="sb-mcp-head">
            <span className="sb-mcp-title">MCP 服务 · 已启用 {rows.length} 台</span>
            <span className={`sb-mcp-status${statusCls}`} title={statusText}>
              <Icon name={svc?.error ? 'alert' : 'circle'} />
              {statusText}
            </span>
          </div>
          <div className="sb-mcp-list">
            {rows.map((row) => {
              const locked = row.server.locked;
              const busy = busyId === row.server.id;
              return (
                <div className="sb-mcp-row" key={row.server.id}>
                  <div className="sb-mcp-info">
                    <div className="sb-mcp-name" title={locked ? '服务器已锁定（不允许 AI 访问），MCP 工具调用会被拒绝' : row.server.name}>
                      {locked ? <Icon name="lock" /> : null}
                      {row.server.name}
                    </div>
                    <div className="sb-mcp-meta">
                      {row.server.username}@{row.server.host}:{row.server.port}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="icon-btn sb-mcp-gear"
                    title="MCP 功能开关与接入信息"
                    onClick={() => { setOpen(false); openMcpModal(row.server); }}
                  >
                    <Icon name="gear" />
                  </button>
                  <label
                    className="sb-mcp-switch"
                    title={locked
                      ? '服务器已锁定（不允许 AI 访问），请先在服务器设置中解锁'
                      : '点击停用：从 MCP 可发现设备列表移除（功能开关配置保留）'}
                  >
                    <input
                      type="checkbox"
                      checked
                      disabled={locked || busy}
                      onChange={() => { if (!locked) void disableServer(row); }}
                    />
                    <span className="sb-mcp-switch-track"></span>
                  </label>
                </div>
              );
            })}
          </div>
          <div className="sb-mcp-foot">
            关闭开关即从 MCP 可发现列表移除（配置保留）；重新启用或配置功能开关，请到服务器卡片「更多 → MCP」。
          </div>
        </div>
      )}
    </div>
  );
}
