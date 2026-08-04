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
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuickCommand {
    pub id: String,
    pub title: String,
    pub command: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: Option<String>,
    pub server_ids: Vec<String>,
    pub quick_commands: Vec<QuickCommand>,
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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
    pub snapshots: Vec<TermSnapshot>,
    /// 旧会话无此字段时按空处理
    #[serde(default)]
    pub file_refs: Vec<FileRef>,
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

    /// 批量合并 Xshell 导入的服务器：一次 with_state 原子持久化，不触碰 SecretStore。
    /// ID 已存在 → 连接配置以导入为准，但**保留现有 AI 锁**（重新导入绝不能解锁）；
    /// 配置完全一致（含锁位）→ unchanged；存在差异 → 覆盖并计 updated；不存在 → imported。
    pub(crate) fn merge_xshell_servers(&self, servers: &[Server]) -> Result<XshellImportResult, String> {
        let mut result = XshellImportResult::default();
        self.with_state(|s| {
            for sv in servers {
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
            Ok(result)
        })
    }

    pub fn upsert_project(&self, project: Project) -> Result<(), String> {
        self.with_state(|s| {
            match s.projects.iter_mut().find(|p| p.id == project.id) {
                Some(slot) => *slot = project,
                None => s.projects.push(project),
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
pub fn get_config_dir(store: State<'_, Arc<Store>>) -> String {
    store.config_dir.to_string_lossy().into_owned()
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
                }],
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
                            actions: vec![AiActionRecord {
                                tool_call_id: "call-1".to_string(),
                                tool: "run_command".to_string(),
                                intent: "查看版本".to_string(),
                                summary: "执行命令：node -v".to_string(),
                                status: "succeeded".to_string(),
                            }],
                            ts: 1_752_000_000_001,
                        }],
                    }],
                );
                m
            },
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
        let srv = |id: &str, port: u16| Server {
            id: id.to_string(),
            name: id.to_string(),
            host: format!("10.0.0.{}", port % 250 + 1),
            port,
            auth_type: AuthType::Password,
            username: "root".to_string(),
            key_path: String::new(),
            locked: false,
        };
        // 首次：全部 imported
        let r = store
            .merge_xshell_servers(&[srv("xshell-aaa", 22), srv("xshell-bbb", 2222)])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (2, 0, 0));
        // 原样再导：全部 unchanged（幂等）
        let r = store
            .merge_xshell_servers(&[srv("xshell-aaa", 22), srv("xshell-bbb", 2222)])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 0, 2));
        // 配置有变化：覆盖并计 updated（不新增重复项）
        let r = store.merge_xshell_servers(&[srv("xshell-bbb", 22)]).unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 1, 0));
        // 新会话：imported；旧会话原样仍 unchanged
        let r = store
            .merge_xshell_servers(&[srv("xshell-aaa", 22), srv("xshell-ccc", 2200)])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (1, 0, 1));
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
            .merge_xshell_servers(&[Server {
                id: "xshell-keep".to_string(),
                name: "K".to_string(),
                host: "h".to_string(),
                port: 22,
                auth_type: AuthType::Password,
                username: "u".to_string(),
                key_path: String::new(),
                locked: false,
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
        };
        let json = serde_json::to_string(&r).unwrap();
        for key in [
            "\"imported\":1",
            "\"updated\":2",
            "\"unchanged\":3",
            "\"skipped\":4",
            "\"needsAttention\":5",
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
            .merge_xshell_servers(&[Server {
                id: "xshell-lock".to_string(),
                name: "K".to_string(),
                host: "h".to_string(),
                port: 22,
                auth_type: AuthType::Password,
                username: "u".to_string(),
                key_path: String::new(),
                locked: false,
            }])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 0, 1));
        assert!(
            store.server("xshell-lock").unwrap().locked,
            "重新导入绝不能解锁"
        );
        // 连接配置变化时同样保留锁
        let r = store
            .merge_xshell_servers(&[Server {
                id: "xshell-lock".to_string(),
                name: "K2".to_string(),
                host: "h".to_string(),
                port: 2222,
                auth_type: AuthType::Password,
                username: "u".to_string(),
                key_path: String::new(),
                locked: false,
            }])
            .unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 1, 0));
        let sv = store.server("xshell-lock").unwrap();
        assert_eq!(sv.name, "K2");
        assert_eq!(sv.port, 2222);
        assert!(sv.locked, "配置更新后锁仍保留");
    }
}
