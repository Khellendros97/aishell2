/**
 * AI 助手面板 —— 照 .proto/workbench-ai.js 移植全部交互，mock 回复换成 pi 子进程流式事件
 * （ai:event:<key> 订阅，见 src/api.ts）。挂载时设置 Workbench.ai = { addSnapshot, addFileRef, addServerRef, addPathRef }，
 * 容器被移除时置 null 并 aiKillProject 清理该项目的 pi 进程。
 * 输入区 chip 四类引用：终端快照 @terminal_<id>、文件引用 @文件名_起_止、服务器/本地终端引用
 * @remote:服务器名称 / @local、文件/目录路径引用 @file:文件名 / @path:目录名（发送时展开为说明文本拼进 prompt）；
 * Settings.autoSwitchAiWorkdir
 * 开启时输入区固定显示工作区域标签，随激活终端自动切换并作为当前目标上下文带入。
 */
import type { UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import MarkdownIt from 'markdown-it';
import type { AiActionRecord, AiMode, AppState, ChatMsg, ChatSession, FileRef, LlmConfig, PathRef, Project, Server, ServerRef, TermSnapshot } from '../../types';
import { icon } from '../../icons';
import {
  aiAbort, aiChat, aiDebugInfo, aiKillProject, aiRespondApproval, aiSetThinking, getState, onAiEvent, saveSettings,
  sessionUpsert, sessionsGet, setAiMode,
  type AiEvent,
} from '../../api';
import { Workbench, activateTab, bus, getActiveTab, getActiveTerminalApi, getTabs, type Tab, type TerminalApi } from './core';
import { addQuickCommandModal } from './quickcommand';
import { confirmDialog, copyText, toast, uid } from '../../ui';

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
.ai-action-card .ai-action-status { font-size: 11px; color: var(--text-2); display: inline-flex; align-items: center; gap: 5px; }
.ai-action-spinner {
  width: 11px; height: 11px; flex: none; border: 1.5px solid var(--border-strong);
  border-top-color: var(--accent); border-radius: 50%;
  animation: ai-action-spin .75s linear infinite;
}
@keyframes ai-action-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ai-action-spinner { animation-duration: 1.8s; } }
.ai-action-card .ai-action-result {
  font-size: 11px; color: var(--text-2); max-height: 90px; overflow-y: auto;
  white-space: pre-wrap; word-break: break-all;
}
.ai-action-card.succeeded { border-left: 3px solid var(--green); }
.ai-action-card.failed { border-left: 3px solid var(--red); }
.ai-action-card.rejected { border-left: 3px solid var(--yellow); opacity: 0.75; }
/* 回合结束后的一串工具调用：整组折叠，点击组头展开/收起 */
.ai-action-group { margin: 6px 0; }
.ai-action-group-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: 8px;
  padding: 7px 10px; font-size: 11.5px; cursor: pointer; user-select: none;
}
.ai-action-group-title { font-weight: 600; display: inline-flex; align-items: center; gap: 4px; }
.ai-action-group-title svg { flex: none; }
.ai-action-group-meta { display: inline-flex; align-items: center; gap: 6px; color: var(--text-2); }
.ai-action-group-bad { color: var(--red); }
.ai-action-group-warn { color: var(--yellow); }
.ai-action-group-body { display: flex; flex-direction: column; }
.ai-action-group.collapsed .ai-action-group-body { display: none; }
.ai-action-group-toggle {
  display: inline-flex; align-items: center;
  color: var(--text-2); vertical-align: -2px;
}
.ai-action-group-toggle svg { width: 12px; height: 12px; }
.ai-action-card .ai-action-detail { display: flex; flex-direction: column; gap: 5px; }
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
/* 固定工作区域标签：随激活终端自动切换、不可移除，图标与文字对齐 */
.ai-workarea-chip {
  cursor: default; display: inline-flex; align-items: center; gap: 4px;
  border-color: var(--accent); color: var(--accent-hover);
}
.ai-workarea-chip .ic { flex: none; }
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
  /** run_command 整体超时秒数（未传时后端默认 10 秒） */
  timeoutSeconds?: number;
  /** 审批事件携带的 requestId（批准/拒绝回执用） */
  requestId?: string;
  /** 智能审批自动放行：status='smart' 时展示判定理由 */
  smartReason?: string;
  status: 'approving' | 'approved' | 'rejected' | 'running' | 'succeeded' | 'failed' | 'smart';
  /** actionEnd 的截断结果 */
  result?: string;
  /** 动作开始时已生成文本长度(text 内时序锚点,渲染时把卡片穿插到该位置) */
  textLen?: number;
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
  smart: '已智能放行',
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
      return `上传 ${String(args.localPath ?? '')} 到 ${String(args.remoteDir ?? '')}${args.overwrite ? '（覆盖同名）' : ''}`;
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
/** 用户手动展开的工具调用组（key = `<sid>:<消息ts>`；renderHistory 全量重渲染时保持状态） */
const expandedGroups = new Set<string>();
const snapshots = new Map<string, TermSnapshot>(); // 快照 id -> 全文（输入区 chip + 历史消息 chip 共用）
const fileRefs = new Map<string, FileRef>(); // 文件引用 id -> 全文（编辑器选区，@文件名_起_止 标签）
const serverRefs = new Map<string, ServerRef>(); // 服务器/本地引用 key -> 引用（key = serverId ?? 'local'，@remote:名称 / @local 标签）
const pathRefs = new Map<string, PathRef>(); // 文件/目录路径引用 path -> 引用（@file:文件名 / @path:目录名 标签）
/** 自动切换 AI 工作区域（Settings.autoSwitchAiWorkdir）：开启时输入区固定显示工作区域标签 */
let autoSwitchAiWorkdir = false;
/** 当前 AI 工作区域（默认本地；随激活终端自动切换） */
let workareaRef: ServerRef | null = null;
/** 工作区域固定标签 DOM（不可移除；clearChips 清空后由 renderWorkareaChip 重建） */
let workareaChipEl: HTMLElement | null = null;
let activeSessionId = '';
let unlisten: UnlistenFn | null = null;
let observer: MutationObserver | null = null;
let unmounted = false;
/** AI 面板根容器（Ctrl+C 键盘策略监听用，卸载时移除） */
let panelRoot: HTMLElement | null = null;

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

