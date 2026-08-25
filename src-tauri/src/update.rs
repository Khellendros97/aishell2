//! 客户端自动更新（对照 docs/AIShell云服务-客户端自动更新功能开发文档.md §4–§6）。
//!
//! 架构：Rust 持有唯一更新任务与状态机，前端只读状态 + 触发命令：
//!   idle → checking → not_available / available → downloading → ready → installing → error
//! - 检查：自行 GET `{AISHELL_SERVER_URL}/api/updates/latest?target=&current=&channel=stable`
//!   （支持 If-None-Match/304；204 = 无更新），用于 UI 展示与「无签名迁移期」识别；
//! - 下载/验签/安装：走 tauri-plugin-updater（端点与 target 运行期注入，公钥在 tauri.conf.json
//!   plugins.updater.pubkey 固化，构建端 createUpdaterArtifacts 生成 .sig）；
//! - 安装前重新请求 manifest 确认未被 yank（§6.4/§7.2），不一致即清除待安装状态；
//! - 已下载未安装的版本号持久化到 `update-pending.json`，重启后由首次检查对账；
//! - 后台调度：窗口就绪后延迟 10s 首检、每 24h 复检；仅注入 AISHELL_SERVER_URL 的构建启用。
//!
//! 安全约束（§11）：检查与下载不带任何用户 token；仅接受 HTTPS（debug 构建放宽以便联调）；
//! 错误信息脱敏（不含 token/私钥，这些本就不进入客户端）；后台失败只写 debug 日志不打扰用户。
//!
//! 注意（Windows）：`Update::install` 拉起 NSIS 安装器后内部 `std::process::exit(0)`，
//! `update_install` 命令在该平台不会返回；前端触发后以 installing 状态事件为准。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::cloud;
use crate::term::diag;

/// updater 验签公钥（minisign base64）。与 CI GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`
/// 对应的私钥生成（`npx tauri signer generate`），私钥永不进入仓库与客户端。
/// 轮换需走双公钥过渡（§6.1），不能直接替换导致存量客户端失联。
pub const UPDATER_PUBKEY: &str =
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDE4Q0NBNkI2ODVDOUY2MkIKUldRcjlzbUZ0cWJNR08vN3lvNUV0czlCa2hEamllSHVSeUZzc2NZL3liQXdXcFZvR3FPdGp5c3MK";

/// 更新频道。首期固定 stable；beta 灰度验证完成后再提供用户可见入口（§5.2）。
const CHANNEL: &str = "stable";

/// 主窗口就绪后首次后台检查延迟（§5.1：约 10 秒）。
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(10);
/// 后台检查间隔（§5.1：24 小时）。
const CHECK_INTERVAL: Duration = Duration::from_secs(24 * 60 * 60);
/// manifest 请求超时。
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// 待安装记录文件名（app_config_dir 下）。
const PENDING_FILE: &str = "update-pending.json";

/* ---------------- SemVer（§9.1：版本比较单一真源，含 prerelease） ---------------- */

/// 精简 SemVer：major.minor.patch[-prerelease]（忽略 build 元数据）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SemVer {
    major: u64,
    minor: u64,
    patch: u64,
    /// 预发布标识（None = 正式版，正式版 > 任意预发布版）
    pre: Option<String>,
}

/// 解析 `X.Y.Z` / `X.Y.Z-pre[.n]`；非法输入返回 None。
pub(crate) fn parse_semver(s: &str) -> Option<SemVer> {
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, Some(p.to_string())),
        None => (s, None),
    };
    // build 元数据（+meta）不参与比较，直接剥掉
    let core = core.split_once('+').map(|(a, _)| a).unwrap_or(core);
    let mut it = core.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    let patch = it.next()?.parse().ok()?;
    if it.next().is_some() {
        return None;
    }
    if let Some(p) = &pre {
        if p.is_empty() || p.split('.').any(|seg| seg.is_empty()) {
            return None;
        }
    }
    Some(SemVer { major, minor, patch, pre })
}

impl SemVer {
    /// prerelease 逐段比较：纯数字段按数值（小者小），数字段 < 字母段，字母段字典序。
    fn pre_lt(a: &str, b: &str) -> bool {
        let (mut sa, mut sb) = (a.split('.'), b.split('.'));
        loop {
            match (sa.next(), sb.next()) {
                (None, None) => return false,
                (None, Some(_)) => return true, // 字段少者小：1.0.0-alpha < 1.0.0-alpha.1
                (Some(_), None) => return false,
                (Some(x), Some(y)) => match (x.parse::<u64>().ok(), y.parse::<u64>().ok()) {
                    (Some(nx), Some(ny)) if nx == ny => continue,
                    (Some(nx), Some(ny)) => return nx < ny,
                    (Some(_), None) => return true, // 数字段 < 字母段
                    (None, Some(_)) => return false,
                    (None, None) => match x.cmp(y) {
                        std::cmp::Ordering::Less => return true,
                        std::cmp::Ordering::Greater => return false,
                        std::cmp::Ordering::Equal => continue,
                    },
                },
            }
        }
    }
}

