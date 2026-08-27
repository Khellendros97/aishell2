/**
 * 欢迎页 —— AIShell 项目唯一维度主页（React 迁移）。
 * 对照 legacy/pages/welcome.ts（逐条移植）与 .proto/welcome.html / .proto/welcome.js（交互规格）；
 * 布局 / DOM 结构 / CSS 类名 / 交互 / 文案与 legacy 完全一致，顶栏由 App.tsx 提供，本组件不渲染 Topbar。
 *
 * 后端接口点（均见 src/api.ts）：get_state / upsert_project / delete_project / upsert_server /
 * delete_server / create_project_folder / rename_project_folder / delete_project_folder /
 * delete_folder_with_projects（按分类递归删除项目）/ set_ui_expanded（welcome:projectGroups 分组展开状态）/
 * save_settings（projectView 视图持久化）/ ensure_project_dirs（新建项目先拿最终路径再落盘）/
 * get_task_project（欢迎页 AI 系统任务上下文）；浏览按钮走 @tauri-apps/plugin-dialog 的 openDialog，
 * 通用 SSH 配置迁移走 AI + python-script skill。
 * 服务器 #tag 筛选与热门标签 chips 复用 src/shared/search.ts 的共享解析器。
 *
 * 服务器表单（mini 快捷新建 + 弹层完整模式）由并行迁移的 src/pages/settings/ServerForm.tsx 提供，
 * ref 句柄语义以 legacy/pages/server-form.ts 的 ServerFormHandle 为准
 * （fill / validate / buildServer / passwordValue / focusFirst，无容器 DOM 参数）。
 *
 * 与 legacy 的实现差异说明：
 * - 项目 / 服务器列表由 React 渲染（legacy 为 innerHTML 字符串 + 容器事件委托），交互语义逐条对应
 *   （data-act / data-id / data-folder 属性保留，click 用元素级 handler 替代 closest 委托分支）；
 * - 拖拽（项目拖到组标题改所属目录）沿用 dataTransfer MIME 约定，高亮用状态驱动（legacy 直接改 class）；
 * - 所属目录输入框的 attachCombo 在 useLayoutEffect 中挂载，卸载时先还原其 DOM 包装，
 *   避免 React 按 vdom 记录的父节点移除输入框时父节点不匹配（.combo 包装）抛异常。
 */
import {
  useEffect, useLayoutEffect, useRef, useState,
  type CSSProperties, type DragEvent, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import type { AppState, CloudStatus, Project, Server } from '../../types';
import {
  cloudBeginLogin, cloudStatus, createProjectFolder, deleteFolderWithProjects, deleteProject, deleteProjectFolder,
  deleteServer, ensureProjectDirs, getState, getTaskProject, onCloudChanged,
  openDialog, renameProjectFolder, saveSettings, setUiExpanded, upsertProject,
} from '../../api';
import { openUrl } from '@tauri-apps/plugin-opener';
import { attachCombo, confirmDialog, promptDialog, toast, uid } from '../../ui';
import { Icon } from '../../shared/Icon';
import {
  matchProject, matchServer, parseSearchQuery, toggleTagInQuery, topTags,
} from '../../shared/search';
import { navigate } from '../../router';
import { ServerForm, type ServerFormHandle } from '../settings/ServerForm';
import { saveServerWithCredentialChoice } from '../settings/server-save';
import { AiPanel } from '../workbench/ai/AiPanel';
import type { AiPanelController } from '../workbench/ai/ai-engine';
import '../welcome.css';

const welcomeLogoUrl = new URL('../../assets/logo.svg', import.meta.url).href;

/** 初始空状态（与 legacy welcome.ts 的 db 初值逐字段一致；真实数据装载后整体替换） */
const EMPTY_STATE: AppState = {
  settings: {
    workspaceDir: null,
    llm: { modelId: '', baseUrl: '', effort: 'low' },
    search: { enabled: false },
    theme: 'dark',
    autoSwitchAiWorkdir: true,
    projectView: 'card',
    approvalMode: 'smart',
    cloud: { mode: 'personal', user: null, capabilities: null },
    autoBackupRemoteFiles: true,
    knowledge: { autoInject: true, injectCount: 5 },
  },
  servers: [], credentials: [], projects: [], sessions: {}, projectFolders: [], commandFolders: [], uiExpanded: {},
  sftpHistory: {}, sftpFavorites: {}, dbConnections: {}, mcp: { port: 8945 }, mcpDevices: {},
  seededSkillWorkspaces: [],
  traceEnabled: false,
};

/**
 * 页面根节点补 flex 属性：App.tsx 已提供 .page-root 弹性列（等价 legacy 的
 * `.page-root.welcome-page` 同元素结构），本根节点作为其中一列占满剩余高度，
 * 使 .welcome-page main { flex: 1 } 的内部滚动布局与 legacy 一致。
 */
const PAGE_ROOT_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 };

/** 分类树节点：path 为完整 '/' 分隔路径（'' 仅用于未分类，不进树），projects 为直属该项目录的项目 */
interface FolderNode {
  name: string;
  path: string;
  children: FolderNode[];
  projects: Project[];
}

/**
 * 构建分类树：目录来源 = projectFolders ∪ 各项目 folder（非搜索态，空目录也渲染）；
 * 搜索态只由 filtered 项目的 folder 建树（含祖先链）。children 按中文字序排序。
 */
function buildFolderTree(db: AppState, filtered: Project[], searching: boolean): FolderNode[] {
  const roots: FolderNode[] = [];
  const nodes = new Map<string, FolderNode>();
  const ensure = (path: string): void => {
    if (!path || nodes.has(path)) return;
    let acc = '';
    let prev: FolderNode | null = null;
    for (const seg of path.split('/')) {
      acc = acc ? `${acc}/${seg}` : seg;
      let node = nodes.get(acc);
      if (!node) {
        node = { name: seg, path: acc, children: [], projects: [] };
        nodes.set(acc, node);
        if (prev) prev.children.push(node);
        else roots.push(node);
      }
      prev = node;
    }
  };

  if (!searching) {
    (db.projectFolders ?? []).forEach((f) => ensure(f));
  }
  for (const p of filtered) {
    const f = p.folder || '';
    if (!f) continue;
    ensure(f);
    nodes.get(f)!.projects.push(p);
  }
  const sortRec = (n: FolderNode): void => {
    n.children.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    n.children.forEach(sortRec);
  };
  roots.forEach(sortRec);
  return roots;
}

/** 收集树内全部目录路径（全部展开 / 折叠按钮用） */
function collectFolderPaths(roots: readonly FolderNode[], out: string[] = []): string[] {
  for (const n of roots) {
    out.push(n.path);
    collectFolderPaths(n.children, out);
  }
  return out;
}

/** 节点的递归项目数（直属 + 全部子分类，组标题角标用） */
function countProjects(node: FolderNode): number {
  return node.projects.length
    + node.children.reduce((sum, c) => sum + countProjects(c), 0);
}

