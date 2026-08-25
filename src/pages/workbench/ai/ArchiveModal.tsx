/**
 * 会话归档/生成笔记对话框(命令式 DOM 模态,照 AiDbApproval.tsx 形态:自包含、不经 React 受控状态,
 * 由 ai-engine.ts 右键菜单「归档会话」/「生成笔记」消费)。
 * variant='archive'(默认)三个模式单选:
 *   - 新建笔记(默认):标题输入框(默认会话标题) + 目录下拉(根目录 + notesList().dirs + 「+ 新建目录…」展开文本框);
 *   - 更新笔记:笔记下拉(显示相对路径;列表为空时禁用);
 *   - 仅归档:说明文案(不生成笔记)。
 * variant='note' 仅前两个模式(生成笔记不归档),标题/按钮文案换成「生成笔记」「生成」。
 * 确认后按钮区换成 spinner「正在生成笔记,可能需要一分钟左右…」,期间禁用 Esc/遮罩关闭;
 * 失败回到表单并显示错误;成功关闭并回调 onDone(notePath)。
 * 接口点:src/api.ts notesList(下拉候选);sessionArchive/sessionNote 由调用方传入 onConfirm 执行(引擎持有 transcript)。
 */
import { icon } from '../../../icons';
import { notesList } from '../../../api';
import type { ArchiveMode } from '../../../types';

export interface ArchiveModalOpts {
  /** archive = 归档会话(含仅归档模式);note = 仅生成笔记(不归档) */
  variant?: 'archive' | 'note';
  sessionTitle: string;
  /** 执行归档(由 ai-engine 注入:拼 transcript 后调 sessionArchive);
   *  resolve = 笔记绝对路径(仅归档模式为空串);reject = 失败(弹窗保留并展示错误) */
  onConfirm: (sel: {
    mode: ArchiveMode;
    title: string | null;
    dirRel: string | null;
    noteRel: string | null;
  }) => Promise<string>;
  /** 成功关闭后回调(notePath 可能为空串 = 仅归档) */
  onDone: (notePath: string) => void;
}

/** 已打开的归档对话框(防重复打开,同 AiDbApproval) */
let activeModal: { close: () => void } | null = null;

const NEW_DIR_SENTINEL = '__new_dir__';

