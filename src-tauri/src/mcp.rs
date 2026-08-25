//! MCP 服务端（Model Context Protocol，Streamable HTTP 传输，仅绑定 127.0.0.1）。
//!
//! 把用户在「服务器卡片 → 更多 → MCP」中启用的服务器暴露给外部 agent 工具
//! （Cursor / Claude / 自研 agent 等），接入方式：
//!   URL: `http://127.0.0.1:<port>/mcp`，请求头 `Authorization: Bearer <令牌>`。
//!
//! 契约与边界（与 ai_actions.rs 同一安全哲学，入口处统一裁决）：
//! - 每次工具调用按顺序校验：服务器存在 → 设备已启用 → `server.locked` 拒绝（与 AI 锁同语义）
//!   → 单项功能开关（store.rs McpFeatures）→ 执行；
//! - 工具输出过 known_secrets 脱敏 + 256KB 截断；write_file 内容上限 5MB（对齐 MAX_EDIT_BYTES）；
//! - 上传/下载的本地侧路径必须位于 MCP 传输目录内（<workspace>/.aishell/mcp-transfer 或
//!   <config_dir>/mcp-transfer），复用 ai_actions 的 normalize_path / ensure_inside；
//! - 数据库查询复用 AiActions::db_query（命令白名单 + keyring 凭据 + SSH 本机客户端执行）；
//! - 令牌存 keyring（`mcp:token`，store.rs），每次请求现读，重置立即生效。
//!
//! 传输实现：hyper 1（依赖树已有），stateless 子集（无 Mcp-Session-Id）：
//! initialize / notifications/* / tools/list / tools/call / ping；GET/DELETE → 405；
//! OPTIONS → CORS 预检。JSON-RPC dispatcher（handle_jsonrpc）与传输解耦，可复用做 stdio 桥。
//!
//! 前端契约：src/api.ts 的 mcp 段（mcp_set_device / mcp_status / mcp_ensure_token /
//! mcp_reset_token / mcp_set_port）；src/types.ts 的 McpStatus 与本文件 McpStatus 对齐。

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use tokio::net::TcpListener;

use crate::ai_actions::AiActions;
use crate::ssh::SshManager;
use crate::staging::RemoteStaging;
use crate::store::{AuthType, McpDeviceConfig, Store};

/// exec_command 默认超时（秒）与上限（对齐 ai_actions 的 1–3600 语义）。
const DEFAULT_EXEC_TIMEOUT_SECS: u64 = 30;
const MAX_EXEC_TIMEOUT_SECS: u64 = 3600;
/// write_file / edit_file 内容上限（对齐 fsops::MAX_EDIT_BYTES 的 5MB 编辑约束）。
const MAX_MCP_WRITE_BYTES: usize = 5 * 1024 * 1024;
/// HTTP 请求体上限（内容 5MB + 协议余量）。
const MAX_HTTP_BODY_BYTES: usize = 8 * 1024 * 1024;
/// 工具文本输出截断上限。
const MAX_TOOL_TEXT_BYTES: usize = 256 * 1024;

/// 支持的 MCP 协议版本：回显客户端请求的版本；未知版本回落到最新。
const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL_VERSION: &str = "2025-06-18";

type BoxBodyRes = BoxBody<Bytes, std::io::Error>;

/// MCP 服务状态（mcp_status 返回，与 src/types.ts McpStatus camelCase 对齐）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpStatus {
    /// 是否正在监听
    pub running: bool,
    /// 配置端口（store.mcp.port）
    pub port: u16,
    /// 实际绑定端口（仅运行中）
    pub bound_port: Option<u16>,
    /// 启动失败原因（如端口被占用）
    pub error: Option<String>,
    /// 已启用 MCP 的设备数
    pub device_count: usize,
}

/// 监听任务句柄：sync() 更换端口/停止时通过 stop 信号优雅退出并等待任务结束，
/// 确保旧监听释放端口后再绑定新端口。
struct ListenerHandle {
    /// 期望端口（配置值）
    port: u16,
    /// 实际绑定端口（bind 后由任务回报）
    bound_port: u16,
    /// 启动失败原因
    error: Option<String>,
    /// 代数：旧任务迟到回报不得污染新句柄
    gen: u64,
    stop: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

/// MCP 核心：协议处理 + 监听任务 + 工具执行（无 Tauri 依赖，可单测）。
pub(crate) struct McpCore {
    store: Arc<Store>,
    ssh: Arc<SshManager>,
    actions: Arc<AiActions>,
    listener: Mutex<Option<ListenerHandle>>,
}

/// 对外门面：Tauri State 持有；sync() 按配置启停监听。
pub struct McpService {
    core: Arc<McpCore>,
}

static GEN: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

impl McpService {
    pub fn new(store: Arc<Store>, ssh: Arc<SshManager>, staging: Arc<RemoteStaging>) -> Self {
        McpService {
            core: Arc::new(McpCore::new(store, ssh, staging)),
        }
    }

    /// 按当前配置同步监听状态（幂等）：至少一台设备启用 → 确保监听在配置端口上；
    /// 无启用设备或端口变更 → 停止/重启。由 mcp_set_device / mcp_set_port /
    /// delete_server / clear_all_servers 与启动时调用。
    pub async fn sync(&self) {
        let desired = if self.core.store.mcp_enabled_count() > 0 {
            Some(self.core.store.mcp_config().port)
        } else {
            None
        };
        let old = {
            let mut g = self.core.listener.lock().unwrap();
            let keep = matches!((g.as_ref(), desired), (Some(h), Some(p)) if h.port == p && h.error.is_none());
            if keep {
                return;
            }
            g.take()
        };
        if let Some(h) = old {
            let _ = h.stop.send(true);
            // 等旧任务退出（最多 2 秒），确保端口释放后再绑定
            let _ = tokio::time::timeout(Duration::from_secs(2), h.task).await;
        }
        if let Some(port) = desired {
            let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
            let core = Arc::clone(&self.core);
            let gen = GEN.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let task = tokio::spawn(async move {
                core.run_listener(port, gen, stop_rx).await;
            });
            *self.core.listener.lock().unwrap() = Some(ListenerHandle {
                port,
                bound_port: port,
                error: None,
                gen,
                stop: stop_tx,
                task,
            });
        }
    }

