//! 会话级远程文件暂存（自动备份远程文件的数据层）。
//!
//! 存储布局（config_dir 由 lib.rs 注入）：
//!   <root>/<projectId>/<sessionId>/manifest.json   每会话一个清单（同目录 .tmp+rename 原子写）
//!   <root>/blobs/<sha256>                          内容寻址 blob（只写一次，多会话共享）
//! projectId / sessionId / serverId 只允许 `[A-Za-z0-9_-]+`，不直接拼接为文件名。
//!
//! 语义：
//! - [`RemoteStaging::ensure_snapshot`]：AI 会话第一次修改某远程文件前保存原始快照；
//!   同一会话（projectId+sessionId+serverId+canonical 路径）后续修改复用快照，不覆盖。
//! - 已有文件保留完整字节；首次创建文件只记录 `Absent`；受保护写入的目录目标一律失败
//!   （无法确定目录内文件）；主动暂存（[`RemoteStaging::add_path`]）则支持目录递归暂存全部文件。
//! - [`RemoteStaging::clear_unchanged`]：远端现状与首次快照完全一致的条目直接接受清除
//!   （不触碰远程内容），有变更/检查失败的保留。
//! - [`RemoteStaging::add_path`] 递归暂存目录时经进度回调（lib.rs 注入 emit `staging:progress`）
//!   逐文件发送 walk/stage 两阶段进度，前端右下角弹窗展示。
//! - [`RemoteStaging::accept`] 只删除本地条目，不改远程内容；[`RemoteStaging::restore`]
//!   先比较暂存记录的 current hash/size/mtime，冲突时返回结构化冲突（force 仅前端用户命令传入）。
//! - 快照/diff 输出统一经 [`crate::redact::redact_secrets`] 脱敏；二进制或超过编辑上限
//!   只返回 hash/size/mtime 元数据，不把原文返回前端。
//! - manifest 缺失视为空（从未暂存）；manifest 存在但损坏 → 带路径错误，不静默当作空列表。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::State;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex as AsyncMutex;

use crate::fsops::{BINARY_SCAN_BYTES, MAX_EDIT_BYTES};
use crate::ssh::SshManager;
use crate::store::Store;

/// 刷新当前状态 / 还原冲突校验时对当前文件做 hash 的大小上限（超过只比较 size/mtime，
/// 避免每次命令后全量读超大文件）。
const CURRENT_HASH_CAP: u64 = 64 * 1024 * 1024;
/// 流式拷贝缓冲（与 sftp.rs 一致）。
const COPY_BUF: usize = 64 * 1024;
/// 单次主动暂存目录的文件数上限（防误暂存 node_modules 级大目录打爆 blob 存储）。
const MAX_STAGE_FILES: usize = 2000;

/// 原始/当前存在状态（serde lowercase：existing / absent）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StagedState {
    Existing,
    Absent,
}

/// 暂存条目（serde camelCase，与 src/types.ts StagedFile 对齐）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedFile {
    pub entry_id: String,
    pub server_id: String,
    pub remote_path: String,
    pub original_state: StagedState,
    /// 快照 blob 的 sha256（Absent 时为 None）
    pub blob_ref: Option<String>,
    pub size: Option<u64>,
    pub mtime: Option<i64>,
    pub sha256: Option<String>,
    pub staged_at: i64,
    /// 当前（最近一次刷新时的）状态
    pub current_state: StagedState,
    pub current_size: Option<u64>,
    pub current_mtime: Option<i64>,
    pub current_sha256: Option<String>,
}

/// 文件元数据（二进制/超大文件的展示与冲突校验用）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingMeta {
    pub sha256: Option<String>,
    pub size: Option<u64>,
    pub mtime: Option<i64>,
}

/// 单侧内容读取结果：text 为可编辑文本（已脱敏）；meta 为二进制/超大元数据；absent 表示该侧不存在。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingContent {
    pub text: Option<String>,
    pub meta: Option<StagingMeta>,
    pub absent: bool,
}

/// diff 单侧行（kind：del/add/ctx）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLine {
    pub kind: String,
    pub text: String,
}

/// diff 元数据对比（二进制/超大时）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffMeta {
    pub snapshot: StagingMeta,
    pub current: StagingMeta,
}

/// staging_diff 结果：行级 diff（文本）或元数据对比（二进制/超大）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingDiff {
    /// 左侧（快照侧）行
    pub left: Vec<DiffLine>,
    /// 右侧（当前侧）行
    pub right: Vec<DiffLine>,
    pub meta: Option<DiffMeta>,
    pub snapshot_absent: bool,
    pub current_absent: bool,
}

/// restore 冲突详情（结构化返回，前端据此弹「仍要强制还原？」）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreConflict {
    pub current_size: Option<u64>,
    pub current_mtime: Option<i64>,
    pub current_sha256: Option<String>,
}

/// restore 结果：restored=true 时 entry 为更新后的条目；conflict 非空表示冲突且未还原。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreOutcome {
    pub restored: bool,
    pub conflict: Option<RestoreConflict>,
    pub entry: Option<StagedFile>,
}

/// staging_clear 结果：removed 为「无变更已清除」的条目；kept 为仍有变更/检查失败而保留的条目。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingClearOutcome {
    pub removed: Vec<StagedFile>,
    pub kept: Vec<StagedFile>,
    /// 检查失败的条目说明（对应条目保留在 kept 中）
    pub errors: Vec<String>,
}

/// 递归暂存目录的进度（add_path 经 `staging:progress` 事件逐文件发送，前端右下角进度弹窗消费）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagingProgress {
    pub project_id: String,
    pub session_id: String,
    /// walk = 枚举目录文件；stage = 逐个暂存文件
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub current_path: String,
}

/// 进度事件回调（lib.rs 注入 emit `staging:progress`；测试环境不注入则静默）。
type ProgressEmitter = Arc<dyn Fn(&StagingProgress) + Send + Sync>;

/// 会话级暂存管理器（lib.rs 注入，前端命令与 AI 动作共用同一实例）。
pub struct RemoteStaging {
    root: PathBuf,
    ssh: Arc<SshManager>,
    store: Arc<Store>,
    progress: StdMutex<Option<ProgressEmitter>>,
    /// 唯一键（projectId:sessionId:serverId:path）→ 进程内锁：避免并发首次写入覆盖原始快照
    locks: StdMutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

/// 非法 id 检查：projectId / sessionId / serverId 只允许字母数字与 `-` `_`。
fn validate_id(id: &str, what: &str) -> Result<(), String> {
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return Err(format!("非法{what}：仅允许字母、数字与 - _（实际：{id}）"));
    }
    Ok(())
}

