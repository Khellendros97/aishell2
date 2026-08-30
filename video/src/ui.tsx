/**
 * 共享 UI 小组件:Icon(lucide 风格描边图标)。
 * 对照主仓 src/icons.ts 的 icon() 函数,渲染结构一致。
 */
import React from 'react';
import { C, ICONS, IconName } from './theme';

export const Icon: React.FC<{ name: IconName; size?: number; color?: string; strokeWidth?: number }> = ({
  name,
  size = 16,
  color = 'currentColor',
  strokeWidth = 2,
}) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke={color}
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    style={{ display: 'block', flex: 'none' }}
    dangerouslySetInnerHTML={{ __html: ICONS[name] }}
  />
);

/** AIShell logo(src/assets/logo.svg 等比内联) */
export const Logo: React.FC<{ size?: number }> = ({ size = 22 }) => (
  <svg viewBox="0 0 512 512" width={size} height={size} style={{ display: 'block', flex: 'none' }}>
    <defs>
      <linearGradient id="vd-head" x1="256" y1="126" x2="256" y2="414" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#FAFCFF" />
        <stop offset="1" stopColor="#DDE9FF" />
      </linearGradient>
      <linearGradient id="vd-screen" x1="256" y1="186" x2="256" y2="340" gradientUnits="userSpaceOnUse">
        <stop offset="0" stopColor="#182238" />
        <stop offset="1" stopColor="#0D1220" />
      </linearGradient>
    </defs>
    <path d="M256 126V88" stroke={C.accent} strokeWidth="24" strokeLinecap="round" />
    <circle cx="256" cy="68" r="24" fill={C.accent} />
    <circle cx="256" cy="68" r="10" fill="#FFFFFF" />
    <rect x="88" y="238" width="48" height="92" rx="24" fill={C.accent} />
    <rect x="376" y="238" width="48" height="92" rx="24" fill={C.accent} />
    <rect x="116" y="126" width="280" height="288" rx="74" fill="url(#vd-head)" stroke={C.accent} strokeWidth="12" />
    <rect x="154" y="186" width="204" height="154" rx="40" fill="url(#vd-screen)" />
    <path d="M188 230l42 34-42 34" fill="none" stroke={C.green} strokeWidth="28" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M258 300h72" fill="none" stroke={C.green} strokeWidth="28" strokeLinecap="round" />
  </svg>
);