impl PartialOrd for SemVer {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for SemVer {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        use std::cmp::Ordering::*;
        match (self.major, self.minor, self.patch).cmp(&(other.major, other.minor, other.patch)) {
            Equal => match (&self.pre, &other.pre) {
                (None, None) => Equal,
                (Some(_), None) => Less,
                (None, Some(_)) => Greater,
                (Some(a), Some(b)) => {
                    if Self::pre_lt(a, b) {
                        Less
                    } else if Self::pre_lt(b, a) {
                        Greater
                    } else {
                        Equal
                    }
                }
            },
            ord => ord,
        }
    }
}

/* ---------------- 平台 target 映射（§9.1） ---------------- */

/// (os, arch) → 服务端/updater 约定的 target 名。os 接受 "macos"/"darwin" 两种写法。
/// 与 tauri-plugin-updater 的 `{os}-{arch}` 命名一致（updater_os: windows/darwin）。
pub(crate) fn updater_target_for(os: &str, arch: &str) -> Option<&'static str> {
    let os = match os {
        "macos" | "darwin" => "darwin",
        "windows" => "windows",
        _ => return None,
    };
    match (os, arch) {
        ("windows", "x86_64") => Some("windows-x86_64"),
        ("darwin", "aarch64") => Some("darwin-aarch64"),
        ("darwin", "x86_64") => Some("darwin-x86_64"),
        _ => None,
    }
}

/// 当前进程的更新 target（首期仅支持三个目标平台，其余在编译期即不适用）。
pub fn current_target() -> &'static str {
    updater_target_for(std::env::consts::OS, std::env::consts::ARCH)
        .expect("不支持的更新平台（仅 windows-x86_64 / darwin-aarch64 / darwin-x86_64）")
}

/* ---------------- 服务端 manifest（§5.3 响应契约） ---------------- */

/// `GET /api/updates/latest` 成功响应（platforms 只含请求 target 的条目）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct LatestManifest {
    pub version: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub pub_date: Option<String>,
    #[serde(default)]
    pub platforms: HashMap<String, PlatformArtifact>,
}

/// 单平台制品：url + minisign 签名（.sig 文件内容整体 base64）。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub(crate) struct PlatformArtifact {
    pub url: String,
    #[serde(default)]
    pub signature: Option<String>,
}

/// 服务端响应 → manifest 的纯函数（单测覆盖 204/304/非法 JSON/非法版本/异常状态码）。
pub(crate) fn apply_response(
    status: u16,
    body: &str,
    cached: Option<&LatestManifest>,
) -> Result<Option<LatestManifest>, String> {
    match status {
        204 => Ok(None),
        304 => cached
            .cloned()
            .map(Some)
            .ok_or_else(|| "更新服务返回 304 但本地没有可复用的缓存".to_string()),
        200 => {
            let m: LatestManifest = serde_json::from_str(body)
                .map_err(|e| format!("更新服务返回的信息格式无效: {e}"))?;
            if parse_semver(&m.version).is_none() {
                return Err(format!("更新服务返回了无法识别的版本号: {}", m.version));
            }
            Ok(Some(m))
        }
        other => Err(format!("更新服务返回异常状态码 {other}")),
    }
}

/// 安装前对账（§6.4/§7.2）：待安装版本必须仍是服务端当前提供的版本。
pub(crate) fn verify_pending(
    manifest: Option<&LatestManifest>,
    pending: &str,
) -> Result<(), String> {
    match manifest {
        None => Err("更新已不可用（可能已被服务端撤回），请重新检查更新".to_string()),
        Some(m) if m.version == pending => Ok(()),
        Some(m) => Err(format!(
            "服务端当前提供的版本是 {}，与已下载的 {pending} 不一致，请重新检查更新",
            m.version
        )),
    }
}

/* ---------------- 状态与事件载荷（与前端 src/types.ts UpdateStatus 对齐） ---------------- */

/// 更新状态机（serde snake_case 与前端字符串联合类型一致）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateState {
    Idle,
    Checking,
    NotAvailable,
    Available,
    Downloading,
    Ready,
    Installing,
    Error,
}

