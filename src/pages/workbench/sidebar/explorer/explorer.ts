/**
 * 文件资源管理器:DOM 渲染与交互层(React 迁移拆分子模块,聚合入口 ExplorerPanel.tsx)。
 * 对照 legacy/pages/workbench/sidebar/explorer.ts(1105 行)逐条翻译:
 * - 树模型 / 加载 / 展开状态持久化在 ./tree.ts,本文件只负责行渲染、右键菜单、行内输入、
 *   拖拽(DND_MIME 契约 + OS 文件 webkitGetAsEntry 导入)、属性对话框、快捷键、定时轮询与挂载;
 * - 挂载契约:mountExplorer(el) 返回 cleanup(反注册 wbEvents 监听 / 移除快捷键 / 停轮询 /
 *   作废在途加载),由 React 组件 useEffect 调用;模块级状态(根节点/展开集合/选中路径)
 *   跨面板切换保留(与 legacy 卸载即弃容器、保留模块状态一致);
 * - 快捷键门禁 Workbench.activePanel → useWorkbench().panel;openTab → useWorkbench().openTab
 *   (文件打开统一走 EditorTab 的 openLocalFile);SFTP 上传目标的命令式句柄 sftpTab.api →
 *   tabApis.get(tab.id)(stores/workbench 注册表);
 * - revealLocalPath 为对外导出契约(SftpTab 下载完成定位用):先 setPanel('explorer')
 *   再在面板内展开定位;面板尚未挂载(React 异步渲染)时经 pendingReveal 由挂载流程接管。
 * 接口点:src/api.ts 的 fs_list/fs_create/fs_delete/fs_move/fs_copy/fs_import/fs_stat/fs_reveal
 *   /sftp_upload/sftp_download/sftp_delete;src/ui.ts confirmDialog/copyText/showContextMenu/toast;
 *   stores/workbench 的 useWorkbench/wbEvents/tabApis/DND_MIME/wbHandles。
 *
 * 相对 legacy 的修复:
 * - legacy 的 window keydown 快捷键在模块加载时注册、从不移除(应用生命周期泄漏,工作台
 *   实例销毁后残留闭包);React 版改为 mountExplorer 内注册、cleanup 移除,语义不变
 *   (面板未显示时同样早退);
 * - 属性对话框 propModal 若随面板容器被销毁(切项目重建工作台)仍持有已脱离 DOM 的引用,
 *   后续「属性」点击不可见;React 版在 isConnected 检查失败时重建(附带到新容器);
 * - revealLocalPath 在容器未挂载时(切面板后的 React 渲染间隙)改为等待挂载接管,
 *   legacy 直接静默返回,切面板后立刻触发会定位失败。
 */
import { icon } from '../../../../icons';
import {
  fsCopy, fsCreate, fsDelete, fsImport, fsMove, fsReveal, fsStat,
  sftpDelete, sftpDownload, sftpUpload,
} from '../../../../api';
import type { FsStat } from '../../../../types';
import {
  confirmDialog, copyText, showContextMenu, toast, type CtxItem,
} from '../../../../ui';
import {
  DND_MIME, getActiveTab, tabApis, useWorkbench, wbEvents, wbHandles,
} from '../../../../stores/workbench';
import { clearClip, getClip, setClip } from '../../clipboard';
import { openLocalFile } from '../../tabs/EditorTab';
import {
  blockedByEditor, collapse, depthOf, editingPaths, expand, findNode, getRoot, getRootPath,
  invalidateLoads, isExpanded, joinPath, loadDir, normPath, refreshAll, refreshDir,
  relativePath, resetRoot, seedExpanded, setRenderHook, clearExpanded, type TreeNode,
} from './tree';
/** 头按钮「刷新」与聚合入口共用(转出给 ExplorerPanel.tsx) */
export { refreshAll } from './tree';

/* ---------- 文件类型角标(照抄原型 FILE_STYLES) ---------- */
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

