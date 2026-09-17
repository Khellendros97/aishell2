/**
 * 视频十客户端画面复刻:仪表盘与备忘录。三页面叠放(工作台 ⇄ 账号·云同步 ⇄ 设置·外观,交叉淡化,
 * 全程保持挂载——锚点实测要求消费窗口内不卸载):工作台 = 活动栏(仪表盘首位 compass)+ 侧栏
 * (资源管理器 ⇄ 仪表盘面板:备忘录可编辑表格/备忘文本/markdown 卡/AI 产物两卡)+ 本地终端 +
 * AI 面板(定制会话:指令气泡/工具条/小结) + 底栏;弹层:「定制仪表盘」promptDialog、下拉、toast、
 * 「已复制」浮标。全部内容由 state(Wb10State)驱动;交互目标打 data-anchor(components/anchors.tsx
 * 运行时实测),几何常量见 ./layout.ts。
 */
import React from 'react';
import { TopBar } from '../components/TopBar';
import { C, FONT_MONO, FONT_UI, IconName } from '../theme';
import { Icon } from '../ui';
import { WIN_H, WIN_W } from '../scene';
import {
  ACCT, ACCT_HINT, ACCT_NAV, ACT_DASH, ACT_ORDER, AI, AI_REQ1, AI_REQ2, AI_SUM1, AI_SUM2, BODY, CENTER,
  CHART, DEMO, DEVICES, DLG, DLG_F, DLG_LABEL, DASH_BTN, DASH_HEAD, DROP_OPTS, EXPL, MEMO, MEMO_ADD,
  MEMO_COL2_X, MEMO_COPY, MEMO_L1, MEMO_L2, MEMO_MD, MEMO_ROWS, MD, NEW_K, NEW_V, PERF, PERF_COLS,
  PERF_ROWS, SCALE_STATS, SET, SET_COMPACT_HINT, SET_DEF_HINT, SET_NAV_ICONS, SIDEBAR, STAT_DASH,
  SUMMARY_STATS, TAB_W, TOP_NAV, TOOLS1, TOOLS2, TREE, acctNavCy, chartX, explRowY, memoRowY, perfRowY,
  setNavCy, statRect,
} from './layout';
import { Chart10 } from './Chart10';

/** 面板卡片绝对定位的纵向原点:工作台骨架 top = 顶栏 40 */
const PANEL_TOP = 40;

/* ---------- 状态 ---------- */

export type H10 =
  | 'actDash' | 'memoAdd' | 'memoCopy' | 'memoText' | 'autoBtn' | 'dashSparkles'
  | 'dlgSend' | 'statDash' | 'defSel' | 'defOpt' | 'setSave'
  | null;

export interface Wb10State {
  pageT: { acct: number; set: number };
  /** 资源管理器 ⇄ 仪表盘(0 explorer,1 dashboard) */
  dashT: number;
  /* A:备忘录 */
  rowAdded: boolean;
  cell0: string;
  cell1: string;
  /** 新增行保存确认闪色 0..1 */
  rowFlash: number;
  /** 备忘文本键入内容 */
  memoText: string;
  memoFlash: number;
  copyChip: number;
  /* C/D:AI 产物卡片 */
  perfT: number;
  autoReady: boolean;
  chartT: number;
  chartDraw: number;
  tooltip: boolean;
  /* C/D:定制弹窗 + AI 会话 */
  dlg: 0 | 1 | 2;
  dlgT: number;
  dlgText: string;
  aiSess: boolean;
  user1T: number;
  tools1: number;
  sum1T: number;
  user2T: number;
  tools2: number;
  sum2T: number;
  /* B:账号页 */
  hintT: number;
  /* E:设置页 */
  dropOpen: boolean;
  defOptHover: boolean;
  valDash: boolean;
  savedToast: boolean;
  hover: H10;
  press: H10;
}

/* ---------- 小组件 ---------- */

const iconBtn = (opts: { hovered?: boolean; disabled?: boolean } = {}): React.CSSProperties => ({
  width: 24,
  height: 24,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 4,
  color: opts.disabled ? C.text2 : opts.hovered ? C.text0 : C.text1,
  background: opts.hovered ? C.bgHover : 'transparent',
  opacity: opts.disabled ? 0.55 : 1,
});

/** 输入框焦点虚线框(对照 .dash-cell-input:focus / .dash-memo:focus 的 dashed outline) */
const focusOutline = (focused: boolean): React.CSSProperties =>
  focused ? { outline: `1px dashed ${C.text2}`, outlineOffset: -3 } : {};

const Caret: React.FC = () => (
  <span
    style={{
      display: 'inline-block', width: 1.5, height: 13, background: C.accent, marginLeft: 1.5,
      verticalAlign: '-2px', opacity: 0.85,
    }}
  />
);

const btnSmall = (opts: { hovered?: boolean; primary?: boolean } = {}): React.CSSProperties => ({
  height: 26,
  padding: '0 10px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  borderRadius: 4,
  border: `1px solid ${opts.primary ? 'transparent' : C.border}`,
  background: opts.primary ? (opts.hovered ? C.accentHover : C.accent) : opts.hovered ? C.bg3 : C.bg2,
  color: opts.primary ? '#fff' : opts.hovered ? C.text0 : C.text1,
  fontSize: 12,
  lineHeight: '16px',
  whiteSpace: 'nowrap',
});

