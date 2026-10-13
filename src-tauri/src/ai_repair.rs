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
//! - 有效区域内：孤儿 toolResult（所属 assistant toolCall 不在有效区域内）→ 删除；
//!   assistant 的 toolCall 缺结果 → 合成 isError 结果补齐（缺失同样会被端点拒绝）。
//! - compaction 自带 firstKeptEntryId / retainedTail 时按文档语义纳入保留范围一并校验。
//!
//! 修复必须先 `AiManager::kill_session` 等待 pi 进程退出（内存态独占写文件）；下次 ai_chat
//! 按同一文件懒重启加载修复后内容。杀进程重启本身也能治愈 pi 进程内的内存态损坏。

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
    fn role(&self) -> Option<&str> {
        self.v["message"]["role"].as_str()
    }
    fn tool_call_id(&self) -> Option<&str> {
        self.v["message"]["toolCallId"].as_str()
    }
    /// assistant 消息 content 块里的 toolCall（id, name）对；非数组 content 返回空。
    fn tool_calls(&self) -> Vec<(String, String)> {
        let Some(blocks) = self.v["message"]["content"].as_array() else {
            return Vec::new();
        };
        blocks
            .iter()
            .filter(|b| b["type"].as_str() == Some("toolCall"))
            .filter_map(|b| {
                let id = b["id"].as_str()?.to_string();
                let name = b["name"].as_str().unwrap_or("").to_string();
                Some((id, name))
            })
            .collect()
    }
}

