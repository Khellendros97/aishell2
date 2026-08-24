/**
 * AI 助手面板引擎（React 迁移：命令式引擎 + 薄壳，由 AiPanel.tsx 挂载/清理）。
 * 对照 legacy/pages/workbench/ai.ts 逐行移植，逻辑/交互/DOM 类名/文案逐条一致
 * （.proto/workbench-ai.js 为交互规格；mock 回复换成 pi 子进程流式事件
 * ai:event:<key>，见 src/api.ts）。挂载时写 wbHandles.ai = { addSnapshot, addFileRef,
 * addServerRef, addPathRef, addBrowserRef, currentSessionId }，清理时仅回收当前面板 DOM 监听；
 * 项目上下文与 AI 事件订阅在模块级保留，切换会话/项目不停止 pi 进程。
 * 基础工具远程化：actionStart 的 args 携带 serverId 表示远程 write/edit/delete_path（guard
 * 覆盖版工具经动作桥执行，见 aishell-guard.ts）；这类动作完成后额外广播 staging-changed
 * （远程写入/删除已进会话暂存自动备份），且不发 fs:changed（后端已按 serverId 跳过）。
 * 数据库连接申请（request_db_connection）：approval 事件携带 connection 字段 → 插入审批卡片
 * （只读展示 AI 填写的连接信息）→ 点【审批】打开审批对话框（./AiDbApproval，用户只填密码 +
 * 勾查询权限）→ 通过先 saveDbConnection 落库再 aiRespondDbRequest 回执 connectionId；
 * 关闭对话框不回执，卡片可重开。
 * 输入区引用 tag 内嵌于输入框（contenteditable）：终端快照 @term:<id>、文件引用 @文件名_起_止、
 * 服务器/本地终端引用 @remote:服务器名称 / @local、文件/目录路径引用 @file:文件名 / @path:目录名、
 * 浏览器元素引用 @browser:#id 或标签名、浏览器页面引用 @page:页面标题（多页面模型）、
 * 技能引用 @skill:名称 —— chip 可穿插在文字中，发送时按输入框内的先后顺序展开进 prompt
 * （content 字段落盘保留 token，历史消息按 token 原位还原内嵌 chip；旧会话回退为消息上方 chip 行）；
 * 输入 @ 唤起自动补全：浏览器页面 / 远程服务器 / 终端最后一条命令（本地文件/目录引用仍走
 * explorer 右键与拖入入口，不进补全）；
 * 图片附件缩略图 chip（粘贴剪贴板 / explorer/SFTP 拖入 / 右键「添加到对话」，
 * 经 ai_attach_images 物化到 <project>/.aishell/ai-images/，发送时不进 prompt 而是随
 * ai_chat 的 images 参数经 pi RPC images 字段传给多模态模型；单条 ≤9 张、单张 ≤10MB）；
 * Settings.autoSwitchAiWorkdir 开启时输入框上方 chip 行首位固定显示
 * 工作区域标签（不可移除），随激活终端自动切换并作为当前目标上下文带入。
 * 发送无独立按钮：Enter 发送（输入盒右下角小字提示），生成中右下角切换为中断图标按钮（点击/Enter 停止）。
 * AI 回复中的链接：普通点击在内置浏览器标签页打开（活跃页面导航 + openTab('browser')），
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
 * - mountAiPanel(container, options) 返回面板控制器（cleanup + 程序化新会话发送）。
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
 *   ai_generate_session_title（首条消息异步标题）/ staging_list /
 *   ai_attach_images（图片附件物化）/ ai_read_image（缩略图/预览回读），事件 on_ai_event（ai:event:<key>）。
 *  AI 事件订阅按 projectId:sessionId 常驻在模块级项目上下文中：切换会话/项目只切换视图，
 *  不退订、不 abort；卸载仅回收当前面板 DOM 监听，不杀项目 pi 进程。
 */
import type { UnlistenFn } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import MarkdownIt from 'markdown-it';
import type { AiActionRecord, AiMode, AppState, AttachImageItem, BrowserPageRef, BrowserRef, ChatMsg, ChatSession, FileRef, ImageRef, LlmConfig, PathRef, Project, Server, ServerRef, SkillRef, TermSnapshot } from '../../../types';
import { icon, type IconName } from '../../../icons';
import {
  aiAbort, aiAttachImages, aiChat, aiDebugInfo, aiGenerateSessionTitle, aiReadImage, aiRespondApproval, aiRespondDbRequest, aiSetThinking, getState, onAiEvent, onAiSessionTitle, saveDbConnection, saveSettings,
  sessionArchive, sessionUpsert, sessionsGet, setAiMode, stagingList, traceStatus,
  type AiEvent,
  type AiSessionTitleEvent,
} from '../../../api';
import { DND_MIME, getActiveTab, getActiveTerminalApi, tabApis, useWorkbench, wbEvents, wbHandles, type Tab, type TerminalApi } from '../../../stores/workbench';
import { getBrowserPagesForMention, openInActivePage } from '../tabs/browser-engine';
import { addQuickCommandModal } from '../tabs/useTerminal';
import { hideProgress } from '../statusbar-progress';
import { confirmDialog, copyText, showContextMenu, toast, uid } from '../../../ui';
import { openAiDbApprovalModal, type DbRequestDetail } from './AiDbApproval';
import { openArchiveModal } from './ArchiveModal';
import { openNote } from '../tabs/NoteTab';
import { DB_DEFAULT_PORTS, DB_KIND_LABEL } from '../db';

