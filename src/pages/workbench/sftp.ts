/**
 * SFTP 标签渲染器 —— 移植自 .proto/workbench-sftp.js，数据源换成真实后端命令。
 * - 每个 tab 独立维护 cwd / history / forward 栈；打开时先解析远端 home（sftp_home）作为初始路径
 * - 顶栏：后退 / 前进 / 上级 / home（~ 主目录）/ 根（/）+ 可编辑路径输入框（回车或「跳转」直达）+ 平铺/列表视图切换
 * - 平铺/列表双视图；单击目录进入、双击文件提示；条目可拖拽（source:'remote' + serverId）
 * - 容器 drop 收 source:'local' → sftp_upload → toast → 刷新
 * - OS 文件拖入（dataTransfer.files）在此面板刻意不接收：系统文件只进本地文件资源管理器
 * - 加载失败：toast 错误原文 + 面板内错误条与「重试」
 */
import './sftp.css';
import type { FsEntry } from '../../types';
import { sftpHome, sftpList, sftpUpload } from '../../api';
import { toast } from '../../ui';
import { bus, registerRenderer, Workbench, type Tab } from './core';
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
  if (path === st.cwd) return;
  if (push) {
    st.back.push(st.cwd);
    st.fwd.length = 0;
  }
  st.cwd = path;
  st.entries = [];
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
      await sftpUpload(st.serverId, payload.path, st.cwd);
      toast('已上传 ' + payload.name, 'success');
      void loadDir(st);
    } catch (err) {
      toast(String(err), 'error');
    }
  });
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
    const iconEl = document.createElement('div');
    iconEl.className = 'sf-icon';
    iconEl.innerHTML = iconSvg(it.isDir ? 'folder' : 'file');
    const name = document.createElement('div');
    name.className = 'sf-name';
    name.textContent = it.name;
    el.appendChild(iconEl);
    el.appendChild(name);
    el.addEventListener('click', () => {
      grid.querySelectorAll('.sf-item').forEach((x) => x.classList.remove('sel'));
      el.classList.add('sel');
      if (it.isDir) goTo(st, it.path, true);
    });
    el.addEventListener('dblclick', () => {
      if (!it.isDir) toast('暂不支持远程编辑');
    });
    bindDrag(el, it, st);
    grid.appendChild(el);
  });
  body.appendChild(grid);
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
    ic.innerHTML = iconSvg(it.isDir ? 'folder' : 'file');
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
    tr.addEventListener('click', () => {
      if (it.isDir) goTo(st, it.path, true);
    });
    tr.addEventListener('dblclick', () => {
      if (!it.isDir) toast('暂不支持远程编辑');
    });
    bindDrag(tr, it, st);
    tbody.appendChild(tr);
  });
  table.appendChild(thead);
  table.appendChild(tbody);
  body.appendChild(table);
}

function renderView(st: SftpTabState): void {
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
  void initHome(st);

  return {
    getCwd: () => st.cwd,
    refresh: () => void loadDir(st),
    navigate: (p: string) => goTo(st, p, true),
  };
});

bus.on('tab-closed', (tab: Tab | null) => {
  if (tab) sftpTabs.delete(tab.id);
});
