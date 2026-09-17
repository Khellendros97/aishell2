/**
 * 视频十(仪表盘与备忘录)场景几何常量与演示数据。
 * 工作台骨架与 timeline9 同源(活动栏/侧栏/中央标签区/AI 面板/底栏),活动栏补上首位「仪表盘」
 * (compass,对照主仓 Workbench.tsx:328);新增:仪表盘侧栏面板(备忘录可编辑表格/备忘文本/markdown 卡/
 * 性能表格卡/流量折线图卡,对照主仓 DashboardPanel.tsx + dashboard.css)、「定制仪表盘」promptDialog
 * (对照 src/ui.ts promptDialog multiline 形态)、账号页云同步视图(CloudSyncView 配置同步规模/设备管理)、
 * 设置页「外观」(Settings.tsx appearance:界面主题/服务器紧凑布局/菜单栏默认打开/保存)。
 * 坐标系:窗口设计稿 1920×1200;卡片/表格/字段均为绝对定位写死(不用流式推导)。
 * 锚点:交互目标打 data-anchor(见各常量注释),高亮/指针经 components/anchors.tsx 实测;
 * 所有锚点元素全程挂载(三页面叠放交叉淡化,不卸载),弹窗/下拉内的锚点按消费窗口挂载。
 */

/* ================= 工作台骨架(与视频五/六/七/八/九一致;侧栏加宽为 300) ================= */
export const CENTER = { x: 348, w: 1232, tabBarH: 36 } as const;
export const TAB_TERM_X = 308;
export const TAB_W = 152;

/** 活动栏(对照主仓 Workbench.tsx):仪表盘首位,其后 explorer/servers/commands/skills/notes/timeline/browser;
 *  图标 40×40 + gap2,顶栏 40 + paddingTop 6 → 第 i 项中心 y = 66 + 42i */
export const ACT_ORDER = ['dashboard', 'explorer', 'servers', 'commands', 'skills', 'notes', 'timeline', 'browser'] as const;
export const actCy = (i: number): number => 66 + i * 42;
export const ACT_DASH = { x: 24, y: actCy(0) } as const;

/** 顶栏导航按钮(与 cloud8/timeline9 一致) */
export const TOP_NAV = {
  project: { x: 1615, y: 20 },
  settings: { x: 1675, y: 20 },
  account: { x: 1735, y: 20 },
} as const;

/* 资源管理器文件树(侧栏默认面板,项目「订单服务」) */
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

/* ================= 仪表盘侧栏面板(对照 DashboardPanel.tsx + dashboard.css) ================= */
export const SIDEBAR = { x: 48, w: 300 } as const;
/** 面板头(34px):标题左,头操作区右——定制(sparkles)/自动刷新(play⇄pause)/刷新,icon-btn 24×24 */
export const DASH_HEAD = { y: 74, h: 34 } as const;
export const DASH_BTN = {
  sparkles: { x: 276, y: 91 },
  auto: { x: 302, y: 91 },
  refresh: { x: 328, y: 91 },
} as const;
/** 面板体:padding 8 → 内容 x56 w284,起 y116 */
export const BODY = { x: 56, w: 284 } as const;

/* --- 备忘录卡(固定置顶,脚本不可删) --- */
export const MEMO = {
  y: 116,
  titleH: 26,
  /** 表格:header 27 + 行高 29(padding 7 10,font 12);两列 4:6 + 操作列 30(对照 .dash-col-first/.dash-col-ops) */
  headH: 27,
  rowH: 29,
  col1W: 102,
  opsW: 30,
  /** 备忘文本(textarea,min-height 88) */
  textH: 94,
} as const;
export const MEMO_TABLE_Y = MEMO.y + MEMO.titleH; // 142
export const memoRowY = (i: number): number => MEMO_TABLE_Y + MEMO.headH + i * MEMO.rowH;
/** 列位:x56..158(col1) 158..310(col2) 310..340(ops);复制按钮在 col2 右缘(right:4) */
export const MEMO_COL2_X = BODY.x + MEMO.col1W; // 158
export const MEMO_COPY = { x: 297, y: memoRowY(0) + MEMO.rowH / 2 } as const; // 行0 复制钮中心
export const MEMO_ADD = { x: BODY.x + BODY.w - 15, y: MEMO_TABLE_Y + MEMO.headH / 2 } as const; // 表头 + 钮
export const MEMO_TEXT_Y = memoRowY(3); // 三行后表格底 = 备忘文本顶