export function openArchiveModal(opts: ArchiveModalOpts): void {
  if (activeModal) return;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const root = document.createElement('div');
  root.className = 'modal';
  root.style.width = '480px';
  mask.appendChild(root);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));

  /** 生成期间禁止 Esc/遮罩关闭(请求在途,关闭会让用户误以为已取消) */
  let busy = false;
  const close = (): void => {
    if (busy) return;
    if (activeModal !== modal) return;
    activeModal = null;
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
    window.removeEventListener('keydown', onKeydown);
  };
  const modal: { close: () => void } = { close };
  activeModal = modal;
  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close();
  };
  window.addEventListener('keydown', onKeydown);
  mask.addEventListener('mousedown', (e) => { if (e.target === mask) close(); });

  root.innerHTML = `
    <div class="modal-head">
      <h3>归档会话</h3>
      <button class="icon-btn" data-act="close" title="关闭">${icon('x')}</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label>归档方式</label>
        <div class="archive-modes">
          <label class="archive-mode"><input type="radio" name="archive-mode" value="new" checked>
            <span><b>新建笔记</b><span class="hint">AI 将会话整理为一篇新 Markdown 笔记</span></span></label>
          <label class="archive-mode"><input type="radio" name="archive-mode" value="update">
            <span><b>更新笔记</b><span class="hint">AI 将会话信息整合进既有笔记(保持原内容不丢)</span></span></label>
          <label class="archive-mode"><input type="radio" name="archive-mode" value="only">
            <span><b>仅归档</b><span class="hint">不生成笔记,仅把会话从列表移除(历史仍保留)</span></span></label>
        </div>
      </div>
      <div class="field" data-f="new-fields">
        <label>笔记标题 <span class="req">*</span></label>
        <input class="input" data-f="title" spellcheck="false">
      </div>
      <div class="field" data-f="new-fields">
        <label>保存目录</label>
        <select class="input" data-f="dir"><option value="">（根目录）</option></select>
        <input class="input hidden" data-f="newdir" placeholder="新目录相对路径，如 项目A/部署" spellcheck="false" style="margin-top:6px">
      </div>
      <div class="field hidden" data-f="update-fields">
        <label>目标笔记</label>
        <select class="input" data-f="note"></select>
        <div class="hint" data-f="note-empty">没有可更新的笔记</div>
      </div>
      <div class="archive-error hidden" data-f="error"></div>
    </div>
    <div class="modal-foot" data-f="foot">
      <button class="btn" data-act="cancel">取消</button>
      <button class="btn primary" data-act="ok">归档</button>
    </div>`;

  const titleInput = root.querySelector<HTMLInputElement>('[data-f=title]')!;
  const dirSelect = root.querySelector<HTMLSelectElement>('[data-f=dir]')!;
  const newDirInput = root.querySelector<HTMLInputElement>('[data-f=newdir]')!;
  const noteSelect = root.querySelector<HTMLSelectElement>('[data-f=note]')!;
  const noteEmptyHint = root.querySelector<HTMLElement>('[data-f=note-empty]')!;
  const errorEl = root.querySelector<HTMLElement>('[data-f=error]')!;
  const foot = root.querySelector<HTMLElement>('[data-f=foot]')!;
  titleInput.value = opts.sessionTitle;

  /* 生成笔记变体:标题/按钮换文案,移除「仅归档」模式(生成笔记必落盘笔记) */
  const isNote = opts.variant === 'note';
  const okLabel = isNote ? '生成' : '归档';
  if (isNote) {
    root.querySelector('h3')!.textContent = '生成笔记';
    root.querySelectorAll('.archive-mode').forEach((el) => {
      if (el.querySelector<HTMLInputElement>('input')?.value === 'only') el.remove();
    });
    (root.querySelector('[data-act=ok]') as HTMLButtonElement).textContent = okLabel;
  }

  /* 候选目录/笔记下拉(失败时仅根目录可用,错误在确认时由后端兜底) */
  void notesList().then((listing) => {
    for (const d of listing.dirs) {
      const opt = document.createElement('option');
      opt.value = d;
      opt.textContent = d;
      dirSelect.appendChild(opt);
    }
    const newDirOpt = document.createElement('option');
    newDirOpt.value = NEW_DIR_SENTINEL;
    newDirOpt.textContent = '＋ 新建目录…';
    dirSelect.appendChild(newDirOpt);
    for (const n of listing.notes) {
      const opt = document.createElement('option');
      opt.value = n;
      opt.textContent = n;
      noteSelect.appendChild(opt);
    }
    const hasNotes = listing.notes.length > 0;
    noteEmptyHint.classList.toggle('hidden', hasNotes);
    noteSelect.classList.toggle('hidden', !hasNotes);
    root.querySelector<HTMLInputElement>('input[value=update]')!.disabled = !hasNotes;
  }).catch(() => { /* 候选加载失败不阻塞:确认时后端给出可执行错误 */ });

  dirSelect.addEventListener('change', () => {
    const isNew = dirSelect.value === NEW_DIR_SENTINEL;
    newDirInput.classList.toggle('hidden', !isNew);
    if (isNew) newDirInput.focus();
  });

  /* 模式切换:字段显隐 */
  root.querySelectorAll<HTMLInputElement>('input[name=archive-mode]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const mode = root.querySelector<HTMLInputElement>('input[name=archive-mode]:checked')?.value ?? 'new';
      root.querySelectorAll('[data-f=new-fields]').forEach((el) => el.classList.toggle('hidden', mode !== 'new'));
      root.querySelector('[data-f=update-fields]')?.classList.toggle('hidden', mode !== 'update');
      errorEl.classList.add('hidden');
    });
  });

  const confirmHandler = (): void => {
    const mode = (root.querySelector<HTMLInputElement>('input[name=archive-mode]:checked')?.value ?? 'new') as ArchiveMode;
    let title: string | null = null;
    let dirRel: string | null = null;
    let noteRel: string | null = null;
    if (mode === 'new') {
      title = titleInput.value.trim();
      if (!title) {
        errorEl.textContent = '请填写笔记标题';
        errorEl.classList.remove('hidden');
        titleInput.focus();
        return;
      }
      dirRel = dirSelect.value === NEW_DIR_SENTINEL
        ? (newDirInput.value.trim() || null)
        : (dirSelect.value || null);
    } else if (mode === 'update') {
      noteRel = noteSelect.value || null;
      if (!noteRel) {
        errorEl.textContent = '请选择要更新的笔记';
        errorEl.classList.remove('hidden');
        return;
      }
    }

    /* 按钮区换成 spinner,期间禁用 Esc/遮罩关闭(busy 门控) */
    busy = true;
    errorEl.classList.add('hidden');
    foot.innerHTML = mode === 'only'
      ? `<span class="archive-busy">${icon('loader')}正在归档…</span>`
      : `<span class="archive-busy">${icon('loader')}正在生成笔记，可能需要一分钟左右…</span>`;

    void opts.onConfirm({ mode, title, dirRel, noteRel }).then(
      (notePath) => {
        busy = false;
        close();
        opts.onDone(notePath);
      },
      (err: unknown) => {
        /* 失败回到表单并显示错误(可修正后重试) */
        busy = false;
        foot.innerHTML = `
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn primary" data-act="ok">${okLabel}</button>`;
        foot.querySelector('[data-act=cancel]')?.addEventListener('click', close);
        foot.querySelector('[data-act=ok]')?.addEventListener('click', confirmHandler);
        errorEl.textContent = String(err) || (isNote ? '生成笔记失败' : '归档失败');
        errorEl.classList.remove('hidden');
      },
    );
  };

  root.querySelector('[data-act=close]')?.addEventListener('click', close);
  root.querySelector('[data-act=cancel]')?.addEventListener('click', close);
  root.querySelector('[data-act=ok]')?.addEventListener('click', confirmHandler);

  titleInput.focus();
  titleInput.select();
}
