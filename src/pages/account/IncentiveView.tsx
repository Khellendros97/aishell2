/**
 * 激励计划子页（React 版，新增功能）—— 云账号页导航的一页。
 * 协议以 docs/AIShell云服务-激励计划API文档.md 第三节为准（全部只读 GET）：
 * 计分规则（rules）+ 本人积分汇总与明细（points/mine）+ 全员排行榜（leaderboard），
 * 点击排行榜某成员用其 userId 调 points/users/:id 查看该成员明细（公开透明）。
 * 维度键对照（§3.1）：规则接口为 camelCase、明细/排行接口为 snake_case，二者不可复用，
 * 本页用 DIMENSION_LABELS 一张表统一映射中文名。
 * 实时性（§集成建议 3）：进入页面并行拉三组；排行榜 20 秒轮询；本人明细随页面刷新。
 * 与后端的接口点（见 src/api.ts）：incentiveRules / incentivePointsMine / incentivePointsUser /
 * incentiveLeaderboard；token 全程留在 Rust 端，本页无任何 token 接触。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CloudStatus, IncentiveLeaderboard, IncentivePointEntry, IncentivePoints, IncentiveRules,
} from '../../types';
import {
  incentiveLeaderboard, incentivePointsMine, incentivePointsUser, incentiveRules,
} from '../../api';
import { Icon } from '../../shared/Icon';

/** 排行榜轮询间隔（§集成建议 3：服务端无推送，15–30 秒） */
const BOARD_POLL_MS = 20_000;
/** 明细分页大小 */
const PAGE_SIZE = 20;

/** snake_case 维度键 → 中文名（§3.1；明细/排行两处共用） */
const DIMENSION_LABELS: Record<string, string> = {
  ai_tool: 'AI 工具调用',
  manual_ops: '人工命令/SFTP',
  ticket_report: '工单报告',
  skill_upload: 'skill 上传',
  skill_reference: 'skill 被引用',
  feedback: '问题反馈',
};

/** 规则接口的 camelCase 键顺序（展示用；点分明细接口不含规则键） */
const RULE_ORDER: Array<{ key: keyof IncentiveRules; dimension: string }> = [
  { key: 'aiTool', dimension: 'ai_tool' },
  { key: 'manualOps', dimension: 'manual_ops' },
  { key: 'ticketReport', dimension: 'ticket_report' },
  { key: 'skillUpload', dimension: 'skill_upload' },
  { key: 'skillReference', dimension: 'skill_reference' },
  { key: 'feedback', dimension: 'feedback' },
];

function dimensionLabel(key: string): string {
  return DIMENSION_LABELS[key] ?? key;
}

/** RFC 3339 → 2026-09-10 12:38（截到分钟，同账号页其他子页口径） */
function fmtTime(rfc3339: string): string {
  if (!rfc3339) return '';
  return rfc3339.replace('T', ' ').slice(0, 16);
}

/** 维度小计行（键按 §3.1 中文映射，仅渲染有分的维度） */
function DimensionTags({ byDimension }: { byDimension: Record<string, number> }): JSX.Element {
  const keys = Object.keys(byDimension);
  if (keys.length === 0) return <span className="inc-none">暂无得分</span>;
  return (
    <span className="inc-dims">
      {keys.map((k) => (
        <span className="inc-dim" key={k}>
          {dimensionLabel(k)} <b>{byDimension[k]}</b>
        </span>
      ))}
    </span>
  );
}