/// 词法规范化绝对路径（折叠 `.` `..` 与重复 `/`；不触碰磁盘）。
/// pub(crate)：ai_actions 的 remote_* 动作族复用同一套路径归一（保证暂存键一致）。
pub(crate) fn canonical_remote_path(path: &str) -> Result<String, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("远程路径不能为空".to_string());
    }
    if !path.starts_with('/') {
        return Err(format!("远程路径必须是绝对路径：{path}"));
    }
    let mut parts: Vec<&str> = Vec::new();
    for comp in path.split('/') {
        match comp {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            c => parts.push(c),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

fn unix_ts() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 判断 SFTP 错误是否为「文件不存在」。
fn is_no_such_file(e: &russh_sftp::client::error::Error) -> bool {
    matches!(e, russh_sftp::client::error::Error::Status(s) if s.status_code == russh_sftp::protocol::StatusCode::NoSuchFile)
}

/// 递归枚举远端目录下全部文件（绝对路径；符号链接不追踪，防逃逸/防死循环）。
/// async 递归需装箱（与 sftp.rs copy_one/delete_one 同模式）。
async fn walk_remote_files(
    sftp: &russh_sftp::client::SftpSession,
    dir: &str,
    out: &mut Vec<String>,
) -> Result<(), String> {
    async fn inner(sftp: &russh_sftp::client::SftpSession, dir: &str, out: &mut Vec<String>) -> Result<(), String> {
        let rd = sftp
            .read_dir(dir)
            .await
            .map_err(|e| format!("读取远端目录 {dir} 失败: {e}"))?;
        for ent in rd {
            let md = ent.metadata();
            if md.is_symlink() {
                continue;
            }
            let path = ent.path();
            if md.is_dir() {
                Box::pin(inner(sftp, &path, out)).await?;
            } else {
                out.push(path);
            }
        }
        Ok(())
    }
    Box::pin(inner(sftp, dir, out)).await
}

/// 远端现状与暂存快照（首次快照）是否完全一致——「没有任何变更」。
/// remote = 远端 (size, mtime, sha256)；sha256 为 ≤ hash cap 时按需计算的结果（超大文件为 None）。
/// 超大文件（快照无 hash 记录）只信 size/mtime，与 restore 冲突校验同一保守策略。
fn snapshot_unchanged(
    entry: &StagedFile,
    remote: Option<(Option<u64>, Option<i64>, Option<String>)>,
) -> bool {
    match (&entry.original_state, remote) {
        (StagedState::Absent, None) => true,
        (StagedState::Existing, Some((size, mtime, sha))) => {
            if entry.size != size || entry.mtime != mtime {
                return false;
            }
            match (&entry.sha256, sha) {
                (Some(rec), Some(cur)) => cur == *rec,
                _ => true,
            }
        }
        _ => false,
    }
}

impl RemoteStaging {
    pub fn new(root: PathBuf, ssh: Arc<SshManager>, store: Arc<Store>) -> Self {
        RemoteStaging {
            root,
            ssh,
            store,
            progress: StdMutex::new(None),
            locks: StdMutex::new(HashMap::new()),
        }
    }

    /// 注入进度事件回调（lib.rs：emit `staging:progress`；测试/无 UI 环境不注入则静默）。
    pub fn set_progress_emitter(&self, f: ProgressEmitter) {
        *self.progress.lock().unwrap_or_else(|p| p.into_inner()) = Some(f);
    }

    fn emit_progress(&self, p: &StagingProgress) {
        if let Some(f) = self.progress.lock().unwrap_or_else(|p| p.into_inner()).as_ref() {
            f(p);
        }
    }

    fn validate_session(&self, project_id: &str, session_id: &str, server_id: &str) -> Result<(), String> {
        validate_id(project_id, "项目 ID")?;
        validate_id(session_id, "会话 ID")?;
        validate_id(server_id, "服务器 ID")?;
        Ok(())
    }

    fn manifest_path(&self, project_id: &str, session_id: &str) -> PathBuf {
        self.root.join(project_id).join(session_id).join("manifest.json")
    }

    fn session_dir(&self, project_id: &str, session_id: &str) -> PathBuf {
        self.root.join(project_id).join(session_id)
    }

    /// 读 manifest：文件缺失 → 空列表（从未暂存）；存在但损坏 → 带路径错误。
    fn read_manifest(&self, project_id: &str, session_id: &str) -> Result<Vec<StagedFile>, String> {
        let path = self.manifest_path(project_id, session_id);
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("读取暂存清单失败（{}）：{e}", path.display())),
        };
        serde_json::from_slice(&bytes)
            .map_err(|e| format!("暂存清单损坏（{}）：{e}", path.display()))
    }

    /// 原子写 manifest：同目录 .tmp + rename（与 store.rs persist_locked 同模式）。
    fn write_manifest(&self, project_id: &str, session_id: &str, entries: &[StagedFile]) -> Result<(), String> {
        let dir = self.session_dir(project_id, session_id);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("创建暂存目录失败（{}）：{e}", dir.display()))?;
        let path = dir.join("manifest.json");
        let tmp = dir.join("manifest.json.tmp");
        let json = serde_json::to_string_pretty(entries)
            .map_err(|e| format!("序列化暂存清单失败: {e}"))?;
        std::fs::write(&tmp, json).map_err(|e| format!("写入暂存清单临时文件失败（{}）：{e}", tmp.display()))?;
        std::fs::rename(&tmp, &path).map_err(|e| format!("原子替换暂存清单失败（{}）：{e}", path.display()))?;
        Ok(())
    }

    fn lock_for(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut map = self.locks.lock().unwrap_or_else(|p| p.into_inner());
        map.entry(key.to_string()).or_insert_with(|| Arc::new(AsyncMutex::new(()))).clone()
    }

    /// 同一会话的 manifest 是单文件读改写事务；所有写操作必须持有此锁，避免并发丢失更新。
    fn manifest_lock(&self, project_id: &str, session_id: &str) -> Arc<AsyncMutex<()>> {
        self.lock_for(&format!("manifest:{project_id}:{session_id}"))
    }

    /// 保存快照：按唯一键查 manifest，已有条目直接返回（同一会话后续修改不覆盖原始快照）；
    /// 无条目时经 SFTP 读远程元数据与完整原始字节写 blob（文件不存在记录 Absent），再原子写 manifest。
    /// 快照失败返回中文错误（调用方应阻止远程修改）。
    pub async fn ensure_snapshot(
        &self,
        project_id: &str,
        session_id: &str,
        server_id: &str,
        remote_path: &str,
    ) -> Result<StagedFile, String> {
        self.validate_session(project_id, session_id, server_id)?;
        let remote_path = canonical_remote_path(remote_path)?;
        let lock_key = format!("{project_id}:{session_id}:{server_id}:{remote_path}");
        let lock = self.lock_for(&lock_key);
        let _guard = lock.lock().await;
        let manifest_lock = self.manifest_lock(project_id, session_id);
        let _manifest_guard = manifest_lock.lock().await;

        let mut entries = self.read_manifest(project_id, session_id)?;
        if let Some(existing) = entries.iter().find(|e| e.server_id == server_id && e.remote_path == remote_path) {
            return Ok(existing.clone());
        }
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        let (blob_ref, size, mtime, sha256) = match sftp.metadata(&remote_path).await {
            Ok(md) if md.is_dir() => {
                return Err(format!("无法确定目录内文件，不执行受保护写入：{remote_path}"));
            }
            Ok(_md) => self.store_remote_file(&sftp, &remote_path).await?,
            Err(e) if is_no_such_file(&e) => (None, None, None, None),
            Err(e) => return Err(format!("读取远端 {remote_path} 快照失败: {e}")),
        };
        let original_state = if blob_ref.is_some() { StagedState::Existing } else { StagedState::Absent };
        let now = unix_ts();
        let entry = StagedFile {
            entry_id: format!("{:x}", Sha256::digest(format!("{lock_key}:{now}").as_bytes()))[..24].to_string(),
            server_id: server_id.to_string(),
            remote_path: remote_path.clone(),
            original_state: original_state.clone(),
            blob_ref,
            size,
            mtime,
            sha256: sha256.clone(),
            staged_at: now,
            current_state: original_state,
            current_size: size,
            current_mtime: mtime,
            current_sha256: sha256,
        };
        entries.push(entry.clone());
        self.write_manifest(project_id, session_id, &entries)?;
        Ok(entry)
    }

    /// 主动暂存文件或目录（用户 SFTP 菜单 / AI staging_add 工具）。
    /// 文件 → ensure_snapshot；目录 → 递归枚举全部文件逐个暂存（跳过符号链接防逃逸/防环），
    /// 文件数超过 [`MAX_STAGE_FILES`] 时中止。与 ensure_snapshot 同去重语义：已暂存条目原样返回。
    pub async fn add_path(
        &self,
        project_id: &str,
        session_id: &str,
        server_id: &str,
        remote_path: &str,
    ) -> Result<Vec<StagedFile>, String> {
        self.validate_session(project_id, session_id, server_id)?;
        let remote_path = canonical_remote_path(remote_path)?;
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        let md = match sftp.metadata(&remote_path).await {
            Ok(md) => md,
            Err(e) if is_no_such_file(&e) => return Err(format!("远端路径不存在：{remote_path}")),
            Err(e) => return Err(format!("读取远端 {remote_path} 状态失败: {e}")),
        };
        if !md.is_dir() {
            let e = self.ensure_snapshot(project_id, session_id, server_id, &remote_path).await?;
            return Ok(vec![e]);
        }
        let mut files: Vec<String> = Vec::new();
        self.emit_progress(&StagingProgress {
            project_id: project_id.to_string(),
            session_id: session_id.to_string(),
            phase: "walk".into(),
            done: 0,
            total: 0,
            current_path: remote_path.clone(),
        });
        walk_remote_files(&sftp, &remote_path, &mut files).await?;
        if files.is_empty() {
            return Err(format!("远端目录为空，没有可暂存的文件：{remote_path}"));
        }
        if files.len() > MAX_STAGE_FILES {
            return Err(format!(
                "远端目录包含 {} 个文件，超过单次暂存上限 {}，已中止（请只暂存需要的子目录）",
                files.len(),
                MAX_STAGE_FILES
            ));
        }
        let total = files.len();
        let mut out = Vec::with_capacity(total);
        for (i, f) in files.iter().enumerate() {
            // 逐文件进度（done 为已完成的文件数，当前文件尚未开始）
            self.emit_progress(&StagingProgress {
                project_id: project_id.to_string(),
                session_id: session_id.to_string(),
                phase: "stage".into(),
                done: i,
                total,
                current_path: f.clone(),
            });
            match self.ensure_snapshot(project_id, session_id, server_id, f).await {
                Ok(e) => out.push(e),
                Err(e) => {
                    return Err(format!("暂存 {f} 失败（已暂存 {} 个文件）：{e}", out.len()));
                }
            }
        }
        self.emit_progress(&StagingProgress {
            project_id: project_id.to_string(),
            session_id: session_id.to_string(),
            phase: "done".into(),
            done: total,
            total,
            current_path: String::new(),
        });
        Ok(out)
    }

    /// 清理无变更条目：远端现状与首次快照完全一致的条目直接接受（清除本地暂存记录），
    /// 有变更或检查失败（连接/读取出错）的条目保留。单次持有 manifest 锁，逐条 re-stat +
    /// 条件 hash（≤ CURRENT_HASH_CAP 时比对内容，超大文件只信 size/mtime，与 refresh_current 一致）。
    pub async fn clear_unchanged(
        &self,
        project_id: &str,
        session_id: &str,
    ) -> Result<StagingClearOutcome, String> {
        validate_id(project_id, "项目 ID")?;
        validate_id(session_id, "会话 ID")?;
        let manifest_lock = self.manifest_lock(project_id, session_id);
        let _manifest_guard = manifest_lock.lock().await;
        let entries = self.read_manifest(project_id, session_id)?;
        if entries.is_empty() {
            return Ok(StagingClearOutcome { removed: Vec::new(), kept: Vec::new(), errors: Vec::new() });
        }
        let mut removed: Vec<StagedFile> = Vec::new();
        let mut kept: Vec<StagedFile> = Vec::new();
        let mut errors: Vec<String> = Vec::new();
        let total = entries.len();
        for (i, entry) in entries.into_iter().enumerate() {
            // 逐条检查进度（done 为已完成的条目数，当前条目尚未开始）
            self.emit_progress(&StagingProgress {
                project_id: project_id.to_string(),
                session_id: session_id.to_string(),
                phase: "clear".into(),
                done: i,
                total,
                current_path: entry.remote_path.clone(),
            });
            let sftp = match self.ssh.open_sftp(&entry.server_id).await {
                Ok(s) => s,
                Err(e) => {
                    errors.push(format!("服务器 {}：{e}", entry.server_id));
                    kept.push(entry);
                    continue;
                }
            };
            // 远端现状 (size, mtime, sha256)：sha256 仅 ≤ cap 时按需计算
            let remote = match sftp.metadata(&entry.remote_path).await {
                Ok(md) if md.is_dir() => {
                    // 暂存条目只会是文件；防御性保留，不判定
                    kept.push(entry);
                    continue;
                }
                Ok(md) => {
                    let size = md.size;
                    let mtime = md.mtime.map(|m| m as i64);
                    let sha = match size {
                        Some(s) if s <= CURRENT_HASH_CAP => {
                            match self.read_remote_bytes(&sftp, &entry.remote_path).await {
                                Ok(b) => Some(hex::encode(Sha256::digest(&b))),
                                Err(e) => {
                                    errors.push(format!("{}：{e}", entry.remote_path));
                                    kept.push(entry);
                                    continue;
                                }
                            }
                        }
                        _ => None,
                    };
                    Some((size, mtime, sha))
                }
                Err(e) if is_no_such_file(&e) => None,
                Err(e) => {
                    errors.push(format!("{}：{e}", entry.remote_path));
                    kept.push(entry);
                    continue;
                }
            };
            if snapshot_unchanged(&entry, remote) {
                removed.push(entry);
            } else {
                kept.push(entry);
            }
        }
        self.write_manifest(project_id, session_id, &kept)?;
        self.emit_progress(&StagingProgress {
            project_id: project_id.to_string(),
            session_id: session_id.to_string(),
            phase: "done".into(),
            done: removed.len() + kept.len(),
            total: removed.len() + kept.len(),
            current_path: String::new(),
        });
        Ok(StagingClearOutcome { removed, kept, errors })
    }

    /// 列出某会话全部暂存条目（按暂存时间排序）。manifest 损坏 → 带路径错误。
    pub async fn list(&self, project_id: &str, session_id: &str) -> Result<Vec<StagedFile>, String> {
        validate_id(project_id, "项目 ID")?;
        validate_id(session_id, "会话 ID")?;
        if !self.session_dir(project_id, session_id).is_dir() {
            return Ok(Vec::new());
        }
        let mut entries = self.read_manifest(project_id, session_id)?;
        entries.sort_by_key(|e| e.staged_at);
        Ok(entries)
    }

    fn find_entry(&self, entries: &[StagedFile], entry_id: &str) -> Result<StagedFile, String> {
        entries
            .iter()
            .find(|e| e.entry_id == entry_id)
            .cloned()
            .ok_or_else(|| format!("暂存条目不存在：{entry_id}"))
    }

    /// 读取快照侧内容：Absent → absent；Existing → blob 文本（脱敏）或二进制元数据。
    pub async fn read_snapshot(
        &self,
        project_id: &str,
        session_id: &str,
        entry_id: &str,
    ) -> Result<StagingContent, String> {
        validate_id(project_id, "项目 ID")?;
        validate_id(session_id, "会话 ID")?;
        let entries = self.read_manifest(project_id, session_id)?;
        let entry = self.find_entry(&entries, entry_id)?;
        if entry.original_state == StagedState::Absent {
            return Ok(StagingContent { text: None, meta: None, absent: true });
        }
        let blob_ref = entry.blob_ref.as_ref().ok_or_else(|| format!("暂存条目缺少 blob 引用：{entry_id}"))?;
        let blob_path = self.root.join("blobs").join(blob_ref);
        let bytes = std::fs::read(&blob_path)
            .map_err(|e| format!("读取快照 blob 失败（{}）：{e}", blob_path.display()))?;
        Ok(content_from_bytes(&bytes, entry.size, entry.mtime, entry.sha256.clone(), &self.store.known_secrets()))
    }

    /// 读取当前侧内容：实时从远端读取（当前状态以远端为事实源）。
    pub async fn read_current(
        &self,
        project_id: &str,
        session_id: &str,
        entry_id: &str,
    ) -> Result<StagingContent, String> {
        validate_id(project_id, "项目 ID")?;
        validate_id(session_id, "会话 ID")?;
        let entries = self.read_manifest(project_id, session_id)?;
        let entry = self.find_entry(&entries, entry_id)?;
        let sftp = self
            .ssh
            .open_sftp(&entry.server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        match sftp.metadata(&entry.remote_path).await {
            Ok(md) if md.is_dir() => Ok(StagingContent {
                text: None,
                meta: Some(StagingMeta {
                    sha256: None,
                    size: md.size,
                    mtime: md.mtime.map(|m| m as i64),
                }),
                absent: false,
            }),
            Ok(_md) => {
                let bytes = self.read_remote_bytes(&sftp, &entry.remote_path).await?;
                let sha256 = Some(hex::encode(Sha256::digest(&bytes)));
                let size = bytes.len() as u64;
                let mtime = sftp
                    .metadata(&entry.remote_path)
                    .await
                    .ok()
                    .and_then(|md| md.mtime.map(|m| m as i64));
                Ok(content_from_bytes(&bytes, Some(size), mtime, sha256, &self.store.known_secrets()))
            }
            Err(e) if is_no_such_file(&e) => {
                Ok(StagingContent { text: None, meta: None, absent: true })
            }
            Err(e) => Err(format!("读取远端 {} 当前内容失败: {e}", entry.remote_path)),
        }
    }

    /// 接受暂存：只删除本地条目（不改远程内容），返回被移除条目。
    pub async fn accept(
        &self,
        project_id: &str,
        session_id: &str,
        entry_id: &str,
    ) -> Result<StagedFile, String> {
        validate_id(project_id, "项目 ID")?;
        validate_id(session_id, "会话 ID")?;
        let manifest_lock = self.manifest_lock(project_id, session_id);
        let _manifest_guard = manifest_lock.lock().await;
        let mut entries = self.read_manifest(project_id, session_id)?;
        let idx = entries
            .iter()
            .position(|e| e.entry_id == entry_id)
            .ok_or_else(|| format!("暂存条目不存在：{entry_id}"))?;
        let removed = entries.remove(idx);
        self.write_manifest(project_id, session_id, &entries)?;
        Ok(removed)
    }

    /// 还原：先比较暂存记录的 current hash/size/mtime 与远端现状，冲突时返回结构化冲突
    /// （force=true 仍执行——仅由用户前端命令传入，AI 工具永远传 false）。
    /// Absent 原始状态 → 删除当前远程文件；Existing → 以 blob 原始字节写回并更新条目 current。
    pub async fn restore(
        &self,
        project_id: &str,
        session_id: &str,
        entry_id: &str,
        force: bool,
    ) -> Result<RestoreOutcome, String> {
        validate_id(project_id, "项目 ID")?;
        validate_id(session_id, "会话 ID")?;
        let manifest_lock = self.manifest_lock(project_id, session_id);
        let _manifest_guard = manifest_lock.lock().await;
        let mut entries = self.read_manifest(project_id, session_id)?;
        let entry = self.find_entry(&entries, entry_id)?;
        let sftp = self
            .ssh
            .open_sftp(&entry.server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;

        // 冲突校验：当前远端属性 vs 暂存记录的 current
        let current_remote = match sftp.metadata(&entry.remote_path).await {
            Ok(md) if md.is_dir() => {
                return Err(format!("远端 {} 当前是目录，无法还原文件", entry.remote_path));
            }
            Ok(md) => Some((md.size, md.mtime.map(|m| m as i64))),
            Err(e) if is_no_such_file(&e) => None,
            Err(e) => return Err(format!("读取远端 {} 状态失败: {e}", entry.remote_path)),
        };
        let conflict = restore_conflict(&entry, current_remote, &sftp, &entry.remote_path).await?;
        if let Some(c) = conflict {
            if !force {
                return Ok(RestoreOutcome { restored: false, conflict: Some(c), entry: None });
            }
        }

        // 执行还原
        match entry.original_state {
            StagedState::Absent => {
                // 快照时文件不存在 → 还原 = 删除当前远程文件
                match sftp.metadata(&entry.remote_path).await {
                    Ok(md) if !md.is_dir() => {
                        sftp.remove_file(&entry.remote_path)
                            .await
                            .map_err(|e| format!("还原（删除）远端 {} 失败: {e}", entry.remote_path))?;
                    }
                    Ok(_) => {
                        return Err(format!("远端 {} 当前是目录，无法还原删除", entry.remote_path));
                    }
                    Err(e) if is_no_such_file(&e) => {}
                    Err(e) => return Err(format!("读取远端 {} 状态失败: {e}", entry.remote_path)),
                }
            }
            StagedState::Existing => {
                let blob_ref = entry
                    .blob_ref
                    .as_ref()
                    .ok_or_else(|| format!("暂存条目缺少 blob 引用：{entry_id}"))?;
                let blob_path = self.root.join("blobs").join(blob_ref);
                let bytes = std::fs::read(&blob_path)
                    .map_err(|e| format!("读取快照 blob 失败（{}）：{e}", blob_path.display()))?;
                self.write_remote_bytes(&sftp, &entry.remote_path, &bytes).await?;
            }
        }
        // 还原后条目 current = 原始状态
        let mut restored = entry.clone();
        restored.current_state = restored.original_state.clone();
        restored.current_size = restored.size;
        restored.current_mtime = restored.mtime;
        restored.current_sha256 = restored.sha256.clone();
        if let Some(e) = entries.iter_mut().find(|e| e.entry_id == entry_id) {
            *e = restored.clone();
        }
        self.write_manifest(project_id, session_id, &entries)?;
        Ok(RestoreOutcome { restored: true, conflict: None, entry: Some(restored) })
    }

    /// 行级 diff（文本）或元数据对比（二进制/超大）。diff 行已脱敏。
    pub async fn diff(
        &self,
        project_id: &str,
        session_id: &str,
        entry_id: &str,
    ) -> Result<StagingDiff, String> {
        validate_id(project_id, "项目 ID")?;
        validate_id(session_id, "会话 ID")?;
        let entries = self.read_manifest(project_id, session_id)?;
        let entry = self.find_entry(&entries, entry_id)?;
        let snapshot = self.read_snapshot(project_id, session_id, entry_id).await?;
        let current = self.read_current(project_id, session_id, entry_id).await?;
        let snapshot_absent = snapshot.absent;
        let current_absent = current.absent;

        // 两侧都可用文本（快照侧 Absent 视为空文本）→ 行级 diff；否则元数据对比
        let snapshot_text = if snapshot.absent { Some(String::new()) } else { snapshot.text.clone() };
        match (snapshot_text, current.text.clone()) {
            (Some(s), Some(c)) => {
                let a: Vec<String> = s.lines().map(str::to_string).collect();
                let b: Vec<String> = c.lines().map(str::to_string).collect();
                match diff_lines(&a, &b) {
                    Some((left, right)) => {
                        let known = self.store.known_secrets();
                        let redact = |v: &mut Vec<DiffLine>| {
                            for l in v.iter_mut() {
                                let (masked, _) = crate::redact::redact_secrets(&l.text, &known);
                                l.text = masked;
                            }
                        };
                        let (mut left, mut right) = (left, right);
                        redact(&mut left);
                        redact(&mut right);
                        Ok(StagingDiff {
                            left,
                            right,
                            meta: None,
                            snapshot_absent,
                            current_absent,
                        })
                    }
                    None => Ok(StagingDiff {
                        left: Vec::new(),
                        right: Vec::new(),
                        meta: Some(DiffMeta {
                            snapshot: StagingMeta {
                                sha256: entry.sha256.clone(),
                                size: entry.size,
                                mtime: entry.mtime,
                            },
                            current: StagingMeta {
                                sha256: current.meta.as_ref().and_then(|m| m.sha256.clone()),
                                size: current.meta.as_ref().and_then(|m| m.size),
                                mtime: current.meta.as_ref().and_then(|m| m.mtime),
                            },
                        }),
                        snapshot_absent,
                        current_absent,
                    }),
                }
            }
            _ => {
                // 快照侧 meta 从条目取（快照不常驻内存，meta 只含 hash/size/mtime，无原文）
                let snapshot_meta = StagingMeta {
                    sha256: entry.sha256.clone(),
                    size: entry.size,
                    mtime: entry.mtime,
                };
                let current_meta = current.meta.unwrap_or(StagingMeta { sha256: None, size: None, mtime: None });
                Ok(StagingDiff {
                    left: Vec::new(),
                    right: Vec::new(),
                    meta: Some(DiffMeta { snapshot: snapshot_meta, current: current_meta }),
                    snapshot_absent,
                    current_absent,
                })
            }
        }
    }

    /// 执行后刷新条目 current 状态（re-stat + 有条件 hash）。
    pub async fn refresh_current(
        &self,
        project_id: &str,
        session_id: &str,
        server_id: &str,
        remote_path: &str,
    ) -> Result<StagedFile, String> {
        self.validate_session(project_id, session_id, server_id)?;
        let remote_path = canonical_remote_path(remote_path)?;
        let manifest_lock = self.manifest_lock(project_id, session_id);
        let _manifest_guard = manifest_lock.lock().await;
        let mut entries = self.read_manifest(project_id, session_id)?;
        let Some(entry) = entries.iter_mut().find(|e| e.server_id == server_id && e.remote_path == remote_path) else {
            return Ok(StagedFile {
                entry_id: String::new(),
                server_id: server_id.to_string(),
                remote_path: remote_path.clone(),
                original_state: StagedState::Absent,
                blob_ref: None,
                size: None,
                mtime: None,
                sha256: None,
                staged_at: 0,
                current_state: StagedState::Absent,
                current_size: None,
                current_mtime: None,
                current_sha256: None,
            });
        };
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        let (state, size, mtime, sha256) = match sftp.metadata(&remote_path).await {
            Ok(md) if md.is_dir() => {
                return Err(format!("远端 {remote_path} 当前是目录，无法刷新暂存状态"));
            }
            Ok(md) => {
                let size = md.size;
                let mtime = md.mtime.map(|m| m as i64);
                let sha256 = match size {
                    Some(s) if s <= CURRENT_HASH_CAP => {
                        let bytes = self.read_remote_bytes(&sftp, &remote_path).await?;
                        Some(hex::encode(Sha256::digest(&bytes)))
                    }
                    _ => None,
                };
                (StagedState::Existing, size, mtime, sha256)
            }
            Err(e) if is_no_such_file(&e) => (StagedState::Absent, None, None, None),
            Err(e) => return Err(format!("读取远端 {remote_path} 状态失败: {e}")),
        };
        entry.current_state = state;
        entry.current_size = size;
        entry.current_mtime = mtime;
        entry.current_sha256 = sha256;
        let out = entry.clone();
        self.write_manifest(project_id, session_id, &entries)?;
        Ok(out)
    }

    /// 是否已开启自动备份（AI 远程动作前判断）。
    pub fn auto_backup_enabled(&self) -> bool {
        self.store.settings().auto_backup_remote_files
    }

    /* ---------- 内部：SFTP 原始字节读写（复用 sftp.rs 流式范式，不复用仅限文本的 sftp_read） ---------- */

    /// 远端文件 → (blob_ref, size, mtime, sha256)：流式写 blob（内容寻址、只写一次）。
    async fn store_remote_file(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        remote_path: &str,
    ) -> Result<(Option<String>, Option<u64>, Option<i64>, Option<String>), String> {
        let md = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| format!("读取远端 {remote_path} 属性失败: {e}"))?;
        let size = md.size;
        let mtime = md.mtime.map(|m| m as i64);
        let mut src = sftp
            .open(remote_path)
            .await
            .map_err(|e| format!("打开远端 {remote_path} 失败: {e}"))?;
        let blob_dir = self.root.join("blobs");
        std::fs::create_dir_all(&blob_dir)
            .map_err(|e| format!("创建 blob 目录失败（{}）：{e}", blob_dir.display()))?;
        let tmp = blob_dir.join(format!(".tmp-{}-{}", std::process::id(), unix_ts()));
        let mut dst = tokio::fs::File::create(&tmp)
            .await
            .map_err(|e| format!("创建临时 blob 失败（{}）：{e}", tmp.display()))?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; COPY_BUF];
        loop {
            let n = src
                .read(&mut buf)
                .await
                .map_err(|e| format!("读取远端 {remote_path} 失败: {e}"))?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            dst.write_all(&buf[..n])
                .await
                .map_err(|e| format!("写入临时 blob 失败: {e}"))?;
        }
        dst.flush().await.map_err(|e| format!("写入临时 blob 失败: {e}"))?;
        let sha = hex::encode(hasher.finalize());
        let final_path = blob_dir.join(&sha);
        if final_path.exists() {
            let _ = tokio::fs::remove_file(&tmp).await;
        } else {
            tokio::fs::rename(&tmp, &final_path)
                .await
                .map_err(|e| format!("保存快照 blob 失败（{}）：{e}", final_path.display()))?;
        }
        Ok((Some(sha.clone()), size, mtime, Some(sha)))
    }

    /// 读取远端文件完整字节（内存；仅用于当前内容展示/刷新 hash，文件应 ≤ 编辑上限或 hash cap）。
    async fn read_remote_bytes(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        remote_path: &str,
    ) -> Result<Vec<u8>, String> {
        let md = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| format!("读取远端 {remote_path} 属性失败: {e}"))?;
        if md.size.unwrap_or(0) > CURRENT_HASH_CAP {
            return Err(format!("远端 {remote_path} 超过 {} 字节，无法整读", CURRENT_HASH_CAP));
        }
        let mut f = sftp
            .open(remote_path)
            .await
            .map_err(|e| format!("打开远端 {remote_path} 失败: {e}"))?;
        let mut bytes: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; COPY_BUF];
        loop {
            let n = f
                .read(&mut buf)
                .await
                .map_err(|e| format!("读取远端 {remote_path} 失败: {e}"))?;
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        Ok(bytes)
    }

    /// 写远端文件（restore 回写 blob 原始字节）。
    async fn write_remote_bytes(
        &self,
        sftp: &russh_sftp::client::SftpSession,
        remote_path: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        let mut dst = sftp
            .create(remote_path)
            .await
            .map_err(|e| format!("创建远端文件 {remote_path} 失败: {e}"))?;
        dst.write_all(bytes)
            .await
            .map_err(|e| format!("写回远端 {remote_path} 失败: {e}"))?;
        dst.shutdown()
            .await
            .map_err(|e| format!("关闭远端文件 {remote_path} 失败: {e}"))
    }
}

