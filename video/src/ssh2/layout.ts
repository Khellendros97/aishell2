/**
 * 视频二(项目配置 + SSH 终端)场景几何常量。
 * 与场景组件的 CSS 共用同一份数值,指针/运镜锚点由此推导,保证落点精确。
 * 坐标系:窗口设计稿 1920×1200。mono 字号 12.5 → 字符宽 7.19px。
 */

/* ================= 欢迎页 ================= */
/** 主内容区(右侧为 520 宽的 AI aside) */
export const WELCOME = { mainW: 1400, padX: 24, padTop: 20 };
/** 「＋ 新建项目」按钮(主区右上) */
export const NEW_PROJ_BTN = { x: 1266, y: 60, w: 110, h: 32 };

/* 项目卡片网格:3 列,gap 12;新卡片为第 3 张 */
export const PROJ_CARD3 = { x: 932, y: 110, w: 442, h: 108 };

/* 新建项目模态框:520 宽,顶部 208,高度随内容(mini 展开时向下增长) */
export const PROJ_MODAL = { x: 700, y: 208, w: 520 };
/** 模态框内锚点(按 Welcome2 CSS 核算) */
export const PM = {
  /** 项目名称输入框(body 起点 x720;label 276–294) */
  nameInput: { x: 720, y: 300, w: 480, h: 32 },
  /** 「＋ 新建服务器连接」toggle */
  serverAdd: { x: 720, y: 527, w: 480, h: 42 },
  /* mini 表单(展开后):容器 x720 y491,内边距 14,双列(220+12+220) */
  miniName: { x: 734, y: 529, w: 220, h: 32 },
  miniHost: { x: 966, y: 529, w: 220, h: 32 },
  miniUser: { x: 734, y: 665, w: 220, h: 32 },
  miniSecret: { x: 966, y: 665, w: 220, h: 32 },
  miniSave: { x: 1132, y: 709, w: 54, h: 30 },
  /** mini 收起后服务器卡片(选中态) */
  serverCard: { x: 720, y: 487, w: 480, h: 66 },
  /** 模态框底部 保存(mini 收起后) */
  footSave: { x: 1144, y: 569, w: 56, h: 32 },
};

/* ================= 工作台 ================= */
export const ACT = {
  /* 活动栏图标中心(x=24,首图标 y 64,步进 38) */
  explorer: { x: 24, y: 64 },
  servers: { x: 24, y: 102 },
  commands: { x: 24, y: 216 },
};

/** 侧栏(活动栏 48 + 侧栏 260 → 侧栏 x 48..308) */
export const SIDEBAR = { x: 48, w: 260, headH: 34 };
/** 服务器卡片(本地终端卡之后;侧栏内容 padding 8) */
export const SERVER_CARD = { x: 56, y: 148, w: 244, h: 94 };
/** 卡片 actions 行三个 26×26 按钮:添加到对话 / SSH / SFTP(右对齐) */
export const SSH_BTN = { x: 230, y: 216, w: 26, h: 26 };

/* 中央区域:标签栏 + 信息栏 + 终端主体；历史命令抽屉固定在终端右侧 280px */
export const TERM = {
  x: 308,
  w: 1272,
  tabBarH: 36,
  infoY: 112,
  infoH: 34,
  scrollY: 110,
  padX: 12,
  padTop: 10,
  lineH: 21.25,
  bottom: 1174,
};
/** xterm 可视区；抽屉展开时宽度减去 280px */
export const TERM_VIEW = { x: 308, w: 992 };
/** 实际前端 .term-drawer：终端面板右侧固定抽屉 */
export const HISTORY_DRAWER = { x: 1300, y: 110, w: 280, headH: 34, bodyPad: 8, gap: 8 };
/** 历史卡片按命令与输出预览自上而下排列 */
export const HISTORY_CARD = {
  x: 1308,
  w: 264,
  y: [152, 251, 379, 520, 648],
  h: [91, 120, 133, 120, 120],
};
/** 第三张卡片「添加到chat」、第四张卡片「命令收藏」按钮中心 */
export const HISTORY_ACTIONS = {
  addchat: { x: 1470, y: 470 },
  pin: { x: 1366, y: 618 },
};

/* AI 面板(同视频一:输入区顶 1028;chip 行 1070;输入盒 1098) */
export const AI_PANEL2 = { x: 1580, w: 340 };
export const WORKAREA_CHIP = { x: 1588, y: 1070, w: 190, h: 22 };
export const AI_INPUT2 = { x: 1588, y: 1098, w: 324, h: 70 };
/** AI 命令卡「粘贴到终端」按钮(bubble 底对齐堆叠后的估算位) */
export const CARD_PASTE = { x: 1790, y: 934 };

/* 命令收藏模态框(y 320) */
export const FAV_MODAL = { x: 700, y: 320, w: 520 };
export const FAV_SAVE = { x: 1144, y: 678, w: 56, h: 32 };
/** 命令收藏面板卡片(搜索行之下;侧栏内容 padding 8) */
export const FAV_CARD = { x: 56, y: 112, w: 244, h: 96 };
export const FAV_COPY_BTN = { x: 66, y: 178, w: 86, h: 26 };

/** 演示数据 */
export const DEMO = {
  projectName: 'deephaven-bigdata',
  serverName: 'deephaven-dev-01',
  serverHost: '10.21.36.8',
  serverUser: 'devops',
  remotePrompt: '[devops@deephaven-dev-01 ~]$',
};
