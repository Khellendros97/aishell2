/**
 * AI 助手面板 —— 照 .proto/workbench-ai.js 移植全部交互，mock 回复换成 pi 子进程流式事件
 * （ai:event:<key> 订阅，见 src/api.ts）。挂载时设置 Workbench.ai = { addSnapshot }，容器被移除时置 null
 * 并 aiKillProject 清理该项目的 pi 进程。
 */
import type { UnlistenFn } from '@tauri-apps/api/event';
import type { AppState, ChatMsg, ChatSession, LlmConfig, Project, TermSnapshot } from '../../types';
import { icon } from '../../icons';
import {
  aiAbort, aiChat, aiKillProject, aiSetThinking, getState, onAiEvent, saveSettings,
  sessionUpsert, sessionsGet,
  type AiEvent,
} from '../../api';
import { Workbench, getActiveTerminalApi } from './core';
import { addQuickCommandModal } from './quickcommand';
import { toast, uid } from '../../ui';

/* ---------- 面板样式（原型 workbench-ai.js 注入的样式 + 错误气泡红边） ---------- */
const STYLE = `
#ai-session-bar {
  height: 40px; flex: none; display: flex; align-items: center; gap: 6px;
  padding: 0 8px; border-bottom: 1px solid var(--border);
}
#ai-session-bar .select { flex: 1; height: 26px; font-size: 12px; padding: 0 28px 0 8px; }
/* 思考强度快捷入口（输入区上方一行） */
#ai-effort-bar {
  display: flex; align-items: center; gap: 6px;
  padding: 6px 10px 0; font-size: 11px; color: var(--text-2);
}
#ai-effort-bar .ai-effort-label { display: inline-flex; align-items: center; gap: 4px; }
#ai-effort-bar .select {
  height: 22px; width: 78px; font-size: 11px; padding: 0 20px 0 6px;
  color: var(--text-0);
}
#ai-chat {
  flex: 1; overflow-y: auto; padding: 12px 10px;
  display: flex; flex-direction: column; gap: 10px;
}
.ai-msg { display: flex; }
.ai-msg.user { justify-content: flex-end; }
.ai-bubble {
  max-width: 88%; padding: 8px 11px; border-radius: 10px;
  font-size: 12.5px; line-height: 1.6; word-break: break-word; min-width: 0;
}
.ai-msg.user .ai-bubble { background: var(--accent-dim); border-bottom-right-radius: 3px; }
.ai-msg.ai .ai-bubble { background: var(--bg-2); border-bottom-left-radius: 3px; }
.ai-msg.ai .ai-bubble.error { border: 1px solid var(--red); }
.ai-text { white-space: pre-wrap; }
.ai-para { margin: 0 0 6px; }
.ai-para:last-child { margin-bottom: 0; }
.ai-code-inline {
  background: var(--inline-code-bg); border: 1px solid var(--border); border-radius: 3px;
  padding: 0 4px; font-family: var(--font-mono); font-size: 11.5px; color: var(--yellow);
}
.ai-code-block {
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; margin: 6px 0; overflow-x: auto; position: relative;
}
.ai-code-block code { font-family: var(--font-mono); font-size: 12px; color: var(--text-0); white-space: pre; }
.ai-code-lang { position: absolute; top: 5px; right: 8px; font-size: 10px; color: var(--text-2); }
.ai-suggest {
  display: flex; flex-direction: column; gap: 6px; margin: 6px 0;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.ai-suggest:hover { border-color: var(--border-strong); background: var(--bg-3); }
.ai-suggest.cmd { border-left: 3px solid var(--green); }
.ai-suggest.text { border-left: 3px solid var(--accent); }
.ai-suggest-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.ai-suggest-head .ai-suggest-icon { font-size: 14px; }
.ai-suggest-actions { display: flex; align-items: center; gap: 6px; }
.ai-suggest-actions .icon-btn { width: 24px; height: 24px; font-size: 13px; }
/* 工具活动行（流式气泡内，瞬时展示） */
.ai-tool-line {
  display: flex; align-items: center; gap: 5px;
  font-size: 11px; color: var(--text-2); margin-bottom: 3px;
  font-family: var(--font-mono); word-break: break-all;
}
.ai-tool-line svg { flex: none; }
.ai-suggest-main {
  font-size: 12px;
  white-space: pre-wrap; word-break: break-all;
}
.ai-suggest.cmd .ai-suggest-main { font-family: var(--font-mono); color: var(--green); }
#ai-input-area {
  flex: none; border-top: 1px solid var(--border);
  padding: 8px; display: flex; flex-direction: column; gap: 6px;
}
#ai-chip-row { display: flex; flex-wrap: wrap; gap: 4px; }
#ai-input-row { display: flex; gap: 6px; align-items: flex-end; }
#ai-input {
  flex: 1; resize: none; height: 34px; max-height: 120px; overflow-y: auto;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px;
  color: var(--text-0); padding: 7px 10px; outline: none;
  font-family: var(--font-ui); font-size: 12.5px; line-height: 1.5;
}
#ai-input:focus { border-color: var(--accent); }
#ai-input::placeholder { color: var(--text-2); }
#ai-send { flex: none; height: 34px; padding: 0 14px; }
.ai-snap-chip { cursor: pointer; user-select: none; }
.ai-snap-chip .ai-chip-x { margin-left: 5px; opacity: 0.7; cursor: pointer; }
.ai-snap-chip .ai-chip-x:hover { opacity: 1; }
.ai-msg-chips { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 6px; }
.ai-typing { display: inline-flex; align-items: center; gap: 4px; }
.ai-typing .ai-typing-label { font-size: 11px; color: var(--text-2); margin-right: 2px; white-space: nowrap; }
.ai-typing .ai-typing-dot {
  width: 5px; height: 5px; border-radius: 50%; background: var(--text-2);
  animation: ai-blink 1.2s infinite;
}
.ai-typing .ai-typing-dot:nth-child(3) { animation-delay: 0.2s; }
.ai-typing .ai-typing-dot:nth-child(4) { animation-delay: 0.4s; }
@keyframes ai-blink {
  0%, 60%, 100% { opacity: 0.25; transform: translateY(0); }
  30% { opacity: 1; transform: translateY(-2px); }
}
.ai-snap-command {
  background: var(--inline-code-bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 7px 10px; margin-bottom: 10px; font-size: 12px; color: var(--green);
}
.ai-snap-pre {
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 12px; overflow: auto; max-height: 60vh;
  font-family: var(--font-mono); font-size: 12px; line-height: 1.6; color: var(--text-0);
  white-space: pre-wrap; word-break: break-all;
}
`;

