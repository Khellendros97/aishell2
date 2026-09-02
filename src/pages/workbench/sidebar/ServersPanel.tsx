/**
 * 服务器列表侧栏面板 —— React 版,逐行对照 legacy/pages/workbench/sidebar/servers.ts(899 行)。
 * 渲染当前项目绑定的服务器卡片;SSH 连接 / SFTP 标签页;刷新源 = wbEvents 'project-changed'
 * + window 'aishell:data-changed'(命令面板 Ctrl+T 全局数据广播)。
 * 面板内嵌模态框(与 legacy 同构,常驻挂载 + hidden/open 类切换,淡出后回 hidden):
 *  - 新建/编辑服务器:字段/校验复用 src/pages/settings/ServerForm(密码留空 = keyring 保持原值),
 *    创建成功后立即绑定到当前项目(先拉后端最新 project 合并,避免过期内存快照覆盖已删绑定);
 *  - SSH跳转设置:堡垒机开关 + 目标主机列表(create 含堡垒机表单 / edit / 目标主机只读三种形态);
 *  - 数据库连接配置(AI 受管查询通道):列表 ↔ 表单两视图,共享常量来自 ../db。
 * 与旧版差异:Workbench.state.project → useWorkbench.getState().project;bus → wbEvents;
 * Workbench.ai.addServerRef → wbHandles.ai?.addServerRef;旧版 DOM 重建/节点复用改 React key。
 * 2026-08 新增:设置-外观「服务器紧凑布局」开启时卡片默认折叠(仅图标/名称/IP),点击展开操作按钮,
 * 开关存 settings.compactServerList(无 proto/legacy 对照)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Credential, DbConnection, DbKind, McpDeviceConfig, Server } from '../../../types';
import {
  deleteDbConnection, deleteServer, getState, saveDbConnection, setServerLocked, upsertProject,
} from '../../../api';
import { useWorkbench, wbEvents, wbHandles } from '../../../stores/workbench';
import { confirmDialog, showContextMenu, toast, uid } from '../../../ui';
import { Icon } from '../../../shared/Icon';
import { matchServer, parseSearchQuery, toggleTagInQuery, topTags } from '../../../shared/search';
import type { SidebarPanelDef } from './panel-types';
import { ServerForm, type ServerFormHandle } from '../../settings/ServerForm';
import { saveServerWithCredentialChoice } from '../../settings/server-save';
import { openMcpModal } from './McpModal';
import { DB_COMMAND_GROUPS, DB_DEFAULT_COMMANDS, DB_DEFAULT_PORTS, DB_KIND_LABEL } from '../db';
import './servers.css';

/* ---------- 模态显隐状态机(对照 legacy 的 hidden/open 类切换:打开先撤 hidden 下一帧加 open;
   关闭撤 open 淡出,160ms 后回 hidden) ---------- */
type FadeState = 'closed' | 'shown' | 'open';

function useFadeModal(): [FadeState, () => void, () => void] {
  const [state, setState] = useState<FadeState>('closed');
  const timerRef = useRef<number | null>(null);
  useEffect(() => () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); }, []);
  const open = useCallback((): void => {
    if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
    setState('shown');
    requestAnimationFrame(() => setState('open'));
  }, []);
  const close = useCallback((): void => {
    setState('shown'); // 撤 open 类,开始淡出
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setState('closed'), 160);
  }, []);
  return [state, open, close];
}

/** 目标主机草稿:server 为当前值(新建条目 id 由 buildServer 生成);password 为保存时的表单密码(null = 不写 keyring) */
interface JumpTargetDraft { server: Server; password: string | null; }

/** SSH跳转草稿:mode create = 新建堡垒机(含堡垒机表单);edit = 编辑既有服务器 */
interface JumpDraft { mode: 'create' | 'edit'; toggle: boolean; targets: JumpTargetDraft[]; }

/* ---------- 数据库连接配置弹窗(AI 受管查询通道) ----------
   列表视图 ↔ 表单视图(新增/编辑),密码永不回显;类型/端口/命令清单等共享常量见 ../db。 */
interface DbFormState {
  id: string;
  kind: DbKind;
  name: string;
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  /** 已勾选的命令(保存 = 白名单);初始 = 已保存集或该类型默认只读集 */
  commands: Set<string>;
  /** 已保存但不在清单内的自定义命令(额外勾选组;随表单状态实时联动) */
  extras: string[];
  /** 打开时类型(切换类型联动端口用:端口仍为旧默认则跟随新默认) */
  prevKind: DbKind;
}

