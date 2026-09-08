//! 项目时间线：跨 SSH/终端命令/SFTP/AI 会话的统一事件流水，按项目落盘、可搜索。
//!
//! 目录组织：`<项目>/.aishell/timeline/YYYY-MM-DD.jsonl`（日期按 UTC，与 trace.rs 一致），
//! 每行一个 JSON：`{"ts": <epoch-millis>, "kind": "<类别>", "summary": "...", "detail": "..."}`。
//! 类别（kind）：
//! - `ssh_connect` / `ssh_disconnect`  SSH 连接建立/断开（ssh.rs 连接池埋点）
//! - `command`        命令执行（终端区块上报 / SFTP 面板远程命令 / AI run_command，detail 为裁剪输出）
//! - `file_upload` / `file_download`    SFTP 传输完成（手动通道与 AI 通道）
//! - `ai_user` / `ai_assistant` / `ai_tool`  AI 会话的用户提问 / 助手回复 / 工具调用
//!
//! 写入仿 trace.rs：全局 mpsc + 单后台写线程（BufWriter，500ms 周期 flush），
//! 埋点失败静默、绝不影响主路径；与 trace 不同——时间线是长期事实记录，无开关、默认常开。
//! 保留 30 天：写线程每天首次写某项目目录时清理过期日期文件（无独立定时任务，
//! 不活跃的项目不产生 IO；搜索路径只读存在的时间段文件）。
//! 与 trace.rs（7 天调试日志）互不依赖，仅复用其日期换算纯函数。

use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, LazyLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::State;
use unicode_segmentation::UnicodeSegmentation;

use crate::trace::{date_dir_name, now_ms, parse_date_dir};

/// 时间线保留天数：日期文件早于「今天 - 30 天」即过期删除
const RETENTION_DAYS: i64 = 30;
/// 写线程 flush 周期（兼作 recv 超时，保证无新消息时也定期落盘）
const FLUSH_INTERVAL: Duration = Duration::from_millis(500);
/// 搜索默认/最大返回条数（防爆内存与前端渲染压力）
const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 1000;
/// detail 字段裁剪上限（字素）：埋点侧已各自裁剪，这里兜底防异常大文本撑爆文件
const MAX_DETAIL_GRAPHEMES: usize = 16 * 1024;
/// summary 字段裁剪上限（字素）：单行展示文本
const MAX_SUMMARY_GRAPHEMES: usize = 512;

/// 时间线条目（与前端 types.ts TimelineEntry 逐字段对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub ts: u64,
    pub kind: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// 搜索条件（与前端 types.ts TimelineQuery 逐字段对齐）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineQuery {
    /// 关键词：大小写不敏感子串匹配 summary + detail
    pub keyword: Option<String>,
    /// 类别过滤；空/None 表示全部
    pub kinds: Option<Vec<String>>,
    /// 时间段起（epoch millis，含）；None 表示不限
    pub from_ts: Option<u64>,
    /// 时间段止（epoch millis，含）；None 表示不限
    pub to_ts: Option<u64>,
    pub limit: Option<usize>,
}

/* ---------------- 埋点入口 ---------------- */

/// 追加一条时间线事件：项目无法解析 / 序列化失败 / 写线程不可用时静默返回。
/// 各埋点通用入口（ssh/sftp/ai.rs 后端埋点与 timeline_report 前端上报共用）。
pub(crate) fn append(
    store: &crate::store::Store,
    project_id: &str,
    kind: &str,
    summary: impl Into<String>,
    detail: Option<String>,
) {
    let Some(project_path) = store.project_path(project_id) else {
        return;
    };
    let dir = PathBuf::from(project_path).join(".aishell").join("timeline");
    append_to_dir(&dir, kind, summary, detail);
}

/// 落盘主路径：构造条目（字段裁剪兜底）后交写线程；dir 不存在由写线程惰性创建。
fn append_to_dir(dir: &Path, kind: &str, summary: impl Into<String>, detail: Option<String>) {
    let entry = TimelineEntry {
        ts: now_ms(),
        kind: kind.to_string(),
        summary: clip_graphemes(&summary.into(), MAX_SUMMARY_GRAPHEMES),
        detail: detail.map(|d| clip_graphemes(&d, MAX_DETAIL_GRAPHEMES)),
    };
    let Ok(line) = serde_json::to_string(&entry) else {
        return;
    };
    let Some(tx) = writer_tx() else { return };
    let _ = tx.send(TimelineMsg::Write(WriteMsg {
        path: dir.join(format!("{}.jsonl", date_dir_name(entry.ts))),
        line,
    }));
}