/* ---------- 状态 ---------- */
/** 生成中/错误气泡的瞬时状态（不进 ChatSession.messages，不落盘）；tools 为工具活动行（同上） */
interface Pending {
  phase: 'typing' | 'stream' | 'error';
  text: string;
  error?: string;
  tools: string[];
}

let project: Project | null = null;
const sessions = new Map<string, ChatSession>(); // id -> ChatSession（含历史）
const pendingBy = new Map<string, Pending | null>(); // 会话 id -> 瞬时气泡状态
const snapshots = new Map<string, TermSnapshot>(); // 快照 id -> 全文（输入区 chip + 历史消息 chip 共用）
let activeSessionId = '';
let unlisten: UnlistenFn | null = null;
let observer: MutationObserver | null = null;
let unmounted = false;

let chat: HTMLElement;
let sessionSelect: HTMLSelectElement;
let newSessionBtn: HTMLButtonElement;
let input: HTMLTextAreaElement;
let sendBtn: HTMLButtonElement;
let chipRow: HTMLElement;
let effortSelect: HTMLSelectElement;
/** 思考强度切换防抖：快速连续切换只允许一个保存流程 */
let effortSaving = false;

/* ---------- 面板挂载 / 卸载 ---------- */
export function mountAiPanel(container: HTMLElement): void {
  project = Workbench.state.project;
  unmounted = false;

  const style = document.createElement('style');
  style.textContent = STYLE;
  document.head.appendChild(style);

  container.innerHTML = `
    <div id="ai-session-bar">
      <select id="ai-session-select" class="select" title="切换会话"></select>
      <button id="ai-new-session" class="icon-btn" title="新建会话">${icon('plus')}</button>
    </div>
    <div id="ai-chat"></div>
    <div id="ai-input-area">
      <div id="ai-effort-bar">
        <span class="ai-effort-label">${icon('zap')} 思考强度</span>
        <select id="ai-effort-select" class="select" title="思考强度（立即生效）">
          <option value="low">low</option>
          <option value="high">high</option>
          <option value="max">max</option>
        </select>
      </div>
      <div id="ai-chip-row"></div>
      <div id="ai-input-row">
        <textarea id="ai-input" placeholder="向 AI 提问，Enter 发送，Shift+Enter 换行"></textarea>
        <button id="ai-send" class="btn primary" title="发送 (Enter)">发送</button>
      </div>
    </div>`;

  const el = (id: string) => container.querySelector<HTMLElement>(`#ai-${id}`)!;
  chat = el('chat');
  sessionSelect = el('session-select') as HTMLSelectElement;
  newSessionBtn = el('new-session') as HTMLButtonElement;
  input = el('input') as HTMLTextAreaElement;
  sendBtn = el('send') as HTMLButtonElement;
  chipRow = el('chip-row');
  effortSelect = el('effort-select') as HTMLSelectElement;

  /* 容器被移除（工作台页面卸载）→ 取消订阅、置空 Workbench.ai、杀掉本项目 pi 进程 */
  observer = new MutationObserver(() => {
    if (!container.isConnected) cleanup();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  Workbench.ai = aiHandle;

  bindEvents();
  void loadSessions();
  void loadEffort();
}

function cleanup(): void {
  if (unmounted) return;
  unmounted = true;
  if (unlisten) { unlisten(); unlisten = null; }
  if (observer) { observer.disconnect(); observer = null; }
  if (Workbench.ai === aiHandle) Workbench.ai = null;
  if (project) void aiKillProject(project.id).catch(() => { /* 进程清理失败可忽略 */ });
}

/* ---------- Workbench.ai 句柄（终端模块添加快照） ---------- */
const aiHandle = {
  addSnapshot(snap: TermSnapshot): void {
    if (!snap || !snap.id) return;
    snapshots.set(snap.id, snap);
    addChip(snap);
  },
};

/* ---------- 会话管理 ---------- */
function newSession(): ChatSession {
  const s: ChatSession = { id: uid('sess'), title: '新会话', messages: [] };
  sessions.set(s.id, s);
  return s;
}

function currentKey(): string {
  return project && activeSessionId ? `${project.id}:${activeSessionId}` : '';
}

async function loadSessions(): Promise<void> {
  if (!project) {
    toast('项目未加载', 'error');
    return;
  }
  try {
    const list = await sessionsGet(project.id);
    for (const s of list) sessions.set(s.id, s);
    // Rust 按插入序返回（旧→新，session_upsert 原地更新不换位）：默认选最新的会话
    if (list.length > 0) activeSessionId = list[list.length - 1].id;
  } catch (err) {
    toast(`会话加载失败：${String(err)}`, 'error');
  }
  if (!activeSessionId || !sessions.has(activeSessionId)) {
    activeSessionId = newSession().id;
  }
  await subscribe(currentKey());
  renderSessionBar();
  renderHistory();
  updateSendBtn();
}

async function subscribe(key: string): Promise<void> {
  if (unlisten) { unlisten(); unlisten = null; }
  if (!key) return;
  try {
    unlisten = await onAiEvent(key, (ev) => handleEvent(key, ev));
  } catch (err) {
    console.error('AI 事件订阅失败:', err);
  }
}

/** 读取当前思考强度回显到快捷入口（后端 settings 为事实源） */
async function loadEffort(): Promise<void> {
  try {
    const st = await getState();
    effortSelect.value = st.settings.llm.effort || 'low';
  } catch {
    /* 读取失败保持默认 low */
  }
}

/** 快捷切换思考强度：先落盘配置，再动态下发到存活 pi 进程（set_thinking_level，不打断生成、不丢上下文） */
async function switchEffort(level: LlmConfig['effort']): Promise<void> {
  if (effortSaving || !project) return;
  effortSaving = true;
  let st: AppState | null = null;
  try {
    st = await getState();
    st.settings.llm.effort = level;
    await saveSettings(st.settings, null, null);
    await aiSetThinking(project.id, level);
    toast(`思考强度已切换为 ${level}`, 'success');
  } catch (err) {
    effortSelect.value = st?.settings.llm.effort ?? 'low';
    toast(`切换思考强度失败: ${String(err)}`, 'error');
  } finally {
    effortSaving = false;
  }
}

function handleEvent(key: string, ev: AiEvent): void {
  const sid = key.slice(key.indexOf(':') + 1);
  if (ev.type === 'delta') {
    const cur = pendingBy.get(sid) ?? null;
    const p = cur ?? { phase: 'stream' as const, text: '', tools: [] };
    p.phase = 'stream';
    p.text += ev.text;
    pendingBy.set(sid, p);
  } else if (ev.type === 'tool') {
    /* 工具活动行：瞬时展示，不进历史；相邻重复行折叠为 ×N */
    const cur = pendingBy.get(sid) ?? null;
    const p = cur ?? { phase: 'typing' as const, text: '', tools: [] };
    const label = ev.label ? `${ev.tool} ${ev.label}` : ev.tool;
    const last = p.tools[p.tools.length - 1];
    const m = last?.match(/^(.*) ×(\d+)$/);
    if (last === label) {
      p.tools[p.tools.length - 1] = `${label} ×2`;
    } else if (m && m[1] === label) {
      p.tools[p.tools.length - 1] = `${label} ×${Number(m[2]) + 1}`;
    } else {
      p.tools.push(label);
    }
    pendingBy.set(sid, p);
  } else if (ev.type === 'segment') {
    /* 新一轮 assistant 消息分段（工具来回时），仅流式中有文本才分段 */
    const cur = pendingBy.get(sid) ?? null;
    if (cur && cur.phase === 'stream' && cur.text) {
      cur.text += '\n\n';
      pendingBy.set(sid, cur);
    }
  } else if (ev.type === 'done') {
    finalize(sid);
  } else {
    pendingBy.set(sid, { phase: 'error', text: '', error: ev.message, tools: [] });
  }
  if (sid === activeSessionId) {
    renderHistory();
    updateSendBtn();
  }
}

/** done：把流式文本定稿为 assistant 消息并落盘（错误气泡不进历史）；零增量 done 给占位文案 */
function finalize(sid: string): void {
  const s = sessions.get(sid);
  const p = pendingBy.get(sid) ?? null;
  pendingBy.set(sid, null);
  if (!s || !p || p.phase !== 'stream') return;
  const text = p.text.trim() ? p.text : '（AI 未返回内容，请重试或检查模型配置）';
  s.messages.push({ role: 'assistant', content: text, snapshots: [], ts: Date.now() });
  persistSession(s);
}

/** 离开一个正在生成的会话：中止后端并把手头文本定稿（切走后就收不到 done 事件了） */
function leaveSession(sid: string): void {
  const p = pendingBy.get(sid) ?? null;
  pendingBy.set(sid, null);
  if (p && p.phase === 'stream' && p.text) {
    const s = sessions.get(sid);
    if (s) {
      s.messages.push({ role: 'assistant', content: p.text, snapshots: [], ts: Date.now() });
      persistSession(s);
    }
  }
  if (project) void aiAbort(`${project.id}:${sid}`).catch(() => { /* 后端无进程时静默 */ });
}

function persistSession(s: ChatSession): void {
  if (!project) return;
  void sessionUpsert(project.id, s).catch((err) => toast(`会话保存失败：${String(err)}`, 'error'));
}

function renderSessionBar(): void {
  sessionSelect.innerHTML = '';
  sessions.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title;
    opt.selected = s.id === activeSessionId;
    sessionSelect.appendChild(opt);
  });
}

