//! 仪表盘文件级云同步的安全纯逻辑层（与 notes_sync/skills_sync 同构的受限文件域）。
//!
//! 同步路径命名空间（NFC、`/` 分隔）：`project/<projectId>/<固定文件名>`，固定三文件：
//! - `dashboard.py`：定制脚本（AI 经 dashboard_reload / 用户编辑产生）；
//! - `memo.md`：备忘录文本；
//! - `table.json`：备忘录顶部可编辑表格数据。
//!
//! 同步范围刻意收窄，避免把本机状态灌进云端或让单个坏文件卡死同步：
//! - 只认上面的固定文件名清单（无子目录），目录里其它文件（含 `.tmp`/`.bak`
//!   原子写残留等点开头条目）一律跳过；
//! - 仪表盘目录不存在（该项目从未打开过仪表盘面板）→ 本轮状态未知，不进
//!   `scanned_prefixes`，diff 不据此产生 tombstone；
//! - 文件是符号链接或超限（上限与技能一致 16MB）跳过该文件；
//! - 落盘复用 notes_sync 的 safe_target/ensure_safe_parent/atomic_write（symlink
//!   TOCTOU 防护同语义），错误文案在本模块映射为仪表盘语境；
//! - 文件内容写入前复验 payload hash（云端数据损坏时让该轮同步失败并保留现场）。
//!
//! 与技能的「内置播种原样副本跳过」不同：这里不过滤默认内容——目录只在面板
//! 渲染过之后才存在（seed_default 在 render 时播种），存在即代表真实使用过，
//! 三文件都算用户状态。用户手动删目录视为「重置」意图，按笔记同语义传播。

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::crypto::{
    dashboard_entity_id, decode_strict_base64, encode_base64, normalize_note_path, sha256_hex,
};
use super::notes_sync::{
    atomic_write, ensure_safe_parent, normalized_sync_path, safe_target, NoteSyncError,
};

/// 仪表盘 payload 的当前 schema 版本。
pub const DASHBOARD_PAYLOAD_SCHEMA_VERSION: u32 = 1;
/// 与服务端同步实体类型对应的名称（服务端 entity_type 白名单须包含）。
pub const DASHBOARD_ENTITY_TYPE: &str = "dashboard";
/// 仪表盘索引基线在本地 baseline 存储里的固定 (entity_type, entity_id)。
pub const DASHBOARD_INDEX_BASELINE_TYPE: &str = "dashboard_index";
pub const DASHBOARD_INDEX_BASELINE_ID: &str = "default";

/// 同步白名单：仪表盘目录里只有这三个文件是用户状态。
pub const SYNC_FILES: [&str; 3] = ["dashboard.py", "memo.md", "table.json"];
/// 单文件同步上限：备忘/表格/脚本都是小文本，超限视为异常，跳过该文件。
const MAX_FILE_BYTES: usize = 16 * 1024 * 1024;

/// 文件内容的传输编码：文本直存，二进制走标准 base64。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DashboardContentEncoding {
    Utf8,
    Base64,
}

/// 当前索引的一条记录（与 NoteIndexRecord/SkillIndexRecord 字段语义一致）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardIndexRecord {
    pub entity_id: String,
    pub hash: String,
    pub path: String,
}

/// tombstone 反查记录：按 entity_id 存 baseline，应用删除时还原同步路径。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardIndexRecordBaseline {
    pub path: String,
}

/// 版本 1 的仪表盘文件 payload；hash 是原始字节的 SHA-256。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DashboardFilePayloadV1 {
    pub schema_version: u32,
    pub path: String,
    pub encoding: DashboardContentEncoding,
    pub content: String,
    pub hash: String,
}

/// 一个待扫描的仪表盘根（每项目一个）。
#[derive(Debug, Clone)]
pub struct DashboardRootSpec {
    /// 同步路径前缀：`project/<projectId>`。
    pub prefix: String,
    pub root: PathBuf,
}

/// 扫描产出的完整快照。
#[derive(Debug, Default)]
pub struct DashboardScanOutcome {
    pub index: Vec<DashboardIndexRecord>,
    pub file_payloads: Vec<DashboardFilePayloadV1>,
    /// 本轮实际扫描过内容的根前缀。根目录缺失/不可读的根不在其中——状态未知时
    /// diff 不得据此产生 tombstone（项目目录移动/还原中不能误删云端仪表盘）。
    pub scanned_prefixes: BTreeSet<String>,
}

