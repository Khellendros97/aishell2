/**
 * 视频四工作台复刻:以当前 React 前端为准(ai/ai-engine.ts 的 AI 面板与动作卡、
 * ui.ts confirmDialog、sidebar/ServersPanel.tsx 数据库连接弹窗、ai/AiDbApproval.tsx
 * 连接审批对话框的实测布局与文案)。全部内容由 state(Wb4State)驱动,锚点见 ./layout.ts。
 * 坐标约定:消息条目绝对定位于消息区(窗口 y80 起,条目 y 为窗口坐标);
 * 菜单/弹窗为窗口层 absolute 覆盖(zIndex:菜单 40-45 < toast 46 < 模态 50 < 指针 60)。
 */
import React from 'react';
import { TopBar } from '../components/TopBar';
import { C, FONT_MONO, FONT_UI, IconName } from '../theme';
import { Icon } from '../ui';
import { WIN_H, WIN_W } from '../scene';
import {
  AGENT_BTN, AGENT_DLG, AGENT_MSG, AI_INPUT, CHAT, DBA, DBA_FIELD_REL, DBM, DBM_FIELD_REL, DBM_FORM,
  DBM_LIST, DBM_LIST_FULL, DEMO, DB_READ_CMDS, DB_WRITE_CMDS, EFFORT_SEL, ITEM_W, MODE_MENU,
  MODE_SEL, MORE_ITEMS, MORE_MENU, SIDEBAR, SnapSpec, TermLine, TERM_BASE, YOLO_BTN, YOLO_DLG,
  YOLO_MSG, ActionStatus, ChatItem, dbmClose,
} from './layout';

/* ---------- 状态 ---------- */

export type T4 =
  | 'actServers' | 'modeSel' | 'input' | 'card'
  | 'approveEdit' | 'approveDel' | 'dbAudit' | 'agree' | 'yoloOk'
  | 'more' | 'srvCard' | 'dbAdd' | 'dbName' | 'dbHost' | 'dbUser' | 'dbPwd' | 'dbDb' | 'dbSave' | 'dbClose'
  | 'dbaPwd' | 'dbaOk' | null;

export interface DbForm {
  name: string;
  host: string;
  user: string;
  pwd: string;
  database: string;
}

export interface Wb4State {
  panel: 'explorer' | 'servers';
  serverExpanded: boolean;
  mode: 'suggest' | 'agent' | 'yolo';
  modeMenu: { open: boolean; hover: number; press: number } | null;
  items: ChatItem[];
  inputText: string;
  inputCaret: boolean;
  inputFocus: boolean;
  inputChip: boolean;
  /** 粘贴到终端提示符的命令(null = 空提示符) */
  termCmd: string | null;
  /** 服务器卡「更多」菜单 */
  ctx: { hover: number; press: number } | null;
  dialog: 'agent' | 'yolo' | null;
  dialogT: number;
  dbModal: null | { view: 'list' | 'form'; saved: boolean; form: DbForm | null };
  dbModalT: number;
  /** AI 数据库连接审批弹窗 */
  dba: null | { pwd: string; focus: boolean };
  dbaT: number;
  toast: string | null;
  hover: T4;
  press: T4;
}

export const MODE_LABEL: Record<Wb4State['mode'], string> = { suggest: '仅建议', agent: '工作', yolo: '全自动' };

const ACTION_STATUS_TEXT: Record<ActionStatus, string> = {
  approving: '等待批准',
  smart: '已智能放行 · 执行中…',
  running: '执行中…',
  succeeded: '成功',
};

/* ---------- 小组件 ---------- */

const iconBtnStyle = (opts: { hovered?: boolean; pressed?: boolean }): React.CSSProperties => ({
  width: 26,
  height: 26,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 4,
  border: `1px solid ${opts.hovered ? C.accent : C.border}`,
  background: opts.hovered ? C.accentDim : C.bg1,
  color: opts.hovered ? C.accent : C.text1,
  transform: opts.pressed ? 'translateY(0.5px)' : 'none',
});

const btnSmall = (primary: boolean, hovered: boolean, pressed: boolean): React.CSSProperties => ({
  height: 24,
  padding: '0 10px',
  display: 'inline-flex',
  alignItems: 'center',
  borderRadius: 4,
  border: `1px solid ${primary ? C.accent : C.border}`,
  background: primary ? (hovered ? C.accentHover : C.accent) : hovered ? C.bg3 : C.bg2,
  color: primary ? '#fff' : C.text0,
  fontSize: 12,
  lineHeight: '16px',
  transform: pressed ? 'translateY(0.5px)' : 'none',
});

const Spinner: React.FC<{ frame: number }> = ({ frame }) => (
  <svg viewBox="0 0 24 24" width={11} height={11} style={{ opacity: frame % 20 < 10 ? 1 : 0.45 }}>
    <g fill="none" stroke={C.text2} strokeWidth={2.6} strokeLinecap="round">
      <path d="M12 3a9 9 0 1 1-9 9" opacity={0.35} />
      <path d="M12 3a9 9 0 0 1 6.4 2.6" />
    </g>
  </svg>
);

