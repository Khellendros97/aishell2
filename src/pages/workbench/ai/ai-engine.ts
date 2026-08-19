/**
 * AI 助手面板引擎（React 迁移：命令式引擎 + 薄壳，由 AiPanel.tsx 挂载/清理）。
 * 对照 legacy/pages/workbench/ai.ts 逐行移植，逻辑/交互/DOM 类名/文案逐条一致
 * （.proto/workbench-ai.js 为交互规格；mock 回复换成 pi 子进程流式事件
 * ai:event:<key>，见 src/api.ts）。挂载时写 wbHandles.ai = { addSnapshot, addFileRef,
 * addServerRef, addPathRef, addBrowserRef, currentSessionId }，清理时置 null 并 aiKillProject 清理该项目
 * pi 进程。
 * 基础工具远程化：actionStart 的 args 携带 serverId 表示远程 write/edit/delete_path（guard
 * 覆盖版工具经动作桥执行，见 aishell-guard.ts）；这类动作完成后额外广播 staging-changed
 * （远程写入/删除已进会话暂存自动备份），且不发 fs:changed（后端已按 serverId 跳过）。
 * 数据库连接申请（request_db_connection）：approval 事件携带 connection 字段 → 插入审批卡片
 * （只读展示 AI 填写的连接信息）→ 点【审批】打开审批对话框（./AiDbApproval，用户只填密码 +
 * 勾查询权限）→ 通过先 saveDbConnection 落库再 aiRespondDbRequest 回执 connectionId；
 * 关闭对话框不回执，卡片可重开。
 * 输入区 chip 五类引用：终端快照 @terminal_<id>、文件引用 @文件名_起_止、服务器/本地终端
 * 引用 @remote:服务器名称 / @local、文件/目录路径引用 @file:文件名 / @path:目录名、
 * 浏览器元素引用 @browser:#id 或标签名（发送时展开为说明文本/元素 HTML 拼进 prompt）；
 * Settings.autoSwitchAiWorkdir 开启时输入区固定显示
 * 工作区域标签，随激活终端自动切换并作为当前目标上下文带入。
 * AI 回复中的链接：普通点击在内置浏览器标签页打开（browser_navigate + openTab('browser')），
 * Ctrl/Shift+点击仍走系统浏览器（openUrl）。
 *
 * React 差异（语义对齐 legacy，对照 stores/workbench.ts）：
 * - 旧 bus 'tab-activated' → useWorkbench.subscribe 按 activeId 变化推导（激活标签变化时
 *   以 getActiveTab(state) 回调，与 legacy 传激活 Tab 同语义），清理函数退订；
 * - 旧 bus 'staging-changed' → wbEvents.on/emit；
 * - Workbench.state.project → useWorkbench.getState().project；Workbench.ai → wbHandles.ai；
 * - openTab / activateTab / getActiveTab / getTabs → useWorkbench.getState().* 对应方法；
 * - 旧 Tab.api 字段（openTab 返回的渲染器句柄）→ tabApis 注册表（tabApis.get(tab.id)）；
 * - MutationObserver 容器移除守卫删除：React keep-alive 常驻挂载，卸载由 useEffect cleanup
 *   调 mountAiPanel 返回的清理函数完成；
 * - mountAiPanel(container) 返回清理函数（原为 void，靠 observer 触发 cleanup）。
 * 瞬时错误自动重试：pi 默认对限流/过载瞬时错误自动重试，失败尝试的错误气泡会被重试
 * 恢复的流式内容取代（delta 分支复活错误 pending）；重试以「自动重试」瞬时工具行提示，
 * 回合结束仍会收到 done（ai.rs 在 delta 恢复时重置终态抑制）。停止键不等后端事件，
 * 本地立即定稿（leaveSession 同语义），任何终止事件丢失都不会卡死输入区。
 * 流式渲染性能（曾因每个 delta 全量重建聊天区导致长对话整机卡顿）：delta 事件 rAF
 *   合帧（schedulePendingRender），一帧至多增量更新一次流式气泡，历史节点不动；低频
 *   事件（工具/审批/done）走 refreshActive 增量追加新消息节点；气泡内文本段按锚点
 *   偏移缓存（segCache，段完成即命中）、段内 ``` 围栏 parts 前缀缓存（fixedParts，
 *   每帧只重渲最后一个 part）、动作卡 DOM 按 toolCallId 复用（cardEls，低频事件重建
 *   气泡时作废）。渲染产出与全量 innerHTML 版逐节点一致（同一 renderAI/renderActionCard）。
 *
 * 与后端的接口点（src/api.ts）：sessions_get / session_upsert / ai_chat / ai_abort /
 *   ai_kill_project / ai_set_thinking / ai_respond_approval / ai_respond_db_request /
 *   ai_debug_info / set_ai_mode / get_state / save_settings / save_db_connection /
 *   staging_list，事件 on_ai_event（ai:event:<key>）。
 */
import type { UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import MarkdownIt from 'markdown-it';
import type { AiActionRecord, AiMode, AppState, BrowserRef, ChatMsg, ChatSession, FileRef, LlmConfig, PathRef, Project, Server, ServerRef, SkillRef, TermSnapshot } from '../../../types';
import { icon } from '../../../icons';
import {
  aiAbort, aiChat, aiDebugInfo, aiKillProject, aiRespondApproval, aiRespondDbRequest, aiSetThinking, browserEnsure, browserNavigate, getState, onAiEvent, saveDbConnection, saveSettings,
  sessionUpsert, sessionsGet, setAiMode, stagingList,
  type AiEvent,
} from '../../../api';
import { getActiveTab, getActiveTerminalApi, tabApis, useWorkbench, wbEvents, wbHandles, type Tab, type TerminalApi } from '../../../stores/workbench';
import { addQuickCommandModal } from '../tabs/useTerminal';
import { hideProgress } from '../statusbar-progress';
import { confirmDialog, copyText, showContextMenu, toast, uid } from '../../../ui';
import { openAiDbApprovalModal, type DbRequestDetail } from './AiDbApproval';
import { DB_DEFAULT_PORTS, DB_KIND_LABEL } from '../db';

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
#ai-staging-notice {
  min-height: 30px;
  margin: 0 10px 8px;
  padding: 5px 9px;
  display: none;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-2);
  color: var(--text-1);
  font-size: 11.5px;
  cursor: pointer;
  text-align: left;
  transition: border-color .12s, background .12s, color .12s;
}
#ai-staging-notice.visible { display: flex; }
#ai-staging-notice:hover { border-color: var(--accent); background: var(--accent-dim); color: var(--text-0); }
#ai-staging-notice .ic { flex: none; color: var(--accent); }
#ai-staging-notice .ai-staging-link { margin-left: auto; color: var(--accent); }
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
.ai-action-impact-warn { color: var(--yellow); display: inline-flex; align-items: flex-start; gap: 4px; }
.ai-action-impact-warn svg { flex: none; width: 12px; height: 12px; margin-top: 2px; }
.ai-action-impact-ok { color: var(--green); }
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
/* 数据库连接申请审批对话框（AiDbApproval.tsx） */
.db-approval-tip {
  display: flex; align-items: center; gap: 6px;
  margin-bottom: 12px; padding: 8px 10px;
  border: 1px solid var(--border); border-radius: 8px;
  background: var(--bg-2); color: var(--text-0); font-size: 12.5px;
}
.db-approval-tip svg { flex: none; color: var(--accent); }
.db-approval-warn {
  display: flex; align-items: flex-start; gap: 6px;
  margin-top: 10px; font-size: 11.5px; color: var(--yellow); line-height: 1.5;
}
.db-approval-warn svg { flex: none; width: 12px; height: 12px; margin-top: 2px; }
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
  /** 远程操作（基础工具 serverId 模式）：携带目标服务器 id；actionEnd 据此广播 staging-changed */
  serverId?: string;
  /** 审批事件携带的 requestId（批准/拒绝回执用） */
  requestId?: string;
  /** 数据库连接申请（request_db_connection）：AI 填写的连接信息，卡片只读展示、审批对话框复用 */
  dbRequest?: DbRequestDetail;
  /** 智能审批自动放行：status='smart' 时展示判定理由 */
  smartReason?: string;
  /** 影响计划（自动备份开启时审批事件携带）：unbounded 卡片展示「不保证完整备份」 */
  impact?: { effect: 'none' | 'bounded' | 'unbounded'; changes: Array<{ operation: string; path: string; destination?: string | null }>; reason: string };
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
  staging_list: '查看暂存列表',
  staging_diff: '查看暂存 diff',
  staging_restore: '还原暂存文件',
  staging_add: '主动暂存文件',
  staging_clear: '清理无变更暂存',
  request_db_connection: '申请数据库连接',
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

