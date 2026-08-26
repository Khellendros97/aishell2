//! 笔记文件级云同步的安全纯逻辑层。
//!
//! 本模块只处理 `.aishell/notes` 一类根目录：扫描结果的路径始终是 NFC、`/`
//! 分隔的相对路径；文件内容在这里保持为 UTF-8 明文，调用方再交给
//! `crypto::encrypt_sync_item` 加密。所有落盘操作都先校验边界、符号链接和
//! payload hash，再通过同目录临时文件原子替换。

use super::crypto::{normalize_note_path, note_entity_id, sha256_hex, CryptoError};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use unicode_normalization::UnicodeNormalization;

/// 笔记 payload 的当前 schema 版本。
pub const NOTE_PAYLOAD_SCHEMA_VERSION: u32 = 1;
/// 与服务端同步实体类型对应的名称。
pub const NOTE_ENTITY_TYPE: &str = "note";
pub const NOTE_DIRECTORY_ENTITY_TYPE: &str = "note_directory";
const EMPTY_DIRECTORY_DOMAIN: &[u8] = b"aishell.note-directory/v1\0";
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// 笔记同步错误。错误信息不包含文件内容或密钥。
#[derive(Debug)]
pub enum NoteSyncError {
    Io(io::Error),
    Crypto(CryptoError),
    InvalidRoot(String),
    InvalidPath(String),
    Symlink(String),
    UnsupportedEntry(String),
    InvalidPayload(String),
    DuplicatePath(String),
    Collision(String),
    InvalidUtf8(String),
}

impl fmt::Display for NoteSyncError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "笔记同步文件操作失败：{error}"),
            Self::Crypto(error) => write!(f, "笔记同步路径校验失败：{error}"),
            Self::InvalidRoot(path) => write!(f, "笔记根目录不合法：{path}"),
            Self::InvalidPath(path) => write!(f, "笔记相对路径不合法：{path}"),
            Self::Symlink(path) => write!(f, "笔记同步拒绝符号链接：{path}"),
            Self::UnsupportedEntry(path) => write!(f, "笔记目录包含不支持的文件类型：{path}"),
            Self::InvalidPayload(message) => write!(f, "笔记同步 payload 不合法：{message}"),
            Self::DuplicatePath(path) => write!(f, "笔记路径 NFC 规范化后重复：{path}"),
            Self::Collision(path) => write!(f, "笔记冲突副本已存在且无法命名：{path}"),
            Self::InvalidUtf8(path) => write!(f, "笔记不是 UTF-8 文本：{path}"),
        }
    }
}

impl std::error::Error for NoteSyncError {}

impl From<io::Error> for NoteSyncError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<CryptoError> for NoteSyncError {
    fn from(error: CryptoError) -> Self {
        Self::Crypto(error)
    }
}

pub type NoteSyncResult<T> = Result<T, NoteSyncError>;

/// 同步索引中的实体类别。serde 名称是服务端协议使用的 `file` / `directory`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteEntryType {
    File,
    Directory,
}

impl NoteEntryType {
    pub fn entity_type(self) -> &'static str {
        match self {
            Self::File => NOTE_ENTITY_TYPE,
            Self::Directory => NOTE_DIRECTORY_ENTITY_TYPE,
        }
    }
}

/// 当前索引的一条记录，字段与同步索引的 entityId/hash/type/path 一一对应。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteIndexRecord {
    pub entity_id: String,
    pub hash: String,
    #[serde(rename = "type")]
    pub entry_type: NoteEntryType,
    pub path: String,
}

/// 便于调用方按实体 ID 存放索引；扫描结果另有稳定排序的 records。
pub type NoteIndex = Vec<NoteIndexRecord>;

/// 版本 1 的笔记文件 payload。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NotePayloadV1 {
    pub schema_version: u32,
    pub path: String,
    pub content: String,
    pub hash: String,
}

impl NotePayloadV1 {
    pub fn new(path: impl Into<String>, content: impl Into<String>) -> NoteSyncResult<Self> {
        let path = normalized_sync_path(&path.into())?;
        let content = content.into();
        let hash = sha256_hex(content.as_bytes());
        Ok(Self {
            schema_version: NOTE_PAYLOAD_SCHEMA_VERSION,
            path,
            content,
            hash,
        })
    }
}

/// 版本 1 的目录 payload。目录 hash 对路径和 schema 做域隔离，空目录也能同步。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteDirectoryPayloadV1 {
    pub schema_version: u32,
    pub path: String,
    pub hash: String,
}

