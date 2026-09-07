/**
 * 系统通知（Windows toast）：AI 助手事件与耗时操作完成的统一通知出口。
 * 无 .proto 对照，全新功能。
 * 与后端的接口点：自定义命令 `system_notify`（src-tauri/src/notify.rs，tauri-winrt-notification
 * 直接发 WinRT toast）——插件的 JS sendNotification 是 WebView2 Web Notification API
 * （new window.Notification），重复通知会被 WebView2 通知层吞掉（实测只有第一条弹出），
 * 插件 Rust 命令又接不到 on_activated（无法点击聚焦），故改走自有命令；
 * 开关持久化在 Settings.notifyAi / notifyLongTasks（store.rs），本模块经 getState 惰性读取并缓存，
 * 订阅 `aishell:data-changed`（设置页保存后广播）刷新。
 * 发送策略（产品确认）：仅 AIShell 窗口未聚焦时发送——应用内已有 toast / 审批卡片，
 * 聚焦时不重复打扰；耗时操作门槛 ≥30 秒（NOTIFY_MIN_MS，由 statusbar-progress 按任务时长判定后调用）。
 * 任何失败静默降级（console.warn 留痕），绝不影响主流程。
 */
import { invoke } from '@tauri-apps/api/core';
import { getState } from '../api';

/** 耗时操作通知门槛：任务持续超过该时长，完成时才发通知（秒级小操作不打扰） */
export const NOTIFY_MIN_MS = 30_000;

let aiOn = true;
let longTasksOn = true;
let loaded = false;
let loading: Promise<void> | null = null;

async function refresh(): Promise<void> {
  try {
    const s = await getState();
    aiOn = s.settings.notifyAi ?? true;
    longTasksOn = s.settings.notifyLongTasks ?? true;
    loaded = true;
  } catch { /* 后端未就绪：保持默认开启，下次通知前再取 */ }
}

function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) loading = refresh().finally(() => { loading = null; });
  return loading;
}

/* 设置页保存后广播（Settings.save）；模块级订阅一次（单页应用，生命周期 = webview）。
   先失效缓存再预取，下一次通知用新开关值 */
window.addEventListener('aishell:data-changed', () => { loaded = false; void ensureLoaded(); });

/** 走自有 Rust 命令发 WinRT toast（notify.rs：图标用应用 logo 覆盖，点击聚焦主窗口） */
async function send(title: string, body: string): Promise<void> {
  try {
    await invoke('system_notify', { title, body });
  } catch (err) {
    console.warn('[notify] 系统通知发送失败:', err);
  }
}

/** 发送前统一闸门：开关 + 窗口焦点（聚焦时用户正看着应用，不打扰） */
function notify(kind: 'ai' | 'long', title: string, body: string): void {
  void (async () => {
    await ensureLoaded();
    if (kind === 'ai' ? !aiOn : !longTasksOn) return;
    if (document.hasFocus()) return;
    await send(title, body);
  })();
}

/** AI 助手通知：等待审批 / ask、confirm 提问 / 任务完成（ai-engine.ts 事件分支调用） */
export function notifyAi(title: string, body: string): void {
  notify('ai', title, body);
}

/** 耗时操作通知：上传/下载/备份/暂存等长操作完成（statusbar-progress.ts 完成点调用） */
export function notifyLongTask(title: string, body: string): void {
  notify('long', title, body);
}

/** 通知正文裁剪：取首个非空行，按码点截断（中文/emoji 不截半字符） */
export function clipBody(s: string, max = 80): string {
  const line = s.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const cps = Array.from(line);
  return cps.length > max ? `${cps.slice(0, max).join('')}…` : line;
}