export function Welcome(_props: { params: URLSearchParams }): JSX.Element {
  /* ---------- 云登录快捷通道（CR-1.9）：未登录且构建注入了 serverUrl 时显示 ----------
     登录成功后 cloud:changed 驱动隐藏,无需等待回调 */
  const [cloudBarVisible, setCloudBarVisible] = useState(false);
  useEffect(() => {
    const render = (s: CloudStatus): void => setCloudBarVisible(!!s.serverUrl && !s.loggedIn);
    let un: (() => void) | null = null;
    void cloudStatus().then(render).catch(() => {});
    void onCloudChanged(render).then((u) => { un = u; }).catch(() => {});
    return () => { un?.(); };
  }, []);

  /* ---------- 渲染相关状态 ---------- */
  const [db, setDb] = useState<AppState>(EMPTY_STATE);
  /** 首次 getState 装载完成前不展示空态（legacy 骨架中空态初始为 hidden，装载后才计算） */
  const [loaded, setLoaded] = useState(false);
  const [viewMode, setViewMode] = useState<'card' | 'list'>('card');
  const [query, setQuery] = useState('');
  /** 展开状态的项目分类分组（键 = folder 值，空串 = 未分类）；默认全折叠 */
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  /** 列表视图中展开子表（绑定服务器）的项目 id */
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());
  /** 拖拽中项目 id（.dragging 视觉态，随 React 渲染管理） */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  /** 当前拖拽放置目标组（.drop-target 高亮，随 React 渲染管理） */
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  /** 通用 SSH 工具迁移任务启动状态。 */
  const [importBusy, setImportBusy] = useState(false);
  const [taskProject, setTaskProject] = useState<Project | null>(null);
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskAiReady, setTaskAiReady] = useState(false);
  const taskAiRef = useRef<AiPanelController | null>(null);

  /* ---------- 项目模态框状态（新建 / 编辑） ---------- */
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);   // null = 新建
  const [selectedServerIds, setSelectedServerIds] = useState<string[]>([]);
  const [nameError, setNameError] = useState(false);
  const [serverQuery, setServerQuery] = useState('');
  const [miniExpanded, setMiniExpanded] = useState(false);
  const [miniErr, setMiniErr] = useState<string | null>(null);
  const fNameRef = useRef<HTMLInputElement>(null);
  const fPathRef = useRef<HTMLInputElement>(null);
  const fFolderRef = useRef<HTMLInputElement>(null);
  const miniFormRef = useRef<ServerFormHandle>(null);

  /* ---------- 列表视图：绑定服务器 添加 / 编辑模态框 ---------- */
  const [srvHidden, setSrvHidden] = useState(true);                  // 关闭动画结束后加 hidden
  const [srvOpen, setSrvOpen] = useState(false);                     // .open 类（淡入动画）
  const [srvErr, setSrvErr] = useState<string | null>(null);
  const [srvEditingId, setSrvEditingId] = useState<string | null>(null);
  /** 新建服务器自动并入该项目的绑定 */
  const [srvContextProjectId, setSrvContextProjectId] = useState<string | null>(null);
  const srvFormRef = useRef<ServerFormHandle>(null);

  /* ---------- 非渲染状态 ---------- */
  /** 本次会话已从后端恢复过分组展开状态（每会话只播种一次，避免重复覆盖用户操作） */
  const groupsSeededRef = useRef(false);
  /** 分组展开状态防抖落盘定时器（300ms 合并连续 toggle） */
  const persistTimerRef = useRef<number | null>(null);
  /** srv 弹层关闭动画定时器 / 打开 rAF 句柄（重新打开时取消防抖残留） */
  const srvCloseTimerRef = useRef<number | null>(null);
  const srvOpenRafRef = useRef<number | null>(null);
  /** 最新 db 快照（attachCombo 每次展开取候选用，见 folderOptions） */
  const dbRef = useRef<AppState>(EMPTY_STATE);

  /* ---------- 分组展开状态持久化（落盘 uiExpanded['welcome:projectGroups']，key 语义见 types.ts） ---------- */
  /** 300ms 防抖把分组展开集合写入后端；失败仅 console.warn 不打扰用户 */
  function persistGroupsExpanded(snapshot: Set<string>): void {
    const arr = [...snapshot];
    if (persistTimerRef.current !== null) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      setUiExpanded('welcome:projectGroups', arr).catch((err) =>
        console.warn('保存分组展开状态失败:', err));
    }, 300);
  }

  /* ---------- 工具行：视图切换（落盘持久化） ---------- */
  async function switchView(v: 'card' | 'list') {
    if (viewMode === v) return;
    setViewMode(v);
    try {
      await saveSettings({ ...db.settings, projectView: v }, null, null);
    } catch (err) {
      toast(String(err), 'error');
    }
  }

  /* ---------- 分组交互 ---------- */
  function toggleGroup(folder: string) {
    const next = new Set(expandedGroups);
    if (next.has(folder)) next.delete(folder);
    else next.add(folder);
    setExpandedGroups(next);
    persistGroupsExpanded(next);
  }
  function toggleRow(projectId: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }

  /* ---------- 拖拽整理：项目拖到组标题 = 改所属目录；未分类组标题 = 清空 ---------- */
  const onProjectDragStart = (e: DragEvent<HTMLDivElement>) => {
    const id = e.currentTarget.dataset.id;
    if (!e.dataTransfer || !id) return;
    e.dataTransfer.setData('application/x-aishell-project', id);
    e.dataTransfer.setData('text/plain', id); // 兜底：外部场景读不到自定义类型
    setDraggingId(id);
  };
  const onProjectDragEnd = () => {
    setDraggingId(null);
    setDropTarget(null); // 拖出窗口 / 中途取消时清理残留的放置高亮
  };
  const onGroupsDragOver = (e: DragEvent<HTMLDivElement>) => {
    const title = (e.target as HTMLElement).closest<HTMLElement>('.proj-group-title');
    if (!e.dataTransfer || !title) return;
    if (!Array.from(e.dataTransfer.types).includes('application/x-aishell-project')) return;
    e.preventDefault(); // 声明可放置，drop 才会触发
    const folder = title.dataset.folder ?? '';
    setDropTarget((prev) => (prev === folder ? prev : folder)); // 相同值跳过，避免拖过时反复重渲染
  };
  const onGroupTitleDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return; // 标题内子元素间移动不取消
    setDropTarget(null);
  };
  const onGroupsDrop = (e: DragEvent<HTMLDivElement>) => {
    const title = (e.target as HTMLElement).closest<HTMLElement>('.proj-group-title');
    if (!e.dataTransfer || !title) return;
    e.preventDefault();
    setDropTarget(null);
    const id = e.dataTransfer.getData('application/x-aishell-project') || e.dataTransfer.getData('text/plain');
    const proj = db.projects.find((p) => p.id === id);
    if (!proj) return;
    const folderKey = title.dataset.folder ?? '';
    if ((proj.folder || '') === folderKey) return; // 已在目标组，跳过
    void moveProjectToFolder(proj, folderKey);
  };

  /** 拖拽移动项目到目标目录 */
  async function moveProjectToFolder(proj: Project, folder: string): Promise<void> {
    try {
      await upsertProject({ ...proj, folder });
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    setDb(await getState());
    toast(`已移动到「${folder || '未分类'}」`, 'success');
  }

  /* ---------- 分类目录：新建 / 重命名 / 删除（语义同 legacy） ---------- */
  async function createFolderFlow(): Promise<void> {
    const name = await promptDialog({
      title: '新建分类目录',
      label: '目录路径（可含 / 层级）',
      placeholder: '例如：生产环境/Web',
      okText: '创建',
      allowPath: true,
    });
    if (name === null) return;
    try {
      await createProjectFolder(name);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    setDb(await getState());
    toast(`分类目录「${name}」已创建`, 'success');
  }

  async function renameFolderFlow(folder: string): Promise<void> {
    const name = await promptDialog({
      title: '重命名分类目录',
      label: '目录路径（可含 / 层级）',
      defaultValue: folder,
      okText: '重命名',
      allowPath: true,
    });
    if (name === null) return;
    try {
      await renameProjectFolder(folder, name);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    setDb(await getState());
    // 前缀级联重命名后，旧目录及其子分类的折叠状态整体清除（新路径保持展开可见）
    const oldPrefix = `${folder}/`;
    const next = new Set(expandedGroups);
    for (const k of [...next]) {
      if (k === folder || k.startsWith(oldPrefix)) next.delete(k);
    }
    setExpandedGroups(next);
    persistGroupsExpanded(next);
    toast(`分类目录已重命名为「${name}」`, 'success');
  }

  /**
   * 删除分类目录：
   * - 目录与子分类下都没有项目 → 仅删目录条目（delete_project_folder），简单确认；
   * - 有项目（含子分类）→ 危险确认弹窗列出全部受影响项目，调 delete_folder_with_projects
   *   递归删除（服务器保留不删除，便于误导入后整批清掉重新导入）。
   */
  async function deleteFolderFlow(folder: string): Promise<void> {
    const prefix = `${folder}/`;
    const affectedFolders = (db.projectFolders ?? []).filter(
      (f) => f === folder || f.startsWith(prefix),
    );
    const affectedProjects = (db.projects ?? []).filter(
      (p) => (p.folder || '') === folder || (p.folder || '').startsWith(prefix),
    );
    if (affectedProjects.length === 0 && affectedFolders.length <= 1) {
      const ok = await confirmDialog({
        title: '删除分类目录',
        message: `确定删除分类目录「${folder}」吗？`,
        danger: true,
        okText: '删除',
      });
      if (!ok) return;
      try {
        await deleteProjectFolder(folder);
      } catch (err) {
        toast(String(err), 'error');
        return;
      }
      setDb(await getState());
      toast(`分类目录「${folder}」已删除`, 'success');
    } else {
      const subCount = Math.max(0, affectedFolders.length - 1);
      const scope = subCount > 0 ? `及其 ${subCount} 个子分类` : '';
      const ok = await confirmDialog({
        title: '删除分类及项目',
        message:
          `将删除分类「${folder}」${scope}下的共 ${affectedProjects.length} 个项目` +
          '（清单见下方）。仅删除项目记录与 AI 会话，不会删除磁盘文件和服务器配置。',
        danger: true,
        okText: `删除 ${affectedProjects.length} 个项目`,
        list: affectedProjects.map((p) => p.name),
      });
      if (!ok) return;
      let n: number;
      try {
        n = await deleteFolderWithProjects(folder);
      } catch (err) {
        toast(String(err), 'error');
        return;
      }
      setDb(await getState());
      toast(`已删除「${folder}」下 ${n} 个项目`, 'success');
    }
    // 已删除目录及其子分类的折叠状态一并清理
    const next = new Set(expandedGroups);
    for (const k of [...next]) {
      if (k === folder || k.startsWith(prefix)) next.delete(k);
    }
    setExpandedGroups(next);
    persistGroupsExpanded(next);
  }

  /* ---------- 删除项目 ---------- */
  async function deleteProjectFlow(id: string) {
    const proj = db.projects.find((p) => p.id === id);
    if (!proj) return;
    const ok = await confirmDialog({
      title: '删除项目',
      message: `确定要删除项目「${proj.name}」吗？仅删除项目记录，不会删除磁盘文件。`,
      danger: true,
      okText: '删除',
    });
    if (!ok) return;
    try {
      await deleteProject(id);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    setDb((prev) => ({ ...prev, projects: prev.projects.filter((p) => p.id !== id) }));
    toast('项目已删除', 'success');
  }

  /* ---------- 新建 / 编辑项目模态框 ---------- */
  function openModal(mode: 'new' | 'edit', id?: string) {
    setEditingId(mode === 'edit' ? (id ?? null) : null);
    if (mode === 'edit' && id) {
      const proj = db.projects.find((p) => p.id === id);
      if (!proj) return;
      if (fNameRef.current) fNameRef.current.value = proj.name || '';
      if (fPathRef.current) fPathRef.current.value = proj.path || '';
      if (fFolderRef.current) fFolderRef.current.value = proj.folder || '';
      setSelectedServerIds((proj.serverIds || []).slice());
    } else {
      if (fNameRef.current) fNameRef.current.value = '';
      if (fPathRef.current) fPathRef.current.value = '';
      if (fFolderRef.current) fFolderRef.current.value = '';
      setSelectedServerIds([]);
    }
    setNameError(false);
    setModalOpen(true);
    fNameRef.current?.focus();
  }

  function closeModal() {
    setModalOpen(false);
  }

  /* 名称必填校验（输入即清除，与 legacy 一致） */
  function showNameError() {
    setNameError(true);
    fNameRef.current?.focus();
  }

  /* 目录浏览…：真实目录选择 */
  const onBrowse = async () => {
    const path = await openDialog({ directory: true });
    if (path && fPathRef.current) fPathRef.current.value = path;
  };

  /* Enter 快捷保存（所属目录输入框的 attachCombo 原生 keydown 先于 React 委托执行，顺序同 legacy） */
  const onProjectFieldEnter = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') void saveProject();
  };

  /* 保存项目 */
  async function saveProject() {
    const name = (fNameRef.current?.value ?? '').trim();
    if (!name) {
      showNameError();
      return;
    }
    const pathInput = (fPathRef.current?.value ?? '').trim();
    const serverIds = selectedServerIds.slice();
    // 过滤已不存在的服务器 id：跨页面操作（如工作台删除服务器）后本页内存快照可能过期，
    // 直接全量覆盖会把幽灵 id 写回配置文件。
    try {
      const alive = new Set((await getState()).servers.map((s) => s.id));
      if (serverIds.length) {
        for (let i = serverIds.length - 1; i >= 0; i--) {
          if (!alive.has(serverIds[i])) serverIds.splice(i, 1);
        }
      }
    } catch {
      /* 后端未就绪时保持原勾选 */
    }
    // 所属目录：规范化 '/' 分隔路径（去首尾/重复分隔符），留空 = 未分类
    const folder = (fFolderRef.current?.value ?? '').trim().split('/').filter(Boolean).join('/');

    if (editingId) {
      const proj = db.projects.find((p) => p.id === editingId);
      if (!proj) return;
      const updated: Project = { ...proj, name, path: pathInput || null, serverIds, folder };
      try {
        await upsertProject(updated);
      } catch (err) {
        toast(String(err), 'error');
        return;
      }
      setDb((prev) => ({
        ...prev,
        projects: prev.projects.map((p) => (p.id === proj.id ? updated : p)),
      }));
      closeModal();
      notifyDataChanged();
      toast('已保存', 'success');
    } else {
      let finalPath: string;
      let proj: Project;
      try {
        finalPath = await ensureProjectDirs(pathInput || null, name);
        proj = {
          id: uid('proj'),
          name,
          path: finalPath,
          serverIds,
          quickCommands: [],
          // 新项目默认建议模式（不扩大权限；模式按项目持久化）
          aiMode: 'suggest',
          folder,
        };
        await upsertProject(proj);
      } catch (err) {
        toast(String(err), 'error');
        return;
      }
      setDb((prev) => ({ ...prev, projects: [...prev.projects, proj] }));
      closeModal();
      notifyDataChanged();
      toast('项目已创建', 'success');
    }
  }

  /** 后端数据变化广播：命令面板同款事件，通知保活的工作台（绑定服务器等）返回后刷新，避免列表过期 */
  function notifyDataChanged(): void {
    window.dispatchEvent(new CustomEvent('aishell:data-changed'));
  }

  /* ---------- 服务器多选列表（平铺，仅搜索过滤） ---------- */
  function toggleServer(id: string) {
    setSelectedServerIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  /* ---------- 快捷新建服务器（字段与校验复用 ServerForm，与侧栏编辑表单同源；密码留空 = 不保存） ---------- */
  function expandMini() {
    setMiniExpanded(true);
    clearMiniError();
    miniFormRef.current?.focusFirst();
  }
  function collapseMini() {
    setMiniExpanded(false);
  }
  function clearMiniError() {
    setMiniErr(null);
  }
  function resetMini() {
    miniFormRef.current?.fill(null); // 清空为新建态（密码/密钥路径不留上次输入）
    clearMiniError();
  }

  async function saveMiniServer() {
    clearMiniError();

    const err = miniFormRef.current?.validate() ?? null;
    if (err) {
      setMiniErr(err);
      return;
    }
    const srv = miniFormRef.current!.buildServer(null);
    const password = miniFormRef.current!.passwordValue();
    let saved: Server | null;
    try {
      saved = await saveServerWithCredentialChoice(srv, password);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    if (!saved) return;
    setDb((prev) => ({ ...prev, servers: [...prev.servers, saved!] }));
    setSelectedServerIds((prev) => [...prev, saved!.id]);
    collapseMini();
    resetMini();
    toast('服务器已创建并自动选中', 'success');
  }

  /* ---------- 列表视图：绑定服务器 添加 / 编辑 / 删除 ---------- */
  function openSrvModal(server: Server | null, contextProjectId: string | null) {
    // 关闭动画未结束就重新打开：取消残留的隐藏定时器，避免新弹层被旧定时器隐藏（legacy 有此竞态）
    if (srvCloseTimerRef.current !== null) {
      window.clearTimeout(srvCloseTimerRef.current);
      srvCloseTimerRef.current = null;
    }
    if (srvOpenRafRef.current !== null) {
      window.cancelAnimationFrame(srvOpenRafRef.current);
      srvOpenRafRef.current = null;
    }
    setSrvEditingId(server ? server.id : null);
    setSrvContextProjectId(contextProjectId);
    setSrvErr(null);
    setSrvHidden(false);
    srvOpenRafRef.current = window.requestAnimationFrame(() => {
      srvOpenRafRef.current = null;
      setSrvOpen(true);
    });
    srvFormRef.current?.fill(server);
    srvFormRef.current?.focusFirst();
  }

  function closeSrvModal() {
    setSrvOpen(false);
    if (srvOpenRafRef.current !== null) {
      window.cancelAnimationFrame(srvOpenRafRef.current);
      srvOpenRafRef.current = null;
    }
    if (srvCloseTimerRef.current !== null) window.clearTimeout(srvCloseTimerRef.current);
    srvCloseTimerRef.current = window.setTimeout(() => {
      srvCloseTimerRef.current = null;
      setSrvHidden(true);
    }, 160);
  }

  async function saveSrvModal() {
    const err = srvFormRef.current?.validate() ?? null;
    if (err) {
      setSrvErr(err);
      return;
    }
    const editing = srvEditingId ? db.servers.find((s) => s.id === srvEditingId) ?? null : null;
    const srv = srvFormRef.current!.buildServer(editing);
    const password = srvFormRef.current!.passwordValue();
    let saved: Server | null;
    try {
      saved = await saveServerWithCredentialChoice(srv, password);
    } catch (e) {
      toast(String(e), 'error');
      return;
    }
    if (!saved) return;

    if (editing) {
      setDb((prev) => ({
        ...prev,
        servers: prev.servers.map((s) => (s.id === editing.id ? saved! : s)),
      }));
      toast('服务器已更新', 'success');
    } else {
      setDb((prev) => ({ ...prev, servers: [...prev.servers, saved!] }));
      // 新建服务器：把 id 并入当前项目绑定后再落盘（幂等去重）
      if (srvContextProjectId) {
        const proj = db.projects.find((p) => p.id === srvContextProjectId);
        if (proj && !proj.serverIds.includes(srv.id)) {
          const updated = { ...proj, serverIds: [...proj.serverIds, srv.id] };
          try {
            await upsertProject(updated);
          } catch (e) {
            toast(`服务器已创建，但绑定项目失败：${String(e)}`, 'error');
            closeSrvModal();
            return;
          }
          setDb((prev) => ({
            ...prev,
            projects: prev.projects.map((p) => (p.id === proj.id ? updated : p)),
          }));
        }
      }
      toast('服务器已创建', 'success');
    }
    closeSrvModal();
  }

  /** 删除服务器（列表视图子表）：后端级联从绑定项目 serverIds 中移除，本地同步 */
  async function deleteServerFlow(server: Server) {
    const bound = db.projects.filter((p) => p.serverIds.includes(server.id)).map((p) => p.name);
    let msg = `确定要删除服务器「${server.name}」吗？`;
    if (bound.length) {
      msg += `该服务器被以下项目绑定：${bound.join('、')}。删除后将从这些项目的绑定中移除。`;
    } else {
      msg += '此操作不可撤销。';
    }
    const ok = await confirmDialog({ title: '删除服务器', message: msg, danger: true, okText: '删除' });
    if (!ok) return;
    try {
      await deleteServer(server.id);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    setDb((prev) => ({
      ...prev,
      servers: prev.servers.filter((s) => s.id !== server.id),
      projects: prev.projects.map((p) => ({
        ...p,
        serverIds: p.serverIds.filter((id) => id !== server.id),
      })),
    }));
    toast(`已删除服务器「${server.name}」`, 'success');
  }

  /* ---------- AI 通用 SSH 配置迁移 ---------- */
  async function importSshToolFlow() {
    const toolName = await promptDialog({
      title: '从其他 SSH 工具导入',
      label: 'SSH 工具名称',
      placeholder: '例如 XShell、SecureCRT、MobaXterm、FinalShell',
      okText: '开始探查',
    });
    const name = (toolName ?? '').trim();
    if (!name) return;
    const controller = taskAiRef.current;
    if (!controller || !taskProject) {
      toast(taskError ?? 'AI 助手仍在初始化，请稍后重试', 'error');
      return;
    }
    const prompt = `我要把「${name}」中的 SSH 配置迁移到 AIShell。整个过程分三个阶段，请严格按阶段顺序执行：

【阶段一：探查】（由你自主完成，探查脚本会自动执行，无需等待逐条批准）
1. 首先读取并遵循已挂载的 python-script skill。当前是本地系统任务上下文，工作目录为 ${taskProject.path}，未绑定任何远程服务器。
2. 用 py 工具编写并执行只读 Python 脚本，检查环境变量与常见用户目录，定位「${name}」的安装目录、配置目录和 SSH 配置文件，扫描并解析其结构。可分多个脚本逐步深入；脚本内不要 import aishell 的 config 模块（那会触发人工审批并打断探查）。
3. 严禁读取、输出、解密或迁移密码、私钥正文、私钥短语、令牌等秘密。只收集：配置路径、格式、条目数量、完整目录树、名称、主机、端口、用户名、认证类型和私钥路径。
4. 探查完成后，用中文简要汇总发现结果。

【阶段二：确认导入计划】
5. 基于探查结果制定迁移计划：字段映射、按 host + port + username 去重的规则、预计新增/复用/跳过项、待用户补充的凭据。计划必须包含「源目录 → 分类 / 项目 / 标签」对照表。AIShell 采用「分类-项目-主机」三层语义结构，你需要对源工具的目录树做语义分析后再落位，规则如下：
   - 地理位置类目录（如 华东、华北、浙江省、北京 等行政区划或地域词）→ 转为分类目录（import_project 的 folder 参数），支持多级嵌套路径（用 / 分隔，如 folder="华东/浙江省"）。纯地理层级本身不建项目。
   - 具体单位 / 业务系统类目录（如 xx大学、xx企业、xx系统、xx平台）→ 转为一个 AIShell 项目，项目名取目录名；其上级地理层级写入 folder（不含工具名）。例如源结构「北京/北京航空航天大学/新平台」：北京 → folder 层级、北京航空航天大学 → 项目名、新平台 → 该组服务器的标签。
   - 其余细分分组（如 AAA、BI、访客、部门名、用途归类等）→ 不建项目也不建分类，转为该组内每台服务器的标签：随 import_project 的 servers[i].tags 字段传入（字符串数组，如 ["AAA","访客"]）；同名细分分组出现在多处时可合并为同一个标签。
   - 直接挂在源根目录、不属于任何分组的会话归入名为「未分组」的项目（folder 留空 = 未分类）。只有当源工具完全没有目录结构时，才把所有项目统一放到以「${name}」命名的分类下（folder="${name}"）作为兜底。
   - 分类只承载地理等大颗粒语义层级；禁止把细粒度分组建成分类目录（那会让分类树退化成源目录树的镜像），禁止把所有服务器聚合到单个项目。
   - 同一地理层级下的多个单位各自建项目。项目按名称去重：不同上级路径下的同名目录会引发冲突，计划中必须标注并给出消歧后的项目名（如「Web（生产环境）」）。
6. 用 ask 工具把计划提交给我确认：把「源目录 → 分类 / 项目 / 标签」对照表和新增/复用/跳过统计放进问题正文，用选项让我选择（如是否按此计划继续、同名目录如何消歧、待补凭据如何处理）。不要只在回复正文里罗列计划等我打字回复。
7. 我回答后，如需最终把关再调用一次 confirm 工具（如「确认按上述计划执行导入？」）。我确认前不得写文件、不得调用 aishell.config.import_project、不得修改 AIShell 配置。

【阶段三：执行导入】
8. 我确认后，完整展示最终 Python 迁移脚本及影响。脚本只能写入当前 tasks 工作目录，必须通过 from aishell import config 调用 config.import_project 等受控 SDK，按源目录逐个建项目（每个目录一次 import_project 调用），禁止直接读取或编辑 aishell.json。涉及配置写入的脚本会请求人工批准，属正常流程，如实等待即可。
9. 调用 py 执行，并汇总新增、复用、跳过和待人工补凭据的结果。

现在开始阶段一探查。`;
    setImportBusy(true);
    try {
      await controller.startConversation(prompt);
      toast(`已创建「${name}」配置迁移会话`, 'success');
    } catch (err) {
      toast(`启动迁移会话失败：${String(err)}`, 'error');
    } finally {
      setImportBusy(false);
    }
  }

  /* ---------- effects ---------- */

  /* 初始装载：拉取全量状态；恢复视图模式与分组展开状态（每会话只播种一次） */
  useEffect(() => {
    void getState()
      .then((s) => {
        setDb(s);
        setLoaded(true);
        setViewMode(s.settings.projectView ?? 'card');
        if (!groupsSeededRef.current) {
          groupsSeededRef.current = true;
          setExpandedGroups(new Set(s.uiExpanded?.['welcome:projectGroups'] ?? []));
        }
      })
      .catch((err) => toast(String(err), 'error'));
    void getTaskProject()
      .then((p) => { setTaskProject(p); setTaskError(null); })
      .catch((err) => setTaskError(String(err)));
    return () => { taskAiRef.current = null; };
  }, []);

  /* 命令面板（Ctrl+T）等全局操作清空/变更数据后广播，此处重新拉取渲染 */
  useEffect(() => {
    const onDataChanged = () => {
      void getState()
        .then((s) => {
          setDb(s);
          // 模态框打开时服务器列表/项目分组随 db 状态自动重渲染（legacy 的 renderServerList 职责）
        })
        .catch((err) => toast(String(err), 'error'));
    };
    window.addEventListener('aishell:data-changed', onDataChanged);
    return () => window.removeEventListener('aishell:data-changed', onDataChanged);
  }, []);

  /* Esc 关闭弹层：先项目模态框，再 srv 弹层（与 legacy 顺序一致） */
  useEffect(() => {
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (modalOpen) closeModal();
      else if (srvOpen) closeSrvModal();
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, [modalOpen, srvOpen]);

  /* db 快照同步（attachCombo 展开时取最新候选用） */
  useEffect(() => {
    dbRef.current = db;
  }, [db]);

  /**
   * 所属目录组合框：候选 = projectFolders ∪ 各项目 folder 派生值，去重排序；未分类不列。
   * attachCombo 每次展开时取最新候选（经 dbRef，避免闭包过期）；手输新目录保存时由后端 upsert_project 自动注册。
   * 注意必须用 useLayoutEffect：卸载时它的 destroy 先于子节点 DOM 移除执行（React 18 删除顺序），
   * 可在 React 按 vdom 父节点移除 input 之前把它从 .combo 包装还原回 .field，避免 removeChild 抛异常。
   */
  useLayoutEffect(() => {
    const input = fFolderRef.current;
    if (!input) return;
    attachCombo(input, () => {
      const names = new Set<string>(dbRef.current.projectFolders ?? []);
      dbRef.current.projects.forEach((p) => { if (p.folder) names.add(p.folder); });
      return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh'));
    });
    return () => {
      input.dispatchEvent(new FocusEvent('blur')); // 收起可能打开的下拉（同时移除 document/window 临时监听）
      const wrap = input.parentElement;
      if (wrap && wrap.classList.contains('combo') && wrap.parentElement) {
        wrap.parentElement.insertBefore(input, wrap); // 还原 input 到 React 管理的 .field 下
        wrap.remove();
      }
    };
  }, []);

  /* ---------- 渲染计算（分类树 + 搜索；对应 legacy renderProjects 的分组/空态职责） ---------- */
  const parsedQuery = parseSearchQuery(query);
  const searching = !!query.trim();
  const projects = db.projects || [];
  const serversById = new Map((db.servers || []).map((s) => [s.id, s] as const));
  // 项目过滤：#tag 条件 AND + name/path/folder 文本匹配（共享解析器）
  const filtered = searching ? projects.filter((p) => matchProject(p, serversById, parsedQuery)) : projects;
  const folderTree = buildFolderTree(db, filtered, searching);
  // 完全没有项目且没有任何目录 → 引导空态；有项目但搜索无命中 → 搜索空态
  // （loaded 前与 legacy 骨架一致：空态保持 hidden，等首次 getState 后再展示）
  const folderCount = new Set([
    ...(db.projectFolders ?? []),
    ...projects.map((p) => p.folder || ''),
  ]).size;
  const showEmpty = loaded && projects.length === 0 && folderCount === 0;
  const showSearchEmpty = loaded && projects.length > 0 && filtered.length === 0;
  // 「全部展开 / 全部折叠」单按钮：按当前状态切换，图标 = 目标动作（含未分类组）
  const folderPaths = collectFolderPaths(folderTree);
  const allFolderKeys = ['', ...folderPaths];
  const allExpanded = folderPaths.length > 0 && allFolderKeys.every((k) => expandedGroups.has(k));
  const wsDir = db.settings.workspaceDir || '';
  /** 搜索态强制展开命中子树；平时按折叠状态 */
  const expandedOf = (path: string): boolean => searching || expandedGroups.has(path);

  /** 卡片视图：单张项目卡片（标签最多 5 个：超过 5 台显示前 4 个 + 「+剩余数量」） */
  const projectCardEl = (p: Project): JSX.Element => {
    const hasPath = !!p.path;
    const displayPath = hasPath && p.path ? p.path : `${wsDir}\\${p.name}`;
    const servers = (p.serverIds || [])
      .map((id) => db.servers.find((s) => s.id === id))
      .filter((s): s is Server => !!s);
    const tagLimit = 5;
    const shownServers = servers.length > tagLimit ? servers.slice(0, tagLimit - 1) : servers;
    const hiddenCount = servers.length - shownServers.length;
    return (
      <div
        key={p.id}
        className={`card clickable project-card${draggingId === p.id ? ' dragging' : ''}`}
        draggable data-id={p.id} title={p.name}
        onClick={() => navigate('#/workbench?project=' + p.id)}
        onDragStart={onProjectDragStart} onDragEnd={onProjectDragEnd}
      >
        <div className="pc-head">
          <span className="pc-name ellipsis">{p.name}</span>
          <div className="pc-actions">
            <button className="icon-btn" data-act="edit" data-id={p.id} title="编辑项目"
              onClick={(e) => { e.stopPropagation(); openModal('edit', p.id); }}><Icon name="gear" /></button>
            <button className="icon-btn danger" data-act="delete" data-id={p.id} title="删除项目"
              onClick={(e) => { e.stopPropagation(); void deleteProjectFlow(p.id); }}><Icon name="trash" /></button>
          </div>
        </div>
        <div className="pc-path mono ellipsis" title={displayPath}>
          {displayPath}{!hasPath ? <span className="tag yellow">workspace</span> : null}
        </div>
        <div className="pc-tags">
          {servers.length ? (
            <>
              {shownServers.map((s) => <span className="tag blue" key={s.id}>{s.name}</span>)}
              {hiddenCount > 0 ? <span className="tag">+{hiddenCount}</span> : null}
            </>
          ) : <span className="tag">仅本地</span>}
        </div>
      </div>
    );
  };

  /** 列表视图：项目行 + 可展开的绑定服务器子表（每台服务器 编辑/删除，底部「添加服务器」） */
  const projectRowEl = (p: Project): JSX.Element => {
    const hasPath = !!p.path;
    const displayPath = hasPath && p.path ? p.path : `${wsDir}\\${p.name}`;
    const servers = (p.serverIds || [])
      .map((id) => db.servers.find((s) => s.id === id))
      .filter((s): s is Server => !!s);
    const expanded = expandedRows.has(p.id);
    return (
      <div className="proj-row-wrap" key={p.id}>
        <div
          className={`card proj-row${draggingId === p.id ? ' dragging' : ''}`}
          draggable data-id={p.id}
          onClick={() => toggleRow(p.id)}
          onDragStart={onProjectDragStart} onDragEnd={onProjectDragEnd}
        >
          <button className="icon-btn pr-chevron" data-act="toggle" data-id={p.id} title="展开 / 收起服务器"
            onClick={(e) => { e.stopPropagation(); toggleRow(p.id); }}>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} />
          </button>
          <span className="pr-name ellipsis" title={p.name}>{p.name}</span>
          <span className="pr-path mono ellipsis" title={displayPath}>{displayPath}</span>
          <span className="tag pr-count">{servers.length} 台服务器</span>
          <div className="pr-actions">
            <button className="icon-btn" data-act="open" data-id={p.id} title="打开项目"
              onClick={(e) => { e.stopPropagation(); navigate('#/workbench?project=' + p.id); }}><Icon name="externalLink" /></button>
            <button className="icon-btn" data-act="edit" data-id={p.id} title="编辑项目"
              onClick={(e) => { e.stopPropagation(); openModal('edit', p.id); }}><Icon name="gear" /></button>
            <button className="icon-btn danger" data-act="delete" data-id={p.id} title="删除项目"
              onClick={(e) => { e.stopPropagation(); void deleteProjectFlow(p.id); }}><Icon name="trash" /></button>
          </div>
        </div>
        <div className={`pr-detail${expanded ? '' : ' hidden'}`} data-id={p.id}>
          <div className="pr-servers">
            {servers.length ? servers.map((s) => (
              <div className="pr-server" key={s.id}>
                <span className="ps-name ellipsis" title={s.name}>{s.name}</span>
                <span className="ps-host mono">{s.host}:{s.port}</span>
                <span className="ps-user">{s.username || '-'}</span>
                {s.authType === 'key' ? <span className="tag yellow">密钥</span> : <span className="tag blue">密码</span>}
                <div className="ps-actions">
                  <button className="icon-btn" data-act="srv-edit" data-id={s.id} title="编辑服务器"
                    onClick={(e) => { e.stopPropagation(); openSrvModal(s, null); }}><Icon name="pencil" /></button>
                  <button className="icon-btn danger" data-act="srv-del" data-id={s.id} title="删除服务器"
                    onClick={(e) => { e.stopPropagation(); void deleteServerFlow(s); }}><Icon name="trash" /></button>
                </div>
              </div>
            )) : <div className="pr-empty-servers">暂无绑定服务器</div>}
          </div>
          <button className="btn pr-add-server" data-act="add-server" data-id={p.id}
            onClick={() => openSrvModal(null, p.id)}><Icon name="plus" /> 添加服务器</button>
        </div>
      </div>
    );
  };

  /* 服务器多选列表内容（对应 legacy renderServerList；搜索过滤：#tag 条件 AND +
     名称 / host / username 大小写不敏感子串，共享解析器） */
  const allServers = db.servers || [];
  const parsedSrvQuery = parseSearchQuery(serverQuery);
  const filteredServers = serverQuery.trim()
    ? allServers.filter((s) => matchServer(s, parsedSrvQuery))
    : allServers;
  // 现有全部标签（表单 tag 输入候选）与热门标签（多选列表 / 项目区筛选 chips）
  const allTagOptions = [...new Set(allServers.flatMap((s) => s.tags))].sort((a, b) =>
    a.localeCompare(b, 'zh'));
  const hotServerTags = topTags(allServers);
  const activeQueryTags = parsedQuery.tags;
  const activeServerQueryTags = parsedSrvQuery.tags;
  const serverListContent = !allServers.length
    ? <div className="server-empty">暂无服务器，可在下方新建</div>
    : !filteredServers.length
      ? <div className="server-empty">没有匹配的服务器，试试其他关键词或 #标签</div>
      : (
        <>
          {filteredServers.map((s) => (
            <div
              className={`card clickable server-card${selectedServerIds.includes(s.id) ? ' selected' : ''}`}
              data-id={s.id} key={s.id} onClick={() => toggleServer(s.id)}
            >
              <div className="sc-head">
                <span className="sc-name ellipsis" title={s.name}>{s.name}</span>
                {s.authType === 'key' ? <span className="tag yellow">密钥</span> : <span className="tag blue">密码</span>}
              </div>
              <div className="sc-meta mono">{s.host}:{s.port}</div>
            </div>
          ))}
        </>
      );

  /* ---------- 分类树渲染：递归层级分组（华东/浙江省/杭州市），组标题可折叠 / 重命名 / 删除 ----------
     拖拽投放复用 .proj-group-title[data-folder] 委托（onGroupsDragOver/onGroupsDrop）；
     未分类（folder=''）不进树，单独渲染在最下方。 */
  const renderGroupBody = (groupProjects: Project[]): JSX.Element =>
    viewMode === 'card'
      ? <div className="proj-grid">{groupProjects.map(projectCardEl)}</div>
      : <div className="proj-list">{groupProjects.map(projectRowEl)}</div>;

  const renderFolderNode = (node: FolderNode, depth: number): JSX.Element => {
    const expanded = expandedOf(node.path);
    const total = countProjects(node);
    return (
      <div className="proj-group" key={node.path}>
        <div
          className={`proj-group-title${dropTarget === node.path ? ' drop-target' : ''}`}
          data-folder={node.path}
          style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
          onClick={() => { if (!searching) toggleGroup(node.path); }}
          onDragLeave={onGroupTitleDragLeave}
        >
          <span className="pgt-folder"><Icon name={expanded ? 'folderOpen' : 'folder'} /></span>
          <span className="pgt-name" title={node.path}>{node.name}</span>
          <span className="tag" title={`含子分类共 ${total} 个项目`}>{total}</span>
          <button className="icon-btn" data-act="rename-folder" data-folder={node.path}
            title={`重命名「${node.path}」（子分类一并改名）`}
            onClick={(e) => { e.stopPropagation(); void renameFolderFlow(node.path); }}><Icon name="pencil" /></button>
          <button className="icon-btn danger" data-act="del-folder" data-folder={node.path}
            title={`删除「${node.path}」${total > 0 ? `（递归删除其下 ${total} 个项目）` : ''}`}
            onClick={(e) => { e.stopPropagation(); void deleteFolderFlow(node.path); }}><Icon name="trash" /></button>
        </div>
        {(node.projects.length > 0 || node.children.length > 0) && (
          <div className={`proj-group-body${expanded ? '' : ' hidden'}`}>
            {node.projects.length > 0 ? renderGroupBody(node.projects) : null}
            {node.children.map((c) => renderFolderNode(c, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  /* ---------- 页面骨架（DOM 结构 / 类名 / 文案与 legacy welcome.ts 一致） ---------- */
  return (
    <div className="welcome-page" style={PAGE_ROOT_STYLE}>
      <div className="welcome-content">
      <main>
        <img className="welcome-logo-watermark" src={welcomeLogoUrl} alt="" aria-hidden="true" />

        <div className="page-head">
          <h2>我的项目</h2>
          <span className="tag" id="proj-count">{projects.length} 个项目</span>
        </div>

        {cloudBarVisible ? (
          <div id="cloud-login-bar" className="cloud-login-bar">
            <span>登录公司账号，免配置使用 AI</span>
            <button
              className="btn primary small" id="btn-cloud-login"
              onClick={() => {
                cloudBeginLogin()
                  .then((url) => openUrl(url))
                  .then(() => toast('请在浏览器中完成授权…', 'info'))
                  .catch((err) => toast(`登录发起失败: ${String(err)}`, 'error'));
              }}
            >登录</button>
          </div>
        ) : null}

        <div className="welcome-toolbar">
          <input className="input" id="proj-search" placeholder="搜索项目名 / 路径 / 所属目录 / #标签…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="icon-btn" id="btn-toggle-folders" title={allExpanded ? '全部折叠' : '全部展开'}
            onClick={() => {
              if (allExpanded) {
                setExpandedGroups(new Set());
                persistGroupsExpanded(new Set());
              } else {
                const next = new Set(allFolderKeys);
                setExpandedGroups(next);
                persistGroupsExpanded(next);
              }
            }}>
            <Icon name={allExpanded ? 'folder' : 'folderOpen'} />
          </button>
          <div className="view-switch">
            <button className={`icon-btn${viewMode === 'card' ? ' active' : ''}`} id="btn-view-card" title="卡片视图"
              onClick={() => void switchView('card')}><Icon name="grid" /></button>
            <button className={`icon-btn${viewMode === 'list' ? ' active' : ''}`} id="btn-view-list" title="列表视图"
              onClick={() => void switchView('list')}><Icon name="list" /></button>
          </div>
          <button className="btn" id="btn-import-ssh-tool" disabled={importBusy || !taskProject || !taskAiReady} onClick={() => void importSshToolFlow()}>
            {importBusy ? (<><Icon name="loader" /> 正在创建迁移会话…</>) : (<><Icon name="folder" /> 从其他 SSH 工具导入</>)}
          </button>
          <button className="btn" id="btn-new-folder" onClick={() => void createFolderFlow()}>
            <Icon name="folderPlus" /> 新建分类目录
          </button>
          <button className="btn primary" id="btn-new" onClick={() => openModal('new')}>
            <Icon name="plus" /> 新建项目
          </button>
        </div>

        {/* 热门标签 chips：被引用最多的几个服务器标签，点击切换进/出 #tag 搜索条件 */}
        {hotServerTags.length > 0 && (
          <div className="proj-tag-row">
            {hotServerTags.map((t) => (
              <button
                key={t}
                className={`tag clickable${activeQueryTags.includes(t.toLowerCase()) ? ' active' : ''}`}
                title={`筛选 #${t}`}
                onClick={() => setQuery(toggleTagInQuery(query, t))}
              >
                <Icon name="hash" />
                {t}
              </button>
            ))}
          </div>
        )}

        <div id="proj-groups" onDragOver={onGroupsDragOver} onDrop={onGroupsDrop}>
          {folderTree.map((n) => renderFolderNode(n, 0))}
          {/* 未分类组：不进树，固定渲染在最后（无项目时不渲染空壳） */}
          {(() => {
            const uncategorized = filtered.filter((p) => !(p.folder || ''));
            if (!uncategorized.length) return null;
            const expanded = expandedOf('');
            return (
              <div className="proj-group">
                <div
                  className={`proj-group-title${dropTarget === '' ? ' drop-target' : ''}`}
                  data-folder=""
                  onClick={() => { if (!searching) toggleGroup(''); }}
                  onDragLeave={onGroupTitleDragLeave}
                >
                  <span className="pgt-folder"><Icon name={expanded ? 'folderOpen' : 'folder'} /></span>
                  <span className="pgt-name">未分类</span>
                  <span className="tag">{uncategorized.length}</span>
                </div>
                <div className={`proj-group-body${expanded ? '' : ' hidden'}`}>
                  {renderGroupBody(uncategorized)}
                </div>
              </div>
            );
          })()}
        </div>

        <div className={`empty-state${showEmpty ? '' : ' hidden'}`} id="empty-state">
          <div className="icon"><Icon name="folder" /></div>
          <div>还没有项目，创建一个项目开始使用 AIShell</div>
          <button className="btn primary" id="btn-empty-new" onClick={() => openModal('new')}>新建项目</button>
        </div>
        <div className={`empty-state${showSearchEmpty ? '' : ' hidden'}`} id="search-empty">
          <div className="icon"><Icon name="folder" /></div>
          <div>没有匹配的项目，试试其他关键词</div>
        </div>
      </main>
      <aside className="welcome-ai" aria-label="AI 助手">
        <div className="welcome-ai-head"><Icon name="bot" /><span>AI 助手</span><span className="tag">本地任务</span></div>
        <div className="welcome-ai-body">
          {taskProject ? (
            <AiPanel
              project={taskProject}
              workbenchIntegration={false}
              fixedWorkareaPath={taskProject.path ?? undefined}
              lockedMode="agent"
              onReady={(controller) => { taskAiRef.current = controller; setTaskAiReady(true); }}
            />
          ) : (
            <div className="welcome-ai-empty">
              <Icon name="alert" />
              <strong>AI 助手暂不可用</strong>
              <span>{taskError ?? '正在初始化任务工作区…'}</span>
              <button className="btn" onClick={() => navigate('#/settings')}>前往设置</button>
            </div>
          )}
        </div>
      </aside>
      </div>

      {/* 新建 / 编辑项目模态框（常驻挂载，.open 控制显隐，同 legacy 骨架） */}
      <div className={`modal-mask${modalOpen ? ' open' : ''}`} id="proj-modal"
        onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
        <div className="modal">
          <div className="modal-head">
            <h3 id="modal-title">{editingId ? '编辑项目' : '新建项目'}</h3>
            <button className="icon-btn" id="modal-close" title="关闭" onClick={closeModal}><Icon name="x" /></button>
          </div>
          <div className="modal-body">
            <div className="field">
              <label>项目名称<span className="req">*</span></label>
              <input ref={fNameRef} className={`input${nameError ? ' invalid' : ''}`} id="f-name"
                placeholder="例如：数据中台 ETL"
                onInput={() => setNameError(false)} onKeyDown={onProjectFieldEnter} />
              <div className={`error${nameError ? '' : ' hidden'}`} id="f-name-err">请输入项目名称</div>
            </div>
            <div className="field">
              <label>项目路径</label>
              <div className="path-row">
                <input ref={fPathRef} className="input" id="f-path"
                  placeholder="例如：D:\projects\my-app" onKeyDown={onProjectFieldEnter} />
                <button className="btn" id="btn-browse" onClick={() => void onBrowse()}>浏览…</button>
              </div>
              <div className="hint">选择目录后将在其下创建 .aishell 工作目录；留空则在全局 workspace 目录中新建项目目录。</div>
            </div>
            <div className="field">
              <label>所属目录</label>
              <input ref={fFolderRef} className="input" id="f-folder"
                placeholder="可输入新分类或从下拉选择，例如：生产环境/Web" onKeyDown={onProjectFieldEnter} />
              <div className="hint">以 / 分隔的目录路径，可输入新分类或从下拉选择；留空表示未分类</div>
            </div>
            <div className="field">
              <label>绑定远程服务器（可多选）</label>
              <div className="server-search-row">
                <input className="input" id="server-search" placeholder="搜索服务器…（#标签 筛选）"
                  value={serverQuery} onChange={(e) => setServerQuery(e.target.value)} />
              </div>
              {/* 热门标签 chips：点击切换进/出 #tag 筛选条件 */}
              {hotServerTags.length > 0 && (
                <div className="proj-tag-row in-modal">
                  {hotServerTags.map((t) => (
                    <button
                      key={t}
                      className={`tag clickable${activeServerQueryTags.includes(t.toLowerCase()) ? ' active' : ''}`}
                      title={`筛选 #${t}`}
                      onClick={() => setServerQuery(toggleTagInQuery(serverQuery, t))}
                    >
                      <Icon name="hash" />
                      {t}
                    </button>
                  ))}
                </div>
              )}
              <div className="server-list" id="server-list">{serverListContent}</div>
              <div className={`server-add${miniExpanded ? ' hidden' : ''}`} id="server-add-toggle" onClick={expandMini}>
                <Icon name="plus" /> 新建服务器连接
              </div>
              <div className={`server-mini${miniExpanded ? '' : ' hidden'}`} id="server-mini">
                {/* 服务器表单字段（双列紧凑布局）由 ServerForm 渲染，与侧栏编辑表单同源 */}
                <div id="mini-form"><ServerForm ref={miniFormRef} compact credentials={db.credentials} allTags={allTagOptions} /></div>
                <div className={`error${miniErr === null ? ' hidden' : ''}`} id="mini-err">{miniErr}</div>
                <div className="mini-actions">
                  <button className="btn" id="mini-cancel"
                    onClick={() => { collapseMini(); resetMini(); }}>收起</button>
                  <button className="btn primary" id="mini-save" onClick={() => void saveMiniServer()}>保存</button>
                </div>
              </div>
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn" id="btn-cancel" onClick={closeModal}>取消</button>
            <button className="btn primary" id="btn-save" onClick={() => void saveProject()}>保存</button>
          </div>
        </div>
      </div>

      {/* 列表视图：添加 / 编辑绑定服务器模态框（单页弹层，字段由 ServerForm 渲染） */}
      <div className={`modal-mask${srvHidden ? ' hidden' : ''}${srvOpen ? ' open' : ''}`} id="srv-modal"
        onMouseDown={(e) => { if (e.target === e.currentTarget) closeSrvModal(); }}>
        <div className="modal">
          <div className="modal-head">
            <h3 id="srv-modal-title">{srvEditingId ? '编辑服务器' : '新建服务器'}</h3>
            <button className="icon-btn" id="srv-modal-close" title="关闭" onClick={closeSrvModal}><Icon name="x" /></button>
          </div>
          <div className="modal-body">
            <div id="srv-form"><ServerForm ref={srvFormRef} credentials={db.credentials} allTags={allTagOptions} /></div>
            <div className={`error${srvErr === null ? ' hidden' : ''}`} id="srv-err">{srvErr}</div>
          </div>
          <div className="modal-foot">
            <button className="btn" id="srv-cancel" onClick={closeSrvModal}>取消</button>
            <button className="btn primary" id="srv-save" onClick={() => void saveSrvModal()}>保存</button>
          </div>
        </div>
      </div>
    </div>
  );
}
