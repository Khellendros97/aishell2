/**
 * 用量报表子页（React 版）—— 云账号三页导航的第二页。
 * 对照旧实现 src/pages/account.ts 的 guardCloud / loadUsage / renderUsage / mountUsageToolbar：
 * 未接入/未登录守卫、过滤工具行（天数/类型/模型 + 刷新）、汇总卡片、每日明细表、模型分布表。
 * 与后端的接口点（见 src/api.ts）：cloudUsage（days 1–90 默认 14；kind llm|search；model 仅 LLM 过滤）。
 * 过滤状态（usageDays/usageKind/usageModel）由父组件 Account 持有——旧实现以闭包变量跨子页切换保留，
 * 本组件挂载时恢复、卸载不丢；异步竞态用序号 ref 丢弃迟到响应（同旧实现 usageSeq）。
 * 守卫语义与旧版一致：未接入显示「该功能不可用」，未登录显示「去登录」（切回账号信息页）。
 */
import { useEffect, useRef, useState } from 'react';
import type { CloudStatus, UsageReport } from '../../types';
import { cloudUsage } from '../../api';
import { Icon } from '../../shared/Icon';

/** 用量报表天数选项（同旧实现 USAGE_DAYS） */
const USAGE_DAYS = [7, 14, 30, 90];

/** 类型过滤选项：空 = 全部（同旧实现 kindOpts） */
const USAGE_KINDS: Array<{ value: string; label: string }> = [
  { value: '', label: '全部类型' },
  { value: 'llm', label: '仅 LLM' },
  { value: 'search', label: '仅搜索' },
];

interface UsageViewProps {
  status: CloudStatus | null;
  days: number;
  kind: string;
  model: string;
  onFilter: (days: number, kind: string, model: string) => void;
  onGoLogin: () => void;
}

/** 数字千分位 / 毫秒一位小数（同旧实现 fmt / fmtMs） */
const fmt = (n: number): string => (n ?? 0).toLocaleString('zh-CN');
const fmtMs = (n: number): string => (n ?? 0).toFixed(1);

