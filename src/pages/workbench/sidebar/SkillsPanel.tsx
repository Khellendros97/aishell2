/**
 * Skill 管理面板 —— React 版,逐行对照 legacy/pages/workbench/sidebar/skills.ts(501 行)。
 * 数据源 skillsList(后端权威,SKILL.md enabled 是启停唯一事实源),不写 localStorage;
 * 分组折叠状态(global|project)模块内 Set 会话级保留(不落盘);搜索只过滤不持久化。
 * 新增/编辑模态为 body 级浮层(createRoot 挂载):完整 SKILL.md textarea 原样提交,
 * scope 编辑区(local/all + 远程主机卡片 + 其它 remote: 名称 chips)独立收集后作为
 * skillSave 显式参数交给后端(后端只重写顶层 scope,其余字节不动),前端不解析重写 YAML。
 * 契约:skillsPanel 导出(标题 + HeadActions「Skill Hub / + 添加」)。
 * 接口点:src/api.ts skills 段(skillsList / skillRead / skillSave / skillDelete / skillSetEnabled)。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Server, SkillOrigin, SkillSummary } from '../../../types';
import { getState, skillDelete, skillRead, skillSave, skillSetEnabled, skillsList } from '../../../api';
import { useWorkbench, wbEvents } from '../../../stores/workbench';
import { confirmDialog, toast } from '../../../ui';
import { Icon } from '../../../shared/Icon';
import type { SidebarPanelDef } from './panel-types';
import './skills.css';

/** 新增时 textarea 精确预填模板(选中 your-skill-name 方便直接替换;保存前由后端权威校验) */
const NEW_SKILL_TEMPLATE = `---
name: your-skill-name
description: 说明该 Skill 的能力与触发场景。
scope:
  - all
enabled: true
---

# Skill instructions

在此编写给 AI 的操作说明。`;

/** 分组折叠状态(global|project);模块级会话保留,首次挂载默认展开,不写 aishell.json */
const collapsedGroups = new Set<SkillOrigin>();

const projectId = (): string => useWorkbench.getState().project?.id ?? '';

/** 面板刷新句柄:模态(HeadActions 与卡片共用的 body 级浮层)保存成功后触发列表重拉
    (对照 legacy 模块级 render 函数) */
let refreshPanel: (() => void) | null = null;

