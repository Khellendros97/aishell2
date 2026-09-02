/**
 * 内置浏览器标签页引擎(命令式,React 薄壳 BrowserTab.tsx 挂载)。无 .proto 对照(全新功能)。
 * 与后端的接口点:
 * - 命令:browser_ensure / set_rect / set_visible / navigate / back / forward / reload /
 *   set_inspect / open_devtools / close_view(全部带 viewId,src/api.ts 封装,Rust browser.rs);
 *   地址栏历史 browser_history_add / browser_history_list(无 viewId,持久化在
 *   aishell.json browserHistory——store.rs record_browser_history 合并去重,MRU 上限 200);
 * - 事件:browser:event(url / title / element / ai-navigate / new-window,均带 viewId)。
 * 多页面模型:工作台浏览器标签页(固定 id 'browser' 单实例)内部维护多个「页面」,
 * 每页对应 Rust 侧一个子 webview(label = browser-<viewId>),首次导航才懒创建,
 * 关闭页面经 close_view 释放;页面状态(地址/标题/检查模式)Rust 侧持有,前端模块级
 * 镜像跨挂载保留(同 explorer 模式:标签关闭再打开不丢)。
 * 右侧标签页侧边栏默认折叠(窄轨:仅页面图标 + 新建/展开按钮);展开后显示标题列表。
 * 本引擎职责:
 * - 工具栏 UI(后退/前进/刷新/地址栏/打开本地 HTML/检查元素/开发者工具,作用于活跃页面);
 * - 标签页侧边栏图标:优先站点 favicon(子 webview 注入脚本探测 link[rel~=icon],
 *   经 kind=favicon 事件回传;加载失败回落默认地球),仅内存镜像不持久化,重开标签时
 *   browser_ensure 返回的 favicon 字段直接恢复;
 * - 活跃页面容器 rect 同步(ResizeObserver + window resize,逻辑坐标与窗口 1:1);
 * - 显隐合成:页面活跃 && 标签激活 && 工作台可见 && 无全屏遮罩(.modal-mask/.ctx-menu 挂
 *   body 直下)&& 已导航 才显示——子 webview 永远浮在主 webview 之上,遮罩出现时必须让位;
 *   非活跃页面一律隐藏。
 * - 检查模式开关;element 事件 → wbHandles.ai.addBrowserRef(chip 引用,发送时展开);
 * - 地址栏历史:导航/标题事件防抖上报后端;地址栏聚焦展开最近记录(最多 8 条),
 *   输入按子串过滤(URL/标题,大小写不敏感),↑↓ 选择 / Enter 打开 / Esc 关闭 / 点击打开;
 *   下拉打开期间隐藏全部页面 webview(原生表面永远盖住 DOM,须让其让位,与遮罩避让同机制);
 * - 页面增删/切换(关闭最后一页自动补一页空白页)。
 * 挂载契约:每次挂载完整初始化 DOM/监听/观察,清理函数完整回收;引擎状态跨挂载保留。
 */
import { icon } from '../../../icons';
import { showContextMenu, toast } from '../../../ui';
import {
  browserBack, browserCloseView, browserEnsure, browserForward, browserHistoryAdd, browserHistoryList,
  browserNavigate, browserOpenDevtools, browserReload, browserSetInspect, browserSetRect,
  browserSetVisible, onBrowserEvent, onBrowserProxyChanged, openDialog,
} from '../../../api';
import type { BrowserEvent, BrowserHistoryItem, BrowserRef } from '../../../types';
import { wbHandles } from '../../../stores/workbench';

/* ---------- 模块级状态(跨标签切换保留;各页面 webview 在 Rust 侧) ---------- */

/** 单个页面的前端镜像状态 */
interface PageState {
  id: string;
  url: string;
  title: string;
  /** 站点图标地址(空串 = 尚未探测到,显示默认地球) */
  favicon: string;
  inspect: boolean;
  /** 是否发生过真实导航(about:blank 之外)——未导航页面无 webview,显示占位提示 */
  hasNavigated: boolean;
  /** 上次下发给后端的显隐状态(重挂后置 false 强制重发) */
  shownApplied: boolean;
}