/* ---------- 面板样式（原型 workbench-ai.js 注入的样式 + 错误气泡红边） ---------- */
const STYLE = `
#ai-session-bar {
  height: 40px; flex: none; display: flex; align-items: center; gap: 6px;
  padding: 0 8px; border-bottom: 1px solid var(--border);
}
#ai-session-picker { position: relative; flex: 1; min-width: 0; }
#ai-session-select { width: 100%; height: 26px; display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 0 8px; font-size: 12px; text-align: left; }
#ai-session-select .ai-session-current { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#ai-session-select .ai-session-chevron { flex: none; }
#ai-session-menu {
  position: absolute; z-index: 20; left: 0; right: 0; top: calc(100% + 4px); max-height: 240px; overflow-y: auto;
  padding: 4px; background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 6px; box-shadow: 0 8px 24px rgba(0,0,0,.28);
}
#ai-session-menu[hidden] { display: none; }
.ai-session-option { width: 100%; min-height: 28px; display: flex; align-items: center; gap: 6px; border: 0; border-radius: 4px; padding: 4px 7px; color: var(--text-0); background: transparent; text-align: left; cursor: pointer; font-size: 12px; }
.ai-session-option:hover, .ai-session-option:focus-visible { background: var(--bg-3); outline: none; }
.ai-session-option .ai-session-title { min-width: 0; }
.ai-session-option[aria-current="true"] { background: var(--accent-dim); }
.ai-session-option .ai-session-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-session-option .ai-session-loading { margin-left: auto; color: var(--accent); }
.ai-session-loading .ic { width: 13px; height: 13px; animation: ai-session-spin .8s linear infinite; }
@keyframes ai-session-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .ai-session-loading .ic { animation-duration: 1.8s; } }
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
/* 工作区域固定 chip 行(输入框上方):引用 tag 已内嵌输入框,图片附件 chip 也在本行;
   无任何 chip 时行高塌为 0(slot 空内容),仅余 #ai-input-area 的 6px gap */
#ai-chip-row { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
#ai-workarea-slot { flex: none; display: inline-flex; }
#ai-input-row { position: relative; }
/* 输入盒:外框承担旧 textarea 的边框/背景/滚动,内部是 contenteditable + 右下角状态区 */
#ai-input-box {
  position: relative;
  display: flex; align-items: flex-start;
  min-height: 70px; /* 初始约两行 + 底部提示预留(58px 输入区 + 上下 padding) */
  max-height: 120px; overflow-y: auto;
  background: var(--bg-2); border: 1px solid var(--border); border-radius: 6px;
  color: var(--text-0); padding: 6px 8px;
  font-family: var(--font-ui); font-size: 12.5px; line-height: 1.5;
}
#ai-input-box:focus-within { border-color: var(--accent); }
#ai-input {
  flex: 1; min-width: 0; outline: none; border: 0; background: transparent;
  color: var(--text-0); font: inherit; white-space: pre-wrap; word-break: break-word;
  min-height: 58px; /* 初始约两行(2×19px 行高) + 底部 20px 提示预留 */
  padding: 0 4px 20px 0; /* 底部留白:右下角「Enter 发送」/中断按钮不压正文 */
}
#ai-input:empty::before {
  content: attr(data-placeholder); color: var(--text-2); pointer-events: none;
}
/* 右下角状态区:空闲显示「Enter 发送」小字提示,生成中切换为中断图标按钮(带背景防文字穿透) */
.ai-input-corner {
  position: absolute; right: 6px; bottom: 4px;
  display: inline-flex; align-items: center; gap: 4px;
  padding-left: 6px; background: var(--bg-2); border-radius: 4px;
}
.ai-input-hint { font-size: 10.5px; color: var(--text-2); user-select: none; padding: 0 2px; }
.ai-abort-btn {
  width: 22px; height: 22px; flex: none;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border-strong); border-radius: 4px;
  background: var(--bg-3); color: var(--red); cursor: pointer;
}
.ai-abort-btn:hover { border-color: var(--red); background: var(--bg-2); }
.ai-abort-btn[hidden] { display: none; }
/* 内嵌引用 chip:原子元素(contenteditable=false),✕ 移除 */
.ai-inline-chip {
  display: inline-flex; align-items: center; gap: 3px;
  padding: 0 5px; margin: 0 1px; border-radius: 4px;
  background: var(--accent-dim); border: 1px solid var(--accent);
  color: var(--accent-hover); font-size: 11.5px; cursor: pointer; user-select: none;
  max-width: 220px;
}
.ai-inline-chip .ai-chip-label {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px;
}
.ai-inline-chip .ai-chip-x { flex: none; opacity: 0.6; cursor: pointer; display: inline-flex; }
.ai-inline-chip .ai-chip-x:hover { opacity: 1; }
.ai-inline-chip .ai-chip-x svg { width: 11px; height: 11px; }
/* @ 自动补全弹层:输入行上方,分组 + 项(图标 + 标签 + 右侧提示) */
.ai-mention-pop {
  position: absolute; left: 0; right: 0; bottom: calc(100% + 4px); z-index: 30;
  max-height: 264px; overflow-y: auto; padding: 4px;
  background: var(--bg-1); border: 1px solid var(--border-strong); border-radius: 6px;
  box-shadow: 0 8px 24px rgba(0,0,0,.28);
}
.ai-mention-group { font-size: 10.5px; color: var(--text-2); padding: 5px 7px 2px; }
.ai-mention-item {
  width: 100%; min-height: 28px; display: flex; align-items: center; gap: 6px;
  border: 0; border-radius: 4px; padding: 4px 7px; text-align: left; cursor: pointer;
  background: transparent; color: var(--text-0); font-size: 12px;
}
.ai-mention-item:hover, .ai-mention-item.active { background: var(--accent-dim); outline: none; }
.ai-mention-item .ic { flex: none; color: var(--text-2); }
.ai-mention-item.active .ic { color: var(--accent); }
.ai-mention-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-mention-hint { flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10.5px; color: var(--text-2); }
.ai-msg-chip-inline { display: inline-flex; vertical-align: baseline; }
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
/* 图片附件：输入区 chip 缩略图（22px）与历史消息缩略图行（110px，点开大图）。
   缩略图容器固定尺寸，加载中显示浅色占位，失败红边显示文件名。 */
.ai-img-chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 7px 2px 3px; }
.ai-img-chip .ai-img-name { max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ai-img-chip-thumb {
  width: 22px; height: 22px; flex: none; overflow: hidden;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 4px; border: 1px solid var(--border); background: var(--bg-3);
  font-size: 0; color: transparent;
}
.ai-img-chip-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ai-msg-images { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.ai-img-thumb {
  width: 110px; height: 110px; padding: 0; overflow: hidden; cursor: zoom-in;
  display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg-3);
  font-size: 10.5px; color: var(--text-2); text-align: center; line-height: 1.3;
  transition: border-color 0.12s;
}
.ai-img-thumb:hover { border-color: var(--accent); }
.ai-img-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ai-img-thumb.ai-img-error, .ai-img-chip-thumb.ai-img-error { border-color: var(--red); }
/* 图片预览对话框：等比缩放居中，超大图不撑破 modal */
.ai-img-view {
  display: flex; align-items: center; justify-content: center;
  min-height: 160px; max-height: 68vh; overflow: hidden;
  border: 1px solid var(--border); border-radius: 8px; background: var(--bg-1);
  color: var(--text-2); font-size: 12px;
}
.ai-img-view img { max-width: 100%; max-height: 68vh; object-fit: contain; display: block; }
/* 输入区拖拽图片高亮 */
#ai-input-area.ai-drag-over {
  outline: 1.5px dashed var(--accent); outline-offset: -3px;
  border-radius: 6px; background: var(--accent-dim);
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
  /** 创建序号（同 textLen 锚点的工具行/动作卡按到达先后排序；瞬时字段，不落盘） */
  seq?: number;
}

/** 非受控工具活动行（瞬时展示，不落盘）：textLen 为发生时已生成文本长度，渲染时按时序穿插 */
interface ToolLine {
  label: string;
  /** 相邻同行折叠计数（显示为 ×N） */
  count: number;
  /** 发生时 p.text 长度（穿插锚点） */
  textLen: number;
  /** 到达序号（同锚点排序用） */
  seq: number;
}

/** 生成中/错误气泡的瞬时状态（不进 ChatSession.messages，不落盘）；tools 为工具活动行（同上） */
interface Pending {
  phase: 'typing' | 'stream' | 'error';
  text: string;
  error?: string;
  tools: ToolLine[];
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
  py: '执行 Python 脚本',
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
    case 'py': {
      const p = typeof args.path === 'string' && args.path.trim() ? args.path.trim() : '';
      if (p) return `执行 Python 脚本 ${p}`;
      const code = typeof args.code === 'string' ? args.code.trim() : '';
      const lines = code ? code.split('\n').length : 0;
      return `执行内联 Python 脚本（${lines} 行）`;
    }
    default:
      return '';
  }
}

const emptyPending = (): Pending => ({ phase: 'typing', text: '', tools: [], actions: new Map() });

/** 首条消息的即时临时标题：模型标题回来前也不超过 20 个用户可见字符。 */
function temporarySessionTitle(text: string, fallback: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return fallback;
  if (typeof Intl.Segmenter === 'undefined') return Array.from(normalized).slice(0, 20).join('');
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return Array.from(segmenter.segment(normalized), ({ segment }) => segment).slice(0, 20).join('');
}

/** session_upsert 的入参快照：后续流式事件继续修改内存对象时不影响排队中的写入。 */
function cloneChatSession(s: ChatSession): ChatSession {
  return {
    id: s.id,
    title: s.title,
    autoTitleTriggered: s.autoTitleTriggered === true,
    messages: s.messages.map((m) => ({
      role: m.role,
      content: m.content,
      snapshots: m.snapshots.map((snap) => ({ ...snap })),
      fileRefs: m.fileRefs.map((ref) => ({ ...ref })),
      serverRefs: m.serverRefs.map((ref) => ({ ...ref })),
      pathRefs: m.pathRefs.map((ref) => ({ ...ref })),
      browserRefs: m.browserRefs.map((ref) => ({ ...ref })),
      browserPageRefs: (m.browserPageRefs ?? []).map((ref) => ({ ...ref })),
      skillRefs: m.skillRefs.map((ref) => ({ ...ref, scope: [...ref.scope] })),
      imageRefs: (m.imageRefs ?? []).map((ref) => ({ ...ref })),
      actions: m.actions.map((action) => ({ ...action })),
      ts: m.ts,
    })),
  };
}

export interface AiPanelOptions {
  /** 显式 AI 上下文；工作台不传时沿用 zustand 当前项目。 */
  project?: Project;
  /** 是否接入工作台标签、暂存区和 wbHandles；欢迎页任务上下文关闭。 */
  workbenchIntegration?: boolean;
  /** 固定本地工作区域说明；设置后不跟随工作台标签切换。 */
  fixedWorkareaPath?: string;
  /** 锁定模式选择；系统任务上下文固定为工作模式。 */
  lockedMode?: AiMode;
}

export interface AiPanelController {
  cleanup(): void;
  /** 新建独立会话并发送首条纯文本消息。 */
  startConversation(prompt: string): Promise<void>;
}

interface ProjectContext {
  project: Project;
  sessions: Map<string, ChatSession>;
  pendingBy: Map<string, Pending | null>;
  /** 用户手动展开的工具调用组（key = `<sid>:<消息ts>`） */
  expandedGroups: Set<string>;
  activeSessionId: string;
  loaded: boolean;
  loading: boolean;
  loadPromise: Promise<void> | null;
  loadGeneration: number;
  /** 同一项目的每个会话只订阅一次；切换会话/项目不退订。 */
  subscriptions: Map<string, UnlistenFn>;
  subscribing: Set<string>;
  /** 按 projectId:sessionId 串行化 session_upsert，确保快照按产生顺序落盘。 */
  persistQueues: Map<string, Promise<void>>;
}

/** 项目上下文模块级常驻：工作台 React 面板重挂时只换视图，不丢历史、pending 或事件订阅。 */
const projectContexts = new Map<string, ProjectContext>();
let viewContext: ProjectContext | null = null;
let eventContext: ProjectContext | null = null;
let project: Project | null = null;
let panelOptions: Required<Pick<AiPanelOptions, 'workbenchIntegration'>> & Omit<AiPanelOptions, 'workbenchIntegration' | 'project'> = {
  workbenchIntegration: true,
};
/** 以下是当前视图上下文的别名，保留命令式引擎原有函数结构。 */
let sessions = new Map<string, ChatSession>();
let pendingBy = new Map<string, Pending | null>();
let expandedGroups = new Set<string>();
const snapshots = new Map<string, TermSnapshot>(); // 快照 id -> 全文（输入区 chip + 历史消息 chip 共用）
const fileRefs = new Map<string, FileRef>(); // 文件引用 id -> 全文（编辑器选区，@文件名_起_止 标签）
const serverRefs = new Map<string, ServerRef>(); // 服务器/本地引用 key -> 引用（key = serverId ?? 'local'，@remote:名称 / @local 标签）
const pathRefs = new Map<string, PathRef>(); // 文件/目录路径引用 path -> 引用（@file:文件名 / @path:目录名 标签）
const browserRefs = new Map<string, BrowserRef>(); // 浏览器元素引用 key -> 引用（key = `${name}:${ts}`，@browser:名称 标签）
const pageRefs = new Map<string, BrowserPageRef>(); // 浏览器页面引用 id -> 引用（@page:页面标题 标签，@ 补全插入）
const skillRefs = new Map<string, SkillRef>(); // 技能引用 key -> 引用（key = `${origin}:${name}`，@skill:名称 标签）
/* 图片附件拆两个 Map：
   - historyImageRefs  历史消息缩略图/预览查找（renderMessage 灌入，跨会话累积）；
   - inputImageRefs    输入区待发图片（attachImages 写入、chip ✕ 删除、clearChips/挂面板清空）。
   此前共用一个 Map：renderHistory 把历史消息 imageRefs 灌回后，发送时 imageRefs.forEach 全量
   收集会把上一会话/历史消息的图片带进新消息（发 1 张实际带 3 张、再发变 4 张）。 */
const historyImageRefs = new Map<string, ImageRef>(); // 历史消息图片 id -> 引用
const inputImageRefs = new Map<string, ImageRef>(); // 输入区待发图片 id -> 引用
/** 落盘图片回读缓存（path -> base64；null = 读取失败）。有界 FIFO，避免多图会话内存膨胀。 */
const imageCache = new Map<string, { mime: string; data: string } | null>();
const IMAGE_CACHE_MAX = 16;
/** 单条消息图片上限（DeepSeek 官方 600 张/请求 48MiB，产品侧收敛到 9 张；单张 10MB 由后端 attach 校验） */
const MAX_ATTACH_IMAGES = 9;
/** 图片扩展名粗筛（能否作为附件以粘贴/拖入与右键入口为准；实际格式由后端魔数嗅探判定） */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

/** 回读落盘图片（带缓存）；失败缓存 null（文件被移动/删除的场景重试也无益）。 */
async function loadImageData(path: string): Promise<{ mime: string; data: string } | null> {
  if (imageCache.has(path)) return imageCache.get(path) ?? null;
  let out: { mime: string; data: string } | null = null;
  try {
    out = await aiReadImage(path);
  } catch {
    out = null;
  }
  imageCache.set(path, out);
  if (imageCache.size > IMAGE_CACHE_MAX) {
    const oldest = imageCache.keys().next().value;
    if (oldest !== undefined && oldest !== path) imageCache.delete(oldest);
  }
  return out;
}

/** 模型是否支持图片输入（启发式与 Rust ai.rs models_json_for 一致：模型 id 小写含 "vision"）。 */
function supportsVisionModel(modelId: string): boolean {
  return modelId.toLowerCase().includes('vision');
}
/** 自动切换 AI 工作区域（Settings.autoSwitchAiWorkdir）：开启时输入区固定显示工作区域标签 */
let autoSwitchAiWorkdir = false;
/** 当前 AI 工作区域（默认本地；随激活终端/浏览器标签自动切换） */
let workareaRef: ServerRef | null = null;
/** 当前浏览器工作区域不使用服务器引用，单独记录以便发送时注入明确上下文。 */
let browserWorkarea = false;
/** 工作区域固定标签 DOM（不可移除；clearChips 清空后由 renderWorkareaChip 重建） */
let workareaChipEl: HTMLElement | null = null;
let activeSessionId = '';
let unmounted = false;
let sessionMenuOpen = false;
let offSessionOutside: (() => void) | null = null;
/** AI 面板根容器（Ctrl+C 键盘策略监听用，卸载时移除） */
let panelRoot: HTMLElement | null = null;
let stagingNotice: HTMLButtonElement;
let offStagingChanged: (() => void) | null = null;
/** 全局标题事件只注册一次；发送前 await，避免首条命令先于 listener 发出。 */
let sessionTitleListenerPromise: Promise<void> | null = null;
/** listener 早于项目/会话加载完成时暂存事件，loadSessions 合并后回放。 */
const pendingSessionTitleEvents = new Map<string, AiSessionTitleEvent[]>();
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
/** 工具行/动作卡创建序号：同 textLen 锚点的条目按到达先后排序（模块级单调递增即可，排序都在单个 pending 内） */
let toolSeq = 0;

let chat: HTMLElement;
let sessionSelect: HTMLButtonElement;
let sessionMenu: HTMLElement;
let newSessionBtn: HTMLButtonElement;
/** contenteditable 输入区（引用 tag 以原子 chip 内嵌其中，可穿插文字） */
let input: HTMLDivElement;
/** 输入盒（边框/背景/滚动容器）：工作区域 chip 槽 + contenteditable */
let inputBox: HTMLDivElement;
/** 固定工作区域 chip 槽（输入盒最前，不可编辑不可移除） */
let workareaSlot: HTMLElement;
/** 中断按钮（生成中显示于输入盒右下角；空闲隐藏——发送走 Enter，按钮位置显示「Enter 发送」小字） */
let sendBtn: HTMLButtonElement;
/** 图片附件缩略图行（引用 tag 已内嵌输入框，此行只剩图片 chip） */
let chipRow: HTMLElement;
let effortSelect: HTMLSelectElement;
let modeSelect: HTMLSelectElement;
/** 思考强度切换防抖：快速连续切换只允许一个保存流程 */
let effortSaving = false;
/** AI 模式切换防抖（YOLO 确认弹窗期间防重复触发） */
let modeSaving = false;

/* ---------- @ 自动补全（输入框内输入 @ 唤起） ---------- */

/** 补全候选项：apply 负责删除 @query 并插入对应 chip（本地文件/目录走文件对话框，异步） */
interface MentionItem {
  key: string;
  group: string;
  icon: IconName;
  label: string;
  hint?: string;
  /** 过滤关键词（与 @ 后输入的 query 做子串匹配） */
  keywords: string;
  apply(): void | Promise<void>;
}

let mentionEl: HTMLElement | null = null;
let mentionItems: MentionItem[] = [];
let mentionIndex = 0;
/** '@' 所在文本节点与偏移（应用时删除「@query」再插入 chip） */
let mentionAnchor: { node: Text; at: number } | null = null;
/** 当前补全过滤词（服务器列表异步到达后按此重渲染） */
let mentionQuery = '';
/** 服务器列表缓存（弹层打开时拉取一次，会话期间复用） */
let serversCache: Server[] | null = null;
/** 输入区最近一次光标 Range（文件对话框等异步流程失焦后恢复插入位置用） */
let savedRange: Range | null = null;
/** document selectionchange 监听（记录 savedRange；卸载时移除） */
let offSelectionChange: (() => void) | null = null;

/* UI 显示文案：内部枚举值不变（AiMode / LlmConfig.effort），仅展示层用中文 */
const MODE_LABEL: Record<AiMode, string> = { suggest: '仅建议', agent: '工作', yolo: '全自动' };
const EFFORT_LABEL: Record<LlmConfig['effort'], string> = { low: '低', high: '高', max: '最高' };

/**
 * 切换 AI 模式：YOLO 先弹危险确认（取消回退原模式）；确认后调 setAiMode 落盘
 * （Rust 同时向该项目存活 pi 进程热推 /aishell-mode），成功才更新内存项目。
 */
async function switchMode(mode: AiMode): Promise<void> {
  const ctx = viewContext;
  const targetProject = ctx?.project;
  if (modeSaving || !ctx || !targetProject) return;
  if (mode === targetProject.aiMode) {
    if (viewContext === ctx && !unmounted) modeSelect.value = targetProject.aiMode;
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
      if (viewContext === ctx && !unmounted) modeSelect.value = targetProject.aiMode;
      return;
    }
  }
  modeSaving = true;
  try {
    await setAiMode(targetProject.id, mode);
    /* 跨「仅建议」边界（suggest ↔ agent/yolo）时，Rust 侧会重启该项目全部 pi 进程
       （--tools 与系统提示不同，热推无法变更模型可见工具集）；生成中的回合被打断，
       这里把所有会话的流式文本定稿并中止后端，UI 即时反映新模式。 */
    const crossedSuggest = (targetProject.aiMode === 'suggest') !== (mode === 'suggest');
    targetProject.aiMode = mode;
    if (viewContext === ctx && !unmounted) modeSelect.value = mode;
    if (crossedSuggest) leaveAllSessions(ctx);
    toast(`AI 模式已切换为 ${MODE_LABEL[mode]}`, 'success');
  } catch (err) {
    if (viewContext === ctx && !unmounted) modeSelect.value = targetProject.aiMode;
    toast(`切换 AI 模式失败：${String(err)}`, 'error');
  } finally {
    modeSaving = false;
  }
}

/* ---------- 面板挂载 / 卸载 ---------- */
function getProjectContext(p: Project): ProjectContext {
  const existing = projectContexts.get(p.id);
  if (existing) {
    existing.project = p;
    return existing;
  }
  const created: ProjectContext = {
    project: p,
    sessions: new Map(),
    pendingBy: new Map(),
    expandedGroups: new Set(),
    activeSessionId: '',
    loaded: false,
    loading: false,
    loadPromise: null,
    loadGeneration: 0,
    subscriptions: new Map(),
    subscribing: new Set(),
    persistQueues: new Map(),
  };
  projectContexts.set(p.id, created);
  return created;
}

function bindViewContext(ctx: ProjectContext): void {
  viewContext = ctx;
  project = ctx.project;
  sessions = ctx.sessions;
  pendingBy = ctx.pendingBy;
  expandedGroups = ctx.expandedGroups;
  activeSessionId = ctx.activeSessionId;
}

function saveViewContext(): void {
  if (viewContext) viewContext.activeSessionId = activeSessionId;
}

export function mountAiPanel(container: HTMLElement, options: AiPanelOptions = {}): AiPanelController {
  const nextProject = options.project ?? useWorkbench.getState().project;
  if (!nextProject) {
    toast('项目未加载', 'error');
    return {
      cleanup: () => { /* 项目尚未加载，不创建引擎状态 */ },
      startConversation: async () => { throw new Error('项目未加载'); },
    };
  }
  const ctx = getProjectContext(nextProject);
  bindViewContext(ctx);
  panelOptions = {
    workbenchIntegration: options.workbenchIntegration !== false,
    fixedWorkareaPath: options.fixedWorkareaPath,
    lockedMode: options.lockedMode,
  };
  unmounted = false;

  /* 输入引用属于当前面板，跨项目不串入下一个输入框；会话/流式状态属于项目上下文，
     面板重挂或切项目时保留并继续接收事件。 */
  snapshots.clear();
  fileRefs.clear();
  serverRefs.clear();
  pathRefs.clear();
  browserRefs.clear();
  pageRefs.clear();
  skillRefs.clear();
  inputImageRefs.clear(); // 输入区待发图片随面板重挂清空（历史消息图片在 historyImageRefs，不受影响）
  serversCache = null;
  savedRange = null;
  autoSwitchAiWorkdir = false;
  workareaRef = null;
  browserWorkarea = false;
  workareaChipEl = null;
  activeSessionId = ctx.activeSessionId;

  if (!document.getElementById('aishell-ai-panel-style')) {
    const style = document.createElement('style');
    style.id = 'aishell-ai-panel-style';
    style.textContent = STYLE;
    document.head.appendChild(style);
  }

  container.innerHTML = `
    <div id="ai-session-bar">
      <div id="ai-session-picker">
        <button id="ai-session-select" class="select" type="button" aria-haspopup="listbox" aria-expanded="false" title="切换会话">
          <span class="ai-session-current">加载会话中…</span>${icon('chevronDown')}
        </button>
        <div id="ai-session-menu" role="listbox" aria-label="AI 会话列表" hidden></div>
      </div>
      <button id="ai-new-session" class="icon-btn" type="button" title="新建会话">${icon('plus')}</button>
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
      <div id="ai-chip-row"><span id="ai-workarea-slot"></span></div>
      <div id="ai-input-row">
        <div id="ai-input-box">
          <div id="ai-input" contenteditable="true" role="textbox" aria-multiline="true" aria-label="AI 对话输入框"
            data-placeholder="向 AI 提问，Shift+Enter 换行；输入 @ 引用终端/文件/服务器/浏览器；可粘贴或拖入图片"></div>
          <span class="ai-input-corner">
            <span class="ai-input-hint">Enter 发送</span>
            <button class="ai-abort-btn" type="button" title="停止生成 (Enter)" hidden>${icon('square')}</button>
          </span>
        </div>
      </div>
    </div>`;

  const el = (id: string) => container.querySelector<HTMLElement>(`#ai-${id}`)!;
  chat = el('chat');
  sessionSelect = el('session-select') as HTMLButtonElement;
  sessionMenu = el('session-menu');
  newSessionBtn = el('new-session') as HTMLButtonElement;
  input = el('input') as HTMLDivElement;
  inputBox = el('input-box') as HTMLDivElement;
  workareaSlot = el('workarea-slot');
  sendBtn = container.querySelector<HTMLButtonElement>('.ai-abort-btn')!;
  chipRow = el('chip-row');
  effortSelect = el('effort-select') as HTMLSelectElement;
  modeSelect = el('mode-select') as HTMLSelectElement;
  stagingNotice = el('staging-notice') as HTMLButtonElement;
  modeSelect.value = panelOptions.lockedMode ?? project?.aiMode ?? 'suggest';
  if (panelOptions.lockedMode) {
    modeSelect.disabled = true;
    modeSelect.title = '系统任务上下文固定为工作模式';
  }

  const mountedHandle = createAiHandle();
  if (panelOptions.workbenchIntegration) wbHandles.ai = mountedHandle;

  /* 自动切换 AI 工作区域：激活终端标签（含新开终端）时跟随切换。
     legacy 由 bus 'tab-activated' 广播（activeId 变化时发激活 Tab），
     这里订阅 store 状态按 activeId 变化推导，语义一致；AI 面板页级常驻（每页只挂一次），
     unmounted 守卫 + container.isConnected 守卫兜底 */
  if (panelOptions.workbenchIntegration) {
    offTabActivated = useWorkbench.subscribe((s, prev) => {
      if (s.activeId === prev.activeId) return;
      if (unmounted || !container.isConnected) return;
      if (autoSwitchAiWorkdir) updateWorkareaFromTab(getActiveTab(s));
    });

    offStagingChanged = wbEvents.on('staging-changed', () => {
      if (!unmounted && container.isConnected) void refreshStagingNotice();
    });
  }
  /* 标题事件是全局单例订阅；先启动注册，send 首条消息时再 await 同一个 Promise。 */
  void ensureSessionTitleListener().catch(() => { /* 发送流程仍可继续，标题命令失败不阻塞 ai_chat */ });

  // pi 运行时诊断输出到控制台（F12 可查），便于排查安装版「pi 运行时不存在」
  void aiDebugInfo().then((info) => console.log('[AI] pi 运行时诊断:\n' + info));

  bindEvents();
  panelRoot = container;
  container.addEventListener('keydown', onPanelKeydown, true);
  void loadSessions();
  void loadEffort();
  if (panelOptions.workbenchIntegration) void refreshStagingNotice();
  else stagingNotice.hidden = true;
  return {
    cleanup: () => cleanup(mountedHandle),
    startConversation: (prompt: string) => startConversation(ctx, prompt),
  };
}

