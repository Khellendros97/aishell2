/**
 * 视频三导演脚本:全部运镜/指针/点击/字幕/场景状态的帧级编排。
 * 状态推导为纯函数(wbAt),组件只负责渲染;锚点坐标全部来自 ./layout.ts。
 *
 * 剧情线(30fps,约 85s):
 *   A  0–420    系统资源管理器拖文件入项目(文件管理器)
 *   B  420–1096 打开 SFTP → 拖拽上传 → 系统直拖 SFTP 被拒(规范说明)→ 右键下载
 *   C  1096–1465 双击 SFTP 文本文件在线编辑,Ctrl+S 写回远端;本地文件双击编辑
 *   D  1465–1900 SFTP 压缩为 tgz / 快速备份
 *   E  1900–2560 收藏夹 / 搜索 / 列表视图排序 / 收尾
 */
import { interpolate } from 'remotion';
import { Stop } from '../anim';
import { Click } from '../components/Cursor';
import {
  APPS_ENTRIES, BACKUP, ARCHIVE, DEMO, DIR_MENU, FILE_MENU, HOME_ENTRIES, UPLOADED, osRow,
  menuItemY, SFTP_BTN, ACT, FAV_OK,
} from './layout';
import { EditorDoc, SftpEntry, Tok, Wb3State, Wb3Target } from './Wb3';

/* ============ 关键帧 ============ */
/** 场景 A:OS 拖入 */
const OS_IN = 80;
const A_PRESS = 168;
const A_DROP = 236;
/** 场景 B */
const B_SERVERS = 444;
const B_CARD = 466;
const B_SFTP = 508;
const B_EXPLORER = 546;
const B_UP_PRESS = 606;
const B_UP_DROP = 662;
const B_REJ_PRESS = 730;
const B_REJ_DROP = 800;
const B_RC_DEPLOY = 884;
const B_DL_CLICK = 952;
/** 场景 C */
const C_OPEN1 = 1108;
const C_SEL1 = 1170;
const C_TYPE = 1198;
const C_SAVE = 1292;
const C_OPEN2 = 1396;
/** 场景 D */
const D_TAB = 1508;
const D_RC_LOGS = 1566;
const D_ZIP = 1612;
const D_RC_APPS = 1726;
const D_BAK = 1768;
/** 场景 E */
const E_STAR = 1962;
const E_FAVOK = 2044;
const E_FAVBTN = 2064;
const E_APPS1 = 2102;
const E_APPS2 = 2113;
const E_JUMP = 2144;
const E_SEARCH = 2168;
const E_ESC = 2224;
const E_LIST = 2264;
const E_SORT1 = 2296;
const E_SORT2 = 2326;
export const DURATION = 2560;

