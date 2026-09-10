/**
 * 视频九(时间线云同步)场景几何常量与演示数据。
 * 工作台骨架与 ssh7/cloud8 同源(活动栏/资源管理器/中央标签区/AI 面板/底栏);
 * 新增:时间线标签页(工具栏/标签 chips/类别 chips/事件行/状态行,对照主仓 TimelineTab.tsx +
 * timeline.css)、打标签右键菜单与弹窗(TagDialog)、设置页「时间线云同步」区(Settings.tsx)、
 * 删除云端时间线确认框;网页端场景(浏览器框 + 云平台工作台「时间线」页,自绘非内置浏览器)。
 * 坐标系:窗口设计稿 1920×1200;时间线行/网页行均为绝对定位写死(不用流式推导)。
 */

/* ================= 工作台骨架(与视频五/六/七/八一致) ================= */
export const CENTER = { x: 308, w: 1272, tabBarH: 36 } as const;
export const TAB_W = 152;
export const TAB_TERM_X = 308;
export const TAB_TL_X = 460;
/** 时间线标签中心(点击目标) */
export const TAB_TL_C = { x: TAB_TL_X + TAB_W / 2, y: 40 + 18 };

/** 活动栏「时间线」入口(对照主仓 Workbench.tsx:位于 notes 与 browser 之间);
 *  ACT_ITEMS 中索引 5,窗口 y = 顶栏 40 + paddingTop 6 + 图标中心 20 + 42×5 = 276 */
export const ACT_TL = { x: 24, y: 276, i: 5 } as const;

/* 顶栏导航按钮(与 cloud8 一致) */
export const TOP_NAV = {
  project: { x: 1615, y: 20 },
  settings: { x: 1675, y: 20 },
  account: { x: 1735, y: 20 },
} as const;

/* 资源管理器文件树(侧栏,项目「订单服务」) */
export const EXPL = { top: 74, rowH: 26, indent: 14 } as const;
export const explRowY = (i: number): number => EXPL.top + i * EXPL.rowH;
export const TREE: { name: string; icon: 'folderOpen' | 'folder' | 'file'; depth: number }[] = [
  { name: 'order-service', icon: 'folderOpen', depth: 0 },
  { name: '.aishell', icon: 'folder', depth: 1 },
  { name: 'src', icon: 'folder', depth: 1 },
  { name: 'deploy', icon: 'folder', depth: 1 },
  { name: 'Cargo.toml', icon: 'file', depth: 1 },
  { name: 'README.md', icon: 'file', depth: 1 },
];

/* ================= AI 面板(静态历史,同 cloud8) ================= */
export const CHAT = { l: 1590, w: 310, top: 80, bottom: 1016 } as const;
export const ITEM_W = 296;
export type ChatSpec =
  | { kind: 'user'; id: string; lines: string[] }
  | { kind: 'ai'; id: string; lines: string[] };
export const CHAT_HISTORY: ChatSpec[] = [
  { kind: 'user', id: 'u1', lines: ['测试挂了怎么排查？'] },
  { kind: 'ai', id: 'ai1', lines: ['先看失败用例的断言输出——', '定位到回调签名配置缺失，', '补上 DB_PASS 配置即可。'] },
];

/* ================= 底栏(含 SFTP 上传进度) ================= */
export const PROG = { x: 420, y: 1187, barW: 150, barH: 4 } as const;
export const TOAST_POS = { right: 24, bottom: 34 } as const;

/* ================= 时间线标签页 ================= */
export const TL = {
  x: CENTER.x,
  w: CENTER.w,
  /** 工具栏(标题+搜索框+时间段+刷新+AI 分析) */
  toolY: 76,
  toolH: 44,
  search: { x: 396, y: 84, w: 400, h: 28 },
  rangeX: 812,
  /** 标签 chips 行 */
  tagsY: 124,
  tagsH: 32,
  chipW: 76,
  /** 类别 chips 行 */
  kindsY: 160,
  kindsH: 36,
  /** 事件列表:行绝对定位 */
  bodyTop: 204,
  rowH: 36,
  rowX: 312,
  rowW: 1256,
  statusY: 1150,
  /** 工具栏右侧按钮(窗口坐标;面板右缘 1580,right:12 → 1568) */
  refreshBtn: { x: 1408, y: 84, w: 70, h: 28 },
  aiBtn: { x: 1484, y: 84, w: 84, h: 28 },
} as const;
/** 行内列位(相对窗口) */
export const TL_COL = { icon: 322, time: 352, kind: 492, summary: 552 } as const;
export const tlRowY = (i: number): number => TL.bodyTop + i * TL.rowH;

