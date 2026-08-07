/**
 * SFTP 标签渲染器 —— 移植自 .proto/workbench-sftp.js，数据源换成真实后端命令。
 * - 每个 tab 独立维护 cwd / history / forward 栈；打开时先解析远端 home（sftp_home）作为初始路径
 * - 顶栏：后退 / 前进 / 上级 / home（~ 主目录）/ 根（/）+ 可编辑路径输入框（回车或「跳转」直达）+ 平铺/列表视图切换
 * - 平铺/列表双视图；平铺视图支持拖拽框选（多选作用于复制/剪切/删除/压缩等菜单操作）
 * - 容器空白右键：粘贴 + 「打开终端」（新开 SSH 终端标签，自动 cd 到当前目录，可手动执行 tar 压缩/解压）
 * - 条目可拖拽（source:'remote' + serverId）；容器 drop 收 source:'local' → sftp_upload → toast → 刷新
 * - 右键菜单含「属性」（sftp_stat 弹属性框）、「权限设置」「赋予可执行权限」（chmod 经后端
 *   ssh_exec 直执执行，完成后刷新 + toast，见 api.ts sshExec 契约）；权限修改不新增后端命令
 * - 远端命令直执（待优化 5）：压缩/解压/备份/chmod 一律走 ssh_exec 复用既有 SSH 连接，
 *   不再起迷你终端（规避登录时序竞态）；命令与输出/退出码写入 debug 日志（src/debug.ts dbg）
 * - OS 文件拖入（dataTransfer.files）在此面板刻意不接收：系统文件只进本地文件资源管理器
 * - 加载失败：toast 错误原文 + 面板内错误条与「重试」
 */
import './sftp.css';
import type { FsEntry, FsStat, SshExecResult } from '../../types';
import {
  fsDelete, getState, sftpCopy, sftpCreate, sftpDelete, sftpDownload, sftpHome, sftpList, sftpRename,
  sftpStat, sftpUniqueName, sftpUpload, sshExec,
} from '../../api';
import { confirmDialog, promptDialog, showContextMenu, toast, uid, type CtxItem } from '../../ui';
import { bus, getActiveTab, openTab, registerRenderer, Workbench, type Tab } from './core';
import { clearClip, getClip, setClip } from './clipboard';
import { revealLocalPath } from './sidebar/explorer';
import { dbg } from '../../debug';
import { icon, icon as iconSvg } from '../../icons';

interface SftpEls {
  body: HTMLElement;
  backBtn: HTMLButtonElement;
  fwdBtn: HTMLButtonElement;
  upBtn: HTMLButtonElement;
  homeBtn: HTMLButtonElement;
  rootBtn: HTMLButtonElement;
  pathInput: HTMLInputElement;
  goBtn: HTMLButtonElement;
  gridBtn: HTMLButtonElement;
  listBtn: HTMLButtonElement;
}

interface SftpTabState {
  serverId: string;
  /** 远端 home（sftp_home 解析，失败时回退 '/'） */
  home: string;
  cwd: string;
  back: string[];
  fwd: string[];
  els: SftpEls;
  entries: FsEntry[];
  loading: boolean;
  error: string;
  seq: number;
  /** 平铺视图框选/单击选中的条目路径集合（目录切换时清空） */
  sel: Set<string>;
  /** 最近一次渲染的带完整远端路径条目（菜单多选操作的数据源） */
  renderEntries: RemoteEntry[];
  /** 下次 loadDir 成功后要聚焦（选中+滚动）的条目路径；不存在则静默跳过 */
  pendingFocus: string | null;
}

/** 带完整远端路径的展示条目 */
interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

type DndPayload = { source?: string; path?: string; name?: string; isDir?: boolean };

/* ---------- 视图状态（模块级，跨标签共享） ---------- */
let viewMode: 'grid' | 'list' = 'grid';
const sftpTabs = new Map<string, SftpTabState>();

function fmtSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function fmtTime(unixSec: number): string {
  const dt = new Date(unixSec * 1000);
  const p = (v: number) => String(v).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) + ' ' + p(dt.getHours()) + ':' + p(dt.getMinutes());
}

function parentOf(path: string): string {
  if (path === '/') return '/';
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

/** 用户输入的远程路径归一化：统一 '/'、折叠重复分隔符、解析 . / ..，非法输入返回 null */
function normalizeRemotePath(p: string): string | null {
  const raw = p.trim().replace(/\\/g, '/');
  if (!raw) return null;
  const segs: string[] = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') segs.pop();
    else segs.push(seg);
  }
  return '/' + segs.join('/');
}

function emptyState(iconName: Parameters<typeof icon>[0], text: string): HTMLElement {
  const es = document.createElement('div');
  es.className = 'empty-state';
  const ic = document.createElement('div');
  ic.className = 'icon';
  ic.innerHTML = icon(iconName);
  const tx = document.createElement('div');
  tx.textContent = text;
  es.appendChild(ic);
  es.appendChild(tx);
  return es;
}

/* ---------- 导航（异步加载，seq 防竞态：仅最新一次请求可落地） ---------- */
async function loadDir(st: SftpTabState): Promise<void> {
  const seq = ++st.seq;
  st.loading = true;
  st.error = '';
  renderView(st);
  try {
    const entries = await sftpList(st.serverId, st.cwd);
    if (seq !== st.seq) return;
    st.entries = entries;
    st.loading = false;
  } catch (err) {
    if (seq !== st.seq) return;
    st.loading = false;
    st.error = String(err);
    toast(String(err), 'error');
  }
  renderView(st);
  applyFocus(st);
}

/** 刷新后聚焦：选中目标条目并滚动到可见；目标不存在（改名失败/被删）时静默跳过。 */
function applyFocus(st: SftpTabState): void {
  const focus = st.pendingFocus;
  if (!focus) return;
  st.pendingFocus = null;
  if (!st.renderEntries.some((e) => e.path === focus)) return;
  st.sel.clear();
  st.sel.add(focus);
  renderView(st);
  requestAnimationFrame(() => {
    const row = Array.from(st.els.body.querySelectorAll<HTMLElement>('[data-path]'))
      .find((el) => el.dataset.path === focus);
    row?.scrollIntoView({ block: 'nearest' });
  });
}

