/**
 * 暂存 diff 标签页('staging-diff',React 版)。
 * 对照 legacy/pages/workbench/diff.ts(由 .proto 的暂存面板衍生,无独立原型页)逐条迁移:
 *   - 只读展示某暂存条目「首次快照 vs 当前」:文本文件 → 左右两个只读 CodeMirror
 *     (左 = 快照,右 = 当前;删除/新增行高亮,复用 EditorTab 的 createReadonlyView,
 *     不新增 @codemirror/merge 依赖);二进制/超大 → hash/size/mtime 元数据对比;
 *   - 'staging-changed' 广播时刷新(接受/还原/AI 工具完成后)。
 * 与后端的接口点:staging_list / staging_diff。
 * 相对 legacy 的修复:
 *   - 只读视图主题现在随全局切换自动重配(legacy 的 onThemeChange 只重配编辑器标签,
 *     createReadonlyView 的 compart 从不刷新,与 editor.ts 注释声称的行为不符);
 *   - 文本 → 元数据 切换时销毁旧 CodeMirror 视图(legacy 只销毁了再重建的路径,
 *     走 meta 分支时视图随 innerHTML 替换脱离 DOM 但未 destroy,泄漏);
 *   - 载入加序号守卫,快速连续刷新(手动 + staging-changed)时旧响应不覆盖新结果。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { stagingDiff, stagingList } from '../../../api';
import type { DiffLine, StagedFile, StagingDiff } from '../../../types';
import { toast } from '../../../ui';
import { wbEvents, type TabProps } from '../../../stores/workbench';
import { onThemeChange } from '../../../theme';
import { Icon } from '../../../shared/Icon';
import { createReadonlyView, reconfigureTheme } from './EditorTab';
import '../diff.css';

const delLineDeco = Decoration.line({ class: 'sd-line-del' });
const addLineDeco = Decoration.line({ class: 'sd-line-add' });
const gapLineDeco = Decoration.line({ class: 'sd-line-gap' });
const DIFF_CONTEXT_LINES = 3;
const MIN_FOLDED_LINES = 4;

interface DisplayLine {
  text: string;
  kind: DiffLine['kind'] | 'gap' | 'fold';
  lineNo: number | null;
  foldId?: string;
}

interface DiffGrid {
  left: DisplayLine[];
  right: DisplayLine[];
}

interface FoldedGrid extends DiffGrid {
  foldIds: string[];
}

/** 以双方 ctx 行为锚点，将每个增删块顶端对齐，较短一侧用不占原文件行号的空行补齐。 */
function alignDiffLines(left: DiffLine[], right: DiffLine[]): DiffGrid {
  const grid: DiffGrid = { left: [], right: [] };
  let leftIndex = 0;
  let rightIndex = 0;
  let leftLineNo = 1;
  let rightLineNo = 1;
  const append = (target: DisplayLine[], line: DiffLine | undefined, lineNo: number): void => {
    target.push(line
      ? { text: line.text, kind: line.kind, lineNo }
      : { text: '', kind: 'gap', lineNo: null });
  };

  while (leftIndex < left.length || rightIndex < right.length) {
    const leftLine = left[leftIndex];
    const rightLine = right[rightIndex];
    if (leftLine?.kind === 'ctx' && rightLine?.kind === 'ctx') {
      append(grid.left, leftLine, leftLineNo++);
      append(grid.right, rightLine, rightLineNo++);
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    const leftStart = leftIndex;
    const rightStart = rightIndex;
    while (leftIndex < left.length && left[leftIndex].kind !== 'ctx') leftIndex += 1;
    while (rightIndex < right.length && right[rightIndex].kind !== 'ctx') rightIndex += 1;
    const blockLength = Math.max(leftIndex - leftStart, rightIndex - rightStart);
    for (let offset = 0; offset < blockLength; offset += 1) {
      const leftChange = left[leftStart + offset];
      const rightChange = right[rightStart + offset];
      append(grid.left, leftChange, leftLineNo);
      append(grid.right, rightChange, rightLineNo);
      if (leftChange) leftLineNo += 1;
      if (rightChange) rightLineNo += 1;
    }
  }
  return grid;
}

function foldUnchangedLines(grid: DiffGrid, expanded: ReadonlySet<string>): FoldedGrid {
  const folded: FoldedGrid = { left: [], right: [], foldIds: [] };
  let index = 0;
  const appendRange = (start: number, end: number): void => {
    folded.left.push(...grid.left.slice(start, end));
    folded.right.push(...grid.right.slice(start, end));
  };

  while (index < grid.left.length) {
    if (grid.left[index].kind !== 'ctx' || grid.right[index].kind !== 'ctx') {
      appendRange(index, index + 1);
      index += 1;
      continue;
    }

    const start = index;
    while (index < grid.left.length
      && grid.left[index].kind === 'ctx'
      && grid.right[index].kind === 'ctx') index += 1;
    const end = index;
    const wholeFile = start === 0 && end === grid.left.length;
    const leadingContext = start === 0 && !wholeFile ? 0 : DIFF_CONTEXT_LINES;
    const trailingContext = end === grid.left.length && !wholeFile ? 0 : DIFF_CONTEXT_LINES;
    const hiddenStart = Math.min(end, start + leadingContext);
    const hiddenEnd = Math.max(hiddenStart, end - trailingContext);
    const hiddenCount = hiddenEnd - hiddenStart;
    if (hiddenCount < MIN_FOLDED_LINES) {
      appendRange(start, end);
      continue;
    }

    const leftStart = grid.left[hiddenStart].lineNo;
    const leftEnd = grid.left[hiddenEnd - 1].lineNo;
    const rightStart = grid.right[hiddenStart].lineNo;
    const rightEnd = grid.right[hiddenEnd - 1].lineNo;
    const foldId = `${leftStart}-${leftEnd}:${rightStart}-${rightEnd}`;
    if (expanded.has(foldId)) {
      appendRange(start, end);
      continue;
    }

    appendRange(start, hiddenStart);
    const text = `展开 ${hiddenCount} 行未变化内容`;
    folded.left.push({ text, kind: 'fold', lineNo: null, foldId });
    folded.right.push({ text, kind: 'fold', lineNo: null, foldId });
    folded.foldIds.push(foldId);
    appendRange(hiddenEnd, end);
  }
  return folded;
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

/* 元数据对比行:React 自带转义,不再需要 legacy 的 escapeHtml */
function metaRow(label: string, sha: string | null, size: number | null, mtime: number | null): JSX.Element {
  return (
    <div className="sd-meta-row">
      <span className="sd-meta-label">{label}</span>
      <code>sha256={sha ?? '-'}</code>
      <span>{fmtSize(size)}</span>
      <span>mtime={fmtMtime(mtime)}</span>
    </div>
  );
}

class FoldWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly foldId: string,
    private readonly onExpand: (foldId: string) => void,
  ) {
    super();
  }

  eq(other: FoldWidget): boolean {
    return other.text === this.text && other.foldId === this.foldId;
  }

  toDOM(): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sd-fold-button';
    button.textContent = `⋯ ${this.text}`;
    button.addEventListener('click', () => this.onExpand(this.foldId));
    return button;
  }

}

