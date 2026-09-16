/**
 * 激励计划宣传片 —— 真实 UI 组件（复用主仓类名 + real-ui.css，非近似绘制的示意件）。
 * 结构逐处对照：src/components/Topbar.tsx / Statusbar.tsx、src/pages/workbench/Workbench.tsx
 * （活动栏、侧栏壳、标签栏、AI 面板壳）。图标用 svg.ic（1em 随字号，与主仓 src/icons.ts 一致）。
 */
import React from 'react';
import { IconName } from '../theme';
import { ICONS } from '../theme';
import { Logo } from '../ui';

/** 主仓 icon() 等价物：<svg class="ic"> 尺寸由 CSS 1em 决定 */
export const Ic: React.FC<{ name: IconName }> = ({ name }) => (
  <svg
    className="ic"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    dangerouslySetInnerHTML={{ __html: ICONS[name] }}
  />
);

/* ---------------- 页头（Topbar） ---------------- */

export const Topbar: React.FC<{ active?: '项目' | '设置' | '账号' | null; version?: string }> = ({ active = null, version = 'v1.1.3' }) => (
  <div className="page-topbar">
    <div className="brand">
      <Logo size={22} />
      <span>AIShell</span>
      <span className="tb-version">{version}</span>
    </div>
    <div className="spacer" />
    {(['项目', '设置', '账号'] as const).map((n) => (
      <button key={n} className={`btn small${active === n ? '' : ' ghost'}`}>
        {n}
      </button>
    ))}
    <button className="icon-btn">
      <Ic name="sun" />
    </button>
    <div className="tb-win-controls">
      <button className="tb-win-btn">
        <Ic name="minus" />
      </button>
      <button className="tb-win-btn">
        <Ic name="square" />
      </button>
      <button className="tb-win-btn tb-win-close">
        <Ic name="x" />
      </button>
    </div>
  </div>
);

/* ---------------- 活动栏（ActivityBar） ---------------- */

export type PanelName = 'explorer' | 'servers' | 'commands' | 'skills' | 'notes' | null;

const ACTIVITY: Array<{ panel: PanelName; icon: IconName; title: string }> = [
  { panel: null, icon: 'chevronLeft', title: '折叠侧栏' },
  { panel: 'explorer', icon: 'folder', title: '文件资源管理器' },
  { panel: 'servers', icon: 'monitor', title: '服务器列表' },
  { panel: 'commands', icon: 'star', title: '命令收藏' },
  { panel: 'skills', icon: 'sparkles', title: 'Skill' },
  { panel: 'notes', icon: 'pencil', title: '笔记' },
  { panel: null, icon: 'timeline', title: '项目时间线' },
  { panel: null, icon: 'globe', title: '浏览器' },
];

export const ActivityBar: React.FC<{ active?: PanelName }> = ({ active = null }) => (
  <div id="activity-bar">
    {ACTIVITY.map((a, i) => (
      <div key={i} className={`activity-icon${a.panel !== null && a.panel === active ? ' active' : ''}`} title={a.title}>
        <Ic name={a.icon} />
      </div>
    ))}
    <div className="activity-icon avatar-entry" title="账号">
      <span className="avatar-img">李</span>
    </div>
  </div>
);

/* ---------------- 侧栏壳（Sidebar） ---------------- */

export const Sidebar: React.FC<{ title: string; actions?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  actions,
  children,
}) => (
  <div id="sidebar">
    <div id="sidebar-head">
      <span id="sidebar-title">{title}</span>
      <span id="sidebar-actions">{actions}</span>
    </div>
    <div id="sidebar-content">
      <div className="wbs-panel-root">{children}</div>
    </div>
  </div>
);

/* ---------------- 标签栏（TabBar） ---------------- */

export interface TabDef {
  id: string;
  icon: IconName;
  title: string;
  /** 锚点 id(供高亮环/指针实测定位,见 components/anchors.tsx) */
  anchor?: string;
}

export const TabBar: React.FC<{ tabs: TabDef[]; active: string }> = ({ tabs, active }) => (
  <div id="tab-bar">
    {tabs.map((t) => (
      <div key={t.id} className={`wb-tab${t.id === active ? ' active' : ''}`} data-anchor={t.anchor}>
        <span className="tab-icon">
          <Ic name={t.icon} />
        </span>
        <span className="tab-title">{t.title}</span>
        <button className="tab-close">
          <Ic name="x" />
        </button>
      </div>
    ))}
  </div>
);

/* ---------------- AI 面板壳 ---------------- */

export const AiPanel: React.FC<{ children: React.ReactNode }> = ({ children }) => <div id="ai-panel">{children}</div>;

export const AiSessionBar: React.FC<{ title: string }> = ({ title }) => (
  <div id="ai-session-bar">
    <div id="ai-session-picker">
      <button id="ai-session-select" className="select" type="button" title="切换会话">
        <span className="ai-session-current">{title}</span>
        <Ic name="chevronDown" />
      </button>
    </div>
    <button id="ai-new-session" className="icon-btn" type="button" title="新建会话">
      <Ic name="plus" />
    </button>
  </div>
);

/* ---------------- 状态栏（Statusbar） ---------------- */

export const Statusbar: React.FC<{
  project: string;
  activeTab: string;
  progress?: { label: string; detail: string; pct: number } | null;
  aiActive?: boolean;
}> = ({ project, activeTab, progress = null, aiActive = true }) => (
  <div className="app-statusbar">
    <div className="statusbar-left">
      <span className="statusbar-item">
        <Ic name="folder" /> {project}
      </span>
      <span className="statusbar-item statusbar-active-tab ellipsis">{activeTab}</span>
    </div>
    <div className="statusbar-right">
      {progress ? (
        <span className="wb-progress-task" style={{ marginRight: 12 }}>
          <span className="wb-progress-fill" style={{ width: `${progress.pct}%` }} />
          <span className="wb-progress-label">{progress.label}</span>
          <span className="wb-progress-detail">{progress.detail}</span>
        </span>
      ) : null}
      <button className={`statusbar-ai-toggle${aiActive ? ' active' : ''}`}>
        <Ic name="bot" /> AI 助手
      </button>
    </div>
  </div>
);

/* ---------------- 工作台总壳（活动栏 + 侧栏 + 中央 + AI 面板 + 状态栏） ---------------- */

export const Workbench: React.FC<{
  panel: PanelName;
  sidebar: React.ReactNode;
  tabs: TabDef[];
  activeTab: string;
  center: React.ReactNode;
  ai: React.ReactNode;
  statusbar: React.ReactNode;
  activePage?: '项目' | '设置' | '账号' | null;
}> = ({ panel, sidebar, tabs, activeTab, center, ai, statusbar, activePage = null }) => (
  <>
    <Topbar active={activePage} />
    <div className="wb-shell">
      <div className="wb">
        <ActivityBar active={panel} />
        {sidebar}
        <div id="center">
          <TabBar tabs={tabs} active={activeTab} />
          <div id="tab-content">{center}</div>
        </div>
        {ai}
      </div>
      {statusbar}
    </div>
  </>
);
