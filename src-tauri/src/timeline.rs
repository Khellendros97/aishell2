//! 项目时间线：跨 SSH/终端命令/SFTP/AI 会话的统一事件流水，按项目落盘、可搜索。
//!
//! 目录组织：`<项目>/.aishell/timeline/YYYY-MM-DD.jsonl`（日期按 UTC，与 trace.rs 一致），
//! 每行一个 JSON：`{"ts": <epoch-millis>, "kind": "<类别>", "summary": "...", "detail": "..."}`。
//! 类别（kind）：
//! - `ssh_connect` / `ssh_disconnect`  SSH 连接建立/断开（ssh.rs 连接池埋点）
//! - `command`        命令执行（终端区块上报 / SFTP 面板远程命令；AI run_command 由 ai_tool 事件覆盖，不另写）
//! - `file_upload` / `file_download`    SFTP 传输完成（手动通道与 AI 通道）
//! - `ai_user` / `ai_assistant` / `ai_tool`  AI 会话的用户提问 / 助手回复 / 工具调用
//! - `skill`          AI read 读取 SKILL.md（解析为技能事件，替换该次的 ai_tool）
//!
//! 写入仿 trace.rs：全局 mpsc + 单后台写线程（BufWriter，500ms 周期 flush），
//! 埋点失败静默、绝不影响主路径；与 trace 不同——时间线是长期事实记录，无开关、默认常开。
//! 保留 30 天：写线程每天首次写某项目目录时清理过期日期文件（无独立定时任务，
//! 不活跃的项目不产生 IO；搜索路径只读存在的时间段文件）。
//! 与 trace.rs（7 天调试日志）互不依赖，仅复用其日期换算纯函数。
//!
//! 标签：存储在同目录 sidecar `tags.jsonl`（非日期文件名，不受过期清理影响），
//! 每行一个 TimelineTag `{ts, name, color, anchorTs, anchorKind}`，anchor 用
//! (ts, kind) 定位被打标的事件（事件无独立 id，毫秒+类别实践中足够唯一）。
//! 两个同名标签构成「标签对」：按 anchorTs 排序后相邻两两配对，划定的时间选区内
//! 的事件与直接被打标的事件一样获得着色（奇数个时最后一个落单仅为单标签）。
//! 搜索关键词支持 `#标签名` token（可多个，AND 语义）：命中直接打标或处于该标签
//! 选区内的事件；返回条目经 `tags` 字段带回标签名/颜色/是否直接打标。

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
/// 标签名裁剪上限（字素）与默认颜色（非法颜色输入回退到它）
const MAX_TAG_NAME_GRAPHEMES: usize = 64;
const DEFAULT_TAG_COLOR: &str = "#4f8ef7";
/// 标签 sidecar 文件名（非日期文件名，cleanup_expired_in 不会动它）
const TAGS_FILE: &str = "tags.jsonl";

/// 时间线条目（与前端 types.ts TimelineEntry 逐字段对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub ts: u64,
    pub kind: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// 搜索时回填的标签标注（不落盘：写入路径恒为 None）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<TimelineTagInfo>>,
}

/// 条目命中的标签（与前端 types.ts TimelineTagInfo 对齐）：
/// direct=true 表示事件被直接打标，false 表示仅处于该标签的选区内。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTagInfo {
    pub name: String,
    pub color: String,
    pub direct: bool,
}

/// 一条标签记录（tags.jsonl 行格式，与前端 types.ts TimelineTag 对齐）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTag {
    /// 打标时间（epoch millis）
    pub ts: u64,
    pub name: String,
    /// #rrggbb
    pub color: String,
    /// 被打标事件的定位锚点
    pub anchor_ts: u64,
    pub anchor_kind: String,
}

