/**
 * 工作台编辑器模块 —— 注册 'editor' 标签渲染器（CodeMirror 6）。
 * 移植自 .proto/workbench-editor.js：
 *   - 脏标记 ● / 800ms 防抖自动保存 / Ctrl+S 立即保存 / 关闭时静默落盘
 *   - 语法高亮改用 @codemirror/language-data 按文件名/扩展名匹配（不可识别为纯文本）
 *   - 数据源为真实 fs_read / fs_write（后端 fsops），载入失败 toast 错误原文并显示空文档
 * 扩展（待优化 9，.proto 无此规格）：Ctrl+F / Ctrl+H 查找替换栏（复用 @codemirror/search），
 *   替换走既有脏标记/自动保存；无只读态（二进制文件在打开前已被拦截）。
 * import 即完成注册（副作用），由 workbench.ts 引入。
 */
import { EditorState, Prec, StateEffect, Compartment, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, selectAll } from '@codemirror/commands';
import { HighlightStyle, LanguageDescription, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { oneDarkTheme } from '@codemirror/theme-one-dark';
import { search, SearchQuery, getSearchQuery, openSearchPanel, closeSearchPanel, searchPanelOpen, setSearchQuery, findNext, findPrevious, replaceNext, replaceAll } from '@codemirror/search';
import type { Panel, ViewUpdate } from '@codemirror/view';
import { fsRead, fsWrite, onFsChanged, sftpRead, sftpStat, sftpWrite } from '../../api';
import { copyText, showContextMenu, toast, uid } from '../../ui';
import { icon } from '../../icons';
import type { IconName } from '../../icons';
import type { FileRef } from '../../types';
import { registerRenderer, bus, setTabTitle, Workbench, type Tab } from './core';
import { currentTheme, onThemeChange } from '../../theme';
import './editor.css';

/* 两套编辑器语法色均避开默认的纯蓝 #0000ff，保证浅色/深色背景上的对比度。 */
const darkHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#ff8bd4' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: '#ff9f9f' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#8bd5ff' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#ffd580' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#f0f3f6' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#ffe08a' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: '#80d8ff' },
  { tag: [tags.meta, tags.comment], color: '#8d99aa' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#ffc777' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#a6e3a1' },
  { tag: tags.invalid, color: '#ff6b6b' },
  { tag: tags.link, color: '#8bd5ff', textDecoration: 'underline' },
], { themeType: 'dark' });

const lightHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#7a3e9d' },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName, tags.macroName], color: '#a31515' },
  { tag: [tags.function(tags.variableName), tags.labelName], color: '#075985' },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: '#7a4f01' },
  { tag: [tags.definition(tags.name), tags.separator], color: '#374151' },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation, tags.modifier, tags.self, tags.namespace], color: '#7c4a03' },
  { tag: [tags.operator, tags.operatorKeyword, tags.url, tags.escape, tags.regexp, tags.link, tags.special(tags.string)], color: '#006d77' },
  { tag: [tags.meta, tags.comment], color: '#5f6b7a' },
  { tag: [tags.atom, tags.bool, tags.special(tags.variableName)], color: '#8a4b08' },
  { tag: [tags.processingInstruction, tags.string, tags.inserted], color: '#18794e' },
  { tag: tags.invalid, color: '#b42318' },
  { tag: tags.link, color: '#0b5cad', textDecoration: 'underline' },
], { themeType: 'light' });

/* CodeMirror 主题随全局主题切换：两套高亮配色都显式重配。 */
const cmTheme = new Compartment();
const cmThemeExt = (): Extension => currentTheme() === 'dark'
  ? [oneDarkTheme, syntaxHighlighting(darkHighlightStyle)]
  : syntaxHighlighting(lightHighlightStyle);

/** 单个编辑器标签的运行状态 */
interface EditorEntry {
  tab: Tab;
  baseTitle: string;
  dirty: boolean;
  /** 文档变更版本号：写盘成功时仅当版本未再变才去脏 */
  version: number;
  /** 防抖定时器（自动保存 800ms） */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** 串行化写盘链，避免并发 fs_write 乱序 */
  chain: Promise<void>;
  /** 程序化载入文档期间禁止标记脏 */
  loading: boolean;
  view: EditorView;
  /** 远端文件打开时的 stat 快照（保存前与远端比对，检测外部修改）；无快照 = 不检测 */
  remoteStat?: { size: number; mtime: number } | null;
  /** 远端已被外部修改（未解决前自动保存静默跳过，Ctrl+S 弹窗处理） */
  conflict: boolean;
  /** 冲突弹窗防重入 */
  conflictDialogOpen: boolean;
}

