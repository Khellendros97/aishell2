/**
 * 激励计划宣传片 —— 几何与演示数据。
 * 窗口按主仓真实尺寸绘制（1440×900，decorations:false 的无边框窗口），内部布局严格照
 * workbench.css 的像素值：topbar 40 / activity-bar 48 / sidebar 260 / AI 面板 340 / tab-bar 36 / statusbar 26。
 * 所有热区坐标由这套真实布局推导，与真实控件对齐（不再凭感觉摆位）。
 */

/* ---------------- 窗口与镜头 ---------------- */

/** 窗口内部按主仓真实尺寸绘制（1440×900，tauri.conf 默认窗口，保持 1.6 比例） */
export const NATIVE = { w: 1440, h: 900 } as const;

/** 显示缩放：把真实 1440×900 窗口等比缩进 1080p 画面，上下留出章节标/结算卡/字幕带 */
export const SCALE = 0.78;

/** 悬浮窗口在视频坐标系（1920×1080）中的位置与外框尺寸 */
export const WIN = {
  x: Math.round((1920 - NATIVE.w * SCALE) / 2), // 398
  y: 118,
  w: Math.round(NATIVE.w * SCALE), // 1123
  h: Math.round(NATIVE.h * SCALE), // 702
};

/** 窗口内部像素 → 视频坐标（热区/高亮环/指针统一走这里） */
export function toStage(x: number, y: number, w: number, h: number): Rect {
  return { x: WIN.x + x * SCALE, y: WIN.y + y * SCALE, w: w * SCALE, h: h * SCALE };
}

/** 工作台骨架尺寸（照 workbench.css / statusbar.css，窗口内部真实像素） */
export const L = {
  topbar: 40,
  activity: 48,
  sidebar: 260,
  ai: 340,
  tab: 36,
  status: 26,
} as const;

/** 中央区几何（由骨架推导，窗口内部像素） */
export const CTR = {
  x: L.activity + L.sidebar, // 308
  y: L.topbar + L.tab, // 76
  w: NATIVE.w - L.activity - L.sidebar - L.ai, // 792
  h: NATIVE.h - L.topbar - L.tab - L.status, // 798
} as const;
export const AI_X = L.activity + L.sidebar + CTR.w; // 1100
export const SIDEBAR_X = L.activity; // 48

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const r = (x: number, y: number, w: number, h: number): Rect => ({ x, y, w, h });

/* ---------------- 各渠道热区（窗口内部真实像素） ---------------- */
/* 以下为指针轨道的兜底近似值：锚点（data-anchor）尚未挂载的极少数帧用它过渡，
   挂载后坐标一律以运行时实测为准（见 components/anchors.tsx），改布局无需同步这里。 */

/** 01 终端正文区（term-xterm 全文区） */
const T1_TERM = r(CTR.x, CTR.y + 34, CTR.w - 288, 420);
/** 01 标签栏里的 SFTP 标签（第二个标签） */
const T1_SFTP_TAB = r(CTR.x + 112, L.topbar, 112, L.tab);
/** 02 AI 输入框（#ai-input-box，min-height 70，贴面板底部） */
const T2_INPUT = r(AI_X + 8, NATIVE.h - L.status - 8 - 70, L.ai - 16, 70);
/** 03 笔记工具栏「发布工单日志」按钮 */
const T3_NOTE_BTN = r(CTR.x + 244, L.topbar + L.tab + 6, 112, 24);
/** 03 工单弹窗「发布工单日志」（modal 620×660 居中） */
const T3_PUBLISH = r(887, 718, 125, 30);
/** 04 Skill 卡片「上传到 Skill Hub」图标按钮（卡片操作行首按钮） */
const T4_UPLOAD = r(148, 266, 24, 24);
/** 05 反馈弹窗「提交」（modal 560×580 居中） */
const T5_SUBMIT = r(928, 658, 54, 30);

/** 各锚点的兜底中心点（视频坐标， = toStage 常量中心；仅供锚点未挂载前指针轨道兜底） */
const centerOf = (rc: Rect): { x: number; y: number } => {
  const st = toStage(rc.x, rc.y, rc.w, rc.h);
  return { x: st.x + st.w / 2, y: st.y + st.h / 2 };
};
export const ANCHOR_FALLBACK: Record<string, { x: number; y: number }> = {
  'term-body': centerOf(T1_TERM),
  'tab-sftp': centerOf(T1_SFTP_TAB),
  'ai-input': centerOf(T2_INPUT),
  'note-publish-btn': centerOf(T3_NOTE_BTN),
  'ticket-publish': centerOf(T3_PUBLISH),
  'skill-upload': centerOf(T4_UPLOAD),
  'feedback-submit': centerOf(T5_SUBMIT),
};

/* ---------------- 单渠道节拍 ---------------- */

