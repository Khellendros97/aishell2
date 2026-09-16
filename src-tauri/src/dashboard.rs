//! 项目自定义仪表盘：每个项目一个 `<项目根>/.aishell/dashboard/dashboard.py`，
//! 脚本复用 pysdk（ssh/sftp/db）采集数据，经 `aishell.dashboard` 声明组件（文本/表格/图片/图表），
//! 组件 spec 经 SDK 桥 dashboard_emit 推回本模块，侧栏「仪表盘」面板据此渲染。
//! 对照 .proto/ 交互规格：无对应条目（新功能）；与后端接口点：
//! - 前端命令 dashboard_render / dashboard_save_memo（api.ts 封装）；
//! - AI 工具 dashboard_reload / dashboard_view（ai.rs run_internal_action 两臂）；
//! - 渲染成功后 emit「dashboard:changed」事件（模式照 sftp:progress），面板监听即时刷新。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai_actions::AiActions;
use crate::pysdk::PySdkBridge;
use crate::ssh::SshManager;
use crate::staging::RemoteStaging;
use crate::store::Store;

/// 脚本执行固定 session 标识（SDK 桥对账用；仪表盘无独立会话）
const DASHBOARD_SESSION: &str = "dashboard";
const DASHBOARD_SCRIPT: &str = "dashboard.py";
const MEMO_FILE: &str = "memo.md";
/// 备忘录顶部可编辑表格的数据文件（记账号/密码等关键信息；AI 添加的 table 组件是只读的，与它无关）
const REC_TABLE_FILE: &str = "table.json";
/// stderr 摘要上限（错误展示用，避免刷屏）
const STDERR_SNIPPET: usize = 2000;
/// 可编辑表格容量上限（防脚本/AI 误写撑爆配置文件）
const REC_TABLE_MAX_COLUMNS: usize = 50;
const REC_TABLE_MAX_ROWS: usize = 500;
const REC_TABLE_MAX_CELL_CHARS: usize = 4000;