/** 单侧只读编辑器:按对齐后的网格构建文档，gutter 显示原文件行号，占位行留空。 */
function buildSide(
  parent: HTMLElement,
  lines: DisplayLine[],
  highlightKind: 'del' | 'add',
  onExpand: (foldId: string) => void,
): EditorView {
  const text = lines.map((line) => line.text).join('\n');
  const view = createReadonlyView(parent, text, (displayLineNo) => {
    const lineNo = lines[displayLineNo - 1]?.lineNo;
    return lineNo == null ? '' : String(lineNo);
  });
  const builder = new RangeSetBuilder<Decoration>();
  let pos = 0;
  for (const line of lines) {
    if (line.kind === highlightKind) {
      builder.add(pos, pos, highlightKind === 'del' ? delLineDeco : addLineDeco);
    } else if (line.kind === 'gap') {
      builder.add(pos, pos, gapLineDeco);
    } else if (line.kind === 'fold' && line.foldId) {
      builder.add(pos, pos + line.text.length, Decoration.replace({
        widget: new FoldWidget(line.text, line.foldId, onExpand),
      }));
    }
    pos += line.text.length + 1;
  }
  view.dispatch({
    effects: StateEffect.appendConfig.of(EditorView.decorations.of(builder.finish())),
  });
  return view;
}

