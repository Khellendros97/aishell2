//! 用户数据云同步 HTTP API。
//!
//! 对照 `E:\workspace\aishell-cloud\internal\server\router.go` 与
//! `docs/07-user-data-cloud-sync-requirements.md`：本文件只负责认证后的传输、
//! 路由和线协议编解码，不读取 Store 的状态，也不把 token 暴露给上层。
//! `Transport` 是同步引擎和测试 fake 的边界；生产环境使用 `ReqwestTransport`。

use async_trait::async_trait;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT, CONTENT_LENGTH, CONTENT_TYPE, RANGE,
};
use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use crate::cloud::CloudManager;
use crate::store::Store;

use super::protocol::{
    AckRequest, AckResponse, ApiErrorEnvelope, Backup, BackupPage, ChangesResponse,
    CompleteBackupRequest, CompleteUploadRequest, CreateBackupRequest, CreateUploadRequest, Device,
    DevicesResponse, KeyEnvelope, MutationsRequest, MutationsResponse, PutKeyEnvelopeRequest,
    RegisterDeviceRequest, RegisterDeviceResponse, SnapshotResponse, SyncItem, SyncStatus,
    UpdateDeviceRequest, Upload,
};

/// 统一的 HTTP 请求描述。header 名和值均不含认证信息，认证由 Transport 注入。
#[derive(Debug, Clone)]
pub struct TransportRequest {
    pub method: reqwest::Method,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

impl TransportRequest {
    pub fn new(method: reqwest::Method, path: impl Into<String>) -> Self {
        Self {
            method,
            path: path.into(),
            query: Vec::new(),
            headers: BTreeMap::new(),
            body: Vec::new(),
        }
    }

    pub fn query(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.query.push((key.into(), value.into()));
        self
    }

    pub fn header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(key.into(), value.into());
        self
    }
}

/// Transport 返回的最小响应，避免同步逻辑依赖 reqwest::Response，便于 fake 测试。
#[derive(Debug, Clone)]
pub struct TransportResponse {
    pub status: u16,
    pub headers: BTreeMap<String, String>,
    pub body: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct TransportFailure {
    pub message: String,
}

impl fmt::Display for TransportFailure {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for TransportFailure {}

/// 网络边界。fake 只需要实现该 trait，不会触及真实网络或 keyring。
#[async_trait]
pub trait Transport: Send + Sync {
    async fn send(&self, request: TransportRequest) -> Result<TransportResponse, TransportFailure>;
}

/// 获取 access token 的接口。它刻意独立于 cloud.rs 私有的 credentials/token 请求细节。
#[async_trait]
pub trait TokenSource: Send + Sync {
    async fn access_token(&self) -> Result<String, String>;
}

/// 复用现有 CloudManager 的有效 token/refresh 流程。
///
/// 这里不直接调用 cloud.rs 的私有函数；`valid_access_token` 已经负责内存缓存、
/// refresh_token 轮换和 keyring 更新，因此同步 API 与现有 OAuth 认证保持一致。
pub struct CloudTokenSource {
    cloud: Arc<CloudManager>,
    store: Arc<Store>,
}

impl CloudTokenSource {
    pub fn new(cloud: Arc<CloudManager>, store: Arc<Store>) -> Self {
        Self { cloud, store }
    }
}

#[async_trait]
impl TokenSource for CloudTokenSource {
    async fn access_token(&self) -> Result<String, String> {
        self.cloud.valid_access_token(&self.store).await
    }
}

/// reqwest 生产传输实现。所有云同步路由都从 `/api` 或 `/api/storage` 开始。
pub struct ReqwestTransport {
    client: reqwest::Client,
    base_url: String,
    token_source: Arc<dyn TokenSource>,
}

impl ReqwestTransport {
    pub fn new(
        base_url: impl Into<String>,
        token_source: Arc<dyn TokenSource>,
    ) -> Result<Self, String> {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        if base_url.is_empty() {
            return Err("云服务地址不能为空".to_string());
        }
        let client = reqwest::Client::builder()
            .build()
            .map_err(|e| format!("创建云同步 HTTP 客户端失败: {e}"))?;
        Ok(Self {
            client,
            base_url,
            token_source,
        })
    }

