/**
 * 视频七(SSH 隧道)场景几何常量。
 * 工作台骨架与 browser5/staging6 同源;隧道标签页按 tabs/TunnelTab.tsx + tunnel.css 实测
 * (padding 14 18,头 title+hint+右上「+ 新建隧道」,卡片列 gap 10,卡片 padding 10 12,
 * 状态徽标 8px 圆点,操作按钮 停止/编辑/删除 h24);新建模态 520 宽(tunnel-modal),
 * 类型 local 时 field-row 为 本地端口|目标主机|目标端口 三列,dynamic 时第二列是 SOCKS5 说明;
 * 端口冲突确认框 = ui.ts confirmDialog 400 宽。设置页按 Settings.tsx(左导航 176px,
 * 面板 max-width 860,padding 24 28)与 BrowserPanel.tsx「内置浏览器」面板复刻。
 * 顶栏「设置/项目」切换按钮锚点按 scene.ts ACCOUNT_BTN(1710+27)与 TopBar flex 布局推算。
 * 坐标系:窗口设计稿 1920×1200。
 */

/* ================= 工作台骨架(与视频五/六一致) ================= */
export const SIDEBAR = { x: 48, w: 260, headH: 34 };
export const CENTER = { x: 308, w: 1272, tabBarH: 36 };

/* ================= 中央标签栏(y40..76,单标签宽 152) ================= */
export const TAB_W = 152;
export const TAB_TERM_X = 308;
export const TAB_BROWSER_X = 460;
export const TAB_TUNNEL_X = 612;

/* ================= 顶栏导航按钮(TopBar flex 实测推算) ================= */
export const TOP_NAV = {
  project: { x: 1615, y: 20 },
  settings: { x: 1675, y: 20 },
  account: { x: 1735, y: 20 },
} as const;

/* ================= 服务器卡片与「更多」下拉(ServersPanel 复刻) ================= */
/** 服务器卡片 y178..282(侧栏内容 y74 + 本地卡 ~96 + gap 8);按钮行 y214..240,4×26+gap6 右对齐;
 *  「更多」按钮实测中心 (277,224) */
export const SRV = {
  more: { x: 277, y: 224 },
} as const;
/** 「更多」下拉:锚于按钮下方右对齐(x104..292),itemH 30 4 项: MCP/数据库连接/SSH跳转设置/SSH 隧道 */
export const SRV_MENU = { x: 104, y: 256, w: 188, itemH: 30, pad: 4 } as const;
export const srvMenuItemCy = (i: number): number => SRV_MENU.y + SRV_MENU.pad + i * SRV_MENU.itemH + SRV_MENU.itemH / 2;
/** 「SSH 隧道」菜单项 = 第 4 项 */
export const SRV_ITEM_TUNNEL = 3;

/* ================= 隧道标签页(中央内容区 y76..1174;TunnelTab padding 14 18) ================= */
export const TUN = {
  /** 头部:y90..132(title 15px cy98;hint 11px y114..130);右侧「+ 新建隧道」按钮(h24) */
  titleCx: 372,
  newBtn: { x: 1462, y: 88, w: 100, h: 24 },
  /** 卡片列表 y146 起,卡片高 58,gap 10(窗口坐标;Wb7 列表容器顶部即 y146,行内按行号偏移) */
  rowY: 146,
  rowH: 58,
  gap: 10,
  /** 卡片:左体 x338(列表容器 x326 + 卡片 padding 12),右缘 1562;按钮组右内缘 1550,
   *  3×54+2×6=174 左起 1376(停止/编辑/删除,h24 垂直居中) */
  nameCyOfs: 20,
  routeCyOfs: 40,
  btnStop: { w: 54, x: 1376 },
  btnEdit: { w: 54, x: 1436 },
  btnDel: { w: 54, x: 1496 },
  /** 状态徽标圆点(名称右侧 x470 附近,Wb7 内动态) */
} as const;
export const tunRowY = (row: number): number => TUN.rowY + row * (TUN.rowH + TUN.gap);
export const tunRowCy = (row: number): number => tunRowY(row) + TUN.rowH / 2;
export const tunBtnAnchor = (row: number, btn: { x: number; w: number }): { x: number; y: number } => ({
  x: btn.x + btn.w / 2,
  y: tunRowCy(row),
});
/** 新建隧道按钮中心 */
export const TUN_NEW_C = { x: TUN.newBtn.x + TUN.newBtn.w / 2, y: TUN.newBtn.y + TUN.newBtn.h / 2 };

