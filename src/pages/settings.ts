/**
 * 配置页 —— 移植自 .proto/settings.js + settings.html。
 * 差异：数据源为 Tauri 后端（get_state / upsert_server / delete_server / save_settings）；
 * 密码与 apiKey 表单留空提交 null（后端保持原值），显示位不打回明文；
 * 浏览按钮走 @tauri-apps/plugin-dialog；「重置演示数据」按钮本页无（见欢迎页「打开配置目录」）。
 * 新增（非原型）：服务器列表支持按 名称/host/账号/目录 搜索，并按 folder 分组展示
 * （folder 为 '/' 分隔相对路径，与 store.rs Server 字段 serde camelCase 对齐；旧配置无该字段按未分类）。
 */
import type { AppState, LlmConfig, Server, Theme, XshellImportResult } from '../types';
import { createServerFolder, deleteServer, deleteServerFolder, getState, importXshellFromDir, importXshellSessions, openDialog, renameServerFolder, saveSettings, setServerLocked, setTheme, upsertServer } from '../api';
import { attachCombo, confirmDialog, promptDialog, toast, uid } from '../ui';
import { icon } from '../icons';
import { openUrl } from '@tauri-apps/plugin-opener';
import { applyTheme, currentTheme, onThemeChange } from '../theme';
import type { PageRender } from '../main';
import './settings.css';

const AUTH_LABEL: Record<string, string> = { password: '密码', key: '密钥' };

/** 展开状态的服务器分组（键 = folder 值，含未分类空串）；默认全折叠，跨 renderServers 重渲染保留 */
const expandedFolders = new Set<string>();