/** 类别元数据(对照主仓 TimelineTab KINDS;本片只用到出现的几类) */
export const KIND_META: Record<string, { label: string; icon: 'monitor' | 'terminal' | 'upload' | 'download' | 'user' | 'bot' | 'wrench' | 'alert' }> = {
  ssh_connect: { label: '连接', icon: 'monitor' },
  ssh_disconnect: { label: '断开', icon: 'monitor' },
  ssh_connect_failed: { label: '连接失败', icon: 'alert' },
  command: { label: '命令', icon: 'terminal' },
  file_upload: { label: '上传', icon: 'upload' },
  file_download: { label: '下载', icon: 'download' },
  ai_user: { label: '提问', icon: 'user' },
  ai_assistant: { label: '回答', icon: 'bot' },
  ai_tool: { label: '工具', icon: 'wrench' },
};

/** 本地时间线行(项目「订单服务」,ts 倒序;tags 由 script.ts 按打标进度注入) */
export interface LocalRow {
  id: string;
  time: string;
  kind: string;
  summary: string;
  /** 打标后:B1 → t1,B2 → t5;region 为选区行(t2/t3/t4) */
  tag?: '发布';
  region?: boolean;
}
export const TL_ROWS: LocalRow[] = [
  { id: 't0', time: '09-10 15:42:10', kind: 'file_upload', summary: 'dist.tar.gz → /srv/order/releases/' },
  { id: 't1', time: '09-10 15:41:58', kind: 'command', summary: '$ cargo test --release', tag: '发布' },
  { id: 't2', time: '09-10 15:40:47', kind: 'ai_assistant', summary: '先看失败用例的断言输出，定位到回调签名…', region: true },
  { id: 't3', time: '09-10 15:40:02', kind: 'ai_user', summary: '测试挂了怎么排查？', region: true },
  { id: 't4', time: '09-10 15:38:12', kind: 'command', summary: '$ systemctl status order-api', region: true },
  { id: 't5', time: '09-10 15:35:40', kind: 'ssh_connect', summary: '连接 order-1 (10.10.1.55:22)', tag: '发布' },
  { id: 't6', time: '09-10 14:52:31', kind: 'command', summary: '$ docker compose ps' },
  { id: 't7', time: '09-10 14:50:07', kind: 'file_download', summary: 'app.log ← /var/log/order/' },
];
/** 打标目标行(显示序):B1 右键 t1(第 1 行),B2 右键 t5(第 5 行) */
export const ROW_TAG1 = 1;
export const ROW_TAG2 = 5;
export const TAG_COLOR = '#4f8ef7';
export const TAG2_COLOR = '#4ec98a';

/* 右键菜单(锚于目标行下方;单菜单实例,两次出现仅 y 不同) */
export const MENU9 = { x: 560, w: 150, itemH: 30, pad: 4 } as const;
export const MENU9_ITEM = '标签…';
export const MENU9_Y1 = 268; /* t1 行(y240)下方 */
export const MENU9_Y2 = 412; /* t5 行(y384)下方 */
export const menuItemCy = (y: number): number => y + MENU9.pad + MENU9.itemH / 2;

/* 打标签弹窗(TagDialog 460 宽) */
export const DLG9 = { x: 730, y: 420, w: 460, h: 340 } as const;
export const DLG9_F = {
  headCy: 442,
  targetY: 478,
  input: { x: 754, y: 500, w: 412, h: 34 },
  paletteY: 556,
  hintY: 608,
  btnCancel: { x: 1014, y: 706, w: 60, h: 30 },
  btnOk: { x: 1096, y: 706, w: 76, h: 30 },
} as const;
/** 调色板 8 色(对照主仓 TAG_PALETTE) */
export const PALETTE = ['#4f8ef7', '#4ec98a', '#e5b567', '#e5534b', '#9d6bde', '#d670a8', '#3fb6c9', '#8b949e'];
export const paletteCx = (i: number): number => DLG9_F.input.x + 11 + i * 32;

