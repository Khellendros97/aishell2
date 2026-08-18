/**
 * 应用入口(React 版):语义对照旧版 src/main.ts。
 * - 主题先行(避免首屏亮暗闪烁)、无 hash 时按配置完整度跳转;
 * - OS 文件拖入全局兜底(dragDropEnabled:false 后 WebView2 默认行为是导航到拖入文件);
 * - 禁用 WebView2 原生右键菜单(输入框放行);F12 打开 DevTools(应用自控);
 * - 命令面板 / Debug 日志总线为自包含命令式浮层,保持旧模块不动,继续在此初始化。
 */
import './styles/design.css';
import { createRoot } from 'react-dom/client';
import { getState, isConfigComplete, openDevtools } from './api';
import { initCommandPanel } from './command-panel';
import { initDebug } from './debug';
import { initUpdates } from './updates';
import { navigate } from './router';
import { applyTheme } from './theme';
import { ErrorBoundary } from './shared/ErrorBoundary';
import App from './App';

async function boot(): Promise<void> {
  /* 先取 settings.theme 应用,避免首屏亮暗闪烁;失败保持默认深色 */
  try { applyTheme((await getState()).settings.theme); } catch { /* 后端未就绪 */ }
  if (!location.hash) {
    let ok = false;
    try { ok = await isConfigComplete(); } catch { /* 后端未就绪时按缺配处理 */ }
    navigate(ok ? '#/welcome' : '#/settings?reason=missing-config');
  }
  createRoot(document.getElementById('app')!).render(<ErrorBoundary><App /></ErrorBoundary>);
}

/* OS 文件拖入的全局兜底:各面板自己的 drop handler 先行执行不受影响。 */
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

/* 禁用 WebView2 原生右键菜单(刷新/检查等浏览器项与应用无关)。
   输入框放行原生菜单(拼写/撤销/粘贴是刚需);
   各面板自定义菜单(explorer/sftp/terminal)在目标元素上 preventDefault + stopPropagation,
   冒泡不到这里,不受影响。 */
document.addEventListener('contextmenu', (e) => {
  if ((e.target as HTMLElement).closest('input, textarea:not(.xterm-helper-textarea)')) return;
  e.preventDefault();
});

/* F12 打开 DevTools:浏览器快捷键已被后端禁用(会劫持终端 Ctrl+Shift+C/V),改为应用自控 */
document.addEventListener('keydown', (e) => {
  if (e.key === 'F12') {
    e.preventDefault();
    void openDevtools();
  }
});

/* 命令面板(Ctrl+T / Ctrl+P):全局组件,不随路由重渲染销毁 */
initCommandPanel();
/* Debug 日志总线:启动即订阅后端 debug:log(面板未开也留历史) */
void initDebug();
/* 更新状态总线:拉一次 update_status 并订阅事件(Topbar 徽标/设置页「关于与更新」共用) */
initUpdates();

void boot();
