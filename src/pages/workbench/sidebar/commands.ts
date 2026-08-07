/**
 * 命令收藏面板 —— 移植自 .proto/workbench-sidebar.js 的「面板 3」。
 * 差异：持久化走 upsert_project 命令（原型是 A.save(db)）；无可用终端时 toast
 * 「没有可用的终端标签页」；样式类改 wbs-commands- 前缀 + 共享 .wbs-content。
 * 契约：mountCommandsPanel(container) 由 workbench.ts 侧栏框架挂载（container = #sidebar-content，
 * 面板不碰 #sidebar-head）；commandsHead 描述符由框架渲染标题与 actions 区。
 * 注意：commands 面板的准入（活跃标签须为终端）与 tab-activated 自动切回 explorer 由框架负责（照抄原型）。
 * 新增（非原型，对应待优化 6/7）：
 * - 顶部搜索框按 标题/命令内容 过滤（搜索中匹配的目录自动展开，忽略折叠态）；
 * - 按 folder 分组展示（folder 与 store.rs QuickCommand 字段对齐，commandFolders 镜像 serverFolders）；
 * - 分类目录管理：新建（搜索行按钮）/ 重命名（组标题）/ 删除（仅空组），交互与服务器分类一致；
 * - 全局可用命令：数据源 = 当前项目 quickCommands + 其他项目中 global=true 的命令；
 *   全局命令带「全局」徽标，编辑/删除仍归属原项目（卡片闭包经 slot.d 动态绑定，避免引用旧对象）。
 */
import { bus, getActiveTerminalApi, Workbench } from '../core';
import { attachCombo, confirmDialog, promptDialog, toast, uid } from '../../../ui';
import {
  createCommandFolder, deleteCommandFolder, getState, renameCommandFolder, upsertProject,
} from '../../../api';
import type { Project, QuickCommand } from '../../../types';
import { icon } from '../../../icons';
import './commands.css';

/** 侧栏框架渲染 #sidebar-head 用（标题 + actions 按钮） */
export const commandsHead = {
  title: '命令收藏',
  renderActions(el: HTMLElement): void {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn small primary';
    addBtn.textContent = '+ 新增';
    addBtn.onclick = () => openQuickCommandModal(null, Workbench.state.project);
    el.appendChild(addBtn);
  },
};

/** 一条待展示的命令及其归属项目：当前项目命令 owner = 当前项目；跨项目全局命令 owner = 其原项目 */
interface DisplayedCommand { qc: QuickCommand; owner: Project }

let container: HTMLElement | null = null;
let mounted = false;

/* 搜索行（持久元素）：搜索框 + 新建分类目录 + 全部展开/折叠，不随列表重建，避免输入焦点丢失 */
let searchWrap: HTMLElement | null = null;
let searchInput: HTMLInputElement | null = null;
let toggleBtn: HTMLButtonElement | null = null;
let searchQuery = '';
/** 展开的分类面板（键 = folder 值，空串 = 未分类）；模块级持久，重渲染保留展开态，默认全部折叠 */
const expandedFolders = new Set<string>();

let latestFolders: string[] = [];    // 最近一次 render 拉取的 commandFolders 清单（空目录也在此）
let latestCommands: QuickCommand[] = []; // 最近一次 render 的全部命令（含跨项目全局，供分类下拉候选）
let renderedGroupKeys: string[] = []; // 最近一次渲染的分组键（「全部展开/折叠」切换用）

/* 卡片 key 复用：按 qc.id 复用 DOM 节点，闭包一律经 slot.d 动态读取当前数据对象 ——
   全局命令每次 render 都来自 getState 的新拷贝，绝不能把旧对象关进闭包 */
interface CardSlot { d: DisplayedCommand; el: HTMLElement }
const cardSlots = new Map<string, CardSlot>();

function runOnTerminal(action: 'paste' | 'execute', cmd: string): void {
  const api = getActiveTerminalApi();
  if (!api) { toast('没有可用的终端标签页'); return; }
  if (action === 'paste') api.paste(cmd);
  else api.execute(cmd);
}

/** 所属目录组合框候选：commandFolders ∪ 各命令 folder 派生值（去重排序）；手输新分类保存时后端自动注册 */
const folderOptions = (): string[] => {
  const opts = new Set<string>(latestFolders);
  latestCommands.forEach((qc) => { if (qc.folder) opts.add(qc.folder); });
  return Array.from(opts).sort((a, b) => a.localeCompare(b, 'zh'));
};

