/**
 * 视频八工作台/账号页复刻:云同步与云备份。双页面(page 切换,pageT 淡入淡出):
 * 工作台(资源管理器文件树右键「备份到云端」+「备份到云端」确认框 + 底栏云备份进度 +
 * AI 面板静态历史)、账号页(Account.tsx 左导航 + CloudSyncView:状态 chip 工具栏/概要统计卡/
 * 配置同步规模/设备管理/冲突/云端备份/危险区,绝对定位 + 校正层,锚点=窗口坐标)。
 * 弹窗:PasswordModal(设置/解锁云同步密码)与 RestoreModal(恢复云端备份)。
 * 全部内容由 state(Wb8State)驱动,锚点见 ./layout.ts。
 */
import React from 'react';
import { TopBar } from '../components/TopBar';
import { C, FONT_MONO, FONT_UI, IconName } from '../theme';
import { Icon } from '../ui';
import { WIN_H, WIN_W } from '../scene';
import {
  ACC, CFM8, CFM8_BTN, CHAT, ChatItem, DEMO, EXPL, EXPL_MENU, EXPL_ROW_DATASET, ITEM_W, MENU_BACKUP,
  NAV_ACCOUNT_SYNC, PWD8, PWD8_F, PROG, RST8, RST8_F, TAB_W, TERM_BASE, TermLine, TOAST8, TOP_NAV,
  TREE, accNavCy, accScaleCardX, accSumCardX, explMenuItemCy, explRowY,
} from './layout';

/* ---------- 状态 ---------- */

export type T8 =
  | 'accountNav' | 'projNav' | 'dataset' | 'menuBackup'
  | 'setPwd' | 'pwdOk' | 'sync' | 'lock' | 'unlock'
  | 'restore' | 'rstOk' | 'cfmOk'
  | null;

export interface Wb8State {
  page: 'workbench' | 'account';
  pageT: number;
  /** 云同步已初始化(设置密码后) */
  initialized: boolean;
  /** 锁定态:初始化前 true;INIT_OK→false;锁定→true;解锁→false */
  locked: boolean;
  syncing: boolean;
  /** 配置规模卡有数字(首次同步完成后) */
  counts: boolean;
  /** 云端备份条目(备份任务完成后) */
  backupEntry: boolean;
  /** 条目名隐藏(锁定态) */
  backupLocked: boolean;
  pwdDlg: 'init' | 'unlock' | null;
  pwdT: number;
  pwdText: string;
  cfm: boolean;
  cfmT: number;
  rst: boolean;
  rstT: number;
  toast: string | null;
  /** 底栏进度 0..1,null=无 */
  progress: number | null;
  progressDetail: string;
  menu: { open: boolean; hover: number } | null;
  items: ChatItem[];
  hover: T8;
  press: T8;
}

/* ---------- 小组件 ---------- */

const Spinner: React.FC<{ frame?: number; size?: number; color?: string }> = ({ frame = 0, size = 11, color = C.text2 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} style={{ opacity: frame % 20 < 10 ? 1 : 0.45 }}>
    <g fill="none" stroke={color} strokeWidth={2.6} strokeLinecap="round">
      <path d="M12 3a9 9 0 1 1-9 9" opacity={0.35} />
      <path d="M12 3a9 9 0 0 1 6.4 2.6" />
    </g>
  </svg>
);

const btnSmall = (primary: boolean, opts: { hovered?: boolean; danger?: boolean; dangerSolid?: boolean } = {}): React.CSSProperties => ({
  height: 28,
  padding: '0 10px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  borderRadius: 4,
  border: `1px solid ${primary ? C.accent : opts.danger || opts.dangerSolid ? C.red : C.border}`,
  background: primary
    ? (opts.hovered ? C.accentHover : C.accent)
    : opts.dangerSolid ? (opts.hovered ? '#f0777e' : C.red) : opts.hovered ? C.bg3 : C.bg2,
  color: primary || opts.dangerSolid ? '#fff' : opts.hovered ? C.text0 : C.text1,
  fontSize: 12,
  lineHeight: '16px',
  whiteSpace: 'nowrap',
});

const iconBtn26: React.CSSProperties = {
  width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center',
  borderRadius: 4, color: C.text2, flex: 'none',
};

/* ---------- 活动栏 / 资源管理器侧栏 ---------- */

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
      const active = it.id === 'explorer';
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

const MENU_ITEMS: { label: string; icon: IconName }[] = [
  { label: '新建文件', icon: 'filePlus' },
  { label: '新建文件夹', icon: 'folderPlus' },
  { label: '在终端中打开', icon: 'terminal' },
  { label: '备份到云端', icon: 'cloudBackup' },
];

