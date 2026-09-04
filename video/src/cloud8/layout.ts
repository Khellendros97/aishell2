/**
 * 视频八(云同步与云备份)场景几何常量。
 * 工作台骨架与 ssh7 同源(活动栏/侧栏/终端/AI 面板/底栏);侧栏为资源管理器文件树
 * (行高 26,dataset 文件夹右键菜单 itemH 28),底栏新增云备份进度(标题+进度条+明细)。
 * 账号页按 Account.tsx(settings-page 容器:左导航 168px padding 14 8 + 内容区)与
 * CloudSyncView.tsx(account.css:sync-toolbar / sync-summary-grid 统计卡 / sync-section
 * 分区 / sync-device / sync-backup 行 / danger-zone)复刻;弹窗:PasswordModal 440 宽、
 * 「备份到云端」确认框 400 宽、RestoreModal 500 宽(MaskModal 居中)。
 * 坐标系:窗口设计稿 1920×1200;账号页内容为绝对定位 + 校正层,锚点即窗口坐标。
 */

/* ================= 工作台骨架(与视频五/六/七一致) ================= */
export const SIDEBAR = { x: 48, w: 260, headH: 34 };
export const CENTER = { x: 308, w: 1272, tabBarH: 36 };
export const TAB_W = 152;
export const TAB_TERM_X = 308;

/* ================= 资源管理器文件树(侧栏) ================= */
/** 树行:起点 y74(头 34),行高 26;行0 根目录,行3 dataset(右键目标) */
export const EXPL = { top: 74, rowH: 26, indent: 14 } as const;
export const explRowY = (i: number): number => EXPL.top + i * EXPL.rowH;
export const EXPL_ROW_DATASET = 3;
export const TREE: { name: string; icon: 'folderOpen' | 'folder' | 'file'; depth: number }[] = [
  { name: 'nebula-site', icon: 'folderOpen', depth: 0 },
  { name: '.aishell', icon: 'folder', depth: 1 },
  { name: 'assets', icon: 'folder', depth: 1 },
  { name: 'dataset', icon: 'folder', depth: 1 },
  { name: 'docs', icon: 'folder', depth: 1 },
  { name: 'index.html', icon: 'file', depth: 1 },
  { name: 'package.json', icon: 'file', depth: 1 },
];

/** 右键菜单(锚于 dataset 行下方;itemH 28 4 项,「备份到云端」为第 4 项) */
export const EXPL_MENU = { x: 96, y: 196, w: 180, itemH: 28, pad: 4 } as const;
export const explMenuItemCy = (i: number): number => EXPL_MENU.y + EXPL_MENU.pad + i * EXPL_MENU.itemH + EXPL_MENU.itemH / 2;
export const MENU_BACKUP = 3;
export const EXPL_ROW_HOVER = 130; /* 菜单悬停高亮行 x 起点 */

/* ================= 顶栏导航按钮(与 ssh7 一致) ================= */
export const TOP_NAV = {
  project: { x: 1615, y: 20 },
  settings: { x: 1675, y: 20 },
  account: { x: 1735, y: 20 },
} as const;

/* ================= 底栏云备份进度(statusbar-progress) ================= */
export const PROG = { x: 420, y: 1187, barW: 150, barH: 4 } as const;

/* ================= AI 面板(与视频五/六/七一致) ================= */
export const CHAT = { l: 1590, w: 310, top: 80, bottom: 1016 } as const;
export const ITEM_W = 296;
export const AI_INPUT = { x: 1750, y: 1130 } as const;

/* ================= 聊天条目(静态历史,同构 ssh7) ================= */
export type ActionStatus = 'succeeded';

export interface ActionSpec {
  name: string;
  icon: 'wrench' | 'database' | 'filePlus';
  cmd?: string;
  result?: string;
}

export type ChatSpec =
  | { kind: 'user'; id: string; lines: string[]; chip?: string }
  | { kind: 'ai'; id: string; lines: string[] }
  | { kind: 'action'; id: string; status: ActionStatus; spec: ActionSpec };

export function chatItemH(item: ChatSpec): number {
  if (item.kind === 'user') return 16 + item.lines.length * 20;
  if (item.kind === 'ai') return 16 + item.lines.length * 20;
  let blocks = 20;
  let n = 1;
  if (item.spec.cmd) { blocks += 24; n++; }
  if (item.spec.result) { blocks += 28; n++; }
  return 12 + 16 + blocks + (n - 1) * 5;
}

export type ChatItem = ChatSpec & { y: number; h: number };

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