/* UI 显示文案：内部枚举值不变（AiMode / LlmConfig.effort），仅展示层用中文 */
const MODE_LABEL: Record<AiMode, string> = { suggest: '仅建议', agent: '工作', yolo: '全自动' };
const EFFORT_LABEL: Record<LlmConfig['effort'], string> = { low: '低', high: '高', max: '最高' };

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
      title: '开启全自动模式',
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
    /* 跨「仅建议」边界（suggest ↔ agent/yolo）时，Rust 侧会重启该项目全部 pi 进程
       （--tools 与系统提示不同，热推无法变更模型可见工具集）；生成中的回合被打断，
       这里把所有会话的流式文本定稿并中止后端，UI 即时反映新模式。 */
    const crossedSuggest = (project.aiMode === 'suggest') !== (mode === 'suggest');
    project.aiMode = mode;
    modeSelect.value = mode;
    if (crossedSuggest) leaveAllSessions();
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

  /* 会话与瞬时状态严格按项目隔离：工作台每次进入都会重新挂载本面板，
     清空上一项目残留的会话/快照/引用/展开态，防止跨项目串数据（会话列表只含当前项目）。 */
  sessions.clear();
  pendingBy.clear();
  expandedGroups.clear();
  snapshots.clear();
  fileRefs.clear();
  serverRefs.clear();
  pathRefs.clear();
  autoSwitchAiWorkdir = false;
  workareaRef = null;
  workareaChipEl = null;
  activeSessionId = '';

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
          <option value="suggest">仅建议</option>
          <option value="agent">工作</option>
          <option value="yolo">全自动</option>
        </select>
        <span class="ai-effort-label">${icon('zap')} 思考强度</span>
        <select id="ai-effort-select" class="select" title="思考强度（立即生效）">
          <option value="low">低</option>
          <option value="high">高</option>
          <option value="max">最高</option>
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

  /* 自动切换 AI 工作区域：激活终端标签（含新开终端）时跟随切换；
     AI 面板页级常驻（每页只挂一次），卸载后 unmounted 守卫 + container.isConnected 守卫兜底 */
  bus.on('tab-activated', (t) => {
    if (unmounted || !container.isConnected) return;
    if (autoSwitchAiWorkdir) updateWorkareaFromTab(t);
  });

  // pi 运行时诊断输出到控制台（F12 可查），便于排查安装版「pi 运行时不存在」
  void aiDebugInfo().then((info) => console.log('[AI] pi 运行时诊断:\n' + info));

  bindEvents();
  panelRoot = container;
  container.addEventListener('keydown', onPanelKeydown, true);
  void loadSessions();
  void loadEffort();
}

function cleanup(): void {
  if (unmounted) return;
  unmounted = true;
  if (panelRoot) { panelRoot.removeEventListener('keydown', onPanelKeydown, true); panelRoot = null; }
  if (unlisten) { unlisten(); unlisten = null; }
  if (observer) { observer.disconnect(); observer = null; }
  if (Workbench.ai === aiHandle) Workbench.ai = null;
  if (project) void aiKillProject(project.id).catch(() => { /* 进程清理失败可忽略 */ });
}

