/**
 * 工作台核心：状态、事件总线、标签页管理器、模块注册表。
 * 逐行翻译自 .proto/workbench-core.js —— 本文件是所有工作台模块的协作契约，接口不得破坏。
 * 与原型唯一差异：DOM 容器由 init() 注入（workbench.ts 建好布局后调用），项目数据由 workbench.ts 异步装载。
 */
import type { FileRef, Project, TermSnapshot } from '../../types';
import { icon } from '../../icons';

export type TabData = Record<string, unknown>;

export interface Tab {
  id: string;
  type: string;
  title: string;
  icon: string;
  data: TabData;
  onClose: ((tab: Tab) => void) | null;
  api: unknown;
  el: HTMLElement;
  pane: HTMLElement;
}

export interface OpenTabOptions {
  id: string;
  type: string;
  title: string;
  data?: TabData;
  onClose?: ((tab: Tab) => void) | null;
  activate?: boolean;
}

export interface TerminalApi {
  paste(cmd: string): void;
  execute(cmd: string): void;
  takeSnapshot(): TermSnapshot;
}

export interface AiHandle {
  addSnapshot(snap: TermSnapshot): void;
  /** 编辑器选区引用（@文件名_起始行_结束行号） */
  addFileRef?(ref: FileRef): void;
}

/** fn(container, tab) 返回可选 tabApi 对象（供其他模块调用） */
export type RendererFn = (container: HTMLElement, tab: Tab) => unknown;
export type BusEvent = 'tab-activated' | 'tab-closed' | 'project-changed';
type BusCallback = (arg: Tab | null) => void;

const TYPE_ICONS: Record<string, string> = { editor: icon('file'), sftp: icon('globe'), terminal: icon('terminal') };

/* ---------- 事件总线 ----------
   'tab-activated'   (tab|null)      激活标签变化（关闭最后一个标签时发 null）
   'tab-closed'      (tab)
   'project-changed' ()              项目数据被某模块修改（各模块可据此刷新） */
const listeners = new Map<BusEvent, BusCallback[]>();
export const bus = {
  on(ev: BusEvent, cb: BusCallback): void {
    const list = listeners.get(ev) ?? [];
    list.push(cb);
    listeners.set(ev, list);
  },
  emit(ev: BusEvent, arg: Tab | null = null): void {
    (listeners.get(ev) ?? []).forEach((cb) => cb(arg));
  },
};

/* ---------- 渲染器注册表 ---------- */
const renderers = new Map<string, RendererFn>();
export function registerRenderer(type: string, fn: RendererFn): void {
  renderers.set(type, fn);
}

/* ---------- 标签页管理器 ---------- */
let tabBar: HTMLElement;
let tabContent: HTMLElement;
const tabs: Tab[] = [];
let activeId: string | null = null;

/** 由 workbench.ts 在布局 DOM 就绪后调用一次 */
export function initWorkbench(els: { tabBar: HTMLElement; tabContent: HTMLElement }): void {
  tabBar = els.tabBar;
  tabContent = els.tabContent;
}

export function openTab({
  id, type, title, data = {}, onClose = null, activate = true,
}: OpenTabOptions): Tab | null {
  const existing = tabs.find((t) => t.id === id);
  if (existing) {
    if (activate) activateTab(id);
    return existing;
  }
  const renderer = renderers.get(type);
  if (!renderer) {
    console.error('未注册的标签类型:', type);
    return null;
  }

  const tab = {
    id, type, title, icon: TYPE_ICONS[type] || icon('file'), data, onClose, api: null,
  } as Tab;
  tab.el = document.createElement('div');
  tab.el.className = 'wb-tab';
  tab.el.innerHTML = `<span class="tab-icon"></span><span class="tab-title"></span><button class="tab-close" title="关闭">${icon('x')}</button>`;
  tab.el.querySelector('.tab-icon')!.innerHTML = tab.icon;
  tab.el.querySelector('.tab-title')!.textContent = title;
  tab.el.onclick = (e) => { if (!(e.target as HTMLElement).closest('.tab-close')) activateTab(id); };
  (tab.el.querySelector('.tab-close') as HTMLButtonElement).onclick = () => closeTab(id);
  tabBar.appendChild(tab.el);

  tab.pane = document.createElement('div');
  tab.pane.className = 'tab-pane';
  tab.pane.dataset.tabId = id;
  tabContent.appendChild(tab.pane);

  tab.api = renderer(tab.pane, tab) ?? null;
  tabs.push(tab);
  if (activate || tabs.length === 1) activateTab(id);
  return tab;
}

export function setTabTitle(id: string, title: string): void {
  const tab = tabs.find((t) => t.id === id);
  if (tab) {
    tab.title = title;
    tab.el.querySelector('.tab-title')!.textContent = title;
  }
}

export function activateTab(id: string): void {
  if (activeId === id) return;
  activeId = id;
  tabs.forEach((t) => {
    t.el.classList.toggle('active', t.id === id);
    t.pane.classList.toggle('active', t.id === id);
  });
  bus.emit('tab-activated', getActiveTab());
}

export function closeTab(id: string): void {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [tab] = tabs.splice(idx, 1);
  if (tab.onClose) tab.onClose(tab);
  tab.el.remove();
  tab.pane.remove();
  bus.emit('tab-closed', tab);
  if (activeId === id) {
    activeId = null;
    const next = tabs[Math.min(idx, tabs.length - 1)];
    if (next) activateTab(next.id);
    else bus.emit('tab-activated', null);
  }
}

export function getActiveTab(): Tab | null {
  return tabs.find((t) => t.id === activeId) ?? null;
}

export function getTabs(): Tab[] {
  return tabs.slice();
}

/* ---------- 终端访问（供快捷指令 / AI 建议组件使用） ---------- */
export function getActiveTerminalApi(): TerminalApi | null {
  const active = getActiveTab();
  if (active && active.type === 'terminal' && active.api) return active.api as TerminalApi;
  const anyTerm = [...tabs].reverse().find((t) => t.type === 'terminal' && t.api);
  return anyTerm ? (anyTerm.api as TerminalApi) : null;
}

/* ---------- 全局句柄 ---------- */
export const Workbench = {
  state: { project: null as Project | null },
  ai: null as AiHandle | null,
  /** 侧栏面板切换（workbench.ts 挂载后注入）：sftp 下载完成切回文件资源管理器用 */
  switchPanel: null as ((panel: string) => void) | null,
  /** 当前显示的侧栏面板（explorer | servers | commands），快捷键按面板分发用 */
  activePanel: null as string | null,
  // 拖拽数据契约：dataTransfer 类型 'application/x-aishell'，
  // JSON: { source: 'local'|'remote', path: string, name: string, isDir: boolean, serverId?: string }
  DND_MIME: 'application/x-aishell',
  bus,
  registerRenderer,
  openTab,
  closeTab,
  activateTab,
  setTabTitle,
  getActiveTab,
  getTabs,
  getActiveTerminalApi,
};

declare global {
  interface Window {
    Workbench: typeof Workbench;
  }
}
window.Workbench = Workbench;
