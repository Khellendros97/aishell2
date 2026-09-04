/**
 * 视频五工作台复刻:内置浏览器标签页(工具栏/页面区/「标签页」窄轨)+ 双站点页面
 * (站点一 Nebula Data 部署在远程主机;站点二 Aurora AI 本地设计稿)+ 检查元素覆盖层
 * (browser.rs INSPECTOR_JS 实测样式)+ AI 面板(含「在内置浏览器中打开」文本建议卡)。
 * 全部内容由 state(Wb5State)驱动,锚点见 ./layout.ts;
 * 坐标约定:站点内容为页面区局部坐标,检查覆盖层同系;聊天条目绝对定位于消息区。
 */
import React from 'react';
import { TopBar } from '../components/TopBar';
import { C, FONT_MONO, FONT_UI, IconName } from '../theme';
import { Icon } from '../ui';
import { WIN_H, WIN_W } from '../scene';
import {
  ACT, ACT_BOX, BR, BR_CY, CHAT, ChatItem, DEMO, EFFORT_SEL, ITEM_W, MODE_SEL, RAIL, RAIL_DOT_CY,
  RAIL_NEW_CY, RAIL_TOGGLE_CY, SITE1, TAB_BROWSER_X, TAB_TERM_X, TAB_W, TERM_BASE, TermLine,
  VIEW, brCx, toWin,
} from './layout';

/* ---------- 状态 ---------- */

export type T5 = 'actBrowser' | 'address' | 'inspect' | 'globe' | 'input' | null;

export interface Wb5State {
  /** 浏览器标签页进场 t(0..1,标签栏宽度/透明度) */
  browserTabT: number;
  centerTab: 'terminal' | 'browser';
  addressFocus: boolean;
  addressText: string;
  addressCaret: boolean;
  /** 当前页面内容:空提示 / 站点一(远程) / 站点二(本地设计稿) */
  site: 'none' | 'remote' | 'local';
  siteIn: number;
  /** 页面加载进度条 0..1(0 = 隐藏) */
  loading: number;
  /** 页面缩放(Ctrl+滚轮) */
  zoom: number;
  /** 检查元素按钮激活态 */
  inspectOn: boolean;
  /** 检查覆盖层(hero 标题,进出场 t) */
  inspect: { t: number } | null;
  /** 站点一改样式 t(标题品牌蓝 64px / 按钮胶囊圆角) */
  styledT: number;
  items: ChatItem[];
  inputText: string;
  inputCaret: boolean;
  inputFocus: boolean;
  inputChip: boolean;
  hover: T5;
  press: T5;
}

/* ---------- 小组件 ---------- */

const iconBtn = (size: number, opts: { hovered?: boolean; active?: boolean; pressed?: boolean }): React.CSSProperties => ({
  width: size,
  height: size,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 4,
  border: `1px solid ${opts.active || opts.hovered ? C.accent : C.border}`,
  background: opts.active ? C.accentDim : opts.hovered ? C.bg3 : C.bg1,
  color: opts.active || opts.hovered ? C.accent : C.text1,
  transform: opts.pressed ? 'translateY(0.5px)' : 'none',
});

const Spinner: React.FC<{ frame: number }> = ({ frame }) => (
  <svg viewBox="0 0 24 24" width={11} height={11} style={{ opacity: frame % 20 < 10 ? 1 : 0.45 }}>
    <g fill="none" stroke={C.text2} strokeWidth={2.6} strokeLinecap="round">
      <path d="M12 3a9 9 0 1 1-9 9" opacity={0.35} />
      <path d="M12 3a9 9 0 0 1 6.4 2.6" />
    </g>
  </svg>
);

const btnSmall = (primary: boolean, hovered: boolean, pressed: boolean): React.CSSProperties => ({
  height: 24,
  padding: '0 10px',
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 4,
  border: `1px solid ${primary ? C.accent : C.border}`,
  background: primary ? (hovered ? C.accentHover : C.accent) : hovered ? C.bg3 : C.bg2,
  color: primary ? '#fff' : C.text0,
  fontSize: 12,
  lineHeight: '16px',
  transform: pressed ? 'translateY(0.5px)' : 'none',
});

/* ---------- 活动栏 ---------- */

