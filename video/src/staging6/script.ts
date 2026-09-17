/**
 * 视频六导演脚本:文件暂存功能全流程的帧级编排。
 * 剧情线(30fps,约 99s,承接第五段结尾——AI 已改完 index.html):
 *   A    0–470   act2 编辑文件执行完成 → 「已暂存 1 个文件修改」提示条滑入
 *   B   470–870  用户追加修改 theme.css → 提示条更新为 2 个
 *   C   870–1100 点击提示条 → 「文件暂存区」标签页打开(两条目表格)
 *   D  1100–1380 比较差异 → diff 标签(首次快照 vs 当前内容,删红/增绿)
 *   E  1380–1740 导出 → 导出备份对话框 → 本地 .aishell/backup/ 落盘
 *   F  1740–2100 还原 → 危险确认框 → 远程恢复为首次快照(条目保留)
 *   G  2100–2420 接受 → 确认框 → 清除 index.html 条目(计数 2→1)
 *   H  2420–2790 会话绑定:新建会话(提示条消失)→ 切回原会话(提示条重现)
 *   G  2790–2960 收尾全景
 */
import { interpolate } from 'remotion';
import { Stop, track1 } from '../anim';
import { AnchorStop } from '../components/anchors';
import { Click } from '../components/Cursor';
import {
  ChatItem, ChatSpec, DEMO, DIFF, EXP_BTN, NOTICE, SES_NEW, SES_SELECT, STG, TAB_STAGING_X, TAB_W,
  U2, sesMenuItemCy, stackChat, stgBtnAnchor,
} from './layout';
import { Wb6State } from './Wb6';

/* ============ 关键帧 ============ */
const ACT2_T = 170;
const ACT2_OK = 260;
const NOTICE_IN = 272;
const U2_CLICK = 480;
const U2_TYPE = 492;
const U2_ENTER = 590;
const AI3_T = 630;
const ACT3_T = 700;
const ACT3_OK = 790;
const NOTICE2_AT = 800;
const STG_CLICK = 880;
const STG_IN = 884;
const DIFF_CLICK = 1100;
const DIFF_IN = 1104;
const BACK_CLICK = 1360;
const BACK_AT = 1364;
const EXP_CLICK = 1430;
const EXP_DLG = 1434;
const EXP_OK = 1560;
const EXP_DONE = 1572;
const RES_CLICK = 1810;
const RES_DLG = 1814;
const RES_OK = 1950;
const RES_DONE = 1962;
const ACC_CLICK = 2110;
const ACC_DLG = 2114;
const ACC_OK = 2250;
const ACC_DONE = 2262;
const NEWSES_CLICK = 2440;
const SES_MENU_CLICK = 2540;
const BACKSES_CLICK = 2640;
const BACKSES_AT = 2648;
export const DURATION = 2960;