/* ---------- 活动栏 ---------- */

const ACT_ICONS: Record<(typeof ACT_ORDER)[number], IconName> = {
  dashboard: 'compass',
  explorer: 'folder',
  servers: 'monitor',
  commands: 'star',
  skills: 'sparkles',
  notes: 'pencil',
  timeline: 'timeline',
  browser: 'globe',
};

const ActivityBar: React.FC<{ st: Wb10State }> = ({ st }) => {
  const dashActive = st.dashT >= 0.5;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 48, background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6, gap: 2 }}>
      {ACT_ORDER.map((id, i) => {
        const active = (id === 'dashboard' && dashActive) || (id === 'explorer' && !dashActive);
        const hovered = id === 'dashboard' && (st.hover === 'actDash' || st.press === 'actDash');
        return (
          <div
            key={id}
            data-anchor={id === 'dashboard' ? 'act-dash' : undefined}
            title={id === 'dashboard' ? '仪表盘' : id === 'explorer' ? '文件资源管理器' : undefined}
            style={{
              width: 40, height: 40, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: '0 8px 8px 0', borderLeft: `2px solid ${active ? C.accent : 'transparent'}`,
              color: active ? C.accent : hovered ? C.text0 : C.text1,
              background: active || hovered ? C.bgHover : 'transparent',
            }}
          >
            <Icon name={ACT_ICONS[id]} size={18} />
          </div>
        );
      })}
      <div style={{ marginTop: 'auto', marginBottom: 6 }}>
        <div style={{ width: 26, height: 26, borderRadius: '50%', background: C.bg3, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
          <Icon name="user" size={14} />
        </div>
      </div>
    </div>
  );
};

/* ---------- 侧栏:资源管理器 ⇄ 仪表盘 ---------- */

const ExplorerPanel: React.FC<{ opacity: number }> = ({ opacity }) => (
  <div style={{ position: 'absolute', inset: 0, background: C.bg1, display: 'flex', flexDirection: 'column', overflow: 'hidden', opacity }}>
    <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 10px 0 14px', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: C.text1 }}>
      资源管理器
    </div>
    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      {TREE.map((node, i) => (
        <div
          key={node.name}
          style={{
            position: 'absolute', left: 0, right: 0, top: explRowY(i) - EXPL.top, height: EXPL.rowH,
            display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 10 + node.depth * EXPL.indent,
            fontSize: 12.5, color: C.text1,
          }}
        >
          <span style={{ display: 'flex', color: C.text2 }}><Icon name={node.icon} size={14} /></span>
          {node.name}
        </div>
      ))}
    </div>
  </div>
);

/* --- 仪表盘面板(对照 DashboardPanel.tsx + dashboard.css;局部坐标原点 = 窗口 (48,74)) --- */

const DashHeadActions: React.FC<{ st: Wb10State }> = ({ st }) => (
  <div style={{ position: 'absolute', right: 8, top: 5, display: 'flex', gap: 2 }}>
    <span data-anchor="dash-sparkles" title="定制仪表盘(描述需求,AI 自动定制)" style={iconBtn({ hovered: st.hover === 'dashSparkles' || st.press === 'dashSparkles' })}>
      <Icon name="sparkles" size={14} />
    </span>
    <span
      data-anchor="dash-auto"
      title={st.autoReady ? '暂停自动刷新' : '恢复自动刷新'}
      style={iconBtn({ disabled: !st.autoReady, hovered: st.autoReady && st.hover === 'autoBtn' })}
    >
      <Icon name={st.autoReady ? 'pause' : 'play'} size={13} />
    </span>
    <span title="刷新" style={iconBtn()}>
      <Icon name="refresh" size={13} />
    </span>
  </div>
);