/* --- markdown 卡(项目概览) --- */
export const MD = { y: 358, titleH: 26, h: 98 } as const;

/* --- 性能监控卡(C 幕 AI 产物;5 列:服务器/1分钟/5分钟/15分钟/内存) --- */
export const PERF = { y: 464, titleH: 26, headH: 27, rowH: 29 } as const;
export const PERF_COLS = [
  { key: 'name', title: '服务器', x: 64, w: 62 },
  { key: 'l1', title: '1分钟', x: 130, w: 48 },
  { key: 'l5', title: '5分钟', x: 182, w: 44 },
  { key: 'l15', title: '15分钟', x: 230, w: 54 },
  { key: 'mem', title: '内存', x: 288, w: 46 },
] as const;
export const PERF_ROWS = [
  { name: 'order-1', l1: '0.42', l5: '0.38', l15: '0.35', mem: '61%' },
  { name: 'pay-1', l1: '0.18', l5: '0.21', l15: '0.19', mem: '43%' },
] as const;
export const perfRowY = (i: number): number => PERF.y + PERF.titleH + PERF.headH + i * PERF.rowH;

/* --- 流量监控卡(D 幕 AI 产物;echarts 折线 SVG 手绘) --- */
export const CHART = { y: 583, titleH: 26, h: 190 } as const;
/** SVG 绘图区(卡片内 x56..332 → 图宽 268,高 182,padding 后绘图区) */
export const CHART_GEO = { x: 56, y: CHART.y + CHART.titleH, w: 268, h: 182, padL: 36, padR: 10, padT: 12, padB: 22, yMax: 500 } as const;
/** 近 24 小时入/出流量(Mbps);20:00 入 480 为峰值(tooltip 定格) */
export const CHART_IN = [12, 8, 6, 5, 6, 9, 18, 42, 86, 120, 150, 138, 126, 142, 158, 170, 210, 260, 330, 410, 480, 392, 180, 60];
export const CHART_OUT = [8, 5, 4, 3, 4, 6, 12, 28, 60, 88, 104, 96, 90, 98, 110, 122, 150, 190, 240, 276, 310, 260, 120, 44];
export const PEAK_HOUR = 20;
export const chartX = (i: number): number => CHART_GEO.x + CHART_GEO.padL + (i * (CHART_GEO.w - CHART_GEO.padL - CHART_GEO.padR)) / 23;
export const chartY = (v: number): number => CHART_GEO.y + CHART_GEO.padT + (1 - v / CHART_GEO.yMax) * (CHART_GEO.h - CHART_GEO.padT - CHART_GEO.padB);
/** 峰值点(窗口坐标,指针 hover 目标) */
export const CHART_PEAK = { x: chartX(PEAK_HOUR), y: chartY(CHART_IN[PEAK_HOUR]) } as const;
export const CHART_LINE = '#5470c6';
export const CHART_LINE2 = '#91cc75';

