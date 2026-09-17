/**
 * 视频十导演脚本:仪表盘与备忘录的帧级编排。
 * 剧情线(30fps,144s):
 *   A  0–1080   打开侧栏「仪表盘」→ 备忘录表格新增行记密码(失焦即存)→ 单元格复制 → 备忘文本随手记
 *   B  1080–1800 账号页云同步:配置同步规模高亮「仪表盘」→ Note 三文件端到端加密 → 换机恢复提示
 *   C  1800–2640 定制①:「定制仪表盘」弹窗 → AI 会话四拍工具条(read/write/reload/view)→ 性能表格卡
 *   D  2640–3420 定制②:再次定制流量图表 → AI 经数据库管道 → 折线图 draw-on + 峰值 tooltip
 *   E  3420–3960 设置-外观「菜单栏默认打开」→ 改选仪表盘 → 保存 → 重进工作台侧栏即仪表盘
 *   F  3960–4320 收尾拉远 + 三张特性卡
 * 指针/高亮全部走锚点实测(components/anchors.tsx):元素打 data-anchor,这里只编排帧号、
 * 锚点 id 与 canvas 兜底坐标(锚点未测量的冷启动首帧兜底,实测后即被替换)。
 */
import { interpolate } from 'remotion';
import { Stop } from '../anim';
import { Click } from '../components/Cursor';
import type { AnchorStop } from '../components/anchors';
import {
  ACT_DASH, AI_REQ1, AI_REQ2, AI1, AI2, CHART_PEAK, DASH_BTN, DLG_F, MEMO_L1, MEMO_L2, MEMO_ADD,
  MEMO_COL2_X, MEMO_COPY, NEW_K, NEW_V, SET, STAT_DASH, TOP_NAV, dropOptCy, memoRowY,
} from './layout';
import type { Wb10State } from './Wb10';

/* ============ 关键帧 ============ */
/* A 幕:备忘录 */
export const ACT_CLICK = 140;
export const DASH_AT = 152;
export const ADD_CLICK = 240;
export const ROW_AT = 246;
const TYPE0 = 280;
const CELL1_CLICK = 372;
const TYPE1 = 400;
export const BLUR1 = 588;
const FLASH_AT = 596;
export const COPY_CLICK = 720;
const CHIP_AT = 724;
const CHIP_END = 864;
export const TEXT_AT = 846;
const TYPE2 = 880;
/** 备忘文本总字数(两行 + 换行),3 帧/字 */
const TEXT_TOTAL = MEMO_L1.length + 1 + MEMO_L2.length;
const TYPE2_END = TYPE2 + TEXT_TOTAL * 3;
export const BLUR2 = Math.max(TYPE2_END + 14, 1066);
/* B 幕:云同步 */
export const ACCT_CLICK = 1090;
export const ACCT_AT = 1098;
export const HINT_AT = 1620;
/* C 幕:定制① */
export const WB2_CLICK = 1810;
export const WB2_AT = 1818;
export const SPARK1 = 1930;
export const DLG1_AT = 1942;
const TD1 = 1990;
export const SEND1 = 2200;
export const AI1_AT = 2220;
const U1_AT = 2224;
const T1_0 = 2264;
const T1_STEP = 36;
const SUM1 = 2412;
export const CARD1_AT = 2460;
export const AUTO_AT = 2470;
/* D 幕:定制② */
export const SPARK2 = 2720;
export const DLG2_AT = 2732;
const TD2 = 2770;
export const SEND2 = 2950;
const U2_AT = 2972;
const T2_0 = 3008;
const T2_STEP = 36;
const SUM2 = 3120;
export const CARD2_AT = 3170;
const DRAW0 = 3200;
const DRAW_LEN = 90;
export const TIP_AT = 3330;
/* E 幕:设置-外观 */
export const SET_CLICK = 3444;
export const SET_AT = 3452;
export const DROP_AT = 3588;
export const OPT_CLICK = 3660;
export const DROP_DONE = 3668;
export const SAVE_CLICK = 3740;
const TOAST2_END = 3884;
export const E2_AT = 3856;
/* F 幕 */
export const PULL_AT = 4040;
export const DURATION = 4320;

