/**
 * 视频九网页端画面:自绘浏览器框(浅色:标签条 + 地址栏,外部浏览器而非内置浏览器)+
 * 云平台用户工作台「时间线」页 —— 对照 aishell-cloud web/admin(UserWorkspace 外壳 +
 * TimelinePanel + TimelineStream),浅色主题:LC 调色板取自 styles.css :root 变量。
 * 布局:侧栏(AIShell 云服务 + 导航)+ 顶栏(eyebrow + h1 + 用户菜单)+ 统一时间线卡片
 * (页头 / 筛选表单 / 类别 chips / 日分隔 / 事件行 / 展开详情)+ 治理卡(删除云端时间线)。
 * 事件行绝对定位写死;筛选状态(projSel/kindCmd/kindUp/tagOn)与刷新帧(refreshAt,
 * 行级 stagger)由 script.ts 的 webAt 推导;可见行集合见 webVisibleRows。
 */
import React from 'react';
import { interpolate } from 'remotion';
import { FONT_MONO, FONT_UI } from '../theme';
import { Icon, Logo } from '../ui';
import { WIN_H, WIN_W } from '../scene';
import {
  DROP_OPTS, KIND_META, KIND_TONE, PROJ_META, TAG_TONE, WEB, WEB_CHIPS, WEB_COL, WEB_DETAIL,
  WEB_EXPAND_ID, WebRow, dropOptCy, webChipX, webRowY,
} from './layout';

/* ---------- 状态 ---------- */

export type W9 = 'projSel' | 'projOpt' | 'kindCmd' | 'kindUp' | 'tagSel' | 'row' | null;

export interface Web9State {
  dropOpen: boolean;
  dropT: number;
  /** 下拉悬停项(0 全部项目 1 订单服务 2 支付网关) */
  dropHover: number;
  /** true=已选「订单服务」 */
  projSel: boolean;
  kindCmd: boolean;
  kindUp: boolean;
  tagOn: boolean;
  /** 最近一次列表刷新帧(行 stagger 起点) */
  refreshAt: number;
  expanded: boolean;
  hover: W9;
  press: W9;
}

/* ---------- 浅色调色板(对照 aishell-cloud web/admin styles.css :root) ---------- */

const LC = {
  bg: '#f3f4f7',
  surface: '#ffffff',
  subtle: '#f7f8fa',
  border: '#d8dce3',
  borderStrong: '#c3c9d2',
  text: '#1f2329',
  muted: '#656b76',
  faint: '#8b92a0',
  accent: '#3b76e1',
  accentHover: '#2f66c9',
  accentSoft: '#edf3ff',
  navActiveBg: '#e9f0fd',
  navText: '#596170',
  navHover: '#eceff4',
  green: '#16895b',
  red: '#c83d4d',
  redSoft: '#fff0f2',
  redBorder: '#efbac1',
  shadow: '0 8px 28px rgba(24,37,57,0.09)',
} as const;

/* ---------- 浏览器框(浅色) ---------- */

