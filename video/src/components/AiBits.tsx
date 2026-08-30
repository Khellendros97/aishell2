/**
 * AI 对话气泡件(两个视频工程共用):对照 ai-engine.ts 的 .ai-msg/.ai-bubble/.ai-tool-line/.ai-typing。
 * 从 components/Workbench.tsx 抽出,供场景一(01 视频)与场景二(02 视频)复用。
 */
import React from 'react';
import { C, FONT_MONO } from '../theme';
import { Icon } from '../ui';

/** 一条聊天消息(气泡态);ai 消息可带工具行与输入中指示 */
export interface ChatMsg {
  role: 'user' | 'ai';
  text: string;
  /** 用户消息内嵌引用 chip(如 @term:a1b2c,渲染在文本前) */
  chip?: string;
  /** 工具行标签(如「kb_search 你服务于哪家企业」) */
  tool?: string;
  /** 正在输入(三点指示) */
  typing?: boolean;
  /** 命令卡(AI 输出的 ```command 围栏,渲染为可粘贴卡片) */
  cmdCard?: { cmd: string; pressed?: boolean; hovered?: boolean };
}

/** 用户消息内嵌引用 chip(对照 ai-engine .ai-inline-chip) */
const InlineChip: React.FC<{ text: string }> = ({ text }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '0 5px',
      borderRadius: 4,
      background: C.accentDim,
      border: `1px solid ${C.accent}`,
      color: C.accentHover,
      fontSize: 11.5,
      marginRight: 4,
    }}
  >
    {text}
  </span>
);

/** 正在输入三点指示(帧驱动确定性闪烁) */
export const TypingDots: React.FC<{ frame: number }> = ({ frame }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
    <span style={{ fontSize: 11, color: C.text2, marginRight: 2 }}>正在输入</span>
    {[0, 1, 2].map((i) => {
      const up = (frame * 2 + i * 8) % 48 < 24;
      return (
        <span
          key={i}
          style={{
            width: 5,
            height: 5,
            borderRadius: '50%',
            background: C.text2,
            opacity: up ? 1 : 0.25,
            transform: up ? 'translateY(-2px)' : 'none',
          }}
        />
      );
    })}
  </span>
);

/** 命令卡(对照 .ai-suggest.cmd:左侧绿条 + 终端图标头 + mono 命令体 + 粘贴/收藏按钮) */
export const CommandCard: React.FC<{ cmd: string; hovered?: boolean; pressed?: boolean }> = ({
  cmd,
  hovered,
  pressed,
}) => (
  <div
    style={{
      margin: '6px 0',
      padding: '8px 10px',
      background: hovered ? C.bg3 : C.bg2,
      border: `1px solid ${hovered ? C.borderStrong : C.border}`,
      borderLeft: `3px solid ${C.green}`,
      borderRadius: 8,
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      transform: pressed ? 'translateY(0.5px)' : 'none',
    }}
  >
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <Icon name="terminal" size={13} color={C.green} />
      <span style={{ fontSize: 11, color: C.text2 }}>点击卡片粘贴到终端</span>
      <div style={{ flex: 1 }} />
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          padding: '3px 10px',
          borderRadius: 4,
          background: hovered ? C.accent : C.bg1,
          border: `1px solid ${hovered ? C.accent : C.border}`,
          color: hovered ? '#fff' : C.text1,
          fontSize: 11.5,
        }}
      >
        粘贴到终端
      </div>
      <Icon name="star" size={13} color={C.text2} />
    </div>
    <code style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C.green, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{cmd}</code>
  </div>
);

export const Bubble: React.FC<{ msg: ChatMsg; frame: number }> = ({ msg, frame }) => {
  const isUser = msg.role === 'user';
  return (
    <div style={{ display: 'flex', justifyContent: isUser ? 'flex-end' : 'flex-start' }}>
      <div
        style={{
          maxWidth: '88%',
          padding: '8px 11px',
          borderRadius: 10,
          borderBottomRightRadius: isUser ? 3 : 10,
          borderBottomLeftRadius: isUser ? 10 : 3,
          background: isUser ? C.accentDim : C.bg2,
          fontSize: 12.5,
          lineHeight: 1.6,
          wordBreak: 'break-word',
        }}
      >
        {msg.tool && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: C.text2, marginBottom: 3, fontFamily: FONT_MONO }}>
            <Icon name="wrench" size={11} />
            {msg.tool}
          </div>
        )}
        {msg.typing && !msg.text ? <TypingDots frame={frame} /> : <>{msg.chip && <InlineChip text={msg.chip} />}{msg.text}</>}
        {msg.cmdCard && <CommandCard cmd={msg.cmdCard.cmd} hovered={msg.cmdCard.hovered} pressed={msg.cmdCard.pressed} />}
      </div>
    </div>
  );
};
