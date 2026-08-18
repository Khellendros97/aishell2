//! 云服务 OAuth2 客户端（协议以 docs/AIShell云服务-OAuth2接入文档.md 为准）。
//!
//! 流程（CR-1.2 的协议修正版）：
//! 1. `cloud_begin_login` 生成一次性 state（CSRF 防注入）并启动本地回环回调监听，
//!    返回授权 URL，前端用系统浏览器打开 `{server}/oauth/authorize`；
//! 2. 用户在云平台完成登录/授权后，服务端 302 回跳
//!    `http://127.0.0.1:38901/auth/callback?code=…&state=…`（RFC 8252 loopback 重定向，
//!    回调地址需在服务端白名单登记）；
//! 3. 本端校验 state → `POST {server}/oauth/token`（Basic 认证，client_id:client_secret）
//!    换取 access_token + refresh_token → 写入 keyring（cloud:*）；
//! 4. `GET {server}/api/auth/me` 拉取用户资料与能力清单 → 缓存进 aishell.json cloud 段；
//! 5. 广播 `cloud:changed`（载荷 = cloud_status 同构）驱动前端刷新。
//!
//! 硬约束（AGENTS.md / CR-1.5）：token 只进 keyring，永不进 aishell.json、永不返回前端；
//! serverUrl / client_id / client_secret 均为构建期注入（build.rs），客户端无修改入口。
//!
//! 登出（CR-1.7）：尽力调 `{server}/api/auth/logout` 吊销 refresh_token，失败忽略，
//! 本地一律清 keyring + cloud 段；个人模式配置（llm/search）不受影响。

use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, State};

use crate::store::{CloudCapabilities, CloudMode, CloudUser, Store};

/// 构建期注入的云配置（build.rs）；任一缺失 = 未接入，云功能整体隐藏。
const SERVER_URL: Option<&str> = option_env!("AISHELL_SERVER_URL");
const CLIENT_ID: Option<&str> = option_env!("AISHELL_CLIENT_ID");
const CLIENT_SECRET: Option<&str> = option_env!("AISHELL_CLIENT_SECRET");

/// 本地回调监听端口（redirect_uri 白名单精确匹配，端口必须固定；127.0.0.1 回环不触发防火墙）。
const REDIRECT_PORT: u16 = 38901;
const REDIRECT_PATH: &str = "/auth/callback";
const REDIRECT_URI: &str = "http://127.0.0.1:38901/auth/callback";

/// 授权超时（CR-1.4）：2 分钟未收到回调自动作废。
const LOGIN_TIMEOUT: Duration = Duration::from_secs(120);

/// 授权中 state 的字符数（hex 32 位）。
const STATE_HEX_LEN: usize = 32;

/// 内存中的云会话状态（令牌的权威存储是 keyring，内存仅做过期缓存）。
struct CloudInner {
    /// 进行中的授权会话 state（回跳时比对，防 CSRF 授权注入）
    pending_state: Option<String>,
    /// 授权回调服务器的取消通道（cancel_login 时触发）
    cancel: Option<tokio::sync::oneshot::Sender<()>>,
    /// access_token 内存缓存（仅当未过期时有效）
    access_token: Option<String>,
    /// access_token 过期时刻（unix 秒）
    access_expires_at: Option<u64>,
}

/// Tauri 托管：登录会话 + 令牌内存缓存。
pub struct CloudManager {
    inner: Mutex<CloudInner>,
}

impl Default for CloudManager {
    fn default() -> Self {
        Self {
            inner: Mutex::new(CloudInner {
                pending_state: None,
                cancel: None,
                access_token: None,
                access_expires_at: None,
            }),
        }
    }
}

impl CloudManager {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, CloudInner>, String> {
        self.inner
            .lock()
            .map_err(|_| "云会话状态锁损坏".to_string())
    }
}

/// cloud_status 返回值（token 永不在此；与前端 src/api.ts CloudStatus 对齐）。
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CloudStatus {
    pub logged_in: bool,
    pub user: Option<CloudUser>,
    pub capabilities: Option<CloudCapabilities>,
    /// 构建期注入的服务器地址；None = 未接入云服务
    pub server_url: Option<String>,
    pub mode: CloudMode,
}

/// 当前登录态与展示资料（供 cloud_status 与事件载荷复用）。
fn build_status(store: &Store) -> CloudStatus {
    let (user, caps) = store.cloud_profile();
    // 登录态以 refresh_token 是否在 keyring 为准（access 可能已过期，请求时再轮换）。
    let logged_in = store.cloud_tokens().1.is_some();
    CloudStatus {
        logged_in,
        user,
        capabilities: caps,
        server_url: server_url(),
        mode: store.cloud_mode(),
    }
}

fn emit_changed(app: &AppHandle, store: &Store) {
    let status = build_status(store);
    let _ = app.emit("cloud:changed", status);
}

/// 密码学随机 hex 字符串（state）。
fn random_hex(len: usize) -> Result<String, String> {
    let mut buf = vec![0u8; len / 2];
    getrandom::fill(&mut buf).map_err(|e| format!("生成随机数失败: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect::<String>())
}

/// 构建注入的服务器地址（去尾斜杠）；未注入返回 None。
/// 供 ai.rs（托管模式 baseUrl 拼接）与 smart_approval.rs 复用。
pub fn server_url() -> Option<String> {
    SERVER_URL
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
}

/// 取 OAuth 应用凭据；未配置时返回可执行中文错误（前端据此隐藏云功能）。
/// 服务器地址去掉尾部斜杠，避免拼接出 `//oauth/token` 双斜杠（配置常带 `/`）。
fn credentials() -> Result<(String, String, String), String> {
    match (SERVER_URL, CLIENT_ID, CLIENT_SECRET) {
        (Some(u), Some(i), Some(s)) if !u.is_empty() && !i.is_empty() && !s.is_empty() => Ok((
            server_url().unwrap_or_default(),
            i.to_string(),
            s.to_string(),
        )),
        _ => Err("当前构建未配置云服务（缺少服务器地址或应用凭据）".to_string()),
    }
}

/// 解析回跳 query 字符串中的参数（只处理 URL 编码过的键值；未编码键值原样返回）。
fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else {
            continue;
        };
        map.insert(
            k.to_string(),
            percent_decode(v).unwrap_or_else(|| v.to_string()),
        );
    }
    map
}

