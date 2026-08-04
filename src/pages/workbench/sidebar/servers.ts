/**
 * 服务器面板 —— 移植自 .proto/workbench-sidebar.js「面板 2：服务器列表」。
 * 渲染当前项目绑定的服务器卡片；SSH 连接 / SFTP 标签页；bus.on('project-changed') 重渲染。
 * 新增：标题行「新建」按钮 → 面板内联模态框创建服务器，创建成功后立即绑定到当前项目
 * （upsert_server + upsert_project，与设置页表单同字段语义：密码留空 = 不写入 keyring）。
 * 与原型差异：不做在线状态探活（计划明确去掉随机 mock 状态点），认证方式以 tag 呈现。
 * 侧栏框架契约：导出 head 描述符（title），mountServersPanel(container) 只渲染内容区。
 */
import type { Server } from '../../../types';
import { icon } from '../../../icons';
import { getState, upsertProject, upsertServer } from '../../../api';
import { bus, openTab, Workbench } from '../core';
import { toast, uid } from '../../../ui';
import './servers.css';

export const serversHead = { title: '服务器列表' };

const esc = (s: string | number): string =>
  String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);

export function mountServersPanel(container: HTMLElement): void {
  /* ---------- 新建服务器模态框（一次性建 DOM，复用全局 .modal-mask/.modal/.field 样式） ---------- */
  container.insertAdjacentHTML('beforeend', `
    <div class="modal-mask hidden" id="srv-modal">
      <div class="modal">
        <div class="modal-head">
          <h3>新建服务器连接</h3>
          <button id="srv-modal-close" class="icon-btn" title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>服务器名称<span class="req">*</span></label>
            <input id="srv-f-name" class="input" placeholder="例如：生产-Web-01">
          </div>
          <div class="field">
            <label>IP 地址<span class="req">*</span></label>
            <input id="srv-f-host" class="input mono" placeholder="例如：47.102.118.66">
          </div>
          <div class="field">
            <label>SSH 端口<span class="req">*</span></label>
            <input id="srv-f-port" class="input mono" type="number" min="1" max="65535" value="22">
          </div>
          <div class="field">
            <label>认证方式<span class="req">*</span></label>
            <select id="srv-f-auth" class="select">
              <option value="password">账号密码</option>
              <option value="key">密钥</option>
            </select>
          </div>
          <div class="field">
            <label>账号<span class="req">*</span></label>
            <input id="srv-f-username" class="input" placeholder="例如：deploy">
          </div>
          <div class="field" data-auth="password">
            <label>密码</label>
            <input id="srv-f-password" class="input" type="password" placeholder="留空则不保存">
          </div>
          <div class="field" data-auth="key">
            <label>密钥文件路径</label>
            <input id="srv-f-keypath" class="input mono" placeholder="C:\\Users\\demo\\.ssh\\id_ed25519">
          </div>
        </div>
        <div class="modal-foot">
          <button id="srv-modal-cancel" class="btn">取消</button>
          <button id="srv-modal-save" class="btn primary">创建并绑定到当前项目</button>
        </div>
      </div>
    </div>
  `);

  const modal = container.querySelector('#srv-modal') as HTMLElement;
  const fName = container.querySelector('#srv-f-name') as HTMLInputElement;
  const fHost = container.querySelector('#srv-f-host') as HTMLInputElement;
  const fPort = container.querySelector('#srv-f-port') as HTMLInputElement;
  const fAuth = container.querySelector('#srv-f-auth') as HTMLSelectElement;
  const fUsername = container.querySelector('#srv-f-username') as HTMLInputElement;
  const fPassword = container.querySelector('#srv-f-password') as HTMLInputElement;
  const fKeyPath = container.querySelector('#srv-f-keypath') as HTMLInputElement;

  function syncAuthFields(): void {
    const mode = fAuth.value;
    modal.querySelectorAll('.field[data-auth]').forEach((field) => {
      field.classList.toggle('hidden', field.getAttribute('data-auth') !== mode);
    });
  }

  function openModal(): void {
    // 每次打开重置表单（密码/密钥路径不留上次输入）
    fName.value = '';
    fHost.value = '';
    fPort.value = '22';
    fAuth.value = 'password';
    fUsername.value = '';
    fPassword.value = '';
    fKeyPath.value = '';
    syncAuthFields();
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.add('open'));
    fName.focus();
  }

  function closeModal(): void {
    modal.classList.remove('open');
    setTimeout(() => modal.classList.add('hidden'), 160);
  }

  async function saveNewServer(): Promise<void> {
    const name = fName.value.trim();
    const host = fHost.value.trim();
    if (!name || !host) {
      toast('请填写服务器名称与 IP 地址', 'error');
      return;
    }
    const server: Server = {
      id: uid('srv'),
      name,
      host,
      port: Number(fPort.value) || 22,
      authType: fAuth.value as Server['authType'],
      username: fUsername.value.trim(),
      keyPath: fAuth.value === 'key' ? fKeyPath.value.trim() : '',
    };
    const password = fAuth.value === 'password' ? fPassword.value : null;
    try {
      await upsertServer(server, password);
      // 创建成功后立即绑定到当前项目（内存同步 + 落盘 + 通知各面板刷新）
      const project = Workbench.state.project;
      if (project) {
        if (!project.serverIds.includes(server.id)) {
          project.serverIds.push(server.id);
          await upsertProject(project);
        }
        bus.emit('project-changed');
      }
      closeModal();
      toast(`服务器「${name}」已创建并绑定到当前项目`, 'success');
    } catch (err) {
      toast(`创建服务器失败: ${String(err)}`, 'error');
    }
  }

  modal.querySelector('#srv-modal-close')!.addEventListener('click', closeModal);
  modal.querySelector('#srv-modal-cancel')!.addEventListener('click', closeModal);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
  fAuth.addEventListener('change', syncAuthFields);
  modal.querySelector('#srv-modal-save')!.addEventListener('click', () => { void saveNewServer(); });
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  };
  document.addEventListener('keydown', onKeydown);

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

    /* 复用内容容器：模态框是 container 直子节点，绝不能整清空（否则新建表单随列表刷新被移除） */
    let wrap = container.querySelector<HTMLElement>('.wbs-content');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'wbs-content';
      container.appendChild(wrap);
    }
    wrap.innerHTML = '';

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

    // 「远程服务器」标题行 + 新建服务器快捷入口（空列表也可新建）
    const head = document.createElement('div');
    head.className = 'wbs-server-head';
    const headTitle = document.createElement('span');
    headTitle.textContent = '远程服务器';
    const newBtn = document.createElement('button');
    newBtn.className = 'btn small';
    newBtn.innerHTML = `${icon('plus')} 新建`;
    newBtn.title = '新建服务器连接并绑定到当前项目';
    newBtn.onclick = openModal;
    head.append(headTitle, newBtn);
    wrap.appendChild(head);

    if (!bound.length) {
      const es = document.createElement('div');
      es.className = 'empty-state';
      es.innerHTML = `<div class="icon">${icon('monitor')}</div><div>该项目尚未绑定服务器</div>`
        + '<div style="font-size:11.5px">点击上方「新建」创建并绑定，或前往「设置」管理全部服务器</div>';
      wrap.appendChild(es);
      container.appendChild(wrap);
      return;
    }
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