/* ================= AI 面板(定制会话) ================= */
/** 面板 x1580 w340;内容容器原点 (1580, 80),条目 x1590 w320 */
export const AI = { paneL: 1580, itemX: 1590, itemW: 312, bubbleW: 300 } as const;
export const AI1 = {
  userY: 96,
  toolsY: 190,
  toolStep: 34,
  sumY: 334,
} as const;
export const AI2 = {
  userY: 396,
  toolsY: 486,
  toolStep: 34,
  sumY: 592,
} as const;
/** 工具条文案(对照 dashboard 技能调试循环:read → write → dashboard_reload → dashboard_view) */
export const TOOLS1 = [
  { text: 'read · dashboard/SKILL.md', done: true },
  { text: 'write · .aishell/dashboard/dashboard.py', done: true },
  { text: 'dashboard_reload · 退出码 0', done: true },
  { text: 'dashboard_view · 5 个组件核对通过', done: true },
] as const;
export const TOOLS2 = [
  { text: 'write · dashboard.py（+chart 组件）', done: true },
  { text: 'dashboard_reload · 退出码 0', done: true },
  { text: 'dashboard_view · 组件核对通过', done: true },
] as const;
export const AI_SUM1 = '已新增「服务器性能监控」表格，30 秒自动刷新。';
export const AI_SUM2 = '已新增「流量监控」折线图，经只读管道连业务库取数。';
export const AI_REQ1 = '增加一个服务器性能监控面板，显示各服务器的负载和内存，每 30 秒自动刷新';
export const AI_REQ2 = '再加一个流量监控图表：查 order-1 上 MySQL 的流量统计表，画近 24 小时折线图';

/* ================= 底栏 / toast ================= */
export const TOAST_POS = { right: 24, bottom: 34 } as const;

/* ================= 「定制仪表盘」promptDialog(400 宽,对照 src/ui.ts multiline 形态) ================= */
export const DLG = { x: 760, y: 400, w: 400, h: 348 } as const;
export const DLG_F = {
  headH: 44,
  labelY: 466,
  input: { x: 784, y: 508, w: 352, h: 116 },
  hintY: 632,
  btnCancel: { x: 964, y: 698, w: 64, h: 30 },
  btnSend: { x: 1040, y: 698, w: 104, h: 30 },
} as const;
export const DLG_LABEL = '描述你想在仪表盘中看到的内容,AI 将修改 dashboard.py 并自动调试验证:';

/* ================= 账号页(云同步视图,对照 account/Account.tsx + CloudSyncView.tsx) ================= */
export const ACCT = {
  navW: 190,
  navTop: 96,
  navStep: 40,
  /** nav:账号信息/用量报表/记忆宫殿/用户反馈/云同步(active)/激励计划 */
  navActive: 4,
  contentX: 222,
  toolbarY: 64,
  summaryY: 112,
  /** 配置同步规模 section */
  scaleTitleY: 208,
  scaleGridY: 244,
  statW: 300,
  statH: 56,
  statGap: 10,
  statRowStep: 66,
  /** 设备管理 section */
  devTitleY: 396,
  devListY: 428,
  devStep: 40,
  hintY: 520,
} as const;
export const ACCT_NAV = [
  { label: '账号信息', icon: 'user' },
  { label: '用量报表', icon: 'chart' },
  { label: '记忆宫殿', icon: 'database' },
  { label: '用户反馈', icon: 'message' },
  { label: '云同步', icon: 'cloudSync' },
  { label: '激励计划', icon: 'trophy' },
] as const;
export const acctNavCy = (i: number): number => ACCT.navTop + i * ACCT.navStep + 20;
/** 同步规模统计(两行 × 5;「仪表盘」为最后一格,高亮目标) */
export const SCALE_STATS: { label: string; value: number | string }[] = [
  { label: '项目配置', value: 3 },
  { label: '服务器配置', value: 2 },
  { label: '登录凭据', value: 2 },
  { label: '项目文件夹', value: 2 },
  { label: '命令文件夹', value: 1 },
  { label: 'SSH 隧道', value: 1 },
  { label: 'SFTP 收藏', value: 4 },
  { label: '浏览器收藏', value: 6 },
  { label: 'AI 技能', value: 5 },
  { label: '仪表盘', value: 3 },
];
export const statRect = (i: number): { x: number; y: number; w: number; h: number } => ({
  x: ACCT.contentX + 12 + (i % 5) * (ACCT.statW + ACCT.statGap),
  y: ACCT.scaleGridY + Math.floor(i / 5) * ACCT.statRowStep,
  w: ACCT.statW,
  h: ACCT.statH,
});
/** 「仪表盘」统计格(第 10 格)中心 */
export const STAT_DASH = { x: statRect(9).x, y: statRect(9).y, w: statRect(9).w, h: statRect(9).h } as const;
export const SUMMARY_STATS = [
  { label: '最近成功同步', value: '09-16 16:58' },
  { label: '待上传项', value: '0' },
  { label: '同步空间', value: '128 MB / 1 GB' },
  { label: '备份空间', value: '0 / 5 GB' },
] as const;
export const DEVICES = [
  { name: 'DEV-LAPTOP（本机）', last: '09-16 17:02', current: true },
  { name: 'office-desktop', last: '09-12 09:40', current: false },
] as const;
export const ACCT_HINT = '换台电脑登录同一账号，仪表盘与备忘录自动恢复';

