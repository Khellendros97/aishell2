/**
 * 发布工单日志模态框(命令式 DOM 模态,照 PublishReportModal.tsx 形态:自包含、不经 React 受控状态)。
 * 对照 .proto 无直接原型(新功能)。
 * 入口:NoteTab 工具栏「发布工单日志」按钮、NotesPanel 笔记右键「发布工单日志」。
 * 用途:把笔记内容整理为「工单处理报告」提交到云平台激励计划(协议见
 * docs/AIShell云服务-激励计划API文档.md §二);管理员审核通过后入账「工单报告」积分。
 * 流程(单步表单):打开时 fsRead 读笔记正文预填到正文域 → 用户补充标题/工单号/附件 →
 * 「发布」调 incentiveSubmitTicketReport(multipart,附件由后端读取上传)→ 成功提示待审核。
 * busy 期间禁用 Esc/遮罩关闭(提交在途,关闭会让用户误以为已取消);失败显示错误可重试。
 * 接口点:src/api.ts incentive 段(incentiveSubmitTicketReport)+ fs 段(fsRead)+ openDialog(附件选择)。
 */
import { icon } from '../../../icons';
import { fsRead, incentiveSubmitTicketReport, openDialog } from '../../../api';
import { toast } from '../../../ui';
import type { IncentiveTicketReport } from '../../../types';
import './publish-report.css';

export interface PublishTicketModalOpts {
  /** 笔记绝对路径(打开时读取正文预填) */
  notePath: string;
  /** 笔记显示名(标题栏展示) */
  noteName: string;
}

/** 已打开的工单模态框(防重复打开,同 PublishReportModal) */
let activeModal: { close: () => void } | null = null;

/** 服务端字段上限(与 cloud.rs incentive_submit_ticket_report 同口径) */
const TITLE_MAX = 120;
const CONTENT_MAX = 10000;
const REF_MAX = 255;
const MAX_ATTACHMENTS = 10;

/** 服务端安全扩展名白名单(激励计划 API 文档 §二;与 cloud.rs 复用 feedback 白名单同口径) */
const ALLOWED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'heic',
  'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz',
]);

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function extAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return true;
  const idx = lower.lastIndexOf('.');
  return idx > 0 && ALLOWED_EXTS.has(lower.slice(idx + 1));
}

