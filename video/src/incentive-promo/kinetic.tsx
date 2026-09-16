/**
 * 激励计划宣传片 —— 动效原语（纯 frame 驱动、确定性，无 Date.now / Math.random）。
 * 比教学视频更「动感」：弹簧入场、渐变大字、辉光球 + 斜向光束 + 粒子背景、分值迸发。
 */
import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT_UI, type IconName } from '../theme';
import { Icon } from '../ui';
import { BRAND, INK } from './brand';

/** 确定性伪随机（同 index 恒定，保证可重渲） */
export function rnd(i: number): number {
  const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/* ---------------- 文字 ---------------- */

/** 渐变裁剪文字 */
export const GradText: React.FC<{ children: React.ReactNode; grad?: string; style?: React.CSSProperties }> = ({
  children,
  grad = BRAND.gradX,
  style,
}) => (
  <span
    style={{
      backgroundImage: grad,
      WebkitBackgroundClip: 'text',
      backgroundClip: 'text',
      color: 'transparent',
      WebkitTextFillColor: 'transparent',
      ...style,
    }}
  >
    {children}
  </span>
);

/** 逐字弹簧冲入的大标题（CJK 按 Array.from 逐字，空格保留） */
export const KineticTitle: React.FC<{
  text: string;
  from: number;
  size: number;
  weight?: number;
  grad?: string;
  stagger?: number;
  rise?: number;
  style?: React.CSSProperties;
}> = ({ text, from, size, weight = 800, grad, stagger = 2.2, rise = 46, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'baseline',
        fontFamily: FONT_UI,
        fontSize: size,
        fontWeight: weight,
        letterSpacing: 2,
        lineHeight: 1.1,
        ...style,
      }}
    >
      {Array.from(text).map((ch, i) => {
        const d = from + i * stagger;
        const p = spring({ frame: Math.max(0, frame - d), fps, config: { damping: 13, mass: 0.62, stiffness: 130 } });
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: frame < d ? 0 : Math.min(1, p * 1.8),
              transform: `translateY(${(1 - p) * rise}px)`,
              whiteSpace: 'pre',
            }}
          >
            {grad ? <GradText grad={grad}>{ch}</GradText> : ch}
          </span>
        );
      })}
    </div>
  );
};

/** 横向展开的渐变光带（片头/落版用） */
export const GrowLine: React.FC<{ from: number; width: number; x: number; y: number; height?: number; grad?: string }> = ({
  from,
  width,
  x,
  y,
  height = 3,
  grad = BRAND.grad,
}) => {
  const frame = useCurrentFrame();
  const t = spring({ frame: Math.max(0, frame - from), fps: 30, config: { damping: 18, mass: 0.8, stiffness: 90 } });
  if (frame < from) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: width * Math.max(0, Math.min(1, t)),
        height,
        marginLeft: -(width * Math.max(0, Math.min(1, t))) / 2,
        borderRadius: height,
        background: grad,
        boxShadow: `0 0 24px ${BRAND.glow}`,
      }}
    />
  );
};

/* ---------------- 背景 ---------------- */

const ORBS = [
  { x: 430, y: 290, r: 620, c: 'rgba(99,102,241,0.52)', ph: 0 },
  { x: 1500, y: 780, r: 700, c: 'rgba(217,70,239,0.38)', ph: 2.1 },
  { x: 1200, y: 200, r: 540, c: 'rgba(139,92,246,0.46)', ph: 4.2 },
];