/* ============ 摄像机轨道 ============ */
export const CAM_S: readonly Stop[] = [
  { f: 0, v: 0.75 }, { f: 140, v: 0.75 }, { f: 180, v: 1.35 }, { f: 300, v: 1.45 },
  { f: 470, v: 1.45 }, { f: 500, v: 1.45 }, { f: 640, v: 1.4 }, { f: 800, v: 1.4 },
  { f: 840, v: 1.45 }, { f: 870, v: 1.45 }, { f: 920, v: 1.0 }, { f: 1090, v: 1.0 },
  { f: 1130, v: 1.2 }, { f: 1330, v: 1.2 }, { f: 1380, v: 1.0 }, { f: 1420, v: 1.3 },
  { f: 1570, v: 1.3 }, { f: 1590, v: 1.15 }, { f: 1740, v: 1.0 }, { f: 1810, v: 1.3 },
  { f: 1960, v: 1.3 }, { f: 1990, v: 1.15 }, { f: 2100, v: 1.0 }, { f: 2110, v: 1.3 },
  { f: 2260, v: 1.3 }, { f: 2290, v: 1.2 }, { f: 2410, v: 1.0 }, { f: 2450, v: 1.3 },
  { f: 2620, v: 1.3 }, { f: 2700, v: 1.35 }, { f: 2790, v: 1.35 }, { f: 2840, v: 0.75 },
  { f: DURATION, v: 0.75 },
];
export const CAM_X: readonly Stop[] = [
  { f: 0, v: 960 }, { f: 140, v: 960 }, { f: 180, v: 1750 }, { f: 300, v: 1750 },
  { f: 470, v: 1750 }, { f: 500, v: 1750 }, { f: 640, v: 1750 }, { f: 800, v: 1750 },
  { f: 840, v: 1750 }, { f: 870, v: 1750 }, { f: 920, v: 944 }, { f: 1090, v: 944 },
  { f: 1130, v: 944 }, { f: 1330, v: 944 }, { f: 1380, v: 944 }, { f: 1420, v: 960 },
  { f: 1570, v: 960 }, { f: 1590, v: 1300 }, { f: 1740, v: 944 }, { f: 1810, v: 960 },
  { f: 1960, v: 960 }, { f: 1990, v: 1300 }, { f: 2100, v: 944 }, { f: 2110, v: 960 },
  { f: 2260, v: 960 }, { f: 2290, v: 944 }, { f: 2410, v: 944 }, { f: 2450, v: 1750 },
  { f: 2620, v: 1750 }, { f: 2700, v: 1750 }, { f: 2790, v: 1750 }, { f: 2840, v: 960 },
  { f: DURATION, v: 960 },
];
export const CAM_Y: readonly Stop[] = [
  { f: 0, v: 600 }, { f: 140, v: 600 }, { f: 180, v: 760 }, { f: 300, v: 1030 },
  { f: 470, v: 1030 }, { f: 500, v: 1060 }, { f: 640, v: 900 }, { f: 800, v: 900 },
  { f: 840, v: 1030 }, { f: 870, v: 1030 }, { f: 920, v: 620 }, { f: 1090, v: 620 },
  { f: 1130, v: 400 }, { f: 1330, v: 400 }, { f: 1380, v: 620 }, { f: 1420, v: 590 },
  { f: 1570, v: 590 }, { f: 1590, v: 780 }, { f: 1740, v: 620 }, { f: 1810, v: 590 },
  { f: 1960, v: 590 }, { f: 1990, v: 780 }, { f: 2100, v: 620 }, { f: 2110, v: 590 },
  { f: 2260, v: 590 }, { f: 2290, v: 480 }, { f: 2410, v: 620 }, { f: 2450, v: 420 },
  { f: 2620, v: 420 }, { f: 2700, v: 900 }, { f: 2790, v: 900 }, { f: 2840, v: 600 },
  { f: DURATION, v: 600 },
];

/* ============ 消息流(会话 s1;新会话为空) ============ */
function buildSpecs(frame: number): ChatSpec[] {
  const specs: ChatSpec[] = [];
  /* —— 第五段遗留历史 —— */
  specs.push({ kind: 'user', id: 'u1', chip: '@browser:#hero-title', lines: ['把这个标题改成品牌蓝，', '按钮改成胶囊圆角'] });
  specs.push({ kind: 'ai', id: 'ai1', lines: ['好的，该网站 IP 10.21.36.8 命中服务器', 'deephaven-dev-01，先定位部署目录。'] });
  specs.push({ kind: 'action', id: 'act1', status: 'succeeded', spec: { name: '执行命令', icon: 'wrench', cmd: 'ssh deploy@10.21.36.8 "ls /var/www"', result: '/var/www/nebula' } });
  specs.push({ kind: 'ai', id: 'ai2', lines: ['已定位部署目录 /var/www/nebula，', '正在修改 index.html。'] });
  /* —— 本片:first act2 完成 → 触发暂存 —— */
  if (frame >= ACT2_T) {
    specs.push({
      kind: 'action', id: 'act2',
      status: frame < ACT2_OK ? 'running' : 'succeeded',
      spec: {
        name: '编辑文件', icon: 'wrench',
        intent: '意图：h1 品牌蓝 64px · 按钮胶囊圆角',
        meta: '10.21.36.8:/var/www/nebula/index.html',
        result: '已写入，2 处样式更新',
      },
    });
  }
  if (frame >= U2_ENTER) specs.push({ kind: 'user', id: 'u2', lines: [U2] });
  if (frame >= AI3_T) {
    const typing = frame < AI3_T + 14;
    specs.push({ kind: 'ai', id: 'ai3', typing, lines: ['好的，修改主题样式表 theme.css。'] });
  }
  if (frame >= ACT3_T) {
    specs.push({
      kind: 'action', id: 'act3',
      status: frame < ACT3_OK ? 'running' : 'succeeded',
      spec: {
        name: '编辑文件', icon: 'wrench',
        intent: '意图：调亮按钮悬停色',
        meta: '10.21.36.8:/var/www/nebula/css/theme.css',
        result: '已写入 theme.css',
      },
    });
  }
  return specs;
}