impl NoteDirectoryPayloadV1 {
    pub fn new(path: impl Into<String>) -> NoteSyncResult<Self> {
        let path = normalized_sync_path(&path.into())?;
        Ok(Self {
            schema_version: NOTE_PAYLOAD_SCHEMA_VERSION,
            hash: directory_hash(&path),
            path,
        })
    }
}

/// 扫描后的完整快照。`index` 可直接用于 diff，payloads 用于生成 upsert 内容。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NoteSnapshot {
    pub index: NoteIndex,
    pub payloads: Vec<NotePayloadV1>,
    pub directory_payloads: Vec<NoteDirectoryPayloadV1>,
}

impl NoteSnapshot {
    pub fn empty() -> Self {
        Self {
            index: Vec::new(),
            payloads: Vec::new(),
            directory_payloads: Vec::new(),
        }
    }

    pub fn payload(&self, path: &str) -> Option<&NotePayloadV1> {
        self.payloads.iter().find(|payload| payload.path == path)
    }

    pub fn directory_payload(&self, path: &str) -> Option<&NoteDirectoryPayloadV1> {
        self.directory_payloads
            .iter()
            .find(|payload| payload.path == path)
    }
}

/// 一个需要上传的实体索引记录。内容 payload 由快照按 path 取出并加密。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUpsert {
    pub entity_id: String,
    pub hash: String,
    #[serde(rename = "type")]
    pub entry_type: NoteEntryType,
    pub path: String,
}

impl From<NoteIndexRecord> for NoteUpsert {
    fn from(record: NoteIndexRecord) -> Self {
        Self {
            entity_id: record.entity_id,
            hash: record.hash,
            entry_type: record.entry_type,
            path: record.path,
        }
    }
}

/// 一个需要上传的删除 tombstone。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteTombstone {
    pub entity_id: String,
    #[serde(rename = "type")]
    pub entry_type: NoteEntryType,
    pub path: String,
    pub tombstone: bool,
}

/// 基于最后一次索引与本次扫描索引产生的上传/删除计划。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteSyncPlan {
    pub upserts: Vec<NoteUpsert>,
    pub tombstones: Vec<NoteTombstone>,
}

/// `DiffPlan` 是调用方常用的别名。
pub type DiffPlan = NoteSyncPlan;

/// 根据 entityId 比较索引。由于 entityId 由 NFC 路径派生，移动天然表现为旧 ID
/// tombstone + 新 ID upsert，而同一路径的内容变化只生成 upsert。
pub fn diff(old: &[NoteIndexRecord], current: &[NoteIndexRecord]) -> NoteSyncPlan {
    let old_by_id: BTreeMap<&str, &NoteIndexRecord> = old
        .iter()
        .map(|record| (record.entity_id.as_str(), record))
        .collect();
    let current_by_id: BTreeMap<&str, &NoteIndexRecord> = current
        .iter()
        .map(|record| (record.entity_id.as_str(), record))
        .collect();

    let mut plan = NoteSyncPlan::default();
    for (entity_id, record) in &current_by_id {
        if old_by_id.get(entity_id).is_none_or(|old_record| {
            old_record.hash != record.hash
                || old_record.entry_type != record.entry_type
                || old_record.path != record.path
        }) {
            plan.upserts.push(NoteUpsert {
                entity_id: record.entity_id.clone(),
                hash: record.hash.clone(),
                entry_type: record.entry_type,
                path: record.path.clone(),
            });
        }
    }
    for (entity_id, record) in &old_by_id {
        if !current_by_id.contains_key(entity_id) {
            plan.tombstones.push(NoteTombstone {
                entity_id: (*entity_id).to_string(),
                entry_type: record.entry_type,
                path: record.path.clone(),
                tombstone: true,
            });
        }
    }
    // 父目录必须先于文件存在；删除则反过来，避免目录 tombstone 抢先删除其子项。
    plan.upserts.sort_by(|left, right| {
        path_depth(&left.path)
            .cmp(&path_depth(&right.path))
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.entity_id.cmp(&right.entity_id))
    });
    plan.tombstones.sort_by(|left, right| {
        path_depth(&right.path)
            .cmp(&path_depth(&left.path))
            .then_with(|| left.path.cmp(&right.path))
            .then_with(|| left.entity_id.cmp(&right.entity_id))
    });
    plan
}

