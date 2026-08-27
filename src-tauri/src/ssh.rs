//! SSH 连接管理 —— 连接复用（同一 server 的终端与 SFTP 共享一条 TCP 连接，russh 多路复用）、
//! 密码认证走 keyring `server:<id>`、密钥走 russh-keys load_secret_key；
//! Xshell 专用 NSSSH 私钥在加载前给出可执行的 OpenSSH 导出提示，带密码短语密钥亦明确报错；
//! check_server_key MVP 直接信任（A5 已知限制）、连接与认证各自 10s 超时。
//!
//! 认证失败识别（待优化 4）：错误密码/密钥的常规表现是 `AuthResult::Failure`，
//! 认证期间被服务器断开（如 MaxAuthTries 超限）表现为 `Error::Disconnect`；
//! 两类均以 `AUTH_FAILED_PREFIX` 前缀返回中文错误，前端 terminal.ts 据此弹出重设凭据对话框。
//!
//! `ssh_exec`（待优化 5）：SFTP 直执命令入口，复用本管理器既有连接，新建 channel
//! 执行并带整体超时（`SSH_EXEC_TIMEOUT`），不依赖前端迷你终端的登录时序。
//!
//! façade 签名即跨模块契约（term.rs / sftp.rs 依赖），实现时不得更改。
//! 断线重连：连接放入 map 后 spawn 后台 watcher，`Handle::is_closed()` 变真时从 map 摘除，
//! 下次 `get_or_connect` 自动重连。

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::sync::Arc;
use std::time::Duration;

use russh::client;
use russh::ChannelMsg;
use serde::Serialize;
use tauri::State;
use tokio::sync::Mutex;

use crate::store;

const NSSSH_PRIVATE_KEY_HEADER: &[u8] = b"---- BEGIN NSSSH PRIVATE KEY ----";

/// 认证失败错误的稳定前缀（机器可识别标记）：前端 terminal.ts 据此弹出
/// 「重新设置登录凭据」对话框，展示时剥掉此前缀。与 src/api.ts SSH_AUTH_FAILED_PREFIX 保持一致。
pub const AUTH_FAILED_PREFIX: &str = "[SSH认证失败]";

/// 认证失败的中文错误（带原始错误摘要）：用户名、密码或密钥不正确，或认证方法不被服务器支持。
fn auth_failed_msg(server: &store::Server, detail: &str) -> String {
    format!(
        "{AUTH_FAILED_PREFIX}服务器「{}」（{}:{}）认证失败：用户名、密码或密钥不正确，\
         请重新设置后重试（原始错误：{detail}）",
        server.name, server.host, server.port
    )
}

/// 判定 russh 认证阶段的 Error 是否由凭据问题引起。错误密码/密钥的常规表现是
/// `AuthResult::Failure`（success()==false，在 connect_handle 中单独处理），
/// 此处兜底 Error 分支：认证期间被服务器断开（如连续失败触发 MaxAuthTries 上限）、
/// 认证方法不被服务器支持（引导用户在对话框中切换认证方式）。
fn is_auth_failure(e: &russh::Error) -> bool {
    matches!(
        e,
        russh::Error::Disconnect | russh::Error::UnsupportedAuthMethod
    )
}

fn has_nsssh_header(bytes: &[u8]) -> bool {
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    let Some(rest) = bytes.strip_prefix(NSSSH_PRIVATE_KEY_HEADER) else {
        return false;
    };
    rest.is_empty() || matches!(rest.first(), Some(b'\r' | b'\n'))
}

/// 固定长度读取文件头，不加载或输出私钥正文。
fn is_nsssh_private_key(path: &str) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let mut prefix = [0_u8; NSSSH_PRIVATE_KEY_HEADER.len() + 4];
    let Ok(read) = file.read(&mut prefix) else {
        return false;
    };
    has_nsssh_header(&prefix[..read])
}