/** 标记下次刷新后聚焦的目标路径（粘贴/重命名/压缩/上传等操作的统一入口） */
function focusAfterRefresh(st: SftpTabState, path: string): void {
  st.pendingFocus = path;
  void loadDir(st);
}

/** 打开标签先解析远端 home：成功则初始定位 home，失败回退 '/' 并 toast（home 语义仍可用） */
async function initHome(st: SftpTabState): Promise<void> {
  try {
    st.home = await sftpHome(st.serverId);
    st.cwd = st.home;
  } catch (err) {
    toast(String(err), 'error');
  }
  void loadDir(st);
}

function goTo(st: SftpTabState, path: string, push: boolean): void {
  if (path === st.cwd) {
    // 同路径 = 手动刷新（跳转按钮/重复双击目录），不产生历史
    void loadDir(st);
    return;
  }
  if (push) {
    st.back.push(st.cwd);
    st.fwd.length = 0;
  }
  st.cwd = path;
  st.entries = [];
  st.sel.clear(); // 目录切换后旧选中无意义
  void loadDir(st);
}

function goBack(st: SftpTabState): void {
  if (!st.back.length) return;
  st.fwd.push(st.cwd);
  st.cwd = st.back.pop()!;
  void loadDir(st);
}

function goForward(st: SftpTabState): void {
  if (!st.fwd.length) return;
  st.back.push(st.cwd);
  st.cwd = st.fwd.pop()!;
  void loadDir(st);
}

function setViewMode(mode: 'grid' | 'list'): void {
  if (viewMode === mode) return;
  viewMode = mode;
  sftpTabs.forEach((st) => renderView(st));
}

/* ---------- 拖拽 ---------- */
function bindDrag(el: HTMLElement, it: RemoteEntry, st: SftpTabState): void {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    if (!e.dataTransfer) return;
    e.dataTransfer.setData(Workbench.DND_MIME, JSON.stringify({
      source: 'remote',
      path: it.path,
      name: it.name,
      isDir: it.isDir,
      serverId: st.serverId,
    }));
    e.dataTransfer.effectAllowed = 'copy';
  });
}

function bindDrop(root: HTMLElement, st: SftpTabState): void {
  root.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes(Workbench.DND_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  root.addEventListener('drop', async (e) => {
    e.preventDefault();
    // 只收 DND_MIME（应用内拖拽）；OS 文件拖入（无 DND_MIME）一律忽略——产品禁令
    const raw = e.dataTransfer ? e.dataTransfer.getData(Workbench.DND_MIME) : '';
    if (!raw) return;
    let payload: DndPayload | null = null;
    try {
      payload = JSON.parse(raw) as DndPayload;
    } catch {
      return;
    }
    if (!payload || payload.source !== 'local' || !payload.name || !payload.path) return;
    if (st.loading) return;
    try {
      const landed = await sftpUpload(st.serverId, payload.path, st.cwd);
      toast('已上传 ' + payload.name, 'success');
      focusAfterRefresh(st, joinRemote(st.cwd, landed));
    } catch (err) {
      toast(String(err), 'error');
    }
  });
}

/* ---------- 右键菜单：打开 / 复制 / 剪切 / 粘贴 / 重命名 / 删除 / 下载 ---------- */

/** 编辑器可编辑约束：>5MB 或常见二进制扩展名 → 不可在编辑器中打开（与后端 sftp_read 同一大小约束） */
const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'avif',
  'avi', 'mp4', 'mkv', 'mov', 'wmv', 'flv', 'webm', 'mpg', 'mpeg', 'm4v',
  'mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma',
  'zip', '7z', 'rar', 'gz', 'tar', 'bz2', 'xz', 'zst', 'iso', 'dmg',
  'exe', 'dll', 'so', 'dylib', 'bin', 'dat', 'class', 'jar', 'wasm', 'pyc', 'obj', 'o', 'lib', 'a',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'db', 'sqlite', 'mdb',
]);

/** 目录恒可打开（进入）；文件须文本且 ≤5MB */
function isTextEditable(it: RemoteEntry): boolean {
  if (it.isDir) return true;
  if (it.size > MAX_EDIT_BYTES) return false;
  const ext = (it.name.split('.').pop() ?? '').toLowerCase();
  return !BINARY_EXT.has(ext);
}

function joinRemote(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir + '/' + name;
}

/** 在文档编辑器中打开远端文本文件（保存走 sftp_write，见 editor.ts） */
function openRemoteFile(st: SftpTabState, it: RemoteEntry): void {
  openTab({
    id: `editor:sftp:${st.serverId}:${it.path}`,
    type: 'editor',
    title: it.name,
    data: { sftp: { serverId: st.serverId, remotePath: it.path }, name: it.name },
  });
}

/** 粘贴到当前目录：本地源 → 上传（剪切=上传+删本地）；远端源同会话 → 复制/移动。多条目逐项处理。 */
async function pasteRemote(st: SftpTabState): Promise<void> {
  const clip = getClip();
  if (!clip) return;
  let focusPath: string | null = null;
  try {
    if (clip.source === 'remote') {
      if (clip.serverId !== st.serverId) {
        toast('暂不支持跨服务器粘贴', 'error');
        return;
      }
      if (clip.mode === 'cut') {
        if (clip.items.every((i) => parentOf(i.path) === st.cwd)) return; // 同目录剪切 = 无操作
        if (clip.items.some((i) => i.isDir && st.cwd.startsWith(i.path + '/'))) {
          toast('不能把目录粘贴到它自身内部', 'error');
          return;
        }
        for (const it of clip.items) {
          await sftpRename(st.serverId, it.path, joinRemote(st.cwd, it.name));
        }
        focusPath = joinRemote(st.cwd, clip.items[0].name);
        clearClip();
      } else {
        let landed: string | null = null;
        for (const it of clip.items) {
          landed = await sftpCopy(st.serverId, it.path, st.cwd);
        }
        if (landed) focusPath = joinRemote(st.cwd, landed);
      }
    } else {
      let landed: string | null = null;
      for (const it of clip.items) {
        landed = await sftpUpload(st.serverId, it.path, st.cwd);
      }
      if (landed) focusPath = joinRemote(st.cwd, landed);
      if (clip.mode === 'cut') {
        // 跨文件系统剪切 = 拷贝 + 删除本地源
        for (const it of clip.items) await fsDelete(it.path);
        clearClip();
      }
    }
    toast('粘贴成功', 'success');
    st.sel.clear();
    if (focusPath) focusAfterRefresh(st, focusPath);
    else void loadDir(st);
  } catch (err) {
    toast(String(err), 'error');
  }
}