const BrowserChrome: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div
    style={{
      position: 'absolute', width: WIN_W, height: WIN_H, background: LC.bg, color: LC.text,
      fontFamily: FONT_UI, fontSize: 13, borderRadius: 14, border: '1px solid #9aa1ad',
      overflow: 'hidden', boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
    }}
  >
    {/* 标签条 */}
    <div style={{ height: WEB.tabStripH, background: '#dee1e6', display: 'flex', alignItems: 'flex-end', paddingLeft: 16, gap: 8 }}>
      <div style={{ height: 34, width: 300, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', background: LC.surface, borderRadius: '10px 10px 0 0', fontSize: 12.5, color: LC.text }}>
        <span style={{ display: 'flex', color: LC.accent }}><Icon name="globe" size={13} /></span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>AIShell 云服务 · 工作台</span>
        <span style={{ marginLeft: 'auto', display: 'flex', color: LC.faint }}><Icon name="x" size={11} /></span>
      </div>
      <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5f6368', marginBottom: 4 }}>
        <Icon name="plus" size={13} />
      </div>
    </div>
    {/* 工具栏 + 地址栏 */}
    <div style={{ height: WEB.toolbarH, background: LC.surface, borderBottom: `1px solid ${LC.border}`, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 10, boxSizing: 'border-box' }}>
      {(['arrowLeft', 'arrowRight', 'refresh'] as const).map((n) => (
        <span key={n} style={{ display: 'flex', color: '#5f6368' }}><Icon name={n} size={15} /></span>
      ))}
      <div style={{ position: 'absolute', left: WEB.addr.x, top: WEB.addr.y, width: WEB.addr.w, height: WEB.addr.h, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 8, padding: '0 14px', background: '#f1f3f4', borderRadius: 16, fontSize: 12.5, color: '#3c4043' }}>
        <Icon name="lock" size={12} color={LC.green} />
        <span style={{ fontFamily: FONT_MONO, fontSize: 12 }}>{WEB.url}</span>
      </div>
      <div style={{ position: 'absolute', left: 1608, top: 46, width: 30, height: 30, borderRadius: '50%', background: '#e8eaed', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#5f6368' }}>
        <Icon name="user" size={14} />
      </div>
    </div>
    {children}
  </div>
);

/* ---------- 侧栏(对照 UserWorkspace sidebar) ---------- */

const Sidebar: React.FC = () => (
  <div style={{ position: 'absolute', left: 0, top: WEB.tabStripH + WEB.toolbarH, bottom: 0, width: WEB.sideW, background: LC.subtle, borderRight: `1px solid ${LC.border}`, boxSizing: 'border-box' }}>
    <div style={{ height: 64, display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px', borderBottom: `1px solid ${LC.border}`, boxSizing: 'border-box' }}>
      <Logo size={26} />
      <span style={{ fontWeight: 700, fontSize: 15, color: LC.text }}>AIShell 云服务</span>
    </div>
    <div style={{ padding: '14px 20px 6px', fontSize: 11, fontWeight: 650, color: LC.faint, letterSpacing: 0.4 }}>工作台</div>
    {WEB.menu.map((m, i) => {
      const active = i === WEB.menuActive;
      return (
        <div
          key={m.label}
          style={{
            height: 38, margin: '2px 10px', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px',
            borderRadius: 7, fontSize: 13, color: active ? LC.accent : LC.navText,
            background: active ? LC.navActiveBg : 'transparent', fontWeight: active ? 700 : 400,
          }}
        >
          <span style={{ display: 'flex' }}><Icon name={m.icon} size={14} /></span>
          {m.label}
        </div>
      );
    })}
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '12px 0 16px', borderTop: `1px solid ${LC.border}` }}>
      <div style={{ height: 38, margin: '0 10px', display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px', borderRadius: 7, fontSize: 13, color: LC.navText }}>
        <span style={{ display: 'flex' }}><Icon name="external" size={14} /></span>
        回到主页
      </div>
    </div>
  </div>
);

/* ---------- 顶栏(eyebrow + h1 + 用户菜单) ---------- */

const Topbar: React.FC = () => (
  <div
    style={{
      position: 'absolute', left: WEB.sideW, right: 0, top: WEB.tabStripH + WEB.toolbarH, height: WEB.topbarH,
      borderBottom: `1px solid ${LC.border}`, background: 'rgba(255,255,255,0.93)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 30px', boxSizing: 'border-box',
    }}
  >
    <div>
      <div style={{ color: LC.accent, fontSize: 12, fontWeight: 700, letterSpacing: 1.2 }}>用户工作台</div>
      <div style={{ fontSize: 20, fontWeight: 750, color: LC.text, marginTop: 2 }}>时间线</div>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '4px 6px', borderRadius: 10 }}>
      <div style={{ width: 30, height: 30, borderRadius: '50%', background: LC.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', color: LC.accent }}>
        <Icon name="user" size={14} />
      </div>
      <div>
        <div style={{ fontSize: 12.5, fontWeight: 650, color: LC.text }}>演示账号</div>
        <div style={{ fontSize: 11, color: LC.faint }}>企业用户</div>
      </div>
    </div>
  </div>
);

/* ---------- 筛选表单控件 ---------- */

const selectBox = (hot: boolean): React.CSSProperties => ({
  position: 'absolute', height: WEB.filterH, boxSizing: 'border-box',
  display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px',
  background: LC.surface, border: `1px solid ${hot ? LC.accent : LC.border}`, borderRadius: 8,
  fontSize: 12.5, color: LC.text,
});

const filterLabel = (x: number, text: string): React.ReactNode => (
  <span style={{ position: 'absolute', left: x, top: WEB.filterLabelY, fontSize: 11, fontWeight: 650, color: LC.muted }}>{text}</span>
);

/** 标签色(与客户端打标一致:云端存的就是 TAG_COLOR #4f8ef7,浅色底上仍可读) */
const TAG_COLOR_LIGHT = '#4f8ef7';

/* ---------- 云平台工作台 ---------- */

const CloudApp: React.FC<{ st: Web9State; frame: number; rows: { row: WebRow; idx: number }[] }> = ({ st, frame, rows }) => {
  const projLabel = st.projSel ? PROJ_META.order.label : '全部项目';
  const tagLabel = st.tagOn ? '发布' : '全部标签';
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Sidebar />
      <Topbar />
      {/* 内容区(窗口坐标覆盖层) */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        {/* ===== 统一时间线卡片 ===== */}
        <div
          style={{
            position: 'absolute', left: WEB.cardX, top: WEB.cardY, width: WEB.cardW, height: WEB.dangerY - WEB.cardY - 16,
            background: LC.surface, border: `1px solid ${LC.border}`, borderRadius: 10,
            boxShadow: '0 3px 12px rgba(24,37,57,0.035)', boxSizing: 'border-box',
          }}
        />
        {/* 卡片页头 */}
        <div style={{ position: 'absolute', left: WEB.cardX, top: WEB.cardY, width: WEB.cardW, height: WEB.cardHeadH, borderBottom: `1px solid ${LC.border}`, display: 'flex', alignItems: 'center', padding: '0 20px', gap: 11, boxSizing: 'border-box' }}>
          <span style={{ width: 36, height: 36, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: LC.accent, background: LC.accentSoft, flex: 'none' }}>
            <Icon name="clock" size={17} />
          </span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: LC.text }}>统一时间线</div>
            <div style={{ fontSize: 12, color: LC.muted, marginTop: 2 }}>跨项目聚合的操作记录，按时间倒序</div>
          </div>
          <span style={{ marginLeft: 'auto', padding: '4px 9px', border: `1px solid ${LC.border}`, borderRadius: 999, fontSize: 11, color: LC.faint, background: LC.subtle, whiteSpace: 'nowrap' }}>
            已加载 {rows.length} 条
          </span>
        </div>
        {/* 筛选表单(label 在上) */}
        {filterLabel(WEB.projSel.x, '项目')}
        {filterLabel(WEB.tagSel.x, '标签')}
        {filterLabel(WEB.kwInput.x, '关键词')}
        {filterLabel(WEB.rangeSel.x, '时间范围')}
        <div style={{ ...selectBox(st.hover === 'projSel' || st.dropOpen), left: WEB.projSel.x, top: WEB.projSel.y, width: WEB.projSel.w }}>
          {projLabel}
          <Icon name="chevronDown" size={12} color={LC.faint} />
        </div>
        <div style={{ ...selectBox(st.tagOn), left: WEB.tagSel.x, top: WEB.tagSel.y, width: WEB.tagSel.w, color: st.tagOn ? LC.accent : LC.text }}>
          {tagLabel}
          <Icon name="chevronDown" size={12} color={LC.faint} />
        </div>
        <div
          style={{
            position: 'absolute', left: WEB.kwInput.x, top: WEB.kwInput.y, width: WEB.kwInput.w, height: WEB.kwInput.h, boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', background: LC.surface, border: `1px solid ${LC.border}`,
            borderRadius: 8, fontSize: 12, color: LC.faint,
          }}
        >
          <Icon name="search" size={12} />
          搜索摘要与详情，支持 #标签
        </div>
        <div style={{ ...selectBox(false), left: WEB.rangeSel.x, top: WEB.rangeSel.y, width: WEB.rangeSel.w }}>
          近 30 天
          <Icon name="chevronDown" size={12} color={LC.faint} />
        </div>
        <div
          style={{
            position: 'absolute', left: WEB.queryBtn.x, top: WEB.queryBtn.y, width: WEB.queryBtn.w, height: WEB.queryBtn.h, boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, background: LC.surface,
            border: `1px solid ${LC.borderStrong}`, borderRadius: 8, fontSize: 12.5, color: LC.text,
          }}
        >
          <Icon name="search" size={12} /> 查询
        </div>
        <div
          style={{
            position: 'absolute', left: WEB.resetBtn.x, top: WEB.resetBtn.y, width: WEB.resetBtn.w, height: WEB.resetBtn.h, boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', justifyContent: 'center', background: LC.surface,
            border: `1px solid ${LC.borderStrong}`, borderRadius: 8, fontSize: 12.5, color: LC.text,
          }}
        >
          重置
        </div>
        {/* 项目下拉 */}
        {st.dropOpen && (
          <div
            style={{
              position: 'absolute', left: WEB.drop.x, top: WEB.drop.y, width: WEB.drop.w, padding: WEB.drop.pad, boxSizing: 'border-box',
              background: LC.surface, border: `1px solid ${LC.border}`, borderRadius: 8,
              boxShadow: LC.shadow, zIndex: 45, opacity: st.dropT,
            }}
          >
            {DROP_OPTS.map((o, i) => (
              <div
                key={o}
                style={{
                  height: WEB.drop.optH, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRadius: 6,
                  fontSize: 12.5, color: st.dropHover === i ? LC.text : LC.muted,
                  background: st.dropHover === i ? LC.subtle : 'transparent',
                }}
              >
                {o}
                {st.projSel && i === 1 && <span style={{ marginLeft: 'auto', display: 'flex', color: LC.accent }}><Icon name="check" size={12} /></span>}
              </div>
            ))}
            <span style={{ display: 'none' }}>{`${dropOptCy(1)}`}</span>
          </div>
        )}
        {/* 类别 chips(9 类, pill) */}
        {WEB_CHIPS.map((k, i) => {
          const active = (k.key === 'command' && st.kindCmd) || (k.key === 'upload' && st.kindUp);
          return (
            <div
              key={k.key}
              style={{
                position: 'absolute', left: webChipX(i), top: WEB.chipsY, width: k.w, height: WEB.chipH, boxSizing: 'border-box',
                display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 999, fontSize: 11,
                color: active ? LC.accent : LC.muted, background: active ? LC.accentSoft : LC.surface,
                border: `1px solid ${active ? LC.accent : LC.border}`, fontWeight: active ? 650 : 400,
              }}
            >
              {k.label}
            </div>
          );
        })}
        {/* 日分隔 */}
        <div style={{ position: 'absolute', left: WEB.rowX + 8, top: WEB.dayY, fontSize: 11, fontWeight: 700, letterSpacing: 0.5, color: LC.faint }}>
          2026-09-10
        </div>
        {/* 事件流 */}
        {rows.map(({ row }, j) => {
          const y = webRowY(j);
          const meta = KIND_META[row.kind];
          const tone = TAG_TONE[KIND_TONE[row.kind] ?? 'muted'];
          const ra = st.refreshAt + j * 6;
          const ot = st.refreshAt > 0
            ? interpolate(frame, [ra, ra + 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
            : 1;
          const dy = st.refreshAt > 0 ? (1 - ot) * 6 : 0;
          const expanded = st.expanded && row.id === WEB_EXPAND_ID;
          const hasDetail = row.id === WEB_EXPAND_ID;
          const rowHot = st.hover === 'row' && row.id === WEB_EXPAND_ID;
          return (
            <div key={row.id} style={{ position: 'absolute', left: 0, right: 0, top: y, opacity: ot, transform: `translateY(${dy}px)` }}>
              <div
                style={{
                  position: 'absolute', left: WEB.rowX, top: 0, width: WEB.rowW, height: WEB.rowH - 4, boxSizing: 'border-box',
                  borderRadius: 8,
                  /* 对照 TimelineStream:命中标签的行以标签色铺底(inline 优先于 expanded 类底色) */
                  background: row.tag ? `${TAG_COLOR_LIGHT}1f` : expanded || rowHot ? LC.subtle : 'transparent',
                  border: expanded ? `1px solid ${LC.border}` : '1px solid transparent',
                  display: 'flex', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap',
                }}
              >
                <span style={{ position: 'absolute', left: WEB_COL.time - WEB.rowX, fontFamily: FONT_MONO, fontSize: 11, color: LC.faint }}>{row.time}</span>
                <span
                  style={{
                    position: 'absolute', left: WEB_COL.kind - WEB.rowX, height: 22, padding: '0 9px', display: 'inline-flex',
                    alignItems: 'center', borderRadius: 999, fontSize: 11, color: tone.fg, background: tone.bg,
                  }}
                >
                  {meta.label}
                </span>
                <span style={{ position: 'absolute', left: WEB_COL.summary - WEB.rowX, right: 220, fontSize: 12.5, color: LC.text, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.summary}
                </span>
                {row.tag && (
                  <span
                    style={{
                      position: 'absolute', right: 116, display: 'inline-flex', alignItems: 'center', gap: 2, height: 22,
                      padding: '0 8px', borderRadius: 999, fontSize: 11,
                      border: `1px solid ${TAG_COLOR_LIGHT}`, color: TAG_COLOR_LIGHT,
                    }}
                  >
                    <span style={{ display: 'flex' }}><Icon name="hash" size={10} /></span>
                    {row.tag}
                  </span>
                )}
                <span style={{ position: 'absolute', right: 30, fontSize: 11, color: LC.muted }}>{PROJ_META[row.proj].label}</span>
                {hasDetail && (
                  <span style={{ position: 'absolute', right: 10, display: 'flex', color: LC.faint, transform: expanded ? 'rotate(90deg)' : 'none' }}>
                    <Icon name="chevronRight" size={13} />
                  </span>
                )}
              </div>
              {/* 展开详情(对照 .timeline-detail:白底 + mono + pre-wrap) */}
              {expanded && (
                <div
                  style={{
                    position: 'absolute', left: WEB.rowX + 8, top: WEB.rowH - 2, width: WEB.rowW - 16, height: WEB.detailH,
                    boxSizing: 'border-box', padding: '9px 12px', background: LC.surface, border: `1px solid ${LC.border}`,
                    borderRadius: 8, fontFamily: FONT_MONO, fontSize: 11.5, lineHeight: 1.55, color: LC.text, overflow: 'hidden',
                  }}
                >
                  {WEB_DETAIL.map((l, i) => (
                    <div key={i} style={{ whiteSpace: 'pre', color: l.includes('已脱敏') ? TAG_TONE.amber.fg : undefined }}>
                      {l}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {/* ===== 治理卡(对照 TimelinePanel timeline-danger-card) ===== */}
        <div
          style={{
            position: 'absolute', left: WEB.cardX, top: WEB.dangerY, width: WEB.cardW, height: WEB.dangerH,
            background: LC.surface, border: `1px solid ${LC.border}`, borderRadius: 10,
            boxShadow: '0 3px 12px rgba(24,37,57,0.035)', boxSizing: 'border-box',
            display: 'flex', alignItems: 'center', padding: '0 20px', gap: 11,
          }}
        >
          <span style={{ width: 36, height: 36, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', color: LC.red, background: LC.redSoft, flex: 'none' }}>
            <Icon name="trash" size={16} />
          </span>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: LC.text }}>云端时间线数据</div>
            <div style={{ fontSize: 12, color: LC.muted, marginTop: 2 }}>删除后本机时间线不受影响，后续上报会重新累积</div>
          </div>
          <span
            style={{
              marginLeft: 'auto', height: 30, padding: '0 12px', display: 'inline-flex', alignItems: 'center',
              borderRadius: 8, border: `1px solid ${LC.redBorder}`, color: LC.red, background: LC.surface, fontSize: 12.5, whiteSpace: 'nowrap',
            }}
          >
            删除云端时间线
          </span>
        </div>
      </div>
    </div>
  );
};

/* ---------- 主组件 ---------- */

export const Web9: React.FC<{ state: Web9State; frame: number; rows: { row: WebRow; idx: number }[] }> = ({ state, frame, rows }) => (
  <BrowserChrome>
    <CloudApp st={state} frame={frame} rows={rows} />
  </BrowserChrome>
);
