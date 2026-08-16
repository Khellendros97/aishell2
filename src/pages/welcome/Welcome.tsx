/**
 * 欢迎页 —— AIShell 项目唯一维度主页（React 迁移）。
 * 对照 legacy/pages/welcome.ts（逐条移植）与 .proto/welcome.html / .proto/welcome.js（交互规格）；
 * 布局 / DOM 结构 / CSS 类名 / 交互 / 文案与 legacy 完全一致，顶栏由 App.tsx 提供，本组件不渲染 Topbar。
 *
 * 后端接口点（均见 src/api.ts）：get_state / upsert_project / delete_project / upsert_server /
 * delete_server / create_project_folder / rename_project_folder / delete_project_folder /
 * set_ui_expanded（welcome:projectGroups 分组展开状态）/ save_settings（projectView 视图持久化）/
 * ensure_project_dirs（新建项目先拿最终路径再落盘）/ import_xshell_sessions / import_xshell_from_dir；
 * 浏览按钮走 @tauri-apps/plugin-dialog 的 openDialog。
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
import type { AppState, CloudStatus, Project, Server, XshellImportResult } from '../../types';
import {
  cloudBeginLogin, cloudStatus, createProjectFolder, deleteProject, deleteProjectFolder, deleteServer,
  ensureProjectDirs, getState, importXshellFromDir, importXshellSessions, onCloudChanged, openDialog,
  renameProjectFolder, saveSettings, setUiExpanded, upsertProject, upsertServer,
} from '../../api';
import { openUrl } from '@tauri-apps/plugin-opener';
import { attachCombo, confirmDialog, promptDialog, toast, uid } from '../../ui';
import { Icon } from '../../shared/Icon';
import { navigate } from '../../router';
import { ServerForm, type ServerFormHandle } from '../settings/ServerForm';
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
  },
  servers: [], projects: [], sessions: {}, projectFolders: [], commandFolders: [], uiExpanded: {},
  sftpHistory: {}, sftpFavorites: {}, dbConnections: {}, mcp: { port: 8945 }, mcpDevices: {},
  seededSkillWorkspaces: [],
};

/**
 * 页面根节点补 flex 属性：App.tsx 已提供 .page-root 弹性列（等价 legacy 的
 * `.page-root.welcome-page` 同元素结构），本根节点作为其中一列占满剩余高度，
 * 使 .welcome-page main { flex: 1 } 的内部滚动布局与 legacy 一致。
 */
const PAGE_ROOT_STYLE: CSSProperties = { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 };

/** 搜索匹配：项目名 / 路径 / 所属目录 大小写不敏感；空串显示全部 */
function matchProject(p: Project, q: string): boolean {
  if (!q) return true;
  return [p.name, p.path ?? '', p.folder ?? ''].some((v) => v.toLowerCase().includes(q));
}

