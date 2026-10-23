//! 堡垒机 Web 单点登录（SSO）客户端接管。
//!
//! 背景：不少堡垒机只提供 Web 管理页，页面通过厂商的 SSO 客户端启动本地 SSH 工具。
//! 已验证两种客户端形态：
//!
//! 1. `C:\sso_client\xshell_agent.exe` 读取 `db_path.ini` 的 `xshell=` 路径，然后以
//!    `-url ssh://<uid>:<一次性密码>@<fort_ip>:<fort_port>` 调用配置的客户端。
//! 2. 齐治 AccessClient 注册 `accessclient://` 协议（`LoaderShell.exe "%1"`），载荷是
//!    base64(zlib(JSON))（含 Host/Port/User/PWD/SessionTitle），LoaderShell 再按 App Paths
//!    找到 Xshell 并以 `-url ssh://<User>:<PWD>@<Host>:<Port> -newtab <标题>` 拉起。
//!
//! AIShell 的接管点：
//! - 形态 1：把 `db_path.ini` 的 `xshell=` 指向 AIShell（手工/安装时配置）；
//! - 形态 2：在 `HKCU\Software\Classes\accessclient` 写用户级协议覆盖（无需管理员，
//!   见 `sso_set_access_client_takeover`），浏览器点击后直接拉起 AIShell。
//!
//! 接管后本模块负责把 URL 变成 AIShell 的 SSH 终端：
//!
//! - 首次启动：`run()` 从命令行提取 URL，`setup` 里登记临时服务器并挂起，
//!   前端挂载后经 `sso_take_pending` 取走；
//! - 已有实例：`tauri-plugin-single-instance` 把新进程的 argv 转发过来，
//!   解析后 emit `sso:open`，前端直接开标签。
//!
//! 安全边界（与 keyring 模型一致）：
//! - 一次性密码只进 `SshManager` 的内存临时服务器，不写 `aishell.json`、keyring、
//!   时间线、trace 或日志；
//! - 前端事件与 `sso_take_pending` 的 payload 都不含密码；
//! - URL 原文不落盘，解析失败的错误也不回显原文（避免把密码带进 UI/日志）。

use std::io::Read;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use flate2::read::{DeflateDecoder, ZlibDecoder};
use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use url::{Host, Url};
use zeroize::Zeroizing;

use crate::ssh::{SshManager, SsoKind};
use crate::store::{AuthType, Server};

/// 一次性 SSO 会话的前端展示信息（密码绝不下发）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoOpen {
    pub server_id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    /// `ssh`（开终端）或 `sftp`（开文件管理器）
    pub protocol: String,
    /// 标签标题：厂商给的会话名，缺省 `user@host[:port]`
    pub title: String,
}

/// 首次启动时前端取走的挂起结果。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SsoPending {
    pub open: Option<SsoOpen>,
    pub error: Option<String>,
}

static PENDING: Mutex<SsoPending> = Mutex::new(SsoPending { open: None, error: None });
static LAUNCH_URL: Mutex<Option<String>> = Mutex::new(None);

/// 从命令行参数提取 SSO URL：支持 `-url <url>`、`/url <url>`、`--sso-url <url>`、
/// `-url=<url>` 以及裸 `ssh://` / `ssh2://` / `accessclient://` 参数。找不到返回 None。
///
/// 两种厂商客户端的实际调用形如：
/// - `AIShell.exe -url ssh://user:sid@host:2022`
/// - `AIShell.exe "accessclient://eJx..."`（Windows 协议处理器只传 URL）
pub fn url_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    let mut it = args.into_iter();
    let _exe = it.next();
    for arg in it.by_ref() {
        if matches!(arg.as_str(), "-url" | "/url" | "--url" | "--sso-url") {
            return it.next().filter(|s| !s.trim().is_empty());
        }
        for prefix in ["-url=", "/url=", "--url=", "--sso-url="] {
            if let Some(rest) = arg.strip_prefix(prefix) {
                if !rest.trim().is_empty() {
                    return Some(rest.to_string());
                }
            }
        }
        if arg.starts_with("ssh://") || arg.starts_with("ssh2://") || is_access_client_url(&arg) {
            return Some(arg);
        }
    }
    None
}

fn is_access_client_url(raw: &str) -> bool {
    raw.get(..15)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("accessclient://"))
}

