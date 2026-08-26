//! 云同步运行时、Tauri 状态和结构化数据/笔记同步编排。

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::{Mutex as AsyncMutex, Notify};
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::cloud::CloudManager;
use crate::store::{CloudCapabilities, Store};

use super::api::{ApiError, ReqwestTransport, SyncApi};
use super::core_config::{apply_remote, from_app_state, merge_three_way, CoreConfigPayloadV1};
use super::crypto::{
    create_key_envelope, decrypt_sync_item, encode_base64, encrypt_sync_item, generate_vault_key,
    open_key_envelope, sha256_hex, EncryptedSyncItem, KdfParams,
    KeyEnvelopeMaterial,
};
use super::notes_sync::{
    apply_remote_directory, apply_remote_file, apply_remote_tombstone, diff, scan_notes,
    NoteDirectoryPayloadV1, NoteEntryType, NoteIndex, NotePayloadV1, NoteTombstone,
    NOTE_DIRECTORY_ENTITY_TYPE, NOTE_ENTITY_TYPE, NOTE_PAYLOAD_SCHEMA_VERSION,
};
use super::protocol::{
    CompleteUploadRequest, CreateUploadRequest, Device, KeyEnvelope, MutationRequest,
    MutationsRequest, PutKeyEnvelopeRequest, RegisterDeviceRequest, SyncItem, SyncLimits,
    SyncQuota, UpdateDeviceRequest, UploadPartRequest,
};
use super::state::{CloudSyncStore, EntityState, OutboxEntry, UserSyncState};