/* ================= 新建隧道模态(520 宽,tunnel-modal) ================= */
export const TDIA = { x: 700, y: 340, w: 520, h: 520 } as const;
export const TDIA_F = {
  headCy: 364,
  nameLabelCy: 412,
  nameInput: { x: 718, y: 426, w: 484, h: 34 },
  kindLabelCy: 482,
  kindSel: { x: 718, y: 496, w: 484, h: 34 },
  bindLabelCy: 552,
  bindInput: { x: 718, y: 566, w: 484, h: 34 },
  bindHintY: 608,
  /** field-row:标签 cy 648,输入 y662 h34 */
  rowLabelCy: 648,
  portInput: { x: 718, y: 662, w: 150, h: 34 },
  hostInput: { x: 884, y: 662, w: 150, h: 34 },
  targetInput: { x: 1050, y: 662, w: 152, h: 34 },
  dynHintY: 660,
  footCy: 828,
  btnCancel: { x: 1046, y: 812, w: 60, h: 32 },
  btnOk: { x: 1122, y: 812, w: 80, h: 32 },
} as const;
/** 类型下拉菜单(select 下方,itemH 30):0=本地端口转发 1=SOCKS5 动态代理 */
export const TDIA_MENU = { x: TDIA_F.kindSel.x, y: TDIA_F.kindSel.y + TDIA_F.kindSel.h + 4, w: TDIA_F.kindSel.w, itemH: 30, pad: 4 } as const;
export const tdiaMenuItemCy = (i: number): number => TDIA_MENU.y + TDIA_MENU.pad + i * TDIA_MENU.itemH + TDIA_MENU.itemH / 2;

/* ================= 端口冲突确认框(confirmDialog 400 宽) ================= */
export const CFM7 = { x: 760, w: 400, h: 200 } as const;
/** 框体 y500..700;foot 高 56 → 按钮 cy 672;右 padding 18 → 「关闭并启动」(宽约 96)中心 1094,「取消」中心 1008 */
export const CFM7_BTN = {
  ok: { x: 1094, y: 672 },
  cancel: { x: 1008, y: 672 },
} as const;

/* ================= 底栏角标(statusbar-tunnels,绿色 tunnel 图标+数量) ================= */
/** 状态栏右端:AI 助手按钮(右 padding 8,宽约 77)左缘 ~1835;角标 marginRight 12 → 右缘 1823,内容约 20 宽 */
export const BADGE = { x: 1813, y: 1187 } as const;
/** toast(与 staging6 一致:right 24 bottom 34) */
export const TOAST = { x: 1896, y: 1146 } as const;

/* ================= 设置页(Settings.tsx:左导航 176px + 内容 padding 24 28) ================= */
export const SET = {
  navX: 0,
  navW: 176,
  navTop: 40,
  navPadTop: 20,
  navItemH: 32,
  /** 内容区面板(x176+28=204,y40+24=64,宽 860) */
  panelX: 204,
  panelY: 64,
  panelW: 860,
} as const;
/** 左导航项中心(项序:0 功能特性 1 凭据库 2 外观 3 快捷键 4 API 接口 5 关于与更新 6 浏览器) */
export const setNavCy = (i: number): number => SET.navTop + SET.navPadTop + i * SET.navItemH + SET.navItemH / 2;
export const NAV_FEATURES = 0;
export const NAV_BROWSER = 6;

