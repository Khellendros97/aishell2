/**
 * 笔记标签页(React 版,新建) —— markdown 笔记的编辑/预览双模式。
 * 对照 .proto 无直接原型(新功能);保存链与编辑器行为照 EditorTab 简化版
 * (本地 fsWrite 单一后端、无 SFTP 冲突检测/暂存/查找栏):
 *   - 编辑:CodeMirror,markdown 语言经 @codemirror/language-data 异步 load(与 EditorTab 同源);
 *     主题复用 EditorTab 导出的 reconfigureTheme(共享 cmTheme compartment,全局主题切换联动);
 *   - 预览:MarkdownIt({html:false, breaks:true, linkify:true}) + link_open target=_blank
 *     (配置抄 ai-engine.ts:429);切到预览前先把未保存内容落盘;
 *   - 脏标记 ● + 800ms 防抖自动保存 + Ctrl+S + 关闭时静默落盘;
 *   - onFsChanged 模块级订阅:同路径无脏改动重载,有脏改动 toast 提示(照 EditorTab.tsx:882)。
 * keep-alive 契约:effect 依赖 [tab.id](硬约束 9:tab 对象引用会被 setTabTitle 换,不可作依赖)。
 * 接口点:fs_read / fs_write / fs:changed;外部入口 openNote(tab id = note:<path> 去重激活)。
 */
import { useEffect, useRef, useState } from 'react';
import { EditorState, Prec, StateEffect, type Extension } from '@codemirror/state';
import { EditorView, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { LanguageDescription, indentUnit } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import MarkdownIt from 'markdown-it';
import { fsRead, fsWrite, onFsChanged } from '../../../api';
import { toast } from '../../../ui';
import { useWorkbench, tabApis, type Tab, type TabProps } from '../../../stores/workbench';
import { onThemeChange } from '../../../theme';
import { Icon } from '../../../shared/Icon';
import { reconfigureTheme, editorCmThemeExt } from './EditorTab';
import './note.css';

/* Markdown 预览渲染器:配置抄 ai-engine.ts(html:false 转义原始 HTML 防 XSS,
   breaks 保留单换行;外链 target=_blank 由系统浏览器打开) */
const md = new MarkdownIt({ html: false, breaks: true, linkify: true, typographer: false });
const defaultLinkOpen = md.renderer.rules.link_open
  ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/** 单个笔记标签的运行状态(简化版 EditorEntry:只走本地 fsWrite) */
interface NoteEntry {
  tab: Tab;
  path: string;
  baseTitle: string;
  dirty: boolean;
  version: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  chain: Promise<void>;
  loading: boolean;
  view: EditorView;
  /** 预览内容版本递增(React 重渲预览区) */
  notifyContent: () => void;
}

/** 已打开的笔记标签登记:fs:changed 外部刷新用 */
const entries = new Map<string, NoteEntry>();

/** Windows 路径比较键(与 EditorTab filePathKey 同规则) */
function filePathKey(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

/** 保存:防抖自动保存 / Ctrl+S / 关闭落盘共用,写盘串行化(只走 fsWrite) */
function queueSave(entry: NoteEntry, silent: boolean): Promise<void> {
  clearTimeout(entry.timer);
  entry.timer = undefined;
  const content = entry.view.state.doc.toString();
  const version = entry.version;
  const run = entry.chain.then(() => fsWrite(entry.path, content));
  entry.chain = run.catch(() => undefined);
  return run.then(
    () => {
      if (entry.version === version) {
        entry.dirty = false;
        useWorkbench.getState().setTabTitle(entry.tab.id, entry.baseTitle);
      }
      if (!silent) toast('已自动保存', 'success');
    },
    (err: unknown) => toast(String(err), 'error'),
  );
}

function markDirty(entry: NoteEntry): void {
  if (entry.loading) return;
  entry.dirty = true;
  entry.version += 1;
  useWorkbench.getState().setTabTitle(entry.tab.id, '● ' + entry.baseTitle);
  clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    void queueSave(entry, false);
  }, 800);
}