const entries = new Map<string, EditorEntry>();
onThemeChange(() => {
  entries.forEach((e) => e.view.dispatch({ effects: cmTheme.reconfigure(cmThemeExt()) }));
});

/** Windows 路径比较键：统一分隔符与大小写，避免 Rust PathBuf 的 `\\` 与前端项目路径的 `/` 不匹配 */
function filePathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

/* ---------- 保存：防抖自动保存与 Ctrl+S / 关闭落盘共用，写盘串行化 ---------- */
/** 远端写回冲突（外部已修改）：携带后端返回的远端当前属性 */
class RemoteConflictError extends Error {
  constructor(readonly actualSize: number | null, readonly actualMtime: number | null) {
    super('远端文件已被外部修改');
  }
}

/** explicit：Ctrl+S 显式保存（冲突时弹三选对话框）；自动保存/关闭时仅提示一次不打断 */
function queueSave(entry: EditorEntry, silent: boolean, explicit = false): Promise<void> {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  const path = String(entry.tab.data.path ?? '');
  const sftp = entry.tab.data.sftp as { serverId?: string; remotePath?: string } | undefined;
  const remote = Boolean(sftp?.serverId && sftp.remotePath);
  const content = entry.view.state.doc.toString();
  const version = entry.version;
  // 远端文件（SFTP 打开）保存走 sftp_write（带打开时快照做外部修改冲突检测），否则本地 fs_write
  const run = remote
    ? entry.chain.then(async () => {
        const res = await sftpWrite(
          sftp!.serverId!, sftp!.remotePath!, content,
          entry.remoteStat?.size, entry.remoteStat?.mtime,
        );
        if (res.conflict) {
          entry.conflict = true;
          throw new RemoteConflictError(res.actualSize ?? null, res.actualMtime ?? null);
        }
        // 写盘成功：以后端落盘后属性重建基线（mtime/size 以服务器为准，避免下次误报）
        entry.conflict = false;
        if (res.actualSize != null && res.actualMtime != null) {
          entry.remoteStat = { size: res.actualSize, mtime: res.actualMtime };
        }
      })
    : entry.chain.then(() => fsWrite(path, content));
  entry.chain = run.catch(() => undefined); // 失败不阻断后续写盘
  return run.then(
    () => {
      // 写盘完成时文档未被继续修改 → 去脏并还原标题
      if (entry.version === version) {
        entry.dirty = false;
        setTabTitle(entry.tab.id, entry.baseTitle);
      }
      if (!silent) toast(remote ? '已保存到远端' : '已自动保存', 'success');
    },
    (err: unknown) => {
      if (err instanceof RemoteConflictError) {
        handleRemoteConflict(entry, err, explicit);
        return;
      }
      // 失败：toast 错误原文，保留脏标
      toast(String(err), 'error');
    },
  );
}

/** 远端被外部修改：explicit（Ctrl+S）弹三选确认；否则只提示一次（自动保存/关闭不打断流程）。 */
function handleRemoteConflict(entry: EditorEntry, err: RemoteConflictError, explicit: boolean): void {
  if (!explicit) {
    if (!entry.conflict) {
      toast(`「${entry.baseTitle}」远端已被外部修改，未覆盖保存（Ctrl+S 可处理）`, 'info');
    }
    return;
  }
  if (entry.conflictDialogOpen) return;
  entry.conflictDialogOpen = true;
  conflictDialog(entry.baseTitle, err.actualSize, err.actualMtime).then((choice) => {
    entry.conflictDialogOpen = false;
    if (!entries.has(entry.tab.id)) return; // 弹窗期间标签已关闭
    if (choice === 'overwrite') {
      entry.remoteStat = null; // 强制覆写：跳过冲突检测
      void queueSave(entry, false);
    } else if (choice === 'reload') {
      entry.conflict = false;
      void loadFile(entry, true).then(() => rebaseRemoteStat(entry));
    }
    // cancel：保留脏标与 conflict 标记，自动保存继续静默跳过
  });
}

