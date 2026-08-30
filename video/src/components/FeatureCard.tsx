/**
 * 特性卡片(场景二侧栏注记):视频坐标系,放在推镜后画面左侧的留白区。
 * 左 accent 竖条 + 序号 kicker + 标题 + 说明;8 帧淡入淡出并轻微上移。
 */
import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { C, FONT_UI } from '../theme';

export const FeatureCard: React.FC<{ from: number; to: number; kicker: string; title: string; desc: string }> = ({
  from,
  to,
  kicker,
  title,
  desc,
}) => {
  const frame = useCurrentFrame();
  if (frame < from - 8 || frame > to + 8) return null;
  const opacity = interpolate(frame, [from - 8, from, to, to + 8], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const rise = interpolate(frame, [from - 8, from + 4], [14, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: 72,
        top: '50%',
        transform: `translateY(calc(-50% + ${rise}px))`,
        opacity,
        borderLeft: `3px solid ${C.accent}`,
        paddingLeft: 20,
        fontFamily: FONT_UI,
        pointerEvents: 'none',
        maxWidth: 420,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: 2, color: C.accent, marginBottom: 10 }}>{kicker}</div>
      <div style={{ fontSize: 34, fontWeight: 700, color: C.text0, marginBottom: 12, letterSpacing: 1 }}>{title}</div>
      <div style={{ fontSize: 16, lineHeight: 1.7, color: C.text1 }}>{desc}</div>
    </div>
  );
};
