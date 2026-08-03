//! SSH 连接管理 —— 连接复用（同一 server 的终端与 SFTP 共享一条 TCP 连接，russh 多路复用）、
//! 密码认证走 keyring `server:<id>`、密钥走 russh-keys load_secret_key（带短语明确报错）、
//! check_server_key MVP 直接信任（A5 已知限制）、连接与认证各自 10s 超时。
//!
//! façade 签名即跨模块契约（term.rs / sftp.rs 依赖），实现时不得更改。
//! 断线重连：连接放入 map 后 spawn 后台 watcher，`Handle::is_closed()` 变真时从 map 摘除，
//! 下次 `get_or_connect` 自动重连。

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use tokio::sync::Mutex;

use crate::store;

/// 客户端事件处理器。MVP 接受任意 host key（计划 A5：不做 known_hosts 校验，后续版本补）。
pub struct CliHandler;

impl client::Handler for CliHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// 连接门面：线程安全（内部 Mutex<HashMap>），同一 server 所有会话共享一条 TCP 连接。
pub struct SshManager {
    store: Arc<store::Store>,
    sessions: Mutex<HashMap<String, Arc<client::Handle<CliHandler>>>>,
}

impl SshManager {
    pub fn new(store: Arc<store::Store>) -> Self {
        SshManager {
            store,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 取（或建立）到 server 的连接：map 命中且未断开则复用，否则连接 + 认证后入池。
    pub async fn get_or_connect(
        self: &Arc<Self>,
        server_id: &str,
    ) -> Result<Arc<client::Handle<CliHandler>>, String> {
        if let Some(handle) = self.live_handle(server_id).await {
            return Ok(handle);
        }
        let server = self
            .store
            .server(server_id)
            .ok_or_else(|| format!("服务器不存在：{server_id}"))?;
        let handle = self.connect_handle(&server, None).await?;
        self.insert_and_watch(server_id, handle).await
    }

    /// 测试专用（doc hidden）：绕过 Store 与 keyring，直接以给定凭据建连并入池。
    /// `password` 仅在 authType=Password 时生效（Key 分支忽略）。
    #[doc(hidden)]
    pub async fn connect_direct(
        self: &Arc<Self>,
        server: store::Server,
        password: Option<&str>,
    ) -> Result<Arc<client::Handle<CliHandler>>, String> {
        let handle = self.connect_handle(&server, password).await?;
        self.insert_and_watch(&server.id, handle).await
    }

    /// 打开（或复用）连接并申请 PTY + shell channel，交给 term.rs 接入事件流。
    pub async fn open_shell(
        self: &Arc<Self>,
        server_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<russh::Channel<russh::client::Msg>, String> {
        let handle = self.get_or_connect(server_id).await?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开服务器会话通道失败：{e}"))?;
        channel
            .request_pty(true, "xterm-256color", cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|e| format!("申请远程 PTY 失败：{e}"))?;
        channel
            .request_shell(true)
            .await
            .map_err(|e| format!("启动远程 shell 失败：{e}"))?;
        Ok(channel)
    }

    /// 打开（或复用）连接并在其上建立 SFTP 会话。
    pub async fn open_sftp(
        self: &Arc<Self>,
        server_id: &str,
    ) -> Result<russh_sftp::client::SftpSession, String> {
        let handle = self.get_or_connect(server_id).await?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开服务器会话通道失败：{e}"))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| format!("申请 SFTP 子系统失败：{e}"))?;
        russh_sftp::client::SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| format!("初始化 SFTP 会话失败：{e}"))
    }

    /// 断开并清理该 server 的连接（下次操作自动重连）。
    pub async fn disconnect(&self, server_id: &str) {
        let handle = self.sessions.lock().await.remove(server_id);
        if let Some(handle) = handle {
            let _ = handle
                .disconnect(russh::Disconnect::ByApplication, "client disconnect", "en")
                .await;
        }
    }

    /* ---------- 内部 ---------- */

    async fn live_handle(&self, server_id: &str) -> Option<Arc<client::Handle<CliHandler>>> {
        let map = self.sessions.lock().await;
        map.get(server_id).filter(|h| !h.is_closed()).cloned()
    }

    /// 建连 + 认证（各 10s 超时）。password_override 仅供测试注入，None 时走 Store/keyring。
    async fn connect_handle(
        &self,
        server: &store::Server,
        password_override: Option<&str>,
    ) -> Result<Arc<client::Handle<CliHandler>>, String> {
        if server.username.trim().is_empty() {
            return Err(format!(
                "服务器「{}」未配置登录用户名，请在设置中补充",
                server.name
            ));
        }
        let config = Arc::new(client::Config::default());
        let addr = (server.host.as_str(), server.port);
        let mut handle = tokio::time::timeout(
            Duration::from_secs(10),
            client::connect(config, addr, CliHandler),
        )
        .await
        .map_err(|_| {
            format!(
                "连接服务器「{}」超时（10s）：{}:{}",
                server.name, server.host, server.port
            )
        })?
        .map_err(|e| {
            format!(
                "连接服务器「{}」失败（{}:{}）：{e}",
                server.name, server.host, server.port
            )
        })?;

        let accepted = match server.auth_type {
            store::AuthType::Password => {
                let password = match password_override {
                    Some(p) => p.to_string(),
                    None => self
                        .store
                        .read_secret(&format!("server:{}", server.id))
                        .map_err(|e| format!("读取服务器「{}」的密码失败：{e}", server.name))?,
                };
                let res = tokio::time::timeout(
                    Duration::from_secs(10),
                    handle.authenticate_password(&server.username, password),
                )
                .await
                .map_err(|_| format!("认证服务器「{}」超时（10s）", server.name))?
                .map_err(|e| format!("认证服务器「{}」失败：{e}", server.name))?;
                res.success()
            }
            store::AuthType::Key => {
                let key = russh::keys::load_secret_key(&server.key_path, None).map_err(|e| match e {
                    russh::keys::Error::KeyIsEncrypted => format!(
                        "MVP 暂不支持带密码短语的密钥，请改用无短语密钥（{}:{}）",
                        server.host, server.port
                    ),
                    other => format!(
                        "读取服务器「{}」的密钥失败（{}）：{other}",
                        server.name, server.key_path
                    ),
                })?;
                let key = russh::keys::PrivateKeyWithHashAlg::new(
                    Arc::new(key),
                    handle
                        .best_supported_rsa_hash()
                        .await
                        .map_err(|e| format!("获取服务器「{}」的签名算法支持失败：{e}", server.name))?
                        .flatten(),
                );
                let res = tokio::time::timeout(
                    Duration::from_secs(10),
                    handle.authenticate_publickey(&server.username, key),
                )
                .await
                .map_err(|_| format!("认证服务器「{}」超时（10s）", server.name))?
                .map_err(|e| format!("认证服务器「{}」失败：{e}", server.name))?;
                res.success()
            }
        };
        if !accepted {
            return Err(format!(
                "认证服务器「{}」被拒绝（{}:{}）",
                server.name, server.host, server.port
            ));
        }
        Ok(Arc::new(handle))
    }

    /// 放入连接池并 spawn 后台 watcher：连接结束（is_closed）时从 map 摘除。
    async fn insert_and_watch(
        self: &Arc<Self>,
        server_id: &str,
        handle: Arc<client::Handle<CliHandler>>,
    ) -> Result<Arc<client::Handle<CliHandler>>, String> {
        {
            let mut map = self.sessions.lock().await;
            // 并发建连竞争：若已有可用连接则复用之，丢弃本次新建
            if let Some(existing) = map.get(server_id) {
                if !existing.is_closed() {
                    return Ok(Arc::clone(existing));
                }
            }
            map.insert(server_id.to_string(), Arc::clone(&handle));
        }
        self.spawn_watcher(server_id.to_string(), Arc::clone(&handle));
        Ok(handle)
    }

    fn spawn_watcher(self: &Arc<Self>, server_id: String, handle: Arc<client::Handle<CliHandler>>) {
        let manager = Arc::clone(self);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                if handle.is_closed() {
                    let mut map = manager.sessions.lock().await;
                    // 仅摘除仍指向同一连接的表项（避免误删并发重建的新连接）
                    if matches!(map.get(&server_id), Some(h) if Arc::ptr_eq(h, &handle)) {
                        map.remove(&server_id);
                    }
                    break;
                }
            }
        });
    }
}