/* ---------- 分类目录管理（交互与服务器分类一致：新建 prompt / 重命名 prompt / 删除确认） ---------- */
async function createFolderFlow(): Promise<void> {
  const name = await promptDialog({
    title: '新建分类目录',
    label: '目录路径（可含 / 层级）',
    placeholder: '例如：常用/部署',
    okText: '创建',
  });
  if (name === null) return;
  try {
    await createCommandFolder(name);
  } catch (err) {
    toast(String(err), 'error');
    return;
  }
  bus.emit('project-changed');
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
    await renameCommandFolder(folder, name);
  } catch (err) {
    toast(`重命名分类目录失败: ${String(err)}`, 'error');
    return;
  }
  bus.emit('project-changed');
  toast(`分类目录已重命名为「${name}」`, 'success');
}

async function deleteFolderFlow(folder: string): Promise<void> {
  const ok = await confirmDialog({
    title: '删除分类目录',
    message: `确定删除分类目录「${folder}」吗？`,
    danger: true,
    okText: '删除',
  });
  if (!ok) return;
  try {
    await deleteCommandFolder(folder);
  } catch (err) {
    toast(String(err), 'error');
    return;
  }
  expandedFolders.delete(folder);
  bus.emit('project-changed');
  toast(`分类目录「${folder}」已删除`, 'success');
}

/* ---------- 新增/编辑模态（DOM 照 .proto/workbench-terminal.js 与 sidebar 的 qc 模态） ---------- */
/** owner 为命令归属项目：新增 = 当前项目；编辑全局命令 = 其原项目（跨项目编辑仍写回原项目） */
function openQuickCommandModal(qc: QuickCommand | null, owner: Project | null): void {
  const isNew = !qc;
  /* 移除本模块残留的关闭中弹层（fade-out 期间仍挂在 DOM，避免输入被旧弹层截获） */
  document.querySelectorAll('.modal-mask').forEach((m) => {
    if (m.querySelector('.wbs-commands-qc-title-input')) m.remove();
  });
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML =
    '<div class="modal" style="width:460px">' +
      `<div class="modal-head"><h3>${isNew ? '新增命令收藏' : '编辑命令收藏'}</h3></div>` +
      '<div class="modal-body">' +
        '<div class="field"><label>标题 <span class="req">*</span></label>' +
          '<input class="input wbs-commands-qc-title-input" placeholder="例如：查看 Git 状态"></div>' +
        '<div class="field"><label>命令 <span class="req">*</span></label>' +
          '<textarea class="textarea wbs-commands-qc-cmd-input" rows="3" placeholder="例如：git status && git log --oneline -5"></textarea></div>' +
        '<div class="field"><label>所属目录</label>' +
          '<input class="input wbs-commands-qc-folder-input" placeholder="可输入新分类或从下拉选择，例如：常用/部署">' +
          '<div class="hint">以 / 分隔的目录路径，可下拉选择已有分类，也可直接输入新分类；留空表示未分类</div></div>' +
        '<div class="field"><label class="wbs-commands-global-label">' +
          '<input type="checkbox" class="wbs-commands-qc-global-input"> 全局可用（所有项目的命令收藏与快捷指令面板可见可用）' +
          '</label>' +
          `<div class="hint">勾选后可在所有项目中使用；编辑/删除仍归属${owner ? `「${owner.name}」` : '其原项目'}</div></div>` +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn wbs-commands-cancel">取消</button>' +
        '<button class="btn primary wbs-commands-save">保存</button>' +
      '</div>' +
    '</div>';
  const titleInput = mask.querySelector<HTMLInputElement>('.wbs-commands-qc-title-input')!;
  const cmdInput = mask.querySelector<HTMLTextAreaElement>('.wbs-commands-qc-cmd-input')!;
  const folderInput = mask.querySelector<HTMLInputElement>('.wbs-commands-qc-folder-input')!;
  const globalInput = mask.querySelector<HTMLInputElement>('.wbs-commands-qc-global-input')!;
  if (qc) {
    titleInput.value = qc.title;
    cmdInput.value = qc.command;
    folderInput.value = qc.folder;
    globalInput.checked = qc.global;
  }
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  attachCombo(folderInput, folderOptions);

  const close = (): void => {
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
  };
  const save = async (): Promise<void> => {
    const title = titleInput.value.trim();
    const command = cmdInput.value.trim();
    if (!title || !command) { toast('标题和命令不能为空'); return; }
    if (!owner) { toast('当前没有可用项目'); return; }
    /* 所属目录：规范化 '/' 分隔路径（去首尾/重复分隔符），留空 = 未分类（与服务器表单同语义） */
    const folder = folderInput.value.trim().split('/').filter(Boolean).join('/');
    const global = globalInput.checked;
    if (qc) {
      qc.title = title;
      qc.command = command;
      qc.folder = folder;
      qc.global = global;
    } else {
      owner.quickCommands.push({ id: uid('qc'), title, command, folder, global });
    }
    close();
    try {
      await upsertProject(owner);
      bus.emit('project-changed');
    } catch (err) {
      toast(String(err), 'error');
    }
  };
  (mask.querySelector('.wbs-commands-cancel') as HTMLButtonElement).onclick = close;
  (mask.querySelector('.wbs-commands-save') as HTMLButtonElement).onclick = () => void save();
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); void save(); }
  });
  cmdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
  });
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  titleInput.focus();
  if (qc && titleInput.value) titleInput.select();
}

