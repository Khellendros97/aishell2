/**
 * Skill Hub 技能市场工作区标签页：工作区结构对照 .proto/workbench.html；
 * 内容对照云端 SkillHub API 约定，由 Rust skillhub_* 命令代理列表、明细、
 * 版本正文与 ZIP 安装；安装后通知 Skill 管理面板刷新，下载目标由用户明确选择
 * 全局或当前项目。
 */
import { useCallback, useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import type {
  CloudStatus,
  SkillHubDetail,
  SkillHubItem,
  SkillHubVersionDetail,
  SkillOrigin,
} from '../../../types';
import {
  cloudStatus,
  skillHubDetail,
  skillHubDownload,
  skillHubList,
  skillHubVersionDetail,
} from '../../../api';
import { useWorkbench, wbEvents, type TabProps } from '../../../stores/workbench';
import { navigate } from '../../../router';
import { toast } from '../../../ui';
import { Icon } from '../../../shared/Icon';
import './skill-hub.css';

const PAGE_SIZE = 24;

type DownloadTarget = {
  item: SkillHubItem;
  version: string;
};

function formatDate(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(epochMs));
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (value >= 10000) return `${(value / 10000).toFixed(1)}万`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatSize(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '大小未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function cloudStatusText(status: CloudStatus | null): string {
  if (!status) return '正在检查云账号…';
  if (status.loggedIn) return `已连接${status.user?.name ? ` · ${status.user.name}` : ''}`;
  if (!status.serverUrl) return '当前构建未接入云服务';
  return '需要登录企业云账号';
}

function DetailModal({
  item,
  onClose,
  onDownload,
}: {
  item: SkillHubItem;
  onClose(): void;
  onDownload(version: string): void;
}): JSX.Element {
  const [detail, setDetail] = useState<SkillHubDetail | null>(null);
  const [version, setVersion] = useState<SkillHubVersionDetail | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const itemKey = `${item.namespace}/${item.slug}`;

  useEffect(() => {
    let alive = true;
    setDetail(null);
    setVersion(null);
    setError('');
    setLoading(true);
    void (async () => {
      try {
        const nextDetail = await skillHubDetail(item.namespace, item.slug);
        if (!alive) return;
        setDetail(nextDetail);
        const publishedVersion = (nextDetail.skill.publishedVersion?.version
          ?? nextDetail.skill.headlineVersion?.version
          ?? item.latestVersion)
          || null;
        if (publishedVersion) {
          try {
            const nextVersion = await skillHubVersionDetail(item.namespace, item.slug, publishedVersion);
            if (alive) setVersion(nextVersion);
          } catch (err) {
            if (alive) setError(`版本正文读取失败：${String(err)}`);
          }
        }
      } catch (err) {
        if (alive) setError(String(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [itemKey, item.namespace, item.slug, item.latestVersion]);

  const skill = detail?.skill;
  const publishedVersion = (skill?.publishedVersion?.version
    ?? skill?.headlineVersion?.version
    ?? item.latestVersion)
    || null;
  const metadata = version?.version.metadata;
  const metadataText = metadata && typeof metadata === 'object' && Object.keys(metadata).length > 0
    ? JSON.stringify(metadata, null, 2)
    : '';

  return (
    <div className="modal-mask open skillhub-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal skillhub-detail-modal">
        <div className="modal-head skillhub-modal-head">
          <div>
            <div className="skillhub-modal-kicker">SKILL DETAILS</div>
            <h3>{item.displayName || item.slug}</h3>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="modal-body skillhub-detail-body">
          {loading ? (
            <div className="skillhub-loading"><span className="skillhub-spinner"></span>正在读取 SkillHub 明细…</div>
          ) : error && !skill ? (
            <div className="skillhub-error-block"><Icon name="alert" /><span>{error}</span></div>
          ) : (
            <>
              {error ? <div className="skillhub-inline-error">{error}</div> : null}
              <div className="skillhub-detail-summary">
                <div className="skillhub-detail-main">
                  <div className="skillhub-detail-slug mono">{item.namespace}/{item.slug}</div>
                  <p>{skill?.summary || item.summary || '暂无简介'}</p>
                  <div className="skillhub-detail-tags">
                    {(skill?.labels ?? []).map((label) => <span className="tag purple" key={label}>{label}</span>)}
                    <span className="tag blue">{skill?.visibility || 'PUBLIC'}</span>
                    <span className="tag green">{skill?.status || 'ACTIVE'}</span>
                  </div>
                </div>
                <div className="skillhub-detail-stats">
                  <div><strong>{formatCount(skill?.downloadCount ?? item.downloads)}</strong><span>下载</span></div>
                  <div><strong>{formatCount(skill?.starCount ?? item.stars)}</strong><span>收藏</span></div>
                  <div><strong>{skill?.ratingAvg ? skill.ratingAvg.toFixed(1) : '—'}</strong><span>评分</span></div>
                </div>
              </div>
              <div className="skillhub-detail-meta">
                <span>作者：{skill?.ownerDisplayName || '未知'}</span>
                <span>版本：{publishedVersion || '暂无可下载版本'}</span>
                <span>包大小：{formatSize(version?.version.totalSize ?? 0)}</span>
                <span>更新时间：{formatDate(item.updatedAt)}</span>
              </div>
              {metadataText ? (
                <section className="skillhub-doc-section">
                  <div className="skillhub-section-label">元数据</div>
                  <pre className="skillhub-code-block">{metadataText}</pre>
                </section>
              ) : null}
              <section className="skillhub-doc-section">
                <div className="skillhub-section-label">SKILL.md</div>
                <pre className="skillhub-markdown-block">{version?.version.body || '暂无版本正文'}</pre>
              </section>
            </>
          )}
        </div>
        <div className="modal-foot skillhub-modal-foot">
          <button className="btn" onClick={onClose}>关闭</button>
          <button className="btn skillhub-gradient-btn" disabled={!publishedVersion || loading} onClick={() => { if (publishedVersion) onDownload(publishedVersion); }}>
            <Icon name="download" /> 下载此 Skill
          </button>
        </div>
      </div>
    </div>
  );
}

function DownloadModal({
  target,
  onClose,
}: {
  target: DownloadTarget;
  onClose(): void;
}): JSX.Element {
  const project = useWorkbench((state) => state.project);
  const [origin, setOrigin] = useState<SkillOrigin>(project ? 'project' : 'global');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (): Promise<void> => {
    if (origin === 'project' && !project) {
      setError('当前没有可用项目，不能安装到项目 Skill');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await skillHubDownload(
        project?.id ?? '',
        origin,
        target.item.namespace,
        target.item.slug,
        target.version,
      );
      wbEvents.emit('project-changed');
      toast(`Skill「${target.item.displayName || target.item.slug}」已安装到${origin === 'global' ? '全局' : '项目'}`, 'success');
      onClose();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-mask open skillhub-modal-mask" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal skillhub-download-modal">
        <div className="modal-head skillhub-modal-head">
          <div>
            <div className="skillhub-modal-kicker">INSTALL SKILL</div>
            <h3>下载到哪里？</h3>
          </div>
          <button className="icon-btn" title="关闭" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="modal-body">
          <div className="skillhub-install-package">
            <Icon name="package" />
            <div><strong>{target.item.displayName || target.item.slug}</strong><span>{target.item.namespace}/{target.item.slug} · {target.version || '最新已发布版本'}</span></div>
          </div>
          <div className="skillhub-scope-options">
            <label className={`skillhub-scope-option${origin === 'global' ? ' selected' : ''}`}>
              <input type="radio" name="skillhub-origin" value="global" checked={origin === 'global'} onChange={() => setOrigin('global')} />
              <span className="skillhub-scope-icon"><Icon name="globe" /></span>
              <span><strong>全局 Skill</strong><small>当前工作区下的 .aishell/skills，所有项目可复用</small></span>
            </label>
            <label className={`skillhub-scope-option${origin === 'project' ? ' selected' : ''}${project ? '' : ' disabled'}`}>
              <input type="radio" name="skillhub-origin" value="project" checked={origin === 'project'} disabled={!project} onChange={() => setOrigin('project')} />
              <span className="skillhub-scope-icon"><Icon name="folderOpen" /></span>
              <span><strong>项目 Skill</strong><small>{project ? `${project.name} · 仅当前项目使用` : '当前没有打开的项目'}</small></span>
            </label>
          </div>
          {error ? <div className="skillhub-inline-error">{error}</div> : null}
        </div>
        <div className="modal-foot skillhub-modal-foot">
          <button className="btn" disabled={saving} onClick={onClose}>取消</button>
          <button className="btn skillhub-gradient-btn" disabled={saving} onClick={() => void submit()}>
            {saving ? <><span className="skillhub-spinner small"></span>安装中…</> : <><Icon name="download" />确认下载</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export function SkillHubTab({ tab }: TabProps): JSX.Element {
  const tabId = tab.id;
  const [items, setItems] = useState<SkillHubItem[]>([]);
  const [query, setQuery] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [cloud, setCloud] = useState<CloudStatus | null>(null);
  const [detailItem, setDetailItem] = useState<SkillHubItem | null>(null);
  const [downloadTarget, setDownloadTarget] = useState<DownloadTarget | null>(null);

  const loadPage = useCallback(async (keyword: string, cursor: string | null, replace: boolean): Promise<void> => {
    if (replace) setLoading(true);
    else setLoadingMore(true);
    setError('');
    try {
      const result = await skillHubList(keyword, cursor, PAGE_SIZE);
      setItems((current) => replace ? result.items : [...current, ...result.items]);
      setNextCursor(result.nextCursor || null);
    } catch (err) {
      setError(String(err));
    } finally {
      if (replace) setLoading(false);
      else setLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    void loadPage('', null, true);
    let alive = true;
    void cloudStatus().then((status) => { if (alive) setCloud(status); }).catch(() => {});
    return () => { alive = false; };
  }, [tabId, loadPage]);

  const submitSearch = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void loadPage(query.trim(), null, true);
  };

  const status = cloudStatusText(cloud);
  const canLogin = cloud?.serverUrl != null && !cloud.loggedIn;

  return (
    <div className="skillhub-root">
      <div className="skillhub-shell">
        <section className="skillhub-hero">
          <div className="skillhub-hero-glow"></div>
          <div className="skillhub-hero-content">
            <div className="skillhub-kicker"><span className="skillhub-kicker-dot"></span> AISHELL CLOUD / SKILLHUB</div>
            <div className="skillhub-title-row">
              <span className="skillhub-mark"><Icon name="package" /></span>
              <div><h1>Skill Hub</h1><p>发现团队共享的 AI 技能，把经过审核的工作流带回你的项目。</p></div>
            </div>
            <div className="skillhub-status-row">
              <span className={`skillhub-status${cloud?.loggedIn ? ' connected' : ''}`}><span></span>{status}</span>
              {canLogin ? <button className="skillhub-login-link" onClick={() => navigate('#/account')}>去账号页登录 <Icon name="externalLink" /></button> : null}
            </div>
          </div>
        </section>

        <form className="skillhub-toolbar" onSubmit={submitSearch}>
          <div className="skillhub-search-wrap">
            <Icon name="search" />
            <input className="input skillhub-search" value={query} onChange={(event) => setQuery(event.currentTarget.value)} placeholder="搜索技能名称、描述或关键词…" />
            {query ? <button type="button" className="icon-btn skillhub-clear" title="清空搜索" onClick={() => { setQuery(''); void loadPage('', null, true); }}><Icon name="x" /></button> : null}
          </div>
          <button type="submit" className="btn skillhub-search-btn" disabled={loading}><Icon name="search" />搜索</button>
          <span className="skillhub-result-hint">{items.length ? `已展示 ${items.length} 个技能` : '企业技能目录'}</span>
        </form>

        {error && !items.length ? (
          <div className="skillhub-state skillhub-error-state"><Icon name="alert" /><strong>Skill Hub 暂时不可用</strong><span>{error}</span><button className="btn small" onClick={() => void loadPage(query.trim(), null, true)}>重试</button></div>
        ) : loading ? (
          <div className="skillhub-state"><span className="skillhub-spinner"></span><span>正在加载技能目录…</span></div>
        ) : items.length === 0 ? (
          <div className="skillhub-state"><Icon name="package" /><strong>还没有找到技能</strong><span>换个关键词试试，或等待团队发布新的 Skill。</span></div>
        ) : (
          <div className="skillhub-grid">
            {items.map((item, index) => {
              const tagEntries = item.tags && typeof item.tags === 'object' ? Object.entries(item.tags).slice(0, 3) : [];
              const latestVersion = item.latestVersion?.trim() || '';
              return (
                <article className="skillhub-card" key={`${item.namespace}/${item.slug}`} style={{ '--skillhub-index': index } as CSSProperties}>
                  <div className="skillhub-card-topline"><span className="skillhub-namespace mono">{item.namespace}</span><span className="skillhub-version">v{item.latestVersion || '—'}</span></div>
                  <h2 title={item.displayName || item.slug}>{item.displayName || item.slug}</h2>
                  <p>{item.summary || '暂无简介'}</p>
                  <div className="skillhub-card-tags">
                    {tagEntries.map(([key, value]) => <span className="tag" key={key}>{key}{typeof value === 'string' ? `: ${value}` : ''}</span>)}
                  </div>
                  <div className="skillhub-card-meta"><span><Icon name="download" />{formatCount(item.downloads)}</span><span><Icon name="star" />{formatCount(item.stars)}</span><span>{formatDate(item.updatedAt)}</span></div>
                  <div className="skillhub-card-actions">
                    <button className="btn skillhub-detail-btn" onClick={() => setDetailItem(item)}>查看详情 <Icon name="arrowRight" /></button>
                    <button
                      className="btn skillhub-card-download"
                      disabled={!latestVersion}
                      title={latestVersion ? `下载 ${latestVersion}` : '暂无可下载版本'}
                      onClick={() => { if (latestVersion) setDownloadTarget({ item, version: latestVersion }); }}
                    >
                      <Icon name="download" />下载
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}

        {nextCursor ? <div className="skillhub-load-more"><button className="btn" disabled={loadingMore} onClick={() => void loadPage(query.trim(), nextCursor, false)}>{loadingMore ? '加载中…' : '加载更多技能'}</button></div> : null}
      </div>
      {detailItem ? <DetailModal item={detailItem} onClose={() => setDetailItem(null)} onDownload={(version) => { setDetailItem(null); setDownloadTarget({ item: detailItem, version }); }} /> : null}
      {downloadTarget ? <DownloadModal target={downloadTarget} onClose={() => setDownloadTarget(null)} /> : null}
    </div>
  );
}

export default SkillHubTab;
