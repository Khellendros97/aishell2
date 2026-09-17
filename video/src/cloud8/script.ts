/**
 * 视频八导演脚本:云同步与云备份全流程的帧级编排。
 * 剧情线(30fps,约 120s):
 *   A    0–460   顶栏「账号」→ 云同步页(未初始化)→ 设置同步密码弹窗
 *   B   660–890  初始化成功 → 立即同步 → 配置规模卡填充
 *   C  1420–2000 工作台:资源管理器右键 dataset → 备份到云端 → 确认框 → 底栏进度
 *   D  2100–2810 回账号页:备份条目出现 → 锁定(名称隐藏)→ 解锁(输入同一密码)
 *   E  3040–3200 恢复备份:选目录 + 同名策略 → 开始恢复
 *   F  3260–3600 设备管理 + 收尾全景
 */
import { interpolate } from 'remotion';
import { Stop, track1 } from '../anim';
import { AnchorStop } from '../components/anchors';
import { Click } from '../components/Cursor';
import {
  ACC, CHAT_HISTORY, CFM8_BTN, ChatItem, ChatSpec, DEMO, EXPL_MENU, MENU_BACKUP, PWD8_F, RST8_F,
  TOP_NAV, explMenuItemCy, explRowY, stackChat,
} from './layout';
import { Wb8State } from './Wb8';

/* ============ 关键帧 ============ */
const ACC_CLICK = 230;
const PAGE_AT = 238;
const PWD_CLICK = 460;
const PWD_DLG = 468;
const PWD_TYPE = 530;
const PWD_OK = 660;
const INIT_AT = 666;
const SYNC_CLICK = 890;
const SYNCING_AT = 896;
const SYNC_DONE = 1070;
const PROJ_CLICK = 1420;
const WB_AT = 1428;
const RCT_CLICK = 1550;
const MENU_AT = 1556;
const BK_CLICK = 1660;
const CFM_AT = 1668;
const CFM_OK = 1790;
const CFM_DONE = 1798;
const PROG_AT = 1800;
const PROG_DONE = 2000;
const ACC2_CLICK = 2100;
const PAGE2_AT = 2108;
const LOCK_CLICK = 2260;
const LOCK_AT = 2266;
const UNLOCK_CLICK = 2620;
const PWD2_AT = 2628;
const PWD2_TYPE = 2690;
const UNLOCK_OK = 2810;
const UNLOCKED_AT = 2816;
const RST_CLICK = 3040;
const RST_AT = 3048;
const RST_OK = 3190;
const RST_DONE = 3198;
export const DURATION = 3600;

