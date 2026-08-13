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
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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
        // ai_actions 远程 exec 统一以 `cd '<cwd>' && <cmd>` 包装：剥掉包装再匹配 printf
        let raw = cmd.as_ref();
        let cmd = strip_cd_wrapper(raw);
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

/// 剥掉 ai_actions 远程 exec 的 cd 包装（`cd '/root' && cmd`）；无包装原样返回。
fn strip_cd_wrapper(cmd: &str) -> &str {
    if let Some(rest) = cmd.strip_prefix("cd '") {
        if let Some(idx) = rest.find("' && ") {
            return &rest[idx + "' && ".len()..];
        }
    }
    cmd
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
            is_bastion: false,
            bastion_id: None,
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
            is_bastion: false,
            bastion_id: None,
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
            is_bastion: false,
            bastion_id: None,
        };
        store
            .upsert_server(server.clone(), None)
            .expect("登记服务器应成功");
        let ssh = Arc::new(SshManager::new(Arc::clone(&store)));
        let staging = Arc::new(aishell_lib::staging::RemoteStaging::new(
            std::env::temp_dir().join(format!("aishell-ssh-lock-staging-{}", std::process::id())),
            Arc::clone(&ssh),
            Arc::clone(&store),
        ));
        let actions = aishell_lib::ai_actions::AiActions::new(Arc::clone(&store), Arc::clone(&ssh), staging);

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
            .run_command(
                "p-lock",
                "sess-1",
                "测试".to_string(),
                "printf hi".to_string(),
                "remote".to_string(),
                Some("s-lock".to_string()),
                None,
                None,
                None,
            )
            .await
            .expect_err("锁定服务器应拒绝 AI 远程命令");
        assert!(
            err.contains("已锁定，AI 无权执行远程操作") && err.contains("锁定服务器"),
            "错误串不符: {err}"
        );
        // AI SFTP 上传 / 下载同样在连接前被拒
        let err = actions
            .sftp_upload("p-lock", "sess-1", "s-lock".to_string(), "a.txt".to_string(), "/tmp".to_string(), false, None)
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
            .run_command(
                "p-lock",
                "sess-1",
                "测试".to_string(),
                "printf ai-unlocked".to_string(),
                "remote".to_string(),
                Some("s-lock".to_string()),
                None,
                Some("/root".to_string()),
                None,
            )
            .await
            .expect("解锁后 AI 远程命令应恢复");
        assert_eq!(result.stdout, "ai-unlocked");

        ssh.disconnect("s-lock").await;
        shutdown.shutdown("test done".into());
    };

    let (server_res, ()) = tokio::join!(running, test_body);
    server_res.expect("echo server 异常退出");
}