function ensureSessionTitleListener(): Promise<void> {
  if (!sessionTitleListenerPromise) {
    sessionTitleListenerPromise = onAiSessionTitle((ev) => handleSessionTitleEvent(ev)).then(() => undefined).catch((err) => {
      sessionTitleListenerPromise = null;
      console.error('[AI] 标题事件订阅失败:', err);
      throw err;
    });
  }
  return sessionTitleListenerPromise;
}

function handleSessionTitleEvent(ev: AiSessionTitleEvent): void {
  const title = ev.title.trim();
  if (!title) return;
  const key = `${ev.projectId}:${ev.sessionId}`;
  const ctx = projectContexts.get(ev.projectId);
  const s = ctx?.sessions.get(ev.sessionId);
  if (!ctx || !s) {
    const queued = pendingSessionTitleEvents.get(key) ?? [];
    queued.push({ ...ev, title });
    pendingSessionTitleEvents.set(key, queued);
    return;
  }
  applySessionTitleEvent(ctx, ev);
}

function applySessionTitleEvent(ctx: ProjectContext, ev: AiSessionTitleEvent): void {
  const s = ctx.sessions.get(ev.sessionId);
  if (!s || !ev.title.trim()) return;
  s.title = ev.title.trim().slice(0, 40);
  void persistSession(s, ctx);
  if (viewContext === ctx && !unmounted) renderSessionBar();
}

function replayPendingSessionTitleEvents(ctx: ProjectContext): void {
  for (const sid of ctx.sessions.keys()) {
    const key = `${ctx.project.id}:${sid}`;
    const queued = pendingSessionTitleEvents.get(key);
    if (!queued) continue;
    pendingSessionTitleEvents.delete(key);
    for (const ev of queued) applySessionTitleEvent(ctx, ev);
  }
}

function cleanup(handle: ReturnType<typeof createAiHandle>): void {
  if (unmounted) return;
  unmounted = true;
  cancelPendingRender();
  pendingEl = null;
  msgEls = [];
  segCache.clear();
  fixedParts = [];
  cardEls.clear();
  closeMention();
  saveViewContext();
  if (panelRoot) { panelRoot.removeEventListener('keydown', onPanelKeydown, true); panelRoot = null; }
  if (offSelectionChange) { offSelectionChange(); offSelectionChange = null; }
  closeSessionMenu();
  if (offSessionOutside) { offSessionOutside(); offSessionOutside = null; }
  if (offStagingChanged) { offStagingChanged(); offStagingChanged = null; }
  if (offTabActivated) { offTabActivated(); offTabActivated = null; }
  if (wbHandles.ai === handle) wbHandles.ai = null;
  /* 不退订项目/会话事件，也不 aiAbort/aiKillProject；上下文继续接收并保存后台流。 */
  viewContext = null;
  project = null;
}

/* ---------- wbHandles.ai 句柄（终端模块添加快照 / 服务器引用 / 路径引用） ---------- */
function createAiHandle() {
  return {
  addSnapshot(snap: TermSnapshot): void {
    if (!snap || !snap.id) return;
    snapshots.set(snap.id, snap);
    insertTermChip(snap);
  },
  addFileRef(ref: FileRef): void {
    if (!ref || !ref.id) return;
    fileRefs.set(ref.id, ref);
    insertFileChip(ref);
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
    insertServerChip(ref);
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
    insertPathChip(ref);
  },
  /** 浏览器元素引用（@browser:#id 或标签名 标签，发送时展开页面信息 + 元素 HTML）；
   *  同名元素（如多个 button）允许重复添加——chip 各自携带完整快照数据 */
  addBrowserRef(ref: BrowserRef): void {
    if (!ref || (!ref.name && !ref.tagName)) return;
    const key = `${ref.name || ref.tagName}:${ref.ts}`;
    browserRefs.set(key, ref);
    insertBrowserChip(ref, key);
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
    insertSkillChip(ref);
  },
  /** 图片附件（explorer/SFTP 右键「添加到对话」对图片文件的入口）：
   *  物化由 attachImages 统一完成（vision 门槛 / 数量上限 / 后端嗅探都在那里） */
  addImageRef(ref: { source: 'local' | 'remote'; path: string; serverId?: string }): void {
    if (!ref || typeof ref.path !== 'string' || !ref.path.trim()) return;
    void attachImages([
      ref.source === 'remote'
        ? { source: 'remote', serverId: ref.serverId ?? '', path: ref.path }
        : { source: 'local', path: ref.path },
    ]);
  },
  currentSessionId(): string | null {
    return activeSessionId || null;
  },
  };
}

/* ---------- 会话管理 ---------- */
function newSession(): ChatSession {
  const s: ChatSession = { id: uid('sess'), title: '新会话', messages: [], autoTitleTriggered: false };
  sessions.set(s.id, s);
  if (viewContext) void ensureSessionSubscription(viewContext, s.id);
  return s;
}

async function startConversation(ctx: ProjectContext, prompt: string): Promise<void> {
  const text = prompt.trim();
  if (!text) throw new Error('对话内容不能为空');
  if (viewContext !== ctx || unmounted) throw new Error('AI 面板尚未就绪');
  await loadSessions();
  if (viewContext !== ctx || unmounted) throw new Error('AI 面板已离开当前页面');
  const created = newSession();
  ctx.activeSessionId = created.id;
  activeSessionId = created.id;
  await ensureSessionSubscription(ctx, created.id);
  renderSessionBar();
  renderHistory();
  updateSendBtn();
  await send(text);
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
  if (!panelOptions.workbenchIntegration) {
    stagingNotice.classList.remove('visible');
    return;
  }
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
  const ctx = viewContext;
  if (!ctx || !project) {
    toast('项目未加载', 'error');
    return;
  }
  if (ctx.loaded) {
    ensureActiveSession(ctx);
    replayPendingSessionTitleEvents(ctx);
    renderSessionBar();
    renderHistory();
    updateSendBtn();
    return;
  }
  if (ctx.loading && ctx.loadPromise) {
    await ctx.loadPromise;
    if (viewContext !== ctx || unmounted) return;
    ensureActiveSession(ctx);
    replayPendingSessionTitleEvents(ctx);
    renderSessionBar();
    renderHistory();
    updateSendBtn();
    return;
  }
  ctx.loading = true;
  const generation = ++ctx.loadGeneration;
  const promise = sessionsGet(ctx.project.id).then((list) => {
    if (ctx.loadGeneration !== generation) return;
    /* 已归档会话不进列表(数据仍在 aishell.json,未来可做取消归档) */
    const visible = list.filter((s) => s.archived !== true);
    for (const serverSession of visible) {
      const current = ctx.sessions.get(serverSession.id);
      if (!current) {
        ctx.sessions.set(serverSession.id, serverSession);
        continue;
      }
      /* 合并服务端标题/领取标记，但保留前端正在生成的消息与 pending，避免
         sessions_get 的旧快照覆盖首条消息或流式回合。 */
      current.title = serverSession.title;
      current.autoTitleTriggered = serverSession.autoTitleTriggered === true;
    }
    /* Rust 按插入序返回（旧→新），已有前端新会话不被异步加载覆盖。 */
    if (!ctx.activeSessionId && visible.length > 0) ctx.activeSessionId = visible[visible.length - 1].id;
    ctx.loaded = true;
    replayPendingSessionTitleEvents(ctx);
    for (const s of ctx.sessions.values()) void ensureSessionSubscription(ctx, s.id);
  }).catch((err) => {
    if (ctx.loadGeneration === generation) toast(`会话加载失败：${String(err)}`, 'error');
  }).finally(() => {
    if (ctx.loadGeneration === generation) {
      ctx.loading = false;
      ctx.loadPromise = null;
    }
  });
  ctx.loadPromise = promise;
  await promise;
  if (viewContext !== ctx || unmounted) return;
  ensureActiveSession(ctx);
  renderSessionBar();
  renderHistory();
  updateSendBtn();
  void refreshStagingNotice();
}

function ensureActiveSession(ctx: ProjectContext): void {
  if (!ctx.activeSessionId || !ctx.sessions.has(ctx.activeSessionId)) {
    const created: ChatSession = { id: uid('sess'), title: '新会话', messages: [], autoTitleTriggered: false };
    ctx.sessions.set(created.id, created);
    ctx.activeSessionId = created.id;
    void ensureSessionSubscription(ctx, created.id);
  }
  if (viewContext === ctx) activeSessionId = ctx.activeSessionId;
}

