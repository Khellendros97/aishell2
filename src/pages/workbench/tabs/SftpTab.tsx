/**
 * SFTP 文件传输标签页(React 迁移,整文件替换占位)。
 * 对照 legacy/pages/workbench/sftp.ts(旧原生 TS 渲染器)逐条对齐语义 / DOM 类名 / 文案;
 * 样式复用 src/pages/workbench/sftp.css(此处 import)。
 * 与后端的接口点(src/api.ts):sftp_home / sftp_list / sftp_stat / sftp_upload / sftp_download /
 *   sftp_rename / sftp_copy / sftp_delete / sftp_unique_name / sftp_create / ssh_exec / staging_add,
 *   持久化 set_sftp_history / set_sftp_favorites(路径历史与收藏事实源在 Rust aishell.json)。
 *
 * React 差异(语义对齐 legacy):
 * - keep-alive:组件常驻挂载,active 仅切显隐(由外壳 workbench.css 的 .tab-pane.active 承担);
 *   SSH 会话 / 目录状态(cwd / back / fwd / 历史 / 收藏)在挂载期间持续,卸载才断开清理。
 *   legacy 渲染器对 tab-activated 无任何处理(无激活刷新/聚焦),故不设 useEffect([active]);
 *   快捷键通过 window keydown 在事件时查活跃标签生效,与 legacy 同一语义。
 * - 挂载时 tabApis.set(tab.id, api)(legacy 渲染器返回的 { getCwd, refresh, navigate, focus },
 *   供侧栏「上传到服务器」等外部入口按 tab id 获取),卸载 tabApis.delete;
 * - 旧 Workbench 全局句柄 / bus 改为 stores/workbench.ts 的 useWorkbench / wbHandles / wbEvents /
 *   tabApis:switchPanel → setPanel('explorer')、bus 'staging-changed' → wbEvents.emit、
 *   bus 'tab-closed' → 组件卸载清理(closeHistory + window 监听移除 + tabApis.delete);
 * - 剪贴板(复制/剪切)与本地资源管理器共用 ../clipboard(零 DOM 纯模块);
 *   打开远端文件进编辑器走 EditorTab 导出的 openRemoteFile;下载定位走 sidebar/ExplorerPanel
 *   的 revealLocalPath(该文件由并行子代理创建,契约 (path) => Promise<void>)。
 *
 * 修复的 legacy bug:
 * - legacy 关闭 SFTP 标签时不拆除拖拽框选(marquee)的 window 级 mousemove/mouseup 监听,
 *   残留闭包引用已移除的 DOM;React 卸载清理按归属 tab 拆除(marqueeOwnerId 判定),
 *   且不会误伤其他标签的框选(legacy 模块级单例会)。
 * - 右键「打开终端」legacy 在菜单 action 内才查 getState,失败时 name 回退 'SSH' 但
 *   data.serverId 使用 st.serverId(正确);迁移保持该语义,仅把 Workbench 句柄换 store。
 *
 * 导出签名契约:export function SftpTab({ tab, active }: TabProps),TabProps import 自
 * '../../../stores/workbench'(registry.ts 接线,不得变更)。
 */
import { useEffect, useRef } from 'react';
import '../sftp.css';
import type { FsEntry, FsStat, SftpFavorite, SshExecResult } from '../../../types';
import {
  fsDelete, getState, setSftpFavorites, setSftpHistory, sftpCopy, sftpCreate, sftpDelete, sftpDownload,
  sftpHome, sftpList, sftpRename, sftpStat, sftpUniqueName, sftpUpload, sshExec, stagingAdd,
} from '../../../api';
import { confirmDialog, promptDialog, showContextMenu, toast, uid, type CtxItem } from '../../../ui';
import { dbg } from '../../../debug';
import { icon } from '../../../icons';
import { Icon } from '../../../shared/Icon';
import {
  DND_MIME, getActiveTab, tabApis, useWorkbench, wbEvents, wbHandles, type TabProps,
} from '../../../stores/workbench';
import { clearClip, getClip, setClip } from '../clipboard';
import { openRemoteFile } from './EditorTab';
import { revealLocalPath } from '../sidebar/ExplorerPanel';
import { hideProgress } from '../statusbar-progress';

interface SftpEls {
  body: HTMLElement;
  /** 地址栏包裹层(历史下拉浮层挂载点,绝对定位随它) */
  pathWrap: HTMLElement;
  backBtn: HTMLButtonElement;
  fwdBtn: HTMLButtonElement;
  upBtn: HTMLButtonElement;
  homeBtn: HTMLButtonElement;
  rootBtn: HTMLButtonElement;
  pathInput: HTMLInputElement;
  goBtn: HTMLButtonElement;
  /** 地址栏星按钮(收藏当前路径) */
  starBtn: HTMLButtonElement;
  /** 工具栏搜索按钮 / 搜索输入框 */
  searchBtn: HTMLButtonElement;
  searchInput: HTMLInputElement;
  /** 工具栏收藏夹按钮 / 收藏夹侧边栏 */
  favBtn: HTMLButtonElement;
  favPanel: HTMLElement;
  /** 路径历史下拉浮层(仅展开期间存在) */
  historyBox: HTMLElement | null;
  gridBtn: HTMLButtonElement;
  listBtn: HTMLButtonElement;
}

