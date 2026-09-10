/**
 * 视频九导演脚本:时间线云同步的帧级编排。
 * 剧情线(30fps,约 145s):
 *   A    0–560   终端干活(键入/输出/SFTP 进度)→ 左侧边栏「时间线」入口点击 → 标签页出现,事件逐条刷出
 *   B  570–1115  右键打标「发布」×2(选区着色)→ chips 筛选
 *   B2 1150–1830 AI 分析:工具栏「AI 分析」→ 选择分析范围(勾选「发布」)→ AI 面板新会话流式归纳
 *                项目日志 → ask 卡勾选保存笔记/Skill
 *   C 1850–2430  设置页「时间线云同步」:默认开 + 状态行 + 脱敏/三层开关 Note + 悬停提示小卡
 *   D 2440–3300  网页端工作台(浅色):跨项目统一时间线 → 项目筛选 → 类别+标签筛选 → 展开详情
 *   E 3300–3890  删除云端时间线(确认框 + toast)+ 保留与配额 Note
 *   F 3900–4340  收尾分屏(客户端 ⇄ 网页端)+ 三张特性卡
 */
import { interpolate } from 'remotion';
import { Stop } from '../anim';
import { Click } from '../components/Cursor';
import { ACT_TL, ADLG9_F, AI2, DEMO, MENU9_Y1, MENU9_Y2, TL, TL_ROWS, TL_COL, TL_ROWS as ROWS, WEB, WEB_ROWS, WebRow, dropOptCy, menuItemCy, tlRowY, webChipX, webRowY } from './layout';
import { H9, Wb9State } from './Wb9';
import { W9, Web9State } from './Web9';

void TL_COL;
void webRowY;

/* ============ 关键帧 ============ */
/* A 幕 */
const TERM_TYPE = 170;
const TERM_OUT_AT = 258;
const UP_AT = 240;
const UP_DONE = 332;
/** 入口:活动栏「时间线」图标点击 */
const ACT_CLICK = 340;
const TL_AT = 352;
const ROW0_AT = 372;
const ROW_STEP = 18;
/* B 幕 */
const RCT1 = 570;
const MENU1_AT = 578;
const TAGBTN1 = 642;
const DLG1_AT = 650;
const TYPE1 = 694;
const OK1 = 772;
const TAG1_AT = 782;
const RCT2 = 832;
const MENU2_AT = 840;
const TAGBTN2 = 892;
const DLG2_AT = 900;
const TYPE2 = 936;
const OK2 = 1004;
const TAG2_AT = 1014;
const REGION_END = 1234;
const CHIP_CLICK = 1064;
const FILTER_AT = 1072;
/* B2 幕:AI 分析 */
const AI_CLICK = 1160;
const ADLG_AT = 1170;
const ACHK = 1280;
const AOK = 1380;
const AI_VIEW = 1400;
const TOOL_AT = 1432;
const LINES_AT = 1454;
const LINE_STEP = 20;
const ASK_AT = 1582;
const SAVE_CLICK = 1660;
const SAVED_AT = 1672;
/* C 幕 */
const SET_CLICK = 1850;
const SET_AT = 1858;
const TIP_AT = 2244;
const TIP_END = 2380;
/* D 幕 */
export const WEB_IN = 2440;
const SEL_CLICK = 2672;
const DROP_AT = 2680;
const OPT_CLICK = 2762;
const DROP_DONE = 2770;
const REFRESH1 = 2772;
const KIND1 = 2842;
const KIND2 = 2892;
const REFRESH2 = 2900;
const TAGSEL = 2952;
const REFRESH3 = 2960;
const ROW_CLICK = 3072;
const EXP_AT = 3080;
export const WEB_BACK = 3300;
/* E 幕 */
const PURGE_CLICK = 3392;
const CFM_AT = 3400;
const CFM_OK = 3532;
const CFM_DONE = 3540;
const TOAST_END = 3710;
/* F 幕 */
export const SPLIT_AT = 3900;
export const DURATION = 4340;