fn reject_unsupported_key_format(server: &store::Server) -> Result<(), String> {
    if !is_nsssh_private_key(&server.key_path) {
        return Ok(());
    }
    Err(format!(
        "服务器「{}」使用的是 Xshell 专用 NSSSH 私钥（{}），AIShell 无法直接读取。请在 Xshell 中打开「工具 → 用户密钥管理器」，选中对应密钥并导出为无密码短语的 OpenSSH 私钥，然后在 AIShell 的服务器配置中替换密钥路径",
        server.name, server.key_path
    ))
}

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

/// 转发通道失败的可能原因提示（错误信息追加用；纯函数便于单测）。
/// AdministrativelyProhibited = 堡垒机 sshd 拒绝打开转发通道（典型：AllowTcpForwarding no），
/// 与「在堡垒机上手动 ssh 目标主机」不矛盾——后者是出站客户端连接，不经转发许可。
fn tcp_forward_hint(err: &str) -> &'static str {
    if err.to_lowercase().contains("administrativelyprohibited") {
        "\n可能原因：堡垒机 sshd 禁用了 TCP 转发（AllowTcpForwarding no 或 PermitOpen 限制）。请在堡垒机 /etc/ssh/sshd_config 设置 AllowTcpForwarding yes 并重启 sshd（systemctl restart sshd）后重试。"
    } else {
        ""
    }
}

impl SshManager {
    pub fn new(store: Arc<store::Store>) -> Self {
        SshManager {
            store,
            sessions: Mutex::new(HashMap::new()),
        }
    }

    /// 取（或建立）到 server 的连接：map 命中且未断开则复用，否则连接 + 认证后入池。
    /// 目标主机（Server.bastion_id 非空）走跳板：先建连/复用堡垒机连接，再在堡垒机上开
    /// direct-tcpip 通道指向目标主机 host:port，把通道作为传输层完成目标主机的 SSH 握手
    /// 与认证（两端凭据各自独立存 keyring `server:<id>`）。
    pub async fn get_or_connect(
        self: &Arc<Self>,
        server_id: &str,
    ) -> Result<Arc<client::Handle<CliHandler>>, String> {
        self.get_or_connect_inner(server_id, None).await
    }

    /// 测试专用（doc hidden）：与 `get_or_connect` 相同，但直连与跳板两段认证都用给定密码
    /// 覆盖（None 走 keyring）——回环集成测试用它避免触碰真实 keyring。
    #[doc(hidden)]
    pub async fn get_or_connect_with_password(
        self: &Arc<Self>,
        server_id: &str,
        password: &str,
    ) -> Result<Arc<client::Handle<CliHandler>>, String> {
        self.get_or_connect_inner(server_id, Some(password)).await
    }

