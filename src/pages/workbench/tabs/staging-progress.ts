/**
 * 暂存/清理进度右下角弹窗（命令式单例，body 级挂载，不依赖 React；无 .proto 对照，全新功能）。
 * 数据源：staging.rs 的 add_path 递归暂存目录（逐文件）与 clear_unchanged 清理暂存（逐条目）
 * 经 `staging:progress` 事件发送（接口点 src/api.ts onStagingProgress）：
 * - walk 阶段 = 枚举目录文件（不确定进度条）；stage 阶段 = 逐文件暂存（done/total + 当前文件）；
 * - clear 阶段 = 逐条检查暂存条目（done/total + 当前条目）。
 * 生命周期：SftpTab 暂存含目录 / StagingTab 清理时 showStagingProgress() 预显示
 * （事件到达前的即时反馈），操作完成后 hideStagingProgress()；AI 路径（staging_add/staging_clear
 * 工具）不显式 show，事件自身会显示弹窗，由 ai-engine actionEnd 隐藏。
 */
import { onStagingProgress } from '../../../api';
import type { StagingProgress } from '../../../types';
import { icon } from '../../../icons';
import '../staging.css';

let root: HTMLDivElement | null = null;
let subscribed = false;

function ensureRoot(): HTMLDivElement {
  if (root && root.isConnected) return root;
  root = document.createElement('div');
  root.id = 'staging-progress';
  root.className = 'staging-progress';
  root.innerHTML = `
    <div class="staging-progress-head">
      <span class="sp-ic">${icon('history')}</span>
      <span class="sp-title">正在暂存目录</span>
    </div>
    <div class="sp-bar"><div class="sp-bar-fill"></div></div>
    <div class="sp-text"></div>`;
  document.body.appendChild(root);
  return root;
}

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  void onStagingProgress((p: StagingProgress) => {
    const el = ensureRoot();
    el.classList.add('visible');
    const title = el.querySelector<HTMLElement>('.sp-title');
    const bar = el.querySelector<HTMLElement>('.sp-bar');
    const fill = el.querySelector<HTMLElement>('.sp-bar-fill');
    const text = el.querySelector<HTMLElement>('.sp-text');
    if (!title || !bar || !fill || !text) return;
    if (p.phase === 'walk') {
      bar.classList.add('indeterminate');
      fill.style.width = '';
      title.textContent = '正在暂存目录';
      text.textContent = '正在枚举目录文件…';
      el.title = p.currentPath;
      return;
    }
    bar.classList.remove('indeterminate');
    const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
    fill.style.width = `${pct}%`;
    const name = p.currentPath.split('/').filter(Boolean).pop() || p.currentPath;
    if (p.phase === 'clear') {
      title.textContent = '正在清理暂存区';
      text.textContent = `已检查 ${p.done} / ${p.total} · ${name}`;
    } else {
      title.textContent = '正在暂存目录';
      text.textContent = `已暂存 ${p.done} / ${p.total} · ${name}`;
    }
    el.title = p.currentPath;
  });
}

/** 显示进度弹窗（操作开始前调用；title 为事件到达前的占位标题，并重置为初始状态）。 */
export function showStagingProgress(title?: string): void {
  ensureSubscribed();
  const el = ensureRoot();
  const t = el.querySelector<HTMLElement>('.sp-title');
  const bar = el.querySelector<HTMLElement>('.sp-bar');
  const fill = el.querySelector<HTMLElement>('.sp-bar-fill');
  const text = el.querySelector<HTMLElement>('.sp-text');
  if (t && title) t.textContent = title;
  if (bar) bar.classList.remove('indeterminate');
  if (fill) fill.style.width = '';
  if (text) text.textContent = '';
  el.classList.add('visible');
}

/** 隐藏进度弹窗（stagingAdd / stagingClear 完成、AI 动作结束后调用；未显示时无操作）。 */
export function hideStagingProgress(): void {
  if (!root) return;
  root.classList.remove('visible');
}