function DbConnectionsModal({ server, onClose }: { server: Server; onClose: () => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [conns, setConns] = useState<DbConnection[]>([]);
  const [form, setForm] = useState<DbFormState | null>(null);
  const [editingConn, setEditingConn] = useState<DbConnection | null>(null);

  /* 淡入 */
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const close = (): void => {
    setOpen(false);
    setTimeout(onClose, 160); // 淡出后再卸载
  };

  const loadConns = async (): Promise<void> => {
    try {
      const state = await getState();
      setConns(state.dbConnections[server.id] ?? []);
    } catch {
      setConns([]);
    }
  };

  useEffect(() => { void loadConns(); }, []);

  /** 启用开关:即时保存;密码传 null = 后端保持原值(不触碰 keyring) */
  const toggleConn = (c: DbConnection, enabled: boolean): void => {
    const next: DbConnection = { ...c, enabled };
    void saveDbConnection(server.id, next, null)
      .then(() => { toast(next.enabled ? '已启用连接' : '已禁用连接，AI 不可见、不可执行', 'success'); void loadConns(); })
      .catch((err) => { toast(`切换失败: ${String(err)}`, 'error'); void loadConns(); });
  };

  const deleteConn = (c: DbConnection): void => {
    void confirmDialog({
      title: '删除数据库连接',
      message: `确定删除「${c.name}」？系统凭据库中的密码也会一并删除。`,
      danger: true,
      okText: '删除',
    }).then((ok) => {
      if (!ok) return;
      void deleteDbConnection(server.id, c.id)
        .then(() => { toast('已删除数据库连接', 'success'); void loadConns(); })
        .catch((err) => toast(`删除失败: ${String(err)}`, 'error'));
    });
  };

  /** 表单视图入口:conn 为 null 表示新增(新 id 打开时生成,密码必填) */
  const openForm = (conn: DbConnection | null): void => {
    setEditingConn(conn);
    const d = conn ?? {
      id: uid('dbc'), name: '', kind: 'mysql' as DbKind, host: '127.0.0.1', port: 3306,
      user: '', database: '', allowedCommands: [] as string[], enabled: true,
    };
    const known = new Set(DB_COMMAND_GROUPS[d.kind].flatMap((g) => g.commands));
    const commands = new Set(d.allowedCommands.length ? d.allowedCommands : DB_DEFAULT_COMMANDS[d.kind]);
    /* 已保存但不在清单内的自定义命令:保留为额外勾选组(默认勾选,可取消) */
    const extras = d.allowedCommands.filter((c) => !known.has(c));
    setForm({
      id: d.id, kind: d.kind, name: d.name, host: d.host, port: String(d.port),
      user: d.user, password: '', database: d.database, commands, extras, prevKind: d.kind,
    });
    setView('form');
  };

  /** 切换类型:勾选重置为新类型默认只读集(不同类型命令语义不同,不保留旧勾选);
      端口若仍是旧类型默认值(用户未手改)则联动到新类型默认端口 */
  const onKindChange = (k: DbKind): void => {
    if (!form) return;
    setForm({
      ...form,
      kind: k,
      commands: new Set(DB_DEFAULT_COMMANDS[k]),
      extras: [],
      port: Number(form.port) === DB_DEFAULT_PORTS[form.prevKind] ? String(DB_DEFAULT_PORTS[k]) : form.port,
      prevKind: k,
    });
  };

  const saveForm = (): void => {
    if (!form) return;
    const isNew = editingConn === null;
    const name = form.name.trim();
    const host = form.host.trim();
    const port = Number(form.port);
    const user = form.user.trim();
    const database = form.database.trim();
    const password = form.password;
    const commands = [...form.commands];
    if (!name) { toast('请填写连接名称', 'error'); return; }
    if (!host) { toast('请填写数据库主机', 'error'); return; }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) { toast('端口无效', 'error'); return; }
    if (!user && form.kind !== 'redis') { toast('请填写数据库用户名', 'error'); return; }
    if (isNew && !password && form.kind !== 'redis') { toast('请填写数据库密码', 'error'); return; }
    if (!commands.length) { toast('请至少勾选一条 AI 可用命令', 'error'); return; }
    const connection: DbConnection = {
      id: form.id, name, kind: form.kind, host, port, user, database,
      allowedCommands: commands,
      enabled: editingConn?.enabled ?? true,
    };
    void saveDbConnection(server.id, connection, password || null)
      .then(() => {
        toast(isNew ? '已保存数据库连接' : '已更新数据库连接', 'success');
        setView('list');
        void loadConns();
      })
      .catch((err) => toast(`保存失败: ${String(err)}`, 'error'));
  };

  /* 列表视图 */
  if (view === 'list') {
    return (
      <div className={`modal-mask${open ? ' open' : ''}`}
        onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
        <div className="modal" style={{ width: 600 }}>
          <div className="modal-head">
            <h3>数据库连接 · {server.name}</h3>
            <button className="icon-btn" title="关闭" onClick={close}><Icon name="x" /></button>
          </div>
          <div className="modal-body">
            <div className="db-conn-list">
              {conns.length ? conns.map((c) => (
                <div className={`db-conn-item${c.enabled ? '' : ' disabled'}`} key={c.id}>
                  <span className="db-conn-icon"><Icon name="database" /></span>
                  <span className="db-conn-main">
                    <span className="db-conn-name">{c.name}</span>
                    <span className="db-conn-addr mono">
                      {DB_KIND_LABEL[c.kind]} · {c.host}:{c.port}{c.database ? ` · db=${c.database}` : ''}
                    </span>
                    <span className="db-conn-cmds">允许命令：{(c.allowedCommands.length ? c.allowedCommands : DB_DEFAULT_COMMANDS[c.kind]).join(' / ')}</span>
                  </span>
                  <label className="db-switch" title={c.enabled ? '已启用（点击禁用：AI 不可见、不可执行）' : '已禁用（点击启用）'}>
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) => toggleConn(c, e.currentTarget.checked)}
                    />
                    <span className="db-switch-track"></span>
                  </label>
                  <span className="db-conn-ops">
                    <button className="icon-btn" title="编辑" onClick={() => openForm(c)}><Icon name="pencil" /></button>
                    <button className="icon-btn" title="删除" onClick={() => deleteConn(c)}><Icon name="trash" /></button>
                  </span>
                </div>
              )) : (
                <div className="db-conn-empty">尚未配置数据库连接。AI 将无法通过 db_query 查询；密码保存在系统凭据库，AI 不可见。</div>
              )}
            </div>
          </div>
          <div className="modal-foot">
            <button className="btn primary" onClick={() => openForm(null)}><Icon name="plus" /> 新增连接</button>
          </div>
        </div>
      </div>
    );
  }

  /* 表单视图(新增/编辑共用;redis 隐藏用户名/默认库字段) */
  const isRedis = form?.kind === 'redis';
  const checkedCommands = form?.commands ?? new Set<string>();
  return (
    <div className={`modal-mask${open ? ' open' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="modal" style={{ width: 600 }}>
        <div className="modal-head">
          <h3>{editingConn === null ? '新增数据库连接' : '编辑数据库连接'} · {server.name}</h3>
          <button className="icon-btn" title="关闭" onClick={close}><Icon name="x" /></button>
        </div>
        <div className="modal-body">
          <div className="server-form-grid">
            <div className="field">
              <label>类型</label>
              <select className="select" value={form?.kind} onChange={(e) => onKindChange(e.currentTarget.value as DbKind)}>
                {(Object.keys(DB_KIND_LABEL) as DbKind[]).map((k) => (
                  <option value={k} key={k}>{DB_KIND_LABEL[k]}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>名称<span className="req">*</span></label>
              <input className="input" value={form?.name ?? ''} placeholder="例如：计费库"
                onChange={(e) => { const v = e.currentTarget.value; setForm((f) => (f ? { ...f, name: v } : f)); }} />
            </div>
            <div className="field">
              <label>主机<span className="req">*</span></label>
              <input className="input" value={form?.host ?? ''}
                onChange={(e) => { const v = e.currentTarget.value; setForm((f) => (f ? { ...f, host: v } : f)); }} />
            </div>
            <div className="field">
              <label>端口<span className="req">*</span></label>
              <input className="input" type="number" value={form?.port ?? ''}
                onChange={(e) => { const v = e.currentTarget.value; setForm((f) => (f ? { ...f, port: v } : f)); }} />
            </div>
            <div className={`field${isRedis ? ' hidden' : ''}`}>
              <label>用户名</label>
              <input className="input" value={form?.user ?? ''} placeholder="redis 可留空"
                onChange={(e) => { const v = e.currentTarget.value; setForm((f) => (f ? { ...f, user: v } : f)); }} />
            </div>
            <div className="field">
              <label>密码</label>
              <input className="input mono" type="password" value={form?.password ?? ''}
                placeholder={form?.kind === 'redis' ? '无密码实例可留空' : editingConn === null ? '必填' : '留空保持原密码'}
                onChange={(e) => { const v = e.currentTarget.value; setForm((f) => (f ? { ...f, password: v } : f)); }} />
            </div>
            <div className={`field db-cmds-field${isRedis ? ' hidden' : ''}`}>
              <label>默认库</label>
              <input className="input" value={form?.database ?? ''} placeholder="mysql/clickhouse/postgres 用；redis 忽略"
                onChange={(e) => { const v = e.currentTarget.value; setForm((f) => (f ? { ...f, database: v } : f)); }} />
            </div>
            <div className="field db-cmds-field">
              <label>AI 可用命令</label>
              <div className="db-cmds">
                {form ? (DB_COMMAND_GROUPS[form.kind].map((g) => (
                  <div className="db-cmds-group" key={g.title}>
                    <div className="db-cmds-title">{g.title}</div>
                    <div className={`db-cmds-grid${g.write ? ' write' : ''}`}>
                      {g.commands.map((cmd) => (
                        <label className="db-cmd" key={cmd}>
                          <input type="checkbox" value={cmd} checked={checkedCommands.has(cmd)}
                            onChange={(e) => { const checked = e.currentTarget.checked; setForm((f) => {
                              if (!f) return f;
                              const next = new Set(f.commands);
                              if (checked) next.add(cmd);
                              else next.delete(cmd);
                              return { ...f, commands: next };
                            }); }} />
                          {cmd}
                        </label>
                      ))}
                    </div>
                  </div>
                ))) : null}
                {form && form.extras.length ? (
                  <div className="db-cmds-group">
                    <div className="db-cmds-title">其他（已保存的自定义命令）</div>
                    <div className="db-cmds-grid">
                      {form.extras.map((cmd) => (
                        <label className="db-cmd" key={cmd}>
                          <input type="checkbox" checked={checkedCommands.has(cmd)}
                            onChange={(e) => { const checked = e.currentTarget.checked; setForm((f) => {
                              if (!f) return f;
                              const next = new Set(f.commands);
                              if (checked) next.add(cmd);
                              else next.delete(cmd);
                              return { ...f, commands: next };
                            }); }} />
                          {cmd}
                        </label>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
              <div className="hint">只读命令 AI 可直接执行；勾选写命令后，AI 执行前需人工审批。密码保存在系统凭据库，AI 不可见。</div>
            </div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => { setView('list'); void loadConns(); }}>返回</button>
          <button className="btn primary" onClick={saveForm}>保存</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 面板主体 ---------- */

function ServersPanelBody(): JSX.Element {
  /* 后端状态快照(服务器 + MCP 设备配置 + 紧凑布局设置);挂载 / project-changed / aishell:data-changed 触发重拉 */
  const [data, setData] = useState<{ servers: Server[]; credentials: Credential[]; mcpDevices: Record<string, McpDeviceConfig>; compact: boolean }>({ servers: [], credentials: [], mcpDevices: {}, compact: false });
  const [reloadKey, setReloadKey] = useState(0);
  const [searchText, setSearchText] = useState('');
  /* 紧凑布局下已展开的服务器 id(默认全部折叠,点击卡片展开/收起) */
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  /* 新建/编辑服务器模态(常驻挂载,hidden/open 切换) */
  const [srvState, openSrv, closeSrv] = useFadeModal();
  const [srvEditing, setSrvEditing] = useState<Server | null>(null);
  const srvFormRef = useRef<ServerFormHandle>(null);

  /* SSH跳转设置模态(create/edit/只读三形态) + 目标主机模态 */
  const [jumpState, openJump, closeJump] = useFadeModal();
  const [jumpDraft, setJumpDraft] = useState<JumpDraft | null>(null);
  const [jumpEditServer, setJumpEditServer] = useState<Server | null>(null);
  const [jumpOriginalIds, setJumpOriginalIds] = useState<Set<string>>(new Set());
  /** 只读态(目标主机)横幅:堡垒机名称;null = 非只读态 */
  const [jumpBannerName, setJumpBannerName] = useState<string | null>(null);
  const jumpBastionFormRef = useRef<ServerFormHandle>(null);

  const [targetState, openTarget, closeTarget] = useFadeModal();
  const [editingTarget, setEditingTarget] = useState<Server | null>(null);
  const jumpTargetFormRef = useRef<ServerFormHandle>(null);

  /* 数据库连接配置弹窗(条件挂载,淡出后卸载) */
  const [dbServer, setDbServer] = useState<Server | null>(null);

  /* ---------- 数据装载与联动刷新 ---------- */
  useEffect(() => {
    let alive = true;
    void getState()
      .then((state) => {
        if (!alive) return;
        setData({ servers: state.servers, credentials: state.credentials ?? [], mcpDevices: state.mcpDevices ?? {}, compact: state.settings.compactServerList ?? false });
        // 同步 store 项目快照:欢迎页等外部页面可能改过绑定,而 store 里的 project 是保活内存单例
        // (bound 列表按 project.serverIds 过滤,不刷新则返回后仍按旧绑定渲染)
        const s = useWorkbench.getState();
        const p = s.project;
        if (p) {
          const latest = state.projects.find((x) => x.id === p.id) ?? null;
          if (latest && latest.serverIds.join(',') !== p.serverIds.join(',')) {
            s.setProject({ ...p, serverIds: latest.serverIds });
          }
        }
      })
      .catch(() => { /* 后端未就绪时按空列表渲染 */ });
    return () => { alive = false; };
  }, [reloadKey]);

  /* 面板联动刷新:项目数据变更(其他模块改绑定/命令收藏等) */
  useEffect(() => wbEvents.on('project-changed', () => setReloadKey((k) => k + 1)), []);

  /* 命令面板(Ctrl+T)全局数据广播 */
  useEffect(() => {
    const onDataChanged = (): void => setReloadKey((k) => k + 1);
    window.addEventListener('aishell:data-changed', onDataChanged);
    return () => window.removeEventListener('aishell:data-changed', onDataChanged);
  }, []);

  /* 新建服务器模态 Esc 关闭(与 legacy 一致:仅该模态注册 Escape) */
  useEffect(() => {
    const onKeydown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && srvState !== 'closed') closeSrv();
    };
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, [srvState, closeSrv]);

  /* ---------- 新建/编辑服务器 ---------- */
  const openCreateModal = (): void => {
    setSrvEditing(null);
    srvFormRef.current?.fill(null); // 每次打开重置表单(密码/密钥路径不留上次输入)
    openSrv();
    srvFormRef.current?.focusFirst();
  };

  /** 编辑入口:预填当前服务器配置(密码永不回显),保存走 upsert_server 且密码留空 = 保持原值 */
  const openEditModal = (server: Server): void => {
    setSrvEditing(server);
    srvFormRef.current?.fill(server);
    openSrv();
    srvFormRef.current?.focusFirst();
  };

  const saveServer = async (): Promise<void> => {
    const form = srvFormRef.current;
    if (!form) return;
    const err = form.validate();
    if (err) {
      toast(err, 'error');
      return;
    }
    const isNew = srvEditing === null;
    const server = form.buildServer(srvEditing);
    let saved: Server | null;
    try {
      saved = await saveServerWithCredentialChoice(server, form.passwordValue());
      if (!saved) return;
      if (isNew) {
        // 创建成功后立即绑定到当前项目;先拉最新 project 合并,避免过期内存快照覆盖已删绑定
        const project = useWorkbench.getState().project;
        if (project) {
          let latest = project;
          try {
            const state = await getState();
            latest = state.projects.find((p) => p.id === project.id) ?? project;
          } catch { /* 后端未就绪时用内存快照 */ }
          if (!latest.serverIds.includes(saved.id)) {
            latest.serverIds.push(saved.id);
            await upsertProject(latest);
            // 同步 store 内存单例(新引用触发订阅者),避免下次绑定再次覆盖
            useWorkbench.getState().setProject({ ...project, serverIds: latest.serverIds });
          }
        }
      }
    } catch (err) {
      toast(`${isNew ? '创建' : '保存'}服务器失败: ${String(err)}`, 'error');
      return;
    }
    closeSrv();
    wbEvents.emit('project-changed');
    toast(isNew
      ? `服务器「${server.name}」已创建并绑定到当前项目`
      : `服务器「${server.name}」已更新`, 'success');
  };

  /* ---------- SSH跳转设置 ---------- */

  /** 侧栏列表「SSH跳转」入口:新建堡垒机(含堡垒机服务器表单 + 目标主机列表) */
  const openJumpCreate = (): void => {
    setJumpDraft({ mode: 'create', toggle: true, targets: [] });
    setJumpEditServer(null);
    setJumpOriginalIds(new Set());
    setJumpBannerName(null);
    jumpBastionFormRef.current?.fill(null); // 每次打开重置表单(密码/密钥路径不留上次输入)
    openJump();
    jumpBastionFormRef.current?.focusFirst();
  };

  /** 卡片「更多 → SSH跳转设置」:编辑该服务器的堡垒机配置与目标主机 */
  const openJumpEdit = async (server: Server): Promise<void> => {
    setJumpEditServer(server);
    setJumpDraft({ mode: 'edit', toggle: server.isBastion, targets: [] });
    setJumpBannerName(null);
    const state = await getState().catch(() => null);
    const all = state?.servers ?? [];
    if (server.bastionId) {
      // 目标主机:只读展示归属,不做任何编辑
      const bastion = all.find((s) => s.id === server.bastionId);
      setJumpBannerName(bastion?.name ?? '已删除');
    } else {
      const targets = all.filter((s) => s.bastionId === server.id);
      setJumpOriginalIds(new Set(targets.map((s) => s.id)));
      setJumpDraft({ mode: 'edit', toggle: server.isBastion, targets: targets.map((s) => ({ server: s, password: null })) });
    }
    openJump();
  };

  const onJumpToggle = (checked: boolean): void => {
    if (!jumpDraft) return;
    setJumpDraft({ ...jumpDraft, toggle: checked });
  };

  /** 目标主机弹窗(新增/编辑共用 server-form;密码留空 = 不写入 keyring) */
  const openTargetEditModal = (target: Server | null): void => {
    setEditingTarget(target);
    jumpTargetFormRef.current?.fill(target);
    openTarget();
    jumpTargetFormRef.current?.focusFirst();
  };

  const saveJumpTarget = (): void => {
    const form = jumpTargetFormRef.current;
    if (!form || !jumpDraft) return;
    const err = form.validate();
    if (err) {
      toast(err, 'error');
      return;
    }
    const target = editingTarget; // 局部快照
    const srv = form.buildServer(target);
    const password = form.passwordValue();
    if (target) {
      const slot = jumpDraft.targets.find((t) => t.server.id === target.id);
      if (slot) {
        // buildServer 保留 id / locked / isBastion / bastionId
        setJumpDraft({
          ...jumpDraft,
          targets: jumpDraft.targets.map((t) => (t.server.id === target.id ? { server: srv, password } : t)),
        });
      } else {
        setJumpDraft({ ...jumpDraft, targets: [...jumpDraft.targets, { server: srv, password }] });
      }
    } else {
      setJumpDraft({ ...jumpDraft, targets: [...jumpDraft.targets, { server: srv, password }] });
    }
    closeTarget();
  };

  const deleteJumpTarget = (id: string): void => {
    if (!jumpDraft) return;
    setJumpDraft({ ...jumpDraft, targets: jumpDraft.targets.filter((t) => t.server.id !== id) });
  };

  /** 把新创建的服务器绑定到当前项目(与「新建服务器」同语义:侧栏列表只展示项目绑定服务器)。
   *  先拉后端最新 project 再合并:store 里的 project 是内存快照,若期间其他页面(欢迎页)删除过
   *  服务器,直接用旧快照全量 upsertProject 会把已删除的绑定幽灵 id 写回配置文件。 */
  const bindToProject = async (ids: string[]): Promise<void> => {
    const s = useWorkbench.getState();
    const project = s.project;
    if (!project) return;
    let latest = project;
    try {
      const state = await getState();
      latest = state.projects.find((p) => p.id === project.id) ?? project;
    } catch {
      /* 后端未就绪时退化为内存快照 */
    }
    const added = ids.filter((id) => !latest.serverIds.includes(id));
    if (!added.length) return;
    latest.serverIds.push(...added);
    try {
      await upsertProject(latest);
      s.setProject({ ...project, serverIds: latest.serverIds }); // 同步内存单例,避免下次绑定再次覆盖
    } catch {
      /* 绑定失败不阻断保存(服务器本体已落盘) */
    }
  };

  const saveJump = async (): Promise<void> => {
    const draft = jumpDraft;
    if (!draft) return;
    try {
      if (draft.mode === 'create') {
        const form = jumpBastionFormRef.current;
        if (!form) return;
        const err = form.validate();
        if (err) {
          toast(err, 'error');
          return;
        }
        const bastion = form.buildServer(null);
        bastion.isBastion = draft.toggle;
        // 先建堡垒机,再建目标主机(目标引用堡垒机 id,必须先存在)，每一步都处理共享凭据选择。
        const savedBastion = await saveServerWithCredentialChoice(bastion, form.passwordValue());
        if (!savedBastion) return;
        if (draft.toggle) {
          for (const t of draft.targets) {
            t.server.bastionId = savedBastion.id;
            const savedTarget = await saveServerWithCredentialChoice(t.server, t.password);
            if (!savedTarget) return;
          }
        }
        await bindToProject([bastion.id, ...draft.targets.map((t) => t.server.id)]);
      } else {
        const server = jumpEditServer;
        if (!server || server.bastionId) return; // 目标主机只读态没有保存按钮
        if (!draft.toggle && server.isBastion) {
          // 关闭堡垒机:目标主机解除绑定恢复为普通服务器(非删除)
          const ok = await confirmDialog({
            title: '关闭堡垒机',
            message: `关闭堡垒机后将解除 ${draft.targets.length} 台目标主机的绑定，恢复为普通服务器（连接将不再经堡垒机代理）。确定继续吗？`,
            danger: true,
            okText: '解除绑定',
          });
          if (!ok) {
            setJumpDraft({ ...draft, toggle: true });
            return;
          }
          if (!await saveServerWithCredentialChoice({ ...server, isBastion: false }, null)) return;
          for (const t of draft.targets) {
            if (!await saveServerWithCredentialChoice({ ...t.server, bastionId: null }, null)) return;
          }
          // 关闭开关时同样删除被移除的目标主机(否则残留引用已关闭堡垒机的非法绑定)
          for (const id of jumpOriginalIds) {
            if (!draft.targets.some((t) => t.server.id === id)) {
              await deleteServer(id);
            }
          }
        } else {
          if (draft.toggle !== server.isBastion) {
            if (!await saveServerWithCredentialChoice({ ...server, isBastion: draft.toggle }, null)) return;
          }
          for (const t of draft.targets) {
            if (!jumpOriginalIds.has(t.server.id)) {
              t.server.bastionId = server.id; // 自动绑定到堡垒机
            }
            if (!await saveServerWithCredentialChoice(t.server, t.password)) return;
          }
          for (const id of jumpOriginalIds) {
            if (!draft.targets.some((t) => t.server.id === id)) {
              await deleteServer(id);
            }
          }
          await bindToProject(draft.targets.filter((t) => !jumpOriginalIds.has(t.server.id)).map((t) => t.server.id));
        }
      }
    } catch (err) {
      toast(`保存SSH跳转设置失败: ${String(err)}`, 'error');
      return;
    }
    closeJump();
    wbEvents.emit('project-changed');
    toast('SSH跳转设置已保存', 'success');
  };

  /* ---------- 卡片操作 ---------- */

  /** 把服务器/本地终端引用加入 AI 输入框(@remote:服务器名称 / @local 标签) */
  const addRefToChat = (ref: { serverId: string | null; name: string }): void => {
    if (wbHandles.ai?.addServerRef) {
      wbHandles.ai.addServerRef(ref);
    } else {
      toast('AI 面板未就绪');
    }
  };

  const openLocalTerminal = (): void => {
    // 每次点击都新开独立本地终端(id `term-local:<uid>`,与启动时自动开的首个实例 'term-local' 并存)
    useWorkbench.getState().openTab({
      id: `term-local:${uid('t')}`,
      type: 'terminal',
      title: '本地终端',
      data: { kind: 'local', cwd: project?.path ?? null },
    });
  };

  /** SSH 连接:每次点击都新开标签(唯一 id),支持同一服务器多终端并行;后端按前端 tab id 区分会话 */
  const openTerminal = (s: Server): void => {
    useWorkbench.getState().openTab({
      id: `term:${s.id}:${uid('t')}`,
      type: 'terminal',
      title: s.name,
      data: { kind: 'ssh', serverId: s.id },
    });
  };

  const openSftp = (s: Server): void => {
    useWorkbench.getState().openTab({
      id: 'sftp:' + s.id,
      type: 'sftp',
      title: 'SFTP ' + s.name,
      data: { serverId: s.id },
    });
  };

  /** SSH 隧道：一服务器一标签（同 id 去重，openTab 命中即激活）；关闭标签不停隧道（服务语义） */
  const openTunnel = (s: Server): void => {
    useWorkbench.getState().openTab({
      id: `tunnel:${s.id}`,
      type: 'tunnel',
      title: 'SSH 隧道 · ' + s.name,
      data: { serverId: s.id, serverName: s.name },
    });
  };

  const toggleLock = (s: Server): void => {
    void setServerLocked(s.id, !s.locked)
      .then(() => wbEvents.emit('project-changed'))
      .catch((err) => toast(`切换 AI 锁失败: ${String(err)}`, 'error'));
  };

  /** 紧凑布局:点击卡片切换展开/收起(展开后才显示编辑/锁定/标签与操作按钮) */
  const toggleExpand = (id: string): void => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* ---------- 渲染 ---------- */
  const project = useWorkbench((s) => s.project);
    const { servers, credentials, mcpDevices, compact } = data;

  const ids = project?.serverIds ?? [];
  const bound = servers.filter((s) => ids.includes(s.id));
  // 搜索过滤：#tag 条件 AND + 名称 / host / username 大小写不敏感子串匹配；空串显示全部
  const parsedQuery = parseSearchQuery(searchText);
  const q = searchText.trim().toLowerCase();
  const filtered = bound.filter((s) => matchServer(s, parsedQuery));
  // 热门 tag chips：当前项目内被引用最多的标签，点击切换进/出搜索条件
  const hotTags = topTags(bound);
  const activeTags = parsedQuery.tags;
  const byId = new Map(servers.map((sv) => [sv.id, sv]));
  // 现有全部标签（服务器表单 tag 输入的自动补全候选）
  const allTagOptions = [...new Set(servers.flatMap((s) => s.tags))].sort((a, b) =>
    a.localeCompare(b, 'zh'));

  return (
    <>
      <div className="wbs-content">
        {/* 固定卡片:本地终端,整卡点击新开独立本地终端 */}
        <div
          className="card wbs-server-card wbs-local-card clickable"
          onClick={openLocalTerminal}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            showContextMenu(e.clientX, e.clientY, [
              { label: '添加到对话', iconName: 'chatPlus', action: () => addRefToChat({ serverId: null, name: '本地终端' }) },
            ]);
          }}
        >
          <div className="wbs-server-top">
            <span className="wbs-server-icon"><Icon name="terminal" /></span>
            <span className="wbs-server-main">
              <span className="wbs-server-name">本地终端</span>
              <span className="wbs-server-addr mono">本地终端 · 点击打开</span>
            </span>
            <span className="tag blue">本地</span>
          </div>
        </div>

        {/* 「远程服务器」标题行 + 新建/SSH跳转入口(空列表也可新建) */}
        <div className="wbs-server-head">
          <span>远程服务器</span>
          <div className="wbs-server-head-actions">
            <button className="btn small" title="新建服务器连接并绑定到当前项目" onClick={openCreateModal}>
              <Icon name="plus" /> 新建
            </button>
            <button className="btn small" title="新建 SSH 跳转（堡垒机 + 目标主机）" onClick={openJumpCreate}>
              <Icon name="link" /> SSH跳转
            </button>
          </div>
        </div>

        {/* 搜索行:不随列表重建,避免输入焦点丢失 */}
        <div className="wbs-search">
          <input
            className="input"
            placeholder="搜索服务器…（#标签 筛选）"
            value={searchText}
            onChange={(e) => setSearchText(e.currentTarget.value)}
          />
        </div>

        {/* 热门标签 chips：被引用最多的几个 tag，点击追加/移除 #tag 筛选条件 */}
        {hotTags.length > 0 && (
          <div className="wbs-tags">
            {hotTags.map((t) => (
              <button
                key={t}
                className={`tag clickable${activeTags.includes(t.toLowerCase()) ? ' active' : ''}`}
                title={`筛选 #${t}`}
                onClick={() => setSearchText(toggleTagInQuery(searchText, t))}
              >
                <Icon name="hash" />
                {t}
              </button>
            ))}
          </div>
        )}

        <div className="wbs-server-list">
          {filtered.length === 0 ? (
            q ? (
              <div className="empty-state">
                <div className="icon"><Icon name="monitor" /></div>
                <div>没有匹配「{q}」的服务器</div>
              </div>
            ) : (
              <div className="empty-state">
                <div className="icon"><Icon name="monitor" /></div>
                <div>该项目尚未绑定服务器</div>
                <div style={{ fontSize: '11.5px' }}>点击上方「新建」创建并绑定，或前往「设置」管理全部服务器</div>
              </div>
            )
          ) : (
            filtered.map((s) => {
              const lockTitle = s.locked
                ? 'AI 远程操作已锁定，点击解锁（手动 SSH/SFTP 不受影响）'
                : 'AI 远程操作未锁定，点击锁定（手动 SSH/SFTP 不受影响）';
              /* 紧凑布局:默认折叠(仅图标/名称/IP),点击卡片展开其余信息与操作按钮 */
              const expanded = !compact || expandedIds.has(s.id);
              return (
                <div
                  key={s.id}
                  className={`card wbs-server-card${compact ? ` wbs-compact clickable${expanded ? ' expanded' : ''}` : ''}`}
                  onClick={compact ? () => toggleExpand(s.id) : undefined}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    showContextMenu(e.clientX, e.clientY, [
                      { label: '添加到对话', iconName: 'chatPlus', action: () => addRefToChat({ serverId: s.id, name: s.name }) },
                    ]);
                  }}
                >
                  <div className="wbs-server-top">
                    <span className="wbs-server-icon"><Icon name="server" /></span>
                    <span className="wbs-server-main">
                      <span className="wbs-server-name" title={s.name}>{s.name}</span>
                      <span className="wbs-server-addr mono">{s.host}:{s.port}</span>
                    </span>
                    {expanded ? (
                      <>
                        <button className="icon-btn wbs-edit" title="编辑服务器配置" aria-label="编辑服务器配置"
                          onClick={(e) => { e.stopPropagation(); openEditModal(s); }}>
                          <Icon name="pencil" />
                        </button>
                        <button className={`icon-btn wbs-lock${s.locked ? ' locked' : ''}`} title={lockTitle} aria-label={lockTitle} aria-pressed={s.locked}
                          onClick={(e) => { e.stopPropagation(); toggleLock(s); }}>
                          <Icon name={s.locked ? 'lock' : 'unlock'} />
                        </button>
                      </>
                    ) : (
                      <>
                        {/* 折叠态保留最常用的「添加到对话」,其余操作展开后可用 */}
                        <button className="icon-btn wbs-chat" title="添加到对话" aria-label="添加到对话"
                          onClick={(e) => { e.stopPropagation(); addRefToChat({ serverId: s.id, name: s.name }); }}>
                          <Icon name="chatPlus" />
                        </button>
                        <span className="wbs-caret"><Icon name="chevronDown" /></span>
                      </>
                    )}
                  </div>
                  {/* 认证 / 堡垒机 / MCP 标签独立一行,避免与右上角按钮挤在一起；末尾跟用户自定义 tag */}
                  {expanded ? (
                    <>
                      <div className="wbs-server-tags">
                        <span className="tag">{s.authType === 'password' ? '密码' : <><Icon name="key" /> {s.authType === 'publickey' ? 'SSH 公钥' : '密钥'}</>}</span>
                        {s.isBastion ? (
                          <span className="tag purple"><Icon name="server" /> 堡垒机</span>
                        ) : s.bastionId ? (
                          <span className="tag purple"><Icon name="link" /> 堡垒机:{byId.get(s.bastionId)?.name ?? '已删除'}</span>
                        ) : null}
                        {mcpDevices[s.id]?.enabled ? (
                          <span className="tag green"><Icon name="plug" /> MCP</span>
                        ) : null}
                        {s.tags.map((t) => (
                          <span key={t} className="tag blue"><Icon name="hash" />{t}</span>
                        ))}
                      </div>
                      <div className="wbs-server-actions">
                        <button className="icon-btn wbs-chat" title="添加到对话" aria-label="添加到对话"
                          onClick={(e) => { e.stopPropagation(); addRefToChat({ serverId: s.id, name: s.name }); }}>
                          <Icon name="chatPlus" />
                        </button>
                        <button className="icon-btn wbs-ssh" title="SSH 连接" aria-label="SSH 连接" onClick={(e) => { e.stopPropagation(); openTerminal(s); }}>
                          <Icon name="terminal" />
                        </button>
                        <button className="icon-btn wbs-sftp" title="SFTP 文件管理" aria-label="SFTP 文件管理" onClick={(e) => { e.stopPropagation(); openSftp(s); }}>
                          <Icon name="folder" />
                        </button>
                        {/* 「更多」下拉菜单:MCP 接入 / 数据库连接 / SSH跳转设置(非常用操作收纳进下拉)。
                            服务器已锁定(不允许 AI 访问)时 MCP 入口禁用(后端亦强制拒绝)。 */}
                        <button className="icon-btn wbs-more" title="更多操作" aria-label="更多操作"
                          onClick={(e) => {
                            e.stopPropagation();
                            showContextMenu(e.clientX, e.clientY, [
                              { label: 'MCP', iconName: 'plug', disabled: s.locked, disabledTip: '服务器已锁定（不允许 AI 访问），MCP 不可用', action: () => openMcpModal(s) },
                              { label: '数据库连接', iconName: 'database', action: () => setDbServer(s) },
                              { label: 'SSH跳转设置', iconName: 'link', action: () => void openJumpEdit(s) },
                              { label: 'SSH 隧道', iconName: 'tunnel', action: () => openTunnel(s) },
                            ]);
                          }}>
                          <Icon name="more" />
                        </button>
                      </div>
                    </>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* 新建 / 编辑服务器模态框(常驻挂载;密码留空 = 保持 keyring 原值,永不回显) */}
      <div
        className={`modal-mask${srvState === 'closed' ? ' hidden' : ''}${srvState === 'open' ? ' open' : ''}`}
        id="srv-modal"
        onMouseDown={(e) => { if (e.target === e.currentTarget) closeSrv(); }}
      >
        <div className="modal">
          <div className="modal-head">
            <h3>{srvEditing ? '编辑服务器' : '新建服务器连接'}</h3>
            <button className="icon-btn" title="关闭" onClick={closeSrv}><Icon name="x" /></button>
          </div>
          <div className="modal-body">
            <ServerForm ref={srvFormRef} credentials={credentials} allTags={allTagOptions} />
          </div>
          <div className="modal-foot">
            <button className="btn" onClick={closeSrv}>取消</button>
            <button className="btn primary" onClick={() => void saveServer()}>
              {srvEditing ? '保存' : '创建并绑定到当前项目'}
            </button>
          </div>
        </div>
      </div>

      {/* SSH跳转设置模态(create 含堡垒机表单 / edit / 目标主机只读三形态) */}
      <div
        className={`modal-mask${jumpState === 'closed' ? ' hidden' : ''}${jumpState === 'open' ? ' open' : ''}`}
        id="jump-modal"
        onMouseDown={(e) => { if (e.target === e.currentTarget) closeJump(); }}
      >
        <div className="modal jump-modal">
          <div className="modal-head">
            <h3>{jumpEditServer ? `SSH跳转设置 · ${jumpEditServer.name}` : 'SSH跳转设置'}</h3>
            <button className="icon-btn" title="关闭" onClick={closeJump}><Icon name="x" /></button>
          </div>
          <div className="modal-body">
            {jumpDraft?.mode === 'create' ? (
              <div className="jump-section" id="jump-bastion-wrap">
                <div className="jump-section-title">堡垒机服务器</div>
                <div className="jump-hint">开启「作为堡垒机」后，本服务器的 SSH/SFTP 连接将作为目标主机的跳板</div>
                <div id="jump-bastion-form"><ServerForm ref={jumpBastionFormRef} credentials={credentials} allTags={allTagOptions} /></div>
              </div>
            ) : null}
            {jumpBannerName !== null ? (
              <div className="jump-target-banner" id="jump-target-banner">
                <Icon name="link" /> 该服务器是堡垒机「{jumpBannerName}」的目标主机，SSH/SFTP 连接经堡垒机代理转发。要调整归属请编辑堡垒机的「SSH跳转设置」。
              </div>
            ) : null}
            {jumpBannerName === null ? (
              <div className="jump-toggle-row" id="jump-toggle-row">
                <label className="jump-switch" title="作为堡垒机">
                  <input
                    type="checkbox"
                    checked={jumpDraft?.toggle ?? false}
                    onChange={(e) => onJumpToggle(e.currentTarget.checked)}
                  />
                  <span className="jump-switch-slider"></span>
                </label>
                <div className="jump-toggle-text">
                  <div className="jump-toggle-title">作为堡垒机</div>
                  <div className="jump-toggle-hint">开启后服务器卡片显示「堡垒机」标签</div>
                </div>
              </div>
            ) : null}
            {jumpBannerName === null ? (
              <div className={`jump-section${jumpDraft?.toggle ? '' : ' hidden'}`} id="jump-targets-wrap">
                <div className="jump-section-head">
                  <span className="jump-section-title">目标主机</span>
                  <button id="jump-target-add" className="btn small" onClick={() => openTargetEditModal(null)}>
                    <Icon name="plus" /> 添加目标主机
                  </button>
                </div>
                <div className="jump-hint">目标主机与普通服务器属性相同，SSH/SFTP 连接经本堡垒机代理，卡片显示「堡垒机:名称」标签</div>
                <div id="jump-target-list">
                  {jumpDraft && jumpDraft.targets.length ? jumpDraft.targets.map((t) => (
                    <div className="jump-target-row" key={t.server.id}>
                      <span className="jump-target-info">
                        <span className="jump-target-name" title={t.server.name}>{t.server.name}</span>
                        <span className="jump-target-addr mono">{t.server.host}:{t.server.port} · {t.server.username || '未设账号'}</span>
                      </span>
                      <button className="icon-btn" title="编辑目标主机" aria-label="编辑目标主机" onClick={() => openTargetEditModal(t.server)}>
                        <Icon name="pencil" />
                      </button>
                      <button className="icon-btn" title="删除目标主机" aria-label="删除目标主机" onClick={() => deleteJumpTarget(t.server.id)}>
                        <Icon name="trash" />
                      </button>
                    </div>
                  )) : <div className="jump-empty">尚未添加目标主机</div>}
                </div>
              </div>
            ) : null}
          </div>
          <div className="modal-foot">
            <button className="btn" onClick={closeJump}>{jumpBannerName !== null ? '关闭' : '取消'}</button>
            {jumpBannerName === null ? (
              <button className="btn primary" onClick={() => void saveJump()}>保存</button>
            ) : null}
          </div>
        </div>
      </div>

      {/* 目标主机弹窗(新增/编辑共用 server-form) */}
      <div
        className={`modal-mask${targetState === 'closed' ? ' hidden' : ''}${targetState === 'open' ? ' open' : ''}`}
        id="jump-target-modal"
        onMouseDown={(e) => { if (e.target === e.currentTarget) closeTarget(); }}
      >
        <div className="modal">
          <div className="modal-head">
            <h3>{editingTarget ? '编辑目标主机' : '添加目标主机'}</h3>
            <button className="icon-btn" title="关闭" onClick={closeTarget}><Icon name="x" /></button>
          </div>
          <div className="modal-body">
            <div id="jump-target-form"><ServerForm ref={jumpTargetFormRef} credentials={credentials} allTags={allTagOptions} /></div>
          </div>
          <div className="modal-foot">
            <button className="btn" onClick={closeTarget}>取消</button>
            <button className="btn primary" onClick={saveJumpTarget}>保存</button>
          </div>
        </div>
      </div>

      {/* 数据库连接配置弹窗(AI 受管查询通道) */}
      {dbServer ? <DbConnectionsModal server={dbServer} onClose={() => setDbServer(null)} /> : null}
    </>
  );
}

/** 侧栏面板契约:标题「服务器列表」,无头部操作按钮(新建/SSH跳转在面板内容区) */
export const serversPanel: SidebarPanelDef = {
  title: '服务器列表',
  Panel: ServersPanelBody,
};
