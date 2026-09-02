//! 数据层：AppState 持久化 + 密钥保管（keyring）。
//!
//! 契约：
//! - 数据模型与 src/types.ts 逐字段对齐（serde camelCase），字段名以 .proto/shared/mock.js 为准；
//! - 命令清单见 src/api.ts 的 store 段（命令名/参数名逐一对应，Tauri snake_case→camelCase 自动映射）；
//! - 持久化 <config_dir>/aishell.json，先写 .tmp 再 rename 原子替换；
//! - 密钥走 keyring（service "AIShell"，account: `credential:<id>` / `llm:apikey`），永不进 JSON、永不返回前端。
//!
//! 命令注册由主 agent 在集成阶段统一做（lib.rs 的 generate_handler），本模块只暴露命令函数与类型。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::ssh_keys;
use crate::tunnel::TunnelConfig;

// ---------------------------------------------------------------- 数据模型

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Effort {
    #[default]
    Low,
    High,
    Max,
}

/// 手动反序列化：v4 系列思考档位为 low/high/max；旧配置的 medium 档按 low 处理（无感升级）。
impl<'de> Deserialize<'de> for Effort {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        match s.as_str() {
            "low" => Ok(Effort::Low),
            "high" => Ok(Effort::High),
            "max" => Ok(Effort::Max),
            "medium" => Ok(Effort::Low),
            _ => Err(serde::de::Error::unknown_variant(
                &s,
                &["low", "high", "max"],
            )),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub model_id: String,
    pub base_url: String,
    pub effort: Effort,
}

/// 上一代默认模型；配置里仍为此值时加载迁移为当前默认（用户自定义模型名不动）。
pub const LEGACY_DEFAULT_MODEL_ID: &str = "deepseek-v4-flash";

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            model_id: "deepseek-v4-flash-vision-exp".to_string(),
            base_url: "https://api.deepseek.com/v1".to_string(),
            effort: Effort::Low,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Dark,
    Light,
}

/// 欢迎页项目视图；旧配置无此字段按卡片视图。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ProjectView {
    #[default]
    Card,
    List,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SearchConfig {
    /// 是否向 AI 助手挂载 web_search 工具；key 未配置时仍挂载，调用时返回中文引导错误。
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub workspace_dir: Option<String>,
    pub llm: LlmConfig,
    /// 联网搜索配置；旧配置无此字段时按关闭处理
    #[serde(default)]
    pub search: SearchConfig,
    /// 界面主题；旧配置无此字段时按深色处理
    #[serde(default)]
    pub theme: Theme,
    /// 自动切换 AI 工作区域：开启后前端 AI 输入框显示固定工作区域标签，随激活终端自动切换；
    /// 旧配置无此字段时按开启处理（默认开启）
    #[serde(default = "default_true")]
    pub auto_switch_ai_workdir: bool,
    /// 欢迎页项目视图（card/list）；旧配置无此字段按卡片视图。
    #[serde(default)]
    pub project_view: ProjectView,
    /// 审批模式（智能审批/全部审批）；旧配置无此字段按智能审批
    #[serde(default)]
    pub approval_mode: ApprovalMode,
    /// 自动备份远程文件：开启后 AI 会话第一次修改某远程文件前保存原始快照（会话级暂存区）；
    /// 旧配置无此字段时按开启处理（默认开启）
    #[serde(default = "default_true")]
    pub auto_backup_remote_files: bool,
    /// 服务器紧凑布局：开启后工作台侧栏服务器卡片默认折叠（仅图标/名称/IP），点击展开操作按钮；
    /// 旧配置无此字段时按关闭处理（默认关闭，保持完整卡片）
    #[serde(default)]
    pub compact_server_list: bool,
}

/// 全新安装（无 aishell.json）默认值：自动备份远程文件与自动切换工作区域按开启。
impl Default for Settings {
    fn default() -> Self {
        Settings {
            workspace_dir: None,
            llm: LlmConfig::default(),
            search: SearchConfig::default(),
            theme: Theme::default(),
            auto_switch_ai_workdir: true,
            project_view: ProjectView::default(),
            approval_mode: ApprovalMode::default(),
            auto_backup_remote_files: true,
            compact_server_list: false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Password,
    Key,
    /// SSH 公钥(密钥对):key_path 存密钥对目录(如 `~/.ssh`),认证用目录内标准命名的私钥,
    /// 服务器未部署公钥时由用户提供一次密码自动部署。私钥不进 keyring、不收编。
    PublicKey,
}

/// AI 助手执行模式（按项目持久化）：
/// - Suggest：只给建议（现状），写仅限 .aishell/，无删除/命令/SFTP 工具；
/// - Agent：每次受控工具调用单独审批；
/// - Yolo：跳过审批自动执行（仍受项目根与服务器 AI 锁约束）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AiMode {
    #[default]
    Suggest,
    Agent,
    Yolo,
}

/// 审批模式（全局设置）：
/// - Smart：智能审批——受控工具调用先由 LLM 判定是否危险，非危险直接放行，
///   危险或判定失败（网络/解析错误）回退人工审批（危险方向保守）；
/// - All：全部审批——每次受控工具调用都弹人工确认（原行为）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ApprovalMode {
    #[default]
    Smart,
    All,
}

impl ApprovalMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalMode::Smart => "smart",
            ApprovalMode::All => "all",
        }
    }
}

/// serde 默认值：旧配置无 autoSwitchAiWorkdir 字段时按开启处理（默认开启）。
fn default_true() -> bool {
    true
}

impl AiMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AiMode::Suggest => "suggest",
            AiMode::Agent => "agent",
            AiMode::Yolo => "yolo",
        }
    }
}

/// 可复用的服务器认证凭据。**没有密码字段**——密码只存 keyring（account `credential:<id>`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    pub id: String,
    pub name: String,
    pub auth_type: AuthType,
    pub username: String,
    pub key_path: String,
}

/// 凭据保存模式：ask 在共享凭据可能被改写时返回 needsChoice，update 修改共享凭据，
/// fork 为当前服务器创建独立凭据。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum CredentialSaveMode {
    #[default]
    Ask,
    Update,
    Fork,
}

/// 保存服务器命令的结构化结果，与前端 `ServerSaveResult` 判别联合逐字段对齐。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum ServerSaveResult {
    Saved { server: Server },
    NeedsChoice {
        #[serde(rename = "credentialName")]
        credential_name: String,
        #[serde(rename = "referenceCount")]
        reference_count: usize,
    },
}

/// 服务器连接配置。认证镜像字段保留在服务器上以兼容现有前端；实际 SSH 凭据由 credential_id 指向。
/// 服务器永不携带密码，密码只存 keyring（account `credential:<id>`）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub auth_type: AuthType,
    pub username: String,
    pub key_path: String,
    /// 服务器使用的可复用凭据；旧配置无此字段时由加载迁移补齐。
    #[serde(default)]
    pub credential_id: Option<String>,
    /// AI 操作锁：仅约束 AI 发起的远程动作，不影响用户手动 SSH/SFTP；旧配置无此字段按未锁定。
    #[serde(default)]
    pub locked: bool,
    /// 堡垒机开关：true = 本服务器作为跳板机，目标主机的 SSH/SFTP 连接经它转发；
    /// 卡片上据此打「堡垒机」标签。旧配置无此字段按普通服务器。
    #[serde(default)]
    pub is_bastion: bool,
    /// 所属堡垒机 id：Some = 本服务器是目标主机，连接时先连堡垒机再经其转发；
    /// None = 普通服务器或堡垒机自身。旧配置无此字段按未绑定。
    #[serde(default)]
    pub bastion_id: Option<String>,
    /// 用户自定义标签（搜索框 #tag 筛选用）；旧配置无此字段按空标签处理。
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 数据库类型（AI 受管查询通道）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    #[default]
    Mysql,
    Clickhouse,
    Redis,
    Postgres,
}

impl DbKind {
    pub fn as_str(self) -> &'static str {
        match self {
            DbKind::Mysql => "mysql",
            DbKind::Clickhouse => "clickhouse",
            DbKind::Redis => "redis",
            DbKind::Postgres => "postgres",
        }
    }

    /// 该类型默认只读命令集（allowed_commands 为空时生效；用户可在连接配置里增删）。
    pub fn default_read_commands(self) -> &'static [&'static str] {
        match self {
            DbKind::Mysql | DbKind::Clickhouse | DbKind::Postgres => {
                &["SELECT", "SHOW", "DESC", "DESCRIBE", "EXPLAIN"]
            }
            DbKind::Redis => &[
                "GET",
                "MGET",
                "KEYS",
                "SCAN",
                "TYPE",
                "TTL",
                "PTTL",
                "EXISTS",
                "DBSIZE",
                "INFO",
                "PING",
                "STRLEN",
                "LLEN",
                "SCARD",
                "ZCARD",
                "HLEN",
                "HGET",
                "HGETALL",
                "HKEYS",
                "HVALS",
                "SMEMBERS",
                "LRANGE",
                "ZRANGE",
                "SISMEMBER",
                "HEXISTS",
                "SRANDMEMBER",
                "RANDOMKEY",
                "ZSCORE",
                "HSTRLEN",
                "GETRANGE",
            ],
        }
    }
}

/// SFTP 收藏条目：path 为完整远端路径，title 为收藏时用户编辑的显示标题（默认取目录名）。
/// 列表按 title 展示以区分同名目录（如多台服务器的 etc/log）；点击跳转仍按 path。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpFavorite {
    pub path: String,
    #[serde(default)]
    pub title: String,
}

/// 内置浏览器地址栏历史上限（MRU 截尾；下拉显示条数由前端按需查询，与存储上限解耦）。
pub const BROWSER_HISTORY_CAP: usize = 200;

/// 内置浏览器地址栏历史条目（MRU，最新在前）。URL 为对外展示形态（本地文件即 file:///，
/// 与地址栏/事件一致）；重新导航时后端 normalize_input 会再归一化。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserHistoryEntry {
    pub url: String,
    /// 页面标题（导航事件时往往尚未加载完成，为空串；标题事件到达后补填）
    #[serde(default)]
    pub title: String,
    /// 最近一次访问的毫秒时间戳
    pub ts: u64,
}

/// 历史过滤（纯函数）：query 小写化后按子串匹配 URL 与标题（空 query = 不过滤），
/// 保持原 MRU 序，取前 limit 条。
fn filter_browser_history(
    entries: &[BrowserHistoryEntry],
    query: &str,
    limit: usize,
) -> Vec<BrowserHistoryEntry> {
    let q = query.trim().to_lowercase();
    entries
        .iter()
        .filter(|e| {
            q.is_empty() || e.url.to_lowercase().contains(&q) || e.title.to_lowercase().contains(&q)
        })
        .take(limit)
        .cloned()
        .collect()
}

/// 收藏夹兼容反序列化：旧配置 `serverId -> string[]`（纯路径）→ 新结构 `{path, title}[]`，
/// 旧条目的 title 取路径目录名（rsplit('/') 首个片段，根目录取空串由前端兜底显示）。
fn de_sftp_favorites<'de, D>(d: D) -> Result<HashMap<String, Vec<SftpFavorite>>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Entry {
        Legacy(String),
        New(SftpFavorite),
    }
    let raw = HashMap::<String, Vec<Entry>>::deserialize(d)?;
    Ok(raw
        .into_iter()
        .map(|(k, v)| {
            let v = v
                .into_iter()
                .map(|e| match e {
                    Entry::Legacy(p) => {
                        let title = p.rsplit('/').next().unwrap_or("").to_string();
                        SftpFavorite { path: p, title }
                    }
                    Entry::New(f) => f,
                })
                .collect();
            (k, v)
        })
        .collect())
}

/// 服务器数据库连接配置（AI 受管查询通道）。
/// **不含密码字段**——密码只存 keyring（account `db:<serverId>:<connId>`）。
/// allowed_commands 为 AI 可用命令白名单（首词，大写，如 SELECT / GET / HGETALL）；
/// 空列表 = 使用该类型默认只读集；含写命令（如 UPDATE）时 AI 执行需人工审批。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbConnection {
    pub id: String,
    pub name: String,
    pub kind: DbKind,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 默认库（mysql/clickhouse 用；redis 忽略）
    #[serde(default)]
    pub database: String,
    #[serde(default)]
    pub allowed_commands: Vec<String>,
    /// 启用状态：禁用后 AI 不可见也不可执行（list_servers 隐藏、db_query 拒绝）；旧配置无此字段按启用处理。
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl DbConnection {
    /// 生效的命令白名单：未配置时回落到该类型默认只读集。
    pub fn effective_commands(&self) -> Vec<String> {
        if self.allowed_commands.is_empty() {
            self.kind
                .default_read_commands()
                .iter()
                .map(|s| s.to_string())
                .collect()
        } else {
            self.allowed_commands.clone()
        }
    }
}

/// MCP 服务全局配置（AppState 顶层字段，旧配置无此字段按默认端口）。
/// 端口只在本机回环监听（127.0.0.1），不做局域网暴露。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServiceConfig {
    pub port: u16,
}

impl Default for McpServiceConfig {
    fn default() -> Self {
        Self { port: 8945 }
    }
}

/// MCP 单项功能开关（每服务器独立；**默认全关**，不扩大权限）。
/// 服务器 locked 时无论开关如何，所有 MCP 工具调用一律拒绝（与 AI 锁同语义）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpFeatures {
    /// SFTP：目录查询（sftp_list 工具）
    #[serde(default)]
    pub sftp_list: bool,
    /// SFTP：上传（sftp_upload 工具，本地源限于 MCP 传输目录）
    #[serde(default)]
    pub sftp_upload: bool,
    /// SFTP：下载（sftp_download 工具，落地限于 MCP 传输目录）
    #[serde(default)]
    pub sftp_download: bool,
    /// SFTP：重命名/移动（sftp_rename 工具）
    #[serde(default)]
    pub sftp_rename: bool,
    /// SFTP：删除（sftp_delete 工具，目录递归删除）
    #[serde(default)]
    pub sftp_delete: bool,
    /// 远程文件读取（read_file 工具，>5MB/二进制拒绝）
    #[serde(default)]
    pub file_read: bool,
    /// 远程文件写入（write_file 工具，整体覆写，支持冲突检测）
    #[serde(default)]
    pub file_write: bool,
    /// 远程文件编辑（edit_file 工具，oldText→newText 精确替换）
    #[serde(default)]
    pub file_edit: bool,
    /// 执行远程命令（exec_command 工具，不经 AI 审批）
    #[serde(default)]
    pub exec: bool,
    /// 数据库管道查询（db_query 工具，白名单与 AI 通道一致，仅暴露启用中的连接）
    #[serde(default)]
    pub db_query: bool,
}

impl McpFeatures {
    /// 已启用功能的中文清单（list_devices / 设置页展示用）。
    pub fn enabled_labels(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if self.sftp_list {
            out.push("SFTP 目录查询");
        }
        if self.sftp_upload {
            out.push("SFTP 上传");
        }
        if self.sftp_download {
            out.push("SFTP 下载");
        }
        if self.sftp_rename {
            out.push("SFTP 重命名");
        }
        if self.sftp_delete {
            out.push("SFTP 删除");
        }
        if self.file_read {
            out.push("文件读取");
        }
        if self.file_write {
            out.push("文件写入");
        }
        if self.file_edit {
            out.push("文件编辑");
        }
        if self.exec {
            out.push("执行命令");
        }
        if self.db_query {
            out.push("数据库查询");
        }
        out
    }

    /// 单项功能是否放行某个 MCP 工具（mcp.rs 调用裁决用）。
    pub fn tool_enabled(&self, tool: &str) -> bool {
        match tool {
            "sftp_list" => self.sftp_list,
            "sftp_upload" => self.sftp_upload,
            "sftp_download" => self.sftp_download,
            "sftp_rename" => self.sftp_rename,
            "sftp_delete" => self.sftp_delete,
            "read_file" => self.file_read,
            "write_file" => self.file_write,
            "edit_file" => self.file_edit,
            "exec_command" => self.exec,
            "db_query" => self.db_query,
            _ => false,
        }
    }
}

/// MCP 设备配置（每服务器独立）：enabled = 加入 MCP 可发现设备列表。
/// 服务器被删除时该条目级联清理（delete_server / clear_unreferenced_servers）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpDeviceConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub features: McpFeatures,
}

/// Xshell 一键导入结果（camelCase 与前端 src/types.ts 的 XshellImportResult 对齐）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct XshellImportResult {
    /// 本次新增的会话数
    pub imported: usize,
    /// 本次覆盖更新的会话数
    pub updated: usize,
    /// 已存在且配置完全一致的会话数
    pub unchanged: usize,
    /// 非 SSH / 字段无效 / 无法解析而被跳过的 .xsh 数
    pub skipped: usize,
    /// 本次发现、需要用户后续处理的会话数（密码认证、用户名空、密钥缺失、NSSSH 私钥等）
    pub needs_attention: usize,
    /// 本次导入新建的项目数（按会话目录自动建项目；同名项目复用不计）
    pub projects_created: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    pub id: String,
    pub title: String,
    pub command: String,
    /// 所属目录：'/' 分隔的相对路径（如 "常用/部署"），空串 = 未分类。
    /// 旧配置无此字段按未分类处理。
    #[serde(default)]
    pub folder: String,
    /// 全局可用：true 时该命令在所有项目的命令收藏面板与快捷指令面板可见可用；
    /// 编辑/删除仍归属原项目；旧配置无此字段按仅本项目可见。
    #[serde(default)]
    pub global: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub server_ids: Vec<String>,
    pub quick_commands: Vec<QuickCommand>,
    /// 所属目录：'/' 分隔的相对路径（如 "生产环境/Web"），空串 = 未分类。
    /// 旧配置无此字段按未分类处理；Xshell 导入时按会话目录自动建项目，新建项目 folder 为空。
    #[serde(default)]
    pub folder: String,
    /// AI 助手模式（suggest/agent/yolo）；旧配置无此字段按 suggest（不扩大权限）。
    #[serde(default)]
    pub ai_mode: AiMode,
}

/// AI 动作审计记录（随 assistant 消息持久化，历史只读展示）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiActionRecord {
    pub tool_call_id: String,
    pub tool: String,
    pub intent: String,
    pub summary: String,
    /// approved | rejected | succeeded | failed（前端按此渲染状态）
    pub status: String,
    /// run_command 使用的整体超时秒数；旧记录无此字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_seconds: Option<u64>,
    /// 动作开始时已生成文本长度（content 内时序锚点，前端据此穿插动作卡）；旧记录无此字段
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_len: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermSnapshot {
    pub id: String,
    pub command: String,
    pub content: String,
    pub ts: i64,
}

/// 编辑器选区引用：@文件名_起始行_结束行号 标签对应的压缩内容
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    pub id: String,
    pub path: String,
    pub start_line: i64,
    pub end_line: i64,
    pub content: String,
    pub ts: i64,
}

/// 服务器/本地终端引用：UI 以 @remote:服务器名称 / @local 标签呈现，发送时展开为说明文本。
/// server_id = None 表示本地终端。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerRef {
    pub server_id: Option<String>,
    pub name: String,
}

/// 文件/目录路径引用：UI 以 @file:文件名 / @path:目录名 标签呈现，发送时只带路径不带内容。
/// server_id = 远端引用（SFTP 面板添加）时的目标服务器；None = 本地项目内文件/目录。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathRef {
    pub path: String,
    pub is_dir: bool,
    /// 旧会话无此字段时按 None（本地引用）解析
    #[serde(default)]
    pub server_id: Option<String>,
}

/// 内置浏览器元素引用：UI 以 @browser:{#id 或标签名} 标签呈现，发送时展开为页面信息 + 元素 HTML。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserRef {
    /// 显示名：有 id 为 #id，否则小写标签名
    pub name: String,
    pub tag_name: String,
    /// 元素 id（可空）
    pub element_id: String,
    /// 选中时的页面地址与标题
    pub url: String,
    pub title: String,
    /// 元素完整 outerHTML（注入脚本已截 20000 字符）
    /// 前端/注入脚本全程用 outerHTML，rename + alias 兼容可能已落盘的 outerHtml
    #[serde(rename = "outerHTML", alias = "outerHtml")]
    pub outer_html: String,
    pub ts: i64,
}

/// 技能引用：UI 以 @skill:名称 标签呈现，发送时展开为名称/来源/scope/描述（AI 可循此读取技能文件）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRef {
    pub name: String,
    /// global | project
    pub origin: String,
    /// scope 标签（local/all/remote:xxx）
    #[serde(default)]
    pub scope: Vec<String>,
    /// 一句话描述
    #[serde(default)]
    pub description: String,
}

/// 浏览器页面引用：UI 以 @page:页面标题 标签呈现，发送时展开页面标题与地址
/// （页面正文由 AI 自行用 browser_read / browser_screenshot 读取）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPageRef {
    pub url: String,
    pub title: String,
    pub ts: i64,
}

/// 笔记引用：UI 以 @note:笔记名称 标签呈现，发送时展开为笔记路径（AI 可循此读取笔记内容）。
/// 笔记为工作区全局 <workspace>/.aishell/notes 下的 markdown 文件；path 为绝对路径。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteRef {
    /// 输入 chip / 历史消息引用的唯一 id
    pub id: String,
    /// 笔记绝对路径
    pub path: String,
    /// 笔记显示名（label，不含 .md 扩展名）
    pub name: String,
}

/// 图片附件引用：UI 以缩略图呈现，发送时随 prompt 经 pi RPC images 字段传给多模态模型。
/// path 指向落盘副本（<project>/.aishell/ai-images/，attach 时由后端物化），
/// aishell.json 只存路径不存 base64（该文件整体原子重写，塞图会膨胀）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRef {
    pub id: String,
    /// local | remote | clipboard（附件来源，仅用于展示与排查）
    pub source: String,
    pub name: String,
    pub mime: String,
    /// 落盘副本绝对路径（ai_read_image 回读用）
    pub path: String,
    /// 来源原始路径（local/remote 来源保留，clipboard 无）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub origin_path: Option<String>,
    /// remote 来源时的目标服务器；其余 None
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub server_id: Option<String>,
    pub size: i64,
    pub ts: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
    pub snapshots: Vec<TermSnapshot>,
    /// 旧会话无此字段时按空处理
    #[serde(default)]
    pub file_refs: Vec<FileRef>,
    /// 服务器/本地终端引用（@remote:名称 / @local 标签）；旧会话无此字段时按空处理
    #[serde(default)]
    pub server_refs: Vec<ServerRef>,
    /// 文件/目录路径引用（@file:文件名 / @path:目录名 标签，发送时只带路径不带内容）；旧会话无此字段时按空处理
    #[serde(default)]
    pub path_refs: Vec<PathRef>,
    /// 内置浏览器元素引用（@browser:{#id 或标签名} 标签，发送时展开页面信息 + 元素 HTML）；旧会话无此字段时按空处理
    #[serde(default)]
    pub browser_refs: Vec<BrowserRef>,
    /// 浏览器页面引用（@page:页面标题 标签，发送时展开页面地址与标题）；旧会话无此字段时按空处理
    #[serde(default)]
    pub browser_page_refs: Vec<BrowserPageRef>,
    /// 技能引用（@skill:名称 标签，发送时展开名/来源/scope/描述）；旧会话无此字段时按空处理
    #[serde(default)]
    pub skill_refs: Vec<SkillRef>,
    /// 笔记引用（@note:名称 标签，发送时展开为笔记路径）；旧会话无此字段时按空处理
    #[serde(default)]
    pub note_refs: Vec<NoteRef>,
    /// 图片附件（缩略图展示，发送时经 pi RPC images 字段传图）；旧会话无此字段时按空处理
    #[serde(default)]
    pub image_refs: Vec<ImageRef>,
    /// AI 动作审计（本轮回复中工具动作的意图/目标/最终状态，不含完整输出）；旧会话按空。
    #[serde(default)]
    pub actions: Vec<AiActionRecord>,
    pub ts: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSession {
    pub id: String,
    pub title: String,
    pub messages: Vec<ChatMsg>,
    /// 首条用户消息的自动标题任务是否已经尝试过；失败也不重试。
    #[serde(default)]
    pub auto_title_triggered: bool,
    /// 会话已归档（归档后不出现在前端会话列表，数据仍保留，后续可支持取消归档）。
    #[serde(default)]
    pub archived: bool,
}

/// sessions: projectId -> Vec<ChatSession>
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub settings: Settings,
    #[serde(default)]
    pub credentials: Vec<Credential>,
    pub servers: Vec<Server>,
    pub projects: Vec<Project>,
    pub sessions: HashMap<String, Vec<ChatSession>>,
    /// 项目分类目录清单（'/' 分隔相对路径，与 Project.folder 同语义；空目录也在此）。
    /// 旧配置无此字段按空列表（未分类）解析。
    #[serde(default)]
    pub project_folders: Vec<String>,
    /// 命令收藏分类目录清单（'/' 分隔相对路径，与 QuickCommand.folder 同语义；空目录也在此）。
    /// 旧配置无此字段按空列表（未分类）解析。
    #[serde(default)]
    pub command_folders: Vec<String>,
    /// 各目录树展开状态：key = explorer:<projectId> | welcome:projectGroups | commands:folders，
    /// 值为展开节点的路径（或 folder 值）数组；key 语义与 src/types.ts AppState.uiExpanded 注释一致。
    /// 旧配置无此字段按空 map 解析。
    #[serde(default)]
    pub ui_expanded: HashMap<String, Vec<String>>,
    /// SFTP 路径历史：serverId → MRU 路径列表（最新在前，最多 10 条，由前端截断）。
    /// 旧配置无此字段按空 map 解析。
    #[serde(default)]
    pub sftp_history: HashMap<String, Vec<String>>,
    /// SFTP 收藏夹：serverId → 收藏条目（路径 + 标题，按添加顺序，由前端维护）。
    /// 旧配置为纯路径数组（Vec<String>），读取时经 de_sftp_favorites 自动迁移（标题取目录名）。
    #[serde(default, deserialize_with = "de_sftp_favorites")]
    pub sftp_favorites: HashMap<String, Vec<SftpFavorite>>,
    /// 内置浏览器地址栏历史（MRU：最新在前，上限 BROWSER_HISTORY_CAP 条，由 record_browser_history 维护）。
    /// 旧配置无此字段按空列表解析。
    #[serde(default)]
    pub browser_history: Vec<BrowserHistoryEntry>,
    /// 服务器数据库连接（AI 受管查询通道）：serverId → 连接列表。密码在 keyring。
    /// 旧配置无此字段按空 map 解析。
    #[serde(default)]
    pub db_connections: HashMap<String, Vec<DbConnection>>,
    /// MCP 服务全局配置（回环监听端口）；旧配置无此字段按默认端口 8945。
    #[serde(default)]
    pub mcp: McpServiceConfig,
    /// MCP 设备配置：serverId → 配置（enabled = 加入 MCP 可发现设备列表 + 功能开关）。
    /// 旧配置无此字段按空 map（全部未启用）。
    #[serde(default)]
    pub mcp_devices: HashMap<String, McpDeviceConfig>,
    /// 已完成内置技能播种的 workspace（规范化路径）；旧配置无此字段按空列表。
    /// 用户删除/修改内置技能后不会被同一 workspace 的重启/保存设置流程复活。
    #[serde(default)]
    pub seeded_skill_workspaces: Vec<String>,
    /// AI 会话 trace 日志开关（命令面板 `trace on/off`，见 trace.rs）；旧配置无此字段按关闭。
    /// 放在 AppState 顶层而非 Settings：设置页保存时整体提交 Settings 表单，表单无此字段会被覆盖。
    #[serde(default)]
    pub trace_enabled: bool,
    /// SSH 隧道配置（本地端口转发 -L 等价；enabled = 上次启用状态，重启时自动重建）。
    /// 旧配置无此字段按空列表。运行态（监听/错误）不落盘，由 tunnel.rs 即时合并。
    #[serde(default)]
    pub ssh_tunnels: Vec<crate::tunnel::TunnelConfig>,
}

/// Xshell 扫描产物：服务器 + 其相对 Sessions 目录（空串 = 根目录未分类）。
/// 服务器本身不再携带 folder；目录仅用于导入时按目录自动建项目。
#[derive(Debug, Clone)]
pub struct ScannedSession {
    pub server: Server,
    pub folder: String,
}

// ---------------------------------------------------------------- keyring

const KEYRING_SERVICE: &str = "AIShell";
const KEYRING_ACCOUNT_LLM: &str = "llm:apikey";
const KEYRING_ACCOUNT_BRAVE: &str = "brave:apikey";

fn keyring_account_credential(id: &str) -> String {
    format!("credential:{id}")
}

/// 旧服务器迁移所用的稳定凭据 ID；同一服务器重复加载始终得到同一凭据。
fn legacy_credential_id(server_id: &str) -> String {
    format!("credential-{server_id}")
}

fn default_credential_name(username: &str, host: &str) -> String {
    let username = username.trim();
    if username.is_empty() {
        host.to_string()
    } else {
        format!("{username}@{host}")
    }
}
/// MCP 接入令牌（自签本地配对令牌，非第三方凭据）。
/// 规则例外说明：`mcp_ensure_token` 命令会把它返回前端供显示/复制——这是「密钥永不返回
/// 前端」的唯一例外，因为令牌必须展示给用户粘贴到外部 agent 工具；仍存 keyring 不入 JSON。
const KEYRING_ACCOUNT_MCP: &str = "mcp:token";

fn keyring_account_server(id: &str) -> String {
    format!("server:{id}")
}

/// 数据库连接密码 keyring account：`db:<serverId>:<connId>`。
fn keyring_account_db(server_id: &str, conn_id: &str) -> String {
    format!("db:{server_id}:{conn_id}")
}

fn keyring_set(account: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|e| format!("访问系统钥匙串失败: {e}"))?;
    entry
        .set_password(value)
        .map_err(|e| format!("保存密钥失败: {e}"))
}

fn keyring_get(account: &str) -> Result<String, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|e| format!("访问系统钥匙串失败: {e}"))?;
    entry
        .get_password()
        .map_err(|e| format!("读取密钥失败: {e}"))
}

/// 删除 keyring 条目；条目不存在不算错。
fn keyring_delete(account: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, account)
        .map_err(|e| format!("访问系统钥匙串失败: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("删除密钥失败: {e}")),
    }
}

/// 密钥存储后端:生产 = 系统 keyring;测试 = 内存。
/// 单测绝不允许触碰用户真实的 Windows 凭据管理器。
trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<String, String>;
    fn set(&self, account: &str, value: &str) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}

struct KeyringSecrets;

impl SecretStore for KeyringSecrets {
    fn get(&self, account: &str) -> Result<String, String> {
        keyring_get(account)
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        keyring_set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        keyring_delete(account)
    }
}

#[cfg(test)]
#[derive(Default)]
struct MemorySecrets(std::sync::Mutex<std::collections::HashMap<String, String>>);