    async fn get_or_connect_inner(
        self: &Arc<Self>,
        server_id: &str,
        password_override: Option<&str>,
    ) -> Result<Arc<client::Handle<CliHandler>>, String> {
        if let Some(handle) = self.live_handle(server_id).await {
            return Ok(handle);
        }
        let server = self
            .store
            .server(server_id)
            .ok_or_else(|| format!("服务器不存在：{server_id}"))?;
        let handle = match &server.bastion_id {
            // 普通服务器 / 堡垒机：直连
            None => self.connect_handle(&server, password_override).await?,
            // 目标主机：先连堡垒机，再经其转发（堡垒机本身不允许再挂堡垒机，杜绝链式跳板）
            Some(bastion_id) => {
                let bastion = self.store.server(bastion_id).ok_or_else(|| {
                    format!("目标主机「{}」的堡垒机不存在：{bastion_id}", server.name)
                })?;
                if !bastion.is_bastion {
                    return Err(format!(
                        "目标主机「{}」的堡垒机「{}」未开启堡垒机功能",
                        server.name, bastion.name
                    ));
                }
                if bastion.bastion_id.is_some() {
                    return Err(format!(
                        "堡垒机「{}」不能作为另一台堡垒机的目标主机",
                        bastion.name
                    ));
                }
                let bastion_handle =
                    Box::pin(self.get_or_connect_inner(bastion_id, password_override)).await?;
                self.connect_via_jump(&server, &bastion, bastion_handle, password_override)
                    .await?
            }
        };
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

    /// 执行单条远程命令并收集 stdout/stderr/退出码（复用底层连接；channel 用完即弃）。
    /// 空命令在建连前拒绝。AI 远程动作的锁检查在 ai_actions 入口，不在本方法内。
    /// 无超时：仅保留给确需无界执行的内部调用；AI run_command 必须走 exec_with_timeout。
    pub async fn exec(
        self: &Arc<Self>,
        server_id: &str,
        command: &str,
    ) -> Result<crate::ai_actions::CommandResult, String> {
        self.exec_impl(server_id, command, None).await
    }

    /// 带整体超时的单命令执行：超时后尝试中断远端命令，返回已收集输出并标记
    /// `timed_out=true`（ssh_exec 映射为 code=null；AI run_command 转成明确失败）。
    pub async fn exec_with_timeout(
        self: &Arc<Self>,
        server_id: &str,
        command: &str,
        timeout: Duration,
    ) -> Result<crate::ai_actions::CommandResult, String> {
        self.exec_impl(server_id, command, Some(timeout)).await
    }

    /// exec 公共实现；timeout=None 时不设限。
    async fn exec_impl(
        self: &Arc<Self>,
        server_id: &str,
        command: &str,
        timeout: Option<Duration>,
    ) -> Result<crate::ai_actions::CommandResult, String> {
        if command.trim().is_empty() {
            return Err("命令不能为空".to_string());
        }
        let handle = self.get_or_connect(server_id).await?;
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| format!("打开服务器会话通道失败：{e}"))?;
        channel
            .exec(true, command.as_bytes())
            .await
            .map_err(|e| format!("启动远端命令失败：{e}"))?;
        let mut stdout: Vec<u8> = Vec::new();
        let mut stderr: Vec<u8> = Vec::new();
        let mut exit_code: Option<i32> = None;
        let mut timed_out = false;
        let read = async {
            while let Some(msg) = channel.wait().await {
                match msg {
                    ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                    ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                    ChannelMsg::ExitStatus { exit_status } => exit_code = Some(exit_status as i32),
                    // EOF 仅表示服务端不再发数据,不能跳出:OpenSSH 的消息序是
                    // Eof → ExitStatus → Close(已在真实 sshd 上实测),退出码在 EOF 之后才到。
                    ChannelMsg::Eof => {}
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
        };
        if let Some(d) = timeout {
            if tokio::time::timeout(d, read).await.is_err() {
                timed_out = true;
                // 超时：尽力中断远端命令（失败无碍，channel drop 也会关闭），保留已收集输出
                let _ = channel.eof().await;
            }
        } else {
            read.await;
        }
        Ok(crate::ai_actions::CommandResult {
            stdout: String::from_utf8_lossy(&stdout).into_owned(),
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code,
            timed_out,
        })
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

    /// 直连建连 + 认证（各 10s 超时）。password_override 仅供测试注入，None 时走 Store/keyring。
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
        if server.auth_type == store::AuthType::Key {
            reject_unsupported_key_format(server)?;
        }
        let config = Arc::new(client::Config::default());
        let addr = (server.host.as_str(), server.port);
        let handle = tokio::time::timeout(
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
        self.authenticate_handle(handle, server, password_override).await
    }

    /// 经堡垒机连接目标主机：堡垒机连接复用连接池，在堡垒机上开 direct-tcpip 通道指向
    /// 目标主机 host:port，再把通道当作传输层跑目标主机的 SSH 握手（russh connect_stream），
    /// 随后按目标主机自身凭据认证。各步 10s 超时，错误信息带堡垒机名便于排查。
    /// password_override 仅供测试注入（透传给认证）。
    async fn connect_via_jump(
        self: &Arc<Self>,
        server: &store::Server,
        bastion: &store::Server,
        bastion_handle: Arc<client::Handle<CliHandler>>,
        password_override: Option<&str>,
    ) -> Result<Arc<client::Handle<CliHandler>>, String> {
        if server.username.trim().is_empty() {
            return Err(format!(
                "目标主机「{}」未配置登录用户名，请在设置中补充",
                server.name
            ));
        }
        if server.auth_type == store::AuthType::Key {
            reject_unsupported_key_format(server)?;
        }
        let via = format!("经堡垒机「{}」", bastion.name);
        let channel = tokio::time::timeout(
            Duration::from_secs(10),
            bastion_handle.channel_open_direct_tcpip(
                &server.host,
                server.port as u32,
                "127.0.0.1",
                0,
            ),
        )
        .await
        .map_err(|_| {
            format!(
                "{via}连接目标主机「{}」超时（10s）：{}:{}",
                server.name, server.host, server.port
            )
        })?
        .map_err(|e| {
            let e_str = e.to_string();
            format!(
                "{via}打开到目标主机「{}」（{}:{}）的转发通道失败：{e_str}{}",
                server.name,
                server.host,
                server.port,
                tcp_forward_hint(&e_str)
            )
        })?;
        let config = Arc::new(client::Config::default());
        let handle = tokio::time::timeout(
            Duration::from_secs(10),
            client::connect_stream(config, channel.into_stream(), CliHandler),
        )
        .await
        .map_err(|_| format!("{via}连接目标主机「{}」超时（10s）", server.name))?
        .map_err(|e| format!("{via}连接目标主机「{}」失败：{e}", server.name))?;
        self.authenticate_handle(handle, server, password_override).await
    }

    /// 在已建立 SSH 会话的 handle 上完成用户认证（各 10s 超时）。
    /// 直连（connect_handle）与跳板（connect_via_jump）共用；password_override 仅供测试注入。
    async fn authenticate_handle(
        &self,
        handle: client::Handle<CliHandler>,
        server: &store::Server,
        password_override: Option<&str>,
    ) -> Result<Arc<client::Handle<CliHandler>>, String> {
        let mut handle = handle;
        let accepted = match server.auth_type {
            store::AuthType::Password => {
                let password = match password_override {
                    Some(p) => p.to_string(),
                    None => self
                        .store
                        .read_server_secret(server)
                        .map_err(|e| format!("读取服务器「{}」的密码失败：{e}", server.name))?,
                };
                let res = tokio::time::timeout(
                    Duration::from_secs(10),
                    handle.authenticate_password(&server.username, password),
                )
                .await
                .map_err(|_| format!("认证服务器「{}」超时（10s）", server.name))?
                .map_err(|e| {
                    if is_auth_failure(&e) {
                        auth_failed_msg(server, &e.to_string())
                    } else {
                        format!("认证服务器「{}」失败：{e}", server.name)
                    }
                })?;
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
                .map_err(|e| {
                    if is_auth_failure(&e) {
                        auth_failed_msg(server, &e.to_string())
                    } else {
                        format!("认证服务器「{}」失败：{e}", server.name)
                    }
                })?;
                res.success()
            }
        };
        if !accepted {
            return Err(auth_failed_msg(
                server,
                "服务器拒绝了当前凭据（USERAUTH_FAILURE）",
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

/// `ssh_exec` 单条命令的通道级超时：压缩/解压大目录可能耗时，5 分钟兜底；
/// 超时后中断远端命令并返回已收集的输出（退出码为 null，前端按失败提示）。
const SSH_EXEC_TIMEOUT: Duration = Duration::from_secs(300);

/// `ssh_exec` 直执结果（serde camelCase，与 src/types.ts SshExecResult 对齐）；
/// `code` 为 null 表示命令超时被中断或通道未返回退出码。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshExecResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
}

/// SFTP 直执命令（待优化 5）：复用 SshManager 既有连接（每 serverId 一条），
/// 新建 channel 执行单条命令并收集 stdout/stderr/退出码；不依赖前端迷你终端的
/// 登录时序。命令与结果由前端写入 debug 日志（见 sftp.ts runRemoteCommand）。
#[tauri::command]
pub async fn ssh_exec(
    ssh: State<'_, Arc<SshManager>>,
    server_id: String,
    command: String,
) -> Result<SshExecResult, String> {
    let res = ssh
        .exec_with_timeout(&server_id, &command, SSH_EXEC_TIMEOUT)
        .await?;
    Ok(SshExecResult {
        code: res.exit_code,
        stdout: res.stdout,
        stderr: res.stderr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key_server(path: &str) -> store::Server {
        store::Server {
            id: "srv-nsssh".to_string(),
            name: "Xshell 导入会话".to_string(),
            host: "127.0.0.1".to_string(),
            port: 22,
            auth_type: store::AuthType::Key,
            username: "tester".to_string(),
            key_path: path.to_string(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        }
    }

    #[test]
    fn detects_only_complete_nsssh_header() {
        assert!(has_nsssh_header(
            b"---- BEGIN NSSSH PRIVATE KEY ----\r\npayload"
        ));
        assert!(has_nsssh_header(
            b"\xEF\xBB\xBF---- BEGIN NSSSH PRIVATE KEY ----\n"
        ));
        assert!(!has_nsssh_header(
            b"-----BEGIN OPENSSH PRIVATE KEY-----\npayload"
        ));
        assert!(!has_nsssh_header(b"---- BEGIN NSSSH PRIVATE KEY ----x"));
    }

    #[test]
    fn detects_auth_failure_error_variants() {
        // 认证期间被服务器断开（如 MaxAuthTries 超限）/ 认证方法不受支持 → 判为认证失败
        assert!(is_auth_failure(&russh::Error::Disconnect));
        assert!(is_auth_failure(&russh::Error::UnsupportedAuthMethod));
        // 网络/连接层错误不是凭据问题，不应触发重设凭据对话框
        assert!(!is_auth_failure(&russh::Error::HUP));
        assert!(!is_auth_failure(&russh::Error::ConnectionTimeout));
        assert!(!is_auth_failure(&russh::Error::Kex));
    }

    #[test]
    fn auth_failed_msg_carries_prefix_and_raw_detail() {
        let server = store::Server {
            id: "srv-x".to_string(),
            name: "测试机".to_string(),
            host: "10.0.0.1".to_string(),
            port: 22,
            auth_type: store::AuthType::Password,
            username: "root".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        };
        let msg = auth_failed_msg(&server, "Disconnected");
        assert!(msg.starts_with(AUTH_FAILED_PREFIX));
        assert!(msg.contains("测试机"));
        assert!(msg.contains("10.0.0.1"));
        assert!(msg.contains("Disconnected"));
    }

    /// ssh_exec 的错误路径（不连真实服务器、不碰真实 keyring，走 test_store/MemorySecrets）。
    #[tokio::test]
    async fn ssh_exec_rejects_empty_command_and_unknown_server_without_network() {
        let store_dir = std::env::temp_dir()
            .join(format!("aishell-sshexec-store-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&store_dir);
        let manager = Arc::new(SshManager::new(Arc::new(store::test_store(store_dir.clone()))));
        let timeout = Duration::from_secs(5);

        // 空命令在建连前拒绝
        let err = manager
            .exec_with_timeout("srv-missing", "   ", timeout)
            .await
            .err()
            .unwrap();
        assert!(err.contains("命令不能为空"), "unexpected: {err}");

        // 未知服务器在建连前拒绝
        let err = manager
            .exec_with_timeout("srv-missing", "echo hi", timeout)
            .await
            .err()
            .unwrap();
        assert!(err.contains("服务器不存在"), "unexpected: {err}");

        let _ = std::fs::remove_dir_all(store_dir);
    }

    #[tokio::test]
    async fn connect_rejects_nsssh_before_network_with_actionable_error() {
        let suffix = std::process::id();
        let path = std::env::temp_dir().join(format!("aishell-nsssh-key-test-{suffix}.pri"));
        let store_dir = std::env::temp_dir().join(format!("aishell-nsssh-store-test-{suffix}"));
        let _ = std::fs::remove_dir_all(&store_dir);
        std::fs::write(&path, b"---- BEGIN NSSSH PRIVATE KEY ----\r\npayload").unwrap();
        let server = key_server(&path.to_string_lossy());
        let manager = SshManager::new(Arc::new(store::test_store(store_dir.clone())));

        let err = manager.connect_handle(&server, None).await.err().unwrap();
        assert!(err.contains("Xshell 专用 NSSSH 私钥"));
        assert!(err.contains("工具 → 用户密钥管理器"));
        assert!(err.contains("无密码短语的 OpenSSH 私钥"));

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_dir_all(store_dir);
    }

    /// 跳板错误路径（不连真实服务器、不碰真实 keyring）：
    /// 目标主机的堡垒机不存在 / 未开启堡垒机 / 堡垒机本身又是目标主机 → 建网前拒绝并给出中文错误。
    #[test]
    fn tcp_forward_hint_adds_actionable_guide_for_admin_prohibited() {
        // AdministrativelyProhibited（大小写不敏感）：给出 AllowTcpForwarding 排查指引
        let hint = tcp_forward_hint("Failed to open channel (AdministrativelyProhibited)");
        assert!(hint.contains("AllowTcpForwarding"), "应提示转发开关: {hint}");
        assert!(hint.contains("sshd_config"));
        // 其他错误：无附加提示
        assert_eq!(tcp_forward_hint("Connection reset by peer"), "");
        assert_eq!(tcp_forward_hint("Network is unreachable"), "");
    }

    #[tokio::test]
    async fn get_or_connect_rejects_invalid_jump_setups_before_network() {
        let store_dir = std::env::temp_dir().join(format!(
            "aishell-jump-store-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&store_dir);
        let store = Arc::new(store::test_store(store_dir.clone()));

        let bastion = |id: &str| store::Server {
            id: id.to_string(),
            name: format!("堡垒机{id}"),
            host: "127.0.0.1".to_string(),
            port: 22,
            auth_type: store::AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: true,
            bastion_id: None,
            tags: Vec::new(),
        };
        let target = |id: &str, bid: &str| store::Server {
            id: id.to_string(),
            name: format!("目标机{id}"),
            host: "10.0.0.9".to_string(),
            port: 22,
            auth_type: store::AuthType::Password,
            username: "u".to_string(),
            key_path: String::new(),
            credential_id: None,
            locked: false,
            is_bastion: false,
            bastion_id: Some(bid.to_string()),
            tags: Vec::new(),
        };
        // 合法堡垒机 + 合法目标
        store::force_upsert_server(&store, bastion("b"));
        store::force_upsert_server(&store, target("t-ok", "b"));
        // 幽灵堡垒机引用
        store::force_upsert_server(&store, target("t-ghost", "srv-missing"));
        // 未开启堡垒机的普通服务器被引用
        store::force_upsert_server(&store, {
            let mut plain = bastion("p");
            plain.is_bastion = false;
            plain
        });
        store::force_upsert_server(&store, target("t-plain", "p"));
        // 链式：堡垒机 b2 本身又是 b 的目标主机（同时 is_bastion=true，绕过校验构造非法态）
        let mut b2 = target("b2", "b");
        b2.is_bastion = true;
        store::force_upsert_server(&store, b2);
        store::force_upsert_server(&store, target("t-chain", "b2"));

        let manager = Arc::new(SshManager::new(Arc::clone(&store)));

        let err = manager
            .get_or_connect("t-ghost")
            .await
            .err()
            .expect("幽灵堡垒机应拒绝");
        assert!(err.contains("堡垒机不存在"), "错误串不符: {err}");

        let err = manager
            .get_or_connect("t-plain")
            .await
            .err()
            .expect("未开启堡垒机功能应拒绝");
        assert!(err.contains("未开启堡垒机功能"), "错误串不符: {err}");

        let err = manager
            .get_or_connect("t-chain")
            .await
            .err()
            .expect("链式跳板应拒绝");
        assert!(err.contains("不能作为另一台堡垒机的目标主机"), "错误串不符: {err}");

        // 合法目标：错误发生在真实的堡垒机连接阶段（127.0.0.1:22 无 sshd），
        // 错误应指向堡垒机自身，证明先连堡垒机（而非直连目标机 10.0.0.9）
        let err = manager
            .get_or_connect("t-ok")
            .await
            .err()
            .expect("无 sshd 的堡垒机连接应失败");
        assert!(err.contains("堡垒机b"), "错误串不符: {err}");
        assert!(!err.contains("10.0.0.9"), "不应直连目标主机: {err}");

        let _ = std::fs::remove_dir_all(store_dir);
    }
}