/* ---------- 活动栏 ---------- */

const ACT_ITEMS = [
  { icon: 'folder', id: 'explorer', label: '文件资源管理器' },
  { icon: 'monitor', id: 'servers', label: '服务器列表' },
  { icon: 'star', id: 'commands', label: '命令收藏' },
  { icon: 'sparkles', id: 'skills', label: 'Skill' },
  { icon: 'pencil', id: 'notes', label: '笔记' },
  { icon: 'globe', id: 'browser', label: '浏览器(在标签页中打开)' },
] as const;

const ActivityBar: React.FC<{ panel: string; hover: T4; press: T4 }> = ({ panel, hover, press }) => (
  <div style={{ width: 48, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6, gap: 2 }}>
    {ACT_ITEMS.map((it) => {
      const active = panel === it.id;
      const hovered = it.id === 'servers' && hover === 'actServers';
      const pressed = it.id === 'servers' && press === 'actServers';
      return (
        <div
          key={it.id}
          title={it.label}
          style={{
            width: 40,
            height: 40,
            flex: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '0 8px 8px 0',
            borderLeft: `2px solid ${active ? C.accent : 'transparent'}`,
            color: active ? C.accent : hovered ? C.text0 : C.text1,
            background: active || hovered ? C.bgHover : 'transparent',
            transform: pressed ? 'translateY(0.5px)' : 'none',
          }}
        >
          <Icon name={it.icon as IconName} size={18} />
        </div>
      );
    })}
    <div style={{ marginTop: 'auto', marginBottom: 6 }}>
      <div style={{ width: 26, height: 26, borderRadius: '50%', background: C.bg3, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
        <Icon name="user" size={14} />
      </div>
    </div>
  </div>
);

/* ---------- 侧栏 ---------- */

const ExplorerTree: React.FC = () => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, padding: '4px 0 8px' }}>
    {['src', 'docs', 'scripts'].map((d) => (
      <div key={d} style={{ display: 'flex', alignItems: 'center', gap: 3, height: 24, paddingRight: 6, borderRadius: 3, fontSize: 12.5, color: C.text1 }}>
        <span style={{ width: 14, flex: 'none', display: 'flex', justifyContent: 'center', color: C.text2 }}>
          <Icon name="chevronRight" size={10} />
        </span>
        <span style={{ width: 26, flex: 'none', display: 'flex', justifyContent: 'center', color: C.text2 }}>
          <Icon name="folder" size={13} />
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d}</span>
      </div>
    ))}
    {['README.md', 'app-config.yml', 'docker-compose.yml'].map((f) => (
      <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 3, height: 24, paddingRight: 6, borderRadius: 3, fontSize: 12.5, color: C.text1 }}>
        <span style={{ width: 14, flex: 'none' }} />
        <span style={{ width: 26, flex: 'none', display: 'flex', justifyContent: 'center', color: C.text2 }}>
          <Icon name="file" size={13} />
        </span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</span>
      </div>
    ))}
  </div>
);

