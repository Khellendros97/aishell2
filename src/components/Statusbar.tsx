/**
 * 应用底栏 —— 工作台 / 欢迎页 / 设置页共用（无 .proto 对照，样式自 workbench.css 迁入 statusbar.css）。
 * 结构：左侧信息区（调用方传入）+ 中部进度区 + 右侧（SSH 隧道角标 + MCP 角标 + 可选 AI 助手开关）。
 * - 进度区容器统一用 .statusbar-progress 类：工作台保活隐藏期间容器仍在 DOM，
 *   与当前页面的容器并存，statusbar-progress.ts 会向所有连接的容器同步渲染；
 * - SSH 隧道角标（数据自持 + 点击控制面板）见 components/StatusbarTunnels.tsx，
 *   MCP 角标（同形态）见 components/StatusbarMcp.tsx——两者均为全局数据，不区分页面；
 * - AI 开关仅当 onToggleAi 提供时渲染（工作台/欢迎页有 AI 面板；设置页没有则不传）。
 * 与后端接口点：进度区数据由 statusbar-progress.ts 订阅 sftp:progress / staging:progress，
 * 本组件只提供容器；角标数据拉取与订阅由各自组件自持（见各文件头）。
 */
import { useEffect, type ReactNode } from 'react';
import { Icon } from '../shared/Icon';
import { StatusbarMcp } from './StatusbarMcp';
import { StatusbarTunnels } from './StatusbarTunnels';
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
  /** AI 开关禁用态（AI 已分离到独立窗口时显隐开关无意义，置灰提示） */
  aiDisabled?: boolean;
  /** 禁用态的提示文案（title） */
  aiDisabledHint?: string;
}

export function Statusbar({ left, aiVisible, onToggleAi, aiControls, aiDisabled, aiDisabledHint }: StatusbarProps): JSX.Element {
  /* 进度区：挂载即建立事件订阅并补渲染（传输/暂存事件先于容器出现时任务已入队，需刷新展示） */
  useEffect(() => { refreshProgress(); }, []);

  return (
    <div className="app-statusbar" role="status" aria-label="状态栏">
      <div className="statusbar-left">{left ?? null}</div>
      <div className="statusbar-progress" aria-live="polite"></div>
      <div className="statusbar-right">
        <StatusbarTunnels />
        <StatusbarMcp />
        {onToggleAi && (
          <button
            type="button"
            className={`statusbar-ai-toggle${aiVisible ? ' active' : ''}${aiDisabled ? ' disabled' : ''}`}
            title={aiDisabled ? (aiDisabledHint ?? 'AI 助手已分离到独立窗口') : (aiVisible ? '隐藏 AI 助手' : '显示 AI 助手')}
            aria-controls={aiControls}
            aria-expanded={aiVisible}
            aria-disabled={aiDisabled || undefined}
            onClick={() => { if (!aiDisabled) onToggleAi(); }}
          >
            <Icon name="bot" />
            <span>AI 助手</span>
          </button>
        )}
      </div>
    </div>
  );
}