    pub fn status(&self) -> McpStatus {
        self.core.status()
    }
}

impl McpCore {
    pub(crate) fn new(
        store: Arc<Store>,
        ssh: Arc<SshManager>,
        staging: Arc<RemoteStaging>,
    ) -> Self {
        // 先克隆再构造（结构体字面量按书写顺序求值，store/ssh 移动后不能再借用）。
        // 浏览器动作不面向 MCP 设备开放：这里挂独立空管理器（无 webview，browser_* 一律报「尚未创建」）
        let actions = Arc::new(AiActions::new(
            Arc::clone(&store),
            Arc::clone(&ssh),
            staging,
            Arc::new(crate::browser::BrowserManager::new()),
        ));
        McpCore {
            store,
            ssh,
            actions,
            listener: Mutex::new(None),
        }
    }

    pub(crate) fn status(&self) -> McpStatus {
        let port = self.store.mcp_config().port;
        let device_count = self.store.mcp_enabled_count();
        let g = self.listener.lock().unwrap();
        match g.as_ref() {
            Some(h) if h.error.is_none() => McpStatus {
                running: true,
                port,
                bound_port: Some(h.bound_port),
                error: None,
                device_count,
            },
            Some(h) => McpStatus {
                running: false,
                port,
                bound_port: None,
                error: h.error.clone(),
                device_count,
            },
            None => McpStatus {
                running: false,
                port,
                bound_port: None,
                error: None,
                device_count,
            },
        }
    }

    /// 任务回报监听状态；gen 不匹配（句柄已被替换）时忽略。
    fn record_listener(&self, gen: u64, bound: Option<u16>, error: Option<String>) {
        let mut g = self.listener.lock().unwrap();
        if let Some(h) = g.as_mut() {
            if h.gen == gen {
                if let Some(b) = bound {
                    h.bound_port = b;
                }
                h.error = error;
            }
        }
    }

    /// 监听循环：绑定 127.0.0.1:port，逐连接交给 handle_http；stop 信号到达即退出。
    pub(crate) async fn run_listener(
        self: &Arc<Self>,
        port: u16,
        gen: u64,
        mut stop_rx: tokio::sync::watch::Receiver<bool>,
    ) {
        let addr = format!("127.0.0.1:{port}");
        let listener = match TcpListener::bind(&addr).await {
            Ok(l) => l,
            Err(e) => {
                self.record_listener(
                    gen,
                    None,
                    Some(format!("绑定 {addr} 失败：{e}（请更换 MCP 端口）")),
                );
                let _ = stop_rx.changed().await;
                return;
            }
        };
        let bound = listener.local_addr().map(|a| a.port()).unwrap_or(port);
        self.record_listener(gen, Some(bound), None);
        loop {
            tokio::select! {
                _ = stop_rx.changed() => break,
                acc = listener.accept() => {
                    let (stream, _) = match acc {
                        Ok(s) => s,
                        Err(_) => continue,
                    };
                    let core = Arc::clone(self);
                    tokio::spawn(async move {
                        let io = hyper_util::rt::TokioIo::new(stream);
                        let svc = hyper::service::service_fn(move |req| {
                            let core = Arc::clone(&core);
                            async move { core.handle_http(req).await }
                        });
                        let _ = hyper_util::server::conn::auto::Builder::new(
                            hyper_util::rt::TokioExecutor::new(),
                        )
                        .serve_connection(io, svc)
                        .await;
                    });
                }
            }
        }
    }

    // ------------------------------------------------------------ HTTP 层

