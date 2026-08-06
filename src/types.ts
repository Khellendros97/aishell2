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
  /** 所属目录：'/' 分隔的相对路径（如 "生产环境/Web"），空串 = 未分类；Xshell 导入按会话分组填充 */
  folder: string;
  /** AI 操作锁：仅约束 AI 发起的远程动作，不影响用户手动 SSH/SFTP */
  locked: boolean;
}

export interface QuickCommand {
  id: string;
  title: string;
  command: string;
}

/** 与 store.rs AiMode serde lowercase 对齐 */
export type AiMode = 'suggest' | 'agent' | 'yolo';

export interface Project {
  id: string;
  name: string;
  path: string | null;
  serverIds: string[];
  quickCommands: QuickCommand[];
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

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  snapshots: TermSnapshot[];
  fileRefs: FileRef[];
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
  /** 服务器分类目录清单（'/' 分隔相对路径，与 Server.folder 同语义；空目录也在此）；旧配置无此字段为空列表 */
  serverFolders: string[];
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

/** Xshell 会话导入结果 —— 与 Rust import_xshell_sessions 返回值 serde camelCase 对齐 */
export interface XshellImportResult {
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
  needsAttention: number;
}
