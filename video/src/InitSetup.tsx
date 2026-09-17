/**
 * 场景一:初始化配置(系统设置窗口)。
 * 时间线 0–570;540–570 淡出到黑场,由 Video.tsx 的场景二接续。
 * 运镜仍走 scene.ts 常量;指针/高亮/涟漪改锚点实测(components/anchors.tsx),目标元素打 data-anchor。
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
import { AnchorStop, useAnchorTrack } from './components/anchors';
import { AppWindow, HoverTarget, WinState } from './components/AppWindow';
import { Click, ClickTarget, Cursor } from './components/Cursor';
import { Highlight } from './components/Highlight';
import { ANCHOR, WIN_H, WIN_W } from './scene';

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

/* ---------- 指针轨道(锚点实测优先;x/y 为冷启动首帧兜底,按该段相机换算) ---------- */
/** 设计稿窗口坐标 → canvas 兜底坐标(按某帧相机;仅冷启动首帧兜底,实测就绪后即被替换) */
const wf = (wx: number, wy: number, s: number, cx: number, cy: number): { x: number; y: number } => ({
  x: wx * s + (960 - cx * s),
  y: wy * s + (540 - cy * s),
});

const CUR_PATH: readonly AnchorStop[] = [
  /* 入场起点(推镜途中,取 f95 附近相机近似换算) */
  { f: 95, ...wf(1450, 760, 1.15, 810, 425) },
  /* Workspace 行特写相机 (1.55,660,250) */
  { f: 128, at: 'init-browse', ...wf(ANCHOR.browse.x, ANCHOR.browse.y, 1.55, 660, 250) },
  { f: 160, at: 'init-browse', ...wf(ANCHOR.browse.x, ANCHOR.browse.y, 1.55, 660, 250) },
  /* 对话框期间相机 (1.35,960,600) */
  { f: 186, at: 'init-folder-row', ...wf(ANCHOR.folderRow.x, ANCHOR.folderRow.y, 1.35, 960, 600) },
  { f: 198, at: 'init-folder-row', ...wf(ANCHOR.folderRow.x, ANCHOR.folderRow.y, 1.35, 960, 600) },
  { f: 222, at: 'init-folder-confirm', ...wf(ANCHOR.confirm.x, ANCHOR.confirm.y, 1.35, 960, 600) },
  { f: 246, at: 'init-folder-confirm', ...wf(ANCHOR.confirm.x, ANCHOR.confirm.y, 1.35, 960, 600) },
  /* 保存段相机 (1.5,980,930);380 起警告条收起按钮上移 40,改用收起后位置 + (1.35,1210,1000) 相机 */
  { f: 320, at: 'init-save', ...wf(ANCHOR.save.x, ANCHOR.save.y, 1.5, 980, 930) },
  { f: 350, at: 'init-save', ...wf(ANCHOR.save.x, ANCHOR.save.y, 1.5, 980, 930) },
  { f: 380, at: 'init-save', ...wf(ANCHOR.saveLifted.x, ANCHOR.saveLifted.y, 1.35, 1210, 1000) },
  { f: 436, at: 'init-save', ...wf(ANCHOR.saveLifted.x, ANCHOR.saveLifted.y, 1.35, 1210, 1000) },
  /* 收尾推向顶栏「账号」相机 (1.12,1500,240) */
  { f: 470, at: 'init-account', ...wf(ANCHOR.account.x, ANCHOR.account.y, 1.12, 1500, 240) },
];

const CLICKS: readonly Click[] = [
  { f: 140, ...wf(ANCHOR.browse.x, ANCHOR.browse.y, 1.55, 660, 250), anchor: 'init-browse', target: 'browse' },
  { f: 192, ...wf(ANCHOR.folderRow.x, ANCHOR.folderRow.y, 1.35, 960, 600), anchor: 'init-folder-row', target: 'row' },
  { f: 228, ...wf(ANCHOR.confirm.x, ANCHOR.confirm.y, 1.35, 960, 600), anchor: 'init-folder-confirm', target: 'confirm' },
  { f: 330, ...wf(ANCHOR.save.x, ANCHOR.save.y, 1.5, 980, 930), anchor: 'init-save', target: 'save' },
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
  const cur = useAnchorTrack(CUR_PATH, frame);

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
      </AbsoluteFill>

      {/* 焦点高亮环 + 指针(锚点实测画布坐标,不随相机变换,放相机容器外) */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 55, pointerEvents: 'none' }}>
        <Highlight target="init-banner" pad={5} r={6} from={10} to={70} />
        <Highlight target="init-ws-row" pad={6} r={8} from={80} to={140} />
        <Highlight target="init-save" pad={8} r={8} from={302} to={330} />
        <Highlight target="init-account" pad={4} r={6} from={474} to={534} />
      </div>
      <div style={{ position: 'absolute', inset: 0, zIndex: 60, pointerEvents: 'none' }}>
        <Cursor x={cur.x} y={cur.y} opacity={cursorOpacity} pressScale={pressScale} clicks={CLICKS} />
      </div>
    </AbsoluteFill>
  );
};
