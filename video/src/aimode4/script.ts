/**
 * 视频四导演脚本:全部运镜/指针/点击/字幕/场景状态的帧级编排。
 * 状态推导为纯函数(wbAt),组件只负责渲染;锚点坐标全部来自 ./layout.ts。
 *
 * 剧情线(30fps,约 143s):
 *   O  0–130     开场全景
 *   A  130–1090  仅建议模式:命令建议卡 → AI 申请切换工作模式(确认框) → 编辑文件审批
 *   B  1090–1590 工作模式审批:智能审批自动放行 / 危险操作转人工
 *   C  1590–2130 全自动模式:危险确认框 → 无审批直执行 → 切回工作
 *   D  2130–2740 敏感信息脱敏:终端密码 → AI 视角已脱敏 → 引出数据库管道
 *   E  2740–3500 数据库管道配置:更多菜单 → 连接弹窗(空态/表单/列表)
 *   F  3500–4130 AI 申请数据库连接:审批对话框输密码 → db_query 只读查询
 *   G  4130–4300 收尾全景
 */
import { interpolate } from 'remotion';
import { Stop } from '../anim';
import { Click } from '../components/Cursor';
import {
  ActionSpec, ChatSpec, DEMO, MASK, MODE_MENU, MODE_SEL, AI_INPUT, DBM_ADD, DBM_IN, DBM_LIST,
  DBA_BTN, DBA_PWD, MORE_BTN, actionBtnAnchor, cmdCardAnchor, modeMenuItemCy, moreMenuItemCy, stackChat,
} from './layout';
import { Wb4State } from './Wb4';

/* ============ 关键帧 ============ */
/** 场景 A */
const A_MENU1 = 196; // 打开模式下拉
const A_MENU1_CLOSE = 262;
const A_Q1_CLICK = 340;
const A_Q1_ENTER = 412;
const A_CARD_CLICK = 500;
const A_Q2_CLICK = 656;
const A_Q2_ENTER = 734;
const A_DLG = 796; // AI 申请切换到工作模式(确认框)
const A_DLG_OK = 856;
const A_EDIT_APPROVE = 1000;
/** 场景 B */
const B_Q3_CLICK = 1230;
const B_Q3_ENTER = 1286;
const B_DEL_APPROVE = 1526;
/** 场景 C */
const C_MENU = 1620;
const C_YOLO_PICK = 1688;
const C_DLG = 1696;
const C_DLG_OK = 1790;
const C_Q5_CLICK = 1868;
const C_Q5_ENTER = 1928;
const C_MENU2 = 2028;
const C_AGENT_PICK = 2066;
/** 场景 D */
const D_Q6_CLICK = 2326;
const D_Q6_ENTER = 2406;
/** 场景 E */
const E_ACT = 2756; // 活动栏 → 服务器
const E_CARD = 2876; // 展开服务器卡
const E_MORE = 2916; // 更多菜单
const E_DB = 2986; // 数据库连接 → 弹窗(空态)
const E_ADD = 3064; // 新增连接 → 表单
const E_SAVE = 3352;
const E_CLOSE = 3452;
/** 场景 F */
const F_Q7_CLICK = 3526;
const F_Q7_ENTER = 3570;
const F_AUDIT = 3800; // 审批 → AiDbApproval 对话框
const F_PWD_OK = 3910;
export const DURATION = 4300;

