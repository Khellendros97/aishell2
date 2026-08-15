/**
 * 命令收藏侧栏面板 —— React 版,逐行对照 legacy/pages/workbench/sidebar/commands.ts(538 行)。
 * 顶部搜索行(搜索框 + 新建分类目录 + 全部展开/折叠);按 folder 分组展示(未分类排最后);
 * 数据源 = 当前项目 quickCommands + 其他项目 global=true 命令(跨项目全局命令带「全局」徽标,
 * 编辑/删除仍归属原项目)。分类展开状态经 setUiExpanded('commands:folders') 300ms 防抖落盘,
 * 每会话只从后端播种一次;搜索只过滤不持久化(搜索中命中组自动展开)。
 * 新增/编辑模态为 body 级浮层(createRoot 挂载),所属目录走 attachCombo 组合框。
 * 契约:commandsPanel 导出(标题 + HeadActions「+ 新增」);commands 准入(活跃标签须为终端)
 * 与 tab-activated 自动切回 explorer 由 Workbench 外壳负责。
 * 接口点:src/api.ts store 段(upsert_project / create|rename|delete_command_folder / set_ui_expanded);
 * 终端执行 getActiveTerminalApi()(src/stores/workbench)。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Project, QuickCommand } from '../../../types';
import {
  createCommandFolder, deleteCommandFolder, getState, renameCommandFolder, setUiExpanded, upsertProject,
} from '../../../api';
import { useWorkbench, wbEvents, getActiveTerminalApi } from '../../../stores/workbench';
import { attachCombo, confirmDialog, promptDialog, toast, uid } from '../../../ui';
import { Icon } from '../../../shared/Icon';
import type { SidebarPanelDef } from './panel-types';
import './commands.css';

/* ---------- 分类展开状态(模块级,重挂载保留,默认全部折叠;与 legacy 同语义) ---------- */
const expandedFolders = new Set<string>();
/** 分类展开状态防抖落盘定时器(300ms 合并连续 toggle) */
let foldersPersistTimer: number | null = null;
/** 本次会话已从后端恢复过分类展开状态(每会话只播种一次,避免重复覆盖用户操作) */
let foldersSeeded = false;

/** 300ms 防抖把分类展开集合写入后端;失败仅 console.warn 不打扰用户 */
function persistFoldersExpanded(): void {
  const snapshot = [...expandedFolders];
  if (foldersPersistTimer !== null) window.clearTimeout(foldersPersistTimer);
  foldersPersistTimer = window.setTimeout(() => {
    foldersPersistTimer = null;
    setUiExpanded('commands:folders', snapshot).catch((err) =>
      console.warn('保存命令分类展开状态失败:', err));
  }, 300);
}

/** 展开单个分类(用户显式 toggle / 搜索中不调用——搜索是过滤态不持久化) */
function expandFolder(folder: string): void {
  expandedFolders.add(folder);
  persistFoldersExpanded();
}

/** 折叠单个分类(用户显式 toggle / 删除分类后的清理) */
function collapseFolder(folder: string): void {
  expandedFolders.delete(folder);
  persistFoldersExpanded();
}

/** 一条待展示的命令及其归属项目:当前项目命令 owner = 当前项目;跨项目全局命令 owner = 其原项目 */
interface DisplayedCommand { qc: QuickCommand; owner: Project }

/* ---------- 分类目录管理(交互与服务器分类一致:新建 prompt / 重命名 prompt / 删除确认) ---------- */
async function createFolderFlow(): Promise<void> {
  const name = await promptDialog({
    title: '新建分类目录',
    label: '目录路径（可含 / 层级）',
    placeholder: '例如：常用/部署',
    okText: '创建',
  });
  if (name === null) return;
  try {
    await createCommandFolder(name);
  } catch (err) {
    toast(String(err), 'error');
    return;
  }
  wbEvents.emit('project-changed');
  toast(`分类目录「${name}」已创建`, 'success');
}