/* ============ 摄像机轨道 ============ */
export const CAM_S: readonly Stop[] = [
  { f: 0, v: 0.78 }, { f: 300, v: 0.78 }, { f: 360, v: 0.9 }, { f: 460, v: 0.9 },
  { f: 520, v: 1.2 }, { f: 660, v: 1.2 }, { f: 780, v: 0.9 }, { f: 1000, v: 0.9 },
  { f: 1350, v: 0.78 }, { f: 1480, v: 0.85 }, { f: 1540, v: 1.3 }, { f: 1660, v: 1.3 },
  { f: 1720, v: 1.25 }, { f: 1790, v: 1.25 }, { f: 1850, v: 1.15 }, { f: 2080, v: 1.15 },
  { f: 2140, v: 0.78 }, { f: 2220, v: 0.9 }, { f: 2620, v: 0.9 }, { f: 2680, v: 1.2 },
  { f: 2810, v: 1.2 }, { f: 2900, v: 0.9 }, { f: 3040, v: 0.9 }, { f: 3110, v: 1.2 },
  { f: 3190, v: 1.2 }, { f: 3270, v: 1.0 }, { f: 3520, v: 0.78 }, { f: DURATION, v: 0.78 },
];
export const CAM_X: readonly Stop[] = [
  { f: 0, v: 960 }, { f: 300, v: 960 }, { f: 360, v: 860 }, { f: 460, v: 860 },
  { f: 520, v: 960 }, { f: 660, v: 960 }, { f: 780, v: 860 }, { f: 1000, v: 860 },
  { f: 1350, v: 960 }, { f: 1420, v: 960 }, { f: 1480, v: 944 }, { f: 1540, v: 190 },
  { f: 1660, v: 190 }, { f: 1720, v: 960 }, { f: 1790, v: 960 }, { f: 1850, v: 1000 },
  { f: 2080, v: 1000 }, { f: 2140, v: 960 }, { f: 2220, v: 860 }, { f: 2620, v: 860 },
  { f: 2680, v: 960 }, { f: 2810, v: 960 }, { f: 2900, v: 860 }, { f: 3040, v: 860 },
  { f: 3110, v: 960 }, { f: 3190, v: 960 }, { f: 3270, v: 750 }, { f: 3520, v: 960 },
  { f: DURATION, v: 960 },
];
export const CAM_Y: readonly Stop[] = [
  { f: 0, v: 600 }, { f: 300, v: 600 }, { f: 360, v: 420 }, { f: 460, v: 420 },
  { f: 520, v: 510 }, { f: 660, v: 510 }, { f: 780, v: 420 }, { f: 1000, v: 420 },
  { f: 1350, v: 600 }, { f: 1420, v: 600 }, { f: 1480, v: 620 }, { f: 1540, v: 250 },
  { f: 1660, v: 250 }, { f: 1720, v: 590 }, { f: 1790, v: 590 }, { f: 1850, v: 840 },
  { f: 2080, v: 840 }, { f: 2140, v: 600 }, { f: 2220, v: 420 }, { f: 2620, v: 420 },
  { f: 2680, v: 510 }, { f: 2810, v: 510 }, { f: 2900, v: 420 }, { f: 3040, v: 420 },
  { f: 3110, v: 560 }, { f: 3190, v: 560 }, { f: 3270, v: 620 }, { f: 3520, v: 600 },
  { f: DURATION, v: 600 },
];

/* ============ 消息流(静态历史,承接第五/七段) ============ */
function buildSpecs(): ChatSpec[] {
  return [...CHAT_HISTORY];
}

export function buildItems(): ChatItem[] {
  return stackChat(buildSpecs());
}

/* ============ 动态锚点 ============ */
const ACCOUNT_C = { ...TOP_NAV.account };
const PROJ_C = { ...TOP_NAV.project };
const SETPWD_C = { x: ACC.btnUnlock.x + ACC.btnUnlock.w / 2, y: ACC.btnUnlock.y + ACC.btnUnlock.h / 2 };
const SYNC_C = { x: ACC.btnSync.x + ACC.btnSync.w / 2, y: ACC.btnSync.y + ACC.btnSync.h / 2 };
const LOCK_C = { x: ACC.btnLock.x + ACC.btnLock.w / 2, y: ACC.btnLock.y + ACC.btnLock.h / 2 };
const PWD_INPUT_C = { x: PWD8_F.input.x + PWD8_F.input.w / 2, y: PWD8_F.input.y + PWD8_F.input.h / 2 };
const PWD_OK_C = { x: PWD8_F.btnOk.x + PWD8_F.btnOk.w / 2, y: PWD8_F.btnOk.y + PWD8_F.btnOk.h / 2 };
const DATASET_C = { x: 130, y: explRowY(3) + 13 };
const MENU_BK_C = { x: EXPL_MENU.x + EXPL_MENU.w / 2, y: explMenuItemCy(MENU_BACKUP) };
const CFM_OK_C = { ...CFM8_BTN.ok };
const RST_BTN_C = { x: 1352, y: ACC.bkRow + ACC.bkRowH / 2 };
const RST_OK_C = { x: RST8_F.btnOk.x + RST8_F.btnOk.w / 2, y: RST8_F.btnOk.y + RST8_F.btnOk.h / 2 };

