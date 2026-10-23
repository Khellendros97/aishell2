/**
 * 前端 -> Rust 的全部 invoke 封装 + 事件订阅助手。
 * 这是前后端唯一契约：命令名 / 参数名 / 事件名以此文件为准，Rust 侧逐一对应。
 * 注意：Tauri 把 Rust snake_case 参数映射为 JS camelCase。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AiMode, DashboardSpec, DashboardRender, AiWindowChangedEvent, AiRepairReport, AppState, ArchiveMode, AttachImageItem, AttachedImage, BrowserEvent, BrowserFavorite, BrowserHistoryItem, BrowserProxyConfig, BrowserState, ChatSession, CloudBackupPage, CloudBackupProgress, CloudMode, CloudStatus, ConfigChanged, Credential, CredentialMode, DbConnection, DbKind, DwsAuthStatus, DwsReportDraft, DwsSubmitResult, DwsTemplate, Feedback, FeedbackCategory, FeedbackPage, FeedbackStatus, FsEntry, FsStat, IncentiveLeaderboard, IncentivePoints, IncentiveRules, IncentiveSkillUpload, IncentiveTicketReport, InterruptedBackup, KbHit, KeyPairInfo, McpDeviceConfig, McpStatus, MemoryCard, MemoryEvent, MemoryHit, MemoryScope, NotesListing, PcapReadOut, Project, PublishPageState, ReadImageOut, RestoreCollisionMode, RestoreOutcome, Server, Settings, ServerCredentialDeleteResult, ServerSaveResult, SftpFavorite, SftpProgress, SftpWriteResult, SkillDocument, SkillHubDetail, SkillHubList, SkillHubPublishOutcome, SkillHubVersionDetail, SkillOrigin, SkillSummary, StagedFile, StagingClearOutcome, StagingContent, StagingDiff, StagingExportOutcome, StagingProgress, SshExecResult, SyncDevice, SyncStatus, Theme, TimelineCloudInfo, TimelineEntry, TimelineQuery, TimelineTag, TraceEntry, TunnelConfig, TunnelState, UpdateProgress, UpdateReadyInfo, UpdateStatus, UsageReport, XshellImportResult,
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
/** 当前工作区的系统任务项目（main 侧引入）：按 workspace 合成，用于「任务」会话默认绑定 */
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
/** 删除服务器并尽量清理其关联凭据：凭据已无其他服务器引用时一并删除，否则保留。 */
export const deleteServerWithCredentials = (id: string) =>
  call<ServerCredentialDeleteResult>('delete_server_with_credentials', { id });
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
/** 导出终端会话输出到用户选定的本地文件（save 对话框已确认路径/覆盖）。 */
export const termExport = (path: string, content: string) =>
  call<string>('term_export', { path, content });
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
/** 确保目录存在（多级创建，幂等）；已存在但不是目录会 reject。 */
export const fsEnsureDir = (path: string) => call<void>('fs_ensure_dir', { path });
/** 本地文件被外部修改（AI write/edit 落盘）通知：path 为规范化绝对路径 */
export const onFsChanged = (cb: (path: string) => void): Promise<UnlistenFn> =>
  listen<{ path: string }>('fs:changed', (e) => cb(e.payload.path));
/** 移动/重命名：to 为完整目标路径；目标已存在会 reject。 */
export const fsMove = (from: string, to: string) => call<void>('fs_move', { from, to });
/** 复制进 toDir（重名自动改名）；返回落地路径。 */
export const fsCopy = (from: string, toDir: string) => call<string>('fs_copy', { from, toDir });
/** 在系统文件资源管理器中定位 */
export const fsReveal = (path: string) => call<void>('fs_reveal', { path });
/** 用系统默认应用打开本地文件；无关联程序/失败会 reject（调用方回退 fsReveal） */
export const fsOpenDefault = (path: string) => call<void>('fs_open_default', { path });
/** 读取单项属性（属性对话框用）：mode 仅 Unix 有值（本地 Windows 为 null），linkTarget 仅符号链接有值 */
export const fsStat = (path: string) => call<FsStat>('fs_stat', { path });

