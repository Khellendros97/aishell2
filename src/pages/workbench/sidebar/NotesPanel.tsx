/**
 * 笔记侧栏面板(React 版,新建) —— 对照 .proto 无直接原型(新功能),交互习惯对齐
 * explorer(右键菜单 showContextMenu、行内输入、懒加载展开)。
 * 笔记是 workspace 全局 <workspace>/.aishell/notes 下的 markdown 文件树(不随项目变):
 * - 纯 React keyed 树(相对路径作 key,规模小,不抄 explorer 的 900 行命令式引擎);
 * - 懒加载:fsList 逐目录展开,展开状态经 setUiExpanded('notes', …) 持久化(全局 key);
 * - 拖拽仅树内(source='notes',目录行 drop 拒绝其它 source/自身/祖先);
 * - CRUD 复用 fs_* 命令(base = notesRoot());双击 .md 开 NoteTab,其它文件走 openLocalFile;
 * - 订阅 wbEvents 'notes-changed'(归档写笔记后由 ai-engine 广播)保持展开集合刷新。
 * 接口点:src/api.ts notes 段(notesRoot/notesList)+ fs 段(fsList/fsCreate/fsMove/fsDelete)。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fsCreate, fsDelete, fsList, fsMove, getState, notesRoot, setUiExpanded,
} from '../../../api';
import { DND_MIME, useWorkbench, wbEvents, wbHandles } from '../../../stores/workbench';
import { confirmDialog, showContextMenu, toast, uid, type CtxItem } from '../../../ui';
import { Icon } from '../../../shared/Icon';
import type { SidebarPanelDef } from './panel-types';
import type { NoteRef } from '../../../types';
import { openNote } from '../tabs/NoteTab';
import { openLocalFile } from '../tabs/EditorTab';
import './notes.css';

/** 树节点:path 为相对 notes 根的路径('/' 分隔;根为空串 '') */
interface NoteNode {
  path: string;
  name: string;
  isDir: boolean;
  /** 懒加载:undefined = 未加载 */
  children?: NoteNode[];
  loading: boolean;
}

/** 路径工具:树内一律 '/' 分隔相对路径;绝对路径拼接时用平台分隔符兜底 */
const joinRel = (base: string, name: string): string => (base ? `${base}/${name}` : name);
const parentOf = (rel: string): string => rel.split('/').slice(0, -1).join('/');

/** 模块级面板操作句柄:HeadActions(独立组件)触发面板主体的行内输入/刷新 */
let panelApi: { startCreate: (isDir: boolean, dirRel: string) => void; refresh: () => void } | null = null;

/** 展开状态防抖落盘定时器(setUiExpanded('notes', …) 全局 key,不随项目变) */
let persistTimer: ReturnType<typeof setTimeout> | undefined;

/** 在树中按相对路径找节点(找不到返回 null) */
function findNode(roots: NoteNode[], rel: string): NoteNode | null {
  if (!rel) return null;
  const parts = rel.split('/');
  let list = roots;
  let found: NoteNode | null = null;
  for (const part of parts) {
    found = list.find((n) => n.isDir && n.name === part) ?? null;
    if (!found) return null;
    list = found.children ?? [];
  }
  return found;
}

/** 更新树中某目录节点的 children(不可变替换,React keyed 列表依赖新引用) */
function withChildren(roots: NoteNode[], dirRel: string, children: NoteNode[]): NoteNode[] {
  if (!dirRel) return children;
  return roots.map((n) => {
    if (n.path === dirRel) return { ...n, children, loading: false };
    if (dirRel.startsWith(`${n.path}/`) && n.children) {
      return { ...n, children: withChildren(n.children, dirRel, children) };
    }
    return n;
  });
}

/** 从树中摘除某节点(重命名/移动后由刷新重建,此处用于删除即时反馈) */
function withoutNode(roots: NoteNode[], rel: string): NoteNode[] {
  return roots
    .filter((n) => n.path !== rel)
    .map((n) => (n.children ? { ...n, children: withoutNode(n.children, rel) } : n));
}

