/**
 * 视频四(AI 三种工作模式 + 数据库管道)场景几何常量。
 * 工作台骨架与 sftp3/layout.ts 同源(workbench.css / servers.css 实测布局);
 * AI 面板输入区、确认对话框、数据库弹窗按 ai-engine.ts / design.css / ServersPanel.tsx 取值。
 * 坐标系:窗口设计稿 1920×1200。聊天条目高度由本文件函数统一计算,Wb4 与 script 共用,
 * 指针锚点(批准/审批按钮等)由此推导,保证点击精确落在按钮上。
 */

/* ================= 工作台骨架(与视频三一致) ================= */
export const ACT = {
  explorer: { x: 24, y: 66 },
  servers: { x: 24, y: 108 },
  commands: { x: 24, y: 150 },
  skills: { x: 24, y: 192 },
  notes: { x: 24, y: 234 },
  browser: { x: 24, y: 276 },
} as const;

export const SIDEBAR = { x: 48, w: 260, headH: 34 };
export const CENTER = { x: 308, w: 1272, tabBarH: 36 };

/* ================= AI 面板(x1580 w340) ================= */
/** 会话头 40..80;消息区 80..1026(底对齐,末条 bottom=1016);输入区 1026 起 */
export const CHAT = { l: 1590, w: 310, top: 80, bottom: 1016 } as const;
/** 气泡/动作卡宽度(消息区 padding 10 后 310,卡片略窄) */
export const ITEM_W = 296;

/** 输入区:上边框 1026,padding 8;effort 行内容顶 1040(再 padding-top 6) */
export const MODE_SEL = { x: 1666, y: 1040, w: 74, h: 22 } as const; // AI 模式下拉
export const EFFORT_SEL = { x: 1820, y: 1040, w: 78, h: 22 } as const;
/** 模式下拉展开菜单(自 select 底 1062 起下浮) */
export const MODE_MENU = { x: 1666, y: 1064, w: 118, itemH: 28, pad: 4 } as const;
export const modeMenuItemCy = (i: number): number => MODE_MENU.y + MODE_MENU.pad + i * MODE_MENU.itemH + MODE_MENU.itemH / 2;

/** 输入盒 1094..1166(中心与 scene.ts AI_INPUT 一致) */
export const AI_INPUT = { x: 1750, y: 1130 } as const;

/* ================= 服务器卡与「更多」菜单(侧栏 servers) ================= */
export const SRV_CARD = { x: 56, y: 134, w: 244, h: 102 } as const;
/** 展开态操作行 4 个 26×26 右对齐(more 最右);行中心 y = 134+8+30+6+18+6+13 */
export const MORE_BTN = { x: 262, y: 202, w: 26, h: 26 } as const;
export const MORE_BTN_CY = 215;
/** 更多菜单(showContextMenu 样式,w216 行高 27) */
export const MORE_MENU = { x: 268, y: 228, w: 216, itemH: 27, pad: 4 } as const;
export const moreMenuItemCy = (i: number): number => MORE_MENU.y + MORE_MENU.pad + i * MORE_MENU.itemH + MORE_MENU.itemH / 2;
export const MORE_ITEMS = [
  { label: 'MCP', icon: 'plug' },
  { label: '数据库连接', icon: 'database' },
  { label: 'SSH跳转设置', icon: 'link' },
] as const;

/* ================= 确认对话框(confirmDialog,400 宽居中) ================= */
export const DLG_X = 760; // 400 宽 → 760..1160
export const AGENT_DLG = { h: 240, okText: '同意', danger: false } as const; // AI 申请切换到工作模式(正文 5 行)
export const YOLO_DLG = { h: 160, okText: '仍要开启', danger: true } as const; // 开启全自动模式(正文 1 行)
/** 对话框按钮锚(foot 右对齐:取消 / OK;btnY = 底边 28 上方中心) */
export function dlgButtons(h: number, okW: number): { cancel: { x: number; y: number }; ok: { x: number; y: number } } {
  const y = 600 + h / 2 - 28;
  const okCx = 1160 - 18 - okW / 2;
  const cancelCx = 1160 - 18 - okW - 8 - 27;
  return { cancel: { x: cancelCx, y }, ok: { x: okCx, y } };
}
export const AGENT_BTN = dlgButtons(AGENT_DLG.h, 54); // 同意(两字)
export const YOLO_BTN = dlgButtons(YOLO_DLG.h, 80); // 仍要开启(四字)
/** 对话框正文(行数组,行高 20) */
export const AGENT_MSG: string[] = [
  'AI 申请理由：直接修改项目文件 app-config.yml',
  '（retries: 3 → 5）',
  '',
  '同意后当前会话立即切换为工作模式（Agent），AI 将获得',
  '执行命令、修改文件等权限。',
];
export const YOLO_MSG: string[] = ['AI助手会获得所有权限并自动执行操作，请勿在生产环境中开启'];