    async fn handle_http(
        &self,
        req: Request<Incoming>,
    ) -> Result<Response<BoxBodyRes>, std::convert::Infallible> {
        // CORS 预检（浏览器型 MCP 客户端）
        if req.method() == Method::OPTIONS {
            return Ok(http_json(StatusCode::NO_CONTENT, "", "text/plain"));
        }
        if req.method() != Method::POST {
            return Ok(http_json(
                StatusCode::METHOD_NOT_ALLOWED,
                "Method Not Allowed",
                "text/plain",
            ));
        }
        // 鉴权：Bearer 令牌（每次现读 keyring，重置立即生效）
        let token = match self.store.mcp_token_ensure() {
            Ok(t) => t,
            Err(e) => {
                return Ok(http_json(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    &format!("MCP 令牌不可用: {e}"),
                    "text/plain",
                ))
            }
        };
        let auth_ok = req
            .headers()
            .get(hyper::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|t| t == token.as_str())
            .unwrap_or(false);
        if !auth_ok {
            return Ok(http_json(
                StatusCode::UNAUTHORIZED,
                "Unauthorized",
                "text/plain",
            ));
        }
        // 请求体上限（write_file 内容 5MB + 协议余量）
        let declared = req
            .headers()
            .get(hyper::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        if declared > MAX_HTTP_BODY_BYTES {
            return Ok(http_json(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Payload Too Large",
                "text/plain",
            ));
        }
        let bytes = match req.collect().await {
            Ok(c) => c.to_bytes(),
            Err(e) => {
                return Ok(http_json(
                    StatusCode::BAD_REQUEST,
                    &format!("读取请求体失败: {e}"),
                    "text/plain",
                ))
            }
        };
        if bytes.len() > MAX_HTTP_BODY_BYTES {
            return Ok(http_json(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Payload Too Large",
                "text/plain",
            ));
        }
        let parsed: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(e) => {
                let resp = json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": { "code": -32700, "message": format!("Parse error: {e}") }
                });
                let body = resp.to_string();
                return Ok(http_json(StatusCode::OK, &body, "application/json"));
            }
        };
        let out = self.handle_jsonrpc(parsed).await;
        let (status, body) = match out {
            // 通知：202 空响应
            Value::Null => (StatusCode::ACCEPTED, String::new()),
            v => (StatusCode::OK, v.to_string()),
        };
        Ok(http_json(status, &body, "application/json"))
    }

    // ------------------------------------------------------------ JSON-RPC

    /// 处理单个 JSON-RPC 消息（含批量数组兼容）；通知返回 Null（调用方回 202 空响应）。
    /// 批量元素走 handle_single（不递归，避免 async 递归需装箱）。
    pub(crate) async fn handle_jsonrpc(&self, value: Value) -> Value {
        if let Some(batch) = value.as_array() {
            let mut results: Vec<Value> = Vec::new();
            for v in batch {
                let r = self.handle_single(v.clone()).await;
                if !r.is_null() {
                    results.push(r);
                }
            }
            return if results.is_empty() {
                Value::Null
            } else {
                Value::Array(results)
            };
        }
        self.handle_single(value).await
    }

    async fn handle_single(&self, value: Value) -> Value {
        let Some(obj) = value.as_object() else {
            return jsonrpc_error(Value::Null, -32600, "Invalid Request".to_string());
        };
        let has_id = obj.contains_key("id");
        let id = obj.get("id").cloned().unwrap_or(Value::Null);
        let method = obj
            .get("method")
            .and_then(|m| m.as_str())
            .unwrap_or("")
            .to_string();
        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        let out = match method.as_str() {
            "initialize" => Some(self.rpc_initialize(id.clone(), &params)),
            "notifications/initialized"
            | "notifications/cancelled"
            | "notifications/roots/list_changed" => None,
            "tools/list" => Some(self.rpc_tools_list(id.clone())),
            "tools/call" => Some(self.rpc_tools_call(id.clone(), &params).await),
            "ping" => Some(jsonrpc_result(id.clone(), json!({}))),
            "resources/list" => Some(jsonrpc_result(id.clone(), json!({ "resources": [] }))),
            "prompts/list" => Some(jsonrpc_result(id.clone(), json!({ "prompts": [] }))),
            _ => Some(jsonrpc_error(
                id.clone(),
                -32601,
                format!("方法不存在：{method}"),
            )),
        };
        match (has_id, out) {
            (true, Some(v)) => v,
            (true, None) => jsonrpc_result(id, json!({})),
            (false, _) => Value::Null,
        }
    }

    fn rpc_initialize(&self, id: Value, params: &Value) -> Value {
        let requested = params
            .get("protocolVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let version = if SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
            requested.to_string()
        } else {
            LATEST_PROTOCOL_VERSION.to_string()
        };
        jsonrpc_result(
            id,
            json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": {
                    "name": "AIShell",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "instructions": "先用 list_devices 查询可用的服务器（serverId 与已启用功能），再调用对应工具；锁定服务器与未开启的功能会被拒绝。"
            }),
        )
    }

    fn rpc_tools_list(&self, id: Value) -> Value {
        let tools: Vec<Value> = tool_defs()
            .into_iter()
            .map(|(name, description, schema)| {
                json!({ "name": name, "description": description, "inputSchema": schema })
            })
            .collect();
        jsonrpc_result(id, json!({ "tools": tools }))
    }

    async fn rpc_tools_call(&self, id: Value, params: &Value) -> Value {
        let name = params
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args = params.get("arguments").cloned().unwrap_or(Value::Null);
        if !args.is_object() {
            return jsonrpc_error(id, -32602, "arguments 必须是 JSON 对象".to_string());
        }
        let result = match name.as_str() {
            "list_devices" => self.list_devices_text(),
            "sftp_list" => self.tool_sftp_list(&args).await,
            "sftp_upload" => self.tool_sftp_upload(&args).await,
            "sftp_download" => self.tool_sftp_download(&args).await,
            "sftp_rename" => self.tool_sftp_rename(&args).await,
            "sftp_delete" => self.tool_sftp_delete(&args).await,
            "read_file" => self.tool_read_file(&args).await,
            "write_file" => self.tool_write_file(&args).await,
            "edit_file" => self.tool_edit_file(&args).await,
            "exec_command" => self.tool_exec_command(&args).await,
            "db_query" => self.tool_db_query(&args).await,
            _ => {
                return jsonrpc_error(id, -32602, format!("未知工具：{name}"));
            }
        };
        jsonrpc_result(
            id,
            match result {
                Ok(text) => {
                    json!({ "content": [{ "type": "text", "text": text }], "isError": false })
                }
                Err(text) => {
                    json!({ "content": [{ "type": "text", "text": text }], "isError": true })
                }
            },
        )
    }

    // ------------------------------------------------------------ 工具执行

    /// 工具调用统一裁决：服务器存在 → 设备已启用 → 未锁定 → 功能开关。
    fn guard(&self, server_id: &str, tool: &str) -> Result<(), String> {
        let server = self
            .store
            .server(server_id)
            .ok_or_else(|| format!("服务器不存在：{server_id}"))?;
        let cfg = self
            .store
            .mcp_device(server_id)
            .filter(|c| c.enabled)
            .ok_or_else(|| format!("服务器「{}」未启用 MCP，请在服务器设置中开启", server.name))?;
        if server.locked {
            return Err(format!(
                "服务器「{}」已被锁定（不允许 AI 访问），MCP 调用被拒绝",
                server.name
            ));
        }
        if !cfg.features.tool_enabled(tool) {
            return Err(format!(
                "服务器「{}」未开启该功能，请在服务器 MCP 设置中启用",
                server.name
            ));
        }
        Ok(())
    }

    /// MCP 可发现设备列表（list_devices 工具；输出风格对齐 ai_actions::list_servers）。
    fn list_devices_text(&self) -> Result<String, String> {
        let mut lines: Vec<String> = Vec::new();
        let mut shown = 0usize;
        for (sv, cfg) in self.store.mcp_devices() {
            if !cfg.enabled {
                continue;
            }
            shown += 1;
            let status = if sv.locked {
                "已锁定（不可操作）".to_string()
            } else {
                "可用".to_string()
            };
            let auth = match sv.auth_type {
                AuthType::Password => "密码",
                AuthType::Key => "密钥",
            };
            lines.push(format!(
                "- serverId={}，名称={}，地址={}:{}，用户={}，认证={}，状态={}",
                sv.id, sv.name, sv.host, sv.port, sv.username, auth, status
            ));
            let labels = cfg.features.enabled_labels();
            if labels.is_empty() {
                lines.push("  - 已启用功能：无（需在 AIShell 服务器 MCP 设置中开启）".to_string());
            } else {
                lines.push(format!("  - 已启用功能：{}", labels.join("、")));
            }
            // 数据库连接（db_query 通道）：仅 db_query 开关打开时展示连接清单
            if cfg.features.db_query {
                let conns = self.store.db_connections(&sv.id);
                let enabled: Vec<_> = conns.iter().filter(|c| c.enabled).collect();
                if enabled.is_empty() {
                    lines.push(
                        "  - 数据库连接：无（需在「服务器设置-数据库连接」中配置并启用）"
                            .to_string(),
                    );
                } else {
                    for c in &enabled {
                        let db = if c.database.is_empty() {
                            "-".to_string()
                        } else {
                            c.database.clone()
                        };
                        lines.push(format!(
                            "  - 数据库连接 connectionId={}，名称={}，类型={}，默认库={}，允许命令={}",
                            c.id,
                            c.name,
                            c.kind.as_str(),
                            db,
                            c.effective_commands().join("/")
                        ));
                    }
                }
            }
        }
        if shown == 0 {
            return Ok(
                "没有已启用 MCP 的服务器。请先在 AIShell 的「服务器卡片 → 更多 → MCP」中启用。"
                    .to_string(),
            );
        }
        let mut text = format!("MCP 可用设备（{shown} 台）：\n{}", lines.join("\n"));
        text.push_str("\n提示：各工具通过 serverId 指定目标；锁定服务器会被拒绝。数据库查询用 db_query，connectionId 取上方「数据库连接」条目。");
        Ok(text)
    }

    /// 本地侧 MCP 传输目录（上传源 / 下载落地边界；自动创建）。
    fn transfer_root(&self) -> Result<PathBuf, String> {
        let ws = self
            .store
            .settings()
            .workspace_dir
            .filter(|s| !s.trim().is_empty());
        let base = match ws {
            Some(w) => PathBuf::from(w).join(".aishell").join("mcp-transfer"),
            None => self.store.config_dir().join("mcp-transfer"),
        };
        std::fs::create_dir_all(&base).map_err(|e| format!("创建 MCP 传输目录失败: {e}"))?;
        Ok(base)
    }

    /// 传输目录内解析：词法归一（`.`/`..`）后必须位于根内，返回归一后的绝对路径。
    fn resolve_transfer_path(&self, transfer: &Path, input: &str) -> Result<PathBuf, String> {
        let normalized = crate::ai_actions::normalize_path(Path::new(input));
        crate::ai_actions::ensure_inside(transfer, &normalized).map_err(|_| {
            format!(
                "路径越界：仅允许 MCP 传输目录内的路径（{}）",
                transfer.display()
            )
        })?;
        Ok(normalized)
    }

    async fn tool_sftp_list(&self, args: &Value) -> Result<String, String> {
        let server_id = arg_str(args, "serverId")?;
        let path = arg_str_opt(args, "path")?.unwrap_or_else(|| ".".to_string());
        self.guard(&server_id, "sftp_list")?;
        let sftp = self.ssh.open_sftp(&server_id).await?;
        let entries = crate::sftp::list_dir(&sftp, &path).await?;
        if entries.is_empty() {
            return Ok(format!("目录 {path} 为空"));
        }
        let lines: Vec<String> = entries
            .iter()
            .map(|e| {
                let kind = if e.is_dir { "目录" } else { "文件" };
                let size = if e.is_dir {
                    "-".to_string()
                } else {
                    format_size(e.size)
                };
                format!("{kind} {}（大小 {size}，mtime {}）", e.name, e.mtime)
            })
            .collect();
        Ok(format!(
            "目录 {path}（{} 项）：\n{}",
            entries.len(),
            lines.join("\n")
        ))
    }

    async fn tool_sftp_upload(&self, args: &Value) -> Result<String, String> {
        let server_id = arg_str(args, "serverId")?;
        let local_path = arg_str(args, "localPath")?;
        let remote_dir = arg_str_opt(args, "remoteDir")?.unwrap_or_else(|| ".".to_string());
        self.guard(&server_id, "sftp_upload")?;
        let transfer = self.transfer_root()?;
        let local = self.resolve_transfer_path(&transfer, &local_path)?;
        if !local.is_file() && !local.is_dir() {
            return Err(format!("本地文件或目录不存在：{}", local.display()));
        }
        let sftp = self.ssh.open_sftp(&server_id).await?;
        let remote = if remote_dir.trim().is_empty() || remote_dir == "." {
            sftp.canonicalize(".")
                .await
                .map_err(|e| format!("解析远端目录失败: {e}"))?
        } else {
            remote_dir.clone()
        };
        let landed = crate::sftp::upload_one(&sftp, &local, &remote, false, None).await?;
        Ok(format!(
            "上传完成：{}/{}（服务器 {server_id}；远端已存在同名时自动创建副本）",
            remote.trim_end_matches('/'),
            landed
        ))
    }

    async fn tool_sftp_download(&self, args: &Value) -> Result<String, String> {
        let server_id = arg_str(args, "serverId")?;
        let remote_path = arg_str(args, "remotePath")?;
        self.guard(&server_id, "sftp_download")?;
        let transfer = self.transfer_root()?;
        let local_dir = match arg_str_opt(args, "localDir")? {
            Some(d) => {
                let dir = self.resolve_transfer_path(&transfer, &d)?;
                std::fs::create_dir_all(&dir)
                    .map_err(|e| format!("创建本地目录 {} 失败: {e}", dir.display()))?;
                dir
            }
            None => transfer,
        };
        let sftp = self.ssh.open_sftp(&server_id).await?;
        let landed = crate::sftp::download_one(&sftp, &remote_path, &local_dir, None).await?;
        Ok(format!("已下载到：{landed}（服务器 {server_id}；本地重名自动改名）"))
    }

    async fn tool_sftp_rename(&self, args: &Value) -> Result<String, String> {
        let server_id = arg_str(args, "serverId")?;
        let from = arg_str(args, "from")?;
        let to = arg_str(args, "to")?;
        self.guard(&server_id, "sftp_rename")?;
        let sftp = self.ssh.open_sftp(&server_id).await?;
        crate::sftp::rename_one(&sftp, &from, &to).await?;
        Ok(format!("已重命名/移动：{from} → {to}"))
    }

    async fn tool_sftp_delete(&self, args: &Value) -> Result<String, String> {
        let server_id = arg_str(args, "serverId")?;
        let path = arg_str(args, "path")?;
        self.guard(&server_id, "sftp_delete")?;
        let sftp = self.ssh.open_sftp(&server_id).await?;
        crate::sftp::delete_one(&sftp, &path).await?;
        Ok(format!("已删除：{path}"))
    }

    async fn tool_read_file(&self, args: &Value) -> Result<String, String> {
        let server_id = arg_str(args, "serverId")?;
        let path = arg_str(args, "path")?;
        self.guard(&server_id, "read_file")?;
        let sftp = self.ssh.open_sftp(&server_id).await?;
        let text = crate::sftp::read_text(&sftp, &path).await?;
        Ok(self.redact(&text))
    }

    async fn tool_write_file(&self, args: &Value) -> Result<String, String> {
        let server_id = arg_str(args, "serverId")?;
        let path = arg_str(args, "path")?;
        let content = arg_str(args, "content")?;
        let expected_size = arg_u64_opt(args, "expectedSize")?;
        let expected_mtime = arg_i64_opt(args, "expectedMtime")?;
        self.guard(&server_id, "write_file")?;
        if content.len() > MAX_MCP_WRITE_BYTES {
            return Err(format!(
                "内容过大（超过 {}MB），请拆分写入",
                MAX_MCP_WRITE_BYTES / 1024 / 1024
            ));
        }
        let sftp = self.ssh.open_sftp(&server_id).await?;
        // 文件不存在 → 新建（无冲突检测）；存在 → 走带冲突检测的 write_text
        let exists = sftp
            .try_exists(&path)
            .await
            .map_err(|e| format!("检查远端 {path} 失败: {e}"))?;
        let r = if exists {
            crate::sftp::write_text(&sftp, &path, &content, expected_size, expected_mtime).await?
        } else {
            use tokio::io::AsyncWriteExt;
            let mut f = sftp
                .create(&path)
                .await
                .map_err(|e| format!("创建远端文件 {path} 失败: {e}"))?;
            f.write_all(content.as_bytes())
                .await
                .map_err(|e| format!("写入远端 {path} 失败: {e}"))?;
            f.shutdown()
                .await
                .map_err(|e| format!("关闭远端文件 {path} 失败: {e}"))?;
            crate::sftp::SftpWriteResult {
                conflict: false,
                actual_size: Some(content.len() as u64),
                actual_mtime: None,
            }
        };
        if r.conflict {
            Ok(format!(
                "写入冲突：远端文件已被外部修改（size={}，mtime={}），本次未写入。请先 read_file 获取最新内容后重试",
                r.actual_size.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string()),
                r.actual_mtime.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string())
            ))
        } else {
            Ok(format!(
                "已写入 {path}（size={}，mtime={}）",
                r.actual_size
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                r.actual_mtime
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".to_string())
            ))
        }
    }

    async fn tool_edit_file(&self, args: &Value) -> Result<String, String> {
        let server_id = arg_str(args, "serverId")?;
        let path = arg_str(args, "path")?;
        let old_text = arg_str(args, "oldText")?;
        let new_text = arg_str(args, "newText")?;
        let expected_size = arg_u64_opt(args, "expectedSize")?;
        let expected_mtime = arg_i64_opt(args, "expectedMtime")?;
        self.guard(&server_id, "edit_file")?;
        if old_text.is_empty() {
            return Err("oldText 不能为空".to_string());
        }
        if new_text.len() > MAX_MCP_WRITE_BYTES {
            return Err(format!(
                "内容过大（超过 {}MB），请拆分编辑",
                MAX_MCP_WRITE_BYTES / 1024 / 1024
            ));
        }
        let sftp = self.ssh.open_sftp(&server_id).await?;
        let current = crate::sftp::read_text(&sftp, &path).await?;
        let count = current.match_indices(&old_text).count();
        if count == 0 {
            return Err(format!("oldText 未在文件 {path} 中出现，未做任何修改"));
        }
        if count > 1 {
            return Err(format!(
                "oldText 在文件 {path} 中出现 {count} 次，请提供更精确的匹配片段（当前未修改）"
            ));
        }
        let next = current.replacen(&old_text, &new_text, 1);
        let r = crate::sftp::write_text(&sftp, &path, &next, expected_size, expected_mtime).await?;
        if r.conflict {
            Ok(format!(
                "编辑冲突：远端文件已被外部修改（size={}，mtime={}），本次未写入。请先 read_file 获取最新内容后重试",
                r.actual_size.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string()),
                r.actual_mtime.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string())
            ))
        } else {
            Ok(format!(
                "编辑完成：{path}（size={}，mtime={}）",
                r.actual_size
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".to_string()),
                r.actual_mtime
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "-".to_string())
            ))
        }
    }

    async fn tool_exec_command(&self, args: &Value) -> Result<String, String> {
        let server_id = arg_str(args, "serverId")?;
        let command = arg_str(args, "command")?;
        let timeout_secs =
            arg_u64_opt(args, "timeoutSeconds")?.unwrap_or(DEFAULT_EXEC_TIMEOUT_SECS);
        if !(1..=MAX_EXEC_TIMEOUT_SECS).contains(&timeout_secs) {
            return Err(format!(
                "timeoutSeconds 必须在 1–{MAX_EXEC_TIMEOUT_SECS} 秒之间"
            ));
        }
        if command.trim().is_empty() {
            return Err("命令不能为空".to_string());
        }
        self.guard(&server_id, "exec_command")?;
        let result = self
            .ssh
            .exec_with_timeout(&server_id, &command, Duration::from_secs(timeout_secs))
            .await?;
        Ok(self.assemble_command_result(&result))
    }

    async fn tool_db_query(&self, args: &Value) -> Result<String, String> {
        let server_id = arg_str(args, "serverId")?;
        let connection_id = arg_str(args, "connectionId")?;
        let command = arg_str(args, "command")?;
        self.guard(&server_id, "db_query")?;
        let result = self
            .actions
            .db_query(server_id, connection_id, command)
            .await?;
        Ok(self.assemble_command_result(&result))
    }

    /// 命令类结果组装（exec_command / db_query 共用）：stdout+stderr → 脱敏 → 截断 → 退出码。
    fn assemble_command_result(&self, r: &crate::ai_actions::CommandResult) -> String {
        let mut text = String::new();
        if !r.stdout.is_empty() {
            text.push_str(&format!(
                "标准输出：\n{}\n",
                truncate(&self.redact(&r.stdout))
            ));
        }
        if !r.stderr.is_empty() {
            text.push_str(&format!(
                "标准错误：\n{}\n",
                truncate(&self.redact(&r.stderr))
            ));
        }
        match r.exit_code {
            Some(code) => text.push_str(&format!("退出码：{code}")),
            None => text.push_str("退出码：未知（通道异常关闭）"),
        }
        if r.timed_out {
            text.push_str("\n注意：命令执行超时，已尝试终止远端命令");
        }
        truncate(&text)
    }

    /// known_secrets 脱敏（与 AI 输出同规则，防止命令/文件内容泄露凭据）。
    fn redact(&self, text: &str) -> String {
        crate::redact::redact_secrets(text, &self.store.known_secrets()).0
    }
}

