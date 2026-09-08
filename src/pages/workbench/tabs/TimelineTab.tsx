/**
 * 项目时间线标签页('timeline',本次新增,无 .proto 对照;布局参照 TraceTab.tsx)。
 * 展示当前项目的时间线(后端 timeline.rs 按天滚动落盘 <项目>/.aishell/timeline/YYYY-MM-DD.jsonl,
 * 保留 30 天,无开关默认常开):
 *   - 工具栏:关键词(300ms 防抖,后端匹配 summary+detail,支持 `#标签` token 按标签过滤)、
 *     类别 chips 多选、时间段预设(全部/今天/近7天/近30天/自定义起止)、刷新、「AI 分析」
 *     (有标签时先弹 AnalyzeDialog 多选标签划定范围——按所选标签锚点时间段经
 *     wbHandles.ai.analyzeTimeline(scope) 下发;无标签时全量分析;产物由 ask 多选勾选后保存为笔记/skill);
 *   - 搜索框下方标签 chips 行(当前项目已有标签,按打标时间倒序,点击切换 #tag 筛选,
 *     复用 shared/search.ts 的 parseSearchQuery/toggleTagInQuery 语法先例);
 *   - 事件流倒序(最新在前),行 = 类别图标 + 时间 + 摘要,点击展开/收起 detail(命令输出、
 *     AI 回答全文等);激活期间每 5s 轮询刷新(对照 TraceTab 的 3s 轮询先例);
 *   - 右键行 →「标签…」弹窗打标签(名称 + 8 色调色板;选已有名称自动沿用其最新颜色):
 *     直接打标的事件与处于同名标签对选区内的事件按标签颜色着色(直接更深、选区更浅),
 *     行内显示标签 chips(选区命中为虚线框);标签存 tags.jsonl sidecar,两个同名标签构成标签对;
 *   - 底部计数:当前命中条数(受后端 limit=500 截断时提示)。
 * 与后端的接口点:timeline_search / timeline_tag_add / timeline_tags;事件写入见 timeline.rs
 * 模块注释(ssh.rs/sftp.rs/ai.rs/ai_actions.rs 埋点 + useTerminal 终端区块上报)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { timelineSearch, timelineTagAdd, timelineTagReclose, timelineTagRemove, timelineTags } from '../../../api';
import type { TimelineEntry, TimelineQuery, TimelineTag } from '../../../types';
import { showContextMenu, toast } from '../../../ui';
import { useWorkbench, wbHandles, type TabProps, type TimelineAnalysisScopeItem } from '../../../stores/workbench';
import { Icon } from '../../../shared/Icon';
import type { IconName } from '../../../icons';
import { queryTags, toggleTagInQuery } from '../../../shared/search';
import './timeline.css';

const POLL_MS = 5000;
const QUERY_LIMIT = 500;

/** 类别元数据：筛选 chips 与行内图标/标签共用（与 timeline.rs 的 kind 一致） */
const KINDS: Array<{ key: string; label: string; icon: IconName }> = [
  { key: 'ssh_connect', label: '连接', icon: 'monitor' },
  { key: 'ssh_disconnect', label: '断开', icon: 'monitor' },
  { key: 'ssh_connect_failed', label: '连接失败', icon: 'alert' },
  { key: 'command', label: '命令', icon: 'terminal' },
  { key: 'file_upload', label: '上传', icon: 'upload' },
  { key: 'file_download', label: '下载', icon: 'download' },
  { key: 'ai_user', label: '提问', icon: 'user' },
  { key: 'ai_assistant', label: '回答', icon: 'bot' },
  { key: 'ai_tool', label: '工具', icon: 'wrench' },
];
const KIND_META = new Map(KINDS.map((k) => [k.key, k]));

type RangeKey = 'all' | 'today' | '7d' | '30d' | 'custom';
const RANGES: Array<{ key: RangeKey; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'today', label: '今天' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
  { key: 'custom', label: '自定义' },
];

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 标签调色板（打标弹窗可选色；非法颜色后端会回退默认色） */
const TAG_PALETTE = ['#4f8ef7', '#4ec98a', '#e5b567', '#e5534b', '#9d6bde', '#d670a8', '#3fb6c9', '#8b949e'];

/** 打标弹窗目标事件（右键行时暂存） */
interface TagTarget {
  ts: number;
  kind: string;
  summary: string;
}