/* ---------- 聊天渲染 ---------- */
function scrollBottom(): void {
  chat.scrollTop = chat.scrollHeight;
}

function renderHistory(): void {
  chat.innerHTML = '';
  const s = sessions.get(activeSessionId);
  if (s) s.messages.forEach((m) => chat.appendChild(renderMessage(m)));
  const pend = pendingBy.get(activeSessionId) ?? null;
  if (pend) chat.appendChild(renderPending(pend));
  scrollBottom();
}

function renderMessage(m: ChatMsg): HTMLElement {
  const wrap = document.createElement('div');
  if (m.role === 'user') {
    wrap.className = 'ai-msg user';
    // 历史消息的快照全文也进 map，chip 点击可查看
    m.snapshots.forEach((snap) => snapshots.set(snap.id, snap));
    const chips = m.snapshots.map((snap) =>
      `<span class="tag blue ai-msg-chip" data-snap-id="${escapeHtml(snap.id)}" title="点击查看快照全文">@terminal_${escapeHtml(snap.id)}</span>`,
    ).join('');
    wrap.innerHTML =
      `<div class="ai-bubble">${chips ? `<div class="ai-msg-chips">${chips}</div>` : ''}` +
      `<div class="ai-text">${escapeHtml(m.content)}</div></div>`;
  } else {
    wrap.className = 'ai-msg ai';
    wrap.innerHTML = `<div class="ai-bubble">${renderAI(m.content)}</div>`;
  }
  return wrap;
}