interface SftpTabState {
  /** 本标签 id(marquee 监听归属判定用;legacy 无此字段,React 卸载清理需要) */
  tabId: string;
  serverId: string;
  /** 远端 home(sftp_home 解析,失败时回退 '/') */
  home: string;
  cwd: string;
  back: string[];
  fwd: string[];
  els: SftpEls;
  entries: FsEntry[];
  loading: boolean;
  error: string;
  seq: number;
  /** 平铺视图框选/单击选中的条目路径集合(目录切换时清空) */
  sel: Set<string>;
  /** 最近一次渲染的带完整远端路径条目(菜单多选操作的数据源) */
  renderEntries: RemoteEntry[];
  /** 下次 loadDir 成功后要聚焦(选中+滚动)的条目路径;不存在则静默跳过 */
  pendingFocus: string | null;
  /** 搜索关键字(即时过滤当前目录,切目录时清空) */
  query: string;
  /** 工具栏搜索输入框是否展开 */
  searchOpen: boolean;
  /** 收藏夹侧边栏是否展开 */
  favOpen: boolean;
  /** 历史下拉展开期间挂的 document mousedown 监听(收起时移除,防泄漏) */
  historyDocHandler: ((e: MouseEvent) => void) | null;
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

/* ---------- 视图状态(模块级,跨标签共享) ---------- */
let viewMode: 'grid' | 'list' = 'grid';
/** 列表视图排序:当前排序列与方向(会话级,不持久化;目录恒在前不受方向影响) */
let sortKey: 'name' | 'mtime' = 'name';
let sortAsc = true;
const sftpTabs = new Map<string, SftpTabState>();

/* ---------- 拖拽框选监听(模块级单套,语义同 legacy:renderView 重建 grid 前先 teardown) ----------
   React 差异:记录归属 tab id,卸载时只拆自己的监听(legacy 关闭标签不拆,残留闭包引用已移除 DOM)。 */
let marqueeTeardown: (() => void) | null = null;
let marqueeOwnerId: string | null = null;

/* ---------- SFTP 持久化数据层(路径历史 / 收藏夹,事实源在 Rust aishell.json) ---------- */
const HISTORY_MAX = 10;
/** serverId → MRU 路径(最新在前);首次需要时从 getState 播种,每 serverId 一次 */
const historyByServer = new Map<string, string[]>();
/** serverId → 收藏条目(path + 标题,按添加顺序) */
const favoritesByServer = new Map<string, SftpFavorite[]>();
const seededHistory = new Set<string>();
const seededFavorites = new Set<string>();
/** 防抖落盘定时器 + 待写集合(多个服务器并发变更也不丢) */
let historySaveTimer: number | null = null;
let favoritesSaveTimer: number | null = null;
const dirtyHistory = new Set<string>();
const dirtyFavorites = new Set<string>();

/** 播种某服务器的路径历史:与本地合并——本地条目(本次会话新访问)在前,磁盘补旧,去重截断 10。
 *  不能用「本地已有则丢弃磁盘」:loadDir 落地即 recordHistory,播种到达时本地几乎必已有数据。 */
function seedHistory(serverId: string): void {
  if (seededHistory.has(serverId)) return;
  seededHistory.add(serverId);
  void getState()
    .then((s) => {
      const disk = s.sftpHistory?.[serverId];
      if (!disk || disk.length === 0) return;
      const local = historyByServer.get(serverId) ?? [];
      const merged = local.slice();
      for (const p of disk) if (!merged.includes(p)) merged.push(p);
      historyByServer.set(serverId, merged.slice(0, HISTORY_MAX));
    })
    .catch(() => { /* 播种失败静默:本次会话历史从空开始,不影响其他功能 */ });
}

/** 播种某服务器的收藏夹:与本地合并(磁盘补进本地未有条目,按 path 去重,保持本地顺序在前),语义同 seedHistory */
function seedFavorites(serverId: string): void {
  if (seededFavorites.has(serverId)) return;
  seededFavorites.add(serverId);
  void getState()
    .then((s) => {
      const disk = s.sftpFavorites?.[serverId];
      if (!disk || disk.length === 0) return;
      const local = favoritesByServer.get(serverId) ?? [];
      const merged = local.slice();
      for (const f of disk) if (!merged.some((m) => m.path === f.path)) merged.push(f);
      favoritesByServer.set(serverId, merged);
      sftpTabs.forEach((st) => { if (st.serverId === serverId) renderView(st); });
    })
    .catch(() => {});
}

function getHistory(serverId: string): string[] {
  seedHistory(serverId);
  return historyByServer.get(serverId) ?? [];
}

function getFavorites(serverId: string): SftpFavorite[] {
  seedFavorites(serverId);
  return favoritesByServer.get(serverId) ?? [];
}

/** 记录一次成功落地的目录访问:MRU 去重(已存在先删再 unshift)+ 截断 10 条,防抖落盘 */
function recordHistory(serverId: string, path: string): void {
  seedHistory(serverId); // 首次访问即触发播种:磁盘旧历史经合并保留,否则本地从空起步会整体覆盖
  const list = (historyByServer.get(serverId) ?? []).filter((p) => p !== path);
  list.unshift(path);
  historyByServer.set(serverId, list.slice(0, HISTORY_MAX));
  dirtyHistory.add(serverId);
  if (historySaveTimer === null) {
    historySaveTimer = window.setTimeout(() => {
      historySaveTimer = null;
      dirtyHistory.forEach((id) => {
        const paths = historyByServer.get(id);
        if (paths) {
          setSftpHistory(id, paths).catch((err: unknown) =>
            console.warn('保存 SFTP 路径历史失败:', err));
        }
      });
      dirtyHistory.clear();
    }, 300);
  }
}

/** 收藏集变更后防抖落盘(fire-and-forget,失败仅 console.warn 不 toast) */
function scheduleFavoritesSave(serverId: string): void {
  dirtyFavorites.add(serverId);
  if (favoritesSaveTimer === null) {
    favoritesSaveTimer = window.setTimeout(() => {
      favoritesSaveTimer = null;
      dirtyFavorites.forEach((id) => {
        const paths = favoritesByServer.get(id);
        if (paths) {
          setSftpFavorites(id, paths).catch((err: unknown) =>
            console.warn('保存 SFTP 收藏夹失败:', err));
        }
      });
      dirtyFavorites.clear();
    }, 300);
  }
}

/* ---------- 格式化 / 路径工具 ---------- */

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

/** 用户输入的远程路径归一化:统一 '/'、折叠重复分隔符、解析 . / ..,非法输入返回 null */
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

/* ---------- 导航(异步加载,seq 防竞态:仅最新一次请求可落地) ---------- */
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
    // 目录落地成功即记录访问(后退/前进/直接跳转/初始 home 一视同仁;刷新同路径去重后置顶)
    recordHistory(st.serverId, st.cwd);
  } catch (err) {
    if (seq !== st.seq) return;
    st.loading = false;
    st.error = String(err);
    toast(String(err), 'error');
  }
  renderView(st);
  applyFocus(st);
}