/* ============ 摄像机轨道 ============ */
export const CAM_S: readonly Stop[] = [
  { f: 0, v: 0.78 }, { f: 140, v: 0.78 }, { f: 224, v: 0.9 }, { f: 340, v: 0.9 },
  { f: 392, v: 0.92 }, { f: 560, v: 0.92 }, { f: 624, v: 1.3 }, { f: 1024, v: 1.3 },
  { f: 1064, v: 1.0 }, { f: 1150, v: 1.0 }, { f: 1200, v: 1.3 }, { f: 1380, v: 1.3 },
  { f: 1440, v: 1.05 }, { f: 1830, v: 1.05 }, { f: 1900, v: 1.0 }, { f: 1960, v: 1.08 },
  { f: 2424, v: 1.08 }, { f: 2484, v: 0.9 }, { f: 3104, v: 0.9 }, { f: 3164, v: 1.2 },
  { f: 3296, v: 1.2 }, { f: 3364, v: 0.98 }, { f: SPLIT_AT, v: 0.98 }, { f: DURATION, v: 0.98 },
];
export const CAM_X: readonly Stop[] = [
  { f: 0, v: 960 }, { f: 140, v: 960 }, { f: 224, v: 944 }, { f: 340, v: 944 },
  { f: 392, v: 944 }, { f: 560, v: 944 }, { f: 624, v: 944 }, { f: 1024, v: 944 },
  { f: 1064, v: 944 }, { f: 1150, v: 944 }, { f: 1200, v: 944 }, { f: 1380, v: 944 },
  { f: 1440, v: 1330 }, { f: 1830, v: 1330 }, { f: 1900, v: 880 }, { f: 1960, v: 850 },
  { f: 2424, v: 850 }, { f: 2484, v: 1080 }, { f: 3104, v: 1080 }, { f: 3164, v: 1080 },
  { f: 3296, v: 1080 }, { f: 3364, v: 960 }, { f: SPLIT_AT, v: 960 }, { f: DURATION, v: 960 },
];
export const CAM_Y: readonly Stop[] = [
  { f: 0, v: 600 }, { f: 140, v: 600 }, { f: 224, v: 560 }, { f: 340, v: 600 },
  { f: 392, v: 620 }, { f: 560, v: 620 }, { f: 624, v: 450 }, { f: 1024, v: 450 },
  { f: 1064, v: 620 }, { f: 1150, v: 620 }, { f: 1200, v: 450 }, { f: 1380, v: 450 },
  { f: 1440, v: 480 }, { f: 1830, v: 480 }, { f: 1900, v: 620 }, { f: 1960, v: 600 },
  { f: 2424, v: 600 }, { f: 2484, v: 589 }, { f: 3104, v: 589 }, { f: 3164, v: 380 },
  { f: 3296, v: 380 }, { f: 3364, v: 620 }, { f: SPLIT_AT, v: 620 }, { f: DURATION, v: 620 },
];

