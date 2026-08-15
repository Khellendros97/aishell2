/**
 * Skill 管理面板 —— 无独立原型，视觉与交互复制 sidebar/commands.ts 的紧凑分组卡片；
 * 启用开关复制 sidebar/servers.css 的 .db-switch。契约：mountSkillsPanel(panelRoot) 由
 * workbench.ts 侧栏框架挂载（panelRoot = 每次切换新建的独立容器，卸载即弃），返回 cleanup
 * 反注册 bus 监听并作废在途渲染；skillsHead 描述符由框架渲染标题与 actions 区。
 * 数据源：skillsList（后端权威，SKILL.md enabled 是启停唯一事实源），不写 localStorage；
 * 分组折叠状态模块内 Set<SkillOrigin> 会话级保留（不落盘）；搜索只过滤不持久化。
 * 新增/编辑模态：完整 SKILL.md textarea 原样提交，scope 编辑区独立收集后作为
 * skillSave 显式参数交给后端（后端只重写顶层 scope，其余字节不动），前端不解析重写 YAML。
 */
import { bus, Workbench } from '../core';
import { confirmDialog, toast } from '../../../ui';
import { getState, skillDelete, skillRead, skillSave, skillSetEnabled, skillsList } from '../../../api';
import type { Server, SkillOrigin, SkillSummary } from '../../../types';
import { icon } from '../../../icons';
import './skills.css';

/** 侧栏框架渲染 #sidebar-head 用（标题 + actions 按钮） */
export const skillsHead = {
  title: 'Skill',
  renderActions(el: HTMLElement): void {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn small primary';
    addBtn.textContent = '+ 添加';
    addBtn.onclick = () => openSkillModal(null);
    el.appendChild(addBtn);
  },
};

/** 新增时 textarea 精确预填模板（选中 your-skill-name 方便直接替换；保存前由后端权威校验） */
const NEW_SKILL_TEMPLATE = `---
name: your-skill-name
description: 说明该 Skill 的能力与触发场景。
scope:
  - all
enabled: true
---

# Skill instructions

在此编写给 AI 的操作说明。`;

let container: HTMLElement | null = null;
/** 渲染代际记号：每次 render / 卸载递增，async render 在 await 后校验，在途旧渲染一律丢弃 */
let renderSeq = 0;
/* 搜索行（持久元素）：不随列表重建，避免输入焦点丢失 */
let searchWrap: HTMLElement | null = null;
let searchInput: HTMLInputElement | null = null;
let searchQuery = '';
/** 分组折叠状态（global|project）；模块级会话保留，首次挂载默认展开，不写 aishell.json */
const collapsedGroups = new Set<SkillOrigin>();

/** 卡片 key 复用：按 SkillSummary.id 复用 DOM 节点，闭包一律经 slot.d 动态读取当前数据对象 */
interface CardSlot { d: SkillSummary; el: HTMLElement }
const cardSlots = new Map<string, CardSlot>();

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const projectId = (): string => Workbench.state.project?.id ?? '';

/* ---------- 搜索行 ---------- */
function buildSearchRow(wrap: HTMLElement): void {
  searchWrap = document.createElement('div');
  searchWrap.className = 'wbs-skills-search';
  searchInput = document.createElement('input');
  searchInput.className = 'input';
  searchInput.placeholder = '搜索 Skill（名称/描述/scope）…';
  searchInput.addEventListener('input', () => {
    searchQuery = searchInput!.value.trim().toLowerCase();
    void render();
  });
  searchWrap.append(searchInput);
  wrap.prepend(searchWrap);
}

