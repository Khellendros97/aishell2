/**
 * 视频九客户端画面复刻:时间线云同步。工作台(本地终端 ⇄ 时间线标签页 + AI 静态历史 +
 * 资源管理器)与设置页(左导航 + 「时间线云同步」fieldset + C3 悬停提示小卡)双页面
 * (pageT 淡入淡出);弹层:打标签右键菜单 ×2、TagDialog ×2、「删除云端时间线」确认框、toast。
 * 全部内容由 state(Wb9State)驱动,锚点见 ./layout.ts;各层均 inset:0 绝对定位,子元素
 * 直接用窗口坐标(无校正层)。
 */
import React from 'react';
import { TopBar } from '../components/TopBar';
import { C, FONT_MONO, FONT_UI, IconName } from '../theme';
import { Icon } from '../ui';
import { WIN_H, WIN_W } from '../scene';
import {
  ACT_TL, ADLG9, ADLG9_F, AI2, AI2_ASK, AI2_LINES, ANALYZE_TAGS, CENTER, CFM9, CFM9_BTN, CHAT, ChatSpec,
  DEMO, DLG9, DLG9_F, EXPL, ITEM_W, KIND_META, MENU9,
  MENU9_ITEM, MENU9_Y1, MENU9_Y2, PALETTE, PROG, SET, SET_HINT, TAB_TERM_X, TAB_TL_C,
  TAB_TL_X, TAB_W, TAG2_COLOR, TAG_COLOR, TERM_BASE, TERM_CMD, TERM_OUT, TermLine, TIP_CARD, TL, TL_COL,
  TL_ROWS, TOAST_POS, TREE, explRowY, menuItemCy, paletteCx, setNavCy, tlRowY,
} from './layout';
import type { TlRowStateA, TlRowStateB } from './script';

/* ---------- 状态 ---------- */

export type H9 =
  | 'actTl' | 'tlTab' | 'rowTag1' | 'rowTag2' | 'menuItem' | 'dlgOk' | 'tagChip'
  | 'aiBtn' | 'anaCheck' | 'anaOk' | 'askSave'
  | 'setNav' | 'purgeBtn' | 'cfmOk'
  | null;

export interface Wb9State {
  page: 'workbench' | 'settings';
  pageT: number;
  /** 时间线标签已打开(入口点击后 true) */
  tlOpen: boolean;
  /** 本地终端 ⇄ 时间线标签页 */
  tlT: number;
  /** 时间线行渐显条数 */
  rowsShown: number;
  /** 右键菜单(单实例,两次出现仅 y 不同) */
  menu: { y: number; hover: boolean } | null;
  dlg: 'tag1' | 'tag2' | null;
  dlgT: number;
  dlgText: string;
  tag1: boolean;
  tag2: boolean;
  /** 选区着色 0..1 */
  regionT: number;
  tagFilter: boolean;
  /** 列表交叉淡化 0..1(1=只显示筛选后列表) */
  filterT: number;
  termChars: number;
  termOut: number;
  /** 底栏 SFTP 上传进度 */
  uploadP: number | null;
  /* ---- B2:AI 分析 ---- */
  analyzeDlg: boolean;
  analyzeT: number;
  /** 「发布」标签已勾选 */
  anaChecked: boolean;
  aiView: 'history' | 'analysis';
  /** 分析会话:用户气泡淡入 0..1 */
  aiUserT: number;
  /** timeline_search 工具调用条 */
  aiTool: boolean;
  /** 流式总结可见行数(0..AI2_LINES.length) */
  aiLines: number;
  /** ask 保存卡淡入 0..1 */
  askT: number;
  askSaved: boolean;
  /* ---- C/E:设置页 ---- */
  tipCard: boolean;
  purgeDlg: boolean;
  purgeT: number;
  toast: string | null;
  hover: H9;
  press: H9;
}

/* ---------- 小组件 ---------- */

const Spinner: React.FC<{ frame?: number; size?: number; color?: string }> = ({ frame = 0, size = 11, color = C.text2 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} style={{ opacity: frame % 20 < 10 ? 1 : 0.45 }}>
    <g fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round">
      <path d="M12 3a9 9 0 1 1-9 9" opacity={0.35} />
      <path d="M12 3a9 9 0 0 1 6.4 2.6" />
    </g>
  </svg>
);

const btnSmall = (opts: { hovered?: boolean; dangerSolid?: boolean } = {}): React.CSSProperties => ({
  height: 28,
  padding: '0 10px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  borderRadius: 4,
  border: `1px solid ${opts.dangerSolid ? C.red : C.border}`,
  background: opts.dangerSolid ? (opts.hovered ? '#f0777e' : C.red) : opts.hovered ? C.bg3 : C.bg2,
  color: opts.dangerSolid ? '#fff' : opts.hovered ? C.text0 : C.text1,
  fontSize: 12,
  lineHeight: '16px',
  whiteSpace: 'nowrap',
});

/* ---------- 活动栏 / 资源管理器 ---------- */

const ACT_ITEMS = [
  { icon: 'folder', id: 'explorer' },
  { icon: 'monitor', id: 'servers' },
  { icon: 'star', id: 'commands' },
  { icon: 'sparkles', id: 'skills' },
  { icon: 'pencil', id: 'notes' },
  /* 时间线入口:对照主仓 Workbench.tsx,在 notes 与 browser 之间(点击在中央区开标签页) */
  { icon: 'timeline', id: 'timeline' },
  { icon: 'globe', id: 'browser' },
] as const;