/// 字节 → 内容结果：≤ 编辑上限且非二进制且 UTF-8 → 文本（脱敏）；否则元数据。
fn content_from_bytes(
    bytes: &[u8],
    size: Option<u64>,
    mtime: Option<i64>,
    sha256: Option<String>,
    known_secrets: &[String],
) -> StagingContent {
    let text = if (bytes.len() as u64) <= MAX_EDIT_BYTES
        && !bytes[..bytes.len().min(BINARY_SCAN_BYTES)].contains(&0)
    {
        String::from_utf8(bytes.to_vec()).ok().map(|s| {
            let (masked, _) = crate::redact::redact_secrets(&s, known_secrets);
            masked
        })
    } else {
        None
    };
    match text {
        Some(t) => StagingContent { text: Some(t), meta: None, absent: false },
        None => StagingContent {
            text: None,
            meta: Some(StagingMeta { sha256, size, mtime }),
            absent: false,
        },
    }
}

/// 还原冲突校验：暂存记录的 current hash/size/mtime vs 远端现状。
/// 远端不存在且暂存 current=Absent → 无冲突；远端存在且暂存 current=Existing 且属性一致 → 无冲突。
async fn restore_conflict(
    entry: &StagedFile,
    current_remote: Option<(Option<u64>, Option<i64>)>,
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
) -> Result<Option<RestoreConflict>, String> {
    match (entry.current_state.clone(), current_remote) {
        (StagedState::Absent, None) => Ok(None),
        (StagedState::Absent, Some(_)) => Ok(Some(RestoreConflict {
            current_size: None,
            current_mtime: None,
            current_sha256: None,
        })),
        (StagedState::Existing, None) => Ok(Some(RestoreConflict {
            current_size: None,
            current_mtime: None,
            current_sha256: None,
        })),
        (StagedState::Existing, Some((size, mtime))) => {
            let size_ok = entry.current_size == size;
            let mtime_ok = entry.current_mtime == mtime;
            let mut sha_ok = true;
            if size_ok && mtime_ok {
                // size/mtime 一致时再比 hash（捕捉同尺寸改写）；超出 hash cap 只信 size/mtime
                if let Some(rec) = &entry.current_sha256 {
                    if let Some(s) = size {
                        if s <= CURRENT_HASH_CAP {
                            let mut f = sftp
                                .open(remote_path)
                                .await
                                .map_err(|e| format!("打开远端 {remote_path} 失败: {e}"))?;
                            let mut hasher = Sha256::new();
                            let mut buf = vec![0u8; COPY_BUF];
                            loop {
                                let n = f
                                    .read(&mut buf)
                                    .await
                                    .map_err(|e| format!("读取远端 {remote_path} 失败: {e}"))?;
                                if n == 0 {
                                    break;
                                }
                                hasher.update(&buf[..n]);
                            }
                            sha_ok = hex::encode(hasher.finalize()) == *rec;
                        }
                    }
                }
            }
            if size_ok && mtime_ok && sha_ok {
                Ok(None)
            } else {
                Ok(Some(RestoreConflict { current_size: size, current_mtime: mtime, current_sha256: None }))
            }
        }
    }
}