/** 备忘录卡:置顶可编辑表格(table.json)+ 备忘文本(memo.md);失焦即保存,行闪色表达提交 */
const MemoCard: React.FC<{ st: Wb10State }> = ({ st }) => {
  const rows = [...MEMO_ROWS, ...(st.rowAdded ? [{ k: st.cell0, v: st.cell1 }] : [])];
  const flash = st.rowFlash;
  return (
    <div style={{ position: 'absolute', left: 8, top: MEMO.y - PANEL_TOP, width: BODY.w, border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg2, overflow: 'hidden' }}>
      <div style={{ padding: '6px 10px', fontSize: 12, fontWeight: 600, color: C.text2, borderBottom: `1px solid ${C.border}` }}>备忘录</div>
      {/* 可编辑表格(容器显式高:行均为绝对定位,锚点按构造正确) */}
      <div style={{ position: 'relative', height: MEMO.headH + rows.length * MEMO.rowH, borderBottom: `1px solid ${C.border}` }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: MEMO.headH, display: 'flex', alignItems: 'center', background: C.bg2 }}>
          <span style={{ position: 'absolute', left: 0, width: MEMO.col1W, padding: '0 10px', boxSizing: 'border-box', fontSize: 12, fontWeight: 600, color: C.text2 }}>项目</span>
          <span style={{ position: 'absolute', left: MEMO.col1W, width: BODY.w - MEMO.col1W - MEMO.opsW, height: '100%', padding: '0 10px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', fontSize: 12, fontWeight: 600, color: C.text2, borderLeft: `1px solid ${C.border}` }}>内容</span>
          <span
            data-anchor="memo-add"
            title="新增行"
            style={{ position: 'absolute', right: 0, width: MEMO.opsW, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: st.hover === 'memoAdd' || st.press === 'memoAdd' ? C.text0 : C.text2, background: st.hover === 'memoAdd' ? C.bgHover : 'transparent' }}
          >
            <Icon name="plus" size={12} />
          </span>
        </div>
        {rows.map((r, i) => {
          const isNew = st.rowAdded && i === rows.length - 1;
          const flashBg = isNew && flash > 0.01 ? `rgba(78,201,138,${(0.22 * flash).toFixed(3)})` : 'transparent';
          return (
            <div key={i} style={{ position: 'absolute', left: 0, right: 0, top: MEMO.headH + i * MEMO.rowH, height: MEMO.rowH, borderTop: `1px solid ${C.border}`, background: flashBg }}>
              <span style={{ position: 'absolute', left: 0, width: MEMO.col1W, height: '100%', padding: '0 10px', boxSizing: 'border-box', display: 'flex', alignItems: 'center', fontSize: 12, color: C.text0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
                {isNew ? (
                  <span data-anchor="memo-cell0" style={{ width: '100%', ...focusOutline(isNew && st.cell0.length < NEW_K.length) }}>
                    {r.k}
                    {isNew && st.cell0.length < NEW_K.length && <Caret />}
                  </span>
                ) : r.k}
              </span>
              <span style={{ position: 'absolute', left: MEMO.col1W, width: BODY.w - MEMO.col1W - MEMO.opsW, height: '100%', boxSizing: 'border-box' }}>
                <span
                  data-anchor={isNew ? 'memo-cell1' : `memo-v-${i}`}
                  style={{
                    position: 'absolute', inset: 0, padding: '0 24px 0 10px', display: 'flex', alignItems: 'center',
                    fontSize: 12, color: C.text0, borderLeft: `1px solid ${C.border}`, overflow: 'hidden', whiteSpace: 'nowrap',
                    ...focusOutline(isNew && st.cell0.length >= NEW_K.length && st.cell1.length < NEW_V.length),
                  }}
                >
                  {r.v}
                  {isNew && st.cell0.length >= NEW_K.length && st.cell1.length < NEW_V.length && <Caret />}
                </span>
                {/* 复制到剪贴板(hover 显现;第二列起) */}
                <span
                  data-anchor={i === 0 ? 'memo-copy' : undefined}
                  title="复制到剪贴板"
                  style={{
                    position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', display: 'flex',
                    color: C.text2, opacity: i === 0 && (st.hover === 'memoCopy' || st.press === 'memoCopy' || st.copyChip > 0.01) ? 1 : 0,
                  }}
                >
                  <Icon name="copy" size={11} />
                </span>
              </span>
              <span style={{ position: 'absolute', right: 0, width: MEMO.opsW, height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2 }}>
                <Icon name="trash" size={11} />
              </span>
            </div>
          );
        })}
      </div>
      {/* 备忘文本 */}
      <div
        data-anchor="memo-text"
        style={{
          position: 'relative', height: MEMO.textH, padding: '8px 10px', boxSizing: 'border-box',
          fontSize: 12.5, lineHeight: 1.6, color: C.text1, whiteSpace: 'pre-wrap', ...focusOutline(st.memoText.length > 0 && st.memoFlash <= 0.01),
        }}
      >
        {st.memoText || <span style={{ color: C.text2 }}>记录关键信息…</span>}
        {st.memoText.length > 0 && st.memoText.length < MEMO_L1.length + 1 + MEMO_L2.length && <Caret />}
      </div>
      {/* 已复制浮标(视频示意:真实 toast 在窗口右下,特写镜头外) */}
      {st.copyChip > 0.01 && (
        <div
          style={{
            position: 'absolute', right: 14, bottom: 8, padding: '3px 9px',
            borderRadius: 5, background: 'rgba(20,23,30,0.96)', border: `1px solid ${C.borderStrong}`,
            fontSize: 11, color: C.green, opacity: st.copyChip, whiteSpace: 'nowrap', boxShadow: '0 4px 14px rgba(0,0,0,0.5)',
          }}
        >
          已复制
        </div>
      )}
    </div>
  );
};

const MdCard: React.FC = () => (
  <div style={{ position: 'absolute', left: 8, top: MD.y - PANEL_TOP, width: BODY.w, border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg2, overflow: 'hidden' }}>
    <div style={{ padding: '6px 10px', fontSize: 12, fontWeight: 600, color: C.text2, borderBottom: `1px solid ${C.border}` }}>项目概览</div>
    <div style={{ padding: '8px 10px', fontSize: 12.5, lineHeight: 1.6, color: C.text1 }}>
      {MEMO_MD.map((l) => (
        <div key={l} style={{ display: 'flex', gap: 6 }}>
          <span style={{ color: C.text2 }}>·</span>
          <span>{l}</span>
        </div>
      ))}
    </div>
  </div>
);

const PerfCard: React.FC<{ st: Wb10State }> = ({ st }) => (
  <div
    data-anchor="perf-card"
    style={{
      position: 'absolute', left: 8, top: PERF.y - PANEL_TOP, width: BODY.w,
      border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg2, overflow: 'hidden',
      opacity: st.perfT, transform: `translateY(${(1 - st.perfT) * 14}px)`,
    }}
  >
    <div style={{ padding: '6px 10px', fontSize: 12, fontWeight: 600, color: C.text2, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>
      服务器性能监控（2 台 · 30s 自动刷新）
    </div>
    <div style={{ position: 'relative', height: PERF.headH + PERF_ROWS.length * PERF.rowH }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: PERF.headH, display: 'flex', alignItems: 'center', background: C.bg2 }}>
        {PERF_COLS.map((c) => (
          <span key={c.key} style={{ position: 'absolute', left: c.x - BODY.x, fontSize: 11.5, fontWeight: 600, color: C.text2, whiteSpace: 'nowrap' }}>{c.title}</span>
        ))}
      </div>
      {PERF_ROWS.map((r, i) => (
        <div key={r.name} style={{ position: 'absolute', left: 0, right: 0, top: PERF.headH + i * PERF.rowH, height: PERF.rowH, display: 'flex', alignItems: 'center', borderTop: `1px solid ${C.border}` }}>
          {PERF_COLS.map((c) => (
            <span key={c.key} style={{ position: 'absolute', left: c.x - BODY.x, fontSize: 12, color: c.key === 'name' ? C.text0 : C.text1, fontFamily: c.key === 'name' ? undefined : FONT_MONO, whiteSpace: 'nowrap' }}>
              {r[c.key]}
            </span>
          ))}
        </div>
      ))}
    </div>
  </div>
);

const ChartCard: React.FC<{ st: Wb10State }> = ({ st }) => (
  <div
    data-anchor="chart-card"
    style={{
      position: 'absolute', left: 8, top: CHART.y - PANEL_TOP, width: BODY.w, height: CHART.titleH + CHART.h,
      border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg2, overflow: 'hidden',
      opacity: st.chartT, transform: `translateY(${(1 - st.chartT) * 14}px)`,
    }}
  >
    <div style={{ padding: '6px 10px', fontSize: 12, fontWeight: 600, color: C.text2, borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' }}>
      流量监控（近 24 小时 · 小时粒度）
    </div>
    {/* 图表容器:绝对定位于标题下方,原点 = 窗口 (56, CHART.y + titleH),与 Chart10 的 ORG 同一构造 */}
    <div style={{ position: 'absolute', left: 0, top: CHART.titleH, right: 0, bottom: 0 }}>
      <Chart10 draw={st.chartDraw} tooltip={st.tooltip} />
    </div>
  </div>
);

const DashboardPanel: React.FC<{ st: Wb10State }> = ({ st }) => (
  <div style={{ position: 'absolute', inset: 0, background: C.bg1, overflow: 'hidden', opacity: st.dashT }}>
    <div style={{ position: 'relative', height: DASH_HEAD.h, display: 'flex', alignItems: 'center', padding: '0 10px 0 14px', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: C.text1, borderBottom: `1px solid ${C.border}` }}>
      仪表盘
      <DashHeadActions st={st} />
    </div>
    <MemoCard st={st} />
    <MdCard />
    <PerfCard st={st} />
    <ChartCard st={st} />
  </div>
);

const Sidebar: React.FC<{ st: Wb10State }> = ({ st }) => (
  <div style={{ position: 'absolute', left: SIDEBAR.x, top: 0, bottom: 0, width: SIDEBAR.w, background: C.bg1, borderRight: `1px solid ${C.border}`, overflow: 'hidden' }}>
    <ExplorerPanel opacity={1 - st.dashT} />
    <DashboardPanel st={st} />
  </div>
);

/* ---------- 中央区:本地终端 ---------- */

const TermPane: React.FC = () => (
  <div style={{ position: 'absolute', left: CENTER.x, top: CENTER.tabBarH, width: CENTER.w, bottom: 0, background: '#0d1117', padding: '10px 14px', fontFamily: FONT_MONO, fontSize: 12.5, lineHeight: 1.75, overflow: 'hidden', boxSizing: 'border-box' }}>
    {DEMO.termLines.map((l, i) => (
      <div key={i} style={{ whiteSpace: 'pre', color: l.startsWith('$') ? C.text0 : C.text1 }}>
        {l.startsWith('$') && <span style={{ color: C.green }}>$ </span>}
        {l.startsWith('$') ? l.slice(2) : l || ' '}
      </div>
    ))}
  </div>
);

const CenterArea: React.FC = () => (
  <div style={{ position: 'absolute', left: CENTER.x, top: 0, bottom: 0, width: CENTER.w, display: 'flex', flexDirection: 'column', background: C.bg0 }}>
    <div style={{ height: CENTER.tabBarH, display: 'flex', alignItems: 'stretch', background: C.bg1, borderBottom: `1px solid ${C.border}`, overflow: 'hidden' }}>
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 12px', width: TAB_W, flex: 'none',
          borderRight: `1px solid ${C.border}`, borderTop: `2px solid ${C.accent}`,
          background: C.bg0, fontSize: 12.5, color: C.text0,
        }}
      >
        <span style={{ display: 'flex', flex: 'none' }}><Icon name="terminal" size={15} /></span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>本地终端</span>
      </div>
    </div>
    <TermPane />
  </div>
);

/* ---------- AI 面板(空新会话 ⇄ 定制会话) ---------- */

const ToolBar: React.FC<{ text: string; done: boolean; opacity: number }> = ({ text, done, opacity }) => (
  <div
    style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px', maxWidth: AI.itemW,
      background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6,
      fontFamily: FONT_MONO, fontSize: 10.5, color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', opacity,
    }}
  >
    <span style={{ display: 'flex', color: C.text2 }}><Icon name="wrench" size={11} /></span>
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
    {done && <span style={{ display: 'flex', color: C.green, flex: 'none' }}><Icon name="check" size={11} strokeWidth={3} /></span>}
  </div>
);

