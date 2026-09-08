//! 技能文件级云同步的安全纯逻辑层（与 notes_sync 同构的受限文件树域）。
//!
//! 同步路径命名空间（NFC、`/` 分隔）：
//! - `global/<技能名>/<相对路径>`：全局技能根 `<workspace>/.aishell/skills`；
//! - `project/<projectId>/<技能名>/<相对路径>`：项目技能根 `<项目目录>/.aishell/skills`。
//!
//! 同步范围刻意收窄，避免把本机状态灌进云端或让单个坏目录卡死同步：
//! - 只同步「有效技能目录」（SKILL.md frontmatter 合法且 name 与目录名一致），
//!   损坏技能静默跳过——不传播，也不阻塞整轮同步；
//! - 内置播种副本未被用户改过（SKILL.md 内容 == `.builtin-sha256` 侧车）的技能跳过：
//!   每台设备都会自动播种，无需云端中转；用户改过的照常同步；
//! - 点开头的条目（`.builtin-sha256`、`.tmp`/`.bak` 原子写残留、`.skillhub-*` 暂存目录）
//!   一律跳过；符号链接条目、超限文件跳过所在技能；
//! - 落盘复用 notes_sync 的 safe_target/ensure_safe_parent/atomic_write（symlink
//!   TOCTOU 防护同语义），错误文案在本模块映射为技能语境；
//! - SKILL.md 写入前复验 frontmatter：云端数据损坏时让该轮同步失败并保留现场，
//!   与笔记 payload hash 校验失败的语义一致。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::crypto::{
    decode_strict_base64, encode_base64, normalize_note_path, sha256_hex, skill_entity_id,
};
use super::notes_sync::{
    atomic_write, ensure_safe_parent, normalized_sync_path, remove_tree_no_symlinks, safe_target,
    NoteSyncError,
};
use crate::skills::{builtin_seed_untouched, validate_skill_content, validate_skill_name};

/// 技能 payload 的当前 schema 版本。
pub const SKILL_PAYLOAD_SCHEMA_VERSION: u32 = 1;
/// 与服务端同步实体类型对应的名称。
pub const SKILL_ENTITY_TYPE: &str = "skill";
pub const SKILL_DIRECTORY_ENTITY_TYPE: &str = "skill_directory";
/// 技能索引基线在本地 baseline 存储里的固定 (entity_type, entity_id)。
pub const SKILL_INDEX_BASELINE_TYPE: &str = "skill_index";
pub const SKILL_INDEX_BASELINE_ID: &str = "default";

const SKILL_FILE: &str = "SKILL.md";
const SCOPE_GLOBAL: &str = "global";
const SCOPE_PROJECT: &str = "project";
/// 目录 hash 的域隔离前缀（与笔记目录 hash 区分，防止跨域同路径碰撞）。
const DIRECTORY_HASH_DOMAIN: &[u8] = b"aishell.skill-directory/v1\0";
/// 单文件同步上限：技能是文档/脚本/小资源，超过视为异常附件，跳过所在技能。
const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;
/// 扫描深度上限，防御异常深目录。
const MAX_SCAN_DEPTH: usize = 16;

/// 同步索引中的实体类别；serde 名称与笔记一致的 `file` / `directory`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillEntryType {
    File,
    Directory,
}

impl SkillEntryType {
    pub fn entity_type(self) -> &'static str {
        match self {
            Self::File => SKILL_ENTITY_TYPE,
            Self::Directory => SKILL_DIRECTORY_ENTITY_TYPE,
        }
    }
}

/// 当前索引的一条记录（与 NoteIndexRecord 字段语义一致）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillIndexRecord {
    pub entity_id: String,
    pub hash: String,
    #[serde(rename = "type")]
    pub entry_type: SkillEntryType,
    pub path: String,
}

/// tombstone 反查记录：按 entity_id 存 baseline，应用删除时还原同步路径。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillIndexRecordBaseline {
    pub path: String,
    #[serde(rename = "type")]
    pub entry_type: SkillEntryType,
}

/// 技能文件内容的传输编码：文本直存，二进制走标准 base64。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillContentEncoding {
    Utf8,
    Base64,
}

