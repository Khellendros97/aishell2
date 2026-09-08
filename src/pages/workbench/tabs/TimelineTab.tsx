/**
 * 项目时间线标签页('timeline',本次新增,无 .proto 对照;布局参照 TraceTab.tsx)。
 * 展示当前项目的时间线(后端 timeline.rs 按天滚动落盘 <项目>/.aishell/timeline/YYYY-MM-DD.jsonl,
 * 保留 30 天,无开关默认常开):
 *   - 工具栏:关键词(300ms 防抖,后端匹配 summary+detail)、类别 chips 多选、时间段预设
 *     (全部/今天/近7天/近30天/自定义起止)、刷新、「AI 分析」(经 wbHandles.ai.analyzeTimeline
 *     新建 AI 会话执行时间线分析任务,产物由 ask 多选勾选后保存为笔记/skill);
 *   - 事件流倒序(最新在前),行 = 类别图标 + 时间 + 摘要,点击展开/收起 detail(命令输出、
 *     AI 回答全文等);激活期间每 5s 轮询刷新(对照 TraceTab 的 3s 轮询先例);
 *   - 底部计数:当前命中条数(受后端 limit=500 截断时提示)。
 * 与后端的接口点:timeline_search;事件写入见 timeline.rs 模块注释(ssh.rs/sftp.rs/
 * ai.rs/ai_actions.rs 埋点 + useTerminal 终端区块上报)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { timelineSearch } from '../../../api';
import type { TimelineEntry, TimelineQuery } from '../../../types';
import { toast } from '../../../ui';
import { useWorkbench, wbHandles, type TabProps } from '../../../stores/workbench';
import { Icon } from '../../../shared/Icon';
import type { IconName } from '../../../icons';
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
  const [keywordInput, setKeywordInput] = useState('');
  const [keyword, setKeyword] = useState('');
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [range, setRange] = useState<RangeKey>('7d');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
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
    if (wbHandles.ai?.analyzeTimeline) {
      wbHandles.ai.analyzeTimeline();
    } else {
      toast('AI 面板尚未就绪');
    }
  };

  return (
    <div className="timeline-tab">
      <div className="timeline-toolbar">
        <span className="timeline-title">时间线</span>
        <span className="timeline-search">
          <Icon name="search" />
          <input
            className="input"
            placeholder="搜索摘要与内容…"
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
          title="让 AI 分析时间线，产出项目日志（笔记）与可重用 Skill，勾选后保存"
        >
          <Icon name="sparkles" /> AI 分析
        </button>
      </div>
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
            return (
              <div key={rowKey} className={`timeline-row timeline-kind-${e.kind}`}>
                <button
                  className="timeline-row-head"
                  onClick={() => toggleExpand(rowKey)}
                  title={e.detail ? (open ? '收起详情' : '展开详情') : undefined}
                >
                  <span className="timeline-kind-icon"><Icon name={meta?.icon ?? 'info'} /></span>
                  <span className="timeline-ts">{fmtTime(e.ts)}</span>
                  <span className="timeline-kind">{meta?.label ?? e.kind}</span>
                  <span className="timeline-summary">{e.summary}</span>
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
    </div>
  );
}