/// 自动备份 + bounded 命令：快照失败（echo server 不实现 SFTP 文件操作）必须阻止执行。
/// 验证「影响分析/快照错误不得伪装成已备份」——快照失败时命令不得执行。
#[tokio::test]
async fn remote_run_command_blocks_when_snapshot_fails() {
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
        // 第一段：自动备份开启（默认）→ bounded 命令快照失败必须阻止执行
        let config_dir = std::env::temp_dir().join(format!(
            "aishell-ssh-snapshot-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let store = Arc::new(Store::new(config_dir).expect("Store::new 应成功"));
        let ssh = Arc::new(SshManager::new(Arc::clone(&store)));
        let staging = Arc::new(aishell_lib::staging::RemoteStaging::new(
            std::env::temp_dir().join(format!("aishell-ssh-snap-staging-{}", std::process::id())),
            Arc::clone(&ssh),
            Arc::clone(&store),
        ));
        let actions = aishell_lib::ai_actions::AiActions::new(Arc::clone(&store), Arc::clone(&ssh), staging);

        let server = Server {
            id: "s1".to_string(),
            name: "loopback".to_string(),
            host: addr.ip().to_string(),
            port: addr.port(),
            auth_type: AuthType::Password,
            username: "test".to_string(),
            key_path: String::new(),
            locked: false,
            is_bastion: false,
            bastion_id: None,
        };
        store.upsert_server(server.clone(), None).expect("登记服务器应成功");
        ssh.connect_direct(server, Some("test"))
            .await
            .expect("连接 + 密码认证应成功");

        let project_dir = std::env::temp_dir().join(format!("aishell-ssh-snap-proj-{}", std::process::id()));
        std::fs::create_dir_all(&project_dir).expect("创建项目目录应成功");
        store
            .upsert_project(aishell_lib::store::Project {
                id: "p-snap".to_string(),
                name: "P".to_string(),
                path: Some(project_dir.to_string_lossy().into_owned()),
                server_ids: vec!["s1".to_string()],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: aishell_lib::store::AiMode::Yolo,
            })
            .expect("登记项目应成功");

        // bounded 写入命令（echo x > /tmp/a.txt）：自动备份开启 → 快照失败 → 命令被阻止
        let err = actions
            .run_command(
                "p-snap",
                "sess-1",
                "测试".to_string(),
                "echo x > /tmp/a.txt".to_string(),
                "remote".to_string(),
                Some("s1".to_string()),
                None,
                Some("/root".to_string()),
                None,
            )
            .await
            .expect_err("快照失败应阻止命令执行");
        assert!(
            err.contains("快照") || err.contains("暂存") || err.contains("读取远端"),
            "错误应指向快照/远端读取失败: {err}"
        );
        ssh.disconnect("s1").await;

        // 第二段：关闭自动备份（预写 aishell.json，save_settings 是 pub(crate) 不可调用）
        // → 同一命令直接执行（echo server 剥 cd 包装后回显 printf 输出）
        let config_dir_off = std::env::temp_dir().join(format!(
            "aishell-ssh-snapshot-off-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        std::fs::create_dir_all(&config_dir_off).expect("创建配置目录应成功");
        let seed_config = serde_json::json!({
            "settings": {
                "workspaceDir": null,
                "llm": { "modelId": "", "baseUrl": "", "effort": "low" },
                "search": { "enabled": false },
                "theme": "dark",
                "autoSwitchAiWorkdir": true,
                "projectView": "card",
                "approvalMode": "smart",
                "autoBackupRemoteFiles": false,
            },
            "servers": [],
            "projects": [],
            "sessions": {},
            "projectFolders": [],
            "commandFolders": [],
            "uiExpanded": {},
            "sftpHistory": {},
            "sftpFavorites": {},
            "dbConnections": {},
            "seededSkillWorkspaces": [],
        });
        std::fs::write(
            config_dir_off.join("aishell.json"),
            serde_json::to_string(&seed_config).expect("序列化测试配置应成功"),
        )
        .expect("预写配置应成功");
        let store2 = Arc::new(Store::new(config_dir_off).expect("Store::new 应成功"));
        let ssh2 = Arc::new(SshManager::new(Arc::clone(&store2)));
        let staging2 = Arc::new(aishell_lib::staging::RemoteStaging::new(
            std::env::temp_dir().join(format!("aishell-ssh-snap-off-staging-{}", std::process::id())),
            Arc::clone(&ssh2),
            Arc::clone(&store2),
        ));
        let actions2 = aishell_lib::ai_actions::AiActions::new(Arc::clone(&store2), Arc::clone(&ssh2), staging2);
        let server2 = Server {
            id: "s2".to_string(),
            name: "loopback-off".to_string(),
            host: addr.ip().to_string(),
            port: addr.port(),
            auth_type: AuthType::Password,
            username: "test".to_string(),
            key_path: String::new(),
            locked: false,
            is_bastion: false,
            bastion_id: None,
        };
        store2.upsert_server(server2.clone(), None).expect("登记服务器应成功");
        ssh2.connect_direct(server2, Some("test"))
            .await
            .expect("连接 + 密码认证应成功");
        store2
            .upsert_project(aishell_lib::store::Project {
                id: "p-off".to_string(),
                name: "P2".to_string(),
                path: Some(project_dir.to_string_lossy().into_owned()),
                server_ids: vec!["s2".to_string()],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: aishell_lib::store::AiMode::Yolo,
            })
            .expect("登记项目应成功");
        let result = actions2
            .run_command(
                "p-off",
                "sess-1",
                "测试".to_string(),
                "printf ai-ok".to_string(),
                "remote".to_string(),
                Some("s2".to_string()),
                None,
                Some("/root".to_string()),
                None,
            )
            .await
            .expect("关闭自动备份后命令应直接执行");
        assert_eq!(result.stdout, "ai-ok");
        ssh2.disconnect("s2").await;

        shutdown.shutdown("test done".into());
    };

    let (server_res, ()) = tokio::join!(running, test_body);
    server_res.expect("echo server 异常退出");
}

/// 转发跳板：接受 direct-tcpip 通道并把字节双向桥接到目标 TCP（等价真实 sshd 的 -J 转发）。
/// 客户端 → 目标：`data()` 处理器写 TCP；目标 → 客户端：后台泵任务读 TCP 写 SSH channel。
#[derive(Clone, Default)]
struct ForwardBastion;

impl russh::server::Server for ForwardBastion {
    type Handler = ForwardSession;

    fn new_client(&mut self, _peer_addr: Option<SocketAddr>) -> Self::Handler {
        ForwardSession::default()
    }
}

/// channel → 已连通目标 TCP 的写半（读半由泵任务持有）。
#[derive(Default)]
struct ForwardSession {
    targets: std::collections::HashMap<ChannelId, tokio::net::tcp::OwnedWriteHalf>,
}

impl russh::server::Handler for ForwardSession {
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

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host_to_connect: &str,
        port_to_connect: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: russh::server::ChannelOpenHandle,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let id = channel.id();
        // 连不通被转发目标 → 拒通道（客户端拿到 Connect failed 而非挂起）
        let stream =
            match tokio::net::TcpStream::connect((host_to_connect, port_to_connect as u16)).await {
                Ok(s) => s,
                Err(e) => {
                    reply
                        .reject(russh::ChannelOpenFailure::Other {
                            code: 5,
                            reason: format!("forward connect failed: {e}"),
                        })
                        .await;
                    return Ok(());
                }
            };
        reply.accept().await;
        let (mut read, write) = stream.into_split();
        self.targets.insert(id, write);
        // 泵：目标 TCP → SSH channel；EOF/出错时关通道
        let handle = session.handle();
        tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            loop {
                match read.read(&mut buf).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if handle.data(id, buf[..n].to_vec()).await.is_err() {
                            break;
                        }
                    }
                }
            }
            let _ = handle.eof(id).await;
            let _ = handle.close(id).await;
        });
        Ok(())
    }

    /// 客户端 → 目标：把数据写到对应 channel 的 TCP 写半
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        if let Some(w) = self.targets.get_mut(&channel) {
            let _ = w.write_all(data).await;
        }
        Ok(())
    }
}

