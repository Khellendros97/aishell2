/**
 * 视频三(文件管理 + SFTP)场景几何常量。
 * 全部按当前 React 前端实测布局取值(workbench.css / explorer.css / sftp.css / editor.css),
 * 与场景组件的 CSS 共用同一份数值,指针/运镜锚点由此推导。
 * 坐标系:窗口设计稿 1920×1200。SFTP mono 字号 12.5 → 字符宽约 7.2px;编辑器 13px → 7.8px。
 */

/* ================= 工作台骨架(与真实前端一致) ================= */
/* 活动栏:顶栏 40 之下,padding-top 6 + 图标 40 + gap 2 → 图标中心 y = 66 + i*42 */
export const ACT = {
  explorer: { x: 24, y: 66 },
  servers: { x: 24, y: 108 },
  commands: { x: 24, y: 150 },
  skills: { x: 24, y: 192 },
  notes: { x: 24, y: 234 },
  browser: { x: 24, y: 276 },
} as const;

export const SIDEBAR = { x: 48, w: 260, headH: 34 }; // 内容区 y 74 起,内容 padding-top 4
/** 资源管理器树行中心 y(行高 24) */
export const treeRowY = (i: number): number => 74 + 4 + 12 + i * 24;

/* 服务器卡片:本地终端卡(48px)+ margin 8 之后;actions 行 4 个 26×26 右对齐 gap 6 */
export const SERVER_CARD = { x: 56, y: 134, w: 244, h: 102 };
export const SFTP_BTN = { x: 198, y: 202, w: 26, h: 26 };

export const CENTER = { x: 308, w: 1272, tabBarH: 36 }; // 内容区 y 76..1174
export const AI = { x: 1580, w: 340 };
/** 标签栏各标签 x 区间(按 title 估宽:min 110 max 200) */
export const TABS_X: Record<string, [number, number]> = {
  term: [308, 460],
  sftp: [460, 612],
  edApp: [612, 752],
  edReadme: [752, 870],
};
export const tabCx = (r: [number, number]): number => (r[0] + r[1]) / 2;

/* ================= SFTP 面板 ================= */
export const SF = {
  toolbarTop: 76,
  toolbarH: 41, // 76..117(28px 控件 + 上下 6px padding + 1px 边框)
  bodyTop: 117,
  /** 导航按钮中心(28px 宽,gap 2,自 x=318 起),中心 y 96 */
  nav: { back: 332, fwd: 362, up: 392, home: 422, root: 452, cy: 96 },
  pathWrap: { x1: 476, x2: 1388 },
  /** 地址栏内嵌星按钮 */
  star: { x: 1373, y: 96 },
  go: { x: 1423, y: 96 },
  gridBtn: { x: 1466, y: 96 },
  listBtn: { x: 1496, y: 96 },
  favBtn: { x: 1526, y: 96 },
  searchBtn: { x: 1556, y: 96 },
  /** 搜索展开(160px 输入框)后,右侧按钮簇整体左移量 */
  searchShift: -166,
  bodyPad: 12,
  favW: 200,
} as const;

/** 网格条目中心 x(fav 侧栏展开后 body 变窄,列数/步距变化) */
export const gridColX = (i: number, favOpen: boolean): number =>
  favOpen ? 320 + 50.6 + i * 105.2 : 320 + 46.15 + i * 96.31;
/** 网格条目中心 y(条目高 74 + gap 4,首行 top 129;列数 fav 关 13 / 开 10) */
export const gridRowY = (i: number): number => 129 + 37 + i * 78;
export const gridCols = (favOpen: boolean): number => (favOpen ? 10 : 13);

/** 列表视图几何(favOpen 决定表格宽度与时间列位置) */
export const tableGeom = (favOpen: boolean) => ({
  x1: 320,
  x2: favOpen ? 1368 : 1568,
  thY: 141,
  rowH: 27,
  nameThX: 345,
  /** 修改时间表头点击锚(时间列左 padding 10 + 文字半宽) */
  timeThX: favOpen ? 1248 : 1448,
});

/** 收藏夹侧栏(右侧 200px,头部 ~29px) */
export const FAVP = {
  x: 1380,
  w: 200,
  itemY: (i: number): number => 117 + 29 + 4 + 14 + i * 26,
};

/* ================= 右键菜单 ================= */
/* itemH = 上下 padding 6×2 + 文本行 ~15(12.5px 字号) */
export const MENU = { w: 216, itemH: 27, sepH: 9, pad: 4 } as const;

/** 菜单第 idx 项的中心 y(top 为菜单框顶) */
export function menuItemY(top: number, idx: number, items: readonly (string | 'sep')[]): number {
  let y = top + MENU.pad;
  for (let i = 0; i < idx; i++) y += items[i] === 'sep' ? MENU.sepH : MENU.itemH;
  return y + (items[idx] === 'sep' ? MENU.sepH : MENU.itemH) / 2;
}