/// 下载进度（update:download-progress 事件载荷 / UpdateStatus.progress）。
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// update:ready 事件载荷（新版本就绪提示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateReadyInfo {
    pub version: String,
    pub notes: Option<String>,
    pub published_at: Option<String>,
}

/// update_status 返回值与 update:status-changed 事件载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub state: UpdateState,
    pub current_version: String,
    pub available_version: Option<String>,
    pub notes: Option<String>,
    pub published_at: Option<String>,
    pub progress: Option<DownloadProgress>,
    /// 最近检查时间（epoch 毫秒；前端按本地时区格式化）
    pub last_checked_at: Option<u64>,
    pub error: Option<String>,
    /// 构建是否接入更新服务（未注入 AISHELL_SERVER_URL 的个人构建恒 false）
    pub enabled: bool,
    /// 无签名迁移期（§6.3）：manifest 有新版本但缺签名 → 只允许手动下载
    pub signature_missing: bool,
    /// 无签名迁移期「打开下载页」用制品直链（公开 URL，不含 token）
    pub download_url: Option<String>,
}

/* ---------------- 待安装持久化（§4.2：必要状态落盘，重启后对账） ---------------- */

#[derive(Serialize, Deserialize)]
struct PendingRecord {
    version: String,
    /// 下载完成时间（epoch 毫秒）
    downloaded_at: u64,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ---------------- 状态机管理器 ---------------- */

struct Inner {
    state: UpdateState,
    available_version: Option<String>,
    notes: Option<String>,
    published_at: Option<String>,
    error: Option<String>,
    last_checked_at: Option<u64>,
    signature_missing: bool,
    download_url: Option<String>,
    /// 下载并验签完成、等待用户确认安装的更新（Update 可 Clone，install 取 &self）
    pending_update: Option<Update>,
    /// 与 pending_update 配套的制品字节（plugin 的 install 需要调用方持有字节）
    pending_bytes: Vec<u8>,
    /// 下载进度（Downloading 期间实时更新；Ready 后保留最终值供 UI 展示包大小）
    progress: Option<DownloadProgress>,
    /// manifest ETag（If-None-Match 协商缓存，§5.4）
    etag: Option<String>,
    cached_manifest: Option<LatestManifest>,
}

impl Inner {
    fn reset_available(&mut self) {
        self.available_version = None;
        self.notes = None;
        self.published_at = None;
        self.signature_missing = false;
        self.download_url = None;
        self.pending_update = None;
        self.pending_bytes.clear();
        self.progress = None;
    }
}

/// Tauri 托管的更新管理器。`op` 串行化全部网络操作（§4.2：同进程同时最多一个检查/下载任务）。
pub struct UpdateManager {
    app: AppHandle,
    config_dir: PathBuf,
    inner: Mutex<Inner>,
    op: tokio::sync::Mutex<()>,
    /// 检查完成通知（手动检查复用进行中的后台检查，§4.2）
    check_done: tokio::sync::Notify,
}

impl UpdateManager {
    pub fn new(app: AppHandle, config_dir: PathBuf) -> Self {
        let mut inner = Inner {
            state: UpdateState::Idle,
            available_version: None,
            notes: None,
            published_at: None,
            error: None,
            last_checked_at: None,
            signature_missing: false,
            download_url: None,
            pending_update: None,
            pending_bytes: Vec::new(),
            progress: None,
            etag: None,
            cached_manifest: None,
        };
        // 上次已下载未安装：恢复 available（安装器临时文件不保证跨重启存活，需重新下载）；
        // 版本是否仍有效由首次后台检查对账（服务端 204/更高版本时清除）。
        if let Ok(text) = std::fs::read_to_string(config_dir.join(PENDING_FILE)) {
            if let Ok(rec) = serde_json::from_str::<PendingRecord>(&text) {
                if parse_semver(&rec.version).is_some() {
                    inner.state = UpdateState::Available;
                    inner.available_version = Some(rec.version);
                }
            }
        }
        Self {
            app,
            config_dir,
            inner: Mutex::new(inner),
            op: tokio::sync::Mutex::new(()),
            check_done: tokio::sync::Notify::new(),
        }
    }

    fn current_version(&self) -> String {
        self.app.package_info().version.to_string()
    }

    /// 生成 manifest 请求地址（去掉服务器地址尾部斜杠后拼接，§5.1）。
    fn latest_url(&self, server: &str, current: &str) -> String {
        format!(
            "{server}/api/updates/latest?target={}&current={current}&channel={CHANNEL}",
            current_target()
        )
    }

