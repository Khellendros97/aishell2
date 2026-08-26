//! 云同步本地运行态、待发送 mutation、续传记录和内容寻址密文缓存。
//!
//! 这些文件独立于 `aishell.json`，且所有用户相关路径都从白名单 ID 生成。

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const CLOUD_SYNC_DIR: &str = "cloud-sync";
const INSTALLATION_FILE: &str = "installation.json";
const MAX_ID_BYTES: usize = 128;
const COPY_BUFFER_BYTES: usize = 1024 * 1024;

#[derive(Debug)]
pub enum StateError {
    Io(io::Error),
    Json(serde_json::Error),
    InvalidId,
    InvalidHash,
    InvalidState,
    AtomicReplace,
}

impl fmt::Display for StateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(error) => write!(f, "云同步本地文件操作失败: {error}"),
            Self::Json(error) => write!(f, "云同步本地状态格式损坏: {error}"),
            Self::InvalidId => f.write_str("云同步标识不合法"),
            Self::InvalidHash => f.write_str("云同步 SHA-256 标识不合法"),
            Self::InvalidState => f.write_str("云同步本地状态不一致"),
            Self::AtomicReplace => f.write_str("云同步本地状态原子替换失败"),
        }
    }
}

impl std::error::Error for StateError {}

impl From<io::Error> for StateError {
    fn from(error: io::Error) -> Self {
        Self::Io(error)
    }
}

