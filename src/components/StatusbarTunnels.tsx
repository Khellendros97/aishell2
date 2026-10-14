/**
 * 底栏 SSH 隧道角标 + 控制面板 —— 三页共用（components/Statusbar.tsx 渲染，无 .proto 对照，
 * 形态同 components/StatusbarMcp.tsx）。原 Statusbar 内联的运行中隧道角标迁入本组件。
 * 角标：运行中隧道数量，为 0 时整体不渲染；hover 列明细，点击展开控制面板
 * （fixed 定位锚在角标上方，规避状态栏祖先 overflow 裁剪）。
 * 面板：列出全部已配置隧道（运行中的排前），每行一个启停开关 ——
 * 停止 = tunnel_stop；启动 = tunnel_start，端口冲突沿用 TunnelTab 的「关闭占用方」
 * 确认后带 closeConflict 重试（conflictDetail 从 TunnelTab 导出复用，同一契约源）。
 * 面板不做新建/编辑（工作台标签页跨页面打不开），指向服务器卡片「更多 → SSH 隧道」；
 * 关闭标签页不停隧道（服务语义，见 TunnelTab）。
 * 数据与刷新：tunnel_list()（全服务器）+ getState() 取服务器名；挂载拉一次 +
 * tunnels:changed 驱动刷新（后端在启动/停止/保存/删除/恢复重建时广播）。
 * 接口点：src/api.ts 的 tunnel 段（tunnelList / tunnelStart / tunnelStop / onTunnelsChanged）。
 * 样式：statusbar.css 的 .statusbar-tunnels* / .sb-pop-* / .sb-switch（三页共用骨架）。
 */
import { useEffect, useRef, useState } from 'react';
import { getState, onTunnelsChanged, tunnelList, tunnelStart, tunnelStop } from '../api';
import type { TunnelState } from '../types';
import { confirmDialog, toast } from '../ui';
import { Icon } from '../shared/Icon';
import { conflictDetail } from '../pages/workbench/tabs/TunnelTab';

/** 路由描述（与 TunnelTab 卡片同格式）：dynamic 的目标由客户端协商 */
function routeText(t: TunnelState): string {
  return t.kind === 'dynamic'
    ? `${t.bindAddr}:${t.localPort} → SOCKS5 动态代理`
    : `${t.bindAddr}:${t.localPort} → ${t.targetHost}:${t.targetPort}`;
}

export function StatusbarTunnels(): JSX.Element | null {
  const [tunnels, setTunnels] = useState<TunnelState[]>([]);
  /** serverId → 服务器名（行 meta 展示；服务器已删时回退显示 serverId） */
  const [serverNames, setServerNames] = useState<Record<string, string>>({});
  const [open, setOpen] = useState(false);
  /** 弹层 fixed 坐标（角标上方右对齐），open 时从角标矩形现算 */
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  /** 启停中的隧道 id（防重复点击） */
  const [busyId, setBusyId] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  /** 拉最新隧道列表 + 服务器名，返回列表（拉取失败返回 null，调用方不得据此清 UI） */
  const refresh = async (): Promise<TunnelState[] | null> => {
    try {
      const [list, state] = await Promise.all([tunnelList(), getState()]);
      setTunnels(list);
      const names: Record<string, string> = {};
      for (const s of state.servers) names[s.id] = s.name;
      setServerNames(names);
      return list;
    } catch {
      /* 后端未就绪静默，下次 tunnels:changed 再刷 */
      return null;
    }
  };

  /* 挂载拉一次 + tunnels:changed 跟随（启动/停止/保存/删除/恢复重建都会广播） */
  useEffect(() => {
    void refresh();
    let unlisten: (() => void) | null = null;
    void onTunnelsChanged(() => void refresh()).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
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

  /** 启停隧道：停止直接 tunnel_stop；启动撞端口冲突 → 弹「关闭占用方」确认后重试
   *  （与 TunnelTab.startTunnel 同流程；取消则保持现状）。停掉最后一台后收起弹层。 */
  const toggleTunnel = async (t: TunnelState): Promise<void> => {
    if (busyId) return;
    setBusyId(t.id);
    try {
      if (t.running) {
        await tunnelStop(t.id);
      } else {
        try {
          await tunnelStart(t.id);
        } catch (err) {
          const conflict = conflictDetail(err);
          if (!conflict) throw err;
          if (await confirmDialog({
            title: '端口已被占用',
            message: `${conflict}，是否将其关闭？`,
            okText: '关闭并启动',
          })) {
            await tunnelStart(t.id, true);
          }
        }
      }
      const list = await refresh();
      if (list && !list.some((x) => x.running)) setOpen(false); // 角标即将隐藏，弹层随之收起
    } catch (err) {
      toast(`切换隧道状态失败: ${String(err)}`, 'error');
      void refresh();
    } finally {
      setBusyId(null);
    }
  };

  const running = tunnels.filter((t) => t.running);

  /* 无运行中隧道 → 不渲染角标与弹层（与原内联角标语义一致） */
  if (running.length === 0) return null;

  /* 运行中的排前，组内保持配置顺序（sort 稳定） */
  const sorted = [...tunnels].sort((a, b) => Number(b.running) - Number(a.running));

  return (
    <div className="statusbar-tunnels" ref={wrapRef}>
      <button
        type="button"
        className="statusbar-item statusbar-tunnels-badge"
        title={`运行中的 SSH 隧道（${running.length}）：${running.map((t) => `${t.name}（${t.bindAddr}:${t.localPort}）`).join('、')}（点击管理）`}
        aria-expanded={open}
        onClick={togglePanel}
      >
        <Icon name="tunnel" />{running.length}
      </button>
      {open && pos && (
        <div
          className="sb-pop-panel"
          style={{ right: pos.right, bottom: pos.bottom }}
          role="dialog"
          aria-label="SSH 隧道管理"
        >
          <div className="sb-pop-head">
            <span className="sb-pop-title">SSH 隧道</span>
            <span className="sb-pop-status ok" title="运行中 / 已配置">
              <Icon name="circle" />运行中 {running.length} / 共 {tunnels.length}
            </span>
          </div>
          <div className="sb-pop-list">
            {sorted.map((t) => (
              <div className="sb-pop-row" key={t.id}>
                <div className="sb-pop-info">
                  <div className="sb-pop-name" title={t.name}>
                    <span className={`sb-tun-dot${t.running ? ' running' : ''}`} />
                    {t.name}
                  </div>
                  <div className="sb-pop-meta" title={routeText(t)}>
                    {serverNames[t.serverId] ?? t.serverId} · {routeText(t)}
                  </div>
                  {t.error ? <div className="sb-pop-meta err" title={t.error}>{t.error}</div> : null}
                </div>
                <label
                  className="sb-switch"
                  title={t.running ? '点击停止隧道' : '点击启动隧道'}
                >
                  <input
                    type="checkbox"
                    checked={t.running}
                    disabled={busyId === t.id}
                    onChange={() => { void toggleTunnel(t); }}
                  />
                  <span className="sb-switch-track"></span>
                </label>
              </div>
            ))}
          </div>
          <div className="sb-pop-foot">
            开关启停隧道；新建/编辑请到服务器卡片「更多 → SSH 隧道」（关闭标签页不停隧道）。
          </div>
        </div>
      )}
    </div>
  );
}