/* ============ 指针轨道(wx/wy 为设计稿兜底坐标,at 为锚点 id 实测优先) ============ */
/** 设计稿窗口坐标 → canvas 兜底坐标(按该帧相机;仅冷启动首帧兜底,实测就绪后即被替换) */
const wfAt = (f: number, wx: number, wy: number): { x: number; y: number } => {
  const s = track1(CAM_S, f);
  const cx0 = track1(CAM_X, f);
  const cy0 = track1(CAM_Y, f);
  return { x: wx * s + (960 - cx0 * s), y: wy * s + (540 - cy0 * s) };
};

const CUR_DEF: readonly { f: number; wx: number; wy: number; at?: string }[] = [
  { f: 30, wx: 1500, wy: 900 },
  { f: ACC_CLICK - 10, wx: ACCOUNT_C.x, wy: ACCOUNT_C.y, at: 'w8-acc-nav' },
  { f: ACC_CLICK, wx: ACCOUNT_C.x, wy: ACCOUNT_C.y, at: 'w8-acc-nav' },
  { f: 440, wx: SETPWD_C.x, wy: SETPWD_C.y, at: 'w8-setpwd' },
  { f: PWD_CLICK, wx: SETPWD_C.x, wy: SETPWD_C.y, at: 'w8-setpwd' },
  { f: PWD_TYPE - 10, wx: PWD_INPUT_C.x, wy: PWD_INPUT_C.y, at: 'w8-pwd-input' },
  { f: PWD_OK - 20, wx: PWD_INPUT_C.x, wy: PWD_INPUT_C.y, at: 'w8-pwd-input' },
  { f: PWD_OK - 10, wx: PWD_OK_C.x, wy: PWD_OK_C.y, at: 'w8-pwd-ok' },
  { f: PWD_OK, wx: PWD_OK_C.x, wy: PWD_OK_C.y, at: 'w8-pwd-ok' },
  { f: SYNC_CLICK - 10, wx: SYNC_C.x, wy: SYNC_C.y, at: 'w8-sync' },
  { f: SYNC_CLICK, wx: SYNC_C.x, wy: SYNC_C.y, at: 'w8-sync' },
  { f: 1150, wx: 1100, wy: 320 },
  { f: PROJ_CLICK - 10, wx: PROJ_C.x, wy: PROJ_C.y, at: 'w8-proj-nav' },
  { f: PROJ_CLICK, wx: PROJ_C.x, wy: PROJ_C.y, at: 'w8-proj-nav' },
  { f: 1510, wx: DATASET_C.x, wy: DATASET_C.y, at: 'w8-dataset' },
  { f: RCT_CLICK, wx: DATASET_C.x, wy: DATASET_C.y, at: 'w8-dataset' },
  { f: BK_CLICK - 10, wx: MENU_BK_C.x, wy: MENU_BK_C.y, at: 'w8-menu-backup' },
  { f: BK_CLICK, wx: MENU_BK_C.x, wy: MENU_BK_C.y, at: 'w8-menu-backup' },
  { f: CFM_OK - 10, wx: CFM_OK_C.x, wy: CFM_OK_C.y, at: 'w8-cfm-ok' },
  { f: CFM_OK, wx: CFM_OK_C.x, wy: CFM_OK_C.y, at: 'w8-cfm-ok' },
  { f: 1930, wx: 1150, wy: 900 },
  { f: ACC2_CLICK - 10, wx: ACCOUNT_C.x, wy: ACCOUNT_C.y, at: 'w8-acc-nav' },
  { f: ACC2_CLICK, wx: ACCOUNT_C.x, wy: ACCOUNT_C.y, at: 'w8-acc-nav' },
  { f: LOCK_CLICK - 10, wx: LOCK_C.x, wy: LOCK_C.y, at: 'w8-lock' },
  { f: LOCK_CLICK, wx: LOCK_C.x, wy: LOCK_C.y, at: 'w8-lock' },
  { f: 2560, wx: 900, wy: 480 },
  { f: UNLOCK_CLICK - 10, wx: SETPWD_C.x, wy: SETPWD_C.y, at: 'w8-setpwd' },
  { f: UNLOCK_CLICK, wx: SETPWD_C.x, wy: SETPWD_C.y, at: 'w8-setpwd' },
  { f: PWD2_TYPE - 10, wx: PWD_INPUT_C.x, wy: PWD_INPUT_C.y, at: 'w8-pwd-input' },
  { f: UNLOCK_OK - 20, wx: PWD_INPUT_C.x, wy: PWD_INPUT_C.y, at: 'w8-pwd-input' },
  { f: UNLOCK_OK - 10, wx: PWD_OK_C.x, wy: PWD_OK_C.y, at: 'w8-pwd-ok' },
  { f: UNLOCK_OK, wx: PWD_OK_C.x, wy: PWD_OK_C.y, at: 'w8-pwd-ok' },
  { f: RST_CLICK - 10, wx: RST_BTN_C.x, wy: RST_BTN_C.y, at: 'w8-restore' },
  { f: RST_CLICK, wx: RST_BTN_C.x, wy: RST_BTN_C.y, at: 'w8-restore' },
  { f: RST_OK - 10, wx: RST_OK_C.x, wy: RST_OK_C.y, at: 'w8-rst-ok' },
  { f: RST_OK, wx: RST_OK_C.x, wy: RST_OK_C.y, at: 'w8-rst-ok' },
  { f: 3350, wx: 500, wy: 470 },
  { f: 3560, wx: 1300, wy: 800 },
  { f: DURATION, wx: 1300, wy: 800 },
];