fn parse_entry(line: &str) -> Option<Entry> {
    let v: Value = serde_json::from_str(line).ok()?;
    if v["type"].as_str().is_none() || v["id"].as_str().is_none() {
        return None;
    }
    Some(Entry { raw: line.to_string(), v, modified: false })
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

    // 配对集合：有效区域 assistant 的 toolCall id / toolResult id。retainedTail 与切割后
    // 条目共同构成模型上下文，配对判定必须跨容器合并。
    let mut call_names: HashMap<String, String> = HashMap::new(); // callId -> toolName
    let mut result_ids: HashSet<String> = HashSet::new();
    for &i in &effective {
        let Some(e) = slots[i].as_ref() else { continue };
        match e.role() {
            Some("assistant") => {
                for (id, name) in e.tool_calls() {
                    call_names.entry(id).or_insert(name);
                }
            }
            Some("toolResult") => {
                if let Some(id) = e.tool_call_id() {
                    result_ids.insert(id.to_string());
                }
            }
            _ => {}
        }
    }
    let mut tail_vec: Vec<Value> = Vec::new();
    if let Some(ti) = tail_slot {
        tail_vec = slots[ti]
            .as_ref()
            .expect("链上条目存在")
            .v["retainedTail"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        collect_tail_pairing(&tail_vec, &mut call_names, &mut result_ids);
    }

    // 1) 删除有效区域内的孤儿 toolResult（所属 assistant 不在有效区域内）。连片删除时
    //    子条目沿删除表重接到首个幸存祖先。
    let mut removed_parents: HashMap<String, Option<String>> = HashMap::new();
    for &i in &effective {
        let Some(e) = slots[i].as_ref() else { continue };
        if e.role() != Some("toolResult") {
            continue;
        }
        if e.tool_call_id().is_none_or(|id| !call_names.contains_key(id)) {
            let parent = e.parent_id().map(str::to_string);
            removed_parents.insert(e.id().to_string(), parent);
            slots[i] = None;
            report.removed_orphan_tool_results += 1;
        }
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

    // 2) retainedTail 内的孤儿 toolResult 同样删除（消息级，改数组后写回）。
    if !tail_vec.is_empty() {
        let before = tail_vec.len();
        tail_vec.retain(|m| {
            !(m["role"].as_str() == Some("toolResult")
                && m["toolCallId"].as_str().is_none_or(|id| !call_names.contains_key(id)))
        });
        report.removed_orphan_tool_results += (before - tail_vec.len()) as u32;
    }

    // 3) 补齐缺失结果：有效区域 assistant 的 toolCall 没有对应 toolResult → 合成
    //    isError 条目，插在该 assistant 工具块末尾（其后属于该块的连续 toolResult 之后）。
    let mut used_ids: HashSet<String> = index.keys().cloned().collect();
    let mut missing: Vec<(usize, String, String)> = Vec::new();
    for &i in &effective {
        let Some(e) = slots[i].as_ref() else { continue };
        if e.role() != Some("assistant") {
            continue;
        }
        for (id, name) in e.tool_calls() {
            if !result_ids.contains(&id) {
                missing.push((i, id, name));
            }
        }
    }
    // 按文件顺序从后往前插，前面的插入不会使后面已记录的下标失效。
    missing.sort_by_key(|(i, _, _)| *i);
    for (i, call_id, tool_name) in missing.into_iter().rev() {
        let block_call_ids: HashSet<String> = slots[i]
            .as_ref()
            .map(|e| e.tool_calls().into_iter().map(|(id, _)| id).collect())
            .unwrap_or_default();
        let mut insert_at = i + 1;
        while let Some(e) = slots.get(insert_at).and_then(|s| s.as_ref()) {
            let in_block = e.role() == Some("toolResult")
                && e.tool_call_id().is_some_and(|id| block_call_ids.contains(id));
            if !in_block {
                break;
            }
            insert_at += 1;
        }
        let parent_of_synth = slots
            .get(insert_at - 1)
            .and_then(|s| s.as_ref())
            .map(|e| e.id().to_string());
        let ts = now_iso_millis();
        let synth_id = fresh_id(&mut used_ids);
        let synth = json!({
            "type": "message",
            "id": synth_id,
            "parentId": parent_of_synth.map(Value::String).unwrap_or(Value::Null),
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
        // 重接链：插入点原有的下一条目 parentId 指向新条目。
        if let Some(next) = slots.get_mut(insert_at).and_then(|s| s.as_mut()) {
            next.v["parentId"] = Value::String(synth_id);
            next.modified = true;
        }
        slots.insert(insert_at, Some(Entry { raw: String::new(), v: synth, modified: true }));
        report.filled_missing_tool_results += 1;
    }

    // 4) retainedTail 内缺失结果的补齐（消息级，追加到数组末尾）。
    if !tail_vec.is_empty() {
        let mut tail_missing: Vec<(String, String)> = Vec::new();
        for m in &tail_vec {
            if m["role"].as_str() != Some("assistant") {
                continue;
            }
            if let Some(blocks) = m["content"].as_array() {
                for b in blocks {
                    if b["type"].as_str() == Some("toolCall") {
                        if let Some(id) = b["id"].as_str() {
                            if !result_ids.contains(id) {
                                tail_missing
                                    .push((id.to_string(), b["name"].as_str().unwrap_or("").to_string()));
                            }
                        }
                    }
                }
            }
        }
        for (id, name) in tail_missing {
            tail_vec.push(json!({
                "role": "toolResult",
                "toolCallId": id,
                "toolName": name,
                "content": [{ "type": "text", "text": MISSING_RESULT_TEXT }],
                "isError": true,
                "timestamp": now_iso_millis(),
            }));
            report.filled_missing_tool_results += 1;
        }
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

/// 汇总 retainedTail 消息数组里的配对信息（assistant toolCall / toolResult）。
fn collect_tail_pairing(tail: &[Value], call_names: &mut HashMap<String, String>, result_ids: &mut HashSet<String>) {
    for m in tail {
        match m["role"].as_str() {
            Some("assistant") => {
                if let Some(blocks) = m["content"].as_array() {
                    for b in blocks {
                        if b["type"].as_str() == Some("toolCall") {
                            if let Some(id) = b["id"].as_str() {
                                call_names
                                    .entry(id.to_string())
                                    .or_insert_with(|| b["name"].as_str().unwrap_or("").to_string());
                            }
                        }
                    }
                }
            }
            Some("toolResult") => {
                if let Some(id) = m["toolCallId"].as_str() {
                    result_ids.insert(id.to_string());
                }
            }
            _ => {}
        }
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
    {
        if mgr.session_busy(&project_id, &session_id) {
            return Err("会话正在生成中，请先停止或等待完成".to_string());
        }
    }
    let path = mgr
        .agent_dir
        .join("sessions")
        .join(format!("{project_id}__{session_id}.jsonl"));
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
    let bak = path.with_file_name(format!("{project_id}__{session_id}.jsonl.bak"));
    std::fs::write(&bak, &raw)
        .map_err(|e| format!("备份会话历史失败（{}）: {e}", bak.display()))?;
    let tmp = path.with_file_name(format!("{project_id}__{session_id}.jsonl.tmp"));
    std::fs::write(&tmp, &fixed)
        .map_err(|e| format!("写入临时文件失败（{}）: {e}", tmp.display()))?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("替换会话历史失败（{}）: {e}", path.display())
    })?;
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
}