#[cfg(test)]
impl SecretStore for MemorySecrets {
    fn get(&self, account: &str) -> Result<String, String> {
        self.0
            .lock()
            .map_err(|_| "secrets 锁损坏".to_string())?
            .get(account)
            .cloned()
            .ok_or_else(|| format!("密钥不存在: {account}"))
    }
    fn set(&self, account: &str, value: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "secrets 锁损坏".to_string())?
            .insert(account.to_string(), value.to_string());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|_| "secrets 锁损坏".to_string())?
            .remove(account);
        Ok(())
    }
}

/// 测试专用：内存密钥后端构造 Store，绝不触碰真实 keyring（生产路径禁止使用）。
#[cfg(test)]
pub fn test_store(dir: PathBuf) -> Store {
    Store::with_secrets(dir, std::sync::Arc::new(MemorySecrets::default())).unwrap()
}

/// 测试专用：绕过 upsert_server 的业务校验直接写入/覆盖服务器，
/// 用于构造合法 API 到不了的非法堡垒机绑定态（幽灵/非堡垒机引用、链式跳板）做错误路径测试。
#[cfg(test)]
pub fn force_upsert_server(store: &Store, mut server: Server) {
    store
        .with_state(|s| {
            if server.credential_id.is_none() {
                let credential_id = legacy_credential_id(&server.id);
                server.credential_id = Some(credential_id.clone());
                if !s.credentials.iter().any(|c| c.id == credential_id) {
                    s.credentials.push(Credential {
                        id: credential_id,
                        name: default_credential_name(&server.username, &server.host),
                        auth_type: server.auth_type,
                        username: server.username.clone(),
                        key_path: server.key_path.clone(),
                    });
                }
            }
            match s.servers.iter_mut().find(|sv| sv.id == server.id) {
                Some(slot) => *slot = server,
                None => s.servers.push(server),
            }
            Ok(())
        })
        .unwrap();
}

// ---------------------------------------------------------------- Store

/// 线程安全（Send+Sync）：PathBuf + Mutex<AppState>。ssh/term 等模块持有 `Arc<Store>`。
pub struct Store {
    config_dir: PathBuf,
    state: Mutex<AppState>,
    secrets: std::sync::Arc<dyn SecretStore>,
}

const STATE_FILE: &str = "aishell.json";
/// 系统任务项目的保留 ID。该值参与 `<projectId>:<sessionId>` 会话 key，不能含冒号。
pub const TASK_PROJECT_ID: &str = "system-tasks";
const TASK_PROJECT_NAME: &str = "系统任务";

fn is_task_project_id(project_id: &str) -> bool {
    project_id == TASK_PROJECT_ID
}

/// 服务器标签规范化：逐项 trim、去空、去重（保序）。保存与导入入口统一走这里。
pub fn normalize_tags(tags: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim();
        if !t.is_empty() && !out.iter().any(|x| x == t) {
            out.push(t.to_string());
        }
    }
    out
}

/// 系统任务项目的固定目录：`<workspace>/.aishell/tasks`。
fn task_project_for_workspace(workspace: &str) -> Project {
    let path = PathBuf::from(workspace).join(".aishell").join("tasks");
    Project {
        id: TASK_PROJECT_ID.to_string(),
        name: TASK_PROJECT_NAME.to_string(),
        path: Some(path.to_string_lossy().into_owned()),
        server_ids: Vec::new(),
        quick_commands: Vec::new(),
        folder: String::new(),
        ai_mode: AiMode::Agent,
    }
}

/// 内置技能播种代际：skills.rs 新增内置技能时 +1。记录值为 `<ws>#gen<N>`；
/// 老记录是裸 `<ws>`（gen1，仅 skill-management 时代），不匹配新一代标记 →
/// 老工作区会补种一次（seed_one_builtin_skill 文件级幂等，已有技能文件不覆盖）。
const SEED_GENERATION: u32 = 2;

/// 播种记录标记（`<ws>#gen<N>`）， seeded_skill_workspaces 按此精确匹配去重。
fn seed_marker(ws: &str) -> String {
    format!("{ws}#gen{SEED_GENERATION}")
}

/// 规范化 workspace 路径用于播种记录去重：目录存在时 canonicalize，否则原样（写入前会创建）。
/// Windows canonicalize 的 `\\?\` verbatim 前缀统一剥掉，避免落盘记录形态不一致。
fn normalize_ws(ws: &str) -> String {
    let p = PathBuf::from(ws.trim());
    let p = std::fs::canonicalize(&p).unwrap_or(p);
    #[cfg(windows)]
    let p = {
        let s = p.to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            PathBuf::from(format!(r"\\{rest}"))
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            PathBuf::from(rest)
        } else {
            p
        }
    };
    p.to_string_lossy().into_owned()
}

/// 会话内全部自由文本脱敏（消息正文/快照/文件引用/动作摘要与意图），返回是否有变更。幂等：
/// 已脱敏内容再次处理字符串不变，不会误报 changed。
/// 先做会话级值收集（跨消息共享同一凭据的 KV 值），再逐字段替换——
/// 这样命令行 `-p'值'`、正文复述、动作摘要里的裸文本形态也能被掩盖。
fn redact_session(session: &mut ChatSession, known: &[String]) -> bool {
    let mut secrets = known.to_vec();
    for msg in &session.messages {
        crate::redact::harvest_secrets(&msg.content, &mut secrets);
        for snap in &msg.snapshots {
            crate::redact::harvest_secrets(&snap.content, &mut secrets);
        }
        for r in &msg.file_refs {
            crate::redact::harvest_secrets(&r.content, &mut secrets);
        }
        for a in &msg.actions {
            crate::redact::harvest_secrets(&a.summary, &mut secrets);
            crate::redact::harvest_secrets(&a.intent, &mut secrets);
        }
    }
    secrets.sort();
    secrets.dedup();
    let mut changed = false;
    let mut redact_field = |field: &mut String| {
        let (masked, _) = crate::redact::redact_secrets(field, &secrets);
        if masked != *field {
            *field = masked;
            changed = true;
        }
    };
    for msg in &mut session.messages {
        redact_field(&mut msg.content);
        for snap in &mut msg.snapshots {
            redact_field(&mut snap.content);
        }
        for r in &mut msg.file_refs {
            redact_field(&mut r.content);
        }
        for a in &mut msg.actions {
            redact_field(&mut a.summary);
            redact_field(&mut a.intent);
        }
    }
    changed
}

/// 启动/切换 workspace 迁移：把仍在使用外部路径的密钥型凭据与服务器收编进
/// `<workspace>/.aishell/ssh-key/`。凭据是 key_path 的事实源：先收编凭据并镜像到
/// 引用服务器；未引用凭据（或凭据还没有密钥）的服务器就地收编并回写凭据。
/// 单个失败跳过（下次启动/保存设置重试），返回变更条数（调用方仅在 >0 时落盘）。
pub(crate) fn adopt_managed_ssh_keys(state: &mut AppState) -> usize {
    let Some(workspace) = state
        .settings
        .workspace_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
    else {
        return 0;
    };
    let mut changed = 0;
    // 1) 收编凭据自己的外部密钥。
    for credential in &mut state.credentials {
        if credential.auth_type != AuthType::Key || credential.key_path.trim().is_empty() {
            continue;
        }
        if let Some(adopted) = ssh_keys::adopt_key_into_workspace(&workspace, &credential.key_path)
        {
            credential.key_path = adopted;
            changed += 1;
        }
    }
    // 凭据路径快照：镜像与孤儿判定都要按 id 查凭据，克隆一份避免借用冲突。
    let credential_paths: HashMap<String, (AuthType, String)> = state
        .credentials
        .iter()
        .map(|c| (c.id.clone(), (c.auth_type, c.key_path.clone())))
        .collect();
    // 2) 凭据的保管路径镜像到引用它的密钥服务器（与保存凭据时的镜像行为一致）。
    for server in &mut state.servers {
        if server.auth_type != AuthType::Key {
            continue;
        }
        let Some((auth, path)) = server
            .credential_id
            .as_ref()
            .and_then(|id| credential_paths.get(id))
        else {
            continue;
        };
        if *auth != AuthType::Key || path.trim().is_empty() {
            continue;
        }
        if server.key_path != *path {
            server.key_path = path.clone();
            changed += 1;
        }
    }
    // 3) 未引用凭据（或凭据还没有密钥路径）的密钥服务器：就地收编服务器自己的外部密钥。
    let mut server_adoptions: Vec<(String, String)> = Vec::new();
    for server in &state.servers {
        if server.auth_type != AuthType::Key || server.key_path.trim().is_empty() {
            continue;
        }
        if ssh_keys::is_managed_path(&server.key_path, &workspace) {
            continue;
        }
        let credential_has_key = server
            .credential_id
            .as_ref()
            .and_then(|id| credential_paths.get(id))
            .is_some_and(|(auth, path)| *auth == AuthType::Key && !path.trim().is_empty());
        if credential_has_key {
            continue;
        }
        if let Some(adopted) = ssh_keys::adopt_key_into_workspace(&workspace, &server.key_path) {
            server_adoptions.push((server.id.clone(), adopted));
        }
    }
    for (server_id, adopted) in server_adoptions {
        let Some(server) = state.servers.iter_mut().find(|s| s.id == server_id) else {
            continue;
        };
        if let Some(credential_id) = server.credential_id.clone() {
            if let Some(credential) = state.credentials.iter_mut().find(|c| c.id == credential_id)
            {
                credential.key_path = adopted.clone();
            }
        }
        server.key_path = adopted;
        changed += 1;
    }
    changed
}

impl Store {
    /// 加载 <config_dir>/aishell.json；文件不存在时用默认 state（settings 全空、llm 默认、其余为空）。
    pub fn new(config_dir: PathBuf) -> Result<Self, String> {
        Self::with_secrets(config_dir, std::sync::Arc::new(KeyringSecrets))
    }

    fn with_secrets(
        config_dir: PathBuf,
        secrets: std::sync::Arc<dyn SecretStore>,
    ) -> Result<Self, String> {
        fs::create_dir_all(&config_dir).map_err(|e| format!("创建配置目录失败: {e}"))?;
        let state_path = config_dir.join(STATE_FILE);
        let state: AppState = match fs::read(&state_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("配置文件 {STATE_FILE} 解析失败: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => AppState::default(),
            Err(e) => return Err(format!("读取配置文件失败: {e}")),
        };
        let store = Self {
            config_dir,
            state: Mutex::new(state),
            secrets,
        };
        // 服务器凭据迁移必须先于 known_secrets：会话脱敏应读取迁移后的
        // credential:<id>，不能在旧 server:<id> 已删除后才发现新凭据。
        store.migrate_legacy_credentials()?;
        // 密钥收编迁移：早期版本密钥型凭据/服务器可能仍指向外部私钥文件，workspace
        // 已配置时复制进 `.aishell/ssh-key/` 保管目录并改写 key_path（单个失败跳过）。
        let adopted_keys = {
            let mut guard = store
                .state
                .lock()
                .map_err(|_| "store 状态锁损坏".to_string())?;
            adopt_managed_ssh_keys(&mut guard)
        };
        if adopted_keys > 0 {
            let guard = store
                .state
                .lock()
                .map_err(|_| "store 状态锁损坏".to_string())?;
            store.persist_locked(&guard)?;
        }
        // 历史会话一次性脱敏迁移：旧版本可能把配置里的凭据明文落盘（违反硬约束）；
        // 加载时按现行规则清洗，有变更立即原子写回。
        // 同时做默认模型迁移：配置里还是上一代默认值时升级为当前默认（vision 模型），
        // 用户显式改过的其他模型名不受影响。
        let known = store.known_secrets();
        let dirty = {
            let mut guard = store
                .state
                .lock()
                .map_err(|_| "store 状态锁损坏".to_string())?;
            let mut dirty = false;
            if guard.settings.llm.model_id == LEGACY_DEFAULT_MODEL_ID {
                guard.settings.llm.model_id = LlmConfig::default().model_id;
                dirty = true;
            }
            for sess in guard.sessions.values_mut().flatten() {
                if redact_session(sess, &known) {
                    dirty = true;
                }
            }
            dirty
        };
        if dirty {
            let guard = store
                .state
                .lock()
                .map_err(|_| "store 状态锁损坏".to_string())?;
            store.persist_locked(&guard)?;
        }
        // 内置技能一次性播种：workspace 已配置且从未播种时创建全局 skill-management；
        // 失败阻止启动（不以不完整状态运行）。
        if let Some(ws) = store
            .settings()
            .workspace_dir
            .as_deref()
            .filter(|s| !s.trim().is_empty())
        {
            store.seed_builtin_skill(ws)?;
        }
        Ok(store)
    }

    /// 锁内变更状态并原子持久化；f 返回 Err 时不变更也不落盘。
    fn with_state<T>(
        &self,
        f: impl FnOnce(&mut AppState) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())?;
        let out = f(&mut guard)?;
        self.persist_locked(&guard)?;
        Ok(out)
    }