/* ============ 摄像机轨道(设计稿 1920×1200;canvas 1920×1080) ============ */
const CAM: readonly (readonly [number, number, number, number])[] = [
  [0, 0.8, 900, 610], [120, 0.8, 900, 610], [200, 1.5, 330, 360], [1080, 1.5, 330, 360],
  [1160, 0.95, 960, 618], [1240, 1.12, 1035, 430], [1800, 1.12, 1035, 430],
  [1860, 0.85, 960, 610], [2000, 1.3, 960, 570], [2210, 1.3, 960, 570],
  [2280, 1.0, 1230, 560], [2440, 1.0, 1230, 560],
  [2520, 1.45, 350, 400], [2640, 1.45, 350, 400],
  [2700, 1.0, 1230, 560], [2760, 1.3, 960, 570], [2950, 1.3, 960, 570],
  [3010, 1.0, 1230, 560], [3140, 1.0, 1230, 560],
  [3220, 1.4, 420, 760], [3410, 1.4, 420, 760],
  [3470, 1.0, 960, 600], [3560, 1.5, 560, 330], [3750, 0.95, 900, 600], [3830, 0.95, 900, 600],
  [3900, 0.85, 960, 610], [3960, 0.85, 960, 610], [PULL_AT, 0.62, 960, 600], [DURATION, 0.62, 960, 600],
];
export const CAM_S: readonly Stop[] = CAM.map(([f, s]) => ({ f, v: s }));
export const CAM_X: readonly Stop[] = CAM.map(([f, , x]) => ({ f, v: x }));
export const CAM_Y: readonly Stop[] = CAM.map(([f, , , y]) => ({ f, v: y }));

/** 设计稿窗口坐标 → canvas 兜底坐标(按某帧相机;仅供锚点未测量的冷启动首帧兜底) */
const wf = (wx: number, wy: number, s: number, cx: number, cy: number): { x: number; y: number } => ({
  x: wx * s + (960 - cx * s),
  y: wy * s + (540 - cy * s),
});

/* ============ 指针轨道(at 锚点实测优先,x/y 为冷启动兜底) ============ */
/** A 幕特写相机 (1.5,330,360) 的 park 兜底 */
const PARK_LOW_A = wf(700, 700, 1.5, 330, 360);
/** B 幕同步规模相机 (1.12,1035,430) */
const STAT_Z = wf(STAT_DASH.x + 150, STAT_DASH.y + 28, 1.12, 1035, 430);
/** C/D AI 同框相机 (1.0,1230,560) */
const PARK_AI_CD = wf(1300, 900, 1.0, 1230, 560);
/** F 收尾相机 (0.85,960,610) */
const PARK_EXIT_F = wf(1500, 1050, 0.85, 960, 610);
/** 峰值点特写相机 (1.4,420,760) */
const PEAK_Z = wf(CHART_PEAK.x, CHART_PEAK.y, 1.4, 420, 760);
/** 设置特写相机 (1.5,620,330) */
const SEL_Z = wf(SET.defSel.x + SET.defSel.w / 2, SET.defSel.y + SET.defSel.h / 2, 1.5, 560, 330);
const OPT_Z = wf(SET.defSel.x + SET.defSel.w / 2, dropOptCy(1), 1.5, 560, 330);
const SAVE_Z = wf(SET.save.x + SET.save.w / 2, SET.save.y + SET.save.h / 2, 1.5, 560, 330);

