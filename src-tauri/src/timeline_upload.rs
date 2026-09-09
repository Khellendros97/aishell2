//! 时间线云同步上传器：把本地项目时间线（timeline.rs 的 jsonl）脱敏后增量上传云端，
//! 供云平台「跨项目统一时间线」工作台页与管理后台页展示（协议见 docs/AIShell云服务-时间线云同步API文档.md）。
//!
//! 设计要点：
//! - **无内存队列**：事件最终都落在本地 jsonl（埋点主路径不受网络影响），上传器只是周期重读器——
//!   每 60s 按项目复合游标 `(lastTs, lastId)` 读待传条目批量上报。崩溃/断电零丢失，游标丢失
//!   最多浪费流量（服务端按 `(user_id, event_id)` 幂等去重兜底）。
//! - **开启条件（三层，全部满足才上传）**：已登录（keyring 有 refresh_token）&& 平台能力
//!   `capabilities.timelineSync`（重启/重登刷新）&& 本机设置 `timeline_sync_enabled`（默认开）。
//! - **回填**：游标缺省 (0, None) = 首次开启，从最早现存文件（本地保留 30 天）逐批补传，
//!   限速每 tick 每项目至多 2 批（批次打满才算回填，实时流量单批即止，不会触发限速）。
//! - **脱敏（上传侧，不改本地文件）**：summary/detail 过 redact 键值形态规则；detail 另截到
//!   4096 字素（云端上限）。脱敏是尽力而为的形态匹配，治理靠用户开关可关 + 云端保留期（90 天）。
//! - **事件 id**：新事件写入时已带 uuid v4（timeline.rs）；存量条目补算确定性 id
//!   `sha256(projectId + ts + kind + summary)` 前 32 hex——同一存量条目在任意设备算出同 id，
//!   多设备并行回填天然去重。
//! - **标签**：本地增删改后置脏标记（timeline.rs 打标命令调用 [`mark_tags_dirty`]），
//!   tick 时按项目 PUT 全量覆盖；项目首次回填成功后也推送一次基线。

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::timeline::TimelineEntry;

/// 上传周期（秒）：实时事件的最大上报延迟
const TICK_SECS: u64 = 60;
/// 单批事件条数（服务端上限 500）
const BATCH_EVENTS: usize = 500;
/// 回填限速：每 tick 每项目至多批数（API 文档 §2.3：回填每分钟至多 2 批）
const BACKFILL_BATCHES_PER_TICK: usize = 2;
/// 全局每 tick 批数上限：多项目同时回填时不触发服务端 30 批/分钟限流
const GLOBAL_BATCHES_PER_TICK: usize = 8;
/// 云端 detail 上限（服务端按 rune 计数）
const CLOUD_DETAIL_MAX_RUNES: usize = 4096;
/// 云端 summary 上限（服务端按 rune 计数）
const CLOUD_SUMMARY_MAX_RUNES: usize = 512;

/// 按 rune 裁剪到上限（含尾部标记占位）。本地 clip_graphemes 是字素口径且标记会追加在
/// 上限之外——两者都可能超出服务端的 rune 上限并导致整批 400，故上传侧单独按 rune 截断。
fn clip_runes(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    const MARK: &str = "…(已裁剪)";
    let keep = max.saturating_sub(MARK.chars().count());
    let mut out: String = s.chars().take(keep).collect();
    out.push_str(MARK);
    out
}

/// 水位状态文件（config_dir 下）：本机独立小文件，不进 aishell.json、不进云同步。
const STATE_FILE: &str = "timeline-sync-state.json";

/// 待同步标签的项目集合（timeline.rs 打标/删除/改闭合后置位，tick 消费后移除）。
static TAGS_DIRTY: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(|| Mutex::new(HashSet::new()));

/// 标记某项目的标签云端副本待同步。
pub fn mark_tags_dirty(project_id: &str) {
    if let Ok(mut set) = TAGS_DIRTY.lock() {
        set.insert(project_id.to_string());
    }
}

fn take_tags_dirty(project_id: &str) -> bool {
    TAGS_DIRTY
        .lock()
        .map(|mut s| s.remove(project_id))
        .unwrap_or(false)
}

