/**
 * 前端 -> Rust 的全部 invoke 封装 + 事件订阅助手。
 * 这是前后端唯一契约：命令名 / 参数名 / 事件名以此文件为准，Rust 侧逐一对应。
 * 注意：Tauri 把 Rust snake_case 参数映射为 JS camelCase。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  AiMode, AppState, ChatSession, CloudMode, CloudStatus, DbConnection, DbKind, FsEntry, FsStat, KbHit, McpDeviceConfig, McpStatus, MemoryCard, MemoryEvent, MemoryHit, MemoryScope, Project, RestoreOutcome, Server, Settings, SftpFavorite, SftpProgress, SftpWriteResult, SkillDocument, SkillHubDetail, SkillHubList, SkillHubPublishOutcome, SkillHubVersionDetail, SkillOrigin, SkillSummary, StagedFile, StagingContent, StagingDiff, SshExecResult, Theme, UpdateProgress, UpdateReadyInfo, UpdateStatus, UsageReport, XshellImportResult, BrowserEvent, BrowserState, StagingClearOutcome, StagingProgress,
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
/** 写入某服务器的 SFTP 路径历史（MRU：最新在前，前端防抖后调用） */
export const setSftpHistory = (serverId: string, paths: string[]) =>
  call<void>('set_sftp_history', { serverId, paths });
/** 写入某服务器的 SFTP 收藏夹（路径 + 标题，按添加顺序，前端防抖后调用） */
export const setSftpFavorites = (serverId: string, favorites: SftpFavorite[]) =>
  call<void>('set_sftp_favorites', { serverId, favorites });
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
  | { type: 'approval'; requestId: string; toolCallId: string; action: string; intent: string; summary: string;
      /** 智能审批自动放行：true 时卡片直接展示「已智能放行」（后端已回 confirmed，无需再回复） */
      smart?: boolean; smartReason?: string;
      /** 影响计划（自动备份开启时）：effect 为 none|bounded|unbounded，unbounded 卡片展示「不保证完整备份」 */
      impact?: { effect: 'none' | 'bounded' | 'unbounded'; changes: Array<{ operation: string; path: string; destination?: string | null }>; reason: string };
      /** 数据库连接申请（request_db_connection 工具）：AI 填写的连接信息，审批对话框只读展示 */
      connection?: { serverId: string; name: string; kind: DbKind; host: string; port?: number; user?: string; database?: string } }
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
/** 回复数据库连接申请（request_db_connection 工具）：approved=true 时 connectionId 为前端
 *  已保存连接的 id（工具结果直接携带，AI 据此 db_query）；false 为拒绝。校验语义同 aiRespondApproval。 */
export const aiRespondDbRequest = (key: string, requestId: string, response: { approved: boolean; connectionId?: string }) =>
  call<void>('ai_respond_db_request', { key, requestId, response: JSON.stringify(response) });
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
/* ---------------- browser（内置浏览器子 webview，Rust browser.rs） ----------------
   面板占位 div 经 ResizeObserver 同步位置尺寸；element 事件携带检查器选中的元素引用。 */
/** 懒创建子 webview（全局单实例），返回 url/title/inspect 供面板恢复 */
export const browserEnsure = () => call<BrowserState>('browser_ensure');
export const browserSetRect = (x: number, y: number, w: number, h: number) =>
  call<void>('browser_set_rect', { x, y, w, h });
/** webview 显隐（面板激活 && 无全屏遮罩 的合成结果由前端计算后传入） */
export const browserSetVisible = (visible: boolean) =>
  call<void>('browser_set_visible', { visible });
/** 地址栏导航：本地路径（盘符/UNC）→ file://，无协议补 https://；返回归一化后的 URL */
export const browserNavigate = (input: string) =>
  call<string>('browser_navigate', { input });
export const browserBack = () => call<void>('browser_back');
export const browserForward = () => call<void>('browser_forward');
export const browserReload = () => call<void>('browser_reload');
/** 检查元素模式开关（点击元素 → browser:event element → AI 引用 chip） */
export const browserSetInspect = (enabled: boolean) =>
  call<void>('browser_set_inspect', { enabled });
export const browserOpenDevtools = () => call<void>('browser_open_devtools');
/** 驱动受限本地 ZIP 走可见的 SkillHub 页面流程；只返回终态，不额外广播进度事件。 */
export const browserPublishSkillhub = (projectId: string, origin: SkillOrigin, packagePath: string) =>
  call<SkillHubPublishOutcome>('browser_publish_skillhub', { projectId, origin, packagePath });
export const onBrowserEvent = (cb: (ev: BrowserEvent) => void): Promise<UnlistenFn> =>
  listen<BrowserEvent>('browser:event', (e) => cb(e.payload));

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
/** 暂存/清理的进度事件（staging.rs add_path 逐文件、clear_unchanged 逐条目发送；walk/stage/clear 阶段，done 结束） */
export const onStagingProgress = (cb: (p: StagingProgress) => void): Promise<UnlistenFn> =>
  listen<StagingProgress>('staging:progress', (e) => cb(e.payload));
/** SFTP 传输进度事件（sftp.rs sftp_upload/sftp_download 发送；bytes/files 阶段，done 结束） */
export const onSftpProgress = (cb: (p: SftpProgress) => void): Promise<UnlistenFn> =>
  listen<SftpProgress>('sftp:progress', (e) => cb(e.payload));

/* ---------------- skills ---------------- */
/** 分别扫描全局、项目技能根；目录内有 SKILL.md 但 frontmatter 非法时返回带路径的中文错误 */
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
export { open as openDialog } from '@tauri-apps/plugin-dialog';