/* ---------- 卡片构建（slot 闭包全部经 slot.d 动态取值，key=qc.id 复用） ---------- */
function buildCard(slot: CardSlot): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card wbs-commands-qc-card';
  const head = document.createElement('div');
  head.className = 'wbs-commands-qc-head';
  const titleEl = document.createElement('div');
  titleEl.className = 'wbs-commands-qc-title ellipsis';
  const icons = document.createElement('span');
  icons.className = 'wbs-commands-qc-icons';
  const editBtn = document.createElement('button');
  editBtn.className = 'icon-btn wbs-commands-edit';
  editBtn.title = '编辑';
  editBtn.innerHTML = icon('pencil');
  const delBtn = document.createElement('button');
  delBtn.className = 'icon-btn danger wbs-commands-del';
  delBtn.title = '删除';
  delBtn.innerHTML = icon('trash');
  icons.append(editBtn, delBtn);
  head.append(titleEl, icons);
  const cmdEl = document.createElement('div');
  cmdEl.className = 'wbs-commands-qc-cmd mono';
  const actions = document.createElement('div');
  actions.className = 'wbs-commands-qc-actions';
  const copyBtn = document.createElement('button');
  copyBtn.className = 'btn small wbs-commands-copy';
  copyBtn.textContent = '复制到终端';
  const runBtn = document.createElement('button');
  runBtn.className = 'btn small wbs-commands-run';
  runBtn.textContent = '立即执行';
  actions.append(copyBtn, runBtn);
  card.append(head, cmdEl, actions);

  /* 事件闭包读取 slot.d（点击时最新绑定），编辑/删除走归属项目 */
  editBtn.onclick = () => openQuickCommandModal(slot.d.qc, slot.d.owner);
  delBtn.onclick = () => void deleteQuickCommand(slot.d);
  copyBtn.onclick = () => runOnTerminal('paste', slot.d.qc.command);
  runBtn.onclick = () => runOnTerminal('execute', slot.d.qc.command);

  refreshCard(slot, card);
  return card;
}

/** 按 slot 当前绑定数据刷新卡片文本与「全局」徽标（跨项目可见的命令明确标记归属，编辑/删除仍走原项目） */
function refreshCard(slot: CardSlot, el: HTMLElement): void {
  const { qc } = slot.d;
  const titleEl = el.querySelector<HTMLElement>('.wbs-commands-qc-title')!;
  const cmdEl = el.querySelector<HTMLElement>('.wbs-commands-qc-cmd')!;
  titleEl.textContent = qc.title;
  titleEl.title = qc.title;
  cmdEl.textContent = qc.command;
  cmdEl.title = qc.command;
  const head = el.querySelector<HTMLElement>('.wbs-commands-qc-head')!;
  let badge = head.querySelector<HTMLElement>('.wbs-commands-global-tag');
  if (qc.global) {
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tag blue wbs-commands-global-tag';
      badge.textContent = '全局';
      head.insertBefore(badge, head.querySelector('.wbs-commands-qc-icons'));
    }
  } else if (badge) {
    badge.remove();
  }
}