/* ================= 数据库连接弹窗(600 宽,ServersPanel DbConnectionsModal) ================= */
export const DBM = { x: 660, w: 600 } as const;
/** 列表视图(空态)总高 204 → y 498..702;含条目 216 → y 492..708 */
export const DBM_LIST = { h: 204, y: 498 } as const;
export const DBM_LIST_FULL = { h: 216, y: 492 } as const;
/** 表单视图总高 600 → y 300..900;body 盒顶 = y+48,行距 68,输入中心 = y+48+行rel+39 */
export const DBM_FORM = { h: 600, y: 300 } as const;
/** 表单输入锚(双列:col1 中心 x816,col2 中心 x1104;命令区 label rel 290,box 高 142) */
export const DBM_IN = {
  kind: { x: 816, y: 405 },
  name: { x: 1104, y: 405 },
  host: { x: 816, y: 473 },
  port: { x: 1104, y: 473 },
  user: { x: 816, y: 541 },
  pwd: { x: 1104, y: 541 },
  database: { x: 960, y: 609 },
} as const;
/** 表单 Field 相对 body 盒顶的 top(body 盒顶 = 弹窗 y+48):r1..r4 行距 68,命令区 label rel 290 */
export const DBM_FIELD_REL = { r1: 18, r2: 86, r3: 154, r4: 222, cmds: 290 } as const;
/** 列表「新增连接」按钮(x 右缘 1242,宽 102)/ 表单「保存」(宽 54)/ 关闭 X */
export const DBM_ADD = (view: { y: number; h: number }): { x: number; y: number } => ({ x: 1191, y: view.y + view.h - 28 });
export const DBM_SAVE = { x: 1215, y: DBM_FORM.y + DBM_FORM.h - 28 } as const;
export const dbmClose = (view: { y: number }): { x: number; y: number } => ({ x: 1228, y: view.y + 24 });

/* ================= AI 数据库连接审批弹窗(AiDbApproval,540 宽) ================= */
export const DBA = { x: 690, w: 540, h: 700, y: 250 } as const; // y 250..950;body 盒顶 298
/** 字段 rel top(相对 body 盒顶):tip 18 / r1 48 / r2 116 / r3 184 / r4 252 / 密码 320 / 权限 388(box 142) */
export const DBA_FIELD_REL = { tip: 18, r1: 48, r2: 116, r3: 184, r4: 252, pwd: 320, perms: 388 } as const;
export const DBA_PWD = { x: 960, y: 657 } as const; // 密码输入框中心
export const DBA_BTN = { ok: { x: 1185, y: 922 }, no: { x: 1123, y: 922 } } as const;

/* ================= 聊天条目(高度计算,Wb4 与 script 共用) ================= */
export type ActionStatus = 'approving' | 'smart' | 'running' | 'succeeded';

/** 动作卡内容块(与 renderActionCard 顺序一致:head, intent/bold, cmd, meta/summary, reason, smart, buttons, result) */
export interface ActionSpec {
  name: string;
  icon: 'wrench' | 'database';
  intent?: string;
  bold?: string;
  cmd?: string;
  meta?: string;
  reason?: string;
  smart?: string;
  result?: string;
  /** approving 态按钮:批准+拒绝 / 审批 */
  btn?: 'approve' | 'audit';
}

export interface SnapSpec {
  label: string;
  lines: { segs: { t: string; mask?: boolean }[] }[];
}

export type ChatSpec =
  | { kind: 'user'; id: string; lines: string[]; chip?: string }
  | { kind: 'ai'; id: string; lines: string[]; tool?: string; typing?: boolean; snap?: SnapSpec; card?: { cmd: string } }
  | { kind: 'action'; id: string; status: ActionStatus; spec: ActionSpec };

export const snapH = (snap: SnapSpec): number => 30 + snap.lines.length * 16;

/** 条目高度(渲染块高与 Wb4 严格一致) */
export function chatItemH(item: ChatSpec): number {
  if (item.kind === 'user') return 16 + item.lines.length * 20;
  if (item.kind === 'ai') {
    const n = item.typing ? Math.max(1, item.lines.length) : item.lines.length;
    let h = 16 + n * 20;
    if (item.tool) h += 22;
    if (item.snap) h += snapH(item.snap) + 8;
    if (item.card) h += 66; // 卡 margin-top 6 + 卡高 60
    return h;
  }
  return actionH(item.status, item.spec);
}