/// 版本 1 的技能文件 payload；hash 是原始字节的 SHA-256。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillFilePayloadV1 {
    pub schema_version: u32,
    pub path: String,
    pub encoding: SkillContentEncoding,
    pub content: String,
    pub hash: String,
}

/// 版本 1 的技能目录 payload；hash 对路径和 skill 域做隔离，空目录也能同步。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDirectoryPayloadV1 {
    pub schema_version: u32,
    pub path: String,
    pub hash: String,
}

/// 一个待扫描的技能根。
#[derive(Debug, Clone)]
pub struct SkillRootSpec {
    /// 同步路径前缀：`global` 或 `project/<projectId>`。
    pub prefix: String,
    pub root: PathBuf,
}

/// 扫描产出的完整快照。
#[derive(Debug, Default)]
pub struct SkillScanOutcome {
    pub index: Vec<SkillIndexRecord>,
    pub file_payloads: Vec<SkillFilePayloadV1>,
    pub directory_payloads: Vec<SkillDirectoryPayloadV1>,
    /// 本轮实际扫描过内容的根前缀。根目录缺失/不可读的根不在其中——状态未知时
    /// diff 不得据此产生 tombstone（项目目录移动/还原中不能误删云端技能）。
    pub scanned_prefixes: BTreeSet<String>,
    /// 扫描到的技能个数（按技能目录计）。
    pub skill_count: usize,
}

impl SkillScanOutcome {
    pub fn file_payload(&self, path: &str) -> Option<&SkillFilePayloadV1> {
        self.file_payloads.iter().find(|p| p.path == path)
    }

    pub fn directory_payload(&self, path: &str) -> Option<&SkillDirectoryPayloadV1> {
        self.directory_payloads.iter().find(|p| p.path == path)
    }
}

/// 同步路径的 scope：全局根或某项目的技能根。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkillSyncScope {
    Global,
    Project(String),
}

/// 一个需要上传的实体。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillUpsert {
    pub entity_id: String,
    pub hash: String,
    pub entry_type: SkillEntryType,
    pub path: String,
}

/// 一个需要上传的删除 tombstone。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillTombstone {
    pub entity_id: String,
    pub entry_type: SkillEntryType,
    pub path: String,
}

/// 基于上轮索引与本轮扫描的上传/删除计划。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SkillSyncPlan {
    pub upserts: Vec<SkillUpsert>,
    pub tombstones: Vec<SkillTombstone>,
}

/// 同步路径前缀（首段）：`global`、`project`。
pub fn skill_path_prefix(path: &str) -> Option<&str> {
    path.split('/').next().filter(|s| !s.is_empty())
}

