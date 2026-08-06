/**
 * AI 助手面板 —— 照 .proto/workbench-ai.js 移植全部交互，mock 回复换成 pi 子进程流式事件
 * （ai:event:<key> 订阅，见 src/api.ts）。挂载时设置 Workbench.ai = { addSnapshot }，容器被移除时置 null
 * 并 aiKillProject 清理该项目的 pi 进程。
 */
import type { UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import MarkdownIt from 'markdown-it';
import type { AiActionRecord, AiMode, AppState, ChatMsg, ChatSession, FileRef, LlmConfig, Project, TermSnapshot } from '../../types';
import { icon } from '../../icons';
import {
  aiAbort, aiChat, aiDebugInfo, aiKillProject, aiRespondApproval, aiSetThinking, getState, onAiEvent, saveSettings,
  sessionUpsert, sessionsGet, setAiMode,
  type AiEvent,
} from '../../api';
import { Workbench, getActiveTerminalApi } from './core';
import { addQuickCommandModal } from './quickcommand';
import { confirmDialog, toast, uid } from '../../ui';

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
#ai-effort-bar .ai-mode-label { display: inline-flex; align-items: center; gap: 4px; }
#ai-mode-select { width: 74px; }
/* 动作卡（Agent 审批卡 / YOLO 自动执行卡 / 历史只读审计卡） */
.ai-action-card {
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 8px;
  padding: 8px 10px; margin: 6px 0; display: flex; flex-direction: column; gap: 5px;
}
.ai-action-card .ai-action-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  font-size: 11.5px;
}
.ai-action-card .ai-action-name { font-weight: 600; display: inline-flex; align-items: center; gap: 4px; }
.ai-action-card .ai-action-name svg { flex: none; }
.ai-action-card .ai-action-intent { font-size: 12px; color: var(--text-1); word-break: break-all; }
.ai-action-card .ai-action-cmd {
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 6px 8px; font-family: var(--font-mono); font-size: 11.5px; color: var(--green);
  white-space: pre-wrap; word-break: break-all;
}
.ai-action-card .ai-action-actions { display: flex; gap: 6px; }
.ai-action-card .ai-action-status { font-size: 11px; color: var(--text-2); display: inline-flex; align-items: center; gap: 4px; }
.ai-action-card .ai-action-result {
  font-size: 11px; color: var(--text-2); max-height: 90px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-all;
}
.ai-action-card.succeeded { border-left: 3px solid var(--green); }
.ai-action-card.failed { border-left: 3px solid var(--red); }
.ai-action-card.rejected { border-left: 3px solid var(--yellow); opacity: 0.75; }
/* 历史只读动作卡：默认折叠，点击头部展开/收起 */
.ai-action-card[data-collapsible] { cursor: pointer; }
.ai-action-card[data-collapsible] .ai-action-head { user-select: none; }
.ai-action-card .ai-action-detail { display: flex; flex-direction: column; gap: 5px; }
.ai-action-card.collapsed .ai-action-detail { display: none; }
.ai-action-toggle {
  display: inline-flex; align-items: center; margin-left: 4px;
  color: var(--text-2); vertical-align: -2px;
}
.ai-action-toggle svg { width: 12px; height: 12px; }
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
.ai-text { white-space: normal; overflow-wrap: anywhere; }
/* Markdown 渲染元素（md 输出嵌在 .ai-text 内） */
.ai-text h1, .ai-text h2, .ai-text h3, .ai-text h4 {
  font-weight: 600; margin: 10px 0 6px; line-height: 1.4;
}
.ai-text h1 { font-size: 16px; }
.ai-text h2 { font-size: 14.5px; }
.ai-text h3 { font-size: 13.5px; }
.ai-text h4 { font-size: 13px; }
.ai-text p { margin: 0 0 6px; }
.ai-text p:last-child, .ai-text ul:last-child, .ai-text ol:last-child, .ai-text blockquote:last-child { margin-bottom: 0; }
/* 列表标记放入气泡内容区，避免 marker 溢出边界；嵌套列表保留层级缩进。 */
.ai-text ul, .ai-text ol { margin: 0 0 6px; padding-left: 0; list-style-position: inside; }
.ai-text li { margin: 2px 0; padding-left: 0; }
.ai-text li > ul, .ai-text li > ol { margin-top: 2px; margin-bottom: 0; padding-left: 1.25em; }
.ai-text blockquote {
  border-left: 3px solid var(--border-strong); margin: 6px 0; padding: 2px 10px;
  color: var(--text-1);
}
.ai-text hr { border: none; border-top: 1px solid var(--border); margin: 10px 0; }
.ai-text a { color: var(--link); text-decoration: underline; text-decoration-thickness: 1px; text-underline-offset: 2px; }
.ai-text :not(pre) > code { background: var(--inline-code-bg); border: 1px solid var(--border); border-radius: 3px; padding: 0 4px; font-family: var(--font-mono); font-size: 11.5px; color: var(--yellow); }
.ai-text table { border-collapse: collapse; margin: 6px 0; }
.ai-text th, .ai-text td { border: 1px solid var(--border); padding: 4px 10px; font-size: 12.5px; }
.ai-text th { background: var(--bg-3); font-weight: 600; }
.ai-text strong { font-weight: 600; }
/* 工具活动行（流式气泡内，瞬时展示） */
.ai-code-block {
  background: var(--code-bg); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; margin: 6px 0; overflow-x: auto; position: relative;
}
.ai-code-block code { font-family: var(--font-mono); font-size: 12px; color: var(--text-0); white-space: pre; }
.ai-code-lang { position: absolute; top: 5px; right: 8px; font-size: 10px; color: var(--text-2); }
.ai-suggest {
  position: relative;
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
/* 命令卡片：图钉收藏按钮固定右上角（脱离操作区，hover 时显形避免遮挡粘贴按钮） */
.ai-suggest.cmd .ai-suggest-head { padding-right: 26px; }
.ai-suggest.cmd .ai-qc-fav {
  position: absolute; top: 7px; right: 8px;
  width: 22px; height: 22px; opacity: 0.35; transition: opacity 0.12s;
}
.ai-suggest.cmd:hover .ai-qc-fav { opacity: 1; }
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

/* ---------- Markdown 渲染（AI 回复正文；html:false 转义原始 HTML 防 XSS，breaks 保留单换行） ---------- */
const md = new MarkdownIt({
  html: false,
  breaks: true,
  linkify: true,
  typographer: false,
});
// 外链：新标签打开（点击由 chat 容器委托 openUrl 走系统浏览器）
const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noopener');
  return defaultLinkOpen(tokens, idx, options, env, self);
};

