/**
 * 焦点高亮环:呼吸脉冲的 accent 描边框,套住当前操作目标。
 * 坐标为设计稿坐标系,from/to 控制进出场(各 6 帧淡入淡出)。
 */
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { C } from '../theme';

export const Highlight: React.FC<{ x: number; y: number; w: number; h: number; r?: number; from: number; to: number }> = ({
  x,
  y,
  w,
  h,
  r = 8,
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
