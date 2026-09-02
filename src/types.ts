/**
 * 共享数据模型 —— 与 Rust store.rs 的 serde camelCase 严格对齐，字段名以 .proto/shared/mock.js 为准。
 * 修改任何字段名都必须同步 Rust 侧。
 */
/** Python SDK 导入成功后的配置变更事件，与 Rust ai_actions.rs ConfigChanged 对齐。 */
export interface ConfigChanged {
  kind: 'project' | 'commands' | 'skill' | 'note';
  projectId: string | null;
}

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
  /** 服务器紧凑布局：开启后工作台侧栏服务器卡片默认折叠（仅图标/名称/IP），点击展开；旧配置无此字段按关闭 */
  compactServerList: boolean;
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

/** 与 store.rs AuthType serde lowercase 对齐；publickey = SSH 公钥(密钥对)，keyPath 存密钥对目录 */
export type AuthType = 'password' | 'key' | 'publickey';

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
  /** 用户自定义标签（搜索框 #tag 筛选用）；旧配置无此字段按空数组 */
  tags: string[];
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

/** 笔记引用：UI 以 @note:笔记名称 标签呈现，发送时展开为笔记路径（AI 可循此读取笔记内容）。
 *  笔记为工作区全局 <workspace>/.aishell/notes 下的 markdown 文件；path 为绝对路径。 */
export interface NoteRef {
  /** 输入 chip / 历史消息引用的唯一 id */
  id: string;
  /** 笔记绝对路径 */
  path: string;
  /** 笔记显示名（label，不含 .md 扩展名） */
  name: string;
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
  /** kind=favicon 时 url 为站点图标地址（页面注入脚本探测 link[rel~=icon] 的结果） */
  kind: 'url' | 'title' | 'element' | 'favicon' | 'ai-navigate' | 'new-window';
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
  /** 站点图标地址（可能为空串/缺失；重开标签时直接复用，无需等重新探测） */
  favicon?: string;
}

/** 内置浏览器地址栏历史条目（MRU 最新在前；持久化在 aishell.json browserHistory，
 *  Rust store.rs record_browser_history 维护合并/截尾，browser_history_list 查询） */
export interface BrowserHistoryItem {
  /** 对外展示形态 URL（本地文件即 file:///），可直接作为导航输入 */
  url: string;
  /** 页面标题（导航时往往尚未加载完成，可能为空串） */
  title: string;
  /** 最近一次访问的毫秒时间戳 */
  ts: number;
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
  /** 笔记引用（@note:名称 标签，发送时展开为笔记路径）；旧会话为空 */
  noteRefs: NoteRef[];
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
  /** SSH 隧道配置；旧配置无此字段为空数组 */
  sshTunnels: TunnelConfig[];
  /** 内置浏览器 SOCKS5 代理配置（只作用于内置浏览器子 webview）；旧配置无此字段按未启用 */
  browserProxy: BrowserProxyConfig;
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

/** 密钥对探测结果 —— 与 ssh_keys.rs KeyPairInfo serde camelCase 对齐 */
export interface KeyPairInfo {
  name: string;
  privatePath: string;
  publicPath: string;
}

/** SSH 隧道配置 —— 与 tunnel.rs TunnelConfig serde camelCase 对齐（keyPath 之外 list 形态） */
export interface TunnelConfig {
  id: string;
  serverId: string;
  name: string;
  /** 隧道类型：local = 本地端口固定转发(-L)，dynamic = SOCKS5 动态代理(-D)。缺省 local */
  kind: 'local' | 'dynamic';
  /** 本地监听地址；默认 127.0.0.1 */
  bindAddr: string;
  localPort: number;
  /** 目标主机（远端服务器视角）；留空 = 服务器自身。dynamic 模式下无意义(保存时归零) */
  targetHost: string;
  targetPort: number;
  /** 上次启用状态：重启时自动重建 */
  enabled: boolean;
}

/** 隧道展示态 —— 与 tunnel.rs TunnelState 对齐（配置字段扁平展开 + 运行态） */
export interface TunnelState extends TunnelConfig {
  running: boolean;
  error: string | null;
}

/** 内置浏览器 SOCKS5 代理配置 —— 与 store.rs BrowserProxyConfig serde camelCase 对齐。
 *  只作用于内置浏览器子 webview(创建时注入 --proxy-server);隧道源时隧道停止会回落直连。 */
export interface BrowserProxyConfig {
  enabled: boolean;
  source: 'tunnel' | 'manual';
  tunnelId: string | null;
  host: string;
  port: number;
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
