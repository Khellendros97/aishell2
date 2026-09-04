/**
 * 视频七导演脚本:SSH 隧道(SOCKS5 动态代理)+ 内置浏览器联动的帧级编排。
 * 剧情线(30fps,约 115s;2026-09 返工:删除与主题无关的 AI 开场段,AI 面板空置):
 *   A    0–330   开场字幕 → 服务器卡片「更多 → SSH 隧道」打开隧道标签页(空态)
 *   B  380–860   新建隧道(SOCKS5 动态代理,127.0.0.1:1080)→ 保存并启动
 *   C  860–1230  启动成功:绿点运行中 + toast + 底栏角标(低机位)+ SOCKS5 说明卡
 *   D 1230–2020  加场:新建本地转发撞端口 → 冲突确认框「关闭并启动」→ 状态互换
 *   E 2020–2350  停数据库通道 → 启回内网代理(演示启停按钮)
 *   F 2350–3000  设置页:自动启动说明 → 「浏览器」面板启用 SOCKS5 → 选隧道 → 保存
 *   G 3000–3360  回工作台浏览器标签:输入内网地址 → 打开实验室集群管理台
 *   H 3360–3450  收尾全景
 * 运镜原则:每幕一个稳定镜头,幕内 hold,幕间才移动(上一版幕内漂移+穿空区平移被返工)。
 */
import { interpolate } from 'remotion';
import { Stop } from '../anim';
import { Click } from '../components/Cursor';
import {
  BR7, CFM7_BTN, DEMO, PANEL7, SRV, TDIA_F, TUN, TUN_NEW_C, TOP_NAV,
  TAB_BROWSER_X, TAB_W, brMenuItemCy, setNavCy, srvMenuItemCy, tdiaMenuItemCy, tunBtnAnchor,
} from './layout';
import { Wb7State } from './Wb7';

/* ============ 关键帧 ============ */
const MORE_HOVER = 120;
const MORE_CLICK = 170;
const MENU_AT = 174;
const TUN_CLICK = 260;
const TUN_IN = 268;
const NEW1_CLICK = 380;
const NEW1_DLG = 388;
const N1_CLICK = 440;
const N1_TYPE = 460;
const K1_CLICK = 590;
const K1_PICK = 680;
const P1_CLICK = 730;
const P1_TYPE = 750;
const SAVE1 = 850;
const ROW1_IN = 856;
const TOAST1 = 862;
const NEW2_CLICK = 1230;
const NEW2_DLG = 1238;
const N2_CLICK = 1290;
const N2_TYPE = 1310;
const K2_CLICK = 1440;
const K2_PICK = 1530;
const P2_CLICK = 1590;
const P2_TYPE = 1610;
const T2_CLICK = 1700;
const T2_TYPE = 1720;
const SAVE2 = 1820;
const ROW2_IN = 1826;
const CFM_AT = 1828;
const OK2 = 1940;
const SWAP = 1946;
const STOP2 = 2130;
const STOP2_OK = 2136;
const START1 = 2240;
const START1_OK = 2246;
const SET_CLICK = 2350;
const PAGE_AT = 2358;
const NAV_BR = 2620;
const CKB_CLICK = 2680;
const SEL_CLICK = 2750;
const OPT_CLICK = 2840;
const PSAVE = 2910;
const PTOAST = 2916;
const WB_BACK = 3000;
const BTAB_CLICK = 3050;
const ADDR_CLICK = 3120;
const ADDR_TYPE = 3140;
const ADDR_ENTER = 3260;
const SITE_IN = 3290;
export const DURATION = 3450;