/// 跳板端到端集成测试：目标主机（echo server）经堡垒机（ForwardBastion 转发 direct-tcpip）
/// 完成 SSH 握手、认证与 exec 往返。走 `get_or_connect_with_password`（doc hidden 测试接缝，
/// 两段认证都用覆盖密码，不触碰真实 keyring）。断言：
/// - 隧道打通后目标 exec 往返正常，连接按目标 serverId 入池可复用；
/// - 断开目标后重建隧道成功（堡垒机连接仍在池中可复用）。
#[tokio::test]
async fn jump_target_exec_roundtrip_via_bastion() {
    // 目标机：echo server（隧道的尽头）
    let target_socket = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("绑定目标机监听失败");
    let target_addr = target_socket.local_addr().expect("取目标机地址失败");
    let config = Arc::new(russh::server::Config {
        keys: vec![
            russh::keys::PrivateKey::from_openssh(HOST_KEY_PEM.as_bytes())
                .expect("解析测试 host key 失败"),
        ],
        ..Default::default()
    });
    let mut target_server = EchoServer;
    let target_running = target_server.run_on_socket(Arc::clone(&config), &target_socket);
    let target_shutdown = target_running.handle();

    // 堡垒机：转发跳板
    let bastion_socket = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("绑定堡垒机监听失败");
    let bastion_addr = bastion_socket.local_addr().expect("取堡垒机地址失败");
    let mut bastion_server = ForwardBastion;
    let bastion_running = bastion_server.run_on_socket(config, &bastion_socket);
    let bastion_shutdown = bastion_running.handle();

    let test_body = async {
        let config_dir = std::env::temp_dir().join(format!(
            "aishell-ssh-jump-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis()
        ));
        let store = Arc::new(Store::new(config_dir).expect("Store::new 应成功"));
        let ssh = Arc::new(SshManager::new(Arc::clone(&store)));

        // 堡垒机 + 目标主机登记进 Store（走正式 upsert_server 校验；None = 不触碰 keyring）
        store
            .upsert_server(
                Server {
                    id: "bastion".to_string(),
                    name: "测试堡垒机".to_string(),
                    host: bastion_addr.ip().to_string(),
                    port: bastion_addr.port(),
                    auth_type: AuthType::Password,
                    username: "test".to_string(),
                    key_path: String::new(),
                    locked: false,
                    is_bastion: true,
                    bastion_id: None,
                },
                None,
            )
            .expect("登记堡垒机应成功");
        store
            .upsert_server(
                Server {
                    id: "target".to_string(),
                    name: "目标机".to_string(),
                    host: target_addr.ip().to_string(),
                    port: target_addr.port(),
                    auth_type: AuthType::Password,
                    username: "test".to_string(),
                    key_path: String::new(),
                    locked: false,
                    is_bastion: false,
                    bastion_id: Some("bastion".to_string()),
                },
                None,
            )
            .expect("登记目标主机应成功");

        // 经跳板连接目标主机（两段认证都用覆盖密码 "test"）
        ssh.get_or_connect_with_password("target", "test")
            .await
            .expect("经堡垒机连接目标主机应成功");

        // 复用入池连接 exec
        let exec = ssh
            .exec("target", "printf jump-ok")
            .await
            .expect("经跳板 exec 应成功");
        assert_eq!(exec.stdout, "jump-ok", "stdout 应为目标机命令输出");
        assert_eq!(exec.exit_code, Some(0), "退出码应为 0");

        // open_sftp 同样经跳板（目标 echo server 回复 SFTP 版本握手）
        let _sftp = ssh
            .open_sftp("target")
            .await
            .expect("经跳板 open_sftp 应成功");

        // 断开目标主机后，堡垒机连接仍在池中（跳板复用）；再连目标会重建隧道
        ssh.disconnect("target").await;
        ssh.get_or_connect_with_password("target", "test")
            .await
            .expect("跳板断开后重建应成功");

        ssh.disconnect("target").await;
        ssh.disconnect("bastion").await;
        target_shutdown.shutdown("target done".into());
        bastion_shutdown.shutdown("bastion done".into());
    };

    let (t_res, b_res, ()) = tokio::join!(target_running, bastion_running, test_body);
    t_res.expect("目标 echo server 异常退出");
    b_res.expect("堡垒机转发 server 异常退出");
}
