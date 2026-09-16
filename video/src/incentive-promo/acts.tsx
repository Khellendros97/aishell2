/**
 * 激励计划宣传片 —— 视频坐标图形幕（片头 A / 渠道总览 B / 结尾 E）。
 * 这三幕不走舞台摄像机，直接在 1920×1080 视频坐标系绘制，用弹簧/渐变大字做「动感」。
 */
import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FONT_UI } from '../theme';
import { Icon, Logo } from '../ui';
import { BRAND, CHANNELS, INK } from './brand';
import { GradText, GrowLine, KineticTitle } from './kinetic';
import { B_CARD, B_CARD_X0, RING } from './layout';

/* ---------------- A 片头（0–240） ---------------- */

export const IntroAct: React.FC<{ from: number; to: number }> = ({ from, to }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || frame > to) return null;
  const logoP = spring({ frame: Math.max(0, frame - (from + 24)), fps, config: { damping: 11, mass: 0.9, stiffness: 120 } });
  const subT = interpolate(frame, [from + 140, from + 168], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const out = interpolate(frame, [to - 18, to], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ alignItems: 'center', opacity: out, fontFamily: FONT_UI }}>
      {/* Logo（弹簧冲入 + 光晕） */}
      <div
        style={{
          position: 'absolute', left: 960, top: 330, transform: 'translate(-50%,-50%)',
          opacity: Math.min(1, logoP * 1.8), scale: `${0.4 + 0.6 * logoP}`,
          filter: `drop-shadow(0 0 ${40 * logoP}px ${BRAND.glow})`,
        }}
      >
        <Logo size={172} />
      </div>
      {/* 主标题 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 452 }}>
        <KineticTitle text="AIShell 激励计划" from={from + 72} size={88} grad={BRAND.gradX} stagger={2.6} />
      </div>
      <GrowLine from={from + 128} x={960} y={568} width={620} />
      {/* 副标题 */}
      <div
        style={{
          position: 'absolute', left: 0, right: 0, top: 604, textAlign: 'center',
          fontSize: 27, fontWeight: 600, color: INK.text1, letterSpacing: 3,
          opacity: subT, transform: `translateY(${(1 - subT) * 14}px)`,
        }}
      >
        把每一次操作，变成看得见的成长
      </div>
      {/* 顶部小字 */}
      <div
        style={{
          position: 'absolute', left: 0, right: 0, top: 196, textAlign: 'center',
          fontSize: 16, fontWeight: 700, color: '#b9a6ff', letterSpacing: 6,
          opacity: interpolate(frame, [from + 40, from + 70], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }),
        }}
      >
        员 工 激 励 计 划
      </div>
    </AbsoluteFill>
  );
};

/* ---------------- B 渠道总览（240–390） ---------------- */

