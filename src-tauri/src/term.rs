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
/// 默认开启,便于抓取现场卡死(如 SSH vi 无响应)的事后证据;AISHELL_TERM_LOG=0 显式关闭
/// (落盘与 `debug:log` 事件一并静默,见 diag),AISHELL_TERM_LOG=<path> 改路径。
/// 体积极小(每条消息一行),启动时超 2MB 截断重建。
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
            // 不逐行 flush：BufWriter 满 8KB 自动落盘即可。逐行 flush 在满速输出
            // （tar -v 等每秒数千行）时每行一次 syscall，还会被杀毒 minifilter 放大。
            for line in rx {
                let _ = writeln!(w, "{line}");
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
/// 同时落盘（diag_tx）与广播 `debug:log`（前端 Debug 面板实时流，带速率限制）。
/// pub(crate)：pythoninstall（Python 运行时探测）等模块复用同一事件流。
/// `AISHELL_TERM_LOG=0` 时整体静默（含 `debug:log` 事件，不只是写盘）——诊断打点
/// 曾在 SSH 每包路径上把事件风暴引入主线程（事件经 tao send_event 逐条 marshal
/// 到主线程执行 ExecuteScript），开关必须能整体关掉。
pub(crate) fn diag(msg: &str) {
    let Some(tx) = diag_tx() else { return };
    let ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = format!("{ms} {msg}");
    let _ = tx.send(line.clone());
    if let Some(app) = DEBUG_APP.get() {
        emit_debug_throttled(app, &line);
    }
}

/// `debug:log` 事件节流状态：滚动 1s 窗口起点(ms) 与已广播条数。
static DIAG_EMIT: Mutex<(u64, u32)> = Mutex::new((0, 0));
/// 每秒最多广播的诊断行数：写盘（后台线程）不受影响，仅事件限流。
/// 防止未来任何热路径打点重新以数百条/秒以上的频率打主线程。
const DIAG_EMIT_PER_SEC: u32 = 200;

/// 带全局速率限制的 `debug:log` 广播：滚动 1s 窗口超出上限的行只落盘不广播
/// （Debug 面板本就是环形缓冲最近 3000 行，丢弃中间几行不影响取证）。
fn emit_debug_throttled(app: &AppHandle, line: &str) {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let mut st = DIAG_EMIT.lock().unwrap_or_else(|e| e.into_inner());
    if now.saturating_sub(st.0) >= 1000 {
        st.0 = now;
        st.1 = 0;
    }
    if st.1 >= DIAG_EMIT_PER_SEC {
        return;
    }
    st.1 += 1;
    let _ = app.emit("debug:log", DebugLogPayload { line: line.to_string() });
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

/// 返回字节串可安全整体送 UTF-8 解码的前缀长度：尾部是不完整多字节序列（error_len 为
/// None）时截到字符边界，残字节由调用方留待与下一批数据拼接；确定的非法字节按 1 字节
/// 切出交给 lossy 替换为 U+FFFD，保证每轮调用都有进展（不会卡死在同一错误位置）。
fn utf8_safe_prefix_len(bytes: &[u8]) -> usize {
    match std::str::from_utf8(bytes) {
        Ok(_) => bytes.len(),
        Err(e) => match e.error_len() {
            None => e.valid_up_to(),
            Some(_) => e.valid_up_to() + 1,
        },
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

/// SSH 读循环攒批参数：达到字节上限或时间窗口任一条件即 flush。
/// 256KB 满速（约 40MB/s）下约 150 批/秒，主线程事件负载相比逐包 emit
/// （数千/秒 ×2 路）降两个数量级；8ms 窗口对稀疏输出（按键回显）无感知延迟。
const BATCH_MAX_BYTES: usize = 256 * 1024;
const BATCH_WINDOW: std::time::Duration = std::time::Duration::from_millis(8);

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
        // GUI 启动环境缺 locale/TERM 兜底：C locale 下 zsh 会把中文路径渲染成八进制转义
        #[cfg(not(windows))]
        {
            for (k, v) in shell_env_fallback() {
                cmd.env(k, v);
            }
        }
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
                // 大读缓冲：ConPTY 有数据即返回（不等满），稀疏输出仍是小批；满速输出
                // （cat/构建日志）时单次 read 尽量填满，事件率随块大小一起下降——
                // 与 SSH 分支攒批同目标（emit 走 tao → 主线程逐条 ExecuteScript，
                // 逐 4KB 块 emit 在高速输出时同样会打满主线程）。
                let mut buf = vec![0u8; 256 * 1024];
                // 多字节 UTF-8 字符可能断在 read 边界：carry 留住不完整尾字节与下一批拼接，
                // 按块直接 lossy 会把断点字符替换成 U+FFFD（录制 tee 同样受损）
                let mut carry: Vec<u8> = Vec::new();
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            carry.extend_from_slice(&buf[..n]);
                            let keep = utf8_safe_prefix_len(&carry);
                            let data = String::from_utf8_lossy(&carry[..keep]).into_owned();
                            carry.drain(..keep);
                            mgr.tee_record(&id2, &data);
                            let _ = app.emit(&format!("term:data:{id2}"), TermDataPayload { data });
                        }
                    }
                }
                // 流结束（EOF/读错误）后残留的不完整序列按 lossy 冲出，不静默丢弃
                if !carry.is_empty() {
                    let data = String::from_utf8_lossy(&carry).into_owned();
                    mgr.tee_record(&id2, &data);
                    let _ = app.emit(&format!("term:data:{id2}"), TermDataPayload { data });
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
            // 与本地读线程同型：多字节 UTF-8 字符可能断在 SSH 数据包边界，carry 跨包拼接
            let mut carry: Vec<u8> = Vec::new();
            // 攒批发射缓冲：连续 Data 合并到 BATCH_MAX_BYTES / BATCH_WINDOW 再 emit 一次。
            // 满速输出（tar -v 大包等）时 SSH 每秒可达数千包，逐包 emit 会同时打满
            // 主线程（事件经 tao send_event 逐条 marshal 到主线程 ExecuteScript）与
            // 前端 JS，整窗无响应只能强杀（2026-09 用户事故，seq 2000 万行复现）。
            // 攒批后事件率降 1-2 个数量级；批等待期间不调 wait()，russh 队列与 SSH
            // 窗口自然对远端形成背压。稀疏输出（按键回显）每批等满 BATCH_WINDOW
            //（8ms）超时即发，人无感知。
            let mut batch = String::new();
            let mut batch_pkts = 0usize;
            let mut batch_bytes = 0usize;
            // wait() = tokio mpsc recv()，官方保证取消安全：timeout 取消挂起的 wait
            // 不会丢消息，未取出的仍在通道队列。
            macro_rules! flush_batch {
                () => {
                    if !batch.is_empty() {
                        let pkts = std::mem::take(&mut batch_pkts);
                        let bytes = std::mem::take(&mut batch_bytes);
                        diag(&format!("recv id={id2} batch pkts={pkts} len={bytes}"));
                        mgr.tee_record(&id2, &batch);
                        let r = app.emit(
                            &format!("term:data:{id2}"),
                            TermDataPayload { data: std::mem::take(&mut batch) },
                        );
                        if let Err(e) = r {
                            diag(&format!("emit-err id={id2} err={e}"));
                        }
                    }
                };
            }
            diag(&format!("read-task start id={id2}"));
            loop {
                // 批次有待发数据时限时等下一包：窗口内继续攒，超时即 flush
                let msg = if batch.is_empty() {
                    read_half.wait().await
                } else {
                    match tokio::time::timeout(BATCH_WINDOW, read_half.wait()).await {
                        Ok(m) => m,
                        Err(_) => {
                            flush_batch!();
                            continue;
                        }
                    }
                };
                match msg {
                    Some(ChannelMsg::Data { data }) => {
                        carry.extend_from_slice(&data);
                        batch_pkts += 1;
                        batch_bytes += data.len();
                        let keep = utf8_safe_prefix_len(&carry);
                        batch.push_str(&String::from_utf8_lossy(&carry[..keep]));
                        carry.drain(..keep);
                        if batch.len() >= BATCH_MAX_BYTES {
                            flush_batch!();
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
            // 通道结束：批次残余先冲出，再处理残留不完整序列（与本地读线程同型）
            flush_batch!();
            if !carry.is_empty() {
                let data = String::from_utf8_lossy(&carry).into_owned();
                mgr.tee_record(&id2, &data);
                let _ = app.emit(&format!("term:data:{id2}"), TermDataPayload { data });
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

/// 捆绑资源目录探测（与 pi 运行时一致的三候选）：exe 同级安装布局（$INSTDIR\resources\<rel>）
/// → 扁平布局（$INSTDIR\<rel>，兼容）→ dev 源目录（CARGO_MANIFEST_DIR\resources\<rel>，仅开发态存在，
/// release 二进制里该路径不存在、探测自然落空）。目录存在才返回。
/// find_shell（git-portable）与 pythoninstall（python-embed）共用。
#[cfg(windows)]
pub(crate) fn bundled_resource_dir(rel: &str) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join(rel));
            candidates.push(dir.join(rel));
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(rel));
    candidates.into_iter().find(|p| p.is_dir())
}

/// Windows：探测 Git Bash。顺序：env AISHELL_GIT_BASH → %PROGRAMFILES%\Git\bin\bash.exe →
/// %PROGRAMFILES(X86)%\Git\bin\bash.exe → 捆绑 PortableGit（resources/git-portable，免安装兜底，
/// 优先于 PATH：避免命中过旧/未验证的 PATH 安装）→ `where.exe bash` 输出中首个含 "Git" 的行
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
            let p = format!(r"{}\Git\bin\bash.exe", pf.trim_end_matches(|c: char| ['\\', '/'].contains(&c)));            if PathBuf::from(&p).is_file() {
                return Some(p);
            }
        }
    }
    if let Some(dir) = bundled_resource_dir("git-portable") {
        let p = dir.join("bin").join("bash.exe");
        if p.is_file() {
            return Some(p.to_string_lossy().into_owned());
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
    "未找到 Git Bash：内置便携运行时缺失（可能安装包损坏，请重装 AIShell）且系统未安装 Git for Windows；也可手动安装 Git for Windows 或设置环境变量 AISHELL_GIT_BASH 指向 bash.exe 后重启".to_string()
}

/// find_shell 未命中时的用户可读错误（create_local / ai_actions 两调用点统一文案）。
#[cfg(not(windows))]
pub(crate) fn shell_missing_msg() -> String {
    "未找到可用 shell：$SHELL 未设置且 /bin/zsh、/bin/bash 均不存在".to_string()
}

/* ---------------- PTY 子进程环境兜底（GUI 启动缺 locale/TERM 修复） ---------------- */

/// GUI 启动（Finder/Dock，launchd 环境）不带 LANG/LC_* 与 TERM：PTY 子 shell 落到 C locale
/// 后，zsh 会把 prompt / ls 输出里的中文路径渲染成八进制转义（\350\257…）或问号，zle 粘贴
/// 多字节文本也会被按单字节吃掉。从终端启动（tauri dev）时进程继承终端的 locale，开发
/// 环境难以复现。返回兜底注入项；LANG/LC_ALL/LC_CTYPE 任一已设时不覆盖（尊重用户环境）。
/// pub(crate)：ai_actions 的本地命令执行（--login -c 捕获输出）复用同一兜底。
#[cfg(not(windows))]
pub(crate) fn shell_env_fallback() -> Vec<(&'static str, &'static str)> {
    fn non_empty(var: &str) -> bool {
        match std::env::var(var) {
            Ok(v) => !v.trim().is_empty(),
            Err(_) => false,
        }
    }
    let mut env = Vec::new();
    if !(non_empty("LANG") || non_empty("LC_ALL") || non_empty("LC_CTYPE")) {
        env.push(("LC_CTYPE", utf8_locale_value()));
    }
    if !non_empty("TERM") {
        // 与 SSH request_pty（ssh.rs）申报的终端类型一致
        env.push(("TERM", "xterm-256color"));
    }
    env
}

/// 兜底 locale 值：macOS 用系统特殊值 "UTF-8"（按用户区域映射为 UTF-8 codeset）；
/// Linux 用 glibc 内置 "C.UTF-8"（老系统不识别时 setlocale 退回 C，不劣于现状）。
#[cfg(all(not(windows), target_os = "macos"))]
fn utf8_locale_value() -> &'static str {
    "UTF-8"
}

#[cfg(all(not(windows), not(target_os = "macos")))]
fn utf8_locale_value() -> &'static str {
    "C.UTF-8"
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

    /// utf8_safe_prefix_len：完整序列返回全长；尾部不完整多字节序列截到字符边界
    /// （返回 0 表示整段留待下一批）；确定的非法字节按 1 字节切出，保证每轮有进展。
    #[test]
    fn utf8_prefix_len_boundaries() {
        use super::utf8_safe_prefix_len;
        assert_eq!(utf8_safe_prefix_len(b""), 0);
        assert_eq!(utf8_safe_prefix_len(b"plain ascii"), b"plain ascii".len());
        // "中" = E4 B8 AD
        assert_eq!(utf8_safe_prefix_len(b"\xe4\xb8\xad"), 3);
        assert_eq!(utf8_safe_prefix_len(b"\xe4"), 0);
        assert_eq!(utf8_safe_prefix_len(b"\xe4\xb8"), 0);
        // 前面有 ASCII 时只断出 ASCII 部分
        assert_eq!(utf8_safe_prefix_len(b"a\xe4\xb8"), 1);
        // 完整 "中" + 下一个字符的首字节：安全前缀 = 3，尾部 1 字节留待下一批
        assert_eq!(utf8_safe_prefix_len(b"\xe4\xb8\xad\xe6"), 3);
        // 确定非法字节（\xff）：安全前缀跨过它，本轮 lossy 出一个 U+FFFD
        assert_eq!(utf8_safe_prefix_len(b"ab\xffcd"), 3);
    }

    /// 跨块流式解码对拍：4096 字节按块 + carry 拼接的还原结果与整体解码完全一致，
    /// 不出现 U+FFFD（回归：本地/SSH 读循环按块 lossy 会把断在边界的多字节字符丢字）。
    #[test]
    fn utf8_stream_assemble_across_chunks() {
        use super::utf8_safe_prefix_len;
        // 35 字节/重复（11 个 3 字节汉字 + '/' + '\n'），4096 与 35 互质 → 各 chunk 边界
        // 依次落在后续汉字的第 1/2/3 字节上，三种断开位置全覆盖
        let text = "项目路径：公司测试环境/数据\n".repeat(600);
        let bytes = text.as_bytes();
        let mut carry: Vec<u8> = Vec::new();
        let mut out = String::new();
        let mut pos = 0;
        while pos < bytes.len() {
            let end = (pos + 4096).min(bytes.len());
            carry.extend_from_slice(&bytes[pos..end]);
            let keep = utf8_safe_prefix_len(&carry);
            out.push_str(&String::from_utf8_lossy(&carry[..keep]));
            carry.drain(..keep);
            pos = end;
        }
        out.push_str(&String::from_utf8_lossy(&carry));
        assert_eq!(out, text);
    }
}
