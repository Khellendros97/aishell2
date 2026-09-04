/**
 * 视频五导演脚本:全部运镜/指针/点击/字幕/场景状态的帧级编排。
 * 状态推导为纯函数(wbAt),组件只负责渲染;锚点坐标全部来自 ./layout.ts。
 *
 * 剧情线(30fps,约 105s):
 *   O  0–200     开场全景 → 活动栏地球打开内置浏览器
 *   A  200–560   地址栏输入远程主机网址,页面加载(Nebula Data)
 *   Z  560–800   Ctrl+滚轮缩放网页(1.5× 后复原)
 *   B  800–1130  检查元素:激活 → 悬停 hero 标题 → 选中,@browser 引用进输入框
 *   C  1130–2080 AI 依 IP 定位远程主机 → SSH 定位部署目录 → 修改文件 →
 *                browser_open 刷新页面,样式生效(品牌蓝 64px + 胶囊按钮)
 *   D  2080–2990 案例 2:AI 设计落地页 → 本地创建 HTML → 文本建议卡地球按钮
 *                在内置浏览器打开(Aurora AI 深色设计稿)
 *   G  2990–3160 收尾全景
 */
import { interpolate } from 'remotion';
import { Stop } from '../anim';
import { Click } from '../components/Cursor';
import {
  CHAT, ChatItem, DEMO, ITEM_W, Q1, Q2, SITE1, suggestGlobeAnchor, stackChat, toWin,
} from './layout';
import { Wb5State } from './Wb5';

/* ============ 关键帧 ============ */
const B_OPEN_CLICK = 200; // 活动栏地球 → 打开浏览器标签页
const TAB_IN = 204;
const ADDR_CLICK = 340;
const TYPING_URL_FROM = 352;
const URL_ENTER = 500;
const LOAD1_FROM = 504;
const SITE1_IN = 560;
const ZOOM_IN_FROM = 620;
const ZOOM_IN_TO = 690;
const ZOOM_OUT_FROM = 710;
const ZOOM_OUT_TO = 770;
const INSPECT_CLICK = 840;
const HOVER_FROM = 896;
const PICK_CLICK = 1040;
const CHIP_IN = 1060;
const Q1_CLICK = 1130;
const TYPING_Q1_FROM = 1142;
const Q1_ENTER = 1250;
const AI1_T = 1300;
const ACT1_T = 1400;
const ACT1_OK = 1470;
const AI2_T = 1510;
const ACT2_T = 1610;
const ACT2_OK = 1720;
const AI3_T = 1810;
const RELOAD_T = 1880; // AI 调 browser_open → 页面刷新
const LOAD2_END = 1934;
const SITE1B_IN = 1934;
const Q2_CLICK = 2130;
const TYPING_Q2_FROM = 2142;
const Q2_ENTER = 2260;
const AI4_T = 2300;
const ACT3_T = 2400;
const ACT3_OK = 2480;
const AI5_T = 2540;
const SUGGEST_T = 2580;
const GLOBE_CLICK = 2660; // 文本建议卡「在内置浏览器中打开」
const LOAD3_FROM = 2700;
const SITE2_IN = 2756;
export const DURATION = 3160;