/// 极简 percent-decode（回调参数为 code/state 十六进制，无复杂转义需求）。
fn percent_decode(s: &str) -> Option<String> {
    if !s.contains('%') {
        return Some(s.to_string());
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// 授权回调服务器的响应页（浏览器短暂显示后由用户关闭）。
fn callback_response_html(ok: bool, message: &str) -> String {
    let title = if ok { "登录成功" } else { "登录失败" };
    let color = if ok { "#16a34a" } else { "#dc2626" };
    format!(
        "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>{title}</title>\
         <body style=\"font-family:system-ui;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f8fafc\">\
         <div style=\"text-align:center\"><div style=\"font-size:48px;color:{color}\">{title}</div>\
         <p style=\"color:#475569\">{}</p><p style=\"color:#94a3b8;font-size:13px\">此页面可关闭，返回 AIShell 继续。</p></div></body></html>",
        message
    )
}

/// 向回调浏览器写出**完整 HTTP 响应**（状态行 + 头 + body）。
/// 早期实现只写裸 HTML，真实浏览器无法解析协议报文，表现为「无法访问此页面」。
async fn write_callback_response(stream: &mut tokio::net::TcpStream, ok: bool, message: &str) {
    use tokio::io::AsyncWriteExt;
    let html = callback_response_html(ok, message);
    let status = if ok { "200 OK" } else { "400 Bad Request" };
    let resp = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}",
        html.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
}

/// 处理一次本地回调连接：解析 code/state → 校验 → 换令牌 → 拉用户 → 落库 → 广播。
/// 返回 true 表示本次登录流程已结束（监听任务应退出）。
async fn handle_callback(
    stream: &mut tokio::net::TcpStream,
    cloud: &Arc<CloudManager>,
    store: &Arc<Store>,
    app: &AppHandle,
    expected_state: &str,
) -> bool {
    use tokio::io::AsyncReadExt;

    let mut buf = [0u8; 8192];
    let n = stream.read(&mut buf).await.unwrap_or(0);
    let req = String::from_utf8_lossy(&buf[..n]);
    let request_line = req.lines().next().unwrap_or("");

    // 提取路径与 query：GET /auth/callback?code=…&state=… HTTP/1.1
    let path_query = request_line.split_whitespace().nth(1).unwrap_or_default();
    let (path, query) = match path_query.split_once('?') {
        Some((p, q)) => (p, q),
        None => (path_query, ""),
    };

    if path != REDIRECT_PATH {
        write_callback_response(stream, false, "回调路径不匹配，请检查服务端白名单配置。").await;
        return false;
    }

    let params = parse_query(query);
    let code = params.get("code").cloned();
    let state = params.get("state").cloned();

    // state 校验：缺失或与发起时不一致 → 拒绝（防 CSRF 授权注入）
    if state.as_deref() != Some(expected_state) {
        write_callback_response(stream, false, "state 校验失败，请重新发起登录。").await;
        return true;
    }
    let Some(code) = code else {
        write_callback_response(stream, false, "回调缺少授权码（code）。").await;
        return true;
    };

    let result = exchange_tokens(&code).await;
    match result {
        Ok((access, refresh, expires_in)) => {
            // 刷新轮换后 refresh_token 一并更新；access 过期时间入内存缓存
            if let Err(e) = store.cloud_set_tokens(&access, &refresh) {
                write_callback_response(stream, false, &e).await;
                return true;
            }
            cloud.set_memory_access(&access, expires_in);
            let profile = fetch_me(&access).await;
            match profile {
                Ok((user, caps)) => {
                    if let Err(e) = store.cloud_login_info(user, caps) {
                        write_callback_response(stream, false, &e).await;
                        return true;
                    }
                    // 诊断：能力清单决定 web_search/知识库工具挂载，服务端配置变更需重登刷新
                    crate::term::diag(&format!(
                        "[cloud] 登录成功，capabilities: models={} search={} knowledge={}",
                        store.cloud_profile().1.map(|c| c.models.len()).unwrap_or(0),
                        store.cloud_profile().1.map(|c| c.search).unwrap_or(false),
                        store
                            .cloud_profile()
                            .1
                            .map(|c| c.knowledge)
                            .unwrap_or(false),
                    ));
                    write_callback_response(stream, true, "授权成功，公司账号已关联到 AIShell。")
                        .await;
                    emit_changed(app, store);
                    true
                }
                Err(e) => {
                    // me 拉取失败：令牌已存但资料未落库 → 清登录态，避免半登录
                    let _ = store.cloud_clear();
                    write_callback_response(stream, false, &e).await;
                    emit_changed(app, store);
                    true
                }
            }
        }
        Err(e) => {
            write_callback_response(stream, false, &e).await;
            true
        }
    }
}

/// 记录 access_token 内存缓存（过期时刻 = now + expires_in）。
impl CloudManager {
    fn set_memory_access(&self, access: &str, expires_in: u64) {
        let mut inner = match self.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        inner.access_token = Some(access.to_string());
        inner.access_expires_at = Some(now_unix() + expires_in);
    }

    /// 取未过期的 access_token（CR-1.6 前置：请求前确保令牌有效）。
    /// 内存缓存过期/缺失 → 用 keyring refresh_token 轮换（refresh_token 每次使用都会轮换，
    /// 见 OAuth2 文档 §4.3）；刷新失败（吊销/禁用）→ 清登录态并返回中文可执行错误。
    pub async fn valid_access_token(&self, store: &Arc<Store>) -> Result<String, String> {
        {
            let inner = self.lock()?;
            if let (Some(tok), Some(exp)) = (&inner.access_token, inner.access_expires_at) {
                // 留 30 秒余量，避免请求中途 401
                if exp > now_unix().saturating_add(30) {
                    return Ok(tok.clone());
                }
            }
        }
        let refresh = store
            .cloud_tokens()
            .1
            .ok_or_else(|| "登录已过期，请前往账号页重新登录后使用公司服务".to_string())?;
        let (access, new_refresh, expires_in) = refresh_tokens(&refresh).await?;
        if new_refresh.is_empty() {
            store.cloud_set_access_token(&access)?;
        } else {
            store.cloud_set_tokens(&access, &new_refresh)?;
        }
        self.set_memory_access(&access, expires_in);
        Ok(access)
    }
}

fn now_unix() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// POST {server}/oauth/token（grant_type=refresh_token）轮换令牌对。
async fn refresh_tokens(refresh: &str) -> Result<(String, String, u64), String> {
    let (server, client_id, client_secret) = credentials()?;
    let url = format!("{server}/oauth/token");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .basic_auth(&client_id, Some(&client_secret))
        .form(&[("grant_type", "refresh_token"), ("refresh_token", refresh)])
        .send()
        .await
        .map_err(|e| format!("连接云平台令牌端点失败: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析云平台响应失败: {e}"))?;
    if !status.is_success() {
        let err = body
            .get("error_description")
            .or_else(|| body.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        // 401 invalid_grant / 400 access_denied 等 = refresh 失效或账号被禁用
        return Err(format!("令牌续期失败（HTTP {status}）: {err}"));
    }
    let access = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "云平台响应缺少 access_token".to_string())?
        .to_string();
    let new_refresh = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let expires_in = body
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(7200);
    Ok((access, new_refresh, expires_in))
}

/// POST {server}/oauth/token（grant_type=authorization_code）换取令牌对。
async fn exchange_tokens(code: &str) -> Result<(String, String, u64), String> {
    let (server, client_id, client_secret) = credentials()?;
    let url = format!("{server}/oauth/token");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .basic_auth(&client_id, Some(&client_secret))
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", REDIRECT_URI),
        ])
        .send()
        .await
        .map_err(|e| format!("连接云平台令牌端点失败: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析云平台响应失败: {e}"))?;
    if !status.is_success() {
        let err = body
            .get("error_description")
            .or_else(|| body.get("error"))
            .and_then(|v| v.as_str())
            .unwrap_or("未知错误");
        return Err(format!("云平台令牌签发失败（HTTP {status}）: {err}"));
    }
    let access = body
        .get("access_token")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "云平台响应缺少 access_token".to_string())?
        .to_string();
    let refresh = body
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let expires_in = body
        .get("expires_in")
        .and_then(|v| v.as_u64())
        .unwrap_or(7200);
    Ok((access, refresh, expires_in))
}