// ---------------------------------------------------------------- 工具定义

/// 工具清单（name, description, inputSchema）：静态列表，功能开关按 serverId 在调用时裁决。
fn tool_defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "list_devices",
            "列出所有已加入 MCP 可发现列表的服务器（serverId、状态、已启用功能、数据库连接）。调用其他工具前先查询。",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ),
        (
            "sftp_list",
            "列出远端目录条目（名称/类型/大小/修改时间）。需服务器开启「SFTP 目录查询」；锁定服务器会被拒绝。",
            json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string", "description": "服务器 id（list_devices 查询）" },
                    "path": { "type": "string", "description": "远端目录绝对路径；缺省为登录用户 home" }
                },
                "required": ["serverId"],
                "additionalProperties": false
            }),
        ),
        (
            "sftp_upload",
            "把 MCP 传输目录内的本地文件/目录上传到远端目录（远端重名自动创建副本）。需开启「SFTP 上传」。",
            json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "localPath": { "type": "string", "description": "本机 MCP 传输目录内的绝对路径（list_devices 无此信息，通常在 <工作区>/.aishell/mcp-transfer 下）" },
                    "remoteDir": { "type": "string", "description": "远端目标目录绝对路径；缺省为 home" }
                },
                "required": ["serverId", "localPath"],
                "additionalProperties": false
            }),
        ),
        (
            "sftp_download",
            "把远端文件/目录下载到 MCP 传输目录（本地重名自动改名）。需开启「SFTP 下载」。",
            json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "remotePath": { "type": "string", "description": "远端文件或目录绝对路径" },
                    "localDir": { "type": "string", "description": "传输目录内的落地子目录；缺省为传输目录根" }
                },
                "required": ["serverId", "remotePath"],
                "additionalProperties": false
            }),
        ),
        (
            "sftp_rename",
            "重命名/移动远端文件或目录（目标已存在时报错）。需开启「SFTP 重命名」。",
            json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "from": { "type": "string", "description": "原完整路径" },
                    "to": { "type": "string", "description": "目标完整路径" }
                },
                "required": ["serverId", "from", "to"],
                "additionalProperties": false
            }),
        ),
        (
            "sftp_delete",
            "删除远端文件或目录（目录递归删除；根目录拒绝）。危险操作，需开启「SFTP 删除」。",
            json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "path": { "type": "string", "description": "远端绝对路径" }
                },
                "required": ["serverId", "path"],
                "additionalProperties": false
            }),
        ),
        (
            "read_file",
            "读取远端文本文件内容（>5MB 或二进制拒绝；内容经凭据脱敏）。需开启「文件读取」。",
            json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "path": { "type": "string", "description": "远端文件绝对路径" }
                },
                "required": ["serverId", "path"],
                "additionalProperties": false
            }),
        ),
        (
            "write_file",
            "整体覆写远端文件；文件不存在时新建。传 expectedSize/expectedMtime（来自 read_file 前 stat 或上次写入结果）可做冲突检测。需开启「文件写入」。",
            json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "path": { "type": "string", "description": "远端文件绝对路径" },
                    "content": { "type": "string", "description": "完整新内容（上限 5MB）" },
                    "expectedSize": { "type": "integer", "description": "可选：期望的远端文件字节数，不一致则拒绝写入" },
                    "expectedMtime": { "type": "integer", "description": "可选：期望的远端文件 mtime（unix 秒），不一致则拒绝写入" }
                },
                "required": ["serverId", "path", "content"],
                "additionalProperties": false
            }),
        ),
        (
            "edit_file",
            "精确替换式编辑：把文件中唯一出现的 oldText 替换为 newText（出现 0 次或多次都拒绝并说明）。不创建新文件。需开启「文件编辑」。",
            json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "path": { "type": "string" },
                    "oldText": { "type": "string", "description": "须在文件中恰好出现一次的匹配片段" },
                    "newText": { "type": "string" },
                    "expectedSize": { "type": "integer" },
                    "expectedMtime": { "type": "integer" }
                },
                "required": ["serverId", "path", "oldText", "newText"],
                "additionalProperties": false
            }),
        ),
        (
            "exec_command",
            "在服务器上执行单条命令并返回 stdout/stderr/退出码（默认 30 秒超时）。危险操作，不经 AI 审批，需开启「执行命令」。",
            json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "command": { "type": "string", "description": "远端 shell 命令" },
                    "timeoutSeconds": { "type": "integer", "minimum": 1, "maximum": 3600, "description": "超时秒数；缺省 30" }
                },
                "required": ["serverId", "command"],
                "additionalProperties": false
            }),
        ),
        (
            "db_query",
            "通过数据库管道查询：在服务器本机执行数据库客户端（mysql/clickhouse/redis/postgres），凭据由系统代管。只允许该连接白名单内的命令（默认只读）。需开启「数据库查询」。",
            json!({
                "type": "object",
                "properties": {
                    "serverId": { "type": "string" },
                    "connectionId": { "type": "string", "description": "数据库连接 id（list_devices 查询）" },
                    "command": { "type": "string", "description": "SQL 或单条 redis 命令" }
                },
                "required": ["serverId", "connectionId", "command"],
                "additionalProperties": false
            }),
        ),
    ]
}