/* ---------------- pcap ---------------- */
/** 读取抓包文件（pcap/pcapng）为 base64：本地传 path；远端加传 serverId（path 为远端路径）。
 *  >128MB 或非抓包魔数会 reject 中文错误 */
export const pcapRead = (path: string, serverId?: string) =>
  call<PcapReadOut>('pcap_read', { path, serverId: serverId ?? null });

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
/** 远端文件「系统方式打开」：先下载到临时目录，action=open 系统默认应用打开 / reveal 资源管理器定位；
 *  返回落地本地路径；无默认应用时 reject（调用方回退 reveal） */
export const sftpOpen = (serverId: string, remotePath: string, action: 'open' | 'reveal') =>
  call<string>('sftp_open', { serverId, remotePath, action });
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
/** 保存隧道配置（按 id upsert）；enabled=true 时自动启动（失败 Err 返回错误文本）。
 *  closeConflict=true 表示用户已确认关闭占用端口的冲突隧道（首次尝试撞冲突时后端返回
 *  「[隧道端口冲突]」前缀错误，前端确认后带 true 重试）。 */
export const tunnelSave = (tunnel: TunnelConfig, closeConflict = false) =>
  call<TunnelState>('tunnel_save', { cfg: tunnel, closeConflict });
export const tunnelStart = (id: string, closeConflict = false) =>
  call<TunnelState>('tunnel_start', { id, closeConflict });
export const tunnelStop = (id: string) => call<void>('tunnel_stop', { id });
export const tunnelDelete = (id: string) => call<void>('tunnel_delete', { id });
/** 隧道列表变更（启动/停止/保存/删除/重启恢复）后的全局通知。 */
export const onTunnelsChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen('tunnels:changed', () => cb());

/* ---------------- ai ---------------- */
/** 后端发出的 AI 回合事件（key = `<projectId>:<sessionId>`）：
 *  - approval：Agent 模式逐调用审批请求（对应 pi extension_ui_request/confirm）；
 *  - actionStart/actionEnd：受控工具（write/edit/delete_path/run_command/sftp_upload/sftp_download）
 *    执行生命周期（来自 tool_execution_start/end，toolCallId 关联审批卡）；
 *  - settled：回合以 error 收尾（pi 不补发 done）时的收尾信号，前端据此把已流出的正文定稿落盘。 */
export type AiEvent =
  | { type: 'delta'; text: string }
  /** 思维链增量：生成中临时预览（「深度思考 n 秒」+ 横向滚动正文），不进历史；
   *  正文/工具/回合结束事件到达后前端丢弃该组件 */
  | { type: 'thinking'; text: string }
  /** 思维链结束：立即移除预览组件（正文尚未开始的空档回到「正在输入」） */
  | { type: 'thinkingEnd' }
  | { type: 'tool'; tool: string; label: string }
  | { type: 'segment' }
  | { type: 'done' }
  | { type: 'settled' }
  /** 后端会话自愈等纯信息提示（不进对话历史，前端只弹 toast）：
   *  - 发送前自动修复：会话历史损坏已修复、AI 进程已重启
   *  - 终态错误后检测：发现损坏，下一条消息发送前会自动修复 */
  | { type: 'notice'; message: string }
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
  | { type: 'ask'; requestId: string; toolCallId: string; questions: Array<{ question: string; options?: string[]; multi?: boolean }> }
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
/** 内嵌 pi 运行时版本（设置-关于与更新展示；后端优先读 resources/pi/VERSION，缺失回退 pi --version） */
export const piVersion = () => call<string>('pi_version');
/** 工作台卸载/切项目时调用：kill 该项目全部 pi 进程 */
export const aiKillProject = (projectId: string) => call<void>('ai_kill_project', { projectId });
/** 修复会话历史（右键菜单「修复会话」）：杀会话 pi 进程后校验修复 sessions jsonl
 *  （孤儿工具结果删除、缺失结果补齐；备份 .jsonl.bak 后原子写回），下一条消息按同一文件
 *  懒重启加载修复后内容；文件无结构问题时仅完成进程重启（治愈 pi 内存态损坏）。 */