/* ============ 摄像机轨道(幕内 hold,幕间移动) ============ */
export const CAM_S: readonly Stop[] = [
  { f: 0, v: 0.78 }, { f: 60, v: 1.3 }, { f: 260, v: 1.3 }, { f: 330, v: 1.0 },
  { f: 420, v: 1.15 }, { f: 850, v: 1.15 }, { f: 920, v: 1.0 }, { f: 1010, v: 1.25 },
  { f: 1180, v: 1.25 }, { f: 1240, v: 1.15 }, { f: 1960, v: 1.15 }, { f: 2020, v: 1.0 },
  { f: 2100, v: 1.2 }, { f: 2300, v: 1.2 }, { f: 2380, v: 1.0 }, { f: 2620, v: 1.0 },
  { f: 2680, v: 1.1 }, { f: 2980, v: 1.1 }, { f: 3040, v: 1.0 }, { f: 3120, v: 1.15 },
  { f: 3300, v: 1.15 }, { f: 3360, v: 0.78 }, { f: DURATION, v: 0.78 },
];
export const CAM_X: readonly Stop[] = [
  { f: 0, v: 960 }, { f: 60, v: 480 }, { f: 260, v: 480 }, { f: 330, v: 944 },
  { f: 420, v: 960 }, { f: 850, v: 960 }, { f: 920, v: 944 }, { f: 1010, v: 1200 },
  { f: 1180, v: 1200 }, { f: 1240, v: 960 }, { f: 1960, v: 960 }, { f: 2020, v: 944 },
  { f: 2100, v: 1050 }, { f: 2300, v: 1050 }, { f: 2380, v: 800 }, { f: 2620, v: 800 },
  { f: 2680, v: 700 }, { f: 2980, v: 700 }, { f: 3040, v: 944 }, { f: 3120, v: 850 },
  { f: 3300, v: 850 }, { f: 3360, v: 960 }, { f: DURATION, v: 960 },
];
export const CAM_Y: readonly Stop[] = [
  { f: 0, v: 600 }, { f: 60, v: 340 }, { f: 260, v: 340 }, { f: 330, v: 560 },
  { f: 420, v: 600 }, { f: 850, v: 600 }, { f: 920, v: 630 }, { f: 1010, v: 1000 },
  { f: 1180, v: 1000 }, { f: 1240, v: 600 }, { f: 1960, v: 600 }, { f: 2020, v: 480 },
  { f: 2100, v: 400 }, { f: 2300, v: 400 }, { f: 2380, v: 500 }, { f: 2620, v: 500 },
  { f: 2680, v: 420 }, { f: 2980, v: 420 }, { f: 3040, v: 620 }, { f: 3120, v: 350 },
  { f: 3300, v: 350 }, { f: 3360, v: 600 }, { f: DURATION, v: 600 },
];

/* ============ 动态锚点 ============ */
const MORE_C = { ...SRV.more };
/* 服务器菜单盒 x104 w188,「SSH 隧道」为第 4 项 */
const MENU_TUNNEL_C = { x: 104 + 188 / 2, y: srvMenuItemCy(3) };
const NAME_C = { x: TDIA_F.nameInput.x + TDIA_F.nameInput.w / 2, y: TDIA_F.nameInput.y + TDIA_F.nameInput.h / 2 };
const KIND_C = { x: TDIA_F.kindSel.x + TDIA_F.kindSel.w / 2, y: TDIA_F.kindSel.y + TDIA_F.kindSel.h / 2 };
const PORT_C = { x: TDIA_F.portInput.x + TDIA_F.portInput.w / 2, y: TDIA_F.portInput.y + TDIA_F.portInput.h / 2 };
const TARGET_C = { x: TDIA_F.targetInput.x + TDIA_F.targetInput.w / 2, y: TDIA_F.targetInput.y + TDIA_F.targetInput.h / 2 };
const SAVEOK_C = { x: TDIA_F.btnOk.x + TDIA_F.btnOk.w / 2, y: TDIA_F.btnOk.y + TDIA_F.btnOk.h / 2 };
const MENU_OPT_LOCAL = { x: KIND_C.x, y: tdiaMenuItemCy(0) };
const MENU_OPT_DYN = { x: KIND_C.x, y: tdiaMenuItemCy(1) };
const CFM_OK_C = { ...CFM7_BTN.ok };
const ROW2_STOP = tunBtnAnchor(1, TUN.btnStop);
const ROW1_TOGGLE = tunBtnAnchor(0, TUN.btnStop);
const SET_NAV_C = { ...TOP_NAV.settings };
const PROJ_NAV_C = { ...TOP_NAV.project };
const NAV_BR_C = { x: 88, y: setNavCy(6) };
const CKB_C = { x: PANEL7.brEnableBox.x + PANEL7.brEnableBox.w / 2, y: PANEL7.brEnableBox.y + PANEL7.brEnableBox.h / 2 };
const SEL_C = { x: PANEL7.brSel.x + PANEL7.brSel.w / 2, y: PANEL7.brSel.y + PANEL7.brSel.h / 2 };
const SEL_OPT_C = { x: PANEL7.brSel.x + PANEL7.brSel.w / 2, y: brMenuItemCy(0) };
const PSAVE_C = { x: PANEL7.brSave.x + PANEL7.brSave.w / 2, y: PANEL7.brSave.y + PANEL7.brSave.h / 2 };
const BTAB_C = { x: TAB_BROWSER_X + TAB_W / 2, y: 58 };
const ADDR_C = { x: BR7.address.x + 20, y: BR7.address.y + BR7.address.h / 2 };