/** 由 actionStart 的 args 计算动作意图（审批事件到达前占位；审批事件会覆盖）。
 *  基础工具远程化：args.serverId 存在时标注「远程/服务器」文案。 */
function argsIntent(tool: string, args: Record<string, unknown>): string {
  const server = typeof args.serverId === 'string' && args.serverId ? `（服务器 ${args.serverId}）` : '';
  const remote = args.serverId ? '远程' : '';
  switch (tool) {
    case 'write':
      return `写${remote}文件 ${String(args.path ?? '')}${server}`;
    case 'edit':
      return `编辑${remote}文件 ${String(args.path ?? '')}${server}`;
    case 'delete_path':
      return `删除${remote} ${String(args.path ?? '')}${server}`;
    case 'run_command':
      return String(args.intent ?? '');
    case 'sftp_upload': {
      const items = Array.isArray(args.items) ? args.items : [];
      if (items.length > 0) {
        const first = (items[0] ?? {}) as Record<string, unknown>;
        const overwrite = items.some((item) => (item as Record<string, unknown>)?.overwrite === true);
        return `批量上传 ${items.length} 项${first.localPath ? `（首项：${String(first.localPath)}）` : ''} 到 ${String(first.remoteDir ?? '')}${overwrite ? '（含覆盖项）' : ''}${server}`;
      }
      return `上传 ${String(args.localPath ?? '')} 到 ${String(args.remoteDir ?? '')}${args.overwrite ? '（覆盖同名）' : ''}${server}`;
    }
    case 'sftp_download': {
      const items = Array.isArray(args.items) ? args.items : [];
      if (items.length > 0) {
        const first = (items[0] ?? {}) as Record<string, unknown>;
        return `批量下载 ${items.length} 项${first.remotePath ? `（首项：${String(first.remotePath)}）` : ''} 到 ${String(first.localDir ?? '')}${server}`;
      }
      return `下载 ${String(args.remotePath ?? '')} 到 ${String(args.localDir ?? '')}${server}`;
    }
    case 'staging_list':
      return '查看当前会话文件暂存列表';
    case 'staging_diff':
      return `查看暂存条目 diff（${String(args.entryId ?? '')}）`;
    case 'staging_restore':
      return `还原暂存条目（${String(args.entryId ?? '')}）`;
    case 'staging_add':
      return `主动暂存 ${String(args.remotePath ?? '')}（服务器 ${String(args.serverId ?? '')}）`;
    case 'staging_clear':
      return '清理暂存区无变更条目';
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
const browserRefs = new Map<string, BrowserRef>(); // 浏览器元素引用 key -> 引用（key = `${name}:${ts}`，@browser:名称 标签）
const skillRefs = new Map<string, SkillRef>(); // 技能引用 key -> 引用（key = `${origin}:${name}`，@skill:名称 标签）
/** 自动切换 AI 工作区域（Settings.autoSwitchAiWorkdir）：开启时输入区固定显示工作区域标签 */
let autoSwitchAiWorkdir = false;
/** 当前 AI 工作区域（默认本地；随激活终端/浏览器标签自动切换） */
let workareaRef: ServerRef | null = null;
/** 当前浏览器工作区域不使用服务器引用，单独记录以便发送时注入明确上下文。 */
let browserWorkarea = false;
/** 工作区域固定标签 DOM（不可移除；clearChips 清空后由 renderWorkareaChip 重建） */
let workareaChipEl: HTMLElement | null = null;
let activeSessionId = '';
let unlisten: UnlistenFn | null = null;
let unmounted = false;
/** AI 面板根容器（Ctrl+C 键盘策略监听用，卸载时移除） */
let panelRoot: HTMLElement | null = null;
let stagingNotice: HTMLButtonElement;
let offStagingChanged: (() => void) | null = null;
/** store activeId 变化订阅（原 bus 'tab-activated'，清理时退订） */
let offTabActivated: (() => void) | null = null;
let stagingRefreshVersion = 0;

/* ---------- 流式渲染增量缓存（见文件头「流式渲染性能」说明） ---------- */
/** 已渲染历史消息节点（按消息下标缓存复用；消息只追加不插入，下标即稳定 key） */
let msgEls: HTMLElement[] = [];
/** 当前流式气泡元素（帧渲染整体替换，内部节点经缓存复用） */
let pendingEl: HTMLElement | null = null;
/** delta 合帧调度句柄（null = 无挂起帧；低频同步渲染前取消，避免旧帧覆盖新状态） */
let rafId: number | null = null;
/** 锚点段渲染缓存：段起始偏移 -> 段原文与顶级节点（段内容不变直接 append 复用，不入 DOM 解析） */
const segCache = new Map<number, { text: string; nodes: HTMLElement[] }>();
/** 活跃段内已定型 parts（``` 围栏闭合/新块开启后不再变）的渲染缓存，跨帧复用 */
let fixedParts: Array<{ kind: string; lang: string; body: string; nodes: HTMLElement[] }> = [];
/** 动作卡 DOM 缓存（toolCallId -> 元素）：delta 帧渲染间卡状态不变；低频事件重建气泡时作废 */
const cardEls = new Map<string, HTMLElement>();

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
export function mountAiPanel(container: HTMLElement): () => void {
  project = useWorkbench.getState().project;
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
  browserRefs.clear();
  skillRefs.clear();
  autoSwitchAiWorkdir = false;
  workareaRef = null;
  browserWorkarea = false;
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
    <button id="ai-staging-notice" type="button">
      ${icon('diff')} <span data-ai-staging-text>已暂存 0 个文件修改，点击查看</span><span class="ai-staging-link">${icon('chevronRight')}</span>
    </button>
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
  stagingNotice = el('staging-notice') as HTMLButtonElement;
  modeSelect.value = project?.aiMode ?? 'suggest';

  wbHandles.ai = aiHandle;

  /* 自动切换 AI 工作区域：激活终端标签（含新开终端）时跟随切换。
     legacy 由 bus 'tab-activated' 广播（activeId 变化时发激活 Tab），
     这里订阅 store 状态按 activeId 变化推导，语义一致；AI 面板页级常驻（每页只挂一次），
     unmounted 守卫 + container.isConnected 守卫兜底 */
  offTabActivated = useWorkbench.subscribe((s, prev) => {
    if (s.activeId === prev.activeId) return;
    if (unmounted || !container.isConnected) return;
    if (autoSwitchAiWorkdir) updateWorkareaFromTab(getActiveTab(s));
  });

  offStagingChanged = wbEvents.on('staging-changed', () => {
    if (!unmounted && container.isConnected) void refreshStagingNotice();
  });

  // pi 运行时诊断输出到控制台（F12 可查），便于排查安装版「pi 运行时不存在」
  void aiDebugInfo().then((info) => console.log('[AI] pi 运行时诊断:\n' + info));

  bindEvents();
  panelRoot = container;
  container.addEventListener('keydown', onPanelKeydown, true);
  void loadSessions();
  void loadEffort();
  void refreshStagingNotice();
  return cleanup;
}

function cleanup(): void {
  if (unmounted) return;
  unmounted = true;
  cancelPendingRender();
  pendingEl = null;
  msgEls = [];
  segCache.clear();
  fixedParts = [];
  cardEls.clear();
  if (panelRoot) { panelRoot.removeEventListener('keydown', onPanelKeydown, true); panelRoot = null; }
  if (unlisten) { unlisten(); unlisten = null; }
  if (offStagingChanged) { offStagingChanged(); offStagingChanged = null; }
  if (offTabActivated) { offTabActivated(); offTabActivated = null; }
  if (wbHandles.ai === aiHandle) wbHandles.ai = null;
  if (project) void aiKillProject(project.id).catch(() => { /* 进程清理失败可忽略 */ });
}

/* ---------- wbHandles.ai 句柄（终端模块添加快照 / 服务器引用 / 路径引用） ---------- */
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
  /** 文件/目录路径引用（@file:文件名 / @path:目录名 标签，发送时只带路径不带内容；
   *   serverId 为远端 SFTP 引用，key 带服务器前缀与本地同路径引用区分）；重复添加时提示 */
  addPathRef(ref: PathRef): void {
    if (!ref || typeof ref.path !== 'string' || !ref.path.trim()) return;
    const key = pathRefKey(ref);
    if (pathRefs.has(key)) {
      toast('该引用已在输入框中');
      return;
    }
    pathRefs.set(key, ref);
    addPathRefChip(ref, key);
  },
  /** 浏览器元素引用（@browser:#id 或标签名 标签，发送时展开页面信息 + 元素 HTML）；
   *  同名元素（如多个 button）允许重复添加——chip 各自携带完整快照数据 */
  addBrowserRef(ref: BrowserRef): void {
    if (!ref || (!ref.name && !ref.tagName)) return;
    const key = `${ref.name || ref.tagName}:${ref.ts}`;
    browserRefs.set(key, ref);
    addBrowserRefChip(ref, key);
  },
  /** 技能引用（@skill:名称 标签，发送时展开名/来源/scope/描述，AI 可循此读取技能文件）；重复添加时提示 */
  addSkillRef(ref: SkillRef): void {
    if (!ref || typeof ref.name !== 'string' || !ref.name.trim()) return;
    const key = skillRefKey(ref);
    if (skillRefs.has(key)) {
      toast('该引用已在输入框中');
      return;
    }
    skillRefs.set(key, ref);
    addSkillRefChip(ref, key);
  },
  currentSessionId(): string | null {
    return activeSessionId || null;
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
function openCurrentStaging(): void {
  const pid = project?.id;
  const sid = activeSessionId;
  if (!pid || !sid) return;
  useWorkbench.getState().openTab({
    id: `staging:${pid}:${sid}`,
    type: 'remote-staging',
    title: '文件暂存区',
    data: { projectId: pid, sessionId: sid },
  });
}

async function refreshStagingNotice(): Promise<void> {
  const pid = project?.id;
  const sid = activeSessionId;
  const version = ++stagingRefreshVersion;
  if (!pid || !sid) {
    stagingNotice.classList.remove('visible');
    return;
  }
  try {
    const entries = await stagingList(pid, sid);
    if (version !== stagingRefreshVersion || sid !== activeSessionId) return;
    const text = stagingNotice.querySelector('[data-ai-staging-text]') as HTMLElement;
    text.textContent = `已暂存 ${entries.length} 个文件修改，点击查看`;
    stagingNotice.classList.toggle('visible', entries.length > 0);
  } catch {
    if (version === stagingRefreshVersion) stagingNotice.classList.remove('visible');
  }
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
  void refreshStagingNotice();
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
  // 开启自动切换时：初始工作区域默认本地；已有激活标签则跟随终端或浏览器
  if (autoSwitchAiWorkdir) {
    const active = getActiveTab(useWorkbench.getState());
    if (active) updateWorkareaFromTab(active);
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
    /* 瞬时错误（限流/过载）后 pi 自动重试成功、增量恢复：复用当前 pending（可能是
       错误相）转回流式，错误气泡被内容取代；后端 delta 恢复时已重置终态抑制，
       回合结束仍会收到 done（见 ai.rs 读取线程 text_delta 分支） */
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
      serverId: typeof ev.args.serverId === 'string' && ev.args.serverId ? ev.args.serverId : existing?.serverId,
      requestId: existing?.requestId,
      impact: existing?.impact,
      status: project?.aiMode === 'agent' ? 'approving' : 'running',
      textLen: existing?.textLen ?? p.text.length,
    });
    pendingBy.set(sid, p);
  } else if (ev.type === 'approval') {
    /* AI 申请切换到工作模式（suggest 模式的 request_agent_mode 工具）：弹确认框，
       不进动作卡；其余仍为 Agent 逐调用审批卡 */
    if (ev.action === 'request_agent_mode') {
      void handleModeRequest(sid, ev);
    } else if (ev.action === 'request_db_connection') {
      /* AI 申请数据库连接：插入审批卡片（带 AI 填写的连接信息，只读展示），
         点【审批】打开审批对话框（见 openDbApproval）；关闭对话框不回执、可重开 */
      const cur = pendingBy.get(sid) ?? null;
      const p = cur ?? emptyPending();
      const existing = p.actions.get(ev.toolCallId);
      p.actions.set(ev.toolCallId, {
        toolCallId: ev.toolCallId,
        tool: 'request_db_connection',
        intent: ev.intent || existing?.intent || '',
        summary: ev.summary || existing?.summary || '',
        dbRequest: ev.connection,
        requestId: ev.requestId,
        status: 'approving',
        textLen: existing?.textLen ?? p.text.length,
      });
      pendingBy.set(sid, p);
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
        impact: ev.impact,
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
        impact: ev.impact,
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
    /* 远程写入与暂存工具完成 → 广播刷新暂存面板、diff 标签和输入区计数。
       本地 write/edit 不改远程文件，不触发（后端对远程 write/edit 不发 fs:changed，
       本地文件刷新走 fs:changed 事件，见 editor.ts）。 */
    const isRemoteFileOp = ['write', 'edit', 'delete_path'].includes(ev.tool) && !!existing?.serverId;
    if (ev.tool === 'run_command' || ev.tool === 'sftp_upload'
      || ev.tool === 'staging_restore' || ev.tool === 'staging_list' || ev.tool === 'staging_diff'
      || ev.tool === 'staging_add' || ev.tool === 'staging_clear'
      || isRemoteFileOp) {
      wbEvents.emit('staging-changed');
    }
    /* AI 目录暂存 / 清理结束（成功/失败）→ 收起底边栏进度（staging:progress 事件驱动显示，done 事件也会自动移除） */
    if (ev.tool === 'staging_add' || ev.tool === 'staging_clear') hideProgress(`staging:${project?.id ?? ''}:${sid}`);
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
    /* 保留本回合已积累的文本/工具行/动作卡：瞬时错误后 pi 自动重试成功时，后续 delta
       会把错误气泡复活为流式（见 delta 分支），回合现场与动作卡审计（collectActions）
       不应随错误气泡清空 */
    const cur = pendingBy.get(sid) ?? null;
    pendingBy.set(sid, {
      phase: 'error',
      text: cur?.phase === 'stream' ? cur.text : '',
      error: ev.message,
      tools: cur?.tools ?? [],
      actions: cur?.actions ?? new Map(),
    });
  }
  if (sid === activeSessionId) {
    /* delta 高频到达（每秒数十条）：rAF 合帧只增量更新流式气泡，历史节点不动；
       其余事件低频，同步增量渲染（含 finalize 后追加定稿消息） */
    if (ev.type === 'delta') schedulePendingRender();
    else refreshActive();
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
    browserRefs: [],
    skillRefs: [],
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
        browserRefs: [],
        skillRefs: [],
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
  /* 全量重建（挂载/切会话/发送等低频路径）：重置全部增量缓存，
     msgEls/pendingEl 重新登记（高频流式路径见 schedulePendingRender/refreshActive） */
  cancelPendingRender();
  chat.innerHTML = '';
  msgEls = [];
  segCache.clear();
  fixedParts = [];
  cardEls.clear();
  const s = sessions.get(activeSessionId);
  if (s) {
    s.messages.forEach((m) => {
      const el = renderMessage(m, activeSessionId);
      msgEls.push(el);
      chat.appendChild(el);
    });
  }
  pendingEl = null;
  const pend = pendingBy.get(activeSessionId) ?? null;
  if (pend) replacePending(renderPending(pend));
  scrollBottom();
}

/** 取消挂起的流式帧渲染（低频同步渲染/全量重建前调用，避免旧帧覆盖新状态） */
function cancelPendingRender(): void {
  if (rafId != null) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

/** delta 高频路径：rAF 合帧，一帧至多渲染一次流式气泡（历史节点不动；
 *  窗口最小化等 rAF 暂停场景由 done 事件的同步渲染兜底最终状态） */
function schedulePendingRender(): void {
  if (rafId != null) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    if (unmounted || !chat.isConnected) return;
    renderPendingBubble();
    scrollBottom();
    updateSendBtn();
  });
}

/** 低频事件（工具/审批/分段/done/error）同步渲染：只追加新历史消息节点（finalize 定稿
 *  push 的消息）+ 重建流式气泡，不再全量重建整个聊天区；历史节点跨渲染复用。 */
function refreshActive(): void {
  cancelPendingRender();
  const s = sessions.get(activeSessionId);
  if (s) {
    while (msgEls.length < s.messages.length) {
      const m = s.messages[msgEls.length];
      const el = renderMessage(m, activeSessionId);
      msgEls.push(el);
      chat.insertBefore(el, pendingEl); // pendingEl 为 null 时等价 appendChild
    }
  }
  /* 卡片状态可能已变（批准/执行/终态）：卡 DOM 缓存作废；文本段缓存保留
     （低频事件不改文本内容，段校验失败也会自动全量重渲兜底） */
  cardEls.clear();
  const pend = pendingBy.get(activeSessionId) ?? null;
  if (pend) replacePending(renderPending(pend));
  else if (pendingEl) {
    pendingEl.remove();
    pendingEl = null;
  }
  scrollBottom();
  updateSendBtn();
}

/** 替换/追加当前流式气泡节点 */
function replacePending(el: HTMLElement): void {
  if (pendingEl) pendingEl.replaceWith(el);
  else chat.appendChild(el);
  pendingEl = el;
}

/** 流式气泡渲染（rAF 帧路径）：stream 有文本走增量组装（段/卡缓存），其余相位
 *  （typing/error/尚无文本）无高频变化，直接复用 innerHTML 全量版 renderPending。 */
function renderPendingBubble(): void {
  const p = pendingBy.get(activeSessionId) ?? null;
  if (!p) {
    if (pendingEl) {
      pendingEl.remove();
      pendingEl = null;
    }
    return;
  }
  if (p.phase !== 'stream' || !p.text) {
    replacePending(renderPending(p));
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg ai';
  const bubble = document.createElement('div');
  bubble.className = 'ai-bubble';
  for (const t of p.tools) {
    const line = document.createElement('div');
    line.className = 'ai-tool-line';
    line.innerHTML = `${icon('wrench')}${escapeHtml(t)}`;
    bubble.appendChild(line);
  }
  const textEl = document.createElement('div');
  textEl.className = 'ai-text';
  appendStreamBody(textEl, p);
  bubble.appendChild(textEl);
  wrap.appendChild(bubble);
  replacePending(wrap);
}

/** 流式体增量组装（语义与 interleaveActions 字符串版逐条对齐）：锚点卡按 textLen 升序
 *  穿插文本段，无锚点卡排文本末尾；全部卡无锚点时整组前置（与原 renderPending 一致）。
 *  文本段经 appendSegNodes 复用缓存节点，卡片经 reuseCard 复用 DOM（append 移动）。 */
function appendStreamBody(container: HTMLElement, p: Pending): void {
  const cards = [...p.actions.values()];
  const anchored = cards.some((c) => c.textLen != null);
  if (!anchored) {
    cards.forEach((c) => container.appendChild(reuseCard(c)));
    if (p.text) appendSegNodes(container, p.text, 0);
    return;
  }
  const sorted = cards.slice().sort((a, b) => (a.textLen ?? Infinity) - (b.textLen ?? Infinity));
  let last = 0;
  for (const c of sorted) {
    const at = Math.min(c.textLen ?? p.text.length, p.text.length);
    if (at > last) appendSegNodes(container, p.text.slice(last, at), last);
    container.appendChild(reuseCard(c));
    last = at;
  }
  if (last < p.text.length) appendSegNodes(container, p.text.slice(last), last);
}

/** 动作卡 DOM 复用：delta 帧渲染间卡状态不变，直接移动已有节点（低频事件重建
 *  气泡时 cardEls 已清空，此处按需重建） */
function reuseCard(a: ActionCard): HTMLElement {
  let el = cardEls.get(a.toolCallId);
  if (!el) {
    const t = document.createElement('template');
    t.innerHTML = renderActionCard(a);
    el = t.content.firstElementChild as HTMLElement;
    cardEls.set(a.toolCallId, el);
  }
  return el;
}

/** 锚点段渲染入容器：段内容未变直接复用缓存节点（append 移动，零解析）；
 *  变化（尾段增长/锚点截断）则重渲并更新缓存 */
function appendSegNodes(container: HTMLElement, segText: string, segStart: number): void {
  const cached = segCache.get(segStart);
  if (cached && cached.text === segText) {
    cached.nodes.forEach((n) => container.appendChild(n));
    return;
  }
  const nodes = renderSegNodes(segText);
  segCache.set(segStart, { text: segText, nodes });
  nodes.forEach((n) => container.appendChild(n));
}

/** 活跃段渲染（parts 前缀缓存）：``` 围栏闭合或新块开启后，之前的 parts 不再变化，
 *  渲染结果与原文一起缓存（fixedParts），每帧只重切分 + 重渲最后一个 part。
 *  前缀不匹配（段回退/锚点截断等罕见场景）时全量重渲并重建缓存，保证正确性。 */
function renderSegNodes(segText: string): HTMLElement[] {
  const parts = splitAI(segText);
  let fixed = fixedParts;
  if (fixed.length > Math.max(parts.length - 1, 0)) fixed = [];
  for (let i = 0; i < fixed.length; i++) {
    const f = fixed[i];
    const cur = parts[i];
    if (f.kind !== cur.kind || f.lang !== cur.lang || f.body !== cur.body) {
      fixed = fixed.slice(0, i);
      break;
    }
  }
  const nodes: HTMLElement[] = [];
  /* 校验通过的已定型 parts 节点直接复用（append 移动进本帧容器）——
     此前遗漏此步导致围栏闭合后其之前的定型段从下一帧起消失 */
  fixed.forEach((f) => nodes.push(...f.nodes));
  const newFixed = fixed.slice();
  for (let i = fixed.length; i < parts.length - 1; i++) {
    const part = parts[i];
    const partNodes = htmlToNodes(renderPart(part));
    newFixed.push({ ...part, nodes: partNodes });
    nodes.push(...partNodes);
  }
  fixedParts = newFixed;
  if (parts.length > 0) nodes.push(...htmlToNodes(renderPart(parts[parts.length - 1])));
  return nodes;
}

/** html 字符串 → 顶级元素数组（段/part 渲染结果转 DOM 节点，供跨帧复用） */
function htmlToNodes(html: string): HTMLElement[] {
  const t = document.createElement('template');
  t.innerHTML = html;
  const els: HTMLElement[] = [];
  t.content.childNodes.forEach((n) => {
    if (n.nodeType === Node.ELEMENT_NODE) els.push(n as HTMLElement);
  });
  return els;
}

/** 动作卡渲染：Agent 审批态带批准/拒绝按钮；执行中/终态/历史只读无按钮。
 *  历史一串动作卡的折叠由 renderActionGroup 整组负责，单卡不再单独折叠。 */
function renderActionCard(a: ActionCard): string {
  if (a.dbRequest) return renderDbRequestCard(a);
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
  const impactHtml = a.impact
    ? a.impact.effect === 'unbounded'
      ? `<div class="ai-action-intent ai-action-impact-warn">${icon('alert')} 影响范围无法完整确定，不保证完整备份：${escapeHtml(a.impact.reason)}</div>`
      : a.impact.effect === 'bounded'
        ? `<div class="ai-action-intent ai-action-impact-ok">将自动备份 ${a.impact.changes.length} 个文件</div>`
        : ''
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
      ${impactHtml}
      ${smartHtml}
      ${buttons}
      ${resultHtml}
    </div>
  </div>`;
}

/** 数据库连接申请卡（request_db_connection）：AI 提交连接信息，approving 时显示【审批】按钮
 *  打开审批对话框（openDbApproval）；关闭对话框不回执，卡片保持待批可重开。 */
function renderDbRequestCard(a: ActionCard): string {
  const d = a.dbRequest!;
  const dbName = d.database || d.name || '未知数据库';
  const port = d.port ?? DB_DEFAULT_PORTS[d.kind];
  const kindLabel = DB_KIND_LABEL[d.kind] ?? d.kind;
  const statusText = ACTION_STATUS[a.status] ?? a.status;
  const cls = a.status === 'succeeded' || a.status === 'failed' || a.status === 'rejected' ? a.status : '';
  const approveBtn = a.status === 'approving' && a.requestId
    ? `<div class="ai-action-actions">
        <button class="btn small primary" type="button" data-act-db-approve="${escapeHtml(a.toolCallId)}">审批</button>
      </div>`
    : '';
  const resultHtml = a.result && a.status === 'succeeded'
    ? `<div class="ai-action-result">${escapeHtml(a.result)}</div>`
    : '';
  return `<div class="ai-action-card ${cls}">
    <div class="ai-action-head">
      <span class="ai-action-name">${icon('database')} ${ACTION_NAMES[a.tool] ?? a.tool}</span>
      <span class="ai-action-status">${statusText}</span>
    </div>
    <div class="ai-action-detail">
      <div class="ai-action-intent">AI 助手想要申请访问数据库 <b>${escapeHtml(dbName)}</b> 的权限</div>
      <div class="ai-action-intent ai-action-summary">${kindLabel} · ${escapeHtml(d.host || '')}:${port}${d.user ? ' · 用户 ' + escapeHtml(d.user) : ''} · 服务器 ${escapeHtml(d.serverId || '')}</div>
      ${a.summary ? `<div class="ai-action-intent">申请理由：${escapeHtml(a.summary)}</div>` : ''}
      ${approveBtn}
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
    (m.browserRefs ?? []).forEach((r) => browserRefs.set(`${r.name}:${r.ts}`, r));
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
        return `<span class="tag blue ai-msg-chip" data-snap-id="${escapeHtml(pathRefKey(r))}" data-kind="path" title="引用路径${r.serverId ? `（服务器 ${escapeHtml(r.serverId)}）` : ''}">${escapeHtml(label)}</span>`;
      }),
      ...(m.browserRefs ?? []).map((r) =>
        `<span class="tag blue ai-msg-chip" data-snap-id="${escapeHtml(`${r.name}:${r.ts}`)}" data-kind="browser" title="点击查看元素引用（${escapeHtml(r.url)}）">@browser:${escapeHtml(r.name)}</span>`,
      ),
      ...(m.skillRefs ?? []).map((r) =>
        `<span class="tag blue ai-msg-chip" data-snap-id="${escapeHtml(skillRefKey(r))}" data-kind="skill" title="技能引用「${escapeHtml(r.name)}」（${r.origin === 'global' ? '全局' : '项目'}）">@skill:${escapeHtml(r.name)}</span>`,
      ),
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

/* fenced 块切分（renderAI 的解析步骤，流式增量渲染复用同一份逻辑保证产出一致）：
   ```command → 命令卡；```text → 文本卡；其余 → 代码块；围栏外 → 段落 */
function splitAI(text: string): Array<{ kind: string; lang: string; body: string }> {
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
  return parts;
}

function renderAI(text: string): string {
  return splitAI(text).map(renderPart).join('');
}

/** 文本建议是否可视为单条 URL（http/https/file 开头且无空白 → 可一键内置浏览器打开） */
function isSingleUrl(s: string): boolean {
  const t = s.trim();
  if (!t || /\s/.test(t)) return false;
  return /^(https?|file):\/\//i.test(t);
}

/** 在内置浏览器标签页打开地址（共享单实例:固定 id 去重激活） */
async function openUrlInBrowser(url: string): Promise<void> {
  try {
    await browserEnsure();
    await browserNavigate(url);
    useWorkbench.getState().openTab({ id: 'browser', type: 'browser', title: '浏览器' });
  } catch (err) {
    toast(`无法打开链接: ${String(err)}`, 'error');
  }
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
    case 'text': {
      const isUrl = isSingleUrl(p.body);
      return `<div class="ai-suggest text" data-action="copy" data-text="${escapeHtml(p.body)}" title="点击卡片复制到剪贴板">
        <div class="ai-suggest-head"><span class="ai-suggest-icon">${icon('message')}</span>
        <span class="ai-suggest-actions">
          ${isUrl ? `<button class="icon-btn ai-suggest-open" type="button" title="在内置浏览器中打开">${icon('globe')}</button>` : ''}
          <button class="icon-btn" type="button" title="复制到剪贴板">${icon('copy')}</button>
        </span></div>
        <span class="ai-suggest-main">${escapeHtml(p.body)}</span>
      </div>`;
    }
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
    browserRefs: [],
    skillRefs: [],
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

/** 数据库连接申请审批（request_db_connection）：从最新 state 解析目标服务器名称/锁定态，
 *  打开审批对话框。通过 → 保存连接（密码进 keyring，永不回显）后回执 connectionId，
 *  工具结果直接携带 connectionId，AI 立即可 db_query；拒绝 → 回执 approved:false。
 *  关闭对话框（X/遮罩/Esc）不产生任何回执——卡片保持「等待批准」，可再次点【审批】重开。 */
async function openDbApproval(sid: string, toolCallId: string): Promise<void> {
  if (!project) return;
  const p = pendingBy.get(sid) ?? null;
  const card = p?.actions.get(toolCallId);
  if (!p || !card || !card.requestId || !card.dbRequest) {
    toast('审批请求已过期', 'error');
    return;
  }
  const d = card.dbRequest;
  let serverName = d.serverId;
  let serverLocked = false;
  try {
    const st = await getState();
    const sv = st.servers.find((s) => s.id === d.serverId);
    if (sv) {
      serverName = sv.name;
      serverLocked = !!sv.locked;
    }
  } catch { /* 服务器信息读取失败时回退显示 serverId */ }
  const requestId = card.requestId;
  const key = `${project.id}:${sid}`;
  openAiDbApprovalModal({
    serverName,
    serverLocked,
    detail: d,
    onApprove: async (connection, password) => {
      // 先落库（配置 + keyring 密码），成功再回执 pi；失败弹窗保留可重试
      try {
        await saveDbConnection(d.serverId, connection, password);
      } catch (err) {
        toast(`保存数据库连接失败：${String(err)}`, 'error');
        return false;
      }
      try {
        await aiRespondDbRequest(key, requestId, { approved: true, connectionId: connection.id });
      } catch (err) {
        toast(`回复 AI 审批失败：${String(err)}`, 'error');
        return false;
      }
      card.status = 'succeeded';
      card.requestId = undefined;
      card.result = `已批准并保存数据库连接「${connection.name}」（connectionId=${connection.id}）`;
      if (sid === activeSessionId) {
        renderHistory();
        updateSendBtn();
      }
      toast(`已批准数据库连接「${connection.name}」，AI 可立即查询`, 'success');
      return true;
    },
    onReject: () => {
      aiRespondDbRequest(key, requestId, { approved: false })
        .then(() => {
          card.status = 'rejected';
          card.requestId = undefined;
          if (sid === activeSessionId) {
            renderHistory();
            updateSendBtn();
          }
          toast('已拒绝数据库连接申请', 'info');
        })
        .catch((err: unknown) => toast(`回复 AI 审批失败：${String(err)}`, 'error'));
    },
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
  /* 数据库连接申请卡【审批】按钮：打开审批对话框（关闭不回执，卡片保持待批） */
  const dbApproveBtn = target.closest('[data-act-db-approve]') as HTMLElement | null;
  if (dbApproveBtn) {
    void openDbApproval(activeSessionId, dbApproveBtn.dataset.actDbApprove ?? '');
    return;
  }
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
  /* Markdown 链接：普通点击在内置浏览器标签页打开（openUrlInBrowser）；Ctrl/Shift+点击走系统浏览器 */
  const link = target.closest('a[href]') as HTMLAnchorElement | null;
  if (link) {
    e.preventDefault();
    if (e.ctrlKey || e.shiftKey || e.metaKey) {
      void openUrl(link.href).catch((err) => toast(`无法打开链接: ${String(err)}`, 'error'));
      return;
    }
    void openUrlInBrowser(link.href);
    return;
  }
  /* 收藏按钮在命令卡片内部，优先于卡片的 paste 动作 */
  const fav = target.closest('.ai-qc-fav') as HTMLElement | null;
  if (fav) {
    const card = fav.closest('[data-action]') as HTMLElement | null;
    if (card) addQuickCommandModal(card.dataset.cmd ?? '');
    return;
  }
  /* 文本建议的「在内置浏览器中打开」按钮：只开浏览器，不触发卡片的复制动作 */
  const openBtn = target.closest('.ai-suggest-open') as HTMLElement | null;
  if (openBtn) {
    const card = openBtn.closest('[data-action]') as HTMLElement | null;
    if (card && card.dataset.text) {
      e.preventDefault();
      void openUrlInBrowser(card.dataset.text.trim());
    }
    return;
  }
  const card = target.closest('[data-action]') as HTMLElement | null;
  if (card) {
    if (card.dataset.action === 'paste') {
      const api = getActiveTerminalApi();
      if (api) {
        api.paste(card.dataset.cmd ?? '');
        // 目标终端标签未激活时先切换过去，再聚焦，保证「直接回车即可执行」
        const termTab = useWorkbench.getState().tabs.find((t) => t.type === 'terminal' && tabApis.get(t.id) === api);
        const active = getActiveTab(useWorkbench.getState());
        if (termTab && (!active || active.id !== termTab.id)) useWorkbench.getState().activateTab(termTab.id);
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
    if (chip.dataset.kind === 'server' || chip.dataset.kind === 'path') return; // 服务器/路径引用无详情弹窗
    if (chip.dataset.kind === 'file') openFileRefModal(fileRefs.get(id));
    else if (chip.dataset.kind === 'browser') openBrowserRefModal(browserRefs.get(id));
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

/** 文件/目录路径引用 key：远端引用带服务器前缀，本地引用仅路径（与本地 explorer 旧数据一致） */
function pathRefKey(r: PathRef): string {
  return r.serverId ? `${r.serverId}:${r.path}` : r.path;
}

/** 文件/目录路径引用 chip：标签只用路径最后一段（@file:文件名 / @path:目录名），title 带完整路径与服务器 */
function addPathRefChip(ref: PathRef, key: string): void {
  const name = ref.path.split('/').filter(Boolean).pop() || ref.path;
  const label = ref.isDir ? `@path:${name}` : `@file:${name}`;
  const c = document.createElement('span');
  c.className = 'tag blue ai-snap-chip';
  c.dataset.id = key;
  c.dataset.kind = 'path';
  c.title = `${ref.serverId ? `[服务器 ${ref.serverId}] ` : ''}${ref.path}，✕ 移除`;
  c.innerHTML = `${escapeHtml(label)}<span class="ai-chip-x" title="移除">${icon('x')}</span>`;
  chipRow.appendChild(c);
}

/** 浏览器元素引用 chip：@browser:#id 或标签名，title 带页面地址，点击查看元素详情 */
function addBrowserRefChip(ref: BrowserRef, key: string): void {
  const c = document.createElement('span');
  c.className = 'tag blue ai-snap-chip';
  c.dataset.id = key;
  c.dataset.kind = 'browser';
  c.title = `页面元素引用 ${ref.name}（${ref.url}），点击查看元素 HTML，✕ 移除`;
  c.innerHTML = `@browser:${escapeHtml(ref.name || ref.tagName)}<span class="ai-chip-x" title="移除">${icon('x')}</span>`;
  chipRow.appendChild(c);
}

/** 技能引用 key：来源 + 名称（全局/项目同名技能并存） */
function skillRefKey(r: SkillRef): string {
  return `${r.origin}:${r.name}`;
}

/** 技能引用 chip：@skill:名称，title 带来源与 scope，点击查看详情 */
function addSkillRefChip(ref: SkillRef, key: string): void {
  const c = document.createElement('span');
  c.className = 'tag blue ai-snap-chip';
  c.dataset.id = key;
  c.dataset.kind = 'skill';
  c.title = `技能引用「${ref.name}」（${ref.origin === 'global' ? '全局' : '项目'}），✕ 移除`;
  c.innerHTML = `@skill:${escapeHtml(ref.name)}<span class="ai-chip-x" title="移除">${icon('x')}</span>`;
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
  browserRefs.clear();
  skillRefs.clear();
  renderWorkareaChip(); // 固定工作区域标签不随发送清空，重新挂载
};

/** 固定工作区域标签（不可移除）：显示 @local / @remote:服务器名称，随激活终端自动切换 */
function renderWorkareaChip(): void {
  if (!autoSwitchAiWorkdir) {
    if (workareaChipEl) { workareaChipEl.remove(); workareaChipEl = null; }
    return;
  }
  if (browserWorkarea) {
    const label = '@browser';
    const title = '当前 AI 工作区域：浏览器（随活跃标签页自动切换）';
    if (workareaChipEl && workareaChipEl.isConnected) {
      workareaChipEl.innerHTML = `${icon('globe')} ${label}`;
      workareaChipEl.title = title;
      return;
    }
    const c = document.createElement('span');
    c.className = 'tag blue ai-snap-chip ai-workarea-chip';
    c.dataset.kind = 'workarea';
    c.title = title;
    c.innerHTML = `${icon('globe')} ${label}`;
    chipRow.prepend(c);
    workareaChipEl = c;
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
  browserWorkarea = false;
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

/** 激活终端或浏览器 → 工作区域；其他标签保持当前工作区域不变 */
function updateWorkareaFromTab(t: Tab | null): void {
  if (!t) return;
  if (t.type === 'browser') {
    browserWorkarea = true;
    renderWorkareaChip();
    return;
  }
  if (t.type !== 'terminal') return;
  setWorkarea({
    serverId: t.data.kind === 'ssh' && t.data.serverId ? String(t.data.serverId) : null,
    name: t.data.kind === 'ssh' && t.data.serverId ? String(t.title || '服务器') : '本地终端',
  });
}

function onChipRowClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const chip = target.closest('.ai-snap-chip') as HTMLElement | null;
  if (!chip) return;
  if (chip.dataset.kind === 'workarea') return; // 固定工作区域标签不可移除
  if (target.closest('.ai-chip-x')) {
    if (chip.dataset.kind === 'server') serverRefs.delete(chip.dataset.id ?? '');
    else if (chip.dataset.kind === 'path') pathRefs.delete(chip.dataset.id ?? '');
    else if (chip.dataset.kind === 'browser') browserRefs.delete(chip.dataset.id ?? '');
    else if (chip.dataset.kind === 'skill') skillRefs.delete(chip.dataset.id ?? '');
    chip.remove();
    return;
  }
  if (chip.dataset.kind === 'server' || chip.dataset.kind === 'path') return; // 服务器/路径引用无详情弹窗
  if (chip.dataset.kind === 'file') openFileRefModal(fileRefs.get(chip.dataset.id ?? ''));
  else if (chip.dataset.kind === 'browser') openBrowserRefModal(browserRefs.get(chip.dataset.id ?? ''));
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

/** 浏览器元素引用详情：页面标题/地址 + 元素完整 HTML */
function openBrowserRefModal(ref: BrowserRef | undefined): void {
  if (!ref) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal-head"><h3>页面元素引用 · @browser:${escapeHtml(ref.name)}</h3><button class="icon-btn ai-modal-x" title="关闭">${icon('x')}</button></div>
      <div class="modal-body">
        <div class="ai-snap-command mono">${escapeHtml(ref.title || '（无标题）')} · ${escapeHtml(ref.url)}</div>
        <pre class="ai-snap-pre">${escapeHtml(ref.outerHTML || '')}</pre>
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
  // 生成中 → 停止：本地立即定稿并中止后端（leaveSession 同语义：已生成文本落历史）。
  // 不能只调 aiAbort 等后端终止事件：事件被吞（曾因瞬时错误自动重试后 done 受抑制）
  // 会导致停止键无效、输入区永久卡在生成态
  if (isGenerating(sid)) {
    leaveSession(sid);
    renderHistory();
    updateSendBtn();
    return;
  }
  const text = input.value.trim();
  const snaps: TermSnapshot[] = [];
  const refs: FileRef[] = [];
  const srefs: ServerRef[] = [];
  const prefs: PathRef[] = [];
  const brefs: BrowserRef[] = [];
  const skrefs: SkillRef[] = [];
  // 固定工作区域引用最先（开启自动切换时）；浏览器工作区不携带上一终端引用
  if (autoSwitchAiWorkdir && !browserWorkarea && workareaRef) srefs.push(workareaRef);
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
    } else if (kind === 'browser') {
      const b = browserRefs.get(id);
      if (b) brefs.push(b);
    } else if (kind === 'skill') {
      const r = skillRefs.get(id);
      if (r) skrefs.push(r);
    }
  });
  if (!text && snaps.length === 0 && refs.length === 0 && srefs.length === 0 && prefs.length === 0 && brefs.length === 0 && skrefs.length === 0) return;

  // 首条用户消息决定会话标题
  if (s.messages.length === 0) s.title = text.slice(0, 20) || (brefs.length ? '页面元素引用' : skrefs.length ? '技能引用' : srefs.length || prefs.length ? '引用' : '文件引用');

  s.messages.push({ role: 'user', content: text, snapshots: snaps, fileRefs: refs, serverRefs: srefs, pathRefs: prefs, browserRefs: brefs, skillRefs: skrefs, actions: [], ts: Date.now() });
  input.value = '';
  autoGrow();
  clearChips();
  pendingBy.set(sid, emptyPending());
  renderSessionBar();
  renderHistory();
  updateSendBtn();
  persistSession(s);

  // 提交给 ai_chat 的 prompt = 用户文本 + 快照/文件引用全文 + 服务器/路径/技能引用说明（UI 气泡只显示 chip）
  const prompt = await buildPrompt(text, snaps, refs, srefs, prefs, brefs, skrefs);
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
 * 组装发给 pi 的 prompt：用户文本 + 快照/文件引用全文 + 服务器/路径/浏览器元素/技能引用说明。
 * 固定工作区域（开启自动切换时 srefs[0]）作为「当前工作区域」上下文说明，
 * 远程引用附 user@host:port 便于 AI 选择命令目标（后端 run_command 的 target 由 AI 工具参数决定）；
 * 路径引用只带完整路径不带文件内容；浏览器元素引用展开为页面信息 + 元素完整 HTML；
 * 技能引用展开为名称/来源/scope/描述（AI 可循技能目录读取 SKILL.md 后按技能工作）。
 */
async function buildPrompt(text: string, snaps: TermSnapshot[], refs: FileRef[], srefs: ServerRef[], prefs: PathRef[], brefs: BrowserRef[], skrefs: SkillRef[]): Promise<string> {
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
  if (autoSwitchAiWorkdir && browserWorkarea) {
    parts.push('[当前工作区域: 浏览器]');
  } else if (autoSwitchAiWorkdir && workareaRef && srefs[0] === workareaRef) {
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
    + prefs.map((r) => {
      if (!r.serverId) return `\n\n[${r.isDir ? '目录路径' : '文件路径'}: ${r.path}]`;
      const sv = servers.find((s) => s.id === r.serverId);
      const where = sv ? `${sv.name} (${sv.username}@${sv.host}:${sv.port})` : r.serverId;
      return `\n\n[${r.isDir ? '远程目录路径' : '远程文件路径'}（服务器 ${where}）: ${r.path}]`;
    }).join('')
    + brefs.map((r) =>
      `\n\n[浏览器元素引用 @browser:${r.name}]\n页面: ${r.title || '（无标题）'} (${r.url})\n元素 HTML:\n${r.outerHTML.slice(0, 8000)}`).join('')
    + skrefs.map((r) =>
      `\n\n[技能引用 @skill:${r.name}]\n名称: ${r.name}（${r.origin === 'global' ? '全局' : '项目'}）\nscope: ${r.scope.join(', ') || '-'}\n描述: ${r.description}`).join('')
    + refText;
}

/* ---------- 事件绑定 ---------- */
/** AI 面板 Ctrl+C 策略（capture 阶段）：
 *  1) 输入框有选区 → 不拦截，交给浏览器默认复制；
 *  2) 消息区有选中文本 → 显式复制；
 *  3) 输入框为空且当前标签为终端 → 转发 ^C 给终端。 */
function onPanelKeydown(e: KeyboardEvent): void {
  if (e.key !== 'c' && e.key !== 'C') return;
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  // 消息区(或任意位置)有选中文本 → 显式复制该选区(优先于输入框选区与终端 ^C)
  const sel = window.getSelection();
  const selText = sel ? sel.toString().trim() : '';
  if (selText) {
    e.preventDefault();
    e.stopPropagation();
    void copyText(selText).then(
      () => toast('已复制到剪贴板', 'success'),
      () => toast('复制到剪贴板失败', 'error'),
    );
    return;
  }
  // 输入框有选区 → 不拦截,交给浏览器默认复制
  if (input.selectionStart !== input.selectionEnd) return;
  // 输入框为空且当前标签为终端 → 转发 ^C 给终端(旧 Tab.api 字段 → tabApis 注册表)
  if (input.value === '') {
    const active = getActiveTab(useWorkbench.getState());
    if (active && active.type === 'terminal') {
      const api = tabApis.get(active.id) as TerminalApi | undefined;
      if (api) {
        e.preventDefault();
        e.stopPropagation();
        api.ctrlC();
      }
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
    void refreshStagingNotice();
  };
  newSessionBtn.onclick = () => {
    leaveSession(activeSessionId);
    activeSessionId = newSession().id;
    renderSessionBar();
    renderHistory();
    updateSendBtn();
    void subscribe(currentKey());
    void refreshStagingNotice();
  };
  chat.addEventListener('click', onChatClick);
  /* AI 对话容器右键菜单：复制选中内容/消息体 + 打开当前会话文件暂存区（数量实时查询；只作用于当前 project+session） */
  chat.addEventListener('contextmenu', (e) => {
    const pid = project?.id;
    const sid = activeSessionId;
    if (!pid || !sid) return;
    e.preventDefault();
    e.stopPropagation();
    /* 复制目标：优先当前选区，否则右键命中的那条消息正文（.ai-text，卡片类消息回退整块文本） */
    const selText = (window.getSelection()?.toString() ?? '').trim();
    const msgEl = (e.target as HTMLElement).closest('.ai-msg') as HTMLElement | null;
    const bodyText = (msgEl?.querySelector('.ai-text') as HTMLElement | null)?.textContent?.trim()
      ?? msgEl?.textContent?.trim() ?? '';
    const copyTarget = selText || bodyText;
    const doCopy = (): void => {
      if (!copyTarget) return;
      void copyText(copyTarget).then(
        () => toast('已复制到剪贴板', 'success'),
        () => toast('复制到剪贴板失败', 'error'),
      );
    };
    const openStaging = openCurrentStaging;
    void stagingList(pid, sid)
      .then((entries) => {
        showContextMenu(e.clientX, e.clientY, [
          { label: '复制', iconName: 'copy', action: doCopy, disabled: !copyTarget, disabledTip: copyTarget ? undefined : '没有可复制的内容' },
          'sep',
          { label: `打开文件暂存区（${entries.length}）`, iconName: 'history', action: openStaging },
        ]);
      })
      .catch(() => {
        showContextMenu(e.clientX, e.clientY, [
          { label: '复制', iconName: 'copy', action: doCopy, disabled: !copyTarget, disabledTip: copyTarget ? undefined : '没有可复制的内容' },
          'sep',
          { label: '打开文件暂存区', iconName: 'history', action: openStaging },
        ]);
      });
  });
  stagingNotice.addEventListener('click', openCurrentStaging);
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
