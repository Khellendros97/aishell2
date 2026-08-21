//! AI 会话 Trace 日志：全局开关、按会话分文件落盘、7 天定时清理、导出裁剪。
//!
//! 目录组织：`<config_dir>/ai-trace/<YYYY-MM-DD>/<projectId>__<sessionId>.jsonl`
//! （日期目录按 UTC，清理时整目录过期删除；文件名主干经 `file_stem` 消毒）。
//! 每行一个 JSON：`{"ts": <epoch-millis>, "cat": "<类别>", ...类别字段}`，类别：
//! - `user_input`      用户输入（ai.rs ai_chat，脱敏后 prompt + redacted 计数）
//! - `pi_event`        pi stdout 事件（ai.rs 读线程；text_delta/thinking_delta/toolcall_delta
//!   增量类高频事件写盘前过滤，文本由 assistant_output 聚合覆盖）
//! - `assistant_output` 回合 done 时聚合的完整助手文本
//! - `tool_call`       tool_execution_start/end 配对（tool/status/durationMs/args/result）
//! - `guard`           工具调用门禁（validate 拒绝/审批/智能审批/动作桥结果/指纹拒绝）
//! - `prompt_inject`   spawn 时提示词注入（系统提示词/技能作用域/目录/模式/模型）
//! - `title_gen`       直连 LLM 标题生成（session_title.rs，不经 pi）
//!
//! 写入仿 term.rs diag：全局 mpsc + 单后台写线程（BufWriter，500ms 周期 flush），
//! 埋点失败静默、绝不影响主路径；开关关闭时 log() 零成本直接返回。
//! 开关状态持久化在 AppState.trace_enabled（独立命令读写，不走 Settings 表单——
//! 设置页保存时整体提交 Settings，表单无此字段会被覆盖）。

use std::collections::HashMap;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, LazyLock, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;
use unicode_segmentation::UnicodeSegmentation;

/// 日志保留天数：日期目录早于「今天 - 7 天」即过期删除（今天起算共保留 7 天）
const RETENTION_DAYS: i64 = 7;
/// trace_read 单文件最多回读的字节数（防爆内存，从尾部起读）
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
/// 导出时助手输出最大保留字素数（超出截断并标注原长度）
const EXPORT_MAX_ASSISTANT_GRAPHEMES: usize = 1024;
/// 写线程 flush 周期（兼作 recv 超时，保证无新消息时也定期落盘）
const FLUSH_INTERVAL: Duration = Duration::from_millis(500);

static ENABLED: AtomicBool = AtomicBool::new(false);
static TRACE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// 前端展示/搜索用的结构化条目（text 为已格式化的单行展示文本）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceEntry {
    pub ts: u64,
    pub cat: String,
    pub text: String,
}

/* ---------------- 开关与初始化 ---------------- */

/// lib.rs setup 调用一次：注入日志目录与持久化的开关初值。
pub fn init(dir: PathBuf, enabled: bool) {
    let _ = TRACE_DIR.set(dir);
    ENABLED.store(enabled, Ordering::Relaxed);
}

pub fn is_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

pub fn set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

/* ---------------- 埋点入口 ---------------- */

/// 追加一条 trace 日志：fields 合并进 `{ts, cat, ...}` 后落一行 JSON。
/// 开关关闭 / 目录未初始化 / 序列化失败时静默返回（绝不影响主路径）。
pub(crate) fn log(key: &str, cat: &str, fields: Value) {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    let now = now_ms();
    let mut obj = serde_json::Map::new();
    obj.insert("ts".to_string(), Value::from(now));
    obj.insert("cat".to_string(), Value::from(cat));
    if let Value::Object(extra) = fields {
        for (k, v) in extra {
            obj.insert(k, v);
        }
    }
    let Ok(line) = serde_json::to_string(&Value::Object(obj)) else {
        return;
    };
    let Some(tx) = writer_tx() else { return };
    let _ = tx.send(TraceMsg::Write(WriteMsg {
        date: date_dir_name(now),
        stem: file_stem(key),
        line,
    }));
}

/* ---------------- 后台写线程 ---------------- */

struct WriteMsg {
    date: String,
    stem: String,
    line: String,
}

