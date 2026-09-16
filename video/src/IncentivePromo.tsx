/**
 * 激励计划宣传片总装（合成 IncentivePromo）。
 * 分层（自底向上）：背景动效 → 窗口舞台（视频坐标，内层 1440×900 真实 UI 等比缩放）
 *   → 高亮环 + 指针 + 涟漪（锚点实测叠加层，画布坐标，不随相机变换——实测值已含相机）
 *   → 分值结算 → 字幕 → 暗角 → 总淡出。
 * 轨道/字幕/高亮数据全部来自 incentive-promo/script.ts；
 * 坐标一律运行时实测（components/anchors.tsx），脚本只编排帧号与锚点 id。
 */
import React from 'react';
import { AbsoluteFill, Audio, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { track1 } from './anim';
import { AnchorRoot, useAnchorTrack } from './components/anchors';
import { Caption } from './components/Caption';
import { Cursor } from './components/Cursor';
import { Highlight } from './components/Highlight';
import { CHANNELS, INK } from './incentive-promo/brand';
import { Frame, NativeFrame, SCENES } from './incentive-promo/mocks';
import { IncentiveBoard } from './incentive-promo/IncentiveBoard';
import { ChapterBadge, ChapterDivider, PointsPop } from './incentive-promo/kinetic';
import { ChannelGridAct, IntroAct, OutroAct } from './incentive-promo/acts';
import { CH_TIMING, POP } from './incentive-promo/layout';
import {
  ACT, CAM_S, CAM_X, CAM_Y, CAPTIONS, CH_LEN, CLICKS, CURSOR_OPACITY, CUR_PATH, DURATION,
  HIGHLIGHTS, channelAt, popFor, stageAlpha,
} from './incentive-promo/script';

/* ---------------- 动感背景（辉光球 + 斜向光束 + 暗角） ---------------- */

const Backdrop: React.FC = () => {
  const frame = useCurrentFrame();
  const orb = [
    { x: 430, y: 290, r: 640, c: 'rgba(99,102,241,0.46)', ph: 0 },
    { x: 1500, y: 800, r: 720, c: 'rgba(217,70,239,0.34)', ph: 2.1 },
    { x: 1180, y: 190, r: 560, c: 'rgba(139,92,246,0.40)', ph: 4.2 },
  ];
  const rnd = (i: number): number => {
    const x = Math.sin(i * 127.1 + 311.7) * 43758.5453;
    return x - Math.floor(x);
  };
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: `radial-gradient(1300px 900px at 50% 42%, ${INK.bg2} 0%, ${INK.bg0} 74%)` }} />
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        {orb.map((o, i) => (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: o.x + Math.sin(frame / 90 + o.ph) * 76 - o.r / 2,
              top: o.y + Math.cos(frame / 116 + o.ph) * 58 - o.r / 2,
              width: o.r,
              height: o.r,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${o.c} 0%, transparent 68%)`,
              filter: 'blur(38px)',
            }}
          />
        ))}
      </AbsoluteFill>
      <AbsoluteFill style={{ overflow: 'hidden', opacity: 0.6 }}>
        {Array.from({ length: 7 }).map((_, i) => {
          const speed = 3.4 + rnd(i * 2.9) * 3.6;
          const period = 440 + rnd(i * 4.4) * 470;
          const off = rnd(i * 6.6) * period;
          const p = ((((frame * speed + off) % period) + period) % period) / period;
          const len = 470 + rnd(i * 9.9) * 460;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: -700 + p * 3400,
                top: 50 + i * 152 + rnd(i * 8.1) * 70,
                width: len,
                height: 2,
                transform: 'rotate(-19deg)',
                transformOrigin: '0 0',
                background: 'linear-gradient(90deg, transparent, rgba(170,190,255,0.5), transparent)',
                opacity: 0.5 * Math.sin(Math.PI * p),
              }}
            />
          );
        })}
      </AbsoluteFill>
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.58) 100%)' }} />
    </AbsoluteFill>
  );
};

/** 窗口舞台：整窗随相机缩放（保持真实 UI 比例） */
const Stage: React.FC<{ s: number; cx: number; cy: number; children: React.ReactNode }> = ({ s, cx, cy, children }) => (
  <AbsoluteFill
    style={{
      // 以窗口中心为镜头基准：translate 到画面中心后再缩放
      transform: `translate(${960 - cx * s}px, ${540 - cy * s}px) scale(${s})`,
      transformOrigin: '0 0',
      width: 1920,
      height: 1080,
      flex: 'none',
    }}
  >
    {children}
  </AbsoluteFill>
);

const PromoBody: React.FC = () => {
  const frame = useCurrentFrame();

  const cam = { s: track1(CAM_S, frame), cx: track1(CAM_X, frame), cy: track1(CAM_Y, frame) };
  const cur = useAnchorTrack(CUR_PATH, frame);
  const pressing = CLICKS.some((c) => frame >= c.f && frame < c.f + 6);
  const cursorOpacity = track1(CURSOR_OPACITY, frame);
  const ch = channelAt(frame);

  const fadeIn = interpolate(frame, [0, 10], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const masterFade = interpolate(frame, [DURATION - 44, DURATION - 14], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const sAlpha = stageAlpha(frame);

  const outAt = ch ? CH_TIMING.outAt[ch.i] : 0;
  const popAt = ch ? CH_TIMING.popAt[ch.i] : 0;

  return (
    <AbsoluteFill style={{ background: INK.bg0, opacity: fadeIn }}>
      <Backdrop />

      {/* 窗口舞台（视频坐标 + 相机缩放） */}
      {sAlpha > 0 && (
        <AbsoluteFill style={{ opacity: sAlpha }}>
          <Stage s={cam.s} cx={cam.cx} cy={cam.cy}>
            {ch ? (
              <Frame t={ch.t} inAt={CH_TIMING.mockIn} outAt={outAt}>
                {React.createElement(SCENES[ch.i], { t: ch.t })}
              </Frame>
            ) : frame >= ACT.D0 && frame < ACT.E0 + 30 ? (
              <NativeFrame>
                <IncentiveBoard t={frame - ACT.D0} />
              </NativeFrame>
            ) : null}
          </Stage>

          {/* 高亮环（锚点实测画布坐标，不随相机缩放——实测值已含相机，逐帧贴住元素） */}
          <div style={{ position: 'absolute', inset: 0, zIndex: 55, pointerEvents: 'none' }}>
            {HIGHLIGHTS.map((h) => (
              <Highlight key={`${h.target}:${h.from}`} {...h} />
            ))}
          </div>

          {/* 指针（同源实测坐标，相机推近期间仍贴住目标） */}
          <div style={{ position: 'absolute', inset: 0, zIndex: 60, pointerEvents: 'none' }}>
            <Cursor x={cur.x} y={cur.y} opacity={cursorOpacity} pressScale={pressing ? 0.84 : 1} clicks={CLICKS} />
          </div>

          {/* 分值结算卡（视频坐标，窗口下方居中） */}
          {ch
            ? (() => {
                const info = popFor(ch.i);
                if (!info) return null;
                const S = [ACT.C1, ACT.C2, ACT.C3, ACT.C4, ACT.C5][ch.i];
                return (
                  <div style={{ position: 'absolute', inset: 0, zIndex: 40, pointerEvents: 'none' }}>
                    <PointsPop
                      from={S + popAt}
                      to={S + outAt + 8}
                      x={POP.x}
                      y={POP.y}
                      label={info.label}
                      points={info.points}
                      unit={info.unit}
                      sub={info.sub}
                      icon={CHANNELS[ch.i].icon}
                    />
                  </div>
                );
              })()
            : null}
        </AbsoluteFill>
      )}

      {/* 视频坐标图形幕 */}
      <IntroAct from={ACT.A0} to={ACT.B0} />
      <ChannelGridAct from={ACT.B0} to={ACT.C1} />
      <OutroAct from={ACT.E0} to={DURATION} duration={DURATION} />

      {/* 渠道章节分隔卡 + 演示期章节标 */}
      {CHANNELS.map((c, i) => {
        const S = [ACT.C1, ACT.C2, ACT.C3, ACT.C4, ACT.C5][i];
        const prevOut = i === 0 ? ACT.C1 : S - CH_LEN + CH_TIMING.outAt[i - 1] + 16;
        return (
          <React.Fragment key={c.no}>
            <ChapterDivider no={c.no} title={c.title} sub={c.sub} points={c.points} unit={c.unit} icon={c.icon} from={prevOut} to={S + 34} />
            <ChapterBadge no={c.no} title={c.title} points={c.points} unit={c.unit} from={S + 44} to={S + CH_TIMING.outAt[i] - 2} />
          </React.Fragment>
        );
      })}

      {/* 字幕 */}
      {CAPTIONS.map((cp) => (
        <Caption key={cp.from} from={cp.from} to={cp.to} text={cp.text} />
      ))}

      {/* 落版淡出 + 占位音轨（静音，覆盖同名文件即可换正式配乐） */}
      <AbsoluteFill style={{ background: '#000', opacity: masterFade, pointerEvents: 'none' }} />
      <Audio src={staticFile('audio/bgm-placeholder.mp3')} volume={0.001} />
    </AbsoluteFill>
  );
};

export const IncentivePromo: React.FC = () => (
  <AnchorRoot>
    <PromoBody />
  </AnchorRoot>
);