    /// 用候选快照提交跨实体变更：持久化成功后才替换内存状态，失败时保持原状态。
    fn with_candidate_state<T>(
        &self,
        f: impl FnOnce(&mut AppState) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())?;
        let mut candidate = guard.clone();
        let out = f(&mut candidate)?;
        self.persist_locked(&candidate)?;
        *guard = candidate;
        Ok(out)
    }

    /// 先写 aishell.json.tmp 再 rename，避免半截文件。
    fn persist_locked(&self, state: &AppState) -> Result<(), String> {
        let json =
            serde_json::to_string_pretty(state).map_err(|e| format!("序列化状态失败: {e}"))?;
        let tmp = self.config_dir.join(format!("{STATE_FILE}.tmp"));
        fs::write(&tmp, json).map_err(|e| format!("写入临时文件失败: {e}"))?;
        fs::rename(&tmp, self.config_dir.join(STATE_FILE))
            .map_err(|e| format!("原子替换配置文件失败: {e}"))
    }

    /// 将旧的 server:<serverId> 密钥迁移到确定性的 credential:<credentialId>。
    /// 先写新密钥、再持久化状态、最后删除旧密钥；任一步失败都不会先删除旧密码。
    fn migrate_legacy_credentials(&self) -> Result<(), String> {
        let mut pending = Vec::new();
        {
            let guard = self
                .state
                .lock()
                .map_err(|_| "store 状态锁损坏".to_string())?;
            for server in &guard.servers {
                if server.credential_id.is_some() {
                    continue;
                }
                let credential_id = legacy_credential_id(&server.id);
                let has_credential = guard.credentials.iter().any(|c| c.id == credential_id);
                let old_account = keyring_account_server(&server.id);
                let old_password = self.secrets.get(&old_account).ok();
                let new_password_exists = self
                    .secrets
                    .get(&keyring_account_credential(&credential_id))
                    .is_ok();
                pending.push((
                    server.clone(),
                    credential_id,
                    has_credential,
                    old_account,
                    old_password,
                    new_password_exists,
                ));
            }
        }
        if pending.is_empty() {
            return Ok(());
        }

        // 先复制密钥。已有新账号不覆盖，重复启动时保持幂等且不破坏用户更新过的密码。
        let mut created_accounts: Vec<String> = Vec::new();
        for (_, credential_id, _, _, password, new_password_exists) in &pending {
            if let (Some(password), false) = (password.as_deref(), *new_password_exists) {
                let account = keyring_account_credential(credential_id);
                if let Err(error) = self.secrets.set(&account, password) {
                    for created in created_accounts {
                        let _ = self.secrets.delete(&created);
                    }
                    return Err(error);
                }
                created_accounts.push(account);
            }
        }

        if let Err(error) = self.with_candidate_state(|state| {
            for (server, credential_id, has_credential, _, _, _) in &pending {
                if let Some(slot) = state.servers.iter_mut().find(|s| s.id == server.id) {
                    if slot.credential_id.is_none() {
                        slot.credential_id = Some(credential_id.clone());
                    }
                }
                if !*has_credential && !state.credentials.iter().any(|c| c.id == *credential_id) {
                    state.credentials.push(Credential {
                        id: credential_id.clone(),
                        name: default_credential_name(&server.username, &server.host),
                        auth_type: server.auth_type,
                        username: server.username.clone(),
                        key_path: server.key_path.clone(),
                    });
                }
            }
            Ok(())
        }) {
            for account in created_accounts {
                let _ = self.secrets.delete(&account);
            }
            return Err(error);
        }

        // 状态已经成功落盘后才清理旧账号；清理失败不影响新凭据和旧密码的可恢复性。
        for (_, _, _, old_account, _, _) in pending {
            self.secrets.delete(&old_account)?;
        }
        Ok(())
    }

    fn is_config_complete(&self) -> bool {
        let Ok(guard) = self.state.lock() else {
            return false;
        };
        guard
            .settings
            .workspace_dir
            .as_deref()
            .is_some_and(|s| !s.trim().is_empty())
    }

    /// 保存设置；api_key / brave_key 为 Some 时写入 keyring（空串也写，视为覆盖），None 保持原值。
    /// workspace 切换/首配时在同一事务内播种内置技能：播种失败整体回滚（旧 settings 与播种记录保留）。
    /// pub(crate)：skills.rs 等模块的测试需要构造带 workspace 的 Store。
    pub(crate) fn save_settings(
        &self,
        settings: Settings,
        api_key: Option<&str>,
        brave_key: Option<&str>,
    ) -> Result<(), String> {
        if let Some(key) = api_key {
            self.secrets.set(KEYRING_ACCOUNT_LLM, key)?;
        }
        if let Some(key) = brave_key {
            self.secrets.set(KEYRING_ACCOUNT_BRAVE, key)?;
        }
        self.with_state(|s| {
            // 先播种（失败 → 闭包返回 Err，s.settings 与播种记录均未变更，整体回滚）
            if let Some(ws) = settings
                .workspace_dir
                .as_deref()
                .filter(|w| !w.trim().is_empty())
            {
                let ws = normalize_ws(ws);
                let marker = seed_marker(&ws);
                if !s.seeded_skill_workspaces.contains(&marker) {
                    crate::skills::seed_builtin_skill_files(&ws)?;
                    s.seeded_skill_workspaces.push(marker);
                }
            }
            s.settings = settings.clone();
            // 首次配置/切换 workspace 后，顺带收编仍在外部的私钥（单个失败跳过）。
            adopt_managed_ssh_keys(s);
            Ok(())
        })
    }

    /// 内置技能播种：workspace 非空且未记录时创建 `<workspace>/.aishell/skills/<name>/SKILL.md`；
    /// 目标已存在则保留用户文件不覆盖；只有文件已存在或成功创建后才记录 workspace 并原子落盘。
    fn seed_builtin_skill(&self, workspace: &str) -> Result<(), String> {
        let ws = normalize_ws(workspace);
        if ws.is_empty() {
            return Ok(());
        }
        let marker = seed_marker(&ws);
        {
            let guard = self
                .state
                .lock()
                .map_err(|_| "store 状态锁损坏".to_string())?;
            if guard.seeded_skill_workspaces.contains(&marker) {
                return Ok(());
            }
        }
        crate::skills::seed_builtin_skill_files(&ws)?;
        self.with_state(|s| {
            if !s.seeded_skill_workspaces.contains(&marker) {
                s.seeded_skill_workspaces.push(marker);
            }
            Ok(())
        })
    }

    /// 仅更新界面主题（顶栏快捷切换用；避免前端回传整个 Settings 造成 llm 字段竞态覆盖）。
    fn set_theme(&self, theme: Theme) -> Result<(), String> {
        self.with_state(|s| {
            s.settings.theme = theme;
            Ok(())
        })
    }

    fn validate_server(&self, server: &Server) -> Result<(), String> {
        if server.is_bastion && server.bastion_id.is_some() {
            return Err(format!(
                "服务器「{}」不能同时作为堡垒机与目标主机",
                server.name
            ));
        }
        if let Some(bid) = &server.bastion_id {
            let bastion_ok = self
                .state
                .lock()
                .map_err(|_| "store 状态锁损坏".to_string())?
                .servers
                    .iter()
                .any(|sv| sv.id == *bid && sv.is_bastion);
            if !bastion_ok {
                return Err(format!(
                    "目标主机「{}」的堡垒机不存在或未开启堡垒机功能（{}）",
                    server.name, bid
                ));
            }
        }
        Ok(())
        }

    fn new_credential_id(&self, server_id: &str, state: &AppState) -> String {
        let base = format!("credential-{server_id}");
        if !state.credentials.iter().any(|c| c.id == base) {
            return base;
        }
        let mut n = 2;
        loop {
            let id = format!("{base}-{n}");
            if !state.credentials.iter().any(|c| c.id == id) {
                return id;
            }
            n += 1;
        }
    }

    fn credential_from_server(id: String, server: &Server, name: String) -> Credential {
        Credential {
            id,
            name,
            auth_type: server.auth_type,
            username: server.username.clone(),
            key_path: server.key_path.clone(),
        }
    }

    /// 服务器已存在则更新，否则插入；password 为 Some 时写入凭据 keyring，None 保持原值。
    /// 这是内部兼容 API，采用确定性的 update 行为，不向调用方暴露交互选择。
    pub fn upsert_server(&self, server: Server, password: Option<&str>) -> Result<(), String> {
        self.save_server_with_credential(server, password, CredentialSaveMode::Update)
            .map(|_| ())
    }

    /// 保存服务器并按凭据引用关系处理共享凭据。
    pub fn save_server_with_credential(
        &self,
        mut server: Server,
        password: Option<&str>,
        mode: CredentialSaveMode,
    ) -> Result<ServerSaveResult, String> {
        server.tags = normalize_tags(&server.tags);
        // 密钥认证先把外部私钥收编进 workspace 保管目录（凭据跨项目共享，密钥随凭据走）。
        if server.auth_type == AuthType::Key {
            if let Some(adopted) = self.adopt_key_path(&server.key_path) {
                server.key_path = adopted;
            }
        }
        self.validate_server(&server)?;
        let snapshot = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())?
            .clone();
        let existing = snapshot.servers.iter().find(|s| s.id == server.id).cloned();
        let current_id = existing.as_ref().and_then(|s| s.credential_id.clone());
        let current = current_id
            .as_ref()
            .and_then(|id| snapshot.credentials.iter().find(|c| c.id == *id).cloned());
        let requested_id = server.credential_id.clone();
        let requested = requested_id
            .as_ref()
            .and_then(|id| snapshot.credentials.iter().find(|c| c.id == *id).cloned());
        if requested_id.is_some() && requested.is_none() {
            return Err(format!(
                "凭据不存在：{}",
                requested_id.as_deref().unwrap_or_default()
            ));
        }

        let target_references = requested_id.as_ref().map_or(0, |id| {
            snapshot
                .servers
                .iter()
                .filter(|item| item.credential_id.as_deref() == Some(id))
                .count()
        });
        let same_credential = requested_id.is_some() && requested_id == current_id;
        let credential_changed = requested.as_ref().is_some_and(|credential| {
            credential.auth_type != server.auth_type
                || credential.username != server.username
                || credential.key_path != server.key_path
        });
        let modifies_existing = credential_changed || password.is_some();
        if let Some(credential) = requested.as_ref() {
            if target_references > 0
                && mode == CredentialSaveMode::Ask
                && modifies_existing
            {
                return Ok(ServerSaveResult::NeedsChoice {
                    credential_name: credential.name.clone(),
                    reference_count: target_references,
                });
            }
        }

        let mut update_shared = false;
        let mut copy_from = None;
        let credential = match (&existing, requested, same_credential, mode) {
            (_, Some(selected), _, CredentialSaveMode::Fork) if modifies_existing => {
                copy_from = Some(selected.id.clone());
                Self::credential_from_server(
                    self.new_credential_id(&server.id, &snapshot),
                    &server,
                    default_credential_name(&server.username, &server.host),
                )
            }
            (_, Some(mut selected), _, CredentialSaveMode::Update) if modifies_existing => {
                selected.auth_type = server.auth_type;
                selected.username = server.username.clone();
                selected.key_path = server.key_path.clone();
                update_shared = true;
                selected
            }
            (_, Some(selected), _, _) => {
                server.auth_type = selected.auth_type;
                server.username = selected.username.clone();
                server.key_path = selected.key_path.clone();
                selected
            }
            (Some(_), None, _, _) => {
                copy_from = current.as_ref().map(|credential| credential.id.clone());
                Self::credential_from_server(
                    self.new_credential_id(&server.id, &snapshot),
                    &server,
                    default_credential_name(&server.username, &server.host),
                )
            }
            (None, None, _, _) => Self::credential_from_server(
                self.new_credential_id(&server.id, &snapshot),
                &server,
                default_credential_name(&server.username, &server.host),
            ),
        };
        server.credential_id = Some(credential.id.clone());

        let account = keyring_account_credential(&credential.id);
        let old_secret = self.secrets.get(&account).ok();
        let copied_secret = copy_from
            .as_deref()
            .and_then(|id| self.secrets.get(&keyring_account_credential(id)).ok());
        // 公钥(密钥对)类型与 Key 一样不向 keyring 写密码:部署公钥所需的密码是用户
        // 连接时一次性输入的,不进系统凭据库。
        let secret_update = if matches!(
            credential.auth_type,
            AuthType::Key | AuthType::PublicKey
        ) {
            Some(None)
        } else if let Some(value) = password {
            Some(Some(value.to_string()))
        } else if copy_from.is_some() {
            copied_secret.map(Some)
        } else {
            None
        };
        if let Some(value) = &secret_update {
            match value {
                Some(value) => self.secrets.set(&account, value)?,
                None => self.secrets.delete(&account)?,
            }
        }

        let persisted = self.with_candidate_state(|state| {
            match state.credentials.iter_mut().find(|item| item.id == credential.id) {
                Some(slot) if update_shared => *slot = credential.clone(),
                Some(_) => {}
                None => state.credentials.push(credential.clone()),
            }
            if update_shared {
                for item in &mut state.servers {
                    if item.credential_id.as_deref() == Some(&credential.id) {
                        item.auth_type = credential.auth_type;
                        item.username = credential.username.clone();
                        item.key_path = credential.key_path.clone();
                    }
                }
            }
            match state.servers.iter_mut().find(|item| item.id == server.id) {
                Some(slot) => *slot = server.clone(),
                None => state.servers.push(server.clone()),
            }
            Ok(())
        });
        if let Err(error) = persisted {
            if secret_update.is_some() {
                match old_secret {
                    Some(value) => {
                        let _ = self.secrets.set(&account, &value);
                    }
                    None => {
                        let _ = self.secrets.delete(&account);
                    }
                }
            }
            return Err(error);
        }
        Ok(ServerSaveResult::Saved { server })
    }

    /// 全部凭据配置（不含密码）。
    pub fn credentials_all(&self) -> Vec<Credential> {
        self.state
            .lock()
            .map(|g| g.credentials.clone())
            .unwrap_or_default()
    }

    /// 保存凭据并同步所有引用服务器的认证镜像；password 为 None 保持原密码。
    pub fn upsert_credential(
        &self,
        mut credential: Credential,
        password: Option<&str>,
    ) -> Result<Credential, String> {
        if credential.id.trim().is_empty() || credential.name.trim().is_empty() {
            return Err("凭据名称不能为空".to_string());
        }
        // 密钥认证先把外部私钥收编进 workspace 保管目录，之后引用服务器镜像同一保管路径。
        if credential.auth_type == AuthType::Key {
            if let Some(adopted) = self.adopt_key_path(&credential.key_path) {
                credential.key_path = adopted;
            }
        }
        let account = keyring_account_credential(&credential.id);
        let old_secret = self.secrets.get(&account).ok();
        // 公钥(密钥对)类型与 Key 一样不向 keyring 写密码:部署公钥所需的密码是用户
        // 连接时一次性输入的,不进系统凭据库。
        let secret_update = if matches!(
            credential.auth_type,
            AuthType::Key | AuthType::PublicKey
        ) {
            Some(None)
        } else {
            password.map(|value| Some(value.to_string()))
        };
        if let Some(value) = &secret_update {
            match value {
                Some(value) => self.secrets.set(&account, value)?,
                None => self.secrets.delete(&account)?,
            }
        }
        let persisted = self.with_candidate_state(|state| {
            match state.credentials.iter_mut().find(|item| item.id == credential.id) {
                Some(slot) => *slot = credential.clone(),
                None => state.credentials.push(credential.clone()),
            }
            for server in &mut state.servers {
                if server.credential_id.as_deref() == Some(&credential.id) {
                    server.auth_type = credential.auth_type;
                    server.username = credential.username.clone();
                    server.key_path = credential.key_path.clone();
                }
            }
            Ok(credential.clone())
        });
        if let Err(error) = persisted {
            if secret_update.is_some() {
                match old_secret {
                    Some(value) => {
                        let _ = self.secrets.set(&account, &value);
                    }
                    None => {
                        let _ = self.secrets.delete(&account);
                    }
                }
            }
            return Err(error);
        }
        persisted
    }

    /// 删除未被服务器引用的凭据；密钥认证凭据也尽力清理对应 keyring 账号。
    pub fn delete_credential(&self, id: &str) -> Result<(), String> {
        let (credential, references, old_password) = {
            let guard = self
                .state
                .lock()
                .map_err(|_| "store 状态锁损坏".to_string())?;
            let credential = guard.credentials.iter().find(|c| c.id == id).cloned();
            let references = guard
                .servers
                .iter()
                .filter(|s| s.credential_id.as_deref() == Some(id))
                .count();
            let password = self.secrets.get(&keyring_account_credential(id)).ok();
            (credential, references, password)
        };
        if credential.is_none() {
            return Ok(());
        }
        if references > 0 {
            return Err(format!(
                "凭据「{}」仍被 {} 台服务器引用，不能删除",
                credential.unwrap().name,
                references
            ));
        }
        self.secrets.delete(&keyring_account_credential(id))?;
        if let Err(e) = self.with_state(|s| {
            s.credentials.retain(|c| c.id != id);
            Ok(())
        }) {
            if let Some(password) = old_password {
                let _ = self.secrets.set(&keyring_account_credential(id), &password);
            }
            return Err(e);
        }
        Ok(())
    }

    /// 清除未被任何服务器引用的凭据元数据与 keyring 密钥，返回清除数量。
    pub fn clear_unreferenced_credentials(&self) -> Result<usize, String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())?;
        let referenced: HashSet<String> = guard
            .servers
            .iter()
            .filter_map(|server| server.credential_id.clone())
            .collect();
        let orphan_ids: HashSet<String> = guard
            .credentials
            .iter()
            .filter(|credential| !referenced.contains(&credential.id))
            .map(|credential| credential.id.clone())
            .collect();
        if orphan_ids.is_empty() {
            return Ok(0);
        }
        let orphans: Vec<(String, Option<String>)> = orphan_ids
            .iter()
            .map(|id| {
                let account = keyring_account_credential(id);
                let old_secret = self.secrets.get(&account).ok();
                (account, old_secret)
            })
            .collect();

        let mut deleted: Vec<(String, Option<String>)> = Vec::with_capacity(orphans.len());
        for (account, old_secret) in &orphans {
            if let Err(error) = self.secrets.delete(account) {
                for (deleted_account, deleted_secret) in &deleted {
                    if let Some(secret) = deleted_secret {
                        let _ = self.secrets.set(deleted_account, secret);
                    }
                }
                return Err(error);
            }
            deleted.push((account.clone(), old_secret.clone()));
        }

        let mut candidate = guard.clone();
        candidate
            .credentials
            .retain(|credential| !orphan_ids.contains(&credential.id));
        if let Err(error) = self.persist_locked(&candidate) {
            for (account, old_secret) in &deleted {
                if let Some(secret) = old_secret {
                    let _ = self.secrets.set(account, secret);
                }
            }
            return Err(error);
        }
        *guard = candidate;
        Ok(orphan_ids.len())
    }

    /// 从状态中移除服务器及其附属配置，返回待清理的数据库 keyring 账号。
    fn remove_servers_from_state(
        state: &mut AppState,
        ids: &HashSet<String>,
        unbind_projects: bool,
    ) -> Vec<String> {
        let db_accounts = ids
            .iter()
            .flat_map(|server_id| {
                state
                    .db_connections
                    .get(server_id)
                    .into_iter()
                    .flatten()
                    .map(|connection| keyring_account_db(server_id, &connection.id))
            })
            .collect();
        state.servers.retain(|server| !ids.contains(&server.id));
        state.mcp_devices.retain(|server_id, _| !ids.contains(server_id));
        state.sftp_history.retain(|server_id, _| !ids.contains(server_id));
        state.sftp_favorites.retain(|server_id, _| !ids.contains(server_id));
        state.db_connections.retain(|server_id, _| !ids.contains(server_id));
        if unbind_projects {
            for project in &mut state.projects {
                project.server_ids.retain(|server_id| !ids.contains(server_id));
            }
        }
        db_accounts
    }

    fn delete_db_accounts(&self, accounts: Vec<String>) {
        for account in accounts {
            let _ = self.secrets.delete(&account);
        }
    }

    /// 移除服务器、级联清理项目绑定及服务器附属配置，不删除可复用凭据。
    /// 服务器是堡垒机且仍有目标主机时拒绝删除（避免留下指向幽灵堡垒机的目标），
    /// 提示先到「SSH跳转设置」解除目标主机绑定。
    fn delete_server(&self, id: &str) -> Result<(), String> {
        let has_targets = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())?
            .servers
            .iter()
            .any(|server| server.bastion_id.as_deref() == Some(id));
        if has_targets {
            let name = self
                .server(id)
                .map(|server| server.name)
                .unwrap_or_else(|| id.to_string());
            return Err(format!(
                "堡垒机「{name}」仍有目标主机绑定，请先在「SSH跳转设置」中解除目标主机绑定后再删除"
            ));
        }
        let ids = HashSet::from([id.to_string()]);
        let db_accounts = self.with_candidate_state(|state| {
            Ok(Self::remove_servers_from_state(state, &ids, true))
        })?;
        self.delete_db_accounts(db_accounts);
        Ok(())
    }

    /// 清除未被项目直接引用、也不是其依赖堡垒机的服务器及附属配置，返回清除数量。
    pub fn clear_unreferenced_servers(&self) -> Result<usize, String> {
        let (removed, db_accounts) = self.with_candidate_state(|state| {
            let mut keep: HashSet<String> = state
                .projects
                .iter()
                .flat_map(|project| project.server_ids.iter().cloned())
                .collect();
            let mut pending: Vec<String> = keep.iter().cloned().collect();
            while let Some(server_id) = pending.pop() {
                let Some(bastion_id) = state
                    .servers
                    .iter()
                    .find(|server| server.id == server_id)
                    .and_then(|server| server.bastion_id.clone())
                else {
                    continue;
                };
                if keep.insert(bastion_id.clone()) {
                    pending.push(bastion_id);
                }
            }
            let removed_ids: HashSet<String> = state
                .servers
                .iter()
                .filter(|server| !keep.contains(&server.id))
                .map(|server| server.id.clone())
                .collect();
            let removed = removed_ids.len();
            let db_accounts = Self::remove_servers_from_state(state, &removed_ids, false);
            Ok((removed, db_accounts))
        })?;
        self.delete_db_accounts(db_accounts);
        Ok(removed)
    }

    /// 分类目录名规范化：整体 trim、按 '/' 拆分、过滤空段后 join('/')（与前端表单同语义）。
    fn normalize_folder(name: &str) -> String {
        name.trim()
            .split('/')
            .filter(|seg| !seg.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    }

    /// 新建项目分类目录：规范化名称；空串报错、重名报错；嵌套路径自动补建缺失的祖先目录，
    /// 保证树形展示时中间层级存在。一次 with_state 原子落盘。
    pub fn create_project_folder(&self, name: &str) -> Result<(), String> {
        let folder = Self::normalize_folder(name);
        if folder.is_empty() {
            return Err("分类目录名称不能为空".to_string());
        }
        self.with_state(|s| {
            if s.project_folders.iter().any(|f| f == &folder) {
                return Err("分类目录已存在".to_string());
            }
            let segs: Vec<&str> = folder.split('/').collect();
            for i in 1..=segs.len() {
                let prefix = segs[..i].join("/");
                if !s.project_folders.iter().any(|f| f == &prefix) {
                    s.project_folders.push(prefix);
                }
            }
            Ok(())
        })
    }

    /// 重命名项目分类目录：前缀级联——folder==old 或以 old/ 为前缀（子分类）的项目与目录
    /// 条目同步改写；级联结果与既有目录撞名时去重合并；new 的祖先目录缺失时补建。
    /// 未分类（空串）不可重命名；new 规范化后与 old 相同视为 no-op。一次 with_state 原子落盘。
    pub fn rename_project_folder(&self, old: &str, new: &str) -> Result<(), String> {
        if old.is_empty() {
            return Err("未分类目录不可重命名".to_string());
        }
        let folder = Self::normalize_folder(new);
        if folder.is_empty() {
            return Err("分类目录名称不能为空".to_string());
        }
        if folder == old {
            return Ok(());
        }
        let old_prefix = format!("{old}/");
        let cascade = |f: &str| -> Option<String> {
            if f == old {
                Some(folder.clone())
            } else {
                f.strip_prefix(&old_prefix)
                    .map(|rest| format!("{folder}/{rest}"))
            }
        };
        self.with_state(|s| {
            if s.project_folders.iter().any(|f| f == &folder) {
                return Err("分类目录已存在".to_string());
            }
            for p in &mut s.projects {
                if let Some(nf) = cascade(&p.folder) {
                    p.folder = nf;
                }
            }
            let mut folders = std::mem::take(&mut s.project_folders);
            for f in folders.iter_mut() {
                if let Some(nf) = cascade(f) {
                    *f = nf;
                }
            }
            if !folders.iter().any(|f| f == &folder) {
                folders.push(folder.clone());
            }
            // new 的祖先目录缺失时补建（与 create 同语义）
            let segs: Vec<&str> = folder.split('/').collect();
            for i in 1..segs.len() {
                let prefix = segs[..i].join("/");
                if !folders.iter().any(|f| f == &prefix) {
                    folders.push(prefix);
                }
            }
            // 级联后可能与既有目录撞名，去重保序
            let mut seen: Vec<String> = Vec::new();
            folders.retain(|f| {
                if seen.iter().any(|x| x == f) {
                    false
                } else {
                    seen.push(f.clone());
                    true
                }
            });
            s.project_folders = folders;
            Ok(())
        })
    }

    /// 按分类递归删除项目：folder 精确匹配或以其为前缀（子分类）的项目全部按
    /// delete_project 同语义删除（删项目记录与 sessions，不动服务器）；
    /// 同时清理该前缀下的 project_folders 条目。返回删除的项目数。
    pub fn delete_folder_with_projects(&self, name: &str) -> Result<usize, String> {
        if name.is_empty() {
            return Err("未分类目录不可删除".to_string());
        }
        let folder = Self::normalize_folder(name);
        if folder.is_empty() {
            return Err("分类目录名称不能为空".to_string());
        }
        let prefix = format!("{folder}/");
        self.with_state(|s| {
            let matches = |f: &str| f == folder || f.starts_with(&prefix);
            let removed: Vec<String> = s
                .projects
                .iter()
                .filter(|p| matches(&p.folder))
                .map(|p| p.id.clone())
                .collect();
            if removed.iter().any(|id| is_task_project_id(id)) {
                return Err("系统任务项目不可删除".to_string());
            }
            let n = removed.len();
            s.projects.retain(|p| !matches(&p.folder));
            for id in &removed {
                s.sessions.remove(id);
            }
            s.project_folders.retain(|f| !matches(f));
            Ok(n)
        })
    }

    /// 删除项目分类目录：规范化名称；未分类空串报错；目录下仍有项目报错；
    /// 不存在视为幂等成功。一次 with_state 原子落盘。
    pub fn delete_project_folder(&self, name: &str) -> Result<(), String> {
        if name.is_empty() {
            return Err("未分类目录不可删除".to_string());
        }
        let folder = Self::normalize_folder(name);
        if folder.is_empty() {
            return Err("分类目录名称不能为空".to_string());
        }
        self.with_state(|s| {
            if s.projects.iter().any(|p| p.folder == folder) {
                return Err(format!("分类目录「{folder}」下仍有项目，不能删除"));
            }
            s.project_folders.retain(|f| *f != folder);
            Ok(())
        })
    }

    /// 新建命令收藏分类目录：规范化名称；空串报错、重名报错；一次 with_state 原子落盘。
    /// 空目录也保存在 command_folders（与 project_folders 同语义）。
    pub fn create_command_folder(&self, name: &str) -> Result<(), String> {
        let folder = Self::normalize_folder(name);
        if folder.is_empty() {
            return Err("分类目录名称不能为空".to_string());
        }
        self.with_state(|s| {
            if s.command_folders.iter().any(|f| f == &folder) {
                return Err("分类目录已存在".to_string());
            }
            s.command_folders.push(folder);
            Ok(())
        })
    }

    /// 重命名命令收藏分类目录：级联改写所有项目 quick_commands 中 folder==old 的命令
    /// （含不在 command_folders 列表里的旧值），并同步列表（old 移除、new 不存在才追加）。
    /// 未分类（空串）不可重命名；new 规范化后与 old 相同视为 no-op。一次 with_state 原子落盘。
    pub fn rename_command_folder(&self, old: &str, new: &str) -> Result<(), String> {
        if old.is_empty() {
            return Err("未分类目录不可重命名".to_string());
        }
        let folder = Self::normalize_folder(new);
        if folder.is_empty() {
            return Err("分类目录名称不能为空".to_string());
        }
        if folder == old {
            return Ok(());
        }
        self.with_state(|s| {
            if s.command_folders.iter().any(|f| f == &folder) {
                return Err("分类目录已存在".to_string());
            }
            for p in &mut s.projects {
                for qc in &mut p.quick_commands {
                    if qc.folder == old {
                        qc.folder = folder.clone();
                    }
                }
            }
            s.command_folders.retain(|f| f != old);
            if !s.command_folders.iter().any(|f| f == &folder) {
                s.command_folders.push(folder);
            }
            Ok(())
        })
    }

    /// 删除命令收藏分类目录：规范化名称；未分类空串报错；任意项目仍有命令使用该目录时报错；
    /// 不存在视为幂等成功。一次 with_state 原子落盘。
    pub fn delete_command_folder(&self, name: &str) -> Result<(), String> {
        if name.is_empty() {
            return Err("未分类目录不可删除".to_string());
        }
        let folder = Self::normalize_folder(name);
        if folder.is_empty() {
            return Err("分类目录名称不能为空".to_string());
        }
        self.with_state(|s| {
            if s.projects
                .iter()
                .any(|p| p.quick_commands.iter().any(|qc| qc.folder == folder))
            {
                return Err(format!("分类目录「{folder}」下仍有命令，不能删除"));
            }
            s.command_folders.retain(|f| *f != folder);
            Ok(())
        })
    }

    /// 写入目录树展开状态（key = explorer:<projectId> | welcome:projectGroups | commands:folders，
    /// values 为展开节点的路径或 folder 值数组，空数组即清空该 key）。
    /// 前端防抖后调用，仅覆盖该 key 不影响其他展开状态。一次 with_state 原子落盘。
    pub fn set_ui_expanded(&self, key: String, values: Vec<String>) -> Result<(), String> {
        if key.is_empty() {
            return Err("展开状态 key 不能为空".to_string());
        }
        self.with_state(|s| {
            s.ui_expanded.insert(key, values);
            Ok(())
        })
    }

    /// 写入某服务器的 SFTP 路径历史（MRU：最新在前，最多 10 条由前端维护）。
    /// 前端防抖后调用，仅覆盖该 serverId 不影响其他服务器。一次 with_state 原子落盘。
    pub fn set_sftp_history(&self, server_id: String, paths: Vec<String>) -> Result<(), String> {
        if server_id.is_empty() {
            return Err("服务器 ID 不能为空".to_string());
        }
        self.with_state(|s| {
            s.sftp_history.insert(server_id, paths);
            Ok(())
        })
    }

    /// 记录内置浏览器地址栏历史：URL 完全一致则置顶并补填非空标题，否则插入头部；
    /// 超出 [`BROWSER_HISTORY_CAP`] 截尾。空 URL 忽略。一次 with_state 原子落盘。
    /// URL/标题均为对外展示形态（本地文件即 file:///），由前端导航事件传入。
    pub fn record_browser_history(&self, url: String, title: String) -> Result<(), String> {
        let url = url.trim().to_string();
        if url.is_empty() {
            return Ok(());
        }
        let title = title.trim().to_string();
        self.with_state(|s| {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let list = &mut s.browser_history;
            match list.iter().position(|e| e.url == url) {
                Some(pos) => {
                    // 同地址重复访问：置顶刷新时间；标题只补不洗（后到的空串别抹掉已知标题）
                    let mut entry = list.remove(pos);
                    if !title.is_empty() {
                        entry.title = title;
                    }
                    entry.ts = ts;
                    list.insert(0, entry);
                }
                None => list.insert(0, BrowserHistoryEntry { url, title, ts }),
            }
            list.truncate(BROWSER_HISTORY_CAP);
            Ok(())
        })
    }

    /// 地址栏历史下拉数据源：query 非空时对 URL 与标题做大小写不敏感子串过滤，
    /// 保持 MRU 序，最多 limit 条。只读不改状态、不落盘。
    pub fn browser_history_filtered(&self, query: &str, limit: usize) -> Vec<BrowserHistoryEntry> {
        let guard = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())
            .expect("store 状态锁损坏");
        filter_browser_history(&guard.browser_history, query, limit)
    }

    /// 写入某服务器的 SFTP 收藏夹（路径 + 标题，按添加顺序）。
    /// 前端防抖后调用，仅覆盖该 serverId 不影响其他服务器。一次 with_state 原子落盘。
    pub fn set_sftp_favorites(
        &self,
        server_id: String,
        favorites: Vec<SftpFavorite>,
    ) -> Result<(), String> {
        if server_id.is_empty() {
            return Err("服务器 ID 不能为空".to_string());
        }
        self.with_state(|s| {
            s.sftp_favorites.insert(server_id, favorites);
            Ok(())
        })
    }

    /// 批量合并 Xshell 导入的服务器并按其目录自动建项目：一次 with_state 原子持久化，不触碰 SecretStore。
    /// 服务器合并语义：ID 已存在 → 连接配置以导入为准，但**保留现有 AI 锁与堡垒机绑定**（重新导入绝不能
    /// 解锁或改绑）；配置完全一致（含锁位）→ unchanged；存在差异 → 覆盖并计 updated；不存在 → imported。
    /// 项目：按 folder 分组，项目名 = folder 路径（如 "生产环境/Web"），空串统一归「未命名项目」；
    /// 按名字匹配已有项目则复用（仅补绑 serverIds，去重），否则新建项目（id 唯一 proj- 前缀；
    /// path=None；quick_commands 空；ai_mode 默认；folder=''）并计 projects_created。
    /// 绑定对所有导入/更新/未变服务器都生效（幂等，不产生重复 serverIds）。
    pub(crate) fn merge_xshell_servers(
        &self,
        sessions: &[ScannedSession],
    ) -> Result<XshellImportResult, String> {
        let mut result = XshellImportResult::default();
        self.with_state(|s| {
            for scan in sessions {
                let sv = &scan.server;
                match s.servers.iter_mut().find(|x| x.id == sv.id) {
                    Some(slot) => {
                        let mut merged = sv.clone();
                        merged.credential_id = slot.credential_id.clone();
                        merged.locked = slot.locked;
                        merged.is_bastion = slot.is_bastion;
                        merged.bastion_id = slot.bastion_id.clone();
                        if *slot == merged {
                            result.unchanged += 1;
                        } else {
                            *slot = merged;
                            result.updated += 1;
                        }
                    }
                    None => {
                        let mut imported = sv.clone();
                        let credential_id = imported
                            .credential_id
                            .clone()
                            .unwrap_or_else(|| legacy_credential_id(&imported.id));
                        imported.credential_id = Some(credential_id.clone());
                        if !s.credentials.iter().any(|c| c.id == credential_id) {
                            s.credentials.push(Credential {
                                id: credential_id,
                                name: default_credential_name(&imported.username, &imported.host),
                                auth_type: imported.auth_type,
                                username: imported.username.clone(),
                                key_path: imported.key_path.clone(),
                            });
                        }
                        s.servers.push(imported);
                        result.imported += 1;
                    }
                }
            }
            // 按目录归组：项目名 = 目录路径；空目录统一归「未命名项目」。保持扫描顺序，
            // 同一目录内按出现顺序累计 server id（去重）。
            let mut groups: Vec<(String, Vec<String>)> = Vec::new();
            for scan in sessions {
                let name = if scan.folder.is_empty() {
                    "未命名项目".to_string()
                } else {
                    scan.folder.clone()
                };
                match groups.iter_mut().find(|(n, _)| *n == name) {
                    Some((_, ids)) => {
                        if !ids.contains(&scan.server.id) {
                            ids.push(scan.server.id.clone());
                        }
                    }
                    None => groups.push((name, vec![scan.server.id.clone()])),
                }
            }
            for (name, ids) in groups {
                match s.projects.iter_mut().find(|p| p.name == name) {
                    // 同名项目复用：仅补绑 serverIds（去重）
                    Some(p) => {
                        for id in ids {
                            if !p.server_ids.contains(&id) {
                                p.server_ids.push(id);
                            }
                        }
                    }
                    None => {
                        // 唯一 id：毫秒时间戳 hex + 冲突递增后缀，proj- 前缀
                        let base = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_nanos())
                            .unwrap_or(0);
                        let mut id = format!("proj-{base:x}");
                        let mut n = 0u64;
                        while s.projects.iter().any(|p| p.id == id) {
                            n += 1;
                            id = format!("proj-{base:x}-{n}");
                        }
                        s.projects.push(Project {
                            id,
                            name,
                            path: None,
                            server_ids: ids,
                            quick_commands: Vec::new(),
                            folder: String::new(),
                            ai_mode: AiMode::default(),
                        });
                        result.projects_created += 1;
                    }
                }
            }
            Ok(result)
        })
    }

    pub fn upsert_project(&self, project: Project) -> Result<(), String> {
        if is_task_project_id(&project.id) {
            return Err("系统任务项目不可修改".to_string());
        }
        // 命令收藏非空 folder 自动注册进 command_folders、项目自身非空 folder 自动注册进
        // project_folders（前端手输新目录保存时无需先建目录）
        let folders: Vec<String> = project
            .quick_commands
            .iter()
            .filter(|qc| !qc.folder.is_empty())
            .map(|qc| qc.folder.clone())
            .collect();
        let project_folder = project.folder.clone();
        self.with_state(|s| {
            match s.projects.iter_mut().find(|p| p.id == project.id) {
                Some(slot) => *slot = project,
                None => s.projects.push(project),
            }
            for f in folders {
                if !s.command_folders.iter().any(|x| x == &f) {
                    s.command_folders.push(f);
                }
            }
            if !project_folder.is_empty() && !s.project_folders.iter().any(|x| x == &project_folder)
            {
                s.project_folders.push(project_folder);
            }
            Ok(())
        })
    }

    /// 删除项目并顺带清理该项目的 sessions。
    fn delete_project(&self, id: &str) -> Result<(), String> {
        if is_task_project_id(id) {
            return Err("系统任务项目不可删除".to_string());
        }
        self.with_state(|s| {
            s.projects.retain(|p| p.id != id);
            s.sessions.remove(id);
            Ok(())
        })
    }

    /// path 为 Some → 在该目录下创建 .aishell/；为 None → 用 <workspace_dir>/<name> 并创建（含 .aishell/）。
    /// 目录已存在不报错。返回最终项目路径。
    /// pub(crate)：ai_actions 的 SDK 导入项目（路径留空时默认 workspace 下创建）复用。
    pub(crate) fn ensure_project_dirs(
        &self,
        path: Option<&str>,
        name: &str,
    ) -> Result<String, String> {
        let project_dir = match path {
            Some(p) if !p.trim().is_empty() => PathBuf::from(p),
            _ => {
                let guard = self
                    .state
                    .lock()
                    .map_err(|_| "store 状态锁损坏".to_string())?;
                let ws = guard
                    .settings
                    .workspace_dir
                    .as_deref()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| "请先在设置中配置工作区目录".to_string())?;
                PathBuf::from(ws).join(name)
            }
        };
        fs::create_dir_all(project_dir.join(".aishell"))
            .map_err(|e| format!("创建项目目录失败: {e}"))?;
        Ok(project_dir.to_string_lossy().into_owned())
    }

    pub(crate) fn sessions_get(&self, project_id: &str) -> Result<Vec<ChatSession>, String> {
        let guard = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())?;
        Ok(guard.sessions.get(project_id).cloned().unwrap_or_default())
    }

    pub(crate) fn session_upsert(
        &self,
        project_id: &str,
        mut session: ChatSession,
    ) -> Result<(), String> {
        // 落盘前脱敏：快照/文件引用/消息正文可能含配置里读到的凭据（硬约束：密码永不进 JSON）。
        // 注意 known_secrets() 自身要锁 state，必须先于 with_state 调用（std Mutex 不可重入）。
        let known = self.known_secrets();
        redact_session(&mut session, &known);
        self.with_state(|s| {
            let list = s.sessions.entry(project_id.to_string()).or_default();
            match list.iter_mut().find(|x| x.id == session.id) {
                Some(slot) => {
                    // 标题领取状态只允许后端原子命令推进，普通前端 upsert 不可抢先置位。
                    // 已领取后同样保留后端标题，避免旧前端快照覆盖异步生成结果。
                    session.auto_title_triggered = slot.auto_title_triggered;
                    if slot.auto_title_triggered {
                        session.title = slot.title.clone();
                    }
                    // 归档标记只由后端 set_session_archived 推进，前端残留快照不可冲掉。
                    session.archived = slot.archived;
                    *slot = session;
                }
                None => {
                    // 新会话同样从未领取开始，普通前端 upsert 不可直接置位。
                    session.auto_title_triggered = false;
                    session.archived = false;
                    list.push(session);
                }
            }
            Ok(())
        })
    }

    /// 原子领取首条用户消息的标题任务：只要首条消息匹配且尚未领取就成功。
    pub(crate) fn try_claim_session_title(
        &self,
        project_id: &str,
        session_id: &str,
        first_message: &str,
    ) -> Result<Option<String>, String> {
        self.with_state(|s| {
            let Some(session) = s
                .sessions
                .get_mut(project_id)
                .and_then(|list| list.iter_mut().find(|item| item.id == session_id))
            else {
                return Ok(None);
            };
            let Some(message) = session.messages.first() else {
                return Ok(None);
            };
            if session.auto_title_triggered
                || message.role != "user"
                || message.content != first_message
            {
                return Ok(None);
            }
            let expected_title = session.title.clone();
            session.auto_title_triggered = true;
            Ok(Some(expected_title))
        })
    }

    /// 标题请求完成后，仅在会话仍使用对应临时标题时写回，避免覆盖用户已识别的会话。
    pub(crate) fn update_session_title_if_expected(
        &self,
        project_id: &str,
        session_id: &str,
        expected_titles: &[String],
        title: &str,
    ) -> Result<bool, String> {
        self.with_state(|s| {
            let Some(session) = s
                .sessions
                .get_mut(project_id)
                .and_then(|list| list.iter_mut().find(|item| item.id == session_id))
            else {
                return Ok(false);
            };
            if !expected_titles
                .iter()
                .any(|expected| expected == &session.title)
            {
                return Ok(false);
            }
            session.title = title.to_string();
            Ok(true)
        })
    }

    /// 原子设置会话归档标记；返回是否实际变更（会话不存在视为无变更）。
    pub(crate) fn set_session_archived(
        &self,
        project_id: &str,
        session_id: &str,
        archived: bool,
    ) -> Result<bool, String> {
        self.with_state(|s| {
            let Some(session) = s
                .sessions
                .get_mut(project_id)
                .and_then(|list| list.iter_mut().find(|item| item.id == session_id))
            else {
                return Ok(false);
            };
            if session.archived == archived {
                return Ok(false);
            }
            session.archived = archived;
            Ok(true)
        })
    }

    // ---------------------------------------------------------- 下游模块 API
    // ssh.rs / sftp.rs / ai.rs 依赖以下 pub 方法（SshManager::new(store: Arc<Store>)）。

    /// 配置目录（mcp.rs 传输目录回退用）。
    pub fn config_dir(&self) -> &std::path::Path {
        &self.config_dir
    }

    /// 取服务器配置（clone 返回，不含密码）；不存在返回 None。
    pub fn server(&self, id: &str) -> Option<Server> {
        let guard = self.state.lock().ok()?;
        guard.servers.iter().find(|sv| sv.id == id).cloned()
    }

    /// 读通用 keyring 密钥（仅内部后端使用）。密码账号统一为 credential:<id>。
    /// 对历史测试/异常调用保留 server:<id> 的只读兼容映射，正常 SSH 路径不使用它。
    pub fn read_secret(&self, account: &str) -> Result<String, String> {
        if let Some(server_id) = account.strip_prefix("server:") {
            if let Some(server) = self.server(server_id) {
                if let Ok(value) = self.read_server_secret(&server) {
                    return Ok(value);
                }
            }
        }
        self.secrets.get(account)
    }

    /// 按服务器引用读取密码；正常路径只访问 credential:<id>。
    pub fn read_server_secret(&self, server: &Server) -> Result<String, String> {
        let credential_id = server
            .credential_id
            .as_deref()
            .ok_or_else(|| format!("服务器「{}」未关联登录凭据", server.name))?;
        self.secrets.get(&keyring_account_credential(credential_id))
    }

    /// 已知密钥字面量（LLM/Brave API Key + 各凭据密码 + 数据库连接密码），供 redact 脱敏精确匹配。
    /// 空值与 <4 字符的短值剔除（短值误伤面大），结果去重。读取失败的条目静默跳过。
    pub fn known_secrets(&self) -> Vec<String> {
        let mut out: Vec<String> = [KEYRING_ACCOUNT_LLM, KEYRING_ACCOUNT_BRAVE]
            .iter()
            .filter_map(|acc| self.secrets.get(acc).ok())
            .collect();
        let guard = self.state.lock();
        if let Ok(g) = guard {
            for credential in &g.credentials {
                if let Ok(v) = self
                    .secrets
                    .get(&keyring_account_credential(&credential.id))
                {
                    out.push(v);
                }
            }
            for sv in &g.servers {
                if let Some(conns) = g.db_connections.get(&sv.id) {
                    for c in conns {
                        if let Ok(v) = self.secrets.get(&keyring_account_db(&sv.id, &c.id)) {
                            out.push(v);
                        }
                    }
                }
            }
        }
        out.retain(|s| s.len() >= 4);
        out.sort();
        out.dedup();
        out
    }

    /// 当前 LLM 配置（clone）。
    pub fn llm_config(&self) -> LlmConfig {
        let guard = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())
            .expect("store 状态锁损坏");
        guard.settings.llm.clone()
    }

    /// 当前审批模式（默认智能审批）。
    pub fn approval_mode(&self) -> ApprovalMode {
        self.settings().approval_mode
    }

    /// AI 会话 trace 日志开关（trace.rs init 读取初值）。
    pub fn trace_enabled(&self) -> bool {
        let Ok(guard) = self.state.lock() else {
            return false;
        };
        guard.trace_enabled
    }

    /// 原子落盘 trace 开关（trace_set_enabled 命令；运行时标志由 trace.rs 自置）。
    pub fn set_trace_enabled(&self, enabled: bool) -> Result<(), String> {
        self.with_state(|s| {
            s.trace_enabled = enabled;
            Ok(())
        })
    }

    /// 当前全局设置（clone）。
    pub fn settings(&self) -> Settings {
        let guard = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())
            .expect("store 状态锁损坏");
        guard.settings.clone()
    }

    /// 笔记根目录:workspace 全局 `.aishell/notes`(不存在则创建);workspace 未配置报错。
    pub fn notes_root(&self) -> Result<PathBuf, String> {
        let ws = self
            .settings()
            .workspace_dir
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "请先在设置中配置工作区目录".to_string())?;
        let root = PathBuf::from(ws).join(".aishell").join("notes");
        fs::create_dir_all(&root).map_err(|e| format!("创建笔记目录失败: {e}"))?;
        Ok(root)
    }

    /// 保存密钥型凭据/服务器时收编外部私钥（见 `ssh_keys::adopt_key_into_workspace`）。
    pub(crate) fn adopt_key_path(&self, key_path: &str) -> Option<String> {
        let settings = self.settings();
        let workspace = settings
            .workspace_dir
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())?;
        ssh_keys::adopt_key_into_workspace(workspace, key_path)
    }

    /// SSH 隧道配置列表（全部；运行态见 tunnel.rs TunnelManager）。
    pub fn tunnels_all(&self) -> Vec<TunnelConfig> {
        self.state
            .lock()
            .map(|g| g.ssh_tunnels.clone())
            .unwrap_or_default()
    }

    /// 保存隧道配置（按 id upsert，原子落盘）。
    pub fn save_tunnel(&self, cfg: TunnelConfig) -> Result<(), String> {
        self.with_state(|state| {
            match state.ssh_tunnels.iter_mut().find(|t| t.id == cfg.id) {
                Some(slot) => *slot = cfg.clone(),
                None => state.ssh_tunnels.push(cfg.clone()),
            }
            Ok(())
        })
    }

    /// 删除隧道配置（运行中的隧道由 tunnel_delete 先 stop 再调这里）。
    pub fn delete_tunnel(&self, id: &str) -> Result<(), String> {
        self.with_state(|state| {
            state.ssh_tunnels.retain(|t| t.id != id);
            Ok(())
        })
    }

    /// 系统任务项目：不落入 AppState.projects，按当前 workspace 合成并确保目录存在。
    /// 任务项目固定使用 `<workspace>/.aishell/tasks`，没有 workspace 时返回可执行的中文错误。
    pub fn task_project(&self) -> Result<Project, String> {
        let workspace = self
            .settings()
            .workspace_dir
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| "请先在设置中配置工作区目录".to_string())?;
        let project = task_project_for_workspace(workspace.trim());
        fs::create_dir_all(
            PathBuf::from(project.path.as_deref().unwrap_or_default()).join(".aishell"),
        )
        .map_err(|e| format!("创建系统任务目录失败: {e}"))?;
        Ok(project)
    }

    /// 项目本地路径；任务项目按 workspace 合成，普通项目未设置或不存在返回 None。
    pub fn project_path(&self, project_id: &str) -> Option<String> {
        if is_task_project_id(project_id) {
            return self.task_project().ok().and_then(|p| p.path);
        }
        let guard = self.state.lock().ok()?;
        guard
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .and_then(|p| p.path.clone())
    }

    /// 项目配置（clone 返回）；系统任务项目按 workspace 合成，不写入 projects。
    pub fn project(&self, project_id: &str) -> Option<Project> {
        if is_task_project_id(project_id) {
            return self.task_project().ok();
        }
        let guard = self.state.lock().ok()?;
        guard.projects.iter().find(|p| p.id == project_id).cloned()
    }

    /// 全部服务器配置（clone 返回；不含密码——密码在 keyring）。SDK 导入去重等用。
    pub fn servers_all(&self) -> Vec<Server> {
        self.state
            .lock()
            .map(|g| g.servers.clone())
            .unwrap_or_default()
    }

    /// 全部普通项目（clone 返回）。系统任务合成项目永不暴露给项目列表或 SDK 导入。
    pub fn projects_all(&self) -> Vec<Project> {
        self.state
            .lock()
            .map(|g| {
                g.projects
                    .iter()
                    .filter(|p| !is_task_project_id(&p.id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 项目 AI 模式；系统任务上下文固定为 Agent，普通项目不存在返回 None。
    pub fn ai_mode(&self, project_id: &str) -> Option<AiMode> {
        if is_task_project_id(project_id) {
            return Some(AiMode::Agent);
        }
        let guard = self.state.lock().ok()?;
        guard
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.ai_mode)
    }

    /// 原子更新单个项目的 ai_mode（只改目标字段，不回传整个 Project）。
    /// 系统任务上下文固定 Agent，拒绝任何试图打开 yolo 的调用。
    pub fn set_ai_mode(&self, project_id: &str, mode: AiMode) -> Result<(), String> {
        if is_task_project_id(project_id) {
            return if mode == AiMode::Agent {
                Ok(())
            } else {
                Err("系统任务上下文固定为工作模式".to_string())
            };
        }
        self.with_state(|s| {
            let p = s
                .projects
                .iter_mut()
                .find(|p| p.id == project_id)
                .ok_or_else(|| format!("项目不存在：{project_id}"))?;
            p.ai_mode = mode;
            Ok(())
        })
    }

    /// 原子更新单个服务器的 AI 锁（只改目标字段）。
    pub fn set_server_locked(&self, id: &str, locked: bool) -> Result<(), String> {
        self.with_state(|s| {
            let sv = s
                .servers
                .iter_mut()
                .find(|sv| sv.id == id)
                .ok_or_else(|| format!("服务器不存在：{id}"))?;
            sv.locked = locked;
            Ok(())
        })
    }

    /// 服务器数据库连接列表（clone 返回，不含密码）。
    pub fn db_connections(&self, server_id: &str) -> Vec<DbConnection> {
        self.state
            .lock()
            .map(|g| g.db_connections.get(server_id).cloned().unwrap_or_default())
            .unwrap_or_default()
    }

    /// 取单个数据库连接（不含密码）；不存在返回 None。
    pub fn db_connection(&self, server_id: &str, conn_id: &str) -> Option<DbConnection> {
        self.db_connections(server_id)
            .into_iter()
            .find(|c| c.id == conn_id)
    }

    /// 读数据库连接密码（keyring account `db:<serverId>:<connId>`）。
    pub fn db_secret(&self, server_id: &str, conn_id: &str) -> Result<String, String> {
        self.secrets.get(&keyring_account_db(server_id, conn_id))
    }

    /// 保存数据库连接：password 为 Some 时写 keyring（含空串，视为清空/覆盖），None 保持原值。
    /// 连接不存在则插入，已存在则更新（按 id 匹配）。
    pub fn save_db_connection(
        &self,
        server_id: &str,
        connection: DbConnection,
        password: Option<&str>,
    ) -> Result<(), String> {
        if connection.id.trim().is_empty() || connection.name.trim().is_empty() {
            return Err("连接名称不能为空".to_string());
        }
        if connection.host.trim().is_empty() {
            return Err("数据库主机不能为空".to_string());
        }
        if connection.port == 0 {
            return Err("数据库端口无效".to_string());
        }
        // redis 无需账号（redis-cli 无 user 概念）；mysql/clickhouse 必须有
        if connection.user.trim().is_empty() && connection.kind != DbKind::Redis {
            return Err("数据库用户不能为空".to_string());
        }
        if let Some(pw) = password {
            self.secrets
                .set(&keyring_account_db(server_id, &connection.id), pw)?;
        }
        self.with_state(|s| {
            let list = s.db_connections.entry(server_id.to_string()).or_default();
            match list.iter_mut().find(|c| c.id == connection.id) {
                Some(slot) => *slot = connection,
                None => list.push(connection),
            }
            Ok(())
        })
    }

    /// 删除数据库连接（配置 + keyring 密码一并清理）。
    pub fn delete_db_connection(&self, server_id: &str, conn_id: &str) -> Result<(), String> {
        self.with_state(|s| {
            if let Some(list) = s.db_connections.get_mut(server_id) {
                list.retain(|c| c.id != conn_id);
            }
            Ok(())
        })?;
        let _ = self.secrets.delete(&keyring_account_db(server_id, conn_id));
        Ok(())
    }

    // ---------------------------------------------------------- MCP 服务
    // 配置存 aishell.json；接入令牌存 keyring（KEYRING_ACCOUNT_MCP）。

    /// 当前 MCP 服务配置（clone）。
    pub fn mcp_config(&self) -> McpServiceConfig {
        self.state.lock().map(|g| g.mcp).unwrap_or_default()
    }

    /// 修改 MCP 监听端口（1024–65535），只改目标字段。
    pub fn set_mcp_port(&self, port: u16) -> Result<(), String> {
        if !(1024..=65535).contains(&port) {
            return Err("MCP 端口必须在 1024–65535 之间".to_string());
        }
        self.with_state(|s| {
            s.mcp.port = port;
            Ok(())
        })
    }

    /// 某服务器的 MCP 设备配置（clone）；未配置返回 None。
    pub fn mcp_device(&self, server_id: &str) -> Option<McpDeviceConfig> {
        self.state
            .lock()
            .ok()
            .and_then(|g| g.mcp_devices.get(server_id).cloned())
    }

    /// 保存 MCP 设备配置（服务器必须存在；由 mcp_set_device 命令调用并同步监听）。
    pub fn set_mcp_device(&self, server_id: &str, config: McpDeviceConfig) -> Result<(), String> {
        if self.server(server_id).is_none() {
            return Err(format!("服务器不存在：{server_id}"));
        }
        self.with_state(|s| {
            s.mcp_devices.insert(server_id.to_string(), config);
            Ok(())
        })
    }

    /// 全部 MCP 设备配置（带服务器信息，list_devices 与监听判断用）。
    pub fn mcp_devices(&self) -> Vec<(Server, McpDeviceConfig)> {
        self.state
            .lock()
            .map(|g| {
                g.mcp_devices
                    .iter()
                    .filter_map(|(sid, cfg)| {
                        g.servers
                            .iter()
                            .find(|s| &s.id == sid)
                            .map(|s| (s.clone(), cfg.clone()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    /// 已启用 MCP 的设备数（>0 时监听需运行）。
    pub fn mcp_enabled_count(&self) -> usize {
        self.state
            .lock()
            .map(|g| g.mcp_devices.values().filter(|d| d.enabled).count())
            .unwrap_or(0)
    }

    /// 读取或生成 MCP 接入令牌（keyring account `mcp:token`）。
    /// 自签本地配对令牌：sha256(纳秒时间戳‖pid‖进程内计数器‖旧值) 十六进制前 32 字符。
    pub fn mcp_token_ensure(&self) -> Result<String, String> {
        if let Ok(t) = self.secrets.get(KEYRING_ACCOUNT_MCP) {
            if t.len() >= 16 {
                return Ok(t);
            }
        }
        let token = self.mcp_token_generate();
        self.secrets.set(KEYRING_ACCOUNT_MCP, &token)?;
        Ok(token)
    }

    /// 重置 MCP 接入令牌（返回新值；旧令牌立即失效——校验每次从 keyring 现读）。
    pub fn mcp_token_reset(&self) -> Result<String, String> {
        let token = self.mcp_token_generate();
        self.secrets.set(KEYRING_ACCOUNT_MCP, &token)?;
        Ok(token)
    }

    fn mcp_token_generate(&self) -> String {
        use std::sync::atomic::{AtomicU64, Ordering};
        static CTR: AtomicU64 = AtomicU64::new(0);
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        h.update(now.to_le_bytes());
        h.update(std::process::id().to_le_bytes());
        h.update(CTR.fetch_add(1, Ordering::Relaxed).to_le_bytes());
        if let Ok(old) = self.secrets.get(KEYRING_ACCOUNT_MCP) {
            h.update(old.as_bytes());
        }
        hex::encode(h.finalize())[..32].to_string()
    }
}

// ---------------------------------------------------------------- Tauri commands
// 命令名/参数名与 src/api.ts 的 store 段逐一对应（Tauri snake_case→camelCase 自动映射）。
// 注册由主 agent 集成阶段统一做，本模块只暴露函数。

// Tauri 要求 async 命令带引用输入时必须返回 Result；返回 bool/String 的命令改同步形态。

#[tauri::command]
pub fn is_config_complete(store: State<'_, Arc<Store>>) -> bool {
    store.is_config_complete()
}

#[tauri::command]
pub async fn get_state(store: State<'_, Arc<Store>>) -> Result<AppState, String> {
    let guard = store
        .state
        .lock()
        .map_err(|_| "store 状态锁损坏".to_string())?;
    Ok(guard.clone())
}

/// 返回欢迎页系统任务上下文；该合成项目不写入 AppState.projects。
#[tauri::command]
pub async fn get_task_project(store: State<'_, Arc<Store>>) -> Result<Project, String> {
    store.task_project()
}

#[tauri::command]
pub async fn save_settings(
    store: State<'_, Arc<Store>>,
    settings: Settings,
    api_key: Option<String>,
    brave_key: Option<String>,
) -> Result<(), String> {
    store.save_settings(settings, api_key.as_deref(), brave_key.as_deref())
}

#[tauri::command]
pub async fn set_theme(store: State<'_, Arc<Store>>, theme: Theme) -> Result<(), String> {
    store.set_theme(theme)
}

#[tauri::command]
pub async fn upsert_server(
    store: State<'_, Arc<Store>>,
    ssh: State<'_, Arc<crate::ssh::SshManager>>,
    server: Server,
    password: Option<String>,
    credential_mode: Option<CredentialSaveMode>,
) -> Result<ServerSaveResult, String> {
    let saved = store.save_server_with_credential(
        server.clone(),
        password.as_deref(),
        credential_mode.unwrap_or_default(),
    )?;
    // 认证配置可能已变（如切换认证方式）：断开该服务器旧连接，下次操作按新配置重连；
    // 否则连接池里的旧会话（密码/密钥已认证过）会被继续复用，修改不生效。
    if matches!(saved, ServerSaveResult::Saved { .. }) {
        ssh.disconnect(&server.id).await;
    }
    Ok(saved)
}

#[tauri::command]
pub async fn upsert_credential(
    store: State<'_, Arc<Store>>,
    ssh: State<'_, Arc<crate::ssh::SshManager>>,
    credential: Credential,
    password: Option<String>,
) -> Result<Credential, String> {
    let saved = store.upsert_credential(credential.clone(), password.as_deref())?;
    // 凭据认证信息变更：断开所有引用它的服务器连接，下次连接按新凭据重连。
    for server in store.servers_all() {
        if server.credential_id.as_deref() == Some(&credential.id) {
            ssh.disconnect(&server.id).await;
        }
    }
    Ok(saved)
}

#[tauri::command]
pub async fn delete_credential(store: State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    store.delete_credential(&id)
}

#[tauri::command]
pub async fn clear_unreferenced_credentials(
    store: State<'_, Arc<Store>>,
) -> Result<usize, String> {
    store.clear_unreferenced_credentials()
}

#[tauri::command]
pub async fn delete_server(
    store: State<'_, Arc<Store>>,
    mcp: State<'_, Arc<crate::mcp::McpService>>,
    ssh: State<'_, Arc<crate::ssh::SshManager>>,
    id: String,
) -> Result<(), String> {
    store.delete_server(&id)?;
    // 级联清理 MCP 设备配置后同步监听（可能需停止）
    mcp.sync().await;
    // 服务器已删除：断开连接池残留连接（一直挂着会常驻 TCP 直到 watcher 检测）
    ssh.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn upsert_project(store: State<'_, Arc<Store>>, project: Project) -> Result<(), String> {
    store.upsert_project(project)
}

#[tauri::command]
pub async fn delete_project(store: State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    store.delete_project(&id)
}

#[tauri::command]
pub async fn ensure_project_dirs(
    store: State<'_, Arc<Store>>,
    path: Option<String>,
    name: String,
) -> Result<String, String> {
    store.ensure_project_dirs(path.as_deref(), &name)
}

#[tauri::command]
pub async fn sessions_get(
    store: State<'_, Arc<Store>>,
    project_id: String,
) -> Result<Vec<ChatSession>, String> {
    store.sessions_get(&project_id)
}

#[tauri::command]
pub async fn session_upsert(
    store: State<'_, Arc<Store>>,
    project_id: String,
    session: ChatSession,
) -> Result<(), String> {
    store.session_upsert(&project_id, session)
}

#[tauri::command]
pub async fn set_server_locked(
    store: State<'_, Arc<Store>>,
    id: String,
    locked: bool,
) -> Result<(), String> {
    store.set_server_locked(&id, locked)
}

#[tauri::command]
pub async fn save_db_connection(
    store: State<'_, Arc<Store>>,
    server_id: String,
    connection: DbConnection,
    password: Option<String>,
) -> Result<(), String> {
    store.save_db_connection(&server_id, connection, password.as_deref())
}

#[tauri::command]
pub async fn delete_db_connection(
    store: State<'_, Arc<Store>>,
    server_id: String,
    conn_id: String,
) -> Result<(), String> {
    store.delete_db_connection(&server_id, &conn_id)
}

#[tauri::command]
pub async fn create_project_folder(
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<(), String> {
    store.create_project_folder(&name)
}

#[tauri::command]
pub async fn rename_project_folder(
    store: State<'_, Arc<Store>>,
    old: String,
    new: String,
) -> Result<(), String> {
    store.rename_project_folder(&old, &new)
}

#[tauri::command]
pub async fn delete_project_folder(
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<(), String> {
    store.delete_project_folder(&name)
}

#[tauri::command]
pub async fn delete_folder_with_projects(
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<usize, String> {
    store.delete_folder_with_projects(&name)
}

#[tauri::command]
pub async fn create_command_folder(
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<(), String> {
    store.create_command_folder(&name)
}

#[tauri::command]
pub async fn rename_command_folder(
    store: State<'_, Arc<Store>>,
    old: String,
    new: String,
) -> Result<(), String> {
    store.rename_command_folder(&old, &new)
}

#[tauri::command]
pub async fn delete_command_folder(
    store: State<'_, Arc<Store>>,
    name: String,
) -> Result<(), String> {
    store.delete_command_folder(&name)
}

#[tauri::command]
pub async fn set_ui_expanded(
    store: State<'_, Arc<Store>>,
    key: String,
    values: Vec<String>,
) -> Result<(), String> {
    store.set_ui_expanded(key, values)
}

#[tauri::command]
pub async fn set_sftp_history(
    store: State<'_, Arc<Store>>,
    server_id: String,
    paths: Vec<String>,
) -> Result<(), String> {
    store.set_sftp_history(server_id, paths)
}

#[tauri::command]
pub async fn set_sftp_favorites(
    store: State<'_, Arc<Store>>,
    server_id: String,
    favorites: Vec<SftpFavorite>,
) -> Result<(), String> {
    store.set_sftp_favorites(server_id, favorites)
}

#[tauri::command]
pub async fn clear_unreferenced_servers(
    store: State<'_, Arc<Store>>,
    mcp: State<'_, Arc<crate::mcp::McpService>>,
) -> Result<usize, String> {
    let removed = store.clear_unreferenced_servers()?;
    // 被清理服务器的设备配置已移除，按剩余设备同步 MCP 监听。
    mcp.sync().await;
    Ok(removed)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一个独立的临时配置目录（按 pid+tag 命名，测试间不冲突；不触碰真实用户配置）。
    fn temp_config_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aishell-store-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn credential_test_server(id: &str, host: &str) -> Server {
        Server {
            id: id.to_string(),
            name: format!("服务器-{id}"),
            host: host.to_string(),
            port: 22,
            auth_type: AuthType::Password,
            username: "deploy".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        }
    }

    fn test_chat_msg(role: &str, content: &str) -> ChatMsg {
        ChatMsg {
            role: role.to_string(),
            content: content.to_string(),
            snapshots: vec![],
            file_refs: vec![],
            server_refs: vec![],
            path_refs: vec![],
            browser_refs: vec![],
            browser_page_refs: vec![],
            skill_refs: vec![],
            note_refs: vec![],
            image_refs: vec![],
            actions: vec![],
            ts: 1,
        }
    }

    fn sample_state() -> AppState {
        AppState {
            settings: Settings {
                workspace_dir: Some("D:\\AIShellWorkspace".to_string()),
                llm: LlmConfig::default(),
                search: SearchConfig::default(),
                theme: Theme::Dark,
                auto_switch_ai_workdir: true,
                project_view: ProjectView::Card,
                approval_mode: ApprovalMode::Smart,
                auto_backup_remote_files: true,
                compact_server_list: false,
            },
            credentials: vec![
                Credential {
                    id: "credential-srv-1".to_string(),
                    name: "deploy@47.102.118.66".to_string(),
                    auth_type: AuthType::Password,
                    username: "deploy".to_string(),
                    key_path: String::new(),
                },
                Credential {
                    id: "credential-srv-2".to_string(),
                    name: "ubuntu@192.168.10.21".to_string(),
                    auth_type: AuthType::Key,
                    username: "ubuntu".to_string(),
                    key_path: "C:\\Users\\demo\\.ssh\\id_ed25519".to_string(),
                },
            ],
            servers: vec![
                Server {
                    id: "srv-1".to_string(),
                    name: "生产-Web-01".to_string(),
                    host: "47.102.118.66".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "deploy".to_string(),
                    key_path: String::new(),
                    credential_id: Some("credential-srv-1".to_string()),
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                Server {
                    id: "srv-2".to_string(),
                    name: "测试-K8s-Node".to_string(),
                    host: "192.168.10.21".to_string(),
                    port: 2222,
                    auth_type: AuthType::Key,
                    username: "ubuntu".to_string(),
                    key_path: "C:\\Users\\demo\\.ssh\\id_ed25519".to_string(),
                    credential_id: Some("credential-srv-2".to_string()),
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
            ],
            projects: vec![Project {
                id: "proj-1".to_string(),
                name: "AIShell 主仓库".to_string(),
                path: Some("D:\\projects\\AIShell2".to_string()),
                server_ids: vec!["srv-1".to_string(), "srv-2".to_string()],
                quick_commands: vec![QuickCommand {
                    id: "qc-1".to_string(),
                    title: "查看 Git 状态".to_string(),
                    command: "git status && git log --oneline -5".to_string(),
                    folder: "常用".to_string(),
                    global: true,
                }],
                folder: "生产环境".to_string(),
                ai_mode: AiMode::Suggest,
            }],
            sessions: {
                let mut m = HashMap::new();
                m.insert(
                    "proj-1".to_string(),
                    vec![ChatSession {
                        id: "sess-1".to_string(),
                        title: "会话一".to_string(),
                        auto_title_triggered: false,
                    archived: false,
                        messages: vec![ChatMsg {
                            role: "user".to_string(),
                            content: "看看日志".to_string(),
                            snapshots: vec![TermSnapshot {
                                id: "snap-1".to_string(),
                                command: "tail -20 app.log".to_string(),
                                content: "INFO ...".to_string(),
                                ts: 1_752_000_000_000,
                            }],
                            file_refs: vec![FileRef {
                                id: "ref-1".to_string(),
                                path: "C:/demo/app.ts".to_string(),
                                start_line: 3,
                                end_line: 7,
                                content: "const a = 1;".to_string(),
                                ts: 1_752_000_000_001,
                            }],
                            server_refs: vec![ServerRef {
                                server_id: Some("srv-1".to_string()),
                                name: "生产-Web-01".to_string(),
                            }],
                            path_refs: vec![PathRef {
                                path: "C:/demo/app.ts".to_string(),
                                is_dir: false,
                                server_id: None,
                            }],
                            browser_refs: vec![BrowserRef {
                                name: "#login-btn".to_string(),
                                tag_name: "button".to_string(),
                                element_id: "login-btn".to_string(),
                                url: "https://example.com/login".to_string(),
                                title: "登录".to_string(),
                                outer_html: r#"<button id="login-btn">登录</button>"#.to_string(),
                                ts: 1_752_000_000_002,
                            }],
                            browser_page_refs: vec![BrowserPageRef {
                                url: "http://localhtml.localhost/C:/x/console.html".to_string(),
                                title: "控制台".to_string(),
                                ts: 1_752_000_000_004,
                            }],
                            skill_refs: vec![SkillRef {
                                name: "code-review".to_string(),
                                origin: "project".to_string(),
                                scope: vec!["all".to_string()],
                                description: "代码审查".to_string(),
                            }],
                            note_refs: vec![NoteRef {
                                id: "note-1".to_string(),
                                path: "D:/AIShellWorkspace/.aishell/notes/deploy.md"
                                    .to_string(),
                                name: "deploy".to_string(),
                            }],
                            image_refs: vec![ImageRef {
                                id: "img-1".to_string(),
                                source: "clipboard".to_string(),
                                name: "截图.png".to_string(),
                                mime: "image/png".to_string(),
                                path: "D:/demo/.aishell/ai-images/1752000000000_截图.png"
                                    .to_string(),
                                origin_path: None,
                                server_id: None,
                                size: 4096,
                                ts: 1_752_000_000_003,
                            }],
                            actions: vec![AiActionRecord {
                                tool_call_id: "call-1".to_string(),
                                tool: "run_command".to_string(),
                                intent: "查看版本".to_string(),
                                summary: "执行命令：node -v".to_string(),
                                status: "succeeded".to_string(),
                                timeout_seconds: Some(10),
                                text_len: Some(160),
                            }],
                            ts: 1_752_000_000_001,
                        }],
                    }],
                );
                m
            },
            project_folders: vec!["生产环境".to_string()],
            command_folders: vec!["常用".to_string()],
            ui_expanded: HashMap::new(),
            sftp_history: HashMap::new(),
            sftp_favorites: HashMap::new(),
            browser_history: Vec::new(),
            db_connections: HashMap::new(),
            mcp: McpServiceConfig::default(),
            mcp_devices: {
                let mut m = HashMap::new();
                m.insert(
                    "srv-1".to_string(),
                    McpDeviceConfig {
                        enabled: true,
                        features: McpFeatures {
                            sftp_list: true,
                            file_read: true,
                            exec: true,
                            db_query: true,
                            ..Default::default()
                        },
                    },
                );
                m
            },
            // 与 settings.workspace_dir 一致：reload 时视为已播种（不创建 D:\AIShellWorkspace，不破坏往返相等）。
            // 记录值必须带当前播种代际标记（裸 workspace 是 gen1 旧记录，会触发补种写盘）
            seeded_skill_workspaces: vec![seed_marker("D:\\AIShellWorkspace")],
            trace_enabled: false,
            ssh_tunnels: vec![],
        }
    }

    #[test]
    fn state_json_uses_camelcase_field_names() {
        let json = serde_json::to_string(&sample_state()).unwrap();
        for key in [
            "\"serverIds\"",
            "\"quickCommands\"",
            "\"workspaceDir\"",
            "\"modelId\"",
            "\"baseUrl\"",
            "\"effort\"",
            "\"authType\"",
            "\"keyPath\"",
            "\"aiMode\"",
            "\"locked\"",
            "\"isBastion\"",
            "\"bastionId\"",
            "\"toolCallId\"",
            "\"projectFolders\"",
            "\"commandFolders\"",
            "\"uiExpanded\"",
            "\"sftpHistory\"",
            "\"sftpFavorites\"",
            "\"global\"",
            "\"serverRefs\"",
            "\"autoSwitchAiWorkdir\"",
            "\"projectView\"",
            "\"seededSkillWorkspaces\"",
            "\"mcp\"",
            "\"mcpDevices\"",
            "\"sftpList\"",
            "\"fileRead\"",
            "\"dbQuery\"",
        ] {
            assert!(json.contains(key), "序列化 JSON 缺少字段 {key}: {json}");
        }
        // 往返一致（含嵌套 sessions / snapshots / actions）
        let back: AppState = serde_json::from_str(&json).unwrap();
        assert_eq!(back, sample_state());
    }

    #[test]
    fn default_state_matches_spec() {
        let dir = temp_config_dir("default");
        let store = test_store(dir);
        let guard = store.state.lock().unwrap();
        assert_eq!(guard.settings.workspace_dir, None);
        assert_eq!(guard.settings.llm.model_id, "deepseek-v4-flash-vision-exp");
        assert_eq!(guard.settings.llm.base_url, "https://api.deepseek.com/v1");
        assert_eq!(guard.settings.llm.effort, Effort::Low);
        assert!(guard.servers.is_empty());
        assert!(guard.projects.is_empty());
        assert!(guard.sessions.is_empty());
        drop(guard);
        // 默认 state 序列化后仍是合法 camelCase 文件
        assert!(!store.is_config_complete());
    }

    #[test]
    fn store_roundtrips_state_to_disk() {
        let dir = temp_config_dir("roundtrip");
        {
            let store = test_store(dir.clone());
            store
                .with_state(|s| {
                    *s = sample_state();
                    Ok(())
                })
                .unwrap();
            assert!(dir.join("aishell.json").is_file());
            assert!(
                !dir.join("aishell.json.tmp").exists(),
                "临时文件应已被 rename 掉"
            );
        }
        let reloaded = test_store(dir);
        let guard = reloaded.state.lock().unwrap();
        assert_eq!(*guard, sample_state());
    }

    #[test]
    fn is_config_complete_reflects_workspace_dir() {
        let dir = temp_config_dir("complete");
        let ws = temp_config_dir("complete-ws");
        let store = test_store(dir);
        assert!(!store.is_config_complete());
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        assert!(store.is_config_complete());
    }

    #[test]
    fn theme_persists_and_legacy_json_defaults_dark() {
        let dir = temp_config_dir("theme");
        let store = test_store(dir.clone());
        assert_eq!(store.state.lock().unwrap().settings.theme, Theme::Dark);
        store.set_theme(Theme::Light).unwrap();
        let store2 = test_store(dir);
        assert_eq!(store2.state.lock().unwrap().settings.theme, Theme::Light);
        // 旧配置 JSON 无 theme 字段:serde default 按深色解析
        let legacy: Settings = serde_json::from_str(
            r#"{"workspaceDir":null,"llm":{"modelId":"m","baseUrl":"u","effort":"medium"}}"#,
        )
        .unwrap();
        assert_eq!(legacy.theme, Theme::Dark);
        // 旧档位 medium 兼容映射为 low（v4 系列无 medium 档）
        assert_eq!(legacy.llm.effort, Effort::Low);
    }

    #[test]
    fn ensure_project_dirs_with_explicit_path() {
        let dir = temp_config_dir("ensure-path");
        let store = test_store(dir);
        let base = std::env::temp_dir().join(format!(
            "aishell-store-test-explicit-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&base);

        let result = store
            .ensure_project_dirs(Some(base.to_str().unwrap()), "ignored")
            .unwrap();
        assert_eq!(PathBuf::from(&result), base);
        assert!(base.join(".aishell").is_dir());
        // 目录已存在不报错
        let again = store
            .ensure_project_dirs(Some(base.to_str().unwrap()), "ignored")
            .unwrap();
        assert_eq!(again, result);
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn ensure_project_dirs_falls_back_to_workspace() {
        let dir = temp_config_dir("ensure-ws");
        let store = test_store(dir);
        let ws = std::env::temp_dir().join(format!("aishell-store-test-ws-{}", std::process::id()));
        let _ = fs::remove_dir_all(&ws);
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();

        let result = store.ensure_project_dirs(None, "my-proj").unwrap();
        let expected = ws.join("my-proj");
        assert_eq!(PathBuf::from(&result), expected);
        assert!(expected.join(".aishell").is_dir());
        // 幂等
        let again = store.ensure_project_dirs(None, "my-proj").unwrap();
        assert_eq!(again, result);
        let _ = fs::remove_dir_all(&ws);
    }

    #[test]
    fn ensure_project_dirs_requires_workspace() {
        let dir = temp_config_dir("ensure-nows");
        let store = test_store(dir);
        let err = store.ensure_project_dirs(None, "x").unwrap_err();
        assert!(
            err.contains("请先在设置中配置工作区目录"),
            "错误串不符: {err}"
        );
    }

    #[test]
    fn delete_server_cascades_and_keeps_reusable_credential() {
        let dir = temp_config_dir("cascade");
        let store = test_store(dir);
        store
            .upsert_server(
                Server {
                    id: "srv-c-1".to_string(),
                    name: "A".to_string(),
                    host: "h1".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "u".to_string(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                Some("pw-1"),
            )
            .unwrap();
        store
            .upsert_server(
                Server {
                    id: "srv-c-2".to_string(),
                    name: "B".to_string(),
                    host: "h2".to_string(),
                    port: 22,
                    auth_type: AuthType::Key,
                    username: "u".to_string(),
                    key_path: "C:\\key".to_string(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                None,
            )
            .unwrap();
        store
            .upsert_project(Project {
                id: "proj-c-1".to_string(),
                name: "P".to_string(),
                path: None,
                server_ids: vec!["srv-c-1".to_string(), "srv-c-2".to_string()],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();

        // 删除前凭据库与服务器附属配置确实存在。
        let deleted_server = store.server("srv-c-1").unwrap();
        assert_eq!(store.read_server_secret(&deleted_server).unwrap(), "pw-1");
        store
            .save_db_connection(
                "srv-c-1",
                DbConnection {
                    id: "db-c-1".to_string(),
                    name: "DB".to_string(),
                    kind: DbKind::Mysql,
                    host: "127.0.0.1".to_string(),
                    port: 3306,
                    user: "root".to_string(),
                    database: String::new(),
                    allowed_commands: Vec::new(),
                    enabled: true,
                },
                Some("db-password"),
            )
            .unwrap();
        store
            .with_state(|state| {
                state.sftp_history.insert("srv-c-1".to_string(), vec!["/tmp".to_string()]);
                state.sftp_favorites.insert(
                    "srv-c-1".to_string(),
                    vec![SftpFavorite { path: "/var".to_string(), title: "var".to_string() }],
                );
                state.mcp_devices.insert("srv-c-1".to_string(), McpDeviceConfig::default());
                Ok(())
            })
            .unwrap();

        store.delete_server("srv-c-1").unwrap();

        let guard = store.state.lock().unwrap();
        assert_eq!(guard.servers.len(), 1);
        assert_eq!(guard.servers[0].id, "srv-c-2");
        assert_eq!(guard.projects[0].server_ids, vec!["srv-c-2".to_string()]);
        assert!(!guard.sftp_history.contains_key("srv-c-1"));
        assert!(!guard.sftp_favorites.contains_key("srv-c-1"));
        assert!(!guard.mcp_devices.contains_key("srv-c-1"));
        assert!(!guard.db_connections.contains_key("srv-c-1"));
        drop(guard);
        assert!(store.db_secret("srv-c-1", "db-c-1").is_err());
        // 删除服务器只解除引用，可复用凭据及其密码仍由凭据库管理。
        assert_eq!(store.read_server_secret(&deleted_server).unwrap(), "pw-1");
        // 删除不存在的服务器不算错
        store.delete_server("srv-c-404").unwrap();
    }

    #[test]
    fn server_save_result_uses_frontend_camel_case_contract() {
        let value = serde_json::to_value(ServerSaveResult::NeedsChoice {
            credential_name: "共享凭据".to_string(),
            reference_count: 2,
        })
        .unwrap();

        assert_eq!(value["status"], "needsChoice");
        assert_eq!(value["credentialName"], "共享凭据");
        assert_eq!(value["referenceCount"], 2);
        assert!(value.get("credential_name").is_none());
        assert!(value.get("reference_count").is_none());
    }

    #[test]
    fn shared_credential_ask_update_and_fork_are_consistent() {
        let dir = temp_config_dir("shared-credential");
        let store = test_store(dir);
        let first = credential_test_server("srv-a", "10.0.0.1");
        store.upsert_server(first.clone(), Some("old-password")).unwrap();
        let first = store.server("srv-a").unwrap();
        let credential_id = first.credential_id.clone().unwrap();

        let mut second = credential_test_server("srv-b", "10.0.0.2");
        second.credential_id = Some(credential_id.clone());
        let saved = store
            .save_server_with_credential(second, None, CredentialSaveMode::Ask)
            .unwrap();
        assert!(matches!(saved, ServerSaveResult::Saved { .. }));

        let mut changed = store.server("srv-a").unwrap();
        changed.username = "root".to_string();
        let result = store
            .save_server_with_credential(
                changed.clone(),
                Some("new-password"),
                CredentialSaveMode::Ask,
            )
            .unwrap();
        assert!(matches!(
            result,
            ServerSaveResult::NeedsChoice {
                reference_count: 2,
                ..
            }
        ));
        assert_eq!(store.server("srv-a").unwrap().username, "deploy");
        assert_eq!(store.read_server_secret(&first).unwrap(), "old-password");

        let updated = store
            .save_server_with_credential(
                changed.clone(),
                Some("new-password"),
                CredentialSaveMode::Update,
            )
            .unwrap();
        assert!(matches!(updated, ServerSaveResult::Saved { .. }));
        assert!(store
            .servers_all()
            .iter()
            .filter(|server| server.credential_id.as_deref() == Some(&credential_id))
            .all(|server| server.username == "root"));
        assert_eq!(
            store.read_server_secret(&store.server("srv-b").unwrap()).unwrap(),
            "new-password"
        );

        let mut forked = store.server("srv-a").unwrap();
        forked.username = "release".to_string();
        let result = store
            .save_server_with_credential(forked, None, CredentialSaveMode::Fork)
            .unwrap();
        let ServerSaveResult::Saved { server: forked } = result else {
            panic!("fork 应保存服务器");
        };
        assert_ne!(forked.credential_id.as_deref(), Some(credential_id.as_str()));
        assert_eq!(store.read_server_secret(&forked).unwrap(), "new-password");
        assert_eq!(store.server("srv-b").unwrap().username, "root");
    }

    #[test]
    fn legacy_server_credentials_migrate_once_without_exposing_password() {
        let dir = temp_config_dir("credential-migration");
        let mut state = AppState::default();
        state
            .servers
            .push(credential_test_server("srv-legacy", "10.0.0.9"));
        fs::write(
            dir.join(STATE_FILE),
            serde_json::to_string_pretty(&state).unwrap(),
        )
        .unwrap();
        let secrets = std::sync::Arc::new(MemorySecrets::default());
        secrets.set("server:srv-legacy", "legacy-password").unwrap();

        let store = Store::with_secrets(dir.clone(), secrets.clone()).unwrap();
        let migrated = store.server("srv-legacy").unwrap();
        assert_eq!(
            migrated.credential_id.as_deref(),
            Some("credential-srv-legacy")
        );
        assert_eq!(store.credentials_all().len(), 1);
        assert_eq!(store.read_server_secret(&migrated).unwrap(), "legacy-password");
        assert!(secrets.get("server:srv-legacy").is_err());
        let json = fs::read_to_string(dir.join(STATE_FILE)).unwrap();
        assert!(!json.contains("legacy-password"));
        drop(store);

        let reloaded = Store::with_secrets(dir, secrets).unwrap();
        assert_eq!(reloaded.credentials_all().len(), 1);
        assert_eq!(
            reloaded
                .server("srv-legacy")
                .unwrap()
                .credential_id
                .as_deref(),
            Some("credential-srv-legacy")
        );
    }

    #[test]
    fn credential_delete_requires_no_references_and_server_delete_keeps_it() {
        let dir = temp_config_dir("credential-delete");
        let store = test_store(dir);
        store
            .upsert_server(
                credential_test_server("srv-delete", "10.0.0.3"),
                Some("password"),
            )
            .unwrap();
        let server = store.server("srv-delete").unwrap();
        let credential_id = server.credential_id.clone().unwrap();
        assert!(store.delete_credential(&credential_id).is_err());

        store.delete_server("srv-delete").unwrap();
        assert!(store.credentials_all().iter().any(|item| item.id == credential_id));
        assert_eq!(store.read_server_secret(&server).unwrap(), "password");
        store.delete_credential(&credential_id).unwrap();
        assert!(store.credentials_all().iter().all(|item| item.id != credential_id));
        assert!(store.read_server_secret(&server).is_err());
    }

    #[test]
    fn clear_unreferenced_credentials_removes_metadata_and_secrets() {
        let dir = temp_config_dir("credential-clear");
        let store = test_store(dir);
        store
            .upsert_server(
                credential_test_server("srv-keep-credential", "10.0.0.10"),
                Some("keep-password"),
            )
            .unwrap();
        let kept_server = store.server("srv-keep-credential").unwrap();
        let kept_id = kept_server.credential_id.clone().unwrap();
        store
            .upsert_credential(
                Credential {
                    id: "credential-orphan-password".to_string(),
                    name: "孤儿密码".to_string(),
                    auth_type: AuthType::Password,
                    username: "orphan".to_string(),
                    key_path: String::new(),
                },
                Some("orphan-password"),
            )
            .unwrap();
        store
            .upsert_credential(
                Credential {
                    id: "credential-orphan-key".to_string(),
                    name: "孤儿密钥".to_string(),
                    auth_type: AuthType::Key,
                    username: "orphan".to_string(),
                    key_path: "C:\\orphan-key".to_string(),
                },
                None,
            )
            .unwrap();

        assert_eq!(store.clear_unreferenced_credentials().unwrap(), 2);
        assert_eq!(store.credentials_all().len(), 1);
        assert_eq!(store.credentials_all()[0].id, kept_id);
        assert_eq!(store.read_server_secret(&kept_server).unwrap(), "keep-password");
        assert!(store
            .secrets
            .get(&keyring_account_credential("credential-orphan-password"))
            .is_err());
        assert!(store
            .secrets
            .get(&keyring_account_credential("credential-orphan-key"))
            .is_err());
        assert_eq!(store.clear_unreferenced_credentials().unwrap(), 0);

        store.delete_server("srv-keep-credential").unwrap();
        assert_eq!(store.clear_unreferenced_credentials().unwrap(), 1);
        assert!(store.credentials_all().is_empty());
        assert!(store.read_server_secret(&kept_server).is_err());
    }

    #[test]
    fn upsert_credential_adopts_external_key_into_workspace() {
        let config = temp_config_dir("adopt-cred");
        let workspace = config.parent().unwrap().join("adopt-cred-ws");
        let store = test_store(config.clone());
        store
            .with_candidate_state(|state| {
                state.settings.workspace_dir = Some(workspace.to_string_lossy().into_owned());
                Ok(())
            })
            .unwrap();
        let external = config.join("origin-key");
        fs::write(&external, "-----BEGIN OPENSSH PRIVATE KEY-----\nk1\n-----\n").unwrap();

        let credential = Credential {
            id: "c1".into(),
            name: "c".into(),
            auth_type: AuthType::Key,
            username: "u".into(),
            key_path: external.to_string_lossy().into_owned(),
        };
        store.upsert_credential(credential, None).unwrap();
        let stored = store.credentials_all().remove(0);
        let expected_name =
            crate::ssh_keys::key_file_name_for_content(&fs::read(&external).unwrap());
        let expected_path = crate::ssh_keys::managed_key_dir(&workspace.to_string_lossy())
            .join(expected_name);
        // key_path 已改写为 workspace 保管路径，内容与原文件一致，原文件保持不动（复制而非移动）。
        assert_eq!(stored.key_path, expected_path.to_string_lossy());
        assert_eq!(fs::read(&stored.key_path).unwrap(), fs::read(&external).unwrap());
        assert!(external.exists());

        // 再次保存（key_path 已是保管路径）→ 幂等，不再改名复制。
        store.upsert_credential(stored.clone(), None).unwrap();
        assert_eq!(store.credentials_all()[0].key_path, stored.key_path);
        let _ = fs::remove_dir_all(&config);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn upsert_server_adopts_key_and_mirrors_to_credential() {
        let config = temp_config_dir("adopt-srv");
        let workspace = config.parent().unwrap().join("adopt-srv-ws");
        let store = test_store(config.clone());
        store
            .with_candidate_state(|state| {
                state.settings.workspace_dir = Some(workspace.to_string_lossy().into_owned());
                Ok(())
            })
            .unwrap();
        let external = config.join("srv-key");
        fs::write(&external, "SERVER-KEY-CONTENT").unwrap();

        let mut server = credential_test_server("srv-key1", "10.0.0.1");
        server.auth_type = AuthType::Key;
        server.key_path = external.to_string_lossy().into_owned();
        store.upsert_server(server, None).unwrap();

        let saved = store.server("srv-key1").unwrap();
        let credential_id = saved.credential_id.expect("密钥服务器保存后必有关联凭据");
        let credential = store
            .credentials_all()
            .into_iter()
            .find(|c| c.id == credential_id)
            .unwrap();
        assert!(saved.key_path.starts_with(
            crate::ssh_keys::managed_key_dir(&workspace.to_string_lossy())
                .to_string_lossy()
                .as_ref()
        ));
        assert_eq!(credential.key_path, saved.key_path);
        assert_eq!(fs::read(&saved.key_path).unwrap(), b"SERVER-KEY-CONTENT");
        let _ = fs::remove_dir_all(&config);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn adopt_managed_ssh_keys_migrates_credentials_and_servers() {
        let config = temp_config_dir("adopt-migrate");
        let workspace = config.parent().unwrap().join("adopt-migrate-ws");
        let mut state = AppState::default();
        state.settings.workspace_dir = Some(workspace.to_string_lossy().into_owned());

        let external_credential_key = config.join("cred-key");
        fs::write(&external_credential_key, "CRED-KEY").unwrap();
        let external_server_key = config.join("srv-key");
        fs::write(&external_server_key, "SRV-KEY").unwrap();

        state.credentials.push(Credential {
            id: "c1".into(),
            name: "c1".into(),
            auth_type: AuthType::Key,
            username: "u".into(),
            key_path: external_credential_key.to_string_lossy().into_owned(),
        });
        state.credentials.push(Credential {
            id: "c2".into(),
            name: "c2".into(),
            auth_type: AuthType::Key,
            username: "u".into(),
            key_path: String::new(),
        });
        let mut password_server = credential_test_server("s3", "10.0.0.3");
        password_server.credential_id = Some("c1".into());
        state.servers.push(Server {
            id: "s1".into(),
            name: "s1".into(),
            host: "h".into(),
            port: 22,
            auth_type: AuthType::Key,
            username: "u".into(),
            key_path: external_credential_key.to_string_lossy().into_owned(),
            credential_id: Some("c1".into()),
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        });
        state.servers.push(Server {
            id: "s2".into(),
            name: "s2".into(),
            host: "h".into(),
            port: 22,
            auth_type: AuthType::Key,
            username: "u".into(),
            key_path: external_server_key.to_string_lossy().into_owned(),
            credential_id: Some("c2".into()),
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        });
        state.servers.push(password_server);

        // c1 收编(1) + s1 镜像(1) + s2 就地收编并回写 c2(1)。
        assert_eq!(adopt_managed_ssh_keys(&mut state), 3);
        let managed_dir = crate::ssh_keys::managed_key_dir(&workspace.to_string_lossy());
        let c1 = state.credentials.iter().find(|c| c.id == "c1").unwrap();
        let c2 = state.credentials.iter().find(|c| c.id == "c2").unwrap();
        let s1 = state.servers.iter().find(|s| s.id == "s1").unwrap();
        let s2 = state.servers.iter().find(|s| s.id == "s2").unwrap();
        let s3 = state.servers.iter().find(|s| s.id == "s3").unwrap();
        assert!(c1.key_path.starts_with(managed_dir.to_string_lossy().as_ref()));
        assert_eq!(fs::read(&c1.key_path).unwrap(), b"CRED-KEY");
        assert_eq!(s1.key_path, c1.key_path, "引用服务器镜像凭据保管路径");
        assert_eq!(c2.key_path, s2.key_path, "孤儿服务器密钥收编后回写凭据");
        assert_eq!(fs::read(&s2.key_path).unwrap(), b"SRV-KEY");
        assert!(
            !s3.key_path.starts_with(managed_dir.to_string_lossy().as_ref()),
            "密码服务器不受影响"
        );
        assert!(external_credential_key.exists(), "复制而非移动");
        // 幂等：再跑一遍无变更。
        assert_eq!(adopt_managed_ssh_keys(&mut state), 0);
        let _ = fs::remove_dir_all(&config);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn adopt_managed_ssh_keys_without_workspace_is_noop() {
        let config = temp_config_dir("adopt-no-ws");
        let mut state = AppState::default();
        let key_file = config.join("k");
        fs::write(&key_file, "KEY").unwrap();
        state.credentials.push(Credential {
            id: "c1".into(),
            name: "c1".into(),
            auth_type: AuthType::Key,
            username: "u".into(),
            key_path: key_file.to_string_lossy().into_owned(),
        });
        assert_eq!(adopt_managed_ssh_keys(&mut state), 0);
        assert_eq!(
            state.credentials[0].key_path,
            key_file.to_string_lossy().into_owned()
        );
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn publickey_credential_keeps_dir_and_no_keyring_secret() {
        let config = temp_config_dir("pubkey-cred");
        let workspace = config.parent().unwrap().join("pubkey-cred-ws");
        let store = test_store(config.clone());
        store
            .with_candidate_state(|state| {
                state.settings.workspace_dir = Some(workspace.to_string_lossy().into_owned());
                Ok(())
            })
            .unwrap();
        let key_dir = config.join("keypair-home");
        let credential = Credential {
            id: "pk1".into(),
            name: "pk".into(),
            auth_type: AuthType::PublicKey,
            username: "u".into(),
            key_path: key_dir.to_string_lossy().into_owned(),
        };
        store.upsert_credential(credential, Some("deploy-pwd-passed")).unwrap();
        let stored = store.credentials_all().remove(0);
        // key_path 原样保存(不被收编复制、不指向 .aishell/ssh-key),密码不进 keyring。
        assert_eq!(stored.key_path, key_dir.to_string_lossy());
        assert!(!stored.key_path.starts_with(
            crate::ssh_keys::managed_key_dir(&workspace.to_string_lossy())
                .to_string_lossy()
                .as_ref()
        ));
        assert!(store
            .secrets
            .get(&keyring_account_credential("pk1"))
            .is_err());
        let _ = fs::remove_dir_all(&config);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn save_server_publickey_mirrors_dir_without_adoption() {
        let config = temp_config_dir("pubkey-srv");
        let workspace = config.parent().unwrap().join("pubkey-srv-ws");
        let store = test_store(config.clone());
        store
            .with_candidate_state(|state| {
                state.settings.workspace_dir = Some(workspace.to_string_lossy().into_owned());
                Ok(())
            })
            .unwrap();
        let key_dir = config.join("keypair-home");
        let mut server = credential_test_server("pk-srv", "10.9.9.9");
        server.auth_type = AuthType::PublicKey;
        server.key_path = key_dir.to_string_lossy().into_owned();
        store.upsert_server(server, None).unwrap();

        let saved = store.server("pk-srv").unwrap();
        let credential_id = saved.credential_id.expect("服务器保存后必有关联凭据");
        let credential = store
            .credentials_all()
            .into_iter()
            .find(|c| c.id == credential_id)
            .unwrap();
        // 目录路径镜像到凭据,两端都不被收编,keyring 无密码。
        assert_eq!(saved.key_path, key_dir.to_string_lossy());
        assert_eq!(credential.auth_type, AuthType::PublicKey);
        assert_eq!(credential.key_path, saved.key_path);
        assert!(store.secrets.get(&keyring_account_credential(&credential_id)).is_err());
        let _ = fs::remove_dir_all(&config);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn adopt_managed_ssh_keys_ignores_publickey() {
        let config = temp_config_dir("adopt-pubkey");
        let workspace = config.parent().unwrap().join("adopt-pubkey-ws");
        let mut state = AppState::default();
        state.settings.workspace_dir = Some(workspace.to_string_lossy().into_owned());
        let key_dir = config.join("keypair-home");
        state.credentials.push(Credential {
            id: "c1".into(),
            name: "c1".into(),
            auth_type: AuthType::PublicKey,
            username: "u".into(),
            key_path: key_dir.to_string_lossy().into_owned(),
        });
        assert_eq!(adopt_managed_ssh_keys(&mut state), 0);
        assert_eq!(
            state.credentials[0].key_path,
            key_dir.to_string_lossy().into_owned()
        );
        let _ = fs::remove_dir_all(&config);
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn tunnel_crud_roundtrip_and_old_config_compat() {
        let config = temp_config_dir("tunnel-crud");
        let store = test_store(config.clone());
        // 触发一次写盘（test_store 起于内存态，save_tunnel 首次落盘）。
        let cfg = crate::tunnel::TunnelConfig {
            id: "t1".into(),
            server_id: "s1".into(),
            name: "db".into(),
            kind: crate::tunnel::TunnelKind::Local,
            bind_addr: "127.0.0.1".into(),
            local_port: 3307,
            target_host: "".into(),
            target_port: 3306,
            enabled: true,
        };
        store.save_tunnel(cfg.clone()).unwrap();
        // 旧配置无 ssh_tunnels 字段 → 空列表（serde default 兼容）。
        let state_path = config.join(STATE_FILE);
        let sample = fs::read(&state_path).expect("save_tunnel 后应有配置文件");
        let mut value: serde_json::Value = serde_json::from_slice(&sample).unwrap();
        value.as_object_mut().unwrap().remove("sshTunnels");
        fs::write(&state_path, serde_json::to_vec(&value).unwrap()).unwrap();
        let reloaded = test_store(config.clone());
        assert!(reloaded.tunnels_all().is_empty());

        let mut all = store.tunnels_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0], cfg);
        // upsert 同 id 更新。
        let mut updated = cfg.clone();
        updated.local_port = 3308;
        store.save_tunnel(updated.clone()).unwrap();
        all = store.tunnels_all();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0], updated);
        // 删除。
        store.delete_tunnel("t1").unwrap();
        assert!(store.tunnels_all().is_empty());
        // 重启（Store 从磁盘读）仍一致。
        store.save_tunnel(cfg.clone()).unwrap();
        let store2 = test_store(config.clone());
        assert_eq!(store2.tunnels_all()[0], cfg);
        let _ = fs::remove_dir_all(&config);
    }

    #[test]
    fn upsert_server_updates_in_place() {
        let dir = temp_config_dir("upsert");
        let store = test_store(dir);
        let base = Server {
            id: "srv-u".to_string(),
            name: "旧名".to_string(),
            host: "h".to_string(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        };
        store.upsert_server(base.clone(), None).unwrap();
        let mut updated = base;
        updated.name = "新名".to_string();
        store.upsert_server(updated.clone(), None).unwrap();

        let guard = store.state.lock().unwrap();
        assert_eq!(guard.servers.len(), 1, "同 id 应原地更新而非追加");
        assert_eq!(guard.servers[0].name, "新名");
    }

    #[test]
    fn upsert_rejects_invalid_bastion_bindings() {
        let dir = temp_config_dir("bastion-bind");
        let store = test_store(dir);
        let base = Server {
            id: "srv-b".to_string(),
            name: "堡垒机".to_string(),
            host: "h".to_string(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: true,
            bastion_id: None,
            tags: Vec::new(),
        };
        store.upsert_server(base.clone(), None).unwrap();

        // 一台服务器不能同时是堡垒机又是目标主机
        let both = Server {
            bastion_id: Some("srv-b".to_string()),
            tags: Vec::new(),
            ..base.clone()
        };
        let err = store.upsert_server(both, None).unwrap_err();
        assert!(
            err.contains("不能同时作为堡垒机与目标主机"),
            "错误串不符: {err}"
        );

        // 目标主机的堡垒机必须已开启堡垒机功能
        let target_ok = Server {
            id: "srv-t".to_string(),
            name: "目标机".to_string(),
            host: "10.0.0.2".to_string(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: Some("srv-b".to_string()),
            tags: Vec::new(),
        };
        store.upsert_server(target_ok, None).unwrap();
        // 未开启堡垒机的服务器不能作堡垒机引用
        let plain = Server {
            id: "srv-p".to_string(),
            name: "普通机".to_string(),
            host: "h".to_string(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        };
        store.upsert_server(plain.clone(), None).unwrap();
        let bad_ref = Server {
            id: "srv-t2".to_string(),
            name: "目标2".to_string(),
            host: "h".to_string(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: Some("srv-p".to_string()),
            tags: Vec::new(),
        };
        let err = store.upsert_server(bad_ref, None).unwrap_err();
        assert!(err.contains("未开启堡垒机功能"), "错误串不符: {err}");
        // 不存在的堡垒机
        let ghost = Server {
            id: "srv-t3".to_string(),
            name: "目标3".to_string(),
            host: "h".to_string(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: Some("srv-ghost".to_string()),
            tags: Vec::new(),
        };
        let err = store.upsert_server(ghost, None).unwrap_err();
        assert!(err.contains("不存在或未开启"), "错误串不符: {err}");

        // 合法绑定在 state 里完整保存
        assert_eq!(
            store.server("srv-t").unwrap().bastion_id.as_deref(),
            Some("srv-b")
        );
    }

    #[test]
    fn delete_bastion_with_targets_is_blocked() {
        let dir = temp_config_dir("bastion-delete");
        let store = test_store(dir);
        let bastion = Server {
            id: "srv-b".to_string(),
            name: "堡垒机".to_string(),
            host: "h".to_string(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: true,
            bastion_id: None,
            tags: Vec::new(),
        };
        store.upsert_server(bastion, None).unwrap();
        store
            .upsert_server(
                Server {
                    id: "srv-t".to_string(),
                    name: "目标机".to_string(),
                    host: "h".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "u".to_string(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: Some("srv-b".to_string()),
                    tags: Vec::new(),
                },
                Some("pw-t"),
            )
            .unwrap();

        // 有目标主机时删除被拒，state 与 keyring 均不受影响
        let err = store.delete_server("srv-b").unwrap_err();
        assert!(err.contains("SSH跳转设置"), "错误串不符: {err}");
        assert!(store.server("srv-b").is_some(), "拒绝删除时不应动 state");
        assert_eq!(store.read_secret("server:srv-t").unwrap(), "pw-t");

        // 目标主机本身可正常删除（级联解绑项目）
        store.delete_server("srv-t").unwrap();
        assert!(store.server("srv-t").is_none());
        // 目标主机清空后堡垒机可删除
        store.delete_server("srv-b").unwrap();
        assert!(store.server("srv-b").is_none());
    }

    #[test]
    fn create_project_folder_normalizes_and_rejects_invalid() {
        let dir = temp_config_dir("proj-folder-create");
        let store = test_store(dir.clone());
        // 空串 / 纯分隔符 → 中文错误
        assert_eq!(
            store.create_project_folder("  ").unwrap_err(),
            "分类目录名称不能为空"
        );
        assert_eq!(
            store.create_project_folder("///").unwrap_err(),
            "分类目录名称不能为空"
        );
        // 规范化：trim + 去空段；支持层级；嵌套路径自动补建祖先目录
        store.create_project_folder(" 生产环境/Web ").unwrap();
        store.create_project_folder("a//b/").unwrap();
        {
            let guard = store.state.lock().unwrap();
            assert_eq!(
                guard.project_folders,
                vec![
                    "生产环境".to_string(),
                    "生产环境/Web".to_string(),
                    "a".to_string(),
                    "a/b".to_string()
                ]
            );
        }
        // 重名（规范化后相同）报错，且列表不变
        assert_eq!(
            store.create_project_folder("生产环境/Web").unwrap_err(),
            "分类目录已存在"
        );
        assert_eq!(
            store.state.lock().unwrap().project_folders,
            vec![
                "生产环境".to_string(),
                "生产环境/Web".to_string(),
                "a".to_string(),
                "a/b".to_string()
            ]
        );
        // 落盘后重载一致
        let reloaded = test_store(dir);
        assert_eq!(
            reloaded.state.lock().unwrap().project_folders,
            vec![
                "生产环境".to_string(),
                "生产环境/Web".to_string(),
                "a".to_string(),
                "a/b".to_string()
            ]
        );
    }

    #[test]
    fn rename_project_folder_cascades_to_projects() {
        let dir = temp_config_dir("proj-rename-cascade");
        let store = test_store(dir.clone());
        store.create_project_folder("生产环境").unwrap();
        store
            .upsert_project(Project {
                id: "proj-r-1".to_string(),
                name: "A".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![],
                folder: "生产环境".to_string(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();
        store
            .upsert_project(Project {
                id: "proj-r-2".to_string(),
                name: "B".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();

        // 新旧名均按规范化处理：带空白与重复分隔符也应级联生效
        store
            .rename_project_folder("生产环境", " 生产环境//Web ")
            .unwrap();

        let guard = store.state.lock().unwrap();
        // 级联后补建 new 的祖先目录「生产环境」
        assert_eq!(
            guard.project_folders,
            vec!["生产环境/Web".to_string(), "生产环境".to_string()]
        );
        assert_eq!(
            guard
                .projects
                .iter()
                .find(|p| p.id == "proj-r-1")
                .unwrap()
                .folder,
            "生产环境/Web"
        );
        assert_eq!(
            guard
                .projects
                .iter()
                .find(|p| p.id == "proj-r-2")
                .unwrap()
                .folder,
            ""
        );
        drop(guard);
        // 落盘后重载一致
        let reloaded = test_store(dir);
        let guard = reloaded.state.lock().unwrap();
        assert_eq!(
            guard.project_folders,
            vec!["生产环境/Web".to_string(), "生产环境".to_string()]
        );
        assert_eq!(
            guard
                .projects
                .iter()
                .find(|p| p.id == "proj-r-1")
                .unwrap()
                .folder,
            "生产环境/Web"
        );
    }

    #[test]
    fn rename_project_folder_rejects_conflict_and_uncategorized() {
        let dir = temp_config_dir("proj-rename-conflict");
        let store = test_store(dir);
        store.create_project_folder("甲").unwrap();
        store.create_project_folder("乙").unwrap();

        // 未分类（空串）不可重命名
        assert_eq!(
            store.rename_project_folder("", "x").unwrap_err(),
            "未分类目录不可重命名"
        );
        // 目标已存在且 ≠ old → 报错
        assert_eq!(
            store.rename_project_folder("甲", "乙").unwrap_err(),
            "分类目录已存在"
        );
        // new 规范化后为空 → 报错
        assert_eq!(
            store.rename_project_folder("甲", " / ").unwrap_err(),
            "分类目录名称不能为空"
        );
        // new 规范化后与 old 相同 → no-op，列表不变
        store.rename_project_folder("甲", " 甲 ").unwrap();
        let guard = store.state.lock().unwrap();
        assert_eq!(
            guard.project_folders,
            vec!["甲".to_string(), "乙".to_string()]
        );
    }

    #[test]
    fn rename_project_folder_handles_folders_not_in_list() {
        let dir = temp_config_dir("proj-rename-derived");
        let store = test_store(dir.clone());
        // 历史 JSON 里项目的 folder 可能不在 project_folders 清单（upsert 现在会自动注册，
        // 但旧配置不会回溯补录）；重命名同样级联并补入清单
        store
            .with_state(|s| {
                s.projects.push(Project {
                    id: "proj-d-1".to_string(),
                    name: "C".to_string(),
                    path: None,
                    server_ids: vec![],
                    quick_commands: vec![],
                    folder: "旧目录".to_string(),
                    ai_mode: AiMode::Suggest,
                });
                Ok(())
            })
            .unwrap();
        assert!(store.state.lock().unwrap().project_folders.is_empty());

        store.rename_project_folder("旧目录", "新目录").unwrap();

        let guard = store.state.lock().unwrap();
        assert_eq!(guard.projects[0].folder, "新目录");
        assert_eq!(guard.project_folders, vec!["新目录".to_string()]);
    }

    #[test]
    fn delete_project_folder_removes_and_persists() {
        let dir = temp_config_dir("proj-folder-delete");
        let store = test_store(dir.clone());
        store.create_project_folder("生产环境").unwrap();
        store.create_project_folder("开发环境/Web").unwrap();
        // 未分类空串不可删除；规范化后为空同样报中文错误
        assert_eq!(
            store.delete_project_folder("").unwrap_err(),
            "未分类目录不可删除"
        );
        assert_eq!(
            store.delete_project_folder(" / ").unwrap_err(),
            "分类目录名称不能为空"
        );
        // 不存在的目录视为幂等成功
        store.delete_project_folder("不存在的目录").unwrap();
        // 删除成功：入参规范化，仅移除匹配项（祖先目录「开发环境」保留）
        store.delete_project_folder(" 开发环境/Web ").unwrap();
        {
            let guard = store.state.lock().unwrap();
            assert_eq!(
                guard.project_folders,
                vec!["生产环境".to_string(), "开发环境".to_string()]
            );
        }
        // 落盘后重载一致
        let reloaded = test_store(dir);
        assert_eq!(
            reloaded.state.lock().unwrap().project_folders,
            vec!["生产环境".to_string(), "开发环境".to_string()]
        );
    }

    #[test]
    fn delete_project_folder_rejects_when_projects_exist() {
        let dir = temp_config_dir("proj-folder-delete-nonempty");
        let store = test_store(dir.clone());
        store
            .upsert_project(Project {
                id: "proj-f-1".to_string(),
                name: "A".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![],
                folder: "生产环境".to_string(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();
        // 目录下仍有项目 → 中文错误
        let err = store.delete_project_folder("生产环境").unwrap_err();
        assert_eq!(err, "分类目录「生产环境」下仍有项目，不能删除");
        // 目录与项目都未被改动
        let guard = store.state.lock().unwrap();
        assert_eq!(guard.project_folders, vec!["生产环境".to_string()]);
        assert_eq!(guard.projects.len(), 1);
        drop(guard);
        // 删除项目后可删目录，且落盘一致
        store.delete_project("proj-f-1").unwrap();
        store.delete_project_folder("生产环境").unwrap();
        assert!(store.state.lock().unwrap().project_folders.is_empty());
        let reloaded = test_store(dir);
        assert!(reloaded.state.lock().unwrap().project_folders.is_empty());
    }

    #[test]
    fn rename_project_folder_cascades_to_subfolders() {
        let dir = temp_config_dir("proj-rename-prefix");
        let store = test_store(dir);
        store.create_project_folder("华东/浙江省/杭州市").unwrap();
        store
            .upsert_project(Project {
                id: "proj-p-1".to_string(),
                name: "直属".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![],
                folder: "华东".to_string(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();
        store
            .upsert_project(Project {
                id: "proj-p-2".to_string(),
                name: "子级".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![],
                folder: "华东/浙江省".to_string(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();

        store.rename_project_folder("华东", "华南").unwrap();

        let guard = store.state.lock().unwrap();
        // 前缀级联：直属与子分类项目、目录清单全部改写
        assert_eq!(
            guard
                .projects
                .iter()
                .find(|p| p.id == "proj-p-1")
                .unwrap()
                .folder,
            "华南"
        );
        assert_eq!(
            guard
                .projects
                .iter()
                .find(|p| p.id == "proj-p-2")
                .unwrap()
                .folder,
            "华南/浙江省"
        );
        assert_eq!(
            guard.project_folders,
            vec![
                "华南".to_string(),
                "华南/浙江省".to_string(),
                "华南/浙江省/杭州市".to_string()
            ]
        );
    }

    #[test]
    fn delete_folder_with_projects_recurses_and_keeps_servers() {
        let dir = temp_config_dir("proj-folder-batch-delete");
        let store = test_store(dir.clone());
        store.create_project_folder("华东/浙江省").unwrap();
        store
            .upsert_server(
                Server {
                    id: "srv-b-1".into(),
                    name: "留存".into(),
                    host: "10.1.0.1".into(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "root".into(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                None,
            )
            .unwrap();
        let proj = |id: &str, folder: &str| Project {
            id: id.to_string(),
            name: id.to_string(),
            path: None,
            server_ids: vec!["srv-b-1".to_string()],
            quick_commands: vec![],
            folder: folder.to_string(),
            ai_mode: AiMode::Suggest,
        };
        store.upsert_project(proj("proj-b-1", "华东")).unwrap();
        store.upsert_project(proj("proj-b-2", "华东/浙江省")).unwrap();
        store.upsert_project(proj("proj-b-3", "华北")).unwrap();

        // 递归删除：直属 + 子分类项目都没了，「华东」及子目录条目清理
        let n = store.delete_folder_with_projects("华东").unwrap();
        assert_eq!(n, 2);
        {
            let guard = store.state.lock().unwrap();
            assert!(guard.projects.iter().all(|p| p.id == "proj-b-3"));
            // 「华东」及子目录条目清理，「华北」保留（upsert_project 自动注册的目录）
            assert_eq!(guard.project_folders, vec!["华北".to_string()]);
            // 服务器不受影响（仅解绑语义，与单个 delete_project 一致）
            assert!(guard.servers.iter().any(|s| s.id == "srv-b-1"));
        }
        // 未分类不可删
        assert_eq!(
            store.delete_folder_with_projects("").unwrap_err(),
            "未分类目录不可删除"
        );
        // 落盘后重载一致
        let reloaded = test_store(dir);
        let guard = reloaded.state.lock().unwrap();
        assert_eq!(guard.projects.len(), 1);
        assert_eq!(guard.project_folders, vec!["华北".to_string()]);
    }

    #[test]
    fn server_tags_default_and_normalize() {
        // 旧配置无 tags 字段 → 反序列化为空数组
        let legacy: Server = serde_json::from_str(
            r#"{"id":"srv-1","name":"n","host":"h","port":22,"authType":"password","username":"u","keyPath":""}"#,
        )
        .unwrap();
        assert!(legacy.tags.is_empty());
        // 保存时归一化：trim、去空、去重保序
        let dir = temp_config_dir("server-tags-normalize");
        let store = test_store(dir);
        store
            .upsert_server(
                Server {
                    tags: vec![
                        " AAA ".to_string(),
                        "".to_string(),
                        "AAA".to_string(),
                        "BI".to_string(),
                    ],
                    ..legacy
                },
                None,
            )
            .unwrap();
        assert_eq!(
            store.server("srv-1").unwrap().tags,
            vec!["AAA".to_string(), "BI".to_string()]
        );
    }

    #[test]
    fn clear_unreferenced_servers_keeps_project_bastion_and_cleans_dependents() {
        let dir = temp_config_dir("clear-unreferenced");
        let store = test_store(dir.clone());
        let server = |id: &str, is_bastion: bool, bastion_id: Option<&str>| Server {
            id: id.to_string(),
            name: id.to_string(),
            host: format!("{id}.example"),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion,
            bastion_id: bastion_id.map(str::to_string),
            tags: Vec::new(),
        };
        store.upsert_server(server("keep-bastion", true, None), None).unwrap();
        store
            .upsert_server(server("keep-target", false, Some("keep-bastion")), None)
            .unwrap();
        store.upsert_server(server("drop-bastion", true, None), None).unwrap();
        store
            .upsert_server(server("drop-target", false, Some("drop-bastion")), None)
            .unwrap();
        store
            .upsert_server(server("drop-password", false, None), Some("orphan-password"))
            .unwrap();
        let dropped_password_server = store.server("drop-password").unwrap();
        store
            .upsert_project(Project {
                id: "proj-keep".to_string(),
                name: "P".to_string(),
                path: None,
                server_ids: vec!["keep-target".to_string()],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();

        let db = |id: &str| DbConnection {
            id: id.to_string(),
            name: id.to_string(),
            kind: DbKind::Mysql,
            host: "127.0.0.1".to_string(),
            port: 3306,
            user: "root".to_string(),
            database: String::new(),
            allowed_commands: Vec::new(),
            enabled: true,
        };
        store
            .save_db_connection("keep-target", db("keep-db"), Some("keep-db-password"))
            .unwrap();
        store
            .save_db_connection("drop-password", db("drop-db"), Some("drop-db-password"))
            .unwrap();
        store
            .with_state(|state| {
                for id in ["keep-target", "drop-password"] {
                    state.sftp_history.insert(id.to_string(), vec!["/tmp".to_string()]);
                    state.sftp_favorites.insert(
                        id.to_string(),
                        vec![SftpFavorite { path: "/var".to_string(), title: "var".to_string() }],
                    );
                    state.mcp_devices.insert(id.to_string(), McpDeviceConfig::default());
                }
                Ok(())
            })
            .unwrap();

        assert_eq!(store.clear_unreferenced_servers().unwrap(), 3);
        let guard = store.state.lock().unwrap();
        let ids: HashSet<&str> = guard.servers.iter().map(|server| server.id.as_str()).collect();
        assert_eq!(ids, HashSet::from(["keep-bastion", "keep-target"]));
        assert_eq!(guard.projects[0].server_ids, vec!["keep-target".to_string()]);
        assert!(guard.sftp_history.contains_key("keep-target"));
        assert!(!guard.sftp_history.contains_key("drop-password"));
        assert!(guard.sftp_favorites.contains_key("keep-target"));
        assert!(!guard.sftp_favorites.contains_key("drop-password"));
        assert!(guard.mcp_devices.contains_key("keep-target"));
        assert!(!guard.mcp_devices.contains_key("drop-password"));
        assert!(guard.db_connections.contains_key("keep-target"));
        assert!(!guard.db_connections.contains_key("drop-password"));
        drop(guard);
        assert_eq!(store.db_secret("keep-target", "keep-db").unwrap(), "keep-db-password");
        assert!(store.db_secret("drop-password", "drop-db").is_err());
        assert_eq!(store.read_server_secret(&dropped_password_server).unwrap(), "orphan-password");
        assert_eq!(store.credentials_all().len(), 5);

        let reloaded = test_store(dir);
        assert_eq!(reloaded.clear_unreferenced_servers().unwrap(), 0);
        assert_eq!(reloaded.state.lock().unwrap().servers.len(), 2);
    }

    #[test]
    fn clear_unreferenced_servers_terminates_on_legacy_bastion_cycle() {
        let dir = temp_config_dir("clear-cycle");
        let store = test_store(dir);
        let cyclic = |id: &str, bastion_id: &str| Server {
            id: id.to_string(),
            name: id.to_string(),
            host: id.to_string(),
            port: 22,
            auth_type: AuthType::Key,
            username: "u".to_string(),
            key_path: "key".to_string(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: Some(bastion_id.to_string()),
            tags: Vec::new(),
        };
        force_upsert_server(&store, cyclic("cycle-a", "cycle-b"));
        force_upsert_server(&store, cyclic("cycle-b", "cycle-a"));
        store
            .upsert_project(Project {
                id: "proj-cycle".to_string(),
                name: "P".to_string(),
                path: None,
                server_ids: vec!["cycle-a".to_string()],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();

        assert_eq!(store.clear_unreferenced_servers().unwrap(), 0);
        assert_eq!(store.state.lock().unwrap().servers.len(), 2);
    }

    #[test]
    fn upsert_project_auto_registers_folder() {
        let dir = temp_config_dir("upsert-proj-folder-register");
        let store = test_store(dir);
        let mk = |folder: &str| Project {
            id: "proj-u-f".to_string(),
            name: "U".to_string(),
            path: None,
            server_ids: vec![],
            quick_commands: vec![],
            folder: folder.to_string(),
            ai_mode: AiMode::Suggest,
        };
        // 非空 folder 自动注册
        store.upsert_project(mk("生产环境")).unwrap();
        assert_eq!(
            store.state.lock().unwrap().project_folders,
            vec!["生产环境".to_string()]
        );
        // 再次 upsert 同目录的项目不重复注册
        store.upsert_project(mk("生产环境")).unwrap();
        assert_eq!(
            store.state.lock().unwrap().project_folders,
            vec!["生产环境".to_string()]
        );
        // 未分类（空串）不注册
        store.upsert_project(mk("")).unwrap();
        assert_eq!(
            store.state.lock().unwrap().project_folders,
            vec!["生产环境".to_string()]
        );
    }

    #[test]
    fn merge_xshell_servers_builds_projects_by_folder() {
        let dir = temp_config_dir("xshell-merge-projects");
        let store = test_store(dir.clone());
        let srv = |id: &str| Server {
            id: id.to_string(),
            name: id.to_string(),
            host: "h".to_string(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        };
        // 有目录 → 项目名 = 目录路径；空目录 → 归「未命名项目」
        store
            .merge_xshell_servers(&[
                ScannedSession {
                    server: srv("x-1"),
                    folder: "生产环境/Web".to_string(),
                },
                ScannedSession {
                    server: srv("x-2"),
                    folder: String::new(),
                },
                ScannedSession {
                    server: srv("x-3"),
                    folder: "生产环境/Web".to_string(),
                },
            ])
            .unwrap();
        {
            let guard = store.state.lock().unwrap();
            assert_eq!(guard.servers.len(), 3);
            assert_eq!(guard.projects.len(), 2, "两个目录各建一个项目");
            let web = guard
                .projects
                .iter()
                .find(|p| p.name == "生产环境/Web")
                .unwrap();
            // 新项目：id proj- 前缀、path=None、quick_commands 空、ai_mode 默认、folder 空
            assert!(web.id.starts_with("proj-"), "id 应 proj- 前缀: {}", web.id);
            assert_eq!(web.path, None);
            assert!(web.quick_commands.is_empty());
            assert_eq!(web.ai_mode, AiMode::Suggest);
            assert_eq!(web.folder, "");
            assert_eq!(
                web.server_ids,
                vec!["x-1".to_string(), "x-3".to_string()],
                "同目录服务器应幂等去重绑定"
            );
            let unnamed = guard
                .projects
                .iter()
                .find(|p| p.name == "未命名项目")
                .unwrap();
            assert_eq!(unnamed.server_ids, vec!["x-2".to_string()]);
            // 空目录不注册进 project_folders
            assert!(guard.project_folders.is_empty());
        }
        // 重复导入（全部 unchanged）：不重复建项目、不重复绑定
        let r = store
            .merge_xshell_servers(&[
                ScannedSession {
                    server: srv("x-1"),
                    folder: "生产环境/Web".to_string(),
                },
                ScannedSession {
                    server: srv("x-2"),
                    folder: String::new(),
                },
            ])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 0, 2));
        assert_eq!(r.projects_created, 0, "重复导入不重复建项目");
        {
            let guard = store.state.lock().unwrap();
            assert_eq!(guard.projects.len(), 2);
            let web = guard
                .projects
                .iter()
                .find(|p| p.name == "生产环境/Web")
                .unwrap();
            assert_eq!(
                web.server_ids,
                vec!["x-1".to_string(), "x-3".to_string()],
                "绑定保持幂等（去重）"
            );
        }
        // 已有同名项目复用：预置同名项目后导入该目录的服务器 → 复用仅补绑,不覆盖原字段
        store
            .upsert_project(Project {
                id: "proj-pre".to_string(),
                name: "预置目录".to_string(),
                path: Some("D:\\existing".to_string()),
                server_ids: vec![],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Agent,
            })
            .unwrap();
        let r = store
            .merge_xshell_servers(&[ScannedSession {
                server: srv("x-4"),
                folder: "预置目录".to_string(),
            }])
            .unwrap();
        assert_eq!(r.projects_created, 0, "同名项目复用不计新建");
        let guard = store.state.lock().unwrap();
        let pre = guard
            .projects
            .iter()
            .find(|p| p.name == "预置目录")
            .unwrap();
        assert_eq!(pre.id, "proj-pre", "复用已有项目而非新建");
        assert_eq!(
            pre.path,
            Some("D:\\existing".to_string()),
            "复用不覆盖原字段"
        );
        assert_eq!(pre.ai_mode, AiMode::Agent);
        assert_eq!(
            pre.server_ids,
            vec!["x-4".to_string()],
            "新服务器补绑进已有项目"
        );
        drop(guard);
        // 落盘后重载一致(两个导入项目 + 一个预置项目)
        let reloaded = test_store(dir);
        assert_eq!(reloaded.state.lock().unwrap().projects.len(), 3);
    }

    #[test]
    fn legacy_json_without_project_folders_parses_as_empty() {
        // 旧配置 JSON 无 projectFolders 字段 → serde default 空列表，不报错
        let json = serde_json::to_string(&sample_state()).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v.as_object_mut().unwrap().remove("projectFolders");
        let back: AppState = serde_json::from_value(v).unwrap();
        assert!(back.project_folders.is_empty());
        assert_eq!(back.servers.len(), 2, "其余字段不受影响");
    }

    #[test]
    fn legacy_json_server_folder_fields_are_ignored() {
        // 旧配置 JSON 遗留的 serverFolders / Server.folder 字段 → 无 deny_unknown_fields，
        // serde 直接忽略，不报错；Server 不再有 folder，项目 folder 缺省为空串
        let old = r#"{
            "settings": {"workspaceDir":null,"llm":{"modelId":"m","baseUrl":"u","effort":"low"},"search":{"enabled":false},"theme":"dark","autoSwitchAiWorkdir":false},
            "servers":[{"id":"s1","name":"S","host":"h","port":22,"authType":"password","username":"u","keyPath":"","folder":"生产环境"}],
            "projects":[{"id":"p1","name":"P","path":null,"serverIds":[],"quickCommands":[]}],
            "sessions":{},
            "serverFolders":["生产环境"]
        }"#;
        let state: AppState = serde_json::from_str(old).unwrap();
        assert_eq!(state.servers.len(), 1, "遗留 folder 字段不影响解析");
        assert!(
            state.project_folders.is_empty(),
            "旧 serverFolders 不映射到 project_folders"
        );
        assert_eq!(state.projects[0].folder, "", "旧项目无 folder 字段按未分类");
    }

    #[test]
    fn legacy_json_without_command_folder_fields_parses_with_defaults() {
        // 旧配置 JSON 无 commandFolders 字段、QuickCommand 无 folder/global 字段 →
        // serde default：空列表 / 未分类 / 非全局，不报错
        let json = serde_json::to_string(&sample_state()).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        let obj = v.as_object_mut().unwrap();
        obj.remove("commandFolders");
        let proj = obj.get_mut("projects").unwrap().as_array_mut().unwrap();
        for p in proj.iter_mut() {
            for qc in p
                .get_mut("quickCommands")
                .unwrap()
                .as_array_mut()
                .unwrap()
                .iter_mut()
            {
                let q = qc.as_object_mut().unwrap();
                q.remove("folder");
                q.remove("global");
            }
        }
        let back: AppState = serde_json::from_value(v).unwrap();
        assert!(back.command_folders.is_empty());
        assert_eq!(back.projects[0].quick_commands[0].folder, "");
        assert!(!back.projects[0].quick_commands[0].global);
        assert_eq!(back.servers.len(), 2, "其余字段不受影响");
    }

    #[test]
    fn legacy_json_without_ui_expanded_parses_as_empty_map() {
        // 旧配置 JSON 无 uiExpanded 字段 → serde default 空 map，不报错
        let json = serde_json::to_string(&sample_state()).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v.as_object_mut().unwrap().remove("uiExpanded");
        let back: AppState = serde_json::from_value(v).unwrap();
        assert!(back.ui_expanded.is_empty());
        assert_eq!(back.servers.len(), 2, "其余字段不受影响");
    }

    #[test]
    fn set_ui_expanded_persists_across_reload() {
        // 写入后重载 store：展开状态仍在，且不影响其他 key
        let dir = temp_config_dir("ui-expanded-persist");
        let store = test_store(dir.clone());
        store
            .set_ui_expanded(
                "explorer:proj-1".to_string(),
                vec!["src".to_string(), "src/components".to_string()],
            )
            .unwrap();
        // 空 key 拒绝
        assert!(store
            .set_ui_expanded(String::new(), vec!["x".to_string()])
            .is_err());
        // 覆盖写第二个 key
        store
            .set_ui_expanded(
                "welcome:projectGroups".to_string(),
                vec!["生产环境".to_string()],
            )
            .unwrap();
        let reloaded = test_store(dir.clone());
        let guard = reloaded.state.lock().unwrap();
        assert_eq!(
            guard.ui_expanded.get("explorer:proj-1").unwrap(),
            &vec!["src".to_string(), "src/components".to_string()],
            "首次写入的 key 原样保留"
        );
        assert_eq!(
            guard.ui_expanded.get("welcome:projectGroups").unwrap(),
            &vec!["生产环境".to_string()],
            "第二个 key 写入成功"
        );
        // 清空数组覆盖后 key 仍在（空值语义：空展开集合）
        drop(guard);
        store
            .set_ui_expanded("welcome:projectGroups".to_string(), vec![])
            .unwrap();
        let reloaded2 = test_store(dir);
        assert!(
            reloaded2
                .state
                .lock()
                .unwrap()
                .ui_expanded
                .get("welcome:projectGroups")
                .unwrap()
                .is_empty(),
            "空数组覆盖后落盘为空列表"
        );
    }

    #[test]
    fn legacy_json_without_sftp_history_and_favorites_parses_as_empty_maps() {
        // 旧配置 JSON 无 sftpHistory / sftpFavorites 字段 → serde default 空 map，不报错
        let json = serde_json::to_string(&sample_state()).unwrap();
        let mut v: serde_json::Value = serde_json::from_str(&json).unwrap();
        v.as_object_mut().unwrap().remove("sftpHistory");
        v.as_object_mut().unwrap().remove("sftpFavorites");
        let back: AppState = serde_json::from_value(v).unwrap();
        assert!(
            back.sftp_history.is_empty(),
            "旧 JSON 无 sftpHistory 按空 map"
        );
        assert!(
            back.sftp_favorites.is_empty(),
            "旧 JSON 无 sftpFavorites 按空 map"
        );
        assert_eq!(back.servers.len(), 2, "其余字段不受影响");
    }

    #[test]
    fn set_sftp_history_persists_across_reload() {
        // 写入后重载 store：路径历史仍在，且不影响其他服务器
        let dir = temp_config_dir("sftp-history-persist");
        let store = test_store(dir.clone());
        store
            .set_sftp_history(
                "srv-1".to_string(),
                vec!["/var/log".to_string(), "/etc".to_string(), "/".to_string()],
            )
            .unwrap();
        // 空 serverId 拒绝
        assert!(store
            .set_sftp_history(String::new(), vec!["/".to_string()])
            .is_err());
        // 第二个服务器独立
        store
            .set_sftp_history("srv-2".to_string(), vec!["/tmp".to_string()])
            .unwrap();
        let reloaded = test_store(dir.clone());
        let guard = reloaded.state.lock().unwrap();
        assert_eq!(
            guard.sftp_history.get("srv-1").unwrap(),
            &vec!["/var/log".to_string(), "/etc".to_string(), "/".to_string()],
            "首次写入的服务器原样保留"
        );
        assert_eq!(
            guard.sftp_history.get("srv-2").unwrap(),
            &vec!["/tmp".to_string()],
            "第二个服务器写入成功"
        );
        // 空数组覆盖后 key 仍在（清空语义）
        drop(guard);
        store.set_sftp_history("srv-1".to_string(), vec![]).unwrap();
        let reloaded2 = test_store(dir);
        assert!(
            reloaded2
                .state
                .lock()
                .unwrap()
                .sftp_history
                .get("srv-1")
                .unwrap()
                .is_empty(),
            "空数组覆盖后落盘为空列表"
        );
    }

    #[test]
    fn set_sftp_favorites_persists_across_reload() {
        // 写入后重载 store：收藏夹仍在（含标题），且不影响其他服务器
        let dir = temp_config_dir("sftp-favorites-persist");
        let store = test_store(dir.clone());
        store
            .set_sftp_favorites(
                "srv-1".to_string(),
                vec![
                    SftpFavorite {
                        path: "/data".to_string(),
                        title: "数据目录".to_string(),
                    },
                    SftpFavorite {
                        path: "/backup".to_string(),
                        title: "备份".to_string(),
                    },
                ],
            )
            .unwrap();
        // 空 serverId 拒绝
        assert!(store
            .set_sftp_favorites(
                String::new(),
                vec![SftpFavorite {
                    path: "/data".to_string(),
                    title: "数据目录".to_string()
                }],
            )
            .is_err());
        let reloaded = test_store(dir.clone());
        let guard = reloaded.state.lock().unwrap();
        assert_eq!(
            guard.sftp_favorites.get("srv-1").unwrap(),
            &vec![
                SftpFavorite {
                    path: "/data".to_string(),
                    title: "数据目录".to_string()
                },
                SftpFavorite {
                    path: "/backup".to_string(),
                    title: "备份".to_string()
                },
            ],
            "收藏条目（含标题）按添加顺序保留"
        );
        // 覆盖写（取消收藏后列表变短）同样落盘
        drop(guard);
        store
            .set_sftp_favorites(
                "srv-1".to_string(),
                vec![SftpFavorite {
                    path: "/data".to_string(),
                    title: "数据目录".to_string(),
                }],
            )
            .unwrap();
        let reloaded2 = test_store(dir);
        assert_eq!(
            reloaded2
                .state
                .lock()
                .unwrap()
                .sftp_favorites
                .get("srv-1")
                .unwrap(),
            &vec![SftpFavorite {
                path: "/data".to_string(),
                title: "数据目录".to_string()
            }],
            "覆盖写后落盘为新列表"
        );
    }

    #[test]
    fn legacy_sftp_favorites_strings_migrate_to_titled() {
        // 旧配置 `sftpFavorites: {serverId: ["/data", "/etc/log"]}`（纯路径）→ 读取时自动迁移为 {path,title}，
        // title 取目录名；新格式条目原样保留。
        let dir = temp_config_dir("sftp-fav-legacy");
        let state_path = dir.join("aishell.json");
        std::fs::create_dir_all(&dir).unwrap();
        let mut state = serde_json::to_value(sample_state()).unwrap();
        state["sftpFavorites"] = serde_json::json!({
            "srv-1": ["/data", "/etc/log"],
            "srv-2": [{ "path": "/opt/app", "title": "核心应用" }],
        });
        std::fs::write(&state_path, serde_json::to_string(&state).unwrap()).unwrap();
        let store = test_store(dir);
        let guard = store.state.lock().unwrap();
        assert_eq!(
            guard.sftp_favorites.get("srv-1").unwrap(),
            &vec![
                SftpFavorite {
                    path: "/data".to_string(),
                    title: "data".to_string()
                },
                SftpFavorite {
                    path: "/etc/log".to_string(),
                    title: "log".to_string()
                },
            ],
            "旧纯路径条目按目录名补标题"
        );
        assert_eq!(
            guard.sftp_favorites.get("srv-2").unwrap(),
            &vec![SftpFavorite {
                path: "/opt/app".to_string(),
                title: "核心应用".to_string()
            }],
            "新格式条目原样保留"
        );
    }

    #[test]
    fn create_command_folder_normalizes_and_rejects_invalid() {
        let dir = temp_config_dir("qc-folder-create");
        let store = test_store(dir.clone());
        // 空串 / 纯分隔符 → 中文错误
        assert_eq!(
            store.create_command_folder("  ").unwrap_err(),
            "分类目录名称不能为空"
        );
        assert_eq!(
            store.create_command_folder("///").unwrap_err(),
            "分类目录名称不能为空"
        );
        // 规范化：trim + 去空段；支持层级
        store.create_command_folder(" 常用/部署 ").unwrap();
        store.create_command_folder("a//b/").unwrap();
        {
            let guard = store.state.lock().unwrap();
            assert_eq!(
                guard.command_folders,
                vec!["常用/部署".to_string(), "a/b".to_string()]
            );
        }
        // 重名（规范化后相同）报错，且列表不变
        assert_eq!(
            store.create_command_folder("常用/部署").unwrap_err(),
            "分类目录已存在"
        );
        assert_eq!(
            store.state.lock().unwrap().command_folders,
            vec!["常用/部署".to_string(), "a/b".to_string()]
        );
        // 落盘后重载一致
        let reloaded = test_store(dir);
        assert_eq!(
            reloaded.state.lock().unwrap().command_folders,
            vec!["常用/部署".to_string(), "a/b".to_string()]
        );
    }

    #[test]
    fn rename_command_folder_cascades_across_projects() {
        let dir = temp_config_dir("qc-rename-cascade");
        let store = test_store(dir.clone());
        store.create_command_folder("常用").unwrap();
        let mk = |id: &str, folder: &str| Project {
            id: format!("proj-{id}"),
            name: format!("P{id}"),
            path: None,
            server_ids: vec![],
            quick_commands: vec![QuickCommand {
                id: format!("qc-{id}"),
                title: format!("T{id}"),
                command: format!("echo {id}"),
                folder: folder.to_string(),
                global: id == "b",
            }],
            folder: String::new(),
            ai_mode: AiMode::Suggest,
        };
        // 两个项目各有一条命令挂在「常用」下，其中一个还带 global
        store.upsert_project(mk("a", "常用")).unwrap();
        store.upsert_project(mk("b", "常用")).unwrap();
        // 新旧名均按规范化处理：带空白与重复分隔符也应级联生效
        store.rename_command_folder("常用", " 常用//部署 ").unwrap();
        {
            let guard = store.state.lock().unwrap();
            assert_eq!(guard.command_folders, vec!["常用/部署".to_string()]);
            for p in &guard.projects {
                assert_eq!(p.quick_commands[0].folder, "常用/部署");
                // global 字段级联后保持不变
                assert_eq!(p.quick_commands[0].global, p.id == "proj-b");
            }
        }
        // 落盘后重载一致
        let reloaded = test_store(dir);
        let guard = reloaded.state.lock().unwrap();
        assert_eq!(guard.command_folders, vec!["常用/部署".to_string()]);
        assert_eq!(guard.projects[0].quick_commands[0].folder, "常用/部署");
        assert_eq!(guard.projects[1].quick_commands[0].folder, "常用/部署");
    }

    #[test]
    fn rename_command_folder_rejects_conflict_and_uncategorized() {
        let dir = temp_config_dir("qc-rename-conflict");
        let store = test_store(dir);
        store.create_command_folder("甲").unwrap();
        store.create_command_folder("乙").unwrap();
        // 未分类（空串）不可重命名
        assert_eq!(
            store.rename_command_folder("", "x").unwrap_err(),
            "未分类目录不可重命名"
        );
        // 目标已存在且 ≠ old → 报错
        assert_eq!(
            store.rename_command_folder("甲", "乙").unwrap_err(),
            "分类目录已存在"
        );
        // new 规范化后为空 → 报错
        assert_eq!(
            store.rename_command_folder("甲", " / ").unwrap_err(),
            "分类目录名称不能为空"
        );
        // new 规范化后与 old 相同 → no-op，列表不变
        store.rename_command_folder("甲", " 甲 ").unwrap();
        let guard = store.state.lock().unwrap();
        assert_eq!(
            guard.command_folders,
            vec!["甲".to_string(), "乙".to_string()]
        );
    }

    #[test]
    fn rename_command_folder_handles_folders_not_in_list() {
        let dir = temp_config_dir("qc-rename-derived");
        let store = test_store(dir.clone());
        // 历史 JSON 里命令的 folder 可能不在 command_folders 清单；重命名同样级联并补入清单
        store
            .with_state(|s| {
                s.projects.push(Project {
                    id: "proj-d".to_string(),
                    name: "D".to_string(),
                    path: None,
                    server_ids: vec![],
                    quick_commands: vec![QuickCommand {
                        id: "qc-d".to_string(),
                        title: "T".to_string(),
                        command: "echo d".to_string(),
                        folder: "旧目录".to_string(),
                        global: false,
                    }],
                    folder: String::new(),
                    ai_mode: AiMode::Suggest,
                });
                Ok(())
            })
            .unwrap();
        assert!(store.state.lock().unwrap().command_folders.is_empty());
        store.rename_command_folder("旧目录", "新目录").unwrap();
        let guard = store.state.lock().unwrap();
        assert_eq!(guard.projects[0].quick_commands[0].folder, "新目录");
        assert_eq!(guard.command_folders, vec!["新目录".to_string()]);
    }

    #[test]
    fn delete_command_folder_removes_and_persists() {
        let dir = temp_config_dir("qc-folder-delete");
        let store = test_store(dir.clone());
        store.create_command_folder("常用").unwrap();
        store.create_command_folder("开发环境/Web").unwrap();
        // 未分类空串不可删除；规范化后为空同样报中文错误
        assert_eq!(
            store.delete_command_folder("").unwrap_err(),
            "未分类目录不可删除"
        );
        assert_eq!(
            store.delete_command_folder(" / ").unwrap_err(),
            "分类目录名称不能为空"
        );
        // 不存在的目录视为幂等成功
        store.delete_command_folder("不存在的目录").unwrap();
        // 删除成功：入参规范化，仅移除匹配项
        store.delete_command_folder(" 开发环境/Web ").unwrap();
        {
            let guard = store.state.lock().unwrap();
            assert_eq!(guard.command_folders, vec!["常用".to_string()]);
        }
        // 落盘后重载一致
        let reloaded = test_store(dir);
        assert_eq!(
            reloaded.state.lock().unwrap().command_folders,
            vec!["常用".to_string()]
        );
    }

    #[test]
    fn delete_command_folder_rejects_when_commands_exist() {
        let dir = temp_config_dir("qc-folder-delete-nonempty");
        let store = test_store(dir.clone());
        store.create_command_folder("常用").unwrap();
        store
            .upsert_project(Project {
                id: "proj-f".to_string(),
                name: "F".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![QuickCommand {
                    id: "qc-f".to_string(),
                    title: "T".to_string(),
                    command: "echo f".to_string(),
                    folder: "常用".to_string(),
                    global: false,
                }],
                folder: String::new(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();
        // 目录下仍有命令（任意项目）→ 中文错误
        let err = store.delete_command_folder("常用").unwrap_err();
        assert_eq!(err, "分类目录「常用」下仍有命令，不能删除");
        // 目录与命令都未被改动
        let guard = store.state.lock().unwrap();
        assert_eq!(guard.command_folders, vec!["常用".to_string()]);
        assert_eq!(guard.projects[0].quick_commands.len(), 1);
        drop(guard);
        // 删除命令后可删目录，且落盘一致
        store
            .upsert_project(Project {
                id: "proj-f".to_string(),
                name: "F".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();
        store.delete_command_folder("常用").unwrap();
        assert!(store.state.lock().unwrap().command_folders.is_empty());
        let reloaded = test_store(dir);
        assert!(reloaded.state.lock().unwrap().command_folders.is_empty());
    }

    #[test]
    fn upsert_project_auto_registers_command_folders() {
        let dir = temp_config_dir("upsert-qc-folder-register");
        let store = test_store(dir);
        let mk = |qcs: Vec<QuickCommand>| Project {
            id: "proj-u".to_string(),
            name: "U".to_string(),
            path: None,
            server_ids: vec![],
            quick_commands: qcs,
            folder: String::new(),
            ai_mode: AiMode::Suggest,
        };
        // 非空 folder 自动注册
        store
            .upsert_project(mk(vec![QuickCommand {
                id: "qc-u-1".to_string(),
                title: "T".to_string(),
                command: "echo u".to_string(),
                folder: "常用".to_string(),
                global: true,
            }]))
            .unwrap();
        assert_eq!(
            store.state.lock().unwrap().command_folders,
            vec!["常用".to_string()]
        );
        // 再次 upsert 同目录命令不重复注册
        store
            .upsert_project(mk(vec![QuickCommand {
                id: "qc-u-2".to_string(),
                title: "T".to_string(),
                command: "echo v".to_string(),
                folder: "常用".to_string(),
                global: false,
            }]))
            .unwrap();
        assert_eq!(
            store.state.lock().unwrap().command_folders,
            vec!["常用".to_string()]
        );
        // 未分类（空串）不注册
        store
            .upsert_project(mk(vec![QuickCommand {
                id: "qc-u-3".to_string(),
                title: "T".to_string(),
                command: "echo w".to_string(),
                folder: String::new(),
                global: false,
            }]))
            .unwrap();
        assert_eq!(
            store.state.lock().unwrap().command_folders,
            vec!["常用".to_string()]
        );
    }

    #[test]
    fn session_title_claim_allows_completed_assistant_message_and_is_once() {
        let dir = temp_config_dir("session-title-claim");
        let store = test_store(dir);
        store
            .session_upsert(
                "proj-title",
                ChatSession {
                    id: "sess-title".to_string(),
                    title: "临时标题".to_string(),
                    messages: vec![
                        test_chat_msg("user", "请检查部署状态"),
                        test_chat_msg("assistant", "部署状态正常"),
                    ],
                    auto_title_triggered: false,
                    archived: false,
                },
            )
            .unwrap();

        assert_eq!(
            store
                .try_claim_session_title("proj-title", "sess-title", "请检查部署状态")
                .unwrap(),
            Some("临时标题".to_string())
        );
        assert_eq!(
            store
                .try_claim_session_title("proj-title", "sess-title", "请检查部署状态")
                .unwrap(),
            None
        );
    }

    #[test]
    fn session_title_claim_requires_matching_first_user_message() {
        let dir = temp_config_dir("session-title-first-message");
        let store = test_store(dir);
        store
            .session_upsert(
                "proj-title",
                ChatSession {
                    id: "sess-title".to_string(),
                    title: "临时标题".to_string(),
                    messages: vec![test_chat_msg("assistant", "先有回复")],
                    auto_title_triggered: false,
                    archived: false,
                },
            )
            .unwrap();
        assert_eq!(
            store
                .try_claim_session_title("proj-title", "sess-title", "首条用户消息")
                .unwrap(),
            None
        );
    }

    #[test]
    fn session_upsert_preserves_claimed_title_and_flag() {
        let dir = temp_config_dir("session-title-upsert");
        let store = test_store(dir);
        let first = ChatSession {
            id: "sess-title".to_string(),
            title: "临时标题".to_string(),
            messages: vec![test_chat_msg("user", "请检查部署状态")],
            auto_title_triggered: false,
            archived: false,
        };
        store.session_upsert("proj-title", first).unwrap();
        assert_eq!(
            store
                .try_claim_session_title("proj-title", "sess-title", "请检查部署状态")
                .unwrap(),
            Some("临时标题".to_string())
        );

        store
            .session_upsert(
                "proj-title",
                ChatSession {
                    id: "sess-title".to_string(),
                    title: "前端旧快照标题".to_string(),
                    messages: vec![
                        test_chat_msg("user", "请检查部署状态"),
                        test_chat_msg("assistant", "已完成"),
                    ],
                    auto_title_triggered: false,
                    archived: false,
                },
            )
            .unwrap();
        let saved = store.sessions_get("proj-title").unwrap().pop().unwrap();
        assert!(saved.auto_title_triggered);
        assert_eq!(saved.title, "临时标题");
    }

    #[test]
    fn session_title_update_uses_compare_and_swap_expected_title() {
        let dir = temp_config_dir("session-title-cas");
        let store = test_store(dir);
        store
            .session_upsert(
                "proj-title",
                ChatSession {
                    id: "sess-title".to_string(),
                    title: "临时标题".to_string(),
                    messages: vec![test_chat_msg("user", "第一条")],
                    auto_title_triggered: false,
                    archived: false,
                },
            )
            .unwrap();

        assert!(!store
            .update_session_title_if_expected(
                "proj-title",
                "sess-title",
                &["不是当前标题".to_string()],
                "不应写入",
            )
            .unwrap());
        assert!(store
            .update_session_title_if_expected(
                "proj-title",
                "sess-title",
                &["临时标题".to_string()],
                "部署检查",
            )
            .unwrap());
        assert_eq!(
            store.sessions_get("proj-title").unwrap()[0].title,
            "部署检查"
        );
    }

    #[test]
    fn session_upsert_preserves_archived_flag_and_setter_works() {
        let dir = temp_config_dir("session-archived");
        let store = test_store(dir);
        let sess = || ChatSession {
            id: "sess-arch".to_string(),
            title: "T".to_string(),
            messages: vec![test_chat_msg("user", "hi")],
            auto_title_triggered: false,
            archived: false,
        };
        store.session_upsert("proj-arch", sess()).unwrap();
        assert!(store
            .set_session_archived("proj-arch", "sess-arch", true)
            .unwrap());
        // 重复设置同值返回 false（无变更）
        assert!(!store
            .set_session_archived("proj-arch", "sess-arch", true)
            .unwrap());
        // 不存在会话返回 false 而非报错
        assert!(!store
            .set_session_archived("proj-arch", "sess-none", true)
            .unwrap());
        // 前端残留快照 upsert 不得冲掉 archived 标记
        store.session_upsert("proj-arch", sess()).unwrap();
        let saved = store.sessions_get("proj-arch").unwrap().pop().unwrap();
        assert!(saved.archived, "upsert 应保留 slot 的 archived 值");
        // 新插入会话 upsert 传入 true 也被强制回落 false
        let mut s2 = sess();
        s2.id = "sess-arch-2".to_string();
        s2.archived = true;
        store.session_upsert("proj-arch", s2).unwrap();
        let list = store.sessions_get("proj-arch").unwrap();
        assert!(
            !list
                .iter()
                .find(|s| s.id == "sess-arch-2")
                .unwrap()
                .archived
        );
    }

    #[test]
    fn old_json_without_archived_field_parses() {
        let json = r#"{"id":"s1","title":"T","messages":[],"autoTitleTriggered":false}"#;
        let session: ChatSession = serde_json::from_str(json).unwrap();
        assert!(!session.archived);
    }

    #[test]
    fn sessions_upsert_and_delete_project_cleanup() {
        let dir = temp_config_dir("sessions");
        let store = test_store(dir);
        let sess = ChatSession {
            id: "sess-x".to_string(),
            title: "T".to_string(),
            messages: vec![],
            auto_title_triggered: false,
            archived: false,
        };
        store.session_upsert("proj-x", sess.clone()).unwrap();
        // 同 id 更新不重复插入
        let mut v2 = sess.clone();
        v2.title = "T2".to_string();
        store.session_upsert("proj-x", v2.clone()).unwrap();
        assert_eq!(store.sessions_get("proj-x").unwrap(), vec![v2.clone()]);
        assert!(store.sessions_get("proj-y").unwrap().is_empty());

        store
            .upsert_project(Project {
                id: "proj-x".to_string(),
                name: "P".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();
        store.delete_project("proj-x").unwrap();
        assert!(
            store.sessions_get("proj-x").unwrap().is_empty(),
            "delete_project 应清理 sessions"
        );
        assert!(store.state.lock().unwrap().projects.is_empty());
    }

    #[test]
    fn sessions_masked_on_upsert_and_on_load() {
        let dir = temp_config_dir("session-mask");
        let store = test_store(dir.clone());
        let msg = |content: &str| ChatMsg {
            role: "user".to_string(),
            content: content.to_string(),
            snapshots: vec![TermSnapshot {
                id: "snap-1".to_string(),
                command: "cat /srun3/etc/flow_log.conf".to_string(),
                content: content.to_string(),
                ts: 1,
            }],
            file_refs: vec![],
            server_refs: vec![],
            path_refs: vec![],
            browser_refs: vec![],
            browser_page_refs: vec![],
            skill_refs: vec![],
            note_refs: vec![],
            image_refs: vec![],
            actions: vec![],
            ts: 1,
        };
        // upsert 时脱敏：明文不进内存态，也不进落盘（硬约束：密码永不进 JSON）
        let sess = ChatSession {
            id: "sess-mask".to_string(),
            title: "T".to_string(),
            auto_title_triggered: false,
            archived: false,
            messages: vec![
                msg(r#"db_password="hunter2""#),
                ChatMsg {
                    role: "assistant".to_string(),
                    content: "正文复述密码 hunter2 也应掩盖".to_string(),
                    snapshots: vec![],
                    file_refs: vec![],
                    server_refs: vec![],
                    path_refs: vec![],
                    browser_refs: vec![],
                    browser_page_refs: vec![],
                    skill_refs: vec![],
                    note_refs: vec![],
                    image_refs: vec![],
                    actions: vec![AiActionRecord {
                        tool_call_id: "call-1".to_string(),
                        tool: "run_command".to_string(),
                        intent: "查询在线记录".to_string(),
                        summary: "执行命令（远程）：mysql -uicc -p'hunter2' -e 'select 1'"
                            .to_string(),
                        status: "succeeded".to_string(),
                        timeout_seconds: None,
                        text_len: None,
                    }],
                    ts: 2,
                },
            ],
        };
        store.session_upsert("proj-mask", sess).unwrap();
        let raw = std::fs::read_to_string(dir.join(STATE_FILE)).unwrap();
        assert!(!raw.contains("hunter2"), "落盘文件不得含凭据明文");
        assert!(raw.contains("***已脱敏***"));
        let back = store.sessions_get("proj-mask").unwrap();
        assert!(!back[0].messages[0].snapshots[0].content.contains("hunter2"));
        assert!(back[0].messages[0].content.contains("***已脱敏***"));

        // 加载迁移：历史文件含明文（模拟旧版本遗留），重载后立即清洗并原子写回
        drop(store);
        std::fs::write(dir.join(STATE_FILE), raw.replace("***已脱敏***", "hunter2")).unwrap();
        let store2 = test_store(dir.clone());
        let raw2 = std::fs::read_to_string(dir.join(STATE_FILE)).unwrap();
        assert!(!raw2.contains("hunter2"), "加载迁移应清洗历史明文并写回");
        let back2 = store2.sessions_get("proj-mask").unwrap();
        assert!(back2[0].messages[0].snapshots[0]
            .content
            .contains("***已脱敏***"));

        // 幂等：已脱敏文件重载不再触发写回（内容不再变化）
        drop(store2);
        let store3 = test_store(dir.clone());
        let raw3 = std::fs::read_to_string(dir.join(STATE_FILE)).unwrap();
        assert_eq!(raw2, raw3);
        drop(store3);
    }

    #[test]
    fn db_connection_crud_persists_secret() {
        let dir = temp_config_dir("db-conn");
        let store = test_store(dir.clone());
        let conn = DbConnection {
            id: "db-1".to_string(),
            name: "计费库".to_string(),
            kind: DbKind::Mysql,
            host: "127.0.0.1".to_string(),
            port: 3506,
            user: "icc".to_string(),
            database: "srun4k".to_string(),
            allowed_commands: vec![],
            enabled: true,
        };
        // 默认只读集回退
        assert_eq!(
            conn.effective_commands(),
            vec!["SELECT", "SHOW", "DESC", "DESCRIBE", "EXPLAIN"]
        );
        // 保存 + keyring
        store
            .save_db_connection("srv-a", conn.clone(), Some("pw-db-1"))
            .unwrap();
        assert_eq!(store.db_connections("srv-a"), vec![conn.clone()]);
        assert_eq!(store.db_secret("srv-a", "db-1").unwrap(), "pw-db-1");
        // 更新（None 保持密码）
        let mut v2 = conn.clone();
        v2.name = "计费库改".to_string();
        store.save_db_connection("srv-a", v2.clone(), None).unwrap();
        assert_eq!(store.db_connections("srv-a"), vec![v2.clone()]);
        assert_eq!(store.db_secret("srv-a", "db-1").unwrap(), "pw-db-1");
        // 重载后配置落盘仍在；keyring 密码独立于配置存储（MemorySecrets 不跨实例，此处只验配置）
        let reloaded = test_store(dir);
        assert_eq!(reloaded.db_connections("srv-a"), vec![v2]);
        // 删除清理配置与 keyring
        store.delete_db_connection("srv-a", "db-1").unwrap();
        assert!(store.db_connections("srv-a").is_empty());
        assert!(store.db_secret("srv-a", "db-1").is_err());
        // 校验失败不落盘
        let bad = DbConnection {
            id: "db-x".to_string(),
            name: "".to_string(),
            ..conn
        };
        assert!(store.save_db_connection("srv-a", bad, Some("pw")).is_err());
        assert!(store.db_connections("srv-a").is_empty());
    }

    #[test]
    fn db_secrets_join_known_secrets() {
        let dir = temp_config_dir("db-known");
        let store = test_store(dir);
        store
            .upsert_server(
                Server {
                    id: "srv-a".to_string(),
                    name: "N".to_string(),
                    host: "h".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "u".to_string(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                None,
            )
            .unwrap();
        let conn = DbConnection {
            id: "db-1".to_string(),
            name: "N".to_string(),
            kind: DbKind::Redis,
            host: "127.0.0.1".to_string(),
            port: 16386,
            user: "".to_string(),
            database: String::new(),
            allowed_commands: vec![],
            enabled: true,
        };
        store
            .save_db_connection("srv-a", conn, Some("srun_3000@redis"))
            .unwrap();
        let known = store.known_secrets();
        assert!(
            known.contains(&"srun_3000@redis".to_string()),
            "数据库密码应参与输出脱敏"
        );
    }

    #[test]
    fn old_db_connection_without_enabled_parses_as_enabled() {
        // 旧配置无 enabled 字段 → serde 默认 true（无感升级，已有连接不受新增字段影响）
        let old = r#"{"id":"db-1","name":"计费库","kind":"mysql","host":"127.0.0.1","port":3306,"user":"u","database":"d","allowedCommands":["SELECT"]}"#;
        let conn: DbConnection = serde_json::from_str(old).unwrap();
        assert!(conn.enabled);
        assert_eq!(conn.effective_commands(), vec!["SELECT".to_string()]);
    }

    #[test]
    fn old_chat_msg_without_file_refs_parses_with_empty_vec() {
        // 旧版会话消息无 fileRefs 字段 → serde(default) 兜底为空（无感升级）
        let old = r#"{"role":"user","content":"看看日志","snapshots":[{"id":"snap-1","command":"tail -20 app.log","content":"INFO","ts":1752000000000}],"ts":1752000000001}"#;
        let msg: ChatMsg = serde_json::from_str(old).unwrap();
        assert_eq!(msg.role, "user");
        assert_eq!(msg.snapshots.len(), 1);
        assert!(msg.file_refs.is_empty(), "旧数据应兼容为空引用列表");
        assert!(msg.server_refs.is_empty(), "旧数据应兼容为空服务器引用列表");
        assert!(msg.path_refs.is_empty(), "旧数据应兼容为空路径引用列表");
        assert!(
            msg.browser_refs.is_empty(),
            "旧数据应兼容为空浏览器元素引用列表"
        );
        assert!(
            msg.browser_page_refs.is_empty(),
            "旧数据应兼容为空浏览器页面引用列表"
        );
        assert!(
            msg.note_refs.is_empty(),
            "旧数据应兼容为空笔记引用列表"
        );
    }

    #[test]
    fn chat_msg_browser_page_refs_roundtrip_camel_case() {
        // 新增的浏览器页面引用字段按 camelCase 往返（与前端 ChatMsg.browserPageRefs 对齐）
        let m = ChatMsg {
            browser_page_refs: vec![BrowserPageRef {
                url: "http://localhtml.localhost/C:/x/console.html".to_string(),
                title: "控制台".to_string(),
                ts: 1_752_000_000_002,
            }],
            ..test_chat_msg("user", "看看 @page:控制台")
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(
            json.contains("\"browserPageRefs\""),
            "序列化应为 camelCase: {json}"
        );
        let back: ChatMsg = serde_json::from_str(&json).unwrap();
        assert_eq!(back.browser_page_refs.len(), 1);
        assert_eq!(back.browser_page_refs[0].title, "控制台");
    }

    #[test]
    fn chat_msg_note_refs_roundtrip_camel_case() {
        // 笔记引用字段按 camelCase 往返（与前端 ChatMsg.noteRefs 对齐）
        let m = ChatMsg {
            note_refs: vec![NoteRef {
                id: "note-1".to_string(),
                path: "D:/AIShellWorkspace/.aishell/notes/deploy.md".to_string(),
                name: "deploy".to_string(),
            }],
            ..test_chat_msg("user", "看看 @note:deploy")
        };
        let json = serde_json::to_string(&m).unwrap();
        assert!(
            json.contains("\"noteRefs\""),
            "序列化应为 camelCase: {json}"
        );
        let back: ChatMsg = serde_json::from_str(&json).unwrap();
        assert_eq!(back.note_refs.len(), 1);
        assert_eq!(back.note_refs[0].name, "deploy");
    }

    #[test]
    fn downstream_accessors() {
        let dir = temp_config_dir("accessors");
        let ws = temp_config_dir("accessors-ws");
        let store = test_store(dir);
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws.to_string_lossy().into_owned()),
                    llm: LlmConfig {
                        model_id: "deepseek-reasoner".to_string(),
                        base_url: "https://api.deepseek.com/v1".to_string(),
                        effort: Effort::High,
                    },
                    search: SearchConfig { enabled: false },
                    theme: Theme::Dark,
                    auto_switch_ai_workdir: false,
                    project_view: ProjectView::Card,
                    approval_mode: ApprovalMode::Smart,
                    auto_backup_remote_files: true,
                    compact_server_list: false,
                },
                Some("sk-test-key"),
                None,
            )
            .unwrap();
        store
            .upsert_server(
                Server {
                    id: "srv-a".to_string(),
                    name: "A".to_string(),
                    host: "h".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "u".to_string(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                Some("pw-a"),
            )
            .unwrap();
        store
            .upsert_project(Project {
                id: "proj-a".to_string(),
                name: "P".to_string(),
                path: Some("D:\\proj".to_string()),
                server_ids: vec![],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Agent,
            })
            .unwrap();

        // server() 返回 clone，不含密码字段
        assert_eq!(store.server("srv-a").unwrap().name, "A");
        assert!(store.server("srv-missing").is_none());
        // read_secret 按 account 读
        assert_eq!(store.read_secret("server:srv-a").unwrap(), "pw-a");
        assert_eq!(store.read_secret("llm:apikey").unwrap(), "sk-test-key");
        assert!(store.read_secret("server:missing").is_err());
        // llm_config()
        let llm = store.llm_config();
        assert_eq!(llm.model_id, "deepseek-reasoner");
        assert_eq!(serde_json::to_string(&llm.effort).unwrap(), "\"high\"");
        // project_path()
        assert_eq!(store.project_path("proj-a").as_deref(), Some("D:\\proj"));
        assert_eq!(store.project_path("proj-missing"), None);
    }

    #[test]
    fn merge_xshell_servers_counts_imported_updated_unchanged() {
        let dir = temp_config_dir("xshell-merge-count");
        let store = test_store(dir.clone());
        let srv = |id: &str, port: u16| ScannedSession {
            server: Server {
                id: id.to_string(),
                name: id.to_string(),
                host: format!("10.0.0.{}", port % 250 + 1),
                port,
                auth_type: AuthType::Password,
                username: "root".to_string(),
                key_path: String::new(),
                credential_id: None,
                locked: false,
                is_bastion: false,
                bastion_id: None,
                tags: Vec::new(),
            },
            // 全部未分类 → 归「未命名项目」，不干扰计数断言
            folder: String::new(),
        };
        // 首次：全部 imported；根目录会话统一归「未命名项目」
        let r = store
            .merge_xshell_servers(&[srv("xshell-aaa", 22), srv("xshell-bbb", 2222)])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (2, 0, 0));
        assert_eq!(r.projects_created, 1, "根目录会话建「未命名项目」");
        // 原样再导：全部 unchanged（幂等），不重复建项目
        let r = store
            .merge_xshell_servers(&[srv("xshell-aaa", 22), srv("xshell-bbb", 2222)])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 0, 2));
        assert_eq!(r.projects_created, 0);
        // 配置有变化：覆盖并计 updated（不新增重复项）
        let r = store
            .merge_xshell_servers(&[srv("xshell-bbb", 22)])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 1, 0));
        // 新会话：imported；旧会话原样仍 unchanged
        let r = store
            .merge_xshell_servers(&[srv("xshell-aaa", 22), srv("xshell-ccc", 2200)])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (1, 0, 1));
        // 全部归入同一个「未命名项目」，绑定去重
        {
            let guard = store.state.lock().unwrap();
            let unnamed = guard
                .projects
                .iter()
                .find(|p| p.name == "未命名项目")
                .unwrap();
            assert_eq!(unnamed.server_ids.len(), 3, "三个会话都绑定且不重复");
        }
        // 内存状态与落盘一致
        assert_eq!(store.state.lock().unwrap().servers.len(), 3);
        let saved: AppState =
            serde_json::from_str(&fs::read_to_string(dir.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(saved.servers.len(), 3);
        assert_eq!(
            saved
                .servers
                .iter()
                .find(|s| s.id == "xshell-bbb")
                .unwrap()
                .port,
            22,
            "更新的配置应已持久化"
        );
    }

    #[test]
    fn merge_xshell_servers_does_not_touch_secrets() {
        let dir = temp_config_dir("xshell-merge-secrets");
        let store = test_store(dir);
        // 预置一条真实密钥，合并后必须原样保留（merge 绝不读写 SecretStore）
        store.secrets.set("server:xshell-keep", "pw").unwrap();
        store
            .merge_xshell_servers(&[ScannedSession {
                server: Server {
                    id: "xshell-keep".to_string(),
                    name: "K".to_string(),
                    host: "h".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "u".to_string(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                folder: String::new(),
            }])
            .unwrap();
        assert_eq!(store.secrets.get("server:xshell-keep").unwrap(), "pw");
    }

    #[test]
    fn xshell_import_result_serializes_camelcase() {
        let r = XshellImportResult {
            imported: 1,
            updated: 2,
            unchanged: 3,
            skipped: 4,
            needs_attention: 5,
            projects_created: 6,
        };
        let json = serde_json::to_string(&r).unwrap();
        for key in [
            "\"imported\":1",
            "\"updated\":2",
            "\"unchanged\":3",
            "\"skipped\":4",
            "\"needsAttention\":5",
            "\"projectsCreated\":6",
        ] {
            assert!(json.contains(key), "序列化缺少字段 {key}: {json}");
        }
    }

    #[test]
    fn save_settings_brave_key_semantics() {
        let dir = temp_config_dir("brave-key");
        let store = test_store(dir);
        // 未配置时 read_secret 报错
        assert!(store.read_secret("brave:apikey").is_err());
        // 保存 brave key（Some 覆盖）+ search.enabled 持久化
        store
            .save_settings(
                Settings {
                    workspace_dir: None,
                    llm: LlmConfig::default(),
                    search: SearchConfig { enabled: true },
                    theme: Theme::Dark,
                    auto_switch_ai_workdir: false,
                    project_view: ProjectView::List,
                    approval_mode: ApprovalMode::Smart,
                    auto_backup_remote_files: true,
                    compact_server_list: false,
                },
                None,
                Some("bsk-1"),
            )
            .unwrap();
        assert_eq!(store.read_secret("brave:apikey").unwrap(), "bsk-1");
        assert!(store.settings().search.enabled);
        // None 保持原值
        store
            .save_settings(
                Settings {
                    search: SearchConfig { enabled: false },
                    ..store.settings()
                },
                None,
                None,
            )
            .unwrap();
        assert_eq!(
            store.read_secret("brave:apikey").unwrap(),
            "bsk-1",
            "None 应保持原值"
        );
        assert!(!store.settings().search.enabled);
        // 空串视为覆盖（与 api_key 语义一致）
        store
            .save_settings(store.settings(), None, Some(""))
            .unwrap();
        assert_eq!(store.read_secret("brave:apikey").unwrap(), "");
    }

    #[test]
    fn old_settings_json_defaults_search_disabled() {
        // 旧版 aishell.json 无 search 字段 → 反序列化默认 enabled=false（无感升级）
        let old = r#"{"workspaceDir":"C:\\ws","llm":{"modelId":"deepseek-chat","baseUrl":"https://api.deepseek.com/v1","effort":"medium"},"theme":"dark"}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert!(!s.search.enabled);
        // 旧配置无 autoSwitchAiWorkdir 字段 → 默认开启（无感升级）
        assert!(s.auto_switch_ai_workdir);
        // 旧配置无 approvalMode 字段 → 默认智能审批（无感升级，且默认不扩大打扰）
        assert_eq!(s.approval_mode, ApprovalMode::Smart);
        assert_eq!(s.approval_mode.as_str(), "smart");
    }

    #[test]
    fn legacy_json_defaults_ai_mode_locked_actions() {
        // 旧版数据缺 aiMode / locked / actions → 分别默认 suggest / false / 空（无感升级，不扩大权限）
        let old = r#"{
            "settings": {"workspaceDir":null,"llm":{"modelId":"m","baseUrl":"u","effort":"low"},"search":{"enabled":false},"theme":"dark"},
            "servers":[{"id":"s1","name":"S","host":"h","port":22,"authType":"password","username":"u","keyPath":""}],
            "projects":[{"id":"p1","name":"P","path":null,"serverIds":[],"quickCommands":[]}],
            "sessions":{}
        }"#;
        let state: AppState = serde_json::from_str(old).unwrap();
        assert!(!state.servers[0].locked, "旧服务器默认未锁定");
        assert!(!state.servers[0].is_bastion, "旧服务器默认不是堡垒机");
        assert_eq!(
            state.servers[0].bastion_id, None,
            "旧服务器默认无堡垒机绑定"
        );
        assert_eq!(
            state.projects[0].ai_mode,
            AiMode::Suggest,
            "旧项目默认 suggest"
        );
        // 旧 ChatMsg 无 actions → 空
        let old_msg = r#"{"role":"assistant","content":"hi","snapshots":[],"fileRefs":[],"ts":1}"#;
        let msg: ChatMsg = serde_json::from_str(old_msg).unwrap();
        assert!(msg.actions.is_empty(), "旧消息默认无动作记录");
    }

    #[test]
    fn ai_mode_roundtrips_and_serializes_lowercase() {
        for (mode, literal) in [
            (AiMode::Suggest, "\"suggest\""),
            (AiMode::Agent, "\"agent\""),
            (AiMode::Yolo, "\"yolo\""),
        ] {
            assert_eq!(serde_json::to_string(&mode).unwrap(), literal);
            let back: AiMode = serde_json::from_str(literal).unwrap();
            assert_eq!(back, mode);
        }
        assert_eq!(AiMode::default(), AiMode::Suggest);
        // 非法字面量拒绝（fail-closed）
        assert!(serde_json::from_str::<AiMode>("\"yolo2\"").is_err());
        assert!(serde_json::from_str::<AiMode>("\"YOLO\"").is_err());
    }

    #[test]
    fn task_project_is_synthetic_fixed_path_and_agent_only() {
        let dir = temp_config_dir("task-project");
        let workspace =
            std::env::temp_dir().join(format!("aishell-store-task-ws-{}", std::process::id()));
        let _ = fs::remove_dir_all(&workspace);
        let store = test_store(dir.clone());
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(workspace.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        let task = store.task_project().unwrap();
        assert_eq!(task.id, TASK_PROJECT_ID);
        assert!(!TASK_PROJECT_ID.contains(':'), "任务项目 ID 不能含冒号");
        assert_eq!(task.name, "系统任务");
        assert_eq!(
            task.path.as_deref(),
            Some(workspace.join(".aishell").join("tasks").to_str().unwrap())
        );
        assert!(workspace
            .join(".aishell")
            .join("tasks")
            .join(".aishell")
            .is_dir());
        assert_eq!(store.project(TASK_PROJECT_ID), Some(task.clone()));
        assert_eq!(store.project_path(TASK_PROJECT_ID), task.path);
        assert_eq!(store.ai_mode(TASK_PROJECT_ID), Some(AiMode::Agent));
        assert!(store.projects_all().iter().all(|p| p.id != TASK_PROJECT_ID));
        assert!(store
            .state
            .lock()
            .unwrap()
            .projects
            .iter()
            .all(|p| p.id != TASK_PROJECT_ID));
        assert!(store.set_ai_mode(TASK_PROJECT_ID, AiMode::Agent).is_ok());
        assert_eq!(
            store
                .set_ai_mode(TASK_PROJECT_ID, AiMode::Yolo)
                .unwrap_err(),
            "系统任务上下文固定为工作模式"
        );
        assert_eq!(
            store
                .set_ai_mode(TASK_PROJECT_ID, AiMode::Suggest)
                .unwrap_err(),
            "系统任务上下文固定为工作模式"
        );
        let _ = fs::remove_dir_all(&workspace);
    }

    #[test]
    fn task_project_requires_workspace_and_reserved_id_rejected() {
        let dir = temp_config_dir("task-project-reject");
        let store = test_store(dir);
        assert_eq!(
            store.task_project().unwrap_err(),
            "请先在设置中配置工作区目录"
        );
        let task = Project {
            id: TASK_PROJECT_ID.to_string(),
            name: "伪造任务项目".to_string(),
            path: None,
            server_ids: Vec::new(),
            quick_commands: Vec::new(),
            folder: String::new(),
            ai_mode: AiMode::Yolo,
        };
        assert_eq!(
            store.upsert_project(task),
            Err("系统任务项目不可修改".to_string())
        );
        assert_eq!(
            store.delete_project(TASK_PROJECT_ID),
            Err("系统任务项目不可删除".to_string())
        );
        store
            .with_state(|s| {
                s.projects.push(Project {
                    id: TASK_PROJECT_ID.to_string(),
                    name: "历史任务项目".to_string(),
                    path: None,
                    server_ids: Vec::new(),
                    quick_commands: Vec::new(),
                    folder: String::new(),
                    ai_mode: AiMode::Agent,
                });
                Ok(())
            })
            .unwrap();
        assert!(store.projects_all().iter().all(|p| p.id != TASK_PROJECT_ID));
    }

    #[test]
    fn task_project_sessions_are_stored_without_project_record() {
        let dir = temp_config_dir("task-sessions");
        let store = test_store(dir.clone());
        let session = ChatSession {
            id: "task-session".to_string(),
            title: "迁移探查".to_string(),
            messages: vec![test_chat_msg("user", "只读探查")],
            auto_title_triggered: false,
            archived: false,
        };
        store
            .session_upsert(TASK_PROJECT_ID, session.clone())
            .unwrap();
        assert_eq!(store.sessions_get(TASK_PROJECT_ID).unwrap(), vec![session]);
        assert!(store
            .state
            .lock()
            .unwrap()
            .projects
            .iter()
            .all(|p| p.id != TASK_PROJECT_ID));
        let reloaded = test_store(dir);
        assert_eq!(reloaded.sessions_get(TASK_PROJECT_ID).unwrap().len(), 1);
    }

    #[test]
    fn set_ai_mode_updates_only_target_project() {
        let dir = temp_config_dir("ai-mode");
        let store = test_store(dir.clone());
        store
            .upsert_project(Project {
                id: "p-a".to_string(),
                name: "A".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();
        store
            .upsert_project(Project {
                id: "p-b".to_string(),
                name: "B".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();

        store.set_ai_mode("p-a", AiMode::Yolo).unwrap();
        assert_eq!(store.ai_mode("p-a"), Some(AiMode::Yolo));
        assert_eq!(
            store.ai_mode("p-b"),
            Some(AiMode::Suggest),
            "只改目标项目，其他项目不受影响"
        );
        // 落盘持久化
        let store2 = test_store(dir);
        assert_eq!(store2.ai_mode("p-a"), Some(AiMode::Yolo));
        // 项目不存在 → 中文错误
        let err = store2.set_ai_mode("p-missing", AiMode::Agent).unwrap_err();
        assert!(err.contains("项目不存在：p-missing"), "错误串不符: {err}");
    }

    #[test]
    fn set_server_locked_updates_only_target_server() {
        let dir = temp_config_dir("server-lock");
        let store = test_store(dir.clone());
        let srv = |id: &str| Server {
            id: id.to_string(),
            name: id.to_string(),
            host: "h".to_string(),
            port: 22,
            auth_type: AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        };
        store.upsert_server(srv("sv-a"), None).unwrap();
        store.upsert_server(srv("sv-b"), None).unwrap();

        store.set_server_locked("sv-a", true).unwrap();
        assert!(store.server("sv-a").unwrap().locked);
        assert!(!store.server("sv-b").unwrap().locked, "只改目标服务器");
        // 落盘持久化
        let store2 = test_store(dir);
        assert!(store2.server("sv-a").unwrap().locked);
        // 解锁
        store2.set_server_locked("sv-a", false).unwrap();
        assert!(!store2.server("sv-a").unwrap().locked);
        // 不存在 → 中文错误
        let err = store2.set_server_locked("sv-missing", true).unwrap_err();
        assert!(
            err.contains("服务器不存在：sv-missing"),
            "错误串不符: {err}"
        );
    }

    #[test]
    fn merge_xshell_servers_keeps_existing_lock() {
        let dir = temp_config_dir("xshell-merge-lock");
        let store = test_store(dir);
        // 预置一条已锁定的服务器
        store
            .upsert_server(
                Server {
                    id: "xshell-lock".to_string(),
                    name: "K".to_string(),
                    host: "h".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "u".to_string(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: true,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                None,
            )
            .unwrap();
        // Xshell 导入的同 ID 服务器 locked=false：连接配置合并，锁必须保留
        let r = store
            .merge_xshell_servers(&[ScannedSession {
                server: Server {
                    id: "xshell-lock".to_string(),
                    name: "K".to_string(),
                    host: "h".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "u".to_string(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                folder: String::new(),
            }])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 0, 1));
        assert!(
            store.server("xshell-lock").unwrap().locked,
            "重新导入绝不能解锁"
        );
        // 连接配置变化时同样保留锁
        let r = store
            .merge_xshell_servers(&[ScannedSession {
                server: Server {
                    id: "xshell-lock".to_string(),
                    name: "K2".to_string(),
                    host: "h".to_string(),
                    port: 2222,
                    auth_type: AuthType::Password,
                    username: "u".to_string(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                folder: String::new(),
            }])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 1, 0));
        let sv = store.server("xshell-lock").unwrap();
        assert_eq!(sv.name, "K2");
        assert_eq!(sv.port, 2222);
        assert!(sv.locked, "配置更新后锁仍保留");
    }
    // ---------------------------------------------------------------- 内置技能播种

    /// 首次保存 workspace 后精确产生 .aishell/skills/skill-management/SKILL.md。
    #[test]
    fn first_save_seeds_skill_management() {
        let dir = temp_config_dir("seed-first");
        let ws = temp_config_dir("seed-first-ws");
        let store = test_store(dir.clone());
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        let file = ws
            .join(".aishell")
            .join("skills")
            .join("skill-management")
            .join("SKILL.md");
        assert!(file.is_file(), "首次保存未播种内置技能");
        let py_file = ws
            .join(".aishell")
            .join("skills")
            .join("python-script")
            .join("SKILL.md");
        assert!(py_file.is_file(), "首次保存未播种 python-script 内置技能");
        let content = fs::read_to_string(&file).unwrap();
        // 内容含两个目录、目录结构、scope/enabled 语义
        assert!(
            content.contains("## 两个技能根目录"),
            "缺少目录说明: {content}"
        );
        assert!(
            content.contains("<name>/SKILL.md"),
            "缺少目录结构: {content}"
        );
        assert!(
            content.contains("## scope 语义"),
            "缺少 scope 语义: {content}"
        );
        assert!(
            content.contains("enabled") && content.contains("scope"),
            "缺少字段 schema"
        );
        // 播种记录已落盘（记录的是 normalize_ws 规范化路径 + 播种代际标记）
        let state: AppState =
            serde_json::from_str(&fs::read_to_string(dir.join("aishell.json")).unwrap()).unwrap();
        let expected_ws = normalize_ws(&ws.to_string_lossy());
        assert_eq!(
            state.seeded_skill_workspaces,
            vec![seed_marker(&expected_ws)],
            "播种记录不符: {:?}",
            state.seeded_skill_workspaces
        );
    }

    /// gen1 旧记录（裸 workspace，仅 skill-management 时代）：加载时按当前代际补种——
    /// python-script 落盘、skill-management 文件级幂等不覆盖；旧记录保留并追加新代际标记。
    #[test]
    fn legacy_bare_seed_record_triggers_reseed() {
        let dir = temp_config_dir("seed-gen1");
        let ws = temp_config_dir("seed-gen1-ws");
        let legacy = normalize_ws(&ws.to_string_lossy());
        let state = AppState {
            settings: Settings {
                workspace_dir: Some(ws.to_string_lossy().into_owned()),
                ..Default::default()
            },
            seeded_skill_workspaces: vec![legacy.clone()],
            ..Default::default()
        };
        fs::write(
            dir.join("aishell.json"),
            serde_json::to_string(&state).unwrap(),
        )
        .unwrap();
        let store = test_store(dir);
        assert!(
            ws.join(".aishell")
                .join("skills")
                .join("python-script")
                .join("SKILL.md")
                .is_file(),
            "旧工作区未补种 python-script"
        );
        let records = store.state.lock().unwrap().seeded_skill_workspaces.clone();
        assert_eq!(records.len(), 2, "旧记录保留 + 追加新代际标记: {records:?}");
        assert!(records.contains(&legacy), "旧记录被改写: {records:?}");
        assert!(
            records.contains(&seed_marker(&legacy)),
            "缺新代际标记: {records:?}"
        );
    }

    /// 目标已存在不覆盖；用户删除后同 workspace 重启/再次保存不复活。
    #[test]
    fn seed_never_overwrites_or_resurrects() {
        let dir = temp_config_dir("seed-keep");
        let ws = temp_config_dir("seed-keep-ws");
        let file = ws
            .join(".aishell")
            .join("skills")
            .join("skill-management")
            .join("SKILL.md");
        // 预置用户文件 → 保存设置不覆盖
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "用户自建的内容").unwrap();
        let store = test_store(dir.clone());
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            "用户自建的内容",
            "已存在文件被覆盖"
        );
        // 用户删除后：重启（重新加载）不复活
        fs::remove_dir_all(ws.join(".aishell")).unwrap();
        let _store2 = test_store(dir.clone());
        assert!(!file.exists(), "重启不应复活已删除的内置技能");
        // 再次保存设置同样不复活
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        assert!(!file.exists(), "再次保存不应复活已删除的内置技能");
    }

    /// 切换到从未播种的新 workspace 会播种；旧 workspace 记录保留。
    #[test]
    fn switching_workspace_seeds_new_one() {
        let dir = temp_config_dir("seed-switch");
        let ws1 = temp_config_dir("seed-switch-ws1");
        let ws2 = temp_config_dir("seed-switch-ws2");
        let store = test_store(dir.clone());
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws1.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws2.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        assert!(ws1
            .join(".aishell")
            .join("skills")
            .join("skill-management")
            .join("SKILL.md")
            .is_file());
        assert!(ws2
            .join(".aishell")
            .join("skills")
            .join("skill-management")
            .join("SKILL.md")
            .is_file());
        let state: AppState =
            serde_json::from_str(&fs::read_to_string(dir.join("aishell.json")).unwrap()).unwrap();
        assert_eq!(state.seeded_skill_workspaces.len(), 2);
        // 再切回 ws1：已播种 → 不再创建（幂等）
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws1.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        assert_eq!(state.seeded_skill_workspaces.len(), 2);
    }

    /// 播种写失败：save_settings 保持旧 workspace 与旧播种记录（整体回滚）。
    #[test]
    fn seed_failure_rolls_back_save_settings() {
        let dir = temp_config_dir("seed-fail");
        let ws1 = temp_config_dir("seed-fail-ws1");
        let ws2 = temp_config_dir("seed-fail-ws2");
        let store = test_store(dir.clone());
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws1.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        // 让新 workspace 播种必然失败：把 .aishell 预置为「文件」占位
        fs::write(ws2.join(".aishell"), "占位文件").unwrap();
        let err = store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws2.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap_err();
        assert!(
            err.contains("创建内置技能目录失败") || err.contains("创建技能根失败"),
            "错误串不符: {err}"
        );
        // 设置与播种记录保持旧值（ws1）
        let settings = store.settings();
        assert_eq!(
            settings.workspace_dir.as_deref(),
            Some(ws1.to_str().unwrap()),
            "失败后 workspace 被改成新值"
        );
        let state: AppState =
            serde_json::from_str(&fs::read_to_string(dir.join("aishell.json")).unwrap()).unwrap();
        assert_eq!(
            state.seeded_skill_workspaces.len(),
            1,
            "失败后播种记录被污染"
        );
        assert!(state.seeded_skill_workspaces[0].contains("seed-fail-ws1"));
    }

    /// 播种写失败：首次加载（with_secrets）返回错误，阻止以不完整状态启动。
    #[test]
    fn seed_failure_blocks_first_load() {
        let dir = temp_config_dir("seed-load-fail");
        let ws = temp_config_dir("seed-load-fail-ws");
        // 预置一个「已配置 workspace 但未播种」的 aishell.json
        let state = AppState {
            settings: Settings {
                workspace_dir: Some(ws.to_string_lossy().into_owned()),
                ..Default::default()
            },
            seeded_skill_workspaces: Vec::new(),
            ..Default::default()
        };
        fs::write(
            dir.join("aishell.json"),
            serde_json::to_string(&state).unwrap(),
        )
        .unwrap();
        // 让播种失败：.aishell 被文件占位
        fs::write(ws.join(".aishell"), "占位文件").unwrap();
        let res = Store::with_secrets(dir.clone(), std::sync::Arc::new(MemorySecrets::default()));
        let err = match res {
            Err(e) => e,
            Ok(_) => panic!("播种失败场景不应加载成功"),
        };
        assert!(err.contains("内置技能"), "错误串不符: {err}");
        // 修复后加载成功
        fs::remove_file(ws.join(".aishell")).unwrap();
        let store =
            Store::with_secrets(dir, std::sync::Arc::new(MemorySecrets::default())).unwrap();
        assert!(store.settings().workspace_dir.is_some());
    }

    /// 旧 aishell.json 无 seededSkillWorkspaces 可正常反序列化为空，且不触发播种。
    #[test]
    fn legacy_state_without_seed_field_parses_empty() {
        let dir = temp_config_dir("seed-legacy");
        let ws = temp_config_dir("seed-legacy-ws");
        // workspace 未配置 → 旧配置加载不播种
        let old = r#"{"settings":{"workspaceDir":null,"llm":{"modelId":"m","baseUrl":"u","effort":"low"},"search":{"enabled":false},"theme":"dark"},"servers":[],"projects":[],"sessions":{},"projectFolders":[],"commandFolders":[],"uiExpanded":{},"sftpHistory":{},"sftpFavorites":{},"dbConnections":{}}"#;
        fs::write(dir.join("aishell.json"), old).unwrap();
        let store = test_store(dir.clone());
        assert!(store
            .state
            .lock()
            .unwrap()
            .seeded_skill_workspaces
            .is_empty());
        // workspace 已配置但旧配置无播种字段 → 加载时播种一次并记录
        let state = AppState {
            settings: Settings {
                workspace_dir: Some(ws.to_string_lossy().into_owned()),
                ..Default::default()
            },
            ..Default::default()
        };
        fs::write(
            dir.join("aishell.json"),
            serde_json::to_string(&state).unwrap(),
        )
        .unwrap();
        let store = test_store(dir);
        assert!(ws
            .join(".aishell")
            .join("skills")
            .join("skill-management")
            .join("SKILL.md")
            .is_file());
        assert_eq!(store.state.lock().unwrap().seeded_skill_workspaces.len(), 1);
    }

    /// 旧 aishell.json 无 mcp / mcpDevices 字段：正常解析，MCP 默认全关、端口默认。
    #[test]
    fn legacy_state_without_mcp_fields_parses() {
        let dir = temp_config_dir("mcp-legacy");
        let old = r#"{"settings":{"workspaceDir":null,"llm":{"modelId":"m","baseUrl":"u","effort":"low"},"search":{"enabled":false},"theme":"dark"},"servers":[],"projects":[],"sessions":{},"projectFolders":[],"commandFolders":[],"uiExpanded":{},"sftpHistory":{},"sftpFavorites":{},"dbConnections":{}}"#;
        fs::write(dir.join("aishell.json"), old).unwrap();
        let store = test_store(dir.clone());
        assert_eq!(store.mcp_config().port, 8945, "旧配置端口应回落到默认 8945");
        assert_eq!(store.mcp_enabled_count(), 0, "旧配置无任何 MCP 设备");
        assert!(store.mcp_device("srv-x").is_none());
        // 落盘往返：默认 mcp 字段写回后仍可解析
        let back: AppState =
            serde_json::from_str(&fs::read_to_string(dir.join("aishell.json")).unwrap()).unwrap();
        assert_eq!(back.mcp.port, 8945);
        assert!(back.mcp_devices.is_empty());
    }

    /// MCP 设备配置保存/读取/级联删除。
    #[test]
    fn mcp_device_lifecycle_and_cascade() {
        let dir = temp_config_dir("mcp-device");
        let store = test_store(dir.clone());
        // 服务器不存在 → 拒绝
        assert!(store
            .set_mcp_device("ghost", McpDeviceConfig::default())
            .is_err());
        // 建服务器后保存设备配置
        store
            .upsert_server(
                Server {
                    id: "srv-mcp".to_string(),
                    name: "MCP 测试机".to_string(),
                    host: "10.0.0.1".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "root".to_string(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                    tags: Vec::new(),
                },
                Some("pw"),
            )
            .unwrap();
        let cfg = McpDeviceConfig {
            enabled: true,
            features: McpFeatures {
                exec: true,
                db_query: true,
                ..Default::default()
            },
        };
        store.set_mcp_device("srv-mcp", cfg.clone()).unwrap();
        assert_eq!(store.mcp_device("srv-mcp"), Some(cfg));
        assert_eq!(store.mcp_enabled_count(), 1);
        // 落盘往返
        let reload = test_store(dir.clone());
        assert!(reload.mcp_device("srv-mcp").unwrap().features.exec);
        // 删除服务器 → 设备配置级联清理
        reload.delete_server("srv-mcp").unwrap();
        assert!(reload.mcp_device("srv-mcp").is_none());
        assert_eq!(reload.mcp_enabled_count(), 0);
    }

    /// 端口校验与持久化。
    #[test]
    fn mcp_port_validate_and_persist() {
        let dir = temp_config_dir("mcp-port");
        let store = test_store(dir.clone());
        assert!(store.set_mcp_port(1023).is_err(), "低于 1024 应拒绝");
        store.set_mcp_port(1024).unwrap();
        store.set_mcp_port(65535).unwrap();
        assert_eq!(store.mcp_config().port, 65535);
        let reload = test_store(dir.clone());
        assert_eq!(reload.mcp_config().port, 65535);
    }

    /// MCP 令牌：ensure 生成且可复用、reset 生成新值、存 keyring 不入 JSON。
    #[test]
    fn mcp_token_ensure_reset_not_in_json() {
        let dir = temp_config_dir("mcp-token");
        let store = test_store(dir.clone());
        let t1 = store.mcp_token_ensure().unwrap();
        assert_eq!(t1.len(), 32, "令牌应为 32 字符十六进制");
        assert_eq!(
            store.mcp_token_ensure().unwrap(),
            t1,
            "重复 ensure 返回同一令牌"
        );
        let t2 = store.mcp_token_reset().unwrap();
        assert_eq!(t2.len(), 32);
        assert_ne!(t1, t2, "重置后令牌必须变化");
        assert_eq!(
            store.mcp_token_ensure().unwrap(),
            t2,
            "重置后 ensure 返回新令牌"
        );
        // 令牌不进 aishell.json（且令牌测试不应产生配置文件——从未触发 with_state 持久化）
        assert!(
            !dir.join("aishell.json").exists(),
            "令牌测试不应产生配置文件"
        );
    }

    /// 功能开关默认全关；tool_enabled 映射与设置页一致。
    #[test]
    fn mcp_features_default_off_and_mapping() {
        let f = McpFeatures::default();
        for tool in [
            "sftp_list",
            "sftp_upload",
            "sftp_download",
            "sftp_rename",
            "sftp_delete",
            "read_file",
            "write_file",
            "edit_file",
            "exec_command",
            "db_query",
        ] {
            assert!(!f.tool_enabled(tool), "{tool} 默认应关闭");
        }
        let on = McpFeatures {
            exec: true,
            db_query: true,
            ..Default::default()
        };
        assert!(on.tool_enabled("exec_command"));
        assert!(on.tool_enabled("db_query"));
        assert!(!on.tool_enabled("sftp_list"));
        assert!(!on.tool_enabled("未知工具"));
        // 中文清单
        let labels = on.enabled_labels();
        assert_eq!(labels, vec!["执行命令", "数据库查询"]);
    }

    /// 默认模型迁移：配置里仍是上一代默认值时加载即升级；用户自定义模型名不动。
    #[test]
    fn legacy_default_model_migrates_to_vision() {
        let dir = temp_config_dir("model-migrate");
        let llm = |id: &str| {
            format!(
                r#"{{"modelId":"{id}","baseUrl":"https://api.deepseek.com/v1","effort":"low"}}"#
            )
        };
        // 旧默认 → 升级并写回
        fs::write(
            dir.join("aishell.json"),
            format!(r#"{{"settings":{{"workspaceDir":null,"llm":{},"search":{{"enabled":false}},"theme":"dark"}},"servers":[],"projects":[],"sessions":{{}},"projectFolders":[],"commandFolders":[],"uiExpanded":{{}},"sftpHistory":{{}},"sftpFavorites":{{}},"dbConnections":{{}}}}"#, llm(LEGACY_DEFAULT_MODEL_ID)),
        )
        .unwrap();
        let store = test_store(dir.clone());
        assert_eq!(
            store.settings().llm.model_id,
            LlmConfig::default().model_id,
            "旧默认值应升级为当前默认"
        );
        drop(store);
        let raw = fs::read_to_string(dir.join("aishell.json")).unwrap();
        assert!(
            raw.contains("deepseek-v4-flash-vision-exp"),
            "迁移应写回配置文件"
        );

        // 自定义模型名 → 不动
        fs::write(
            dir.join("aishell.json"),
            format!(r#"{{"settings":{{"workspaceDir":null,"llm":{},"search":{{"enabled":false}},"theme":"dark"}},"servers":[],"projects":[],"sessions":{{}},"projectFolders":[],"commandFolders":[],"uiExpanded":{{}},"sftpHistory":{{}},"sftpFavorites":{{}},"dbConnections":{{}}}}"#, llm("deepseek-reasoner")),
        )
        .unwrap();
        let store = test_store(dir.clone());
        assert_eq!(
            store.settings().llm.model_id,
            "deepseek-reasoner",
            "自定义模型名不应被迁移"
        );
    }

    /// 旧会话消息无 imageRefs 字段按空解析；带 imageRefs 的消息往返不丢字段。
    #[test]
    fn chat_msg_image_refs_compat_roundtrip() {
        let old = r#"{"role":"user","content":"看图","snapshots":[],"fileRefs":[],"serverRefs":[],"pathRefs":[],"browserRefs":[],"skillRefs":[],"actions":[],"ts":1}"#;
        let msg: ChatMsg = serde_json::from_str(old).unwrap();
        assert!(msg.image_refs.is_empty(), "旧会话无 imageRefs 应按空解析");

        let with_img = r#"{"role":"user","content":"看图","snapshots":[],"fileRefs":[],"serverRefs":[],"pathRefs":[],"browserRefs":[],"skillRefs":[],"imageRefs":[{"id":"img-1","source":"remote","name":"a.png","mime":"image/png","path":"C:/x/.aishell/ai-images/1_a.png","originPath":"/srv/a.png","serverId":"srv-1","size":10,"ts":2}],"actions":[],"ts":1}"#;
        let msg: ChatMsg = serde_json::from_str(with_img).unwrap();
        assert_eq!(msg.image_refs.len(), 1);
        assert_eq!(msg.image_refs[0].server_id.as_deref(), Some("srv-1"));
        let back = serde_json::to_string(&msg).unwrap();
        assert!(
            back.contains("\"imageRefs\":"),
            "序列化应保留 camelCase 字段名"
        );
    }

    /// 浏览器历史记录合并语义：同 URL 置顶刷新时间且空标题不覆盖已知标题；
    /// 新地址插头部；超出 BROWSER_HISTORY_CAP 截尾；空 URL 忽略；落盘可重开。
    #[test]
    fn browser_history_record_merges_mru_and_caps() {
        let dir = temp_config_dir("browser-history");
        let store = test_store(dir.clone());
        store
            .record_browser_history("https://a.com/".into(), "A 页面".into())
            .unwrap();
        store
            .record_browser_history("https://b.com/".into(), String::new())
            .unwrap();
        // 重复访问 a：置顶；本次未带标题不应抹掉已知标题
        store
            .record_browser_history(" https://a.com/ ".into(), String::new())
            .unwrap();
        let list = store.browser_history_filtered("", 10);
        let urls: Vec<&str> = list.iter().map(|e| e.url.as_str()).collect();
        assert_eq!(urls, vec!["https://a.com/", "https://b.com/"], "MRU 应置顶");
        assert_eq!(list[0].title, "A 页面", "后到的空串不应覆盖已知标题");
        assert!(list[0].ts >= list[1].ts, "置顶条目时间戳不应更早");
        // 标题补填：b 后续带标题到达时写入
        store
            .record_browser_history("https://b.com/".into(), "B 页面".into())
            .unwrap();
        let list = store.browser_history_filtered("", 10);
        assert_eq!(list[0].title, "B 页面");
        // 空地址忽略
        store
            .record_browser_history("   ".into(), "无效".into())
            .unwrap();
        assert_eq!(
            store.browser_history_filtered("", usize::MAX).len(),
            2,
            "空 URL 不入历史"
        );
        // 超上限截尾：最新在前
        for i in 0..(BROWSER_HISTORY_CAP + 20) {
            store
                .record_browser_history(format!("https://x.com/{i}"), String::new())
                .unwrap();
        }
        let all = store.browser_history_filtered("", usize::MAX);
        assert_eq!(all.len(), BROWSER_HISTORY_CAP, "应截尾至上限");
        assert_eq!(all[0].url, format!("https://x.com/{}", BROWSER_HISTORY_CAP + 19));
        drop(store);
        // 原子落盘：用 MemorySecrets 重开（绝不走真实 keyring），记录仍在
        let reopened =
            Store::with_secrets(dir, std::sync::Arc::new(MemorySecrets::default())).unwrap();
        assert!(!reopened.browser_history_filtered("", usize::MAX).is_empty());
    }

    /// 浏览器历史过滤：URL 与标题均参与、大小写不敏感；空 query 不过滤保持 MRU 序。
    #[test]
    fn browser_history_filter_matches_url_or_title() {
        let entry = |url: &str, title: &str| BrowserHistoryEntry {
            url: url.to_string(),
            title: title.to_string(),
            ts: 0,
        };
        let entries = vec![
            entry("https://github.com/aishell/repo", "GitHub · AIShell"),
            entry("file:///C:/docs/intro.html", "新手入门"),
            entry("http://localhost:3000/api", ""),
            entry("https://example.com/Path?q=1", "Example 站点"),
        ];
        let hits = |q: &str| filter_browser_history(&entries, q, 8);
        assert_eq!(hits("GITHUB").len(), 1, "URL 应大小写不敏感匹配");
        assert_eq!(hits("github.com")[0].url, "https://github.com/aishell/repo");
        assert_eq!(
            hits("入门")[0].url,
            "file:///C:/docs/intro.html",
            "中文标题应可命中"
        );
        assert_eq!(
            hits("example.com/path")[0].url,
            "https://example.com/Path?q=1",
            "路径片段应可命中"
        );
        // 空 query = 最近记录原序返回，limit 截取生效
        let recent = filter_browser_history(&entries, "  ", 2);
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].url, "https://github.com/aishell/repo");
        assert!(hits("不存在关键词xyz").is_empty());
    }

    /// 旧 aishell.json 无 browserHistory 字段按空列表解析，不影响加载。
    #[test]
    fn legacy_state_without_browser_history_parses_empty() {
        let dir = temp_config_dir("legacy-bhist");
        let old = r#"{"settings":{"workspaceDir":null,"llm":{"modelId":"m","baseUrl":"u","effort":"low"},"search":{"enabled":false},"theme":"dark"},"servers":[],"projects":[],"sessions":{},"projectFolders":[],"commandFolders":[],"uiExpanded":{},"sftpHistory":{},"sftpFavorites":{},"dbConnections":{}}"#;
        fs::write(dir.join("aishell.json"), old).unwrap();
        let store = test_store(dir);
        assert!(store
            .state
            .lock()
            .unwrap()
            .browser_history
            .is_empty());
    }
}