function getCardEl(d: DisplayedCommand): HTMLElement {
  let slot = cardSlots.get(d.qc.id);
  if (!slot) {
    slot = { d, el: null! };
    slot.el = buildCard(slot);
    cardSlots.set(d.qc.id, slot);
  } else {
    /* 同 id 复用节点，仅重新绑定数据对象 + 刷新文本（避免闭包引用旧对象） */
    slot.d = d;
    refreshCard(slot, slot.el);
  }
  return slot.el;
}

async function deleteQuickCommand(d: DisplayedCommand): Promise<void> {
  const ok = await confirmDialog({
    title: '删除命令收藏',
    message: `确定删除「${d.qc.title}」吗？${d.owner !== Workbench.state.project ? `（归属项目「${d.owner.name}」）` : ''}`,
    danger: true,
    okText: '删除',
  });
  if (!ok) return;
  const idx = d.owner.quickCommands.indexOf(d.qc);
  if (idx >= 0) d.owner.quickCommands.splice(idx, 1);
  try {
    await upsertProject(d.owner);
    bus.emit('project-changed');
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 渲染 ---------- */
function buildSearchRow(wrap: HTMLElement): void {
  searchWrap = document.createElement('div');
  searchWrap.className = 'wbs-commands-search';
  searchInput = document.createElement('input');
  searchInput.className = 'input';
  searchInput.placeholder = '搜索命令…';
  const newFolderBtn = document.createElement('button');
  newFolderBtn.className = 'icon-btn';
  newFolderBtn.title = '新建分类目录';
  newFolderBtn.innerHTML = icon('folderPlus');
  newFolderBtn.onclick = () => void createFolderFlow();
  toggleBtn = document.createElement('button');
  toggleBtn.className = 'icon-btn';
  toggleBtn.title = '全部展开';
  toggleBtn.innerHTML = icon('folderOpen');
  toggleBtn.onclick = () => {
    const allExpanded = renderedGroupKeys.length > 0 && renderedGroupKeys.every((k) => expandedFolders.has(k));
    if (allExpanded) expandedFolders.clear();
    else renderedGroupKeys.forEach((k) => expandedFolders.add(k));
    void render();
  };
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput!.value.trim().toLowerCase();
    void render();
  });
  searchWrap.append(searchInput, newFolderBtn, toggleBtn);
  wrap.prepend(searchWrap);
}

/** 数据源：当前项目 quickCommands + 其他项目 global=true 的命令（全局命令编辑/删除仍归属原项目） */
async function collectCommands(): Promise<DisplayedCommand[]> {
  const out: DisplayedCommand[] = [];
  const project = Workbench.state.project;
  if (project) {
    for (const qc of project.quickCommands ?? []) out.push({ qc, owner: project });
  }
  try {
    const state = await getState();
    latestFolders = state.commandFolders ?? [];
    for (const p of state.projects) {
      if (p.id === project?.id) continue;
      for (const qc of p.quickCommands ?? []) {
        if (qc.global) out.push({ qc, owner: p });
      }
    }
  } catch {
    /* 后端未就绪时仅展示当前项目命令 */
  }
  return out;
}