/* ============ 摄像机轨道 ============ */
export const CAM_S: readonly Stop[] = [
  { f: 0, v: 0.78 }, { f: 100, v: 0.78 }, { f: 134, v: 1.02 }, { f: 320, v: 1.02 }, { f: 356, v: 0.85 },
  { f: 430, v: 0.85 }, { f: 444, v: 1.5 }, { f: 520, v: 1.5 }, { f: 552, v: 0.9 }, { f: 700, v: 0.9 },
  { f: 724, v: 1.3 }, { f: 838, v: 1.3 }, { f: 870, v: 1.25 }, { f: 1096, v: 1.25 }, { f: 1132, v: 1.18 },
  { f: 1345, v: 1.18 }, { f: 1465, v: 1.18 }, { f: 1516, v: 1.28 }, { f: 1618, v: 1.28 }, { f: 1634, v: 0.95 },
  { f: 1688, v: 0.95 }, { f: 1706, v: 1.28 }, { f: 1774, v: 1.28 }, { f: 1788, v: 0.95 }, { f: 1840, v: 0.95 },
  { f: 1858, v: 1.28 }, { f: 1936, v: 1.3 }, { f: 2050, v: 1.3 }, { f: 2076, v: 1.35 }, { f: 2398, v: 1.35 },
  { f: 2440, v: 0.78 },
];
export const CAM_X: readonly Stop[] = [
  { f: 0, v: 960 }, { f: 100, v: 960 }, { f: 134, v: 560 }, { f: 320, v: 560 }, { f: 356, v: 960 },
  { f: 430, v: 960 }, { f: 444, v: 400 }, { f: 520, v: 400 }, { f: 552, v: 830 }, { f: 700, v: 830 },
  { f: 724, v: 900 }, { f: 838, v: 900 }, { f: 870, v: 820 }, { f: 1096, v: 820 }, { f: 1132, v: 860 },
  { f: 1345, v: 860 }, { f: 1465, v: 860 }, { f: 1516, v: 900 }, { f: 1618, v: 900 }, { f: 1634, v: 960 },
  { f: 1688, v: 960 }, { f: 1706, v: 900 }, { f: 1774, v: 900 }, { f: 1788, v: 960 }, { f: 1840, v: 960 },
  { f: 1858, v: 900 }, { f: 1936, v: 960 }, { f: 1976, v: 960 }, { f: 1994, v: 960 }, { f: 2050, v: 960 },
  { f: 2076, v: 1000 }, { f: 2398, v: 1000 }, { f: 2440, v: 960 },
];
export const CAM_Y: readonly Stop[] = [
  { f: 0, v: 600 }, { f: 100, v: 600 }, { f: 134, v: 520 }, { f: 320, v: 520 }, { f: 356, v: 600 },
  { f: 430, v: 600 }, { f: 444, v: 330 }, { f: 520, v: 330 }, { f: 552, v: 600 }, { f: 700, v: 600 },
  { f: 724, v: 500 }, { f: 838, v: 500 }, { f: 870, v: 520 }, { f: 1096, v: 520 }, { f: 1132, v: 500 },
  { f: 1345, v: 500 }, { f: 1465, v: 500 }, { f: 1516, v: 480 }, { f: 1618, v: 480 }, { f: 1634, v: 605 },
  { f: 1688, v: 605 }, { f: 1706, v: 480 }, { f: 1774, v: 480 }, { f: 1788, v: 605 }, { f: 1840, v: 605 },
  { f: 1858, v: 480 }, { f: 1936, v: 380 }, { f: 1976, v: 380 }, { f: 1994, v: 560 }, { f: 2050, v: 560 },
  { f: 2076, v: 380 }, { f: 2398, v: 380 }, { f: 2440, v: 600 },
];

/* ============ 指针轨道 ============ */
const row0 = osRow(0);
const row1 = osRow(1);
/** 下载菜单项中心(FILE_MENU 第 18 项,菜单顶 258) */
const DL_ITEM = { x: 569 + 108, y: menuItemY(258, 18, FILE_MENU) };
/** 压缩/备份菜单项中心(DIR_MENU 第 8/9 项,菜单顶 180) */
const ZIP_ITEM = { x: 665 + 108, y: menuItemY(180, 8, DIR_MENU) };
const BAK_ITEM = { x: 376 + 108, y: menuItemY(180, 9, DIR_MENU) };