/// 与 `diff` 相同的显式命名，便于避免和其它同步域的 diff 混淆。
pub fn diff_indexes(old: &NoteIndex, current: &NoteIndex) -> NoteSyncPlan {
    diff(old, current)
}

/// 扫描 notes root。根目录本身不产生相对路径记录；其下的所有普通文件和目录
/// 都会被记录，因此非空目录和空目录均可在远端还原。
pub fn scan_notes(root: &Path, vault_key: &[u8; 32]) -> NoteSyncResult<NoteSnapshot> {
    let root = validated_root(root)?;
    let mut snapshot = NoteSnapshot::empty();
    let mut children = read_sorted_children(&root)?;
    children.sort_by(|left, right| {
        left.file_name()
            .map(|name| name.to_string_lossy().nfc().collect::<String>())
            .unwrap_or_default()
            .cmp(
                &right
                    .file_name()
                    .map(|name| name.to_string_lossy().nfc().collect::<String>())
                    .unwrap_or_default(),
            )
    });
    for child in children {
        scan_entry(&child, Path::new(""), vault_key, &mut snapshot)?;
    }
    snapshot
        .index
        .sort_by(|left, right| left.path.cmp(&right.path));
    snapshot
        .payloads
        .sort_by(|left, right| left.path.cmp(&right.path));
    snapshot
        .directory_payloads
        .sort_by(|left, right| left.path.cmp(&right.path));
    Ok(snapshot)
}

/// 语义更明确的扫描别名。
pub fn scan_notes_root(root: &Path, vault_key: &[u8; 32]) -> NoteSyncResult<NoteSnapshot> {
    scan_notes(root, vault_key)
}

fn scan_entry(
    path: &Path,
    parent_relative: &Path,
    vault_key: &[u8; 32],
    snapshot: &mut NoteSnapshot,
) -> NoteSyncResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    let relative = if parent_relative.as_os_str().is_empty() {
        path.file_name()
            .ok_or_else(|| NoteSyncError::InvalidPath(path.display().to_string()))?
            .to_string_lossy()
            .into_owned()
    } else {
        format!(
            "{}/{}",
            parent_relative.to_string_lossy().replace('\\', "/"),
            path.file_name()
                .ok_or_else(|| NoteSyncError::InvalidPath(path.display().to_string()))?
                .to_string_lossy()
        )
    };
    let relative = normalized_sync_path(&relative)?;
    if metadata.file_type().is_symlink() {
        return Err(NoteSyncError::Symlink(relative));
    }
    if metadata.is_dir() {
        let entity_id = note_entity_id(vault_key, &relative)?;
        let hash = directory_hash(&relative);
        push_unique_index(
            snapshot,
            NoteIndexRecord {
                entity_id,
                hash: hash.clone(),
                entry_type: NoteEntryType::Directory,
                path: relative.clone(),
            },
        )?;
        snapshot.directory_payloads.push(NoteDirectoryPayloadV1 {
            schema_version: NOTE_PAYLOAD_SCHEMA_VERSION,
            path: relative.clone(),
            hash,
        });
        let mut children = read_sorted_children(path)?;
        children.sort_by(|left, right| {
            left.file_name()
                .map(|name| name.to_string_lossy().nfc().collect::<String>())
                .unwrap_or_default()
                .cmp(
                    &right
                        .file_name()
                        .map(|name| name.to_string_lossy().nfc().collect::<String>())
                        .unwrap_or_default(),
                )
        });
        for child in children {
            scan_entry(&child, Path::new(&relative), vault_key, snapshot)?;
        }
        return Ok(());
    }
    if !metadata.is_file() {
        return Err(NoteSyncError::UnsupportedEntry(relative));
    }

    let bytes = fs::read(path)?;
    // 读取前后再次检查，避免扫描过程中目录项被替换为符号链接。
    let after = fs::symlink_metadata(path)?;
    if after.file_type().is_symlink() {
        return Err(NoteSyncError::Symlink(relative));
    }
    if !after.is_file() || after.len() != bytes.len() as u64 {
        return Err(NoteSyncError::InvalidPayload(format!(
            "文件在扫描期间发生变化：{relative}"
        )));
    }
    let content = String::from_utf8(bytes.clone())
        .map_err(|_| NoteSyncError::InvalidUtf8(relative.clone()))?;
    let hash = sha256_hex(&bytes);
    let entity_id = note_entity_id(vault_key, &relative)?;
    push_unique_index(
        snapshot,
        NoteIndexRecord {
            entity_id,
            hash: hash.clone(),
            entry_type: NoteEntryType::File,
            path: relative.clone(),
        },
    )?;
    snapshot.payloads.push(NotePayloadV1 {
        schema_version: NOTE_PAYLOAD_SCHEMA_VERSION,
        path: relative,
        content,
        hash,
    });
    Ok(())
}