export const CUR_PATH: readonly AnchorStop[] = [
  { f: 0, x: 1500, y: 1050 },
  /* A 幕:活动栏仪表盘 → 备忘录加行 → 两格键入 → 失焦 → 复制 → 备忘文本 */
  { f: 96, at: 'act-dash', dx: 6, dy: 6, ...wf(ACT_DASH.x, ACT_DASH.y, 0.8, 900, 610) },
  { f: 134, at: 'act-dash', dx: 6, dy: 6, ...wf(ACT_DASH.x, ACT_DASH.y, 0.8, 900, 610) },
  { f: 170, at: 'park-low', ...PARK_LOW_A },
  { f: 210, at: 'memo-add', dx: 4, dy: 4, ...wf(MEMO_ADD.x, MEMO_ADD.y, 1.5, 330, 360) },
  { f: 236, at: 'memo-add', dx: 4, dy: 4, ...wf(MEMO_ADD.x, MEMO_ADD.y, 1.5, 330, 360) },
  { f: 268, at: 'memo-cell0', dx: 170, dy: 4, ...wf(107, memoRowY(2) + 14, 1.5, 330, 360) },
  { f: 356, at: 'memo-cell0', dx: 170, dy: 4, ...wf(107, memoRowY(2) + 14, 1.5, 330, 360) },
  { f: 380, at: 'memo-cell1', dx: 150, dy: 4, ...wf(MEMO_COL2_X + 74, memoRowY(2) + 14, 1.5, 330, 360) },
  { f: 540, at: 'memo-cell1', dx: 150, dy: 4, ...wf(MEMO_COL2_X + 74, memoRowY(2) + 14, 1.5, 330, 360) },
  { f: 580, at: 'park-low', ...PARK_LOW_A },
  { f: 610, at: 'park-low', ...PARK_LOW_A },
  { f: 690, at: 'memo-copy', dx: 3, dy: 3, ...wf(MEMO_COPY.x, MEMO_COPY.y, 1.5, 330, 360) },
  { f: 716, at: 'memo-copy', dx: 3, dy: 3, ...wf(MEMO_COPY.x, MEMO_COPY.y, 1.5, 330, 360) },
  { f: 780, at: 'park-low', ...PARK_LOW_A },
  { f: 846, at: 'memo-text', dx: 120, dy: 12, ...wf(198, 303, 1.5, 330, 360) },
  { f: 1048, at: 'memo-text', dx: 120, dy: 12, ...wf(198, 303, 1.5, 330, 360) },
  { f: 1062, at: 'park-low', ...PARK_LOW_A },
  /* B 幕:账号页云同步 */
  { f: 1082, at: 'tb-account', dx: 5, dy: 5, ...wf(TOP_NAV.account.x, TOP_NAV.account.y, 0.95, 960, 618) },
  { f: 1086, at: 'tb-account', dx: 5, dy: 5, ...wf(TOP_NAV.account.x, TOP_NAV.account.y, 0.95, 960, 618) },
  { f: 1214, at: 'stat-dashboard', dx: 120, dy: 2, ...STAT_Z },
  { f: 1760, at: 'stat-dashboard', dx: 120, dy: 2, ...STAT_Z },
  /* C 幕:定制① */
  { f: 1780, at: 'tb-project', dx: 4, dy: 4, ...wf(TOP_NAV.project.x, TOP_NAV.project.y, 0.85, 960, 610) },
  { f: 1806, at: 'tb-project', dx: 4, dy: 4, ...wf(TOP_NAV.project.x, TOP_NAV.project.y, 0.85, 960, 610) },
  { f: 1896, at: 'dash-sparkles', dx: 3, dy: 3, ...wf(DASH_BTN.sparkles.x, DASH_BTN.sparkles.y, 0.85, 960, 610) },
  { f: 1926, at: 'dash-sparkles', dx: 3, dy: 3, ...wf(DASH_BTN.sparkles.x, DASH_BTN.sparkles.y, 0.85, 960, 610) },
  { f: 1966, at: 'dlg-input', dx: 120, dy: 40, ...wf(960, 570, 1.3, 960, 570) },
  { f: 2130, at: 'dlg-input', dx: 120, dy: 40, ...wf(960, 570, 1.3, 960, 570) },
  { f: 2182, at: 'dlg-send', dx: 2, dy: 2, ...wf(DLG_F.btnSend.x + 52, DLG_F.btnSend.y + 15, 1.3, 960, 570) },
  { f: 2196, at: 'dlg-send', dx: 2, dy: 2, ...wf(DLG_F.btnSend.x + 52, DLG_F.btnSend.y + 15, 1.3, 960, 570) },
  { f: 2244, at: 'park-ai', ...PARK_AI_CD },
  { f: 2456, at: 'park-ai', ...PARK_AI_CD },
  { f: 2472, at: 'dash-auto', dx: 2, dy: 2, ...wf(DASH_BTN.auto.x, DASH_BTN.auto.y, 1.45, 350, 400) },
  { f: 2600, at: 'park-ai', ...PARK_AI_CD },
  /* D 幕:定制② */
  { f: 2660, at: 'park-ai', ...PARK_AI_CD },
  { f: 2684, at: 'dash-sparkles', dx: 3, dy: 3, ...wf(DASH_BTN.sparkles.x, DASH_BTN.sparkles.y, 1.0, 1230, 560) },
  { f: 2716, at: 'dash-sparkles', dx: 3, dy: 3, ...wf(DASH_BTN.sparkles.x, DASH_BTN.sparkles.y, 1.0, 1230, 560) },
  { f: 2756, at: 'dlg-input', dx: 120, dy: 40, ...wf(960, 570, 1.3, 960, 570) },
  { f: 2900, at: 'dlg-input', dx: 120, dy: 40, ...wf(960, 570, 1.3, 960, 570) },
  { f: 2936, at: 'dlg-send', dx: 2, dy: 2, ...wf(DLG_F.btnSend.x + 52, DLG_F.btnSend.y + 15, 1.3, 960, 570) },
  { f: 2946, at: 'dlg-send', dx: 2, dy: 2, ...wf(DLG_F.btnSend.x + 52, DLG_F.btnSend.y + 15, 1.3, 960, 570) },
  { f: 2996, at: 'park-ai', ...PARK_AI_CD },
  { f: 3264, at: 'park-ai', ...PARK_AI_CD },
  { f: 3278, at: 'chart-peak', dx: 6, dy: -4, ...PEAK_Z },
  { f: 3400, at: 'chart-peak', dx: 6, dy: -4, ...PEAK_Z },
  /* E 幕:设置-外观 */
  { f: 3420, at: 'park-ai', ...PARK_AI_CD },
  { f: 3438, at: 'tb-settings', dx: 4, dy: 4, ...wf(TOP_NAV.settings.x, TOP_NAV.settings.y, 1.0, 960, 600) },
  { f: 3556, at: 'set-default-select', dx: 60, dy: 3, ...SEL_Z },
  { f: 3576, at: 'set-default-select', dx: 60, dy: 3, ...SEL_Z },
  { f: 3640, at: 'set-opt-dashboard', dx: 40, dy: 2, ...OPT_Z },
  { f: 3656, at: 'set-opt-dashboard', dx: 40, dy: 2, ...OPT_Z },
  { f: 3712, at: 'set-save', dx: 2, dy: 2, ...SAVE_Z },
  { f: 3736, at: 'set-save', dx: 2, dy: 2, ...SAVE_Z },
  { f: 3800, at: 'park-exit', ...PARK_EXIT_F },
];

