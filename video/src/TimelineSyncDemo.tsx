/**
 * 第九段教学视频总装:时间线云同步(合成 TimelineSyncDemo)。
 * 三场景:客户端(Wb9)⇄ 网页端(Web9,sceneT 交叉淡化)⇄ 收尾分屏(SPLIT_AT 后,视频坐标,
 * 双窗口缩略 + 同步徽标 + 三张特性卡)。运镜/指针/点击/字幕全部来自 timeline9/script.ts。
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
import { Icon } from './ui';
import {
  CAM_S, CAM_X, CAM_Y, CAPTIONS9, CLICKS, CUR_PATH, DURATION, HIGHLIGHTS9, NOTES9, SPLIT_AT,
  WEB_BACK, WEB_IN, finaleWb, finaleWeb, tlRowsAt, wbAt, webAt, webVisibleRows,
} from './timeline9/script';
import { Wb9 } from './timeline9/Wb9';
import { Web9 } from './timeline9/Web9';

/** 收尾三张特性卡(视频坐标) */
const CARDS = [
  { from: 4120, title: '自动记录', desc: 'SSH、命令、传输、AI 会话，9 类事件零操作留痕' },
  { from: 4165, title: '脱敏同步', desc: '本机脱敏后上传，默认开启、一键可关' },
  { from: 4210, title: '跨项目检索', desc: '网页端统一时间线，项目 / 类别 / 标签任意筛' },
] as const;

/** 分屏缩略窗框(各自取景:窗口内容 scale 后平移,框内裁切) */
const PANE = { y: 140, h: 560, w: 880 } as const;

const MiniPane: React.FC<{ x: number; label: string; children: React.ReactNode; dx: number; dy: number; scale: number }> = ({ x, label, children, dx, dy, scale }) => (
  <div style={{ position: 'absolute', left: x, top: PANE.y, opacity: 1 }}>
    <div
      style={{
        position: 'absolute', left: 0, top: 0, width: PANE.w, height: PANE.h, borderRadius: 12,
        border: `1px solid ${C.borderStrong}`, overflow: 'hidden', background: '#0a0b0e',
        boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
      }}
    >
      <div style={{ position: 'absolute', left: dx, top: dy, width: 1920, height: 1200, transform: `scale(${scale})`, transformOrigin: '0 0' }}>
        {children}
      </div>
    </div>
    <div style={{ position: 'absolute', left: 0, top: PANE.h + 14, width: PANE.w, textAlign: 'center', fontSize: 15, fontWeight: 600, color: C.text1 }}>
      {label}
    </div>
  </div>
);

