/** 顶栏组件：移植自 .proto/shared/mock.js 的 renderTopbar，导航改走 hash 路由。 */
import { navigate } from '../router';

export type TopbarPage = 'welcome' | 'settings' | null;

export function renderTopbar(root: HTMLElement, activePage: TopbarPage): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'page-topbar';
  bar.innerHTML = `
    <div class="brand"><span class="logo">⌁</span><span>AIShell</span></div>
    <div class="spacer"></div>
    <button class="btn ghost small" data-nav="welcome">项目</button>
    <button class="btn ghost small" data-nav="settings">设置</button>`;
  (bar.querySelector('[data-nav=welcome]') as HTMLButtonElement).onclick = () => navigate('#/welcome');
  (bar.querySelector('[data-nav=settings]') as HTMLButtonElement).onclick = () => navigate('#/settings');
  if (activePage) {
    const btn = bar.querySelector(`[data-nav=${activePage}]`);
    if (btn) btn.classList.remove('ghost');
  }
  root.prepend(bar);
  return bar;
}