/** 面板容器(挂载时赋值,卸载置 null;渲染/轮询/定位都以它为界) */
let container: HTMLElement | null = null;
/** 单击聚焦的当前行路径(快捷键操作目标;渲染时行加 .sel) */
let selectedPath: string | null = null;
/** 拖拽中的本地节点(dragover 据此决定 move/copy 光标;守卫在 moveNode 内) */
let draggingNode: TreeNode | null = null;
/** 属性对话框(一次性建 DOM 复用,模态框模式同 servers.ts;容器销毁后重建) */
let propModal: HTMLElement | null = null;
/** 属性对话框的 document Escape 监听(重建时先移除旧的,防累积) */
let propKeyHandler: ((e: KeyboardEvent) => void) | null = null;
/** 定时刷新(终端 touch 等外部变更可见) */
const POLL_MS = 3000;
let pollTimer: number | null = null;
/** 面板未挂载时待执行的定位请求(revealLocalPath 与挂载流程的交接点) */
let pendingReveal: string | null = null;

/* ---------- 行渲染 ---------- */
function buildRow(node: TreeNode, depth: number, isRoot: boolean): HTMLElement {
  const row = document.createElement('div');
  row.className = 'wbs-explorer-row';
  row.style.paddingLeft = `${6 + depth * 14}px`;
  row.title = node.path;
  row.dataset.path = node.path; // 快捷键定位行元素用
  if (selectedPath === node.path) row.classList.add('sel');

  const arrow = document.createElement('span');
  arrow.className = 'wbs-explorer-arrow';
  if (node.isDir) arrow.textContent = isExpanded(node.path) ? '▾' : '▸';
  row.appendChild(arrow);

  const fileTag = document.createElement('span');
  fileTag.className = 'wbs-explorer-file-tag';
  if (node.isDir) {
    fileTag.innerHTML = icon(isExpanded(node.path) ? 'folderOpen' : 'folder');
  } else {
    const ext = (node.name.split('.').pop() || '').toLowerCase();
    const st = FILE_STYLES[ext];
    if (st) {
      fileTag.textContent = st.label;
      fileTag.style.fontSize = '9.5px';
      fileTag.style.fontWeight = '700';
      fileTag.style.color = st.color;
    } else {
      fileTag.innerHTML = icon('file');
    }
  }
  row.appendChild(fileTag);

  const name = document.createElement('span');
  name.className = 'wbs-explorer-name';
  name.textContent = node.name;
  row.appendChild(name);

  if (!isRoot) {
    const del = document.createElement('button');
    del.className = 'icon-btn danger wbs-explorer-del';
    del.title = '删除';
    del.innerHTML = icon('trash');
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteNode(node);
    });
    row.appendChild(del);

    /* 拖拽:local 源(DND 契约)——树内拖到目录=移动,供远端 SFTP 面板接收=上传 */
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.setData(DND_MIME, JSON.stringify({
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
    /* 根行右键:仅粘贴 / 系统资源管理器打开 */
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showRootMenu(e.clientX, e.clientY, node);
    });
  }

  /* 剪切中的行半透明(剪切粘贴成功前) */
  const clipMark = getClip();
  if (clipMark?.mode === 'cut' && clipMark.items.some((i) => i.path === node.path)) {
    row.classList.add('wbs-cut');
  }

  /* 目录行是 remote 拖入的下载目标,也是 OS 文件拖入的上传目标 */
  if (node.isDir) {
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      const types = Array.from(e.dataTransfer.types);
      if (!types.includes(DND_MIME) && !types.includes('Files')) return;
      e.preventDefault();
      /* 本地树内拖拽=移动;远端 / OS 文件=复制 */
      e.dataTransfer.dropEffect = draggingNode ? 'move' : 'copy';
      row.classList.add('wbs-explorer-drop');
    });
    row.addEventListener('dragleave', (e) => {
      if (!row.contains(e.relatedTarget as Node)) row.classList.remove('wbs-explorer-drop');
    });
    row.addEventListener('drop', (e) => {
      row.classList.remove('wbs-explorer-drop');
      if (!e.dataTransfer) return;
      const raw = (() => { try { return e.dataTransfer!.getData(DND_MIME); } catch { return ''; } })();
      if (raw) {
        e.preventDefault();
        let data: { source: string; path: string; name: string; isDir: boolean; serverId?: string } | null = null;
        try { data = JSON.parse(raw); } catch { return; }
        if (!data) return;
        /* 树内移动(legacy 曾缺失:local 载荷只有远端接收逻辑,拖到目录上被静默丢弃) */
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
      // OS 文件拖入(dataTransfer.files):导入本地目录;SFTP 面板不接收(产品禁令)
      if (e.dataTransfer.files.length > 0) {
        e.preventDefault();
        e.stopPropagation(); // 防止冒泡到树空白区 handler 重复导入
        void importOsFiles(e.dataTransfer, node);
      }
    });
  }

  /* 单击聚焦、双击打开(与 SFTP 面板统一;目录双击才展开/折叠)。
     点击同时把焦点从终端 xterm 隐藏输入框移走,让面板快捷键可响应。 */
  row.addEventListener('click', () => {
    selectedPath = node.path;
    (document.activeElement as HTMLElement | null)?.blur?.();
    render();
  });
  row.addEventListener('dblclick', () => openNode(node));
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
    collapse(node.path);
    render();
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 打开(单击 / 菜单「打开」共用) ---------- */
function openNode(node: TreeNode): void {
  if (node.isDir) {
    if (isExpanded(node.path)) {
      collapse(node.path);
      render();
    } else {
      expand(node.path);
      if (node.children) render();
      else void loadDir(node);
    }
  } else {
    openLocalFile(node.path, node.name);
  }
}