/* ============ 指针轨道 ============ */
const ROW1_Y = tlRowY(1) + 18;
const ROW5_Y = tlRowY(5) + 18;
/** AnalyzeDialog「发布」勾选框中心 */
const ACHK_PT = { x: ADLG9_F.checkboxX + 8, y: ADLG9_F.itemY(0) + 18 };
/** AnalyzeDialog「开始分析」按钮中心 */
const AOK_PT = { x: ADLG9_F.btnOk.x + ADLG9_F.btnOk.w / 2, y: ADLG9_F.btnOk.y + ADLG9_F.btnOk.h / 2 };
/** AI 面板 ask 卡「保存选中」按钮中心 */
const SAVE_PT = { x: AI2.saveBtn.x + AI2.saveBtn.w / 2, y: AI2.saveBtn.y + AI2.saveBtn.h / 2 };
/** 网页端各交互点(窗口坐标) */
const W_SEL = { x: WEB.projSel.x + WEB.projSel.w / 2, y: WEB.projSel.y + WEB.projSel.h / 2 };
const W_OPT = { x: WEB.drop.x + 80, y: dropOptCy(1) };
const W_KIND1 = { x: webChipX(3) + 28, y: WEB.chipsY + WEB.chipH / 2 };
const W_KIND2 = { x: webChipX(4) + 28, y: WEB.chipsY + WEB.chipH / 2 };
const W_TAG = { x: WEB.tagSel.x + WEB.tagSel.w / 2, y: WEB.tagSel.y + WEB.tagSel.h / 2 };
const W_ROW = { x: 800, y: webRowY(0) + 21 };
const CURVE: readonly (readonly [number, number, number])[] = [
  [30, 1500, 900],
  [ACT_CLICK - 10, ACT_TL.x, ACT_TL.y],
  [ACT_CLICK, ACT_TL.x, ACT_TL.y],
  [470, 800, 300],
  [RCT1, 800, ROW1_Y],
  [TAGBTN1 - 10, 635, menuItemCy(MENU9_Y1)],
  [TAGBTN1, 635, menuItemCy(MENU9_Y1)],
  [TYPE1 - 8, 960, 517],
  [OK1 - 10, 1134, 721],
  [OK1, 1134, 721],
  [812, 800, 430],
  [RCT2, 800, ROW5_Y],
  [TAGBTN2 - 10, 635, menuItemCy(MENU9_Y2)],
  [TAGBTN2, 635, menuItemCy(MENU9_Y2)],
  [TYPE2 - 8, 960, 517],
  [OK2 - 10, 1134, 721],
  [OK2, 1134, 721],
  [CHIP_CLICK - 10, 360, 140],
  [CHIP_CLICK, 360, 140],
  [AI_CLICK - 10, TL.aiBtn.x + TL.aiBtn.w / 2, TL.aiBtn.y + TL.aiBtn.h / 2],
  [AI_CLICK, TL.aiBtn.x + TL.aiBtn.w / 2, TL.aiBtn.y + TL.aiBtn.h / 2],
  [ACHK - 10, ACHK_PT.x, ACHK_PT.y],
  [ACHK, ACHK_PT.x, ACHK_PT.y],
  [AOK - 10, AOK_PT.x, AOK_PT.y],
  [AOK, AOK_PT.x, AOK_PT.y],
  [SAVE_CLICK - 10, SAVE_PT.x, SAVE_PT.y],
  [SAVE_CLICK, SAVE_PT.x, SAVE_PT.y],
  [1830, 1500, 700],
  [SET_CLICK - 10, 1675, 34],
  [SET_CLICK, 1675, 34],
  [2234, 498, 409],
  [2380, 900, 780],
  [SEL_CLICK - 10, W_SEL.x, W_SEL.y],
  [SEL_CLICK, W_SEL.x, W_SEL.y],
  [OPT_CLICK - 10, W_OPT.x, W_OPT.y],
  [OPT_CLICK, W_OPT.x, W_OPT.y],
  [KIND1 - 10, W_KIND1.x, W_KIND1.y],
  [KIND1, W_KIND1.x, W_KIND1.y],
  [KIND2 - 10, W_KIND2.x, W_KIND2.y],
  [KIND2, W_KIND2.x, W_KIND2.y],
  [TAGSEL - 10, W_TAG.x, W_TAG.y],
  [TAGSEL, W_TAG.x, W_TAG.y],
  [ROW_CLICK - 10, W_ROW.x, W_ROW.y],
  [ROW_CLICK, W_ROW.x, W_ROW.y],
  [3280, 900, 800],
  [PURGE_CLICK - 10, 386, 610],
  [PURGE_CLICK, 386, 610],
  [CFM_OK - 10, 1116, 689],
  [CFM_OK, 1116, 689],
  [3800, 700, 900],
  [DURATION, 1200, 850],
];
export const CUR_X: readonly Stop[] = CURVE.map(([f, x]) => ({ f, v: x }));
export const CUR_Y: readonly Stop[] = CURVE.map(([f, , y]) => ({ f, v: y }));