export function buildItems(frame: number): ChatItem[] {
  return stackChat(buildSpecs(frame));
}

/* ============ 动态锚点 ============ */
const NOTICE_ANCHOR = { x: 1750, y: NOTICE.y + NOTICE.h / 2 };
const DIFF_BTN = stgBtnAnchor(0, STG.btnDiff);
const ACCEPT_BTN = stgBtnAnchor(0, STG.btnAccept);
const RESTORE_BTN = stgBtnAnchor(1, STG.btnRestore);
const EXPORT_BTN = stgBtnAnchor(0, STG.btnExport);
const STG_TAB = { x: TAB_STAGING_X + TAB_W / 2, y: 58 };
const SES_NEW_C = { x: SES_NEW.x + SES_NEW.w / 2, y: SES_NEW.y + SES_NEW.h / 2 };
const SES_SEL_C = { x: SES_SELECT.x + SES_SELECT.w / 2, y: SES_SELECT.y + SES_SELECT.h / 2 };
const SES_ITEM0 = { x: SES_SELECT.x + SES_SELECT.w / 2, y: sesMenuItemCy(0) };

/* ============ 指针轨道(wx/wy 为设计稿兜底坐标,at 为锚点 id 实测优先) ============ */
/** 设计稿窗口坐标 → canvas 兜底坐标(按该帧相机;仅冷启动首帧兜底,实测就绪后即被替换) */
const wfAt = (f: number, wx: number, wy: number): { x: number; y: number } => {
  const s = track1(CAM_S, f);
  const cx0 = track1(CAM_X, f);
  const cy0 = track1(CAM_Y, f);
  return { x: wx * s + (960 - cx0 * s), y: wy * s + (540 - cy0 * s) };
};