export const aiRepairSession = (projectId: string, sessionId: string) =>
  call<AiRepairReport>('ai_repair_session', { projectId, sessionId });
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

/* ---------------- cloud（云服务 OAuth2，CR-1） ----------------
   协议以 docs/AIShell云服务-OAuth2接入文档.md 为准；token 永不返回前端。 */
/** 发起登录：返回授权 URL（系统浏览器打开）；后端同时起本地回环回调监听。
 *  未注入云配置的构建返回中文错误（正常路径不调用）。 */
export const cloudBeginLogin = () => call<string>('cloud_begin_login');
/** 取消进行中的登录（作废 state 并关闭回调监听） */
export const cloudCancelLogin = () => call<void>('cloud_cancel_login');
/** 退出登录：尽力吊销服务端 refresh_token，本地清 keyring + cloud 段 */
export const cloudLogout = () => call<void>('cloud_logout');
/** 当前云状态（登录态/用户/能力/服务器地址/模式；token 不在此） */
export const cloudStatus = () => call<CloudStatus>('cloud_status');
/** 切换托管/个人模式 */
export const cloudSetMode = (mode: CloudMode) => call<void>('cloud_set_mode', { mode });
/** 登录/登出/登录失效/模式切换后广播（载荷 = CloudStatus） */
export const onCloudChanged = (cb: (s: CloudStatus) => void): Promise<UnlistenFn> =>
  listen<CloudStatus>('cloud:changed', (e) => cb(e.payload));

/* ---------------- 云同步与云备份（token / 密码 / vaultKey 全程留在 Rust 端） ---------------- */
export const cloudSyncStatus = () => call<SyncStatus>('cloud_sync_status');
export const cloudSyncInitialize = (password: string) => call<SyncStatus>('cloud_sync_initialize', { password });
export const cloudSyncUnlock = (password: string) => call<SyncStatus>('cloud_sync_unlock', { password });
export const cloudSyncLock = () => call<SyncStatus>('cloud_sync_lock');
export const cloudSyncNow = () => call<SyncStatus>('cloud_sync_now');
export const cloudSyncResolveConflict = (conflictId: string, resolution: string) =>
  call<SyncStatus>('cloud_sync_resolve_conflict', { conflictId, resolution });
export const cloudSyncChangePassword = (oldPassword: string, newPassword: string) =>
  call<SyncStatus>('cloud_sync_change_password', { oldPassword, newPassword });
/** 删除全部云端数据需要 Rust 发送固定确认头，前端只传入确认短语作为二次确认。 */
export const cloudSyncDeleteAll = (confirmation: string) =>
  call<void>('cloud_sync_delete_all', { confirmation });
export const cloudSyncDevices = () => call<SyncDevice[]>('cloud_sync_devices');
export const cloudSyncRenameDevice = (deviceId: string, name: string) =>
  call<SyncDevice>('cloud_sync_rename_device', { deviceId, name });
export const cloudSyncRevokeDevice = (deviceId: string) =>
  call<void>('cloud_sync_revoke_device', { deviceId });
export const cloudSyncReregisterDevice = (name?: string) =>
  call<SyncDevice>('cloud_sync_reregister_device', { name: name ?? null });

export const cloudBackupsList = (cursor?: string | null, limit?: number) =>
  call<CloudBackupPage>('cloud_backups_list', { cursor: cursor ?? null, limit: limit ?? null });
