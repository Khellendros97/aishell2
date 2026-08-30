/**
 * 场景一:初始化配置(系统设置窗口)。
 * 时间线 0–570;540–570 淡出到黑场,由 Video.tsx 的场景二接续。
 * 运镜与指针共用 scene.ts 锚点,所有运动曲线在此一处编排。
 *
 * 段落:
 *   0–72    全景开场,警告条高亮          72–105 推镜 → Workspace 输入行
 *   95–140  指针入场 → 点「浏览…」        142–228 文件夹对话框(选中 → 确认)
 *   250–272 路径键入                     266–330 平移推镜 → 点「保存」
 *   334–398 警告条收起 + toast           398–432 拉镜回全景
 *   430–540 推向顶栏「账号」收尾         540–570 淡出
 */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { EASE, Stop, track1 } from './anim';
import { AppWindow, HoverTarget, WinState } from './components/AppWindow';
import { Click, ClickTarget, Cursor } from './components/Cursor';
import { Highlight } from './components/Highlight';
import { ACCOUNT_BTN, ANCHOR, BANNER_H, TOPBAR_H, BROWSE_BTN, PANEL, SAVE_BTN, WIN_H, WIN_W } from './scene';

/* ---------- 摄像机轨道(scale + 设计稿焦点) ---------- */
const CAM_S: readonly Stop[] = [
  { f: 0, v: 0.75 },
  { f: 72, v: 0.75 },
  { f: 105, v: 1.55 },
  { f: 142, v: 1.55 },
  { f: 172, v: 1.35 },
  { f: 228, v: 1.35 },
  { f: 256, v: 1.55 },
  { f: 266, v: 1.55 },
  { f: 300, v: 1.5 },
  { f: 334, v: 1.5 },
  { f: 368, v: 1.35 },
  { f: 398, v: 1.35 },
  { f: 432, v: 0.75 },
  { f: 442, v: 0.75 },
  { f: 482, v: 1.12 },
];
const CAM_X: readonly Stop[] = [
  { f: 0, v: 960 },
  { f: 72, v: 960 },
  { f: 105, v: 660 },
  { f: 142, v: 660 },
  { f: 172, v: 960 },
  { f: 228, v: 960 },
  { f: 256, v: 660 },
  { f: 266, v: 660 },
  { f: 300, v: 980 },
  { f: 334, v: 980 },
  { f: 368, v: 1210 },
  { f: 398, v: 1210 },
  { f: 432, v: 960 },
  { f: 442, v: 960 },
  { f: 482, v: 1500 },
];
const CAM_Y: readonly Stop[] = [
  { f: 0, v: 600 },
  { f: 72, v: 600 },
  { f: 105, v: 250 },
  { f: 142, v: 250 },
  { f: 172, v: 600 },
  { f: 228, v: 600 },
  { f: 256, v: 250 },
  { f: 266, v: 250 },
  { f: 300, v: 930 },
  { f: 334, v: 930 },
  { f: 368, v: 1000 },
  { f: 398, v: 1000 },
  { f: 432, v: 600 },
  { f: 442, v: 600 },
  { f: 482, v: 240 },
];

/* ---------- 指针轨道(设计稿坐标) ---------- */
const CUR_X: readonly Stop[] = [
  { f: 95, v: ANCHOR.cursorStart.x },
  { f: 128, v: ANCHOR.browse.x },
  { f: 160, v: ANCHOR.browse.x },
  { f: 186, v: ANCHOR.folderRow.x },
  { f: 198, v: ANCHOR.folderRow.x },
  { f: 222, v: ANCHOR.confirm.x },
  { f: 246, v: ANCHOR.confirm.x },
  { f: 320, v: ANCHOR.save.x },
  { f: 350, v: ANCHOR.save.x },
  { f: 380, v: ANCHOR.saveLifted.x },
  { f: 436, v: ANCHOR.saveLifted.x },
  { f: 470, v: ANCHOR.account.x },
];
const CUR_Y: readonly Stop[] = [
  { f: 95, v: ANCHOR.cursorStart.y },
  { f: 128, v: ANCHOR.browse.y },
  { f: 160, v: ANCHOR.browse.y },
  { f: 186, v: ANCHOR.folderRow.y },
  { f: 198, v: ANCHOR.folderRow.y },
  { f: 222, v: ANCHOR.confirm.y },
  { f: 246, v: ANCHOR.confirm.y },
  { f: 320, v: ANCHOR.save.y },
  { f: 350, v: ANCHOR.save.y },
  { f: 380, v: ANCHOR.saveLifted.y },
  { f: 436, v: ANCHOR.saveLifted.y },
  { f: 470, v: ANCHOR.account.y },
];