/* ============ 摄像机轨道 ============ */
export const CAM_S: readonly Stop[] = [
  { f: 0, v: 0.75 }, { f: 150, v: 0.75 }, { f: 190, v: 1.35 }, { f: 280, v: 1.35 },
  { f: 330, v: 1.5 }, { f: 520, v: 1.5 }, { f: 560, v: 1.15 }, { f: 660, v: 1.15 }, { f: 800, v: 1.15 },
  { f: 836, v: 1.5 }, { f: 880, v: 1.5 }, { f: 920, v: 1.35 }, { f: 1050, v: 1.35 },
  { f: 1090, v: 1.5 }, { f: 1240, v: 1.5 }, { f: 1270, v: 1.4 }, { f: 1860, v: 1.4 },
  { f: 1900, v: 1.25 }, { f: 2080, v: 1.25 }, { f: 2110, v: 1.5 }, { f: 2250, v: 1.5 },
  { f: 2280, v: 1.35 }, { f: 2620, v: 1.55 }, { f: 2690, v: 1.25 }, { f: 2756, v: 1.1 },
  { f: 2990, v: 1.02 }, { f: 3070, v: 0.75 }, { f: DURATION, v: 0.75 },
];
export const CAM_X: readonly Stop[] = [
  { f: 0, v: 960 }, { f: 150, v: 960 }, { f: 190, v: 300 }, { f: 280, v: 300 },
  { f: 330, v: 940 }, { f: 520, v: 940 }, { f: 560, v: 927 }, { f: 660, v: 1150 }, { f: 800, v: 927 },
  { f: 836, v: 1080 }, { f: 880, v: 1080 }, { f: 920, v: 927 }, { f: 1050, v: 927 },
  { f: 1090, v: 1750 }, { f: 1240, v: 1750 }, { f: 1270, v: 1750 }, { f: 1860, v: 1750 },
  { f: 1900, v: 927 }, { f: 2080, v: 927 }, { f: 2110, v: 1750 }, { f: 2250, v: 1750 },
  { f: 2280, v: 1750 }, { f: 2620, v: 1720 }, { f: 2690, v: 927 }, { f: 2756, v: 927 },
  { f: 2990, v: 927 }, { f: 3070, v: 960 }, { f: DURATION, v: 960 },
];
export const CAM_Y: readonly Stop[] = [
  { f: 0, v: 600 }, { f: 150, v: 600 }, { f: 190, v: 520 }, { f: 280, v: 520 },
  { f: 330, v: 150 }, { f: 520, v: 150 }, { f: 560, v: 430 }, { f: 660, v: 500 }, { f: 800, v: 430 },
  { f: 836, v: 160 }, { f: 880, v: 160 }, { f: 920, v: 420 }, { f: 1050, v: 420 },
  { f: 1090, v: 950 }, { f: 1240, v: 950 },
  { f: 1270, v: 900 }, { f: 1500, v: 860 }, { f: 1760, v: 770 }, { f: 1860, v: 740 },
  { f: 1900, v: 480 }, { f: 2080, v: 480 }, { f: 2110, v: 950 }, { f: 2250, v: 950 },
  { f: 2280, v: 720 }, { f: 2620, v: 830 }, { f: 2690, v: 480 }, { f: 2756, v: 520 },
  { f: 2990, v: 600 }, { f: 3070, v: 600 }, { f: DURATION, v: 600 },
];

/* ============ 消息流 ============ */
export function buildItems(frame: number): ChatItem[]{ return stackChat(buildSpecs(frame)); }

function buildSpecs(frame: number): import('./layout').ChatSpec[] {
  const specs: import('./layout').ChatSpec[] = [];
  if (frame >= Q1_ENTER) {
    specs.push({ kind: 'user', id: 'u1', chip: '@browser:#hero-title', lines: ['把这个标题改成品牌蓝，', '按钮改成胶囊圆角'] });
  }
  if (frame >= AI1_T) {
    const typing = frame < AI1_T + 14;
    specs.push({
      kind: 'ai', id: 'ai1', typing,
      lines: ['好的，该网站 IP 10.21.36.8 命中服务器', 'deephaven-dev-01，先定位部署目录。'],
    });
  }
  if (frame >= ACT1_T) {
    specs.push({
      kind: 'action', id: 'act1',
      status: frame < ACT1_OK ? 'running' : 'succeeded',
      spec: { name: '执行命令', icon: 'wrench', cmd: 'ssh deploy@10.21.36.8 "ls /var/www"', result: '/var/www/nebula' },
    });
  }
  if (frame >= AI2_T) {
    const typing = frame < AI2_T + 14;
    specs.push({ kind: 'ai', id: 'ai2', typing, lines: ['已定位部署目录 /var/www/nebula，', '正在修改 index.html。'] });
  }
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
  if (frame >= AI3_T) {
    const typing = frame < AI3_T + 14;
    specs.push({
      kind: 'ai', id: 'ai3', typing,
      lines: ['修改完成，已用「打开浏览器」工具', '刷新页面，改动即刻可见。'],
      tool: typing ? undefined : 'browser_open http://10.21.36.8',
    });
  }
  if (frame >= Q2_ENTER) {
    specs.push({ kind: 'user', id: 'u2', lines: ['再设计一个 AI 产品的落地页，', '深色科技风，保存到项目里'] });
  }
  if (frame >= AI4_T) {
    const typing = frame < AI4_T + 14;
    specs.push({ kind: 'ai', id: 'ai4', typing, lines: ['好的，我来设计并生成本地页面文件。'] });
  }
  if (frame >= ACT3_T) {
    specs.push({
      kind: 'action', id: 'act3',
      status: frame < ACT3_OK ? 'running' : 'succeeded',
      spec: {
        name: '创建文件', icon: 'filePlus',
        intent: '意图：深色科技风落地页（Aurora AI）',
        meta: 'D:\\projects\\nebula\\design\\landing.html',
        result: '已创建 design/landing.html · 12.6 KB',
      },
    });
  }
  if (frame >= AI5_T) {
    const typing = frame < AI5_T + 14;
    specs.push({
      kind: 'ai', id: 'ai5', typing,
      lines: ['设计稿已生成，点击卡片上的地球按钮', '可在内置浏览器中打开预览。'],
      suggest: frame >= SUGGEST_T ? { text: DEMO.localFile, url: true } : undefined,
    });
  }
  return specs;
}