// ---------------------------------------------------------------- helpers

fn jsonrpc_result(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn jsonrpc_error(id: Value, code: i64, message: String) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// 带 CORS 头的 JSON/文本响应（浏览器型 MCP 客户端需要）。
fn http_json(status: StatusCode, body: &str, content_type: &'static str) -> Response<BoxBodyRes> {
    let mut resp = Response::new(full(body.as_bytes().to_vec()));
    *resp.status_mut() = status;
    let h = resp.headers_mut();
    h.insert(hyper::header::CONTENT_TYPE, content_type.parse().unwrap());
    h.insert(
        hyper::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        "*".parse().unwrap(),
    );
    h.insert(
        hyper::header::ACCESS_CONTROL_ALLOW_METHODS,
        "GET, POST, OPTIONS".parse().unwrap(),
    );
    h.insert(
        hyper::header::ACCESS_CONTROL_ALLOW_HEADERS,
        "Authorization, Content-Type, Mcp-Session-Id, mcp-protocol-version"
            .parse()
            .unwrap(),
    );
    h.insert(
        hyper::header::ACCESS_CONTROL_MAX_AGE,
        "86400".parse().unwrap(),
    );
    resp
}

fn full(bytes: Vec<u8>) -> BoxBodyRes {
    Full::new(Bytes::from(bytes))
        .map_err(|never| match never {})
        .boxed()
}

fn arg_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("缺少字符串参数：{key}"))
}

