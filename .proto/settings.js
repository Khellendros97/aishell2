/* ============================================================
   AIShell 原型 - 设置页逻辑
   依赖：shared/mock.js（window.AIShell）、shared/design.css
   ============================================================ */
(function () {
  'use strict';

  const A = window.AIShell;
  let db = A.load();

  /* ---------- 页面骨架 ---------- */
  A.renderTopbar('settings');

  // reason=missing-config：顶部黄色提示条
  if (new URLSearchParams(location.search).get('reason') === 'missing-config') {
    document.getElementById('warn-banner').classList.add('show');
  }

  const navItems = document.querySelectorAll('#settings-nav .nav-item');
  const panels = {
    servers: document.getElementById('panel-servers'),
    system: document.getElementById('panel-system'),
  };

  /* ---------- 左侧导航切换 ---------- */
  function switchPanel(name) {
    navItems.forEach((item) => item.classList.toggle('active', item.dataset.panel === name));
    Object.entries(panels).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
  }
  navItems.forEach((item) => {
    item.addEventListener('click', () => switchPanel(item.dataset.panel));
  });

  /* ============================================================
     服务器配置
     ============================================================ */
  const grid = document.getElementById('server-grid');
  const emptyState = document.getElementById('server-empty');
  const countTag = document.getElementById('server-count');

  const AUTH_LABEL = { password: '密码', key: '密钥' };

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
      editBtn.textContent = '✎';
      editBtn.dataset.act = 'edit';
      editBtn.dataset.id = s.id;

      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn danger';
      delBtn.title = '删除';
      delBtn.textContent = '🗑';
      delBtn.dataset.act = 'del';
      delBtn.dataset.id = s.id;

      // AI 操作锁：仅约束 AI 发起的远程动作，不影响用户手动 SSH/SFTP
      const lockBtn = document.createElement('button');
      lockBtn.className = 'icon-btn' + (s.locked ? ' active' : '');
      lockBtn.title = s.locked ? 'AI 操作已锁定：点击解锁' : '锁定 AI 远程操作（手动 SSH/SFTP 不受影响）';
      lockBtn.textContent = s.locked ? '🔒' : '🔓';
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
      user.textContent = '👤 ' + (s.username || '-');
      meta.append(tag, user);

      card.append(head, host, meta);
      grid.appendChild(card);
    });
  }

  // 事件委托：编辑 / 删除 / AI 锁切换
  grid.addEventListener('click', async (e) => {
    const btn = e.target.closest('.icon-btn');
    if (!btn) return;
    const server = db.servers.find((s) => s.id === btn.dataset.id);
    if (!server) return;
    if (btn.dataset.act === 'edit') openServerModal(server);
    else if (btn.dataset.act === 'del') await deleteServer(server);
    else if (btn.dataset.act === 'lock') {
      // AI 锁只影响 AI 发起的远程动作；用户手动 SSH/SFTP 不受影响
      server.locked = !server.locked;
      A.save(db);
      renderServers();
      A.toast(server.locked ? `已锁定「${server.name}」的 AI 远程操作` : `已解锁「${server.name}」的 AI 远程操作`, 'success');
    }
  });

  async function deleteServer(server) {
    const bound = db.projects.filter((p) => p.serverIds.includes(server.id)).map((p) => p.name);
    let msg = `确定要删除服务器「${server.name}」吗？`;
    if (bound.length) {
      msg += `该服务器被以下项目绑定：${bound.join('、')}。删除后将从这些项目的绑定中移除。`;
    } else {
      msg += '此操作不可撤销。';
    }
    const ok = await A.confirmDialog({ title: '删除服务器', message: msg, danger: true, okText: '删除' });
    if (!ok) return;
    // 级联：从绑定项目的 serverIds 中移除
    db.servers = db.servers.filter((s) => s.id !== server.id);
    db.projects.forEach((p) => {
      p.serverIds = p.serverIds.filter((id) => id !== server.id);
    });
    A.save(db);
    renderServers();
    A.toast(`已删除服务器「${server.name}」`, 'success');
  }

  /* ---------- 新建 / 编辑模态框 ---------- */
  const modal = document.getElementById('server-modal');
  const modalTitle = document.getElementById('server-modal-title');
  const fName = document.getElementById('f-name');
  const fHost = document.getElementById('f-host');
  const fPort = document.getElementById('f-port');
  const fAuth = document.getElementById('f-auth');
  const fUsername = document.getElementById('f-username');
  const fPassword = document.getElementById('f-password');
  const fKeyPath = document.getElementById('f-keypath');
  let editingId = null;

  function openServerModal(server) {
    editingId = server ? server.id : null;
    modalTitle.textContent = server ? '编辑服务器' : '新建服务器';
    fName.value = server ? server.name : '';
    fHost.value = server ? server.host : '';
    fPort.value = server ? String(server.port) : '22';
    fAuth.value = server ? server.authType : 'password';
    fUsername.value = server ? server.username : '';
    fPassword.value = server ? server.password : '';
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

  // 认证方式切换：联动显示 / 隐藏账号密码 或 密钥文件路径
  function syncAuthFields() {
    const mode = fAuth.value;
    modal.querySelectorAll('.field[data-auth]').forEach((field) => {
      field.classList.toggle('hidden', field.dataset.auth !== mode);
    });
  }

  fAuth.addEventListener('change', syncAuthFields);

  document.getElementById('server-modal-close').addEventListener('click', closeServerModal);
  document.getElementById('server-modal-cancel').addEventListener('click', closeServerModal);
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeServerModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeServerModal();
  });

  // 浏览…：模拟文件选择
  document.getElementById('btn-browse-key').addEventListener('click', () => {
    fKeyPath.value = 'C:\\Users\\demo\\.ssh\\id_ed25519';
  });

  document.getElementById('btn-new-server').addEventListener('click', () => openServerModal(null));

  document.getElementById('server-modal-save').addEventListener('click', saveServer);

  function saveServer() {
    const name = fName.value.trim();
    const host = fHost.value.trim();
    const port = parseInt(fPort.value, 10);
    const authType = fAuth.value;
    const username = fUsername.value.trim();
    const password = fPassword.value;
    const keyPath = fKeyPath.value.trim();

    if (!name) return A.toast('请填写服务器名称', 'error');
    if (!host) return A.toast('请填写 IP 地址', 'error');
    if (!fPort.value || isNaN(port) || port < 1 || port > 65535) return A.toast('请填写有效的 SSH 端口（1-65535）', 'error');
    if (authType === 'password') {
      if (!username) return A.toast('请填写账号', 'error');
      if (!password) return A.toast('请填写密码', 'error');
    } else if (!keyPath) {
      return A.toast('请填写密钥文件路径', 'error');
    }

    if (editingId) {
      const target = db.servers.find((s) => s.id === editingId);
      if (target) Object.assign(target, { name, host, port, authType, username, password, keyPath });
    } else {
      db.servers.push({
        id: A.uid('srv'), name, host, port, authType,
        username: authType === 'password' ? username : '',
        password: authType === 'password' ? password : '',
        keyPath: authType === 'key' ? keyPath : '',
      });
    }
    A.save(db);
    closeServerModal();
    renderServers();
    A.toast(editingId ? '服务器已更新' : '服务器已创建', 'success');
  }

  /* ============================================================
     系统设置
     ============================================================ */
  const fWorkspace = document.getElementById('f-workspace');
  const fModelId = document.getElementById('f-model-id');
  const fBaseUrl = document.getElementById('f-base-url');
  const fApiKey = document.getElementById('f-api-key');
  const fEffort = document.getElementById('f-effort');

  function loadSystemSettings() {
    const s = db.settings || {};
    fWorkspace.value = s.workspaceDir || '';
    const llm = s.llm || {};
    fModelId.value = llm.modelId || '';
    fBaseUrl.value = llm.baseUrl || '';
    fApiKey.value = llm.apiKey || '';
    fEffort.value = llm.effort || 'medium';
  }

  // Workspace 浏览…：模拟选择
  document.getElementById('btn-browse-ws').addEventListener('click', () => {
    fWorkspace.value = 'D:\\AIShellWorkspace';
  });

  // API Key 显隐切换
  document.getElementById('btn-toggle-key').addEventListener('click', (e) => {
    const visible = fApiKey.type === 'text';
    fApiKey.type = visible ? 'password' : 'text';
    e.currentTarget.textContent = visible ? '👁' : '🙈';
    e.currentTarget.title = visible ? '显示 / 隐藏' : '隐藏 / 显示';
  });

  document.getElementById('btn-save-system').addEventListener('click', () => {
    const workspaceDir = fWorkspace.value.trim();
    if (!workspaceDir) {
      A.toast('请填写 Workspace 目录', 'error');
      fWorkspace.focus();
      return;
    }
    db.settings.workspaceDir = workspaceDir;
    db.settings.llm = {
      modelId: fModelId.value.trim(),
      baseUrl: fBaseUrl.value.trim(),
      apiKey: fApiKey.value.trim(),
      effort: fEffort.value,
    };
    A.save(db);
    A.toast('设置已保存', 'success');
  });

  /* ---------- 初始化 ---------- */
  loadSystemSettings();
  renderServers();
})();
