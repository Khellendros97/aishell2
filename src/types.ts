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

export interface Settings {
  workspaceDir: string | null;
  llm: LlmConfig;
  /** 联网搜索配置；旧配置无此字段时按关闭处理 */
  search: SearchConfig;
  theme: Theme;
  /** 自动切换 AI 工作区域：开启后 AI 输入框显示固定工作区域标签，随激活终端自动切换；旧配置无此字段按开启 */
  autoSwitchAiWorkdir: boolean;
  /** 欢迎页项目视图；旧配置无此字段按卡片视图 */
  projectView: 'card' | 'list';
  /** 审批模式（智能审批/全部审批）；旧配置无此字段按智能审批 */
  approvalMode: 'smart' | 'all';
  /** 云服务接入（公司服务器托管）；旧配置无此字段按未接入处理 */
  cloud: CloudConfig;
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
  latestVersion: string | null;
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

/** 与 store.rs Theme serde lowercase 对齐 */
export type Theme = 'dark' | 'light';

export type AuthType = 'password' | 'key';

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  authType: AuthType;
  username: string;
  keyPath: string;
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
  /** AI 动作审计（本轮回复中工具动作的意图/目标/最终状态，不含完整输出）；旧会话为空 */
  actions: AiActionRecord[];
  ts: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMsg[];
}

/** sessions: projectId -> ChatSession[] */
export interface AppState {
  settings: Settings;
  servers: Server[];
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
  /** 已完成内置技能播种的 workspace（规范化路径）；旧配置无此字段为空数组 */
  seededSkillWorkspaces: string[];
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
