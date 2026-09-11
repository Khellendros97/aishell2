/**
 * Skill 管理面板 —— React 版,逐行对照 legacy/pages/workbench/sidebar/skills.ts(501 行)。
 * 数据源 skillsList(后端权威,SKILL.md enabled 是启停唯一事实源),不写 localStorage;
 * 分组折叠状态(global|project)模块内 Set 会话级保留(不落盘);搜索只过滤不持久化。
 * 新增/编辑模态为 body 级浮层(createRoot 挂载):完整 SKILL.md textarea 原样提交,
 * scope 编辑区(local/all + 远程主机卡片 + 其它 remote: 名称 chips)独立收集后作为
 * skillSave 显式参数交给后端(后端只重写顶层 scope,其余字节不动),前端不解析重写 YAML。
 * 契约:skillsPanel 导出(标题 + HeadActions「Skill Hub / + 添加」)。
 * 接口点:src/api.ts skills 段(skillsList / skillRead / skillSave / skillDelete / skillSetEnabled /
 * skillPackUpload) 与 browser 段(browserPublishSkillhub)。
 */
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Server, SkillOrigin, SkillSummary } from '../../../types';
import { browserPublishSkillhub, browserPublishState, getState, incentiveRegisterSkillUpload, skillDelete, skillPackUpload, skillRead, skillSave, skillSetEnabled, skillsList } from '../../../api';
import { openInActivePage } from '../tabs/browser-engine';
import { useWorkbench, wbEvents, wbHandles } from '../../../stores/workbench';
import { confirmDialog, toast } from '../../../ui';
import { Icon } from '../../../shared/Icon';
import { useIncentiveEnabled } from '../../../shared/useIncentive';
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

/** 上传成功后通知云平台登记计分（激励计划 API 文档 §一）。
 *  作者归属由服务端回查 skillhub 核实，客户端只报 namespace/slug；
 *  404（刚上传有可见性延迟）/ 502（回查 skillhub 失败）为可重试，409（已被他人登记）/
 *  403（作者非本人）为终态不重试。失败只影响计分，不影响上传结果，故静默降级为提示。 */
async function notifySkillUpload(slug: string, namespace: string): Promise<void> {
  const RETRYABLE = ['（HTTP 404）', '（HTTP 502）'];
  const DELAYS_MS = [3000, 8000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      await incentiveRegisterSkillUpload(slug, namespace);
      toast(`Skill「${slug}」上传已登记，核实后计入激励积分`, 'success');
      return;
    } catch (err) {
      const msg = String(err);
      const retryable = RETRYABLE.some((m) => msg.includes(m));
      if (!retryable || attempt >= DELAYS_MS.length) {
        toast(`Skill 上传登记失败（不影响上传结果）：${msg}`, 'info', 4000);
        return;
      }
      await new Promise((r) => setTimeout(r, DELAYS_MS[attempt]));
    }
  }
}

/* ---------- 上传计分观察器（手动发布也能登记） ----------
   自动化只有在「自己点了发布」时才拿得到 Published 终态；用户手动点发布时自动化只会拿到 Manual 超时，
   计分便漏掉。此观察器把「登记」从「谁点的按钮」解耦：上传开始时武装，周期轮询发布页真实 URL——
   SkillHub 是 SPA，发布成功后是 pushState 客户端路由跳转（不触发 on_page_load），所以必须主动读取
   `location.href`，不能依赖 browser:event 的 url 事件。落到技能列表页即视为发布成功，用采样到的
   namespace 登记。最长存活 10 分钟，命中或超时即解除。 */
const SKILLHUB_SKILLS_URL = 'https://skillhub.srun.com:6780/dashboard/skills';
/** 观察器最长存活（覆盖用户手动填写与确认的耗时） */
const UPLOAD_WATCH_MS = 10 * 60 * 1000;
/** 发布页状态轮询间隔（同时采样 URL 与 namespace） */
const UPLOAD_POLL_MS = 3000;

interface UploadWatch {
  slug: string;
  /** 最近采样到的 namespace（缺省 global；自动化固定 Global，手动可能选团队空间） */
  namespace: string;
  /** 已登记（自动成功或轮询命中），避免两条路径重复上报 */
  done: boolean;
  expires: number;
  polling: boolean;
  /** 是否已观察到「非技能列表页」的地址。上传开始时用户可能正停在技能列表页，
   *  首次轮询会立刻读到落地页——必须先看到发布页/其它页（即确实离开过），
   *  之后再次回到技能列表页才算发布成功，避免开局误判。 */
  sawNonLanding: boolean;
}

let uploadWatch: UploadWatch | null = null;