/* ============ 动态锚点(文本建议卡地球按钮,指针轨/点击/高亮共用) ============ */
export function suggestGlobeAnchorAt(frame: number): { x: number; y: number } {
  const item = buildItems(frame).find((it) => it.id === 'ai5');
  if (!item || item.kind !== 'ai' || !item.suggest) return { x: CHAT.l + ITEM_W - 22, y: CHAT.bottom };
  return suggestGlobeAnchor(item);
}
const GLOBE_ANCHOR = suggestGlobeAnchorAt(GLOBE_CLICK + 6);

/* ============ 指针轨道(点位表 → x/y 双轨) ============ */
const CURVE: readonly (readonly [number, number, number])[] = [
  [60, 1450, 900],
  [176, 24, 276],
  [240, 420, 220],
  [330, 900, 96],
  [500, 900, 96],
  [524, 927, 470],
  [810, 927, 470],
  [830, 1522, 96],
  [884, 1522, 96],
  [902, 870, 342],
  [940, 927, 346],
  [972, 1000, 350],
  [1002, 935, 344],
  [1028, 927, 345],
  [1076, 1750, 1130],
  [1240, 1750, 1130],
  [1262, 1850, 960],
  [1856, 1850, 960],
  [1888, 927, 470],
  [2066, 927, 470],
  [2098, 1750, 1130],
  [2250, 1750, 1130],
  [2272, 1850, 960],
  [2624, GLOBE_ANCHOR.x, GLOBE_ANCHOR.y],
  [2688, GLOBE_ANCHOR.x, GLOBE_ANCHOR.y],
  [2716, 927, 470],
  [2990, 927, 600],
  [3050, 1500, 940],
  [3140, 1500, 940],
];
export const CUR_X: readonly Stop[] = CURVE.map(([f, x]) => ({ f, v: x }));
export const CUR_Y: readonly Stop[] = CURVE.map(([f, , y]) => ({ f, v: y }));

/* ============ 点击(涟漪) ============ */
export const CLICKS: readonly Click[] = [
  { f: B_OPEN_CLICK, x: 24, y: 276, target: 'browse' },
  { f: ADDR_CLICK, x: 900, y: 96, target: 'input' },
  { f: URL_ENTER, x: 900, y: 96, target: 'input' },
  { f: INSPECT_CLICK, x: 1522, y: 96, target: 'browse' },
  { f: PICK_CLICK, x: 927, y: 345, target: 'row' },
  { f: Q1_CLICK, x: 1750, y: 1130, target: 'input' },
  { f: Q1_ENTER, x: 1750, y: 1130, target: 'input' },
  { f: Q2_CLICK, x: 1750, y: 1130, target: 'input' },
  { f: Q2_ENTER, x: 1750, y: 1130, target: 'input' },
  { f: GLOBE_CLICK, x: GLOBE_ANCHOR.x, y: GLOBE_ANCHOR.y, target: 'browse' },
];