/** 同目录剪切粘贴 = 无操作（共享给条目与空白区菜单） */
function pasteDisabled(st: SftpTabState): boolean {
  const clip = getClip();
  if (!clip) return true;
  if (clip.source === 'remote' && clip.mode === 'cut' && clip.serverId === st.serverId) {
    return clip.items.every((i) => parentOf(i.path) === st.cwd);
  }
  return false;
}

/** 删除一个或多个远端条目（框选多选时循环删除） */
async function deleteRemote(st: SftpTabState, items: RemoteEntry[]): Promise<void> {
  const ok = await confirmDialog({
    title: items.length > 1 ? `删除 ${items.length} 个项目` : '删除',
    message: items.length > 1
      ? `确定删除选中的 ${items.length} 个远端项目吗？`
      : `确定删除远端「${items[0].path}」吗？`,
    danger: true,
    okText: '删除',
  });
  if (!ok) return;
  try {
    for (const it of items) await sftpDelete(st.serverId, it.path);
    toast(items.length > 1 ? `已删除 ${items.length} 个项目` : `已删除 ${items[0].name}`, 'success');
    st.sel.clear();
    void loadDir(st);
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 压缩 / 解压 / 备份 / chmod（ssh_exec 直执：命令与输出进 debug 日志） ---------- */

/** POSIX shell 单引号引用（路径含空格/引号时防断词与注入） */
function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** 常见压缩包扩展名（右键「解压」仅对这些条目显示） */
function isArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.zip');
}

/** 条目图标：目录/文件/压缩包分色 + 填充，比线框更醒目（颜色走 icon() 的 opts，不进 CSS 以便随图标库统一调整） */
function entryIcon(it: RemoteEntry): string {
  if (it.isDir) return iconSvg('folder', { stroke: '#2563eb', fill: '#93c5fd' });
  if (isArchive(it.name)) return iconSvg('archive', { stroke: '#c2410c', fill: '#fdba74' });
  return iconSvg('file', { stroke: '#64748b', fill: '#e2e8f0' });
}

/** 多行文本逐行写入 debug 日志（dbg 一行一条，避免长输出挤成单条）。 */
function dbgLines(prefix: string, text: string): void {
  if (!text) return;
  for (const line of text.split('\n')) dbg(`${prefix} ${line}`);
}

/**
 * 直执远端命令（待优化 5）：走后端 ssh_exec 复用 SSH 连接执行单条命令（不再起迷你终端，
 * 规避登录时序竞态）；命令行 / stdout / stderr / 退出码写入 debug 日志，
 * 完成后按退出码 toast 并刷新目录（成功且给了 focusPath 时聚焦落地条目）。
 */
async function runRemoteCommand(st: SftpTabState, command: string, doneToast: string, focusPath: string | null): Promise<void> {
  dbg(`sftp ssh_exec ${st.serverId} $ ${command}`);
  let res: SshExecResult;
  try {
    res = await sshExec(st.serverId, command);
  } catch (err) {
    dbg(`sftp ssh_exec ${st.serverId} 失败: ${String(err)}`);
    toast(String(err), 'error');
    st.sel.clear();
    void loadDir(st);
    return;
  }
  dbgLines(`sftp ssh_exec ${st.serverId} stdout`, res.stdout);
  dbgLines(`sftp ssh_exec ${st.serverId} stderr`, res.stderr);
  dbg(`sftp ssh_exec ${st.serverId} exit=${res.code ?? 'null(超时中断或无退出码)'}`);
  const success = res.code === 0;
  toast(
    success ? doneToast : `${doneToast}失败，详见 debug 日志`,
    success ? 'success' : 'error',
  );
  st.sel.clear();
  if (success && focusPath) focusAfterRefresh(st, focusPath);
  else void loadDir(st);
}

/** 压缩选中条目为 tgz：单选目录/文件 → `名称.tgz`；多选 → 弹输入框指定包名（重名自动改名）。 */
async function compressRemote(st: SftpTabState, items: RemoteEntry[]): Promise<void> {
  const parent = parentOf(items[0].path);
  let want: string | null = null;
  if (items.length === 1) {
    // 单选：直接取条目名（压缩包再压时去掉原扩展名防 .tgz.tgz）
    let base = items[0].name;
    const lower = base.toLowerCase();
    if (lower.endsWith('.tar.gz')) base = base.slice(0, -7);
    else if (lower.endsWith('.tgz')) base = base.slice(0, -4);
    want = base + '.tgz';
  } else {
    // 多选：用户指定包名
    want = await promptDialog({
      title: '压缩为 tgz',
      label: `将 ${items.length} 个条目打包，输入压缩包名称：`,
      defaultValue: items[0].name.replace(/\.(tar\.gz|tgz|zip)$/i, '') + '.tgz',
      placeholder: '例如 archive.tgz',
      okText: '压缩',
    });
  }
  if (!want) return; // 取消
  try {
    const dest = await sftpUniqueName(st.serverId, parent, want);
    const names = items.map((i) => shQuote(i.name)).join(' ');
    const cmd = `tar czf ${shQuote(joinRemote(parent, dest))} -C ${shQuote(parent)} ${names}`;
    await runRemoteCommand(st, cmd, `已压缩为 ${dest}`, joinRemote(parent, dest));
  } catch (err) {
    toast(String(err), 'error');
  }
}

/** 解压压缩包到其所在目录：tar.gz/tgz 走 tar，zip 走 unzip。 */
async function extractRemote(st: SftpTabState, it: RemoteEntry): Promise<void> {
  const parent = parentOf(it.path);
  const cmd = it.name.toLowerCase().endsWith('.zip')
    ? `unzip -o ${shQuote(it.path)} -d ${shQuote(parent)}`
    : `tar xzf ${shQuote(it.path)} -C ${shQuote(parent)}`;
  // 聚焦解压产物：通常与压缩包同名（去扩展名）；产物名不同时 applyFocus 静默跳过
  const base = it.name.replace(/\.(tar\.gz|tgz|zip)$/i, '');
  await runRemoteCommand(st, cmd, `已解压 ${it.name}`, joinRemote(parent, base));
}

/** 快速备份：目录压缩为 `名称_bakYYYYMMDD-HHMM.tgz`；文件复制为 `名称_bakYYYYMMDD-HHMM`（保留原扩展名）。
 *  重名经 sftpUniqueName 自动改名；完成后刷新并聚焦备份文件。 */
function backupRemote(st: SftpTabState, item: RemoteEntry): void {
  const parent = parentOf(item.path);
  const now = new Date();
  const p = (v: number) => String(v).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
  void (async () => {
    try {
      const dest = await sftpUniqueName(st.serverId, parent, `${item.name}_bak${stamp}${item.isDir ? '.tgz' : ''}`);
      const cmd = item.isDir
        ? `tar czf ${shQuote(joinRemote(parent, dest))} -C ${shQuote(parent)} ${shQuote(item.name)}`
        : `cp ${shQuote(item.path)} ${shQuote(joinRemote(parent, dest))}`;
      await runRemoteCommand(st, cmd, `备份完成：${dest}`, joinRemote(parent, dest));
    } catch (err) {
      toast(String(err), 'error');
    }
  })();
}

/* ---------- 属性 / 权限设置 / 赋予可执行权限（chmod 经 ssh_exec 直执，完成后刷新） ---------- */

/** 权限位 → 3 位八进制串（如 644）；mode 为 null 时显示 — */
function modeOct(mode: number | null): string {
  if (mode === null) return '—';
  return (mode & 0o777).toString(8).padStart(3, '0');
}

/** 权限位 → 符号串（如 rwxr-xr-x）；mode 为 null 时显示 — */
function modeSymbolic(mode: number | null): string {
  if (mode === null) return '—';
  const bits = mode & 0o777;
  const chars = 'rwxrwxrwx';
  let s = '';
  for (let i = 8; i >= 0; i--) s += (bits >> i) & 1 ? chars[8 - i] : '-';
  return s;
}

/** 「属性」对话框：sftp_stat 取远端属性，展示名称/类型/大小/修改时间/权限/链接目标/完整路径。 */
function showSftpProperties(st: SftpTabState, it: RemoteEntry): void {
  void (async () => {
    let stat: FsStat;
    try {
      stat = await sftpStat(st.serverId, it.path);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal sf-prop-modal">
        <div class="modal-head">
          <h3>属性</h3>
          <button class="icon-btn" title="关闭">${iconSvg('x')}</button>
        </div>
        <div class="modal-body">
          <div class="sf-prop-title">
            <span class="sf-prop-icon">${iconSvg(stat.linkTarget ? 'link' : stat.isDir ? 'folder' : 'file')}</span>
            <span class="sf-prop-name"></span>
          </div>
          <div class="sf-prop-rows"></div>
        </div>
        <div class="modal-foot">
          <button class="btn primary" data-act="close">关闭</button>
        </div>
      </div>`;
    const rows = mask.querySelector('.sf-prop-rows')!;
    const defs: Array<[string, string]> = [
      ['type', '类型'],
      ['size', '大小'],
      ['mtime', '修改时间'],
      ['mode', '权限'],
      ['link', '链接目标'],
      ['path', '完整路径'],
    ];
    for (const [key, label] of defs) {
      const row = document.createElement('div');
      row.className = 'sf-prop-row';
      row.dataset.key = key;
      const lab = document.createElement('span');
      lab.className = 'sf-prop-label';
      lab.textContent = label;
      const val = document.createElement('span');
      val.className = 'sf-prop-value mono';
      row.append(lab, val);
      rows.appendChild(row);
    }
    const close = (): void => {
      mask.classList.remove('open');
      setTimeout(() => mask.remove(), 160);
    };
    mask.querySelector('[data-act=close]')!.addEventListener('click', close);
    mask.querySelector('.modal-head .icon-btn')!.addEventListener('click', close);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    const values: Record<string, HTMLElement> = {};
    mask.querySelectorAll<HTMLElement>('.sf-prop-row').forEach((row) => {
      values[row.dataset.key!] = row.querySelector('.sf-prop-value')!;
    });
    mask.querySelector('.sf-prop-name')!.textContent = stat.name;
    values.type.textContent = stat.linkTarget ? '符号链接' : stat.isDir ? '目录' : '文件';
    values.size.textContent = stat.isDir ? '—' : fmtSize(stat.size);
    values.mtime.textContent = fmtTime(stat.mtime);
    values.mode.textContent = stat.mode !== null ? `${modeSymbolic(stat.mode)} (${modeOct(stat.mode)})` : '—';
    mask.querySelectorAll<HTMLElement>('.sf-prop-row[data-key="link"]').forEach((row) => {
      row.classList.toggle('hidden', !stat.linkTarget);
    });
    values.link.textContent = stat.linkTarget ?? '—';
    values.path.textContent = stat.path;
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('open'));
  })();
}

/** 「权限设置」对话框：输入 3 位八进制权限（预填当前值，可用预设快捷填充），确认后经 ssh_exec 直执 chmod。 */
function showChmodDialog(st: SftpTabState, it: RemoteEntry): void {
  void (async () => {
    let stat: FsStat;
    try {
      stat = await sftpStat(st.serverId, it.path);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    const current = stat.mode !== null ? modeOct(stat.mode) : '755';
    const presets = [
      ['755', '目录默认'], ['644', '文件默认'], ['700', '仅自己'],
      ['600', '仅自己读写'], ['750', '同组读执行'], ['777', '全部读写执行'],
    ];
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML = `
      <div class="modal sf-chmod-modal">
        <div class="modal-head"><h3>权限设置</h3></div>
        <div class="modal-body">
          <div class="sf-chmod-path mono"></div>
          <label class="sf-chmod-label">八进制权限（3 位，0-7）：</label>
          <input class="input sf-chmod-input" type="text" maxlength="3" spellcheck="false" inputmode="numeric">
          <div class="sf-chmod-chips"></div>
          <div class="sf-chmod-error"></div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok">确定</button>
        </div>
      </div>`;
    const input = mask.querySelector('.sf-chmod-input') as HTMLInputElement;
    const errEl = mask.querySelector('.sf-chmod-error') as HTMLElement;
    const chips = mask.querySelector('.sf-chmod-chips')!;
    const setInput = (v: string): void => {
      input.value = v;
      errEl.textContent = '';
      chips.querySelectorAll('.sf-chmod-chip').forEach((c) => {
        c.classList.toggle('active', c.textContent === v);
      });
    };
    for (const [mode, hint] of presets) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'sf-chmod-chip' + (mode === current ? ' active' : '');
      chip.textContent = mode;
      chip.title = hint;
      chip.addEventListener('click', () => setInput(mode));
      chips.appendChild(chip);
    }
    input.value = current;
    input.title = '如 755 表示 rwxr-xr-x';
    mask.querySelector('.sf-chmod-path')!.textContent = it.path;
    const close = (): void => {
      mask.classList.remove('open');
      setTimeout(() => mask.remove(), 160);
    };
    const submit = (): void => {
      const mode = input.value.trim();
      if (!/^[0-7]{3}$/.test(mode)) {
        errEl.textContent = '请输入 3 位八进制数（每位 0-7），例如 755';
        return;
      }
      close();
      // 绝对路径更稳（ssh_exec 不依赖会话 cwd，路径不受影响）
      void runRemoteCommand(st, `chmod ${mode} -- ${shQuote(it.path)}`, `已将 ${it.name} 权限设置为 ${mode}`, it.path);
    };
    mask.querySelector('[data-act=cancel]')!.addEventListener('click', close);
    mask.querySelector('[data-act=ok]')!.addEventListener('click', submit);
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') submit();
      else if (e.key === 'Escape') close();
    });
    document.body.appendChild(mask);
    requestAnimationFrame(() => {
      mask.classList.add('open');
      input.focus();
      input.select();
    });
  })();
}

/** 赋予可执行权限（仅文件）：经 ssh_exec 直执 chmod +x，完成后刷新并 toast。 */
function makeExecutable(st: SftpTabState, it: RemoteEntry): void {
  void runRemoteCommand(st, `chmod +x -- ${shQuote(it.path)}`, `已赋予 ${it.name} 可执行权限`, it.path);
}

/** 在当前目录新建空文件/目录（空白右键菜单）：输入名称 → 创建 → 聚焦新条目 */
async function createRemote(st: SftpTabState, isDir: boolean): Promise<void> {
  const name = await promptDialog({
    title: isDir ? '新建目录' : '新建文件',
    placeholder: isDir ? '目录名' : '文件名',
    okText: '创建',
  });
  if (!name) return; // 取消
  try {
    await sftpCreate(st.serverId, joinRemote(st.cwd, name), isDir);
    toast(`已创建 ${name}`, 'success');
    focusAfterRefresh(st, joinRemote(st.cwd, name));
  } catch (err) {
    toast(String(err), 'error');
  }
}

/** 下载到本地项目目录，随后切到文件资源管理器并定位高亮落地文件 */
async function downloadRemote(st: SftpTabState, it: RemoteEntry): Promise<void> {
  const projectPath = Workbench.state.project?.path;
  if (!projectPath) {
    toast('项目未设置本地目录，无法下载', 'error');
    return;
  }
  try {
    const dest = await sftpDownload(st.serverId, it.path, projectPath);
    toast(`已下载 ${it.name} 到本地`, 'success');
    Workbench.switchPanel?.('explorer');
    void revealLocalPath(dest);
  } catch (err) {
    toast(String(err), 'error');
  }
}

/** 行内重命名（grid/table 共用：替换名称元素为输入框，回车提交 / Esc 还原） */
function startRemoteRename(st: SftpTabState, it: RemoteEntry, row: HTMLElement): void {
  const nameEl = row.querySelector('.sf-name, .nm') as HTMLElement | null;
  if (!nameEl) return;
  const input = document.createElement('input');
  input.className = 'input sf-rename';
  input.value = it.name;
  nameEl.replaceWith(input);
  input.focus();
  const dot = it.name.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : it.name.length);
  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (!commit || !newName || newName === it.name) {
      renderView(st);
      return;
    }
    if (/[\\/]/.test(newName)) {
      toast('名称不能包含路径分隔符', 'error');
      renderView(st);
      return;
    }
    void sftpRename(st.serverId, it.path, joinRemote(parentOf(it.path), newName))
      .then(() => {
        toast(`已重命名为 ${newName}`, 'success');
        focusAfterRefresh(st, joinRemote(parentOf(it.path), newName));
      })
      .catch((err: unknown) => {
        toast(String(err), 'error');
        renderView(st);
      });
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

/** 单选/多选共用的条目菜单：右键的条目不在选中集时先单选它，再按选中集提供操作 */
function showEntryMenu(x: number, y: number, st: SftpTabState, it: RemoteEntry, row: HTMLElement): void {
  if (!st.sel.has(it.path)) {
    st.sel.clear();
    st.sel.add(it.path);
    renderView(st);
  }
  const items = st.renderEntries.filter((e) => st.sel.has(e.path));
  const multi = items.length > 1;
  const first = items[0];
  const editable = !multi && isTextEditable(first);
  showContextMenu(x, y, [
    {
      label: '打开', iconName: first.isDir ? 'folder' : 'file',
      disabled: multi || !editable,
      disabledTip: multi ? '多选时不可用' : (first.isDir ? undefined : '二进制文件或超过 5MB，无法在编辑器中打开'),
      action: () => { if (first.isDir) goTo(st, first.path, true); else openRemoteFile(st, first); },
    },
    'sep',
    {
      label: '复制', iconName: 'copy',
      action: () => {
        setClip({
          source: 'remote', serverId: st.serverId,
          items: items.map((e) => ({ path: e.path, name: e.name, isDir: e.isDir })),
          mode: 'copy',
        });
        renderView(st);
      },
    },
    {
      label: '剪切', iconName: 'scissors',
      action: () => {
        setClip({
          source: 'remote', serverId: st.serverId,
          items: items.map((e) => ({ path: e.path, name: e.name, isDir: e.isDir })),
          mode: 'cut',
        });
        renderView(st);
      },
    },
    {
      label: '粘贴', iconName: 'clipboard', disabled: pasteDisabled(st),
      action: () => void pasteRemote(st),
    },
    'sep',
    {
      label: '压缩为 tgz', iconName: 'package',
      action: () => void compressRemote(st, items),
    },
    // 快速备份：目录压缩为 tgz、文件直接复制，完成后刷新并聚焦备份文件；多选时不可用
    ...(!multi ? [
      {
        label: '快速备份', iconName: 'history',
        action: () => backupRemote(st, first),
      },
    ] as CtxItem[] : []),
    ...(items.length === 1 && isArchive(items[0].name) ? [
      {
        label: '解压到当前目录', iconName: 'folderOpen',
        action: () => void extractRemote(st, items[0]),
      },
    ] as CtxItem[] : []),
    'sep',
    {
      label: '属性', iconName: 'info', disabled: multi, disabledTip: '多选时不可用',
      action: () => showSftpProperties(st, first),
    },
    {
      label: '权限设置', iconName: 'lock', disabled: multi, disabledTip: '多选时不可用',
      action: () => void showChmodDialog(st, first),
    },
    // 赋予可执行权限仅文件可用（与 Xshell / 常规 FTP 客户端一致：目录权限走「权限设置」）
    ...(!multi && !first.isDir ? [
      {
        label: '赋予可执行权限', iconName: 'zap',
        action: () => makeExecutable(st, first),
      },
    ] as CtxItem[] : []),
    'sep',
    {
      label: '重命名', iconName: 'pencil', disabled: multi, disabledTip: '多选时不可用',
      action: () => startRemoteRename(st, first, row),
    },
    { label: '删除', iconName: 'trash', danger: true, action: () => void deleteRemote(st, items) },
    'sep',
    {
      label: '下载', iconName: 'download', disabled: multi, disabledTip: '多选时不可用',
      action: () => void downloadRemote(st, first),
    },
  ]);
}

/** 容器空白区右键：打开终端（新开 SSH 终端标签，自动 cd 到当前目录）+ 粘贴到当前目录 */
function bindRootContextMenu(root: HTMLElement, st: SftpTabState): void {
  root.addEventListener('contextmenu', (e) => {
    if ((e.target as HTMLElement).closest('.sf-item, .sf-table tr')) return; // 条目行已自行处理
    e.preventDefault();
    if (st.sel.size) {
      st.sel.clear(); // 空白处右键 = 取消框选
      renderView(st);
    }
    showContextMenu(e.clientX, e.clientY, [
      {
        label: '新建文件', iconName: 'filePlus',
        action: () => void createRemote(st, false),
      },
      {
        label: '新建目录', iconName: 'folderPlus',
        action: () => void createRemote(st, true),
      },
      'sep',
      {
        label: '打开终端', iconName: 'terminal',
        action: () => {
          // 直执改造后不再起迷你终端（时序问题）：新开 SSH 终端标签并自动 cd 到当前目录
          // （term_create 的 cwd 契约，见 term.rs create_ssh）
          void (async () => {
            const name = (await getState().catch(() => null))
              ?.servers.find((s) => s.id === st.serverId)?.name ?? 'SSH';
            openTab({
              id: `term:${st.serverId}:${uid('t')}`,
              type: 'terminal',
              title: name,
              data: { kind: 'ssh', serverId: st.serverId, cwd: st.cwd },
            });
          })();
        },
      },
      'sep',
      {
        label: '粘贴', iconName: 'clipboard', disabled: pasteDisabled(st),
        action: () => void pasteRemote(st),
      },
    ]);
  });
}

/** 剪贴板中剪切(非复制)的条目：半透明标记（粘贴成功后 renderView 自动清除） */
function markClipped(el: HTMLElement, st: SftpTabState, it: RemoteEntry): void {
  const clip = getClip();
  if (clip && clip.source === 'remote' && clip.mode === 'cut'
    && clip.serverId === st.serverId && clip.items.some((c) => c.path === it.path)) {
    el.classList.add('sf-cut');
  }
}

/* ---------- 视图渲染 ---------- */
function buildToolbar(st: SftpTabState): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'sf-toolbar';
  const mk = (cls: string, html: string, title: string, fn: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.className = 'icon-btn ' + cls;
    b.innerHTML = html;
    b.title = title;
    b.addEventListener('click', fn);
    return b;
  };
  const jump = (): void => {
    // ~ / ~/xxx 展开为远端 home
    const raw = st.els.pathInput.value.trim();
    const expanded = raw === '~' ? st.home : raw.startsWith('~/') ? st.home + raw.slice(1) : raw;
    const p = normalizeRemotePath(expanded);
    if (p === null) {
      st.els.pathInput.value = st.cwd;
      return;
    }
    // 先失焦：renderView 只在输入框非聚焦时同步 value，否则用户输入会被覆盖
    st.els.pathInput.blur();
    goTo(st, p, true);
  };
  st.els.backBtn = mk('', icon('arrowLeft'), '后退', () => goBack(st));
  st.els.fwdBtn = mk('', icon('arrowRight'), '前进', () => goForward(st));
  st.els.upBtn = mk('', icon('arrowUp'), '上一级', () => goTo(st, parentOf(st.cwd), true));
  st.els.homeBtn = mk('', icon('home'), '回到主目录 ~', () => goTo(st, st.home, true));
  st.els.rootBtn = mk('', icon('slash'), '根目录 /', () => goTo(st, '/', true));
  const input = document.createElement('input');
  input.className = 'input sf-path';
  input.type = 'text';
  input.spellcheck = false;
  input.placeholder = '输入远程路径，回车跳转';
  input.title = '远程路径（自动归一化 . / ..），回车或点击「跳转」进入';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') jump();
    else if (e.key === 'Escape') {
      input.value = st.cwd;
      input.blur();
    }
  });
  const goBtn = document.createElement('button');
  goBtn.className = 'btn sf-go';
  goBtn.textContent = '跳转';
  goBtn.title = '跳转到输入框中的路径';
  goBtn.addEventListener('click', jump);
  st.els.pathInput = input;
  st.els.goBtn = goBtn;
  st.els.gridBtn = mk('sf-view', icon('grid'), '平铺视图', () => setViewMode('grid'));
  st.els.listBtn = mk('sf-view', icon('list'), '列表视图', () => setViewMode('list'));
  bar.appendChild(st.els.backBtn);
  bar.appendChild(st.els.fwdBtn);
  bar.appendChild(st.els.upBtn);
  bar.appendChild(st.els.homeBtn);
  bar.appendChild(st.els.rootBtn);
  bar.appendChild(input);
  bar.appendChild(goBtn);
  bar.appendChild(st.els.gridBtn);
  bar.appendChild(st.els.listBtn);
  return bar;
}

function buildGrid(body: HTMLElement, st: SftpTabState, entries: RemoteEntry[]): void {
  const grid = document.createElement('div');
  grid.className = 'sf-grid';
  entries.forEach((it) => {
    const el = document.createElement('div');
    el.className = 'sf-item';
    el.title = it.path + (it.isDir ? '' : ' · ' + fmtSize(it.size) + ' · ' + fmtTime(it.mtime));
    if (st.sel.has(it.path)) el.classList.add('sel');
    el.dataset.path = it.path; // 框选相交判定用
    const iconEl = document.createElement('div');
    iconEl.className = 'sf-icon';
    iconEl.innerHTML = entryIcon(it);
    const name = document.createElement('div');
    name.className = 'sf-name';
    name.textContent = it.name;
    el.appendChild(iconEl);
    el.appendChild(name);
    el.addEventListener('click', () => {
      // 单击仅聚焦（与本地资源管理器统一）；目录进入/文件打开由双击承担。
      // 直接改类不重建 DOM：重建会打断双击事件的冒泡路径（dblclick 目标被移除）
      st.sel.clear();
      st.sel.add(it.path);
      (document.activeElement as HTMLElement | null)?.blur?.();
      grid.querySelectorAll('.sf-item.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    });
    el.addEventListener('dblclick', () => {
      if (it.isDir) goTo(st, it.path, true);
      else if (isTextEditable(it)) openRemoteFile(st, it);
      else toast('二进制文件或超过 5MB，无法在编辑器中打开', 'error');
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showEntryMenu(e.clientX, e.clientY, st, it, el);
    });
    markClipped(el, st, it);
    bindDrag(el, it, st);
    grid.appendChild(el);
  });
  body.appendChild(grid);
  bindGridMarquee(grid, st);
}

/** 平铺视图拖拽框选：fixed 选框随鼠标更新，松开时与条目矩形求交加入选中集。
 *  mousedown 绑在 grid 父容器（.sf-body）上——起点可能落在 body 的 padding 空白区。
 *  监听器模块级单套：renderView 重建 grid 前先 teardown，避免旧闭包把选中集清空。 */
let marqueeTeardown: (() => void) | null = null;

function bindGridMarquee(grid: HTMLElement, st: SftpTabState): void {
  marqueeTeardown?.();
  const scope = grid.parentElement ?? grid;
  let startX = 0;
  let startY = 0;
  let dragging = false;
  let moved = false;
  let box: HTMLDivElement | null = null;
  const onDown = (e: MouseEvent): void => {
    if (e.button !== 0 || st.loading) return;
    startX = e.clientX;
    startY = e.clientY;
    dragging = true;
    moved = false;
  };
  const onMove = (e: MouseEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    if (!box) {
      box = document.createElement('div');
      box.className = 'sf-marquee';
      document.body.appendChild(box);
    }
    moved = true;
    box.style.left = Math.min(startX, e.clientX) + 'px';
    box.style.top = Math.min(startY, e.clientY) + 'px';
    box.style.width = Math.abs(dx) + 'px';
    box.style.height = Math.abs(dy) + 'px';
  };
  const onUp = (e: MouseEvent): void => {
    if (!dragging) return;
    dragging = false;
    if (box) { box.remove(); box = null; }
    if (!moved) {
      // 纯点击：空白清空选择；条目点击由条目 click 处理
      if (!(e.target as HTMLElement).closest('.sf-item') && st.sel.size) {
        st.sel.clear();
        renderView(st);
      }
      return;
    }
    const x1 = Math.min(startX, e.clientX);
    const y1 = Math.min(startY, e.clientY);
    const x2 = Math.max(startX, e.clientX);
    const y2 = Math.max(startY, e.clientY);
    const next = new Set<string>();
    grid.querySelectorAll<HTMLElement>('.sf-item').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) {
        const p = el.dataset.path;
        if (p) next.add(p);
      }
    });
    st.sel = next;
    renderView(st);
  };
  scope.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  marqueeTeardown = () => {
    scope.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    if (box) { box.remove(); box = null; }
    dragging = false;
  };
}
function buildTable(body: HTMLElement, st: SftpTabState, entries: RemoteEntry[]): void {
  const table = document.createElement('table');
  table.className = 'sf-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  [['名称'], ['大小', 'right'], ['修改时间']].forEach(([label, align]) => {
    const th = document.createElement('th');
    th.textContent = label;
    if (align === 'right') th.style.textAlign = 'right';
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  const tbody = document.createElement('tbody');
  entries.forEach((it) => {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    const span = document.createElement('span');
    span.className = 'sf-t-name';
    const ic = document.createElement('span');
    ic.innerHTML = entryIcon(it);
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = it.name;
    span.appendChild(ic);
    span.appendChild(nm);
    tdName.appendChild(span);
    const tdSize = document.createElement('td');
    tdSize.className = 'sf-t-size';
    tdSize.textContent = it.isDir ? '—' : fmtSize(it.size);
    const tdTime = document.createElement('td');
    tdTime.className = 'sf-t-time';
    tdTime.textContent = fmtTime(it.mtime);
    tr.appendChild(tdName);
    tr.appendChild(tdSize);
    tr.appendChild(tdTime);
    tr.title = it.path;
    tr.dataset.path = it.path; // 聚焦滚动与框选判定共用
    if (st.sel.has(it.path)) tr.classList.add('sel');
    tr.addEventListener('click', () => {
      // 列表视图单击仅聚焦（双击进入/打开）。
      // 直接改类不重建 DOM：重建会打断双击事件的冒泡路径（dblclick 目标被移除）
      st.sel.clear();
      st.sel.add(it.path);
      (document.activeElement as HTMLElement | null)?.blur?.();
      tbody.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'));
      tr.classList.add('sel');
    });
    tr.addEventListener('dblclick', () => {
      if (it.isDir) goTo(st, it.path, true);
      else if (isTextEditable(it)) openRemoteFile(st, it);
      else toast('二进制文件或超过 5MB，无法在编辑器中打开', 'error');
    });
    tr.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showEntryMenu(e.clientX, e.clientY, st, it, tr);
    });
    markClipped(tr, st, it);
    bindDrag(tr, it, st);
    tbody.appendChild(tr);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  body.appendChild(table);
}

function renderView(st: SftpTabState): void {
  // 先拆除上一次渲染的框选监听：列表视图下若残留 grid 的 window mouseup，
  // 会把「点击空白清空选择+重建」误判到表格上，破坏双击事件合成
  marqueeTeardown?.();
  marqueeTeardown = null;
  st.els.backBtn.disabled = st.back.length === 0;
  st.els.fwdBtn.disabled = st.fwd.length === 0;
  st.els.upBtn.disabled = st.cwd === '/';
  st.els.homeBtn.disabled = st.cwd === st.home;
  st.els.rootBtn.disabled = st.cwd === '/';
  st.els.homeBtn.title = '回到主目录 ' + st.home;
  st.els.gridBtn.classList.toggle('active', viewMode === 'grid');
  st.els.listBtn.classList.toggle('active', viewMode === 'list');
  // 输入框聚焦编辑中不覆盖用户输入；其余时刻与当前路径保持同步
  if (document.activeElement !== st.els.pathInput) st.els.pathInput.value = st.cwd;

  const body = st.els.body;
  body.textContent = '';
  if (st.loading) {
    body.appendChild(emptyState('loader', '加载中…'));
    return;
  }
  if (st.error) {
    const box = document.createElement('div');
    box.className = 'sf-error';
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = st.error;
    const retry = document.createElement('button');
    retry.className = 'btn';
    retry.textContent = '重试';
    retry.addEventListener('click', () => void loadDir(st));
    box.appendChild(msg);
    box.appendChild(retry);
    body.appendChild(box);
    return;
  }
  if (!st.entries.length) {
    body.appendChild(emptyState('folder', '目录为空'));
    return;
  }
  const entries: RemoteEntry[] = st.entries.map((e) => ({
    name: e.name,
    path: (st.cwd === '/' ? '' : st.cwd) + '/' + e.name,
    isDir: e.isDir,
    size: e.size,
    mtime: e.mtime,
  }));
  st.renderEntries = entries;
  if (viewMode === 'grid') buildGrid(body, st, entries);
  else buildTable(body, st, entries);
}

/* ---------- 渲染器注册 ---------- */
registerRenderer('sftp', (container, tab) => {
  const st: SftpTabState = {
    serverId: String(tab.data.serverId ?? ''),
    home: '/',
    cwd: '/',
    back: [],
    fwd: [],
    els: {} as SftpEls,
    entries: [],
    loading: true,
    error: '',
    seq: 0,
    sel: new Set<string>(),
    renderEntries: [],
    pendingFocus: null,
  };
  sftpTabs.set(tab.id, st);

  const root = document.createElement('div');
  root.className = 'sf-root';
  root.appendChild(buildToolbar(st));

  const body = document.createElement('div');
  body.className = 'sf-body';
  st.els.body = body;
  root.appendChild(body);

  container.appendChild(root);
  bindDrop(root, st);
  bindRootContextMenu(root, st);
  void initHome(st);

  return {
    getCwd: () => st.cwd,
    refresh: () => void loadDir(st),
    navigate: (p: string) => goTo(st, p, true),
    /** 刷新并聚焦到 cwd 内的落地条目（上传/粘贴后定位用） */
    focus: (name: string) => focusAfterRefresh(st, joinRemote(st.cwd, name)),
  };
});

bus.on('tab-closed', (tab: Tab | null) => {
  if (!tab) return;
  sftpTabs.delete(tab.id);
});

/* ---------- 快捷键：Ctrl+C 复制 / Ctrl+X 剪切 / Ctrl+V 粘贴 / F2 重命名 / Delete 删除 ----------
   仅当激活标签为 SFTP 时生效；路径输入框 / 编辑器等编辑控件聚焦时不劫持。 */
window.addEventListener('keydown', (e) => {
  const tab = getActiveTab();
  if (!tab || tab.type !== 'sftp') return;
  const st = sftpTabs.get(tab.id);
  if (!st || st.loading) return;
  const ae = document.activeElement;
  const typing = ae instanceof HTMLInputElement
    || ae instanceof HTMLTextAreaElement
    || (ae instanceof HTMLElement && ae.isContentEditable);
  if (typing) return;
  const items = st.renderEntries.filter((x) => st.sel.has(x.path));
  if ((e.ctrlKey || e.metaKey) && !e.altKey) {
    const k = e.key.toLowerCase();
    if (k === 'v') {
      // 粘贴不要求有选中（复制后直接 Ctrl+V 的常见场景）
      if (getClip()) {
        e.preventDefault();
        void pasteRemote(st);
      }
      return;
    }
    if (!items.length) return;
    if (k === 'c') {
      e.preventDefault();
      setClip({
        source: 'remote', serverId: st.serverId,
        items: items.map((x) => ({ path: x.path, name: x.name, isDir: x.isDir })),
        mode: 'copy',
      });
      renderView(st);
      return;
    }
    if (k === 'x') {
      e.preventDefault();
      setClip({
        source: 'remote', serverId: st.serverId,
        items: items.map((x) => ({ path: x.path, name: x.name, isDir: x.isDir })),
        mode: 'cut',
      });
      renderView(st);
      return;
    }
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey || !items.length) return;
  if (e.key === 'F2') {
    if (items.length !== 1) return;
    e.preventDefault();
    const row = Array.from(st.els.body.querySelectorAll<HTMLElement>('[data-path]'))
      .find((el) => el.dataset.path === items[0].path);
    if (row) startRemoteRename(st, items[0], row);
    return;
  }
  if (e.key === 'Delete') {
    e.preventDefault();
    void deleteRemote(st, items);
  }
});