    /// 用现有 cloud.rs 的编译期服务器地址构造生产 Transport。
    pub fn from_cloud(cloud: Arc<CloudManager>, store: Arc<Store>) -> Result<Self, String> {
        let base =
            crate::cloud::server_url().ok_or_else(|| "当前构建未配置云服务地址".to_string())?;
        Self::new(base, Arc::new(CloudTokenSource::new(cloud, store)))
    }
}

#[async_trait]
impl Transport for ReqwestTransport {
    async fn send(&self, request: TransportRequest) -> Result<TransportResponse, TransportFailure> {
        let token = self
            .token_source
            .access_token()
            .await
            .map_err(|message| TransportFailure { message })?;
        let url = format!("{}{}", self.base_url, normalize_path(&request.path));
        let mut builder = self.client.request(request.method, url).bearer_auth(token);
        if !request.query.is_empty() {
            builder = builder.query(&request.query);
        }
        let mut headers = HeaderMap::new();
        for (name, value) in request.headers {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|e| TransportFailure {
                message: format!("同步请求 header 名不合法: {e}"),
            })?;
            let value = HeaderValue::from_str(&value).map_err(|e| TransportFailure {
                message: format!("同步请求 header 值不合法: {e}"),
            })?;
            headers.insert(name, value);
        }
        builder = builder.headers(headers);
        if !request.body.is_empty() {
            builder = builder.body(request.body);
        }
        let response = builder.send().await.map_err(|e| TransportFailure {
            message: format!("连接云平台失败: {e}"),
        })?;
        let status = response.status().as_u16();
        let mut response_headers = BTreeMap::new();
        for (name, value) in response.headers() {
            if let Ok(value) = value.to_str() {
                response_headers.insert(name.as_str().to_ascii_lowercase(), value.to_string());
            }
        }
        let body = response
            .bytes()
            .await
            .map_err(|e| TransportFailure {
                message: format!("读取云平台响应失败: {e}"),
            })?
            .to_vec();
        Ok(TransportResponse {
            status,
            headers: response_headers,
            body,
        })
    }
}

fn normalize_path(path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        format!("/{path}")
    }
}

/// 结构化错误：与 Go `APIError` 的 `error/code/details` 对齐，并保留 Retry-After。
#[derive(Debug, Clone, PartialEq)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub details: Option<Value>,
    pub retry_after: Option<Duration>,
}

impl ApiError {
    pub fn new(status: u16, code: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.into(),
            message: message.into(),
            details: None,
            retry_after: None,
        }
    }

    pub fn transport(message: impl Into<String>) -> Self {
        Self::new(0, "NETWORK_ERROR", message)
    }

    pub fn is_status(&self, status: u16) -> bool {
        self.status == status
    }

    pub fn retryable(&self) -> bool {
        self.status == 408 || self.status == 425 || self.status == 429 || self.status >= 500
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.code.is_empty() {
            write!(f, "{}", self.message)
        } else {
            write!(f, "{}: {}", self.code, self.message)
        }
    }
}

impl std::error::Error for ApiError {}

pub type ApiResult<T> = Result<T, ApiError>;

/// 高层同步 API。所有请求均通过 Transport，故 engine 单测可以完全使用 fake。
pub struct SyncApi<T> {
    transport: T,
}

impl<T> SyncApi<T> {
    pub fn new(transport: T) -> Self {
        Self { transport }
    }

    pub fn transport(&self) -> &T {
        &self.transport
    }
}

impl<T: Transport> SyncApi<T> {
    async fn send_json<R: DeserializeOwned>(&self, request: TransportRequest) -> ApiResult<R> {
        let response = self
            .transport
            .send(request)
            .await
            .map_err(|e| ApiError::transport(e.message))?;
        decode_json_response(response)
    }

    async fn send_empty(&self, request: TransportRequest) -> ApiResult<()> {
        let response = self
            .transport
            .send(request)
            .await
            .map_err(|e| ApiError::transport(e.message))?;
        ensure_success(&response)?;
        Ok(())
    }

    async fn send_raw(&self, request: TransportRequest) -> ApiResult<TransportResponse> {
        let response = self
            .transport
            .send(request)
            .await
            .map_err(|e| ApiError::transport(e.message))?;
        ensure_success(&response)?;
        Ok(response)
    }

    pub async fn register_device(
        &self,
        body: &RegisterDeviceRequest,
    ) -> ApiResult<RegisterDeviceResponse> {
        self.send_json(json_request(
            reqwest::Method::POST,
            "/api/sync/devices/register",
            body,
        )?)
        .await
    }