function renderPending(p: Pending): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg ai';
  const toolLines = p.tools.map((t) => `<div class="ai-tool-line">${icon('wrench')}${escapeHtml(t)}</div>`).join('');
  if (p.phase === 'typing' || (p.phase === 'stream' && !p.text)) {
    wrap.innerHTML =
      `<div class="ai-bubble">${toolLines}` +
      '<span class="ai-typing"><span class="ai-typing-label">正在输入</span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span></span></div>';
  } else if (p.phase === 'error') {
    wrap.innerHTML = `<div class="ai-bubble error"><div class="ai-text">${escapeHtml(p.error ?? '')}</div></div>`;
  } else {
    wrap.innerHTML = `<div class="ai-bubble">${toolLines}${renderAI(p.text)}</div>`;
  }
  return wrap;
}

/* ---------- 极简 markdown：先转义 HTML，再解析 ---------- */
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inline(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/`([^`]+)`/g, '<code class="ai-code-inline">$1</code>');
  return out;
}

/* fenced 块：```command → 命令卡；```text → 文本卡；其余 → 代码块 */
function renderAI(text: string): string {
  const parts: Array<{ kind: string; lang: string; body: string }> = [];
  const re = /```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ kind: 'para', lang: '', body: text.slice(last, m.index) });
    const lang = (m[1] || '').trim();
    const body = m[2].replace(/\r?\n$/, '');
    parts.push({ kind: lang === 'command' ? 'command' : lang === 'text' ? 'text' : 'code', lang, body });
    last = re.lastIndex;
  }
  if (last < text.length) parts.push({ kind: 'para', lang: '', body: text.slice(last) });
  return parts.map(renderPart).join('');
}