/* ---------- 树内移动(拖拽)与剪贴板粘贴 ---------- */
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
    expand(targetDir.path);
    await refreshAll();
  } catch (err) {
    toast(String(err), 'error');
  }
}

async function pasteInto(targetDir: TreeNode): Promise<void> {
  const clip = getClip();
  if (!clip) return;
  /* 远端源:下载到本地目标目录(重名自动改名);剪切 = 下载 + 删除远端源 */
  if (clip.source === 'remote') {
    if (!clip.serverId) return;
    if (clip.items.some((i) => i.isDir && (targetDir.path === i.path || targetDir.path.startsWith(`${i.path}/`)))) {
      toast('不能把目录粘贴到它自身内部', 'error');
      return;
    }
    try {
      for (const it of clip.items) await sftpDownload(clip.serverId, it.path, targetDir.path);
      if (clip.mode === 'cut') {
        for (const it of clip.items) await sftpDelete(clip.serverId, it.path);
        clearClip();
      }
      expand(targetDir.path);
      await refreshDir(targetDir);
      toast('粘贴成功', 'success');
    } catch (err) {
      toast(String(err), 'error');
    }
    return;
  }
  if (clip.items.some((i) => i.isDir && (targetDir.path === i.path || targetDir.path.startsWith(`${i.path}/`)))) {
    toast('不能把目录粘贴到它自身内部', 'error');
    return;
  }
  try {
    if (clip.mode === 'cut') {
      for (const it of clip.items) {
        const srcParent = it.path.slice(0, it.path.length - it.name.length - 1);
        if (normPath(srcParent) === normPath(targetDir.path)) continue; // 同目录剪切 = 无操作
        if (blockedByEditor(it.path)) continue;
        await fsMove(it.path, joinPath(targetDir.path, it.name));
      }
      clearClip();
    } else {
      for (const it of clip.items) await fsCopy(it.path, targetDir.path);
    }
    expand(targetDir.path);
    await refreshAll();
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 重命名(行内输入,风格同新建输入行) ---------- */
function startRename(node: TreeNode, row: HTMLElement): void {
  if (blockedByEditor(node.path)) return; // 编辑中的文件直接拒绝进入重命名
  const nameEl = row.querySelector('.wbs-explorer-name');
  if (!nameEl) return;
  const input = document.createElement('input');
  input.className = 'input wbs-explorer-rename';
  input.value = node.name;
  nameEl.replaceWith(input);
  input.focus();
  /* 选中主名(文件不含扩展名),与系统资源管理器一致 */
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

/* ---------- 属性对话框(一次性建 DOM 复用,模态框模式同 servers.ts) ---------- */

/** 人类可读大小:B / KB / MB / GB / TB,≥100 取整,其余保留 1 位小数 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = v >= 100 ? String(Math.round(v)) : v.toFixed(1).replace(/\.0$/, '');
  return `${s} ${units[i]}`;
}

function ensurePropModal(): HTMLElement {
  /* 已建过但随面板容器被销毁(切项目重建工作台)时重建,避免持有脱离 DOM 的引用 */
  if (propModal && propModal.isConnected) return propModal;
  propModal = null;
  if (propKeyHandler) { document.removeEventListener('keydown', propKeyHandler); propKeyHandler = null; }
  const mask = document.createElement('div');
  mask.className = 'modal-mask hidden';
  mask.innerHTML = `
    <div class="modal wbs-prop-modal">
      <div class="modal-head">
        <h3>属性</h3>
        <button class="icon-btn" title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="wbs-prop-title">
          <span class="wbs-prop-icon">${icon('file')}</span>
          <span class="wbs-prop-name"></span>
        </div>
        <div class="wbs-prop-rows"></div>
      </div>
      <div class="modal-foot">
        <button class="btn primary" data-act="close">关闭</button>
      </div>
    </div>`;
  const rows = mask.querySelector('.wbs-prop-rows')!;
  const defs: Array<[string, string]> = [
    ['type', '类型'],
    ['size', '大小'],
    ['mtime', '修改时间'],
    ['readonly', '只读'],
    ['link', '链接目标'],
    ['path', '完整路径'],
  ];
  for (const [key, label] of defs) {
    const row = document.createElement('div');
    row.className = 'wbs-prop-row';
    row.dataset.key = key;
    const lab = document.createElement('span');
    lab.className = 'wbs-prop-label';
    lab.textContent = label;
    const val = document.createElement('span');
    val.className = 'wbs-prop-value mono';
    row.append(lab, val);
    rows.appendChild(row);
  }
  const close = (): void => {
    mask.classList.remove('open');
    setTimeout(() => mask.classList.add('hidden'), 160);
  };
  mask.querySelector('[data-act=close]')!.addEventListener('click', close);
  mask.querySelector('.modal-head .icon-btn')!.addEventListener('click', close);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape' && !mask.classList.contains('hidden')) close();
  };
  document.addEventListener('keydown', onKey);
  propKeyHandler = onKey;
  (container ?? document.body).appendChild(mask);
  propModal = mask;
  return mask;
}

async function showProperties(node: TreeNode): Promise<void> {
  let stat: FsStat;
  try {
    stat = await fsStat(node.path);
  } catch (err) {
    toast(String(err), 'error');
    return;
  }
  const mask = ensurePropModal();
  const iconEl = mask.querySelector('.wbs-prop-icon') as HTMLElement;
  iconEl.innerHTML = icon(stat.linkTarget ? 'link' : stat.isDir ? 'folder' : 'file');
  mask.querySelector('.wbs-prop-name')!.textContent = stat.name;
  const values: Record<string, HTMLElement> = {};
  mask.querySelectorAll<HTMLElement>('.wbs-prop-row').forEach((row) => {
    values[row.dataset.key!] = row.querySelector('.wbs-prop-value')!;
  });
  values.type.textContent = stat.linkTarget ? '符号链接' : stat.isDir ? '文件夹' : '文件';
  /* 目录大小由系统语义决定,不具可比性,展示 —(选简单方案) */
  values.size.textContent = stat.isDir ? '—' : formatSize(stat.size);
  values.mtime.textContent = new Date(stat.mtime * 1000).toLocaleString();
  values.readonly.textContent = stat.readonly ? '是' : '否';
  mask.querySelectorAll<HTMLElement>('.wbs-prop-row[data-key="link"]').forEach((row) => {
    row.classList.toggle('hidden', !stat.linkTarget);
  });
  values.link.textContent = stat.linkTarget ?? '—';
  values.path.textContent = stat.path;
  mask.classList.remove('hidden');
  requestAnimationFrame(() => mask.classList.add('open'));
}

/** 把文件/目录路径引用加入 AI 输入框(@file:文件名 / @path:目录名 标签,见 core.ts AiHandle.addPathRef);
 *  图片文件走图片附件(addImageRef:物化后随消息传图,而非只带路径);面板未挂载时提示 */
function addPathToChat(path: string, isDir: boolean): void {
  const name = path.split('/').filter(Boolean).pop() ?? '';
  if (!isDir && /\.(png|jpe?g|gif|webp)$/i.test(name)) {
    if (wbHandles.ai?.addImageRef) {
      wbHandles.ai.addImageRef({ source: 'local', path });
    } else {
      toast('AI 面板尚未就绪');
    }
    return;
  }
  if (wbHandles.ai?.addPathRef) {
    wbHandles.ai.addPathRef({ path, isDir });
  } else {
    toast('AI 面板尚未就绪');
  }
}

/* ---------- 右键菜单 ---------- */
/** 上传到 SFTP 菜单项:仅当工作区激活标签为 SFTP 时显示(目标 = 该 SFTP 标签当前目录) */
function sftpUploadItems(path: string, name: string): CtxItem[] {
  const sftpTab = getActiveTab(useWorkbench.getState());
  if (!sftpTab || sftpTab.type !== 'sftp' || !sftpTab.data.serverId) return [];
  const serverId = String(sftpTab.data.serverId);
  return [{
    label: '上传到服务器', iconName: 'upload',
    action: () => {
      const api = tabApis.get(sftpTab.id) as { getCwd?: () => string; focus?: (name: string) => void } | undefined;
      const cwd = api?.getCwd?.() ?? '/';
      void sftpUpload(serverId, path, cwd)
        .then((landed) => {
          toast(`已上传 ${name}`, 'success');
          api?.focus?.(landed); // 刷新 SFTP 面板并聚焦落地文件
        })
        .catch((err: unknown) => toast(String(err), 'error'));
    },
  }];
}

function showNodeMenu(x: number, y: number, node: TreeNode, row: HTMLElement): void {
  const pasteTarget = node.isDir ? node : node.parent;
  /* 编辑中的文件禁止移动类操作——旧标签写盘会在旧路径重建文件,抵消操作;防线前置为禁用态
     (纯查询不 toast:菜单打开时仅禁用项带提示,真正触发动作时 blockedByEditor 才会提示) */
  const editing = editingPaths().some((p) => p === node.path || p.startsWith(`${node.path}/`));
  const editingTip = '文件正在编辑器中打开,请先关闭对应标签页';
  /* 目录行右键:新建文件/目录(在选中目录下创建)+ 刷新该目录 */
  const newItems: CtxItem[] = node.isDir ? [
    { label: '新建文件', iconName: 'filePlus', action: () => startInlineInput(false, node, row) },
    { label: '新建目录', iconName: 'folderPlus', action: () => startInlineInput(true, node, row) },
    { label: '刷新', iconName: 'refresh', action: () => void refreshDir(node) },
  ] : [];
  const uploadItems = sftpUploadItems(node.path, node.name);
  showContextMenu(x, y, [
    { label: '打开', iconName: node.isDir ? 'folder' : 'file', action: () => openNode(node) },
    ...(newItems.length ? ['sep' as const, ...newItems] : []),
    'sep',
    { label: '复制', iconName: 'copy', action: () => { setClip({ source: 'local', items: [{ path: node.path, name: node.name, isDir: node.isDir }], mode: 'copy' }); render(); } },
    { label: '剪切', iconName: 'scissors', disabled: editing, disabledTip: editingTip, action: () => { setClip({ source: 'local', items: [{ path: node.path, name: node.name, isDir: node.isDir }], mode: 'cut' }); render(); } },
    { label: '粘贴', iconName: 'clipboard', disabled: !getClip() || !pasteTarget, action: () => { if (pasteTarget) void pasteInto(pasteTarget); } },
    ...(uploadItems.length ? ['sep' as const, ...uploadItems] : []),
    'sep',
    { label: '重命名', iconName: 'pencil', disabled: editing, disabledTip: editingTip, action: () => startRename(node, row) },
    { label: '删除', iconName: 'trash', danger: true, action: () => void deleteNode(node) },
    'sep',
    { label: '在系统文件资源管理器中打开', iconName: 'externalLink', action: () => void fsReveal(node.path).catch((err) => toast(String(err), 'error')) },
    { label: '添加到对话', iconName: 'chatPlus', action: () => addPathToChat(node.path, node.isDir) },
    { label: '复制文件路径', iconName: 'link', action: () => { void copyText(node.path.replace(/\//g, '\\')).then(() => toast('已复制文件路径', 'success')); } },
    { label: '复制相对路径', iconName: 'link', action: () => { void copyText(relativePath(node.path)).then(() => toast('已复制相对路径', 'success')); } },
    { label: '属性', iconName: 'info', action: () => void showProperties(node) },
  ]);
}

function showRootMenu(x: number, y: number, root: TreeNode): void {
  const uploadItems = sftpUploadItems(root.path, root.name);
  showContextMenu(x, y, [
    { label: '新建文件', iconName: 'filePlus', action: () => startInlineInput(false, root, null) },
    { label: '新建目录', iconName: 'folderPlus', action: () => startInlineInput(true, root, null) },
    { label: '刷新', iconName: 'refresh', action: () => void refreshAll() },
    'sep',
    { label: '粘贴', iconName: 'clipboard', disabled: !getClip(), action: () => void pasteInto(root) },
    ...(uploadItems.length ? ['sep' as const, ...uploadItems] : []),
    'sep',
    { label: '在系统文件资源管理器中打开', iconName: 'externalLink', action: () => void fsReveal(root.path).catch((err) => toast(String(err), 'error')) },
    { label: '添加到对话', iconName: 'chatPlus', action: () => addPathToChat(root.path, true) },
    { label: '属性', iconName: 'info', action: () => void showProperties(root) },
  ]);
}

/* ---------- 新建(内联输入行;parent 为空 = 根目录,afterRow 指定输入行插入位置) ---------- */
export function startInlineInput(isDir: boolean, parent: TreeNode | null, afterRow: HTMLElement | null): void {
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
    if (isDir) expand(target);
    // 父目录展开(含未展开过的情况)保证新项目立即可见
    expand(parent.path);
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
    expand(targetDir.path);
    await refreshDir(targetDir);
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 下载后定位高亮(SFTP 面板下载完成调用) ---------- */
/** 等待 node.children 就绪:未加载则发起,在途加载则轮询等其落地。 */
async function ensureChildren(node: TreeNode): Promise<void> {
  for (;;) {
    if (node.children) return;
    if (node.loading) {
      await new Promise((r) => setTimeout(r, 40));
      continue;
    }
    await loadDir(node);
    return;
  }
}

/** 展开祖先链、滚动到可见并短暂高亮目标本地路径;路径不在项目内时静默忽略。 */
async function doReveal(path: string): Promise<void> {
  const root = getRoot();
  if (!container || !root || !path.startsWith(`${root.path}/`)) return;
  const segs = path.slice(root.path.length + 1).split('/');
  let node = root;
  // 逐级展开父目录(每层确保 children 已加载)
  for (let i = 0; i < segs.length - 1; i++) {
    expand(node.path);
    await ensureChildren(node);
    const child = (node.children ?? []).find((c) => c.name === segs[i]);
    if (!child) return;
    node = child;
  }
  expand(node.path);
  render();
  const row = Array.from(container.querySelectorAll('.wbs-explorer-row'))
    .find((el) => el.getAttribute('title') === path);
  if (row) {
    row.scrollIntoView({ block: 'nearest' });
    row.classList.add('wbs-explorer-highlight');
    window.setTimeout(() => row.classList.remove('wbs-explorer-highlight'), 2500);
  }
}

/**
 * 在文件资源管理器中定位本地文件(对外导出契约,SftpTab 下载完成后调用):
 * 先切侧栏面板到 explorer,再在面板内展开祖先链并高亮目标。
 * 面板容器尚未挂载(React 状态更新后的渲染间隙)时交给挂载流程接管(pendingReveal)。
 */
export async function revealLocalPath(path: string): Promise<void> {
  useWorkbench.getState().setPanel('explorer');
  if (!container) {
    pendingReveal = path;
    return;
  }
  await doReveal(path);
}

/* ---------- OS 文件拖入导入 ---------- */
/** 单文件上限 100MB(base64 传输,超大文件走系统拷贝更稳) */
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
      expand(targetDir.path);
      await refreshDir(targetDir);
    }
  } catch (err) {
    toast(String(err), 'error');
  }
}

/** 递归导入一个 entry(目录沿 webkitGetAsEntry 遍历),返回导入条目数。 */
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
    toast(`「${file.name}」超过 100MB,已跳过`, 'error');
    return 0;
  }
  const b64 = await fileToBase64(file);
  await fsImport(destDir, file.name, false, b64);
  return 1;
}

/** readEntries 每批最多 100 条,循环取空为止。 */
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
  if (!node.isDir || !isExpanded(node.path)) return;
  if (!node.children) {
    if (node.loading) {
      const wait = document.createElement('div');
      wait.className = 'wbs-explorer-loading';
      wait.style.paddingLeft = `${6 + (depth + 1) * 14}px`;
      wait.textContent = '加载中…';
      parent.appendChild(wait);
    } else {
      /* 展开但未加载(移动/粘贴把目标目录置为 expanded 时即此场景)→ 自动加载 */
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
    es.innerHTML = `<div class="icon">${icon('folder')}</div><div>项目未设置本地路径</div><div style="font-size:11.5px">请在「设置」中为项目选择工作目录</div>`;
    container.appendChild(es);
    return;
  }
  const tree = document.createElement('div');
  tree.className = 'wbs-explorer-tree';
  /* 树空白区右键 = 根目录菜单(行级 contextmenu 已 stopPropagation,不会重复弹) */
  tree.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showRootMenu(e.clientX, e.clientY, root);
  });
  /* 树空白区也是 OS 拖入落点(落到根目录);行级 drop 已 stopPropagation,不会重复导入 */
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