/// GET {server}/api/auth/me：用户资料 + 能力清单（防御解析：字段缺失按默认）。
/// 服务端结构不确定（可能带 data 包装 / user 嵌套 / 不同字段名），做多层兜底：
/// 用户对象定位 = body → body.data → body.data.user → body.user。
async fn fetch_me(access: &str) -> Result<(CloudUser, CloudCapabilities), String> {
    let (server, ..) = credentials()?;
    let url = format!("{server}/api/auth/me");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .bearer_auth(access)
        .send()
        .await
        .map_err(|e| format!("连接云平台用户接口失败: {e}"))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析云平台用户信息失败: {e}"))?;
    if !status.is_success() {
        return Err(format!("拉取用户信息失败（HTTP {status}）"));
    }
    // 诊断：完整 me 响应（capabilities 决定工具挂载，字段结构需与服务端对齐）
    crate::term::diag(&format!("[cloud] /api/auth/me 响应: {body}"));
    let data = body.get("data").unwrap_or(&body);
    let user_obj = data
        .get("user")
        .or_else(|| body.get("user"))
        .unwrap_or(data);
    let str_field = |v: &serde_json::Value, keys: &[&str]| -> Option<String> {
        keys.iter()
            .find_map(|k| v.get(*k).and_then(|x| x.as_str()))
            .map(String::from)
    };
    let user = CloudUser {
        // 用户 id：记忆卡片权限判断（creatorId === 当前用户 id）依赖该字段
        id: user_obj.get("id").and_then(|v| v.as_i64()).or_else(|| {
            user_obj
                .get("userId")
                .or_else(|| user_obj.get("uid"))
                .and_then(|v| v.as_i64())
        }),
        name: str_field(
            user_obj,
            &[
                "name",
                "username",
                "nickname",
                "display_name",
                "displayName",
            ],
        )
        .unwrap_or_else(|| "未知用户".to_string()),
        avatar: str_field(
            user_obj,
            &[
                "avatar",
                "avatarURL",
                "avatar_url",
                "avatarUrl",
                "photo",
                "portrait",
            ],
        ),
        dept: str_field(
            user_obj,
            &["dept", "department", "department_name", "departmentName"],
        ),
    };
    // 诊断：头像未解析到时打印原始响应到 Debug 面板，区分
    // 「服务端未返回/字段名不匹配/服务端用户无头像」（term::diag → debug:log 事件流）
    if user.avatar.is_none() {
        crate::term::diag(&format!(
            "[cloud] /api/auth/me 未解析到头像，原始响应: {body}"
        ));
    }
    // capabilities：用户对象 → data → body 三级兜底
    let caps_raw = user_obj
        .get("capabilities")
        .or_else(|| data.get("capabilities"))
        .or_else(|| body.get("capabilities"));
    let mut caps = CloudCapabilities::default();
    if let Some(c) = caps_raw {
        caps.models = c
            .get("models")
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|x| x.as_str().map(String::from))
                    .collect()
            })
            .unwrap_or_default();
        caps.search = c.get("search").and_then(|v| v.as_bool()).unwrap_or(false);
        caps.knowledge = c
            .get("knowledge")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        caps.latest_version = str_field(c, &["latest_version", "latestVersion"]);
    }
    Ok((user, caps))
}

/// 授权回调监听任务：三路 select（连接 / 取消 / 超时），处理一次回调后退出。
async fn run_callback_server(
    cloud: Arc<CloudManager>,
    store: Arc<Store>,
    app: AppHandle,
    expected_state: String,
    mut cancel: tokio::sync::oneshot::Receiver<()>,
) {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", REDIRECT_PORT)).await {
        Ok(l) => l,
        Err(e) => {
            crate::term::diag(&format!("[cloud] 回调端口 {REDIRECT_PORT} 监听失败: {e}"));
            return;
        }
    };
    let deadline = Instant::now() + LOGIN_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break; // 超时作废（CR-1.4）
        }
        tokio::select! {
            _ = &mut cancel => break,
            res = tokio::time::timeout(remaining, listener.accept()) => {
                match res {
                    Ok(Ok((mut stream, _))) => {
                        if handle_callback(&mut stream, &cloud, &store, &app, &expected_state).await {
                            break;
                        }
                    }
                    _ => break,
                }
            }
        }
    }
}

// ---------------------------------------------------------------- 启动刷新

/// 应用启动时（lib.rs setup 异步调用）：已登录则拉取最新用户资料与能力清单，
/// 服务端配置变更（models/search/knowledge）无需用户重登即可生效。
/// 流程：未登录直接跳过 → valid_access_token（过期自动轮换）→ me → 更新缓存并广播；
/// 刷新失败（吊销/禁用）→ 登录失效，清登录态（账号页与角标随之刷新）。
pub async fn refresh_on_startup(app: &AppHandle, store: &Arc<Store>, cloud: &Arc<CloudManager>) {
    // 未登录（keyring 无 refresh_token）不处理
    if store.cloud_tokens().1.is_none() {
        return;
    }
    match cloud.valid_access_token(store).await {
        Ok(token) => match fetch_me(&token).await {
            Ok((user, caps)) => {
                if let Err(e) = store.cloud_update_profile(user, caps) {
                    crate::term::diag(&format!("[cloud] 启动刷新资料失败: {e}"));
                    return;
                }
                crate::term::diag(&format!(
                    "[cloud] 启动刷新：models={} search={} knowledge={}",
                    store.cloud_profile().1.map(|c| c.models.len()).unwrap_or(0),
                    store.cloud_profile().1.map(|c| c.search).unwrap_or(false),
                    store
                        .cloud_profile()
                        .1
                        .map(|c| c.knowledge)
                        .unwrap_or(false),
                ));
                emit_changed(app, store);
            }
            Err(e) => crate::term::diag(&format!("[cloud] 启动刷新 me 拉取失败: {e}")),
        },
        Err(e) => {
            // refresh 失效（服务端吊销/账号禁用）→ 登录失效，清登录态
            crate::term::diag(&format!("[cloud] 启动刷新登录失效: {e}"));
            let _ = store.cloud_clear();
            emit_changed(app, store);
        }
    }
}

