/**
 * 工作台页面：三栏布局（activity-bar / sidebar / center / ai-panel）。
 * 结构照 .proto/workbench.html，面板切换行为照 .proto/workbench-sidebar.js：
 * - activity-bar 四个面板按钮（explorer / servers / commands / skills）+ 底部 AI 面板开关；
 * - commands 准入：仅当活跃标签为终端，否则 toast「请先激活一个终端标签页」；
 * - 正在显示 commands 时活跃标签变为非终端 → 自动切回 explorer。
 *
 * 与原型差异：项目数据异步装载（getState），面板由 ./sidebar/*.ts 与 ./ai.ts 挂载；
 * 页面就绪后自动开一个本地终端标签（id 'term-local'）。
 */
import { cloudStatus, getState, onCloudChanged } from '../../api';
import { renderTopbar } from '../../components/topbar';
import { navigate } from '../../router';
import { toast } from '../../ui';
import { icon } from '../../icons';
import type { CloudStatus, Project } from '../../types';
import { bus, closeTab, getActiveTab, getTabs, initWorkbench, openTab, Workbench } from './core';
import type { Tab } from './core';
import { wbLifecycle } from './lifecycle';
import { mountExplorerPanel, explorerHead } from './sidebar/explorer';
import { mountServersPanel, serversHead } from './sidebar/servers';
import { mountCommandsPanel, commandsHead } from './sidebar/commands';
import { mountSkillsPanel, skillsHead } from './sidebar/skills';
import { mountAiPanel } from './ai';
import './terminal'; // import 即注册渲染器（模块级副作用）
import './editor';
import './sftp';
import './workbench.css';

const PANELS: Record<string, string> = {
  explorer: '文件资源管理器',
  servers: '服务器列表',
  commands: '命令收藏',
  skills: 'Skill',
};