/** 刷新后聚焦:选中目标条目并滚动到可见;目标不存在(改名失败/被删)时静默跳过。 */
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

/** 标记下次刷新后聚焦的目标路径(粘贴/重命名/压缩/上传等操作的统一入口) */
function focusAfterRefresh(st: SftpTabState, path: string): void {
  st.pendingFocus = path;
  void loadDir(st);
}

/** 打开标签先解析远端 home:成功则初始定位 home,失败回退 '/' 并 toast(home 语义仍可用) */
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
    // 同路径 = 手动刷新(跳转按钮/重复双击目录),不产生历史
    void loadDir(st);
    return;
  }
  // 切换目录:清空搜索并收起搜索框 / 历史下拉(goBack/goForward 复用本函数语义)
  clearSearch(st);
  closeHistory(st);
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
    e.dataTransfer.setData(DND_MIME, JSON.stringify({
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
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes(DND_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });
  root.addEventListener('drop', async (e) => {
    e.preventDefault();
    // 只收 DND_MIME(应用内拖拽);OS 文件拖入(无 DND_MIME)一律忽略——产品禁令
    const raw = e.dataTransfer ? e.dataTransfer.getData(DND_MIME) : '';
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

/* ---------- 右键菜单:打开 / 复制 / 剪切 / 粘贴 / 重命名 / 删除 / 下载 ---------- */

/** 编辑器可编辑约束:>5MB 或常见二进制扩展名 → 不可在编辑器中打开(与后端 sftp_read 同一大小约束) */
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

/** 目录恒可打开(进入);文件须文本且 ≤5MB */
function isTextEditable(it: RemoteEntry): boolean {
  if (it.isDir) return true;
  if (it.size > MAX_EDIT_BYTES) return false;
  const ext = (it.name.split('.').pop() ?? '').toLowerCase();
  return !BINARY_EXT.has(ext);
}

function joinRemote(dir: string, name: string): string {
  return dir === '/' ? '/' + name : dir + '/' + name;
}

/** 在文档编辑器中打开远端文本文件(保存走 sftp_write,见 EditorTab.tsx 的 openRemoteFile) */
function openRemoteInEditor(st: SftpTabState, it: RemoteEntry): void {
  openRemoteFile(st.serverId, it.path, it.name, { size: it.size, mtime: it.mtime });
}

/** 粘贴到当前目录:本地源 → 上传(剪切=上传+删本地);远端源同会话 → 复制/移动。多条目逐项处理。 */
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

/** 同目录剪切粘贴 = 无操作(共享给条目与空白区菜单) */
function pasteDisabled(st: SftpTabState): boolean {
  const clip = getClip();
  if (!clip) return true;
  if (clip.source === 'remote' && clip.mode === 'cut' && clip.serverId === st.serverId) {
    return clip.items.every((i) => parentOf(i.path) === st.cwd);
  }
  return false;
}

/** 删除一个或多个远端条目(框选多选时循环删除) */
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

/* ---------- 压缩 / 解压 / 备份 / chmod(ssh_exec 直执:命令与输出进 debug 日志) ---------- */

/** POSIX shell 单引号引用(路径含空格/引号时防断词与注入) */
function shQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** 常见压缩包扩展名(右键「解压」仅对这些条目显示) */
function isArchive(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.zip');
}

/** 条目图标:目录/文件/压缩包分色 + 填充,比线框更醒目(颜色走 icon() 的 opts,不进 CSS 以便随图标库统一调整) */
function entryIcon(it: RemoteEntry): string {
  if (it.isDir) return icon('folder', { stroke: '#2563eb', fill: '#93c5fd' });
  if (isArchive(it.name)) return icon('archive', { stroke: '#c2410c', fill: '#fdba74' });
  return icon('file', { stroke: '#64748b', fill: '#e2e8f0' });
}

/** 多行文本逐行写入 debug 日志(dbg 一行一条,避免长输出挤成单条)。 */
function dbgLines(prefix: string, text: string): void {
  if (!text) return;
  for (const line of text.split('\n')) dbg(`${prefix} ${line}`);
}

/**
 * 直执远端命令(待优化 5):走后端 ssh_exec 复用 SSH 连接执行单条命令(不再起迷你终端,
 * 规避登录时序竞态);命令行 / stdout / stderr / 退出码写入 debug 日志,
 * 完成后按退出码 toast 并刷新目录(成功且给了 focusPath 时聚焦落地条目)。
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

/** 压缩选中条目为 tgz:单选目录/文件 → `名称.tgz`;多选 → 弹输入框指定包名(重名自动改名)。 */
async function compressRemote(st: SftpTabState, items: RemoteEntry[]): Promise<void> {
  const parent = parentOf(items[0].path);
  let want: string | null = null;
  if (items.length === 1) {
    // 单选:直接取条目名(压缩包再压时去掉原扩展名防 .tgz.tgz)
    let base = items[0].name;
    const lower = base.toLowerCase();
    if (lower.endsWith('.tar.gz')) base = base.slice(0, -7);
    else if (lower.endsWith('.tgz')) base = base.slice(0, -4);
    want = base + '.tgz';
  } else {
    // 多选:用户指定包名
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

/** 解压压缩包到其所在目录:tar.gz/tgz 走 tar,zip 走 unzip。 */
async function extractRemote(st: SftpTabState, it: RemoteEntry): Promise<void> {
  const parent = parentOf(it.path);
  const cmd = it.name.toLowerCase().endsWith('.zip')
    ? `unzip -o ${shQuote(it.path)} -d ${shQuote(parent)}`
    : `tar xzf ${shQuote(it.path)} -C ${shQuote(parent)}`;
  // 聚焦解压产物:通常与压缩包同名(去扩展名);产物名不同时 applyFocus 静默跳过
  const base = it.name.replace(/\.(tar\.gz|tgz|zip)$/i, '');
  await runRemoteCommand(st, cmd, `已解压 ${it.name}`, joinRemote(parent, base));
}

/** 快速备份:目录压缩为 `名称_bakYYYYMMDD-HHMM.tgz`;文件复制为 `名称_bakYYYYMMDD-HHMM`(保留原扩展名)。
 *  重名经 sftpUniqueName 自动改名;完成后刷新并聚焦备份文件。 */
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

/* ---------- 属性 / 权限设置 / 赋予可执行权限(chmod 经 ssh_exec 直执,完成后刷新) ---------- */

/** 权限位 → 3 位八进制串(如 644);mode 为 null 时显示 — */
function modeOct(mode: number | null): string {
  if (mode === null) return '—';
  return (mode & 0o777).toString(8).padStart(3, '0');
}

/** 权限位 → 符号串(如 rwxr-xr-x);mode 为 null 时显示 — */
function modeSymbolic(mode: number | null): string {
  if (mode === null) return '—';
  const bits = mode & 0o777;
  const chars = 'rwxrwxrwx';
  let s = '';
  for (let i = 8; i >= 0; i--) s += (bits >> i) & 1 ? chars[8 - i] : '-';
  return s;
}

/** 「属性」对话框:sftp_stat 取远端属性,展示名称/类型/大小/修改时间/权限/链接目标/完整路径。 */
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
          <button class="icon-btn" title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="sf-prop-title">
            <span class="sf-prop-icon">${icon(stat.linkTarget ? 'link' : stat.isDir ? 'folder' : 'file')}</span>
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

/** 「权限设置」对话框:输入 3 位八进制权限(预填当前值,可用预设快捷填充),确认后经 ssh_exec 直执 chmod。 */
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
      // 绝对路径更稳(ssh_exec 不依赖会话 cwd,路径不受影响)
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

/** 赋予可执行权限(仅文件):经 ssh_exec 直执 chmod +x,完成后刷新并 toast。 */
function makeExecutable(st: SftpTabState, it: RemoteEntry): void {
  void runRemoteCommand(st, `chmod +x -- ${shQuote(it.path)}`, `已赋予 ${it.name} 可执行权限`, it.path);
}

/** 在当前目录新建空文件/目录(空白右键菜单):输入名称 → 创建 → 聚焦新条目 */
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

/** 下载到本地项目目录,随后切到文件资源管理器并定位高亮落地文件 */
async function downloadRemote(st: SftpTabState, it: RemoteEntry): Promise<void> {
  const projectPath = useWorkbench.getState().project?.path;
  if (!projectPath) {
    toast('项目未设置本地目录，无法下载', 'error');
    return;
  }
  try {
    const dest = await sftpDownload(st.serverId, it.path, projectPath);
    toast(`已下载 ${it.name} 到本地`, 'success');
    useWorkbench.getState().setPanel('explorer');
    void revealLocalPath(dest);
  } catch (err) {
    toast(String(err), 'error');
  }
}

/** 行内重命名(grid/table 共用:替换名称元素为输入框,回车提交 / Esc 还原) */
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

/** 暂存远端文件/目录到 AI 会话暂存区（目录递归暂存全部文件；供 diff / 审批 / 修改前备份使用） */
async function stageRemoteItems(st: SftpTabState, items: RemoteEntry[]): Promise<void> {
  const projectId = useWorkbench.getState().project?.id;
  const sessionId = wbHandles.ai?.currentSessionId?.();
  if (!projectId || !sessionId) {
    toast('AI 会话尚未加载，无法暂存', 'error');
    return;
  }
  // 目录递归暂存较慢：底边栏显示进度（纯事件驱动——后端 add_path 遍历前即发 walk 事件，
  // 逐文件 stage、结束 done 自动收起；不额外占位，避免与事件槽并存成双条）
  const progKey = `staging:${projectId}:${sessionId}`;
  let total = 0;
  try {
    for (const entry of items) {
      const staged = await stagingAdd(projectId, sessionId, st.serverId, entry.path);
      total += staged.length;
    }
    toast(
      items.length === 1
        ? `已暂存 ${total} 个文件（${items[0].name}）`
        : `已暂存 ${items.length} 项（共 ${total} 个文件）`,
      'success',
    );
    wbEvents.emit('staging-changed');
  } catch (err) {
    toast(String(err), 'error');
  } finally {
    // 兜底：操作中途失败无 done 事件时收起残留槽（正常路径 done 已移除，此处无操作）
    hideProgress(progKey);
  }
}

/** 单选/多选共用的条目菜单:右键的条目不在选中集时先单选它,再按选中集提供操作 */
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
      action: () => { if (first.isDir) goTo(st, first.path, true); else openRemoteInEditor(st, first); },
    },
    // 把远端文件/目录路径引用加入 AI 输入框(@file:文件名 / @path:目录名 标签,发送时带服务器上下文)
    {
      label: '添加到对话', iconName: 'chatPlus', disabled: multi, disabledTip: '多选时不可用',
      action: () => addSftpPathToChat(st, first.path, first.isDir),
    },
    'sep',
    {
      label: '暂存', iconName: 'history',
      disabledTip: undefined,
      action: () => void stageRemoteItems(st, items),
    },
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
    // 快速备份:目录压缩为 tgz、文件直接复制,完成后刷新并聚焦备份文件;多选时不可用
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
    // 赋予可执行权限仅文件可用(与 Xshell / 常规 FTP 客户端一致:目录权限走「权限设置」)
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

/** 把远端文件/目录路径引用加入 AI 输入框(@file:文件名 / @path:目录名 标签,发送时带服务器上下文);
 *  见 core.ts AiHandle.addPathRef;AI 面板未挂载时提示 */
function addSftpPathToChat(st: SftpTabState, path: string, isDir: boolean): void {
  if (wbHandles.ai?.addPathRef) {
    wbHandles.ai.addPathRef({ path, isDir, serverId: st.serverId });
  } else {
    toast('AI 面板尚未就绪');
  }
}

/** 容器空白区右键:打开终端(新开 SSH 终端标签,自动 cd 到当前目录)+ 粘贴到当前目录 */
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
        label: '把当前目录添加到对话', iconName: 'chatPlus',
        action: () => addSftpPathToChat(st, st.cwd, true),
      },
      {
        label: '打开终端', iconName: 'terminal',
        action: () => {
          // 直执改造后不再起迷你终端(时序问题):新开 SSH 终端标签并自动 cd 到当前目录
          // (term_create 的 cwd 契约,见 term.rs create_ssh)
          void (async () => {
            const name = (await getState().catch(() => null))
              ?.servers.find((s) => s.id === st.serverId)?.name ?? 'SSH';
            useWorkbench.getState().openTab({
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

/** 剪贴板中剪切(非复制)的条目:半透明标记(粘贴成功后 renderView 自动清除) */
function markClipped(el: HTMLElement, st: SftpTabState, it: RemoteEntry): void {
  const clip = getClip();
  if (clip && clip.source === 'remote' && clip.mode === 'cut'
    && clip.serverId === st.serverId && clip.items.some((c) => c.path === it.path)) {
    el.classList.add('sf-cut');
  }
}

/* ---------- 路径历史下拉(地址栏聚焦展开,mousedown 跳转先于 blur) ---------- */

function showHistory(st: SftpTabState): void {
  closeHistory(st);
  const list = getHistory(st.serverId);
  if (!list.length) return;
  const box = document.createElement('div');
  box.className = 'sf-history';
  list.forEach((path) => {
    const item = document.createElement('div');
    item.className = 'sf-history-item' + (path === st.cwd ? ' current' : '');
    item.textContent = path;
    item.title = path;
    // mousedown 先于 blur 触发:preventDefault 保住输入框焦点,避免 blur 关闭下拉后收不到点击
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      closeHistory(st);
      st.els.pathInput.blur();
      goTo(st, path, true);
    });
    box.appendChild(item);
  });
  st.els.historyBox = box;
  st.els.pathWrap.appendChild(box);
  const onDoc = (e: MouseEvent): void => {
    // 点击浮层与输入框之外 → 收起(输入框自身点击不关:focus 已展开)
    const t = e.target as Node;
    if (!box.contains(t) && !st.els.pathInput.contains(t)) closeHistory(st);
  };
  st.historyDocHandler = onDoc;
  document.addEventListener('mousedown', onDoc);
}

/** 收起历史下拉并移除 document 级监听(幂等;tab 关闭时也调用防泄漏) */
function closeHistory(st: SftpTabState): void {
  if (st.historyDocHandler) {
    document.removeEventListener('mousedown', st.historyDocHandler);
    st.historyDocHandler = null;
  }
  st.els.historyBox?.remove();
  st.els.historyBox = null;
}

/* ---------- 搜索(工具栏展开输入框,即时过滤当前目录) ---------- */

/** 收起搜索框并清空关键字(DOM 与状态同步;renderView 亦会按状态补同步) */
function clearSearch(st: SftpTabState): void {
  st.query = '';
  st.searchOpen = false;
  st.els.searchInput.value = '';
  st.els.searchInput.classList.remove('sf-search-open');
  st.els.searchBtn.classList.remove('active');
}

/** 搜索匹配:query 含 `*` / `?` 时按 glob 整名匹配(`*` → 任意串、`?` → 单字符,
 *  其余正则元字符转义,不区分大小写);不含通配符时维持子串包含匹配。 */
function matchEntry(name: string, query: string): boolean {
  if (query.includes('*') || query.includes('?')) {
    // 先转义正则元字符(* ? 除外),再展开通配符;整体锚定整名
    const re = new RegExp('^' + query.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
    return re.test(name);
  }
  return name.toLowerCase().includes(query.toLowerCase());
}

function setSearchOpen(st: SftpTabState, open: boolean): void {
  if (open) {
    st.searchOpen = true;
    st.els.searchBtn.classList.add('active');
    st.els.searchInput.classList.add('sf-search-open');
    st.els.searchInput.focus();
  } else {
    clearSearch(st);
  }
}

/* ---------- 收藏夹(星按钮 + 右侧边栏) ---------- */

function basenameOf(path: string): string {
  return path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);
}

/** 星按钮:收藏 / 取消收藏当前路径。收藏时先弹窗让用户编辑标题(默认目录名称),
 *  防同名目录(如多台服务器的 etc/log)在收藏夹里无法区分;取消收藏不变。 */
function toggleFavorite(st: SftpTabState): void {
  const list = getFavorites(st.serverId);
  if (list.some((f) => f.path === st.cwd)) {
    // 已收藏 → 取消
    favoritesByServer.set(st.serverId, list.filter((f) => f.path !== st.cwd));
    scheduleFavoritesSave(st.serverId);
    renderView(st);
    return;
  }
  // 未收藏 → 弹窗编辑标题;取消则不收藏
  void promptDialog({
    title: '收藏目录',
    label: `标题（默认取目录名称，可自定义以区分同名目录）· 路径：${st.cwd}`,
    defaultValue: basenameOf(st.cwd),
    okText: '收藏',
    allowPath: true,
  }).then((title) => {
    if (title === null) return;
    const t = title.trim() || basenameOf(st.cwd);
    favoritesByServer.set(st.serverId, [...getFavorites(st.serverId), { path: st.cwd, title: t }]);
    scheduleFavoritesSave(st.serverId);
    renderView(st); // 星按钮态 + 侧边栏列表(开着时)一并刷新
  });
}

/** 侧边栏 ✕:从收藏夹移除指定路径 */
function removeFavorite(st: SftpTabState, path: string): void {
  favoritesByServer.set(st.serverId, getFavorites(st.serverId).filter((f) => f.path !== path));
  scheduleFavoritesSave(st.serverId);
  renderView(st);
}

function setFavOpen(st: SftpTabState, open: boolean): void {
  st.favOpen = open;
  st.els.favPanel.hidden = !open;
  st.els.favBtn.classList.toggle('active', open);
  if (open) renderFavList(st);
}

/** 重渲收藏夹侧边栏列表(打开时调用;收藏集变化时若侧栏开着也重渲) */
function renderFavList(st: SftpTabState): void {
  const panel = st.els.favPanel;
  panel.textContent = '';
  const head = document.createElement('div');
  head.className = 'sf-fav-head';
  const title = document.createElement('span');
  title.textContent = '收藏夹';
  const close = document.createElement('button');
  close.className = 'icon-btn sf-fav-close';
  close.innerHTML = icon('x');
  close.title = '关闭收藏夹';
  close.addEventListener('click', () => setFavOpen(st, false));
  head.appendChild(title);
  head.appendChild(close);
  panel.appendChild(head);
  const list = getFavorites(st.serverId);
  if (!list.length) {
    panel.appendChild(emptyState('star', '暂无收藏'));
    return;
  }
  const ul = document.createElement('div');
  ul.className = 'sf-fav-list';
  list.forEach((fav) => {
    const { path, title } = fav;
    const item = document.createElement('div');
    item.className = 'sf-fav-item' + (path === st.cwd ? ' current' : '');
    item.title = path; // 悬浮提示完整路径
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = title;
    item.appendChild(nm);
    const sub = document.createElement('span');
    sub.className = 'sub';
    sub.textContent = path;
    item.appendChild(sub);
    const rm = document.createElement('button');
    rm.className = 'icon-btn sf-fav-rm';
    rm.innerHTML = icon('x');
    rm.title = '取消收藏';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      removeFavorite(st, path);
    });
    item.appendChild(rm);
    item.addEventListener('click', () => goTo(st, path, true));
    ul.appendChild(item);
  });
  panel.appendChild(ul);
}

/* ---------- 视图渲染 ---------- */

/** 工具栏按钮/输入框的交互接线(legacy buildToolbar 的 DOM 创建部分改为 JSX 骨架,这里只挂监听) */
function wireToolbar(st: SftpTabState): void {
  const jump = (): void => {
    // ~ / ~/xxx 展开为远端 home
    const raw = st.els.pathInput.value.trim();
    const expanded = raw === '~' ? st.home : raw.startsWith('~/') ? st.home + raw.slice(1) : raw;
    const p = normalizeRemotePath(expanded);
    if (p === null) {
      st.els.pathInput.value = st.cwd;
      return;
    }
    // 先失焦:renderView 只在输入框非聚焦时同步 value,否则用户输入会被覆盖
    st.els.pathInput.blur();
    goTo(st, p, true);
  };
  st.els.backBtn.addEventListener('click', () => goBack(st));
  st.els.fwdBtn.addEventListener('click', () => goForward(st));
  st.els.upBtn.addEventListener('click', () => goTo(st, parentOf(st.cwd), true));
  st.els.homeBtn.addEventListener('click', () => goTo(st, st.home, true));
  st.els.rootBtn.addEventListener('click', () => goTo(st, '/', true));
  st.els.pathInput.addEventListener('focus', () => showHistory(st));
  st.els.pathInput.addEventListener('blur', () => closeHistory(st));
  st.els.pathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') jump();
    else if (e.key === 'Escape') {
      st.els.pathInput.value = st.cwd;
      st.els.pathInput.blur();
    }
  });
  st.els.starBtn.addEventListener('click', () => toggleFavorite(st));
  st.els.goBtn.addEventListener('click', jump);
  st.els.gridBtn.addEventListener('click', () => setViewMode('grid'));
  st.els.listBtn.addEventListener('click', () => setViewMode('list'));
  st.els.favBtn.addEventListener('click', () => setFavOpen(st, !st.favOpen));
  st.els.searchBtn.addEventListener('click', () => setSearchOpen(st, !st.searchOpen));
  st.els.searchInput.addEventListener('input', () => {
    st.query = st.els.searchInput.value;
    renderView(st);
  });
  st.els.searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') clearSearch(st);
  });
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
      // 单击仅聚焦(与本地资源管理器统一);目录进入/文件打开由双击承担。
      // 直接改类不重建 DOM:重建会打断双击事件的冒泡路径(dblclick 目标被移除)
      st.sel.clear();
      st.sel.add(it.path);
      (document.activeElement as HTMLElement | null)?.blur?.();
      grid.querySelectorAll('.sf-item.sel').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
    });
    el.addEventListener('dblclick', () => {
      if (it.isDir) goTo(st, it.path, true);
      else if (isTextEditable(it)) openRemoteInEditor(st, it);
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

/**
 * 平铺视图拖拽框选:fixed 选框随鼠标更新,松开时与条目矩形求交加入选中集。
 *  mousedown 绑在 grid 父容器(.sf-body)上——起点可能落在 body 的 padding 空白区。
 *  监听器模块级单套:renderView 重建 grid 前先 teardown,避免旧闭包把选中集清空。
 *  React 差异:记录归属 tab id(marqueeOwnerId),卸载时只拆自己的监听。
 */
function bindGridMarquee(grid: HTMLElement, st: SftpTabState): void {
  marqueeTeardown?.();
  marqueeOwnerId = st.tabId;
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
      // 纯点击:空白清空选择;条目点击由条目 click 处理
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
    marqueeOwnerId = null;
  };
}

/** 列表视图排序:目录恒在前(不受方向影响),组内按排序列比较 */
function sortedEntries(entries: RemoteEntry[]): RemoteEntry[] {
  const arr = entries.slice();
  arr.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const d = sortKey === 'name'
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : a.mtime - b.mtime;
    return sortAsc ? d : -d;
  });
  return arr;
}