/// 搜索条件（与前端 types.ts TimelineQuery 逐字段对齐）。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineQuery {
    /// 关键词：大小写不敏感子串匹配 summary + detail；`#标签名` token 按标签过滤（可多个，AND）
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
        tags: None,
    };
    let Ok(line) = serde_json::to_string(&entry) else {
        return;
    };
    send_line(&dir.join(format!("{}.jsonl", date_dir_name(entry.ts))), line);
}

/// 把一行 JSON 交后台写线程追加到指定文件（写线程负责建目录与过期清理）。
fn send_line(path: &Path, line: String) {
    let Some(tx) = writer_tx() else { return };
    let _ = tx.send(TimelineMsg::Write(WriteMsg {
        path: path.to_path_buf(),
        line,
    }));
}

/// 同步追加一行（仅 tags.jsonl 用）：用户驱动、低频，直写让 IO 错误可上报、落盘即可读。
/// 关键是**不能走写线程**：写线程按路径缓存文件句柄，而 tags.jsonl 会被 rewrite_tags
/// 原子替换（rename）——替换后写线程仍持有旧句柄（指向已删除的文件对象），
/// 后续追加全部写进"幽灵文件"，表现为删除标签后再也打不上任何标签。
fn append_line_sync(path: &Path, line: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("标签目录创建失败：{e}"))?;
    }
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("标签文件打开失败：{e}"))?;
    writeln!(f, "{line}").map_err(|e| format!("标签写入失败：{e}"))?;
    Ok(())
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

/* ---------------- 标签 ---------------- */

/// 打标签：名称/颜色校验后同步追加到 tags.jsonl（同步直写，见 append_line_sync 注释）。
/// 名称去空白、剥开头 `#`；不允许内部含空白（`#tag` 搜索语法按空白分词，含空白的名字搜不到）。
fn tag_add_to_dir(
    dir: &Path,
    name: &str,
    color: &str,
    anchor_ts: u64,
    anchor_kind: &str,
) -> Result<TimelineTag, String> {
    let name = normalize_tag_name(name)?;
    let color = if is_hex_color(color) {
        color.to_lowercase()
    } else {
        DEFAULT_TAG_COLOR.to_string()
    };
    let tag = TimelineTag {
        ts: now_ms(),
        name,
        color,
        anchor_ts,
        anchor_kind: anchor_kind.to_string(),
    };
    let line = serde_json::to_string(&tag).map_err(|e| format!("标签序列化失败：{e}"))?;
    append_line_sync(&dir.join(TAGS_FILE), &line)?;
    Ok(tag)
}

fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(|c| c.is_ascii_hexdigit())
}

/// 标签名归一化（去空白、剥开头 #、禁内部空白、字素裁剪）；供 add/reclose 共用。
fn normalize_tag_name(name: &str) -> Result<String, String> {
    let name = name.trim().trim_start_matches('#');
    if name.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    if name.chars().any(char::is_whitespace) {
        return Err("标签名不能包含空格（#标签 搜索按空格分词）".to_string());
    }
    Ok(clip_graphemes(name, MAX_TAG_NAME_GRAPHEMES))
}