fn arg_str_opt(args: &Value, key: &str) -> Result<Option<String>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.clone())),
        Some(_) => Err(format!("参数 {key} 必须是字符串")),
    }
}

fn arg_u64_opt(args: &Value, key: &str) -> Result<Option<u64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("参数 {key} 必须是正整数")),
        Some(_) => Err(format!("参数 {key} 必须是整数")),
    }
}

fn arg_i64_opt(args: &Value, key: &str) -> Result<Option<i64>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => n
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("参数 {key} 必须是整数")),
        Some(_) => Err(format!("参数 {key} 必须是整数")),
    }
}

/// 人类可读大小（B/KB/MB/GB/TB）。
fn format_size(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut u = 0usize;
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 {
        format!("{n} B")
    } else {
        format!("{v:.1} {}", UNITS[u])
    }
}

/// 文本截断（UTF-8 边界安全）。
fn truncate(text: &str) -> String {
    if text.len() <= MAX_TOOL_TEXT_BYTES {
        return text.to_string();
    }
    let mut end = MAX_TOOL_TEXT_BYTES;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let mut s = text[..end].to_string();
    s.push_str("\n…（输出过长，已截断）");
    s
}

// ---------------------------------------------------------------- Tauri commands
// 命令名与 src/api.ts 的 mcp 段逐一对应。

