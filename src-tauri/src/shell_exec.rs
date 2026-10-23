//! 前台终端命令通道（AI 在用户已打开的 SSH shell 里执行命令）。
//!
//! 背景：部分堡垒机网关（齐治 TERM-SSHD）一条 TCP 连接只允许一个会话 channel，
//! AI 的 `run_command` 不能像普通服务器那样新开 exec channel，只能复用终端已有的 shell。
//!
//! 协议：把命令 base64 后单行注入（保证不触发 tty 的行切分/长度问题），用运行时拼接的
//! BEGIN/END 标记包住输出。标记由 shell 变量拼接产生，回显的命令行里只有 `$A1$A2`
//! 字面量，不会误触捕获起点。
//!
//! 本模块不依赖 Tauri / SSH：`AiCapture` 由终端读循环喂数据，由 ssh.rs 的
//! `exec_in_shell` 驱动；`AnsiState` 是捕获输出的 ANSI 清洗器（终端录制另有一份
//! 同语义实现，刻意不共享以避免录制路径被 AI 功能牵动）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::Engine as _;
use tokio::sync::{oneshot, Mutex as AsyncMutex};

/// 单条 AI 命令的输出上限：超过后放弃并报错，避免把内存打满。
const CAPTURE_MAX_BYTES: usize = 4 * 1024 * 1024;

/// tty 规范模式单行上限通常 4096；base64 后留余量，超长命令提示改用脚本上传。
const MAX_ENVELOPE_BYTES: usize = 3500;

/// 捕获完成的原始结果（已剥 ANSI）。
#[derive(Debug, Clone, PartialEq)]
pub struct Captured {
    pub text: String,
    pub exit_code: Option<i32>,
}

/// 构造注入命令（单行）：
///
/// ```text
/// A1=__AISHELL_AI; A2="BEGIN_<nonce>__"; A3="END_<nonce>__";
/// printf '\n%s\n' "$A1$A2"; ( cd '<cwd>' && eval "$(printf %s '<b64>' | base64 -d)" ) 2>&1;
/// printf '\n%s:%d\n' "$A1$A3" "$?"
/// ```
///
/// 命令 base64 后不含换行，整条注入串始终是 tty 的一行；子 shell 隔离 cd/export。
pub fn build_envelope(nonce: &str, cwd: Option<&str>, command: &str) -> Result<String, String> {
    let encoded = base64::engine::general_purpose::STANDARD.encode(command.as_bytes());
    let cwd_prefix = match cwd.filter(|c| !c.trim().is_empty()) {
        Some(dir) => format!("cd {} && ", shell_quote(dir)),
        None => String::new(),
    };
    let envelope = format!(
        "A1=__AISHELL_AI; A2=\"BEGIN_{nonce}__\"; A3=\"END_{nonce}__\"; \
         printf '\\n%s\\n' \"$A1$A2\"; \
         ( {cwd_prefix}eval \"$(printf %s '{encoded}' | base64 -d)\" ) 2>&1; \
         printf '\\n%s:%d\\n' \"$A1$A3\" \"$?\""
    );
    if envelope.len() > MAX_ENVELOPE_BYTES {
        return Err(format!(
            "命令过长（注入串 {} 字节，终端单行上限约 {} 字节）：请把脚本先上传到远端再执行",
            envelope.len(),
            MAX_ENVELOPE_BYTES
        ));
    }
    Ok(envelope)
}

/// POSIX 单引号转义（仅供 cd 路径；命令本体走 base64）。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 一条正在进行的 AI 命令的状态。
struct Active {
    begin: String,
    end_prefix: String,
    /// 已捕获的原文（从 BEGIN 之后开始）
    buf: String,
    /// 尚未匹配到 BEGIN 时，下一次搜索的起始下标（处理跨批标记）
    scan: usize,
    started: bool,
    tx: oneshot::Sender<Result<Captured, String>>,
}

/// 终端读循环与 AI 执行之间的捕获槽。
pub struct AiCapture {
    /// 串行化同一终端上的 AI 命令（用户输入由 term.rs 另行丢弃）。
    busy: AsyncMutex<()>,
    slot: StdMutex<Option<Active>>,
}

impl AiCapture {
    pub fn new() -> Arc<Self> {
        Arc::new(AiCapture {
            busy: AsyncMutex::new(()),
            slot: StdMutex::new(None),
        })
    }

