/**
 * 工作台底边栏进度区（命令式单例，挂载到 #workbench-statusbar 的 #workbench-progress 容器）。
 * 无 .proto 对照，全新功能；取代旧右下角弹窗 staging-progress.ts。
 *
 * 数据源：
 * - `sftp:progress`（src/api.ts onSftpProgress）：sftp_upload / sftp_download 命令的传输进度。
 *   bytes = 当前文件字节进度（totalBytes > 10MB 时显示确定进度条，小文件快速传输不打扰）；
 *   files = 一个文件已完成（显示已处理文件数）；done = 命令结束（隐藏对应任务）。
 * - `staging:progress`（src/api.ts onStagingProgress）：递归暂存目录 / 清理暂存区 / 导出备份的进度。
 *   walk = 枚举阶段（不确定条）；stage/clear/export = 逐文件/逐条目占比；done = 操作完成（隐藏）。
 * - `cloud-backup:progress`（src/api.ts onCloudBackupProgress）：云端备份长任务进度；只为云备份
 *   任务显示取消按钮，Rust 后台任务的生命周期不随工作台导航终止。
 *
 * 多任务并存（上传 + 暂存 + 云备份）按 key 分槽：SFTP 任务用 taskId，暂存任务用 project:session，
 * 云备份任务用 cloud-backup:taskId。
 * 显式控制（showProgress / hideProgress）用于暂存/清理操作开始前的占位与异常收尾；done 事件
 * 到达会自动移除任务槽，无需调用方重复隐藏。
 */
import { cloudBackupCancel, onCloudBackupProgress, onSftpProgress, onStagingProgress } from '../../api';
import type { CloudBackupProgress, SftpProgress, StagingProgress } from '../../types';
import { icon } from '../../icons';

interface Task {
  key: string;
  title: string;
  /** 确定进度（0-100）或 null = 不确定（数据不足时显示滚动条） */
  pct: number | null;
  detail: string;
  /** 仅云备份任务可取消；SFTP/staging 不设置此字段，保持原交互不变 */
  cancel?: () => void;
}

const tasks = new Map<string, Task>();
let subscribed = false;

function rootEl(): HTMLElement | null {
  const el = document.getElementById('workbench-progress');
  return el && el.isConnected ? el : null;
}

function render(): void {
  const el = rootEl();
  if (!el) return;
  el.innerHTML = '';
  for (const t of tasks.values()) {
    const bar = document.createElement('div');
    bar.className = 'wb-progress-task';
    if (t.pct == null) bar.classList.add('indeterminate');
    bar.title = t.detail;
    const fill = document.createElement('div');
    fill.className = 'wb-progress-fill';
    if (t.pct != null) fill.style.width = `${t.pct}%`;
    const label = document.createElement('span');
    label.className = 'wb-progress-label';
    label.textContent = `${t.title}${t.pct != null ? ` ${t.pct}%` : ''}`;
    const detail = document.createElement('span');
    detail.className = 'wb-progress-detail';
    detail.textContent = t.detail;
    bar.append(fill, label, detail);
    if (t.cancel) {
      const cancel = document.createElement('button');
      cancel.className = 'icon-btn wb-progress-cancel';
      cancel.title = '取消云备份';
      cancel.setAttribute('aria-label', '取消云备份');
      cancel.innerHTML = icon('x');
      cancel.addEventListener('click', (event) => { event.stopPropagation(); t.cancel?.(); });
      bar.appendChild(cancel);
    }
    el.appendChild(bar);
  }
}

/** 字节数人类可读格式（B/KB/MB/GB） */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function upsert(key: string, title: string, pct: number | null, detail: string, cancel?: () => void): void {
  const prev = tasks.get(key);
  tasks.set(key, { key, title, pct, detail, cancel });
  if (prev || rootEl()) render();
}

function finish(key: string): void {
  if (tasks.delete(key)) render();
}

