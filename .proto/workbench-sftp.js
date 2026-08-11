/* ============================================================
   workbench-sftp.js — 注册 'sftp' 标签类型：模拟远程文件系统
   - 每个 tab 独立维护 cwd / history / forward 栈
   - 顶栏：后退 ◀ 前进 ▶ 上级 ↑ home 🏠 根 / + 面包屑 + 视图切换
   - 平铺/列表双视图；双击目录进入、双击文件提示；条目可拖拽
   - 支持 local -> remote 拖放上传（Workbench.DND_MIME）
   依赖 workbench-core.js 提供的 Workbench API，不污染全局。
   ============================================================ */
(function () {
  'use strict';
  const WB = window.Workbench;
  if (!WB || typeof WB.registerRenderer !== 'function') return;
  const { registerRenderer, bus } = WB;
  const toast = (msg, type) => { if (window.AIShell) AIShell.toast(msg, type); };

  /* ---------- 模块样式（只增不改 shared） ---------- */
  if (!document.getElementById('sf-style')) {
    const st = document.createElement('style');
    st.id = 'sf-style';
    st.textContent = [
      '.sf-root{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;background:var(--bg-0);}',
      '.sf-toolbar{flex:none;display:flex;align-items:center;gap:2px;padding:6px 10px;border-bottom:1px solid var(--border);background:var(--bg-1);}',
      '.sf-view.active{color:var(--accent);background:var(--bg-hover);}',
      '.sf-crumb{display:flex;align-items:center;gap:2px;flex:1 1 auto;min-width:0;margin:0 8px;overflow-x:auto;white-space:nowrap;}',
      '.sf-crumb-item{border:none;background:none;color:var(--text-1);font-size:12.5px;padding:2px 6px;border-radius:4px;cursor:pointer;font-family:var(--font-ui);}',
      '.sf-crumb-item:hover{background:var(--bg-hover);color:var(--text-0);}',
      '.sf-crumb-item.cur{color:var(--text-0);font-weight:600;cursor:default;}',
      '.sf-crumb-sep{color:var(--text-2);flex:none;user-select:none;}',
      '.sf-body{flex:1 1 auto;min-height:0;overflow:auto;padding:12px;}',
      '.sf-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:4px;}',
      '.sf-item{display:flex;flex-direction:column;align-items:center;gap:6px;padding:12px 4px;border-radius:var(--radius-m);border:1px solid transparent;cursor:pointer;user-select:none;text-align:center;}',
      '.sf-item:hover{background:var(--bg-hover);border-color:var(--border);}',
      '.sf-item.sel{background:var(--bg-active);}',
      '.sf-item .sf-icon{font-size:30px;line-height:1;}',
      '.sf-item .sf-name{font-size:12px;color:var(--text-1);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sf-table{width:100%;border-collapse:collapse;font-size:12.5px;}',
      '.sf-table th{text-align:left;color:var(--text-2);font-weight:500;font-size:11px;padding:4px 10px;border-bottom:1px solid var(--border-strong);}',
      '.sf-table td{padding:4px 10px;border-bottom:1px solid var(--border);}',
      '.sf-table tr{cursor:pointer;}',
      '.sf-table tr:hover td{background:var(--bg-hover);}',
      '.sf-table .sf-t-name{display:flex;align-items:center;gap:8px;color:var(--text-0);min-width:0;}',
      '.sf-table .sf-t-name .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sf-table .sf-t-size{color:var(--text-2);font-family:var(--font-mono);text-align:right;white-space:nowrap;}',
      '.sf-table .sf-t-time{color:var(--text-2);white-space:nowrap;}',
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ================= 模拟远程文件系统 ================= */
  function ts(daysAgo, hh, mm) {
    const t = new Date();
    t.setDate(t.getDate() - daysAgo);
    t.setHours(hh, mm, 0, 0);
    return t.toISOString();
  }
  const f = (size, mtime) => ({ type: 'file', size: size, mtime: mtime });
  const d = (mtime, children) => ({ type: 'dir', mtime: mtime, children: children || {} });

  const remoteFS = d(ts(0, 0, 0), {
    home: d(ts(0, 8, 0), {
      deploy: d(ts(0, 8, 5), {
        apps: d(ts(0, 8, 10), {
          web: d(ts(1, 10, 24), {
            'package.json': f(1842, ts(1, 10, 20)),
            'server.js': f(4210, ts(1, 10, 24)),
            'index.html': f(3278, ts(2, 15, 41)),
            'nginx.conf': f(953, ts(3, 9, 12)),
            '使用说明.md': f(640, ts(4, 11, 30)),
          }),
          api: d(ts(1, 9, 15), {
            'app.py': f(5612, ts(1, 9, 15)),
            'requirements.txt': f(214, ts(1, 9, 2)),
            'config.yaml': f(1086, ts(1, 8, 47)),
          }),
          'batch-job.py': f(2031, ts(2, 2, 0)),
        }),
        logs: d(ts(0, 6, 0), {
          'access.log': f(12582912, ts(0, 5, 59)),
          'error.log': f(34816, ts(0, 6, 0)),
        }),
        backup: d(ts(5, 3, 0), {
          'backup-2026-07-28.tar.gz': f(268435456, ts(5, 3, 0)),
          'db-dump-2026-07-30.sql': f(5242880, ts(3, 22, 17)),
        }),
        'deploy.sh': f(1216, ts(0, 8, 5)),
        'README.md': f(1533, ts(6, 14, 22)),
        '.env.example': f(392, ts(6, 14, 20)),
        'Dockerfile': f(874, ts(6, 14, 19)),
      }),
    }),
  });

  function getNode(path) {
    if (path === '/') return remoteFS;
    let node = remoteFS;
    for (const seg of path.split('/').filter(Boolean)) {
      if (!node.children || !node.children[seg]) return null;
      node = node.children[seg];
    }
    return node;
  }
  function listChildren(path) {
    const node = getNode(path);
    const items = [];
    if (node && node.children) {
      for (const name of Object.keys(node.children)) {
        const child = node.children[name];
        items.push({
          name: name,
          path: (path === '/' ? '' : path) + '/' + name,
          isDir: child.type === 'dir',
          node: child,
        });
      }
    }
    items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return items;
  }
  function parentOf(path) {
    if (path === '/') return '/';
    const idx = path.lastIndexOf('/');
    return idx <= 0 ? '/' : path.slice(0, idx);
  }
  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }
  function fmtTime(iso) {
    const dt = new Date(iso);
    const p = (v) => String(v).padStart(2, '0');
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) + ' ' + p(dt.getHours()) + ':' + p(dt.getMinutes());
  }

  /* ================= 视图状态（模块级）与标签页状态 ================= */
  let viewMode = 'grid'; // 'grid' | 'list'
  const sftpTabs = new Map(); // tabId -> { cwd, back, fwd, els }

  function setViewMode(mode) {
    if (viewMode === mode) return;
    viewMode = mode;
    sftpTabs.forEach((st) => renderView(st));
  }

  function goTo(st, path, push) {
    if (path === st.cwd) return;
    if (push) { st.back.push(st.cwd); st.fwd.length = 0; }
    st.cwd = path;
    renderView(st);
  }
  function goBack(st) {
    if (!st.back.length) return;
    st.fwd.push(st.cwd);
    st.cwd = st.back.pop();
    renderView(st);
  }
  function goForward(st) {
    if (!st.fwd.length) return;
    st.back.push(st.cwd);
    st.cwd = st.fwd.pop();
    renderView(st);
  }

  /* ================= 拖拽 ================= */
  function bindDrag(el, it) {
    el.draggable = true;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(WB.DND_MIME, JSON.stringify({
        source: 'remote', path: it.path, name: it.name, isDir: it.isDir,
      }));
      e.dataTransfer.effectAllowed = 'copy';
    });
  }
  function bindDrop(root, st) {
    root.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, WB.DND_MIME) >= 0) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }
    });
    root.addEventListener('drop', (e) => {
      e.preventDefault();
      const raw = e.dataTransfer.getData(WB.DND_MIME);
      if (!raw) return;
      let payload = null;
      try { payload = JSON.parse(raw); } catch (err) { return; }
      if (!payload || payload.source !== 'local' || !payload.name) return;
      const name = String(payload.name).replace(/[\\/]/g, '_');
      const dirNode = getNode(st.cwd);
      if (!dirNode || !dirNode.children) return;
      // 重名加后缀
      let final = name;
      let i = 1;
      while (dirNode.children[final]) {
        const dot = name.lastIndexOf('.');
        final = (dot > 0 ? name.slice(0, dot) + ' (' + i + ')' + name.slice(dot) : name + ' (' + i + ')');
        i++;
      }
      dirNode.children[final] = payload.isDir
        ? { type: 'dir', mtime: new Date().toISOString(), children: {} }
        : { type: 'file', size: 0, mtime: new Date().toISOString() };
      toast('已上传 ' + payload.name + ' 到远程目录', 'success');
      renderView(st);
    });
  }

  /* ================= 视图渲染 ================= */
  function buildCrumbs(cwd) {
    const crumbs = [{ label: '/', path: '/' }];
    if (cwd !== '/') {
      let acc = '';
      for (const seg of cwd.split('/').filter(Boolean)) {
        acc = acc ? acc + '/' + seg : '/' + seg;
        crumbs.push({ label: seg, path: acc });
      }
    }
    return crumbs;
  }

  function buildToolbar(st) {
    const bar = document.createElement('div');
    bar.className = 'sf-toolbar';
    const mk = (cls, text, title, fn) => {
      const b = document.createElement('button');
      b.className = 'icon-btn ' + cls;
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', fn);
      return b;
    };
    st.els.backBtn = mk('', '◀', '后退', () => goBack(st));
    st.els.fwdBtn = mk('', '▶', '前进', () => goForward(st));
    st.els.upBtn = mk('', '↑', '上一级', () => goTo(st, parentOf(st.cwd), true));
    st.els.homeBtn = mk('', '🏠', '回到 /home/deploy', () => goTo(st, '/home/deploy', true));
    st.els.rootBtn = mk('', '/', '根目录 /', () => goTo(st, '/', true));
    st.els.crumbs = document.createElement('div');
    st.els.crumbs.className = 'sf-crumb';
    st.els.gridBtn = mk('sf-view', '⊞', '平铺视图', () => setViewMode('grid'));
    st.els.listBtn = mk('sf-view', '☰', '列表视图', () => setViewMode('list'));
    bar.appendChild(st.els.backBtn);
    bar.appendChild(st.els.fwdBtn);
    bar.appendChild(st.els.upBtn);
    bar.appendChild(st.els.homeBtn);
    bar.appendChild(st.els.rootBtn);
    bar.appendChild(st.els.crumbs);
    bar.appendChild(st.els.gridBtn);
    bar.appendChild(st.els.listBtn);
    return bar;
  }

  function buildGrid(body, st, entries) {
    const grid = document.createElement('div');
    grid.className = 'sf-grid';
    entries.forEach((it) => {
      const el = document.createElement('div');
      el.className = 'sf-item';
      el.title = it.path + (it.isDir ? '' : ' · ' + fmtSize(it.node.size) + ' · ' + fmtTime(it.node.mtime));
      const icon = document.createElement('div');
      icon.className = 'sf-icon';
      icon.textContent = it.isDir ? '📁' : '📄';
      const name = document.createElement('div');
      name.className = 'sf-name';
      name.textContent = it.name;
      el.appendChild(icon);
      el.appendChild(name);
      el.addEventListener('click', () => {
        grid.querySelectorAll('.sf-item').forEach((x) => x.classList.remove('sel'));
        el.classList.add('sel');
        if (it.isDir) goTo(st, it.path, true);
      });
      el.addEventListener('dblclick', () => {
        if (!it.isDir) toast('原型暂不支持远程编辑');
      });
      bindDrag(el, it);
      grid.appendChild(el);
    });
    body.appendChild(grid);
  }

  function buildTable(body, st, entries) {
    const table = document.createElement('table');
    table.className = 'sf-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    [['名称'], ['大小', 'right'], ['修改时间']].forEach(([label, align]) => {
      const th = document.createElement('th');
      th.textContent = label;
      if (align === 'right') th.style.textAlign = 'right';
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    const tbody = document.createElement('tbody');
    entries.forEach((it) => {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      const span = document.createElement('span');
      span.className = 'sf-t-name';
      const ic = document.createElement('span');
      ic.textContent = it.isDir ? '📁' : '📄';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = it.name;
      span.appendChild(ic);
      span.appendChild(nm);
      tdName.appendChild(span);
      const tdSize = document.createElement('td');
      tdSize.className = 'sf-t-size';
      tdSize.textContent = it.isDir ? '—' : fmtSize(it.node.size);
      const tdTime = document.createElement('td');
      tdTime.className = 'sf-t-time';
      tdTime.textContent = fmtTime(it.node.mtime);
      tr.appendChild(tdName);
      tr.appendChild(tdSize);
      tr.appendChild(tdTime);
      tr.title = it.path;
      tr.addEventListener('click', () => { if (it.isDir) goTo(st, it.path, true); });
      tr.addEventListener('dblclick', () => { if (!it.isDir) toast('原型暂不支持远程编辑'); });
      bindDrag(tr, it);
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    body.appendChild(table);
  }

  function renderView(st) {
    const entries = listChildren(st.cwd);

    st.els.backBtn.disabled = st.back.length === 0;
    st.els.fwdBtn.disabled = st.fwd.length === 0;
    st.els.upBtn.disabled = st.cwd === '/';
    st.els.gridBtn.classList.toggle('active', viewMode === 'grid');
    st.els.listBtn.classList.toggle('active', viewMode === 'list');

    const crumbs = buildCrumbs(st.cwd);
    const crumbBox = st.els.crumbs;
    crumbBox.textContent = '';
    crumbs.forEach((c, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'sf-crumb-sep';
        sep.textContent = '/';
        crumbBox.appendChild(sep);
      }
      const btn = document.createElement('button');
      btn.className = 'sf-crumb-item' + (i === crumbs.length - 1 ? ' cur' : '');
      btn.textContent = c.label;
      if (i < crumbs.length - 1) btn.addEventListener('click', () => goTo(st, c.path, true));
      crumbBox.appendChild(btn);
    });

    const body = st.els.body;
    body.textContent = '';
    if (!entries.length) {
      const es = document.createElement('div');
      es.className = 'empty-state';
      const ic = document.createElement('div');
      ic.className = 'icon';
      ic.textContent = '📂';
      const tx = document.createElement('div');
      tx.textContent = '目录为空';
      es.appendChild(ic);
      es.appendChild(tx);
      body.appendChild(es);
      return;
    }
    if (viewMode === 'grid') buildGrid(body, st, entries);
    else buildTable(body, st, entries);
  }

  /* ================= 渲染器注册 ================= */
  registerRenderer('sftp', (container, tab) => {
    const st = { cwd: '/home/deploy', back: [], fwd: [], els: {} };
    sftpTabs.set(tab.id, st);

    const root = document.createElement('div');
    root.className = 'sf-root';
    root.appendChild(buildToolbar(st));

    const body = document.createElement('div');
    body.className = 'sf-body';
    st.els.body = body;
    root.appendChild(body);

    container.appendChild(root);
    bindDrop(root, st);
    renderView(st);

    return {
      getCwd: () => st.cwd,
      refresh: () => renderView(st),
      navigate: (p) => goTo(st, p, true),
    };
  });

  bus.on('tab-closed', (tab) => { sftpTabs.delete(tab.id); });
})();
