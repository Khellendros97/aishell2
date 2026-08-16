/**
 * 内置浏览器标签页引擎(命令式,React 薄壳 BrowserTab.tsx 挂载)。无 .proto 对照(全新功能)。
 * 与后端的接口点:
 * - 命令:browser_ensure / set_rect / set_visible / navigate / back / forward / reload /
 *   set_inspect / open_devtools(src/api.ts 封装,Rust browser.rs);
 * - 事件:browser:event(url / title / element / ai-navigate)。
 * 原生子 webview 由 Rust 持有(全局单实例,跨标签关闭/跨项目保留),本引擎只负责:
 * - 工具栏 UI(后退/前进/刷新/地址栏/打开本地 HTML/检查元素/开发者工具);
 * - 容器 div 的 rect 同步(ResizeObserver + window resize,逻辑坐标与窗口 1:1);
 * - 显隐合成:标签激活 && 无全屏遮罩(.modal-mask/.ctx-menu 挂 body 直下)才显示——
 *   子 webview 永远浮在主 webview 之上,遮罩出现时必须让位;
 * - 检查模式开关;element 事件 → wbHandles.ai.addBrowserRef(chip 引用,发送时展开)。
 * 状态放模块级(同 explorer 模式):标签关闭再打开不丢 url/检查模式。
 * 挂载契约:每次挂载完整初始化 DOM/监听/观察,清理函数完整回收;引擎状态跨挂载保留。
 */
import { icon } from '../../../icons';
import { toast } from '../../../ui';
import {
  browserBack, browserEnsure, browserForward, browserNavigate, browserOpenDevtools, browserReload,
  browserSetInspect, browserSetRect, browserSetVisible, onBrowserEvent, openDialog,
} from '../../../api';
import type { BrowserEvent, BrowserRef } from '../../../types';
import { wbHandles } from '../../../stores/workbench';

/* ---------- 模块级状态(跨标签切换保留;webview 本体在 Rust 侧) ---------- */
let currentUrl = '';
let inspecting = false;
/** 是否发生过真实导航(about:blank 之外)——未导航前保持 webview 隐藏、显示占位提示 */
let hasNavigated = false;
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
let ro: ResizeObserver | null = null;
let unlistenFn: (() => void) | null = null;

/* ---------- rect 同步与显隐 ---------- */

function syncRect(): void {
  const el = viewEl;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  void browserSetRect(r.x, r.y, r.width, r.height).catch(() => { /* 标签切换竞态可忽略 */ });
}

function applyVisibility(): void {
  // 四重条件:标签激活 && 工作台可见(路由停留) && 无全屏遮罩 && 已发生导航
  void browserSetVisible(tabActive && workbenchActive && !overlayOpen && hasNavigated)
    .catch(() => { /* 标签切换竞态可忽略 */ });
}

function updateHint(): void {
  if (hintEl) hintEl.style.display = hasNavigated ? 'none' : 'flex';
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
  inspecting = on;
  inspectBtn?.classList.toggle('active', on);
  if (inspectBtn) {
    inspectBtn.title = on
      ? '检查模式已开启:点击页面元素选中加入 AI 对话,Esc 取消'
      : '检查元素:点击页面元素加入 AI 对话';
  }
  if (silent) return;
  void browserSetInspect(on).catch((err) => toast(`切换检查模式失败: ${String(err)}`, 'error'));
}

/* ---------- 导航 ---------- */