function buildTable(body: HTMLElement, st: SftpTabState, entries: RemoteEntry[]): void {
  const table = document.createElement('table');
  table.className = 'sf-table';
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  // 可排序表头:名称 / 修改时间(大小列不参与);同列点击取反方向,换列重置升序
  const mkTh = (label: string, key: 'name' | 'mtime' | null, align?: string): HTMLTableCellElement => {
    const th = document.createElement('th');
    th.textContent = label;
    if (align === 'right') th.style.textAlign = 'right';
    if (key) {
      th.className = 'sf-sortable';
      if (sortKey === key) {
        th.classList.add('sf-sort-active');
        const ind = document.createElement('span');
        ind.className = 'sf-sort-ind';
        ind.innerHTML = icon(sortAsc ? 'arrowUp' : 'arrowDown');
        th.appendChild(ind);
      }
      th.addEventListener('click', () => {
        if (sortKey === key) sortAsc = !sortAsc;
        else { sortKey = key; sortAsc = true; }
        renderView(st);
      });
    }
    return th;
  };
  headRow.appendChild(mkTh('名称', 'name'));
  headRow.appendChild(mkTh('大小', null, 'right'));
  headRow.appendChild(mkTh('修改时间', 'mtime'));
  thead.appendChild(headRow);
  const tbody = document.createElement('tbody');
  sortedEntries(entries).forEach((it) => {
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
      // 列表视图单击仅聚焦(双击进入/打开)。
      // 直接改类不重建 DOM:重建会打断双击事件的冒泡路径(dblclick 目标被移除)
      st.sel.clear();
      st.sel.add(it.path);
      (document.activeElement as HTMLElement | null)?.blur?.();
      tbody.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'));
      tr.classList.add('sel');
    });
    tr.addEventListener('dblclick', () => {
      if (it.isDir) goTo(st, it.path, true);
      else if (isTextEditable(it)) openRemoteInEditor(st, it);
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
  // 先拆除上一次渲染的框选监听:列表视图下若残留 grid 的 window mouseup,
  // 会把「点击空白清空选择+重建」误判到表格上,破坏双击事件合成
  marqueeTeardown?.();
  marqueeTeardown = null;
  marqueeOwnerId = null;
  st.els.backBtn.disabled = st.back.length === 0;
  st.els.fwdBtn.disabled = st.fwd.length === 0;
  st.els.upBtn.disabled = st.cwd === '/';
  st.els.homeBtn.disabled = st.cwd === st.home;
  st.els.rootBtn.disabled = st.cwd === '/';
  st.els.homeBtn.title = '回到主目录 ' + st.home;
  st.els.gridBtn.classList.toggle('active', viewMode === 'grid');
  st.els.listBtn.classList.toggle('active', viewMode === 'list');
  // 搜索框 / 收藏夹按钮与侧边栏状态同步(导航清空或按钮点击后保持一致)
  st.els.searchBtn.classList.toggle('active', st.searchOpen);
  st.els.searchInput.classList.toggle('sf-search-open', st.searchOpen);
  st.els.favBtn.classList.toggle('active', st.favOpen);
  st.els.favPanel.hidden = !st.favOpen;
  const isFav = getFavorites(st.serverId).some((f) => f.path === st.cwd);
  st.els.starBtn.classList.toggle('active', isFav);
  st.els.starBtn.title = isFav ? '取消收藏' : '收藏当前路径';
  if (st.favOpen) renderFavList(st);
  // 输入框聚焦编辑中不覆盖用户输入;其余时刻与当前路径保持同步
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
  const entries: RemoteEntry[] = st.entries.map((e) => ({
    name: e.name,
    path: (st.cwd === '/' ? '' : st.cwd) + '/' + e.name,
    isDir: e.isDir,
    size: e.size,
    mtime: e.mtime,
  }));
  st.renderEntries = entries;
  // 搜索过滤:名称按 matchEntry(子串或 glob 通配,大小写不敏感),仅影响展示;renderEntries 保持全量(菜单数据源)
  const q = st.query.trim();
  const filtered = q ? entries.filter((e) => matchEntry(e.name, q)) : entries;
  if (!filtered.length) {
    body.appendChild(emptyState(q ? 'search' : 'folder', q ? '无匹配条目' : '目录为空'));
    return;
  }
  if (viewMode === 'grid') buildGrid(body, st, filtered);
  else buildTable(body, st, filtered);
}

/* ---------- 组件 ----------
   挂载 = 渲染器创建(解析远端 home → 首屏加载),卸载 = tab 关闭(断开 SSH 会话由 SshManager
   引用计数兜底,本组件只负责自身监听/注册表清理);keep-alive 下 active 仅切显隐,
   legacy 对 tab-activated 无任何处理,故不设 useEffect([active])。 */
export function SftpTab({ tab, active: _active }: TabProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const pathWrapRef = useRef<HTMLDivElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const backBtnRef = useRef<HTMLButtonElement>(null);
  const fwdBtnRef = useRef<HTMLButtonElement>(null);
  const upBtnRef = useRef<HTMLButtonElement>(null);
  const homeBtnRef = useRef<HTMLButtonElement>(null);
  const rootBtnRef = useRef<HTMLButtonElement>(null);
  const goBtnRef = useRef<HTMLButtonElement>(null);
  const starBtnRef = useRef<HTMLButtonElement>(null);
  const searchBtnRef = useRef<HTMLButtonElement>(null);
  const favBtnRef = useRef<HTMLButtonElement>(null);
  const gridBtnRef = useRef<HTMLButtonElement>(null);
  const listBtnRef = useRef<HTMLButtonElement>(null);
  const favPanelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    const body = bodyRef.current;
    const pathWrap = pathWrapRef.current;
    const pathInput = pathInputRef.current;
    const searchInput = searchInputRef.current;
    const backBtn = backBtnRef.current;
    const fwdBtn = fwdBtnRef.current;
    const upBtn = upBtnRef.current;
    const homeBtn = homeBtnRef.current;
    const rootBtn = rootBtnRef.current;
    const goBtn = goBtnRef.current;
    const starBtn = starBtnRef.current;
    const searchBtn = searchBtnRef.current;
    const favBtn = favBtnRef.current;
    const gridBtn = gridBtnRef.current;
    const listBtn = listBtnRef.current;
    const favPanel = favPanelRef.current;
    if (!root || !body || !pathWrap || !pathInput || !searchInput || !backBtn || !fwdBtn
      || !upBtn || !homeBtn || !rootBtn || !goBtn || !starBtn || !searchBtn || !favBtn
      || !gridBtn || !listBtn || !favPanel) return;

    const st: SftpTabState = {
      tabId: tab.id,
      serverId: String(tab.data.serverId ?? ''),
      home: '/',
      cwd: '/',
      back: [],
      fwd: [],
      els: {
        body, pathWrap, backBtn, fwdBtn, upBtn, homeBtn, rootBtn, pathInput, goBtn,
        starBtn, searchBtn, searchInput, favBtn, favPanel, gridBtn, listBtn,
        historyBox: null,
      },
      entries: [],
      loading: true,
      error: '',
      seq: 0,
      sel: new Set<string>(),
      renderEntries: [],
      pendingFocus: null,
      query: '',
      searchOpen: false,
      favOpen: false,
      historyDocHandler: null,
    };
    sftpTabs.set(tab.id, st);

    wireToolbar(st);
    // 侧边栏右键不冒泡到容器菜单(新建/粘贴等动作只对目录区有意义)
    favPanel.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    bindDrop(root, st);
    bindRootContextMenu(root, st);
    void initHome(st);

    /* 命令式句柄注册(legacy 渲染器返回的 api,供侧栏「上传到服务器」等外部入口按 tab id 获取) */
    tabApis.set(tab.id, {
      getCwd: () => st.cwd,
      refresh: () => void loadDir(st),
      navigate: (p: string) => goTo(st, p, true),
      /** 刷新并聚焦到 cwd 内的落地条目(上传/粘贴后定位用) */
      focus: (name: string) => focusAfterRefresh(st, joinRemote(st.cwd, name)),
    });

    /* 快捷键:Ctrl+C 复制 / Ctrl+X 剪切 / Ctrl+V 粘贴 / F2 重命名 / Delete 删除
       仅当本标签为激活标签时生效;路径输入框 / 编辑器等编辑控件聚焦时不劫持。 */
    const onKey = (e: KeyboardEvent): void => {
      const activeTab = getActiveTab(useWorkbench.getState());
      if (!activeTab || activeTab.id !== tab.id || activeTab.type !== 'sftp') return;
      if (st.loading) return;
      const ae = document.activeElement;
      const typing = ae instanceof HTMLInputElement
        || ae instanceof HTMLTextAreaElement
        || (ae instanceof HTMLElement && ae.isContentEditable);
      if (typing) return;
      const items = st.renderEntries.filter((x) => st.sel.has(x.path));
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 'v') {
          // 粘贴不要求有选中(复制后直接 Ctrl+V 的常见场景)
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
    };
    window.addEventListener('keydown', onKey);

    return () => {
      /* 卸载(tab 关闭):移除 window 快捷键与历史下拉的 document 级监听、按归属拆除框选
         监听(legacy 不拆,残留闭包引用已移除 DOM)、注销命令式句柄与状态表。 */
      window.removeEventListener('keydown', onKey);
      if (marqueeOwnerId === tab.id) {
        marqueeTeardown?.();
        marqueeTeardown = null;
        marqueeOwnerId = null;
      }
      closeHistory(st);
      sftpTabs.delete(tab.id);
      tabApis.delete(tab.id);
    };
    // tab.id 与 tab.data 在标签存活期内稳定,仅挂载一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="sf-root" ref={rootRef}>
      <div className="sf-toolbar">
        <button ref={backBtnRef} className="icon-btn" title="后退"><Icon name="arrowLeft" /></button>
        <button ref={fwdBtnRef} className="icon-btn" title="前进"><Icon name="arrowRight" /></button>
        <button ref={upBtnRef} className="icon-btn" title="上一级"><Icon name="arrowUp" /></button>
        <button ref={homeBtnRef} className="icon-btn" title="回到主目录 ~"><Icon name="home" /></button>
        <button ref={rootBtnRef} className="icon-btn" title="根目录 /"><Icon name="slash" /></button>
        {/* 地址栏包一层相对定位容器:路径历史下拉浮层(.sf-history)定位随它 */}
        <div className="sf-path-wrap" ref={pathWrapRef}>
          <input
            ref={pathInputRef}
            className="input sf-path"
            type="text"
            spellCheck={false}
            placeholder="输入远程路径，回车跳转"
            title="远程路径（自动归一化 . / ..），回车或点击「跳转」进入；聚焦显示最近访问历史"
          />
          {/* 收藏当前路径星按钮:absolute 定位在地址栏输入框内部右端(浏览器 URL 栏式),active 态 = 已收藏 */}
          <button ref={starBtnRef} className="icon-btn sf-star" title="收藏当前路径"><Icon name="star" /></button>
        </div>
        <button ref={goBtnRef} className="btn sf-go" title="跳转到输入框中的路径">跳转</button>
        <button ref={gridBtnRef} className="icon-btn sf-view" title="平铺视图"><Icon name="grid" /></button>
        <button ref={listBtnRef} className="icon-btn sf-view" title="列表视图"><Icon name="list" /></button>
        {/* 收藏夹侧边栏开关(工具栏右端,视图按钮旁;active 态 = 侧边栏展开) */}
        <button ref={favBtnRef} className="icon-btn sf-fav-toggle" title="收藏夹"><Icon name="star" /></button>
        {/* 搜索按钮 + 搜索输入框(工具栏最右;展开时 focus,收起时隐藏) */}
        <button ref={searchBtnRef} className="icon-btn sf-search-toggle" title="搜索当前目录"><Icon name="search" /></button>
        <input
          ref={searchInputRef}
          className="input sf-search"
          type="text"
          spellCheck={false}
          placeholder="搜索当前目录，支持 *.log 通配"
          title="按名称过滤当前目录（大小写不敏感）；含 * 或 ? 时按通配整名匹配，如 *.log；Esc 关闭"
        />
      </div>
      {/* 主行 = 目录区 + 收藏夹侧边栏(默认隐藏) */}
      <div className="sf-main">
        <div className="sf-body" ref={bodyRef} />
        <aside className="sf-fav" ref={favPanelRef} hidden />
      </div>
    </div>
  );
}
