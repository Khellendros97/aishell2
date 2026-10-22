//! AI 会话历史修复：pi 会话 jsonl 的结构校验与修复（右键菜单「修复会话」）。
//!
//! 背景：发给 LLM 的上下文由 pi 沿 parentId 链从叶子回溯构建，途中遇 compaction 用摘要
//! 截断（resources/pi/docs/session-format.md「Context Building」）。当压缩切割点落在
//! 「assistant(toolCalls) → toolResult」块中间（或工具结果缺失）时，构建出的消息序列会
//! 出现孤儿 role:"tool"，OpenAI 兼容端点直接 400（Messages with role "tool" must be a
//! response to a preceding message with "tool_calls"），且坏上下文随会话文件持久化、
//! 重试永远复现。
//!
//! 修复策略（保守：只动会进入模型上下文的「有效区域」）：
//! - 从最后一行沿 parentId 回溯确定叶子链，取链上最后一个 compaction 为切割点；切割点
//!   之前的条目已被摘要覆盖、不参与上下文构建，一律原样保留。
//! - 有效区域内先按 pi `buildSessionProjection` 语义叠加 context_edit：同一 target 以链上
//!   最后一条编辑为准，`replacement: null` 表示把该条从模型上下文剔除。**剔除必须参与配对
//!   判定**——pi 的 length/overflow 恢复会省略「被放弃的 assistant 尝试」，但其
//!   `_prepareRun` / `_prepareRetry` 路径只省略 assistant、把工具结果留在上下文里；只按原始
//!   条目做配对检查会误判为健康（「修复会话」修不好的正是这一类），端点则持续 400。
//! - 可见消息按模型上下文顺序校验「assistant(toolCalls) → 紧邻 toolResult」：无主的、
//!   顺序错位的、重复应答的 toolResult → 删除；assistant 的 toolCall 缺结果 → 合成
//!   isError 结果补齐（缺失同样会被端点拒绝）。
//! - compaction 自带 firstKeptEntryId / retainedTail 时按文档语义纳入保留范围一并校验。
//!
//! 修复必须先 `AiManager::kill_session` 等待 pi 进程退出（内存态独占写文件）；下次 ai_chat
//! 按同一文件懒重启加载修复后内容。杀进程重启本身也能治愈 pi 进程内的内存态损坏。
//!
//! 三个入口共用本模块：右键「修复会话」（手动，报告全部变更）；`ai_chat` 发送前预检
//! （自动，仅结构性损坏时杀进程+备份+写回，见 `auto_repair_session`）；回合终态错误后的
//! 异步检测（`detect_session_corruption` —— 空闲时立即调用 `auto_repair_session` 修复，
//! 生成中则留给下一次发送前预检）。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngExt;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::ai::AiManager;

/// 补齐缺失结果时的占位正文（isError=true，模型可据此知道结果不可用）。
const MISSING_RESULT_TEXT: &str = "（结果缺失，已由会话修复自动补齐）";

/// 修复报告（serde camelCase 与前端 src/types.ts 的 AiRepairReport 对齐）。
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiRepairReport {
    /// 原文件总行数（不含空行）
    pub total_lines: usize,
    /// 无法解析被丢弃的行数
    pub dropped_malformed: u32,
    /// 删除的孤儿工具结果数
    pub removed_orphan_tool_results: u32,
    /// 补齐的缺失工具结果数
    pub filled_missing_tool_results: u32,
    /// 是否发生了任何修改
    pub changed: bool,
}

/// 解析后的条目：保留原始行，未修改的条目按原字符串写回（避免 JSON 重序列化改动键序）。
struct Entry {
    v: Value,
    raw: String,
    modified: bool,
}

impl Entry {
    fn id(&self) -> &str {
        self.v["id"].as_str().unwrap_or("")
    }
    fn parent_id(&self) -> Option<&str> {
        self.v["parentId"].as_str()
    }
    fn kind(&self) -> &str {
        self.v["type"].as_str().unwrap_or("")
    }
}

fn parse_entry(line: &str) -> Option<Entry> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v["type"].as_str().is_none() || v["id"].as_str().is_none() {
        return None;
    }
    Some(Entry { raw: line.to_string(), v, modified: false })
}

/// 上下文可见位置：retainedTail 内的消息下标 / 链上条目下标。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VisLoc {
    Tail(usize),
    Entry(usize),
}

/// 可见消息的配对语义（pi 把条目转成消息后的角色形状）。
enum VisKind {
    /// assistant + 它携带的 (toolCallId, toolName)
    Assistant(Vec<(String, String)>),
    /// toolResult + 应答的 toolCallId
    ToolResult(String),
    /// 其它消息（user/system/custom_message/branch_summary）：结束当前工具块
    Barrier,
}

struct VisMsg {
    loc: VisLoc,
    kind: VisKind,
}

/// 从 content 块数组提取 toolCall（原始条目与 context_edit replacement 共用）。
fn calls_from_content(content: &Value) -> Vec<(String, String)> {
    let Some(blocks) = content.as_array() else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|b| b["type"].as_str() == Some("toolCall"))
        .filter_map(|b| {
            let id = b["id"].as_str()?;
            if id.is_empty() {
                return None;
            }
            Some((id.to_string(), b["name"].as_str().unwrap_or("").to_string()))
        })
        .collect()
}