/// 解析 `ssh://user:password@host:port`。密码用 `Zeroizing` 包住，减少驻留时间。
struct SsoSpec {
    host: String,
    port: u16,
    username: String,
    password: Zeroizing<String>,
    /// `ssh` 或 `sftp`
    protocol: String,
    /// 厂商给的会话标题（AccessClient 的 SessionTitle / st），空则用 `user@host[:port]`
    session_title: String,
}

/// 手写 Debug：密码永远显示 `<redacted>`，避免测试失败/日志把一次性密码打出来。
impl std::fmt::Debug for SsoSpec {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SsoSpec")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("protocol", &self.protocol)
            .field("session_title", &self.session_title)
            .field("password", &"<redacted>")
            .finish()
    }
}

fn parse_sso_url(raw: &str) -> Result<SsoSpec, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("SSO 链接为空".to_string());
    }
    // 错误不回显原 URL：其中含一次性密码
    let url = Url::parse(raw).map_err(|_| "SSO 链接格式不正确".to_string())?;
    if !matches!(url.scheme(), "ssh" | "ssh2") {
        return Err(format!(
            "不支持的 SSO 协议「{}」：仅支持 ssh:// 链接",
            url.scheme()
        ));
    }
    let host = match url.host() {
        Some(Host::Domain(d)) => d.to_string(),
        Some(Host::Ipv4(ip)) => ip.to_string(),
        Some(Host::Ipv6(ip)) => ip.to_string(),
        None => return Err("SSO 链接缺少主机地址".to_string()),
    };
    if host.is_empty() {
        return Err("SSO 链接缺少主机地址".to_string());
    }
    let username = percent_decode_str(url.username())
        .decode_utf8_lossy()
        .into_owned();
    if username.is_empty() {
        return Err("SSO 链接缺少用户名".to_string());
    }
    let password = url
        .password()
        .map(|p| percent_decode_str(p).decode_utf8_lossy().into_owned())
        .unwrap_or_default();
    if password.is_empty() {
        return Err("SSO 链接缺少一次性密码".to_string());
    }
    let port = url.port().unwrap_or(22);
    if port == 0 {
        return Err("SSO 链接端口不合法".to_string());
    }
    Ok(SsoSpec {
        host,
        port,
        username,
        password: Zeroizing::new(password),
        protocol: "ssh".to_string(),
        session_title: String::new(),
    })
}

/// 齐治 AccessClient 载荷（`accessclient://` 解码后的 JSON）。
/// 字段名沿用厂商大写键；只取建立 SSH 会话需要的几项。
#[derive(Deserialize)]
struct AccessClientPayload {
    #[serde(default, rename = "Host")]
    host: String,
    #[serde(default, rename = "Port")]
    port: PortField,
    #[serde(default, rename = "User")]
    username: String,
    #[serde(default, rename = "PWD")]
    password: String,
    #[serde(default, rename = "Proto")]
    proto: String,
    #[serde(default, rename = "SessionTitle")]
    session_title: String,
    /// SFTP 载荷没有 SessionTitle/Proto，标题在 `st` 里，客户端由 app 区分（xftp）
    #[serde(default, rename = "app")]
    app: String,
    #[serde(default, rename = "st")]
    st_title: String,
}

/// 厂商把端口写成字符串（"22"），部分版本可能是数字。
#[derive(Deserialize, Default)]
#[serde(untagged)]
enum PortField {
    #[default]
    Missing,
    Text(String),
    Number(u16),
}

impl PortField {
    fn value(&self) -> Result<u16, String> {
        match self {
            PortField::Missing => Ok(22),
            PortField::Number(n) => Ok(*n),
            PortField::Text(s) if s.trim().is_empty() => Ok(22),
            PortField::Text(s) => s
                .trim()
                .parse::<u16>()
                .map_err(|_| "SSO 载荷里的端口不合法".to_string()),
        }
    }
}

