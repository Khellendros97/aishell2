/**
 * 视频六工作台复刻:文件暂存功能。四中央标签(本地终端/浏览器/文件暂存区/暂存 diff),
 * 暂存区面板(StagingTab 实测:头+提示+工具栏+表格行内 比较差异/接受/还原/导出)、
 * diff 视图(DiffTab:左右「首次快照/当前内容」,删红/增绿/折叠)、AI 面板新增
 * 「已暂存 N 个文件修改,点击查看」提示条与会话下拉菜单;接受/还原确认框与导出备份对话框。
 * 站点内容复用 browser5/Wb5 的 Site1(styled=1,承接第五段结果)。
 * 全部内容由 state(Wb6State)驱动,锚点见 ./layout.ts。
 */
import React from 'react';
import { TopBar } from '../components/TopBar';
import { C, FONT_MONO, FONT_UI, IconName } from '../theme';
import { Icon } from '../ui';
import { WIN_H, WIN_W } from '../scene';
import { Site1 } from '../browser5/Wb5';
import {
  CHAT, CFM_BTN, CFM_DLG, ChatItem, DEMO, DIFF, DIFF_ROWS, DIFF_ROWS as ROWS, EFFORT_SEL,
  EXP_ACCEPT, EXP_BTN, EXP_DLG, EXP_OPT, ITEM_W, MODE_SEL, NOTICE, SES_MENU, SES_NEW, SES_SELECT,
  STG, TAB_BROWSER_X, TAB_STAGING_X, TAB_TERM_X, TAB_W, TERM_BASE, TermLine, diffLineCy,
  diffSideX, sesMenuItemCy, stgRowCy,
} from './layout';
import { VIEW } from '../browser5/layout';

/* ---------- 状态 ---------- */

export type T6 =
  | 'notice' | 'stgDiff1' | 'stgExport1' | 'stgRestore2' | 'stgAccept1'
  | 'sesNew' | 'sesSelect' | 'sesItem0' | 'input'
  | 'expOk' | 'accOk' | 'resOk' | null;

export interface Wb6State {
  centerTab: 'terminal' | 'browser' | 'staging' | 'diff';
  /** 「文件暂存区」/「index.html」标签进场 t */
  stagingTabT: number;
  diffTabT: number;
  /** 暂存行可见性(接受清除 index 行;还原保留 theme 行) */
  rowIndex: boolean;
  rowTheme: boolean;
  /** 「已暂存」提示条 */
  noticeVisible: boolean;
  noticeCount: number;
  noticeT: number;
  /** 会话:s1 = Nebula 官网改版;new = 新会话(聊天与暂存清空) */
  session: 's1' | 'new';
  sessionMenu: { open: boolean; hover: number } | null;
  items: ChatItem[];
  inputText: string;
  inputCaret: boolean;
  inputFocus: boolean;
  dialog: 'accept' | 'restore' | null;
  dialogT: number;
  exportDlg: boolean;
  exportDlgT: number;
  toast: string | null;
  hover: T6;
  press: T6;
}

/* ---------- 小组件 ---------- */

const Spinner: React.FC<{ frame: number }> = ({ frame }) => (
  <svg viewBox="0 0 24 24" width={11} height={11} style={{ opacity: frame % 20 < 10 ? 1 : 0.45 }}>
    <g fill="none" stroke={C.text2} strokeWidth={2.6} strokeLinecap="round">
      <path d="M12 3a9 9 0 1 1-9 9" opacity={0.35} />
      <path d="M12 3a9 9 0 0 1 6.4 2.6" />
    </g>
  </svg>
);

const btnSmall = (primary: boolean, opts: { hovered?: boolean; danger?: boolean; disabled?: boolean } = {}): React.CSSProperties => ({
  height: 24,
  padding: '0 9px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  borderRadius: 4,
  border: `1px solid ${primary || opts.danger ? (opts.danger ? C.red : C.accent) : C.border}`,
  background: primary ? (opts.hovered ? C.accentHover : C.accent) : opts.hovered ? C.bg3 : C.bg2,
  color: primary ? '#fff' : opts.hovered ? C.text0 : C.text1,
  fontSize: 12,
  lineHeight: '16px',
  opacity: opts.disabled ? 0.45 : 1,
  whiteSpace: 'nowrap',
});

const Checkbox: React.FC<{ size?: number; checked?: boolean }> = ({ size = 13, checked = false }) => (
  <span
    style={{
      width: size,
      height: size,
      borderRadius: 2,
      border: `1px solid ${checked ? C.accent : C.borderStrong}`,
      background: checked ? C.accent : 'transparent',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: 'none',
    }}
  >
    {checked && (
      <svg viewBox="0 0 24 24" width={9} height={9}>
        <path d="m5 12 5 5 9-10" fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    )}
  </span>
);

/* ---------- 活动栏 / 侧栏 ---------- */