/** 指针淡入淡出 */
export const CURSOR_OPACITY: readonly Stop[] = [
  { f: 0, v: 0 }, { f: 50, v: 0 }, { f: 62, v: 1 }, { f: 3846, v: 1 }, { f: 3880, v: 0 },
];

/* ============ 点击(涟漪;anchor 命中即实测中心) ============ */
export const CLICKS: readonly Click[] = [
  { f: ACT_CLICK, x: wf(24, 66, 0.8, 900, 610).x, y: wf(24, 66, 0.8, 900, 610).y, target: 'browse', anchor: 'act-dash' },
  { f: ADD_CLICK, x: 953, y: 233, target: 'browse', anchor: 'memo-add' },
  { f: BLUR1, x: PARK_LOW_A.x, y: PARK_LOW_A.y, target: 'browse', anchor: 'park-low' },
  { f: COPY_CLICK, x: 911, y: 276, target: 'browse', anchor: 'memo-copy' },
  { f: 1060, x: PARK_LOW_A.x, y: PARK_LOW_A.y, target: 'browse', anchor: 'park-low' },
  { f: ACCT_CLICK, x: 1698, y: 20, target: 'browse', anchor: 'tb-account' },
  { f: WB2_CLICK, x: 1517, y: 38, target: 'browse', anchor: 'tb-project' },
  { f: SPARK1, x: 379, y: 99, target: 'browse', anchor: 'dash-sparkles' },
  { f: SEND1, x: 1132, y: 726, target: 'confirm', anchor: 'dlg-send' },
  { f: SPARK2, x: 6, y: 71, target: 'browse', anchor: 'dash-sparkles' },
  { f: SEND2, x: 1132, y: 726, target: 'confirm', anchor: 'dlg-send' },
  { f: SET_CLICK, x: 1675, y: -40, target: 'browse', anchor: 'tb-settings' },
  { f: DROP_AT - 8, x: SEL_Z.x, y: SEL_Z.y, target: 'browse', anchor: 'set-default-select' },
  { f: OPT_CLICK, x: OPT_Z.x, y: OPT_Z.y, target: 'browse', anchor: 'set-opt-dashboard' },
  { f: SAVE_CLICK, x: SAVE_Z.x, y: SAVE_Z.y, target: 'save', anchor: 'set-save' },
];

