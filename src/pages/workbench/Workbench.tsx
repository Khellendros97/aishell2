/**
 * 工作台页面外壳(React 版):对照 src/pages/workbench/workbench.ts + core.ts 的标签栏。
 * 结构照 .proto/workbench.html,DOM id/class 不变(workbench.css 直接复用):
 * - activity-bar 面板按钮(explorer/servers/commands/skills)+ 浏览器入口(打开中央标签页)+
 *   底部 AI 面板开关;浏览器是主工作区标签页而非侧栏面板(用户要求窗口大),固定 id 'browser'
 *   单实例,openTab 同 id 去重激活;
 * - commands 准入在 store.setPanel(活跃标签须为终端);活跃标签变为非终端时自动切回 explorer;
 * - 侧栏/ AI 面板可拖宽(语义同旧版 bindPanelResize:指针拖拽 + 键盘方向键 + 出屏钳制);
 * - 标签栏:同 id 去重激活、终端同名自动编号、终端右键菜单(添加到对话/重命名/复制 SSH 渠道/关闭);
 * - panes 常驻挂载(keep-alive),active 仅切显隐 —— 终端/SSH/AI 会话不随标签切换销毁。
 * 项目装载失败自行导航回欢迎页并 onFail();实例销毁(换项目)时关闭全部标签并复位 store。
 */
import { useEffect, useRef } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { getState } from '../../api';
import { navigate } from '../../router';
import { toast, promptDialog, showContextMenu, uid, type CtxMenuItems } from '../../ui';
import type { Project, ServerRef } from '../../types';
import { Topbar } from '../../components/Topbar';
import { Icon } from '../../shared/Icon';
import {
  useWorkbench, wbHandles, type PanelKey, type Tab,
} from '../../stores/workbench';
import { PANELS } from './sidebar/panels';
import { TAB_TYPES } from './tabs/registry';
import { setWorkbenchActive } from './tabs/browser-engine';
import { AiPanel } from './ai/AiPanel';
import { refreshProgress } from './statusbar-progress';
import './workbench.css';

/* ---------- 面板拖宽(指针 + 键盘,出屏钳制;对照旧版 bindPanelResize) ---------- */
function usePanelResize(
  handleRef: RefObject<HTMLDivElement>,
  panelRef: RefObject<HTMLDivElement>,
  side: 'left' | 'right',
  workbenchRef: RefObject<HTMLDivElement>,
  activityBarRef: RefObject<HTMLDivElement>,
  sidebarRef: RefObject<HTMLDivElement>,
  aiPanelRef: RefObject<HTMLDivElement>,
  sidebarResizerRef: RefObject<HTMLDivElement>,
  aiResizerRef: RefObject<HTMLDivElement>,
): void {
  useEffect(() => {
    const handle = handleRef.current;
    const panel = panelRef.current;
    const workbench = workbenchRef.current;
    if (!handle || !panel || !workbench) return;
    const minimum = side === 'left' ? 180 : 280;
    const maximum = side === 'left' ? 520 : 560;
    const property = side === 'left' ? '--sidebar-w' : '--ai-panel-w';

    const clampWidth = (width: number): number => {
      const occupiedByOther = (activityBarRef.current?.offsetWidth ?? 0)
        + (side === 'left' ? (aiPanelRef.current?.offsetWidth ?? 0) : (sidebarRef.current?.offsetWidth ?? 0))
        + (sidebarResizerRef.current?.offsetWidth ?? 0) + (aiResizerRef.current?.offsetWidth ?? 0);
      const availableMaximum = Math.max(minimum, workbench.clientWidth - occupiedByOther - 360);
      return Math.round(Math.max(minimum, Math.min(maximum, Math.min(width, availableMaximum))));
    };

    const applyWidth = (width: number): void => {
      const next = clampWidth(width);
      workbench.style.setProperty(property, `${next}px`);
      handle.setAttribute('aria-valuenow', String(next));
    };

    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const delta = event.clientX - startX;
      applyWidth(startWidth + (side === 'left' ? delta : -delta));
    };
    const onPointerUp = (): void => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('active');
      document.body.classList.remove('wb-resizing');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      startX = event.clientX;
      startWidth = panel.getBoundingClientRect().width;
      handle.classList.add('active');
      document.body.classList.add('wb-resizing');
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      applyWidth(panel.getBoundingClientRect().width + direction * (side === 'left' ? 16 : -16));
    };

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('keydown', onKeyDown);
    applyWidth(panel.getBoundingClientRect().width);
    return () => {
      onPointerUp();
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('keydown', onKeyDown);
    };
  }, [handleRef, panelRef, side, workbenchRef, activityBarRef, sidebarRef, aiPanelRef, sidebarResizerRef, aiResizerRef]);
}