/* ---------- Workbench.ai 句柄（终端模块添加快照 / 服务器引用 / 路径引用） ---------- */
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
  /** 服务器/本地终端引用（@remote:服务器名称 / @local 标签）；与固定工作区域重复时不再插入 */
  addServerRef(ref: ServerRef): void {
    if (!ref || typeof ref.name !== 'string' || !ref.name.trim()) return;
    const key = serverRefKey(ref);
    if (autoSwitchAiWorkdir && workareaRef && serverRefKey(workareaRef) === key) {
      toast('该终端已是当前 AI 工作区域，无需重复添加');
      return;
    }
    if (serverRefs.has(key)) {
      toast('该引用已在输入框中');
      return;
    }
    serverRefs.set(key, ref);
    addServerRefChip(ref);
  },
  /** 文件/目录路径引用（@file:文件名 / @path:目录名 标签，发送时只带路径不带内容）；重复添加时提示 */
  addPathRef(ref: PathRef): void {
    if (!ref || typeof ref.path !== 'string' || !ref.path.trim()) return;
    if (pathRefs.has(ref.path)) {
      toast('该引用已在输入框中');
      return;
    }
    pathRefs.set(ref.path, ref);
    addPathRefChip(ref);
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

/** 读取思考强度/工作区域设置回显（后端 settings 为事实源） */
async function loadEffort(): Promise<void> {
  try {
    const st = await getState();
    effortSelect.value = st.settings.llm.effort || 'low';
    autoSwitchAiWorkdir = !!st.settings.autoSwitchAiWorkdir;
  } catch {
    /* 读取失败保持默认 low / 开启（与 Settings 默认一致） */
  }
  // 开启自动切换时：初始工作区域默认本地；已有激活终端则跟随其归属
  if (autoSwitchAiWorkdir) {
    const active = getActiveTab();
    if (active && active.type === 'terminal') updateWorkareaFromTab(active);
    renderWorkareaChip();
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
    toast(`思考强度已切换为 ${EFFORT_LABEL[level]}`, 'success');
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
    const timeoutArg = ev.args.timeoutSeconds;
    p.actions.set(ev.toolCallId, {
      toolCallId: ev.toolCallId,
      tool: ev.tool,
      intent: existing?.intent ?? argsIntent(ev.tool, ev.args),
      summary: existing?.summary ?? argsIntent(ev.tool, ev.args),
      command: typeof ev.args.command === 'string' ? ev.args.command : existing?.command,
      timeoutSeconds: typeof timeoutArg === 'number' && Number.isInteger(timeoutArg)
        ? timeoutArg
        : existing?.timeoutSeconds ?? 10,
      requestId: existing?.requestId,
      status: project?.aiMode === 'agent' ? 'approving' : 'running',
      textLen: existing?.textLen ?? p.text.length,
    });
    pendingBy.set(sid, p);
  } else if (ev.type === 'approval') {
    /* AI 申请切换到工作模式（suggest 模式的 request_agent_mode 工具）：弹确认框，
       不进动作卡；其余仍为 Agent 逐调用审批卡 */
    if (ev.action === 'request_agent_mode') {
      void handleModeRequest(sid, ev);
    } else if (ev.smart) {
      /* 智能审批自动放行：后端已判定非危险并直接回 confirmed，卡片进入「已智能放行」态 */
      const cur = pendingBy.get(sid) ?? null;
      const p = cur ?? emptyPending();
      const existing = p.actions.get(ev.toolCallId);
      p.actions.set(ev.toolCallId, {
        toolCallId: ev.toolCallId,
        tool: existing?.tool ?? ev.action,
        intent: ev.intent || existing?.intent || '',
        summary: ev.summary || existing?.summary || '',
        command: existing?.command,
        timeoutSeconds: existing?.timeoutSeconds,
        status: 'smart',
        smartReason: ev.smartReason,
        textLen: existing?.textLen ?? p.text.length,
      });
      pendingBy.set(sid, p);
    } else {
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
        timeoutSeconds: existing?.timeoutSeconds,
        requestId: ev.requestId,
        status: existing?.status === 'running' ? 'running' : 'approving',
        smartReason: ev.smartReason,
        textLen: existing?.textLen ?? p.text.length,
      });
      pendingBy.set(sid, p);
    }
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
    timeoutSeconds: a.timeoutSeconds,
    textLen: a.textLen,
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
    serverRefs: [],
    pathRefs: [],
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
        serverRefs: [],
        pathRefs: [],
        actions: collectActions(p),
        ts: Date.now(),
      });
      persistSession(s);
    }
  }
  if (project) void aiAbort(`${project.id}:${sid}`).catch(() => { /* 后端无进程时静默 */ });
}

