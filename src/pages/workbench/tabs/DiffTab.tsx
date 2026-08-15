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
import { useCallback, useEffect, useRef, useState } from 'react';
import { RangeSetBuilder, StateEffect } from '@codemirror/state';
import { Decoration, EditorView } from '@codemirror/view';
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

/** 单侧只读编辑器:按行构建文档并给 del/add 行加背景高亮。
 *  CodeMirror 行装饰(Decoration.line)要求零长度范围:在行首 pos 处 add(pos, pos, deco)。 */
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

export function DiffTab({ tab, active: _active }: TabProps): JSX.Element {
  const data = tab.data as { projectId: string; sessionId: string; entryId: string };
  const [entry, setEntry] = useState<StagedFile | null>(null);
  const [diff, setDiff] = useState<StagingDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const viewsRef = useRef<EditorView[]>([]);
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
      setDiff(d);
      setError(null);
    } catch (err) {
      if (seq !== loadSeqRef.current) return;
      setError(String(err));
    }
  }, [data.projectId, data.sessionId, data.entryId]);

  /* 文本 diff:按 diff 对象构建左右只读视图;diff 变化时先销毁旧视图再重建(同 legacy render) */
  useEffect(() => {
    // 先销毁旧视图(无论新内容是否为文本 diff),避免 text→meta 切换泄漏
    viewsRef.current.forEach((v) => v.destroy());
    viewsRef.current = [];
    if (!diff || diff.meta) return;
    const leftEl = leftRef.current;
    const rightEl = rightRef.current;
    if (!leftEl || !rightEl) return;
    const left = diff.snapshotAbsent ? [] : diff.left;
    const right = diff.currentAbsent ? [] : diff.right;
    viewsRef.current = [buildSide(leftEl, left, 'del'), buildSide(rightEl, right, 'add')];
  }, [diff]);

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
        <button className="btn small" title="刷新" onClick={() => void load()}><Icon name="refresh" /> 刷新</button>
      </div>
      <div className="sd-meta">
        <span className="sd-path" title={entry?.remotePath ?? ''}>{name}</span>
        <span className="sd-state">{stateText}</span>
        {diff?.snapshotAbsent ? <span className="sd-badge sd-badge-del">快照侧：文件不存在</span> : null}
        {diff?.currentAbsent ? <span className="sd-badge sd-badge-del">当前侧：文件已删除</span> : null}
      </div>
      <div className="sd-body">
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