const Orbs: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      {ORBS.map((o, i) => {
        const dx = Math.sin(frame / 90 + o.ph) * 74;
        const dy = Math.cos(frame / 116 + o.ph) * 56;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: o.x + dx - o.r / 2,
              top: o.y + dy - o.r / 2,
              width: o.r,
              height: o.r,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${o.c} 0%, transparent 68%)`,
              filter: 'blur(36px)',
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

const Streaks: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ overflow: 'hidden', opacity: 0.75 }}>
      {Array.from({ length: 7 }).map((_, i) => {
        const speed = 3.4 + rnd(i * 2.9) * 3.6;
        const period = 440 + rnd(i * 4.4) * 460;
        const off = rnd(i * 6.6) * period;
        const t = (((frame * speed + off) % period) + period) % period / period;
        const len = 460 + rnd(i * 9.9) * 460;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: -700 + t * 3400,
              top: 60 + i * 152 + rnd(i * 8.1) * 70,
              width: len,
              height: 2,
              transform: 'rotate(-19deg)',
              transformOrigin: '0 0',
              background: 'linear-gradient(90deg, transparent, rgba(170,190,255,0.55), transparent)',
              opacity: 0.55 * Math.sin(Math.PI * t),
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

const Dust: React.FC<{ count?: number }> = ({ count = 44 }) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      {Array.from({ length: count }).map((_, i) => {
        const bx = rnd(i * 3.1) * 1920;
        const by = rnd(i * 7.7) * 1080;
        const sp = 0.22 + rnd(i * 5.3) * 0.6;
        const size = 1.4 + rnd(i * 11.3) * 2.6;
        const y = ((((by - frame * sp) % 1080) + 1080) % 1080);
        const tw = 0.28 + 0.62 * (0.5 + 0.5 * Math.sin(frame / 12 + i * 1.7));
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: bx,
              top: y,
              width: size,
              height: size,
              borderRadius: '50%',
              background: '#cbd5ff',
              opacity: tw * 0.7,
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};

/** 完整背景：深底 + 辉光球 + 光束 + 粒子 + 暗角 */
export const Backdrop: React.FC<{ dim?: number }> = ({ dim = 1 }) => (
  <AbsoluteFill style={{ opacity: dim }}>
    <AbsoluteFill style={{ background: `radial-gradient(1300px 900px at 50% 40%, ${INK.bg2} 0%, ${INK.bg0} 74%)` }} />
    <Orbs />
    <Streaks />
    <Dust />
    <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, transparent 52%, rgba(0,0,0,0.55) 100%)' }} />
  </AbsoluteFill>
);

/* ---------------- 分值 / 徽标 ---------------- */

/** 分值迸发卡：维度名 + 「+N 分/单位」渐变数字 */
export const PointsPop: React.FC<{
  from: number;
  to?: number;
  x: number;
  y: number;
  label: string;
  points: number;
  unit: string;
  sub?: string;
  icon?: IconName;
}> = ({ from, to, x, y, label, points, unit, sub, icon = 'coins' }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from - 10) return null;
  const p = spring({ frame: Math.max(0, frame - from), fps, config: { damping: 11, mass: 0.7, stiffness: 150 } });
  const pulse = 1 + 0.05 * Math.sin((frame - from) / 7);
  const out = to === undefined ? 1 : interpolate(frame, [to - 10, to], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        opacity: Math.min(1, p * 2.2) * out,
        transform: `translateY(${(1 - p) * 28}px) scale(${(0.9 + 0.1 * p) * pulse})`,
        transformOrigin: 'left center',
        fontFamily: FONT_UI,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 18,
          padding: '16px 28px 16px 20px',
          borderRadius: 18,
          background: 'rgba(13,15,26,0.88)',
          border: `1px solid ${INK.line2}`,
          boxShadow: `0 20px 64px ${BRAND.glowSoft}, inset 0 1px 0 rgba(255,255,255,0.06)`,
        }}
      >
        <div
          style={{
            width: 46,
            height: 46,
            borderRadius: 13,
            background: BRAND.gradDim,
            border: `1px solid ${INK.line2}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: '#cbb8ff',
          }}
        >
          <Icon name={icon} size={23} />
        </div>
        <div style={{ minWidth: 150 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: INK.text0, letterSpacing: 0.5 }}>{label}</div>
          {sub ? <div style={{ fontSize: 12.5, color: INK.text2, marginTop: 4 }}>{sub}</div> : null}
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 7, marginLeft: 10 }}>
          <GradText grad={BRAND.grad} style={{ fontSize: 56, fontWeight: 900, letterSpacing: -1.5, lineHeight: 1 }}>
            +{points}
          </GradText>
          <span style={{ fontSize: 16, fontWeight: 700, color: INK.text1 }}>分/{unit}</span>
        </div>
      </div>
    </div>
  );
};