export const cloudBackupStart = (path: string) => call<string>('cloud_backup_start', { path });
export const cloudBackupCancel = (taskId: string) => call<void>('cloud_backup_cancel', { taskId });
export const cloudBackupResume = (backupId: string) => call<string>('cloud_backup_resume', { backupId });
/** 本地记录里未完成的备份草稿（服务端列表不返回 draft，续传/放弃以这里为准） */
export const cloudBackupInterrupted = () => call<InterruptedBackup[]>('cloud_backup_interrupted');
export const cloudBackupAbandon = (taskId: string) => call<void>('cloud_backup_abandon', { taskId });
export const cloudBackupRestore = (backupId: string, targetPath: string, collisionMode: RestoreCollisionMode) =>
  call<void>('cloud_backup_restore', { backupId, targetPath, collisionMode });
export const cloudBackupDelete = (backupId: string) => call<void>('cloud_backup_delete', { backupId });
export const onCloudSyncChanged = (cb: (s: SyncStatus) => void): Promise<UnlistenFn> =>
  listen<SyncStatus>('cloud-sync:changed', (e) => cb(e.payload));
export const onCloudBackupProgress = (cb: (p: CloudBackupProgress) => void): Promise<UnlistenFn> =>
  listen<CloudBackupProgress>('cloud-backup:progress', (e) => cb(e.payload));
export const onCloudBackupChanged = (cb: () => void): Promise<UnlistenFn> =>
  listen<unknown>('cloud-backup:changed', () => cb());

/* ---------------- 用量报表 / 记忆卡片（token 全程留在 Rust 端，前端只收结构化数据） ---------------- */
/** 个人用量报表（GET /api/usage）；days 1–90 默认 14；kind llm|search；model 仅 LLM 过滤 */
export const cloudUsage = (days?: number, kind?: string, model?: string) =>
  call<UsageReport>('cloud_usage', { days: days ?? null, kind: kind ?? '', model: model ?? '' });
/** 记忆卡片（GET /api/memories）；scope：缺省/all = 共享+我的个人，shared 仅共享，personal 仅我的个人 */
export const memoriesList = (scope?: MemoryScope) =>
  call<MemoryCard[]>('memories_list', { scope: scope ?? '' });
/** 主动提交记忆（POST /api/memories，原文保存）；scope 默认 shared，个人记录用 personal */
export const memoryCreate = (content: string, category: string, tags: string[], scope?: MemoryScope) =>
  call<MemoryCard>('memory_create', { content, category, tags, scope: scope ?? '' });
/** 编辑/纠正卡片（PUT /api/memories/{id}）；note 可选纠正说明 */
export const memoryUpdate = (id: string, content: string, category: string, tags: string[], note?: string) =>
  call<void>('memory_update', { id, content, category, tags, note: note ?? '' });
/** 删除卡片（DELETE /api/memories/{id}，不可恢复） */
export const memoryDelete = (id: string) => call<void>('memory_delete', { id });
/** 单卡变更历史（GET /api/memories/{id}/history） */
export const memoryHistory = (id: string) => call<MemoryEvent[]>('memory_history', { id });
/** 语义检索记忆（POST /api/memories/search）；topK 默认 10 */
export const memorySearch = (query: string, topK?: number, scope?: MemoryScope) =>
  call<MemoryHit[]>('memory_search', { query, topK: topK ?? null, scope: scope ?? '' });
/** 个人卡片提升为共享（POST /api/memories/{id}/promote）；返回新共享卡片 id */
export const memoryPromote = (id: string) => call<string>('memory_promote', { id });
/** 知识库语义检索（GET /api/kb/search，开放 API 文档 §4.1）：只读透传，命中带相关度 score
 *  供前端「自动注入」客户端检索用；AI 工具侧的 kb_search 走 pi 扩展。 */
export const kbSearch = (query: string, limit?: number, workspaceId?: number | null) =>
  call<KbHit[]>('kb_search', { query, limit: limit ?? null, workspaceId: workspaceId ?? null });