/** 明细表（本人与他人共用；§3.3/§3.4 响应同构） */
function PointsTable({ points }: { points: IncentivePoints }): JSX.Element {
  if (points.items.length === 0) {
    return <div className="cloud-empty">暂无积分明细。</div>;
  }
  return (
    <div className="usage-table-wrap">
      <table className="usage-table">
        <thead>
          <tr><th>时间</th><th>维度</th><th>分值</th><th>说明</th></tr>
        </thead>
        <tbody>
          {points.items.map((it: IncentivePointEntry) => (
            <tr key={it.id}>
              <td className="mono">{fmtTime(it.createdAt)}</td>
              <td>{dimensionLabel(it.dimension)}</td>
              <td className="mono">+{it.points}</td>
              <td className="inc-note">{it.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 明细分页条（基于 itemTotal 流水条数，非分值 total——§3.3） */
function Pager({ page, pageSize, itemTotal, onPage }: {
  page: number; pageSize: number; itemTotal: number; onPage: (p: number) => void;
}): JSX.Element | null {
  const pages = Math.max(1, Math.ceil(itemTotal / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="inc-pager">
      <button className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</button>
      <span>第 {page} / {pages} 页（共 {itemTotal} 条）</span>
      <button className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)}>下一页</button>
    </div>
  );
}

interface IncentiveViewProps {
  status: CloudStatus | null;
  onGoLogin: () => void;
}

export function IncentiveView({ status, onGoLogin }: IncentiveViewProps): JSX.Element {
  const [rules, setRules] = useState<IncentiveRules | null>(null);
  const [mine, setMine] = useState<IncentivePoints | null>(null);
  const [minePage, setMinePage] = useState(1);
  const [board, setBoard] = useState<IncentiveLeaderboard | null>(null);
  /** 查看中成员（null = 本人）；点排行榜行时用其 userId 拉明细 */
  const [viewUser, setViewUser] = useState<{ id: number; name: string } | null>(null);
  const [other, setOther] = useState<IncentivePoints | null>(null);
  const [otherPage, setOtherPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** 序号 ref 丢弃迟到响应（照 UsageView 的竞态处理） */
  const seq = useRef(0);

  const loggedIn = !!status?.loggedIn;
  const enabled = !!status?.serverUrl && status.loggedIn && status.capabilities?.incentive === true;

  /** 拉取规则 + 本人明细（页面进入与本人分页变化时） */
  const loadMine = useCallback(async (page: number): Promise<void> => {
    const id = ++seq.current;
    setError(null);
    try {
      const [r, p] = await Promise.all([incentiveRules(), incentivePointsMine(page, PAGE_SIZE)]);
      if (id !== seq.current) return;
      setRules(r);
      setMine(p);
    } catch (e) {
      if (id === seq.current) setError(String(e));
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, []);

  /** 拉取排行榜（轮询与手动刷新共用；不触碰 loading/error 主态，失败静默保留旧榜） */
  const loadBoard = useCallback(async (): Promise<void> => {
    try {
      setBoard(await incentiveLeaderboard());
    } catch {
      /* 轮询失败静默，保留上次榜单 */
    }
  }, []);

  /** 查看某成员明细（他人走 points/users/:id；本人切回 mine） */
  const loadOther = useCallback(async (target: { id: number; name: string }, page: number): Promise<void> => {
    try {
      setOther(await incentivePointsUser(target.id, page, PAGE_SIZE));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  /* 进入页面 / 本人分页变化：拉规则 + 本人明细 */
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    void loadMine(minePage);
  }, [enabled, minePage, loadMine]);

  /* 排行榜：首次 + 20s 轮询（页面隐藏时不打扰服务端，恢复可见时立即补一次） */
  useEffect(() => {
    if (!enabled) return;
    void loadBoard();
    const timer = setInterval(() => {
      if (!document.hidden) void loadBoard();
    }, BOARD_POLL_MS);
    const onVisible = (): void => { if (!document.hidden) void loadBoard(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, loadBoard]);

  /* 选中成员变化：拉该成员明细（空选中 = 本人，无需额外请求） */
  useEffect(() => {
    if (!enabled || !viewUser) { setOther(null); return; }
    setOtherPage(1);
    void loadOther(viewUser, 1);
  }, [enabled, viewUser, loadOther]);

  if (!status?.serverUrl) {
    return <div className="cloud-empty"><div>当前构建未接入云服务，激励计划不可用。</div></div>;
  }
  if (!loggedIn) {
    return (
      <div className="cloud-empty">
        <div>登录公司账号后即可查看激励计划。</div>
        <button className="btn primary small" onClick={onGoLogin}>去登录</button>
      </div>
    );
  }
  if (!enabled) {
    return (
      <div className="cloud-empty">
        <div>当前账号未开通激励计划。</div>
        <div className="hint">如需开通，请联系云平台管理员。</div>
      </div>
    );
  }

  const myRank = mine && board ? board.items.find((e) => e.userId === mine.userId)?.rank ?? null : null;

  return (
    <div className="inc-root">
      <div className="account-toolbar">
        <button className="btn small" onClick={() => { setLoading(true); void loadMine(minePage); void loadBoard(); }}>
          <Icon name="refresh" /> 刷新
        </button>
        {board?.generatedAt ? <span className="inc-generated">榜单更新于 {fmtTime(board.generatedAt)}</span> : null}
      </div>

      {loading ? (
        <div className="loading-row"><Icon name="loader" /> 加载激励计划…</div>
      ) : error ? (
        <div className="cloud-empty">
          <div className="err-text">加载激励计划失败：{error}</div>
          <button className="btn small" onClick={() => { setLoading(true); void loadMine(minePage); }}>重试</button>
        </div>
      ) : (
        <>
          {/* 计分规则 */}
          {rules && (
            <section className="usage-section">
              <div className="usage-section-title">计分规则</div>
              <div className="inc-rules">
                {RULE_ORDER.map(({ key, dimension }) => {
                  const rule = rules[key];
                  return (
                    <div className={`inc-rule${rule.enabled ? '' : ' off'}`} key={key}>
                      <span className="inc-rule-name">{dimensionLabel(dimension)}</span>
                      <span className="inc-rule-points">{rule.points} 分</span>
                      {!rule.enabled && <span className="inc-rule-off">已停用</span>}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* 本人积分 */}
          {mine && (
            <section className="usage-section">
              <div className="usage-section-title">
                我的积分
                {myRank !== null && <span className="inc-rank-chip">当前排名第 {myRank} 名</span>}
              </div>
              <div className="inc-mine-head">
                <div className="inc-total">
                  <div className="usage-stat-label">积分总分</div>
                  <div className="inc-total-value">{mine.total}</div>
                </div>
                <div className="inc-mine-dims">
                  <DimensionTags byDimension={mine.byDimension} />
                </div>
              </div>
              <PointsTable points={mine} />
              <Pager page={minePage} pageSize={PAGE_SIZE} itemTotal={mine.itemTotal} onPage={setMinePage} />
            </section>
          )}

          {/* 全员排行榜 */}
          <section className="usage-section">
            <div className="usage-section-title">积分排行榜<span className="inc-hint-inline">（点击成员查看其明细）</span></div>
            {!board || board.items.length === 0 ? (
              <div className="cloud-empty">暂无得分记录。</div>
            ) : (
              <div className="usage-table-wrap inc-board-wrap">
                <table className="usage-table">
                  <thead>
                    <tr><th>名次</th><th>成员</th><th>部门</th><th>积分</th><th>维度小计</th></tr>
                  </thead>
                  <tbody>
                    {board.items.map((e) => {
                      const isMe = mine != null && e.userId === mine.userId;
                      const active = viewUser ? viewUser.id === e.userId : isMe;
                      return (
                        <tr
                          key={e.userId}
                          className={`inc-board-row${active ? ' active' : ''}`}
                          onClick={() => {
                            if (isMe) setViewUser(null);
                            else setViewUser({ id: e.userId, name: e.name });
                          }}
                        >
                          <td className="mono inc-rank">{e.rank}</td>
                          <td>{e.name}{isMe && <span className="inc-me-tag">我</span>}</td>
                          <td>{e.dept}</td>
                          <td className="mono inc-board-total">{e.total}</td>
                          <td><DimensionTags byDimension={e.byDimension} /></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* 选中成员明细（点排行榜行展开；本人时提示点自己行可返回） */}
          {viewUser && (
            <section className="usage-section inc-other">
              <div className="usage-section-title">
                {viewUser.name} 的积分明细
                <button className="btn small inc-back" onClick={() => setViewUser(null)}>
                  <Icon name="arrowLeft" /> 返回我的积分
                </button>
              </div>
              {other ? (
                <>
                  <div className="inc-other-head">
                    <span>总分 <b>{other.total}</b></span>
                    <DimensionTags byDimension={other.byDimension} />
                  </div>
                  <PointsTable points={other} />
                  <Pager page={otherPage} pageSize={PAGE_SIZE} itemTotal={other.itemTotal}
                         onPage={(p) => { setOtherPage(p); void loadOther(viewUser, p); }} />
                </>
              ) : (
                <div className="loading-row"><Icon name="loader" /> 加载明细…</div>
              )}
            </section>
          )}
        </>
      )}
    </div>
  );
}
