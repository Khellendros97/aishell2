/**
 * 视频二工作台复刻:以当前 React 前端为准，终端历史使用右侧 .term-drawer，
 * 卡片内提供「命令收藏 / 添加到chat」；服务器、命令收藏与 AI 面板沿用实际布局。
 * 全部内容由 state(Wb2State)驱动,锚点见 ./layout.ts。
 */
import React from 'react';
import { Bubble, ChatMsg } from '../components/AiBits';
import { TopBar } from '../components/TopBar';
import { C, FONT_MONO, FONT_UI } from '../theme';
import { Icon } from '../ui';
import { WIN_H, WIN_W } from '../scene';
import { AI_PANEL2, DEMO, FAV_MODAL, HISTORY_CARD, HISTORY_DRAWER, SIDEBAR, SSH_BTN, TERM } from './layout';

export interface TermOutLine {
  text: string;
  color?: 'green' | 'dim' | 'yellow';
}

export interface TermBlockState {
  cmd: string;
  out: TermOutLine[];
  /** 右侧历史抽屉中的当前操作状态 */
  hovered?: boolean;
  pressAction?: 'pin' | 'addchat' | null;
}

/** 文本选区:第 blockIdx 块第 lineIdx 行(输出行)的 [startCh,endCh) 字符区间 */
export interface SelRange {
  blockIdx: number;
  lineIdx: number;
  startCh: number;
  endCh: number;
}

export type Wb2Target =
  | 'actServers'
  | 'actCommands'
  | 'sshBtn'
  | 'addchat'
  | 'pin'
  | 'cmdCard'
  | 'favSave'
  | 'favCopy'
  | null;

export interface Wb2State {
  panel: 'explorer' | 'servers' | 'commands';
  sshOpen: boolean;
  /** 连接过程可见行数(0..TERM_MOTD_LINES) */
  connectLines: number;
  workarea: 'local' | 'remote';
  blocks: TermBlockState[];
  termInput: string;
  termCaret: boolean;
  selection: SelRange | null;
  aiMsgs: ChatMsg[];
  aiInputText: string;
  aiInputChip: string | null;
  workareaFlash: boolean;
  favModalT: number;
  favTitle: string;
  favCmd: string;
  favSaved: boolean;
  toast: string | null;
  hover: Wb2Target;
  press: Wb2Target;
}

const SEL_BG = 'rgba(79,142,247,0.35)';
const PROMPT_REMOTE = DEMO.remotePrompt;

const btnSmall = (hovered: boolean, pressed: boolean): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  height: 26,
  padding: '0 10px',
  background: hovered ? C.bg3 : C.bg2,
  border: `1px solid ${hovered ? C.borderStrong : C.border}`,
  borderRadius: 4,
  fontSize: 12,
  color: C.text0,
  transform: pressed ? 'translateY(0.5px)' : 'none',
  whiteSpace: 'nowrap',
});

const outColor = (c?: TermOutLine['color']): string => (c === 'green' ? C.green : c === 'yellow' ? C.yellow : c === 'dim' ? '#8b93a5' : C.text1);

/** 终端提示符(远程) */
const RemotePrompt: React.FC = () => <span style={{ color: C.green }}>{PROMPT_REMOTE}</span>;

/** 渲染一行(可带选区高亮) */
const TermLineRow: React.FC<{ line: TermOutLine; sel?: { startCh: number; endCh: number } | null }> = ({ line, sel }) => {
  const color = outColor(line.color);
  if (!sel) return <div style={{ color }}>{line.text || ' '}</div>;
  const { startCh, endCh } = sel;
  return (
    <div style={{ color }}>
      {line.text.slice(0, startCh)}
      <span style={{ background: SEL_BG, color: C.text0 }}>{line.text.slice(startCh, endCh)}</span>
      {line.text.slice(endCh)}
    </div>
  );
};