/** 时间段预设 → fromTs/toTs（本地时区；custom 由日期输入框决定，在组件内合成） */
function rangeBounds(range: RangeKey): { fromTs?: number; toTs?: number } {
  const now = Date.now();
  switch (range) {
    case 'today': {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return { fromTs: d.getTime() };
    }
    case '7d':
      return { fromTs: now - 7 * 86_400_000 };
    case '30d':
      return { fromTs: now - 30 * 86_400_000 };
    default:
      return {};
  }
}

export function TimelineTab({ active }: TabProps): JSX.Element {
  const project = useWorkbench((s) => s.project);
  const projectId = project?.id ?? '';
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [allTags, setAllTags] = useState<TimelineTag[]>([]);
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<RangeKey>('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // 打标弹窗：非 null 时打开（目标事件锚点）
  const [tagTarget, setTagTarget] = useState<TagTarget | null>(null);
  // AI 分析范围选择弹窗（有标签时先弹）
  const [analyzeOpen, setAnalyzeOpen] = useState(false);
  // 载入序号守卫：轮询与手动刷新并发时旧响应不覆盖新结果
  const seqRef = useRef(0);

  /* 关键词防抖：输入停顿 300ms 后才触发后端查询 */
  useEffect(() => {
    const timer = window.setTimeout(() => setKeyword(keywordInput.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [keywordInput]);

  const load = useCallback(async () => {
    if (!projectId) return;
    const seq = ++seqRef.current;
    const bounds = rangeBounds(range);
    const query: TimelineQuery = { limit: QUERY_LIMIT };
    if (keyword) query.keyword = keyword;
    if (kinds.size) query.kinds = Array.from(kinds);
    if (range === 'custom') {
      if (customFrom) {
        const t = new Date(`${customFrom}T00:00:00`).getTime();
        if (!Number.isNaN(t)) query.fromTs = t;
      }
      if (customTo) {
        const t = new Date(`${customTo}T23:59:59.999`).getTime();
        if (!Number.isNaN(t)) query.toTs = t;
      }
    } else {
      if (bounds.fromTs) query.fromTs = bounds.fromTs;
      if (bounds.toTs) query.toTs = bounds.toTs;
    }
    try {
      const list = await timelineSearch(projectId, query);
      if (seq !== seqRef.current) return;
      setEntries(list);
    } catch {
      /* 读失败静默：项目可能未就绪或时间线目录尚未创建 */
    }
    try {
      const tags = await timelineTags(projectId);
      if (seq !== seqRef.current) return;
      setAllTags(tags);
    } catch {
      /* 标签加载失败不影响事件流展示 */
    }
  }, [projectId, keyword, kinds, range, customFrom, customTo]);

  /* 条件变化即重查；激活期间轮询(keep-alive：切标签只是 display:none，不卸载) */
  useEffect(() => {
    void load();
    if (!active) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, active]);

  const toggleKind = (key: string): void => {
    setKinds((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleExpand = (rowKey: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const analyze = (): void => {
    if (!wbHandles.ai?.analyzeTimeline) {
      toast('AI 面板尚未就绪');
      return;
    }
    // 有标签时先让用户勾选分析范围；无标签可划范围时保持全量分析
    if (tagOptions.length > 0) {
      setAnalyzeOpen(true);
    } else {
      wbHandles.ai.analyzeTimeline();
    }
  };

  /** 勾选的标签名 → 分析范围（同名标签的锚点最小/最大 ts 划定时间段） */
  const buildScope = (names: Set<string>): TimelineAnalysisScopeItem[] => {
    const out: TimelineAnalysisScopeItem[] = [];
    for (const t of tagOptions) {
      const key = t.name.toLowerCase();
      if (!names.has(key)) continue;
      const group = allTags.filter((x) => x.name.toLowerCase() === key);
      out.push({
        name: t.name,
        fromTs: Math.min(...group.map((x) => x.anchorTs)),
        toTs: Math.max(...group.map((x) => x.anchorTs)),
      });
    }
    return out;
  };

  /* 已有标签按名去重（timeline_tags 已按打标时间倒序，先见即最新），供 chips 行与打标弹窗复用 */
  const tagOptions: TimelineTag[] = [];
  {
    const seen = new Set<string>();
    for (const t of allTags) {
      const key = t.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tagOptions.push(t);
    }
  }
  const activeTags = queryTags(keywordInput);

  const removeTag = async (entry: TimelineEntry, name: string): Promise<void> => {
    try {
      await timelineTagRemove(projectId, name, entry.ts, entry.kind);
      toast(`已删除标签「${name}」`);
      void load();
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  const openTagMenu = (e: React.MouseEvent, entry: TimelineEntry): void => {
    e.preventDefault();
    const directTags = entry.tags?.filter((t) => t.direct) ?? [];
    showContextMenu(e.clientX, e.clientY, [
      {
        label: '标签…',
        iconName: 'hash',
        action: () => setTagTarget({ ts: entry.ts, kind: entry.kind, summary: entry.summary }),
      },
      ...(directTags.length > 0
        ? [
            'sep' as const,
            ...directTags.map((t) => ({
              label: `删除标签「${t.name}」`,
              iconName: 'trash' as const,
              danger: true,
              action: () => void removeTag(entry, t.name),
            })),
          ]
        : []),
    ]);
  };

  return (
    <div className="timeline-tab">
      <div className="timeline-toolbar">
        <span className="timeline-title">时间线</span>
        <span className="timeline-search">
          <Icon name="search" />
          <input
            className="input"
            placeholder="搜索摘要与内容，#标签 按标签过滤…"
            value={keywordInput}
            onChange={(e) => setKeywordInput(e.target.value)}
            spellCheck={false}
          />
        </span>
        {RANGES.map((r) => (
          <button
            key={r.key}
            className={`btn small ghost timeline-range${range === r.key ? ' active' : ''}`}
            onClick={() => setRange(r.key)}
          >
            {r.label}
          </button>
        ))}
        {range === 'custom' && (
          <span className="timeline-custom-range">
            <input
              className="input"
              type="date"
              value={customFrom}
              onChange={(e) => setCustomFrom(e.target.value)}
            />
            <span>至</span>
            <input
              className="input"
              type="date"
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value)}
            />
          </span>
        )}
        <span className="timeline-spacer" />
        <button className="btn small ghost" onClick={() => void load()} title="刷新">
          <Icon name="refresh" /> 刷新
        </button>
        <button
          className="btn small ghost"
          onClick={analyze}
          title="让 AI 分析时间线：先勾选标签划定范围（无标签时全量分析），产出项目日志（笔记）与可重用 Skill，勾选后保存"
        >
          <Icon name="sparkles" /> AI 分析
        </button>
      </div>
      {tagOptions.length > 0 && (
        <div className="timeline-tags">
          {tagOptions.map((t) => (
            <button
              key={t.name.toLowerCase()}
              className={`timeline-tag-chip${activeTags.includes(t.name.toLowerCase()) ? ' active' : ''}`}
              style={{ color: t.color }}
              onClick={() => setKeywordInput(toggleTagInQuery(keywordInput, t.name))}
              title={`${activeTags.includes(t.name.toLowerCase()) ? '取消' : '按'}标签「${t.name}」筛选`}
            >
              <Icon name="hash" /> {t.name}
            </button>
          ))}
        </div>
      )}
      <div className="timeline-kinds">
        {KINDS.map((k) => (
          <button
            key={k.key}
            className={`timeline-kind-chip${kinds.has(k.key) ? ' active' : ''}`}
            onClick={() => toggleKind(k.key)}
            title={`${kinds.has(k.key) ? '取消' : '筛选'}「${k.label}」类事件`}
          >
            <Icon name={k.icon} /> {k.label}
          </button>
        ))}
      </div>
      <div className="timeline-body">
        {entries.length === 0 ? (
          <div className="timeline-empty">
            暂无时间线记录（连接服务器、执行命令或与 AI 对话后会自动记录，保留 30 天）
          </div>
        ) : (
          entries.map((e, i) => {
            const meta = KIND_META.get(e.kind);
            const rowKey = `${e.ts}-${i}`;
            const open = expanded.has(rowKey);
            // 着色：直接打标优先于选区命中；多个标签取第一个的颜色（行内 chips 展示全部）
            const directTag = e.tags?.find((t) => t.direct);
            const regionTag = e.tags?.find((t) => !t.direct);
            const bg = directTag ? `${directTag.color}2e` : regionTag ? `${regionTag.color}1a` : undefined;
            return (
              <div key={rowKey} className={`timeline-row timeline-kind-${e.kind}`} style={bg ? { background: bg } : undefined}>
                <button
                  className="timeline-row-head"
                  onClick={() => toggleExpand(rowKey)}
                  onContextMenu={(ev) => openTagMenu(ev, e)}
                  title={e.detail ? (open ? '收起详情' : '展开详情') : undefined}
                >
                  <span className="timeline-kind-icon"><Icon name={meta?.icon ?? 'info'} /></span>
                  <span className="timeline-ts">{fmtTime(e.ts)}</span>
                  <span className="timeline-kind">{meta?.label ?? e.kind}</span>
                  <span className="timeline-summary">{e.summary}</span>
                  {e.tags?.map((t) => (
                    <span
                      key={`${t.name}-${t.direct}`}
                      className={`timeline-row-tag${t.direct ? '' : ' region'}`}
                      style={{ color: t.color, borderColor: t.color }}
                      title={t.direct ? `标签「${t.name}」` : `处于标签对「${t.name}」选区内`}
                    >
                      <Icon name="hash" /> {t.name}
                    </span>
                  ))}
                </button>
                {open && e.detail && <pre className="timeline-detail">{e.detail}</pre>}
              </div>
            );
          })
        )}
      </div>
      <div className="timeline-status">
        共 {entries.length} 条{entries.length >= QUERY_LIMIT ? `（已达单次查询上限 ${QUERY_LIMIT}，可用关键词/时间段缩小范围）` : ''}
        {keyword ? ` · 关键词「${keyword}」` : ''}
        {kinds.size ? ` · ${kinds.size} 个类别` : ''}
      </div>
      {tagTarget && (
        <TagDialog
          target={tagTarget}
          existing={tagOptions}
          allTags={allTags}
          onClose={() => setTagTarget(null)}
          onSaved={() => {
            setTagTarget(null);
            void load();
          }}
          projectId={projectId}
        />
      )}
      {analyzeOpen && (
        <AnalyzeDialog
          existing={tagOptions}
          onClose={() => setAnalyzeOpen(false)}
          onConfirm={(names) => {
            setAnalyzeOpen(false);
            wbHandles.ai?.analyzeTimeline?.(buildScope(names));
          }}
        />
      )}
    </div>
  );
}

/** AI 分析范围选择：勾选标签划定分析范围（多选），AI 只检索所选标签的选区/锚点事件 */
function AnalyzeDialog({
  existing, onClose, onConfirm,
}: {
  existing: TimelineTag[];
  onClose: () => void;
  onConfirm: (names: Set<string>) => void;
}): JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const toggle = (key: string): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return (
    <div
      className="modal-mask open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal timeline-tag-modal" role="dialog" aria-label="选择分析范围">
        <div className="modal-head">
          <h3>选择分析范围</h3>
        </div>
        <div className="modal-body">
          <div className="timeline-analyze-hint">
            勾选要分析的标签（可多选），AI 只检索这些标签划定的时间线范围。
          </div>
          <div className="timeline-analyze-list">
            {existing.map((t) => {
              const key = t.name.toLowerCase();
              return (
                <label key={key} className="timeline-analyze-item">
                  <input
                    type="checkbox"
                    checked={picked.has(key)}
                    onChange={() => toggle(key)}
                  />
                  <span className="timeline-tag-chip" style={{ color: t.color }}>
                    <Icon name="hash" /> {t.name}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button
            className="btn primary"
            disabled={picked.size === 0}
            onClick={() => onConfirm(picked)}
          >
            开始分析{picked.size > 0 ? `（${picked.size} 个标签）` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 打标签弹窗：名称（可点选已有标签沿用其最新颜色）+ 调色板；两个同名标签构成标签对划定选区。
 *  名称已有闭合选区（同名标签数为 ≥2 的偶数）时先询问：创建新标签（开始新选区）或
 *  更新闭合位置（把最近选区的结束锚点移到当前事件，沿用原颜色）。 */
function TagDialog({
  target, existing, allTags, onClose, onSaved, projectId,
}: {
  target: TagTarget;
  existing: TimelineTag[];
  /** 未去重的全部标签记录（判断选区是否闭合用） */
  allTags: TimelineTag[];
  onClose: () => void;
  onSaved: () => void;
  projectId: string;
}): JSX.Element {
  const [name, setName] = useState('');
  const [color, setColor] = useState(TAG_PALETTE[0]);
  const [busy, setBusy] = useState(false);
  // 闭合选区确认：null=编辑表单，否则暂存待确认的标签名
  const [confirmClosed, setConfirmClosed] = useState<string | null>(null);

  const pickExisting = (t: TimelineTag): void => {
    setName(t.name);
    setColor(t.color);
  };

  const normalizedName = (): string | null => {
    const trimmed = name.trim().replace(/^#+/, '');
    if (!trimmed) {
      toast('请输入标签名', 'error');
      return null;
    }
    if (/\s/.test(trimmed)) {
      toast('标签名不能包含空格', 'error');
      return null;
    }
    return trimmed;
  };

  const doAdd = async (tagName: string): Promise<void> => {
    setBusy(true);
    try {
      await timelineTagAdd(projectId, tagName, color, target.ts, target.kind);
      toast(`已打标签「${tagName}」`);
      onSaved();
    } catch (err) {
      toast(String(err), 'error');
      setBusy(false);
    }
  };

  const doReclose = async (tagName: string): Promise<void> => {
    setBusy(true);
    try {
      await timelineTagReclose(projectId, tagName, target.ts, target.kind);
      toast(`已把标签对「${tagName}」的闭合位置移到当前事件`);
      onSaved();
    } catch (err) {
      toast(String(err), 'error');
      setBusy(false);
    }
  };

  const submit = async (): Promise<void> => {
    const tagName = normalizedName();
    if (!tagName) return;
    // 同名标签数为 ≥2 的偶数 = 选区已闭合，需用户取舍：新标签（开新选区）还是移动闭合端
    const count = allTags.filter((t) => t.name.toLowerCase() === tagName.toLowerCase()).length;
    if (count >= 2 && count % 2 === 0) {
      setConfirmClosed(tagName);
      return;
    }
    await doAdd(tagName);
  };

  return (
    <div
      className="modal-mask open"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal timeline-tag-modal" role="dialog" aria-label="打标签">
        <div className="modal-head">
          <h3>打标签</h3>
        </div>
        <div className="modal-body">
          <div className="timeline-tag-target" title={target.summary}>
            {fmtTime(target.ts)} · {target.summary}
          </div>
          {confirmClosed === null ? (
            <>
              <input
                className="input timeline-tag-name"
                placeholder="标签名（两个同名标签构成标签对划定选区）"
                value={name}
                autoFocus
                spellCheck={false}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                  if (e.key === 'Escape') onClose();
                }}
              />
              {existing.length > 0 && (
                <div className="timeline-tag-existing">
                  {existing.map((t) => (
                    <button
                      key={t.name.toLowerCase()}
                      className="timeline-tag-chip"
                      style={{ color: t.color }}
                      onClick={() => pickExisting(t)}
                      title={`沿用标签「${t.name}」`}
                    >
                      <Icon name="hash" /> {t.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="timeline-tag-palette">
                {TAG_PALETTE.map((c) => (
                  <button
                    key={c}
                    className={`timeline-tag-swatch${color === c ? ' active' : ''}`}
                    style={{ background: c }}
                    onClick={() => setColor(c)}
                    title={c}
                  />
                ))}
              </div>
            </>
          ) : (
            <div className="timeline-tag-closed-hint">
              标签「{confirmClosed}」的选区已闭合（已有两个同名标签）。要继续打标请选择：
            </div>
          )}
        </div>
        <div className="modal-foot">
          {confirmClosed === null ? (
            <>
              <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
              <button className="btn primary" onClick={() => void submit()} disabled={busy}>确定</button>
            </>
          ) : (
            <>
              <button className="btn ghost" onClick={() => setConfirmClosed(null)} disabled={busy}>返回</button>
              <button
                className="btn ghost"
                onClick={() => void doReclose(confirmClosed)}
                disabled={busy}
                title="把最近一个选区的结束端移到当前事件（沿用原颜色）"
              >
                更新闭合位置
              </button>
              <button
                className="btn primary"
                onClick={() => void doAdd(confirmClosed)}
                disabled={busy}
                title="追加第三个同名标签，开始新的选区"
              >
                创建新标签
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
