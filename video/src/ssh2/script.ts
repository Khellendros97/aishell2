/**
 * 视频二导演脚本:全部运镜/指针/点击/字幕/场景状态的帧级编排。
 * 状态推导为纯函数(welcomeAt / wbAt),组件只负责渲染。
 * 锚点坐标全部来自 ./layout.ts(与组件 CSS 同源)。
 */
import { interpolate } from 'remotion';
import { Stop } from '../anim';
import { Click } from '../components/Cursor';
import { ChatMsg } from '../components/AiBits';
import { WelcomeState } from './Welcome2';
import { TermBlockState, Wb2State, Wb2Target } from './Wb2';
import {
  ACT,
  AI_INPUT2,
  HISTORY_ACTIONS,
  CARD_PASTE,
  FAV_COPY_BTN,
  FAV_SAVE,
  NEW_PROJ_BTN,
  PM,
  PROJ_CARD3,
  SSH_BTN,
  WORKAREA_CHIP,
} from './layout';

/* ============ 内容常量 ============ */
export const CMD1 = 'uname -a';
export const CMD2 = 'df -h';
export const CMD3 = 'systemctl status deephaven-worker';
export const CMD_CARD = 'journalctl -u deephaven-worker -n 50 --no-pager';
export const ASK = '这个服务运行正常吗？';
export const ANS = '从快照看，deephaven-worker 处于 active (running) 状态，已稳定运行 1 小时 20 分钟，服务正常。如需进一步排查，可查看最近日志：';
export const RESTART = 'sudo systemctl restart ';
export const PASTE_WORD = 'deephaven-worker';
export const FAV_TITLE = 'journalctl -u deephaven-wo…';
export const SNAP_CHIP = '@term:a1b2c';

/** 场景切换帧:436–466 欢迎页淡出,468–498 工作台淡入 */
export const SCENE_A_END = 468;

/* ============ 摄像机轨道 ============ */
export const CAM_S: readonly Stop[] = [
  { f: 0, v: 0.75 }, { f: 125, v: 0.75 }, { f: 160, v: 1.2 }, { f: 400, v: 1.2 }, { f: 424, v: 0.75 },
  { f: 468, v: 0.75 }, { f: 520, v: 0.75 }, { f: 556, v: 1.15 }, { f: 632, v: 1.15 }, { f: 664, v: 1.2 },
  { f: 700, v: 1.5 }, { f: 760, v: 1.4 }, { f: 890, v: 1.4 }, { f: 905, v: 1.45 }, { f: 930, v: 1.45 },
  { f: 965, v: 1.5 }, { f: 1148, v: 1.5 }, { f: 1180, v: 1.4 }, { f: 1284, v: 1.4 }, { f: 1310, v: 1.2 },
  { f: 1375, v: 1.2 }, { f: 1405, v: 1.3 }, { f: 1442, v: 1.3 }, { f: 1475, v: 1.4 }, { f: 1540, v: 1.4 },
  { f: 1570, v: 1.6 }, { f: 1700, v: 1.6 }, { f: 1745, v: 0.75 },
];
export const CAM_X: readonly Stop[] = [
  { f: 0, v: 960 }, { f: 125, v: 960 }, { f: 160, v: 960 }, { f: 400, v: 960 }, { f: 424, v: 960 },
  { f: 468, v: 960 }, { f: 520, v: 960 }, { f: 556, v: 640 }, { f: 632, v: 640 }, { f: 664, v: 1000 },
  { f: 700, v: 1750 }, { f: 760, v: 950 }, { f: 890, v: 950 }, { f: 905, v: 980 }, { f: 930, v: 980 },
  { f: 965, v: 1750 }, { f: 1148, v: 1750 }, { f: 1180, v: 950 }, { f: 1284, v: 950 }, { f: 1310, v: 960 },
  { f: 1375, v: 960 }, { f: 1405, v: 560 }, { f: 1442, v: 560 }, { f: 1475, v: 950 }, { f: 1540, v: 950 },
  { f: 1570, v: 900 }, { f: 1700, v: 900 }, { f: 1745, v: 960 },
];
export const CAM_Y: readonly Stop[] = [
  { f: 0, v: 600 }, { f: 125, v: 600 }, { f: 160, v: 580 }, { f: 400, v: 580 }, { f: 424, v: 600 },
  { f: 468, v: 600 }, { f: 520, v: 600 }, { f: 556, v: 340 }, { f: 632, v: 340 }, { f: 664, v: 400 },
  { f: 700, v: 1000 }, { f: 760, v: 420 }, { f: 890, v: 420 }, { f: 905, v: 460 }, { f: 930, v: 460 },
  { f: 965, v: 1000 }, { f: 1148, v: 1000 }, { f: 1180, v: 500 }, { f: 1284, v: 500 }, { f: 1310, v: 580 },
  { f: 1375, v: 580 }, { f: 1405, v: 340 }, { f: 1442, v: 340 }, { f: 1475, v: 700 }, { f: 1540, v: 700 },
  { f: 1570, v: 620 }, { f: 1700, v: 620 }, { f: 1745, v: 600 },
];