/// 解码 `accessclient://<base64(zlib(json))>`。
///
/// Windows 对自定义协议会把整段 URL 原样传给处理器，但个别浏览器/系统版本会在空路径
/// 后面补一个 `/`，因此先按原文解码、失败再去掉尾部斜杠重试。
fn parse_access_client(raw: &str) -> Result<SsoSpec, String> {
    let raw = raw.trim();
    let rest = raw
        .get(15..)
        .ok_or_else(|| "AccessClient 链接格式不正确".to_string())?;
    // 浏览器可能把 base64 里的 + / = 百分号编码
    let token = percent_decode_str(rest).decode_utf8_lossy().into_owned();
    let candidates = [token.as_str(), token.trim_end_matches('/')];
    let mut bytes = None;
    for candidate in candidates {
        if candidate.trim().is_empty() {
            continue;
        }
        for engine in [
            &base64::engine::general_purpose::STANDARD,
            &base64::engine::general_purpose::URL_SAFE,
            &base64::engine::general_purpose::STANDARD_NO_PAD,
            &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        ] {
            if let Ok(decoded) = engine.decode(candidate.trim()) {
                bytes = Some(decoded);
                break;
            }
        }
        if bytes.is_some() {
            break;
        }
    }
    let bytes = bytes.ok_or_else(|| "AccessClient 载荷不是有效的 base64".to_string())?;

    // 正常是 zlib；兼容未压缩的 JSON 与裸 deflate
    let json = match inflate(&bytes) {
        Some(out) => String::from_utf8(out).map_err(|_| "AccessClient 载荷解码失败".to_string())?,
        None => String::from_utf8(bytes).map_err(|_| "AccessClient 载荷解码失败".to_string())?,
    };
    let payload: AccessClientPayload =
        serde_json::from_str(&json).map_err(|_| "AccessClient 载荷内容不完整".to_string())?;

    let protocol = access_client_protocol(&payload)?;
    let host = payload.host.trim().to_string();
    if host.is_empty() {
        return Err("AccessClient 载荷缺少主机地址".to_string());
    }
    let username = payload.username.trim().to_string();
    if username.is_empty() {
        return Err("AccessClient 载荷缺少用户名".to_string());
    }
    let port = payload.port.value()?;
    if port == 0 {
        return Err("AccessClient 载荷里的端口不合法".to_string());
    }
    if payload.password.is_empty() {
        return Err("AccessClient 载荷缺少一次性密码".to_string());
    }
    // SFTP 载荷用 `st`，SSH 载荷用 `SessionTitle`
    let session_title = if !payload.session_title.trim().is_empty() {
        payload.session_title.trim().to_string()
    } else {
        payload.st_title.trim().to_string()
    };
    Ok(SsoSpec {
        host,
        port,
        username,
        password: Zeroizing::new(payload.password),
        protocol,
        session_title,
    })
}

/// 会话类型：优先显式 `Proto`；SFTP 载荷没有 Proto，按客户端 `app` 推断
/// （xftp/winscp/filezilla 是文件传输客户端，其余按 SSH）。
fn access_client_protocol(payload: &AccessClientPayload) -> Result<String, String> {
    let proto = payload.proto.trim().to_ascii_lowercase();
    if !proto.is_empty() {
        return match proto.as_str() {
            "ssh" | "sftp" => Ok(proto),
            other => Err(format!(
                "暂不支持该会话类型「{other}」：当前仅接管 SSH 与 SFTP"
            )),
        };
    }
    Ok(match payload.app.trim().to_ascii_lowercase().as_str() {
        "xftp" | "winscp" | "filezilla" => "sftp",
        _ => "ssh",
    }
    .to_string())
}

fn inflate(bytes: &[u8]) -> Option<Vec<u8>> {
    for decoder in [0, 1] {
        let mut out = Vec::new();
        let ok = if decoder == 0 {
            ZlibDecoder::new(bytes).read_to_end(&mut out).is_ok()
        } else {
            DeflateDecoder::new(bytes).read_to_end(&mut out).is_ok()
        };
        if ok && !out.is_empty() {
            return Some(out);
        }
    }
    None
}

/// 记录首次启动命令行里的 URL（`run()` 在 Builder 之前调用）。
pub fn remember_launch_url(url: Option<String>) {
    if let Ok(mut slot) = LAUNCH_URL.lock() {
        *slot = url;
    }
}

/// 首次启动在 setup 末尾调用：解析并登记临时服务器，等待前端 `sso_take_pending` 取走。
/// 首启不 emit 事件——此时前端还没挂载，事件会丢。
pub fn init_launch(ssh: &Arc<SshManager>) {
    let raw = LAUNCH_URL.lock().ok().and_then(|mut slot| slot.take());
    let Some(raw) = raw else { return };
    let result = prepare(ssh, &raw);
    if let Ok(mut pending) = PENDING.lock() {
        match result {
            Ok(open) => {
                pending.open = Some(open);
                pending.error = None;
            }
            Err(e) => {
                pending.open = None;
                pending.error = Some(e);
            }
        }
    }
}

