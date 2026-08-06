//! 终端管理器：本地 shell（portable-pty；Windows 起 Git Bash/ConPTY，macOS/Linux 起 $SHELL/zsh）
//! 与 SSH shell 同构接入。
//! 契约（与 src/api.ts 严格对齐）：
//! - 命令 `term_create(id, kind, server_id, cwd)` / `term_input(id, data)` /
//!   `term_resize(id, cols, rows)` / `term_close(id)`；
//! - 事件 `term:data:<id>` payload `{data}`（UTF-8 lossy）、`term:exit:<id>` payload `{code}`。
//!
//! SSH 分支复用 `ssh::SshManager::open_shell` 返回的 channel（连接复用由 SshManager 管理）。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
// 仅 Windows 的 Git Bash 探测（where.exe）使用；macOS/Linux 走 $SHELL，用不到
#[cfg(windows)]
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use russh::{ChannelMsg, ChannelWriteHalf};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ssh::SshManager;

/* ---------------- 事件 payload（字段名与 src/api.ts 一一对应） ---------------- */

#[derive(Clone, Serialize)]
struct TermDataPayload {
    data: String,
}

#[derive(Clone, Serialize)]
struct TermExitPayload {
    code: Option<i32>,
}

/* ---------------- 终端后端 ---------------- */

/// 本地 PTY 或 SSH channel 的统一后端。
/// 本地：writer 写 PTY、master 调 resize、child 由 wait 线程收尸、killer 供 close 杀进程
/// （与 wait 线程分锁，避免 close 与 wait 互相阻塞）。
/// SSH：russh channel 拆分为读写两半，写半句柄可跨任务共享（方法均取 &self）。
enum TermBackend {
    Local {
        writer: Arc<Mutex<Box<dyn Write + Send>>>,
        master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
        killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    },
    Ssh {
        write_half: Arc<ChannelWriteHalf<russh::client::Msg>>,
    },
}

/// 单个终端句柄（id -> handle 存放于 TermManager）。
pub struct TermHandle {
    backend: TermBackend,
    closed: AtomicBool,
}

impl TermHandle {
    /// 向终端写入数据（本地 PTY / SSH channel 统一入口）。
    async fn write(&self, data: &str) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("终端已关闭".to_string());
        }
        match &self.backend {
            TermBackend::Local { writer, .. } => {
                let mut w = writer.lock().map_err(|e| e.to_string())?;
                w.write_all(data.as_bytes())
                    .map_err(|e| format!("PTY 写入失败: {e}"))?;
                w.flush().map_err(|e| format!("PTY 写入失败: {e}"))
            }
            TermBackend::Ssh { write_half } => write_half
                .data_bytes(data.to_string())
                .await
                .map_err(|e| format!("SSH 通道写入失败: {e}")),
        }
    }

    /// 调整终端尺寸（本地 ConPTY resize / SSH window-change）。
    async fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err("终端已关闭".to_string());
        }
        match &self.backend {
            TermBackend::Local { master, .. } => master
                .lock()
                .map_err(|e| e.to_string())?
                .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
                .map_err(|e| format!("PTY 尺寸调整失败: {e}")),
            TermBackend::Ssh { write_half } => write_half
                .window_change(cols as u32, rows as u32, 0, 0)
                .await
                .map_err(|e| format!("SSH 窗口尺寸调整失败: {e}")),
        }
    }

    /// 关闭终端（幂等）：本地 kill 子进程 / SSH 发送 channel close。
    /// 幂等由调用方保证（TermManager::close 先移出 map，且 closed 标记防重入）。
    async fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        match &self.backend {
            TermBackend::Local { killer, .. } => {
                if let Ok(mut k) = killer.lock() {
                    let _ = k.kill();
                }
            }
            TermBackend::Ssh { write_half } => {
                let _ = write_half.close().await;
            }
        }
    }
}

/* ---------------- 终端管理器 ---------------- */

/// 统一终端管理器：id -> Arc<TermHandle>。本地与 SSH 对前端同构。
pub struct TermManager {
    map: Mutex<HashMap<String, Arc<TermHandle>>>,
    ssh: Arc<SshManager>,
}

