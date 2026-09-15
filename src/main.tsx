/**
 * 应用入口(React 版):语义对照旧版 src/main.ts。
 * - 主题先行(避免首屏亮暗闪烁)、无 hash 时按配置完整度跳转;
 * - OS 文件拖入全局兜底(dragDropEnabled:false 后 WebView2 默认行为是导航到拖入文件);
 * - 禁用 WebView2 原生右键菜单(输入框放行);F12 打开 DevTools(应用自控);
 * - AI 任务未结束时拦截窗口关闭,弹确认框二次确认(anyAiBusy + onCloseRequested);
 *   分离窗口(label = ai-detach)关闭即聚合:先释放项目上下文再放行,不弹确认;
 * - 命令面板 / Debug 日志总线为自包含命令式浮层,保持旧模块不动,继续在此初始化。
 */
import './styles/design.css';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { aiAnyBusy, aiWindowClose, getState, isConfigComplete, openDevtools } from './api';
import { initCommandPanel } from './command-panel';
import { initDebug } from './debug';
import { navigate } from './router';
import { applyTheme } from './theme';
import { confirmDialog } from './ui';
import { anyAiBusy } from './pages/workbench/ai/ai-engine';
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

/* ---------- 程序关闭二次确认:AI 助手任务尚未结束时先拦截 ---------- */
/* 按窗口分两种角色：
   - 分离窗口(label = ai-detach):关闭即聚合——直接放行(api 层随后 destroy,后端 Destroyed
     广播 ai:window-changed 让宿主还原面板);分离是双端订阅,宿主 ctx 全程在线收流,
     关闭不影响任务,故 AI 忙也不弹确认。
   - 主窗口:有任务(anyAiBusy 本窗口常驻上下文——分离后 ctx 仍在收流,天然覆盖分离窗口的
     忙态;外加 aiAnyBusy 后端进程表兜底)一律 preventDefault 拦下,弹确认框;确认后先带走
     分离窗口再 destroy() 强制关闭——destroy 不再触发 closeRequested(不会递归回本守卫),
     后端退出收尾(exit_cleanup_if_last_window)照常执行。无任务放行前也要调 ai_window_close
     兜底带走分离窗口,否则主窗口销毁后的退出收尾会 kill_all pi,分离窗口沦为僵尸。
     确认框打开期间的再次关闭请求也拦下(不重复弹框,也不放行——否则第二击会绕过未确认的
     对话框直接关窗)。无 Tauri 环境(纯浏览器)静默跳过。 */
let closeGuardDialogOpen = false;
void (async () => {
  let win: ReturnType<typeof getCurrentWindow>;
  try {
    win = getCurrentWindow();
    const isDetachWindow = win.label === 'ai-detach';
    await win.onCloseRequested(async (event) => {
      if (isDetachWindow) return; // 关闭即聚合:直接放行
      const backendBusy = await aiAnyBusy().catch(() => false);
      if (!anyAiBusy() && !backendBusy) {
        await aiWindowClose().catch(() => { /* 无分离窗口时为 no-op */ });
        return; // 无 AI 任务:放行,不弹框
      }
      event.preventDefault();
      if (closeGuardDialogOpen) return;
      closeGuardDialogOpen = true;
      let confirmed = false;
      try {
        confirmed = await confirmDialog({
          title: 'AI 任务尚未结束',
          message: 'AI 助手仍在生成回复或等待你的确认，关闭将中断进行中的任务。确定要关闭 AIShell 吗？',
          danger: true,
          okText: '仍然关闭',
        });
      } finally {
        closeGuardDialogOpen = false;
      }
      if (confirmed) {
        await aiWindowClose().catch(() => { /* 分离窗口可能已自行关闭 */ });
        await win.destroy();
      }
    });
  } catch { /* 无 Tauri 注入(vite dev 纯浏览器调试):无窗口概念,跳过 */ }
})();

/* 命令面板(Ctrl+T / Ctrl+P):全局组件,不随路由重渲染销毁;AI 分离窗口跳过
   (命令面板的动作面向工作台/欢迎页布局,独立 AI 窗口里无意义) */
try {
  if (getCurrentWindow().label !== 'ai-detach') initCommandPanel();
} catch { /* 无 Tauri 注入:照常初始化 */ }
/* Debug 日志总线:启动即订阅后端 debug:log(面板未开也留历史) */
void initDebug();

void boot();