impl DashboardScanOutcome {
    pub fn file_payload(&self, path: &str) -> Option<&DashboardFilePayloadV1> {
        self.file_payloads.iter().find(|p| p.path == path)
    }
}

/// 一个需要上传的实体。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardUpsert {
    pub entity_id: String,
    pub hash: String,
    pub path: String,
}

/// 一个需要上传的删除 tombstone。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DashboardTombstone {
    pub entity_id: String,
    pub path: String,
}

/// 基于上轮索引与本轮扫描的上传/删除计划。
#[derive(Debug, Default, PartialEq, Eq)]
pub struct DashboardSyncPlan {
    pub upserts: Vec<DashboardUpsert>,
    pub tombstones: Vec<DashboardTombstone>,
}

/// 同步路径前缀（首段）：只有 `project`。
pub fn dashboard_path_prefix(path: &str) -> Option<&str> {
    path.split('/').next().filter(|s| !s.is_empty())
}

fn is_safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

/// 解析同步路径 `project/<projectId>/<固定文件名>`，返回 (projectId, 文件名)。
/// 文件名必须在白名单内——仪表盘域没有自由路径，防呆也防跨域实体替换。
pub fn split_dashboard_path(path: &str) -> Result<(String, String), String> {
    let normalized = normalized_sync_path(path).map_err(|e| dashboard_err("路径解析", e))?;
    let mut parts = normalized.split('/');
    let scope = parts.next().unwrap_or_default();
    if scope != "project" {
        return Err(format!("仪表盘同步路径 scope 不合法：{normalized}"));
    }
    let pid = parts.next().ok_or("仪表盘同步路径缺少项目标识")?;
    if !is_safe_id(pid) {
        return Err(format!("仪表盘同步路径的项目标识不合法：{pid}"));
    }
    let name = parts.next().ok_or("仪表盘同步路径缺少文件名")?;
    if parts.next().is_some() {
        return Err(format!("仪表盘同步路径不含子目录：{normalized}"));
    }
    if !SYNC_FILES.contains(&name) {
        return Err(format!("仪表盘同步路径的文件名不在白名单内：{name}"));
    }
    Ok((pid.to_string(), name.to_string()))
}

/// 扫描全部仪表盘根。单个文件损坏/超限/含链接只影响自身（跳过），不影响其它文件。
pub fn scan_dashboard_roots(specs: &[DashboardRootSpec], vault_key: &[u8; 32]) -> DashboardScanOutcome {
    let mut outcome = DashboardScanOutcome::default();
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
        outcome.scanned_prefixes.insert(prefix.clone());
        for name in SYNC_FILES {
            let file = spec.root.join(name);
            let Ok(file_meta) = fs::symlink_metadata(&file) else {
                continue;
            };
            if file_meta.file_type().is_symlink() || !file_meta.is_file() {
                continue;
            }
            if file_meta.len() as usize > MAX_FILE_BYTES {
                continue;
            }
            // 读取前后复核未被替换/改写（扫描期间正在写入的文件按失败跳过）。
            let Ok(bytes) = read_stable(&file) else {
                continue;
            };
            let sync_path = match normalize_note_path(&format!("{prefix}/{name}")) {
                Ok(path) => path,
                Err(_) => continue,
            };
            let hash = sha256_hex(&bytes);
            let Ok(entity_id) = dashboard_entity_id(vault_key, &sync_path) else {
                continue;
            };
            outcome.index.push(DashboardIndexRecord {
                entity_id,
                hash: hash.clone(),
                path: sync_path.clone(),
            });
            let (encoding, content) = match std::str::from_utf8(&bytes) {
                Ok(text) => (DashboardContentEncoding::Utf8, text.to_string()),
                Err(_) => (DashboardContentEncoding::Base64, encode_base64(&bytes)),
            };
            outcome.file_payloads.push(DashboardFilePayloadV1 {
                schema_version: DASHBOARD_PAYLOAD_SCHEMA_VERSION,
                path: sync_path,
                encoding,
                content,
                hash,
            });
        }
    }
    outcome.index.sort_by(|left, right| left.path.cmp(&right.path));
    outcome
        .file_payloads
        .sort_by(|left, right| left.path.cmp(&right.path));
    outcome
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