async function navigate(input: string): Promise<void> {
  const value = input.trim();
  if (!value) return;
  try {
    await browserEnsure();
    const normalized = await browserNavigate(value);
    currentUrl = normalized;
    hasNavigated = true;
    updateHint();
    applyVisibility();
    if (addressInput && !editingAddress) addressInput.value = normalized;
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
    <div class="browser-view">
      <div class="browser-hint">
        <span class="browser-hint-icon">${icon('globe')}</span>
        <span>输入网址打开网页,或用上方按钮选择本地 HTML 文件;<br>「检查元素」选中页面元素后加入 AI 对话</span>
      </div>
    </div>`;

  addressInput = container.querySelector<HTMLInputElement>('.browser-address');
  inspectBtn = container.querySelector<HTMLButtonElement>('[data-act="inspect"]');
  hintEl = container.querySelector<HTMLDivElement>('.browser-hint');
  viewEl = container.querySelector<HTMLDivElement>('.browser-view');
  if (addressInput) addressInput.value = currentUrl;

  const onToolbarClick = (e: Event): void => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'back') void browserBack().catch((err) => toast(`后退失败: ${String(err)}`, 'error'));
    else if (act === 'forward') void browserForward().catch((err) => toast(`前进失败: ${String(err)}`, 'error'));
    else if (act === 'reload') void browserReload().catch((err) => toast(`刷新失败: ${String(err)}`, 'error'));
    else if (act === 'local') void openLocalFile();
    else if (act === 'inspect') setInspectState(!inspecting);
    else if (act === 'devtools') {
      void (async () => {
        await browserEnsure();
        await browserOpenDevtools();
      })().catch((err) => toast(`打开开发者工具失败: ${String(err)}`, 'error'));
    }
  };
  container.querySelector('.browser-toolbar')?.addEventListener('click', onToolbarClick);

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
    if (addressInput && addressInput.value.trim() !== currentUrl) addressInput.value = currentUrl;
  };
  addressInput?.addEventListener('keydown', onAddressKey);
  addressInput?.addEventListener('focus', onAddressFocus);
  addressInput?.addEventListener('blur', onAddressBlur);

  /* 占位区 rect 同步:尺寸变化(窗口缩放/面板拖宽)与初始各报一次 */
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
    if (ev.kind === 'url' && ev.url && ev.url !== 'about:blank') {
      currentUrl = ev.url;
      hasNavigated = true;
      updateHint();
      applyVisibility();
      if (addressInput && !editingAddress) addressInput.value = ev.url;
    } else if (ev.kind === 'ai-navigate' && ev.url) {
      toast(`AI 正在打开: ${ev.url}`);
    } else if (ev.kind === 'element') {
      handleElementSelected(ev);
    }
    // kind=title 只作状态记录,地址栏展示 url 即可
  }).then((fn) => {
    if (containerEl === container) unlistenFn = fn;
    else fn();
  });

  updateHint();
  syncRect();

  /* 恢复 webview 侧状态(url/检查模式跨标签保留)并显示 */
  void (async () => {
    try {
      const st = await browserEnsure();
      if (containerEl !== container) return;
      if (st.url && st.url !== 'about:blank') {
        currentUrl = st.url;
        hasNavigated = true;
        if (addressInput && !editingAddress) addressInput.value = st.url;
      }
      setInspectState(st.inspect, true); // 仅恢复按钮态,Rust 侧已是该状态
      updateHint();
      syncRect();
      applyVisibility();
    } catch (err) {
      toast(`初始化浏览器失败: ${String(err)}`, 'error');
    }
  })();

  return () => {
    if (containerEl === container) containerEl = null;
    ro?.disconnect();
    overlayObserver.disconnect();
    window.removeEventListener('resize', syncRect);
    if (unlistenFn) { unlistenFn(); unlistenFn = null; }
    container.querySelector('.browser-toolbar')?.removeEventListener('click', onToolbarClick);
    addressInput?.removeEventListener('keydown', onAddressKey);
    addressInput?.removeEventListener('focus', onAddressFocus);
    addressInput?.removeEventListener('blur', onAddressBlur);
    container.innerHTML = '';
    addressInput = null;
    inspectBtn = null;
    hintEl = null;
    viewEl = null;
    ro = null;
    tabActive = false;
    applyVisibility(); // 标签关闭:隐藏 webview(Rust 侧保留,再开同 id 标签恢复)
  };
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
  setInspectState(false, true);
  void browserSetInspect(false).catch(() => { /* 页面可能已跳转,静默 */ });
}
