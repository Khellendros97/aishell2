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
import { Stop, track1 } from '../anim';
import { AnchorStop } from '../components/anchors';
import { Click } from '../components/Cursor';
import {
  APPS_ENTRIES, BACKUP, ARCHIVE, DEMO, DIR_MENU, FILE_MENU, HOME_ENTRIES, UPLOADED, osRow,
  menuItemY, SFTP_BTN, SF, ACT, FAV_OK,
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

/** 设计稿窗口坐标 → canvas 兜底坐标(按该帧相机;仅冷启动首帧兜底,实测就绪后即被替换) */
const wfAt = (f: number, wx: number, wy: number): { x: number; y: number } => {
  const s = track1(CAM_S, f);
  const cx0 = track1(CAM_X, f);
  const cy0 = track1(CAM_Y, f);
  return { x: wx * s + (960 - cx0 * s), y: wy * s + (540 - cy0 * s) };
};

/* 原始轨道定义:wx/wy 为设计稿兜底坐标,at 为锚点 id(实测优先) */
const CUR_DEF: readonly { f: number; wx: number; wy: number; at?: string }[] = [
  { f: 60, wx: 1200, wy: 800 }, { f: 148, wx: row0.x, wy: row0.y, at: 'w3-os-row0' }, { f: 172, wx: row0.x, wy: row0.y, at: 'w3-os-row0' }, { f: 190, wx: 300, wy: 620 }, { f: 214, wx: 245, wy: 300 },
  { f: 236, wx: 240, wy: 186 }, { f: 260, wx: 240, wy: 186 }, { f: 330, wx: 420, wy: 300 },
  { f: 436, wx: ACT.servers.x, wy: ACT.servers.y, at: 'w3-act-servers' }, { f: 446, wx: ACT.servers.x, wy: ACT.servers.y, at: 'w3-act-servers' }, { f: 458, wx: 177, wy: 157, at: 'w3-card' }, { f: 470, wx: 177, wy: 157, at: 'w3-card' },
  { f: 500, wx: 211, wy: 215, at: 'w3-sftp-btn' }, { f: 512, wx: 211, wy: 215, at: 'w3-sftp-btn' }, { f: 540, wx: ACT.explorer.x, wy: ACT.explorer.y, at: 'w3-act-explorer' }, { f: 552, wx: ACT.explorer.x, wy: ACT.explorer.y, at: 'w3-act-explorer' },
  { f: 596, wx: 180, wy: 162, at: 'w3-os-row0' }, { f: 610, wx: 180, wy: 162, at: 'w3-os-row0' }, { f: 632, wx: 450, wy: 300 }, { f: 662, wx: 880, wy: 470 }, { f: 690, wx: 880, wy: 470 },
  { f: 726, wx: row1.x, wy: row1.y, at: 'w3-os-row1' }, { f: 734, wx: row1.x, wy: row1.y, at: 'w3-os-row1' }, { f: 756, wx: 500, wy: 640 }, { f: 776, wx: 800, wy: 500 }, { f: 796, wx: 880, wy: 470 },
  { f: 800, wx: 880, wy: 470 }, { f: 826, wx: row1.x, wy: row1.y, at: 'w3-os-row1' }, { f: 870, wx: row1.x, wy: row1.y, at: 'w3-os-row1' },
  { f: 878, wx: 559, wy: 244, at: 'w3-entry-deploy.md' }, { f: 890, wx: 559, wy: 244, at: 'w3-entry-deploy.md' }, { f: 930, wx: DL_ITEM.x, wy: DL_ITEM.y, at: 'w3-menu-18' }, { f: 958, wx: DL_ITEM.x, wy: DL_ITEM.y, at: 'w3-menu-18' }, { f: 1000, wx: 700, wy: 500 },
  { f: 1060, wx: 462, wy: 244, at: 'w3-entry-app-config.yml' }, { f: 1096, wx: 462, wy: 244, at: 'w3-entry-app-config.yml' }, { f: 1150, wx: 464, wy: 219 }, { f: 1190, wx: 464, wy: 219 }, { f: 1280, wx: 700, wy: 400 },
  { f: 1350, wx: 150, wy: 234, at: 'w3-tree-README.md' }, { f: 1385, wx: 150, wy: 234, at: 'w3-tree-README.md' }, { f: 1420, wx: 150, wy: 234, at: 'w3-tree-README.md' }, { f: 1470, wx: 536, wy: 58, at: 'w3-tab-sftp' }, { f: 1500, wx: 536, wy: 58, at: 'w3-tab-sftp' },
  { f: 1516, wx: 700, wy: 300 }, { f: 1560, wx: 655, wy: 166, at: 'w3-entry-logs' }, { f: 1572, wx: 655, wy: 166, at: 'w3-entry-logs' }, { f: 1600, wx: ZIP_ITEM.x, wy: ZIP_ITEM.y, at: 'w3-menu-8' }, { f: 1618, wx: ZIP_ITEM.x, wy: ZIP_ITEM.y, at: 'w3-menu-8' },
  { f: 1660, wx: 600, wy: 260 }, { f: 1690, wx: 366, wy: 166, at: 'w3-entry-apps' }, { f: 1732, wx: 366, wy: 166, at: 'w3-entry-apps' }, { f: 1756, wx: BAK_ITEM.x, wy: BAK_ITEM.y, at: 'w3-menu-9' }, { f: 1774, wx: BAK_ITEM.x, wy: BAK_ITEM.y, at: 'w3-menu-9' },
  { f: 1810, wx: 700, wy: 400 }, { f: 1950, wx: SF.star.x, wy: SF.star.y, at: 'w3-sf-star' }, { f: 1968, wx: SF.star.x, wy: SF.star.y, at: 'w3-sf-star' }, { f: 2036, wx: FAV_OK.x, wy: FAV_OK.y, at: 'w3-fav-ok' }, { f: 2050, wx: FAV_OK.x, wy: FAV_OK.y, at: 'w3-fav-ok' },
  { f: 2058, wx: SF.favBtn.x, wy: SF.favBtn.y, at: 'w3-sf-fav' }, { f: 2070, wx: SF.favBtn.x, wy: SF.favBtn.y, at: 'w3-sf-fav' }, { f: 2095, wx: 371, wy: 166, at: 'w3-entry-apps' }, { f: 2108, wx: 371, wy: 166, at: 'w3-entry-apps' }, { f: 2126, wx: 371, wy: 166, at: 'w3-entry-apps' },
  { f: 2136, wx: 1450, wy: 164, at: 'w3-fav-item' }, { f: 2150, wx: 1450, wy: 164, at: 'w3-fav-item' }, { f: 2160, wx: SF.searchBtn.x, wy: SF.searchBtn.y, at: 'w3-sf-search' }, { f: 2174, wx: SF.searchBtn.x, wy: SF.searchBtn.y, at: 'w3-sf-search' }, { f: 2210, wx: 1560, wy: 140 },
  { f: 2246, wx: SF.listBtn.x, wy: SF.listBtn.y, at: 'w3-sf-list' }, { f: 2270, wx: SF.listBtn.x, wy: SF.listBtn.y, at: 'w3-sf-list' }, { f: 2284, wx: 1248, wy: 141, at: 'w3-sort-th' }, { f: 2400, wx: 1248, wy: 141, at: 'w3-sort-th' }, { f: 2460, wx: 900, wy: 700 },
];

export const CUR_PATH: readonly AnchorStop[] = CUR_DEF.map(({ f, wx, wy, at }) => ({ f, at, ...wfAt(f, wx, wy) }));

/* ============ 点击(涟漪;anchor 命中实测中心,wx/wy 为冷启动兜底) ============ */
const click = (f: number, wx: number, wy: number, target: Click['target'], anchor?: string): Click => ({
  f, target, anchor, ...wfAt(f, wx, wy),
});
export const CLICKS: readonly Click[] = [
  click(A_PRESS, row0.x, row0.y, 'row', 'w3-os-row0'),
  click(A_DROP, 240, 186, 'row'),
  click(B_SERVERS, ACT.servers.x, ACT.servers.y, 'browse', 'w3-act-servers'),
  click(B_CARD, 177, 157, 'browse', 'w3-card'),
  click(B_SFTP, SFTP_BTN.x + 13, SFTP_BTN.y + 13, 'browse', 'w3-sftp-btn'),
  click(B_EXPLORER, ACT.explorer.x, ACT.explorer.y, 'browse', 'w3-act-explorer'),
  click(B_UP_PRESS, 180, 162, 'row', 'w3-os-row0'),
  click(B_UP_DROP, 880, 470, 'row'),
  click(B_REJ_PRESS, row1.x, row1.y, 'row', 'w3-os-row1'),
  click(B_REJ_DROP, 880, 470, 'row'),
  click(B_RC_DEPLOY, 559, 244, 'row', 'w3-entry-deploy.md'),
  click(B_DL_CLICK, DL_ITEM.x, DL_ITEM.y, 'confirm', 'w3-menu-18'),
  click(C_OPEN1, 462, 244, 'row', 'w3-entry-app-config.yml'),
  click(C_OPEN1 + 12, 462, 244, 'row', 'w3-entry-app-config.yml'),
  click(C_SEL1, 464, 219, 'input'),
  click(C_SEL1 + 11, 464, 219, 'input'),
  click(C_OPEN2, 150, 234, 'row', 'w3-tree-README.md'),
  click(C_OPEN2 + 11, 150, 234, 'row', 'w3-tree-README.md'),
  click(D_TAB, 536, 58, 'browse', 'w3-tab-sftp'),
  click(D_RC_LOGS, 655, 166, 'row', 'w3-entry-logs'),
  click(D_ZIP, ZIP_ITEM.x, ZIP_ITEM.y, 'confirm', 'w3-menu-8'),
  click(D_RC_APPS, 366, 166, 'row', 'w3-entry-apps'),
  click(D_BAK, BAK_ITEM.x, BAK_ITEM.y, 'confirm', 'w3-menu-9'),
  click(E_STAR, SF.star.x, SF.star.y, 'browse', 'w3-sf-star'),
  click(E_FAVOK, FAV_OK.x, FAV_OK.y, 'save', 'w3-fav-ok'),
  click(E_FAVBTN, SF.favBtn.x, SF.favBtn.y, 'browse', 'w3-sf-fav'),
  click(E_APPS1, 371, 166, 'row', 'w3-entry-apps'),
  click(E_APPS2, 371, 166, 'row', 'w3-entry-apps'),
  click(E_JUMP, 1450, 164, 'confirm', 'w3-fav-item'),
  click(E_SEARCH, SF.searchBtn.x, SF.searchBtn.y, 'browse', 'w3-sf-search'),
  click(E_LIST, SF.listBtn.x, SF.listBtn.y, 'browse', 'w3-sf-list'),
  click(E_SORT1, 1248, 141, 'confirm', 'w3-sort-th'),
  click(E_SORT2, 1248, 141, 'confirm', 'w3-sort-th'),
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

/** 焦点高亮环(锚点实测,pad 外扩) */
export const HIGHLIGHTS3 = [
  { target: 'w3-sftp-btn', pad: 5, r: 6, from: 496, to: 516 },
  { target: 'w3-sf-star', pad: 10, r: 8, from: 1950, to: 1976 },
  { target: 'w3-sf-fav', pad: 4, r: 6, from: 2052, to: 2072 },
  { target: 'w3-sf-search', pad: 4, r: 6, from: 2156, to: 2176 },
  { target: 'w3-sf-list', pad: 4, r: 6, from: 2252, to: 2272 },
  { target: 'w3-sort-th', pad: 4, r: 4, from: 2290, to: 2336 },
] as const;

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