/* ---------- 定时刷新(终端 touch 等外部变更可见) ---------- */
function startPolling(): void {
  if (pollTimer !== null) window.clearInterval(pollTimer);
  pollTimer = window.setInterval(() => {
    if (!container?.isConnected || document.hidden) return; // 面板已切走 / 窗口不可见
    if (container.querySelector('.wbs-explorer-inline-input, .wbs-explorer-rename')) return; // 输入中不打断
    if (!getRoot()) return;
    void refreshAll();
  }, POLL_MS);
}

/* ---------- 快捷键:Ctrl+C 复制 / Ctrl+X 剪切 / Ctrl+V 粘贴 / F2 重命名 / Delete 删除 ----------
   与 SFTP 面板同套语义;仅当侧栏显示文件资源管理器时生效;编辑控件聚焦时不劫持。
   (legacy 在模块加载时注册且从不移除;React 版随 mount/cleanup 注册移除,语义不变) */
/** 粘贴目标:选中目录自身 / 选中文件(或未选中)的父目录 / 根 */
function pasteTargetNode(): TreeNode | null {
  const root = getRoot();
  if (!root) return null;
  if (!selectedPath) return root;
  const n = findNode(selectedPath);
  if (!n) return root;
  return n.isDir ? n : (n.parent ?? root);
}