/** 报表主体：统计区间 + 汇总卡片 + 两张明细表（同旧实现 renderUsage 的 innerHTML 结构） */
function UsageReportBody({ report }: { report: UsageReport }): JSX.Element {
  const s = report.summary;
  const stats: Array<[string, string, string]> = [
    ['请求总数', fmt(s.requests), ''],
    ['LLM 请求', fmt(s.llmRequests), ''],
    ['搜索请求', fmt(s.searchRequests), ''],
    ['Prompt Tokens', fmt(s.promptTokens), ''],
    ['Completion Tokens', fmt(s.completionTokens), ''],
    ['总 Tokens', fmt(s.totalTokens), ''],
    ['平均延迟', `${fmtMs(s.averageLatencyMs)} ms`, ''],
    ['错误数', fmt(s.errorCount), s.errorCount > 0 ? 'warn' : ''],
  ];
  return (
    <>
      <div className="usage-range">统计区间：{report.from} ~ {report.to}（{report.timezone}）</div>
      <div className="usage-summary-grid">
        {stats.map(([label, value, cls]) => (
          <div className={`usage-stat${cls ? ` ${cls}` : ''}`} key={label}>
            <div className="usage-stat-label">{label}</div>
            <div className="usage-stat-value">{value}</div>
          </div>
        ))}
      </div>
      <div className="usage-section">
        <div className="usage-section-title">每日明细</div>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead><tr><th>日期</th><th>请求</th><th>LLM</th><th>搜索</th><th>Token</th><th>错误</th></tr></thead>
            <tbody>
              {report.daily.length > 0 ? report.daily.map((d) => (
                <tr key={d.date}>
                  <td className="mono">{d.date}</td>
                  <td>{fmt(d.requests)}</td>
                  <td>{fmt(d.llmRequests)}</td>
                  <td>{fmt(d.searchRequests)}</td>
                  <td>{fmt(d.promptTokens + d.completionTokens)}</td>
                  <td>{fmt(d.errorCount)}</td>
                </tr>
              )) : <tr><td colSpan={6} className="empty-cell">无数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      <div className="usage-section">
        <div className="usage-section-title">模型分布</div>
        <div className="usage-table-wrap">
          <table className="usage-table">
            <thead><tr><th>模型</th><th>请求</th><th>Prompt</th><th>Completion</th><th>总 Token</th></tr></thead>
            <tbody>
              {report.models.length > 0 ? report.models.map((m) => (
                <tr key={m.model}>
                  <td className="mono">{m.model}</td>
                  <td>{fmt(m.requests)}</td>
                  <td>{fmt(m.promptTokens)}</td>
                  <td>{fmt(m.completionTokens)}</td>
                  <td>{fmt(m.totalTokens)}</td>
                </tr>
              )) : <tr><td colSpan={5} className="empty-cell">无模型数据</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

export function UsageView({ status, days, kind, model, onFilter, onGoLogin }: UsageViewProps): JSX.Element {
  /** 异步竞态序号：过滤切换/刷新后丢弃迟到的响应（同旧实现 usageSeq） */
  const seqRef = useRef(0);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 刷新按钮：过滤值未变也要重新拉取，tick 自增触发 effect */
  const [tick, setTick] = useState(0);

  // 挂载/过滤变化/点刷新 → 重新加载（同旧实现 loadUsage 的调用时机）
  useEffect(() => {
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    void cloudUsage(days, kind, model)
      .then((r) => {
        if (seq !== seqRef.current) return;
        setReport(r);
        setLoading(false);
      })
      .catch((e) => {
        if (seq !== seqRef.current) return;
        setError(String(e));
        setLoading(false);
      });
  }, [days, kind, model, tick]);

  // 守卫（同旧实现 guardCloud 渲染形态）：未接入云服务
  if (!status?.serverUrl) {
    return <div className="cloud-empty"><div>当前构建未接入云服务，该功能不可用。</div></div>;
  }
  // 守卫：未登录
  if (!status.loggedIn) {
    return (
      <div className="cloud-empty">
        <div>登录公司账号后即可使用该功能。</div>
        <button className="btn primary small" onClick={onGoLogin}>去登录</button>
      </div>
    );
  }

  const models = status.capabilities?.models ?? [];
  return (
    <>
      <div className="account-toolbar" id="usage-toolbar">
        <select id="usage-days" className="select" title="统计天数" value={days}
                onChange={(e) => onFilter(Number(e.currentTarget.value), kind, model)}>
          {USAGE_DAYS.map((d) => <option value={d} key={d}>近 {d} 天</option>)}
        </select>
        <select id="usage-kind" className="select" title="类型过滤" value={kind}
                onChange={(e) => onFilter(days, e.currentTarget.value, model)}>
          {USAGE_KINDS.map((k) => <option value={k.value} key={k.value}>{k.label}</option>)}
        </select>
        <select id="usage-model" className="select" title="模型过滤（仅 LLM）" value={model}
                onChange={(e) => onFilter(days, kind, e.currentTarget.value)}>
          <option value="">全部模型</option>
          {models.map((m) => <option value={m} key={m}>{m}</option>)}
        </select>
        <button className="btn small" onClick={() => setTick((t) => t + 1)}><Icon name="refresh" /> 刷新</button>
      </div>
      <div id="usage-content">
        {loading ? (
          <div className="loading-row"><Icon name="loader" /> 加载用量报表…</div>
        ) : error ? (
          <div className="cloud-empty">
            <div className="err-text">加载用量报表失败：{error}</div>
            <button className="btn small" onClick={() => setTick((t) => t + 1)}>重试</button>
          </div>
        ) : report ? (
          <UsageReportBody report={report} />
        ) : null}
      </div>
    </>
  );
}