enum TraceMsg {
    Write(WriteMsg),
    /// 清空会话前让写线程先关闭该会话的句柄（Windows 文件占用时无法删除），ack 回执
    CloseSession { stem: String, ack: mpsc::Sender<()> },
}

fn writer_tx() -> Option<&'static mpsc::Sender<TraceMsg>> {
    static TX: LazyLock<Option<mpsc::Sender<TraceMsg>>> = LazyLock::new(|| {
        let base = TRACE_DIR.get()?.clone();
        if std::fs::create_dir_all(&base).is_err() {
            return None;
        }
        let (tx, rx) = mpsc::channel::<TraceMsg>();
        std::thread::spawn(move || writer_loop(rx, base));
        Some(tx)
    });
    TX.as_ref()
}

fn writer_loop(rx: mpsc::Receiver<TraceMsg>, base: PathBuf) {
    let mut writers: HashMap<PathBuf, BufWriter<std::fs::File>> = HashMap::new();
    let mut last_flush = Instant::now();
    loop {
        match rx.recv_timeout(FLUSH_INTERVAL) {
            Ok(TraceMsg::Write(msg)) => {
                let path = base.join(&msg.date).join(format!("{}.jsonl", msg.stem));
                // 打开失败跳过该行（不缓存失败，下条消息重试）
                if !writers.contains_key(&path) {
                    if let Some(parent) = path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                    }
                    if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(&path)
                    {
                        writers.insert(path.clone(), BufWriter::new(f));
                    }
                }
                if let Some(w) = writers.get_mut(&path) {
                    let _ = writeln!(w, "{}", msg.line);
                }
            }
            Ok(TraceMsg::CloseSession { stem, ack }) => {
                let suffix = format!("{stem}.jsonl");
                writers.retain(|p, w| {
                    let keep = !p.file_name().is_some_and(|n| n.to_string_lossy() == suffix);
                    if !keep {
                        let _ = w.flush();
                    }
                    keep
                });
                let _ = ack.send(());
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if last_flush.elapsed() >= FLUSH_INTERVAL {
            for w in writers.values_mut() {
                let _ = w.flush();
            }
            last_flush = Instant::now();
        }
    }
}

/* ---------------- 读取 ---------------- */

/// 读指定会话的全部 trace 行（跨日期目录，按目录名升序拼接）；单文件只回读尾部 MAX_READ_BYTES。
fn read_session_lines(key: &str) -> Vec<String> {
    let Some(base) = TRACE_DIR.get() else {
        return Vec::new();
    };
    let stem = file_stem(key);
    let mut dates: Vec<String> = std::fs::read_dir(base)
        .map(|rd| {
            rd.flatten()
                .filter(|e| e.path().is_dir())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    dates.sort();
    let mut lines = Vec::new();
    for date in dates {
        let path = base.join(date).join(format!("{stem}.jsonl"));
        lines.extend(read_tail_lines(&path));
    }
    lines
}

/// 回读文件尾部（至多 MAX_READ_BYTES，从最近完整行开始），跳过空行。
fn read_tail_lines(path: &Path) -> Vec<String> {
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(MAX_READ_BYTES);
    if f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    if f.read_to_end(&mut buf).is_err() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&buf);
    let mut iter = text.lines();
    if start > 0 {
        iter.next(); // 丢弃被截断的首行
    }
    iter.filter(|s| !s.trim().is_empty())
        .map(str::to_string)
        .collect()
}

/* ---------------- 格式化与导出裁剪 ---------------- */

fn str_field<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// 面板展示文本（完整内容，不裁剪）。
fn format_entry(v: &Value, raw: &str) -> String {
    match str_field(v, "cat") {
        "user_input" => {
            let redacted = v.get("redacted").and_then(Value::as_u64).unwrap_or(0);
            let note = if redacted > 0 {
                format!("（{redacted} 处凭据已脱敏）")
            } else {
                String::new()
            };
            format!("用户输入{note}: {}", str_field(v, "prompt"))
        }
        "pi_event" => format_pi_event(str_field(v, "raw")),
        "assistant_output" => format!("助手输出: {}", str_field(v, "text")),
        "tool_call" => format!(
            "工具调用 {} [{}] 耗时 {}ms 参数={} 结果={}",
            str_field(v, "tool"),
            str_field(v, "status"),
            v.get("durationMs").and_then(Value::as_u64).unwrap_or(0),
            str_field(v, "args"),
            str_field(v, "result"),
        ),
        "guard" => format!("门禁[{}]: {}", str_field(v, "kind"), str_field(v, "detail")),
        "prompt_inject" => format!(
            "提示词注入[{}]: {}",
            str_field(v, "kind"),
            str_field(v, "detail")
        ),
        "title_gen" => format!(
            "标题生成[{}]: {}",
            str_field(v, "kind"),
            str_field(v, "detail")
        ),
        // 未知类别（新版本写入的旧文件）：原样展示原始行
        _ => format!("未知类别: {raw}"),
    }
}

/// pi_event 解包展示：原始 JSON 行可读性太差，按事件类型格式化为单行中文摘要。
/// 裁剪约定：思维链/工具参数增量只显示本段字素数（全文无调试价值且文本量巨大）；
/// 未知类型保留原文（完整记录优先于可读性）。
fn format_pi_event(raw: &str) -> String {
    let Ok(ev) = serde_json::from_str::<Value>(raw) else {
        return format!("pi 事件（非 JSON 行）: {raw}");
    };
    let ty = ev.get("type").and_then(Value::as_str).unwrap_or("");
    match ty {
        "message_update" => {
            let ae = ev.get("assistantMessageEvent").cloned().unwrap_or_else(|| json!({}));
            let sub = ae.get("type").and_then(Value::as_str).unwrap_or("");
            match sub {
                "text_delta" => format!(
                    "文本增量: {}",
                    ae.get("delta").and_then(Value::as_str).unwrap_or("")
                ),
                "thinking_delta" => format!(
                    "思维链增量（{} 字素）",
                    ae.get("delta")
                        .and_then(Value::as_str)
                        .map(|s| s.graphemes(true).count())
                        .unwrap_or(0)
                ),
                "toolcall_delta" => format!(
                    "工具参数增量（{} 字素）",
                    ae.get("delta")
                        .and_then(Value::as_str)
                        .map(|s| s.graphemes(true).count())
                        .unwrap_or(0)
                ),
                "toolcall_start" => format!(
                    "工具调用开始: {}",
                    ae.get("toolName").and_then(Value::as_str).unwrap_or("")
                ),
                "error" => format!(
                    "生成出错: {}",
                    ae.get("message")
                        .or_else(|| ae.get("error"))
                        .and_then(Value::as_str)
                        .unwrap_or("AI 回复出错")
                ),
                other => format!("消息更新[{other}]"),
            }
        }
        "tool_execution_start" => {
            let tool = ev.get("toolName").and_then(Value::as_str).unwrap_or("");
            // 关键参数摘要（与 ai.rs 瞬时工具行同规则；content 不展示）
            let label = ev
                .get("args")
                .and_then(|a| {
                    a.get("path")
                        .or_else(|| a.get("pattern"))
                        .or_else(|| a.get("command"))
                        .or_else(|| a.get("query"))
                        .or_else(|| a.get("name"))
                })
                .and_then(Value::as_str)
                .unwrap_or("");
            if label.is_empty() {
                format!("工具开始: {tool}")
            } else {
                format!("工具开始: {tool} {label}")
            }
        }
        "tool_execution_end" => {
            let tool = ev.get("toolName").and_then(Value::as_str).unwrap_or("");
            if ev.get("isError").and_then(Value::as_bool).unwrap_or(false) {
                format!(
                    "工具结束: {tool} 失败: {}",
                    ev.get("errorMessage").and_then(Value::as_str).unwrap_or("")
                )
            } else {
                format!("工具结束: {tool} 成功")
            }
        }
        "agent_settled" => "回合结束（agent_settled）".to_string(),
        "turn_start" => "回合开始".to_string(),
        "auto_retry_start" => format!(
            "自动重试: 第{}/{}次（模型瞬时错误）",
            ev.get("attempt").and_then(Value::as_u64).unwrap_or(0),
            ev.get("maxAttempts").and_then(Value::as_u64).unwrap_or(0),
        ),
        "message_start" | "message_end" => {
            let role = ev
                .get("message")
                .and_then(|m| m.get("role"))
                .and_then(Value::as_str)
                .unwrap_or("?");
            let stop = ev
                .get("message")
                .and_then(|m| m.get("stopReason"))
                .and_then(Value::as_str);
            match stop {
                Some("error") => format!("{ty}: role={role} stopReason=error"),
                _ => format!("{ty}: role={role}"),
            }
        }
        "response" => format!(
            "命令响应: {} {}",
            ev.get("command").and_then(Value::as_str).unwrap_or(""),
            if ev.get("success").and_then(Value::as_bool).unwrap_or(false) {
                "成功"
            } else {
                "失败"
            },
        ),
        "extension_ui_request" => format!(
            "扩展请求: {}",
            ev.get("title").and_then(Value::as_str).unwrap_or("")
        ),
        _ => format!("{ty}: {raw}"),
    }
}

/// 导出裁剪：成功的工具调用只保留工具名称/状态/耗时；助手输出截断 1024 字素；
/// 其余内容（含失败的工具调用）不裁剪。
fn export_entry_text(v: &Value, raw: &str) -> String {
    match str_field(v, "cat") {
        "tool_call" if str_field(v, "status") == "success" => format!(
            "工具调用 {} [success] 耗时 {}ms",
            str_field(v, "tool"),
            v.get("durationMs").and_then(Value::as_u64).unwrap_or(0),
        ),
        "assistant_output" => {
            let text = str_field(v, "text");
            let total = text.graphemes(true).count();
            if total > EXPORT_MAX_ASSISTANT_GRAPHEMES {
                let kept: String = text
                    .graphemes(true)
                    .take(EXPORT_MAX_ASSISTANT_GRAPHEMES)
                    .collect();
                format!("助手输出: {kept}…(已裁剪，原文 {total} 字素)")
            } else {
                format!("助手输出: {text}")
            }
        }
        _ => format_entry(v, raw),
    }
}

fn parse_entry(line: &str) -> Option<TraceEntry> {
    let v: Value = serde_json::from_str(line).ok()?;
    let ts = v.get("ts")?.as_u64()?;
    let cat = v.get("cat")?.as_str()?.to_string();
    let text = format_entry(&v, line);
    Some(TraceEntry { ts, cat, text })
}

/* ---------------- 7 天定时清理 ---------------- */

/// 过期判定：日期目录名（UTC）早于「今天 - 7 天」即过期；非日期目录名不动。
fn is_expired_dir(name: &str, today_ms: u64) -> bool {
    let Some(dir_days) = parse_date_dir(name) else {
        return false;
    };
    let today_days = (today_ms / 86_400_000) as i64;
    dir_days < today_days - (RETENTION_DAYS - 1)
}

/// 清理过期日期目录（写线程可能仍持有跨天的旧句柄导致删除失败，静默留待下次）。
pub fn cleanup_expired() {
    let Some(base) = TRACE_DIR.get() else { return };
    let today = now_ms();
    let Ok(rd) = std::fs::read_dir(base) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let name = e.file_name().to_string_lossy().into_owned();
        if is_expired_dir(&name, today) {
            let _ = std::fs::remove_dir_all(&p);
        }
    }
}

/// lib.rs setup 调用：启动即清一次，之后每 24h 清理过期日期目录。
pub fn spawn_cleanup_task() {
    tauri::async_runtime::spawn(async {
        cleanup_expired();
        let mut interval = tokio::time::interval(Duration::from_secs(24 * 3600));
        interval.tick().await; // interval 首次 tick 立即返回，启动清理已在上面做过
        loop {
            interval.tick().await;
            cleanup_expired();
        }
    });
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
pub fn trace_status() -> bool {
    is_enabled()
}

/// 开关：先原子落盘（AppState.trace_enabled）再置运行时标志。
#[tauri::command]
pub async fn trace_set_enabled(
    store: State<'_, Arc<crate::store::Store>>,
    enabled: bool,
) -> Result<(), String> {
    store.set_trace_enabled(enabled)?;
    set_enabled(enabled);
    Ok(())
}

#[tauri::command]
pub fn trace_read(key: String) -> Vec<TraceEntry> {
    read_session_lines(&key)
        .iter()
        .filter_map(|l| parse_entry(l))
        .collect()
}

/// 导出当前会话 trace 到用户选定路径（应用裁剪规则）；返回导出行数。
#[tauri::command]
pub fn trace_export(path: String, key: String) -> Result<usize, String> {
    let lines = read_session_lines(&key);
    if lines.is_empty() {
        return Err("该会话暂无 trace 日志".to_string());
    }
    let mut out = String::new();
    let mut count = 0usize;
    for line in &lines {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(ts) = v.get("ts").and_then(Value::as_u64) else {
            continue;
        };
        out.push_str(&format!(
            "{} [{}] {}\n",
            format_ts(ts),
            str_field(&v, "cat"),
            export_entry_text(&v, line)
        ));
        count += 1;
    }
    std::fs::write(&path, out).map_err(|e| format!("导出日志失败: {e}"))?;
    Ok(count)
}

/// 清空当前会话 trace：先让写线程关闭该会话句柄（ack 回执），再删全部日期文件。
#[tauri::command]
pub fn trace_clear(key: String) -> Result<(), String> {
    let Some(base) = TRACE_DIR.get() else {
        return Ok(());
    };
    let stem = file_stem(&key);
    if let Some(tx) = writer_tx() {
        let (ack_tx, ack_rx) = mpsc::channel::<()>();
        let _ = tx.send(TraceMsg::CloseSession {
            stem: stem.clone(),
            ack: ack_tx,
        });
        let _ = ack_rx.recv_timeout(Duration::from_secs(2));
    }
    let rd = std::fs::read_dir(base).map_err(|e| format!("读取 trace 目录失败: {e}"))?;
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_dir() {
            continue;
        }
        let f = p.join(format!("{stem}.jsonl"));
        if f.exists() {
            std::fs::remove_file(&f).map_err(|e| format!("清空 trace 失败: {e}"))?;
        }
    }
    Ok(())
}

/* ---------------- 时间与文件名（纯函数，单测覆盖） ---------------- */

/// 当前 epoch 毫秒（ai.rs 配对 tool_execution_start/end 算耗时共用）
pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Unix 天数转公历 (年, 月, 日)（Howard Hinnant 算法，UTC；无 chrono 依赖）
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 公历转 Unix 天数（civil_from_days 的逆运算）
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + u64::from(d - 1); // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe as i64 - 719_468
}