/** 重新加载后刷新基线：以远端当前 stat 为准，避免下次保存误报冲突 */
async function rebaseRemoteStat(entry: EditorEntry): Promise<void> {
  const sftp = entry.tab.data.sftp as { serverId?: string; remotePath?: string } | undefined;
  if (!sftp?.serverId || !sftp.remotePath) return;
  try {
    const st = await sftpStat(sftp.serverId, sftp.remotePath);
    entry.remoteStat = { size: st.size, mtime: st.mtime };
  } catch {
    entry.remoteStat = null; // 基线刷新失败：下次保存不检测，避免连环误报
  }
}

/** 三选一冲突弹窗：覆盖保存 / 重新加载 / 取消（复用全局 modal 样式） */
function conflictDialog(
  name: string, actualSize: number | null, actualMtime: number | null,
): Promise<'overwrite' | 'reload' | 'cancel'> {
  const { promise, resolve } = Promise.withResolvers<'overwrite' | 'reload' | 'cancel'>();
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:460px">
      <div class="modal-head"><h3>远端文件已被外部修改</h3></div>
      <div class="modal-body" style="color:var(--text-1);line-height:1.7">
        文件「<span class="cf-file"></span>」在编辑器打开期间被其他进程修改
        <span class="cf-stat"></span>。<br><br>
        继续保存会覆盖外部修改；重新加载会放弃当前未保存的编辑。
      </div>
      <div class="modal-foot">
        <button class="btn" data-act="reload">重新加载</button>
        <button class="btn" data-act="cancel">取消</button>
        <button class="btn danger-solid" data-act="overwrite">覆盖保存</button>
      </div>
    </div>`;
  mask.querySelector('.cf-file')!.textContent = name;
  const statParts: string[] = [];
  if (actualSize != null) statParts.push(`当前大小 ${actualSize} 字节`);
  if (actualMtime != null) statParts.push(`修改时间 ${new Date(actualMtime * 1000).toLocaleString()}`);
  mask.querySelector('.cf-stat')!.textContent = statParts.length ? `（${statParts.join('、')}）` : '';
  const close = (v: 'overwrite' | 'reload' | 'cancel'): void => {
    mask.remove();
    resolve(v);
  };
  mask.querySelectorAll<HTMLButtonElement>('button[data-act]').forEach((b) => {
    b.addEventListener('click', () => close(b.dataset.act as 'overwrite' | 'reload' | 'cancel'));
  });
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  return promise;
}

function markDirty(entry: EditorEntry): void {
  if (entry.loading) return;
  entry.dirty = true;
  entry.version += 1;
  setTabTitle(entry.tab.id, '● ' + entry.baseTitle);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void queueSave(entry, false);
  }, 800);
}

/* ---------- 异步载入：文档内容 + 语言高亮（一次性应用） ---------- */
/** skipIfSame：外部刷新用 —— 磁盘内容与当前文档一致时跳过，不打扰光标与撤销历史 */
async function loadFile(entry: EditorEntry, skipIfSame = false): Promise<void> {
  const path = String(entry.tab.data.path ?? '');
  const sftp = entry.tab.data.sftp as { serverId?: string; remotePath?: string } | undefined;
  let text = '';
  let ok = false;
  try {
    // 远端文件（SFTP 打开）读取走 sftp_read，否则本地 fs_read
    text = sftp?.serverId && sftp.remotePath
      ? await sftpRead(sftp.serverId, sftp.remotePath)
      : await fsRead(path);
    ok = true;
  } catch (err) {
    toast(String(err), 'error');
    // 载入失败：显示空文档（视图已为空）
  }
  if (skipIfSame && (!ok || entry.view.state.doc.toString() === text)) return;
  const name = path.split(/[\\/]/).pop() ?? '';
  const desc = LanguageDescription.matchFilename(languages, name);
  let langExt: Extension[] = [];
  if (desc) {
    try {
      langExt = [await desc.load()];
    } catch (err) {
      console.warn('编辑器语言载入失败，降级为纯文本:', err);
    }
  }
  entry.loading = true;
  try {
    entry.view.dispatch({
      changes: { from: 0, to: entry.view.state.doc.length, insert: text },
      effects: StateEffect.appendConfig.of(langExt),
    });
  } finally {
    entry.loading = false;
  }
}

/* ---------- 编辑器右键菜单：全选 / 复制 / 剪切 / 粘贴 / 添加到chat ---------- */
function showEditorMenu(x: number, y: number, entry: EditorEntry, path: string): void {
  const view = entry.view;
  const { from, to, empty } = view.state.selection.main;
  const hasSel = !empty && from !== to;
  const selText = hasSel ? view.state.sliceDoc(from, to) : '';

  showContextMenu(x, y, [
    { label: '全选', iconName: 'square', action: () => { view.focus(); selectAll(view); } },
    'sep',
    {
      label: '复制', iconName: 'copy', disabled: !hasSel, disabledTip: '请先框选一段文字',
      action: () => { void copyText(selText).then(() => toast('已复制', 'success')); },
    },
    {
      label: '剪切', iconName: 'scissors', disabled: !hasSel, disabledTip: '请先框选一段文字',
      action: () => {
        void copyText(selText).then(() => {
          view.dispatch({ changes: { from, to } });
          toast('已剪切', 'success');
        });
      },
    },
    {
      label: '删除', iconName: 'trash', danger: true, disabled: !hasSel, disabledTip: '请先框选一段文字',
      action: () => { view.dispatch({ changes: { from, to } }); },
    },
    {
      label: '粘贴', iconName: 'clipboard',
      action: () => {
        void navigator.clipboard.readText().then((text) => {
          const pos = view.state.selection.main.from;
          view.dispatch({
            changes: { from: pos, insert: text },
            selection: { anchor: pos + text.length },
          });
        }).catch(() => toast('读取剪贴板失败', 'error'));
      },
    },
    'sep',
    {
      label: '添加到chat', iconName: 'chatPlus', disabled: !hasSel, disabledTip: '请先框选一段文字',
      action: () => addCurrentSelectionToAI(view, path),
    },
  ]);
}

/** 取当前选区（菜单/Ctrl+L 共用入口）：无选区时提示 */
function addCurrentSelectionToAI(view: EditorView, path: string): boolean {
  const { from, to, empty } = view.state.selection.main;
  if (empty || from === to) {
    toast('请先框选一段文字', 'error');
    return false;
  }
  addSelectionToAI(view, path, from, to, view.state.sliceDoc(from, to));
  return true;
}

/** 选区 → @文件名_起始行_结束行号 标签（内容随标签压缩，发送时展开） */
function addSelectionToAI(view: EditorView, path: string, from: number, to: number, content: string): void {
  const doc = view.state.doc;
  const fromLine = doc.lineAt(from);
  let toLine = doc.lineAt(to);
  // 选区结束恰落在行首 → 不含该行内容
  if (to === toLine.from && toLine.number > fromLine.number) toLine = doc.line(toLine.number - 1);
  const ref: FileRef = {
    id: uid('ref'), path,
    startLine: fromLine.number, endLine: toLine.number,
    content, ts: Date.now(),
  };
  if (Workbench.ai?.addFileRef) {
    Workbench.ai.addFileRef(ref);
    toast('已添加到 AI 对话', 'success');
  } else {
    toast('AI 面板未就绪', 'error');
  }
}

/* ---------- 查找 / 替换（Ctrl+F / Ctrl+H，待优化 9） ----------
   复用 @codemirror/search 的查询状态、匹配高亮与 findNext/findPrevious/replaceNext/replaceAll 命令，
   面板换成中文 UI（顶部浮层）；替换产生 doc change，自动走既有脏标记/自动保存逻辑。 */

/** 匹配计数上限：超过显示 1000+，避免超大文档全量扫描卡顿（与 @codemirror/search 内部限制一致） */
const FIND_MATCH_CAP = 1000;
/** 面板实例登记：openFind 需要把 Ctrl+H 的替换态同步到已打开的实例 */
const findBars = new WeakMap<EditorView, FindBar>();

/** Ctrl+F / Ctrl+H 打开（已打开则聚焦）查找栏；withReplace 控制替换行展开 */
function openFind(view: EditorView, withReplace: boolean): void {
  openSearchPanel(view);
  findBars.get(view)?.setReplaceMode(withReplace);
}

class FindBar implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;
  pos = 0;

  private readonly view: EditorView;
  private query: SearchQuery;
  private matches: { from: number; to: number }[] = [];
  private truncated = false;
  private current = -1;

  private readonly searchInput: HTMLInputElement;
  private readonly replaceInput: HTMLInputElement;
  private readonly countEl: HTMLElement;
  private readonly caseBtn: HTMLButtonElement;
  private readonly wordBtn: HTMLButtonElement;
  private readonly replaceRow: HTMLElement;
  private readonly replaceToggleBtn: HTMLButtonElement;
  private readonly replaceBtn: HTMLButtonElement;
  private readonly replaceAllBtn: HTMLButtonElement;

  constructor(view: EditorView) {
    this.view = view;
    this.query = new SearchQuery(getSearchQuery(view.state));
    findBars.set(view, this);

    this.searchInput = this.makeInput('查找');
    this.searchInput.setAttribute('main-field', 'true'); // openSearchPanel 据此聚焦
    this.replaceInput = this.makeInput('替换为');

    this.countEl = document.createElement('span');
    this.countEl.className = 'ed-find-count';

    const iconBtn = (name: IconName, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'icon-btn';
      b.title = title;
      b.innerHTML = icon(name);
      b.addEventListener('click', onClick);
      return b;
    };
    const textBtn = (label: string, extra: string, title: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn small${extra ? ' ' + extra : ''}`;
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', onClick);
      return b;
    };

    const prevBtn = iconBtn('arrowUp', '上一项（Shift+Enter）', () => findPrevious(view));
    const nextBtn = iconBtn('arrowDown', '下一项（Enter）', () => findNext(view));
    const closeBtn = iconBtn('x', '关闭（Esc）', () => closeSearchPanel(view));

    this.caseBtn = textBtn('Aa', 'ed-find-toggle', '大小写敏感', () => {
      this.caseBtn.classList.toggle('active');
      this.commit();
    });
    this.wordBtn = textBtn('全词', 'ed-find-toggle', '全词匹配', () => {
      this.wordBtn.classList.toggle('active');
      this.commit();
    });

    // 替换行折叠/展开：查找输入框左侧的 chevron（>=折叠 / v=展开），与 Ctrl+H 等效
    this.replaceToggleBtn = iconBtn('chevronRight', '展开替换（Ctrl+H）', () => {
      this.setReplaceMode(this.replaceRow.classList.contains('hidden'));
    });

    this.replaceBtn = textBtn('替换', '', '替换当前匹配并跳到下一个（Enter）', () => this.doReplaceNext());
    this.replaceAllBtn = textBtn('全部替换', '', '替换全部匹配', () => this.doReplaceAll());

    this.replaceRow = document.createElement('div');
    this.replaceRow.className = 'ed-find-replace hidden';
    this.replaceRow.append(this.replaceInput, this.replaceBtn, this.replaceAllBtn);

    this.dom = document.createElement('div');
    this.dom.className = 'ed-findbar';
    const mainRow = document.createElement('div');
    mainRow.className = 'ed-find-row';
    mainRow.append(this.replaceToggleBtn, this.searchInput, this.countEl, prevBtn, nextBtn, this.caseBtn, this.wordBtn, closeBtn);
    this.dom.append(mainRow, this.replaceRow);

    // 输入即提交查询（含大小写/全词开关与替换串）；Enter/Shift+Enter 跳转、Esc 关闭并交还焦点给编辑器
    this.searchInput.addEventListener('input', () => this.commit());
    this.replaceInput.addEventListener('input', () => this.commit());
    [this.searchInput, this.replaceInput].forEach((input) => input.addEventListener('keydown', (e) => this.onKeydown(e)));

    this.syncReplaceButtons();
    this.recompute();
  }

  private makeInput(placeholder: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'ed-find-input';
    input.placeholder = placeholder;
    input.spellcheck = false;
    return input;
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchInput.value,
      caseSensitive: this.caseBtn.classList.contains('active'),
      wholeWord: this.wordBtn.classList.contains('active'),
      replace: this.replaceInput.value,
    });
    if (!query.eq(this.query)) {
      this.query = query;
      this.view.dispatch({ effects: setSearchQuery.of(query) });
    }
  }

  private onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.target === this.replaceInput) this.doReplaceNext();
      else if (e.shiftKey) findPrevious(this.view);
      else findNext(this.view);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // 避免再冒泡到编辑器 keymap 重复关闭
      closeSearchPanel(this.view);
    }
  }

  update(update: ViewUpdate): void {
    let queryChanged = false;
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.query = effect.value;
          this.syncFields();
          queryChanged = true;
        }
      }
    }
    if (update.state.readOnly !== update.startState.readOnly) this.syncReplaceButtons();
    if (queryChanged || update.docChanged) this.recompute();
    else if (update.selectionSet) this.updateCurrent();
  }

  mount(): void {
    this.searchInput.focus();
    this.searchInput.select();
  }

  destroy(): void {
    findBars.delete(this.view);
  }

  /** Ctrl+F 收起替换行 / Ctrl+H 或 chevron 按钮展开替换行，焦点跟随到对应输入框 */
  setReplaceMode(on: boolean): void {
    this.replaceRow.classList.toggle('hidden', !on);
    this.replaceToggleBtn.innerHTML = icon(on ? 'chevronDown' : 'chevronRight');
    this.replaceToggleBtn.title = on ? '收起替换' : '展开替换（Ctrl+H）';
    (on ? this.replaceInput : this.searchInput).focus();
  }

  private syncFields(): void {
    this.searchInput.value = this.query.search;
    this.replaceInput.value = this.query.replace;
    this.caseBtn.classList.toggle('active', this.query.caseSensitive);
    this.wordBtn.classList.toggle('active', this.query.wholeWord);
  }

  /** 全量重算匹配（查询/文档变更时）：供计数、当前项定位使用 */
  private recompute(): void {
    this.matches = [];
    this.truncated = false;
    if (this.query.valid) {
      const cursor = this.query.getCursor(this.view.state);
      for (let it = cursor.next(); !it.done; it = cursor.next()) {
        if (this.matches.length >= FIND_MATCH_CAP) { this.truncated = true; break; }
        this.matches.push({ from: it.value.from, to: it.value.to });
      }
    }
    this.updateCurrent();
  }

  /** 光标是否正落在某个匹配上（二分定位），并刷新 n/m 计数 */
  private updateCurrent(): void {
    const sel = this.view.state.selection.main;
    const arr = this.matches;
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].from < sel.from) lo = mid + 1; else hi = mid;
    }
    this.current = lo < arr.length && arr[lo].from === sel.from && arr[lo].to === sel.to ? lo : -1;
    this.renderCount();
  }

  private renderCount(): void {
    if (!this.query.search) { this.countEl.textContent = ''; return; }
    const total = this.matches.length;
    const suffix = this.truncated ? '+' : '';
    this.countEl.textContent = this.current >= 0
      ? `${this.current + 1}/${total}${suffix}`
      : `${total}${suffix} 处匹配`;
  }

  private doReplaceNext(): void {
    if (this.view.state.readOnly) return;
    if (!replaceNext(this.view)) toast('没有可替换的匹配项', 'info');
  }

  private doReplaceAll(): void {
    const view = this.view;
    if (view.state.readOnly) return;
    if (!this.query.valid) { toast('请先输入查找内容', 'info'); return; }
    // 先按与 replaceAll 相同的口径（仅精确匹配）统计数量，再执行
    let count = 0;
    const cursor = this.query.getCursor(view.state);
    for (let it = cursor.next(); !it.done; it = cursor.next()) {
      // @codemirror/search 的 d.ts 对 value 只声明 from/to，运行时恒带 precise 标志
      const v = it.value as { from: number; to: number; precise: boolean };
      if (v.precise) count++;
    }
    if (count === 0) { toast('没有可替换的匹配项', 'info'); return; }
    replaceAll(view);
    toast(`已替换 ${count} 处`, 'success');
  }

  /** 只读态（本编辑器暂不启用）时禁用替换按钮 */
  private syncReplaceButtons(): void {
    const ro = this.view.state.readOnly;
    this.replaceBtn.disabled = ro;
    this.replaceAllBtn.disabled = ro;
  }
}