/// 行级 diff：公共前后缀裁剪 + 中段 LCS（上限 2000 行/侧，超出返回 None → 元数据对比）。
/// 返回 (左侧行, 右侧行)：left 的 kind ∈ {del, ctx}，right 的 kind ∈ {add, ctx}。
fn diff_lines(a: &[String], b: &[String]) -> Option<(Vec<DiffLine>, Vec<DiffLine>)> {
    const LINE_CAP: usize = 2000;
    if a.len() > LINE_CAP || b.len() > LINE_CAP {
        return None;
    }
    // 公共前缀/后缀裁剪
    let mut pre = 0;
    while pre < a.len() && pre < b.len() && a[pre] == b[pre] {
        pre += 1;
    }
    let mut suf = 0;
    while suf < a.len() - pre && suf < b.len() - pre && a[a.len() - 1 - suf] == b[b.len() - 1 - suf] {
        suf += 1;
    }
    let mid_a = &a[pre..a.len() - suf];
    let mid_b = &b[pre..b.len() - suf];
    let (mid_left, mid_right) = lcs_diff(mid_a, mid_b);
    let mut left: Vec<DiffLine> = Vec::with_capacity(pre + mid_left.len() + suf);
    let mut right: Vec<DiffLine> = Vec::with_capacity(pre + mid_right.len() + suf);
    for line in a.iter().take(pre) {
        left.push(DiffLine { kind: "ctx".into(), text: line.clone() });
        right.push(DiffLine { kind: "ctx".into(), text: line.clone() });
    }
    left.extend(mid_left);
    right.extend(mid_right);
    for line in a.iter().rev().take(suf).rev() {
        left.push(DiffLine { kind: "ctx".into(), text: line.clone() });
        right.push(DiffLine { kind: "ctx".into(), text: line.clone() });
    }
    Some((left, right))
}

