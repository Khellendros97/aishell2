/**
 * 前端 -> Rust 的全部 invoke 封装 + 事件订阅助手。
 * 这是前后端唯一契约：命令名 / 参数名 / 事件名以此文件为准，Rust 侧逐一对应。
 * 注意：Tauri 把 Rust snake_case 参数映射为 JS camelCase。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AiMode, AppState, ChatSession, FsEntry, Project, Server, Settings, Theme, XshellImportResult,
} from './types';

export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

/* ---------------- store ----------------
   apiKey / braveKey / password 传 null 表示「不修改已保存的密钥」。 */
export const isConfigComplete = () => call<boolean>('is_config_complete');
export const getState = () => call<AppState>('get_state');
export const saveSettings = (settings: Settings, apiKey: string | null, braveKey: string | null) =>
  call<void>('save_settings', { settings, apiKey, braveKey });
/** 顶栏快捷切换主题专用：只更新 settings.theme,不动其他设置字段 */
export const setTheme = (theme: Theme) => call<void>('set_theme', { theme });
export const upsertServer = (server: Server, password: string | null) =>
  call<void>('upsert_server', { server, password });
export const deleteServer = (id: string) => call<void>('delete_server', { id });
/** 一键从 Xshell 导入 SSH 会话：扫描 Documents/NetSarang Computer 最高版本的 Xshell/Sessions；
 *  密码永不迁移；无可用会话目录时 reject 中文错误串。 */
export const importXshellSessions = () => call<XshellImportResult>('import_xshell_sessions');
export const upsertProject = (project: Project) => call<void>('upsert_project', { project });
export const deleteProject = (id: string) => call<void>('delete_project', { id });
/** path 为 null 时回退到 <workspaceDir>/<name>；返回最终项目路径 */
export const ensureProjectDirs = (path: string | null, name: string) =>
  call<string>('ensure_project_dirs', { path, name });
export const sessionsGet = (projectId: string) =>
  call<ChatSession[]>('sessions_get', { projectId });
export const sessionUpsert = (projectId: string, session: ChatSession) =>
  call<void>('session_upsert', { projectId, session });
/** 原子切换项目 AI 模式（只改目标字段；后端同时向该项目存活 pi 进程热推 /aishell-mode） */
export const setAiMode = (projectId: string, mode: AiMode) =>
  call<void>('set_ai_mode', { projectId, mode });
/** 原子切换服务器 AI 操作锁（只改目标字段；仅约束 AI 远程动作） */
export const setServerLocked = (id: string, locked: boolean) =>
  call<void>('set_server_locked', { id, locked });

/* ---------------- term ----------------
   id 由前端生成、先订阅事件再调 term_create，避免输出竞态丢失。
   term_create 失败时错误串原样 reject（如「未找到 Git Bash」）。 */
export type TermKind = 'local' | 'ssh';
export const termCreate = (id: string, kind: TermKind, serverId: string | null, cwd: string | null) =>
  call<void>('term_create', { id, kind, serverId, cwd });
export const termInput = (id: string, data: string) => call<void>('term_input', { id, data });
export const termResize = (id: string, cols: number, rows: number) =>
  call<void>('term_resize', { id, cols, rows });
export const termClose = (id: string) => call<void>('term_close', { id });
export const onTermData = (id: string, cb: (data: string) => void): Promise<UnlistenFn> =>
  listen<{ data: string }>(`term:data:${id}`, (e) => cb(e.payload.data));
export const onTermExit = (id: string, cb: (code: number | null) => void): Promise<UnlistenFn> =>
  listen<{ code: number | null }>(`term:exit:${id}`, (e) => cb(e.payload.code));

/* ---------------- fs ---------------- */
export const fsList = (path: string) => call<FsEntry[]>('fs_list', { path });
/** >5MB 或二进制文件会 reject 错误串 */
export const fsRead = (path: string) => call<string>('fs_read', { path });
export const fsWrite = (path: string, content: string) => call<void>('fs_write', { path, content });
export const fsCreate = (path: string, isDir: boolean) => call<void>('fs_create', { path, isDir });
export const fsDelete = (path: string) => call<void>('fs_delete', { path });
/** OS 拖入导入：返回落地后的最终名称（重名自动改名）；文件内容 base64，目录传 null。 */
export const fsImport = (dir: string, name: string, isDir: boolean, data: string | null) =>
  call<string>('fs_import', { dir, name, isDir, data });
