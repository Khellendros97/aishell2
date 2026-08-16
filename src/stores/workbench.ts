/**
 * 工作台全局状态(zustand):标签页管理器 + 侧栏面板状态 + AI 面板开关 + 跨模块句柄。
 * 语义逐条对照旧版 src/pages/workbench/core.ts(React 迁移):
 * - openTab 同 id 去重(激活并返回既有标签)、终端同名自动编号(编号不复用);
 * - closeTab 触发 tab.onClose(后端清理入口)、邻居标签补位激活,最后一个关闭后 activeId=null;
 * - 旧 bus 的 'tab-activated'/'tab-closed' 由状态订阅推导(useWorkbench(s => s.activeId)),
 *   不再单独广播;'project-changed'/'staging-changed' 保留为 wbEvents 通知(数据刷新用);
 * - 旧 Tab.api(渲染器返回的命令式句柄)改为 tabApis 注册表:标签组件挂载时 set、卸载时 delete;
 * - 旧 Workbench 全局句柄(ai/switchPanel/activePanel/DND_MIME)拆为 store 字段与 wbHandles.ai。
 * 与后端的接口点:无(纯前端状态);项目数据事实源仍在 Rust 端 aishell.json。
 */
import { create } from 'zustand';
import type { BrowserRef, FileRef, PathRef, Project, ServerRef, TermSnapshot } from '../types';
import type { IconName } from '../icons';
import { toast } from '../ui';

export type TabData = Record<string, unknown>;

export interface Tab {
  id: string;
  type: string;
  title: string;
  icon: IconName;
  data: TabData;
  onClose: ((tab: Tab) => void) | null;
}

export interface OpenTabOptions {
  id: string;
  type: string;
  title: string;
  data?: TabData;
  onClose?: ((tab: Tab) => void) | null;
  activate?: boolean;
}

/** 标签页组件契约:panes 常驻挂载(keep-alive),active 仅表示当前显示 */
export interface TabProps {
  tab: Tab;
  active: boolean;
}

export interface TerminalApi {
  paste(cmd: string): void;
  execute(cmd: string): void;
  takeSnapshot(): TermSnapshot;
  /** 聚焦终端(供 AI 面板粘贴命令等外部入口调用,目标标签未激活时需先 activateTab) */
  focus(): void;
  /** 发送 Ctrl+C(^C 中断)给终端进程(AI 面板等外部焦点场景转发中断用) */
  ctrlC(): void;
}

export interface AiHandle {
  addSnapshot(snap: TermSnapshot): void;
  /** 编辑器选区引用(@文件名_起始行_结束行号) */
  addFileRef?(ref: FileRef): void;
  /** 服务器/本地终端引用(@remote:服务器名称 / @local 标签) */
  addServerRef?(ref: ServerRef): void;
  /** 文件/目录路径引用(@file:文件名 / @path:目录名 标签,发送时只带路径不带内容) */
  addPathRef?(ref: PathRef): void;
  /** 内置浏览器元素引用(@browser:#id 或标签名 标签,发送时展开页面信息 + 元素 HTML) */
  addBrowserRef?(ref: BrowserRef): void;
  /** 当前 AI 会话 ID;会话尚未加载时返回 null。 */
  currentSessionId?(): string | null;
}

const TYPE_ICONS: Record<string, IconName> = {
  editor: 'file', sftp: 'globe', terminal: 'terminal', 'remote-staging': 'history', 'staging-diff': 'diff',
  browser: 'globe',
};

export type PanelKey = 'explorer' | 'servers' | 'commands' | 'skills';

interface WorkbenchState {
  project: Project | null;
  tabs: Tab[];
  activeId: string | null;
  panel: PanelKey;
  aiVisible: boolean;
  openTab(options: OpenTabOptions): Tab | null;
  closeTab(id: string): void;
  activateTab(id: string): void;
  setTabTitle(id: string, title: string): void;
  /** 切换侧栏面板;commands 有准入(活跃标签须为终端),不满足时 toast 并拒绝 */
  setPanel(panel: PanelKey): void;
  setAiVisible(visible: boolean): void;
  setProject(project: Project | null): void;
  /** 工作台实例销毁时复位(换项目重建 / 应用内销毁路径) */
  reset(): void;
}

/* ---------- 事件通知(旧 bus 中非标签派生的两条事件) ----------
   'project-changed'  项目数据被某模块修改(各面板据此刷新)
   'staging-changed'  暂存区变化
   on() 返回反注册函数:组件卸载时必须调用,监听器不得只增不减 */
type NotifyEvent = 'project-changed' | 'staging-changed';
const notifyListeners = new Map<NotifyEvent, Set<() => void>>();
export const wbEvents = {
  on(ev: NotifyEvent, cb: () => void): () => void {
    const set = notifyListeners.get(ev) ?? new Set();
    set.add(cb);
    notifyListeners.set(ev, set);
    return () => { set.delete(cb); };
  },
  emit(ev: NotifyEvent): void {
    (notifyListeners.get(ev) ?? []).forEach((cb) => cb());
  },
};