/// LCS 行 diff（DP，行数 ≤ 2000 保证内存有界；返回对齐后的左右行）。
fn lcs_diff(a: &[String], b: &[String]) -> (Vec<DiffLine>, Vec<DiffLine>) {
    let (n, m) = (a.len(), b.len());
    if n == 0 {
        let right = b.iter().map(|t| DiffLine { kind: "add".into(), text: t.clone() }).collect();
        return (Vec::new(), right);
    }
    if m == 0 {
        let left = a.iter().map(|t| DiffLine { kind: "del".into(), text: t.clone() }).collect();
        return (left, Vec::new());
    }
    // dp[i][j] = LCS(a[i..], b[j..])，倒推
    let mut dp = vec![vec![0u32; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            dp[i][j] = if a[i] == b[j] {
                dp[i + 1][j + 1] + 1
            } else {
                dp[i + 1][j].max(dp[i][j + 1])
            };
        }
    }
    let mut left = Vec::new();
    let mut right = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if a[i] == b[j] {
            left.push(DiffLine { kind: "ctx".into(), text: a[i].clone() });
            right.push(DiffLine { kind: "ctx".into(), text: b[j].clone() });
            i += 1;
            j += 1;
        } else if dp[i + 1][j] >= dp[i][j + 1] {
            left.push(DiffLine { kind: "del".into(), text: a[i].clone() });
            i += 1;
        } else {
            right.push(DiffLine { kind: "add".into(), text: b[j].clone() });
            j += 1;
        }
    }
    while i < n {
        left.push(DiffLine { kind: "del".into(), text: a[i].clone() });
        i += 1;
    }
    while j < m {
        right.push(DiffLine { kind: "add".into(), text: b[j].clone() });
        j += 1;
    }
    (left, right)
}

