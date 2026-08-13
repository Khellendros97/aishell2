/**
 * 欢迎页 —— AIShell 项目唯一维度主页。
 * 服务器不再独立成维度：本页不再有「服务器分类目录」，服务器只能在项目语义下管理
 * （项目模态框勾选绑定、列表视图内展开子表编辑/删除/添加）。
 * 本页承担：项目分类目录（projectFolders）管理（新建/重命名/删除/拖拽归组）、
 * 卡片 / 列表双视图（projectView 持久化到 settings）、按 名称/路径/目录 搜索过滤、
 * 从 Xshell 导入（按会话目录自动建项目）、项目 CRUD 与服务器绑定。
 * 数据源为 Tauri 后端（get_state / upsert_project / delete_project / upsert_server /
 * create_project_folder / rename_project_folder / delete_project_folder）；
 * 新建项目先 ensureProjectDirs 拿最终路径，再 upsertProject 落盘；
 * 浏览按钮走 @tauri-apps/plugin-dialog；卡片点击经 router.navigate 进入工作台。
 */
import type { AppState, Project, Server, XshellImportResult } from '../types';
import {
  createProjectFolder, deleteProject, deleteProjectFolder, deleteServer, ensureProjectDirs,
  getState, importXshellFromDir, importXshellSessions, openDialog, renameProjectFolder,
  saveSettings, setUiExpanded, upsertProject, upsertServer,
} from '../api';
import { attachCombo, confirmDialog, promptDialog, toast, uid } from '../ui';
import { icon } from '../icons';
import { navigate } from '../router';
import type { PageRender } from '../main';
import { createServerForm } from './server-form';
import './welcome.css';

const welcomeLogoUrl = new URL('../assets/logo.svg', import.meta.url).href;

/** 展开状态的项目分类分组（键 = folder 值，空串 = 未分类）；默认全折叠，跨重渲染保留 */
const expandedGroups = new Set<string>();
/** 列表视图中展开子表（绑定服务器）的项目 id；跨重渲染保留 */
const expandedRows = new Set<string>();
/** 本次会话已从后端恢复过分组展开状态（每会话只播种一次，避免重复覆盖用户操作） */
let groupsSeeded = false;
/** 分组展开状态防抖落盘定时器（300ms 合并连续 toggle） */
let groupsPersistTimer: number | null = null;

/* ---------- 分组展开状态持久化（落盘 uiExpanded['welcome:projectGroups']，key 语义见 types.ts） ---------- */
/** 300ms 防抖把分组展开集合写入后端；失败仅 console.warn 不打扰用户 */
function persistGroupsExpanded(): void {
  const snapshot = [...expandedGroups];
  if (groupsPersistTimer !== null) window.clearTimeout(groupsPersistTimer);
  groupsPersistTimer = window.setTimeout(() => {
    groupsPersistTimer = null;
    setUiExpanded('welcome:projectGroups', snapshot).catch((err) =>
      console.warn('保存分组展开状态失败:', err));
  }, 300);
}

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c] as string);
}