const CLICKS: readonly Click[] = [
  { f: 140, ...ANCHOR.browse, target: 'browse' },
  { f: 192, ...ANCHOR.folderRow, target: 'row' },
  { f: 228, ...ANCHOR.confirm, target: 'confirm' },
  { f: 330, ...ANCHOR.save, target: 'save' },
];

const FULL_PATH = 'D:\\AIShellDemo\\workspace';

/** 区间内返回 hover 目标 */
function hoverAt(frame: number): HoverTarget {
  if (frame >= 128 && frame < 140) return 'browse';
  if (frame >= 186 && frame < 192) return 'row';
  if (frame >= 222 && frame < 228) return 'confirm';
  if (frame >= 320 && frame < 330) return 'save';
  if (frame >= 470) return 'account';
  return null;
}

export const InitSetup: React.FC = () => {
  const frame = useCurrentFrame();

  const cam = { s: track1(CAM_S, frame), cx: track1(CAM_X, frame), cy: track1(CAM_Y, frame) };
  const cur = { x: track1(CUR_X, frame), y: track1(CUR_Y, frame) };

  /* 窗口状态推进 */
  const dialogT = interpolate(frame, [142, 158, 228, 242], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE,
  });
  const bannerT = interpolate(frame, [336, 348], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: EASE });
  const toastT = interpolate(frame, [336, 352, 470, 486], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: EASE,
  });
  const typedChars = Math.floor(interpolate(frame, [252, 272], [0, FULL_PATH.length], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));

  /* 按压态:点击帧起 6 帧 */
  const pressFor = (target: ClickTarget): boolean => CLICKS.some((c) => c.target === target && frame >= c.f && frame < c.f + 6);

  const winState: WinState = {
    workspace: FULL_PATH.slice(0, typedChars),
    showCaret: frame >= 250 && frame <= 276,
    bannerT,
    toastT,
    dialogT,
    dialogSelected: frame >= 192,
    hover: hoverAt(frame),
    press: pressFor('browse') ? 'browse' : pressFor('confirm') ? 'confirm' : pressFor('save') ? 'save' : null,
  };

  /* 指针:95 帧淡入;点击瞬间压扁 */
  const cursorOpacity = interpolate(frame, [95, 102], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const pressing = CLICKS.some((c) => frame >= c.f && frame < c.f + 6);
  const pressScale = pressing ? 0.84 : 1;

  /* 场景进出场:0–8 淡入,540–570 淡出到黑场(场景二 575 起淡入) */
  const fade = interpolate(frame, [0, 8, 540, 570], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{ background: 'radial-gradient(1200px 800px at 50% 38%, #232733 0%, #101218 72%)', opacity: fade }}>
      {/* 摄像机:设计稿 1920×1200 → 视频 1920×1080 */}
      <AbsoluteFill
        style={{
          width: WIN_W,
          height: WIN_H,
          flex: 'none',
          transform: `translate(${960 - cam.cx * cam.s}px, ${540 - cam.cy * cam.s}px) scale(${cam.s})`,
          transformOrigin: '0 0',
        }}
      >
        <AppWindow state={winState} />

        {/* 焦点高亮环(设计稿坐标) */}
        <Highlight x={6} y={TOPBAR_H + 5} w={WIN_W - 12} h={BANNER_H - 10} r={6} from={10} to={70} />
        <Highlight x={PANEL.x - 6} y={BROWSE_BTN.y - 6} w={PANEL.w + 12} h={46} r={8} from={80} to={140} />
        <Highlight x={SAVE_BTN.x - 8} y={SAVE_BTN.y - 8} w={SAVE_BTN.w + 16} h={SAVE_BTN.h + 16} r={8} from={302} to={330} />
        <Highlight x={ACCOUNT_BTN.x - 4} y={ACCOUNT_BTN.y - 4} w={ACCOUNT_BTN.w + 8} h={ACCOUNT_BTN.h + 8} r={6} from={474} to={534} />

        <Cursor x={cur.x} y={cur.y} opacity={cursorOpacity} pressScale={pressScale} clicks={CLICKS} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