/* ============ 摄像机轨道 ============ */
export const CAM_S: readonly Stop[] = [
  { f: 0, v: 0.75 }, { f: 130, v: 0.75 }, { f: 182, v: 1.55 }, { f: 322, v: 1.55 }, { f: 342, v: 1.5 },
  { f: 512, v: 1.5 }, { f: 532, v: 1.3 }, { f: 612, v: 1.3 }, { f: 648, v: 1.5 }, { f: 800, v: 1.5 },
  { f: 818, v: 1.15 }, { f: 852, v: 1.15 }, { f: 884, v: 1.5 }, { f: 1096, v: 1.5 }, { f: 1112, v: 1.2 },
  { f: 1192, v: 1.2 }, { f: 1224, v: 1.5 }, { f: 1694, v: 1.5 }, { f: 1712, v: 1.15 }, { f: 1782, v: 1.15 },
  { f: 1812, v: 1.5 }, { f: 2126, v: 1.5 }, { f: 2182, v: 1.3 }, { f: 2284, v: 1.3 }, { f: 2320, v: 1.45 },
  { f: 2746, v: 1.45 }, { f: 2802, v: 1.35 }, { f: 2976, v: 1.35 }, { f: 3006, v: 1.0 }, { f: 3450, v: 1.0 },
  { f: 3506, v: 1.45 }, { f: 3796, v: 1.45 }, { f: 3830, v: 0.95 }, { f: 4120, v: 0.95 }, { f: 4182, v: 0.78 },
  { f: 4300, v: 0.78 },
];
export const CAM_X: readonly Stop[] = [
  { f: 0, v: 960 }, { f: 130, v: 960 }, { f: 182, v: 1700 }, { f: 322, v: 1700 }, { f: 342, v: 1700 },
  { f: 512, v: 1700 }, { f: 532, v: 940 }, { f: 612, v: 940 }, { f: 648, v: 1700 }, { f: 800, v: 1700 },
  { f: 818, v: 960 }, { f: 852, v: 960 }, { f: 884, v: 1700 }, { f: 1096, v: 1700 }, { f: 1112, v: 1250 },
  { f: 1192, v: 1250 }, { f: 1224, v: 1700 }, { f: 1694, v: 1700 }, { f: 1712, v: 960 }, { f: 1782, v: 960 },
  { f: 1812, v: 1700 }, { f: 2126, v: 1700 }, { f: 2182, v: 900 }, { f: 2284, v: 900 }, { f: 2320, v: 1700 },
  { f: 2746, v: 1700 }, { f: 2802, v: 400 }, { f: 2976, v: 400 }, { f: 3006, v: 960 }, { f: 3450, v: 960 },
  { f: 3506, v: 1700 }, { f: 3796, v: 1700 }, { f: 3830, v: 960 }, { f: 4120, v: 960 }, { f: 4182, v: 960 },
  { f: 4300, v: 960 },
];
export const CAM_Y: readonly Stop[] = [
  { f: 0, v: 600 }, { f: 130, v: 600 }, { f: 182, v: 1051 }, { f: 322, v: 1051 }, { f: 342, v: 1000 },
  { f: 512, v: 1000 }, { f: 532, v: 1060 }, { f: 612, v: 1060 }, { f: 648, v: 1000 }, { f: 800, v: 1000 },
  { f: 818, v: 570 }, { f: 852, v: 570 }, { f: 884, v: 1000 }, { f: 1096, v: 1000 }, { f: 1112, v: 760 },
  { f: 1192, v: 760 }, { f: 1224, v: 1000 }, { f: 1694, v: 1000 }, { f: 1712, v: 570 }, { f: 1782, v: 570 },
  { f: 1812, v: 1000 }, { f: 2126, v: 1000 }, { f: 2182, v: 1060 }, { f: 2284, v: 1060 }, { f: 2320, v: 980 },
  { f: 2746, v: 980 }, { f: 2802, v: 420 }, { f: 2976, v: 420 }, { f: 3006, v: 600 }, { f: 3240, v: 650 }, { f: 3450, v: 650 },
  { f: 3506, v: 980 }, { f: 3796, v: 980 }, { f: 3830, v: 600 }, { f: 4120, v: 600 }, { f: 4182, v: 600 },
  { f: 4300, v: 600 },
];

/* ============ 指针轨道(点位表 → x/y 双轨) ============ */
const CURVE: readonly (readonly [number, number, number])[] = [
  [60, 1450, 900],
  [148, MODE_SEL.x + MODE_SEL.w / 2, MODE_SEL.y + MODE_SEL.h / 2],
  [206, MODE_SEL.x + 37, MODE_SEL.y + 11],
  [216, MODE_MENU.x + 59, modeMenuItemCy(0)],
  [246, MODE_MENU.x + 59, modeMenuItemCy(0)],
  [258, MODE_SEL.x + 37, MODE_SEL.y + 11],
  [330, MODE_SEL.x + 37, MODE_SEL.y + 11],
  [336, AI_INPUT.x, AI_INPUT.y],
  [424, AI_INPUT.x, AI_INPUT.y],
  [436, 1850, 960],
  [486, 1738, 986],
  [522, 1738, 986],
  [556, 900, 1100],
  [626, 900, 1100],
  [648, AI_INPUT.x, AI_INPUT.y],
  [744, AI_INPUT.x, AI_INPUT.y],
  [758, 1850, 960],
  [840, 1115, 692],
  [878, 1115, 692],
  [910, 1850, 960],
  [986, 1622, 983],
  [1022, 1622, 983],
  [1090, 1850, 960],
  [1222, AI_INPUT.x, AI_INPUT.y],
  [1296, AI_INPUT.x, AI_INPUT.y],
  [1416, AI_INPUT.x, AI_INPUT.y],
  [1478, AI_INPUT.x, AI_INPUT.y],
  [1514, 1622, 983],
  [1548, 1622, 983],
  [1612, 1850, 960],
  [1616, MODE_SEL.x + 37, MODE_SEL.y + 11],
  [1638, MODE_SEL.x + 37, MODE_SEL.y + 11],
  [1650, MODE_MENU.x + 59, modeMenuItemCy(2)],
  [1684, MODE_MENU.x + 59, modeMenuItemCy(2)],
  [1706, 1102, 652],
  [1786, 1102, 652],
  [1856, AI_INPUT.x, AI_INPUT.y],
  [1938, AI_INPUT.x, AI_INPUT.y],
  [1952, 1850, 960],
  [2016, MODE_SEL.x + 37, MODE_SEL.y + 11],
  [2046, MODE_MENU.x + 59, modeMenuItemCy(1)],
  [2070, MODE_MENU.x + 59, modeMenuItemCy(1)],
  [2100, 1850, 960],
  [2240, 900, 1060],
  [2300, 900, 1060],
  [2318, AI_INPUT.x, AI_INPUT.y],
  [2410, AI_INPUT.x, AI_INPUT.y],
  [2430, 1850, 960],
  [2746, 24, 108],
  [2780, 24, 108],
  [2862, 150, 157],
  [2896, 150, 157],
  [2908, MORE_BTN.x + 13, MORE_BTN.y + 13],
  [2934, MORE_BTN.x + 13, MORE_BTN.y + 13],
  [2946, 376, moreMenuItemCy(1)],
  [3008, 376, moreMenuItemCy(1)],
  [3056, DBM_ADD(DBM_LIST).x, DBM_ADD(DBM_LIST).y],
  [3084, DBM_ADD(DBM_LIST).x, DBM_ADD(DBM_LIST).y],
  [3104, DBM_IN.name.x, DBM_IN.name.y],
  [3150, DBM_IN.name.x, DBM_IN.name.y],
  [3156, DBM_IN.host.x, DBM_IN.host.y],
  [3200, DBM_IN.host.x, DBM_IN.host.y],
  [3208, DBM_IN.user.x, DBM_IN.user.y],
  [3250, DBM_IN.user.x, DBM_IN.user.y],
  [3256, DBM_IN.pwd.x, DBM_IN.pwd.y],
  [3300, DBM_IN.pwd.x, DBM_IN.pwd.y],
  [3302, DBM_IN.database.x, DBM_IN.database.y],
  [3344, DBM_IN.database.x, DBM_IN.database.y],
  [3346, 1215, 872],
  [3400, 1215, 872],
  [3440, 1228, 522],
  [3476, 1228, 516],
  [3510, 1850, 960],
  [3522, AI_INPUT.x, AI_INPUT.y],
  [3572, AI_INPUT.x, AI_INPUT.y],
  [3590, 1850, 960],
  [3788, 1623, 983],
  [3822, 1623, 983],
  [3848, DBA_PWD.x, DBA_PWD.y],
  [3900, DBA_PWD.x, DBA_PWD.y],
  [3904, DBA_BTN.ok.x, DBA_BTN.ok.y],
  [3950, DBA_BTN.ok.x, DBA_BTN.ok.y],
  [4100, 1500, 940],
  [4290, 1500, 940],
];