// ---------------------------------------------------------------- 开放 API（用量 / 记忆卡片）

/// 带 Bearer 的 JSON 请求；成功返回解析后的 JSON（204 等无体响应返回 Null）。
/// token 由 `valid_access_token` 在请求前续期（CR-1.6）；仍 401 = refresh 失效/账号禁用，
/// 统一按服务端错误文本透传（协议见 docs/AIShell云服务-开放API文档.md 与 记忆卡片API文档.md）。
async fn cloud_api_request(
    cloud: &Arc<CloudManager>,
    store: &Arc<Store>,
    method: reqwest::Method,
    path: &str,
    query: &[(&str, String)],
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let (server, ..) = credentials()?;
    let token = cloud.valid_access_token(store).await?;
    let url = format!("{server}{path}");
    let client = reqwest::Client::new();
    let mut req = client.request(method, &url).bearer_auth(&token);
    if !query.is_empty() {
        req = req.query(query);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("连接云平台失败: {e}"))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("读取云平台响应失败: {e}"))?;
    if !status.is_success() {
        return Err(api_error_text(status.as_u16(), &text));
    }
    let t = text.trim();
    if t.is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(t).map_err(|e| format!("解析云平台响应失败: {e}"))
}

/// 带 Bearer 的二进制下载请求，供 SkillHub ZIP 使用，响应体不经过 JSON 解析。
async fn cloud_api_download(
    cloud: &Arc<CloudManager>,
    store: &Arc<Store>,
    path: &str,
    query: &[(&str, String)],
) -> Result<Vec<u8>, String> {
    let (server, ..) = credentials()?;
    let token = cloud.valid_access_token(store).await?;
    let url = format!("{server}{path}");
    let client = reqwest::Client::new();
    let mut req = client.get(&url).bearer_auth(&token);
    if !query.is_empty() {
        req = req.query(query);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("连接云平台失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp
            .text()
            .await
            .map_err(|e| format!("读取云平台错误响应失败：{e}"))?;
        return Err(api_error_text(status.as_u16(), &text));
    }
    const MAX_SKILLHUB_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;
    if resp
        .content_length()
        .is_some_and(|length| length > MAX_SKILLHUB_DOWNLOAD_BYTES as u64)
    {
        return Err("SkillHub 下载包过大（上限 50 MiB）".to_string());
    }
    let mut resp = resp;
    let mut bytes = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取 SkillHub 下载包失败：{e}"))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_SKILLHUB_DOWNLOAD_BYTES {
            return Err("SkillHub 下载包过大（上限 50 MiB）".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

/// 非 2xx 响应的中文错误提取：统一格式 {"error": "中文可读信息"}，
/// 兼容 error_description/msg 兜底；无 JSON 结构时原样截取响应文本。
fn api_error_text(status: u16, text: &str) -> String {
    let err = serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|v| {
            v.get("error")
                .or_else(|| v.get("error_description"))
                .or_else(|| v.get("msg"))
                .and_then(|x| x.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| {
            let t = text.trim();
            if t.is_empty() {
                "无响应内容".to_string()
            } else {
                t.to_string()
            }
        });
    format!("{err}（HTTP {status}）")
}

/// GET /api/usage 响应（开放 API 文档 §4.1）；字段缺失按默认兜底（防御服务端结构微调）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageReport {
    pub from: String,
    pub to: String,
    pub timezone: String,
    pub summary: UsageSummary,
    pub daily: Vec<UsageDaily>,
    pub models: Vec<UsageModel>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageSummary {
    pub requests: u64,
    pub llm_requests: u64,
    pub search_requests: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub average_latency_ms: f64,
    pub error_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageDaily {
    pub date: String,
    pub requests: u64,
    pub llm_requests: u64,
    pub search_requests: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub error_count: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageModel {
    pub model: String,
    pub requests: u64,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

/// 记忆卡片（记忆卡片 API 文档 §1.2）；creatorId 为创建时快照的数字 id。
/// scope：shared（团队共享）/ personal（仅本人可见）；存量旧卡片字段缺失按共享处理。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryCard {
    pub id: String,
    pub content: String,
    pub category: String,
    pub tags: Vec<String>,
    pub creator_id: Option<i64>,
    pub creator_name: String,
    pub dept: String,
    pub source: String,
    /// shared / personal；旧卡片可能缺失（按共享处理）
    pub scope: Option<String>,
    /// 自动沉淀卡片元数据（手动卡片通常无，客户端仅透传展示）
    pub project_name: Option<String>,
    pub session_id: Option<String>,
    pub date: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// 卡片变更历史事件（§6）：event = ADD / UPDATE。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryEvent {
    pub event: String,
    pub value: String,
    pub ts: String,
    pub actor: String,
    pub note: String,
}

/// 语义检索命中（§7.2）：卡片字段平铺 + 相关度 score。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryHit {
    #[serde(flatten)]
    pub card: MemoryCard,
    pub score: f64,
}

// ---------------------------------------------------------------- Tauri commands

/// 发起登录：生成 state、启动本地回调监听，返回授权 URL（前端 openUrl 打开系统浏览器）。
/// 未注入云配置时返回中文错误（前端隐藏云功能，正常路径不会调用）。
#[tauri::command]
pub async fn cloud_begin_login(
    app: AppHandle,
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
) -> Result<String, String> {
    let (server, client_id, _) = credentials()?;
    let mut inner = cloud.lock()?;
    if inner.pending_state.is_some() {
        return Err("已有登录进行中，请先完成或取消当前登录".to_string());
    }
    let state = random_hex(STATE_HEX_LEN)?;
    inner.pending_state = Some(state.clone());
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    inner.cancel = Some(cancel_tx);
    drop(inner);

    let store2 = Arc::clone(&store);
    let app2 = app.clone();
    let state2 = state.clone();
    let cloud2 = Arc::clone(&cloud);
    tokio::spawn(async move {
        run_callback_server(cloud2.clone(), store2, app2, state2.clone(), cancel_rx).await;
        // 监听结束：仅当 pending 仍是本次会话时清掉（避免误清新会话）
        if let Ok(mut inner) = cloud2.lock() {
            if inner.pending_state.as_deref() == Some(state2.as_str()) {
                inner.pending_state = None;
                inner.cancel = None;
            }
        }
    });

    let url = format!(
        "{server}/oauth/authorize?client_id={client_id}&redirect_uri={}&response_type=code&state={}",
        urlencode(REDIRECT_URI),
        state
    );
    Ok(url)
}

/// 取消进行中的登录（作废 state 并关闭回调监听）。
#[tauri::command]
pub async fn cloud_cancel_login(cloud: State<'_, Arc<CloudManager>>) -> Result<(), String> {
    let mut inner = cloud.lock()?;
    inner.pending_state = None;
    if let Some(tx) = inner.cancel.take() {
        let _ = tx.send(());
    }
    Ok(())
}

/// 退出登录：尽力吊销服务端 refresh_token（失败忽略），本地清 keyring + cloud 段，
/// 广播 cloud:changed；个人模式配置不受影响（CR-1.7）。
#[tauri::command]
pub async fn cloud_logout(app: AppHandle, store: State<'_, Arc<Store>>) -> Result<(), String> {
    let (server, _, _) = credentials().unwrap_or_default();
    let access = store.cloud_tokens().0;
    if !server.is_empty() {
        if let Some(token) = access {
            let url = format!("{server}/api/auth/logout");
            let client = reqwest::Client::new();
            // 吊销失败不阻塞本地登出
            let _ = client.post(&url).bearer_auth(token).send().await;
        }
    }
    store.cloud_clear()?;
    emit_changed(&app, &store);
    Ok(())
}
// ---------------------------------------------------------------- SkillHub（文档 §8）

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillHubItem {
    #[serde(default)]
    pub id: i64,
    pub namespace: String,
    pub slug: String,
    pub display_name: String,
    pub summary: String,
    #[serde(default)]
    pub tags: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub downloads: u64,
    #[serde(default)]
    pub stars: u64,
    #[serde(default)]
    pub download_count: u64,
    #[serde(default)]
    pub star_count: u64,
    #[serde(default)]
    pub rating_avg: f64,
    #[serde(default)]
    pub rating_count: u64,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
    #[serde(default)]
    pub latest_version: String,
    #[serde(default)]
    pub changelog: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub owner_id: String,
    #[serde(default)]
    pub owner_display_name: String,
    #[serde(default)]
    pub visibility: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub hidden: bool,
    #[serde(default)]
    pub headline_version: Option<SkillHubVersion>,
    #[serde(default)]
    pub published_version: Option<SkillHubVersion>,
    #[serde(default)]
    pub owner_preview_version: Option<SkillHubVersion>,
    #[serde(default)]
    pub resolution_mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillHubVersion {
    #[serde(default)]
    pub id: i64,
    pub version: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub changelog: String,
    #[serde(default)]
    pub file_count: u64,
    #[serde(default)]
    pub total_size: u64,
    #[serde(default)]
    pub published_at: String,
    #[serde(default)]
    pub download_available: bool,
    #[serde(default)]
    pub metadata: serde_json::Value,
    #[serde(default)]
    pub body: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillHubList {
    pub items: Vec<SkillHubItem>,
    #[serde(default)]
    pub next_cursor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillHubDetail {
    pub skill: SkillHubItem,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SkillHubVersionDetail {
    pub version: SkillHubVersion,
}

fn skillhub_segment(value: &str) -> String {
    utf8_percent_encode(value.trim(), NON_ALPHANUMERIC).to_string()
}

#[tauri::command]
pub async fn skillhub_list(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    q: Option<String>,
    cursor: Option<String>,
    size: Option<u32>,
) -> Result<SkillHubList, String> {
    let mut query = Vec::new();
    if let Some(value) = q.filter(|value| !value.trim().is_empty()) {
        query.push(("q", value.trim().to_string()));
    }
    if let Some(value) = cursor.filter(|value| !value.trim().is_empty()) {
        query.push(("cursor", value));
    }
    query.push(("size", size.unwrap_or(24).clamp(1, 100).to_string()));
    let value = cloud_api_request(
        &cloud,
        &store,
        reqwest::Method::GET,
        "/api/skills",
        &query,
        None,
    )
    .await?;
    serde_json::from_value(value).map_err(|e| format!("解析 SkillHub 列表失败：{e}"))
}

#[tauri::command]
pub async fn skillhub_detail(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    namespace: String,
    slug: String,
) -> Result<SkillHubDetail, String> {
    let path = format!(
        "/api/skills/{}/{}",
        skillhub_segment(&namespace),
        skillhub_segment(&slug)
    );
    let value = cloud_api_request(&cloud, &store, reqwest::Method::GET, &path, &[], None).await?;
    serde_json::from_value(value).map_err(|e| format!("解析 SkillHub 详情失败：{e}"))
}

#[tauri::command]
pub async fn skillhub_version_detail(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    namespace: String,
    slug: String,
    version: String,
) -> Result<SkillHubVersionDetail, String> {
    let path = format!(
        "/api/skills/{}/{}/versions/{}",
        skillhub_segment(&namespace),
        skillhub_segment(&slug),
        skillhub_segment(&version)
    );
    let value = cloud_api_request(&cloud, &store, reqwest::Method::GET, &path, &[], None).await?;
    serde_json::from_value(value).map_err(|e| format!("解析 SkillHub 版本详情失败：{e}"))
}

#[tauri::command]
pub async fn skillhub_download(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    project_id: String,
    origin: crate::skills::SkillOrigin,
    namespace: String,
    slug: String,
    version: String,
) -> Result<crate::skills::SkillSummary, String> {
    let path = format!(
        "/api/skills/{}/{}/download",
        skillhub_segment(&namespace),
        skillhub_segment(&slug)
    );
    let query = vec![("version", version)];
    let bytes = cloud_api_download(&cloud, &store, &path, &query).await?;
    crate::skills::install_skillhub_zip(store.inner().as_ref(), &project_id, origin, &slug, &bytes)
}

/// 当前云状态：登录态、用户资料、能力清单、服务器地址（构建常量）、模式。
/// token 永不返回（CR-1.5）。Tauri async 命令带引用输入必须返回 Result。
#[tauri::command]
pub async fn cloud_status(store: State<'_, Arc<Store>>) -> Result<CloudStatus, String> {
    Ok(build_status(&store))
}

/// 手动切换托管/个人模式（仅已登录时托管模式有意义；未登录切托管在请求层报错引导）。
#[tauri::command]
pub async fn cloud_set_mode(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    mode: CloudMode,
) -> Result<(), String> {
    store.cloud_set_mode(mode)?;
    emit_changed(&app, &store);
    Ok(())
}

// ---------------------------------------------------------------- 用量报表（GET /api/usage，文档 §4.1）

/// 个人用量报表：仅统计当前令牌用户本人（服务端强制忽略 userId 参数）。
/// `days` 1–90（默认 14）；`kind` llm|search；`model` 模型名过滤（仅 LLM）。
#[tauri::command]
pub async fn cloud_usage(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    days: Option<u32>,
    kind: Option<String>,
    model: Option<String>,
) -> Result<UsageReport, String> {
    let mut q: Vec<(&str, String)> = Vec::new();
    if let Some(d) = days {
        if (1..=90).contains(&d) {
            q.push(("days", d.to_string()));
        }
    }
    if let Some(k) = kind {
        if !k.is_empty() {
            q.push(("kind", k));
        }
    }
    if let Some(m) = model {
        if !m.is_empty() {
            q.push(("model", m));
        }
    }
    let v = cloud_api_request(&cloud, &store, reqwest::Method::GET, "/api/usage", &q, None).await?;
    serde_json::from_value(v).map_err(|e| format!("解析用量报表失败: {e}"))
}

// ---------------------------------------------------------------- 记忆卡片（文档：记忆卡片 API）

/// 拉取记忆卡片（GET /api/memories，不分页）。
/// `scope`：缺省/空 = all（共享 + 当前用户个人，按更新时间倒序合并）；`shared` 仅共享；
/// `personal` 仅当前用户个人卡片（他人的个人卡片任何 scope 下都不出现）。
#[tauri::command]
pub async fn memories_list(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    scope: Option<String>,
) -> Result<Vec<MemoryCard>, String> {
    let q: Vec<(&str, String)> = match scope {
        Some(s) if !s.trim().is_empty() && s != "all" => vec![("scope", s.trim().to_string())],
        _ => Vec::new(),
    };
    let v = cloud_api_request(
        &cloud,
        &store,
        reqwest::Method::GET,
        "/api/memories",
        &q,
        None,
    )
    .await?;
    let cards = v
        .get("memories")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    serde_json::from_value(cards).map_err(|e| format!("解析记忆卡片列表失败: {e}"))
}

/// 主动提交一条记忆（POST /api/memories）：内容原文保存，不被 AI 改写。
/// `scope`：shared（默认）/ personal；共享入口提交 shared，个人工作记录/偏好提交 personal。
#[tauri::command]
pub async fn memory_create(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    content: String,
    category: String,
    tags: Option<Vec<String>>,
    scope: Option<String>,
) -> Result<MemoryCard, String> {
    let mut body = serde_json::json!({ "content": content, "category": category });
    if let Some(t) = tags {
        body["tags"] = serde_json::json!(t);
    }
    if let Some(s) = scope {
        if !s.trim().is_empty() {
            body["scope"] = serde_json::json!(s.trim());
        }
    }
    let v = cloud_api_request(
        &cloud,
        &store,
        reqwest::Method::POST,
        "/api/memories",
        &[],
        Some(body),
    )
    .await?;
    serde_json::from_value(v).map_err(|e| format!("解析记忆卡片失败: {e}"))
}

/// 编辑/纠正卡片（PUT /api/memories/{id}）：仅创建者本人或管理员；可附纠正说明留痕。
#[tauri::command]
pub async fn memory_update(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    id: String,
    content: String,
    category: String,
    tags: Option<Vec<String>>,
    note: Option<String>,
) -> Result<(), String> {
    let mut body = serde_json::json!({ "content": content, "category": category });
    if let Some(t) = tags {
        body["tags"] = serde_json::json!(t);
    }
    if let Some(n) = note {
        if !n.trim().is_empty() {
            body["note"] = serde_json::json!(n);
        }
    }
    let _ = cloud_api_request(
        &cloud,
        &store,
        reqwest::Method::PUT,
        &format!("/api/memories/{id}"),
        &[],
        Some(body),
    )
    .await?;
    Ok(())
}

/// 删除卡片（DELETE /api/memories/{id}）：全员不可见、历史一并清除、不可恢复；
/// 前端已二次确认。非创建者/管理员由服务端 403 拒绝。
#[tauri::command]
pub async fn memory_delete(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    id: String,
) -> Result<(), String> {
    let _ = cloud_api_request(
        &cloud,
        &store,
        reqwest::Method::DELETE,
        &format!("/api/memories/{id}"),
        &[],
        None,
    )
    .await?;
    Ok(())
}

/// 单卡变更历史时间线（GET /api/memories/{id}/history）。
#[tauri::command]
pub async fn memory_history(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    id: String,
) -> Result<Vec<MemoryEvent>, String> {
    let v = cloud_api_request(
        &cloud,
        &store,
        reqwest::Method::GET,
        &format!("/api/memories/{id}/history"),
        &[],
        None,
    )
    .await?;
    let events = v
        .get("history")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    serde_json::from_value(events).map_err(|e| format!("解析记忆历史失败: {e}"))
}

/// 语义检索记忆（POST /api/memories/search）：topK 默认 10、clamp 1–20；
/// `scope` 缺省 = all（共享 + 当前用户个人；个人检索失败不阻断共享结果）。
#[tauri::command]
pub async fn memory_search(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    query: String,
    top_k: Option<u32>,
    scope: Option<String>,
) -> Result<Vec<MemoryHit>, String> {
    let mut body = serde_json::json!({ "query": query });
    if let Some(k) = top_k {
        body["topK"] = serde_json::json!(k);
    }
    if let Some(s) = scope {
        if !s.trim().is_empty() {
            body["scope"] = serde_json::json!(s.trim());
        }
    }
    let v = cloud_api_request(
        &cloud,
        &store,
        reqwest::Method::POST,
        "/api/memories/search",
        &[],
        Some(body),
    )
    .await?;
    let hits = v
        .get("results")
        .cloned()
        .unwrap_or_else(|| serde_json::json!([]));
    serde_json::from_value(hits).map_err(|e| format!("解析记忆检索结果失败: {e}"))
}

/// 个人卡片提升为共享（POST /api/memories/{id}/promote）：仅创建者本人可调；
/// 原文保留不被改写，原个人卡片消失、共享空间出现新 id 的共享卡片（服务端写审计）。
/// 返回新的共享卡片 id。
#[tauri::command]
pub async fn memory_promote(
    cloud: State<'_, Arc<CloudManager>>,
    store: State<'_, Arc<Store>>,
    id: String,
) -> Result<String, String> {
    let v = cloud_api_request(
        &cloud,
        &store,
        reqwest::Method::POST,
        &format!("/api/memories/{id}/promote"),
        &[],
        None,
    )
    .await?;
    let new_id = v
        .get("id")
        .and_then(|x| x.as_str())
        .ok_or_else(|| "提升响应缺少新卡片 id".to_string())?
        .to_string();
    Ok(new_id)
}

/// 上报对话历史触发自动沉淀（POST /api/memories/sediment，记忆卡片 API 文档 §10）。
/// 供 ai.rs 在每次对话回合结束后调用——pi 封装无法在 LLM 请求体携带 sessionId/projectName，
/// 由客户端把本回合历史显式上报，走与 LLM 请求完全相同的自动沉淀管线。
/// 服务器按 sessionId 聚合缓冲（8 条/2000 字/闲置 5 分钟），客户端只需每回合推送，不感知
/// flush 细节（默认 flush=true 立即入队）；仅 user/assistant 消息参与沉淀。
/// 失败返回中文错误（调用方记录诊断日志，不打断对话）。
pub async fn sediment_dialogue(
    cloud: &Arc<CloudManager>,
    store: &Arc<Store>,
    messages: Vec<serde_json::Value>,
    session_id: Option<&str>,
    project_name: Option<&str>,
) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }
    let body = sediment_body(&messages, session_id, project_name);
    let v = cloud_api_request(
        cloud,
        store,
        reqwest::Method::POST,
        "/api/memories/sediment",
        &[],
        Some(body),
    )
    .await?;
    let ok = v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false);
    if !ok {
        return Err("沉淀上报未被服务端接受（ok=false）".to_string());
    }
    Ok(())
}

/// 构造 /api/memories/sediment 请求体（纯函数）：messages 必填；空白 sessionId/projectName 省略。
fn sediment_body(
    messages: &[serde_json::Value],
    session_id: Option<&str>,
    project_name: Option<&str>,
) -> serde_json::Value {
    let mut body = serde_json::json!({ "messages": messages });
    if let Some(s) = session_id {
        if !s.trim().is_empty() {
            body["sessionId"] = serde_json::json!(s.trim());
        }
    }
    if let Some(p) = project_name {
        if !p.trim().is_empty() {
            body["projectName"] = serde_json::json!(p.trim());
        }
    }
    body
}

/// 极简 URL 编码（授权 URL 参数；redirect_uri 只含 `:/-_` 无需全量编码，保守处理特殊字符）。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(debug_assertions)]
    #[test]
    fn debug_build_uses_local_server_url() {
        // build.rs 只在存在的 dev.env 里取 AISHELL_SERVER_URL 注入（debug 构建优先本机文件）。
        // dev.env 不入库（含 OAuth 密钥），CI 干净检出时缺失 → server_url() 为空，此断言前提不成立，
        // 因此跟随同一 dev.env 校验（与 build.rs read_env_file 语义一致：去注释/空行/首尾空白），
        // 缺失时跳过，既守住「debug 构建不误用生产地址」的意图，又不让密钥文件不入库导致误报。
        let dev_env = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../dev.env");
        let expected = std::fs::read_to_string(dev_env)
            .ok()
            .and_then(|text| {
                text.lines().find_map(|l| {
                    let l = l.trim();
                    let (k, v) = l.split_once('=')?;
                    (k.trim() == "AISHELL_SERVER_URL" && !v.trim().is_empty())
                        .then(|| v.trim().trim_end_matches('/').to_string())
                })
            });
        if let Some(expected) = expected {
            assert_eq!(server_url().as_deref(), Some(expected.as_str()));
        }
        // dev.env 缺失（CI）时跳过断言
    }

    #[test]
    fn parse_query_handles_encoded_and_plain() {
        let m = parse_query(
            "code=abc123&state=xyz&redirect_uri=http%3A%2F%2F127.0.0.1%3A38901%2Fauth%2Fcallback",
        );
        assert_eq!(m.get("code").map(String::as_str), Some("abc123"));
        assert_eq!(m.get("state").map(String::as_str), Some("xyz"));
        assert_eq!(
            m.get("redirect_uri").map(String::as_str),
            Some(REDIRECT_URI)
        );
    }

    #[test]
    fn urlencode_keeps_safe_chars() {
        assert_eq!(
            urlencode(REDIRECT_URI),
            "http%3A%2F%2F127.0.0.1%3A38901%2Fauth%2Fcallback"
        );
    }

    #[test]
    fn random_hex_has_expected_len() {
        let a = random_hex(32).unwrap();
        let b = random_hex(32).unwrap();
        assert_eq!(a.len(), 32);
        assert_ne!(a, b, "两次生成的 state 不应相同");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    // ---------------------------------------------------------------- 开放 API 解析

    #[test]
    fn usage_report_parses_full_document_sample() {
        let json = r#"{
          "from": "2026-07-29", "to": "2026-08-11", "timezone": "UTC",
          "summary": { "requests": 128, "llmRequests": 100, "searchRequests": 28,
                       "promptTokens": 123456, "completionTokens": 54321, "totalTokens": 177777,
                       "averageLatencyMs": 214.5, "errorCount": 2 },
          "daily": [ { "date": "2026-08-11", "requests": 12, "llmRequests": 9, "searchRequests": 3,
                       "promptTokens": 0, "completionTokens": 0, "errorCount": 0 } ],
          "models": [ { "model": "gpt-4o", "requests": 80, "promptTokens": 0,
                        "completionTokens": 0, "totalTokens": 0 } ]
        }"#;
        let r: UsageReport = serde_json::from_str(json).unwrap();
        assert_eq!(r.from, "2026-07-29");
        assert_eq!(r.summary.requests, 128);
        assert_eq!(r.summary.llm_requests, 100);
        assert_eq!(r.summary.total_tokens, 177777);
        assert!((r.summary.average_latency_ms - 214.5).abs() < 1e-9);
        assert_eq!(r.summary.error_count, 2);
        assert_eq!(r.daily.len(), 1);
        assert_eq!(r.daily[0].date, "2026-08-11");
        assert_eq!(r.daily[0].search_requests, 3);
        assert_eq!(r.models.len(), 1);
        assert_eq!(r.models[0].model, "gpt-4o");
        assert_eq!(r.models[0].requests, 80);
    }

    #[test]
    fn usage_report_tolerates_missing_fields() {
        // 服务端旧版本/字段缺失：按默认值兜底，不整卡失败
        let r: UsageReport =
            serde_json::from_str(r#"{"from":"2026-08-01","to":"2026-08-11"}"#).unwrap();
        assert_eq!(r.timezone, "");
        assert_eq!(r.summary.requests, 0);
        assert!(r.daily.is_empty());
        assert!(r.models.is_empty());
    }

    #[test]
    fn memory_card_parses_document_sample() {
        let json = r#"{
          "id": "83d6beb5-2cdb-4c45-8c8a-123e8282813e",
          "content": "生产发布前必须冻结主干分支",
          "category": "编码规范",
          "tags": ["发布", "分支"],
          "creatorId": 7,
          "creatorName": "张三",
          "dept": "研发部",
          "source": "manual",
          "scope": "shared",
          "projectName": "aishell-cloud",
          "sessionId": "chat-2026-08-12-0001",
          "date": "2026-08-12",
          "createdAt": "2026-08-12 11:46",
          "updatedAt": "2026-08-12 11:46"
        }"#;
        let c: MemoryCard = serde_json::from_str(json).unwrap();
        assert_eq!(c.id, "83d6beb5-2cdb-4c45-8c8a-123e8282813e");
        assert_eq!(c.category, "编码规范");
        assert_eq!(c.tags, vec!["发布", "分支"]);
        assert_eq!(c.creator_id, Some(7));
        assert_eq!(c.creator_name, "张三");
        assert_eq!(c.source, "manual");
        assert_eq!(c.scope.as_deref(), Some("shared"));
        assert_eq!(c.project_name.as_deref(), Some("aishell-cloud"));
        assert_eq!(c.session_id.as_deref(), Some("chat-2026-08-12-0001"));
        assert_eq!(c.date.as_deref(), Some("2026-08-12"));
        assert_eq!(c.created_at, "2026-08-12 11:46");
    }

    #[test]
    fn memory_card_personal_scope_parses() {
        let c: MemoryCard =
            serde_json::from_str(r#"{"id":"p1","content":"个人工作笔记","scope":"personal"}"#)
                .unwrap();
        assert_eq!(c.scope.as_deref(), Some("personal"));
    }

    #[test]
    fn memory_card_tolerates_missing_optional_fields() {
        // 自动沉淀卡片 category 为空、creatorId 缺失 → 默认兜底
        let c: MemoryCard = serde_json::from_str(r#"{"id":"x","content":"事实"}"#).unwrap();
        assert_eq!(c.category, "");
        assert!(c.tags.is_empty());
        assert_eq!(c.creator_id, None);
        assert_eq!(c.source, "");
    }

    #[test]
    fn memory_hit_flattens_card_and_score() {
        let json = r#"{
          "id": "b583edb2", "content": "Redis 密码在配置中心", "category": "",
          "tags": [], "creatorId": 7, "creatorName": "张三", "dept": "研发部",
          "source": "auto", "createdAt": "2026-08-12 11:47", "updatedAt": "2026-08-12 11:47",
          "score": 0.334
        }"#;
        let h: MemoryHit = serde_json::from_str(json).unwrap();
        assert_eq!(h.card.id, "b583edb2");
        assert_eq!(h.card.content, "Redis 密码在配置中心");
        assert_eq!(h.card.source, "auto");
        assert!((h.score - 0.334).abs() < 1e-9);
    }

    #[test]
    fn memory_history_parses_events() {
        let json = r#"{"history": [
          { "event": "ADD", "value": "v1", "ts": "2026-08-12 11:46", "actor": "张三", "note": "" },
          { "event": "UPDATE", "value": "v2", "ts": "2026-08-12 12:03", "actor": "李四(管理员代编辑)", "note": "补充说明" }
        ]}"#;
        let events: Vec<MemoryEvent> = serde_json::from_value(
            serde_json::from_str::<serde_json::Value>(json)
                .unwrap()
                .get("history")
                .unwrap()
                .clone(),
        )
        .unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].event, "ADD");
        assert_eq!(events[1].event, "UPDATE");
        assert_eq!(events[1].note, "补充说明");
        assert_eq!(events[1].actor, "李四(管理员代编辑)");
    }

    #[test]
    fn api_error_text_extracts_service_chinese_error() {
        // 统一 {"error": "中文"} 格式
        assert_eq!(
            api_error_text(503, r#"{"error":"记忆服务未配置"}"#),
            "记忆服务未配置（HTTP 503）"
        );
        // 兼容 error_description / msg 兜底
        assert_eq!(
            api_error_text(429, r#"{"error_description":"个人配额已用完"}"#),
            "个人配额已用完（HTTP 429）"
        );
        assert_eq!(
            api_error_text(403, r#"{"msg":"只能编辑自己上传的记忆卡片"}"#),
            "只能编辑自己上传的记忆卡片（HTTP 403）"
        );
        // 非 JSON：原样截取
        assert_eq!(
            api_error_text(502, "Bad Gateway"),
            "Bad Gateway（HTTP 502）"
        );
        // 空体
        assert_eq!(api_error_text(204, ""), "无响应内容（HTTP 204）");
    }

    #[test]
    fn sediment_body_builds_document_shape() {
        let messages = vec![
            json!({"role": "user", "content": "Redis 密码去哪找"}),
            json!({"role": "assistant", "content": "配置中心 vault"}),
        ];
        let body = sediment_body(&messages, Some("chat-1"), Some("aishell-cloud"));
        assert_eq!(body["sessionId"], "chat-1");
        assert_eq!(body["projectName"], "aishell-cloud");
        assert_eq!(body["messages"].as_array().unwrap().len(), 2);
        assert_eq!(body["messages"][0]["role"], "user");
        // 空白 sessionId/projectName 不进入请求体（服务端按缺失处理）
        let body2 = sediment_body(&messages, Some("  "), None);
        assert!(body2.get("sessionId").is_none(), "空白 sessionId 不应发送");
        assert!(body2.get("projectName").is_none());
        // 空消息直接短路（不发起请求）
        let body3 = sediment_body(&[], None, None);
        assert_eq!(body3["messages"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn sediment_dialogue_empty_messages_noop() {
        // 空消息不触碰云会话/网络：构造最小实例验证短路语义
        let dir =
            std::env::temp_dir().join(format!("aishell-sediment-noop-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(crate::store::test_store(dir));
        let cloud = Arc::new(CloudManager::default());
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let res = rt.block_on(sediment_dialogue(&cloud, &store, vec![], None, None));
        assert!(res.is_ok(), "空消息应无操作成功返回");
    }
    #[test]
    fn skillhub_models_parse_and_escape_path_segments() {
        let list: SkillHubList = serde_json::from_value(json!({
            "items": [{
                "namespace": "global",
                "slug": "skillhub-hello",
                "displayName": "SkillHub Hello",
                "summary": "演示技能",
                "tags": {"category": "demo"},
                "downloads": 12,
                "stars": 3,
                "latestVersion": "1.0.0",
                "updatedAt": 1786516613789_i64
            }],
            "nextCursor": ""
        }))
        .unwrap();
        assert_eq!(list.items[0].id, 0);
        assert_eq!(
            list.items[0].tags.get("category").map(String::as_str),
            Some("demo")
        );
        assert_eq!(list.items[0].latest_version, "1.0.0");
        assert_eq!(skillhub_segment("team/skill"), "team%2Fskill");
        assert_eq!(skillhub_segment("  latest  "), "latest");
    }

    #[test]
    fn skillhub_version_detail_parses_body_and_metadata() {
        let detail: SkillHubVersionDetail = serde_json::from_value(json!({
            "version": {
                "version": "2.0.0",
                "status": "PUBLISHED",
                "fileCount": 2,
                "totalSize": 1024,
                "downloadAvailable": true,
                "metadata": {"frontmatter": {"name": "demo"}},
                "body": "# Demo"
            }
        }))
        .unwrap();
        assert_eq!(detail.version.id, 0);
        assert_eq!(detail.version.file_count, 2);
        assert_eq!(detail.version.metadata["frontmatter"]["name"], "demo");
        assert_eq!(detail.version.body, "# Demo");
    }
}