/// 根据 entityId 比较索引（与 notes/skills 的 diff 同语义）：同一路径的内容变化只生成
/// upsert，删除生成 tombstone。
pub fn diff_dashboard_indexes(old: &[DashboardIndexRecord], current: &[DashboardIndexRecord]) -> DashboardSyncPlan {
    let old_by_id: BTreeMap<&str, &DashboardIndexRecord> = old
        .iter()
        .map(|record| (record.entity_id.as_str(), record))
        .collect();
    let current_by_id: BTreeMap<&str, &DashboardIndexRecord> = current
        .iter()
        .map(|record| (record.entity_id.as_str(), record))
        .collect();
    let mut plan = DashboardSyncPlan::default();
    for (entity_id, record) in &current_by_id {
        if old_by_id
            .get(entity_id)
            .is_none_or(|old| old.hash != record.hash || old.path != record.path)
        {
            plan.upserts.push(DashboardUpsert {
                entity_id: (*entity_id).to_string(),
                hash: record.hash.clone(),
                path: record.path.clone(),
            });
        }
    }
    for (entity_id, record) in &old_by_id {
        if !current_by_id.contains_key(entity_id) {
            plan.tombstones.push(DashboardTombstone {
                entity_id: (*entity_id).to_string(),
                path: record.path.clone(),
            });
        }
    }
    plan.upserts.sort_by(|left, right| left.path.cmp(&right.path));
    plan.tombstones.sort_by(|left, right| left.path.cmp(&right.path));
    plan
}

// ---------------------------------------------------------------- 远端应用

fn dashboard_err(context: &str, error: NoteSyncError) -> String {
    match error {
        NoteSyncError::Io(error) => format!("仪表盘同步文件操作失败（{context}）：{error}"),
        NoteSyncError::Symlink(path) => format!("仪表盘同步拒绝符号链接：{path}"),
        NoteSyncError::InvalidPath(path) => format!("仪表盘同步路径不合法：{path}"),
        NoteSyncError::InvalidRoot(path) => format!("仪表盘根目录不合法：{path}"),
        NoteSyncError::Collision(path) => format!("仪表盘同步目标冲突：{path}"),
        other => format!("仪表盘同步失败（{context}）：{other}"),
    }
}

/// 校验并解码远端文件 payload，返回原始字节。
fn decoded_file_bytes(payload: &DashboardFilePayloadV1) -> Result<Vec<u8>, String> {
    if payload.schema_version != DASHBOARD_PAYLOAD_SCHEMA_VERSION {
        return Err(format!(
            "不支持的仪表盘文件 schema 版本：{}",
            payload.schema_version
        ));
    }
    // 路径二次校验 + 文件名白名单（防跨域实体替换）。
    split_dashboard_path(&payload.path)?;
    let bytes = match payload.encoding {
        DashboardContentEncoding::Utf8 => payload.content.as_bytes().to_vec(),
        DashboardContentEncoding::Base64 => decode_strict_base64(&payload.content)
            .map_err(|e| format!("仪表盘文件 base64 解码失败：{e}"))?,
    };
    if sha256_hex(&bytes) != payload.hash {
        return Err(format!("仪表盘文件 hash 不匹配：{}", payload.path));
    }
    Ok(bytes)
}

/// 原子写入远端仪表盘文件。`root` 为 `<项目根>/.aishell/dashboard`（不存在则创建），
/// `file_name` 为白名单文件名。
pub fn apply_remote_file(
    root: &std::path::Path,
    file_name: &str,
    payload: &DashboardFilePayloadV1,
) -> Result<(), String> {
    let bytes = decoded_file_bytes(payload)?;
    if !SYNC_FILES.contains(&file_name) {
        return Err(format!("仪表盘同步文件名不在白名单内：{file_name}"));
    }
    if !root.exists() {
        fs::create_dir_all(root).map_err(|e| {
            format!("创建仪表盘根目录失败（{}）：{e}", root.display())
        })?;
    }
    let meta = fs::symlink_metadata(root)
        .map_err(|e| dashboard_err("根目录检查", NoteSyncError::Io(e)))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!("仪表盘根目录不合法：{}", root.display()));
    }
    let (target, _) = safe_target(root, file_name).map_err(|e| dashboard_err("路径解析", e))?;
    ensure_safe_parent(root, &target).map_err(|e| dashboard_err("创建父目录", e))?;
    atomic_write(&target, &bytes, true).map_err(|e| dashboard_err("写入", e))
}