const CUR_DEF: readonly { f: number; wx: number; wy: number; at?: string }[] = [
  { f: 60, wx: 1450, wy: 900 },
  { f: 160, wx: 1750, wy: 860 },
  { f: 310, wx: 1850, wy: 960 },
  { f: 466, wx: 1750, wy: 1130, at: 'w6-ai-input' },
  { f: 600, wx: 1750, wy: 1130, at: 'w6-ai-input' },
  { f: 620, wx: 1850, wy: 960 },
  { f: 862, wx: NOTICE_ANCHOR.x, wy: NOTICE_ANCHOR.y, at: 'w6-notice' },
  { f: 916, wx: NOTICE_ANCHOR.x, wy: NOTICE_ANCHOR.y, at: 'w6-notice' },
  { f: 958, wx: 700, wy: 300 },
  { f: 1088, wx: DIFF_BTN.x, wy: DIFF_BTN.y, at: 'w6-stg-diff-0' },
  { f: 1146, wx: DIFF_BTN.x, wy: DIFF_BTN.y, at: 'w6-stg-diff-0' },
  { f: 1340, wx: STG_TAB.x, wy: STG_TAB.y, at: 'w6-tab-staging' },
  { f: 1352, wx: STG_TAB.x, wy: STG_TAB.y, at: 'w6-tab-staging' },
  { f: 1420, wx: EXPORT_BTN.x, wy: EXPORT_BTN.y, at: 'w6-stg-export-0' },
  { f: 1478, wx: EXPORT_BTN.x, wy: EXPORT_BTN.y, at: 'w6-stg-export-0' },
  { f: 1546, wx: EXP_BTN.ok.x, wy: EXP_BTN.ok.y, at: 'w6-exp-ok' },
  { f: 1600, wx: EXP_BTN.ok.x, wy: EXP_BTN.ok.y, at: 'w6-exp-ok' },
  { f: 1796, wx: RESTORE_BTN.x, wy: RESTORE_BTN.y, at: 'w6-stg-restore-1' },
  { f: 1854, wx: RESTORE_BTN.x, wy: RESTORE_BTN.y, at: 'w6-stg-restore-1' },
  { f: 1936, wx: 1115, wy: 672, at: 'w6-dlg-ok' },
  { f: 1996, wx: 1115, wy: 672, at: 'w6-dlg-ok' },
  { f: 2096, wx: ACCEPT_BTN.x, wy: ACCEPT_BTN.y, at: 'w6-stg-accept-0' },
  { f: 2154, wx: ACCEPT_BTN.x, wy: ACCEPT_BTN.y, at: 'w6-stg-accept-0' },
  { f: 2236, wx: 1115, wy: 672, at: 'w6-dlg-ok' },
  { f: 2296, wx: 1115, wy: 672, at: 'w6-dlg-ok' },
  { f: 2426, wx: SES_NEW_C.x, wy: SES_NEW_C.y, at: 'w6-ses-new' },
  { f: 2484, wx: SES_NEW_C.x, wy: SES_NEW_C.y, at: 'w6-ses-new' },
  { f: 2526, wx: SES_SEL_C.x, wy: SES_SEL_C.y, at: 'w6-ses-select' },
  { f: 2610, wx: SES_SEL_C.x, wy: SES_SEL_C.y, at: 'w6-ses-select' },
  { f: 2630, wx: SES_ITEM0.x, wy: SES_ITEM0.y, at: 'w6-ses-item-0' },
  { f: 2690, wx: SES_ITEM0.x, wy: SES_ITEM0.y, at: 'w6-ses-item-0' },
  { f: 2760, wx: 1500, wy: 940 },
  { f: 2940, wx: 1500, wy: 940 },
];

export const CUR_PATH: readonly AnchorStop[] = CUR_DEF.map(({ f, wx, wy, at }) => ({ f, at, ...wfAt(f, wx, wy) }));

/* ============ 点击(涟漪;anchor 命中实测中心) ============ */
const click = (f: number, wx: number, wy: number, target: Click['target'], anchor?: string): Click => ({
  f, target, anchor, ...wfAt(f, wx, wy),
});
export const CLICKS: readonly Click[] = [
  click(U2_CLICK, 1750, 1130, 'input', 'w6-ai-input'),
  click(U2_ENTER, 1750, 1130, 'input', 'w6-ai-input'),
  click(STG_CLICK, NOTICE_ANCHOR.x, NOTICE_ANCHOR.y, 'browse', 'w6-notice'),
  click(DIFF_CLICK, DIFF_BTN.x, DIFF_BTN.y, 'row', 'w6-stg-diff-0'),
  click(BACK_CLICK, STG_TAB.x, STG_TAB.y, 'browse', 'w6-tab-staging'),
  click(EXP_CLICK, EXPORT_BTN.x, EXPORT_BTN.y, 'row', 'w6-stg-export-0'),
  click(EXP_OK, EXP_BTN.ok.x, EXP_BTN.ok.y, 'confirm', 'w6-exp-ok'),
  click(RES_CLICK, RESTORE_BTN.x, RESTORE_BTN.y, 'row', 'w6-stg-restore-1'),
  click(RES_OK, 1115, 672, 'confirm', 'w6-dlg-ok'),
  click(ACC_CLICK, ACCEPT_BTN.x, ACCEPT_BTN.y, 'row', 'w6-stg-accept-0'),
  click(ACC_OK, 1115, 672, 'confirm', 'w6-dlg-ok'),
  click(NEWSES_CLICK, SES_NEW_C.x, SES_NEW_C.y, 'browse', 'w6-ses-new'),
  click(SES_MENU_CLICK, SES_SEL_C.x, SES_SEL_C.y, 'browse', 'w6-ses-select'),
  click(BACKSES_CLICK, SES_ITEM0.x, SES_ITEM0.y, 'row', 'w6-ses-item-0'),
];

