/**
 * 视频七工作台复刻:SSH 隧道 + 设置页联动。双页面(page 切换,pageT 淡入淡出):
 * 工作台(本地终端/浏览器/SSH 隧道三标签,隧道标签按 TunnelTab.tsx:头+卡片列表+520 宽新建模态+
 * 端口冲突确认框;底栏绿色隧道角标)、设置页(Settings.tsx 左导航 176 + BrowserPanel「内置浏览器」
 * 面板:启用 SOCKS5 代理/代理来源/隧道下拉/当前生效状态行/独立保存)。浏览器标签页地址栏可输入,
 * 站点复用 browser5/Wb5 的 Site1,内网站点 SiteIntra 为本段新增(实验室集群管理台)。
 * 全部内容由 state(Wb7State)驱动,锚点见 ./layout.ts。
 */
import React from 'react';
import { TopBar } from '../components/TopBar';
import { C, FONT_MONO, FONT_UI, IconName } from '../theme';
import { Icon } from '../ui';
import { WIN_H, WIN_W } from '../scene';
import { Site1 } from '../browser5/Wb5';
import {
  BADGE, BR7, CFM7, CFM7_BTN, DEMO, NAV_BROWSER, NAV_FEATURES, PANEL7,
  SET, SRV, SRV_ITEM_TUNNEL, SRV_MENU, TAB_W, TDIA,
  TDIA_F, TDIA_MENU, TERM_BASE, TermLine, TOP_NAV, TUN, VIEW7, brMenuItemCy, brRadioCy,
  srvMenuItemCy, tdiaMenuItemCy,
} from './layout';

/* ---------- 状态 ---------- */

export type T7 =
  | 'more' | 'srvMenuTunnel'
  | 'newTunnel' | 'nameInput' | 'kindSel' | 'kindOpt0' | 'kindOpt1' | 'portInput' | 'targetInput' | 'saveOk'
  | 'row1Toggle' | 'row2Toggle' | 'cfmOk'
  | 'setNav' | 'navBrowser' | 'ckb' | 'selBox' | 'selOpt' | 'psave'
  | 'projNav' | 'btab' | 'addr' | 'input'
  | null;

export interface Wb7State {
  page: 'workbench' | 'settings';
  /** 设置页在场度(0 工作台 → 1 设置页) */
  pageT: number;
  centerTab: 'terminal' | 'browser' | 'tunnel';
  tunnelTabT: number;
  srvMenu: { open: boolean; hover: number } | null;
  row1: { present: boolean; running: boolean; t: number };
  row2: { present: boolean; running: boolean; t: number };
  dlg: 'new1' | 'new2' | null;
  dlgT: number;
  kindMenuOpen: boolean;
  kindHover: number;
  f1Name: string;
  f1Port: string;
  f2Name: string;
  f2Kind: 'local' | 'dynamic';
  f2Port: string;
  f2Target: string;
  cfm: boolean;
  cfmT: number;
  toast: string | null;
  badge: number;
  setPage: 'features' | 'browser';
  proxyEnabled: boolean;
  selOpen: boolean;
  selHover: boolean;
  selValue: boolean;
  addrFocus: boolean;
  addrText: string;
  loading: boolean;
  site: 'nebula' | 'intra';
  siteIn: number;
  hover: T7;
  press: T7;
}

/* ---------- 小组件 ---------- */

const Spinner: React.FC<{ frame: number }> = ({ frame }) => (
  <svg viewBox="0 0 24 24" width={11} height={11} style={{ opacity: frame % 20 < 10 ? 1 : 0.45 }}>
    <g fill="none" stroke={C.text2} strokeWidth={2.6} strokeLinecap="round">
      <path d="M12 3a9 9 0 1 1-9 9" opacity={0.35} />
      <path d="M12 3a9 9 0 0 1 6.4 2.6" />
    </g>
  </svg>
);

const btnSmall = (primary: boolean, opts: { hovered?: boolean; danger?: boolean } = {}): React.CSSProperties => ({
  height: 24,
  padding: '0 9px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  borderRadius: 4,
  border: `1px solid ${primary || opts.danger ? (opts.danger ? C.red : C.accent) : C.border}`,
  background: primary ? (opts.hovered ? C.accentHover : C.accent) : opts.hovered ? C.bg3 : C.bg2,
  color: primary ? '#fff' : opts.hovered ? C.text0 : C.text1,
  fontSize: 12,
  lineHeight: '16px',
  whiteSpace: 'nowrap',
});

const Checkbox: React.FC<{ size?: number; checked?: boolean }> = ({ size = 14, checked = false }) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: 3,
      border: `1px solid ${checked ? C.accent : C.borderStrong}`,
      background: checked ? C.accent : C.bg2,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none',
    }}
  >
    {checked && (
      <svg viewBox="0 0 24 24" width={size - 5} height={size - 5}>
        <path d="m5 12 5 5 9-10" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )}
  </span>
);

const Radio: React.FC<{ checked: boolean }> = ({ checked }) => (
  <span
    style={{
      width: 14, height: 14, borderRadius: '50%', flex: 'none',
      border: `1px solid ${checked ? C.accent : C.borderStrong}`,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: C.bg2,
    }}
  >
    {checked && <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.accent }} />}
  </span>
);