function renderPart(p: { kind: string; lang: string; body: string }): string {
  switch (p.kind) {
    case 'command':
      return `<div class="ai-suggest cmd" data-action="paste" data-cmd="${escapeHtml(p.body)}" title="点击卡片粘贴到终端">
        <div class="ai-suggest-head"><span class="ai-suggest-icon">${icon('terminal')}</span>
        <span class="ai-suggest-actions">
          <button class="icon-btn ai-qc-fav" type="button" title="收藏为快捷指令">${icon('pin')}</button>
          <button class="btn small" type="button">粘贴到终端</button>
        </span></div>
        <code class="ai-suggest-main">${escapeHtml(p.body)}</code>
      </div>`;
    case 'text':
      return `<div class="ai-suggest text" data-action="copy" data-text="${escapeHtml(p.body)}" title="点击卡片复制到剪贴板">
        <div class="ai-suggest-head"><span class="ai-suggest-icon">${icon('message')}</span>
        <button class="btn small" type="button">复制到剪贴板</button></div>
        <span class="ai-suggest-main">${escapeHtml(p.body)}</span>
      </div>`;
    case 'code':
      return `<pre class="ai-code-block">${p.lang ? `<span class="ai-code-lang">${escapeHtml(p.lang)}</span>` : ''}<code>${escapeHtml(p.body)}</code></pre>`;
    default:
      return p.body
        .split(/\n{2,}/)
        .map((para) => para.trim())
        .filter(Boolean)
        .map((para) => `<p class="ai-para">${inline(para).replace(/\n/g, '<br>')}</p>`)
        .join('');
  }
}