/* ================= B2 幕:AI 分析(对照 TimelineTab AnalyzeDialog + ai-engine analyzeTimeline) ================= */
/** 「选择分析范围」弹窗 */
export const ADLG9 = { x: 730, y: 400, w: 460, h: 304 } as const;
export const ADLG9_F = {
  hintY: 456,
  /** 两个标签勾选项(发布 / 排查),行高 36 */
  itemY: (i: number): number => 496 + i * 36,
  checkboxX: 754,
  footerY: 652,
  btnCancel: { x: 966, y: 652, w: 60, h: 30 },
  btnOk: { x: 1044, y: 652, w: 128, h: 30 },
} as const;
/** 分析范围标签(第一项会被勾选;名称与 DEMO.tag1Name 一致,字面量避免 TDZ) */
export const ANALYZE_TAGS = [
  { name: '发布', color: TAG_COLOR },
  { name: '排查', color: TAG2_COLOR },
] as const;

/** AI 面板「时间线分析」会话内容几何(相对窗口;面板 1580..1920) */
export const AI2 = {
  paneL: 1580,
  userY: 96,
  toolY: 168,
  linesY: 204,
  lineH: 22,
  askY: 366,
  askW: 308,
  askX: 1590,
  saveBtn: { x: 1796, y: 486, w: 88, h: 28 },
} as const;
/** 流式总结文案(项目日志浓缩;逐行显现) */
export const AI2_LINES: { text: string; bold?: boolean; muted?: boolean }[] = [
  { text: '已检索「发布」选区（15:35–15:42 · 6 条事件）', muted: true },
  { text: '项目日志 · 订单服务发布', bold: true },
  { text: '· 连接 order-1，cargo test --release 全过' },
  { text: '· 上传 dist.tar.gz 至 releases/ 完成发布' },
  { text: '· 遗留：回调签名缺失已补 DB_PASS 修复' },
  { text: '已产出 1 篇笔记与 1 个 Skill，请选择保存：', muted: true },
];
/** ask 卡选项(默认全勾选) */
export const AI2_ASK = ['[笔记] 订单服务发布日志', '[Skill] order-release-flow'] as const;

/* ================= 设置页 ================= */
export const SET = {
  navW: 200,
  nav: ['账号信息', 'AI 模型', '服务器', '项目', '技能', '系统设置', '关于'],
  navActive: 5,
  navTop: 86,
  navStep: 36,
  fsX: 280,
  fsW: 900,
  /** 上一个 fieldset(AI 助手,ghost 垫底;顶部越界由镜头裁掉) */
  fsAi: { y: 64, h: 272 },
  /** 「时间线云同步」fieldset */
  fsTl: { y: 356, h: 330 },
  legendDy: -9,
  label: { x: 312, y: 402 },
  checkbox: { x: 490, y: 401, w: 16, h: 16 },
  hint: { x: 312, y: 436, w: 830 },
  status: { x: 312, y: 556 },
  purgeBtn: { x: 312, y: 596, w: 148, h: 28 },
} as const;
export const setNavCy = (i: number): number => SET.navTop + i * SET.navStep + 17;
/** C3 悬停提示小卡(开关右侧) */
export const TIP_CARD = { x: 530, y: 372, w: 316 } as const;

/* 「删除云端时间线」确认框(400 宽,窗口内居中) */
export const CFM9 = { x: 760, y: 475, w: 400, h: 250 } as const;
export const CFM9_BTN = {
  cancel: { x: 988, y: 673, w: 60, h: 32 },
  ok: { x: 1072, y: 673, w: 88, h: 32 },
} as const;

/* ================= 网页端(浏览器框 + 云平台工作台,浅色主题) =================
 * 对照 aishell-cloud web/admin:UserWorkspace 外壳(侧栏 + 顶栏)+ TimelinePanel +
 * TimelineStream(卡片/筛选表单/类别 chips/日分隔/事件行/展开详情/治理卡);
 * 配色取 styles.css :root 变量(--bg #f3f4f7 / --surface #fff / --accent #3b76e1 等),
 * 本地收敛为 Web9.tsx 内的 LC 调色板;此处只放几何与数据。 */