async function renameFolderFlow(folder: string): Promise<void> {
  const name = await promptDialog({
    title: '重命名分类目录',
    label: '目录路径（可含 / 层级）',
    defaultValue: folder,
    okText: '重命名',
    allowPath: true,
  });
  if (name === null) return;
  try {
    await renameCommandFolder(folder, name);
  } catch (err) {
    toast(`重命名分类目录失败: ${String(err)}`, 'error');
    return;
  }
  wbEvents.emit('project-changed');
  toast(`分类目录已重命名为「${name}」`, 'success');
}

async function deleteFolderFlow(folder: string): Promise<void> {
  const ok = await confirmDialog({
    title: '删除分类目录',
    message: `确定删除分类目录「${folder}」吗？`,
    danger: true,
    okText: '删除',
  });
  if (!ok) return;
  try {
    await deleteCommandFolder(folder);
  } catch (err) {
    toast(String(err), 'error');
    return;
  }
  expandedFolders.delete(folder); // 已删除分类不再保留展开状态
  persistFoldersExpanded();
  wbEvents.emit('project-changed');
  toast(`分类目录「${folder}」已删除`, 'success');
}

/* ---------- 卡片操作 ---------- */
function runOnTerminal(action: 'paste' | 'execute', cmd: string): void {
  const api = getActiveTerminalApi();
  if (!api) { toast('没有可用的终端标签页'); return; }
  if (action === 'paste') api.paste(cmd);
  else api.execute(cmd);
}

/** upsert 成功后同步 store 持有的当前项目对象(克隆新引用,触发订阅者重渲染) */
function syncProjectStore(owner: Project): void {
  const s = useWorkbench.getState();
  if (s.project && s.project.id === owner.id) s.setProject({ ...owner });
}

async function deleteQuickCommand(d: DisplayedCommand): Promise<void> {
  const ok = await confirmDialog({
    title: '删除命令收藏',
    message: `确定删除「${d.qc.title}」吗？${d.owner !== useWorkbench.getState().project ? `（归属项目「${d.owner.name}」）` : ''}`,
    danger: true,
    okText: '删除',
  });
  if (!ok) return;
  const idx = d.owner.quickCommands.indexOf(d.qc);
  if (idx >= 0) d.owner.quickCommands.splice(idx, 1);
  try {
    await upsertProject(d.owner);
    syncProjectStore(d.owner);
    wbEvents.emit('project-changed');
  } catch (err) {
    toast(String(err), 'error');
  }
}