/* ---------- 渲染器 ---------- */
registerRenderer('editor', (container, tab) => {
  const sftp = tab.data.sftp as { serverId?: string; remotePath?: string; stat?: { size: number; mtime: number } } | undefined;
  // 远端文件无本地 path：用远端路径承担文件名/语言/选区引用展示
  const path = String(tab.data.path ?? '') || (sftp?.remotePath ?? '');
  const name = path.split(/[\\/]/).pop() ?? '';
  const baseTitle = tab.title || name || '未命名';

  const root = document.createElement('div');
  root.className = 'ed-root';
  container.appendChild(root);

  const entry: EditorEntry = {
    tab, baseTitle,
    dirty: false, version: 0, timer: undefined,
    chain: Promise.resolve(), loading: false,
    view: undefined as unknown as EditorView,
    // 打开时快照：远端外部修改冲突检测基线（无快照 = 不检测）
    remoteStat: sftp?.stat ?? null,
    conflict: false,
    conflictDialogOpen: false,
  };

  entry.view = new EditorView({
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        indentUnit.of('  '),
        EditorState.tabSize.of(2),
        // Ctrl+S：立即保存（取消防抖计时器直接写）；Ctrl+L：框选内容添加到 AI 对话；
        // Ctrl+F/Ctrl+H：查找 / 替换（keymap 仅编辑器聚焦时生效，不干扰终端等全局快捷键）；Esc 关闭查找栏
        Prec.highest(keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => { void queueSave(entry, false, true); return true; },
          },
          {
            key: 'Mod-l',
            preventDefault: true,
            run: () => addCurrentSelectionToAI(entry.view, path),
          },
          {
            key: 'Mod-f',
            preventDefault: true,
            run: () => { openFind(entry.view, false); return true; },
          },
          {
            key: 'Mod-h',
            preventDefault: true,
            run: () => { openFind(entry.view, true); return true; },
          },
          {
            key: 'Escape',
            run: () => {
              if (!searchPanelOpen(entry.view.state)) return false;
              closeSearchPanel(entry.view);
              return true;
            },
          },
        ])),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        cmTheme.of(cmThemeExt()),
        // 查找/替换面板：top 浮层 + 中文面板（FindBar）；查询状态/高亮/跳转/替换复用 @codemirror/search
        search({ top: true, createPanel: (view) => new FindBar(view) }),
        EditorView.updateListener.of((update) => { if (update.docChanged) markDirty(entry); }),
      ],
    }),
    parent: root,
  });

  entries.set(tab.id, entry);

  /* 自定义右键菜单：替换浏览器默认菜单（全选/复制/剪切/粘贴/添加到chat） */
  entry.view.dom.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showEditorMenu(e.clientX, e.clientY, entry, path);
  });

  // 链式保留打开方传入的 onClose：先静默落盘未保存缓冲，再放行（原型语义）
  const originalOnClose = tab.onClose;
  tab.onClose = (t: Tab): void => {
    void (async () => {
      if (entry.dirty && !entry.conflict) {
        try { await queueSave(entry, true); } catch { /* 错误已 toast，仍放行关闭 */ }
      } else if (entry.dirty && entry.conflict) {
        // 远端已被外部修改且未处理：不覆盖外部修改，也不弹窗打断关闭流程
        toast(`「${entry.baseTitle}」远端已被外部修改，更改未保存`, 'info');
      }
      originalOnClose?.(t);
    })();
  };

  void loadFile(entry);

  return {
    getPath: () => path,
    getValue: () => entry.view.state.doc.toString(),
    save: () => queueSave(entry, false),
  };
});

/* ---------- 关闭标签：销毁视图并清理（对应原型 bus.on('tab-closed') 的静默落盘位，落盘已上移到 onClose） ---------- */
bus.on('tab-closed', (tab) => {
  if (!tab) return;
  const entry = entries.get(tab.id);
  if (!entry) return;
  entries.delete(tab.id);
  entry.view.destroy();
});

/* ---------- 外部修改同步：AI write/edit 落盘（fs:changed）后刷新同路径标签 ---------- */
void onFsChanged((changedPath) => {
  const changedKey = filePathKey(changedPath);
  entries.forEach((entry) => {
    if (entry.tab.data.sftp) return; // 远端文件无本地路径，不参与本地 fs:changed
    const path = String(entry.tab.data.path ?? '');
    if (filePathKey(path) !== changedKey) return;
    if (entry.dirty) {
      // 本地有未保存改动：不覆盖用户输入，仅提示手动处理
      toast(`「${entry.baseTitle}」已被 AI 修改，但本地有未保存改动，已保留你的编辑`, 'info');
      return;
    }
    void loadFile(entry, true);
  });
}).catch((err) => {
  console.warn('订阅 fs:changed 失败:', err);
});