export const CUR_X: readonly Stop[] = [
  { f: 60, v: 1200 }, { f: 148, v: row0.x }, { f: 172, v: row0.x }, { f: 190, v: 300 }, { f: 214, v: 245 },
  { f: 236, v: 240 }, { f: 260, v: 240 }, { f: 330, v: 420 },
  { f: 436, v: ACT.servers.x }, { f: 446, v: ACT.servers.x }, { f: 458, v: 177 }, { f: 470, v: 177 },
  { f: 500, v: 211 }, { f: 512, v: 211 }, { f: 540, v: ACT.explorer.x }, { f: 552, v: ACT.explorer.x },
  { f: 596, v: 180 }, { f: 610, v: 180 }, { f: 632, v: 450 }, { f: 662, v: 880 }, { f: 690, v: 880 },
  { f: 726, v: row1.x }, { f: 734, v: row1.x }, { f: 756, v: 500 }, { f: 776, v: 800 }, { f: 796, v: 880 },
  { f: 800, v: 880 }, { f: 826, v: row1.x }, { f: 870, v: row1.x },
  { f: 878, v: 559 }, { f: 890, v: 559 }, { f: 930, v: DL_ITEM.x }, { f: 958, v: DL_ITEM.x }, { f: 1000, v: 700 },
  { f: 1060, v: 462 }, { f: 1096, v: 462 }, { f: 1150, v: 464 }, { f: 1190, v: 464 }, { f: 1280, v: 700 },
  { f: 1350, v: 150 }, { f: 1385, v: 150 }, { f: 1420, v: 150 }, { f: 1470, v: 536 }, { f: 1500, v: 536 },
  { f: 1516, v: 700 }, { f: 1560, v: 655 }, { f: 1572, v: 655 }, { f: 1600, v: ZIP_ITEM.x }, { f: 1618, v: ZIP_ITEM.x },
  { f: 1660, v: 600 }, { f: 1690, v: 366 }, { f: 1732, v: 366 }, { f: 1756, v: BAK_ITEM.x }, { f: 1774, v: BAK_ITEM.x },
  { f: 1810, v: 700 }, { f: 1950, v: 1373 }, { f: 1968, v: 1373 }, { f: 2036, v: FAV_OK.x }, { f: 2050, v: FAV_OK.x },
  { f: 2058, v: 1526 }, { f: 2070, v: 1526 }, { f: 2095, v: 371 }, { f: 2108, v: 371 }, { f: 2126, v: 371 },
  { f: 2136, v: 1450 }, { f: 2150, v: 1450 }, { f: 2160, v: 1556 }, { f: 2174, v: 1556 }, { f: 2210, v: 1560 },
  { f: 2246, v: 1330 }, { f: 2270, v: 1330 }, { f: 2284, v: 1248 }, { f: 2400, v: 1248 }, { f: 2460, v: 900 },
];
export const CUR_Y: readonly Stop[] = [
  { f: 60, v: 800 }, { f: 148, v: row0.y }, { f: 172, v: row0.y }, { f: 190, v: 620 }, { f: 214, v: 300 },
  { f: 236, v: 186 }, { f: 260, v: 186 }, { f: 330, v: 300 },
  { f: 436, v: ACT.servers.y }, { f: 446, v: ACT.servers.y }, { f: 458, v: 157 }, { f: 470, v: 157 },
  { f: 500, v: 215 }, { f: 512, v: 215 }, { f: 540, v: ACT.explorer.y }, { f: 552, v: ACT.explorer.y },
  { f: 596, v: 162 }, { f: 610, v: 162 }, { f: 632, v: 300 }, { f: 662, v: 470 }, { f: 690, v: 470 },
  { f: 726, v: row1.y }, { f: 734, v: row1.y }, { f: 756, v: 640 }, { f: 776, v: 500 }, { f: 796, v: 470 },
  { f: 800, v: 470 }, { f: 826, v: row1.y }, { f: 870, v: row1.y },
  { f: 878, v: 244 }, { f: 890, v: 244 }, { f: 930, v: DL_ITEM.y }, { f: 958, v: DL_ITEM.y }, { f: 1000, v: 500 },
  { f: 1060, v: 244 }, { f: 1096, v: 244 }, { f: 1150, v: 219 }, { f: 1190, v: 219 }, { f: 1280, v: 400 },
  { f: 1350, v: 234 }, { f: 1385, v: 234 }, { f: 1420, v: 234 }, { f: 1470, v: 58 }, { f: 1500, v: 58 },
  { f: 1516, v: 300 }, { f: 1560, v: 166 }, { f: 1572, v: 166 }, { f: 1600, v: ZIP_ITEM.y }, { f: 1618, v: ZIP_ITEM.y },
  { f: 1660, v: 260 }, { f: 1690, v: 166 }, { f: 1732, v: 166 }, { f: 1756, v: BAK_ITEM.y }, { f: 1774, v: BAK_ITEM.y },
  { f: 1810, v: 400 }, { f: 1950, v: 96 }, { f: 1968, v: 96 }, { f: 2036, v: FAV_OK.y }, { f: 2050, v: FAV_OK.y },
  { f: 2058, v: 96 }, { f: 2070, v: 96 }, { f: 2095, v: 166 }, { f: 2108, v: 166 }, { f: 2126, v: 166 },
  { f: 2136, v: 164 }, { f: 2150, v: 164 }, { f: 2160, v: 96 }, { f: 2174, v: 96 }, { f: 2210, v: 140 },
  { f: 2246, v: 96 }, { f: 2270, v: 96 }, { f: 2284, v: 141 }, { f: 2400, v: 141 }, { f: 2460, v: 700 },
];