/** 只联动垂直方向；requestAnimationFrame 合并连续滚动事件，写入守卫防止事件回环。 */
function syncVerticalScroll(left: EditorView, right: EditorView): () => void {
  let frame: number | null = null;
  let syncing: EditorView | null = null;
  const bind = (source: EditorView, target: EditorView): (() => void) => {
    const onScroll = (): void => {
      if (syncing === source) {
        syncing = null;
        return;
      }
      if (frame !== null) cancelAnimationFrame(frame);
      const scrollTop = source.scrollDOM.scrollTop;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (Math.abs(target.scrollDOM.scrollTop - scrollTop) < 1) return;
        syncing = target;
        target.scrollDOM.scrollTop = scrollTop;
      });
    };
    source.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    return () => source.scrollDOM.removeEventListener('scroll', onScroll);
  };
  const offLeft = bind(left, right);
  const offRight = bind(right, left);
  return () => {
    offLeft();
    offRight();
    if (frame !== null) cancelAnimationFrame(frame);
  };
}

export function DiffTab({ tab, active: _active }: TabProps): JSX.Element {
  const data = tab.data as { projectId: string; sessionId: string; entryId: string };
  const [entry, setEntry] = useState<StagedFile | null>(null);
  const [diff, setDiff] = useState<StagingDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedFolds, setExpandedFolds] = useState<Set<string>>(() => new Set());
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const viewsRef = useRef<EditorView[]>([]);
  const scrollCleanupRef = useRef<() => void>(() => undefined);
  /* 载入序号守卫:快速连续刷新时丢弃过期响应(legacy 无此守卫) */
  const loadSeqRef = useRef(0);

  /* 载入:条目 + diff;失败在 body 显示错误(同 legacy 的 sd-loading.error),
     diff 为 null 且无错误时显示「加载中…」(仅初次),刷新期间保留旧内容 */
  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeqRef.current;
    try {
      const entries = await stagingList(data.projectId, data.sessionId);
      const e = entries.find((it) => it.entryId === data.entryId) ?? null;
      const d = await stagingDiff(data.projectId, data.sessionId, data.entryId);
      if (seq !== loadSeqRef.current) return; // 已有更新的载入发起,丢弃本次结果
      setEntry(e);
      setExpandedFolds(new Set());
      setDiff(d);
      setError(null);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setError(String(err));
    }
  }, [data.projectId, data.sessionId, data.entryId]);

  const fullGrid = useMemo(() => {
    if (!diff || diff.meta) return null;
    return alignDiffLines(
      diff.snapshotAbsent ? [] : diff.left,
      diff.currentAbsent ? [] : diff.right,
    );
  }, [diff]);
  const displayGrid = useMemo(
    () => fullGrid ? foldUnchangedLines(fullGrid, expandedFolds) : null,
    [expandedFolds, fullGrid],
  );
  const defaultFoldIds = useMemo(
    () => fullGrid ? foldUnchangedLines(fullGrid, new Set()).foldIds : [],
    [fullGrid],
  );
  const allExpanded = defaultFoldIds.length > 0
    && defaultFoldIds.every((foldId) => expandedFolds.has(foldId));
  const expandFold = useCallback((foldId: string): void => {
    setExpandedFolds((current) => {
      const next = new Set(current);
      next.add(foldId);
      return next;
    });
  }, []);

  /* 文本 diff:按 diff 对象构建左右只读视图;diff 变化时先销毁旧视图再重建(同 legacy render) */
  useEffect(() => {
    const previousScrollTop = viewsRef.current[0]?.scrollDOM.scrollTop ?? 0;
    // 先销毁旧视图(无论新内容是否为文本 diff),避免 text→meta 切换泄漏
    scrollCleanupRef.current();
    scrollCleanupRef.current = () => undefined;
    viewsRef.current.forEach((v) => v.destroy());
    viewsRef.current = [];
    if (!displayGrid) return;
    const leftEl = leftRef.current;
    const rightEl = rightRef.current;
    if (!leftEl || !rightEl) return;
    const left = buildSide(leftEl, displayGrid.left, 'del', expandFold);
    const right = buildSide(rightEl, displayGrid.right, 'add', expandFold);
    left.scrollDOM.scrollTop = previousScrollTop;
    right.scrollDOM.scrollTop = previousScrollTop;
    viewsRef.current = [left, right];
    scrollCleanupRef.current = syncVerticalScroll(left, right);
  }, [displayGrid, expandFold]);

  /* 挂载:首载 + 事件订阅(卸载即退订,替代 legacy 的 isConnected 守卫) */
  useEffect(() => {
    void load().catch((err) => toast(`暂存 diff 加载失败：${String(err)}`, 'error'));
    const offStaging = wbEvents.on('staging-changed', () => void load());
    /* 修复 legacy bug:只读视图主题跟随全局切换(见文件头注释) */
    const offTheme = onThemeChange(() => viewsRef.current.forEach((v) => reconfigureTheme(v)));
    return () => {
      offStaging();
      offTheme();
    };
    // data 在标签存活期内稳定,只订阅一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* 卸载:销毁左右视图(对应 legacy 的 viewsByTab + tab-closed 清理) */
  useEffect(() => () => {
    scrollCleanupRef.current();
    scrollCleanupRef.current = () => undefined;
    viewsRef.current.forEach((v) => v.destroy());
    viewsRef.current = [];
  }, []);

  const name = entry?.remotePath.split('/').filter(Boolean).pop() ?? '暂存条目';
  const stateText = entry
    ? `${entry.remotePath}（${entry.originalState === 'absent' ? '原始不存在' : '原始已存在'} → 当前${entry.currentState === 'absent' ? '已不存在' : '存在'}）`
    : '（条目已不存在——可能已被接受）';

  return (
    <div className="sd-panel">
      <div className="sd-head">
        <span className="sd-title"><Icon name="diff" /> 暂存 diff</span>
        <div className="sd-head-actions">
          {defaultFoldIds.length > 0 ? (
            <button
              className="btn small"
              title={allExpanded ? '折叠无差异内容' : '展开全部无差异内容'}
              onClick={() => setExpandedFolds(allExpanded ? new Set() : new Set(defaultFoldIds))}
            >
              <Icon name={allExpanded ? 'eyeOff' : 'eye'} /> {allExpanded ? '折叠无差异' : '展开全部'}
            </button>
          ) : null}
          <button className="btn small" title="刷新" onClick={() => void load()}><Icon name="refresh" /> 刷新</button>
        </div>
      </div>
      <div className="sd-meta">
        <span className="sd-path" title={entry?.remotePath ?? ''}>{name}</span>
        <span className="sd-state">{stateText}</span>
        {diff?.snapshotAbsent ? <span className="sd-badge sd-badge-del">快照侧：文件不存在</span> : null}
        {diff?.currentAbsent ? <span className="sd-badge sd-badge-del">当前侧：文件已删除</span> : null}
      </div>
      <div className={`sd-body${error === null && diff && !diff.meta ? ' text-diff' : ''}`}>
        {error !== null ? (
          <div className="sd-loading error">{error}</div>
        ) : diff === null ? (
          <div className="sd-loading">加载中…</div>
        ) : diff.meta ? (
          <>
            {/* 二进制/超大:只展示元数据,不把原文返回前端 */}
            <div className="sd-binary-note"><Icon name="info" /> 文件为二进制或超过编辑上限，无法显示文本 diff：</div>
            <div className="sd-meta-table">
              {metaRow('首次快照', diff.meta.snapshot.sha256, diff.meta.snapshot.size, diff.meta.snapshot.mtime)}
              {metaRow('当前', diff.meta.current.sha256, diff.meta.current.size, diff.meta.current.mtime)}
            </div>
          </>
        ) : (
          <div className="sd-sides">
            <div className="sd-side">
              <div className="sd-side-head"><Icon name="arrowLeft" /> 首次快照{diff.snapshotAbsent ? '（不存在）' : ''}</div>
              <div className="sd-side-editor" ref={leftRef} />
            </div>
            <div className="sd-side">
              <div className="sd-side-head">当前内容{diff.currentAbsent ? '（已删除）' : ''} <Icon name="arrowRight" /></div>
              <div className="sd-side-editor" ref={rightRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