/* ============ 字幕 ============ */
export const CAPTIONS6 = [
  { from: 4, to: 110, text: '文件暂存区：AI 改动前的自动备份' },
  { from: 190, to: 300, text: 'AI 修改远程文件前，原始内容已自动存入暂存区' },
  { from: 320, to: 460, text: '对话栏底部提示：已暂存，点击查看' },
  { from: 500, to: 620, text: '继续提出修改，各文件的首次快照独立保留' },
  { from: 800, to: 870, text: '暂存提示实时更新' },
  { from: 900, to: 1080, text: '点击提示条，进入文件暂存区面板' },
  { from: 1140, to: 1330, text: '比较差异：首次快照与当前内容并排对照' },
  { from: 1390, to: 1560, text: '导出：把首次快照落为本地备份文件' },
  { from: 1600, to: 1740, text: '备份落在项目 .aishell/backup/ 目录' },
  { from: 1830, to: 1950, text: '还原：把远程文件恢复到修改前，当前修改丢弃' },
  { from: 2130, to: 2250, text: '接受：确认本次修改，清除暂存记录' },
  { from: 2470, to: 2600, text: '暂存区与会话绑定——新建会话生成新暂存区' },
  { from: 2640, to: 2780, text: '切回原会话，暂存区原样保留，可随时查看' },
  { from: 2850, to: 2945, text: '接受、还原、导出、对比——AI 的每次远端改动都有退路' },
];

/* ============ 教学叠加层 ============ */
export interface Note6 {
  from: number;
  to: number;
  x: number;
  y: number;
  w: number;
  kind: 'info' | 'alert';
  title: string;
  body: string;
}
export const NOTES6: readonly Note6[] = [
  {
    from: 200, to: 470, x: 1100, y: 720, w: 460, kind: 'info',
    title: '自动备份',
    body: '自动备份开启后，AI 会话第一次修改远程文件（写命令 / SFTP 覆盖）前自动保存原始快照；同一会话对同一文件的后续修改不覆盖首次快照。',
  },
  {
    from: 1150, to: 1330, x: 1150, y: 560, w: 420, kind: 'info',
    title: '比较差异',
    body: '左侧为首次快照、右侧为当前内容，增删行高亮显示，未变化的上下文自动折叠，双击暂存行也可打开。',
  },
  {
    from: 2470, to: 2720, x: 1150, y: 560, w: 450, kind: 'info',
    title: '与会话绑定',
    body: '暂存区按会话绑定：新建会话会创建新的暂存区；原有暂存区不会被清除，切换会话即可随时查看文件备份，应用重启仍保留。',
  },
];

export const KBD6: readonly { from: number; to: number; x: number; y: number; label: string }[] = [];

