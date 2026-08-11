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
        self.inner.lock().map_err(|_| "云会话状态锁损坏".to_string())
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
    Ok(buf
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>())
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
        (Some(u), Some(i), Some(s)) if !u.is_empty() && !i.is_empty() && !s.is_empty() => {
            Ok((server_url().unwrap_or_default(), i.to_string(), s.to_string()))
        }
        _ => Err("当前构建未配置云服务（缺少服务器地址或应用凭据）".to_string()),
    }
}

/// 解析回跳 query 字符串中的参数（只处理 URL 编码过的键值；未编码键值原样返回）。
fn parse_query(query: &str) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    for pair in query.split('&') {
        let Some((k, v)) = pair.split_once('=') else { continue };
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
async fn write_callback_response(
    stream: &mut tokio::net::TcpStream,
    ok: bool,
    message: &str,
) {
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
    let path_query = request_line
        .split_whitespace()
        .nth(1)
        .unwrap_or_default();
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
                        store.cloud_profile().1.map(|c| c.knowledge).unwrap_or(false),
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
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh),
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
    let expires_in = body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(7200);
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
    let expires_in = body.get("expires_in").and_then(|v| v.as_u64()).unwrap_or(7200);
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
    let data = body.get("data").unwrap_or(&body);
    let user_obj = data.get("user").or_else(|| body.get("user")).unwrap_or(data);
    let str_field = |v: &serde_json::Value, keys: &[&str]| -> Option<String> {
        keys.iter()
            .find_map(|k| v.get(*k).and_then(|x| x.as_str()))
            .map(String::from)
    };
    let user = CloudUser {
        name: str_field(
            user_obj,
            &["name", "username", "nickname", "display_name", "displayName"],
        )
        .unwrap_or_else(|| "未知用户".to_string()),
        avatar: str_field(
            user_obj,
            &["avatar", "avatarURL", "avatar_url", "avatarUrl", "photo", "portrait"],
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
        caps.knowledge = c.get("knowledge").and_then(|v| v.as_bool()).unwrap_or(false);
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
pub async fn cloud_logout(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
) -> Result<(), String> {
    let (server, _, _) = credentials().unwrap_or_default();
    let access = store.cloud_tokens().0;
    if !server.is_empty() {
        if let Some(token) = access {
            let url = format!("{server}/api/auth/logout");
            let client = reqwest::Client::new();
            // 吊销失败不阻塞本地登出
            let _ = client
                .post(&url)
                .bearer_auth(token)
                .send()
                .await;
        }
    }
    store.cloud_clear()?;
    emit_changed(&app, &store);
    Ok(())
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

    #[test]
    fn parse_query_handles_encoded_and_plain() {
        let m = parse_query("code=abc123&state=xyz&redirect_uri=http%3A%2F%2F127.0.0.1%3A38901%2Fauth%2Fcallback");
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
}