/** 模式切换跨「仅建议」边界时后端会重启本项目全部 pi 进程：把所有会话的生成中文本
 *  定稿并中止后端（与 leaveSession 同语义，逐会话处理） */
function leaveAllSessions(): void {
  [...sessions.keys()].forEach((sid) => leaveSession(sid));
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
 *  历史一串动作卡的折叠由 renderActionGroup 整组负责，单卡不再单独折叠。 */
function renderActionCard(a: ActionCard): string {
  const isCmd = a.tool === 'run_command';
  // actionStart 后：YOLO/人工批准为 running；智能审批自动放行暂存 smart，二者都仍在执行中。
  const isCmdRunning = isCmd && (a.status === 'running' || a.status === 'smart');
  const statusText = a.status === 'smart' && isCmdRunning
    ? '已智能放行 · 执行中…'
    : ACTION_STATUS[a.status] ?? a.status;
  const cls = a.status === 'succeeded' || a.status === 'failed' || a.status === 'rejected' ? a.status : '';
  const loadingHtml = isCmdRunning
    ? '<span class="ai-action-spinner" role="status" aria-label="命令执行中"></span>'
    : '';
  const buttons = a.status === 'approving' && a.requestId
    ? `<div class="ai-action-actions">
        <button class="btn small primary" type="button" data-act-approve="${escapeHtml(a.toolCallId)}">批准</button>
        <button class="btn small" type="button" data-act-reject="${escapeHtml(a.toolCallId)}">拒绝</button>
      </div>`
    : '';
  const resultHtml = a.result && (a.status === 'succeeded' || a.status === 'failed')
    ? `<div class="ai-action-result">${escapeHtml(a.result)}</div>`
    : '';
  const smartHtml = a.smartReason
    ? `<div class="ai-action-intent ai-action-smart">${a.status === 'approving' ? '智能审批拦截（转人工确认）' : '智能判定'}：${escapeHtml(a.smartReason)}</div>`
    : '';
  const timeoutHtml = isCmd
    ? `<div class="ai-action-intent">超时：${a.timeoutSeconds ?? 10} 秒</div>`
    : '';
  return `<div class="ai-action-card ${cls}">
    <div class="ai-action-head">
      <span class="ai-action-name">${icon('wrench')} ${ACTION_NAMES[a.tool] ?? a.tool}</span>
      <span class="ai-action-status">${loadingHtml}${statusText}</span>
    </div>
    <div class="ai-action-detail">
      ${a.intent ? `<div class="ai-action-intent">意图：${escapeHtml(a.intent)}</div>` : ''}
      ${isCmd && a.command
        ? `<code class="ai-action-cmd">${escapeHtml(a.command)}</code>`
        : a.summary ? `<div class="ai-action-intent ai-action-summary">${escapeHtml(a.summary)}</div>` : ''}
      ${timeoutHtml}
      ${smartHtml}
      ${buttons}
      ${resultHtml}
    </div>
  </div>`;
}

/** 回合结束后的历史动作卡整组折叠：默认收起为「工具调用 (N)」一行，点击组头展开全部详情。
 *  失败/拒绝计数在组头聚合提示；展开状态以 `<sid>:<消息ts>` 为 key 跨重渲染保持。 */
function renderActionGroup(actions: AiActionRecord[], groupKey: string): string {
  const expanded = expandedGroups.has(groupKey);
  const failed = actions.filter((a) => a.status === 'failed').length;
  const rejected = actions.filter((a) => a.status === 'rejected').length;
  const badHtml = failed ? `<span class="ai-action-group-bad">${failed} 失败</span>` : '';
  const warnHtml = !failed && rejected ? `<span class="ai-action-group-warn">${rejected} 已拒绝</span>` : '';
  const cards = actions
    .map((a) => renderActionCard({
      toolCallId: a.toolCallId,
      tool: a.tool,
      intent: a.intent,
      summary: a.summary,
      status: a.status,
      timeoutSeconds: a.timeoutSeconds,
    }))
    .join('');
  return `<div class="ai-action-group${expanded ? '' : ' collapsed'}" data-group-key="${escapeHtml(groupKey)}">
    <div class="ai-action-group-head">
      <span class="ai-action-group-title">${icon('wrench')} 工具调用 (${actions.length})</span>
      <span class="ai-action-group-meta">${badHtml}${warnHtml}<span class="ai-action-group-toggle" title="${expanded ? '收起' : '展开'}">${icon(expanded ? 'arrowUp' : 'arrowDown')}</span></span>
    </div>
    <div class="ai-action-group-body">${cards}</div>
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
      ...(m.serverRefs ?? []).map((r) => {
        const key = serverRefKey(r);
        const label = r.serverId ? `@remote:${r.name}` : '@local';
        return `<span class="tag blue ai-msg-chip" data-snap-id="${escapeHtml(key)}" data-kind="server" title="${r.serverId ? `引用服务器「${r.name}」` : '引用本地终端'}">${escapeHtml(label)}</span>`;
      }),
      ...(m.pathRefs ?? []).map((r) => {
        const name = r.path.split('/').filter(Boolean).pop() || r.path;
        const label = r.isDir ? `@path:${name}` : `@file:${name}`;
        return `<span class="tag blue ai-msg-chip" data-snap-id="${escapeHtml(r.path)}" data-kind="path" title="引用路径">${escapeHtml(label)}</span>`;
      }),
    ].join('');
    wrap.innerHTML =
      `<div class="ai-bubble">${chips ? `<div class="ai-msg-chips">${chips}</div>` : ''}` +
      `<div class="ai-text">${escapeHtml(m.content)}</div></div>`;
  } else {
    wrap.className = 'ai-msg ai';
    /* 时序排版:有 textLen 锚点的动作卡穿插进 content 对应位置(文本段→卡→文本段);
       旧记录(全部无锚点)回退为末尾整组折叠「工具调用 (N)」 */
    const hasAnchors = (m.actions ?? []).some((a) => a.textLen != null);
    const bodyHtml = hasAnchors
      ? interleaveActions(
          m.content,
          (m.actions ?? []).map((a) => ({
            html: renderActionCard({
              toolCallId: a.toolCallId,
              tool: a.tool,
              intent: a.intent,
              summary: a.summary,
              status: a.status,
              timeoutSeconds: a.timeoutSeconds,
            }),
            textLen: a.textLen,
          })),
        )
      : renderAI(m.content) + (m.actions?.length ? renderActionGroup(m.actions, `${sid}:${m.ts}`) : '');
    wrap.innerHTML = `<div class="ai-bubble"><div class="ai-text">${bodyHtml}</div></div>`;
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
    /* 流式:动作卡按 textLen 锚点穿插进已生成文本(与历史时序排版同规则) */
    const cards = [...p.actions.values()].map((a) => ({ html: renderActionCard(a), textLen: a.textLen }));
    const body = cards.some((c) => c.textLen != null)
      ? interleaveActions(p.text, cards)
      : `${actionCards}${renderAI(p.text)}`;
    wrap.innerHTML = `<div class="ai-bubble">${toolLines}<div class="ai-text">${body}</div></div>`;
  }
  return wrap;
}

/** 把动作卡按 textLen 锚点穿插进文本:时间顺序排版(文本段 → 动作卡 → 文本段);
 *  无锚点的卡按序排在文本末尾(兼容旧记录)。锚点是 content 的字符偏移,
 *  text 只增不减故偏移稳定;锚点恰好落在 ``` 围栏中间的概率极低(工具边界即文本分段点)。 */
function interleaveActions(text: string, cards: Array<{ html: string; textLen?: number }>): string {
  const sorted = [...cards].sort((a, b) => (a.textLen ?? Infinity) - (b.textLen ?? Infinity));
  let out = '';
  let last = 0;
  for (const c of sorted) {
    const at = Math.min(c.textLen ?? text.length, text.length);
    if (at > last) out += renderAI(text.slice(last, at));
    out += c.html;
    last = at;
  }
  if (last < text.length) out += renderAI(text.slice(last));
  return out || renderAI(text);
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

/** AI 申请切换到工作模式（request_agent_mode 工具，仅建议模式可用）：
 *  弹确认框展示申请理由；同意 → 先回复 pi（guard 拿到结果后本回合可继续），
 *  再走 switchMode 实时切换路径切到工作模式（跨边界会重启进程、定稿当前生成）；
 *  拒绝 → 仅回复 pi，保持仅建议模式。 */
async function handleModeRequest(sid: string, ev: Extract<AiEvent, { type: 'approval' }>): Promise<void> {
  if (!project) return;
  const ok = await confirmDialog({
    title: 'AI 申请切换到工作模式',
    message: `AI 申请理由：${ev.summary || ev.intent || '未说明'}\n\n同意后当前会话立即切换为工作模式（Agent），AI 将获得执行命令、修改文件等权限。`,
    okText: '同意切换',
  });
  try {
    await aiRespondApproval(`${project.id}:${sid}`, ev.requestId, ok);
  } catch (err) {
    toast(`回复 AI 申请失败：${String(err)}`, 'error');
    return;
  }
  if (ok) {
    await switchMode('agent');
    /* 跨边界切换后端重启 pi 进程,当前回合已被打断定稿(switchMode → leaveAllSessions);
       会话历史在 --session 文件中,自动补发继续指令,AI 在工作模式下恢复历史接续执行 */
    if (project && project.aiMode === 'agent') autoResumeAfterModeSwitch(sid);
  } else {
    toast('已拒绝 AI 的工作模式申请', 'info');
  }
}

/** 模式切换后的自动续跑:以一条用户消息把「已同意,请继续」送进会话并提交 aiChat;
 *  pi 经 --session 恢复完整历史(含 AI 的申请与用户同意),据此接续被打断的操作。
 *  有 pending(切换未生效/会话仍生成中)时不补发,避免与在途回合冲突。 */
function autoResumeAfterModeSwitch(sid: string): void {
  if (!project) return;
  const s = sessions.get(sid);
  if (!s || pendingBy.get(sid)) return;
  const text = '已同意切换到工作模式，请继续执行刚才的操作。';
  s.messages.push({
    role: 'user',
    content: text,
    snapshots: [],
    fileRefs: [],
    serverRefs: [],
    pathRefs: [],
    actions: [],
    ts: Date.now(),
  });
  pendingBy.set(sid, emptyPending());
  if (sid === activeSessionId) {
    renderHistory();
    updateSendBtn();
  }
  persistSession(s);
  aiChat(`${project.id}:${sid}`, text).catch((err: unknown) => {
    console.error('[AI] 模式切换后续跑失败:', err);
    pendingBy.set(sid, { phase: 'error', text: '', error: String(err), tools: [], actions: new Map() });
    if (sid === activeSessionId) {
      renderHistory();
      updateSendBtn();
    }
  });
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
  /* 工具调用组：点击组头切换折叠/展开（保持 expandedGroups 状态，重渲染不丢） */
  const groupHead = target.closest('.ai-action-group-head') as HTMLElement | null;
  if (groupHead && !target.closest('button, a')) {
    const group = groupHead.closest('.ai-action-group') as HTMLElement | null;
    const key = group?.dataset.groupKey ?? '';
    if (group && key) {
      const willExpand = group.classList.contains('collapsed');
      if (willExpand) expandedGroups.add(key);
      else expandedGroups.delete(key);
      group.classList.toggle('collapsed');
      const toggle = groupHead.querySelector('.ai-action-group-toggle') as HTMLElement | null;
      if (toggle) {
        toggle.title = willExpand ? '收起' : '展开';
        toggle.innerHTML = icon(willExpand ? 'arrowUp' : 'arrowDown');
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
        // 目标终端标签未激活时先切换过去，再聚焦，保证「直接回车即可执行」
        const termTab = getTabs().find((t) => t.type === 'terminal' && t.api === api);
        const active = getActiveTab();
        if (termTab && (!active || active.id !== termTab.id)) activateTab(termTab.id);
        api.focus();
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
    if (chip.dataset.kind === 'server') return; // 服务器引用无详情弹窗
    if (chip.dataset.kind === 'file') openFileRefModal(fileRefs.get(id));
    else openSnapModal(snapshots.get(id));
  }
}

/* ---------- 输入区 chip（终端快照 / 文件引用 / 服务器引用 / 固定工作区域） ---------- */
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

/** 服务器/本地引用 key：serverId 为空 = 本地终端 */
function serverRefKey(r: ServerRef): string {
  return r.serverId ?? 'local';
}

function addServerRefChip(ref: ServerRef): void {
  const key = serverRefKey(ref);
  const label = ref.serverId ? `@remote:${ref.name}` : '@local';
  const c = document.createElement('span');
  c.className = 'tag blue ai-snap-chip';
  c.dataset.id = key;
  c.dataset.kind = 'server';
  c.title = ref.serverId ? `引用服务器「${ref.name}」，✕ 移除` : '引用本地终端，✕ 移除';
  c.innerHTML = `${escapeHtml(label)}<span class="ai-chip-x" title="移除">${icon('x')}</span>`;
  chipRow.appendChild(c);
}

/** 文件/目录路径引用 chip：标签只用路径最后一段（@file:文件名 / @path:目录名），title 带完整路径 */
function addPathRefChip(ref: PathRef): void {
  const name = ref.path.split('/').filter(Boolean).pop() || ref.path;
  const label = ref.isDir ? `@path:${name}` : `@file:${name}`;
  const c = document.createElement('span');
  c.className = 'tag blue ai-snap-chip';
  c.dataset.id = ref.path;
  c.dataset.kind = 'path';
  c.title = `${ref.path}，✕ 移除`;
  c.innerHTML = `${escapeHtml(label)}<span class="ai-chip-x" title="移除">${icon('x')}</span>`;
  chipRow.appendChild(c);
}

const clearChips = (): void => {
  chipRow.innerHTML = '';
  /* 状态 Map 必须与 chip DOM 同步清空:此前只清 DOM,serverRefs 等残留导致
     发送后重新添加同一引用被误判「该引用已在输入框中」(与 chip ✕ 移除路径同语义) */
  snapshots.clear();
  fileRefs.clear();
  serverRefs.clear();
  pathRefs.clear();
  renderWorkareaChip(); // 固定工作区域标签不随发送清空，重新挂载
};

/** 固定工作区域标签（不可移除）：显示 @local / @remote:服务器名称，随激活终端自动切换 */
function renderWorkareaChip(): void {
  if (!autoSwitchAiWorkdir) {
    if (workareaChipEl) { workareaChipEl.remove(); workareaChipEl = null; }
    return;
  }
  if (!workareaRef) workareaRef = { serverId: null, name: '本地终端' };
  const label = workareaRef.serverId ? `@remote:${workareaRef.name}` : '@local';
  const title = workareaRef.serverId
    ? `当前 AI 工作区域：服务器「${workareaRef.name}」（随激活终端自动切换）`
    : '当前 AI 工作区域：本地（随激活终端自动切换）';
  if (workareaChipEl && workareaChipEl.isConnected) {
    workareaChipEl.innerHTML = `${icon('globe')} ${escapeHtml(label)}`;
    workareaChipEl.title = title;
    return;
  }
  const c = document.createElement('span');
  c.className = 'tag blue ai-snap-chip ai-workarea-chip';
  c.dataset.kind = 'workarea';
  c.title = title;
  c.innerHTML = `${icon('globe')} ${escapeHtml(label)}`;
  chipRow.prepend(c);
  workareaChipEl = c;
}

/** 工作区域切换：更新固定标签；同名手动引用被覆盖（固定引用不重复插入） */
function setWorkarea(ref: ServerRef): void {
  const key = serverRefKey(ref);
  if (workareaRef && serverRefKey(workareaRef) === key) {
    // 名称可能变化（如服务器改名），仍刷新标签
    workareaRef = ref;
    renderWorkareaChip();
    return;
  }
  workareaRef = ref;
  if (serverRefs.has(key)) {
    serverRefs.delete(key);
    chipRow.querySelectorAll('.ai-snap-chip[data-kind="server"]').forEach((el) => {
      if ((el as HTMLElement).dataset.id === key) el.remove();
    });
  }
  renderWorkareaChip();
}

/** 激活终端 → 工作区域：SSH 终端取服务器引用，本地终端取本地引用；非终端标签不切换 */
function updateWorkareaFromTab(t: Tab | null): void {
  if (!t || t.type !== 'terminal') return;
  const data = t.data as { kind?: string; serverId?: string };
  if (data.kind === 'ssh' && data.serverId) {
    setWorkarea({ serverId: data.serverId, name: String(t.title || '服务器') });
  } else {
    setWorkarea({ serverId: null, name: '本地终端' });
  }
}

function onChipRowClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const chip = target.closest('.ai-snap-chip') as HTMLElement | null;
  if (!chip) return;
  if (chip.dataset.kind === 'workarea') return; // 固定工作区域标签不可移除
  if (target.closest('.ai-chip-x')) {
    if (chip.dataset.kind === 'server') serverRefs.delete(chip.dataset.id ?? '');
    else if (chip.dataset.kind === 'path') pathRefs.delete(chip.dataset.id ?? '');
    chip.remove();
    return;
  }
  if (chip.dataset.kind === 'server' || chip.dataset.kind === 'path') return; // 服务器/路径引用无详情弹窗
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
async function send(): Promise<void> {
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
  const srefs: ServerRef[] = [];
  const prefs: PathRef[] = [];
  // 固定工作区域引用最先（开启自动切换时）；发送时作为当前目标上下文说明
  if (autoSwitchAiWorkdir && workareaRef) srefs.push(workareaRef);
  chipRow.querySelectorAll('.ai-snap-chip').forEach((c) => {
    const el = c as HTMLElement;
    const id = el.dataset.id ?? '';
    const kind = el.dataset.kind ?? '';
    if (kind === 'file') {
      const r = fileRefs.get(id);
      if (r) refs.push(r);
    } else if (kind === 'term') {
      const sn = snapshots.get(id);
      if (sn) snaps.push(sn);
    } else if (kind === 'server') {
      const r = serverRefs.get(id);
      if (r) srefs.push(r);
    } else if (kind === 'path') {
      const p = pathRefs.get(id);
      if (p) prefs.push(p);
    }
  });
  if (!text && snaps.length === 0 && refs.length === 0 && srefs.length === 0 && prefs.length === 0) return;

  // 首条用户消息决定会话标题
  if (s.messages.length === 0) s.title = text.slice(0, 20) || (srefs.length || prefs.length ? '引用' : '文件引用');

  s.messages.push({ role: 'user', content: text, snapshots: snaps, fileRefs: refs, serverRefs: srefs, pathRefs: prefs, actions: [], ts: Date.now() });
  input.value = '';
  autoGrow();
  clearChips();
  pendingBy.set(sid, emptyPending());
  renderSessionBar();
  renderHistory();
  updateSendBtn();
  persistSession(s);

  // 提交给 ai_chat 的 prompt = 用户文本 + 快照/文件引用全文 + 服务器/路径引用说明（UI 气泡只显示 chip）
  const prompt = await buildPrompt(text, snaps, refs, srefs, prefs);
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

/**
 * 组装发给 pi 的 prompt：用户文本 + 快照/文件引用全文 + 服务器/路径引用说明。
 * 固定工作区域（开启自动切换时 srefs[0]）作为「当前工作区域」上下文说明，
 * 远程引用附 user@host:port 便于 AI 选择命令目标（后端 run_command 的 target 由 AI 工具参数决定）；
 * 路径引用只带完整路径不带文件内容。
 */
async function buildPrompt(text: string, snaps: TermSnapshot[], refs: FileRef[], srefs: ServerRef[], prefs: PathRef[]): Promise<string> {
  let servers: Server[] = [];
  try {
    servers = (await getState()).servers;
  } catch {
    /* 后端未就绪时仅用名称 */
  }
  /** 远程引用说明：名称 (user@host:port)；服务器已删除时回退为名称 */
  const remoteText = (r: ServerRef): string => {
    const sv = servers.find((s) => s.id === r.serverId);
    if (!sv) return `[引用服务器: ${r.name}]`;
    return `[引用服务器: ${sv.name} (${sv.username}@${sv.host}:${sv.port})]`;
  };
  const parts: string[] = [];
  if (autoSwitchAiWorkdir && workareaRef && srefs[0] === workareaRef) {
    // 固定工作区域：作为当前目标上下文说明
    const wr: ServerRef = workareaRef; // 具名 const：IIFE 闭包内保持收窄
    parts.push(
      wr.serverId === null
        ? '[当前工作区域: 本地]'
        : (() => {
            const sv = servers.find((s) => s.id === wr.serverId);
            return sv
              ? `[当前工作区域: 服务器 ${sv.name} (${sv.username}@${sv.host}:${sv.port})]`
              : `[当前工作区域: ${wr.name}]`;
          })(),
    );
  }
  for (const r of srefs) {
    if (r === workareaRef) continue; // 工作区域已作为上下文说明，避免重复
    parts.push(r.serverId === null ? '[引用: 本地终端]' : remoteText(r));
  }
  const refText = parts.map((p) => `\n\n${p}`).join('');
  return text
    + snaps.map((sn) => `\n\n[终端快照 命令: ${sn.command}]\n${sn.content.slice(0, 4000)}`).join('')
    + refs.map((r) => `\n\n[文件引用 ${r.path} 第${r.startLine}-${r.endLine}行]\n${r.content.slice(0, 4000)}`).join('')
    + prefs.map((p) => `\n\n[${p.isDir ? '引用目录' : '引用文件'}: ${p.path}]`).join('')
    + refText;
}

/* ---------- 事件绑定 ---------- */
/** AI 面板 Ctrl+C 策略（capture 阶段）：
 *  1) 输入框有选区 → 不拦截，交给浏览器默认复制；
 *  2) 消息区有选中文本 → 显式复制（WebView 对非编辑区选中文本的默认复制不可靠，走 copyText 封装）；
 *  3) 输入框为空且当前标签为终端 → 转发 ^C 给终端（中断正在运行的程序），避免误吞 Ctrl+C。 */
function onPanelKeydown(e: KeyboardEvent): void {
  if (e.key !== 'c' && e.key !== 'C') return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  // 输入框有选区：默认复制行为即可
  if (input.selectionStart !== input.selectionEnd) return;
  const sel = window.getSelection();
  const selText = sel ? sel.toString() : '';
  if (selText) {
    e.preventDefault();
    e.stopPropagation();
    void copyText(selText);
    return;
  }
  // 输入框为空且终端是当前 tab：转发 ^C 给终端
  if (input.value === '') {
    const active = getActiveTab();
    if (active && active.type === 'terminal' && active.api) {
      e.preventDefault();
      e.stopPropagation();
      (active.api as TerminalApi).ctrlC();
    }
  }
}

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
