/**
 * 欢迎页 —— 移植自 .proto/welcome.js + welcome.html。
 * 差异：数据源为 Tauri 后端（get_state / upsert_project / delete_project / upsert_server）；
 * 「重置演示数据」按钮改为「打开配置目录」（openPath(getConfigDir())）；
 * 新建项目先 ensureProjectDirs 拿最终路径，再 upsertProject 落盘；
 * 浏览按钮走 @tauri-apps/plugin-dialog；卡片点击经 router.navigate 进入工作台。
 */
import type { AppState, Project, Server } from '../types';
import {
  deleteProject, ensureProjectDirs, getConfigDir, getState, openDialog, upsertProject, upsertServer,
} from '../api';
import { confirmDialog, toast, uid } from '../ui';
import { icon } from '../icons';
import { openPath } from '@tauri-apps/plugin-opener';
import { navigate } from '../router';
import type { PageRender } from '../main';
import './welcome.css';

const welcomeLogoUrl = new URL('../assets/logo.svg', import.meta.url).href;

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

export const renderWelcome: PageRender = (root) => {
  root.classList.add('welcome-page');

  /* ---------- 页面骨架（同 .proto/welcome.html） ---------- */
  root.insertAdjacentHTML('beforeend', `
    <main>
      <img class="welcome-logo-watermark" src="${welcomeLogoUrl}" alt="" aria-hidden="true">
      <div class="page-head">
        <h2>我的项目</h2>
        <span class="tag" id="proj-count">0 个项目</span>
        <div class="spacer"></div>
        <button class="btn ghost small" id="btn-reset" title="打开应用配置目录">打开配置目录</button>
        <button class="btn primary" id="btn-new">${icon('plus')} 新建项目</button>
      </div>

      <div class="proj-grid" id="proj-grid"></div>

      <div class="empty-state hidden" id="empty-state">
        <div class="icon">${icon('folder')}</div>
        <div>还没有项目，创建一个项目开始使用 AIShell</div>
        <button class="btn primary" id="btn-empty-new">新建项目</button>
      </div>
    </main>

    <!-- 新建 / 编辑项目模态框 -->
    <div class="modal-mask" id="proj-modal">
      <div class="modal">
        <div class="modal-head">
          <h3 id="modal-title">新建项目</h3>
          <button class="icon-btn" id="modal-close" title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div class="field">
            <label>项目名称<span class="req">*</span></label>
            <input class="input" id="f-name" placeholder="例如：数据中台 ETL">
            <div class="error hidden" id="f-name-err">请输入项目名称</div>
          </div>
          <div class="field">
            <label>项目路径</label>
            <div class="path-row">
              <input class="input" id="f-path" placeholder="例如：D:\\projects\\my-app">
              <button class="btn" id="btn-browse">浏览…</button>
            </div>
            <div class="hint">选择目录后将在其下创建 .aishell 工作目录；留空则在全局 workspace 目录中新建项目目录。</div>
          </div>
          <div class="field">
            <label>绑定远程服务器（可多选）</label>
            <div class="server-list" id="server-list"></div>
            <div class="server-add" id="server-add-toggle">${icon('plus')} 新建服务器连接</div>
            <div class="server-mini hidden" id="server-mini">
              <div class="mini-grid">
                <div class="field">
                  <label>名称<span class="req">*</span></label>
                  <input class="input" id="mini-name" placeholder="例如：测试服务器">
                </div>
                <div class="field">
                  <label>IP 地址<span class="req">*</span></label>
                  <input class="input" id="mini-host" placeholder="例如：192.168.1.10">
                </div>
                <div class="field">
                  <label>端口<span class="req">*</span></label>
                  <input class="input mono" id="mini-port" type="number" min="1" max="65535" value="22">
                </div>
                <div class="field">
                  <label>认证方式</label>
                  <select class="select" id="mini-auth">
                    <option value="password">密码</option>
                    <option value="key">密钥</option>
                  </select>
                </div>
                <div class="field">
                  <label>账号</label>
                  <input class="input" id="mini-user" placeholder="例如：root">
                </div>
                <div class="field">
                  <label id="mini-secret-label">密码</label>
                  <input class="input" id="mini-secret" placeholder="输入服务器密码">
                </div>
              </div>
              <div class="error hidden" id="mini-err"></div>
              <div class="mini-actions">
                <button class="btn" id="mini-cancel">收起</button>
                <button class="btn primary" id="mini-save">保存</button>
              </div>
            </div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="btn-cancel">取消</button>
          <button class="btn primary" id="btn-save">保存</button>
        </div>
      </div>
    </div>
  `);

  /* ---------- 元素引用 ---------- */
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
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
    fName: $<HTMLInputElement>('f-name'),
    fNameErr: $('f-name-err'),
    fPath: $<HTMLInputElement>('f-path'),
    btnBrowse: $('btn-browse'),
    serverList: $('server-list'),
    addToggle: $('server-add-toggle'),
    mini: $('server-mini'),
    miniName: $<HTMLInputElement>('mini-name'),
    miniHost: $<HTMLInputElement>('mini-host'),
    miniPort: $<HTMLInputElement>('mini-port'),
    miniAuth: $<HTMLSelectElement>('mini-auth'),
    miniUser: $<HTMLInputElement>('mini-user'),
    miniSecret: $<HTMLInputElement>('mini-secret'),
    miniSecretLabel: $('mini-secret-label'),
    miniErr: $('mini-err'),
    miniSave: $('mini-save'),
    miniCancel: $('mini-cancel'),
  };

  /* ---------- 状态 ---------- */
  let db: AppState = {
    settings: { workspaceDir: null, llm: { modelId: '', baseUrl: '', effort: 'low' }, search: { enabled: false }, theme: 'dark' },
    servers: [], projects: [], sessions: {},
  };
  let editingId: string | null = null;       // null = 新建；否则为正在编辑的项目 id
  let selectedServerIds: string[] = [];      // 模态框中多选的服务器 id

  /* ---------- 项目列表渲染 ---------- */
  function renderProjects() {
    const projects = db.projects || [];
    els.count.textContent = `${projects.length} 个项目`;
    els.grid.innerHTML = '';

    projects.forEach((p) => {
      const hasPath = !!p.path;
      const wsDir = db.settings.workspaceDir || '';
      const displayPath = hasPath && p.path ? p.path : `${wsDir}\\${p.name}`;
      const servers = (p.serverIds || [])
        .map((id) => db.servers.find((s) => s.id === id))
        .filter((s): s is Server => !!s);
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
            <button class="icon-btn" data-act="edit" title="编辑项目">${icon('gear')}</button>
            <button class="icon-btn danger" data-act="delete" title="删除项目">${icon('trash')}</button>
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
    const card = (e.target as HTMLElement).closest<HTMLElement>('.project-card');
    if (!card) return;
    const projId = card.dataset.id;
    if (!projId) return;
    const actBtn = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (actBtn) {
      if (actBtn.dataset.act === 'edit') openModal('edit', projId);
      else if (actBtn.dataset.act === 'delete') void deleteProjectFlow(projId);
      return;
    }
    navigate('#/workbench?project=' + projId);
  });

  /* ---------- 删除项目 ---------- */
  async function deleteProjectFlow(id: string) {
    const proj = db.projects.find((p) => p.id === id);
    if (!proj) return;
    const ok = await confirmDialog({
      title: '删除项目',
      message: `确定要删除项目「${proj.name}」吗？仅删除项目记录，不会删除磁盘文件。`,
      danger: true,
      okText: '删除',
    });
    if (!ok) return;
    try {
      await deleteProject(id);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    db.projects = db.projects.filter((p) => p.id !== id);
    renderProjects();
    toast('项目已删除', 'success');
  }

  /* ---------- 新建 / 编辑模态框 ---------- */
  function openModal(mode: 'new' | 'edit', id?: string) {
    editingId = mode === 'edit' ? (id ?? null) : null;
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
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && els.modal.classList.contains('open')) closeModal();
  };
  document.addEventListener('keydown', onKeydown);

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

  /* 目录浏览…：真实目录选择 */
  els.btnBrowse.onclick = async () => {
    const path = await openDialog({ directory: true });
    if (path) els.fPath.value = path;
  };

  /* Enter 快捷保存 */
  [els.fName, els.fPath].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void saveProject();
    });
  });

  /* 保存项目 */
  async function saveProject() {
    const name = els.fName.value.trim();
    if (!name) {
      showNameError();
      return;
    }
    const pathInput = els.fPath.value.trim();
    const serverIds = selectedServerIds.slice();

    if (editingId) {
      const proj = db.projects.find((p) => p.id === editingId);
      if (!proj) return;
      const updated: Project = { ...proj, name, path: pathInput || null, serverIds };
      try {
        await upsertProject(updated);
      } catch (err) {
        toast(String(err), 'error');
        return;
      }
      Object.assign(proj, updated);
      closeModal();
      renderProjects();
      toast('已保存', 'success');
    } else {
      let finalPath: string;
      let proj: Project;
      try {
        finalPath = await ensureProjectDirs(pathInput || null, name);
        proj = {
          id: uid('proj'),
          name,
          path: finalPath,
          serverIds,
          quickCommands: [],
          // 新项目默认建议模式（不扩大权限；模式按项目持久化）
          aiMode: 'suggest',
        };
        await upsertProject(proj);
      } catch (err) {
        toast(String(err), 'error');
        return;
      }
      db.projects.push(proj);
      closeModal();
      renderProjects();
      toast('项目已创建', 'success');
    }
  }
  els.btnSave.onclick = () => void saveProject();

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
    const card = (e.target as HTMLElement).closest<HTMLElement>('.server-card');
    if (!card) return;
    const id = card.dataset.id;
    if (!id) return;
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

  async function saveMiniServer() {
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

    const auth = els.miniAuth.value as Server['authType'];
    const secret = els.miniSecret.value.trim();
    const srv: Server = {
      id: uid('srv'),
      name,
      host,
      port,
      authType: auth,
      username: els.miniUser.value.trim(),
      keyPath: auth === 'key' ? secret : '',
      locked: false,
    };

    try {
      await upsertServer(srv, auth === 'password' ? (secret || null) : null);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    db.servers.push(srv);
    selectedServerIds.push(srv.id);
    renderServerList();
    collapseMini();
    resetMini();
    toast('服务器已创建并自动选中', 'success');
  }
  els.miniSave.onclick = () => void saveMiniServer();

  /* ---------- 打开配置目录（原型「重置演示数据」的替代） ---------- */
  els.btnReset.onclick = async () => {
    try {
      await openPath(await getConfigDir());
    } catch {
      toast('无法打开配置目录', 'error');
    }
  };

  /* ---------- 初始渲染 ---------- */
  void getState()
    .then((s) => {
      db = s;
      renderProjects();
    })
    .catch((err) => toast(String(err), 'error'));

  return () => {
    document.removeEventListener('keydown', onKeydown);
  };
};