export const CUR_X: readonly Stop[] = CURVE.map(([f, x]) => ({ f, v: x }));
export const CUR_Y: readonly Stop[] = CURVE.map(([f, , y]) => ({ f, v: y }));

/* ============ 点击(涟漪) ============ */
export const CLICKS: readonly Click[] = [
  { f: A_MENU1, x: MODE_SEL.x + 37, y: MODE_SEL.y + 11, target: 'row' },
  { f: A_MENU1_CLOSE, x: MODE_SEL.x + 37, y: MODE_SEL.y + 11, target: 'row' },
  { f: A_Q1_CLICK, x: AI_INPUT.x, y: AI_INPUT.y, target: 'input' },
  { f: A_CARD_CLICK, x: 1738, y: 986, target: 'row' },
  { f: A_Q2_CLICK, x: AI_INPUT.x, y: AI_INPUT.y, target: 'input' },
  { f: A_DLG_OK, x: 1115, y: 692, target: 'confirm' },
  { f: A_EDIT_APPROVE, x: 1622, y: 983, target: 'confirm' },
  { f: B_Q3_CLICK, x: AI_INPUT.x, y: AI_INPUT.y, target: 'input' },
  { f: 1424, x: AI_INPUT.x, y: AI_INPUT.y, target: 'input' },
  { f: B_DEL_APPROVE, x: 1622, y: 983, target: 'confirm' },
  { f: C_MENU, x: MODE_SEL.x + 37, y: MODE_SEL.y + 11, target: 'row' },
  { f: C_YOLO_PICK, x: MODE_MENU.x + 59, y: modeMenuItemCy(2), target: 'row' },
  { f: C_DLG_OK, x: 1102, y: 652, target: 'confirm' },
  { f: C_Q5_CLICK, x: AI_INPUT.x, y: AI_INPUT.y, target: 'input' },
  { f: C_MENU2, x: MODE_SEL.x + 37, y: MODE_SEL.y + 11, target: 'row' },
  { f: C_AGENT_PICK, x: MODE_MENU.x + 59, y: modeMenuItemCy(1), target: 'row' },
  { f: D_Q6_CLICK, x: AI_INPUT.x, y: AI_INPUT.y, target: 'input' },
  { f: E_ACT, x: 24, y: 108, target: 'browse' },
  { f: E_CARD, x: 150, y: 157, target: 'row' },
  { f: E_MORE, x: MORE_BTN.x + 13, y: MORE_BTN.y + 13, target: 'browse' },
  { f: E_DB, x: 376, y: moreMenuItemCy(1), target: 'row' },
  { f: E_ADD, x: DBM_ADD(DBM_LIST).x, y: DBM_ADD(DBM_LIST).y, target: 'confirm' },
  { f: 3110, x: DBM_IN.name.x, y: DBM_IN.name.y, target: 'input' },
  { f: 3160, x: DBM_IN.host.x, y: DBM_IN.host.y, target: 'input' },
  { f: 3216, x: DBM_IN.user.x, y: DBM_IN.user.y, target: 'input' },
  { f: 3262, x: DBM_IN.pwd.x, y: DBM_IN.pwd.y, target: 'input' },
  { f: 3308, x: DBM_IN.database.x, y: DBM_IN.database.y, target: 'input' },
  { f: E_SAVE, x: 1215, y: 872, target: 'confirm' },
  { f: E_CLOSE, x: 1228, y: 522, target: 'browse' },
  { f: F_Q7_CLICK, x: AI_INPUT.x, y: AI_INPUT.y, target: 'input' },
  { f: F_AUDIT, x: 1623, y: 983, target: 'confirm' },
  { f: 3856, x: DBA_PWD.x, y: DBA_PWD.y, target: 'input' },
  { f: F_PWD_OK, x: DBA_BTN.ok.x, y: DBA_BTN.ok.y, target: 'confirm' },
];

