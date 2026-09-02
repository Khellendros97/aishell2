/**
 * 前端 -> Rust 的全部 invoke 封装 + 事件订阅助手。
 * 这是前后端唯一契约：命令名 / 参数名 / 事件名以此文件为准，Rust 侧逐一对应。
 * 注意：Tauri 把 Rust snake_case 参数映射为 JS camelCase。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AiMode, AppState, ArchiveMode, AttachImageItem, AttachedImage, BrowserEvent, BrowserHistoryItem, BrowserProxyConfig, BrowserState, ChatSession, ConfigChanged, Credential, CredentialMode, DbConnection, DbKind, FsEntry, FsStat, KeyPairInfo, McpDeviceConfig, McpStatus, NotesListing, Project, ReadImageOut, RestoreOutcome, Server, Settings, ServerSaveResult, SftpFavorite, SftpProgress, SftpWriteResult, SkillDocument, SkillOrigin, SkillSummary, StagedFile, StagingClearOutcome, StagingContent, StagingDiff, StagingExportOutcome, StagingProgress, SshExecResult, Theme, TraceEntry, TunnelConfig, TunnelState, XshellImportResult,
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
/** 欢迎页 AI 的系统任务上下文；不进入普通项目列表。 */
export const getTaskProject = () => call<Project>('get_task_project');
/** Python SDK 成功导入配置后的全局通知。 */
export const onConfigChanged = (cb: (event: ConfigChanged) => void): Promise<UnlistenFn> =>
  listen<ConfigChanged>('config:changed', (e) => cb(e.payload));
export const saveSettings = (settings: Settings, apiKey: string | null, braveKey: string | null) =>
  call<void>('save_settings', { settings, apiKey, braveKey });
/** 顶栏快捷切换主题专用：只更新 settings.theme,不动其他设置字段 */
export const setTheme = (theme: Theme) => call<void>('set_theme', { theme });
export const upsertServer = (server: Server, password: string | null, credentialMode: CredentialMode = 'ask') =>
  call<ServerSaveResult>('upsert_server', { server, password, credentialMode });
export const upsertCredential = (credential: Credential, password: string | null) =>
  call<Credential>('upsert_credential', { credential, password });
export const deleteCredential = (id: string) => call<void>('delete_credential', { id });
/** 清除凭据库中未被任何服务器引用的凭据及其 keyring 密钥，返回清除数量。 */
export const clearUnreferencedCredentials = () => call<number>('clear_unreferenced_credentials');
export const deleteServer = (id: string) => call<void>('delete_server', { id });
/** 新建项目分类目录：name 规范化后入库；空名/重名返回后端中文错误 */
export const createProjectFolder = (name: string) => call<void>('create_project_folder', { name });
/** 重命名项目分类目录：级联改写所有项目 folder；new 与 old 相同为 no-op；未分类不可重命名 */
export const renameProjectFolder = (oldName: string, newName: string) =>
  call<void>('rename_project_folder', { old: oldName, new: newName });
/** 删除项目分类目录：目录下仍有项目时返回后端中文错误；未分类不可删除 */
export const deleteProjectFolder = (name: string) => call<void>('delete_project_folder', { name });
/** 按分类递归删除项目：含子分类下的项目一并删除（服务器仅解绑不删除），返回删除的项目数 */
export const deleteFolderWithProjects = (name: string) =>
  call<number>('delete_folder_with_projects', { name });
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
/** 写入某服务器的 SFTP 路径历史（MRU：最新在前，前端防抖后调用） */
export const setSftpHistory = (serverId: string, paths: string[]) =>
  call<void>('set_sftp_history', { serverId, paths });
/** 写入某服务器的 SFTP 收藏夹（路径 + 标题，按添加顺序，前端防抖后调用） */
export const setSftpFavorites = (serverId: string, favorites: SftpFavorite[]) =>
  call<void>('set_sftp_favorites', { serverId, favorites });
/** 清除未被项目直接或经堡垒机依赖引用的服务器及附属配置，返回清除数量。 */
export const clearUnreferencedServers = () => call<number>('clear_unreferenced_servers');
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

/* ---------------- 数据库连接（AI 受管查询通道） ----------------
   password 传 null 表示不修改已保存的密码；连接列表随 getState 返回。 */
export const saveDbConnection = (serverId: string, connection: DbConnection, password: string | null) =>
  call<void>('save_db_connection', { serverId, connection, password });
