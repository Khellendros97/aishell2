/**
 * 共享数据模型 —— 与 Rust store.rs 的 serde camelCase 严格对齐，字段名以 .proto/shared/mock.js 为准。
 * 修改任何字段名都必须同步 Rust 侧。
 */
export interface LlmConfig {
  modelId: string;
  baseUrl: string;
  /** v4 系列思考档位；旧配置的 medium 后端已兼容映射为 low */
  effort: 'low' | 'high' | 'max';
}

export interface SearchConfig {
  enabled: boolean;
}

/** 知识库配置（云端只读中转，开放 API 文档 §4）：autoInject 只控制「发消息前自动把分数最高的前 N 条命中注入用户输入」；
 *  kb_search 工具挂载不受它影响（托管模式且平台启用 knowledge 能力时始终提供给 AI 助手）。 */
export interface KnowledgeConfig {
  /** 是否开启知识库自动注入（开启会降低 AI 响应速度） */
  autoInject: boolean;
  /** 自动注入的命中条数（1–20） */
  injectCount: number;
}

/** 知识库语义检索命中（开放 API 文档 §4.1，响应为顶层命中数组）。字段为上游原生 snake_case
 *  （KbHit 是云平台只读透传结构，未做 camelCase 重命名，故此处保持 snake_case 与 Rust 对齐）。 */
export interface KbHit {
  chunk_id: number | null;
  document_id: number | null;
  document_title: string;
  heading_path: string;
  score: number;
  snippet: string;
  content_preview: string;
  content: string;
  workspace_id: number | null;
  workspace_name: string;
  retrieval_type: string;
}

export interface Settings {
  workspaceDir: string | null;
  llm: LlmConfig;
  /** 联网搜索配置；旧配置无此字段时按关闭处理 */
  search: SearchConfig;
  /** 知识库配置；旧配置无此字段时按默认开启自动注入处理 */
  knowledge: KnowledgeConfig;
  theme: Theme;
  /** 自动切换 AI 工作区域：开启后 AI 输入框显示固定工作区域标签，随激活终端自动切换；旧配置无此字段按开启 */
  autoSwitchAiWorkdir: boolean;
  /** 欢迎页项目视图；旧配置无此字段按卡片视图 */
  projectView: 'card' | 'list';
  /** 审批模式（智能审批/全部审批）；旧配置无此字段按智能审批 */
  approvalMode: 'smart' | 'all';
  /** 云服务接入（公司服务器托管）；旧配置无此字段按未接入处理 */
  cloud: CloudConfig;
  /** 自动备份远程文件：开启后 AI 会话第一次修改某远程文件前保存原始快照（会话级暂存区）；旧配置无此字段按开启 */
  autoBackupRemoteFiles: boolean;
}

/** 云服务接入模式（与 store.rs CloudMode serde lowercase 对齐） */
export type CloudMode = 'hosted' | 'personal';

/** 登录用户展示资料（token 永不进 JSON、永不返回前端） */
export interface CloudUser {
  /** 平台用户数字 id（/api/auth/me 带回；记忆卡片权限判断用） */
  id: number | null;
  name: string;
  avatar: string | null;
  dept: string | null;
}

/** 服务端能力清单（登录后缓存，供托管模式 UI 使用） */
export interface CloudCapabilities {
  models: string[];
  search: boolean;
  knowledge: boolean;
  /** 是否开通用户数据同步；旧服务端缺失时按关闭处理 */
  dataSync: boolean;
  /** 是否开通文件云备份；旧服务端缺失时按关闭处理 */
  fileBackup: boolean;
  latestVersion: string | null;
}

/** 云同步配额（云端不返回任何密钥或明文配置） */
export interface SyncQuota {
  usedBytes: number;
  totalBytes: number;
  backupUsedBytes: number;
  backupTotalBytes: number;
}

/** 云同步服务端限制 */
export interface SyncLimits {
  maxBatchItems: number;
  maxBatchBytes: number;
  inlinePayloadBytes: number;
  maxBackupBytes: number;
  maxBackupFiles: number;
  maxConcurrentBackups: number;
}

/** 同步冲突摘要；localValue/remoteValue 仅为非敏感展示摘要，绝不含凭据明文 */
export interface SyncConflict {
  id: string;
  kind: string;
  entityType: string;
  entityId: string;
  summary: string;
  localDevice: string | null;
  remoteDevice: string | null;
  createdAt: string;
  path?: string | null;
}