/* ---------------- 用户反馈（用户反馈 API 文档；token 全程留在 Rust 端） ----------------
   提交为 multipart/form-data（附件传本地文件绝对路径，由后端读取上传）；
   列表/详情只返回本人反馈，状态由管理员后台流转（用户只读）。 */
/** 提交反馈（POST /api/feedback）；attachmentPaths 为本地文件绝对路径（最多 10 个，单个 ≤20MB） */
export const feedbackSubmit = (
  category: FeedbackCategory,
  title: string,
  content: string,
  attachmentPaths?: string[],
) => call<Feedback>('feedback_submit', { category, title, content, attachmentPaths: attachmentPaths ?? null });
/** 分页查询本人反馈（GET /api/feedback）；status/category 传 '' 或 undefined = 不过滤 */
export const feedbackList = (page?: number, pageSize?: number, status?: FeedbackStatus | '', category?: FeedbackCategory | '') =>
  call<FeedbackPage>('feedback_list', {
    page: page ?? null,
    pageSize: pageSize ?? null,
    status: status ?? '',
    category: category ?? '',
  });
/** 反馈详情（GET /api/feedback/:id） */
export const feedbackDetail = (id: number) => call<Feedback>('feedback_detail', { id });
/** 下载本人反馈附件到指定本地路径（savePath 由保存对话框取得） */
export const feedbackDownloadAttachment = (id: number, attachmentId: number, savePath: string) =>
  call<void>('feedback_download_attachment', { id, attachmentId, savePath });

/* ---------------- 员工激励计划（激励计划 API 文档；token 全程留在 Rust 端） ----------------
   能力位 capabilities.incentive 为 false 时隐藏全部入口（调用会 403）。
   skill 上传登记在上传成功后由 SkillsPanel 自动调用；工单报告提交为 multipart（附件传本地绝对路径）。 */
/** 计分规则（GET /api/incentive/rules，§3.2） */
export const incentiveRules = () => call<IncentiveRules>('incentive_rules');
/** 本人积分汇总 + 明细分页（GET /api/incentive/points/mine，§3.3） */
export const incentivePointsMine = (page?: number, pageSize?: number) =>
  call<IncentivePoints>('incentive_points_mine', { page: page ?? null, pageSize: pageSize ?? null });
/** 查看任意用户积分明细（GET /api/incentive/points/users/:id，§3.4） */
export const incentivePointsUser = (userId: number, page?: number, pageSize?: number) =>
  call<IncentivePoints>('incentive_points_user', { userId, page: page ?? null, pageSize: pageSize ?? null });
/** 全员积分排行榜（GET /api/incentive/points/leaderboard，§3.5） */
export const incentiveLeaderboard = () => call<IncentiveLeaderboard>('incentive_leaderboard');
/** skill 上传登记（POST /api/incentive/skill-uploads，§一）；namespace 缺省 global */
export const incentiveRegisterSkillUpload = (slug: string, namespace?: string) =>
  call<IncentiveSkillUpload>('incentive_register_skill_upload', { namespace: namespace ?? null, slug });
/** 提交工单处理报告（POST /api/incentive/ticket-reports，§二）；attachmentPaths 为本地绝对路径 */
export const incentiveSubmitTicketReport = (
  title: string,
  content: string,
  ticketRef?: string,
  attachmentPaths?: string[],
) => call<IncentiveTicketReport>('incentive_submit_ticket_report', {
  title, content, ticketRef: ticketRef ?? '', attachmentPaths: attachmentPaths ?? null,
});

/* ---------------- AI 助手窗口分离/聚合（Rust ai_window.rs） ----------------
   分离 = 宿主窗口释放该项目引擎上下文（flush 落盘 + 退订），pi 进程与 aishell.json
   会话快照 app 级共享，独立窗口重新挂载即可无缝续流；聚合 = 反向。 */
/** 分离 AI 助手到独立窗口（同项目重复调用 = 聚焦；异项目已有分离窗口时返回中文错误） */
export const aiWindowOpen = (projectId: string, sessionId: string | null, host: 'workbench' | 'welcome') =>
  call<void>('ai_window_open', { projectId, sessionId, host });