fn push_unique_index(snapshot: &mut NoteSnapshot, record: NoteIndexRecord) -> NoteSyncResult<()> {
    if snapshot.index.iter().any(|old| old.path == record.path) {
        return Err(NoteSyncError::DuplicatePath(record.path));
    }
    if snapshot
        .index
        .iter()
        .any(|old| old.entity_id == record.entity_id)
    {
        return Err(NoteSyncError::DuplicatePath(record.path));
    }
    snapshot.index.push(record);
    Ok(())
}

fn read_sorted_children(path: &Path) -> NoteSyncResult<Vec<PathBuf>> {
    let mut children = fs::read_dir(path)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>, io::Error>>()?;
    children.sort_by(|left, right| left.file_name().cmp(&right.file_name()));
    Ok(children)
}

fn path_depth(path: &str) -> usize {
    path.split('/').count()
}

fn directory_hash(path: &str) -> String {
    let mut value = EMPTY_DIRECTORY_DOMAIN.to_vec();
    value.extend_from_slice(path.as_bytes());
    sha256_hex(&value)
}

/// 复用 crypto 的 NFC/path 规则，并补上 Windows 驱动器、ADS 和设备名规则。
/// 后三项即使在非 Windows 测试机也执行，保证同步数据跨平台可还原。
fn normalized_sync_path(path: &str) -> NoteSyncResult<String> {
    let normalized = normalize_note_path(path)?;
    for component in normalized.split('/') {
        if component.is_empty()
            || component == "."
            || component == ".."
            || component.contains(':')
            || component.ends_with(' ')
            || component.ends_with('.')
            || is_windows_device_name(component)
        {
            return Err(NoteSyncError::InvalidPath(path.to_string()));
        }
    }
    Ok(normalized)
}

fn is_windows_device_name(component: &str) -> bool {
    let stem = component
        .split_once('.')
        .map_or(component, |(stem, _)| stem)
        .to_ascii_uppercase();
    matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

fn validated_root(root: &Path) -> NoteSyncResult<PathBuf> {
    let metadata = fs::symlink_metadata(root)
        .map_err(|error| NoteSyncError::InvalidRoot(format!("{}（{error}）", root.display())))?;
    if metadata.file_type().is_symlink() {
        return Err(NoteSyncError::Symlink(root.display().to_string()));
    }
    if !metadata.is_dir() {
        return Err(NoteSyncError::InvalidRoot(root.display().to_string()));
    }
    let canonical = root
        .canonicalize()
        .map_err(|error| NoteSyncError::InvalidRoot(format!("{}（{error}）", root.display())))?;
    let canonical_meta = fs::symlink_metadata(&canonical)?;
    if canonical_meta.file_type().is_symlink() || !canonical_meta.is_dir() {
        return Err(NoteSyncError::InvalidRoot(canonical.display().to_string()));
    }
    Ok(canonical)
}

/// 在 root 下解析路径。逐组件检查 symlink，并用最近存在的祖先做 canonical 边界校验。
fn safe_target(root: &Path, relative: &str) -> NoteSyncResult<(PathBuf, String)> {
    let root = validated_root(root)?;
    let relative = normalized_sync_path(relative)?;
    let mut target = root.clone();
    for component in relative.split('/') {
        target.push(component);
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(NoteSyncError::Symlink(target.display().to_string()))
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(NoteSyncError::Io(error)),
        }
    }
    let mut probe = target.clone();
    while !probe.exists() {
        if !probe.pop() {
            return Err(NoteSyncError::InvalidPath(relative.clone()));
        }
    }
    let canonical_root = root.canonicalize()?;
    let canonical_probe = probe.canonicalize()?;
    if !canonical_probe.starts_with(&canonical_root) {
        return Err(NoteSyncError::InvalidPath(relative.clone()));
    }
    Ok((target, relative))
}