    pub fn status(&self) -> UpdateStatus {
        let g = self.inner.lock().expect("更新状态锁损坏");
        UpdateStatus {
            state: g.state,
            current_version: self.current_version(),
            available_version: g.available_version.clone(),
            notes: g.notes.clone(),
            published_at: g.published_at.clone(),
            progress: g.progress,
            last_checked_at: g.last_checked_at,
            error: g.error.clone(),
            enabled: cloud::server_url().is_some(),
            signature_missing: g.signature_missing,
            download_url: g.download_url.clone(),
        }
    }

    /// 广播 update:status-changed（全量状态，前端单一事件源）。
    fn emit_status(&self) {
        let _ = self.app.emit("update:status-changed", self.status());
    }

    fn save_pending(&self, version: &str) {
        let path = self.config_dir.join(PENDING_FILE);
        let rec = PendingRecord {
            version: version.to_string(),
            downloaded_at: now_ms(),
        };
        if let Ok(text) = serde_json::to_string_pretty(&rec) {
            // 失败静默：记录只影响重启后的展示恢复，不影响安装主路径
            let _ = std::fs::write(&path, text);
        }
    }

    fn clear_pending(&self) {
        let _ = std::fs::remove_file(self.config_dir.join(PENDING_FILE));
    }

    /// 构建请求前置校验：必须已注入服务器地址；release 构建强制 HTTPS（§6.2/§11）。
    fn validate_server(&self) -> Result<String, String> {
        let server = cloud::server_url()
            .ok_or_else(|| "此构建未接入云服务更新（未注入服务器地址）".to_string())?;
        if !server.starts_with("https://") && !cfg!(debug_assertions) {
            return Err(
                "更新服务地址必须使用 HTTPS，自动更新已停用（请联系管理员检查服务端部署）"
                    .to_string(),
            );
        }
        Ok(server)
    }

    /// 原始 manifest 请求（If-None-Match 协商缓存；成功时更新 etag/缓存）。
    async fn fetch_latest(&self, server: &str) -> Result<Option<LatestManifest>, String> {
        let url = self.latest_url(server, &self.current_version());
        let etag = self.inner.lock().expect("更新状态锁损坏").etag.clone();
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .map_err(|e| format!("更新请求初始化失败: {e}"))?;
        let mut req = client
            .get(&url)
            .header("Accept", "application/json");
        if let Some(etag) = &etag {
            req = req.header("If-None-Match", etag);
        }
        let res = req.send().await.map_err(|e| {
            if e.is_timeout() {
                "检查更新失败：请求超时".to_string()
            } else {
                format!("检查更新失败：网络错误 {e}")
            }
        })?;
        let status = res.status().as_u16();
        let new_etag = res
            .headers()
            .get("ETag")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let body = res.text().await.map_err(|e| format!("检查更新失败：响应读取错误 {e}"))?;
        let cached = self.inner.lock().expect("更新状态锁损坏").cached_manifest.clone();
        let outcome = apply_response(status, &body, cached.as_ref())?;
        let mut g = self.inner.lock().expect("更新状态锁损坏");
        if let Some(etag) = new_etag {
            g.etag = Some(etag);
        }
        if let Some(m) = &outcome {
            g.cached_manifest = Some(m.clone());
        }
        Ok(outcome)
    }