/* ---------- 新增/编辑模态(字段 DOM 照 legacy 的 qc 模态;body 级浮层) ---------- */
function QuickCommandModal({ qc, owner, onDone }: {
  qc: QuickCommand | null;
  owner: Project | null;
  onDone: () => void;
}): JSX.Element {
  const isNew = !qc;
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(qc?.title ?? '');
  const [command, setCommand] = useState(qc?.command ?? '');
  const [folder, setFolder] = useState(qc?.folder ?? '');
  const [global, setGlobal] = useState(qc?.global ?? false);
  const titleRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  /* 淡入 */
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  /* 挂载后聚焦标题;编辑态全选标题文本(同 legacy) */
  useEffect(() => {
    titleRef.current?.focus();
    if (qc && title) titleRef.current?.select();
  }, []);

  /* 所属目录组合框:attachCombo 每次展开时取最新候选(经模块级 ref,避免闭包过期);
     必须用 useLayoutEffect:卸载时它的 destroy 先于子节点 DOM 移除执行(React 18 删除顺序),
     可先把 input 从 .combo 包装还原回 .field,避免 removeChild 抛异常 */
  useLayoutEffect(() => {
    const input = folderInputRef.current;
    if (!input) return;
    attachCombo(input, folderOptions);
    return () => {
      input.dispatchEvent(new FocusEvent('blur')); // 收起可能打开的下拉(同时移除 document/window 临时监听)
      const wrap = input.parentElement;
      if (wrap && wrap.classList.contains('combo') && wrap.parentElement) {
        wrap.parentElement.insertBefore(input, wrap); // 还原 input 到 React 管理的 .field 下
        wrap.remove();
      }
    };
  }, []);

  const close = (): void => {
    setOpen(false);
    setTimeout(onDone, 160); // 淡出后再卸载
  };

  const save = async (): Promise<void> => {
    const t = title.trim();
    const c = command.trim();
    if (!t || !c) { toast('标题和命令不能为空'); return; }
    if (!owner) { toast('当前没有可用项目'); return; }
    /* 所属目录:规范化 '/' 分隔路径(去首尾/重复分隔符),留空 = 未分类(与服务器表单同语义) */
    const folderName = folder.trim().split('/').filter(Boolean).join('/');
    if (qc) {
      qc.title = t;
      qc.command = c;
      qc.folder = folderName;
      qc.global = global;
    } else {
      owner.quickCommands.push({ id: uid('qc'), title: t, command: c, folder: folderName, global });
    }
    close();
    try {
      await upsertProject(owner);
      syncProjectStore(owner);
      wbEvents.emit('project-changed');
    } catch (err) {
      toast(String(err), 'error');
    }
  };

  return (
    <div
      className={`modal-mask${open ? ' open' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="modal" style={{ width: 460 }}>
        <div className="modal-head">
          <h3>{isNew ? '新增命令收藏' : '编辑命令收藏'}</h3>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>标题 <span className="req">*</span></label>
            <input ref={titleRef} className="input wbs-commands-qc-title-input" placeholder="例如：查看 Git 状态"
              value={title} onChange={(e) => setTitle(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void save(); } }} />
          </div>
          <div className="field">
            <label>命令 <span className="req">*</span></label>
            <textarea className="textarea wbs-commands-qc-cmd-input" rows={3} placeholder="例如：git status && git log --oneline -5"
              value={command} onChange={(e) => setCommand(e.currentTarget.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }} />
          </div>
          <div className="field">
            <label>所属目录</label>
            <input ref={folderInputRef} className="input wbs-commands-qc-folder-input" placeholder="可输入新分类或从下拉选择，例如：常用/部署"
              value={folder} onChange={(e) => setFolder(e.currentTarget.value)} />
            <div className="hint">以 / 分隔的目录路径，可下拉选择已有分类，也可直接输入新分类；留空表示未分类</div>
          </div>
          <div className="field">
            <label className="wbs-commands-global-label">
              <input type="checkbox" className="wbs-commands-global-input" checked={global}
                onChange={(e) => setGlobal(e.currentTarget.checked)} /> 全局可用（所有项目的命令收藏与快捷指令面板可见可用）
            </label>
            <div className="hint">勾选后可在所有项目中使用；编辑/删除仍归属{owner ? `「${owner.name}」` : '其原项目'}</div>
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn wbs-commands-cancel" onClick={close}>取消</button>
          <button className="btn primary wbs-commands-save" onClick={() => void save()}>保存</button>
        </div>
      </div>
    </div>
  );
}

/** owner 为命令归属项目:新增 = 当前项目;编辑全局命令 = 其原项目(跨项目编辑仍写回原项目) */
function openQuickCommandModal(qc: QuickCommand | null, owner: Project | null): void {
  /* 移除本模块残留的关闭中弹层(fade-out 期间仍挂在 DOM,避免输入被旧弹层截获) */
  document.querySelectorAll('.modal-mask').forEach((m) => {
    if (m.querySelector('.wbs-commands-qc-title-input')) m.remove();
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<QuickCommandModal qc={qc} owner={owner} onDone={() => { root.unmount(); host.remove(); }} />);
}

/* ---------- 卡片 ---------- */
function QuickCommandCard({ d }: { d: DisplayedCommand }): JSX.Element {
  const { qc } = d;
  return (
    <div className="card wbs-commands-qc-card">
      <div className="wbs-commands-qc-head">
        <div className="wbs-commands-qc-title ellipsis" title={qc.title}>{qc.title}</div>
        {qc.global ? <span className="tag blue wbs-commands-global-tag">全局</span> : null}
        <span className="wbs-commands-qc-icons">
          <button className="icon-btn wbs-commands-edit" title="编辑" onClick={() => openQuickCommandModal(d.qc, d.owner)}>
            <Icon name="pencil" />
          </button>
          <button className="icon-btn danger wbs-commands-del" title="删除" onClick={() => void deleteQuickCommand(d)}>
            <Icon name="trash" />
          </button>
        </span>
      </div>
      <div className="wbs-commands-qc-cmd mono" title={qc.command}>{qc.command}</div>
      <div className="wbs-commands-qc-actions">
        <button className="btn small wbs-commands-copy" onClick={() => runOnTerminal('paste', qc.command)}>复制到终端</button>
        <button className="btn small wbs-commands-run" onClick={() => runOnTerminal('execute', qc.command)}>立即执行</button>
      </div>
    </div>
  );
}

/* ---------- 面板主体 ---------- */

/** 最近一次拉取的分类清单与全部命令(供所属目录组合框候选;模块级,跨模态存活) */
let latestFolders: string[] = [];
let latestCommands: QuickCommand[] = [];

/** 所属目录组合框候选:commandFolders ∪ 各命令 folder 派生值(去重排序);手输新分类保存时后端自动注册 */
function folderOptions(): string[] {
  const opts = new Set<string>(latestFolders);
  latestCommands.forEach((qc) => { if (qc.folder) opts.add(qc.folder); });
  return Array.from(opts).sort((a, b) => a.localeCompare(b, 'zh'));
}

function CommandsPanelBody(): JSX.Element {
  const [displayed, setDisplayed] = useState<DisplayedCommand[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [searchText, setSearchText] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  /* 数据源:当前项目 quickCommands + 其他项目 global=true 命令(全局命令编辑/删除仍归属原项目) */
  useEffect(() => {
    let alive = true;
    void (async () => {
      const out: DisplayedCommand[] = [];
      const project = useWorkbench.getState().project;
      if (project) {
        for (const qc of project.quickCommands ?? []) out.push({ qc, owner: project });
      }
      let latestFoldersLocal: string[] = [];
      try {
        const state = await getState();
        latestFoldersLocal = state.commandFolders ?? [];
        // 展开状态播种:首次取到 state 即恢复分类展开集合(此刻尚无列表 DOM 可点击,无竞态)
        if (!foldersSeeded) {
          foldersSeeded = true;
          for (const f of state.uiExpanded?.['commands:folders'] ?? []) expandedFolders.add(f);
        }
        for (const p of state.projects) {
          if (p.id === project?.id) continue;
          for (const qc of p.quickCommands ?? []) {
            if (qc.global) out.push({ qc, owner: p });
          }
        }
      } catch {
        /* 后端未就绪时仅展示当前项目命令 */
      }
      if (!alive) return;
      setDisplayed(out);
      setFolders(latestFoldersLocal);
      latestFolders = latestFoldersLocal;
      latestCommands = out.map((d) => d.qc);
    })();
    return () => { alive = false; };
  }, [reloadKey]);

  /* 其他模块(终端区块/本面板)改 quickCommands 后联动刷新 */
  useEffect(() => wbEvents.on('project-changed', () => setReloadKey((k) => k + 1)), []);

  /* ---------- 渲染计算 ---------- */
  const q = searchText.trim().toLowerCase();
  const searching = !!q;
  /* 搜索过滤:标题 / 命令内容 大小写不敏感;空串显示全部 */
  const filtered = displayed.filter(({ qc }) =>
    !q || qc.title.toLowerCase().includes(q) || qc.command.toLowerCase().includes(q));

  /* 分组:commandFolders(含空目录)∪ 各命令 folder 派生值;未分类(空串)排最后 */
  const groups = new Map<string, DisplayedCommand[]>();
  const folderSet = new Set<string>(folders);
  filtered.forEach((d) => folderSet.add(d.qc.folder || ''));
  folderSet.forEach((k) => groups.set(k, []));
  filtered.forEach((d) => groups.get(d.qc.folder || '')!.push(d));
  const keys = Array.from(groups.keys()).sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return a.localeCompare(b, 'zh');
  });

  /* 「全部展开 / 全部折叠」单按钮:按当前状态切换,图标 = 目标动作;搜索中隐藏 */
  const allExpanded = keys.length > 0 && keys.every((k) => expandedFolders.has(k));

  const toggleAll = (): void => {
    if (allExpanded) expandedFolders.clear();
    else keys.forEach((k) => expandedFolders.add(k));
    persistFoldersExpanded();
    setReloadKey((k) => k + 1);
  };

  const toggleFolder = (folderKey: string): void => {
    if (expandedFolders.has(folderKey)) collapseFolder(folderKey);
    else expandFolder(folderKey);
    setReloadKey((k) => k + 1);
  };

  return (
    <div className="wbs-content">
      {/* 搜索行:搜索框 + 新建分类目录 + 全部展开/折叠(持久元素,不随列表重建) */}
      <div className="wbs-commands-search">
        <input className="input" placeholder="搜索命令…" value={searchText}
          onChange={(e) => setSearchText(e.currentTarget.value)} />
        <button className="icon-btn" title="新建分类目录" onClick={() => void createFolderFlow()}>
          <Icon name="folderPlus" />
        </button>
        <button className={`icon-btn${searching ? ' hidden' : ''}`} title={allExpanded ? '全部折叠' : '全部展开'} onClick={toggleAll}>
          <Icon name={allExpanded ? 'folder' : 'folderOpen'} />
        </button>
      </div>
      <div className="wbs-commands-list">
        {displayed.length === 0 ? (
          <div className="empty-state">
            <div className="icon"><Icon name="star" /></div>
            <div>暂无命令收藏</div>
            <div style={{ fontSize: '11.5px' }}>点击「+ 新增」创建常用命令</div>
          </div>
        ) : (
          keys.map((folderKey) => {
            const items = groups.get(folderKey)!;
            if (searching && items.length === 0) return null; // 搜索中隐藏无命中的组(含空目录)
            const expanded = searching ? true : expandedFolders.has(folderKey);
            return (
              <div key={folderKey}>
                <div
                  className={`wbs-commands-group-title${expanded ? ' expanded' : ''}`}
                  onClick={searching ? undefined : () => toggleFolder(folderKey)}
                >
                  <span className="wbs-commands-group-ic"><Icon name={expanded ? 'folderOpen' : 'folder'} /></span>
                  <span className="wbs-commands-group-name">{folderKey || '未分类'}</span>
                  <span className="tag">{items.length}</span>
                  {folderKey ? (
                    <>
                      <button className="icon-btn" title={`重命名「${folderKey}」`}
                        onClick={(e) => { e.stopPropagation(); void renameFolderFlow(folderKey); }}>
                        <Icon name="pencil" />
                      </button>
                      {/* 仅空组(计数 0)可删除;搜索态下空组已隐藏,不渲染删除入口 */}
                      {!searching && items.length === 0 ? (
                        <button className="icon-btn danger" title={`删除「${folderKey}」`}
                          onClick={(e) => { e.stopPropagation(); void deleteFolderFlow(folderKey); }}>
                          <Icon name="trash" />
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
                <div className={`wbs-commands-group-list${expanded ? '' : ' hidden'}`}>
                  {items.map((d) => <QuickCommandCard key={d.qc.id} d={d} />)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ---------- 侧栏头操作区:「+ 新增」 ---------- */
function CommandsHeadActions(): JSX.Element {
  return (
    <button className="btn small primary" onClick={() => openQuickCommandModal(null, useWorkbench.getState().project)}>
      + 新增
    </button>
  );
}

export const commandsPanel: SidebarPanelDef = {
  title: '命令收藏',
  HeadActions: CommandsHeadActions,
  Panel: CommandsPanelBody,
};
