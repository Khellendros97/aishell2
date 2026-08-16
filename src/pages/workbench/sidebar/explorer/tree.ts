/**
 * 文件资源管理器:树模型与后端数据层(React 迁移拆分子模块,聚合入口 ExplorerPanel.tsx)。
 * 对照 legacy/pages/workbench/sidebar/explorer.ts 的模型/加载/持久化段落逐条翻译:
 * - 树节点(TreeNode)以 path 唯一标识,children=null 表示尚未加载;刷新按 path reconcile
 *   复用未变节点对象(AGENTS.md 硬约束 8:无差别重建 children 会让行点击写进孤儿节点);
 * - 展开状态 300ms 防抖落盘 setUiExpanded('explorer:<projectId>'),每项目每会话只播种一次,
 *   播种 await 期间用户手动改动过的路径不覆盖(seedGuard 语义同 legacy);
 * - 全局加载序号 loadSeq:异步结果只接受最新一次(防乱序渲染),卸载/重建时递增作废在途加载;
 * - 渲染触发经 setRenderHook 注入(实际 DOM 渲染在 explorer.ts,避免本模块反向依赖)。
 * 接口点:src/api.ts 的 fs_list / get_state / set_ui_expanded(fs_move / fs_copy 等操作在
 * explorer.ts 调用,不在此模块);项目事实源在 Rust 端 aishell.json(store),前端只读 useWorkbench().project。
 */
import { fsList, getState, setUiExpanded } from '../../../../api';
import type { FsEntry } from '../../../../types';
import { toast } from '../../../../ui';
import { useWorkbench } from '../../../../stores/workbench';

/** 树节点:path 为正斜杠规范化后的绝对路径 */
export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  parent: TreeNode | null;
  children: TreeNode[] | null; // null = 尚未加载
  loading: boolean;
}

export const joinPath = (parent: string, name: string): string => `${parent}/${name}`;
export const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

let rootNode: TreeNode | null = null;
const expanded = new Set<string>();
/** 本次会话已从后端恢复过展开状态的项目 id(每项目只播种一次,避免重复覆盖用户操作) */
const seededProjects = new Set<string>();
/** 播种 await 期间用户手动改动过的路径(种子跳过,不覆盖用户在等待期间的点击) */
let seedGuard: Set<string> | null = null;
/** 展开状态防抖落盘定时器(300ms 合并连续 toggle) */
let persistTimer: number | null = null;
/** 全局加载序号:异步结果只接受最新一次(防止乱序渲染) */
let loadSeq = 0;
/** DOM 渲染入口(mountExplorer 注入) */
let renderHook: (() => void) | null = null;

/** 注册 DOM 渲染入口(mountExplorer 挂载时注入;卸载传 null) */
export function setRenderHook(fn: (() => void) | null): void {
  renderHook = fn;
}

/** 树内容/状态变化后请求重绘(未挂载时由 render 内部兜底) */
function notifyRender(): void {
  renderHook?.();
}

/** 递增全局加载序号:作废所有在途 fsList/loadDir/refreshAll(卸载/重建时用,旧 token 结果不再渲染) */
export function invalidateLoads(): void {
  loadSeq++;
}

/* ---------- 展开状态持久化(落盘 uiExpanded['explorer:<projectId>'],key 语义见 types.ts) ---------- */
/**
 * 300ms 防抖把当前展开集合写入后端;key 与快照都在触发时刻取,切项目不会串写。
 * 尚未播种完的项目不落盘(getRoot 重建/首帧的临时状态会覆盖其历史展开状态):
 * 未播种过或播种 await 仍在途(seedGuard 非空)都跳过;失败仅 console.warn 不打扰用户。
 */
function persistExpanded(): void {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    const pid = useWorkbench.getState().project?.id;
    if (!pid || !seededProjects.has(pid) || seedGuard !== null) return;
    setUiExpanded(`explorer:${pid}`, [...expanded]).catch((err) =>
      console.warn('保存目录展开状态失败:', err));
  }, 300);
}

/** 展开目录(用户显式操作或操作后保证可见);改动即防抖落盘 */
export function expand(path: string): void {
  expanded.add(path);
  seedGuard?.add(path);
  persistExpanded();
}

/** 折叠目录(用户显式操作 / 加载失败清理);改动即防抖落盘 */
export function collapse(path: string): void {
  expanded.delete(path);
  seedGuard?.add(path);
  persistExpanded();
}

/** 目录当前是否展开(渲染层查询;集合唯一维护点在本模块) */
export function isExpanded(path: string): boolean {
  return expanded.has(path);
}

/** 清空展开集合(项目切换重建根时用);未播种过的项目不落盘 */
export function clearExpanded(): void {
  expanded.clear();
  persistExpanded();
}

/**
 * 恢复当前项目上次会话的展开状态;每项目每会话仅播种一次。
 * 播种 await 期间用户改动过的路径不覆盖(seedGuard);await 期间切了项目则整次作废。
 */
export async function seedExpanded(): Promise<void> {
  const pid = useWorkbench.getState().project?.id;
  if (!pid || seededProjects.has(pid)) return;
  seededProjects.add(pid);
  const key = `explorer:${pid}`;
  const guard = new Set<string>();
  seedGuard = guard;
  let saved: string[] = [];
  try {
    saved = (await getState()).uiExpanded?.[key] ?? [];
  } catch (err) {
    console.warn('恢复目录展开状态失败:', err);
  }
  seedGuard = null;
  if (useWorkbench.getState().project?.id !== pid) return; // await 期间切了项目,本次作废
  let changed = false;
  for (const p of saved) {
    if (guard.has(p) || expanded.has(p)) continue;
    expanded.add(p);
    changed = true;
  }
  // await 期间用户动过展开状态:播种完成后补一次合并落盘(期间被 persist 门禁拦下的改动)
  if (guard.size > 0) persistExpanded();
  if (changed) notifyRender();
}