export function openPublishTicketModal(opts: PublishTicketModalOpts): void {
  if (activeModal) return;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const root = document.createElement('div');
  root.className = 'modal publish-ticket-modal';
  mask.appendChild(root);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));

  /** busy 期间禁止 Esc/遮罩关闭(提交在途,关闭会让用户误以为已取消) */
  let busy = false;
  let attachments: string[] = [];
  let submitted: IncentiveTicketReport | null = null;

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

  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const showError = (msg: string): void => {
    const el = root.querySelector<HTMLElement>('[data-f=error]');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
  };
  const clearError = (): void => root.querySelector<HTMLElement>('[data-f=error]')?.classList.add('hidden');

  /** 附件选择区渲染(选择/删除后局部刷新,不动用户已填的标题与正文) */
  const renderAttachments = (): void => {
    const box = root.querySelector<HTMLElement>('[data-f=attachments]');
    if (!box) return;
    box.innerHTML = attachments.length === 0
      ? '<div class="pt-attach-empty">未选择附件（可选，支持图片/PDF/Office/文本日志/压缩包）</div>'
      : attachments.map((p, i) => `
          <div class="pt-attach-row">
            <span class="pt-attach-name" title="${esc(p)}">${esc(fileName(p))}</span>
            <button class="icon-btn" data-attach-remove="${i}" title="移除">${icon('x')}</button>
          </div>`).join('');
    box.querySelectorAll<HTMLButtonElement>('[data-attach-remove]').forEach((btn) => {
      btn.addEventListener('click', () => {
        attachments.splice(Number(btn.dataset.attachRemove), 1);
        renderAttachments();
      });
    });
  };

  /** 已提交成功视图(展示报告编号与待审核说明) */
  const renderDone = (): void => {
    root.innerHTML = `
      <div class="modal-head">
        <h3>发布工单日志</h3>
        <button class="icon-btn" data-act="close" title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="pr-guide pr-success">工单日志已提交${submitted ? `（编号 #${submitted.id}）` : ''}，等待管理员审核通过后计入「工单报告」积分。</div>
      </div>
      <div class="modal-foot">
        <button class="btn primary" data-act="close">关闭</button>
      </div>`;
    root.querySelectorAll('[data-act=close]').forEach((el) => el.addEventListener('click', close));
  };

  /** 主表单(打开即渲染,正文域先占位、读盘后回填) */
  const renderForm = (): void => {
    root.innerHTML = `
      <div class="modal-head">
        <h3>发布工单日志</h3>
        <button class="icon-btn" data-act="close" title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="pr-note hint">笔记：${esc(opts.noteName)}</div>
        <div class="field">
          <label>标题<span class="req">*</span></label>
          <input class="input" data-f="title" type="text" maxlength="${TITLE_MAX}"
                 placeholder="一句话概括本次工单处理（不超过 ${TITLE_MAX} 字）" spellcheck="false">
        </div>
        <div class="field">
          <label>工单号 / 链接</label>
          <input class="input" data-f="ref" type="text" maxlength="${REF_MAX}"
                 placeholder="选填，如 TICKET-1024 或工单链接" spellcheck="false">
        </div>
        <div class="field">
          <label>正文<span class="req">*</span></label>
          <textarea class="input pt-content" data-f="content" rows="12" spellcheck="false"
                    placeholder="正在读取笔记内容…"></textarea>
          <div class="hint pt-counter" data-f="counter"></div>
        </div>
        <div class="field">
          <label>附件</label>
          <div class="pt-attachments" data-f="attachments"></div>
          <div><button class="btn small" data-act="pick">${icon('filePlus')} 添加附件</button></div>
        </div>
        <div class="pr-error hidden" data-f="error"></div>
      </div>
      <div class="modal-foot" data-f="foot">
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn brand-gradient pt-publish" data-act="publish">${icon('ticket')} 发布工单日志</button>
      </div>`;

    root.querySelector('[data-act=close]')?.addEventListener('click', close);
    root.querySelector('[data-act=cancel]')?.addEventListener('click', close);
    root.querySelector('[data-act=pick]')?.addEventListener('click', () => void pickFiles());
    root.querySelector('[data-act=publish]')?.addEventListener('click', () => void submit());

    const counter = root.querySelector<HTMLElement>('[data-f=counter]');
    const updateCounter = (): void => {
      const ta = root.querySelector<HTMLTextAreaElement>('[data-f=content]');
      if (counter && ta) counter.textContent = `${ta.value.length} / ${CONTENT_MAX} 字`;
    };
    root.querySelector('[data-f=content]')?.addEventListener('input', updateCounter);
    renderAttachments();
    updateCounter();

    // 读笔记正文预填(失败不阻断,留空让用户手填)
    void fsRead(opts.notePath).then(
      (text) => {
        const ta = root.querySelector<HTMLTextAreaElement>('[data-f=content]');
        if (!ta) return; // 已切到成功视图/关闭
        const body = text.slice(0, CONTENT_MAX);
        ta.value = body;
        updateCounter();
        // 标题留空由用户填写;正文过长时提示已截断
        if (text.length > CONTENT_MAX) {
          const hint = root.querySelector<HTMLElement>('[data-f=counter]');
          if (hint) hint.textContent += `（笔记过长已截断至 ${CONTENT_MAX} 字）`;
        }
      },
      (err: unknown) => {
        const ta = root.querySelector<HTMLTextAreaElement>('[data-f=content]');
        if (ta) ta.placeholder = '未能读取笔记内容，请手动填写';
        showError(`读取笔记失败：${String(err)}`);
      },
    );
  };

  const pickFiles = async (): Promise<void> => {
    const picked = await openDialog({ multiple: true, directory: false });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    const merged = [...attachments];
    for (const p of list) {
      if (!merged.includes(p)) merged.push(p);
    }
    if (merged.length > MAX_ATTACHMENTS) {
      showError(`附件最多 ${MAX_ATTACHMENTS} 个`);
      return;
    }
    const bad = merged.find((p) => !extAllowed(fileName(p)));
    if (bad) {
      showError(`附件类型不允许：${fileName(bad)}（支持图片/PDF/Office/文本日志/压缩包）`);
      return;
    }
    clearError();
    attachments = merged;
    renderAttachments();
  };

  const submit = async (): Promise<void> => {
    const titleEl = root.querySelector<HTMLInputElement>('[data-f=title]');
    const refEl = root.querySelector<HTMLInputElement>('[data-f=ref]');
    const contentEl = root.querySelector<HTMLTextAreaElement>('[data-f=content]');
    if (!titleEl || !contentEl) return;
    const title = titleEl.value.trim();
    const content = contentEl.value.trim();
    const ticketRef = refEl?.value.trim() ?? '';
    if (!title) { showError('标题不能为空'); return; }
    if (title.length > TITLE_MAX) { showError(`标题不能超过 ${TITLE_MAX} 字`); return; }
    if (!content) { showError('正文不能为空'); return; }
    if (content.length > CONTENT_MAX) { showError(`正文不能超过 ${CONTENT_MAX} 字`); return; }
    clearError();

    busy = true;
    const foot = root.querySelector<HTMLElement>('[data-f=foot]');
    if (foot) foot.innerHTML = `<span class="pr-busy">${icon('loader')}正在提交工单日志…</span>`;
    try {
      submitted = await incentiveSubmitTicketReport(title, content, ticketRef, attachments);
      busy = false;
      toast('工单日志已提交，等待管理员审核', 'success');
      renderDone();
    } catch (err) {
      busy = false;
      // 失败:重建表单会丢用户输入,故只恢复按钮区并显示错误
      if (foot) {
        foot.innerHTML = `
          <button class="btn" data-act="cancel">取消</button>
          <button class="btn brand-gradient pt-publish" data-act="publish">${icon('ticket')} 重试发布</button>`;
        foot.querySelector('[data-act=cancel]')?.addEventListener('click', close);
        foot.querySelector('[data-act=publish]')?.addEventListener('click', () => void submit());
      }
      showError(String(err));
    }
  };

  renderForm();
}
