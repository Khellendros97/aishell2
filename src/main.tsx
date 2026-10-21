/**
 * 应用入口(React 版):语义对照旧版 src/main.ts。
 * - 主题先行(避免首屏亮暗闪烁)、无 hash 时按配置完整度跳转;
 * - OS 文件拖入全局兜底(dragDropEnabled:false 后 WebView2 默认行为是导航到拖入文件);
 * - 禁用 WebView2 原生右键菜单(输入框放行);F12 打开 DevTools(应用自控);
 * - AI 任务未结束时拦截窗口关闭,弹确认框二次确认(anyAiBusy + onCloseRequested);
 *   分离窗口(label = ai-detach)关闭即聚合:先 flush 正式会话快照再销毁,不弹确认;
 * - 命令面板 / Debug 日志总线为自包含命令式浮层,保持旧模块不动,继续在此初始化。
 */
import './styles/design.css';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { aiAnyBusy, aiWindowClose, getState, isConfigComplete, onTrayExitRequest, openDevtools, trayAvailable } from './api';
import { initCommandPanel } from './command-panel';
import { initDebug } from './debug';
import { initUpdates } from './updates';
import { navigate } from './router';
import { applyTheme } from './theme';
import { confirmDialog } from './ui';
import {
  anyAiBusy, currentDetachedAiSessionId, flushAiPendingOutput, flushAiSessionSnapshots,
} from './pages/workbench/ai/ai-engine';
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
   - 分离窗口(label = ai-detach):关闭即聚合——onCloseRequested 先 flush 正式消息，
     再由 ai_window_close 记录当前会话并 destroy；宿主 ctx 全程在线收流，AI 忙也不弹确认。
   - 主窗口:
     · closeToTray 开启且托盘可用:关闭 = 隐藏到托盘(Rust 侧 prevent_close + hide,窗口
       不销毁,会话继续在后台运行),这里 preventDefault 拦下 JS 默认 destroy、不弹 AI 忙
       确认;托盘创建失败(查询 tray_available 为 false)时照常走下面的关窗流程。
       托盘菜单「退出 AIShell」经 tray:exit-request 事件回到确认 + 落盘 + destroy 流程。
     · closeToTray 关闭:有任务(anyAiBusy 本窗口常驻上下文——分离后 ctx 仍在收流,天然覆盖
       分离窗口的忙态;外加 aiAnyBusy 后端进程表兜底)一律 preventDefault 拦下,弹确认框;确认后
       先带走分离窗口再 destroy() 强制关闭——destroy 不再触发 closeRequested(不会递归回本守卫),
       后端退出收尾(exit_cleanup_if_last_window)照常执行。无任务放行前也要调 ai_window_close
       兜底带走分离窗口,否则主窗口销毁后的退出收尾会 kill_all pi,分离窗口沦为僵尸。
       确认框打开期间的再次关闭请求也拦下(不重复弹框,也不放行——否则第二击会绕过未确认的
       对话框直接关窗)。无 Tauri 环境(纯浏览器)静默跳过。 */
let closeGuardDialogOpen = false;
void (async () => {
  let win: ReturnType<typeof getCurrentWindow>;
  try {
    win = getCurrentWindow();
  } catch { return; } // 无 Tauri 注入(vite dev 纯浏览器调试):无窗口概念,跳过
  if (win.label === 'ai-detach') {
    /* X 关闭与面板「聚合」都必须先落盘正式消息。后端 ai_window_close 使用 destroy，
       不会再次进入本守卫；正在生成的 pending 不定稿，交给宿主上下文继续续流。 */
    let closeStarted = false;
    await win.onCloseRequested(async (event) => {
      event.preventDefault();
      if (closeStarted) return;
      closeStarted = true;
      try {
        await flushAiSessionSnapshots();
        await aiWindowClose(currentDetachedAiSessionId());
      } catch (err) {
        closeStarted = false;
        console.error('[AI] 聚合窗口关闭失败:', err);
      }
    });
    return;
  }

  /* 强制退出:带走分离窗口 → 落盘未定稿正文 → destroy(触发 Destroyed 收尾) */
  const forceQuit = async (): Promise<void> => {
    await aiWindowClose().catch(() => { /* 分离窗口可能已自行关闭 */ });
    /* 关闭前把已流出但未定稿的助手正文落盘（await 到写入完成再销毁窗口，
       否则进程退出后该段正文永久丢失）。分离是双端订阅，本窗口 ctx 已含分离窗口
       的 pending，无需单独处理对方。 */
    await flushAiPendingOutput().catch(() => { /* 落盘失败不阻塞关闭 */ });
    await win.destroy();
  };

  /* 托盘「退出」与 AI 忙时的关闭确认共用：有任务先二次确认，无任务直接退出 */
  const confirmAndQuit = async (): Promise<void> => {
    const backendBusy = await aiAnyBusy().catch(() => false);
    if (!anyAiBusy() && !backendBusy) {
      await forceQuit();
      return;
    }
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
    if (confirmed) await forceQuit();
  };

  try {
    await win.onCloseRequested(async (event) => {
      /* 关闭即隐藏到托盘:Rust 侧已 prevent_close + hide,窗口与全部会话继续存活。
         必须 preventDefault——Tauri 的 JS onCloseRequested 在未拦截时会主动 destroy()
         窗口(绕过 Rust 的 hide);同时先查托盘是否真的可用,创建失败时放行关窗。 */
      const closeToTray = await getState().then((s) => s.settings.closeToTray).catch(() => false);
      if (closeToTray && (await trayAvailable().catch(() => false))) {
        event.preventDefault();
        return;
      }
      const backendBusy = await aiAnyBusy().catch(() => false);
      if (!anyAiBusy() && !backendBusy) {
        await aiWindowClose().catch(() => { /* 无分离窗口时为 no-op */ });
        return; // 无 AI 任务:放行,不弹框
      }
      event.preventDefault();
      await confirmAndQuit(); // 忙态可能在等待期间变化,复用内部的最新判定
    });
    /* 托盘右键「退出 AIShell」:后端已先显示主窗口,这里复用忙态确认流程 */
    await onTrayExitRequest(() => { void confirmAndQuit(); });
  } catch { /* 无 Tauri 注入(vite dev 纯浏览器调试):无窗口概念,跳过 */ }
})();

/* 命令面板(Ctrl+T / Ctrl+P):全局组件,不随路由重渲染销毁;AI 分离窗口跳过
   (命令面板的动作面向工作台/欢迎页布局,独立 AI 窗口里无意义) */
try {
  if (getCurrentWindow().label !== 'ai-detach') initCommandPanel();
} catch { /* 无 Tauri 注入:照常初始化 */ }
/* Debug 日志总线:启动即订阅后端 debug:log(面板未开也留历史) */
void initDebug();
/* 更新状态总线:拉一次 update_status 并订阅事件(Topbar 徽标/设置页「关于与更新」共用) */
initUpdates();

void boot();