/// 默认仪表盘脚本：播种一次（用户可自由修改，不覆盖），初始只有欢迎文本——
/// 备忘录组件（含顶部可编辑表格）由渲染管线固定合并，不依赖脚本。
const DEFAULT_SCRIPT: &str = r#""""AIShell 项目仪表盘 —— 由 AIShell 渲染时执行，用 aishell.dashboard 声明组件。
可用能力：servers/ssh/sftp/db（见 python-script 技能），组件 API 见 dashboard 技能。
"""

from aishell import dashboard

# 可选：声明自动刷新间隔（秒），面板头部可暂停/恢复
# dashboard.meta(refresh_seconds=30)

dashboard.text(
    "welcome",
    "仪表盘",
    "这是本项目的自定义仪表盘。上方备忘录可记录关键信息（顶部表格可编辑），"
    "点击侧栏头部的「定制仪表盘」，告诉 AI 你想监控什么。",
)
"#;

/// 默认备忘录：同样只播种一次。
const DEFAULT_MEMO: &str = "在这里记录关键信息（发布窗口、注意事项……）\n";

/// 默认可编辑表格（备忘录顶部）：只播种一次。
const DEFAULT_REC_TABLE: &str = r#"{"columns":[{"key":"item","title":"项目"},{"key":"value","title":"内容"}],"rows":[{"item":"示例","value":"表格可编辑：记录账号、密码、地址等关键信息"}]}"#;

/// 渲染结果（前端契约；serde camelCase）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DashboardRender {
    /// 组件 spec（含头部合并的备忘录组件）；脚本失败时为 None
    pub spec: Option<Value>,
    /// 脚本执行/推送失败的错误描述（中文，行内展示）；成功为 None
    pub error: Option<String>,
    /// 渲染完成时间（unix 秒）
    pub refreshed_at: u64,
}

/// 运行态缓存：每个项目最近一次渲染结果（dashboard_view 工具读取；不落盘）。
static LAST_RENDER: OnceLock<Mutex<HashMap<String, DashboardRender>>> = OnceLock::new();
/// 每项目渲染互斥锁（面板自动刷新与 AI reload 并发时串行）。
static RENDER_LOCKS: OnceLock<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>> =
    OnceLock::new();
/// 事件发射句柄（lib.rs setup 注入；测试不注入则静默跳过）。
static APP: OnceLock<AppHandle> = OnceLock::new();

pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

fn emit_changed(project_id: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit("dashboard:changed", json!({ "projectId": project_id }));
    }
}

fn last_render() -> &'static Mutex<HashMap<String, DashboardRender>> {
    LAST_RENDER.get_or_init(|| Mutex::new(HashMap::new()))
}

fn render_lock(project_id: &str) -> Arc<tokio::sync::Mutex<()>> {
    let locks = RENDER_LOCKS.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = locks.lock().unwrap_or_else(|e| e.into_inner());
    guard
        .entry(project_id.to_string())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// 项目仪表盘目录：`<项目根>/.aishell/dashboard`（项目根解析规则照 skills::project_skills_root；
/// 不存在则创建）。
pub(crate) fn dashboard_dir(store: &Store, project_id: &str) -> Result<PathBuf, String> {
    let project = store
        .project(project_id)
        .ok_or_else(|| format!("项目不存在：{project_id}"))?;
    let root = match project.path.as_deref().filter(|s| !s.trim().is_empty()) {
        Some(p) => PathBuf::from(p),
        None => {
            let ws = store
                .settings()
                .workspace_dir
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| "请先在设置中配置工作区目录".to_string())?;
            PathBuf::from(ws).join(&project.name)
        }
    };
    let dir = root.join(".aishell").join("dashboard");
    fs::create_dir_all(&dir).map_err(|e| format!("创建仪表盘目录失败：{e}"))?;
    Ok(dir)
}

/// 播种默认仪表盘脚本、备忘录与可编辑表格（均只在缺失时写入，用户改过不动）。
fn seed_default(dir: &Path) -> Result<(), String> {
    let script = dir.join(DASHBOARD_SCRIPT);
    if !script.exists() {
        fs::write(&script, DEFAULT_SCRIPT).map_err(|e| format!("写入默认仪表盘脚本失败：{e}"))?;
    }
    let memo = dir.join(MEMO_FILE);
    if !memo.exists() {
        fs::write(&memo, DEFAULT_MEMO).map_err(|e| format!("写入默认备忘录失败：{e}"))?;
    }
    let table = dir.join(REC_TABLE_FILE);
    if !table.exists() {
        fs::write(&table, DEFAULT_REC_TABLE).map_err(|e| format!("写入默认表格失败：{e}"))?;
    }
    Ok(())
}

/// tmp + rename 原子写（同 store.rs persist_locked 风格）。
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    fs::write(&tmp, content).map_err(|e| format!("写入备忘录失败：{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("保存备忘录失败：{e}"))
}

/// 读取备忘录内容（缺失返回空串，不算错误）。
fn read_memo(dir: &Path) -> String {
    fs::read_to_string(dir.join(MEMO_FILE)).unwrap_or_default()
}

/// 可编辑表格列（前端编辑时 key 唯一；title 展示）。
#[derive(serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RecTableColumn {
    pub key: String,
    pub title: String,
}

/// 读取备忘录顶部的可编辑表格（文件缺失/损坏返回空列空行，不阻塞渲染）。
fn read_rec_table(dir: &Path) -> (Vec<RecTableColumn>, Vec<std::collections::HashMap<String, String>>) {
    let Ok(raw) = fs::read_to_string(dir.join(REC_TABLE_FILE)) else {
        return (Vec::new(), Vec::new());
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return (Vec::new(), Vec::new());
    };
    let columns: Vec<RecTableColumn> = v
        .get("columns")
        .cloned()
        .and_then(|c| serde_json::from_value(c).ok())
        .unwrap_or_default();
    let rows: Vec<std::collections::HashMap<String, String>> = v
        .get("rows")
        .cloned()
        .and_then(|r| serde_json::from_value(r).ok())
        .unwrap_or_default();
    (columns, rows)
}

/// 备忘录组件（固定在 spec 头部；脚本无法删除，AI 可直接编辑 memo.md/table.json）。
/// 顶部是可编辑表格（columns/rows，用户记账号密码等），下方是备忘文本（content）。
fn memo_component(
    content: String,
    columns: Vec<RecTableColumn>,
    rows: Vec<std::collections::HashMap<String, String>>,
) -> Value {
    json!({"type": "memo", "id": "memo", "title": "备忘录", "content": content, "columns": columns, "rows": rows})
}

/// 渲染仪表盘：执行 dashboard.py（SDK 桥注入）→ 取组件 spec → 头部合并备忘录。
/// 脚本失败返回 error 字段（前端保留上次成功 spec 行内报错）；并发渲染按项目串行。
pub(crate) async fn render(
    actions: &Arc<AiActions>,
    store: &Arc<Store>,
    project_id: &str,
) -> Result<DashboardRender, String> {
    let lock = render_lock(project_id);
    let _permit = lock.lock().await;
    let out = render_inner(actions, store, project_id).await;
    if let Ok(r) = &out {
        if let Ok(mut cache) = last_render().lock() {
            cache.insert(project_id.to_string(), r.clone());
        }
    }
    out
}

async fn render_inner(
    actions: &Arc<AiActions>,
    store: &Arc<Store>,
    project_id: &str,
) -> Result<DashboardRender, String> {
    let dir = dashboard_dir(store, project_id)?;
    seed_default(&dir)?;
    let refreshed_at = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    };
    let fail = |msg: String| {
        Ok(DashboardRender {
            spec: None,
            error: Some(msg),
            refreshed_at: refreshed_at(),
        })
    };
    // 备忘录在渲染开始时读一次（渐进转发的每帧与最终结果共用，采集期间编辑下次渲染生效）
    let (memo_cols, memo_rows) = read_rec_table(&dir);
    let memo = memo_component(read_memo(&dir), memo_cols, memo_rows);
    // 渐进渲染：脚本每声明一个组件（aishell.dashboard 声明即 emit），桥实时转发到本通道，
    // 转发任务合并备忘录后经 dashboard:progress 事件推给面板——面板边采集边出内容，
    // 不再等整个脚本跑完才一次性渲染
    let (progress_tx, mut progress_rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let bridge = match PySdkBridge::start(Arc::clone(actions), project_id, DASHBOARD_SESSION, Some(progress_tx)).await
    {
        Ok(b) => b,
        Err(e) => return fail(e),
    };
    let forward = {
        let memo = memo.clone();
        let pid = project_id.to_string();
        tokio::spawn(async move {
            while let Some(mut spec) = progress_rx.recv().await {
                if let Some(components) = spec.get_mut("components").and_then(Value::as_array_mut)
                {
                    components.insert(0, memo.clone());
                }
                if let Some(app) = APP.get() {
                    let _ = app.emit("dashboard:progress", json!({ "projectId": pid, "spec": spec }));
                }
            }
        })
    };
    let result = actions
        .run_py(
            project_id,
            None,
            Some(format!(".aishell/dashboard/{DASHBOARD_SCRIPT}")),
            Vec::new(),
            None,
            bridge.env_pairs(),
        )
        .await;
    let spec = bridge.take_dashboard_spec();
    bridge.stop().await;
    // 等转发任务把队列里剩余的进度帧发完（tx 随 bridge ctx 销毁而断开，recv 自然结束）
    let _ = forward.await;
    let result = match result {
        Ok(r) => r,
        Err(e) => return fail(format!("仪表盘脚本执行失败：{e}")),
    };
    if result.timed_out {
        return fail("仪表盘脚本执行超时，已终止".to_string());
    }
    if result.exit_code != Some(0) {
        let stderr: String = result.stderr.chars().take(STDERR_SNIPPET).collect();
        return fail(format!(
            "仪表盘脚本退出码 {}：{}",
            result.exit_code.unwrap_or(-1),
            if stderr.trim().is_empty() {
                "无错误输出"
            } else {
                stderr.trim()
            }
        ));
    }
    let mut spec = match spec {
        Some(s) => s,
        None => {
            return fail(
                "仪表盘脚本未推送组件（请使用 aishell.dashboard 声明组件，见 dashboard 技能）"
                    .to_string(),
            )
        }
    };
    // 备忘录固定合并到组件头部（复用渲染开始时读的内容，与渐进帧一致）
    if let Some(components) = spec.get_mut("components").and_then(Value::as_array_mut) {
        components.insert(0, memo);
    } else {
        spec = json!({"meta": spec.get("meta").cloned().unwrap_or(json!({})), "components": [memo]});
    }
    Ok(DashboardRender {
        spec: Some(spec),
        error: None,
        refreshed_at: refreshed_at(),
    })
}

/// dashboard_view 工具输出：组件树文本摘要（供 AI 验证部署效果）。
pub(crate) fn view_summary(project_id: &str) -> String {
    let cache = match last_render().lock() {
        Ok(c) => c,
        Err(_) => return "仪表盘缓存不可用".to_string(),
    };
    let Some(r) = cache.get(project_id) else {
        return "仪表盘尚未渲染，请先用 dashboard_reload 执行一次渲染".to_string();
    };
    if let Some(err) = &r.error {
        return format!("仪表盘渲染失败：{err}");
    }
    let Some(spec) = &r.spec else {
        return "仪表盘暂无组件".to_string();
    };
    let mut lines = Vec::new();
    if let Some(secs) = spec
        .get("meta")
        .and_then(|m| m.get("refreshSeconds"))
        .and_then(Value::as_u64)
    {
        lines.push(format!("自动刷新间隔：{secs} 秒"));
    }
    let components = spec
        .get("components")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    lines.push(format!("组件数：{}", components.len()));
    for c in &components {
        let ty = c.get("type").and_then(Value::as_str).unwrap_or("?");
        let id = c.get("id").and_then(Value::as_str).unwrap_or("");
        let title = c.get("title").and_then(Value::as_str).unwrap_or("");
        let detail = match ty {
            "table" => {
                let cols = c
                    .get("columns")
                    .and_then(Value::as_array)
                    .map(|a| a.len())
                    .unwrap_or(0);
                let rows = c
                    .get("rows")
                    .and_then(Value::as_array)
                    .map(|a| a.len())
                    .unwrap_or(0);
                format!("{cols} 列 × {rows} 行")
            }
            "image" => c
                .get("mime")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string(),
            "text" | "memo" => {
                let key = if ty == "memo" { "content" } else { "markdown" };
                let len = c
                    .get(key)
                    .and_then(Value::as_str)
                    .map(|s| s.chars().count())
                    .unwrap_or(0);
                if ty == "memo" {
                    let cols = c
                        .get("columns")
                        .and_then(Value::as_array)
                        .map(|a| a.len())
                        .unwrap_or(0);
                    let rows = c
                        .get("rows")
                        .and_then(Value::as_array)
                        .map(|a| a.len())
                        .unwrap_or(0);
                    format!("表格 {cols} 列 × {rows} 行 + 文本 {len} 字符")
                } else {
                    format!("{len} 字符")
                }
            }
            _ => String::new(),
        };
        lines.push(format!("- [{ty}] {title}（id={id}）{detail}"));
    }
    lines.join("\n")
}

/// 供 ai.rs / 前端命令构造 AiActions（轻量：全部 Arc 克隆）。
fn make_actions(
    store: &Arc<Store>,
    ssh: &Arc<SshManager>,
    staging: &Arc<RemoteStaging>,
    browser: &Arc<crate::browser::BrowserManager>,
) -> Arc<AiActions> {
    Arc::new(AiActions::new(
        Arc::clone(store),
        Arc::clone(ssh),
        Arc::clone(staging),
        Arc::clone(browser),
    ))
}

/// AI 工具 dashboard_reload 的执行体（ai.rs run_internal_action 调用）：
/// 渲染 + 成功后广播 dashboard:changed，返回给模型的是文本摘要或错误。
pub(crate) async fn reload_for_ai(
    actions: &Arc<AiActions>,
    store: &Arc<Store>,
    project_id: &str,
) -> Result<String, String> {
    let r = render(actions, store, project_id).await?;
    if let Some(err) = &r.error {
        return Err(format!("仪表盘脚本执行失败：{err}"));
    }
    emit_changed(project_id);
    Ok(view_summary(project_id))
}

#[tauri::command]
pub async fn dashboard_render(
    store: State<'_, Arc<Store>>,
    ssh: State<'_, Arc<SshManager>>,
    staging: State<'_, Arc<RemoteStaging>>,
    app: AppHandle,
    project_id: String,
) -> Result<DashboardRender, String> {
    let browser = app.state::<Arc<crate::browser::BrowserManager>>();
    let actions = make_actions(&store, &ssh, &staging, &browser);
    render(&actions, &store, &project_id).await
}

#[tauri::command]
pub async fn dashboard_save_memo(
    store: State<'_, Arc<Store>>,
    project_id: String,
    content: String,
) -> Result<(), String> {
    let dir = dashboard_dir(&store, &project_id)?;
    write_atomic(&dir.join(MEMO_FILE), &content)?;
    emit_changed(&project_id);
    Ok(())
}

/// 保存备忘录顶部的可编辑表格（整表覆盖写，原子；容量上限防误写撑爆配置）。
#[tauri::command]
pub async fn dashboard_save_table(
    store: State<'_, Arc<Store>>,
    project_id: String,
    columns: Vec<RecTableColumn>,
    rows: Vec<std::collections::HashMap<String, String>>,
) -> Result<(), String> {
    if columns.len() > REC_TABLE_MAX_COLUMNS {
        return Err(format!("表格列数超过上限（{REC_TABLE_MAX_COLUMNS}）"));
    }
    if rows.len() > REC_TABLE_MAX_ROWS {
        return Err(format!("表格行数超过上限（{REC_TABLE_MAX_ROWS}）"));
    }
    let mut keys = std::collections::HashSet::new();
    for c in &columns {
        if c.key.trim().is_empty() || !keys.insert(c.key.clone()) {
            return Err("表格列 key 为空或重复".to_string());
        }
    }
    for r in &rows {
        for v in r.values() {
            if v.chars().count() > REC_TABLE_MAX_CELL_CHARS {
                return Err(format!("单元格内容超过 {REC_TABLE_MAX_CELL_CHARS} 字符上限"));
            }
        }
    }
    let dir = dashboard_dir(&store, &project_id)?;
    let body = serde_json::to_string(&json!({ "columns": columns, "rows": rows }))
        .map_err(|e| format!("表格序列化失败：{e}"))?;
    write_atomic(&dir.join(REC_TABLE_FILE), &body)?;
    emit_changed(&project_id);
    Ok(())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{Project, Settings, test_store};

    /// 独立临时基目录（pid + 序号，测试间不冲突；照 skills.rs tmp_base 模式）。
    fn tmp_base(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "aishell-dash-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ))
    }

    /// 构造带 workspace 与一个项目的 Store，返回 (store, 项目根)。
    fn store_with_project(tag: &str) -> (Store, PathBuf) {
        let base = tmp_base(tag);
        let config = base.join("config");
        let ws = base.join("workspace");
        let proj = ws.join("项目A");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(&proj).unwrap();
        let store = test_store(config);
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        store
            .upsert_project(Project {
                id: "p1".to_string(),
                name: "项目A".to_string(),
                path: Some(proj.to_string_lossy().into_owned()),
                server_ids: Vec::new(),
                quick_commands: Vec::new(),
                folder: String::new(),
                ai_mode: Default::default(),
            })
            .unwrap();
        (store, proj)
    }

    #[test]
    fn dashboard_dir_resolves_inside_project_root() {
        let (store, proj) = store_with_project("dir");
        let dir = dashboard_dir(&store, "p1").unwrap();
        assert_eq!(dir, proj.join(".aishell").join("dashboard"));
        assert!(dir.is_dir());
        assert!(dashboard_dir(&store, "missing").is_err());
    }

    #[test]
    fn seed_default_is_idempotent_and_preserves_user_edits() {
        let (store, _proj) = store_with_project("seed");
        let dir = dashboard_dir(&store, "p1").unwrap();
        seed_default(&dir).unwrap();
        assert!(dir.join(DASHBOARD_SCRIPT).is_file());
        assert!(dir.join(MEMO_FILE).is_file());
        assert!(dir.join(REC_TABLE_FILE).is_file());
        // 默认可编辑表格可读回（columns/rows 结构完整）
        let (cols, rows) = read_rec_table(&dir);
        assert_eq!(cols.len(), 2);
        assert_eq!(rows.len(), 1);
        // 用户修改后再次播种不覆盖
        fs::write(dir.join(DASHBOARD_SCRIPT), "# 用户改过").unwrap();
        fs::write(dir.join(REC_TABLE_FILE), "{\"columns\":[],\"rows\":[]}").unwrap();
        seed_default(&dir).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join(DASHBOARD_SCRIPT)).unwrap(),
            "# 用户改过"
        );
        let (cols, rows) = read_rec_table(&dir);
        assert!(cols.is_empty() && rows.is_empty(), "用户表格被播种覆盖");
        // 损坏的 table.json 不阻塞渲染（回退空表）
        fs::write(dir.join(REC_TABLE_FILE), "not json").unwrap();
        let (cols, rows) = read_rec_table(&dir);
        assert!(cols.is_empty() && rows.is_empty());
    }

    #[test]
    fn memo_write_atomic_and_merge_component() {
        let dir = tmp_base("memo");
        fs::create_dir_all(&dir).unwrap();
        write_atomic(&dir.join(MEMO_FILE), "关键信息").unwrap();
        assert_eq!(read_memo(&dir), "关键信息");
        write_atomic(&dir.join(MEMO_FILE), "更新后").unwrap();
        assert_eq!(read_memo(&dir), "更新后");
        let cols = vec![RecTableColumn { key: "k".to_string(), title: "项".to_string() }];
        let rows = vec![std::collections::HashMap::from([("k".to_string(), "v".to_string())])];
        let c = memo_component("内容".to_string(), cols, rows);
        assert_eq!(c["type"], "memo");
        assert_eq!(c["content"], "内容");
        assert_eq!(c["columns"][0]["key"], "k");
        assert_eq!(c["rows"][0]["k"], "v");
    }

    #[test]
    fn view_summary_handles_empty_cache() {
        let s = view_summary("no-such-project");
        assert!(s.contains("尚未渲染"), "实际：{s}");
    }

    #[test]
    fn view_summary_formats_component_tree() {
        let project_id = "view-test";
        let r = DashboardRender {
            spec: Some(json!({
                "meta": {"refreshSeconds": 30},
                "components": [
                    memo_component("备忘".to_string(),
                        vec![RecTableColumn { key: "a".to_string(), title: "A".to_string() }],
                        vec![std::collections::HashMap::from([("a".to_string(), "1".to_string())])]),
                    {"type": "table", "id": "load", "title": "负载",
                     "columns": [{"key": "a", "title": "A"}], "rows": [{"a": 1}, {"a": 2}]},
                    {"type": "image", "id": "img", "title": "图", "mime": "image/svg+xml", "data": ""},
                    {"type": "text", "id": "t", "title": "文", "markdown": "你好"},
                ]
            })),
            error: None,
            refreshed_at: 1,
        };
        last_render().lock().unwrap().insert(project_id.to_string(), r);
        let s = view_summary(project_id);
        assert!(s.contains("自动刷新间隔：30 秒"), "实际：{s}");
        assert!(s.contains("组件数：4"), "实际：{s}");
        assert!(s.contains("[table] 负载（id=load）1 列 × 2 行"), "实际：{s}");
        assert!(s.contains("[memo]"), "实际：{s}");
        assert!(s.contains("表格 1 列 × 1 行 + 文本 2 字符"), "实际：{s}");
        assert!(s.contains("image/svg+xml"), "实际：{s}");
        last_render().lock().unwrap().remove(project_id);
    }

    #[test]
    fn view_summary_shows_error() {
        let project_id = "view-err";
        last_render().lock().unwrap().insert(
            project_id.to_string(),
            DashboardRender {
                spec: None,
                error: Some("退出码 1".to_string()),
                refreshed_at: 1,
            },
        );
        assert!(view_summary(project_id).contains("渲染失败"));
        last_render().lock().unwrap().remove(project_id);
    }

    /// 端到端：默认模板经真实 Python + SDK 桥渲染成功（备忘录头部合并 + 示例组件）；
    /// 脚本崩溃走 error 路径。无 Python 运行时 / SDK 包的环境跳过（CI 兼容性）。
    #[tokio::test]
    async fn render_end_to_end_with_real_python() {
        if crate::pythoninstall::find_python().is_none() || crate::pysdk::pysdk_dir().is_none() {
            eprintln!("跳过：无 Python 运行时或内置 SDK 包");
            return;
        }
        let (store, _proj) = store_with_project("e2e");
        let store = Arc::new(store);
        let ssh = Arc::new(crate::ssh::SshManager::new(Arc::clone(&store)));
        let staging = Arc::new(crate::staging::RemoteStaging::new(
            tmp_base("e2e-staging"),
            Arc::clone(&ssh),
            Arc::clone(&store),
        ));
        let actions = Arc::new(AiActions::new(
            Arc::clone(&store),
            ssh,
            staging,
            Arc::new(crate::browser::BrowserManager::new()),
        ));

        // 默认模板渲染成功：备忘录固定头部（含可编辑表格） + 脚本文本组件
        let r = render(&actions, &store, "p1").await.unwrap();
        assert!(r.error.is_none(), "默认模板渲染失败：{:?}", r.error);
        let spec = r.spec.expect("应有组件 spec");
        let components = spec["components"].as_array().unwrap();
        assert_eq!(components[0]["type"], "memo");
        assert!(components[0]["columns"].is_array(), "备忘录应带可编辑表格");
        assert!(components.iter().any(|c| c["type"] == "text"));

        // 脚本崩溃 → error 路径（含退出码），spec 为 None
        let dir = dashboard_dir(&store, "p1").unwrap();
        fs::write(dir.join(DASHBOARD_SCRIPT), "raise SystemExit(3)\n").unwrap();
        let r = render(&actions, &store, "p1").await.unwrap();
        assert!(r.spec.is_none());
        assert!(r.error.unwrap_or_default().contains('3'), "应带退出码");
    }
}