/* ============ 字幕 ============ */
export const CAPTIONS4 = [
  { from: 4, to: 100, text: 'AI 助手的三种工作模式与数据库管道' },
  { from: 150, to: 256, text: '三种模式：仅建议 · 工作 · 全自动' },
  { from: 268, to: 336, text: '模式一：仅建议 —— 只提供建议，或在 .agent 专属工作区写入' },
  { from: 436, to: 520, text: 'AI 以建议卡片回复：命令给你，执行权在你' },
  { from: 528, to: 624, text: '点击卡片粘贴到终端，是否执行由你决定' },
  { from: 760, to: 880, text: '仅建议模式下，AI 可主动申请切换到工作模式' },
  { from: 900, to: 1030, text: '已切换为工作模式 —— AI 继续执行，工具调用需审批' },
  { from: 1100, to: 1200, text: '审批分两种：智能审批 / 全部审批（设置中切换）' },
  { from: 1300, to: 1396, text: '智能审批：常规读写、构建、查询自动放行' },
  { from: 1500, to: 1590, text: '危险操作被拦截，转人工确认' },
  { from: 1600, to: 1692, text: '模式三：全自动 —— 所有工具直接执行，无需审批' },
  { from: 1740, to: 1856, text: '有一定风险，不建议在生产环境开启' },
  { from: 1950, to: 2036, text: '无人值守自动执行 —— 请谨慎使用' },
  { from: 2044, to: 2130, text: '演示完毕，切回工作模式' },
  { from: 2150, to: 2286, text: '无论哪种模式：密码等敏感信息一律脱敏' },
  { from: 2320, to: 2426, text: '试着让 AI 把终端里的数据库密码拿出来连库' },
  { from: 2440, to: 2560, text: 'AI 拿到的密码是 ***已脱敏***，无法自主连接数据库' },
  { from: 2626, to: 2740, text: '替代方案：数据库管道 —— 受控的数据库访问通道' },
  { from: 2760, to: 2870, text: '数据库管道按服务器配置：更多 → 数据库连接' },
  { from: 3010, to: 3096, text: '密码保存在系统凭据库，AI 永远不可见' },
  { from: 3110, to: 3300, text: '类型选 MySQL，逐项填写连接信息' },
  { from: 3340, to: 3446, text: '只读命令可直接执行；写命令勾选后需审批' },
  { from: 3610, to: 3790, text: 'AI 需要连库时，会提交连接申请，由你输入密码' },
  { from: 3840, to: 3940, text: '连接信息由 AI 填好、只读；密码只能由你输入' },
  { from: 3990, to: 4100, text: '管道之内，只跑白名单里的只读查询' },
  { from: 4180, to: 4290, text: '三种模式层层把关；密码不出本机，查询走在管道里' },
];

/* ============ 教学叠加层 ============ */
export interface Note4 {
  from: number;
  to: number;
  x: number;
  y: number;
  w: number;
  kind: 'info' | 'alert';
  title: string;
  body: string;
}
export const NOTES4: readonly Note4[] = [
  {
    from: 1096, to: 1200, x: 1020, y: 620, w: 470, kind: 'info',
    title: '两种审批模式（设置中切换）',
    body: '智能审批：常规读写、构建、查询自动放行，卡片标记「已智能放行」；删除、服务启停、格式化等危险操作仍转人工确认。全部审批：每次操作都需人工确认。',
  },
  {
    from: 2186, to: 2280, x: 250, y: 620, w: 470, kind: 'alert',
    title: '敏感信息脱敏',
    body: '终端与文件内容进入 AI 前，密码、密钥、token 等键值会被替换为 ***已脱敏***；已知的密钥原文也会被二次遮蔽，AI 拿不到真实密码。',
  },
  {
    from: 2626, to: 2820, x: 1120, y: 620, w: 400, kind: 'info',
    title: '数据库管道',
    body: '按服务器配置数据库连接：白名单内只读命令 AI 可直接执行，写命令需审批；密码存入系统凭据库，AI 永不可见。',
  },
];

