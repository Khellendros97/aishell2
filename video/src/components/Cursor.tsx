/**
 * 虚拟指针:Windows 风格箭头 + 点击涟漪。
 * 坐标为设计稿坐标系(1920×1200),随摄像机缩放——缩放时指针与 UI 等比放大。
 */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { C } from '../theme';

export type ClickTarget = 'browse' | 'row' | 'confirm' | 'save' | 'input';

export interface Click {
  f: number;
  x: number;
  y: number;
  target: ClickTarget;
}

/** 涟漪持续帧数:不超过对话框关闭(确认点击 228 + 14 = 242 对话框卸载) */
const RIPPLE_FRAMES = 14;

export const Cursor: React.FC<{ x: number; y: number; opacity: number; pressScale: number; clicks: readonly Click[] }> = ({
  x,
  y,
  opacity,
  pressScale,
  clicks,
}) => {
  const frame = useCurrentFrame();
  return (
    <>
      {/* 点击涟漪 */}
      {clicks.map((c) => {
        const t = (frame - c.f) / RIPPLE_FRAMES;
        if (t < 0 || t > 1) return null;
        return (
          <div
            key={c.f}
            style={{
              position: 'absolute',
              left: c.x,
              top: c.y,
              width: 60,
              height: 60,
              marginLeft: -30,
              marginTop: -30,
              borderRadius: '50%',
              border: `3px solid ${C.accent}`,
              opacity: 0.85 * (1 - t),
              transform: `scale(${0.15 + 0.85 * t})`,
              pointerEvents: 'none',
            }}
          />
        );
      })}
      {/* 指针箭头(锚点为箭尖) */}
      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          opacity,
          transform: `scale(${pressScale})`,
          transformOrigin: '2px 2px',
          filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.5))',
          pointerEvents: 'none',
        }}
      >
        <svg width={19} height={28} viewBox="0 0 14 21">
          <path
            d="M1 1 L1 16.8 L4.6 12.9 L7.4 19.6 L9.9 18.5 L7.2 11.9 L12.6 11.5 Z"
            fill="#ffffff"
            stroke="#101216"
            strokeWidth={1.1}
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </>
  );
};
