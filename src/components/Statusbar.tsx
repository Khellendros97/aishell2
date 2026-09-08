/**
 * 应用底栏 —— 工作台 / 欢迎页 / 设置页共用（无 .proto 对照，样式自 workbench.css 迁入 statusbar.css）。
 * 结构：左侧信息区（调用方传入）+ 中部进度区 + 右侧（运行中隧道角标 + 可选 AI 助手开关）。
 * - 进度区容器统一用 .statusbar-progress 类：工作台保活隐藏期间容器仍在 DOM，
 *   与当前页面的容器并存，statusbar-progress.ts 会向所有连接的容器同步渲染；
 * - 隧道角标为全局数据（不区分页面），拉取与 tunnels:changed 订阅由本组件自持；
 * - AI 开关仅当 onToggleAi 提供时渲染（工作台/欢迎页有 AI 面板；设置页没有则不传）。
 * 与后端接口点：tunnel_list / tunnels:changed（角标，见 src/api.ts）；
 * 进度区数据由 statusbar-progress.ts 订阅 sftp:progress / staging:progress，本组件只提供容器。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { onTunnelsChanged, tunnelList } from '../api';
import type { TunnelState } from '../types';
import { Icon } from '../shared/Icon';
import { refreshProgress } from '../pages/workbench/statusbar-progress';
import './statusbar.css';

export interface StatusbarProps {
  /** 左侧信息区（工作台：当前项目/活动标签页；其余页面缺省为空） */
  left?: ReactNode;
  /** AI 面板当前显隐（与 onToggleAi 一起提供才渲染开关） */
  aiVisible?: boolean;
  /** AI 开关点击回调 */
  onToggleAi?: () => void;
  /** AI 开关 aria-controls 指向的面板元素 id */
  aiControls?: string;
}

export function Statusbar({ left, aiVisible, onToggleAi, aiControls }: StatusbarProps): JSX.Element {
  /* 运行中隧道角标：挂载拉一次 + tunnels:changed 驱动刷新（全服务器，不过滤） */
  const [runningTunnels, setRunningTunnels] = useState<TunnelState[]>([]);
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void tunnelList()
        .then((list) => { if (alive) setRunningTunnels(list.filter((t) => t.running)); })
        .catch(() => { /* 后端未就绪静默，下次 tunnels:changed 再刷 */ });
    };
    refresh();
    let unlisten: (() => void) | null = null;
    void onTunnelsChanged(refresh).then((u) => { unlisten = u; });
    return () => { alive = false; unlisten?.(); };
  }, []);

  /* 进度区：挂载即建立事件订阅并补渲染（传输/暂存事件先于容器出现时任务已入队，需刷新展示） */
  useEffect(() => { refreshProgress(); }, []);

  return (
    <div className="app-statusbar" role="status" aria-label="状态栏">
      <div className="statusbar-left">{left ?? null}</div>
      <div className="statusbar-progress" aria-live="polite"></div>
      <div className="statusbar-right">
        {runningTunnels.length > 0 && (
          <span
            className="statusbar-item statusbar-tunnels"
            title={`运行中的 SSH 隧道（${runningTunnels.length}）：${runningTunnels.map((t) => `${t.name}（${t.bindAddr}:${t.localPort}）`).join('、')}`}
          >
            <Icon name="tunnel" />{runningTunnels.length}
          </span>
        )}
        {onToggleAi && (
          <button
            type="button"
            className={`statusbar-ai-toggle${aiVisible ? ' active' : ''}`}
            title={aiVisible ? '隐藏 AI 助手' : '显示 AI 助手'}
            aria-controls={aiControls}
            aria-expanded={aiVisible}
            onClick={onToggleAi}
          >
            <Icon name="bot" />
            <span>AI 助手</span>
          </button>
        )}
      </div>
    </div>
  );
}