export const deleteDbConnection = (serverId: string, connId: string) =>
  call<void>('delete_db_connection', { serverId, connId });

/* ---------------- MCP 服务（外部 agent 工具接入，Streamable HTTP） ----------------
   设备配置随 getState 返回（AppState.mcpDevices / mcp.port）；令牌为自签本地配对令牌，
   仅在本应用 MCP 设置界面展示/复制（这是「密钥永不返回前端」规则的显式例外）。 */
/** 保存某服务器的 MCP 设备配置（enabled = 加入 MCP 可发现设备列表 + 功能开关）；后端同步监听 */
export const setMcpDevice = (serverId: string, config: McpDeviceConfig) =>
  call<void>('mcp_set_device', { serverId, config });
/** 修改 MCP 监听端口（1024–65535）；后端同步重启监听 */
export const setMcpPort = (port: number) => call<void>('mcp_set_port', { port });
/** 服务状态：是否监听、实际端口、启动失败原因、已启用设备数 */
export const getMcpStatus = () => call<McpStatus>('mcp_status');
/** 读取（必要时生成）MCP 接入令牌，供设置界面展示/复制 */
export const mcpEnsureToken = () => call<string>('mcp_ensure_token');
/** 重置 MCP 接入令牌（旧令牌立即失效） */
export const mcpResetToken = () => call<string>('mcp_reset_token');

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
export const termRecordStart = (id: string, path: string, header: string) =>
  call<void>('term_record_start', { id, path, header });
export const termRecordStop = (id: string, footer: string) =>
  call<string | null>('term_record_stop', { id, footer });
export const onTermData = (id: string, cb: (data: string) => void): Promise<UnlistenFn> =>
  listen<{ data: string }>(`term:data:${id}`, (e) => cb(e.payload.data));
export const onTermExit = (id: string, cb: (code: number | null) => void): Promise<UnlistenFn> =>
  listen<{ code: number | null }>(`term:exit:${id}`, (e) => cb(e.payload.code));

/* ---------------- fs ---------------- */
export const fsList = (path: string) => call<FsEntry[]>('fs_list', { path });
/** 是否满足编辑器 UTF-8 文本约束；目录、>5MB、二进制返回 false。 */
export const fsIsText = (path: string) => call<boolean>('fs_is_text', { path });
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
/** 覆写远端文本文件（保存场景允许覆盖）；expectedSize/expectedMtime 为打开时快照，
 *  远端属性不一致时后端不写入并返回 conflict=true（前端弹「外部修改」确认） */
export const sftpWrite = (serverId: string, remotePath: string, content: string, expectedSize?: number, expectedMtime?: number) =>
  call<SftpWriteResult>('sftp_write', { serverId, remotePath, content, expectedSize, expectedMtime });
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
/** 公钥(密钥对)认证被拒的稳定前缀（与 ssh.rs NEED_DEPLOY_PREFIX 保持一致）：
 *  terminal.ts 据此弹出「输入密码自动部署公钥」对话框。 */
export const SSH_NEED_DEPLOY_KEY_PREFIX = '[SSH需部署公钥]';

/** ssh_exec：复用服务器既有 SSH 连接（每 serverId 一条）直执单条命令，不走迷你终端。
 *  返回 { code, stdout, stderr }；code=null 表示命令超时被中断或未收到退出码。
 *  命令与结果由调用方写入 debug 日志（见 sftp.ts runRemoteCommand）。 */
export const sshExec = (serverId: string, command: string) =>
  call<SshExecResult>('ssh_exec', { serverId, command });

/** 部署公钥(密钥对)凭据的公钥到服务器 authorized_keys（ssh-copy-id 等价）。
 *  密码一次性使用、不进系统凭据库；成功后下次连接即公钥免密登录。 */
export const sshDeployPublicKey = (serverId: string, password: string) =>
  call<void>('ssh_deploy_public_key', { serverId, password });

/* ---------------- 密钥对（SSH 公钥凭据） ----------------
   探测/生成均由后端同一定义（ssh_keys.rs），前端只展示结果。 */
