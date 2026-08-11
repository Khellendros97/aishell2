/**
 * 顶栏组件:移植自 .proto/shared/mock.js 的 renderTopbar,导航改走 hash 路由。
 * 无边框窗口(decorations:false)下兼作自绘标题栏:整条 bar 标记 data-tauri-drag-region 拖拽；
 * Windows 会原生处理拖拽区双击最大化，前端不再重复调用 toggleMaximize；
 * 右侧内嵌最小化 / 最大化-还原 / 关闭按钮，交互元素不会误拖。
 */
import { getCurrentWindow } from '@tauri-apps/api/window';
import { getVersion } from '@tauri-apps/api/app';
import { icon } from '../icons';
import { navigate } from '../router';
import { onCloudChanged, setTheme } from '../api';
import { applyTheme, currentTheme, onThemeChange } from '../theme';
import { toast } from '../ui';
import { wbLifecycle } from '../pages/workbench/lifecycle';

export type TopbarPage = 'welcome' | 'settings' | 'account' | null;

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
    <div class="brand"><img class="logo" src="${appLogoUrl}" alt="AIShell"><span>AIShell</span><span class="tb-version"></span></div>
    <div class="spacer"></div>
    <button class="btn ghost small" data-nav="welcome">项目</button>
    <button class="btn ghost small" data-nav="settings">设置</button>
    <button class="btn ghost small tb-account" data-nav="account">账号<span class="tb-badge" hidden></span></button>
    <button class="icon-btn tb-theme" title="切换亮色 / 深色主题"></button>
    <div class="tb-win-controls">
      <button class="tb-win-btn tb-win-min" title="最小化">${icon('minus')}</button>
      <button class="tb-win-btn tb-win-max" title="最大化 / 还原">${icon('square')}</button>
      <button class="tb-win-btn tb-win-close" title="关闭">${icon('x')}</button>
    </div>`;
  (bar.querySelector('[data-nav=welcome]') as HTMLButtonElement).onclick = () => navigate('#/welcome');
  (bar.querySelector('[data-nav=settings]') as HTMLButtonElement).onclick = () => navigate('#/settings');
  (bar.querySelector('[data-nav=account]') as HTMLButtonElement).onclick = () => navigate('#/account');

  /* 账号角标（CR-2.4）：托管模式 + 未登录（登录失效）时提示「重新登录」。
     topbar 随路由重建，订阅在按钮失联后自退订防泄漏（同主题按钮模式）。 */
  const accountBtn = bar.querySelector('.tb-account') as HTMLButtonElement;
  const badge = bar.querySelector('.tb-badge') as HTMLSpanElement;
  const syncBadge = (loggedIn: boolean, mode: string, configured: boolean) => {
    const need = configured && mode === 'hosted' && !loggedIn;
    badge.hidden = !need;
    if (need) badge.title = '登录已过期，请重新登录';
  };
  const offCloud = onCloudChanged((s) => {
    if (!accountBtn.isConnected) { void offCloud.then((un) => un()).catch(() => {}); return; }
    syncBadge(s.loggedIn, s.mode, s.serverUrl !== null);
  }).catch(() => () => {});
  // 初始态：拉一次状态填充角标（失败静默，未接入/未登录无角标）
  import('../api').then(({ cloudStatus }) =>
    cloudStatus().then((s) => {
      if (!accountBtn.isConnected) return;
      syncBadge(s.loggedIn, s.mode, s.serverUrl !== null);
    }).catch(() => {}),
  );

  /* 版本号(tauri.conf.json version,异步填充;失败静默留空) */
  getVersion()
    .then((v) => { (bar.querySelector('.tb-version') as HTMLSpanElement).textContent = `v${v}`; })
    .catch(() => { /* 版本号获取失败不影响顶栏 */ });
  if (activePage) {
    const btn = bar.querySelector(`[data-nav=${activePage}]`);
    if (btn) btn.classList.remove('ghost');
  }

  /* 「返回工作台」箭头:仅 welcome/settings 且工作台有保活项目时出现(见 lifecycle.ts);
     点击经路由复用保活实例,标签页全部保留 */
  if (activePage && wbLifecycle.projectId) {
    const back = document.createElement('button');
    back.className = 'icon-btn tb-back';
    back.title = '返回工作台';
    back.innerHTML = icon('arrowLeft');
    back.onclick = () => navigate(`#/workbench?project=${wbLifecycle.projectId}`);
    bar.prepend(back);
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