    pub async fn devices(&self) -> ApiResult<Vec<Device>> {
        let response: DevicesResponse = self
            .send_json(TransportRequest::new(
                reqwest::Method::GET,
                "/api/sync/devices",
            ))
            .await?;
        Ok(response.devices)
    }

    pub async fn update_device(
        &self,
        device_id: &str,
        body: &UpdateDeviceRequest,
    ) -> ApiResult<Device> {
        let path = format!("/api/sync/devices/{}", encode_path_segment(device_id));
        self.send_json(json_request(reqwest::Method::PATCH, path, body)?)
            .await
    }

    pub async fn revoke_device(&self, device_id: &str) -> ApiResult<()> {
        let path = format!("/api/sync/devices/{}", encode_path_segment(device_id));
        self.send_empty(TransportRequest::new(reqwest::Method::DELETE, path))
            .await
    }

    pub async fn status(&self) -> ApiResult<SyncStatus> {
        self.send_json(TransportRequest::new(
            reqwest::Method::GET,
            "/api/sync/status",
        ))
        .await
    }

    pub async fn key_envelope(&self) -> ApiResult<KeyEnvelope> {
        self.send_json(TransportRequest::new(
            reqwest::Method::GET,
            "/api/sync/key-envelope",
        ))
        .await
    }

    pub async fn put_key_envelope(&self, body: &PutKeyEnvelopeRequest) -> ApiResult<KeyEnvelope> {
        self.send_json(json_request(
            reqwest::Method::PUT,
            "/api/sync/key-envelope",
            body,
        )?)
        .await
    }

    pub async fn ack(&self, body: &AckRequest) -> ApiResult<AckResponse> {
        self.send_json(json_request(reqwest::Method::POST, "/api/sync/ack", body)?)
            .await
    }

    pub async fn changes(&self, after: i64, limit: usize) -> ApiResult<ChangesResponse> {
        let request = TransportRequest::new(reqwest::Method::GET, "/api/sync/changes")
            .query("after", after.to_string())
            .query("limit", limit.to_string());
        self.send_json(request).await
    }

    pub async fn snapshot(
        &self,
        page_token: Option<&str>,
        limit: usize,
    ) -> ApiResult<SnapshotResponse> {
        let mut request = TransportRequest::new(reqwest::Method::GET, "/api/sync/snapshot")
            .query("limit", limit.to_string());
        if let Some(token) = page_token {
            request = request.query("pageToken", token.to_string());
        }
        self.send_json(request).await
    }

    pub async fn item(&self, entity_type: &str, entity_id: &str) -> ApiResult<SyncItem> {
        let path = format!(
            "/api/sync/items/{}/{}",
            encode_path_segment(entity_type),
            encode_path_segment(entity_id)
        );
        self.send_json(TransportRequest::new(reqwest::Method::GET, path))
            .await
    }

    pub async fn mutations(&self, body: &MutationsRequest) -> ApiResult<MutationsResponse> {
        self.send_json(json_request(
            reqwest::Method::POST,
            "/api/sync/mutations",
            body,
        )?)
        .await
    }

    pub async fn create_upload(&self, body: &CreateUploadRequest) -> ApiResult<Upload> {
        self.send_json(json_request(
            reqwest::Method::POST,
            "/api/storage/uploads",
            body,
        )?)
        .await
    }

    pub async fn upload_status(&self, upload_id: &str) -> ApiResult<Upload> {
        let path = format!("/api/storage/uploads/{}", encode_path_segment(upload_id));
        self.send_json(TransportRequest::new(reqwest::Method::GET, path))
            .await
    }

