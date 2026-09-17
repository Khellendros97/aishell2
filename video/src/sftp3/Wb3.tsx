/**
 * 视频三工作台复刻:以当前 React 前端为准(Workbench.tsx / SftpTab.tsx / EditorTab.tsx /
 * ExplorerPanel.tsx / ServersPanel.tsx 的实测布局与文案),复刻文件资源管理器、SFTP 面板、
 * 文档编辑器与右键菜单。全部内容由 state(Wb3State)驱动,锚点见 ./layout.ts。
 * 坐标约定:SFTP 工具栏/网格内的 absolute 定位均相对面板原点(设计稿 x308/y76 或 x320/y129),
 * 已在渲染处换算。
 */
import React from 'react';
import { TopBar } from '../components/TopBar';
import { C, FONT_MONO, FONT_UI, ICONS, IconName } from '../theme';
import { Icon } from '../ui';
import { WIN_H, WIN_W } from '../scene';
import {
  ACT, AI, CENTER, DEMO, ED, EntryDef, FAV_MODAL, MENU, MENU_ICONS, SF, SIDEBAR,
  fmtSize, fmtTime, gridColX, gridCols, gridRowY, sortedEntries, tableGeom,
} from './layout';

/* ---------- 状态 ---------- */

export interface SftpEntry extends EntryDef {}

export type TokKind = 'plain' | 'key' | 'str' | 'num' | 'comment' | 'head' | 'atom';
export type Tok = [TokKind, string];

export interface EditorDoc {
  title: string;
  remote: boolean;
  tokens: Tok[][];
  dirty: boolean;
  /** 选区:第 line 行第 col 列起 len 个字符 */
  sel: { line: number; col: number; len: number } | null;
  /** 光标:第 line 行第 col 列(块状) */
  caret: { line: number; col: number } | null;
}

export interface Wb3Tab {
  id: string;
  kind: 'terminal' | 'sftp' | 'editor';
  title: string;
  icon: IconName;
  dirty?: boolean;
}

export interface CtxState {
  x: number;
  y: number;
  items: readonly (string | 'sep')[];
  hover: number;
  press: number;
}

export type Wb3Target =
  | 'actExplorer'
  | 'actServers'
  | 'card'
  | 'sftpBtn'
  | 'tabSftp'
  | 'sfStar'
  | 'sfFavBtn'
  | 'sfSearchBtn'
  | 'sfListBtn'
  | 'sortTh'
  | 'favItem'
  | null;

export interface Wb3State {
  panel: 'explorer' | 'servers';
  serverExpanded: boolean;
  tabs: Wb3Tab[];
  activeId: string;
  termCaret: boolean;
  /** SFTP 面板状态;标签未打开时为 null */
  sftp: {
    cwd: string;
    entries: SftpEntry[];
    loading: boolean;
    sel: string | null;
    view: 'grid' | 'list';
    sortKey: 'name' | 'mtime';
    sortAsc: boolean;
    searchOpen: boolean;
    query: string;
    favOpen: boolean;
    favorites: { title: string; path: string }[];
    starActive: boolean;
  } | null;
  /** 编辑器文档,按 tab id 索引 */
  editors: Record<string, EditorDoc>;
  favModalT: number;
  ctx: CtxState | null;
  /** 本地树文件行(目录行固定 src/docs/scripts) */
  treeFiles: string[];
  /** 下载/导入落地高亮的文件名(2.5s) */
  treeHighlight: string | null;
  /** 拖拽落点反馈:树可放 / SFTP 可放 / SFTP 拒收 */
  dropZone: 'tree' | 'sftp-ok' | 'sftp-no' | null;
  toast: string | null;
  progress: { label: string; detail: string } | null;
  /** 拖拽幽灵(渲染于总装层,位置跟随指针) */
  ghost: { name: string; reject: boolean; fade: number } | null;
  hover: Wb3Target;
  press: Wb3Target;
}

/* ---------- 小组件 ---------- */

const iconBtnStyle = (opts: { active?: boolean; hovered?: boolean; pressed?: boolean }): React.CSSProperties => ({
  width: 28,
  height: 28,
  flex: 'none',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 4,
  border: `1px solid ${opts.hovered ? C.borderStrong : 'transparent'}`,
  background: opts.active ? C.accentDim : opts.hovered ? C.bg3 : 'transparent',
  color: opts.active ? C.accent : C.text1,
  transform: opts.pressed ? 'translateY(0.5px)' : 'none',
});

