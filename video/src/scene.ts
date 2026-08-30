/**
 * 场景几何常量:窗口设计稿坐标系 1920×1200。
 * AppWindow / FolderDialog 的 CSS 与 InitSetup 的运镜、指针锚点共用同一份数值,
 * 改布局时只改这里,指针落点自动跟随,保证「指针永远精确落在按钮上」。
 */

export const WIN_W = 1920;
export const WIN_H = 1200;
export const TOPBAR_H = 40;

/* 顶栏右侧按钮簇(自绘标题栏:项目/设置/账号 + 主题 + 窗口控制);
   ACCOUNT_BTN 为按顶栏 flex 布局实测的位置,顶栏右簇宽度变化时需同步 */
export const ACCOUNT_BTN = { x: 1710, y: 6, w: 54, h: 28 };

/* 设置面板(左侧导航 200px,主区 padding 24/28,面板宽 860) */
export const PANEL = { x: 228, y: 104, w: 860 };
export const BROWSE_BTN = { x: 1022, y: 170, w: 66, h: 34 };
export const SAVE_BTN = { x: 1032, y: 953, w: 56, h: 32 };
/** 警告条收起后内容上移 40px,保存按钮随之到 929 */
export const BANNER_H = 40;
/* 工作台(场景二):右侧 AI 面板 340px(对照 --ai-panel-w),底栏 26px */
export const AI_PANEL = { x: 1580, w: 340 };
/** AI 输入盒中心(输入区:上边框 1026 起,输入盒 y 1096–1166) */
export const AI_INPUT = { x: 1750, y: 1131 };

/* 文件夹选择对话框(640×430,窗口内居中偏上) */
export const DIALOG = { x: 640, y: 395, w: 640, h: 430 };
/** 对话框内局部坐标(DLG_ROW1 只需垂直位置:行水平横跨列表,点击取行中央) */
export const DLG_ROW1 = { y: 116, h: 36 };
export const DLG_CONFIRM = { x: 520, y: 386, w: 104, h: 32 };

/** 全局锚点(设计稿坐标,指针/运镜共用) */
export const ANCHOR = {
  browse: { x: BROWSE_BTN.x + BROWSE_BTN.w / 2, y: BROWSE_BTN.y + BROWSE_BTN.h / 2 },
  folderRow: { x: DIALOG.x + DIALOG.w / 2, y: DIALOG.y + DLG_ROW1.y + DLG_ROW1.h / 2 },
  confirm: { x: DIALOG.x + DLG_CONFIRM.x + DLG_CONFIRM.w / 2, y: DIALOG.y + DLG_CONFIRM.y + DLG_CONFIRM.h / 2 },
  save: { x: SAVE_BTN.x + SAVE_BTN.w / 2, y: SAVE_BTN.y + SAVE_BTN.h / 2 },
  /** 警告条收起后的保存按钮位置 */
  saveLifted: { x: SAVE_BTN.x + SAVE_BTN.w / 2, y: SAVE_BTN.y + SAVE_BTN.h / 2 - BANNER_H },
  account: { x: ACCOUNT_BTN.x + ACCOUNT_BTN.w / 2, y: ACCOUNT_BTN.y + ACCOUNT_BTN.h / 2 },
  cursorStart: { x: 1450, y: 760 },
};