/* ---------- 卡片 ---------- */
function buildCard(slot: CardSlot): HTMLElement {
  const card = document.createElement('div');
  card.className = 'card wbs-skills-card';
  const head = document.createElement('div');
  head.className = 'wbs-skills-head';
  const nameEl = document.createElement('div');
  nameEl.className = 'wbs-skills-name ellipsis';
  const badge = document.createElement('span');
  badge.className = 'tag wbs-skills-origin';
  head.append(nameEl, badge);
  const descEl = document.createElement('div');
  descEl.className = 'wbs-skills-desc';
  const tags = document.createElement('div');
  tags.className = 'wbs-skills-tags';
  const actions = document.createElement('div');
  actions.className = 'wbs-skills-actions';
  const toggle = document.createElement('label');
  toggle.className = 'db-switch';
  toggle.title = '启用/禁用（只改 SKILL.md 顶层 enabled）';
  toggle.innerHTML = '<input type="checkbox" class="wbs-skills-toggle"><span class="db-switch-track"></span>';
  const editBtn = document.createElement('button');
  editBtn.className = 'icon-btn';
  editBtn.title = '编辑';
  editBtn.innerHTML = icon('pencil');
  const delBtn = document.createElement('button');
  delBtn.className = 'icon-btn danger';
  delBtn.title = '删除';
  delBtn.innerHTML = icon('trash');
  actions.append(toggle, editBtn, delBtn);
  card.append(head, descEl, tags, actions);

  /* 事件闭包读取 slot.d（点击时最新绑定），避免引用旧对象 */
  editBtn.onclick = () => openSkillModal(slot.d);
  delBtn.onclick = () => void deleteSkillFlow(slot.d);
  toggle.querySelector<HTMLInputElement>('.wbs-skills-toggle')!.onchange = () =>
    void toggleEnabled(slot.d, toggle.querySelector<HTMLInputElement>('.wbs-skills-toggle')!);

  refreshCard(slot, card);
  return card;
}

/** 按 slot 当前绑定数据刷新卡片文本与来源徽标 */
function refreshCard(slot: CardSlot, el: HTMLElement): void {
  const { d } = slot;
  el.querySelector<HTMLElement>('.wbs-skills-name')!.textContent = d.name;
  el.querySelector<HTMLElement>('.wbs-skills-name')!.title = d.name;
  const badge = el.querySelector<HTMLElement>('.wbs-skills-origin')!;
  badge.textContent = d.origin === 'global' ? '全局' : '项目';
  badge.classList.toggle('blue', d.origin === 'global');
  el.querySelector<HTMLElement>('.wbs-skills-desc')!.textContent = d.description;
  el.querySelector<HTMLElement>('.wbs-skills-desc')!.title = d.description;
  const tags = el.querySelector<HTMLElement>('.wbs-skills-tags')!;
  tags.innerHTML = d.scope.map((s) => `<span class="tag wbs-skills-scope-tag">${esc(s)}</span>`).join('');
  const toggle = el.querySelector<HTMLInputElement>('.wbs-skills-toggle')!;
  toggle.checked = d.enabled;
  // 卡片按 id 复用，请求期间的 disabled 会残留到下次渲染 → 每次刷新显式复位
  toggle.disabled = false;
}

function getCardEl(d: SkillSummary): HTMLElement {
  let slot = cardSlots.get(d.id);
  if (!slot) {
    slot = { d, el: null! };
    slot.el = buildCard(slot);
    cardSlots.set(d.id, slot);
  } else {
    slot.d = d;
    refreshCard(slot, slot.el);
  }
  return slot.el;
}

/* ---------- 操作 ---------- */
async function toggleEnabled(d: SkillSummary, input: HTMLInputElement): Promise<void> {
  const next = input.checked;
  input.checked = !next; // 请求期间显示原值
  input.disabled = true;
  try {
    await skillSetEnabled(projectId(), d.origin, d.name, next);
    void render();
  } catch (err) {
    input.disabled = false;
    toast(String(err), 'error');
  }
}

