/**
 * 内置浏览器标签页引擎(命令式,React 薄壳 BrowserTab.tsx 挂载)。无 .proto 对照(全新功能)。
 * 与后端的接口点:
 * - 命令:browser_ensure / set_rect / set_visible / navigate / back / forward / reload /
 *   set_inspect / open_devtools / close_view(全部带 viewId,src/api.ts 封装,Rust browser.rs);
 * - 事件:browser:event(url / title / element / ai-navigate / new-window,均带 viewId)。
 * 多页面模型:工作台浏览器标签页(固定 id 'browser' 单实例)内部维护多个「页面」,
 * 每页对应 Rust 侧一个子 webview(label = browser-<viewId>),首次导航才懒创建,
 * 关闭页面经 close_view 释放;页面状态(地址/标题/检查模式)Rust 侧持有,前端模块级
 * 镜像跨挂载保留(同 explorer 模式:标签关闭再打开不丢)。
 * 右侧标签页侧边栏默认折叠(窄轨:仅页面图标 + 新建/展开按钮);展开后显示标题列表。
 * 本引擎职责:
 * - 工具栏 UI(后退/前进/刷新/地址栏/打开本地 HTML/检查元素/开发者工具,作用于活跃页面);
 * - 活跃页面容器 rect 同步(ResizeObserver + window resize,逻辑坐标与窗口 1:1);
 * - 显隐合成:页面活跃 && 标签激活 && 工作台可见 && 无全屏遮罩(.modal-mask/.ctx-menu 挂
 *   body 直下)&& 已导航 才显示——子 webview 永远浮在主 webview 之上,遮罩出现时必须让位;
 *   非活跃页面一律隐藏。
 * - 检查模式开关;element 事件 → wbHandles.ai.addBrowserRef(chip 引用,发送时展开);
 * - 页面增删/切换(关闭最后一页自动补一页空白页)。
 * 挂载契约:每次挂载完整初始化 DOM/监听/观察,清理函数完整回收;引擎状态跨挂载保留。
 */
import { icon } from '../../../icons';
import { showContextMenu, toast } from '../../../ui';
import {
  browserBack, browserCloseView, browserEnsure, browserForward, browserNavigate, browserOpenDevtools,
  browserReload, browserSetInspect, browserSetRect, browserSetVisible, onBrowserEvent, openDialog,
} from '../../../api';
import type { BrowserEvent, BrowserRef } from '../../../types';
import { wbHandles } from '../../../stores/workbench';

/* ---------- 模块级状态(跨标签切换保留;各页面 webview 在 Rust 侧) ---------- */

/** 单个页面的前端镜像状态 */
interface PageState {
  id: string;
  url: string;
  title: string;
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

let containerEl: HTMLElement | null = null;
let addressInput: HTMLInputElement | null = null;
let inspectBtn: HTMLButtonElement | null = null;
let hintEl: HTMLDivElement | null = null;
let viewEl: HTMLDivElement | null = null;
let pagesEl: HTMLElement | null = null;
let ro: ResizeObserver | null = null;
let unlistenFn: (() => void) | null = null;

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

/** 原生子 WebView 的层级高于主 WebView；全屏遮罩和右键菜单出现时必须临时隐藏它。 */
function hasBlockingOverlay(): boolean {
  return Array.from(document.body.children).some(
    (n) => n instanceof HTMLElement
      && (n.classList.contains('modal-mask') || n.classList.contains('ctx-menu')),
  );
}

function applyVisibility(): void {
  // 四重条件:页面活跃 && 标签激活 && 工作台可见(路由停留) && 无全屏遮罩 && 已发生导航
  const base = tabActive && workbenchActive && !overlayOpen;
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

async function navigate(input: string): Promise<void> {
  const p = activePage();
  const value = input.trim();
  if (!p || !value) return;
  try {
    await browserEnsure(p.id);
    const normalized = await browserNavigate(p.id, value);
    p.url = normalized;
    p.hasNavigated = true;
    updateHint();
    applyVisibility();
    syncRect();
    updateAddress();
    renderPagesBar();
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

/* ---------- 页面增删切换 ---------- */

function newPage(): PageState {
  const p: PageState = { id: `p${++pageSeq}`, url: '', title: '', inspect: false, hasNavigated: false, shownApplied: false };
  pages.push(p);
  setActivePage(p.id);
  return p;
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
        title="${pageDisplayTitle(p).replace(/"/g, '&quot;')}${p.url ? ` · ${p.url.replace(/"/g, '&quot;')}` : ''}">${icon('globe')}</button>`,
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
      <span class="browser-page-ic">${icon('globe')}</span>
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
      <input class="browser-address" type="text" spellcheck="false"
        placeholder="输入网址或本地 HTML 路径,回车打开" />
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

  const onAddressKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && addressInput) {
      e.preventDefault();
      void navigate(addressInput.value);
    }
  };
  const onAddressFocus = (): void => { editingAddress = true; };
  const onAddressBlur = (): void => {
    editingAddress = false;
    // 未导航提交时还原为当前地址
    const p = activePage();
    if (addressInput && p && addressInput.value.trim() !== p.url) addressInput.value = p.url;
  };
  addressInput?.addEventListener('keydown', onAddressKey);
  addressInput?.addEventListener('focus', onAddressFocus);
  addressInput?.addEventListener('blur', onAddressBlur);

  /* 占位区 rect 同步:尺寸变化(窗口缩放/面板拖宽/侧栏展开)与初始各报一次 */
  ro = new ResizeObserver(() => syncRect());
  if (viewEl) ro.observe(viewEl);
  window.addEventListener('resize', syncRect);

  /* 子 WebView 会盖住主页面的模态与菜单；它们出现/移除时重算可见性。 */
  overlayOpen = hasBlockingOverlay();
  const overlayObserver = new MutationObserver(() => {
    const open = hasBlockingOverlay();
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
    } else if (ev.kind === 'title' && ev.title && page) {
      page.title = ev.title;
      renderPagesBar();
    } else if (ev.kind === 'ai-navigate' && ev.url) {
      toast(`AI 正在打开: ${ev.url}`);
    } else if (ev.kind === 'new-window' && ev.url) {
      /* 新窗口拦截（main 侧引入）：后端拒绝弹窗并把地址经 browser:event new-window 送来，这里开新标签页 */
      const target = newPage();
      void (async () => {
        try {
          await browserEnsure(target.id);
          const normalized = await browserNavigate(target.id, ev.url!);
          target.url = normalized;
          target.hasNavigated = true;
          updateHint();
          applyVisibility();
          syncRect();
          updateAddress();
          renderPagesBar();
        } catch (err) {
          toast(`无法在新页面打开: ${String(err)}`, 'error');
        }
      })();
    } else if (ev.kind === 'element') {
      handleElementSelected(ev);
    }
  }).then((fn) => {
    if (containerEl === container) unlistenFn = fn;
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
    container.querySelector('.browser-toolbar')?.removeEventListener('click', onToolbarClick);
    pagesEl?.removeEventListener('click', onPagesClick);
    pagesEl?.removeEventListener('contextmenu', onPagesContextMenu);
    addressInput?.removeEventListener('keydown', onAddressKey);
    addressInput?.removeEventListener('focus', onAddressFocus);
    addressInput?.removeEventListener('blur', onAddressBlur);
    container.innerHTML = '';
    addressInput = null;
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