export const CUR_PATH: readonly AnchorStop[] = CUR_DEF.map(({ f, wx, wy, at }) => ({ f, at, ...wfAt(f, wx, wy) }));

/* ============ 点击(涟漪;anchor 命中实测中心) ============ */
const click = (f: number, wx: number, wy: number, target: Click['target'], anchor?: string): Click => ({
  f, target, anchor, ...wfAt(f, wx, wy),
});
export const CLICKS: readonly Click[] = [
  click(ACC_CLICK, ACCOUNT_C.x, ACCOUNT_C.y, 'browse', 'w8-acc-nav'),
  click(PWD_CLICK, SETPWD_C.x, SETPWD_C.y, 'browse', 'w8-setpwd'),
  click(PWD_CLICK + 4, PWD_INPUT_C.x, PWD_INPUT_C.y, 'input', 'w8-pwd-input'),
  click(PWD_OK, PWD_OK_C.x, PWD_OK_C.y, 'confirm', 'w8-pwd-ok'),
  click(SYNC_CLICK, SYNC_C.x, SYNC_C.y, 'save', 'w8-sync'),
  click(PROJ_CLICK, PROJ_C.x, PROJ_C.y, 'browse', 'w8-proj-nav'),
  click(RCT_CLICK, DATASET_C.x, DATASET_C.y, 'row', 'w8-dataset'),
  click(BK_CLICK, MENU_BK_C.x, MENU_BK_C.y, 'browse', 'w8-menu-backup'),
  click(CFM_OK, CFM_OK_C.x, CFM_OK_C.y, 'confirm', 'w8-cfm-ok'),
  click(ACC2_CLICK, ACCOUNT_C.x, ACCOUNT_C.y, 'browse', 'w8-acc-nav'),
  click(LOCK_CLICK, LOCK_C.x, LOCK_C.y, 'browse', 'w8-lock'),
  click(UNLOCK_CLICK, SETPWD_C.x, SETPWD_C.y, 'browse', 'w8-setpwd'),
  click(UNLOCK_CLICK + 4, PWD_INPUT_C.x, PWD_INPUT_C.y, 'input', 'w8-pwd-input'),
  click(UNLOCK_OK, PWD_OK_C.x, PWD_OK_C.y, 'confirm', 'w8-pwd-ok'),
  click(RST_CLICK, RST_BTN_C.x, RST_BTN_C.y, 'row', 'w8-restore'),
  click(RST_OK, RST_OK_C.x, RST_OK_C.y, 'confirm', 'w8-rst-ok'),
];