/** 目标 URL 是否为发布成功落地页（技能列表页；忽略 query/hash 与尾斜杠差异）。 */
function isSkillhubSkillsLanding(url: string): boolean {
  const u = url.split(/[?#]/)[0].replace(/\/+$/, '');
  return u === SKILLHUB_SKILLS_URL.replace(/\/+$/, '');
}

function disarmUploadWatch(): void {
  uploadWatch = null;
}

/** 命中发布成功：登记并解除观察器（done 置位防重复）。 */
function fireUploadRegistration(w: UploadWatch): void {
  if (w.done) return;
  w.done = true;
  const { slug, namespace } = w;
  disarmUploadWatch();
  void notifySkillUpload(slug, namespace);
}

/** 一次轮询：读发布页状态，更新 namespace 采样；若已落到技能列表页则登记。
 *  仅当此轮询前已观察到非落地页（确实离开过技能列表页）才认定发布成功。 */
async function pollUploadWatch(w: UploadWatch): Promise<void> {
  if (uploadWatch !== w || w.done) return;
  if (Date.now() > w.expires) { disarmUploadWatch(); return; }
  if (w.polling) return; // 上一轮未回，避免堆积
  w.polling = true;
  try {
    const st = await browserPublishState();
    if (uploadWatch !== w || w.done) return;
    if (st.namespace) w.namespace = st.namespace;
    if (!st.url) return; // 读不到地址（页面加载中/已关）：不改判定状态
    if (isSkillhubSkillsLanding(st.url)) {
      if (w.sawNonLanding) fireUploadRegistration(w);
    } else {
      w.sawNonLanding = true;
    }
  } catch {
    /* 页面已关/读取失败：保持观察，下一轮重试 */
  } finally {
    w.polling = false;
  }
}

/** 上传动作开始时武装观察器：清掉上一次，重置坐标采样并立即轮询一次。 */
function armUploadWatch(slug: string): void {
  disarmUploadWatch();
  const w: UploadWatch = {
    slug, namespace: 'global', done: false,
    expires: Date.now() + UPLOAD_WATCH_MS, polling: false, sawNonLanding: false,
  };
  uploadWatch = w;
  void pollUploadWatch(w);
  // 周期轮询由 setTimeout 自链（非 setInterval，避免上一轮未回时堆积）
  const tick = (): void => {
    if (uploadWatch !== w) return;
    void pollUploadWatch(w).then(() => {
      if (uploadWatch === w) setTimeout(tick, UPLOAD_POLL_MS);
    });
  };
  setTimeout(tick, UPLOAD_POLL_MS);
}

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
function SkillCard({ d, onToggle, onDelete, onUpload, onRegister, uploading, uploadBusy, incentiveEnabled }: {
  d: SkillSummary;
  onToggle(d: SkillSummary, next: boolean): Promise<boolean>;
  onDelete(d: SkillSummary): void;
  onUpload(d: SkillSummary): void;
  onRegister(d: SkillSummary): void;
  uploading: boolean;
  uploadBusy: boolean;
  incentiveEnabled: boolean;
}): JSX.Element {
  const [pending, setPending] = useState(false);
  /** 请求期间的显示值(原值;成功后随 d.enabled 同步) */
  const [display, setDisplay] = useState(d.enabled);
  useEffect(() => { setDisplay(d.enabled); }, [d.enabled]);

  const handleToggle = (next: boolean): void => {
    if (pending || uploading) return;
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
          <input type="checkbox" className="wbs-skills-toggle" checked={display} disabled={pending || uploading}
            onChange={(e) => handleToggle(e.currentTarget.checked)} />
          <span className="db-switch-track"></span>
        </label>
        <button className="icon-btn" title="上传到 Skill Hub" disabled={uploadBusy} onClick={() => onUpload(d)}>
          <Icon name={uploading ? 'loader' : 'upload'} />
        </button>
        {incentiveEnabled && (
          <button className="icon-btn" title="登记激励积分（上传到 Skill Hub 后手动补登记；服务端按作者核实）"
            onClick={() => onRegister(d)}>
            <Icon name="trophy" />
          </button>
        )}
        <button className="icon-btn" title="添加到 AI 对话" onClick={() => addSkillToChat(d)}><Icon name="chatPlus" /></button>
        <button className="icon-btn" title="编辑" disabled={uploading} onClick={() => openSkillModal(d)}><Icon name="gear" /></button>
        <button className="icon-btn danger" title="删除" disabled={uploading} onClick={() => void onDelete(d)}><Icon name="trash" /></button>
      </div>
    </div>
  );
}

/** 把技能引用加入 AI 输入框（@skill:名称 标签，发送时展开名/来源/scope/描述，AI 可循此读取技能文件）；
 *  AI 面板未挂载时提示。 */
function addSkillToChat(d: SkillSummary): void {
  if (wbHandles.ai?.addSkillRef) {
    wbHandles.ai.addSkillRef({ name: d.name, origin: d.origin, scope: d.scope, description: d.description });
  } else {
    toast('AI 面板尚未就绪');
  }
}

/* ---------- 面板主体 ---------- */
function SkillsPanelBody(): JSX.Element {
  const [items, setItems] = useState<SkillSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [uploadingSkillId, setUploadingSkillId] = useState<string | null>(null);
  const uploadingRef = useRef<string | null>(null);
  const aliveRef = useRef(true);
  /** 激励计划能力（上传成功后登记计分；未开通时不上报，不影响上传本身） */
  const incentiveEnabled = useIncentiveEnabled();

  useEffect(() => () => { aliveRef.current = false; }, []);

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

  /** 打包与可见浏览器导航并行；浏览器启动失败时保留 ZIP，让用户直接在当前页手动选择。 */
  const onUpload = (d: SkillSummary): void => {
    if (uploadingRef.current) return;
    uploadingRef.current = d.id;
    setUploadingSkillId(d.id);
    // 激励计分：上传动作开始即武装 URL 观察器，手动点发布也能在落地技能列表页时登记
    if (incentiveEnabled) armUploadWatch(d.name);
    const navigation = new Promise<void>((resolve, reject) => {
      useWorkbench.getState().openTab({ id: 'browser', type: 'browser', title: '浏览器' });
      void (async () => {
        await openInActivePage('https://skillhub.srun.com:6780/dashboard/publish');
      })().then(resolve, reject);
    });
    const packed = skillPackUpload(projectId(), d.origin, d.name);

    void Promise.allSettled([packed, navigation]).then(async ([packResult, navigationResult]) => {
      if (packResult.status === 'rejected') {
        if (aliveRef.current) toast(`Skill 打包失败：${String(packResult.reason)}`, 'error');
        if (incentiveEnabled) disarmUploadWatch();
        return;
      }
      const packagePath = packResult.value;
      if (navigationResult.status === 'rejected') {
        if (aliveRef.current) {
          toast(
            `打开 Skill Hub 失败：${String(navigationResult.reason)}。请在当前发布页手动选择刚才打包的技能包。`,
            'error',
            3000,
          );
        }
        return; // 保留观察器：用户可能仍能手动发布
      }
      try {
        const outcome = await browserPublishSkillhub(projectId(), d.origin, packagePath);
        if (!aliveRef.current) return;
        if (outcome.status === 'published') {
          toast(`Skill「${d.name}」已提交到 Skill Hub`, 'success');
          // 自动化自己点成功：立即登记（观察器若已因落地页命中则跳过，避免重复）
          if (incentiveEnabled && uploadWatch && !uploadWatch.done) {
            fireUploadRegistration(uploadWatch);
          }
        } else {
          // Manual：自动化未点成功，但用户多半会手动发布 → 保留观察器，等落地技能列表页再登记
          toast(outcome.message, 'info', 3000);
          if (!incentiveEnabled) disarmUploadWatch();
        }
      } catch (err) {
        if (aliveRef.current) toast(`自动上传失败：${String(err)}`, 'error');
        if (incentiveEnabled) disarmUploadWatch();
      }
    }).finally(() => {
      uploadingRef.current = null;
      if (aliveRef.current) setUploadingSkillId(null);
    });
  };

  /** 手动补登记激励积分：上传到 Skill Hub 后若自动登记未命中（如手动点发布），用户可点卡片奖杯图标登记。
   *  服务端按作者核实，重复登记幂等；slug 取技能名，namespace 取发布页当前选择（读不到按 global）。 */
  const onRegister = (d: SkillSummary): void => {
    void (async () => {
      let namespace = 'global';
      try {
        const st = await browserPublishState();
        if (st.namespace) namespace = st.namespace;
      } catch { /* 非发布页时读不到，按缺省 global 登记 */ }
      await notifySkillUpload(d.name, namespace);
    })();
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
                    <SkillCard
                      key={s.id}
                      d={s}
                      onToggle={onToggle}
                      onDelete={onDelete}
                      onUpload={onUpload}
                      onRegister={onRegister}
                      uploading={uploadingSkillId === s.id}
                      uploadBusy={uploadingSkillId !== null}
                      incentiveEnabled={incentiveEnabled}
                    />
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
        className="btn small brand-gradient wbs-skillhub-btn"
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