fn ensure_safe_parent(root: &Path, target: &Path) -> NoteSyncResult<()> {
    let root = validated_root(root)?;
    let parent = target
        .parent()
        .ok_or_else(|| NoteSyncError::InvalidPath(target.display().to_string()))?;
    let relative = parent
        .strip_prefix(&root)
        .map_err(|_| NoteSyncError::InvalidPath(parent.display().to_string()))?;
    let mut current = root;
    for component in relative.components() {
        let name = component.as_os_str();
        current.push(name);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(NoteSyncError::Symlink(current.display().to_string()))
            }
            Ok(metadata) if !metadata.is_dir() => {
                return Err(NoteSyncError::InvalidPath(current.display().to_string()))
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                fs::create_dir(&current)?;
                let created = fs::symlink_metadata(&current)?;
                if created.file_type().is_symlink() || !created.is_dir() {
                    return Err(NoteSyncError::InvalidPath(current.display().to_string()));
                }
            }
            Err(error) => return Err(NoteSyncError::Io(error)),
        }
    }
    Ok(())
}

fn temporary_path(parent: &Path, name: &str) -> PathBuf {
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let pid = std::process::id();
    parent.join(format!(".{name}.aishell-sync-{pid}-{sequence}.tmp"))
}

/// 同目录 tmp + flush + rename。Unix rename 可原子替换；Windows 的 rename 不覆盖已有
/// 文件，因此只在确认目标是普通文件后删除，再完成替换，绝不覆盖符号链接或目录。
fn atomic_write(target: &Path, bytes: &[u8], replace_existing: bool) -> NoteSyncResult<()> {
    let parent = target
        .parent()
        .ok_or_else(|| NoteSyncError::InvalidPath(target.display().to_string()))?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| NoteSyncError::InvalidPath(target.display().to_string()))?;
    let temporary = temporary_path(parent, name);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let write_result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok::<(), io::Error>(())
    })();
    drop(file);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(NoteSyncError::Io(error));
    }

    let result = if replace_existing {
        match fs::rename(&temporary, target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                let metadata = fs::symlink_metadata(target)?;
                if metadata.file_type().is_symlink() || !metadata.is_file() {
                    Err(NoteSyncError::Symlink(target.display().to_string()))
                } else {
                    fs::remove_file(target)?;
                    fs::rename(&temporary, target).map_err(NoteSyncError::Io)
                }
            }
            Err(error) => Err(NoteSyncError::Io(error)),
        }
    } else {
        match fs::rename(&temporary, target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                Err(NoteSyncError::Collision(target.display().to_string()))
            }
            Err(error) => Err(NoteSyncError::Io(error)),
        }
    };
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn validate_file_payload(payload: &NotePayloadV1) -> NoteSyncResult<String> {
    if payload.schema_version != NOTE_PAYLOAD_SCHEMA_VERSION {
        return Err(NoteSyncError::InvalidPayload(format!(
            "不支持的文件 schema 版本：{}",
            payload.schema_version
        )));
    }
    let path = normalized_sync_path(&payload.path)?;
    let actual_hash = sha256_hex(payload.content.as_bytes());
    if payload.hash != actual_hash {
        return Err(NoteSyncError::InvalidPayload(format!(
            "文件 hash 不匹配：{path}"
        )));
    }
    Ok(path)
}

fn validate_directory_payload(payload: &NoteDirectoryPayloadV1) -> NoteSyncResult<String> {
    if payload.schema_version != NOTE_PAYLOAD_SCHEMA_VERSION {
        return Err(NoteSyncError::InvalidPayload(format!(
            "不支持的目录 schema 版本：{}",
            payload.schema_version
        )));
    }
    let path = normalized_sync_path(&payload.path)?;
    if payload.hash != directory_hash(&path) {
        return Err(NoteSyncError::InvalidPayload(format!(
            "目录 hash 不匹配：{path}"
        )));
    }
    Ok(path)
}

/// 原子应用远端文件，返回规范化相对路径。
pub fn apply_remote_file(root: &Path, payload: &NotePayloadV1) -> NoteSyncResult<String> {
    let path = validate_file_payload(payload)?;
    let (target, path) = safe_target(root, &path)?;
    ensure_safe_parent(root, &target)?;
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.file_type().is_symlink() {
            return Err(NoteSyncError::Symlink(target.display().to_string()));
        }
        if metadata.is_dir() {
            return Err(NoteSyncError::InvalidPath(format!(
                "文件目标是目录：{path}"
            )));
        }
    }
    atomic_write(&target, payload.content.as_bytes(), true)?;
    Ok(path)
}