/** 设置页输入框/选择框 */
const BoxInput: React.FC<{
  box: { x: number; y: number; w: number; h: number };
  value: string;
  placeholder?: string;
  mono?: boolean;
  focus?: boolean;
  caret?: boolean;
  chevron?: boolean;
}> = ({ box, value, placeholder, mono, focus, caret, chevron }) => (
  <div
    style={{
      position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, boxSizing: 'border-box',
      display: 'flex', alignItems: 'center', padding: '0 10px',
      background: C.bg0, border: `1px solid ${focus ? C.accent : C.border}`, borderRadius: 4,
      fontSize: 12.5, color: value ? C.text0 : C.text2, fontFamily: mono ? FONT_MONO : FONT_UI,
      overflow: 'hidden', whiteSpace: 'nowrap',
    }}
  >
    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {value || placeholder}
      {caret && <span style={{ display: 'inline-block', width: 1.5, height: 13, background: C.accent, verticalAlign: '-2px', marginLeft: 1, opacity: caret ? 1 : 0 }} />}
    </span>
    {chevron && <Icon name="chevronDown" size={12} color={C.text2} />}
  </div>
);

const FieldLabel: React.FC<{ x: number; cy: number; text: string; req?: boolean }> = ({ x, cy, text, req }) => (
  <div style={{ position: 'absolute', left: x, top: cy - 9, fontSize: 12.5, color: C.text1, whiteSpace: 'nowrap' }}>
    {text}
    {req && <span style={{ color: C.red, marginLeft: 2 }}>*</span>}
  </div>
);

/* ---------- 活动栏 / 侧栏 ---------- */

const ACT_ITEMS = [
  { icon: 'folder', id: 'explorer' },
  { icon: 'monitor', id: 'servers' },
  { icon: 'star', id: 'commands' },
  { icon: 'sparkles', id: 'skills' },
  { icon: 'pencil', id: 'notes' },
  { icon: 'globe', id: 'browser' },
] as const;