/* ============ 焦点高亮环(锚点实测,pad 外扩) ============ */
export const HIGHLIGHTS6 = [
  { target: 'w6-notice', pad: 4, r: 8, from: STG_CLICK - 26, to: STG_CLICK - 2 },
  { target: 'w6-stg-diff-0', pad: 5, r: 4, from: DIFF_CLICK - 26, to: DIFF_CLICK - 2 },
  { target: 'w6-stg-export-0', pad: 5, r: 4, from: EXP_CLICK - 26, to: EXP_CLICK - 2 },
  { target: 'w6-exp-ok', pad: 0, r: 4, from: EXP_OK - 24, to: EXP_OK - 2 },
  { target: 'w6-stg-restore-1', pad: 5, r: 4, from: RES_CLICK - 26, to: RES_CLICK - 2 },
  { target: 'w6-dlg-ok', pad: 0, r: 4, from: RES_OK - 24, to: RES_OK - 2 },
  { target: 'w6-stg-accept-0', pad: 5, r: 4, from: ACC_CLICK - 26, to: ACC_CLICK - 2 },
  { target: 'w6-dlg-ok', pad: 0, r: 4, from: ACC_OK - 24, to: ACC_OK - 2 },
  { target: 'w6-ses-new', pad: 4, r: 6, from: NEWSES_CLICK - 24, to: NEWSES_CLICK - 2 },
  { target: 'w6-ses-select', pad: 4, r: 6, from: SES_MENU_CLICK - 24, to: SES_MENU_CLICK - 2 },
  { target: 'w6-ses-item-0', pad: 4, r: 4, from: BACKSES_CLICK - 24, to: BACKSES_CLICK - 2 },
] as const;

/* ============ 工具 ============ */
const typed = (frame: number, from: number, step: number, full: string): string =>
  full.slice(0, Math.max(0, Math.min(full.length, Math.floor((frame - from) / step) + 1)));

const inSpan = (frame: number, a: number, b: number): boolean => frame >= a && frame < b;