/* ---------------- Tauri 命令（前端工作台调用；AI 侧经 ai_actions 动作桥） ---------------- */

/// 用户从 SFTP / 远程编辑器主动暂存文件或目录（目录递归暂存全部文件）。
#[tauri::command]
pub async fn staging_add(
    staging: State<'_, Arc<RemoteStaging>>,
    project_id: String,
    session_id: String,
    server_id: String,
    remote_path: String,
) -> Result<Vec<StagedFile>, String> {
    staging
        .add_path(&project_id, &session_id, &server_id, &remote_path)
        .await
}

/// 清理无变更条目：远端现状与首次快照完全一致的条目直接接受清除，有变更/检查失败的保留。
#[tauri::command]
pub async fn staging_clear(
    staging: State<'_, Arc<RemoteStaging>>,
    project_id: String,
    session_id: String,
) -> Result<StagingClearOutcome, String> {
    staging.clear_unchanged(&project_id, &session_id).await
}

#[tauri::command]
pub async fn staging_list(
    staging: State<'_, Arc<RemoteStaging>>,
    project_id: String,
    session_id: String,
) -> Result<Vec<StagedFile>, String> {
    staging.list(&project_id, &session_id).await
}

#[tauri::command]
pub async fn staging_snapshot_read(
    staging: State<'_, Arc<RemoteStaging>>,
    project_id: String,
    session_id: String,
    entry_id: String,
) -> Result<StagingContent, String> {
    staging.read_snapshot(&project_id, &session_id, &entry_id).await
}