/** 聚合还原：优雅关闭分离窗口（分离窗口 JS 侧先释放上下文再放行） */
export const aiWindowClose = () => call<void>('ai_window_close');
/** 后端进程表是否有任一 pi 忙（生成/审批等待）：主窗口关闭守卫的跨窗口查询 */
export const aiAnyBusy = () => call<boolean>('ai_any_busy');
/** 「添加到对话」跨窗口转发：wbHandles.ai 转发桩 → 分离窗口插入引用 chip */
export const aiForwardRef = (projectId: string, payload: Record<string, unknown>) =>
  call<void>('ai_forward_ref', { projectId, payload });
/** 分离状态广播（建窗/窗口销毁都会发；宿主窗口据此显隐 AI 面板） */
export const onAiWindowChanged = (cb: (ev: AiWindowChangedEvent) => void): Promise<UnlistenFn> =>
  listen<AiWindowChangedEvent>('ai:window-changed', (e) => cb(e.payload));
/** 「添加到对话」转发事件（仅分离窗口监听） */
export const onAiForwardRef = (projectId: string, cb: (payload: Record<string, unknown>) => void): Promise<UnlistenFn> =>
  listen<Record<string, unknown>>(`ai:forward-ref:${projectId}`, (e) => cb(e.payload));

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

/* ---------------- 项目时间线（Rust timeline.rs） ----------------
   按天滚动落盘 <项目>/.aishell/timeline/YYYY-MM-DD.jsonl，保留 30 天（后端写线程每天
   首次写入时清理）；无开关、默认常开。事件源：SSH 连接池（connect/disconnect）、
   终端命令区块（前端上报）、ssh_exec / SFTP 传输、AI 会话（提问/回答/工具调用）。 */
/** 前端事件上报（终端命令区块定稿）：fire-and-forget，失败静默 */
export const timelineReport = (projectId: string, kind: string, summary: string, detail?: string) =>
  call<void>('timeline_report', { projectId, kind, summary, detail: detail ?? null });
/** 时间线搜索（关键词/类别/时间段过滤，倒序返回） */
export const timelineSearch = (projectId: string, query: TimelineQuery) =>
  call<TimelineEntry[]>('timeline_search', { projectId, query });
/** 登记 serverId 的项目归属（打开 SSH 终端/SFTP 标签时调用，连接事件按归属项目落盘） */
export const timelineBindServer = (projectId: string, serverId: string) =>
  call<void>('timeline_bind_server', { projectId, serverId });
/** 给事件打标签（anchorTs/anchorKind 定位事件；两个同名标签构成标签对划定选区） */
export const timelineTagAdd = (projectId: string, name: string, color: string, anchorTs: number, anchorKind: string) =>
  call<TimelineTag>('timeline_tag_add', { projectId, name, color, anchorTs, anchorKind });
/** 删除标签（按 名称+锚点 匹配，同名同锚点多条一并删） */
export const timelineTagRemove = (projectId: string, name: string, anchorTs: number, anchorKind: string) =>
  call<number>('timeline_tag_remove', { projectId, name, anchorTs, anchorKind });
/** 更新闭合位置：该名称最近一个闭合选区的结束锚点移到目标事件，沿用原颜色 */
export const timelineTagReclose = (projectId: string, name: string, anchorTs: number, anchorKind: string) =>
  call<TimelineTag>('timeline_tag_reclose', { projectId, name, anchorTs, anchorKind });
/** 列出项目全部标签记录（按打标时间倒序；按名去重取最新颜色由调用方做） */
export const timelineTags = (projectId: string) =>
  call<TimelineTag[]>('timeline_tags', { projectId });

/* ---------------- 时间线云同步（Rust timeline_upload.rs） ----------------
   60s 周期按水位把本地时间线脱敏增量上传云端（登录 + timelineSync 能力 + 本机开关三层判定），
   协议见 docs/AIShell云服务-时间线云同步API文档.md；云端供工作台/管理后台跨项目统一时间线。 */