/* ============ 状态推导 ============ */
export function wbAt(frame: number): Wb6State {
  /* ---- 标签页 ---- */
  const stagingTabT = interpolate(frame, [STG_IN, STG_IN + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const diffTabT = interpolate(frame, [DIFF_IN, DIFF_IN + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const centerTab: Wb6State['centerTab'] =
    frame < STG_IN + 6 ? 'browser' : frame < DIFF_IN + 6 ? 'staging' : frame < BACK_AT ? 'diff' : 'staging';

  /* ---- 暂存行(theme.css 在 act3 完成后才入暂存区;接受后 index 行清除) ---- */
  const rowIndex = frame < ACC_OK + 8;
  const rowTheme = frame >= NOTICE2_AT;
  const count = (rowIndex ? 1 : 0) + (rowTheme ? 1 : 0);

  /* ---- 会话 ---- */
  const session: Wb6State['session'] = frame < NEWSES_CLICK + 6 ? 's1' : frame < BACKSES_AT ? 'new' : 's1';
  const sessionMenu = inSpan(frame, SES_MENU_CLICK + 2, BACKSES_CLICK + 6)
    ? { open: true, hover: inSpan(frame, 2610, BACKSES_CLICK) ? 0 : -1 }
    : null;

  /* ---- 「已暂存」提示条 ---- */
  const stagedCount = count;
  const noticeVisible = session === 's1' && stagedCount > 0 && frame >= NOTICE_IN;
  const noticeT = noticeVisible
    ? (frame < NEWSES_CLICK + 6
        ? interpolate(frame, [NOTICE_IN, NOTICE_IN + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : interpolate(frame, [BACKSES_AT, BACKSES_AT + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }))
    : 0;

  /* ---- 聊天 ---- */
  const items = session === 's1' ? stackChat(buildSpecs(frame)) : [];

  /* ---- 输入区 ---- */
  const inputFocus = inSpan(frame, U2_CLICK, U2_ENTER + 4);
  const inputText = inSpan(frame, U2_TYPE, U2_ENTER + 4) ? typed(frame, U2_TYPE, 5, U2) : '';
  const inputCaret = inputFocus && inputText.length > 0;

  /* ---- 对话框 ---- */
  const dialog: Wb6State['dialog'] =
    inSpan(frame, RES_DLG + 8, RES_OK + 8) ? 'restore' : inSpan(frame, ACC_DLG + 8, ACC_OK + 8) ? 'accept' : null;
  const dialogT =
    dialog === 'restore'
      ? interpolate(frame, [RES_DLG + 8, RES_DLG + 18, RES_OK + 2, RES_OK + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
      : dialog === 'accept'
        ? interpolate(frame, [ACC_DLG + 8, ACC_DLG + 18, ACC_OK + 2, ACC_OK + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : 0;
  const exportDlg = inSpan(frame, EXP_DLG + 8, EXP_OK + 8);
  const exportDlgT = exportDlg
    ? interpolate(frame, [EXP_DLG + 8, EXP_DLG + 18, EXP_OK + 2, EXP_OK + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 0;

  /* ---- toast ---- */
  const toast =
    inSpan(frame, EXP_DONE, EXP_DONE + 170) ? `已导出 1 项备份。已导出到：${DEMO.exportTarget}`
    : inSpan(frame, RES_DONE, RES_DONE + 110) ? '已还原到首次修改前的内容'
    : inSpan(frame, ACC_DONE, ACC_DONE + 110) ? '已接受暂存（清除本地条目）'
    : null;

  /* ---- hover / press ---- */
  const hover: Wb6State['hover'] =
    inSpan(frame, 856, STG_CLICK) ? 'notice'
    : inSpan(frame, 1076, DIFF_CLICK) ? 'stgDiff1'
    : inSpan(frame, 1406, EXP_CLICK) ? 'stgExport1'
    : inSpan(frame, 1536, EXP_OK) ? 'expOk'
    : inSpan(frame, 1786, RES_CLICK) ? 'stgRestore2'
    : inSpan(frame, 1926, RES_OK) ? 'resOk'
    : inSpan(frame, 2086, ACC_CLICK) ? 'stgAccept1'
    : inSpan(frame, 2226, ACC_OK) ? 'accOk'
    : inSpan(frame, 2416, NEWSES_CLICK) ? 'sesNew'
    : inSpan(frame, 2516, SES_MENU_CLICK) ? 'sesSelect'
    : inSpan(frame, 2610, BACKSES_CLICK) ? 'sesItem0'
    : inSpan(frame, U2_CLICK - 14, U2_CLICK + 2) ? 'input'
    : null;
  const press: Wb6State['hover'] =
    inSpan(frame, STG_CLICK, STG_CLICK + 6) ? 'notice'
    : inSpan(frame, DIFF_CLICK, DIFF_CLICK + 6) ? 'stgDiff1'
    : inSpan(frame, EXP_CLICK, EXP_CLICK + 6) ? 'stgExport1'
    : inSpan(frame, EXP_OK, EXP_OK + 6) ? 'expOk'
    : inSpan(frame, RES_CLICK, RES_CLICK + 6) ? 'stgRestore2'
    : inSpan(frame, RES_OK, RES_OK + 6) ? 'resOk'
    : inSpan(frame, ACC_CLICK, ACC_CLICK + 6) ? 'stgAccept1'
    : inSpan(frame, ACC_OK, ACC_OK + 6) ? 'accOk'
    : inSpan(frame, NEWSES_CLICK, NEWSES_CLICK + 6) ? 'sesNew'
    : inSpan(frame, SES_MENU_CLICK, SES_MENU_CLICK + 6) ? 'sesSelect'
    : inSpan(frame, BACKSES_CLICK, BACKSES_CLICK + 6) ? 'sesItem0'
    : null;

  return {
    centerTab,
    stagingTabT,
    diffTabT,
    rowIndex,
    rowTheme,
    noticeVisible,
    noticeCount: stagedCount,
    noticeT,
    session,
    sessionMenu,
    items,
    inputText,
    inputCaret,
    inputFocus,
    dialog,
    dialogT,
    exportDlg,
    exportDlgT,
    toast,
    hover,
    press,
  };
}

/* 引用防抖(diff 行几何在 Wb6 内消费) */
void DIFF.lineTop;
