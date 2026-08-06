/** 应用入口：hash 路由 + 启动缺配跳转（语义同 .proto/index.html）。 */
import './styles/design.css';
import { getState, isConfigComplete, openDevtools } from './api';
import { initCommandPanel } from './command-panel';
import { navigate, onRoute, parseHash } from './router';
import { applyTheme } from './theme';
import { renderTopbar } from './components/topbar';
import { renderWelcome } from './pages/welcome';
import { renderSettings } from './pages/settings';
import { renderWorkbench } from './pages/workbench/workbench';

export type PageCleanup = () => void;
export type PageRender = (root: HTMLElement, params: URLSearchParams) => void | PageCleanup;

const app = document.getElementById('app')!;
let cleanup: PageCleanup | null = null;

async function render(): Promise<void> {
  const { name, params } = parseHash();
  if (cleanup) { cleanup(); cleanup = null; }
  app.innerHTML = '';
  const page = document.createElement('div');
  page.className = 'page-root';
  app.appendChild(page);
  if (name === '/workbench') {
    cleanup = await renderWorkbench(page, params) ?? null;
  } else if (name === '/settings') {
    renderTopbar(page, 'settings');
    cleanup = renderSettings(page, params) ?? null;
  } else {
    renderTopbar(page, 'welcome');
    cleanup = renderWelcome(page, params) ?? null;
  }
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

/* 命令面板（Ctrl+T）：全局组件，挂载后不随页面重渲染销毁 */
initCommandPanel();