/// 解析同步路径 `global/<name>/<rel...>` / `project/<pid>/<name>/<rel...>`，
/// 返回 (scope, 技能根内相对路径 `<name>[/<rel...>]`)。
pub fn split_skill_path(path: &str) -> Result<(SkillSyncScope, String), String> {
    let normalized = normalized_sync_path(path).map_err(|e| skill_err("路径解析", e))?;
    let mut parts = normalized.split('/');
    let scope = match parts.next().unwrap_or_default() {
        SCOPE_GLOBAL => SkillSyncScope::Global,
        SCOPE_PROJECT => {
            let pid = parts.next().ok_or("技能同步路径缺少项目标识")?;
            if !is_safe_id(pid) {
                return Err(format!("技能同步路径的项目标识不合法：{pid}"));
            }
            SkillSyncScope::Project(pid.to_string())
        }
        other => return Err(format!("技能同步路径 scope 不合法：{other}")),
    };
    let name = parts.next().ok_or("技能同步路径缺少技能名")?;
    validate_skill_name(name).map_err(|e| format!("技能同步路径的技能名不合法：{e}"))?;
    let mut segments = vec![name];
    segments.extend(parts);
    for segment in &segments {
        if segment.starts_with('.') {
            return Err(format!("技能同步路径包含隐藏条目：{normalized}"));
        }
    }
    Ok((scope, segments.join("/")))
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// 扫描全部技能根。单个技能损坏/超限/含链接只影响自身（跳过），不影响其它技能。
pub fn scan_skill_roots(specs: &[SkillRootSpec], vault_key: &[u8; 32]) -> SkillScanOutcome {
    let mut outcome = SkillScanOutcome::default();
    for spec in specs {
        let Ok(prefix) = normalized_sync_path(&spec.prefix) else {
            continue;
        };
        // 根缺失/不可读：本轮状态未知，不进入 scanned_prefixes（diff 不产生 tombstone）。
        let Ok(meta) = fs::symlink_metadata(&spec.root) else {
            continue;
        };
        if meta.file_type().is_symlink() || !meta.is_dir() {
            continue;
        }
        let Ok(entries) = fs::read_dir(&spec.root) else {
            continue;
        };
        outcome.scanned_prefixes.insert(prefix.clone());
        let mut children: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
        children.sort();
        for child in children {
            scan_one_skill(&prefix, &child, vault_key, &mut outcome);
        }
    }
    outcome.index.sort_by(|left, right| left.path.cmp(&right.path));
    outcome
        .file_payloads
        .sort_by(|left, right| left.path.cmp(&right.path));
    outcome
        .directory_payloads
        .sort_by(|left, right| left.path.cmp(&right.path));
    outcome
}

/// 单个技能目录：非法/内置原样副本/损坏/含链接/超限 → 静默跳过。
fn scan_one_skill(prefix: &str, dir: &std::path::Path, vault_key: &[u8; 32], outcome: &mut SkillScanOutcome) {
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return;
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return;
    }
    let Some(name) = dir.file_name().and_then(|n| n.to_str()) else {
        return;
    };
    if name.starts_with('.') || validate_skill_name(name).is_err() {
        return;
    }
    let skill_file = dir.join(SKILL_FILE);
    let Ok(file_meta) = fs::symlink_metadata(&skill_file) else {
        return;
    };
    if file_meta.file_type().is_symlink() || !file_meta.is_file() {
        return;
    }
    // 内置播种原样副本每台设备都有，跳过；用户改过的照常同步。
    if builtin_seed_untouched(dir) {
        return;
    }
    // SKILL.md 必须是合法 UTF-8 且 frontmatter 校验通过，否则整个技能跳过。
    let Ok(skill_bytes) = read_stable(&skill_file) else {
        return;
    };
    let Ok(skill_content) = String::from_utf8(skill_bytes) else {
        return;
    };
    if validate_skill_content(name, &skill_content).is_err() {
        return;
    }
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut directories: Vec<String> = Vec::new();
    if collect_tree(dir, &format!("{prefix}/{name}"), 0, &mut files, &mut directories).is_err() {
        return;
    }
    for path in directories {
        let Ok(entity_id) = skill_entity_id(vault_key, &path) else {
            return;
        };
        let hash = skill_directory_hash(&path);
        outcome.index.push(SkillIndexRecord {
            entity_id,
            hash: hash.clone(),
            entry_type: SkillEntryType::Directory,
            path: path.clone(),
        });
        outcome.directory_payloads.push(SkillDirectoryPayloadV1 {
            schema_version: SKILL_PAYLOAD_SCHEMA_VERSION,
            path,
            hash,
        });
    }
    for (path, bytes) in files {
        let hash = sha256_hex(&bytes);
        let Ok(entity_id) = skill_entity_id(vault_key, &path) else {
            return;
        };
        outcome.index.push(SkillIndexRecord {
            entity_id,
            hash: hash.clone(),
            entry_type: SkillEntryType::File,
            path: path.clone(),
        });
        let (encoding, content) = match std::str::from_utf8(&bytes) {
            Ok(text) => (SkillContentEncoding::Utf8, text.to_string()),
            Err(_) => (SkillContentEncoding::Base64, encode_base64(&bytes)),
        };
        outcome.file_payloads.push(SkillFilePayloadV1 {
            schema_version: SKILL_PAYLOAD_SCHEMA_VERSION,
            path,
            encoding,
            content,
            hash,
        });
    }
    outcome.skill_count += 1;
}

