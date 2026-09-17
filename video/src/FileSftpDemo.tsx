/**
 * 第三段教学视频总装:文件管理与 SFTP(合成 FileSftpDemo)。
 * 单场景工作台 + 悬浮系统资源管理器窗口;运镜/指针/点击/拖拽幽灵/字幕全部来自
 * sftp3/script.ts(导演脚本),场景状态经 wbAt 纯函数推导。
 */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { track1 } from './anim';
import { AnchorRoot, useAnchorTrack } from './components/anchors';
import { Caption } from './components/Caption';
import { Cursor } from './components/Cursor';
import { Highlight } from './components/Highlight';
import { C, FONT_UI } from './theme';
import { CAM_S, CAM_X, CAM_Y, CAPTIONS3, CLICKS, CUR_PATH, HIGHLIGHTS3, KBD3, NOTES3, DURATION, wbAt } from './sftp3/script';
import { Wb3 } from './sftp3/Wb3';
import { OsWindow } from './sftp3/OsWindow';

const Body: React.FC = () => {
  const frame = useCurrentFrame();

  const cam = { s: track1(CAM_S, frame), cx: track1(CAM_X, frame), cy: track1(CAM_Y, frame) };
  const cur = useAnchorTrack(CUR_PATH, frame);
  const state = wbAt(frame);

  const fadeIn = interpolate(frame, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const masterFade = interpolate(frame, [DURATION - 60, DURATION - 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const cursorOpacity = interpolate(frame, [50, 60], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const pressing = CLICKS.some((c) => frame >= c.f && frame < c.f + 6);

  /* OS 窗口进出场:80–110 上滑入场;840–870 淡出 */
  const osOpacity = interpolate(frame, [OS_IN0, OS_IN0 + 30, 840, 872], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const osOffsetY = interpolate(frame, [OS_IN0, OS_IN0 + 30], [36, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: undefined });
  const osDragRow = frame >= 148 && frame < 240 ? 0 : frame >= 726 && frame < 806 ? 1 : null;

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
          <Wb3 state={state} frame={frame} />
          <OsWindow opacity={osOpacity} offsetY={osOffsetY} dragRow={osDragRow} />

          {/* 教学说明卡 */}
          {NOTES3.map((n) => {
            const t = interpolate(frame, [n.from - 6, n.from, n.to, n.to + 6], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            if (t <= 0) return null;
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
                  border: '1px solid rgba(229,98,106,0.55)',
                  opacity: t,
                  pointerEvents: 'none',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <RejectDot />
                  <span style={{ fontSize: 14, fontWeight: 700, color: C.red }}>{n.title}</span>
                </div>
                <div style={{ fontSize: 12.5, lineHeight: 1.7, color: C.text1 }}>{n.body}</div>
              </div>
            );
          })}

          {/* 键盘提示 */}
          {KBD3.map((k) => {
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

      {/* 高亮环(锚点实测画布坐标,不随相机变换) */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 55, pointerEvents: 'none' }}>
        {HIGHLIGHTS3.map((h) => (
          <Highlight key={h.target + h.from} target={h.target} pad={h.pad} r={h.r} from={h.from} to={h.to} />
        ))}
      </div>
      {/* 指针与拖拽幽灵(同源实测坐标;右键菜单 zIndex 40 / 模态 50 之上) */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 60, pointerEvents: 'none' }}>
        {state.ghost && state.ghost.fade > 0 && (
          <div
            style={{
              position: 'absolute',
              left: cur.x + 12 + (state.ghost.reject ? Math.sin(frame / 2) * 3 : 0),
              top: cur.y + 18,
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              padding: '7px 12px',
              borderRadius: 8,
              background: 'rgba(28,32,40,0.96)',
              border: `1px solid ${state.ghost.reject ? C.red : C.borderStrong}`,
              boxShadow: '0 10px 26px rgba(0,0,0,0.5)',
              fontSize: 12.5,
              color: C.text0,
              opacity: state.ghost.fade,
              whiteSpace: 'nowrap',
            }}
          >
            {state.ghost.reject && <RejectDot />}
            {state.ghost.name}
          </div>
        )}
        <Cursor x={cur.x} y={cur.y} opacity={cursorOpacity} pressScale={pressing ? 0.84 : 1} clicks={CLICKS} />
      </div>

      {/* 暗角 + 字幕 + 总淡出 */}
      <AbsoluteFill style={{ background: 'radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.26) 100%)', pointerEvents: 'none' }} />
      {CAPTIONS3.map((c) => (
        <Caption key={c.from} from={c.from} to={c.to} text={c.text} />
      ))}
      <AbsoluteFill style={{ background: '#000', opacity: masterFade, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};

export const FileSftpDemo: React.FC = () => (
  <AnchorRoot>
    <Body />
  </AnchorRoot>
);

const OS_IN0 = 80;

const RejectDot: React.FC = () => (
  <svg viewBox="0 0 24 24" width={15} height={15} style={{ display: 'block', flex: 'none' }}>
    <circle cx="12" cy="12" r="9" fill="none" stroke={C.red} strokeWidth={2.2} />
    <path d="M5.8 5.8 18.2 18.2" stroke={C.red} strokeWidth={2.2} strokeLinecap="round" />
  </svg>
);
