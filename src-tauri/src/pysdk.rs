//! py 工具的 SDK 一次性通道 —— Python 脚本调用 AIShell 能力（ssh/sftp/数据库管道）的本机 HTTP 桥。
//! 对照 .proto/ 交互规格：无对应条目——本模块是纯进程内桥，不涉及前后端 IPC；
//! 与后端接口点：ai.rs 的 run_internal_action「run_py」分支在执行脚本前 `PySdkBridge::start`，
//! 把 url/token 经环境变量注入 Python 进程，进程结束后 `stop` 销毁。
//!
//! 设计（与 MCP 服务的区别）：
//! - 每次 py 执行绑定 127.0.0.1:0（ephemeral 端口）+ 随机一次性 token（仅内存，不进 keyring），
//!   随脚本进程结束销毁——无常驻端口、无长期令牌，SDK 通道的生命周期 = 单次脚本执行；
//! - dispatcher 直接调 AiActions 执行体（与 McpCore 工具实现同层），裁决走 AI 体系
//!   （ensure_ai_allowed 服务器锁 + db 命令白名单 + 项目根边界），**不复用 MCP 设备/功能开关**；
//!   脚本级审批（py 工具动作卡）一次完成，脚本内单项调用不再逐次审批；
//! - 传输协议是薄 JSON：POST /rpc，体 `{"method": "...", "params": {...}}`，
//!   响应 `{"ok": true, "result": ...}` / `{"ok": false, "error": "中文原因"}`；
//! - 输出脱敏在 AiActions 的 sdk_* 方法内完成（与 run_command 同标准）。
//!
//! Python 侧 SDK 包在 resources/pysdk/aishell/（入库源码，bundle.resources 随包分发），
//! 运行时经 PYTHONPATH 注入，`pysdk_dir()` 按「安装布局 → 扁平布局 → dev 源目录」探测。

use std::path::PathBuf;
use std::sync::Arc;

use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Bytes, Incoming};
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{json, Value};
use tokio::net::TcpListener;

use crate::ai_actions::AiActions;

/// 请求体上限（sftp_write 内容 5MB + 协议余量，与 mcp.rs 同值）。
const MAX_HTTP_BODY_BYTES: usize = 8 * 1024 * 1024;

type BoxBodyRes = BoxBody<Bytes, std::io::Error>;

/// 一次性 SDK 桥句柄：url/token 注入 Python 进程环境；`stop` 在脚本结束后销毁监听。
pub struct PySdkBridge {
    url: String,
    token: String,
    stop_tx: tokio::sync::watch::Sender<bool>,
    task: tokio::task::JoinHandle<()>,
}