const AiCustomSession: React.FC<{ st: Wb10State }> = ({ st }) => {
  const L = (x: number, y: number): React.CSSProperties => ({ position: 'absolute', left: x - 1580, top: y - 80 });
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
      {/* 第一轮:性能监控 */}
      <div style={{ ...L(1580, 96), width: 320, display: 'flex', justifyContent: 'flex-end', opacity: st.user1T }}>
        <div style={{ maxWidth: 300, padding: '8px 11px', borderRadius: 10, borderBottomRightRadius: 3, background: C.accentDim, fontSize: 12, lineHeight: '19px' }}>
          {AI_REQ1}
        </div>
      </div>
      <div style={{ ...L(1590, 190), display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
        {TOOLS1.slice(0, st.tools1).map((t) => (
          <ToolBar key={t.text} text={t.text} done={t.done} opacity={1} />
        ))}
      </div>
      {st.sum1T > 0 && (
        <div style={{ ...L(1590, 334), width: 310, fontSize: 12, lineHeight: '19px', color: C.text0, opacity: st.sum1T, display: 'flex', gap: 6 }}>
          <span style={{ display: 'flex', color: C.green, flex: 'none', marginTop: 2 }}><Icon name="check" size={12} strokeWidth={3} /></span>
          <span>{AI_SUM1}</span>
        </div>
      )}
      {/* 第二轮:流量图表 */}
      <div style={{ ...L(1580, 396), width: 320, display: 'flex', justifyContent: 'flex-end', opacity: st.user2T }}>
        <div style={{ maxWidth: 300, padding: '8px 11px', borderRadius: 10, borderBottomRightRadius: 3, background: C.accentDim, fontSize: 12, lineHeight: '19px' }}>
          {AI_REQ2}
        </div>
      </div>
      <div style={{ ...L(1590, 486), display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-start' }}>
        {TOOLS2.slice(0, st.tools2).map((t) => (
          <ToolBar key={t.text} text={t.text} done={t.done} opacity={1} />
        ))}
      </div>
      {st.sum2T > 0 && (
        <div style={{ ...L(1590, 592), width: 310, fontSize: 12, lineHeight: '19px', color: C.text0, opacity: st.sum2T, display: 'flex', gap: 6 }}>
          <span style={{ display: 'flex', color: C.green, flex: 'none', marginTop: 2 }}><Icon name="check" size={12} strokeWidth={3} /></span>
          <span>{AI_SUM2}</span>
        </div>
      )}
    </div>
  );
};

const AiPanel: React.FC<{ st: Wb10State }> = ({ st }) => (
  <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: 340, background: C.bg1, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
    <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: 1, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '0 8px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, color: C.text0 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {st.aiSess ? '订单服务 · 定制仪表盘' : '新会话'}
        </span>
        <Icon name="chevronDown" size={12} color={C.text2} />
      </div>
      <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1, borderRadius: 4 }}>
        <Icon name="plus" size={14} />
      </div>
    </div>
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
      {st.aiSess && <AiCustomSession st={st} />}
    </div>
    <div style={{ flex: 'none', height: 148, boxSizing: 'border-box', borderTop: `1px solid ${C.border}`, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 0', fontSize: 11, color: C.text2, flex: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="bot" size={12} /> AI 模式
        </span>
        <div style={{ width: 74, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text0, fontSize: 12, boxSizing: 'border-box', flex: 'none' }}>
          全自动
          <Icon name="chevronDown" size={10} color={C.text2} />
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="zap" size={12} /> 思考强度
        </span>
        <div style={{ width: 78, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text0, fontSize: 12, boxSizing: 'border-box', flex: 'none' }}>
          高
          <Icon name="chevronDown" size={10} color={C.text2} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 10, fontSize: 11, lineHeight: '18px', background: C.accentDim, color: C.accentHover }}>
          <Icon name="monitor" size={11} />
          @local
        </span>
      </div>
      <div style={{ position: 'relative', flex: 1, minHeight: 0, padding: '8px 10px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12.5, lineHeight: '20px' }}>
        <span style={{ color: C.text2 }}>向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器/浏览器；可粘贴或插入图片</span>
        <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10.5, color: C.text2 }}>Enter 发送</span>
      </div>
    </div>
  </div>
);

/* ---------- 底栏 ---------- */

const Statusbar: React.FC = () => (
  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 26, display: 'flex', alignItems: 'center', padding: '0 8px', background: C.bg1, borderTop: `1px solid ${C.border}`, color: C.text1, fontSize: 11 }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 12 }}>
      <Icon name="folder" size={12} />
      {DEMO.projectName}
    </span>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.text2 }}>
      <Icon name="terminal" size={12} />
      本地终端
    </span>
    <div style={{ flex: 1 }} />
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 4, background: C.accentDim, color: C.accent }}>
      <Icon name="bot" size={12} /> AI 助手
    </span>
  </div>
);