/** 条目右键菜单(与 SftpTab showEntryMenu 一致;目录无「赋予可执行权限」) */
export const FILE_MENU: readonly (string | 'sep')[] = [
  '打开', '添加到对话', 'sep', '暂存', '复制', '剪切', '粘贴', 'sep',
  '压缩为 tgz', '快速备份', 'sep', '属性', '权限设置', '赋予可执行权限', 'sep',
  '重命名', '删除', 'sep', '下载',
];
export const DIR_MENU: readonly (string | 'sep')[] = [
  '打开', '添加到对话', 'sep', '暂存', '复制', '剪切', '粘贴', 'sep',
  '压缩为 tgz', '快速备份', 'sep', '属性', '权限设置', 'sep',
  '重命名', '删除', 'sep', '下载',
];
export const MENU_ICONS: Record<string, string> = {
  打开: 'file', 添加到对话: 'chatPlus', 暂存: 'history', 复制: 'copy', 剪切: 'scissors',
  粘贴: 'clipboard', '压缩为 tgz': 'package', 快速备份: 'history', 属性: 'info',
  权限设置: 'lock', 赋予可执行权限: 'zap', 重命名: 'pencil', 删除: 'trash', 下载: 'download',
};

/* ================= 收藏目录对话框 ================= */
export const FAV_MODAL = { x: 730, y: 490, w: 460, h: 236 } as const;
export const FAV_OK = { x: 1134, y: 668 } as const;

/* ================= 编辑器 ================= */
export const ED = {
  x: 308, w: 1272, top: 76,
  gutterW: 56,
  padLeft: 14,
  contentTop: 84,
  lineH: 20.8,
} as const;
/** 第 i 行的中心 y / 第 col 列字符的 x(近似) */
export const edLineY = (i: number): number => ED.contentTop + i * ED.lineH + 10;
export const edCharX = (col: number): number => ED.x + ED.gutterW + ED.padLeft + col * 7.8;

/* ================= OS 资源管理器窗口 ================= */
export const OS_WIN = { x: 150, y: 640, w: 500, h: 396 } as const;
/** OS 窗口文件行抓取点(标题栏 40 + 工具行 44 + 表头 30,行高 32) */
export const osRow = (i: number): { x: number; y: number } => ({ x: 265, y: 640 + 40 + 44 + 30 + 16 + i * 32 });

/* ================= 演示数据 ================= */
const ts = (s: string): number => new Date(s.replace(' ', 'T') + ':00+08:00').getTime() / 1000;

export interface EntryDef {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** /home/devops 初始条目(顺序即 grid 顺序:目录在前按名排,文件按名排) */
export const HOME_ENTRIES: EntryDef[] = [
  { name: 'apps', isDir: true, size: 0, mtime: ts('2026-08-28 09:12') },
  { name: 'backups', isDir: true, size: 0, mtime: ts('2026-07-02 18:40') },
  { name: 'conf', isDir: true, size: 0, mtime: ts('2026-06-18 11:02') },
  { name: 'logs', isDir: true, size: 0, mtime: ts('2026-08-30 09:00') },
  { name: '.bashrc', isDir: false, size: 142, mtime: ts('2026-07-15 20:31') },
  { name: 'deploy.md', isDir: false, size: 4920, mtime: ts('2026-08-12 10:05') },
  { name: 'README.md', isDir: false, size: 2150, mtime: ts('2026-08-01 14:20') },
];

/** 上传/压缩/备份产物(按演示时间戳) */
export const UPLOADED: EntryDef = { name: 'app-config.yml', isDir: false, size: 1180, mtime: ts('2026-08-30 11:20') };
export const ARCHIVE: EntryDef = { name: 'logs.tgz', isDir: false, size: 3_360_000, mtime: ts('2026-08-30 11:40') };
export const BACKUP: EntryDef = { name: 'apps_bak20260830-1145.tgz', isDir: false, size: 15_800_000, mtime: ts('2026-08-30 11:45') };

/** /home/devops/apps 内容 */
export const APPS_ENTRIES: EntryDef[] = [
  { name: 'start.sh', isDir: false, size: 620, mtime: ts('2026-08-26 18:22') },
  { name: 'worker.jar', isDir: false, size: 48_300_000, mtime: ts('2026-08-26 18:20') },
];

export const DEMO = {
  projectName: 'deephaven-bigdata',
  serverName: 'deephaven-dev-01',
  serverHost: '10.21.36.8',
  home: '/home/devops',
  appsDir: '/home/devops/apps',
  uploadName: 'app-config.yml',
  osName2: 'rollback.sh',
  downloadName: 'deploy.md',
  favTitle: 'devops',
} as const;

/** 大小格式化(与 SftpTab fmtSize 一致) */
export function fmtSize(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

/** 时间格式化(与 SftpTab fmtTime 一致) */
export function fmtTime(unixSec: number): string {
  const dt = new Date(unixSec * 1000);
  const p = (v: number): string => String(v).padStart(2, '0');
  return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate()) + ' ' + p(dt.getHours()) + ':' + p(dt.getMinutes());
}

/** 列表视图排序(与 SftpTab sortedEntries 一致:目录恒在前) */
export function sortedEntries(entries: EntryDef[], key: 'name' | 'mtime', asc: boolean): EntryDef[] {
  const arr = entries.slice();
  arr.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const d = key === 'name'
      ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
      : a.mtime - b.mtime;
    return asc ? d : -d;
  });
  return arr;
}