const ACT_ITEMS = [
  { icon: 'folder', id: 'explorer', label: '文件资源管理器' },
  { icon: 'monitor', id: 'servers', label: '服务器列表' },
  { icon: 'star', id: 'commands', label: '命令收藏' },
  { icon: 'sparkles', id: 'skills', label: 'Skill' },
  { icon: 'pencil', id: 'notes', label: '笔记' },
  { icon: 'globe', id: 'browser', label: '浏览器(在标签页中打开)' },
] as const;

/** 对照 Workbench.tsx:浏览器是中央标签页入口,活动项永不带 active 态(侧栏面板保持高亮) */
const ActivityBar: React.FC<{ hover: T5; press: T5 }> = ({ hover, press }) => (
  <div style={{ width: 48, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6, gap: 2 }}>
    {ACT_ITEMS.map((it) => {
      const active = it.id === 'servers';
      const isBr = it.id === 'browser';
      const hovered = isBr && hover === 'actBrowser';
      const pressed = isBr && press === 'actBrowser';
      return (
        <div
          key={it.id}
          title={it.label}
          style={{
            width: ACT_BOX.w,
            height: ACT_BOX.h,
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '0 8px 8px 0',
            borderLeft: `2px solid ${active ? C.accent : 'transparent'}`,
            color: active ? C.accent : hovered ? C.text0 : C.text1,
            background: active || hovered ? C.bgHover : 'transparent',
            transform: pressed ? 'translateY(0.5px)' : 'none',
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

/* ---------- 侧栏:服务器列表(deep 锚定主机,展开态) ---------- */

const ServersPanel: React.FC = () => (
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
    <div style={{ padding: '8px 12px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8 }}>
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
          <div key={n} style={iconBtn(26, {})}>
            <Icon name={n} size={13} />
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ---------- 中央标签栏 ---------- */

const WbTab: React.FC<{ icon: IconName; title: string; active: boolean; w?: number; opacity?: number }> = ({ icon, title, active, w = TAB_W, opacity = 1 }) => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 6,
      padding: '0 8px 0 12px',
      width: w,
      flex: 'none',
      borderRight: `1px solid ${C.border}`,
      borderTop: `2px solid ${active ? C.accent : 'transparent'}`,
      background: active ? C.bg0 : C.bg1,
      fontSize: 12.5,
      color: active ? C.text0 : C.text1,
      overflow: 'hidden',
      opacity,
    }}
  >
    <span style={{ display: 'flex', flex: 'none' }}>
      <Icon name={icon} size={15} />
    </span>
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{title}</span>
    <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2, borderRadius: 3, flex: 'none' }}>
      <Icon name="x" size={11} />
    </span>
  </div>
);

/* ---------- 终端(常驻标签,本片作背景) ---------- */

const TermPane: React.FC<{ frame: number }> = ({ frame }) => (
  <div
    style={{
      flex: 1,
      minHeight: 0,
      background: '#0d1117',
      padding: '10px 12px',
      fontFamily: FONT_MONO,
      fontSize: 12.5,
      lineHeight: 1.7,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      justifyContent: 'flex-end',
    }}
  >
    {[...TERM_BASE, { prompt: true } as TermLine].map((l, i) => {
      const isCmd = !!(l.prompt || l.cmd);
      return (
        <div key={i} style={{ whiteSpace: 'pre', color: isCmd ? C.text0 : C.text1 }}>
          {isCmd && <span style={{ color: C.green }}>$ </span>}
          {l.cmd || l.text || ' '}
          {l.prompt && (
            <span
              style={{
                display: 'inline-block',
                width: 7,
                height: 14,
                background: C.text1,
                verticalAlign: '-2px',
                marginLeft: 2,
                opacity: frame % 32 < 16 ? 1 : 0,
              }}
            />
          )}
        </div>
      );
    })}
  </div>
);

/* ---------- 站点一:Nebula Data(部署在远程主机的浅色官网) ---------- */

export const Site1: React.FC<{ styled: number }> = ({ styled }) => {
  const hero = {
    x: SITE1.heroTitle.x + (SITE1.heroTitleStyled.x - SITE1.heroTitle.x) * styled,
    y: SITE1.heroTitle.y + (SITE1.heroTitleStyled.y - SITE1.heroTitle.y) * styled,
    w: SITE1.heroTitle.w + (SITE1.heroTitleStyled.w - SITE1.heroTitle.w) * styled,
    h: SITE1.heroTitle.h + (SITE1.heroTitleStyled.h - SITE1.heroTitle.h) * styled,
  };
  const features = [
    { icon: 'zap' as IconName, title: '实时管道', desc: '百万点/秒写入，端到端延迟毫秒级' },
    { icon: 'search' as IconName, title: '智能告警', desc: '时序异常自动检测，告警精准直达' },
    { icon: 'monitor' as IconName, title: '可视化看板', desc: '拖拽式搭建，大屏与报表一键生成' },
  ];
  return (
    <div style={{ position: 'absolute', inset: 0, background: '#f8f9fb', color: '#111827' }}>
      {/* 站点头部 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 64, background: '#fff', borderBottom: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', padding: '0 40px', gap: 10 }}>
        <span style={{ width: 26, height: 26, borderRadius: 8, background: 'linear-gradient(135deg,#4f8ef7,#22d3ee)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name="zap" size={15} color="#fff" />
        </span>
        <span style={{ fontSize: 17, fontWeight: 700 }}>Nebula Data</span>
        <span style={{ display: 'flex', gap: 32, marginLeft: 56, fontSize: 13.5, color: '#4b5563' }}>
          <span>产品</span><span>文档</span><span>价格</span><span>博客</span>
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ height: 32, padding: '0 16px', display: 'flex', alignItems: 'center', background: '#2563eb', color: '#fff', fontSize: 13, borderRadius: 6 }}>进入控制台</span>
      </div>
      {/* 徽标 pill */}
      <div
        style={{
          position: 'absolute', left: 0, right: 0, top: 140, display: 'flex', justifyContent: 'center',
        }}
      >
        <span style={{ height: 28, padding: '0 14px', display: 'inline-flex', alignItems: 'center', border: '1px solid #dbeafe', background: '#eff6ff', color: '#2563eb', fontSize: 12.5, borderRadius: 999 }}>
          全新 v3.0 · 实时引擎上线
        </span>
      </div>
      {/* hero 标题(改样式目标:品牌蓝 64px) */}
      <div
        style={{
          position: 'absolute', left: hero.x, top: hero.y, width: hero.w, height: hero.h,
          fontSize: 48 + 16 * styled, fontWeight: 700, lineHeight: `${hero.h}px`,
          color: styled > 0 ? `rgb(${17 + 62 * styled},${24 + 119 * styled},${39 + 208 * styled})` : '#111827',
          textAlign: 'center', whiteSpace: 'nowrap',
        }}
      >
        让数据流动起来
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 296, textAlign: 'center', fontSize: 17, color: '#6b7280' }}>
        面向物联网与实时分析的一站式数据平台
      </div>
      {/* CTA(改样式目标:胶囊圆角) */}
      <div
        style={{
          position: 'absolute', left: SITE1.cta.x, top: SITE1.cta.y, width: SITE1.cta.w, height: SITE1.cta.h,
          background: '#2563eb', color: '#fff', fontSize: 15, fontWeight: 600,
          lineHeight: `${SITE1.cta.h}px`, textAlign: 'center', borderRadius: 6 + 16 * styled,
          boxShadow: '0 6px 18px rgba(37,99,235,0.28)',
        }}
      >
        立即体验
      </div>
      {/* 特性卡 */}
      {features.map((f, i) => (
        <div
          key={f.title}
          style={{
            position: 'absolute', left: 69 + i * 380, top: 500, width: 340, height: 190,
            background: '#fff', border: '1px solid #e5e7eb', borderRadius: 12, padding: 24,
            boxShadow: '0 2px 10px rgba(17,24,39,0.04)',
          }}
        >
          <span style={{ width: 40, height: 40, borderRadius: 10, background: '#eff6ff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Icon name={f.icon} size={19} color="#2563eb" />
          </span>
          <div style={{ fontSize: 16, fontWeight: 600, marginTop: 14 }}>{f.title}</div>
          <div style={{ fontSize: 12.5, color: '#6b7280', marginTop: 8, lineHeight: 1.7 }}>{f.desc}</div>
        </div>
      ))}
      {/* 页脚 */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56, background: '#fff', borderTop: '1px solid #e5e7eb', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: '#9ca3af' }}>
        © 2026 Nebula Data
      </div>
    </div>
  );
};

/* ---------- 站点二:Aurora AI(本地设计稿,深色科技风) ---------- */

const Site2: React.FC = () => (
  <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(165deg,#0b1020 0%,#101a36 55%,#0c1326 100%)', color: '#e8eaf0', overflow: 'hidden' }}>
    {/* 氛围光斑 */}
    <div style={{ position: 'absolute', left: -140, top: 60, width: 640, height: 640, background: 'radial-gradient(circle,rgba(79,142,247,0.16) 0%,transparent 65%)' }} />
    <div style={{ position: 'absolute', right: -120, top: 240, width: 560, height: 560, background: 'radial-gradient(circle,rgba(192,132,252,0.13) 0%,transparent 65%)' }} />
    {/* 导航 */}
    <div style={{ position: 'absolute', left: 40, right: 40, top: 28, display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ display: 'flex', color: '#7dd3fc' }}>
        <Icon name="sparkles" size={18} />
      </span>
      <span style={{ fontSize: 17, fontWeight: 700 }}>Aurora AI</span>
      <span style={{ display: 'flex', gap: 32, marginLeft: 56, fontSize: 13.5, color: '#9fb0d8' }}>
        <span>功能</span><span>场景</span><span>定价</span><span>文档</span>
      </span>
      <span style={{ flex: 1 }} />
      <span style={{ height: 34, padding: '0 18px', display: 'flex', alignItems: 'center', background: 'linear-gradient(90deg,#4f8ef7,#7c3aed)', color: '#fff', fontSize: 13, borderRadius: 8 }}>免费开始</span>
    </div>
    {/* hero */}
    <div style={{ position: 'absolute', left: 0, right: 0, top: 150, display: 'flex', justifyContent: 'center' }}>
      <span style={{ height: 26, padding: '0 14px', display: 'inline-flex', alignItems: 'center', border: '1px solid rgba(125,211,252,0.35)', background: 'rgba(125,211,252,0.08)', color: '#7dd3fc', fontSize: 12, borderRadius: 999, letterSpacing: 1 }}>
        AURORA 2.0 · 多模态创作引擎
      </span>
    </div>
    <div
      style={{
        position: 'absolute', left: 0, right: 0, top: 212, textAlign: 'center', fontSize: 54, fontWeight: 800, letterSpacing: 2,
        background: 'linear-gradient(90deg,#7dd3fc,#818cf8,#c084fc)',
        backgroundClip: 'text', WebkitBackgroundClip: 'text', color: 'transparent',
      }}
    >
      让创意，即刻成形
    </div>
    <div style={{ position: 'absolute', left: 0, right: 0, top: 300, textAlign: 'center', fontSize: 16, color: '#9fb0d8' }}>
      从一句话到可交互页面，Aurora 陪你完成每一次创作
    </div>
    <div style={{ position: 'absolute', left: 0, right: 0, top: 360, display: 'flex', justifyContent: 'center', gap: 16 }}>
      <span style={{ width: 132, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'linear-gradient(90deg,#4f8ef7,#7c3aed)', color: '#fff', fontSize: 14.5, fontWeight: 600, borderRadius: 10 }}>开始使用</span>
      <span style={{ width: 132, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid rgba(255,255,255,0.25)', color: '#dbe4ff', fontSize: 14.5, borderRadius: 10 }}>查看文档</span>
    </div>
    {/* 特性卡(玻璃拟态) */}
    {[
      { icon: 'sparkles' as IconName, title: '多模态生成', desc: '文本 / 图像 / 页面一站式生成' },
      { icon: 'bot' as IconName, title: '智能编排', desc: '自然语言编排工作流与自动化' },
      { icon: 'zap' as IconName, title: '一键部署', desc: '边缘网络全球加速分发' },
    ].map((f, i) => (
      <div
        key={f.title}
        style={{
          position: 'absolute', left: 69 + i * 380, top: 470, width: 340, height: 180,
          background: 'rgba(255,255,255,0.055)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, padding: 24,
        }}
      >
        <span style={{ width: 40, height: 40, borderRadius: 10, background: 'rgba(125,211,252,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={f.icon} size={19} color="#7dd3fc" />
        </span>
        <div style={{ fontSize: 15.5, fontWeight: 600, marginTop: 14, color: '#f2f5ff' }}>{f.title}</div>
        <div style={{ fontSize: 12.5, color: '#9fb0d8', marginTop: 8, lineHeight: 1.7 }}>{f.desc}</div>
      </div>
    ))}
    {/* 指标行 */}
    {[
      { n: '40+', label: '创作模型' },
      { n: '12ms', label: '首字延迟' },
      { n: '99.99%', label: '服务可用' },
    ].map((m, i) => (
      <div key={m.label} style={{ position: 'absolute', left: 219 + i * 400, top: 720, width: 200, textAlign: 'center' }}>
        <div style={{ fontSize: 27, fontWeight: 700, color: '#f2f5ff' }}>{m.n}</div>
        <div style={{ fontSize: 12.5, color: '#9fb0d8', marginTop: 6 }}>{m.label}</div>
      </div>
    ))}
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 56, borderTop: '1px solid rgba(255,255,255,0.09)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12.5, color: 'rgba(159,176,216,0.6)' }}>
      © 2026 Aurora AI
    </div>
  </div>
);

/* ---------- 浏览器标签页 ---------- */

const BrowserPane: React.FC<{ st: Wb5State; frame: number }> = ({ st, frame }) => {
  const heroRect = SITE1.heroTitle;
  const heroLabel = 'h1#hero-title  384×60';
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* 工具栏 y76..117 */}
      <div style={{ height: 41, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderBottom: `1px solid ${C.border}`, boxSizing: 'border-box' }}>
        <div style={iconBtn(28, {})} title="后退"><Icon name="arrowLeft" size={15} /></div>
        <div style={iconBtn(28, {})} title="前进"><Icon name="arrowRight" size={15} /></div>
        <div style={iconBtn(28, {})} title="刷新"><Icon name="refresh" size={15} /></div>
        <div style={{ position: 'relative', flex: 1, minWidth: 0, display: 'flex' }}>
          <div
            style={{
              width: '100%', height: 28, display: 'flex', alignItems: 'center', padding: '0 10px',
              borderRadius: 4, border: `1px solid ${st.addressFocus ? C.accent : C.border}`,
              background: C.bg2, fontSize: 13, color: C.text0, boxSizing: 'border-box',
              fontFamily: FONT_MONO, whiteSpace: 'nowrap', overflow: 'hidden',
            }}
          >
            {st.addressText ? (
              <>
                {st.addressText}
                {st.addressCaret && <span style={{ display: 'inline-block', width: 1.5, height: 14, background: C.text0, marginLeft: 1 }} />}
              </>
            ) : (
              <span style={{ color: C.text2 }}>输入网址或本地 HTML 路径,回车打开</span>
            )}
          </div>
        </div>
        <div style={iconBtn(28, {})} title="打开本地 HTML 文件"><Icon name="folderOpen" size={15} /></div>
        <div style={iconBtn(28, { hovered: st.hover === 'inspect', active: st.inspectOn })} title="检查元素:点击页面元素加入 AI 对话">
          <Icon name="inspect" size={15} />
        </div>
        <div style={iconBtn(28, {})} title="开发者工具(该视图的 F12)"><Icon name="wrench" size={15} /></div>
      </div>
      {/* 页面区 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 0, background: C.bg1, overflow: 'hidden' }}>
          {/* 加载进度条 */}
          {st.loading > 0 && (
            <div style={{ position: 'absolute', left: 0, top: 0, height: 3, width: `${Math.round(st.loading * 100)}%`, background: C.accent, boxShadow: '0 0 8px rgba(79,142,247,0.8)', zIndex: 20 }} />
          )}
          {/* 空提示 */}
          {st.site === 'none' && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'center', justifyContent: 'center', color: C.text2, fontSize: 13, textAlign: 'center', lineHeight: 1.8, padding: '0 24px' }}>
              <span style={{ display: 'flex', opacity: 0.6 }}><Icon name="globe" size={32} /></span>
              <span>
                输入网址打开网页,或用上方按钮选择本地 HTML 文件;
                <br />
                「检查元素」选中页面元素后加入 AI 对话
              </span>
            </div>
          )}
          {/* 站点内容(Ctrl+滚轮缩放:整页 scale,transformOrigin 0 0,与真实浏览器缩放观感一致) */}
          {st.site !== 'none' && (
            <div style={{ position: 'absolute', left: 0, top: 0, width: VIEW.w, height: VIEW.h, transform: `scale(${st.zoom})`, transformOrigin: '0 0', opacity: st.siteIn }}>
              {st.site === 'remote' ? <Site1 styled={st.styledT} /> : <Site2 />}
            </div>
          )}
          {/* 检查元素覆盖层(INSPECTOR_JS:#2563eb 2px + 左上角标签) */}
          {st.inspect && (
            <div
              style={{
                position: 'absolute', left: heroRect.x, top: heroRect.y, width: heroRect.w, height: heroRect.h,
                border: '2px solid #2563eb', background: 'rgba(37,99,235,0.12)', boxSizing: 'border-box', opacity: st.inspect.t, zIndex: 30,
              }}
            >
              <div style={{ position: 'absolute', left: -2, top: -24, whiteSpace: 'nowrap', font: '12px/18px Consolas, monospace', background: '#2563eb', color: '#fff', padding: '0 6px', borderRadius: 3 }}>
                {heroLabel}
              </div>
            </div>
          )}
        </div>
        {/* 右侧「标签页」窄轨(折叠) */}
        <div style={{ width: RAIL.w, flex: 'none', borderLeft: `1px solid ${C.border}`, background: C.bg1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '6px 0' }}>
          <div style={iconBtn(24, {})} title="展开标签页列表"><Icon name="chevronLeft" size={13} /></div>
          <div style={iconBtn(24, {})} title="新建页面"><Icon name="plus" size={13} /></div>
          <div
            title={`${DEMO.siteUrl} · 当前页面`}
            style={{
              width: 24, height: 24, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
              border: `1px solid ${C.accent}`, borderRadius: 4, background: C.accentDim, color: C.accent, marginTop: 2,
            }}
          >
            <Icon name="globe" size={14} />
          </div>
          <span style={{ display: 'none' }}>{`${RAIL_TOGGLE_CY},${RAIL_NEW_CY},${RAIL_DOT_CY},${brCx(BR.back)},${BR_CY},${toWin(heroRect).x}`}</span>
        </div>
      </div>
      <span style={{ display: 'none' }}>{frame}</span>
    </div>
  );
};

/* ---------- 聊天条目 ---------- */

const Chip: React.FC<{ label: string }> = ({ label }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 5px',
      borderRadius: 4,
      background: 'rgba(79,142,247,0.28)',
      border: `1px solid ${C.accent}`,
      color: C.accentHover,
      fontSize: 11.5,
      marginRight: 4,
      verticalAlign: 'baseline',
      whiteSpace: 'nowrap',
    }}
  >
    {label}
  </span>
);

const UserBubble: React.FC<{ item: ChatItem }> = ({ item }) =>
  item.kind !== 'user' ? null : (
    <div style={{ position: 'absolute', left: CHAT.l - 1580, top: item.y - 80, width: CHAT.w, display: 'flex', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxWidth: ITEM_W,
          padding: '8px 11px',
          borderRadius: 10,
          borderBottomRightRadius: 3,
          background: C.accentDim,
          fontSize: 12.5,
          lineHeight: '20px',
        }}
      >
        {item.chip && <Chip label={item.chip} />}
        {item.lines.map((l, i) => (
          <span key={i}>
            {l}
            {i < item.lines.length - 1 && <br />}
          </span>
        ))}
      </div>
    </div>
  );

const STATUS_COLOR: Record<string, string> = {
  approving: C.text2,
  smart: C.text2,
  running: C.text2,
  succeeded: C.green,
};
const STATUS_TEXT: Record<string, string> = {
  approving: '等待批准',
  smart: '已智能放行 · 执行中…',
  running: '执行中…',
  succeeded: '成功',
};

const ActionCard: React.FC<{ item: ChatItem; hover: T5; press: T5; frame: number }> = ({ item, frame }) => {
  if (item.kind !== 'action') return null;
  const { status, spec } = item;
  return (
    <div
      style={{
        position: 'absolute',
        left: CHAT.l - 1580,
        top: item.y - 80,
        width: ITEM_W,
        boxSizing: 'border-box',
        padding: '8px 10px',
        background: C.bg2,
        border: `1px solid ${C.border}`,
        borderLeft: status === 'succeeded' ? `3px solid ${C.green}` : `1px solid ${C.border}`,
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, height: 20 }}>
        <span style={{ fontWeight: 600, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          <Icon name={spec.icon} size={13} />
          {spec.name}
        </span>
        <span style={{ fontSize: 11, color: STATUS_COLOR[status], display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
          {(status === 'running' || status === 'smart') && <Spinner frame={frame} />}
          {STATUS_TEXT[status]}
        </span>
      </div>
      {spec.intent && <div style={{ fontSize: 12, lineHeight: '18px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{spec.intent}</div>}
      {spec.cmd && (
        <code
          style={{
            display: 'block',
            boxSizing: 'border-box',
            height: 24,
            lineHeight: '16px',
            padding: '3px 8px',
            background: '#14161b',
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            color: C.text0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {spec.cmd}
        </code>
      )}
      {spec.meta && <div style={{ fontSize: 12, lineHeight: '18px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{spec.meta}</div>}
      {spec.smart && (
        <div style={{ fontSize: 12, lineHeight: '18px', color: status === 'approving' ? C.yellow : C.green, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{spec.smart}</div>
      )}
      {status === 'succeeded' && spec.result && (
        <div
          style={{
            boxSizing: 'border-box',
            height: 28,
            padding: '4px 8px',
            background: '#14161b',
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            fontSize: 12,
            lineHeight: '20px',
            color: C.text1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {spec.result}
        </div>
      )}
    </div>
  );
};

/** 文本建议卡(.ai-suggest.text):含「在内置浏览器中打开」地球按钮 */
const SuggestCard: React.FC<{ text: string; url: boolean; hover: T5 }> = ({ text, url, hover }) => (
  <div
    style={{
      marginTop: 6,
      boxSizing: 'border-box',
      height: 68,
      padding: '8px 10px',
      background: hover === 'globe' ? C.bg3 : C.bg1,
      border: `1px solid ${hover === 'globe' ? C.borderStrong : C.border}`,
      borderLeft: `3px solid ${C.accent}`,
      borderRadius: 8,
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 24 }}>
      <span style={{ display: 'flex', color: C.text2 }}>
        <Icon name="message" size={14} />
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {url && (
          <span style={iconBtn(24, { hovered: hover === 'globe' })} title="在内置浏览器中打开">
            <Icon name="globe" size={13} />
          </span>
        )}
        <span style={iconBtn(24, {})} title="复制到剪贴板">
          <Icon name="copy" size={13} />
        </span>
      </span>
    </div>
    <div style={{ marginTop: 6, fontSize: 12, lineHeight: '20px', color: C.text0, wordBreak: 'break-all', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
      {text}
    </div>
  </div>
);

const AiBubble: React.FC<{ item: ChatItem; frame: number; hover: T5 }> = ({ item, frame, hover }) =>
  item.kind !== 'ai' ? null : (
    <div style={{ position: 'absolute', left: CHAT.l - 1580, top: item.y - 80, width: ITEM_W }}>
      <div
        style={{
          maxWidth: ITEM_W,
          padding: '8px 11px',
          borderRadius: 10,
          borderBottomLeftRadius: 3,
          background: C.bg2,
          fontSize: 12.5,
          lineHeight: '20px',
        }}
      >
        {item.tool && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: C.text2, marginBottom: 3, fontFamily: FONT_MONO, whiteSpace: 'nowrap', overflow: 'hidden' }}>
            <Icon name="globe" size={11} />
            {item.tool}
          </div>
        )}
        {item.typing ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20 }}>
            {[0, 1, 2].map((i) => {
              const up = (frame * 2 + i * 8) % 48 < 24;
              return (
                <span
                  key={i}
                  style={{ width: 5, height: 5, borderRadius: '50%', background: C.text2, opacity: up ? 1 : 0.25, transform: up ? 'translateY(-2px)' : 'none' }}
                />
              );
            })}
          </span>
        ) : (
          item.lines.map((l, i) => (
            <span key={i}>
              {l}
              {i < item.lines.length - 1 && <br />}
            </span>
          ))
        )}
        {item.suggest && !item.typing && <SuggestCard text={item.suggest.text} url={item.suggest.url} hover={hover} />}
      </div>
    </div>
  );

/* ---------- AI 面板 ---------- */

const AiPanel: React.FC<{ st: Wb5State; frame: number }> = ({ st, frame }) => (
  <div style={{ width: 340, flex: 'none', background: C.bg1, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
    <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: 1, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '0 8px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12 }}>
        新会话
        <Icon name="chevronDown" size={12} color={C.text2} />
      </div>
      <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
        <Icon name="plus" size={14} />
      </div>
    </div>
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
      {st.items.map((item) =>
        item.kind === 'user' ? (
          <UserBubble key={item.id} item={item} />
        ) : item.kind === 'ai' ? (
          <AiBubble key={item.id} item={item} frame={frame} hover={st.hover} />
        ) : (
          <ActionCard key={item.id} item={item} hover={st.hover} press={st.press} frame={frame} />
        ),
      )}
    </div>
    <div style={{ flex: 'none', height: 148, boxSizing: 'border-box', borderTop: `1px solid ${C.border}`, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 0', fontSize: 11, color: C.text2, flex: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="bot" size={12} /> AI 模式
        </span>
        <div
          style={{
            width: MODE_SEL.w,
            height: MODE_SEL.h,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 6px',
            background: C.bg2,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            color: C.text0,
            fontSize: 12,
            boxSizing: 'border-box',
            flex: 'none',
          }}
        >
          工作
          <Icon name="chevronDown" size={10} color={C.text2} />
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="zap" size={12} /> 思考强度
        </span>
        <div
          style={{
            width: EFFORT_SEL.w,
            height: EFFORT_SEL.h,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 6px',
            background: C.bg2,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            color: C.text0,
            fontSize: 12,
            boxSizing: 'border-box',
            flex: 'none',
          }}
        >
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
          position: 'relative',
          flex: 1,
          minHeight: 0,
          padding: '8px 10px',
          background: C.bg2,
          border: `1px solid ${st.inputFocus ? C.accent : C.border}`,
          borderRadius: 6,
          fontSize: 12.5,
          lineHeight: '20px',
        }}
      >
        {st.inputText || st.inputChip ? (
          <span style={{ color: C.text0, wordBreak: 'break-all' }}>
            {st.inputChip && <Chip label="@browser:#hero-title" />}
            {st.inputText}
            {st.inputCaret && <span style={{ display: 'inline-block', width: 1.5, height: 14, background: C.accent, verticalAlign: '-2px', marginLeft: 1 }} />}
          </span>
        ) : (
          <span style={{ color: C.text2 }}>向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器</span>
        )}
        <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10.5, color: C.text2 }}>Enter 发送</span>
      </div>
    </div>
  </div>
);

/* ---------- 状态栏 ---------- */

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

/* ---------- 主组件 ---------- */

export const Wb5: React.FC<{ state: Wb5State; frame: number }> = ({ state, frame }) => (
  <div
    style={{
      position: 'absolute',
      width: WIN_W,
      height: WIN_H,
      background: C.bg0,
      color: C.text0,
      fontFamily: FONT_UI,
      fontSize: 13,
      borderRadius: 14,
      border: `1px solid ${C.borderStrong}`,
      overflow: 'hidden',
      boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
    }}
  >
    <TopBar active="项目" project={DEMO.projectName} />

    <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 26, display: 'flex' }}>
      <ActivityBar hover={state.hover} press={state.press} />

      {/* 侧栏:服务器列表 */}
      <div style={{ position: 'relative', width: 260, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px 0 14px', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: C.text1 }}>
          服务器列表
        </div>
        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          <ServersPanel />
        </div>
      </div>

      {/* 中央:标签栏 + 终端/浏览器(keep-alive:双页面常驻,仅切显隐) */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg0 }}>
        <div style={{ height: 36, flex: 'none', display: 'flex', alignItems: 'stretch', background: C.bg1, borderBottom: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <WbTab icon="terminal" title="本地终端" active={state.centerTab === 'terminal'} />
          {state.browserTabT > 0 && (
            <div style={{ width: TAB_W * state.browserTabT, opacity: state.browserTabT, overflow: 'hidden', display: 'flex' }}>
              <WbTab icon="globe" title="浏览器" active={state.centerTab === 'browser'} w={TAB_W} />
            </div>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0, display: state.centerTab === 'terminal' ? 'flex' : 'none' }}>
            <TermPane frame={frame} />
          </div>
          <div style={{ position: 'absolute', inset: 0, display: state.centerTab === 'browser' ? 'flex' : 'none' }}>
            <BrowserPane st={state} frame={frame} />
          </div>
        </div>
      </div>

      <AiPanel st={state} frame={frame} />
    </div>

    <Statusbar />
  </div>
);