/* ============ 指针轨道 ============ */
const cx = (r: { x: number; w: number }): number => r.x + r.w / 2;
const cy = (r: { y: number; h: number }): number => r.y + r.h / 2;

export const CUR_X: readonly Stop[] = [
  { f: 60, v: 1200 }, { f: 118, v: cx(NEW_PROJ_BTN) }, { f: 132, v: cx(NEW_PROJ_BTN) }, { f: 140, v: cx(PM.nameInput) },
  { f: 176, v: cx(PM.nameInput) }, { f: 200, v: cx(PM.serverAdd) }, { f: 212, v: cx(PM.miniName) }, { f: 250, v: cx(PM.miniHost) },
  { f: 276, v: cx(PM.miniUser) }, { f: 292, v: cx(PM.miniSecret) }, { f: 310, v: cx(PM.miniSecret) }, { f: 330, v: cx(PM.miniSave) },
  { f: 336, v: cx(PM.miniSave) }, { f: 388, v: cx(PM.footSave) }, { f: 400, v: cx(PM.footSave) }, { f: 430, v: cx(PROJ_CARD3) },
  /* 场景 B */
  { f: 470, v: 1200 }, { f: 558, v: ACT.servers.x }, { f: 566, v: ACT.servers.x }, { f: 628, v: cx(SSH_BTN) },
  { f: 640, v: cx(SSH_BTN) }, { f: 670, v: cx(WORKAREA_CHIP) }, { f: 735, v: cx(WORKAREA_CHIP) }, { f: 760, v: 600 },
  /* 场景 C */
  { f: 890, v: 600 }, { f: 905, v: 1450 }, { f: 915, v: HISTORY_ACTIONS.addchat.x }, { f: 935, v: HISTORY_ACTIONS.addchat.x },
  { f: 958, v: cx(AI_INPUT2) }, { f: 1000, v: cx(AI_INPUT2) }, { f: 1010, v: 1865 },
  /* 场景 D */
  { f: 1115, v: 1865 }, { f: 1142, v: CARD_PASTE.x }, { f: 1155, v: CARD_PASTE.x }, { f: 1180, v: 700 },
  /* 场景 E */
  { f: 1255, v: 700 }, { f: 1278, v: HISTORY_ACTIONS.pin.x }, { f: 1290, v: HISTORY_ACTIONS.pin.x }, { f: 1325, v: cx(FAV_SAVE) },
  { f: 1350, v: cx(FAV_SAVE) }, { f: 1372, v: ACT.commands.x }, { f: 1410, v: ACT.commands.x }, { f: 1435, v: cx(FAV_COPY_BTN) },
  { f: 1450, v: cx(FAV_COPY_BTN) }, { f: 1470, v: 700 },
  /* 场景 F */
  { f: 1545, v: 700 }, { f: 1585, v: 344 }, { f: 1605, v: 459 }, { f: 1615, v: 459 }, { f: 1640, v: 694 },
  { f: 1690, v: 694 }, { f: 1710, v: 900 },
];
export const CUR_Y: readonly Stop[] = [
  { f: 60, v: 800 }, { f: 118, v: cy(NEW_PROJ_BTN) }, { f: 132, v: cy(NEW_PROJ_BTN) }, { f: 140, v: cy(PM.nameInput) },
  { f: 176, v: cy(PM.nameInput) }, { f: 200, v: cy(PM.serverAdd) }, { f: 212, v: cy(PM.miniName) }, { f: 250, v: cy(PM.miniHost) },
  { f: 276, v: cy(PM.miniUser) }, { f: 292, v: cy(PM.miniSecret) }, { f: 310, v: cy(PM.miniSecret) }, { f: 330, v: cy(PM.miniSave) },
  { f: 336, v: cy(PM.miniSave) }, { f: 388, v: cy(PM.footSave) }, { f: 400, v: cy(PM.footSave) }, { f: 430, v: cy(PROJ_CARD3) },
  /* 场景 B */
  { f: 470, v: 800 }, { f: 558, v: ACT.servers.y }, { f: 566, v: ACT.servers.y }, { f: 628, v: cy(SSH_BTN) },
  { f: 640, v: cy(SSH_BTN) }, { f: 670, v: cy(WORKAREA_CHIP) }, { f: 735, v: cy(WORKAREA_CHIP) }, { f: 760, v: 220 },
  /* 场景 C */
  { f: 890, v: 220 }, { f: 905, v: 430 }, { f: 915, v: HISTORY_ACTIONS.addchat.y }, { f: 935, v: HISTORY_ACTIONS.addchat.y },
  { f: 958, v: cy(AI_INPUT2) }, { f: 1000, v: cy(AI_INPUT2) }, { f: 1010, v: 985 },
  /* 场景 D */
  { f: 1115, v: 985 }, { f: 1142, v: CARD_PASTE.y }, { f: 1155, v: CARD_PASTE.y }, { f: 1180, v: 562 },
  /* 场景 E */
  { f: 1255, v: 562 }, { f: 1278, v: HISTORY_ACTIONS.pin.y }, { f: 1290, v: HISTORY_ACTIONS.pin.y }, { f: 1325, v: cy(FAV_SAVE) },
  { f: 1350, v: cy(FAV_SAVE) }, { f: 1372, v: ACT.commands.y }, { f: 1410, v: ACT.commands.y }, { f: 1435, v: cy(FAV_COPY_BTN) },
  { f: 1450, v: cy(FAV_COPY_BTN) }, { f: 1470, v: 590 },
  /* 场景 F */
  { f: 1545, v: 590 }, { f: 1585, v: 382 }, { f: 1605, v: 382 }, { f: 1615, v: 382 }, { f: 1640, v: 700 },
  { f: 1690, v: 700 }, { f: 1710, v: 700 },
];

