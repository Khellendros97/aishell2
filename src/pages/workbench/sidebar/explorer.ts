/**
 * 文件资源管理器面板 —— 移植自 .proto/workbench-sidebar.js 的「面板 1」。
 * 差异：真实 fs_list 懒加载（目录首次展开时读取，而非 mock 全量树）；
 * 删除/新建/远端拖入都走后端命令并 toast 真实错误；样式类改 wbs-explorer- 前缀。
 * 契约：mountExplorerPanel(container) 由 workbench.ts 侧栏框架挂载（container = #sidebar-content，
 * 面板不碰 #sidebar-head）；explorerHead 描述符由框架渲染标题与 actions 区。
 */
import { bus, getTabs, openTab, Workbench } from '../core';
import { confirmDialog, copyText, showContextMenu, toast, type CtxItem } from '../../../ui';
import { fsCopy, fsCreate, fsDelete, fsImport, fsList, fsMove, fsReveal, sftpDownload } from '../../../api';
import type { FsEntry } from '../../../types';
import { icon as iconSvg } from '../../../icons';
import './explorer.css';

/** 侧栏框架渲染 #sidebar-head 用（标题 + actions 按钮） */
export const explorerHead = {
  title: '文件资源管理器',
  renderActions(el: HTMLElement): void {
    const newFile = document.createElement('button');
    newFile.className = 'icon-btn';
    newFile.title = '新建文件';
    newFile.innerHTML = iconSvg('filePlus');
    newFile.onclick = () => startInlineInput(false, null, null);
    const newDir = document.createElement('button');
    newDir.className = 'icon-btn';
    newDir.title = '新建目录';
    newDir.innerHTML = iconSvg('folderPlus');
    newDir.onclick = () => startInlineInput(true, null, null);
    el.append(newFile, newDir);
  },
};

/* ---------- 文件类型角标（照抄原型 FILE_STYLES） ---------- */
const FILE_STYLES: Record<string, { label: string; color: string }> = {
  js: { label: 'js', color: '#e5c07b' },
  ts: { label: 'ts', color: '#4f8ef7' },
  py: { label: 'py', color: '#4ec98a' },
  css: { label: 'css', color: '#4f8ef7' },
  html: { label: 'html', color: '#e5626a' },
  json: { label: '{}', color: '#e5c07b' },
  md: { label: 'md', color: '#b687e8' },
  sh: { label: 'sh', color: '#4ec98a' },
  gitignore: { label: 'git', color: '#6b7180' },
};

interface TreeNode {
  name: string;
  path: string; // 正斜杠规范化后的绝对路径
  isDir: boolean;
  parent: TreeNode | null;
  children: TreeNode[] | null; // null = 尚未加载
  loading: boolean;
}

let container: HTMLElement | null = null;
let mounted = false;
let rootNode: TreeNode | null = null;
const expanded = new Set<string>();
/** 全局加载序号：异步结果只接受最新一次（防止乱序渲染） */
let loadSeq = 0;
/** 拖拽中的本地节点（dragover 据此决定 move/copy 光标；守卫在 moveNode 内） */
let draggingNode: TreeNode | null = null;
/** 复制/剪切剪贴板：剪切粘贴成功后清空，复制可多次粘贴 */
let fsClipboard: { path: string; name: string; isDir: boolean; mode: 'copy' | 'cut' } | null = null;

const joinPath = (parent: string, name: string): string => `${parent}/${name}`;
const normPath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');

function getRoot(): TreeNode | null {
  const raw = Workbench.state.project?.path;
  if (!raw) return null;
  const path = normPath(raw);
  if (rootNode && rootNode.path === path) return rootNode;
  rootNode = { name: path, path, isDir: true, parent: null, children: null, loading: false };
  expanded.clear();
  expanded.add(path);
  return rootNode;
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

async function loadDir(node: TreeNode): Promise<void> {
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
    expanded.delete(node.path);
  } finally {
    node.loading = false;
    if (token === loadSeq) render();
  }
}