/* ---------- 状态 ---------- */
/** 受控工具动作卡（Agent 审批 / YOLO 自动执行 / 历史只读），按 toolCallId 索引 */
interface ActionCard {
  toolCallId: string;
  tool: string;
  intent: string;
  summary: string;
  /** run_command 展示命令原文 */
  command?: string;
  /** 审批事件携带的 requestId（批准/拒绝回执用） */
  requestId?: string;
  status: 'approving' | 'approved' | 'rejected' | 'running' | 'succeeded' | 'failed';
  /** actionEnd 的截断结果 */
  result?: string;
}

/** 生成中/错误气泡的瞬时状态（不进 ChatSession.messages，不落盘）；tools 为工具活动行（同上） */
interface Pending {
  phase: 'typing' | 'stream' | 'error';
  text: string;
  error?: string;
  tools: string[];
  /** 受控工具动作卡（本轮可观察审计，finalize 时随消息持久化） */
  actions: Map<string, ActionCard>;
}

const ACTION_NAMES: Record<string, string> = {
  write: '写文件',
  edit: '编辑文件',
  delete_path: '删除文件',
  run_command: '执行命令',
  sftp_upload: '上传文件',
  sftp_download: '下载文件',
};

const ACTION_STATUS: Record<ActionCard['status'], string> = {
  approving: '等待批准',
  approved: '已批准',
  running: '执行中…',
  succeeded: '成功',
  failed: '失败',
  rejected: '已拒绝',
};