/// 字素级裁剪：超限截断并追加标注（防半截 UTF-8 / 撑爆单行 JSON）。
fn clip_graphemes(s: &str, max: usize) -> String {
    if s.graphemes(true).count() <= max {
        return s.to_string();
    }
    let kept: String = s.graphemes(true).take(max).collect();
    format!("{kept}…(已裁剪)")
}

/* ---------------- 后台写线程 ---------------- */

struct WriteMsg {
    path: PathBuf,
    line: String,
}

enum TimelineMsg {
    Write(WriteMsg),
    /// 搜索/测试前让写线程 flush 全部句柄（ack 回执），保证刚写入的事件可被读到
    Flush { ack: mpsc::Sender<()> },
}

fn writer_tx() -> Option<&'static mpsc::Sender<TimelineMsg>> {
    static TX: LazyLock<Option<mpsc::Sender<TimelineMsg>>> = LazyLock::new(|| {
        let (tx, rx) = mpsc::channel::<TimelineMsg>();
        std::thread::spawn(move || writer_loop(rx));
        Some(tx)
    });
    TX.as_ref()
}

fn writer_loop(rx: mpsc::Receiver<TimelineMsg>) {
    let mut writers: HashMap<PathBuf, BufWriter<std::fs::File>> = HashMap::new();
    // 每个时间线目录当天是否已做过过期清理（日期变了重新清一次）
    let mut cleaned: HashMap<PathBuf, String> = HashMap::new();
    let mut last_flush = Instant::now();
    loop {
        match rx.recv_timeout(FLUSH_INTERVAL) {
            Ok(TimelineMsg::Write(msg)) => {
                // 打开失败跳过该行（不缓存失败，下条消息重试）
                if !writers.contains_key(&msg.path) {
                    if let Some(parent) = msg.path.parent() {
                        let _ = std::fs::create_dir_all(parent);
                        // 每天首次写该目录时顺带清理过期日期文件
                        let dir = parent.to_path_buf();
                        let today = msg
                            .path
                            .file_stem()
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        if cleaned.get(&dir) != Some(&today) {
                            cleanup_expired_in(&dir);
                            cleaned.insert(dir, today);
                        }
                    }
                    if let Ok(f) =
                        std::fs::OpenOptions::new().create(true).append(true).open(&msg.path)
                    {
                        writers.insert(msg.path.clone(), BufWriter::new(f));
                    }
                }
                if let Some(w) = writers.get_mut(&msg.path) {
                    let _ = writeln!(w, "{}", msg.line);
                }
            }
            Ok(TimelineMsg::Flush { ack }) => {
                for w in writers.values_mut() {
                    let _ = w.flush();
                }
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

/// 让写线程 flush（搜索前调用，容忍写线程未启动——无任何写入时本就无数据可读）。
fn flush_writer() {
    if let Some(tx) = writer_tx() {
        let (ack_tx, ack_rx) = mpsc::channel::<()>();
        if tx.send(TimelineMsg::Flush { ack: ack_tx }).is_ok() {
            let _ = ack_rx.recv_timeout(Duration::from_secs(2));
        }
    }
}

/* ---------------- 过期清理 ---------------- */

/// 清理时间线目录下早于「今天 - 30 天」的日期文件；非日期文件名不动。
fn cleanup_expired_in(dir: &Path) {
    let today_days = (now_ms() / 86_400_000) as i64;
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let Some(stem) = p.file_stem().map(|s| s.to_string_lossy().into_owned()) else {
            continue;
        };
        let Some(file_days) = parse_date_dir(&stem) else {
            continue;
        };
        if file_days < today_days - (RETENTION_DAYS - 1) {
            let _ = std::fs::remove_file(&p);
        }
    }
}

/* ---------------- 搜索 ---------------- */

/// 在给定时间线目录上执行搜索：按日期文件倒序读取，倒序（最新在前）返回。
/// 纯磁盘读取（先由调用方 flush 写线程），可单测。
fn search_dir(dir: &Path, q: &TimelineQuery) -> Vec<TimelineEntry> {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let keyword = q
        .keyword
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_lowercase);
    let kinds: Option<Vec<&str>> = q
        .kinds
        .as_deref()
        .filter(|ks| !ks.is_empty())
        .map(|ks| ks.iter().map(String::as_str).collect());

    // 时间段覆盖的日期文件（UTC 天）；不限时回退到目录内全部日期文件
    let files = date_files_in_range(dir, q.from_ts, q.to_ts);
    let mut out: Vec<TimelineEntry> = Vec::new();
    // 文件名即日期，倒序遍历保证整体最新在前；单文件内正序解析后局部反转
    for path in files.into_iter().rev() {
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let mut day_entries: Vec<TimelineEntry> = text
            .lines()
            .filter(|l| !l.trim().is_empty())
            .filter_map(|l| serde_json::from_str::<TimelineEntry>(l).ok())
            .filter(|e| matches_query(e, q.from_ts, q.to_ts, &kinds, &keyword))
            .collect();
        day_entries.reverse();
        out.extend(day_entries);
        if out.len() >= limit {
            out.truncate(limit);
            break;
        }
    }
    out
}

fn matches_query(
    e: &TimelineEntry,
    from_ts: Option<u64>,
    to_ts: Option<u64>,
    kinds: &Option<Vec<&str>>,
    keyword: &Option<String>,
) -> bool {
    if let Some(from) = from_ts {
        if e.ts < from {
            return false;
        }
    }
    if let Some(to) = to_ts {
        if e.ts > to {
            return false;
        }
    }
    if let Some(ks) = kinds {
        if !ks.iter().any(|k| *k == e.kind) {
            return false;
        }
    }
    if let Some(kw) = keyword {
        let in_summary = e.summary.to_lowercase().contains(kw);
        let in_detail = e
            .detail
            .as_deref()
            .map(|d| d.to_lowercase().contains(kw))
            .unwrap_or(false);
        if !in_summary && !in_detail {
            return false;
        }
    }
    true
}

/// 时间段 → 存在的日期文件列表（升序）。from/to 都为 None 时列目录全部日期文件；
/// 否则按天展开（两端钳制在 31 天内防误传大区间扫空目录——超出部分本就被 30 天保留清理）。
fn date_files_in_range(dir: &Path, from_ts: Option<u64>, to_ts: Option<u64>) -> Vec<PathBuf> {
    if from_ts.is_none() && to_ts.is_none() {
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|rd| {
                rd.flatten()
                    .map(|e| e.path())
                    .filter(|p| {
                        p.is_file()
                            && p.extension().is_some_and(|x| x == "jsonl")
                            && p.file_stem()
                                .and_then(|s| s.to_str())
                                .and_then(parse_date_dir)
                                .is_some()
                    })
                    .collect()
            })
            .unwrap_or_default();
        files.sort();
        return files;
    }
    let today = now_ms();
    let from_day = (from_ts.unwrap_or(0) / 86_400_000) as i64;
    let to_day = (to_ts.unwrap_or(today) / 86_400_000) as i64;
    let from_day = from_day.max(to_day - (RETENTION_DAYS - 1));
    let mut files = Vec::new();
    for day in from_day..=to_day {
        let (y, m, d) = crate::trace::civil_from_days(day);
        let path = dir.join(format!("{y:04}-{m:02}-{d:02}.jsonl"));
        if path.is_file() {
            files.push(path);
        }
    }
    files
}

/* ---------------- 命令 ---------------- */

/// 前端事件上报（终端命令区块）：fire-and-forget，失败不影响终端主路径。
#[tauri::command]
pub fn timeline_report(
    store: State<'_, Arc<crate::store::Store>>,
    project_id: String,
    kind: String,
    summary: String,
    detail: Option<String>,
) {
    append(&store, &project_id, &kind, summary, detail);
}

/// 登记 serverId 的项目归属：前端打开 SSH 终端 / SFTP 标签时调用，
/// 之后该连接的 connect/disconnect/exec/传输事件计入该项目时间线（取最近触发方）。
#[tauri::command]
pub async fn timeline_bind_server(
    ssh: State<'_, Arc<crate::ssh::SshManager>>,
    project_id: String,
    server_id: String,
) -> Result<(), String> {
    ssh.bind_project(&server_id, &project_id).await;
    Ok(())
}

/// 时间线搜索（TimelineTab 与 AI timeline_search 工具共用）。
#[tauri::command]
pub fn timeline_search(
    store: State<'_, Arc<crate::store::Store>>,
    project_id: String,
    query: TimelineQuery,
) -> Result<Vec<TimelineEntry>, String> {
    let Some(project_path) = store.project_path(&project_id) else {
        return Err("项目不存在或未设置路径".to_string());
    };
    flush_writer();
    let dir = PathBuf::from(project_path).join(".aishell").join("timeline");
    Ok(search_dir(&dir, &query))
}

/// AI 工具 / 内部分发复用的免 State 版本。
pub(crate) fn search(
    store: &crate::store::Store,
    project_id: &str,
    query: &TimelineQuery,
) -> Result<Vec<TimelineEntry>, String> {
    let Some(project_path) = store.project_path(project_id) else {
        return Err("项目不存在或未设置路径".to_string());
    };
    flush_writer();
    let dir = PathBuf::from(project_path).join(".aishell").join("timeline");
    Ok(search_dir(&dir, query))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trace::{civil_from_days, days_from_civil};

    /// 独立临时目录（照 store.rs 测试惯例：temp_dir + 进程号 + 用例标签，Drop 自动清理）
    struct TestDir(PathBuf);
    impl TestDir {
        fn new(tag: &str) -> Self {
            let base = std::env::temp_dir().join(format!(
                "aishell-timeline-test-{tag}-{}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&base);
            std::fs::create_dir_all(&base).unwrap();
            Self(base)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn entry(ts: u64, kind: &str, summary: &str, detail: Option<&str>) -> TimelineEntry {
        TimelineEntry {
            ts,
            kind: kind.to_string(),
            summary: summary.to_string(),
            detail: detail.map(str::to_string),
        }
    }

    fn write_day(dir: &Path, date: &str, entries: &[TimelineEntry]) {
        std::fs::create_dir_all(dir).unwrap();
        let mut text = String::new();
        for e in entries {
            text.push_str(&serde_json::to_string(e).unwrap());
            text.push('\n');
        }
        std::fs::write(dir.join(format!("{date}.jsonl")), text).unwrap();
    }

    fn day_ms(y: i64, m: u32, d: u32) -> u64 {
        days_from_civil(y, m, d) as u64 * 86_400_000
    }

    #[test]
    fn clip_graphemes_truncates_with_marker() {
        let long = "汉".repeat(600);
        let clipped = clip_graphemes(&long, MAX_SUMMARY_GRAPHEMES);
        assert!(clipped.contains("已裁剪"));
        assert!(clipped.graphemes(true).count() < 600);
        assert_eq!(clip_graphemes("短文本", 10), "短文本");
    }

    #[test]
    fn search_returns_newest_first_across_days() {
        let tmp = TestDir::new("order");
        let dir = tmp.path();
        write_day(dir, "2026-09-07", &[
            entry(day_ms(2026, 9, 7) + 1000, "command", "ls", None),
            entry(day_ms(2026, 9, 7) + 2000, "command", "pwd", None),
        ]);
        write_day(dir, "2026-09-08", &[
            entry(day_ms(2026, 9, 8) + 500, "ssh_connect", "连接 web-1", None),
        ]);
        let out = search_dir(dir, &TimelineQuery::default());
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].kind, "ssh_connect");
        assert_eq!(out[1].summary, "pwd");
        assert_eq!(out[2].summary, "ls");
    }

    #[test]
    fn search_filters_by_keyword_case_insensitive() {
        let tmp = TestDir::new("keyword");
        let dir = tmp.path();
        write_day(dir, "2026-09-08", &[
            entry(day_ms(2026, 9, 8), "command", "git status", Some("On branch Main")),
            entry(day_ms(2026, 9, 8) + 1, "ai_user", "帮我看看 nginx", None),
        ]);
        let q = TimelineQuery { keyword: Some("MAIN".into()), ..Default::default() };
        let out = search_dir(dir, &q);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].summary, "git status"); // detail 命中也算
        let q = TimelineQuery { keyword: Some("nginx".into()), ..Default::default() };
        assert_eq!(search_dir(dir, &q).len(), 1);
        let q = TimelineQuery { keyword: Some("不存在".into()), ..Default::default() };
        assert!(search_dir(dir, &q).is_empty());
    }

    #[test]
    fn search_filters_by_kinds_and_time_range() {
        let tmp = TestDir::new("kinds");
        let dir = tmp.path();
        let base = day_ms(2026, 9, 8);
        write_day(dir, "2026-09-08", &[
            entry(base + 1000, "ssh_connect", "连接", None),
            entry(base + 2000, "command", "ls", None),
            entry(base + 3000, "file_upload", "上传 a.txt", None),
        ]);
        let q = TimelineQuery { kinds: Some(vec!["command".into(), "file_upload".into()]), ..Default::default() };
        let out = search_dir(dir, &q);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].kind, "file_upload");
        let q = TimelineQuery { from_ts: Some(base + 1500), to_ts: Some(base + 2500), ..Default::default() };
        let out = search_dir(dir, &q);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].summary, "ls");
    }

    #[test]
    fn search_range_picks_only_relevant_date_files() {
        let tmp = TestDir::new("range");
        let dir = tmp.path();
        write_day(dir, "2026-09-06", &[entry(day_ms(2026, 9, 6), "command", "前一天", None)]);
        write_day(dir, "2026-09-07", &[entry(day_ms(2026, 9, 7), "command", "当天", None)]);
        let q = TimelineQuery {
            from_ts: Some(day_ms(2026, 9, 7)),
            to_ts: Some(day_ms(2026, 9, 7) + 86_399_999),
            ..Default::default()
        };
        let out = search_dir(dir, &q);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].summary, "当天");
    }

    #[test]
    fn search_respects_limit() {
        let tmp = TestDir::new("limit");
        let dir = tmp.path();
        let entries: Vec<TimelineEntry> = (0..10)
            .map(|i| entry(day_ms(2026, 9, 8) + i, "command", &format!("cmd{i}"), None))
            .collect();
        write_day(dir, "2026-09-08", &entries);
        let q = TimelineQuery { limit: Some(3), ..Default::default() };
        let out = search_dir(dir, &q);
        assert_eq!(out.len(), 3);
        assert_eq!(out[0].summary, "cmd9"); // 最新在前
    }

    #[test]
    fn search_tolerates_malformed_lines() {
        let tmp = TestDir::new("malformed");
        let dir = tmp.path();
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("2026-09-08.jsonl"),
            "not json\n{\"ts\":1,\"kind\":\"command\",\"summary\":\"ok\"}\n\n",
        )
        .unwrap();
        let out = search_dir(dir, &TimelineQuery::default());
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].summary, "ok");
    }

    #[test]
    fn cleanup_removes_files_older_than_retention() {
        let tmp = TestDir::new("cleanup");
        let dir = tmp.path();
        let today = date_dir_name(now_ms());
        let old_day = days_from_civil(2020, 1, 1);
        let (y, m, d) = civil_from_days(old_day);
        let old = format!("{y:04}-{m:02}-{d:02}");
        write_day(dir, &today, &[entry(now_ms(), "command", "新", None)]);
        write_day(dir, &old, &[entry(0, "command", "旧", None)]);
        std::fs::write(dir.join("notes.txt"), "非日期文件不动").unwrap();
        cleanup_expired_in(dir);
        assert!(dir.join(format!("{today}.jsonl")).exists());
        assert!(!dir.join(format!("{old}.jsonl")).exists());
        assert!(dir.join("notes.txt").exists());
    }

    #[test]
    fn append_to_dir_writes_parseable_line() {
        let tmp = TestDir::new("append");
        let dir = tmp.path().join("timeline");
        append_to_dir(&dir, "command", "echo hi", Some("hi".into()));
        flush_writer();
        let today = date_dir_name(now_ms());
        let text = std::fs::read_to_string(dir.join(format!("{today}.jsonl"))).unwrap();
        let e: TimelineEntry = serde_json::from_str(text.trim()).unwrap();
        assert_eq!(e.kind, "command");
        assert_eq!(e.summary, "echo hi");
        assert_eq!(e.detail.as_deref(), Some("hi"));
    }
}