/** 目录子项排序:目录在前,各组按名称排序(explorer 习惯) */
function sortEntries(list: NoteNode[]): NoteNode[] {
  return [...list].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
}

function NotesPanelBody(): JSX.Element {
  const [rootAbs, setRootAbs] = useState<string | null>(null);
  const [rootError, setRootError] = useState<string | null>(null);
  const [roots, setRoots] = useState<NoteNode[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  /** 行内输入:新建(目标目录 + 类型)或重命名(目标节点) */
  const [inline, setInline] = useState<
    { kind: 'create'; dirRel: string; isDir: boolean } | { kind: 'rename'; rel: string } | null
  >(null);
  const rootsRef = useRef(roots);
  rootsRef.current = roots;
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  /* 挂载取根路径 + 展开状态(workspace 未配置 → 空态提示) */
  useEffect(() => {
    let alive = true;
    void Promise.all([notesRoot(), getState()])
      .then(([root, state]) => {
        if (!alive) return;
        setRootAbs(root);
        setRootError(null);
        setExpanded(new Set(state.uiExpanded['notes'] ?? []));
      })
      .catch((err) => { if (alive) { setRootError(String(err)); setRootAbs(null); } });
    return () => { alive = false; };
  }, []);

  /** 展开集合变更:防抖落盘 */
  const persistExpanded = useCallback((next: Set<string>): void => {
    setExpanded(next);
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      void setUiExpanded('notes', [...next]).catch(() => { /* 落盘失败静默(非关键路径) */ });
    }, 300);
  }, []);

  /** 加载某目录子项(相对路径,'' = 根) */
  const loadDir = useCallback(async (dirRel: string): Promise<void> => {
    if (!rootAbs) return;
    const abs = dirRel ? `${rootAbs}/${dirRel}` : rootAbs;
    const entries = await fsList(abs);
    const children = sortEntries(entries.map((e) => ({
      path: joinRel(dirRel, e.name),
      name: e.name,
      isDir: e.isDir,
      loading: false,
    })));
    setRoots((cur) => withChildren(cur, dirRel, children));
  }, [rootAbs]);

  /* 根目录首载 + reloadKey 联动(CRUD/notes-changed 后重载全部已展开目录,保持展开集合) */
  useEffect(() => {
    if (!rootAbs) return;
    let alive = true;
    void (async () => {
      try {
        await loadDir('');
        // 已展开目录逐个重载(并发;失败静默——目录可能已被删,由下一次展开时重新加载报错)
        const dirs = [...expandedRef.current];
        await Promise.all(dirs.map((d) => (alive ? loadDir(d).catch(() => undefined) : undefined)));
      } catch (err) {
        if (alive) toast(String(err), 'error');
      }
    })();
    return () => { alive = false; };
  }, [rootAbs, reloadKey, loadDir]);

  /* 订阅 notes-changed(归档写笔记等外部变更;保持展开集合刷新) */
  useEffect(() => wbEvents.on('notes-changed', () => setReloadKey((k) => k + 1)), []);

  /* 注册面板操作句柄(HeadActions 用;卸载清理) */
  useEffect(() => {
    panelApi = {
      startCreate: (isDir, dirRel) => {
        // 目标目录需已展开,新建行才可见
        if (dirRel && !expandedRef.current.has(dirRel)) {
          const next = new Set(expandedRef.current);
          next.add(dirRel);
          persistExpanded(next);
        }
        setInline({ kind: 'create', dirRel, isDir });
      },
      refresh: () => setReloadKey((k) => k + 1),
    };
    return () => { panelApi = null; clearTimeout(persistTimer); };
  }, [persistExpanded]);

  const toggleDir = (rel: string): void => {
    const next = new Set(expandedRef.current);
    if (next.has(rel)) {
      next.delete(rel);
    } else {
      next.add(rel);
      const node = findNode(rootsRef.current, rel);
      if (node && !node.children) {
        void loadDir(rel).catch((err) => toast(String(err), 'error'));
      }
    }
    persistExpanded(next);
  };

  /** 双击打开:.md → 笔记标签页;其它文件 → 编辑器标签 */
  const openNode = (node: NoteNode): void => {
    if (node.isDir) { toggleDir(node.path); return; }
    if (node.name.toLowerCase().endsWith('.md')) openNote(`${rootAbs}/${node.path}`, node.name);
    else openLocalFile(`${rootAbs}/${node.path}`, node.name);
  };

  /* ---------- 行内输入提交(新建 / 重命名) ---------- */
  const commitInline = (value: string): void => {
    const ctx = inline;
    setInline(null);
    if (!ctx || !rootAbs) return;
    const name = value.trim();
    if (!name) return;
    if (ctx.kind === 'create') {
      const rel = joinRel(ctx.dirRel, ctx.isDir ? name : (name.toLowerCase().endsWith('.md') ? name : `${name}.md`));
      void fsCreate(`${rootAbs}/${rel}`, ctx.isDir)
        .then(() => {
          if (ctx.isDir) {
            const next = new Set(expandedRef.current);
            next.add(rel);
            persistExpanded(next);
          }
          setReloadKey((k) => k + 1);
        })
        .catch((err) => toast(String(err), 'error'));
    } else {
      const dir = parentOf(ctx.rel);
      const from = `${rootAbs}/${ctx.rel}`;
      const to = `${rootAbs}/${joinRel(dir, name)}`;
      void fsMove(from, to)
        .then(() => setReloadKey((k) => k + 1))
        .catch((err) => toast(String(err), 'error'));
    }
  };

  /* ---------- 右键菜单 ---------- */
  const onNodeMenu = (e: React.MouseEvent, node: NoteNode): void => {
    e.preventDefault();
    e.stopPropagation();
    const abs = `${rootAbs}/${node.path}`;
    const isNote = !node.isDir && node.name.toLowerCase().endsWith('.md');
    const noteRefOf = (): NoteRef => ({
      id: uid('note'),
      path: abs,
      name: node.name.replace(/\.md$/i, ''),
    });
    showContextMenu(e.clientX, e.clientY, [
      { label: '打开', iconName: node.isDir ? 'folder' : 'file', action: () => openNode(node) },
      ...(node.isDir ? [
        'sep' as const,
        { label: '新建笔记', iconName: 'note', action: () => panelApi?.startCreate(false, node.path) } as CtxItem,
        { label: '新建目录', iconName: 'folderPlus', action: () => panelApi?.startCreate(true, node.path) } as CtxItem,
      ] : []),
      ...(isNote ? [
        'sep' as const,
        { label: '添加到对话', iconName: 'chatPlus', action: () => {
          const ref = noteRefOf();
          if (wbHandles.ai?.addNoteRef) wbHandles.ai.addNoteRef(ref);
          else toast('AI 面板尚未就绪');
        } } as CtxItem,
        { label: '转换成skill', iconName: 'sparkles', action: () => {
          const ref = noteRefOf();
          if (wbHandles.ai?.convertNoteToSkill) wbHandles.ai.convertNoteToSkill(ref);
          else toast('AI 面板尚未就绪');
        } } as CtxItem,
      ] : []),
      'sep',
      { label: '重命名', iconName: 'pencil', action: () => setInline({ kind: 'rename', rel: node.path }) } as CtxItem,
      {
        label: '删除', iconName: 'trash', danger: true,
        action: () => {
          void confirmDialog({
            title: node.isDir ? '删除目录' : '删除笔记',
            message: `确定删除「${node.name}」吗？${node.isDir ? '\n目录内全部内容将一并删除。' : ''}\n路径：${abs}`,
            danger: true,
            okText: '删除',
          }).then((ok) => {
            if (!ok) return;
            void fsDelete(abs)
              .then(() => {
                setRoots((cur) => withoutNode(cur, node.path));
                toast(`「${node.name}」已删除`, 'success');
              })
              .catch((err) => toast(String(err), 'error'));
          });
        },
      },
    ]);
  };

  /* ---------- 拖拽:仅笔记树内部(source='notes') ---------- */
  const onDragStart = (e: React.DragEvent, node: NoteNode): void => {
    e.dataTransfer.setData(DND_MIME, JSON.stringify({
      source: 'notes', path: node.path, name: node.name, isDir: node.isDir,
    }));
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDirDrop = (e: React.DragEvent, dirRel: string): void => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).classList.remove('wbs-notes-drop');
    const raw = (() => { try { return e.dataTransfer.getData(DND_MIME); } catch { return ''; } })();
    if (!raw) return;
    const data = JSON.parse(raw) as { source?: string; path?: string; name?: string; isDir?: boolean };
    if (data.source !== 'notes' || !data.path || !data.name || !rootAbs) return;
    // 自身/祖先校验:目录不得移入自身或其后代
    if (data.path === dirRel || (data.isDir && dirRel.startsWith(`${data.path}/`))) {
      toast('不能移动到自身或其子目录', 'error');
      return;
    }
    if (parentOf(data.path) === dirRel) return; // 同目录 no-op
    void fsMove(`${rootAbs}/${data.path}`, `${rootAbs}/${joinRel(dirRel, data.name)}`)
      .then(() => setReloadKey((k) => k + 1))
      .catch((err) => toast(String(err), 'error'));
  };
  const dirDropProps = (dirRel: string): Record<string, unknown> => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(DND_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      (e.currentTarget as HTMLElement).classList.add('wbs-notes-drop');
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
        (e.currentTarget as HTMLElement).classList.remove('wbs-notes-drop');
      }
    },
    onDrop: (e: React.DragEvent) => onDirDrop(e, dirRel),
  });

  /* ---------- 行渲染(递归;key = 相对路径) ---------- */
  const renderNode = (node: NoteNode, depth: number): JSX.Element => {
    const open = node.isDir && expanded.has(node.path);
    const renaming = inline?.kind === 'rename' && inline.rel === node.path;
    return (
      <div key={node.path}>
        <div
          className="wbs-notes-row"
          style={{ paddingLeft: 6 + depth * 14 }}
          draggable={!renaming}
          onDragStart={(e) => onDragStart(e, node)}
          onClick={() => { if (node.isDir) toggleDir(node.path); }}
          onDoubleClick={() => { if (!node.isDir) openNode(node); }}
          onContextMenu={(e) => onNodeMenu(e, node)}
          {...(node.isDir ? dirDropProps(node.path) : {})}
        >
          <span className="wbs-explorer-arrow">{node.isDir ? (open ? '▾' : '▸') : ''}</span>
          <span className="wbs-explorer-file-tag">
            <Icon name={node.isDir ? (open ? 'folderOpen' : 'folder') : (node.name.endsWith('.md') ? 'note' : 'file')} />
          </span>
          {renaming ? (
            <input
              className="input wbs-explorer-rename"
              defaultValue={node.name}
              spellCheck={false}
              autoFocus
              onFocus={(e) => {
                // 默认选中主名(不含扩展名),对齐系统重命名习惯
                const dot = node.isDir ? -1 : node.name.lastIndexOf('.');
                e.currentTarget.setSelectionRange(0, dot > 0 ? dot : node.name.length);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitInline(e.currentTarget.value); }
                else if (e.key === 'Escape') { e.preventDefault(); setInline(null); }
              }}
              onBlur={(e) => commitInline(e.currentTarget.value)}
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="wbs-explorer-name" title={node.path}>{node.name}</span>
          )}
        </div>
        {open && (
          <div>
            {inline?.kind === 'create' && inline.dirRel === node.path && (
              <div className="wbs-notes-row" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>
                <span className="wbs-explorer-arrow" />
                <span className="wbs-explorer-file-tag"><Icon name={inline.isDir ? 'folderPlus' : 'note'} /></span>
                <input
                  className="input wbs-explorer-rename"
                  placeholder={inline.isDir ? '目录名' : '笔记名(自动补 .md)'}
                  spellCheck={false}
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); commitInline(e.currentTarget.value); }
                    else if (e.key === 'Escape') { e.preventDefault(); setInline(null); }
                  }}
                  onBlur={(e) => commitInline(e.currentTarget.value)}
                />
              </div>
            )}
            {node.loading
              ? <div className="wbs-explorer-loading" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>加载中…</div>
              : (node.children ?? []).map((c) => renderNode(c, depth + 1))}
            {node.children && node.children.length === 0 && (
              <div className="wbs-explorer-loading" style={{ paddingLeft: 6 + (depth + 1) * 14 }}>（空目录）</div>
            )}
          </div>
        )}
      </div>
    );
  };

  /* ---------- 渲染 ---------- */
  if (rootError) {
    return (
      <div className="wbs-content">
        <div className="empty-state">
          <div className="icon"><Icon name="alert" /></div>
          <div>{rootError}</div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="wbs-content wbs-notes-root"
      {...dirDropProps('')}
      onContextMenu={(e) => {
        // 空白区右键:根目录新建(行命中行自身 stopPropagation,不会冒泡到这里)
        e.preventDefault();
        showContextMenu(e.clientX, e.clientY, [
          { label: '新建笔记', iconName: 'note', action: () => panelApi?.startCreate(false, '') },
          { label: '新建目录', iconName: 'folderPlus', action: () => panelApi?.startCreate(true, '') },
          { label: '刷新', iconName: 'refresh', action: () => setReloadKey((k) => k + 1) },
        ]);
      }}
    >
      {inline?.kind === 'create' && inline.dirRel === '' && (
        <div className="wbs-notes-row" style={{ paddingLeft: 6 }}>
          <span className="wbs-explorer-arrow" />
          <span className="wbs-explorer-file-tag"><Icon name={inline.isDir ? 'folderPlus' : 'note'} /></span>
          <input
            className="input wbs-explorer-rename"
            placeholder={inline.isDir ? '目录名' : '笔记名(自动补 .md)'}
            spellCheck={false}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitInline(e.currentTarget.value); }
              else if (e.key === 'Escape') { e.preventDefault(); setInline(null); }
            }}
            onBlur={(e) => commitInline(e.currentTarget.value)}
          />
        </div>
      )}
      {rootAbs === null ? (
        <div className="wbs-explorer-loading" style={{ paddingLeft: 6 }}>加载中…</div>
      ) : roots.length === 0 && inline?.kind !== 'create' ? (
        <div className="empty-state">
          <div className="icon"><Icon name="note" /></div>
          <div>暂无笔记</div>
          <div style={{ fontSize: '11.5px' }}>点击「+ 新建笔记」或右键空白区创建;归档会话时也可生成笔记</div>
        </div>
      ) : (
        roots.map((n) => renderNode(n, 0))
      )}
    </div>
  );
}

/* ---------- 侧栏头操作区:新建笔记 / 新建目录 / 刷新 ---------- */
function NotesHeadActions(): JSX.Element {
  const panel = useWorkbench((s) => s.panel);
  return (
    <>
      <button className="icon-btn" title="新建笔记" disabled={panel !== 'notes'}
        onClick={() => panelApi?.startCreate(false, '')}><Icon name="note" /></button>
      <button className="icon-btn" title="新建目录" disabled={panel !== 'notes'}
        onClick={() => panelApi?.startCreate(true, '')}><Icon name="folderPlus" /></button>
      <button className="icon-btn" title="刷新"
        onClick={() => panelApi?.refresh()}><Icon name="refresh" /></button>
    </>
  );
}

export const notesPanel: SidebarPanelDef = {
  title: '笔记',
  HeadActions: NotesHeadActions,
  Panel: NotesPanelBody,
};
