//! SSH 自包含 loopback 集成测试（计划步骤 5 验收，不依赖外部 SSH 服务器）。
//!
//! 进程内起一个 russh echo server（模式照 russh 仓库 examples/sftp_server.rs / echoserver.rs）：
//! 密码认证接受 test/test，shell 请求回 success，data 原样回显。
//! 断言 `SshManager` 连接 + `open_shell` 后往 channel 写 "echo hello\n" 能读到含 hello 的输出。
//!
//! 密码通过 `SshManager::connect_direct`（doc hidden 的测试专用入口）注入，不起 keyring；
//! server 记录经 connect_direct 直接入池，因此 `open_shell` 可走 `get_or_connect` 复用该连接。
//!
//! 注意：本文件依赖 aishell_lib 的 `pub mod ssh` / `pub mod store`（集成阶段由主 agent 打开）。

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use aishell_lib::ssh::SshManager;
use aishell_lib::store::{AuthType, Server, Store};
use russh::server::{Auth, Msg, Server as _, Session};
use russh::{Channel, ChannelId, ChannelMsg};
use tokio::net::TcpListener;

/// 测试专用 host key（Ed25519，无短语；仅供进程内测试 server 使用）。
const HOST_KEY_PEM: &str = r#"-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACD20+MMuGo8/wZIbz3jYmjJ02xCB0js/jhvB7diYjpD8wAAAKAkXSJvJF0i
bwAAAAtzc2gtZWQyNTUxOQAAACD20+MMuGo8/wZIbz3jYmjJ02xCB0js/jhvB7diYjpD8w
AAAED2j0W1Uaq7UYOtm3xr6zhimPBiUhWVXhKZWDNh9pBb7vbT4wy4ajz/BkhvPeNiaMnT
bEIHSOz+OG8Ht2JiOkPzAAAAG2toZWxsZW5kcm9zQERFU0tUT1AtSjNJVlFGOAEC
-----END OPENSSH PRIVATE KEY-----
"#;

/// 极简 echo server：接受任意客户端，shell 数据原样回显。
#[derive(Clone, Default)]
struct EchoServer;

impl russh::server::Server for EchoServer {
    type Handler = EchoSession;

    fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
        EchoSession::default()
    }
}

#[derive(Default)]
struct EchoSession {
    /// 已申请 sftp 子系统的通道（首包回复版本握手后移除）
    sftp_channels: std::collections::HashSet<ChannelId>,
}

impl russh::server::Handler for EchoSession {
    type Error = russh::Error;

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        if user == "test" && password == "test" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name == "sftp" {
            self.sftp_channels.insert(channel);
            session.channel_success(channel)?;
        } else {
            session.channel_failure(channel)?;
        }
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.sftp_channels.remove(&channel) {
            // SFTP 版本握手：回复 SSH_FXP_VERSION（type=2, version=3），仅首包
            session.data(channel, [0, 0, 0, 5, 2, 0, 0, 0, 3].to_vec())?;
        } else {
            // 原样回显到同一 channel（to_vec：Bytes 借用要求 'static）
            session.data(channel, data.to_vec())?;
        }
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // 模拟常见命令输出：`printf <text>` → stdout 为 <text>；其余命令原样回显命令串；
        // stderr 恒空，退出码恒 0。消息序照真实 OpenSSH 实测：data → eof → exit-status → close
        // （与直觉相反：eof 先于退出码；客户端若在 eof 处中断读取将永远拿不到退出码）
        session.channel_success(channel)?;
        let cmd = String::from_utf8_lossy(data);
        let out: Vec<u8> = match cmd.strip_prefix("printf ") {
            Some(text) => text.trim().as_bytes().to_vec(),
            None => data.to_vec(),
        };
        if !out.is_empty() {
            session.data(channel, out)?;
        }
        session.eof(channel)?;
        session.exit_status_request(channel, 0)?;
        session.close(channel)?;
        Ok(())
    }
}