const pages: PageState[] = [];
let activePageId = '';
let pageSeq = 0;
/** 标签页侧边栏折叠态(默认折叠;跨挂载保留) */
let sidebarCollapsed = true;
/** 当前标签是否激活(active 只切显隐,keep-alive 契约) */
let tabActive = false;
/** 工作台页面是否可见(路由停留 #/workbench;离开到设置/欢迎页时 display:none 保活,
 *  子 webview 必须跟随隐藏,否则会盖住其他页面) */
let workbenchActive = true;
let overlayOpen = false;
/** 用户正在编辑地址栏(期间不用 url 事件回填覆盖输入) */
let editingAddress = false;

/* ---------- 地址栏历史(上报防抖 + 下拉状态) ---------- */

/** 下拉最多展示条数(需求:8 条;存储上限 200 在 store.rs BROWSER_HISTORY_CAP) */
const HISTORY_LIMIT = 8;
/** 导航 started/finished/title 多次事件的防抖合并窗口 */
const HISTORY_DEBOUNCE_MS = 400;
let histPending: { url: string; title: string } | null = null;
let histTimer: ReturnType<typeof setTimeout> | null = null;
let histOpen = false;
/** 当前下拉数据(MRU 序,已按 query 过滤、截取前 8 条) */
let histItems: BrowserHistoryItem[] = [];
/** 键盘高亮行下标,-1 = 无高亮(回车走原文输入) */
let histActiveIdx = -1;
/** 只应用最后一次查询结果(输入竞态与失焦保护) */
let histReqSeq = 0;

let containerEl: HTMLElement | null = null;
let addressInput: HTMLInputElement | null = null;
let histDropEl: HTMLDivElement | null = null;
let inspectBtn: HTMLButtonElement | null = null;
let hintEl: HTMLDivElement | null = null;
let viewEl: HTMLDivElement | null = null;
let pagesEl: HTMLElement | null = null;
let ro: ResizeObserver | null = null;
let unlistenFn: (() => void) | null = null;
let unlistenProxyFn: (() => void) | null = null;

/* ---------- 页面状态辅助 ---------- */

function activePage(): PageState | null {
  return pages.find((p) => p.id === activePageId) ?? null;
}

/** 页面显示标题:页面标题 → URL host → 地址原文;未导航显示「新标签页」 */
function pageDisplayTitle(p: PageState): string {
  if (!p.hasNavigated && !p.url) return '新标签页';
  if (p.title) return p.title;
  try {
    return new URL(p.url).hostname || p.url;
  } catch {
    return p.url || '新标签页';
  }
}

function updateAddress(): void {
  if (addressInput && !editingAddress) addressInput.value = activePage()?.url ?? '';
}

function updateHint(): void {
  if (hintEl) hintEl.style.display = activePage()?.hasNavigated ? 'none' : 'flex';
}

function updateInspectBtn(): void {
  const p = activePage();
  inspectBtn?.classList.toggle('active', !!p?.inspect);
  if (inspectBtn) {
    inspectBtn.title = p?.inspect
      ? '检查模式已开启:点击页面元素选中加入 AI 对话,Esc 取消'
      : '检查元素:点击页面元素加入 AI 对话';
  }
}

/* ---------- rect 同步与显隐 ---------- */

function syncRect(): void {
  const el = viewEl;
  if (!el) return;
  const p = activePage();
  if (!p || !p.hasNavigated) return;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  void browserSetRect(p.id, r.x, r.y, r.width, r.height).catch(() => { /* 标签切换竞态可忽略 */ });
}

function applyVisibility(): void {
  // 五重条件:页面活跃 && 标签激活 && 工作台可见(路由停留) && 无全屏遮罩 && 历史下拉未开 && 已发生导航
  // (历史下拉是 DOM,压不过原生子 webview,打开期间必须让页面整体隐藏,与遮罩避让同机制)
  const base = tabActive && workbenchActive && !overlayOpen && !histOpen;
  for (const p of pages) {
    if (!p.hasNavigated) {
      p.shownApplied = false;
      continue; // 未导航页面无 webview,无需下发
    }
    const desired = base && p.id === activePageId;
    if (p.shownApplied === desired) continue;
    p.shownApplied = desired;
    void browserSetVisible(p.id, desired).catch(() => { /* 标签切换竞态可忽略 */ });
  }
}

