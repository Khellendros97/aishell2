/**
 * 服务器面板 —— 移植自 .proto/workbench-sidebar.js「面板 2：服务器列表」。
 * 渲染当前项目绑定的服务器卡片；SSH 连接 / SFTP 标签页；bus.on('project-changed') 重渲染。
 * 新增：标题行「新建」按钮 → 面板内联模态框创建服务器，创建成功后立即绑定到当前项目
 * （upsert_server + upsert_project，与设置页表单同字段语义：密码留空 = 不写入 keyring）。
 * 与原型差异：不做在线状态探活（计划明确去掉随机 mock 状态点），认证方式以 tag 呈现。
 * 新增（非原型）：远程服务器支持按 名称/host/账号/目录 搜索；空搜索词时按 folder 分组展示
 * （folder 与 store.rs Server 字段对齐）；新建模态框含「所属目录」组合框（下拉可选已有分类，也可手输新分类）。
 * 新增：分组面板默认折叠，点组标题展开/收起（全部展开/折叠切换按钮在搜索框旁）；拖服务器卡片到组标题可改分类。
 * 侧栏框架契约：导出 head 描述符（title），mountServersPanel(container) 只渲染内容区。
 */
import type { Server } from '../../../types';
import { icon } from '../../../icons';
import { getState, renameServerFolder, setServerLocked, upsertProject, upsertServer } from '../../../api';
import { bus, openTab, Workbench } from '../core';
import { attachCombo, promptDialog, toast, uid } from '../../../ui';
import './servers.css';

export const serversHead = { title: '服务器列表' };

/* 展开的分类面板（键 = folder 值，空串 = 未分类）；模块级持久，project-changed 重渲染保留展开态，默认全部折叠 */
const expandedFolders = new Set<string>();