/* ============ 字幕 ============ */
export const CAPTIONS5 = [
  { from: 4, to: 100, text: '内置浏览器：打开远程网站 · 检查元素 · AI 联动改造' },
  { from: 130, to: 250, text: '活动栏点击地球图标，打开内置浏览器标签页' },
  { from: 300, to: 470, text: '地址栏输入部署在远程主机上的网站地址' },
  { from: 600, to: 780, text: '按住 Ctrl 滚动滚轮，自由缩放网页' },
  { from: 850, to: 1030, text: '「检查元素」：选中页面元素，加入 AI 对话' },
  { from: 1140, to: 1240, text: '命令 AI 助手修改样式' },
  { from: 1360, to: 1590, text: 'AI 根据网站 IP 找到对应远程主机，定位部署目录' },
  { from: 1650, to: 1770, text: '经 SSH 修改网站文件，全程无需离开对话' },
  { from: 1850, to: 2060, text: 'AI 调用「打开浏览器」工具刷新网页，改动即刻可见' },
  { from: 2120, to: 2250, text: '案例 2：让 AI 设计一个落地页' },
  { from: 2390, to: 2540, text: 'AI 在本地创建 HTML 设计稿' },
  { from: 2600, to: 2740, text: '点击「在内置浏览器中打开」，预览设计产物' },
  { from: 3000, to: 3120, text: '内置浏览器 × AI 助手：看到即可改到，设计即刻预览' },
];

/* ============ 教学叠加层 ============ */
export interface Note5 {
  from: number;
  to: number;
  x: number;
  y: number;
  w: number;
  kind: 'info' | 'alert';
  title: string;
  body: string;
}
export const NOTES5: readonly Note5[] = [
  {
    from: 596, to: 800, x: 1180, y: 560, w: 420, kind: 'info',
    title: 'Ctrl+滚轮缩放',
    body: '内置浏览器启用缩放热键：按住 Ctrl 滚动滚轮即可放大/缩小网页，由 WebView2 原生渲染，与页面样式互不干扰。',
  },
  {
    from: 1360, to: 1590, x: 1120, y: 620, w: 450, kind: 'info',
    title: 'IP → 远程主机自动定位',
    body: '网站 IP 10.21.36.8 与服务器列表中的 deephaven-dev-01 匹配；AI 经 SSH 定位部署目录 /var/www/nebula，直接修改页面文件。',
  },
  {
    from: 2560, to: 2740, x: 1150, y: 560, w: 400, kind: 'info',
    title: '在内置浏览器中打开',
    body: '文本建议块包含链接或本地文件路径时，点击地球按钮即可在内置浏览器中打开预览，无需离开工作台。',
  },
];

/** 键盘提示 */
export const KBD5: readonly { from: number; to: number; x: number; y: number; label: string }[] = [
  { from: 610, to: 780, x: 980, y: 500, label: 'Ctrl + 滚轮' },
];

/** 焦点高亮环 */
const HERO_WIN = toWin(SITE1.heroTitleStyled);
export const HIGHLIGHTS5 = [
  { x: 4, y: 256, w: 40, h: 40, r: 6, from: 176, to: 198 },
  { x: 420, y: 82, w: 1048, h: 28, r: 4, from: 312, to: 498 },
  { x: 1508, y: 82, w: 28, h: 28, r: 4, from: 816, to: 838 },
  { x: 1596, y: 1098, w: 162, h: 24, r: 4, from: 1064, to: 1126 },
  { x: HERO_WIN.x, y: HERO_WIN.y, w: HERO_WIN.w, h: HERO_WIN.h, r: 4, from: 1950, to: 2060 },
  { x: GLOBE_ANCHOR.x - 14, y: GLOBE_ANCHOR.y - 14, w: 28, h: 28, r: 4, from: 2600, to: 2656 },
];

/* ============ 工具 ============ */
const typed = (frame: number, from: number, step: number, full: string): string =>
  full.slice(0, Math.max(0, Math.min(full.length, Math.floor((frame - from) / step) + 1)));

const inSpan = (frame: number, a: number, b: number): boolean => frame >= a && frame < b;