/* ============ 指针轨道 ============ */
const CURVE: readonly (readonly [number, number, number])[] = [
  [30, 1500, 900],
  [MORE_HOVER - 10, MORE_C.x, MORE_C.y],
  [MORE_CLICK, MORE_C.x, MORE_C.y],
  [240, MENU_TUNNEL_C.x, MENU_TUNNEL_C.y],
  [TUN_CLICK, MENU_TUNNEL_C.x, MENU_TUNNEL_C.y],
  [NEW1_CLICK - 10, TUN_NEW_C.x, TUN_NEW_C.y],
  [NEW1_CLICK, TUN_NEW_C.x, TUN_NEW_C.y],
  [N1_CLICK - 10, NAME_C.x, NAME_C.y],
  [N1_CLICK, NAME_C.x, NAME_C.y],
  [K1_CLICK - 10, KIND_C.x, KIND_C.y],
  [K1_CLICK, KIND_C.x, KIND_C.y],
  [K1_PICK - 10, MENU_OPT_DYN.x, MENU_OPT_DYN.y],
  [K1_PICK, MENU_OPT_DYN.x, MENU_OPT_DYN.y],
  [P1_CLICK - 10, PORT_C.x, PORT_C.y],
  [P1_CLICK, PORT_C.x, PORT_C.y],
  [SAVE1 - 10, SAVEOK_C.x, SAVEOK_C.y],
  [SAVE1, SAVEOK_C.x, SAVEOK_C.y],
  [950, 700, 380],
  [NEW2_CLICK - 10, TUN_NEW_C.x, TUN_NEW_C.y],
  [NEW2_CLICK, TUN_NEW_C.x, TUN_NEW_C.y],
  [N2_CLICK - 10, NAME_C.x, NAME_C.y],
  [N2_CLICK, NAME_C.x, NAME_C.y],
  [K2_CLICK - 10, KIND_C.x, KIND_C.y],
  [K2_CLICK, KIND_C.x, KIND_C.y],
  [K2_PICK - 10, MENU_OPT_LOCAL.x, MENU_OPT_LOCAL.y],
  [K2_PICK, MENU_OPT_LOCAL.x, MENU_OPT_LOCAL.y],
  [P2_CLICK - 10, PORT_C.x, PORT_C.y],
  [P2_CLICK, PORT_C.x, PORT_C.y],
  [T2_CLICK - 10, TARGET_C.x, TARGET_C.y],
  [T2_CLICK, TARGET_C.x, TARGET_C.y],
  [SAVE2 - 10, SAVEOK_C.x, SAVEOK_C.y],
  [SAVE2, SAVEOK_C.x, SAVEOK_C.y],
  [OK2 - 10, CFM_OK_C.x, CFM_OK_C.y],
  [OK2, CFM_OK_C.x, CFM_OK_C.y],
  [STOP2 - 10, ROW2_STOP.x, ROW2_STOP.y],
  [STOP2, ROW2_STOP.x, ROW2_STOP.y],
  [2190, 800, 350],
  [START1 - 10, ROW1_TOGGLE.x, ROW1_TOGGLE.y],
  [START1, ROW1_TOGGLE.x, ROW1_TOGGLE.y],
  [2330, SET_NAV_C.x, SET_NAV_C.y],
  [SET_CLICK, SET_NAV_C.x, SET_NAV_C.y],
  [2460, 620, 300],
  [NAV_BR - 10, NAV_BR_C.x, NAV_BR_C.y],
  [NAV_BR, NAV_BR_C.x, NAV_BR_C.y],
  [CKB_CLICK - 10, CKB_C.x, CKB_C.y],
  [CKB_CLICK, CKB_C.x, CKB_C.y],
  [SEL_CLICK - 10, SEL_C.x, SEL_C.y],
  [SEL_CLICK, SEL_C.x, SEL_C.y],
  [OPT_CLICK - 10, SEL_OPT_C.x, SEL_OPT_C.y],
  [OPT_CLICK, SEL_OPT_C.x, SEL_OPT_C.y],
  [PSAVE - 10, PSAVE_C.x, PSAVE_C.y],
  [PSAVE, PSAVE_C.x, PSAVE_C.y],
  [2970, 820, 400],
  [WB_BACK - 10, PROJ_NAV_C.x, PROJ_NAV_C.y],
  [WB_BACK, PROJ_NAV_C.x, PROJ_NAV_C.y],
  [BTAB_CLICK - 10, BTAB_C.x, BTAB_C.y],
  [BTAB_CLICK, BTAB_C.x, BTAB_C.y],
  [ADDR_CLICK - 10, ADDR_C.x, ADDR_C.y],
  [ADDR_CLICK, ADDR_C.x, ADDR_C.y],
  [ADDR_ENTER, ADDR_C.x, ADDR_C.y],
  [3330, 720, 320],
  [3400, 1400, 800],
  [DURATION, 1400, 800],
];
export const CUR_X: readonly Stop[] = CURVE.map(([f, x]) => ({ f, v: x }));
export const CUR_Y: readonly Stop[] = CURVE.map(([f, , y]) => ({ f, v: y }));

