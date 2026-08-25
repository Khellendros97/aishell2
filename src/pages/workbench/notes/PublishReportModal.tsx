/**
 * 发布钉钉日志模态框(命令式 DOM 模态,照 ../ai/ArchiveModal.tsx 形态:自包含、不经 React
 * 受控状态)。对照 .proto 无直接原型(新功能)。
 * 入口:NoteTab 工具栏「发布日志」按钮、NotesPanel 笔记右键「发布钉钉日志」。
 * 流程(五步,框内分步推进):
 *   1. 认证检测:dwsAuthStatus;未安装/未认证展示引导(终端执行 dws auth login)+ 重新检测;
 *   2. 模版选择:radio 列表,默认选中上次选择(uiExpanded['dws:lastReportTemplate'] 持久化);
 *   3. 生成内容:dwsReportGenerate(后端读笔记 + 查模版字段 + LLM 整理 contents JSON);
 *   4. 可编辑预览:每个内容项一个 textarea(label = 字段名),可修改后「确认发布」;
 *   5. 发布:dwsReportSubmit;成功视图提示移步钉钉日志查看(附 dingtalkOpenUrl 链接),
 *      report.json 临时文件由后端清理,前端不感知。
 * busy 期间禁用 Esc/遮罩关闭(同 ArchiveModal);失败回到当前步显示错误可重试。
 * 接口点:src/api.ts dws 段(dwsAuthStatus/dwsReportTemplates/dwsReportGenerate/dwsReportSubmit)
 * + getState/setUiExpanded(模版记忆)。
 */
import { icon } from '../../../icons';
import {
  dwsAuthStatus, dwsReportGenerate, dwsReportSubmit, dwsReportTemplates, getState, setUiExpanded,
} from '../../../api';
import type { DwsReportContent, DwsTemplate } from '../../../types';
import './publish-report.css';

export interface PublishReportModalOpts {
  /** 笔记绝对路径(后端校验须在 notes 根内) */
  notePath: string;
  /** 笔记显示名(标题栏展示) */
  noteName: string;
}

/** 已打开的发布模态框(防重复打开,同 ArchiveModal) */
let activeModal: { close: () => void } | null = null;

/** 模版记忆在 uiExpanded 的 key(值 = [templateId],复用目录展开状态的持久化通道) */
const LAST_TEMPLATE_KEY = 'dws:lastReportTemplate';

type Step = 'auth' | 'template' | 'preview' | 'done';