export interface Beat {
  /** 目标锚点 id（元素上的 data-anchor；高亮环/指针/涟漪全部实测定位） */
  at: string;
  /** 点击帧（幕内局部） */
  f: number;
  /** 点击涟漪目标语义（Cursor 组件用） */
  kind: 'row' | 'confirm';
  /** 是否推近（false = 保持全景，仅指示/点击，避免与上一推镜的收镜冲突） */
  zoom: boolean;
}

/** 每渠道节拍（相邻点击须 ≥60 帧，保证相机轨道帧号严格递增） */
export const CH_BEATS: Beat[][] = [
  [
    { at: 'term-body', f: 96, kind: 'row', zoom: true },
    { at: 'tab-sftp', f: 156, kind: 'confirm', zoom: false },
  ],
  [{ at: 'ai-input', f: 100, kind: 'row', zoom: true }],
  [
    { at: 'note-publish-btn', f: 84, kind: 'row', zoom: true },
    { at: 'ticket-publish', f: 150, kind: 'confirm', zoom: true },
  ],
  [{ at: 'skill-upload', f: 100, kind: 'row', zoom: true }],
  [{ at: 'feedback-submit', f: 124, kind: 'confirm', zoom: true }],
];

/** 渠道幕节奏（局部帧，逐渠道） */
export const CH_TIMING = {
  /** 窗口淡入 */
  mockIn: 36,
  /** 弹窗出现（工单/反馈；-1 表示无弹窗） */
  modalAt: [-1, -1, 96, -1, 78],
  /** 结算卡出现 */
  popAt: [150, 150, 176, 150, 158],
  /** 窗口淡出 */
  outAt: [182, 182, 198, 182, 190],
} as const;

/** 窗口中心（视频坐标，镜头基准取景） */
export const WIN_C = { x: WIN.x + WIN.w / 2, y: WIN.y + WIN.h / 2 };

/** 结算卡（视频坐标，窗口正下方居中；卡宽约 520） */
export const POP = { x: 700, y: 836 };

/* ---------------- B 幕五渠道卡 / E 幕圆环（视频坐标） ---------------- */

export const B_CARD = { w: 300, h: 320, gap: 28, y: 380 };
export const B_CARD_X0 = (1920 - (B_CARD.w * 5 + B_CARD.gap * 4)) / 2;

export const RING = { cx: 960, cy: 430, r: 296 };

/* ---------------- 演示数据 ---------------- */

export const PROJ = '订单服务';
export const SRV = 'order-1';

/** 项目 / 服务器（终端与标签栏用） */
export const TABS = {
  term: { id: 'term', icon: 'terminal' as const, title: 'deploy@order-1' },
  sftp: { id: 'sftp', icon: 'folder' as const, title: 'SFTP · order-1' },
  note: { id: 'note', icon: 'pencil' as const, title: '● 发布问题复盘.md' },
};

/** 终端（01）：xterm 暗色主题 #0d1117 / #e6edf3，ANSI green #4ec98a */
export const TERM = {
  prompt: 'deploy@order-1:~$ ',
  cmd: './deploy.sh --env prod',
  lines: [
    { t: '› 拉取镜像 registry.srun.com/order-svc:1.8.3', c: '#e6edf3' },
    { t: '✓ 构建完成  用时 42.6s', c: '#4ec98a' },
    { t: '✓ 迁移数据库  3 个变更已应用', c: '#4ec98a' },
    { t: '✓ 滚动发布  order-1 / order-2 全部就绪', c: '#4ec98a' },
  ],
  infoCmd: './deploy.sh --env prod',
  lastHistory: 'git pull --ff-only',
};

/** SFTP（01）：真实 `.sf-table` 列 = 名称 / 大小 / 修改时间 */
export const SFTP = {
  path: '/opt/order-svc/releases',
  rows: [
    { n: '..', dir: true, size: '—', time: '2026-09-11 09:10' },
    { n: 'current', dir: true, size: '—', time: '2026-09-11 09:24' },
    { n: 'dist.tar.gz', dir: false, size: '86.2 MB', time: '2026-09-11 09:23', sel: true },
    { n: '1.8.2', dir: true, size: '—', time: '2026-09-05 18:40' },
    { n: 'deploy.sh', dir: false, size: '3.1 KB', time: '2026-08-30 11:02' },
    { n: 'rollback.sh', dir: false, size: '1.8 KB', time: '2026-08-30 11:02' },
  ],
  progress: { label: '上传 dist.tar.gz 82%', detail: '70.6 MB / 86.2 MB', pct: 82 },
};

/** AI 助手（02） */
export const AI = {
  session: '订单服务 · 运维排查',
  ask: '帮我看看 order-1 上磁盘占用最大的目录',
  actionName: '执行命令',
  actionStatus: '成功',
  intent: '查看根目录下各目录磁盘占用',
  cmd: 'du -sh /* | sort -h | tail -5',
  result: '/var/lib/docker   38.4G\n/data/order-svc   12.1G\n/var/log   6.7G',
  reply: '占用最大的是 /var/lib/docker（38.4G，镜像与日志缓存），其次是 /data/order-svc（12.1G）。建议清理 /var/log 下 30 天前的日志。',
  mode: '工作',
  effort: '高',
};

