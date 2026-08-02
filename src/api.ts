/**
 * 前端 -> Rust 的全部 invoke 封装 + 事件订阅助手。
 * 这是前后端唯一契约：命令名 / 参数名 / 事件名以此文件为准，Rust 侧逐一对应。
 * 注意：Tauri 把 Rust snake_case 参数映射为 JS camelCase。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AppState, ChatSession, FsEntry, Project, Server, Settings,
} from './types';

export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

/* ---------------- store ----------------
   apiKey / password 传 null 表示「不修改已保存的密钥」。 */
export const isConfigComplete = () => call<boolean>('is_config_complete');
export const getState = () => call<AppState>('get_state');
export const saveSettings = (settings: Settings, apiKey: string | null) =>
  call<void>('save_settings', { settings, apiKey });
export const upsertServer = (server: Server, password: string | null) =>
  call<void>('upsert_server', { server, password });
export const deleteServer = (id: string) => call<void>('delete_server', { id });
export const upsertProject = (project: Project) => call<void>('upsert_project', { project });
export const deleteProject = (id: string) => call<void>('delete_project', { id });
/** path 为 null 时回退到 <workspaceDir>/<name>；返回最终项目路径 */
export const ensureProjectDirs = (path: string | null, name: string) =>
  call<string>('ensure_project_dirs', { path, name });
export const sessionsGet = (projectId: string) =>
  call<ChatSession[]>('sessions_get', { projectId });
export const sessionUpsert = (projectId: string, session: ChatSession) =>
  call<void>('session_upsert', { projectId, session });

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

/* ---------------- sftp ---------------- */
export const sftpList = (serverId: string, path: string) =>
  call<FsEntry[]>('sftp_list', { serverId, path });
export const sftpUpload = (serverId: string, localPath: string, remoteDir: string) =>
  call<void>('sftp_upload', { serverId, localPath, remoteDir });
export const sftpDownload = (serverId: string, remotePath: string, localDir: string) =>
  call<void>('sftp_download', { serverId, remotePath, localDir });

/* ---------------- ai ---------------- */
export type AiEvent =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; message: string };
/** key = `<projectId>:<sessionId>`；同 key 并发生成由后端先 abort 再发 */
export const aiChat = (key: string, prompt: string) => call<void>('ai_chat', { key, prompt });
export const aiAbort = (key: string) => call<void>('ai_abort', { key });
/** 工作台卸载/切项目时调用：kill 该项目全部 pi 进程 */
export const aiKillProject = (projectId: string) => call<void>('ai_kill_project', { projectId });
export const onAiEvent = (key: string, cb: (ev: AiEvent) => void): Promise<UnlistenFn> =>
  listen<AiEvent>(`ai:event:${key}`, (e) => cb(e.payload));

/* ---------------- misc ---------------- */
/** 返回 app_config_dir 绝对路径（配置页「打开配置目录」按钮用） */
export const getConfigDir = () => call<string>('get_config_dir');
export { open as openDialog } from '@tauri-apps/plugin-dialog';