/** 密钥对目录默认值：用户主目录下 `.ssh`（不存在也返回，由探测/生成按需创建）。 */
export const sshDefaultKeypairDir = () => call<string>('ssh_default_keypair_dir');
/** 探测目录是否已有标准命名密钥对（id_ed25519/id_rsa/id_ecdsa，私钥+同名 .pub 并存）。 */
export const sshDetectKeypair = (dir: string) => call<KeyPairInfo | null>('ssh_detect_keypair', { dir });
/** 在目录下生成密钥对（ed25519、无密码短语；文件已存在时拒绝）。 */
export const sshGenerateKeypair = (dir: string) => call<KeyPairInfo>('ssh_generate_keypair', { dir });

/* ---------------- SSH 隧道（本地端口转发 -L 等价） ----------------
   配置存 aishell.json（enabled = 重启自动重建），运行态在后端 tunnel.rs；tunnels:changed
   事件驱动标签页刷新。关闭隧道标签页不停止隧道（服务语义，与终端/会话类资源区分）。 */
/** 隧道列表（serverId 可选：按服务器过滤）。 */
export const tunnelList = (serverId?: string) =>
  call<TunnelState[]>('tunnel_list', { serverId: serverId ?? null });
/** 保存隧道配置（按 id upsert）；enabled=true 时自动启动（失败 Err 返回错误文本）。 */
export const tunnelSave = (tunnel: TunnelConfig) =>
  call<TunnelState>('tunnel_save', { cfg: tunnel });
export const tunnelStart = (id: string) => call<TunnelState>('tunnel_start', { id });
export const tunnelStop = (id: string) => call<void>('tunnel_stop', { id });
export const tunnelDelete = (id: string) => call<void>('tunnel_delete', { id });
/** 隧道列表变更（启动/停止/保存/删除/重启恢复）后的全局通知。 */
export const onTunnelsChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen('tunnels:changed', () => cb());

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
  | { type: 'approval'; requestId: string; toolCallId: string; action: string; intent: string; summary: string;
      /** 智能审批自动放行：true 时卡片直接展示「已智能放行」（后端已回 confirmed，无需再回复） */
      smart?: boolean; smartReason?: string;
      /** 影响计划（自动备份开启时）：effect 为 none|bounded|unbounded，unbounded 卡片展示「不保证完整备份」 */
      impact?: { effect: 'none' | 'bounded' | 'unbounded'; changes: Array<{ operation: string; path: string; destination?: string | null }>; reason: string };
      /** 数据库连接申请（request_db_connection 工具）：AI 填写的连接信息，审批对话框只读展示 */
      connection?: { serverId: string; name: string; kind: DbKind; host: string; port?: number; user?: string; database?: string } }
  /** ask 工具（通用问答）：AI 一次提出多个问题，前端渲染问答卡片（每问候选选项 + 自由输入框），
   *  用户提交后经 aiRespondAsk 回执拼装好的问答文本 */
  | { type: 'ask'; requestId: string; toolCallId: string; questions: Array<{ question: string; options?: string[] }> }
  /** confirm 工具（通用是非确认）：单一问题 + 确认/取消，经 aiRespondConfirm 回执布尔 */
  | { type: 'confirm'; requestId: string; toolCallId: string; question: string }
  | { type: 'actionStart'; toolCallId: string; tool: string; args: Record<string, unknown> }
  | { type: 'actionEnd'; toolCallId: string; tool: string; isError: boolean; result: string };
/** key = `<projectId>:<sessionId>`；同 key 并发生成由后端先 abort 再发。
 *  images：随消息附带的多模态图片（mime + 不带 dataURL 前缀的 base64），经 pi RPC images 字段进入 user 消息。 */
export const aiChat = (key: string, prompt: string, images?: Array<{ mimeType: string; data: string }>) =>
  call<void>('ai_chat', { key, prompt, images });
/** 图片附件物化：按来源（本地/远程/剪贴板 base64）读取、魔数嗅探后落到 <project>/.aishell/ai-images/，
 *  返回落盘副本信息；整批任一失败报错。 */
export const aiAttachImages = (projectId: string, items: AttachImageItem[]) =>
  call<AttachedImage[]>('ai_attach_images', { projectId, items });
/** 回读落盘图片为 base64（缩略图/预览用）。 */
export const aiReadImage = (path: string) => call<ReadImageOut>('ai_read_image', { path });
/** 首条用户消息的异步会话标题生成；失败不影响 ai_chat，标题由前端先显示本地临时标题。 */
export const aiGenerateSessionTitle = (projectId: string, sessionId: string, firstMessage: string, expectedTitle?: string) =>
  call<void>('ai_generate_session_title', { projectId, sessionId, firstMessage, expectedTitle });