async function deleteSkillFlow(d: SkillSummary): Promise<void> {
  const ok = await confirmDialog({
    title: '删除 Skill',
    message: `确定删除「${d.name}」吗？\n来源：${d.origin === 'global' ? '全局' : '项目'}\n磁盘目录：${d.path}`,
    danger: true,
    okText: '删除',
  });
  if (!ok) return;
  try {
    await skillDelete(projectId(), d.origin, d.name);
    void render();
    toast(`Skill「${d.name}」已删除`, 'success');
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 新增/编辑模态（scope 编辑区独立收集，保存时作为显式参数交给后端） ---------- */
function openSkillModal(d: SkillSummary | null): void {
  const isNew = !d;
  /* 移除本模块残留的关闭中弹层（fade-out 期间仍挂在 DOM，避免输入被旧弹层截获） */
  document.querySelectorAll('.modal-mask').forEach((m) => {
    if (m.querySelector('.wbs-skills-origin-select')) m.remove();
  });
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML =
    '<div class="modal" style="width:720px">' +
      `<div class="modal-head"><h3>${isNew ? '新增 Skill' : '编辑 Skill'}</h3></div>` +
      '<div class="modal-body">' +
        '<div class="field"><label>来源</label>' +
          '<select class="input wbs-skills-origin-select">' +
            '<option value="project">项目</option>' +
            '<option value="global">全局</option>' +
          '</select>' +
          '<div class="hint">项目技能存于 &lt;项目目录&gt;/.aishell/skills/，全局技能存于 &lt;工作区目录&gt;/.aishell/skills/</div></div>' +
        '<div class="field"><label>SKILL.md 内容 <span class="req">*</span></label>' +
          '<textarea class="textarea mono wbs-skills-content" rows="16" spellcheck="false"></textarea>' +
          '<div class="hint">name/description 以后端校验为准；scope 与 enabled 由下方/后端管理，textarea 内改动 scope 会被保存时重写</div></div>' +
        '<div class="field"><label>作用域 scope</label>' +
          '<div class="wbs-skills-scope-opts">' +
            '<label class="wbs-skills-check"><input type="checkbox" class="wbs-skills-scope-local"> local（本地工作区域）</label>' +
            '<label class="wbs-skills-check"><input type="checkbox" class="wbs-skills-scope-all"> all（始终适用）</label>' +
          '</div>' +
          '<div class="hint">远程主机（来自项目绑定服务器，勾选加入 scope：remote:&lt;Server.name&gt;）：</div>' +
          '<input class="input wbs-skills-remote-search" placeholder="搜索服务器…">' +
          '<div class="wbs-skills-remote-list"></div>' +
          '<div class="hint">其它远程主机名称（可逐项添加/移除）：</div>' +
          '<div class="wbs-skills-extra-row">' +
            '<input class="input wbs-skills-extra-input" placeholder="例如：prod-db">' +
            '<button class="btn small wbs-skills-extra-add">添加</button>' +
          '</div>' +
          '<div class="wbs-skills-extra-chips"></div></div>' +
        '<div class="wbs-skills-parse-error"></div>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn wbs-skills-cancel">取消</button>' +
        '<button class="btn primary wbs-skills-save">保存</button>' +
      '</div>' +
    '</div>';
  const originSelect = mask.querySelector<HTMLSelectElement>('.wbs-skills-origin-select')!;
  const contentInput = mask.querySelector<HTMLTextAreaElement>('.wbs-skills-content')!;
  const localCheck = mask.querySelector<HTMLInputElement>('.wbs-skills-scope-local')!;
  const allCheck = mask.querySelector<HTMLInputElement>('.wbs-skills-scope-all')!;
  const remoteSearch = mask.querySelector<HTMLInputElement>('.wbs-skills-remote-search')!;
  const remoteList = mask.querySelector<HTMLElement>('.wbs-skills-remote-list')!;
  const extraInput = mask.querySelector<HTMLInputElement>('.wbs-skills-extra-input')!;
  const extraChips = mask.querySelector<HTMLElement>('.wbs-skills-extra-chips')!;
  const errorEl = mask.querySelector<HTMLElement>('.wbs-skills-parse-error')!;
  const saveBtn = mask.querySelector<HTMLButtonElement>('.wbs-skills-save')!;
  const cancelBtn = mask.querySelector<HTMLButtonElement>('.wbs-skills-cancel')!;

  /* scope 当前值（数组，去重保序）；checkbox/服务器卡/extra chips 都从它渲染 */
  const currentScope: string[] = [];
  let serverCandidates: Server[] = [];
  const project = Workbench.state.project;
  if (project) {
    void getState().then((state) => {
      serverCandidates = state.servers.filter((s) => (project.serverIds ?? []).includes(s.id));
      renderRemoteList();
    }).catch(() => { /* 无服务器也可手动输入其它主机名称 */ });
  }

  const inScope = (v: string): boolean => currentScope.includes(v);
  const setScope = (v: string, on: boolean): void => {
    const idx = currentScope.indexOf(v);
    if (on && idx < 0) currentScope.push(v);
    if (!on && idx >= 0) currentScope.splice(idx, 1);
  };
  const remoteOf = (name: string): string => `remote:${name}`;

  function renderRemoteList(): void {
    const q = remoteSearch.value.trim().toLowerCase();
    const filtered = q
      ? serverCandidates.filter((s) => [s.name, s.host, s.username].some((v) => v.toLowerCase().includes(q)))
      : serverCandidates;
    if (!filtered.length) {
      remoteList.innerHTML = '<div class="server-empty">没有匹配的服务器，可在「其它远程主机名称」手动添加</div>';
      return;
    }
    remoteList.innerHTML = filtered.map((s) => {
      const v = remoteOf(s.name);
      const selected = inScope(v);
      return `<div class="card clickable wbs-skills-remote-card${selected ? ' selected' : ''}" data-name="${esc(s.name)}">
        <span class="ellipsis" title="${esc(s.name)}">${esc(s.name)}</span>
        <span class="mono">${esc(s.host)}</span></div>`;
    }).join('');
  }

  function renderChips(): void {
    const extras = currentScope.filter((v) => v.startsWith('remote:') && !serverCandidates.some((s) => remoteOf(s.name) === v));
    extraChips.innerHTML = extras.map((v) =>
      `<span class="tag wbs-skills-extra-chip" data-value="${esc(v)}">${esc(v)}<button class="icon-btn wbs-skills-chip-rm" title="移除">${icon('x')}</button></span>`
    ).join('');
  }

  function renderScopeControls(): void {
    localCheck.checked = inScope('local');
    allCheck.checked = inScope('all');
    renderRemoteList();
    renderChips();
  }

  /* 初始化：编辑用后端 SkillDocument.summary.scope；新增用模板一致的 ["all"] */
  if (isNew) {
    originSelect.value = 'project';
    contentInput.value = NEW_SKILL_TEMPLATE;
    currentScope.push('all');
    // 选中模板 name 方便直接替换
    contentInput.focus();
    const nameIdx = contentInput.value.indexOf('your-skill-name');
    if (nameIdx >= 0) contentInput.setSelectionRange(nameIdx, nameIdx + 'your-skill-name'.length);
  } else {
    originSelect.value = d.origin;
    originSelect.disabled = true; // 编辑锁定来源
    contentInput.value = '';
    currentScope.push(...d.scope);
    void skillRead(projectId(), d.origin, d.name)
      .then((doc) => {
        if (!mask.isConnected) return;
        contentInput.value = doc.content;
        errorEl.textContent = '';
      })
      .catch((err: unknown) => {
        if (!mask.isConnected) return;
        errorEl.textContent = `读取 Skill 失败：${String(err)}`;
      });
  }
  renderScopeControls();

  localCheck.onchange = () => { setScope('local', localCheck.checked); renderScopeControls(); };
  allCheck.onchange = () => { setScope('all', allCheck.checked); renderScopeControls(); };
  remoteSearch.addEventListener('input', renderRemoteList);
  remoteList.addEventListener('click', (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>('.wbs-skills-remote-card');
    if (!card?.dataset.name) return;
    const v = remoteOf(card.dataset.name);
    setScope(v, !inScope(v));
    renderScopeControls();
  });
  extraChips.addEventListener('click', (e) => {
    const rm = (e.target as HTMLElement).closest<HTMLElement>('.wbs-skills-chip-rm');
    if (!rm) return;
    const chip = rm.closest<HTMLElement>('.wbs-skills-extra-chip');
    if (!chip?.dataset.value) return;
    setScope(chip.dataset.value, false);
    renderScopeControls();
  });
  const addExtra = (): void => {
    const v = extraInput.value.trim();
    if (!v) return;
    if (!/^remote:/.test(v)) {
      toast('其它远程主机名称需以 remote: 开头，例如 remote:prod-db');
      return;
    }
    setScope(v, true);
    extraInput.value = '';
    renderScopeControls();
  };
  mask.querySelector<HTMLButtonElement>('.wbs-skills-extra-add')!.onclick = addExtra;
  extraInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addExtra(); }
  });
  contentInput.addEventListener('input', () => { errorEl.textContent = ''; });

  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));

  const close = (): void => {
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
  };
  const save = async (): Promise<void> => {
    saveBtn.disabled = true;
    try {
      await skillSave(projectId(), originSelect.value as SkillOrigin, isNew ? null : d!.name, contentInput.value, [...currentScope]);
      close();
      void render();
      toast('Skill 已保存', 'success');
    } catch (err) {
      /* 失败保留弹窗和输入并展示后端可执行错误 */
      errorEl.textContent = String(err);
      saveBtn.disabled = false;
    }
  };
  cancelBtn.onclick = close;
  saveBtn.onclick = () => void save();
  contentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
  });
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
}