/* ============ 点击(涟漪) ============ */
export const CLICKS: readonly Click[] = [
  { f: ACT_CLICK, x: ACT_TL.x, y: ACT_TL.y, target: 'browse' },
  { f: RCT1, x: 800, y: ROW1_Y, target: 'row' },
  { f: TAGBTN1, x: 635, y: menuItemCy(MENU9_Y1), target: 'browse' },
  { f: OK1, x: 1134, y: 721, target: 'confirm' },
  { f: RCT2, x: 800, y: ROW5_Y, target: 'row' },
  { f: TAGBTN2, x: 635, y: menuItemCy(MENU9_Y2), target: 'browse' },
  { f: OK2, x: 1134, y: 721, target: 'confirm' },
  { f: CHIP_CLICK, x: 360, y: 140, target: 'browse' },
  { f: AI_CLICK, x: TL.aiBtn.x + TL.aiBtn.w / 2, y: TL.aiBtn.y + TL.aiBtn.h / 2, target: 'browse' },
  { f: ACHK, x: ACHK_PT.x, y: ACHK_PT.y, target: 'browse' },
  { f: AOK, x: AOK_PT.x, y: AOK_PT.y, target: 'confirm' },
  { f: SAVE_CLICK, x: SAVE_PT.x, y: SAVE_PT.y, target: 'confirm' },
  { f: SET_CLICK, x: 1675, y: 34, target: 'browse' },
  { f: SEL_CLICK, x: W_SEL.x, y: W_SEL.y, target: 'browse' },
  { f: OPT_CLICK, x: W_OPT.x, y: W_OPT.y, target: 'browse' },
  { f: KIND1, x: W_KIND1.x, y: W_KIND1.y, target: 'browse' },
  { f: KIND2, x: W_KIND2.x, y: W_KIND2.y, target: 'browse' },
  { f: TAGSEL, x: W_TAG.x, y: W_TAG.y, target: 'browse' },
  { f: ROW_CLICK, x: W_ROW.x, y: W_ROW.y, target: 'row' },
  { f: PURGE_CLICK, x: 386, y: 610, target: 'save' },
  { f: CFM_OK, x: 1116, y: 689, target: 'confirm' },
];

/* ============ 字幕 ============ */
export const CAPTIONS9 = [
  { from: 4, to: 150, text: '每天的服务器操作，事后还想得起来吗？' },
  { from: 152, to: 330, text: '连接、命令、传输、AI 会话——' },
  { from: 342, to: 450, text: '从左侧边栏打开「时间线」' },
  { from: 455, to: 560, text: '每一次操作，都自动记入时间线' },
  { from: 570, to: 760, text: '给关键操作打上标签' },
  { from: 790, to: 990, text: '两个同名标签，自动围出一段选区' },
  { from: 1010, to: 1115, text: '点标签即可筛选；标签会随时间线一起上云' },
  { from: 1165, to: 1300, text: '时间线还能直接交给 AI 分析' },
  { from: 1405, to: 1560, text: 'AI 检索选区事件，归纳出项目日志' },
  { from: 1590, to: 1810, text: '产出笔记与 Skill，勾选后一键保存' },
  { from: 1860, to: 1960, text: '云同步默认开启——什么都不用配' },
  { from: 1980, to: 2180, text: '上传前自动脱敏，本地文件保持原样' },
  { from: 2210, to: 2405, text: '不想上云？一键关闭，时间线仍在本机记录' },
  { from: 2465, to: 2630, text: '打开云平台工作台——所有项目的时间线汇成一条河' },
  { from: 2670, to: 2830, text: '按项目筛选，各看各的' },
  { from: 2840, to: 3060, text: '类别、标签、关键词，随心组合' },
  { from: 3080, to: 3285, text: '点开详情——和本机看到的一样，除了已脱敏' },
  { from: 3320, to: 3485, text: '云端数据，随时可以一键清空' },
  { from: 3540, to: 3695, text: '本机记录原样保留，之后从新事件重新累积' },
  { from: 3720, to: 3885, text: '云端默认保留 90 天，超量自动暂停' },
  { from: 3950, to: 4100, text: '操作留痕，跨端可查' },
  { from: 4140, to: 4320, text: '时间线云同步——默认开启，随时可关' },
];