/* ============ 状态推导 ============ */
export function wbAt(frame: number): Wb5State {
  /* ---- 标签页 ---- */
  const browserTabT = interpolate(frame, [TAB_IN, TAB_IN + 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const centerTab: Wb5State['centerTab'] = frame >= TAB_IN + 6 ? 'browser' : 'terminal';

  /* ---- 地址栏 ---- */
  const addressFocus = inSpan(frame, ADDR_CLICK, URL_ENTER + 6);
  let addressText = '';
  if (inSpan(frame, TYPING_URL_FROM, URL_ENTER + 6)) addressText = typed(frame, TYPING_URL_FROM, 8, DEMO.siteUrl);
  else if (frame >= URL_ENTER + 6 && frame < GLOBE_CLICK + 8) addressText = DEMO.siteUrl;
  else if (frame >= GLOBE_CLICK + 8) addressText = DEMO.localFile;

  /* ---- 页面内容与加载 ---- */
  const site: Wb5State['site'] = frame < SITE1_IN ? 'none' : frame < SITE2_IN ? 'remote' : 'local';
  const siteIn =
    site === 'remote'
      ? interpolate(frame, [frame >= SITE1B_IN ? SITE1B_IN : SITE1_IN, (frame >= SITE1B_IN ? SITE1B_IN : SITE1_IN) + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
      : site === 'local'
        ? interpolate(frame, [SITE2_IN, SITE2_IN + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
        : 0;
  const loading =
    inSpan(frame, LOAD1_FROM, SITE1_IN) ? interpolate(frame, [LOAD1_FROM, SITE1_IN], [0.08, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : inSpan(frame, RELOAD_T, LOAD2_END) ? interpolate(frame, [RELOAD_T, LOAD2_END], [0.08, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : inSpan(frame, LOAD3_FROM, SITE2_IN) ? interpolate(frame, [LOAD3_FROM, SITE2_IN], [0.08, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 0;

  /* ---- Ctrl+滚轮缩放 ---- */
  const zoomIn = interpolate(frame, [ZOOM_IN_FROM, ZOOM_IN_TO], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const zoomOut = interpolate(frame, [ZOOM_OUT_FROM, ZOOM_OUT_TO], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const zoom = 1 + 0.5 * (zoomIn - zoomOut);

  /* ---- 检查元素 ---- */
  const inspectOn = inSpan(frame, INSPECT_CLICK + 4, PICK_CLICK + 4);
  const inspect = inSpan(frame, HOVER_FROM, PICK_CLICK + 6)
    ? { t: interpolate(frame, [HOVER_FROM, HOVER_FROM + 10, PICK_CLICK, PICK_CLICK + 6], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }
    : null;
  const styledT = interpolate(frame, [SITE1B_IN, SITE1B_IN + 28], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  /* ---- 输入区 ---- */
  const inputFocus = inSpan(frame, Q1_CLICK, Q1_ENTER + 4) || inSpan(frame, Q2_CLICK, Q2_ENTER + 4);
  let inputText = '';
  if (inSpan(frame, TYPING_Q1_FROM, Q1_ENTER + 4)) inputText = typed(frame, TYPING_Q1_FROM, 5.5, Q1);
  else if (inSpan(frame, TYPING_Q2_FROM, Q2_ENTER + 4)) inputText = typed(frame, TYPING_Q2_FROM, 5, Q2);
  const inputChip = inSpan(frame, CHIP_IN, Q1_ENTER + 4);
  const inputCaret = inputFocus && inputText.length > 0;

  /* ---- hover / press ---- */
  const hover: Wb5State['hover'] =
    inSpan(frame, 176, B_OPEN_CLICK) ? 'actBrowser'
    : inSpan(frame, 300, ADDR_CLICK) ? 'address'
    : inSpan(frame, 816, INSPECT_CLICK) ? 'inspect'
    : inSpan(frame, 1100, Q1_CLICK + 2) || inSpan(frame, 2100, Q2_CLICK + 2) ? 'input'
    : inSpan(frame, 2596, GLOBE_CLICK) ? 'globe'
    : null;
  const press: Wb5State['hover'] =
    inSpan(frame, B_OPEN_CLICK, B_OPEN_CLICK + 6) ? 'actBrowser'
    : inSpan(frame, ADDR_CLICK, ADDR_CLICK + 6) ? 'address'
    : inSpan(frame, INSPECT_CLICK, INSPECT_CLICK + 6) ? 'inspect'
    : inSpan(frame, Q1_CLICK, Q1_CLICK + 6) || inSpan(frame, Q2_CLICK, Q2_CLICK + 6) ? 'input'
    : inSpan(frame, GLOBE_CLICK, GLOBE_CLICK + 6) ? 'globe'
    : null;

  return {
    browserTabT,
    centerTab,
    addressFocus,
    addressText,
    addressCaret: addressFocus,
    site,
    siteIn,
    loading,
    zoom,
    inspectOn,
    inspect,
    styledT,
    items: buildItems(frame),
    inputText,
    inputCaret,
    inputFocus,
    inputChip,
    hover,
    press,
  };
}