/// 原子重写 tags.jsonl（tmp+rename；标签全走 append_line_sync 同步直写，
/// 不存在写线程缓冲行，也无残留句柄问题）。坏行原样保留。返回被剔除的标签条数。
fn rewrite_tags(dir: &Path, keep: impl Fn(&TimelineTag) -> bool) -> Result<u32, String> {
    let path = dir.join(TAGS_FILE);
    let text = std::fs::read_to_string(&path).unwrap_or_default();
    let mut lines: Vec<String> = Vec::new();
    let mut removed = 0u32;
    for l in text.lines().filter(|l| !l.trim().is_empty()) {
        match serde_json::from_str::<TimelineTag>(l) {
            Ok(t) if !keep(&t) => removed += 1,
            Ok(t) => lines.push(serde_json::to_string(&t).map_err(|e| e.to_string())?),
            Err(_) => lines.push(l.to_string()),
        }
    }
    let tmp = dir.join(format!("{TAGS_FILE}.tmp"));
    let body = if lines.is_empty() {
        String::new()
    } else {
        format!("{}\n", lines.join("\n"))
    };
    std::fs::write(&tmp, body).map_err(|e| format!("标签写入失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("标签保存失败：{e}"))?;
    Ok(removed)
}

/// 删除标签：按 (name, anchorTs, anchorKind) 匹配（同名同锚点的多条一并删除）。
fn tag_remove_in_dir(
    dir: &Path,
    name: &str,
    anchor_ts: u64,
    anchor_kind: &str,
) -> Result<u32, String> {
    let name = normalize_tag_name(name)?.to_lowercase();
    let removed = rewrite_tags(dir, |t| {
        !(t.name.to_lowercase() == name && t.anchor_ts == anchor_ts && t.anchor_kind == anchor_kind)
    })?;
    if removed == 0 {
        return Err("标签已不存在，请刷新后重试".to_string());
    }
    Ok(removed)
}

/// 更新闭合位置：把该标签名最近一个已闭合选区的「结束锚点」移到新事件上
/// （删除旧结束锚点、按被删标签的颜色补一条新锚点）。无闭合选区时报错。
fn tag_reclose_in_dir(
    dir: &Path,
    name: &str,
    anchor_ts: u64,
    anchor_kind: &str,
) -> Result<TimelineTag, String> {
    let name = normalize_tag_name(name)?;
    let name_lower = name.to_lowercase();
    // 同名标签按锚点排序后相邻配对，取最后一对的第二个（闭合端）
    let mut group: Vec<TimelineTag> = load_tags(dir)
        .into_iter()
        .filter(|t| t.name.to_lowercase() == name_lower)
        .collect();
    group.sort_by_key(|t| t.anchor_ts);
    let Some(closing) = group.chunks_exact(2).last().map(|pair| pair[1].clone()) else {
        return Err(format!("标签「{name}」没有已闭合的选区"));
    };
    // 按打标 ts 精确定位那一条记录删除（同名同锚点可能存在多条，只删闭合端这条）
    rewrite_tags(dir, |t| t.ts != closing.ts)?;
    let tag = TimelineTag {
        ts: now_ms(),
        name,
        color: closing.color,
        anchor_ts,
        anchor_kind: anchor_kind.to_string(),
    };
    let line = serde_json::to_string(&tag).map_err(|e| format!("标签序列化失败：{e}"))?;
    append_line_sync(&dir.join(TAGS_FILE), &line)?;
    Ok(tag)
}

/// 读取 tags.jsonl 全部标签（坏行跳过；锚点已超出保留期的标签视为失效丢弃）。
fn load_tags(dir: &Path) -> Vec<TimelineTag> {
    let Ok(text) = std::fs::read_to_string(dir.join(TAGS_FILE)) else {
        return Vec::new();
    };
    let cutoff = now_ms().saturating_sub((RETENTION_DAYS as u64) * 86_400_000);
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<TimelineTag>(l).ok())
        .filter(|t| t.anchor_ts >= cutoff)
        .collect()
}

/// 标签索引：直接锚点 + 同名两两配对的时间选区（搜索过滤与条目标注共用）。
struct TagIndex {
    anchors: Vec<TimelineTag>,
    /// (小写名, 选区起, 选区止, 颜色)；起止为锚点事件的 ts（含边界）
    regions: Vec<(String, u64, u64, String)>,
}

impl TagIndex {
    fn build(tags: Vec<TimelineTag>) -> Self {
        // 同名（大小写不敏感）按锚点 ts 排序后相邻配对：(1,2)、(3,4)…，落单的仅为单标签
        let mut by_name: HashMap<String, Vec<&TimelineTag>> = HashMap::new();
        for t in &tags {
            by_name.entry(t.name.to_lowercase()).or_default().push(t);
        }
        let mut regions = Vec::new();
        for mut group in by_name.into_values() {
            group.sort_by_key(|t| t.anchor_ts);
            for pair in group.chunks_exact(2) {
                regions.push((
                    pair[0].name.to_lowercase(),
                    pair[0].anchor_ts,
                    pair[1].anchor_ts,
                    pair[0].color.clone(),
                ));
            }
        }
        Self { anchors: tags, regions }
    }

    /// 条目是否命中指定标签（大小写不敏感）：直接打标或处于该标签选区内
    fn matches(&self, e: &TimelineEntry, name_lower: &str) -> bool {
        self.anchors.iter().any(|t| {
            t.name.to_lowercase() == name_lower
                && t.anchor_ts == e.ts
                && t.anchor_kind == e.kind
        }) || self
            .regions
            .iter()
            .any(|(n, from, to, _)| n == name_lower && e.ts >= *from && e.ts <= *to)
    }

    /// 条目的标签标注（直接打标优先；同名兼有选区命中时只保留直接项）
    fn info_for(&self, e: &TimelineEntry) -> Option<Vec<TimelineTagInfo>> {
        let mut out: Vec<TimelineTagInfo> = Vec::new();
        for t in &self.anchors {
            if t.anchor_ts == e.ts && t.anchor_kind == e.kind {
                out.push(TimelineTagInfo {
                    name: t.name.clone(),
                    color: t.color.clone(),
                    direct: true,
                });
            }
        }
        for (n, from, to, color) in &self.regions {
            if e.ts >= *from && e.ts <= *to && !out.iter().any(|i| i.name.to_lowercase() == *n) {
                let name = self
                    .anchors
                    .iter()
                    .find(|t| t.name.to_lowercase() == *n)
                    .map(|t| t.name.clone())
                    .unwrap_or_else(|| n.clone());
                out.push(TimelineTagInfo {
                    name,
                    color: color.clone(),
                    direct: false,
                });
            }
        }
        if out.is_empty() { None } else { Some(out) }
    }
}

/// 关键词拆词：`#标签` token（去 # 小写归一，多个 AND）+ 剩余文本条件（照 parseSearchQuery 先例）。
fn split_keyword_tags(keyword: Option<&str>) -> (Vec<String>, Option<String>) {
    let Some(kw) = keyword.map(str::trim).filter(|s| !s.is_empty()) else {
        return (Vec::new(), None);
    };
    let mut tags: Vec<String> = Vec::new();
    let mut words: Vec<&str> = Vec::new();
    for token in kw.split_whitespace() {
        if token.starts_with('#') && token.len() > 1 {
            let t = token[1..].to_lowercase();
            if !tags.contains(&t) {
                tags.push(t);
            }
        } else {
            words.push(token);
        }
    }
    let text = if words.is_empty() {
        None
    } else {
        Some(words.join(" ").to_lowercase())
    };
    (tags, text)
}

/* ---------------- 搜索 ---------------- */

/// 在给定时间线目录上执行搜索：按日期文件倒序读取，倒序（最新在前）返回。
/// 纯磁盘读取（先由调用方 flush 写线程），可单测。
/// 关键词中的 `#标签` token 走标签索引过滤；返回条目回填 tags 标注（直接打标/选区命中）。
fn search_dir(dir: &Path, q: &TimelineQuery) -> Vec<TimelineEntry> {
    let limit = q.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
    let (tag_filter, keyword) = split_keyword_tags(q.keyword.as_deref());
    let tag_index = TagIndex::build(load_tags(dir));
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
            .filter(|e| tag_filter.iter().all(|t| tag_index.matches(e, t)))
            .collect();
        day_entries.reverse();
        out.extend(day_entries);
        if out.len() >= limit {
            out.truncate(limit);
            break;
        }
    }
    for e in &mut out {
        e.tags = tag_index.info_for(e);
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

/// 给事件打标签（TimelineTab 右键「标签」入口）：anchorTs/anchorKind 定位被打标的事件。
/// 两个同名标签自动构成标签对划定选区；颜色非法时回退默认色。
#[tauri::command]
pub fn timeline_tag_add(
    store: State<'_, Arc<crate::store::Store>>,
    project_id: String,
    name: String,
    color: String,
    anchor_ts: u64,
    anchor_kind: String,
) -> Result<TimelineTag, String> {
    let Some(project_path) = store.project_path(&project_id) else {
        return Err("项目不存在或未设置路径".to_string());
    };
    let dir = PathBuf::from(project_path).join(".aishell").join("timeline");
    tag_add_to_dir(&dir, &name, &color, anchor_ts, &anchor_kind)
}

/// 删除标签（TimelineTab 右键「删除标签」）：按 (name, anchorTs, anchorKind) 匹配删除。
#[tauri::command]
pub fn timeline_tag_remove(
    store: State<'_, Arc<crate::store::Store>>,
    project_id: String,
    name: String,
    anchor_ts: u64,
    anchor_kind: String,
) -> Result<u32, String> {
    let Some(project_path) = store.project_path(&project_id) else {
        return Err("项目不存在或未设置路径".to_string());
    };
    let dir = PathBuf::from(project_path).join(".aishell").join("timeline");
    tag_remove_in_dir(&dir, &name, anchor_ts, &anchor_kind)
}

/// 更新闭合位置（打标时该名称已有闭合选区，用户选择「更新闭合位置」）：
/// 最近一个闭合选区的结束锚点移到 (anchorTs, anchorKind)，沿用原颜色。
#[tauri::command]
pub fn timeline_tag_reclose(
    store: State<'_, Arc<crate::store::Store>>,
    project_id: String,
    name: String,
    anchor_ts: u64,
    anchor_kind: String,
) -> Result<TimelineTag, String> {
    let Some(project_path) = store.project_path(&project_id) else {
        return Err("项目不存在或未设置路径".to_string());
    };
    let dir = PathBuf::from(project_path).join(".aishell").join("timeline");
    tag_reclose_in_dir(&dir, &name, anchor_ts, &anchor_kind)
}

/// 列出项目时间线的全部标签记录（按打标时间倒序；前端按名去重取最新颜色）。
#[tauri::command]
pub fn timeline_tags(
    store: State<'_, Arc<crate::store::Store>>,
    project_id: String,
) -> Result<Vec<TimelineTag>, String> {
    let Some(project_path) = store.project_path(&project_id) else {
        return Err("项目不存在或未设置路径".to_string());
    };
    flush_writer();
    let dir = PathBuf::from(project_path).join(".aishell").join("timeline");
    let mut tags = load_tags(&dir);
    tags.sort_by_key(|t| std::cmp::Reverse(t.ts));
    Ok(tags)
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
            tags: None,
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
        assert!(e.tags.is_none(), "落盘条目不应带 tags 标注");
    }

    #[test]
    fn tag_add_validates_name_and_color() {
        let tmp = TestDir::new("tagadd");
        let dir = tmp.path();
        assert!(tag_add_to_dir(dir, "  ", "#fff", 1, "command").is_err());
        assert!(tag_add_to_dir(dir, "有空 格", "#fff", 1, "command").is_err());
        // 剥开头 #、非法颜色回退默认色
        let tag = tag_add_to_dir(dir, "#部署", "红色", 1000, "command").unwrap();
        assert_eq!(tag.name, "部署");
        assert_eq!(tag.color, DEFAULT_TAG_COLOR);
        let tag = tag_add_to_dir(dir, "发版", "#FFAA00", 2000, "command").unwrap();
        assert_eq!(tag.color, "#ffaa00", "合法颜色小写归一");
        flush_writer();
        let tags = load_tags(dir);
        // anchor_ts 1000/2000 已超出 30 天保留期 → 视为失效
        assert!(tags.is_empty(), "过期锚点的标签应被丢弃");
    }

    /// 造一组今天的事件 + 标签锚点（锚点须在保留期内，故用 now_ms 偏移）
    fn tag_fixture(dir: &Path) -> Vec<u64> {
        let base = now_ms() - 60_000;
        let today = date_dir_name(base);
        write_day(dir, &today, &[
            entry(base, "command", "git pull", None),
            entry(base + 1000, "command", "cargo build", None),
            entry(base + 2000, "file_upload", "上传 dist.zip", None),
            entry(base + 3000, "command", "systemctl restart app", None),
            entry(base + 4000, "ai_user", "部署完了吗", None),
        ]);
        let mut tags = String::new();
        for t in [
            TimelineTag { ts: base + 5000, name: "部署".into(), color: "#e5534b".into(), anchor_ts: base, anchor_kind: "command".into() },
            TimelineTag { ts: base + 5001, name: "部署".into(), color: "#e5534b".into(), anchor_ts: base + 3000, anchor_kind: "command".into() },
            TimelineTag { ts: base + 5002, name: "重点".into(), color: "#4ec98a".into(), anchor_ts: base + 4000, anchor_kind: "ai_user".into() },
        ] {
            tags.push_str(&serde_json::to_string(&t).unwrap());
            tags.push('\n');
        }
        std::fs::write(dir.join(TAGS_FILE), tags).unwrap();
        (base..=base + 4000).step_by(1000).collect()
    }

    #[test]
    fn search_annotates_direct_tags_and_pair_region() {
        let tmp = TestDir::new("taganno");
        let dir = tmp.path();
        let ts = tag_fixture(dir);
        let out = search_dir(dir, &TimelineQuery::default());
        assert_eq!(out.len(), 5);
        let by_ts = |t: u64| out.iter().find(|e| e.ts == t).unwrap();
        // 直接打标：首条与第四条
        let tags = by_ts(ts[0]).tags.as_ref().unwrap();
        assert!(tags.iter().any(|i| i.name == "部署" && i.direct));
        let tags = by_ts(ts[3]).tags.as_ref().unwrap();
        assert!(tags.iter().any(|i| i.name == "部署" && i.direct));
        // 选区内（标签对锚点之间）：第二、三条带「部署」非直接标注
        let tags = by_ts(ts[1]).tags.as_ref().unwrap();
        assert!(tags.iter().any(|i| i.name == "部署" && !i.direct && i.color == "#e5534b"));
        let tags = by_ts(ts[2]).tags.as_ref().unwrap();
        assert!(tags.iter().any(|i| i.name == "部署" && !i.direct));
        // 选区外的第五条只有自己的单标签（不成对、无选区）
        let tags = by_ts(ts[4]).tags.as_ref().unwrap();
        assert_eq!(tags.len(), 1);
        assert!(tags[0].name == "重点" && tags[0].direct);
    }

    #[test]
    fn search_filters_by_hash_tag_syntax() {
        let tmp = TestDir::new("tagfilter");
        let dir = tmp.path();
        let ts = tag_fixture(dir);
        // #部署：命中两个锚点 + 选区内两条，不含选区外的 ai_user
        let q = TimelineQuery { keyword: Some("#部署".into()), ..Default::default() };
        let out = search_dir(dir, &q);
        let got: Vec<u64> = out.iter().map(|e| e.ts).collect();
        assert_eq!(got, vec![ts[3], ts[2], ts[1], ts[0]], "倒序：锚点+选区内事件");
        // #重点：单标签只命中直接打标事件；大小写不敏感
        let q = TimelineQuery { keyword: Some("#重点".into()), ..Default::default() };
        let out = search_dir(dir, &q);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].ts, ts[4]);
        // #标签 + 文本条件叠加（AND）
        let q = TimelineQuery { keyword: Some("#部署 build".into()), ..Default::default() };
        let out = search_dir(dir, &q);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].summary, "cargo build");
        // 不存在的标签 → 空
        let q = TimelineQuery { keyword: Some("#没有".into()), ..Default::default() };
        assert!(search_dir(dir, &q).is_empty());
    }

    #[test]
    fn tag_remove_deletes_anchor_and_region_updates() {
        let tmp = TestDir::new("tagremove");
        let dir = tmp.path();
        let ts = tag_fixture(dir);
        // 删掉「部署」的闭合端（anchor=ts[3]）：选区应消失，只剩单标签
        let removed = tag_remove_in_dir(dir, "部署", ts[3], "command").unwrap();
        assert_eq!(removed, 1);
        let out = search_dir(dir, &TimelineQuery::default());
        let by_ts = |t: u64| out.iter().find(|e| e.ts == t).unwrap();
        assert!(by_ts(ts[0]).tags.as_ref().unwrap().iter().any(|i| i.direct));
        assert!(by_ts(ts[1]).tags.is_none(), "选区应随闭合端删除而消失");
        // 再删一次同一锚点 → 中文报错
        assert!(tag_remove_in_dir(dir, "部署", ts[3], "command").is_err());
        // 名字归一（大小写/#前缀）后也能删
        assert_eq!(tag_remove_in_dir(dir, "#重点", ts[4], "ai_user").unwrap(), 1);
    }

    #[test]
    fn tag_reclose_moves_closing_anchor() {
        let tmp = TestDir::new("tagreclose");
        let dir = tmp.path();
        let ts = tag_fixture(dir);
        // 单标签无闭合选区 → 报错
        assert!(tag_reclose_in_dir(dir, "重点", ts[1], "command").is_err());
        // 「部署」选区 [ts0, ts3] 闭合端移到 ts[4]（沿用原色）
        let tag = tag_reclose_in_dir(dir, "部署", ts[4], "ai_user").unwrap();
        assert_eq!(tag.color, "#e5534b");
        assert_eq!(tag.anchor_ts, ts[4]);
        flush_writer();
        let out = search_dir(dir, &TimelineQuery::default());
        let by_ts = |t: u64| out.iter().find(|e| e.ts == t).unwrap();
        // 旧闭合端 ts[3] 不再是直接打标，但处于新选区 [ts0, ts4] 内
        let t3 = by_ts(ts[3]).tags.as_ref().unwrap();
        assert!(t3.iter().any(|i| i.name == "部署" && !i.direct));
        assert!(!t3.iter().any(|i| i.name == "部署" && i.direct));
        // 新闭合端 ts[4] 直接打标（同时还有自己的「重点」）
        let t4 = by_ts(ts[4]).tags.as_ref().unwrap();
        assert!(t4.iter().any(|i| i.name == "部署" && i.direct));
        // 选区外的无标注场景：起点之前的没有
        assert_eq!(load_tags(dir).iter().filter(|t| t.name == "部署").count(), 2, "仍是两个标签");
    }

    /// 回归：删除标签触发 tags.jsonl 原子重写后，后续打标（任意名称/颜色）必须落盘可读
    /// （历史 bug：标签走写线程缓存句柄，rename 替换后追加全写进已删除的旧文件）。
    #[test]
    fn tag_add_still_works_after_remove_rewrite() {
        let tmp = TestDir::new("tagrewrite");
        let dir = tmp.path();
        let base = now_ms() - 60_000;
        tag_add_to_dir(dir, "部署", "#e5534b", base, "command").unwrap();
        tag_add_to_dir(dir, "部署", "#e5534b", base + 1000, "command").unwrap();
        tag_remove_in_dir(dir, "部署", base + 1000, "command").unwrap();
        tag_add_to_dir(dir, "新标签", "#4ec98a", base + 2000, "command").unwrap();
        let names: Vec<String> = load_tags(dir).iter().map(|t| t.name.clone()).collect();
        assert_eq!(names, vec!["部署".to_string(), "新标签".to_string()]);
    }
}