function ensureSessionSubscription(ctx: ProjectContext, sid: string): Promise<void> {
  if (ctx.subscriptions.has(sid) || ctx.subscribing.has(sid)) return Promise.resolve();
  if (!ctx.sessions.has(sid)) return Promise.resolve();
  ctx.subscribing.add(sid);
  const key = `${ctx.project.id}:${sid}`;
  return onAiEvent(key, (ev) => handleEvent(ctx, sid, ev)).then((off) => {
    ctx.subscribing.delete(sid);
    if (ctx.subscriptions.has(sid)) off();
    else ctx.subscriptions.set(sid, off);
  }).catch((err) => {
    ctx.subscribing.delete(sid);
    console.error('AI 事件订阅失败:', err);
  });
}

/** 读取思考强度/工作区域设置回显（后端 settings 为事实源） */
async function loadEffort(): Promise<void> {
  try {
    const st = await getState();
    effortSelect.value = st.settings.llm.effort || 'low';
    autoSwitchAiWorkdir = panelOptions.fixedWorkareaPath
      ? true
      : panelOptions.workbenchIntegration && !!st.settings.autoSwitchAiWorkdir;
  } catch {
    /* 读取失败保持默认 low / 开启（与 Settings 默认一致） */
  }
  if (panelOptions.fixedWorkareaPath) {
    workareaRef = { serverId: null, name: panelOptions.fixedWorkareaPath };
    renderWorkareaChip();
  } else if (autoSwitchAiWorkdir) {
    // 开启自动切换时：初始工作区域默认本地；已有激活标签则跟随终端或浏览器
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

function handleEvent(ctx: ProjectContext, sid: string, ev: AiEvent): void {
  /* 事件回调必须使用其订阅所属项目上下文；项目切换后仍可在后台定稿/落盘，
     只有当前可见上下文才触碰 DOM。同步执行期间暂借旧引擎别名，结束后恢复。 */
  const previous = { project, sessions, pendingBy, expandedGroups, activeSessionId, eventContext };
  eventContext = ctx;
  project = ctx.project;
  sessions = ctx.sessions;
  pendingBy = ctx.pendingBy;
  expandedGroups = ctx.expandedGroups;
  activeSessionId = viewContext === ctx ? ctx.activeSessionId : '';
  try {
    handleEventBody(sid, ev);
  } finally {
    project = previous.project;
    sessions = previous.sessions;
    pendingBy = previous.pendingBy;
    expandedGroups = previous.expandedGroups;
    activeSessionId = previous.activeSessionId;
    eventContext = previous.eventContext;
  }
}

function handleEventBody(sid: string, ev: AiEvent): void {
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
    /* 工具活动行：瞬时展示，不进历史；锚定到发生时已生成文本位置（时序穿插），
       相邻重复行折叠为 ×N（锚点保留首次发生位置） */
    const cur = pendingBy.get(sid) ?? null;
    const p = cur ?? emptyPending();
    const label = ev.label ? `${ev.tool} ${ev.label}` : ev.tool;
    const last = p.tools[p.tools.length - 1];
    if (last && last.label === label) {
      last.count += 1;
    } else {
      p.tools.push({ label, count: 1, textLen: p.text.length, seq: ++toolSeq });
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
      seq: existing?.seq ?? ++toolSeq,
    });
    pendingBy.set(sid, p);
  } else if (ev.type === 'approval') {
    /* AI 申请切换到工作模式（suggest 模式的 request_agent_mode 工具）：弹确认框，
       不进动作卡；其余仍为 Agent 逐调用审批卡 */
    if (ev.action === 'request_agent_mode') {
      void handleModeRequest(eventContext!, sid, ev);
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
        seq: existing?.seq ?? ++toolSeq,
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
        seq: existing?.seq ?? ++toolSeq,
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
        seq: existing?.seq ?? ++toolSeq,
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
    if (ev.tool === 'py' && !ev.isError) window.dispatchEvent(new CustomEvent('aishell:data-changed'));
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
  if (eventContext === viewContext && sid === activeSessionId && !unmounted) {
    /* delta 高频到达（每秒数十条）：rAF 合帧只增量更新流式气泡，历史节点不动；
       其余事件低频，同步渲染（含 finalize 后追加定稿消息） */
    if (ev.type === 'delta') schedulePendingRender();
    else refreshActive();
    renderSessionBar();
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
  if (!s || !p || p.phase !== 'stream') {
    if (s) persistSession(s);
    return;
  }  const text = p.text.trim() ? p.text : '（AI 未返回内容，请重试或检查模型配置）';
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
  if (sid === activeSessionId) renderSessionBar();
}

/** 显式停止当前会话：中止后端并把手头文本定稿；切换会话不调用此函数。 */
function leaveSession(sid: string, ctx: ProjectContext | null = viewContext): void {
  if (!ctx) return;
  const p = ctx.pendingBy.get(sid) ?? null;
  ctx.pendingBy.set(sid, null);
  if (p && p.phase === 'stream' && p.text) {
    const s = ctx.sessions.get(sid);
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
      void persistSession(s, ctx);
    }
  }
  void aiAbort(`${ctx.project.id}:${sid}`).catch(() => { /* 后端无进程时静默 */ });
}

/** 模式切换跨「仅建议」边界时后端会重启本项目全部 pi 进程：把所有会话的生成中文本
 *  定稿并中止后端（与 leaveSession 同语义，逐会话处理） */
function leaveAllSessions(ctx: ProjectContext | null = viewContext): void {
  if (!ctx) return;
  [...ctx.sessions.keys()].forEach((sid) => leaveSession(sid, ctx));
}

/* ---------- 会话归档(转录 → sessionArchive → 前端移除;数据仍在 aishell.json,archived 标记) ---------- */

/** 转录大小上限:超长截断保留尾部(归档语义上近期内容更重要),头部标注截断标记 */
const TRANSCRIPT_MAX_BYTES = 64 * 1024;

/** 拼会话转录:标题 + [用户]/[AI] 逐条 content(不含快照/引用展开;LLM 只看对话正文) */
function buildTranscript(session: ChatSession): string {
  let out = `会话标题: ${session.title}\n\n`;
  for (const m of session.messages) {
    out += `[${m.role === 'user' ? '用户' : 'AI'}]\n${m.content}\n\n`;
  }
  if (out.length > TRANSCRIPT_MAX_BYTES) {
    const tail = out.slice(out.length - TRANSCRIPT_MAX_BYTES);
    // 截断点回退到最近的消息边界,避免从一条消息中间切开
    const boundary = tail.indexOf('\n\n[');
    out = `（转录过长,已截断早期内容）\n\n${boundary > 0 ? tail.slice(boundary + 2) : tail}`;
  }
  return out;
}

/** 归档成功后的前端收尾:移除会话 + 退订 + 活跃会话补位 + 通知笔记面板/打开笔记 */
function afterArchived(ctx: ProjectContext, sid: string, notePath: string): void {
  ctx.sessions.delete(sid);
  ctx.pendingBy.delete(sid);
  ctx.subscriptions.get(sid)?.();
  ctx.subscriptions.delete(sid);
  wbEvents.emit('notes-changed');
  if (viewContext === ctx) {
    if (ctx.activeSessionId === sid) {
      ctx.activeSessionId = '';
      ensureActiveSession(ctx);
    }
    activeSessionId = ctx.activeSessionId;
    renderSessionBar();
    renderHistory();
    updateSendBtn();
    void refreshStagingNotice();
  }
  if (notePath) {
    openNote(notePath);
    toast('已归档并生成笔记', 'success');
  } else {
    toast('会话已归档', 'success');
  }
}

/** 归档入口(右键菜单「归档会话」):拼转录 → ArchiveModal → sessionArchive → 收尾 */
function archiveSession(pid: string, sid: string): void {
  const ctx = viewContext;
  if (!ctx || ctx.project.id !== pid) return;
  const session = ctx.sessions.get(sid);
  if (!session) return;
  openArchiveModal({
    sessionTitle: session.title,
    onConfirm: ({ mode, title, dirRel, noteRel }) => sessionArchive({
      projectId: pid,
      sessionId: sid,
      mode,
      title,
      dirRel,
      noteRel,
      transcript: buildTranscript(session),
    }),
    onDone: (notePath) => afterArchived(ctx, sid, notePath),
  });
}

function enqueueSessionSnapshot(target: ProjectContext, snapshot: ChatSession): Promise<void> {
  const key = `${target.project.id}:${snapshot.id}`;
  const previous = target.persistQueues.get(key) ?? Promise.resolve();
  let current: Promise<void>;
  current = previous
    .catch(() => { /* 上一次失败不阻塞后续快照 */ })
    .then(() => sessionUpsert(target.project.id, snapshot))
    .catch((err) => {
      if (!unmounted && viewContext === target) toast(`会话保存失败：${String(err)}`, 'error');
      else console.error('[AI] 会话保存失败:', err);
    })
    .finally(() => {
      if (target.persistQueues.get(key) === current) target.persistQueues.delete(key);
    });
  target.persistQueues.set(key, current);
  return current;
}

function persistSession(s: ChatSession, ctx: ProjectContext | null = eventContext ?? viewContext): Promise<void> {
  const target = ctx ?? eventContext ?? viewContext;
  if (!target) return Promise.resolve();
  return enqueueSessionSnapshot(target, cloneChatSession(s));
}

function renderSessionBar(): void {
  const current = sessions.get(activeSessionId);
  const label = sessionSelect.querySelector('.ai-session-current');
  if (label) label.textContent = current?.title ?? (sessions.size ? '选择会话' : '加载会话中…');
  sessionMenu.innerHTML = '';
  sessions.forEach((s) => {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'ai-session-option';
    option.dataset.sessionId = s.id;
    option.setAttribute('role', 'option');
    option.setAttribute('aria-current', String(s.id === activeSessionId));
    option.innerHTML = `<span class="ai-session-title">${escapeHtml(s.title)}</span>`;
    if (isGenerating(s.id)) {
      const loading = document.createElement('span');
      loading.className = 'ai-session-loading';
      loading.setAttribute('role', 'status');
      loading.setAttribute('aria-label', '生成中');
      loading.innerHTML = icon('loader');
      option.appendChild(loading);
    }
    sessionMenu.appendChild(option);
  });
  sessionSelect.setAttribute('aria-expanded', String(sessionMenuOpen));
}

function closeSessionMenu(): void {
  sessionMenuOpen = false;
  if (sessionMenu) sessionMenu.hidden = true;
  if (sessionSelect) sessionSelect.setAttribute('aria-expanded', 'false');
}

function toggleSessionMenu(): void {
  sessionMenuOpen = !sessionMenuOpen;
  sessionMenu.hidden = !sessionMenuOpen;
  sessionSelect.setAttribute('aria-expanded', String(sessionMenuOpen));
  if (sessionMenuOpen) {
    const current = sessionMenu.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(activeSessionId)}"]`);
    current?.focus();
  }
}

function selectSession(sid: string): void {
  if (!sessions.has(sid)) return;
  activeSessionId = sid;
  saveViewContext();
  closeSessionMenu();
  renderSessionBar();
  renderHistory();
  updateSendBtn();
  void refreshStagingNotice();
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
  const textEl = document.createElement('div');
  textEl.className = 'ai-text';
  appendStreamBody(textEl, p);
  bubble.appendChild(textEl);
  wrap.appendChild(bubble);
  replacePending(wrap);
}

/** 工具行/动作卡统一为时序条目：按 textLen 锚点穿插进文本，同锚点按到达序号排序 */
interface StreamItem {
  el?: HTMLElement;
  html?: string;
  textLen?: number;
  seq?: number;
}

/** 流式体增量组装（语义与 interleaveActions 字符串版逐条对齐）：锚点条目（动作卡 +
 *  工具行）按 textLen 升序、同锚点按 seq 穿插文本段，无锚点条目排文本末尾；全部条目
 *  无锚点时整组前置（与原 renderPending 一致，typing 相位尚无文本时即此形态）。
 *  文本段经 appendSegNodes 复用缓存节点，卡片经 reuseCard 复用 DOM（append 移动）。 */
function appendStreamBody(container: HTMLElement, p: Pending): void {
  const items: StreamItem[] = [
    ...p.tools.map((t) => ({ el: toolLineEl(t), textLen: t.textLen, seq: t.seq })),
    ...[...p.actions.values()].map((c) => ({ el: reuseCard(c), textLen: c.textLen, seq: c.seq })),
  ];
  const anchored = items.some((i) => i.textLen != null);
  if (!anchored) {
    items.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    items.forEach((i) => container.appendChild(i.el!));
    if (p.text) appendSegNodes(container, p.text, 0);
    return;
  }
  const sorted = items.slice().sort((a, b) =>
    (a.textLen ?? Infinity) - (b.textLen ?? Infinity) || (a.seq ?? 0) - (b.seq ?? 0));
  let last = 0;
  for (const i of sorted) {
    const at = Math.min(i.textLen ?? p.text.length, p.text.length);
    if (at > last) appendSegNodes(container, p.text.slice(last, at), last);
    container.appendChild(i.el!);
    last = at;
  }
  if (last < p.text.length) appendSegNodes(container, p.text.slice(last), last);
}

/** 工具行元素（每帧重建：数量少、无内部状态；相邻重复折叠为 ×N 后缀） */
function toolLineEl(t: ToolLine): HTMLElement {
  const line = document.createElement('div');
  line.className = 'ai-tool-line';
  line.innerHTML = `${icon('wrench')}${escapeHtml(t.label)}${t.count > 1 ? ` ×${t.count}` : ''}`;
  return line;
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

/* ---------- 历史消息内嵌 token 还原（content 中 chip 文本形态 → 原位 chip） ---------- */

/** 历史消息引用的 chip 描述：token = 文本形态（与 chipToken 同规则），html = 展示 chip */
interface MessageToken {
  token: string;
  html: string;
}

/** 由消息的各引用数组构建 token 清单（顺序 = 各数组顺序；点击委托与输入区 chip 同一套 data 属性） */
function buildMessageTokens(m: ChatMsg): MessageToken[] {
  const out: MessageToken[] = [];
  const push = (token: string, id: string, kind: string, title: string): void => {
    out.push({
      token,
      html: `<span class="tag blue ai-msg-chip ai-msg-chip-inline" data-snap-id="${escapeHtml(id)}" data-kind="${kind}" title="${escapeHtml(title)}">${escapeHtml(token)}</span>`,
    });
  };
  m.snapshots.forEach((snap) => push(`@term:${snap.id}`, snap.id, 'term', '点击查看快照全文'));
  m.fileRefs.forEach((ref) => {
    const n = ref.path.split(/[\\/]/).pop() || ref.path;
    push(`@${n}_${ref.startLine}_${ref.endLine}`, ref.id, 'file', `点击查看文件引用 · ${ref.path} 第${ref.startLine}-${ref.endLine}行`);
  });
  (m.serverRefs ?? []).forEach((r) => {
    const label = r.serverId ? `@remote:${r.name}` : '@local';
    push(label, serverRefKey(r), 'server', r.serverId ? `引用服务器「${r.name}」` : '引用本地终端');
  });
  (m.pathRefs ?? []).forEach((r) => {
    const name = r.path.split('/').filter(Boolean).pop() || r.path;
    push(r.isDir ? `@path:${name}` : `@file:${name}`, pathRefKey(r), 'path', `引用路径${r.serverId ? `（服务器 ${r.serverId}）` : ''} ${r.path}`);
  });
  (m.browserRefs ?? []).forEach((r) =>
    push(`@browser:${r.name}`, `${r.name}:${r.ts}`, 'browser', `点击查看元素引用（${r.url}）`));
  (m.browserPageRefs ?? []).forEach((r) =>
    push(`@page:${pageRefLabel(r)}`, '', 'page', `浏览器页面引用 ${pageRefLabel(r)}（${r.url}）`));
  (m.skillRefs ?? []).forEach((r) =>
    push(`@skill:${r.name}`, skillRefKey(r), 'skill', `技能引用「${r.name}」（${r.origin === 'global' ? '全局' : '项目'}）`));
  return out;
}

/** content 内嵌 token 原位还原为 chip：同名 token 按出现顺序消费第 i 个引用；
 *  返回 HTML 与命中数（0 = 旧会话 content 无 token，回退消息上方 chip 行布局） */
function renderContentWithTokens(content: string, tokens: MessageToken[]): { html: string; matched: number } {
  if (!tokens.length || !content) return { html: '', matched: 0 };
  const byToken = new Map<string, MessageToken[]>();
  for (const t of tokens) {
    const arr = byToken.get(t.token) ?? [];
    arr.push(t);
    byToken.set(t.token, arr);
  }
  const cursor = new Map<string, number>();
  let html = '';
  let i = 0;
  let matched = 0;
  while (i < content.length) {
    let best: { token: string; at: number } | null = null;
    for (const token of byToken.keys()) {
      const at = content.indexOf(token, i);
      if (at < 0) continue;
      // 同位置优先更长的 token（如 @term:x1 是 @term:x12 的前缀）
      if (!best || at < best.at || (at === best.at && token.length > best.token.length)) best = { token, at };
    }
    if (!best) break;
    if (best.at > i) html += escapeHtml(content.slice(i, best.at));
    const idx = cursor.get(best.token) ?? 0;
    const list = byToken.get(best.token) ?? [];
    if (idx < list.length) {
      html += list[idx].html;
      cursor.set(best.token, idx + 1);
      matched += 1;
    } else {
      html += escapeHtml(best.token); // 引用数据缺失（理论上不会）：按原文展示
    }
    i = best.at + best.token.length;
  }
  if (i < content.length) html += escapeHtml(content.slice(i));
  return { html, matched };
}

function renderMessage(m: ChatMsg, sid: string): HTMLElement {
  const wrap = document.createElement('div');
  if (m.role === 'user') {
    wrap.className = 'ai-msg user';
    // 历史消息的快照/文件引用全文也进 map，chip 点击可查看
    m.snapshots.forEach((snap) => snapshots.set(snap.id, snap));
    m.fileRefs.forEach((ref) => fileRefs.set(ref.id, ref));
    (m.browserRefs ?? []).forEach((r) => browserRefs.set(`${r.name}:${r.ts}`, r));
    (m.imageRefs ?? []).forEach((r) => historyImageRefs.set(r.id, r));
    /* 新版消息 content 内嵌 token：按 token 原位还原内嵌 chip（保留引用与文字的顺序）；
       旧会话 content 无 token（matched=0）→ 回退为消息上方 chip 行（历史布局） */
    const tokens = buildMessageTokens(m);
    const { html, matched } = renderContentWithTokens(m.content, tokens);
    const legacyChips = matched > 0 ? '' : tokens.map((t) => t.html).join('');
    /* 图片附件：文字下方缩略图行（点击弹大图；加载失败红边显示文件名） */
    const imgsHtml = (m.imageRefs ?? [])
      .map((r) =>
        `<button type="button" class="ai-img-thumb" data-snap-id="${escapeHtml(r.id)}" data-kind="image" data-img-path="${escapeHtml(r.path)}" data-img-name="${escapeHtml(r.name)}" title="${escapeHtml(r.name)} · 点击查看大图">${escapeHtml(r.name)}</button>`,
      )
      .join('');
    wrap.innerHTML =
      `<div class="ai-bubble">${legacyChips ? `<div class="ai-msg-chips">${legacyChips}</div>` : ''}` +
      `<div class="ai-text">${matched > 0 ? html : escapeHtml(m.content)}</div>${imgsHtml ? `<div class="ai-msg-images">${imgsHtml}</div>` : ''}</div>`;
    wrap.querySelectorAll('.ai-img-thumb').forEach((el) => hydrateImageThumb(el as HTMLElement));
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
  const toolLineHtml = (t: ToolLine): string =>
    `<div class="ai-tool-line">${icon('wrench')}${escapeHtml(t.label)}${t.count > 1 ? ` ×${t.count}` : ''}</div>`;
  /* 工具行与动作卡合并为时序条目（同锚点/无文本时按到达序号排序） */
  const items: StreamItem[] = [
    ...p.tools.map((t) => ({ html: toolLineHtml(t), textLen: t.textLen, seq: t.seq })),
    ...[...p.actions.values()].map((a) => ({ html: renderActionCard(a), textLen: a.textLen, seq: a.seq })),
  ];
  if (p.phase === 'typing' || (p.phase === 'stream' && !p.text)) {
    const headItems = items.slice().sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
      .map((i) => i.html).join('');
    wrap.innerHTML =
      `<div class="ai-bubble">${headItems}` +
      '<span class="ai-typing"><span class="ai-typing-label">正在输入</span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span></span></div>';
  } else if (p.phase === 'error') {
    wrap.innerHTML = `<div class="ai-bubble error"><div class="ai-text">${escapeHtml(p.error ?? '')}</div></div>`;
  } else {
    /* 流式:工具行/动作卡按 textLen 锚点穿插进已生成文本(与历史时序排版同规则);
       全部无锚点时整组前置(尚无文本即发生工具调用的形态) */
    const anchored = items.some((i) => i.textLen != null);
    const body = anchored
      ? interleaveActions(p.text, items)
      : `${items.map((i) => i.html).join('')}${renderAI(p.text)}`;
    wrap.innerHTML = `<div class="ai-bubble"><div class="ai-text">${body}</div></div>`;
  }
  return wrap;
}

/** 把工具行/动作卡按 textLen 锚点穿插进文本:时间顺序排版(文本段 → 条目 → 文本段),
 *  同锚点条目按 seq(到达序号)排序;无锚点的条目按序排在文本末尾(兼容旧记录)。锚点是
 *  content 的字符偏移,text 只增不减故偏移稳定;锚点恰好落在 ``` 围栏中间的概率极低
 *  (工具边界即文本分段点)。 */
function interleaveActions(text: string, cards: StreamItem[]): string {
  const sorted = [...cards].sort((a, b) =>
    (a.textLen ?? Infinity) - (b.textLen ?? Infinity) || (a.seq ?? 0) - (b.seq ?? 0));
  let out = '';
  let last = 0;
  for (const c of sorted) {
    const at = Math.min(c.textLen ?? text.length, text.length);
    if (at > last) out += renderAI(text.slice(last, at));
    out += c.html ?? '';
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

/** 在内置浏览器标签页打开地址（浏览器引擎活跃页面导航；标签页固定 id 去重激活） */
async function openUrlInBrowser(url: string): Promise<void> {
  try {
    await openInActivePage(url);
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
async function handleModeRequest(ctx: ProjectContext, sid: string, ev: Extract<AiEvent, { type: 'approval' }>): Promise<void> {
  const previous = { project, sessions, pendingBy, expandedGroups, activeSessionId, eventContext };
  eventContext = ctx;
  project = ctx.project;
  sessions = ctx.sessions;
  pendingBy = ctx.pendingBy;
  expandedGroups = ctx.expandedGroups;
  activeSessionId = viewContext === ctx ? ctx.activeSessionId : '';
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
  project = previous.project;
  sessions = previous.sessions;
  pendingBy = previous.pendingBy;
  expandedGroups = previous.expandedGroups;
  activeSessionId = previous.activeSessionId;
  eventContext = previous.eventContext;
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
    const kind = chip.dataset.kind ?? '';
    // 服务器/路径/技能/页面引用无详情弹窗（title 已带说明）
    if (kind === 'server' || kind === 'path' || kind === 'skill' || kind === 'page') return;
    if (kind === 'file') openFileRefModal(fileRefs.get(id));
    else if (kind === 'browser') openBrowserRefModal(browserRefs.get(id));
    else if (kind === 'image') openImageModal(historyImageRefs.get(id) ?? inputImageRefs.get(id));
    else openSnapModal(snapshots.get(id)); // term 与旧消息无 kind 的快照 chip
  }
}

/* ---------- 输入区内嵌引用 chip（contenteditable 原子元素，可穿插在文字中） ---------- */

/** 服务器/本地引用 key：serverId 为空 = 本地终端 */
function serverRefKey(r: ServerRef): string {
  return r.serverId ?? 'local';
}

/** 文件/目录路径引用 key：远端引用带服务器前缀，本地引用仅路径（与本地 explorer 旧数据一致） */
function pathRefKey(r: PathRef): string {
  return r.serverId ? `${r.serverId}:${r.path}` : r.path;
}

/** 技能引用 key：来源 + 名称（全局/项目同名技能并存） */
function skillRefKey(r: SkillRef): string {
  return `${r.origin}:${r.name}`;
}

/** 浏览器页面引用显示标签：页面标题 → URL host */
function pageRefLabel(r: BrowserPageRef): string {
  if (r.title) return r.title;
  try {
    return new URL(r.url).hostname || r.url;
  } catch {
    return r.url;
  }
}

/** chip 的文本形态（= 落盘 content 中的内嵌 token；历史渲染按 token 原位还原 chip） */
function chipToken(kind: string, id: string): string {
  switch (kind) {
    case 'term': {
      const sn = snapshots.get(id);
      return sn ? `@term:${sn.id}` : '';
    }
    case 'file': {
      const r = fileRefs.get(id);
      if (!r) return '';
      const n = r.path.split(/[\\/]/).pop() || r.path;
      return `@${n}_${r.startLine}_${r.endLine}`;
    }
    case 'server': {
      const r = serverRefs.get(id);
      return r ? (r.serverId ? `@remote:${r.name}` : '@local') : '';
    }
    case 'path': {
      const r = pathRefs.get(id);
      if (!r) return '';
      const n = r.path.split('/').filter(Boolean).pop() || r.path;
      return r.isDir ? `@path:${n}` : `@file:${n}`;
    }
    case 'browser': {
      const r = browserRefs.get(id);
      return r ? `@browser:${r.name || r.tagName}` : '';
    }
    case 'skill': {
      const r = skillRefs.get(id);
      return r ? `@skill:${r.name}` : '';
    }
    case 'page': {
      const r = pageRefs.get(id);
      return r ? `@page:${pageRefLabel(r)}` : '';
    }
    default:
      return '';
  }
}

/** 内嵌 chip 元素：原子元素（contenteditable=false），✕ 移除，点击主体查看详情 */
function makeInlineChip(kind: string, id: string, label: string, title: string): HTMLElement {
  const c = document.createElement('span');
  c.className = 'ai-inline-chip';
  c.contentEditable = 'false';
  c.dataset.kind = kind;
  c.dataset.id = id;
  c.title = title;
  c.innerHTML = `<span class="ai-chip-label">${escapeHtml(label)}</span><span class="ai-chip-x" title="移除">${icon('x')}</span>`;
  return c;
}

/** 在光标处插入 chip（无可用光标时追加末尾）；chip 后补空格并把光标移到空格后 */
function insertChipEl(chip: HTMLElement): void {
  input.focus();
  const sel = window.getSelection();
  let range: Range | null = null;
  if (sel && sel.rangeCount && input.contains(sel.anchorNode)) {
    range = sel.getRangeAt(0);
  } else if (savedRange && input.contains(savedRange.commonAncestorContainer)) {
    range = savedRange.cloneRange();
  }
  if (range) {
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    range.deleteContents();
    range.insertNode(chip);
  } else {
    input.appendChild(chip);
  }
  const space = document.createTextNode(' ');
  chip.after(space);
  const caret = document.createRange();
  caret.setStart(space, 1);
  caret.collapse(true);
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(caret);
  }
  savedRange = caret.cloneRange();
}

/** 终端快照 chip：@term:<id>（与其他 @kind:名称 形态标签命名对齐） */
function insertTermChip(snap: TermSnapshot): void {
  insertChipEl(makeInlineChip('term', snap.id, `@term:${snap.id}`, '终端命令快照，点击查看全文，✕ 移除'));
}

/** 文件引用 chip：@文件名_起始行_结束行号 */
function insertFileChip(ref: FileRef): void {
  const name = ref.path.split(/[\\/]/).pop() || ref.path;
  insertChipEl(makeInlineChip('file', ref.id, `@${name}_${ref.startLine}_${ref.endLine}`,
    `点击查看文件引用，✕ 移除 · ${ref.path} 第${ref.startLine}-${ref.endLine}行`));
}

/** 服务器/本地终端引用 chip：@remote:服务器名称 / @local */
function insertServerChip(ref: ServerRef): void {
  const key = serverRefKey(ref);
  const label = ref.serverId ? `@remote:${ref.name}` : '@local';
  insertChipEl(makeInlineChip('server', key, label,
    ref.serverId ? `引用服务器「${ref.name}」，✕ 移除` : '引用本地终端，✕ 移除'));
}

/** 文件/目录路径引用 chip：标签只用路径最后一段（@file:文件名 / @path:目录名），title 带完整路径与服务器 */
function insertPathChip(ref: PathRef): void {
  const key = pathRefKey(ref);
  const name = ref.path.split('/').filter(Boolean).pop() || ref.path;
  const label = ref.isDir ? `@path:${name}` : `@file:${name}`;
  insertChipEl(makeInlineChip('path', key, label,
    `${ref.serverId ? `[服务器 ${ref.serverId}] ` : ''}${ref.path}，✕ 移除`));
}

/** 浏览器元素引用 chip：@browser:#id 或标签名，title 带页面地址，点击查看元素详情 */
function insertBrowserChip(ref: BrowserRef, key: string): void {
  insertChipEl(makeInlineChip('browser', key, `@browser:${ref.name || ref.tagName}`,
    `页面元素引用 ${ref.name}（${ref.url}），点击查看元素 HTML，✕ 移除`));
}

/** 技能引用 chip：@skill:名称，title 带来源 */
function insertSkillChip(ref: SkillRef): void {
  insertChipEl(makeInlineChip('skill', skillRefKey(ref), `@skill:${ref.name}`,
    `技能引用「${ref.name}」（${ref.origin === 'global' ? '全局' : '项目'}），✕ 移除`));
}

/** 浏览器页面引用 chip：@page:页面标题（@ 补全插入；发送时展开页面地址与标题） */
function insertPageChip(ref: BrowserPageRef): void {
  const id = uid('page');
  pageRefs.set(id, ref);
  insertChipEl(makeInlineChip('page', id, `@page:${pageRefLabel(ref)}`,
    `浏览器页面引用 ${pageRefLabel(ref)}（${ref.url}），✕ 移除`));
}

/** 输入区 chip 点击（委托）：✕ 移除；主体打开详情弹窗（与历史 chip 同一套） */
function onInlineChipClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const chip = target.closest('.ai-inline-chip') as HTMLElement | null;
  if (!chip) return;
  const id = chip.dataset.id ?? '';
  if (target.closest('.ai-chip-x')) {
    /* 状态 Map 必须与 chip DOM 同步删除:残留会导致再次添加同一引用被误判
       「该引用已在输入框中」(与旧版 chip-row ✕ 路径同语义) */
    const kind = chip.dataset.kind ?? '';
    if (kind === 'term') snapshots.delete(id);
    else if (kind === 'file') fileRefs.delete(id);
    else if (kind === 'server') serverRefs.delete(id);
    else if (kind === 'path') pathRefs.delete(id);
    else if (kind === 'browser') browserRefs.delete(id);
    else if (kind === 'page') pageRefs.delete(id);
    else if (kind === 'skill') skillRefs.delete(id);
    chip.remove();
    input.focus();
    return;
  }
  const kind = chip.dataset.kind ?? '';
  if (kind === 'file') openFileRefModal(fileRefs.get(id));
  else if (kind === 'browser') openBrowserRefModal(browserRefs.get(id));
  else if (kind === 'term') openSnapModal(snapshots.get(id));
}

/** 缩略图容器填充：加载中占位（固定尺寸），成功替换为 <img>，失败红边显示文件名 */
function hydrateImageThumb(el: HTMLElement): void {
  const path = el.dataset.imgPath ?? '';
  const name = el.dataset.imgName ?? '图片';
  void loadImageData(path).then((out) => {
    if (!el.isConnected) return;
    if (!out) {
      el.classList.add('ai-img-error');
      el.textContent = name;
      return;
    }
    const img = document.createElement('img');
    img.src = `data:${out.mime};base64,${out.data}`;
    img.alt = name;
    el.replaceChildren(img);
  });
}

/** 图片附件 chip：缩略图 + 名称，点击预览大图，✕ 移除 */
function addImageRefChip(ref: ImageRef): void {
  const c = document.createElement('span');
  c.className = 'tag blue ai-snap-chip ai-img-chip';
  c.dataset.id = ref.id;
  c.dataset.kind = 'image';
  c.title = `图片附件「${ref.name}」，点击预览，✕ 移除`;
  c.innerHTML =
    `<span class="ai-img-chip-thumb" data-img-path="${escapeHtml(ref.path)}" data-img-name="${escapeHtml(ref.name)}"></span>` +
    `<span class="ai-img-name">${escapeHtml(ref.name)}</span><span class="ai-chip-x" title="移除">${icon('x')}</span>`;
  chipRow.appendChild(c);
  hydrateImageThumb(c.querySelector('.ai-img-chip-thumb') as HTMLElement);
}

/** 图片附件详情：来源/大小说明 + 大图（等比缩放，超大图不撑破 modal） */
function openImageModal(ref: ImageRef | undefined): void {
  if (!ref) return;
  const originText =
    ref.source === 'remote'
      ? `远程 · ${ref.originPath ?? ''}`
      : ref.source === 'local'
        ? `本地 · ${ref.originPath ?? ''}`
        : '剪贴板粘贴';
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:720px">
      <div class="modal-head"><h3>图片 · ${escapeHtml(ref.name)}</h3><button class="icon-btn ai-modal-x" title="关闭">${icon('x')}</button></div>
      <div class="modal-body">
        <div class="ai-snap-command mono">${escapeHtml(originText)} · ${(ref.size / 1024).toFixed(0)} KB · ${escapeHtml(ref.mime)}</div>
        <div class="ai-img-view">加载中…</div>
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
  const box = mask.querySelector('.ai-img-view') as HTMLElement;
  void loadImageData(ref.path).then((out) => {
    if (!box.isConnected) return;
    if (!out) {
      box.textContent = '图片加载失败（文件可能已被移动或删除）';
      return;
    }
    const img = document.createElement('img');
    img.src = `data:${out.mime};base64,${out.data}`;
    img.alt = ref.name;
    box.replaceChildren(img);
  });
}

const clearChips = (): void => {
  chipRow.innerHTML = '';
  input.innerHTML = '';
  /* 状态 Map 必须与 chip DOM 同步清空:此前只清 DOM,serverRefs 等残留导致
     发送后重新添加同一引用被误判「该引用已在输入框中」(与 chip ✕ 移除路径同语义) */
  snapshots.clear();
  fileRefs.clear();
  serverRefs.clear();
  pathRefs.clear();
  browserRefs.clear();
  pageRefs.clear();
  skillRefs.clear();
  inputImageRefs.clear();
  savedRange = null;
  renderWorkareaChip(); // 固定工作区域标签不随发送清空，重新挂载
};

/** 固定工作区域标签（不可移除）：输入框上方 chip 行首位（#ai-workarea-slot），
 *  显示 @local / @remote:服务器名称 / @browser，随激活终端自动切换；独立槽位保证始终在行首 */
function renderWorkareaChip(): void {
  if (!autoSwitchAiWorkdir) {
    workareaChipEl = null;
    workareaSlot.replaceChildren();
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
    workareaSlot.replaceChildren(c);
    workareaChipEl = c;
    return;
  }
  if (!workareaRef) workareaRef = { serverId: null, name: '本地终端' };
  const fixedPath = panelOptions.fixedWorkareaPath;
  const label = fixedPath ? '@tasks' : workareaRef.serverId ? `@remote:${workareaRef.name}` : '@local';
  const title = fixedPath
    ? `当前 AI 工作区域：${fixedPath}`
    : workareaRef.serverId
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
  workareaSlot.replaceChildren(c);
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
    input.querySelectorAll(`.ai-inline-chip[data-kind="server"][data-id="${CSS.escape(key)}"]`).forEach((el) => el.remove());
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

/** 图片附件行点击（引用 tag 已内嵌输入框，此行只剩图片 chip）：✕ 移除 / 点击预览 */
function onChipRowClick(e: MouseEvent): void {
  const target = e.target as HTMLElement;
  const chip = target.closest('.ai-snap-chip') as HTMLElement | null;
  if (!chip || chip.dataset.kind !== 'image') return;
  const id = chip.dataset.id ?? '';
  if (target.closest('.ai-chip-x')) {
    inputImageRefs.delete(id);
    chip.remove();
    return;
  }
  openImageModal(inputImageRefs.get(id));
}

function openSnapModal(snap: TermSnapshot | undefined): void {
  if (!snap) return;
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `
    <div class="modal" style="width:560px">
      <div class="modal-head"><h3>终端快照 · @term:${escapeHtml(snap.id)}</h3><button class="icon-btn ai-modal-x" title="关闭">${icon('x')}</button></div>
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

/** 图片附件统一入口：数量上限 → vision 模型门槛 → 后端物化（嗅探+落盘）→ 输入区出 chip。
 *  粘贴剪贴板 / explorer、SFTP 拖拽与右键添加共用；失败整批 toast（后端任一项失败即报错）。 */
async function attachImages(items: AttachImageItem[]): Promise<void> {
  if (!items.length) return;
  const ctx = viewContext;
  const proj = project;
  if (!ctx || !proj) {
    toast('项目未加载', 'error');
    return;
  }
  if (inputImageRefs.size + items.length > MAX_ATTACH_IMAGES) {
    toast(`单条消息最多附加 ${MAX_ATTACH_IMAGES} 张图片`, 'error');
    return;
  }
  try {
    const st = await getState();
    if (!supportsVisionModel(st.settings.llm.modelId)) {
      toast('当前模型不支持图片，请先在设置中切换为 vision 模型', 'error');
      return;
    }
  } catch {
    /* 后端未就绪时放行，由 ai_attach_images / 发送侧兜底报错 */
  }
  let attached;
  try {
    attached = await aiAttachImages(proj.id, items);
  } catch (err) {
    toast(String(err), 'error');
    return;
  }
  items.forEach((item, i) => {
    const a = attached[i];
    if (!a) return;
    const ref: ImageRef = {
      id: uid('img'),
      source: item.source,
      name: a.name,
      mime: a.mime,
      path: a.path,
      originPath: item.source === 'clipboard' ? undefined : item.path,
      serverId: item.source === 'remote' ? item.serverId : null,
      size: a.size,
      ts: Date.now(),
    };
    inputImageRefs.set(ref.id, ref);
    addImageRefChip(ref);
  });
}

/** File -> 不带 dataURL 前缀的 base64（FileReader，与 explorer OS 导入同模式） */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result ?? '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`));
    reader.readAsDataURL(file);
  });
}

/** 从剪贴板/拖拽 DataTransfer 提取图片文件（粘贴多张与资源管理器多选复制都走这里；按名称去重） */
function extractImageFiles(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const seen = new Set<string>();
  const out: File[] = [];
  const push = (f: File | null): void => {
    if (!f) return;
    const isImage = f.type.startsWith('image/') || IMAGE_EXT_RE.test(f.name);
    if (!isImage || seen.has(f.name + f.size)) return;
    seen.add(f.name + f.size);
    out.push(f);
  };
  if (dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file') push(item.getAsFile());
    }
  } else {
    Array.from(dt.files).forEach(push);
  }
  return out;
}