/* ============ 焦点高亮环(锚点 target 模式) ============ */
export const HIGHLIGHTS: readonly { target: string; pad: number; r: number; from: number; to: number }[] = [
  { target: 'act-dash', pad: 5, r: 8, from: ACT_CLICK - 24, to: ACT_CLICK - 2 },
  { target: 'memo-add', pad: 4, r: 5, from: ADD_CLICK - 24, to: ADD_CLICK - 2 },
  { target: 'memo-cell0', pad: 3, r: 4, from: ROW_AT + 18, to: ROW_AT + 44 },
  { target: 'memo-copy', pad: 5, r: 5, from: COPY_CLICK - 24, to: COPY_CLICK - 2 },
  { target: 'memo-text', pad: 4, r: 5, from: TEXT_AT, to: TEXT_AT + 26 },
  { target: 'stat-dashboard', pad: 6, r: 8, from: 1240, to: 1560 },
  { target: 'dash-sparkles', pad: 4, r: 6, from: SPARK1 - 24, to: SPARK1 - 2 },
  { target: 'dlg-send', pad: 5, r: 5, from: SEND1 - 24, to: SEND1 - 2 },
  { target: 'dash-auto', pad: 4, r: 6, from: AUTO_AT - 4, to: AUTO_AT + 26 },
  { target: 'perf-card', pad: 6, r: 8, from: CARD1_AT + 60, to: 2626 },
  { target: 'dash-sparkles', pad: 4, r: 6, from: SPARK2 - 24, to: SPARK2 - 2 },
  { target: 'dlg-send', pad: 5, r: 5, from: SEND2 - 24, to: SEND2 - 2 },
  { target: 'chart-card', pad: 6, r: 8, from: CARD2_AT + 56, to: 3400 },
  { target: 'set-default-select', pad: 5, r: 6, from: 3556, to: DROP_AT - 10 },
  { target: 'set-opt-dashboard', pad: 3, r: 5, from: OPT_CLICK - 24, to: OPT_CLICK - 2 },
  { target: 'set-save', pad: 5, r: 5, from: SAVE_CLICK - 24, to: SAVE_CLICK - 2 },
];

/* ============ 字幕 ============ */
export const CAPTIONS = [
  { from: 4, to: 132, text: '每个项目都有一块自己的仪表盘——最上面，是随手记的备忘录' },
  { from: 246, to: 390, text: '服务器密码、数据库地址、常用入口——记在表格里' },
  { from: 402, to: 580, text: '失焦即保存，不用找保存按钮' },
  { from: 700, to: 850, text: '点一下复制，直接粘到终端里用' },
  { from: 884, to: 1068, text: '零碎但重要的信息，随手写在备忘里' },
  { from: 1100, to: 1290, text: '备忘录跟着仪表盘，一起进了云同步' },
  { from: 1310, to: 1600, text: '密码在云端也是密文——钥匙只在你手里' },
  { from: 1615, to: 1790, text: '换台电脑登录，备忘录原样回来' },
  { from: 1852, to: 1985, text: '想要更多？让 AI 来定制' },
  { from: 1995, to: 2190, text: '用一句话描述你想看到的内容' },
  { from: 2212, to: 2445, text: 'AI 读懂技能、改脚本、自动调试验证' },
  { from: 2470, to: 2630, text: '面板就位——每 30 秒自动采集最新数据' },
  { from: 2655, to: 2830, text: '再来一个——这次数据在数据库里' },
  { from: 2870, to: 3130, text: '数据库直连走 SDK 管道：凭据代管、只读白名单' },
  { from: 3175, to: 3410, text: '图表组件直接连库取数——你只管提需求' },
  { from: 3455, to: 3620, text: '想让工作台第一眼就是仪表盘？设置里改一下' },
  { from: 3660, to: 3940, text: '下次进来，最重要的信息已经在眼前' },
  { from: 3970, to: 4115, text: '一块仪表盘，装下项目最关键的信息' },
  { from: 4140, to: 4305, text: '仪表盘与备忘录——开箱即用，越用越顺手' },
];