/** 渠道章节标（演示期常驻左上） */
export const ChapterBadge: React.FC<{ no: string; title: string; points: number; unit: string; from: number; to: number }> = ({
  no,
  title,
  points,
  unit,
  from,
  to,
}) => {
  const frame = useCurrentFrame();
  const t = spring({ frame: Math.max(0, frame - from), fps: 30, config: { damping: 16, mass: 0.7, stiffness: 110 } });
  const out = interpolate(frame, [to - 12, to], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (frame < from - 6 || out <= 0) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: 76,
        top: 62,
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        opacity: Math.min(1, t * 2) * out,
        transform: `translateX(${(1 - t) * -24}px)`,
        fontFamily: FONT_UI,
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 13,
          background: BRAND.grad,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 21,
          fontWeight: 900,
          color: '#fff',
          boxShadow: `0 10px 30px ${BRAND.glowSoft}`,
        }}
      >
        {no}
      </div>
      <div>
        <div style={{ fontSize: 22, fontWeight: 800, color: INK.text0, letterSpacing: 1 }}>{title}</div>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: '#b9a6ff', marginTop: 3, letterSpacing: 0.5 }}>
          每{unit} +{points} 分
        </div>
      </div>
    </div>
  );
};

/** 渠道章节分隔（视频坐标，窗口入场前的大字过场）：大号编号 + 渠道名 + 分值 */
export const ChapterDivider: React.FC<{
  no: string;
  title: string;
  sub: string;
  points: number;
  unit: string;
  icon: IconName;
  from: number;
  to: number;
}> = ({ no, title, sub, points, unit, icon, from, to }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const tin = spring({ frame: Math.max(0, frame - from), fps, config: { damping: 14, mass: 0.7, stiffness: 120 } });
  const out = interpolate(frame, [to - 14, to], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  if (frame < from - 4 || out <= 0) return null;
  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        opacity: Math.min(1, tin * 1.7) * out,
        fontFamily: FONT_UI,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 40, transform: `scale(${0.9 + 0.1 * tin})` }}>
        <GradText grad={BRAND.grad} style={{ fontSize: 190, fontWeight: 900, letterSpacing: -8, lineHeight: 0.9 }}>
          {no}
        </GradText>
        <div style={{ width: 2, height: 150, background: INK.line2 }} />
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ display: 'flex', color: '#cbb8ff' }}>
              <Icon name={icon} size={38} />
            </span>
            <span style={{ fontSize: 62, fontWeight: 900, color: INK.text0, letterSpacing: 3 }}>{title}</span>
          </div>
          <div style={{ fontSize: 21, color: INK.text1, marginTop: 16, letterSpacing: 1 }}>{sub}</div>
          <div style={{ marginTop: 18, display: 'inline-flex', alignItems: 'baseline', gap: 8, padding: '8px 20px', borderRadius: 999, background: BRAND.gradDim, border: `1px solid ${INK.line2}` }}>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#cbb8ff' }}>每{unit}</span>
            <GradText grad={BRAND.grad} style={{ fontSize: 30, fontWeight: 900 }}>+{points}</GradText>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#cbb8ff' }}>分</span>
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};

/** 小胶囊标签（渐显） */
export const Chip: React.FC<{
  text: string;
  from: number;
  to: number;
  x: number;
  y: number;
  tone?: 'brand' | 'green';
  icon?: IconName;
}> = ({ text, from, to, x, y, tone = 'brand', icon }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [from - 6, from, to, to + 6], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  if (t <= 0) return null;
  const c = tone === 'green' ? INK.green : '#cbb8ff';
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 16px',
        borderRadius: 999,
        background: tone === 'green' ? 'rgba(78,201,138,0.14)' : BRAND.gradDim,
        border: `1px solid ${tone === 'green' ? 'rgba(78,201,138,0.45)' : INK.line2}`,
        color: c,
        fontSize: 15,
        fontWeight: 700,
        letterSpacing: 0.4,
        opacity: t,
        transform: `translateY(${(1 - t) * 10}px) scale(${0.94 + 0.06 * t})`,
        fontFamily: FONT_UI,
      }}
    >
      {icon ? <Icon name={icon} size={15} /> : null}
      {text}
    </div>
  );
};

/** 数字滚动（千分位，OutCubic） */
export const CountUp: React.FC<{ from: number; to: number; value: number; size: number; color?: string; grad?: string }> = ({
  from,
  to,
  value,
  size,
  color,
  grad,
}) => {
  const frame = useCurrentFrame();
  const n = Math.round(
    interpolate(frame, [from, to], [0, value], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.out(Easing.cubic),
    }),
  );
  const label = n.toLocaleString('en-US');
  return grad ? (
    <GradText grad={grad} style={{ fontSize: size, fontWeight: 900, letterSpacing: -1.5 }}>
      {label}
    </GradText>
  ) : (
    <span style={{ fontSize: size, fontWeight: 900, color, letterSpacing: -1.5 }}>{label}</span>
  );
};