/** 异步载入:文档内容 + markdown 语言高亮(一次性应用);skipIfSame 供外部刷新 */
async function loadNote(entry: NoteEntry, skipIfSame = false): Promise<void> {
  let text = '';
  let ok = false;
  try {
    text = await fsRead(entry.path);
    ok = true;
  } catch (err) {
    toast(String(err), 'error');
  }
  if (skipIfSame && (!ok || entry.view.state.doc.toString() === text)) return;
  const name = entry.path.split(/[\\/]/).pop() ?? '';
  const desc = LanguageDescription.matchFilename(languages, name);
  let langExt: Extension[] = [];
  if (desc) {
    try {
      langExt = [await desc.load()];
    } catch (err) {
      console.warn('笔记语言载入失败，降级为纯文本:', err);
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
  entry.notifyContent();
}

export function NoteTab({ tab }: TabProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<NoteEntry | null>(null);
  const [mode, setMode] = useState<'edit' | 'preview'>('edit');
  const [, setContentVersion] = useState(0);

  /* keep-alive:CodeMirror 实例生命周期 = 组件挂载/卸载;effect 依赖 tab.id(硬约束 9) */
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const path = String(tab.data.path ?? '');
    const name = path.split(/[\\/]/).pop() ?? '笔记';
    const entry: NoteEntry = {
      tab, path, baseTitle: tab.title || name,
      dirty: false, version: 0, timer: undefined,
      chain: Promise.resolve(), loading: false,
      view: undefined as unknown as EditorView,
      notifyContent: () => setContentVersion((v) => v + 1),
    };
    entryRef.current = entry;
    entries.set(tab.id, entry);

    entry.view = new EditorView({
      state: EditorState.create({
        doc: '',
        extensions: [
          lineNumbers(),
          highlightActiveLine(),
          history(),
          indentUnit.of('  '),
          EditorState.tabSize.of(2),
          Prec.highest(keymap.of([
            {
              key: 'Mod-s', preventDefault: true,
              run: () => { void queueSave(entry, false); return true; },
            },
          ])),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          /* 主题:复用 EditorTab 共享 cmTheme compartment(全局切换经 reconfigureTheme 联动) */
          editorCmThemeExt(),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              markDirty(entry);
              entry.notifyContent();
            }
          }),
        ],
      }),
      parent: root,
    });

    tabApis.set(tab.id, {
      getPath: () => entry.path,
      getValue: () => entry.view.state.doc.toString(),
      save: () => queueSave(entry, false),
    });

    /* 关闭时静默落盘(链式保留打开方 onClose,语义同 EditorTab) */
    const originalOnClose = tab.onClose;
    tab.onClose = (t: Tab): void => {
      void (async () => {
        if (entry.dirty) {
          try { await queueSave(entry, true); } catch { /* 错误已 toast,仍放行关闭 */ }
        }
        originalOnClose?.(t);
      })();
    };

    const offTheme = onThemeChange(() => reconfigureTheme(entry.view));
    void loadNote(entry);

    return () => {
      clearTimeout(entry.timer);
      offTheme();
      entry.view.destroy();
      entries.delete(tab.id);
      tabApis.delete(tab.id);
      entryRef.current = null;
    };
    // tab 对象在标签存活期内 id/data 稳定;依赖只取 tab.id(硬约束 9)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id]);

  /* 切换到预览:先把未保存内容落盘(保证预览与磁盘一致) */
  const switchMode = (next: 'edit' | 'preview'): void => {
    const entry = entryRef.current;
    if (next === 'preview' && entry?.dirty) void queueSave(entry, true);
    setMode(next);
  };

  const previewHtml = mode === 'preview'
    ? md.render(entryRef.current?.view.state.doc.toString() ?? '')
    : '';

  return (
    <div className="note-root">
      <div className="note-toolbar">
        <div className="note-mode-switch">
          <button
            className={`btn small${mode === 'edit' ? ' primary' : ''}`}
            onClick={() => switchMode('edit')}
          ><Icon name="pencil" /> 编辑</button>
          <button
            className={`btn small${mode === 'preview' ? ' primary' : ''}`}
            onClick={() => switchMode('preview')}
          ><Icon name="eye" /> 预览</button>
        </div>
        <span className="note-path ellipsis" title={String(tab.data.path ?? '')}>
          {String(tab.data.path ?? '')}
        </span>
      </div>
      <div className={`note-editor${mode === 'edit' ? '' : ' hidden'}`} ref={rootRef} />
      {mode === 'preview' && (
        <div className="note-md" dangerouslySetInnerHTML={{ __html: previewHtml }} />
      )}
    </div>
  );
}

/* ---------- 外部入口 ---------- */
/** 打开笔记标签页:tab id = note:<path>,同路径去重激活(照 EditorTab openLocalFile 模式) */
export function openNote(path: string, name?: string): Tab | null {
  const display = name ?? path.split(/[\\/]/).pop() ?? path;
  return useWorkbench.getState().openTab({
    id: `note:${path}`,
    type: 'note',
    title: display,
    data: { path, name: display },
  });
}

/* ---------- 外部修改同步:AI write/edit 落盘(fs:changed)后刷新同路径标签 ---------- */
void onFsChanged((changedPath) => {
  const changedKey = filePathKey(changedPath);
  entries.forEach((entry) => {
    if (filePathKey(entry.path) !== changedKey) return;
    if (entry.dirty) {
      toast(`「${entry.baseTitle}」已被外部修改，但本地有未保存改动，已保留你的编辑`, 'info');
      return;
    }
    void loadNote(entry, true);
  });
}).catch((err) => {
  console.warn('订阅 fs:changed 失败:', err);
});