/* ---------------- 水位状态（持久化） ---------------- */

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct ProjectSyncState {
    /// 已上传事件的最大 ts（含）；与 `last_id` 构成复合游标 `(last_ts, last_id)`
    last_ts: u64,
    /// 已上传末条事件的 id：同毫秒事件成组时仅靠 ts 无法前进，靠它跳过已传前缀
    last_id: Option<String>,
    /// 该项目标签是否已推送过基线（首次事件上传成功后置位）
    tags_uploaded: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct SyncState {
    /// 云端容量超限（413）后置位：暂停上报，用户删除云端时间线（purge 命令）后复位
    quota_exceeded: bool,
    projects: HashMap<String, ProjectSyncState>,
}

fn state_path(config_dir: &Path) -> PathBuf {
    config_dir.join(STATE_FILE)
}

fn load_state(config_dir: &Path) -> SyncState {
    std::fs::read_to_string(state_path(config_dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// 原子写：先 .tmp 再 rename（与 store.rs with_state 同约定）。
fn save_state(config_dir: &Path, state: &SyncState) -> Result<(), String> {
    let path = state_path(config_dir);
    let tmp = config_dir.join(".timeline-sync-state.tmp");
    let text = serde_json::to_string(state).map_err(|e| format!("序列化同步状态失败: {e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("写入同步状态失败: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("保存同步状态失败: {e}"))
}

/* ---------------- 资格判定 ---------------- */

/// 三层开关判定（API 文档 §1.1）：登录 && 能力开放 && 本机开关（默认开）。
fn eligible(store: &crate::store::Store) -> bool {
    if crate::cloud::server_url().is_none() {
        return false;
    }
    let (_, refresh) = store.cloud_tokens();
    if refresh.is_none() {
        return false;
    }
    if !store.settings().timeline_sync_enabled {
        return false;
    }
    let (_, caps) = store.cloud_profile();
    caps.is_some_and(|c| c.timeline_sync)
}

/* ---------------- 事件 id 与脱敏 ---------------- */

/// 单条事件的最终 id（timeline.rs 同源实现：存量条目按 sha256 补算）。
fn effective_event_id(project_id: &str, e: &TimelineEntry) -> String {
    crate::timeline::effective_event_id(project_id, e)
}

/// 单条事件 → 上报 JSON（脱敏 + detail 云端裁剪 + id 补算）。summary 为空的条目返回 None
/// （服务端要求 1..512，空串会连坐整批 400）。
fn event_payload(project_id: &str, e: &TimelineEntry) -> Option<serde_json::Value> {
    if e.summary.trim().is_empty() {
        return None;
    }
    let (summary, _) = crate::redact::redact_secrets(&e.summary, &[]);
    let summary = clip_runes(&summary, CLOUD_SUMMARY_MAX_RUNES);
    let detail = e.detail.as_ref().map(|d| {
        let (redacted, _) = crate::redact::redact_secrets(d, &[]);
        clip_runes(&redacted, CLOUD_DETAIL_MAX_RUNES)
    });
    Some(serde_json::json!({
        "id": effective_event_id(project_id, e),
        "ts": e.ts,
        "kind": e.kind,
        "summary": summary,
        "detail": detail,
    }))
}

/// 排查用设备标识（可选字段；取主机名，取不到留空省略）。
fn device_hint() -> Option<String> {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .filter(|s| !s.trim().is_empty())
}

/* ---------------- 上传响应分流 ---------------- */

/// 单批上报结果（按 API 文档 §7 错误码分流）。
#[derive(Debug)]
enum BatchOutcome {
    Accepted,
    /// 403 TIMELINE_NOT_ENABLED：能力缓存未刷新（重启/重登才刷新），终止 tick 直到资格翻转
    NotEnabled,
    /// 413 QUOTA_EXCEEDED：置持久标记暂停上报，待用户 purge 后复位
    QuotaExceeded,
    /// 429：本 tick 终止，下 tick 退避重试
    RateLimited,
    /// 400：`index` 为服务端 details.index（出错事件下标）；剔除后可整批重发
    InvalidBatch { index: Option<usize> },
    /// 网络/5xx 等传输失败：本 tick 终止，水位不动
    Failed(String),
}

fn parse_response_json(text: &str) -> Option<serde_json::Value> {
    serde_json::from_str(text.trim()).ok()
}

fn map_response(status: u16, text: &str) -> BatchOutcome {
    let body = parse_response_json(text);
    let code = body
        .as_ref()
        .and_then(|b| b.get("code"))
        .and_then(|c| c.as_str())
        .unwrap_or("")
        .to_string();
    match status {
        200..=299 => BatchOutcome::Accepted,
        403 if code == "TIMELINE_NOT_ENABLED" => BatchOutcome::NotEnabled,
        413 => BatchOutcome::QuotaExceeded,
        429 => BatchOutcome::RateLimited,
        400 if code == "INVALID_TIMELINE_PAYLOAD" => BatchOutcome::InvalidBatch {
            index: body
                .as_ref()
                .and_then(|b| b.get("details"))
                .and_then(|d| d.get("index"))
                .and_then(|i| i.as_u64())
                .map(|i| i as usize),
        },
        _ => {
            let msg = body
                .as_ref()
                .and_then(|b| b.get("error"))
                .and_then(|e| e.as_str())
                .unwrap_or("");
            BatchOutcome::Failed(format!("HTTP {status} {msg}").trim().to_string())
        }
    }
}

async fn post_events(
    cloud: &std::sync::Arc<crate::cloud::CloudManager>,
    store: &std::sync::Arc<crate::store::Store>,
    project_id: &str,
    project_name: &str,
    events: Vec<serde_json::Value>,
) -> Result<(u16, String), String> {
    // 项目名本地无长度限制，服务端限 128 字符且无 index 定位——不截断会让该项目整批永久被拒
    let name: String = project_name.chars().take(128).collect();
    let mut body = serde_json::json!({
        "projectId": project_id,
        "projectName": name,
        "events": events,
    });
    if let Some(hint) = device_hint() {
        body["deviceHint"] = serde_json::Value::String(hint);
    }
    crate::cloud::cloud_api_raw(
        cloud,
        store,
        reqwest::Method::POST,
        "/api/timeline/events",
        &[],
        Some(body),
    )
    .await
}

/* ---------------- 周期任务 ---------------- */

/// 启动上传器周期任务（lib.rs setup 调用；未登录/能力关闭时 tick 空转，开销为一次内存读）。
pub fn spawn_uploader(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 首个 tick 等启动刷新（refresh_on_startup 拉最新能力清单）完成后再跑
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            if let Err(e) = tick(&app).await {
                crate::term::diag(&format!("[timeline-upload] {e}"));
            }
            tokio::time::sleep(Duration::from_secs(TICK_SECS)).await;
        }
    });
}

async fn tick(app: &tauri::AppHandle) -> Result<(), String> {
    use std::sync::Arc;
    let store: Arc<crate::store::Store> = app.state::<Arc<crate::store::Store>>().inner().clone();
    let cloud: Arc<crate::cloud::CloudManager> =
        app.state::<Arc<crate::cloud::CloudManager>>().inner().clone();
    if !eligible(&store) {
        return Ok(());
    }
    if load_state(store.config_dir()).quota_exceeded {
        return Ok(());
    }
    // 保证最近 500ms 内写入的事件已落盘再读
    crate::timeline::flush_writer();

    let mut state = load_state(store.config_dir());
    let mut state_dirty = false;
    let mut batches_left = GLOBAL_BATCHES_PER_TICK;
    // Some = 终止整个 tick（能力关闭/限流/传输失败）；最终统一落盘后再返回
    let mut halt: Option<Result<(), String>> = None;

    'outer: for project in store.projects_all() {
        if batches_left == 0 {
            break;
        }
        let Some(project_path) = project.path else { continue };
        let dir = PathBuf::from(&project_path).join(".aishell").join("timeline");
        if !dir.is_dir() {
            continue;
        }
        // 取出本项目状态逐段修改（避免持有 map 借引用跨 state 其它字段写入）
        let mut pj = state.projects.remove(&project.id).unwrap_or_default();
        let mut pj_dirty = false;

        // 标签：脏标记（本地增删改）或首次基线 → PUT 全量覆盖
        let tags_dirty = take_tags_dirty(&project.id);
        if tags_dirty || !pj.tags_uploaded {
            match put_tags(&cloud, &store, &project.id, &dir).await {
                Ok(()) => {
                    pj.tags_uploaded = true;
                    pj_dirty = true;
                }
                Err(TickAbort::Quota) => {
                    state.quota_exceeded = true;
                    state_dirty = true;
                    break 'outer;
                }
                Err(TickAbort::Transient(e)) => {
                    halt = Some(Err(format!("标签上传失败（下 tick 重试）: {e}")));
                    break 'outer;
                }
                Err(TickAbort::Other(e)) => {
                    // 载荷类失败重试也不会好（如标签超上限），跳过不阻断事件上传；
                    // 未达基线的项目下 tick 会重试一次基线
                    crate::term::diag(&format!(
                        "[timeline-upload] 项目 {} 标签上传跳过: {e}",
                        project.id
                    ));
                    if tags_dirty {
                        mark_tags_dirty(&project.id);
                    }
                }
            }
        }

        // 事件：按水位增量批量上传；批次打满视为回填中，限每 tick 2 批
        let mut backfill_left = BACKFILL_BATCHES_PER_TICK;
        loop {
            if batches_left == 0 || backfill_left == 0 {
                break;
            }
            let entries = crate::timeline::read_entries_since(
                &dir,
                &project.id,
                pj.last_ts,
                pj.last_id.as_deref(),
                BATCH_EVENTS,
            );
            if entries.is_empty() {
                break;
            }
            let batch_max_ts = entries.last().map(|e| e.ts).unwrap_or(pj.last_ts);
            // 游标推进到本批末条 id（存量条目用补算 id，与上报载荷同源，否则游标无法前进）
            let batch_last_id = entries
                .last()
                .map(|e| effective_event_id(&project.id, e));
            let payloads: Vec<serde_json::Value> = entries
                .iter()
                .filter_map(|e| event_payload(&project.id, e))
                .collect();
            let outcome = if payloads.is_empty() {
                // 整批都是空 summary 等不可上报条目：推进水位防死循环
                BatchOutcome::Accepted
            } else {
                let (status, text) =
                    match post_events(&cloud, &store, &project.id, &project.name, payloads.clone())
                        .await
                    {
                        Ok(r) => r,
                        Err(e) => {
                            halt = Some(Err(format!("事件上传传输失败（下 tick 重试）: {e}")));
                            break 'outer;
                        }
                    };
                match map_response(status, &text) {
                    BatchOutcome::InvalidBatch { index: Some(i) } if i < payloads.len() => {
                        // 剔除出错事件整批重发一次（幂等，安全）；再失败走 InvalidBatch 放弃该批
                        let mut retry = payloads.clone();
                        retry.remove(i);
                        match post_events(&cloud, &store, &project.id, &project.name, retry).await
                        {
                            Ok((s2, t2)) => map_response(s2, &t2),
                            Err(e) => {
                                halt = Some(Err(format!(
                                    "事件上传传输失败（下 tick 重试）: {e}"
                                )));
                                break 'outer;
                            }
                        }
                    }
                    other => other,
                }
            };
            match outcome {
                BatchOutcome::Accepted => {
                    pj.last_ts = batch_max_ts;
                    if batch_last_id.is_some() {
                        pj.last_id = batch_last_id.clone();
                    }
                    pj_dirty = true;
                    batches_left -= 1;
                    // 批次没打满 = 已追平本地末尾（实时态），单批即止
                    if entries.len() < BATCH_EVENTS {
                        break;
                    }
                    backfill_left -= 1;
                }
                BatchOutcome::NotEnabled | BatchOutcome::RateLimited => {
                    halt = Some(Ok(()));
                    break 'outer;
                }
                BatchOutcome::QuotaExceeded => {
                    state.quota_exceeded = true;
                    state_dirty = true;
                    crate::term::diag(
                        "[timeline-upload] 云端时间线容量超限（413），已暂停上传；删除云端时间线后恢复",
                    );
                    break 'outer;
                }
                BatchOutcome::InvalidBatch { index } => {
                    // 无法定位坏事件或重试仍失败：放弃该批（推进游标防死循环），数据保留在本地
                    crate::term::diag(&format!(
                        "[timeline-upload] 项目 {} 事件批次被拒（index={index:?}），跳过该批",
                        project.id
                    ));
                    pj.last_ts = batch_max_ts;
                    if batch_last_id.is_some() {
                        pj.last_id = batch_last_id.clone();
                    }
                    pj_dirty = true;
                    break;
                }
                BatchOutcome::Failed(e) => {
                    halt = Some(Err(format!("事件上传失败（下 tick 重试）: {e}")));
                    break 'outer;
                }
            }
        }

        if pj_dirty {
            state_dirty = true;
        }
        state.projects.insert(project.id.clone(), pj);
    }

    if state_dirty {
        save_state(store.config_dir(), &state)?;
    }
    halt.unwrap_or(Ok(()))
}

/// 标签上传的失败分类：Quota（置位暂停）/ Transient（终止 tick）/ Other（跳过不阻断）。
enum TickAbort {
    Quota,
    Transient(String),
    Other(String),
}

/// 上传前标签净化：剔除服务端会整批拒绝的条目（返回净化结果与被剔除条数）。
/// 本地校验用字素裁剪，服务端用 rune 计数且限 9 类锚点——两侧口径差异必须在此吸收，
/// 否则单条非法标签会让该项目标签基线永远无法成功（每 tick 重试）。
fn sanitize_tags(tags: Vec<crate::timeline::TimelineTag>) -> (Vec<crate::timeline::TimelineTag>, usize) {
    const KINDS: [&str; 9] = [
        "ssh_connect",
        "ssh_disconnect",
        "ssh_connect_failed",
        "command",
        "file_upload",
        "file_download",
        "ai_user",
        "ai_assistant",
        "ai_tool",
    ];
    let before = tags.len();
    let kept = tags
        .into_iter()
        .filter(|t| {
            let name = t.name.trim();
            !name.is_empty()
                && name.chars().count() <= 64
                && t.color.len() == 7
                && t.color.starts_with('#')
                && t.color[1..].chars().all(|c| c.is_ascii_hexdigit())
                && KINDS.contains(&t.anchor_kind.as_str())
                && t.ts > 0
                && t.anchor_ts > 0
        })
        .collect::<Vec<_>>();
    let dropped = before - kept.len();
    (kept, dropped)
}

/// PUT 项目标签全集（全量覆盖语义；传空数组即清空该项目云端标签）。
async fn put_tags(
    cloud: &std::sync::Arc<crate::cloud::CloudManager>,
    store: &std::sync::Arc<crate::store::Store>,
    project_id: &str,
    dir: &Path,
) -> Result<(), TickAbort> {
    // project_id 是客户端 uuid；防御性拒绝会破坏 REST 路径的值
    if project_id.is_empty() || project_id.contains('/') {
        return Err(TickAbort::Other("项目 id 非法".into()));
    }
    let tags = crate::timeline::load_tags(dir);
    let (tags, dropped) = sanitize_tags(tags);
    if dropped > 0 {
        // 服务端整批拒绝语义下，个别不合法标签会连坐整个 PUT（且基线永不成功 → 每 tick 重试）；
        // 这里先剔除再上报，云端标签副本允许与本地有差异（事件上报不受影响）
        crate::term::diag(&format!(
            "[timeline-upload] 项目 {project_id} 有 {dropped} 条标签不满足云端校验，已跳过"
        ));
    }
    if tags.len() > 200 {
        return Err(TickAbort::Other(format!(
            "标签数量超上限（{}/200）",
            tags.len()
        )));
    }
    let path = format!("/api/timeline/projects/{project_id}/tags");
    let (status, text) = crate::cloud::cloud_api_raw(
        cloud,
        store,
        reqwest::Method::PUT,
        &path,
        &[],
        Some(serde_json::json!({ "tags": tags })),
    )
    .await
    .map_err(TickAbort::Transient)?;
    match map_response(status, &text) {
        BatchOutcome::Accepted => Ok(()),
        BatchOutcome::QuotaExceeded => Err(TickAbort::Quota),
        BatchOutcome::InvalidBatch { .. } => Err(TickAbort::Other(format!(
            "标签载荷被拒: HTTP {status} {text}"
        ))),
        BatchOutcome::Failed(e) => Err(TickAbort::Transient(e)),
        BatchOutcome::NotEnabled | BatchOutcome::RateLimited => {
            Err(TickAbort::Transient(format!("HTTP {status}")))
        }
    }
}

/* ---------------- 命令 ---------------- */

/// timeline_cloud_info 返回值（设置页「时间线云同步」区展示）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineCloudInfo {
    /// 三层开关是否全部满足（满足即会上传）
    pub eligible: bool,
    pub logged_in: bool,
    /// 平台是否开放 timelineSync 能力
    pub capability: bool,
    /// 本机「时间线云同步」开关
    pub setting_enabled: bool,
    /// 云端容量超限暂停中（413）；删除云端时间线后恢复
    pub quota_exceeded: bool,
}