export const WEB = {
  tabStripH: 40,
  toolbarH: 44,
  addr: { x: 150, y: 46, w: 1400, h: 32 },
  url: 'cloud.example.com/workbench#/timeline',
  sideW: 208,
  /** 侧栏导航(对照 UserWorkspace;active = 时间线) */
  menu: [
    { label: '概览', icon: 'home' },
    { label: '我的用量', icon: 'chart' },
    { label: '对话测试', icon: 'terminal' },
    { label: '记忆宫殿', icon: 'sparkles' },
    { label: 'Skill Hub', icon: 'package' },
    { label: '问题反馈', icon: 'send' },
    { label: '云同步', icon: 'history' },
    { label: '云备份', icon: 'box' },
    { label: '时间线', icon: 'clock' },
  ] as const,
  menuActive: 8,
  menuTop: 196,
  menuStep: 40,
  /** 顶栏(eyebrow + h1 + 用户菜单) */
  topbarH: 76,
  /** 统一时间线卡片 */
  cardX: 240,
  cardY: 184,
  cardW: 1648,
  cardHeadH: 68,
  /** 筛选表单(label 在上、控件在下;对照 .timeline-filters) */
  filterLabelY: 268,
  filterY: 286,
  filterH: 34,
  projSel: { x: 260, y: 286, w: 170, h: 34 },
  tagSel: { x: 446, y: 286, w: 150, h: 34 },
  kwInput: { x: 612, y: 286, w: 320, h: 34 },
  rangeSel: { x: 948, y: 286, w: 150, h: 34 },
  queryBtn: { x: 1114, y: 286, w: 76, h: 34 },
  resetBtn: { x: 1198, y: 286, w: 76, h: 34 },
  /** 项目下拉(锚于 select 下方) */
  drop: { x: 260, y: 324, w: 170, optH: 36, pad: 4 },
  /** 类别 chips(9 类,对照 KIND_ORDER;x 由 chipX(i) 推导) */
  chipsY: 344,
  chipH: 26,
  /** 日分隔 + 事件流 */
  dayY: 390,
  listTop: 420,
  rowH: 46,
  detailH: 110,
  rowX: 260,
  rowW: 1608,
  /** 治理卡(删除云端时间线) */
  dangerY: 736,
  dangerH: 80,
} as const;
/** 类别 chips 文案与宽度(等宽 56,「连接失败」76),起点 x260 间距 8 */
export const WEB_CHIPS: { key: string; label: string; w: number }[] = [
  { key: 'connect', label: '连接', w: 56 },
  { key: 'disconnect', label: '断开', w: 56 },
  { key: 'failed', label: '连接失败', w: 76 },
  { key: 'command', label: '命令', w: 56 },
  { key: 'upload', label: '上传', w: 56 },
  { key: 'download', label: '下载', w: 56 },
  { key: 'ask', label: '提问', w: 56 },
  { key: 'answer', label: '回复', w: 56 },
  { key: 'tool', label: '工具', w: 56 },
];
export const webChipX = (i: number): number => 260 + WEB_CHIPS.slice(0, i).reduce((s, c) => s + c.w + 8, 0);
/** 行内列位(相对窗口):时间 / 类别徽标 / 摘要;项目名与标签 chip 右对齐 */
export const WEB_COL = { time: 272, kind: 380, summary: 444 } as const;
export const webRowY = (i: number): number => WEB.listTop + i * WEB.rowH;
export const dropOptCy = (i: number): number => WEB.drop.y + WEB.drop.pad + i * WEB.drop.optH + WEB.drop.optH / 2;
/** 筛选下拉选项:0 全部项目 1 订单服务 2 支付网关 */
export const DROP_OPTS = ['全部项目', '订单服务', '支付网关'] as const;