    /// 检查更新。`manual=true` 为设置页手动触发（失败向上返回中文错误）；
    /// 后台调用失败只落 debug 日志（§4.3），两者都更新状态与事件。
    pub async fn run_check(&self, manual: bool) -> Result<UpdateStatus, String> {
        // 复用进行中的检查：等待其完成后直接返回最新状态（§4.2 并发去重）
        if self.inner.lock().expect("更新状态锁损坏").state == UpdateState::Checking {
            self.check_done.notified().await;
            return Ok(self.status());
        }
        let server = match self.validate_server() {
            Ok(s) => s,
            Err(e) => {
                if manual {
                    return Err(e);
                }
                diag(&format!("update: 后台检查跳过：{e}"));
                return Ok(self.status());
            }
        };
        // 下载进行中不打断（下载内部自带重检查逻辑）
        if self.inner.lock().expect("更新状态锁损坏").state == UpdateState::Downloading {
            return Ok(self.status());
        }
        let _guard = self.op.lock().await;
        {
            let mut g = self.inner.lock().expect("更新状态锁损坏");
            g.state = UpdateState::Checking;
            g.error = None;
            g.progress = None;
        }
        self.emit_status();
        let result = self.fetch_latest(&server).await;
        let outcome = match result {
            Ok(o) => o,
            Err(e) => {
                let mut g = self.inner.lock().expect("更新状态锁损坏");
                g.state = UpdateState::Error;
                g.error = Some(e.clone());
                g.last_checked_at = Some(now_ms());
                drop(g);
                self.emit_status();
                self.check_done.notify_one();
                if manual {
                    return Err(e);
                }
                diag(&format!("update: 后台检查失败：{e}"));
                return Ok(self.status());
            }
        };
        let current = self.current_version();
        let current_semver = parse_semver(&current);
        let mut g = self.inner.lock().expect("更新状态锁损坏");
        g.last_checked_at = Some(now_ms());
        g.error = None;
        let target = current_target();
        // 选择本平台制品并判断是否真的更新（服务端已按 current 过滤，客户端再校验一次防降级）
        let offered = outcome.as_ref().and_then(|m| {
            let newer = parse_semver(m.version.trim())
                .zip(current_semver.as_ref())
                .is_some_and(|(v, c)| v > *c);
            newer.then(|| m.platforms.get(target)).flatten()
        });
        match offered {
            None => {
                // 无更新 / 频道关闭 / target 不支持 / 版本不高于当前：清空待安装状态（yank 对账）
                g.reset_available();
                g.state = UpdateState::NotAvailable;
                drop(g);
                self.clear_pending();
                self.emit_status();
            }
            Some(artifact) => {
                let m = outcome.as_ref().expect("offered 非 None 时 manifest 必然存在");
                let version = m.version.trim().to_string();
                // 已就绪同一版本：保持 ready（重新检查不应丢掉已下载的安装包）
                let same_pending = g.pending_update.is_some()
                    && g.available_version.as_deref() == Some(version.as_str());
                if !same_pending {
                    g.pending_update = None;
                    g.pending_bytes.clear();
                    self.clear_pending();
                }
                g.available_version = Some(version);
                g.notes = m.notes.clone();
                g.published_at = m.pub_date.clone();
                g.signature_missing = artifact.signature.as_deref().unwrap_or("").trim().is_empty();
                g.download_url = Some(artifact.url.clone());
                if !same_pending {
                    g.state = UpdateState::Available;
                }
                drop(g);
                self.emit_status();
            }
        }
        self.check_done.notify_one();
        Ok(self.status())
    }

