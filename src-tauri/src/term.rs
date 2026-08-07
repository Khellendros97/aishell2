//! 终端管理器：本地 shell（portable-pty；Windows 起 Git Bash/ConPTY，macOS/Linux 起 $SHELL/zsh）
//! 与 SSH shell 同构接入。
//! 契约（与 src/api.ts 严格对齐）：
//! - 命令 `term_create(id, kind, server_id, cwd)` / `term_input(id, data)` /
//!   `term_resize(id, cols, rows)` / `term_close(id)` / `term_record_start(id, path, header)` /
//!   `term_record_stop(id, footer)`；
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

/// Debug 面板事件 payload（前端 src/debug.ts 订阅 `debug:log`）。
#[derive(Clone, Serialize)]
struct DebugLogPayload {
    line: String,
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

/* ---------------- 诊断：SSH 通道收发元信息落盘（只记时间戳/方向/长度,不记内容） ---------------- */
/// 默认开启,便于抓取现场卡死(如 SSH vi 无响应)的事后证据;AISHELL_TERM_LOG=0 显式关闭,
/// AISHELL_TERM_LOG=<path> 改路径。体积极小(每条消息一行),启动时超 2MB 截断重建。
fn diag_tx() -> Option<&'static std::sync::mpsc::Sender<String>> {
    use std::sync::LazyLock;
    static TX: LazyLock<Option<std::sync::mpsc::Sender<String>>> = LazyLock::new(|| {
        let env = std::env::var("AISHELL_TERM_LOG").ok();
        if env.as_deref() == Some("0") {
            return None;
        }
        let path = match env.filter(|s| !s.is_empty()) {
            Some(p) => p,
            None => {
                #[cfg(windows)]
                let dir = std::env::var("APPDATA")
                    .map(|a| format!(r"{a}\com.aishell.app\logs"))
                    .unwrap_or_else(|_| "logs".to_string());
                #[cfg(not(windows))]
                let dir = std::env::var("HOME")
                    .map(|h| format!("{h}/Library/Application Support/com.aishell.app/logs"))
                    .unwrap_or_else(|_| "logs".to_string());
                let _ = std::fs::create_dir_all(&dir);
                std::path::Path::new(&dir).join("term-diag.log").to_string_lossy().into_owned()
            }
        };
        if std::fs::metadata(&path).map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(false) {
            let _ = std::fs::remove_file(&path);
        }
        let f = std::fs::OpenOptions::new().create(true).append(true).open(path).ok()?;
        let (tx, rx) = std::sync::mpsc::channel::<String>();
        std::thread::spawn(move || {
            use std::io::BufWriter;
            let mut w = BufWriter::new(f);
            for line in rx {
                let _ = writeln!(w, "{line}");
                let _ = w.flush();
            }
        });
        Some(tx)
    });
    TX.as_ref()
}

/// Debug 面板事件出口：lib.rs setup 注入 AppHandle，diag 行同步广播 `debug:log`。
static DEBUG_APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn set_debug_app(app: AppHandle) {
    let _ = DEBUG_APP.set(app);
}

/// 追加一行带毫秒时间戳的诊断日志；失败静默（绝不影响终端主路径）。
/// 同时落盘（diag_tx）与广播 `debug:log`（前端 Debug 面板实时流）。
/// pub(crate)：gitinstall（Git Bash 首启安装引导）复用同一事件流。
pub(crate) fn diag(msg: &str) {
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = format!("{ms} {msg}");
    if let Some(tx) = diag_tx() {
        let _ = tx.send(line.clone());
    }
    if let Some(app) = DEBUG_APP.get() {
        let _ = app.emit("debug:log", DebugLogPayload { line });
    }
}

/// 导出 Debug 面板日志到用户选定路径（前端 save 对话框拿路径后调此命令写盘）。
#[tauri::command]
pub fn debug_export(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("导出日志失败: {e}"))
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
            TermBackend::Ssh { write_half } => {
                let r = write_half.data_bytes(data.to_string()).await;
                match &r {
                    Ok(()) => diag(&format!("send ok len={}", data.len())),
                    Err(e) => diag(&format!("send err len={} err={e}", data.len())),
                }
                r.map_err(|e| format!("SSH 通道写入失败: {e}"))
            }
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

/* ---------------- 终端录制（tee 到 项目/.aishell/record/服务器-日期时间.log） ---------------- */