/** 类别徽标色调(对照 styles.css .tag.*:blue/purple/green/red/amber/muted) */
export const TAG_TONE = {
  blue: { fg: '#2d64b5', bg: '#edf3ff' },
  purple: { fg: '#6d45a5', bg: '#f3edfc' },
  green: { fg: '#16895b', bg: '#eaf8f2' },
  red: { fg: '#c83d4d', bg: '#fff0f2' },
  amber: { fg: '#a76513', bg: '#fff6e8' },
  muted: { fg: '#59606c', bg: '#eef0f3' },
} as const;
export const KIND_TONE: Record<string, keyof typeof TAG_TONE> = {
  ssh_connect: 'green',
  ssh_disconnect: 'muted',
  ssh_connect_failed: 'red',
  command: 'blue',
  file_upload: 'purple',
  file_download: 'purple',
  ai_user: 'amber',
  ai_assistant: 'amber',
  ai_tool: 'blue',
};

/** 网页事件行(两项目混合,ts 倒序;detail 只给 w5,展开演示) */
export interface WebRow {
  id: string;
  proj: 'order' | 'pay';
  time: string;
  kind: string;
  summary: string;
  tag?: '发布';
}
export const WEB_ROWS: WebRow[] = [
  { id: 'w0', proj: 'pay', time: '09-10 16:02:11', kind: 'command', summary: '$ systemctl restart pay-gateway' },
  { id: 'w1', proj: 'pay', time: '09-10 15:58:40', kind: 'file_download', summary: 'app.log ← /var/log/pay/' },
  { id: 'w2', proj: 'pay', time: '09-10 15:55:02', kind: 'ssh_connect', summary: '连接 pay-1 (10.10.1.62:22)' },
  { id: 'w3', proj: 'order', time: '09-10 15:42:10', kind: 'file_upload', summary: 'dist.tar.gz → /srv/order/releases/' },
  { id: 'w4', proj: 'order', time: '09-10 15:41:58', kind: 'command', summary: '$ cargo test --release', tag: '发布' },
  { id: 'w5', proj: 'order', time: '09-10 15:35:40', kind: 'ssh_connect', summary: '连接 order-1 (10.10.1.55:22)', tag: '发布' },
];
/** D4 展开的目标行(命令 · cargo test) */
export const WEB_EXPAND_ID = 'w4';
export const WEB_DETAIL: string[] = [
  '$ cargo test --release',
  'running 42 tests',
  'test payment::tests::callback_sign ... ok',
  'config: DB_PASS=***已脱敏***',
  'test result: ok. 42 passed; 0 failed',
];

/** 项目 chip 元数据 */
export const PROJ_META: Record<WebRow['proj'], { label: string; color: string }> = {
  order: { label: '订单服务', color: '#4f8ef7' },
  pay: { label: '支付网关', color: '#9d6bde' },
};

/* ================= 终端(本地终端标签,背景) ================= */
export type TermLine = { prompt?: boolean; cmd?: string; text?: string };
export const TERM_CMD = 'cargo test --release';
export const TERM_BASE: TermLine[] = [
  { cmd: 'ssh deploy@10.10.1.55' },
  { text: 'Welcome to Ubuntu 22.04 (order-1)' },
  { text: '' },
  { cmd: 'systemctl status order-api' },
  { text: '● order-api - Order Service API' },
  { text: '   Active: active (running) since 09-10 08:00' },
  { text: '' },
];
export const TERM_OUT: string[] = [
  '   Compiling order-api v0.8.2',
  '    Finished `release` profile [optimized] in 28.4s',
  '42 passed; 0 failed',
];

/* ================= 演示文案 ================= */
export const DEMO = {
  projectName: '订单服务',
  uploadFile: 'dist.tar.gz',
  tag1Name: '发布',
  tag2Name: '发布',
  chipText: '上传已开启：按分钟增量上报（首次开启会自动回填本地近 30 天历史）',
  purgeToast: '云端时间线已清空（事件 1,286 条 · 标签 4 个）',
  tipTitle: '关闭后只写本机',
  tipBody: '关闭开关只停止上传，时间线仍在本机记录（保留 30 天）；已上传的数据可在下方删除。',
} as const;
export const SET_HINT = '登录公司账号且平台开通后，项目时间线（SSH 连接、命令、文件传输、AI 会话）将脱敏上传云端，用于跨设备回溯与网页端「跨项目统一时间线」视图；云端保留期默认 90 天。本机时间线文件不受影响；关闭只停止上传，已上传数据可在下方删除';