const ServersPanel: React.FC<{ expanded: boolean; hover: T4; press: T4 }> = ({ expanded, hover, press }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, padding: '4px 8px' }}>
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
    {/* 服务器卡(可展开;展开后操作行 4 按钮,more 最右,锚点 MORE_BTN) */}
    <div
      style={{
        padding: '8px 12px',
        background: C.bg2,
        border: `1px solid ${hover === 'srvCard' || hover === 'more' ? C.borderStrong : C.border}`,
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
        <span style={{ color: C.text2, transform: expanded ? 'none' : 'rotate(-90deg)', display: 'flex' }}>
          <Icon name="chevronDown" size={14} />
        </span>
      </div>
      {expanded && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', marginLeft: 40, marginTop: 6 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 10, fontSize: 11, lineHeight: '18px', background: C.bg3, color: C.text1 }}>密码</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
            {(
              [
                { icon: 'chatPlus', title: '添加到对话', target: null },
                { icon: 'folder', title: 'SFTP 文件管理', target: null },
                { icon: 'terminal', title: 'SSH 连接', target: null },
                { icon: 'more', title: '更多操作', target: 'more' },
              ] as const
            ).map((b) => (
              <div key={b.title} title={b.title} style={iconBtnStyle({ hovered: hover === b.target, pressed: press === b.target })}>
                <Icon name={b.icon as IconName} size={13} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  </div>
);

/* ---------- 终端 ---------- */

const TermPane: React.FC<{ cmd: string | null; frame: number }> = ({ cmd, frame }) => {
  const lines: TermLine[] = [...TERM_BASE, { prompt: true, cmd: cmd ?? undefined }];
  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        background: '#0d1117',
        padding: '10px 12px',
        fontFamily: FONT_MONO,
        fontSize: 12.5,
        lineHeight: 1.7,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'flex-end',
      }}
    >
      {lines.map((l, i) => {
        const isCmd = !!(l.prompt || l.cmd);
        return (
          <div key={i} style={{ whiteSpace: 'pre', color: isCmd ? C.text0 : C.text1 }}>
            {isCmd && <span style={{ color: C.green }}>$ </span>}
            {l.cmd || l.text || ' '}
            {l.prompt && (
              <span
                style={{
                  display: 'inline-block',
                  width: 7,
                  height: 14,
                  background: C.text1,
                  verticalAlign: '-2px',
                  marginLeft: 2,
                  opacity: frame % 32 < 16 ? 1 : 0,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};

/* ---------- 聊天条目 ---------- */

const SnapCard: React.FC<{ snap: SnapSpec }> = ({ snap }) => (
  <div style={{ marginTop: 6, padding: '6px 8px', background: '#0d1117', border: `1px solid ${C.border}`, borderRadius: 6 }}>
    <div style={{ fontSize: 10.5, color: C.text2, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
      <Icon name="terminal" size={11} />
      {snap.label}
    </div>
    {snap.lines.map((l, i) => (
      <div key={i} style={{ fontFamily: FONT_MONO, fontSize: 11, lineHeight: '16px', whiteSpace: 'pre', color: C.text1 }}>
        {l.segs.map((s, j) => (
          <span key={j} style={s.mask ? { color: C.red, fontWeight: 700 } : undefined}>{s.t}</span>
        ))}
      </div>
    ))}
  </div>
);

const UserBubble: React.FC<{ item: ChatItem }> = ({ item }) =>
  item.kind !== 'user' ? null : (
    <div style={{ position: 'absolute', left: CHAT.l - 1580, top: item.y - 80, width: CHAT.w, display: 'flex', justifyContent: 'flex-end' }}>
      <div
        style={{
          maxWidth: ITEM_W,
          padding: '8px 11px',
          borderRadius: 10,
          borderBottomRightRadius: 3,
          background: C.accentDim,
          fontSize: 12.5,
          lineHeight: '20px',
        }}
      >
        {item.chip && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '0 5px',
              borderRadius: 4,
              background: 'rgba(79,142,247,0.28)',
              border: `1px solid ${C.accent}`,
              color: C.accentHover,
              fontSize: 11.5,
              marginRight: 4,
              verticalAlign: 'baseline',
            }}
          >
            {item.chip}
          </span>
        )}
        {item.lines.map((l, i) => (
          <span key={i}>
            {l}
            {i < item.lines.length - 1 && <br />}
          </span>
        ))}
      </div>
    </div>
  );

const AiBubble: React.FC<{ item: ChatItem; frame: number; hover: T4 }> = ({ item, frame, hover }) =>
  item.kind !== 'ai' ? null : (
    <div style={{ position: 'absolute', left: CHAT.l - 1580, top: item.y - 80, width: ITEM_W }}>
      <div
        style={{
          maxWidth: ITEM_W,
          padding: '8px 11px',
          borderRadius: 10,
          borderBottomLeftRadius: 3,
          background: C.bg2,
          fontSize: 12.5,
          lineHeight: '20px',
        }}
      >
        {item.tool && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: C.text2, marginBottom: 3, fontFamily: FONT_MONO, whiteSpace: 'nowrap', overflow: 'hidden' }}>
            <Icon name="wrench" size={11} />
            {item.tool}
          </div>
        )}
        {item.snap && <SnapCard snap={item.snap} />}
        {item.typing ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20 }}>
            {[0, 1, 2].map((i) => {
              const up = (frame * 2 + i * 8) % 48 < 24;
              return (
                <span
                  key={i}
                  style={{ width: 5, height: 5, borderRadius: '50%', background: C.text2, opacity: up ? 1 : 0.25, transform: up ? 'translateY(-2px)' : 'none' }}
                />
              );
            })}
          </span>
        ) : (
          item.lines.map((l, i) => (
            <span key={i}>
              {l}
              {i < item.lines.length - 1 && <br />}
            </span>
          ))
        )}
        {item.card && (
          <div
            style={{
              marginTop: 6,
              padding: '8px 10px',
              background: hover === 'card' ? C.bg3 : C.bg1,
              border: `1px solid ${hover === 'card' ? C.accent : C.border}`,
              borderLeft: `3px solid ${C.green}`,
              borderRadius: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Icon name="terminal" size={13} color={C.green} />
              <span style={{ fontSize: 11, color: C.text2 }}>点击卡片粘贴到终端</span>
            </div>
            <code style={{ fontFamily: FONT_MONO, fontSize: 11.5, color: C.green, whiteSpace: 'pre-wrap' }}>{item.card.cmd}</code>
          </div>
        )}
      </div>
    </div>
  );

const STATUS_COLOR: Record<ActionStatus, string> = {
  approving: C.text2,
  smart: C.text2,
  running: C.text2,
  succeeded: C.green,
};

const ActionCard: React.FC<{ item: ChatItem; hover: T4; press: T4; frame: number }> = ({ item, hover, press, frame }) => {
  if (item.kind !== 'action') return null;
  const { status, spec } = item;
  const hoveredBtn =
    (spec.btn === 'approve' && (hover === 'approveEdit' || hover === 'approveDel')) ||
    (spec.btn === 'audit' && hover === 'dbAudit');
  const pressedBtn =
    (spec.btn === 'approve' && (press === 'approveEdit' || press === 'approveDel')) ||
    (spec.btn === 'audit' && press === 'dbAudit');
  return (
    <div
      style={{
        position: 'absolute',
        left: CHAT.l - 1580,
        top: item.y - 80,
        width: ITEM_W,
        boxSizing: 'border-box',
        padding: '8px 10px',
        background: C.bg2,
        border: `1px solid ${C.border}`,
        borderLeft: status === 'succeeded' ? `3px solid ${C.green}` : `1px solid ${C.border}`,
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, height: 20 }}>
        <span style={{ fontWeight: 600, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          <Icon name={spec.icon} size={13} />
          {spec.name}
        </span>
        <span style={{ fontSize: 11, color: STATUS_COLOR[status], display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
          {(status === 'running' || status === 'smart') && <Spinner frame={frame} />}
          {ACTION_STATUS_TEXT[status]}
        </span>
      </div>
      {spec.intent && <div style={{ fontSize: 12, lineHeight: '18px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{spec.intent}</div>}
      {spec.bold && (
        <div style={{ fontSize: 12, lineHeight: '18px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {spec.bold.split(DEMO.dbName)[0]}
          <b style={{ color: C.text0 }}>{DEMO.dbName}</b>
          {spec.bold.split(DEMO.dbName)[1]}
        </div>
      )}
      {spec.cmd && (
        <code
          style={{
            display: 'block',
            boxSizing: 'border-box',
            height: 24,
            lineHeight: '16px',
            padding: '3px 8px',
            background: '#14161b',
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            fontFamily: FONT_MONO,
            fontSize: 11.5,
            color: C.text0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {spec.cmd}
        </code>
      )}
      {spec.meta && <div style={{ fontSize: 12, lineHeight: '18px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{spec.meta}</div>}
      {spec.reason && <div style={{ fontSize: 12, lineHeight: '18px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{spec.reason}</div>}
      {spec.smart && (
        <div style={{ fontSize: 12, lineHeight: '18px', color: status === 'approving' ? C.yellow : C.green, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{spec.smart}</div>
      )}
      {status === 'approving' && spec.btn && (
        <div style={{ display: 'flex', gap: 6, height: 26, alignItems: 'center' }}>
          {spec.btn === 'approve' ? (
            <>
              <span style={btnSmall(true, hoveredBtn, pressedBtn)}>批准</span>
              <span style={btnSmall(false, false, false)}>拒绝</span>
            </>
          ) : (
            <span style={btnSmall(true, hoveredBtn, pressedBtn)}>审批</span>
          )}
        </div>
      )}
      {status === 'succeeded' && spec.result && (
        <div
          style={{
            boxSizing: 'border-box',
            height: 28,
            padding: '4px 8px',
            background: '#14161b',
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            fontSize: 12,
            lineHeight: '20px',
            color: C.text1,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {spec.result}
        </div>
      )}
    </div>
  );
};

/* ---------- 确认对话框(confirmDialog 样式,400 宽) ---------- */

const ConfirmDialog: React.FC<{ kind: 'agent' | 'yolo'; t: number }> = ({ kind, t }) => {
  const dlg = kind === 'agent' ? AGENT_DLG : YOLO_DLG;
  const msg = kind === 'agent' ? AGENT_MSG : YOLO_MSG;
  const top = 600 - dlg.h / 2;
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute',
          left: 760,
          top,
          width: 400,
          height: dlg.h,
          boxSizing: 'border-box',
          background: C.bg1,
          border: `1px solid ${C.borderStrong}`,
          borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
          opacity: t,
          transform: `translateY(${8 - 8 * t}px)`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{kind === 'agent' ? 'AI 申请切换到工作模式' : '开启全自动模式'}</span>
          <Icon name="x" size={14} color={C.text2} />
        </div>
        <div style={{ flex: 1, padding: '18px', color: C.text1, fontSize: 12.5, lineHeight: '20px', overflow: 'hidden' }}>
          {msg.map((l, i) => (
            <div key={i} style={{ height: l === '' ? 10 : 20, whiteSpace: 'nowrap' }}>{l === '' ? '' : l}</div>
          ))}
        </div>
        <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', borderTop: `1px solid ${C.border}` }}>
          <div style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13 }}>取消</div>
          <div
            style={{
              height: 32,
              padding: '0 14px',
              display: 'flex',
              alignItems: 'center',
              borderRadius: 4,
              fontSize: 13,
              color: '#fff',
              background: dlg.danger ? C.red : C.accent,
            }}
          >
            {dlg.okText}
          </div>
          <span style={{ display: 'none' }}>{`${AGENT_BTN.ok.x},${YOLO_BTN.ok.x}`}</span>
        </div>
      </div>
    </div>
  );
};

/* ---------- 命令勾选区(db-cmds,高 142) ---------- */

const CmdGroups: React.FC = () => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      border: `1px solid ${C.border}`,
      borderRadius: 6,
      padding: '10px 12px',
      background: C.bg2,
      boxSizing: 'border-box',
      height: 142,
      overflow: 'hidden',
    }}
  >
    {[
      { title: '只读命令（AI 可直接执行）', cmds: DB_READ_CMDS, write: false },
      { title: '写命令（勾选后 AI 执行前需人工审批）', cmds: DB_WRITE_CMDS, write: true },
    ].map((g) => (
      <div key={g.title}>
        <div style={{ fontSize: 11.5, color: C.text1, marginBottom: 6, whiteSpace: 'nowrap' }}>{g.title}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px' }}>
          {g.cmds.map((c) => (
            <label key={c} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: C.text1, whiteSpace: 'nowrap' }}>
              <span
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  border: `1px solid ${g.write ? C.borderStrong : C.accent}`,
                  background: g.write ? 'transparent' : C.accent,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flex: 'none',
                }}
              >
                {!g.write && (
                  <svg viewBox="0 0 24 24" width={9} height={9}>
                    <path d="m5 12 5 5 9-10" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              {c}
            </label>
          ))}
        </div>
      </div>
    ))}
  </div>
);

/* ---------- 表单字段(绝对定位于 modal body,label 17 + gap 5 + input 34) ---------- */

const Field: React.FC<{
  label: string;
  value: string;
  x: number; // 相对 body 盒左
  y: number; // 相对 body 盒顶
  w: number;
  mono?: boolean;
  disabled?: boolean;
  focus?: boolean;
  caret?: boolean;
}> = ({ label, value, x, y, w, mono, disabled, focus, caret }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: 56 }}>
    <div style={{ fontSize: 12, color: C.text1, height: 17, lineHeight: '17px', whiteSpace: 'nowrap' }}>{label}</div>
    <div
      style={{
        marginTop: 5,
        height: 34,
        display: 'flex',
        alignItems: 'center',
        padding: '0 10px',
        background: C.bg2,
        border: `1px solid ${focus ? C.accent : C.border}`,
        borderRadius: 4,
        fontSize: 13,
        fontFamily: mono ? FONT_MONO : FONT_UI,
        color: C.text0,
        opacity: disabled ? 0.75 : 1,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      {value || (disabled ? '' : <span style={{ color: C.text2 }} />)}
      {caret && <span style={{ display: 'inline-block', width: 1.5, height: 14, background: C.text0, marginLeft: 1 }} />}
    </div>
  </div>
);

/* ---------- 数据库连接弹窗 ---------- */

const DbModal: React.FC<{ st: Wb4State }> = ({ st }) => {
  if (!st.dbModal) return null;
  const { view, saved, form } = st.dbModal;
  const t = st.dbModalT;
  const geom = view === 'list' ? (saved ? DBM_LIST_FULL : DBM_LIST) : DBM_FORM;
  const close = dbmClose(geom);
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.55 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute',
          left: DBM.x,
          top: geom.y,
          width: DBM.w,
          height: geom.h,
          boxSizing: 'border-box',
          background: C.bg1,
          border: `1px solid ${C.borderStrong}`,
          borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
          opacity: t,
          transform: `translateY(${8 - 8 * t}px)`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>
            {view === 'list' ? `数据库连接 · ${DEMO.serverName}` : `新增数据库连接 · ${DEMO.serverName}`}
          </span>
          <span
            title="关闭"
            style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1, background: st.hover === 'dbClose' ? C.bgHover : 'transparent', borderRadius: 4 }}
          >
            <Icon name="x" size={14} />
          </span>
        </div>
        <div style={{ flex: 1, padding: 18, position: 'relative' }}>
          {view === 'list' ? (
            saved ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', border: `1px solid ${C.border}`, borderRadius: 8 }}>
                <span style={{ color: C.text2, flex: 'none', display: 'flex' }}>
                  <Icon name="database" size={16} />
                </span>
                <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{DEMO.dbConnName}</span>
                  <span style={{ fontSize: 11.5, color: C.text2, fontFamily: FONT_MONO }}>MySQL · {DEMO.serverHost}:3306 · db={DEMO.dbName}</span>
                  <span style={{ fontSize: 11, color: C.text2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    允许命令：{DB_READ_CMDS.join(' / ')}
                  </span>
                </span>
                <span style={{ position: 'relative', width: 30, height: 17, flex: 'none' }}>
                  <span style={{ position: 'absolute', inset: 0, background: 'rgba(79,142,247,0.25)', border: `1px solid ${C.accent}`, borderRadius: 9 }} />
                  <span style={{ position: 'absolute', left: 14, top: 1, width: 13, height: 13, borderRadius: '50%', background: C.accent }} />
                </span>
                <span style={{ display: 'flex', gap: 6, flex: 'none', color: C.text1 }}>
                  <Icon name="pencil" size={14} />
                  <Icon name="trash" size={14} />
                </span>
              </div>
            ) : (
              <div style={{ color: C.text2, fontSize: 12.5, padding: '12px 4px', lineHeight: 1.55 }}>
                尚未配置数据库连接。AI 将无法通过 db_query 查询；
                <br />
                密码保存在系统凭据库，AI 不可见。
              </div>
            )
          ) : (
            form && (
              <>
                <Field label="类型" value="MySQL" disabled x={18} y={DBM_FIELD_REL.r1} w={276} />
                <Field label="名称" value={form.name} x={306} y={DBM_FIELD_REL.r1} w={276} focus={st.hover === 'dbName'} caret={st.hover === 'dbName'} />
                <Field label="主机" value={form.host} mono x={18} y={DBM_FIELD_REL.r2} w={276} focus={st.hover === 'dbHost'} caret={st.hover === 'dbHost'} />
                <Field label="端口" value="3306" mono disabled x={306} y={DBM_FIELD_REL.r2} w={276} />
                <Field label="用户名" value={form.user} mono x={18} y={DBM_FIELD_REL.r3} w={276} focus={st.hover === 'dbUser'} caret={st.hover === 'dbUser'} />
                <Field label="密码" value={form.pwd} mono x={306} y={DBM_FIELD_REL.r3} w={276} focus={st.hover === 'dbPwd'} caret={st.hover === 'dbPwd'} />
                <Field label="默认库" value={form.database} mono x={18} y={DBM_FIELD_REL.r4} w={276} focus={st.hover === 'dbDb'} caret={st.hover === 'dbDb'} />
                <div style={{ position: 'absolute', left: 18, top: DBM_FIELD_REL.cmds, width: 564 }}>
                  <div style={{ fontSize: 12, color: C.text1, height: 17, lineHeight: '17px', marginBottom: 5 }}>AI 可用命令</div>
                  <CmdGroups />
                </div>
              </>
            )
          )}
        </div>
        <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', borderTop: `1px solid ${C.border}` }}>
          {view === 'list' ? (
            <div
              style={{
                height: 32,
                padding: '0 14px',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                background: st.hover === 'dbAdd' ? C.accentHover : C.accent,
                borderRadius: 4,
                color: '#fff',
                fontSize: 13,
              }}
            >
              <Icon name="plus" size={13} /> 新增连接
            </div>
          ) : (
            <div
              style={{
                height: 32,
                padding: '0 14px',
                display: 'flex',
                alignItems: 'center',
                background: st.hover === 'dbSave' ? C.accentHover : C.accent,
                borderRadius: 4,
                color: '#fff',
                fontSize: 13,
              }}
            >
              保存
            </div>
          )}
          <span style={{ display: 'none' }}>{`${close.x},${close.y}`}</span>
        </div>
      </div>
    </div>
  );
};

/* ---------- AI 数据库连接审批对话框(AiDbApproval,540 宽) ---------- */

const DbApprovalModal: React.FC<{ st: Wb4State }> = ({ st }) => {
  if (!st.dba) return null;
  const t = st.dbaT;
  const W = 246; // 双列列宽(内容宽 504,gap 12)
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.55 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute',
          left: DBA.x,
          top: DBA.y,
          width: DBA.w,
          height: DBA.h,
          boxSizing: 'border-box',
          background: C.bg1,
          border: `1px solid ${C.borderStrong}`,
          borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)',
          opacity: t,
          transform: `translateY(${8 - 8 * t}px)`,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>数据库连接审批</span>
          <Icon name="x" size={14} color={C.text2} />
        </div>
        <div style={{ flex: 1, padding: 18, position: 'relative' }}>
          <div style={{ position: 'absolute', left: 18, top: DBA_FIELD_REL.tip, height: 22, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: C.text0, whiteSpace: 'nowrap' }}>
            <Icon name="database" size={14} color={C.accent} />
            <span>
              AI 助手想要申请连接数据库 <b>{DEMO.dbName}</b> 的权限
            </span>
          </div>
          <Field label="类型" value="MySQL" disabled x={18} y={DBA_FIELD_REL.r1} w={W} />
          <Field label="连接名称" value={DEMO.dbConnName} disabled x={276} y={DBA_FIELD_REL.r1} w={W} />
          <Field label="主机" value={DEMO.serverHost} mono disabled x={18} y={DBA_FIELD_REL.r2} w={W} />
          <Field label="端口" value="3306" mono disabled x={276} y={DBA_FIELD_REL.r2} w={W} />
          <Field label="用户名" value={DEMO.dbUser} mono disabled x={18} y={DBA_FIELD_REL.r3} w={W} />
          <Field label="默认库" value={DEMO.dbName} mono disabled x={276} y={DBA_FIELD_REL.r3} w={W} />
          <Field label="目标服务器" value={`${DEMO.serverName}（${DEMO.serverId}）`} disabled x={18} y={DBA_FIELD_REL.r4} w={504} />
          <div style={{ position: 'absolute', left: 18, top: DBA_FIELD_REL.pwd, width: 504, height: 56 }}>
            <div style={{ fontSize: 12, color: C.text1, height: 17, lineHeight: '17px' }}>
              密码<span style={{ color: C.red, marginLeft: 2 }}>*</span>
            </div>
            <div
              style={{
                marginTop: 5,
                height: 34,
                display: 'flex',
                alignItems: 'center',
                padding: '0 10px',
                background: C.bg2,
                border: `1px solid ${st.dba.focus || st.hover === 'dbaPwd' ? C.accent : C.border}`,
                borderRadius: 4,
                fontSize: 13,
                fontFamily: FONT_MONO,
                color: C.text0,
              }}
            >
              {st.dba.pwd}
              {st.dba.focus && <span style={{ display: 'inline-block', width: 1.5, height: 14, background: C.text0, marginLeft: 1 }} />}
            </div>
          </div>
          <div style={{ position: 'absolute', left: 18, top: DBA_FIELD_REL.perms, width: 504 }}>
            <div style={{ fontSize: 12, color: C.text1, height: 17, lineHeight: '17px', marginBottom: 5 }}>查询权限</div>
            <CmdGroups />
            <div style={{ fontSize: 11.5, color: C.text2, marginTop: 8, whiteSpace: 'nowrap' }}>
              只读命令 AI 可直接执行；勾选写命令后，AI 执行前需人工审批。
            </div>
          </div>
        </div>
        <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', borderTop: `1px solid ${C.border}` }}>
          <div style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13 }}>拒绝</div>
          <div
            style={{
              height: 32,
              padding: '0 14px',
              display: 'flex',
              alignItems: 'center',
              background: st.hover === 'dbaOk' ? C.accentHover : C.accent,
              borderRadius: 4,
              color: '#fff',
              fontSize: 13,
              opacity: st.dba.pwd ? 1 : 0.55,
            }}
          >
            通过
          </div>
        </div>
      </div>
    </div>
  );
};

/* ---------- AI 面板 ---------- */

const ModeMenu: React.FC<{ st: Wb4State }> = ({ st }) => {
  if (!st.modeMenu?.open) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: MODE_MENU.x,
        top: MODE_MENU.y,
        width: MODE_MENU.w,
        padding: MODE_MENU.pad,
        background: C.bg2,
        border: `1px solid ${C.borderStrong}`,
        borderRadius: 6,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 45,
      }}
    >
      {(['suggest', 'agent', 'yolo'] as const).map((m, i) => {
        const current = st.mode === m;
        return (
          <div
            key={m}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: MODE_MENU.itemH,
              padding: '0 10px',
              borderRadius: 4,
              fontSize: 12.5,
              color: st.modeMenu!.hover === i ? C.text0 : C.text1,
              background: st.modeMenu!.hover === i ? C.bgHover : current ? C.accentDim : 'transparent',
              fontWeight: current ? 600 : 400,
            }}
          >
            {MODE_LABEL[m]}
            {current && <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.accent }} />}
          </div>
        );
      })}
    </div>
  );
};

const AiPanel: React.FC<{ st: Wb4State; frame: number }> = ({ st, frame }) => (
  <div style={{ width: 340, flex: 'none', background: C.bg1, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
    {/* 会话头 40..80 */}
    <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: 1, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '0 8px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12 }}>
        新会话
        <Icon name="chevronDown" size={12} color={C.text2} />
      </div>
      <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
        <Icon name="plus" size={14} />
      </div>
    </div>
    {/* 消息区 80..1026(条目绝对定位) */}
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
      {st.items.map((item) =>
        item.kind === 'user' ? (
          <UserBubble key={item.id} item={item} />
        ) : item.kind === 'ai' ? (
          <AiBubble key={item.id} item={item} frame={frame} hover={st.hover} />
        ) : (
          <ActionCard key={item.id} item={item} hover={st.hover} press={st.press} frame={frame} />
        ),
      )}
    </div>
    {/* 输入区 1026..1174 */}
    <div style={{ flex: 'none', height: 148, boxSizing: 'border-box', borderTop: `1px solid ${C.border}`, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 0', fontSize: 11, color: C.text2, flex: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="bot" size={12} /> AI 模式
        </span>
        <div
          style={{
            width: MODE_SEL.w,
            height: MODE_SEL.h,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 6px',
            background: C.bg2,
            border: `1px solid ${st.hover === 'modeSel' || st.modeMenu?.open ? C.accent : C.border}`,
            borderRadius: 4,
            color: C.text0,
            fontSize: 12,
            boxSizing: 'border-box',
            flex: 'none',
          }}
        >
          {MODE_LABEL[st.mode]}
          <Icon name="chevronDown" size={10} color={C.text2} />
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="zap" size={12} /> 思考强度
        </span>
        <div
          style={{
            width: EFFORT_SEL.w,
            height: EFFORT_SEL.h,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 6px',
            background: C.bg2,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            color: C.text0,
            fontSize: 12,
            boxSizing: 'border-box',
            flex: 'none',
          }}
        >
          低
          <Icon name="chevronDown" size={10} color={C.text2} />
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 10, fontSize: 11, lineHeight: '18px', background: C.accentDim, color: C.accentHover }}>
          <Icon name="monitor" size={11} />
          @local
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          flex: 1,
          minHeight: 0,
          padding: '8px 10px',
          background: C.bg2,
          border: `1px solid ${st.inputFocus ? C.accent : C.border}`,
          borderRadius: 6,
          fontSize: 12.5,
          lineHeight: '20px',
        }}
      >
        {st.inputText || st.inputChip ? (
          <span style={{ color: C.text0, wordBreak: 'break-all' }}>
            {st.inputChip && (
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
                  verticalAlign: 'baseline',
                }}
              >
                @term:t1
              </span>
            )}
            {st.inputText}
            {st.inputCaret && <span style={{ display: 'inline-block', width: 1.5, height: 14, background: C.accent, verticalAlign: '-2px', marginLeft: 1 }} />}
          </span>
        ) : (
          <span style={{ color: C.text2 }}>向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器</span>
        )}
        <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10.5, color: C.text2 }}>Enter 发送</span>
      </div>
    </div>
  </div>
);

/* ---------- 更多菜单 / Toast / 状态栏 ---------- */

const MoreMenu: React.FC<{ st: Wb4State }> = ({ st }) => {
  if (!st.ctx) return null;
  return (
    <div
      style={{
        position: 'absolute',
        left: MORE_MENU.x,
        top: MORE_MENU.y,
        width: MORE_MENU.w,
        padding: MORE_MENU.pad,
        background: C.bg2,
        border: `1px solid ${C.borderStrong}`,
        borderRadius: 8,
        boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 40,
      }}
    >
      {MORE_ITEMS.map((it, i) => (
        <div
          key={it.label}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            height: MORE_MENU.itemH,
            padding: '0 10px',
            borderRadius: 4,
            fontSize: 12.5,
            color: C.text0,
            background: st.ctx!.hover === i ? C.bgHover : 'transparent',
          }}
        >
          <span style={{ display: 'flex', width: 15, justifyContent: 'center', color: C.text1 }}>
            <Icon name={it.icon as IconName} size={14} />
          </span>
          {it.label}
        </div>
      ))}
    </div>
  );
};

