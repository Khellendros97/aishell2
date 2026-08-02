/* ============================================================
   AIShell 原型共享 Mock 数据 + 工具函数
   所有页面共用。数据写入 localStorage，键名 AISHELL_PROTO_DB。
   ============================================================ */
(function () {
  const DB_KEY = 'AISHELL_PROTO_DB';

  const seed = {
    settings: {
      workspaceDir: 'D:\\AIShellWorkspace',
      llm: { modelId: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-proto-demo-key-********', effort: 'medium' },
    },
    servers: [
      { id: 'srv-1', name: '生产-Web-01', host: '47.102.118.66', port: 22, authType: 'password', username: 'deploy', password: '••••••••', keyPath: '' },
      { id: 'srv-2', name: '测试-K8s-Node', host: '192.168.10.21', port: 2222, authType: 'key', username: 'ubuntu', password: '', keyPath: 'C:\\Users\\demo\\.ssh\\id_ed25519' },
      { id: 'srv-3', name: 'GPU训练机', host: '10.8.0.5', port: 22, authType: 'key', username: 'root', password: '', keyPath: 'C:\\Users\\demo\\.ssh\\gpu_key.pem' },
    ],
    projects: [
      {
        id: 'proj-1', name: 'AIShell 主仓库', path: 'D:\\projects\\AIShell2', serverIds: ['srv-1', 'srv-2'],
        quickCommands: [
          { id: 'qc-1', title: '查看 Git 状态', command: 'git status && git log --oneline -5' },
          { id: 'qc-2', title: '前端热更新', command: 'npm run dev -- --host 0.0.0.0' },
          { id: 'qc-3', title: '磁盘占用排查', command: 'du -sh ./* | sort -rh | head -20' },
        ],
      },
      { id: 'proj-2', name: '数据中台 ETL', path: '', serverIds: ['srv-2'], quickCommands: [{ id: 'qc-4', title: '重启 Airflow', command: 'systemctl restart airflow-webserver' }] },
      { id: 'proj-3', name: '个人博客', path: 'D:\\blog', serverIds: [], quickCommands: [] },
    ],
  };

  function load() {
    try {
      const raw = localStorage.getItem(DB_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* fallthrough */ }
    save(seed);
    return JSON.parse(JSON.stringify(seed));
  }
  function save(db) { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
  function reset() { localStorage.removeItem(DB_KEY); return load(); }
  function uid(prefix) { return prefix + '-' + Math.random().toString(36).slice(2, 8); }

  /* ---------- Toast ---------- */
  function toast(msg, type) {
    let root = document.getElementById('toast-root');
    if (!root) { root = document.createElement('div'); root.id = 'toast-root'; document.body.appendChild(root); }
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    root.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .2s'; setTimeout(() => el.remove(), 220); }, 2200);
  }

  /* ---------- 通用确认弹窗 ----------
     confirmDialog({title, message, danger, okText}) -> Promise<boolean> */
  function confirmDialog({ title = '确认操作', message = '', danger = false, okText = '确定' } = {}) {
    return new Promise((resolve) => {
      const mask = document.createElement('div');
      mask.className = 'modal-mask';
      mask.innerHTML = `
        <div class="modal" style="width:400px">
          <div class="modal-head"><h3></h3></div>
          <div class="modal-body" style="color:var(--text-1);line-height:1.6"></div>
          <div class="modal-foot">
            <button class="btn" data-act="cancel">取消</button>
            <button class="btn ${danger ? 'danger-solid' : 'primary'}" data-act="ok"></button>
          </div>
        </div>`;
      mask.querySelector('h3').textContent = title;
      mask.querySelector('.modal-body').textContent = message;
      mask.querySelector('[data-act=ok]').textContent = okText;
      document.body.appendChild(mask);
      requestAnimationFrame(() => mask.classList.add('open'));
      const close = (val) => { mask.classList.remove('open'); setTimeout(() => mask.remove(), 160); resolve(val); };
      mask.querySelector('[data-act=cancel]').onclick = () => close(false);
      mask.querySelector('[data-act=ok]').onclick = () => close(true);
      mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(false); });
    });
  }

  /* 顶栏：brand + 可选右侧插槽。page: 'welcome' | 'settings' | 'workbench' */
  function renderTopbar(activePage) {
    const bar = document.createElement('div');
    bar.className = 'page-topbar';
    bar.innerHTML = `
      <div class="brand"><span class="logo">⌁</span><span>AIShell</span><span class="tag">Prototype</span></div>
      <div class="spacer"></div>
      <button class="btn ghost small" data-nav="welcome">项目</button>
      <button class="btn ghost small" data-nav="settings">设置</button>`;
    bar.querySelector('[data-nav=welcome]').onclick = () => (location.href = 'welcome.html');
    bar.querySelector('[data-nav=settings]').onclick = () => (location.href = 'settings.html');
    if (activePage) {
      const btn = bar.querySelector(`[data-nav=${activePage}]`);
      if (btn) { btn.classList.remove('ghost'); }
    }
    document.body.prepend(bar);
    return bar;
  }

  window.AIShell = { load, save, reset, uid, toast, confirmDialog, renderTopbar };
})();
