/**
 * 视频六(文件暂存区)场景几何常量。
 * 工作台骨架与 browser5/layout.ts 同源;暂存区面板按 tabs/StagingTab.tsx + staging.css
 * 实测布局(头 35 + 提示 2 行 + 工具栏 38 + 表格行高 30);diff 标签按 tabs/DiffTab.tsx +
 * diff.css(左右双栏「首次快照/当前内容」,删行红 / 增行绿 / 折叠行);AI 面板新增
 * 「已暂存 N 个文件修改,点击查看」提示条(ai-engine.ts #ai-staging-notice:min-height 30,
 * margin 0 10 8,位于消息区与输入区之间)与会话下拉菜单。
 * 对话框:接受/还原确认框(ui.ts confirmDialog,400 宽)与导出备份对话框(470 宽,
 * staging-export-* 样式)。坐标系:窗口设计稿 1920×1200。
 */

/* ================= 工作台骨架(与视频四/五一致) ================= */
export const SIDEBAR = { x: 48, w: 260, headH: 34 };
export const CENTER = { x: 308, w: 1272, tabBarH: 36 };

/* ================= 中央标签栏(y40..76,单标签宽 152) ================= */
export const TAB_W = 152;
export const TAB_TERM_X = 308;
export const TAB_BROWSER_X = 460;
export const TAB_STAGING_X = 612;

/* ================= 文件暂存区面板(中央内容区 y76..1174) ================= */
export const STG = {
  /** 头部 y76..111:history 图标 + 「文件暂存区」+ 计数徽标;右侧「刷新」按钮(h24) */
  headCy: 93,
  countBadge: { x: 434, y: 84, w: 18, h: 18 },
  refresh: { x: 1500, y: 81, w: 68, h: 24 },
  /** 提示文案 y111..163(staging-hint,11px 两行) */
  hintTop: 117,
  /** 工具栏 y163..201:左「选择文件后可批量操作」,右 4 按钮 */
  toolbarCy: 182,
  btnClear: { x: 1184, y: 170, w: 108, h: 24 },
  btnBulkAccept: { x: 1298, y: 170, w: 78, h: 24 },
  btnBulkRestore: { x: 1382, y: 170, w: 96, h: 24 },
  btnBulkExport: { x: 1484, y: 170, w: 84, h: 24 },
  /** 表格:表头 y211..240,行高 30;列锚(表体内容 x320..1568) */
  thCy: 226,
  rowY: 240,
  rowH: 30,
  col: { check: 334, server: 356, path: 470, time: 740, orig: 890, cur: 1010 },
  /** 行内操作按钮(行内右对齐,行右缘 = 窗口 x1568;gap 4) */
  btnDiff: { w: 92, x: 1290 },
  btnAccept: { w: 54, x: 1386 },
  btnRestore: { w: 54, x: 1444 },
  btnExport: { w: 66, x: 1502 },
} as const;
/** 行内按钮中心(行号 0 起) */
export const stgBtnCx = (b: { x: number; w: number }): number => b.x + b.w / 2;
export const stgRowCy = (row: number): number => STG.rowY + row * STG.rowH + STG.rowH / 2;
export const stgBtnAnchor = (row: number, btn: { x: number; w: number }): { x: number; y: number } => ({
  x: stgBtnCx(btn),
  y: stgRowCy(row),
});

/* ================= 暂存 diff 标签 ================= */
export const DIFF = {
  /** 头部 y76..111:diff 图标 + 「暂存 diff」;右侧 展开全部 / 刷新 */
  refresh: { x: 1500, y: 81, w: 68, h: 24 },
  expandAll: { x: 1412, y: 81, w: 82, h: 24 },
  /** meta 行 y111..141 */
  metaCy: 126,
  /** 双栏 y151..1164(gap 10):左 x320..938,右 x948..1566 */
  sideHeadCy: 164,
  /** 代码行:i 行顶部 = 184 + i*20,行高 20;行号 gutter 距侧栏左缘 14 */
  lineTop: 184,
  lineH: 20,
} as const;
export const diffSideX = (side: 0 | 1): number => (side === 0 ? 320 : 948);
export const diffSideW = 618;
export const diffLineCy = (i: number): number => DIFF.lineTop + i * DIFF.lineH + DIFF.lineH / 2;

/* ================= AI 面板(x1580 w340) ================= */
export const CHAT = { l: 1590, w: 310, top: 80, bottom: 980 } as const;
export const ITEM_W = 296;
export const MODE_SEL = { x: 1666, y: 1040, w: 74, h: 22 } as const;
export const EFFORT_SEL = { x: 1820, y: 1040, w: 78, h: 22 } as const;
export const AI_INPUT = { x: 1750, y: 1130 } as const;
/** 会话栏 y40..80:select x1588..1878 h26,+ 新建按钮 x1878..1904 */
export const SES_SELECT = { x: 1588, y: 47, w: 290, h: 26 } as const;
export const SES_NEW = { x: 1878, y: 47, w: 26, h: 26 } as const;
/** 会话下拉菜单(展开于 select 下方,itemH 28,pad 4) */
export const SES_MENU = { x: 1588, y: 82, w: 290, itemH: 28, pad: 4 } as const;
export const sesMenuItemCy = (i: number): number => SES_MENU.y + SES_MENU.pad + i * SES_MENU.itemH + SES_MENU.itemH / 2;
/** 「已暂存」提示条(y988..1018,margin 0 10 8;消息区随之收窄至 bottom 980) */
export const NOTICE = { x: 1598, y: 988, w: 304, h: 30 } as const;

