/**
 * 用户反馈子页（React 版）—— 云账号四页导航的第四页（无旧实现对照，新增功能）。
 * 协议以 docs/AIShell云服务-用户反馈API文档.md 为准：
 * 分页列表（状态/分类过滤，按创建时间倒序）、提交反馈（multipart，附件经系统文件对话框选
 * 本地路径后由后端读取上传）、详情弹窗（附件下载经保存对话框选路径，后端下载落盘）。
 * 与后端的接口点（见 src/api.ts）：feedbackList / feedbackDetail / feedbackSubmit /
 * feedbackDownloadAttachment；token 全程留在 Rust 端，本页无任何 token 接触。
 * 状态由管理员后台流转，本页只读展示（不提供任何修改状态/删除反馈的入口）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { save } from '@tauri-apps/plugin-dialog';
import type {
  CloudStatus, Feedback, FeedbackAttachment, FeedbackCategory, FeedbackStatus,
} from '../../types';
import {
  feedbackDetail, feedbackDownloadAttachment, feedbackList, feedbackSubmit, openDialog,
} from '../../api';
import { toast } from '../../ui';
import { Icon } from '../../shared/Icon';
import { MaskModal } from './MaskModal';

/** 每页条数（服务端最大 100；列表页 10 条一页够用） */
const PAGE_SIZE = 10;
/** 附件上限（用户反馈 API 文档 §1.4；客户端预检数量/类型，大小由后端校验并返回中文错误） */
const MAX_ATTACHMENTS = 10;
/** 服务端安全扩展名白名单（§1.4；tar.gz 双后缀单独判定） */
const ALLOWED_EXTS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'heic',
  'pdf',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp',
  'txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml',
  'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz',
]);

const CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: '缺陷', suggestion: '建议', question: '问题', other: '其他',
};
const STATUS_LABELS: Record<FeedbackStatus, string> = {
  pending: '待处理', processing: '处理中', resolved: '已解决', closed: '已关闭',
};