/** 输入框粘贴：含图片文件时拦截默认行为并转为附件（一次可多张）；
 *  文本粘贴统一以纯文本插入（contenteditable 默认会带富文本格式） */
function onInputPaste(e: ClipboardEvent): void {
  const files = extractImageFiles(e.clipboardData);
  if (files.length) {
    e.preventDefault();
    void Promise.all(files.map(async (f) => ({ source: 'clipboard' as const, name: f.name, data: await readFileAsBase64(f) })))
      .then(attachImages)
      .catch((err) => toast(String(err), 'error'));
    return;
  }
  const text = e.clipboardData?.getData('text/plain');
  if (typeof text === 'string' && text) {
    e.preventDefault();
    document.execCommand('insertText', false, text);
  }
}

/** 输入区拖放：①应用内 explorer/SFTP 拖拽载荷（DND_MIME，图片扩展名）②OS 文件拖入。
 *  两者都不是时不拦截（保留文本拖放等默认行为）。 */
function onInputAreaDrop(e: DragEvent): void {
  const area = e.currentTarget as HTMLElement;
  area.classList.remove('ai-drag-over');
  const dt = e.dataTransfer;
  if (!dt) return;
  const raw = dt.getData(DND_MIME);
  if (raw) {
    try {
      const p = JSON.parse(raw) as { source: 'local' | 'remote'; path: string; name: string; isDir: boolean; serverId?: string };
      e.preventDefault();
      if (p.isDir) {
        toast('目录不能作为图片附件');
        return;
      }
      if (!IMAGE_EXT_RE.test(p.name)) {
        toast('仅支持 PNG / JPEG / GIF / WebP 图片');
        return;
      }
      void attachImages([
        p.source === 'remote'
          ? { source: 'remote', serverId: p.serverId ?? '', path: p.path }
          : { source: 'local', path: p.path },
      ]);
      return;
    } catch {
      /* 载荷损坏按 OS 文件分支处理 */
    }
  }
  const files = extractImageFiles(dt);
  if (!files.length) return;
  e.preventDefault();
  void Promise.all(files.map(async (f) => ({ source: 'clipboard' as const, name: f.name, data: await readFileAsBase64(f) })))
    .then(attachImages)
    .catch((err) => toast(String(err), 'error'));
}

