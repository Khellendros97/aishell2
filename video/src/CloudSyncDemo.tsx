/**
 * 第八段教学视频总装:云同步与云备份(合成 CloudSyncDemo)。
 * 单场景工作台+账号页双页面;运镜/指针/点击/字幕全部来自 cloud8/script.ts(导演脚本),
 * 场景状态经 wbAt 纯函数推导。教学说明卡(NOTES8)为窗口坐标叠加层。
 */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { track1 } from './anim';
import { AnchorRoot, useAnchorTrack } from './components/anchors';
import { Caption } from './components/Caption';
import { Cursor } from './components/Cursor';
import { Highlight } from './components/Highlight';
import { C, FONT_UI, IconName } from './theme';
import { Icon } from './ui';
import {
  CAM_S, CAM_X, CAM_Y, CAPTIONS8, CLICKS, CUR_PATH, DURATION, HIGHLIGHTS8, KBD8, NOTES8, wbAt,
} from './cloud8/script';
import { Wb8 } from './cloud8/Wb8';

const NOTE_ICON: Record<'info' | 'alert', IconName> = { info: 'info', alert: 'alert' };
const NOTE_COLOR = { info: { edge: 'rgba(79,142,247,0.55)', text: C.accent }, alert: { edge: 'rgba(229,98,106,0.55)', text: C.red } };

const Body: React.FC = () => {
  const frame = useCurrentFrame();

  const cam = { s: track1(CAM_S, frame), cx: track1(CAM_X, frame), cy: track1(CAM_Y, frame) };
  const cur = useAnchorTrack(CUR_PATH, frame);
  const state = wbAt(frame);

  const fadeIn = interpolate(frame, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const masterFade = interpolate(frame, [DURATION - 60, DURATION - 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const cursorOpacity = interpolate(frame, [50, 60], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const pressing = CLICKS.some((c) => frame >= c.f && frame < c.f + 6);

  return (
    <AbsoluteFill style={{ background: '#0a0b0e' }}>
      <AbsoluteFill style={{ background: 'radial-gradient(1200px 800px at 50% 38%, #232733 0%, #101218 72%)', opacity: fadeIn }}>
        <AbsoluteFill
          style={{
            width: 1920,
            height: 1200,
            flex: 'none',
            transform: `translate(${960 - cam.cx * cam.s}px, ${540 - cam.cy * cam.s}px) scale(${cam.s})`,
            transformOrigin: '0 0',
          }}
        >
          <Wb8 state={state} frame={frame} />

          {/* 教学说明卡 */}
          {NOTES8.map((n) => {
            const t = interpolate(frame, [n.from - 6, n.from, n.to, n.to + 6], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            if (t <= 0) return null;
            const cc = NOTE_COLOR[n.kind];
            return (
              <div
                key={n.from}
                style={{
                  position: 'absolute',
                  left: n.x,
                  top: n.y,
                  width: n.w,
                  padding: '14px 16px',
                  borderRadius: 10,
                  background: 'rgba(13,15,20,0.94)',
                  border: `1px solid ${cc.edge}`,
                  opacity: t,
                  pointerEvents: 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ display: 'flex', color: cc.text }}>
                    <Icon name={NOTE_ICON[n.kind]} size={15} />
                  </span>
                  <span style={{ fontSize: 14, fontWeight: 700, color: cc.text }}>{n.title}</span>
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.7, color: C.text1 }}>{n.body}</div>
              </div>
            );
          })}

          {/* 键盘提示(本片无) */}
          {KBD8.map((k) => {
            const t = interpolate(frame, [k.from - 6, k.from, k.to, k.to + 6], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            if (t <= 0) return null;
            return (
              <div
                key={k.from}
                style={{
                  position: 'absolute',
                  left: k.x,
                  top: k.y,
                  padding: '6px 14px',
                  borderRadius: 8,
                  background: 'rgba(13,15,20,0.92)',
                  border: '1px solid #4f8ef7',
                  color: '#6ba1f8',
                  fontSize: 13,
                  fontWeight: 600,
                  fontFamily: FONT_UI,
                  opacity: t,
                  pointerEvents: 'none',
                }}
              >
                {k.label}
              </div>
            );
          })}
        </AbsoluteFill>
      </AbsoluteFill>

      {/* 焦点高亮环 + 指针(锚点实测画布坐标,不随相机变换;zIndex 55 压过 Wb8 内菜单 45/模态 50) */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 55, pointerEvents: 'none' }}>
        {HIGHLIGHTS8.map((h) => (
          <Highlight key={`${h.target}:${h.from}`} target={h.target} pad={h.pad} r={h.r} from={h.from} to={h.to} />
        ))}
      </div>
      <div style={{ position: 'absolute', inset: 0, zIndex: 60, pointerEvents: 'none' }}>
        <Cursor x={cur.x} y={cur.y} opacity={cursorOpacity} pressScale={pressing ? 0.84 : 1} clicks={CLICKS} />
      </div>

      {/* 暗角 + 字幕 + 总淡出 */}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.26) 100%)', pointerEvents: 'none' }} />
      {CAPTIONS8.map((c) => (
        <Caption key={c.from} from={c.from} to={c.to} text={c.text} />
      ))}
      <AbsoluteFill style={{ background: '#000', opacity: masterFade, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );

};

export const CloudSyncDemo: React.FC = () => (
  <AnchorRoot>
    <Body />
  </AnchorRoot>
);
