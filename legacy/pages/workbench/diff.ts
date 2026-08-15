/**
 * 暂存 diff 标签（'staging-diff'）—— 只读展示某暂存条目「首次快照 vs 当前」：
 * 文本文件 → 左右两个只读 CodeMirror（左 = 快照，右 = 当前；删除/新增行高亮，复用 editor.ts
 * 主题与只读初始化，不新增 @codemirror/merge 依赖）；二进制/超大 → hash/size/mtime 元数据对比。
 * 'staging-changed' 广播时刷新（接受/还原/AI 工具完成后）。
 */
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
import { stagingDiff, stagingList } from '../../api';
import type { DiffLine, StagedFile, StagingDiff } from '../../types';
import { icon } from '../../icons';
import { toast } from '../../ui';
import { bus, registerRenderer, type Tab } from './core';
import { createReadonlyView } from './editor';
import './diff.css';

const delLineDeco = Decoration.line({ class: 'sd-line-del' });
const addLineDeco = Decoration.line({ class: 'sd-line-add' });

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtSize(size: number | null): string {
  if (size == null) return '-';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fmtMtime(m: number | null): string {
  if (!m) return '-';
  const d = new Date(m * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function metaRow(label: string, sha: string | null, size: number | null, mtime: number | null): string {
  return `<div class="sd-meta-row"><span class="sd-meta-label">${escapeHtml(label)}</span><code>sha256=${escapeHtml(sha ?? '-')}</code><span>${fmtSize(size)}</span><span>mtime=${escapeHtml(fmtMtime(mtime))}</span></div>`;
}

/** 单侧只读编辑器：按行构建文档并给 del/add 行加背景高亮。
 *  CodeMirror 行装饰（Decoration.line）要求零长度范围：在行首 pos 处 add(pos, pos, deco)。 */
function buildSide(parent: HTMLElement, lines: DiffLine[], highlightKind: 'del' | 'add'): EditorView {
  const text = lines.map((l) => l.text).join('\n');
  const view = createReadonlyView(parent, text);
  const builder = new RangeSetBuilder<Decoration>();
  let pos = 0;
  for (const l of lines) {
    if (l.kind === highlightKind) {
      builder.add(pos, pos, highlightKind === 'del' ? delLineDeco : addLineDeco);
    }
    pos += l.text.length + 1; // 跳过换行
  }
  view.dispatch({
    effects: StateEffect.appendConfig.of(EditorView.decorations.of(builder.finish())),
  });
  return view;
}

/** 打开的 diff 视图按 tab id 登记（标签关闭时销毁） */
const viewsByTab = new Map<string, EditorView[]>();

registerRenderer('staging-diff', (container, tab) => {
  const data = tab.data as { projectId: string; sessionId: string; entryId: string };
  let entry: StagedFile | null = null;

  container.innerHTML = `
    <div class="sd-panel">
      <div class="sd-head">
        <span class="sd-title">${icon('diff')} 暂存 diff</span>
        <button class="btn small" data-sd-refresh title="刷新">${icon('refresh')} 刷新</button>
      </div>
      <div class="sd-meta" data-sd-meta></div>
      <div class="sd-body"><div class="sd-loading">加载中…</div></div>
    </div>
  `;
  const bodyEl = container.querySelector('.sd-body') as HTMLElement;
  const metaEl = container.querySelector('.sd-meta') as HTMLElement;

  function clearViews(): void {
    (viewsByTab.get(tab.id) ?? []).forEach((v) => v.destroy());
    viewsByTab.delete(tab.id);
  }

  function render(d: StagingDiff): void {
    const name = entry?.remotePath.split('/').filter(Boolean).pop() ?? '暂存条目';
    const stateText = entry
      ? `${entry.remotePath}（${entry.originalState === 'absent' ? '原始不存在' : '原始已存在'} → 当前${entry.currentState === 'absent' ? '已不存在' : '存在'}）`
      : '（条目已不存在——可能已被接受）';
    metaEl.innerHTML = `
      <span class="sd-path" title="${escapeHtml(entry?.remotePath ?? '')}">${escapeHtml(name)}</span>
      <span class="sd-state">${escapeHtml(stateText)}</span>
      ${d.snapshotAbsent ? '<span class="sd-badge sd-badge-del">快照侧：文件不存在</span>' : ''}
      ${d.currentAbsent ? '<span class="sd-badge sd-badge-del">当前侧：文件已删除</span>' : ''}
    `;
    if (d.meta) {
      // 二进制/超大：只展示元数据，不把原文返回前端
      bodyEl.innerHTML = `
        <div class="sd-binary-note">${icon('info')} 文件为二进制或超过编辑上限，无法显示文本 diff：</div>
        <div class="sd-meta-table">
          ${metaRow('首次快照', d.meta.snapshot.sha256, d.meta.snapshot.size, d.meta.snapshot.mtime)}
          ${metaRow('当前', d.meta.current.sha256, d.meta.current.size, d.meta.current.mtime)}
        </div>`;
      return;
    }
    bodyEl.innerHTML = `
      <div class="sd-sides">
        <div class="sd-side">
          <div class="sd-side-head">${icon('arrowLeft')} 首次快照${d.snapshotAbsent ? '（不存在）' : ''}</div>
          <div class="sd-side-editor" data-sd-left></div>
        </div>
        <div class="sd-side">
          <div class="sd-side-head">当前内容${d.currentAbsent ? '（已删除）' : ''} ${icon('arrowRight')}</div>
          <div class="sd-side-editor" data-sd-right></div>
        </div>
      </div>`;
    clearViews();
    const leftEl = bodyEl.querySelector('[data-sd-left]') as HTMLElement;
    const rightEl = bodyEl.querySelector('[data-sd-right]') as HTMLElement;
    const left = d.snapshotAbsent ? [] : d.left;
    const right = d.currentAbsent ? [] : d.right;
    const lv = buildSide(leftEl, left, 'del');
    const rv = buildSide(rightEl, right, 'add');
    viewsByTab.set(tab.id, [lv, rv]);
  }

  async function load(): Promise<void> {
    try {
      const entries = await stagingList(data.projectId, data.sessionId);
      entry = entries.find((e) => e.entryId === data.entryId) ?? null;
      const d = await stagingDiff(data.projectId, data.sessionId, data.entryId);
      render(d);
    } catch (err) {
      bodyEl.innerHTML = `<div class="sd-loading error">${escapeHtml(String(err))}</div>`;
    }
  }

  container.querySelector('[data-sd-refresh]')!.addEventListener('click', () => void load());
  const offStaging = bus.on('staging-changed', () => { if (container.isConnected) void load(); });
  const origOnClose = tab.onClose;
  tab.onClose = (t: Tab): void => {
    clearViews();
    offStaging();
    origOnClose?.(t);
  };

  void load().catch((err) => toast(`暂存 diff 加载失败：${String(err)}`, 'error'));
});