impl PySdkBridge {
    /// 绑定 127.0.0.1:0 起监听并返回句柄；失败时脚本应不带 SDK 环境继续（调用方决定）。
    pub async fn start(
        actions: Arc<AiActions>,
        project_id: &str,
        session_id: &str,
    ) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| format!("SDK 通道绑定端口失败：{e}"))?;
        let port = listener
            .local_addr()
            .map_err(|e| format!("SDK 通道读取端口失败：{e}"))?
            .port();
        let token = generate_token();
        let ctx = Arc::new(SdkCtx {
            actions,
            project_id: project_id.to_string(),
            session_id: session_id.to_string(),
            token: token.clone(),
        });
        let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
        let task = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = stop_rx.changed() => break,
                    acc = listener.accept() => {
                        let (stream, _) = match acc {
                            Ok(s) => s,
                            Err(_) => continue,
                        };
                        let ctx = Arc::clone(&ctx);
                        tokio::spawn(async move {
                            let io = hyper_util::rt::TokioIo::new(stream);
                            let svc = hyper::service::service_fn(move |req| {
                                let ctx = Arc::clone(&ctx);
                                async move { ctx.handle_http(req).await }
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
        });
        Ok(PySdkBridge {
            url: format!("http://127.0.0.1:{port}/rpc"),
            token,
            stop_tx,
            task,
        })
    }

    /// 注入 Python 进程的环境变量对（AISHELL_SDK_URL / AISHELL_SDK_TOKEN）。
    pub fn env_pairs(&self) -> Vec<(String, String)> {
        vec![
            ("AISHELL_SDK_URL".to_string(), self.url.clone()),
            ("AISHELL_SDK_TOKEN".to_string(), self.token.clone()),
        ]
    }

    /// 桥地址（仅测试用）。
    #[cfg(test)]
    pub(crate) fn url(&self) -> &str {
        &self.url
    }

    /// 一次性 token（仅测试用）。
    #[cfg(test)]
    pub(crate) fn token(&self) -> &str {
        &self.token
    }

    /// 销毁通道：停止接受新连接并终止监听任务（token 随之失效——只在内存）。
    /// await 任务句柄确保监听 socket 已释放（abort 是异步调度的）。
    pub async fn stop(self) {
        let _ = self.stop_tx.send(true);
        self.task.abort();
        let _ = self.task.await;
    }
}

/// SDK 通道的共享上下文（每连接 handler 持 Arc）。
struct SdkCtx {
    actions: Arc<AiActions>,
    project_id: String,
    session_id: String,
    token: String,
}

impl SdkCtx {
    async fn handle_http(
        &self,
        req: Request<Incoming>,
    ) -> Result<Response<BoxBodyRes>, std::convert::Infallible> {
        if req.method() != Method::POST || req.uri().path() != "/rpc" {
            return Ok(json_resp(
                StatusCode::NOT_FOUND,
                json!({"ok": false, "error": "未知路径"}),
            ));
        }
        // 鉴权：Bearer 一次性 token（仅内存，进程结束即失效）
        let auth_ok = req
            .headers()
            .get(hyper::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .map(|t| t == self.token.as_str())
            .unwrap_or(false);
        if !auth_ok {
            return Ok(json_resp(
                StatusCode::UNAUTHORIZED,
                json!({"ok": false, "error": "SDK 令牌无效或已失效"}),
            ));
        }
        // 请求体上限（先信 CONTENT_LENGTH，再实测）
        let declared = req
            .headers()
            .get(hyper::header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(0);
        if declared > MAX_HTTP_BODY_BYTES {
            return Ok(json_resp(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"ok": false, "error": "请求体超过 8MB 上限"}),
            ));
        }
        let bytes = match req.collect().await {
            Ok(c) => c.to_bytes(),
            Err(e) => {
                return Ok(json_resp(
                    StatusCode::BAD_REQUEST,
                    json!({"ok": false, "error": format!("读取请求体失败：{e}")}),
                ))
            }
        };
        if bytes.len() > MAX_HTTP_BODY_BYTES {
            return Ok(json_resp(
                StatusCode::PAYLOAD_TOO_LARGE,
                json!({"ok": false, "error": "请求体超过 8MB 上限"}),
            ));
        }
        let parsed: Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(e) => {
                return Ok(json_resp(
                    StatusCode::BAD_REQUEST,
                    json!({"ok": false, "error": format!("请求 JSON 解析失败：{e}")}),
                ))
            }
        };
        let out = self.dispatch(parsed).await;
        Ok(json_resp(StatusCode::OK, out))
    }

    /// 方法分发：全部委托 AiActions 执行体（锁/白名单/边界裁决在执行体入口完成）。
    async fn dispatch(&self, req: Value) -> Value {
        let method = req.get("method").and_then(Value::as_str).unwrap_or("");
        let params = req.get("params").cloned().unwrap_or(Value::Null);
        let str_param = |k: &str| {
            params
                .get(k)
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string()
        };
        let result: Result<Value, String> = match method {
            "list_servers" => self.actions.sdk_list_servers(&self.project_id),
            "ssh_exec" => {
                let timeout = params.get("timeoutSeconds").and_then(Value::as_u64);
                self.actions
                    .sdk_exec(&str_param("serverId"), &str_param("command"), timeout)
                    .await
                    .map(|r| serde_json::to_value(r).unwrap_or(Value::Null))
            }
            "sftp_list" => self
                .actions
                .remote_listdir(&str_param("serverId"), &str_param("path"))
                .await
                .and_then(|s| serde_json::from_str(&s).map_err(|e| format!("目录结果解析失败：{e}"))),
            "sftp_stat" => self
                .actions
                .remote_stat(&str_param("serverId"), &str_param("path"))
                .await
                .and_then(|s| serde_json::from_str(&s).map_err(|e| format!("属性结果解析失败：{e}"))),
            "sftp_read" => self
                .actions
                .remote_read(&str_param("serverId"), &str_param("path"))
                .await
                .and_then(|bytes| {
                    String::from_utf8(bytes).map_err(|_| "远端内容不是有效 UTF-8".to_string())
                })
                .map(Value::String),
            "sftp_write" => self
                .actions
                .remote_write(
                    &self.project_id,
                    &self.session_id,
                    &str_param("serverId"),
                    &str_param("path"),
                    &str_param("content"),
                )
                .await
                .map(Value::String),
            "sftp_mkdir" => self
                .actions
                .remote_mkdir(&str_param("serverId"), &str_param("path"))
                .await
                .map(|_| json!(format!("目录已就绪：{}", str_param("path")))),
            "sftp_rename" => self
                .actions
                .remote_rename(
                    &self.project_id,
                    &self.session_id,
                    &str_param("serverId"),
                    &str_param("from"),
                    &str_param("to"),
                )
                .await
                .map(Value::String),
            "sftp_delete" => self
                .actions
                .remote_delete(
                    &self.project_id,
                    &self.session_id,
                    &str_param("serverId"),
                    &str_param("path"),
                )
                .await
                .map(Value::String),
            "sftp_upload" => {
                let overwrite = params
                    .get("overwrite")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                self.actions
                    .sftp_upload(
                        &self.project_id,
                        &self.session_id,
                        str_param("serverId"),
                        str_param("localPath"),
                        str_param("remoteDir"),
                        overwrite,
                        None,
                    )
                    .await
                    .map(Value::String)
            }
            "sftp_download" => self
                .actions
                .sftp_download(
                    &self.project_id,
                    str_param("serverId"),
                    str_param("remotePath"),
                    str_param("localDir"),
                )
                .await
                .map(|_| json!(format!("下载完成：{}", str_param("remotePath")))),
            "db_list_connections" => self.actions.sdk_db_connections(&str_param("serverId")),
            "db_query" => self
                .actions
                .sdk_db_query(
                    &str_param("serverId"),
                    &str_param("connectionId"),
                    &str_param("command"),
                )
                .await
                .map(|r| serde_json::to_value(r).unwrap_or(Value::Null)),
            // 配置导入（本地 config 写盘，不经服务器锁；凭据只进 keyring）
            "import_project" => self.actions.sdk_import_project(&params),
            "import_commands" => self.actions.sdk_import_commands(&params),
            "import_skill" => self.actions.sdk_import_skill(&self.project_id, &params),
            "import_note" => self.actions.sdk_import_note(&params),
            other => Err(format!(
                "未知 SDK 方法：{other}（可用：list_servers/ssh_exec/sftp_*/db_list_connections/db_query/import_*）"
            )),
        };
        match result {
            Ok(v) => json!({"ok": true, "result": v}),
            Err(e) => json!({"ok": false, "error": e}),
        }
    }
}