/// 已有实例收到新的 SSO URL（single-instance 回调）：登记后通知前端。
pub fn handle_incoming(app: &AppHandle, raw: &str) {
    let Some(ssh) = app.try_state::<Arc<SshManager>>() else {
        // 极端竞态：setup 还没 manage(ssh)。记下 URL，由 init_launch 兜底消费；
        // 若 setup 已过则只能丢弃（正常不会发生，second instance 必然在首实例启动后）。
        remember_launch_url(Some(raw.to_string()));
        return;
    };
    // 只发给主窗口：AI 分离窗口也挂载同一前端（App.tsx），广播会在分离窗口的
    // 独立 zustand 实例里误开工作台标签/改写路由。
    let main = app.get_webview_window("main");
    // 托盘/最小化状态下收到 SSO 会话：把主窗口带回前台，用户点完堡垒机登录应直接看到终端。
    if let Some(win) = &main {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
    match prepare(ssh.inner(), raw) {
        Ok(open) => {
            if let Some(win) = main {
                let _ = win.emit("sso:open", open);
            } else {
                let _ = app.emit("sso:open", open);
            }
        }
        Err(e) => {
            if let Some(win) = main {
                let _ = win.emit("sso:error", e);
            } else {
                let _ = app.emit("sso:error", e);
            }
        }
    }
}

/// 解析 URL → 创建内存临时服务器 → 返回前端展示信息。
/// 密码只交给 `SshManager::add_ephemeral`，不进入返回值。
fn prepare(ssh: &Arc<SshManager>, raw: &str) -> Result<SsoOpen, String> {
    let spec = if is_access_client_url(raw) {
        parse_access_client(raw)?
    } else {
        parse_sso_url(raw)?
    };
    // 每次点击都是一次独立会话：该网关一个 TCP 连接只绑定一个会话，
    // 复用连接开第二个 channel 会被拒（ConnectFailed），并发连接又被踢（Disconnected）。
    let id = format!("sso-{}", uuid::Uuid::new_v4());
    let title = if !spec.session_title.is_empty() {
        spec.session_title.clone()
    } else if spec.port == 22 {
        format!("{}@{}", spec.username, spec.host)
    } else {
        format!("{}@{}:{}", spec.username, spec.host, spec.port)
    };
    let server = Server {
        id: id.clone(),
        name: title.clone(),
        host: spec.host.clone(),
        port: spec.port,
        auth_type: AuthType::Password,
        username: spec.username.clone(),
        key_path: String::new(),
        credential_id: None,
        locked: false,
        is_bastion: false,
        bastion_id: None,
        tags: Vec::new(),
    };
    ssh.add_ephemeral(server, spec.password, SsoKind::parse(&spec.protocol))?;
    Ok(SsoOpen {
        server_id: id,
        host: spec.host,
        port: spec.port,
        username: spec.username,
        protocol: spec.protocol,
        title,
    })
}

/// 前端挂载后取走首次启动的 SSO 结果（取走即清空）。
#[tauri::command]
pub fn sso_take_pending() -> SsoPending {
    PENDING
        .lock()
        .map(|mut pending| SsoPending {
            open: pending.open.take(),
            error: pending.error.take(),
        })
        .unwrap_or_default()
}

/// 当前是否已由 AIShell 接管 `accessclient://`（用户级协议覆盖存在且指向当前程序）。
#[tauri::command]
pub fn sso_access_client_takeover() -> Result<bool, String> {
    takeover::status()
}

/// 开启/关闭 `accessclient://` 的用户级协议接管。
///
/// 只写 `HKCU\Software\Classes\accessclient`：这是每用户覆盖，优先于厂商写在
/// HKLM 的处理器，无需管理员权限；关闭时删除该键，浏览器随即回落到厂商客户端。
#[tauri::command]
pub fn sso_set_access_client_takeover(enabled: bool) -> Result<bool, String> {
    takeover::set(enabled)?;
    takeover::status()
}

#[cfg(windows)]
mod takeover {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const KEY: &str = r"Software\Classes\accessclient";

    /// 注册表里应写入的命令行：`"<AIShell.exe>" "%1"`。
    /// 用 `current_exe` 而非安装目录推断，dev 构建与安装版都能定位。
    fn command_line() -> Result<String, String> {
        let exe = std::env::current_exe()
            .map_err(|e| format!("无法定位 AIShell 可执行文件：{e}"))?;
        Ok(format!("\"{}\" \"%1\"", exe.display()))
    }

    pub fn status() -> Result<bool, String> {
        let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(KEY) else {
            return Ok(false);
        };
        let Ok(cmd_key) = key.open_subkey(r"shell\open\command") else {
            return Ok(false);
        };
        let cmd: String = cmd_key
            .get_value("")
            .map_err(|e| format!("读取协议接管状态失败：{e}"))?;
        let exe = std::env::current_exe()
            .map_err(|e| format!("无法定位 AIShell 可执行文件：{e}"))?;
        Ok(cmd.to_lowercase().contains(&exe.display().to_string().to_lowercase()))
    }

    pub fn set(enabled: bool) -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if enabled {
            let (key, _) = hkcu
                .create_subkey(KEY)
                .map_err(|e| format!("写入协议接管失败：{e}"))?;
            key.set_value("", &String::from("URL:AccessClient Protocol"))
                .map_err(|e| format!("写入协议接管失败：{e}"))?;
            key.set_value("URL Protocol", &String::new())
                .map_err(|e| format!("写入协议接管失败：{e}"))?;
            let (cmd_key, _) = key
                .create_subkey(r"shell\open\command")
                .map_err(|e| format!("写入协议接管失败：{e}"))?;
            let cmd = command_line()?;
            cmd_key
                .set_value("", &cmd)
                .map_err(|e| format!("写入协议接管失败：{e}"))?;
        } else if hkcu.open_subkey(KEY).is_ok() {
            hkcu.delete_subkey_all(KEY)
                .map_err(|e| format!("取消协议接管失败：{e}"))?;
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod takeover {
    pub fn status() -> Result<bool, String> {
        Ok(false)
    }

    pub fn set(_enabled: bool) -> Result<(), String> {
        Err("堡垒机协议接管仅支持 Windows".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::test_store;

    #[test]
    fn parses_ssh_url_with_one_time_password() {
        let spec = parse_sso_url("ssh://user:sid-123@bastion.example:2022").unwrap();
        assert_eq!(spec.host, "bastion.example");
        assert_eq!(spec.port, 2022);
        assert_eq!(spec.username, "user");
        assert_eq!(spec.password.as_str(), "sid-123");
    }

    #[test]
    fn decodes_percent_encoded_username_and_password() {
        let spec = parse_sso_url("ssh://u%40corp:p%40ss@host.example:22").unwrap();
        assert_eq!(spec.username, "u@corp");
        assert_eq!(spec.password.as_str(), "p@ss");
    }

    #[test]
    fn defaults_to_port_22() {
        let spec = parse_sso_url("ssh://user:pass@host.example").unwrap();
        assert_eq!(spec.port, 22);
    }

    #[test]
    fn rejects_missing_password_and_other_schemes() {
        let err = parse_sso_url("ssh://user@host.example:22").unwrap_err();
        assert!(err.contains("一次性密码"), "{err}");
        let err = parse_sso_url("http://user:pass@host.example").unwrap_err();
        assert!(err.contains("ssh://"), "{err}");
        assert!(parse_sso_url("").unwrap_err().contains("为空"));
    }

    #[test]
    fn extracts_url_from_agent_arguments() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            url_from_args(args(&["AIShell.exe", "-url", "ssh://u:p@h:2022"])).as_deref(),
            Some("ssh://u:p@h:2022")
        );
        assert_eq!(
            url_from_args(args(&["AIShell.exe", "/url", "ssh://u:p@h"])).as_deref(),
            Some("ssh://u:p@h")
        );
        assert_eq!(
            url_from_args(args(&["AIShell.exe", "-url=ssh://u:p@h"])).as_deref(),
            Some("ssh://u:p@h")
        );
        assert_eq!(
            url_from_args(args(&["AIShell.exe", "ssh://u:p@h"])).as_deref(),
            Some("ssh://u:p@h")
        );
        assert!(url_from_args(args(&["AIShell.exe"])).is_none());
    }

    /// 造一条与齐治 AccessClient 同格式的载荷（base64(zlib(JSON))）。
    fn access_payload(json: &str) -> String {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;
        let mut enc = ZlibEncoder::new(Vec::new(), Compression::default());
        enc.write_all(json.as_bytes()).unwrap();
        let bytes = enc.finish().unwrap();
        format!(
            "accessclient://{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )
    }

    #[test]
    fn parses_access_client_payload() {
        let raw = access_payload(
            r#"{"app":"xshell","User":"demo","SessionTitle":"root@demo-host","Port":"22","Host":"10.0.0.9","SessionAccount":"root","Proto":"ssh","PWD":"OTP:abc123"}"#,
        );
        let spec = parse_access_client(&raw).unwrap();
        assert_eq!(spec.host, "10.0.0.9");
        assert_eq!(spec.port, 22);
        assert_eq!(spec.username, "demo");
        assert_eq!(spec.password.as_str(), "OTP:abc123");
        assert_eq!(spec.protocol, "ssh");
        assert_eq!(spec.session_title, "root@demo-host");
    }

    #[test]
    fn parses_access_client_sftp_payload_by_app() {
        // 真实 SFTP 载荷没有 Proto/SessionTitle：标题在 st，客户端是 xftp
        let raw = access_payload(
            r#"{"Path":"","app":"xftp","st":"root@demo-host","ver":"4.6.10","User":"demo","Port":"22","Host":"10.0.0.9","shterm_ver":"2","PWD":"OTP:abc123","url":"https://10.0.0.9:443/shterm/resources/conf/AccessClient.exe"}"#,
        );
        let spec = parse_access_client(&raw).unwrap();
        assert_eq!(spec.protocol, "sftp");
        assert_eq!(spec.host, "10.0.0.9");
        assert_eq!(spec.username, "demo");
        assert_eq!(spec.session_title, "root@demo-host");
    }

    #[test]
    fn access_client_tolerates_trailing_slash_and_numeric_port() {
        let base = access_payload(
            r#"{"Host":"10.0.0.8","Port":2222,"User":"u","PWD":"p","Proto":"ssh"}"#,
        );
        let spec = parse_access_client(&base).unwrap();
        assert_eq!(spec.port, 2222);
        assert_eq!(spec.username, "u");
        // Windows 对自定义协议可能补尾部斜杠
        let spec = parse_access_client(&format!("{base}/")).unwrap();
        assert_eq!(spec.host, "10.0.0.8");
    }

    #[test]
    fn rejects_non_ssh_access_client_payload() {
        let raw = access_payload(
            r#"{"Host":"h","Port":"3389","User":"u","PWD":"p","Proto":"rdp"}"#,
        );
        let err = parse_access_client(&raw).unwrap_err();
        assert!(err.contains("仅接管 SSH 与 SFTP"), "{err}");
    }

    #[test]
    fn extracts_access_client_url_from_arguments() {
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert_eq!(
            url_from_args(args(&["AIShell.exe", "accessclient://eJxkAAA"])).as_deref(),
            Some("accessclient://eJxkAAA")
        );
        assert_eq!(
            url_from_args(args(&["AIShell.exe", "-url", "accessclient://eJxkAAA"])).as_deref(),
            Some("accessclient://eJxkAAA")
        );
    }

    #[test]
    fn prepare_opens_access_client_session_with_title() {
        let dir = std::env::temp_dir().join(format!(
            "aishell-sso-ac-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let ssh = Arc::new(SshManager::new(Arc::new(test_store(dir.clone()))));
        let raw = access_payload(
            r#"{"Host":"10.0.0.9","Port":"22","User":"demo","PWD":"OTP:tok","Proto":"ssh","SessionTitle":"root@demo"}"#,
        );
        let open = prepare(&ssh, &raw).unwrap();
        assert_eq!(open.username, "demo");
        assert_eq!(open.protocol, "ssh");
        assert_eq!(open.title, "root@demo");
        assert_eq!(ssh.ephemeral_password(&open.server_id).as_deref(), Some("OTP:tok"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn prepare_registers_ephemeral_server() {
        let dir = std::env::temp_dir().join(format!(
            "aishell-sso-store-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let ssh = Arc::new(SshManager::new(Arc::new(test_store(dir.clone()))));
        let open = prepare(&ssh, "ssh://user:sid123@iam.example.edu:2022").unwrap();
        assert_eq!(open.host, "iam.example.edu");
        assert_eq!(open.port, 2022);
        assert_eq!(open.username, "user");
        assert_eq!(open.title, "user@iam.example.edu:2022");
        // 临时服务器不在持久化 Store 中，但 SshManager 能按 id 找到显示名/密码
        assert_eq!(
            ssh.server_label(&open.server_id).as_deref(),
            Some("user@iam.example.edu:2022")
        );
        assert_eq!(
            ssh.ephemeral_password(&open.server_id).as_deref(),
            Some("sid123")
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