export interface AiSessionTitleEvent {
  projectId: string;
  sessionId: string;
  title: string;
}
/** 后端标题生成完成事件；监听是全局的，调用方按 projectId/sessionId 隔离。 */
export const onAiSessionTitle = (cb: (ev: AiSessionTitleEvent) => void): Promise<UnlistenFn> =>
  listen<AiSessionTitleEvent>('ai:session-title', (e) => cb(e.payload));
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
/** 回复数据库连接申请（request_db_connection 工具）：approved=true 时 connectionId 为前端
 *  已保存连接的 id（工具结果直接携带，AI 据此 db_query）；false 为拒绝。校验语义同 aiRespondApproval。 */
export const aiRespondDbRequest = (key: string, requestId: string, response: { approved: boolean; connectionId?: string }) =>
  call<void>('ai_respond_db_request', { key, requestId, response: JSON.stringify(response) });
/** 回复 ask 工具提问：response 为拼装好的「问/答」文本（取消传空串）。校验语义同 aiRespondApproval。 */
export const aiRespondAsk = (key: string, requestId: string, response: string) =>
  call<void>('ai_respond_ask', { key, requestId, response });
/** 回复 confirm 工具确认：confirmed=true 确认 / false 取消。校验语义同 aiRespondApproval。 */
export const aiRespondConfirm = (key: string, requestId: string, confirmed: boolean) =>
  call<void>('ai_respond_confirm', { key, requestId, confirmed });
export const onAiEvent = (key: string, cb: (ev: AiEvent) => void): Promise<UnlistenFn> =>
  listen<AiEvent>(`ai:event:${key}`, (e) => cb(e.payload));

/* ---------------- AI 会话 trace（Rust trace.rs） ----------------
   开关持久化在 AppState.traceEnabled（命令面板 `trace on/off`）；日志按会话分文件落盘
   （<config>/ai-trace/<日期>/<项目>__<会话>.jsonl），7 天过期由后端定时清理。
   trace_export 由后端做裁剪：成功的工具调用只留名称/状态/耗时，助手输出截断 1024 字素。 */
/** trace 开关状态（右键「追溯」菜单显隐用） */
export const traceStatus = () => call<boolean>('trace_status');
export const traceSetEnabled = (enabled: boolean) => call<void>('trace_set_enabled', { enabled });
/** 读取当前会话全部 trace（跨日期目录拼接，单文件最多回读尾部 2MB） */
export const traceRead = (key: string) => call<TraceEntry[]>('trace_read', { key });
/** 导出当前会话 trace（应用裁剪规则）到用户选定路径；返回导出行数 */
export const traceExport = (path: string, key: string) => call<number>('trace_export', { path, key });
/** 清空当前会话 trace（全部日期文件） */
export const traceClear = (key: string) => call<void>('trace_clear', { key });

/* ---------------- browser（内置浏览器多页面子 webview，Rust browser.rs） ----------------
   每个「页面」一个子 webview（viewId 由前端生成 p1/p2/…）；占位 div 经 ResizeObserver
   同步位置尺寸（仅活跃页面）；element 事件携带检查器选中的元素引用（均带 viewId）。 */
/** 懒创建该页面的子 webview，返回 url/title/inspect 供页面状态恢复 */
export const browserEnsure = (viewId: string) => call<BrowserState>('browser_ensure', { viewId });
export const browserSetRect = (viewId: string, x: number, y: number, w: number, h: number) =>
  call<void>('browser_set_rect', { viewId, x, y, w, h });
/** webview 显隐（活跃页面 && 标签激活 && 无全屏遮罩 的合成结果由前端计算后传入） */
export const browserSetVisible = (viewId: string, visible: boolean) =>
  call<void>('browser_set_visible', { viewId, visible });
/** 地址栏导航：本地路径（盘符/UNC）→ file://，无协议补 https://；返回归一化后的 URL */
export const browserNavigate = (viewId: string, input: string) =>
  call<string>('browser_navigate', { viewId, input });
export const browserBack = (viewId: string) => call<void>('browser_back', { viewId });
export const browserForward = (viewId: string) => call<void>('browser_forward', { viewId });
export const browserReload = (viewId: string) => call<void>('browser_reload', { viewId });
/** 检查元素模式开关（点击元素 → browser:event element → AI 引用 chip） */
export const browserSetInspect = (viewId: string, enabled: boolean) =>
  call<void>('browser_set_inspect', { viewId, enabled });
