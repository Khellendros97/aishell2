/**
 * 服务器面板 —— 移植自 .proto/workbench-sidebar.js「面板 2：服务器列表」。
 * 渲染当前项目绑定的服务器卡片；SSH 连接 / SFTP 标签页；bus.on('project-changed') 重渲染。
 * 新增：标题行「新建」按钮 → 面板内联模态框创建服务器，创建成功后立即绑定到当前项目
 * （upsert_server + upsert_project，与设置页表单同字段语义：密码留空 = 不写入 keyring）。
 * 与原型差异：不做在线状态探活（计划明确去掉随机 mock 状态点），认证方式以 tag 呈现。
 * 新增（非原型）：远程服务器支持按 名称/host/账号 搜索；列表平铺展示（服务器不再有目录维度，分类能力已转移给项目）。
 * 侧栏框架契约：导出 head 描述符（title），mountServersPanel(container) 只渲染内容区。
 */
import type { DbConnection, DbKind, Server } from '../../../types';
import { icon } from '../../../icons';
import { deleteDbConnection, getState, saveDbConnection, setServerLocked, upsertProject, upsertServer } from '../../../api';
import { bus, openTab, Workbench } from '../core';
import { confirmDialog, showContextMenu, toast, uid } from '../../../ui';
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
          '<button class="icon-btn wbs-db" title="数据库连接（AI 受管查询）" aria-label="数据库连接">' + icon('database') + '</button>' +
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
      (card.querySelector('.wbs-db') as HTMLButtonElement).onclick = (e) => {
        e.stopPropagation();
        openDbConnectionsModal(s);
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

/* ---------- 数据库连接配置弹窗（AI 受管查询通道） ---------- */

const DB_KIND_LABEL: Record<DbKind, string> = {
  mysql: 'MySQL',
  clickhouse: 'ClickHouse',
  redis: 'Redis',
};

/** 各类型 AI 可用命令清单（表单勾选区用）：只读组与后端 store.rs DbKind::default_read_commands 严格一致；
 *  写组为常用写操作（勾选后保存进白名单，AI 执行前 guard 分类转人工审批）。 */
const DB_COMMAND_GROUPS: Record<DbKind, { title: string; write: boolean; commands: string[] }[]> = {
  mysql: [
    { title: '只读命令（AI 可直接执行）', write: false, commands: ['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'] },
    { title: '写命令（勾选后 AI 执行前需人工审批）', write: true, commands: ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'] },
  ],
  clickhouse: [
    { title: '只读命令（AI 可直接执行）', write: false, commands: ['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'] },
    { title: '写命令（勾选后 AI 执行前需人工审批）', write: true, commands: ['INSERT', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'OPTIMIZE', 'RENAME'] },
  ],
  redis: [
    { title: '只读命令（AI 可直接执行）', write: false, commands: [
      'GET', 'MGET', 'KEYS', 'SCAN', 'TYPE', 'TTL', 'PTTL', 'EXISTS', 'DBSIZE',
      'INFO', 'PING', 'STRLEN', 'LLEN', 'SCARD', 'ZCARD', 'HLEN', 'HGET',
      'HGETALL', 'HKEYS', 'HVALS', 'SMEMBERS', 'LRANGE', 'ZRANGE', 'SISMEMBER',
      'HEXISTS', 'SRANDMEMBER', 'RANDOMKEY', 'ZSCORE', 'HSTRLEN', 'GETRANGE',
    ] },
    { title: '写命令（勾选后 AI 执行前需人工审批）', write: true, commands: [
      'SET', 'MSET', 'SETEX', 'DEL', 'EXPIRE', 'PERSIST', 'HSET', 'HDEL',
      'LPUSH', 'RPUSH', 'LPOP', 'RPOP', 'SADD', 'SREM', 'ZADD', 'ZREM',
      'RENAME', 'FLUSHDB', 'FLUSHALL',
    ] },
  ],
};

/** 各类型默认只读命令集（取命令清单的只读组） */
const DB_DEFAULT_COMMANDS: Record<DbKind, string[]> = {
  mysql: DB_COMMAND_GROUPS.mysql[0].commands,
  clickhouse: DB_COMMAND_GROUPS.clickhouse[0].commands,
  redis: DB_COMMAND_GROUPS.redis[0].commands,
};

/** 数据库连接配置弹窗：列表视图 ↔ 表单视图（新增/编辑），密码永不回显。 */
function openDbConnectionsModal(server: Server): void {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const root = document.createElement('div');
  root.className = 'modal';
  root.style.width = '600px';
  mask.appendChild(root);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  const close = (): void => {
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
  };
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });

  const loadConns = async (): Promise<DbConnection[]> => {
    try {
      const state = await getState();
      return state.dbConnections[server.id] ?? [];
    } catch {
      return [];
    }
  };

  const renderList = (): void => {
    void loadConns().then((conns) => {
      root.innerHTML = `
        <div class="modal-head">
          <h3>数据库连接 · ${esc(server.name)}</h3>
          <button class="icon-btn" data-act="close" title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="db-conn-list">
            ${conns.length ? conns.map((c) => `
              <div class="db-conn-item${c.enabled ? '' : ' disabled'}" data-id="${esc(c.id)}">
                <span class="db-conn-icon">${icon('database')}</span>
                <span class="db-conn-main">
                  <span class="db-conn-name">${esc(c.name)}</span>
                  <span class="db-conn-addr mono">${DB_KIND_LABEL[c.kind]} · ${esc(c.host)}:${c.port}${c.database ? ' · db=' + esc(c.database) : ''}</span>
                  <span class="db-conn-cmds">允许命令：${esc((c.allowedCommands.length ? c.allowedCommands : DB_DEFAULT_COMMANDS[c.kind]).join(' / '))}</span>
                </span>
                <label class="db-switch" title="${c.enabled ? '已启用（点击禁用：AI 不可见、不可执行）' : '已禁用（点击启用）'}">
                  <input type="checkbox" data-act="toggle" ${c.enabled ? 'checked' : ''}><span class="db-switch-track"></span>
                </label>
                <span class="db-conn-ops">
                  <button class="icon-btn" data-act="edit" title="编辑">${icon('pencil')}</button>
                  <button class="icon-btn" data-act="del" title="删除">${icon('trash')}</button>
                </span>
              </div>`).join('')
              : '<div class="db-conn-empty">尚未配置数据库连接。AI 将无法通过 db_query 查询；密码保存在系统凭据库，AI 不可见。</div>'}
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn primary" data-act="new">${icon('plus')} 新增连接</button>
        </div>`;
      root.querySelector('[data-act=close]')?.addEventListener('click', close);
      root.querySelector('[data-act=new]')?.addEventListener('click', () => renderForm(null));
      root.querySelectorAll<HTMLInputElement>('[data-act=toggle]').forEach((input, i) => {
        input.addEventListener('change', () => {
          const next: DbConnection = { ...conns[i], enabled: input.checked };
          // 密码传 null：后端保持原值（不触碰 keyring）
          void saveDbConnection(server.id, next, null)
            .then(() => { toast(next.enabled ? '已启用连接' : '已禁用连接，AI 不可见、不可执行', 'success'); renderList(); })
            .catch((err) => { toast(`切换失败: ${String(err)}`, 'error'); renderList(); });
        });
      });
      root.querySelectorAll('[data-act=edit]').forEach((b, i) => {
        b.addEventListener('click', () => renderForm(conns[i]));
      });
      root.querySelectorAll('[data-act=del]').forEach((b, i) => {
        b.addEventListener('click', () => {
          void confirmDialog({
            title: '删除数据库连接',
            message: `确定删除「${conns[i].name}」？系统凭据库中的密码也会一并删除。`,
            danger: true,
            okText: '删除',
          }).then((ok) => {
            if (!ok) return;
            void deleteDbConnection(server.id, conns[i].id)
              .then(() => { toast('已删除数据库连接', 'success'); renderList(); })
              .catch((err) => toast(`删除失败: ${String(err)}`, 'error'));
          });
        });
      });
    });
  };

  /** 表单视图：conn 为 null 表示新增。 */
  const renderForm = (conn: DbConnection | null): void => {
    const isNew = !conn;
    const d = conn ?? { id: uid('dbc'), name: '', kind: 'mysql' as DbKind, host: '127.0.0.1', port: 3306, user: '', database: '', allowedCommands: [] as string[], enabled: true };
    root.innerHTML = `
      <div class="modal-head">
        <h3>${isNew ? '新增数据库连接' : '编辑数据库连接'} · ${esc(server.name)}</h3>
        <button class="icon-btn" data-act="close" title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="server-form-grid">
          <div class="field"><label>类型</label>
            <select class="select" data-f="kind">${(Object.keys(DB_KIND_LABEL) as DbKind[]).map((k) =>
              `<option value="${k}" ${d.kind === k ? 'selected' : ''}>${DB_KIND_LABEL[k]}</option>`).join('')}
            </select></div>
          <div class="field"><label>名称<span class="req">*</span></label>
            <input class="input" data-f="name" value="${esc(d.name)}" placeholder="例如：计费库"></div>
          <div class="field"><label>主机<span class="req">*</span></label>
            <input class="input" data-f="host" value="${esc(d.host)}"></div>
          <div class="field"><label>端口<span class="req">*</span></label>
            <input class="input" data-f="port" type="number" value="${d.port}"></div>
          <div class="field" data-hide-redis><label>用户名</label>
            <input class="input" data-f="user" value="${esc(d.user)}" placeholder="redis 可留空"></div>
          <div class="field"><label>密码</label>
            <input class="input mono" data-f="password" type="password" placeholder="${isNew ? '必填' : '留空保持原密码'}"></div>
          <div class="field db-cmds-field" data-hide-redis><label>默认库</label>
            <input class="input" data-f="database" value="${esc(d.database)}" placeholder="mysql/clickhouse 用；redis 忽略"></div>
          <div class="field db-cmds-field"><label>AI 可用命令</label>
            <div class="db-cmds" data-cmds></div>
            <div class="hint">只读命令 AI 可直接执行；勾选写命令后，AI 执行前需人工审批。密码保存在系统凭据库，AI 不可见。</div>
          </div>
        </div>
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="back">返回</button>
        <button class="btn primary" data-act="save">保存</button>
      </div>`;
    root.querySelector('[data-act=close]')?.addEventListener('click', close);
    root.querySelector('[data-act=back]')?.addEventListener('click', renderList);

    /* 命令勾选区：checked = 初始勾选集；savedExtras = 已保存但不在清单内的命令（保留为额外勾选项） */
    const renderCmdGroups = (kind: DbKind, checked: Set<string>, savedExtras: string[]): void => {
      const box = root.querySelector('[data-cmds]') as HTMLElement;
      const groups = DB_COMMAND_GROUPS[kind];
      const known = new Set(groups.flatMap((g) => g.commands));
      const extra = savedExtras.filter((c) => !known.has(c));
      box.innerHTML = groups.map((g) => `
        <div class="db-cmds-group">
          <div class="db-cmds-title">${g.title}</div>
          <div class="db-cmds-grid${g.write ? ' write' : ''}">${g.commands.map((cmd) => `
            <label class="db-cmd"><input type="checkbox" value="${cmd}"${checked.has(cmd) ? ' checked' : ''}>${cmd}</label>`).join('')}
          </div>
        </div>`).join('') + (extra.length ? `
        <div class="db-cmds-group">
          <div class="db-cmds-title">其他（已保存的自定义命令）</div>
          <div class="db-cmds-grid">${extra.map((cmd) => `
            <label class="db-cmd"><input type="checkbox" value="${esc(cmd)}" checked>${esc(cmd)}</label>`).join('')}
          </div>
        </div>` : '');
    };
    // 初始勾选：已保存白名单（空 = 该类型默认只读集）
    renderCmdGroups(d.kind, new Set(d.allowedCommands.length ? d.allowedCommands : DB_DEFAULT_COMMANDS[d.kind]), d.allowedCommands);

    const kindSel = root.querySelector('[data-f=kind]') as HTMLSelectElement;
    // redis 无用户名/默认库概念（user 可选、database 忽略），切换类型时隐藏对应字段
    const redisHidden = root.querySelectorAll<HTMLElement>('[data-hide-redis]');
    const syncKindFields = (): void => {
      const isRedis = kindSel.value === 'redis';
      redisHidden.forEach((el) => el.classList.toggle('hidden', isRedis));
    };
    // 切换类型：勾选重置为新类型默认只读集（不同类型命令语义不同，不保留旧勾选）
    kindSel.addEventListener('change', () => {
      const k = kindSel.value as DbKind;
      renderCmdGroups(k, new Set(DB_DEFAULT_COMMANDS[k]), []);
      syncKindFields();
    });
    syncKindFields();

    root.querySelector('[data-act=save]')?.addEventListener('click', () => {
      const name = (root.querySelector('[data-f=name]') as HTMLInputElement).value.trim();
      const host = (root.querySelector('[data-f=host]') as HTMLInputElement).value.trim();
      const port = Number((root.querySelector('[data-f=port]') as HTMLInputElement).value);
      const user = (root.querySelector('[data-f=user]') as HTMLInputElement).value.trim();
      const database = (root.querySelector('[data-f=database]') as HTMLInputElement).value.trim();
      const password = (root.querySelector('[data-f=password]') as HTMLInputElement).value;
      const commands = [...root.querySelectorAll<HTMLInputElement>('[data-cmds] input[type=checkbox]:checked')].map((el) => el.value);
      if (!name) { toast('请填写连接名称', 'error'); return; }
      if (!host) { toast('请填写数据库主机', 'error'); return; }
      if (!Number.isInteger(port) || port <= 0 || port > 65535) { toast('端口无效', 'error'); return; }
      if (!user && kindSel.value !== 'redis') { toast('请填写数据库用户名', 'error'); return; }
      if (isNew && !password) { toast('请填写数据库密码', 'error'); return; }
      if (!commands.length) { toast('请至少勾选一条 AI 可用命令', 'error'); return; }
      const connection: DbConnection = {
        id: d.id,
        name, kind: kindSel.value as DbKind, host, port, user, database,
        allowedCommands: commands,
        enabled: d.enabled,
      };
      void saveDbConnection(server.id, connection, password || null)
        .then(() => { toast(isNew ? '已保存数据库连接' : '已更新数据库连接', 'success'); renderList(); })
        .catch((err) => toast(`保存失败: ${String(err)}`, 'error'));
    });
  };

  renderList();
}