/** 薄壳 active 变化回调:标签激活时同步 rect 并显示,非激活隐藏 */
export function setTabActive(active: boolean): void {
  tabActive = active;
  applyVisibility();
  if (active) syncRect();
}

/** 工作台页面可见性(Workbench 组件 active prop 驱动):
 *  离开 #/workbench 到设置/欢迎页时工作台 display:none 保活,子 webview 必须跟随隐藏 */
export function setWorkbenchActive(active: boolean): void {
  workbenchActive = active;
  applyVisibility();
  if (active && tabActive) syncRect();
}

/* ---------- 检查模式 ---------- */

function setInspectState(on: boolean, silent = false): void {
  const p = activePage();
  if (!p) return;
  if (!silent && !p.hasNavigated) {
    toast('请先在地址栏打开一个页面', 'error');
    return;
  }
  p.inspect = on;
  updateInspectBtn();
  if (silent) return;
  void browserSetInspect(p.id, on).catch((err) => toast(`切换检查模式失败: ${String(err)}`, 'error'));
}

/* ---------- 导航 ---------- */

async function navigatePage(p: PageState, input: string): Promise<string> {
  const value = input.trim();
  if (!value) throw new Error('地址不能为空');
  await browserEnsure(p.id);
  const normalized = await browserNavigate(p.id, value);
  p.url = normalized;
  p.hasNavigated = true;
  updateHint();
  applyVisibility();
  syncRect();
  updateAddress();
  renderPagesBar();
  return normalized;
}

async function navigate(input: string): Promise<void> {
  const p = activePage();
  if (!p || !input.trim()) return;
  try {
    await navigatePage(p, input);
  } catch (err) {
    toast(`无法打开: ${String(err)}`, 'error');
  }
}

async function openLocalFile(): Promise<void> {
  const path = await openDialog({
    multiple: false,
    filters: [{ name: 'HTML 文件', extensions: ['html', 'htm'] }],
  });
  if (typeof path === 'string' && path) await navigate(path);
}

/** 在活跃页面打开地址(无页面时新建一页);AI 面板链接点击等外部入口用,返回归一化 URL */
export async function openInActivePage(input: string): Promise<string> {
  const value = input.trim();
  if (!value) throw new Error('地址不能为空');
  let p = activePage();
  if (!p) p = newPage();
  return navigatePage(p, value);
}

/* ---------- 地址栏历史:导航事件防抖上报 + 输入下拉过滤 ---------- */

/** 防抖合并后上报历史:started/finished/title 一次导航连发多条,按同 URL 归并只补标题;
 *  不同地址以最新为准(重定向链收敛到最终页)。失败静默——历史非关键路径。 */
function queueHistoryRecord(url: string, title: string): void {
  if (!url || url === 'about:blank') return;
  histPending =
    histPending && histPending.url === url
      ? { url, title: title || histPending.title }
      : { url, title };
  if (!histTimer) {
    histTimer = setTimeout(() => {
      histTimer = null;
      const item = histPending;
      histPending = null;
      if (item) void browserHistoryAdd(item.url, item.title).catch(() => {});
    }, HISTORY_DEBOUNCE_MS);
  }
}

/** 历史行标题兜底:无页面标题时显示 host */
function historyDisplayTitle(it: BrowserHistoryItem): string {
  if (it.title) return it.title;
  try {
    return new URL(it.url).hostname || it.url;
  } catch {
    return it.url;
  }
}

/** 按地址栏当前输入刷新下拉(URL/标题子串过滤,MRU 序前 8 条);查询竞态由 histReqSeq 收敛,
 *  过期结果与失焦后的迟到结果直接丢弃。无匹配时收起下拉(不留空面板)。 */
async function refreshHistoryDrop(): Promise<void> {
  const input = addressInput;
  if (!input || !editingAddress) return;
  const query = input.value.trim();
  const seq = ++histReqSeq;
  let items: BrowserHistoryItem[] = [];
  try {
    items = await browserHistoryList(query, HISTORY_LIMIT);
  } catch {
    /* 查询失败按空列表处理 */
  }
  if (!addressInput || seq !== histReqSeq || !editingAddress) return;
  if (!items.length) {
    closeHistoryDrop();
    return;
  }
  histItems = items;
  histActiveIdx = -1;
  renderHistoryDrop();
}