/** 面板行几何(features / browser 两面板共用纵向节奏) */
export const PANEL7 = {
  titleCy: 82,
  hintY: 102,
  /** features:通用 fieldset(两项)+ SSH 隧道 fieldset(自动启动) */
  genTop: 140,
  genRow1: 176,
  genRow2: 216,
  tunTop: 260,
  tunRow: 300,
  tunHintY: 330,
  /** browser 面板 */
  brEnableLabelY: 168,
  brEnableBox: { x: 208, y: 192, w: 16, h: 16 },
  brSrcLabelY: 236,
  brRadio1: { x: 208, y: 262 },
  brRadio2: { x: 470, y: 262 },
  brSelLabelY: 306,
  brSel: { x: 204, y: 330, w: 340, h: 32 },
  brSelHintY: 372,
  brStatusY: 420,
  brSave: { x: 204, y: 452, w: 64, h: 32 },
} as const;
/** 代理下拉菜单(select 下方,单条候选) */
export const BR_MENU = { x: PANEL7.brSel.x, y: PANEL7.brSel.y + PANEL7.brSel.h + 4, w: PANEL7.brSel.w, itemH: 30, pad: 4 } as const;
export const brMenuItemCy = (i: number): number => BR_MENU.y + BR_MENU.pad + i * BR_MENU.itemH + BR_MENU.itemH / 2;
export const brRadioCy = (r: { x: number; y: number }): { x: number; y: number } => ({ x: r.x + 8, y: r.y + 8 });

/* ================= 浏览器标签页(与 browser5 BR 同布局;地址栏可输入) ================= */
export const BR7 = {
  back: { x: 318, y: 82, w: 28, h: 28 },
  address: { x: 420, y: 82, w: 1048, h: 28 },
} as const;
export const BR7_ADDR_C = { x: BR7.address.x + 20, y: BR7.address.y + BR7.address.h / 2 };

/* ================= 内网站点(实验室集群管理台;页面局部坐标 0..1238×0..1057) ================= */
export const INTRA = {
  headerH: 64,
  sideW: 200,
  title: { x: 60, y: 100, w: 420, h: 42 },
  badge: { x: 500, y: 108, w: 190, h: 26 },
} as const;
/** 页面局部 → 窗口坐标(VIEW 同 browser5:x308 y117 w1238 h1057) */
export const VIEW7 = { x: 308, y: 117, w: 1238, h: 1057 } as const;

/* ================= AI 面板(x1580 w340,与视频五/六一致) ================= */
export const CHAT = { l: 1590, w: 310, top: 80, bottom: 1016 } as const;
export const ITEM_W = 296;
export const AI_INPUT = { x: 1750, y: 1130 } as const;

/* ================= 聊天条目(高度计算,与视频五/六同构) ================= */
export type ActionStatus = 'approving' | 'smart' | 'running' | 'succeeded';

export interface ActionSpec {
  name: string;
  icon: 'wrench' | 'database' | 'filePlus' | 'tunnel';
  intent?: string;
  cmd?: string;
  meta?: string;
  smart?: string;
  result?: string;
}

export type ChatSpec =
  | { kind: 'user'; id: string; lines: string[]; chip?: string }
  | { kind: 'ai'; id: string; lines: string[]; typing?: boolean }
  | { kind: 'action'; id: string; status: ActionStatus; spec: ActionSpec };

export function chatItemH(item: ChatSpec): number {
  if (item.kind === 'user') return 16 + item.lines.length * 20;
  if (item.kind === 'ai') {
    const n = item.typing ? Math.max(1, item.lines.length) : item.lines.length;
    return 16 + n * 20;
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

/* ================= 演示数据 ================= */
export const DEMO = {
  projectName: 'nebula-site',
  serverName: 'deephaven-dev-01',
  serverHost: '10.21.36.8',
  siteUrl: 'http://10.21.36.8',
  intraUrl: 'http://192.168.30.20:8080',
  tun1Name: '内网代理',
  tun1Port: '1080',
  tun2Name: '数据库通道',
  tun2Port: '1080',
  tun2TargetPort: '3306',
} as const;

/** 终端回滚(本地终端,常驻标签,背景) */
export type TermLine = { prompt?: boolean; cmd?: string; text?: string };
export const TERM_BASE: TermLine[] = [
  { cmd: 'ssh deploy@10.21.36.8 "pm2 status"' },
  { text: '┌─ nebula-web   online   12d' },
  { text: '└─ aurora-api   online   12d' },
  { text: '' },
  { cmd: 'git log --oneline -2' },
  { text: 'c81f2aa chore: 发布 v3.0' },
  { text: '' },
];