fn classify_message(message: &Value) -> VisKind {
    match message["role"].as_str() {
        Some("assistant") => VisKind::Assistant(calls_from_content(&message["content"])),
        Some("toolResult") => VisKind::ToolResult(
            message["toolCallId"].as_str().unwrap_or("").to_string(),
        ),
        _ => VisKind::Barrier,
    }
}

/// 上下文编辑的生效结果（同一 target 取链上最后一条）。
enum ContextEdit {
    Omit,
    Replace(Value),
}

/// 收集有效区域内全部 context_edit：targetId → 最新编辑（链上顺序覆盖）。
fn latest_context_edits(
    slots: &[Option<Entry>],
    effective: &[usize],
) -> HashMap<String, ContextEdit> {
    let mut edits: HashMap<String, ContextEdit> = HashMap::new();
    for &i in effective {
        let Some(entry) = slots[i].as_ref() else { continue };
        if entry.kind() != "context_edit" {
            continue;
        }
        let Some(target) = entry.v["targetId"].as_str() else { continue };
        let edit = match entry.v.get("replacement") {
            None | Some(Value::Null) => ContextEdit::Omit,
            Some(replacement) => ContextEdit::Replace(replacement.clone()),
        };
        edits.insert(target.to_string(), edit);
    }
    edits
}

/// replacement 的正文形状：字符串按 pi 规则归一为单个 text 块。
fn replacement_content(replacement: &Value) -> Value {
    match replacement {
        Value::Array(_) => replacement.clone(),
        Value::String(text) => json!([{ "type": "text", "text": text }]),
        _ => json!([]),
    }
}

/// 有效区域（切割点之后 + firstKept 保留段）的可见消息，已叠加 context_edit。
/// 非上下文条目（model_change / thinking_level_change / context_edit 等）不产生消息。
fn effective_visible_messages(
    slots: &[Option<Entry>],
    effective: &[usize],
    edits: &HashMap<String, ContextEdit>,
) -> Vec<VisMsg> {
    let mut visible = Vec::new();
    for &i in effective {
        let Some(entry) = slots[i].as_ref() else { continue };
        let kind = entry.kind();
        if kind != "message" && kind != "custom_message" && kind != "branch_summary" {
            continue;
        }
        match edits.get(entry.id()) {
            Some(ContextEdit::Omit) => continue,
            Some(ContextEdit::Replace(replacement)) if kind == "message" => {
                let message = &entry.v["message"];
                let kind = match message["role"].as_str() {
                    Some("assistant") => {
                        VisKind::Assistant(calls_from_content(&replacement_content(replacement)))
                    }
                    Some("toolResult") => VisKind::ToolResult(
                        message["toolCallId"].as_str().unwrap_or("").to_string(),
                    ),
                    _ => VisKind::Barrier,
                };
                visible.push(VisMsg { loc: VisLoc::Entry(i), kind });
            }
            _ => {
                let kind = if kind == "message" {
                    classify_message(&entry.v["message"])
                } else {
                    VisKind::Barrier
                };
                visible.push(VisMsg { loc: VisLoc::Entry(i), kind });
            }
        }
    }
    visible
}

/// retainedTail 是一段自包含的消息检查点（没有条目 id，也不会被 context_edit 指向）。
fn tail_visible_messages(tail: &[Value]) -> Vec<VisMsg> {
    tail.iter()
        .enumerate()
        .map(|(i, message)| VisMsg {
            loc: VisLoc::Tail(i),
            kind: classify_message(message),
        })
        .collect()
}

struct PendingBlock {
    /// 工具块中最后一个可见结果（尚无结果时是 assistant 本身）：补齐结果的插入锚点。
    last: VisLoc,
    /// 尚未应答的 (toolCallId, toolName)，保持 assistant 声明顺序。
    missing: Vec<(String, String)>,
}

/// 缺失结果补齐计划：插入锚点 + 该块缺失的 (toolCallId, toolName)。
type FillPlan = (VisLoc, Vec<(String, String)>);

fn close_block(pending: &mut Option<PendingBlock>, fills: &mut Vec<FillPlan>) {
    let Some(block) = pending.take() else { return };
    if !block.missing.is_empty() {
        fills.push((block.last, block.missing));
    }
}

/// 按模型上下文顺序校验工具块：删除无主/错位/重复的 toolResult，记录缺失结果的补齐锚点。
/// 端点要求 assistant(tool_calls) 后紧跟每个调用的 tool 消息；只检查「调用 id 在整个有效
/// 区域出现过」会把 context_edit 剔除 assistant 后遗留的结果误判为配对。
fn plan_tool_repairs(visible: &[VisMsg]) -> (Vec<VisLoc>, Vec<FillPlan>) {
    let mut removed: Vec<VisLoc> = Vec::new();
    let mut fills: Vec<FillPlan> = Vec::new();
    let mut pending: Option<PendingBlock> = None;
    for msg in visible {
        match &msg.kind {
            VisKind::Barrier => close_block(&mut pending, &mut fills),
            VisKind::Assistant(calls) => {
                close_block(&mut pending, &mut fills);
                if !calls.is_empty() {
                    pending = Some(PendingBlock { last: msg.loc, missing: calls.clone() });
                }
            }
            VisKind::ToolResult(call_id) => {
                let matched = pending.as_mut().is_some_and(|block| {
                    let Some(pos) = block.missing.iter().position(|(id, _)| id == call_id) else {
                        return false;
                    };
                    block.missing.remove(pos);
                    block.last = msg.loc;
                    true
                });
                if matched {
                    if pending.as_ref().is_some_and(|block| block.missing.is_empty()) {
                        pending = None;
                    }
                } else {
                    removed.push(msg.loc);
                }
            }
        }
    }
    close_block(&mut pending, &mut fills);
    (removed, fills)
}