/// 内置 SDK 包目录（resources/pysdk，含 aishell/ 包）：安装布局 → 扁平布局（兼容）→
/// dev 源目录。安装版 bundle.resources 解到 resource_dir/resources/ 子目录
/// （Windows 即 exe 旁 resources/；macOS 为 Contents/Resources/resources/）。
/// 找不到时返回 None——脚本 import aishell 会报 ModuleNotFoundError，py 结果如实呈现。
pub(crate) fn pysdk_dir() -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Windows 安装布局：resource_dir = exe 目录
            candidates.push(dir.join("resources").join("pysdk"));
            candidates.push(dir.join("pysdk"));
            // macOS 安装布局：Contents/MacOS/exe → Contents/Resources/resources/pysdk
            if let Some(contents) = dir.parent() {
                candidates.push(
                    contents
                        .join("Resources")
                        .join("resources")
                        .join("pysdk"),
                );
            }
        }
    }
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("pysdk"),
    );
    candidates
        .into_iter()
        .find(|p| p.join("aishell").join("__init__.py").is_file())
}

/// 一次性 token：sha256(纳秒时间戳‖pid‖进程内计数器) 十六进制前 32 字符
/// （与 store.rs mcp_token_generate 同思路，但只驻内存、不进 keyring）。
fn generate_token() -> String {
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
    hex::encode(h.finalize())[..32].to_string()
}