/* ---------- 命令式句柄注册表 ----------
   标签组件挂载时 tabApis.set(tab.id, api)、卸载时 delete;
   AI 面板挂载时写 wbHandles.ai、卸载时清空(标签栏右键「添加到对话」等外部入口用) */
export const tabApis = new Map<string, unknown>();
export const wbHandles = {
  ai: null as AiHandle | null,
};

/** 拖拽数据契约:dataTransfer 类型 'application/x-aishell',
    JSON: { source: 'local'|'remote', path: string, name: string, isDir: boolean, serverId?: string } */
export const DND_MIME = 'application/x-aishell';

/** 终端同名自动编号:同名「30.37」开第二个 → 「30.37 #2」;编号不复用(取现有最大后缀+1) */
function uniqueTerminalTitle(base: string, tabs: readonly Tab[]): string {
  let max = 0;
  for (const t of tabs) {
    if (t.type !== 'terminal') continue;
    const m = t.title.match(/^(.*?)(?:\s+#(\d+))?$/);
    if (m && m[1] === base) max = Math.max(max, Number(m[2] ?? 1));
  }
  return max === 0 ? base : `${base} #${max + 1}`;
}

export const useWorkbench = create<WorkbenchState>((set, get) => ({
  project: null,
  tabs: [],
  activeId: null,
  panel: 'explorer',
  aiVisible: true,

  openTab({ id, type, title, data = {}, onClose = null, activate = true }) {
    const s = get();
    const existing = s.tabs.find((t) => t.id === id);
    if (existing) {
      if (activate && s.activeId !== id) set({ activeId: id });
      else if (activate) return existing; // 同 id 已激活:无状态变化
      return existing;
    }
    // 未注册的标签类型不再像旧版 registerRenderer 一样拒绝:
    // 渲染层(registry)对未知类型显示占位提示,便于迁移期渐进接线
    const finalTitle = type === 'terminal' ? uniqueTerminalTitle(title, s.tabs) : title;
    const tab: Tab = { id, type, title: finalTitle, icon: TYPE_ICONS[type] ?? 'file', data, onClose };
    set({
      tabs: [...s.tabs, tab],
      activeId: activate || s.tabs.length === 0 ? id : s.activeId,
    });
    return tab;
  },

  closeTab(id) {
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = tabs[idx];
    tab.onClose?.(tab);
    tabApis.delete(id);
    const rest = tabs.filter((t) => t.id !== id);
    let nextActive = activeId;
    if (activeId === id) {
      const next = rest[Math.min(idx, rest.length - 1)];
      nextActive = next ? next.id : null;
    }
    set({ tabs: rest, activeId: nextActive });
  },

  activateTab(id) {
    if (get().activeId === id) return;
    set({ activeId: id });
  },

  setTabTitle(id, title) {
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, title } : t)) });
  },

  setPanel(panel) {
    if (panel === 'commands') {
      const s = get();
      const active = s.tabs.find((t) => t.id === s.activeId);
      if (!active || active.type !== 'terminal') {
        toast('请先激活一个终端标签页');
        return;
      }
    }
    set({ panel });
  },

  setAiVisible(visible) {
    set({ aiVisible: visible });
  },

  setProject(project) {
    set({ project });
  },

  reset() {
    tabApis.clear();
    wbHandles.ai = null;
    set({ project: null, tabs: [], activeId: null, panel: 'explorer', aiVisible: true });
  },
}));

/** 非 hook 版当前活跃标签(命令式代码 / selector 复用) */
export function getActiveTab(s: { tabs: Tab[]; activeId: string | null }): Tab | null {
  return s.tabs.find((t) => t.id === s.activeId) ?? null;
}

/** 当前可用的终端 api(供快捷指令 / AI 建议组件使用):
    优先活跃标签,否则最近打开的终端 */
export function getActiveTerminalApi(): TerminalApi | null {
  const s = useWorkbench.getState();
  const active = getActiveTab(s);
  if (active?.type === 'terminal') {
    const api = tabApis.get(active.id);
    if (api) return api as TerminalApi;
  }
  const anyTerm = [...s.tabs].reverse().find((t) => t.type === 'terminal');
  return anyTerm ? ((tabApis.get(anyTerm.id) as TerminalApi) ?? null) : null;
}

/* ---------- 控制台调试句柄(语义同旧版 window.Workbench) ---------- */
declare global {
  interface Window {
    Workbench: {
      state: { project: Project | null; activeId: string | null; panel: string; aiVisible: boolean };
      ai: AiHandle | null;
      openTab(options: OpenTabOptions): Tab | null;
      closeTab(id: string): void;
      tabs(): Tab[];
    };
  }
}
window.Workbench = {
  get state() {
    const s = useWorkbench.getState();
    return { project: s.project, activeId: s.activeId, panel: s.panel, aiVisible: s.aiVisible };
  },
  get ai() { return wbHandles.ai; },
  openTab: (o) => useWorkbench.getState().openTab(o),
  closeTab: (id) => useWorkbench.getState().closeTab(id),
  tabs: () => useWorkbench.getState().tabs,
};