/** 数据变更监听句柄：面板切换会重建 DOM 但 window 监听不自动消失，重挂载时先移除旧的 */
let dataChangedHandler: (() => void) | null = null;

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
          <div class="field">
            <label>所属目录</label>
            <input id="srv-f-folder" class="input" placeholder="可输入新分类或从下拉选择，例如：生产环境/Web">
            <div class="hint">以 / 分隔的目录路径，用于侧栏分组展示；可下拉选择已有分类，也可直接输入新分类；留空表示未分类</div>
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
  const fFolder = container.querySelector('#srv-f-folder') as HTMLInputElement;

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
    fFolder.value = '';
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
      // 所属目录：规范化 '/' 分隔路径（去首尾/重复分隔符），留空 = 未分类
      folder: fFolder.value.trim().split('/').filter(Boolean).join('/'),
      locked: false,
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

  /* 搜索行（持久元素）：搜索框 + 全部展开/折叠切换按钮，不随列表重建，避免输入焦点丢失 */
  const searchWrap = document.createElement('div');
  searchWrap.className = 'wbs-search';
  const searchInput = document.createElement('input');
  searchInput.className = 'input';
  searchInput.placeholder = '搜索服务器…';
  const toggleFoldersBtn = document.createElement('button');
  toggleFoldersBtn.className = 'icon-btn';
  toggleFoldersBtn.title = '全部展开';
  toggleFoldersBtn.innerHTML = icon('folderOpen');
  searchWrap.append(searchInput, toggleFoldersBtn);
  let searchQuery = ''; // 搜索词（小写，空串 = 显示全部）

  let latestServers: Server[] = [];   // 最近一次 render 拉取的服务器（供新建模态框分类下拉候选）
  let latestFolders: string[] = [];   // 最近一次 render 拉取的分类目录清单
  let latestBoundFolders: string[] = []; // 最近一次 render 的分组键（「全部展开/折叠」切换用）

  /** 所属目录组合框候选：已有目录 ∪ 各服务器 folder 派生值（去重排序）；手输新分类保存时后端自动注册 */
  const folderOptions = (): string[] => {
    const opts = new Set<string>(latestFolders);
    latestServers.forEach((s) => { if (s.folder) opts.add(s.folder); });
    return Array.from(opts).sort((a, b) => a.localeCompare(b, 'zh'));
  };
  attachCombo(fFolder, folderOptions);

  /* 分组标题重命名：级联改所有服务器 folder 后整体重渲染（复用设置页 promptDialog 流程） */
  async function renameFolderFlow(folder: string): Promise<void> {
    const name = await promptDialog({
      title: '重命名分类目录',
      label: '目录路径（可含 / 层级）',
      defaultValue: folder,
      okText: '重命名',
      allowPath: true,
    });
    if (name === null) return;
    try {
      await renameServerFolder(folder, name);
    } catch (err) {
      toast(`重命名分类目录失败: ${String(err)}`, 'error');
      return;
    }
    bus.emit('project-changed');
    toast(`分类目录已重命名为「${name}」`, 'success');
  }

  const render = async (): Promise<void> => {
    let servers: Server[] = [];
    let folders: string[] = [];
    try {
      const state = await getState();
      servers = state.servers;
      folders = state.serverFolders;
    } catch {
      /* 后端未就绪时按空列表渲染 */
    }
    latestServers = servers;
    latestFolders = folders;
    const project = Workbench.state.project;
    const ids = project?.serverIds ?? [];
    const bound = servers.filter((s) => ids.includes(s.id));

    // 全部展开/折叠切换按钮状态：图标 = 目标动作（folderOpen 展开 / folder 折叠）
    latestBoundFolders = Array.from(new Set(bound.map((s) => s.folder || '')));
    const allExpanded = latestBoundFolders.length > 0 && latestBoundFolders.every((k) => expandedFolders.has(k));
    toggleFoldersBtn.innerHTML = icon(allExpanded ? 'folder' : 'folderOpen');
    toggleFoldersBtn.title = allExpanded ? '全部折叠' : '全部展开';

    /* 复用内容容器：模态框是 container 直子节点，绝不能整清空（否则新建表单随列表刷新被移除）；
       只清理上次的动态内容（本地卡 / 标题 / 列表容器），持久搜索框保留 */
    let wrap = container.querySelector<HTMLElement>('.wbs-content');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'wbs-content';
      container.appendChild(wrap);
    }
    wrap.querySelectorAll('.wbs-local-card, .wbs-server-head, .wbs-server-list').forEach((el) => el.remove());

    /* 固定卡片：本地 Git Bash，整卡点击新开独立本地终端（id `term-local:<uid>`，与启动时自动开的首个实例 'term-local' 并存） */
    const localCard = document.createElement('div');
    localCard.className = 'card wbs-server-card wbs-local-card clickable';
    localCard.innerHTML =
      '<div class="wbs-server-top">' +
        '<span class="wbs-server-icon">' + icon('terminal') + '</span>' +
        '<span class="wbs-server-main">' +
          '<span class="wbs-server-name">本地 Git Bash</span>' +
          '<span class="wbs-server-addr mono">本地终端 · 点击打开</span>' +
        '</span>' +
        '<span class="tag blue">本地</span>' +
      '</div>';
    localCard.onclick = () => {
      openTab({
        id: `term-local:${uid('t')}`,
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

    // 搜索过滤：名称 / host / username / folder 大小写不敏感；空串显示全部
    const q = searchQuery;
    const filtered = bound.filter((s) =>
      !q || [s.name, s.host, s.username, s.folder].some((v) => v.toLowerCase().includes(q))
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
      card.draggable = true; // 拖拽到分组标题行可改分类
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
          '<button class="icon-btn wbs-lock' + (s.locked ? ' locked' : '') + '" title="' + lockTitle + '" aria-label="' + lockTitle + '" aria-pressed="' + String(s.locked) + '">' +
            icon(s.locked ? 'lock' : 'unlock') +
          '</button>' +
        '</div>' +
        // 认证 tag 独立一行，避免与右上角 AI 锁按钮挤在一起
        '<div class="wbs-server-tags">' +
          '<span class="tag">' + (s.authType === 'key' ? icon('key') + ' 密钥' : '密码') + '</span>' +
        '</div>' +
        '<div class="wbs-server-actions">' +
          '<button class="icon-btn wbs-ssh" title="SSH 连接" aria-label="SSH 连接">' + icon('terminal') + '</button>' +
          '<button class="icon-btn wbs-sftp" title="SFTP 文件管理" aria-label="SFTP 文件管理">' + icon('folder') + '</button>' +
        '</div>';
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
      // 拖拽改分类：拖起时标记数据与半透明态，dragend 清理（搜索态平铺时无分组标题作为放置目标，属预期）
      card.addEventListener('dragstart', (e) => {
        const dt = e.dataTransfer;
        if (!dt) return;
        dt.setData('application/x-aishell-server', s.id);
        dt.setData('text/plain', s.id);
        card.classList.add('dragging');
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
      return card;
    };

    // 搜索中平铺展示；空搜索词按 folder 分组（未分类 = 空串，放最后）
    if (q) {
      filtered.forEach((s) => list.appendChild(buildCard(s)));
    } else {
      const groups = new Map<string, Server[]>();
      filtered.forEach((s) => {
        const key = s.folder || '';
        const arr = groups.get(key);
        if (arr) arr.push(s);
        else groups.set(key, [s]);
      });
      const keys = Array.from(groups.keys()).sort((a, b) => {
        if (!a) return 1; // 未分类组排最后
        if (!b) return -1;
        return a.localeCompare(b, 'zh');
      });
      keys.forEach((folderKey) => {
        const expanded = expandedFolders.has(folderKey);
        const gTitle = document.createElement('div');
        gTitle.className = 'wbs-server-group-title' + (expanded ? ' expanded' : '');
        gTitle.dataset.folder = folderKey;
        // 折叠指示：收起 = 闭合文件夹 / 展开 = 打开的文件夹
        const ic = document.createElement('span');
        ic.className = 'wbs-server-group-ic';
        ic.innerHTML = icon(expanded ? 'folderOpen' : 'folder');
        const tx = document.createElement('span');
        tx.className = 'wbs-server-group-name';
        tx.textContent = folderKey || '未分类';
        const cnt = document.createElement('span');
        cnt.className = 'tag';
        cnt.textContent = String(groups.get(folderKey)!.length);
        gTitle.append(ic, tx, cnt);
        // 未分类不可重命名；其余组提供重命名入口（与设置页同流程）；stopPropagation 防触发折叠
        if (folderKey) {
          const renameBtn = document.createElement('button');
          renameBtn.className = 'icon-btn';
          renameBtn.title = `重命名「${folderKey}」`;
          renameBtn.innerHTML = icon('pencil');
          renameBtn.onclick = (e) => {
            e.stopPropagation();
            void renameFolderFlow(folderKey);
          };
          gTitle.append(renameBtn);
        }
        // 点击标题行 = 展开/收起该组（默认全部折叠）
        gTitle.addEventListener('click', () => {
          if (expandedFolders.has(folderKey)) expandedFolders.delete(folderKey);
          else expandedFolders.add(folderKey);
          void render();
        });
        list.appendChild(gTitle);
        // 组内列表容器：收起时整体隐藏
        const gList = document.createElement('div');
        gList.className = 'wbs-server-group-list';
        if (!expanded) gList.classList.add('hidden');
        groups.get(folderKey)!.forEach((s) => gList.appendChild(buildCard(s)));
        list.appendChild(gList);
        // 放置目标：拖服务器卡片到组标题（含未分类）= 改分类
        gTitle.addEventListener('dragover', (e) => {
          const dt = e.dataTransfer;
          if (dt && dt.types.includes('application/x-aishell-server')) {
            e.preventDefault();
            gTitle.classList.add('drop-target');
          }
        });
        gTitle.addEventListener('dragleave', () => gTitle.classList.remove('drop-target'));
        gTitle.addEventListener('drop', (e) => {
          e.preventDefault();
          gTitle.classList.remove('drop-target');
          const id = e.dataTransfer?.getData('application/x-aishell-server') ?? '';
          if (!id) return;
          const server = servers.find((sv) => sv.id === id);
          if (!server) return;
          if (server.folder === folderKey) return; // 目标分类相同则跳过
          void upsertServer({ ...server, folder: folderKey }, null)
            .then(() => {
              bus.emit('project-changed');
              toast(`已移动到「${folderKey || '未分类'}」`, 'success');
            })
            .catch((err) => toast(`移动分类失败: ${String(err)}`, 'error'));
        });
      });
    }
  };

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.trim().toLowerCase();
    void render();
  });

  // 全部展开 / 全部折叠：单按钮按当前状态切换（图标 = 目标动作）
  toggleFoldersBtn.addEventListener('click', () => {
    const allExpanded = latestBoundFolders.length > 0 && latestBoundFolders.every((k) => expandedFolders.has(k));
    if (allExpanded) expandedFolders.clear();
    else latestBoundFolders.forEach((k) => expandedFolders.add(k));
    void render();
  });

  void render();
  bus.on('project-changed', () => { void render(); });
  // 命令面板（Ctrl+T）等全局操作清空/变更数据后广播，侧栏常驻需同步刷新
  if (dataChangedHandler) window.removeEventListener('aishell:data-changed', dataChangedHandler);
  dataChangedHandler = () => { if (container.isConnected) void render(); };
  window.addEventListener('aishell:data-changed', dataChangedHandler);
}