/* ============ 点击(涟漪) ============ */
export const CLICKS: readonly Click[] = [
  { f: MORE_CLICK, x: MORE_C.x, y: MORE_C.y, target: 'browse' },
  { f: TUN_CLICK, x: MENU_TUNNEL_C.x, y: MENU_TUNNEL_C.y, target: 'browse' },
  { f: NEW1_CLICK, x: TUN_NEW_C.x, y: TUN_NEW_C.y, target: 'browse' },
  { f: N1_CLICK, x: NAME_C.x, y: NAME_C.y, target: 'input' },
  { f: K1_CLICK, x: KIND_C.x, y: KIND_C.y, target: 'browse' },
  { f: K1_PICK, x: MENU_OPT_DYN.x, y: MENU_OPT_DYN.y, target: 'browse' },
  { f: P1_CLICK, x: PORT_C.x, y: PORT_C.y, target: 'input' },
  { f: SAVE1, x: SAVEOK_C.x, y: SAVEOK_C.y, target: 'save' },
  { f: NEW2_CLICK, x: TUN_NEW_C.x, y: TUN_NEW_C.y, target: 'browse' },
  { f: N2_CLICK, x: NAME_C.x, y: NAME_C.y, target: 'input' },
  { f: K2_CLICK, x: KIND_C.x, y: KIND_C.y, target: 'browse' },
  { f: K2_PICK, x: MENU_OPT_LOCAL.x, y: MENU_OPT_LOCAL.y, target: 'browse' },
  { f: P2_CLICK, x: PORT_C.x, y: PORT_C.y, target: 'input' },
  { f: T2_CLICK, x: TARGET_C.x, y: TARGET_C.y, target: 'input' },
  { f: SAVE2, x: SAVEOK_C.x, y: SAVEOK_C.y, target: 'save' },
  { f: OK2, x: CFM_OK_C.x, y: CFM_OK_C.y, target: 'confirm' },
  { f: STOP2, x: ROW2_STOP.x, y: ROW2_STOP.y, target: 'row' },
  { f: START1, x: ROW1_TOGGLE.x, y: ROW1_TOGGLE.y, target: 'row' },
  { f: SET_CLICK, x: SET_NAV_C.x, y: SET_NAV_C.y, target: 'browse' },
  { f: NAV_BR, x: NAV_BR_C.x, y: NAV_BR_C.y, target: 'browse' },
  { f: CKB_CLICK, x: CKB_C.x, y: CKB_C.y, target: 'browse' },
  { f: SEL_CLICK, x: SEL_C.x, y: SEL_C.y, target: 'browse' },
  { f: OPT_CLICK, x: SEL_OPT_C.x, y: SEL_OPT_C.y, target: 'browse' },
  { f: PSAVE, x: PSAVE_C.x, y: PSAVE_C.y, target: 'save' },
  { f: WB_BACK, x: PROJ_NAV_C.x, y: PROJ_NAV_C.y, target: 'browse' },
  { f: BTAB_CLICK, x: BTAB_C.x, y: BTAB_C.y, target: 'browse' },
  { f: ADDR_CLICK, x: ADDR_C.x, y: ADDR_C.y, target: 'input' },
  { f: ADDR_ENTER, x: ADDR_C.x, y: ADDR_C.y, target: 'input' },
];

/* ============ 字幕 ============ */
export const CAPTIONS7 = [
  { from: 4, to: 150, text: '内网系统只有服务器能访问？SSH 隧道打通它' },
  { from: 180, to: 320, text: '服务器卡片「更多」菜单 → SSH 隧道' },
  { from: 460, to: 700, text: '新建隧道：默认选 SOCKS5 动态代理（-D）' },
  { from: 880, to: 1000, text: '保存即启动——绿点「运行中」' },
  { from: 1030, to: 1170, text: '底栏亮起隧道角标，实时显示运行数量' },
  { from: 1300, to: 1540, text: '再建一条本地转发，本地端口故意撞车' },
  { from: 1860, to: 2020, text: '冲突只在启动时判定——确认后自动关闭占用方' },
  { from: 2140, to: 2330, text: '停掉数据库通道，把内网代理启回来' },
  { from: 2400, to: 2600, text: '「自动启动」：AIShell 重启后隧道自动恢复' },
  { from: 2700, to: 2900, text: '浏览器设置：启用 SOCKS5，选择运行中的隧道' },
  { from: 2920, to: 2990, text: '状态行确认生效；保存后浏览器标签页自动重建' },
  { from: 3160, to: 3310, text: '请求经 SSH 隧道由远端服务器代为访问' },
  { from: 3370, to: 3440, text: 'SSH 隧道 × 内置浏览器，内网系统本地直达' },
];