/* ---------- 账号页(云同步视图) ---------- */

const AccountPage: React.FC<{ st: Wb10State }> = ({ st }) => (
  <div
    style={{
      position: 'absolute', left: 0, right: 0, top: 40, bottom: 0, background: C.bg0,
      opacity: st.pageT.acct, transform: `translateY(${(1 - st.pageT.acct) * 12}px)`,
    }}
  >
    {/* 校正层:页面原点在顶栏下方 40px,子元素直接用窗口坐标 */}
    <div style={{ position: 'absolute', left: 0, right: 0, top: -40, bottom: 0 }}>
    {/* 左导航(对照 account/Account.tsx) */}
    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: ACCT.navW, background: C.bg1, borderRight: `1px solid ${C.border}`, padding: '14px 8px', boxSizing: 'border-box' }}>
      {ACCT_NAV.map((item, i) => {
        const active = i === ACCT.navActive;
        return (
          <div
            key={item.label}
            style={{
              height: 40, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRadius: 6,
              fontSize: 12.5, color: active ? C.accent : C.text2, background: active ? C.accentDim : 'transparent',
              fontWeight: active ? 600 : 400,
            }}
          >
            <span style={{ display: 'flex' }}><Icon name={item.icon} size={14} /></span>
            {item.label}
          </div>
        );
      })}
      <span style={{ display: 'none' }}>{`${acctNavCy(ACCT.navActive)}`}</span>
    </div>
    {/* 云同步视图(对照 CloudSyncView) */}
    <div style={{ position: 'absolute', left: ACCT.contentX, right: 24, top: 0, bottom: 0, overflow: 'hidden' }}>
      {/* 工具栏 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: ACCT.toolbarY, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, height: 24, padding: '0 10px', borderRadius: 12, background: 'rgba(78,201,138,0.14)', border: `1px solid ${C.green}55`, fontSize: 12, color: C.green }}>
          <Icon name="cloudSync" size={12} /> 已就绪
        </span>
        <div style={{ flex: 1 }} />
        <span style={btnSmall()}><Icon name="refresh" size={11} /> 刷新</span>
        <span style={btnSmall({ primary: true })}><Icon name="sync" size={11} /> 立即同步</span>
        <span style={btnSmall()}><Icon name="lock" size={11} /> 锁定</span>
      </div>
      {/* 概要统计 */}
      <div style={{ position: 'absolute', left: 0, top: ACCT.summaryY, width: '100%', display: 'flex', gap: 12 }}>
        {SUMMARY_STATS.map((s) => (
          <div key={s.label} style={{ flex: 1, border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg1, padding: '10px 14px' }}>
            <div style={{ fontSize: 11, color: C.text2 }}>{s.label}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text0, marginTop: 3 }}>{s.value}</div>
          </div>
        ))}
      </div>
      {/* 配置同步规模 */}
      <div style={{ position: 'absolute', left: 0, top: ACCT.scaleTitleY, display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: C.text0 }}>
        <span style={{ display: 'flex', color: C.text1 }}><Icon name="cloudSync" size={14} /></span>
        配置同步规模
      </div>
      <div style={{ position: 'absolute', left: 12, top: ACCT.scaleGridY, width: '100%' }}>
        {SCALE_STATS.map((s, i) => {
          const r = statRect(i);
          const isDash = i === 9;
          return (
            <div
              key={s.label}
              data-anchor={isDash ? 'stat-dashboard' : undefined}
              style={{
                position: 'absolute', left: r.x - ACCT.contentX - 12, top: r.y - ACCT.scaleGridY, width: r.w, height: r.h,
                boxSizing: 'border-box', border: `1px solid ${isDash ? C.accent : C.border}`, borderRadius: 8,
                background: isDash ? 'rgba(79,142,247,0.10)' : C.bg1, padding: '9px 14px',
              }}
            >
              <div style={{ fontSize: 11, color: isDash ? C.accent : C.text2 }}>{s.label}</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: isDash ? C.text0 : C.text0, marginTop: 2 }}>{s.value}</div>
            </div>
          );
        })}
      </div>
      {/* 设备管理 */}
      <div style={{ position: 'absolute', left: 0, top: ACCT.devTitleY, display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: C.text0 }}>
        <span style={{ display: 'flex', color: C.text1 }}><Icon name="device" size={14} /></span>
        设备管理
      </div>
      <div style={{ position: 'absolute', left: 0, top: ACCT.devListY, width: 720 }}>
        {DEVICES.map((d) => (
          <div key={d.name} style={{ height: 36, display: 'flex', alignItems: 'center', gap: 9, fontSize: 12.5, color: C.text0 }}>
            <span style={{ display: 'flex', color: C.text2 }}><Icon name={d.current ? 'monitor' : 'device'} size={14} /></span>
            {d.name}
            <span style={{ fontSize: 11, color: C.text2 }}>最近活动:{d.last}</span>
          </div>
        ))}
      </div>
      {/* 换机恢复提示(B3) */}
      {st.hintT > 0 && (
        <div style={{ position: 'absolute', left: 0, top: ACCT.hintY, display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: C.green, opacity: st.hintT }}>
          <span style={{ display: 'flex' }}><Icon name="sync" size={14} /></span>
          {ACCT_HINT}
        </div>
      )}
      {/* 「仪表盘」统计格引用防抖(保持常量被消费) */}
      <span style={{ display: 'none' }}>{`${STAT_DASH.x},${STAT_DASH.y}`}</span>
    </div>
    </div>
  </div>
);

