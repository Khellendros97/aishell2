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
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { LanguageDescription, indentUnit } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { oneDark } from '@codemirror/theme-one-dark';
import { fsRead, fsWrite } from '../../api';
import { toast } from '../../ui';
import { bus, registerRenderer, setTabTitle, type Tab } from './core';
import { currentTheme, onThemeChange } from '../../theme';
import './editor.css';

/* CodeMirror 主题随全局主题切换:Compartment 运行时重配,亮色用 CM 默认亮色(样式见 editor.css) */
const cmTheme = new Compartment();
const cmThemeExt = () => (currentTheme() === 'dark' ? oneDark : []);
onThemeChange(() => {
  entries.forEach((e) => e.view.dispatch({ effects: cmTheme.reconfigure(cmThemeExt()) }));
});

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

/* ---------- 保存：防抖自动保存与 Ctrl+S / 关闭落盘共用，写盘串行化 ---------- */
function queueSave(entry: EditorEntry, silent: boolean): Promise<void> {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  const path = String(entry.tab.data.path ?? '');
  const content = entry.view.state.doc.toString();
  const version = entry.version;
  const run = entry.chain.then(() => fsWrite(path, content));
  entry.chain = run.catch(() => undefined); // 失败不阻断后续写盘
  return run.then(
    () => {
      // 写盘完成时文档未被继续修改 → 去脏并还原标题
      if (entry.version === version) {
        entry.dirty = false;
        setTabTitle(entry.tab.id, entry.baseTitle);
      }
      if (!silent) toast('已自动保存', 'success');
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
async function loadFile(entry: EditorEntry): Promise<void> {
  const path = String(entry.tab.data.path ?? '');
  let text = '';
  try {
    text = await fsRead(path);
  } catch (err) {
    toast(String(err), 'error');
    // 载入失败：显示空文档（视图已为空）
  }
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

/* ---------- 渲染器 ---------- */
registerRenderer('editor', (container, tab) => {
  const path = String(tab.data.path ?? '');
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
        // Ctrl+S：立即保存（取消防抖计时器直接写）
        Prec.highest(keymap.of([{
          key: 'Mod-s',
          preventDefault: true,
          run: () => { void queueSave(entry, false); return true; },
        }])),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        cmTheme.of(cmThemeExt()),
        EditorView.updateListener.of((update) => { if (update.docChanged) markDirty(entry); }),
      ],
    }),
    parent: root,
  });

  entries.set(tab.id, entry);

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