/* ============ 教学叠加层 ============ */
export interface Note7 {
  from: number;
  to: number;
  x: number;
  y: number;
  w: number;
  kind: 'info' | 'alert';
  title: string;
  body: string;
}
export const NOTES7: readonly Note7[] = [
  {
    from: 915, to: 1140, x: 700, y: 830, w: 440, kind: 'info',
    title: 'SOCKS5 动态代理',
    body: '与固定目标的 -L 不同，-D 的目标地址由客户端在连接时指定：应用把任意请求交给 127.0.0.1:1080，隧道经 SSH 连接在远端代为访问，域名也由远端解析。',
  },
  {
    from: 1860, to: 2050, x: 700, y: 740, w: 420, kind: 'info',
    title: '端口冲突按运行态判定',
    body: '配置允许端口重复；启动时若端口已被其它「运行中」隧道绑定，会询问是否关闭占用方，确认后自动关闭并启动。',
  },
  {
    from: 2400, to: 2600, x: 1100, y: 240, w: 440, kind: 'info',
    title: '隧道自动启动',
    body: '开启时，上次启用的隧道随 AIShell 启动自动恢复；关闭时退出应用会把全部隧道设为禁用，下次不再恢复。',
  },
  {
    from: 2700, to: 2960, x: 1100, y: 300, w: 420, kind: 'info',
    title: '只作用于内置浏览器',
    body: '代理不影响主界面与其他功能；保存后已打开的浏览器标签页自动重建；隧道停止时自动回落直连。',
  },
  {
    from: 3370, to: 3440, x: 1120, y: 680, w: 460, kind: 'info',
    title: '标签页 ≠ 隧道',
    body: '关闭 SSH 隧道标签页不会停止隧道；底栏角标实时显示运行数量，悬停可查看隧道清单。',
  },
];

export const KBD7: readonly { from: number; to: number; x: number; y: number; label: string }[] = [];

/* ============ 焦点高亮环 ============ */
export const HIGHLIGHTS7 = [
  { x: 265, y: 212, w: 28, h: 28, r: 6, from: MORE_CLICK - 24, to: MORE_CLICK - 2 },
  { x: 108, y: 350, w: 180, h: 30, r: 4, from: TUN_CLICK - 24, to: TUN_CLICK - 2 },
  { x: TUN.newBtn.x - 4, y: TUN.newBtn.y - 4, w: TUN.newBtn.w + 8, h: TUN.newBtn.h + 8, r: 4, from: NEW1_CLICK - 24, to: NEW1_CLICK - 2 },
  { x: TDIA_F.nameInput.x - 4, y: TDIA_F.nameInput.y - 4, w: TDIA_F.nameInput.w + 8, h: TDIA_F.nameInput.h + 8, r: 4, from: N1_CLICK - 22, to: N1_CLICK - 2 },
  { x: TDIA_F.kindSel.x - 4, y: TDIA_F.kindSel.y - 4, w: TDIA_F.kindSel.w + 8, h: TDIA_F.kindSel.h + 8, r: 4, from: K1_CLICK - 22, to: K1_CLICK - 2 },
  { x: 722, y: 568, w: 476, h: 30, r: 4, from: K1_PICK - 22, to: K1_PICK - 2 },
  { x: TDIA_F.portInput.x - 4, y: TDIA_F.portInput.y - 4, w: TDIA_F.portInput.w + 8, h: TDIA_F.portInput.h + 8, r: 4, from: P1_CLICK - 22, to: P1_CLICK - 2 },
  { x: TDIA_F.btnOk.x - 6, y: TDIA_F.btnOk.y - 6, w: TDIA_F.btnOk.w + 12, h: TDIA_F.btnOk.h + 12, r: 4, from: SAVE1 - 22, to: SAVE1 - 2 },
  /* 底栏隧道角标(AI 助手按钮左侧,右缘 ~1823) */
  { x: 1795, y: 1175, w: 36, h: 24, r: 6, from: 1030, to: 1140 },
  { x: TUN.newBtn.x - 4, y: TUN.newBtn.y - 4, w: TUN.newBtn.w + 8, h: TUN.newBtn.h + 8, r: 4, from: NEW2_CLICK - 24, to: NEW2_CLICK - 2 },
  { x: TDIA_F.btnOk.x - 6, y: TDIA_F.btnOk.y - 6, w: TDIA_F.btnOk.w + 12, h: TDIA_F.btnOk.h + 12, r: 4, from: SAVE2 - 22, to: SAVE2 - 2 },
  { x: CFM7_BTN.ok.x - 52, y: CFM7_BTN.ok.y - 16, w: 104, h: 32, r: 4, from: OK2 - 22, to: OK2 - 2 },
  { x: TUN.btnStop.x - 5, y: ROW2_STOP.y - 14, w: TUN.btnStop.w + 10, h: 28, r: 4, from: STOP2 - 22, to: STOP2 - 2 },
  { x: TUN.btnStop.x - 5, y: ROW1_TOGGLE.y - 14, w: TUN.btnStop.w + 10, h: 28, r: 4, from: START1 - 22, to: START1 - 2 },
  { x: TOP_NAV.settings.x - 24, y: 7, w: 48, h: 26, r: 6, from: SET_CLICK - 22, to: SET_CLICK - 2 },
  { x: 20, y: setNavCy(6) - 14, w: 140, h: 28, r: 4, from: NAV_BR - 22, to: NAV_BR - 2 },
  { x: PANEL7.brEnableBox.x - 3, y: PANEL7.brEnableBox.y - 3, w: PANEL7.brEnableBox.w + 6, h: PANEL7.brEnableBox.h + 6, r: 4, from: CKB_CLICK - 22, to: CKB_CLICK - 2 },
  { x: PANEL7.brSel.x - 3, y: PANEL7.brSel.y - 3, w: PANEL7.brSel.w + 6, h: PANEL7.brSel.h + 6, r: 4, from: SEL_CLICK - 22, to: SEL_CLICK - 2 },
  { x: 208, y: 370, w: 332, h: 30, r: 4, from: OPT_CLICK - 22, to: OPT_CLICK - 2 },
  { x: PANEL7.brSave.x - 4, y: PANEL7.brSave.y - 4, w: PANEL7.brSave.w + 8, h: PANEL7.brSave.h + 8, r: 4, from: PSAVE - 22, to: PSAVE - 2 },
  { x: TOP_NAV.project.x - 24, y: 7, w: 48, h: 26, r: 6, from: WB_BACK - 22, to: WB_BACK - 2 },
  { x: TAB_BROWSER_X, y: 42, w: TAB_W, h: 30, r: 0, from: BTAB_CLICK - 22, to: BTAB_CLICK - 2 },
  { x: BR7.address.x - 2, y: BR7.address.y - 2, w: BR7.address.w + 4, h: BR7.address.h + 4, r: 4, from: ADDR_CLICK - 22, to: ADDR_CLICK - 2 },
];