const ActivityBar: React.FC = () => (
  <div style={{ width: 48, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6, gap: 2 }}>
    {ACT_ITEMS.map((it) => {
      const active = it.id === 'servers';
      return (
        <div
          key={it.id}
          style={{
            width: 40, height: 40, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: '0 8px 8px 0', borderLeft: `2px solid ${active ? C.accent : 'transparent'}`,
            color: active ? C.accent : C.text1, background: active ? C.bgHover : 'transparent',
          }}
        >
          <Icon name={it.icon as IconName} size={18} />
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

const SRV_MENU_ITEMS: { label: string; icon: IconName }[] = [
  { label: 'MCP', icon: 'plug' },
  { label: '数据库连接', icon: 'database' },
  { label: 'SSH跳转设置', icon: 'link' },
  { label: 'SSH 隧道', icon: 'tunnel' },
];

const ServersPanel: React.FC<{ st: Wb7State }> = ({ st }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, padding: '4px 8px' }}>
    <div style={{ padding: '8px 12px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, background: C.bg3, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
        <Icon name="monitor" size={16} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>本地终端</div>
        <div style={{ fontSize: 11.5, color: C.text2, fontFamily: FONT_MONO }}>本地终端 · 点击打开</div>
      </div>
    </div>
    <div style={{ padding: '8px 12px', background: C.bg2, border: `1px solid ${st.hover === 'more' ? C.accent : C.border}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: C.accentDim, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.accentHover }}>
          <Icon name="server" size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{DEMO.serverName}</div>
          <div style={{ fontSize: 11.5, color: C.text2, fontFamily: FONT_MONO }}>{DEMO.serverHost}:22</div>
        </div>
        <span style={{ color: C.text2, display: 'flex' }}>
          <Icon name="chevronDown" size={14} />
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', marginLeft: 40, marginTop: 6 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 10, fontSize: 11, lineHeight: '18px', background: C.bg3, color: C.text1 }}>密码</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        {(['chatPlus', 'folder', 'terminal', 'more'] as IconName[]).map((n) => (
          <div
            key={n}
            style={{
              width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4,
              border: `1px solid ${n === 'more' && (st.hover === 'more' || st.press === 'more' || st.srvMenu?.open) ? C.accent : C.border}`,
              background: n === 'more' && (st.hover === 'more' || st.srvMenu?.open) ? C.bg3 : C.bg1, color: C.text1,
            }}
          >
            <Icon name={n} size={13} />
          </div>
        ))}
      </div>
    </div>
    {/* 「更多」下拉菜单:锚点常量是窗口坐标,容器原点在侧栏内容区(窗口 x48 y74),须减偏移 */}
    {st.srvMenu?.open && (
      <div
        style={{
          position: 'absolute', left: SRV_MENU.x - 48, top: SRV_MENU.y - 74, width: SRV_MENU.w, padding: SRV_MENU.pad,
          background: C.bg2, border: `1px solid ${C.borderStrong}`, borderRadius: 6,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', zIndex: 45,
        }}
      >
        {SRV_MENU_ITEMS.map((it, i) => {
          const current = i === SRV_ITEM_TUNNEL;
          return (
            <div
              key={it.label}
              style={{
                display: 'flex', alignItems: 'center', gap: 7, height: SRV_MENU.itemH, padding: '0 10px', borderRadius: 4,
                fontSize: 12.5, color: st.srvMenu!.hover === i ? C.text0 : current ? C.accent : C.text1,
                background: st.srvMenu!.hover === i ? C.bgHover : 'transparent',
              }}
            >
              <span style={{ display: 'flex', color: st.srvMenu!.hover === i ? C.text0 : current ? C.accent : C.text2 }}>
                <Icon name={it.icon} size={13} />
              </span>
              {it.label}
            </div>
          );
        })}
        <span style={{ display: 'none' }}>{`${srvMenuItemCy(SRV_ITEM_TUNNEL)}`}</span>
      </div>
    )}
  </div>
);

/* ---------- 中央标签栏 ---------- */

const WbTab: React.FC<{ icon: IconName; title: string; active: boolean; w?: number; opacity?: number }> = ({ icon, title, active, w = TAB_W, opacity = 1 }) => (
  <div
    style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 12px', width: w, flex: 'none',
      borderRight: `1px solid ${C.border}`, borderTop: `2px solid ${active ? C.accent : 'transparent'}`,
      background: active ? C.bg0 : C.bg1, fontSize: 12.5, color: active ? C.text0 : C.text1,
      overflow: 'hidden', opacity,
    }}
  >
    <span style={{ display: 'flex', flex: 'none' }}><Icon name={icon} size={15} /></span>
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{title}</span>
    <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2, borderRadius: 3, flex: 'none' }}>
      <Icon name="x" size={11} />
    </span>
  </div>
);

/* ---------- 终端(背景) ---------- */

const TermPane: React.FC<{ frame: number }> = ({ frame }) => (
  <div style={{ flex: 1, minHeight: 0, background: '#0d1117', padding: '10px 12px', fontFamily: FONT_MONO, fontSize: 12.5, lineHeight: 1.7, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
    {[...TERM_BASE, { prompt: true } as TermLine].map((l, i) => {
      const isCmd = !!(l.prompt || l.cmd);
      return (
        <div key={i} style={{ whiteSpace: 'pre', color: isCmd ? C.text0 : C.text1 }}>
          {isCmd && <span style={{ color: C.green }}>$ </span>}
          {l.cmd || l.text || ' '}
          {l.prompt && (
            <span style={{ display: 'inline-block', width: 7, height: 14, background: C.text1, verticalAlign: '-2px', marginLeft: 2, opacity: frame % 32 < 16 ? 1 : 0 }} />
          )}
        </div>
      );
    })}
  </div>
);

/* ---------- 内网站点(实验室集群管理台,浅色页面) ---------- */

const intraCard: React.CSSProperties = { background: '#ffffff', border: '1px solid #dde3ea', borderRadius: 8 };

const SiteIntra: React.FC = () => (
  <div style={{ position: 'absolute', left: 0, top: 0, width: VIEW7.w, height: VIEW7.h, background: '#eef1f5', fontFamily: FONT_UI, overflow: 'hidden' }}>
    {/* 顶栏 */}
    <div style={{ height: 64, background: '#ffffff', borderBottom: '1px solid #dde3ea', display: 'flex', alignItems: 'center', gap: 12, padding: '0 24px' }}>
      <div style={{ width: 28, height: 28, borderRadius: 6, background: '#2f6fe4', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon name="grid" size={15} color="#ffffff" />
      </div>
      <span style={{ fontSize: 17, fontWeight: 700, color: '#1a2230' }}>实验室集群管理台</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '3px 10px', borderRadius: 12, background: '#e8f0fe', color: '#2f6fe4', fontSize: 12 }}>
        <Icon name="lock" size={11} />
        内网 · 仅实验室网络可达
      </span>
      <div style={{ flex: 1 }} />
      <span style={{ fontSize: 12.5, color: '#5a6578' }}>admin@lab</span>
    </div>
    <div style={{ display: 'flex', height: VIEW7.h - 64 }}>
      {/* 侧边导航 */}
      <div style={{ width: 200, flex: 'none', background: '#ffffff', borderRight: '1px solid #dde3ea', padding: '14px 10px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {[
          { label: '节点总览', active: true },
          { label: '任务队列', active: false },
          { label: '数据集管理', active: false },
          { label: '作业日志', active: false },
          { label: '系统设置', active: false },
        ].map((it) => (
          <div
            key={it.label}
            style={{
              height: 34, display: 'flex', alignItems: 'center', padding: '0 12px', borderRadius: 6,
              fontSize: 13, color: it.active ? '#2f6fe4' : '#4a5568', background: it.active ? '#e8f0fe' : 'transparent', fontWeight: it.active ? 600 : 400,
            }}
          >
            {it.label}
          </div>
        ))}
      </div>
      {/* 主区 */}
      <div style={{ flex: 1, minWidth: 0, padding: 20 }}>
        <div style={{ display: 'flex', gap: 14, marginBottom: 16 }}>
          {[
            { label: '在线节点', value: '12 / 12' },
            { label: '运行任务', value: '3' },
            { label: '存储用量', value: '68%' },
          ].map((c) => (
            <div key={c.label} style={{ ...intraCard, flex: 1, padding: '16px 18px' }}>
              <div style={{ fontSize: 12, color: '#7a8699' }}>{c.label}</div>
              <div style={{ fontSize: 26, fontWeight: 700, color: '#1a2230', marginTop: 6, fontFamily: FONT_MONO }}>{c.value}</div>
            </div>
          ))}
        </div>
        <div style={intraCard}>
          <div style={{ padding: '12px 16px', borderBottom: '1px solid #dde3ea', fontSize: 14, fontWeight: 600, color: '#1a2230' }}>集群节点</div>
          <div style={{ display: 'flex', padding: '8px 16px', fontSize: 12, color: '#7a8699', borderBottom: '1px solid #e7ecf2' }}>
            <span style={{ width: 160 }}>节点</span>
            <span style={{ width: 180 }}>IP</span>
            <span style={{ width: 140 }}>状态</span>
            <span style={{ width: 120 }}>CPU</span>
            <span>内存</span>
          </div>
          {[
            { node: 'node-01', ip: '192.168.30.11', cpu: '32%', mem: '51%' },
            { node: 'node-02', ip: '192.168.30.12', cpu: '18%', mem: '44%' },
            { node: 'node-03', ip: '192.168.30.13', cpu: '57%', mem: '62%' },
            { node: 'node-04', ip: '192.168.30.14', cpu: '9%', mem: '38%' },
          ].map((r, i) => (
            <div key={r.node} style={{ display: 'flex', alignItems: 'center', padding: '9px 16px', fontSize: 12.5, color: '#2a3444', background: i % 2 ? '#f7f9fb' : 'transparent', borderBottom: '1px solid #eef2f6', fontFamily: FONT_MONO }}>
              <span style={{ width: 160 }}>{r.node}</span>
              <span style={{ width: 180 }}>{r.ip}</span>
              <span style={{ width: 140, display: 'inline-flex', alignItems: 'center', gap: 6, color: '#1f9d61' }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: '#1f9d61' }} />运行中
              </span>
              <span style={{ width: 120 }}>{r.cpu}</span>
              <span>{r.mem}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

/* ---------- 浏览器标签页(地址栏可输入;nebula → 内网站点) ---------- */

const iconBtn28: React.CSSProperties = {
  width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg1, color: C.text1, flex: 'none',
};

const BrowserPane7: React.FC<{ st: Wb7State; frame: number }> = ({ st, frame }) => (
  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ height: 41, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderBottom: `1px solid ${C.border}`, boxSizing: 'border-box' }}>
      {(['arrowLeft', 'arrowRight', 'refresh'] as IconName[]).map((n) => (
        <div key={n} style={iconBtn28}>
          <Icon name={n} size={15} />
        </div>
      ))}
      <div
        style={{
          flex: 1, height: 28, display: 'flex', alignItems: 'center', padding: '0 10px', borderRadius: 4,
          border: `1px solid ${st.addrFocus ? C.accent : C.border}`, background: C.bg2, fontSize: 13,
          fontFamily: FONT_MONO, color: C.text0, overflow: 'hidden', whiteSpace: 'nowrap',
        }}
      >
        {st.addrFocus ? (
          <span>
            {st.addrText}
            <span style={{ display: 'inline-block', width: 1.5, height: 14, background: C.accent, verticalAlign: '-2px', marginLeft: 1, opacity: frame % 30 < 15 ? 1 : 0 }} />
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {st.loading && <Spinner frame={frame} />}
            {st.site === 'intra' ? DEMO.intraUrl : DEMO.siteUrl}
          </span>
        )}
      </div>
      {(['folderOpen', 'inspect', 'wrench'] as IconName[]).map((n) => (
        <div key={n} style={iconBtn28}>
          <Icon name={n} size={15} />
        </div>
      ))}
    </div>
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0, background: C.bg1, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: VIEW7.w, height: VIEW7.h }}>
          <div style={{ position: 'absolute', inset: 0, opacity: st.site === 'nebula' ? 1 : 1 - st.siteIn }}>
            <Site1 styled={1} />
          </div>
          {st.siteIn > 0 && (
            <div style={{ position: 'absolute', inset: 0, opacity: st.siteIn, transform: `translateY(${(1 - st.siteIn) * 14}px)` }}>
              <SiteIntra />
            </div>
          )}
        </div>
      </div>
      <div style={{ width: 34, flex: 'none', borderLeft: `1px solid ${C.border}`, background: C.bg1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '6px 0' }}>
        <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg1, color: C.text1 }}>
          <Icon name="chevronLeft" size={13} />
        </div>
        <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg1, color: C.text1 }}>
          <Icon name="plus" size={13} />
        </div>
        <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.accent}`, borderRadius: 4, background: C.accentDim, color: C.accent, marginTop: 2 }}>
          <Icon name="globe" size={14} />
        </div>
      </div>
    </div>
  </div>
);

/* ---------- SSH 隧道标签页 ---------- */

const StatusBadge: React.FC<{ running: boolean }> = ({ running }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: running ? '#2e9e5b' : C.text2 }}>
    <span style={{ width: 8, height: 8, borderRadius: '50%', background: running ? '#2e9e5b' : C.text2 }} />
    {running ? '运行中' : '已停止'}
  </span>
);

const TunnelRow: React.FC<{
  row: number;
  name: string;
  route: string;
  running: boolean;
  present: boolean;
  t: number;
  hover: T7;
  toggleTarget: T7;
}> = ({ row, name, route, running, present, t, hover, toggleTarget }) => {
  if (!present) return null;
  return (
    <div
      style={{
        position: 'absolute', left: 0, right: 0, top: row * (TUN.rowH + TUN.gap), height: TUN.rowH, boxSizing: 'border-box',
        padding: '10px 12px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8,
        opacity: t, transform: `translateY(${(1 - t) * 10}px)`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <strong style={{ fontSize: 13, color: C.text0 }}>{name}</strong>
          <StatusBadge running={running} />
        </div>
        <div style={{ fontSize: 12, color: C.text1, marginTop: 4, fontFamily: FONT_MONO }}>{route}</div>
      </div>
      {/* 按钮组:右内缘 12,与 layout 的 btnStop/btnEdit/btnDel 窗口锚点严格一致 */}
      <div style={{ position: 'absolute', right: 12, top: (TUN.rowH - 24) / 2, display: 'flex', gap: 6 }}>
        <span style={{ width: TUN.btnStop.w, ...btnSmall(false, { hovered: hover === toggleTarget }), justifyContent: 'center' }}>
          {running ? '停止' : '启动'}
        </span>
        <span style={{ width: TUN.btnEdit.w, ...btnSmall(false, {}), justifyContent: 'center' }}>编辑</span>
        <span style={{ width: TUN.btnDel.w, ...btnSmall(false, { danger: true }), justifyContent: 'center' }}>删除</span>
      </div>
    </div>
  );
};

const TunnelPanel: React.FC<{ st: Wb7State }> = ({ st }) => {
  const empty = !st.row1.present && !st.row2.present;
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {/* 头:窗口 y90 起(内容区 y76 + padding 14) */}
      <div style={{ position: 'absolute', left: 18, right: 18, top: 14, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 15, fontWeight: 600 }}>
            <Icon name="tunnel" size={16} />SSH 隧道
            <span style={{ fontSize: 12, fontWeight: 400, color: C.text2 }}>· {DEMO.serverName}</span>
          </div>
          <div style={{ fontSize: 11.5, color: C.text2, marginTop: 5 }}>本地端口 → 远端目标端口（经服务器 SSH 连接转发）；关闭本标签页不停止隧道。</div>
        </div>
        <span
          style={{
            height: 24, padding: '0 10px', display: 'inline-flex', alignItems: 'center', gap: 4, borderRadius: 4,
            border: `1px solid ${C.accent}`, background: st.hover === 'newTunnel' || st.press === 'newTunnel' ? C.accentHover : C.accent,
            color: '#fff', fontSize: 12, whiteSpace: 'nowrap',
          }}
        >
          <Icon name="plus" size={12} />新建隧道
        </span>
      </div>
      {/* 卡片列表:窗口 y146 起(局部 top = TUN.rowY - 76),行按行号偏移,锚点即窗口坐标 */}
      <div style={{ position: 'absolute', left: 18, right: 18, top: TUN.rowY - 76, bottom: 0 }}>
        <TunnelRow
          row={0}
          name={DEMO.tun1Name}
          route={`127.0.0.1:${DEMO.tun1Port} → SOCKS5 动态代理`}
          running={st.row1.running}
          present={st.row1.present}
          t={st.row1.t}
          hover={st.hover}
          toggleTarget="row1Toggle"
        />
        <TunnelRow
          row={1}
          name={DEMO.tun2Name}
          route={`127.0.0.1:${DEMO.tun2Port} → localhost:${DEMO.tun2TargetPort}`}
          running={st.row2.running}
          present={st.row2.present}
          t={st.row2.t}
          hover={st.hover}
          toggleTarget="row2Toggle"
        />
        {empty && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: C.text2 }}>
            <div style={{ color: C.text2, opacity: 0.7 }}>
              <Icon name="tunnel" size={34} strokeWidth={1.5} />
            </div>
            <div style={{ fontSize: 13, color: C.text1 }}>暂无隧道</div>
            <div style={{ fontSize: 12 }}>新建隧道后，本地应用可直接访问远端内网服务（如数据库、Web 管理页）。</div>
          </div>
        )}
      </div>
    </div>
  );
};

/* ---------- 新建隧道模态 ---------- */

const KIND_OPTIONS = ['本地端口转发（-L，固定目标）', 'SOCKS5 动态代理（-D，目标由客户端指定）'];

const TunnelModal: React.FC<{ st: Wb7State; frame: number }> = ({ st, frame }) => {
  if (!st.dlg) return null;
  const isNew1 = st.dlg === 'new1';
  const t = st.dlgT;
  const kindLocal = !isNew1 && st.f2Kind === 'local';
  const nameValue = isNew1 ? st.f1Name : st.f2Name;
  const portValue = isNew1 ? st.f1Port : st.f2Port;
  const kindText = isNew1 ? KIND_OPTIONS[1] : kindLocal ? KIND_OPTIONS[0] : KIND_OPTIONS[1];
  const nameFocus = st.hover === 'nameInput';
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute', left: TDIA.x, top: TDIA.y, width: TDIA.w, height: TDIA.h, boxSizing: 'border-box',
          background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>新建隧道</span>
          <Icon name="x" size={14} color={C.text2} />
        </div>
        <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
          {/* 坐标校正层:字段常量是窗口坐标,平移回模态局部原点(head 48 之下) */}
          <div style={{ position: 'absolute', left: -TDIA.x, top: -(TDIA.y + 48), width: TDIA.w, height: TDIA.h - 48 }}>
            <FieldLabel x={TDIA_F.nameInput.x} cy={TDIA_F.nameLabelCy} text="名称" req />
            <BoxInput box={TDIA_F.nameInput} value={nameValue} placeholder="例如：内网数据库" focus={nameFocus} caret={nameFocus} />
            <FieldLabel x={TDIA_F.kindSel.x} cy={TDIA_F.kindLabelCy} text="类型" />
            <BoxInput box={TDIA_F.kindSel} value={kindText} chevron focus={st.hover === 'kindSel' || st.kindMenuOpen} />
            <FieldLabel x={TDIA_F.bindInput.x} cy={TDIA_F.bindLabelCy} text="本地绑定地址" />
            <BoxInput box={TDIA_F.bindInput} value="127.0.0.1" mono />
            <div style={{ position: 'absolute', left: TDIA_F.bindInput.x, top: TDIA_F.bindHintY, width: 484, fontSize: 11, color: C.text2, lineHeight: 1.5 }}>
              默认 127.0.0.1 仅本机可访问；改 0.0.0.0 会暴露给局域网，请谨慎。
            </div>
            <FieldLabel x={TDIA_F.portInput.x} cy={TDIA_F.rowLabelCy} text="本地端口" req />
            <BoxInput box={TDIA_F.portInput} value={portValue} placeholder="3307" mono focus={st.hover === 'portInput'} caret={portValue.length > 0 && st.hover === 'portInput'} />
            {kindLocal ? (
              <>
                <FieldLabel x={TDIA_F.hostInput.x} cy={TDIA_F.rowLabelCy} text="目标主机" />
                <BoxInput box={TDIA_F.hostInput} value="" placeholder="localhost（服务器自身）" mono />
                <FieldLabel x={TDIA_F.targetInput.x} cy={TDIA_F.rowLabelCy} text="目标端口" req />
                <BoxInput box={TDIA_F.targetInput} value={st.f2Target} placeholder="3306" mono focus={st.hover === 'targetInput'} caret={st.f2Target.length > 0 && st.hover === 'targetInput'} />
              </>
            ) : (
              <div style={{ position: 'absolute', left: TDIA_F.hostInput.x, width: 318, top: TDIA_F.dynHintY, fontSize: 11, color: C.text2, lineHeight: 1.6 }}>
                目标地址由客户端在 SOCKS5 握手时指定（浏览器/代理工具填 127.0.0.1:端口 即可；域名由远端解析）。
              </div>
            )}
          </div>
        </div>
        <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', borderTop: `1px solid ${C.border}` }}>
          <div style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13, color: C.text1 }}>取消</div>
          <div style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4, fontSize: 13, color: '#fff', background: st.hover === 'saveOk' ? C.accentHover : C.accent }}>
            <Icon name="plus" size={13} />保存并启动
          </div>
        </div>
        {/* 类型下拉菜单 */}
        {st.kindMenuOpen && (
          <div
            style={{
              position: 'absolute', left: TDIA_MENU.x - TDIA.x, top: TDIA_MENU.y - TDIA.y, width: TDIA_MENU.w, padding: TDIA_MENU.pad,
              background: C.bg2, border: `1px solid ${C.borderStrong}`, borderRadius: 6,
              boxShadow: '0 4px 16px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', zIndex: 51,
            }}
          >
            {KIND_OPTIONS.map((label, i) => {
              const current = isNew1 ? i === 1 : (st.f2Kind === 'local' ? i === 0 : i === 1);
              return (
                <div
                  key={label}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6, height: TDIA_MENU.itemH, padding: '0 10px', borderRadius: 4,
                    fontSize: 12.5, color: st.kindHover === i ? C.text0 : current ? C.accent : C.text1,
                    background: st.kindHover === i ? C.bgHover : 'transparent', whiteSpace: 'nowrap', overflow: 'hidden',
                  }}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
                  {current && <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.accent, marginLeft: 'auto', flex: 'none' }} />}
                </div>
              );
            })}
            <span style={{ display: 'none' }}>{`${tdiaMenuItemCy(0)},${tdiaMenuItemCy(1)}`}</span>
          </div>
        )}
      </div>
    </div>
  );
};