const ExplorerPanel: React.FC<{ st: Wb8State }> = ({ st }) => (
  <div style={{ position: 'relative', width: 260, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
    <div style={{ height: 34, flex: 'none', display: 'flex', alignItems: 'center', padding: '0 10px 0 14px', fontSize: 11, fontWeight: 600, letterSpacing: 0.5, color: C.text1 }}>
      资源管理器
    </div>
    <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      {TREE.map((node, i) => {
        const target = i === EXPL_ROW_DATASET;
        return (
          <div
            key={node.name}
            data-anchor={target ? 'w8-dataset' : undefined}
            style={{
              position: 'absolute', left: 0, right: 0, top: explRowY(i) - EXPL.top, height: EXPL.rowH,
              display: 'flex', alignItems: 'center', gap: 6, paddingLeft: 10 + node.depth * EXPL.indent,
              fontSize: 12.5, color: target && st.hover === 'dataset' ? C.text0 : C.text1,
              background: target && (st.hover === 'dataset' || st.menu?.open) ? C.bgHover : 'transparent',
            }}
          >
            <span style={{ display: 'flex', color: C.text2 }}><Icon name={node.icon} size={14} /></span>
            {node.name}
          </div>
        );
      })}
      {/* 右键菜单 */}
      {st.menu?.open && (
        <div
          style={{
            position: 'absolute', left: EXPL_MENU.x - 48, top: EXPL_MENU.y - 74, width: EXPL_MENU.w, padding: EXPL_MENU.pad,
            background: C.bg2, border: `1px solid ${C.borderStrong}`, borderRadius: 6,
            boxShadow: '0 4px 16px rgba(0,0,0,0.4)', display: 'flex', flexDirection: 'column', zIndex: 45,
          }}
        >
          {MENU_ITEMS.map((it, i) => {
            const backup = i === MENU_BACKUP;
            return (
              <div
                key={it.label}
                data-anchor={backup ? 'w8-menu-backup' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 7, height: EXPL_MENU.itemH, padding: '0 10px', borderRadius: 4,
                  fontSize: 12.5, color: st.menu!.hover === i ? C.text0 : backup ? C.accent : C.text1,
                  background: st.menu!.hover === i ? C.bgHover : 'transparent',
                }}
              >
                <span style={{ display: 'flex', color: st.menu!.hover === i ? C.text0 : backup ? C.accent : C.text2 }}>
                  <Icon name={it.icon} size={13} />
                </span>
                {it.label}
              </div>
            );
          })}
          <span style={{ display: 'none' }}>{`${explMenuItemCy(MENU_BACKUP)}`}</span>
        </div>
      )}
    </div>
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

/* ---------- AI 面板(静态历史) ---------- */

const UserBubble: React.FC<{ item: ChatItem }> = ({ item }) =>
  item.kind !== 'user' ? null : (
    <div style={{ position: 'absolute', left: CHAT.l - 1580, top: item.y - 80, width: CHAT.w, display: 'flex', justifyContent: 'flex-end' }}>
      <div style={{ maxWidth: ITEM_W, padding: '8px 11px', borderRadius: 10, borderBottomRightRadius: 3, background: C.accentDim, fontSize: 12.5, lineHeight: '20px' }}>
        {item.chip && (
          <span style={{ display: 'inline-flex', alignItems: 'center', padding: '0 5px', borderRadius: 4, background: 'rgba(79,142,247,0.28)', border: `1px solid ${C.accent}`, color: C.accentHover, fontSize: 11.5, marginRight: 4 }}>
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

const AiBubble: React.FC<{ item: ChatItem }> = ({ item }) =>
  item.kind !== 'ai' ? null : (
    <div style={{ position: 'absolute', left: CHAT.l - 1580, top: item.y - 80, width: ITEM_W }}>
      <div style={{ maxWidth: ITEM_W, padding: '8px 11px', borderRadius: 10, borderBottomLeftRadius: 3, background: C.bg2, fontSize: 12.5, lineHeight: '20px' }}>
        {item.lines.map((l, i) => (
          <span key={i}>
            {l}
            {i < item.lines.length - 1 && <br />}
          </span>
        ))}
      </div>
    </div>
  );

const ActionCard: React.FC<{ item: ChatItem }> = ({ item }) => {
  if (item.kind !== 'action') return null;
  return (
    <div
      style={{
        position: 'absolute', left: CHAT.l - 1580, top: item.y - 80, width: ITEM_W, boxSizing: 'border-box',
        padding: '8px 10px', background: C.bg2, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.green}`,
        borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 5,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, height: 20 }}>
        <span style={{ fontWeight: 600, fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
          <Icon name={item.spec.icon} size={13} />
          {item.spec.name}
        </span>
        <span style={{ fontSize: 11, color: C.green }}>成功</span>
      </div>
      {item.spec.cmd && (
        <div style={{ boxSizing: 'border-box', padding: '4px 8px', background: '#14161b', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, lineHeight: '20px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.spec.cmd}
        </div>
      )}
      {item.spec.result && (
        <div style={{ boxSizing: 'border-box', padding: '4px 8px', background: '#14161b', border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, lineHeight: '20px', color: C.text1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {item.spec.result}
        </div>
      )}
    </div>
  );
};

const AiPanel: React.FC<{ st: Wb8State }> = ({ st }) => (
  <div style={{ position: 'relative', width: 340, flex: 'none', background: C.bg1, borderLeft: `1px solid ${C.border}`, display: 'flex', flexDirection: 'column' }}>
    <div style={{ height: 40, flex: 'none', display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', borderBottom: `1px solid ${C.border}` }}>
      <div
        style={{
          flex: 1, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6,
          padding: '0 8px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12, color: C.text0,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Nebula 官网改版</span>
        <Icon name="chevronDown" size={12} color={C.text2} />
      </div>
      <div style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text1, borderRadius: 4 }}>
        <Icon name="plus" size={14} />
      </div>
    </div>
    <div style={{ flex: 1, minHeight: 0, position: 'relative', overflow: 'hidden' }}>
      {st.items.map((item) =>
        item.kind === 'user' ? (
          <UserBubble key={item.id} item={item} />
        ) : item.kind === 'ai' ? (
          <AiBubble key={item.id} item={item} />
        ) : (
          <ActionCard key={item.id} item={item} />
        ),
      )}
    </div>
    <div style={{ flex: 'none', height: 148, boxSizing: 'border-box', borderTop: `1px solid ${C.border}`, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 0', fontSize: 11, color: C.text2, flex: 'none' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="bot" size={12} /> AI 模式
        </span>
        <div style={{ width: 74, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text0, fontSize: 12, boxSizing: 'border-box', flex: 'none' }}>
          工作
          <Icon name="chevronDown" size={10} color={C.text2} />
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Icon name="zap" size={12} /> 思考强度
        </span>
        <div style={{ width: 78, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 6px', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, color: C.text0, fontSize: 12, boxSizing: 'border-box', flex: 'none' }}>
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
          position: 'relative', flex: 1, minHeight: 0, padding: '8px 10px', background: C.bg2,
          border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12.5, lineHeight: '20px',
        }}
      >
        <span style={{ color: C.text2 }}>向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器</span>
        <span style={{ position: 'absolute', right: 6, bottom: 4, fontSize: 10.5, color: C.text2 }}>Enter 发送</span>
      </div>
    </div>
  </div>
);

/* ---------- 底栏(含云备份进度) ---------- */

const Statusbar: React.FC<{ st: Wb8State; frame: number }> = ({ st, frame }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 26, display: 'flex', alignItems: 'center', padding: '0 8px', background: C.bg1, borderTop: `1px solid ${C.border}`, color: C.text1, fontSize: 11 }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, marginRight: 12 }}>
      <Icon name="folder" size={12} />
      {DEMO.projectName}
    </span>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: C.text2 }}>
      <Icon name="terminal" size={12} />
      本地终端
    </span>
    {st.progress !== null && (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 16, color: C.text1 }}>
        <Spinner frame={frame} size={11} color={C.accent} />
        云备份 上传中
        <span style={{ width: PROG.barW, height: PROG.barH, borderRadius: 2, background: C.bg3, overflow: 'hidden', display: 'inline-flex' }}>
          <span style={{ width: PROG.barW * st.progress, height: '100%', background: C.accent }} />
        </span>
        {Math.round(st.progress * 100)}%
        <span style={{ color: C.text2 }}>{st.progressDetail}</span>
      </span>
    )}
    <div style={{ flex: 1 }} />
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: '0 8px', borderRadius: 4, background: C.accentDim, color: C.accent }}>
      <Icon name="bot" size={12} /> AI 助手
    </span>
    <span style={{ display: 'none' }}>{`${PROG.x},${PROG.y}`}</span>
  </div>
);

/* ---------- 账号页 ---------- */

const ACC_NAV: { label: string; icon: IconName }[] = [
  { label: '账号信息', icon: 'user' },
  { label: '用量报表', icon: 'chart' },
  { label: '记忆宫殿', icon: 'database' },
  { label: '用户反馈', icon: 'message' },
  { label: '云同步', icon: 'cloudSync' },
];

const SecTitle: React.FC<{ x: number; cy: number; icon: IconName; text: string }> = ({ x, cy, icon, text }) => (
  <div style={{ position: 'absolute', left: x, top: cy - 10, display: 'flex', alignItems: 'center', gap: 7, fontSize: 13, fontWeight: 600, color: C.text0, whiteSpace: 'nowrap' }}>
    <span style={{ display: 'flex', color: C.text1 }}><Icon name={icon} size={14} /></span>
    {text}
  </div>
);

const StatCard: React.FC<{ x: number; y: number; w: number; h: number; label: string; value: string; accent?: boolean }> = ({ x, y, w, h, label, value, accent }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, boxSizing: 'border-box', padding: '10px 12px', background: C.bg1, border: `1px solid ${C.border}`, borderRadius: 8, overflow: 'hidden' }}>
    <div style={{ fontSize: 11, color: C.text2, marginBottom: 5, whiteSpace: 'nowrap' }}>{label}</div>
    <div style={{ fontSize: 14, fontWeight: 600, color: accent ? C.accent : C.text0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</div>
  </div>
);

const AccountPage: React.FC<{ st: Wb8State; frame: number }> = ({ st, frame }) => {
  const chipIcon: IconName = !st.initialized || st.locked ? 'lock' : st.syncing ? 'sync' : 'cloudSync';
  const chipText = !st.initialized || st.locked ? '需要解锁' : st.syncing ? '同步中' : '已就绪';
  const chipColor = !st.initialized || st.locked ? C.text2 : C.accent;
  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 0, display: 'flex', background: C.bg0 }}>
      {/* 左导航 */}
      <div style={{ width: ACC.navW, flex: 'none', background: C.bg1, borderRight: `1px solid ${C.border}`, padding: '14px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {ACC_NAV.map((it, i) => {
          const active = i === NAV_ACCOUNT_SYNC;
          return (
            <div
              key={it.label}
              style={{
                height: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRadius: 6,
                fontSize: 12.5, color: active ? C.accent : C.text2,
                background: active ? C.accentDim : st.hover === 'accountNav' && i === NAV_ACCOUNT_SYNC ? C.bgHover : 'transparent',
                fontWeight: active ? 600 : 400,
              }}
            >
              <Icon name={it.icon} size={14} />
              {it.label}
            </div>
          );
        })}
        <span style={{ display: 'none' }}>{`${accNavCy(NAV_ACCOUNT_SYNC)}`}</span>
      </div>
      {/* 内容(view head + CloudSyncView;校正层让子元素直接用窗口坐标) */}
      <div style={{ flex: 1, minWidth: 0, position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: -ACC.viewX + 24, top: -40 }}>
          <div style={{ position: 'absolute', left: ACC.viewX, top: ACC.headCy - 11, display: 'flex', alignItems: 'center', gap: 8, fontSize: 15, fontWeight: 600, whiteSpace: 'nowrap' }}>
            <span style={{ display: 'flex', color: C.text1 }}><Icon name="cloudSync" size={15} /></span>
            云同步
          </div>

          {/* 工具栏 */}
          <span style={{ position: 'absolute', left: ACC.chip.x, top: ACC.chip.y - 9, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, color: chipColor, whiteSpace: 'nowrap' }}>
            <span style={{ display: 'flex' }}>
              {st.syncing ? <Spinner frame={frame} size={14} color={chipColor} /> : <Icon name={chipIcon} size={14} />}
            </span>
            {chipText}
          </span>
          <span style={{ position: 'absolute', left: ACC.btnRefresh.x, top: ACC.btnRefresh.y, ...btnSmall(false, {}) }}>
            <Icon name="refresh" size={12} /> 刷新
          </span>
          {!st.initialized ? (
            <span
              data-anchor="w8-setpwd"
              style={{ position: 'absolute', left: ACC.btnUnlock.x, top: ACC.btnUnlock.y, width: ACC.btnUnlock.w, boxSizing: 'border-box', justifyContent: 'center', ...btnSmall(true, { hovered: st.hover === 'setPwd' }) }}
            >
              设置同步密码
            </span>
          ) : st.locked ? (
            <span
              data-anchor="w8-setpwd"
              style={{ position: 'absolute', left: ACC.btnUnlock.x, top: ACC.btnUnlock.y, width: ACC.btnUnlock.w, boxSizing: 'border-box', justifyContent: 'center', ...btnSmall(true, { hovered: st.hover === 'unlock' }) }}
            >
              解锁云同步
            </span>
          ) : (
            <>
              <span data-anchor="w8-sync" style={{ position: 'absolute', left: ACC.btnSync.x, top: ACC.btnSync.y, ...btnSmall(true, { hovered: st.hover === 'sync' }) }}>
                <Icon name="sync" size={12} /> 立即同步
              </span>
              <span data-anchor="w8-lock" style={{ position: 'absolute', left: ACC.btnLock.x, top: ACC.btnLock.y, ...btnSmall(false, { hovered: st.hover === 'lock' }) }}>
                <Icon name="lock" size={12} /> 锁定
              </span>
            </>
          )}

          {/* 概要统计卡 */}
          {(st.counts ? DEMO.summaryAfter : DEMO.summary).map((s, i) => (
            <StatCard key={s.label} x={accSumCardX(i)} y={ACC.sumTop} w={ACC.sumCardW} h={ACC.sumH} label={s.label} value={s.value} accent={i === 0 && st.counts} />
          ))}

          {/* 配置同步规模 */}
          <div style={{ position: 'absolute', left: ACC.viewX, top: ACC.scaleTop, width: ACC.viewW, height: 106, boxSizing: 'border-box', border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg1 }} />
          <SecTitle x={ACC.viewX + 14} cy={ACC.scaleTitleCy} icon="cloudSync" text="配置同步规模" />
          {st.counts ? (
            DEMO.counts.map((c, i) => (
              <StatCard key={c.label} x={accScaleCardX(i)} y={ACC.scaleCardTop} w={142} h={ACC.scaleCardH} label={c.label} value={String(c.value)} />
            ))
          ) : (
            <div style={{ position: 'absolute', left: ACC.viewX + 14, top: ACC.scaleCardTop + 8, width: 800, fontSize: 11.5, color: C.text2 }}>
              尚未同步过核心配置。
            </div>
          )}

          {/* 设备管理 */}
          <div style={{ position: 'absolute', left: ACC.viewX, top: ACC.devTop, width: ACC.viewW, height: 112, boxSizing: 'border-box', border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg1 }} />
          <SecTitle x={ACC.viewX + 14} cy={ACC.devTitleCy} icon="device" text="设备管理" />
          {!st.initialized || st.locked ? (
            <div style={{ position: 'absolute', left: ACC.viewX + 14, top: ACC.devRow1 + 4, width: 800, fontSize: 11.5, color: C.text2 }}>
              解锁后可管理设备。
            </div>
          ) : (
            DEMO.devices.map((d, i) => (
              <div
                key={d.name}
                style={{
                  position: 'absolute', left: ACC.viewX + 14, top: i === 0 ? ACC.devRow1 : ACC.devRow2, width: ACC.viewW - 28, height: ACC.devRowH,
                  boxSizing: 'border-box', padding: '4px 8px', border: `1px solid ${C.border}`, borderRadius: 6,
                  display: 'flex', alignItems: 'center', gap: 8,
                }}
              >
                <span style={{ display: 'flex', color: C.text1 }}><Icon name={d.current ? 'monitor' : 'device'} size={14} /></span>
                <span style={{ fontSize: 12, fontWeight: 600, color: C.text0, minWidth: 100 }}>{d.name}{d.current ? '（本机）' : ''}</span>
                <span style={{ fontSize: 11, color: C.text2, flex: 1 }}>最近活动:{d.seen}</span>
                <span style={iconBtn26}><Icon name="pencil" size={13} /></span>
                {!d.current && <span style={iconBtn26}><Icon name="trash" size={13} /></span>}
              </div>
            ))
          )}

          {/* 冲突 */}
          <div style={{ position: 'absolute', left: ACC.viewX, top: ACC.cflTop, width: ACC.viewW, height: 62, boxSizing: 'border-box', border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg1 }} />
          <SecTitle x={ACC.viewX + 14} cy={ACC.cflTitleCy} icon="alert" text="冲突" />
          <div style={{ position: 'absolute', left: ACC.viewX + 14, top: ACC.cflHintY, width: 800, fontSize: 11.5, color: C.text2 }}>
            暂无待处理冲突。
          </div>

          {/* 云端备份 */}
          <div style={{ position: 'absolute', left: ACC.viewX, top: ACC.bkTop, width: ACC.viewW, height: 148, boxSizing: 'border-box', border: `1px solid ${C.border}`, borderRadius: 8, background: C.bg1 }} />
          <SecTitle x={ACC.viewX + 14} cy={ACC.bkTitleCy} icon="cloudBackup" text="云端备份" />
          {st.backupEntry ? (
            <div
              style={{
                position: 'absolute', left: ACC.viewX + 14, top: ACC.bkRow, width: ACC.viewW - 28, height: ACC.bkRowH,
                boxSizing: 'border-box', padding: '5px 8px', border: `1px solid ${C.border}`, borderRadius: 6,
                display: 'flex', alignItems: 'center', gap: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.text0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {st.backupLocked ? '已加密备份（需解锁查看名称）' : DEMO.backupName}
                </div>
                <div style={{ fontSize: 11, color: C.text2, marginTop: 3, whiteSpace: 'nowrap' }}>{DEMO.backupMeta}</div>
              </div>
              <span
                data-anchor="w8-restore"
                style={{
                  ...btnSmall(true, { hovered: st.hover === 'restore' }),
                  opacity: st.backupLocked ? 0.45 : 1,
                }}
              >
                恢复
              </span>
              <span style={iconBtn26}><Icon name="trash" size={13} /></span>
            </div>
          ) : (
            <div style={{ position: 'absolute', left: ACC.viewX + 14, top: ACC.bkRow + 6, width: 800, fontSize: 11.5, color: C.text2 }}>
              暂无云端备份。可在文件资源管理器右键选择“备份到云端”。
            </div>
          )}
          <div style={{ position: 'absolute', left: ACC.viewX + 14, top: ACC.bkLimitsY, width: 800, fontSize: 11, color: C.text2 }}>
            {DEMO.backupLimit}
          </div>

          {/* 危险区(解锁后可见) */}
          {st.initialized && !st.locked && (
            <>
              <span style={{ position: 'absolute', left: ACC.dzChange.x, top: ACC.dzChange.y, width: ACC.dzChange.w, boxSizing: 'border-box', justifyContent: 'center', ...btnSmall(false, {}) }}>
                修改同步密码
              </span>
              <span style={{ position: 'absolute', left: ACC.dzDelete.x, top: ACC.dzDelete.y, width: ACC.dzDelete.w, boxSizing: 'border-box', justifyContent: 'center', ...btnSmall(false, { dangerSolid: true }) }}>
                删除全部云端数据
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

/* ---------- 密码弹窗(PasswordModal) ---------- */

const PasswordModal: React.FC<{ st: Wb8State }> = ({ st }) => {
  if (!st.pwdDlg) return null;
  const t = st.pwdT;
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute', left: PWD8.x, top: PWD8.y, width: PWD8.w, height: PWD8.h, boxSizing: 'border-box',
          background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{st.pwdDlg === 'init' ? '设置云同步密码' : '解锁云同步'}</span>
          <Icon name="x" size={14} color={C.text2} />
        </div>
        <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: -PWD8.x, top: -(PWD8.y + 48), width: PWD8.w, height: PWD8.h - 48 }}>
          <div style={{ position: 'absolute', left: PWD8_F.input.x, top: PWD8_F.labelCy - 9, fontSize: 12.5, color: C.text1, whiteSpace: 'nowrap' }}>同步密码</div>
          <div
            data-anchor="w8-pwd-input"
            style={{
              position: 'absolute', left: PWD8_F.input.x, top: PWD8_F.input.y, width: PWD8_F.input.w, height: PWD8_F.input.h, boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', padding: '0 10px', background: C.bg0, border: `1px solid ${C.accent}`,
              borderRadius: 4, fontSize: 14, letterSpacing: 2, color: C.text0,
            }}
          >
            {st.pwdText}
            <span style={{ display: 'inline-block', width: 1.5, height: 14, background: C.accent, marginLeft: 2 }} />
          </div>
          <div style={{ position: 'absolute', left: PWD8_F.input.x, top: PWD8_F.hintY, width: 392, fontSize: 11, color: C.text2, lineHeight: 1.6 }}>
            密码只用于本机解锁云端加密数据，不会上传到云端或写入配置文件。
          </div>
          </div>
        </div>
        <div style={{ height: 52, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', borderTop: `1px solid ${C.border}` }}>
          <div style={{ height: 30, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text1 }}>取消</div>
          <div data-anchor="w8-pwd-ok" style={{ height: 30, padding: '0 14px', display: 'flex', alignItems: 'center', borderRadius: 4, fontSize: 12.5, color: '#fff', background: st.hover === 'pwdOk' ? C.accentHover : C.accent }}>
            确定
          </div>
        </div>
        <span style={{ display: 'none' }}>{`${PWD8_F.btnOk.x},${PWD8_F.btnCancel.x}`}</span>
      </div>
    </div>
  );
};

/* ---------- 「备份到云端」确认框 ---------- */

const BackupConfirmDialog: React.FC<{ t: number; hover: T8 }> = ({ t, hover }) => (
  <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
    <div
      style={{
        position: 'absolute', left: CFM8.x, top: 600 - CFM8.h / 2, width: CFM8.w, height: CFM8.h,
        boxSizing: 'border-box', background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
        boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
        display: 'flex', flexDirection: 'column',
      }}
    >
      <div style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>备份到云端</span>
        <Icon name="x" size={14} color={C.text2} />
      </div>
      <div style={{ flex: 1, padding: '14px 18px', color: C.text1, fontSize: 12.5, lineHeight: '20px' }}>
        <div>将备份「{DEMO.datasetPath}」</div>
        <div>及其内容，共 128 个文件、2.4 GB。</div>
        <div>文件可能包含敏感信息，请确认后继续。</div>
      </div>
      <div style={{ height: 56, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', borderTop: `1px solid ${C.border}` }}>
        <div style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 13, color: C.text1 }}>取消</div>
        <div data-anchor="w8-cfm-ok" style={{ height: 32, padding: '0 14px', display: 'flex', alignItems: 'center', borderRadius: 4, fontSize: 13, color: '#fff', background: hover === 'cfmOk' ? C.accentHover : C.accent }}>
          开始备份
        </div>
      </div>
      <span style={{ display: 'none' }}>{`${CFM8_BTN.ok.x},${CFM8_BTN.cancel.x}`}</span>
    </div>
  </div>
);

/* ---------- 恢复弹窗(RestoreModal) ---------- */

const RestoreModal: React.FC<{ st: Wb8State }> = ({ st }) => {
  if (!st.rst) return null;
  const t = st.rstT;
  return (
    <div style={{ position: 'absolute', inset: 0, background: `rgba(8,10,14,${0.5 * t})`, zIndex: 50 }}>
      <div
        style={{
          position: 'absolute', left: RST8.x, top: RST8.y, width: RST8.w, height: RST8.h, boxSizing: 'border-box',
          background: C.bg1, border: `1px solid ${C.borderStrong}`, borderRadius: 10,
          boxShadow: '0 8px 32px rgba(0,0,0,0.55)', opacity: t, transform: `translateY(${8 - 8 * t}px)`,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ height: 48, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 18px', borderBottom: `1px solid ${C.border}` }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>恢复云端备份</span>
          <Icon name="x" size={14} color={C.text2} />
        </div>
        <div style={{ position: 'relative', flex: 1, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: -RST8.x, top: -(RST8.y + 48), width: RST8.w, height: RST8.h - 48 }}>
          <div style={{ position: 'absolute', left: RST8_F.targetInput.x, top: RST8_F.hintY, width: 452, fontSize: 11.5, color: C.text2, lineHeight: 1.6 }}>
            备份:{DEMO.backupName},大小 2.4 GB,文件 128 个。
          </div>
          <div style={{ position: 'absolute', left: RST8_F.targetInput.x, top: RST8_F.targetLabelCy - 9, fontSize: 12.5, color: C.text1, whiteSpace: 'nowrap' }}>恢复到本地目录</div>
          <div
            style={{
              position: 'absolute', left: RST8_F.targetInput.x, top: RST8_F.targetInput.y, width: RST8_F.targetInput.w, height: RST8_F.targetInput.h, boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', padding: '0 10px', background: C.bg0, border: `1px solid ${C.border}`,
              borderRadius: 4, fontSize: 12.5, color: C.text0, fontFamily: FONT_MONO, whiteSpace: 'nowrap', overflow: 'hidden',
            }}
          >
            {DEMO.restoreTarget}
          </div>
          <div style={{ position: 'absolute', left: RST8_F.browseBtn.x, top: RST8_F.browseBtn.y, height: RST8_F.browseBtn.h, padding: '0 10px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text1, whiteSpace: 'nowrap' }}>
            浏览…
          </div>
          <div style={{ position: 'absolute', left: RST8_F.sel.x, top: RST8_F.selLabelCy - 9, fontSize: 12.5, color: C.text1, whiteSpace: 'nowrap' }}>遇到同名文件</div>
          <div
            style={{
              position: 'absolute', left: RST8_F.sel.x, top: RST8_F.sel.y, width: RST8_F.sel.w, height: RST8_F.sel.h, boxSizing: 'border-box',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 10px', background: C.bg0,
              border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text0,
            }}
          >
            保留两份（推荐）
            <Icon name="chevronDown" size={12} color={C.text2} />
          </div>
          </div>
        </div>
        <div style={{ height: 52, flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '0 18px', borderTop: `1px solid ${C.border}` }}>
          <div style={{ height: 30, padding: '0 14px', display: 'flex', alignItems: 'center', background: C.bg2, border: `1px solid ${C.border}`, borderRadius: 4, fontSize: 12.5, color: C.text1 }}>取消</div>
          <div data-anchor="w8-rst-ok" style={{ height: 30, padding: '0 14px', display: 'flex', alignItems: 'center', gap: 6, borderRadius: 4, fontSize: 12.5, color: '#fff', background: st.hover === 'rstOk' ? C.accentHover : C.accent }}>
            <Icon name="cloudBackup" size={12} /> 开始恢复
          </div>
        </div>
        <span style={{ display: 'none' }}>{`${RST8_F.btnOk.x},${RST8_F.sel.x}`}</span>
      </div>
    </div>
  );
};

/* ---------- 主组件 ---------- */

export const Wb8: React.FC<{ state: Wb8State; frame: number }> = ({ state, frame }) => {
  const st = state;
  return (
    <div
      style={{
        position: 'absolute', width: WIN_W, height: WIN_H, background: C.bg0, color: C.text0,
        fontFamily: FONT_UI, fontSize: 13, borderRadius: 14, border: `1px solid ${C.borderStrong}`,
        overflow: 'hidden', boxShadow: '0 40px 120px rgba(0,0,0,0.55)',
      }}
    >
      <TopBar active={st.page === 'workbench' ? '项目' : '账号'} project={st.page === 'workbench' ? DEMO.projectName : undefined} anchors={{ project: 'w8-proj-nav', account: 'w8-acc-nav' }} />

      {/* 工作台页面 */}
      <div style={{ position: 'absolute', left: 0, right: 0, top: 40, bottom: 26, display: 'flex', opacity: 1 - st.pageT, pointerEvents: st.page === 'workbench' ? 'auto' : 'none' }}>
        <ActivityBar />
        <ExplorerPanel st={st} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: C.bg0 }}>
          <div style={{ height: 36, flex: 'none', display: 'flex', alignItems: 'stretch', background: C.bg1, borderBottom: `1px solid ${C.border}`, overflow: 'hidden' }}>
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 0 12px', width: TAB_W, flex: 'none',
                borderRight: `1px solid ${C.border}`, borderTop: `2px solid ${C.accent}`,
                background: C.bg0, fontSize: 12.5, color: C.text0,
              }}
            >
              <span style={{ display: 'flex', flex: 'none' }}><Icon name="terminal" size={15} /></span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>本地终端</span>
              <span style={{ width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', color: C.text2, borderRadius: 3, flex: 'none' }}>
                <Icon name="x" size={11} />
              </span>
            </div>
          </div>
          <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
            <TermPane frame={frame} />
          </div>
        </div>
        <AiPanel st={st} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 26, opacity: 1 - st.pageT, pointerEvents: st.page === 'workbench' ? 'auto' : 'none' }}>
        <Statusbar st={st} frame={frame} />
      </div>

      {/* 账号页 */}
      <div
        style={{
          position: 'absolute', inset: 0, opacity: st.pageT,
          transform: `translateY(${(1 - st.pageT) * 12}px)`, pointerEvents: st.page === 'account' ? 'auto' : 'none',
        }}
      >
        <AccountPage st={st} frame={frame} />
      </div>

      {/* 覆盖层:右键菜单 45 < toast 46 < 弹窗 50 */}
      {st.toast && (
        <div
          style={{
            position: 'absolute', right: 24, bottom: 34, padding: '11px 18px', background: C.bg2,
            border: `1px solid ${C.borderStrong}`, borderRadius: 8, fontSize: 12.5,
            boxShadow: '0 8px 32px rgba(0,0,0,0.55)', whiteSpace: 'nowrap', zIndex: 46, maxWidth: 620,
          }}
        >
          {st.toast}
        </div>
      )}
      <PasswordModal st={st} />
      {st.cfm && <BackupConfirmDialog t={st.cfmT} hover={st.hover} />}
      <RestoreModal st={st} />
      <span style={{ display: 'none' }}>{`${TOP_NAV.account.x},${TOP_NAV.project.x}`}</span>
    </div>
  );
};