function renderHistoryDrop(): void {
  const el = histDropEl;
  if (!el) return;
  el.innerHTML = histItems
    .map(
      (it, i) =>
        `<div class="browser-history-item${i === histActiveIdx ? ' active' : ''}" data-hist-idx="${i}">
          <span class="browser-history-ic">${icon('history')}</span>
          <span class="browser-history-text">
            <span class="browser-history-title">${escapeText(historyDisplayTitle(it))}</span>
            <span class="browser-history-url">${escapeText(it.url)}</span>
          </span>
        </div>`,
    )
    .join('');
  const wasOpen = histOpen;
  histOpen = histItems.length > 0;
  el.style.display = histOpen ? 'block' : 'none';
  // 下拉打开/收起都会改变子 webview 该不该让位
  if (histOpen !== wasOpen) applyVisibility();
}

function updateHistHighlight(): void {
  histDropEl?.querySelectorAll<HTMLElement>('.browser-history-item').forEach((el, i) => {
    el.classList.toggle('active', i === histActiveIdx);
    if (i === histActiveIdx) el.scrollIntoView({ block: 'nearest' });
  });
}

function closeHistoryDrop(): void {
  histReqSeq++; // 在途查询作废
  histItems = [];
  histActiveIdx = -1;
  const wasOpen = histOpen;
  histOpen = false;
  if (histDropEl) {
    histDropEl.style.display = 'none';
    histDropEl.innerHTML = '';
  }
  if (wasOpen) applyVisibility();
}

/** 键盘 ↑↓ 在「原文输入(-1) ↔ 各历史行」间循环移动(浏览器惯例:最后一条再 ↓ 回到原文) */
function moveHistHighlight(dir: 1 | -1): void {
  if (!histOpen || !histItems.length) return;
  const last = histItems.length - 1;
  histActiveIdx =
    dir > 0 ? (histActiveIdx >= last ? -1 : histActiveIdx + 1) : histActiveIdx <= -1 ? last : histActiveIdx - 1;
  updateHistHighlight();
}

async function commitHistoryItem(it: BrowserHistoryItem): Promise<void> {
  if (addressInput) addressInput.value = it.url;
  closeHistoryDrop();
  await navigate(it.url);
}

/* ---------- 页面增删切换 ---------- */

function newPage(): PageState {
  const p: PageState = { id: `p${++pageSeq}`, url: '', title: '', favicon: '', inspect: false, hasNavigated: false, shownApplied: false };
  pages.push(p);
  setActivePage(p.id);
  return p;
}