export async function renderWorkbench(root: HTMLElement, params: URLSearchParams): Promise<(() => void) | void> {
  // 顶栏（原型 workbench.html 的 AIShell.renderTopbar()；工作台无导航高亮）
  renderTopbar(root, null);

  root.insertAdjacentHTML('beforeend', `
    <div id="workbench">
      <!-- 契约：activity-bar 的图标由本模块绑定事件；data-panel 取值为 explorer | servers | commands | skills | ai -->
      <div id="activity-bar">
        <div class="activity-icon active" data-panel="explorer" title="文件资源管理器">${icon('folder')}</div>
        <div class="activity-icon" data-panel="servers" title="服务器列表">${icon('monitor')}</div>
        <div class="activity-icon" data-panel="commands" title="命令收藏">${icon('star')}</div>
        <div class="activity-icon" data-panel="skills" title="Skill">${icon('sparkles')}</div>
        <div class="activity-icon ai-toggle" data-panel="ai" title="AI 助手">${icon('bot')}</div>
        <!-- 云账号入口（CR-1.1b）：置于 AI 开关下方（activity-bar 最底部）；未接入云服务时隐藏 -->
        <div class="activity-icon avatar-entry" data-nav-account title="账号" hidden>${icon('user')}</div>
      </div>
      <div id="sidebar">
        <div id="sidebar-head"><span id="sidebar-title">文件资源管理器</span><span id="sidebar-actions"></span></div>
        <div id="sidebar-content"></div>
      </div>
      <div id="sidebar-resizer" class="wb-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整左侧边栏宽度" tabindex="0"></div>
      <div id="center">
        <div id="tab-bar"></div>
        <div id="tab-content"></div>
      </div>
      <div id="ai-resizer" class="wb-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整 AI 面板宽度" tabindex="0"></div>
      <div id="ai-panel"></div>
    </div>`);

  const activityBar = root.querySelector('#activity-bar') as HTMLElement;
  const sidebarTitle = root.querySelector('#sidebar-title') as HTMLElement;
  const sidebarContent = root.querySelector('#sidebar-content') as HTMLElement;
  const aiPanel = root.querySelector('#ai-panel') as HTMLElement;
  const tabBar = root.querySelector('#tab-bar') as HTMLElement;
  const tabContent = root.querySelector('#tab-content') as HTMLElement;
  const workbench = root.querySelector('#workbench') as HTMLElement;
  const sidebar = root.querySelector('#sidebar') as HTMLElement;
  const sidebarResizer = root.querySelector('#sidebar-resizer') as HTMLElement;
  const aiResizer = root.querySelector('#ai-resizer') as HTMLElement;
  const resizeCleanups: Array<() => void> = [];

  function bindPanelResize(handle: HTMLElement, panel: HTMLElement, side: 'left' | 'right'): void {
    const minimum = side === 'left' ? 180 : 280;
    const maximum = side === 'left' ? 520 : 560;
    const property = side === 'left' ? '--sidebar-w' : '--ai-panel-w';
    let dragging = false;
    let startX = 0;
    let startWidth = 0;

    const clampWidth = (width: number): number => {
      const occupiedByOther = activityBar.offsetWidth
        + (side === 'left' ? aiPanel.offsetWidth : sidebar.offsetWidth)
        + sidebarResizer.offsetWidth + aiResizer.offsetWidth;
      const availableMaximum = Math.max(minimum, workbench.clientWidth - occupiedByOther - 360);
      return Math.round(Math.max(minimum, Math.min(maximum, Math.min(width, availableMaximum))));
    };

    const applyWidth = (width: number): void => {
      const next = clampWidth(width);
      workbench.style.setProperty(property, `${next}px`);
      handle.setAttribute('aria-valuenow', String(next));
    };

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
    resizeCleanups.push(() => {
      onPointerUp();
      handle.removeEventListener('pointerdown', onPointerDown);
      handle.removeEventListener('keydown', onKeyDown);
    });
  }

  bindPanelResize(sidebarResizer, sidebar, 'left');
  bindPanelResize(aiResizer, aiPanel, 'right');

  initWorkbench({ tabBar, tabContent });

  /* 面板头描述符：标题 + actions 按钮（explorer 的新建/刷新、commands 的新增走这里渲染） */
  const HEADS: Record<string, { title: string; renderActions?: (el: HTMLElement) => void }> = {
    explorer: explorerHead,
    servers: serversHead,
    commands: commandsHead,
    skills: skillsHead,
  };
  const sidebarActions = root.querySelector('#sidebar-actions') as HTMLElement;
  /* 面板契约：mount(panelRoot) 返回 cleanup（反注册监听 / 停定时器 / 作废闭包）。
     每个面板挂在独立新建的 panelRoot 上 —— 不再共享 #sidebar-content：
     卸载后面板的迟到的异步渲染只能写进已脱离 DOM 的旧根，天然不可见 */
  const MOUNTS: Record<string, (container: HTMLElement) => (() => void) | void> = {
    explorer: mountExplorerPanel,
    servers: mountServersPanel,
    commands: mountCommandsPanel,
    skills: mountSkillsPanel,
  };
  let currentPanel = 'explorer';
  let aiMounted = false;
  let unmountPanel: (() => void) | null = null;

  function mountPanel(panel: string): void {
    unmountPanel?.();
    unmountPanel = null;
    const head = HEADS[panel];
    sidebarTitle.textContent = head?.title ?? PANELS[panel] ?? panel;
    sidebarActions.innerHTML = '';
    head?.renderActions?.(sidebarActions);
    sidebarContent.innerHTML = '';
    const panelRoot = document.createElement('div');
    panelRoot.className = 'wbs-panel-root';
    sidebarContent.appendChild(panelRoot);
    unmountPanel = MOUNTS[panel]?.(panelRoot) ?? null;
    activityBar.querySelectorAll('.activity-icon').forEach((el) => {
      el.classList.toggle('active', el.getAttribute('data-panel') === panel);
    });
    Workbench.activePanel = panel;
  }

  function setPanel(panel: string): void {
    /* commands 准入：仅当活跃标签为终端 */
    if (panel === 'commands') {
      const tab = getActiveTab();
      if (!tab || tab.type !== 'terminal') { toast('请先激活一个终端标签页'); return; }
    }
    currentPanel = panel;
    mountPanel(panel);
  }
  // 供其他模块（如 SFTP 下载完成）程序化切换面板
  Workbench.switchPanel = (panel: string) => setPanel(panel);

  function setAiVisible(visible: boolean): void {
    if (!aiMounted) { mountAiPanel(aiPanel); aiMounted = true; }
    aiPanel.classList.toggle('hidden', !visible);
    aiResizer.classList.toggle('hidden', !visible);
    activityBar.querySelector('.ai-toggle')?.classList.toggle('active', visible);
  }

  activityBar.addEventListener('click', (e) => {
    const icon = (e.target as HTMLElement).closest('.activity-icon');
    if (!icon) return;
    const panel = icon.getAttribute('data-panel');
    if (panel === 'ai') { setAiVisible(aiPanel.classList.contains('hidden')); return; }
    if (!panel || panel === currentPanel) return;
    setPanel(panel);
  });

  /* 正在显示 commands 时活跃标签变为非终端（或 null）→ 自动切回 explorer；页面卸载时反注册 */
  const onTabActivated = (tab: Tab | null): void => {
    if (currentPanel === 'commands' && (!tab || tab.type !== 'terminal')) setPanel('explorer');
  };
  const offTabActivated = bus.on('tab-activated', onTabActivated);

  /* ---------- 项目装载（异步） ---------- */
  let project: Project | null = null;
  try {
    const state = await getState();
    project = state.projects.find((p) => p.id === params.get('project')) ?? state.projects[0] ?? null;
  } catch (err) {
    toast(`加载项目数据失败: ${String(err)}`, 'error');
  }
  if (!project) {
    toast('没有可用项目，请先在欢迎页创建项目', 'error');
    navigate('#/welcome');
    return () => {
      offTabActivated();
      resizeCleanups.forEach((cleanup) => cleanup());
      getTabs().forEach((t) => closeTab(t.id));
    };
  }
  Workbench.state.project = project;
  /* 装载成功:登记保活 id,路由层复用本页(保留标签页)与顶栏返回箭头以此为凭 */
  wbLifecycle.projectId = project.id;

  /* ---------- 默认面板 + AI 面板（原型 #ai-panel 常驻布局，默认开） ---------- */
  mountPanel('explorer');
  setAiVisible(true);

  /* ---------- 页面就绪后自动开一个本地终端标签 ---------- */
  openTab({
    id: 'term-local',
    type: 'terminal',
    title: '本地终端',
    data: { kind: 'local', cwd: project.path },
  });

  /* ---------- 云账号入口（CR-1.1b） ---------- */
  const avatarEntry = root.querySelector('[data-nav-account]') as HTMLElement;
  const renderAvatar = (s: CloudStatus) => {
    if (!s.serverUrl) { avatarEntry.hidden = true; return; } // 未接入云服务：隐藏入口
    avatarEntry.hidden = false;
    if (s.loggedIn && s.user?.avatar) {
      const img = document.createElement('img');
      img.alt = '';
      img.className = 'avatar-img';
      img.src = s.user.avatar;
      // 头像加载失败回退通用图标（CSP 禁内联脚本，用事件绑定）
      img.addEventListener('error', () => { avatarEntry.innerHTML = icon('user'); });
      avatarEntry.innerHTML = '';
      avatarEntry.appendChild(img);
      avatarEntry.title = `${s.user.name}（点击进入账号页）`;
    } else {
      avatarEntry.innerHTML = icon('user');
      avatarEntry.title = '登录公司账号';
    }
  };
  avatarEntry.addEventListener('click', () => navigate('#/account'));
  void cloudStatus().then(renderAvatar).catch(() => {});
  const offCloud = onCloudChanged(renderAvatar).catch(() => () => {});

  return () => {
    offTabActivated();
    void offCloud.then((un) => un()).catch(() => {});
    // 卸载当前面板（反注册其 bus 监听 / 停轮询），再关闭全部标签
    unmountPanel?.();
    unmountPanel = null;
    resizeCleanups.forEach((cleanup) => cleanup());
    // 关闭全部标签（closeTab 触发各渲染器 onClose → term_close 等后端清理）
    getTabs().forEach((t) => closeTab(t.id));
  };
}