/** 笔记（03）：CodeMirror 暗色 oneDark（bg #282c34） */
export const NOTE = {
  path: '笔记 / 订单服务 / 发布问题复盘.md',
  lines: [
    '# 订单服务 · 发布问题复盘',
    '',
    '## 现象',
    'order-2 节点滚动发布时偶发 502，持续约 40s。',
    '',
    '## 定位',
    '健康检查探针超时阈值偏小，容器尚未就绪即被摘流。',
    '',
    '## 处理',
    'initialDelaySeconds 30 → 45，探针间隔 10s → 5s；',
    '已重新发布验证通过。',
  ],
};

/** 工单日志弹窗（03） */
export const TICKET = {
  noteName: '发布问题复盘.md',
  title: 'order-2 滚动发布 502 问题处理',
  ref: 'TICKET-1024',
  content: '## 现象\norder-2 节点滚动发布时偶发 502，持续约 40s。\n## 定位\n健康检查探针超时阈值偏小。\n## 处理\ninitialDelaySeconds 30 → 45，已重新发布验证通过。',
  counter: '96 / 10000 字',
  okNo: '128',
};

/** 上传 Skill（04） */
export const SKILL = {
  name: 'order-release-flow',
  desc: '订单服务标准发布流程：预检 → 滚动发布 → 健康校验 → 回滚预案',
  scopes: ['all', 'remote:order-1'],
  refLine: '@skill:order-release-flow',
  toast: 'Skill「order-release-flow」上传已登记，核实后计入激励积分',
};

/** 问题反馈（05） */
export const FEEDBACK = {
  category: '缺陷',
  title: 'SFTP 大文件上传偶发进度卡在 99%',
  content: '上传 2GB 以上文件时，进度条长时间停在 99%，实际已完成，刷新后正常。',
  okNo: '87',
  rows: [
    { id: 87, cat: '缺陷', status: '待处理', time: '2026-09-11 09:41', title: 'SFTP 大文件上传偶发进度卡在 99%', attach: 1 },
    { id: 85, cat: '建议', status: '处理中', time: '2026-09-09 15:20', title: '希望时间线支持按服务器筛选', attach: 0 },
    { id: 81, cat: '问题', status: '已解决', time: '2026-09-04 10:12', title: 'AI 助手引用远程文件路径不生效', attach: 2 },
    { id: 76, cat: '缺陷', status: '已关闭', time: '2026-08-28 17:03', title: '隧道自动启动在断网时反复重试', attach: 0 },
  ],
};

/* ---------------- 账号页 / 激励计划（D 幕）演示数据 ---------------- */

export const POINTS_TOTAL = 386;

export const RULES: Array<{ label: string; points: number }> = [
  { label: 'AI 工具调用', points: 1 },
  { label: '人工命令/SFTP', points: 5 },
  { label: '工单报告', points: 20 },
  { label: 'skill 上传', points: 20 },
  { label: 'skill 被引用', points: 1 },
  { label: '问题反馈', points: 10 },
];

export const MY_DIMS: Array<{ label: string; v: number }> = [
  { label: '工单报告', v: 120 },
  { label: '人工命令/SFTP', v: 85 },
  { label: '问题反馈', v: 60 },
  { label: 'skill 上传', v: 60 },
  { label: 'AI 工具调用', v: 42 },
  { label: 'skill 被引用', v: 19 },
];

export const MY_ITEMS: Array<{ t: string; dim: string; p: number; note: string }> = [
  { t: '2026-09-11 09:24', dim: '工单报告', p: 20, note: '工单 #128 审核通过' },
  { t: '2026-09-10 17:02', dim: '人工命令/SFTP', p: 5, note: '执行 deploy.sh --env prod' },
  { t: '2026-09-10 16:41', dim: 'AI 工具调用', p: 1, note: 'run_command（412 ms）' },
  { t: '2026-09-10 15:08', dim: 'skill 上传', p: 20, note: 'order-release-flow 核实通过' },
];

export const BOARD: Array<{ rank: number; name: string; dept: string; total: number; self?: boolean }> = [
  { rank: 1, name: '陈思远', dept: '平台研发部', total: 512 },
  { rank: 2, name: '林一鸣', dept: '云服务组', total: 386, self: true },
  { rank: 3, name: '李文博', dept: '平台研发部', total: 341 },
  { rank: 4, name: '王梦琪', dept: '测试中心', total: 298 },
  { rank: 5, name: '赵子墨', dept: '云服务组', total: 265 },
  { rank: 6, name: '孙悦', dept: '运维组', total: 240 },
];
