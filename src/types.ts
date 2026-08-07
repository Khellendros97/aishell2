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
  /** 自动切换 AI 工作区域：开启后 AI 输入框显示固定工作区域标签，随激活终端自动切换；旧配置无此字段按关闭 */
  autoSwitchAiWorkdir: boolean;
  /** 欢迎页项目视图；旧配置无此字段按卡片视图 */
  projectView: 'card' | 'list';
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
  /** SFTP 收藏夹：serverId → 收藏路径列表（按添加顺序）；旧配置无此字段为空对象 */
  sftpFavorites: Record<string, string[]>;
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
