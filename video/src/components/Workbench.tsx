/**
 * 工作台复刻(场景二):对照 src/pages/workbench 的 workbench.css 布局
 * (活动栏 48 / 侧栏 260 / 中央标签+终端 / 右侧 AI 面板 340 / 底栏 26)
 * 与 ai/ai-engine.ts 的面板结构(会话头、消息气泡、工具行、输入区)。
 * 布局几何与 ../scene.ts 的 AI_PANEL / AI_INPUT 锚点一致。
 */
import React from 'react';
import { C, FONT_MONO, FONT_UI } from '../theme';
import { Icon } from '../ui';
import { TopBar } from './TopBar';
import { AI_PANEL, WIN_H, WIN_W } from '../scene';

/** 一条聊天消息(气泡态);ai 消息可带工具行与输入中指示 */
export interface ChatMsg {
  role: 'user' | 'ai';
  text: string;
  /** 工具行标签(如「kb_search 你服务于哪家企业」) */
  tool?: string;
  /** 正在输入(三点指示) */
  typing?: boolean;
}

export interface WorkbenchState {
  msgs: ChatMsg[];
  inputText: string;
  inputCaret: boolean;
  inputFocus: boolean;
}

const ACTIVITY_ICONS = [
  { icon: 'folder', active: true },
  { icon: 'server', active: false },
  { icon: 'note', active: false },
  { icon: 'terminal', active: false },
  { icon: 'zap', active: false },
] as const;

const TREE = [
  { icon: 'folder', name: 'src', indent: 0 },
  { icon: 'folder', name: 'docs', indent: 0 },
  { icon: 'folder', name: 'scripts', indent: 0 },
  { icon: 'file', name: 'README.md', indent: 0 },
  { icon: 'file', name: 'docker-compose.yml', indent: 0 },
] as const;

/** Git Bash 提示符行(绿用户/紫 MINGW64/黄路径) */
const TermPrompt: React.FC = () => (
  <>
    <span style={{ color: C.green }}>khellendros@desktop</span> <span style={{ color: '#b687e8' }}>MINGW64</span>{' '}
    <span style={{ color: C.yellow }}>/d/AIShellDemo/workspace/deephaven-bigdata</span>
  </>
);

interface TermLine {
  text?: string;
  /** 命令行($ 前缀) */
  cmd?: boolean;
  /** 行首为 shell 提示符 */
  prompt?: boolean;
  /** 行尾块光标 */
  cursor?: boolean;
}

/** 终端回滚内容(约 52 行 ≈ 1100px,铺满中央区可视高度,顶部少量裁切) */
const TERM_LINES: TermLine[] = [
  { prompt: true },
  { cmd: true, text: 'git status' },
  { text: 'On branch main' },
  { text: 'nothing to commit, working tree clean' },
  { text: '' },
  { prompt: true },
  { cmd: true, text: 'npm run build' },
  { text: '' },
  { text: '> deephaven-bigdata@1.2.0 build' },
  { text: '> tsc && vite build' },
  { text: '' },
  { text: 'vite v5.4.19 building for production...' },
  { text: 'transforming...' },
  { text: '✓ 1284 modules transformed.' },
  { text: 'rendering chunks...' },
  { text: 'computing gzip size...' },
  { text: 'dist/index.html                    0.46 kB │ gzip:   0.30 kB' },
  { text: 'dist/assets/index-Dn8kL2pQ.css    46.12 kB │ gzip:   9.84 kB' },
  { text: 'dist/assets/vendor-Bq7mXz2a.js   198.33 kB │ gzip:  64.12 kB' },
  { text: 'dist/assets/worker-Pq4nLx88.js    84.07 kB │ gzip:  27.55 kB' },
  { text: 'dist/assets/index-Cx3mPq91.js    312.48 kB │ gzip: 101.26 kB' },
  { text: '✓ built in 4.21s' },
  { text: '' },
  { prompt: true },
  { cmd: true, text: 'git log --oneline -5' },
  { text: 'a3f8c21 feat: 接入企业知识库检索' },
  { text: '91bc04e fix: 终端命令区块边界判定' },
  { text: 'e55d7a0 chore: 升级依赖' },
  { text: 'c21a9b8 feat: SFTP 断点续传' },
  { text: '7d02e11 docs: 更新部署手册' },
  { text: '' },
  { prompt: true },
  { cmd: true, text: 'docker compose ps' },
  { text: 'NAME       STATUS        PORTS' },
  { text: 'postgres   Up 3 days     5432/tcp' },
  { text: 'redis      Up 3 days     6379/tcp' },
  { text: 'minio      Up 3 days     9000/tcp' },
  { text: '' },
  { prompt: true },
  { cmd: true, text: 'npm outdated' },
  { text: 'Package  Current  Wanted  Latest' },
  { text: 'react     18.3.1  18.3.1  19.1.0' },
  { text: 'vite      5.4.19  5.4.21   7.1.3' },
  { text: '' },
  { prompt: true },
  { cmd: true, text: 'pytest tests/ -q' },
  { text: '..........................................' },
  { text: '42 passed in 3.87s' },
  { text: '' },
  { prompt: true },
  { cmd: true, cursor: true },
];

