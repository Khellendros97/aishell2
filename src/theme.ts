/**
 * 全局界面主题（深色 / 亮色）。
 * 事实源在后端 settings.theme（src-tauri store.rs）；本模块只持有当前生效值的内存副本。
 * 切换路径：applyTheme 立即生效（<html data-theme> + 广播）→ 调用方负责 setTheme 持久化。
 * 变量覆盖在 design.css `:root[data-theme='light']`；终端 / 编辑器经 onThemeChange 联动。
 */
export type Theme = 'dark' | 'light';

let current: Theme = 'dark';
const listeners = new Set<(t: Theme) => void>();

export function currentTheme(): Theme {
  return current;
}

/** 应用主题：更新 <html data-theme>（CSS 变量切换）并广播给 xterm / CodeMirror 等监听器 */
export function applyTheme(t: Theme): void {
  current = t;
  document.documentElement.dataset.theme = t;
  listeners.forEach((cb) => cb(t));
}

/** 订阅主题切换；返回退订函数（长生命周期模块可不退订，同 core.ts bus 的用法惯例） */
export function onThemeChange(cb: (t: Theme) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
