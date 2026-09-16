/**
 * 虚拟指针:Windows 风格箭头 + 点击涟漪。
 * 坐标为最终画布坐标。点击涟漪优先取 click.anchor 锚点的实测中心(逐帧贴住真实元素,
 * 含锚点卸载后的 last-known 缓存),未接锚点的旧视频回退 click.x/y。
 */
import React from 'react';
import { useCurrentFrame } from 'remotion';
import { C } from '../theme';
import { useAnchorMaybe } from './anchors';

export type ClickTarget = 'browse' | 'row' | 'confirm' | 'save' | 'input';

export interface Click {
  f: number;
  x: number;
  y: number;
  target: ClickTarget;
  /** 锚点 id:命中即以其中心为涟漪位置,x/y 退化为兜底 */
  anchor?: string;
}

/** 涟漪持续帧数:不超过对话框关闭(确认点击 228 + 14 = 242 对话框卸载) */
const RIPPLE_FRAMES = 14;

const ClickRipple: React.FC<{ c: Click }> = ({ c }) => {
  const frame = useCurrentFrame();
  const a = useAnchorMaybe(c.anchor ?? '');
  const cx = a ? a.x + a.w / 2 : c.x;
  const cy = a ? a.y + a.h / 2 : c.y;
  const t = (frame - c.f) / RIPPLE_FRAMES;
  if (t < 0 || t > 1) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: cx,
        top: cy,
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
};

export const Cursor: React.FC<{ x: number; y: number; opacity: number; pressScale: number; clicks: readonly Click[] }> = ({
  x,
  y,
  opacity,
  pressScale,
  clicks,
}) => {
  return (
    <>
      {/* 点击涟漪 */}
      {clicks.map((c) => (
        <ClickRipple key={c.f} c={c} />
      ))}
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