/// unix 天数 → 件历日期（Howard Hinnant 的 civil_from_days 算法）。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 当前时刻的 ISO-8601 毫秒精度时间戳（与 pi 条目同形态，如 2026-10-13T01:55:47.338Z）。
fn now_iso_millis() -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let sod = secs.rem_euclid(86_400);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

/// 生成文件内未占用的 8 位十六进制条目 id（pi 条目 id 同形态）。
fn fresh_id(used: &mut HashSet<String>) -> String {
    let mut rng = rand::rng();
    loop {
        let id = format!("{:08x}", rng.random::<u32>());
        if used.insert(id.clone()) {
            return id;
        }
    }
}

/// 修复会话文件内容，返回（修复后全文, 报告）。纯函数、不碰磁盘，便于单测。
pub(crate) fn repair_session_lines(raw: &str) -> (String, AiRepairReport) {
    let mut report = AiRepairReport::default();
    let mut slots: Vec<Option<Entry>> = Vec::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        report.total_lines += 1;
        match parse_entry(t) {
            Some(e) => slots.push(Some(e)),
            None => {
                report.dropped_malformed += 1;
                slots.push(None);
            }
        }
    }
    let live: Vec<usize> = slots
        .iter()
        .enumerate()
        .filter(|(_, s)| s.is_some())
        .map(|(i, _)| i)
        .collect();
    // id → 下标（重复 id 取首个）
    let index: HashMap<String, usize> = {
        let mut m = HashMap::new();
        for &i in &live {
            if let Some(e) = &slots[i] {
                m.entry(e.id().to_string()).or_insert(i);
            }
        }
        m
    };
    // 叶子链：从最后一个条目沿 parentId 回溯（防环；父 id 缺失即止——与 pi 构建上下文
    // 的行走语义一致，断链之前的条目不进上下文）。
    let chain: Vec<usize> = {
        let mut rev = Vec::new();
        let mut cur = live.last().copied();
        let mut seen: HashSet<usize> = HashSet::new();
        while let Some(i) = cur {
            if !seen.insert(i) {
                break;
            }
            rev.push(i);
            cur = slots[i]
                .as_ref()
                .and_then(|e| e.parent_id())
                .and_then(|p| index.get(p).copied());
        }
        rev.reverse();
        rev
    };

    // 切割点：链上最后一个 compaction。保留范围按文档三种形态确定：
    // retainedTail（自包含检查点，firstKept 段不生效）/ firstKeptEntryId（保留段）/
    // 都没有（切割点前全被摘要）。compaction 条目本身只贡献摘要消息，不参与配对。
    let cut = chain
        .iter()
        .rposition(|&i| slots[i].as_ref().is_some_and(|e| e.kind() == "compaction"));
    let (effective, tail_slot): (Vec<usize>, Option<usize>) = if let Some(ci) = cut {
        let comp_i = chain[ci];
        let comp = slots[comp_i].as_ref().expect("链上条目存在");
        if comp.v["retainedTail"].is_array() {
            (chain[ci + 1..].to_vec(), Some(comp_i))
        } else {
            let start = comp
                .v["firstKeptEntryId"]
                .as_str()
                .and_then(|id| index.get(id).copied())
                .filter(|&ki| ki <= comp_i)
                .and_then(|ki| chain.iter().position(|&i| i == ki))
                .unwrap_or(ci + 1);
            (
                chain[start..].iter().copied().filter(|&i| i != comp_i).collect(),
                None,
            )
        }
    } else {
        (chain.clone(), None)
    };

    // 可见消息 = 模型真正会收到的消息序列：retainedTail（压缩检查点内嵌消息）在前，
    // 切割点之后的有效条目在后。context_edit 的剔除/替换必须先叠加，配对判定只看可见
    // 消息——pi 恢复流程省略 assistant 但留下其结果时，原始条目看起来是完整配对。
    let edits = latest_context_edits(&slots, &effective);
    let mut tail_vec: Vec<Value> = Vec::new();
    let mut visible: Vec<VisMsg> = Vec::new();
    if let Some(ti) = tail_slot {
        tail_vec = slots[ti]
            .as_ref()
            .expect("链上条目存在")
            .v["retainedTail"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        visible.extend(tail_visible_messages(&tail_vec));
    }
    visible.extend(effective_visible_messages(&slots, &effective, &edits));
    let (removed, fills) = plan_tool_repairs(&visible);
    let removed_entries: Vec<usize> = removed
        .iter()
        .filter_map(|loc| match loc {
            VisLoc::Entry(i) => Some(*i),
            VisLoc::Tail(_) => None,
        })
        .collect();
    let mut removed_tail: Vec<usize> = removed
        .iter()
        .filter_map(|loc| match loc {
            VisLoc::Tail(i) => Some(*i),
            VisLoc::Entry(_) => None,
        })
        .collect();

    // 1) 删除无主/错位/重复的 toolResult。连片删除时子条目沿删除表重接到首个幸存祖先。
    let mut removed_parents: HashMap<String, Option<String>> = HashMap::new();
    for &i in &removed_entries {
        let Some(e) = slots[i].as_ref() else { continue };
        let parent = e.parent_id().map(str::to_string);
        removed_parents.insert(e.id().to_string(), parent);
        slots[i] = None;
    }
    if !removed_parents.is_empty() {
        for slot in slots.iter_mut().flatten() {
            let Some(first_hop) = slot.parent_id().and_then(|p| removed_parents.get(p).cloned()) else {
                continue;
            };
            let mut target = first_hop;
            let mut guard = 0; // 病态文件防环
            while let Some(next) = target.as_ref().and_then(|t| removed_parents.get(t).cloned()) {
                target = next;
                guard += 1;
                if guard > 10_000 {
                    target = None;
                    break;
                }
            }
            slot.v["parentId"] = target.map(Value::String).unwrap_or(Value::Null);
            slot.modified = true;
        }
    }
    report.removed_orphan_tool_results += removed_entries.len() as u32;

    // 2) retainedTail 内的同类删除（消息级，改数组后写回）。
    removed_tail.sort_unstable();
    for &i in removed_tail.iter().rev() {
        if i < tail_vec.len() {
            tail_vec.remove(i);
        }
    }
    report.removed_orphan_tool_results += removed_tail.len() as u32;

    // 3) 补齐缺失结果：锚点可能是链上条目或 tail 消息，分别插入对应容器。
    let mut used_ids: HashSet<String> = index.keys().cloned().collect();
    let mut entry_fills: Vec<(usize, Vec<(String, String)>)> = Vec::new();
    let mut tail_fills: Vec<(usize, Vec<(String, String)>)> = Vec::new();
    for (anchor, calls) in fills {
        match anchor {
            VisLoc::Entry(i) => entry_fills.push((i, calls)),
            VisLoc::Tail(i) => tail_fills.push((i, calls)),
        }
    }
    // tail 锚点按已删除消息数量回移（锚点本身是可见消息，不会被删）。
    for (anchor, _) in tail_fills.iter_mut() {
        let shift = removed_tail
            .iter()
            .filter(|&&removed_idx| removed_idx < *anchor)
            .count();
        *anchor -= shift;
    }
    // 链上从后往前插，前面的插入不会使后面已记录的锚点失效。
    entry_fills.sort_by_key(|(anchor, _)| *anchor);
    for (anchor, calls) in entry_fills.into_iter().rev() {
        let mut parent_id = slots
            .get(anchor)
            .and_then(|s| s.as_ref())
            .map(|e| e.id().to_string());
        let mut group: Vec<Option<Entry>> = Vec::with_capacity(calls.len());
        let mut last_synth_id = String::new();
        for (call_id, tool_name) in calls {
            let ts = now_iso_millis();
            let synth_id = fresh_id(&mut used_ids);
            let synth = json!({
                "type": "message",
                "id": synth_id,
                "parentId": parent_id.map(Value::String).unwrap_or(Value::Null),
                "timestamp": ts,
                "message": {
                    "role": "toolResult",
                    "toolCallId": call_id,
                    "toolName": tool_name,
                    "content": [{ "type": "text", "text": MISSING_RESULT_TEXT }],
                    "isError": true,
                    "timestamp": ts,
                },
            });
            parent_id = Some(synth_id.clone());
            last_synth_id = synth_id;
            group.push(Some(Entry { raw: String::new(), v: synth, modified: true }));
            report.filled_missing_tool_results += 1;
        }
        // 重接链：插入点之后的首个存活条目 parentId 指向新条目。插入点可能是刚删除的
        // None 槽位，必须往后找首个存活条目，否则合成结果不在叶链上、根本不进上下文。
        if let Some(next) = slots.iter_mut().skip(anchor + 1).flatten().next() {
            next.v["parentId"] = Value::String(last_synth_id);
            next.modified = true;
        }
        slots.splice(anchor + 1..anchor + 1, group);
    }
    // tail 从后往前插（消息级）。
    tail_fills.sort_by_key(|(anchor, _)| *anchor);
    for (anchor, calls) in tail_fills.into_iter().rev() {
        let group: Vec<Value> = calls
            .iter()
            .map(|(call_id, tool_name)| {
                json!({
                    "role": "toolResult",
                    "toolCallId": call_id,
                    "toolName": tool_name,
                    "content": [{ "type": "text", "text": MISSING_RESULT_TEXT }],
                    "isError": true,
                    "timestamp": now_iso_millis(),
                })
            })
            .collect();
        report.filled_missing_tool_results += group.len() as u32;
        let insert_at = (anchor + 1).min(tail_vec.len());
        tail_vec.splice(insert_at..insert_at, group);
    }
    if let Some(ti) = tail_slot {
        let unchanged = {
            let comp = slots[ti].as_ref().expect("链上条目存在");
            comp.v["retainedTail"].as_array() == Some(&tail_vec)
        };
        if !unchanged {
            if let Some(comp) = slots[ti].as_mut() {
                comp.v["retainedTail"] = Value::Array(tail_vec);
                comp.modified = true;
            }
        }
    }

    report.changed = report.dropped_malformed > 0
        || report.removed_orphan_tool_results > 0
        || report.filled_missing_tool_results > 0;
    let lines: Vec<String> = slots
        .iter()
        .flatten()
        .map(|e| {
            if e.modified {
                serde_json::to_string(&e.v).unwrap_or_else(|_| e.raw.clone())
            } else {
                e.raw.clone()
            }
        })
        .collect();
    let body = if lines.is_empty() { String::new() } else { format!("{}\n", lines.join("\n")) };
    (body, report)
}