/// 解析日期目录名 "YYYY-MM-DD" 为 Unix 天数；格式非法返回 None。
fn parse_date_dir(name: &str) -> Option<i64> {
    let mut it = name.split('-');
    let y: i64 = it.next()?.parse().ok()?;
    let m: u32 = it.next()?.parse().ok()?;
    let d: u32 = it.next()?.parse().ok()?;
    if it.next().is_some() || name.len() != 10 || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

/// 日期目录名（UTC）：YYYY-MM-DD
fn date_dir_name(ms: u64) -> String {
    let (y, m, d) = civil_from_days((ms / 86_400_000) as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

/// 导出 .log 行首时间戳（UTC）：YYYY-MM-DD HH:MM:SS.mmmZ
fn format_ts(ms: u64) -> String {
    let rem = ms % 86_400_000;
    let (y, mo, d) = civil_from_days((ms / 86_400_000) as i64);
    format!(
        "{y:04}-{mo:02}-{d:02} {:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600_000,
        (rem % 3_600_000) / 60_000,
        (rem % 60_000) / 1000,
        rem % 1000,
    )
}

/// key("<projectId>:<sessionId>") → 文件名主干：首个 ':' 归一为 '__'，
/// 路径分隔/控制字符等替换为 '_'（防目录穿越）。
fn file_stem(key: &str) -> String {
    key.replacen(':', "__", 1)
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn civil_date_roundtrip() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        let days = days_from_civil(2026, 8, 21);
        assert_eq!(civil_from_days(days), (2026, 8, 21));
        // 闰日
        let leap = days_from_civil(2024, 2, 29);
        assert_eq!(civil_from_days(leap), (2024, 2, 29));
        // 跨年边界
        let ny = days_from_civil(2027, 1, 1);
        assert_eq!(civil_from_days(ny - 1), (2026, 12, 31));
    }

    #[test]
    fn date_dir_name_is_utc() {
        assert_eq!(date_dir_name(0), "1970-01-01");
        assert_eq!(date_dir_name(86_400_000 - 1), "1970-01-01");
        assert_eq!(date_dir_name(86_400_000), "1970-01-02");
    }

    #[test]
    fn expired_dir_judgement() {
        let today = days_from_civil(2026, 8, 21) as u64 * 86_400_000;
        assert!(!is_expired_dir("2026-08-21", today)); // 今天
        assert!(!is_expired_dir("2026-08-15", today)); // 6 天前，保留（共 7 天）
        assert!(is_expired_dir("2026-08-14", today)); // 7 天前，过期
        assert!(is_expired_dir("2020-01-01", today));
        // 非日期目录名不动
        assert!(!is_expired_dir("not-a-date", today));
        assert!(!is_expired_dir("2026-13-01", today));
        assert!(!is_expired_dir("2026-08-1", today));
    }

    #[test]
    fn file_stem_sanitizes() {
        assert_eq!(file_stem("proj:sess1"), "proj__sess1");
        assert_eq!(file_stem("a/b\\c:d"), "a_b_c__d");
        assert_eq!(file_stem("..:../x"), "..__.._x");
    }

    #[test]
    fn export_trims_successful_tool_call() {
        let v = json!({"cat":"tool_call","tool":"run_command","status":"success","durationMs":2300,
            "args":"{\"command\":\"rm -rf /tmp/x\"}","result":"很长的输出"});
        let line = v.to_string();
        assert_eq!(export_entry_text(&v, &line), "工具调用 run_command [success] 耗时 2300ms");
    }

    #[test]
    fn export_keeps_failed_tool_call_full() {
        let v = json!({"cat":"tool_call","tool":"run_command","status":"error","durationMs":100,
            "args":"{}","result":"失败原因"});
        let line = v.to_string();
        let text = export_entry_text(&v, &line);
        assert!(text.contains("失败原因") && text.contains("error"));
    }

    #[test]
    fn export_truncates_assistant_output() {
        let long = "汉".repeat(2000);
        let v = json!({"cat":"assistant_output","text": long});
        let line = v.to_string();
        let text = export_entry_text(&v, &line);
        assert!(text.contains("已裁剪") && text.contains("2000"));
        // 1024 字素 + 前缀/后缀
        assert!(text.graphemes(true).count() < 1100);
    }

    #[test]
    fn export_keeps_short_assistant_output_and_other_categories() {
        let v = json!({"cat":"assistant_output","text":"简短回复"});
        let line = v.to_string();
        assert_eq!(export_entry_text(&v, &line), "助手输出: 简短回复");
        let v = json!({"cat":"guard","kind":"approval","detail":"用户批准"});
        let line = v.to_string();
        assert_eq!(export_entry_text(&v, &line), "门禁[approval]: 用户批准");
    }

    #[test]
    fn pi_event_unwraps_text_delta_and_tool_events() {
        let raw = r#"{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"你好"}}"#;
        assert_eq!(format_pi_event(raw), "文本增量: 你好");
        let raw = r#"{"type":"tool_execution_start","toolName":"run_command","args":{"command":"ls -la"}}"#;
        assert_eq!(format_pi_event(raw), "工具开始: run_command ls -la");
        let raw = r#"{"type":"tool_execution_end","toolName":"write","isError":false}"#;
        assert_eq!(format_pi_event(raw), "工具结束: write 成功");
        let raw = r#"{"type":"tool_execution_end","toolName":"edit","isError":true,"errorMessage":"权限拒绝"}"#;
        assert_eq!(format_pi_event(raw), "工具结束: edit 失败: 权限拒绝");
        assert_eq!(format_pi_event(r#"{"type":"agent_settled"}"#), "回合结束（agent_settled）");
    }

    #[test]
    fn pi_event_trims_thinking_to_length() {
        let thinking = "想".repeat(500);
        let raw = json!({"type":"message_update","assistantMessageEvent":{"type":"thinking_delta","delta": thinking}}).to_string();
        assert_eq!(format_pi_event(&raw), "思维链增量（500 字素）");
        let raw = json!({"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","delta":"{\"path\":"}}).to_string();
        assert_eq!(format_pi_event(&raw), "工具参数增量（8 字素）");
    }

    #[test]
    fn pi_event_unknown_type_keeps_raw() {
        let raw = r#"{"type":"some_new_event","payload":"x"}"#;
        assert_eq!(format_pi_event(raw), format!("some_new_event: {raw}"));
        assert!(format_pi_event("not json at all").starts_with("pi 事件（非 JSON 行）"));
    }
}
