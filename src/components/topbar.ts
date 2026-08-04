/**
 * 顶栏组件:移植自 .proto/shared/mock.js 的 renderTopbar,导航改走 hash 路由。
 * 无边框窗口(decorations:false)下兼作自绘标题栏:整条 bar 标记 data-tauri-drag-region 拖拽；
 * Windows 会原生处理拖拽区双击最大化，前端不再重复调用 toggleMaximize；
 * 右侧内嵌最小化 / 最大化-还原 / 关闭按钮，交互元素不会误拖。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { icon } from '../icons';
import { navigate } from '../router';
import { setTheme } from '../api';
import { applyTheme, currentTheme, onThemeChange } from '../theme';
import { toast } from '../ui';

export type TopbarPage = 'welcome' | 'settings' | null;

const appWin = getCurrentWindow();
const appLogoUrl = new URL('../assets/logo.svg', import.meta.url).href;

/** 按当前最大化状态切换 max 按钮图标(topbar 随路由重建,故每次从 document 现查按钮) */
function syncMaxIcon(maximized: boolean): void {
  const btn = document.querySelector('.tb-win-max');
  if (btn) btn.innerHTML = maximized ? icon('restore') : icon('square');
}

/* 模块级注册一次:Win+方向键等系统途径触发的最大化也要同步图标 */
void appWin.onResized(() => {
  void appWin.isMaximized().then(syncMaxIcon);
});

export function renderTopbar(root: HTMLElement, activePage: TopbarPage): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'page-topbar';
  bar.setAttribute('data-tauri-drag-region', '');
  bar.innerHTML = `
    <div class="brand"><img class="logo" src="${appLogoUrl}" alt="AIShell"><span>AIShell</span></div>
    <div class="spacer"></div>
    <button class="btn ghost small" data-nav="welcome">项目</button>
    <button class="btn ghost small" data-nav="settings">设置</button>
    <button class="icon-btn tb-theme" title="切换亮色 / 深色主题"></button>
    <div class="tb-win-controls">
      <button class="tb-win-btn tb-win-min" title="最小化">${icon('minus')}</button>
      <button class="tb-win-btn tb-win-max" title="最大化 / 还原">${icon('square')}</button>
      <button class="tb-win-btn tb-win-close" title="关闭">${icon('x')}</button>
    </div>`;
  (bar.querySelector('[data-nav=welcome]') as HTMLButtonElement).onclick = () => navigate('#/welcome');
  (bar.querySelector('[data-nav=settings]') as HTMLButtonElement).onclick = () => navigate('#/settings');
  if (activePage) {
    const btn = bar.querySelector(`[data-nav=${activePage}]`);
    if (btn) btn.classList.remove('ghost');
  }

  /* 主题快捷切换:立即生效(含终端/编辑器联动),后台持久化;失败回滚 */
  const themeBtn = bar.querySelector('.tb-theme') as HTMLButtonElement;
  const syncThemeIcon = () => { themeBtn.innerHTML = icon(currentTheme() === 'dark' ? 'sun' : 'moon'); };
  syncThemeIcon();
  /* 设置页 select 等其他入口切主题时同步图标;topbar 随路由重建,脱节后自退订防泄漏 */
  const offTheme = onThemeChange(() => {
    if (!themeBtn.isConnected) { offTheme(); return; }
    syncThemeIcon();
  });
  themeBtn.onclick = () => {
    const prev = currentTheme();
    const next = prev === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    syncThemeIcon();
    setTheme(next).catch((err) => {
      applyTheme(prev);
      syncThemeIcon();
      toast(`主题保存失败: ${String(err)}`, 'error');
    });
  };

  (bar.querySelector('.tb-win-min') as HTMLButtonElement).onclick = () => { void appWin.minimize(); };
  (bar.querySelector('.tb-win-max') as HTMLButtonElement).onclick = () => { void appWin.toggleMaximize(); };
  (bar.querySelector('.tb-win-close') as HTMLButtonElement).onclick = () => { void appWin.close(); };
  void appWin.isMaximized().then(syncMaxIcon);

  root.prepend(bar);
  return bar;
}
