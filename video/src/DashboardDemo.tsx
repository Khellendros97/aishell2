/**
 * 第十段教学视频总装:仪表盘与备忘录(合成 DashboardDemo)。
 * 分层(自底向上):背景渐变 → 窗口舞台(相机缩放,内含 Wb10 三页面与 Note 叠加层)
 *   → 高亮环 + 指针(锚点实测叠加层,画布坐标,放相机容器外——实测值已含相机,逐帧贴住元素)
 *   → 字幕 → 收尾特性卡 → 暗角 → 总淡出。
 * 坐标一律运行时实测(components/anchors.tsx);轨道/字幕/高亮来自 dashboard10/script.ts。
 */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { track1 } from './anim';
import { AnchorRoot, useAnchorTrack } from './components/anchors';
import { Caption } from './components/Caption';
import { Cursor } from './components/Cursor';
import { Highlight } from './components/Highlight';
import { Note } from './components/Note';
import { C } from './theme';
import {
  CAM_S, CAM_X, CAM_Y, CAPTIONS, CLICKS, CURSOR_OPACITY, CUR_PATH, DURATION, HIGHLIGHTS, NOTES,
  PULL_AT, finaleWb, wbAt,
} from './dashboard10/script';
import { Wb10 } from './dashboard10/Wb10';

/** 收尾三张特性卡(视频坐标) */
const CARDS = [
  { from: 4140, title: '备忘录随手记', desc: '密码、IP、入口链接，表格 + 文本双区，失焦即存、一键复制' },
  { from: 4185, title: 'AI 一句话定制', desc: '监控表格、数据库图表，描述需求即可，AI 改脚本自动验证' },
  { from: 4230, title: '加密同步上云', desc: '三个文件端到端加密，换机登录即恢复' },
] as const;

const Body: React.FC = () => {
  const frame = useCurrentFrame();

  const cam = { s: track1(CAM_S, frame), cx: track1(CAM_X, frame), cy: track1(CAM_Y, frame) };
  const cur = useAnchorTrack(CUR_PATH, frame);
  const curOpacity = track1(CURSOR_OPACITY, frame);
  const pressing = CLICKS.some((c) => frame >= c.f && frame < c.f + 6);
  const state = wbAt(frame);

  const inFinale = frame >= PULL_AT;
  const fadeIn = interpolate(frame, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const masterFade = interpolate(frame, [DURATION - 60, DURATION - 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const dimT = interpolate(frame, [4120, 4160], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ background: '#0a0b0e', opacity: fadeIn }}>
      {!inFinale && (
        <AbsoluteFill style={{ background: 'radial-gradient(1200px 800px at 50% 38%, #232733 0%, #101218 72%)' }}>
          {/* 窗口舞台(相机缩放;设计稿 1920×1200) */}
          <AbsoluteFill
            style={{
              width: 1920,
              height: 1200,
              flex: 'none',
              transform: `translate(${960 - cam.cx * cam.s}px, ${540 - cam.cy * cam.s}px) scale(${cam.s})`,
              transformOrigin: '0 0',
            }}
          >
            <Wb10 state={state} frame={frame} />
            {/* 教学说明卡(窗口坐标,随相机缩放) */}
            {NOTES.map((n) => (
              <Note key={n.from} note={n} />
            ))}
          </AbsoluteFill>

          {/* 高亮环(锚点实测画布坐标,不随相机变换;zIndex 55 压过弹窗遮罩) */}
          <div style={{ position: 'absolute', inset: 0, zIndex: 55, pointerEvents: 'none' }}>
            {HIGHLIGHTS.map((h) => (
              <Highlight key={`${h.target}:${h.from}`} target={h.target} pad={h.pad} r={h.r} from={h.from} to={h.to} />
            ))}
          </div>
          {/* 指针(同源实测坐标) */}
          <div style={{ position: 'absolute', inset: 0, zIndex: 60, pointerEvents: 'none' }}>
            <Cursor x={cur.x} y={cur.y} opacity={curOpacity} pressScale={pressing ? 0.84 : 1} clicks={CLICKS} />
          </div>
        </AbsoluteFill>
      )}

      {/* 收尾:定稿仪表盘全景 + 压暗 + 特性卡 */}
      {inFinale && (
        <AbsoluteFill>
          <AbsoluteFill style={{ background: 'radial-gradient(1200px 800px at 50% 38%, #232733 0%, #101218 72%)' }}>
            <AbsoluteFill
              style={{
                width: 1920,
                height: 1200,
                flex: 'none',
                transform: `translate(${960 - cam.cx * cam.s}px, ${540 - cam.cy * cam.s}px) scale(${cam.s})`,
                transformOrigin: '0 0',
              }}
            >
              <Wb10 state={finaleWb()} frame={0} />
            </AbsoluteFill>
          </AbsoluteFill>
          <AbsoluteFill style={{ background: 'rgba(10,11,14,0.72)', opacity: dimT, pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', left: 0, width: 1920, top: 810, display: 'flex', justifyContent: 'center' }}>
            <div style={{ display: 'flex', gap: 40 }}>
              {CARDS.map((cc) => {
                const t = interpolate(frame, [cc.from - 8, cc.from, DURATION - 30, DURATION - 8], [0, 1, 1, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                const rise = interpolate(frame, [cc.from - 8, cc.from + 6], [16, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                return (
                  <div
                    key={cc.title}
                    style={{
                      width: 430, borderLeft: `3px solid ${C.accent}`, paddingLeft: 18,
                      opacity: t, transform: `translateY(${rise}px)`, pointerEvents: 'none',
                    }}
                  >
                    <div style={{ fontSize: 21, fontWeight: 700, color: C.text0, marginBottom: 8 }}>{cc.title}</div>
                    <div style={{ fontSize: 14, lineHeight: 1.6, color: C.text1 }}>{cc.desc}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </AbsoluteFill>
      )}

      {/* 暗角 + 字幕 + 总淡出 */}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.26) 100%)', pointerEvents: 'none' }} />
      {CAPTIONS.map((c) => (
        <Caption key={c.from} from={c.from} to={c.to} text={c.text} />
      ))}
      <AbsoluteFill style={{ background: '#000', opacity: masterFade, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};

export const DashboardDemo: React.FC = () => (
  <AnchorRoot>
    <Body />
  </AnchorRoot>
);