/** 终端标签重命名:promptDialog 输入新名,空串/路径分隔符由弹窗校验拦截 */
function renameTerminalTab(tab: Tab): void {
  void promptDialog({
    title: '重命名终端标签',
    label: '标签名称(会话级,仅当前窗口有效)',
    defaultValue: tab.title,
    placeholder: '例如:抓包终端',
    okText: '重命名',
  }).then((name: string | null) => {
    const trimmed = (name ?? '').trim();
    if (trimmed) useWorkbench.getState().setTabTitle(tab.id, trimmed);
  });
}

export interface WorkbenchProps {
  /** 路由当前是否停留在工作台(false = 保活隐藏) */
  active: boolean;
  /** 本实例创建时的路由目标项目参数(App 的 key 机制保证实例内稳定) */
  targetParam: string | null;
  /** 项目装载成功(登记保活 id) */
  onReady(projectId: string): void;
  /** 装载失败(已自行导航离开,App 销毁实例) */
  onFail(): void;
}

export default function Workbench({ active, targetParam, onReady, onFail }: WorkbenchProps): JSX.Element {
  const panel = useWorkbench((s) => s.panel);
  const aiVisible = useWorkbench((s) => s.aiVisible);
  const tabs = useWorkbench((s) => s.tabs);
  const activeId = useWorkbench((s) => s.activeId);
  const project = useWorkbench((s) => s.project);
  const activeTab = tabs.find((t) => t.id === activeId) ?? null;

  const workbenchRef = useRef<HTMLDivElement>(null);
  const activityBarRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const sidebarResizerRef = useRef<HTMLDivElement>(null);
  const aiPanelRef = useRef<HTMLDivElement>(null);
  const aiResizerRef = useRef<HTMLDivElement>(null);

  usePanelResize(sidebarResizerRef, sidebarRef, 'left', workbenchRef, activityBarRef, sidebarRef, aiPanelRef, sidebarResizerRef, aiResizerRef);
  usePanelResize(aiResizerRef, aiPanelRef, 'right', workbenchRef, activityBarRef, sidebarRef, aiPanelRef, sidebarResizerRef, aiResizerRef);

  /* ---------- 项目装载(异步;对照旧版 workbench.ts 装载段) ---------- */
  useEffect(() => {
    let alive = true;
    void (async () => {
      let project: Project | null = null;
      try {
        const state = await getState();
        project = state.projects.find((p) => p.id === targetParam) ?? state.projects[0] ?? null;
      } catch (err) {
        toast(`加载项目数据失败: ${String(err)}`, 'error');
      }
      if (!alive) return; // 装载期间路由已离开:实例将被销毁,迟到结果丢弃
      if (!project) {
        toast('没有可用项目,请先在欢迎页创建项目', 'error');
        navigate('#/welcome');
        onFail();
        return;
      }
      const s = useWorkbench.getState();
      s.setProject(project);
      s.setPanel('explorer'); // 默认面板
      s.setAiVisible(true);   // AI 面板默认开(原型 #ai-panel 常驻布局)
      s.openTab({
        id: 'term-local',
        type: 'terminal',
        title: '本地终端',
        data: { kind: 'local', cwd: project.path },
      });
      onReady(project.id);
    })();
    return () => { alive = false; };
    // targetParam 经 App 的 key 机制保证实例内稳定,无需入依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 实例销毁:关闭全部标签(触发各组件清理→term_close 等后端回收)并复位 ---------- */
  useEffect(() => () => {
    const s = useWorkbench.getState();
    s.tabs.slice().forEach((t) => s.closeTab(t.id));
    s.reset();
  }, []);

  /* ---------- 保活隐藏联动:路由离开工作台(设置/欢迎页)时工作台 display:none,
     浏览器子 webview 必须跟随隐藏,否则永远浮在主 webview 上盖住其他页面 ---------- */
  useEffect(() => {
    setWorkbenchActive(active);
  }, [active]);

  /* ---------- 底边栏进度区:挂载后刷新一次(传输/暂存事件先于容器出现时任务已入队) ---------- */
  useEffect(() => {
    refreshProgress();
  }, []);

  /* ---------- 正在显示 commands 时活跃标签变为非终端(或 null)→ 自动切回 explorer ---------- */
  useEffect(() => {
    const s = useWorkbench.getState();
    const activeTab = s.tabs.find((t) => t.id === s.activeId);
    if (s.panel === 'commands' && (!activeTab || activeTab.type !== 'terminal')) s.setPanel('explorer');
  }, [activeId, panel]);

  /* ---------- activity-bar 点击:面板切换 / 浏览器标签页入口 / AI 面板开关 ---------- */
  const onActivityClick = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const iconEl = (e.target as HTMLElement).closest('.activity-icon');
    if (!iconEl) return;
    const p = iconEl.getAttribute('data-panel');
    const s = useWorkbench.getState();
    if (p === 'ai') { s.setAiVisible(!s.aiVisible); return; }
    if (p === 'browser') {
      // 浏览器是中央标签页(非侧栏面板):固定 id 单实例,openTab 同 id 去重激活
      s.openTab({ id: 'browser', type: 'browser', title: '浏览器' });
      return;
    }
    if (!p || p === s.panel) return;
    s.setPanel(p as PanelKey);
  };

  /* ---------- 终端标签右键菜单(原生右键已全局禁用;语义对照旧版 core.ts) ---------- */
  const onTabContextMenu = (e: ReactMouseEvent<HTMLDivElement>, tab: Tab): void => {
    if (tab.type !== 'terminal') return;
    e.preventDefault();
    e.stopPropagation();
    const kind = tab.data.kind === 'ssh' ? 'ssh' : 'local';
    const serverId = tab.data.serverId as string | undefined;
    const ref: ServerRef = kind === 'ssh' && serverId
      ? { serverId, name: tab.title }
      : { serverId: null, name: '本地终端' };
    const items: CtxMenuItems = [
      { label: '添加到对话', iconName: 'chatPlus', action: () => wbHandles.ai?.addServerRef?.(ref) },
      { label: '重命名', iconName: 'pencil', action: () => renameTerminalTab(tab) },
    ];
    if (kind === 'ssh') {
      items.push(
        {
          label: '复制 SSH 渠道', iconName: 'copy',
          action: () => useWorkbench.getState().openTab({
            id: `term:${serverId}:${uid('t')}`, type: 'terminal', title: tab.title, data: { kind: 'ssh', serverId },
          }),
        },
        'sep',
      );
    }
    items.push({ label: '关闭标签', iconName: 'x', action: () => useWorkbench.getState().closeTab(tab.id) });
    showContextMenu(e.clientX, e.clientY, items);
  };

  const def = PANELS[panel] ?? PANELS.explorer;
  const HeadActions = def.HeadActions;

  return (
    <>
      <Topbar activePage={null} />
      <div id="workbench-shell">
        <div id="workbench" ref={workbenchRef} aria-hidden={!active}>
          <div id="activity-bar" ref={activityBarRef} onClick={onActivityClick}>
            <div className={`activity-icon${panel === 'explorer' ? ' active' : ''}`} data-panel="explorer" title="文件资源管理器"><Icon name="folder" /></div>
            <div className={`activity-icon${panel === 'servers' ? ' active' : ''}`} data-panel="servers" title="服务器列表"><Icon name="monitor" /></div>
            <div className={`activity-icon${panel === 'commands' ? ' active' : ''}`} data-panel="commands" title="命令收藏"><Icon name="star" /></div>
            <div className={`activity-icon${panel === 'skills' ? ' active' : ''}`} data-panel="skills" title="Skill"><Icon name="sparkles" /></div>
            <div className={`activity-icon${panel === 'notes' ? ' active' : ''}`} data-panel="notes" title="笔记"><Icon name="note" /></div>
            <div className="activity-icon" data-panel="browser" title="浏览器(在标签页中打开)"><Icon name="globe" /></div>
          </div>
        <div id="sidebar" ref={sidebarRef}>
          <div id="sidebar-head">
            <span id="sidebar-title">{def.title}</span>
            <span id="sidebar-actions">{HeadActions ? <HeadActions /> : null}</span>
          </div>
          <div id="sidebar-content">
            <div className="wbs-panel-root"><def.Panel /></div>
          </div>
        </div>
        <div id="sidebar-resizer" ref={sidebarResizerRef} className="wb-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整左侧边栏宽度" tabIndex={0}></div>
        <div id="center">
          <div id="tab-bar">
            {tabs.map((t) => (
              <div
                key={t.id}
                className={`wb-tab${t.id === activeId ? ' active' : ''}`}
                onClick={(e) => { if (!(e.target as HTMLElement).closest('.tab-close')) useWorkbench.getState().activateTab(t.id); }}
                onContextMenu={(e) => onTabContextMenu(e, t)}
              >
                <span className="tab-icon"><Icon name={t.icon} /></span>
                <span className="tab-title">{t.title}</span>
                <button className="tab-close" title="关闭" onClick={() => useWorkbench.getState().closeTab(t.id)}><Icon name="x" /></button>
              </div>
            ))}
          </div>
          <div id="tab-content">
            {tabs.map((t) => {
              const Comp = TAB_TYPES[t.type];
              return (
                <div key={t.id} className={`tab-pane${t.id === activeId ? ' active' : ''}`} data-tab-id={t.id}>
                  {Comp
                    ? <Comp tab={t} active={t.id === activeId} />
                    : <div style={{ padding: 24, color: 'var(--text-2)' }}>未注册的标签类型: {t.type}</div>}
                </div>
              );
            })}
          </div>
        </div>
        <div
          id="ai-resizer"
          ref={aiResizerRef}
          className={`wb-resize-handle${aiVisible ? '' : ' hidden'}`}
          role="separator" aria-orientation="vertical" aria-label="调整 AI 面板宽度" tabIndex={0}
        ></div>
        {/* AI 面板须在项目装载完成后才挂载(对照旧版 workbench.ts:装载段完成后才 setAiVisible(true)→mountAiPanel):
            ai-engine 在挂载时一次性快照 useWorkbench.getState().project,渲染即挂载会早于异步装载读到 null,
            导致发送消息恒报「项目未加载」。project 门控恢复旧版时序;换项目时整树经 key 重建,AiPanel 随之重挂。 */}
        <div id="ai-panel" ref={aiPanelRef} className={aiVisible ? '' : 'hidden'}>{project && active ? <AiPanel /> : null}</div>
        </div>
        <div id="workbench-statusbar" role="status" aria-label="工作台状态栏">
          <div className="statusbar-left">
            {project && <span className="statusbar-item" title={`当前项目：${project.name}`}><Icon name="folder" />{project.name}</span>}
            <span className="statusbar-item statusbar-active-tab" title={activeTab ? `当前标签页：${activeTab.title}` : '当前没有活跃标签页'}>
              {activeTab ? <><Icon name={activeTab.icon} />{activeTab.title}</> : '无活动标签页'}
            </span>
          </div>
          <div className="statusbar-progress" id="workbench-progress" aria-live="polite"></div>
          <div className="statusbar-right">
            <button
              type="button"
              className={`statusbar-ai-toggle${aiVisible ? ' active' : ''}`}
              title={aiVisible ? '隐藏 AI 助手' : '显示 AI 助手'}
              aria-controls="ai-panel"
              aria-expanded={aiVisible}
              onClick={() => useWorkbench.getState().setAiVisible(!aiVisible)}
            >
              <Icon name="bot" />
              <span>AI 助手</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