const Body: React.FC = () => {
  const frame = useCurrentFrame();

  const cam = { s: track1(CAM_S, frame), cx: track1(CAM_X, frame), cy: track1(CAM_Y, frame) };
  const cur = useAnchorTrack(CUR_PATH, frame);
  const state = wbAt(frame);
  const web = webAt(frame);
  const { rowsA, rowsB } = tlRowsAt(frame, state);
  const webRows = webVisibleRows(web);

  const sceneT = interpolate(frame, [WEB_IN, WEB_IN + 32, WEB_BACK, WEB_BACK + 32], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const inSplit = frame >= SPLIT_AT;

  const fadeIn = interpolate(frame, [0, 8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const masterFade = interpolate(frame, [DURATION - 60, DURATION - 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const cursorOpacity = interpolate(frame, [50, 60], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    * interpolate(frame, [SPLIT_AT - 20, SPLIT_AT], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const pressing = CLICKS.some((c) => frame >= c.f && frame < c.f + 6);

  /* 收尾分屏元素 */
  const splitT = interpolate(frame, [SPLIT_AT, SPLIT_AT + 65], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const arrowT = interpolate(frame, [SPLIT_AT + 70, SPLIT_AT + 90], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const dimT = interpolate(frame, [4100, 4140], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  void splitT;

  return (
    <AbsoluteFill style={{ background: '#0a0b0e' }}>
      {!inSplit && (
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
            {/* 客户端 ⇄ 网页端交叉淡化 */}
            <AbsoluteFill style={{ opacity: 1 - sceneT, transform: `translateX(${-40 * sceneT}px)` }}>
              <Wb9 state={state} frame={frame} rowsA={rowsA} rowsB={rowsB} />
            </AbsoluteFill>
            <AbsoluteFill style={{ opacity: sceneT, transform: `translateX(${40 * (1 - sceneT)}px)` }}>
              <Web9 state={web} frame={frame} rows={webRows} />
            </AbsoluteFill>

            {/* 教学说明卡 */}
            {NOTES9.map((n) => (
              <Note key={n.from} note={n} />
            ))}
          </AbsoluteFill>
        </AbsoluteFill>
      )}

      {/* 焦点高亮环 + 指针(锚点实测画布坐标,不随相机变换;zIndex 55 压过菜单 45/模态 50) */}
      {!inSplit && (
        <>
          <div style={{ position: 'absolute', inset: 0, zIndex: 55, pointerEvents: 'none' }}>
            {HIGHLIGHTS9.map((h) => (
              <Highlight key={`${h.target}:${h.from}`} target={h.target} pad={h.pad} r={h.r} from={h.from} to={h.to} />
            ))}
          </div>
          <div style={{ position: 'absolute', inset: 0, zIndex: 60, pointerEvents: 'none' }}>
            <Cursor x={cur.x} y={cur.y} opacity={cursorOpacity} pressScale={pressing ? 0.84 : 1} clicks={CLICKS} />
          </div>
        </>
      )}

      {/* 收尾分屏:客户端 ⇄ 网页端 + 同步徽标 + 特性卡 */}
      {inSplit && (
        <AbsoluteFill>
          <MiniPane x={60} label="客户端 · 时间线" dx={-220} dy={-23} scale={0.69}>
            <Wb9 state={finaleWb()} frame={0} rowsA={tlRowsAt(9999, finaleWb()).rowsA} rowsB={tlRowsAt(9999, finaleWb()).rowsB} />
          </MiniPane>
          <MiniPane x={980} label="云平台 · 跨项目统一时间线" dx={-16} dy={-19} scale={0.48}>
            <Web9 state={finaleWeb()} frame={0} rows={webVisibleRows(finaleWeb())} />
          </MiniPane>
          {/* 同步徽标(接缝处) */}
          <div
            style={{
              position: 'absolute', left: 928, top: 390, width: 64, height: 64, borderRadius: '50%',
              background: C.accentDim, border: `1.5px solid ${C.accent}`, display: 'flex',
              alignItems: 'center', justifyContent: 'center', color: C.accent,
              opacity: arrowT, transform: `scale(${(0.9 + 0.08 * Math.sin(frame / 7)) * arrowT})`,
            }}
          >
            <Icon name="sync" size={26} />
          </div>
          {/* 特性卡(压暗背景后浮出) */}
          <AbsoluteFill style={{ background: 'rgba(10,11,14,0.72)', opacity: dimT, pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', left: 0, width: 1920, top: 780, display: 'flex', justifyContent: 'center' }}>
            <div style={{ display: 'flex', gap: 40 }}>
              {CARDS.map((cc) => {
                const t = interpolate(frame, [cc.from - 8, cc.from, DURATION - 30, DURATION - 8], [0, 1, 1, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                const rise = interpolate(frame, [cc.from - 8, cc.from + 6], [16, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
                return (
                  <div
                    key={cc.title}
                    style={{
                      width: 420, borderLeft: `3px solid ${C.accent}`, paddingLeft: 18,
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
      {CAPTIONS9.map((c) => (
        <Caption key={c.from} from={c.from} to={c.to} text={c.text} />
      ))}
      <AbsoluteFill style={{ background: '#000', opacity: masterFade, pointerEvents: 'none' }} />
    </AbsoluteFill>
  );
};

export const TimelineSyncDemo: React.FC = () => (
  <AnchorRoot>
    <Body />
  </AnchorRoot>
);