/* ============ 工具 ============ */
const typed = (frame: number, from: number, step: number, full: string): string =>
  full.slice(0, Math.max(0, Math.min(full.length, Math.floor((frame - from) / step) + 1)));

const inSpan = (frame: number, a: number, b: number): boolean => frame >= a && frame < b;

/* ============ 状态推导 ============ */
export function wbAt(frame: number): Wb7State {
  /* ---- 页面切换 ---- */
  const pageT = interpolate(frame, [PAGE_AT, PAGE_AT + 14, WB_BACK + 4, WB_BACK + 16], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp',
  });
  const page: Wb7State['page'] = pageT >= 0.5 ? 'settings' : 'workbench';

  /* ---- 标签页 ---- */
  const tunnelTabT = interpolate(frame, [TUN_IN, TUN_IN + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const centerTab: Wb7State['centerTab'] =
    frame < TUN_IN + 6 ? 'terminal' : frame < BTAB_CLICK + 6 ? 'tunnel' : 'browser';

  /* ---- 服务器「更多」菜单 ---- */
  const srvMenu = inSpan(frame, MENU_AT, TUN_CLICK + 6)
    ? { open: true, hover: inSpan(frame, 230, TUN_CLICK) ? 3 : -1 }
    : null;

  /* ---- 隧道行(保存落盘即出现;running 按启动/停止/互换切换) ---- */
  const running1 = (frame >= ROW1_IN && frame < SWAP) || frame >= START1_OK;
  /* 数据库通道:保存落盘(ROW2_IN)即出现但被冲突挡住,确认「关闭并启动」(SWAP)后才运行 */
  const running2 = frame >= SWAP && frame < STOP2_OK;
  const row1 = {
    present: frame >= ROW1_IN,
    running: running1,
    t: interpolate(frame, [ROW1_IN, ROW1_IN + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  };
  const row2 = {
    present: frame >= ROW2_IN,
    running: running2,
    t: interpolate(frame, [ROW2_IN, ROW2_IN + 12], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
  };
  const badge = (running1 ? 1 : 0) + (running2 ? 1 : 0);

  /* ---- 新建隧道模态 ---- */
  const dlg: Wb7State['dlg'] =
    inSpan(frame, NEW1_DLG + 8, SAVE1 + 8) ? 'new1' : inSpan(frame, NEW2_DLG + 8, SAVE2 + 8) ? 'new2' : null;
  const dlgT =
    dlg === 'new1'
      ? interpolate(frame, [NEW1_DLG + 8, NEW1_DLG + 18, SAVE1 + 2, SAVE1 + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
      : dlg === 'new2'
        ? interpolate(frame, [NEW2_DLG + 8, NEW2_DLG + 18, SAVE2 + 2, SAVE2 + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : 0;
  const kindMenuOpen = dlg === 'new1' ? inSpan(frame, K1_CLICK + 2, K1_PICK + 4) : dlg === 'new2' ? inSpan(frame, K2_CLICK + 2, K2_PICK + 4) : false;
  const kindHover = kindMenuOpen ? (dlg === 'new1' ? (inSpan(frame, K1_CLICK + 40, K1_PICK) ? 1 : -1) : inSpan(frame, K2_CLICK + 40, K2_PICK) ? 0 : -1) : -1;

  const f1Name = inSpan(frame, N1_TYPE, SAVE1 + 4) ? typed(frame, N1_TYPE, 6, DEMO.tun1Name) : '';
  const f1Port = inSpan(frame, P1_TYPE, SAVE1 + 4) ? typed(frame, P1_TYPE, 5, DEMO.tun1Port) : '';
  const f2Name = inSpan(frame, N2_TYPE, SAVE2 + 4) ? typed(frame, N2_TYPE, 6, DEMO.tun2Name) : '';
  const f2Kind: Wb7State['f2Kind'] = frame >= K2_PICK + 4 ? 'local' : 'dynamic';
  const f2Port = inSpan(frame, P2_TYPE, SAVE2 + 4) ? typed(frame, P2_TYPE, 5, DEMO.tun2Port) : '';
  const f2Target = inSpan(frame, T2_TYPE, SAVE2 + 4) ? typed(frame, T2_TYPE, 5, DEMO.tun2TargetPort) : '';

  /* ---- 冲突确认框 ---- */
  const cfm = inSpan(frame, CFM_AT + 8, OK2 + 8);
  const cfmT = cfm
    ? interpolate(frame, [CFM_AT + 8, CFM_AT + 18, OK2 + 2, OK2 + 8], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 0;

  /* ---- toast ---- */
  const toast =
    inSpan(frame, TOAST1, TOAST1 + 240) ? '隧道已创建'
    : inSpan(frame, PTOAST, PTOAST + 150) ? '浏览器代理设置已保存,打开的浏览器标签页正在重建'
    : null;

  /* ---- 设置页 ---- */
  const setPage: Wb7State['setPage'] = frame >= NAV_BR + 6 ? 'browser' : 'features';
  const proxyEnabled = frame >= CKB_CLICK + 4;
  const selOpen = inSpan(frame, SEL_CLICK + 2, OPT_CLICK + 4);
  const selHover = inSpan(frame, SEL_CLICK + 40, OPT_CLICK);
  const selValue = frame >= OPT_CLICK + 4;

  /* ---- 浏览器标签页 ---- */
  const addrFocus = inSpan(frame, ADDR_CLICK, ADDR_ENTER + 4);
  const addrText = inSpan(frame, ADDR_TYPE, ADDR_ENTER + 4) ? typed(frame, ADDR_TYPE, 4, DEMO.intraUrl) : '';
  const loading = inSpan(frame, ADDR_ENTER + 2, SITE_IN);
  const site: Wb7State['site'] = frame >= SITE_IN ? 'intra' : 'nebula';
  const siteIn = interpolate(frame, [SITE_IN, SITE_IN + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  /* ---- hover / press ---- */
  const hover: Wb7State['hover'] =
    inSpan(frame, MORE_HOVER, MORE_CLICK) ? 'more'
    : inSpan(frame, 230, TUN_CLICK) ? 'srvMenuTunnel'
    : inSpan(frame, NEW1_CLICK - 24, NEW1_CLICK) || inSpan(frame, NEW2_CLICK - 24, NEW2_CLICK) ? 'newTunnel'
    : inSpan(frame, N1_CLICK - 22, K1_CLICK - 26) || inSpan(frame, N2_CLICK - 22, K2_CLICK - 26) ? 'nameInput'
    : inSpan(frame, K1_CLICK - 26, K1_CLICK) || inSpan(frame, K2_CLICK - 26, K2_CLICK) ? 'kindSel'
    : inSpan(frame, K1_CLICK + 40, K1_PICK) ? 'kindOpt1'
    : inSpan(frame, K2_CLICK + 40, K2_PICK) ? 'kindOpt0'
    : inSpan(frame, P1_CLICK - 22, P1_CLICK) || inSpan(frame, P2_CLICK - 22, P2_CLICK) ? 'portInput'
    : inSpan(frame, T2_CLICK - 22, T2_CLICK) ? 'targetInput'
    : inSpan(frame, SAVE1 - 22, SAVE1) || inSpan(frame, SAVE2 - 22, SAVE2) ? 'saveOk'
    : inSpan(frame, STOP2 - 22, STOP2) ? 'row2Toggle'
    : inSpan(frame, START1 - 22, START1) ? 'row1Toggle'
    : inSpan(frame, SET_CLICK - 22, SET_CLICK) ? 'setNav'
    : inSpan(frame, NAV_BR - 22, NAV_BR) ? 'navBrowser'
    : inSpan(frame, CKB_CLICK - 22, CKB_CLICK) ? 'ckb'
    : inSpan(frame, SEL_CLICK - 22, SEL_CLICK) ? 'selBox'
    : inSpan(frame, SEL_CLICK + 40, OPT_CLICK) ? 'selOpt'
    : inSpan(frame, PSAVE - 22, PSAVE) ? 'psave'
    : inSpan(frame, WB_BACK - 22, WB_BACK) ? 'projNav'
    : inSpan(frame, BTAB_CLICK - 22, BTAB_CLICK) ? 'btab'
    : inSpan(frame, ADDR_CLICK - 22, ADDR_CLICK) ? 'addr'
    : null;
  const press: Wb7State['hover'] =
    inSpan(frame, MORE_CLICK, MORE_CLICK + 6) ? 'more'
    : inSpan(frame, TUN_CLICK, TUN_CLICK + 6) ? 'srvMenuTunnel'
    : inSpan(frame, NEW1_CLICK, NEW1_CLICK + 6) || inSpan(frame, NEW2_CLICK, NEW2_CLICK + 6) ? 'newTunnel'
    : inSpan(frame, N1_CLICK, N1_CLICK + 6) || inSpan(frame, N2_CLICK, N2_CLICK + 6) ? 'nameInput'
    : inSpan(frame, K1_CLICK, K1_CLICK + 6) || inSpan(frame, K2_CLICK, K2_CLICK + 6) ? 'kindSel'
    : inSpan(frame, K1_PICK, K1_PICK + 6) ? 'kindOpt1'
    : inSpan(frame, K2_PICK, K2_PICK + 6) ? 'kindOpt0'
    : inSpan(frame, P1_CLICK, P1_CLICK + 6) || inSpan(frame, P2_CLICK, P2_CLICK + 6) ? 'portInput'
    : inSpan(frame, T2_CLICK, T2_CLICK + 6) ? 'targetInput'
    : inSpan(frame, SAVE1, SAVE1 + 6) || inSpan(frame, SAVE2, SAVE2 + 6) ? 'saveOk'
    : inSpan(frame, OK2, OK2 + 6) ? 'cfmOk'
    : inSpan(frame, STOP2, STOP2 + 6) ? 'row2Toggle'
    : inSpan(frame, START1, START1 + 6) ? 'row1Toggle'
    : inSpan(frame, SET_CLICK, SET_CLICK + 6) ? 'setNav'
    : inSpan(frame, NAV_BR, NAV_BR + 6) ? 'navBrowser'
    : inSpan(frame, CKB_CLICK, CKB_CLICK + 6) ? 'ckb'
    : inSpan(frame, SEL_CLICK, SEL_CLICK + 6) ? 'selBox'
    : inSpan(frame, OPT_CLICK, OPT_CLICK + 6) ? 'selOpt'
    : inSpan(frame, PSAVE, PSAVE + 6) ? 'psave'
    : inSpan(frame, WB_BACK, WB_BACK + 6) ? 'projNav'
    : inSpan(frame, BTAB_CLICK, BTAB_CLICK + 6) ? 'btab'
    : inSpan(frame, ADDR_CLICK, ADDR_CLICK + 6) || inSpan(frame, ADDR_ENTER, ADDR_ENTER + 6) ? 'addr'
    : null;

  return {
    page,
    pageT,
    centerTab,
    tunnelTabT,
    srvMenu,
    row1,
    row2,
    dlg,
    dlgT,
    kindMenuOpen,
    kindHover,
    f1Name,
    f1Port,
    f2Name,
    f2Kind,
    f2Port,
    f2Target,
    cfm,
    cfmT,
    toast,
    badge,
    setPage,
    proxyEnabled,
    selOpen,
    selHover,
    selValue,
    addrFocus,
    addrText,
    loading,
    site,
    siteIn,
    hover,
    press,
  };
}
