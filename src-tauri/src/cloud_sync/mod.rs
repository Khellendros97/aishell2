//! 用户数据云同步与文件备份。
//!
//! 端到端加密、协议 DTO 和本地运行态均只在 Rust 后端使用；前端只接收状态摘要。
//! 密码、vaultKey、凭据明文、OAuth token 永远不经过 Tauri 命令边界返回前端。

pub mod api;
pub mod backup;
pub mod core_config;
pub mod crypto;
pub mod engine;
pub mod manager;
pub mod notes_sync;
pub mod protocol;
pub mod state;

use std::sync::Arc;
use tauri::State;

use backup::{BackupManager, ClientBackupPage, InterruptedBackup, RestoreCollision};
use manager::{ClientDevice, ClientSyncStatus, CloudSyncManager};

type SyncState<'a> = State<'a, Arc<CloudSyncManager>>;
type BackupState<'a> = State<'a, Arc<BackupManager>>;

#[tauri::command]
pub async fn cloud_sync_status(sync: SyncState<'_>) -> Result<ClientSyncStatus, String> {
    // 未登录/离线时回退到本地缓存状态，避免账号页因网络失败而空白。
    match sync.refresh_status().await {
        Ok(status) => Ok(status),
        Err(_) => Ok(sync.current_status()),
    }
}

#[tauri::command]
pub async fn cloud_sync_initialize(sync: SyncState<'_>, password: String) -> Result<ClientSyncStatus, String> {
    sync.initialize(&password).await
}

#[tauri::command]
pub async fn cloud_sync_unlock(sync: SyncState<'_>, password: String) -> Result<ClientSyncStatus, String> {
    sync.unlock(&password).await
}

#[tauri::command]
pub async fn cloud_sync_lock(sync: SyncState<'_>) -> Result<ClientSyncStatus, String> {
    sync.lock()
}

#[tauri::command]
pub async fn cloud_sync_now(sync: SyncState<'_>) -> Result<ClientSyncStatus, String> {
    let manager = sync.inner().clone();
    manager.sync_now().await
}

#[tauri::command]
pub async fn cloud_sync_resolve_conflict(
    sync: SyncState<'_>,
    conflict_id: String,
    resolution: String,
) -> Result<ClientSyncStatus, String> {
    if !matches!(resolution.as_str(), "local" | "remote" | "dismiss") {
        return Err("未知的冲突处理方式".to_string());
    }
    sync.resolve_conflict(&conflict_id, &resolution)
}

#[tauri::command]
pub async fn cloud_sync_change_password(
    sync: SyncState<'_>,
    old_password: String,
    new_password: String,
) -> Result<ClientSyncStatus, String> {
    sync.change_password(&old_password, &new_password).await
}

#[tauri::command]
pub async fn cloud_sync_delete_all(sync: SyncState<'_>, confirmation: String) -> Result<(), String> {
    if confirmation != "DELETE_ALL_CLOUD_DATA" {
        return Err("请输入完整的确认短语后再删除全部云端数据".to_string());
    }
    sync.delete_all().await
}

#[tauri::command]
pub async fn cloud_sync_devices(sync: SyncState<'_>) -> Result<Vec<ClientDevice>, String> {
    sync.devices().await
}

#[tauri::command]
pub async fn cloud_sync_rename_device(
    sync: SyncState<'_>,
    device_id: String,
    name: String,
) -> Result<ClientDevice, String> {
    sync.rename_device(&device_id, &name).await
}

#[tauri::command]
pub async fn cloud_sync_revoke_device(sync: SyncState<'_>, device_id: String) -> Result<(), String> {
    sync.revoke_device(&device_id).await
}

#[tauri::command]
pub async fn cloud_sync_reregister_device(
    sync: SyncState<'_>,
    name: Option<String>,
) -> Result<ClientDevice, String> {
    sync.reregister_device(name).await
}

#[tauri::command]
pub async fn cloud_backups_list(
    backup: BackupState<'_>,
    cursor: Option<String>,
    limit: Option<i64>,
) -> Result<ClientBackupPage, String> {
    backup.list(cursor, limit).await
}

#[tauri::command]
pub async fn cloud_backup_start(backup: BackupState<'_>, path: String) -> Result<String, String> {
    backup.start(path)
}

#[tauri::command]
pub async fn cloud_backup_cancel(backup: BackupState<'_>, task_id: String) -> Result<(), String> {
    backup.cancel(&task_id)
}

#[tauri::command]
pub async fn cloud_backup_resume(backup: BackupState<'_>, backup_id: String) -> Result<String, String> {
    backup.resume(&backup_id)
}

#[tauri::command]
pub async fn cloud_backup_interrupted(backup: BackupState<'_>) -> Result<Vec<InterruptedBackup>, String> {
    backup.interrupted()
}

#[tauri::command]
pub async fn cloud_backup_abandon(backup: BackupState<'_>, task_id: String) -> Result<(), String> {
    backup.abandon(&task_id).await
}

#[tauri::command]
pub async fn cloud_backup_restore(
    backup: BackupState<'_>,
    backup_id: String,
    target_path: String,
    collision_mode: RestoreCollision,
) -> Result<(), String> {
    backup.restore(&backup_id, &target_path, collision_mode).await
}

#[tauri::command]
pub async fn cloud_backup_delete(backup: BackupState<'_>, backup_id: String) -> Result<(), String> {
    backup.delete(&backup_id).await
}
