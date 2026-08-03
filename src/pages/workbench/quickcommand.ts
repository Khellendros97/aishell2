/**
 * 「收藏为快捷指令」共享模态 —— 从 terminal.ts 的 addToQuickCommands 平移而来,
 * 供终端信息栏 / 历史区块 / AI 命令建议卡片三处复用(模态 DOM 照 .proto/workbench-terminal.js)。
 * 流程:命令去重 → 弹模态(标题必填,预填命令截断) → push 到当前项目 quickCommands
 * → upsertProject 持久化 → bus.emit('project-changed') 联动快捷指令面板刷新。
 */
import { toast, uid } from '../../ui';
import { upsertProject } from '../../api';
import { bus, Workbench } from './core';

export function addQuickCommandModal(cmdText: string): void {
  const project = Workbench.state.project;
  if (!project) { toast('当前没有打开的项目', 'error'); return; }
  const qcs = project.quickCommands ?? (project.quickCommands = []);
  if (qcs.some((q) => q.command === cmdText)) {
    toast('该命令已在快捷指令中', 'error');
    return;
  }
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:440px">
      <div class="modal-head"><h3>添加快捷指令</h3></div>
      <div class="modal-body">
        <div class="field"><label>指令标题<span class="req">*</span></label><input class="input term-qc-title" maxlength="40"></div>
        <div class="field"><label>命令</label><input class="input mono term-qc-cmd"></div>
      </div>
      <div class="modal-foot">
        <button class="btn term-qc-cancel">取消</button>
        <button class="btn primary term-qc-ok">保存</button>
      </div>
    </div>`;
  const titleInput = mask.querySelector('.term-qc-title') as HTMLInputElement;
  const cmdInput = mask.querySelector('.term-qc-cmd') as HTMLInputElement;
  titleInput.value = cmdText.length > 24 ? `${cmdText.slice(0, 24)}…` : cmdText;
  cmdInput.value = cmdText;
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  titleInput.focus();
  titleInput.select();
  const close = () => { mask.classList.remove('open'); setTimeout(() => mask.remove(), 160); };
  (mask.querySelector('.term-qc-cancel') as HTMLButtonElement).onclick = close;
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });
  const save = () => {
    const title = titleInput.value.trim();
    const command = cmdInput.value.trim();
    if (!title) { titleInput.style.borderColor = 'var(--red)'; titleInput.focus(); return; }
    if (!command) { cmdInput.style.borderColor = 'var(--red)'; cmdInput.focus(); return; }
    qcs.push({ id: uid('qc'), title, command });
    void upsertProject(project).catch((e) => toast(String(e), 'error'));
    bus.emit('project-changed');
    toast('已添加快捷指令', 'success');
    close();
  };
  (mask.querySelector('.term-qc-ok') as HTMLButtonElement).onclick = save;
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}