/* ================= 聊天条目(高度计算,与视频五同构;chat bottom 固定 980) ================= */
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

export type ChatSpec =
  | { kind: 'user'; id: string; lines: string[]; chip?: string }
  | { kind: 'ai'; id: string; lines: string[]; tool?: string; typing?: boolean }
  | { kind: 'action'; id: string; status: ActionStatus; spec: ActionSpec };

export function chatItemH(item: ChatSpec): number {
  if (item.kind === 'user') return 16 + item.lines.length * 20;
  if (item.kind === 'ai') {
    const n = item.typing ? Math.max(1, item.lines.length) : item.lines.length;
    return 16 + n * 20 + (item.tool ? 22 : 0);
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

/* ================= 对话框(窗口居中) ================= */
/** 确认框(confirmDialog,400 宽):接受暂存 / 确认还原,正文 3 行 → 高 200 */
export const CFM_DLG = { x: 760, w: 400, h: 200 } as const;
export const CFM_BTN = {
  ok: { x: 1115, y: 672 },
  cancel: { x: 1053, y: 672 },
} as const;

/** 导出备份对话框(470 宽,staging-export-*):高 326 → y437..763 */
export const EXP_DLG = { x: 725, y: 437, w: 470, h: 326 } as const;
export const EXP_OPT = { x: 743, y: 493, w: 434, h: 58 } as const; // 单选选项(两行,间距 6)
export const EXP_ACCEPT = { x: 743, y: 682 } as const; // 「同时接受变更」复选框行左缘
export const EXP_BTN = {
  ok: { x: 1141, y: 735 },
  cancel: { x: 1070, y: 735 },
} as const;

/* ================= 演示数据 ================= */
export const DEMO = {
  projectName: 'nebula-site',
  serverName: 'deephaven-dev-01',
  serverHost: '10.21.36.8',
  siteUrl: 'http://10.21.36.8',
  sessionName: 'Nebula 官网改版',
  sessionOther: '官网首页设计',
  file1Name: 'index.html',
  file1Path: '/var/www/nebula/index.html',
  file1Time: '2026-08-31 10:32',
  file1Size: '存在 · 3.2 KB',
  file2Name: 'theme.css',
  file2Path: '/var/www/nebula/css/theme.css',
  file2Time: '2026-08-31 10:41',
  file2Size: '存在 · 1.8 KB',
  exportTarget: 'D:\\projects\\nebula\\.aishell\\backup\\index.html_bak20260831-1032',
  entry1Id: 'e-index',
  entry2Id: 'e-theme',
} as const;

export const U2 = '再把按钮悬停色调亮一点';

/** diff 行(对齐网格):同一网格行左右单元格各自带 ctx/del/add/gap/fold;
 *  del(左红)/add(右绿)成对顶端对齐,较短一侧为 gap(斜纹占位,无行号) */
export interface DiffRow {
  leftKind: 'ctx' | 'del' | 'add' | 'gap' | 'fold';
  rightKind: 'ctx' | 'del' | 'add' | 'gap' | 'fold';
  left: string;
  right: string;
  leftNo: number | null;
  rightNo: number | null;
  foldText?: string;
}

export const DIFF_ROWS: DiffRow[] = [
  { leftKind: 'fold', rightKind: 'fold', left: '', right: '', leftNo: null, rightNo: null, foldText: '展开 6 行未变化内容' },
  {
    leftKind: 'ctx', rightKind: 'ctx', leftNo: 10, rightNo: 10,
    left: '  <p class="badge">全新 v3.0 · 实时引擎上线</p>',
    right: '  <p class="badge">全新 v3.0 · 实时引擎上线</p>',
  },
  {
    leftKind: 'del', rightKind: 'add', leftNo: 11, rightNo: 11,
    left: '  <h1 id="hero-title">让数据流动起来</h1>',
    right: '  <h1 id="hero-title" style="color:#4f8ef7;font-size:64px">',
  },
  {
    leftKind: 'ctx', rightKind: 'ctx', leftNo: 12, rightNo: 12,
    left: '  <p class="sub">面向物联网与实时分析的一站式数据平台</p>',
    right: '  <p class="sub">面向物联网与实时分析的一站式数据平台</p>',
  },
  {
    leftKind: 'del', rightKind: 'add', leftNo: 13, rightNo: 13,
    left: '  <button class="cta">立即体验</button>',
    right: '  <button class="cta" style="border-radius:22px">立即体验',
  },
  {
    leftKind: 'ctx', rightKind: 'ctx', leftNo: 14, rightNo: 14,
    left: '</section>',
    right: '</section>',
  },
  { leftKind: 'fold', rightKind: 'fold', left: '', right: '', leftNo: null, rightNo: null, foldText: '展开 9 行未变化内容' },
];

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