/** 动作卡高度:margin 12 + padding 16 + head 20 + 各块 + 块间 gap 5 */
export function actionH(status: ActionStatus, s: ActionSpec): number {
  let blocks = 20;
  let n = 1;
  if (s.intent || s.bold) { blocks += 18; n++; }
  if (s.cmd) { blocks += 24; n++; }
  if (s.meta) { blocks += 18; n++; }
  if (s.reason) { blocks += 18; n++; }
  if (s.smart) { blocks += 18; n++; }
  if (status === 'approving' && s.btn) { blocks += 26; n++; }
  if (status === 'succeeded' && s.result) { blocks += 28; n++; }
  return 12 + 16 + blocks + (n - 1) * 5;
}

/** 动作卡按钮块中心(相对卡顶):按块顺序累加 */
export function actionBtnOff(status: ActionStatus, s: ActionSpec): number {
  let off = 8 + 20 + 5;
  if (s.intent || s.bold) off += 23;
  if (s.cmd) off += 29;
  if (s.meta) off += 23;
  if (s.reason) off += 23;
  if (s.smart) off += 23;
  return off + 13;
}

/** 布局后的条目(Wb4 渲染输入):y 为条目顶 */
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

/** 条目内命令卡中心(粘贴点击锚) */
export function cmdCardAnchor(item: ChatItem): { x: number; y: number } {
  const top = item.kind === 'ai' ? item.y + 16 + item.lines.length * 20 + 6 + 30 : item.y;
  return { x: CHAT.l + ITEM_W / 2, y: top };
}

/** 动作卡按钮锚(批准/拒绝/审批:btn.small 高 24,卡左 pad 10,批准宽 44) */
export function actionBtnAnchor(item: ChatItem, which: 'approve' | 'reject' | 'audit'): { x: number; y: number } {
  if (item.kind !== 'action') return { x: CHAT.l, y: item.y };
  const y = item.y + actionBtnOff(item.status, item.spec);
  if (which === 'approve') return { x: CHAT.l + 10 + 22, y };
  if (which === 'audit') return { x: CHAT.l + 10 + 23, y }; // 审批(两字,宽 46)
  return { x: CHAT.l + 10 + 44 + 6 + 22, y }; // 拒绝
}

/* ================= 演示数据 ================= */
export const DEMO = {
  projectName: 'deephaven-bigdata',
  serverName: 'deephaven-dev-01',
  serverHost: '10.21.36.8',
  serverId: 'srv-9d4k1f',
  dbName: 'orders',
  dbConnName: '计费库',
  dbUser: 'app_ro',
  dbPwd: 'Sup3r$ecret9',
  dbPwdDots: '••••••••••••',
  connId: 'dbc-9f3k2a',
  agentReason: 'AI 申请理由：直接修改项目文件 app-config.yml（retries: 3 → 5）\n同意后当前会话立即切换为工作模式（Agent），AI 将获得执行命令、修改文件等权限。',
} as const;

/** MASK 文案(redact.rs MASK) */
export const MASK = '***已脱敏***';

/** AI 可用命令(与 db.ts DB_COMMAND_GROUPS.mysql 一致) */
export const DB_READ_CMDS = ['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN'];
export const DB_WRITE_CMDS = ['INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'CREATE', 'ALTER', 'DROP', 'TRUNCATE'];

/* 终端回滚(底部为含密码的 mysql 会话;D1 特写取景) */
export type TermLine = { prompt?: boolean; cmd?: string; text?: string; green?: boolean };
export const TERM_BASE: TermLine[] = [
  { cmd: 'npm run build' },
  { text: '> deephaven-bigdata@1.2.0 build' },
  { text: '> tsc && vite build' },
  { text: 'vite v5.4.19 building for production...' },
  { text: '✓ 1284 modules transformed.' },
  { text: '✓ built in 4.21s' },
  { text: '' },
  { cmd: 'git log --oneline -3' },
  { text: 'a3f8c21 feat: 接入企业知识库检索' },
  { text: '91bc04e fix: 终端命令区块边界判定' },
  { text: 'e55d7a0 chore: 升级依赖' },
  { text: '' },
  { cmd: "mysql -h db.internal -u app -p'Sup3r$ecret9'" },
  { text: 'Welcome to the MySQL monitor.  Server version: 8.0.36' },
  { text: "Type 'help;' or '\\h' for help." },
  { text: 'mysql> SELECT COUNT(*) FROM orders;' },
  { text: '+----------+' },
  { text: '| COUNT(*) |' },
  { text: '+----------+' },
  { text: '|    15392 |' },
  { text: '+----------+' },
  { text: '1 row in set (0.03 sec)' },
  { text: 'mysql> exit' },
  { text: 'Bye' },
  { text: '' },
];