/* ---------- @ 自动补全（输入框内输入 @ 唤起；Enter/Tab 选中，Esc 关闭） ---------- */

function isMentionOpen(): boolean {
  return !!mentionEl && mentionEl.isConnected;
}

/** 弹层挂 #ai-input-row（position:relative），覆盖在输入行上方 */
function ensureMentionEl(): void {
  if (mentionEl && mentionEl.isConnected) return;
  const el = document.createElement('div');
  el.className = 'ai-mention-pop';
  el.style.display = 'none';
  el.addEventListener('mousedown', (e) => e.preventDefault()); // 不抢输入焦点
  el.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('[data-mention-key]');
    if (!item) return;
    const idx = mentionItems.findIndex((it) => it.key === item.dataset.mentionKey);
    if (idx >= 0) {
      mentionIndex = idx;
      void applyMentionActive();
    }
  });
  inputBox.parentElement?.appendChild(el);
  mentionEl = el;
}

/** 组装补全候选：浏览器页面 / 远程服务器 / 本地文件 / 本地目录 / 终端最后一条命令 */
function buildMentionItems(): MentionItem[] {
  const items: MentionItem[] = [];
  if (panelOptions.workbenchIntegration) getBrowserPagesForMention().forEach((p) => {
    items.push({
      key: `page-${p.id}`,
      group: '浏览器页面',
      icon: 'globe',
      label: `@page:${p.title}`,
      hint: p.url,
      keywords: `page 浏览器 browser ${p.title} ${p.url}`,
      apply: () => insertPageChip({ url: p.url, title: p.title, ts: Date.now() }),
    });
  });
  if (panelOptions.workbenchIntegration) (serversCache ?? []).forEach((sv) => {
    items.push({
      key: `server-${sv.id}`,
      group: '远程服务器',
      icon: 'monitor',
      label: `@remote:${sv.name}`,
      hint: `${sv.username}@${sv.host}:${sv.port}`,
      keywords: `remote server 服务器 ${sv.name} ${sv.host}`,
      apply: () => {
        const ref: ServerRef = { serverId: sv.id, name: sv.name };
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
        insertServerChip(ref);
      },
    });
  });
  const termApi = panelOptions.workbenchIntegration ? getActiveTerminalApi() : null;
  if (termApi) {
    items.push({
      key: 'term-last',
      group: '终端',
      icon: 'terminal',
      label: '终端最后一条命令（输出快照）',
      hint: '@term:',
      keywords: 'term terminal 终端 命令 快照 snapshot',
      apply: () => {
        const snap = termApi.takeSnapshot();
        if (!snap.command && !snap.content) {
          toast('终端还没有可引用的命令输出');
          return;
        }
        snapshots.set(snap.id, snap);
        insertTermChip(snap);
      },
    });
  }
  return items;
}