/// 深度优先收集技能目录树；任何链接/超限/越规条目都放弃整个技能（Err）。
fn collect_tree(
    dir: &std::path::Path,
    sync_prefix: &str,
    depth: usize,
    files: &mut Vec<(String, Vec<u8>)>,
    directories: &mut Vec<String>,
) -> Result<(), ()> {
    if depth > MAX_SCAN_DEPTH {
        return Err(());
    }
    directories.push(sync_prefix.to_string());
    let entries = fs::read_dir(dir).map_err(|_| ())?;
    let mut children: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    children.sort();
    for child in children {
        let Some(raw_name) = child.file_name().and_then(|n| n.to_str()) else {
            return Err(());
        };
        if raw_name.starts_with('.') {
            continue;
        }
        let child_sync = normalize_note_path(&format!("{sync_prefix}/{raw_name}")).map_err(|_| ())?;
        let meta = fs::symlink_metadata(&child).map_err(|_| ())?;
        if meta.file_type().is_symlink() {
            return Err(());
        }
        if meta.is_dir() {
            collect_tree(&child, &child_sync, depth + 1, files, directories)?;
        } else if meta.is_file() {
            if meta.len() as usize > MAX_FILE_BYTES {
                return Err(());
            }
            files.push((child_sync, read_stable(&child).map_err(|_| ())?));
        } else {
            return Err(());
        }
    }
    Ok(())
}

/// 读取普通文件并复核读取前后未被替换/改写（扫描期间正在写入的文件按失败处理）。
fn read_stable(path: &std::path::Path) -> Result<Vec<u8>, ()> {
    let bytes = fs::read(path).map_err(|_| ())?;
    let after = fs::symlink_metadata(path).map_err(|_| ())?;
    if after.file_type().is_symlink() || !after.is_file() || after.len() != bytes.len() as u64 {
        return Err(());
    }
    Ok(bytes)
}

fn skill_directory_hash(path: &str) -> String {
    let mut value = DIRECTORY_HASH_DOMAIN.to_vec();
    value.extend_from_slice(path.as_bytes());
    sha256_hex(&value)
}

/// 根据 entityId 比较索引（与 notes_sync::diff 同语义）：同一路径的内容变化只生成
/// upsert，删除/移动生成 tombstone；upsert 父目录先于子文件，tombstone 反序。
pub fn diff_skill_indexes(old: &[SkillIndexRecord], current: &[SkillIndexRecord]) -> SkillSyncPlan {
    let old_by_id: BTreeMap<&str, &SkillIndexRecord> = old
        .iter()
        .map(|record| (record.entity_id.as_str(), record))
        .collect();
    let current_by_id: BTreeMap<&str, &SkillIndexRecord> = current
        .iter()
        .map(|record| (record.entity_id.as_str(), record))
        .collect();
    let mut plan = SkillSyncPlan::default();
    for (entity_id, record) in &current_by_id {
        if old_by_id.get(entity_id).is_none_or(|old| {
            old.hash != record.hash
                || old.entry_type != record.entry_type
                || old.path != record.path
        }) {
            plan.upserts.push(SkillUpsert {
                entity_id: (*entity_id).to_string(),
                hash: record.hash.clone(),
                entry_type: record.entry_type,
                path: record.path.clone(),
            });
        }
    }
    for (entity_id, record) in &old_by_id {
        if !current_by_id.contains_key(entity_id) {
            plan.tombstones.push(SkillTombstone {
                entity_id: (*entity_id).to_string(),
                entry_type: record.entry_type,
                path: record.path.clone(),
            });
        }
    }
    plan.upserts.sort_by(|left, right| {
        path_depth(&left.path)
            .cmp(&path_depth(&right.path))
            .then_with(|| left.path.cmp(&right.path))
    });
    plan.tombstones.sort_by(|left, right| {
        path_depth(&right.path)
            .cmp(&path_depth(&left.path))
            .then_with(|| left.path.cmp(&right.path))
    });
    plan
}

fn path_depth(path: &str) -> usize {
    path.split('/').count()
}

// ---------------------------------------------------------------- 远端应用