/* ---------- 建议卡片 / 快照 chip 点击（事件委托） ---------- */
function onChatClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  /* 收藏按钮在命令卡片内部，优先于卡片的 paste 动作 */
  const fav = target.closest('.ai-qc-fav') as HTMLElement | null;
  if (fav) {
    const card = fav.closest('[data-cmd]') as HTMLElement | null;
    if (card) addQuickCommandModal(card.dataset.cmd ?? '');
    return;
  }
  const card = target.closest('[data-action]') as HTMLElement | null;
  if (card) {
    if (card.dataset.action === 'paste') {
      const api = getActiveTerminalApi();
      if (api) {
        api.paste(card.dataset.cmd ?? '');
        toast('已粘贴到终端', 'success');
      } else {
        toast('没有可用的终端标签页', 'error');
      }
    } else if (card.dataset.action === 'copy') {
      void navigator.clipboard.writeText(card.dataset.text ?? '').then(
        () => toast('已复制到剪贴板', 'success'),
        () => toast('复制到剪贴板失败', 'error'),
      );
    }
    return;
  }
  const chip = target.closest('[data-snap-id]') as HTMLElement | null;
  if (chip) openSnapModal(snapshots.get(chip.dataset.snapId ?? ''));
}

/* ---------- 终端快照 chip（输入区） ---------- */
function addChip(snap: TermSnapshot): void {
  const c = document.createElement('span');
  c.className = 'tag blue ai-snap-chip';
  c.dataset.id = snap.id;
  c.title = '点击查看快照全文，✕ 移除';
  c.innerHTML = `@terminal_${escapeHtml(snap.id)}<span class="ai-chip-x" title="移除">${icon('x')}</span>`;
  chipRow.appendChild(c);
}

const clearChips = (): void => {
  chipRow.innerHTML = '';
};

function onChipRowClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const chip = target.closest('.ai-snap-chip') as HTMLElement | null;
  if (!chip) return;
  if (target.closest('.ai-chip-x')) {
    chip.remove();
    return;
  }
  openSnapModal(snapshots.get(chip.dataset.id ?? ''));
}