/* ---------- 端口冲突确认框 ---------- */

const ConflictDialog: React.FC<{ t: number; hover: T7 }> = ({ t, hover }) => (
  <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 52 }}>
    <div
      style={{
        position: 'absolute', left: CFM7.x, top: 600 - CFM7.h / 2, width: CFM7.w, height: CFM7.h,
        boxSizing: 'border-box', background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>端口已被占用</span>
        <Icon name="x" size={14} color={C.text2} />
      </div>
      <div style={{ flex: 1, padding: '14px 18px', color: C.text1, fontSize: 12.5, lineHeight: '20px' }}>
        该端口已被「{DEMO.tun1Name}」占用，是否将其关闭？
      </div>
      <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', borderTop: `1px solid ${C.border}` }}>
        <div style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13, color: C.text1 }}>取消</div>
        <div style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', borderRadius: 4, fontSize: 13, color: '#fff', background: hover === 'cfmOk' ? C.accentHover : C.accent }}>
          关闭并启动
        </div>
      </div>
      <span style={{ display: 'none' }}>{`${CFM7_BTN.ok.x},${CFM7_BTN.cancel.x}`}</span>
    </div>
  </div>
);

/* ---------- 设置页 ---------- */

const NAV_ITEMS7: { label: string; icon: IconName }[] = [
  { label: '功能特性', icon: 'zap' },
  { label: '凭据库', icon: 'key' },
  { label: '外观', icon: 'monitor' },
  { label: '快捷键', icon: 'key' },
  { label: 'API 接口', icon: 'plug' },
  { label: '关于与更新', icon: 'info' },
  { label: '浏览器', icon: 'globe' },
];