#[tauri::command]
pub async fn mcp_set_device(
    store: State<'_, Arc<Store>>,
    mcp: State<'_, Arc<McpService>>,
    server_id: String,
    config: McpDeviceConfig,
) -> Result<(), String> {
    store.set_mcp_device(&server_id, config)?;
    mcp.sync().await;
    Ok(())
}

#[tauri::command]
pub async fn mcp_set_port(
    store: State<'_, Arc<Store>>,
    mcp: State<'_, Arc<McpService>>,
    port: u16,
) -> Result<(), String> {
    store.set_mcp_port(port)?;
    mcp.sync().await;
    Ok(())
}

// Tauri 要求 async 命令带引用输入时必须返回 Result；mcp_status 无 async 需求，改同步形态。
#[tauri::command]
pub fn mcp_status(mcp: State<'_, Arc<McpService>>) -> McpStatus {
    mcp.status()
}

#[tauri::command]
pub async fn mcp_ensure_token(store: State<'_, Arc<Store>>) -> Result<String, String> {
    store.mcp_token_ensure()
}

#[tauri::command]
pub async fn mcp_reset_token(store: State<'_, Arc<Store>>) -> Result<String, String> {
    store.mcp_token_reset()
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{test_store, AuthType, DbConnection, DbKind, McpFeatures, Server};
    use std::path::PathBuf;

    /// 唯一临时目录（并行测试同 tag 会互相删除，必须逐次唯一）。
    fn temp_dir(tag: &str) -> PathBuf {
        static CTR: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir =
            std::env::temp_dir().join(format!("aishell-mcp-test-{tag}-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 测试用 McpCore：test_store（不碰真实 keyring）+ 一台未锁定服务器。
    fn test_core() -> Arc<McpCore> {
        let dir = temp_dir("core");
        let store = Arc::new(test_store(dir));
        store
            .upsert_server(
                Server {
                    id: "srv-1".to_string(),
                    name: "测试机".to_string(),
                    host: "127.0.0.1".to_string(),
                    port: 22,
                    auth_type: AuthType::Password,
                    username: "test".to_string(),
                    key_path: String::new(),
                    credential_id: None,
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                },
                Some("pw"),
            )
            .unwrap();
        let ssh = Arc::new(SshManager::new(Arc::clone(&store)));
        let staging = Arc::new(RemoteStaging::new(
            temp_dir("staging"),
            Arc::clone(&ssh),
            Arc::clone(&store),
        ));
        Arc::new(McpCore::new(store, ssh, staging))
    }

    #[tokio::test]
    async fn initialize_echoes_supported_version() {
        let core = test_core();
        let out = core
            .handle_jsonrpc(json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": { "name": "t", "version": "1" } }
            }))
            .await;
        assert_eq!(out["id"], 1);
        assert_eq!(out["result"]["protocolVersion"], "2025-03-26");
        assert_eq!(out["result"]["serverInfo"]["name"], "AIShell");
        assert!(out["result"]["capabilities"]["tools"].is_object());
        // 未知版本回落到最新
        let out2 = core
            .handle_jsonrpc(json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "9999-01-01" }
            }))
            .await;
        assert_eq!(out2["result"]["protocolVersion"], "2025-06-18");
    }

    #[tokio::test]
    async fn tools_list_has_all_tools_with_schema() {
        let core = test_core();
        let out = core
            .handle_jsonrpc(json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" }))
            .await;
        let tools = out["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        for t in [
            "list_devices",
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
            assert!(names.contains(&t), "tools/list 缺少 {t}");
        }
        for t in tools {
            assert!(
                !t["description"].as_str().unwrap().is_empty(),
                "描述不能为空"
            );
            assert!(t["inputSchema"].is_object(), "inputSchema 必须是对象");
        }
    }

    #[tokio::test]
    async fn ping_and_unknown_method_and_notification() {
        let core = test_core();
        let out = core
            .handle_jsonrpc(json!({ "jsonrpc": "2.0", "id": 3, "method": "ping" }))
            .await;
        assert_eq!(out["result"], json!({}));
        let out = core
            .handle_jsonrpc(json!({ "jsonrpc": "2.0", "id": 4, "method": "foo" }))
            .await;
        assert_eq!(out["error"]["code"], -32601);
        // 通知（无 id）→ 无响应
        let out = core
            .handle_jsonrpc(json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .await;
        assert!(out.is_null());
        // 非对象 → Invalid Request
        let out = core.handle_jsonrpc(json!("hello")).await;
        assert_eq!(out["error"]["code"], -32600);
    }

    #[tokio::test]
    async fn batch_requests_processed() {
        let core = test_core();
        let out = core
            .handle_jsonrpc(json!([
                { "jsonrpc": "2.0", "id": 1, "method": "ping" },
                { "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
            ]))
            .await;
        let arr = out.as_array().unwrap();
        assert_eq!(arr.len(), 2);
        assert_eq!(arr[0]["id"], 1);
        assert!(arr[1]["result"]["tools"].is_array());
    }

    #[tokio::test]
    async fn tool_guards_reject_before_ssh() {
        let core = test_core();
        async fn call_tool(core: &McpCore, args: Value) -> Value {
            core.handle_jsonrpc(json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "exec_command", "arguments": args }
            }))
            .await
        }
        let text = |out: &Value| {
            out["result"]["content"][0]["text"]
                .as_str()
                .unwrap()
                .to_string()
        };
        // 1) 未启用 MCP
        let out = call_tool(&core, json!({ "serverId": "srv-1", "command": "echo hi" })).await;
        assert_eq!(out["result"]["isError"], true);
        assert!(text(&out).contains("未启用 MCP"), "{}", text(&out));
        // 2) 启用设备但功能未开
        core.store
            .set_mcp_device(
                "srv-1",
                McpDeviceConfig {
                    enabled: true,
                    features: McpFeatures::default(),
                },
            )
            .unwrap();
        let out = call_tool(&core, json!({ "serverId": "srv-1", "command": "echo hi" })).await;
        assert!(text(&out).contains("未开启该功能"), "{}", text(&out));
        // 3) 开启 exec 后锁定服务器
        core.store
            .set_mcp_device(
                "srv-1",
                McpDeviceConfig {
                    enabled: true,
                    features: McpFeatures {
                        exec: true,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        core.store.set_server_locked("srv-1", true).unwrap();
        let out = call_tool(&core, json!({ "serverId": "srv-1", "command": "echo hi" })).await;
        assert!(text(&out).contains("已被锁定"), "{}", text(&out));
        // 4) 未知服务器
        let out = call_tool(&core, json!({ "serverId": "ghost", "command": "echo hi" })).await;
        assert!(text(&out).contains("服务器不存在"), "{}", text(&out));
        // 5) 未知工具 → JSON-RPC 错误
        let out = core
            .handle_jsonrpc(json!({
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": { "name": "nope", "arguments": {} }
            }))
            .await;
        assert_eq!(out["error"]["code"], -32602);
        // 6) arguments 非对象 → JSON-RPC 错误
        let out = core
            .handle_jsonrpc(json!({
                "jsonrpc": "2.0", "id": 3, "method": "tools/call",
                "params": { "name": "exec_command", "arguments": "x" }
            }))
            .await;
        assert_eq!(out["error"]["code"], -32602);
    }

    #[tokio::test]
    async fn list_devices_shows_enabled_devices() {
        let core = test_core();
        let call = || async {
            core.handle_jsonrpc(json!({
                "jsonrpc": "2.0", "id": 1, "method": "tools/call",
                "params": { "name": "list_devices", "arguments": {} }
            }))
            .await
        };
        // 未启用任何设备 → 引导文案
        let out = call().await;
        let text = out["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(text.contains("没有已启用 MCP 的服务器"), "{text}");
        // 启用 exec + db_query，并配置一条数据库连接
        core.store
            .set_mcp_device(
                "srv-1",
                McpDeviceConfig {
                    enabled: true,
                    features: McpFeatures {
                        exec: true,
                        db_query: true,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        core.store
            .save_db_connection(
                "srv-1",
                DbConnection {
                    id: "dbc-1".to_string(),
                    name: "测试库".to_string(),
                    kind: DbKind::Mysql,
                    host: "127.0.0.1".to_string(),
                    port: 3306,
                    user: "root".to_string(),
                    database: "app".to_string(),
                    allowed_commands: vec![],
                    enabled: true,
                },
                Some("pw"),
            )
            .unwrap();
        let out = call().await;
        let text = out["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(text.contains("serverId=srv-1"), "{text}");
        assert!(text.contains("执行命令"), "{text}");
        assert!(text.contains("connectionId=dbc-1"), "{text}");
        assert!(text.contains("SELECT"), "{text}");
        // 锁定后仍列出但标注
        core.store.set_server_locked("srv-1", true).unwrap();
        let out = call().await;
        let text = out["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string();
        assert!(text.contains("已锁定"), "{text}");
    }

    #[tokio::test]
    async fn transfer_root_uses_workspace_or_config_dir() {
        let core = test_core();
        // workspace 未配置 → <config_dir>/mcp-transfer
        let root = core.transfer_root().unwrap();
        assert!(root.ends_with("mcp-transfer"), "{}", root.display());
        // workspace 已配置 → <workspace>/.aishell/mcp-transfer
        let ws = temp_dir("ws");
        core.store
            .save_settings(
                crate::store::Settings {
                    workspace_dir: Some(ws.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        let root = core.transfer_root().unwrap();
        assert!(
            root.starts_with(ws.join(".aishell").join("mcp-transfer")),
            "{}",
            root.display()
        );
    }

    #[tokio::test]
    async fn http_layer_auth_methods_and_cors() {
        let core = test_core();
        core.store
            .set_mcp_device(
                "srv-1",
                McpDeviceConfig {
                    enabled: true,
                    features: McpFeatures {
                        exec: true,
                        ..Default::default()
                    },
                },
            )
            .unwrap();
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let task_core = Arc::clone(&core);
        let gen = 4242;
        let task = tokio::spawn(async move {
            task_core.run_listener(0, gen, stop_rx).await;
        });
        // 模拟 sync() 建句柄（record_listener 只更新匹配 gen 的既有句柄）
        *core.listener.lock().unwrap() = Some(ListenerHandle {
            port: 0,
            bound_port: 0,
            error: None,
            gen,
            stop: stop_tx.clone(),
            task,
        });
        // 轮询等待临时端口就绪（port 0 → 实际端口由任务回报）
        let mut base: Option<String> = None;
        for _ in 0..100 {
            let st = core.status();
            if st.running && st.bound_port.is_some_and(|p| p > 0) {
                base = Some(format!("http://127.0.0.1:{}", st.bound_port.unwrap()));
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let base = base.expect("监听未在 5 秒内就绪");
        let token = core.store.mcp_token_ensure().unwrap();
        let client = reqwest::Client::new();
        // 无令牌 → 401
        let resp = client
            .post(format!("{base}/mcp"))
            .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
        // 错误令牌 → 401
        let resp = client
            .post(format!("{base}/mcp"))
            .bearer_auth("wrong-token")
            .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
        // 带令牌 initialize → 200 + 版本回显
        let resp = client
            .post(format!("{base}/mcp"))
            .bearer_auth(&token)
            .json(&json!({
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": { "protocolVersion": "2025-03-26" }
            }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        // 先读响应头再消费 body（json() 会 move resp）
        assert_eq!(
            resp.headers().get("access-control-allow-origin").unwrap(),
            "*"
        );
        let body: Value = resp.json().await.unwrap();
        assert_eq!(body["result"]["protocolVersion"], "2025-03-26");
        // 通知 → 202 空响应
        let resp = client
            .post(format!("{base}/mcp"))
            .bearer_auth(&token)
            .json(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 202);
        // GET → 405
        let resp = client.get(format!("{base}/mcp")).send().await.unwrap();
        assert_eq!(resp.status(), 405);
        // OPTIONS 预检 → 204 + CORS 头
        let resp = client
            .request(reqwest::Method::OPTIONS, format!("{base}/mcp"))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 204);
        assert_eq!(
            resp.headers().get("access-control-allow-origin").unwrap(),
            "*"
        );
        // 停掉监听：从句柄取回任务并等待结束
        let _ = stop_tx.send(true);
        let task = core.listener.lock().unwrap().take().map(|h| h.task);
        if let Some(t) = task {
            let _ = t.await;
        }
    }
}