export const renderSettings: PageRender = (root, params) => {
  root.classList.add('settings-page');

  /* ---------- 页面骨架（同 .proto/settings.html） ---------- */
  root.insertAdjacentHTML('beforeend', `
    <div id="warn-banner">${icon('alert')} 缺少必要配置，请先完成系统设置</div>
    <div id="settings-layout">
      <nav id="settings-nav">
        <div class="nav-item active" data-panel="servers">${icon('monitor')} 服务器配置</div>
        <div class="nav-item" data-panel="system">${icon('gear')} 系统设置</div>
      </nav>
      <main id="settings-content">
        <section id="panel-servers" class="settings-panel">
          <div class="panel-head">
            <div class="panel-title">服务器 <span id="server-count" class="tag">0</span></div>
            <div class="panel-actions">
              <button id="btn-import-xshell" class="btn">${icon('folder')} 从 Xshell 导入</button>
              <button id="btn-new-folder" class="btn">${icon('folderPlus')} 新建分类目录</button>
              <button id="btn-new-server" class="btn primary">${icon('plus')} 新建服务器</button>
            </div>
          </div>
          <div id="import-note" class="import-note hidden" role="status"></div>
          <div class="search-row">
            <input id="server-search" class="input" placeholder="搜索服务器…">
            <button id="btn-toggle-folders" class="icon-btn" title="全部展开">${icon('folderOpen')}</button>
          </div>
          <div id="server-grid"></div>
          <div id="server-empty" class="empty-state hidden">
            <div class="icon">${icon('monitor')}</div>
            <div>暂无服务器，点击右上角「新建服务器」开始配置</div>
          </div>
          <div id="server-search-empty" class="empty-state hidden">
            <div class="icon">${icon('folder')}</div>
            <div>没有匹配的服务器，试试其他关键词</div>
          </div>
        </section>
        <section id="panel-system" class="settings-panel hidden">
          <div class="panel-head"><div class="panel-title">系统设置</div></div>
          <div class="field">
            <label>界面主题</label>
            <select id="f-theme" class="select">
              <option value="dark">深色</option>
              <option value="light">亮色</option>
            </select>
            <div class="hint">选择后立即生效；顶栏 ☀/☾ 按钮亦可快捷切换</div>
          </div>
          <div class="field">
            <label>Workspace 目录<span class="req">*</span></label>
            <div class="input-row">
              <input id="f-workspace" class="input mono" placeholder="D:\\AIShellWorkspace">
              <button id="btn-browse-ws" class="btn small">浏览…</button>
            </div>
            <div class="hint">项目默认创建目录</div>
          </div>
          <fieldset class="llm-group">
            <legend>大模型配置</legend>
            <div class="field">
              <label>模型 ID</label>
              <input id="f-model-id" class="input" placeholder="deepseek-v4-flash">
            </div>
            <div class="field">
              <label>Base URL</label>
              <input id="f-base-url" class="input mono" placeholder="https://api.deepseek.com/v1">
            </div>
            <div class="field">
              <label>API Key</label>
              <div class="input-row">
                <input id="f-api-key" class="input mono" type="password" placeholder="已保存则不显示，留空表示不修改">
                <button id="btn-toggle-key" class="icon-btn" title="显示 / 隐藏">${icon('eye')}</button>
              </div>
              <div class="hint">获取 API Key：<a href="https://platform.deepseek.com/api_keys" data-open-url="https://platform.deepseek.com/api_keys">platform.deepseek.com/api_keys</a></div>
            </div>
            <div class="field">
              <label>思考强度</label>
              <select id="f-effort" class="select">
                <option value="low">low</option>
                <option value="high">high</option>
                <option value="max">max</option>
              </select>
            </div>
          </fieldset>
          <fieldset class="llm-group">
            <legend>联网搜索</legend>
            <div class="field">
              <label>启用 AI 联网搜索</label>
              <input id="f-search-enabled" type="checkbox">
              <div class="hint">启用后 AI 助手可通过 Brave Search 获取最新信息（问时效性问题时自动使用）</div>
            </div>
            <div class="field">
              <label>Brave Search API Key</label>
              <div class="input-row">
                <input id="f-brave-key" class="input mono" type="password" placeholder="已保存则不显示，留空表示不修改">
                <button id="btn-toggle-brave" class="icon-btn" title="显示 / 隐藏">${icon('eye')}</button>
              </div>
              <div class="hint">免费额度 2000 次/月，<a href="https://api-dashboard.search.brave.com/app/keys" data-open-url="https://api-dashboard.search.brave.com/app/keys">获取 Brave Search API Key</a></div>
            </div>
          </fieldset>
          <div class="form-actions">
            <button id="btn-save-system" class="btn primary">保存</button>
          </div>
        </section>
      </main>
    </div>

    <!-- 新建 / 编辑服务器模态框 -->
    <div id="server-modal" class="modal-mask hidden">
      <div class="modal">
        <div class="modal-head">
          <h3 id="server-modal-title">新建服务器</h3>
          <button id="server-modal-close" class="icon-btn" title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>服务器名称<span class="req">*</span></label>
            <input id="f-name" class="input" placeholder="例如：生产-Web-01">
          </div>
          <div class="field">
            <label>IP 地址<span class="req">*</span></label>
            <input id="f-host" class="input mono" placeholder="例如：47.102.118.66">
          </div>
          <div class="field">
            <label>SSH 端口<span class="req">*</span></label>
            <input id="f-port" class="input mono" type="number" min="1" max="65535" value="22">
          </div>
          <div class="field">
            <label>认证方式<span class="req">*</span></label>
            <select id="f-auth" class="select">
              <option value="password">账号密码</option>
              <option value="key">密钥</option>
            </select>
          </div>
          <div class="field">
            <label>账号<span class="req">*</span></label>
            <input id="f-username" class="input" placeholder="例如：deploy">
          </div>
          <div class="field" data-auth="password">
            <label>密码</label>
            <input id="f-password" class="input" type="password" placeholder="••••••••">
          </div>
          <div class="field" data-auth="key">
            <label>密钥文件路径</label>
            <div class="input-row">
              <input id="f-keypath" class="input mono" placeholder="C:\\Users\\demo\\.ssh\\id_ed25519">
              <button id="btn-browse-key" class="btn small">浏览…</button>
            </div>
          </div>
          <div class="field">
            <label>所属目录</label>
            <input id="f-folder" class="input" placeholder="可输入新分类或从下拉选择，例如：生产环境/Web">
            <div class="hint">以 / 分隔的目录路径，可输入新分类或从下拉选择；留空表示未分类</div>
          </div>
        </div>
        <div class="modal-foot">
          <button id="server-modal-cancel" class="btn">取消</button>
          <button id="server-modal-save" class="btn primary">保存</button>
        </div>
      </div>
    </div>
  `);

  /* ---------- 元素引用 ---------- */
  const warnBanner = root.querySelector('#warn-banner') as HTMLElement;
  const navItems = Array.from(root.querySelectorAll<HTMLElement>('#settings-nav .nav-item'));
  const panels = {
    servers: root.querySelector('#panel-servers') as HTMLElement,
    system: root.querySelector('#panel-system') as HTMLElement,
  };
  const grid = root.querySelector('#server-grid') as HTMLElement;
  const emptyState = root.querySelector('#server-empty') as HTMLElement;
  const searchEmpty = root.querySelector('#server-search-empty') as HTMLElement;
  const serverSearch = root.querySelector('#server-search') as HTMLInputElement;
  const countTag = root.querySelector('#server-count') as HTMLElement;

  const modal = root.querySelector('#server-modal') as HTMLElement;
  const modalTitle = root.querySelector('#server-modal-title') as HTMLElement;
  const fName = root.querySelector('#f-name') as HTMLInputElement;
  const fHost = root.querySelector('#f-host') as HTMLInputElement;
  const fPort = root.querySelector('#f-port') as HTMLInputElement;
  const fAuth = root.querySelector('#f-auth') as HTMLSelectElement;
  const fUsername = root.querySelector('#f-username') as HTMLInputElement;
  const fPassword = root.querySelector('#f-password') as HTMLInputElement;
  const fKeyPath = root.querySelector('#f-keypath') as HTMLInputElement;
  const fFolder = root.querySelector('#f-folder') as HTMLInputElement;
  let editingId: string | null = null;

  const fTheme = root.querySelector('#f-theme') as HTMLSelectElement;
  const fWorkspace = root.querySelector('#f-workspace') as HTMLInputElement;
  const fModelId = root.querySelector('#f-model-id') as HTMLInputElement;
  const fBaseUrl = root.querySelector('#f-base-url') as HTMLInputElement;
  const fApiKey = root.querySelector('#f-api-key') as HTMLInputElement;
  const fEffort = root.querySelector('#f-effort') as HTMLSelectElement;
  const fSearchEnabled = root.querySelector('#f-search-enabled') as HTMLInputElement;
  const fBraveKey = root.querySelector('#f-brave-key') as HTMLInputElement;

  /* ---------- 状态 ---------- */
  let db: AppState = {
    settings: { workspaceDir: null, llm: { modelId: '', baseUrl: '', effort: 'low' }, search: { enabled: false }, theme: 'dark' },
    servers: [], projects: [], sessions: {}, serverFolders: [],
  };
  let searchQuery = ''; // 服务器列表搜索词（小写，空串 = 全部）
  let renderedGroupKeys: string[] = []; // 最近一次渲染的分组键（「全部展开」用）

  // reason=missing-config：顶部黄色提示条（同 .proto/settings.js）
  if (params.get('reason') === 'missing-config') warnBanner.classList.add('show');

  /* ---------- 左侧导航切换 ---------- */
  function switchPanel(name: string) {
    navItems.forEach((item) => item.classList.toggle('active', item.dataset.panel === name));
    (Object.keys(panels) as Array<keyof typeof panels>).forEach((key) => {
      panels[key].classList.toggle('hidden', key !== name);
    });
  }
  navItems.forEach((item) => {
    item.addEventListener('click', () => switchPanel(item.dataset.panel ?? ''));
  });

  /* ============================================================
     服务器配置
     ============================================================ */
  /** 搜索匹配：名称 / host / username / folder 大小写不敏感；空串显示全部 */
  function matchServer(s: Server, q: string): boolean {
    if (!q) return true;
    return [s.name, s.host, s.username, s.folder].some((v) => v.toLowerCase().includes(q));
  }

  /** 单张服务器卡片（编辑 / 删除 / AI 锁按钮，事件委托挂在 #server-grid 上）；draggable 供拖拽改分类 */
  function buildServerCard(s: Server): HTMLElement {
    const card = document.createElement('div');
    card.className = 'card server-card';
    card.draggable = true;
    card.dataset.id = s.id;

    const head = document.createElement('div');
    head.className = 'sc-head';
    const name = document.createElement('span');
    name.className = 'sc-name ellipsis';
    name.textContent = s.name;
    name.title = s.name;
    const actions = document.createElement('div');
    actions.className = 'sc-actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'icon-btn';
    editBtn.title = '编辑';
    editBtn.innerHTML = icon('pencil');
    editBtn.dataset.act = 'edit';
    editBtn.dataset.id = s.id;

    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn danger';
    delBtn.title = '删除';
    delBtn.innerHTML = icon('trash');
    delBtn.dataset.act = 'del';
    delBtn.dataset.id = s.id;

    // AI 操作锁：仅约束 AI 发起的远程动作，不影响用户手动 SSH/SFTP
    const lockBtn = document.createElement('button');
    lockBtn.className = 'icon-btn' + (s.locked ? ' locked' : '');
    lockBtn.title = s.locked
      ? `「${s.name}」的 AI 远程操作已锁定，点击解锁`
      : `锁定「${s.name}」的 AI 远程操作（手动 SSH/SFTP 不受影响）`;
    lockBtn.innerHTML = icon(s.locked ? 'lock' : 'unlock');
    lockBtn.dataset.act = 'lock';
    lockBtn.dataset.id = s.id;

    actions.append(editBtn, lockBtn, delBtn);
    head.append(name, actions);

    const host = document.createElement('div');
    host.className = 'sc-host mono';
    host.textContent = `${s.host}:${s.port}`;

    const meta = document.createElement('div');
    meta.className = 'sc-meta';
    const tag = document.createElement('span');
    tag.className = 'tag ' + (s.authType === 'key' ? 'purple' : 'blue');
    tag.textContent = AUTH_LABEL[s.authType] || s.authType;
    const user = document.createElement('span');
    user.className = 'sc-user';
    user.innerHTML = `${icon('user')} `;
    user.appendChild(document.createTextNode(s.username || '-'));
    meta.append(tag, user);

    card.append(head, host, meta);
    return card;
  }

  function renderServers() {
    grid.innerHTML = '';
    countTag.textContent = String(db.servers.length);
    const q = searchQuery;
    const filtered = db.servers.filter((s) => matchServer(s, q));
    // 无服务器但存在空目录时也渲染目录列表（标题+计数 0），不显示「暂无服务器」空态
    emptyState.classList.toggle('hidden', db.servers.length > 0 || (db.serverFolders?.length ?? 0) > 0);
    // 有服务器但搜索无命中 → 专属空态（与「完全没有服务器」区分）
    searchEmpty.classList.toggle('hidden', !(db.servers.length > 0 && filtered.length === 0));

    // 组来源：server_folders ∪ 各服务器 folder 派生值（并集，去重），空目录（0 台）也渲染；
    // 搜索中只展示命中服务器的分组（空目录无意义，保持原有搜索空态语义）。
    const groups = new Map<string, Server[]>();
    if (q) {
      filtered.forEach((s) => {
        const key = s.folder || '';
        const list = groups.get(key);
        if (list) list.push(s);
        else groups.set(key, [s]);
      });
    } else {
      const folderSet = new Set<string>(db.serverFolders ?? []);
      filtered.forEach((s) => folderSet.add(s.folder || ''));
      folderSet.forEach((key) => groups.set(key, []));
      filtered.forEach((s) => groups.get(s.folder || '')!.push(s));
    }

    if (!groups.size) {
      renderedGroupKeys = [];
      syncToggleFoldersBtn();
      return;
    }

    // 未分类（空串）组排最后
    const keys = Array.from(groups.keys()).sort((a, b) => {
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b, 'zh');
    });

    keys.forEach((folderKey) => {
      const expanded = expandedFolders.has(folderKey);
      const section = document.createElement('div');
      section.className = 'server-group';

      const title = document.createElement('div');
      title.className = 'server-group-title';
      title.dataset.folder = folderKey;
      // 折叠指示：收起 = 闭合文件夹 / 展开 = 打开的文件夹（标题行点击切换，见 #server-grid 事件委托）
      const titleIcon = document.createElement('span');
      titleIcon.className = 'sg-folder';
      titleIcon.innerHTML = icon(expanded ? 'folderOpen' : 'folder');
      const titleText = document.createElement('span');
      titleText.textContent = folderKey || '未分类';
      const count = document.createElement('span');
      count.className = 'tag';
      count.textContent = String(groups.get(folderKey)!.length);
      title.append(titleIcon, titleText, count);

      // 未分类不可重命名/删除；其余组标题行提供重命名入口（事件委托见 #server-grid）
      if (folderKey) {
        const renameBtn = document.createElement('button');
        renameBtn.className = 'icon-btn';
        renameBtn.title = `重命名「${folderKey}」`;
        renameBtn.innerHTML = icon('pencil');
        renameBtn.dataset.act = 'rename-folder';
        renameBtn.dataset.folder = folderKey;
        title.append(renameBtn);
        // 仅空组（计数 0）可删除
        if (groups.get(folderKey)!.length === 0) {
          const delBtn = document.createElement('button');
          delBtn.className = 'icon-btn danger';
          delBtn.title = `删除「${folderKey}」`;
          delBtn.innerHTML = icon('trash');
          delBtn.dataset.act = 'del-folder';
          delBtn.dataset.folder = folderKey;
          title.append(delBtn);
        }
      }

      const inner = document.createElement('div');
      inner.className = 'server-grid';
      inner.classList.toggle('hidden', !expanded);
      groups.get(folderKey)!.forEach((s) => inner.appendChild(buildServerCard(s)));

      section.append(title, inner);
      grid.appendChild(section);
    });
    renderedGroupKeys = keys;
    syncToggleFoldersBtn();
  }

  // 搜索过滤：输入即重渲染（输入框为静态骨架，不随列表重建，焦点不丢）
  serverSearch.addEventListener('input', () => {
    searchQuery = serverSearch.value.trim().toLowerCase();
    renderServers();
  });

  // 事件委托：编辑 / 删除 / AI 锁切换 / 分类目录重命名、删除 / 组标题折叠切换
  grid.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.icon-btn');
    if (btn) {
      if (btn.dataset.act === 'rename-folder') {
        void renameFolderFlow(btn.dataset.folder ?? '');
        return;
      }
      if (btn.dataset.act === 'del-folder') {
        void deleteFolderFlow(btn.dataset.folder ?? '');
        return;
      }
      const server = db.servers.find((s) => s.id === btn.dataset.id);
      if (!server) return;
      if (btn.dataset.act === 'edit') openServerModal(server);
      else if (btn.dataset.act === 'del') void deleteServerFlow(server);
      else if (btn.dataset.act === 'lock') void toggleServerLock(server);
      return;
    }
    // 组标题行点击 = 展开/收起（标题行内按钮已在上方分支处理，不会误触发折叠）
    const title = (e.target as HTMLElement).closest<HTMLElement>('.server-group-title');
    if (title) toggleFolder(title.dataset.folder ?? '');
  });

  // 拖拽改分类（页面内 HTML5 DnD）：dragstart 记录服务器 id，组标题行（含未分类）为放置目标
  grid.addEventListener('dragstart', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.server-card');
    if (!e.dataTransfer || !card?.dataset.id) return;
    e.dataTransfer.setData('application/x-aishell-server', card.dataset.id);
    e.dataTransfer.setData('text/plain', card.dataset.id); // 兜底：外部场景读不到自定义类型
    card.classList.add('dragging');
  });

  grid.addEventListener('dragend', (e) => {
    (e.target as HTMLElement).closest<HTMLElement>('.server-card')?.classList.remove('dragging');
    // 拖出窗口 / 中途取消时清理残留的放置高亮
    grid.querySelectorAll('.server-group-title.drop-target').forEach((t) => t.classList.remove('drop-target'));
  });

  grid.addEventListener('dragover', (e) => {
    const title = (e.target as HTMLElement).closest<HTMLElement>('.server-group-title');
    if (!e.dataTransfer || !title) return;
    if (!Array.from(e.dataTransfer.types).includes('application/x-aishell-server')) return;
    e.preventDefault(); // 声明可放置，drop 才会触发
    title.classList.add('drop-target');
  });

  grid.addEventListener('dragleave', (e) => {
    const title = (e.target as HTMLElement).closest<HTMLElement>('.server-group-title');
    if (!title) return;
    if (e.relatedTarget instanceof Node && title.contains(e.relatedTarget)) return; // 标题内子元素间移动不取消
    title.classList.remove('drop-target');
  });

  grid.addEventListener('drop', (e) => {
    const title = (e.target as HTMLElement).closest<HTMLElement>('.server-group-title');
    if (!e.dataTransfer || !title) return;
    e.preventDefault();
    title.classList.remove('drop-target');
    const id = e.dataTransfer.getData('application/x-aishell-server') || e.dataTransfer.getData('text/plain');
    const server = db.servers.find((s) => s.id === id);
    if (!server) return;
    const folderKey = title.dataset.folder ?? '';
    if (server.folder === folderKey) return; // 已在目标组，跳过
    void moveServerToFolder(server, folderKey);
  });

  /** 组标题行点击：切换折叠状态（键 = folder 值，含未分类空串）并重渲染 */
  function toggleFolder(folder: string) {
    if (expandedFolders.has(folder)) expandedFolders.delete(folder);
    else expandedFolders.add(folder);
    renderServers();
  }

  /** 拖拽移动服务器到目标目录：密码传 null 保持 keyring 原值 */
  async function moveServerToFolder(server: Server, folder: string): Promise<void> {
    try {
      await upsertServer({ ...server, folder }, null);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    db = await getState();
    renderServers();
    toast(`已移动到「${folder || '未分类'}」`, 'success');
  }

  /* ---------- 分类目录：新建 / 重命名 ---------- */
  async function createFolderFlow(): Promise<void> {
    const name = await promptDialog({
      title: '新建分类目录',
      label: '目录路径（可含 / 层级）',
      placeholder: '例如：生产环境/Web',
      okText: '创建',
      allowPath: true,
    });
    if (name === null) return;
    try {
      await createServerFolder(name);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    db = await getState();
    renderServers();
    toast(`分类目录「${name}」已创建`, 'success');
  }

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
      toast(String(err), 'error');
      return;
    }
    db = await getState();
    renderServers();
    toast(`分类目录已重命名为「${name}」`, 'success');
  }

  /** 删除空分类目录：确认后调后端（失败显示后端中文错误），仅空组标题行有删除按钮 */
  async function deleteFolderFlow(folder: string): Promise<void> {
    const ok = await confirmDialog({
      title: '删除分类目录',
      message: `确定删除分类目录「${folder}」吗？`,
      danger: true,
      okText: '删除',
    });
    if (!ok) return;
    try {
      await deleteServerFolder(folder);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    db = await getState();
    expandedFolders.delete(folder); // 已删除目录不再保留折叠状态
    renderServers();
    toast(`分类目录「${folder}」已删除`, 'success');
  }

  /** AI 锁切换：原子 API 成功后原地更新 db.servers，失败回退并 toast */
  async function toggleServerLock(server: Server): Promise<void> {
    const next = !server.locked;
    try {
      await setServerLocked(server.id, next);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    server.locked = next;
    renderServers();
    toast(next ? `已锁定「${server.name}」的 AI 远程操作` : `已解锁「${server.name}」的 AI 远程操作`, 'success');
  }

  async function deleteServerFlow(server: Server) {
    const bound = db.projects.filter((p) => p.serverIds.includes(server.id)).map((p) => p.name);
    let msg = `确定要删除服务器「${server.name}」吗？`;
    if (bound.length) {
      msg += `该服务器被以下项目绑定：${bound.join('、')}。删除后将从这些项目的绑定中移除。`;
    } else {
      msg += '此操作不可撤销。';
    }
    const ok = await confirmDialog({ title: '删除服务器', message: msg, danger: true, okText: '删除' });
    if (!ok) return;
    try {
      await deleteServer(server.id);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    // 后端已级联从绑定项目的 serverIds 中移除，本地同步
    db.servers = db.servers.filter((s) => s.id !== server.id);
    db.projects.forEach((p) => {
      p.serverIds = p.serverIds.filter((id) => id !== server.id);
    });
    renderServers();
    toast(`已删除服务器「${server.name}」`, 'success');
  }

  /* ---------- 新建 / 编辑模态框 ---------- */
  /** 所属目录组合框候选：db.serverFolders ∪ 各服务器 folder 派生值，去重排序；未分类不列。
   *  attachCombo 每次展开时调用，手输新目录保存时由后端 upsert_server 自动注册。 */
  const folderOptions = (): string[] => {
    const names = new Set<string>(db.serverFolders ?? []);
    db.servers.forEach((s) => { if (s.folder) names.add(s.folder); });
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh'));
  };
  attachCombo(fFolder, folderOptions);

  function openServerModal(server: Server | null) {
    editingId = server ? server.id : null;
    modalTitle.textContent = server ? '编辑服务器' : '新建服务器';
    fName.value = server ? server.name : '';
    fHost.value = server ? server.host : '';
    fPort.value = server ? String(server.port) : '22';
    fAuth.value = server ? server.authType : 'password';
    fUsername.value = server ? server.username : '';
    fPassword.value = ''; // 已保存的密码永不回传，留空 = 不修改
    fKeyPath.value = server ? server.keyPath : '';
    fFolder.value = server ? server.folder : '';
    syncAuthFields();
    modal.classList.remove('hidden');
    requestAnimationFrame(() => modal.classList.add('open'));
    fName.focus();
  }

  function closeServerModal() {
    modal.classList.remove('open');
    setTimeout(() => modal.classList.add('hidden'), 160);
  }

  // 认证方式切换：联动显示 / 隐藏 账号密码 或 密钥文件路径
  function syncAuthFields() {
    const mode = fAuth.value;
    modal.querySelectorAll('.field[data-auth]').forEach((field) => {
      field.classList.toggle('hidden', field.getAttribute('data-auth') !== mode);
    });
  }

  fAuth.addEventListener('change', syncAuthFields);

  (root.querySelector('#server-modal-close') as HTMLElement).addEventListener('click', closeServerModal);
  (root.querySelector('#server-modal-cancel') as HTMLElement).addEventListener('click', closeServerModal);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeServerModal(); });
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeServerModal();
  };
  document.addEventListener('keydown', onKeydown);

  // 浏览…：真实文件选择（plugin-dialog）
  (root.querySelector('#btn-browse-key') as HTMLElement).addEventListener('click', async () => {
    const path = await openDialog();
    if (path) fKeyPath.value = path;
  });

  (root.querySelector('#btn-new-server') as HTMLElement).addEventListener('click', () => openServerModal(null));
  (root.querySelector('#btn-new-folder') as HTMLElement).addEventListener('click', () => void createFolderFlow());

  // 全部展开 / 全部折叠：单按钮按当前状态切换，图标 = 目标动作（folderOpen 展开 / folder 折叠）
  const toggleFoldersBtn = root.querySelector('#btn-toggle-folders') as HTMLButtonElement;
  const syncToggleFoldersBtn = () => {
    const allExpanded = renderedGroupKeys.length > 0 && renderedGroupKeys.every((k) => expandedFolders.has(k));
    toggleFoldersBtn.innerHTML = icon(allExpanded ? 'folder' : 'folderOpen');
    toggleFoldersBtn.title = allExpanded ? '全部折叠' : '全部展开';
  };
  toggleFoldersBtn.addEventListener('click', () => {
    const allExpanded = renderedGroupKeys.length > 0 && renderedGroupKeys.every((k) => expandedFolders.has(k));
    if (allExpanded) expandedFolders.clear();
    else renderedGroupKeys.forEach((k) => expandedFolders.add(k));
    renderServers();
  });

  /* ---------- 从 Xshell 一键导入 ---------- */
  const btnImportXshell = root.querySelector('#btn-import-xshell') as HTMLButtonElement;
  const importNote = root.querySelector('#import-note') as HTMLElement;
  btnImportXshell.addEventListener('click', () => void importXshellFlow());

  async function importXshellFlow() {
    // 进行态：禁用按钮并替换内容，成功/失败都恢复
    const originalHtml = btnImportXshell.innerHTML;
    const setBusy = (busy: boolean) => {
      btnImportXshell.disabled = busy;
      btnImportXshell.innerHTML = busy ? `${icon('loader')} 正在扫描 Xshell 会话…` : originalHtml;
    };
    // 导入结果落库并刷新（自动扫描与手动重试共用）
    const applyResult = async (r: XshellImportResult) => {
      db = await getState();
      renderServers();
      toast(`Xshell 导入完成：新增 ${r.imported}，更新 ${r.updated}，未变化 ${r.unchanged}，跳过 ${r.skipped}`, 'success');
      // needsAttention>0 时用面板内持久提示（toast 仅 2.2s 读不完长文案）；=0 时隐藏
      importNote.classList.toggle('hidden', r.needsAttention === 0);
      if (r.needsAttention > 0) {
        importNote.innerHTML = `${icon('alert')} 已导入，但有 ${r.needsAttention} 个会话需处理：Xshell 密码不会迁移；NSSSH 专用密钥请在 Xshell 的「工具 → 用户密钥管理器」中导出为无密码短语的 OpenSSH 私钥，再编辑服务器替换密钥路径`;
      }
    };
    setBusy(true);
    try {
      await applyResult(await importXshellSessions());
    } catch (err) {
      // 自动扫描失败（通常 Xshell 装在非默认位置）→ 弹目录选择器让用户手动指定会话目录重试
      const dir = await openDialog({
        directory: true,
        title: '选择 Xshell 会话目录',
      });
      if (dir) {
        setBusy(true);
        try {
          await applyResult(await importXshellFromDir(dir));
        } catch (err2) {
          toast(String(err2), 'error');
        }
      } else {
        toast(String(err), 'error');
      }
    } finally {
      setBusy(false);
    }
  }
  (root.querySelector('#server-modal-save') as HTMLElement).addEventListener('click', () => void saveServer());

  async function saveServer() {
    const name = fName.value.trim();
    const host = fHost.value.trim();
    const port = parseInt(fPort.value, 10);
    const authType = fAuth.value as Server['authType'];
    const username = fUsername.value.trim();
    const password = fPassword.value;
    const keyPath = fKeyPath.value.trim();
    // 所属目录：规范化 '/' 分隔路径（去首尾/重复分隔符），留空 = 未分类
    const folder = fFolder.value.trim().split('/').filter(Boolean).join('/');

    if (!name) { toast('请填写服务器名称', 'error'); return; }
    if (!host) { toast('请填写 IP 地址', 'error'); return; }
    if (!fPort.value || isNaN(port) || port < 1 || port > 65535) { toast('请填写有效的 SSH 端口（1-65535）', 'error'); return; }
    if (!username) { toast('请填写账号', 'error'); return; }
    if (authType === 'password') {
      // 新建必须填密码；编辑留空 = 不修改已保存的密码
      if (!editingId && !password) { toast('请填写密码', 'error'); return; }
    } else if (!keyPath) {
      toast('请填写密钥文件路径', 'error');
      return;
    }

    const server: Server = {
      id: editingId ?? uid('srv'),
      name, host, port, authType,
      username,
      keyPath: authType === 'key' ? keyPath : '',
      folder,
      // 编辑时保留原 AI 锁，新建默认未锁定
      locked: editingId ? (db.servers.find((s) => s.id === editingId)?.locked ?? false) : false,
    };
    const passwordOrNull = authType === 'password' ? (password || null) : null;

    try {
      await upsertServer(server, passwordOrNull);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }

    if (editingId) {
      const target = db.servers.find((s) => s.id === editingId);
      if (target) Object.assign(target, server);
    } else {
      db.servers.push(server);
    }
    closeServerModal();
    renderServers();
    toast(editingId ? '服务器已更新' : '服务器已创建', 'success');
  }

  /* ============================================================
     系统设置
     ============================================================ */
  function loadSystemSettings() {
    const s = db.settings;
    /* 主题取内存当前值:顶栏即时切换后 db 缓存已过期,不能用 s.theme */
    fTheme.value = currentTheme();
    fWorkspace.value = s.workspaceDir || '';
    fModelId.value = s.llm.modelId || '';
    fBaseUrl.value = s.llm.baseUrl || '';
    fApiKey.value = ''; // 已保存的 key 永不回传，留空 = 不修改
    fEffort.value = s.llm.effort || 'low';
    fSearchEnabled.checked = s.search?.enabled ?? false;
    fBraveKey.value = ''; // 同上：Brave key 永不回传
  }

  // Workspace 浏览…：真实目录选择
  (root.querySelector('#btn-browse-ws') as HTMLElement).addEventListener('click', async () => {
    const path = await openDialog({ directory: true });
    if (path) fWorkspace.value = path;
  });

  // API Key 显隐切换
  const btnToggleKey = root.querySelector('#btn-toggle-key') as HTMLElement;
  btnToggleKey.addEventListener('click', () => {
    const visible = fApiKey.type === 'text';
    fApiKey.type = visible ? 'password' : 'text';
    btnToggleKey.innerHTML = visible ? icon('eye') : icon('eyeOff');
    btnToggleKey.title = visible ? '显示 / 隐藏' : '隐藏 / 显示';
  });

  // Brave API Key 显隐切换
  const btnToggleBrave = root.querySelector('#btn-toggle-brave') as HTMLElement;
  btnToggleBrave.addEventListener('click', () => {
    const visible = fBraveKey.type === 'text';
    fBraveKey.type = visible ? 'password' : 'text';
    btnToggleBrave.innerHTML = visible ? icon('eye') : icon('eyeOff');
    btnToggleBrave.title = visible ? '显示 / 隐藏' : '隐藏 / 显示';
  });

  // hint 链接：外部浏览器打开（webview 内点击导航会离开页面，必须拦截）
  root.querySelectorAll<HTMLElement>('a[data-open-url]').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const url = el.dataset.openUrl;
      if (!url) return;
      void openUrl(url).catch((err) => toast(`无法打开链接: ${String(err)}`, 'error'));
    });
  });

  /* 主题选择即时生效(与顶栏按钮同语义),保存按钮不再负责主题 */
  fTheme.addEventListener('change', () => {
    const t = fTheme.value as Theme;
    applyTheme(t);
    setTheme(t).catch((err) => toast(`主题保存失败: ${String(err)}`, 'error'));
  });
  /* 顶栏切换时同步 select 显示(仅在本页存活期) */
  const offTheme = onThemeChange((t) => { fTheme.value = t; });

  (root.querySelector('#btn-save-system') as HTMLElement).addEventListener('click', () => void saveSystemSettings());

  async function saveSystemSettings() {
    const workspaceDir = fWorkspace.value.trim();
    if (!workspaceDir) {
      toast('请填写 Workspace 目录', 'error');
      fWorkspace.focus();
      return;
    }
    const llm: LlmConfig = {
      modelId: fModelId.value.trim(),
      baseUrl: fBaseUrl.value.trim(),
      effort: fEffort.value as LlmConfig['effort'],
    };
    const apiKey = fApiKey.value.trim();
    const braveKey = fBraveKey.value.trim();
    /* theme 带内存当前值:避免本页打开期间顶栏切换的主题被表单旧值覆盖 */
    const settings = { workspaceDir, llm, search: { enabled: fSearchEnabled.checked }, theme: currentTheme() };
    try {
      await saveSettings(settings, apiKey || null, braveKey || null);
      db.settings = settings;
      toast('设置已保存', 'success');
    } catch (err) {
      toast(String(err), 'error');
    }
  }

  /* ---------- 初始化 ---------- */
  void getState()
    .then((s) => {
      db = s;
      renderServers();
      loadSystemSettings();
      // ?new=server：服务器面板「新建」快捷入口直达——数据就绪后立即弹出新建模态框
      if (params.get('new') === 'server') openServerModal(null);
    })
    .catch((err) => toast(String(err), 'error'));

  // 命令面板（Ctrl+T）等全局操作清空/变更数据后广播，此处重新拉取渲染
  const onDataChanged = () => {
    void getState()
      .then((s) => { db = s; renderServers(); })
      .catch((err) => toast(String(err), 'error'));
  };
  window.addEventListener('aishell:data-changed', onDataChanged);

  return () => {
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('aishell:data-changed', onDataChanged);
    offTheme();
  };
};