/* ============ 教学叠加层(窗口坐标,渲染在相机容器内) ============ */
export interface NoteSpec10 {
  from: number;
  to: number;
  x: number;
  y: number;
  w: number;
  kind: 'info' | 'alert';
  title: string;
  body: string;
}
export const NOTES: readonly NoteSpec10[] = [
  {
    from: 1310, to: 1610, x: 1150, y: 560, w: 440, kind: 'info',
    title: '三个文件，加密上云',
    body: '仪表盘同步 = dashboard.py（定制脚本）、memo.md（备忘文本）、table.json（备忘表格）三个文件；与笔记同一加密通道——内容经凭据保险箱钥匙端到端加密后才上传，服务端只存密文。',
  },
  {
    from: 2870, to: 3130, x: 1080, y: 250, w: 460, kind: 'info',
    title: '数据库管道',
    body: '图表数据来自 SDK 数据库管道：db.connections 列出服务器上启用中的连接（MySQL / PostgreSQL / ClickHouse / Redis），db.query 执行单条命令——连接凭据由系统钥匙串代管、命令白名单默认只读，脚本拿不到任何密码。',
  },
];

/* ============ 工具 ============ */
const inSpan = (frame: number, a: number, b: number): boolean => frame >= a && frame < b;
const fade = (frame: number, a: number, b: number): number =>
  interpolate(frame, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
const bell = (frame: number, a: number, len: number): number =>
  inSpan(frame, a, a + len) ? Math.sin(((frame - a) / len) * Math.PI) : 0;
const dlgFade = (frame: number, at: number, ok: number): number =>
  interpolate(frame, [at + 8, at + 18, ok + 2, ok + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
const typed = (frame: number, at: number, fps: number, text: string): string =>
  text.slice(0, Math.max(0, Math.min(text.length, Math.floor((frame - at) / fps) + 1)));

/* ============ 状态推导 ============ */
export function wbAt(frame: number): Wb10State {
  const acctT = fade(frame, ACCT_AT, ACCT_AT + 14) * (1 - fade(frame, WB2_AT, WB2_AT + 14));
  const setT = fade(frame, SET_AT, SET_AT + 14) * (1 - fade(frame, E2_AT, E2_AT + 20));

  const hover = (() => {
    if (inSpan(frame, ACT_CLICK - 24, ACT_CLICK)) return 'actDash' as const;
    if (inSpan(frame, ADD_CLICK - 24, ADD_CLICK)) return 'memoAdd' as const;
    if (inSpan(frame, COPY_CLICK - 24, COPY_CLICK)) return 'memoCopy' as const;
    if (inSpan(frame, AUTO_AT - 20, AUTO_AT + 6)) return 'autoBtn' as const;
    if (inSpan(frame, SPARK1 - 24, SPARK1) || inSpan(frame, SPARK2 - 24, SPARK2)) return 'dashSparkles' as const;
    if (inSpan(frame, SEND1 - 24, SEND1) || inSpan(frame, SEND2 - 24, SEND2)) return 'dlgSend' as const;
    if (inSpan(frame, OPT_CLICK - 24, OPT_CLICK)) return 'defOpt' as const;
    if (inSpan(frame, SAVE_CLICK - 24, SAVE_CLICK)) return 'setSave' as const;
    return null;
  })();
  const press = (() => {
    if (inSpan(frame, ACT_CLICK, ACT_CLICK + 6)) return 'actDash' as const;
    if (inSpan(frame, ADD_CLICK, ADD_CLICK + 6)) return 'memoAdd' as const;
    if (inSpan(frame, COPY_CLICK, COPY_CLICK + 6)) return 'memoCopy' as const;
    if (inSpan(frame, SPARK1, SPARK1 + 6) || inSpan(frame, SPARK2, SPARK2 + 6)) return 'dashSparkles' as const;
    if (inSpan(frame, SEND1, SEND1 + 6) || inSpan(frame, SEND2, SEND2 + 6)) return 'dlgSend' as const;
    if (inSpan(frame, OPT_CLICK, OPT_CLICK + 6)) return 'defOpt' as const;
    if (inSpan(frame, SAVE_CLICK, SAVE_CLICK + 6)) return 'setSave' as const;
    return null;
  })();

  const dlg: Wb10State['dlg'] =
    inSpan(frame, DLG1_AT + 8, SEND1 + 8) ? 1 : inSpan(frame, DLG2_AT + 8, SEND2 + 8) ? 2 : 0;

  return {
    pageT: { acct: acctT, set: setT },
    dashT: fade(frame, DASH_AT, DASH_AT + 14),
    rowAdded: frame >= ROW_AT,
    cell0: typed(frame, TYPE0, 14, NEW_K),
    cell1: typed(frame, TYPE1, 8, NEW_V),
    rowFlash: bell(frame, FLASH_AT, 50),
    memoText: (() => {
      const n = Math.max(0, Math.min(TEXT_TOTAL, Math.floor((frame - TYPE2) / 3) + 1));
      const all = `${MEMO_L1}\n${MEMO_L2}`;
      return all.slice(0, n);
    })(),
    memoFlash: bell(frame, BLUR2 + 8, 44),
    copyChip: fade(frame, CHIP_AT, CHIP_AT + 12) * (1 - fade(frame, CHIP_END - 24, CHIP_END)),
    perfT: fade(frame, CARD1_AT, CARD1_AT + 40),
    autoReady: frame >= AUTO_AT,
    chartT: fade(frame, CARD2_AT, CARD2_AT + 40),
    chartDraw: Math.max(0, Math.min(1, (frame - DRAW0) / DRAW_LEN)),
    tooltip: inSpan(frame, TIP_AT, 3420),
    dlg,
    dlgT: dlg === 1 ? dlgFade(frame, DLG1_AT, SEND1) : dlg === 2 ? dlgFade(frame, DLG2_AT, SEND2) : 0,
    dlgText: dlg === 1 ? typed(frame, TD1, 3.5, AI_REQ1) : dlg === 2 ? typed(frame, TD2, 3.5, AI_REQ2) : '',
    aiSess: frame >= AI1_AT,
    user1T: fade(frame, U1_AT, U1_AT + 12),
    tools1: frame < T1_0 ? 0 : Math.min(4, Math.floor((frame - T1_0) / T1_STEP) + 1),
    sum1T: fade(frame, SUM1, SUM1 + 12),
    user2T: fade(frame, U2_AT, U2_AT + 12),
    tools2: frame < T2_0 ? 0 : Math.min(3, Math.floor((frame - T2_0) / T2_STEP) + 1),
    sum2T: fade(frame, SUM2, SUM2 + 12),
    hintT: fade(frame, HINT_AT, HINT_AT + 14),
    dropOpen: inSpan(frame, DROP_AT, OPT_CLICK + 8),
    defOptHover: frame >= OPT_CLICK - 24,
    valDash: frame >= OPT_CLICK + 6,
    savedToast: inSpan(frame, SAVE_CLICK + 4, TOAST2_END),
    hover,
    press,
  };
}

/** 收尾定稿状态(F 幕特性卡背景) */
export function finaleWb(): Wb10State {
  const base = wbAt(DURATION - 1);
  return {
    ...base,
    pageT: { acct: 0, set: 0 },
    dashT: 1,
    rowFlash: 0,
    memoFlash: 0,
    copyChip: 0,
    perfT: 1,
    chartT: 1,
    chartDraw: 1,
    tooltip: false,
    dlg: 0,
    dlgT: 0,
    aiSess: true,
    user1T: 1,
    tools1: 4,
    sum1T: 1,
    user2T: 1,
    tools2: 3,
    sum2T: 1,
    hintT: 1,
    dropOpen: false,
    savedToast: false,
    hover: null,
    press: null,
  };
}

/* 引用防抖(AI1/AI2 几何供 Wb10 内联使用) */
void AI1;
void AI2;