function onKeyDown(e: KeyboardEvent): void {
  if (useWorkbench.getState().panel !== 'explorer') return;
  const ae = document.activeElement;
  const typing = ae instanceof HTMLInputElement
    || ae instanceof HTMLTextAreaElement
    || (ae instanceof HTMLElement && ae.isContentEditable);
  if (typing) return;
  const root = getRoot();
  if (!root) return;
  const node = selectedPath ? findNode(selectedPath) : null;
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'v') {
      // 粘贴不要求有选中
      if (getClip()) {
        e.preventDefault();
        const target = pasteTargetNode();
        if (target) void pasteInto(target);
      }
      return;
    }
    if (!node || node === root) return;
    if (k === 'c') {
      e.preventDefault();
      setClip({ source: 'local', items: [{ path: node.path, name: node.name, isDir: node.isDir }], mode: 'copy' });
      render();
      return;
    }
    if (k === 'x') {
      if (blockedByEditor(node.path)) return;
      e.preventDefault();
      setClip({ source: 'local', items: [{ path: node.path, name: node.name, isDir: node.isDir }], mode: 'cut' });
      render();
      return;
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || !node || node === root) return;
  if (e.key === 'F2') {
    if (blockedByEditor(node.path)) return;
    e.preventDefault();
    const row = Array.from(container?.querySelectorAll<HTMLElement>('.wbs-explorer-row') ?? [])
      .find((el) => el.dataset.path === node.path);
    if (row) startRename(node, row);
    return;
  }
  if (e.key === 'Delete') {
    e.preventDefault();
    void deleteNode(node);
  }
}