/** 键盘/焦点提示(本片无快捷键,留空) */
export const KBD4: readonly { from: number; to: number; x: number; y: number; label: string }[] = [];

/** 焦点高亮环 */
export const HIGHLIGHTS4 = [
  { x: MODE_SEL.x - 5, y: MODE_SEL.y - 5, w: MODE_SEL.w + 10, h: MODE_SEL.h + 10, r: 5, from: 150, to: 192 },
  { x: 1601, y: 956, w: 274, h: 60, r: 8, from: 470, to: 498 },
  { x: 1600, y: 971, w: 44, h: 24, r: 4, from: 974, to: 1002 },
  { x: 1600, y: 971, w: 44, h: 24, r: 4, from: 1500, to: 1528 },
  { x: 1062, y: 636, w: 80, h: 32, r: 4, from: 1758, to: 1792 },
  { x: MODE_SEL.x - 5, y: MODE_SEL.y - 5, w: MODE_SEL.w + 10, h: MODE_SEL.h + 10, r: 5, from: 2004, to: 2026 },
  { x: MORE_BTN.x - 5, y: MORE_BTN.y - 5, w: MORE_BTN.w + 10, h: MORE_BTN.h + 10, r: 5, from: 2890, to: 2914 },
  { x: 1140, y: 658, w: 102, h: 32, r: 4, from: 3038, to: 3062 },
  { x: 1188, y: 856, w: 54, h: 32, r: 4, from: 3326, to: 3350 },
  { x: 1600, y: 971, w: 46, h: 24, r: 4, from: 3774, to: 3798 },
  { x: 1158, y: 906, w: 54, h: 32, r: 4, from: 3884, to: 3910 },
];

/* ============ 演示文本 ============ */
const Q1 = '看一下当前磁盘占用';
const Q2 = '把 app-config.yml 的 retries 改成 5';
const Q3 = '跑一遍测试套件';
const Q4 = '清理项目里的 dist.old 旧构建产物';
const Q5 = '重新构建并部署到测试环境';
const Q6 = '终端里的数据库密码是多少？直接帮我连上库查一下';
const Q7 = '统计一下计费库今天新增的订单量';

const EDIT_SPEC: ActionSpec = {
  name: '编辑文件', icon: 'wrench',
  intent: '意图：按用户要求调整配置参数',
  meta: 'app-config.yml · retries: 3 → 5',
  btn: 'approve', result: '已写入 app-config.yml',
};
const TEST_SPEC: ActionSpec = {
  name: '执行命令', icon: 'wrench',
  intent: '意图：运行项目测试套件',
  cmd: 'npm run test',
  smart: '智能判定：常规测试命令，非危险操作',
  result: '42 passed in 3.87s',
};
const DEL_SPEC: ActionSpec = {
  name: '删除文件', icon: 'wrench',
  intent: '意图：清理旧构建产物',
  meta: 'dist.old/（12 个文件）',
  smart: '智能审批拦截：删除目录，危险操作',
  btn: 'approve', result: '已删除 12 个文件',
};
const DEPLOY_SPEC: ActionSpec = {
  name: '执行命令', icon: 'wrench',
  intent: '意图：重新构建并部署到测试环境',
  cmd: 'npm run build && ./deploy.sh',
  result: '构建完成，已部署到 staging',
};
const DB_SPEC: ActionSpec = {
  name: '申请数据库连接', icon: 'database',
  bold: `AI 助手想要申请访问数据库 ${DEMO.dbName} 的权限`,
  meta: 'MySQL · 10.21.36.8:3306 · app_ro',
  reason: '申请理由：统计今日订单量需要访问计费库',
  btn: 'audit',
  result: `已批准并保存「${DEMO.dbConnName}」(${DEMO.connId})`,
};

const SNAP = {
  label: '@term:t1 · 终端快照（已脱敏）',
  lines: [
    { segs: [{ t: '$ mysql -h db.internal -u app' }] },
    { segs: [{ t: "  -p'" }, { t: MASK, mask: true }, { t: "'" }] },
    { segs: [{ t: 'Welcome to the MySQL monitor.' }] },
    { segs: [{ t: 'mysql> exit' }] },
  ],
};

/* ============ 工具 ============ */
const typed = (frame: number, from: number, step: number, full: string): string =>
  full.slice(0, Math.max(0, Math.min(full.length, Math.floor((frame - from) / step) + 1)));

const inSpan = (frame: number, a: number, b: number): boolean => frame >= a && frame < b;

const dots = (n: number): string => '•'.repeat(Math.max(0, n));