/** RFC 3339 时间按文档「其中的时区偏移格式化展示」：截取到分钟（2026-08-21 10:30） */
function fmtTime(rfc3339: string): string {
  return rfc3339.replace('T', ' ').slice(0, 16);
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** 附件名扩展名预检（与后端 cloud.rs feedback_check_attachment_name 同口径） */
function extAllowed(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.tar.gz')) return true;
  const idx = lower.lastIndexOf('.');
  return idx > 0 && ALLOWED_EXTS.has(lower.slice(idx + 1));
}

/* ---------------- 提交反馈弹窗 ---------------- */

function FeedbackSubmitModal({ onClose, onSubmitted }: {
  onClose: () => void;
  onSubmitted: () => void;
}): JSX.Element {
  const [category, setCategory] = useState<FeedbackCategory>('bug');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  /** 已选附件（本地绝对路径；提交时由后端读取上传） */
  const [paths, setPaths] = useState<string[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const pickFiles = async (): Promise<void> => {
    const picked = await openDialog({ multiple: true, directory: false });
    if (!picked) return;
    const list = Array.isArray(picked) ? picked : [picked];
    const merged = [...paths];
    for (const p of list) {
      if (!merged.includes(p)) merged.push(p);
    }
    if (merged.length > MAX_ATTACHMENTS) {
      setErr(`附件最多 ${MAX_ATTACHMENTS} 个`);
      return;
    }
    const bad = merged.find((p) => !extAllowed(fileName(p)));
    if (bad) {
      setErr(`附件类型不允许：${fileName(bad)}（支持图片/PDF/Office/文本日志/压缩包）`);
      return;
    }
    setErr(null);
    setPaths(merged);
  };

  const submit = async (): Promise<void> => {
    const t = title.trim();
    const c = content.trim();
    if (!t) { setErr('反馈标题不能为空'); return; }
    if (t.length > 120) { setErr('反馈标题不能超过 120 字'); return; }
    if (!c) { setErr('反馈正文不能为空'); return; }
    if (c.length > 10000) { setErr('反馈正文不能超过 10000 字'); return; }
    setErr(null);
    setSubmitting(true);
    try {
      const fb = await feedbackSubmit(category, t, c, paths);
      toast(`反馈已提交（编号 #${fb.id}）`, 'success');
      onSubmitted();
      onClose();
    } catch (e) {
      setErr(String(e));
      setSubmitting(false);
    }
  };

  return (
    <MaskModal
      width={560}
      onClose={onClose}
      head={<h3>提交反馈</h3>}
      body={
        <>
          <div className="field">
            <label>分类<span className="req">*</span></label>
            <select id="fb-category" className="select" value={category}
                    onChange={(e) => setCategory(e.currentTarget.value as FeedbackCategory)}>
              {(Object.keys(CATEGORY_LABELS) as FeedbackCategory[]).map((c) => (
                <option value={c} key={c}>{CATEGORY_LABELS[c]}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>标题<span className="req">*</span></label>
            <input id="fb-title" className="input" type="text" spellCheck={false} value={title}
                   maxLength={120} placeholder="一句话概括问题或建议（不超过 120 字）"
                   onChange={(e) => setTitle(e.currentTarget.value)} />
          </div>
          <div className="field">
            <label>正文<span className="req">*</span></label>
            <textarea id="fb-content" className="input" rows={6} spellCheck={false} value={content}
                      placeholder="请描述现象、期望行为与复现步骤；请勿包含密码、密钥等敏感信息"
                      onChange={(e) => setContent(e.currentTarget.value)} />
          </div>
          <div className="field">
            <label>附件（可选）</label>
            <div className="fb-attach-row">
              <button className="btn small" onClick={() => void pickFiles()} disabled={submitting}>
                <Icon name="plus" /> 选择文件
              </button>
              <span className="hint">最多 {MAX_ATTACHMENTS} 个，单个 ≤ 20 MB，合计 ≤ 100 MB；支持图片/PDF/Office/文本日志/压缩包</span>
            </div>
            {paths.length > 0 ? (
              <div className="fb-attach-list">
                {paths.map((p) => (
                  <div className="fb-attach-item" key={p} title={p}>
                    <Icon name="file" /><span className="fb-attach-name">{fileName(p)}</span>
                    <button className="icon-btn" title="移除" aria-label="移除"
                            onClick={() => setPaths(paths.filter((x) => x !== p))}>
                      <Icon name="x" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          <div id="fb-form-err" className="form-error" hidden={!err}>{err}</div>
        </>
      }
      foot={
        <>
          <button className="btn small" onClick={onClose} disabled={submitting}>取消</button>
          <button className="btn primary small" onClick={() => void submit()} disabled={submitting}>
            {submitting ? '提交中…' : '提交'}
          </button>
        </>
      }
    />
  );
}

/* ---------------- 反馈详情弹窗 ---------------- */

function FeedbackDetailModal({ id, onClose }: {
  id: number;
  onClose: () => void;
}): JSX.Element {
  const [fb, setFb] = useState<Feedback | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** 正在下载的附件 id（按钮防重复点击） */
  const [downloading, setDownloading] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    feedbackDetail(id)
      .then((f) => { if (!cancelled) setFb(f); })
      .catch((e) => { if (!cancelled) setErr(String(e)); });
    return () => { cancelled = true; };
  }, [id]);

  const download = async (att: FeedbackAttachment): Promise<void> => {
    const path = await save({ defaultPath: att.filename });
    if (!path) return;
    setDownloading(att.id);
    try {
      await feedbackDownloadAttachment(id, att.id, path);
      toast(`附件已保存：${att.filename}`, 'success');
    } catch (e) {
      toast(`下载附件失败: ${String(e)}`, 'error');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <MaskModal
      width={560}
      onClose={onClose}
      head={<h3>{fb ? `反馈 #${fb.id}：${fb.title}` : '反馈详情'}</h3>}
      body={
        err ? (
          <div className="cloud-empty"><div className="err-text">加载反馈详情失败：{err}</div></div>
        ) : !fb ? (
          <div className="loading-row"><Icon name="loader" /> 加载反馈详情…</div>
        ) : (
          <>
            <div className="fb-detail-meta">
              <span className="mem-cat">{CATEGORY_LABELS[fb.category] ?? fb.category}</span>
              <span className={`fb-status fb-status-${fb.status}`}>
                {STATUS_LABELS[fb.status] ?? fb.status}
              </span>
              <span className="fb-detail-time" title="创建时间">{fmtTime(fb.createdAt)}</span>
              {fb.updatedAt !== fb.createdAt ? (
                <span className="fb-detail-time" title="最近更新（管理员处理后会变化）">
                  更新于 {fmtTime(fb.updatedAt)}
                </span>
              ) : null}
            </div>
            <div className="mem-content fb-detail-content">{fb.content}</div>
            {fb.attachments.length > 0 ? (
              <div className="fb-detail-attachments">
                <div className="fb-detail-sub">附件（{fb.attachments.length}）</div>
                {fb.attachments.map((a) => (
                  <div className="fb-attach-item" key={a.id} title={a.filename}>
                    <Icon name="file" />
                    <span className="fb-attach-name">{a.filename}</span>
                    <span className="fb-attach-size">{fmtSize(a.sizeBytes)}</span>
                    <button className="icon-btn" title="下载附件" aria-label="下载附件"
                            disabled={downloading === a.id}
                            onClick={() => void download(a)}>
                      <Icon name="download" />
                    </button>
                  </div>
                ))}
              </div>
            ) : null}
            <div className="hint fb-detail-hint">
              状态由管理员在后台处理更新；补充附件请重新提交一条反馈并注明关联编号 #{fb.id}
            </div>
          </>
        )
      }
      foot={<button className="btn small" onClick={onClose}>关闭</button>}
    />
  );
}

/* ---------------- 列表主视图 ---------------- */

const STATUS_TABS: Array<{ value: FeedbackStatus | ''; label: string }> = [
  { value: '', label: '全部' },
  { value: 'pending', label: '待处理' },
  { value: 'processing', label: '处理中' },
  { value: 'resolved', label: '已解决' },
  { value: 'closed', label: '已关闭' },
];

interface FeedbackViewProps {
  status: CloudStatus | null;
  onGoLogin: () => void;
}

export function FeedbackView({ status, onGoLogin }: FeedbackViewProps): JSX.Element {
  const [items, setItems] = useState<Feedback[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState<FeedbackStatus | ''>('');
  const [categoryFilter, setCategoryFilter] = useState<FeedbackCategory | ''>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSubmit, setShowSubmit] = useState(false);
  /** 详情弹窗目标反馈 id（null = 关闭） */
  const [detailId, setDetailId] = useState<number | null>(null);

  /** 异步竞态序号（同 MemoriesView：过滤/翻页触发后丢弃迟到响应） */
  const seqRef = useRef(0);

  const load = useCallback(async (p: number, st: FeedbackStatus | '', cat: FeedbackCategory | ''): Promise<void> => {
    if (!status?.serverUrl || !status.loggedIn) return;
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    try {
      const data = await feedbackList(p, PAGE_SIZE, st, cat);
      if (seq !== seqRef.current) return;
      setItems(data.items);
      setTotal(data.total);
      setPage(data.page);
      setLoading(false);
    } catch (e) {
      if (seq !== seqRef.current) return;
      setError(String(e));
      setLoading(false);
    }
  }, [status?.serverUrl, status?.loggedIn]);

  // 挂载 + 过滤切换：回到第一页重载
  useEffect(() => { void load(1, statusFilter, categoryFilter); }, [load, statusFilter, categoryFilter]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // 守卫：未接入云服务
  if (!status?.serverUrl) {
    return <div className="cloud-empty"><div>当前构建未接入云服务，该功能不可用。</div></div>;
  }
  // 守卫：未登录
  if (!status.loggedIn) {
    return (
      <div className="cloud-empty">
        <div>登录公司账号后即可提交和查看反馈。</div>
        <button className="btn primary small" onClick={onGoLogin}>去登录</button>
      </div>
    );
  }

  return (
    <>
      <div className="account-toolbar" id="feedback-toolbar">
        <div className="mem-scope-tabs fb-status-tabs">
          {STATUS_TABS.map((t) => (
            <button key={t.value} className={`mem-scope-tab${statusFilter === t.value ? ' active' : ''}`}
                    onClick={() => setStatusFilter(t.value)}>{t.label}</button>
          ))}
        </div>
        <select className="select" value={categoryFilter} title="按分类过滤"
                onChange={(e) => setCategoryFilter(e.currentTarget.value as FeedbackCategory | '')}>
          <option value="">全部分类</option>
          {(Object.keys(CATEGORY_LABELS) as FeedbackCategory[]).map((c) => (
            <option value={c} key={c}>{CATEGORY_LABELS[c]}</option>
          ))}
        </select>
        <button className="icon-btn" title="刷新" aria-label="刷新"
                onClick={() => void load(page, statusFilter, categoryFilter)}>
          <Icon name="refresh" />
        </button>
        <span className="fb-toolbar-gap" />
        <button className="btn primary small" onClick={() => setShowSubmit(true)}>
          <Icon name="plus" /> 提交反馈
        </button>
      </div>
      <div id="feedback-content">
        {loading ? (
          <div className="loading-row"><Icon name="loader" /> 加载反馈列表…</div>
        ) : error ? (
          <div className="cloud-empty">
            <div className="err-text">加载反馈列表失败:{error}</div>
            <button className="btn small" onClick={() => void load(page, statusFilter, categoryFilter)}>重试</button>
          </div>
        ) : items.length === 0 ? (
          <div className="cloud-empty">
            {statusFilter || categoryFilter ? '没有符合条件的反馈' : '暂无反馈，点击「提交反馈」告诉我们你遇到的问题或建议'}
          </div>
        ) : (
          <>
            <div className="mem-list">
              {items.map((f) => (
                <div className="mem-card fb-card" key={f.id} data-id={f.id}
                     onClick={() => setDetailId(f.id)}>
                  <div className="mem-card-head">
                    <span className="mem-cat">{CATEGORY_LABELS[f.category] ?? f.category}</span>
                    <span className={`fb-status fb-status-${f.status}`}>
                      {STATUS_LABELS[f.status] ?? f.status}
                    </span>
                    <span className="mem-time" title="创建时间">{fmtTime(f.createdAt)}</span>
                  </div>
                  <div className="fb-card-title">#{f.id} {f.title}</div>
                  <div className="mem-card-foot">
                    {f.attachmentCount > 0 ? (
                      <span className="fb-card-attach"><Icon name="file" /> {f.attachmentCount} 个附件</span>
                    ) : <span />}
                    <span className="mem-actions"><Icon name="chevronRight" /></span>
                  </div>
                </div>
              ))}
            </div>
            {totalPages > 1 ? (
              <div className="fb-pager">
                <button className="btn small" disabled={page <= 1}
                        onClick={() => void load(page - 1, statusFilter, categoryFilter)}>上一页</button>
                <span className="fb-pager-info">{page} / {totalPages} 页（共 {total} 条）</span>
                <button className="btn small" disabled={page >= totalPages}
                        onClick={() => void load(page + 1, statusFilter, categoryFilter)}>下一页</button>
              </div>
            ) : null}
          </>
        )}
      </div>
      {showSubmit ? (
        <FeedbackSubmitModal
          onClose={() => setShowSubmit(false)}
          onSubmitted={() => void load(1, statusFilter, categoryFilter)}
        />
      ) : null}
      {detailId !== null ? <FeedbackDetailModal id={detailId} onClose={() => setDetailId(null)} /> : null}
    </>
  );
}