const ACT_ITEMS = [
  { icon: 'folder', id: 'explorer' },
  { icon: 'monitor', id: 'servers' },
  { icon: 'star', id: 'commands' },
  { icon: 'sparkles', id: 'skills' },
  { icon: 'pencil', id: 'notes' },
  { icon: 'globe', id: 'browser' },
] as const;

const ActivityBar: React.FC = () => (
  <div style={{ width: 48, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 6, gap: 2 }}>
    {ACT_ITEMS.map((it) => {
      const active = it.id === 'servers';
      return (
        <div
          key={it.id}
          style={{
            width: 40, height: 40, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center',
            borderRadius: '0 8px 8px 0', borderLeft: `2px solid ${active ? C.accent : 'transparent'}`,
            color: active ? C.accent : C.text1, background: active ? C.bgHover : 'transparent',
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

const ServersPanel: React.FC = () => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: 0, padding: '4px 8px' }}>
    <div style={{ padding: '8px 12px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8, marginBottom: 8, display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ width: 30, height: 30, borderRadius: 8, background: C.bg3, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1 }}>
        <Icon name="monitor" size={16} />
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>本地终端</div>
        <div style={{ fontSize: 11.5, color: C.text2, fontFamily: FONT_MONO }}>本地终端 · 点击打开</div>
      </div>
    </div>
    <div style={{ padding: '8px 12px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 30, height: 30, borderRadius: 8, background: C.accentDim, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.accentHover }}>
          <Icon name="server" size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{DEMO.serverName}</div>
          <div style={{ fontSize: 11.5, color: C.text2, fontFamily: FONT_MONO }}>{DEMO.serverHost}:22</div>
        </div>
        <span style={{ color: C.text2, display: 'flex' }}>
          <Icon name="chevronDown" size={14} />
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', marginLeft: 40, marginTop: 6 }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', padding: '1px 8px', borderRadius: 10, fontSize: 11, lineHeight: '18px', background: C.bg3, color: C.text1 }}>密码</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
        {(['chatPlus', 'folder', 'terminal', 'more'] as IconName[]).map((n) => (
          <div key={n} style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg1, color: C.text1 }}>
            <Icon name={n} size={13} />
          </div>
        ))}
      </div>
    </div>
  </div>
);

/* ---------- 中央标签栏 ---------- */

const WbTab: React.FC<{ icon: IconName; title: string; active: boolean; w?: number; opacity?: number; anchor?: string }> = ({ icon, title, active, w = TAB_W, opacity = 1, anchor }) => (
  <div
    data-anchor={anchor}
    style={{
      display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 12px', width: w, flex: 'none',
      borderRight: `1px solid ${C.border}`, borderTop: `2px solid ${active ? C.accent : 'transparent'}`,
      background: active ? C.bg0 : C.bg1, fontSize: 12.5, color: active ? C.text0 : C.text1,
      overflow: 'hidden', opacity,
    }}
  >
    <span style={{ display: 'flex', flex: 'none' }}><Icon name={icon} size={15} /></span>
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{title}</span>
    <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2, borderRadius: 3, flex: 'none' }}>
      <Icon name="x" size={11} />
    </span>
  </div>
);

/* ---------- 终端(背景) ---------- */

const TermPane: React.FC<{ frame: number }> = ({ frame }) => (
  <div style={{ flex: 1, minHeight: 0, background: '#0d1117', padding: '10px 12px', fontFamily: FONT_MONO, fontSize: 12.5, lineHeight: 1.7, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
    {[...TERM_BASE, { prompt: true } as TermLine].map((l, i) => {
      const isCmd = !!(l.prompt || l.cmd);
      return (
        <div key={i} style={{ whiteSpace: 'pre', color: isCmd ? C.text0 : C.text1 }}>
          {isCmd && <span style={{ color: C.green }}>$ </span>}
          {l.cmd || l.text || ' '}
          {l.prompt && (
            <span style={{ display: 'inline-block', width: 7, height: 14, background: C.text1, verticalAlign: '-2px', marginLeft: 2, opacity: frame % 32 < 16 ? 1 : 0 }} />
          )}
        </div>
      );
    })}
  </div>
);

/* ---------- 浏览器(承接第五段结果,静态) ---------- */

const BrowserPaneStatic: React.FC = () => (
  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
    <div style={{ height: 41, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderBottom: `1px solid ${C.border}`, boxSizing: 'border-box' }}>
      {(['arrowLeft', 'arrowRight', 'refresh'] as IconName[]).map((n) => (
        <div key={n} style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg1, color: C.text1 }}>
          <Icon name={n} size={15} />
        </div>
      ))}
      <div style={{ flex: 1, height: 28, display: 'flex', alignItems: 'center', padding: '0 10px', borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg2, fontSize: 13, fontFamily: FONT_MONO, color: C.text0 }}>
        {DEMO.siteUrl}
      </div>
      {(['folderOpen', 'inspect', 'wrench'] as IconName[]).map((n) => (
        <div key={n} style={{ width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg1, color: C.text1 }}>
          <Icon name={n} size={15} />
        </div>
      ))}
    </div>
    <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
      <div style={{ position: 'relative', flex: 1, minWidth: 0, background: C.bg1, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: VIEW.w, height: VIEW.h }}>
          <Site1 styled={1} />
        </div>
      </div>
      <div style={{ width: 34, flex: 'none', borderLeft: `1px solid ${C.border}`, background: C.bg1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: '6px 0' }}>
        <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg1, color: C.text1 }}>
          <Icon name="chevronLeft" size={13} />
        </div>
        <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 4, border: `1px solid ${C.border}`, background: C.bg1, color: C.text1 }}>
          <Icon name="plus" size={13} />
        </div>
        <div style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.accent}`, borderRadius: 4, background: C.accentDim, color: C.accent, marginTop: 2 }}>
          <Icon name="globe" size={14} />
        </div>
      </div>
    </div>
  </div>
);

/* ---------- 文件暂存区面板 ---------- */

const StagingRow: React.FC<{
  y: number; server: string; name: string; path: string; time: string; size: string;
  hover: T6; press: T6; targets: { diff: T6; accept: T6; restore: T6; export: T6 };
  anchors?: Partial<Record<Exclude<T6, null>, string>>;
}> = ({ y, server, name, path, time, size, hover, press, targets, anchors }) => {
  const cy = y + STG.rowH / 2;
  const cell: React.CSSProperties = { padding: '6px 8px', borderBottom: `1px solid ${C.border}`, verticalAlign: 'middle', height: STG.rowH };
  return (
    <div style={{ position: 'absolute', left: 12, right: 12, top: y, height: STG.rowH, borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'stretch', fontSize: 12 }}>
      <div style={{ ...cell, width: 30, paddingLeft: 6, paddingRight: 4, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Checkbox />
      </div>
      <div style={{ ...cell, width: 114, display: 'flex', alignItems: 'center', color: C.text1, whiteSpace: 'nowrap' }}>{server}</div>
      <div style={{ ...cell, flex: 1, display: 'flex', alignItems: 'center', color: C.text0, overflow: 'hidden', whiteSpace: 'nowrap' }}>
        {name}
      </div>
      <div style={{ ...cell, width: 150, display: 'flex', alignItems: 'center', color: C.text2, whiteSpace: 'nowrap' }}>{time}</div>
      <div style={{ ...cell, width: 120, display: 'flex', alignItems: 'center', color: C.text1, whiteSpace: 'nowrap' }}>{size}</div>
      <div style={{ ...cell, width: 90, display: 'flex', alignItems: 'center', color: C.text0, whiteSpace: 'nowrap' }}>存在</div>
      <div style={{ ...cell, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
        {([
          { label: '比较差异', icon: 'diff' as IconName, primary: false, key: targets.diff, w: STG.btnDiff.w },
          { label: '接受', icon: null, primary: true, key: targets.accept, w: STG.btnAccept.w },
          { label: '还原', icon: null, primary: false, key: targets.restore, w: STG.btnRestore.w },
          { label: '导出', icon: 'download' as IconName, primary: false, key: targets.export, w: STG.btnExport.w },
        ] as const).map((b) => (
          <span
            key={b.label}
            title={b.label}
            data-anchor={b.key ? anchors?.[b.key] : undefined}
            style={{
              width: b.w,
              ...btnSmall(b.primary, { hovered: hover === b.key, danger: false }),
              justifyContent: 'center',
            }}
          >
            {b.icon && <Icon name={b.icon} size={12} />}
            {b.label}
          </span>
        ))}
      </div>
      <span style={{ display: 'none' }}>{`${path},${cy},${press}`}</span>
    </div>
  );
};

const StagingPanel: React.FC<{ st: Wb6State }> = ({ st }) => {
  const count = (st.rowIndex ? 1 : 0) + (st.rowTheme ? 1 : 0);
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
      {/* 头部 */}
      <div style={{ height: 35, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontWeight: 600, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Icon name="history" size={15} /> 文件暂存区
          <span style={{ minWidth: 18, height: 18, padding: '0 5px', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: `1px solid ${C.borderStrong}`, borderRadius: 9, background: C.bg3, color: C.text1, font: `600 10px/1 ${FONT_MONO}` }}>
            {count}
          </span>
        </span>
        <span style={{ ...btnSmall(false, {}), width: STG.refresh.w, justifyContent: 'center' }}>
          <Icon name="refresh" size={12} /> 刷新
        </span>
      </div>
      {/* 提示 */}
      <div style={{ flex: 'none', fontSize: 11, color: C.text2, padding: '8px 12px', borderBottom: `1px solid ${C.border}`, lineHeight: 1.6 }}>
        自动备份开启后，AI 会话第一次修改远程文件前自动保存原始快照，同一会话后续修改不覆盖。接受 = 确认本次修改并清除暂存条目（不改远程内容）；还原 = 把远程文件恢复到首次修改前的内容；清理 = 把「无变更」的条目一次性接受清除。
      </div>
      {/* 工具栏 */}
      <div style={{ height: 38, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px', borderBottom: `1px solid ${C.border}`, background: C.bg2 }}>
        <span style={{ fontSize: 11.5, color: C.text2 }}>选择文件后可批量操作</span>
        <span style={{ flex: 1 }} />
        <span style={btnSmall(false, {})}>
          <Icon name="trash" size={12} /> 清理无变更
        </span>
        <span style={btnSmall(true, {})}>批量接受</span>
        <span style={btnSmall(false, {})}>
          <Icon name="restore" size={12} /> 批量还原
        </span>
        <span style={btnSmall(false, {})}>
          <Icon name="download" size={12} /> 批量导出
        </span>
      </div>
      {/* 表格 */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', padding: '10px 0 0 0' }}>
        <div style={{ position: 'absolute', left: 12, right: 12, top: 0, height: 29, display: 'flex', alignItems: 'stretch', fontSize: 12, borderBottom: `1px solid ${C.borderStrong}` }}>
          {[
            { label: '', w: 30 },
            { label: '服务器', w: 114 },
            { label: '远程路径', w: 0 },
            { label: '首次快照', w: 150 },
            { label: '原始状态', w: 120 },
            { label: '当前状态', w: 90 },
            { label: '操作', w: 0 },
          ].map((h, i) => (
            <div
              key={i}
              style={{
                width: h.w || (i === 2 ? 1 : 'auto'),
                flex: h.w ? 'none' : (i === 2 ? 1 : 'none'),
                textAlign: i === 6 ? 'right' : 'left',
                padding: '6px 8px', fontWeight: 600, color: C.text2, whiteSpace: 'nowrap',
              }}
            >
              {h.label}
            </div>
          ))}
        </div>
        {st.rowIndex && (
          <StagingRow
            y={29}
            server={DEMO.serverName}
            name={DEMO.file1Name}
            path={DEMO.file1Path}
            time={DEMO.file1Time}
            size={DEMO.file1Size}
            hover={st.hover}
            press={st.press}
            targets={{ diff: 'stgDiff1', accept: 'stgAccept1', restore: null, export: 'stgExport1' }}
            anchors={{ stgDiff1: 'w6-stg-diff-0', stgAccept1: 'w6-stg-accept-0', stgExport1: 'w6-stg-export-0' }}
          />
        )}
        {st.rowTheme && (
          <StagingRow
            y={29 + (st.rowIndex ? STG.rowH : 0)}
            server={DEMO.serverName}
            name={DEMO.file2Name}
            path={DEMO.file2Path}
            time={DEMO.file2Time}
            size={DEMO.file2Size}
            hover={st.hover}
            press={st.press}
            targets={{ diff: null, accept: null, restore: 'stgRestore2', export: null }}
            anchors={{ stgRestore2: 'w6-stg-restore-1' }}
          />
        )}
        {count === 0 && (
          <div style={{ color: C.text2, fontSize: 12, padding: '24px 8px', textAlign: 'center', lineHeight: 1.7 }}>
            当前会话暂无暂存条目。AI 修改远程文件（run_command 写入 / sftp_upload 覆盖）前会自动保存原始快照。
          </div>
        )}
      </div>
    </div>
  );
};

/* ---------- 暂存 diff 面板 ---------- */

const DiffCell: React.FC<{ kind: 'ctx' | 'del' | 'add' | 'gap' | 'fold'; text: string; no: number | null; foldText?: string }> = ({ kind, text, no, foldText }) => {
  const bg =
    kind === 'del' ? 'rgba(220, 60, 60, 0.16)'
    : kind === 'add' ? 'rgba(60, 180, 100, 0.16)'
    : kind === 'gap'
      ? 'repeating-linear-gradient(-45deg, transparent, transparent 4px, rgba(127,127,127,0.06) 4px, rgba(127,127,127,0.06) 8px)'
      : 'transparent';
  return (
    <div style={{ display: 'flex', height: DIFF.lineH, background: bg, alignItems: 'center' }}>
      <span style={{ width: 34, flex: 'none', textAlign: 'right', paddingRight: 8, fontSize: 10.5, color: C.text2, fontFamily: FONT_MONO, opacity: 0.7 }}>
        {no ?? ''}
      </span>
      {kind === 'fold' ? (
        <span
          style={{
            flex: 1, textAlign: 'center', fontSize: 12, fontFamily: FONT_MONO, color: C.text2,
            background: 'rgba(79,142,247,0.08)', border: `1px solid ${C.border}`, borderRadius: 3,
            margin: '0 6px', padding: '0 8px', whiteSpace: 'nowrap', overflow: 'hidden',
          }}
        >
          ⋯ {foldText}
        </span>
      ) : (
        <code style={{ fontFamily: FONT_MONO, fontSize: 12, color: C.text0, whiteSpace: 'pre', overflow: 'hidden' }}>{text}</code>
      )}
    </div>
  );
};

const DiffPanel: React.FC = () => (
  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}>
    {/* 头部 */}
    <div style={{ height: 35, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 12px', borderBottom: `1px solid ${C.border}` }}>
      <span style={{ fontWeight: 600, fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Icon name="diff" size={15} /> 暂存 diff
      </span>
      <span style={{ display: 'flex', gap: 6 }}>
        <span style={{ ...btnSmall(false, {}), width: DIFF.expandAll.w, justifyContent: 'center' }}>
          <Icon name="star" size={12} /> 展开全部
        </span>
        <span style={{ ...btnSmall(false, {}), width: DIFF.refresh.w, justifyContent: 'center' }}>
          <Icon name="refresh" size={12} /> 刷新
        </span>
      </span>
    </div>
    {/* meta */}
    <div style={{ height: 30, flex: 'none', display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: `1px solid ${C.border}`, fontSize: 11.5, color: C.text2 }}>
      <span style={{ fontWeight: 600, color: C.text0, fontFamily: FONT_MONO }}>{DEMO.file1Name}</span>
      <span>{DEMO.file1Path}（原始已存在 → 当前存在）</span>
    </div>
    {/* 双栏 */}
    <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', gap: 10, padding: '10px 12px' }}>
      {([0, 1] as const).map((side) => {
        const head = side === 0
          ? { icon: 'arrowLeft' as IconName, label: '首次快照' }
          : { icon: 'arrowRight' as IconName, label: '当前内容' };
        return (
          <div key={side} style={{ flex: '0 0 618px', minWidth: 0, border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg2, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            <div style={{ height: 27, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 11, color: C.text2, borderBottom: `1px solid ${C.border}`, background: C.bg3 }}>
              {side === 0 && <Icon name={head.icon} size={12} />}
              {head.label}
              {side === 1 && <Icon name={head.icon} size={12} />}
            </div>
            <div style={{ flex: 1, minHeight: 0, padding: '6px 0', overflow: 'hidden' }}>
              {ROWS.map((r, i) => (
                <DiffCell
                  key={i}
                  kind={side === 0 ? r.leftKind : r.rightKind}
                  text={side === 0 ? r.left : r.right}
                  no={side === 0 ? r.leftNo : r.rightNo}
                  foldText={r.foldText}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
    <span style={{ display: 'none' }}>{`${diffLineCy(0)},${diffSideX(1)}`}</span>
  </div>
);

/* ---------- 聊天条目 ---------- */

const Chip: React.FC<{ label: string }> = ({ label }) => (
  <span
    style={{
      display: 'inline-flex', alignItems: 'center', padding: '0 5px', borderRadius: 4,
      background: 'rgba(79,142,247,0.28)', border: `1px solid ${C.accent}`, color: C.accentHover,
      fontSize: 11.5, marginRight: 4, verticalAlign: 'baseline', whiteSpace: 'nowrap',
    }}
  >
    {label}
  </span>
);

const STATUS_COLOR: Record<string, string> = { approving: C.text2, smart: C.text2, running: C.text2, succeeded: C.green };
const STATUS_TEXT: Record<string, string> = { approving: '等待批准', smart: '已智能放行 · 执行中…', running: '执行中…', succeeded: '成功' };

const ActionCard: React.FC<{ item: ChatItem; frame: number }> = ({ item, frame }) => {
  if (item.kind !== 'action') return null;
  const { status, spec } = item;
  return (
    <div
      style={{
        position: 'absolute', left: CHAT.l - 1580, top: item.y - 80, width: ITEM_W, boxSizing: 'border-box',
        padding: '8px 10px', background: C.bg2, border: `1px solid ${C.border}`,
        borderLeft: status === 'succeeded' ? `3px solid ${C.green}` : `1px solid ${C.border}`,
        borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, height: 20 }}>
        <span style={{ fontWeight: 600, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          <Icon name={spec.icon} size={13} />
          {spec.name}
        </span>
        <span style={{ fontSize: 11, color: STATUS_COLOR[status], display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}>
          {(status === 'running' || status === 'smart') && <Spinner frame={frame} />}
          {STATUS_TEXT[status]}
        </span>
      </div>
      {spec.intent && <div style={{ fontSize: 12, lineHeight: '18px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{spec.intent}</div>}
      {spec.meta && <div style={{ fontSize: 12, lineHeight: '18px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{spec.meta}</div>}
      {status === 'succeeded' && spec.result && (
        <div style={{ boxSizing: 'border-box', height: 28, padding: '4px 8px', background: '#14161b', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, lineHeight: '20px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {spec.result}
        </div>
      )}
    </div>
  );
};

const UserBubble: React.FC<{ item: ChatItem }> = ({ item }) =>
  item.kind !== 'user' ? null : (
    <div style={{ position: 'absolute', left: CHAT.l - 1580, top: item.y - 80, width: CHAT.w, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ maxWidth: ITEM_W, padding: '8px 11px', borderRadius: 10, borderBottomRightRadius: 3, background: C.accentDim, fontSize: 12.5, lineHeight: '20px' }}>
        {item.chip && <Chip label={item.chip} />}
        {item.lines.map((l, i) => (
          <span key={i}>
            {l}
            {i < item.lines.length - 1 && <br />}
          </span>
        ))}
      </div>
    </div>
  );

const AiBubble: React.FC<{ item: ChatItem; frame: number }> = ({ item, frame }) =>
  item.kind !== 'ai' ? null : (
    <div style={{ position: 'absolute', left: CHAT.l - 1580, top: item.y - 80, width: ITEM_W }}>
      <div style={{ maxWidth: ITEM_W, padding: '8px 11px', borderRadius: 10, borderBottomLeftRadius: 3, background: C.bg2, fontSize: 12.5, lineHeight: '20px' }}>
        {item.typing ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 20 }}>
            {[0, 1, 2].map((i) => {
              const up = (frame * 2 + i * 8) % 48 < 24;
              return (
                <span key={i} style={{ width: 5, height: 5, borderRadius: '50%', background: C.text2, opacity: up ? 1 : 0.25, transform: up ? 'translateY(-2px)' : 'none' }} />
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
      </div>
    </div>
  );

/* ---------- AI 面板(会话栏 + 消息 + 暂存提示条 + 输入区) ---------- */

const AiPanel: React.FC<{ st: Wb6State; frame: number }> = ({ st, frame }) => (
  <div style={{ position: 'relative', width: 340, flex: 'none', background: C.bg1, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
    {/* 会话栏 */}
    <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: `1px solid ${C.border}` }}>
      <div
        data-anchor="w6-ses-select"
        style={{
          flex: 1, height: SES_SELECT.h, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          padding: '0 8px', background: C.bg2, border: `1px solid ${st.hover === 'sesSelect' || st.sessionMenu?.open ? C.accent : C.border}`,
          borderRadius: 4, fontSize: 12, color: C.text0,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {st.session === 's1' ? DEMO.sessionName : '新会话'}
        </span>
        <Icon name="chevronDown" size={12} color={C.text2} />
      </div>
      <div
        data-anchor="w6-ses-new"
        style={{
          width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1,
          borderRadius: 4, background: st.hover === 'sesNew' || st.press === 'sesNew' ? C.bg3 : 'transparent',
          border: `1px solid ${st.hover === 'sesNew' ? C.accent : 'transparent'}`,
        }}
        title="新建会话"
      >
        <Icon name="plus" size={14} />
      </div>
    </div>
    {/* 消息区(底部让位提示条) */}
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
      {st.session === 'new' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2, fontSize: 12 }}>
          新会话已创建，暂存区为空
        </div>
      )}
      {st.items.map((item) =>
        item.kind === 'user' ? (
          <UserBubble key={item.id} item={item} />
        ) : item.kind === 'ai' ? (
          <AiBubble key={item.id} item={item} frame={frame} />
        ) : (
          <ActionCard key={item.id} item={item} frame={frame} />
        ),
      )}
    </div>
    {/* 「已暂存」提示条 */}
    {st.noticeVisible && (
      <div
        data-anchor="w6-notice"
        style={{
          minHeight: NOTICE.h, margin: '0 10px 8px', padding: '5px 9px', display: 'flex', alignItems: 'center', gap: 6,
          border: `1px solid ${st.hover === 'notice' ? C.accent : C.border}`, borderRadius: 6,
          background: st.hover === 'notice' ? C.accentDim : C.bg2, color: st.hover === 'notice' ? C.text0 : C.text1,
          fontSize: 11.5, opacity: st.noticeT, transform: `translateY(${8 - 8 * st.noticeT}px)`, flex: 'none', cursor: 'pointer',
        }}
      >
        <span style={{ display: 'flex', flex: 'none', color: C.accent }}>
          <Icon name="diff" size={14} />
        </span>
        已暂存 {st.noticeCount} 个文件修改，点击查看
        <span style={{ marginLeft: 'auto', display: 'flex', color: C.accent }}>
          <Icon name="chevronRight" size={13} />
        </span>
      </div>
    )}
    {/* 输入区 */}
    <div style={{ flex: 'none', height: 148, boxSizing: 'border-box', borderTop: `1px solid ${C.border}`, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 0', fontSize: 11, color: C.text2, flex: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="bot" size={12} /> AI 模式
        </span>
        <div style={{ width: MODE_SEL.w, height: MODE_SEL.h, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text0, fontSize: 12, boxSizing: 'border-box', flex: 'none' }}>
          工作
          <Icon name="chevronDown" size={10} color={C.text2} />
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="zap" size={12} /> 思考强度
        </span>
        <div style={{ width: EFFORT_SEL.w, height: EFFORT_SEL.h, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text0, fontSize: 12, boxSizing: 'border-box', flex: 'none' }}>
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
        data-anchor="w6-ai-input"
        style={{
          position: 'relative', flex: 1, minHeight: 0, padding: '8px 10px', background: C.bg2,
          border: `1px solid ${st.inputFocus ? C.accent : C.border}`, borderRadius: 6, fontSize: 12.5, lineHeight: '20px',
        }}
      >
        {st.inputText ? (
          <span style={{ color: C.text0, wordBreak: 'break-all' }}>
            {st.inputText}
            {st.inputCaret && <span style={{ display: 'inline-block', width: 1.5, height: 14, background: C.accent, verticalAlign: '-2px', marginLeft: 1 }} />}
          </span>
        ) : (
          <span style={{ color: C.text2 }}>向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器</span>
        )}
        <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10.5, color: C.text2 }}>Enter 发送</span>
      </div>
    </div>
    {/* 会话下拉菜单 */}
    {st.sessionMenu?.open && (
      <div
        style={{
          position: 'absolute', left: 8, top: 42, width: SES_MENU.w, padding: SES_MENU.pad,
          background: C.bg2, border: `1px solid ${C.borderStrong}`, borderRadius: 6,
          boxShadow: '0 4px 16px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', zIndex: 45,
        }}
      >
        {[DEMO.sessionName, DEMO.sessionOther].map((label, i) => {
          const current = i === 0 && st.session === 's1';
          return (
            <div
              key={label}
              data-anchor={i === 0 ? 'w6-ses-item-0' : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, height: SES_MENU.itemH, padding: '0 10px', borderRadius: 4,
                fontSize: 12.5, color: st.sessionMenu!.hover === i ? C.text0 : current ? C.accent : C.text1,
                background: st.sessionMenu!.hover === i ? C.bgHover : current ? C.accentDim : 'transparent',
                fontWeight: current ? 600 : 400, overflow: 'hidden', whiteSpace: 'nowrap',
              }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
              {current && <span style={{ width: 5, height: 5, borderRadius: '50%', background: C.accent, marginLeft: 'auto' }} />}
            </div>
          );
        })}
        <span style={{ display: 'none' }}>{`${sesMenuItemCy(0)}`}</span>
      </div>
    )}
  </div>
);

/* ---------- 对话框 ---------- */

const ConfirmDialog: React.FC<{ kind: 'accept' | 'restore'; t: number; hover: T6 }> = ({ kind, t, hover }) => {
  const accept = kind === 'accept';
  const lines = accept
    ? ['确认本次修改并清除暂存条目？', `${DEMO.serverName}：${DEMO.file1Path}`, '（不改远程内容，只删除本地暂存记录）']
    : ['把远程文件还原到首次修改前的内容？', `${DEMO.serverName}：${DEMO.file2Path}`, '还原后当前修改将丢失（外部修改冲突会另行提示）'];
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute', left: CFM_DLG.x, top: 600 - CFM_DLG.h / 2, width: CFM_DLG.w, height: CFM_DLG.h,
          boxSizing: 'border-box', background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{accept ? '接受暂存' : '确认还原'}</span>
          <Icon name="x" size={14} color={C.text2} />
        </div>
        <div style={{ flex: 1, padding: '14px 18px', color: C.text1, fontSize: 12.5, lineHeight: '20px', overflow: 'hidden' }}>
          {lines.map((l, i) => (
            <div key={i} style={{ whiteSpace: 'nowrap' }}>{l}</div>
          ))}
        </div>
        <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', borderTop: `1px solid ${C.border}` }}>
          <div style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13 }}>取消</div>
          <div
            data-anchor="w6-dlg-ok"
            style={{
              height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', borderRadius: 4, fontSize: 13, color: '#fff',
              background: accept ? (hover === 'accOk' ? C.accentHover : C.accent) : hover === 'resOk' ? '#f0777e' : C.red,
            }}
          >
            {accept ? '接受' : '还原'}
          </div>
        </div>
        <span style={{ display: 'none' }}>{`${CFM_BTN.ok.x},${CFM_BTN.cancel.x}`}</span>
      </div>
    </div>
  );
};

const ExportDialog: React.FC<{ t: number; hover: T6 }> = ({ t, hover }) => (
  <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.55 * t})`, zIndex: 50 }}>
    <div
      style={{
        position: 'absolute', left: EXP_DLG.x, top: EXP_DLG.y, width: EXP_DLG.w, height: EXP_DLG.h,
        boxSizing: 'border-box', background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>导出暂存备份</span>
      </div>
      <div style={{ flex: 1, padding: '14px 18px', overflow: 'hidden' }}>
        <div style={{ fontSize: 12, color: C.text1, lineHeight: 1.6, marginBottom: 8 }}>
          将 <b style={{ color: C.accent }}>1</b> 个条目的首次快照导出为备份文件
        </div>
        {([
          { title: '导出备份到本地', desc: '复制到项目目录 .aishell/backup/，文件名自动加 _bakYYYYMMDD-HHMM 后缀', checked: true },
          { title: '导出备份到远程', desc: '上传回文件原所在的远程服务器目录，同样加 _bak 时间后缀', checked: false },
        ] as const).map((o, i) => (
          <div
            key={o.title}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', marginBottom: 6,
              border: `1px solid ${o.checked ? C.accent : C.border}`, borderRadius: 6,
              background: o.checked ? C.accentDim : 'transparent',
            }}
          >
            <span
              style={{
                width: 13, height: 13, borderRadius: '50%', flex: 'none', marginTop: 3,
                border: `1px solid ${o.checked ? C.accent : C.borderStrong}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}
            >
              {o.checked && <span style={{ width: 7, height: 7, borderRadius: '50%', background: C.accent }} />}
            </span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block', fontWeight: 600, fontSize: 12.5, color: C.text1 }}>{o.title}</span>
              <span style={{ display: 'block', fontSize: 11, color: C.text2, lineHeight: 1.5, marginTop: 2, whiteSpace: 'nowrap' }}>{o.desc}</span>
            </span>
            <span style={{ display: 'none' }}>{i}</span>
          </div>
        ))}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10, fontSize: 12, color: C.text1, whiteSpace: 'nowrap' }}>
          <Checkbox size={12} />
          同时接受变更（导出完成后清除已导出的暂存条目，不改远程文件）
        </label>
      </div>
      <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', borderTop: `1px solid ${C.border}` }}>
        <div style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13 }}>取消</div>
        <div data-anchor="w6-exp-ok" style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4, fontSize: 13, color: '#fff', background: hover === 'expOk' ? C.accentHover : C.accent }}>
          <Icon name="download" size={13} /> 导出
        </div>
        <span style={{ display: 'none' }}>{`${EXP_ACCEPT.x},${EXP_BTN.ok.x}`}</span>
      </div>
    </div>
  </div>
);

/* ---------- 状态栏 / Toast ---------- */

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

export const Wb6: React.FC<{ state: Wb6State; frame: number }> = ({ state, frame }) => (
  <div
    style={{
      position: 'absolute', width: WIN_W, height: WIN_H, background: C.bg0, color: C.text0,
      fontFamily: FONT_UI, fontSize: 13, borderRadius: 14, border: `1px solid ${C.borderStrong}`,
      overflow: 'hidden', boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
    }}
  >
    <TopBar active="项目" project={DEMO.projectName} />

    <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 26, display: 'flex' }}>
      <ActivityBar />

      <div style={{ position: 'relative', width: 260, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
        <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 10px 0 14px', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: C.text1 }}>
          服务器列表
        </div>
        <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
          <ServersPanel />
        </div>
      </div>

      {/* 中央:四标签(keep-alive 常驻,仅切显隐) */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg0 }}>
        <div style={{ height: 36, flex: 'none', display: 'flex', alignItems: 'stretch', background: C.bg1, borderBottom: `1px solid ${C.border}`, overflow: 'hidden' }}>
          <WbTab icon="terminal" title="本地终端" active={state.centerTab === 'terminal'} />
          <WbTab icon="globe" title="浏览器" active={state.centerTab === 'browser'} />
          {state.stagingTabT > 0 && (
            <div style={{ width: TAB_W * state.stagingTabT, opacity: state.stagingTabT, overflow: 'hidden', display: 'flex' }}>
              <WbTab icon="history" title="文件暂存区" active={state.centerTab === 'staging'} w={TAB_W} anchor="w6-tab-staging" />
            </div>
          )}
          {state.diffTabT > 0 && (
            <div style={{ width: TAB_W * state.diffTabT, opacity: state.diffTabT, overflow: 'hidden', display: 'flex' }}>
              <WbTab icon="diff" title={DEMO.file1Name} active={state.centerTab === 'diff'} w={TAB_W} />
            </div>
          )}
        </div>
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <div style={{ position: 'absolute', inset: 0, display: state.centerTab === 'terminal' ? 'flex' : 'none' }}>
            <TermPane frame={frame} />
          </div>
          <div style={{ position: 'absolute', inset: 0, display: state.centerTab === 'browser' ? 'flex' : 'none' }}>
            <BrowserPaneStatic />
          </div>
          <div style={{ position: 'absolute', inset: 0, display: state.centerTab === 'staging' ? 'flex' : 'none' }}>
            <StagingPanel st={state} />
          </div>
          <div style={{ position: 'absolute', inset: 0, display: state.centerTab === 'diff' ? 'flex' : 'none' }}>
            <DiffPanel />
          </div>
        </div>
      </div>

      <AiPanel st={state} frame={frame} />
    </div>

    <Statusbar />

    {/* 覆盖层:会话菜单 45 < toast 46 < 模态 50 */}
    {state.toast && (
      <div
        style={{
          position: 'absolute', right: 24, bottom: 34, padding: '11px 18px', background: C.bg2,
          border: `1px solid ${C.borderStrong}`, borderRadius: 8, fontSize: 12.5,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)', whiteSpace: 'nowrap', zIndex: 46,
        }}
      >
        {state.toast}
      </div>
    )}
    {state.dialog && <ConfirmDialog kind={state.dialog} t={state.dialogT} hover={state.hover} />}
    {state.exportDlg && <ExportDialog t={state.exportDlgT} hover={state.hover} />}
  </div>
);