/* ---------- 新增/编辑模态(scope 编辑区独立收集,保存时作为显式参数交给后端) ---------- */
function SkillModal({ skill, onDone }: { skill: SkillSummary | null; onDone: () => void }): JSX.Element {
  const isNew = !skill;
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState<SkillOrigin>(skill?.origin ?? 'project');
  const [content, setContent] = useState(isNew ? NEW_SKILL_TEMPLATE : '');
  /** scope 当前值(数组,去重保序);checkbox/服务器卡/extra chips 都从它渲染 */
  const [scope, setScope] = useState<string[]>(isNew ? ['all'] : [...(skill?.scope ?? [])]);
  const [servers, setServers] = useState<Server[]>([]);
  const [remoteQuery, setRemoteQuery] = useState('');
  const [extraInput, setExtraInput] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const contentRef = useRef<HTMLTextAreaElement>(null);

  /* 淡入 */
  useEffect(() => {
    const raf = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  /* 初始化:编辑用后端 SkillDocument.content(异步,关闭后丢弃迟到结果);
     新增预填模板并选中 name 占位 */
  useEffect(() => {
    let alive = true;
    if (isNew) {
      const ta = contentRef.current;
      ta?.focus();
      const nameIdx = content.indexOf('your-skill-name');
      if (nameIdx >= 0) ta?.setSelectionRange(nameIdx, nameIdx + 'your-skill-name'.length);
      return;
    }
    void skillRead(projectId(), skill.origin, skill.name)
      .then((doc) => { if (alive) { setContent(doc.content); setError(''); } })
      .catch((err: unknown) => { if (alive) setError(`读取 Skill 失败：${String(err)}`); });
    return () => { alive = false; };
  }, []);

  /* 远程主机候选:当前项目绑定服务器(getState 异步拉取,失败则仅可手动输入) */
  useEffect(() => {
    let alive = true;
    const project = useWorkbench.getState().project;
    if (project) {
      void getState().then((state) => {
        if (!alive) return;
        setServers(state.servers.filter((s) => (project.serverIds ?? []).includes(s.id)));
      }).catch(() => { /* 无服务器也可手动输入其它主机名称 */ });
    }
    return () => { alive = false; };
  }, []);

  const inScope = (v: string): boolean => scope.includes(v);

  const setScopeValue = (v: string, on: boolean): void => {
    setScope((cur) => {
      const idx = cur.indexOf(v);
      if (on && idx < 0) return [...cur, v];
      if (!on && idx >= 0) return cur.filter((x) => x !== v);
      return cur;
    });
  };

  const remoteOf = (name: string): string => `remote:${name}`;

  const addExtra = (): void => {
    const v = extraInput.trim();
    if (!v) return;
    if (!/^remote:/.test(v)) {
      toast('其它远程主机名称需以 remote: 开头，例如 remote:prod-db');
      return;
    }
    setScopeValue(v, true);
    setExtraInput('');
  };

  const close = (): void => {
    setOpen(false);
    setTimeout(onDone, 160); // 淡出后再卸载
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await skillSave(projectId(), origin, isNew ? null : skill.name, content, [...scope]);
      close();
      refreshPanel?.();
      toast('Skill 已保存', 'success');
    } catch (err) {
      /* 失败保留弹窗和输入并展示后端可执行错误 */
      setError(String(err));
      setSaving(false);
    }
  };

  const remoteQ = remoteQuery.trim().toLowerCase();
  const filteredServers = remoteQ
    ? servers.filter((s) => [s.name, s.host, s.username].some((v) => v.toLowerCase().includes(remoteQ)))
    : servers;
  /* 非当前项目服务器条目的 remote: 名称(可逐项移除的 chips) */
  const extras = scope.filter((v) => v.startsWith('remote:') && !servers.some((s) => remoteOf(s.name) === v));

  return (
    <div
      className={`modal-mask${open ? ' open' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="modal" style={{ width: 720 }}>
        <div className="modal-head">
          <h3>{isNew ? '新增 Skill' : '编辑 Skill'}</h3>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>来源</label>
            <select className="input wbs-skills-origin-select" value={origin} disabled={!isNew}
              onChange={(e) => setOrigin(e.currentTarget.value as SkillOrigin)}>
              <option value="project">项目</option>
              <option value="global">全局</option>
            </select>
            <div className="hint">项目技能存于 &lt;项目目录&gt;/.aishell/skills/，全局技能存于 &lt;工作区目录&gt;/.aishell/skills/</div>
          </div>
          <div className="field">
            <label>SKILL.md 内容 <span className="req">*</span></label>
            <textarea ref={contentRef} className="textarea mono wbs-skills-content" rows={16} spellCheck={false}
              value={content} onChange={(e) => { setContent(e.currentTarget.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); } }} />
            <div className="hint">name/description 以后端校验为准；scope 与 enabled 由下方/后端管理，textarea 内改动 scope 会被保存时重写</div>
          </div>
          <div className="field">
            <label>作用域 scope</label>
            <div className="wbs-skills-scope-opts">
              <label className="wbs-skills-check">
                <input type="checkbox" className="wbs-skills-scope-local" checked={inScope('local')}
                  onChange={(e) => setScopeValue('local', e.currentTarget.checked)} /> local（本地工作区域）
              </label>
              <label className="wbs-skills-check">
                <input type="checkbox" className="wbs-skills-scope-all" checked={inScope('all')}
                  onChange={(e) => setScopeValue('all', e.currentTarget.checked)} /> all（始终适用）
              </label>
            </div>
            <div className="hint">远程主机（来自项目绑定服务器，勾选加入 scope：remote:&lt;Server.name&gt;）：</div>
            <input className="input wbs-skills-remote-search" placeholder="搜索服务器…" value={remoteQuery}
              onChange={(e) => setRemoteQuery(e.currentTarget.value)} />
            <div className="wbs-skills-remote-list">
              {filteredServers.length ? filteredServers.map((s) => {
                const v = remoteOf(s.name);
                const selected = inScope(v);
                return (
                  <div key={s.id} className={`card clickable wbs-skills-remote-card${selected ? ' selected' : ''}`}
                    onClick={() => setScopeValue(v, !selected)}>
                    <span className="ellipsis" title={s.name}>{s.name}</span>
                    <span className="mono">{s.host}</span>
                  </div>
                );
              }) : <div className="server-empty">没有匹配的服务器，可在「其它远程主机名称」手动添加</div>}
            </div>
            <div className="hint">其它远程主机名称（可逐项添加/移除）：</div>
            <div className="wbs-skills-extra-row">
              <input className="input wbs-skills-extra-input" placeholder="例如：prod-db" value={extraInput}
                onChange={(e) => setExtraInput(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addExtra(); } }} />
              <button className="btn small wbs-skills-extra-add" onClick={addExtra}>添加</button>
            </div>
            <div className="wbs-skills-extra-chips">
              {extras.map((v) => (
                <span className="tag wbs-skills-extra-chip" key={v}>
                  {v}
                  <button className="icon-btn wbs-skills-chip-rm" title="移除" onClick={() => setScopeValue(v, false)}>
                    <Icon name="x" />
                  </button>
                </span>
              ))}
            </div>
          </div>
          {error ? <div className="wbs-skills-parse-error">{error}</div> : null}
        </div>
        <div className="modal-foot">
          <button className="btn wbs-skills-cancel" onClick={close}>取消</button>
          <button className="btn primary wbs-skills-save" disabled={saving} onClick={() => void save()}>保存</button>
        </div>
      </div>
    </div>
  );
}

function openSkillModal(d: SkillSummary | null): void {
  /* 移除本模块残留的关闭中弹层(fade-out 期间仍挂在 DOM,避免输入被旧弹层截获) */
  document.querySelectorAll('.modal-mask').forEach((m) => {
    if (m.querySelector('.wbs-skills-origin-select')) m.remove();
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(<SkillModal skill={d} onDone={() => { root.unmount(); host.remove(); }} />);
}

/* ---------- 卡片 ---------- */
function SkillCard({ d, onToggle, onDelete }: {
  d: SkillSummary;
  onToggle(d: SkillSummary, next: boolean): Promise<boolean>;
  onDelete(d: SkillSummary): void;
}): JSX.Element {
  const [pending, setPending] = useState(false);
  /** 请求期间的显示值(原值;成功后随 d.enabled 同步) */
  const [display, setDisplay] = useState(d.enabled);
  useEffect(() => { setDisplay(d.enabled); }, [d.enabled]);

  const handleToggle = (next: boolean): void => {
    if (pending) return;
    setPending(true);
    setDisplay(!next); // 请求期间显示原值(与 legacy 一致)
    void onToggle(d, next).then((ok) => {
      setPending(false);
      setDisplay(ok ? next : !next);
    });
  };

  return (
    <div className="card wbs-skills-card">
      <div className="wbs-skills-head">
        <div className="wbs-skills-name ellipsis" title={d.name}>{d.name}</div>
        <span className={`tag wbs-skills-origin${d.origin === 'global' ? ' blue' : ''}`}>
          {d.origin === 'global' ? '全局' : '项目'}
        </span>
      </div>
      <div className="wbs-skills-desc" title={d.description}>{d.description}</div>
      <div className="wbs-skills-tags">
        {d.scope.map((s) => <span className="tag wbs-skills-scope-tag" key={s}>{s}</span>)}
      </div>
      <div className="wbs-skills-actions">
        <label className="db-switch" title="启用/禁用（只改 SKILL.md 顶层 enabled）">
          <input type="checkbox" className="wbs-skills-toggle" checked={display} disabled={pending}
            onChange={(e) => handleToggle(e.currentTarget.checked)} />
          <span className="db-switch-track"></span>
        </label>
        <button className="icon-btn" title="编辑" onClick={() => openSkillModal(d)}><Icon name="pencil" /></button>
        <button className="icon-btn danger" title="删除" onClick={() => void onDelete(d)}><Icon name="trash" /></button>
      </div>
    </div>
  );
}

/* ---------- 面板主体 ---------- */
function SkillsPanelBody(): JSX.Element {
  const [items, setItems] = useState<SkillSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  /* 挂载时注册面板刷新句柄(模态保存成功后经它重拉列表;卸载清理) */
  useEffect(() => {
    refreshPanel = () => setReloadKey((k) => k + 1);
    return () => { refreshPanel = null; };
  }, []);

  useEffect(() => {
    let alive = true;
    void skillsList(projectId())
      .then((list) => { if (alive) { setItems(list); setError(null); } })
      .catch((err) => { if (alive) setError(String(err)); });
    return () => { alive = false; };
  }, [reloadKey]);

  /* 项目切换/CRUD 后联动刷新 */
  useEffect(() => wbEvents.on('project-changed', () => setReloadKey((k) => k + 1)), []);

  /** 启停开关:请求期间卡片显示原值并禁用(与 legacy 一致),成功刷新列表、失败提示 */
  const onToggle = async (d: SkillSummary, next: boolean): Promise<boolean> => {
    try {
      await skillSetEnabled(projectId(), d.origin, d.name, next);
      setReloadKey((k) => k + 1);
      return true;
    } catch (err) {
      toast(String(err), 'error');
      return false;
    }
  };

  const onDelete = (d: SkillSummary): void => {
    void confirmDialog({
      title: '删除 Skill',
      message: `确定删除「${d.name}」吗？\n来源：${d.origin === 'global' ? '全局' : '项目'}\n磁盘目录：${d.path}`,
      danger: true,
      okText: '删除',
    }).then((ok) => {
      if (!ok) return;
      void skillDelete(projectId(), d.origin, d.name)
        .then(() => { setReloadKey((k) => k + 1); toast(`Skill「${d.name}」已删除`, 'success'); })
        .catch((err) => toast(String(err), 'error'));
    });
  };

  const toggleGroup = (origin: SkillOrigin): void => {
    if (collapsedGroups.has(origin)) collapsedGroups.delete(origin);
    else collapsedGroups.add(origin);
    setReloadKey((k) => k + 1);
  };

  /* ---------- 渲染 ---------- */
  const q = searchText.trim().toLowerCase();
  const searching = !!q;
  /* 搜索过滤:名称 / 描述 / scope 大小写不敏感 */
  const filtered = items.filter((s) =>
    !q
    || s.name.toLowerCase().includes(q)
    || s.description.toLowerCase().includes(q)
    || s.scope.some((sc) => sc.toLowerCase().includes(q)));

  return (
    <div className="wbs-content">
      {/* 搜索行:不随列表重建,避免输入焦点丢失 */}
      <div className="wbs-skills-search">
        <input className="input" placeholder="搜索 Skill（名称/描述/scope）…" value={searchText}
          onChange={(e) => setSearchText(e.currentTarget.value)} />
      </div>
      <div className="wbs-skills-list">
        {/* 工作区/项目目录缺失等后端错误:展示可执行错误与重试按钮,不伪装成空列表 */}
        {error ? (
          <div className="empty-state">
            <div className="icon"><Icon name="alert" /></div>
            <div className="wbs-skills-error">{error}</div>
            <button className="btn small" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
          </div>
        ) : items.length === 0 ? (
          <div className="empty-state">
            <div className="icon"><Icon name="sparkles" /></div>
            <div>暂无 Skill</div>
            <div style={{ fontSize: '11.5px' }}>点击「+ 添加」创建全局或项目 Skill</div>
          </div>
        ) : searching && filtered.length === 0 ? (
          <div className="empty-state">
            <div className="icon"><Icon name="search" /></div>
            <div>没有匹配的 Skill</div>
            <div style={{ fontSize: '11.5px' }}>试试名称、描述或 scope 关键词</div>
          </div>
        ) : (
          /* 两个固定分组:全局 / 项目(始终显示标题、数量与折叠状态;搜索期间强制展开命中组) */
          (['global', 'project'] as const).map((origin) => {
            const groupItems = filtered.filter((s) => s.origin === origin);
            if (searching && !groupItems.length) return null; // 搜索中隐藏无命中组
            const total = items.filter((s) => s.origin === origin).length;
            const expanded = searching ? true : !collapsedGroups.has(origin);
            return (
              <div key={origin}>
                <div
                  className={`wbs-skills-group-title${expanded ? ' expanded' : ''}`}
                  onClick={searching ? undefined : () => toggleGroup(origin)}
                >
                  <span className="wbs-skills-group-ic"><Icon name={expanded ? 'folderOpen' : 'folder'} /></span>
                  <span className="wbs-skills-group-name">{origin === 'global' ? '全局' : '项目'}</span>
                  <span className="tag">{total}</span>
                </div>
                <div className={`wbs-skills-group-list${expanded ? '' : ' hidden'}`}>
                  {groupItems.map((s) => (
                    <SkillCard key={s.id} d={s} onToggle={onToggle} onDelete={onDelete} />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

/* ---------- 侧栏头操作区:「Skill Hub」入口 + 「+ 添加」 ---------- */
function SkillsHeadActions(): JSX.Element {
  return (
    <div className="wbs-skills-head-actions">
      <button
        className="btn small wbs-skillhub-btn"
        title="在主工作区打开 Skill Hub"
        onClick={() => useWorkbench.getState().openTab({ id: 'skill-hub', type: 'skill-hub', title: 'Skill Hub' })}
      >
        <Icon name="package" /> Skill Hub
      </button>
      <button className="btn small primary" onClick={() => openSkillModal(null)}>
        + 添加
      </button>
    </div>
  );
}

export const skillsPanel: SidebarPanelDef = {
  title: 'Skill',
  HeadActions: SkillsHeadActions,
  Panel: SkillsPanelBody,
};