/* ============ 点击(涟漪) ============ */
export const CLICKS: readonly Click[] = [
  { f: A_PRESS, x: row0.x, y: row0.y, target: 'row' },
  { f: A_DROP, x: 240, y: 186, target: 'row' },
  { f: B_SERVERS, x: ACT.servers.x, y: ACT.servers.y, target: 'browse' },
  { f: B_CARD, x: 177, y: 157, target: 'browse' },
  { f: B_SFTP, x: SFTP_BTN.x + 13, y: SFTP_BTN.y + 13, target: 'browse' },
  { f: B_EXPLORER, x: ACT.explorer.x, y: ACT.explorer.y, target: 'browse' },
  { f: B_UP_PRESS, x: 180, y: 162, target: 'row' },
  { f: B_UP_DROP, x: 880, y: 470, target: 'row' },
  { f: B_REJ_PRESS, x: row1.x, y: row1.y, target: 'row' },
  { f: B_REJ_DROP, x: 880, y: 470, target: 'row' },
  { f: B_RC_DEPLOY, x: 559, y: 244, target: 'row' },
  { f: B_DL_CLICK, x: DL_ITEM.x, y: DL_ITEM.y, target: 'confirm' },
  { f: C_OPEN1, x: 462, y: 244, target: 'row' },
  { f: C_OPEN1 + 12, x: 462, y: 244, target: 'row' },
  { f: C_SEL1, x: 464, y: 219, target: 'input' },
  { f: C_SEL1 + 11, x: 464, y: 219, target: 'input' },
  { f: C_OPEN2, x: 150, y: 234, target: 'row' },
  { f: C_OPEN2 + 11, x: 150, y: 234, target: 'row' },
  { f: D_TAB, x: 536, y: 58, target: 'browse' },
  { f: D_RC_LOGS, x: 655, y: 166, target: 'row' },
  { f: D_ZIP, x: ZIP_ITEM.x, y: ZIP_ITEM.y, target: 'confirm' },
  { f: D_RC_APPS, x: 366, y: 166, target: 'row' },
  { f: D_BAK, x: BAK_ITEM.x, y: BAK_ITEM.y, target: 'confirm' },
  { f: E_STAR, x: 1373, y: 96, target: 'browse' },
  { f: E_FAVOK, x: FAV_OK.x, y: FAV_OK.y, target: 'save' },
  { f: E_FAVBTN, x: 1526, y: 96, target: 'browse' },
  { f: E_APPS1, x: 371, y: 166, target: 'row' },
  { f: E_APPS2, x: 371, y: 166, target: 'row' },
  { f: E_JUMP, x: 1450, y: 164, target: 'confirm' },
  { f: E_SEARCH, x: 1556, y: 96, target: 'browse' },
  { f: E_LIST, x: 1330, y: 96, target: 'browse' },
  { f: E_SORT1, x: 1248, y: 141, target: 'confirm' },
  { f: E_SORT2, x: 1248, y: 141, target: 'confirm' },
];