export const browserOpenDevtools = (viewId: string) => call<void>('browser_open_devtools', { viewId });
/** 关闭页面：释放该页面的子 webview 与 Rust 侧状态 */
export const browserCloseView = (viewId: string) => call<void>('browser_close_view', { viewId });
/** 记录地址栏历史：导航/标题事件后防抖上报（后端按 URL 合并去重保持 MRU，落盘 aishell.json） */
export const browserHistoryAdd = (url: string, title: string) =>
  call<void>('browser_history_add', { url, title });
/** 地址栏历史下拉数据源：query 对 URL/标题做大小写不敏感子串过滤，limit 默认 8，返回 MRU 序 */
export const browserHistoryList = (query: string, limit = 8) =>
  call<BrowserHistoryItem[]>('browser_history_list', { query, limit });
export const onBrowserEvent = (cb: (ev: BrowserEvent) => void): Promise<UnlistenFn> =>
  listen<BrowserEvent>('browser:event', (e) => cb(e.payload));

/** 保存内置浏览器 SOCKS5 代理配置：保存即生效——关闭所有现有浏览器子视图并广播
 *  browser:proxy-changed，标签页按 URL 自动重建（代理只能在子 webview 创建时注入）。 */
export const browserSetProxy = (cfg: BrowserProxyConfig) =>
  call<void>('browser_set_proxy', { cfg });
/** 代理配置变更通知（browser_set_proxy 保存后广播）；浏览器标签页据此自动重建。 */
export const onBrowserProxyChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen('browser:proxy-changed', () => cb());

/* ---------------- staging（会话级远程文件暂存，自动备份） ----------------
   快照在 AI 修改远程文件前自动创建；本组命令供「文件暂存区」面板 / diff 标签使用。
   staging_accept 只注册为前端命令，绝不加入 pi 工具 / guard 工具集 / 动作桥。 */
/** 用户主动暂存远程文件或目录（目录递归暂存全部文件）；同一会话已暂存时复用既有条目，不覆盖首次快照。 */
export const stagingAdd = (projectId: string, sessionId: string, serverId: string, remotePath: string) =>
  call<StagedFile[]>('staging_add', { projectId, sessionId, serverId, remotePath });
export const stagingList = (projectId: string, sessionId: string) =>
  call<StagedFile[]>('staging_list', { projectId, sessionId });
/** 读取快照侧内容：text 为已脱敏文本；二进制/超大只返回 hash/size/mtime 元数据 */
export const stagingSnapshotRead = (projectId: string, sessionId: string, entryId: string) =>
  call<StagingContent>('staging_snapshot_read', { projectId, sessionId, entryId });
/** 读取当前侧内容（实时从远端读取） */
export const stagingCurrentRead = (projectId: string, sessionId: string, entryId: string) =>
  call<StagingContent>('staging_current_read', { projectId, sessionId, entryId });
/** 接受暂存：只删除本地条目，不改远程内容 */
export const stagingAccept = (projectId: string, sessionId: string, entryId: string) =>
  call<StagedFile>('staging_accept', { projectId, sessionId, entryId });
/** 还原：先比较暂存记录的 current hash/size/mtime，冲突时返回结构化冲突；
 *  force=true 只由用户前端命令传入（AI 工具恒 false） */
export const stagingRestore = (projectId: string, sessionId: string, entryId: string, force: boolean) =>
  call<RestoreOutcome>('staging_restore', { projectId, sessionId, entryId, force });
/** 行级 diff（文本）或元数据对比（二进制/超大） */
export const stagingDiff = (projectId: string, sessionId: string, entryId: string) =>
  call<StagingDiff>('staging_diff', { projectId, sessionId, entryId });
/** 清理无变更条目：远端现状与首次快照完全一致的条目直接接受清除，有变更/检查失败的保留 */
export const stagingClear = (projectId: string, sessionId: string) =>
  call<StagingClearOutcome>('staging_clear', { projectId, sessionId });
/** 导出暂存备份：mode local = 快照复制到项目 .aishell/backup/（多条目打包 zip），remote =
 *  上传回条目原远程目录，文件名均加 _bak 后缀（stamp 为前端生成的本地时间 YYYYMMDD-HHMM，
 *  与 SFTP 快速备份同格式）；archiveName 仅多条目时需要（压缩包基础名，后缀后端追加）；
 *  accept=true 时导出成功的条目随后接受清除。与 staging_accept 同边界：绝不加入 pi 工具 / guard。 */