/** 重新读取已展开目录（新建/删除/下载后调用） */
async function refreshDir(node: TreeNode): Promise<void> {
  const token = ++loadSeq;
  try {
    const entries = await fsList(node.path);
    if (token !== loadSeq) return;
    node.children = entries.map((e) => makeChild(node, e));
  } catch (err) {
    if (token !== loadSeq) return;
    toast(String(err), 'error');
  } finally {
    if (token === loadSeq) render();
  }
}

/** 项目数据变化：路径变了重建根，否则刷新所有已加载目录。
 *  关键不变式：未变化的节点必须复用原对象——子树加载状态（children/loading）与
 *  DOM 行闭包都挂在节点对象上，无差别替换会让行点击失效（点击写进孤儿节点）。 */
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

async function refreshAll(): Promise<void> {
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
    // 仅内容变化才重绘：定时轮询下避免无效 DOM 重建与 hover 态丢失
    if (changed && token === loadSeq) render();
  }
}

/* ---------- 行渲染 ---------- */
function buildRow(node: TreeNode, depth: number, isRoot: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'wbs-explorer-row';
  row.style.paddingLeft = `${6 + depth * 14}px`;
  row.title = node.path;

  const arrow = document.createElement('span');
  arrow.className = 'wbs-explorer-arrow';
  if (node.isDir) arrow.textContent = expanded.has(node.path) ? '▾' : '▸';
  row.appendChild(arrow);

  const icon = document.createElement('span');
  icon.className = 'wbs-explorer-file-tag';
  if (node.isDir) {
    icon.innerHTML = iconSvg('folder');
  } else {
    const ext = (node.name.split('.').pop() || '').toLowerCase();
    const st = FILE_STYLES[ext];
    if (st) {
      icon.textContent = st.label;
      icon.style.fontSize = '9.5px';
      icon.style.fontWeight = '700';
      icon.style.color = st.color;
    } else {
      icon.innerHTML = iconSvg('file');
    }
  }
  row.appendChild(icon);

  const name = document.createElement('span');
  name.className = 'wbs-explorer-name';
  name.textContent = node.name;
  row.appendChild(name);

  if (!isRoot) {
    const del = document.createElement('button');
    del.className = 'icon-btn danger wbs-explorer-del';
    del.title = '删除';
    del.innerHTML = iconSvg('trash');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteNode(node);
    });
    row.appendChild(del);

    /* 拖拽：local 源（DND 契约）——树内拖到目录=移动，供远端 SFTP 面板接收=上传 */
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData(Workbench.DND_MIME, JSON.stringify({
        source: 'local', path: node.path, name: node.name, isDir: node.isDir,
      }));
      e.dataTransfer.effectAllowed = 'copyMove';
      draggingNode = node;
    });
    row.addEventListener('dragend', () => { draggingNode = null; });

    /* 右键菜单 */
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showNodeMenu(e.clientX, e.clientY, node, row);
    });
  } else {
    /* 根行右键：仅粘贴 / 系统资源管理器打开 */
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showRootMenu(e.clientX, e.clientY, node);
    });
  }

  /* 剪切中的行半透明（剪切粘贴成功前） */
  if (fsClipboard?.mode === 'cut' && fsClipboard.path === node.path) row.classList.add('wbs-cut');

  /* 目录行是 remote 拖入的下载目标，也是 OS 文件拖入的上传目标 */
  if (node.isDir) {
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types);
      if (!types.includes(Workbench.DND_MIME) && !types.includes('Files')) return;
      e.preventDefault();
      /* 本地树内拖拽=移动；远端 / OS 文件=复制 */
      e.dataTransfer.dropEffect = draggingNode ? 'move' : 'copy';
      row.classList.add('wbs-explorer-drop');
    });
    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget as Node)) row.classList.remove('wbs-explorer-drop');
    });
    row.addEventListener('drop', (e) => {
      row.classList.remove('wbs-explorer-drop');
      if (!e.dataTransfer) return;
      const raw = (() => { try { return e.dataTransfer!.getData(Workbench.DND_MIME); } catch { return ''; } })();
      if (raw) {
        e.preventDefault();
        let data: { source: string; path: string; name: string; isDir: boolean; serverId?: string } | null = null;
        try { data = JSON.parse(raw); } catch { return; }
        if (!data) return;
        /* 树内移动（此前缺失：local 载荷只有远端接收逻辑，拖到目录上被静默丢弃） */
        if (data.source === 'local') {
          void moveNode(data.path, data.name, data.isDir, node);
          return;
        }
        if (data.source !== 'remote') return;
        const serverId = data.serverId;
        if (!serverId) return;
        void downloadTo({ path: data.path, name: data.name, serverId }, node);
        return;
      }
      // OS 文件拖入（dataTransfer.files）：导入本地目录；SFTP 面板不接收（产品禁令）
      if (e.dataTransfer.files.length > 0) {
        e.preventDefault();
        e.stopPropagation(); // 防止冒泡到树空白区 handler 重复导入
        void importOsFiles(e.dataTransfer, node);
      }
    });
  }

  row.addEventListener('click', () => openNode(node));
  return row;
}