/// 会话历史文件路径（ai_chat 的 spawn、手动修复、发送前自动修复共用同一规则）。
pub(crate) fn session_path(
    agent_dir: &std::path::Path,
    project_id: &str,
    session_id: &str,
) -> std::path::PathBuf {
    agent_dir
        .join("sessions")
        .join(format!("{project_id}__{session_id}.jsonl"))
}

/// 把修复结果落盘：原文件备份为 `.jsonl.bak`，再经 `.jsonl.tmp` 原子替换。
/// 备份/写入失败均返回中文错误且不留下半截主文件。
pub(crate) fn persist_repair(
    path: &std::path::Path,
    raw: &str,
    fixed: &str,
) -> Result<(), String> {
    let bak = std::path::PathBuf::from(format!("{}.bak", path.display()));
    let tmp = std::path::PathBuf::from(format!("{}.tmp", path.display()));
    std::fs::write(&bak, raw)
        .map_err(|e| format!("备份会话历史失败（{}）: {e}", bak.display()))?;
    std::fs::write(&tmp, fixed)
        .map_err(|e| format!("写入临时文件失败（{}）: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换会话历史失败（{}）: {e}", path.display())
    })
}

/// 是否属于「发给模型会被端点拒绝」的结构性损坏（孤儿/缺失工具结果）。
/// 解析失败的半截行不算——生成中读文件可能读到未写完的最后一行。
pub(crate) fn has_structural_issues(report: &AiRepairReport) -> bool {
    report.removed_orphan_tool_results > 0 || report.filled_missing_tool_results > 0
}

