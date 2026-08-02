/**
 * 共享数据模型 —— 与 Rust store.rs 的 serde camelCase 严格对齐，字段名以 .proto/shared/mock.js 为准。
 * 修改任何字段名都必须同步 Rust 侧。
 */
export interface LlmConfig {
  modelId: string;
  baseUrl: string;
  effort: 'low' | 'medium' | 'high';
}

export interface Settings {
  workspaceDir: string | null;
  llm: LlmConfig;
}

export type AuthType = 'password' | 'key';

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  authType: AuthType;
  username: string;
  keyPath: string;
}

export interface QuickCommand {
  id: string;
  title: string;
  command: string;
}

export interface Project {
  id: string;
  name: string;
  path: string | null;
  serverIds: string[];
  quickCommands: QuickCommand[];
}

export interface TermSnapshot {
  id: string;
  command: string;
  content: string;
  ts: number;
}

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  snapshots: TermSnapshot[];
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
}

export interface FsEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}
