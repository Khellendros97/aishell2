//! 云同步分页、快照和 ACK 状态机。

use async_trait::async_trait;

use super::api::{ApiError, ApiResult, SyncApi, Transport};
use super::protocol::{AckRequest, ChangesResponse, SnapshotResponse, SyncItem};

const DEFAULT_PAGE_SIZE: usize = 100;
const MAX_SNAPSHOT_RESTARTS: usize = 3;

#[async_trait]
pub trait SyncRemote: Send + Sync {
    async fn changes(&self, after: i64, limit: usize) -> ApiResult<ChangesResponse>;
    async fn snapshot(
        &self,
        page_token: Option<&str>,
        limit: usize,
    ) -> ApiResult<SnapshotResponse>;
    async fn ack(&self, request: &AckRequest) -> ApiResult<()>;
}

#[async_trait]
impl<T: Transport> SyncRemote for SyncApi<T> {
    async fn changes(&self, after: i64, limit: usize) -> ApiResult<ChangesResponse> {
        SyncApi::changes(self, after, limit).await
    }

    async fn snapshot(&self, page_token: Option<&str>, limit: usize) -> ApiResult<SnapshotResponse> {
        SyncApi::snapshot(self, page_token, limit).await
    }

    async fn ack(&self, request: &AckRequest) -> ApiResult<()> {
        SyncApi::ack(self, request).await.map(|_| ())
    }
}

#[async_trait]
pub trait ChangeApplier: Send + Sync {
    /// 一页必须整体完成后才能返回；失败时调用方不会 ACK 本页游标。
    async fn apply_page(&self, items: &[SyncItem]) -> Result<(), String>;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PullOutcome {
    pub cursor: i64,
    pub used_snapshot: bool,
    pub applied_items: usize,
}

pub async fn pull_remote<R: SyncRemote, A: ChangeApplier>(
    remote: &R,
    applier: &A,
    device_id: &str,
    start_cursor: i64,
) -> Result<PullOutcome, String> {
    match pull_changes(remote, applier, device_id, start_cursor).await {
        Ok(outcome) => Ok(outcome),
        Err(error) if error.code == "SYNC_CURSOR_EXPIRED" || error.status == 410 => {
            pull_snapshot(remote, applier, device_id).await
        }
        Err(error) => Err(error.to_string()),
    }
}

async fn pull_changes<R: SyncRemote, A: ChangeApplier>(
    remote: &R,
    applier: &A,
    device_id: &str,
    start_cursor: i64,
) -> Result<PullOutcome, ApiError> {
    let mut cursor = start_cursor;
    let mut applied = 0usize;
    loop {
        let page = remote.changes(cursor, DEFAULT_PAGE_SIZE).await?;
        applier
            .apply_page(&page.changes)
            .await
            .map_err(|message| ApiError::new(0, "LOCAL_APPLY_FAILED", message))?;
        cursor = page.next_cursor;
        applied += page.changes.len();
        remote
            .ack(&AckRequest {
                device_id: device_id.to_string(),
                cursor,
            })
            .await?;
        if !page.has_more {
            return Ok(PullOutcome {
                cursor,
                used_snapshot: false,
                applied_items: applied,
            });
        }
    }
}

async fn pull_snapshot<R: SyncRemote, A: ChangeApplier>(
    remote: &R,
    applier: &A,
    device_id: &str,
) -> Result<PullOutcome, String> {
    for _ in 0..MAX_SNAPSHOT_RESTARTS {
        let mut token: Option<String> = None;
        let mut all = Vec::new();
        let mut latest_cursor = 0;
        let mut restart = false;
        loop {
            match remote.snapshot(token.as_deref(), DEFAULT_PAGE_SIZE).await {
                Ok(page) => {
                    latest_cursor = page.latest_cursor;
                    all.extend(page.items);
                    if !page.has_more {
                        break;
                    }
                    token = page.next_page_token;
                    if token.is_none() {
                        return Err("云端快照分页缺少 nextPageToken，请稍后重试".to_string());
                    }
                }
                Err(error) if error.code == "SYNC_CONFLICT" || error.status == 409 => {
                    restart = true;
                    break;
                }
                Err(error) => return Err(error.to_string()),
            }
        }
        if restart {
            continue;
        }
        applier.apply_page(&all).await?;
        remote
            .ack(&AckRequest {
                device_id: device_id.to_string(),
                cursor: latest_cursor,
            })
            .await
            .map_err(|error| error.to_string())?;
        return Ok(PullOutcome {
            cursor: latest_cursor,
            used_snapshot: true,
            applied_items: all.len(),
        });
    }
    Err("云端数据持续变化，无法取得一致快照，请稍后重试".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;
    use std::sync::Mutex;

    struct FakeRemote {
        changes: Mutex<VecDeque<ApiResult<ChangesResponse>>>,
        snapshots: Mutex<VecDeque<ApiResult<SnapshotResponse>>>,
        acks: Mutex<Vec<i64>>,
    }

    #[async_trait]
    impl SyncRemote for FakeRemote {
        async fn changes(&self, _after: i64, _limit: usize) -> ApiResult<ChangesResponse> {
            self.changes.lock().unwrap().pop_front().unwrap()
        }
        async fn snapshot(&self, _token: Option<&str>, _limit: usize) -> ApiResult<SnapshotResponse> {
            self.snapshots.lock().unwrap().pop_front().unwrap()
        }
        async fn ack(&self, request: &AckRequest) -> ApiResult<()> {
            self.acks.lock().unwrap().push(request.cursor);
            Ok(())
        }
    }

    struct FakeApplier {
        pages: Mutex<Vec<usize>>,
    }

    #[async_trait]
    impl ChangeApplier for FakeApplier {
        async fn apply_page(&self, items: &[SyncItem]) -> Result<(), String> {
            self.pages.lock().unwrap().push(items.len());
            Ok(())
        }
    }

    #[tokio::test]
    async fn page_is_applied_before_ack() {
        let remote = FakeRemote {
            changes: Mutex::new(VecDeque::from([Ok(ChangesResponse {
                changes: vec![],
                next_cursor: 7,
                has_more: false,
            })])),
            snapshots: Mutex::new(VecDeque::new()),
            acks: Mutex::new(Vec::new()),
        };
        let applier = FakeApplier { pages: Mutex::new(Vec::new()) };
        let result = pull_remote(&remote, &applier, "dev", 2).await.unwrap();
        assert_eq!(result.cursor, 7);
        assert_eq!(*remote.acks.lock().unwrap(), vec![7]);
        assert_eq!(*applier.pages.lock().unwrap(), vec![0]);
    }

    #[tokio::test]
    async fn expired_cursor_falls_back_to_snapshot() {
        let remote = FakeRemote {
            changes: Mutex::new(VecDeque::from([Err(ApiError::new(410, "SYNC_CURSOR_EXPIRED", "expired"))])),
            snapshots: Mutex::new(VecDeque::from([Ok(SnapshotResponse {
                items: vec![],
                next_page_token: None,
                has_more: false,
                latest_cursor: 9,
            })])),
            acks: Mutex::new(Vec::new()),
        };
        let applier = FakeApplier { pages: Mutex::new(Vec::new()) };
        let result = pull_remote(&remote, &applier, "dev", 0).await.unwrap();
        assert!(result.used_snapshot);
        assert_eq!(result.cursor, 9);
    }
}