/* ============ 字幕 ============ */
export const CAPTIONS8 = [
  { from: 4, to: 150, text: '换电脑、重装系统——配置和数据怎么办？' },
  { from: 260, to: 440, text: '顶栏「账号」→ 云同步' },
  { from: 500, to: 640, text: '同步密码只存本机，用于解锁云端加密数据' },
  { from: 900, to: 1080, text: '立即同步——配置规模一目了然' },
  { from: 1140, to: 1330, text: '项目、服务器、凭据、收藏、隧道，一次同步' },
  { from: 1470, to: 1630, text: '资源管理器右键 → 备份到云端' },
  { from: 1740, to: 1930, text: '确认后加密上传，进度看底栏' },
  { from: 2200, to: 2300, text: '备份已上云——先锁定看看' },
  { from: 2340, to: 2570, text: '锁定后连备份名称都不可见——密钥不出本机' },
  { from: 2660, to: 2800, text: '换新电脑？登录后输入同一密码即可解锁' },
  { from: 3060, to: 3180, text: '恢复：选目录、选同名策略，原样取回' },
  { from: 3270, to: 3430, text: '设备可重命名/撤销；删除云端数据需二次确认' },
  { from: 3490, to: 3585, text: '云同步 + 云备份——换机不丢数据' },
];

/* ============ 教学叠加层 ============ */
export interface Note8 {
  from: number;
  to: number;
  x: number;
  y: number;
  w: number;
  kind: 'info' | 'alert';
  title: string;
  body: string;
}
export const NOTES8: readonly Note8[] = [
  {
    from: 1110, to: 1350, x: 990, y: 420, w: 440, kind: 'info',
    title: '一次同步什么',
    body: '项目、服务器、登录凭据、文件夹、SSH 隧道与收藏整体同步；凭据密码与 SSH 私钥先在本机加密再上传，云端无法解密。',
  },
  {
    from: 2320, to: 2580, x: 990, y: 420, w: 450, kind: 'info',
    title: '端到端加密',
    body: '锁定后本机不再保留明文密钥，云端备份名称也不可见；换新电脑登录同一账号，输入同步密码即可解出密钥、解锁全部数据。',
  },
  {
    from: 3270, to: 3440, x: 800, y: 380, w: 440, kind: 'info',
    title: '设备与删除保护',
    body: '每台设备可重命名、撤销；「删除全部云端数据」需要输入 DELETE_ALL_CLOUD_DATA 二次确认，误触也删不掉。',
  },
];

export const KBD8: readonly { from: number; to: number; x: number; y: number; label: string }[] = [];

/* ============ 焦点高亮环(锚点实测,pad 外扩) ============ */
export const HIGHLIGHTS8 = [
  { target: 'w8-acc-nav', pad: 0, r: 6, from: ACC_CLICK - 22, to: ACC_CLICK - 2 },
  { target: 'w8-setpwd', pad: 4, r: 4, from: PWD_CLICK - 22, to: PWD_CLICK - 2 },
  { target: 'w8-pwd-ok', pad: 6, r: 4, from: PWD_OK - 22, to: PWD_OK - 2 },
  { target: 'w8-sync', pad: 4, r: 4, from: SYNC_CLICK - 22, to: SYNC_CLICK - 2 },
  { target: 'w8-proj-nav', pad: 0, r: 6, from: PROJ_CLICK - 22, to: PROJ_CLICK - 2 },
  { target: 'w8-dataset', pad: 0, r: 4, from: RCT_CLICK - 30, to: RCT_CLICK - 2 },
  { target: 'w8-menu-backup', pad: 0, r: 4, from: BK_CLICK - 22, to: BK_CLICK - 2 },
  { target: 'w8-cfm-ok', pad: 0, r: 4, from: CFM_OK - 22, to: CFM_OK - 2 },
  { target: 'w8-acc-nav', pad: 0, r: 6, from: ACC2_CLICK - 22, to: ACC2_CLICK - 2 },
  { target: 'w8-lock', pad: 4, r: 4, from: LOCK_CLICK - 22, to: LOCK_CLICK - 2 },
  { target: 'w8-setpwd', pad: 4, r: 4, from: UNLOCK_CLICK - 22, to: UNLOCK_CLICK - 2 },
  { target: 'w8-pwd-ok', pad: 6, r: 4, from: UNLOCK_OK - 22, to: UNLOCK_OK - 2 },
  { target: 'w8-restore', pad: 4, r: 4, from: RST_CLICK - 22, to: RST_CLICK - 2 },
  { target: 'w8-rst-ok', pad: 6, r: 4, from: RST_OK - 22, to: RST_OK - 2 },
] as const;