/** 由帧推导消息流(与 Wb4 渲染共用高度模型) */
export function buildItems(frame: number): ChatSpec[] {
  const specs: ChatSpec[] = [];
  if (frame >= A_Q1_ENTER) specs.push({ kind: 'user', id: 'u1', lines: [Q1] });
  if (frame >= 424) {
    const typing = frame < 436;
    specs.push({
      kind: 'ai', id: 'ai1',
      lines: typing ? [] : ['当前磁盘占用如下，建议先确认整体使用率：'],
      typing,
      card: frame >= 444 ? { cmd: 'df -h' } : undefined,
    });
  }
  if (frame >= A_Q2_ENTER) specs.push({ kind: 'user', id: 'u2', lines: ['把 app-config.yml 的 retries', '改成 5'] });
  if (frame >= 746) {
    const typing = frame < 758;
    specs.push({
      kind: 'ai', id: 'ai2',
      lines: typing ? [] : ['仅建议模式下我只能提供建议，', '无法直接修改项目文件。'],
      typing,
    });
  }
  if (frame >= 880) specs.push({ kind: 'ai', id: 'ai3', lines: ['好的，继续执行刚才的修改。'] });
  if (frame >= 896) {
    specs.push({
      kind: 'action', id: 'actEdit',
      status: frame < A_EDIT_APPROVE + 6 ? 'approving' : frame < 1042 ? 'running' : 'succeeded',
      spec: EDIT_SPEC,
    });
  }
  if (frame >= B_Q3_ENTER) specs.push({ kind: 'user', id: 'u3', lines: [Q3] });
  if (frame >= 1300) {
    specs.push({ kind: 'action', id: 'actTest', status: frame < 1364 ? 'smart' : 'succeeded', spec: TEST_SPEC });
  }
  if (frame >= 1476) specs.push({ kind: 'user', id: 'u4', lines: [Q4] });
  if (frame >= 1490) {
    specs.push({
      kind: 'action', id: 'actDel',
      status: frame < B_DEL_APPROVE + 6 ? 'approving' : frame < 1568 ? 'running' : 'succeeded',
      spec: DEL_SPEC,
    });
  }
  if (frame >= C_Q5_ENTER) specs.push({ kind: 'user', id: 'u5', lines: [Q5] });
  if (frame >= 1942) {
    specs.push({ kind: 'action', id: 'actDeploy', status: frame < 1988 ? 'running' : 'succeeded', spec: DEPLOY_SPEC });
  }
  if (frame >= D_Q6_ENTER) specs.push({ kind: 'user', id: 'u6', chip: '@term:t1', lines: ['终端里的数据库密码是多少？', '直接帮我连上库查一下'] });
  if (frame >= 2418) {
    const typing = frame < 2430;
    specs.push({
      kind: 'ai', id: 'aiSnap',
      lines: typing ? [] : ['终端快照里的密码已被替换为 ***已脱敏***，', '我拿不到真实密码，无法自主连接数据库。'],
      typing,
      snap: typing ? undefined : SNAP,
    });
  }
  if (frame >= 2614) {
    const typing = frame < 2626;
    specs.push({
      kind: 'ai', id: 'aiPipe',
      lines: typing ? [] : ['需要查询数据库时，我可以走「数据库管道」，', '或提交连接申请，由你输入密码授权。'],
      typing,
    });
  }
  if (frame >= F_Q7_ENTER) specs.push({ kind: 'user', id: 'u7', lines: [Q7] });
  if (frame >= 3596) {
    specs.push({
      kind: 'action', id: 'actDb',
      status: frame < F_PWD_OK + 12 ? 'approving' : 'succeeded',
      spec: DB_SPEC,
    });
  }
  if (frame >= 3958) {
    const typing = frame < 3970;
    specs.push({
      kind: 'ai', id: 'aiQuery',
      lines: typing ? [] : ['今天新增 1,284 单，环比 +6.2%；', '近 7 天日均 1,190 单。'],
      tool: typing ? undefined : 'db_query SELECT COUNT(*) FROM orders',
      typing,
    });
  }
  return specs;
}