/// 会话修复串行化：发送前预检、终态错误检测、手动修复命令可能同时读写同一文件。
static REPAIR_GATE: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// 只读检测：有结构性损坏时返回报告，否则 None。
/// 终态错误后的第二层检测用它判断是否调用 `auto_repair_session`；不杀进程、不写文件。
pub(crate) fn detect_session_corruption(
    path: &std::path::Path,
) -> Result<Option<AiRepairReport>, String> {
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(path).map_err(|e| format!("读取会话历史失败（{}）: {e}", path.display()))?;
    let (_, report) = repair_session_lines(&raw);
    Ok(has_structural_issues(&report).then_some(report))
}

/// 发送前自动修复（第一层兜底）：会话空闲时校验 jsonl，发现结构性损坏则
/// 杀 pi 进程（内存态是上下文来源，必须重启）→ 备份 + 原子写回。
/// 返回 Some(report) 表示确实修过；None = 无文件/已干净/生成中（生成中不动文件）。
pub(crate) fn auto_repair_session(
    mgr: &AiManager,
    project_id: &str,
    session_id: &str,
) -> Result<Option<AiRepairReport>, String> {
    let _gate = REPAIR_GATE.lock().unwrap_or_else(|p| p.into_inner());
    if mgr.session_busy(project_id, session_id) {
        return Ok(None);
    }
    let path = session_path(&mgr.agent_dir, project_id, session_id);
    if detect_session_corruption(&path)?.is_none() {
        return Ok(None);
    }
    // 先杀进程再重读：杀之前 pi 可能还有收尾写入，以最终落盘内容为准
    mgr.kill_session(project_id, session_id);
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取会话历史失败（{}）: {e}", path.display()))?;
    let (fixed, report) = repair_session_lines(&raw);
    if !has_structural_issues(&report) {
        // 第一次读到的损坏是半截写入等瞬时态：不落盘
        return Ok(None);
    }
    persist_repair(&path, &raw, &fixed)?;
    Ok(Some(report))
}

/// 修复内容摘要（中文，供前端提示与 trace 使用）。
pub(crate) fn report_fixes(report: &AiRepairReport) -> String {
    let mut parts: Vec<String> = Vec::new();
    if report.removed_orphan_tool_results > 0 {
        parts.push(format!("清理孤儿工具结果 {} 条", report.removed_orphan_tool_results));
    }
    if report.filled_missing_tool_results > 0 {
        parts.push(format!("补齐缺失工具结果 {} 条", report.filled_missing_tool_results));
    }
    if report.dropped_malformed > 0 {
        parts.push(format!("丢弃损坏行 {} 行", report.dropped_malformed));
    }
    if parts.is_empty() {
        "无结构问题".to_string()
    } else {
        parts.join("、")
    }
}

/// 修复会话历史（右键菜单「修复会话」）：busy 拒绝 → 杀会话 pi 进程（等退出，文件无并发
/// 写者）→ 校验修复 jsonl（备份 .jsonl.bak + 原子写回）。下次 ai_chat 按同一文件懒重启。
#[tauri::command]
pub async fn ai_repair_session(
    mgr: State<'_, Arc<AiManager>>,
    project_id: String,
    session_id: String,
) -> Result<AiRepairReport, String> {
    let _gate = REPAIR_GATE.lock().unwrap_or_else(|p| p.into_inner());
    if mgr.session_busy(&project_id, &session_id) {
        return Err("会话正在生成中，请先停止或等待完成".to_string());
    }
    let path = session_path(&mgr.agent_dir, &project_id, &session_id);
    if !path.exists() {
        return Err("未找到会话历史文件（该会话可能还没有发过消息）".to_string());
    }
    mgr.kill_session(&project_id, &session_id);
    let raw = std::fs::read_to_string(&path)
        .map_err(|e| format!("读取会话历史失败（{}）: {e}", path.display()))?;
    let (fixed, report) = repair_session_lines(&raw);
    if !report.changed {
        return Ok(report);
    }
    persist_repair(&path, &raw, &fixed)?;
    Ok(report)
}