function openSnapModal(snap: TermSnapshot | undefined): void {
  if (!snap) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal-head"><h3>终端快照 · @terminal_${escapeHtml(snap.id)}</h3><button class="icon-btn ai-modal-x" title="关闭">${icon('x')}</button></div>
      <div class="modal-body">
        <div class="ai-snap-command mono">$ ${escapeHtml(snap.command)}</div>
        <pre class="ai-snap-pre">${escapeHtml(snap.content || '')}</pre>
      </div>
    </div>`;
  document.body.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('open'));
  const close = (): void => {
    mask.classList.remove('open');
    setTimeout(() => mask.remove(), 160);
  };
  (mask.querySelector('.ai-modal-x') as HTMLButtonElement).onclick = close;
  mask.addEventListener('mousedown', (e) => {
    if (e.target === mask) close();
  });
}

/* ---------- 输入区 ---------- */
function autoGrow(): void {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  input.style.overflowY = input.scrollHeight > 120 ? 'auto' : 'hidden';
}

function updateSendBtn(): void {
  sendBtn.textContent = isGenerating(activeSessionId) ? '停止' : '发送';
}

/** 是否正在生成（错误气泡不算生成中，允许继续发新消息） */
function isGenerating(sid: string): boolean {
  const p = pendingBy.get(sid) ?? null;
  return !!p && p.phase !== 'error';
}

/* ---------- 发送与流式接收 ---------- */
function send(): void {
  if (!project) {
    toast('项目未加载', 'error');
    return;
  }
  const sid = activeSessionId;
  const s = sessions.get(sid);
  if (!s) return;
  // 生成中 → 停止
  if (isGenerating(sid)) {
    void aiAbort(`${project.id}:${sid}`).catch(() => { /* 后端无进程时静默 */ });
    return;
  }
  const text = input.value.trim();
  const chipIds = Array.from(chipRow.children).map((c) => (c as HTMLElement).dataset.id ?? '');
  const snaps = chipIds.map((id) => snapshots.get(id)).filter((x): x is TermSnapshot => Boolean(x));
  if (!text && snaps.length === 0) return;

  // 首条用户消息决定会话标题
  if (s.messages.length === 0) s.title = text.slice(0, 20) || '终端快照';

  s.messages.push({ role: 'user', content: text, snapshots: snaps, ts: Date.now() });
  input.value = '';
  autoGrow();
  clearChips();
  pendingBy.set(sid, { phase: 'typing', text: '', tools: [] });
  renderSessionBar();
  renderHistory();
  updateSendBtn();
  persistSession(s);

  // 提交给 ai_chat 的 prompt = 用户文本 + 每个快照追加（UI 气泡只显示 chip）
  const prompt = text + snaps
    .map((sn) => `\n\n[终端快照 命令: ${sn.command}]\n${sn.content.slice(0, 4000)}`)
    .join('');
  aiChat(`${project.id}:${sid}`, prompt).catch((err: unknown) => {
    // 提交失败（pi 运行时缺失 / 未配置 API Key 等）：错误气泡红边
    pendingBy.set(sid, { phase: 'error', text: '', error: String(err), tools: [] });
    if (sid === activeSessionId) {
      renderHistory();
      updateSendBtn();
    }
  });
}

/* ---------- 事件绑定 ---------- */
function bindEvents(): void {
  sessionSelect.onchange = () => {
    leaveSession(activeSessionId);
    activeSessionId = sessionSelect.value;
    void subscribe(currentKey());
    renderHistory();
    updateSendBtn();
  };
  newSessionBtn.onclick = () => {
    leaveSession(activeSessionId);
    activeSessionId = newSession().id;
    renderSessionBar();
    renderHistory();
    updateSendBtn();
    void subscribe(currentKey());
  };
  chat.addEventListener('click', onChatClick);
  chipRow.addEventListener('click', onChipRowClick);
  input.addEventListener('input', autoGrow);
  input.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  sendBtn.onclick = send;
  effortSelect.onchange = () => {
    void switchEffort(effortSelect.value as LlmConfig['effort']);
  };
}