/* ============ 状态推导 ============ */
export function wbAt(frame: number): Wb4State {
  /* ---- 模式与下拉 ---- */
  const mode: 'suggest' | 'agent' | 'yolo' =
    frame < A_DLG_OK + 4 ? 'suggest' : frame < C_DLG_OK + 8 ? 'agent' : frame < C_AGENT_PICK + 8 ? 'yolo' : 'agent';
  const menuOpen1 = inSpan(frame, A_MENU1 + 2, A_MENU1_CLOSE + 4);
  const menuOpen2 = inSpan(frame, C_MENU + 2, C_YOLO_PICK + 8);
  const menuOpen3 = inSpan(frame, C_MENU2 + 2, C_AGENT_PICK + 8);
  const modeMenu =
    menuOpen1 || menuOpen2 || menuOpen3
      ? {
          open: true,
          hover: menuOpen1 ? (inSpan(frame, 210, A_MENU1_CLOSE) ? 0 : -1)
            : menuOpen2 ? (inSpan(frame, 1650, C_YOLO_PICK) ? 2 : -1)
            : inSpan(frame, 2040, C_AGENT_PICK) ? 1 : -1,
          press: inSpan(frame, C_YOLO_PICK, C_YOLO_PICK + 6) ? 2 : inSpan(frame, C_AGENT_PICK, C_AGENT_PICK + 6) ? 1 : -1,
        }
      : null;

  /* ---- 消息流 ---- */
  const items = stackChat(buildItems(frame));

  /* ---- 输入区 ---- */
  const inputFocus =
    inSpan(frame, A_Q1_CLICK, A_Q1_ENTER + 4) || inSpan(frame, A_Q2_CLICK, A_Q2_ENTER + 4)
    || inSpan(frame, B_Q3_CLICK, B_Q3_ENTER + 4) || inSpan(frame, 1424, 1480)
    || inSpan(frame, C_Q5_CLICK, C_Q5_ENTER + 4) || inSpan(frame, D_Q6_CLICK, D_Q6_ENTER + 4)
    || inSpan(frame, F_Q7_CLICK, F_Q7_ENTER + 4);
  let inputText = '';
  if (inSpan(frame, 344, A_Q1_ENTER + 4)) inputText = typed(frame, 344, 7, Q1);
  else if (inSpan(frame, 660, A_Q2_ENTER + 4)) inputText = typed(frame, 660, 2.6, Q2);
  else if (inSpan(frame, 1234, B_Q3_ENTER + 4)) inputText = typed(frame, 1234, 6, Q3);
  else if (inSpan(frame, 1424, 1480)) inputText = typed(frame, 1426, 2.6, Q4);
  else if (inSpan(frame, 1872, C_Q5_ENTER + 4)) inputText = typed(frame, 1872, 4, Q5);
  else if (inSpan(frame, 2330, D_Q6_ENTER + 4)) inputText = typed(frame, 2330, 3, Q6);
  else if (inSpan(frame, 3530, F_Q7_ENTER + 4)) inputText = typed(frame, 3530, 2.2, Q7);
  const inputChip = inSpan(frame, 2330, D_Q6_ENTER + 4);
  const inputCaret = inputFocus && inputText.length > 0;

  /* ---- 确认框 ---- */
  const dialog: 'agent' | 'yolo' | null =
    inSpan(frame, A_DLG, A_DLG_OK + 8) ? 'agent' : inSpan(frame, C_DLG, C_DLG_OK + 8) ? 'yolo' : null;
  const dialogT =
    dialog === 'agent'
      ? interpolate(frame, [A_DLG, A_DLG + 10, A_DLG_OK + 2, A_DLG_OK + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
      : dialog === 'yolo'
        ? interpolate(frame, [C_DLG, C_DLG + 10, C_DLG_OK + 2, C_DLG_OK + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : 0;

  /* ---- 数据库连接弹窗 ---- */
  let dbModal: { view: 'list' | 'form'; saved: boolean; form: null | { name: string; host: string; user: string; pwd: string; database: string } } | null = null;
  if (inSpan(frame, E_DB + 10, E_ADD + 8)) dbModal = { view: 'list', saved: false, form: null };
  else if (inSpan(frame, E_ADD + 8, E_SAVE + 8)) {
    dbModal = {
      view: 'form', saved: false,
      form: {
        name: typed(frame, 3114, 8, DEMO.dbConnName),
        host: typed(frame, 3164, 3, DEMO.serverHost),
        user: typed(frame, 3220, 3, DEMO.dbUser),
        pwd: dots(Math.floor((frame - 3266) / 2) > 12 ? 12 : Math.max(0, Math.floor((frame - 3266) / 2))),
        database: typed(frame, 3312, 3, DEMO.dbName),
      },
    };
  } else if (inSpan(frame, E_SAVE + 8, E_CLOSE + 8)) dbModal = { view: 'list', saved: true, form: null };
  const dbModalT = inSpan(frame, E_DB + 10, E_CLOSE + 8)
    ? interpolate(frame, [E_DB + 10, E_DB + 20, E_CLOSE + 2, E_CLOSE + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 0;

  /* ---- AI 数据库连接审批弹窗 ---- */
  const dbaOpen = inSpan(frame, F_AUDIT + 10, F_PWD_OK + 8);
  const dba = dbaOpen
    ? {
        pwd: dots(Math.min(12, Math.max(0, Math.floor((frame - 3860) / 2)))),
        focus: inSpan(frame, 3856, F_PWD_OK),
      }
    : null;
  const dbaT = dbaOpen
    ? interpolate(frame, [F_AUDIT + 10, F_AUDIT + 20, F_PWD_OK + 2, F_PWD_OK + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 0;

  /* ---- 更多菜单 / 侧栏 ---- */
  const ctx = inSpan(frame, E_MORE + 2, E_DB + 6)
    ? { hover: inSpan(frame, 2950, E_DB) ? 1 : -1, press: inSpan(frame, E_DB, E_DB + 6) ? 1 : -1 }
    : null;

  /* ---- toast ---- */
  const toast =
    inSpan(frame, A_DLG_OK + 8, A_DLG_OK + 68) ? 'AI 模式已切换为 工作'
    : inSpan(frame, C_DLG_OK + 8, C_DLG_OK + 68) ? 'AI 模式已切换为 全自动'
    : inSpan(frame, C_AGENT_PICK + 8, C_AGENT_PICK + 68) ? 'AI 模式已切换为 工作'
    : inSpan(frame, E_SAVE + 6, E_SAVE + 66) ? '已保存数据库连接'
    : inSpan(frame, F_PWD_OK + 8, F_PWD_OK + 92) ? '已批准数据库连接「计费库」，AI 可立即查询'
    : null;

  /* ---- hover / press ---- */
  const hover =
    inSpan(frame, 150, A_MENU1) || inSpan(frame, A_MENU1_CLOSE - 12, A_MENU1_CLOSE + 4)
    || inSpan(frame, 1596, C_MENU) || inSpan(frame, 2004, C_MENU2) ? 'modeSel'
    : inSpan(frame, 470, A_CARD_CLICK + 2) ? 'card'
    : inSpan(frame, 826, A_DLG_OK) ? 'agree'
    : inSpan(frame, 974, A_EDIT_APPROVE) ? 'approveEdit'
    : inSpan(frame, 1498, B_DEL_APPROVE) ? 'approveDel'
    : inSpan(frame, 1760, C_DLG_OK) ? 'yoloOk'
    : inSpan(frame, 2726, E_ACT) ? 'actServers'
    : inSpan(frame, 2846, E_CARD) ? 'srvCard'
    : inSpan(frame, 2890, E_MORE) ? 'more'
    : inSpan(frame, 3038, E_ADD) ? 'dbAdd'
    : inSpan(frame, 3104, 3144) ? 'dbName'
    : inSpan(frame, 3154, 3198) ? 'dbHost'
    : inSpan(frame, 3210, 3242) ? 'dbUser'
    : inSpan(frame, 3256, 3290) ? 'dbPwd'
    : inSpan(frame, 3302, 3334) ? 'dbDb'
    : inSpan(frame, 3326, E_SAVE) ? 'dbSave'
    : inSpan(frame, 3426, E_CLOSE) ? 'dbClose'
    : inSpan(frame, 3772, F_AUDIT) ? 'dbAudit'
    : inSpan(frame, 3846, 3860) ? 'dbaPwd'
    : inSpan(frame, 3884, F_PWD_OK) ? 'dbaOk'
    : null;
  const press =
    inSpan(frame, A_MENU1, A_MENU1 + 6) || inSpan(frame, A_MENU1_CLOSE, A_MENU1_CLOSE + 6)
    || inSpan(frame, C_MENU, C_MENU + 6) || inSpan(frame, C_MENU2, C_MENU2 + 6) ? 'modeSel'
    : inSpan(frame, A_CARD_CLICK, A_CARD_CLICK + 6) ? 'card'
    : inSpan(frame, A_DLG_OK, A_DLG_OK + 6) ? 'agree'
    : inSpan(frame, A_EDIT_APPROVE, A_EDIT_APPROVE + 6) ? 'approveEdit'
    : inSpan(frame, B_DEL_APPROVE, B_DEL_APPROVE + 6) ? 'approveDel'
    : inSpan(frame, C_DLG_OK, C_DLG_OK + 6) ? 'yoloOk'
    : inSpan(frame, E_ACT, E_ACT + 6) ? 'actServers'
    : inSpan(frame, E_CARD, E_CARD + 6) ? 'srvCard'
    : inSpan(frame, E_MORE, E_MORE + 6) ? 'more'
    : inSpan(frame, E_ADD, E_ADD + 6) ? 'dbAdd'
    : inSpan(frame, E_SAVE, E_SAVE + 6) ? 'dbSave'
    : inSpan(frame, E_CLOSE, E_CLOSE + 6) ? 'dbClose'
    : inSpan(frame, F_AUDIT, F_AUDIT + 6) ? 'dbAudit'
    : inSpan(frame, F_PWD_OK, F_PWD_OK + 6) ? 'dbaOk'
    : null;

  return {
    panel: frame >= E_ACT + 6 ? ('servers' as const) : ('explorer' as const),
    serverExpanded: frame >= E_CARD + 6,
    mode,
    modeMenu,
    items,
    inputText,
    inputCaret,
    inputFocus,
    inputChip,
    termCmd: frame >= A_CARD_CLICK + 6 ? 'df -h' : null,
    ctx,
    dialog,
    dialogT,
    dbModal,
    dbModalT,
    dba,
    dbaT,
    toast,
    hover,
    press,
  };
}

/* 供总装层使用的锚点重推导(点击帧的卡片按钮位置,验证指针轨) */
export function approveAnchorAt(frame: number, id: string, which: 'approve' | 'audit'): { x: number; y: number } {
  const item = stackChat(buildItems(frame)).find((it) => it.id === id);
  if (!item) return { x: 0, y: 0 };
  return actionBtnAnchor(item, which);
}
export function cardAnchorAt(frame: number, id: string): { x: number; y: number } {
  const item = stackChat(buildItems(frame)).find((it) => it.id === id);
  if (!item) return { x: 0, y: 0 };
  return cmdCardAnchor(item);
}