    pub async fn lock(&self) -> tokio::sync::MutexGuard<'_, ()> {
        self.busy.lock().await
    }

    pub fn is_busy(&self) -> bool {
        self.slot.lock().map(|s| s.is_some()).unwrap_or(false)
    }

    /// 开始一次捕获：返回接收端；调用方负责把命令写入终端。
    pub fn begin(&self, nonce: &str) -> oneshot::Receiver<Result<Captured, String>> {
        let (tx, rx) = oneshot::channel();
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some(Active {
                begin: format!("__AISHELL_AIBEGIN_{nonce}__"),
                end_prefix: format!("__AISHELL_AIEND_{nonce}__:"),
                buf: String::new(),
                scan: 0,
                started: false,
                tx,
            });
        }
        rx
    }

    /// 读循环每批调用：截取 BEGIN 与 END 之间的内容。
    pub fn feed(&self, chunk: &str) {
        let Ok(mut guard) = self.slot.lock() else { return };
        let Some(active) = guard.as_mut() else { return };

        let mut buf = std::mem::take(&mut active.buf);
        buf.push_str(chunk);

        if !active.started {
            if let Some(idx) = buf.find(&active.begin) {
                let begin_len = active.begin.len();
                buf = buf[idx + begin_len..].to_string();
                active.started = true;
                active.scan = 0;
            } else {
                // 只保留可能跨批的标记前缀，避免 BEGIN 之前的海量输出占内存
                let keep = active.begin.len().saturating_sub(1);
                if buf.len() > keep {
                    buf = buf[buf.len() - keep..].to_string();
                }
                active.buf = buf;
                return;
            }
        }

        if buf.len() > CAPTURE_MAX_BYTES {
            let Active { tx, .. } = guard.take().expect("active exists");
            let _ = tx.send(Err(format!(
                "命令输出超过 {} MB，已放弃捕获（命令可能仍在远端执行）",
                CAPTURE_MAX_BYTES / 1024 / 1024
            )));
            return;
        }

        // END 标记后紧跟退出码与换行；数字可能跨批到达，未拿到换行就继续等
        let from = active.scan.min(buf.len());
        if let Some(idx) = buf[from..].find(&active.end_prefix) {
            let idx = from + idx;
            let after = idx + active.end_prefix.len();
            if let Some(nl) = buf[after..].find('\n') {
                let code = buf[after..after + nl].trim().parse::<i32>().ok();
                let raw = buf[..idx].to_string();
                let Active { tx, .. } = guard.take().expect("active exists");
                let mut strip = AnsiState::default();
                // pty 输出是 CRLF；交给 LLM 前归一成 LF
                let text = strip.strip(&raw).replace("\r\n", "\n");
                let _ = tx.send(Ok(Captured {
                    text: trim_one_leading_newline(text),
                    exit_code: code,
                }));
                return;
            }
            active.scan = idx;
        } else {
            active.scan = buf.len().saturating_sub(active.end_prefix.len() + 8);
        }
        active.buf = buf;
    }

    /// 超时/取消：拿走槽并返回错误。
    pub fn abort(&self, reason: impl Into<String>) {
        let tx = self
            .slot
            .lock()
            .ok()
            .and_then(|mut slot| slot.take())
            .map(|active| active.tx);
        if let Some(tx) = tx {
            let _ = tx.send(Err(reason.into()));
        }
    }
}

fn trim_one_leading_newline(mut s: String) -> String {
    if s.starts_with('\r') {
        s.remove(0);
    }
    if s.starts_with('\n') {
        s.remove(0);
    }
    s
}

/// 全屏（alternate screen）检测：vim/less/top 等占用时禁止注入。
#[derive(Default)]
pub struct AltScreenTracker {
    tail: StdMutex<String>,
    active: AtomicBool,
}

impl AltScreenTracker {
    pub fn new() -> Arc<Self> {
        Arc::new(AltScreenTracker::default())
    }

    pub fn is_active(&self) -> bool {
        self.active.load(Ordering::Relaxed)
    }

    pub fn feed(&self, chunk: &str) {
        let Ok(mut tail) = self.tail.lock() else { return };
        let mut probe = String::with_capacity(tail.len() + chunk.len() + 8);
        probe.push_str(&tail);
        probe.push_str(chunk);
        for (seq, on) in [
            ("\x1b[?1049h", true),
            ("\x1b[?1049l", false),
            ("\x1b[?1047h", true),
            ("\x1b[?1047l", false),
            ("\x1b[?47h", true),
            ("\x1b[?47l", false),
        ] {
            if probe.contains(seq) {
                self.active.store(on, Ordering::Relaxed);
            }
        }
        // 保留末尾 8 字节，处理跨批转义序列
        let keep = probe.len().saturating_sub(8);
        *tail = probe[keep..].to_string();
    }
}

/// 剥除 ANSI 转义序列（录制与 AI 捕获共用）。
#[derive(Debug, Default)]
pub struct AnsiState {
    state: AnsiPhase,
}