/** 输入事件驱动：光标前文本以「@query」结尾（@ 前是起点或非单词字符，避免邮箱中段误触发）时打开弹层 */
function updateMention(): void {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.isCollapsed || !input.contains(sel.anchorNode)) {
    closeMention();
    return;
  }
  const range = sel.getRangeAt(0);
  if (range.startContainer.nodeType !== Node.TEXT_NODE) {
    closeMention();
    return;
  }
  const node = range.startContainer as Text;
  const before = (node.nodeValue ?? '').slice(0, range.startOffset);
  const m = /(?:^|[^\w@])@([^\s@]*)$/.exec(before);
  if (!m) {
    closeMention();
    return;
  }
  const query = m[1];
  const at = before.length - query.length - 1; // '@' 在文本节点中的偏移
  ensureMentionEl();
  mentionAnchor = { node, at };
  mentionIndex = 0;
  if (panelOptions.workbenchIntegration && !serversCache) {
    void getState().then((st) => {
      serversCache = st.servers;
      if (isMentionOpen()) renderMention(mentionQuery);
    }).catch(() => { /* 拉取失败仅缺服务器分组 */ });
  }
  renderMention(query);
}

function renderMention(query: string): void {
  mentionQuery = query;
  if (!mentionEl) return;
  const q = query.toLowerCase();
  const items = buildMentionItems()
    .filter((it) => !q || it.keywords.toLowerCase().includes(q) || it.label.toLowerCase().includes(q));
  mentionItems = items;
  if (!items.length) {
    closeMention();
    return;
  }
  if (mentionIndex >= items.length) mentionIndex = 0;
  const seenGroups: string[] = [];
  let html = '';
  items.forEach((it, i) => {
    if (!seenGroups.includes(it.group)) {
      seenGroups.push(it.group);
      html += `<div class="ai-mention-group">${escapeHtml(it.group)}</div>`;
    }
    html += `<button type="button" class="ai-mention-item${i === mentionIndex ? ' active' : ''}" data-mention-key="${escapeHtml(it.key)}">${icon(it.icon)}<span class="ai-mention-label">${escapeHtml(it.label)}</span>${it.hint ? `<span class="ai-mention-hint">${escapeHtml(it.hint)}</span>` : ''}</button>`;
  });
  mentionEl.innerHTML = html;
  mentionEl.style.display = 'block';
  mentionEl.querySelector('.ai-mention-item.active')?.scrollIntoView({ block: 'nearest' });
}

function moveMention(delta: number): void {
  if (!mentionItems.length) return;
  mentionIndex = (mentionIndex + delta + mentionItems.length) % mentionItems.length;
  const rows = mentionEl?.querySelectorAll<HTMLElement>('.ai-mention-item') ?? [];
  rows.forEach((el) => el.classList.remove('active'));
  const active = rows[mentionIndex];
  active?.classList.add('active');
  active?.scrollIntoView({ block: 'nearest' });
}

/** 应用当前选中项：删除「@query」文本 → 执行 apply（插入 chip / 打开文件对话框） */
async function applyMentionActive(): Promise<void> {
  const item = mentionItems[mentionIndex];
  const anchor = mentionAnchor;
  closeMention();
  if (!item) return;
  if (!anchor || !anchor.node.isConnected || !input.contains(anchor.node)) {
    await item.apply();
    return;
  }
  const sel = window.getSelection();
  const end = sel && sel.anchorNode === anchor.node ? sel.anchorOffset : anchor.node.nodeValue?.length ?? 0;
  const range = document.createRange();
  range.setStart(anchor.node, Math.min(anchor.at, end));
  range.setEnd(anchor.node, Math.max(Math.min(anchor.at, end), end));
  if (sel) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  range.deleteContents();
  savedRange = range.cloneRange();
  await item.apply();
}

function closeMention(): void {
  mentionAnchor = null;
  mentionItems = [];
  mentionIndex = 0;
  mentionQuery = '';
  if (mentionEl) {
    mentionEl.remove();
    mentionEl = null;
  }
}

/** 生成状态切换：右下角「Enter 发送」小字 ↔ 中断图标按钮（点击/Enter 停止生成） */
function updateSendBtn(): void {
  const generating = isGenerating(activeSessionId);
  sendBtn.hidden = !generating;
  const hint = sendBtn.parentElement?.querySelector<HTMLElement>('.ai-input-hint');
  if (hint) hint.style.display = generating ? 'none' : '';
}

/** 是否正在生成（错误气泡不算生成中，允许继续发新消息） */
function isGenerating(sid: string): boolean {
  const p = pendingBy.get(sid) ?? null;
  return !!p && p.phase !== 'error';
}

/* ---------- 输入区内容读取（contenteditable → 有序段） ---------- */

/** 输入区内容段：文本段与内嵌 chip 段（顺序即输入框视觉顺序；发送展开与落盘都按此顺序） */
type InputSegment = { kind: 'text'; text: string } | { kind: 'chip'; chipKind: string; id: string };

/** chip 引用数据（发送时捕获的快照；buildPrompt 展开用，不依赖输入区全局 Map） */
type ChipDatum =
  | { kind: 'term'; snap: TermSnapshot }
  | { kind: 'file'; ref: FileRef }
  | { kind: 'server'; ref: ServerRef }
  | { kind: 'path'; ref: PathRef }
  | { kind: 'browser'; ref: BrowserRef }
  | { kind: 'page'; ref: BrowserPageRef }
  | { kind: 'skill'; ref: SkillRef };

function readInputSegments(): InputSegment[] {
  const segs: InputSegment[] = [];
  const pushText = (t: string): void => {
    if (!t) return;
    const last = segs[segs.length - 1];
    if (last && last.kind === 'text') last.text += t;
    else segs.push({ kind: 'text', text: t });
  };
  const walkInline = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.classList.contains('ai-inline-chip')) {
      segs.push({ kind: 'chip', chipKind: el.dataset.kind ?? '', id: el.dataset.id ?? '' });
      return;
    }
    if (el.tagName === 'BR') {
      pushText('\n');
      return;
    }
    if (el.tagName === 'DIV' || el.tagName === 'P') {
      // 嵌套块级（粘贴残留）：按行处理，行前补换行
      if (segs.length > 0) pushText('\n');
      el.childNodes.forEach(walkInline);
      return;
    }
    el.childNodes.forEach(walkInline);
  };
  input.childNodes.forEach((node, i) => {
    const isLast = i === input.childNodes.length - 1;
    if (node.nodeType === Node.ELEMENT_NODE
      && ((node as HTMLElement).tagName === 'DIV' || (node as HTMLElement).tagName === 'P')) {
      if (segs.length > 0) pushText('\n');
      node.childNodes.forEach(walkInline);
      if (!isLast) pushText('\n');
    } else {
      walkInline(node);
    }
  });
  return segs;
}

/** 输入区纯文本形态（chip → token）——落盘 content（历史按 token 原位还原 chip） */
function segmentsToText(segments: InputSegment[]): string {
  let out = '';
  for (const seg of segments) {
    if (seg.kind === 'text') out += seg.text;
    else out += chipToken(seg.chipKind, seg.id);
  }
  return out;
}

/** 输入区是否为空（无文本且无内嵌 chip；图片附件不算——与旧 textarea 空判语义一致） */
function isInputEmpty(): boolean {
  if (input.querySelector('.ai-inline-chip')) return false;
  return !input.textContent?.trim();
}

/* ---------- 发送与流式接收 ---------- */
async function send(textOverride?: string): Promise<void> {
  const ctx = viewContext;
  const targetProject = project;
  if (!ctx || !targetProject) {
    toast('项目未加载', 'error');
    return;
  }
  const pid = targetProject.id;
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
  closeMention(); // 发送按钮路径可能带着打开的 @ 补全弹层
  // 读取输入区：文本段与内嵌 chip 按输入框内顺序；程序化首条消息直接使用纯文本段。
  const segments: InputSegment[] = textOverride === undefined
    ? readInputSegments()
    : [{ kind: 'text', text: textOverride }];
  const seenIds = new Set<string>();
  /** chip 引用数据快照（clearChips 会清空全局 Map，prompt 展开用这份捕获） */
  const chipData = new Map<string, ChipDatum>();
  const snaps: TermSnapshot[] = [];
  const refs: FileRef[] = [];
  const srefs: ServerRef[] = [];
  const prefs: PathRef[] = [];
  const brefs: BrowserRef[] = [];
  const pgrefs: BrowserPageRef[] = [];
  const skrefs: SkillRef[] = [];
  const imgs: ImageRef[] = [];
  for (const seg of segments) {
    if (seg.kind !== 'chip' || seenIds.has(seg.id)) continue;
    if (seg.chipKind === 'file') {
      const r = fileRefs.get(seg.id);
      if (!r) continue;
      seenIds.add(seg.id);
      chipData.set(seg.id, { kind: 'file', ref: r });
      refs.push(r);
    } else if (seg.chipKind === 'term') {
      const sn = snapshots.get(seg.id);
      if (!sn) continue;
      seenIds.add(seg.id);
      chipData.set(seg.id, { kind: 'term', snap: sn });
      snaps.push(sn);
    } else if (seg.chipKind === 'server') {
      const r = serverRefs.get(seg.id);
      if (!r) continue;
      seenIds.add(seg.id);
      chipData.set(seg.id, { kind: 'server', ref: r });
      srefs.push(r);
    } else if (seg.chipKind === 'path') {
      const p = pathRefs.get(seg.id);
      if (!p) continue;
      seenIds.add(seg.id);
      chipData.set(seg.id, { kind: 'path', ref: p });
      prefs.push(p);
    } else if (seg.chipKind === 'browser') {
      const b = browserRefs.get(seg.id);
      if (!b) continue;
      seenIds.add(seg.id);
      chipData.set(seg.id, { kind: 'browser', ref: b });
      brefs.push(b);
    } else if (seg.chipKind === 'page') {
      const p = pageRefs.get(seg.id);
      if (!p) continue;
      seenIds.add(seg.id);
      chipData.set(seg.id, { kind: 'page', ref: p });
      pgrefs.push(p);
    } else if (seg.chipKind === 'skill') {
      const r = skillRefs.get(seg.id);
      if (!r) continue;
      seenIds.add(seg.id);
      chipData.set(seg.id, { kind: 'skill', ref: r });
      skrefs.push(r);
    }
  }
  inputImageRefs.forEach((r) => imgs.push(r));
  const text = segmentsToText(segments).trim();
  if (!text && snaps.length === 0 && refs.length === 0 && srefs.length === 0 && prefs.length === 0 && brefs.length === 0 && pgrefs.length === 0 && skrefs.length === 0 && imgs.length === 0) return;

  // 只有新会话的第一条用户消息触发一次标题任务；后续消息永不自动改名。
  const shouldGenerateTitle = s.messages.length === 0 && !s.autoTitleTriggered;
  if (shouldGenerateTitle) {
    s.title = temporarySessionTitle(
      text,
      !text && imgs.length
        ? '图片消息'
        : brefs.length || pgrefs.length
          ? '页面元素引用'
          : skrefs.length
            ? '技能引用'
            : srefs.length || prefs.length
              ? '引用'
              : '文件引用',
    );
  }

  s.messages.push({ role: 'user', content: text, snapshots: snaps, fileRefs: refs, serverRefs: srefs, pathRefs: prefs, browserRefs: brefs, browserPageRefs: pgrefs, skillRefs: skrefs, imageRefs: imgs, actions: [], ts: Date.now() });
  if (shouldGenerateTitle) s.autoTitleTriggered = true;
  clearChips();
  pendingBy.set(sid, emptyPending());
  renderSessionBar();
  renderHistory();
  updateSendBtn();
  /* 首条严格按「保存首条 user（auto=false）→领取标题任务→ai_chat」顺序执行。
     标题命令只领取并异步启动后端模型请求，不等待模型 HTTP；命令失败也继续 ai_chat，
     内存 autoTitleTriggered 已置 true，后续消息永不重试。 */
  if (shouldGenerateTitle) {
    const firstSnapshot = cloneChatSession(s);
    firstSnapshot.autoTitleTriggered = false;
    try {
      await ensureSessionTitleListener();
    } catch (err) {
      console.error('[AI] 标题事件监听注册失败，继续发送:', err);
    }
    await enqueueSessionSnapshot(ctx, firstSnapshot);
    try {
      await aiGenerateSessionTitle(pid, sid, text, firstSnapshot.title);
    } catch (err) {
      console.error('[AI] 会话标题命令失败，继续发送:', err);
    }
  } else {
    void persistSession(s, ctx);
  }

  // 提交给 ai_chat 的 prompt = 工作区域上下文 + 输入区各段按序展开（文本原样、chip 展开为引用说明）
  const prompt = await buildPrompt(segments, imgs, chipData);
  // 图片本体不进 prompt：经 ai_chat 的 images 参数走 pi RPC images 字段（多模态 user 消息）。
  // 回读失败的图片跳过并提示（落盘副本被移动/删除的极端场景），不阻塞整条消息。
  const loaded = await Promise.all(
    imgs.map(async (r) => {
      const out = await loadImageData(r.path);
      return out ? { mimeType: out.mime, data: out.data } : null;
    }),
  );
  const images = loaded.filter((x): x is { mimeType: string; data: string } => x !== null);
  if (images.length < imgs.length) {
    toast(`${imgs.length - images.length} 张图片读取失败，已跳过`, 'error');
  }
  aiChat(`${pid}:${sid}`, prompt, images.length ? images : undefined).catch((err: unknown) => {
    // 提交失败（pi 运行时缺失 / 未配置 API Key 等）：错误气泡红边；完整信息打到控制台便于排查
    console.error('[AI] ai_chat 失败:', err);
    ctx.pendingBy.set(sid, { phase: 'error', text: '', error: String(err), tools: [], actions: new Map() });
    if (viewContext === ctx && !unmounted && sid === activeSessionId) {
      renderHistory();
      updateSendBtn();
      renderSessionBar();
    }
  });
}