/** 底边栏进度注册（幂等；工作台挂载后 #workbench-progress 容器出现，事件到达即显示） */
function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  void onSftpProgress((p: SftpProgress) => {
    if (p.phase === 'done') {
      finish(p.taskId);
      return;
    }
    const dir = p.direction === 'upload' ? '上传' : '下载';
    const name = p.current.split('/').filter(Boolean).pop() || p.current;
    if (p.phase === 'bytes') {
      // 仅大文件（≥10MB）显示确定进度条；小文件静默（files 事件已保证任务槽存在）
      if (p.totalBytes >= 10 * 1024 * 1024) {
        const pct = p.totalBytes ? Math.min(100, Math.round((p.doneBytes / p.totalBytes) * 100)) : 0;
        upsert(p.taskId, `${dir} ${name}`, pct, formatBytes(p.doneBytes) + ' / ' + formatBytes(p.totalBytes));
      }
    } else {
      // files：任务槽先占位（无大文件时也显示「已处理 N 个文件」窗口）。
      // 若大文件正在传输（上一事件为 bytes 且未到 100%），保留其标题与百分比不被覆盖。
      const prev = tasks.get(p.taskId);
      const streaming = prev && prev.pct != null && prev.pct < 100;
      upsert(
        p.taskId,
        streaming ? prev.title : `${dir}中`,
        streaming ? prev.pct : null,
        `已处理 ${p.filesDone} 个文件 · ${name}`,
      );
    }
  });
  void onStagingProgress((p: StagingProgress) => {
    const key = `staging:${p.projectId}:${p.sessionId}`;
    if (p.phase === 'done') {
      finish(key);
      return;
    }
    const name = p.currentPath.split('/').filter(Boolean).pop() || p.currentPath;
    if (p.phase === 'walk') {
      upsert(key, '正在暂存目录', null, '正在枚举目录文件…');
      return;
    }
    const title = p.phase === 'clear' ? '正在清理暂存区' : p.phase === 'export' ? '正在导出备份' : '正在暂存目录';
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    const verb = p.phase === 'clear' ? '已检查' : p.phase === 'export' ? '已导出' : '已暂存';
    upsert(key, title, pct, `${verb} ${p.done} / ${p.total} · ${name}`);
  });
  void onCloudBackupProgress((p: CloudBackupProgress) => {
    const key = `cloud-backup:${p.taskId}`;
    if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') {
      finish(key);
      return;
    }
    const pct = p.totalBytes > 0 ? Math.min(100, Math.round((p.doneBytes / p.totalBytes) * 100))
      : p.filesTotal > 0 ? Math.min(100, Math.round((p.filesDone / p.filesTotal) * 100)) : null;
    const phase = p.phase === 'scan' ? '扫描中' : p.phase === 'encrypt' ? '加密中' : p.phase === 'finalize' ? '收尾中' : '上传中';
    const detail = p.currentPath ? `${p.currentPath} · ${formatBytes(p.doneBytes)} / ${formatBytes(p.totalBytes)}` : `已处理 ${p.filesDone} / ${p.filesTotal} 个文件`;
    upsert(key, `云备份${phase}`, pct, detail, p.cancellable ? () => {
      void cloudBackupCancel(p.taskId).catch(() => {});
    } : undefined);
  });
}

/** 显示一个手动任务槽（操作开始前占位；key 缺省为 'manual'）。
 *  用于暂存/清理等调用方想提前给用户即时反馈的场景；done 事件会覆盖并移除。 */
export function showProgress(title: string, key = 'manual', detail = ''): void {
  ensureSubscribed();
  upsert(key, title, null, detail);
}

/** 移除一个手动任务槽（操作失败/完成时兜底；未显示时无操作） */
export function hideProgress(key = 'manual'): void {
  finish(key);
}

/** 工作台挂载完成时补渲染（事件在容器出现前到达时任务已入队列，需刷新展示）；
 *  同时确保事件订阅已建立——SFTP 传输为纯事件驱动，若惰性只在 showProgress 时注册，
 *  用户直接上传/下载将收不到进度（曾因此不显示）。 */
export function refreshProgress(): void {
  ensureSubscribed();
  render();
}