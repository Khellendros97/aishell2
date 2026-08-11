/* ============================================================
   AIShell 欢迎页（项目列表）
   依赖 shared/mock.js 提供的 AIShell 全局 API。
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 状态 ---------- */
  let db = null;
  let editingId = null;            // null = 新建；否则为正在编辑的项目 id
  let selectedServerIds = [];      // 模态框中多选的服务器 id
  let mockDirIndex = 0;
  const mockDirs = [
    'D:\\projects\\new-app',
    'D:\\projects\\api-service',
    'D:\\projects\\web-console',
  ];

  const $ = (id) => document.getElementById(id);

  const els = {
    grid: $('proj-grid'),
    empty: $('empty-state'),
    count: $('proj-count'),
    btnNew: $('btn-new'),
    btnEmptyNew: $('btn-empty-new'),
    btnReset: $('btn-reset'),
    modal: $('proj-modal'),
    modalTitle: $('modal-title'),
    modalClose: $('modal-close'),
    btnCancel: $('btn-cancel'),
    btnSave: $('btn-save'),
    fName: $('f-name'),
    fNameErr: $('f-name-err'),
    fPath: $('f-path'),
    btnBrowse: $('btn-browse'),
    serverList: $('server-list'),
    addToggle: $('server-add-toggle'),
    mini: $('server-mini'),
    miniName: $('mini-name'),
    miniHost: $('mini-host'),
    miniPort: $('mini-port'),
    miniAuth: $('mini-auth'),
    miniUser: $('mini-user'),
    miniSecret: $('mini-secret'),
    miniSecretLabel: $('mini-secret-label'),
    miniErr: $('mini-err'),
    miniSave: $('mini-save'),
    miniCancel: $('mini-cancel'),
  };

  /* ---------- 工具 ---------- */
  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ---------- 启动 ---------- */
  AIShell.renderTopbar('welcome');
  db = AIShell.load();

  // 启动检查：缺少 workspace 配置 → 设置页
  if (!db.settings || !db.settings.workspaceDir) {
    location.replace('settings.html?reason=missing-config');
    return;
  }

  /* ---------- 项目列表渲染 ---------- */
  function renderProjects() {
    const projects = db.projects || [];
    els.count.textContent = `${projects.length} 个项目`;
    els.grid.innerHTML = '';

    projects.forEach((p) => {
      const hasPath = !!p.path;
      const wsDir = (db.settings && db.settings.workspaceDir) || '';
      const displayPath = hasPath ? p.path : `${wsDir}\\${p.name}`;
      const servers = (p.serverIds || [])
        .map((id) => db.servers.find((s) => s.id === id))
        .filter(Boolean);
      const serverTags = servers.length
        ? servers.map((s) => `<span class="tag blue">${esc(s.name)}</span>`).join('')
        : '<span class="tag">仅本地</span>';

      const card = document.createElement('div');
      card.className = 'card clickable project-card';
      card.dataset.id = p.id;
      card.innerHTML = `
        <div class="pc-head">
          <span class="pc-name ellipsis" title="${esc(p.name)}">${esc(p.name)}</span>
          <div class="pc-actions">
            <button class="icon-btn" data-act="edit" title="编辑项目">⚙</button>
            <button class="icon-btn danger" data-act="delete" title="删除项目">🗑</button>
          </div>
        </div>
        <div class="pc-path mono ellipsis" title="${esc(displayPath)}">
          ${esc(displayPath)}${hasPath ? '' : ' <span class="tag yellow">workspace</span>'}
        </div>
        <div class="pc-tags">${serverTags}</div>`;
      els.grid.appendChild(card);
    });

    els.empty.classList.toggle('hidden', projects.length > 0);
  }

  /* ---------- 卡片交互（事件委托） ---------- */
  els.grid.addEventListener('click', (e) => {
    const card = e.target.closest('.project-card');
    if (!card) return;
    const actBtn = e.target.closest('[data-act]');
    if (actBtn) {
      if (actBtn.dataset.act === 'edit') openModal('edit', card.dataset.id);
      else if (actBtn.dataset.act === 'delete') deleteProject(card.dataset.id);
      return;
    }
    location.href = 'workbench.html?project=' + card.dataset.id;
  });

  /* ---------- 删除项目 ---------- */
  async function deleteProject(id) {
    const proj = db.projects.find((p) => p.id === id);
    if (!proj) return;
    const ok = await AIShell.confirmDialog({
      title: '删除项目',
      message: `确定要删除项目「${proj.name}」吗？仅删除项目记录，不会删除磁盘文件。`,
      danger: true,
      okText: '删除',
    });
    if (!ok) return;
    db.projects = db.projects.filter((p) => p.id !== id);
    AIShell.save(db);
    renderProjects();
    AIShell.toast('项目已删除', 'success');
  }

  /* ---------- 新建 / 编辑模态框 ---------- */
  function openModal(mode, id) {
    editingId = mode === 'edit' ? id : null;
    els.modalTitle.textContent = editingId ? '编辑项目' : '新建项目';

    if (editingId) {
      const proj = db.projects.find((p) => p.id === editingId);
      if (!proj) return;
      els.fName.value = proj.name || '';
      els.fPath.value = proj.path || '';
      selectedServerIds = (proj.serverIds || []).slice();
    } else {
      els.fName.value = '';
      els.fPath.value = '';
      selectedServerIds = [];
    }

    clearNameError();
    renderServerList();
    els.modal.classList.add('open');
    els.fName.focus();
  }

  function closeModal() {
    els.modal.classList.remove('open');
  }

  els.btnNew.onclick = () => openModal('new');
  els.btnEmptyNew.onclick = () => openModal('new');
  els.modalClose.onclick = closeModal;
  els.btnCancel.onclick = closeModal;
  els.modal.addEventListener('mousedown', (e) => {
    if (e.target === els.modal) closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.modal.classList.contains('open')) closeModal();
  });

  /* 名称必填校验 */
  function showNameError() {
    els.fName.classList.add('invalid');
    els.fNameErr.classList.remove('hidden');
    els.fName.focus();
  }
  function clearNameError() {
    els.fName.classList.remove('invalid');
    els.fNameErr.classList.add('hidden');
  }
  els.fName.addEventListener('input', clearNameError);

  /* 模拟目录浏览 */
  els.btnBrowse.onclick = () => {
    AIShell.toast('原型中模拟目录选择');
    els.fPath.value = mockDirs[mockDirIndex % mockDirs.length];
    mockDirIndex++;
  };

  /* Enter 快捷保存 */
  [els.fName, els.fPath].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') saveProject();
    });
  });

  /* 保存项目 */
  function saveProject() {
    const name = els.fName.value.trim();
    if (!name) {
      showNameError();
      return;
    }
    const path = els.fPath.value.trim();
    const serverIds = selectedServerIds.slice();

    if (editingId) {
      const proj = db.projects.find((p) => p.id === editingId);
      if (!proj) return;
      proj.name = name;
      proj.path = path;
      proj.serverIds = serverIds;
      AIShell.save(db);
      closeModal();
      renderProjects();
      AIShell.toast('已保存', 'success');
    } else {
      db.projects.push({
        id: AIShell.uid('proj'),
        name: name,
        path: path,
        serverIds: serverIds,
        quickCommands: [],
      });
      AIShell.save(db);
      closeModal();
      renderProjects();
      AIShell.toast('项目已创建', 'success');
    }
  }
  els.btnSave.onclick = saveProject;

  /* ---------- 服务器多选列表 ---------- */
  function renderServerList() {
    const servers = db.servers || [];
    if (!servers.length) {
      els.serverList.innerHTML = '<div class="server-empty">暂无服务器，可在下方新建</div>';
      return;
    }
    els.serverList.innerHTML = servers.map((s) => {
      const selected = selectedServerIds.includes(s.id);
      const authTag = s.authType === 'key'
        ? '<span class="tag yellow">密钥</span>'
        : '<span class="tag green">密码</span>';
      return `
        <div class="card clickable server-card${selected ? ' selected' : ''}" data-id="${esc(s.id)}">
          <div class="sc-head">
            <span class="sc-name ellipsis" title="${esc(s.name)}">${esc(s.name)}</span>
            ${authTag}
          </div>
          <div class="sc-meta mono">${esc(s.host)}:${esc(s.port)}</div>
        </div>`;
    }).join('');
  }

  els.serverList.addEventListener('click', (e) => {
    const card = e.target.closest('.server-card');
    if (!card) return;
    const id = card.dataset.id;
    const idx = selectedServerIds.indexOf(id);
    if (idx >= 0) selectedServerIds.splice(idx, 1);
    else selectedServerIds.push(id);
    renderServerList();
  });

  /* ---------- 快捷新建服务器 ---------- */
  function expandMini() {
    els.addToggle.classList.add('hidden');
    els.mini.classList.remove('hidden');
    clearMiniError();
    els.miniName.focus();
  }
  function collapseMini() {
    els.mini.classList.add('hidden');
    els.addToggle.classList.remove('hidden');
  }
  function clearMiniError() {
    els.miniErr.classList.add('hidden');
    [els.miniName, els.miniHost, els.miniPort].forEach((el) => el.classList.remove('invalid'));
  }
  function resetMini() {
    els.miniName.value = '';
    els.miniHost.value = '';
    els.miniPort.value = '22';
    els.miniAuth.value = 'password';
    els.miniUser.value = '';
    els.miniSecret.value = '';
    updateSecretField();
    clearMiniError();
  }

  els.addToggle.onclick = expandMini;
  els.miniCancel.onclick = () => { collapseMini(); resetMini(); };

  /* 认证方式切换：密码 ⇄ 密钥路径 */
  function updateSecretField() {
    const isKey = els.miniAuth.value === 'key';
    els.miniSecretLabel.textContent = isKey ? '密钥路径' : '密码';
    els.miniSecret.placeholder = isKey
      ? 'C:\\Users\\demo\\.ssh\\id_ed25519'
      : '输入服务器密码';
  }
  els.miniAuth.onchange = updateSecretField;

  function saveMiniServer() {
    clearMiniError();

    const name = els.miniName.value.trim();
    const host = els.miniHost.value.trim();
    const portRaw = els.miniPort.value.trim();

    let bad = false;
    if (!name) { els.miniName.classList.add('invalid'); bad = true; }
    if (!host) { els.miniHost.classList.add('invalid'); bad = true; }
    const port = parseInt(portRaw, 10);
    if (!portRaw || isNaN(port) || port < 1 || port > 65535) {
      els.miniPort.classList.add('invalid');
      bad = true;
    }
    if (bad) {
      els.miniErr.textContent = '请填写必填项（名称、IP、端口），端口需为 1-65535 的整数';
      els.miniErr.classList.remove('hidden');
      return;
    }

    const auth = els.miniAuth.value;
    const secret = els.miniSecret.value.trim();
    const srv = {
      id: AIShell.uid('srv'),
      name: name,
      host: host,
      port: port,
      authType: auth,
      username: els.miniUser.value.trim(),
      password: auth === 'password' ? secret : '',
      keyPath: auth === 'key' ? secret : '',
    };

    db.servers.push(srv);
    AIShell.save(db);
    selectedServerIds.push(srv.id);
    renderServerList();
    collapseMini();
    resetMini();
    AIShell.toast('服务器已创建并自动选中', 'success');
  }
  els.miniSave.onclick = saveMiniServer;

  /* ---------- 重置演示数据 ---------- */
  els.btnReset.onclick = async () => {
    const ok = await AIShell.confirmDialog({
      title: '重置演示数据',
      message: '确定要重置所有演示数据吗？项目、服务器与设置将恢复为初始状态。',
      danger: true,
      okText: '重置',
    });
    if (!ok) return;
    AIShell.reset();
    location.reload();
  };

  /* ---------- 初始渲染 ---------- */
  renderProjects();
})();
