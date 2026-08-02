/**
 * SFTP 标签渲染器 —— 移植自 .proto/workbench-sftp.js，数据源换成真实后端命令。
 * - 每个 tab 独立维护 cwd / history / forward 栈；初始路径 '/'（后端 home 语义并入根）
 * - 顶栏：后退 / 前进 / 上级 / home / 根 + 面包屑（每段可点、当前段禁用）+ 平铺/列表视图切换
 * - 平铺/列表双视图；单击目录进入、双击文件提示；条目可拖拽（source:'remote' + serverId）
 * - 容器 drop 收 source:'local' → sftp_upload → toast → 刷新
 * - OS 文件拖入（dataTransfer.files）在此面板刻意不接收：系统文件只进本地文件资源管理器
 * - 加载失败：toast 错误原文 + 面板内错误条与「重试」
 */
import './sftp.css';
import type { FsEntry } from '../../types';
import { sftpList, sftpUpload } from '../../api';
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
  crumbs: HTMLElement;
  gridBtn: HTMLButtonElement;
  listBtn: HTMLButtonElement;
}

interface SftpTabState {
  serverId: string;
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
function buildCrumbs(cwd: string): Array<{ label: string; path: string }> {
  const crumbs = [{ label: '/', path: '/' }];
  if (cwd !== '/') {
    let acc = '';
    for (const seg of cwd.split('/').filter(Boolean)) {
      acc = acc ? acc + '/' + seg : '/' + seg;
      crumbs.push({ label: seg, path: acc });
    }
  }
  return crumbs;
}

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
  st.els.backBtn = mk('', icon('arrowLeft'), '后退', () => goBack(st));
  st.els.fwdBtn = mk('', icon('arrowRight'), '前进', () => goForward(st));
  st.els.upBtn = mk('', icon('arrowUp'), '上一级', () => goTo(st, parentOf(st.cwd), true));
  st.els.homeBtn = mk('', icon('home'), '回到根目录 /', () => goTo(st, '/', true));
  st.els.rootBtn = mk('', icon('slash'), '根目录 /', () => goTo(st, '/', true));
  st.els.crumbs = document.createElement('div');
  st.els.crumbs.className = 'sf-crumb';
  st.els.gridBtn = mk('sf-view', icon('grid'), '平铺视图', () => setViewMode('grid'));
  st.els.listBtn = mk('sf-view', icon('list'), '列表视图', () => setViewMode('list'));
  bar.appendChild(st.els.backBtn);
  bar.appendChild(st.els.fwdBtn);
  bar.appendChild(st.els.upBtn);
  bar.appendChild(st.els.homeBtn);
  bar.appendChild(st.els.rootBtn);
  bar.appendChild(st.els.crumbs);
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
  st.els.gridBtn.classList.toggle('active', viewMode === 'grid');
  st.els.listBtn.classList.toggle('active', viewMode === 'list');

  const crumbs = buildCrumbs(st.cwd);
  const crumbBox = st.els.crumbs;
  crumbBox.textContent = '';
  crumbs.forEach((c, i) => {
    if (i > 0) {
      const sep = document.createElement('span');
      sep.className = 'sf-crumb-sep';
      sep.textContent = '/';
      crumbBox.appendChild(sep);
    }
    const btn = document.createElement('button');
    btn.className = 'sf-crumb-item' + (i === crumbs.length - 1 ? ' cur' : '');
    btn.textContent = c.label;
    if (i < crumbs.length - 1) btn.addEventListener('click', () => goTo(st, c.path, true));
    crumbBox.appendChild(btn);
  });

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
  void loadDir(st);

  return {
    getCwd: () => st.cwd,
    refresh: () => void loadDir(st),
    navigate: (p: string) => goTo(st, p, true),
  };
});

bus.on('tab-closed', (tab: Tab | null) => {
  if (tab) sftpTabs.delete(tab.id);
});