export const renderWelcome: PageRender = (root) => {
  root.classList.add('welcome-page');

  /* ---------- 页面骨架 ---------- */
  root.insertAdjacentHTML('beforeend', `
    <main>
      <img class="welcome-logo-watermark" src="${welcomeLogoUrl}" alt="" aria-hidden="true">
      <div class="page-head">
        <h2>我的项目</h2>
        <span class="tag" id="proj-count">0 个项目</span>
      </div>

      <div class="welcome-toolbar">
        <input class="input" id="proj-search" placeholder="搜索项目名 / 路径 / 所属目录…">
        <button class="icon-btn" id="btn-toggle-folders" title="全部展开">${icon('folderOpen')}</button>
        <div class="view-switch">
          <button class="icon-btn" id="btn-view-card" title="卡片视图">${icon('grid')}</button>
          <button class="icon-btn" id="btn-view-list" title="列表视图">${icon('list')}</button>
        </div>
        <button class="btn" id="btn-import-xshell">${icon('folder')} 从 Xshell 导入</button>
        <button class="btn" id="btn-new-folder">${icon('folderPlus')} 新建分类目录</button>
        <button class="btn primary" id="btn-new">${icon('plus')} 新建项目</button>
      </div>

      <div id="import-note" class="import-note hidden" role="status"></div>

      <div id="proj-groups"></div>

      <div class="empty-state hidden" id="empty-state">
        <div class="icon">${icon('folder')}</div>
        <div>还没有项目，创建一个项目开始使用 AIShell</div>
        <button class="btn primary" id="btn-empty-new">新建项目</button>
      </div>
      <div class="empty-state hidden" id="search-empty">
        <div class="icon">${icon('folder')}</div>
        <div>没有匹配的项目，试试其他关键词</div>
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
            <label>所属目录</label>
            <input class="input" id="f-folder" placeholder="可输入新分类或从下拉选择，例如：生产环境/Web">
            <div class="hint">以 / 分隔的目录路径，可输入新分类或从下拉选择；留空表示未分类</div>
          </div>
          <div class="field">
            <label>绑定远程服务器（可多选）</label>
            <div class="server-search-row">
              <input class="input" id="server-search" placeholder="搜索服务器…">
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

    <!-- 列表视图：添加 / 编辑绑定服务器模态框（单页弹层，字段由 server-form.ts 渲染） -->
    <div class="modal-mask hidden" id="srv-modal">
      <div class="modal">
        <div class="modal-head">
          <h3 id="srv-modal-title">新建服务器</h3>
          <button class="icon-btn" id="srv-modal-close" title="关闭">${icon('x')}</button>
        </div>
        <div class="modal-body">
          <div id="srv-form"></div>
          <div class="error hidden" id="srv-err"></div>
        </div>
        <div class="modal-foot">
          <button class="btn" id="srv-cancel">取消</button>
          <button class="btn primary" id="srv-save">保存</button>
        </div>
      </div>
    </div>
  `);

  /* ---------- 元素引用 ---------- */
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const els = {
    search: $<HTMLInputElement>('proj-search'),
    toggleFolders: $('btn-toggle-folders'),
    btnViewCard: $('btn-view-card'),
    btnViewList: $('btn-view-list'),
    btnImportXshell: $<HTMLButtonElement>('btn-import-xshell'),
    importNote: $('import-note'),
    btnNewFolder: $('btn-new-folder'),
    btnNew: $('btn-new'),
    groups: $('proj-groups'),
    empty: $('empty-state'),
    searchEmpty: $('search-empty'),
    count: $('proj-count'),
    btnEmptyNew: $('btn-empty-new'),
    modal: $('proj-modal'),
    modalTitle: $('modal-title'),
    modalClose: $('modal-close'),
    btnCancel: $('btn-cancel'),
    btnSave: $('btn-save'),
    fName: $<HTMLInputElement>('f-name'),
    fNameErr: $('f-name-err'),
    fPath: $<HTMLInputElement>('f-path'),
    fFolder: $<HTMLInputElement>('f-folder'),
    btnBrowse: $('btn-browse'),
    serverList: $('server-list'),
    serverSearch: $<HTMLInputElement>('server-search'),
    addToggle: $('server-add-toggle'),
    mini: $('server-mini'),
    miniForm: $('mini-form'),
    miniErr: $('mini-err'),
    miniSave: $('mini-save'),
    miniCancel: $('mini-cancel'),
    srvModal: $('srv-modal'),
    srvModalTitle: $('srv-modal-title'),
    srvModalClose: $('srv-modal-close'),
    srvCancel: $('srv-cancel'),
    srvSave: $('srv-save'),
    srvFormEl: $('srv-form'),
    srvErr: $('srv-err'),
  };

  /* ---------- 状态 ---------- */
  let db: AppState = {
    settings: {
      workspaceDir: null,
      llm: { modelId: '', baseUrl: '', effort: 'low' },
      search: { enabled: false },
      theme: 'dark',
      autoSwitchAiWorkdir: true,
      projectView: 'card',
      approvalMode: 'smart',
      autoBackupRemoteFiles: true,
    },
    servers: [], projects: [], sessions: {}, projectFolders: [], commandFolders: [], uiExpanded: {}, sftpHistory: {}, sftpFavorites: {}, dbConnections: {}, seededSkillWorkspaces: [],
  };
  let editingId: string | null = null;       // null = 新建；否则为正在编辑的项目 id
  let selectedServerIds: string[] = [];      // 模态框中多选的服务器 id
  let viewMode: 'card' | 'list' = 'card';    // 项目视图（进入页面时按 settings.projectView 恢复）
  let renderedGroupKeys: string[] = [];      // 最近一次渲染的分组键（「全部展开」用）

  /* ---------- 工具行：视图切换（落盘持久化） ---------- */
  function syncViewBtns() {
    els.btnViewCard.classList.toggle('active', viewMode === 'card');
    els.btnViewList.classList.toggle('active', viewMode === 'list');
  }
  async function switchView(v: 'card' | 'list') {
    if (viewMode === v) return;
    viewMode = v;
    syncViewBtns();
    renderProjects();
    try {
      await saveSettings({ ...db.settings, projectView: v }, null, null);
    } catch (err) {
      toast(String(err), 'error');
    }
  }
  els.btnViewCard.onclick = () => void switchView('card');
  els.btnViewList.onclick = () => void switchView('list');

  /* 全部展开 / 全部折叠：单按钮按当前状态切换，图标 = 目标动作 */
  const syncToggleFoldersBtn = () => {
    const allExpanded = renderedGroupKeys.length > 0 && renderedGroupKeys.every((k) => expandedGroups.has(k));
    els.toggleFolders.innerHTML = icon(allExpanded ? 'folder' : 'folderOpen');
    els.toggleFolders.title = allExpanded ? '全部折叠' : '全部展开';
  };
  els.toggleFolders.onclick = () => {
    const allExpanded = renderedGroupKeys.length > 0 && renderedGroupKeys.every((k) => expandedGroups.has(k));
    if (allExpanded) expandedGroups.clear();
    else renderedGroupKeys.forEach((k) => expandedGroups.add(k));
    persistGroupsExpanded();
    renderProjects();
  };

  /* ---------- 项目列表渲染（按 所属目录 分组；卡片 / 列表双视图） ---------- */
  /** 搜索匹配：项目名 / 路径 / 所属目录 大小写不敏感；空串显示全部 */
  function matchProject(p: Project, q: string): boolean {
    if (!q) return true;
    return [p.name, p.path ?? '', p.folder ?? ''].some((v) => v.toLowerCase().includes(q));
  }

  /** 卡片视图：单张项目卡片（标签最多 5 个：超过 5 台显示前 4 个 + 「+剩余数量」） */
  function projectCardHtml(p: Project): string {
    const hasPath = !!p.path;
    const wsDir = db.settings.workspaceDir || '';
    const displayPath = hasPath && p.path ? p.path : `${wsDir}\\${p.name}`;
    const servers = (p.serverIds || [])
      .map((id) => db.servers.find((s) => s.id === id))
      .filter((s): s is Server => !!s);
    const tagLimit = 5;
    const shownServers = servers.length > tagLimit ? servers.slice(0, tagLimit - 1) : servers;
    const hiddenCount = servers.length - shownServers.length;
    const serverTags = servers.length
      ? shownServers.map((s) => `<span class="tag blue">${esc(s.name)}</span>`).join('')
        + (hiddenCount > 0 ? `<span class="tag">+${hiddenCount}</span>` : '')
      : '<span class="tag">仅本地</span>';
    return `
      <div class="card clickable project-card" draggable="true" data-id="${esc(p.id)}" title="${esc(p.name)}">
        <div class="pc-head">
          <span class="pc-name ellipsis">${esc(p.name)}</span>
          <div class="pc-actions">
            <button class="icon-btn" data-act="edit" data-id="${esc(p.id)}" title="编辑项目">${icon('gear')}</button>
            <button class="icon-btn danger" data-act="delete" data-id="${esc(p.id)}" title="删除项目">${icon('trash')}</button>
          </div>
        </div>
        <div class="pc-path mono ellipsis" title="${esc(displayPath)}">
          ${esc(displayPath)}${hasPath ? '' : ' <span class="tag yellow">workspace</span>'}
        </div>
        <div class="pc-tags">${serverTags}</div>
      </div>`;
  }

  /** 列表视图：项目行 + 可展开的绑定服务器子表（每台服务器 编辑/删除，底部「添加服务器」） */
  function projectRowHtml(p: Project): string {
    const hasPath = !!p.path;
    const wsDir = db.settings.workspaceDir || '';
    const displayPath = hasPath && p.path ? p.path : `${wsDir}\\${p.name}`;
    const servers = (p.serverIds || [])
      .map((id) => db.servers.find((s) => s.id === id))
      .filter((s): s is Server => !!s);
    const expanded = expandedRows.has(p.id);
    const authTag = (s: Server) => s.authType === 'key'
      ? '<span class="tag yellow">密钥</span>'
      : '<span class="tag blue">密码</span>';
    const serverRows = servers.length
      ? servers.map((s) => `
        <div class="pr-server">
          <span class="ps-name ellipsis" title="${esc(s.name)}">${esc(s.name)}</span>
          <span class="ps-host mono">${esc(s.host)}:${esc(s.port)}</span>
          <span class="ps-user">${esc(s.username || '-')}</span>
          ${authTag(s)}
          <div class="ps-actions">
            <button class="icon-btn" data-act="srv-edit" data-id="${esc(s.id)}" title="编辑服务器">${icon('pencil')}</button>
            <button class="icon-btn danger" data-act="srv-del" data-id="${esc(s.id)}" title="删除服务器">${icon('trash')}</button>
          </div>
        </div>`).join('')
      : '<div class="pr-empty-servers">暂无绑定服务器</div>';
    return `
      <div class="proj-row-wrap">
        <div class="card proj-row" draggable="true" data-id="${esc(p.id)}">
          <button class="icon-btn pr-chevron" data-act="toggle" data-id="${esc(p.id)}" title="展开 / 收起服务器">${icon(expanded ? 'chevronDown' : 'chevronRight')}</button>
          <span class="pr-name ellipsis" title="${esc(p.name)}">${esc(p.name)}</span>
          <span class="pr-path mono ellipsis" title="${esc(displayPath)}">${esc(displayPath)}</span>
          <span class="tag pr-count">${servers.length} 台服务器</span>
          <div class="pr-actions">
            <button class="icon-btn" data-act="open" data-id="${esc(p.id)}" title="打开项目">${icon('externalLink')}</button>
            <button class="icon-btn" data-act="edit" data-id="${esc(p.id)}" title="编辑项目">${icon('gear')}</button>
            <button class="icon-btn danger" data-act="delete" data-id="${esc(p.id)}" title="删除项目">${icon('trash')}</button>
          </div>
        </div>
        <div class="pr-detail${expanded ? '' : ' hidden'}" data-id="${esc(p.id)}">
          <div class="pr-servers">${serverRows}</div>
          <button class="btn pr-add-server" data-act="add-server" data-id="${esc(p.id)}">${icon('plus')} 添加服务器</button>
        </div>
      </div>`;
  }

  function renderProjects() {
    const projects = db.projects || [];
    els.count.textContent = `${projects.length} 个项目`;
    const q = els.search.value.trim().toLowerCase();
    const filtered = q ? projects.filter((p) => matchProject(p, q)) : projects;

    // 组来源：projectFolders ∪ 各项目 folder 派生值（并集，去重），空目录（0 个项目）也渲染；
    // 搜索中只展示命中项目的分组（空目录无意义，保持搜索空态语义）。
    const folderSet = new Set<string>(db.projectFolders ?? []);
    projects.forEach((p) => folderSet.add(p.folder || ''));

    // 完全没有项目且没有任何目录 → 引导空态；有项目但搜索无命中 → 搜索空态
    els.empty.classList.toggle('hidden', projects.length > 0 || folderSet.size > 0);
    els.searchEmpty.classList.toggle('hidden', !(projects.length > 0 && filtered.length === 0));

    const groups = new Map<string, Project[]>();
    if (q) {
      filtered.forEach((p) => {
        const key = p.folder || '';
        const arr = groups.get(key);
        if (arr) arr.push(p);
        else groups.set(key, [p]);
      });
    } else {
      folderSet.forEach((key) => groups.set(key, []));
      filtered.forEach((p) => groups.get(p.folder || '')!.push(p));
    }

    if (!groups.size) {
      els.groups.innerHTML = '';
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

    els.groups.innerHTML = keys.map((folderKey) => {
      const groupProjects = groups.get(folderKey)!;
      const expanded = expandedGroups.has(folderKey);
      const title = `
        <div class="proj-group-title" data-folder="${esc(folderKey)}">
          <span class="pgt-folder">${icon(expanded ? 'folderOpen' : 'folder')}</span>
          <span class="pgt-name" title="${esc(folderKey || '未分类')}">${esc(folderKey || '未分类')}</span>
          <span class="tag">${groupProjects.length}</span>
          ${folderKey ? `<button class="icon-btn" data-act="rename-folder" data-folder="${esc(folderKey)}" title="重命名「${esc(folderKey)}」">${icon('pencil')}</button>` : ''}
          ${folderKey && groupProjects.length === 0
            ? `<button class="icon-btn danger" data-act="del-folder" data-folder="${esc(folderKey)}" title="删除「${esc(folderKey)}」">${icon('trash')}</button>`
            : ''}
        </div>`;
      const body = viewMode === 'card'
        ? `<div class="proj-grid">${groupProjects.map(projectCardHtml).join('')}</div>`
        : `<div class="proj-list">${groupProjects.map(projectRowHtml).join('')}</div>`;
      return `<div class="proj-group">${title}<div class="proj-group-body${expanded ? '' : ' hidden'}">${body}</div></div>`;
    }).join('');
    renderedGroupKeys = keys;
    syncToggleFoldersBtn();
  }

  /* ---------- 分组交互（事件委托） ---------- */
  function toggleGroup(folder: string) {
    if (expandedGroups.has(folder)) expandedGroups.delete(folder);
    else expandedGroups.add(folder);
    persistGroupsExpanded();
    renderProjects();
  }
  function toggleRow(projectId: string) {
    if (expandedRows.has(projectId)) expandedRows.delete(projectId);
    else expandedRows.add(projectId);
    renderProjects();
  }

  els.groups.addEventListener('click', (e) => {
    const actEl = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (actEl) {
      const act = actEl.dataset.act;
      const id = actEl.dataset.id;
      const folder = actEl.dataset.folder;
      if (act === 'rename-folder' && folder) { void renameFolderFlow(folder); return; }
      if (act === 'del-folder' && folder) { void deleteFolderFlow(folder); return; }
      if (act === 'toggle' && id) { toggleRow(id); return; }
      if (act === 'add-server' && id) { openSrvModal(null, id); return; }
      if (act === 'open' && id) { navigate('#/workbench?project=' + id); return; }
      if (act === 'edit' && id) { openModal('edit', id); return; }
      if (act === 'delete' && id) { void deleteProjectFlow(id); return; }
      if (act === 'srv-edit' && id) {
        const srv = db.servers.find((s) => s.id === id);
        if (srv) openSrvModal(srv, null);
        return;
      }
      if (act === 'srv-del' && id) {
        const srv = db.servers.find((s) => s.id === id);
        if (srv) void deleteServerFlow(srv);
        return;
      }
      return;
    }
    // 组标题行点击 = 展开/收起（行内按钮已在上方分支处理，不会误触发折叠）
    const title = (e.target as HTMLElement).closest<HTMLElement>('.proj-group-title');
    if (title) { toggleGroup(title.dataset.folder ?? ''); return; }
    // 列表行点击（非按钮）= 展开/收起绑定服务器子表
    const row = (e.target as HTMLElement).closest<HTMLElement>('.proj-row');
    if (row?.dataset.id) { toggleRow(row.dataset.id); return; }
    // 卡片点击 = 进入工作台
    const card = (e.target as HTMLElement).closest<HTMLElement>('.project-card');
    if (card?.dataset.id) navigate('#/workbench?project=' + card.dataset.id);
  });

  /* ---------- 拖拽整理：项目拖到组标题 = 改所属目录；未分类组标题 = 清空 ---------- */
  els.groups.addEventListener('dragstart', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('.project-card, .proj-row');
    if (!e.dataTransfer || !el?.dataset.id) return;
    e.dataTransfer.setData('application/x-aishell-project', el.dataset.id);
    e.dataTransfer.setData('text/plain', el.dataset.id); // 兜底：外部场景读不到自定义类型
    el.classList.add('dragging');
  });

  els.groups.addEventListener('dragend', (e) => {
    (e.target as HTMLElement).closest<HTMLElement>('.project-card, .proj-row')?.classList.remove('dragging');
    // 拖出窗口 / 中途取消时清理残留的放置高亮
    els.groups.querySelectorAll('.proj-group-title.drop-target').forEach((t) => t.classList.remove('drop-target'));
  });

  els.groups.addEventListener('dragover', (e) => {
    const title = (e.target as HTMLElement).closest<HTMLElement>('.proj-group-title');
    if (!e.dataTransfer || !title) return;
    if (!Array.from(e.dataTransfer.types).includes('application/x-aishell-project')) return;
    e.preventDefault(); // 声明可放置，drop 才会触发
    title.classList.add('drop-target');
  });

  els.groups.addEventListener('dragleave', (e) => {
    const title = (e.target as HTMLElement).closest<HTMLElement>('.proj-group-title');
    if (!title) return;
    if (e.relatedTarget instanceof Node && title.contains(e.relatedTarget)) return; // 标题内子元素间移动不取消
    title.classList.remove('drop-target');
  });

  els.groups.addEventListener('drop', (e) => {
    const title = (e.target as HTMLElement).closest<HTMLElement>('.proj-group-title');
    if (!e.dataTransfer || !title) return;
    e.preventDefault();
    title.classList.remove('drop-target');
    const id = e.dataTransfer.getData('application/x-aishell-project') || e.dataTransfer.getData('text/plain');
    const proj = db.projects.find((p) => p.id === id);
    if (!proj) return;
    const folderKey = title.dataset.folder ?? '';
    if ((proj.folder || '') === folderKey) return; // 已在目标组，跳过
    void moveProjectToFolder(proj, folderKey);
  });

  /** 拖拽移动项目到目标目录 */
  async function moveProjectToFolder(proj: Project, folder: string): Promise<void> {
    try {
      await upsertProject({ ...proj, folder });
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    db = await getState();
    renderProjects();
    toast(`已移动到「${folder || '未分类'}」`, 'success');
  }

  /* ---------- 分类目录：新建 / 重命名 / 删除（语义同原服务器目录） ---------- */
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
      await createProjectFolder(name);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    db = await getState();
    renderProjects();
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
      await renameProjectFolder(folder, name);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    db = await getState();
    expandedGroups.delete(folder); // 目录已改名，旧折叠状态不再保留
    persistGroupsExpanded();
    renderProjects();
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
      await deleteProjectFolder(folder);
    } catch (err) {
      toast(String(err), 'error');
      return;
    }
    db = await getState();
    expandedGroups.delete(folder); // 已删除目录不再保留折叠状态
    persistGroupsExpanded();
    renderProjects();
    toast(`分类目录「${folder}」已删除`, 'success');
  }

  els.btnNewFolder.onclick = () => void createFolderFlow();

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

  /* ---------- 新建 / 编辑项目模态框 ---------- */
  /** 所属目录组合框候选：projectFolders ∪ 各项目 folder 派生值，去重排序；未分类不列。
   *  attachCombo 每次展开时调用，手输新目录保存时由后端 upsert_project 自动注册。 */
  const folderOptions = (): string[] => {
    const names = new Set<string>(db.projectFolders ?? []);
    db.projects.forEach((p) => { if (p.folder) names.add(p.folder); });
    return Array.from(names).sort((a, b) => a.localeCompare(b, 'zh'));
  };
  attachCombo(els.fFolder, folderOptions);

  function openModal(mode: 'new' | 'edit', id?: string) {
    editingId = mode === 'edit' ? (id ?? null) : null;
    els.modalTitle.textContent = editingId ? '编辑项目' : '新建项目';

    if (editingId) {
      const proj = db.projects.find((p) => p.id === editingId);
      if (!proj) return;
      els.fName.value = proj.name || '';
      els.fPath.value = proj.path || '';
      els.fFolder.value = proj.folder || '';
      selectedServerIds = (proj.serverIds || []).slice();
    } else {
      els.fName.value = '';
      els.fPath.value = '';
      els.fFolder.value = '';
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
    if (e.key !== 'Escape') return;
    if (els.modal.classList.contains('open')) closeModal();
    else if (els.srvModal.classList.contains('open')) closeSrvModal();
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
  [els.fName, els.fPath, els.fFolder].forEach((el) => {
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
    // 过滤已不存在的服务器 id：跨页面操作（如工作台删除服务器）后本页内存快照可能过期，
    // 直接全量覆盖会把幽灵 id 写回配置文件。
    try {
      const alive = new Set((await getState()).servers.map((s) => s.id));
      if (serverIds.length) {
        for (let i = serverIds.length - 1; i >= 0; i--) {
          if (!alive.has(serverIds[i])) serverIds.splice(i, 1);
        }
      }
    } catch {
      /* 后端未就绪时保持原勾选 */
    }
    // 所属目录：规范化 '/' 分隔路径（去首尾/重复分隔符），留空 = 未分类
    const folder = els.fFolder.value.trim().split('/').filter(Boolean).join('/');

    if (editingId) {
      const proj = db.projects.find((p) => p.id === editingId);
      if (!proj) return;
      const updated: Project = { ...proj, name, path: pathInput || null, serverIds, folder };
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
          folder,
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

  /* ---------- 服务器多选列表（平铺，仅搜索过滤） ---------- */
  function renderServerList() {
    const all = db.servers || [];
    if (!all.length) {
      els.serverList.innerHTML = '<div class="server-empty">暂无服务器，可在下方新建</div>';
      return;
    }
    // 搜索过滤：名称 / host / username 大小写不敏感；空串显示全部
    const q = els.serverSearch.value.trim().toLowerCase();
    const filtered = q
      ? all.filter((s) => [s.name, s.host, s.username].some((v) => v.toLowerCase().includes(q)))
      : all;
    if (!filtered.length) {
      els.serverList.innerHTML = '<div class="server-empty">没有匹配的服务器，试试其他关键词</div>';
      return;
    }
    els.serverList.innerHTML = filtered.map((s) => {
      const selected = selectedServerIds.includes(s.id);
      const authTag = s.authType === 'key'
        ? '<span class="tag yellow">密钥</span>'
        : '<span class="tag blue">密码</span>';
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

  // 列表点击委托：卡片 = 单选切换
  els.serverList.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.server-card');
    if (!card?.dataset.id) return;
    const id = card.dataset.id;
    const idx = selectedServerIds.indexOf(id);
    if (idx >= 0) selectedServerIds.splice(idx, 1);
    else selectedServerIds.push(id);
    renderServerList();
  });

  // 搜索过滤：输入即重渲染（输入框为静态骨架，不随列表重建，焦点不丢）
  els.serverSearch.addEventListener('input', renderServerList);
  /* 项目搜索:输入即按 名称/路径/所属目录 过滤重渲染(matchProject 见上) */
  els.search.addEventListener('input', renderProjects);

  /* ---------- 快捷新建服务器（字段与校验复用 server-form.ts，与侧栏编辑表单同源；密码留空 = 不保存） ---------- */
  const miniForm = createServerForm(els.miniForm, { compact: true });

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

  /* ---------- 列表视图：绑定服务器 添加 / 编辑 / 删除 ---------- */
  const srvForm = createServerForm(els.srvFormEl);
  let srvEditingId: string | null = null;
  let srvContextProjectId: string | null = null; // 新建服务器自动并入该项目的绑定

  function openSrvModal(server: Server | null, contextProjectId: string | null) {
    srvEditingId = server ? server.id : null;
    srvContextProjectId = contextProjectId;
    els.srvModalTitle.textContent = server ? '编辑服务器' : '新建服务器';
    srvForm.fill(server);
    els.srvErr.classList.add('hidden');
    els.srvModal.classList.remove('hidden');
    requestAnimationFrame(() => els.srvModal.classList.add('open'));
    srvForm.focusFirst();
  }

  function closeSrvModal() {
    els.srvModal.classList.remove('open');
    setTimeout(() => els.srvModal.classList.add('hidden'), 160);
  }

  els.srvModalClose.onclick = closeSrvModal;
  els.srvCancel.onclick = closeSrvModal;
  els.srvModal.addEventListener('mousedown', (e) => {
    if (e.target === els.srvModal) closeSrvModal();
  });

  async function saveSrvModal() {
    const err = srvForm.validate();
    if (err) {
      els.srvErr.textContent = err;
      els.srvErr.classList.remove('hidden');
      return;
    }
    const editing = srvEditingId ? db.servers.find((s) => s.id === srvEditingId) ?? null : null;
    const srv = srvForm.buildServer(editing);
    try {
      await upsertServer(srv, srvForm.passwordValue());
    } catch (e) {
      toast(String(e), 'error');
      return;
    }

    if (editing) {
      Object.assign(editing, srv);
      toast('服务器已更新', 'success');
    } else {
      db.servers.push(srv);
      // 新建服务器：把 id 并入当前项目绑定后再落盘（幂等去重）
      if (srvContextProjectId) {
        const proj = db.projects.find((p) => p.id === srvContextProjectId);
        if (proj && !proj.serverIds.includes(srv.id)) {
          proj.serverIds.push(srv.id);
          try {
            await upsertProject(proj);
          } catch (e) {
            toast(`服务器已创建，但绑定项目失败：${String(e)}`, 'error');
            closeSrvModal();
            renderProjects();
            return;
          }
        }
      }
      toast('服务器已创建', 'success');
    }
    closeSrvModal();
    renderProjects();
  }
  els.srvSave.onclick = () => void saveSrvModal();

  /** 删除服务器（列表视图子表）：后端级联从绑定项目 serverIds 中移除，本地同步 */
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
    db.servers = db.servers.filter((s) => s.id !== server.id);
    db.projects.forEach((p) => {
      p.serverIds = p.serverIds.filter((id) => id !== server.id);
    });
    renderProjects();
    toast(`已删除服务器「${server.name}」`, 'success');
  }

  /* ---------- 从 Xshell 一键导入（自动扫描失败 → 目录选择器手动指定） ---------- */
  async function importXshellFlow() {
    // 进行态：禁用按钮并替换内容，成功/失败都恢复
    const originalHtml = els.btnImportXshell.innerHTML;
    const setBusy = (busy: boolean) => {
      els.btnImportXshell.disabled = busy;
      els.btnImportXshell.innerHTML = busy ? `${icon('loader')} 正在扫描 Xshell 会话…` : originalHtml;
    };
    // 导入结果落库并刷新（自动扫描与手动重试共用）
    const applyResult = async (r: XshellImportResult) => {
      db = await getState();
      renderProjects();
      const projectNote = r.projectsCreated > 0 ? `，新建 ${r.projectsCreated} 个项目` : '';
      toast(`Xshell 导入完成：新增 ${r.imported}，更新 ${r.updated}，未变化 ${r.unchanged}，跳过 ${r.skipped}${projectNote}`, 'success');
      // needsAttention>0 时用页面内持久提示（toast 仅 2.2s 读不完长文案）；=0 时隐藏
      els.importNote.classList.toggle('hidden', r.needsAttention === 0);
      if (r.needsAttention > 0) {
        els.importNote.innerHTML = `${icon('alert')} 已导入，但有 ${r.needsAttention} 个会话需处理：Xshell 密码不会迁移；NSSSH 专用密钥请在 Xshell 的「工具 → 用户密钥管理器」中导出为无密码短语的 OpenSSH 私钥，再编辑服务器替换密钥路径`;
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
  els.btnImportXshell.onclick = () => void importXshellFlow();

  /* ---------- 初始渲染 ---------- */
  void getState()
    .then((s) => {
      db = s;
      viewMode = s.settings.projectView ?? 'card';
      syncViewBtns();
      // 展开状态播种：首次取到 state 即恢复分组展开集合（此刻尚无分组 DOM 可点击，无竞态）
      if (!groupsSeeded) {
        groupsSeeded = true;
        for (const f of s.uiExpanded?.['welcome:projectGroups'] ?? []) expandedGroups.add(f);
      }
      renderProjects();
    })
    .catch((err) => toast(String(err), 'error'));

  // 命令面板（Ctrl+T）等全局操作清空/变更数据后广播，此处重新拉取渲染
  const onDataChanged = () => {
    void getState()
      .then((s) => {
        db = s;
        renderProjects();
        if (els.modal.classList.contains('open')) renderServerList();
      })
      .catch((err) => toast(String(err), 'error'));
  };
  window.addEventListener('aishell:data-changed', onDataChanged);

  return () => {
    document.removeEventListener('keydown', onKeydown);
    window.removeEventListener('aishell:data-changed', onDataChanged);
  };
};
