/**
 * 激励计划宣传片 D 幕 —— 真实「账号 → 激励计划」页面（对照 src/pages/account/IncentiveView.tsx + account.css）。
 * 结构：计分规则（.inc-rules）→ 我的积分（.inc-total + .inc-dims + .usage-table 时间/维度/分值/说明）
 *      → 积分排行榜（名次/成员/部门/积分/维度小计，自己行 .inc-board-row.active + .inc-me-tag 我）。
 */
import React from 'react';
import { Easing, interpolate } from 'remotion';
import { BOARD, MY_DIMS, MY_ITEMS, POINTS_TOTAL, RULES } from './layout';
import { AccountShell } from './mocks';
import { Ic } from './rui';

const rv = (t: number, start: number, dur = 8): number =>
  interpolate(t, [start, start + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

/** 维度小计（真实 .inc-dims / .inc-dim <b>） */
const Dims: React.FC<{ dims: Array<{ label: string; v: number }> }> = ({ dims }) => (
  <span className="inc-dims">
    {dims.map((d) => (
      <span key={d.label} className="inc-dim">
        {d.label} <b>{d.v}</b>
      </span>
    ))}
  </span>
);

export const IncentiveBoard: React.FC<{ t: number }> = ({ t }) => {
  const total = Math.round(
    interpolate(t, [96, 156], [0, POINTS_TOTAL], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) }),
  );
  return (
    <AccountShell active="incentive">
      <div className="account-view-head">
        <Ic name="trophy" /> 激励计划
      </div>
      <div className="account-body">
        <div className="account-toolbar">
          <button className="btn small"><Ic name="refresh" /> 刷新</button>
          <span className="inc-generated">榜单更新于 2026-09-11 09:24</span>
        </div>

        {/* 计分规则 */}
        <section className="usage-section">
          <div className="usage-section-title">计分规则</div>
          <div className="inc-rules">
            {RULES.map((r, i) => (
              <div key={r.label} className="inc-rule" style={{ opacity: rv(t, 24 + i * 5, 8) }}>
                <span className="inc-rule-name">{r.label}</span>
                <span className="inc-rule-points">{r.points} 分</span>
              </div>
            ))}
          </div>
        </section>

        {/* 我的积分 */}
        <section className="usage-section">
          <div className="usage-section-title">
            我的积分
            <span className="inc-rank-chip" style={{ opacity: rv(t, 110) }}>当前排名第 2 名</span>
          </div>
          <div className="inc-mine-head">
            <div className="inc-total">
              <div className="usage-stat-label">积分总分</div>
              <div className="inc-total-value">{total.toLocaleString('en-US')}</div>
            </div>
            <div className="inc-mine-dims">
              <Dims dims={MY_DIMS} />
            </div>
          </div>
          <div className="usage-table-wrap">
            <table className="usage-table">
              <thead>
                <tr><th>时间</th><th>维度</th><th>分值</th><th>说明</th></tr>
              </thead>
              <tbody>
                {MY_ITEMS.map((it, i) => (
                  <tr key={it.t} style={{ opacity: rv(t, 132 + i * 8, 8) }}>
                    <td className="mono">{it.t}</td>
                    <td>{it.dim}</td>
                    <td className="mono" style={{ color: 'var(--green)' }}>+{it.p}</td>
                    <td className="inc-note">{it.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* 积分排行榜 */}
        <section className="usage-section">
          <div className="usage-section-title">
            积分排行榜<span className="inc-hint-inline">（点击成员查看其明细）</span>
          </div>
          <div className="usage-table-wrap inc-board-wrap">
            <table className="usage-table">
              <thead>
                <tr><th>名次</th><th>成员</th><th>部门</th><th>积分</th><th>维度小计</th></tr>
              </thead>
              <tbody>
                {BOARD.map((b, i) => (
                  <tr key={b.name} className={`inc-board-row${b.self ? ' active' : ''}`} style={{ opacity: rv(t, 190 + i * 7, 8) }}>
                    <td className="mono inc-rank">{b.rank}</td>
                    <td>
                      {b.name}
                      {b.self ? <span className="inc-me-tag">我</span> : null}
                    </td>
                    <td>{b.dept}</td>
                    <td className="mono inc-board-total">{b.total}</td>
                    <td>
                      <Dims dims={b.self ? MY_DIMS.slice(0, 3) : MY_DIMS.slice(0, 2)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </AccountShell>
  );
};
