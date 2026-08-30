/**
 * 底部解说字幕:视频坐标系(不随摄像机缩放),药丸底板 + 淡入上移出场。
 */
import React from 'react';
import { Easing, interpolate, useCurrentFrame } from 'remotion';
import { FONT_UI } from '../theme';

export const Caption: React.FC<{ from: number; to: number; text: string }> = ({ from, to, text }) => {
  const frame = useCurrentFrame();
  if (frame < from - 8 || frame > to + 8) return null;
  const opacity = interpolate(frame, [from - 8, from, to, to + 8], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const rise = interpolate(frame, [from - 8, from + 2], [12, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 64,
        display: 'flex',
        justifyContent: 'center',
        opacity,
        transform: `translateY(${rise}px)`,
        pointerEvents: 'none',
      }}
    >
      <div
        style={{
          padding: '12px 28px',
          borderRadius: 12,
          background: 'rgba(12,14,18,0.78)',
          border: '1px solid rgba(255,255,255,0.09)',
          fontFamily: FONT_UI,
          fontSize: 27,
          fontWeight: 600,
          letterSpacing: 0.5,
          color: '#f2f4f8',
          whiteSpace: 'nowrap',
        }}
      >
        {text}
      </div>
    </div>
  );
};
