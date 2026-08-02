/** 应用入口：hash 路由 + 启动缺配跳转（语义同 .proto/index.html）。 */
import './styles/design.css';
import { navigate, onRoute, parseHash } from './router';
import { isConfigComplete } from './api';
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

void boot();