/* ---------- 渲染 ---------- */
async function render(): Promise<void> {
  if (!container) return;
  const gen = ++renderSeq;
  const host = container;
  let items: SkillSummary[] = [];
  let error: string | null = null;
  try {
    items = await skillsList(projectId());
  } catch (err) {
    error = String(err);
  }
  /* 代际/宿主校验：await 期间面板被卸载或又有新 render 触发 → 本次结果直接丢弃 */
  if (gen !== renderSeq || host !== container || !host.isConnected) return;
  const liveIds = new Set(items.map((s) => s.id));

  /* 内容容器复用（每次挂载框架会清空 container，这里只建一次持久搜索行） */
  let wrap = container.querySelector<HTMLElement>('.wbs-content');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'wbs-content';
    container.appendChild(wrap);
  }
  if (!searchWrap || !searchWrap.isConnected) buildSearchRow(wrap);
  let list = wrap.querySelector<HTMLElement>('.wbs-skills-list');
  if (list) list.remove();
  list = document.createElement('div');
  list.className = 'wbs-skills-list';
  searchWrap!.insertAdjacentElement('afterend', list);

  /* 回收本次未出现的卡片节点 */
  for (const [id, slot] of cardSlots) {
    if (!liveIds.has(id)) {
      slot.el.remove();
      cardSlots.delete(id);
    }
  }

  /* 工作区/项目目录缺失等后端错误：展示可执行错误与重试按钮，不伪装成空列表 */
  if (error) {
    const es = document.createElement('div');
    es.className = 'empty-state';
    es.innerHTML = `<div class="icon">${icon('alert')}</div><div class="wbs-skills-error">${esc(error)}</div>`;
    const retry = document.createElement('button');
    retry.className = 'btn small';
    retry.textContent = '重试';
    retry.onclick = () => void render();
    es.appendChild(retry);
    list.appendChild(es);
    return;
  }

  if (!items.length) {
    const es = document.createElement('div');
    es.className = 'empty-state';
    es.innerHTML = `<div class="icon">${icon('sparkles')}</div><div>暂无 Skill</div><div style="font-size:11.5px">点击「+ 添加」创建全局或项目 Skill</div>`;
    list.appendChild(es);
    return;
  }

  const q = searchQuery;
  const searching = !!q;
  const filtered = items.filter((s) =>
    !q
    || s.name.toLowerCase().includes(q)
    || s.description.toLowerCase().includes(q)
    || s.scope.some((sc) => sc.toLowerCase().includes(q)));
  if (searching && !filtered.length) {
    const es = document.createElement('div');
    es.className = 'empty-state';
    es.innerHTML = `<div class="icon">${icon('search')}</div><div>没有匹配的 Skill</div><div style="font-size:11.5px">试试名称、描述或 scope 关键词</div>`;
    list.appendChild(es);
    return;
  }

  /* 两个固定分组：全局 / 项目（始终显示标题、数量与折叠状态；搜索期间强制展开命中组） */
  for (const origin of ['global', 'project'] as const) {
    const groupItems = filtered.filter((s) => s.origin === origin);
    if (searching && !groupItems.length) continue; // 搜索中隐藏无命中组
    const total = items.filter((s) => s.origin === origin).length;
    const expanded = searching ? true : !collapsedGroups.has(origin);
    const gTitle = document.createElement('div');
    gTitle.className = 'wbs-skills-group-title' + (expanded ? ' expanded' : '');
    const ic = document.createElement('span');
    ic.className = 'wbs-skills-group-ic';
    ic.innerHTML = icon(expanded ? 'folderOpen' : 'folder');
    const tx = document.createElement('span');
    tx.className = 'wbs-skills-group-name';
    tx.textContent = origin === 'global' ? '全局' : '项目';
    const cnt = document.createElement('span');
    cnt.className = 'tag';
    cnt.textContent = String(total);
    gTitle.append(ic, tx, cnt);
    if (!searching) {
      gTitle.addEventListener('click', () => {
        if (collapsedGroups.has(origin)) collapsedGroups.delete(origin);
        else collapsedGroups.add(origin);
        void render();
      });
    }
    list.appendChild(gTitle);
    const gList = document.createElement('div');
    gList.className = 'wbs-skills-group-list';
    if (!expanded) gList.classList.add('hidden');
    groupItems.forEach((s) => gList.appendChild(getCardEl(s)));
    list.appendChild(gList);
  }
}

/* ---------- 挂载 ---------- */
export function mountSkillsPanel(el: HTMLElement): () => void {
  container = el;
  /* 面板切换重建 DOM：搜索词重置为空（与服务器面板同行为），折叠状态保留 */
  searchQuery = '';
  if (searchInput) { searchInput.value = ''; }
  /* 项目切换/CRUD 后联动刷新 */
  const offProjectChanged = bus.on('project-changed', () => void render());
  void render();
  return () => {
    offProjectChanged();
    renderSeq++; // 作废在途 async render
    if (container === el) container = null;
  };
}