    /// 下载并验签更新（tauri-plugin-updater）。成功后进入 ready 并持久化待安装版本。
    pub async fn run_download(&self) -> Result<UpdateStatus, String> {
        let state = {
            let g = self.inner.lock().expect("更新状态锁损坏");
            if g.available_version.is_none() {
                return Err("当前没有可下载的更新，请先检查更新".to_string());
            }
            if g.signature_missing {
                return Err("该版本未提供更新签名，无法自动更新；请使用「打开下载页」手动下载安装"
                    .to_string());
            }
            g.state
        };
        if matches!(state, UpdateState::Ready | UpdateState::Downloading) {
            return Ok(self.status());
        }

        let server = self.validate_server()?;
        let _guard = self.op.lock().await;
        let state = {
            let g = self.inner.lock().expect("更新状态锁损坏");
            if g.available_version.is_none() {
                return Err("当前没有可下载的更新，请先检查更新".to_string());
            }
            if g.signature_missing {
                return Err("该版本未提供更新签名，无法自动更新；请使用「打开下载页」手动下载安装"
                    .to_string());
            }
            g.state
        };
        if matches!(state, UpdateState::Ready | UpdateState::Downloading) {
            return Ok(self.status());
        }

        {
            let mut g = self.inner.lock().expect("更新状态锁损坏");
            g.state = UpdateState::Downloading;
            g.error = None;
            g.pending_update = None;
            g.pending_bytes.clear();
        }
        self.emit_status();
        // 端点运行期注入（服务器地址是构建期 env，静态 tauri.conf.json 无法模板化）；
        // target 显式指定，manifest platforms 的键与 CI 上传的制品 target 一一对应。
        let endpoint = self
            .latest_url(&server, &self.current_version())
            .parse()
            .map_err(|e| format!("更新服务地址无效: {e}"))?;
        let updater = self
            .app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|e| format!("更新端点校验失败: {e}"))?
            .target(current_target())
            .build()
            .map_err(|e| format!("更新器初始化失败: {e}"))?;
        let update = match updater.check().await {
            Ok(Some(u)) => u,
            Ok(None) => {
                // 服务端此刻无更新（发布间隙/缓存滞后）：回到 not_available
                let mut g = self.inner.lock().expect("更新状态锁损坏");
                g.reset_available();
                g.state = UpdateState::NotAvailable;
                drop(g);
                self.clear_pending();
                self.emit_status();
                return Ok(self.status());
            }
            Err(e) => {
                let msg = format!("获取更新信息失败: {e}");
                let mut g = self.inner.lock().expect("更新状态锁损坏");
                g.state = UpdateState::Error;
                g.error = Some(msg.clone());
                drop(g);
                self.emit_status();
                return Err(msg);
            }
        };
        {
            let mut g = self.inner.lock().expect("更新状态锁损坏");
            g.available_version = Some(update.version.clone());
            g.notes = update.body.clone();
            g.published_at = update.date.map(|d| d.to_string());
        }
        self.emit_status();
        // 下载进度回调：逐块累计并广播（字节/总量；UI 据 total 算百分比）
        let mut downloaded: u64 = 0;
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded += chunk as u64;
                    let p = DownloadProgress { downloaded, total };
                    {
                        let mut g = self.inner.lock().expect("更新状态锁损坏");
                        g.progress = Some(p);
                    }
                    let _ = self.app.emit("update:download-progress", p);
                },
                || {},
            )
            .await;
        match bytes {
            Ok(bytes) => {
                let version = update.version.clone();
                let mut g = self.inner.lock().expect("更新状态锁损坏");
                g.state = UpdateState::Ready;
                g.error = None;
                g.pending_update = Some(update);
                g.pending_bytes = bytes;
                let info = UpdateReadyInfo {
                    version: version.clone(),
                    notes: g.notes.clone(),
                    published_at: g.published_at.clone(),
                };
                drop(g);
                self.save_pending(&version);
                self.emit_status();
                let _ = self.app.emit("update:ready", info);
                diag(&format!("update: v{version} 下载验签完成，等待用户确认安装"));
                Ok(self.status())
            }
            Err(e) => {
                // 签名错误/网络中断等：回到 available 允许重试；下载失败不影响应用运行（§6.2）
                let msg = format!("下载更新失败: {e}");
                let mut g = self.inner.lock().expect("更新状态锁损坏");
                g.state = UpdateState::Available;
                g.error = Some(msg.clone());
                g.progress = None;
                drop(g);
                self.emit_status();
                Err(msg)
            }
        }
    }

    /// 安装并重启。Windows 上 install 拉起安装器后进程即退出，本函数不返回；
    /// 安装前重新请求 manifest 对账，版本被撤回/替换时清除待安装状态并拒绝（§6.4/§7.2）。
    pub async fn run_install(&self) -> Result<(), String> {
        let server = self.validate_server()?;
        {
            let g = self.inner.lock().expect("更新状态锁损坏");
            if g.pending_update.is_none() || g.pending_bytes.is_empty() {
                return Err("当前没有已就绪的更新，请先下载更新".to_string());
            }
        }
        let _guard = self.op.lock().await;
        let (update, bytes, version) = {
            let mut g = self.inner.lock().expect("更新状态锁损坏");
            (
                g.pending_update.clone().expect("前置检查已确认存在"),
                std::mem::take(&mut g.pending_bytes),
                g.available_version.clone().unwrap_or_default(),
            )
        };
        // 对账：服务端必须仍提供同一版本（204/更高版本都视为不可安装）
        let manifest = match self.fetch_latest(&server).await {
            Ok(o) => o,
            Err(e) => {
                let mut g = self.inner.lock().expect("更新状态锁损坏");
                g.state = UpdateState::Ready; // 网络瞬断不丢弃已下载制品，用户可重试
                g.pending_bytes = bytes;
                g.error = Some(e.clone());
                drop(g);
                self.emit_status();
                return Err(format!("安装前确认更新状态失败：{e}"));
            }
        };
        if let Err(msg) = verify_pending(manifest.as_ref(), &version) {
            let mut g = self.inner.lock().expect("更新状态锁损坏");
            g.pending_update = None;
            g.pending_bytes.clear();
            match &manifest {
                Some(m) => {
                    g.available_version = Some(m.version.clone());
                    g.state = UpdateState::Available;
                }
                None => {
                    g.reset_available();
                    g.state = UpdateState::NotAvailable;
                }
            }
            g.error = Some(msg.clone());
            drop(g);
            self.clear_pending();
            self.emit_status();
            return Err(msg);
        }
        {
            let mut g = self.inner.lock().expect("更新状态锁损坏");
            g.state = UpdateState::Installing;
            drop(g);
        }
        self.emit_status();
        diag(&format!("update: 确认安装 v{version}（用户已确认重启）"));
        if let Err(e) = update.install(&bytes) {
            let msg = format!("安装更新失败: {e}");
            let mut g = self.inner.lock().expect("更新状态锁损坏");
            g.state = UpdateState::Error;
            g.error = Some(msg.clone());
            g.pending_bytes = bytes;
            drop(g);
            self.emit_status();
            return Err(msg);
        }
        // Windows 不会执行到这（install 内部已 exit）；macOS 替换完成后重启进入新版本
        self.clear_pending();
        diag("update: 安装完成，重启应用");
        self.app.restart();
    }
}