/* ============ 教学叠加层 ============ */
export interface Note9 {
  from: number;
  to: number;
  x: number;
  y: number;
  w: number;
  kind: 'info' | 'alert';
  title: string;
  body: string;
}
export const NOTES9: readonly Note9[] = [
  {
    from: 1910, to: 2180, x: 1230, y: 264, w: 430, kind: 'info',
    title: '三层开关',
    body: '已登录云服务 + 平台已开通时间线同步 + 本机开关打开——三者同时满足才上传；任一不满足只写本地文件，不排队、不上传。',
  },
  {
    from: 1990, to: 2200, x: 1230, y: 470, w: 430, kind: 'info',
    title: '脱敏后上云',
    body: '上传前对摘要与详情做凭据形态替换：password=order@2026 → password=***已脱敏***。本地时间线文件保持原样；脱敏是尽力而为的形态匹配，敏感信息请以治理措施兜底。',
  },
  {
    from: 3720, to: 3890, x: 1230, y: 470, w: 440, kind: 'info',
    title: '保留与配额',
    body: '云端事件默认保留 90 天（按事件时间清理，标签随锚点过期）；单用户上限 200,000 条，超限自动暂停上传，删除云端时间线后即可恢复。',
  },
];

/* ============ 焦点高亮环 ============ */
export const HIGHLIGHTS9 = [
  { x: 4, y: ACT_TL.y - 20, w: 40, h: 40, r: 8, from: ACT_CLICK - 22, to: ACT_CLICK - 2 },
  { x: 312, y: 240, w: 1256, h: 34, r: 4, from: RCT1 - 30, to: RCT1 - 2 },
  { x: 564, y: 272, w: 142, h: 30, r: 4, from: TAGBTN1 - 22, to: TAGBTN1 - 2 },
  { x: 1090, y: 700, w: 88, h: 36, r: 4, from: OK1 - 22, to: OK1 - 2 },
  { x: 312, y: 384, w: 1256, h: 34, r: 4, from: RCT2 - 30, to: RCT2 - 2 },
  { x: 564, y: 416, w: 142, h: 30, r: 4, from: TAGBTN2 - 22, to: TAGBTN2 - 2 },
  { x: 1090, y: 700, w: 88, h: 36, r: 4, from: OK2 - 22, to: OK2 - 2 },
  { x: 318, y: 126, w: 84, h: 28, r: 4, from: CHIP_CLICK - 22, to: CHIP_CLICK - 2 },
  { x: TL.aiBtn.x - 4, y: TL.aiBtn.y - 4, w: TL.aiBtn.w + 8, h: TL.aiBtn.h + 8, r: 4, from: AI_CLICK - 22, to: AI_CLICK - 2 },
  { x: ACHK_PT.x - 14, y: ACHK_PT.y - 14, w: 28, h: 28, r: 4, from: ACHK - 22, to: ACHK - 2 },
  { x: ADLG9_F.btnOk.x - 4, y: ADLG9_F.btnOk.y - 4, w: ADLG9_F.btnOk.w + 8, h: ADLG9_F.btnOk.h + 8, r: 4, from: AOK - 22, to: AOK - 2 },
  { x: AI2.saveBtn.x - 4, y: AI2.saveBtn.y - 4, w: AI2.saveBtn.w + 8, h: AI2.saveBtn.h + 8, r: 4, from: SAVE_CLICK - 22, to: SAVE_CLICK - 2 },
  { x: 1649, y: 13, w: 52, h: 38, r: 6, from: SET_CLICK - 22, to: SET_CLICK - 2 },
  { x: 484, y: 395, w: 28, h: 28, r: 4, from: 1966, to: 2180 },
  { x: 306, y: 548, w: 640, h: 26, r: 4, from: 1966, to: 2180 },
  { x: WEB.projSel.x - 4, y: WEB.projSel.y - 4, w: WEB.projSel.w + 8, h: WEB.projSel.h + 8, r: 6, from: SEL_CLICK - 22, to: SEL_CLICK - 2 },
  { x: WEB.drop.x - 2, y: WEB.drop.y + WEB.drop.pad + 36 - 2, w: WEB.drop.w + 4, h: 40, r: 6, from: OPT_CLICK - 22, to: OPT_CLICK - 2 },
  { x: webChipX(3) - 4, y: WEB.chipsY - 4, w: 64, h: WEB.chipH + 8, r: 12, from: KIND1 - 22, to: KIND1 - 2 },
  { x: webChipX(4) - 4, y: WEB.chipsY - 4, w: 64, h: WEB.chipH + 8, r: 12, from: KIND2 - 22, to: KIND2 - 2 },
  { x: WEB.tagSel.x - 4, y: WEB.tagSel.y - 4, w: WEB.tagSel.w + 8, h: WEB.tagSel.h + 8, r: 6, from: TAGSEL - 22, to: TAGSEL - 2 },
  { x: WEB.rowX - 4, y: webRowY(0) - 4, w: WEB.rowW + 8, h: 50, r: 8, from: ROW_CLICK - 22, to: ROW_CLICK - 2 },
  { x: 306, y: 590, w: 160, h: 36, r: 4, from: PURGE_CLICK - 22, to: PURGE_CLICK - 2 },
  { x: 1066, y: 667, w: 100, h: 40, r: 4, from: CFM_OK - 22, to: CFM_OK - 2 },
];