/** 页面图标标记:有站点 favicon 用 <img>(加载失败由捕获 error 回落地球),否则默认地球 */
function pageIconHtml(p: PageState): string {
  if (!p.favicon) return icon('globe');
  const src = escapeText(p.favicon).replace(/"/g, '&quot;');
  return `<img class="browser-favicon" src="${src}" alt="" referrerpolicy="no-referrer" />`;
}

function setActivePage(id: string): void {
  const p = pages.find((x) => x.id === id);
  if (!p) return;
  activePageId = id;
  applyVisibility(); // 旧页面隐藏 + 新页面显示
  updateAddress();
  updateHint();
  updateInspectBtn();
  syncRect();
  renderPagesBar();
}

function closePage(id: string): void {
  const idx = pages.findIndex((p) => p.id === id);
  if (idx < 0) return;
  const wasActive = id === activePageId;
  pages.splice(idx, 1);
  void browserCloseView(id).catch(() => { /* 页面可能尚未创建,静默 */ });
  if (pages.length === 0) {
    newPage(); // 最后关闭后补一页空白页(浏览器惯例)
    return;
  }
  if (wasActive) {
    const next = pages[Math.min(idx, pages.length - 1)];
    setActivePage(next.id);
  } else {
    renderPagesBar();
  }
}

/* ---------- 右侧标签页侧边栏(默认折叠) ---------- */

function renderPagesBar(): void {
  const el = pagesEl;
  if (!el) return;
  if (sidebarCollapsed) {
    el.classList.add('collapsed');
    el.classList.remove('expanded');
    const dots = pages.map((p) =>
      `<button class="browser-page-dot${p.id === activePageId ? ' active' : ''}" data-pages-id="${p.id}"
        title="${pageDisplayTitle(p).replace(/"/g, '&quot;')}${p.url ? ` · ${p.url.replace(/"/g, '&quot;')}` : ''}"><span class="browser-page-ic">${pageIconHtml(p)}</span></button>`,
    ).join('');
    el.innerHTML =
      `<button class="icon-btn browser-pages-toggle" data-pages-act="toggle" title="展开标签页列表">${icon('chevronLeft')}</button>` +
      `<button class="icon-btn" data-pages-act="new" title="新建页面">${icon('plus')}</button>` +
      `<div class="browser-pages-rail">${dots}</div>`;
    return;
  }
  el.classList.add('expanded');
  el.classList.remove('collapsed');
  const rows = pages.map((p) =>
    `<div class="browser-page-row${p.id === activePageId ? ' active' : ''}" data-pages-id="${p.id}" title="${p.url.replace(/"/g, '&quot;')}">
      <span class="browser-page-ic">${pageIconHtml(p)}</span>
      <span class="browser-page-title">${escapeText(pageDisplayTitle(p))}</span>
      <button class="browser-page-close" data-pages-close="${p.id}" title="关闭页面">${icon('x')}</button>
    </div>`,
  ).join('');
  el.innerHTML =
    `<div class="browser-pages-head">
      <span class="browser-pages-title">标签页</span>
      <button class="icon-btn" data-pages-act="new" title="新建页面">${icon('plus')}</button>
      <button class="icon-btn browser-pages-toggle" data-pages-act="toggle" title="收起标签页列表">${icon('chevronRight')}</button>
    </div>` +
    `<div class="browser-pages-list">${rows}</div>`;
}

function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function onPagesClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const actBtn = target.closest<HTMLElement>('[data-pages-act]');
  if (actBtn) {
    const act = actBtn.dataset.pagesAct;
    if (act === 'toggle') {
      sidebarCollapsed = !sidebarCollapsed;
      renderPagesBar();
      // 侧栏宽度变化改变视图区域,重同步活跃页面 rect
      requestAnimationFrame(() => syncRect());
    } else if (act === 'new') {
      newPage();
      addressInput?.focus();
    }
    return;
  }
  const closeBtn = target.closest<HTMLElement>('[data-pages-close]');
  if (closeBtn) {
    closePage(closeBtn.dataset.pagesClose ?? '');
    return;
  }
  const row = target.closest<HTMLElement>('[data-pages-id]');
  if (row) setActivePage(row.dataset.pagesId ?? '');
}

function onPagesContextMenu(e: MouseEvent): void {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-pages-id]');
  if (!row) return;
  e.preventDefault();
  const id = row.dataset.pagesId ?? '';
  showContextMenu(e.clientX, e.clientY, [
    { label: '关闭页面', iconName: 'x', action: () => closePage(id) },
    { label: '关闭其他页面', iconName: 'trash', action: () => pages.filter((p) => p.id !== id).forEach((p) => closePage(p.id)) },
  ]);
}

/* ---------- 挂载 / 卸载 ---------- */

export function mountBrowser(container: HTMLElement, active: boolean): () => void {
  tabActive = active;
  workbenchActive = true; // 挂载即工作台显示中;Workbench 的 active effect 随后同步覆盖
  containerEl = container;

  container.innerHTML = `
    <div class="browser-toolbar">
      <button class="icon-btn" data-act="back" title="后退">${icon('arrowLeft')}</button>
      <button class="icon-btn" data-act="forward" title="前进">${icon('arrowRight')}</button>
      <button class="icon-btn" data-act="reload" title="刷新">${icon('refresh')}</button>
      <div class="browser-address-wrap">
        <input class="browser-address" type="text" spellcheck="false"
          placeholder="输入网址或本地 HTML 路径,回车打开" />
        <div class="browser-history-drop" style="display:none"></div>
      </div>
      <button class="icon-btn" data-act="local" title="打开本地 HTML 文件">${icon('folderOpen')}</button>
      <button class="icon-btn browser-inspect-btn" data-act="inspect"
        title="检查元素:点击页面元素加入 AI 对话">${icon('inspect')}</button>
      <button class="icon-btn" data-act="devtools" title="开发者工具(该视图的 F12)">${icon('wrench')}</button>
    </div>
    <div class="browser-body">
      <div class="browser-view">
        <div class="browser-hint">
          <span class="browser-hint-icon">${icon('globe')}</span>
          <span>输入网址打开网页,或用上方按钮选择本地 HTML 文件;<br>「检查元素」选中页面元素后加入 AI 对话</span>
        </div>
      </div>
      <div class="browser-pages collapsed"></div>
    </div>`;

  addressInput = container.querySelector<HTMLInputElement>('.browser-address');
  histDropEl = container.querySelector<HTMLDivElement>('.browser-history-drop');
  inspectBtn = container.querySelector<HTMLButtonElement>('[data-act="inspect"]');
  hintEl = container.querySelector<HTMLDivElement>('.browser-hint');
  viewEl = container.querySelector<HTMLDivElement>('.browser-view');
  pagesEl = container.querySelector<HTMLElement>('.browser-pages');

  /* 恢复页面状态(模块级 pages 跨挂载保留);没有页面时补一页空白页 */
  if (!pages.length) newPage();
  else if (!activePage()) setActivePage(pages[pages.length - 1].id);
  else {
    updateAddress();
    updateHint();
    updateInspectBtn();
    renderPagesBar();
  }

  const onToolbarClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'local') {
      void openLocalFile();
      return;
    }
    const p = activePage();
    if (!p) return;
    // 未导航页面无 webview:导航类/检查/开发者工具都先引导打开页面
    if (!p.hasNavigated) {
      toast('请先在地址栏打开一个页面', 'error');
      return;
    }
    if (act === 'back') void browserBack(p.id).catch((err) => toast(`后退失败: ${String(err)}`, 'error'));
    else if (act === 'forward') void browserForward(p.id).catch((err) => toast(`前进失败: ${String(err)}`, 'error'));
    else if (act === 'reload') void browserReload(p.id).catch((err) => toast(`刷新失败: ${String(err)}`, 'error'));
    else if (act === 'inspect') setInspectState(!p.inspect);
    else if (act === 'devtools') {
      void (async () => {
        await browserEnsure(p.id);
        await browserOpenDevtools(p.id);
      })().catch((err) => toast(`打开开发者工具失败: ${String(err)}`, 'error'));
    }
  };
  container.querySelector('.browser-toolbar')?.addEventListener('click', onToolbarClick);

  pagesEl?.addEventListener('click', onPagesClick);
  pagesEl?.addEventListener('contextmenu', onPagesContextMenu);
  /** favicon <img> 加载失败回落默认地球(error 事件不冒泡,用捕获监听) */
  const onPageImgError = (e: Event): void => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.classList.contains('browser-favicon')) return;
    const holder = img.parentElement;
    if (!holder || !holder.classList.contains('browser-page-ic')) return;
    holder.innerHTML = icon('globe');
  };
  pagesEl?.addEventListener('error', onPageImgError, true);

  const onAddressKey = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (histOpen && histItems.length) {
        e.preventDefault(); // 下拉打开时 ↑↓ 用于选择行,不移动光标
        moveHistHighlight(e.key === 'ArrowDown' ? 1 : -1);
      }
      return;
    }
    if (e.key === 'Enter' && addressInput) {
      e.preventDefault();
      const picked = histOpen && histActiveIdx >= 0 ? histItems[histActiveIdx] : null;
      closeHistoryDrop();
      // 有键盘选中项 → 打开该历史;否则按原文导航(浏览器惯例)
      void (picked ? commitHistoryItem(picked) : navigate(addressInput.value));
    } else if (e.key === 'Escape' && histOpen) {
      closeHistoryDrop();
    }
  };
  const onAddressInput = (): void => {
    void refreshHistoryDrop();
  };
  const onAddressFocus = (): void => {
    editingAddress = true;
    // 聚焦即展开最近记录(无记录时 refresh 内部自动收起)
    void refreshHistoryDrop();
  };
  const onAddressBlur = (): void => {
    editingAddress = false;
    closeHistoryDrop();
    // 未导航提交时还原为当前地址
    const p = activePage();
    if (addressInput && p && addressInput.value.trim() !== p.url) addressInput.value = p.url;
  };
  /** mousedown 而非 click:preventDefault 保住地址栏焦点,避免 blur 抢先把下拉关掉 */
  const onHistoryMouseDown = (e: MouseEvent): void => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-hist-idx]');
    if (!row) return;
    e.preventDefault();
    const it = histItems[Number(row.dataset.histIdx)];
    if (it && addressInput) void commitHistoryItem(it);
  };
  histDropEl?.addEventListener('mousedown', onHistoryMouseDown);
  addressInput?.addEventListener('keydown', onAddressKey);
  addressInput?.addEventListener('input', onAddressInput);
  addressInput?.addEventListener('focus', onAddressFocus);
  addressInput?.addEventListener('blur', onAddressBlur);

  /* 占位区 rect 同步:尺寸变化(窗口缩放/面板拖宽/侧栏展开)与初始各报一次 */
  ro = new ResizeObserver(() => syncRect());
  if (viewEl) ro.observe(viewEl);
  window.addEventListener('resize', syncRect);

  /* 遮罩避让:modal-mask / ctx-menu 挂 body 直下,出现/移除时重算可见性 */
  overlayOpen = Array.from(document.body.children).some(
    (n) => n instanceof HTMLElement
      && (n.classList.contains('modal-mask') || n.classList.contains('ctx-menu')),
  );
  const overlayObserver = new MutationObserver(() => {
    const open = Array.from(document.body.children).some(
      (n) => n instanceof HTMLElement
        && (n.classList.contains('modal-mask') || n.classList.contains('ctx-menu')),
    );
    if (open !== overlayOpen) {
      overlayOpen = open;
      applyVisibility();
    }
  });
  overlayObserver.observe(document.body, { childList: true });

  /* listen 返回 Promise<UnlistenFn>:标签提前关闭时拿到句柄立即注销 */
  void onBrowserEvent((ev: BrowserEvent) => {
    const page = ev.viewId ? pages.find((x) => x.id === ev.viewId) : null;
    if (ev.kind === 'url' && ev.url && ev.url !== 'about:blank') {
      if (page) {
        page.url = ev.url;
        page.hasNavigated = true;
      }
      updateHint();
      applyVisibility();
      updateAddress();
      renderPagesBar();
      if (page) queueHistoryRecord(page.url, page.title);
    } else if (ev.kind === 'title' && ev.title && page) {
      page.title = ev.title;
      renderPagesBar();
      queueHistoryRecord(page.url, page.title);
    } else if (ev.kind === 'favicon' && ev.url && page) {
      // 站点图标(注入脚本已限定 http(s)/data:image,此处再防御一次;失败不覆盖已知值)
      if (/^(https?:|data:image\/)/i.test(ev.url)) {
        page.favicon = ev.url;
        renderPagesBar();
      }
    } else if (ev.kind === 'ai-navigate' && ev.url) {
      toast(`AI 正在打开: ${ev.url}`);
    } else if (ev.kind === 'new-window' && ev.url) {
      const target = newPage();
      void navigatePage(target, ev.url).catch((err) => {
        toast(`无法在新页面打开: ${String(err)}`, 'error');
      });
    } else if (ev.kind === 'element') {
      handleElementSelected(ev);
    }
  }).then((fn) => {
    if (containerEl === container) unlistenFn = fn;
    else fn();
  });

  /* 代理变更(设置页保存 SOCKS5 代理后广播):后端已关闭全部子视图,
     已导航页面按 URL 自动重建(代理只能在子 webview 创建时注入,重建即生效) */
  void onBrowserProxyChanged(() => {
    if (containerEl !== container) return;
    for (const p of pages) {
      if (!p.hasNavigated || !p.url || p.url === 'about:blank') continue;
      void navigatePage(p, p.url).catch((err) => {
        toast(`代理变更后重建页面失败: ${String(err)}`, 'error');
      });
    }
  }).then((fn) => {
    if (containerEl === container) unlistenProxyFn = fn;
    else fn();
  });

  /* 重挂后显隐状态强制重发一次(后端不跨挂载记忆) */
  pages.forEach((p) => { p.shownApplied = false; });
  applyVisibility();
  updateHint();
  syncRect();

  /* 恢复 webview 侧状态(url/标题/检查模式跨挂载保留) */
  void (async () => {
    for (const p of pages) {
      if (!p.hasNavigated) continue;
      try {
        const st = await browserEnsure(p.id);
        if (containerEl !== container) return;
        if (st.url && st.url !== 'about:blank') {
          p.url = st.url;
          p.hasNavigated = true;
        }
        p.title = st.title || p.title;
        p.inspect = st.inspect;
        if (st.favicon) p.favicon = st.favicon;
      } catch {
        /* webview 已不存在(理论上不会):保持镜像状态 */
      }
    }
    if (containerEl !== container) return;
    updateAddress();
    updateHint();
    updateInspectBtn();
    renderPagesBar();
    applyVisibility();
    syncRect();
  })();

  return () => {
    if (containerEl === container) containerEl = null;
    ro?.disconnect();
    overlayObserver.disconnect();
    window.removeEventListener('resize', syncRect);
    if (unlistenFn) { unlistenFn(); unlistenFn = null; }
    if (unlistenProxyFn) { unlistenProxyFn(); unlistenProxyFn = null; }
    container.querySelector('.browser-toolbar')?.removeEventListener('click', onToolbarClick);
    pagesEl?.removeEventListener('click', onPagesClick);
    pagesEl?.removeEventListener('contextmenu', onPagesContextMenu);
    pagesEl?.removeEventListener('error', onPageImgError, true);
    addressInput?.removeEventListener('keydown', onAddressKey);
    addressInput?.removeEventListener('input', onAddressInput);
    addressInput?.removeEventListener('focus', onAddressFocus);
    addressInput?.removeEventListener('blur', onAddressBlur);
    histDropEl?.removeEventListener('mousedown', onHistoryMouseDown);
    closeHistoryDrop();
    // 未落库的防抖条目随卸载立即上报(页面访问是既成事实,不因标签关闭而丢)
    if (histTimer) { clearTimeout(histTimer); histTimer = null; }
    const pending = histPending;
    histPending = null;
    if (pending) void browserHistoryAdd(pending.url, pending.title).catch(() => {});
    container.innerHTML = '';
    addressInput = null;
    histDropEl = null;
    inspectBtn = null;
    hintEl = null;
    viewEl = null;
    pagesEl = null;
    ro = null;
    tabActive = false;
    applyVisibility(); // 标签关闭:隐藏全部页面 webview(Rust 侧保留,再开同 id 标签恢复)
  };
}

/* ---------- 外部查询(AI 输入框 @ 自动补全等) ---------- */

/** 当前所有已导航页面(标题/地址),AI @ 补全引用浏览器页面用 */
export function getBrowserPagesForMention(): Array<{ id: string; title: string; url: string }> {
  return pages
    .filter((p) => p.hasNavigated)
    .map((p) => ({ id: p.id, title: pageDisplayTitle(p), url: p.url }));
}

/* ---------- 检查器选中元素 → AI 引用 chip ---------- */

function handleElementSelected(ev: BrowserEvent): void {
  const ref: BrowserRef = {
    name: ev.name ?? '',
    tagName: ev.tagName ?? '',
    elementId: ev.elementId ?? '',
    url: ev.url ?? '',
    title: ev.title ?? '',
    outerHTML: ev.outerHTML ?? '',
    ts: ev.ts ?? Date.now(),
  };
  if (!ref.name && !ref.tagName) return;
  if (wbHandles.ai?.addBrowserRef) {
    wbHandles.ai.addBrowserRef(ref);
    toast(`已添加元素引用 @browser:${ref.name || ref.tagName}`);
  } else {
    toast('AI 面板尚未就绪,无法添加元素引用', 'error');
  }
  // 注入脚本点击后已自动 disable;同步 Rust 状态与按钮,避免下次导航又被激活
  const page = ev.viewId ? pages.find((p) => p.id === ev.viewId) : null;
  if (page) page.inspect = false;
  updateInspectBtn();
  if (page) void browserSetInspect(page.id, false).catch(() => { /* 页面可能已跳转,静默 */ });
}