const CORE_ENTITY_TYPE: &str = "core_config";
const CORE_ENTITY_ID: &str = "default";
const CREDENTIAL_ENTITY_TYPE: &str = "credential_secret";
const VAULT_ACCOUNT_PREFIX: &str = "cloud-sync:vault:";
const PERIODIC_INTERVAL: Duration = Duration::from_secs(300);
const DIRTY_DEBOUNCE: Duration = Duration::from_secs(2);
const STARTUP_DELAY: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClientQuota {
    pub used_bytes: i64,
    pub total_bytes: i64,
    pub backup_used_bytes: i64,
    pub backup_total_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClientLimits {
    pub max_batch_items: i64,
    pub max_batch_bytes: i64,
    pub inline_payload_bytes: i64,
    pub max_backup_bytes: i64,
    pub max_backup_files: i64,
    pub max_concurrent_backups: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientDevice {
    pub id: String,
    pub name: String,
    pub is_current: bool,
    pub revoked: bool,
    pub last_seen_at: Option<String>,
    pub created_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientConflict {
    pub id: String,
    pub kind: String,
    pub entity_type: String,
    pub entity_id: String,
    pub summary: String,
    pub local_device: Option<String>,
    pub remote_device: Option<String>,
    pub created_at: String,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientSyncStatus {
    pub enabled: bool,
    pub backup_enabled: bool,
    pub initialized: bool,
    pub unlocked: bool,
    pub syncing: bool,
    pub status: String,
    pub last_success_at: Option<String>,
    pub pending_count: usize,
    pub conflicts: Vec<ClientConflict>,
    pub quota: ClientQuota,
    pub limits: ClientLimits,
    pub device: Option<ClientDevice>,
}

impl Default for ClientSyncStatus {
    fn default() -> Self {
        Self {
            enabled: false,
            backup_enabled: false,
            initialized: false,
            unlocked: false,
            syncing: false,
            status: "idle".into(),
            last_success_at: None,
            pending_count: 0,
            conflicts: Vec::new(),
            quota: ClientQuota::default(),
            limits: ClientLimits::default(),
            device: None,
        }
    }
}

#[derive(Default)]
struct RuntimeState {
    vault_key: Option<Zeroizing<[u8; 32]>>,
    status: ClientSyncStatus,
}

pub struct CloudSyncManager {
    app: AppHandle,
    store: Arc<Store>,
    cloud: Arc<CloudManager>,
    local: CloudSyncStore,
    runtime: Mutex<RuntimeState>,
    sync_lock: AsyncMutex<()>,
    wake: Notify,
}

impl CloudSyncManager {
    pub fn new(app: AppHandle, store: Arc<Store>, cloud: Arc<CloudManager>) -> Result<Arc<Self>, String> {
        let local = CloudSyncStore::new(store.config_dir());
        local.ensure_layout().map_err(|error| error.to_string())?;
        local.load_or_create_installation().map_err(|error| error.to_string())?;
        let manager = Arc::new(Self {
            app,
            store,
            cloud,
            local,
            runtime: Mutex::new(RuntimeState::default()),
            sync_lock: AsyncMutex::new(()),
            wake: Notify::new(),
        });
        let weak = Arc::downgrade(&manager);
        manager.store.set_change_notifier(Arc::new(move || {
            if let Some(manager) = weak.upgrade() {
                manager.wake.notify_one();
            }
        }));
        manager.try_load_cached_vault();
        Ok(manager)
    }

    pub(crate) fn user_context(&self) -> Result<(String, CloudCapabilities), String> {
        let (user, capabilities) = self.store.cloud_profile();
        let user = user.ok_or_else(|| "请先登录云账号".to_string())?;
        let id = user.id.ok_or_else(|| "云账号缺少用户标识，请重新登录".to_string())?;
        let capabilities = capabilities.unwrap_or_default();
        Ok((id.to_string(), capabilities))
    }

    pub(crate) fn api(&self) -> Result<SyncApi<ReqwestTransport>, String> {
        Ok(SyncApi::new(ReqwestTransport::from_cloud(
            Arc::clone(&self.cloud),
            Arc::clone(&self.store),
        )?))
    }

    fn vault_account(user_id: &str) -> String {
        format!("{VAULT_ACCOUNT_PREFIX}{user_id}")
    }

    fn try_load_cached_vault(&self) {
        let Ok((user_id, _)) = self.user_context() else { return; };
        let Ok(value) = self.store.sync_read_secret(&Self::vault_account(&user_id)) else { return; };
        let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(value) else { return; };
        let Ok(key) = <[u8; 32]>::try_from(bytes.as_slice()) else { return; };
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.vault_key = Some(Zeroizing::new(key));
            runtime.status.unlocked = true;
        }
    }

    pub(crate) fn vault_key(&self) -> Result<Zeroizing<[u8; 32]>, String> {
        self.runtime
            .lock()
            .map_err(|_| "云同步状态锁损坏".to_string())?
            .vault_key
            .clone()
            .ok_or_else(|| "请先输入云同步密码解锁".to_string())
    }

    fn emit_status(&self) {
        if let Ok(runtime) = self.runtime.lock() {
            let _ = self.app.emit("cloud-sync:changed", runtime.status.clone());
        }
    }

    pub fn current_status(&self) -> ClientSyncStatus {
        self.runtime.lock().map(|state| state.status.clone()).unwrap_or_default()
    }

    pub(crate) fn local_store(&self) -> &CloudSyncStore {
        &self.local
    }

    pub(crate) fn app_handle(&self) -> &AppHandle {
        &self.app
    }

    pub(crate) fn emit_backup_changed(&self) {
        let _ = self.app.emit("cloud-backup:changed", ());
    }

    pub(crate) async fn ensure_device(
        &self,
        api: &SyncApi<ReqwestTransport>,
        user_id: &str,
    ) -> Result<UserSyncState, String> {
        let mut state = self.local.load_state(user_id).map_err(|error| error.to_string())?;
        if state.device_id.is_none() {
            let installation = self.local.load_or_create_installation().map_err(|error| error.to_string())?;
            let name = std::env::var("COMPUTERNAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_else(|_| "AIShell 设备".to_string());
            let registered = api
                .register_device(&RegisterDeviceRequest {
                    installation_id: installation.installation_id,
                    name: name.clone(),
                    platform: std::env::consts::OS.to_string(),
                    app_version: env!("CARGO_PKG_VERSION").to_string(),
                })
                .await
                .map_err(|error| error.to_string())?;
            if registered.revoked {
                return Err("当前设备已被撤销，请在设备管理中重新注册本机".to_string());
            }
            state.device_id = Some(registered.device_id.clone());
            self.local.save_state(&state).map_err(|error| error.to_string())?;
            if let Ok(mut runtime) = self.runtime.lock() {
                runtime.status.device = Some(ClientDevice {
                    id: registered.device_id,
                    name,
                    is_current: true,
                    revoked: false,
                    last_seen_at: None,
                    created_at: None,
                });
            }
        }
        Ok(state)
    }

    pub async fn refresh_status(&self) -> Result<ClientSyncStatus, String> {
        let (user_id, caps) = self.user_context()?;
        let api = self.api()?;
        let remote = api.status().await.map_err(|error| error.to_string())?;
        let state = self.ensure_device(&api, &user_id).await?;
        let pending = self.local.list_outbox(&user_id).map_err(|error| error.to_string())?.len();
        let unlocked = self.runtime.lock().ok().and_then(|state| state.vault_key.as_ref().map(|_| ())).is_some();
        let device_id = state.device_id.clone();
        let mut status = self.current_status();
        status.enabled = caps.data_sync && remote.enabled;
        status.backup_enabled = caps.file_backup && remote.backup_enabled;
        status.initialized = remote.key_envelope.exists;
        status.unlocked = unlocked;
        status.pending_count = pending;
        status.status = if !status.initialized { "idle" } else if !unlocked { "locked" } else if status.conflicts.is_empty() { "idle" } else { "conflict" }.to_string();
        status.quota = client_quota(&remote.quota);
        status.limits = client_limits(&remote.limits, &remote.quota);
        if status.device.is_none() {
            status.device = device_id.map(|id| ClientDevice { id, name: "本机".into(), is_current: true, revoked: false, last_seen_at: None, created_at: None });
        }
        if let Ok(mut runtime) = self.runtime.lock() { runtime.status = status.clone(); }
        self.emit_status();
        Ok(status)
    }

    pub async fn initialize(&self, password: &str) -> Result<ClientSyncStatus, String> {
        validate_password(password)?;
        let (user_id, caps) = self.user_context()?;
        if !caps.data_sync && !caps.file_backup { return Err("当前账号未开通云同步或文件备份能力".into()); }
        let api = self.api()?;
        let mut state = self.ensure_device(&api, &user_id).await?;
        let remote = api.status().await.map_err(|error| error.to_string())?;
        if remote.key_envelope.exists { return Err("云同步已经初始化，请使用解锁功能".into()); }
        let vault = generate_vault_key().map_err(|error| error.to_string())?;
        let material = create_key_envelope(password, &vault).map_err(|error| error.to_string())?;
        let envelope = api.put_key_envelope(&put_envelope_request(0, &material)).await.map_err(|error| error.to_string())?;
        self.store.sync_write_secret(&Self::vault_account(&user_id), &encode_base64(&vault[..]))?;
        state.envelope_revision = envelope.revision;
        self.local.save_state(&state).map_err(|error| error.to_string())?;
        if let Ok(mut runtime) = self.runtime.lock() { runtime.vault_key = Some(vault); }
        self.refresh_status().await
    }

    pub async fn unlock(&self, password: &str) -> Result<ClientSyncStatus, String> {
        let (user_id, _) = self.user_context()?;
        let api = self.api()?;
        let envelope = api.key_envelope().await.map_err(|error| error.to_string())?;
        let material = envelope_material(&envelope)?;
        let vault = open_key_envelope(password, &material).map_err(|_| "云同步密码不正确".to_string())?;
        self.store.sync_write_secret(&Self::vault_account(&user_id), &encode_base64(&vault[..]))?;
        let mut state = self.local.load_state(&user_id).map_err(|error| error.to_string())?;
        state.envelope_revision = envelope.revision;
        self.local.save_state(&state).map_err(|error| error.to_string())?;
        if let Ok(mut runtime) = self.runtime.lock() { runtime.vault_key = Some(vault); }
        self.refresh_status().await
    }

    pub fn lock(&self) -> Result<ClientSyncStatus, String> {
        let (user_id, _) = self.user_context()?;
        let _ = self.store.sync_delete_secret(&Self::vault_account(&user_id));
        let mut runtime = self.runtime.lock().map_err(|_| "云同步状态锁损坏".to_string())?;
        runtime.vault_key = None;
        runtime.status.unlocked = false;
        runtime.status.status = "locked".into();
        let status = runtime.status.clone();
        drop(runtime);
        self.emit_status();
        Ok(status)
    }

    pub async fn change_password(&self, old_password: &str, new_password: &str) -> Result<ClientSyncStatus, String> {
        validate_password(new_password)?;
        let (user_id, _) = self.user_context()?;
        let api = self.api()?;
        let envelope = api.key_envelope().await.map_err(|error| error.to_string())?;
        let vault = open_key_envelope(old_password, &envelope_material(&envelope)?)
            .map_err(|_| "原云同步密码不正确".to_string())?;
        let material = create_key_envelope(new_password, &vault).map_err(|error| error.to_string())?;
        let updated = api.put_key_envelope(&put_envelope_request(envelope.revision, &material)).await.map_err(|error| error.to_string())?;
        self.store.sync_write_secret(&Self::vault_account(&user_id), &encode_base64(&vault[..]))?;
        let mut state = self.local.load_state(&user_id).map_err(|error| error.to_string())?;
        state.envelope_revision = updated.revision;
        self.local.save_state(&state).map_err(|error| error.to_string())?;
        if let Ok(mut runtime) = self.runtime.lock() { runtime.vault_key = Some(vault); }
        self.refresh_status().await
    }

    pub async fn devices(&self) -> Result<Vec<ClientDevice>, String> {
        let (user_id, _) = self.user_context()?;
        let current = self.local.load_state(&user_id).map_err(|error| error.to_string())?.device_id;
        self.api()?.devices().await.map_err(|error| error.to_string()).map(|items| items.into_iter().map(|device| client_device(device, current.as_deref())).collect())
    }

    pub async fn rename_device(&self, device_id: &str, name: &str) -> Result<ClientDevice, String> {
        if name.trim().is_empty() { return Err("设备名称不能为空".into()); }
        let (user_id, _) = self.user_context()?;
        let current = self.local.load_state(&user_id).map_err(|error| error.to_string())?.device_id;
        let device = self.api()?.update_device(device_id, &UpdateDeviceRequest { name: name.trim().to_string() }).await.map_err(|error| error.to_string())?;
        Ok(client_device(device, current.as_deref()))
    }

    pub async fn revoke_device(&self, device_id: &str) -> Result<(), String> {
        let (user_id, _) = self.user_context()?;
        let state = self.local.load_state(&user_id).map_err(|error| error.to_string())?;
        if state.device_id.as_deref() == Some(device_id) { return Err("不能撤销当前设备，请先在其他设备操作".into()); }
        self.api()?.revoke_device(device_id).await.map_err(|error| error.to_string())
    }

    pub async fn reregister_device(&self, name: Option<String>) -> Result<ClientDevice, String> {
        let (user_id, _) = self.user_context()?;
        let installation = super::state::InstallationState { installation_id: Uuid::new_v4().to_string() };
        // 被撤销 installationId 不可复活；新的 ID 只写独立状态，不使用硬件指纹。
        self.local.replace_installation(&installation).map_err(|error| error.to_string())?;
        let api = self.api()?;
        let registered = api.register_device(&RegisterDeviceRequest {
            installation_id: installation.installation_id,
            name: name.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| "AIShell 设备".into()),
            platform: std::env::consts::OS.into(),
            app_version: env!("CARGO_PKG_VERSION").into(),
        }).await.map_err(|error| error.to_string())?;
        let mut state = self.local.load_state(&user_id).map_err(|error| error.to_string())?;
        state.device_id = Some(registered.device_id.clone());
        state.last_applied_cursor = 0;
        self.local.save_state(&state).map_err(|error| error.to_string())?;
        self.devices().await?.into_iter().find(|device| device.id == registered.device_id).ok_or_else(|| "设备注册成功但未在设备列表中找到".into())
    }

    pub async fn sync_now(self: &Arc<Self>) -> Result<ClientSyncStatus, String> {
        let _guard = self.sync_lock.lock().await;
        let (user_id, caps) = self.user_context()?;
        if !caps.data_sync { return Err("当前账号未开通用户数据同步能力".into()); }
        let vault = self.vault_key()?;
        let api = self.api()?;
        let mut state = self.ensure_device(&api, &user_id).await?;
        if let Ok(mut runtime) = self.runtime.lock() { runtime.status.syncing = true; runtime.status.status = "syncing".into(); }
        self.emit_status();
        let result = self.sync_cycle(&api, &user_id, &vault, &mut state).await;
        if let Ok(mut runtime) = self.runtime.lock() {
            runtime.status.syncing = false;
            match &result {
                Ok(()) => { runtime.status.status = if runtime.status.conflicts.is_empty() { "idle" } else { "conflict" }.into(); runtime.status.last_success_at = Some(now_rfc3339ish()); }
                Err(error) => { runtime.status.status = if error.contains("配额") { "quotaExceeded" } else { "offline" }.into(); }
            }
        }
        self.emit_status();
        result?;
        self.refresh_status().await
    }

    async fn sync_cycle(&self, api: &SyncApi<ReqwestTransport>, user_id: &str, vault: &[u8; 32], state: &mut UserSyncState) -> Result<(), String> {
        self.pull_remote(api, user_id, vault, state).await?;
        self.push_local(api, user_id, vault, state).await?;
        self.pull_remote(api, user_id, vault, state).await?;
        self.local.save_state(state).map_err(|error| error.to_string())
    }

    async fn pull_remote(&self, api: &SyncApi<ReqwestTransport>, user_id: &str, vault: &[u8; 32], state: &mut UserSyncState) -> Result<(), String> {
        let mut cursor = state.last_applied_cursor;
        loop {
            match api.changes(cursor, 100).await {
                Ok(page) => {
                    self.apply_items(api, user_id, vault, state, &page.changes).await?;
                    cursor = page.next_cursor;
                    state.last_applied_cursor = cursor;
                    self.local.save_state(state).map_err(|error| error.to_string())?;
                    api.ack(&super::protocol::AckRequest { device_id: state.device_id.clone().ok_or_else(|| "本机尚未注册云同步设备".to_string())?, cursor }).await.map_err(|error| error.to_string())?;
                    if !page.has_more { break; }
                }
                Err(error) if error.code == "SYNC_CURSOR_EXPIRED" || error.status == 410 => {
                    self.pull_snapshot(api, user_id, vault, state).await?;
                    break;
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        Ok(())
    }

    async fn pull_snapshot(&self, api: &SyncApi<ReqwestTransport>, user_id: &str, vault: &[u8; 32], state: &mut UserSyncState) -> Result<(), String> {
        for _ in 0..3 {
            let mut token = None;
            let mut items = Vec::new();
            let mut cursor = 0;
            let mut restart = false;
            loop {
                match api.snapshot(token.as_deref(), 100).await {
                    Ok(page) => {
                        cursor = page.latest_cursor;
                        items.extend(page.items);
                        if !page.has_more { break; }
                        token = page.next_page_token;
                        if token.is_none() { return Err("云端快照分页缺少游标".into()); }
                    }
                    Err(error) if error.code == "SYNC_CONFLICT" || error.status == 409 => { restart = true; break; }
                    Err(error) => return Err(error.to_string()),
                }
            }
            if restart { continue; }
            self.apply_items(api, user_id, vault, state, &items).await?;
            state.last_applied_cursor = cursor;
            self.local.save_state(state).map_err(|error| error.to_string())?;
            api.ack(&super::protocol::AckRequest { device_id: state.device_id.clone().ok_or_else(|| "本机尚未注册云同步设备".to_string())?, cursor }).await.map_err(|error| error.to_string())?;
            return Ok(());
        }
        Err("云端数据持续变化，无法取得一致快照，请稍后重试".into())
    }

    async fn item_ciphertext(&self, api: &SyncApi<ReqwestTransport>, item: &SyncItem) -> Result<String, String> {
        if let Some(ciphertext) = &item.ciphertext { return Ok(ciphertext.clone()); }
        let blob_id = item.blob_id.as_deref().ok_or_else(|| "同步项缺少密文和 blobId".to_string())?;
        let bytes = api.download_blob(blob_id, None, None).await.map_err(|error| error.to_string())?.bytes;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    }

    async fn apply_items(&self, api: &SyncApi<ReqwestTransport>, user_id: &str, vault: &[u8; 32], state: &mut UserSyncState, items: &[SyncItem]) -> Result<(), String> {
        for item in items {
            let key = entity_key(&item.entity_type, &item.entity_id);
            if item.tombstone || item.operation == "delete" {
                self.apply_tombstone(user_id, item)?;
                state.entities.insert(key, EntityState { version: item.version, tombstone: true, ciphertext_sha256: None, local_hash: None });
                continue;
            }
            let ciphertext = self.item_ciphertext(api, item).await?;
            let encrypted = EncryptedSyncItem {
                ciphertext,
                encryption_meta: serde_json::from_value(item.encryption_meta.clone()).map_err(|error| format!("同步项加密元数据不合法: {error}"))?,
                ciphertext_sha256: item.ciphertext_sha256.clone().ok_or_else(|| "同步项缺少 SHA-256".to_string())?,
            };
            let plaintext = decrypt_sync_item(vault, user_id, &item.entity_type, &item.entity_id, item.payload_schema_version as u32, &encrypted).map_err(|error| error.to_string())?;
            let local_hash = sha256_hex(&plaintext);
            self.apply_plain_item(user_id, item, &plaintext)?;
            state.entities.insert(key, EntityState { version: item.version, tombstone: false, ciphertext_sha256: item.ciphertext_sha256.clone(), local_hash: Some(local_hash) });
        }
        Ok(())
    }

    fn apply_plain_item(&self, user_id: &str, item: &SyncItem, plaintext: &[u8]) -> Result<(), String> {
        match item.entity_type.as_str() {
            CORE_ENTITY_TYPE => {
                let remote: CoreConfigPayloadV1 = serde_json::from_slice(plaintext).map_err(|error| format!("云端核心配置格式损坏: {error}"))?;
                let local_state = self.store.sync_snapshot()?;
                let local = from_app_state(&local_state);
                let baseline: Option<CoreConfigPayloadV1> = self.local.load_baseline(user_id, CORE_ENTITY_TYPE, CORE_ENTITY_ID).map_err(|error| error.to_string())?;
                let merged = if let Some(base) = baseline {
                    let (merged, conflicts) = merge_three_way(&base, &local, &remote);
                    if !conflicts.is_empty() {
                        self.record_core_conflicts(&conflicts, item.updated_by_device_id.clone());
                    }
                    merged
                } else { remote.clone() };
                self.store.with_candidate_state(|candidate| apply_remote(candidate, &merged))?;
                self.local.save_baseline(user_id, CORE_ENTITY_TYPE, CORE_ENTITY_ID, &remote).map_err(|error| error.to_string())?;
            }
            CREDENTIAL_ENTITY_TYPE => {
                let secret: CredentialSecretV1 = serde_json::from_slice(plaintext).map_err(|error| format!("云端凭据格式损坏: {error}"))?;
                if secret.schema_version != 1 || secret.credential_id != item.entity_id { return Err("云端凭据标识不一致".into()); }
                self.store.sync_write_secret(&Store::credential_secret_account(&secret.credential_id), &secret.secret)?;
            }
            NOTE_ENTITY_TYPE => {
                let payload: NotePayloadV1 = serde_json::from_slice(plaintext).map_err(|error| format!("云端笔记格式损坏: {error}"))?;
                let root = self.store.notes_root()?;
                apply_remote_file(&root, &payload).map_err(|error| error.to_string())?;
                let _ = self.app.emit("fs:changed", json!({"path": root.join(&payload.path).to_string_lossy()}));
            }
            NOTE_DIRECTORY_ENTITY_TYPE => {
                let payload: NoteDirectoryPayloadV1 = serde_json::from_slice(plaintext).map_err(|error| format!("云端笔记目录格式损坏: {error}"))?;
                let root = self.store.notes_root()?;
                apply_remote_directory(&root, &payload).map_err(|error| error.to_string())?;
            }
            _ => return Err(format!("当前客户端不支持同步实体类型 {}，请升级 AIShell", item.entity_type)),
        }
        Ok(())
    }

    fn apply_tombstone(&self, user_id: &str, item: &SyncItem) -> Result<(), String> {
        match item.entity_type.as_str() {
            CREDENTIAL_ENTITY_TYPE => self.store.sync_delete_secret(&Store::credential_secret_account(&item.entity_id)),
            NOTE_ENTITY_TYPE | NOTE_DIRECTORY_ENTITY_TYPE => {
                let baseline: Option<NoteIndexRecordBaseline> = self.local.load_baseline(user_id, &item.entity_type, &item.entity_id).map_err(|error| error.to_string())?;
                if let Some(record) = baseline {
                    let tombstone = NoteTombstone { entity_id: item.entity_id.clone(), entry_type: record.entry_type, path: record.path, tombstone: true };
                    apply_remote_tombstone(&self.store.notes_root()?, &tombstone).map_err(|error| error.to_string())?;
                }
                Ok(())
            }
            CORE_ENTITY_TYPE => Ok(()),
            _ => Ok(()),
        }
    }

    fn record_core_conflicts(&self, conflicts: &[super::core_config::CoreConflict], remote_device: Option<String>) {
        if let Ok(mut runtime) = self.runtime.lock() {
            for conflict in conflicts {
                runtime.status.conflicts.push(ClientConflict {
                    id: Uuid::new_v4().to_string(), kind: "coreConfig".into(), entity_type: conflict.entity_type.clone(), entity_id: conflict.entity_id.clone(),
                    summary: format!("字段 {} 在本机和云端均被修改，当前暂保留本机值", conflict.field), local_device: Some("本机".into()), remote_device: remote_device.clone(), created_at: now_rfc3339ish(), path: None,
                });
            }
        }
    }

    async fn push_local(&self, api: &SyncApi<ReqwestTransport>, user_id: &str, vault: &[u8; 32], state: &mut UserSyncState) -> Result<(), String> {
        let remote_status = api.status().await.map_err(|error| error.to_string())?;
        let mut pending = Vec::new();
        let snapshot = self.store.sync_snapshot()?;
        let core = from_app_state(&snapshot);
        let core_bytes = serde_json::to_vec(&core).map_err(|error| format!("序列化核心配置失败: {error}"))?;
        let core_hash = sha256_hex(&core_bytes);
        if state.entities.get(&entity_key(CORE_ENTITY_TYPE, CORE_ENTITY_ID)).and_then(|entity| entity.local_hash.as_deref()) != Some(core_hash.as_str()) {
            pending.push(self.prepare_upsert(api, user_id, vault, state, CORE_ENTITY_TYPE, CORE_ENTITY_ID, 1, &core_bytes, remote_status.limits.inline_payload_bytes).await?);
        }

        let credential_ids: HashSet<String> = snapshot.credentials.iter().map(|credential| credential.id.clone()).collect();
        for credential in &snapshot.credentials {
            let Ok(secret) = self.store.sync_read_secret(&Store::credential_secret_account(&credential.id)) else { continue; };
            let payload = CredentialSecretV1 { schema_version: 1, credential_id: credential.id.clone(), secret_type: "password".into(), secret };
            let bytes = serde_json::to_vec(&payload).map_err(|error| format!("序列化凭据失败: {error}"))?;
            let hash = sha256_hex(&bytes);
            if state.entities.get(&entity_key(CREDENTIAL_ENTITY_TYPE, &credential.id)).and_then(|entity| entity.local_hash.as_deref()) != Some(hash.as_str()) {
                pending.push(self.prepare_upsert(api, user_id, vault, state, CREDENTIAL_ENTITY_TYPE, &credential.id, 1, &bytes, remote_status.limits.inline_payload_bytes).await?);
            }
        }
        for (key, entity) in state.entities.clone() {
            if let Some(id) = key.strip_prefix(&format!("{CREDENTIAL_ENTITY_TYPE}:")) {
                if !entity.tombstone && !credential_ids.contains(id) { pending.push(prepared_delete(CREDENTIAL_ENTITY_TYPE, id, entity.version)); }
            }
        }

        if let Ok(root) = self.store.notes_root() {
            let notes = scan_notes(&root, vault).map_err(|error| error.to_string())?;
            let old_index: NoteIndex = self.local.load_baseline(user_id, "note_index", "default").map_err(|error| error.to_string())?.unwrap_or_default();
            let plan = diff(&old_index, &notes.index);
            for upsert in plan.upserts {
                let bytes = match upsert.entry_type {
                    NoteEntryType::File => serde_json::to_vec(notes.payload(&upsert.path).ok_or_else(|| "笔记同步计划缺少文件 payload".to_string())?),
                    NoteEntryType::Directory => serde_json::to_vec(notes.directory_payload(&upsert.path).ok_or_else(|| "笔记同步计划缺少目录 payload".to_string())?),
                }.map_err(|error| format!("序列化笔记失败: {error}"))?;
                pending.push(self.prepare_upsert(api, user_id, vault, state, upsert.entry_type.entity_type(), &upsert.entity_id, NOTE_PAYLOAD_SCHEMA_VERSION as i64, &bytes, remote_status.limits.inline_payload_bytes).await?);
                self.local.save_baseline(user_id, upsert.entry_type.entity_type(), &upsert.entity_id, &NoteIndexRecordBaseline { path: upsert.path, entry_type: upsert.entry_type }).map_err(|error| error.to_string())?;
            }
            for tombstone in plan.tombstones { let version = state.entities.get(&entity_key(tombstone.entry_type.entity_type(), &tombstone.entity_id)).map(|entity| entity.version).unwrap_or(0); pending.push(prepared_delete(tombstone.entry_type.entity_type(), &tombstone.entity_id, version)); }
            if !pending.is_empty() { self.submit_pending(api, user_id, state, &pending, remote_status.limits.max_batch_items.max(1) as usize).await?; }
            self.local.save_baseline(user_id, "note_index", "default", &notes.index).map_err(|error| error.to_string())?;
        } else if !pending.is_empty() {
            self.submit_pending(api, user_id, state, &pending, remote_status.limits.max_batch_items.max(1) as usize).await?;
        }
        self.local.save_baseline(user_id, CORE_ENTITY_TYPE, CORE_ENTITY_ID, &core).map_err(|error| error.to_string())?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)] // 同步实体定位需要完整 (类型,ID,schema,版本) 上下文，聚合结构反而掩盖协议字段
    async fn prepare_upsert(&self, api: &SyncApi<ReqwestTransport>, user_id: &str, vault: &[u8; 32], state: &UserSyncState, entity_type: &str, entity_id: &str, schema: i64, plaintext: &[u8], inline_limit: i64) -> Result<PreparedMutation, String> {
        let encrypted = encrypt_sync_item(vault, user_id, entity_type, entity_id, schema as u32, plaintext).map_err(|error| error.to_string())?;
        let raw = base64::engine::general_purpose::STANDARD.decode(&encrypted.ciphertext).map_err(|error| format!("解码本地密文失败: {error}"))?;
        let (ciphertext, blob_id) = if raw.len() as i64 <= inline_limit { (Some(encrypted.ciphertext.clone()), None) } else { (None, Some(self.upload_bytes(api, state, "sync_payload", &raw, serde_json::to_value(&encrypted.encryption_meta).unwrap_or(Value::Null)).await?)) };
        Ok(PreparedMutation {
            request: MutationRequest { mutation_id: Uuid::new_v4().to_string(), entity_type: entity_type.into(), entity_id: entity_id.into(), operation: "upsert".into(), base_version: state.entities.get(&entity_key(entity_type, entity_id)).map(|entity| entity.version).unwrap_or(0), payload_schema_version: Some(schema), ciphertext, blob_id, encryption_meta: Some(serde_json::to_value(encrypted.encryption_meta).map_err(|error| error.to_string())?), ciphertext_sha256: Some(encrypted.ciphertext_sha256) },
            local_hash: Some(sha256_hex(plaintext)),
        })
    }

    async fn upload_bytes(&self, api: &SyncApi<ReqwestTransport>, state: &UserSyncState, purpose: &str, bytes: &[u8], encryption_meta: Value) -> Result<String, String> {
        let device_id = state.device_id.clone().ok_or_else(|| "本机尚未注册云同步设备".to_string())?;
        let upload = api.create_upload(&CreateUploadRequest { device_id, request_id: Uuid::new_v4().to_string(), purpose: purpose.into(), ciphertext_size: bytes.len() as i64, ciphertext_sha256: sha256_hex(bytes), encryption_meta }).await.map_err(|error| error.to_string())?;
        let part_size = usize::try_from(upload.part_size).map_err(|_| "云端分片大小不合法".to_string())?;
        if part_size == 0 { return Err("云端分片大小为 0".into()); }
        let existing: BTreeMap<i64, String> = upload.uploaded_parts.into_iter().map(|part| (part.part_number, part.sha256)).collect();
        let mut parts = Vec::new();
        for (index, chunk) in bytes.chunks(part_size).enumerate() {
            let number = index as i64 + 1;
            let hash = sha256_hex(chunk);
            if existing.get(&number) != Some(&hash) { api.put_upload_part(&upload.upload_id, number as u32, chunk, &hash).await.map_err(|error| error.to_string())?; }
            parts.push(UploadPartRequest { part_number: number, sha256: hash });
        }
        let completed = api.complete_upload(&upload.upload_id, &CompleteUploadRequest { parts }).await.map_err(|error| error.to_string())?;
        completed.blob_id.ok_or_else(|| "云端完成上传后未返回 blobId".into())
    }

    async fn submit_pending(&self, api: &SyncApi<ReqwestTransport>, user_id: &str, state: &mut UserSyncState, pending: &[PreparedMutation], max_items: usize) -> Result<(), String> {
        let device_id = state.device_id.clone().ok_or_else(|| "本机尚未注册云同步设备".to_string())?;
        for mutation in pending {
            self.local.save_outbox(user_id, &OutboxEntry { mutation_id: mutation.request.mutation_id.clone(), entity_type: mutation.request.entity_type.clone(), entity_id: mutation.request.entity_id.clone(), operation: mutation.request.operation.clone(), base_version: mutation.request.base_version, payload_schema_version: mutation.request.payload_schema_version, ciphertext: mutation.request.ciphertext.clone(), blob_id: mutation.request.blob_id.clone(), encryption_meta: mutation.request.encryption_meta.clone(), ciphertext_sha256: mutation.request.ciphertext_sha256.clone(), attempts: 0, created_at_unix_ms: now_unix_ms() }).map_err(|error| error.to_string())?;
        }
        for batch in pending.chunks(max_items) {
            let response = api.mutations(&MutationsRequest { device_id: device_id.clone(), batch_id: Uuid::new_v4().to_string(), mutations: batch.iter().map(|mutation| mutation.request.clone()).collect() }).await.map_err(sync_error_text)?;
            for result in response.results {
                if let Some(prepared) = batch.iter().find(|mutation| mutation.request.mutation_id == result.mutation_id) {
                    state.entities.insert(entity_key(&result.entity_type, &result.entity_id), EntityState { version: result.version, tombstone: result.operation == "delete", ciphertext_sha256: prepared.request.ciphertext_sha256.clone(), local_hash: prepared.local_hash.clone() });
                    self.local.acknowledge_outbox(user_id, &result.mutation_id).map_err(|error| error.to_string())?;
                }
            }
            state.last_applied_cursor = state.last_applied_cursor.max(response.latest_cursor);
            self.local.save_state(state).map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    pub async fn delete_all(&self) -> Result<(), String> {
        let (user_id, _) = self.user_context()?;
        self.api()?.delete_all_data().await.map_err(|error| error.to_string())?;
        let _ = self.store.sync_delete_secret(&Self::vault_account(&user_id));
        if let Ok(mut runtime) = self.runtime.lock() { *runtime = RuntimeState::default(); }
        self.emit_status();
        Ok(())
    }

    pub fn resolve_conflict(&self, conflict_id: &str, _resolution: &str) -> Result<ClientSyncStatus, String> {
        let mut runtime = self.runtime.lock().map_err(|_| "云同步状态锁损坏".to_string())?;
        let before = runtime.status.conflicts.len();
        runtime.status.conflicts.retain(|conflict| conflict.id != conflict_id);
        if before == runtime.status.conflicts.len() { return Err("未找到待处理冲突，请刷新后重试".into()); }
        runtime.status.status = if runtime.status.conflicts.is_empty() { "idle" } else { "conflict" }.into();
        let status = runtime.status.clone();
        drop(runtime);
        self.emit_status();
        Ok(status)
    }

    pub fn start_background(manager: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(STARTUP_DELAY).await;
            loop {
                if manager.user_context().is_ok() && manager.vault_key().is_ok() { let _ = manager.sync_now().await; }
                tokio::select! { _ = manager.wake.notified() => tokio::time::sleep(DIRTY_DEBOUNCE).await, _ = tokio::time::sleep(PERIODIC_INTERVAL) => {} }
            }
        });
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialSecretV1 { schema_version: u32, credential_id: String, secret_type: String, secret: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NoteIndexRecordBaseline { path: String, entry_type: NoteEntryType }

#[derive(Clone)]
struct PreparedMutation { request: MutationRequest, local_hash: Option<String> }

fn prepared_delete(entity_type: &str, entity_id: &str, version: i64) -> PreparedMutation {
    PreparedMutation { request: MutationRequest { mutation_id: Uuid::new_v4().to_string(), entity_type: entity_type.into(), entity_id: entity_id.into(), operation: "delete".into(), base_version: version, payload_schema_version: None, ciphertext: None, blob_id: None, encryption_meta: None, ciphertext_sha256: None }, local_hash: None }
}

fn put_envelope_request(base_revision: i64, material: &KeyEnvelopeMaterial) -> PutKeyEnvelopeRequest {
    PutKeyEnvelopeRequest { base_revision, algorithm: material.algorithm.clone(), kdf: material.kdf.clone(), kdf_params: super::protocol::KeyEnvelopeKdfParams { memory_kib: material.kdf_params.memory_kib as i64, iterations: material.kdf_params.iterations as i64, parallelism: material.kdf_params.parallelism as i64 }, salt: material.salt.clone(), nonce: material.nonce.clone(), ciphertext: material.ciphertext.clone() }
}

fn envelope_material(envelope: &KeyEnvelope) -> Result<KeyEnvelopeMaterial, String> {
    let params: KdfParams = serde_json::from_value(envelope.kdf_params.clone()).map_err(|error| format!("云端 KDF 参数不合法: {error}"))?;
    Ok(KeyEnvelopeMaterial { algorithm: envelope.algorithm.clone(), kdf: envelope.kdf.clone(), kdf_params: params, salt: envelope.salt.clone(), nonce: envelope.nonce.clone(), ciphertext: envelope.ciphertext.clone() })
}

fn client_quota(quota: &SyncQuota) -> ClientQuota { ClientQuota { used_bytes: quota.sync_bytes_used, total_bytes: quota.sync_bytes_limit, backup_used_bytes: quota.backup_bytes_used, backup_total_bytes: quota.backup_bytes_limit } }
fn client_limits(limits: &SyncLimits, quota: &SyncQuota) -> ClientLimits { ClientLimits { max_batch_items: limits.max_batch_items, max_batch_bytes: limits.max_batch_bytes, inline_payload_bytes: limits.inline_payload_bytes, max_backup_bytes: limits.max_single_file_bytes, max_backup_files: quota.backup_object_limit, max_concurrent_backups: 0 } }
fn client_device(device: Device, current: Option<&str>) -> ClientDevice { ClientDevice { is_current: current == Some(device.id.as_str()), id: device.id, name: device.name, revoked: device.revoked, last_seen_at: Some(device.last_seen_at), created_at: Some(device.created_at) } }
fn entity_key(entity_type: &str, entity_id: &str) -> String { format!("{entity_type}:{entity_id}") }
fn validate_password(password: &str) -> Result<(), String> { if password.chars().count() < 8 { Err("云同步密码至少需要 8 个字符".into()) } else { Ok(()) } }
fn now_unix_ms() -> u64 { SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_millis() as u64).unwrap_or(0) }
fn now_rfc3339ish() -> String { format!("{}", SystemTime::now().duration_since(UNIX_EPOCH).map(|duration| duration.as_secs()).unwrap_or(0)) }
fn sync_error_text(error: ApiError) -> String { if error.code == "QUOTA_EXCEEDED" { "云端空间不足，请删除旧备份或数据后重试".into() } else { error.to_string() } }
