//! 文件/目录云备份：扫描 → 流式加密到本地内容寻址密文 → 分片上传 → 加密 manifest → complete。
//!
//! 与真实云端契约对齐：create upload 前必须已知完整密文大小和整体 SHA-256，
//! 因此每个文件先加密落成本地密文缓存（`CloudSyncStore::put_blob` 顺带算摘要），
//! 再创建/恢复分片上传。备份任务记录持久化在 `users/<id>/backup-tasks/`，
//! 取消或退出后可用 backupId 续传，已完成文件按 (路径,大小,mtime) 跳过。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File, OpenOptions};
use std::io::{Cursor, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tokio_util::sync::CancellationToken;
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

use super::api::{ReqwestTransport, SyncApi};
use super::crypto::{
    decrypt_backup_name, decrypt_file_stream, encrypt_backup_name, encrypt_file_stream,
    sha256_hex, FileEncryptionMeta,
};
use super::manager::CloudSyncManager;
use super::protocol::{
    CompleteBackupRequest, CompleteUploadRequest, CreateBackupRequest, CreateUploadRequest,
    Upload, UploadPartRequest,
};

const FILE_PURPOSE: &str = "backup_file";
const MANIFEST_PURPOSE: &str = "backup_manifest";
const MANIFEST_SCHEMA_VERSION: u32 = 1;
const MAX_STABILITY_RETRIES: usize = 3;
const DEFAULT_PAGE_SIZE: i64 = 20;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestFileEntry {
    pub path: String,
    pub size_bytes: u64,
    pub mtime_unix_ms: u64,
    pub plain_sha256: String,
    pub blob_id: String,
    pub ciphertext_sha256: String,
    pub encryption: FileEncryptionMeta,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ManifestDirectoryEntry {
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    pub schema_version: u32,
    pub created_at_unix_ms: u64,
    pub files: Vec<ManifestFileEntry>,
    pub directories: Vec<ManifestDirectoryEntry>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RestoreCollision {
    Skip,
    KeepBoth,
    Overwrite,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientBackup {
    pub id: String,
    pub name: Option<String>,
    pub device_name: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
    pub size_bytes: i64,
    pub file_count: i64,
    pub status: String,
    pub locked: bool,
    pub root_meta: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientBackupPage {
    pub items: Vec<ClientBackup>,
    pub next_cursor: Option<String>,
    pub total: i64,
}

/// 本地可续传/可放弃的中断备份任务（服务端列表不含草稿，只能从本地记录展示）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedBackup {
    pub task_id: String,
    pub backup_id: String,
    pub display_name: String,
    pub source_path: String,
    pub files_done: usize,
    pub files_total: usize,
    pub status: String,
    pub created_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupProgressEvent {
    pub task_id: String,
    pub phase: String,
    pub current_path: String,
    pub files_done: usize,
    pub files_total: usize,
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_second: u64,
    pub cancellable: bool,
    pub error: Option<String>,
}

/// 进行中的上传会话。密文带随机 salt，重加密必然改变摘要，因此续传复用会话的
/// 前提是本地密文缓存（按 ciphertextSha256 寻址）还在且源文件 mtime 未变；
/// 旧版记录只有 uploadId，按摘要求知处理（放弃旧会话重新加密上传）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum InflightUpload {
    Legacy(String),
    Full {
        upload_id: String,
        ciphertext_sha256: String,
        mtime_unix_ms: u64,
        encryption: FileEncryptionMeta,
    },
}

impl InflightUpload {
    fn upload_id(&self) -> &str {
        match self {
            Self::Legacy(id) => id,
            Self::Full { upload_id, .. } => upload_id,
        }
    }

    fn matches(&self, ciphertext_sha256: &str) -> bool {
        matches!(self, Self::Full { ciphertext_sha256: expected, .. } if expected == ciphertext_sha256)
    }
}

/// 持久化的备份任务记录：续传与崩溃恢复的事实源。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTaskRecord {
    pub task_id: String,
    pub user_id: String,
    pub backup_id: String,
    pub source_path: String,
    pub source_type: String,
    pub display_name: String,
    pub files_total: usize,
    pub bytes_total: u64,
    pub directories: Vec<String>,
    pub completed_files: BTreeMap<String, ManifestFileEntry>,
    pub inflight_uploads: BTreeMap<String, InflightUpload>,
    pub warnings: Vec<String>,
    pub created_at_unix_ms: u64,
    pub status: String,
}

pub struct BackupManager {
    sync: Arc<CloudSyncManager>,
    tasks: Mutex<HashMap<String, CancellationToken>>,
}

#[derive(Debug, Clone)]
struct ScannedFile {
    absolute: PathBuf,
    relative: String,
    size: u64,
    mtime_unix_ms: u64,
}

#[derive(Debug, Default)]
struct ScanResult {
    files: Vec<ScannedFile>,
    directories: Vec<String>,
    warnings: Vec<String>,
    total_bytes: u64,
}

impl BackupManager {
    pub fn new(sync: Arc<CloudSyncManager>) -> Arc<Self> {
        Arc::new(Self {
            sync,
            tasks: Mutex::new(HashMap::new()),
        })
    }

    fn emit_progress(&self, event: &BackupProgressEvent) {
        let _ = self.sync.app_handle().emit("cloud-backup:progress", event);
    }

    #[allow(clippy::too_many_arguments)] // 进度事件字段平铺，聚合反而与事件载荷重复
    fn progress(
        &self,
        task_id: &str,
        phase: &str,
        current_path: &str,
        files_done: usize,
        files_total: usize,
        done_bytes: u64,
        total_bytes: u64,
        started: Instant,
        error: Option<String>,
    ) {
        let elapsed = started.elapsed().as_secs_f64();
        let speed = if elapsed > 0.1 { (done_bytes as f64 / elapsed) as u64 } else { 0 };
        self.emit_progress(&BackupProgressEvent {
            task_id: task_id.to_string(),
            phase: phase.to_string(),
            current_path: current_path.to_string(),
            files_done,
            files_total,
            done_bytes,
            total_bytes,
            speed_bytes_per_second: speed,
            cancellable: !matches!(phase, "done" | "error" | "cancelled"),
            error,
        });
    }

    fn start_task(&self, task_id: &str) -> Result<CancellationToken, String> {
        let mut tasks = self.tasks.lock().map_err(|_| "备份任务锁损坏".to_string())?;
        if tasks.values().any(|token| !token.is_cancelled()) {
            return Err("已有云备份任务进行中，请等待完成或先取消".to_string());
        }
        let token = CancellationToken::new();
        tasks.insert(task_id.to_string(), token.clone());
        Ok(token)
    }

    fn finish_task(&self, task_id: &str) {
        if let Ok(mut tasks) = self.tasks.lock() {
            tasks.remove(task_id);
        }
    }

    /// 启动新备份，立即返回 taskId；失败细节通过 progress 事件上报。
    pub fn start(self: &Arc<Self>, source: String) -> Result<String, String> {
        let (_, caps) = self.sync.user_context()?;
        if !caps.file_backup {
            return Err("当前账号未开通文件备份能力".to_string());
        }
        self.sync.vault_key()?;
        let source_path = PathBuf::from(&source);
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|_| format!("备份源不存在或不可读：{source}"))?;
        if metadata.file_type().is_symlink() {
            return Err("不支持直接备份符号链接，请选择真实文件或目录".to_string());
        }
        let task_id = Uuid::new_v4().to_string();
        let token = self.start_task(&task_id)?;
        let manager = Arc::clone(self);
        let task_id_clone = task_id.clone();
        tauri::async_runtime::spawn(async move {
            manager.run_backup(task_id_clone, source_path, None, token).await;
        });
        Ok(task_id)
    }

    /// 按 draft backupId 续传：从本地任务记录恢复进度，已完成文件直接跳过。
    pub fn resume(self: &Arc<Self>, backup_id: &str) -> Result<String, String> {
        let (user_id, _) = self.sync.user_context()?;
        self.sync.vault_key()?;
        let records: Vec<BackupTaskRecord> = self
            .sync
            .local_store()
            .list_backup_tasks(&user_id)
            .map_err(|error| error.to_string())?;
        let record = records
            .into_iter()
            .find(|record| record.backup_id == backup_id && record.status != "completed")
            .ok_or_else(|| "未找到可续传的本地备份任务，请重新发起备份".to_string())?;
        let task_id = record.task_id.clone();
        if self
            .tasks
            .lock()
            .map_err(|_| "备份任务锁损坏".to_string())?
            .contains_key(&task_id)
        {
            return Err("该备份任务正在进行中".to_string());
        }
        let source = PathBuf::from(&record.source_path);
        let token = self.start_task(&task_id)?;
        let manager = Arc::clone(self);
        let task_id_clone = task_id.clone();
        tauri::async_runtime::spawn(async move {
            manager.run_backup(task_id_clone, source, Some(record), token).await;
        });
        Ok(task_id)
    }

    pub fn cancel(&self, task_id: &str) -> Result<(), String> {
        let tasks = self.tasks.lock().map_err(|_| "备份任务锁损坏".to_string())?;
        let token = tasks
            .get(task_id)
            .ok_or_else(|| "备份任务不存在或已结束".to_string())?;
        token.cancel();
        Ok(())
    }

    fn save_record(&self, record: &BackupTaskRecord) -> Result<(), String> {
        self.sync
            .local_store()
            .save_backup_task(&record.user_id, &record.task_id, record)
            .map_err(|error| error.to_string())
    }

    async fn run_backup(
        self: Arc<Self>,
        task_id: String,
        source: PathBuf,
        existing: Option<BackupTaskRecord>,
        token: CancellationToken,
    ) {
        let started = Instant::now();
        let result = self.run_backup_inner(&task_id, &source, existing, &token, started).await;
        self.finish_task(&task_id);
        match result {
            Ok(()) => self.sync.emit_backup_changed(),
            Err(error) if error == TASK_CANCELLED => {
                self.progress(&task_id, "cancelled", "", 0, 0, 0, 0, started, None);
                self.sync.emit_backup_changed();
            }
            Err(error) => {
                self.progress(&task_id, "error", "", 0, 0, 0, 0, started, Some(error));
                self.sync.emit_backup_changed();
            }
        }
    }

    async fn run_backup_inner(
        &self,
        task_id: &str,
        source: &Path,
        existing: Option<BackupTaskRecord>,
        token: &CancellationToken,
        started: Instant,
    ) -> Result<(), String> {
        let (user_id, _) = self.sync.user_context()?;
        let vault = self.sync.vault_key()?;
        let api = self.sync.api()?;
        let device = self.sync.ensure_device(&api, &user_id).await?;
        let device_id = device.device_id.clone().ok_or_else(|| "本机尚未注册云同步设备".to_string())?;

        self.progress(task_id, "scan", "", 0, 0, 0, 0, started, None);
        let scan = scan_source(source)?;
        if token.is_cancelled() {
            return Err(TASK_CANCELLED.to_string());
        }

        let mut record = match existing {
            Some(mut record) => {
                record.status = "running".to_string();
                record
            }
            None => {
                let display_name = source
                    .file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .filter(|name| !name.is_empty())
                    .unwrap_or_else(|| source.display().to_string());
                let (encrypted_name, name_nonce) = encrypt_backup_name(&vault, &display_name)
                    .map_err(|error| error.to_string())?;
                let source_type = if source.is_dir() { "directory" } else { "file" };
                let backup = api
                    .create_backup(&CreateBackupRequest {
                        device_id: device_id.clone(),
                        request_id: Uuid::new_v4().to_string(),
                        source_type: source_type.to_string(),
                        encrypted_display_name: encrypted_name,
                        root_meta: json!({
                            "version": 1,
                            "sourceType": source_type,
                            "fileCount": scan.files.len(),
                            "totalBytes": scan.total_bytes,
                        }),
                        encryption_meta: json!({
                            "algorithm": "xchacha20-poly1305",
                            "nonce": name_nonce,
                        }),
                    })
                    .await
                    .map_err(|error| error.to_string())?;
                let record = BackupTaskRecord {
                    task_id: task_id.to_string(),
                    user_id: user_id.clone(),
                    backup_id: backup.id,
                    source_path: source.display().to_string(),
                    source_type: source_type.to_string(),
                    display_name,
                    files_total: scan.files.len(),
                    bytes_total: scan.total_bytes,
                    directories: scan.directories.clone(),
                    completed_files: BTreeMap::new(),
                    inflight_uploads: BTreeMap::new(),
                    warnings: scan.warnings.clone(),
                    created_at_unix_ms: now_unix_ms(),
                    status: "running".to_string(),
                };
                self.save_record(&record)?;
                record
            }
        };

        let total_files = scan.files.len();
        let total_bytes = scan.total_bytes;
        let mut done_bytes: u64 = record.completed_files.values().map(|entry| entry.size_bytes).sum();
        let mut files_done = record.completed_files.len();

        for file in &scan.files {
            if token.is_cancelled() {
                record.status = "cancelled".to_string();
                self.save_record(&record)?;
                return Err(TASK_CANCELLED.to_string());
            }
            let already = record
                .completed_files
                .get(&file.relative)
                .is_some_and(|entry| entry.size_bytes == file.size && entry.mtime_unix_ms == file.mtime_unix_ms);
            if already {
                continue;
            }
            self.progress(task_id, "encrypt", &file.relative, files_done, total_files, done_bytes, total_bytes, started, None);
            let stable = stable_metadata(&file.absolute, file.size, file.mtime_unix_ms)?;
            // 续传：inflight 会话对应的本地密文缓存还在且源文件未变时复用，跳过重加密；
            // 否则重新加密（随机 salt 会产生新摘要，旧会话由 upload_blob 取消重建）。
            let cached = match record.inflight_uploads.get(&file.relative) {
                Some(InflightUpload::Full { ciphertext_sha256, mtime_unix_ms, encryption, .. })
                    if *mtime_unix_ms == file.mtime_unix_ms =>
                {
                    match self.sync.local_store().blob_path(ciphertext_sha256) {
                        Ok(path) if path.exists() => Some((path, ciphertext_sha256.clone(), encryption.clone())),
                        _ => None,
                    }
                }
                _ => None,
            };
            let (blob_path, blob_sha, blob_size, meta) = match cached {
                Some((path, sha, meta)) => {
                    let size = fs::metadata(&path).map_err(|error| format!("读取密文缓存失败: {error}"))?.len();
                    (path, sha, size, meta)
                }
                None => {
                    let (blob, meta) = self.encrypt_to_blob(&vault, &file.absolute)?;
                    (blob.path, blob.sha256, blob.size, meta)
                }
            };
            let after = fs::metadata(&file.absolute).map_err(|error| format!("读取文件状态失败：{error}"))?;
            if after.len() != stable.0 || mtime_unix_ms(&after) != stable.1 {
                let _ = fs::remove_file(&blob_path);
                return Err(format!("备份过程中文件发生变化，请稍后重试：{}", file.relative));
            }
            self.progress(task_id, "upload", &file.relative, files_done, total_files, done_bytes, total_bytes, started, None);
            let blob_id = self
                .upload_blob(
                    &api,
                    &device_id,
                    &mut record,
                    &file.relative,
                    FILE_PURPOSE,
                    &blob_path,
                    blob_size,
                    &blob_sha,
                    &meta,
                    file.mtime_unix_ms,
                    token,
                )
                .await?;
            record.inflight_uploads.remove(&file.relative);
            record.completed_files.insert(
                file.relative.clone(),
                ManifestFileEntry {
                    path: file.relative.clone(),
                    size_bytes: file.size,
                    mtime_unix_ms: file.mtime_unix_ms,
                    plain_sha256: meta.plain_sha256.clone(),
                    blob_id,
                    ciphertext_sha256: blob_sha.clone(),
                    encryption: meta,
                },
            );
            record.files_total = total_files;
            record.bytes_total = total_bytes;
            self.save_record(&record)?;
            let _ = fs::remove_file(&blob_path);
            done_bytes += file.size;
            files_done += 1;
            self.progress(task_id, "upload", &file.relative, files_done, total_files, done_bytes, total_bytes, started, None);
        }

        if token.is_cancelled() {
            record.status = "cancelled".to_string();
            self.save_record(&record)?;
            return Err(TASK_CANCELLED.to_string());
        }

        self.progress(task_id, "finalize", "", files_done, total_files, done_bytes, total_bytes, started, None);
        let manifest = BackupManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            created_at_unix_ms: now_unix_ms(),
            files: record.completed_files.values().cloned().collect(),
            directories: record
                .directories
                .iter()
                .map(|path| ManifestDirectoryEntry { path: path.clone() })
                .collect(),
            warnings: record.warnings.clone(),
        };
        let manifest_json = serde_json::to_vec(&manifest)
            .map_err(|error| format!("序列化备份清单失败: {error}"))?;
        let mut manifest_cipher = Cursor::new(Vec::new());
        let manifest_meta = encrypt_file_stream(&vault, manifest_json.as_slice(), &mut manifest_cipher)
            .map_err(|error| error.to_string())?;
        let manifest_bytes = manifest_cipher.into_inner();
        let manifest_sha = sha256_hex(&manifest_bytes);
        let manifest_temp = self
            .sync
            .local_store()
            .root()
            .join(format!(".manifest-{task_id}.tmp"));
        fs::write(&manifest_temp, &manifest_bytes)
            .map_err(|error| format!("写入备份清单密文失败: {error}"))?;
        let manifest_blob = self
            .upload_blob(
                &api,
                &device_id,
                &mut record,
                "__manifest__",
                MANIFEST_PURPOSE,
                &manifest_temp,
                manifest_bytes.len() as u64,
                &manifest_sha,
                &manifest_meta,
                0,
                token,
            )
            .await?;
        let _ = fs::remove_file(&manifest_temp);

        // referencedBlobIds 只含文件 blob：服务端校验会把 manifest 自身 prepend 进同一集合，
        // 再带 manifest 会因「blob ID 不得重复」被拒绝。
        let referenced: Vec<String> = record
            .completed_files
            .values()
            .map(|entry| entry.blob_id.clone())
            .collect();
        let plain_bytes: u64 = record.completed_files.values().map(|entry| entry.size_bytes).sum();
        let cipher_bytes: u64 = record
            .completed_files
            .values()
            .map(|entry| {
                entry.encryption.plain_size
                    + super::crypto::FILE_HEADER_BYTES as u64
                    + chunk_count(entry.encryption.plain_size) * 16
            })
            .sum::<u64>()
            + manifest_bytes.len() as u64;
        api.complete_backup(
            &record.backup_id,
            &CompleteBackupRequest {
                manifest_blob_id: manifest_blob,
                referenced_blob_ids: referenced,
                file_count: record.completed_files.len() as i64,
                directory_count: record.directories.len() as i64,
                plain_bytes: plain_bytes as i64,
                ciphertext_bytes: cipher_bytes as i64,
                manifest_ciphertext_sha256: manifest_sha,
            },
        )
        .await
        .map_err(|error| error.to_string())?;
        self.sync
            .local_store()
            .delete_backup_task(&user_id, task_id)
            .map_err(|error| error.to_string())?;
        self.progress(task_id, "done", "", total_files, total_files, total_bytes, total_bytes, started, None);
        Ok(())
    }

    /// 加密源文件到本地内容寻址密文缓存；返回缓存引用和 manifest 元数据。
    fn encrypt_to_blob(
        &self,
        vault: &[u8; 32],
        source: &Path,
    ) -> Result<(super::state::BlobRef, FileEncryptionMeta), String> {
        let temp = self
            .sync
            .local_store()
            .root()
            .join(format!(".enc-{}.tmp", Uuid::new_v4()));
        let result = (|| {
            let input = File::open(source).map_err(|error| format!("打开待备份文件失败: {error}"))?;
            let output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temp)
                .map_err(|error| format!("创建密文缓存失败: {error}"))?;
            let mut buffered = std::io::BufWriter::new(output);
            let meta = encrypt_file_stream(vault, input, &mut buffered).map_err(|error| error.to_string())?;
            use std::io::Write as _;
            buffered.flush().map_err(|error| format!("写入密文缓存失败: {error}"))?;
            let file = buffered.into_inner().map_err(|error| format!("写入密文缓存失败: {error}"))?;
            file.sync_all().map_err(|error| format!("写入密文缓存失败: {error}"))?;
            drop(file);
            let blob = self
                .sync
                .local_store()
                .put_blob(File::open(&temp).map_err(|error| format!("读取密文缓存失败: {error}"))?)
                .map_err(|error| error.to_string())?;
            Ok((blob, meta))
        })();
        let _ = fs::remove_file(&temp);
        result
    }

    /// 上传一个本地密文文件：create upload 前大小/整体 SHA-256 已知；inflight 会话
    /// 仅在密文摘要一致时复用（续传跳过分片），摘要不匹配说明内容已重加密，旧会话
    /// 尽力取消后重建，避免 complete 时整体摘要不匹配。
    #[allow(clippy::too_many_arguments)]
    async fn upload_blob(
        &self,
        api: &SyncApi<ReqwestTransport>,
        device_id: &str,
        record: &mut BackupTaskRecord,
        key: &str,
        purpose: &str,
        path: &Path,
        size: u64,
        sha256: &str,
        meta: &FileEncryptionMeta,
        mtime_unix_ms: u64,
        token: &CancellationToken,
    ) -> Result<String, String> {
        let encryption_meta = serde_json::to_value(meta).unwrap_or(Value::Null);
        let mut upload = match record.inflight_uploads.get(key) {
            Some(inflight) if inflight.matches(sha256) => {
                match api.upload_status(inflight.upload_id()).await {
                    Ok(upload) if upload.status == "uploading" => upload,
                    _ => self.create_upload(api, device_id, record, key, purpose, size, sha256, meta, mtime_unix_ms, encryption_meta.clone()).await?,
                }
            }
            Some(inflight) => {
                let _ = api.cancel_upload(inflight.upload_id()).await;
                self.create_upload(api, device_id, record, key, purpose, size, sha256, meta, mtime_unix_ms, encryption_meta.clone()).await?
            }
            None => self.create_upload(api, device_id, record, key, purpose, size, sha256, meta, mtime_unix_ms, encryption_meta.clone()).await?,
        };
        let part_size = usize::try_from(upload.part_size).map_err(|_| "云端分片大小不合法".to_string())?;
        if part_size == 0 {
            return Err("云端分片大小为 0".to_string());
        }
        let mut existing: BTreeMap<i64, String> = upload
            .uploaded_parts
            .drain(..)
            .map(|part| (part.part_number, part.sha256))
            .collect();
        let mut file = File::open(path).map_err(|error| format!("读取密文缓存失败: {error}"))?;
        let part_total = size.div_ceil(part_size as u64);
        let mut parts = Vec::new();
        let mut buffer = vec![0u8; part_size];
        for index in 0..part_total {
            if token.is_cancelled() {
                self.save_record(record)?;
                return Err(TASK_CANCELLED.to_string());
            }
            let number = index as i64 + 1;
            let offset = index * part_size as u64;
            let want = std::cmp::min(part_size as u64, size - offset) as usize;
            file.seek(SeekFrom::Start(offset))
                .and_then(|_| file.read_exact(&mut buffer[..want]))
                .map_err(|error| format!("读取密文缓存失败: {error}"))?;
            let hash = sha256_hex(&buffer[..want]);
            if existing.get(&number) != Some(&hash) {
                api.put_upload_part(&upload.upload_id, number as u32, &buffer[..want], &hash)
                    .await
                    .map_err(|error| error.to_string())?;
                existing.insert(number, hash.clone());
            }
            parts.push(UploadPartRequest { part_number: number, sha256: hash });
        }
        let completed = api
            .complete_upload(&upload.upload_id, &CompleteUploadRequest { parts })
            .await
            .map_err(|error| error.to_string())?;
        completed.blob_id.ok_or_else(|| "云端完成上传后未返回 blobId".to_string())
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_upload(
        &self,
        api: &SyncApi<ReqwestTransport>,
        device_id: &str,
        record: &mut BackupTaskRecord,
        key: &str,
        purpose: &str,
        size: u64,
        sha256: &str,
        meta: &FileEncryptionMeta,
        mtime_unix_ms: u64,
        encryption_meta: Value,
    ) -> Result<Upload, String> {
        let upload = api
            .create_upload(&CreateUploadRequest {
                device_id: device_id.to_string(),
                request_id: Uuid::new_v4().to_string(),
                purpose: purpose.to_string(),
                ciphertext_size: size as i64,
                ciphertext_sha256: sha256.to_string(),
                encryption_meta,
            })
            .await
            .map_err(|error| error.to_string())?;
        record.inflight_uploads.insert(
            key.to_string(),
            InflightUpload::Full {
                upload_id: upload.upload_id.clone(),
                ciphertext_sha256: sha256.to_string(),
                mtime_unix_ms,
                encryption: meta.clone(),
            },
        );
        self.save_record(record)?;
        Ok(upload)
    }

    /// 分页列出备份；解锁状态下本地解密显示名，锁定时只暴露非敏感字段。
    pub async fn list(&self, cursor: Option<String>, limit: Option<i64>) -> Result<ClientBackupPage, String> {
        let (_, caps) = self.sync.user_context()?;
        if !caps.file_backup {
            return Err("当前账号未开通文件备份能力".to_string());
        }
        let page = cursor
            .as_deref()
            .and_then(|value| value.parse::<i64>().ok())
            .unwrap_or(1)
            .max(1);
        let page_size = limit.unwrap_or(DEFAULT_PAGE_SIZE).clamp(1, 100);
        let api = self.sync.api()?;
        let remote = api
            .backups(page as usize, page_size as usize)
            .await
            .map_err(|error| error.to_string())?;
        let vault = self.sync.vault_key().ok();
        let items = remote
            .items
            .into_iter()
            .map(|backup| {
                let name = vault.as_deref().and_then(|key| {
                    let nonce = backup
                        .encryption_meta
                        .as_ref()
                        .and_then(|meta| meta.get("nonce"))
                        .and_then(Value::as_str)?;
                    decrypt_backup_name(key, &backup.encrypted_display_name, nonce).ok()
                });
                ClientBackup {
                    id: backup.id,
                    locked: name.is_none(),
                    name,
                    device_name: None,
                    created_at: backup.created_at,
                    completed_at: backup.completed_at,
                    size_bytes: backup.ciphertext_bytes,
                    file_count: backup.file_count,
                    status: backup.status,
                    root_meta: backup.root_meta,
                }
            })
            .collect::<Vec<_>>();
        let has_more = page * page_size < remote.total;
        Ok(ClientBackupPage {
            items,
            next_cursor: has_more.then(|| (page + 1).to_string()),
            total: remote.total,
        })
    }

    pub async fn delete(&self, backup_id: &str) -> Result<(), String> {
        let (_, caps) = self.sync.user_context()?;
        if !caps.file_backup {
            return Err("当前账号未开通文件备份能力".to_string());
        }
        self.sync.api()?.delete_backup(backup_id).await.map_err(|error| error.to_string())?;
        self.sync.emit_backup_changed();
        Ok(())
    }

    /// 本地有记录但未完成的备份任务（服务端列表只返回 completed，草稿只能从本地恢复）。
    /// 正在运行的任务不算中断项。
    pub fn interrupted(&self) -> Result<Vec<InterruptedBackup>, String> {
        let (user_id, _) = self.sync.user_context()?;
        let running: std::collections::HashSet<String> = self
            .tasks
            .lock()
            .map_err(|_| "备份任务锁损坏".to_string())?
            .keys()
            .cloned()
            .collect();
        let records: Vec<BackupTaskRecord> = self
            .sync
            .local_store()
            .list_backup_tasks(&user_id)
            .map_err(|error| error.to_string())?;
        Ok(records
            .into_iter()
            .filter(|record| record.status != "completed" && !running.contains(&record.task_id))
            .map(|record| InterruptedBackup {
                files_done: record.completed_files.len(),
                task_id: record.task_id,
                backup_id: record.backup_id,
                display_name: record.display_name,
                source_path: record.source_path,
                files_total: record.files_total,
                status: record.status,
                created_at_unix_ms: record.created_at_unix_ms,
            })
            .collect())
    }

    /// 放弃中断的备份：尽力取消服务端未完成上传与草稿，清理本地密文缓存和任务记录。
    pub async fn abandon(&self, task_id: &str) -> Result<(), String> {
        let (user_id, _) = self.sync.user_context()?;
        if self
            .tasks
            .lock()
            .map_err(|_| "备份任务锁损坏".to_string())?
            .contains_key(task_id)
        {
            return Err("该备份任务正在进行中，请先取消".to_string());
        }
        let record: Option<BackupTaskRecord> = self
            .sync
            .local_store()
            .load_backup_task(&user_id, task_id)
            .map_err(|error| error.to_string())?;
        let Some(record) = record else {
            return Err("未找到该备份任务记录".to_string());
        };
        if let Ok(api) = self.sync.api() {
            for inflight in record.inflight_uploads.values() {
                let _ = api.cancel_upload(inflight.upload_id()).await;
            }
            let _ = api.delete_backup(&record.backup_id).await;
        }
        for inflight in record.inflight_uploads.values() {
            if let InflightUpload::Full { ciphertext_sha256, .. } = inflight {
                if let Ok(path) = self.sync.local_store().blob_path(ciphertext_sha256) {
                    let _ = fs::remove_file(path);
                }
            }
        }
        self.sync
            .local_store()
            .delete_backup_task(&user_id, task_id)
            .map_err(|error| error.to_string())?;
        self.sync.emit_backup_changed();
        Ok(())
    }

    /// 恢复整个备份到目标目录；校验 manifest 密文摘要、逐文件下载、
    /// 密文 SHA-256 校验、AEAD 解密、明文 SHA-256 校验后原子落盘。
    pub async fn restore(
        &self,
        backup_id: &str,
        target_dir: &str,
        collision: RestoreCollision,
    ) -> Result<(), String> {
        let (_, caps) = self.sync.user_context()?;
        if !caps.file_backup {
            return Err("当前账号未开通文件备份能力".to_string());
        }
        let vault = self.sync.vault_key()?;
        let target = PathBuf::from(target_dir);
        let target_meta = fs::symlink_metadata(&target)
            .map_err(|_| "恢复目标目录不存在，请先创建".to_string())?;
        if !target_meta.is_dir() || target_meta.file_type().is_symlink() {
            return Err("恢复目标必须是真实目录，不能是符号链接".to_string());
        }
        let api = self.sync.api()?;
        let backup = api.backup(backup_id).await.map_err(|error| error.to_string())?;
        if backup.status != "completed" {
            return Err("该备份尚未完成，不能恢复".to_string());
        }
        let manifest_blob = backup
            .manifest_blob_id
            .clone()
            .ok_or_else(|| "云端备份缺少 manifest".to_string())?;
        let manifest_cipher = api
            .download_blob(&manifest_blob, None, None)
            .await
            .map_err(|error| error.to_string())?
            .bytes;
        // 注意：服务端的 completionHash 是 complete 请求体的幂等哈希（供服务端识别重试），
        // 不是 manifest 密文摘要，客户端不能拿它做完整性校验。完整性由容器头明文 SHA-256、
        // 逐块 AEAD 和清单内逐文件 SHA-256 共同保证。
        let mut manifest_plain = Vec::new();
        decrypt_file_stream(&vault, Cursor::new(manifest_cipher), &mut manifest_plain)
            .map_err(|_| "备份清单解密失败，请确认使用正确的云同步密码".to_string())?;
        let manifest: BackupManifest = serde_json::from_slice(&manifest_plain)
            .map_err(|error| format!("备份清单格式损坏: {error}"))?;
        if manifest.schema_version != MANIFEST_SCHEMA_VERSION {
            return Err(format!("不支持的备份清单版本：{}", manifest.schema_version));
        }

        let mut directories = manifest.directories.clone();
        directories.sort_by_key(|entry| entry.path.matches('/').count());
        for directory in &directories {
            let path = safe_join(&target, &directory.path)?;
            fs::create_dir_all(&path).map_err(|error| format!("创建恢复目录失败: {error}"))?;
        }
        for entry in &manifest.files {
            let cipher = api
                .download_blob(&entry.blob_id, None, None)
                .await
                .map_err(|error| error.to_string())?
                .bytes;
            if sha256_hex(&cipher) != entry.ciphertext_sha256 {
                return Err(format!("备份文件密文摘要不匹配：{}", entry.path));
            }
            let mut plain = Vec::new();
            let meta = decrypt_file_stream(&vault, Cursor::new(cipher), &mut plain)
                .map_err(|_| format!("备份文件解密失败：{}", entry.path))?;
            if meta.plain_sha256 != entry.plain_sha256 || meta.plain_size != entry.size_bytes {
                return Err(format!("备份文件明文校验失败：{}", entry.path));
            }
            let destination = resolve_collision(&safe_join(&target, &entry.path)?, collision)?;
            let Some(destination) = destination else { continue };
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| format!("创建恢复目录失败: {error}"))?;
            }
            let temp = destination.with_file_name(format!(
                ".{}.aishell-restore-{}.tmp",
                destination.file_name().and_then(|name| name.to_str()).unwrap_or("file"),
                Uuid::new_v4()
            ));
            if let Err(error) = fs::write(&temp, &plain) {
                let _ = fs::remove_file(&temp);
                return Err(format!("写入恢复文件失败: {error}"));
            }
            if destination.exists() {
                fs::remove_file(&destination).map_err(|error| format!("替换既有文件失败: {error}"))?;
            }
            fs::rename(&temp, &destination).map_err(|error| format!("落盘恢复文件失败: {error}"))?;
        }
        Ok(())
    }
}