/* ============ 点击(含两次中键) ============ */
export interface Click2 extends Click {
  /** 中键点击(显示「中键」徽标) */
  mid?: boolean;
}
export const CLICKS: readonly Click2[] = [
  { f: 126, x: cx(NEW_PROJ_BTN), y: cy(NEW_PROJ_BTN), target: 'browse' },
  { f: 140, x: cx(PM.nameInput), y: cy(PM.nameInput), target: 'input' },
  { f: 202, x: cx(PM.serverAdd), y: cy(PM.serverAdd), target: 'browse' },
  { f: 214, x: cx(PM.miniName), y: cy(PM.miniName), target: 'input' },
  { f: 250, x: cx(PM.miniHost), y: cy(PM.miniHost), target: 'input' },
  { f: 276, x: cx(PM.miniUser), y: cy(PM.miniUser), target: 'input' },
  { f: 292, x: cx(PM.miniSecret), y: cy(PM.miniSecret), target: 'input' },
  { f: 332, x: cx(PM.miniSave), y: cy(PM.miniSave), target: 'save' },
  { f: 392, x: cx(PM.footSave), y: cy(PM.footSave), target: 'save' },
  { f: 432, x: cx(PROJ_CARD3), y: cy(PROJ_CARD3), target: 'browse' },
  { f: 560, x: ACT.servers.x, y: ACT.servers.y, target: 'browse' },
  { f: 632, x: cx(SSH_BTN), y: cy(SSH_BTN), target: 'browse' },
  { f: 760, x: 600, y: 220, target: 'input' },
  { f: 925, x: HISTORY_ACTIONS.addchat.x, y: HISTORY_ACTIONS.addchat.y, target: 'confirm' },
  { f: 960, x: cx(AI_INPUT2), y: cy(AI_INPUT2), target: 'input' },
  { f: 1145, x: CARD_PASTE.x, y: CARD_PASTE.y, target: 'confirm' },
  { f: 1280, x: HISTORY_ACTIONS.pin.x, y: HISTORY_ACTIONS.pin.y, target: 'save' },
  { f: 1330, x: cx(FAV_SAVE), y: cy(FAV_SAVE), target: 'save' },
  { f: 1375, x: ACT.commands.x, y: ACT.commands.y, target: 'browse' },
  { f: 1438, x: cx(FAV_COPY_BTN), y: cy(FAV_COPY_BTN), target: 'confirm' },
  { f: 1608, x: 459, y: 382, target: 'confirm', mid: true },
  { f: 1680, x: 694, y: 700, target: 'input', mid: true },
];