    /// 二进制密文分片 PUT；Content-Length 与 X-Part-SHA256 是服务端校验必需字段。
    pub async fn put_upload_part(
        &self,
        upload_id: &str,
        part_number: u32,
        bytes: &[u8],
        sha256: &str,
    ) -> ApiResult<Upload> {
        let path = format!(
            "/api/storage/uploads/{}/parts/{part_number}",
            encode_path_segment(upload_id)
        );
        let request = TransportRequest::new(reqwest::Method::PUT, path)
            .header(CONTENT_TYPE.as_str(), "application/octet-stream")
            .header(CONTENT_LENGTH.as_str(), bytes.len().to_string())
            .header("X-Part-SHA256", sha256.to_string());
        let request = TransportRequest {
            body: bytes.to_vec(),
            ..request
        };
        // Go 服务端返回 {"part": {...}}，兼容未来直接返回 UploadPart。
        let response = self.send_raw(request).await?;
        let value: Value = parse_json_body(&response.body)?;
        if let Some(part) = value.get("part") {
            serde_json::from_value(part.clone()).map_err(|e| {
                ApiError::new(
                    response.status,
                    "INVALID_RESPONSE",
                    format!("解析上传分片响应失败: {e}"),
                )
            })
        } else {
            serde_json::from_value(value).map_err(|e| {
                ApiError::new(
                    response.status,
                    "INVALID_RESPONSE",
                    format!("解析上传分片响应失败: {e}"),
                )
            })
        }
        .map(|part: super::protocol::UploadPart| Upload {
            upload_id: upload_id.to_string(),
            status: "uploading".to_string(),
            part_size: 0,
            expires_at: String::new(),
            uploaded_parts: vec![part],
            blob_id: None,
        })
    }

    pub async fn complete_upload(
        &self,
        upload_id: &str,
        body: &CompleteUploadRequest,
    ) -> ApiResult<Upload> {
        let path = format!(
            "/api/storage/uploads/{}/complete",
            encode_path_segment(upload_id)
        );
        self.send_json(json_request(reqwest::Method::POST, path, body)?)
            .await
    }

    pub async fn cancel_upload(&self, upload_id: &str) -> ApiResult<()> {
        let path = format!("/api/storage/uploads/{}", encode_path_segment(upload_id));
        self.send_empty(TransportRequest::new(reqwest::Method::DELETE, path))
            .await
    }

    pub async fn create_backup(&self, body: &CreateBackupRequest) -> ApiResult<Backup> {
        self.send_json(json_request(reqwest::Method::POST, "/api/backups", body)?)
            .await
    }

    pub async fn backups(&self, page: usize, page_size: usize) -> ApiResult<BackupPage> {
        let request = TransportRequest::new(reqwest::Method::GET, "/api/backups")
            .query("page", page.to_string())
            .query("pageSize", page_size.to_string());
        self.send_json(request).await
    }

    pub async fn backup(&self, backup_id: &str) -> ApiResult<Backup> {
        let path = format!("/api/backups/{}", encode_path_segment(backup_id));
        self.send_json(TransportRequest::new(reqwest::Method::GET, path))
            .await
    }

    pub async fn complete_backup(
        &self,
        backup_id: &str,
        body: &CompleteBackupRequest,
    ) -> ApiResult<Backup> {
        let path = format!("/api/backups/{}/complete", encode_path_segment(backup_id));
        self.send_json(json_request(reqwest::Method::POST, path, body)?)
            .await
    }

    pub async fn delete_backup(&self, backup_id: &str) -> ApiResult<()> {
        let path = format!("/api/backups/{}", encode_path_segment(backup_id));
        self.send_empty(TransportRequest::new(reqwest::Method::DELETE, path))
            .await
    }

    pub async fn delete_all_data(&self) -> ApiResult<()> {
        let request = TransportRequest::new(reqwest::Method::DELETE, "/api/sync/data")
            .header("X-AIShell-Confirm-Delete", "DELETE_ALL_CLOUD_DATA");
        self.send_empty(request).await
    }