/// 原子应用远端目录，并保留空目录。
pub fn apply_remote_directory(
    root: &Path,
    payload: &NoteDirectoryPayloadV1,
) -> NoteSyncResult<String> {
    let path = validate_directory_payload(payload)?;
    let (target, path) = safe_target(root, &path)?;
    match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(NoteSyncError::Symlink(target.display().to_string()))
        }
        Ok(metadata) if metadata.is_file() => Err(NoteSyncError::InvalidPath(format!(
            "目录目标是文件：{path}"
        ))),
        Ok(_) => Ok(path),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            ensure_safe_parent(root, &target)?;
            fs::create_dir(&target)?;
            Ok(path)
        }
        Err(error) => Err(NoteSyncError::Io(error)),
    }
}

/// 应用文件/目录 tombstone。删除目录前递归检查，遇到任意符号链接即拒绝。
pub fn apply_remote_tombstone(root: &Path, tombstone: &NoteTombstone) -> NoteSyncResult<()> {
    if !tombstone.tombstone {
        return Err(NoteSyncError::InvalidPayload(
            "删除项 tombstone 必须为 true".to_string(),
        ));
    }
    let (target, _) = safe_target(root, &tombstone.path)?;
    let metadata = match fs::symlink_metadata(&target) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(NoteSyncError::Io(error)),
    };
    if metadata.file_type().is_symlink() {
        return Err(NoteSyncError::Symlink(target.display().to_string()));
    }
    match tombstone.entry_type {
        NoteEntryType::File => {
            if !metadata.is_file() {
                return Err(NoteSyncError::InvalidPath(format!(
                    "文件 tombstone 目标不是文件：{}",
                    tombstone.path
                )));
            }
            fs::remove_file(target)?;
        }
        NoteEntryType::Directory => {
            if !metadata.is_dir() {
                return Err(NoteSyncError::InvalidPath(format!(
                    "目录 tombstone 目标不是目录：{}",
                    tombstone.path
                )));
            }
            remove_tree_no_symlinks(&target)?;
        }
    }
    Ok(())
}

fn remove_tree_no_symlinks(path: &Path) -> NoteSyncResult<()> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink() {
        return Err(NoteSyncError::Symlink(path.display().to_string()));
    }
    if metadata.is_dir() {
        for child in fs::read_dir(path)? {
            remove_tree_no_symlinks(&child?.path())?;
        }
        fs::remove_dir(path)?;
    } else if metadata.is_file() {
        fs::remove_file(path)?;
    } else {
        return Err(NoteSyncError::UnsupportedEntry(path.display().to_string()));
    }
    Ok(())
}

/// 远端变更的统一 payload 类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoteRemotePayload {
    File(NotePayloadV1),
    Directory(NoteDirectoryPayloadV1),
}

pub fn apply_remote_payload(root: &Path, payload: &NoteRemotePayload) -> NoteSyncResult<String> {
    match payload {
        NoteRemotePayload::File(payload) => apply_remote_file(root, payload),
        NoteRemotePayload::Directory(payload) => apply_remote_directory(root, payload),
    }
}

/// 生成冲突副本文件名。`device_name`/`timestamp` 只作为单个安全文件名片段，
/// 不允许借此把副本写到 notes root 之外。
pub fn conflict_copy_path(
    root: &Path,
    original_path: &str,
    device_name: &str,
    timestamp: &str,
) -> NoteSyncResult<String> {
    let (original, normalized) = safe_target(root, original_path)?;
    let parent = original
        .parent()
        .ok_or_else(|| NoteSyncError::InvalidPath(normalized.clone()))?;
    let file_name = original
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| NoteSyncError::InvalidPath(normalized.clone()))?;
    let (stem, extension) = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() && !ext.is_empty() => (stem, ext),
        _ => (file_name, "md"),
    };
    let extension = if extension.eq_ignore_ascii_case("md") {
        "md"
    } else {
        extension
    };
    let device = safe_label(device_name, "设备");
    let timestamp = safe_label(timestamp, "时间");
    for suffix in 0..10_000u32 {
        let collision_suffix = if suffix == 0 {
            String::new()
        } else {
            format!("-{suffix}")
        };
        let candidate_name =
            format!("{stem} (冲突-{device}-{timestamp}{collision_suffix}).{extension}");
        let candidate = parent.join(&candidate_name);
        if fs::symlink_metadata(&candidate).is_err() {
            let relative_parent = parent
                .strip_prefix(validated_root(root)?)
                .map_err(|_| NoteSyncError::InvalidPath(normalized.clone()))?;
            let candidate_relative = if relative_parent.as_os_str().is_empty() {
                candidate_name
            } else {
                format!(
                    "{}/{}",
                    relative_parent.to_string_lossy().replace('\\', "/"),
                    candidate_name
                )
            };
            return normalized_sync_path(&candidate_relative);
        }
    }
    Err(NoteSyncError::Collision(normalized))
}

