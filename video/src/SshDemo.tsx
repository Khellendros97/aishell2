/**
 * 第二段教学视频总装:项目配置与 SSH 终端使用(合成 ProjectSshDemo)。
 * 场景 A(0–466)欢迎页新建项目/服务器/自动凭据;场景 B–F(468–1800)工作台。
 * 运镜/指针/点击/字幕全部来自 ssh2/script.ts(导演脚本)。
 */
import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { track1 } from './anim';
import { Caption } from './components/Caption';
import { Cursor } from './components/Cursor';
import { Highlight } from './components/Highlight';
import { WIN_H, WIN_W } from './scene';
import { NEW_PROJ_BTN, PM, WORKAREA_CHIP } from './ssh2/layout';
import { CAM_S, CAM_X, CAM_Y, CAPTIONS2, CLICKS, CUR_X, CUR_Y, MID_NOTES, SCENE_A_END, wbAt, welcomeAt } from './ssh2/script';
import { Wb2 } from './ssh2/Wb2';
import { Welcome2 } from './ssh2/Welcome2';

export const SshDemo: React.FC = () => {
  const frame = useCurrentFrame();

  const cam = { s: track1(CAM_S, frame), cx: track1(CAM_X, frame), cy: track1(CAM_Y, frame) };
  const cur = { x: track1(CUR_X, frame), y: track1(CUR_Y, frame) };

  /* 场景进出场:A 436–466 淡出;B 468–498 淡入 */
  const fadeA = interpolate(frame, [0, 8, 436, 466], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const fadeB = interpolate(frame, [468, 498], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const masterFade = interpolate(frame, [1755, 1785], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  const cursorOpacity = interpolate(frame, [60, 70], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const pressing = CLICKS.some((c) => frame >= c.f && frame < c.f + 6);

  return (
    <AbsoluteFill style={{ background: '#0a0b0e' }}>
      {/* 场景 A:欢迎页 */}
      {frame < SCENE_A_END && (
        <AbsoluteFill style={{ background: 'radial-gradient(1200px 800px at 50% 38%, #232733 0%, #101218 72%)', opacity: fadeA }}>
          <AbsoluteFill
            style={{
              width: WIN_W,
              height: WIN_H,
              flex: 'none',
              transform: `translate(${960 - cam.cx * cam.s}px, ${540 - cam.cy * cam.s}px) scale(${cam.s})`,
              transformOrigin: '0 0',
            }}
          >
            <Welcome2 state={welcomeAt(frame)} frame={frame} />
            <Highlight x={NEW_PROJ_BTN.x - 6} y={NEW_PROJ_BTN.y - 6} w={NEW_PROJ_BTN.w + 12} h={NEW_PROJ_BTN.h + 12} r={8} from={88} to={124} />
            <Highlight x={PM.serverCard.x - 6} y={PM.serverCard.y - 6} w={PM.serverCard.w + 12} h={PM.serverCard.h + 12} r={8} from={338} to={390} />
            <Cursor x={cur.x} y={cur.y} opacity={cursorOpacity} pressScale={pressing ? 0.84 : 1} clicks={CLICKS} />
          </AbsoluteFill>
        </AbsoluteFill>
      )}

      {/* 场景 B–F:工作台 */}
      {frame >= 460 && (
        <AbsoluteFill style={{ background: 'radial-gradient(1200px 800px at 50% 38%, #232733 0%, #101218 72%)', opacity: fadeB }}>
          <AbsoluteFill
            style={{
              width: WIN_W,
              height: WIN_H,
              flex: 'none',
              transform: `translate(${960 - cam.cx * cam.s}px, ${540 - cam.cy * cam.s}px) scale(${cam.s})`,
              transformOrigin: '0 0',
            }}
          >
            <Wb2 state={wbAt(frame)} frame={frame} />
            <Highlight
              x={WORKAREA_CHIP.x - 5}
              y={WORKAREA_CHIP.y - 5}
              w={WORKAREA_CHIP.w + 10}
              h={WORKAREA_CHIP.h + 10}
              r={10}
              from={672}
              to={704}
            />
            <Cursor x={cur.x} y={cur.y} opacity={cursorOpacity} pressScale={pressing ? 0.84 : 1} clicks={CLICKS} />

            {/* 中键徽标 */}
            {CLICKS.filter((c) => c.mid && frame >= c.f && frame < c.f + 26).map((c) => (
              <div
                key={c.f}
                style={{
                  position: 'absolute',
                  left: c.x + 18,
                  top: c.y + 12,
                  padding: '2px 8px',
                  borderRadius: 6,
                  background: 'rgba(13,15,20,0.92)',
                  border: '1px solid rgba(229,192,123,0.6)',
                  color: '#e5c07b',
                  fontSize: 11,
                  fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
                  pointerEvents: 'none',
                }}
              >
                中键
              </div>
            ))}

            {/* 中键注释(教学叠加层) */}
            {MID_NOTES.map((n) => {
              const t = interpolate(frame, [n.from - 6, n.from, n.to, n.to + 6], [0, 1, 1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
              if (t <= 0) return null;
              return (
                <div
                  key={n.from}
                  style={{
                    position: 'absolute',
                    left: n.x,
                    top: n.y,
                    padding: '6px 12px',
                    borderRadius: 8,
                    background: 'rgba(13,15,20,0.92)',
                    border: '1px solid #4f8ef7',
                    color: '#6ba1f8',
                    fontSize: 12.5,
                    fontFamily: '"Segoe UI", "Microsoft YaHei", system-ui, sans-serif',
                    opacity: t,
                    whiteSpace: 'nowrap',
                    pointerEvents: 'none',
                  }}
                >
                  {n.text}
                </div>
              );
            })}
          </AbsoluteFill>
        </AbsoluteFill>
      )}

      {/* 暗角 + 字幕 + 总淡出 */}
      <AbsoluteFill
        style={{ background: 'radial-gradient(ellipse at center, transparent 58%, rgba(0,0,0,0.26) 100%)', pointerEvents: 'none' }}
      />
      {CAPTIONS2.map((c) => (
        <Caption key={c.from} from={c.from} to={c.to} text={c.text} />
      ))}
      <AbsoluteFill style={{ background: '#000', opacity: masterFade, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};
