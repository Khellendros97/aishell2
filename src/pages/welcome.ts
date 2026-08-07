/**
 * 欢迎页 —— 移植自 .proto/welcome.js + welcome.html。
 * 差异：数据源为 Tauri 后端（get_state / upsert_project / delete_project / upsert_server）；
 * 新建项目先 ensureProjectDirs 拿最终路径，再 upsertProject 落盘；
 * 浏览按钮走 @tauri-apps/plugin-dialog；卡片点击经 router.navigate 进入工作台。
 * 新增（非原型）：项目对话框的服务器勾选列表支持按 名称/host/账号/目录 搜索（folder 与 store.rs Server 对齐）；
 * 按 folder 分组折叠展示（默认折叠，组标题含组全选复选框，可全部展开/折叠）。
 */
import type { AppState, Project, Server } from '../types';
import {
  deleteProject, ensureProjectDirs, getState, openDialog, upsertProject, upsertServer,
} from '../api';
import { confirmDialog, toast, uid } from '../ui';
import { icon } from '../icons';
import { navigate } from '../router';
import type { PageRender } from '../main';
import { createServerForm } from './server-form';
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
            <div class="server-search-row">
              <input class="input" id="server-search" placeholder="搜索服务器…">
              <button class="icon-btn" id="server-toggle-folders" title="全部展开">${icon('folderOpen')}</button>
            </div>
            <div class="server-list" id="server-list"></div>
            <div class="server-add" id="server-add-toggle">${icon('plus')} 新建服务器连接</div>
            <div class="server-mini hidden" id="server-mini">
              <!-- 服务器表单字段（双列紧凑布局）由 server-form.ts 渲染，与侧栏编辑表单同源 -->
              <div id="mini-form"></div>
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
    serverSearch: $<HTMLInputElement>('server-search'),
    serverToggleFolders: $('server-toggle-folders'),
    addToggle: $('server-add-toggle'),
    mini: $('server-mini'),
    miniForm: $('mini-form'),
    miniErr: $('mini-err'),
    miniSave: $('mini-save'),
    miniCancel: $('mini-cancel'),
  };

  /* ---------- 状态 ---------- */
  let db: AppState = {
    settings: { workspaceDir: null, llm: { modelId: '', baseUrl: '', effort: 'low' }, search: { enabled: false }, theme: 'dark', autoSwitchAiWorkdir: false },
    servers: [], projects: [], sessions: {}, serverFolders: [], commandFolders: [],
  };
  let editingId: string | null = null;       // null = 新建；否则为正在编辑的项目 id
  let selectedServerIds: string[] = [];      // 模态框中多选的服务器 id
  const expandedGroups = new Set<string>();  // 展开的分组（键 = folder 值，空串 = 未分类）；默认全部折叠，跨重渲染保留

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
      // 服务器标签最多显示 5 个：超过 5 台时显示前 4 个 + 「+剩余数量」标签，避免卡片被撑大
      const tagLimit = 5;
      const shownServers = servers.length > tagLimit ? servers.slice(0, tagLimit - 1) : servers;
      const hiddenCount = servers.length - shownServers.length;
      const serverTags = servers.length
        ? shownServers.map((s) => `<span class="tag blue">${esc(s.name)}</span>`).join('')
          + (hiddenCount > 0 ? `<span class="tag">+${hiddenCount}</span>` : '')
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

  /* ---------- 服务器多选列表（按 folder 分组折叠；组全选） ---------- */
  function renderServerList() {
    const all = db.servers || [];
    if (!all.length) {
      els.serverList.innerHTML = '<div class="server-empty">暂无服务器，可在下方新建</div>';
      return;
    }
    // 搜索过滤：名称 / host / username / folder 大小写不敏感；空串显示全部
    const q = els.serverSearch.value.trim().toLowerCase();
    const filtered = q
      ? all.filter((s) => [s.name, s.host, s.username, s.folder].some((v) => v.toLowerCase().includes(q)))
      : all;
    if (!filtered.length) {
      els.serverList.innerHTML = '<div class="server-empty">没有匹配的服务器，试试其他关键词</div>';
      return;
    }
    // 按 folder 分组（未分类 = 空串，排最后）；搜索态组内过滤，无命中组不渲染。
    // 组全选作用于该分类全部服务器（不受搜索过滤影响）：勾选态按 db.servers 全量计算。
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
    els.serverList.innerHTML = keys.map((folderKey) => {
      const groupServers = groups.get(folderKey)!;
      const expanded = expandedGroups.has(folderKey);
      const cards = groupServers.map((s) => {
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
      return `
        <div class="server-group-title" data-folder="${esc(folderKey)}">
          <span class="sgt-folder">${icon(expanded ? 'folderOpen' : 'folder')}</span>
          <span class="sgt-name" title="${esc(folderKey || '未分类')}">${esc(folderKey || '未分类')}</span>
          <span class="tag">${groupServers.length}</span>
          <input type="checkbox" class="sgt-check" data-folder="${esc(folderKey)}" title="全选 / 取消全选该分类">
        </div>
        <div class="server-group-body${expanded ? '' : ' hidden'}">${cards}</div>`;
    }).join('');
    // 组全选勾选态：按该分类全部服务器（非搜索过滤结果）计算 checked / indeterminate
    els.serverList.querySelectorAll<HTMLInputElement>('.sgt-check').forEach((check) => {
      const folder = check.dataset.folder ?? '';
      const groupAll = all.filter((s) => (s.folder || '') === folder);
      const sel = groupAll.filter((s) => selectedServerIds.includes(s.id)).length;
      check.checked = sel === groupAll.length;
      check.indeterminate = sel > 0 && sel < groupAll.length;
    });
    syncToggleFoldersBtn();
  }

  // 全部展开 / 全部折叠：单按钮按当前状态切换（图标 = 目标动作），作用于全部服务器的分类（含被搜索过滤掉的组）
  const allFolderKeys = () => Array.from(new Set((db.servers || []).map((s) => s.folder || '')));
  const syncToggleFoldersBtn = () => {
    const keys = allFolderKeys();
    const allExpanded = keys.length > 0 && keys.every((k) => expandedGroups.has(k));
    els.serverToggleFolders.innerHTML = icon(allExpanded ? 'folder' : 'folderOpen');
    els.serverToggleFolders.title = allExpanded ? '全部折叠' : '全部展开';
  };
  els.serverToggleFolders.onclick = () => {
    const keys = allFolderKeys();
    const allExpanded = keys.length > 0 && keys.every((k) => expandedGroups.has(k));
    if (allExpanded) expandedGroups.clear();
    else keys.forEach((k) => expandedGroups.add(k));
    renderServerList();
  };

  // 列表点击委托：组标题 = 展开/收起；组全选复选框 = 整组勾选/取消；卡片 = 单选切换
  els.serverList.addEventListener('click', (e) => {
    const check = (e.target as HTMLElement).closest<HTMLInputElement>('.sgt-check');
    if (check) {
      const folder = check.dataset.folder ?? '';
      // 组全选作用于该分类全部服务器，不受搜索过滤影响
      const groupAll = (db.servers || []).filter((s) => (s.folder || '') === folder);
      const allSelected = groupAll.every((s) => selectedServerIds.includes(s.id));
      if (allSelected) {
        // 全部已选 → 全部移除
        const remove = new Set(groupAll.map((s) => s.id));
        selectedServerIds = selectedServerIds.filter((id) => !remove.has(id));
      } else {
        // 否则全部加入（去重）
        groupAll.forEach((s) => {
          if (!selectedServerIds.includes(s.id)) selectedServerIds.push(s.id);
        });
      }
      renderServerList();
      return;
    }
    const title = (e.target as HTMLElement).closest<HTMLElement>('.server-group-title');
    if (title) {
      const folder = title.dataset.folder ?? '';
      if (expandedGroups.has(folder)) expandedGroups.delete(folder);
      else expandedGroups.add(folder);
      renderServerList();
      return;
    }
    const card = (e.target as HTMLElement).closest<HTMLElement>('.server-card');
    if (!card) return;
    const id = card.dataset.id;
    if (!id) return;
    const idx = selectedServerIds.indexOf(id);
    if (idx >= 0) selectedServerIds.splice(idx, 1);
    else selectedServerIds.push(id);
    renderServerList();
  });

  // 搜索过滤：输入即重渲染（输入框为静态骨架，不随列表重建，焦点不丢）
  els.serverSearch.addEventListener('input', renderServerList);

  /* ---------- 快捷新建服务器（字段与校验复用 server-form.ts，与侧栏编辑表单同源；密码留空 = 不保存） ---------- */
  const miniForm = createServerForm(els.miniForm, {
    compact: true,
    folderOptions: () => {
      const names = new Set<string>(db.serverFolders ?? []);
      (db.servers ?? []).forEach((s) => { if (s.folder) names.add(s.folder); });
      return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh'));
    },
  });

  function expandMini() {
    els.addToggle.classList.add('hidden');
    els.mini.classList.remove('hidden');
    clearMiniError();
    miniForm.focusFirst();
  }
  function collapseMini() {
    els.mini.classList.add('hidden');
    els.addToggle.classList.remove('hidden');
  }
  function clearMiniError() {
    els.miniErr.classList.add('hidden');
  }
  function resetMini() {
    miniForm.fill(null); // 清空为新建态（密码/密钥路径不留上次输入）
    clearMiniError();
  }

  els.addToggle.onclick = expandMini;
  els.miniCancel.onclick = () => { collapseMini(); resetMini(); };

  async function saveMiniServer() {
    clearMiniError();

    const err = miniForm.validate();
    if (err) {
      els.miniErr.textContent = err;
      els.miniErr.classList.remove('hidden');
      return;
    }

    const srv = miniForm.buildServer(null);
    try {
      await upsertServer(srv, miniForm.passwordValue());
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

  /* ---------- 初始渲染 ---------- */
  void getState()
    .then((s) => {
      db = s;
      renderProjects();
    })
    .catch((err) => toast(String(err), 'error'));

  // 命令面板（Ctrl+T）等全局操作清空/变更数据后广播，此处重新拉取渲染
  const onDataChanged = () => {
    void getState()
      .then((s) => {
        db = s;
        renderProjects();
        if (!els.modal.classList.contains('hidden')) renderServerList();
      })
      .catch((err) => toast(String(err), 'error'));
  };
  window.addEventListener('aishell:data-changed', onDataChanged);

  return () => {
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('aishell:data-changed', onDataChanged);
  };
};