impl From<serde_json::Error> for StateError {
    fn from(error: serde_json::Error) -> Self {
        Self::Json(error)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstallationState {
    pub installation_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct EntityState {
    pub version: i64,
    pub tombstone: bool,
    pub ciphertext_sha256: Option<String>,
    /// 最后成功应用/提交时对应的本地明文摘要，用于识别离线修改。
    #[serde(default)]
    pub local_hash: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserSyncState {
    pub user_id: String,
    pub device_id: Option<String>,
    pub last_applied_cursor: i64,
    pub envelope_revision: i64,
    pub entities: BTreeMap<String, EntityState>,
    pub last_error: Option<String>,
    pub updated_at_unix_ms: u64,
}

impl UserSyncState {
    pub fn new(user_id: &str) -> Result<Self, StateError> {
        validate_id(user_id)?;
        Ok(Self {
            user_id: user_id.to_string(),
            device_id: None,
            last_applied_cursor: 0,
            envelope_revision: 0,
            entities: BTreeMap::new(),
            last_error: None,
            updated_at_unix_ms: now_unix_ms(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutboxEntry {
    pub mutation_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub operation: String,
    pub base_version: i64,
    pub payload_schema_version: Option<i64>,
    pub ciphertext: Option<String>,
    pub blob_id: Option<String>,
    pub encryption_meta: Option<Value>,
    pub ciphertext_sha256: Option<String>,
    pub attempts: u32,
    pub created_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadPartResume {
    pub part_number: i64,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UploadResume {
    pub upload_id: String,
    pub request_id: String,
    pub purpose: String,
    pub ciphertext_size: i64,
    pub ciphertext_sha256: String,
    pub encryption_meta: Value,
    pub part_size: i64,
    pub uploaded_parts: BTreeMap<i64, UploadPartResume>,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobRef {
    pub sha256: String,
    pub size: u64,
    pub path: PathBuf,
}

#[derive(Debug, Clone)]
pub struct CloudSyncStore {
    root: PathBuf,
}

impl CloudSyncStore {
    /// `root` 是应用配置目录；本构造函数不会读取或修改 `aishell.json`。
    pub fn new(root: impl AsRef<Path>) -> Self {
        Self {
            root: root.as_ref().join(CLOUD_SYNC_DIR),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn ensure_layout(&self) -> Result<(), StateError> {
        fs::create_dir_all(self.users_dir())?;
        fs::create_dir_all(self.blobs_dir())?;
        Ok(())
    }

    pub fn load_or_create_installation(&self) -> Result<InstallationState, StateError> {
        let path = self.root.join(INSTALLATION_FILE);
        if path.exists() {
            let state: InstallationState = read_json(&path)?;
            validate_uuid_id(&state.installation_id)?;
            return Ok(state);
        }
        self.ensure_layout()?;
        let state = InstallationState {
            installation_id: Uuid::new_v4().to_string(),
        };
        atomic_write_json(&path, &state)?;
        Ok(state)
    }

    pub fn replace_installation(&self, state: &InstallationState) -> Result<(), StateError> {
        validate_uuid_id(&state.installation_id)?;
        self.ensure_layout()?;
        atomic_write_json(&self.root.join(INSTALLATION_FILE), state)
    }

    pub fn load_state(&self, user_id: &str) -> Result<UserSyncState, StateError> {
        validate_id(user_id)?;
        let path = self.user_dir(user_id)?.join("state.json");
        if !path.exists() {
            return UserSyncState::new(user_id);
        }
        let state: UserSyncState = read_json(&path)?;
        if state.user_id != user_id || state.last_applied_cursor < 0 || state.envelope_revision < 0
        {
            return Err(StateError::InvalidState);
        }
        Ok(state)
    }

    pub fn save_state(&self, state: &UserSyncState) -> Result<(), StateError> {
        validate_id(&state.user_id)?;
        if state.last_applied_cursor < 0 || state.envelope_revision < 0 {
            return Err(StateError::InvalidState);
        }
        let path = self.user_dir(&state.user_id)?.join("state.json");
        atomic_write_json(&path, state)
    }

    pub fn save_outbox(&self, user_id: &str, entry: &OutboxEntry) -> Result<(), StateError> {
        validate_id(user_id)?;
        validate_id(&entry.mutation_id)?;
        validate_entity_part(&entry.entity_type)?;
        validate_entity_part(&entry.entity_id)?;
        if entry.base_version < 0 || entry.payload_schema_version.is_some_and(|value| value <= 0) {
            return Err(StateError::InvalidState);
        }
        let path = self
            .user_dir(user_id)?
            .join("outbox")
            .join(format!("{}.json", entry.mutation_id));
        atomic_write_json(&path, entry)
    }

    pub fn load_outbox(
        &self,
        user_id: &str,
        mutation_id: &str,
    ) -> Result<Option<OutboxEntry>, StateError> {
        validate_id(user_id)?;
        validate_id(mutation_id)?;
        let path = self
            .user_dir(user_id)?
            .join("outbox")
            .join(format!("{mutation_id}.json"));
        if !path.exists() {
            return Ok(None);
        }
        let entry: OutboxEntry = read_json(&path)?;
        if entry.mutation_id != mutation_id {
            return Err(StateError::InvalidState);
        }
        Ok(Some(entry))
    }

    pub fn list_outbox(&self, user_id: &str) -> Result<Vec<OutboxEntry>, StateError> {
        validate_id(user_id)?;
        let directory = self.user_dir(user_id)?.join("outbox");
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut entries = Vec::new();
        for item in fs::read_dir(directory)? {
            let path = item?.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let entry: OutboxEntry = read_json(&path)?;
            validate_id(&entry.mutation_id)?;
            entries.push(entry);
        }
        entries.sort_by(|left, right| left.mutation_id.cmp(&right.mutation_id));
        Ok(entries)
    }

    /// 服务端确认后删除对应 outbox；确认前不得调用此方法。
    pub fn acknowledge_outbox(&self, user_id: &str, mutation_id: &str) -> Result<bool, StateError> {
        self.delete_outbox(user_id, mutation_id)
    }

    pub fn delete_outbox(&self, user_id: &str, mutation_id: &str) -> Result<bool, StateError> {
        validate_id(user_id)?;
        validate_id(mutation_id)?;
        let path = self
            .user_dir(user_id)?
            .join("outbox")
            .join(format!("{mutation_id}.json"));
        match fs::remove_file(path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub fn save_upload_resume(
        &self,
        user_id: &str,
        resume: &UploadResume,
    ) -> Result<(), StateError> {
        validate_id(user_id)?;
        validate_id(&resume.upload_id)?;
        validate_id(&resume.request_id)?;
        validate_hash(&resume.ciphertext_sha256)?;
        if resume.ciphertext_size < 0 || resume.part_size <= 0 {
            return Err(StateError::InvalidState);
        }
        for (number, part) in &resume.uploaded_parts {
            if *number <= 0 || part.part_number != *number || part.size_bytes < 0 {
                return Err(StateError::InvalidState);
            }
            validate_hash(&part.sha256)?;
        }
        let path = self
            .user_dir(user_id)?
            .join("uploads")
            .join(format!("{}.json", resume.upload_id));
        atomic_write_json(&path, resume)
    }

    pub fn load_upload_resume(
        &self,
        user_id: &str,
        upload_id: &str,
    ) -> Result<Option<UploadResume>, StateError> {
        validate_id(user_id)?;
        validate_id(upload_id)?;
        let path = self
            .user_dir(user_id)?
            .join("uploads")
            .join(format!("{upload_id}.json"));
        if !path.exists() {
            return Ok(None);
        }
        let resume: UploadResume = read_json(&path)?;
        if resume.upload_id != upload_id {
            return Err(StateError::InvalidState);
        }
        Ok(Some(resume))
    }

    pub fn list_upload_resumes(&self, user_id: &str) -> Result<Vec<UploadResume>, StateError> {
        validate_id(user_id)?;
        let directory = self.user_dir(user_id)?.join("uploads");
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut resumes = Vec::new();
        for item in fs::read_dir(directory)? {
            let path = item?.path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                resumes.push(read_json(&path)?);
            }
        }
        resumes.sort_by(|left: &UploadResume, right: &UploadResume| {
            left.upload_id.cmp(&right.upload_id)
        });
        Ok(resumes)
    }

    pub fn delete_upload_resume(&self, user_id: &str, upload_id: &str) -> Result<bool, StateError> {
        validate_id(user_id)?;
        validate_id(upload_id)?;
        let path = self
            .user_dir(user_id)?
            .join("uploads")
            .join(format!("{upload_id}.json"));
        match fs::remove_file(path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    /// 流式写入内容寻址 blob；内存占用只随固定缓冲区增长。
    pub fn put_blob<R: Read>(&self, mut source: R) -> Result<BlobRef, StateError> {
        self.ensure_layout()?;
        let temporary = self.root.join(format!(".blob-{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            let mut hasher = Sha256::new();
            let mut buffer = vec![0u8; COPY_BUFFER_BYTES];
            let mut size = 0u64;
            loop {
                let read = source.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                file.write_all(&buffer[..read])?;
                hasher.update(&buffer[..read]);
                size = size
                    .checked_add(read as u64)
                    .ok_or(StateError::InvalidState)?;
            }
            file.sync_all()?;
            drop(file);
            let sha256 = hex::encode(hasher.finalize());
            validate_hash(&sha256)?;
            let target = self.blobs_dir().join(&sha256);
            if target.exists() {
                let metadata = fs::metadata(&target)?;
                if metadata.len() != size {
                    return Err(StateError::InvalidState);
                }
                fs::remove_file(&temporary)?;
                return Ok(BlobRef {
                    sha256,
                    size,
                    path: target,
                });
            }
            atomic_replace(&temporary, &target)?;
            Ok(BlobRef {
                sha256,
                size,
                path: target,
            })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        result
    }

    pub fn blob_path(&self, sha256: &str) -> Result<PathBuf, StateError> {
        validate_hash(sha256)?;
        Ok(self.blobs_dir().join(sha256))
    }

    pub fn open_blob(&self, sha256: &str) -> Result<File, StateError> {
        Ok(File::open(self.blob_path(sha256)?)?)
    }

    pub fn save_baseline<T: Serialize>(
        &self,
        user_id: &str,
        entity_type: &str,
        entity_id: &str,
        value: &T,
    ) -> Result<(), StateError> {
        validate_id(user_id)?;
        validate_entity_part(entity_type)?;
        validate_entity_part(entity_id)?;
        let path = self
            .user_dir(user_id)?
            .join("baselines")
            .join(entity_type)
            .join(format!("{entity_id}.json"));
        atomic_write_json(&path, value)
    }

    pub fn load_baseline<T: for<'de> Deserialize<'de>>(
        &self,
        user_id: &str,
        entity_type: &str,
        entity_id: &str,
    ) -> Result<Option<T>, StateError> {
        validate_id(user_id)?;
        validate_entity_part(entity_type)?;
        validate_entity_part(entity_id)?;
        let path = self
            .user_dir(user_id)?
            .join("baselines")
            .join(entity_type)
            .join(format!("{entity_id}.json"));
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(read_json(&path)?))
    }

    /// 备份任务记录（含 draft backupId 与已完成文件清单），取消/退出后可据其续传。
    pub fn save_backup_task<T: Serialize>(
        &self,
        user_id: &str,
        task_id: &str,
        value: &T,
    ) -> Result<(), StateError> {
        validate_id(user_id)?;
        validate_id(task_id)?;
        let path = self
            .user_dir(user_id)?
            .join("backup-tasks")
            .join(format!("{task_id}.json"));
        atomic_write_json(&path, value)
    }

    pub fn load_backup_task<T: for<'de> Deserialize<'de>>(
        &self,
        user_id: &str,
        task_id: &str,
    ) -> Result<Option<T>, StateError> {
        validate_id(user_id)?;
        validate_id(task_id)?;
        let path = self
            .user_dir(user_id)?
            .join("backup-tasks")
            .join(format!("{task_id}.json"));
        if !path.exists() {
            return Ok(None);
        }
        Ok(Some(read_json(&path)?))
    }

    pub fn delete_backup_task(&self, user_id: &str, task_id: &str) -> Result<bool, StateError> {
        validate_id(user_id)?;
        validate_id(task_id)?;
        let path = self
            .user_dir(user_id)?
            .join("backup-tasks")
            .join(format!("{task_id}.json"));
        match fs::remove_file(path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        }
    }

    pub fn list_backup_tasks<T: for<'de> Deserialize<'de>>(
        &self,
        user_id: &str,
    ) -> Result<Vec<T>, StateError> {
        validate_id(user_id)?;
        let directory = self.user_dir(user_id)?.join("backup-tasks");
        if !directory.exists() {
            return Ok(Vec::new());
        }
        let mut tasks = Vec::new();
        for item in fs::read_dir(directory)? {
            let path = item?.path();
            if path.extension().and_then(|value| value.to_str()) == Some("json") {
                tasks.push(read_json(&path)?);
            }
        }
        Ok(tasks)
    }

    fn users_dir(&self) -> PathBuf {
        self.root.join("users")
    }

    fn blobs_dir(&self) -> PathBuf {
        self.root.join("blobs")
    }

    fn user_dir(&self, user_id: &str) -> Result<PathBuf, StateError> {
        validate_id(user_id)?;
        Ok(self.users_dir().join(user_id))
    }
}

fn validate_id(value: &str) -> Result<(), StateError> {
    if value.is_empty()
        || value.len() > MAX_ID_BYTES
        || value == "."
        || value == ".."
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(StateError::InvalidId);
    }
    Ok(())
}

fn validate_uuid_id(value: &str) -> Result<(), StateError> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| StateError::InvalidId)
}

fn validate_entity_part(value: &str) -> Result<(), StateError> {
    validate_id(value)
}

fn validate_hash(value: &str) -> Result<(), StateError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(StateError::InvalidHash);
    }
    Ok(())
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, StateError> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn atomic_write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), StateError> {
    let bytes = serde_json::to_vec_pretty(value)?;
    let parent = path.parent().ok_or(StateError::AtomicReplace)?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".{}.{}.tmp",
        path.file_name()
            .and_then(|name| name.to_str())
            .ok_or(StateError::AtomicReplace)?,
        Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        atomic_replace(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn atomic_replace(temporary: &Path, target: &Path) -> Result<(), StateError> {
    match fs::rename(temporary, target) {
        Ok(()) => Ok(()),
        Err(_error) if target.exists() => {
            let backup = target.with_file_name(format!(
                ".{}.{}.bak",
                target.file_name().and_then(|name| name.to_str()).ok_or(StateError::AtomicReplace)?,
                Uuid::new_v4()
            ));
            fs::rename(target, &backup)?;
            match fs::rename(temporary, target) {
                Ok(()) => {
                    fs::remove_file(backup)?;
                    Ok(())
                }
                Err(replace_error) => {
                    let _ = fs::rename(&backup, target);
                    Err(StateError::Io(replace_error))
                }
            }
        }
        Err(error) => Err(StateError::Io(error)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("aishell-cloud-sync-test-{}", Uuid::new_v4()))
    }

    fn outbox(id: &str) -> OutboxEntry {
        OutboxEntry {
            mutation_id: id.to_string(),
            entity_type: "note".to_string(),
            entity_id: "opaque".to_string(),
            operation: "upsert".to_string(),
            base_version: 0,
            payload_schema_version: Some(1),
            ciphertext: Some("YQ==".to_string()),
            blob_id: None,
            encryption_meta: Some(serde_json::json!({"algorithm":"xchacha20-poly1305"})),
            ciphertext_sha256: Some(
                "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb".to_string(),
            ),
            attempts: 0,
            created_at_unix_ms: 1,
        }
    }

    #[test]
    fn installation_and_user_state_are_persistent_and_isolated() {
        let root = temp_root();
        let store = CloudSyncStore::new(&root);
        let installation = store.load_or_create_installation().unwrap();
        assert_eq!(installation, store.load_or_create_installation().unwrap());
        let state = UserSyncState::new("user-a").unwrap();
        store.save_state(&state).unwrap();
        assert_eq!(store.load_state("user-a").unwrap(), state);
        assert_eq!(store.load_state("user-b").unwrap().user_id, "user-b");
        assert!(!store.root().join("aishell.json").exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn existing_state_and_installation_can_be_replaced_atomically() {
        let root = temp_root();
        let store = CloudSyncStore::new(&root);
        let mut state = UserSyncState::new("user-a").unwrap();
        store.save_state(&state).unwrap();
        state.last_applied_cursor = 42;
        store.save_state(&state).unwrap();
        assert_eq!(store.load_state("user-a").unwrap().last_applied_cursor, 42);

        let installation = InstallationState {
            installation_id: Uuid::new_v4().to_string(),
        };
        store.replace_installation(&installation).unwrap();
        assert_eq!(store.load_or_create_installation().unwrap(), installation);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn outbox_survives_reload_and_acknowledge_deletes_only_confirmed_entry() {
        let root = temp_root();
        let store = CloudSyncStore::new(&root);
        store.save_outbox("user-a", &outbox("mutation-a")).unwrap();
        store.save_outbox("user-a", &outbox("mutation-b")).unwrap();
        assert_eq!(store.list_outbox("user-a").unwrap().len(), 2);
        assert!(store.acknowledge_outbox("user-a", "mutation-a").unwrap());
        assert!(store.load_outbox("user-a", "mutation-a").unwrap().is_none());
        assert!(store.load_outbox("user-a", "mutation-b").unwrap().is_some());
        assert!(!store.acknowledge_outbox("user-a", "mutation-a").unwrap());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn ids_are_whitelisted_and_user_paths_cannot_escape() {
        let root = temp_root();
        let store = CloudSyncStore::new(&root);
        assert!(store.load_state("../other").is_err());
        assert!(store.load_state("user/a").is_err());
        assert!(store.load_outbox("user-a", "../../x").is_err());
        assert!(store.blob_path("../x").is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn blobs_are_content_addressed_and_streamed() {
        let root = temp_root();
        let store = CloudSyncStore::new(&root);
        let bytes = vec![42u8; COPY_BUFFER_BYTES * 2 + 17];
        let first = store.put_blob(Cursor::new(bytes.clone())).unwrap();
        let second = store.put_blob(Cursor::new(bytes.clone())).unwrap();
        assert_eq!(first.sha256, second.sha256);
        assert_eq!(first.size as usize, bytes.len());
        assert_eq!(fs::read(first.path).unwrap(), bytes);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn malformed_blob_hash_is_rejected() {
        let root = temp_root();
        let store = CloudSyncStore::new(&root);
        assert!(store.open_blob("ABC").is_err());
        let _ = fs::remove_dir_all(root);
    }
}