/// ANSI 转义剥除状态机（跨分片：CSI/OSC/ESC 序列可能断开在两个 chunk 边界，
/// 状态留在 Recorder 内持续递进）。剥离 CSI(颜色/光标/模式如 ?2004h)、
/// OSC(标题等,BEL 或 ST 收尾)、字符集选择(ESC ( X)与单字符转义,
/// 只留可打印文本与 \r\n\t 控制符。
#[derive(Debug, Default)]
enum AnsiState {
    #[default]
    Normal,
    /// 已见 ESC,等待判定序列类型
    Esc,
    /// CSI 体内,等终止字节 0x40..=0x7E
    Csi,
    /// OSC 体内,等 BEL 或 ST(ESC \)
    Osc,
    /// 字符集选择 ESC ( X / ESC ) X,再丢一个字节
    Charset,
}

impl AnsiState {
    /// 喂入一段输出,返回剥除转义后的明文字节。
    fn strip(&mut self, data: &str) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len());
        for &b in data.as_bytes() {
            match self {
                AnsiState::Normal => {
                    if b == 0x1b {
                        *self = AnsiState::Esc;
                    } else {
                        out.push(b);
                    }
                }
                AnsiState::Esc => match b {
                    b'[' => *self = AnsiState::Csi,
                    b']' => *self = AnsiState::Osc,
                    b'(' | b')' => *self = AnsiState::Charset,
                    0x1b => { /* 连续 ESC:保持 Esc */ }
                    _ => *self = AnsiState::Normal, // 单字符转义(含 ST 的 \):整体丢弃
                },
                AnsiState::Csi => {
                    if (0x40..=0x7e).contains(&b) {
                        *self = AnsiState::Normal;
                    } else if b == 0x1b {
                        *self = AnsiState::Esc;
                    }
                }
                AnsiState::Osc => {
                    if b == 0x07 {
                        *self = AnsiState::Normal;
                    } else if b == 0x1b {
                        *self = AnsiState::Esc;
                    }
                }
                AnsiState::Charset => *self = AnsiState::Normal,
            }
        }
        out
    }
}

/// 终端输出录制器：把 tee 到的输出流(剥除 ANSI 转义后的明文)落盘。
/// 写失败一律静默（绝不影响终端主路径）；drop 时 BufWriter 兜底 flush。
/// 前端负责全部呈现层格式（文件名/开始结束时间戳），本结构只建文件、写头尾、收尾。
#[derive(Debug)]
struct Recorder {
    w: std::io::BufWriter<std::fs::File>,
    path: PathBuf,
    strip: AnsiState,
}

impl Recorder {
    /// 建父目录、建文件、写 header 并 flush。重复 create 同一路径报错（不覆盖已有录制）。
    fn create(path: PathBuf, header: &str) -> Result<Recorder, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建录制目录失败: {e}"))?;
        }
        let f = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::AlreadyExists {
                    "录制文件已存在，请稍后重试".to_string()
                } else {
                    format!("创建录制文件失败: {e}")
                }
            })?;
        let mut w = std::io::BufWriter::new(f);
        writeln!(w, "{header}").map_err(|e| format!("写入录制文件失败: {e}"))?;
        w.flush().map_err(|e| format!("写入录制文件失败: {e}"))?;
        Ok(Recorder {
            w,
            path,
            strip: AnsiState::default(),
        })
    }

    /// tee 一段终端输出（剥除 ANSI 转义后落盘）；失败静默。
    fn write(&mut self, data: &str) {
        let plain = self.strip.strip(data);
        let _ = self.w.write_all(&plain);
    }

    /// 收尾：写 \n+footer+\n 并 flush，返回文件路径（drop 兜底落盘）。
    fn finish(mut self, footer: &str) -> PathBuf {
        let _ = write!(self.w, "\n{footer}\n");
        let _ = self.w.flush();
        self.path
    }
}

/* ---------------- 终端管理器 ---------------- */

/// 统一终端管理器：id -> Arc<TermHandle>。本地与 SSH 对前端同构。
pub struct TermManager {
    map: Mutex<HashMap<String, Arc<TermHandle>>>,
    /// 录制器按 tab id 挂 manager：重连后新读任务继续 tee，不随 TermHandle 替换丢失。
    records: Mutex<HashMap<String, Recorder>>,
    ssh: Arc<SshManager>,
}