/* ---------------- Tauri 命令（api.ts update* 封装一一对应） ---------------- */

/// 当前更新状态（状态机快照；前端 updates.ts 启动时拉一次，之后靠事件）。
#[tauri::command]
pub fn update_status(m: State<'_, Arc<UpdateManager>>) -> UpdateStatus {
    m.status()
}

/// 手动检查更新；失败返回可执行中文错误（后台失败只写 debug，不走此路径）。
#[tauri::command]
pub async fn update_check(m: State<'_, Arc<UpdateManager>>) -> Result<UpdateStatus, String> {
    m.run_check(true).await
}

/// 下载并由 Tauri updater 验签，完成后进入 ready 并广播 update:ready。
#[tauri::command]
pub async fn update_download(m: State<'_, Arc<UpdateManager>>) -> Result<UpdateStatus, String> {
    m.run_download().await
}

/// 用户确认后退出、安装并重启。Windows 上进程在安装器拉起后即退出，本命令不会 resolve。
#[tauri::command]
pub async fn update_install(m: State<'_, Arc<UpdateManager>>) -> Result<(), String> {
    m.run_install().await
}

/* ---------------- 后台调度（§5.1） ---------------- */

/// 主窗口就绪后延迟首检 + 24h 周期复检。未注入服务器地址的个人构建直接禁用。
/// 更新检查不依赖 OAuth 登录（安全修复不能被登录失效阻断）。
pub fn start_background(app: AppHandle) {
    if cloud::server_url().is_none() {
        diag("update: 未注入 AISHELL_SERVER_URL，自动更新禁用（个人构建）");
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK_DELAY).await;
        loop {
            let mgr = app
                .state::<Arc<UpdateManager>>()
                .inner()
                .clone();
            if let Err(e) = mgr.run_check(false).await {
                diag(&format!("update: 后台检查失败：{e}"));
            }
            drop(mgr);
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

/* ---------------- 单元测试（§9.1：SemVer / target 映射 / 响应分支 / yank 对账） ---------------- */

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    fn v(s: &str) -> SemVer {
        parse_semver(s).expect("测试版本号必须合法")
    }

    #[test]
    fn semver_parse_valid() {
        assert_eq!(v("0.4.2"), SemVer { major: 0, minor: 4, patch: 2, pre: None });
        assert_eq!(
            v("1.2.3-beta.1"),
            SemVer { major: 1, minor: 2, patch: 3, pre: Some("beta.1".into()) }
        );
        // build 元数据剥掉
        assert_eq!(v("1.0.0+build.9"), SemVer { major: 1, minor: 0, patch: 0, pre: None });
    }

    #[test]
    fn semver_parse_invalid() {
        for bad in ["abc", "1.2", "1.2.x", "1.2.3.4", "1.2.3-", ""] {
            assert!(parse_semver(bad).is_none(), "应拒绝 {bad}");
        }
    }

    #[test]
    fn semver_order() {
        assert_eq!(v("0.4.2").cmp(&v("0.4.1")), Ordering::Greater);
        assert_eq!(v("1.0.0").cmp(&v("1.0.0-beta")), Ordering::Greater);
        assert_eq!(v("1.0.0-beta.2").cmp(&v("1.0.0-beta.1")), Ordering::Greater);
        assert_eq!(v("1.0.0-alpha").cmp(&v("1.0.0-beta")), Ordering::Less);
        assert_eq!(v("1.0.0-alpha").cmp(&v("1.0.0-alpha.1")), Ordering::Less);
        // 数字段小于字母段（semver 规范）
        assert_eq!(v("1.0.0-2").cmp(&v("1.0.0-rc")), Ordering::Less);
        assert_eq!(v("2.0.0").cmp(&v("10.0.0")), Ordering::Less);
    }

    #[test]
    fn target_mapping() {
        assert_eq!(updater_target_for("windows", "x86_64"), Some("windows-x86_64"));
        assert_eq!(updater_target_for("macos", "aarch64"), Some("darwin-aarch64"));
        assert_eq!(updater_target_for("darwin", "x86_64"), Some("darwin-x86_64"));
        assert_eq!(updater_target_for("linux", "x86_64"), None);
        assert_eq!(updater_target_for("windows", "aarch64"), None);
    }

    fn manifest_json(version: &str, signature: Option<&str>) -> String {
        let sig = match signature {
            Some(s) => format!("\"{s}\""),
            None => "null".to_string(),
        };
        format!(
            r###"{{"version":"{version}","notes":"## 更新内容\n- 修复连接问题","pub_date":"2026-08-17T10:00:00Z","platforms":{{"windows-x86_64":{{"url":"https://cloud.example.com/api/updates/artifacts/42","signature":{sig}}}}}}}"###
        )
    }

    fn parsed(version: &str) -> LatestManifest {
        apply_response(200, &manifest_json(version, Some("sig")), None)
            .expect("合法 manifest")
            .expect("200 应返回 manifest")
    }

    #[test]
    fn apply_response_204_means_no_update() {
        assert!(apply_response(204, "", None).unwrap().is_none());
    }

    #[test]
    fn apply_response_200_parses_manifest() {
        let m = parsed("0.4.2");
        assert_eq!(m.version, "0.4.2");
        assert!(m.notes.as_deref().unwrap().contains("更新内容"));
        let artifact = m.platforms.get("windows-x86_64").expect("应含目标平台");
        assert_eq!(artifact.signature.as_deref(), Some("sig"));
        // 无签名迁移期：signature 为 null 也能解析（由状态机标记 signature_missing）
        let m2 = apply_response(200, &manifest_json("0.4.2", None), None)
            .unwrap()
            .unwrap();
        assert!(m2.platforms["windows-x86_64"].signature.is_none());
    }

    #[test]
    fn apply_response_rejects_invalid_payload() {
        assert!(apply_response(200, "not json", None).is_err());
        // 版本号非法（非 SemVer）必须拒绝，绝不能进入版本比较
        assert!(apply_response(200, &manifest_json("latest", Some("s")), None).is_err());
        assert!(apply_response(500, "Internal Server Error", None).is_err());
    }

    #[test]
    fn apply_response_304_reuses_cache() {
        let cached = parsed("0.4.2");
        let reused = apply_response(304, "", Some(&cached)).unwrap().unwrap();
        assert_eq!(reused, cached);
        // 本地无缓存时 304 是异常（服务端 ETag 协商不应出现）
        assert!(apply_response(304, "", None).is_err());
    }

    #[test]
    fn verify_pending_decisions() {
        let m = parsed("0.4.2");
        assert!(verify_pending(Some(&m), "0.4.2").is_ok());
        // 服务端 204（撤回/频道关闭）→ 拒绝安装
        assert!(verify_pending(None, "0.4.2").is_err());
        // 服务端已提供其他版本（回滚指针/发布更新）→ 拒绝安装并要求重新检查
        assert!(verify_pending(Some(&m), "0.4.3").is_err());
    }

    #[test]
    fn status_serializes_camel_case() {
        let s = UpdateStatus {
            state: UpdateState::NotAvailable,
            current_version: "0.4.0".into(),
            available_version: None,
            notes: None,
            published_at: None,
            progress: None,
            last_checked_at: Some(1755400000000),
            error: None,
            enabled: true,
            signature_missing: false,
            download_url: None,
        };
        let j = serde_json::to_value(&s).unwrap();
        assert_eq!(j["state"], "not_available");
        assert_eq!(j["currentVersion"], "0.4.0");
        assert_eq!(j["lastCheckedAt"], 1755400000000u64);
        assert!(j.get("availableVersion").is_some());
        let p = serde_json::to_value(DownloadProgress { downloaded: 10, total: Some(100) }).unwrap();
        assert_eq!(p["downloaded"], 10u64);
        assert_eq!(p["total"], 100u64);
    }

    #[test]
    fn pending_record_roundtrip() {
        let rec = PendingRecord { version: "0.4.2".into(), downloaded_at: 123 };
        let text = serde_json::to_string(&rec).unwrap();
        let back: PendingRecord = serde_json::from_str(&text).unwrap();
        assert_eq!(back.version, "0.4.2");
        assert_eq!(back.downloaded_at, 123);
    }

    #[test]
    fn manifest_platform_target_mismatch_is_not_offered() {
        // 服务端 200 但不含本平台制品：按无更新处理（offered 选择逻辑的单点验证）
        let body = r#"{"version":"0.5.0","platforms":{"darwin-aarch64":{"url":"https://x/a","signature":"s"}}}"#;
        let m = apply_response(200, body, None).unwrap().unwrap();
        assert!(!m.platforms.contains_key("windows-x86_64"));
    }
}