/* ---------- 根节点与加载 ---------- */
export function getRoot(): TreeNode | null {
  const raw = useWorkbench.getState().project?.path;
  if (!raw) return null;
  const path = normPath(raw);
  if (rootNode && rootNode.path === path) return rootNode;
  rootNode = { name: path, path, isDir: true, parent: null, children: null, loading: false };
  clearExpanded();
  expand(path);
  return rootNode;
}

/** 当前根节点路径(project-changed 对比用;null = 尚未建立) */
export function getRootPath(): string | null {
  return rootNode?.path ?? null;
}

/** 清空根节点(项目路径变化时调用;展开集合由调用方 clearExpanded) */
export function resetRoot(): void {
  rootNode = null;
}

function makeChild(dir: TreeNode, e: FsEntry): TreeNode {
  return {
    name: e.name,
    path: joinPath(dir.path, e.name),
    isDir: e.isDir,
    parent: dir,
    children: null,
    loading: false,
  };
}

/** 首次加载目录(children 未加载 / loading 在途时直接返回) */
export async function loadDir(node: TreeNode): Promise<void> {
  if (node.children || node.loading) return;
  node.loading = true;
  const token = ++loadSeq;
  try {
    const entries = await fsList(node.path);
    if (token !== loadSeq) return;
    node.children = entries.map((e) => makeChild(node, e));
  } catch (err) {
    if (token !== loadSeq) return;
    toast(String(err), 'error');
    collapse(node.path);
  } finally {
    node.loading = false;
    if (token === loadSeq) notifyRender();
  }
}

/** 重新读取已展开目录(新建/删除/下载后调用) */
export async function refreshDir(node: TreeNode): Promise<void> {
  const token = ++loadSeq;
  try {
    const entries = await fsList(node.path);
    if (token !== loadSeq) return;
    node.children = entries.map((e) => makeChild(node, e));
  } catch (err) {
    if (token !== loadSeq) return;
    toast(String(err), 'error');
  } finally {
    if (token === loadSeq) notifyRender();
  }
}

/**
 * 项目数据变化:路径变了重建根,否则刷新所有已加载目录。
 * 关键不变式:未变化的节点必须复用原对象——子树加载状态(children/loading)与
 * DOM 行闭包都挂在节点对象上,无差别替换会让行点击失效(点击写进孤儿节点)。
 */
function reconcile(dir: TreeNode, entries: FsEntry[]): boolean {
  const old = dir.children ?? [];
  const byPath = new Map(old.map((c) => [c.path, c]));
  let changed = old.length !== entries.length;
  const next: TreeNode[] = [];
  for (const e of entries) {
    const path = joinPath(dir.path, e.name);
    const prev = byPath.get(path);
    if (prev && prev.isDir === e.isDir) { next.push(prev); continue; }
    changed = true;
    next.push(makeChild(dir, e));
  }
  dir.children = next;
  return changed;
}

/** 重读全部已加载目录(定时轮询 / 移动粘贴后刷新用) */
export async function refreshAll(): Promise<void> {
  const root = getRoot();
  if (!root) return;
  const dirs: TreeNode[] = [];
  const walk = (n: TreeNode): void => {
    if (n.isDir && n.children) {
      dirs.push(n);
      n.children.forEach(walk);
    }
  };
  walk(root);
  if (!dirs.length) return;
  const token = ++loadSeq;
  let changed = false;
  try {
    const results = await Promise.all(
      dirs.map((d) => fsList(d.path).then((list) => ({ d, list })).catch(() => null)),
    );
    if (token !== loadSeq) return;
    results.forEach((r) => {
      if (r && reconcile(r.d, r.list)) changed = true;
    });
  } finally {
    // 仅内容变化才重绘:定时轮询下避免无效 DOM 重建与 hover 态丢失
    if (changed && token === loadSeq) notifyRender();
  }
}

/* ---------- 编辑器占用保护 ---------- */
/** 正在编辑器打开的文件路径(editor tab id = editor:<path>) */
export function editingPaths(): string[] {
  return useWorkbench.getState().tabs
    .filter((t) => t.type === 'editor')
    .map((t) => t.id.slice('editor:'.length));
}

/** path 或其子孙正被编辑时提示并返回 true——移动/重命名后旧标签写盘会在旧路径重建文件,抵消操作 */
export function blockedByEditor(path: string): boolean {
  const hit = editingPaths().some((p) => p === path || p.startsWith(`${path}/`));
  if (hit) toast('该文件正在编辑器中打开,请先关闭对应标签页', 'error');
  return hit;
}

/** 相对项目根的路径(根自身返回空串时不应出现——根行菜单不提供此项) */
export function relativePath(path: string): string {
  const root = getRoot();
  if (root && path.startsWith(`${root.path}/`)) return path.slice(root.path.length + 1);
  return path;
}

/* ---------- 快捷键定位 ---------- */
/** 按 path 在已加载子树中查找节点(根先行,DFS) */
export function findNode(path: string): TreeNode | null {
  const root = getRoot();
  if (!root) return null;
  if (root.path === path) return root;
  const stack: TreeNode[] = [root];
  while (stack.length) {
    const n = stack.pop()!;
    for (const c of n.children ?? []) {
      if (c.path === path) return c;
      if (c.isDir) stack.push(c);
    }
  }
  return null;
}

/** 行缩进深度(根 = 0) */
export function depthOf(n: TreeNode): number {
  let d = 0;
  while (n.parent) { d++; n = n.parent; }
  return d;
}