impl TermManager {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        TermManager {
            map: Mutex::new(HashMap::new()),
            ssh,
        }
    }

    /// 创建终端：kind = "local" | "ssh"。已存在同 id 时幂等返回。
    pub async fn create(
        self: &Arc<Self>,
        app: AppHandle,
        id: String,
        kind: String,
        server_id: Option<String>,
        cwd: Option<String>,
    ) -> Result<(), String> {
        {
            let map = self.map.lock().map_err(|e| e.to_string())?;
            if map.contains_key(&id) {
                return Ok(());
            }
        }
        match kind.as_str() {
            "local" => self.create_local(app, id, cwd),
            "ssh" => {
                let sid = server_id.ok_or_else(|| "SSH 终端缺少 serverId".to_string())?;
                self.create_ssh(app, id, &sid, cwd).await
            }
            other => Err(format!("未知终端类型: {other}")),
        }
    }

    /// 本地分支：portable-pty 起本地 shell（--login -i），cwd 缺省用用户 home。
    fn create_local(self: &Arc<Self>, app: AppHandle, id: String, cwd: Option<String>) -> Result<(), String> {
        let shell = find_shell().ok_or_else(shell_missing_msg)?;

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| format!("PTY 创建失败: {e}"))?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.args(["--login", "-i"]);
        let dir = match cwd.as_deref() {
            Some(c) if !c.trim().is_empty() => PathBuf::from(c),
            _ => app.path().home_dir().map_err(|e| e.to_string())?,
        };
        if dir.is_dir() {
            cmd.cwd(&dir);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("启动本地 shell 失败: {e}"))?;
        let killer = child.clone_killer();
        let reader = pair.master.try_clone_reader().ok();
        let writer = Arc::new(Mutex::new(
            pair.master.take_writer().map_err(|e| format!("获取 PTY 写入端失败: {e}"))?,
        ));
        let master = Arc::new(Mutex::new(pair.master));
        let child = Arc::new(Mutex::new(child));
        let killer = Arc::new(Mutex::new(killer));

        self.map.lock().map_err(|e| e.to_string())?.insert(
            id.clone(),
            Arc::new(TermHandle {
                backend: TermBackend::Local {
                    writer,
                    master,
                    killer,
                },
                closed: AtomicBool::new(false),
            }),
        );

        // 读线程：PTY 输出 → term:data:<id>
        if let Some(mut reader) = reader {
            let app = app.clone();
            let id2 = id.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                            let _ = app.emit(&format!("term:data:{id2}"), TermDataPayload { data });
                        }
                    }
                }
            });
        }

        // wait 线程：子进程退出 → 清理 map + term:exit:<id>
        let mgr = Arc::clone(self);
        let app = app.clone();
        let id2 = id.clone();
        std::thread::spawn(move || {
            let code = {
                // wait 线程独占该锁直到子进程退出；poison 时取内部值继续（无 unwrap）
                let mut child = child.lock().unwrap_or_else(|e| e.into_inner());
                match child.wait() {
                    Ok(st) => Some(st.exit_code() as i32),
                    Err(_) => None,
                }
            };
            mgr.map.lock().ok().and_then(|mut m| m.remove(&id2));
            let _ = app.emit(&format!("term:exit:{id2}"), TermExitPayload { code });
        });

        Ok(())
    }

    /// SSH 分支：open_shell 开 channel → split 成读写两半；读循环发 term:data/term:exit，
    /// 写半句柄共享给 term_input / term_resize / term_close。
    async fn create_ssh(
        self: &Arc<Self>,
        app: AppHandle,
        id: String,
        server_id: &str,
        cwd: Option<String>,
    ) -> Result<(), String> {
        let channel = self.ssh.open_shell(server_id, 80, 24).await?;
        let (read_half, write_half) = channel.split();
        let write_half = Arc::new(write_half);

        // 迷你终端等场景要求登录后直接落到指定目录：shell 就绪前写入 PTY 缓冲即可
        if let Some(dir) = cwd.as_deref().filter(|d| !d.trim().is_empty()) {
            let quoted = format!("'{}'", dir.replace('\'', "'\\''"));
            let _ = write_half
                .data_bytes(format!("cd {quoted}\r"))
                .await;
        }

        self.map.lock().map_err(|e| e.to_string())?.insert(
            id.clone(),
            Arc::new(TermHandle {
                backend: TermBackend::Ssh {
                    write_half: Arc::clone(&write_half),
                },
                closed: AtomicBool::new(false),
            }),
        );

        let mgr = Arc::clone(self);
        let app = app.clone();
        let id2 = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut read_half = read_half;
            let mut code: Option<i32> = None;
            loop {
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        let data = String::from_utf8_lossy(&data).into_owned();
                        let _ = app.emit(&format!("term:data:{id2}"), TermDataPayload { data });
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        code = Some(exit_status as i32);
                        break;
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close | ChannelMsg::ExitSignal { .. }) => {
                        break;
                    }
                    Some(_) => {}
                    None => break,
                }
            }
            mgr.map.lock().ok().and_then(|mut m| m.remove(&id2));
            let _ = app.emit(&format!("term:exit:{id2}"), TermExitPayload { code });
        });

        Ok(())
    }

    fn handle(&self, id: &str) -> Result<Arc<TermHandle>, String> {
        let map = self.map.lock().map_err(|e| e.to_string())?;
        map.get(id).cloned().ok_or_else(|| format!("终端不存在: {id}"))
    }

    pub async fn input(&self, id: &str, data: &str) -> Result<(), String> {
        self.handle(id)?.write(data).await
    }

    pub async fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        self.handle(id)?.resize(cols, rows).await
    }

    /// 幂等：map 中不存在即视为已关闭。
    pub async fn close(&self, id: &str) -> Result<(), String> {
        let handle = {
            let mut map = self.map.lock().map_err(|e| e.to_string())?;
            map.remove(id)
        };
        if let Some(h) = handle {
            h.close().await;
        }
        Ok(())
    }
}

