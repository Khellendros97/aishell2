/**
 * 服务器面板 —— 移植自 .proto/workbench-sidebar.js「面板 2：服务器列表」。
 * 渲染当前项目绑定的服务器卡片；SSH 连接 / SFTP 标签页；bus.on('project-changed') 重渲染。
 * 与原型差异：不做在线状态探活（计划明确去掉随机 mock 状态点），认证方式以 tag 呈现。
 * 侧栏框架契约：导出 head 描述符（title），mountServersPanel(container) 只渲染内容区。
 */
import type { Server } from '../../../types';
import { icon } from '../../../icons';
import { getState } from '../../../api';
import { navigate } from '../../../router';
import { bus, openTab, Workbench } from '../core';
import './servers.css';

export const serversHead = { title: '服务器列表' };

const esc = (s: string | number): string =>
  String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);

export function mountServersPanel(container: HTMLElement): void {
  const render = async (): Promise<void> => {
    let servers: Server[] = [];
    try {
      servers = (await getState()).servers;
    } catch {
      /* 后端未就绪时按空列表渲染 */
    }
    const project = Workbench.state.project;
    const ids = project?.serverIds ?? [];
    const bound = servers.filter((s) => ids.includes(s.id));

    container.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wbs-content';

    /* 固定卡片：本地 Git Bash，整卡点击打开本地终端（与启动时自动开的 term-local 同 id，重复点击复用聚焦） */
    const localCard = document.createElement('div');
    localCard.className = 'card wbs-server-card wbs-local-card clickable';
    localCard.innerHTML =
      '<div class="wbs-server-top">' +
        '<span class="wbs-server-name">本地 Git Bash</span>' +
        '<span class="tag blue">' + icon('terminal') + ' 本地</span>' +
      '</div>' +
      '<div class="wbs-server-addr mono">本地终端 · 点击打开</div>';
    localCard.onclick = () => {
      openTab({
        id: 'term-local',
        type: 'terminal',
        title: '本地 Git Bash',
        data: { kind: 'local', cwd: project?.path ?? null },
      });
    };
    wrap.appendChild(localCard);

    if (!bound.length) {
      const es = document.createElement('div');
      es.className = 'empty-state';
      es.innerHTML = `<div class="icon">${icon('monitor')}</div><div>该项目尚未绑定服务器</div>`
        + '<div style="font-size:11.5px">可前往「设置」为项目绑定远程服务器</div>';
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = '前往设置绑定';
      btn.onclick = () => navigate('#/settings');
      es.appendChild(btn);
      wrap.appendChild(es);
      container.appendChild(wrap);
      return;
    }
    const sep = document.createElement('div');
    sep.className = 'wbs-local-sep';
    sep.textContent = '远程服务器';
    wrap.appendChild(sep);
    bound.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'card wbs-server-card';
      card.innerHTML =
        '<div class="wbs-server-top">' +
          '<span class="wbs-server-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
          '<span class="tag">' + icon(s.authType === 'key' ? 'key' : 'lock') + ' ' + (s.authType === 'key' ? '密钥' : '密码') + '</span>' +
        '</div>' +
        '<div class="wbs-server-addr mono">' + esc(s.host) + ':' + esc(s.port) + '</div>' +
        '<div class="wbs-server-actions">' +
          '<button class="btn small wbs-ssh">SSH 连接</button>' +
          '<button class="btn small wbs-sftp">SFTP 文件管理</button>' +
        '</div>';
      (card.querySelector('.wbs-ssh') as HTMLButtonElement).onclick = () => {
        openTab({
          id: 'term:' + s.id,
          type: 'terminal',
          title: s.name,
          data: { kind: 'ssh', serverId: s.id },
        });
      };
      (card.querySelector('.wbs-sftp') as HTMLButtonElement).onclick = () => {
        openTab({
          id: 'sftp:' + s.id,
          type: 'sftp',
          title: 'SFTP ' + s.name,
          data: { serverId: s.id },
        });
      };
      wrap.appendChild(card);
    });
    container.appendChild(wrap);
  };

  void render();
  bus.on('project-changed', () => { void render(); });
}