/* ================= 设置页(对照 Settings.tsx appearance) ================= */
export const SET = {
  navW: 200,
  navTop: 96,
  navStep: 38,
  nav: ['功能特性', '凭据库', '外观', '快捷键', 'API 接口', '关于与更新', '浏览器'] as const,
  navActive: 2,
  titleY: 108,
  fieldX: 252,
  /** 界面主题 */
  themeLabelY: 168,
  themeSel: { x: 252, y: 192, w: 220, h: 32 },
  themeHintY: 232,
  /** 服务器紧凑布局 */
  compactLabelY: 272,
  compactCheck: { x: 252, y: 298, w: 16, h: 16 },
  compactHintY: 324,
  /** 菜单栏默认打开 */
  defLabelY: 392,
  defSel: { x: 252, y: 416, w: 220, h: 32 },
  defHintY: 456,
  /** 保存 */
  save: { x: 252, y: 512, w: 56, h: 30 },
  /** 下拉(锚于 select 下方,pad 4,optH 32;选项:收起菜单栏/仪表盘/本地文件/服务器列表) */
  drop: { x: 252, y: 452, w: 220, optH: 32, pad: 4 },
} as const;
export const SET_NAV_ICONS = ['zap', 'key', 'monitor', 'key', 'plug', 'info', 'globe'] as const;
export const setNavCy = (i: number): number => SET.navTop + i * SET.navStep + 17;
export const DROP_OPTS = ['收起菜单栏', '仪表盘', '本地文件', '服务器列表'] as const;
export const dropOptCy = (i: number): number => SET.drop.y + SET.drop.pad + i * SET.drop.optH + SET.drop.optH / 2;
export const SET_DEF_HINT = '进入工作台时菜单栏的初始状态；保存后下次进入工作台生效';
export const SET_COMPACT_HINT = '开启后工作台侧栏的服务器卡片默认折叠，仅显示图标、名称和 IP；点击卡片展开操作按钮';

/* ================= 备忘录演示数据 ================= */
/** 存量两行 + A 幕新增第三行(逐字键入) */
export const MEMO_ROWS = [
  { k: '生产数据库', v: '10.10.1.60:3306' },
  { k: 'Grafana', v: 'admin / grafana@2026' },
] as const;
export const NEW_K = '跳板机';
export const NEW_V = 'root / jb#2026Spring';
/** 备忘文本(逐字键入两行) */
export const MEMO_L1 = '发版前记得先跑 cargo test --release';
export const MEMO_L2 = '监控入口 http://10.10.1.60:3000';
export const MEMO_MD = ['- 生产：order-api @ order-1（Docker）', '- 发布：cargo test → dist.tar.gz → /srv/order/releases/'] as const;

/* ================= 演示文案 ================= */
export const DEMO = {
  projectName: '订单服务',
  copyToast: '已复制',
  saveToast: '设置已保存',
  termLines: [
    '$ ssh deploy@10.10.1.55',
    'Welcome to Ubuntu 22.04 (order-1)',
    '',
    '$ docker compose ps',
    'NAME        IMAGE        STATUS',
    'order-api   order:1.8    Up 3 days',
  ],
} as const;