/** 云同步状态（设置页展示：三层开关满足情况 + 容量超限标记） */
export const timelineCloudInfo = () => call<TimelineCloudInfo>('timeline_cloud_info');
/** 删除本人全部云端时间线（事件+标签，服务端写审计）；本机文件与水位不动，删除后从新事件重新累积 */
export const timelineCloudPurge = () =>
  call<{ deletedEvents: number; deletedTags: number }>('timeline_cloud_purge');

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
/** 驱动受限本地 ZIP 走可见的 SkillHub 页面流程；只返回终态，不额外广播进度事件。 */
export const browserPublishSkillhub = (projectId: string, origin: SkillOrigin, packagePath: string) =>
  call<SkillHubPublishOutcome>('browser_publish_skillhub', { projectId, origin, packagePath });
/** 读取 SkillHub 发布页当前状态（URL + namespace）：手动发布计分观察器轮询用。
 *  SPA 路由跳转不触发 browser:event 的 url 事件，只能主动轮询；非发布页返回空 url。 */
export const browserPublishState = () => call<PublishPageState>('browser_publish_state');
/** 记录地址栏历史：导航/标题事件后防抖上报（后端按 URL 合并去重保持 MRU，落盘 aishell.json） */
export const browserHistoryAdd = (url: string, title: string) =>
  call<void>('browser_history_add', { url, title });
/** 地址栏历史下拉数据源：query 对 URL/标题做大小写不敏感子串过滤，limit 默认 8，返回 MRU 序 */
export const browserHistoryList = (query: string, limit = 8) =>
  call<BrowserHistoryItem[]>('browser_history_list', { query, limit });
/** 写入收藏夹：前端维护整列表（url 去重、添加/移除、防抖回写），后端整列表覆盖落盘；
 *  读取走 getState().browserFavorites。 */
export const browserSetFavorites = (favorites: BrowserFavorite[]) =>
  call<void>('browser_set_favorites', { favorites });
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
 *  上传回条目原远程目录，文件名均加 _bak 后缀（插在扩展名前；stamp 为前端生成的本地时间
 *  YYYYMMDD-HHMM，与 SFTP 快速备份同格式）；archiveName 仅多条目时需要（压缩包基础名，后缀后端追加）；
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

/* ---------------- 钉钉日志发布（Rust dws.rs，经本机 dws CLI） ----------------
   流程：dwsAuthStatus 检测认证 → dwsReportTemplates 列模版 → dwsReportGenerate
   （后端读笔记 + 查模版字段 + LLM 整理为 contents JSON，前端预览可编辑）→
   dwsReportSubmit（后端写临时 report.json 调 dws 提交，无论成败即删临时文件）。 */
/** 检测 dws 认证状态；installed=false 表示未安装 dws CLI，由前端展示引导 */
export const dwsAuthStatus = () => call<DwsAuthStatus>('dws_auth_status');
/** 列出当前用户可用的日志模版 */
export const dwsReportTemplates = () => call<DwsTemplate[]>('dws_report_templates');
/** LLM 整理笔记为日志 contents JSON；返回模版 id + contents 字符串（pretty，供预览编辑） */
export const dwsReportGenerate = (templateName: string, notePath: string) =>
  call<DwsReportDraft>('dws_report_generate', { templateName, notePath });
/** 按模版提交日志；contentsJson 须为 DwsReportContent 数组的 JSON 串 */
export const dwsReportSubmit = (templateId: string, contentsJson: string) =>
  call<DwsSubmitResult>('dws_report_submit', { templateId, contentsJson });

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
/** 打包本地 Skill 为仅供 browserPublishSkillhub 使用的临时 ZIP，返回规范化绝对路径。 */
export const skillPackUpload = (projectId: string, origin: SkillOrigin, name: string) =>
  call<string>('skill_pack_upload', { projectId, origin, name });