export function openPublishReportModal(opts: PublishReportModalOpts): void {
  if (activeModal) return;

  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  const root = document.createElement('div');
  root.className = 'modal publish-report-modal';
  mask.appendChild(root);
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));

  /** busy 期间禁止 Esc/遮罩关闭(LLM 生成/提交在途,关闭会让用户误以为已取消) */
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

  /* ---------- 分步渲染状态 ---------- */
  let templates: DwsTemplate[] = [];
  let selected: DwsTemplate | null = null;
  /** 预览步的内容项(content 与 textarea 双向:渲染时填入,发布时读回) */
  let items: DwsReportContent[] = [];
  let draftTemplateId = '';
  let doneUrl: string | null = null;

  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** 渲染骨架 + 当前步内容;footHtml 由各步给出 */
  const render = (step: Step, bodyHtml: string, footHtml: string): void => {
    root.innerHTML = `
      <div class="modal-head">
        <h3>发布钉钉日志</h3>
        <button class="icon-btn" data-act="close" title="关闭">${icon('x')}</button>
      </div>
      <div class="modal-body">
        <div class="pr-note hint">笔记：${esc(opts.noteName)}</div>
        ${bodyHtml}
        <div class="pr-error hidden" data-f="error"></div>
      </div>
      <div class="modal-foot" data-f="foot">${footHtml}</div>`;
    root.querySelector('[data-act=close]')?.addEventListener('click', close);
    root.querySelector('[data-act=cancel]')?.addEventListener('click', close);
    root.dataset.step = step;
  };

  const showError = (msg: string): void => {
    const el = root.querySelector<HTMLElement>('[data-f=error]');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
  };

  /** busy 态:按钮区换 spinner(期间禁用关闭) */
  const setBusyFoot = (text: string): void => {
    busy = true;
    const foot = root.querySelector<HTMLElement>('[data-f=foot]');
    if (foot) foot.innerHTML = `<span class="pr-busy">${icon('loader')}${esc(text)}</span>`;
  };

  /* ---------- 步骤 1:认证检测 ---------- */
  const renderAuth = (): void => {
    render('auth', '<div class="pr-busy">' + icon('loader') + '正在检测 dws 认证状态…</div>', '');
    void dwsAuthStatus().then(
      (st) => {
        if (!st.installed) {
          render('auth', `
            <div class="pr-guide">未检测到 dws 命令，请先安装钉钉 CLI（dws）后再使用本功能。</div>`,
            `<button class="btn" data-act="cancel">取消</button>
             <button class="btn primary" data-act="recheck">重新检测</button>`);
        } else if (!st.authenticated) {
          render('auth', `
            <div class="pr-guide">未检测到钉钉认证，请先在终端执行 <code>dws auth login</code> 完成认证，然后点击「重新检测」。</div>`,
            `<button class="btn" data-act="cancel">取消</button>
             <button class="btn primary" data-act="recheck">重新检测</button>`);
        } else {
          void loadTemplates();
        }
        root.querySelector('[data-act=recheck]')?.addEventListener('click', renderAuth);
      },
      (err: unknown) => {
        render('auth', '',
          `<button class="btn" data-act="cancel">取消</button>
           <button class="btn primary" data-act="recheck">重新检测</button>`);
        root.querySelector('[data-act=recheck]')?.addEventListener('click', renderAuth);
        showError(String(err));
      },
    );
  };

  /* ---------- 步骤 2:模版选择(记忆上次选择) ---------- */
  const loadTemplates = async (): Promise<void> => {
    render('template', '<div class="pr-busy">' + icon('loader') + '正在加载日志模版…</div>', '');
    try {
      const [list, state] = await Promise.all([dwsReportTemplates(), getState()]);
      templates = list;
      if (templates.length === 0) {
        render('template', '<div class="pr-guide">当前账号没有可用的日志模版，请先在钉钉中创建模版。</div>',
          '<button class="btn" data-act="cancel">取消</button>');
        return;
      }
      const lastId = state.uiExpanded[LAST_TEMPLATE_KEY]?.[0];
      selected = templates.find((t) => t.id === lastId) ?? templates[0];
      renderTemplateStep();
    } catch (err) {
      render('template', '',
        `<button class="btn" data-act="cancel">取消</button>
         <button class="btn primary" data-act="retry">重试</button>`);
      root.querySelector('[data-act=retry]')?.addEventListener('click', () => void loadTemplates());
      showError(String(err));
    }
  };

  const renderTemplateStep = (): void => {
    const rows = templates.map((t) => `
      <label class="pr-template">
        <input type="radio" name="pr-template" value="${esc(t.id)}"${t.id === selected?.id ? ' checked' : ''}>
        <span>${esc(t.name)}</span>
      </label>`).join('');
    render('template', `
      <div class="field">
        <label>选择日志模版</label>
        <div class="pr-templates">${rows}</div>
      </div>`,
      `<button class="btn" data-act="cancel">取消</button>
       <button class="btn primary" data-act="generate">生成内容</button>`);
    root.querySelectorAll<HTMLInputElement>('input[name=pr-template]').forEach((radio) => {
      radio.addEventListener('change', () => {
        selected = templates.find((t) => t.id === radio.value) ?? null;
      });
    });
    root.querySelector('[data-act=generate]')?.addEventListener('click', () => {
      if (!selected) return;
      // 记忆本次选择(落盘失败静默,非关键路径)
      void setUiExpanded(LAST_TEMPLATE_KEY, [selected.id]).catch(() => undefined);
      setBusyFoot('正在整理日志内容，可能需要一分钟左右…');
      void dwsReportGenerate(selected.name, opts.notePath).then(
        (draft) => {
          busy = false;
          draftTemplateId = draft.templateId;
          try {
            items = JSON.parse(draft.contents) as DwsReportContent[];
          } catch {
            renderTemplateStep();
            showError('日志内容解析失败，请重试');
            return;
          }
          renderPreviewStep();
        },
        (err: unknown) => {
          busy = false;
          renderTemplateStep();
          showError(String(err));
        },
      );
    });
  };

  /* ---------- 步骤 4:可编辑预览 ---------- */
  const renderPreviewStep = (): void => {
    const fields = items.map((it, i) => `
      <div class="field">
        <label>${esc(it.key)}</label>
        <textarea class="input pr-content" data-i="${i}" rows="5" spellcheck="false">${esc(it.content)}</textarea>
      </div>`).join('');
    render('preview', `
      <div class="hint pr-tip">模版：${esc(selected?.name ?? '')}，可编辑下方内容后确认发布</div>
      ${fields}`,
      `<button class="btn" data-act="back">返回</button>
       <button class="btn primary" data-act="publish">确认发布</button>`);
    root.querySelector('[data-act=back]')?.addEventListener('click', renderTemplateStep);
    root.querySelector('[data-act=publish]')?.addEventListener('click', () => {
      root.querySelectorAll<HTMLTextAreaElement>('.pr-content').forEach((ta) => {
        const i = Number(ta.dataset.i);
        if (items[i]) items[i].content = ta.value;
      });
      setBusyFoot('正在发布…');
      void dwsReportSubmit(draftTemplateId, JSON.stringify(items)).then(
        (res) => {
          busy = false;
          doneUrl = res.openUrl ?? null;
          renderDoneStep();
        },
        (err: unknown) => {
          busy = false;
          renderPreviewStep();
          showError(String(err));
        },
      );
    });
  };

  /* ---------- 步骤 5:发布成功 ---------- */
  const renderDoneStep = (): void => {
    const link = doneUrl
      ? `<div class="pr-link"><a href="${esc(doneUrl)}" target="_blank" rel="noopener">${esc(doneUrl)}</a></div>`
      : '';
    render('done', `
      <div class="pr-guide pr-success">发布成功，请移步钉钉日志进行查看。</div>
      ${link}`,
      `<button class="btn primary" data-act="cancel">关闭</button>`);
  };

  renderAuth();
}