/** 云同步设备（installationId/deviceId 只作为标识展示，不是密钥） */
export interface SyncDevice {
  id: string;
  deviceId?: string;
  installationId?: string;
  name: string;
  isCurrent: boolean;
  revoked: boolean;
  lastSeenAt: string | null;
  createdAt: string | null;
}

/** cloud_sync_status 返回值 / cloud-sync:changed 事件载荷 */
export interface SyncStatus {
  enabled: boolean;
  backupEnabled: boolean;
  initialized: boolean;
  unlocked: boolean;
  syncing: boolean;
  status: 'idle' | 'syncing' | 'offline' | 'conflict' | 'quotaExceeded' | 'locked' | string;
  lastSuccessAt: string | null;
  /** 兼容后端以 lastSyncAt 命名的状态字段 */
  lastSyncAt?: string | null;
  pendingCount: number;
  conflicts: SyncConflict[];
  quota: SyncQuota;
  limits: SyncLimits;
  device: SyncDevice | null;
}

/** 云端文件备份条目；锁定时 name/rootMeta 可为空，避免泄露本地路径 */
export interface CloudBackup {
  id: string;
  name: string | null;
  deviceName: string | null;
  createdAt: string;
  completedAt: string | null;
  sizeBytes: number;
  fileCount: number;
  status: 'completed' | 'draft' | 'failed' | string;
  locked: boolean;
  rootMeta?: { name?: string | null; isDir?: boolean; fileCount?: number; sizeBytes?: number } | null;
}

/** cloud_backups_list 分页结果 */
export interface CloudBackupPage {
  items: CloudBackup[];
  nextCursor: string | null;
  total?: number;
}

/** cloud-backup:progress 事件载荷 */
export interface CloudBackupProgress {
  taskId: string;
  phase: 'scan' | 'encrypt' | 'upload' | 'finalize' | 'done' | 'error' | 'cancelled' | string;
  currentPath: string;
  filesDone: number;
  filesTotal: number;
  doneBytes: number;
  totalBytes: number;
  speedBytesPerSecond: number;
  cancellable: boolean;
  error?: string | null;
}

/** 恢复遇到目标同名文件时的处理方式（与 Rust serde lowercase 对齐） */
export type RestoreCollisionMode = 'skip' | 'keepBoth' | 'overwrite';

/** 本地可续传/可放弃的中断备份任务（服务端列表只含 completed，草稿只存在本地记录里） */
export interface InterruptedBackup {
  taskId: string;
  backupId: string;
  displayName: string;
  sourcePath: string;
  filesDone: number;
  filesTotal: number;
  status: string;
  createdAtUnixMs: number;
}

/** 云服务配置段（aishell.json）：只存非敏感资料，token 在 keyring */
export interface CloudConfig {
  mode: CloudMode;
  user: CloudUser | null;
  capabilities: CloudCapabilities | null;
}

/** cloud_status 返回值 / cloud:changed 事件载荷（与 Rust cloud.rs CloudStatus 对齐；token 不在此） */
export interface CloudStatus {
  loggedIn: boolean;
  user: CloudUser | null;
  capabilities: CloudCapabilities | null;
  /** 构建期注入的服务器地址；null = 未接入云服务（一切云功能隐藏） */
  serverUrl: string | null;
  mode: CloudMode;
}

/* ---------- 用量报表（GET /api/usage，开放 API 文档 §4.1） ---------- */

/** 汇总指标（summary 段） */
export interface UsageSummary {
  requests: number;
  llmRequests: number;
  searchRequests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  averageLatencyMs: number;
  errorCount: number;
}

/** 单日统计（daily 段，按查询天数补齐连续日期） */
export interface UsageDaily {
  date: string;
  requests: number;
  llmRequests: number;
  searchRequests: number;
  promptTokens: number;
  completionTokens: number;
  errorCount: number;
}