/* ---------------- 本地 shell 探测 ---------------- */

/// Windows：探测 Git Bash。顺序：env AISHELL_GIT_BASH → %PROGRAMFILES%\Git\bin\bash.exe →
/// %PROGRAMFILES(X86)%\Git\bin\bash.exe → `where.exe bash` 输出中首个含 "Git" 的行
/// （排除 System32 的 WSL bash）。pub(crate)：ai_actions 本地命令复用。
#[cfg(windows)]
pub(crate) fn find_shell() -> Option<String> {
    if let Some(p) = std::env::var("AISHELL_GIT_BASH").ok().map(|s| s.trim().to_string()) {
        if !p.is_empty() && PathBuf::from(&p).is_file() {
            return Some(p);
        }
    }
    for var in ["PROGRAMFILES", "PROGRAMFILES(X86)"] {
        if let Ok(pf) = std::env::var(var) {
            let p = format!(r"{}\Git\bin\bash.exe", pf.trim_end_matches(|c| ['\\', '/'].contains(&c)));
            if PathBuf::from(&p).is_file() {
                return Some(p);
            }
        }
    }
    let out = Command::new("where.exe").arg("bash").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .map(str::trim)
        .find(|line| {
            let lower = line.to_lowercase();
            !line.is_empty() && lower.contains("git") && !lower.contains("system32")
        })
        .map(str::to_string)
}

/// macOS/Linux：登录 shell。顺序：$SHELL → /bin/zsh → /bin/bash → /usr/bin/zsh → /usr/bin/bash。
/// macOS 默认 zsh（/bin/zsh 恒在），Linux 发行版 /bin/bash 恒在，$SHELL 覆盖绝大多数场景。
#[cfg(not(windows))]
pub(crate) fn find_shell() -> Option<String> {
    if let Some(p) = std::env::var("SHELL").ok().map(|s| s.trim().to_string()) {
        if !p.is_empty() && PathBuf::from(&p).is_file() {
            return Some(p);
        }
    }
    ["/bin/zsh", "/bin/bash", "/usr/bin/zsh", "/usr/bin/bash"]
        .into_iter()
        .find(|p| PathBuf::from(p).is_file())
        .map(str::to_string)
}

/// find_shell 未命中时的用户可读错误（create_local / ai_actions 两调用点统一文案）。
#[cfg(windows)]
pub(crate) fn shell_missing_msg() -> String {
    "未找到 Git Bash，请安装 Git for Windows 或设置 AISHELL_GIT_BASH".to_string()
}

/// find_shell 未命中时的用户可读错误（create_local / ai_actions 两调用点统一文案）。
#[cfg(not(windows))]
pub(crate) fn shell_missing_msg() -> String {
    "未找到可用 shell：$SHELL 未设置且 /bin/zsh、/bin/bash 均不存在".to_string()
}

/* ---------------- Tauri 命令（注册由主 agent 集成） ---------------- */

#[tauri::command]
pub async fn term_create(
    manager: State<'_, Arc<TermManager>>,
    app: AppHandle,
    id: String,
    kind: String,
    server_id: Option<String>,
    cwd: Option<String>,
) -> Result<(), String> {
    manager.create(app, id, kind, server_id, cwd).await
}

#[tauri::command]
pub async fn term_input(
    manager: State<'_, Arc<TermManager>>,
    id: String,
    data: String,
) -> Result<(), String> {
    manager.input(&id, &data).await
}

#[tauri::command]
pub async fn term_resize(
    manager: State<'_, Arc<TermManager>>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    manager.resize(&id, cols, rows).await
}

#[tauri::command]
pub async fn term_close(
    manager: State<'_, Arc<TermManager>>,
    id: String,
) -> Result<(), String> {
    manager.close(&id).await
}