/// 应用远端删除。根/文件不存在视为已删除（幂等成功）。
pub fn apply_remote_tombstone(root: &std::path::Path, file_name: &str) -> Result<(), String> {
    if !SYNC_FILES.contains(&file_name) {
        return Err(format!("仪表盘同步文件名不在白名单内：{file_name}"));
    }
    if !root.exists() {
        return Ok(());
    }
    let meta = fs::symlink_metadata(root)
        .map_err(|e| dashboard_err("根目录检查", NoteSyncError::Io(e)))?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(format!("仪表盘根目录不合法：{}", root.display()));
    }
    let (target, _) = safe_target(root, file_name).map_err(|e| dashboard_err("路径解析", e))?;
    let target_meta = match fs::symlink_metadata(&target) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(dashboard_err("删除检查", NoteSyncError::Io(error))),
    };
    if target_meta.file_type().is_symlink() {
        return Err(format!("仪表盘同步拒绝符号链接：{}", target.display()));
    }
    if !target_meta.is_file() {
        return Err(format!("仪表盘文件删除目标不是文件：{file_name}"));
    }
    fs::remove_file(&target).map_err(|e| dashboard_err("删除", NoteSyncError::Io(e)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn key() -> [u8; 32] {
        [31u8; 32]
    }

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!(
            "aishell-dashboard-sync-{label}-{}-{nonce}",
            std::process::id()
        ))
    }

    fn cleanup(root: &Path) {
        let _ = std::fs::remove_dir_all(root);
    }

    fn spec(root: &Path, project_id: &str) -> DashboardRootSpec {
        DashboardRootSpec {
            prefix: format!("project/{project_id}"),
            root: root.to_path_buf(),
        }
    }

    #[test]
    fn split_dashboard_path_whitelists_file_names() {
        let (pid, name) = split_dashboard_path("project/p-1/memo.md").unwrap();
        assert_eq!(pid, "p-1");
        assert_eq!(name, "memo.md");
        assert!(split_dashboard_path("project/p-1/secret.txt").is_err());
        assert!(split_dashboard_path("project/p-1/sub/memo.md").is_err());
        assert!(split_dashboard_path("global/memo.md").is_err());
        assert!(split_dashboard_path("project/../etc/passwd").is_err());
        assert!(split_dashboard_path("project/p-1/.builtin-sha256").is_err());
    }

    #[test]
    fn entity_id_is_deterministic_and_domain_isolated() {
        let a = dashboard_entity_id(&key(), "project/p1/memo.md").unwrap();
        let b = dashboard_entity_id(&key(), "project/p1/memo.md").unwrap();
        assert_eq!(a, b);
        // 与笔记/技能域同路径不同 ID（域隔离）。
        let note = super::super::crypto::note_entity_id(&key(), "project/p1/memo.md").unwrap();
        assert_ne!(a, note);
        // 不同项目不同 ID。
        let other = dashboard_entity_id(&key(), "project/p2/memo.md").unwrap();
        assert_ne!(a, other);
    }

    #[test]
    fn scan_collects_whitelisted_files_only_and_reports_scanned_prefix() {
        let root = temp_root("scan");
        let dir = root.join(".aishell").join("dashboard");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("memo.md"), "# memo\n").unwrap();
        fs::write(dir.join("dashboard.py"), "print('x')\n").unwrap();
        fs::write(dir.join("stray.txt"), "ignored").unwrap();
        fs::write(dir.join(".tmp"), "ignored").unwrap();

        let outcome = scan_dashboard_roots(&[spec(&dir, "p1")], &key());
        assert!(outcome.scanned_prefixes.contains("project/p1"));
        assert_eq!(outcome.index.len(), 2);
        assert!(outcome
            .index
            .iter()
            .all(|r| r.path.ends_with("memo.md") || r.path.ends_with("dashboard.py")));
        cleanup(&root);
    }

    #[test]
    fn scan_missing_root_is_not_scanned_and_diff_keeps_cloud() {
        let root = temp_root("missing");
        let dir = root.join(".aishell").join("dashboard");
        let outcome = scan_dashboard_roots(&[spec(&dir, "p1")], &key());
        assert!(outcome.scanned_prefixes.is_empty());
        assert!(outcome.index.is_empty());

        // 上一轮有记录、本轮目录缺失（未扫描）→ tombstone 由调用方按前缀保留策略丢弃。
        let old = vec![DashboardIndexRecord {
            entity_id: dashboard_entity_id(&key(), "project/p1/memo.md").unwrap(),
            hash: "h".into(),
            path: "project/p1/memo.md".into(),
        }];
        let plan = diff_dashboard_indexes(&old, &outcome.index);
        assert_eq!(plan.tombstones.len(), 1);
        assert!(!outcome
            .scanned_prefixes
            .contains(dashboard_path_prefix(&plan.tombstones[0].path).unwrap()));
        cleanup(&root);
    }

    #[test]
    fn diff_detects_content_change_and_deletion() {
        let old = vec![DashboardIndexRecord {
            entity_id: dashboard_entity_id(&key(), "project/p1/memo.md").unwrap(),
            hash: "old".into(),
            path: "project/p1/memo.md".into(),
        }];
        let current = vec![DashboardIndexRecord {
            entity_id: dashboard_entity_id(&key(), "project/p1/memo.md").unwrap(),
            hash: "new".into(),
            path: "project/p1/memo.md".into(),
        }];
        let plan = diff_dashboard_indexes(&old, &current);
        assert_eq!(plan.upserts.len(), 1);
        assert!(plan.tombstones.is_empty());

        let plan = diff_dashboard_indexes(&current, &[]);
        assert!(plan.upserts.is_empty());
        assert_eq!(plan.tombstones.len(), 1);
    }

    #[test]
    fn apply_roundtrip_writes_and_tombstone_removes() {
        let root = temp_root("apply");
        let dir = root.join(".aishell").join("dashboard");
        fs::create_dir_all(&dir).unwrap();
        let content = b"# updated memo".to_vec();
        let payload = DashboardFilePayloadV1 {
            schema_version: DASHBOARD_PAYLOAD_SCHEMA_VERSION,
            path: "project/p1/memo.md".into(),
            encoding: DashboardContentEncoding::Utf8,
            content: String::from_utf8(content.clone()).unwrap(),
            hash: sha256_hex(&content),
        };
        apply_remote_file(&dir, "memo.md", &payload).unwrap();
        assert_eq!(fs::read(dir.join("memo.md")).unwrap(), content);

        apply_remote_tombstone(&dir, "memo.md").unwrap();
        assert!(!dir.join("memo.md").exists());
        // 幂等：再删一次仍成功。
        apply_remote_tombstone(&dir, "memo.md").unwrap();
        cleanup(&root);
    }

    #[test]
    fn apply_rejects_tampered_payload_and_non_whitelisted_name() {
        let dir = temp_root("tamper");
        fs::create_dir_all(&dir).unwrap();
        let payload = DashboardFilePayloadV1 {
            schema_version: DASHBOARD_PAYLOAD_SCHEMA_VERSION,
            path: "project/p1/memo.md".into(),
            encoding: DashboardContentEncoding::Utf8,
            content: "evil".into(),
            hash: sha256_hex(b"other"),
        };
        assert!(apply_remote_file(&dir, "memo.md", &payload).is_err());

        let mut payload = payload;
        payload.hash = sha256_hex(b"evil");
        payload.path = "project/p1/other.txt".into();
        assert!(apply_remote_file(&dir, "other.txt", &payload).is_err());
        cleanup(&dir);
    }

    #[test]
    fn apply_creates_missing_root_dir() {
        let root = temp_root("create");
        let dir = root.join(".aishell").join("dashboard");
        let content = b"print('hi')".to_vec();
        let payload = DashboardFilePayloadV1 {
            schema_version: DASHBOARD_PAYLOAD_SCHEMA_VERSION,
            path: "project/p1/dashboard.py".into(),
            encoding: DashboardContentEncoding::Utf8,
            content: String::from_utf8(content.clone()).unwrap(),
            hash: sha256_hex(&content),
        };
        apply_remote_file(&dir, "dashboard.py", &payload).unwrap();
        assert_eq!(fs::read(dir.join("dashboard.py")).unwrap(), content);
        cleanup(&root);
    }

    #[test]
    fn scan_stable_handles_binary_content_via_base64() {
        let root = temp_root("binary");
        let dir = root.join(".aishell").join("dashboard");
        fs::create_dir_all(&dir).unwrap();
        let bytes = vec![0xff, 0xfe, 0x00, 0x01];
        fs::write(dir.join("memo.md"), &bytes).unwrap();
        let outcome = scan_dashboard_roots(&[spec(&dir, "p1")], &key());
        assert_eq!(outcome.file_payloads.len(), 1);
        let payload = &outcome.file_payloads[0];
        assert_eq!(payload.encoding, DashboardContentEncoding::Base64);
        assert_eq!(decoded_file_bytes(payload).unwrap(), bytes);
        cleanup(&root);
    }
}