const setCy = (i: number): number => SET.navTop + SET.navPadTop + i * SET.navItemH + SET.navItemH / 2;

const SettingsPage: React.FC<{ st: Wb7State }> = ({ st }) => {
  const browserActive = st.setPage === 'browser';
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 0, display: 'flex', background: C.bg0 }}>
      {/* 左导航 */}
      <div style={{ width: SET.navW, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', gap: 2, padding: `20px 12px` }}>
        {NAV_ITEMS7.map((it, i) => {
          const active = browserActive ? i === NAV_BROWSER : i === NAV_FEATURES;
          return (
            <div
              key={it.label}
              style={{
                height: 30, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRadius: 6,
                fontSize: 12.5, color: active ? C.accent : C.text1,
                background: active ? C.accentDim : st.hover === 'navBrowser' && i === NAV_BROWSER ? C.bgHover : 'transparent',
                fontWeight: active ? 600 : 400,
              }}
            >
              <Icon name={it.icon} size={14} />
              {it.label}
            </div>
          );
        })}
        <span style={{ display: 'none' }}>{`${setCy(NAV_BROWSER)}`}</span>
      </div>
      {/* 内容 */}
      <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', padding: '24px 28px', position: 'relative' }}>
        {!browserActive ? (
          /* 功能特性(简化复刻,仅通用 + SSH 隧道两组;背景板,无指针交互) */
          <div style={{ maxWidth: SET.panelW }}>
            <div style={{ fontSize: 15, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <Icon name="zap" size={15} />功能特性
            </div>
            <fieldset style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '12px 16px 14px', margin: '0 0 14px' }}>
              <legend style={{ fontSize: 12, fontWeight: 600, color: C.text1, padding: '0 6px' }}>通用</legend>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: C.text1, marginBottom: 10 }}>
                <Checkbox checked />自动备份远程文件修改
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: C.text1 }}>
                <Checkbox checked />紧凑服务器列表
              </label>
            </fieldset>
            <fieldset style={{ border: `1px solid ${C.border}`, borderRadius: 6, padding: '12px 16px 14px', margin: 0 }}>
              <legend style={{ fontSize: 12, fontWeight: 600, color: C.text1, padding: '0 6px' }}>SSH 隧道</legend>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: C.text1 }}>
                <Checkbox checked />AIShell 启动时自动启动隧道
              </label>
              <div style={{ fontSize: 11, color: C.text2, lineHeight: 1.6, marginTop: 8 }}>
                开启后，上次处于启用状态的 SSH 隧道随 AIShell 启动自动恢复。关闭后：AIShell 退出时会自动把所有隧道设为禁用。
              </div>
            </fieldset>
          </div>
        ) : (
          /* 内置浏览器面板(BrowserPanel 复刻):绝对定位 + 坐标校正层,锚点=窗口坐标常量 */
          <div style={{ width: SET.panelW, position: 'relative' }}>
            <div style={{ position: 'absolute', left: -SET.panelX, top: -SET.panelY }}>
              <div style={{ position: 'absolute', left: 204, top: 71, fontSize: 15, fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 8, whiteSpace: 'nowrap' }}>
                <Icon name="globe" size={15} />内置浏览器
              </div>
              <div style={{ position: 'absolute', left: 204, top: 100, width: 720, fontSize: 11.5, color: C.text2, lineHeight: 1.6 }}>
                SOCKS5 代理只作用于内置浏览器（不影响主界面与其他功能）；保存后已打开的浏览器标签页会自动重建。
              </div>
              <div style={{ position: 'absolute', left: 204, top: PANEL7.brEnableLabelY - 9, fontSize: 12.5, color: C.text1, whiteSpace: 'nowrap' }}>
                启用 SOCKS5 代理
              </div>
              <div style={{ position: 'absolute', left: PANEL7.brEnableBox.x, top: PANEL7.brEnableBox.y }}>
                <Checkbox size={15} checked={st.proxyEnabled} />
              </div>
              {st.proxyEnabled && (
                <>
                  <div style={{ position: 'absolute', left: 204, top: PANEL7.brSrcLabelY - 9, fontSize: 12.5, color: C.text1, whiteSpace: 'nowrap' }}>
                    代理来源
                  </div>
                  <div style={{ position: 'absolute', left: PANEL7.brRadio1.x, top: PANEL7.brRadio1.y, display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.text1, whiteSpace: 'nowrap' }}>
                    <Radio checked />
                    从运行中的 SSH 隧道选择
                  </div>
                  <div style={{ position: 'absolute', left: PANEL7.brRadio2.x, top: PANEL7.brRadio2.y, display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: C.text2, whiteSpace: 'nowrap' }}>
                    <Radio checked={false} />
                    手动输入
                  </div>
                  <div style={{ position: 'absolute', left: 204, top: PANEL7.brSelLabelY - 9, fontSize: 12.5, color: C.text1, whiteSpace: 'nowrap' }}>
                    SSH 隧道(SOCKS5 动态代理)
                  </div>
                  <div style={{ position: 'absolute', left: 204, top: PANEL7.brSel.y, width: PANEL7.brSel.w }}>
                    <BoxInput box={{ x: 0, y: 0, w: PANEL7.brSel.w, h: PANEL7.brSel.h }} value={st.selValue ? `内网代理（127.0.0.1:${DEMO.tun1Port}）` : ''} placeholder="请选择隧道…" chevron focus={st.selOpen || st.hover === 'selBox'} />
                    {st.selOpen && (
                      <div
                        style={{
                          position: 'absolute', left: 0, top: PANEL7.brSel.h + 4, width: BR_MENU_W, padding: 4,
                          background: C.bg2, border: `1px solid ${C.borderStrong}`, borderRadius: 6,
                          boxShadow: '0 4px 16px rgba(0,0,0,0.4)', zIndex: 20,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex', alignItems: 'center', gap: 6, height: 30, padding: '0 10px', borderRadius: 4,
                            color: st.selHover ? C.text0 : C.text1, background: st.selHover ? C.bgHover : 'transparent',
                            whiteSpace: 'nowrap', fontFamily: FONT_MONO, fontSize: 12,
                          }}
                        >
                          内网代理（127.0.0.1:{DEMO.tun1Port}）
                        </div>
                        <span style={{ display: 'none' }}>{`${brMenuItemCy(0)},${brRadioCy(PANEL7.brRadio1).x}`}</span>
                      </div>
                    )}
                  </div>
                  <div style={{ position: 'absolute', left: 204, top: PANEL7.brSelHintY, width: 720, fontSize: 11, color: C.text2, lineHeight: 1.6 }}>
                    只列「运行中」的动态隧道；在服务器卡片「更多 → SSH 隧道」里创建并启动后回到本页刷新。
                  </div>
                </>
              )}
              <div
                style={{
                  position: 'absolute', left: 204, top: PANEL7.brStatusY - 9, fontSize: 12.5, whiteSpace: 'nowrap',
                  color: !st.proxyEnabled ? C.text2 : st.selValue ? C.green : C.red,
                }}
              >
                {!st.proxyEnabled
                  ? '未启用:内置浏览器走直连'
                  : st.selValue
                    ? `当前生效:socks5://127.0.0.1:${DEMO.tun1Port}(隧道「${DEMO.tun1Name}」)`
                    : '未生效:所选隧道未在运行,当前回落直连'}
              </div>
              <div style={{ position: 'absolute', left: PANEL7.brSave.x, top: PANEL7.brSave.y, whiteSpace: 'nowrap' }}>
                <span style={{ height: 32, padding: '0 16px', display: 'inline-flex', alignItems: 'center', gap: 6, borderRadius: 4, fontSize: 13, color: '#fff', background: st.hover === 'psave' ? C.accentHover : C.accent }}>
                  保存
                </span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const BR_MENU_W = PANEL7.brSel.w;

/* ---------- AI 面板(本段与 AI 无关:空会话,仅作工作台背景) ---------- */

const AiPanel: React.FC = () => (
  <div style={{ position: 'relative', width: 340, flex: 'none', background: C.bg1, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
    <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: `1px solid ${C.border}` }}>
      <div
        style={{
          flex: 1, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          padding: '0 8px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, color: C.text0,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>新会话</span>
        <Icon name="chevronDown" size={12} color={C.text2} />
      </div>
      <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1, borderRadius: 4 }}>
        <Icon name="plus" size={14} />
      </div>
    </div>
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }} />
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
          @local
        </span>
      </div>
      <div
        style={{
          position: 'relative', flex: 1, minHeight: 0, padding: '8px 10px', background: C.bg2,
          border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12.5, lineHeight: '20px',
        }}
      >
        <span style={{ color: C.text2 }}>向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器</span>
        <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10.5, color: C.text2 }}>Enter 发送</span>
      </div>
    </div>
  </div>
);

