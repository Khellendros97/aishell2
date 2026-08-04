/* ============================================================
   工作台左侧功能栏模块（sidebar）
   - 活动栏切换：explorer / servers / commands（commands 需终端标签准入）
   - 文件资源管理器：模拟文件树、内联新建、删除、拖拽（local 拖出 / remote 拖入）
   - 服务器列表：绑定服务器卡片，SSH / SFTP 标签页
   - 快捷指令：复制到终端 / 立即执行 / 编辑 / 删除，持久化到 AIShell db
   依赖：shared/mock.js（window.AIShell）、workbench-core.js（window.Workbench）
   仅创建本文件；不污染全局。
   ============================================================ */
(function () {
  'use strict';
  const A = window.AIShell;
  const WB = window.Workbench;
  if (!A || !WB) return;

  /* ---------- 模块内联样式（wbs- 前缀，避免与其他模块冲突） ---------- */
  const style = document.createElement('style');
  style.textContent = `
    .wbs-tree { padding: 4px 0 8px; }
    .wbs-row { display: flex; align-items: center; gap: 3px; height: 24px; padding-right: 6px;
      cursor: pointer; user-select: none; border-radius: 3px; }
    .wbs-row:hover { background: var(--bg-hover); }
    .wbs-arrow { width: 14px; flex: none; text-align: center; font-size: 10px; color: var(--text-2); }
    .wbs-file-tag { width: 26px; flex: none; text-align: center; font-size: 12px; line-height: 24px; }
    .wbs-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-size: 12.5px; color: var(--text-1); }
    .wbs-row:hover .wbs-name { color: var(--text-0); }
    .wbs-del { width: 20px; height: 20px; font-size: 12px; visibility: hidden; flex: none; }
    .wbs-row:hover .wbs-del { visibility: visible; }
    .wbs-inline-input { height: 22px; padding: 2px 8px; font-size: 12px; }
    .wbs-content { padding: 10px; display: flex; flex-direction: column; gap: 10px; }
    .wbs-server-card { padding: 12px 14px; display: flex; flex-direction: column; gap: 9px; }
    .wbs-server-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
    .wbs-server-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .wbs-server-addr { font-size: 11.5px; color: var(--text-2); }
    .wbs-server-actions { display: flex; gap: 8px; }
    .wbs-server-actions .btn { flex: 1; }
    .wbs-qc-card { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
    .wbs-qc-title { font-size: 13px; font-weight: 600; }
    .wbs-qc-cmd { font-size: 11.5px; color: var(--text-1); line-height: 1.5; word-break: break-all;
      white-space: pre-wrap; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .wbs-qc-actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .wbs-drop { outline: 1px dashed var(--accent); outline-offset: -1px; background: rgba(79, 142, 247, 0.08); }
  `;
  document.head.appendChild(style);

  /* ---------- DOM 引用（契约 ID，来自 workbench.html） ---------- */
  const activityBar = document.getElementById('activity-bar');
  const titleEl = document.getElementById('sidebar-title');
  const actionsEl = document.getElementById('sidebar-actions');
  const contentEl = document.getElementById('sidebar-content');

  const PANELS = { explorer: '文件资源管理器', servers: '服务器列表', commands: '快捷指令' };
  let currentPanel = 'explorer';

  /* ---------- 工具 ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ============================================================
     面板 1：文件资源管理器（模拟文件树）
     ============================================================ */
  const FILE_STYLES = {
    js: { label: 'js', color: '#e5c07b' },
    ts: { label: 'ts', color: '#4f8ef7' },
    py: { label: 'py', color: '#4ec98a' },
    css: { label: 'css', color: '#4f8ef7' },
    html: { label: 'html', color: '#e5626a' },
    json: { label: '{}', color: '#e5c07b' },
    md: { label: 'md', color: '#b687e8' },
    sh: { label: 'sh', color: '#4ec98a' },
    gitignore: { label: '⚙', color: '#6b7180' },
  };

  function buildMockTree() {
    const projPath = String(
      (WB.state.project && WB.state.project.path) ||
      (WB.state.db.settings && WB.state.db.settings.workspaceDir) ||
      'D:/AIShellWorkspace'
    ).replace(/\\/g, '/').replace(/\/+$/, '');
    const root = { name: projPath, path: projPath, isDir: true, children: [], parent: null };
    const add = (parent, name, isDir) => {
      const n = { name, path: parent.path + '/' + name, isDir, children: isDir ? [] : null, parent };
      parent.children.push(n);
      return n;
    };
    const src = add(root, 'src', true);
    add(src, 'main.js', false);
    add(src, 'core.py', false);
    add(src, 'app.css', false);
    add(src, 'index.html', false);
    const utils = add(src, 'utils', true);
    add(utils, 'fs_util.js', false);
    add(utils, 'net.py', false);
    const docs = add(root, 'docs', true);
    add(docs, 'README.md', false);
    add(docs, '架构设计.md', false);
    add(docs, 'api.md', false);
    const tests = add(root, 'tests', true);
    add(tests, 'test_core.py', false);
    const scripts = add(root, 'scripts', true);
    add(scripts, 'deploy.sh', false);
    add(root, 'package.json', false);
    add(root, 'tsconfig.json', false);
    add(root, '.gitignore', false);
    add(root, 'README.md', false);
    return root;
  }

  const treeRoot = buildMockTree();
  /* 展开状态：模块内记忆（path -> 展开） */
  const expanded = new Set([treeRoot.path]);
  (function preopen() {
    const byName = (dir, name) => (dir.children || []).find((n) => n.name === name) || null;
    const src = byName(treeRoot, 'src');
    if (src) {
      expanded.add(src.path);
      const utils = byName(src, 'utils');
      if (utils) expanded.add(utils.path);
    }
  })();

  function addRootChild(name, isDir) {
    let finalName = name;
    let i = 2;
    while (treeRoot.children.some((c) => c.name === finalName)) finalName = name + ' (' + i++ + ')';
    const node = { name: finalName, path: treeRoot.path + '/' + finalName, isDir, children: isDir ? [] : null, parent: treeRoot };
    treeRoot.children.push(node);
    if (isDir) expanded.add(node.path);
    renderExplorer();
  }

  function removeNode(node) {
    const parent = node.parent || treeRoot;
    const idx = parent.children.indexOf(node);
    if (idx >= 0) parent.children.splice(idx, 1);
    expanded.delete(node.path);
    renderExplorer();
  }

  function buildRow(node, depth, isRoot) {
    const row = document.createElement('div');
    row.className = 'wbs-row';
    row.style.paddingLeft = (6 + depth * 14) + 'px';

    const arrow = document.createElement('span');
    arrow.className = 'wbs-arrow';
    if (node.isDir) arrow.textContent = expanded.has(node.path) ? '▾' : '▸';
    row.appendChild(arrow);

    const icon = document.createElement('span');
    icon.className = 'wbs-file-tag';
    if (node.isDir) {
      icon.textContent = '📁';
    } else {
      const ext = (node.name.split('.').pop() || '').toLowerCase();
      const st = FILE_STYLES[ext];
      if (st) { icon.textContent = st.label; icon.style.fontSize = '9.5px'; icon.style.fontWeight = '700'; icon.style.color = st.color; }
      else icon.textContent = '📄';
    }
    row.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'wbs-name';
    name.textContent = node.name;
    name.title = node.path;
    row.appendChild(name);

    if (!isRoot) {
      const del = document.createElement('button');
      del.className = 'icon-btn danger wbs-del';
      del.title = '删除';
      del.textContent = '🗑';
      del.addEventListener('click', async (e) => {
        e.stopPropagation();
        const ok = await A.confirmDialog({
          title: node.isDir ? '删除目录' : '删除文件',
          message: '确定删除「' + node.name + '」吗？',
          danger: true,
          okText: '删除',
        });
        if (ok) removeNode(node);
      });
      row.appendChild(del);
    }

    /* 拖拽：local 源，供远端面板接收（DND 契约） */
    if (!isRoot) {
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData(WB.DND_MIME, JSON.stringify({ source: 'local', path: node.path, name: node.name, isDir: node.isDir }));
        e.dataTransfer.effectAllowed = 'copy';
      });
    }

    row.addEventListener('click', () => {
      if (node.isDir) {
        if (expanded.has(node.path)) expanded.delete(node.path); else expanded.add(node.path);
        renderExplorer();
      } else {
        WB.openTab({ id: 'editor:' + node.path, type: 'editor', title: node.name, data: { path: node.path, name: node.name } });
      }
    });
    return row;
  }

  function startInlineInput(isDir) {
    if (contentEl.querySelector('.wbs-inline-input')) return;
    const row = document.createElement('div');
    row.className = 'wbs-row';
    row.style.paddingLeft = (6 + 14) + 'px';
    const input = document.createElement('input');
    input.className = 'input wbs-inline-input';
    input.placeholder = isDir ? '目录名' : '文件名';
    input.spellcheck = false;
    let done = false;
    const finish = (commit) => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      row.remove();
      if (commit && name) addRootChild(name, isDir);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
    input.addEventListener('blur', () => finish(false));
    row.appendChild(input);
    const rootRow = contentEl.querySelector('.wbs-row');
    if (rootRow) rootRow.after(row); else contentEl.appendChild(row);
    input.focus();
  }

  function renderExplorer() {
    actionsEl.innerHTML = '';
    const newFile = document.createElement('button');
    newFile.className = 'icon-btn';
    newFile.title = '新建文件';
    newFile.textContent = '📄+';
    newFile.style.fontSize = '12px';
    newFile.onclick = () => startInlineInput(false);
    const newDir = document.createElement('button');
    newDir.className = 'icon-btn';
    newDir.title = '新建目录';
    newDir.textContent = '📁+';
    newDir.style.fontSize = '12px';
    newDir.onclick = () => startInlineInput(true);
    actionsEl.append(newFile, newDir);

    contentEl.innerHTML = '';
    const tree = document.createElement('div');
    tree.className = 'wbs-tree';
    (function appendNode(container, node, depth, isRoot) {
      container.appendChild(buildRow(node, depth, isRoot));
      if (node.isDir && expanded.has(node.path)) {
        (node.children || []).forEach((c) => appendNode(container, c, depth + 1, false));
      }
    })(tree, treeRoot, 0, true);
    contentEl.appendChild(tree);
  }

  /* ---------- 拖拽接收：remote 文件「下载」到项目根 ---------- */
  contentEl.addEventListener('dragover', (e) => {
    if (currentPanel !== 'explorer') return;
    if (!e.dataTransfer || !e.dataTransfer.types || !Array.from(e.dataTransfer.types).includes(WB.DND_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    contentEl.classList.add('wbs-drop');
  });
  contentEl.addEventListener('dragleave', (e) => {
    if (!contentEl.contains(e.relatedTarget)) contentEl.classList.remove('wbs-drop');
  });
  window.addEventListener('dragend', () => contentEl.classList.remove('wbs-drop'));
  contentEl.addEventListener('drop', (e) => {
    contentEl.classList.remove('wbs-drop');
    if (currentPanel !== 'explorer') return;
    let raw = '';
    try { raw = e.dataTransfer.getData(WB.DND_MIME); } catch (err) { return; }
    if (!raw) return;
    e.preventDefault();
    let data = null;
    try { data = JSON.parse(raw); } catch (err) { return; }
    if (data && data.source === 'remote') {
      A.toast('已复制 ' + data.name + ' 到本地 ' + treeRoot.path, 'success');
      addRootChild(data.name, !!data.isDir);
    }
  });

  /* ============================================================
     面板 2：服务器列表
     ============================================================ */
  /* 在线状态：模块加载时随机确定并保持 */
  const serverStatus = {};
  function getStatus(id) {
    if (!(id in serverStatus)) serverStatus[id] = Math.random() < 0.6 ? 'online' : 'offline';
    return serverStatus[id];
  }

  function renderServers() {
    actionsEl.innerHTML = '';
    const project = WB.state.project;
    const ids = (project && project.serverIds) || [];
    const servers = ids
      .map((id) => ((WB.state.db.servers || []).find((s) => s.id === id)))
      .filter(Boolean);

    contentEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wbs-content';
    if (!servers.length) {
      const es = document.createElement('div');
      es.className = 'empty-state';
      es.innerHTML = '<div class="icon">🖥️</div><div>该项目尚未绑定服务器</div><div style="font-size:11.5px">可前往「设置」为项目绑定远程服务器</div>';
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = '前往设置绑定';
      btn.onclick = () => (location.href = 'settings.html');
      es.appendChild(btn);
      wrap.appendChild(es);
      contentEl.appendChild(wrap);
      return;
    }
    servers.forEach((s) => {
      const online = getStatus(s.id) === 'online';
      const card = document.createElement('div');
      card.className = 'card wbs-server-card';
      card.innerHTML =
        '<div class="wbs-server-top">' +
          '<span class="wbs-server-name" title="' + esc(s.name) + '">' + esc(s.name) + '</span>' +
          '<span class="tag ' + (online ? 'green' : 'red') + '">' + (online ? '🟢 在线' : '🔴 离线') + '</span>' +
        '</div>' +
        '<div class="wbs-server-addr mono">' + esc(s.host) + ':' + esc(s.port) + '</div>' +
        (s.locked
          ? '<div class="wbs-ai-lock"><span class="tag red">🔒 AI 操作已锁定</span><span class="hint">AI 不能执行远程操作；手动 SSH/SFTP 不受影响</span></div>'
          : '') +
        '<div class="wbs-server-actions">' +
          '<button class="btn small primary wbs-ssh">SSH 连接</button>' +
          '<button class="btn small wbs-sftp">SFTP 文件管理</button>' +
        '</div>';
      card.querySelector('.wbs-ssh').onclick = () => {
        WB.openTab({ id: 'term:' + s.id, type: 'terminal', title: s.name, data: { kind: 'ssh', serverId: s.id } });
      };
      card.querySelector('.wbs-sftp').onclick = () => {
        WB.openTab({ id: 'sftp:' + s.id, type: 'sftp', title: s.name + ' SFTP', data: { serverId: s.id } });
      };
      wrap.appendChild(card);
    });
    contentEl.appendChild(wrap);
  }

  /* ============================================================
     面板 3：快捷指令
     ============================================================ */
  function runOnTerminal(action, cmd) {
    const api = WB.getActiveTerminalApi();
    if (!api) { A.toast('请先激活一个终端标签页'); return; }
    if (action === 'paste') api.paste(cmd); else api.execute(cmd);
  }

  function openQuickCommandModal(qc) {
    const isNew = !qc;
    /* 移除本模块残留的关闭中弹层（fade-out 期间仍挂在 DOM，避免输入被旧弹层截获） */
    document.querySelectorAll('.modal-mask').forEach((m) => {
      if (m.querySelector('.wbs-qc-title-input')) m.remove();
    });
    const mask = document.createElement('div');
    mask.className = 'modal-mask';
    mask.innerHTML =
      '<div class="modal" style="width:440px">' +
        '<div class="modal-head"><h3>' + (isNew ? '新增快捷指令' : '编辑快捷指令') + '</h3></div>' +
        '<div class="modal-body">' +
          '<div class="field"><label>标题 <span class="req">*</span></label>' +
            '<input class="input wbs-qc-title-input" placeholder="例如：查看 Git 状态"></div>' +
          '<div class="field"><label>命令 <span class="req">*</span></label>' +
            '<textarea class="textarea wbs-qc-cmd-input" rows="3" placeholder="例如：git status && git log --oneline -5"></textarea></div>' +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn wbs-cancel">取消</button>' +
          '<button class="btn primary wbs-save">保存</button>' +
        '</div>' +
      '</div>';
    const titleInput = mask.querySelector('.wbs-qc-title-input');
    const cmdInput = mask.querySelector('.wbs-qc-cmd-input');
    if (qc) { titleInput.value = qc.title; cmdInput.value = qc.command; }
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('open'));

    const close = () => { mask.classList.remove('open'); setTimeout(() => mask.remove(), 160); };
    const save = () => {
      const project = WB.state.project;
      const title = titleInput.value.trim();
      const command = cmdInput.value.trim();
      if (!title || !command) { A.toast('标题和命令不能为空'); return; }
      if (!project) { A.toast('当前没有可用项目'); return; }
      const qcs = project.quickCommands || (project.quickCommands = []);
      if (qc) { qc.title = title; qc.command = command; }
      else qcs.push({ id: A.uid('qc'), title, command });
      A.save(WB.state.db);
      WB.bus.emit('project-changed');
      close();
    };
    mask.querySelector('.wbs-cancel').onclick = close;
    mask.querySelector('.wbs-save').onclick = save;
    titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
    cmdInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); } });
    mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
    titleInput.focus();
    if (qc && titleInput.value) titleInput.select();
  }

  function renderCommands() {
    actionsEl.innerHTML = '';
    const addBtn = document.createElement('button');
    addBtn.className = 'btn small primary';
    addBtn.textContent = '+ 新增';
    addBtn.onclick = () => openQuickCommandModal(null);
    actionsEl.appendChild(addBtn);

    const project = WB.state.project;
    const qcs = (project && project.quickCommands) || [];
    contentEl.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.className = 'wbs-content';
    if (!qcs.length) {
      const es = document.createElement('div');
      es.className = 'empty-state';
      es.innerHTML = '<div class="icon">⚡</div><div>暂无快捷指令</div><div style="font-size:11.5px">点击「+ 新增」创建常用命令</div>';
      wrap.appendChild(es);
      contentEl.appendChild(wrap);
      return;
    }
    qcs.forEach((qc) => {
      const card = document.createElement('div');
      card.className = 'card wbs-qc-card';
      card.innerHTML =
        '<div class="wbs-qc-title ellipsis" title="' + esc(qc.title) + '">' + esc(qc.title) + '</div>' +
        '<div class="wbs-qc-cmd mono" title="' + esc(qc.command) + '">' + esc(qc.command) + '</div>' +
        '<div class="wbs-qc-actions">' +
          '<button class="btn small wbs-copy">复制到终端</button>' +
          '<button class="btn small wbs-run">立即执行</button>' +
          '<button class="btn small wbs-edit">编辑</button>' +
          '<button class="btn small danger wbs-del">删除</button>' +
        '</div>';
      card.querySelector('.wbs-copy').onclick = () => runOnTerminal('paste', qc.command);
      card.querySelector('.wbs-run').onclick = () => runOnTerminal('execute', qc.command);
      card.querySelector('.wbs-edit').onclick = () => openQuickCommandModal(qc);
      card.querySelector('.wbs-del').onclick = async () => {
        const ok = await A.confirmDialog({ title: '删除快捷指令', message: '确定删除「' + qc.title + '」吗？', danger: true, okText: '删除' });
        if (!ok) return;
        const idx = qcs.indexOf(qc);
        if (idx >= 0) qcs.splice(idx, 1);
        A.save(WB.state.db);
        WB.bus.emit('project-changed');
      };
      wrap.appendChild(card);
    });
    contentEl.appendChild(wrap);
  }

  /* ============================================================
     面板切换
     ============================================================ */
  function renderCurrent() {
    titleEl.textContent = PANELS[currentPanel];
    if (currentPanel === 'explorer') renderExplorer();
    else if (currentPanel === 'servers') renderServers();
    else renderCommands();
  }

  function setPanel(panel) {
    /* commands 准入：仅当活跃标签为终端 */
    if (panel === 'commands') {
      const tab = WB.getActiveTab();
      if (!tab || tab.type !== 'terminal') { A.toast('请先激活一个终端标签页'); return; }
    }
    currentPanel = panel;
    activityBar.querySelectorAll('.activity-icon').forEach((el) => {
      el.classList.toggle('active', el.dataset.panel === panel);
    });
    renderCurrent();
  }

  activityBar.addEventListener('click', (e) => {
    const icon = e.target.closest('.activity-icon');
    if (!icon || icon.dataset.panel === currentPanel) return;
    setPanel(icon.dataset.panel);
  });

  /* 正在显示 commands 时活跃标签变为非终端（或 null）→ 自动切回 explorer */
  WB.bus.on('tab-activated', (tab) => {
    if (currentPanel === 'commands' && (!tab || tab.type !== 'terminal')) setPanel('explorer');
  });

  /* 项目数据变化（本模块或其他模块修改后）→ 刷新当前面板 */
  WB.bus.on('project-changed', () => renderCurrent());

  /* ---------- 初始化：默认 explorer ---------- */
  renderCurrent();
})();
