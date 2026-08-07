/**
 * 服务器面板 —— 移植自 .proto/workbench-sidebar.js「面板 2：服务器列表」。
 * 渲染当前项目绑定的服务器卡片；SSH 连接 / SFTP 标签页；bus.on('project-changed') 重渲染。
 * 新增：标题行「新建」按钮 → 面板内联模态框创建服务器，创建成功后立即绑定到当前项目
 * （upsert_server + upsert_project，与设置页表单同字段语义：密码留空 = 不写入 keyring）。
 * 与原型差异：不做在线状态探活（计划明确去掉随机 mock 状态点），认证方式以 tag 呈现。
 * 新增（非原型）：远程服务器支持按 名称/host/账号 搜索；列表平铺展示（服务器不再有目录维度，分类能力已转移给项目）。
 * 侧栏框架契约：导出 head 描述符（title），mountServersPanel(container) 只渲染内容区。
 */
import type { Server } from '../../../types';
import { icon } from '../../../icons';
import { getState, setServerLocked, upsertProject, upsertServer } from '../../../api';
import { bus, openTab, Workbench } from '../core';
import { showContextMenu, toast, uid } from '../../../ui';
import { createServerForm } from '../../server-form';
import './servers.css';

export const serversHead = { title: '服务器列表' };

/** 数据变更监听句柄：面板切换会重建 DOM 但 window 监听不自动消失，重挂载时先移除旧的 */
let dataChangedHandler: (() => void) | null = null;

const esc = (s: string | number): string =>
  String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[c]);