/* ============ 工具 ============ */
const inSpan = (frame: number, a: number, b: number): boolean => frame >= a && frame < b;
const fade = (frame: number, a: number, b: number): number =>
  interpolate(frame, [a, b], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
const dlgFade = (frame: number, at: number, ok: number): number =>
  interpolate(frame, [at + 8, at + 18, ok + 2, ok + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

/* ============ 时间线行状态(全量列表) ============ */
export interface TlRowStateA { tag?: string; region: number; opacity: number }
export interface TlRowStateB { i: number; tag?: string; region: number }

export function tlRowsAt(frame: number, st: Wb9State): { rowsA: TlRowStateA[]; rowsB: TlRowStateB[] } {
  const rowsA: TlRowStateA[] = ROWS.map((row, i) => {
    const at = ROW0_AT + i * ROW_STEP;
    const opacity = frame >= at ? fade(frame, at, at + 10) : 0;
    const tag = (row.id === 't1' && st.tag1) || (row.id === 't5' && st.tag2) ? DEMO.tag1Name : undefined;
    const region = row.region ? st.regionT : 0;
    return { tag, region, opacity };
  });
  const rowsB: TlRowStateB[] = [];
  rowsA.forEach((r, i) => {
    if (r.tag || r.region > 0.05) rowsB.push({ i, tag: r.tag, region: r.region });
  });
  return { rowsA, rowsB };
}

/* ============ 网页端可见行 ============ */
export function webVisibleRows(w: Web9State): { row: WebRow; idx: number }[] {
  let rows = WEB_ROWS.map((row, idx) => ({ row, idx }));
  if (w.projSel) rows = rows.filter((r) => r.row.proj === 'order');
  const kinds: string[] = [];
  if (w.kindCmd) kinds.push('command');
  if (w.kindUp) kinds.push('file_upload');
  if (kinds.length) rows = rows.filter((r) => kinds.includes(r.row.kind));
  if (w.tagOn) rows = rows.filter((r) => r.row.tag === '发布');
  return rows;
}

/* ============ 状态推导:客户端 ============ */
export function wbAt(frame: number): Wb9State {
  const pageT = fade(frame, SET_AT, SET_AT + 14);
  const tlT = fade(frame, TL_AT, TL_AT + 14);
  const rowsShown = frame >= ROW0_AT ? Math.min(ROWS.length, Math.floor((frame - ROW0_AT) / ROW_STEP) + 1) : 0;

  const menu =
    inSpan(frame, MENU1_AT, TAGBTN1 + 6) ? { y: MENU9_Y1, hover: frame >= TAGBTN1 - 20 }
    : inSpan(frame, MENU2_AT, TAGBTN2 + 6) ? { y: MENU9_Y2, hover: frame >= TAGBTN2 - 20 }
    : null;
  const dlg: Wb9State['dlg'] =
    inSpan(frame, DLG1_AT + 8, OK1 + 8) ? 'tag1'
    : inSpan(frame, DLG2_AT + 8, OK2 + 8) ? 'tag2'
    : null;
  const dlgT = dlg === 'tag1' ? dlgFade(frame, DLG1_AT, OK1) : dlg === 'tag2' ? dlgFade(frame, DLG2_AT, OK2) : 0;
  const typed =
    dlg === 'tag1'
      ? '发布'.slice(0, Math.max(0, Math.min(2, Math.floor((frame - TYPE1) / 14) + 1)))
      : dlg === 'tag2'
        ? '发布'.slice(0, Math.max(0, Math.min(2, Math.floor((frame - TYPE2) / 14) + 1)))
        : '';

  const termChars = Math.max(0, Math.min(20, Math.floor((frame - TERM_TYPE) / 4) + 1));
  const termOut = Math.max(0, Math.min(3, Math.floor((frame - TERM_OUT_AT) / 16) + 1));
  const uploadP = inSpan(frame, UP_AT, UP_DONE) ? interpolate(frame, [UP_AT, UP_DONE], [0.12, 0.86], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : null;

  const hover: H9 =
    inSpan(frame, ACT_CLICK - 24, ACT_CLICK) ? 'actTl'
    : inSpan(frame, RCT1 - 24, RCT1) ? 'rowTag1'
    : inSpan(frame, RCT2 - 24, RCT2) ? 'rowTag2'
    : inSpan(frame, TAGBTN1 - 20, TAGBTN1) || inSpan(frame, TAGBTN2 - 20, TAGBTN2) ? 'menuItem'
    : inSpan(frame, OK1 - 24, OK1) || inSpan(frame, OK2 - 24, OK2) ? 'dlgOk'
    : inSpan(frame, CHIP_CLICK - 24, CHIP_CLICK) ? 'tagChip'
    : inSpan(frame, AI_CLICK - 24, AI_CLICK) ? 'aiBtn'
    : inSpan(frame, ACHK - 24, ACHK) ? 'anaCheck'
    : inSpan(frame, AOK - 24, AOK) ? 'anaOk'
    : inSpan(frame, SAVE_CLICK - 24, SAVE_CLICK) ? 'askSave'
    : inSpan(frame, SET_CLICK - 24, SET_CLICK) ? 'setNav'
    : inSpan(frame, PURGE_CLICK - 24, PURGE_CLICK) ? 'purgeBtn'
    : inSpan(frame, CFM_OK - 24, CFM_OK) ? 'cfmOk'
    : null;
  const press: H9 =
    inSpan(frame, ACT_CLICK, ACT_CLICK + 6) ? 'actTl'
    : inSpan(frame, TAGBTN1, TAGBTN1 + 6) || inSpan(frame, TAGBTN2, TAGBTN2 + 6) ? 'menuItem'
    : inSpan(frame, OK1, OK1 + 6) || inSpan(frame, OK2, OK2 + 6) ? 'dlgOk'
    : inSpan(frame, CHIP_CLICK, CHIP_CLICK + 6) ? 'tagChip'
    : inSpan(frame, AI_CLICK, AI_CLICK + 6) ? 'aiBtn'
    : inSpan(frame, ACHK, ACHK + 6) ? 'anaCheck'
    : inSpan(frame, AOK, AOK + 6) ? 'anaOk'
    : inSpan(frame, SAVE_CLICK, SAVE_CLICK + 6) ? 'askSave'
    : inSpan(frame, SET_CLICK, SET_CLICK + 6) ? 'setNav'
    : inSpan(frame, PURGE_CLICK, PURGE_CLICK + 6) ? 'purgeBtn'
    : inSpan(frame, CFM_OK, CFM_OK + 6) ? 'cfmOk'
    : null;

  return {
    page: frame >= SET_AT ? 'settings' : 'workbench',
    pageT,
    tlOpen: frame >= TL_AT,
    tlT,
    rowsShown,
    menu,
    dlg,
    dlgT,
    dlgText: typed,
    tag1: frame >= TAG1_AT,
    tag2: frame >= TAG2_AT,
    regionT: fade(frame, TAG2_AT, REGION_END),
    tagFilter: frame >= FILTER_AT,
    filterT: fade(frame, FILTER_AT, FILTER_AT + 24),
    termChars,
    termOut,
    uploadP,
    analyzeDlg: inSpan(frame, ADLG_AT + 8, AOK + 8),
    analyzeT: dlgFade(frame, ADLG_AT, AOK),
    anaChecked: frame >= ACHK + 6,
    aiView: frame >= AI_VIEW ? 'analysis' : 'history',
    aiUserT: fade(frame, AI_VIEW, AI_VIEW + 12),
    aiTool: frame >= TOOL_AT,
    aiLines: frame < LINES_AT ? 0 : Math.min(6, Math.floor((frame - LINES_AT) / LINE_STEP) + 1),
    askT: fade(frame, ASK_AT, ASK_AT + 12),
    askSaved: frame >= SAVED_AT,
    tipCard: inSpan(frame, TIP_AT, TIP_END),
    purgeDlg: inSpan(frame, CFM_AT + 8, CFM_OK + 8),
    purgeT: dlgFade(frame, CFM_AT, CFM_OK),
    toast: inSpan(frame, CFM_DONE, TOAST_END) ? DEMO.purgeToast : null,
    hover,
    press,
  };
}

/* ============ 状态推导:网页端 ============ */
export function webAt(frame: number): Web9State {
  const projSel = frame >= DROP_DONE;
  const kindCmd = frame >= KIND1 + 6;
  const kindUp = frame >= KIND2 + 6;
  const tagOn = frame >= TAGSEL + 6;
  const refreshAt = tagOn ? REFRESH3 : kindUp ? REFRESH2 : projSel ? REFRESH1 : 0;
  const hover: W9 =
    inSpan(frame, SEL_CLICK - 24, SEL_CLICK) ? 'projSel'
    : inSpan(frame, OPT_CLICK - 42, OPT_CLICK + 6) ? 'projOpt'
    : inSpan(frame, KIND1 - 24, KIND1) ? 'kindCmd'
    : inSpan(frame, KIND2 - 24, KIND2) ? 'kindUp'
    : inSpan(frame, TAGSEL - 24, TAGSEL) ? 'tagSel'
    : inSpan(frame, ROW_CLICK - 24, ROW_CLICK) ? 'row'
    : null;
  const press: W9 =
    inSpan(frame, SEL_CLICK, SEL_CLICK + 6) ? 'projSel'
    : inSpan(frame, OPT_CLICK, OPT_CLICK + 6) ? 'projOpt'
    : inSpan(frame, KIND1, KIND1 + 6) ? 'kindCmd'
    : inSpan(frame, KIND2, KIND2 + 6) ? 'kindUp'
    : inSpan(frame, TAGSEL, TAGSEL + 6) ? 'tagSel'
    : inSpan(frame, ROW_CLICK, ROW_CLICK + 6) ? 'row'
    : null;
  return {
    dropOpen: inSpan(frame, DROP_AT, OPT_CLICK + 6),
    dropT: fade(frame, DROP_AT, DROP_AT + 10),
    dropHover: frame >= OPT_CLICK - 42 ? 1 : -1,
    projSel,
    kindCmd,
    kindUp,
    tagOn,
    refreshAt,
    expanded: frame >= EXP_AT,
    hover,
    press,
  };
}

/* ============ 收尾分屏状态 ============ */
export function finaleWb(): Wb9State {
  const base = wbAt(DURATION - 1);
  return {
    ...base,
    page: 'workbench',
    pageT: 0,
    tlOpen: true,
    tlT: 1,
    rowsShown: ROWS.length,
    menu: null,
    dlg: null,
    tag1: true,
    tag2: true,
    regionT: 1,
    tagFilter: true,
    filterT: 1,
    termChars: 0,
    termOut: 0,
    uploadP: null,
    analyzeDlg: false,
    analyzeT: 0,
    anaChecked: true,
    aiView: 'analysis',
    aiUserT: 1,
    aiTool: true,
    aiLines: 6,
    askT: 1,
    askSaved: true,
    tipCard: false,
    purgeDlg: false,
    toast: null,
    hover: null,
    press: null,
  };
}

export function finaleWeb(): Web9State {
  return {
    dropOpen: false,
    dropT: 0,
    dropHover: -1,
    projSel: true,
    kindCmd: true,
    kindUp: true,
    tagOn: true,
    refreshAt: 0,
    expanded: true,
    hover: null,
    press: null,
  };
}

/* 引用防抖 */
void webVisibleRows;
void tlRowsAt;
