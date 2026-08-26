//! 云端用户数据 API 的线协议 DTO。
//!
//! 这里的字段直接对应 `internal/userdata` 的 Go 结构和响应对象；不要在
//! DTO 层加入客户端运行态字段或把 `null` 与缺省值混为一谈。

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type JsonValue = Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceRequest {
    pub installation_id: String,
    pub name: String,
    pub platform: String,
    pub app_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RegisterDeviceResponse {
    pub device_id: String,
    pub latest_cursor: i64,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDeviceRequest {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AckRequest {
    pub device_id: String,
    pub cursor: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AckResponse {
    pub device_id: String,
    pub last_ack_cursor: i64,
    pub latest_cursor: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub app_version: String,
    pub last_ack_cursor: i64,
    pub last_seen_at: String,
    pub revoked: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevicesResponse {
    pub devices: Vec<Device>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyEnvelopeKdfParams {
    // 服务端 Go 结构体 JSON tag 为 memoryKiB（大写 B），偏离 camelCase 惯例
    #[serde(rename = "memoryKiB")]
    pub memory_kib: i64,
    pub iterations: i64,
    pub parallelism: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PutKeyEnvelopeRequest {
    pub base_revision: i64,
    pub algorithm: String,
    pub kdf: String,
    pub kdf_params: KeyEnvelopeKdfParams,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyEnvelope {
    pub revision: i64,
    pub algorithm: String,
    pub kdf: String,
    pub kdf_params: JsonValue,
    pub salt: String,
    pub nonce: String,
    pub ciphertext: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KeyEnvelopeStatus {
    pub exists: bool,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncQuota {
    pub sync_bytes_used: i64,
    pub sync_bytes_limit: i64,
    pub backup_bytes_used: i64,
    pub backup_bytes_limit: i64,
    pub backup_object_count: i64,
    pub backup_object_limit: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncLimits {
    pub max_batch_items: i64,
    pub max_batch_bytes: i64,
    pub inline_payload_bytes: i64,
    pub upload_part_bytes: i64,
    pub max_single_file_bytes: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SyncStatus {
    pub enabled: bool,
    pub backup_enabled: bool,
    pub latest_cursor: i64,
    pub minimum_available_cursor: i64,
    pub key_envelope: KeyEnvelopeStatus,
    pub quota: SyncQuota,
    pub limits: SyncLimits,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SyncItem {
    pub cursor: Option<i64>,
    pub entity_type: String,
    pub entity_id: String,
    pub version: i64,
    pub operation: String,
    pub payload_schema_version: i64,
    pub ciphertext: Option<String>,
    pub blob_id: Option<String>,
    pub encryption_meta: JsonValue,
    pub ciphertext_sha256: Option<String>,
    pub ciphertext_size: i64,
    pub tombstone: bool,
    pub updated_by_device_id: Option<String>,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChangesResponse {
    pub changes: Vec<SyncItem>,
    pub next_cursor: i64,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotResponse {
    pub items: Vec<SyncItem>,
    pub next_page_token: Option<String>,
    pub has_more: bool,
    pub latest_cursor: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutationRequest {
    pub mutation_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub operation: String,
    pub base_version: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload_schema_version: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ciphertext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encryption_meta: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ciphertext_sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MutationsRequest {
    pub device_id: String,
    pub batch_id: String,
    pub mutations: Vec<MutationRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutationResult {
    pub mutation_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub operation: String,
    pub version: i64,
    pub cursor: i64,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MutationsResponse {
    pub results: Vec<MutationResult>,
    pub latest_cursor: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlobMetadata {
    pub size: i64,
    pub sha256: String,
}

pub type BlobStat = BlobMetadata;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateUploadRequest {
    pub device_id: String,
    pub request_id: String,
    pub purpose: String,
    pub ciphertext_size: i64,
    pub ciphertext_sha256: String,
    pub encryption_meta: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadPartRequest {
    pub part_number: i64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UploadPart {
    pub part_number: i64,
    pub size_bytes: i64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Upload {
    pub upload_id: String,
    pub status: String,
    pub part_size: i64,
    pub expires_at: String,
    pub uploaded_parts: Vec<UploadPart>,
    pub blob_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompleteUploadRequest {
    pub parts: Vec<UploadPartRequest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CreateBackupRequest {
    pub device_id: String,
    pub request_id: String,
    pub source_type: String,
    pub encrypted_display_name: String,
    pub root_meta: JsonValue,
    pub encryption_meta: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CompleteBackupRequest {
    pub manifest_blob_id: String,
    pub referenced_blob_ids: Vec<String>,
    pub file_count: i64,
    pub directory_count: i64,
    pub plain_bytes: i64,
    pub ciphertext_bytes: i64,
    pub manifest_ciphertext_sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    pub status: String,
    pub source_type: String,
    pub encrypted_display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root_meta: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub encryption_meta: Option<JsonValue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub manifest_blob_id: Option<String>,
    pub file_count: i64,
    pub directory_count: i64,
    pub plain_bytes: i64,
    pub ciphertext_bytes: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_hash: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deleted_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BackupPage {
    pub items: Vec<Backup>,
    pub page: i64,
    pub page_size: i64,
    pub total: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ApiErrorEnvelope {
    pub error: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<JsonValue>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn key_envelope_kdf_uses_server_memory_kib_capital_b() {
        let json = json!({
            "revision": 1,
            "algorithm": "xchacha20-poly1305",
            "kdf": "argon2id",
            "kdfParams": {"memoryKiB": 65536, "iterations": 3, "parallelism": 1},
            "salt": "YQ==",
            "nonce": "Yg==",
            "ciphertext": "Yw=="
        });
        let envelope: KeyEnvelope = serde_json::from_value(json).unwrap();
        let params: KeyEnvelopeKdfParams =
            serde_json::from_value(envelope.kdf_params).unwrap();
        assert_eq!(params.memory_kib, 65536);
        // 序列化回线上协议也必须是大写 B，否则服务端参数校验拒绝
        let value = serde_json::to_value(&params).unwrap();
        assert_eq!(value["memoryKiB"], 65536);
        assert!(value.get("memoryKib").is_none());
    }

    #[test]
    fn status_uses_server_camel_case_names() {
        let status = SyncStatus {
            enabled: true,
            backup_enabled: false,
            latest_cursor: 4,
            minimum_available_cursor: 2,
            key_envelope: KeyEnvelopeStatus {
                exists: true,
                revision: 3,
            },
            quota: SyncQuota {
                sync_bytes_used: 1,
                sync_bytes_limit: 2,
                backup_bytes_used: 3,
                backup_bytes_limit: 4,
                backup_object_count: 5,
                backup_object_limit: 6,
            },
            limits: SyncLimits {
                max_batch_items: 7,
                max_batch_bytes: 8,
                inline_payload_bytes: 9,
                upload_part_bytes: 10,
                max_single_file_bytes: 11,
            },
        };
        let value = serde_json::to_value(status).unwrap();
        assert_eq!(value["backupEnabled"], false);
        assert_eq!(value["minimumAvailableCursor"], 2);
        assert_eq!(value["limits"]["maxSingleFileBytes"], 11);
    }

    #[test]
    fn mutation_delete_omits_payload_fields() {
        let mutation = MutationRequest {
            mutation_id: "m".into(),
            entity_type: "note".into(),
            entity_id: "opaque".into(),
            operation: "delete".into(),
            base_version: 2,
            payload_schema_version: None,
            ciphertext: None,
            blob_id: None,
            encryption_meta: None,
            ciphertext_sha256: None,
        };
        let value = serde_json::to_value(mutation).unwrap();
        assert_eq!(
            value,
            json!({
                "mutationId": "m", "entityType": "note", "entityId": "opaque",
                "operation": "delete", "baseVersion": 2
            })
        );
    }

    #[test]
    fn nullable_sync_item_fields_round_trip() {
        let source = json!({
            "cursor": null, "entityType": "note", "entityId": "id", "version": 1,
            "operation": "delete", "payloadSchemaVersion": 1, "ciphertext": null,
            "blobId": null, "encryptionMeta": {}, "ciphertextSha256": null,
            "ciphertextSize": 0, "tombstone": true, "updatedByDeviceId": null,
            "updatedAt": "2026-08-26T00:00:00Z"
        });
        let item: SyncItem = serde_json::from_value(source.clone()).unwrap();
        assert!(item.cursor.is_none());
        assert!(item.ciphertext.is_none());
        assert_eq!(serde_json::to_value(item).unwrap(), source);
    }

    #[test]
    fn backup_page_matches_gin_shape() {
        let page: BackupPage = serde_json::from_value(json!({
            "items": [], "page": 1, "pageSize": 20, "total": 0
        }))
        .unwrap();
        assert_eq!(page.page_size, 20);
        assert_eq!(serde_json::to_value(page).unwrap()["pageSize"], 20);
    }

    #[test]
    fn error_details_are_optional_but_null_is_accepted() {
        let error: ApiErrorEnvelope = serde_json::from_value(json!({
            "error": "bad", "code": "INVALID_SYNC_PAYLOAD", "details": null
        }))
        .unwrap();
        assert!(error.details.is_none());
    }
}