const Statusbar: React.FC = () => (
  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 26, display: 'flex', alignItems: 'center', padding: '0 8px', background: C.bg1, borderTop: `1px solid ${C.border}`, color: C.text1, fontSize: 11 }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 12 }}>
      <Icon name="folder" size={12} />
      {DEMO.projectName}
    </span>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.text2 }}>
      <Icon name="terminal" size={12} />
      本地终端
    </span>
    <div style={{ flex: 1 }} />
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 4, background: C.accentDim, color: C.accent }}>
      <Icon name="bot" size={12} /> AI 助手
    </span>
  </div>
);

/* ---------- 主组件 ---------- */

export const Wb4: React.FC<{ state: Wb4State; frame: number }> = ({ state, frame }) => (
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
      <ActivityBar panel={state.panel} hover={state.hover} press={state.press} />

      {/* 侧栏 */}
      <div style={{ position: 'relative', width: SIDEBAR.w, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: SIDEBAR.headH, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px 0 14px', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: C.text1 }}>
          {state.panel === 'explorer' ? '文件资源管理器' : '服务器列表'}
          {state.panel === 'explorer' && (
            <span style={{ display: 'flex', gap: 2 }}>
              {(['filePlus', 'folderPlus', 'refresh'] as IconName[]).map((n) => (
                <span key={n} style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
                  <Icon name={n} size={13} />
                </span>
              ))}
            </span>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          {state.panel === 'explorer' ? <ExplorerTree /> : <ServersPanel expanded={state.serverExpanded} hover={state.hover} press={state.press} />}
        </div>
      </div>

      {/* 中央:标签 + 终端 */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg0 }}>
        <div style={{ height: 36, flex: 'none', display: 'flex', alignItems: 'stretch', background: C.bg1, borderBottom: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '0 8px 0 12px',
              width: 152,
              flex: 'none',
              borderRight: `1px solid ${C.border}`,
              borderTop: `2px solid ${C.accent}`,
              background: C.bg0,
              fontSize: 12.5,
              color: C.text0,
            }}
          >
            <span style={{ display: 'flex', flex: 'none' }}>
              <Icon name="terminal" size={15} />
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>本地终端</span>
            <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2, borderRadius: 3, flex: 'none' }}>
              <Icon name="x" size={11} />
            </span>
          </div>
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <TermPane cmd={state.termCmd} frame={frame} />
        </div>
      </div>

      <AiPanel st={state} frame={frame} />
    </div>

    <Statusbar />

    {/* 覆盖层:菜单 40/45 < toast 46 < 模态 50 < 指针(总装层 60) */}
    <ModeMenu st={state} />
    <MoreMenu st={state} />
    {state.toast && (
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
          whiteSpace: 'nowrap',
          zIndex: 46,
        }}
      >
        {state.toast}
      </div>
    )}
    {state.dialog && <ConfirmDialog kind={state.dialog} t={state.dialogT} />}
    {state.dbModal && <DbModal st={state} />}
    {state.dba && <DbApprovalModal st={state} />}
  </div>
);

/* AI_INPUT 供 script.ts 引用;此处引用防止 layout 导出被 tree-shaking 误删(编译期检查) */
void AI_INPUT;
