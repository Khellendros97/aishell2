/* ============================================================
   工作台核心：状态、事件总线、标签页管理器、模块注册表
   本文件是所有工作台模块的协作契约，接口不得破坏。
   ============================================================ */
(function () {
  const params = new URLSearchParams(location.search);
  const db = AIShell.load();
  const project = db.projects.find((p) => p.id === params.get('project')) || db.projects[0] || null;

  /* ---------- 事件总线 ----------
     事件一览：
       'tab-activated'   (tab|null)      激活标签变化（关闭最后一个标签时发 null）
       'tab-closed'      (tab)
       'project-changed' ()              项目数据被某模块修改（各模块可据此刷新）
  */
  const listeners = {};
  const bus = {
    on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    emit(ev, ...args) { (listeners[ev] || []).forEach((cb) => cb(...args)); },
  };

  /* ---------- 渲染器注册表 ----------
     模块通过 registerRenderer(type, fn) 注册。
     fn(container, tab) 返回可选的 tabApi 对象（供其他模块调用）。 */
  const renderers = {};
  function registerRenderer(type, fn) { renderers[type] = fn; }

  /* ---------- 标签页管理器 ---------- */
  const tabBar = document.getElementById('tab-bar');
  const tabContent = document.getElementById('tab-content');
  const tabs = []; // {id, type, title, icon, data, el, pane, api, onClose}
  let activeId = null;

  const TYPE_ICONS = { editor: '📄', sftp: '🗂️', terminal: '⌨️' };

  function openTab({ id, type, title, data = {}, onClose = null, activate = true }) {
    const existing = tabs.find((t) => t.id === id);
    if (existing) { if (activate) activateTab(id); return existing; }
    if (!renderers[type]) { console.error('未注册的标签类型:', type); return null; }

    const tab = { id, type, title, icon: TYPE_ICONS[type] || '📄', data, onClose, api: null };
    tab.el = document.createElement('div');
    tab.el.className = 'wb-tab';
    tab.el.innerHTML = `<span class="tab-icon"></span><span class="tab-title"></span><button class="tab-close" title="关闭">✕</button>`;
    tab.el.querySelector('.tab-icon').textContent = tab.icon;
    tab.el.querySelector('.tab-title').textContent = title;
    tab.el.onclick = (e) => { if (!e.target.closest('.tab-close')) activateTab(id); };
    tab.el.querySelector('.tab-close').onclick = () => closeTab(id);
    tabBar.appendChild(tab.el);

    tab.pane = document.createElement('div');
    tab.pane.className = 'tab-pane';
    tab.pane.dataset.tabId = id;
    tabContent.appendChild(tab.pane);

    tab.api = renderers[type](tab.pane, tab) || null;
    tabs.push(tab);
    if (activate || tabs.length === 1) activateTab(id);
    return tab;
  }

  function setTabTitle(id, title) {
    const tab = tabs.find((t) => t.id === id);
    if (tab) { tab.title = title; tab.el.querySelector('.tab-title').textContent = title; }
  }

  function activateTab(id) {
    if (activeId === id) return;
    activeId = id;
    tabs.forEach((t) => {
      t.el.classList.toggle('active', t.id === id);
      t.pane.classList.toggle('active', t.id === id);
    });
    bus.emit('tab-activated', getActiveTab());
  }

  function closeTab(id) {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const [tab] = tabs.splice(idx, 1);
    if (tab.onClose) tab.onClose(tab);
    tab.el.remove(); tab.pane.remove();
    bus.emit('tab-closed', tab);
    if (activeId === id) {
      activeId = null;
      const next = tabs[Math.min(idx, tabs.length - 1)];
      if (next) activateTab(next.id); else bus.emit('tab-activated', null);
    }
  }

  function getActiveTab() { return tabs.find((t) => t.id === activeId) || null; }
  function getTabs() { return tabs.slice(); }

  /* ---------- 终端访问（供快捷指令 / AI 建议组件使用） ----------
     终端模块渲染时须返回 api = { paste(cmd), execute(cmd), takeSnapshot() } */
  function getActiveTerminalApi() {
    const active = getActiveTab();
    if (active && active.type === 'terminal' && active.api) return active.api;
    const anyTerm = [...tabs].reverse().find((t) => t.type === 'terminal' && t.api);
    return anyTerm ? anyTerm.api : null;
  }

  /* ---------- AI 面板句柄 ----------
     ai 模块初始化时设置 Workbench.ai = { addSnapshot(snap) } */
  const Workbench = {
    state: { project, db },
    bus,
    registerRenderer,
    openTab, closeTab, activateTab, setTabTitle, getActiveTab, getTabs,
    getActiveTerminalApi,
    ai: null,
    // 拖拽数据契约：dataTransfer 类型 'application/x-aishell'，
    // JSON: { source: 'local'|'remote', path: string, name: string, isDir: boolean }
    DND_MIME: 'application/x-aishell',
  };
  window.Workbench = Workbench;

  /* 所有模块脚本加载完毕后：默认打开一个本地终端标签 */
  window.addEventListener('load', () => {
    openTab({ id: 'term-local', type: 'terminal', title: '本地 Git Bash', data: { kind: 'local', label: 'gitbash' } });
  });
})();