/* ================= 账号页(Account.tsx:settings-page + account-layout) ================= */
export const ACC = {
  navW: 168,
  navPadX: 8,
  /** 左导航项(高 34 含 padding 8,gap 2 → 步距 36):0 账号信息 1 用量报表 2 记忆宫殿 3 用户反馈 4 云同步 */
  navItemX: 84,
  navTop: 71,
  navStep: 36,
  /** 内容区:view head「云同步」+ body(CloudSyncView,宽 1240,x204..1444) */
  headCy: 106,
  viewX: 204,
  viewW: 1240,
  /** 工具栏:状态 chip 居左;按钮居右(刷新/立即同步+锁定 或 解锁云同步/设置同步密码) */
  chip: { x: 228, y: 162 },
  btnRefresh: { x: 1258, y: 148, w: 68, h: 28 },
  btnSync: { x: 1268, y: 148, w: 96, h: 28 },
  btnLock: { x: 1372, y: 148, w: 72, h: 28 },
  btnUnlock: { x: 1334, y: 148, w: 110, h: 28 },
  /** 概要统计卡(4 张一行,y196..258) */
  sumTop: 196,
  sumCardW: 302,
  sumGap: 11,
  sumH: 62,
  /** 配置同步规模 section(y274..370:h4 + 8 卡一行) */
  scaleTop: 274,
  scaleTitleCy: 296,
  scaleCardTop: 316,
  scaleCardH: 54,
  /** 设备管理 section(y386..500) */
  devTop: 386,
  devTitleCy: 408,
  devRow1: 430,
  devRow2: 464,
  devRowH: 30,
  /** 冲突 section(y516..578) */
  cflTop: 516,
  cflTitleCy: 538,
  cflHintY: 552,
  /** 云端备份 section(y594..742) */
  bkTop: 594,
  bkTitleCy: 616,
  bkRow: 638,
  bkRowH: 44,
  bkLimitsY: 692,
  /** 危险区(y766..798,按钮右对齐) */
  dzCy: 782,
  dzChange: { x: 1090, y: 766, w: 110, h: 28 },
  dzDelete: { x: 1208, y: 766, w: 152, h: 28 },
} as const;
export const accNavCy = (i: number): number => ACC.navTop + i * ACC.navStep;
export const accSumCardX = (i: number): number => ACC.viewX + 24 + i * (ACC.sumCardW + ACC.sumGap);
export const accScaleCardX = (i: number): number => ACC.viewX + 14 + i * 152;
export const NAV_ACCOUNT_SYNC = 4;

/* ================= 密码弹窗(PasswordModal 440 宽) ================= */
export const PWD8 = { x: 740, y: 396, w: 440, h: 250 } as const;
export const PWD8_F = {
  headCy: 420,
  labelCy: 462,
  input: { x: 764, y: 476, w: 392, h: 34 },
  hintY: 522,
  btnCancel: { x: 1024, y: 598, w: 60, h: 30 },
  btnOk: { x: 1092, y: 598, w: 64, h: 30 },
} as const;

/* ================= 「备份到云端」确认框(confirmDialog 400 宽) ================= */
export const CFM8 = { x: 760, w: 400, h: 216 } as const;
export const CFM8_BTN = {
  ok: { x: 1112, y: 674 },
  cancel: { x: 1024, y: 674 },
} as const;

/* ================= 恢复弹窗(RestoreModal 500 宽) ================= */
export const RST8 = { x: 710, y: 396, w: 500, h: 336 } as const;
export const RST8_F = {
  headCy: 420,
  hintY: 444,
  targetLabelCy: 502,
  targetInput: { x: 734, y: 516, w: 336, h: 34 },
  browseBtn: { x: 1082, y: 516, w: 64, h: 34 },
  selLabelCy: 580,
  sel: { x: 734, y: 594, w: 412, h: 34 },
  btnCancel: { x: 1032, y: 682, w: 60, h: 30 },
  btnOk: { x: 1100, y: 682, w: 86, h: 30 },
} as const;

/* ================= toast(窗口级,与 ssh7 一致) ================= */
export const TOAST8 = { x: 1896, y: 1146 } as const;

/* ================= 演示数据 ================= */
export const DEMO = {
  projectName: 'nebula-site',
  datasetPath: 'D:\\projects\\nebula-site\\dataset',
  backupName: 'dataset-20260903',
  backupMeta: '2026/9/3 14:20 · 2.4 GB · 128 个文件',
  backupLimit: '单次最多 不限 个文件，最大 按云端限制。',
  lastSync: '2026/9/3 14:02',
  quotaText: '2.4 GB / 50 GB',
  backupQuotaText: '7.2 GB / 100 GB',
  pwdDots: '••••••••',
  counts: [
    { label: '项目配置', value: 3 },
    { label: '服务器配置', value: 2 },
    { label: '登录凭据', value: 2 },
    { label: '项目文件夹', value: 5 },
    { label: '命令文件夹', value: 2 },
    { label: 'SSH 隧道', value: 2 },
    { label: 'SFTP 收藏', value: 4 },
    { label: '浏览器收藏', value: 6 },
  ],
  summary: [
    { label: '最近成功同步', value: '暂无' },
    { label: '待上传项', value: '0' },
    { label: '同步空间', value: '0 B / 0 B' },
    { label: '备份空间', value: '0 B / 0 B' },
  ],
  summaryAfter: [
    { label: '最近成功同步', value: '2026/9/3 14:02' },
    { label: '待上传项', value: '0' },
    { label: '同步空间', value: '2.4 GB / 50 GB' },
    { label: '备份空间', value: '7.2 GB / 100 GB' },
  ],
  devices: [
    { name: '台式机-工位', current: true, seen: '2026/9/3 14:02' },
    { name: '笔记本-出差', current: false, seen: '2026/9/1 09:41' },
  ],
  restoreTarget: 'D:\\restore',
} as const;

/** 聊天历史(承接第五/七段) */
export const CHAT_HISTORY: ChatSpec[] = [
  { kind: 'user', id: 'u1', chip: '@browser:#hero-title', lines: ['把这个标题改成品牌蓝，', '按钮改成胶囊圆角'] },
  { kind: 'ai', id: 'ai1', lines: ['好的，该网站 IP 10.21.36.8 命中服务器', 'deephaven-dev-01，先定位部署目录。'] },
  { kind: 'action', id: 'act1', status: 'succeeded', spec: { name: '执行命令', icon: 'wrench', cmd: 'ssh deploy@10.21.36.8 "ls /var/www"', result: '/var/www/nebula' } },
  { kind: 'user', id: 'u0', lines: ['实验室的集群管理台只有内网能打开，', '本地浏览器怎么访问？'] },
  { kind: 'ai', id: 'ai0', lines: ['可以在服务器卡片「更多 → SSH 隧道」', '里建一条 SOCKS5 动态代理隧道：本地', '流量经 deephaven-dev-01 转发，内网', '站点即可直达。'] },
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