const ActivityBar: React.FC<{ st: Wb9State }> = ({ st }) => (
  <div style={{ width: 48, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6, gap: 2 }}>
    {ACT_ITEMS.map((it) => {
      const active = it.id === 'explorer';
      const hovered = it.id === 'timeline' && (st.hover === 'actTl' || st.press === 'actTl');
      return (
        <div
          key={it.id}
          data-anchor={it.id === 'timeline' ? 'w9-act-tl' : undefined}
          style={{
            width: 40, height: 40, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: '0 8px 8px 0', borderLeft: `2px solid ${active ? C.accent : 'transparent'}`,
            color: active ? C.accent : hovered ? C.text0 : C.text1,
            background: active || hovered ? C.bgHover : 'transparent',
          }}
        >
          <Icon name={it.icon as IconName} size={18} />
        </div>
      );
    })}
    <span style={{ display: 'none' }}>{`${ACT_TL.x},${ACT_TL.y}`}</span>
    <div style={{ marginTop: 'auto', marginBottom: 6 }}>
      <div style={{ width: 26, height: 26, borderRadius: '50%', background: C.bg3, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
        <Icon name="user" size={14} />
      </div>
    </div>
  </div>
);

const ExplorerPanel: React.FC = () => (
  <div style={{ width: 260, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
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

/* ---------- 标签栏 ---------- */

const TabBar: React.FC<{ st: Wb9State }> = ({ st }) => (
  <div style={{ height: CENTER.tabBarH, display: 'flex', alignItems: 'stretch', background: C.bg1, borderBottom: `1px solid ${C.border}`, overflow: 'hidden' }}>
    {/* 本地终端常驻;时间线标签在活动栏入口点击后才出现(对照主仓 openTab 单实例激活) */}
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 12px', width: TAB_W, flex: 'none',
        borderRight: `1px solid ${C.border}`, borderTop: `2px solid ${st.tlT < 0.5 ? C.accent : 'transparent'}`,
        background: st.tlT < 0.5 ? C.bg0 : 'transparent', fontSize: 12.5, color: st.tlT < 0.5 ? C.text0 : C.text1,
      }}
    >
      <span style={{ display: 'flex', flex: 'none' }}><Icon name="terminal" size={15} /></span>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>本地终端</span>
    </div>
    {st.tlOpen && (
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 12px', width: TAB_W, flex: 'none',
          borderRight: `1px solid ${C.border}`, borderTop: `2px solid ${st.tlT >= 0.5 ? C.accent : 'transparent'}`,
          background: st.tlT >= 0.5 ? C.bg0 : 'transparent', fontSize: 12.5, color: st.tlT >= 0.5 ? C.text0 : C.text1,
          opacity: Math.min(1, st.tlT * 2),
        }}
      >
        <span style={{ display: 'flex', flex: 'none' }}><Icon name="timeline" size={15} /></span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>时间线</span>
      </div>
    )}
    <span style={{ display: 'none' }}>{`${TAB_TL_C.x},${TAB_TL_C.y}`}</span>
  </div>
);

/* ---------- 终端 ---------- */

const TermPane: React.FC<{ st: Wb9State; frame: number }> = ({ st, frame }) => {
  const lines: (TermLine | { out: string })[] = [
    ...TERM_BASE,
    { prompt: true, cmd: TERM_CMD.slice(0, st.termChars) },
    ...TERM_OUT.slice(0, st.termOut).map((out) => ({ out })),
  ];
  return (
    <div style={{ position: 'absolute', left: CENTER.x, top: 76, width: CENTER.w, height: 1174 - 76, background: '#0d1117', padding: '10px 14px', fontFamily: FONT_MONO, fontSize: 12.5, lineHeight: 1.75, overflow: 'hidden', opacity: 1 - st.tlT, boxSizing: 'border-box' }}>
      {lines.map((l, i) => {
        const isPrompt = 'prompt' in l && !!l.prompt;
        const isCmd = 'cmd' in l;
        const text = 'out' in l ? l.out : 'cmd' in l ? l.cmd ?? '' : l.text ?? ' ';
        return (
          <div key={i} style={{ whiteSpace: 'pre', color: isCmd ? C.text0 : C.text1 }}>
            {isPrompt && <span style={{ color: C.green }}>$ </span>}
            {text}
            {isPrompt && (
              <span style={{ display: 'inline-block', width: 7, height: 14, background: C.text1, verticalAlign: '-2px', marginLeft: 2, opacity: frame % 32 < 16 ? 1 : 0 }} />
            )}
          </div>
        );
      })}
    </div>
  );
};

/* ---------- 时间线标签页 ---------- */

interface RowTag { name: string; direct: boolean }

const TagChip: React.FC<{ tag: RowTag; small?: boolean }> = ({ tag, small }) => (
  <span
    style={{
      display: 'inline-flex', alignItems: 'center', gap: 2, height: small ? 18 : 20, padding: '0 7px',
      borderRadius: 9, fontSize: small ? 10.5 : 11, border: `1px ${tag.direct ? 'solid' : 'dashed'} ${tag.name === DEMO.tag1Name ? TAG_COLOR : TAG2_COLOR}`,
      color: tag.name === DEMO.tag1Name ? TAG_COLOR : TAG2_COLOR, whiteSpace: 'nowrap',
    }}
  >
    <span style={{ display: 'flex' }}><Icon name="hash" size={10} /></span>
    {tag.name}
  </span>
);

const TlRow: React.FC<{ i: number; y: number; opacity: number; tag?: string; region: number }> = ({ i, y, opacity, tag, region }) => {
  const row = TL_ROWS[i];
  const meta = KIND_META[row.kind];
  const direct = !!tag;
  const bg = direct ? 'rgba(79,142,247,0.18)' : region > 0.01 ? `rgba(79,142,247,${(0.16 * region).toFixed(3)})` : 'transparent';
  return (
    <div
      data-anchor={i === 1 ? 'w9-tl-row-1' : i === 5 ? 'w9-tl-row-5' : undefined}
      style={{
        position: 'absolute', left: TL.rowX - CENTER.x, top: y - 76, width: TL.rowW, height: TL.rowH - 2, boxSizing: 'border-box',
        borderRadius: 4, background: bg, opacity,
        display: 'flex', alignItems: 'center', paddingLeft: 10, gap: 0, overflow: 'hidden', whiteSpace: 'nowrap',
      }}
    >
      <span style={{ position: 'absolute', left: TL_COL.icon - TL.rowX, display: 'flex', color: C.text2 }}><Icon name={meta.icon} size={14} /></span>
      <span style={{ position: 'absolute', left: TL_COL.time - TL.rowX, fontFamily: FONT_MONO, fontSize: 11.5, color: C.text2 }}>{row.time}</span>
      <span style={{ position: 'absolute', left: TL_COL.kind - TL.rowX, fontSize: 11.5, color: C.text1 }}>{meta.label}</span>
      <span style={{ position: 'absolute', left: TL_COL.summary - TL.rowX, right: 130, fontSize: 12.5, color: C.text0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{row.summary}</span>
      {tag && (
        <span style={{ position: 'absolute', right: 12 }}>
          <TagChip tag={{ name: tag, direct: true }} small />
        </span>
      )}
      {!tag && region > 0.05 && (
        <span style={{ position: 'absolute', right: 12 }}>
          <TagChip tag={{ name: DEMO.tag1Name, direct: false }} small />
        </span>
      )}
    </div>
  );
};

/** 每行的标签/选区状态(script 按帧推导注入) */
const TimelinePanel: React.FC<{ st: Wb9State; rowsA: TlRowStateA[]; rowsB: TlRowStateB[] }> = ({ st, rowsA, rowsB }) => (
  <div style={{ position: 'absolute', left: CENTER.x, top: 76, width: CENTER.w, height: 1174 - 76, background: C.bg0, opacity: st.tlT, overflow: 'hidden' }}>
    {/* 工具栏 */}
    <div style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: TL.toolH, display: 'flex', alignItems: 'center', borderBottom: `1px solid ${C.border}`, paddingLeft: 14, gap: 8 }}>
      <span style={{ fontSize: 13.5, fontWeight: 600, color: C.text0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <span style={{ display: 'flex', color: C.text1 }}><Icon name="history" size={15} /></span>
        时间线
      </span>
      <span style={{ position: 'absolute', left: TL.search.x - CENTER.x, top: TL.search.y - 76, width: TL.search.w, height: TL.search.h, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, color: C.text2 }}>
        <Icon name="search" size={13} />
        搜索摘要与内容，#标签 按标签过滤…
      </span>
      {['全部', '今天', '近7天', '近30天'].map((r, i) => (
        <span
          key={r}
          style={{
            position: 'absolute', left: TL.rangeX - CENTER.x + i * 58, top: TL.search.y - 76, height: 28, padding: '0 10px',
            display: 'inline-flex', alignItems: 'center', borderRadius: 4, fontSize: 12,
            color: i === 0 ? C.text0 : C.text1, background: i === 0 ? C.bg3 : 'transparent', border: `1px solid ${i === 0 ? C.borderStrong : C.border}`,
          }}
        >
          {r}
        </span>
      ))}
      <span style={{ position: 'absolute', left: TL.refreshBtn.x - CENTER.x, top: TL.refreshBtn.y - 76, width: TL.refreshBtn.w, boxSizing: 'border-box', ...btnSmall() }}>
        <Icon name="refresh" size={12} /> 刷新
      </span>
      <span
        data-anchor="w9-ai-btn"
        style={{
          position: 'absolute', left: TL.aiBtn.x - CENTER.x, top: TL.aiBtn.y - 76, width: TL.aiBtn.w, boxSizing: 'border-box',
          ...btnSmall({ hovered: st.hover === 'aiBtn' }),
        }}
      >
        <Icon name="sparkles" size={12} /> AI 分析
      </span>
    </div>
    {/* 标签 chips 行(对照主仓:仅已存在的标签显示;「排查」为存量标签,「发布」B1 打标后才出现) */}
    <div style={{ position: 'absolute', left: 14, top: TL.tagsY - 76, height: TL.tagsH, display: 'flex', alignItems: 'center', gap: 8 }}>
      {[
        { name: DEMO.tag1Name, color: TAG_COLOR, active: st.tagFilter, show: st.tag1 },
        { name: '排查', color: TAG2_COLOR, active: false, show: true },
      ].filter((t) => t.show).map((t) => (
        <span
          key={t.name}
          data-anchor={t.name === DEMO.tag1Name ? 'w9-tag-chip' : undefined}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, height: 24, padding: '0 10px', borderRadius: 12,
            fontSize: 12, background: t.active ? 'rgba(79,142,247,0.18)' : C.bg1,
            border: `1px solid ${t.active ? TAG_COLOR : C.border}`, color: t.color,
          }}
        >
          <Icon name="hash" size={11} /> {t.name}
        </span>
      ))}
    </div>
    {/* 类别 chips 行 */}
    <div style={{ position: 'absolute', left: 14, top: TL.kindsY - 76, height: TL.kindsH, display: 'flex', alignItems: 'center', gap: 6 }}>
      {['连接', '命令', '上传', '下载', '提问', '回答', '工具'].map((k) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 24, padding: '0 9px', borderRadius: 4, fontSize: 11.5, background: C.bg1, border: `1px solid ${C.border}`, color: C.text1 }}>
          {k}
        </span>
      ))}
    </div>
    {/* 事件列表:全量 ⇄ 筛选后交叉淡化 */}
    <div style={{ position: 'absolute', inset: 0, opacity: 1 - st.filterT }}>
      {rowsA.map((r, i) => (
        <TlRow key={TL_ROWS[i].id} i={i} y={tlRowY(i)} opacity={r.opacity} tag={r.tag} region={r.region} />
      ))}
    </div>
    <div style={{ position: 'absolute', inset: 0, opacity: st.filterT }}>
      {rowsB.map((r, j) => (
        <TlRow key={TL_ROWS[r.i].id} i={r.i} y={tlRowY(j)} opacity={1} tag={r.tag} region={r.region} />
      ))}
    </div>
    {/* 状态行 */}
    <div style={{ position: 'absolute', left: 14, top: TL.statusY - 76, fontSize: 11.5, color: C.text2 }}>
      共 {st.tagFilter ? rowsB.length : rowsA.filter((r) => r.opacity > 0).length} 条
    </div>
  </div>
);