#[tauri::command]
pub async fn staging_current_read(
    staging: State<'_, Arc<RemoteStaging>>,
    project_id: String,
    session_id: String,
    entry_id: String,
) -> Result<StagingContent, String> {
    staging.read_current(&project_id, &session_id, &entry_id).await
}

#[tauri::command]
pub async fn staging_accept(
    staging: State<'_, Arc<RemoteStaging>>,
    project_id: String,
    session_id: String,
    entry_id: String,
) -> Result<StagedFile, String> {
    staging.accept(&project_id, &session_id, &entry_id).await
}

#[tauri::command]
pub async fn staging_restore(
    staging: State<'_, Arc<RemoteStaging>>,
    project_id: String,
    session_id: String,
    entry_id: String,
    force: bool,
) -> Result<RestoreOutcome, String> {
    staging.restore(&project_id, &session_id, &entry_id, force).await
}

#[tauri::command]
pub async fn staging_diff(
    staging: State<'_, Arc<RemoteStaging>>,
    project_id: String,
    session_id: String,
    entry_id: String,
) -> Result<StagingDiff, String> {
    staging.diff(&project_id, &session_id, &entry_id).await
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时 root + test_store（不碰真实 keyring / Store::new）。
    fn test_root(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aishell-staging-{tag}-{}-{}",
            std::process::id(),
            unix_ts()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn validate_id_rejects_dangerous_chars() {
        assert!(validate_id("proj-1_x", "项目 ID").is_ok());
        for bad in ["../etc", "a/b", "a b", "a:b", "", "a\\b", "a\u{2028}b"] {
            assert!(validate_id(bad, "项目 ID").is_err(), "应拒绝: {bad:?}");
        }
    }

    #[test]
    fn canonical_remote_path_normalizes() {
        assert_eq!(canonical_remote_path("/var/www/../etc/app.conf").unwrap(), "/var/etc/app.conf");
        assert_eq!(canonical_remote_path("/var//www//app/config.json").unwrap(), "/var/www/app/config.json");
        assert_eq!(canonical_remote_path("/a/./b/").unwrap(), "/a/b");
        assert_eq!(canonical_remote_path("/").unwrap(), "/");
        assert!(canonical_remote_path("relative/path").is_err(), "相对路径应拒绝");
        assert!(canonical_remote_path("").is_err());
    }

    #[test]
    fn manifest_missing_is_empty_but_corrupt_errors() {
        let root = test_root("manifest");
        let store = Arc::new(crate::store::test_store(root.join("store")));
        let staging = RemoteStaging::new(
            root.clone(),
            Arc::new(SshManager::new(Arc::clone(&store))),
            Arc::clone(&store),
        );
        // 无目录 → 空
        assert_eq!(staging.read_manifest("p1", "s1").unwrap(), Vec::<StagedFile>::new());
        // 写一个合法清单
        staging.write_manifest("p1", "s1", &[]).unwrap();
        assert_eq!(staging.read_manifest("p1", "s1").unwrap(), Vec::<StagedFile>::new());
        // 损坏 → 带路径错误（不静默当空）
        let path = staging.manifest_path("p1", "s1");
        std::fs::write(&path, "not json").unwrap();
        let err = staging.read_manifest("p1", "s1").unwrap_err();
        assert!(err.contains("manifest.json"), "应带路径: {err}");
        assert!(err.contains("损坏"), "应说明损坏: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_atomic_write_leaves_no_tmp() {
        let root = test_root("atomic");
        let store = Arc::new(crate::store::test_store(root.join("store")));
        let staging = RemoteStaging::new(
            root.clone(),
            Arc::new(SshManager::new(Arc::clone(&store))),
            Arc::clone(&store),
        );
        staging.write_manifest("p1", "s1", &[]).unwrap();
        let dir = staging.session_dir("p1", "s1");
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, vec!["manifest.json"], "不应残留 .tmp: {names:?}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn accept_removes_only_local_entry() {
        let root = test_root("accept");
        let store = Arc::new(crate::store::test_store(root.join("store")));
        let staging = RemoteStaging::new(
            root.clone(),
            Arc::new(SshManager::new(Arc::clone(&store))),
            Arc::clone(&store),
        );
        let entry = StagedFile {
            entry_id: "e1".to_string(),
            server_id: "srv-a".to_string(),
            remote_path: "/var/log/a.log".to_string(),
            original_state: StagedState::Existing,
            blob_ref: Some("abc".to_string()),
            size: Some(10),
            mtime: Some(1),
            sha256: Some("abc".to_string()),
            staged_at: 1,
            current_state: StagedState::Existing,
            current_size: Some(10),
            current_mtime: Some(1),
            current_sha256: Some("abc".to_string()),
        };
        staging.write_manifest("p1", "s1", &[entry]).unwrap();
        let removed = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(staging.accept("p1", "s1", "e1"))
            .unwrap();
        assert_eq!(removed.entry_id, "e1");
        let rest = staging.read_manifest("p1", "s1").unwrap();
        assert!(rest.is_empty(), "接受后条目应消失");
        // 重复接受 → 中文错误
        let err = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(staging.accept("p1", "s1", "e1"))
            .unwrap_err();
        assert!(err.contains("暂存条目不存在"), "实际: {err}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn concurrent_accepts_do_not_lose_manifest_updates() {
        let root = test_root("accept-concurrent");
        let store = Arc::new(crate::store::test_store(root.join("store")));
        let staging = Arc::new(RemoteStaging::new(
            root.clone(),
            Arc::new(SshManager::new(Arc::clone(&store))),
            Arc::clone(&store),
        ));
        let entries: Vec<StagedFile> = (1..=3)
            .map(|n| StagedFile {
                entry_id: format!("e{n}"),
                server_id: "srv-a".to_string(),
                remote_path: format!("/tmp/{n}.txt"),
                original_state: StagedState::Existing,
                blob_ref: Some(format!("hash{n}")),
                size: Some(1),
                mtime: Some(1),
                sha256: Some(format!("hash{n}")),
                staged_at: n,
                current_state: StagedState::Existing,
                current_size: Some(1),
                current_mtime: Some(1),
                current_sha256: Some(format!("hash{n}")),
            })
            .collect();
        staging.write_manifest("p1", "s1", &entries).unwrap();
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (a, b, c) = tokio::join!(
                staging.accept("p1", "s1", "e1"),
                staging.accept("p1", "s1", "e2"),
                staging.accept("p1", "s1", "e3"),
            );
            assert!(a.is_ok() && b.is_ok() && c.is_ok());
        });
        assert!(staging.read_manifest("p1", "s1").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn find_entry_matches_by_entry_id() {
        let root = test_root("find");
        let store = Arc::new(crate::store::test_store(root.join("store")));
        let staging = RemoteStaging::new(
            root.clone(),
            Arc::new(SshManager::new(Arc::clone(&store))),
            Arc::clone(&store),
        );
        let entry = StagedFile {
            entry_id: "e9".to_string(),
            server_id: "s".to_string(),
            remote_path: "/x".to_string(),
            original_state: StagedState::Absent,
            blob_ref: None,
            size: None,
            mtime: None,
            sha256: None,
            staged_at: 0,
            current_state: StagedState::Absent,
            current_size: None,
            current_mtime: None,
            current_sha256: None,
        };
        staging.write_manifest("p1", "s1", &[entry]).unwrap();
        let found = staging.find_entry(&staging.read_manifest("p1", "s1").unwrap(), "e9").unwrap();
        assert_eq!(found.remote_path, "/x");
        let err = staging.find_entry(&staging.read_manifest("p1", "s1").unwrap(), "nope").unwrap_err();
        assert!(err.contains("不存在"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn diff_lines_prefix_suffix_and_lcs() {
        let a = vec!["a".to_string(), "b".to_string(), "c".to_string(), "d".to_string()];
        let b = vec!["a".to_string(), "x".to_string(), "c".to_string(), "d".to_string()];
        let (left, right) = diff_lines(&a, &b).unwrap();
        // a: ctx a, del b, ctx c, ctx d
        assert_eq!(left[0].kind, "ctx");
        assert_eq!(left[1].kind, "del");
        assert_eq!(left[1].text, "b");
        assert_eq!(right[1].kind, "add");
        assert_eq!(right[1].text, "x");
        // 全删
        let (left, right) = diff_lines(&["a".to_string()], &[]).unwrap();
        assert_eq!(left[0].kind, "del");
        assert!(right.is_empty());
        // 全增
        let (left, right) = diff_lines(&[], &["a".to_string()]).unwrap();
        assert!(left.is_empty());
        assert_eq!(right[0].kind, "add");
        // 相同
        let (left, right) = diff_lines(&["a".to_string()], &["a".to_string()]).unwrap();
        assert_eq!(left.len(), 1);
        assert_eq!(right.len(), 1);
        // 超大 → None（元数据对比）
        let big: Vec<String> = (0..2500).map(|i| format!("line{i}")).collect();
        assert!(diff_lines(&big, &big).is_none());
    }

    #[test]
    fn content_from_bytes_text_vs_binary() {
        // 文本 → text
        let c = content_from_bytes(b"hello world", Some(11), Some(1), Some("h".into()), &[]);
        assert_eq!(c.text.as_deref(), Some("hello world"));
        assert!(c.meta.is_none());
        // 二进制（NUL）→ meta
        let c = content_from_bytes(b"\x00\x01\x02", Some(3), Some(1), Some("h".into()), &[]);
        assert!(c.text.is_none());
        assert_eq!(c.meta.unwrap().size, Some(3));
        // 超大 → meta
        let big = vec![b'x'; (MAX_EDIT_BYTES + 1) as usize];
        let c = content_from_bytes(&big, Some(big.len() as u64), Some(1), Some("h".into()), &[]);
        assert!(c.text.is_none());
        assert!(c.meta.is_some());
        // 文本含凭据 → 脱敏
        let c = content_from_bytes(b"password=secret123", Some(18), Some(1), Some("h".into()), &[]);
        assert!(c.text.unwrap().contains("已脱敏"));
    }

    #[test]
    fn snapshot_unchanged_decides_consistent() {
        let mk = |orig: StagedState, size: Option<u64>, mtime: Option<i64>, sha: Option<String>| StagedFile {
            entry_id: "e".to_string(),
            server_id: "s".to_string(),
            remote_path: "/x".to_string(),
            original_state: orig.clone(),
            blob_ref: sha.clone(),
            size,
            mtime,
            sha256: sha,
            staged_at: 0,
            current_state: orig,
            current_size: size,
            current_mtime: mtime,
            current_sha256: None,
        };
        // 原始不存在且远端不存在 → 无变更（可清理）
        assert!(snapshot_unchanged(&mk(StagedState::Absent, None, None, None), None));
        // 原始不存在但远端出现 → 有变更（保留）
        assert!(!snapshot_unchanged(
            &mk(StagedState::Absent, None, None, None),
            Some((Some(1), Some(1), None))
        ));
        // 原始存在、远端 size/mtime/hash 全同 → 无变更
        assert!(snapshot_unchanged(
            &mk(StagedState::Existing, Some(10), Some(5), Some("h".to_string())),
            Some((Some(10), Some(5), Some("h".to_string())))
        ));
        // 同 size 同 mtime 但内容不同（hash 不同）→ 有变更
        assert!(!snapshot_unchanged(
            &mk(StagedState::Existing, Some(10), Some(5), Some("h".to_string())),
            Some((Some(10), Some(5), Some("x".to_string())))
        ));
        // mtime 变 → 有变更
        assert!(!snapshot_unchanged(
            &mk(StagedState::Existing, Some(10), Some(5), Some("h".to_string())),
            Some((Some(10), Some(6), Some("h".to_string())))
        ));
        // 远端不存在（文件被删除）→ 有变更
        assert!(!snapshot_unchanged(
            &mk(StagedState::Existing, Some(10), Some(5), Some("h".to_string())),
            None
        ));
        // 超大文件（快照无 hash）只信 size/mtime
        assert!(snapshot_unchanged(
            &mk(StagedState::Existing, Some(100), Some(7), None),
            Some((Some(100), Some(7), None))
        ));
        assert!(!snapshot_unchanged(
            &mk(StagedState::Existing, Some(100), Some(7), None),
            Some((Some(101), Some(7), None))
        ));
        // 快照有 hash 但远端超大（未计算 hash）→ 只看 size/mtime，保守同 restore 语义
        assert!(snapshot_unchanged(
            &mk(StagedState::Existing, Some(10), Some(5), Some("h".to_string())),
            Some((Some(10), Some(5), None))
        ));
    }

    #[test]
    fn clear_unchanged_empty_manifest_is_ok() {
        let root = test_root("clear-empty");
        let store = Arc::new(crate::store::test_store(root.join("store")));
        let staging = RemoteStaging::new(
            root.clone(),
            Arc::new(SshManager::new(Arc::clone(&store))),
            Arc::clone(&store),
        );
        let out = tokio::runtime::Runtime::new()
            .unwrap()
            .block_on(staging.clear_unchanged("p1", "s1"))
            .unwrap();
        assert!(out.removed.is_empty() && out.kept.is_empty() && out.errors.is_empty());
        // manifest 保持不存在（不创建空清单文件）
        assert!(!staging.session_dir("p1", "s1").is_dir());
        let _ = std::fs::remove_dir_all(&root);
    }
}