/* ============ 字幕 ============ */
export const CAPTIONS3 = [
  { from: 4, to: 66, text: '文件管理与 SFTP' },
  { from: 96, to: 196, text: '从系统资源管理器拖入文件到项目' },
  { from: 250, to: 336, text: '已导入文件管理器，可编辑、可上传' },
  { from: 470, to: 560, text: '从服务器卡片打开 SFTP 文件管理' },
  { from: 592, to: 688, text: '从文件管理器拖到 SFTP，即上传到远端目录' },
  { from: 716, to: 806, text: '注意：系统文件不能直接拖入 SFTP' },
  { from: 884, to: 984, text: '右键下载：自动保存到项目目录并定位' },
  { from: 1102, to: 1196, text: '双击 SFTP 中的文本文件，在编辑器中打开' },
  { from: 1214, to: 1304, text: '直接编辑，Ctrl+S 保存写回远端' },
  { from: 1342, to: 1436, text: '本地文件同样双击编辑，保存写入项目目录' },
  { from: 1544, to: 1640, text: '右键压缩：目录一键打成 tgz' },
  { from: 1664, to: 1760, text: '快速备份：自动带时间戳，防止覆盖' },
  { from: 1944, to: 2036, text: '地址栏星标：收藏常用路径' },
  { from: 2052, to: 2148, text: '收藏夹侧栏：跨目录一键跳转' },
  { from: 2164, to: 2258, text: '搜索当前目录，支持 * 通配符' },
  { from: 2276, to: 2380, text: '列表视图：点表头按名称、修改时间排序' },
  { from: 2400, to: 2496, text: '上传下载 · 在线编辑 · 压缩备份 · 收藏与搜索' },
];

/* ============ 教学叠加层 ============ */
/** 拒收说明卡(场景 B) */
export const NOTES3 = [
  {
    from: 756, to: 880, x: 990, y: 560, w: 380,
    title: 'SFTP 不接收系统文件',
    body: '为规范文件管理，系统文件需先拖入左侧文件管理器，再从文件管理器拖到 SFTP 上传',
  },
];

/** 键盘提示 */
export const KBD3 = [
  { from: 1284, to: 1330, x: 1380, y: 880, label: 'Ctrl + S' },
  { from: 2224, to: 2250, x: 1520, y: 140, label: 'Esc' },
];

/** 焦点高亮环 */
export const HIGHLIGHTS3 = [
  { x: SFTP_BTN.x - 5, y: SFTP_BTN.y - 5, w: SFTP_BTN.w + 10, h: SFTP_BTN.h + 10, r: 6, from: 496, to: 516 },
  { x: 1351, y: 74, w: 44, h: 44, r: 8, from: 1950, to: 1976 },
  { x: 1508, y: 78, w: 36, h: 36, r: 6, from: 2052, to: 2072 },
  { x: 1538, y: 78, w: 36, h: 36, r: 6, from: 2156, to: 2176 },
  { x: 1312, y: 78, w: 36, h: 36, r: 6, from: 2252, to: 2272 },
  { x: 1206, y: 127, w: 96, h: 26, r: 4, from: 2290, to: 2336 },
];

/* ============ 编辑器文档 ============ */
const APP_LINES_BEFORE: Tok[][] = [
  [['comment', '# deephaven worker 应用配置']],
  [['key', 'server:']],
  [['plain', '  '], ['key', 'host: '], ['str', '10.21.36.8']],
  [['plain', '  '], ['key', 'port: '], ['num', '8420']],
  [['key', 'worker:']],
  [['plain', '  '], ['key', 'replicas: '], ['num', '4']],
  [['plain', '  '], ['key', 'retries: '], ['num', '3']],
  [['plain', '  '], ['key', 'timeout: '], ['str', '30s']],
  [['plain', '  '], ['key', 'queue: '], ['str', 'kafka://mq-01:9092']],
  [['key', 'logging:']],
  [['plain', '  '], ['key', 'level: '], ['str', 'info']],
  [['plain', '  '], ['key', 'dir: '], ['str', '/var/log/deephaven']],
  [['plain', '  '], ['key', 'rotate: '], ['str', 'daily']],
  [['key', 'resources:']],
  [['plain', '  '], ['key', 'cpu_limit: '], ['str', '"4"']],
  [['plain', '  '], ['key', 'mem_limit: '], ['str', '8Gi']],
  [['key', 'health_check:']],
  [['plain', '  '], ['key', 'path: '], ['str', '/healthz']],
  [['plain', '  '], ['key', 'interval: '], ['str', '15s']],
  [['key', 'metrics:']],
  [['plain', '  '], ['key', 'enabled: '], ['atom', 'true']],
  [['plain', '  '], ['key', 'port: '], ['num', '9100']],
];
const APP_LINES_AFTER: Tok[][] = APP_LINES_BEFORE.map((l, i) =>
  i === 6 ? [['plain', '  '], ['key', 'retries: '], ['num', '5']] : l,
);
const README_LINES: Tok[][] = [
  [['head', '# deephaven-bigdata']],
  [['plain', '']],
  [['plain', '实时数据工作台示例项目。']],
  [['plain', '']],
  [['head', '## 目录']],
  [['plain', '- '], ['key', 'src/'], ['plain', ' 业务脚本']],
  [['plain', '- '], ['key', 'docs/'], ['plain', ' 部署文档']],
  [['plain', '- '], ['key', 'scripts/'], ['plain', ' 运维脚本']],
  [['plain', '']],
  [['head', '## 快速开始']],
  [['str', 'docker compose up -d']],
  [['plain', '']],
  [['head', '## 联系']],
  [['plain', '- 值班群: '], ['str', '#deephaven-ops']],
  [['plain', '- 文档: '], ['str', 'wiki.deephaven.dev/bigdata']],
];