/* ---------- 状态栏(含隧道角标) ---------- */

const Statusbar: React.FC<{ badge: number }> = ({ badge }) => (
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
    {badge > 0 && (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 12, color: C.green }} title={`运行中的 SSH 隧道（${badge}）`}>
        <Icon name="tunnel" size={12} />
        {badge}
      </span>
    )}
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 4, background: C.accentDim, color: C.accent }}>
      <Icon name="bot" size={12} /> AI 助手
    </span>
    <span style={{ display: 'none' }}>{`${BADGE.x},${BADGE.y}`}</span>
  </div>
);

/* ---------- 主组件 ---------- */

export const Wb7: React.FC<{ state: Wb7State; frame: number }> = ({ state, frame }) => {
  const st = state;
  return (
    <div
      style={{
        position: 'absolute', width: WIN_W, height: WIN_H, background: C.bg0, color: C.text0,
        fontFamily: FONT_UI, fontSize: 13, borderRadius: 14, border: `1px solid ${C.borderStrong}`,
        overflow: 'hidden', boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
      }}
    >
      <TopBar active={st.page === 'workbench' ? '项目' : '设置'} project={DEMO.projectName} />

      {/* 工作台页面 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 26, display: 'flex', opacity: 1 - st.pageT, pointerEvents: st.page === 'workbench' ? 'auto' : 'none' }}>
        <ActivityBar />

        <div style={{ position: 'relative', width: 260, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 10px 0 14px', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: C.text1 }}>
            服务器列表
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
            <ServersPanel st={st} />
          </div>
        </div>

        {/* 中央:三标签(keep-alive 常驻,仅切显隐) */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg0 }}>
          <div style={{ height: 36, flex: 'none', display: 'flex', alignItems: 'stretch', background: C.bg1, borderBottom: `1px solid ${C.border}`, overflow: 'hidden' }}>
            <WbTab icon="terminal" title="本地终端" active={st.centerTab === 'terminal'} />
            <WbTab icon="globe" title="浏览器" active={st.centerTab === 'browser'} />
            {st.tunnelTabT > 0 && (
              <div style={{ width: TAB_W * st.tunnelTabT, opacity: st.tunnelTabT, overflow: 'hidden', display: 'flex' }}>
                <WbTab icon="tunnel" title="SSH 隧道" active={st.centerTab === 'tunnel'} w={TAB_W} />
              </div>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            <div style={{ position: 'absolute', inset: 0, display: st.centerTab === 'terminal' ? 'flex' : 'none' }}>
              <TermPane frame={frame} />
            </div>
            <div style={{ position: 'absolute', inset: 0, display: st.centerTab === 'browser' ? 'flex' : 'none' }}>
              <BrowserPane7 st={st} frame={frame} />
            </div>
            <div style={{ position: 'absolute', inset: 0, display: st.centerTab === 'tunnel' ? 'flex' : 'none' }}>
              <TunnelPanel st={st} />
            </div>
          </div>
        </div>

        <AiPanel />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 26, opacity: 1 - st.pageT, pointerEvents: st.page === 'workbench' ? 'auto' : 'none' }}>
        <Statusbar badge={st.badge} />
      </div>

      {/* 设置页 */}
      <div
        style={{
          position: 'absolute', inset: 0, opacity: st.pageT,
          transform: `translateY(${(1 - st.pageT) * 12}px)`, pointerEvents: st.page === 'settings' ? 'auto' : 'none',
        }}
      >
        <SettingsPage st={st} />
      </div>

      {/* 覆盖层:服务器菜单 45 < toast 46 < 模态 50 < 冲突框 52 */}
      {st.toast && (
        <div
          style={{
            position: 'absolute', right: 24, bottom: 34, padding: '11px 18px', background: C.bg2,
            border: `1px solid ${C.borderStrong}`, borderRadius: 8, fontSize: 12.5,
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)', whiteSpace: 'nowrap', zIndex: 46, maxWidth: 560,
          }}
        >
          {st.toast}
        </div>
      )}
      {st.dlg && <TunnelModal st={st} frame={frame} />}
      {st.cfm && <ConflictDialog t={st.cfmT} hover={st.hover} />}
      <span style={{ display: 'none' }}>{`${TOP_NAV.settings.x},${TOP_NAV.project.x},${BR7.address.x},${SRV.more.x},${NAV_FEATURES}`}</span>
    </div>
  );
};
