//! 数据层：AppState 持久化 + 密钥保管（keyring）。
//!
//! 契约：
//! - 数据模型与 src/types.ts 逐字段对齐（serde camelCase），字段名以 .proto/shared/mock.js 为准；
//! - 命令清单见 src/api.ts 的 store 段（命令名/参数名逐一对应，Tauri snake_case→camelCase 自动映射）；
//! - 持久化 <config_dir>/aishell.json，先写 .tmp 再 rename 原子替换；
//! - 密钥走 keyring（service "AIShell"，account: `server:<id>` / `llm:apikey`），永不进 JSON、永不返回前端。
//!
//! 命令注册由主 agent 在集成阶段统一做（lib.rs 的 generate_handler），本模块只暴露命令函数与类型。

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::State;

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
            _ => Err(serde::de::Error::unknown_variant(&s, &["low", "high", "max"])),
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

impl Default for LlmConfig {
    fn default() -> Self {
        Self {
            model_id: "deepseek-v4-flash".to_string(),
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
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
    /// 旧配置无此字段时按关闭处理
    #[serde(default)]
    pub auto_switch_ai_workdir: bool,
    /// 欢迎页项目视图（card/list）；旧配置无此字段按卡片视图。
    #[serde(default)]
    pub project_view: ProjectView,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthType {
    Password,
    Key,
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

impl AiMode {
    pub fn as_str(self) -> &'static str {
        match self {
            AiMode::Suggest => "suggest",
            AiMode::Agent => "agent",
            AiMode::Yolo => "yolo",
        }
    }
}

/// 服务器配置。**没有密码字段**——密码只存 keyring（account `server:<id>`）。
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
    /// AI 操作锁：仅约束 AI 发起的远程动作，不影响用户手动 SSH/SFTP；旧配置无此字段按未锁定。
    #[serde(default)]
    pub locked: bool,
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
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PathRef {
    pub path: String,
    pub is_dir: bool,
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
}

/// sessions: projectId -> Vec<ChatSession>
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub settings: Settings,
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
    /// SFTP 收藏夹：serverId → 收藏路径列表（按添加顺序，由前端维护）。
    /// 旧配置无此字段按空 map 解析。
    #[serde(default)]
    pub sftp_favorites: HashMap<String, Vec<String>>,
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

fn keyring_account_server(id: &str) -> String {
    format!("server:{id}")
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

// ---------------------------------------------------------------- Store

/// 线程安全（Send+Sync）：PathBuf + Mutex<AppState>。ssh/term 等模块持有 `Arc<Store>`。
pub struct Store {
    config_dir: PathBuf,
    state: Mutex<AppState>,
    secrets: std::sync::Arc<dyn SecretStore>,
}

const STATE_FILE: &str = "aishell.json";

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
        let state = match fs::read(&state_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|e| format!("配置文件 {STATE_FILE} 解析失败: {e}"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => AppState::default(),
            Err(e) => return Err(format!("读取配置文件失败: {e}")),
        };
        Ok(Self {
            config_dir,
            state: Mutex::new(state),
            secrets,
        })
    }

    /// 锁内变更状态并原子持久化；f 返回 Err 时不变更也不落盘。
    fn with_state<T>(&self, f: impl FnOnce(&mut AppState) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())?;
        let out = f(&mut guard)?;
        self.persist_locked(&guard)?;
        Ok(out)
    }

    /// 先写 aishell.json.tmp 再 rename，避免半截文件。
    fn persist_locked(&self, state: &AppState) -> Result<(), String> {
        let json = serde_json::to_string_pretty(state)
            .map_err(|e| format!("序列化状态失败: {e}"))?;
        let tmp = self.config_dir.join(format!("{STATE_FILE}.tmp"));
        fs::write(&tmp, json).map_err(|e| format!("写入临时文件失败: {e}"))?;
        fs::rename(&tmp, self.config_dir.join(STATE_FILE))
            .map_err(|e| format!("原子替换配置文件失败: {e}"))
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
    fn save_settings(
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
            s.settings = settings;
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

    /// 服务器已存在则更新，否则插入；password 为 Some 时写入 keyring，None 保持原值。
    pub fn upsert_server(&self, server: Server, password: Option<&str>) -> Result<(), String> {
        if let Some(pw) = password {
            self.secrets.set(&keyring_account_server(&server.id), pw)?;
        }
        self.with_state(|s| {
            match s.servers.iter_mut().find(|sv| sv.id == server.id) {
                Some(slot) => *slot = server,
                None => s.servers.push(server),
            }
            Ok(())
        })
    }

    /// 移除服务器、级联从所有 projects[].server_ids 移除、删 keyring 条目（不存在不算错）。
    fn delete_server(&self, id: &str) -> Result<(), String> {
        self.secrets.delete(&keyring_account_server(id))?;
        self.with_state(|s| {
            s.servers.retain(|sv| sv.id != id);
            for p in &mut s.projects {
                p.server_ids.retain(|sid| sid != id);
            }
            Ok(())
        })
    }

    /// 清除全部服务器配置：先删各服务器 keyring 密钥（失败即中止、state 未动），
    /// 再一次性清空 servers 并让所有 projects 解绑，原子落盘。
    pub fn clear_all_servers(&self) -> Result<(), String> {
        let ids: Vec<String> = self.with_state(|s| Ok(s.servers.iter().map(|sv| sv.id.clone()).collect()))?;
        for id in &ids {
            self.secrets.delete(&keyring_account_server(id))?;
        }
        self.with_state(|s| {
            s.servers.clear();
            for p in &mut s.projects {
                p.server_ids.clear();
            }
            Ok(())
        })
    }

    /// 分类目录名规范化：整体 trim、按 '/' 拆分、过滤空段后 join('/')（与前端表单同语义）。
    fn normalize_folder(name: &str) -> String {
        name.trim()
            .split('/')
            .filter(|seg| !seg.is_empty())
            .collect::<Vec<_>>()
            .join("/")
    }

    /// 新建项目分类目录：规范化名称；空串报错、重名报错；一次 with_state 原子落盘。
    pub fn create_project_folder(&self, name: &str) -> Result<(), String> {
        let folder = Self::normalize_folder(name);
        if folder.is_empty() {
            return Err("分类目录名称不能为空".to_string());
        }
        self.with_state(|s| {
            if s.project_folders.iter().any(|f| f == &folder) {
                return Err("分类目录已存在".to_string());
            }
            s.project_folders.push(folder);
            Ok(())
        })
    }

    /// 重命名项目分类目录：级联改写所有 folder==old 的项目（含历史 JSON 里产生的、不在
    /// project_folders 列表里的旧值），并同步列表（old 移除、new 不存在才追加）。
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
        self.with_state(|s| {
            if s.project_folders.iter().any(|f| f == &folder) {
                return Err("分类目录已存在".to_string());
            }
            for p in &mut s.projects {
                if p.folder == old {
                    p.folder = folder.clone();
                }
            }
            s.project_folders.retain(|f| f != old);
            if !s.project_folders.iter().any(|f| f == &folder) {
                s.project_folders.push(folder);
            }
            Ok(())
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
            if s
                .projects
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

    /// 写入某服务器的 SFTP 收藏夹路径（按添加顺序）。
    /// 前端防抖后调用，仅覆盖该 serverId 不影响其他服务器。一次 with_state 原子落盘。
    pub fn set_sftp_favorites(&self, server_id: String, paths: Vec<String>) -> Result<(), String> {
        if server_id.is_empty() {
            return Err("服务器 ID 不能为空".to_string());
        }
        self.with_state(|s| {
            s.sftp_favorites.insert(server_id, paths);
            Ok(())
        })
    }

    /// 批量合并 Xshell 导入的服务器并按其目录自动建项目：一次 with_state 原子持久化，不触碰 SecretStore。
    /// 服务器合并语义：ID 已存在 → 连接配置以导入为准，但**保留现有 AI 锁**（重新导入绝不能解锁）；
    /// 配置完全一致（含锁位）→ unchanged；存在差异 → 覆盖并计 updated；不存在 → imported。
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
                        merged.locked = slot.locked;
                        if *slot == merged {
                            result.unchanged += 1;
                        } else {
                            *slot = merged;
                            result.updated += 1;
                        }
                    }
                    None => {
                        s.servers.push(sv.clone());
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
            if !project_folder.is_empty() && !s.project_folders.iter().any(|x| x == &project_folder) {
                s.project_folders.push(project_folder);
            }
            Ok(())
        })
    }

    /// 删除项目并顺带清理该项目的 sessions。
    fn delete_project(&self, id: &str) -> Result<(), String> {
        self.with_state(|s| {
            s.projects.retain(|p| p.id != id);
            s.sessions.remove(id);
            Ok(())
        })
    }

    /// path 为 Some → 在该目录下创建 .aishell/；为 None → 用 <workspace_dir>/<name> 并创建（含 .aishell/）。
    /// 目录已存在不报错。返回最终项目路径。
    fn ensure_project_dirs(&self, path: Option<&str>, name: &str) -> Result<String, String> {
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

    fn sessions_get(&self, project_id: &str) -> Result<Vec<ChatSession>, String> {
        let guard = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())?;
        Ok(guard.sessions.get(project_id).cloned().unwrap_or_default())
    }

    fn session_upsert(&self, project_id: &str, session: ChatSession) -> Result<(), String> {
        self.with_state(|s| {
            let list = s.sessions.entry(project_id.to_string()).or_default();
            match list.iter_mut().find(|x| x.id == session.id) {
                Some(slot) => *slot = session,
                None => list.push(session),
            }
            Ok(())
        })
    }

    // ---------------------------------------------------------- 下游模块 API
    // ssh.rs / sftp.rs / ai.rs 依赖以下 pub 方法（SshManager::new(store: Arc<Store>)）。

    /// 取服务器配置（clone 返回，不含密码）；不存在返回 None。
    pub fn server(&self, id: &str) -> Option<Server> {
        let guard = self.state.lock().ok()?;
        guard.servers.iter().find(|sv| sv.id == id).cloned()
    }

    /// 读 keyring 密钥；account 形如 `server:<id>` / `llm:apikey`（service "AIShell"）。
    pub fn read_secret(&self, account: &str) -> Result<String, String> {
        self.secrets.get(account)
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

    /// 当前全局设置（clone）。
    pub fn settings(&self) -> Settings {
        let guard = self
            .state
            .lock()
            .map_err(|_| "store 状态锁损坏".to_string())
            .expect("store 状态锁损坏");
        guard.settings.clone()
    }

    /// 项目本地路径；未设置或项目不存在返回 None。
    pub fn project_path(&self, project_id: &str) -> Option<String> {
        let guard = self.state.lock().ok()?;
        guard
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .and_then(|p| p.path.clone())
    }

    /// 项目配置（clone 返回）；不存在返回 None。
    pub fn project(&self, project_id: &str) -> Option<Project> {
        let guard = self.state.lock().ok()?;
        guard.projects.iter().find(|p| p.id == project_id).cloned()
    }

    /// 项目 AI 模式；项目不存在返回 None。
    pub fn ai_mode(&self, project_id: &str) -> Option<AiMode> {
        let guard = self.state.lock().ok()?;
        guard
            .projects
            .iter()
            .find(|p| p.id == project_id)
            .map(|p| p.ai_mode)
    }

    /// 原子更新单个项目的 ai_mode（只改目标字段，不回传整个 Project）。
    pub fn set_ai_mode(&self, project_id: &str, mode: AiMode) -> Result<(), String> {
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
    server: Server,
    password: Option<String>,
) -> Result<(), String> {
    store.upsert_server(server, password.as_deref())
}

#[tauri::command]
pub async fn delete_server(store: State<'_, Arc<Store>>, id: String) -> Result<(), String> {
    store.delete_server(&id)
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
    paths: Vec<String>,
) -> Result<(), String> {
    store.set_sftp_favorites(server_id, paths)
}

#[tauri::command]
pub async fn clear_all_servers(store: State<'_, Arc<Store>>) -> Result<(), String> {
    store.clear_all_servers()
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;


    /// 造一个独立的临时配置目录（按 pid+tag 命名，测试间不冲突；不触碰真实用户配置）。
    fn temp_config_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aishell-store-test-{tag}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
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
            },
            servers: vec![
                Server {
                    id: "srv-1".to_string(),
                    name: "生产-Web-01".to_string(),
                    host: "47.102.118.66".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "deploy".to_string(),
                    key_path: String::new(),
                    locked: false,
                },
                Server {
                    id: "srv-2".to_string(),
                    name: "测试-K8s-Node".to_string(),
                    host: "192.168.10.21".to_string(),
                    port: 2222,
                    auth_type: AuthType::Key,
                    username: "ubuntu".to_string(),
                    key_path: "C:\\Users\\demo\\.ssh\\id_ed25519".to_string(),
                    locked: false,
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
                            }],
                            actions: vec![AiActionRecord {
                                tool_call_id: "call-1".to_string(),
                                tool: "run_command".to_string(),
                                intent: "查看版本".to_string(),
                                summary: "执行命令：node -v".to_string(),
                                status: "succeeded".to_string(),
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
        assert_eq!(guard.settings.llm.model_id, "deepseek-v4-flash");
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
        let store = test_store(dir);
        assert!(!store.is_config_complete());
        store
            .save_settings(
                Settings {
                    workspace_dir: Some("C:\\ws".to_string()),
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
    fn delete_server_cascades_and_clears_keyring() {
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
                    locked: false,
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
                    locked: false,
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

        // 删除前密钥库里确实有密码
        assert_eq!(store.read_secret("server:srv-c-1").unwrap(), "pw-1");

        store.delete_server("srv-c-1").unwrap();

        let guard = store.state.lock().unwrap();
        assert_eq!(guard.servers.len(), 1);
        assert_eq!(guard.servers[0].id, "srv-c-2");
        assert_eq!(guard.projects[0].server_ids, vec!["srv-c-2".to_string()]);
        drop(guard);
        // 密钥条目已删（再读应报 NoEntry 类错误）
        assert!(store.read_secret("server:srv-c-1").is_err());
        // 删除不存在的服务器不算错
        store.delete_server("srv-c-404").unwrap();
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
            locked: false,
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
    fn create_project_folder_normalizes_and_rejects_invalid() {
        let dir = temp_config_dir("proj-folder-create");
        let store = test_store(dir.clone());
        // 空串 / 纯分隔符 → 中文错误
        assert_eq!(store.create_project_folder("  ").unwrap_err(), "分类目录名称不能为空");
        assert_eq!(store.create_project_folder("///").unwrap_err(), "分类目录名称不能为空");
        // 规范化：trim + 去空段；支持层级
        store.create_project_folder(" 生产环境/Web ").unwrap();
        store.create_project_folder("a//b/").unwrap();
        {
            let guard = store.state.lock().unwrap();
            assert_eq!(
                guard.project_folders,
                vec!["生产环境/Web".to_string(), "a/b".to_string()]
            );
        }
        // 重名（规范化后相同）报错，且列表不变
        assert_eq!(store.create_project_folder("生产环境/Web").unwrap_err(), "分类目录已存在");
        assert_eq!(
            store.state.lock().unwrap().project_folders,
            vec!["生产环境/Web".to_string(), "a/b".to_string()]
        );
        // 落盘后重载一致
        let reloaded = test_store(dir);
        assert_eq!(
            reloaded.state.lock().unwrap().project_folders,
            vec!["生产环境/Web".to_string(), "a/b".to_string()]
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
        store.rename_project_folder("生产环境", " 生产环境//Web ").unwrap();

        let guard = store.state.lock().unwrap();
        assert_eq!(guard.project_folders, vec!["生产环境/Web".to_string()]);
        assert_eq!(
            guard.projects.iter().find(|p| p.id == "proj-r-1").unwrap().folder,
            "生产环境/Web"
        );
        assert_eq!(guard.projects.iter().find(|p| p.id == "proj-r-2").unwrap().folder, "");
        drop(guard);
        // 落盘后重载一致
        let reloaded = test_store(dir);
        let guard = reloaded.state.lock().unwrap();
        assert_eq!(guard.project_folders, vec!["生产环境/Web".to_string()]);
        assert_eq!(
            guard.projects.iter().find(|p| p.id == "proj-r-1").unwrap().folder,
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
        assert_eq!(store.rename_project_folder("", "x").unwrap_err(), "未分类目录不可重命名");
        // 目标已存在且 ≠ old → 报错
        assert_eq!(store.rename_project_folder("甲", "乙").unwrap_err(), "分类目录已存在");
        // new 规范化后为空 → 报错
        assert_eq!(store.rename_project_folder("甲", " / ").unwrap_err(), "分类目录名称不能为空");
        // new 规范化后与 old 相同 → no-op，列表不变
        store.rename_project_folder("甲", " 甲 ").unwrap();
        let guard = store.state.lock().unwrap();
        assert_eq!(guard.project_folders, vec!["甲".to_string(), "乙".to_string()]);
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
        assert_eq!(store.delete_project_folder("").unwrap_err(), "未分类目录不可删除");
        assert_eq!(store.delete_project_folder(" / ").unwrap_err(), "分类目录名称不能为空");
        // 不存在的目录视为幂等成功
        store.delete_project_folder("不存在的目录").unwrap();
        // 删除成功：入参规范化，仅移除匹配项
        store.delete_project_folder(" 开发环境/Web ").unwrap();
        {
            let guard = store.state.lock().unwrap();
            assert_eq!(guard.project_folders, vec!["生产环境".to_string()]);
        }
        // 落盘后重载一致
        let reloaded = test_store(dir);
        assert_eq!(
            reloaded.state.lock().unwrap().project_folders,
            vec!["生产环境".to_string()]
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
    fn clear_all_servers_wipes_servers_and_keyring() {
        let dir = temp_config_dir("clear-all");
        let store = test_store(dir.clone());
        // 两台服务器（一台带密码）+ 一个已绑定项目
        store
            .upsert_server(
                Server {
                    id: "srv-cl-1".to_string(),
                    name: "A".to_string(),
                    host: "h1".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "u".to_string(),
                    key_path: String::new(),
                    locked: false,
                },
                Some("pw-1"),
            )
            .unwrap();
        store
            .upsert_server(
                Server {
                    id: "srv-cl-2".to_string(),
                    name: "B".to_string(),
                    host: "h2".to_string(),
                    port: 22,
                    auth_type: AuthType::Key,
                    username: "u".to_string(),
                    key_path: "C:\\key".to_string(),
                    locked: false,
                },
                None,
            )
            .unwrap();
        store
            .upsert_project(Project {
                id: "proj-cl-1".to_string(),
                name: "P".to_string(),
                path: None,
                server_ids: vec!["srv-cl-1".to_string(), "srv-cl-2".to_string()],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: AiMode::Suggest,
            })
            .unwrap();
        assert_eq!(store.read_secret("server:srv-cl-1").unwrap(), "pw-1");

        store.clear_all_servers().unwrap();

        // state：servers 清空，项目保留但解绑
        let guard = store.state.lock().unwrap();
        assert!(guard.servers.is_empty());
        assert_eq!(guard.projects.len(), 1);
        assert!(guard.projects[0].server_ids.is_empty());
        drop(guard);
        // keyring：全部删除
        assert!(store.read_secret("server:srv-cl-1").is_err());
        assert!(store.read_secret("server:srv-cl-2").is_err());
        // 落盘可重载且一致
        let reloaded = test_store(dir);
        let guard = reloaded.state.lock().unwrap();
        assert!(guard.servers.is_empty());
        assert!(guard.projects[0].server_ids.is_empty());
        // 幂等：空库再清不算错
        drop(guard);
        reloaded.clear_all_servers().unwrap();
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
            locked: false,
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
            let web = guard.projects.iter().find(|p| p.name == "生产环境/Web").unwrap();
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
            let unnamed = guard.projects.iter().find(|p| p.name == "未命名项目").unwrap();
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
            let web = guard.projects.iter().find(|p| p.name == "生产环境/Web").unwrap();
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
        let pre = guard.projects.iter().find(|p| p.name == "预置目录").unwrap();
        assert_eq!(pre.id, "proj-pre", "复用已有项目而非新建");
        assert_eq!(pre.path, Some("D:\\existing".to_string()), "复用不覆盖原字段");
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
        assert!(state.project_folders.is_empty(), "旧 serverFolders 不映射到 project_folders");
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
            .set_ui_expanded("welcome:projectGroups".to_string(), vec!["生产环境".to_string()])
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
        assert!(back.sftp_history.is_empty(), "旧 JSON 无 sftpHistory 按空 map");
        assert!(back.sftp_favorites.is_empty(), "旧 JSON 无 sftpFavorites 按空 map");
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
        store
            .set_sftp_history("srv-1".to_string(), vec![])
            .unwrap();
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
        // 写入后重载 store：收藏夹仍在，且不影响其他服务器
        let dir = temp_config_dir("sftp-favorites-persist");
        let store = test_store(dir.clone());
        store
            .set_sftp_favorites("srv-1".to_string(), vec!["/data".to_string(), "/backup".to_string()])
            .unwrap();
        // 空 serverId 拒绝
        assert!(store
            .set_sftp_favorites(String::new(), vec!["/data".to_string()])
            .is_err());
        let reloaded = test_store(dir.clone());
        let guard = reloaded.state.lock().unwrap();
        assert_eq!(
            guard.sftp_favorites.get("srv-1").unwrap(),
            &vec!["/data".to_string(), "/backup".to_string()],
            "收藏路径按添加顺序保留"
        );
        // 覆盖写（取消收藏后列表变短）同样落盘
        drop(guard);
        store
            .set_sftp_favorites("srv-1".to_string(), vec!["/data".to_string()])
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
            &vec!["/data".to_string()],
            "覆盖写后落盘为新列表"
        );
    }

    #[test]
    fn create_command_folder_normalizes_and_rejects_invalid() {
        let dir = temp_config_dir("qc-folder-create");
        let store = test_store(dir.clone());
        // 空串 / 纯分隔符 → 中文错误
        assert_eq!(store.create_command_folder("  ").unwrap_err(), "分类目录名称不能为空");
        assert_eq!(store.create_command_folder("///").unwrap_err(), "分类目录名称不能为空");
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
        assert_eq!(store.create_command_folder("常用/部署").unwrap_err(), "分类目录已存在");
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
        assert_eq!(store.rename_command_folder("", "x").unwrap_err(), "未分类目录不可重命名");
        // 目标已存在且 ≠ old → 报错
        assert_eq!(store.rename_command_folder("甲", "乙").unwrap_err(), "分类目录已存在");
        // new 规范化后为空 → 报错
        assert_eq!(store.rename_command_folder("甲", " / ").unwrap_err(), "分类目录名称不能为空");
        // new 规范化后与 old 相同 → no-op，列表不变
        store.rename_command_folder("甲", " 甲 ").unwrap();
        let guard = store.state.lock().unwrap();
        assert_eq!(guard.command_folders, vec!["甲".to_string(), "乙".to_string()]);
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
        assert_eq!(store.delete_command_folder("").unwrap_err(), "未分类目录不可删除");
        assert_eq!(store.delete_command_folder(" / ").unwrap_err(), "分类目录名称不能为空");
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
    fn sessions_upsert_and_delete_project_cleanup() {
        let dir = temp_config_dir("sessions");
        let store = test_store(dir);
        let sess = ChatSession {
            id: "sess-x".to_string(),
            title: "T".to_string(),
            messages: vec![],
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
    fn old_chat_msg_without_file_refs_parses_with_empty_vec() {
        // 旧版会话消息无 fileRefs 字段 → serde(default) 兜底为空（无感升级）
        let old = r#"{"role":"user","content":"看看日志","snapshots":[{"id":"snap-1","command":"tail -20 app.log","content":"INFO","ts":1752000000000}],"ts":1752000000001}"#;
        let msg: ChatMsg = serde_json::from_str(old).unwrap();
        assert_eq!(msg.role, "user");
        assert_eq!(msg.snapshots.len(), 1);
        assert!(msg.file_refs.is_empty(), "旧数据应兼容为空引用列表");
        assert!(msg.server_refs.is_empty(), "旧数据应兼容为空服务器引用列表");
        assert!(msg.path_refs.is_empty(), "旧数据应兼容为空路径引用列表");
    }

    #[test]
    fn downstream_accessors() {
        let dir = temp_config_dir("accessors");
        let store = test_store(dir);
        store
            .save_settings(
                Settings {
                    workspace_dir: Some("C:\\ws".to_string()),
                    llm: LlmConfig {
                        model_id: "deepseek-reasoner".to_string(),
                        base_url: "https://api.deepseek.com/v1".to_string(),
                        effort: Effort::High,
                    },
                    search: SearchConfig { enabled: false },
                    theme: Theme::Dark,
                    auto_switch_ai_workdir: false,
                    project_view: ProjectView::Card,
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
                    locked: false,
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
                locked: false,
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
        let r = store.merge_xshell_servers(&[srv("xshell-bbb", 22)]).unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 1, 0));
        // 新会话：imported；旧会话原样仍 unchanged
        let r = store
            .merge_xshell_servers(&[srv("xshell-aaa", 22), srv("xshell-ccc", 2200)])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (1, 0, 1));
        // 全部归入同一个「未命名项目」，绑定去重
        {
            let guard = store.state.lock().unwrap();
            let unnamed = guard.projects.iter().find(|p| p.name == "未命名项目").unwrap();
            assert_eq!(unnamed.server_ids.len(), 3, "三个会话都绑定且不重复");
        }
        // 内存状态与落盘一致
        assert_eq!(store.state.lock().unwrap().servers.len(), 3);
        let saved: AppState =
            serde_json::from_str(&fs::read_to_string(dir.join(STATE_FILE)).unwrap()).unwrap();
        assert_eq!(saved.servers.len(), 3);
        assert_eq!(
            saved.servers.iter().find(|s| s.id == "xshell-bbb").unwrap().port,
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
                    locked: false,
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
        store.save_settings(store.settings(), None, Some("")).unwrap();
        assert_eq!(store.read_secret("brave:apikey").unwrap(), "");
    }

    #[test]
    fn old_settings_json_defaults_search_disabled() {
        // 旧版 aishell.json 无 search 字段 → 反序列化默认 enabled=false（无感升级）
        let old = r#"{"workspaceDir":"C:\\ws","llm":{"modelId":"deepseek-chat","baseUrl":"https://api.deepseek.com/v1","effort":"medium"},"theme":"dark"}"#;
        let s: Settings = serde_json::from_str(old).unwrap();
        assert!(!s.search.enabled);
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
        assert_eq!(state.projects[0].ai_mode, AiMode::Suggest, "旧项目默认 suggest");
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
            locked: false,
        };
        store.upsert_server(srv("sv-a"), None).unwrap();
        store.upsert_server(srv("sv-b"), None).unwrap();

        store.set_server_locked("sv-a", true).unwrap();
        assert!(store.server("sv-a").unwrap().locked);
        assert!(
            !store.server("sv-b").unwrap().locked,
            "只改目标服务器"
        );
        // 落盘持久化
        let store2 = test_store(dir);
        assert!(store2.server("sv-a").unwrap().locked);
        // 解锁
        store2.set_server_locked("sv-a", false).unwrap();
        assert!(!store2.server("sv-a").unwrap().locked);
        // 不存在 → 中文错误
        let err = store2.set_server_locked("sv-missing", true).unwrap_err();
        assert!(err.contains("服务器不存在：sv-missing"), "错误串不符: {err}");
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
                    locked: true,
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
                    locked: false,
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
                    locked: false,
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
}