/**
 * 组装发给 pi 的 prompt：固定工作区域上下文最先（与输入框工作区域标签始终最前一致），
 * 之后按输入框内的视觉顺序逐段展开——文本段原样、chip 段展开为引用说明（快照/文件引用全文、
 * 服务器/路径/浏览器元素与页面/技能引用说明），保留用户书写的引用与文字的相对顺序。
 * 远程引用附 user@host:port 便于 AI 选择命令目标（后端 run_command 的 target 由 AI 工具参数决定）；
 * 路径引用只带完整路径不带文件内容；浏览器元素引用展开为页面信息 + 元素完整 HTML；
 * 浏览器页面引用展开为页面标题与地址（正文由 AI 自行用 browser_read 读取）；
 * 技能引用展开为名称/来源/scope/描述（AI 可循技能目录读取 SKILL.md 后按技能工作）；
 * 图片附件只附一行文件名清单（图片本体经 ai_chat 的 images 参数传给多模态模型，不进 prompt）。
 */
async function buildPrompt(segments: InputSegment[], imgs: ImageRef[], chipData: Map<string, ChipDatum>): Promise<string> {
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
  /** 引用段展开（各分类展开文本与历史版本一致，只是位置改为跟随输入框内顺序） */
  const expand = (d: ChipDatum): string => {
    switch (d.kind) {
      case 'term':
        return `\n\n[终端快照 命令: ${d.snap.command}]\n${d.snap.content.slice(0, 4000)}`;
      case 'file':
        return `\n\n[文件引用 ${d.ref.path} 第${d.ref.startLine}-${d.ref.endLine}行]\n${d.ref.content.slice(0, 4000)}`;
      case 'server':
        return d.ref.serverId === null ? '\n\n[引用: 本地终端]' : `\n\n${remoteText(d.ref)}`;
      case 'path': {
        const r = d.ref;
        if (!r.serverId) return `\n\n[${r.isDir ? '目录路径' : '文件路径'}: ${r.path}]`;
        const sv = servers.find((s) => s.id === r.serverId);
        const where = sv ? `${sv.name} (${sv.username}@${sv.host}:${sv.port})` : r.serverId;
        return `\n\n[${r.isDir ? '远程目录路径' : '远程文件路径'}（服务器 ${where}）: ${r.path}]`;
      }
      case 'browser':
        return `\n\n[浏览器元素引用 @browser:${d.ref.name}]\n页面: ${d.ref.title || '（无标题）'} (${d.ref.url})\n元素 HTML:\n${d.ref.outerHTML.slice(0, 8000)}`;
      case 'page':
        return `\n\n[浏览器页面引用 @page:${pageRefLabel(d.ref)}]\n页面: ${d.ref.title || '（无标题）'} (${d.ref.url})\n可用 browser_read / browser_screenshot 读取该页面内容`;
      case 'skill':
        return `\n\n[技能引用 @skill:${d.ref.name}]\n名称: ${d.ref.name}（${d.ref.origin === 'global' ? '全局' : '项目'}）\nscope: ${d.ref.scope.join(', ') || '-'}\n描述: ${d.ref.description}`;
    }
  };
  const parts: string[] = [];
  if (panelOptions.fixedWorkareaPath) {
    parts.push(`[当前工作区域: 本地系统任务目录 ${panelOptions.fixedWorkareaPath}；未绑定任何远程服务器]\n`);
  } else if (autoSwitchAiWorkdir && browserWorkarea) {
    parts.push('[当前工作区域: 浏览器]\n');
  } else if (autoSwitchAiWorkdir && workareaRef) {
    // 固定工作区域：作为当前目标上下文说明（输入框最前标签）
    const wr: ServerRef = workareaRef; // 具名 const：IIFE 闭包内保持收窄
    parts.push(
      (wr.serverId === null
        ? '[当前工作区域: 本地]'
        : (() => {
            const sv = servers.find((s) => s.id === wr.serverId);
            return sv
              ? `[当前工作区域: 服务器 ${sv.name} (${sv.username}@${sv.host}:${sv.port})]`
              : `[当前工作区域: ${wr.name}]`;
          })()) + '\n',
    );
  }
  for (const seg of segments) {
    if (seg.kind === 'text') parts.push(seg.text);
    else {
      const d = chipData.get(seg.id);
      if (d) parts.push(expand(d));
    }
  }
  if (imgs.length) parts.push(`\n\n[已附加 ${imgs.length} 张图片: ${imgs.map((r) => r.name).join(', ')}]`);
  return parts.join('').trim();
}

/* ---------- 事件绑定 ---------- */
/** AI 面板 Ctrl+C 策略（capture 阶段）：
 *  1) 输入框有选区 → 不拦截，交给浏览器默认复制；
 *  2) 消息区有选中文本 → 显式复制；
 *  3) 输入框为空（无文本且无内嵌 chip）且当前标签为终端 → 转发 ^C 给终端。 */
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
  if (sel && !sel.isCollapsed && input.contains(sel.anchorNode)) return;
  // 输入框为空且当前标签为终端 → 转发 ^C 给终端(旧 Tab.api 字段 → tabApis 注册表)
  if (isInputEmpty()) {
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

function onSessionOutside(e: MouseEvent): void {
  if (!sessionMenuOpen) return;
  const target = e.target as Node;
  if (!sessionSelect.contains(target) && !sessionMenu.contains(target)) closeSessionMenu();
}

function onSessionDocumentKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && sessionMenuOpen) {
    closeSessionMenu();
    sessionSelect.focus();
  }
}

/** 输入事件：空内容归位（清掉残留 <br>，placeholder 依赖 :empty）+ @ 补全探测 */
function onInputInput(): void {
  if (!input.textContent && !input.querySelector('.ai-inline-chip') && input.childNodes.length > 0) {
    const sel = window.getSelection();
    const inside = !!sel && input.contains(sel.anchorNode);
    input.innerHTML = '';
    if (inside && sel) {
      const r = document.createRange();
      r.setStart(input, 0);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  updateMention();
}

/** 输入框按键：补全弹层导航（↑↓/Enter/Tab/Esc）优先；Enter 发送、Shift+Enter 换行 */
function onInputKeydown(e: KeyboardEvent): void {
  if (e.isComposing) return; // IME 组合中的按键不触发发送/补全
  if (isMentionOpen()) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      moveMention(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      void applyMentionActive();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeMention();
      return;
    }
  }
  if (e.key === 'Enter') {
    if (e.shiftKey) {
      // Shift+Enter 换行：显式插入 <br>（发送提取时按换行还原）
      e.preventDefault();
      document.execCommand('insertLineBreak');
    } else {
      e.preventDefault();
      void send();
    }
  }
}

function bindEvents(): void {
  sessionSelect.onclick = () => toggleSessionMenu();
  sessionSelect.onkeydown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!sessionMenuOpen) toggleSessionMenu();
    } else if (e.key === 'Escape') {
      closeSessionMenu();
    }
  };
  sessionMenu.addEventListener('click', (e) => {
    const option = (e.target as HTMLElement).closest('[data-session-id]') as HTMLElement | null;
    if (option?.dataset.sessionId) selectSession(option.dataset.sessionId);
  });
  sessionMenu.addEventListener('keydown', (e: KeyboardEvent) => {
    const option = (e.target as HTMLElement).closest('[data-session-id]') as HTMLElement | null;
    if (!option) return;
    const options = [...sessionMenu.querySelectorAll<HTMLElement>('[data-session-id]')];
    const index = options.indexOf(option);
    if (e.key === 'ArrowDown' && options.length) { e.preventDefault(); options[(index + 1) % options.length].focus(); }
    else if (e.key === 'ArrowUp' && options.length) { e.preventDefault(); options[(index - 1 + options.length) % options.length].focus(); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectSession(option.dataset.sessionId ?? ''); }
    else if (e.key === 'Escape') { e.preventDefault(); closeSessionMenu(); sessionSelect.focus(); }
  });
  offSessionOutside = (): void => {
    document.removeEventListener('mousedown', onSessionOutside, true);
    document.removeEventListener('keydown', onSessionDocumentKeydown, true);
  };
  document.addEventListener('mousedown', onSessionOutside, true);
  document.addEventListener('keydown', onSessionDocumentKeydown, true);
  newSessionBtn.onclick = () => {
    const s = newSession();
    activeSessionId = s.id;
    saveViewContext();
    closeSessionMenu();
    renderSessionBar();
    renderHistory();
    updateSendBtn();
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
    /* 追溯：trace 开启时打开当前会话的 trace 标签页（中央标签，同 id 去重复用） */
    const openTrace = (): void => {
      const title = sessions.get(sid)?.title ?? sid;
      useWorkbench.getState().openTab({
        id: `trace:${sid}`,
        type: 'trace',
        title: `追溯 · ${title}`,
        data: { projectId: pid, sessionId: sid, sessionTitle: title },
      });
    };
    /* 暂存区数量与 trace 开关实时查询（各自失败互不影响） */
    void Promise.all([
      stagingList(pid, sid).catch(() => null),
      traceStatus().catch(() => false),
    ])
      .then(([entries, traceOn]) => {
        /* 归档:生成中的会话禁归档(转录不完整,且后端杀进程会打断在途回合) */
        const archiving = isGenerating(sid);
        showContextMenu(e.clientX, e.clientY, [
          { label: '复制', iconName: 'copy', action: doCopy, disabled: !copyTarget, disabledTip: copyTarget ? undefined : '没有可复制的内容' },
          'sep',
          entries
            ? { label: `打开文件暂存区（${entries.length}）`, iconName: 'history', action: openStaging }
            : { label: '打开文件暂存区', iconName: 'history', action: openStaging },
          ...(traceOn ? ['sep' as const, { label: '追溯', iconName: 'search' as const, action: openTrace }] : []),
          'sep',
          {
            label: '归档会话', iconName: 'archive' as const,
            disabled: archiving, disabledTip: archiving ? '会话正在生成中，请先停止或等待完成' : undefined,
            action: () => archiveSession(pid, sid),
          },
        ]);
      });
  });
  stagingNotice.addEventListener('click', openCurrentStaging);
  chipRow.addEventListener('click', onChipRowClick);
  /* 内嵌引用 chip：✕ 移除 / 点击主体查看详情 */
  input.addEventListener('click', onInlineChipClick);
  /* 输入：空内容归位（placeholder 依赖 :empty）+ @ 补全探测 */
  input.addEventListener('input', onInputInput);
  /* 失焦关闭 @ 补全弹层（弹层自身 mousedown 已 preventDefault，不会触发） */
  input.addEventListener('blur', closeMention);
  /* 粘贴：图片文件转附件（一次可多张）；文本以纯文本插入 */
  input.addEventListener('paste', onInputPaste);
  /* 拖入图片：应用内 explorer/SFTP 拖拽载荷 + OS 文件（dragDropEnabled:false 下 HTML5 DnD 可用）。
     dragover 必须 preventDefault 才能接收 drop；dragleave 在离开整个输入区时才撤高亮（越过子元素会连发） */
  const inputArea = input.closest<HTMLElement>('#ai-input-area');
  if (inputArea) {
    inputArea.addEventListener('dragover', (e) => {
      e.preventDefault();
      inputArea.classList.add('ai-drag-over');
    });
    inputArea.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget || !inputArea.contains(e.relatedTarget as Node)) {
        inputArea.classList.remove('ai-drag-over');
      }
    });
    inputArea.addEventListener('drop', onInputAreaDrop);
  }
  input.addEventListener('keydown', onInputKeydown);
  /* 记录输入区最近光标（补全选中/文件对话框失焦后恢复插入位置用） */
  const onSelChange = (): void => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount && input.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  };
  document.addEventListener('selectionchange', onSelChange);
  offSelectionChange = (): void => {
    document.removeEventListener('selectionchange', onSelChange);
  };
  sendBtn.onclick = () => { void send(); };
  effortSelect.onchange = () => {
    void switchEffort(effortSelect.value as LlmConfig['effort']);
  };
  modeSelect.onchange = () => {
    void switchMode(modeSelect.value as AiMode);
  };
}