/* ---------- 挂载 ----------
   契约:container 为面板私有容器(React 组件每次切换面板重建,卸载即弃);
   返回 cleanup:反注册 wbEvents 监听、移除快捷键、停轮询、作废在途加载(loadSeq 递增
   使旧 token 全部失效)、清空容器引用。模块级树状态(根节点/展开集合/选中路径)跨挂载保留。 */
export function mountExplorer(el: HTMLElement): () => void {
  container = el;
  setRenderHook(render); // tree.ts 的加载/播种结果经此触发重绘
  const offProjectChanged = wbEvents.on('project-changed', () => {
    // 项目路径变化 → 重建根;仅 quickCommands 等变化 → 刷新已加载目录
    const raw = useWorkbench.getState().project?.path;
    const path = raw ? normPath(raw) : null;
    if (path !== getRootPath()) {
      resetRoot();
      clearExpanded();
    }
    if (!getRoot()) { render(); return; }
    // 切到新项目:播种其历史展开状态(每项目每会话一次;须在 getRoot 重建之后,
    // 否则重建期的 persist 会先于种子落盘、覆盖该项目历史展开状态)
    void seedExpanded();
    void refreshAll();
  });
  render();
  void seedExpanded();
  /* 挂载期间接管等待中的定位请求(revealLocalPath 在容器未就绪时写入) */
  const pending = pendingReveal;
  pendingReveal = null;
  if (pending) void doReveal(pending);
  startPolling();
  window.addEventListener('keydown', onKeyDown);
  return () => {
    offProjectChanged();
    window.removeEventListener('keydown', onKeyDown);
    if (pollTimer !== null) { window.clearInterval(pollTimer); pollTimer = null; }
    invalidateLoads(); // 作废在途 fsList/loadDir/refreshAll,旧 token 结果不再渲染
    setRenderHook(null);
    if (container === el) container = null;
  };
}