/* ============ 字幕(全局,间隔 ≥16 帧) ============ */
export const CAPTIONS2 = [
  { from: 4, to: 66, text: '项目配置与 SSH 终端使用' },
  { from: 92, to: 190, text: '新建项目，并添加服务器配置' },
  { from: 210, to: 330, text: '保存服务器，凭据自动创建入库' },
  { from: 398, to: 434, text: '项目创建完成，进入工作台' },
  { from: 505, to: 560, text: '从服务器卡片一键打开 SSH 终端' },
  { from: 640, to: 730, text: '打开终端后，AI 工作区自动切换到远端主机' },
  { from: 746, to: 828, text: '在远端主机执行命令' },
  { from: 890, to: 990, text: '历史命令在终端右侧集中管理，可添加到 AI 对话' },
  { from: 1010, to: 1095, text: 'AI 结合命令快照作答' },
  { from: 1115, to: 1190, text: '命令卡一键粘贴到终端执行' },
  { from: 1255, to: 1345, text: '从历史命令侧栏收藏常用命令' },
  { from: 1380, to: 1460, text: '收藏的命令随时复制到终端执行' },
  { from: 1545, to: 1615, text: '鼠标中键：有选区时复制' },
  { from: 1631, to: 1710, text: '无选区时，中键粘贴到光标处' },
];

/* ============ 中键注释(教学叠加层) ============ */
export const MID_NOTES = [
  { from: 1612, to: 1660, x: 480, y: 410, text: '中键点击：已复制选区' },
  { from: 1684, to: 1730, x: 720, y: 730, text: '中键点击：粘贴到光标处' },
];

/* ============ 场景 A 状态 ============ */
const typed = (frame: number, from: number, to: number, full: string): string =>
  full.slice(0, Math.floor(interpolate(frame, [from, to], [0, full.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })));

