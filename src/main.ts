/** 应用入口：hash 路由 + 启动缺配跳转（语义同 .proto/index.html）。
 * 工作台页面保活：离开只隐藏不销毁，同项目回归原样复用（见 wbLifecycle）。 */
import './styles/design.css';
import { getState, isConfigComplete, openDevtools } from './api';
import { initCommandPanel } from './command-panel';
import { initDebug } from './debug';
import { navigate, onRoute, parseHash } from './router';
import { applyTheme } from './theme';
import { renderTopbar } from './components/topbar';
import { renderWelcome } from './pages/welcome';
import { renderSettings } from './pages/settings';
import { renderAccount } from './pages/account';
import { renderWorkbench } from './pages/workbench/workbench';
import { wbLifecycle } from './pages/workbench/lifecycle';

export type PageCleanup = () => void;
export type PageRender = (root: HTMLElement, params: URLSearchParams) => void | PageCleanup;

const app = document.getElementById('app')!;
/* 子页(welcome/settings)持久容器:与工作台实例并存,切页只切换显隐,不互相销毁 */
const pageEl = document.createElement('div');
pageEl.className = 'page-root';
app.appendChild(pageEl);
let cleanup: PageCleanup | null = null;

/* 工作台保活实例:离开工作台只隐藏(display:none 保持 isConnected,ai.ts 的
   MutationObserver 与 bus 守卫不误判卸载),同项目回归时原样复用 —— 标签页、终端、
   SSH 连接、AI 会话全部保留;换项目才销毁重建。 */
let wbEl: HTMLElement | null = null;
let wbCleanup: PageCleanup | null = null;

/** 销毁保活的工作台(cleanup 触发 closeTab → 各渲染器 onClose 后端清理) */
function destroyWorkbench(): void {
  if (wbCleanup) { wbCleanup(); wbCleanup = null; }
  if (wbEl) { wbEl.remove(); wbEl = null; }
  wbLifecycle.projectId = null;
}

function renderSubPage(name: string, params: URLSearchParams): void {
  if (cleanup) { cleanup(); cleanup = null; }
  pageEl.innerHTML = '';
  if (name === '/settings') {
    renderTopbar(pageEl, 'settings');
    cleanup = renderSettings(pageEl, params) ?? null;
  } else if (name === '/account') {
    renderTopbar(pageEl, 'account');
    cleanup = renderAccount(pageEl, params) ?? null;
  } else {
    renderTopbar(pageEl, 'welcome');
    cleanup = renderWelcome(pageEl, params) ?? null;
  }
}

async function render(): Promise<void> {
  const { name, params } = parseHash();
  if (name === '/workbench') {
    const target = params.get('project');
    if (wbEl && wbLifecycle.projectId && (!target || target === wbLifecycle.projectId)) {
      /* 同项目回归:复用保活实例(含裸 '#/workbench' 情形,目标项目即保活项目) */
      if (cleanup) { cleanup(); cleanup = null; }
      pageEl.innerHTML = '';
      pageEl.style.display = 'none';
      wbEl.style.display = '';
      return;
    }
    /* 首次进入或换项目:销毁旧实例后重建 */
    destroyWorkbench();
    if (cleanup) { cleanup(); cleanup = null; }
    pageEl.innerHTML = '';
    pageEl.style.display = 'none';
    const el = document.createElement('div');
    el.className = 'page-root';
    app.appendChild(el);
    const wb = await renderWorkbench(el, params) ?? null;
    if (wbLifecycle.projectId && el.isConnected && !wbEl) {
      wbEl = el;
      wbCleanup = wb;
    } else {
      /* 装载失败(已自行导航离开)或并发装载落后:跑 cleanup 释放监听再移除 */
      wb?.();
      el.remove();
    }
    return;
  }
  /* welcome/settings:渲染子页;健康的工作台隐藏保活,装载失败的残留直接销毁 */
  if (wbEl && !wbLifecycle.projectId) destroyWorkbench();
  if (wbEl) wbEl.style.display = 'none';
  pageEl.style.display = '';
  renderSubPage(name, params);
}

async function boot(): Promise<void> {
  /* 先取 settings.theme 应用,避免首屏亮暗闪烁;失败保持默认深色 */
  try { const s = await getState(); applyTheme(s.settings.theme); } catch { /* 后端未就绪 */ }
  if (!location.hash) {
    let ok = false;
    try { ok = await isConfigComplete(); } catch { /* 后端未就绪时按缺配处理 */ }
    navigate(ok ? '#/welcome' : '#/settings?reason=missing-config');
    return; // hashchange 触发 render
  }
  await render();
}

onRoute(() => { void render(); });

/* OS 文件拖入的全局兜底：dragDropEnabled=false 后 WebView2 默认行为是导航到拖入文件，
   全局拦截；各面板自己的 drop handler 先行执行不受影响。 */
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

/* 禁用 WebView2 原生右键菜单（刷新/检查等浏览器项与应用无关）。
   输入框放行原生菜单（拼写/撤销/粘贴是刚需）；
   各面板自定义菜单（explorer/sftp/terminal）在目标元素上 preventDefault + stopPropagation，
   冒泡不到这里，不受影响。 */
document.addEventListener('contextmenu', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea:not(.xterm-helper-textarea)')) return;
  e.preventDefault();
});

/* F12 打开 DevTools：浏览器快捷键已被后端禁用（会劫持终端 Ctrl+Shift+C/V），改为应用自控 */
document.addEventListener('keydown', (e) => {
  if (e.key === 'F12') {
    e.preventDefault();
    void openDevtools();
  }
});

void boot();

/* 命令面板（Ctrl+T / Ctrl+P）：全局组件，挂载后不随页面重渲染销毁 */
initCommandPanel();
/* Debug 日志总线：启动即订阅后端 debug:log（面板未开也留历史） */
void initDebug();