#[derive(Debug, Default, PartialEq)]
enum AnsiPhase {
    #[default]
    Normal,
    Esc,
    Csi,
    Osc,
    Charset,
}

impl AnsiState {
    /// 从流中剥除 CSI/OSC/字符集切换等控制序列；跨批状态保留在本结构里。
    pub fn strip(&mut self, input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        for ch in input.chars() {
            match self.state {
                AnsiPhase::Normal => {
                    if ch == '\x1b' {
                        self.state = AnsiPhase::Esc;
                    } else if ch == '\r' {
                        // 保留 CR：输出里的进度条行为交给上层
                        out.push(ch);
                    } else {
                        out.push(ch);
                    }
                }
                AnsiPhase::Esc => match ch {
                    '[' => self.state = AnsiPhase::Csi,
                    ']' => self.state = AnsiPhase::Osc,
                    '(' | ')' | '*' | '+' => self.state = AnsiPhase::Charset,
                    _ => self.state = AnsiPhase::Normal,
                },
                AnsiPhase::Csi => {
                    if ('\u{40}'..='\u{7e}').contains(&ch) {
                        self.state = AnsiPhase::Normal;
                    }
                }
                AnsiPhase::Osc => {
                    if ch == '\x07' {
                        self.state = AnsiPhase::Normal;
                    } else if ch == '\x1b' {
                        self.state = AnsiPhase::Esc;
                    }
                }
                AnsiPhase::Charset => self.state = AnsiPhase::Normal,
            }
        }
        out
    }
}

/// 超时辅助：调用方用同一超时驱动 oneshot 等待。
pub async fn wait_capture(
    rx: oneshot::Receiver<Result<Captured, String>>,
    timeout: Duration,
) -> Result<Captured, String> {
    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(Ok(c))) => Ok(c),
        Ok(Ok(Err(e))) => Err(e),
        Ok(Err(_)) => Err("AI 命令通道已关闭".to_string()),
        Err(_) => Err(format!("命令执行超时（{} 秒）", timeout.as_secs())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn capture() -> Arc<AiCapture> {
        AiCapture::new()
    }

    #[test]
    fn envelope_is_single_line_and_rejects_long_commands() {
        let env = build_envelope("abc", Some("/tmp/a b"), "echo hi\necho bye").unwrap();
        assert!(!env.contains('\n'));
        assert!(env.contains("base64 -d"));
        assert!(env.contains("cd '/tmp/a b'"));
        let long = "x".repeat(MAX_ENVELOPE_BYTES);
        assert!(build_envelope("n", None, &long).unwrap_err().contains("命令过长"));
    }

    #[tokio::test]
    async fn captures_output_and_exit_code() {
        let cap = capture();
        let rx = cap.begin("n1");
        cap.feed("\x1b[?1049h"); // 无关输出
        cap.feed("noise\r\n__AISHELL_AIBEGIN_n1__\r\nhello");
        cap.feed(" world\r\n__AISHELL_AIEND_n1__:0\r\n");
        let got = wait_capture(rx, Duration::from_secs(1)).await.unwrap();
        assert_eq!(got.exit_code, Some(0));
        assert!(got.text.contains("hello world"), "{:?}", got.text);
        assert!(!got.text.contains("AIBEGIN"));
    }

    #[tokio::test]
    async fn handles_markers_split_across_chunks() {
        let cap = capture();
        let rx = cap.begin("n2");
        cap.feed("xx__AISHELL_AIBE");
        cap.feed("GIN_n2__\nOK\n__AISHELL_AIEND_n2__:");
        cap.feed("3\n");
        let got = wait_capture(rx, Duration::from_secs(1)).await.unwrap();
        assert_eq!(got.exit_code, Some(3));
        assert!(got.text.contains("OK"));
    }

    #[tokio::test]
    async fn abort_returns_error() {
        let cap = capture();
        let rx = cap.begin("n3");
        cap.abort("已取消");
        let err = wait_capture(rx, Duration::from_secs(1)).await.unwrap_err();
        assert!(err.contains("已取消"));
    }

    #[test]
    fn alt_screen_tracks_sequences_across_chunks() {
        let t = AltScreenTracker::new();
        t.feed("abc\x1b[?104");
        assert!(!t.is_active());
        t.feed("9h");
        assert!(t.is_active());
        t.feed("\x1b[?1049l");
        assert!(!t.is_active());
    }

    #[test]
    fn ansi_strip_removes_csi_and_osc() {
        let mut s = AnsiState::default();
        assert_eq!(s.strip("\x1b[31mred\x1b[0m plain"), "red plain");
        assert_eq!(s.strip("\x1b]0;title\x07ok"), "ok");
    }
}