/// 在 127.0.0.1 随机端口起 echo server（模式照 russh 仓库 examples 的 echoserver / sftp_server）。
/// `run_on_socket` 会借用调用方帧内的 `socket`/`server`，故不放 helper，由测试函数内联持有；
/// 测试体与 server 用 `tokio::join!` 并发驱动，测试体结束时 `shutdown.shutdown(..)` 关停。
#[tokio::test]
async fn shell_echo_roundtrip() {
    let socket = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("绑定 127.0.0.1:0 失败");
    let addr = socket.local_addr().expect("取监听地址失败");
    let config = Arc::new(russh::server::Config {
        keys: vec![
            russh::keys::PrivateKey::from_openssh(HOST_KEY_PEM.as_bytes())
                .expect("解析测试 host key 失败"),
        ],
        ..Default::default()
    });
    let mut server = EchoServer;
    let running = server.run_on_socket(config, &socket);
    let shutdown = running.handle();

    let test_body = async {
        // Store 仅用于构造 SshManager（连接凭据走 connect_direct，不起 keyring）
        let config_dir = std::env::temp_dir().join(format!(
            "aishell-ssh-loopback-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let store = Arc::new(Store::new(config_dir).expect("Store::new 应成功"));
        let ssh = Arc::new(SshManager::new(store));

        let server = Server {
            id: "s1".to_string(),
            name: "loopback".to_string(),
            host: addr.ip().to_string(),
            port: addr.port(),
            auth_type: AuthType::Password,
            username: "test".to_string(),
            key_path: String::new(),
            locked: false,
        };
        ssh.connect_direct(server, Some("test"))
            .await
            .expect("连接 + 密码认证应成功");

        // open_shell 走 get_or_connect 复用 connect_direct 入池的连接
        let mut channel = ssh
            .open_shell("s1", 80, 24)
            .await
            .expect("open_shell 应成功（PTY + shell 请求）");

        channel
            .data(&b"echo hello\n"[..])
            .await
            .expect("向 channel 写数据应成功");

        // 持续读回显直到含 hello（echo server 原样回显输入）
        let mut got = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline && !got.contains("hello") {
            let msg = tokio::time::timeout(Duration::from_secs(5), channel.wait())
                .await
                .expect("等待回显超时");
            match msg {
                Some(ChannelMsg::Data { data }) => {
                    let bytes: &[u8] = &data;
                    got.push_str(&String::from_utf8_lossy(bytes));
                }
                Some(_) => {}
                None => break, // 通道已关闭
            }
        }
        assert!(
            got.contains("hello"),
            "未收到含 hello 的回显，实际收到：{got:?}"
        );

        ssh.disconnect("s1").await;
        // 关停 echo server，使 join! 两端都结束
        shutdown.shutdown("test done".into());
    };

    let (server_res, ()) = tokio::join!(running, test_body);
    server_res.expect("echo server 异常退出");
}

/// 远程 exec 集成测试：`ssh.exec` 复用连接执行单条命令，
/// 断言 stdout/stderr/退出码（echo server 的 exec 分支：`printf X` → stdout X，stderr 空，exit 0）。
#[tokio::test]
async fn remote_exec_roundtrip() {
    let socket = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("绑定 127.0.0.1:0 失败");
    let addr = socket.local_addr().expect("取监听地址失败");
    let config = Arc::new(russh::server::Config {
        keys: vec![
            russh::keys::PrivateKey::from_openssh(HOST_KEY_PEM.as_bytes())
                .expect("解析测试 host key 失败"),
        ],
        ..Default::default()
    });
    let mut server = EchoServer;
    let running = server.run_on_socket(config, &socket);
    let shutdown = running.handle();

    let test_body = async {
        let config_dir = std::env::temp_dir().join(format!(
            "aishell-ssh-exec-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let store = Arc::new(Store::new(config_dir).expect("Store::new 应成功"));
        let ssh = Arc::new(SshManager::new(store));

        let server = Server {
            id: "s1".to_string(),
            name: "loopback".to_string(),
            host: addr.ip().to_string(),
            port: addr.port(),
            auth_type: AuthType::Password,
            username: "test".to_string(),
            key_path: String::new(),
            locked: false,
        };
        ssh.connect_direct(server, Some("test"))
            .await
            .expect("连接 + 密码认证应成功");

        // exec 复用 connect_direct 入池的连接
        let result = ssh
            .exec("s1", "printf ai-shell")
            .await
            .expect("exec 应成功");
        assert_eq!(result.stdout, "ai-shell", "stdout 应为命令输出");
        assert!(result.stderr.is_empty(), "stderr 应为空");
        assert_eq!(result.exit_code, Some(0), "退出码应为 0");

        // 空命令在建连/建通道前拒绝（复用已建连接，直接返回错误）
        let err = ssh.exec("s1", "  ").await.expect_err("空命令应报错");
        assert!(err.contains("命令不能为空"), "错误串不符: {err}");

        ssh.disconnect("s1").await;
        shutdown.shutdown("test done".into());
    };

    let (server_res, ()) = tokio::join!(running, test_body);
    server_res.expect("echo server 异常退出");
}

/// 服务器 AI 锁硬边界：锁定服务器的 AI 远程动作在任何网络请求前返回固定拒绝错误；
/// 同一服务器的用户手动 open_shell / open_sftp 路径不受影响。
#[tokio::test]
async fn locked_server_blocks_ai_remote_but_manual_paths_ok() {
    let socket = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("绑定 127.0.0.1:0 失败");
    let addr = socket.local_addr().expect("取监听地址失败");
    let config = Arc::new(russh::server::Config {
        keys: vec![
            russh::keys::PrivateKey::from_openssh(HOST_KEY_PEM.as_bytes())
                .expect("解析测试 host key 失败"),
        ],
        ..Default::default()
    });
    let mut server = EchoServer;
    let running = server.run_on_socket(config, &socket);
    let shutdown = running.handle();

    let test_body = async {
        let config_dir = std::env::temp_dir().join(format!(
            "aishell-ssh-lock-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let store = Arc::new(Store::new(config_dir).expect("Store::new 应成功"));
        // 服务器登记进 Store 并锁定（upsert_server None = 不触碰 keyring）
        let server = Server {
            id: "s-lock".to_string(),
            name: "锁定服务器".to_string(),
            host: addr.ip().to_string(),
            port: addr.port(),
            auth_type: AuthType::Password,
            username: "test".to_string(),
            key_path: String::new(),
            locked: true,
        };
        store
            .upsert_server(server.clone(), None)
            .expect("登记服务器应成功");
        let ssh = Arc::new(SshManager::new(Arc::clone(&store)));
        let actions = aishell_lib::ai_actions::AiActions::new(Arc::clone(&store), Arc::clone(&ssh));

        // AI 远程命令：锁检查先于任何网络请求（服务器从未被连接过，直接返回固定错误）
        let project_dir = std::env::temp_dir().join(format!(
            "aishell-ssh-lock-proj-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        std::fs::create_dir_all(&project_dir).expect("创建项目目录应成功");
        store
            .upsert_project(aishell_lib::store::Project {
                id: "p-lock".to_string(),
                name: "P".to_string(),
                path: Some(project_dir.to_string_lossy().into_owned()),
                server_ids: vec!["s-lock".to_string()],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: aishell_lib::store::AiMode::Yolo,
            })
            .expect("登记项目应成功");

        let err = actions
            .run_command("p-lock", "测试".to_string(), "printf hi".to_string(), "remote".to_string(), Some("s-lock".to_string()))
            .await
            .expect_err("锁定服务器应拒绝 AI 远程命令");
        assert!(
            err.contains("已锁定，AI 无权执行远程操作") && err.contains("锁定服务器"),
            "错误串不符: {err}"
        );
        // AI SFTP 上传 / 下载同样在连接前被拒
        let err = actions
            .sftp_upload("p-lock", "s-lock".to_string(), "a.txt".to_string(), "/tmp".to_string(), false)
            .await
            .expect_err("锁定服务器应拒绝 AI 上传");
        assert!(err.contains("已锁定，AI 无权执行远程操作"), "错误串不符: {err}");
        let err = actions
            .sftp_download("p-lock", "s-lock".to_string(), "/tmp/a.txt".to_string(), project_dir.to_string_lossy().into_owned())
            .await
            .expect_err("锁定服务器应拒绝 AI 下载");
        assert!(err.contains("已锁定，AI 无权执行远程操作"), "错误串不符: {err}");

        // 用户手动路径不受锁影响：connect_direct + open_shell / open_sftp 仍可连接
        ssh.connect_direct(server, Some("test"))
            .await
            .expect("锁定服务器的手动连接应成功");
        let mut channel = ssh
            .open_shell("s-lock", 80, 24)
            .await
            .expect("锁定服务器的手动 shell 应可用");
        channel
            .data(&b"echo hello\n"[..])
            .await
            .expect("向 channel 写数据应成功");
        let mut got = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        while tokio::time::Instant::now() < deadline && !got.contains("hello") {
            let msg = tokio::time::timeout(Duration::from_secs(5), channel.wait())
                .await
                .expect("等待回显超时");
            match msg {
                Some(ChannelMsg::Data { data }) => {
                    let bytes: &[u8] = &data;
                    got.push_str(&String::from_utf8_lossy(bytes));
                }
                Some(_) => {}
                None => break,
            }
        }
        assert!(got.contains("hello"), "手动 shell 回显缺失: {got:?}");
        let _sftp = ssh
            .open_sftp("s-lock")
            .await
            .expect("锁定服务器的手动 SFTP 应可用");
        // 解锁后 AI 远程命令恢复（同一连接池，无需重连）
        store.set_server_locked("s-lock", false).expect("解锁应成功");
        let result = actions
            .run_command("p-lock", "测试".to_string(), "printf ai-unlocked".to_string(), "remote".to_string(), Some("s-lock".to_string()))
            .await
            .expect("解锁后 AI 远程命令应恢复");
        assert_eq!(result.stdout, "ai-unlocked");

        ssh.disconnect("s-lock").await;
        shutdown.shutdown("test done".into());
    };

    let (server_res, ()) = tokio::join!(running, test_body);
    server_res.expect("echo server 异常退出");
}