export const ChannelGridAct: React.FC<{ from: number; to: number }> = ({ from, to }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from || frame > to) return null;
  const out = interpolate(frame, [to - 14, to], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const headT = interpolate(frame, [from + 4, from + 24], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ opacity: out, fontFamily: FONT_UI }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 296, textAlign: 'center', fontSize: 40, fontWeight: 900, letterSpacing: 6, color: INK.text0, opacity: headT, transform: `translateY(${(1 - headT) * 16}px)` }}>
        五 大 得 分 渠 道
      </div>
      {CHANNELS.map((c, i) => {
        const p = spring({ frame: Math.max(0, frame - (from + 10 + i * 16)), fps, config: { damping: 13, mass: 0.7, stiffness: 120 } });
        const x = B_CARD_X0 + i * (B_CARD.w + B_CARD.gap);
        return (
          <div
            key={c.no}
            style={{
              position: 'absolute', left: x, top: B_CARD.y, width: B_CARD.w, height: B_CARD.h,
              borderRadius: 20, background: 'linear-gradient(180deg, rgba(26,30,52,0.92) 0%, rgba(14,16,30,0.92) 100%)',
              border: `1px solid ${INK.line2}`, boxShadow: `0 24px 70px rgba(0,0,0,0.5), 0 0 60px ${BRAND.glowSoft}`,
              padding: 26, opacity: Math.min(1, p * 1.7), transform: `translateY(${(1 - p) * 40}px) scale(${0.94 + 0.06 * p})`,
            }}
          >
            <GradText grad={BRAND.grad} style={{ fontSize: 62, fontWeight: 900, letterSpacing: -3, lineHeight: 1 }}>
              {c.no}
            </GradText>
            <div style={{ marginTop: 18, width: 52, height: 52, borderRadius: 14, background: BRAND.gradDim, border: `1px solid ${INK.line2}`, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#cbb8ff' }}>
              <Icon name={c.icon} size={26} />
            </div>
            <div style={{ marginTop: 18, fontSize: 24, fontWeight: 800, color: INK.text0, letterSpacing: 1 }}>{c.title}</div>
            <div style={{ marginTop: 10, fontSize: 13.5, lineHeight: 1.7, color: INK.text1 }}>{c.sub}</div>
            <div style={{ position: 'absolute', left: 26, bottom: 24, display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <GradText grad={BRAND.grad} style={{ fontSize: 40, fontWeight: 900, letterSpacing: -1 }}>+{c.points}</GradText>
              <span style={{ fontSize: 14, fontWeight: 700, color: INK.text1 }}>分/{c.unit}</span>
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
};

/* ---------------- E 结尾（1890–2250） ---------------- */

export const OutroAct: React.FC<{ from: number; to: number; duration: number }> = ({ from, to }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < from) return null;
  const ringT = interpolate(frame, [from + 20, from + 60], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const logoP = spring({ frame: Math.max(0, frame - (from + 40)), fps, config: { damping: 13, mass: 0.9, stiffness: 110 } });
  return (
    <AbsoluteFill style={{ fontFamily: FONT_UI, opacity: interpolate(frame, [to - 40, to - 16], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
      {/* 圆环 */}
      <div
        style={{
          position: 'absolute', left: RING.cx - RING.r, top: RING.cy - RING.r, width: RING.r * 2, height: RING.r * 2,
          borderRadius: '50%', border: `1.5px solid ${INK.line2}`, opacity: ringT,
          boxShadow: `inset 0 0 90px ${BRAND.glowSoft}, 0 0 90px ${BRAND.glowSoft}`,
        }}
      />
      {/* 中心 Logo */}
      <div style={{ position: 'absolute', left: RING.cx, top: RING.cy, transform: `translate(-50%,-50%) scale(${0.5 + 0.5 * logoP})`, opacity: Math.min(1, logoP * 1.8), filter: `drop-shadow(0 0 34px ${BRAND.glow})` }}>
        <Logo size={132} />
      </div>
      {/* 五渠道图标环绕 */}
      {CHANNELS.map((c, i) => {
        const ang = (-90 + i * 72) * (Math.PI / 180);
        const x = RING.cx + Math.cos(ang) * RING.r;
        const y = RING.cy + Math.sin(ang) * RING.r;
        const p = spring({ frame: Math.max(0, frame - (from + 34 + i * 14)), fps, config: { damping: 12, mass: 0.6, stiffness: 140 } });
        return (
          <div key={c.no} style={{ position: 'absolute', left: x, top: y, transform: `translate(-50%,-50%) scale(${0.5 + 0.5 * p})`, opacity: p }}>
            <div style={{ width: 84, height: 84, borderRadius: 24, background: 'linear-gradient(180deg, rgba(28,32,56,0.96) 0%, rgba(15,17,32,0.96) 100%)', border: `1px solid ${INK.line2}`, boxShadow: `0 16px 44px rgba(0,0,0,0.5), 0 0 40px ${BRAND.glowSoft}`, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
              <span style={{ color: '#cbb8ff' }}><Icon name={c.icon} size={30} /></span>
              <span style={{ fontSize: 12, fontWeight: 700, color: INK.text1 }}>{c.points} 分/{c.unit}</span>
            </div>
          </div>
        );
      })}
      {/* slogan */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 782 }}>
        <KineticTitle text="你的日常，就是你的积分" from={from + 130} size={64} grad={BRAND.gradX} stagger={2.4} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 892, textAlign: 'center', fontSize: 22, fontWeight: 600, color: INK.text1, letterSpacing: 4, opacity: interpolate(frame, [from + 200, from + 226], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
        AIShell 激励计划 · 全员参与
      </div>
    </AbsoluteFill>
  );
};