/* ---------- AI 面板(静态历史 ⇄ 时间线分析会话) ---------- */

const ChatBubble: React.FC<{ spec: ChatSpec }> = ({ spec }) => {
  const user = spec.kind === 'user';
  return (
    <div style={{ position: 'absolute', left: CHAT.l - 1580, top: user ? 300 : 344, width: CHAT.w, display: 'flex', justifyContent: user ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: ITEM_W, padding: '8px 11px', borderRadius: 10,
          borderBottomRightRadius: user ? 3 : 10, borderBottomLeftRadius: user ? 10 : 3,
          background: user ? C.accentDim : C.bg2, fontSize: 12.5, lineHeight: '20px',
        }}
      >
        {spec.lines.map((l, i) => (
          <span key={i}>
            {l}
            {i < spec.lines.length - 1 && <br />}
          </span>
        ))}
      </div>
    </div>
  );
};

/** 时间线分析会话(对照 ai-engine analyzeTimeline:新会话 → 注入指令 → timeline_search →
 *  流式归纳 → ask 多选保存产物);坐标为窗口系,面板内容区原点 = 窗口 (1580, 80) */
const AiAnalysis: React.FC<{ st: Wb9State }> = ({ st }) => {
  const L = (x: number, y: number): React.CSSProperties => ({ position: 'absolute', left: x - 1580, top: y - 80 });
  return (
    <>
      {/* 用户指令气泡(浓缩展示;真实注入的是完整分析指令) */}
      <div style={{ ...L(AI2.askX, AI2.userY), width: CHAT.w, display: 'flex', justifyContent: 'flex-end', opacity: st.aiUserT }}>
        <div style={{ maxWidth: ITEM_W, padding: '8px 11px', borderRadius: 10, borderBottomRightRadius: 3, background: C.accentDim, fontSize: 12.5, lineHeight: '20px' }}>
          分析标签「发布」划定的时间线范围，
          <br />
          生成项目日志与可重用 Skill
        </div>
      </div>
      {/* timeline_search 工具调用条 */}
      {st.aiTool && (
        <div
          style={{
            ...L(AI2.askX, AI2.toolY), display: 'inline-flex', alignItems: 'center', gap: 6, height: 26, padding: '0 10px',
            background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6,
            fontFamily: FONT_MONO, fontSize: 11, color: C.text1, whiteSpace: 'nowrap',
          }}
        >
          <span style={{ display: 'flex', color: C.text2 }}><Icon name="wrench" size={11} /></span>
          timeline_search · keyword #发布
        </div>
      )}
      {/* 流式项目日志 */}
      <div style={{ ...L(AI2.askX, AI2.linesY), width: ITEM_W + 6 }}>
        {AI2_LINES.slice(0, st.aiLines).map((l, i) => (
          <div
            key={i}
            style={{
              height: AI2.lineH, display: 'flex', alignItems: 'center', fontSize: l.bold ? 13 : 12, lineHeight: '18px',
              color: l.muted ? C.text2 : C.text0, fontWeight: l.bold ? 700 : 400, whiteSpace: 'nowrap',
            }}
          >
            {l.text}
          </div>
        ))}
        {/* 流式光标(行未齐时) */}
        {st.aiLines > 0 && st.aiLines < AI2_LINES.length && (
          <span style={{ position: 'absolute', left: 0, top: st.aiLines * AI2.lineH + 4, width: 7, height: 14, background: C.accent }} />
        )}
      </div>
      {/* ask 保存卡(多选 → 保存) */}
      {st.askT > 0 && (
        <div
          style={{
            ...L(AI2.askX, AI2.askY), width: AI2.askW, height: 158, boxSizing: 'border-box', padding: '12px 12px 10px',
            background: C.bg2, border: `1px solid ${C.borderStrong}`, borderRadius: 8, opacity: st.askT,
          }}
        >
          {st.askSaved ? (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, fontSize: 12.5, lineHeight: '20px', color: C.green }}>
              <span style={{ display: 'flex', marginTop: 3 }}><Icon name="check" size={13} strokeWidth={3} /></span>
              <span>
                已保存：笔记「订单服务发布日志」
                <br />
                Skill「order-release-flow」
              </span>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12.5, fontWeight: 600, color: C.text0, marginBottom: 8 }}>保存哪些产物？</div>
              {AI2_ASK.map((o) => (
                <div key={o} style={{ display: 'flex', alignItems: 'center', gap: 8, height: 28, fontSize: 12, color: C.text0 }}>
                  <span style={{ width: 15, height: 15, borderRadius: 4, background: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', flex: 'none' }}>
                    <Icon name="check" size={11} strokeWidth={3} />
                  </span>
                  {o}
                </div>
              ))}
              <div
                style={{
                  position: 'absolute', left: AI2.saveBtn.x - AI2.askX, top: AI2.saveBtn.y - AI2.askY,
                  width: AI2.saveBtn.w, height: AI2.saveBtn.h, display: 'flex', alignItems: 'center', justifyContent: 'center',
                  borderRadius: 4, fontSize: 12, color: '#fff', background: st.hover === 'askSave' ? C.accentHover : C.accent,
                }}
                data-anchor="w9-ask-save"
              >
                保存选中
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
};

const AiPanel: React.FC<{ st: Wb9State }> = ({ st }) => (
  <div style={{ position: 'relative', width: 340, flex: 'none', background: C.bg1, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
    <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: 1, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '0 8px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, color: C.text0 }}>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {st.aiView === 'analysis' ? '订单服务 · 时间线分析' : '订单服务 · 排查'}
        </span>
        <Icon name="chevronDown" size={12} color={C.text2} />
      </div>
      <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1, borderRadius: 4 }}>
        <Icon name="plus" size={14} />
      </div>
    </div>
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
      {st.aiView === 'history' ? (
        <>
          <ChatBubble spec={{ kind: 'user', id: 'u1', lines: ['测试挂了怎么排查？'] }} />
          <ChatBubble spec={{ kind: 'ai', id: 'ai1', lines: ['先看失败用例的断言输出——', '定位到回调签名配置缺失，', '补上 DB_PASS 配置即可。'] }} />
        </>
      ) : (
        <AiAnalysis st={st} />
      )}
    </div>
    <div style={{ flex: 'none', height: 148, boxSizing: 'border-box', borderTop: `1px solid ${C.border}`, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 0', fontSize: 11, color: C.text2, flex: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="bot" size={12} /> AI 模式
        </span>
        <div style={{ width: 74, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text0, fontSize: 12, boxSizing: 'border-box', flex: 'none' }}>
          工作
          <Icon name="chevronDown" size={10} color={C.text2} />
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="zap" size={12} /> 思考强度
        </span>
        <div style={{ width: 78, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text0, fontSize: 12, boxSizing: 'border-box', flex: 'none' }}>
          低
          <Icon name="chevronDown" size={10} color={C.text2} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 10, fontSize: 11, lineHeight: '18px', background: C.accentDim, color: C.accentHover }}>
          <Icon name="monitor" size={11} />
          @order-1
        </span>
      </div>
      <div style={{ position: 'relative', flex: 1, minHeight: 0, padding: '8px 10px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12.5, lineHeight: '20px' }}>
        <span style={{ color: C.text2 }}>向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器</span>
        <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10.5, color: C.text2 }}>Enter 发送</span>
      </div>
    </div>
  </div>
);

/* ---------- 底栏 ---------- */

const Statusbar: React.FC<{ st: Wb9State; frame: number }> = ({ st, frame }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 26, display: 'flex', alignItems: 'center', padding: '0 8px', background: C.bg1, borderTop: `1px solid ${C.border}`, color: C.text1, fontSize: 11, opacity: 1 - st.pageT }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 12 }}>
      <Icon name="folder" size={12} />
      {DEMO.projectName}
    </span>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.text2 }}>
      <Icon name="terminal" size={12} />
      本地终端
    </span>
    {st.uploadP !== null && (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 16, color: C.text1 }}>
        <Spinner frame={frame} size={11} color={C.accent} />
        SFTP 上传
        <span style={{ width: PROG.barW, height: PROG.barH, borderRadius: 2, background: C.bg3, overflow: 'hidden', display: 'inline-flex' }}>
          <span style={{ width: PROG.barW * st.uploadP, height: '100%', background: C.accent }} />
        </span>
        {Math.round(st.uploadP * 100)}%
        <span style={{ color: C.text2 }}>{DEMO.uploadFile}</span>
      </span>
    )}
    <div style={{ flex: 1 }} />
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 4, background: C.accentDim, color: C.accent }}>
      <Icon name="bot" size={12} /> AI 助手
    </span>
  </div>
);