fn safe_label(value: &str, fallback: &str) -> String {
    let value: String = value
        .nfc()
        .map(|character| {
            if character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
            {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim()
        .trim_end_matches(['.', ' '])
        .to_string();
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

/// 把指定的本地版本写成冲突副本，返回副本相对路径。使用 no-replace 原子落盘，
/// 不会因为两次同步同时命名而覆盖先生成的副本。
pub fn write_conflict_copy(
    root: &Path,
    original_path: &str,
    local_content: &str,
    device_name: &str,
    timestamp: &str,
) -> NoteSyncResult<String> {
    let candidate_relative = conflict_copy_path(root, original_path, device_name, timestamp)?;
    let (candidate, _) = safe_target(root, &candidate_relative)?;
    ensure_safe_parent(root, &candidate)?;
    atomic_write(&candidate, local_content.as_bytes(), false)?;
    Ok(candidate_relative)
}

/// 先保留本地文件，再原子应用远端版本。不存在本地文件时不生成空冲突副本。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteFileApplyResult {
    pub path: String,
    pub conflict_copy: Option<String>,
}

pub fn apply_remote_file_with_conflict(
    root: &Path,
    payload: &NotePayloadV1,
    device_name: &str,
    timestamp: &str,
) -> NoteSyncResult<RemoteFileApplyResult> {
    let path = validate_file_payload(payload)?;
    let (target, path) = safe_target(root, &path)?;
    let conflict_copy = match fs::symlink_metadata(&target) {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            return Err(NoteSyncError::Symlink(target.display().to_string()))
        }
        Ok(metadata) if metadata.is_file() => {
            let local = fs::read_to_string(&target)
                .map_err(|_| NoteSyncError::InvalidUtf8(path.clone()))?;
            Some(write_conflict_copy(
                root,
                &path,
                &local,
                device_name,
                timestamp,
            )?)
        }
        Ok(_) => {
            return Err(NoteSyncError::InvalidPath(format!(
                "文件目标不是文件：{path}"
            )))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => None,
        Err(error) => return Err(NoteSyncError::Io(error)),
    };
    ensure_safe_parent(root, &target)?;
    atomic_write(&target, payload.content.as_bytes(), true)?;
    Ok(RemoteFileApplyResult {
        path,
        conflict_copy,
    })
}

/// 兼容调用方更短的命名。
pub fn apply_remote_file_keep_local(
    root: &Path,
    payload: &NotePayloadV1,
    device_name: &str,
    timestamp: &str,
) -> NoteSyncResult<RemoteFileApplyResult> {
    apply_remote_file_with_conflict(root, payload, device_name, timestamp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn key() -> [u8; 32] {
        [17u8; 32]
    }

    fn temp_root(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "aishell-note-sync-{label}-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn cleanup(root: &Path) {
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn external_add_delete_and_move_are_diffed() {
        let root = temp_root("diff");
        fs::write(root.join("old.md"), "old").unwrap();
        let old = scan_notes(&root, &key()).unwrap();
        fs::rename(root.join("old.md"), root.join("new.md")).unwrap();
        fs::write(root.join("added.md"), "added").unwrap();
        let current = scan_notes(&root, &key()).unwrap();
        let plan = diff(&old.index, &current.index);
        assert_eq!(plan.upserts.len(), 2);
        assert_eq!(plan.tombstones.len(), 1);
        assert_eq!(plan.tombstones[0].path, "old.md");
        assert!(plan.upserts.iter().any(|item| item.path == "new.md"));
        assert!(plan.upserts.iter().any(|item| item.path == "added.md"));
        cleanup(&root);
    }

    #[test]
    fn empty_directories_are_indexed() {
        let root = temp_root("empty-dir");
        fs::create_dir(root.join("empty")).unwrap();
        let snapshot = scan_notes(&root, &key()).unwrap();
        assert_eq!(snapshot.directory_payloads.len(), 1);
        assert_eq!(snapshot.directory_payloads[0].path, "empty");
        assert_eq!(snapshot.index[0].entry_type, NoteEntryType::Directory);
        cleanup(&root);
    }

    #[test]
    fn paths_are_nfc_and_escape_is_rejected() {
        let root = temp_root("nfc");
        fs::write(root.join("e\u{301}.md"), "nfc").unwrap();
        let snapshot = scan_notes(&root, &key()).unwrap();
        assert_eq!(snapshot.index[0].path, "é.md");
        assert_eq!(
            note_entity_id(&key(), "e\u{301}.md").unwrap(),
            snapshot.index[0].entity_id
        );
        assert!(normalized_sync_path("../outside.md").is_err());
        assert!(normalized_sync_path("a/../../outside.md").is_err());
        assert!(normalized_sync_path("C:/outside.md").is_err());
        assert!(normalized_sync_path("/outside.md").is_err());
        assert!(normalized_sync_path("a\\outside.md").is_err());
        cleanup(&root);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_is_rejected_on_unix() {
        use std::os::unix::fs::symlink;
        let root = temp_root("symlink");
        let outside = temp_root("symlink-outside");
        fs::write(outside.join("secret.md"), "secret").unwrap();
        symlink(outside.join("secret.md"), root.join("linked.md")).unwrap();
        assert!(matches!(
            scan_notes(&root, &key()),
            Err(NoteSyncError::Symlink(_))
        ));
        cleanup(&root);
        cleanup(&outside);
    }

    #[cfg(windows)]
    #[test]
    fn symlink_is_rejected_on_windows() {
        use std::os::windows::fs::symlink_file;
        let root = temp_root("symlink");
        let outside = temp_root("symlink-outside");
        fs::write(outside.join("secret.md"), "secret").unwrap();
        if symlink_file(outside.join("secret.md"), root.join("linked.md")).is_ok() {
            assert!(matches!(
                scan_notes(&root, &key()),
                Err(NoteSyncError::Symlink(_))
            ));
        }
        cleanup(&root);
        cleanup(&outside);
    }

    #[test]
    fn remote_file_and_directory_apply_atomically_and_validate_hash() {
        let root = temp_root("apply");
        let directory = NoteDirectoryPayloadV1::new("nested/empty").unwrap();
        apply_remote_directory(&root, &directory).unwrap();
        let file = NotePayloadV1::new("nested/note.md", "远端内容").unwrap();
        apply_remote_file(&root, &file).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("nested/note.md")).unwrap(),
            "远端内容"
        );
        let mut bad = file.clone();
        bad.hash = "00".repeat(32);
        assert!(matches!(
            apply_remote_file(&root, &bad),
            Err(NoteSyncError::InvalidPayload(_))
        ));
        let tombstone = NoteTombstone {
            entity_id: "unused".to_string(),
            entry_type: NoteEntryType::Directory,
            path: "nested".to_string(),
            tombstone: true,
        };
        apply_remote_tombstone(&root, &tombstone).unwrap();
        assert!(!root.join("nested").exists());
        cleanup(&root);
    }

    #[test]
    fn conflict_copy_uses_requested_name_and_avoids_collision() {
        let root = temp_root("conflict");
        fs::write(root.join("note.md"), "本地版本").unwrap();
        let remote = NotePayloadV1::new("note.md", "远端版本").unwrap();
        let first = apply_remote_file_with_conflict(&root, &remote, "我的设备", "2026-08-26T12-00")
            .unwrap();
        assert_eq!(
            first.conflict_copy.as_deref(),
            Some("note (冲突-我的设备-2026-08-26T12-00).md")
        );
        assert_eq!(
            fs::read_to_string(root.join(first.conflict_copy.unwrap())).unwrap(),
            "本地版本"
        );
        fs::write(root.join("note.md"), "再次本地").unwrap();
        let second =
            apply_remote_file_with_conflict(&root, &remote, "我的设备", "2026-08-26T12-00")
                .unwrap();
        assert_eq!(
            second.conflict_copy.as_deref(),
            Some("note (冲突-我的设备-2026-08-26T12-00-1).md")
        );
        assert_eq!(
            fs::read_to_string(root.join("note.md")).unwrap(),
            "远端版本"
        );
        cleanup(&root);
    }
}