// ---------------------------------------------------------------- 单测（纯函数，不碰真实目录）

#[cfg(test)]
mod tests {
    use super::*;

    fn line(v: Value) -> String {
        serde_json::to_string(&v).expect("测试条目可序列化")
    }

    fn header() -> String {
        line(json!({"type":"session","version":3,"id":"s0","timestamp":"2026-10-13T00:00:00.000Z","cwd":"C:\\t"}))
    }

    fn user(id: &str, parent: &str, text: &str) -> String {
        line(json!({
            "type":"message","id":id,"parentId":parent,"timestamp":"2026-10-13T00:00:00.000Z",
            "message":{"role":"user","content":[{"type":"text","text":text}],"timestamp":"2026-10-13T00:00:00.000Z"}
        }))
    }

    /// assistant 带 N 个 toolCall（(callId, toolName) 对）。
    fn assistant(id: &str, parent: &str, calls: &[(&str, &str)]) -> String {
        let blocks: Vec<Value> = calls
            .iter()
            .map(|(cid, name)| json!({"type":"toolCall","id":cid,"name":name,"arguments":{}}))
            .collect();
        line(json!({
            "type":"message","id":id,"parentId":parent,"timestamp":"2026-10-13T00:00:01.000Z",
            "message":{"role":"assistant","content":blocks,"provider":"x","model":"m","stopReason":"toolUse","timestamp":"2026-10-13T00:00:01.000Z"}
        }))
    }

    fn result(id: &str, parent: &str, call_id: &str, tool: &str) -> String {
        line(json!({
            "type":"message","id":id,"parentId":parent,"timestamp":"2026-10-13T00:00:02.000Z",
            "message":{"role":"toolResult","toolCallId":call_id,"toolName":tool,"content":[{"type":"text","text":"ok"}],"isError":false,"timestamp":"2026-10-13T00:00:02.000Z"}
        }))
    }

    fn compaction(id: &str, parent: &str) -> String {
        line(json!({"type":"compaction","id":id,"parentId":parent,"timestamp":"2026-10-13T00:00:03.000Z","summary":"摘要","tokensBefore":1}))
    }