/* ---------------- SkillHub（云端技能市场） ---------------- */
export const skillHubList = (q: string, cursor: string | null, size = 24) =>
  call<SkillHubList>('skillhub_list', { q: q || null, cursor, size });
export const skillHubDetail = (namespace: string, slug: string) =>
  call<SkillHubDetail>('skillhub_detail', { namespace, slug });
export const skillHubVersionDetail = (namespace: string, slug: string, version: string) =>
  call<SkillHubVersionDetail>('skillhub_version_detail', { namespace, slug, version });
export const skillHubDownload = (
  projectId: string,
  origin: SkillOrigin,
  namespace: string,
  slug: string,
  version: string,
) => call<SkillSummary>('skillhub_download', { projectId, origin, namespace, slug, version });

/* ---------------- update（客户端自动更新，Rust update.rs） ----------------
   后端持有唯一更新任务；检查/下载不带任何用户 token，公钥内置于客户端。 */
/** 当前更新状态快照（此后以 update:status-changed 事件为准） */
export const updateStatus = () => call<UpdateStatus>('update_status');
/** 手动检查更新；失败 reject 中文错误（后台检查失败只写 debug 日志不弹错） */
export const updateCheck = () => call<UpdateStatus>('update_check');
/** 下载并由 Tauri updater 验签；完成后 state=ready 并广播 update:ready */
export const updateDownload = () => call<UpdateStatus>('update_download');
/** 重启并安装（用户确认后）。Windows 上安装器拉起后应用即退出，本调用不会 resolve。 */
export const updateInstall = () => call<void>('update_install');
/** 状态切换（载荷 = UpdateStatus 全量快照） */
export const onUpdateStatusChanged = (cb: (s: UpdateStatus) => void): Promise<UnlistenFn> =>
  listen<UpdateStatus>('update:status-changed', (e) => cb(e.payload));
/** 下载进度（downloaded 字节 / total 可选总量） */
export const onUpdateDownloadProgress = (cb: (p: UpdateProgress) => void): Promise<UnlistenFn> =>
  listen<UpdateProgress>('update:download-progress', (e) => cb(e.payload));
/** 新版本就绪（提示用户「重启并更新」） */
export const onUpdateReady = (cb: (info: UpdateReadyInfo) => void): Promise<UnlistenFn> =>
  listen<UpdateReadyInfo>('update:ready', (e) => cb(e.payload));

/* ---------------- misc ---------------- */
export { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog';

/* ---------------- 仪表盘 ---------------- */
/** 渲染项目仪表盘（执行 .aishell/dashboard/dashboard.py 并取组件 spec） */
export const dashboardRender = (projectId: string) =>
  call<DashboardRender>('dashboard_render', { projectId });
/** 保存仪表盘备忘录（memo.md，原子写） */
export const dashboardSaveMemo = (projectId: string, content: string) =>
  call<void>('dashboard_save_memo', { projectId, content });
/** 保存备忘录顶部的可编辑表格（table.json 整表覆盖写） */
export const dashboardSaveTable = (projectId: string, columns: { key: string; title: string }[], rows: Record<string, string>[]) =>
  call<void>('dashboard_save_table', { projectId, columns, rows });
/** 渐进渲染帧（脚本每声明一个组件推一帧；面板边采集边渲染，不等脚本跑完） */
export const onDashboardProgress = (cb: (projectId: string, spec: DashboardSpec) => void): Promise<UnlistenFn> =>
  listen<{ projectId: string; spec: DashboardSpec }>('dashboard:progress', (e) => cb(e.payload.projectId, e.payload.spec));
/** 仪表盘变更通知（AI reload / memo 保存后广播，面板据此即时刷新） */
export const onDashboardChanged = (cb: (projectId: string) => void): Promise<UnlistenFn> =>
  listen<{ projectId: string }>('dashboard:changed', (e) => cb(e.payload.projectId));
