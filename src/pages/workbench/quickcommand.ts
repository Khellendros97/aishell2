/**
 * 「收藏为命令收藏」共享模态 —— 从 terminal.ts 的 addToQuickCommands 平移而来,
 * 供终端信息栏 / 历史命令 / AI 命令建议卡片三处复用(模态 DOM 照 .proto/workbench-terminal.js)。
 * 流程:命令去重 → 弹模态(标题必填,预填命令截断) → push 到当前项目 quickCommands
 * → upsertProject 持久化 → bus.emit('project-changed') 联动命令收藏面板刷新。
 * 新增(对应待优化 6/7):模态含「所属目录」(组合框,可手输新分类,后端 upsert 自动注册)
 * 与「全局可用」复选框(folder/global 与 store.rs QuickCommand serde camelCase 对齐)。
 */
import { attachCombo, toast, uid } from '../../ui';
import { getState, upsertProject } from '../../api';
import { bus, Workbench } from './core';

export function addQuickCommandModal(cmdText: string): void {
  const project = Workbench.state.project;
  if (!project) { toast('当前没有打开的项目', 'error'); return; }
  const qcs = project.quickCommands ?? (project.quickCommands = []);
  if (qcs.some((q) => q.command === cmdText)) {
    toast('该命令已在命令收藏中', 'error');
    return;
  }
  /* 分类下拉候选：commandFolders ∪ 本项目命令 folder 派生值（异步拉取，失败时仅用本项目候选） */
  let cmdFolders: string[] = [];
  void getState()
    .then((s) => { cmdFolders = s.commandFolders ?? []; })
    .catch(() => { /* 后端未就绪时下拉仅含本项目命令派生目录 */ });
  const folderOptions = (): string[] => {
    const opts = new Set<string>(cmdFolders);
    qcs.forEach((q) => { if (q.folder) opts.add(q.folder); });
    return Array.from(opts).sort((a, b) => a.localeCompare(b, 'zh'));
  };

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:460px">
      <div class="modal-head"><h3>添加命令收藏</h3></div>
      <div class="modal-body">
        <div class="field"><label>指令标题<span class="req">*</span></label><input class="input mono term-qc-title" maxlength="40"></div>
        <div class="field"><label>命令</label><input class="input mono term-qc-cmd"></div>
        <div class="field"><label>所属目录</label>
          <input class="input term-qc-folder" placeholder="可输入新分类或从下拉选择，例如：常用/部署">
          <div class="hint">以 / 分隔的目录路径，可下拉选择已有分类，也可直接输入新分类；留空表示未分类</div>
        </div>
        <div class="field"><label class="term-qc-global-label">
          <input type="checkbox" class="term-qc-global"> 全局可用（所有项目的命令收藏与快捷指令面板可见可用）
        </label>
        <div class="hint">勾选后可在所有项目中使用；编辑/删除仍归属本项目</div></div>
      </div>
      <div class="modal-foot">
        <button class="btn term-qc-cancel">取消</button>
        <button class="btn primary term-qc-ok">保存</button>
      </div>
    </div>`;
  const titleInput = mask.querySelector('.term-qc-title') as HTMLInputElement;
  const cmdInput = mask.querySelector('.term-qc-cmd') as HTMLInputElement;
  const folderInput = mask.querySelector('.term-qc-folder') as HTMLInputElement;
  const globalInput = mask.querySelector('.term-qc-global') as HTMLInputElement;
  titleInput.value = cmdText.length > 24 ? `${cmdText.slice(0, 24)}…` : cmdText;
  cmdInput.value = cmdText;
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  attachCombo(folderInput, folderOptions);
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
    /* 所属目录：规范化 '/' 分隔路径（去首尾/重复分隔符），留空 = 未分类 */
    const folder = folderInput.value.trim().split('/').filter(Boolean).join('/');
    qcs.push({ id: uid('qc'), title, command, folder, global: globalInput.checked });
    void upsertProject(project).catch((e) => toast(String(e), 'error'));
    bus.emit('project-changed');
    toast('已添加命令收藏', 'success');
    close();
  };
  (mask.querySelector('.term-qc-ok') as HTMLButtonElement).onclick = save;
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}