/* ============ 工具 ============ */
const typed = (frame: number, from: number, step: number, full: string): string =>
  full.slice(0, Math.max(0, Math.min(full.length, Math.floor((frame - from) / step) + 1)));

const inSpan = (frame: number, a: number, b: number): boolean => frame >= a && frame < b;

/* ============ 状态推导 ============ */
export function wbAt(frame: number): Wb8State {
  /* ---- 页面切换(账号 ⇄ 工作台) ---- */
  const inAccount = (frame >= PAGE_AT && frame < WB_AT) || frame >= PAGE2_AT;
  const page: Wb8State['page'] = inAccount ? 'account' : 'workbench';
  const pageT = inAccount
    ? interpolate(
        frame,
        frame >= PAGE2_AT ? [PAGE2_AT, PAGE2_AT + 14] : [PAGE_AT, PAGE_AT + 14],
        [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      )
    : interpolate(frame, [WB_AT, WB_AT + 14], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  /* ---- 云同步状态机 ---- */
  const initialized = frame >= INIT_AT;
  const locked = !initialized || (frame >= LOCK_AT && frame < UNLOCKED_AT);
  const syncing = inSpan(frame, SYNCING_AT, SYNC_DONE);
  const counts = frame >= SYNC_DONE;
  const backupEntry = frame >= PAGE2_AT - 40;

  /* ---- 弹窗 ---- */
  const pwdDlg: Wb8State['pwdDlg'] =
    inSpan(frame, PWD_DLG + 8, PWD_OK + 8) ? 'init'
    : inSpan(frame, PWD2_AT + 8, UNLOCK_OK + 8) ? 'unlock'
    : null;
  const pwdT =
    pwdDlg === 'init'
      ? interpolate(frame, [PWD_DLG + 8, PWD_DLG + 18, PWD_OK + 2, PWD_OK + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
      : pwdDlg === 'unlock'
        ? interpolate(frame, [PWD2_AT + 8, PWD2_AT + 18, UNLOCK_OK + 2, UNLOCK_OK + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : 0;
  const pwdText =
    pwdDlg === 'init'
      ? typed(frame, PWD_TYPE, 9, DEMO.pwdDots)
      : pwdDlg === 'unlock'
        ? typed(frame, PWD2_TYPE, 9, DEMO.pwdDots)
        : '';
  const cfm = inSpan(frame, CFM_AT + 8, CFM_OK + 8);
  const cfmT = cfm
    ? interpolate(frame, [CFM_AT + 8, CFM_AT + 18, CFM_OK + 2, CFM_OK + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 0;
  const rst = inSpan(frame, RST_AT + 8, RST_OK + 8);
  const rstT = rst
    ? interpolate(frame, [RST_AT + 8, RST_AT + 18, RST_OK + 2, RST_OK + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 0;

  /* ---- toast ---- */
  const toast =
    inSpan(frame, INIT_AT, INIT_AT + 170) ? '云同步已初始化'
    : inSpan(frame, CFM_DONE, CFM_DONE + 170) ? '云备份任务已启动（bk_7f3a92）'
    : inSpan(frame, UNLOCKED_AT, UNLOCKED_AT + 170) ? '云同步已解锁'
    : inSpan(frame, RST_DONE, RST_DONE + 170) ? '恢复任务已启动，请在状态栏查看进度'
    : null;

  /* ---- 底栏进度 ---- */
  const inProgress = inSpan(frame, PROG_AT, PROG_DONE);
  const progress = !inProgress ? null : frame < PROG_AT + 40 ? 0.08 : interpolate(frame, [PROG_AT + 40, PROG_DONE], [0.15, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const progressDetail = frame < PROG_AT + 40
    ? 'dataset · 已处理 21 / 128 个文件'
    : 'dataset/raw-0042.bin · 1.5 GB / 2.4 GB';

  /* ---- 右键菜单 ---- */
  const menu = inSpan(frame, MENU_AT, BK_CLICK + 6)
    ? { open: true, hover: inSpan(frame, 1610, BK_CLICK) ? MENU_BACKUP : -1 }
    : null;

  const items = buildItems();

  /* ---- hover / press ---- */
  const hover: Wb8State['hover'] =
    inSpan(frame, ACC_CLICK - 24, ACC_CLICK) || inSpan(frame, ACC2_CLICK - 24, ACC2_CLICK) ? 'accountNav'
    : inSpan(frame, PROJ_CLICK - 24, PROJ_CLICK) ? 'projNav'
    : inSpan(frame, 1500, RCT_CLICK) ? 'dataset'
    : inSpan(frame, 1610, BK_CLICK) ? 'menuBackup'
    : inSpan(frame, PWD_CLICK - 24, PWD_CLICK) || inSpan(frame, UNLOCK_CLICK - 24, UNLOCK_CLICK) ? 'setPwd'
    : inSpan(frame, PWD_OK - 24, PWD_OK) || inSpan(frame, UNLOCK_OK - 24, UNLOCK_OK) ? 'pwdOk'
    : inSpan(frame, SYNC_CLICK - 24, SYNC_CLICK) ? 'sync'
    : inSpan(frame, LOCK_CLICK - 24, LOCK_CLICK) ? 'lock'
    : inSpan(frame, RST_CLICK - 24, RST_CLICK) ? 'restore'
    : inSpan(frame, RST_OK - 24, RST_OK) ? 'rstOk'
    : inSpan(frame, CFM_OK - 24, CFM_OK) ? 'cfmOk'
    : null;
  const press: Wb8State['hover'] =
    inSpan(frame, ACC_CLICK, ACC_CLICK + 6) || inSpan(frame, ACC2_CLICK, ACC2_CLICK + 6) ? 'accountNav'
    : inSpan(frame, PROJ_CLICK, PROJ_CLICK + 6) ? 'projNav'
    : inSpan(frame, RCT_CLICK, RCT_CLICK + 6) ? 'dataset'
    : inSpan(frame, BK_CLICK, BK_CLICK + 6) ? 'menuBackup'
    : inSpan(frame, PWD_CLICK, PWD_CLICK + 6) || inSpan(frame, UNLOCK_CLICK, UNLOCK_CLICK + 6) ? 'setPwd'
    : inSpan(frame, PWD_OK, PWD_OK + 6) || inSpan(frame, UNLOCK_OK, UNLOCK_OK + 6) ? 'pwdOk'
    : inSpan(frame, SYNC_CLICK, SYNC_CLICK + 6) ? 'sync'
    : inSpan(frame, LOCK_CLICK, LOCK_CLICK + 6) ? 'lock'
    : inSpan(frame, RST_CLICK, RST_CLICK + 6) ? 'restore'
    : inSpan(frame, RST_OK, RST_OK + 6) ? 'rstOk'
    : inSpan(frame, CFM_OK, CFM_OK + 6) ? 'cfmOk'
    : null;

  return {
    page,
    pageT,
    initialized,
    locked,
    syncing,
    counts,
    backupEntry,
    backupLocked: locked,
    pwdDlg,
    pwdT,
    pwdText,
    cfm,
    cfmT,
    rst,
    rstT,
    toast,
    progress,
    progressDetail,
    menu,
    items,
    hover,
    press,
  };
}

/* 引用防抖 */
void ACC.navItemX;
