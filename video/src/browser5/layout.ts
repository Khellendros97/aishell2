/**
 * 视频五(内置浏览器)场景几何常量。
 * 工作台骨架与 aimode4/layout.ts 同源(workbench.css 实测布局);浏览器标签页按
 * tabs/browser-engine.ts + browser.css 实测:工具栏(后退/前进/刷新/地址栏/本地 HTML/
 * 检查元素/开发者工具)高 41,右侧「标签页」侧边栏折叠为 34px 窄轨。
 * 检查元素覆盖层按 browser.rs INSPECTOR_JS:#2563eb 2px 描边 + 左上角标签;
 * AI 面板文本建议卡(.ai-suggest.text)含「在内置浏览器中打开」地球按钮。
 * 坐标系:窗口设计稿 1920×1200;站点内容用页面区局部坐标(0..1238 × 0..1057),
 * 检查锚点经 VIEW 偏移换算为窗口坐标,指针落点由此推导。
 */

/* ================= 工作台骨架(与视频四一致) ================= */
export const ACT = {
  explorer: { x: 24, y: 66 },
  servers: { x: 24, y: 108 },
  commands: { x: 24, y: 150 },
  skills: { x: 24, y: 192 },
  notes: { x: 24, y: 234 },
  browser: { x: 24, y: 276 },
} as const;
/** 活动栏项点击区(40×40,圆角右凸) */
export const ACT_BOX = { w: 40, h: 40 };

export const SIDEBAR = { x: 48, w: 260, headH: 34 };
export const CENTER = { x: 308, w: 1272, tabBarH: 36 };

/* ================= 中央标签栏(y40..76,单标签宽 152) ================= */
export const TAB_W = 152;
export const TAB_TERM_X = 308;
export const TAB_BROWSER_X = 460;

/* ================= 浏览器标签页(中央内容区 y76..1174) ================= */
/** 工具栏:padding 6 + 按钮 28 + padding 6 + 底边框 1 = 41 → y76..117 */
export const BR = {
  back: { x: 318, y: 82, w: 28, h: 28 },
  forward: { x: 352, y: 82, w: 28, h: 28 },
  reload: { x: 386, y: 82, w: 28, h: 28 },
  /** 地址栏输入框(x420..1468) */
  address: { x: 420, y: 82, w: 1048, h: 28 },
  local: { x: 1474, y: 82, w: 28, h: 28 },
  inspect: { x: 1508, y: 82, w: 28, h: 28 },
  devtools: { x: 1542, y: 82, w: 28, h: 28 },
} as const;
export const brCx = (b: { x: number; w: number }): number => b.x + b.w / 2;
export const BR_CY = 96;

/** 页面区(webview 覆盖区):工具栏之下、右侧页轨之外 */
export const VIEW = { x: 308, y: 117, w: 1238, h: 1057 } as const;
/** 折叠「标签页」窄轨:x1546..1580;toggle/新建/页面圆点竖排(24×24,gap 4,padding 6) */
export const RAIL = { x: 1546, w: 34 } as const;
export const RAIL_TOGGLE_CY = 117 + 6 + 12;
export const RAIL_NEW_CY = RAIL_TOGGLE_CY + 24 + 4;
export const RAIL_DOT_CY = RAIL_NEW_CY + 24 + 4;

/* ================= 站点一(Nebula Data,部署在远程主机)页面局部坐标 ================= */
/** 站点内容局部坐标(0..1238 × 0..1057);hero 标题/CTA 供检查覆盖层与指针锚点使用 */
export const SITE1 = {
  /** h1#hero-title 改样式前(48px) */
  heroTitle: { x: 427, y: 210, w: 384, h: 60 },
  /** 改样式后(64px 品牌蓝) */
  heroTitleStyled: { x: 363, y: 196, w: 512, h: 80 },
  /** button#cta-btn 立即体验 */
  cta: { x: 551, y: 356, w: 136, h: 46 },
} as const;
/** 页面局部 → 窗口坐标 */
export const toWin = (r: { x: number; y: number; w: number; h: number }) => ({
  x: r.x + VIEW.x,
  y: r.y + VIEW.y,
  w: r.w,
  h: r.h,
});

/* ================= AI 面板(x1580 w340,与视频四一致) ================= */
export const CHAT = { l: 1590, w: 310, top: 80, bottom: 1016 } as const;
export const ITEM_W = 296;
export const MODE_SEL = { x: 1666, y: 1040, w: 74, h: 22 } as const;
export const EFFORT_SEL = { x: 1820, y: 1040, w: 78, h: 22 } as const;
export const AI_INPUT = { x: 1750, y: 1130 } as const;

