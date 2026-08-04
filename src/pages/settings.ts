/**
 * 配置页 —— 移植自 .proto/settings.js + settings.html。
 * 差异：数据源为 Tauri 后端（get_state / upsert_server / delete_server / save_settings）；
 * 密码与 apiKey 表单留空提交 null（后端保持原值），显示位不打回明文；
 * 浏览按钮走 @tauri-apps/plugin-dialog；「重置演示数据」按钮本页无（见欢迎页「打开配置目录」）。
 */
import type { AppState, LlmConfig, Server, Theme } from '../types';
import { deleteServer, getState, importXshellSessions, openDialog, saveSettings, setServerLocked, setTheme, upsertServer } from '../api';
import { confirmDialog, toast, uid } from '../ui';
import { icon } from '../icons';
import { openUrl } from '@tauri-apps/plugin-opener';
import { applyTheme, currentTheme, onThemeChange } from '../theme';
import type { PageRender } from '../main';
import './settings.css';

const AUTH_LABEL: Record<string, string> = { password: '密码', key: '密钥' };

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
              <button id="btn-new-server" class="btn primary">${icon('plus')} 新建服务器</button>
            </div>
          </div>
          <div id="import-note" class="import-note hidden" role="status"></div>
          <div id="server-grid" class="server-grid"></div>
          <div id="server-empty" class="empty-state hidden">
            <div class="icon">${icon('monitor')}</div>
            <div>暂无服务器，点击右上角「新建服务器」开始配置</div>
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
    servers: [], projects: [], sessions: {},
  };

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
  function renderServers() {
    grid.innerHTML = '';
    countTag.textContent = String(db.servers.length);
    emptyState.classList.toggle('hidden', db.servers.length > 0);

    db.servers.forEach((s) => {
      const card = document.createElement('div');
      card.className = 'card server-card';

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
      grid.appendChild(card);
    });
  }

  // 事件委托：编辑 / 删除 / AI 锁切换
  grid.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('.icon-btn');
    if (!btn) return;
    const server = db.servers.find((s) => s.id === btn.dataset.id);
    if (!server) return;
    if (btn.dataset.act === 'edit') openServerModal(server);
    else if (btn.dataset.act === 'del') void deleteServerFlow(server);
    else if (btn.dataset.act === 'lock') void toggleServerLock(server);
  });

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

  /* ---------- 从 Xshell 一键导入 ---------- */
  const btnImportXshell = root.querySelector('#btn-import-xshell') as HTMLButtonElement;
  const importNote = root.querySelector('#import-note') as HTMLElement;
  btnImportXshell.addEventListener('click', () => void importXshellFlow());

  async function importXshellFlow() {
    // 进行态：禁用按钮并替换内容，成功/失败都恢复
    const originalHtml = btnImportXshell.innerHTML;
    btnImportXshell.disabled = true;
    btnImportXshell.innerHTML = `${icon('loader')} 正在扫描 Xshell 会话…`;
    try {
      const r = await importXshellSessions();
      db = await getState();
      renderServers();
      toast(`Xshell 导入完成：新增 ${r.imported}，更新 ${r.updated}，未变化 ${r.unchanged}，跳过 ${r.skipped}`, 'success');
      // needsAttention>0 时用面板内持久提示（toast 仅 2.2s 读不完长文案）；=0 时隐藏
      importNote.classList.toggle('hidden', r.needsAttention === 0);
      if (r.needsAttention > 0) {
        importNote.innerHTML = `${icon('alert')} 已导入，但有 ${r.needsAttention} 个会话需处理：Xshell 密码不会迁移；NSSSH 专用密钥请在 Xshell 的「工具 → 用户密钥管理器」中导出为无密码短语的 OpenSSH 私钥，再编辑服务器替换密钥路径`;
      }
    } catch (err) {
      toast(String(err), 'error');
    } finally {
      btnImportXshell.disabled = false;
      btnImportXshell.innerHTML = originalHtml;
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

  return () => {
    document.removeEventListener('keydown', onKeydown);
    offTheme();
  };
};