export function mountServersPanel(container: HTMLElement): void {
  /* ---------- 新建 / 编辑服务器模态框（字段与校验逻辑复用 server-form.ts；密码留空 = 保持原值，永不回显） ---------- */
  container.insertAdjacentHTML('beforeend', `
    <div class="modal-mask hidden" id="srv-modal">
      <div class="modal">
        <div class="modal-head">
          <h3 id="srv-modal-title">新建服务器连接</h3>
          <button id="srv-modal-close" class="icon-btn" title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body" id="srv-modal-body"></div>
        <div class="modal-foot">
          <button id="srv-modal-cancel" class="btn">取消</button>
          <button id="srv-modal-save" class="btn primary">创建并绑定到当前项目</button>
        </div>
      </div>
    </div>
  `);

  /* 搜索行（持久元素）：不随列表重建，避免输入焦点丢失 */
  const searchWrap = document.createElement('div');
  searchWrap.className = 'wbs-search';
  const searchInput = document.createElement('input');
  searchInput.className = 'input';
  searchInput.placeholder = '搜索服务器…';
  searchWrap.append(searchInput);
  let searchQuery = ''; // 搜索词（小写，空串 = 显示全部）

  /* ---------- 新建 / 编辑服务器模态框（字段与校验复用 server-form.ts；编辑时密码留空 = 保持 keyring 原值） ---------- */
  const modal = container.querySelector('#srv-modal') as HTMLElement;
  const modalTitle = container.querySelector('#srv-modal-title') as HTMLElement;
  const saveBtn = container.querySelector('#srv-modal-save') as HTMLButtonElement;
  const form = createServerForm(container.querySelector('#srv-modal-body') as HTMLElement);
  let editingServer: Server | null = null; // null = 新建；否则为正在编辑的服务器（预填，密码不回显）

  function openModal(): void {
    editingServer = null;
    modalTitle.textContent = '新建服务器连接';
    saveBtn.textContent = '创建并绑定到当前项目';
    form.fill(null); // 每次打开重置表单（密码/密钥路径不留上次输入）
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.add('open'));
    form.focusFirst();
  }

  /** 编辑入口：预填当前服务器配置（密码永不回显），保存走 upsert_server 且密码留空 = 保持原值 */
  function openEditModal(server: Server): void {
    editingServer = server;
    modalTitle.textContent = '编辑服务器';
    saveBtn.textContent = '保存';
    form.fill(server);
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.add('open'));
    form.focusFirst();
  }

  function closeModal(): void {
    modal.classList.remove('open');
    setTimeout(() => modal.classList.add('hidden'), 160);
  }

  async function saveServer(): Promise<void> {
    const err = form.validate();
    if (err) {
      toast(err, 'error');
      return;
    }
    const isNew = editingServer === null;
    const server = form.buildServer(editingServer);
    try {
      await upsertServer(server, form.passwordValue());
      if (isNew) {
        // 创建成功后立即绑定到当前项目（内存同步 + 落盘 + 通知各面板刷新）
        const project = Workbench.state.project;
        if (project && !project.serverIds.includes(server.id)) {
          project.serverIds.push(server.id);
          await upsertProject(project);
        }
      }
    } catch (err) {
      toast(`${isNew ? '创建' : '保存'}服务器失败: ${String(err)}`, 'error');
      return;
    }
    closeModal();
    bus.emit('project-changed');
    toast(isNew
      ? `服务器「${server.name}」已创建并绑定到当前项目`
      : `服务器「${server.name}」已更新`, 'success');
  }

  modal.querySelector('#srv-modal-close')!.addEventListener('click', closeModal);
  modal.querySelector('#srv-modal-cancel')!.addEventListener('click', closeModal);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
  modal.querySelector('#srv-modal-save')!.addEventListener('click', () => { void saveServer(); });
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  };
  document.addEventListener('keydown', onKeydown);

  /** 把服务器/本地终端引用加入 AI 输入框（@remote:服务器名称 / @local 标签，见 core.ts AiHandle.addServerRef） */
  function addRefToChat(ref: { serverId: string | null; name: string }): void {
    if (Workbench.ai?.addServerRef) {
      Workbench.ai.addServerRef(ref);
    } else {
      toast('AI 面板未就绪');
    }
  }

  const render = async (): Promise<void> => {
    let servers: Server[] = [];
    try {
      const state = await getState();
      servers = state.servers;
    } catch {
      /* 后端未就绪时按空列表渲染 */
    }
    const project = Workbench.state.project;
    const ids = project?.serverIds ?? [];
    const bound = servers.filter((s) => ids.includes(s.id));

    /* 复用内容容器：模态框是 container 直子节点，绝不能整清空（否则新建表单随列表刷新被移除）；
       只清理上次的动态内容（本地卡 / 标题 / 列表容器），持久搜索框保留 */
    let wrap = container.querySelector<HTMLElement>('.wbs-content');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'wbs-content';
      container.appendChild(wrap);
    }
    wrap.querySelectorAll('.wbs-local-card, .wbs-server-head, .wbs-server-list').forEach((el) => el.remove());

    /* 固定卡片：本地终端，整卡点击新开独立本地终端（id `term-local:<uid>`，与启动时自动开的首个实例 'term-local' 并存） */
    const localCard = document.createElement('div');
    localCard.className = 'card wbs-server-card wbs-local-card clickable';
    localCard.innerHTML =
      '<div class="wbs-server-top">' +
        '<span class="wbs-server-icon">' + icon('terminal') + '</span>' +
        '<span class="wbs-server-main">' +
          '<span class="wbs-server-name">本地终端</span>' +
          '<span class="wbs-server-addr mono">本地终端 · 点击打开</span>' +
        '</span>' +
        '<span class="tag blue">本地</span>' +
      '</div>';
    localCard.onclick = () => {
      openTab({
        id: `term-local:${uid('t')}`,
        type: 'terminal',
        title: '本地终端',
        data: { kind: 'local', cwd: project?.path ?? null },
      });
    };
    /* 本地终端卡右键菜单：添加到对话（@local 标签） */
    localCard.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showContextMenu(e.clientX, e.clientY, [
        { label: '添加到对话', iconName: 'chatPlus', action: () => addRefToChat({ serverId: null, name: '本地终端' }) },
      ]);
    });
    /* 必须 prepend：持久搜索框（searchWrap）在重渲染时保留在 wrap 内，
       appendChild 会把本地卡追加到搜索框/列表之后，卡片沉底 */
    wrap.prepend(localCard);

    // 「远程服务器」标题行 + 新建服务器快捷入口（空列表也可新建）
    const head = document.createElement('div');
    head.className = 'wbs-server-head';
    const headTitle = document.createElement('span');
    headTitle.textContent = '远程服务器';
    const headActions = document.createElement('div');
    headActions.className = 'wbs-server-head-actions';
    const newBtn = document.createElement('button');
    newBtn.className = 'btn small';
    newBtn.innerHTML = `${icon('plus')} 新建`;
    newBtn.title = '新建服务器连接并绑定到当前项目';
    newBtn.onclick = openModal;
    headActions.append(newBtn);
    head.append(headTitle, headActions);

    const list = document.createElement('div');
    list.className = 'wbs-server-list';
    if (searchWrap.isConnected) {
      // 搜索框已挂载（后续 render 复用）：绝不移动它 —— appendChild 移动聚焦节点会触发 blur 导致输入丢焦点；
      // 新建的 head / list 分别插到搜索框两侧即可
      wrap.insertBefore(head, searchWrap);
      searchWrap.insertAdjacentElement('afterend', list);
    } else {
      wrap.append(head, searchWrap, list);
    }

    // 搜索过滤：名称 / host / username 大小写不敏感；空串显示全部
    const q = searchQuery;
    const filtered = bound.filter((s) =>
      !q || [s.name, s.host, s.username].some((v) => v.toLowerCase().includes(q))
    );

    if (!filtered.length) {
      const es = document.createElement('div');
      es.className = 'empty-state';
      es.innerHTML = q
        ? `<div class="icon">${icon('monitor')}</div><div>没有匹配「${esc(q)}」的服务器</div>`
        : '<div class="icon">' + icon('monitor') + '</div><div>该项目尚未绑定服务器</div>'
          + '<div style="font-size:11.5px">点击上方「新建」创建并绑定，或前往「设置」管理全部服务器</div>';
      list.appendChild(es);
      return;
    }
    const buildCard = (s: Server) => {
      const card = document.createElement('div');
      card.className = 'card wbs-server-card';
      const lockTitle = s.locked
        ? 'AI 远程操作已锁定，点击解锁（手动 SSH/SFTP 不受影响）'
        : 'AI 远程操作未锁定，点击锁定（手动 SSH/SFTP 不受影响）';
      card.innerHTML =
        '<div class="wbs-server-top">' +
          '<span class="wbs-server-icon">' + icon('server') + '</span>' +
          '<span class="wbs-server-main">' +
            '<span class="wbs-server-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
            '<span class="wbs-server-addr mono">' + esc(s.host) + ':' + esc(s.port) + '</span>' +
          '</span>' +
          '<button class="icon-btn wbs-edit" title="编辑服务器配置" aria-label="编辑服务器配置">' +
            icon('pencil') +
          '</button>' +
          '<button class="icon-btn wbs-lock' + (s.locked ? ' locked' : '') + '" title="' + lockTitle + '" aria-label="' + lockTitle + '" aria-pressed="' + String(s.locked) + '">' +
            icon(s.locked ? 'lock' : 'unlock') +
          '</button>' +
        '</div>' +
        // 认证 tag 独立一行，避免与右上角 AI 锁按钮挤在一起
        '<div class="wbs-server-tags">' +
          '<span class="tag">' + (s.authType === 'key' ? icon('key') + ' 密钥' : '密码') + '</span>' +
        '</div>' +
        '<div class="wbs-server-actions">' +
          '<button class="icon-btn wbs-chat" title="添加到对话" aria-label="添加到对话">' + icon('chatPlus') + '</button>' +
          '<button class="icon-btn wbs-ssh" title="SSH 连接" aria-label="SSH 连接">' + icon('terminal') + '</button>' +
          '<button class="icon-btn wbs-sftp" title="SFTP 文件管理" aria-label="SFTP 文件管理">' + icon('folder') + '</button>' +
        '</div>';
      (card.querySelector('.wbs-chat') as HTMLButtonElement).onclick = (e) => {
        e.stopPropagation();
        addRefToChat({ serverId: s.id, name: s.name });
      };
      /* 服务器卡右键菜单：添加到对话（@remote:服务器名称 标签） */
      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, [
          { label: '添加到对话', iconName: 'chatPlus', action: () => addRefToChat({ serverId: s.id, name: s.name }) },
        ]);
      });
      (card.querySelector('.wbs-edit') as HTMLButtonElement).onclick = (e) => {
        e.stopPropagation();
        openEditModal(s);
      };
      (card.querySelector('.wbs-lock') as HTMLButtonElement).onclick = (e) => {
        e.stopPropagation();
        void setServerLocked(s.id, !s.locked)
          .then(() => bus.emit('project-changed'))
          .catch((err) => toast(`切换 AI 锁失败: ${String(err)}`, 'error'));
      };
      (card.querySelector('.wbs-ssh') as HTMLButtonElement).onclick = () => {
        // 每次点击都新开标签（唯一 id），支持同一服务器多终端并行；后端按前端 tab id 区分会话
        openTab({
          id: `term:${s.id}:${uid('t')}`,
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
      return card;
    };

    // 平铺列表展示（服务器不再按目录分组）
    filtered.forEach((s) => list.appendChild(buildCard(s)));
  };

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    void render();
  });

  void render();
  /* 守卫陈旧挂载闭包：bus 无 off API（core.ts 契约），面板每次切换都重挂载并重复订阅，
     旧闭包持有的 searchWrap 已被 innerHTML 清空（isConnected=false），无守卫时旧 render 会把
     孤立搜索框重新 append 回活容器 —— 表现为锁切换/命令收藏后搜索框被复制一个（workbench.ts
     同契约注释：监听器用 isConnected 守卫，换页后自动失效） */
  bus.on('project-changed', () => { if (searchWrap.isConnected) void render(); });
  // 命令面板（Ctrl+T）等全局操作清空/变更数据后广播，侧栏常驻需同步刷新
  if (dataChangedHandler) window.removeEventListener('aishell:data-changed', dataChangedHandler);
  dataChangedHandler = () => { if (container.isConnected) void render(); };
  window.addEventListener('aishell:data-changed', dataChangedHandler);
}