/* ================= 聊天条目(高度计算,Wb5 与 script 共用) ================= */
export type ActionStatus = 'approving' | 'smart' | 'running' | 'succeeded';

export interface ActionSpec {
  name: string;
  icon: 'wrench' | 'database' | 'filePlus';
  intent?: string;
  cmd?: string;
  meta?: string;
  smart?: string;
  result?: string;
  btn?: 'approve' | 'audit';
}

/** 文本建议卡(.ai-suggest.text):头 24 + 正文 20 + padding 16 + 边框 2 + margin 6 = 74 */
export const SUGGEST_H = 74;

export type ChatSpec =
  | { kind: 'user'; id: string; lines: string[]; chip?: string }
  | {
      kind: 'ai';
      id: string;
      lines: string[];
      tool?: string;
      typing?: boolean;
      card?: { cmd: string };
      suggest?: { text: string; url: boolean };
    }
  | { kind: 'action'; id: string; status: ActionStatus; spec: ActionSpec };

export function chatItemH(item: ChatSpec): number {
  if (item.kind === 'user') return 16 + item.lines.length * 20;
  if (item.kind === 'ai') {
    const n = item.typing ? Math.max(1, item.lines.length) : item.lines.length;
    let h = 16 + n * 20;
    if (item.tool) h += 22;
    if (item.card) h += 66;
    if (item.suggest) h += SUGGEST_H;
    return h;
  }
  return actionH(item.status, item.spec);
}

export function actionH(status: ActionStatus, s: ActionSpec): number {
  let blocks = 20;
  let n = 1;
  if (s.intent) { blocks += 18; n++; }
  if (s.cmd) { blocks += 24; n++; }
  if (s.meta) { blocks += 18; n++; }
  if (s.smart) { blocks += 18; n++; }
  if (status === 'approving' && s.btn) { blocks += 26; n++; }
  if (status === 'succeeded' && s.result) { blocks += 28; n++; }
  return 12 + 16 + blocks + (n - 1) * 5;
}

export type ChatItem = ChatSpec & { y: number; h: number };

/** 底对齐堆叠:末条 bottom = CHAT.bottom,自下而上排布 */
export function stackChat(specs: ChatSpec[]): ChatItem[] {
  const out: ChatItem[] = [];
  let bottom = CHAT.bottom;
  for (let i = specs.length - 1; i >= 0; i--) {
    const h = chatItemH(specs[i]);
    out.unshift({ ...specs[i], y: bottom - h, h });
    bottom -= h + 8;
  }
  return out;
}

/** 文本建议卡地球按钮锚(卡内右上角按钮组:copy 最右、globe 在其左,gap 6;
 *  卡右 pad 10 → copy 中心 x = 卡右-22,globe 中心 x = copy-30) */
export function suggestGlobeAnchor(item: ChatItem): { x: number; y: number } {
  if (item.kind !== 'ai' || !item.suggest) return { x: CHAT.l, y: item.y };
  const cardTop = item.y + 16 + item.lines.length * 20;
  return { x: CHAT.l + ITEM_W - 10 - 12 - 24 - 6, y: cardTop + 6 + 8 + 12 };
}

/* ================= 演示数据 ================= */
export const DEMO = {
  projectName: 'nebula-site',
  serverName: 'deephaven-dev-01',
  serverHost: '10.21.36.8',
  siteUrl: 'http://10.21.36.8',
  deployDir: '/var/www/nebula',
  fileRef: 'deephaven-dev-01:/var/www/nebula/index.html',
  localFile: 'file:///D:/projects/nebula/design/landing.html',
} as const;

/** 用户输入文案 */
export const Q1 = '把这个标题改成品牌蓝，按钮改成胶囊圆角';
export const Q2 = '再设计一个 AI 产品的落地页，深色科技风，保存到项目里';

/** 终端回滚(本地终端,常驻标签;D 线不激活仅作背景) */
export type TermLine = { prompt?: boolean; cmd?: string; text?: string };
export const TERM_BASE: TermLine[] = [
  { cmd: 'npm run dev' },
  { text: 'VITE v5.4.19  ready in 312 ms' },
  { text: '' },
  { cmd: 'ssh deploy@10.21.36.8 "pm2 status"' },
  { text: '┌─ nebula-web   online   12d' },
  { text: '└─ aurora-api   online   12d' },
  { text: '' },
  { cmd: 'git log --oneline -2' },
  { text: 'c81f2aa chore: 发布 v3.0' },
  { text: '7be01d4 feat: 实时引擎上线' },
  { text: '' },
];