/* ---------- 设置页(外观) ---------- */

const SettingsPage: React.FC<{ st: Wb10State }> = ({ st }) => (
  <div
    style={{
      position: 'absolute', left: 0, right: 0, top: 40, bottom: 0, background: C.bg0,
      opacity: st.pageT.set, transform: `translateY(${(1 - st.pageT.set) * 12}px)`,
    }}
  >
    {/* 校正层:页面原点在顶栏下方 40px,子元素直接用窗口坐标 */}
    <div style={{ position: 'absolute', left: 0, right: 0, top: -40, bottom: 0 }}>
    {/* 左导航(对照 Settings.tsx SETTINGS_NAV) */}
    <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: SET.navW, background: C.bg1, borderRight: `1px solid ${C.border}`, padding: '14px 8px', boxSizing: 'border-box' }}>
      {SET.nav.map((label, i) => {
        const active = i === SET.navActive;
        return (
          <div
            key={label}
            style={{
              height: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRadius: 6,
              fontSize: 12.5, color: active ? C.accent : C.text2, background: active ? C.accentDim : 'transparent',
              fontWeight: active ? 600 : 400,
            }}
          >
            <span style={{ display: 'flex' }}><Icon name={SET_NAV_ICONS[i]} size={14} /></span>
            {label}
          </div>
        );
      })}
      <span style={{ display: 'none' }}>{`${setNavCy(SET.navActive)}`}</span>
    </div>
    {/* 外观面板(字段坐标均为窗口系;容器横跨全宽) */}
    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}>
      <div style={{ position: 'absolute', left: 228, top: SET.titleY, fontSize: 16, fontWeight: 600, color: C.text0 }}>外观</div>
      {/* 界面主题 */}
      <div style={{ position: 'absolute', left: SET.fieldX, top: SET.themeLabelY, fontSize: 13, color: C.text0 }}>界面主题</div>
      <div style={{ position: 'absolute', left: SET.themeSel.x, top: SET.themeSel.y, width: SET.themeSel.w, height: SET.themeSel.h, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px', background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text0 }}>
        深色
        <Icon name="chevronDown" size={12} color={C.text2} />
      </div>
      <div style={{ position: 'absolute', left: SET.fieldX, top: SET.themeHintY, fontSize: 11.5, color: C.text2 }}>选择后立即生效;顶栏 ☀/☾ 按钮亦可快捷切换</div>
      {/* 服务器紧凑布局 */}
      <div style={{ position: 'absolute', left: SET.fieldX, top: SET.compactLabelY, fontSize: 13, color: C.text0 }}>服务器紧凑布局</div>
      <div style={{ position: 'absolute', left: SET.compactCheck.x, top: SET.compactCheck.y, width: SET.compactCheck.w, height: SET.compactCheck.h, borderRadius: 4, border: `1.5px solid ${C.borderStrong}`, boxSizing: 'border-box' }} />
      <div style={{ position: 'absolute', left: SET.fieldX, top: SET.compactHintY, width: 640, fontSize: 11.5, lineHeight: 1.6, color: C.text2 }}>{SET_COMPACT_HINT}</div>
      {/* 菜单栏默认打开 */}
      <div style={{ position: 'absolute', left: SET.fieldX, top: SET.defLabelY, fontSize: 13, color: C.text0 }}>菜单栏默认打开</div>
      <div
        data-anchor="set-default-select"
        style={{
          position: 'absolute', left: SET.defSel.x, top: SET.defSel.y, width: SET.defSel.w, height: SET.defSel.h, boxSizing: 'border-box',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px',
          background: C.bg1, border: `1px solid ${st.defOptHover || st.dropOpen ? C.accent : C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text0,
        }}
      >
        {st.valDash ? '仪表盘' : '本地文件'}
        <Icon name="chevronDown" size={12} color={C.text2} />
      </div>
      <div style={{ position: 'absolute', left: SET.fieldX, top: SET.defHintY, fontSize: 11.5, color: C.text2 }}>{SET_DEF_HINT}</div>
      {/* 下拉选项(打开期间挂载;anchor 消费窗口在其内) */}
      {st.dropOpen && (
        <div style={{ position: 'absolute', left: SET.drop.x, top: SET.drop.y, width: SET.drop.w, padding: SET.drop.pad, background: C.bg2, border: `1px solid ${C.borderStrong}`, borderRadius: 6, boxShadow: '0 6px 24px rgba(0,0,0,0.5)', zIndex: 45 }}>
          {DROP_OPTS.map((o, i) => {
            const sel = (st.valDash && o === '仪表盘') || (!st.valDash && o === '本地文件');
            const hovered = o === '仪表盘' && st.defOptHover;
            return (
              <div
                key={o}
                data-anchor={o === '仪表盘' ? 'set-opt-dashboard' : undefined}
                style={{
                  height: SET.drop.optH, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  padding: '0 10px', borderRadius: 4, fontSize: 12.5,
                  color: hovered || sel ? C.text0 : C.text1, background: hovered ? C.bgHover : 'transparent',
                }}
              >
                {o}
                {sel && <span style={{ display: 'flex', color: C.accent }}><Icon name="check" size={12} strokeWidth={3} /></span>}
              </div>
            );
          })}
        </div>
      )}
      {/* 保存 */}
      <div
        data-anchor="set-save"
        style={{
          position: 'absolute', left: SET.save.x, top: SET.save.y, width: SET.save.w, height: SET.save.h,
          display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, fontSize: 12.5,
          color: '#fff', background: st.hover === 'setSave' || st.press === 'setSave' ? C.accentHover : C.accent,
        }}
      >
        保存
      </div>
    </div>
    </div>
  </div>
);

/* ---------- 「定制仪表盘」promptDialog(对照 src/ui.ts multiline 形态) ---------- */

const PromptDialog: React.FC<{ st: Wb10State }> = ({ st }) => {
  if (!st.dlg) return null;
  const t = st.dlgT;
  const L = (x: number, y: number): React.CSSProperties => ({ position: 'absolute', left: x - DLG.x, top: y - DLG.y });
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute', left: DLG.x, top: DLG.y, width: DLG.w, height: DLG.h, boxSizing: 'border-box',
          background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
        }}
      >
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: DLG_F.headH, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 16px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>定制仪表盘</span>
          <Icon name="x" size={14} color={C.text2} />
        </div>
        <div style={{ ...L(DLG_F.input.x, DLG_F.labelY), width: DLG_F.input.w, fontSize: 12, lineHeight: 1.55, color: C.text1 }}>
          {DLG_LABEL}
        </div>
        <div
          data-anchor="dlg-input"
          style={{
            ...L(DLG_F.input.x, DLG_F.input.y), width: DLG_F.input.w, height: DLG_F.input.h, boxSizing: 'border-box',
            padding: '8px 10px', background: C.bg0, border: `1px solid ${C.accent}`, borderRadius: 4,
            fontSize: 12.5, lineHeight: '20px', color: C.text0, whiteSpace: 'pre-wrap', overflow: 'hidden',
          }}
        >
          {st.dlgText}
          <Caret />
        </div>
        <div style={{ ...L(DLG_F.input.x, DLG_F.hintY), fontSize: 11, color: C.text2 }}>
          Ctrl+Enter 确认，Enter 换行
        </div>
        <div style={{ ...L(DLG_F.btnCancel.x, DLG_F.btnCancel.y), width: DLG_F.btnCancel.w, height: DLG_F.btnCancel.h, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text1 }}>
          取消
        </div>
        <div
          data-anchor="dlg-send"
          style={{
            ...L(DLG_F.btnSend.x, DLG_F.btnSend.y), width: DLG_F.btnSend.w, height: DLG_F.btnSend.h,
            display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, fontSize: 12.5, color: '#fff',
            background: st.hover === 'dlgSend' || st.press === 'dlgSend' ? C.accentHover : C.accent,
          }}
        >
          发送给 AI
        </div>
      </div>
    </div>
  );
};

/* ---------- toast ---------- */

const Toast: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      position: 'absolute', right: 24, bottom: 34, padding: '11px 18px', background: C.bg2,
      border: `1px solid ${C.borderStrong}`, borderRadius: 8, fontSize: 12.5,
      boxShadow: '0 8px 32px rgba(0,0,0,0.55)', whiteSpace: 'nowrap', zIndex: 46,
    }}
  >
    {text}
  </div>
);

/* ---------- 主组件 ---------- */

export const Wb10: React.FC<{ state: Wb10State; frame: number }> = ({ state: st, frame }) => {
  void frame;
  const topActive = st.pageT.set > 0.5 ? '设置' : st.pageT.acct > 0.5 ? '账号' : '项目';
  const wbOpacity = 1 - Math.max(st.pageT.acct, st.pageT.set);
  return (
    <div
      style={{
        position: 'absolute', width: WIN_W, height: WIN_H, background: C.bg0, color: C.text0,
        fontFamily: FONT_UI, fontSize: 13, borderRadius: 14, border: `1px solid ${C.borderStrong}`,
        overflow: 'hidden', boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
      }}
    >
      <TopBar
        active={topActive}
        project={DEMO.projectName}
        version="v1.2.5"
        anchors={{ project: 'tb-project', settings: 'tb-settings', account: 'tb-account' }}
      />

      {/* 工作台骨架 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 26, opacity: wbOpacity }}>
        <ActivityBar st={st} />
        <Sidebar st={st} />
        <CenterArea />
        <AiPanel st={st} />
        <Statusbar />
      </div>

      {/* 账号页 / 设置页(叠放交叉淡化,保持挂载) */}
      <AccountPage st={st} />
      <SettingsPage st={st} />

      {/* 弹层:toast 46 < 弹窗 50 */}
      {st.savedToast && <Toast text={DEMO.saveToast} />}
      <PromptDialog st={st} />

      {/* 指针轨道兜底 park 点(零尺寸锚点,全程挂载;canvas 坐标由测量归一化) */}
      <span data-anchor="park-low" style={{ position: 'absolute', left: 700, top: 700, width: 0, height: 0 }} />
      <span data-anchor="park-ai" style={{ position: 'absolute', left: 1300, top: 900, width: 0, height: 0 }} />
      <span data-anchor="park-exit" style={{ position: 'absolute', left: 1500, top: 1050, width: 0, height: 0 }} />
      {/* 布局常量引用防抖 */}
      <span style={{ display: 'none' }}>{`${MEMO_ADD.x},${chartX(0)},${MEMO_COPY.x},${MEMO_COL2_X}`}</span>
    </div>
  );
};
