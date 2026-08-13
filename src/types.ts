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
  /** 自动备份远程文件：开启后 AI 会话第一次修改某远程文件前保存原始快照（会话级暂存区）；旧配置无此字段按开启 */
  autoBackupRemoteFiles: boolean;
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