async function render(): Promise<void> {
  if (!container) return;
  const displayed = await collectCommands();
  latestCommands = displayed.map((d) => d.qc);
  const liveIds = new Set(displayed.map((d) => d.qc.id));

  /* 内容容器复用（每次挂载框架会清空 container，这里只建一次持久搜索行） */
  let wrap = container.querySelector<HTMLElement>('.wbs-content');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'wbs-content';
    container.appendChild(wrap);
  }
  if (!searchWrap || !searchWrap.isConnected) buildSearchRow(wrap);
  let list = wrap.querySelector<HTMLElement>('.wbs-commands-list');
  if (list) list.remove();
  list = document.createElement('div');
  list.className = 'wbs-commands-list';
  searchWrap!.insertAdjacentElement('afterend', list);

  /* 回收本次未出现的卡片节点（编辑/删除/切项目后旧节点脱离 DOM 且不再复用） */
  for (const [id, slot] of cardSlots) {
    if (!liveIds.has(id)) {
      slot.el.remove();
      cardSlots.delete(id);
    }
  }

  if (!displayed.length) {
    const es = document.createElement('div');
    es.className = 'empty-state';
    es.innerHTML = `<div class="icon">${icon('star')}</div><div>暂无命令收藏</div><div style="font-size:11.5px">点击「+ 新增」创建常用命令</div>`;
    list.appendChild(es);
    return;
  }
  /* 搜索过滤：标题 / 命令内容 大小写不敏感；空串显示全部 */
  const q = searchQuery;
  const filtered = displayed.filter(({ qc }) =>
    !q || qc.title.toLowerCase().includes(q) || qc.command.toLowerCase().includes(q));

  /* 分组：commandFolders（含空目录）∪ 各命令 folder 派生值；未分类（空串）排最后 */
  const groups = new Map<string, DisplayedCommand[]>();
  const folderSet = new Set<string>(latestFolders);
  filtered.forEach((d) => folderSet.add(d.qc.folder || ''));
  folderSet.forEach((k) => groups.set(k, []));
  filtered.forEach((d) => groups.get(d.qc.folder || '')!.push(d));
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b, 'zh');
  });
  renderedGroupKeys = keys;

  /* 搜索中：命中组自动展开（忽略折叠态），隐藏空组；全部展开/折叠按钮搜索时无意义 → 隐藏 */
  const searching = !!q;
  if (toggleBtn) toggleBtn.classList.toggle('hidden', searching);
  if (!searching && toggleBtn) {
    const allExpanded = renderedGroupKeys.length > 0 && renderedGroupKeys.every((k) => expandedFolders.has(k));
    toggleBtn.innerHTML = icon(allExpanded ? 'folder' : 'folderOpen');
    toggleBtn.title = allExpanded ? '全部折叠' : '全部展开';
  }

  keys.forEach((folderKey) => {
    const items = groups.get(folderKey)!;
    if (searching && items.length === 0) return; // 搜索中隐藏无命中的组（含空目录）
    const expanded = searching ? true : expandedFolders.has(folderKey);
    const gTitle = document.createElement('div');
    gTitle.className = 'wbs-commands-group-title' + (expanded ? ' expanded' : '');
    const ic = document.createElement('span');
    ic.className = 'wbs-commands-group-ic';
    ic.innerHTML = icon(expanded ? 'folderOpen' : 'folder');
    const tx = document.createElement('span');
    tx.className = 'wbs-commands-group-name';
    tx.textContent = folderKey || '未分类';
    const cnt = document.createElement('span');
    cnt.className = 'tag';
    cnt.textContent = String(items.length);
    gTitle.append(ic, tx, cnt);
    /* 未分类不可重命名/删除；重命名与删除交互与服务器分类一致 */
    if (folderKey) {
      const renameBtn = document.createElement('button');
      renameBtn.className = 'icon-btn';
      renameBtn.title = `重命名「${folderKey}」`;
      renameBtn.innerHTML = icon('pencil');
      renameBtn.onclick = (e) => {
        e.stopPropagation();
        void renameFolderFlow(folderKey);
      };
      gTitle.append(renameBtn);
      /* 仅空组（计数 0）可删除；搜索态下空组已隐藏，不渲染删除入口 */
      if (!searching && items.length === 0) {
        const delBtn = document.createElement('button');
        delBtn.className = 'icon-btn danger';
        delBtn.title = `删除「${folderKey}」`;
        delBtn.innerHTML = icon('trash');
        delBtn.onclick = (e) => {
          e.stopPropagation();
          void deleteFolderFlow(folderKey);
        };
        gTitle.append(delBtn);
      }
    }
    /* 点击标题行 = 展开/收起该组（搜索态自动展开，点击不切换） */
    if (!searching) {
      gTitle.addEventListener('click', () => {
        if (expandedFolders.has(folderKey)) expandedFolders.delete(folderKey);
        else expandedFolders.add(folderKey);
        void render();
      });
    }
    list.appendChild(gTitle);
    const gList = document.createElement('div');
    gList.className = 'wbs-commands-group-list';
    if (!expanded) gList.classList.add('hidden');
    items.forEach((d) => gList.appendChild(getCardEl(d)));
    list.appendChild(gList);
  });
}

/* ---------- 挂载 ---------- */
export function mountCommandsPanel(el: HTMLElement): void {
  container = el;
  /* 面板切换重建 DOM：搜索词重置为空（与服务器面板同行为），折叠态保留 */
  searchQuery = '';
  if (searchInput) { searchInput.value = ''; }
  if (!mounted) {
    mounted = true;
    /* 其他模块（终端区块/本面板）改 quickCommands 后联动刷新 */
    bus.on('project-changed', () => void render());
  }
  void render();
}