/** SFTP 条目图标(目录蓝 / 压缩包橙 / 文件灰,与 entryIcon 配色一致,带填充) */
export const EntryIcon: React.FC<{ kind: 'dir' | 'file' | 'archive'; size?: number }> = ({ kind, size = 30 }) => {
  const color = kind === 'dir' ? ['#2563eb', '#93c5fd'] : kind === 'archive' ? ['#c2410c', '#fdba74'] : ['#64748b', '#e2e8f0'];
  const path = kind === 'dir' ? ICONS.folder : kind === 'archive' ? ICONS.archive : ICONS.file;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} style={{ display: 'block', flex: 'none' }}>
      <g dangerouslySetInnerHTML={{ __html: path }} fill={color[1]} stroke={color[0]} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

const entryKind = (e: EntryDef): 'dir' | 'file' | 'archive' => {
  if (e.isDir) return 'dir';
  const n = e.name.toLowerCase();
  return n.endsWith('.tar.gz') || n.endsWith('.tgz') || n.endsWith('.zip') ? 'archive' : 'file';
};

const RejectBadge: React.FC = () => (
  <svg viewBox="0 0 24 24" width={16} height={16} style={{ display: 'block', flex: 'none' }}>
    <circle cx="12" cy="12" r="9" fill="none" stroke={C.red} strokeWidth={2} />
    <path d="M5.8 5.8 18.2 18.2" stroke={C.red} strokeWidth={2} strokeLinecap="round" />
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

const ActivityBar: React.FC<{ panel: string; hover: Wb3Target; press: Wb3Target }> = ({ panel, hover, press }) => (
  <div style={{ width: 48, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6, gap: 2 }}>
    {ACT_ITEMS.map((it) => {
      const active = panel === it.id;
      const hovered = (it.id === 'servers' && hover === 'actServers') || (it.id === 'explorer' && hover === 'actExplorer');
      const pressed = (it.id === 'servers' && press === 'actServers') || (it.id === 'explorer' && press === 'actExplorer');
      return (
        <div
          key={it.id}
          title={it.label}
          data-anchor={it.id === 'servers' ? 'w3-act-servers' : it.id === 'explorer' ? 'w3-act-explorer' : undefined}
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

/* ---------- 侧栏:文件资源管理器 ---------- */

const ExplorerTree: React.FC<{ files: string[]; highlight: string | null; dropZone: Wb3State['dropZone'] }> = ({ files, highlight, dropZone }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      right: 0,
      top: 0,
      bottom: 0,
      padding: '4px 0 8px',
      outline: dropZone === 'tree' ? `1.5px dashed ${C.accent}` : 'none',
      outlineOffset: -2,
      background: dropZone === 'tree' ? C.accentDim : 'transparent',
    }}
  >
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
    {files.map((f) => {
      const hl = highlight === f;
      return (
        <div
          key={f}
          data-anchor={`w3-tree-${f}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 3,
            height: 24,
            paddingRight: 6,
            borderRadius: 3,
            fontSize: 12.5,
            color: hl ? C.text0 : C.text1,
            background: hl ? C.accentDim : 'transparent',
            outline: hl ? `1px solid ${C.accent}` : 'none',
            outlineOffset: -1,
          }}
        >
          <span style={{ width: 14, flex: 'none' }} />
          <span style={{ width: 26, flex: 'none', display: 'flex', justifyContent: 'center', color: C.text2 }}>
            <Icon name="file" size={13} />
          </span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f}</span>
        </div>
      );
    })}
  </div>
);

/* ---------- 侧栏:服务器列表 ---------- */

const ServersPanel: React.FC<{ expanded: boolean; hover: Wb3Target; press: Wb3Target }> = ({ expanded, hover, press }) => (
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
    {/* 服务器卡(可展开) */}
    <div
      data-anchor="w3-card"
      style={{
        padding: '8px 12px',
        background: C.bg2,
        border: `1px solid ${hover === 'sftpBtn' || hover === 'card' ? C.borderStrong : C.border}`,
        borderRadius: 8,
        cursor: 'pointer',
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
                { icon: 'folder', title: 'SFTP 文件管理', target: 'sftpBtn' as const },
                { icon: 'terminal', title: 'SSH 连接', target: null },
                { icon: 'more', title: '更多操作', target: null },
              ] as const
            ).map((b) => {
              const h = b.target === 'sftpBtn' && hover === 'sftpBtn';
              const p = b.target === 'sftpBtn' && press === 'sftpBtn';
              return (
                <div
                  key={b.title}
                  title={b.title}
                  data-anchor={b.target === 'sftpBtn' ? 'w3-sftp-btn' : undefined}
                  style={{
                    width: 26,
                    height: 26,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    border: `1px solid ${h ? C.accent : C.border}`,
                    borderRadius: 4,
                    background: h ? C.accentDim : C.bg1,
                    color: h ? C.accent : C.text1,
                    transform: p ? 'translateY(0.5px)' : 'none',
                  }}
                >
                  <Icon name={b.icon as IconName} size={13} />
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  </div>
);

/* ---------- 标签栏 ---------- */

const TabBar: React.FC<{ tabs: Wb3Tab[]; activeId: string; hover: Wb3Target }> = ({ tabs, activeId, hover }) => (
  <div style={{ height: CENTER.tabBarH, flex: 'none', display: 'flex', alignItems: 'stretch', background: C.bg1, borderBottom: `1px solid ${C.border}`, overflow: 'hidden' }}>
    {tabs.map((t) => {
      const active = t.id === activeId;
      const w = t.id === 'term' || t.id === 'sftp' ? 152 : t.id === 'ed-app' ? 140 : 118;
      const hovered = t.id === 'sftp' && hover === 'tabSftp';
      return (
        <div
          key={t.id}
          data-anchor={t.id === 'sftp' ? 'w3-tab-sftp' : undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 8px 0 12px',
            width: w,
            flex: 'none',
            borderRight: `1px solid ${C.border}`,
            borderTop: `2px solid ${active ? C.accent : 'transparent'}`,
            background: active ? C.bg0 : hovered ? C.bgHover : 'transparent',
            color: active ? C.text0 : C.text1,
            fontSize: 12.5,
            cursor: 'pointer',
          }}
        >
          <span style={{ display: 'flex', flex: 'none' }}>
            <Icon name={t.icon} size={15} />
          </span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
            {t.dirty && <span style={{ color: C.yellow, marginRight: 3 }}>●</span>}
            {t.title}
          </span>
          <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2, borderRadius: 3, flex: 'none' }}>
            <Icon name="x" size={11} />
          </span>
        </div>
      );
    })}
  </div>
);

/* ---------- 终端面板 ---------- */

const TerminalPane: React.FC<{ caret: boolean; frame: number }> = ({ caret, frame }) => (
  <div style={{ flex: 1, minHeight: 0, background: '#0d1117', padding: '10px 12px', fontFamily: FONT_MONO, fontSize: 12.5, lineHeight: 1.7 }}>
    <div style={{ color: C.text0, whiteSpace: 'pre-wrap' }}>
      <span style={{ color: C.green }}>[devops@{DEMO.serverName} ~]$</span>{' '}
      {caret && <span style={{ display: 'inline-block', width: 7, height: 14, background: C.text1, verticalAlign: '-2px', opacity: frame % 32 < 16 ? 1 : 0 }} />}
    </div>
  </div>
);

/* ---------- SFTP 面板 ---------- */

const SftpToolbar: React.FC<{ st: NonNullable<Wb3State['sftp']>; hover: Wb3Target; press: Wb3Target }> = ({ st, hover, press }) => {
  const shift = st.searchOpen ? SF.searchShift : 0;
  return (
    <div style={{ position: 'relative', height: SF.toolbarH, flex: 'none', display: 'flex', alignItems: 'center', gap: 2, padding: '6px 10px', borderBottom: `1px solid ${C.border}`, background: C.bg1 }}>
      {(
        [
          { icon: 'arrowLeft', x: SF.nav.back, title: '后退' },
          { icon: 'arrowRight', x: SF.nav.fwd, title: '前进' },
          { icon: 'arrowUp', x: SF.nav.up, title: '上一级' },
          { icon: 'home', x: SF.nav.home, title: '回到主目录 ~' },
          { icon: 'slash', x: SF.nav.root, title: '根目录 /' },
        ] as const
      ).map((b) => (
        <div key={b.title} title={b.title} style={{ ...iconBtnStyle({}), position: 'absolute', left: b.x - CENTER.x - 14, top: 6 }}>
          <Icon name={b.icon as IconName} size={14} />
        </div>
      ))}
      {/* 地址栏(含内嵌星按钮) */}
      <div
        style={{
          position: 'absolute',
          left: SF.pathWrap.x1 - CENTER.x,
          width: SF.pathWrap.x2 - SF.pathWrap.x1,
          top: 6,
          height: 28,
        }}
      >
        <div
          style={{
            position: 'relative',
            width: '100%',
            height: 28,
            display: 'flex',
            alignItems: 'center',
            padding: '0 30px 0 10px',
            background: C.bg2,
            border: `1px solid ${C.border}`,
            borderRadius: 4,
            fontFamily: FONT_MONO,
            fontSize: 12.5,
            color: C.text1,
          }}
        >
          {st.cwd}
          <div data-anchor="w3-sf-star" title="收藏当前路径" style={{ ...iconBtnStyle({ active: st.starActive, hovered: hover === 'sfStar', pressed: press === 'sfStar' }), position: 'absolute', right: 3, top: 2, width: 24, height: 24 }}>
            <Icon name="star" size={13} />
          </div>
        </div>
      </div>
      <div title="跳转到输入框中的路径" style={{ ...btnGo, position: 'absolute', left: SF.go.x - CENTER.x - 24 + shift, top: 6 }}>
        跳转
      </div>
      <div title="平铺视图" style={{ ...iconBtnStyle({ active: st.view === 'grid' }), position: 'absolute', left: SF.gridBtn.x - CENTER.x - 14 + shift, top: 6 }}>
        <Icon name="grid" size={14} />
      </div>
      <div data-anchor="w3-sf-list" title="列表视图" style={{ ...iconBtnStyle({ active: st.view === 'list', hovered: hover === 'sfListBtn', pressed: press === 'sfListBtn' }), position: 'absolute', left: SF.listBtn.x - CENTER.x - 14 + shift, top: 6 }}>
        <Icon name="list" size={14} />
      </div>
      <div data-anchor="w3-sf-fav" title="收藏夹" style={{ ...iconBtnStyle({ active: st.favOpen, hovered: hover === 'sfFavBtn', pressed: press === 'sfFavBtn' }), position: 'absolute', left: SF.favBtn.x - CENTER.x - 14 + shift, top: 6 }}>
        <Icon name="star" size={14} />
      </div>
      <div data-anchor="w3-sf-search" title="搜索当前目录" style={{ ...iconBtnStyle({ active: st.searchOpen, hovered: hover === 'sfSearchBtn' }), position: 'absolute', left: SF.searchBtn.x - CENTER.x - 14 + shift, top: 6 }}>
        <Icon name="search" size={14} />
      </div>
      {st.searchOpen && (
        <div
          style={{
            position: 'absolute',
            left: SF.searchBtn.x - CENTER.x + 18 + shift,
            top: 6,
            width: 160,
            height: 28,
            display: 'flex',
            alignItems: 'center',
            padding: '0 10px',
            background: C.bg2,
            border: `1px solid ${C.accent}`,
            borderRadius: 4,
            fontSize: 12.5,
            color: C.text0,
          }}
        >
          {st.query ? (
            <span>
              {st.query.slice(0, -1)}
              <span style={{ background: C.accentDim, color: C.accentHover }}>{st.query.slice(-1)}</span>
              <span style={{ display: 'inline-block', width: 1, height: 13, background: C.text0, verticalAlign: '-2px', marginLeft: 1 }} />
            </span>
          ) : (
            <span style={{ color: C.text2 }}>搜索当前目录，支持 *.log 通配</span>
          )}
        </div>
      )}
    </div>
  );
};

const btnGo: React.CSSProperties = {
  height: 28,
  padding: '0 12px',
  display: 'flex',
  alignItems: 'center',
  background: C.bg2,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  fontSize: 12.5,
  color: C.text0,
  whiteSpace: 'nowrap',
};

const GridItem: React.FC<{ e: EntryDef; cx: number; cy: number; sel: boolean }> = ({ e, cx, cy, sel }) => (
  <div
    data-anchor={`w3-entry-${e.name}`}
    style={{
      position: 'absolute',
      left: cx - 46,
      top: cy - 37,
      width: 92,
      height: 74,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      padding: '12px 4px',
      borderRadius: 8,
      border: `1px solid ${sel ? C.borderStrong : 'transparent'}`,
      background: sel ? 'rgba(255,255,255,0.1)' : 'transparent',
      cursor: 'pointer',
      boxSizing: 'border-box',
    }}
  >
    <EntryIcon kind={entryKind(e)} />
    <div style={{ fontSize: 12, color: C.text1, maxWidth: 88, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</div>
  </div>
);

const SftpBody: React.FC<{ st: NonNullable<Wb3State['sftp']>; hover: Wb3Target; dropZone: Wb3State['dropZone'] }> = ({ st, hover, dropZone }) => {
  const favOpen = st.favOpen;
  const q = st.query.trim().toLowerCase();
  const shown = q
    ? st.entries.filter((e) => {
        const n = e.name.toLowerCase();
        if (q.includes('*') || q.includes('?')) {
          const re = new RegExp('^' + q.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
          return re.test(n);
        }
        return n.includes(q);
      })
    : st.entries;
  const outline = dropZone === 'sftp-no' ? `1.5px dashed ${C.red}` : dropZone === 'sftp-ok' ? `1.5px dashed ${C.accent}` : 'none';
  const bg = dropZone === 'sftp-no' ? 'rgba(229,98,106,0.07)' : dropZone === 'sftp-ok' ? C.accentDim : 'transparent';
  const cols = gridCols(favOpen);

  const frame = (
    <div
      style={{
        position: 'absolute',
        left: 12,
        top: 12,
        right: favOpen ? SF.favW : 0,
        bottom: 12,
        outline,
        outlineOffset: -4,
        background: bg,
      }}
    >
      {st.loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10, color: C.text2, fontSize: 13, height: '100%' }}>
          <Icon name="loader" size={26} />
          加载中…
        </div>
      ) : shown.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: C.text2, fontSize: 13, height: '100%' }}>
          <Icon name={q ? 'search' : 'folder'} size={26} />
          {q ? '无匹配条目' : '目录为空'}
        </div>
      ) : st.view === 'grid' ? (
        <>
          {shown.map((e, i) => (
            <GridItem key={e.name} e={e} cx={gridColX(i, favOpen) - 320} cy={gridRowY(Math.floor(i / cols)) - 129} sel={st.sel === e.name} />
          ))}
          {dropZone === 'sftp-no' && (
            <div
              style={{
                position: 'absolute',
                left: '50%',
                top: 210,
                transform: 'translateX(-50%)',
                padding: '8px 16px',
                borderRadius: 8,
                background: 'rgba(20,12,13,0.94)',
                border: `1px solid ${C.red}`,
                color: C.red,
                fontSize: 13,
                fontWeight: 600,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                pointerEvents: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              <RejectBadge />
              不支持从系统直接拖入
            </div>
          )}
        </>
      ) : (
        <ListView st={st} shown={shown} hover={hover} />
      )}
    </div>
  );
  return frame;
};

const ListView: React.FC<{ st: NonNullable<Wb3State['sftp']>; shown: EntryDef[]; hover: Wb3Target }> = ({ st, shown, hover }) => {
  const favOpen = st.favOpen;
  const g = tableGeom(favOpen);
  const rows = sortedEntries(shown, st.sortKey, st.sortAsc);
  const totalW = g.x2 - g.x1;
  const colw = { name: totalW - 110 - 160, size: 110, time: 160 };
  const th: React.CSSProperties = { textAlign: 'left', color: C.text2, fontWeight: 500, fontSize: 11, padding: '4px 10px', borderBottom: `1px solid ${C.borderStrong}`, whiteSpace: 'nowrap' };
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, tableLayout: 'fixed' }}>
      <thead>
        <tr>
          <th style={{ ...th, width: colw.name }}>名称</th>
          <th style={{ ...th, width: colw.size, textAlign: 'right' }}>大小</th>
          <th
            data-anchor="w3-sort-th"
            style={{
              ...th,
              width: colw.time,
              color: st.sortKey === 'mtime' ? C.accent : C.text2,
              cursor: 'pointer',
              background: hover === 'sortTh' ? C.bgHover : 'transparent',
            }}
          >
            修改时间
            {st.sortKey === 'mtime' && (
              <span style={{ display: 'inline-flex', verticalAlign: -2, marginLeft: 4 }}>
                <Icon name={st.sortAsc ? 'arrowUp' : 'arrowDown'} size={11} color={C.accent} />
              </span>
            )}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((e) => (
          <tr key={e.name} style={{ cursor: 'pointer', background: st.sel === e.name ? 'rgba(255,255,255,0.1)' : 'transparent' }}>
            <td style={{ padding: '4px 10px', borderBottom: `1px solid ${C.border}` }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: C.text0, minWidth: 0 }}>
                <EntryIcon kind={entryKind(e)} size={16} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.name}</span>
              </span>
            </td>
            <td style={{ padding: '4px 10px', borderBottom: `1px solid ${C.border}`, color: C.text2, fontFamily: FONT_MONO, textAlign: 'right', whiteSpace: 'nowrap' }}>
              {e.isDir ? '—' : fmtSize(e.size)}
            </td>
            <td style={{ padding: '4px 10px', borderBottom: `1px solid ${C.border}`, color: C.text2, whiteSpace: 'nowrap' }}>{fmtTime(e.mtime)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

const FavSidebar: React.FC<{ st: NonNullable<Wb3State['sftp']>; hover: Wb3Target }> = ({ st, hover }) => (
  <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: SF.favW, display: 'flex', flexDirection: 'column', borderLeft: `1px solid ${C.border}`, background: C.bg1 }}>
    <div style={{ height: 29, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px', borderBottom: `1px solid ${C.border}`, fontSize: 12, fontWeight: 600, color: C.text1 }}>
      收藏夹
      <span style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2 }}>
        <Icon name="x" size={12} />
      </span>
    </div>
    <div style={{ flex: 1, padding: 4, overflow: 'hidden' }}>
      {st.favorites.map((f, i) => {
        const current = f.path === st.cwd;
        return (
          <div
            key={f.path}
            title={f.path}
            data-anchor={i === 0 ? 'w3-fav-item' : undefined}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '4px 6px',
              borderRadius: 8,
              fontSize: 12,
              cursor: 'pointer',
              background: hover === 'favItem' && i === 0 ? C.bgHover : 'transparent',
              color: current ? C.accent : C.text1,
            }}
          >
            <span style={{ fontWeight: 600, maxWidth: '55%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.title}</span>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 11, color: current ? C.accentHover : C.text2 }}>{f.path}</span>
          </div>
        );
      })}
    </div>
  </div>
);

/* ---------- 编辑器面板 ---------- */

const TOK_COLOR: Record<TokKind, string> = {
  plain: '#abb2bf',
  key: '#e06c75',
  str: '#98c379',
  num: '#d19a66',
  comment: '#5c6370',
  head: '#e5c07b',
  atom: '#d19a66',
};

const EditorPane: React.FC<{ doc: EditorDoc }> = ({ doc }) => (
  <div style={{ flex: 1, minHeight: 0, display: 'flex', background: '#282c34', overflow: 'hidden', fontFamily: FONT_MONO, fontSize: 13, lineHeight: `${ED.lineH}px` }}>
    {/* 行号槽 */}
    <div style={{ width: ED.gutterW, flex: 'none', paddingTop: 6, color: '#636d83', textAlign: 'right', paddingRight: 14 }}>
      {doc.tokens.map((_, i) => (
        <div key={i}>{i + 1}</div>
      ))}
    </div>
    {/* 内容 */}
    <div style={{ flex: 1, minWidth: 0, paddingTop: 6, color: '#abb2bf' }}>
      {doc.tokens.map((line, li) => {
        const hasCaret = doc.caret && doc.caret.line === li;
        return (
          <div key={li} style={{ position: 'relative', height: ED.lineH, whiteSpace: 'pre' }}>
            {line.map((tok, ti) => {
              const [kind, text] = tok;
              const selected = doc.sel && doc.sel.line === li && kind === 'num';
              return (
                <span key={ti} style={{ color: TOK_COLOR[kind] }}>
                  {selected ? <span style={{ background: 'rgba(59,118,225,0.45)', color: '#ffffff' }}>{text}</span> : text}
                </span>
              );
            })}
            {hasCaret && doc.caret && (
              <span style={{ position: 'absolute', left: doc.caret.col * 7.8, top: 2, width: 7.8, height: 16, background: 'rgba(255,255,255,0.85)' }} />
            )}
          </div>
        );
      })}
    </div>
  </div>
);

/* ---------- AI 面板(静态,延续视频二布局) ---------- */

const AiPanel: React.FC = () => (
  <div style={{ width: AI.w, flex: 'none', background: C.bg1, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
    <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: `1px solid ${C.border}` }}>
      <div style={{ flex: 1, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, padding: '0 8px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12 }}>
        新会话
        <Icon name="chevronDown" size={12} color={C.text2} />
      </div>
      <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
        <Icon name="plus" size={14} />
      </div>
    </div>
    <div style={{ flex: 1 }} />
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 10, fontSize: 11, lineHeight: '18px', background: C.accentDim, color: C.accentHover }}>
          <Icon name="globe" size={11} />
          @remote:{DEMO.serverName}
        </span>
      </div>
      <div style={{ position: 'relative', minHeight: 70, padding: '8px 10px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12.5, lineHeight: 1.6, color: C.text2 }}>
        向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器
        <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10.5 }}>Enter 发送</span>
      </div>
    </div>
  </div>
);

/* ---------- 状态栏 ---------- */

const Statusbar: React.FC<{ tabs: Wb3Tab[]; activeId: string; progress: Wb3State['progress']; frame: number }> = ({ tabs, activeId, progress, frame }) => {
  const active = tabs.find((t) => t.id === activeId);
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 26, display: 'flex', alignItems: 'center', padding: '0 8px', background: C.bg1, borderTop: `1px solid ${C.border}`, color: C.text1, fontSize: 11 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 12 }}>
        <Icon name="folder" size={12} />
        {DEMO.projectName}
      </span>
      {active && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.text2, maxWidth: 260, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          <Icon name={active.icon} size={12} />
          {active.dirty && <span style={{ color: C.yellow }}>● </span>}
          {active.title}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {progress && (
        <div style={{ display: 'flex', alignItems: 'center', marginRight: 12 }}>
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6, height: 18, padding: '0 8px', border: `1px solid ${C.border}`, borderRadius: 9, background: C.bg0, overflow: 'hidden' }}>
            <div style={{ position: 'absolute', left: `${-20 + ((frame % 36) / 36) * 120}%`, top: 0, bottom: 0, width: '34%', background: C.accentDim }} />
            <span style={{ position: 'relative', color: C.text0, fontWeight: 600, whiteSpace: 'nowrap' }}>{progress.label}</span>
            <span style={{ position: 'relative', color: C.text2, whiteSpace: 'nowrap' }}>{progress.detail}</span>
          </div>
        </div>
      )}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 4, background: C.accentDim, color: C.accent }}>
        <Icon name="bot" size={12} /> AI 助手
      </span>
    </div>
  );
};

/* ---------- 右键菜单 ---------- */

const CtxMenu: React.FC<{ ctx: CtxState }> = ({ ctx }) => (
  <div
    style={{
      position: 'absolute',
      left: ctx.x,
      top: ctx.y,
      width: MENU.w,
      padding: MENU.pad,
      background: C.bg2,
      border: `1px solid ${C.borderStrong}`,
      borderRadius: 8,
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 40,
    }}
  >
    {ctx.items.map((it, i) =>
      it === 'sep' ? (
        <div key={`sep${i}`} style={{ height: 1, margin: '4px 6px', background: C.border }} />
      ) : (
        <div key={it} data-anchor={`w3-menu-${i}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 10px',
            borderRadius: 4,
            fontSize: 12.5,
            color: it === '删除' ? C.red : C.text0,
            background: ctx.hover === i ? (it === '删除' ? 'rgba(229,98,106,0.14)' : C.bgHover) : 'transparent',
          }}
        >
          <span style={{ display: 'flex', width: 15, justifyContent: 'center', color: ctx.hover === i ? (it === '删除' ? C.red : C.text0) : C.text1 }}>
            <Icon name={(MENU_ICONS[it] ?? 'file') as IconName} size={14} />
          </span>
          {it}
        </div>
      ),
    )}
  </div>
);

/* ---------- 收藏目录对话框 ---------- */

const FavModal: React.FC<{ t: number }> = ({ t }) => (
  <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
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
        opacity: t,
        transform: `scale(${0.96 + 0.04 * t})`,
      }}
    >
      <div style={{ height: 50, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>收藏目录</span>
        <Icon name="x" size={14} color={C.text2} />
      </div>
      <div style={{ padding: '14px 18px 4px' }}>
        <div style={{ fontSize: 12.5, color: C.text1, marginBottom: 6, lineHeight: 1.5 }}>
          标题（默认取目录名称，可自定义以区分同名目录）
          <br />
          <span style={{ color: C.text2, fontFamily: FONT_MONO, fontSize: 11.5 }}>路径：{DEMO.home}</span>
        </div>
        <div style={{ height: 30, display: 'flex', alignItems: 'center', padding: '0 10px', background: C.bg2, border: `1px solid ${C.accent}`, borderRadius: 4, fontSize: 12.5, color: C.text0 }}>
          {DEMO.favTitle}
          <span style={{ display: 'inline-block', width: 1, height: 13, background: C.text0, marginLeft: 1 }} />
        </div>
      </div>
      <div style={{ height: 54, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', marginTop: 10, borderTop: `1px solid ${C.border}` }}>
        <div style={{ height: 30, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13 }}>取消</div>
        <div data-anchor="w3-fav-ok" style={{ height: 30, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.accent, borderRadius: 4, color: '#fff', fontSize: 13 }}>收藏</div>
      </div>
    </div>
  </div>
);

/* ---------- 主组件 ---------- */

export const Wb3: React.FC<{ state: Wb3State; frame: number }> = ({ state, frame }) => {
  const { panel, serverExpanded, tabs, activeId, termCaret, sftp, editors, favModalT, ctx, treeFiles, treeHighlight, dropZone, toast, progress, hover, press } = state;
  const activeEditor = editors[activeId];

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
        <ActivityBar panel={panel} hover={hover} press={press} />

        {/* 侧栏 */}
        <div style={{ position: 'relative', width: SIDEBAR.w, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: SIDEBAR.headH, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px 0 14px', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: C.text1 }}>
            {panel === 'explorer' ? '文件资源管理器' : '服务器列表'}
            {panel === 'explorer' && (
              <span style={{ display: 'flex', gap: 2 }}>
                {(['filePlus', 'folderPlus', 'refresh'] as IconName[]).map((n) => (
                  <span key={n} title={n === 'filePlus' ? '新建文件' : n === 'folderPlus' ? '新建目录' : '刷新'} style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
                    <Icon name={n} size={13} />
                  </span>
                ))}
              </span>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
            {panel === 'explorer' ? <ExplorerTree files={treeFiles} highlight={treeHighlight} dropZone={dropZone} /> : <ServersPanel expanded={serverExpanded} hover={hover} press={press} />}
          </div>
        </div>

        {/* 中央 */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg0 }}>
          <TabBar tabs={tabs} activeId={activeId} hover={hover} />
          <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
            {activeId === 'term' && <TerminalPane caret={termCaret} frame={frame} />}
            {activeId === 'sftp' && sftp && (
              <div style={{ flex: 1, minWidth: 0, position: 'relative', display: 'flex', flexDirection: 'column', background: C.bg0 }}>
                <SftpToolbar st={sftp} hover={hover} press={press} />
                <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
                  <SftpBody st={sftp} hover={hover} dropZone={dropZone} />
                  {sftp.favOpen && <FavSidebar st={sftp} hover={hover} />}
                </div>
              </div>
            )}
            {activeEditor && <EditorPane doc={activeEditor} />}
          </div>
        </div>

        <AiPanel />
      </div>

      <Statusbar tabs={tabs} activeId={activeId} progress={progress} frame={frame} />

      {ctx && <CtxMenu ctx={ctx} />}
      {favModalT > 0 && <FavModal t={favModalT} />}

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
            whiteSpace: 'nowrap',
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
};
