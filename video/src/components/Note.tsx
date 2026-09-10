/**
 * 教学说明卡(窗口坐标叠加层,随摄像机缩放):info/alert 两态,右缘滑入。
 * 从各段 script 内散落的 Note 渲染抽出共用;note 字段结构见各段 Note9/Note8。
 */
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { C, FONT_UI, IconName } from '../theme';
import { Icon } from '../ui';

export interface NoteSpec {
  from: number;
  to: number;
  x: number;
  y: number;
  w: number;
  kind: 'info' | 'alert';
  title: string;
  body: string;
}

const NOTE_ICON: Record<'info' | 'alert', IconName> = { info: 'info', alert: 'alert' };
const NOTE_COLOR = {
  info: { edge: 'rgba(79,142,247,0.55)', text: C.accent },
  alert: { edge: 'rgba(229,98,106,0.55)', text: C.red },
};

export const Note: React.FC<{ note: NoteSpec }> = ({ note }) => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [note.from - 6, note.from, note.to, note.to + 6], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  if (t <= 0) return null;
  const cc = NOTE_COLOR[note.kind];
  return (
    <div
      style={{
        position: 'absolute',
        left: note.x,
        top: note.y,
        width: note.w,
        padding: '14px 16px',
        borderRadius: 10,
        background: 'rgba(13,15,20,0.94)',
        border: `1px solid ${cc.edge}`,
        opacity: t,
        transform: `translateX(${(1 - t) * 16}px)`,
        pointerEvents: 'none',
        fontFamily: FONT_UI,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{ display: 'flex', color: cc.text }}>
          <Icon name={NOTE_ICON[note.kind]} size={15} />
        </span>
        <span style={{ fontSize: 14, fontWeight: 700, color: cc.text }}>{note.title}</span>
      </div>
      <div style={{ fontSize: 12.5, lineHeight: 1.7, color: C.text1 }}>{note.body}</div>
    </div>
  );
};
