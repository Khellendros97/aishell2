/**
 * 焦点高亮环:呼吸脉冲的 accent 描边框,套住当前操作目标。
 * 两种取坐标方式:
 * - target 模式(推荐):从 <AnchorRoot> 实测的锚点矩形取值,逐帧贴住真实 DOM 元素,
 *   pad 为外扩像素;坐标为最终画布坐标(相机变换已由测量归一化,可渲染在相机容器外)。
 * - x/y/w/h 模式:手写设计稿坐标(旧视频兼容与逃生舱,无需 AnchorRoot)。
 * from/to 控制进出场(各 6 帧淡入淡出)。
 */
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { C } from '../theme';
import { useAnchorStrict } from './anchors';

const Ring: React.FC<{ x: number; y: number; w: number; h: number; r: number; from: number; to: number }> = ({
  x,
  y,
  w,
  h,
  r,
  from,
  to,
}) => {
  const frame = useCurrentFrame();
  if (frame < from - 6 || frame > to + 6) return null;
  const edge = interpolate(frame, [from - 6, from, to, to + 6], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const pulse = 0.72 + 0.28 * Math.sin(frame / 5);
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: w,
        height: h,
        borderRadius: r,
        border: `2.5px solid ${C.accent}`,
        boxShadow: `0 0 0 5px ${C.accentDim}, 0 0 28px rgba(79,142,247,0.45)`,
        opacity: edge * pulse,
        pointerEvents: 'none',
      }}
    />
  );
};

/** target 模式:锚点实测(本帧首轮渲染测量未跑,先渲染空,等测量触发的重渲染) */
const AnchoredHighlight: React.FC<{ target: string; pad: number; r: number; from: number; to: number }> = ({
  target,
  pad,
  r,
  from,
  to,
}) => {
  const frame = useCurrentFrame();
  const active = frame >= from - 6 && frame <= to + 6;
  const a = useAnchorStrict(target, active);
  if (!active || !a) return null;
  return <Ring x={a.x - pad} y={a.y - pad} w={a.w + pad * 2} h={a.h + pad * 2} r={r} from={from} to={to} />;
};

export const Highlight: React.FC<{
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  target?: string;
  pad?: number;
  r?: number;
  from: number;
  to: number;
}> = ({ x, y, w, h, target, pad = 0, r = 8, from, to }) => {
  if (target) return <AnchoredHighlight target={target} pad={pad} r={r} from={from} to={to} />;
  if (x === undefined || y === undefined || w === undefined || h === undefined) {
    throw new Error('[anchors] Highlight 需要 target 或完整 x/y/w/h');
  }
  return <Ring x={x} y={y} w={w} h={h} r={r} from={from} to={to} />;
};