const TASK_CANCELLED: &str = "__cancelled__";

fn chunk_count(size: u64) -> u64 {
    size.div_ceil(super::crypto::FILE_CHUNK_SIZE as u64)
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_unix_ms(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// 扫描前/后的 (size, mtime) 必须一致，最多重试有限次数。
fn stable_metadata(path: &Path, size: u64, mtime: u64) -> Result<(u64, u64), String> {
    for attempt in 0..=MAX_STABILITY_RETRIES {
        let metadata = fs::metadata(path).map_err(|error| format!("读取文件状态失败: {error}"))?;
        let current = (metadata.len(), mtime_unix_ms(&metadata));
        if current == (size, mtime) {
            return Ok(current);
        }
        if attempt == MAX_STABILITY_RETRIES {
            return Err(format!("备份过程中文件持续变化，无法取得一致快照：{}", path.display()));
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    unreachable!()
}

/// 递归扫描：保留空目录、跳过符号链接并记警告；相对路径统一 `/` + NFC。
fn scan_source(source: &Path) -> Result<ScanResult, String> {
    let metadata = fs::symlink_metadata(source)
        .map_err(|error| format!("读取备份源失败: {error}"))?;
    let mut result = ScanResult::default();
    let root_name = source
        .file_name()
        .map(|name| name.to_string_lossy().nfc().collect::<String>())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| "备份源路径不合法".to_string())?;
    if metadata.is_file() {
        result.total_bytes = metadata.len();
        result.files.push(ScannedFile {
            absolute: source.to_path_buf(),
            relative: root_name,
            size: metadata.len(),
            mtime_unix_ms: mtime_unix_ms(&metadata),
        });
        return Ok(result);
    }
    if !metadata.is_dir() {
        return Err("备份源必须是文件或目录".to_string());
    }
    let mut stack = vec![(source.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let mut children = fs::read_dir(&dir)
            .map_err(|error| format!("读取目录失败 {}: {error}", dir.display()))?
            .flatten()
            .collect::<Vec<_>>();
        children.sort_by_key(|entry| entry.file_name());
        for child in children {
            let path = child.path();
            let name = child.file_name().to_string_lossy().nfc().collect::<String>();
            let relative = if prefix.is_empty() { name.clone() } else { format!("{prefix}/{name}") };
            let meta = fs::symlink_metadata(&path)
                .map_err(|error| format!("读取条目失败 {}: {error}", path.display()))?;
            if meta.file_type().is_symlink() {
                result.warnings.push(format!("已跳过符号链接：{relative}"));
                continue;
            }
            if meta.is_dir() {
                result.directories.push(relative.clone());
                stack.push((path, relative));
            } else if meta.is_file() {
                result.total_bytes += meta.len();
                result.files.push(ScannedFile {
                    absolute: path,
                    relative,
                    size: meta.len(),
                    mtime_unix_ms: mtime_unix_ms(&meta),
                });
            } else {
                result.warnings.push(format!("已跳过不支持的文件类型：{relative}"));
            }
        }
    }
    result.files.sort_by(|left, right| left.relative.cmp(&right.relative));
    result.directories.sort();
    Ok(result)
}

/// 校验 manifest 相对路径并拼到恢复目标内，拒绝绝对路径与 `..` 逃逸。
fn safe_join(target: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.contains('\\')
        || relative.split('/').any(|part| part.is_empty() || part == "." || part == "..")
    {
        return Err(format!("备份清单包含非法路径：{relative}"));
    }
    let joined = target.join(relative);
    if !joined.starts_with(target) {
        return Err(format!("备份清单路径越界：{relative}"));
    }
    Ok(joined)
}

/// 按冲突策略决定落盘路径；Skip 命中时返回 None。
fn resolve_collision(path: &Path, collision: RestoreCollision) -> Result<Option<PathBuf>, String> {
    if !path.exists() && fs::symlink_metadata(path).is_err() {
        return Ok(Some(path.to_path_buf()));
    }
    match collision {
        RestoreCollision::Skip => Ok(None),
        RestoreCollision::Overwrite => Ok(Some(path.to_path_buf())),
        RestoreCollision::KeepBoth => {
            let parent = path.parent().ok_or_else(|| "恢复路径不合法".to_string())?;
            let stem = path.file_stem().and_then(|name| name.to_str()).unwrap_or("file").to_string();
            let extension = path
                .extension()
                .and_then(|name| name.to_str())
                .map(|ext| format!(".{ext}"))
                .unwrap_or_default();
            for index in 1..1000 {
                let candidate = parent.join(format!("{stem} ({index}){extension}"));
                if !candidate.exists() && fs::symlink_metadata(&candidate).is_err() {
                    return Ok(Some(candidate));
                }
            }
            Err("无法为冲突文件生成新名称".to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aishell-backup-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scan_keeps_empty_directories_and_skips_symlinks() {
        let root = temp_dir();
        fs::create_dir_all(root.join("empty/nested")).unwrap();
        fs::create_dir_all(root.join("docs")).unwrap();
        let mut file = File::create(root.join("docs/a.md")).unwrap();
        file.write_all(b"hello").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("docs/a.md"), root.join("link")).unwrap();
        let scan = scan_source(&root).unwrap();
        assert!(scan.directories.contains(&"empty".to_string()));
        assert!(scan.directories.contains(&"empty/nested".to_string()));
        assert_eq!(scan.files.len(), 1);
        assert_eq!(scan.files[0].relative, "docs/a.md");
        #[cfg(unix)]
        assert_eq!(scan.warnings.len(), 1);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scan_single_file_uses_its_name_as_relative_path() {
        let root = temp_dir();
        let file_path = root.join("单文件.txt");
        fs::write(&file_path, b"data").unwrap();
        let scan = scan_source(&file_path).unwrap();
        assert_eq!(scan.files.len(), 1);
        assert_eq!(scan.files[0].relative, "单文件.txt");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn safe_join_rejects_escape_and_backslash() {
        let target = Path::new("C:/restore");
        assert!(safe_join(target, "a/b.txt").is_ok());
        assert!(safe_join(target, "../evil").is_err());
        assert!(safe_join(target, "a/../../evil").is_err());
        assert!(safe_join(target, "/absolute").is_err());
        assert!(safe_join(target, "a\\b").is_err());
        assert!(safe_join(target, "").is_err());
    }

    #[test]
    fn legacy_inflight_record_loads_and_is_treated_as_stale() {
        // 旧版记录的 inflightUploads 值是纯字符串 uploadId（无密文摘要），续传时必须按
        // 「内容未知」处理：取消旧会话重建，而不是复用——否则重加密的新摘要会让 complete 失败。
        let record: BackupTaskRecord = serde_json::from_value(serde_json::json!({
            "taskId": "t1",
            "userId": "u1",
            "backupId": "bkp_1",
            "sourcePath": "E:/x/a.txt",
            "sourceType": "file",
            "displayName": "a.txt",
            "filesTotal": 1,
            "bytesTotal": 10,
            "directories": [],
            "completedFiles": {},
            "inflightUploads": {"a.txt": "upl_legacy"},
            "warnings": [],
            "createdAtUnixMs": 1,
            "status": "running"
        }))
        .unwrap();
        let inflight = &record.inflight_uploads["a.txt"];
        assert_eq!(inflight.upload_id(), "upl_legacy");
        assert!(!inflight.matches("任意摘要"));
    }

    #[test]
    fn collision_modes_skip_keep_both_and_overwrite() {        let root = temp_dir();
        let file = root.join("报告.txt");
        fs::write(&file, b"old").unwrap();
        assert!(resolve_collision(&file, RestoreCollision::Skip).unwrap().is_none());
        let keep = resolve_collision(&file, RestoreCollision::KeepBoth).unwrap().unwrap();
        assert_eq!(keep.file_name().unwrap().to_string_lossy(), "报告 (1).txt");
        fs::write(&keep, b"newer").unwrap();
        let keep2 = resolve_collision(&file, RestoreCollision::KeepBoth).unwrap().unwrap();
        assert_eq!(keep2.file_name().unwrap().to_string_lossy(), "报告 (2).txt");
        assert_eq!(resolve_collision(&file, RestoreCollision::Overwrite).unwrap().unwrap(), file);
        let fresh = root.join("新文件.txt");
        assert_eq!(resolve_collision(&fresh, RestoreCollision::Skip).unwrap().unwrap(), fresh);
        let _ = fs::remove_dir_all(root);
    }
}