/// 时间线云同步状态（设置页展示）。
#[tauri::command]
pub fn timeline_cloud_info(
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> TimelineCloudInfo {
    let logged_in = store.cloud_tokens().1.is_some();
    let setting_enabled = store.settings().timeline_sync_enabled;
    let (_, caps) = store.cloud_profile();
    let capability = caps.is_some_and(|c| c.timeline_sync);
    let quota_exceeded = load_state(store.config_dir()).quota_exceeded;
    TimelineCloudInfo {
        eligible: logged_in && setting_enabled && capability && crate::cloud::server_url().is_some(),
        logged_in,
        capability,
        setting_enabled,
        quota_exceeded,
    }
}

/// 删除本人全部云端时间线（事件 + 标签；服务端写审计）。本机时间线文件与水位不动——
/// 已上传过的事件（ts ≤ 水位）不会重传，删除后从新事件重新累积；同时复位容量超限标记。
#[tauri::command]
pub async fn timeline_cloud_purge(
    app: tauri::AppHandle,
    store: tauri::State<'_, std::sync::Arc<crate::store::Store>>,
) -> Result<serde_json::Value, String> {
    let cloud = app.state::<std::sync::Arc<crate::cloud::CloudManager>>().inner().clone();
    let (status, text) = crate::cloud::cloud_api_raw(
        &cloud,
        &store,
        reqwest::Method::DELETE,
        "/api/timeline/mine",
        &[],
        None,
    )
    .await?;
    match map_response(status, &text) {
        BatchOutcome::Accepted => {
            let mut state = load_state(store.config_dir());
            state.quota_exceeded = false;
            let _ = save_state(store.config_dir(), &state);
            Ok(parse_response_json(&text).unwrap_or(serde_json::Value::Null))
        }
        BatchOutcome::Failed(e) => Err(format!("删除云端时间线失败: {e}")),
        _ => Err(format!("删除云端时间线失败: HTTP {status}")),
    }
}

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_event_id_is_deterministic_and_input_sensitive() {
        let e = TimelineEntry {
            ts: 1_757_395_200_000,
            kind: "command".into(),
            summary: "$ cargo test".into(),
            detail: Some("output".into()),
            id: None,
            tags: None,
        };
        let id1 = crate::timeline::stable_event_id("proj-1", &e);
        let id2 = crate::timeline::stable_event_id("proj-1", &e);
        assert_eq!(id1, id2, "同输入必须同 id（多设备回填补算一致）");
        assert_eq!(id1.len(), 32);
        // 任一维度变化 → id 变化
        assert_ne!(id1, crate::timeline::stable_event_id("proj-2", &e));
        let mut e2 = e.clone();
        e2.ts += 1;
        assert_ne!(id1, crate::timeline::stable_event_id("proj-1", &e2));
        let mut e3 = e.clone();
        e3.kind = "ssh_connect".into();
        assert_ne!(id1, crate::timeline::stable_event_id("proj-1", &e3));
        // 已有 id 的条目不参与补算（写入路径恒带 uuid）
        assert!(e.id.is_none());
    }

    #[test]
    fn event_payload_redacts_and_clips_detail() {
        let long = "x".repeat(10_000);
        let e = TimelineEntry {
            ts: 123,
            kind: "command".into(),
            summary: "deploy --password=hunter2".into(),
            detail: Some(format!("login token: abc123 {long}")),
            id: Some("evt-1".into()),
            tags: None,
        };
        let payload = event_payload("p1", &e).expect("非空 summary 应生成载荷");
        assert_eq!(payload["id"], "evt-1", "已有 id 不补算");
        // 键值形态凭据被脱敏（值替换为掩码，键名保留）
        let summary = payload["summary"].as_str().unwrap();
        assert!(!summary.contains("hunter2"), "summary 应脱敏: {summary}");
        assert!(summary.contains("password"), "键名应保留: {summary}");
        // detail 截到云端上限（字素级 + 标注后 ≤ 上限 + 标注长度）
        let detail = payload["detail"].as_str().unwrap();
        assert!(!detail.contains("abc123"), "detail 应脱敏");
        assert!(
            detail.chars().count() <= CLOUD_DETAIL_MAX_RUNES,
            "detail 应截断到服务端 rune 上限"
        );
    }

    #[test]
    fn event_payload_skips_empty_summary() {
        let e = TimelineEntry {
            ts: 1,
            kind: "command".into(),
            summary: "   ".into(),
            detail: None,
            id: None,
            tags: None,
        };
        assert!(event_payload("p1", &e).is_none(), "空 summary 会连坐整批 400");
    }

    #[test]
    fn map_response_routes_error_codes() {
        assert!(matches!(
            map_response(200, r#"{"accepted":1,"duplicated":0}"#),
            BatchOutcome::Accepted
        ));
        assert!(matches!(
            map_response(403, r#"{"error":"x","code":"TIMELINE_NOT_ENABLED"}"#),
            BatchOutcome::NotEnabled
        ));
        assert!(matches!(map_response(413, r#"{"code":"QUOTA_EXCEEDED"}"#), BatchOutcome::QuotaExceeded));
        assert!(matches!(map_response(429, r#"{"code":"RATE_LIMITED"}"#), BatchOutcome::RateLimited));
        match map_response(
            400,
            r#"{"code":"INVALID_TIMELINE_PAYLOAD","details":{"index":3,"reason":"kind"}}"#,
        ) {
            BatchOutcome::InvalidBatch { index } => assert_eq!(index, Some(3)),
            other => panic!("应为 InvalidBatch，实际 {other:?}"),
        }
        // 非 2xx 且非已知码 → 传输失败（文案含状态码）
        let text = r#"{"error":"服务器内部错误"}"#;
        assert!(matches!(map_response(500, text), BatchOutcome::Failed(_)));
    }

    #[test]
    fn sync_state_roundtrip_and_defaults() {
        let dir = std::env::temp_dir().join(format!("aishell-tlup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 缺省：文件不存在 → 默认状态（未超限、无水位）
        let st = load_state(&dir);
        assert!(!st.quota_exceeded);
        assert!(st.projects.is_empty());
        // 写入后可读回
        let mut st = SyncState::default();
        st.projects.insert(
            "p1".into(),
            ProjectSyncState {
                last_ts: 42,
                last_id: Some("evt-42".into()),
                tags_uploaded: true,
            },
        );
        save_state(&dir, &st).unwrap();
        let st = load_state(&dir);
        assert_eq!(st.projects["p1"].last_ts, 42);
        assert_eq!(st.projects["p1"].last_id.as_deref(), Some("evt-42"));
        assert!(st.projects["p1"].tags_uploaded);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 复合游标：同毫秒事件成组时，仅靠 ts 会反复重读同一批——after_id 必须能跳过已传前缀。
    #[test]
    fn read_entries_since_advances_through_same_millisecond_group() {
        let dir = std::env::temp_dir().join(format!(
            "aishell-tlup-cursor-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 读取范围受本地保留期（30 天）限制，时间戳取当天
        let ts = crate::trace::now_ms();
        // 同一毫秒 5 条（回填批次边界会落在组内）
        let entries: Vec<TimelineEntry> = (0..5)
            .map(|i| TimelineEntry {
                ts,
                kind: "command".into(),
                summary: format!("cmd {i}"),
                detail: None,
                id: Some(format!("evt-{i}")),
                tags: None,
            })
            .collect();
        let date = crate::trace::date_dir_name(ts);
        let text: String = entries
            .iter()
            .map(|e| format!("{}\n", serde_json::to_string(e).unwrap()))
            .collect();
        std::fs::write(dir.join(format!("{date}.jsonl")), text).unwrap();

        // 首批：从 ts 起取 3 条
        let first = crate::timeline::read_entries_since(&dir, "p1", ts, None, 3);
        assert_eq!(first.len(), 3);
        assert_eq!(first.last().unwrap().id.as_deref(), Some("evt-2"));
        // 次批：以首批末条 id 为游标，必须跳过前三（否则同毫秒组永远原地打转）
        let second =
            crate::timeline::read_entries_since(&dir, "p1", ts, Some("evt-2"), 3);
        assert_eq!(second.len(), 2, "应只剩后两条");
        assert_eq!(second[0].id.as_deref(), Some("evt-3"));
        assert_eq!(second.last().unwrap().id.as_deref(), Some("evt-4"));
        // 末批后再读：空（游标已到末尾）
        let third =
            crate::timeline::read_entries_since(&dir, "p1", ts, Some("evt-4"), 3);
        assert!(third.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 存量条目（无 id）也要能推进游标：补算 id 参与比较。
    #[test]
    fn read_entries_since_advances_with_legacy_entries() {
        let dir = std::env::temp_dir().join(format!(
            "aishell-tlup-legacy-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // 读取范围受本地保留期（30 天）限制，时间戳取当天
        let ts = crate::trace::now_ms();
        let entries: Vec<TimelineEntry> = (0..3)
            .map(|i| TimelineEntry {
                ts,
                kind: "command".into(),
                summary: format!("legacy {i}"),
                detail: None,
                id: None,
                tags: None,
            })
            .collect();
        let date = crate::trace::date_dir_name(ts);
        let text: String = entries
            .iter()
            .map(|e| format!("{}\n", serde_json::to_string(e).unwrap()))
            .collect();
        std::fs::write(dir.join(format!("{date}.jsonl")), text).unwrap();
        let cursor = crate::timeline::effective_event_id("p1", &entries[1]);
        let rest = crate::timeline::read_entries_since(&dir, "p1", ts, Some(&cursor), 10);
        assert_eq!(rest.len(), 1, "存量条目应按补算 id 跳过前缀");
        assert_eq!(rest[0].summary, "legacy 2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_tags_drops_server_rejected_entries() {
        use crate::timeline::TimelineTag;
        let mk = |name: &str, color: &str, kind: &str| TimelineTag {
            ts: 1,
            name: name.into(),
            color: color.into(),
            anchor_ts: 1,
            anchor_kind: kind.into(),
        };
        let tags = vec![
            mk("发布", "#4f8ef7", "command"),         // 合法
            mk("", "#4f8ef7", "command"),             // 空名
            mk("ok", "4f8ef7", "command"),            // 缺 #
            mk("ok", "#gggggg", "command"),           // 非 hex
            mk("ok", "#4f8ef7", "unknown_kind"),      // 未知锚点类别
            mk(&"x".repeat(65), "#4f8ef7", "command"), // 超 64 rune
        ];
        let (kept, dropped) = sanitize_tags(tags);
        assert_eq!(kept.len(), 1, "只保留合法标签");
        assert_eq!(kept[0].name, "发布");
        assert_eq!(dropped, 5);
    }

    #[test]
    fn clip_runes_respects_server_limit() {
        // 未超限原样返回
        assert_eq!(clip_runes("abc", 10), "abc");
        // 超限截断到 rune 上限（含尾部标记）
        let long = "中".repeat(100);
        let clipped = clip_runes(&long, 10);
        assert_eq!(clipped.chars().count(), 10);
        assert!(clipped.ends_with("…(已裁剪)"));
        // 上限小于标记长度时不 panic（keep 饱和到 0）
        assert!(clip_runes(&long, 2).chars().count() <= 2 + "…(已裁剪)".chars().count());
    }

    #[test]
    fn device_hint_is_short_and_optional() {
        if let Some(h) = device_hint() {
            assert!(!h.trim().is_empty());
            assert!(h.len() <= 128);
        }
    }
}