/** 本地文件被外部修改（AI write/edit 落盘）通知：path 为规范化绝对路径 */
export const onFsChanged = (cb: (path: string) => void): Promise<UnlistenFn> =>
  listen<{ path: string }>('fs:changed', (e) => cb(e.payload.path));
/** 移动/重命名：to 为完整目标路径；目标已存在会 reject。 */
export const fsMove = (from: string, to: string) => call<void>('fs_move', { from, to });
/** 复制进 toDir（重名自动改名）；返回落地路径。 */
export const fsCopy = (from: string, toDir: string) => call<string>('fs_copy', { from, toDir });
/** 在系统文件资源管理器中定位 */
export const fsReveal = (path: string) => call<void>('fs_reveal', { path });

/* ---------------- sftp ---------------- */
/** 解析远端会话 home 目录（canonicalize(".")） */
export const sftpHome = (serverId: string) =>
  call<string>('sftp_home', { serverId });
export const sftpList = (serverId: string, path: string) =>
  call<FsEntry[]>('sftp_list', { serverId, path });
export const sftpUpload = (serverId: string, localPath: string, remoteDir: string) =>
  call<void>('sftp_upload', { serverId, localPath, remoteDir });
export const sftpDownload = (serverId: string, remotePath: string, localDir: string) =>
  call<void>('sftp_download', { serverId, remotePath, localDir });

/* ---------------- ai ---------------- */
/** 后端发出的 AI 回合事件（key = `<projectId>:<sessionId>`）：
 *  - approval：Agent 模式逐调用审批请求（对应 pi extension_ui_request/confirm）；
 *  - actionStart/actionEnd：受控工具（write/edit/delete_path/run_command/sftp_upload/sftp_download）
 *    执行生命周期（来自 tool_execution_start/end，toolCallId 关联审批卡）。 */
export type AiEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool'; tool: string; label: string }
  | { type: 'segment' }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'approval'; requestId: string; toolCallId: string; action: string; intent: string; summary: string }
  | { type: 'actionStart'; toolCallId: string; tool: string; args: Record<string, unknown> }
  | { type: 'actionEnd'; toolCallId: string; tool: string; isError: boolean; result: string };
/** key = `<projectId>:<sessionId>`；同 key 并发生成由后端先 abort 再发 */
export const aiChat = (key: string, prompt: string) => call<void>('ai_chat', { key, prompt });
export const aiAbort = (key: string) => call<void>('ai_abort', { key });
/** 工作台卸载/切项目时调用：kill 该项目全部 pi 进程 */
export const aiKillProject = (projectId: string) => call<void>('ai_kill_project', { projectId });
/** 动态切换项目内 AI 进程的思考强度（立即生效；无存活进程时静默，下次提问按新档位 spawn） */
export const aiSetThinking = (projectId: string, level: string) =>
  call<void>('ai_set_thinking', { projectId, level });
/** 回复待审批动作：confirmed=true 批准 / false 拒绝；仅接受该 key 当前待处理的 requestId，
 *  重复或过期回复返回中文错误。 */
export const aiRespondApproval = (key: string, requestId: string, confirmed: boolean) =>
  call<void>('ai_respond_approval', { key, requestId, confirmed });
export const onAiEvent = (key: string, cb: (ev: AiEvent) => void): Promise<UnlistenFn> =>
  listen<AiEvent>(`ai:event:${key}`, (e) => cb(e.payload));

/* ---------------- misc ---------------- */
/** 返回 app_config_dir 绝对路径（配置页「打开配置目录」按钮用） */
export const getConfigDir = () => call<string>('get_config_dir');
export { open as openDialog } from '@tauri-apps/plugin-dialog';