impl TermManager {
    pub fn new(ssh: Arc<SshManager>) -> Self {
        TermManager {
            map: Mutex::new(HashMap::new()),
            records: Mutex::new(HashMap::new()),
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

        let handle = Arc::new(TermHandle {
            backend: TermBackend::Local {
                writer,
                master,
                killer,
            },
            closed: AtomicBool::new(false),
        });
        self.map
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), Arc::clone(&handle));

        // 读线程：PTY 输出 → term:data:<id> + 录制 tee
        if let Some(mut reader) = reader {
            let app = app.clone();
            let mgr = Arc::clone(self);
            let id2 = id.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let data = String::from_utf8_lossy(&buf[..n]).into_owned();
                            mgr.tee_record(&id2, &data);
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
            // 同 id 重连后旧 wait 线程的迟到清理不得误删新句柄（见 SSH 分支同型守卫）
            mgr.map.lock().ok().and_then(|mut m| {
                if m.get(&id2).is_some_and(|h| Arc::ptr_eq(h, &handle)) {
                    m.remove(&id2)
                } else {
                    None
                }
            });
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

        let handle = Arc::new(TermHandle {
            backend: TermBackend::Ssh {
                write_half: Arc::clone(&write_half),
            },
            closed: AtomicBool::new(false),
        });
        self.map
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), Arc::clone(&handle));

        let mgr = Arc::clone(self);
        let app = app.clone();
        let id2 = id.clone();
        tauri::async_runtime::spawn(async move {
            let mut read_half = read_half;
            let mut code: Option<i32> = None;
            diag(&format!("read-task start id={id2}"));
            loop {
                match read_half.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        diag(&format!("recv id={id2} data len={}", data.len()));
                        let data = String::from_utf8_lossy(&data).into_owned();
                        mgr.tee_record(&id2, &data);
                        let r = app.emit(&format!("term:data:{id2}"), TermDataPayload { data });
                        if let Err(e) = r {
                            diag(&format!("emit-err id={id2} err={e}"));
                        }
                    }
                    Some(ChannelMsg::ExitStatus { exit_status }) => {
                        diag(&format!("recv id={id2} exit-status={exit_status}"));
                        code = Some(exit_status as i32);
                        break;
                    }
                    Some(ChannelMsg::Eof | ChannelMsg::Close | ChannelMsg::ExitSignal { .. }) => {
                        diag(&format!("recv id={id2} eof/close/exit-signal"));
                        break;
                    }
                    Some(_) => {}
                    None => {
                        diag(&format!("recv id={id2} none(channel 关闭)"));
                        break;
                    }
                }
            }
            // 仅当 map 里仍是本句柄才移除：同 id 重连后旧读任务的迟到清理不得误删新句柄
            mgr.map.lock().ok().and_then(|mut m| {
                if m.get(&id2).is_some_and(|h| Arc::ptr_eq(h, &handle)) {
                    m.remove(&id2)
                } else {
                    None
                }
            });
            let r = app.emit(&format!("term:exit:{id2}"), TermExitPayload { code });
            diag(&format!("read-task end id={id2} emit-exit={r:?}"));
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
        // 防御：前端忘停录制时在此移除 recorder（BufWriter Drop 兜底落盘，日志缺结束行）
        if let Ok(mut records) = self.records.lock() {
            records.remove(id);
        }
        Ok(())
    }

    /// 录制 tee：把一段终端输出追加到该终端的录制文件；未在录制 / 写失败均静默。
    fn tee_record(&self, id: &str, data: &str) {
        if let Ok(mut records) = self.records.lock() {
            if let Some(rec) = records.get_mut(id) {
                rec.write(data);
            }
        }
    }

    /// 开始录制：终端必须存在且未在录制。
    pub fn record_start(&self, id: &str, path: &str, header: &str) -> Result<(), String> {
        let map = self.map.lock().map_err(|e| e.to_string())?;
        if !map.contains_key(id) {
            return Err("终端不存在或已关闭".to_string());
        }
        let mut records = self.records.lock().map_err(|e| e.to_string())?;
        if records.contains_key(id) {
            return Err("该终端正在录制中".to_string());
        }
        records.insert(id.to_string(), Recorder::create(PathBuf::from(path), header)?);
        Ok(())
    }

    /// 停止录制：写 footer 收尾并返回文件路径；未在录制返回 None。
    pub fn record_stop(&self, id: &str, footer: &str) -> Result<Option<String>, String> {
        let mut records = self.records.lock().map_err(|e| e.to_string())?;
        Ok(records
            .remove(id)
            .map(|rec| rec.finish(footer).to_string_lossy().into_owned()))
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

/// 开始录制：终端不存在报「终端不存在或已关闭」，已在录制报「该终端正在录制中」。
#[tauri::command]
pub async fn term_record_start(
    manager: State<'_, Arc<TermManager>>,
    id: String,
    path: String,
    header: String,
) -> Result<(), String> {
    manager.record_start(&id, &path, &header)
}

/// 停止录制：写 footer 收尾，返回录制文件路径；未在录制返回 None。
#[tauri::command]
pub async fn term_record_stop(
    manager: State<'_, Arc<TermManager>>,
    id: String,
    footer: String,
) -> Result<Option<String>, String> {
    manager.record_stop(&id, &footer)
}

/* ---------------- 单测：Recorder 内容与覆盖语义（temp_dir，不碰真实终端） ---------------- */

#[cfg(test)]
mod tests {
    use super::Recorder;
    use std::io::Read;

    fn tmp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("aishell-record-test-{tag}-{}", std::process::id()))
    }

    /// create → write → finish 的完整内容断言：header + 原始输出 + footer 齐全。
    #[test]
    fn recorder_roundtrip_content() {
        let dir = tmp_dir("roundtrip");
        let path = dir.join("测试服务器-20260807-120000.log");
        let mut rec = Recorder::create(path.clone(), "===== 录制开始 2026-08-07 12:00:00 =====")
            .expect("首次创建应成功");
        rec.write("$ echo hi\r\nhi\r\n");
        rec.write("$ ");
        let got = rec.finish("===== 录制结束 2026-08-07 12:05:00 =====");
        assert_eq!(got, path, "finish 应返回录制文件路径");

        let mut content = String::new();
        std::fs::File::open(&path)
            .expect("录制文件应存在")
            .read_to_string(&mut content)
            .expect("读录制文件");
        assert_eq!(
            content,
            "===== 录制开始 2026-08-07 12:00:00 =====\n$ echo hi\r\nhi\r\n$ \n===== 录制结束 2026-08-07 12:05:00 =====\n"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 重复 create 同一路径：报错而非覆盖（避免同名录制静默丢数据，语义明确）。
    #[test]
    fn recorder_create_duplicate_is_error() {
        let dir = tmp_dir("duplicate");
        let path = dir.join("dup.log");
        assert!(Recorder::create(path.clone(), "h1").is_ok(), "首次创建应成功");
        let err = Recorder::create(path.clone(), "h2").expect_err("重复 create 应报错");
        assert!(!err.is_empty(), "错误文案不应为空");
        // 原文件内容不受第二次 create 影响
        let mut content = String::new();
        std::fs::File::open(&path)
            .expect("录制文件应存在")
            .read_to_string(&mut content)
            .expect("读录制文件");
        assert_eq!(content, "h1\n");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ANSI 剥除:CSI(颜色/光标/括号粘贴 ?2004h)、OSC(BEL/ST 收尾)、字符集选择
    /// 与单字符转义全部剥除,明文与 \r\n 保留;CSI 跨分片断开也能正确接续。
    #[test]
    fn ansi_strip_sequences() {
        use super::AnsiState;
        let mut s = AnsiState::default();
        // CSI 被两个 chunk 边界断开:ESC 在上一片末尾、[32m 在下一片开头
        let p1 = s.strip("$ ls \u{1b}");
        let p2 = s.strip("[32mgreen\u{1b}[0m normal\r\n");
        assert_eq!(String::from_utf8(p1).unwrap(), "$ ls ");
        assert_eq!(String::from_utf8(p2).unwrap(), "green normal\r\n");
        // 括号粘贴模式 + OSC 标题(BEL 与 ST 两种收尾) + 字符集选择 + 单字符转义
        let p3 = s.strip("\u{1b}[?2004h\u{1b}]0;标题\u{7}\u{1b}]8;;https://x\u{1b}\\\u{1b}(0\u{1b}ctext");
        assert_eq!(String::from_utf8(p3).unwrap(), "text");
        // OSC 跨分片
        let p4 = s.strip("\u{1b}]0;win");
        let p5 = s.strip("dow\u{7}done");
        assert_eq!(String::from_utf8(p4).unwrap(), "");
        assert_eq!(String::from_utf8(p5).unwrap(), "done");
    }
}