fn skill_err(context: &str, error: NoteSyncError) -> String {
    match error {
        NoteSyncError::Io(error) => format!("技能同步文件操作失败（{context}）：{error}"),
        NoteSyncError::Symlink(path) => format!("技能同步拒绝符号链接：{path}"),
        NoteSyncError::InvalidPath(path) => format!("技能同步路径不合法：{path}"),
        NoteSyncError::InvalidRoot(path) => format!("技能根目录不合法：{path}"),
        NoteSyncError::Collision(path) => format!("技能同步目标冲突：{path}"),
        other => format!("技能同步失败（{context}）：{other}"),
    }
}

/// 校验并解码远端文件 payload，返回原始字节。
fn decoded_file_bytes(payload: &SkillFilePayloadV1) -> Result<Vec<u8>, String> {
    if payload.schema_version != SKILL_PAYLOAD_SCHEMA_VERSION {
        return Err(format!(
            "不支持的技能文件 schema 版本：{}",
            payload.schema_version
        ));
    }
    normalized_sync_path(&payload.path).map_err(|e| skill_err("路径校验", e))?;
    let bytes = match payload.encoding {
        SkillContentEncoding::Utf8 => payload.content.as_bytes().to_vec(),
        SkillContentEncoding::Base64 => decode_strict_base64(&payload.content)
            .map_err(|e| format!("技能文件 base64 解码失败：{e}"))?,
    };
    if sha256_hex(&bytes) != payload.hash {
        return Err(format!("技能文件 hash 不匹配：{}", payload.path));
    }
    Ok(bytes)
}

fn validate_directory_payload(payload: &SkillDirectoryPayloadV1) -> Result<(), String> {
    if payload.schema_version != SKILL_PAYLOAD_SCHEMA_VERSION {
        return Err(format!(
            "不支持的技能目录 schema 版本：{}",
            payload.schema_version
        ));
    }
    let path = normalized_sync_path(&payload.path).map_err(|e| skill_err("路径校验", e))?;
    if payload.hash != skill_directory_hash(&path) {
        return Err(format!("技能目录 hash 不匹配：{path}"));
    }
    Ok(())
}

/// 校验根目录可用（不存在则创建），返回受信根。
fn prepare_root(root: &std::path::Path) -> Result<PathBuf, String> {
    if !root.exists() {
        fs::create_dir_all(root)
            .map_err(|e| format!("创建技能根目录失败（{}）：{e}", root.display()))?;
    }
    let meta = fs::symlink_metadata(root)
        .map_err(|e| skill_err("根目录检查", NoteSyncError::Io(e)))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!("技能根目录不合法：{}", root.display()));
    }
    Ok(root.to_path_buf())
}

/// 原子写入远端技能文件。`within_root` 形如 `<技能名>/<相对路径>`；
/// SKILL.md 在写入前复验 frontmatter（目录名一致性含在内）。
pub fn apply_remote_file(
    root: &std::path::Path,
    within_root: &str,
    payload: &SkillFilePayloadV1,
) -> Result<(), String> {
    let bytes = decoded_file_bytes(payload)?;
    let mut segments = within_root.split('/');
    let name = segments.next().ok_or("技能同步路径缺少技能名")?;
    let rel = segments.collect::<Vec<_>>().join("/");
    if rel == SKILL_FILE {
        let content = String::from_utf8(bytes.clone())
            .map_err(|_| format!("技能文件不是 UTF-8 文本：{}", payload.path))?;
        validate_skill_content(name, &content)
            .map_err(|e| format!("云端技能文件校验失败：{e}"))?;
    }
    let root = prepare_root(root)?;
    let (target, _) = safe_target(&root, within_root).map_err(|e| skill_err("路径解析", e))?;
    ensure_safe_parent(&root, &target).map_err(|e| skill_err("创建父目录", e))?;
    atomic_write(&target, &bytes, true).map_err(|e| skill_err("写入", e))
}