export const stagingExport = (
  projectId: string,
  sessionId: string,
  entryIds: string[],
  mode: 'local' | 'remote',
  archiveName: string | null,
  stamp: string,
  accept: boolean,
) => call<StagingExportOutcome>('staging_export', { projectId, sessionId, entryIds, mode, archiveName, stamp, accept });
/** 暂存/清理的进度事件（staging.rs add_path 逐文件、clear_unchanged 逐条目发送；walk/stage/clear 阶段，done 结束） */
export const onStagingProgress = (cb: (p: StagingProgress) => void): Promise<UnlistenFn> =>
  listen<StagingProgress>('staging:progress', (e) => cb(e.payload));
/** SFTP 传输进度事件（sftp.rs sftp_upload/sftp_download 发送；bytes/files 阶段，done 结束） */
export const onSftpProgress = (cb: (p: SftpProgress) => void): Promise<UnlistenFn> =>
  listen<SftpProgress>('sftp:progress', (e) => cb(e.payload));

/* ---------------- notes（会话归档 + 全局笔记树，Rust notes.rs） ----------------
   笔记是 workspace 全局 <workspace>/.aishell/notes 下的 markdown 文件树；
   面板 CRUD 复用 fs_* 命令（base 取 notesRoot 返回值）。
   session_archive 语义：脱敏 → LLM 生成/整合笔记并落盘（mode≠only）→ 标记 archived →
   杀会话 pi 进程；任一前置失败整体 Err，不归档不写文件。返回笔记绝对路径（only 模式为空串）。 */
export const notesRoot = () => call<string>('notes_root_cmd');
export const notesList = () => call<NotesListing>('notes_list_cmd');
export const sessionArchive = (args: {
  projectId: string;
  sessionId: string;
  mode: ArchiveMode;
  /** new 模式必填（笔记标题，后端清洗非法字符） */
  title?: string | null;
  /** new 模式可选（目标目录相对路径，空 = 根目录） */
  dirRel?: string | null;
  /** update 模式必填（既有笔记相对路径） */
  noteRel?: string | null;
  transcript: string;
}) => call<string>('session_archive', args);
/** 仅生成笔记（不归档、不杀会话进程）：与 session_archive 共用生成/落盘逻辑，仅支持 new/update 模式。
 *  返回笔记绝对路径；失败整体 Err，不写文件。 */
export const sessionNote = (args: {
  mode: Exclude<ArchiveMode, 'only'>;
  /** new 模式必填（笔记标题，后端清洗非法字符） */
  title?: string | null;
  /** new 模式可选（目标目录相对路径，空 = 根目录） */
  dirRel?: string | null;
  /** update 模式必填（既有笔记相对路径） */
  noteRel?: string | null;
  transcript: string;
}) => call<string>('session_note', args);

/* ---------------- skills ---------------- *//** 分别扫描全局、项目技能根；目录内有 SKILL.md 但 frontmatter 非法时返回带路径的中文错误 */
export const skillsList = (projectId: string) => call<SkillSummary[]>('skills_list', { projectId });
/** 读取单个技能完整文档（content 为 SKILL.md 原文） */
export const skillRead = (projectId: string, origin: SkillOrigin, name: string) =>
  call<SkillDocument>('skill_read', { projectId, origin, name });
/** 保存技能：scope 为管理 UI 的显式值（后端只重写 frontmatter 顶层 scope，其余字节不变）；
 *  originalName 传 null = 新增；编辑改名时后端整体迁移技能目录（保留附属资源） */
export const skillSave = (
  projectId: string,
  origin: SkillOrigin,
  originalName: string | null,
  content: string,
  scope: string[],
) => call<SkillSummary>('skill_save', { projectId, origin, originalName, content, scope });
export const skillDelete = (projectId: string, origin: SkillOrigin, name: string) =>
  call<void>('skill_delete', { projectId, origin, name });
/** 启停（只改 frontmatter 顶层 enabled 标量） */
export const skillSetEnabled = (projectId: string, origin: SkillOrigin, name: string, enabled: boolean) =>
  call<SkillSummary>('skill_set_enabled', { projectId, origin, name, enabled });

/* ---------------- misc ---------------- */
export { open as openDialog } from '@tauri-apps/plugin-dialog';