const editorDoc = (id: string, over: Partial<EditorDoc>): EditorDoc => ({
  title: id === 'ed-app' ? 'app-config.yml' : 'README.md',
  remote: id === 'ed-app',
  tokens: id === 'ed-app' ? APP_LINES_BEFORE : README_LINES,
  dirty: false,
  sel: null,
  caret: null,
  ...over,
});

/* ============ 状态推导 ============ */
const typed = (frame: number, from: number, step: number, full: string): string =>
  full.slice(0, Math.max(0, Math.min(full.length, Math.floor((frame - from) / step) + 1)));

const inSpan = (frame: number, a: number, b: number): boolean => frame >= a && frame < b;

export function wbAt(frame: number): Wb3State {
  /* ---- 标签 ---- */
  const tabs: Wb3State['tabs'] = [{ id: 'term', kind: 'terminal', title: DEMO.serverName, icon: 'terminal' }];
  let activeId = 'term';
  if (frame >= B_SFTP + 2) {
    tabs.push({ id: 'sftp', kind: 'sftp', title: DEMO.serverName, icon: 'folderOpen' });
    activeId = 'sftp';
  }
  if (frame >= C_OPEN1 + 16) {
    tabs.push({ id: 'ed-app', kind: 'editor', title: 'app-config.yml', icon: 'file', dirty: frame >= C_TYPE && frame < C_SAVE });
    activeId = 'ed-app';
  }
  if (frame >= C_OPEN2 + 16) {
    tabs.push({ id: 'ed-readme', kind: 'editor', title: 'README.md', icon: 'file' });
    activeId = 'ed-readme';
  }
  if (frame >= D_TAB + 2) activeId = 'sftp';

  /* ---- 侧栏 ---- */
  const panel: Wb3State['panel'] = frame < B_SERVERS + 2 ? 'explorer' : frame < B_EXPLORER + 2 ? 'servers' : 'explorer';
  const serverExpanded = frame >= B_CARD + 2;
  const treeFiles =
    frame < A_DROP + 2 ? ['README.md', 'docker-compose.yml']
    : frame < B_DL_CLICK + 6 ? ['app-config.yml', 'docker-compose.yml', 'README.md']
    : ['app-config.yml', 'deploy.md', 'docker-compose.yml', 'README.md'];
  const treeHighlight =
    inSpan(frame, A_DROP + 2, A_DROP + 77) ? 'app-config.yml'
    : inSpan(frame, B_UP_DROP + 6, B_UP_DROP + 81) ? 'app-config.yml'
    : inSpan(frame, B_DL_CLICK + 6, B_DL_CLICK + 81) ? 'deploy.md'
    : null;

  /* ---- SFTP ---- */
  let entries: SftpEntry[] = HOME_ENTRIES;
  if (frame >= B_UP_DROP + 4) entries = [...entries, UPLOADED];
  if (frame >= D_ZIP + 4) entries = [...entries, ARCHIVE];
  if (frame >= D_BAK + 4) entries = [...entries, BACKUP];
  const cwdApps = frame >= E_APPS2 + 3 && frame < E_JUMP + 2;
  const cwd = cwdApps ? DEMO.appsDir : DEMO.home;
  const shownEntries: SftpEntry[] = cwdApps ? APPS_ENTRIES : entries;
  const loading = inSpan(frame, B_SFTP + 2, B_SFTP + 14) || inSpan(frame, E_APPS2 + 3, E_APPS2 + 11);

  let sel: string | null = null;
  if (frame >= B_UP_DROP + 4 && frame < B_RC_DEPLOY) sel = DEMO.uploadName;
  if (frame >= B_RC_DEPLOY && frame < B_DL_CLICK + 2) sel = DEMO.downloadName;
  if (frame >= D_ZIP + 4 && frame < D_RC_APPS) sel = ARCHIVE.name;
  if (frame >= D_RC_APPS && frame < D_BAK + 2) sel = 'apps';
  if (frame >= D_BAK + 4) sel = BACKUP.name;

  const query = frame < E_SEARCH + 8 ? '' : frame < E_ESC ? typed(frame, E_SEARCH + 8, 8, '*.md') : '';
  const sftp: Wb3State['sftp'] = {
    cwd,
    entries: shownEntries,
    loading,
    sel,
    view: frame >= E_LIST + 2 ? 'list' : 'grid',
    sortKey: frame >= E_SORT1 + 2 ? 'mtime' : 'name',
    sortAsc: frame < E_SORT2 + 2,
    searchOpen: inSpan(frame, E_SEARCH + 2, E_ESC + 2),
    query,
    favOpen: frame >= E_FAVBTN + 2,
    favorites: frame >= E_FAVOK + 2 ? [{ title: DEMO.favTitle, path: DEMO.home }] : [],
    starActive: frame >= E_FAVOK + 2,
  };

  /* ---- 编辑器 ---- */
  const editors: Record<string, EditorDoc> = {};
  if (frame >= C_OPEN1 + 16) {
    const edited = frame >= C_TYPE;
    editors['ed-app'] = editorDoc('ed-app', {
      tokens: edited ? APP_LINES_AFTER : APP_LINES_BEFORE,
      dirty: edited && frame < C_SAVE,
      sel: inSpan(frame, C_SEL1 + 14, C_TYPE) ? { line: 6, col: 11, len: 1 } : null,
      caret: edited && frame < C_SAVE + 38 ? { line: 6, col: 12 } : null,
    });
  }
  if (frame >= C_OPEN2 + 16) {
    editors['ed-readme'] = editorDoc('ed-readme', {});
  }

  /* ---- 右键菜单 ---- */
  let ctx: Wb3State['ctx'] = null;
  if (inSpan(frame, B_RC_DEPLOY + 2, B_DL_CLICK + 2)) {
    ctx = { x: 569, y: 258, items: FILE_MENU, hover: frame >= 924 ? 18 : -1, press: inSpan(frame, B_DL_CLICK, B_DL_CLICK + 2) ? 18 : -1 };
  } else if (inSpan(frame, D_RC_LOGS + 2, D_ZIP + 2)) {
    ctx = { x: 665, y: 180, items: DIR_MENU, hover: frame >= 1600 ? 8 : -1, press: inSpan(frame, D_ZIP, D_ZIP + 2) ? 8 : -1 };
  } else if (inSpan(frame, D_RC_APPS + 2, D_BAK + 2)) {
    ctx = { x: 376, y: 180, items: DIR_MENU, hover: frame >= 1756 ? 9 : -1, press: inSpan(frame, D_BAK, D_BAK + 2) ? 9 : -1 };
  }

  /* ---- 拖拽幽灵 ---- */
  let ghost: Wb3State['ghost'] = null;
  if (inSpan(frame, A_PRESS + 4, A_DROP + 2)) ghost = { name: DEMO.uploadName, reject: false, fade: 1 };
  else if (inSpan(frame, B_UP_PRESS + 2, B_UP_DROP + 2)) ghost = { name: DEMO.uploadName, reject: false, fade: 1 };
  else if (inSpan(frame, B_REJ_PRESS + 2, B_REJ_PRESS + 98)) {
    ghost = {
      name: DEMO.osName2,
      reject: inSpan(frame, 756, B_REJ_DROP),
      fade: frame >= B_REJ_DROP ? interpolate(frame, [B_REJ_DROP, B_REJ_DROP + 24], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1,
    };
  }

  /* ---- 其他 ---- */
  const dropZone: Wb3State['dropZone'] =
    inSpan(frame, 196, A_DROP + 4) ? 'tree'
    : inSpan(frame, 620, B_UP_DROP + 4) ? 'sftp-ok'
    : inSpan(frame, 756, B_REJ_DROP + 2) ? 'sftp-no'
    : null;

  const toast =
    inSpan(frame, A_DROP + 4, A_DROP + 64) ? `已导入 1 个项目到 ${DEMO.projectName}`
    : inSpan(frame, B_UP_DROP + 6, B_UP_DROP + 66) ? `已上传 ${DEMO.uploadName}`
    : inSpan(frame, B_DL_CLICK + 4, B_DL_CLICK + 64) ? `已下载 ${DEMO.downloadName} 到本地`
    : inSpan(frame, C_SAVE, C_SAVE + 60) ? '已保存到远端'
    : inSpan(frame, D_ZIP + 4, D_ZIP + 64) ? `已压缩为 ${ARCHIVE.name}`
    : inSpan(frame, D_BAK + 4, D_BAK + 64) ? `备份完成：${BACKUP.name}`
    : null;

  const progress = inSpan(frame, B_UP_DROP - 6, B_UP_DROP + 44) ? { label: '上传中', detail: DEMO.uploadName } : null;
  const favModalT = interpolate(frame, [E_STAR + 4, E_STAR + 18, E_FAVOK, E_FAVOK + 14], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return {
    panel,
    serverExpanded,
    tabs,
    activeId,
    termCaret: frame < B_SFTP + 2,
    sftp: frame >= B_SFTP + 2 ? sftp : null,
    editors,
    favModalT,
    ctx,
    treeFiles,
    treeHighlight,
    dropZone,
    toast,
    progress,
    ghost,
    hover: hover3(frame),
    press: press3(frame),
  };
}

function hover3(frame: number): Wb3Target {
  const s = (a: number, b: number): boolean => frame >= a && frame < b;
  if (s(436, B_SERVERS)) return 'actServers';
  if (s(452, B_CARD)) return 'card';
  if (s(496, B_SFTP)) return 'sftpBtn';
  if (s(534, B_EXPLORER)) return 'actExplorer';
  if (s(1498, D_TAB)) return 'tabSftp';
  if (s(1946, E_STAR)) return 'sfStar';
  if (s(2054, E_FAVBTN)) return 'sfFavBtn';
  if (s(2158, E_SEARCH)) return 'sfSearchBtn';
  if (s(2254, E_LIST)) return 'sfListBtn';
  if (s(2284, E_SORT1)) return 'sortTh';
  if (s(2132, E_JUMP)) return 'favItem';
  return null;
}

function press3(frame: number): Wb3Target {
  const s = (a: number, b: number): boolean => frame >= a && frame < b;
  if (s(B_SERVERS, B_SERVERS + 6)) return 'actServers';
  if (s(B_CARD, B_CARD + 6)) return 'card';
  if (s(B_SFTP, B_SFTP + 6)) return 'sftpBtn';
  if (s(B_EXPLORER, B_EXPLORER + 6)) return 'actExplorer';
  if (s(D_TAB, D_TAB + 6)) return 'tabSftp';
  if (s(E_STAR, E_STAR + 6)) return 'sfStar';
  if (s(E_FAVBTN, E_FAVBTN + 6)) return 'sfFavBtn';
  if (s(E_LIST, E_LIST + 6)) return 'sfListBtn';
  return null;
}