    /// 支持 Range 与 If-None-Match；服务端以 206/304 语义返回，304 映射为空响应。
    pub async fn download_blob(
        &self,
        blob_id: &str,
        range: Option<(u64, Option<u64>)>,
        if_none_match: Option<&str>,
    ) -> ApiResult<BlobDownload> {
        let path = format!("/api/storage/blobs/{}", encode_path_segment(blob_id));
        let mut request = TransportRequest::new(reqwest::Method::GET, path)
            .header(ACCEPT.as_str(), "application/octet-stream");
        if let Some((start, end)) = range {
            let value = match end {
                Some(end) => format!("bytes={start}-{end}"),
                None => format!("bytes={start}-"),
            };
            request = request.header(RANGE.as_str(), value);
        }
        if let Some(etag) = if_none_match {
            request = request.header("If-None-Match", etag);
        }
        let response = self
            .transport
            .send(request)
            .await
            .map_err(|e| ApiError::transport(e.message))?;
        if response.status == 304 {
            return Ok(BlobDownload {
                status: response.status,
                etag: header(&response, "etag"),
                content_range: header(&response, "content-range"),
                bytes: Vec::new(),
            });
        }
        ensure_success(&response)?;
        Ok(BlobDownload {
            status: response.status,
            etag: header(&response, "etag"),
            content_range: header(&response, "content-range"),
            bytes: response.body,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BlobDownload {
    pub status: u16,
    pub etag: Option<String>,
    pub content_range: Option<String>,
    pub bytes: Vec<u8>,
}

fn json_request<T: Serialize>(
    method: reqwest::Method,
    path: impl Into<String>,
    body: &T,
) -> ApiResult<TransportRequest> {
    let body = serde_json::to_vec(body)
        .map_err(|e| ApiError::new(0, "INVALID_REQUEST", format!("编码同步请求失败: {e}")))?;
    Ok(TransportRequest::new(method, path)
        .header(CONTENT_TYPE.as_str(), "application/json")
        .header(CONTENT_LENGTH.as_str(), body.len().to_string())
        .with_body(body))
}

impl TransportRequest {
    fn with_body(mut self, body: Vec<u8>) -> Self {
        self.body = body;
        self
    }
}

fn ensure_success(response: &TransportResponse) -> ApiResult<()> {
    if (200..300).contains(&response.status) {
        return Ok(());
    }
    Err(api_error_from_response(response))
}

fn decode_json_response<R: DeserializeOwned>(response: TransportResponse) -> ApiResult<R> {
    ensure_success(&response)?;
    let value = parse_json_body(&response.body)?;
    serde_json::from_value(value).map_err(|e| {
        ApiError::new(
            response.status,
            "INVALID_RESPONSE",
            format!("解析云同步响应失败: {e}"),
        )
    })
}

fn parse_json_body(body: &[u8]) -> ApiResult<Value> {
    if body.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(body).map_err(|e| {
        ApiError::new(
            0,
            "INVALID_RESPONSE",
            format!("云同步响应不是合法 JSON: {e}"),
        )
    })
}

fn api_error_from_response(response: &TransportResponse) -> ApiError {
    let mut error = match serde_json::from_slice::<ApiErrorEnvelope>(&response.body) {
        Ok(envelope) => ApiError {
            status: response.status,
            code: envelope.code,
            message: envelope.error,
            details: envelope.details,
            retry_after: None,
        },
        Err(_) => {
            let text = String::from_utf8_lossy(&response.body).trim().to_string();
            ApiError::new(
                response.status,
                default_code(response.status),
                if text.is_empty() {
                    default_message(response.status).to_string()
                } else {
                    text.chars().take(512).collect()
                },
            )
        }
    };
    error.retry_after = header(response, "retry-after")
        .and_then(|value| value.trim().parse::<u64>().ok().map(Duration::from_secs));
    error
}

fn header(response: &TransportResponse, name: &str) -> Option<String> {
    response
        .headers
        .iter()
        .find(|(key, _)| key.eq_ignore_ascii_case(name))
        .map(|(_, value)| value.clone())
}

fn default_code(status: u16) -> &'static str {
    match status {
        401 => "UNAUTHORIZED",
        403 => "SYNC_NOT_ENABLED",
        404 => "SYNC_ITEM_NOT_FOUND",
        409 => "SYNC_CONFLICT",
        410 => "SYNC_CURSOR_EXPIRED",
        413 => "ITEM_TOO_LARGE",
        429 => "RATE_LIMITED",
        500..=599 => "STORAGE_UNAVAILABLE",
        _ => "INVALID_SYNC_PAYLOAD",
    }
}

fn default_message(status: u16) -> &'static str {
    match status {
        401 => "登录已失效，请重新登录后重试",
        403 => "云同步尚未开启，请在设置中开启后重试",
        404 => "同步项不存在或无权访问，请刷新后重试",
        409 => "该数据已在另一台设备修改，请先同步最新版本",
        410 => "同步游标已过期，请重新获取完整快照",
        413 => "同步项过大，请改用分片上传后重试",
        429 => "请求过于频繁，请稍后重试",
        500..=599 => "云端服务暂不可用，请稍后重试",
        _ => "同步请求不合法，请检查后重试",
    }
}

/// URL 路径段编码。entity id 通常是 base64url，但该函数也保护普通字符串。
fn encode_path_segment(value: &str) -> String {
    percent_encoding::utf8_percent_encode(value, percent_encoding::NON_ALPHANUMERIC).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::VecDeque;
    use tokio::sync::Mutex;

    struct FakeTransport {
        responses: Mutex<VecDeque<TransportResponse>>,
        requests: Mutex<Vec<TransportRequest>>,
    }

    #[async_trait]
    impl Transport for FakeTransport {
        async fn send(
            &self,
            request: TransportRequest,
        ) -> Result<TransportResponse, TransportFailure> {
            self.requests.lock().await.push(request);
            self.responses
                .lock()
                .await
                .pop_front()
                .ok_or(TransportFailure {
                    message: "fake response exhausted".to_string(),
                })
        }
    }

    fn response(status: u16, body: Value) -> TransportResponse {
        TransportResponse {
            status,
            headers: BTreeMap::new(),
            body: serde_json::to_vec(&body).unwrap(),
        }
    }

    #[tokio::test]
    async fn changes_uses_server_route_and_query() {
        let fake = FakeTransport {
            responses: Mutex::new(VecDeque::from([response(
                200,
                json!({"changes": [], "nextCursor": 7, "hasMore": false}),
            )])),
            requests: Mutex::new(Vec::new()),
        };
        let api = SyncApi::new(fake);
        let page = api.changes(4, 20).await.unwrap();
        assert_eq!(page.next_cursor, 7);
        let request = api.transport().requests.lock().await[0].clone();
        assert_eq!(request.path, "/api/sync/changes");
        assert_eq!(
            request.query,
            vec![("after".into(), "4".into()), ("limit".into(), "20".into())]
        );
    }

    #[tokio::test]
    async fn parses_structured_error_and_retry_after() {
        let mut headers = BTreeMap::new();
        headers.insert("retry-after".to_string(), "3".to_string());
        let fake = FakeTransport {
            responses: Mutex::new(VecDeque::from([TransportResponse {
                status: 429,
                headers,
                body: serde_json::to_vec(&json!({
                    "error": "请求过于频繁，请稍后重试",
                    "code": "RATE_LIMITED",
                    "details": {"limit": 2}
                }))
                .unwrap(),
            }])),
            requests: Mutex::new(Vec::new()),
        };
        let err = SyncApi::new(fake).changes(0, 20).await.unwrap_err();
        assert_eq!(err.code, "RATE_LIMITED");
        assert_eq!(err.details, Some(json!({"limit": 2})));
        assert_eq!(err.retry_after, Some(Duration::from_secs(3)));
        assert!(err.retryable());
    }

    #[tokio::test]
    async fn upload_part_sets_binary_headers_and_body() {
        let fake = FakeTransport {
            responses: Mutex::new(VecDeque::from([response(
                200,
                json!({"part": {"partNumber": 1, "sizeBytes": 2, "sha256": "aa"}}),
            )])),
            requests: Mutex::new(Vec::new()),
        };
        let api = SyncApi::new(fake);
        let part = api.put_upload_part("upl_1", 1, b"ab", "aa").await.unwrap();
        assert_eq!(part.uploaded_parts[0].size_bytes, 2);
        let request = api.transport().requests.lock().await[0].clone();
        assert_eq!(request.method, reqwest::Method::PUT);
        assert_eq!(request.headers.get("content-length").or_else(|| request.headers.get("Content-Length")).map(String::as_str), Some("2"));
        assert_eq!(request.headers.get("X-Part-SHA256").map(String::as_str), Some("aa"));
        assert_eq!(request.body, b"ab");
    }

    #[tokio::test]
    async fn download_blob_sets_range_and_if_none_match() {
        let fake = FakeTransport {
            responses: Mutex::new(VecDeque::from([TransportResponse {
                status: 206,
                headers: BTreeMap::from([
                    ("etag".to_string(), "\"abc\"".to_string()),
                    ("content-range".to_string(), "bytes 2-4/8".to_string()),
                ]),
                body: b"345".to_vec(),
            }])),
            requests: Mutex::new(Vec::new()),
        };
        let api = SyncApi::new(fake);
        let blob = api
            .download_blob("blob_1", Some((2, Some(4))), Some("\"old\""))
            .await
            .unwrap();
        assert_eq!(blob.bytes, b"345");
        let request = api.transport().requests.lock().await[0].clone();
        assert_eq!(request.headers.get("range").or_else(|| request.headers.get("Range")).map(String::as_str), Some("bytes=2-4"));
        assert_eq!(request.headers.get("If-None-Match").map(String::as_str), Some("\"old\""));
    }
}
