/**
 * 工作台编辑器模块 —— 注册 'editor' 标签渲染器（CodeMirror 6）。
 * 移植自 .proto/workbench-editor.js：
 *   - 脏标记 ● / 800ms 防抖自动保存 / Ctrl+S 立即保存 / 关闭时静默落盘
 *   - 语法高亮改用 @codemirror/language-data 按文件名/扩展名匹配（不可识别为纯文本）
 *   - 数据源为真实 fs_read / fs_write（后端 fsops），载入失败 toast 错误原文并显示空文档
 * import 即完成注册（副作用），由 workbench.ts 引入。
 */
import { EditorState, Prec, StateEffect, Compartment, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, selectAll } from '@codemirror/commands';
import { HighlightStyle, LanguageDescription, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { tags } from '@lezer/highlight';
import { oneDarkTheme } from '@codemirror/theme-one-dark';
import { fsRead, fsWrite, onFsChanged, sftpRead, sftpWrite } from '../../api';
import { copyText, showContextMenu, toast, uid } from '../../ui';
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
function queueSave(entry: EditorEntry, silent: boolean): Promise<void> {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  const path = String(entry.tab.data.path ?? '');
  const sftp = entry.tab.data.sftp as { serverId?: string; remotePath?: string } | undefined;
  const remote = Boolean(sftp?.serverId && sftp.remotePath);
  const content = entry.view.state.doc.toString();
  const version = entry.version;
  // 远端文件（SFTP 打开）保存走 sftp_write，否则本地 fs_write
  const run = remote
    ? entry.chain.then(() => sftpWrite(sftp!.serverId!, sftp!.remotePath!, content))
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
      // 失败：toast 错误原文，保留脏标
      toast(String(err), 'error');
    },
  );
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
    { label: '全选', iconName: 'square', action: () => selectAll(view) },
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

/* ---------- 渲染器 ---------- */
registerRenderer('editor', (container, tab) => {
  const sftp = tab.data.sftp as { serverId?: string; remotePath?: string } | undefined;
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
        // Ctrl+S：立即保存（取消防抖计时器直接写）；Ctrl+L：框选内容添加到 AI 对话
        Prec.highest(keymap.of([
          {
            key: 'Mod-s',
            preventDefault: true,
            run: () => { void queueSave(entry, false); return true; },
          },
          {
            key: 'Mod-l',
            preventDefault: true,
            run: () => addCurrentSelectionToAI(entry.view, path),
          },
        ])),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        cmTheme.of(cmThemeExt()),
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
      if (entry.dirty) {
        try { await queueSave(entry, true); } catch { /* 错误已 toast，仍放行关闭 */ }
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