    fn reparse(body: &str) -> Vec<Value> {
        body.lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).expect("输出行仍是合法 JSON"))
            .collect()
    }

    #[test]
    fn healthy_session_unchanged() {
        let raw = [
            header(),
            user("u1", "s0", "hi"),
            assistant("a1", "u1", &[("c0", "grep"), ("c1", "read")]),
            result("r1", "a1", "c0", "grep"),
            result("r2", "r1", "c1", "read"),
            user("u2", "r2", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert!(!report.changed);
        assert_eq!(report.total_lines, 6);
        // 未修改的行原样写回（含末尾换行）
        assert_eq!(body, format!("{raw}\n"));
    }

    #[test]
    fn compaction_splits_tool_block_removes_orphans() {
        // compaction 落在 assistant(toolCalls) 与结果之间：结果成为孤儿被删，后续链重接。
        // 并行双结果连片删除，验证重接到首个幸存祖先（compaction）。
        let raw = [
            header(),
            user("u1", "s0", "hi"),
            assistant("a1", "u1", &[("c0", "grep"), ("c1", "read")]),
            compaction("k1", "a1"),
            result("r1", "k1", "c0", "grep"),
            result("r2", "r1", "c1", "read"),
            user("u2", "r2", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert_eq!(report.removed_orphan_tool_results, 2);
        assert_eq!(report.filled_missing_tool_results, 0);
        assert!(report.changed);
        let entries = reparse(&body);
        assert_eq!(entries.len(), 5);
        // u2 的 parentId 应沿删除表重接到 compaction k1
        let u2 = entries.last().unwrap();
        assert_eq!(u2["parentId"].as_str(), Some("k1"));
        assert_eq!(u2["message"]["content"][0]["text"].as_str(), Some("next"));
    }

    #[test]
    fn missing_result_filled_and_chain_linked() {
        // assistant 带 2 个 toolCall 但只有 1 个结果：补 1 条，插在块末、链正确。
        let raw = [
            header(),
            user("u1", "s0", "hi"),
            assistant("a1", "u1", &[("c0", "grep"), ("c1", "read")]),
            result("r1", "a1", "c0", "grep"),
            user("u2", "r1", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert_eq!(report.filled_missing_tool_results, 1);
        assert_eq!(report.removed_orphan_tool_results, 0);
        let entries = reparse(&body);
        assert_eq!(entries.len(), 6);
        // 插入位置：r1 之后、u2 之前；parentId 链 a1→r1→synth→u2
        let synth = &entries[4];
        assert_eq!(synth["message"]["role"].as_str(), Some("toolResult"));
        assert_eq!(synth["message"]["toolCallId"].as_str(), Some("c1"));
        assert_eq!(synth["message"]["isError"].as_bool(), Some(true));
        assert_eq!(synth["parentId"].as_str(), Some("r1"));
        assert_eq!(entries[5]["parentId"].as_str(), synth["id"].as_str());
    }

    #[test]
    fn all_calls_missing_fills_after_assistant() {
        // assistant 的所有结果都缺：补齐条目直接插在 assistant 之后。
        let raw = [
            header(),
            user("u1", "s0", "hi"),
            assistant("a1", "u1", &[("c0", "grep")]),
            user("u2", "a1", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert_eq!(report.filled_missing_tool_results, 1);
        let entries = reparse(&body);
        assert_eq!(entries.len(), 5);
        assert_eq!(entries[3]["message"]["role"].as_str(), Some("toolResult"));
        assert_eq!(entries[3]["parentId"].as_str(), Some("a1"));
        assert_eq!(entries[4]["parentId"].as_str(), entries[3]["id"].as_str());
    }

    #[test]
    fn orphan_without_compaction_removed() {
        // toolCallId 全文件无所属 assistant（无 compaction 场景）→ 删除。
        let raw = [
            header(),
            user("u1", "s0", "hi"),
            result("r1", "u1", "ghost", "grep"),
            user("u2", "r1", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert_eq!(report.removed_orphan_tool_results, 1);
        let entries = reparse(&body);
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[2]["parentId"].as_str(), Some("u1"));
    }

    #[test]
    fn malformed_line_dropped() {
        let raw = [header(), "{\"broken json".to_string(), user("u1", "s0", "hi")].join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert_eq!(report.dropped_malformed, 1);
        assert!(report.changed);
        let entries = reparse(&body);
        assert_eq!(entries.len(), 2);
    }

    #[test]
    fn header_only_and_empty_noop() {
        let header = format!("{}\n", header());
        let (body, report) = repair_session_lines(&header);
        assert!(!report.changed);
        assert_eq!(body, header);
        let (body, report) = repair_session_lines("");
        assert!(!report.changed);
        assert_eq!(body, "");
    }

    #[test]
    fn first_kept_range_preserves_pairing() {
        // firstKeptEntryId 覆盖了 assistant：整块在保留范围内，不应误删结果。
        let raw = [
            header(),
            user("u1", "s0", "hi"),
            assistant("a1", "u1", &[("c0", "grep")]),
            line(json!({"type":"compaction","id":"k1","parentId":"a1","timestamp":"2026-10-13T00:00:03.000Z","summary":"摘要","firstKeptEntryId":"a1"})),
            result("r1", "k1", "c0", "grep"),
            user("u2", "r1", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert!(!report.changed);
        assert_eq!(body, format!("{raw}\n"));
    }

    #[test]
    fn retained_tail_sanitized() {
        // retainedTail 自包含检查点：尾部孤儿 toolResult 删除、assistant 缺结果补齐。
        let tail = json!([
            {"role":"user","content":"hi"},
            {"role":"assistant","content":[{"type":"toolCall","id":"c0","name":"grep","arguments":{}}],"stopReason":"toolUse"},
            {"role":"toolResult","toolCallId":"ghost","toolName":"grep","content":[{"type":"text","text":"?"}]}
        ]);
        let raw = [
            header(),
            line(json!({"type":"compaction","id":"k1","parentId":"s0","timestamp":"2026-10-13T00:00:03.000Z","summary":"摘要","retainedTail":tail})),
            user("u1", "k1", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert_eq!(report.removed_orphan_tool_results, 1);
        assert_eq!(report.filled_missing_tool_results, 1);
        let entries = reparse(&body);
        assert_eq!(entries.len(), 3);
        let tail2 = entries[1]["retainedTail"].as_array().unwrap();
        assert_eq!(tail2.len(), 3);
        assert_eq!(tail2[2]["role"].as_str(), Some("toolResult"));
        assert_eq!(tail2[2]["toolCallId"].as_str(), Some("c0"));
        assert_eq!(tail2[2]["isError"].as_bool(), Some(true));
        // 切割点之后的链上条目不受影响
        assert_eq!(entries[2]["parentId"].as_str(), Some("k1"));
    }

    #[test]
    fn pre_cut_corruption_untouched() {
        // 切割点之前的历史（含孤儿）已被摘要覆盖，不参与上下文，必须原样保留。
        let raw = [
            header(),
            result("r0", "s0", "old-ghost", "grep"),
            compaction("k1", "r0"),
            user("u1", "k1", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert!(!report.changed);
        assert_eq!(body, format!("{raw}\n"));
    }

    #[test]
    fn context_edit_omitted_assistant_removes_orphan_result() {
        // pi length/overflow 恢复：context_edit 只剔除 assistant（toolCall 参数被截断的尝试），
        // 其 toolResult 仍留在上下文 → 端点 400；修复必须把该结果一并删除。
        let raw = [
            header(),
            user("u1", "s0", "hi"),
            assistant("a1", "u1", &[("c0", "grep")]),
            result("r1", "a1", "c0", "grep"),
            assistant("a2", "r1", &[("c1", "edit")]),
            result("r2", "a2", "c1", "edit"),
            line(json!({"type":"context_edit","id":"e1","parentId":"r2","timestamp":"2026-10-13T00:00:04.000Z","targetId":"a2","replacement":null})),
            user("u2", "e1", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert_eq!(report.removed_orphan_tool_results, 1);
        assert_eq!(report.filled_missing_tool_results, 0);
        assert!(report.changed);
        let entries = reparse(&body);
        assert!(entries.iter().all(|e| e["id"].as_str() != Some("r2")));
        // u2 沿删除表重接到 context_edit 条目
        assert_eq!(entries.last().unwrap()["parentId"].as_str(), Some("e1"));
    }

    #[test]
    fn context_edit_omitted_tool_result_fills_visible_call() {
        // 反向：toolResult 被剔除但 assistant 仍可见 → 必须补齐，否则端点报工具调用无应答。
        let raw = [
            header(),
            user("u1", "s0", "hi"),
            assistant("a1", "u1", &[("c0", "grep")]),
            result("r1", "a1", "c0", "grep"),
            line(json!({"type":"context_edit","id":"e1","parentId":"r1","timestamp":"2026-10-13T00:00:04.000Z","targetId":"r1","replacement":null})),
            user("u2", "e1", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert_eq!(report.filled_missing_tool_results, 1);
        assert_eq!(report.removed_orphan_tool_results, 0);
        let entries = reparse(&body);
        let synth = entries
            .iter()
            .find(|e| {
                e["message"]["toolCallId"].as_str() == Some("c0")
                    && e["message"]["isError"].as_bool() == Some(true)
            })
            .expect("应补齐可见调用的结果");
        // 合成结果插在 a1 之后、被剔除的 r1 之前：可见上下文为 a1 → synth → u2。
        assert_eq!(synth["parentId"].as_str(), Some("a1"));
        let synth_pos = entries.iter().position(|e| e["id"] == synth["id"]).unwrap();
        assert_eq!(entries[synth_pos + 1]["id"].as_str(), Some("r1"));
        assert_eq!(entries[synth_pos + 1]["parentId"].as_str(), synth["id"].as_str());
    }

    #[test]
    fn context_edit_replacement_dropping_tool_call_removes_result() {
        // replacement 只剩文本块（pi 把字符串归一为 text block）→ assistant 不再带 ToolCall，
        // 原结果变成无主结果，必须删除。
        let raw = [
            header(),
            user("u1", "s0", "hi"),
            assistant("a1", "u1", &[("c0", "grep")]),
            result("r1", "a1", "c0", "grep"),
            line(json!({"type":"context_edit","id":"e1","parentId":"r1","timestamp":"2026-10-13T00:00:04.000Z","targetId":"a1","replacement":"（已省略）"})),
            user("u2", "e1", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert_eq!(report.removed_orphan_tool_results, 1);
        assert_eq!(report.filled_missing_tool_results, 0);
        let entries = reparse(&body);
        assert!(entries.iter().all(|e| e["id"].as_str() != Some("r1")));
    }

    #[test]
    fn out_of_order_tool_results_are_removed_and_filled() {
        // assistant 工具块后先出现另一条 assistant：前一调用补结果，错位结果删除。
        let raw = [
            header(),
            user("u1", "s0", "hi"),
            assistant("a1", "u1", &[("c0", "grep")]),
            assistant("a2", "a1", &[("c1", "read")]),
            result("r1", "a2", "c0", "grep"),
            result("r2", "r1", "c1", "read"),
            user("u2", "r2", "next"),
        ]
        .join("\n");
        let (body, report) = repair_session_lines(&raw);
        assert_eq!(report.filled_missing_tool_results, 1);
        assert_eq!(report.removed_orphan_tool_results, 1);
        let entries = reparse(&body);
        // 修复后链路：a1 → synth(c0) → a2 → r2(c1) → u2
        assert_eq!(entries.len(), 7);
        assert_eq!(entries[3]["message"]["toolCallId"].as_str(), Some("c0"));
        assert_eq!(entries[3]["message"]["isError"].as_bool(), Some(true));
        assert_eq!(entries[4]["id"].as_str(), Some("a2"));
        assert_eq!(entries[5]["message"]["toolCallId"].as_str(), Some("c1"));
    }

    fn temp_session_path(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aishell-ai-repair-{tag}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("sessions").join(format!("{tag}.jsonl"))
    }

    #[test]
    fn detect_reports_only_structural_corruption() {
        let path = temp_session_path("detect");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        // 缺失工具结果 → 结构性损坏
        let corrupt = [header(), user("u1", "s0", "hi"), assistant("a1", "u1", &[("c0", "grep")])].join("\n");
        std::fs::write(&path, format!("{corrupt}\n")).unwrap();
        let report = detect_session_corruption(&path).unwrap().expect("应检测到缺失工具结果");
        assert_eq!(report.filled_missing_tool_results, 1);
        assert!(!has_structural_issues(&AiRepairReport::default()));

        // 配对完整 → 干净
        let healthy = [
            header(),
            user("u1", "s0", "hi"),
            assistant("a1", "u1", &[("c0", "grep")]),
            result("r1", "a1", "c0", "grep"),
        ]
        .join("\n");
        std::fs::write(&path, format!("{healthy}\n")).unwrap();
        assert!(detect_session_corruption(&path).unwrap().is_none());

        // 仅半截/损坏行（可能是生成中读到的未写完行）→ 不算结构性损坏
        std::fs::write(&path, format!("{}\n{{broken", header())).unwrap();
        assert!(detect_session_corruption(&path).unwrap().is_none());

        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }

    #[test]
    fn persist_repair_backs_up_original_and_replaces_atomically() {
        let path = temp_session_path("persist");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let raw = [header(), user("u1", "s0", "hi")].join("\n") + "\n";
        let fixed = [header(), user("u2", "s0", "hi")].join("\n") + "\n";
        std::fs::write(&path, &raw).unwrap();
        persist_repair(&path, &raw, &fixed).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), fixed);
        let bak = std::path::PathBuf::from(format!("{}.bak", path.display()));
        assert_eq!(std::fs::read_to_string(&bak).unwrap(), raw);
        assert!(!std::path::PathBuf::from(format!("{}.tmp", path.display())).exists());
        let _ = std::fs::remove_dir_all(path.parent().unwrap().parent().unwrap());
    }
}