fn json_resp(status: StatusCode, body: Value) -> Response<BoxBodyRes> {
    let mut resp = Response::new(full(body.to_string().into_bytes()));
    *resp.status_mut() = status;
    resp.headers_mut().insert(
        hyper::header::CONTENT_TYPE,
        "application/json".parse().unwrap(),
    );
    resp
}

fn full(bytes: Vec<u8>) -> BoxBodyRes {
    Full::new(Bytes::from(bytes))
        .map_err(|e| match e {})
        .boxed()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// token 生成：32 位十六进制且两次生成不重复。
    #[test]
    fn token_is_unique_hex() {
        let a = generate_token();
        let b = generate_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    /// SDK 包目录探测：dev 源目录必须命中（resources/pysdk/aishell/__init__.py 入库）。
    #[test]
    fn pysdk_dir_hits_dev_source() {
        let dir = pysdk_dir().expect("未找到内置 SDK 包目录（resources/pysdk）");
        assert!(dir.join("aishell").join("__init__.py").is_file());
    }

    /// HTTP 桥端到端：无/错令牌 401、未知方法中文错误、list_servers 结构化返回、
    /// 未知项目报错、stop 后连接拒绝（token 随通道销毁失效）。
    #[tokio::test]
    async fn bridge_http_roundtrip() {
        let dir = std::env::temp_dir().join(format!("aishell-pysdk-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = Arc::new(crate::store::test_store(dir.clone()));
        store
            .upsert_project(crate::store::Project {
                id: "p1".to_string(),
                name: "演示项目".to_string(),
                path: None,
                server_ids: Vec::new(),
                quick_commands: Vec::new(),
                folder: String::new(),
                ai_mode: Default::default(),
            })
            .unwrap();
        let ssh = Arc::new(crate::ssh::SshManager::new(Arc::clone(&store)));
        let staging = Arc::new(crate::staging::RemoteStaging::new(
            dir.join("staging"),
            Arc::clone(&ssh),
            Arc::clone(&store),
        ));
        let actions = Arc::new(AiActions::new(
            store,
            ssh,
            staging,
            Arc::new(crate::browser::BrowserManager::new()),
        ));
        let bridge = PySdkBridge::start(actions, "p1", "s1").await.unwrap();
        let client = reqwest::Client::new();

        // 无令牌 / 错误令牌 → 401
        let resp = client
            .post(bridge.url())
            .json(&json!({"method": "list_servers"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);
        let resp = client
            .post(bridge.url())
            .bearer_auth("wrong-token")
            .json(&json!({"method": "list_servers"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 401);

        // 未知方法 → ok:false + 中文错误
        let resp = client
            .post(bridge.url())
            .bearer_auth(bridge.token())
            .json(&json!({"method": "nope"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 200);
        let body: Value = resp.json().await.unwrap();
        assert_eq!(body["ok"], false);
        assert!(body["error"].as_str().unwrap_or("").contains("未知 SDK 方法"));

        // list_servers（无服务器项目）→ ok:true 空数组
        let resp = client
            .post(bridge.url())
            .bearer_auth(bridge.token())
            .json(&json!({"method": "list_servers", "params": {}}))
            .send()
            .await
            .unwrap();
        let body: Value = resp.json().await.unwrap();
        assert_eq!(body["ok"], true);
        assert_eq!(body["result"], json!([]));

        // 未知路径 → 404
        let resp = client
            .post(bridge.url().replace("/rpc", "/other"))
            .bearer_auth(bridge.token())
            .json(&json!({"method": "list_servers"}))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), 404);

        // stop 后连接拒绝（通道销毁；换全新 client 避开 keep-alive 连接复用）
        let url = bridge.url().to_string();
        let token = bridge.token().to_string();
        bridge.stop().await;
        let res = reqwest::Client::new()
            .post(&url)
            .bearer_auth(token)
            .json(&json!({"method": "list_servers"}))
            .send()
            .await;
        assert!(res.is_err(), "stop 后通道仍可连接");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