/** 单模型统计（models 段，仅 LLM） */
export interface UsageModel {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** cloud_usage 返回值（与 Rust cloud.rs UsageReport serde camelCase 对齐） */
export interface UsageReport {
  from: string;
  to: string;
  timezone: string;
  summary: UsageSummary;
  daily: UsageDaily[];
  models: UsageModel[];
}

/* ---------- 记忆卡片（记忆卡片 API 文档 §1.2） ---------- */

/** 共享记忆卡片对象 */
export interface MemoryCard {
  id: string;
  content: string;
  category: string;
  tags: string[];
  creatorId: number | null;
  creatorName: string;
  dept: string;
  /** manual = 主动提交（原文保存）；auto = 对话流量 AI 自动沉淀 */
  source: 'manual' | 'auto' | string;
  /** shared（团队共享）/ personal（仅本人可见）；存量旧卡片可能为空，按共享处理 */
  scope: 'shared' | 'personal' | string | null;
  /** 自动沉淀卡片元数据（手动卡片通常无） */
  projectName: string | null;
  sessionId: string | null;
  date: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 卡片变更历史事件（§6）：event = ADD / UPDATE */
export interface MemoryEvent {
  event: string;
  value: string;
  ts: string;
  actor: string;
  note: string;
}

/** 记忆卡片作用域：shared（团队共享）/ personal（仅本人可见） */
export type MemoryScope = 'all' | 'shared' | 'personal';

/** 语义检索命中（§7.2）：卡片 + 相关度（数组按相关度降序） */
export interface MemoryHit {
  id: string;
  content: string;
  category: string;
  tags: string[];
  creatorId: number | null;
  creatorName: string;
  dept: string;
  source: string;
  scope: 'shared' | 'personal' | string | null;
  projectName: string | null;
  sessionId: string | null;
  date: string | null;
  createdAt: string;
  updatedAt: string;
  score: number;
}

/* ---------- 用户反馈（用户反馈 API 文档 §1.2/§3.2，与 cloud.rs serde camelCase 对齐） ---------- */

/** 反馈分类（创建必填白名单） */
export type FeedbackCategory = 'bug' | 'suggestion' | 'question' | 'other';
/** 反馈状态（用户只读，由管理员后台流转） */
export type FeedbackStatus = 'pending' | 'processing' | 'resolved' | 'closed';

/** 反馈附件元数据（§1.3）；downloadURL 为需鉴权的相对下载地址 */
export interface FeedbackAttachment {
  id: number;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
  downloadURL: string;
}

/** 反馈对象：创建响应 / 详情 / 列表条目同构 */
export interface Feedback {
  id: number;
  reporterId: number | null;
  reporterName: string | null;
  reporterDept: string | null;
  category: FeedbackCategory;
  title: string;
  content: string;
  status: FeedbackStatus;
  attachments: FeedbackAttachment[];
  attachmentCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 分页响应（§3.2）：total 为过滤条件下本人反馈总数 */
export interface FeedbackPage {
  items: Feedback[];
  page: number;
  pageSize: number;
  total: number;
}

/** MCP 服务全局配置（AppState 顶层字段）—— 与 store.rs McpServiceConfig serde camelCase 对齐。
 *  port 为回环监听端口（仅 127.0.0.1，不做局域网暴露）；旧配置无此字段按默认 8945。 */
export interface McpServiceConfig {
  port: number;
}

/** MCP 单项功能开关（每服务器独立；默认全关，不扩大权限）—— 与 store.rs McpFeatures serde camelCase 对齐。
 *  服务器 locked 时无论开关如何，所有 MCP 工具调用一律拒绝（与 AI 锁同语义）。 */
export interface McpFeatures {
  /** SFTP 目录查询（sftp_list 工具） */
  sftpList: boolean;
  /** SFTP 上传（sftp_upload 工具，本地源限于 MCP 传输目录） */
  sftpUpload: boolean;
  /** SFTP 下载（sftp_download 工具，落地限于 MCP 传输目录） */
  sftpDownload: boolean;
  /** SFTP 重命名/移动（sftp_rename 工具） */
  sftpRename: boolean;
  /** SFTP 删除（sftp_delete 工具，目录递归删除） */
  sftpDelete: boolean;
  /** 远程文件读取（read_file 工具，>5MB/二进制拒绝） */
  fileRead: boolean;
  /** 远程文件写入（write_file 工具，整体覆写，支持冲突检测） */
  fileWrite: boolean;
  /** 远程文件编辑（edit_file 工具，oldText→newText 精确替换） */
  fileEdit: boolean;
  /** 执行远程命令（exec_command 工具，不经 AI 审批） */
  exec: boolean;
  /** 数据库管道查询（db_query 工具，白名单与 AI 通道一致，仅暴露启用中的连接） */
  dbQuery: boolean;
}

/** MCP 设备配置（每服务器独立）—— 与 store.rs McpDeviceConfig serde camelCase 对齐。
 *  enabled = 加入 MCP 可发现设备列表；features 为单项功能开关。 */
export interface McpDeviceConfig {
  enabled: boolean;
  features: McpFeatures;
}

/** mcp_status 返回 —— 与 mcp.rs McpStatus serde camelCase 对齐。 */
export interface McpStatus {
  running: boolean;
  port: number;
  boundPort: number | null;
  error: string | null;
  deviceCount: number;
}

/** 与 store.rs Theme serde lowercase 对齐 */
export type Theme = 'dark' | 'light';

export type AuthType = 'password' | 'key';

/** 系统凭据库条目；密码永不通过前端状态返回，password 认证只展示已保存状态。 */
export interface Credential {
  id: string;
  name: string;
  authType: AuthType;
  username: string;
  keyPath: string;
}

export type CredentialMode = 'ask' | 'update' | 'fork';

export type ServerSaveResult =
  | { status: 'saved'; server: Server }
  | { status: 'needsChoice'; credentialName: string; referenceCount: number };

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  authType: AuthType;
  username: string;
  keyPath: string;
  /** 关联凭据库条目；null = 未关联（新建凭据/手工填写） */
  credentialId: string | null;
  /** AI 操作锁：仅约束 AI 发起的远程动作，不影响用户手动 SSH/SFTP */
  locked: boolean;
  /** 堡垒机开关：true = 本服务器作为跳板机，目标主机的 SSH/SFTP 连接经它转发；卡片打「堡垒机」标签 */
  isBastion: boolean;
  /** 所属堡垒机 id：非空 = 目标主机，连接时先连堡垒机再经其转发；卡片打「堡垒机:名称」标签 */
  bastionId: string | null;
}

export interface QuickCommand {
  id: string;
  title: string;
  command: string;
  /** 所属目录：'/' 分隔的相对路径（如 "常用/部署"），空串 = 未分类；旧数据无此字段按未分类 */
  folder: string;
  /** 全局可用：true 时所有项目的命令收藏面板与快捷指令面板可见可用；编辑/删除仍归属原项目 */
  global: boolean;
}

/** 与 store.rs AiMode serde lowercase 对齐 */
export type AiMode = 'suggest' | 'agent' | 'yolo';

export interface Project {
  id: string;
  name: string;
  path: string | null;
  serverIds: string[];
  quickCommands: QuickCommand[];
  /** 所属目录：'/' 分隔的相对路径（如 "生产环境/Web"），空串 = 未分类；旧数据无此字段按未分类 */
  folder: string;
  /** AI 助手模式；旧数据无此字段按 suggest */
  aiMode: AiMode;
}

/** AI 动作审计记录（随 assistant 消息持久化，历史只读展示） */
export interface AiActionRecord {
  toolCallId: string;
  tool: string;
  intent: string;
  summary: string;
  status: 'approved' | 'rejected' | 'succeeded' | 'failed';
  /** run_command 使用的整体超时秒数；旧记录无此字段 */
  timeoutSeconds?: number;
  /** 动作开始时已生成文本长度(content 内的时序锚点,渲染时把动作卡穿插到该位置);旧记录无此字段回退整组折叠 */
  textLen?: number;
}

export interface TermSnapshot {
  id: string;
  command: string;
  content: string;
  ts: number;
}

/** 编辑器选区引用：UI 以 @文件名_起始行_结束行号 标签呈现，发送时展开为内容 */
export interface FileRef {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  content: string;
  ts: number;
}

/** 服务器/本地终端引用：UI 以 @remote:服务器名称 / @local 标签呈现，发送时展开为说明文本 */
export interface ServerRef {
  /** 服务器 id；null = 本地终端 */
  serverId: string | null;
  /** 服务器名称（本地终端为「本地终端」） */
  name: string;
}

/** 文件/目录路径引用：UI 以 @file:文件名 / @path:目录名 标签呈现，发送时只带路径不带内容 */
export interface PathRef {
  /** 绝对路径（正斜杠规范化） */
  path: string;
  /** true = 目录（@path: 标签）；false = 文件（@file: 标签） */
  isDir: boolean;
  /** 远端服务器 ID（SFTP 面板添加的远程引用）；本地文件/目录引用为空 */
  serverId?: string | null;
}

/** 内置浏览器元素引用：UI 以 @browser:#id 或标签名 标签呈现，发送时展开为页面信息 + 元素 HTML */
export interface BrowserRef {
  /** 显示名：有 id 为 #id，否则小写标签名 */
  name: string;
  tagName: string;
  /** 元素 id（可空串） */
  elementId: string;
  /** 选中时的页面地址与标题 */
  url: string;
  title: string;
  /** 元素完整 outerHTML（注入脚本已截 20000 字符） */
  outerHTML: string;
  ts: number;
}

/** 技能引用：UI 以 @skill:名称 标签呈现，发送时展开为技能名称/来源/scope/描述（AI 可循此读取技能文件） */
export interface SkillRef {
  name: string;
  origin: 'global' | 'project';
  /** scope 标签（local/all/remote:xxx） */
  scope: string[];
  /** 一句话描述 */
  description: string;
}

/** 浏览器页面引用：UI 以 @page:页面标题 标签呈现，发送时展开页面标题与地址
 *  （页面正文由 AI 自行用 browser_read / browser_screenshot 读取） */
export interface BrowserPageRef {
  url: string;
  title: string;
  ts: number;
}

/** 图片附件：UI 以缩略图呈现，发送时经 ai_chat 的 images 参数（pi RPC images 字段）传给多模态模型 */
export interface ImageRef {
  id: string;
  /** local | remote | clipboard（附件来源） */
  source: 'local' | 'remote' | 'clipboard';
  name: string;
  mime: string;
  /** 后端物化副本绝对路径（ai_read_image 回读用，永不指向原图） */
  path: string;
  /** 来源原始路径（local/remote 附件保留，clipboard 无） */
  originPath?: string;
  /** remote 来源时的目标服务器 ID */
  serverId?: string | null;
  size: number;
  ts: number;
}

/** ai_attach_images 单项入参：source 标记来源（与 Rust AttachImageIn 的 serde tag 对齐） */
export type AttachImageItem =
  | { source: 'local'; path: string }
  | { source: 'remote'; serverId: string; path: string }
  | { source: 'clipboard'; name: string; data: string };

/** ai_attach_images 返回：落盘副本信息（前端补 id/source 等组成 ImageRef） */
export interface AttachedImage {
  name: string;
  mime: string;
  path: string;
  size: number;
}

/** ai_read_image 返回：data 为不带 dataURL 前缀的 base64 */
export interface ReadImageOut {
  mime: string;
  data: string;
}

/** browser:event 事件 payload（Rust browser.rs 发射）；viewId 标记来源页面（多页面模型） */
export interface BrowserEvent {
  kind: 'url' | 'title' | 'element' | 'ai-navigate' | 'new-window';
  /** 来源页面 id（Rust 侧 viewId） */
  viewId?: string;
  url?: string;
  title?: string;
  /** kind=element 时的元素引用字段（与 BrowserRef 对齐） */
  name?: string;
  tagName?: string;
  elementId?: string;
  outerHTML?: string;
  ts?: number;
}

/** browser_ensure 返回：面板重挂时恢复地址栏/标题/检查模式状态 */
export interface BrowserState {
  url: string;
  title: string;
  inspect: boolean;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  snapshots: TermSnapshot[];
  fileRefs: FileRef[];
  /** 服务器/本地终端引用（@remote:名称 / @local 标签）；旧会话为空 */
  serverRefs: ServerRef[];
  /** 文件/目录路径引用（@file:文件名 / @path:目录名 标签，发送时只带路径不带内容）；旧会话为空 */
  pathRefs: PathRef[];
  /** 内置浏览器元素引用（@browser:#id 或标签名 标签，发送时展开页面信息 + 元素 HTML）；旧会话为空 */
  browserRefs: BrowserRef[];
  /** 浏览器页面引用（@page:页面标题 标签，发送时展开页面地址与标题）；旧会话为空 */
  browserPageRefs?: BrowserPageRef[];
  /** 技能引用（@skill:名称 标签，发送时展开名/来源/scope/描述）；旧会话为空 */
  skillRefs: SkillRef[];
  /** 图片附件（缩略图展示，发送时经 pi RPC images 字段传图）；旧会话为空 */
  imageRefs?: ImageRef[];
  /** AI 动作审计（本轮回复中工具动作的意图/目标/最终状态，不含完整输出）；旧会话为空 */
  actions: AiActionRecord[];
  ts: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMsg[];
  /** 首条用户消息已触发自动标题；失败后也不重试，避免后续消息改写会话标题。 */
  autoTitleTriggered?: boolean;
  /** 会话已归档（归档后不出现在前端会话列表，数据仍保留）；旧配置无此字段按未归档 */
  archived?: boolean;
}

/** 归档对话框的目录/笔记选择器数据（notes_list 命令返回；相对路径 '/' 分隔、已排序） */
export interface NotesListing {
  dirs: string[];
  notes: string[];
}

/** session_archive 归档模式：new = 新建笔记 / update = 整合进既有笔记 / only = 仅归档不生成笔记 */
export type ArchiveMode = 'new' | 'update' | 'only';

/** dws 认证状态（dws_auth_status 返回；installed=false 表示本机未安装 dws CLI） */
export interface DwsAuthStatus {
  installed: boolean;
  authenticated: boolean;
  userName: string;
  corpName: string;
}

/** 钉钉日志模版（dws_report_templates 返回） */
export interface DwsTemplate {
  id: string;
  name: string;
}

/** 日志内容项（与 dws report entry submit --contents 数组元素对齐；发布预览可编辑 content） */
export interface DwsReportContent {
  key: string;
  sort: string;
  content: string;
  contentType: string;
  type: string;
}

/** dws_report_generate 返回：解析出的模版 id + LLM 整理的 contents JSON 字符串（pretty） */
export interface DwsReportDraft {
  templateId: string;
  contents: string;
}

/** dws_report_submit 返回：openUrl = 钉钉日志跳转链接（dws 缺失时为 null） */
export interface DwsSubmitResult {
  openUrl?: string | null;
}

/** sessions: projectId -> ChatSession[] */
export interface AppState {
  settings: Settings;
  servers: Server[];
  credentials: Credential[];
  projects: Project[];
  sessions: Record<string, ChatSession[]>;
  /** 项目分类目录清单（'/' 分隔相对路径，与 Project.folder 同语义；空目录也在此）；旧配置无此字段为空列表 */
  projectFolders: string[];
  /** 命令收藏分类目录清单（'/' 分隔相对路径，与 QuickCommand.folder 同语义；空目录也在此）；旧配置无此字段为空列表 */
  commandFolders: string[];
  /**
   * 各目录树展开状态：key = explorer:<projectId>（文件绝对路径数组）| welcome:projectGroups
   * （folder 值数组，空串 = 未分类）| commands:folders（同语义）；旧配置无此字段为空对象。
   */
  uiExpanded: Record<string, string[]>;
  /** SFTP 路径历史：serverId → MRU 路径列表（最新在前，最多 10 条）；旧配置无此字段为空对象 */
  sftpHistory: Record<string, string[]>;
  /** SFTP 收藏夹：serverId → 收藏条目（路径 + 标题，按添加顺序）；旧配置为纯路径数组，读取时自动迁移 */
  sftpFavorites: Record<string, SftpFavorite[]>;
  /** 服务器数据库连接（AI 受管查询通道）：serverId → 连接列表；旧配置无此字段为空对象 */
  dbConnections: Record<string, DbConnection[]>;
  /** MCP 服务全局配置（回环监听端口）；旧配置无此字段按默认 8945 */
  mcp: McpServiceConfig;
  /** MCP 设备配置：serverId → 配置（enabled = 加入 MCP 可发现设备列表 + 功能开关）；旧配置无此字段为空对象 */
  mcpDevices: Record<string, McpDeviceConfig>;
  /** 已完成内置技能播种的 workspace（规范化路径）；旧配置无此字段为空数组 */
  seededSkillWorkspaces: string[];
  /** AI 会话 trace 日志开关（命令面板 `trace on/off`）；旧配置无此字段按关闭 */
  traceEnabled: boolean;
}

/** AI 会话 trace 条目（trace.rs TraceEntry serde camelCase 对齐）：text 为后端已格式化的单行展示文本 */
export interface TraceEntry {
  ts: number;
  cat: string;
  text: string;
}

export interface FsEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** fs_stat 返回的单项属性快照 —— 与 fsops.rs FsStat serde camelCase 对齐。
 *  mode 为 unix 权限位（本地 Windows 为 null）；linkTarget 非符号链接为 null。 */
export interface FsStat {
  path: string;
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
  mode: number | null;
  readonly: boolean;
  linkTarget: string | null;
}

/** sftp_write 写回结果 —— 与 sftp.rs SftpWriteResult serde camelCase 对齐。
 *  conflict=true 表示远端已被外部修改、本次未写入（actual 为远端当前属性）；
 *  conflict=false 表示已写入（actual 为落盘后属性，前端据此重建下次保存的基线）。 */
export interface SftpWriteResult {
  conflict: boolean;
  actualSize: number | null;
  actualMtime: number | null;
}

/** 数据库类型（AI 受管查询通道）—— 与 store.rs DbKind serde lowercase 对齐 */
export type DbKind = 'mysql' | 'clickhouse' | 'redis' | 'postgres';

/** 服务器数据库连接配置（AI 受管查询通道）—— 与 store.rs DbConnection serde camelCase 对齐。
 *  密码不在 JSON 中（keyring account `db:<serverId>:<connId>`）。
 *  allowedCommands 为 AI 可用命令白名单（首词，大写）；空 = 该类型默认只读集。
 *  enabled 为启用开关：禁用后 AI 不可见也不可执行（list_servers 隐藏、db_query 拒绝）。 */
export interface DbConnection {
  id: string;
  name: string;
  kind: DbKind;
  host: string;
  port: number;
  user: string;
  database: string;
  allowedCommands: string[];
  enabled: boolean;
}

/** SFTP 收藏条目 —— 与 store.rs SftpFavorite serde camelCase 对齐。
 *  title 为收藏时用户编辑的显示标题（默认取目录名称），列表按标题展示以区分同名目录（如多台服务器的 etc/log）。 */
export interface SftpFavorite {
  path: string;
  title: string;
}

/** ssh_exec 直执结果 —— 与 ssh.rs SshExecResult serde camelCase 对齐。
 *  code 为 null 表示命令超时被中断或通道未返回退出码。 */
export interface SshExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Xshell 会话导入结果 —— 与 Rust import_xshell_sessions 返回值 serde camelCase 对齐 */
export interface XshellImportResult {
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  needsAttention: number;
  /** 本次导入新建的项目数（按会话目录自动建项目；同名项目复用不计） */
  projectsCreated: number;
}

/* ---------------- Skill（与 store.rs skills 模块 serde camelCase 对齐） ---------------- */

/** Skill 来源：global = <workspace_dir>/.aishell/skills；project = <项目目录>/.aishell/skills
 *  —— 与 store.rs SkillOrigin serde lowercase 对齐 */
export type SkillOrigin = 'global' | 'project';

/** Skill 摘要 —— 与 store.rs SkillSummary serde camelCase 对齐。
 *  id 固定为 global:<name> 或 project:<projectId>:<name>；path 为 SKILL.md 规范化绝对路径。
 *  scope 缺失/空数组时后端已规范化为 ["all"]；enabled 缺失按 true。 */
export interface SkillSummary {
  id: string;
  name: string;
  description: string;
  scope: string[];
  enabled: boolean;
  origin: SkillOrigin;
  path: string;
}

/** 完整 Skill 文档：content 为完整 SKILL.md 原文（编辑时原样回传，后端只重写顶层 scope） */
export interface SkillDocument {
  summary: SkillSummary;
  content: string;
}

/** SkillHub 本地发布终态：published 时临时 ZIP 已删除；manual 时保留路径供当前浏览器页面手动选择。 */
export interface SkillHubPublishOutcome {
  status: 'published' | 'manual';
  packagePath: string;
  message: string;
}

/* ---------------- SkillHub（与 cloud.rs SkillHub API serde camelCase 对齐） ---------------- */
export interface SkillHubVersion {
  id: number;
  version: string;
  status: string;
  changelog: string;
  fileCount: number;
  totalSize: number;
  publishedAt: string;
  downloadAvailable: boolean;
  metadata: Record<string, unknown>;
  body: string;
}

export interface SkillHubItem {
  id: number;
  namespace: string;
  slug: string;
  displayName: string;
  summary: string;
  tags: Record<string, string>;
  labels: string[];
  downloads: number;
  stars: number;
  downloadCount: number;
  starCount: number;
  ratingAvg: number;
  ratingCount: number;
  createdAt: number;
  updatedAt: number;
  latestVersion: string;
  changelog: string;
  license: string;
  ownerId: string;
  ownerDisplayName: string;
  visibility: string;
  status: string;
  hidden: boolean;
  headlineVersion?: SkillHubVersion | null;
  publishedVersion?: SkillHubVersion | null;
  ownerPreviewVersion?: SkillHubVersion | null;
  resolutionMode: string;
}

export interface SkillHubList {
  items: SkillHubItem[];
  nextCursor: string;
}

export interface SkillHubDetail {
  skill: SkillHubItem;
}

export interface SkillHubVersionDetail {
  version: SkillHubVersion;
}

/* ---------------- 会话级远程文件暂存（与 staging.rs serde camelCase 对齐） ---------------- */

/** 原始/当前存在状态 —— 与 staging.rs StagedState serde lowercase 对齐 */
export type StagedState = 'existing' | 'absent';

/** 暂存条目 —— 与 staging.rs StagedFile serde camelCase 对齐 */
export interface StagedFile {
  entryId: string;
  serverId: string;
  remotePath: string;
  /** 首次快照时远程状态 */
  originalState: StagedState;
  /** 快照 blob 的 sha256（原始状态为 absent 时为 null） */
  blobRef: string | null;
  size: number | null;
  mtime: number | null;
  sha256: string | null;
  stagedAt: number;
  /** 最近一次刷新时的远程状态 */
  currentState: StagedState;
  currentSize: number | null;
  currentMtime: number | null;
  currentSha256: string | null;
}

/** 文件元数据（二进制/超大文件的展示与冲突校验用） */
export interface StagingMeta {
  sha256: string | null;
  size: number | null;
  mtime: number | null;
}

/** 单侧内容读取结果：text 为可编辑文本（已脱敏）；meta 为二进制/超大元数据；absent 表示该侧不存在 */
export interface StagingContent {
  text: string | null;
  meta: StagingMeta | null;
  absent: boolean;
}

/** diff 单侧行（kind：del/add/ctx） */
export interface DiffLine {
  kind: 'del' | 'add' | 'ctx';
  text: string;
}

/** diff 元数据对比（二进制/超大时） */
export interface DiffMeta {
  snapshot: StagingMeta;
  current: StagingMeta;
}

/** staging_diff 结果：行级 diff（文本）或元数据对比（二进制/超大） */
export interface StagingDiff {
  left: DiffLine[];
  right: DiffLine[];
  meta: DiffMeta | null;
  snapshotAbsent: boolean;
  currentAbsent: boolean;
}

/** restore 冲突详情（结构化返回，前端据此弹「仍要强制还原？」） */
export interface RestoreConflict {
  currentSize: number | null;
  currentMtime: number | null;
  currentSha256: string | null;
}

/** restore 结果：restored=true 时 entry 为更新后的条目；conflict 非空表示冲突且未还原 */
export interface RestoreOutcome {
  restored: boolean;
  conflict: RestoreConflict | null;
  entry: StagedFile | null;
}

/** staging_clear 结果：removed 为「无变更已清除」的条目；kept 为仍有变更/检查失败而保留的条目 */
export interface StagingClearOutcome {
  removed: StagedFile[];
  kept: StagedFile[];
  /** 检查失败的条目说明（对应条目保留在 kept 中） */
  errors: string[];
}

/** staging_export 结果 —— 与 staging.rs StagingExportOutcome serde camelCase 对齐 */
export interface StagingExportOutcome {
  /** 成功导出的条目数 */
  exported: number;
  /** 导出后已接受清除的条目数（accept=true 时） */
  accepted: number;
  /** 失败说明（对应条目保留在暂存区） */
  errors: string[];
  /** 导出目标（本地绝对路径或远端路径；远程批量按服务器分组可能多个） */
  targets: string[];
}

/** 递归暂存目录 / 清理 / 导出的进度（staging:progress 事件；与 staging.rs StagingProgress serde camelCase 对齐） */
export interface StagingProgress {
  projectId: string;
  sessionId: string;
  /** walk = 枚举目录文件；stage = 逐个暂存文件；clear = 逐条检查暂存条目；export = 逐条导出备份；done = 操作完成（隐藏进度） */
  phase: 'walk' | 'stage' | 'clear' | 'export' | 'done';
  done: number;
  total: number;
  currentPath: string;
}

/* ---------------- 客户端自动更新（Rust update.rs，serde camelCase 对齐） ---------------- */

/** 更新状态机（与 update.rs UpdateState serde snake_case 对齐） */
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'not_available'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error';

/** 下载进度（update:download-progress 事件载荷） */
export interface UpdateProgress {
  downloaded: number;
  total?: number | null;
}

/** update_status 返回值与 update:status-changed 事件载荷 */
export interface UpdateStatus {
  state: UpdateState;
  currentVersion: string;
  availableVersion?: string | null;
  notes?: string | null;
  publishedAt?: string | null;
  progress?: UpdateProgress | null;
  /** 最近检查时间（epoch 毫秒，前端按本地时区格式化） */
  lastCheckedAt?: number | null;
  error?: string | null;
  /** 构建是否接入更新服务（未注入 AISHELL_SERVER_URL 的个人构建恒 false） */
  enabled: boolean;
  /** 无签名迁移期：manifest 有新版本但缺签名 → 只允许手动下载 */
  signatureMissing: boolean;
  /** 制品直链（公开 URL，无 token；「打开下载页」用） */
  downloadUrl?: string | null;
}

/** update:ready 事件载荷（下载验签完成，提示用户重启生效） */
export interface UpdateReadyInfo {
  version: string;
  notes?: string | null;
  publishedAt?: string | null;
}

/** SFTP 传输进度（sftp:progress 事件；与 sftp.rs SftpProgress serde camelCase 对齐）。
 *  阶段：bytes = 当前文件字节进度；files = 一个文件完成；done = 整个命令结束（隐藏进度） */
export interface SftpProgress {
  taskId: string;
  serverId: string;
  direction: 'upload' | 'download';
  phase: 'bytes' | 'files' | 'done';
  /** 当前文件路径（bytes 阶段为传输中的文件） */
  current: string;
  doneBytes: number;
  totalBytes: number;
  filesDone: number;
  filesTotal: number;
}