/** 由 actionStart 的 args 计算动作意图（审批事件到达前占位；审批事件会覆盖） */
function argsIntent(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case 'write':
      return `写文件 ${String(args.path ?? '')}`;
    case 'edit':
      return `编辑文件 ${String(args.path ?? '')}`;
    case 'delete_path':
      return `删除 ${String(args.path ?? '')}`;
    case 'run_command':
      return String(args.intent ?? '');
    case 'sftp_upload':
      return `上传 ${String(args.localPath ?? '')} 到 ${String(args.remoteDir ?? '')}`;
    case 'sftp_download':
      return `下载 ${String(args.remotePath ?? '')} 到 ${String(args.localDir ?? '')}`;
    default:
      return '';
  }
}

const emptyPending = (): Pending => ({ phase: 'typing', text: '', tools: [], actions: new Map() });

let project: Project | null = null;
const sessions = new Map<string, ChatSession>(); // id -> ChatSession（含历史）
const pendingBy = new Map<string, Pending | null>(); // 会话 id -> 瞬时气泡状态
/** 用户手动展开的历史动作卡（key = `<sid>:<toolCallId>`；renderHistory 全量重渲染时保持状态） */
const expandedCards = new Set<string>();
const snapshots = new Map<string, TermSnapshot>(); // 快照 id -> 全文（输入区 chip + 历史消息 chip 共用）
const fileRefs = new Map<string, FileRef>(); // 文件引用 id -> 全文（编辑器选区，@文件名_起_止 标签）
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
let modeSelect: HTMLSelectElement;
/** 思考强度切换防抖：快速连续切换只允许一个保存流程 */
let effortSaving = false;
/** AI 模式切换防抖（YOLO 确认弹窗期间防重复触发） */
let modeSaving = false;

const MODE_LABEL: Record<AiMode, string> = { suggest: 'Suggest', agent: 'Agent', yolo: 'YOLO' };

/**
 * 切换 AI 模式：YOLO 先弹危险确认（取消回退原模式）；确认后调 setAiMode 落盘
 * （Rust 同时向该项目存活 pi 进程热推 /aishell-mode），成功才更新内存项目。
 */
