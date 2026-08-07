/**
 * 前端 -> Rust 的全部 invoke 封装 + 事件订阅助手。
 * 这是前后端唯一契约：命令名 / 参数名 / 事件名以此文件为准，Rust 侧逐一对应。
 * 注意：Tauri 把 Rust snake_case 参数映射为 JS camelCase。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AiMode, AppState, ChatSession, FsEntry, FsStat, Project, Server, Settings, SshExecResult, Theme, XshellImportResult,
} from './types';

export function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(cmd, args);
}

/** 打开 DevTools（浏览器快捷键已被后端禁用，F12 由前端监听后调此命令） */
export const openDevtools = () => call<void>('open_devtools');

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
/** 新建项目分类目录：name 规范化后入库；空名/重名返回后端中文错误 */
export const createProjectFolder = (name: string) => call<void>('create_project_folder', { name });
/** 重命名项目分类目录：级联改写所有项目 folder；new 与 old 相同为 no-op；未分类不可重命名 */
export const renameProjectFolder = (oldName: string, newName: string) =>
  call<void>('rename_project_folder', { old: oldName, new: newName });
/** 删除项目分类目录：目录下仍有项目时返回后端中文错误；未分类不可删除 */
export const deleteProjectFolder = (name: string) => call<void>('delete_project_folder', { name });
/** 新建命令收藏分类目录：name 规范化后入库；空名/重名返回后端中文错误 */
export const createCommandFolder = (name: string) => call<void>('create_command_folder', { name });
/** 重命名命令收藏分类目录：级联改写所有项目命令的 folder；new 与 old 相同为 no-op；未分类不可重命名 */
export const renameCommandFolder = (oldName: string, newName: string) =>
  call<void>('rename_command_folder', { old: oldName, new: newName });
/** 删除命令收藏分类目录：目录下仍有命令（任意项目）时返回后端中文错误；未分类不可删除 */
export const deleteCommandFolder = (name: string) => call<void>('delete_command_folder', { name });
/** 写入目录树展开状态（前端防抖后调用）；key = explorer:<projectId> | welcome:projectGroups | commands:folders */
export const setUiExpanded = (key: string, values: string[]) =>
  call<void>('set_ui_expanded', { key, values });
/** 清除全部服务器配置：清空服务器与分类目录、所有项目解绑、删除全部 keyring 密钥 */
export const clearAllServers = () => call<void>('clear_all_servers');
/** 一键从 Xshell 导入 SSH 会话：扫描 Documents/NetSarang Computer 最高版本的 Xshell/Sessions；
 *  密码永不迁移；无可用会话目录时 reject 中文错误串。 */
export const importXshellSessions = () => call<XshellImportResult>('import_xshell_sessions');
/** 从用户手动指定的目录导入（自动定位 Sessions 子目录），用于自动扫描失败后的重试。 */
export const importXshellFromDir = (dir: string) =>
  call<XshellImportResult>('import_xshell_from_dir', { dir });
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
   term_create 失败时错误串原样 reject（如「未找到 Git Bash」「未找到可用 shell」）。 */
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
/** 读取单项属性（属性对话框用）：mode 仅 Unix 有值（本地 Windows 为 null），linkTarget 仅符号链接有值 */
export const fsStat = (path: string) => call<FsStat>('fs_stat', { path });

/* ---------------- sftp ---------------- */
/** 解析远端会话 home 目录（canonicalize(".")） */
export const sftpHome = (serverId: string) =>
  call<string>('sftp_home', { serverId });
export const sftpList = (serverId: string, path: string) =>
  call<FsEntry[]>('sftp_list', { serverId, path });
/** 读取远端单项属性（右键「属性」对话框用）：mode 为 unix 权限位，linkTarget 非符号链接为 null */
export const sftpStat = (serverId: string, path: string) =>
  call<FsStat>('sftp_stat', { serverId, path });
/** 读取远端文本文件：>5MB 或二进制会 reject（与 fs_read 同一编辑约束） */
export const sftpRead = (serverId: string, remotePath: string) =>
  call<string>('sftp_read', { serverId, remotePath });
/** 覆写远端文本文件（保存场景允许覆盖） */
export const sftpWrite = (serverId: string, remotePath: string, content: string) =>
  call<void>('sftp_write', { serverId, remotePath, content });
/** 上传本地文件/目录到远端目录（重名自动改名）；返回最终落地名称 */
export const sftpUpload = (serverId: string, localPath: string, remoteDir: string) =>
  call<string>('sftp_upload', { serverId, localPath, remoteDir });
/** 下载远端文件/目录到本地目录（重名自动改名）；返回最终落地的完整本地路径 */
export const sftpDownload = (serverId: string, remotePath: string, localDir: string) =>
  call<string>('sftp_download', { serverId, remotePath, localDir });
/** 远端移动/重命名：to 为完整目标路径；目标已存在会 reject */
export const sftpRename = (serverId: string, from: string, to: string) =>
  call<void>('sftp_rename', { serverId, from, to });
/** 复制远端文件/目录进 toDir（重名自动改名）；返回落地名称 */
export const sftpCopy = (serverId: string, from: string, toDir: string) =>
  call<string>('sftp_copy', { serverId, from, toDir });
/** 删除远端文件或目录（目录递归删除） */
export const sftpDelete = (serverId: string, path: string) =>
  call<void>('sftp_delete', { serverId, path });
/** dir 内不冲突的远端名称（重名自动 `name (1).ext`）——压缩包目标名防覆盖用 */
export const sftpUniqueName = (serverId: string, dir: string, name: string) =>
  call<string>('sftp_unique_name', { serverId, dir, name });
/** 创建远端空文件或目录（目标已存在会 reject） */
export const sftpCreate = (serverId: string, path: string, isDir: boolean) =>
  call<void>('sftp_create', { serverId, path, isDir });

/* ---------------- ssh 直执 ----------------
   认证失败错误串的稳定前缀（与 ssh.rs AUTH_FAILED_PREFIX 保持一致）：terminal.ts 据此
   识别 SSH 认证失败并弹出重设凭据对话框；对话框展示时剥掉此前缀。 */
export const SSH_AUTH_FAILED_PREFIX = '[SSH认证失败]';

/** ssh_exec：复用服务器既有 SSH 连接（每 serverId 一条）直执单条命令，不走迷你终端。
 *  返回 { code, stdout, stderr }；code=null 表示命令超时被中断或未收到退出码。
 *  命令与结果由调用方写入 debug 日志（见 sftp.ts runRemoteCommand）。 */
export const sshExec = (serverId: string, command: string) =>
  call<SshExecResult>('ssh_exec', { serverId, command });

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
/** pi 运行时诊断（候选路径命中情况 + 安装目录实际内容），供控制台输出排查安装版问题 */
export const aiDebugInfo = () => call<string>('ai_debug_info');
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
export { open as openDialog } from '@tauri-apps/plugin-dialog';