/* ---------- 设置页 ---------- */

const FieldsetBox: React.FC<{ y: number; h: number; legend: string; children?: React.ReactNode }> = ({ y, h, legend, children }) => (
  <>
    <div style={{ position: 'absolute', left: SET.fsX, top: y, width: SET.fsW, height: h, boxSizing: 'border-box', border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg1 }} />
    <div style={{ position: 'absolute', left: SET.fsX + 20, top: y - 10, padding: '0 8px', fontSize: 13, fontWeight: 600, color: C.text0, background: C.bg0, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {legend}
    </div>
    {children}
  </>
);

const GhostRow: React.FC<{ y: number; label: string; value: string }> = ({ y, label, value }) => (
  <div style={{ position: 'absolute', left: SET.fsX + 32, top: y, display: 'flex', alignItems: 'center', gap: 14 }}>
    <span style={{ fontSize: 12.5, color: C.text1, width: 120 }}>{label}</span>
    <span style={{ width: 180, height: 30, display: 'inline-flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px', background: C.bg0, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text0, boxSizing: 'border-box' }}>
      {value}
      <Icon name="chevronDown" size={12} color={C.text2} />
    </span>
  </div>
);

const SettingsPanel: React.FC<{ st: Wb9State }> = ({ st }) => (
  <div
    style={{
      position: 'absolute', inset: 0, background: C.bg0, opacity: st.pageT,
      transform: `translateY(${(1 - st.pageT) * 12}px)`, pointerEvents: st.page === 'settings' ? 'auto' : 'none',
    }}
  >
    {/* 左导航 */}
    <div style={{ position: 'absolute', left: 0, top: 40, bottom: 0, width: SET.navW, background: C.bg1, borderRight: `1px solid ${C.border}`, padding: '14px 8px', boxSizing: 'border-box' }}>
      {SET.nav.map((label, i) => {
        const active = i === SET.navActive;
        return (
          <div
            key={label}
            style={{
              height: 34, display: 'flex', alignItems: 'center', padding: '0 10px', borderRadius: 6,
              fontSize: 12.5, color: active ? C.accent : C.text2, background: active ? C.accentDim : 'transparent',
              fontWeight: active ? 600 : 400,
            }}
          >
            {label}
          </div>
        );
      })}
      <span style={{ display: 'none' }}>{`${setNavCy(SET.navActive)}`}</span>
    </div>
    {/* 内容区(fieldset 纵排;镜头只推到「时间线云同步」区) */}
    <FieldsetBox y={SET.fsAi.y} h={SET.fsAi.h} legend="AI 助手">
      <GhostRow y={SET.fsAi.y + 54} label="AI 模式" value="工作" />
      <GhostRow y={SET.fsAi.y + 114} label="思考强度" value="低" />
    </FieldsetBox>
    <FieldsetBox y={SET.fsTl.y} h={SET.fsTl.h} legend="时间线云同步">
      <span style={{ position: 'absolute', left: SET.label.x, top: SET.label.y, fontSize: 13, color: C.text0 }}>同步项目时间线到云端</span>
      <span
        data-anchor="w9-set-ckb"
        style={{
          position: 'absolute', left: SET.checkbox.x, top: SET.checkbox.y, width: SET.checkbox.w, height: SET.checkbox.h,
          borderRadius: 4, background: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
        }}
      >
        <Icon name="check" size={12} strokeWidth={3} />
      </span>
      <div style={{ position: 'absolute', left: SET.hint.x, top: SET.hint.y, width: SET.hint.w, fontSize: 11.5, lineHeight: 1.7, color: C.text2 }}>
        {SET_HINT}
      </div>
      <div data-anchor="w9-set-status" style={{ position: 'absolute', left: SET.status.x, top: SET.status.y, display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.green }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: C.green, flex: 'none' }} />
        {DEMO.chipText}
      </div>
      <span data-anchor="w9-purge-btn" style={{ position: 'absolute', left: SET.purgeBtn.x, top: SET.purgeBtn.y, ...btnSmall({ hovered: st.hover === 'purgeBtn' }) }}>
        删除云端时间线…
      </span>
    </FieldsetBox>
    {/* C3 悬停提示小卡 */}
    {st.tipCard && (
      <div style={{ position: 'absolute', left: TIP_CARD.x, top: TIP_CARD.y, width: TIP_CARD.w, padding: '12px 14px', background: C.bg2, border: `1px solid ${C.accent}`, borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.55)', zIndex: 46 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: C.accent, marginBottom: 5 }}>{DEMO.tipTitle}</div>
        <div style={{ fontSize: 11.5, lineHeight: 1.65, color: C.text1 }}>{DEMO.tipBody}</div>
      </div>
    )}
  </div>
);

/* ---------- 右键菜单 / 打标签弹窗 / 确认框 / toast ---------- */

const ContextMenu: React.FC<{ st: Wb9State }> = ({ st }) => {
  if (!st.menu) return null;
  return (
    <div
      style={{
        position: 'absolute', left: MENU9.x, top: st.menu.y, width: MENU9.w, padding: MENU9.pad,
        background: C.bg2, border: `1px solid ${C.borderStrong}`, borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', zIndex: 45,
      }}
    >
      <div
        data-anchor="w9-menu-tag"
        style={{
          display: 'flex', alignItems: 'center', gap: 7, height: MENU9.itemH, padding: '0 10px', borderRadius: 4,
          fontSize: 12.5, color: st.menu.hover ? C.text0 : C.text1,
          background: st.menu.hover ? C.bgHover : 'transparent',
        }}
      >
        <span style={{ display: 'flex', color: st.menu.hover ? C.text0 : C.text2 }}>
          <Icon name="hash" size={13} />
        </span>
        {MENU9_ITEM}
      </div>
      <span style={{ display: 'none' }}>{`${menuItemCy(MENU9_Y1)},${menuItemCy(MENU9_Y2)}`}</span>
    </div>
  );
};

const DLG_TARGET: Record<'tag1' | 'tag2', string> = {
  tag1: '09-10 15:41:58 · $ cargo test --release',
  tag2: '09-10 15:35:40 · 连接 order-1 (10.10.1.55:22)',
};

const TagDialog: React.FC<{ st: Wb9State }> = ({ st }) => {
  if (!st.dlg) return null;
  const t = st.dlgT;
  const L = (x: number, y: number): React.CSSProperties => ({ position: 'absolute', left: x - DLG9.x, top: y - DLG9.y });
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute', left: DLG9.x, top: DLG9.y, width: DLG9.w, height: DLG9.h, boxSizing: 'border-box',
          background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
        }}
      >
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>打标签</span>
          <Icon name="x" size={14} color={C.text2} />
        </div>
        <div style={{ ...L(DLG9_F.input.x, DLG9_F.targetY), width: 412, fontSize: 11.5, color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {DLG_TARGET[st.dlg]}
        </div>
        <div
          style={{
            ...L(DLG9_F.input.x, DLG9_F.input.y), width: DLG9_F.input.w, height: DLG9_F.input.h, boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', padding: '0 10px', background: C.bg0, border: `1px solid ${C.accent}`,
            borderRadius: 4, fontSize: 13, color: C.text0,
          }}
        >
          {st.dlgText}
          <span style={{ display: 'inline-block', width: 1.5, height: 14, background: C.accent, marginLeft: 2 }} />
        </div>
        <div style={{ ...L(DLG9_F.input.x, DLG9_F.paletteY), display: 'flex', gap: 10 }}>
          {PALETTE.map((c, i) => (
            <span
              key={c}
              style={{
                width: 22, height: 22, borderRadius: 4, background: c, boxSizing: 'border-box',
                border: i === 0 ? '2px solid #fff' : '1px solid rgba(255,255,255,0.15)',
              }}
            />
          ))}
          <span style={{ display: 'none' }}>{`${paletteCx(0)},${paletteCx(7)}`}</span>
        </div>
        <div style={{ ...L(DLG9_F.input.x, DLG9_F.hintY), width: 412, fontSize: 11, lineHeight: 1.6, color: C.text2 }}>
          两个同名标签构成标签对，自动划定一段选区；已有同名标签会沿用其最新颜色。
        </div>
        <div style={{ ...L(DLG9_F.btnCancel.x, DLG9_F.btnCancel.y), width: DLG9_F.btnCancel.w, height: DLG9_F.btnCancel.h, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text1 }}>
          取消
        </div>
        <div
          data-anchor="w9-dlg-ok"
          style={{
            ...L(DLG9_F.btnOk.x, DLG9_F.btnOk.y), width: DLG9_F.btnOk.w, height: DLG9_F.btnOk.h,
            display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, fontSize: 12.5, color: '#fff',
            background: st.hover === 'dlgOk' ? C.accentHover : C.accent,
          }}
        >
          确定
        </div>
      </div>
    </div>
  );
};

/** 「选择分析范围」弹窗(对照 TimelineTab AnalyzeDialog:勾选标签划定范围,无标签时全量) */
const AnalyzeDialog: React.FC<{ st: Wb9State }> = ({ st }) => {
  if (!st.analyzeDlg) return null;
  const t = st.analyzeT;
  const L = (x: number, y: number): React.CSSProperties => ({ position: 'absolute', left: x - ADLG9.x, top: y - ADLG9.y });
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute', left: ADLG9.x, top: ADLG9.y, width: ADLG9.w, height: ADLG9.h, boxSizing: 'border-box',
          background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
        }}
      >
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>选择分析范围</span>
          <Icon name="x" size={14} color={C.text2} />
        </div>
        <div style={{ ...L(ADLG9_F.checkboxX, ADLG9_F.hintY), width: 412, fontSize: 11.5, color: C.text2 }}>
          勾选要分析的标签（可多选），AI 只检索这些标签划定的时间线范围。
        </div>
        {ANALYZE_TAGS.map((tag, i) => {
          const checked = i === 0 && st.anaChecked;
          const hovered = i === 0 && (st.hover === 'anaCheck' || st.press === 'anaCheck');
          return (
            <div
              key={tag.name}
              data-anchor={i === 0 ? 'w9-ana-check' : undefined}
              style={{
                ...L(ADLG9_F.checkboxX - 10, ADLG9_F.itemY(i)), width: 424, height: 36, display: 'flex', alignItems: 'center', gap: 9,
                padding: '0 10px', boxSizing: 'border-box', borderRadius: 6, background: hovered ? C.bgHover : 'transparent',
              }}
            >
              <span
                style={{
                  width: 16, height: 16, borderRadius: 4, flex: 'none', boxSizing: 'border-box',
                  background: checked ? C.accent : 'transparent', border: checked ? 'none' : `1.5px solid ${C.borderStrong}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff',
                }}
              >
                {checked && <Icon name="check" size={11} strokeWidth={3} />}
              </span>
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 3, height: 22, padding: '0 9px', borderRadius: 11,
                  fontSize: 12, border: `1px solid ${tag.color}66`, color: tag.color,
                }}
              >
                <Icon name="hash" size={11} /> {tag.name}
              </span>
              {i === 0 && (
                <span style={{ fontSize: 11, color: C.text2 }}>15:35 – 15:42 · 6 条事件</span>
              )}
            </div>
          );
        })}
        <div style={{ ...L(ADLG9_F.btnCancel.x, ADLG9_F.btnCancel.y), width: ADLG9_F.btnCancel.w, height: ADLG9_F.btnCancel.h, display: 'flex', alignItems: 'center', justifyContent: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text1 }}>
          取消
        </div>
        <div
          data-anchor="w9-ana-ok"
          style={{
            ...L(ADLG9_F.btnOk.x, ADLG9_F.btnOk.y), width: ADLG9_F.btnOk.w, height: ADLG9_F.btnOk.h,
            display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, fontSize: 12.5,
            color: st.anaChecked ? '#fff' : C.text2,
            background: st.anaChecked ? (st.hover === 'anaOk' ? C.accentHover : C.accent) : C.bg2,
            border: st.anaChecked ? 'none' : `1px solid ${C.border}`,
          }}
        >
          开始分析{st.anaChecked ? '（1 个标签）' : ''}
        </div>
      </div>
    </div>
  );
};

const PurgeConfirm: React.FC<{ st: Wb9State }> = ({ st }) => {
  if (!st.purgeDlg) return null;
  const t = st.purgeT;
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute', left: CFM9.x, top: CFM9.y, width: CFM9.w, height: CFM9.h, boxSizing: 'border-box',
          background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
        }}
      >
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 48, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>删除云端时间线</span>
          <Icon name="x" size={14} color={C.text2} />
        </div>
        <div style={{ position: 'absolute', left: 18, right: 18, top: 66, color: C.text1, fontSize: 12.5, lineHeight: '20px' }}>
          <div>将删除云端全部时间线事件与标签：</div>
          <div style={{ marginTop: 4 }}>· 事件 1,286 条 · 标签 4 个</div>
          <div style={{ marginTop: 8, color: C.text2, fontSize: 11.5 }}>
            本机时间线文件不受影响；删除后从新事件重新累积，已上传过的历史不会重传。
          </div>
        </div>
        <div
          style={{
            position: 'absolute', left: CFM9_BTN.cancel.x - CFM9.x, top: CFM9_BTN.cancel.y - CFM9.y,
            width: CFM9_BTN.cancel.w, height: CFM9_BTN.cancel.h, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text1,
          }}
        >
          取消
        </div>
        <div
          data-anchor="w9-cfm-ok"
          style={{
            position: 'absolute', left: CFM9_BTN.ok.x - CFM9.x, top: CFM9_BTN.ok.y - CFM9.y,
            width: CFM9_BTN.ok.w, height: CFM9_BTN.ok.h, display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: 4, fontSize: 12.5, color: '#fff', background: st.hover === 'cfmOk' ? '#f0777e' : C.red,
          }}
        >
          确认清空
        </div>
      </div>
    </div>
  );
};

/* ---------- 主组件 ---------- */

export const Wb9: React.FC<{ state: Wb9State; frame: number; rowsA: TlRowStateA[]; rowsB: TlRowStateB[] }> = ({ state, frame, rowsA, rowsB }) => {
  const st = state;
  return (
    <div
      style={{
        position: 'absolute', width: WIN_W, height: WIN_H, background: C.bg0, color: C.text0,
        fontFamily: FONT_UI, fontSize: 13, borderRadius: 14, border: `1px solid ${C.borderStrong}`,
        overflow: 'hidden', boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
      }}
    >
      <TopBar active={st.page === 'workbench' ? '项目' : '设置'} project={st.page === 'workbench' ? DEMO.projectName : undefined} anchors={{ settings: 'w9-set-nav' }} />

      {/* 工作台骨架 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 26, display: 'flex', opacity: 1 - st.pageT, pointerEvents: st.page === 'workbench' ? 'auto' : 'none' }}>
        <ActivityBar st={st} />
        <ExplorerPanel />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg0, opacity: 1 - st.pageT }}>
          <TabBar st={st} />
        </div>
        <AiPanel st={st} />
      </div>
      {/* 标签页内容(窗口坐标叠加,页面淡化时同步淡出) */}
      <div style={{ position: 'absolute', inset: 0, opacity: 1 - st.pageT, pointerEvents: 'none' }}>
        <TermPane st={st} frame={frame} />
        <TimelinePanel st={st} rowsA={rowsA} rowsB={rowsB} />
      </div>
      <Statusbar st={st} frame={frame} />

      {/* 设置页 */}
      <SettingsPanel st={st} />

      {/* 覆盖层:菜单 45 < toast/tip 46 < 弹窗 50 */}
      <ContextMenu st={st} />
      {st.toast && (
        <div
          style={{
            position: 'absolute', right: TOAST_POS.right, bottom: TOAST_POS.bottom, padding: '11px 18px', background: C.bg2,
            border: `1px solid ${C.borderStrong}`, borderRadius: 8, fontSize: 12.5,
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)', whiteSpace: 'nowrap', zIndex: 46, maxWidth: 620,
          }}
        >
          {st.toast}
        </div>
      )}
      <TagDialog st={st} />
      <AnalyzeDialog st={st} />
      <PurgeConfirm st={st} />
    </div>
  );
};