/** 分组计算（与 legacy renderProjects 的分组/排序/空态判定逐条对应） */
function computeGroups(db: AppState, q: string): {
  projects: Project[]; filtered: Project[]; folderSet: Set<string>;
  groups: Map<string, Project[]>; keys: string[];
} {
  const projects = db.projects || [];
  const filtered = q ? projects.filter((p) => matchProject(p, q)) : projects;

  // 组来源：projectFolders ∪ 各项目 folder 派生值（并集，去重），空目录（0 个项目）也渲染；
  // 搜索中只展示命中项目的分组（空目录无意义，保持搜索空态语义）。
  const folderSet = new Set<string>(db.projectFolders ?? []);
  projects.forEach((p) => folderSet.add(p.folder || ''));

  const groups = new Map<string, Project[]>();
  if (q) {
    filtered.forEach((p) => {
      const key = p.folder || '';
      const arr = groups.get(key);
      if (arr) arr.push(p);
      else groups.set(key, [p]);
    });
  } else {
    folderSet.forEach((key) => groups.set(key, []));
    filtered.forEach((p) => groups.get(p.folder || '')!.push(p));
  }

  // 未分类（空串）组排最后
  const keys = groups.size
    ? Array.from(groups.keys()).sort((a, b) => {
        if (!a) return 1;
        if (!b) return -1;
        return a.localeCompare(b, 'zh');
      })
    : [];
  return { projects, filtered, folderSet, groups, keys };
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
  /** Xshell 导入进行态（按钮禁用 + 文案替换） */
  const [importBusy, setImportBusy] = useState(false);
  /** Xshell 导入后 needsAttention>0 时展示持久提示条；null = 隐藏 */
  const [importNote, setImportNote] = useState<number | null>(null);

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
    const next = new Set(expandedGroups);
    next.delete(folder); // 目录已改名，旧折叠状态不再保留
    setExpandedGroups(next);
    persistGroupsExpanded(next);
    toast(`分类目录已重命名为「${name}」`, 'success');
  }

  /** 删除空分类目录：确认后调后端（失败显示后端中文错误），仅空组标题行有删除按钮 */
  async function deleteFolderFlow(folder: string): Promise<void> {
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
    const next = new Set(expandedGroups);
    next.delete(folder); // 已删除目录不再保留折叠状态
    setExpandedGroups(next);
    persistGroupsExpanded(next);
    toast(`分类目录「${folder}」已删除`, 'success');
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
      toast('项目已创建', 'success');
    }
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
    try {
      await upsertServer(srv, password);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    setDb((prev) => ({ ...prev, servers: [...prev.servers, srv] }));
    setSelectedServerIds((prev) => [...prev, srv.id]);
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
    try {
      await upsertServer(srv, password);
    } catch (e) {
      toast(String(e), 'error');
      return;
    }

    if (editing) {
      setDb((prev) => ({
        ...prev,
        servers: prev.servers.map((s) => (s.id === editing.id ? { ...s, ...srv } : s)),
      }));
      toast('服务器已更新', 'success');
    } else {
      setDb((prev) => ({ ...prev, servers: [...prev.servers, srv] }));
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

  /* ---------- 从 Xshell 一键导入（自动扫描失败 → 目录选择器手动指定） ---------- */
  async function importXshellFlow() {
    // 导入结果落库并刷新（自动扫描与手动重试共用）
    const applyResult = async (r: XshellImportResult) => {
      setDb(await getState());
      const projectNote = r.projectsCreated > 0 ? `，新建 ${r.projectsCreated} 个项目` : '';
      toast(`Xshell 导入完成：新增 ${r.imported}，更新 ${r.updated}，未变化 ${r.unchanged}，跳过 ${r.skipped}${projectNote}`, 'success');
      // needsAttention>0 时用页面内持久提示（toast 仅 2.2s 读不完长文案）；=0 时隐藏
      setImportNote(r.needsAttention > 0 ? r.needsAttention : null);
    };
    setImportBusy(true);
    try {
      await applyResult(await importXshellSessions());
    } catch (err) {
      // 自动扫描失败（通常 Xshell 装在非默认位置）→ 弹目录选择器让用户手动指定会话目录重试
      const dir = await openDialog({
        directory: true,
        title: '选择 Xshell 会话目录',
      });
      if (dir) {
        setImportBusy(true);
        try {
          await applyResult(await importXshellFromDir(dir));
        } catch (err2) {
          toast(String(err2), 'error');
        }
      } else {
        toast(String(err), 'error');
      }
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

  /* ---------- 渲染计算（对应 legacy renderProjects / renderServerList / syncViewBtns / syncToggleFoldersBtn） ---------- */
  const q = query.trim().toLowerCase();
  const { projects, filtered, folderSet, groups, keys } = computeGroups(db, q);
  // 完全没有项目且没有任何目录 → 引导空态；有项目但搜索无命中 → 搜索空态
  // （loaded 前与 legacy 骨架一致：空态保持 hidden，等首次 getState 后再展示）
  const showEmpty = loaded && projects.length === 0 && folderSet.size === 0;
  const showSearchEmpty = loaded && projects.length > 0 && filtered.length === 0;
  // 「全部展开 / 全部折叠」单按钮：按当前状态切换，图标 = 目标动作
  const allExpanded = keys.length > 0 && keys.every((k) => expandedGroups.has(k));
  const wsDir = db.settings.workspaceDir || '';

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

  /* 服务器多选列表内容（对应 legacy renderServerList；搜索过滤：名称 / host / username 大小写不敏感） */
  const allServers = db.servers || [];
  const serverQ = serverQuery.trim().toLowerCase();
  const filteredServers = serverQ
    ? allServers.filter((s) => [s.name, s.host, s.username].some((v) => v.toLowerCase().includes(serverQ)))
    : allServers;
  const serverListContent = !allServers.length
    ? <div className="server-empty">暂无服务器，可在下方新建</div>
    : !filteredServers.length
      ? <div className="server-empty">没有匹配的服务器，试试其他关键词</div>
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

  /* ---------- 页面骨架（DOM 结构 / 类名 / 文案与 legacy welcome.ts 一致） ---------- */
  return (
    <div className="welcome-page" style={PAGE_ROOT_STYLE}>
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
          <input className="input" id="proj-search" placeholder="搜索项目名 / 路径 / 所属目录…"
            value={query} onChange={(e) => setQuery(e.target.value)} />
          <button className="icon-btn" id="btn-toggle-folders" title={allExpanded ? '全部折叠' : '全部展开'}
            onClick={() => {
              if (allExpanded) {
                setExpandedGroups(new Set());
                persistGroupsExpanded(new Set());
              } else {
                const next = new Set(keys);
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
          <button className="btn" id="btn-import-xshell" disabled={importBusy} onClick={() => void importXshellFlow()}>
            {importBusy ? (<><Icon name="loader" /> 正在扫描 Xshell 会话…</>) : (<><Icon name="folder" /> 从 Xshell 导入</>)}
          </button>
          <button className="btn" id="btn-new-folder" onClick={() => void createFolderFlow()}>
            <Icon name="folderPlus" /> 新建分类目录
          </button>
          <button className="btn primary" id="btn-new" onClick={() => openModal('new')}>
            <Icon name="plus" /> 新建项目
          </button>
        </div>

        <div className={`import-note${importNote === null ? ' hidden' : ''}`} role="status">
          {importNote !== null && (
            <><Icon name="alert" /> 已导入，但有 {importNote} 个会话需处理：Xshell 密码不会迁移；NSSSH 专用密钥请在 Xshell 的「工具 → 用户密钥管理器」中导出为无密码短语的 OpenSSH 私钥，再编辑服务器替换密钥路径</>
          )}
        </div>

        <div id="proj-groups" onDragOver={onGroupsDragOver} onDrop={onGroupsDrop}>
          {keys.map((folderKey) => {
            const groupProjects = groups.get(folderKey)!;
            const expanded = expandedGroups.has(folderKey);
            const groupBody = viewMode === 'card'
              ? <div className="proj-grid">{groupProjects.map(projectCardEl)}</div>
              : <div className="proj-list">{groupProjects.map(projectRowEl)}</div>;
            return (
              <div className="proj-group" key={folderKey}>
                <div
                  className={`proj-group-title${dropTarget === folderKey ? ' drop-target' : ''}`}
                  data-folder={folderKey}
                  onClick={() => toggleGroup(folderKey)}
                  onDragLeave={onGroupTitleDragLeave}
                >
                  <span className="pgt-folder"><Icon name={expanded ? 'folderOpen' : 'folder'} /></span>
                  <span className="pgt-name" title={folderKey || '未分类'}>{folderKey || '未分类'}</span>
                  <span className="tag">{groupProjects.length}</span>
                  {folderKey ? (
                    <button className="icon-btn" data-act="rename-folder" data-folder={folderKey}
                      title={`重命名「${folderKey}」`}
                      onClick={(e) => { e.stopPropagation(); void renameFolderFlow(folderKey); }}><Icon name="pencil" /></button>
                  ) : null}
                  {folderKey && groupProjects.length === 0 ? (
                    <button className="icon-btn danger" data-act="del-folder" data-folder={folderKey}
                      title={`删除「${folderKey}」`}
                      onClick={(e) => { e.stopPropagation(); void deleteFolderFlow(folderKey); }}><Icon name="trash" /></button>
                  ) : null}
                </div>
                <div className={`proj-group-body${expanded ? '' : ' hidden'}`}>{groupBody}</div>
              </div>
            );
          })}
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
                <input className="input" id="server-search" placeholder="搜索服务器…"
                  value={serverQuery} onChange={(e) => setServerQuery(e.target.value)} />
              </div>
              <div className="server-list" id="server-list">{serverListContent}</div>
              <div className={`server-add${miniExpanded ? ' hidden' : ''}`} id="server-add-toggle" onClick={expandMini}>
                <Icon name="plus" /> 新建服务器连接
              </div>
              <div className={`server-mini${miniExpanded ? '' : ' hidden'}`} id="server-mini">
                {/* 服务器表单字段（双列紧凑布局）由 ServerForm 渲染，与侧栏编辑表单同源 */}
                <div id="mini-form"><ServerForm ref={miniFormRef} compact /></div>
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
            <div id="srv-form"><ServerForm ref={srvFormRef} /></div>
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