/// 应用远端技能目录（保留空目录；已存在时幂等）。
pub fn apply_remote_directory(
    root: &std::path::Path,
    within_root: &str,
    payload: &SkillDirectoryPayloadV1,
) -> Result<(), String> {
    validate_directory_payload(payload)?;
    let root = prepare_root(root)?;
    let (target, _) = safe_target(&root, within_root).map_err(|e| skill_err("路径解析", e))?;
    match fs::symlink_metadata(&target) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("技能同步拒绝符号链接：{}", target.display()))
        }
        Ok(meta) if meta.is_file() => {
            Err(format!("技能目录目标是文件：{}", target.display()))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            ensure_safe_parent(&root, &target).map_err(|e| skill_err("创建父目录", e))?;
            fs::create_dir(&target)
                .map_err(|e| skill_err("创建目录", NoteSyncError::Io(e)))
        }
        Err(error) => Err(skill_err("目录检查", NoteSyncError::Io(error))),
    }
}

/// 应用远端删除。根不存在视为已删除（幂等成功）。
pub fn apply_remote_tombstone(
    root: &std::path::Path,
    within_root: &str,
    entry_type: SkillEntryType,
) -> Result<(), String> {
    if !root.exists() {
        return Ok(());
    }
    let root = prepare_root(root)?;
    let (target, _) = safe_target(&root, within_root).map_err(|e| skill_err("路径解析", e))?;
    let meta = match fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(skill_err("删除检查", NoteSyncError::Io(error))),
    };
    if meta.file_type().is_symlink() {
        return Err(format!("技能同步拒绝符号链接：{}", target.display()));
    }
    match entry_type {
        SkillEntryType::File => {
            if !meta.is_file() {
                return Err(format!("技能文件删除目标不是文件：{within_root}"));
            }
            fs::remove_file(&target).map_err(|e| skill_err("删除", NoteSyncError::Io(e)))
        }
        SkillEntryType::Directory => {
            if !meta.is_dir() {
                return Err(format!("技能目录删除目标不是目录：{within_root}"));
            }
            remove_tree_no_symlinks(&target).map_err(|e| skill_err("删除目录", e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn key() -> [u8; 32] {
        [23u8; 32]
    }

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "aishell-skill-sync-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn cleanup(root: &Path) {
        let _ = std::fs::remove_dir_all(root);
    }

    fn skill_md(name: &str, desc: &str) -> String {
        format!(
            "---\nname: {name}\ndescription: {desc}\nscope:\n  - all\nenabled: true\n---\n\n# {name}\n正文\n"
        )
    }

    fn write(path: &std::path::Path, content: &str) {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        std::fs::write(path, content).unwrap();
    }

    fn global_spec(root: &std::path::Path) -> SkillRootSpec {
        SkillRootSpec {
            prefix: "global".into(),
            root: root.to_path_buf(),
        }
    }

    #[test]
    fn split_skill_path_validates_scope_name_and_hidden() {
        let (scope, within) = split_skill_path("global/alpha/scripts/run.sh").unwrap();
        assert_eq!(scope, SkillSyncScope::Global);
        assert_eq!(within, "alpha/scripts/run.sh");
        let (scope, within) = split_skill_path("project/p-1.x/alpha").unwrap();
        assert_eq!(scope, SkillSyncScope::Project("p-1.x".into()));
        assert_eq!(within, "alpha");
        // 只有技能名没有相对路径：合法（目录实体）
        assert_eq!(split_skill_path("global/alpha").unwrap().1, "alpha");
        // 非法 scope / 项目标识 / 技能名 / 隐藏段 / 逃逸路径
        assert!(split_skill_path("other/alpha/x").is_err());
        assert!(split_skill_path("project/p%1/alpha/x").is_err());
        assert!(split_skill_path("global/Bad_Name/x").is_err());
        assert!(split_skill_path("global/.hidden/x").is_err());
        assert!(split_skill_path("global/alpha/../x").is_err());
    }

    #[test]
    fn scan_collects_valid_skills_and_skips_invalid() {
        let ws = temp_root("scan");
        let root = ws.join("skills");
        write(&root.join("alpha").join("SKILL.md"), &skill_md("alpha", "合法"));
        write(&root.join("alpha").join("scripts").join("run.sh"), "#!/bin/sh\n");
        std::fs::create_dir_all(root.join("alpha").join("references")).unwrap();
        // 损坏：frontmatter name 与目录不一致
        write(&root.join("broken").join("SKILL.md"), &skill_md("other", "坏"));
        // 非 UTF-8 资源（二进制附件）
        let bytes: Vec<u8> = (0..=255u8).collect();
        std::fs::create_dir_all(root.join("alpha").join("assets")).unwrap();
        std::fs::write(root.join("alpha").join("assets").join("img.bin"), &bytes).unwrap();
        // 非技能目录、隐藏条目
        std::fs::create_dir_all(root.join("plain-folder")).unwrap();
        write(&root.join("alpha").join(".builtin-sha256"), "x");

        let outcome = scan_skill_roots(&[global_spec(&root)], &key());
        assert_eq!(outcome.skill_count, 1);
        assert!(outcome.scanned_prefixes.contains("global"));
        // 目录：alpha、assets、references、scripts
        assert_eq!(outcome.directory_payloads.len(), 4);
        // 文件：SKILL.md、assets/img.bin、scripts/run.sh
        assert_eq!(outcome.file_payloads.len(), 3);
        let bin = outcome
            .file_payloads
            .iter()
            .find(|p| p.path == "global/alpha/assets/img.bin")
            .unwrap();
        assert_eq!(bin.encoding, SkillContentEncoding::Base64);
        assert_eq!(sha256_hex(&bytes), bin.hash);
        assert!(outcome
            .index
            .iter()
            .all(|r| !r.path.contains(".builtin-sha256")));
        assert!(outcome.index.iter().all(|r| !r.path.contains("broken")));
        assert!(outcome.index.iter().all(|r| !r.path.contains("plain-folder")));
        // 索引 entity_id 与 skill_entity_id 一致
        let record = outcome
            .index
            .iter()
            .find(|r| r.path == "global/alpha/SKILL.md")
            .unwrap();
        assert_eq!(
            record.entity_id,
            skill_entity_id(&key(), "global/alpha/SKILL.md").unwrap()
        );
        cleanup(&ws);
    }

    #[test]
    fn scan_skips_untouched_builtin_but_syncs_modified() {
        let ws = temp_root("builtin");
        let root = ws.join("skills");
        let content = skill_md("skill-management", "内置");
        let dir = root.join("skill-management");
        write(&dir.join("SKILL.md"), &content);
        // 侧车与内容一致 → 视为内置原样，跳过
        write(&dir.join(".builtin-sha256"), &sha256_hex(content.as_bytes()));
        let outcome = scan_skill_roots(&[global_spec(&root)], &key());
        assert_eq!(outcome.skill_count, 0);
        // 用户改过（侧车落后）→ 正常同步
        write(&dir.join("SKILL.md"), &skill_md("skill-management", "改过"));
        let outcome = scan_skill_roots(&[global_spec(&root)], &key());
        assert_eq!(outcome.skill_count, 1);
        cleanup(&ws);
    }

    #[test]
    fn scan_missing_root_is_not_scanned() {
        let ws = temp_root("missing");
        let outcome = scan_skill_roots(&[global_spec(&ws.join("nope"))], &key());
        assert!(outcome.index.is_empty());
        assert!(outcome.scanned_prefixes.is_empty());
        cleanup(&ws);
    }

    #[test]
    fn diff_orders_upserts_by_depth_and_tombstones_reversed() {
        let record = |path: &str, kind: SkillEntryType| SkillIndexRecord {
            entity_id: skill_entity_id(&key(), path).unwrap(),
            hash: "h".into(),
            entry_type: kind,
            path: path.into(),
        };
        let old = vec![
            record("global/alpha/SKILL.md", SkillEntryType::File),
            record("global/alpha/scripts", SkillEntryType::Directory),
        ];
        // 新增嵌套文件 + 修改 SKILL.md + 删除 scripts 目录
        let current = vec![
            SkillIndexRecord {
                hash: "h2".into(),
                ..record("global/alpha/SKILL.md", SkillEntryType::File)
            },
            record("global/beta/SKILL.md", SkillEntryType::File),
            record("global/beta", SkillEntryType::Directory),
        ];
        let plan = diff_skill_indexes(&old, &current);
        // upserts 按 (深度, 路径) 排序：父目录（beta）先于其子文件；同深度按路径字典序
        let upsert_paths: Vec<&str> = plan.upserts.iter().map(|u| u.path.as_str()).collect();
        assert_eq!(
            upsert_paths,
            vec!["global/beta", "global/alpha/SKILL.md", "global/beta/SKILL.md"]
        );
        // tombstones：仅被删除的 scripts 目录（SKILL.md 是修改，走 upsert）
        let tombstone_paths: Vec<&str> = plan.tombstones.iter().map(|t| t.path.as_str()).collect();
        assert_eq!(tombstone_paths, vec!["global/alpha/scripts"]);
    }

    #[test]
    fn apply_roundtrip_restores_tree_and_validates() {
        let source_ws = temp_root("rt-src");
        let target_ws = temp_root("rt-dst");
        let source = source_ws.join("skills");
        let target = target_ws.join("skills");
        write(&source.join("alpha").join("SKILL.md"), &skill_md("alpha", "回环"));
        write(
            &source.join("alpha").join("scripts").join("run.sh"),
            "#!/bin/sh\necho hi\n",
        );
        std::fs::create_dir_all(source.join("alpha").join("references")).unwrap();

        let outcome = scan_skill_roots(&[global_spec(&source)], &key());
        let plan = diff_skill_indexes(&[], &outcome.index);
        assert!(plan.tombstones.is_empty());
        for upsert in &plan.upserts {
            let (_, within) = split_skill_path(&upsert.path).unwrap();
            match upsert.entry_type {
                SkillEntryType::File => {
                    let payload = outcome.file_payload(&upsert.path).unwrap();
                    apply_remote_file(&target, &within, payload).unwrap();
                }
                SkillEntryType::Directory => {
                    let payload = outcome.directory_payload(&upsert.path).unwrap();
                    apply_remote_directory(&target, &within, payload).unwrap();
                }
            }
        }
        assert_eq!(
            std::fs::read_to_string(target.join("alpha").join("SKILL.md")).unwrap(),
            skill_md("alpha", "回环")
        );
        assert!(target.join("alpha").join("references").is_dir());
        assert!(!target.join("alpha").join(".builtin-sha256").exists());
        // hash 不匹配拒绝写入
        let mut bad = outcome
            .file_payload("global/alpha/SKILL.md")
            .unwrap()
            .clone();
        bad.hash = "00".repeat(32);
        assert!(apply_remote_file(&target, "alpha/SKILL.md", &bad).is_err());
        // SKILL.md frontmatter 损坏拒绝写入
        let mut broken = bad;
        broken.hash = sha256_hex(b"---\nname: alpha\n---\n");
        broken.content = "---\nname: alpha\n---\n".into();
        broken.encoding = SkillContentEncoding::Utf8;
        assert!(apply_remote_file(&target, "alpha/SKILL.md", &broken).is_err());
        // 目录 payload hash 不匹配拒绝
        let mut bad_dir = outcome.directory_payload("global/alpha").unwrap().clone();
        bad_dir.hash = "00".repeat(32);
        assert!(apply_remote_directory(&target, "alpha", &bad_dir).is_err());
        // tombstone：先删子文件再删目录
        apply_remote_tombstone(&target, "alpha/scripts/run.sh", SkillEntryType::File).unwrap();
        assert!(!target.join("alpha").join("scripts").join("run.sh").exists());
        apply_remote_tombstone(&target, "alpha/scripts", SkillEntryType::Directory).unwrap();
        assert!(!target.join("alpha").join("scripts").exists());
        // 幂等：目标不存在时成功
        apply_remote_tombstone(&target, "alpha/scripts", SkillEntryType::Directory).unwrap();
        cleanup(&source_ws);
        cleanup(&target_ws);
    }

    #[test]
    fn skill_entity_id_is_domain_separated_from_notes() {
        let path = "global/alpha/SKILL.md";
        assert_eq!(
            skill_entity_id(&key(), path).unwrap(),
            skill_entity_id(&key(), path).unwrap()
        );
        assert_ne!(
            skill_entity_id(&key(), path).unwrap(),
            super::super::crypto::note_entity_id(&key(), path).unwrap()
        );
        assert!(skill_entity_id(&key(), "../escape").is_err());
    }
}
