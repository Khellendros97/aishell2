/**
 * Debug 日志总线与底部面板：收集终端事件流——后端 term.rs diag() 广播的 `debug:log`
 * 事件（SSH 通道收发元信息）+ 前端 dbg() 打点（终端会话生命周期 / 输入输出 / 重连）。
 * 环形缓冲 3000 行，应用启动即开始收集（面板未开也有历史）。
 * 打开方式：命令面板（Ctrl+T / Ctrl+P）输入 `debug`。
 * 接口点：后端 `debug:log` 事件（payload {line}）、`debug_export` 命令；
 * 样式 styles/design.css `#dbg-panel`。
 */
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { copyText, toast } from './ui';
import { icon } from './icons';

/** 环形缓冲上限：终端事件流密度约每通道消息 2 行，3000 行≈一次复现操作的完整窗口 */
const MAX_LINES = 3000;
const lines: string[] = [];

let panelEl: HTMLElement | null = null;
let bodyEl: HTMLElement | null = null;
let titleEl: HTMLElement | null = null;
let pauseBtn: HTMLButtonElement | null = null;
let paused = false;
let pendingWhilePaused = 0;

/* ---------- 收集 ---------- */

/** 前端打点入口（terminal.ts 等调用）：与后端行统一 epoch-millis 前缀，`fe` 标记前端来源 */
export function dbg(msg: string): void {
  push(`${Date.now()} fe ${msg}`);
}

/** main.ts 启动时调用一次：订阅后端 debug:log（term.rs diag 行） */
export async function initDebug(): Promise<void> {
  await listen<{ line: string }>('debug:log', (e) => push(e.payload.line));
}

function push(line: string): void {
  lines.push(line);
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
  if (paused) {
    pendingWhilePaused++;
    updatePauseBtn();
    return;
  }
  appendLine(line);
  updateTitle();
}

/** 行分类着色：fe=前端打点（accent），err/失败/exit=异常关注（red） */
function lineClass(line: string): string {
  if (/err|失败|failed|exit/i.test(line)) return 'dbg-line dbg-warn';
  if (line.includes(' fe ')) return 'dbg-line dbg-fe';
  return 'dbg-line';
}

function appendLine(line: string): void {
  if (!bodyEl || panelEl!.classList.contains('hidden')) return;
  // 超上限同步裁 DOM 头（缓冲已在 push 内裁过）
  while (bodyEl.childElementCount >= MAX_LINES) bodyEl.firstElementChild?.remove();
  const nearBottom = bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 30;
  const div = document.createElement('div');
  div.className = lineClass(line);
  div.textContent = line;
  bodyEl.appendChild(div);
  if (nearBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
}

function updateTitle(): void {
  if (titleEl) titleEl.textContent = `Debug 日志 · ${lines.length} 行`;
}

function updatePauseBtn(): void {
  if (!pauseBtn) return;
  pauseBtn.innerHTML = paused
    ? `${icon('play')} 继续${pendingWhilePaused ? ` (+${pendingWhilePaused})` : ''}`
    : `${icon('pause')} 暂停`;
}

/* ---------- 面板 ---------- */

function ensurePanel(): void {
  if (panelEl) return;
  panelEl = document.createElement('div');
  panelEl.id = 'dbg-panel';
  panelEl.className = 'hidden';
  panelEl.innerHTML = `
    <div class="dbg-toolbar">
      <span class="dbg-title">Debug 日志</span>
      <span class="dbg-hint">终端事件流（fe=前端打点，其余=后端通道）</span>
      <span class="dbg-spacer"></span>
      <button class="btn small ghost dbg-pause"></button>
      <button class="btn small ghost dbg-clear">${icon('trash')} 清空</button>
      <button class="btn small ghost dbg-copy">${icon('copy')} 复制</button>
      <button class="btn small ghost dbg-export">${icon('download')} 导出</button>
      <button class="icon-btn dbg-close" title="关闭">${icon('x')}</button>
    </div>
    <div class="dbg-body"></div>
  `;
  document.body.appendChild(panelEl);
  bodyEl = panelEl.querySelector('.dbg-body');
  titleEl = panelEl.querySelector('.dbg-title');
  pauseBtn = panelEl.querySelector('.dbg-pause');

  pauseBtn!.addEventListener('click', () => {
    paused = !paused;
    if (!paused) {
      // 恢复：补渲暂停期积压的行（取缓冲尾部 pendingWhilePaused 行）
      pendingWhilePaused = 0;
      renderAll();
    }
    updatePauseBtn();
  });
  panelEl.querySelector('.dbg-clear')!.addEventListener('click', () => {
    lines.length = 0;
    if (bodyEl) bodyEl.textContent = '';
    pendingWhilePaused = 0;
    updateTitle();
    updatePauseBtn();
  });
  panelEl.querySelector('.dbg-copy')!.addEventListener('click', () => {
    if (!lines.length) { toast('暂无日志', 'info'); return; }
    void copyText(lines.join('\n')).then(() => toast(`已复制 ${lines.length} 行`, 'success'));
  });
  panelEl.querySelector('.dbg-export')!.addEventListener('click', () => void exportLog());
  panelEl.querySelector('.dbg-close')!.addEventListener('click', () => toggleDebugPanel());
  updatePauseBtn();
  updateTitle();
}

function renderAll(): void {
  if (!bodyEl) return;
  bodyEl.textContent = '';
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const div = document.createElement('div');
    div.className = lineClass(line);
    div.textContent = line;
    frag.appendChild(div);
  }
  bodyEl.appendChild(frag);
  bodyEl.scrollTop = bodyEl.scrollHeight;
}

/** 命令面板 `debug` 调用：开关底部日志面板 */
export function toggleDebugPanel(): void {
  ensurePanel();
  const nowHidden = panelEl!.classList.toggle('hidden');
  if (!nowHidden) {
    paused = false;
    pendingWhilePaused = 0;
    updatePauseBtn();
    renderAll();
  }
}

async function exportLog(): Promise<void> {
  if (!lines.length) { toast('暂无日志', 'info'); return; }
  const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const path = await save({
    defaultPath: `aishell-debug-${ts}.log`,
    filters: [{ name: '日志文件', extensions: ['log', 'txt'] }],
  });
  if (!path) return;
  try {
    await invoke('debug_export', { path, content: lines.join('\n') });
    toast(`已导出 ${lines.length} 行: ${path}`, 'success');
  } catch (err) {
    toast(String(err), 'error');
  }
}