async function switchMode(mode: AiMode): Promise<void> {
  if (modeSaving || !project) return;
  if (mode === project.aiMode) {
    modeSelect.value = project.aiMode;
    return;
  }
  if (mode === 'yolo') {
    const ok = await confirmDialog({
      title: '开启 YOLO 模式',
      message: 'AI助手会获得所有权限并自动执行操作，请勿在生产环境中开启',
      danger: true,
      okText: '仍要开启',
    });
    if (!ok) {
      modeSelect.value = project.aiMode;
      return;
    }
  }
  modeSaving = true;
  try {
    await setAiMode(project.id, mode);
    project.aiMode = mode;
    toast(`AI 模式已切换为 ${MODE_LABEL[mode]}`, 'success');
  } catch (err) {
    modeSelect.value = project.aiMode;
    toast(`切换 AI 模式失败：${String(err)}`, 'error');
  } finally {
    modeSaving = false;
  }
}

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
        <span class="ai-mode-label">${icon('bot')} AI 模式</span>
        <select id="ai-mode-select" class="select" title="AI 执行模式（按项目持久化）">
          <option value="suggest">Suggest</option>
          <option value="agent">Agent</option>
          <option value="yolo">YOLO</option>
        </select>
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
  modeSelect = el('mode-select') as HTMLSelectElement;
  modeSelect.value = project?.aiMode ?? 'suggest';

  /* 容器被移除（工作台页面卸载）→ 取消订阅、置空 Workbench.ai、杀掉本项目 pi 进程 */
  observer = new MutationObserver(() => {
    if (!container.isConnected) cleanup();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  Workbench.ai = aiHandle;

  // pi 运行时诊断输出到控制台（F12 可查），便于排查安装版「pi 运行时不存在」
  void aiDebugInfo().then((info) => console.log('[AI] pi 运行时诊断:\n' + info));

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
  addFileRef(ref: FileRef): void {
    if (!ref || !ref.id) return;
    fileRefs.set(ref.id, ref);
    addFileChip(ref);
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
    const p = cur ?? emptyPending();
    p.phase = 'stream';
    p.text += ev.text;
    pendingBy.set(sid, p);
  } else if (ev.type === 'tool') {
    /* 工具活动行：瞬时展示，不进历史；相邻重复行折叠为 ×N */
    const cur = pendingBy.get(sid) ?? null;
    const p = cur ?? emptyPending();
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
  } else if (ev.type === 'actionStart') {
    /* 受控工具开始：Agent 模式进入等待批准（审批事件随后到达），YOLO 直接执行中 */
    const cur = pendingBy.get(sid) ?? null;
    const p = cur ?? emptyPending();
    const existing = p.actions.get(ev.toolCallId);
    p.actions.set(ev.toolCallId, {
      toolCallId: ev.toolCallId,
      tool: ev.tool,
      intent: existing?.intent ?? argsIntent(ev.tool, ev.args),
      summary: existing?.summary ?? argsIntent(ev.tool, ev.args),
      command: typeof ev.args.command === 'string' ? ev.args.command : existing?.command,
      requestId: existing?.requestId,
      status: project?.aiMode === 'agent' ? 'approving' : 'running',
    });
    pendingBy.set(sid, p);
  } else if (ev.type === 'approval') {
    /* Agent 审批请求：卡片进入审批态（显示意图 + 批准/拒绝按钮） */
    const cur = pendingBy.get(sid) ?? null;
    const p = cur ?? emptyPending();
    const existing = p.actions.get(ev.toolCallId);
    p.actions.set(ev.toolCallId, {
      toolCallId: ev.toolCallId,
      tool: existing?.tool ?? ev.action,
      intent: ev.intent || existing?.intent || '',
      summary: ev.summary || existing?.summary || '',
      command: existing?.command,
      requestId: ev.requestId,
      status: existing?.status === 'running' ? 'running' : 'approving',
    });
    pendingBy.set(sid, p);
  } else if (ev.type === 'actionEnd') {
    /* 受控工具结束：更新终态（拒绝场景由前端本地标记，不走此事件） */
    const cur = pendingBy.get(sid) ?? null;
    const p = cur ?? emptyPending();
    const existing = p.actions.get(ev.toolCallId);
    if (existing) {
      existing.status = ev.isError ? 'failed' : 'succeeded';
      existing.result = ev.result ? ev.result.slice(0, 2000) : undefined;
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
    console.error('[AI] 事件错误:', ev.message);
    pendingBy.set(sid, { phase: 'error', text: '', error: ev.message, tools: [], actions: new Map() });
  }
  if (sid === activeSessionId) {
    renderHistory();
    updateSendBtn();
  }
}

/** 把瞬时动作卡整理为持久化审计记录（最终状态；未收到终态的执行中按已批准） */
function collectActions(p: Pending): AiActionRecord[] {
  return [...p.actions.values()].map((a) => ({
    toolCallId: a.toolCallId,
    tool: a.tool,
    intent: a.intent,
    summary: a.summary,
    status: a.status === 'rejected'
      ? 'rejected'
      : a.status === 'failed'
        ? 'failed'
        : a.status === 'succeeded'
          ? 'succeeded'
          : 'approved',
  }));
}

/** done：把流式文本定稿为 assistant 消息并落盘（错误气泡不进历史）；零增量 done 给占位文案 */
function finalize(sid: string): void {
  const s = sessions.get(sid);
  const p = pendingBy.get(sid) ?? null;
  pendingBy.set(sid, null);
  if (!s || !p || p.phase !== 'stream') return;
  const text = p.text.trim() ? p.text : '（AI 未返回内容，请重试或检查模型配置）';
  s.messages.push({
    role: 'assistant',
    content: text,
    snapshots: [],
    fileRefs: [],
    actions: collectActions(p),
    ts: Date.now(),
  });
  persistSession(s);
}

/** 离开一个正在生成的会话：中止后端并把手头文本定稿（切走后就收不到 done 事件了） */
function leaveSession(sid: string): void {
  const p = pendingBy.get(sid) ?? null;
  pendingBy.set(sid, null);
  if (p && p.phase === 'stream' && p.text) {
    const s = sessions.get(sid);
    if (s) {
      s.messages.push({
        role: 'assistant',
        content: p.text,
        snapshots: [],
        fileRefs: [],
        actions: collectActions(p),
        ts: Date.now(),
      });
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
  if (s) s.messages.forEach((m) => chat.appendChild(renderMessage(m, activeSessionId)));
  const pend = pendingBy.get(activeSessionId) ?? null;
  if (pend) chat.appendChild(renderPending(pend));
  scrollBottom();
}

/** 动作卡渲染：Agent 审批态带批准/拒绝按钮；执行中/终态/历史只读无按钮。
 *  collapsible（历史只读）：默认折叠，仅显示工具名与状态，点击展开详情。 */
function renderActionCard(
  a: ActionCard,
  opts: { collapsible?: boolean; expandKey?: string; expanded?: boolean } = {},
): string {
  const collapsible = !!opts.collapsible;
  const collapsed = collapsible && !opts.expanded;
  const statusText = ACTION_STATUS[a.status] ?? a.status;
  const cls = [
    ...(a.status === 'succeeded' || a.status === 'failed' || a.status === 'rejected' ? [a.status] : []),
    ...(collapsed ? ['collapsed'] : []),
  ].join(' ');
  const isCmd = a.tool === 'run_command';
  const buttons = a.status === 'approving' && a.requestId
    ? `<div class="ai-action-actions">
        <button class="btn small primary" type="button" data-act-approve="${escapeHtml(a.toolCallId)}">批准</button>
        <button class="btn small" type="button" data-act-reject="${escapeHtml(a.toolCallId)}">拒绝</button>
      </div>`
    : '';
  const resultHtml = a.result && (a.status === 'succeeded' || a.status === 'failed')
    ? `<div class="ai-action-result">${escapeHtml(a.result)}</div>`
    : '';
  const toggleHtml = collapsible
    ? `<span class="ai-action-toggle" title="${collapsed ? '展开详情' : '收起详情'}">${icon(collapsed ? 'arrowDown' : 'arrowUp')}</span>`
    : '';
  return `<div class="ai-action-card ${cls}"${collapsible ? ` data-collapsible="1" data-expand-key="${escapeHtml(opts.expandKey ?? '')}"` : ''}>
    <div class="ai-action-head">
      <span class="ai-action-name">${icon('wrench')} ${ACTION_NAMES[a.tool] ?? a.tool}</span>
      <span class="ai-action-status">${statusText}${toggleHtml}</span>
    </div>
    <div class="ai-action-detail">
      ${a.intent ? `<div class="ai-action-intent">意图：${escapeHtml(a.intent)}</div>` : ''}
      ${isCmd && a.command
        ? `<code class="ai-action-cmd">${escapeHtml(a.command)}</code>`
        : a.summary ? `<div class="ai-action-intent ai-action-summary">${escapeHtml(a.summary)}</div>` : ''}
      ${buttons}
      ${resultHtml}
    </div>
  </div>`;
}

function renderMessage(m: ChatMsg, sid: string): HTMLElement {
  const wrap = document.createElement('div');
  if (m.role === 'user') {
    wrap.className = 'ai-msg user';
    // 历史消息的快照/文件引用全文也进 map，chip 点击可查看
    m.snapshots.forEach((snap) => snapshots.set(snap.id, snap));
    m.fileRefs.forEach((ref) => fileRefs.set(ref.id, ref));
    const chips = [
      ...m.snapshots.map((snap) =>
        `<span class="tag blue ai-msg-chip" data-snap-id="${escapeHtml(snap.id)}" title="点击查看快照全文">@terminal_${escapeHtml(snap.id)}</span>`,
      ),
      ...m.fileRefs.map((ref) => {
        const n = ref.path.split(/[\\/]/).pop() || ref.path;
        return `<span class="tag blue ai-msg-chip" data-snap-id="${escapeHtml(ref.id)}" data-kind="file" title="点击查看文件引用">@${escapeHtml(n)}_${ref.startLine}_${ref.endLine}</span>`;
      }),
    ].join('');
    wrap.innerHTML =
      `<div class="ai-bubble">${chips ? `<div class="ai-msg-chips">${chips}</div>` : ''}` +
      `<div class="ai-text">${escapeHtml(m.content)}</div></div>`;
  } else {
    wrap.className = 'ai-msg ai';
    // 历史只读审计：动作卡复用同一渲染（终态无按钮，默认折叠可点击展开）；旧会话无 actions 为空
    const actionsHtml = (m.actions ?? []).map((a) => {
      const key = `${sid}:${a.toolCallId}`;
      return renderActionCard({
        toolCallId: a.toolCallId,
        tool: a.tool,
        intent: a.intent,
        summary: a.summary,
        status: a.status,
      }, { collapsible: true, expandKey: key, expanded: expandedCards.has(key) });
    }).join('');
    wrap.innerHTML = `<div class="ai-bubble"><div class="ai-text">${renderAI(m.content)}</div>${actionsHtml}</div>`;
  }
  return wrap;
}

function renderPending(p: Pending): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg ai';
  const toolLines = p.tools.map((t) => `<div class="ai-tool-line">${icon('wrench')}${escapeHtml(t)}</div>`).join('');
  const actionCards = [...p.actions.values()].map((a) => renderActionCard(a)).join('');
  if (p.phase === 'typing' || (p.phase === 'stream' && !p.text)) {
    wrap.innerHTML =
      `<div class="ai-bubble">${toolLines}${actionCards}` +
      '<span class="ai-typing"><span class="ai-typing-label">正在输入</span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span></span></div>';
  } else if (p.phase === 'error') {
    wrap.innerHTML = `<div class="ai-bubble error"><div class="ai-text">${escapeHtml(p.error ?? '')}</div></div>`;
  } else {
    wrap.innerHTML = `<div class="ai-bubble">${toolLines}${actionCards}<div class="ai-text">${renderAI(p.text)}</div></div>`;
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
          <button class="btn small" type="button">粘贴到终端</button>
        </span></div>
        <code class="ai-suggest-main">${escapeHtml(p.body)}</code>
        <button class="icon-btn ai-qc-fav" type="button" title="收藏为命令收藏">${icon('star')}</button>
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
      // markdown-it 渲染段落（标题/列表/粗体/行内代码/链接等），breaks:true 保留单换行
      return md.render(p.body);
  }
}

/** 回复 Agent 审批：批准 → 执行中；拒绝 → 已拒绝（后端只接受当前待处理 requestId） */
async function respondApproval(sid: string, toolCallId: string, confirmed: boolean): Promise<void> {
  if (!project) return;
  const p = pendingBy.get(sid) ?? null;
  const card = p?.actions.get(toolCallId);
  if (!p || !card || !card.requestId) {
    toast('审批请求已过期', 'error');
    return;
  }
  const requestId = card.requestId;
  try {
    await aiRespondApproval(`${project.id}:${sid}`, requestId, confirmed);
  } catch (err) {
    toast(String(err), 'error');
    return;
  }
  card.status = confirmed ? 'running' : 'rejected';
  card.requestId = undefined;
  if (sid === activeSessionId) {
    renderHistory();
    updateSendBtn();
  }
}

/* ---------- 建议卡片 / 动作审批 / 快照 chip 点击（事件委托） ---------- */
function onChatClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  /* 动作卡审批按钮：优先于卡片其他动作 */
  const approveBtn = target.closest('[data-act-approve]') as HTMLElement | null;
  if (approveBtn) {
    void respondApproval(activeSessionId, approveBtn.dataset.actApprove ?? '', true);
    return;
  }
  const rejectBtn = target.closest('[data-act-reject]') as HTMLElement | null;
  if (rejectBtn) {
    void respondApproval(activeSessionId, rejectBtn.dataset.actReject ?? '', false);
    return;
  }
  /* 历史动作卡：点击切换折叠/展开（保持 expandedCards 状态，重渲染不丢） */
  const actionCard = target.closest('.ai-action-card[data-collapsible]') as HTMLElement | null;
  if (actionCard && !target.closest('button, a')) {
    const key = actionCard.dataset.expandKey ?? '';
    if (key) {
      const willExpand = !actionCard.classList.contains('collapsed');
      if (willExpand) expandedCards.delete(key);
      else expandedCards.add(key);
      actionCard.classList.toggle('collapsed');
      const toggle = actionCard.querySelector('.ai-action-toggle') as HTMLElement | null;
      if (toggle) {
        toggle.title = willExpand ? '展开详情' : '收起详情';
        toggle.innerHTML = icon(willExpand ? 'arrowDown' : 'arrowUp');
      }
    }
    return;
  }
  /* Markdown 链接：系统浏览器打开（卡片区无 <a>，不会与图钉/粘贴动作冲突） */
  const link = target.closest('a[href]') as HTMLAnchorElement | null;
  if (link) {
    e.preventDefault();
    void openUrl(link.href).catch((err) => toast(`无法打开链接: ${String(err)}`, 'error'));
    return;
  }
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
  if (chip) {
    const id = chip.dataset.snapId ?? '';
    if (chip.dataset.kind === 'file') openFileRefModal(fileRefs.get(id));
    else openSnapModal(snapshots.get(id));
  }
}

/* ---------- 输入区 chip（终端快照 / 文件引用） ---------- */
function addChip(snap: TermSnapshot): void {
  const c = document.createElement('span');
  c.className = 'tag blue ai-snap-chip';
  c.dataset.id = snap.id;
  c.dataset.kind = 'term';
  c.title = '点击查看快照全文，✕ 移除';
  c.innerHTML = `@terminal_${escapeHtml(snap.id)}<span class="ai-chip-x" title="移除">${icon('x')}</span>`;
  chipRow.appendChild(c);
}

function addFileChip(ref: FileRef): void {
  const name = ref.path.split(/[\\/]/).pop() || ref.path;
  const c = document.createElement('span');
  c.className = 'tag blue ai-snap-chip';
  c.dataset.id = ref.id;
  c.dataset.kind = 'file';
  c.title = `点击查看文件引用，✕ 移除 · ${ref.path} 第${ref.startLine}-${ref.endLine}行`;
  c.innerHTML = `@${escapeHtml(name)}_${ref.startLine}_${ref.endLine}<span class="ai-chip-x" title="移除">${icon('x')}</span>`;
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
  if (chip.dataset.kind === 'file') openFileRefModal(fileRefs.get(chip.dataset.id ?? ''));
  else openSnapModal(snapshots.get(chip.dataset.id ?? ''));
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

function openFileRefModal(ref: FileRef | undefined): void {
  if (!ref) return;
  const name = ref.path.split(/[\\/]/).pop() || ref.path;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal-head"><h3>文件引用 · @${escapeHtml(name)}_${ref.startLine}_${ref.endLine}</h3><button class="icon-btn ai-modal-x" title="关闭">${icon('x')}</button></div>
      <div class="modal-body">
        <div class="ai-snap-command mono">${escapeHtml(ref.path)} · 第${ref.startLine}-${ref.endLine}行</div>
        <pre class="ai-snap-pre">${escapeHtml(ref.content || '')}</pre>
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
  const snaps: TermSnapshot[] = [];
  const refs: FileRef[] = [];
  chipRow.querySelectorAll('.ai-snap-chip').forEach((c) => {
    const el = c as HTMLElement;
    const id = el.dataset.id ?? '';
    if (el.dataset.kind === 'file') {
      const r = fileRefs.get(id);
      if (r) refs.push(r);
    } else {
      const s = snapshots.get(id);
      if (s) snaps.push(s);
    }
  });
  if (!text && snaps.length === 0 && refs.length === 0) return;

  // 首条用户消息决定会话标题
  if (s.messages.length === 0) s.title = text.slice(0, 20) || '文件引用';

  s.messages.push({ role: 'user', content: text, snapshots: snaps, fileRefs: refs, actions: [], ts: Date.now() });
  input.value = '';
  autoGrow();
  clearChips();
  pendingBy.set(sid, emptyPending());
  renderSessionBar();
  renderHistory();
  updateSendBtn();
  persistSession(s);

  // 提交给 ai_chat 的 prompt = 用户文本 + 每个快照/文件引用追加（UI 气泡只显示 chip）
  const prompt = text + snaps
    .map((sn) => `\n\n[终端快照 命令: ${sn.command}]\n${sn.content.slice(0, 4000)}`)
    .join('') + refs
    .map((r) => `\n\n[文件引用 ${r.path} 第${r.startLine}-${r.endLine}行]\n${r.content.slice(0, 4000)}`)
    .join('');
  aiChat(`${project.id}:${sid}`, prompt).catch((err: unknown) => {
    // 提交失败（pi 运行时缺失 / 未配置 API Key 等）：错误气泡红边；完整信息打到控制台便于排查
    console.error('[AI] ai_chat 失败:', err);
    pendingBy.set(sid, { phase: 'error', text: '', error: String(err), tools: [], actions: new Map() });
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
  modeSelect.onchange = () => {
    void switchMode(modeSelect.value as AiMode);
  };
}