export const Wb2: React.FC<{ state: Wb2State; frame: number }> = ({ state, frame }) => {
  const {
    panel,
    sshOpen,
    connectLines,
    workarea,
    blocks,
    termInput,
    termCaret,
    selection,
    aiMsgs,
    aiInputText,
    aiInputChip,
    workareaFlash,
    favModalT,
    favTitle,
    favCmd,
    favSaved,
    toast,
    hover,
    press,
  } = state;

  const CONNECT_LINES: TermOutLine[] = [
    { text: `Connecting to ${DEMO.serverUser}@${DEMO.serverHost}:22 ...`, color: 'dim' },
    { text: 'Welcome to openEuler 24.03 LTS SP4', color: undefined },
    { text: `Last login: Sun Aug 30 10:24:11 2026 from 10.21.36.100`, color: 'dim' },
    { text: '' },
  ];

  return (
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
      <TopBar active="项目" project={DEMO.projectName} />

      <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 26, display: 'flex' }}>
        {/* ===== 活动栏 ===== */}
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
          {(
            [
              { icon: 'folder', id: 'explorer', label: '项目文件' },
              { icon: 'server', id: 'servers', label: '服务器列表' },
              { icon: 'note', id: 'notes', label: '笔记' },
              { icon: 'terminal', id: 'terms', label: '终端' },
              { icon: 'zap', id: 'commands', label: '命令收藏' },
            ] as const
          ).map((it) => {
            const active = panel === it.id;
            const hovered = (it.id === 'servers' && hover === 'actServers') || (it.id === 'commands' && hover === 'actCommands');
            return (
              <div
                key={it.id}
                title={it.label}
                style={{
                  width: 40,
                  height: 36,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: '0 8px 8px 0',
                  borderLeft: `2px solid ${active ? C.accent : 'transparent'}`,
                  color: active ? C.accent : hovered ? C.text0 : C.text1,
                  background: active || hovered ? C.bgHover : 'transparent',
                }}
              >
                <Icon name={it.icon} size={17} />
              </div>
            );
          })}
          <div style={{ marginTop: 'auto', marginBottom: 6 }}>
            <div style={{ width: 26, height: 26, borderRadius: '50%', background: C.bg3, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
              <Icon name="user" size={14} />
            </div>
          </div>
        </div>

        {/* ===== 侧栏 ===== */}
        <div style={{ width: SIDEBAR.w, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              height: SIDEBAR.headH,
              flex: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '0 10px 0 14px',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: 0.5,
              color: C.text1,
            }}
          >
            {panel === 'explorer' ? '项目文件' : panel === 'servers' ? '服务器列表' : '命令收藏'}
            {panel === 'commands' && (
              <div style={{ ...btnSmall(false, false), height: 22, padding: '0 8px', background: C.accent, border: 'none', color: '#fff', fontSize: 11.5 }}>
                + 新增
              </div>
            )}
          </div>

          <div style={{ flex: 1, padding: '4px 8px', overflow: 'hidden' }}>
            {panel === 'explorer' && (
              <>
                {['src', 'docs', 'scripts'].map((d) => (
                  <div key={d} style={{ height: 26, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderRadius: 4, fontSize: 12.5, color: C.text1 }}>
                    <Icon name="chevronRight" size={10} color={C.text2} />
                    <Icon name="folder" size={13} />
                    {d}
                  </div>
                ))}
                {['README.md', 'docker-compose.yml'].map((f) => (
                  <div key={f} style={{ height: 26, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderRadius: 4, fontSize: 12.5, color: C.text1 }}>
                    <span style={{ width: 10 }} />
                    <Icon name="file" size={13} color={C.text2} />
                    {f}
                  </div>
                ))}
              </>
            )}

            {panel === 'servers' && (
              <>
                {/* 本地终端固定卡 */}
                <div style={{ padding: '8px 12px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 30, height: 30, borderRadius: 8, background: C.bg3, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
                    <Icon name="monitor" size={16} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>本地终端</div>
                    <div style={{ fontSize: 11.5, color: C.text2, fontFamily: FONT_MONO }}>本地终端 · 点击打开</div>
                  </div>
                </div>
                {/* 服务器卡 */}
                <div
                  style={{
                    padding: '8px 12px',
                    background: C.bg2,
                    border: `1px solid ${hover === 'sshBtn' ? C.borderStrong : C.border}`,
                    borderRadius: 8,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 30, height: 30, borderRadius: 8, background: C.accentDim, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.accentHover }}>
                      <Icon name="server" size={16} />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{DEMO.serverName}</div>
                      <div style={{ fontSize: 11.5, color: C.text2, fontFamily: FONT_MONO }}>{DEMO.serverHost}:22</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', marginLeft: 40, marginTop: 6 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 10, fontSize: 11, lineHeight: '18px', background: C.bg3, color: C.text1 }}>
                      密码
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
                    <div title="添加到对话" style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.border}`, borderRadius: 4, background: C.bg1, color: C.text1 }}>
                      <Icon name="chatPlus" size={13} />
                    </div>
                    <div
                      title="SSH 连接"
                      style={{
                        width: SSH_BTN.w,
                        height: SSH_BTN.h,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        border: `1px solid ${hover === 'sshBtn' ? C.accent : C.border}`,
                        borderRadius: 4,
                        background: hover === 'sshBtn' ? C.accentDim : C.bg1,
                        color: hover === 'sshBtn' ? C.accent : C.text1,
                        transform: press === 'sshBtn' ? 'translateY(0.5px)' : 'none',
                      }}
                    >
                      <Icon name="terminal" size={13} />
                    </div>
                    <div title="SFTP 文件管理" style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.border}`, borderRadius: 4, background: C.bg1, color: C.text1 }}>
                      <Icon name="folder" size={13} />
                    </div>
                  </div>
                </div>
              </>
            )}

            {panel === 'commands' && (
              <>
                <div style={{ ...btnSmall(false, false), width: '100%', height: 26, justifyContent: 'flex-start', color: C.text2, marginBottom: 8 }}>
                  <Icon name="search" size={12} />
                  搜索命令…
                </div>
                {favSaved && (
                  <div style={{ padding: '8px 10px', background: C.bg2, border: `1px solid ${C.border}`, borderLeft: `2px solid ${C.accent}`, borderRadius: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{favTitle}</span>
                      <Icon name="pencil" size={12} color={C.text2} />
                      <Icon name="trash" size={12} color={C.text2} />
                    </div>
                    <div
                      style={{
                        fontFamily: FONT_MONO,
                        fontSize: 11.5,
                        color: C.text1,
                        margin: '4px 0 6px',
                        overflow: 'hidden',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                      }}
                    >
                      {favCmd}
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <div style={{ ...btnSmall(hover === 'favCopy', press === 'favCopy'), color: hover === 'favCopy' ? C.accent : C.text0 }}>复制到终端</div>
                      <div style={btnSmall(false, false)}>立即执行</div>
                    </div>
                  </div>
                )}
                {!favSaved && <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 12, color: C.text2 }}>暂无命令收藏</div>}
              </>
            )}
          </div>
        </div>

        {/* ===== 中央:标签 + 终端 ===== */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg0 }}>
          <div style={{ height: TERM.tabBarH, flex: 'none', display: 'flex', background: C.bg1, borderBottom: `1px solid ${C.border}` }}>
            {sshOpen && (
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
                {DEMO.serverName}
                <Icon name="x" size={11} color={C.text2} />
              </div>
            )}
          </div>

          {/* 信息栏(与当前 TerminalTab.tsx 一致) */}
          {sshOpen && (
            <div style={{ height: TERM.infoH, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', background: C.bg1, borderBottom: `1px solid ${C.border}`, fontSize: 12 }}>
              <span style={{ color: C.text2 }}>最后命令:</span>
              <span style={{ color: blocks.length ? C.text0 : C.text2, fontFamily: FONT_MONO, fontSize: 11.5 }}>
                {blocks.length ? blocks[blocks.length - 1].cmd : '—'}
              </span>
              <div style={{ flex: 1 }} />
              <div style={btnSmall(false, false)}>
                <Icon name="history" size={12} />
                历史命令 ({blocks.length})
              </div>
              <div style={btnSmall(false, false)}>
                <Icon name="star" size={12} />
                命令收藏
              </div>
              <div style={btnSmall(false, false)}>
                <Icon name="chatPlus" size={12} />
                添加到chat
              </div>
              <div style={btnSmall(false, false)}>
                <Icon name="circle" size={11} />
                录制
              </div>
            </div>
          )}

          {/* 终端主体：xterm 在左，历史命令抽屉固定在右 */}
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            <div style={{ flex: 1, minWidth: 0, background: '#0d1117', padding: `${TERM.padTop}px ${TERM.padX}px`, fontFamily: FONT_MONO, fontSize: 12.5, lineHeight: 1.7, overflow: 'hidden' }}>
              {sshOpen && (
                <>
                  {CONNECT_LINES.slice(0, connectLines).map((l, i) => (
                    <div key={i} style={{ color: outColor(l.color) }}>{l.text || ' '}</div>
                  ))}
                  {blocks.map((b, bi) => (
                    <React.Fragment key={bi}>
                      <div style={{ color: C.text0, whiteSpace: 'pre-wrap' }}>
                        <RemotePrompt /> {b.cmd}
                      </div>
                      {b.out.map((l, li) => (
                        <TermLineRow
                          key={li}
                          line={l}
                          sel={selection && selection.blockIdx === bi && selection.lineIdx === li ? { startCh: selection.startCh, endCh: selection.endCh } : null}
                        />
                      ))}
                    </React.Fragment>
                  ))}
                  {connectLines >= 4 && (
                    <div style={{ color: C.text0, whiteSpace: 'pre-wrap' }}>
                      <RemotePrompt /> {termInput}
                      {termCaret && (
                        <span style={{ display: 'inline-block', width: 7, height: 14, background: C.text1, verticalAlign: '-2px', opacity: frame % 32 < 16 ? 1 : 0 }} />
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            {sshOpen && (
              <div style={{ width: HISTORY_DRAWER.w, flex: 'none', display: 'flex', flexDirection: 'column', background: C.bg1, borderLeft: `1px solid ${C.border}` }}>
                <div style={{ height: HISTORY_DRAWER.headH, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 8px 0 12px', borderBottom: `1px solid ${C.border}`, fontSize: 12, fontWeight: 600, color: C.text1 }}>
                  <span>历史命令</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: blocks.length ? C.text1 : C.text2 }}>
                      <Icon name="trash" size={12} />
                    </span>
                    <span style={{ ...btnSmall(false, false), height: 24, padding: '0 8px', background: 'transparent' }}>收起</span>
                  </span>
                </div>
                <div style={{ flex: 1, overflow: 'hidden', padding: HISTORY_DRAWER.bodyPad, display: 'flex', flexDirection: 'column', gap: HISTORY_DRAWER.gap }}>
                  {blocks.map((b, bi) => (
                    <div
                      key={bi}
                      style={{
                        height: HISTORY_CARD.h[Math.min(bi, HISTORY_CARD.h.length - 1)],
                        boxSizing: 'border-box',
                        border: `1px solid ${b.hovered ? C.borderStrong : C.border}`,
                        borderLeft: `2px solid ${C.accent}`,
                        borderRadius: 6,
                        background: b.hovered ? C.bg3 : C.bg2,
                        padding: '6px 8px',
                        overflow: 'hidden',
                      }}
                    >
                      <div style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.text0, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 34, overflow: 'hidden', marginBottom: 5 }}>{b.cmd}</div>
                      <div style={{ fontFamily: FONT_MONO, fontSize: 11, lineHeight: 1.2, color: C.text2, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 40, overflow: 'hidden', marginBottom: 5 }}>
                        {b.out.slice(0, 3).map((line, i) => <div key={i}>{line.text}</div>)}
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <div style={btnSmall(false, b.pressAction === 'pin')}>
                          <Icon name="star" size={12} color={b.pressAction === 'pin' ? C.yellow : C.text1} />
                          命令收藏
                        </div>
                        <div style={btnSmall(hover === 'addchat' && bi === 2, b.pressAction === 'addchat')}>
                          <Icon name="chatPlus" size={12} />
                          添加到chat
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ===== 右侧 AI 面板 ===== */}
        <div style={{ width: AI_PANEL2.w, flex: 'none', background: C.bg1, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
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

          <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 8, padding: 10 }}>
            {aiMsgs.map((m, i) => (
              <Bubble key={i} msg={m} frame={frame} />
            ))}
          </div>

          <div style={{ flex: 'none', borderTop: `1px solid ${C.border}`, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 0', fontSize: 11, color: C.text2 }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="bot" size={12} /> AI 模式
              </span>
              <div style={{ width: 74, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text0 }}>
                仅建议
                <Icon name="chevronDown" size={10} color={C.text2} />
              </div>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Icon name="zap" size={12} /> 思考强度
              </span>
              <div style={{ width: 78, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text0 }}>
                低
                <Icon name="chevronDown" size={10} color={C.text2} />
              </div>
            </div>
            {/* chip 行:工作区 chip(随激活终端切换) */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  padding: '1px 8px',
                  borderRadius: 10,
                  fontSize: 11,
                  lineHeight: '18px',
                  background: C.accentDim,
                  color: C.accentHover,
                  border: `1px solid ${workareaFlash ? C.accent : 'transparent'}`,
                  boxShadow: workareaFlash ? `0 0 0 3px ${C.accentDim}` : 'none',
                }}
              >
                <Icon name="globe" size={11} />
                {workarea === 'remote' ? `@remote:${DEMO.serverName}` : '@local'}
              </span>
            </div>
            {/* 输入盒(可内嵌 @term chip) */}
            <div
              style={{
                position: 'relative',
                minHeight: 70,
                padding: '8px 10px',
                background: C.bg2,
                border: `1px solid ${C.border}`,
                borderRadius: 6,
                fontSize: 12.5,
                lineHeight: 1.6,
              }}
            >
              {aiInputChip && (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                    padding: '0 5px',
                    borderRadius: 4,
                    background: C.accentDim,
                    border: `1px solid ${C.accent}`,
                    color: C.accentHover,
                    fontSize: 11.5,
                    marginRight: 4,
                  }}
                >
                  {aiInputChip}
                </span>
              )}
              {aiInputText ? (
                <span style={{ color: C.text0 }}>{aiInputText}</span>
              ) : (
                !aiInputChip && <span style={{ color: C.text2 }}>向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器</span>
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
        <span>{sshOpen ? `SSH · ${DEMO.serverName}` : '就绪'}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: C.accent }}>
          <Icon name="bot" size={12} /> AI 助手
        </span>
      </div>

      {/* ===== 命令收藏模态框 ===== */}
      {favModalT > 0 && (
        <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * favModalT})` }}>
          <div
            style={{
              position: 'absolute',
              left: FAV_MODAL.x,
              top: FAV_MODAL.y,
              width: FAV_MODAL.w,
              background: C.bg1,
              border: `1px solid ${C.borderStrong}`,
              borderRadius: 12,
              boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
              opacity: favModalT,
              transform: `scale(${0.96 + 0.04 * favModalT})`,
            }}
          >
            <div style={{ height: 52, display: 'flex', alignItems: 'center', padding: '0 20px', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>添加命令收藏</span>
              <Icon name="x" size={14} color={C.text2} />
            </div>
            <div style={{ padding: '16px 20px 4px' }}>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 500, height: 18, marginBottom: 6 }}>
                  指令标题<span style={{ color: C.red }}> *</span>
                </div>
                <div style={{ height: 32, display: 'flex', alignItems: 'center', padding: '0 10px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5 }}>
                  {favTitle}
                </div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 500, height: 18, marginBottom: 6 }}>命令</div>
                <div style={{ minHeight: 54, padding: '6px 10px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontFamily: FONT_MONO, fontSize: 12 }}>{favCmd}</div>
              </div>
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 500, height: 18, marginBottom: 6 }}>所属目录</div>
                <div style={{ height: 32, display: 'flex', alignItems: 'center', padding: '0 10px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text2 }}>
                  可输入新分类或从下拉选择，例如：常用/部署
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
                <div style={{ width: 16, height: 16, borderRadius: 4, background: C.bg2, border: `1px solid ${C.borderStrong}` }} />
                <span style={{ fontSize: 12.5, color: C.text1 }}>全局可用（所有项目的命令收藏面板可见可用）</span>
              </div>
            </div>
            <div style={{ height: 56, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 20px', borderTop: `1px solid ${C.border}` }}>
              <div style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13 }}>取消</div>
              <div
                style={{
                  height: 32,
                  padding: '0 14px',
                  display: 'flex',
                  alignItems: 'center',
                  background: hover === 'favSave' ? C.accentHover : C.accent,
                  borderRadius: 4,
                  color: '#fff',
                  fontSize: 13,
                  transform: press === 'favSave' ? 'translateY(0.5px)' : 'none',
                }}
              >
                保存
              </div>
            </div>
          </div>
        </div>
      )}

      {/* toast */}
      {toast && (
        <div
          style={{
            position: 'absolute',
            right: 24,
            bottom: 34,
            padding: '11px 18px',
            background: C.bg2,
            border: `1px solid ${C.borderStrong}`,
            borderRadius: 8,
            fontSize: 12.5,
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
};
