/**
 * 命令收藏面板 —— 移植自 .proto/workbench-sidebar.js 的「面板 3」。
 * 差异：持久化走 upsert_project 命令（原型是 A.save(db)）；无可用终端时 toast
 * 「没有可用的终端标签页」；样式类改 wbs-commands- 前缀 + 共享 .wbs-content。
 * 契约：mountCommandsPanel(container) 由 workbench.ts 侧栏框架挂载（container = #sidebar-content，
 * 面板不碰 #sidebar-head）；commandsHead 描述符由框架渲染标题与 actions 区。
 * 注意：commands 面板的准入（活跃标签须为终端）与 tab-activated 自动切回 explorer 由框架负责（照抄原型）。
 */
import { bus, getActiveTerminalApi, Workbench } from '../core';
import { confirmDialog, toast, uid } from '../../../ui';
import { upsertProject } from '../../../api';
import type { QuickCommand } from '../../../types';
import { icon } from '../../../icons';
import './commands.css';

/** 侧栏框架渲染 #sidebar-head 用（标题 + actions 按钮） */
export const commandsHead = {
  title: '命令收藏',
  renderActions(el: HTMLElement): void {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn small primary';
    addBtn.textContent = '+ 新增';
    addBtn.onclick = () => openQuickCommandModal(null);
    el.appendChild(addBtn);
  },
};

const esc = (s: string): string =>
  String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));

let container: HTMLElement | null = null;
let mounted = false;

function runOnTerminal(action: 'paste' | 'execute', cmd: string): void {
  const api = getActiveTerminalApi();
  if (!api) { toast('没有可用的终端标签页'); return; }
  if (action === 'paste') api.paste(cmd);
  else api.execute(cmd);
}

/* ---------- 新增/编辑模态（DOM 照 .proto/workbench-terminal.js 与 sidebar 的 qc 模态） ---------- */
function openQuickCommandModal(qc: QuickCommand | null): void {
  const isNew = !qc;
  /* 移除本模块残留的关闭中弹层（fade-out 期间仍挂在 DOM，避免输入被旧弹层截获） */
  document.querySelectorAll('.modal-mask').forEach((m) => {
    if (m.querySelector('.wbs-commands-qc-title-input')) m.remove();
  });
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML =
    '<div class="modal" style="width:440px">' +
      `<div class="modal-head"><h3>${isNew ? '新增命令收藏' : '编辑命令收藏'}</h3></div>` +
      '<div class="modal-body">' +
        '<div class="field"><label>标题 <span class="req">*</span></label>' +
          '<input class="input wbs-commands-qc-title-input" placeholder="例如：查看 Git 状态"></div>' +
        '<div class="field"><label>命令 <span class="req">*</span></label>' +
          '<textarea class="textarea wbs-commands-qc-cmd-input" rows="3" placeholder="例如：git status && git log --oneline -5"></textarea></div>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn wbs-commands-cancel">取消</button>' +
        '<button class="btn primary wbs-commands-save">保存</button>' +
      '</div>' +
    '</div>';
  const titleInput = mask.querySelector<HTMLInputElement>('.wbs-commands-qc-title-input')!;
  const cmdInput = mask.querySelector<HTMLTextAreaElement>('.wbs-commands-qc-cmd-input')!;
  if (qc) { titleInput.value = qc.title; cmdInput.value = qc.command; }
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));

  const close = (): void => {
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
  };
  const save = async (): Promise<void> => {
    const project = Workbench.state.project;
    const title = titleInput.value.trim();
    const command = cmdInput.value.trim();
    if (!title || !command) { toast('标题和命令不能为空'); return; }
    if (!project) { toast('当前没有可用项目'); return; }
    if (qc) {
      qc.title = title;
      qc.command = command;
    } else {
      project.quickCommands.push({ id: uid('qc'), title, command });
    }
    close();
    try {
      await upsertProject(project);
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

/* ---------- 渲染 ---------- */
function render(): void {
  if (!container) return;
  const project = Workbench.state.project;
  const qcs = (project && project.quickCommands) || [];
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'wbs-content';
  if (!qcs.length) {
    const es = document.createElement('div');
    es.className = 'empty-state';
    es.innerHTML = `<div class="icon">${icon('star')}</div><div>暂无命令收藏</div><div style="font-size:11.5px">点击「+ 新增」创建常用命令</div>`;
    wrap.appendChild(es);
    container.appendChild(wrap);
    return;
  }
  qcs.forEach((qc) => {
    const card = document.createElement('div');
    card.className = 'card wbs-commands-qc-card';
    card.innerHTML =
      '<div class="wbs-commands-qc-head">' +
        `<div class="wbs-commands-qc-title ellipsis" title="${esc(qc.title)}">${esc(qc.title)}</div>` +
        '<span class="wbs-commands-qc-icons">' +
          `<button class="icon-btn wbs-commands-edit" title="编辑">${icon('pencil')}</button>` +
          `<button class="icon-btn danger wbs-commands-del" title="删除">${icon('trash')}</button>` +
        '</span>' +
      '</div>' +
      `<div class="wbs-commands-qc-cmd mono" title="${esc(qc.command)}">${esc(qc.command)}</div>` +
      '<div class="wbs-commands-qc-actions">' +
        '<button class="btn small wbs-commands-copy">复制到终端</button>' +
        '<button class="btn small wbs-commands-run">立即执行</button>' +
      '</div>';
    (card.querySelector('.wbs-commands-copy') as HTMLButtonElement).onclick = () => runOnTerminal('paste', qc.command);
    (card.querySelector('.wbs-commands-run') as HTMLButtonElement).onclick = () => runOnTerminal('execute', qc.command);
    (card.querySelector('.wbs-commands-edit') as HTMLButtonElement).onclick = () => openQuickCommandModal(qc);
    (card.querySelector('.wbs-commands-del') as HTMLButtonElement).onclick = () => void deleteQuickCommand(qc);
    wrap.appendChild(card);
  });
  container.appendChild(wrap);
}

async function deleteQuickCommand(qc: QuickCommand): Promise<void> {
  const project = Workbench.state.project;
  if (!project) return;
  const ok = await confirmDialog({
    title: '删除命令收藏',
    message: `确定删除「${qc.title}」吗？`,
    danger: true,
    okText: '删除',
  });
  if (!ok) return;
  const idx = project.quickCommands.indexOf(qc);
  if (idx >= 0) project.quickCommands.splice(idx, 1);
  try {
    await upsertProject(project);
    bus.emit('project-changed');
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 挂载 ---------- */
export function mountCommandsPanel(el: HTMLElement): void {
  container = el;
  if (!mounted) {
    mounted = true;
    /* 其他模块（终端区块/本面板）改 quickCommands 后联动刷新 */
    bus.on('project-changed', () => render());
  }
  render();
}