export function welcomeAt(frame: number): WelcomeState {
  const inSpan = (a: number, b: number): boolean => frame >= a && frame <= b;
  return {
    modalT: interpolate(frame, [130, 144, 392, 404], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    projName: typed(frame, 142, 172, 'deephaven-bigdata'),
    miniOpen: frame >= 206 && frame < 336,
    miniName: typed(frame, 216, 248, 'deephaven-dev-01'),
    miniHost: typed(frame, 252, 272, '10.21.36.8'),
    miniUser: typed(frame, 278, 290, 'devops'),
    miniSecretLen: Math.floor(interpolate(frame, [294, 306], [0, 8], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })),
    serverSaved: frame >= 336,
    projectSaved: frame >= 396,
    credNoteT: interpolate(frame, [340, 352, 404, 416], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    toast: inSpan(336, 400) ? '服务器已创建并自动选中' : inSpan(398, 434) ? '项目已创建' : null,
    focus: inSpan(140, 174) ? 'name' : inSpan(214, 248) ? 'miniName' : inSpan(250, 272) ? 'miniHost' : inSpan(276, 290) ? 'miniUser' : inSpan(292, 306) ? 'miniSecret' : null,
    hover: inSpan(116, 126) ? 'newProj' : inSpan(196, 202) ? 'serverAdd' : inSpan(320, 332) ? 'miniSave' : inSpan(382, 392) ? 'save' : inSpan(424, 432) ? 'card3' : null,
    press: inSpan(126, 132) ? 'newProj' : inSpan(202, 208) ? 'serverAdd' : inSpan(332, 338) ? 'miniSave' : inSpan(392, 398) ? 'save' : null,
  };
}

/* ============ 场景 B–F 状态 ============ */
const BLOCKS_DEF: { cmd: string; out: { text: string; color?: 'green' | 'dim' | 'yellow' }[] }[] = [
  { cmd: CMD1, out: [{ text: 'Linux deephaven-dev-01 5.10.0-60.139.0.166.oe2203.x86_64 #1 SMP Fri Jul 10 11:23:04 CST 2026 x86_64 GNU/Linux' }] },
  {
    cmd: CMD2,
    out: [
      { text: 'Filesystem      Size  Used Avail Use% Mounted on', color: 'dim' },
      { text: '/dev/vda2        40G   18G   21G  47% /' },
      { text: '/dev/vdb1       200G   96G   95G  51% /data' },
      { text: 'tmpfs            16G     0   16G   0% /dev/shm' },
    ],
  },
  {
    cmd: CMD3,
    out: [
      { text: '● deephaven-worker.service - Deephaven Data Worker' },
      { text: '   Loaded: loaded (/etc/systemd/system/deephaven-worker.service; enabled)', color: 'dim' },
      { text: '   Active: active (running) since Sun 2026-08-30 09:12:44 CST; 1h 20min ago' },
      { text: '   Tasks: 12 (limit: 19192)', color: 'dim' },
      { text: '   Memory: 218.4M', color: 'dim' },
    ],
  },
  {
    cmd: CMD_CARD,
    out: [
      { text: 'Aug 30 10:31:02 deephaven-dev-01 worker[8124]: [INFO] batch#10482 done, 1.2k rows', color: 'dim' },
      { text: 'Aug 30 10:31:12 deephaven-dev-01 worker[8124]: [INFO] batch#10483 done, 0.9k rows', color: 'dim' },
      { text: 'Aug 30 10:31:22 deephaven-dev-01 worker[8124]: [INFO] batch#10484 done, 1.1k rows', color: 'dim' },
      { text: 'Aug 30 10:31:32 deephaven-dev-01 worker[8124]: [INFO] heartbeat ok', color: 'dim' },
    ],
  },
  {
    cmd: CMD_CARD,
    out: [
      { text: 'Aug 30 10:41:02 deephaven-dev-01 worker[8124]: [INFO] batch#10496 done, 1.0k rows', color: 'dim' },
      { text: 'Aug 30 10:41:12 deephaven-dev-01 worker[8124]: [INFO] batch#10497 done, 1.3k rows', color: 'dim' },
      { text: 'Aug 30 10:41:22 deephaven-dev-01 worker[8124]: [INFO] batch#10498 done, 1.2k rows', color: 'dim' },
      { text: 'Aug 30 10:41:32 deephaven-dev-01 worker[8124]: [INFO] heartbeat ok', color: 'dim' },
    ],
  },
  { cmd: `${RESTART}${PASTE_WORD}`, out: [] },
];

/** 各区块出现帧 */
const BLOCK_AT = [788, 815, 880, 1188, 1483, 1698];

export function wbAt(frame: number): Wb2State {
  const inSpan = (a: number, b: number): boolean => frame >= a && frame <= b;

  /* 终端输入行文本 */
  const termInput =
    frame < 762 ? '' :
    inSpan(762, 784) ? typed(frame, 762, 784, CMD1) :
    inSpan(785, 795) ? '' :
    inSpan(796, 810) ? typed(frame, 796, 810, CMD2) :
    inSpan(811, 825) ? '' :
    inSpan(826, 875) ? typed(frame, 826, 875, CMD3) :
    frame < 1152 ? '' :
    frame < 1185 ? CMD_CARD :
    frame < 1442 ? '' :
    frame < 1481 ? CMD_CARD :
    inSpan(1480, 1640) ? '' :
    inSpan(1641, 1675) ? typed(frame, 1641, 1675, RESTART) :
    inSpan(1676, 1679) ? RESTART :
    inSpan(1680, 1688) ? RESTART + typed(frame, 1680, 1688, PASTE_WORD) :
    frame < 1695 ? RESTART + PASTE_WORD : '';

  /* 终端历史抽屉卡片状态 */
  const blocks: TermBlockState[] = [];
  BLOCK_AT.forEach((at, i) => {
    if (frame < at) return;
    const def = BLOCKS_DEF[i];
    blocks.push({
      cmd: def.cmd,
      out: def.out,
      hovered: (i === 2 && inSpan(905, 930)) || (i === 3 && inSpan(1262, 1286)),
      pressAction: i === 2 && inSpan(925, 931) ? 'addchat' : i === 3 && inSpan(1280, 1286) ? 'pin' : null,
    });
  });

  /* AI 消息流 */
  const aiMsgs: ChatMsg[] = [];
  if (frame >= 1002) {
    aiMsgs.push({ role: 'user', chip: SNAP_CHIP, text: ASK });
    if (frame >= 1008) {
      const len = Math.floor(interpolate(frame, [1040, 1095], [0, ANS.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
      aiMsgs.push({
        role: 'ai',
        text: ANS.slice(0, len),
        typing: len === 0,
        cmdCard: frame >= 1098 ? { cmd: CMD_CARD, hovered: inSpan(1125, 1145), pressed: inSpan(1145, 1151) } : undefined,
      });
    }
  }

  return {
    panel: frame < 560 ? 'explorer' : frame < 1379 ? 'servers' : 'commands',
    sshOpen: frame >= 636,
    connectLines: Math.floor(interpolate(frame, [640, 660], [0, 4], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })),
    workarea: frame >= 672 ? 'remote' : 'local',
    workareaFlash: inSpan(672, 700),
    blocks,
    termInput,
    termCaret: inSpan(760, 786) || inSpan(790, 813) || inSpan(820, 878) || inSpan(1152, 1185) || inSpan(1442, 1480) || inSpan(1640, 1695),
    selection:
      frame >= 1585 && frame < 1612
        ? { blockIdx: 2, lineIdx: 0, startCh: 2, endCh: Math.floor(interpolate(frame, [1585, 1605], [2, 18], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })) }
        : null,
    aiMsgs,
    aiInputChip: inSpan(932, 1000) ? SNAP_CHIP : null,
    aiInputText: inSpan(962, 992) ? typed(frame, 962, 992, ASK) : '',
    favModalT: interpolate(frame, [1284, 1298, 1334, 1348], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
    favTitle: FAV_TITLE,
    favCmd: CMD_CARD,
    favSaved: frame >= 1334,
    toast:
      inSpan(928, 990) ? '已添加到 AI 对话' :
      inSpan(1150, 1210) ? '已粘贴到终端' :
      inSpan(1336, 1398) ? '已添加命令收藏' :
      inSpan(1442, 1500) ? '已粘贴到终端' : null,
    hover: wb2Hover(frame),
    press: wb2Press(frame),
  };
}

function wb2Hover(frame: number): Wb2Target {
  const inSpan = (a: number, b: number): boolean => frame >= a && frame < b;
  if (inSpan(556, 560)) return 'actServers';
  if (inSpan(620, 632)) return 'sshBtn';
  if (inSpan(915, 925)) return 'addchat';
  if (inSpan(1125, 1145)) return 'cmdCard';
  if (inSpan(1318, 1330)) return 'favSave';
  if (inSpan(1368, 1375)) return 'actCommands';
  if (inSpan(1428, 1438)) return 'favCopy';
  return null;
}

function wb2Press(frame: number): Wb2Target {
  const inSpan = (a: number, b: number): boolean => frame >= a && frame < b;
  if (inSpan(560, 566)) return 'actServers';
  if (inSpan(632, 638)) return 'sshBtn';
  if (inSpan(925, 931)) return 'addchat';
  if (inSpan(1145, 1151)) return 'cmdCard';
  if (inSpan(1280, 1286)) return 'pin';
  if (inSpan(1330, 1336)) return 'favSave';
  if (inSpan(1375, 1381)) return 'actCommands';
  if (inSpan(1438, 1444)) return 'favCopy';
  return null;
}