async function deleteNode(node: TreeNode): Promise<void> {
  const ok = await confirmDialog({
    title: node.isDir ? '删除目录' : '删除文件',
    message: `确定删除「${node.name}」吗？`,
    danger: true,
    okText: '删除',
  });
  if (!ok) return;
  try {
    await fsDelete(node.path);
    const parent = node.parent;
    if (parent?.children) {
      const idx = parent.children.indexOf(node);
      if (idx >= 0) parent.children.splice(idx, 1);
    }
    expanded.delete(node.path);
    render();
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 打开（单击 / 菜单「打开」共用） ---------- */
function openNode(node: TreeNode): void {
  if (node.isDir) {
    if (expanded.has(node.path)) {
      expanded.delete(node.path);
      render();
    } else {
      expanded.add(node.path);
      if (node.children) render();
      else void loadDir(node);
    }
  } else {
    openTab({
      id: `editor:${node.path}`,
      type: 'editor',
      title: node.name,
      data: { path: node.path, name: node.name },
    });
  }
}

/* ---------- 编辑器占用保护 ---------- */
/** 正在编辑器打开的文件路径（editor tab id = editor:<path>） */
function editingPaths(): string[] {
  return getTabs().filter((t) => t.type === 'editor').map((t) => t.id.slice('editor:'.length));
}

/** path 或其子孙正被编辑时提示并返回 true——移动/重命名后旧标签写盘会在旧路径重建文件，抵消操作 */
function blockedByEditor(path: string): boolean {
  const hit = editingPaths().some((p) => p === path || p.startsWith(`${path}/`));
  if (hit) toast('该文件正在编辑器中打开，请先关闭对应标签页', 'error');
  return hit;
}

/* ---------- 树内移动（拖拽）与剪贴板粘贴 ---------- */
async function moveNode(srcPath: string, name: string, isDir: boolean, targetDir: TreeNode): Promise<void> {
  if (srcPath === targetDir.path) return; // 拖到自身
  if (isDir && targetDir.path.startsWith(`${srcPath}/`)) {
    toast('不能把目录移动到它自身内部', 'error');
    return;
  }
  const srcParent = srcPath.slice(0, srcPath.length - name.length - 1);
  if (normPath(srcParent) === normPath(targetDir.path)) return; // 原地拖放
  if (blockedByEditor(srcPath)) return;
  try {
    await fsMove(srcPath, joinPath(targetDir.path, name));
    expanded.add(targetDir.path);
    await refreshAll();
  } catch (err) {
    toast(String(err), 'error');
  }
}

async function pasteInto(targetDir: TreeNode): Promise<void> {
  const clip = fsClipboard;
  if (!clip) return;
  if (clip.isDir && (targetDir.path === clip.path || targetDir.path.startsWith(`${clip.path}/`))) {
    toast('不能把目录粘贴到它自身内部', 'error');
    return;
  }
  try {
    if (clip.mode === 'cut') {
      const srcParent = clip.path.slice(0, clip.path.length - clip.name.length - 1);
      if (normPath(srcParent) === normPath(targetDir.path)) return; // 同目录剪切 = 无操作
      if (blockedByEditor(clip.path)) return;
      await fsMove(clip.path, joinPath(targetDir.path, clip.name));
      fsClipboard = null;
    } else {
      await fsCopy(clip.path, targetDir.path);
    }
    expanded.add(targetDir.path);
    await refreshAll();
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 重命名（行内输入，风格同新建输入行） ---------- */
function startRename(node: TreeNode, row: HTMLElement): void {
  if (blockedByEditor(node.path)) return; // 编辑中的文件直接拒绝进入重命名
  const nameEl = row.querySelector('.wbs-explorer-name');
  if (!nameEl) return;
  const input = document.createElement('input');
  input.className = 'input wbs-explorer-rename';
  input.value = node.name;
  nameEl.replaceWith(input);
  input.focus();
  /* 选中主名（文件不含扩展名），与系统资源管理器一致 */
  const dot = node.isDir ? -1 : node.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (!commit || !newName || newName === node.name) { render(); return; }
    if (/[\\/]/.test(newName)) {
      toast('名称不能包含路径分隔符', 'error');
      render();
      return;
    }
    if (blockedByEditor(node.path)) { render(); return; }
    const parent = node.path.slice(0, node.path.length - node.name.length - 1);
    void fsMove(node.path, joinPath(parent, newName))
      .then(() => refreshAll())
      .catch((err: unknown) => { toast(String(err), 'error'); render(); });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

/** 相对项目根的路径（根自身返回空串时不应出现——根行菜单不提供此项） */
function relativePath(path: string): string {
  const root = getRoot();
  if (root && path.startsWith(`${root.path}/`)) return path.slice(root.path.length + 1);
  return path;
}
function showNodeMenu(x: number, y: number, node: TreeNode, row: HTMLElement): void {
  const pasteTarget = node.isDir ? node : node.parent;
  /* 编辑中的文件禁止移动类操作——旧标签写盘会在旧路径重建文件,抵消操作;防线前置为禁用态 */
  const editing = editingPaths().some((p) => p === node.path || p.startsWith(`${node.path}/`));
  const editingTip = '文件正在编辑器中打开,请先关闭对应标签页';
  /* 目录行右键：新建文件/目录（在选中目录下创建） */
  const newItems: CtxItem[] = node.isDir ? [
    { label: '新建文件', iconName: 'filePlus', action: () => startInlineInput(false, node, row) },
    { label: '新建目录', iconName: 'folderPlus', action: () => startInlineInput(true, node, row) },
  ] : [];
  showContextMenu(x, y, [
    { label: '打开', iconName: node.isDir ? 'folder' : 'file', action: () => openNode(node) },
    ...(newItems.length ? ['sep' as const, ...newItems] : []),
    'sep',
    { label: '复制', iconName: 'copy', action: () => { fsClipboard = { path: node.path, name: node.name, isDir: node.isDir, mode: 'copy' }; render(); } },
    { label: '剪切', iconName: 'scissors', disabled: editing, disabledTip: editingTip, action: () => { fsClipboard = { path: node.path, name: node.name, isDir: node.isDir, mode: 'cut' }; render(); } },
    { label: '粘贴', iconName: 'clipboard', disabled: !fsClipboard || !pasteTarget, action: () => { if (pasteTarget) void pasteInto(pasteTarget); } },
    'sep',
    { label: '重命名', iconName: 'pencil', disabled: editing, disabledTip: editingTip, action: () => startRename(node, row) },
    { label: '删除', iconName: 'trash', danger: true, action: () => void deleteNode(node) },
    'sep',
    { label: '在系统文件资源管理器中打开', iconName: 'externalLink', action: () => void fsReveal(node.path).catch((err) => toast(String(err), 'error')) },
    { label: '复制文件路径', iconName: 'link', action: () => { void copyText(node.path.replace(/\//g, '\\')).then(() => toast('已复制文件路径', 'success')); } },
    { label: '复制相对路径', iconName: 'link', action: () => { void copyText(relativePath(node.path)).then(() => toast('已复制相对路径', 'success')); } },
  ]);
}

function showRootMenu(x: number, y: number, root: TreeNode): void {
  showContextMenu(x, y, [
    { label: '新建文件', iconName: 'filePlus', action: () => startInlineInput(false, root, null) },
    { label: '新建目录', iconName: 'folderPlus', action: () => startInlineInput(true, root, null) },
    'sep',
    { label: '粘贴', iconName: 'clipboard', disabled: !fsClipboard, action: () => void pasteInto(root) },
    'sep',
    { label: '在系统文件资源管理器中打开', iconName: 'externalLink', action: () => void fsReveal(root.path).catch((err) => toast(String(err), 'error')) },
  ]);
}

/* ---------- 新建（内联输入行；parent 为空 = 根目录，afterRow 指定输入行插入位置） ---------- */
const depthOf = (n: TreeNode): number => {
  let d = 0;
  while (n.parent) { d++; n = n.parent; }
  return d;
};

function startInlineInput(isDir: boolean, parent: TreeNode | null, afterRow: HTMLElement | null): void {
  if (!container || container.querySelector('.wbs-explorer-inline-input')) return;
  const p = parent ?? getRoot();
  if (!p) return;
  const row = document.createElement('div');
  row.className = 'wbs-explorer-row';
  row.style.paddingLeft = `${6 + (depthOf(p) + 1) * 14}px`;
  const input = document.createElement('input');
  input.className = 'input wbs-explorer-inline-input';
  input.placeholder = isDir ? '目录名' : '文件名';
  input.spellcheck = false;
  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    const name = input.value.trim();
    row.remove();
    if (commit && name) void createIn(p, name, isDir);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(false));
  row.appendChild(input);
  const anchor = afterRow ?? container.querySelector('.wbs-explorer-row');
  if (anchor) anchor.after(row);
  else container.appendChild(row);
  input.focus();
}

async function createIn(parent: TreeNode, name: string, isDir: boolean): Promise<void> {
  const target = joinPath(parent.path, name);
  try {
    await fsCreate(target, isDir);
    if (isDir) expanded.add(target);
    // 父目录展开（含未展开过的情况）保证新项目立即可见
    expanded.add(parent.path);
    await refreshDir(parent);
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 远端拖入下载 ---------- */
async function downloadTo(
  data: { path: string; name: string; serverId: string },
  targetDir: TreeNode,
): Promise<void> {
  try {
    await sftpDownload(data.serverId, data.path, targetDir.path);
    toast(`已下载 ${data.name} 到 ${targetDir.path}`, 'success');
    expanded.add(targetDir.path);
    await refreshDir(targetDir);
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- OS 文件拖入导入 ---------- */
/** 单文件上限 100MB（base64 传输，超大文件走系统拷贝更稳） */
const OS_IMPORT_MAX_BYTES = 100 * 1024 * 1024;

async function importOsFiles(dt: DataTransfer, targetDir: TreeNode): Promise<void> {
  const entries: FileSystemEntry[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry();
    if (entry) entries.push(entry);
  }
  if (!entries.length) {
    toast('未识别到可导入的文件', 'error');
    return;
  }
  try {
    let count = 0;
    for (const entry of entries) count += await importEntry(entry, targetDir.path);
    if (count > 0) {
      toast(`已导入 ${count} 个项目到 ${targetDir.path}`, 'success');
      expanded.add(targetDir.path);
      await refreshDir(targetDir);
    }
  } catch (err) {
    toast(String(err), 'error');
  }
}

/** 递归导入一个 entry（目录沿 webkitGetAsEntry 遍历），返回导入条目数。 */
async function importEntry(entry: FileSystemEntry, destDir: string): Promise<number> {
  if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const finalName = await fsImport(destDir, entry.name, true, null);
    const children = await readAllEntries(dirEntry.createReader());
    let n = 1;
    for (const child of children) n += await importEntry(child, joinPath(destDir, finalName));
    return n;
  }
  const file = await entryFile(entry as FileSystemFileEntry);
  if (file.size > OS_IMPORT_MAX_BYTES) {
    toast(`「${file.name}」超过 100MB，已跳过`, 'error');
    return 0;
  }
  const b64 = await fileToBase64(file);
  await fsImport(destDir, file.name, false, b64);
  return 1;
}

/** readEntries 每批最多 100 条，循环取空为止。 */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  const batch = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));
  return (async () => {
    for (;;) {
      const chunk = await batch();
      if (!chunk.length) return all;
      all.push(...chunk);
    }
  })();
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/* ---------- 渲染 ---------- */
function appendNode(parent: HTMLElement, node: TreeNode, depth: number, isRoot: boolean): void {
  parent.appendChild(buildRow(node, depth, isRoot));
  if (!node.isDir || !expanded.has(node.path)) return;
  if (!node.children) {
    if (node.loading) {
      const wait = document.createElement('div');
      wait.className = 'wbs-explorer-loading';
      wait.style.paddingLeft = `${6 + (depth + 1) * 14}px`;
      wait.textContent = '加载中…';
      parent.appendChild(wait);
    } else {
      /* 展开但未加载（移动/粘贴把目标目录置为 expanded 时即此场景）→ 自动加载 */
      void loadDir(node);
    }
    return;
  }
  node.children.forEach((c) => appendNode(parent, c, depth + 1, false));
}

function render(): void {
  if (!container) return;
  const scrollTop = container.scrollTop;
  container.innerHTML = '';
  const root = getRoot();
  if (!root) {
    const es = document.createElement('div');
    es.className = 'empty-state';
    es.innerHTML = `<div class="icon">${iconSvg('folder')}</div><div>项目未设置本地路径</div><div style="font-size:11.5px">请在「设置」中为项目选择工作目录</div>`;
    container.appendChild(es);
    return;
  }
  const tree = document.createElement('div');
  tree.className = 'wbs-explorer-tree';
  /* 树空白区也是 OS 拖入落点（落到根目录）；行级 drop 已 stopPropagation，不会重复导入 */
  tree.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  tree.addEventListener('drop', (e) => {
    if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
    const root = getRoot();
    if (!root) return;
    e.preventDefault();
    void importOsFiles(e.dataTransfer, root);
  });
  appendNode(tree, root, 0, true);
  container.appendChild(tree);
  container.scrollTop = scrollTop;
  if (!root.children && !root.loading) void loadDir(root); // 根目录默认展开
}

/* ---------- 定时刷新（终端 touch 等外部变更可见） ---------- */
const POLL_MS = 3000;
let pollTimer: number | null = null;

function startPolling(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (!container?.isConnected || document.hidden) return; // 面板已切走 / 窗口不可见
    if (container.querySelector('.wbs-explorer-inline-input, .wbs-explorer-rename')) return; // 输入中不打断
    if (!getRoot()) return;
    void refreshAll();
  }, POLL_MS);
}

/* ---------- 挂载 ---------- */
export function mountExplorerPanel(el: HTMLElement): void {
  container = el;
  if (!mounted) {
    mounted = true;
    bus.on('project-changed', () => {
      // 项目路径变化 → 重建根；仅 quickCommands 等变化 → 刷新已加载目录
      const raw = Workbench.state.project?.path;
      const path = raw ? normPath(raw) : null;
      if (path !== (rootNode?.path ?? null)) {
        rootNode = null;
        expanded.clear();
      }
      if (!getRoot()) { render(); return; }
      void refreshAll();
    });
  }
  render();
  startPolling();
}