/** 正在输入三点指示(帧驱动确定性闪烁) */
const TypingDots: React.FC<{ frame: number }> = ({ frame }) => (
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

const Bubble: React.FC<{ msg: ChatMsg; frame: number }> = ({ msg, frame }) => {
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
        {msg.typing && !msg.text ? <TypingDots frame={frame} /> : msg.text}
      </div>
    </div>
  );
};

export const Workbench: React.FC<{ state: WorkbenchState; frame: number }> = ({ state, frame }) => (
  <div
    style={{
      position: 'absolute',
      width: WIN_W,
      height: WIN_H,
      background: C.bg0,
      color: C.text0,
      fontFamily: FONT_UI,
      fontSize: 13,
      borderRadius: 14,
      border: `1px solid ${C.borderStrong}`,
      overflow: 'hidden',
      boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
    }}
  >
    <TopBar active="项目" project="Deephaven-bigdata 开发环境" />

    {/* ===== 工作台主体 ===== */}
    <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 26, display: 'flex' }}>
      {/* 活动栏 */}
      <div
        style={{
          width: 48,
          flex: 'none',
          background: C.bg1,
          borderRight: `1px solid ${C.border}`,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          paddingTop: 6,
          gap: 2,
        }}
      >
        {ACTIVITY_ICONS.map((it) => (
          <div
            key={it.icon}
            style={{
              width: 40,
              height: 36,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '0 8px 8px 0',
              borderLeft: `2px solid ${it.active ? C.accent : 'transparent'}`,
              color: it.active ? C.accent : C.text1,
              background: it.active ? C.bgHover : 'transparent',
            }}
          >
            <Icon name={it.icon} size={17} />
          </div>
        ))}
        <div style={{ marginTop: 'auto', marginBottom: 6 }}>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: C.bg3,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: C.text1,
            }}
          >
            <Icon name="user" size={14} />
          </div>
        </div>
      </div>

      {/* 侧栏:项目文件 */}
      <div style={{ width: 260, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}` }}>
        <div
          style={{
            height: 34,
            display: 'flex',
            alignItems: 'center',
            padding: '0 14px',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.5,
            color: C.text1,
          }}
        >
          项目文件
        </div>
        <div style={{ padding: '0 6px' }}>
          {TREE.map((row) => (
            <div
              key={row.name}
              style={{
                height: 26,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '0 8px',
                borderRadius: 4,
                fontSize: 12.5,
                color: C.text1,
              }}
            >
              <Icon name="chevronRight" size={10} color={C.text2} />
              <Icon name={row.icon} size={13} color={row.icon === 'folder' ? C.text1 : C.text2} />
              {row.name}
            </div>
          ))}
        </div>
      </div>

      {/* 中央:标签 + 终端 */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg0 }}>
        <div style={{ height: 36, flex: 'none', display: 'flex', background: C.bg1, borderBottom: `1px solid ${C.border}` }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 12px',
              minWidth: 110,
              borderRight: `1px solid ${C.border}`,
              borderTop: `2px solid ${C.accent}`,
              background: C.bg0,
              fontSize: 12.5,
              color: C.text0,
            }}
          >
            <Icon name="terminal" size={13} color={C.text1} />
            本地终端
          </div>
        </div>
        <div
          style={{
            flex: 1,
            background: '#0d1117',
            padding: '12px 14px',
            fontFamily: FONT_MONO,
            fontSize: 12.5,
            lineHeight: 1.7,
            overflow: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
          }}
        >
          {/* 回滚日志底部对齐:运镜扫过中央区时内容铺满,顶部超出裁切 */}
          {TERM_LINES.map((line, i) => (
            <div key={i} style={{ whiteSpace: 'pre', color: line.cmd ? C.text0 : C.text1 }}>
              {line.cmd && <span style={{ color: C.green }}>$ </span>}
              {line.prompt && <TermPrompt />}
              {line.text === '' ? ' ' : line.text}
              {line.cursor && (
                <span style={{ display: 'inline-block', width: 7, height: 14, background: C.text1, verticalAlign: '-2px', opacity: frame % 32 < 16 ? 1 : 0 }} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 右侧 AI 面板(对照 ai-engine.ts) */}
      <div
        style={{
          width: AI_PANEL.w,
          flex: 'none',
          background: C.bg1,
          borderLeft: `1px solid ${C.border}`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* 会话头 */}
        <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: `1px solid ${C.border}` }}>
          <div
            style={{
              flex: 1,
              height: 26,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 6,
              padding: '0 8px',
              background: C.bg2,
              border: `1px solid ${C.border}`,
              borderRadius: 4,
              fontSize: 12,
            }}
          >
            新会话
            <Icon name="chevronDown" size={12} color={C.text2} />
          </div>
          <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
            <Icon name="plus" size={14} />
          </div>
        </div>

        {/* 消息区(从底部堆叠,新消息把旧内容向上推) */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8, padding: 10 }}>
          {state.msgs.map((m, i) => (
            <Bubble key={i} msg={m} frame={frame} />
          ))}
        </div>

        {/* 输入区 */}
        <div style={{ flex: 'none', borderTop: `1px solid ${C.border}`, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 0', fontSize: 11, color: C.text2 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="bot" size={12} /> AI 模式
            </span>
            <div
              style={{
                width: 74,
                height: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 6px',
                background: C.bg2,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                color: C.text0,
              }}
            >
              仅建议
              <Icon name="chevronDown" size={10} color={C.text2} />
            </div>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="zap" size={12} /> 思考强度
            </span>
            <div
              style={{
                width: 78,
                height: 22,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 6px',
                background: C.bg2,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                color: C.text0,
              }}
            >
              低
              <Icon name="chevronDown" size={10} color={C.text2} />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                padding: '2px 6px',
                background: C.bg2,
                border: `1px solid ${C.border}`,
                borderRadius: 4,
                fontSize: 11,
                color: C.text1,
              }}
            >
              <Icon name="monitor" size={11} /> @local
            </span>
          </div>
          <div
            style={{
              position: 'relative',
              minHeight: 70,
              padding: '8px 10px',
              background: C.bg2,
              border: `1px solid ${state.inputFocus ? C.accent : C.border}`,
              borderRadius: 6,
              fontSize: 12.5,
              lineHeight: 1.6,
            }}
          >
            {state.inputText ? (
              <span style={{ color: C.text0 }}>
                {state.inputText}
                {state.inputCaret && <span style={{ display: 'inline-block', width: 1.5, height: 14, background: C.accent, verticalAlign: '-2px', marginLeft: 1 }} />}
              </span>
            ) : (
              <span style={{ color: C.text2 }}>向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器</span>
            )}
            <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10.5, color: C.text2 }}>Enter 发送</span>
          </div>
        </div>
      </div>
    </div>

    {/* 底栏 */}
    <div
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        height: 26,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '0 8px',
        background: C.bg1,
        borderTop: `1px solid ${C.border}`,
        color: C.text1,
        fontSize: 11,
      }}
    >
      <span>本地终端 · 就绪</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.accent }}>
        <Icon name="bot" size={12} /> AI 助手
      </span>
    </div>
  </div>
);
