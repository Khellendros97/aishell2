//! 笔记发布钉钉日志:经本机 dws CLI(钉钉工作区命令行)完成认证检测/模版查询/日志提交,
//! 中间由 LLM 把笔记整理为模版字段对应的 contents JSON(前端预览确认后再提交)。
//!
//! dws 调用统一 tokio::process::Command + output()(照 ai_actions.rs run_local 模式,
//! Windows CREATE_NO_WINDOW 隐藏控制台);dws 走 PATH 查找,NotFound 给出安装提示。
//! LLM 调用照 notes.rs generate_note 直连模式(reqwest `{base_url}/chat/completions`,
//! 单次调用由前端 await,不做后台 + 事件)。report.json 临时文件由本模块托管,
//! 提交结束(无论成败)即删除,前端不感知。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use crate::store::Store;

/// dws 命令超时(模版查询/提交都是轻量调用;LLM 超时单独定义)
const DWS_TIMEOUT: Duration = Duration::from_secs(60);
const REPORT_LLM_TIMEOUT: Duration = Duration::from_secs(180);
const REPORT_MAX_TOKENS: u32 = 8192;

// ---------------------------------------------------------------- dws 进程调用

/// 执行 dws 子命令并返回 stdout(成功时)。cwd 供 --contents-file 等「路径须在 cwd 下」
/// 的参数使用(dws 拒绝 cwd 之外的路径);None = 继承应用工作目录。
/// 失败返回中文可操作错误:NotFound = 未安装;非零退出码剥 stdout JSON 的 error.message
/// 或 stderr 摘要;认证类错误追加 dws auth login 引导。
async fn run_dws_in(args: &[&str], cwd: Option<&Path>) -> Result<String, String> {
    let mut cmd = tokio::process::Command::new("dws");
    cmd.args(args).kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    // Windows 下隐藏控制台窗口(与 ai.rs 的 pi 启动一致)
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = tokio::time::timeout(DWS_TIMEOUT, cmd.output())
        .await
        .map_err(|_| format!("dws 命令执行超时（{} 秒），请检查网络后重试", DWS_TIMEOUT.as_secs()))?
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                "未检测到 dws 命令，请先安装钉钉 CLI（dws）".to_string()
            } else {
                format!("执行 dws 失败: {e}")
            }
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    if out.status.success() {
        return Ok(stdout);
    }
    // 失败时 dws 常把结构化错误打在 stdout(error.message),退而求其次取 stderr 摘要
    let detail = serde_json::from_str::<serde_json::Value>(&stdout)
        .ok()
        .and_then(|v| v["error"]["message"].as_str().map(str::to_string))
        .unwrap_or_else(|| {
            crate::session_title::body_snippet(&String::from_utf8_lossy(&out.stderr))
        });
    Err(with_auth_hint(if detail.is_empty() {
        format!("dws 命令失败（退出码 {}）", out.status.code().unwrap_or(-1))
    } else {
        format!("dws 命令失败: {detail}")
    }))
}

/// 无 cwd 要求的 dws 调用(多数命令)。
async fn run_dws(args: &[&str]) -> Result<String, String> {
    run_dws_in(args, None).await
}

/// 认证类错误追加登录引导(认证状态由 dws_auth_status 前置检测,这里是兜底)。
fn with_auth_hint(msg: String) -> String {
    let lower = msg.to_lowercase();
    if lower.contains("auth") || lower.contains("login") || lower.contains("logged") || lower.contains("token") || msg.contains("登录") || msg.contains("认证") {
        format!("{msg}；请先在终端执行 dws auth login 完成认证")
    } else {
        msg
    }
}

// ---------------------------------------------------------------- 认证检测

/// dws 认证状态(dws auth status -y 的精简结果;installed=false 表示未安装 dws)。
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DwsAuthStatus {
    pub installed: bool,
    pub authenticated: bool,
    pub user_name: String,
    pub corp_name: String,
}

/// dws auth status 的 JSON 输出(snake_case,只取需要的字段)。
#[derive(Deserialize, Default)]
#[serde(default)]
struct DwsAuthStatusRaw {
    authenticated: bool,
    token_valid: bool,
    user_name: String,
    corp_name: String,
}

/// 检测 dws 认证状态。未安装/未认证都走 Ok 返回(由前端展示引导),不视为命令失败。
#[tauri::command]
pub async fn dws_auth_status() -> Result<DwsAuthStatus, String> {
    match run_dws(&["auth", "status", "-y"]).await {
        Ok(stdout) => {
            let raw: DwsAuthStatusRaw = serde_json::from_str(&stdout)
                .map_err(|_| "解析 dws 认证状态失败，请升级 dws 后重试".to_string())?;
            Ok(DwsAuthStatus {
                installed: true,
                authenticated: raw.authenticated && raw.token_valid,
                user_name: raw.user_name,
                corp_name: raw.corp_name,
            })
        }
        Err(e) if e.starts_with("未检测到 dws 命令") => Ok(DwsAuthStatus::default()),
        Err(e) => Err(e),
    }
}

// ---------------------------------------------------------------- 模版查询

/// 日志模版(发布模态框的选择器数据)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DwsTemplate {
    pub id: String,
    pub name: String,
}

/// dws report template list 的 JSON 输出。
#[derive(Deserialize, Default)]
#[serde(default)]
struct DwsTemplateListRaw {
    items: Vec<DwsTemplateRaw>,
}

#[derive(Deserialize)]
struct DwsTemplateRaw {
    report_template_id: String,
    report_template_name: String,
}

/// 列出当前用户可用的日志模版。
#[tauri::command]
pub async fn dws_report_templates() -> Result<Vec<DwsTemplate>, String> {
    let stdout = run_dws(&["report", "template", "list", "-y"]).await?;
    let raw: DwsTemplateListRaw = serde_json::from_str(&stdout)
        .map_err(|_| "解析日志模版列表失败，请升级 dws 后重试".to_string())?;
    Ok(raw
        .items
        .into_iter()
        .map(|t| DwsTemplate {
            id: t.report_template_id,
            name: t.report_template_name,
        })
        .collect())
}

/// 模版字段定义(dws report template get 的 result.report_template_fields)。
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DwsTemplateField {
    pub name: String,
    pub sort: i64,
    pub field_type: i64,
}

#[derive(Deserialize)]
struct DwsTemplateGetRaw {
    result: DwsTemplateGetResult,
}

#[derive(Deserialize)]
struct DwsTemplateGetResult {
    report_template_id: String,
    #[serde(default)]
    report_template_fields: Vec<DwsTemplateFieldRaw>,
}

#[derive(Deserialize)]
struct DwsTemplateFieldRaw {
    field_name: String,
    field_sort: i64,
    field_type: i64,
}

/// 按模版名取字段定义(顺带返回模版 id)。模版名由 dws_report_templates 给出,精确匹配。
async fn template_fields(template_name: &str) -> Result<(String, Vec<DwsTemplateField>), String> {
    let stdout = run_dws(&["report", "template", "get", "--name", template_name, "-y"]).await?;
    let raw: DwsTemplateGetRaw = serde_json::from_str(&stdout)
        .map_err(|_| format!("解析模版「{template_name}」定义失败，请升级 dws 后重试"))?;
    let fields = raw
        .result
        .report_template_fields
        .into_iter()
        .map(|f| DwsTemplateField {
            name: f.field_name,
            sort: f.field_sort,
            field_type: f.field_type,
        })
        .collect();
    Ok((raw.result.report_template_id, fields))
}

// ---------------------------------------------------------------- LLM 整理内容

/// 日志内容项(与 dws report entry submit --contents 的数组元素逐字段对齐)。
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ReportContent {
    pub key: String,
    pub sort: String,
    pub content: String,
    pub content_type: String,
    #[serde(rename = "type")]
    pub item_type: String,
}

/// 整理日志的系统提示:严格按模版字段输出 contents JSON 数组。
const REPORT_SYSTEM: &str = "你是 AIShell 钉钉日志整理助手。根据用户笔记与钉钉日志模版字段定义,把笔记整理为日志 contents JSON 数组。规则:每个文本模版字段对应一项,格式 {\"key\":字段的name,\"sort\":\"字段sort的字符串形式\",\"content\":\"Markdown 正文\",\"contentType\":\"markdown\",\"type\":\"字段fieldType的字符串形式\"};key/sort/type 必须与给定字段定义一一对应,不得新增、遗漏或改名;fieldType 为 8(图片)/9(附件) 的字段不要输出对应项(不支持上传图片/附件);把笔记内容按语义归入各文本字段,不要虚构笔记中没有的信息;笔记中已脱敏的标记(如 ***已脱敏***)原样保留。只输出 JSON 数组本身,不要输出解释或 Markdown 围栏。";

/// 从模型输出中提取并校验 contents JSON 数组。
/// 容忍 ```json 围栏与首尾杂音(取首个 '[' 到末个 ']');结构按 ReportContent 校验。
fn extract_contents(raw: &str) -> Result<Vec<ReportContent>, String> {
    let text = raw.trim();
    let start = text.find('[');
    let end = text.rfind(']');
    let slice = match (start, end) {
        (Some(s), Some(e)) if s <= e => &text[s..=e],
        _ => return Err("日志内容生成失败: 模型未输出 JSON 数组".to_string()),
    };
    let mut items: Vec<ReportContent> = serde_json::from_str(slice).map_err(|e| {
        format!("日志内容生成失败: 模型输出 JSON 解析失败（{e}），请重试")
    })?;
    if items.is_empty() {
        return Err("日志内容生成失败: 模型输出的内容为空，请重试".to_string());
    }
    if items.iter().any(|it| it.key.trim().is_empty()) {
        return Err("日志内容生成失败: 模型输出缺少字段名（key），请重试".to_string());
    }
    normalize_contents(&mut items);
    if items.is_empty() {
        return Err("日志内容生成失败: 模型输出的内容为空，请重试".to_string());
    }
    Ok(items)
}

/// contentType 归一化 + 空媒体项剔除(实测钉钉 PARAM_ERROR 结论),不依赖模型记规则,
/// 生成与提交两处统一强制:
/// - 图片(type=8)/附件(type=9) 内容为空时必须整项剔除(空项带 "origin" 也会参数错误);
///   非空时 contentType 只收 "origin"(本功能不产生非空媒体项,此处为防御);
/// - 文本字段(type=1 等) contentType 统一 "markdown"。
fn normalize_contents(items: &mut Vec<ReportContent>) {
    items.retain(|it| !(matches!(it.item_type.as_str(), "8" | "9") && it.content.trim().is_empty()));
    for it in items.iter_mut() {
        it.content_type = if matches!(it.item_type.as_str(), "8" | "9") {
            "origin".to_string()
        } else {
            "markdown".to_string()
        };
    }
}

/// 直连 LLM 整理日志内容(照 notes.rs generate_note 模式;失败返回中文错误,不含 API Key)。
async fn generate_report_contents(
    store: &Store,
    fields: &[DwsTemplateField],
    note: &str,
) -> Result<Vec<ReportContent>, String> {
    let fields_json = serde_json::to_string_pretty(fields)
        .map_err(|e| format!("日志内容生成失败: 序列化模版字段失败: {e}"))?;
    let user = format!("【模版字段定义】\n{fields_json}\n\n【笔记】\n{note}");
    let cfg = store.llm_config();
    crate::trace::log(
        "dws_report",
        "dws_report",
        json!({
            "kind": "request",
            "detail": format!("模型={} 模版字段 {} 个 笔记 {} 字节", cfg.model_id, fields.len(), user.len()),
        }),
    );
    let api_key = store
        .read_secret("llm:apikey")
        .map_err(|_| "日志内容生成失败: 请先在设置中配置 LLM API Key".to_string())?;
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(REPORT_LLM_TIMEOUT)
        .build()
        .map_err(|_| "日志内容生成失败: 创建 HTTP 客户端失败".to_string())?;
    let body = json!({
        "model": cfg.model_id,
        "messages": [
            {"role": "system", "content": REPORT_SYSTEM},
            {"role": "user", "content": user},
        ],
        "temperature": 0.3,
        "max_tokens": REPORT_MAX_TOKENS,
    });
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|_| "日志内容生成失败: 请求失败（网络/超时）".to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let snippet = crate::session_title::body_snippet(&response.text().await.unwrap_or_default());
        return Err(format!("日志内容生成失败: HTTP {status} 响应: {snippet}"));
    }
    let body_text = response
        .text()
        .await
        .map_err(|_| "日志内容生成失败: 读取响应体失败".to_string())?;
    let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|_| {
        format!(
            "日志内容生成失败: 响应 JSON 解析失败，原文: {}",
            crate::session_title::body_snippet(&body_text)
        )
    })?;
    let raw = crate::session_title::extract_content(&data["choices"][0]["message"])
        .ok_or_else(|| "日志内容生成失败: 响应缺少内容".to_string())?;
    extract_contents(&raw)
}

/// 校验笔记绝对路径在 notes 根内(canonicalize 比对,防符号链接逃逸;
/// 与 notes.rs resolve_in_root 同语义,区别是入口参数为绝对路径)。
fn resolve_note_path(root: &Path, note_path: &str) -> Result<PathBuf, String> {
    let target = Path::new(note_path);
    if !target.is_absolute() {
        return Err("笔记路径不合法: 需要绝对路径".to_string());
    }
    if !target.exists() {
        return Err(format!("笔记不存在: {note_path}"));
    }
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("解析笔记根目录失败: {e}"))?;
    let canon_target = target
        .canonicalize()
        .map_err(|e| format!("解析笔记路径失败: {e}"))?;
    if !canon_target.starts_with(&canon_root) {
        return Err("笔记路径不合法: 目标在笔记目录之外".to_string());
    }
    Ok(canon_target)
}

/// 整理日志内容:读笔记(脱敏)→ 取模版字段 → LLM 生成 contents JSON(pretty,供预览编辑)。
/// 返回 (模版 id, contents JSON 字符串);任一失败整体 Err。
#[tauri::command]
pub async fn dws_report_generate(
    store: State<'_, Arc<Store>>,
    template_name: String,
    note_path: String,
) -> Result<serde_json::Value, String> {
    let root = store.notes_root()?;
    let target = resolve_note_path(&root, &note_path)?;
    let raw_note = fs::read_to_string(&target).map_err(|e| format!("读取笔记失败: {e}"))?;
    // 脱敏:笔记可能含用户凭据,同 write_note 的处理
    let (note, _) = crate::redact::redact_secrets(&raw_note, &store.known_secrets());
    let (template_id, fields) = template_fields(&template_name).await?;
    if fields.is_empty() {
        return Err(format!("模版「{template_name}」没有可填字段，请换一个模版"));
    }
    let items = generate_report_contents(&store, &fields, &note).await?;
    let contents = serde_json::to_string_pretty(&items)
        .map_err(|e| format!("日志内容生成失败: 序列化结果失败: {e}"))?;
    crate::trace::log(
        "dws_report",
        "dws_report",
        json!({"kind": "result", "detail": format!("模版={} 内容项 {} 个", template_name, items.len())}),
    );
    Ok(json!({ "templateId": template_id, "contents": contents }))
}

// ---------------------------------------------------------------- 提交发布

/// 发布结果(open_url = 钉钉日志跳转链接,dws 返回缺失时为空)。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DwsSubmitResult {
    pub open_url: Option<String>,
}

/// 递归查找 JSON 中的字符串字段(dws submit 返回的 dingtalkOpenUrl 嵌套层级不定)。
fn find_string_field(v: &serde_json::Value, key: &str) -> Option<String> {
    match v {
        serde_json::Value::Object(map) => {
            if let Some(s) = map.get(key).and_then(|x| x.as_str()) {
                return Some(s.to_string());
            }
            map.values().find_map(|x| find_string_field(x, key))
        }
        serde_json::Value::Array(arr) => arr.iter().find_map(|x| find_string_field(x, key)),
        _ => None,
    }
}

/// 按模版提交日志:contents JSON 写临时文件(report.json,无论成败提交后即删)→
/// dws report entry submit --contents-file → 解析 dingtalkOpenUrl 返回。
#[tauri::command]
pub async fn dws_report_submit(
    template_id: String,
    contents_json: String,
) -> Result<DwsSubmitResult, String> {
    // 提交前校验结构(前端预览可编辑,防止手滑改坏 JSON)
    let mut items: Vec<ReportContent> = serde_json::from_str(&contents_json)
        .map_err(|e| format!("日志内容 JSON 不合法（{e}），请返回上一步重新生成"))?;
    if items.is_empty() {
        return Err("日志内容为空，请返回上一步重新生成".to_string());
    }
    normalize_contents(&mut items);
    if items.is_empty() {
        return Err("日志内容为空，请返回上一步重新生成".to_string());
    }
    let contents_json = serde_json::to_string(&items)
        .map_err(|e| format!("序列化日志内容失败: {e}"))?;
    // dws 要求 --contents-file 路径在 cwd 下:临时文件落系统临时目录,cwd 同目录、参数只传文件名
    let tmp_dir = std::env::temp_dir();
    let tmp_name = format!(
        "aishell-report-{}-{}.json",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    );
    let tmp = tmp_dir.join(&tmp_name);
    fs::write(&tmp, &contents_json).map_err(|e| format!("写入临时日志文件失败: {e}"))?;
    let result = run_dws_in(
        &[
            "report",
            "entry",
            "submit",
            "--template-id",
            &template_id,
            "--contents-file",
            &tmp_name,
            "-y",
        ],
        Some(&tmp_dir),
    )
    .await;
    // report.json 临时文件无论成败即删(发布成功后的清理由此覆盖)
    let _ = fs::remove_file(&tmp);
    let stdout = result?;
    let open_url = serde_json::from_str::<serde_json::Value>(&stdout)
        .ok()
        .and_then(|v| find_string_field(&v, "dingtalkOpenUrl"));
    Ok(DwsSubmitResult { open_url })
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_contents_accepts_plain_json() {
        let raw = r#"[{"key":"今日完成工作","sort":"6","content":"完成开发","contentType":"markdown","type":"1"}]"#;
        let items = extract_contents(raw).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].key, "今日完成工作");
        assert_eq!(items[0].content_type, "markdown");
        assert_eq!(items[0].item_type, "1");
    }

    #[test]
    fn extract_contents_tolerates_fence_and_prose() {
        let raw = "好的，整理如下：\n```json\n[{\"key\":\"明日工作计划\",\"sort\":\"7\",\"content\":\"继续\",\"contentType\":\"markdown\",\"type\":\"1\"}]\n```\n以上。";
        let items = extract_contents(raw).unwrap();
        assert_eq!(items[0].key, "明日工作计划");
    }

    #[test]
    fn extract_contents_rejects_bad_output() {
        assert!(extract_contents("没有 JSON").is_err());
        assert!(extract_contents("[]").is_err());
        assert!(extract_contents("[{\"key\":\"\"}]").is_err());
        assert!(extract_contents("[{\"key\":\"a\"]").is_err());
    }

    #[test]
    fn normalize_drops_empty_media_and_forces_origin() {
        // 实测钉钉 PARAM_ERROR:空的图片(type=8)/附件(type=9)项必须整项剔除;
        // 非空媒体项 contentType 只收 origin,文本字段统一 markdown
        let raw = r#"[
            {"key":"今日完成工作","sort":"6","content":"x","contentType":"markdown","type":"1"},
            {"key":"图片","sort":"3","content":"","contentType":"markdown","type":"8"},
            {"key":"附件","sort":"8","content":"  ","contentType":"markdown","type":"9"}
        ]"#;
        let items = extract_contents(raw).unwrap();
        assert_eq!(items.len(), 1, "空图片/附件项应被剔除");
        assert_eq!(items[0].content_type, "markdown");

        let mut media = vec![ReportContent {
            key: "附件".to_string(),
            sort: "8".to_string(),
            content: "media-id".to_string(),
            content_type: "markdown".to_string(),
            item_type: "9".to_string(),
        }];
        normalize_contents(&mut media);
        assert_eq!(media.len(), 1);
        assert_eq!(media[0].content_type, "origin");
    }

    #[test]
    fn auth_hint_appended_for_auth_errors() {
        let msg = with_auth_hint("dws 命令失败: not logged in".to_string());
        assert!(msg.contains("dws auth login"));
        let plain = with_auth_hint("dws 命令失败: 网络超时".to_string());
        assert!(!plain.contains("dws auth login"));
    }

    #[test]
    fn find_string_field_searches_nested() {
        let v = json!({"a": {"b": [{"dingtalkOpenUrl": "dingtalk://x"}]}});
        assert_eq!(
            find_string_field(&v, "dingtalkOpenUrl"),
            Some("dingtalk://x".to_string())
        );
        assert_eq!(find_string_field(&v, "missing"), None);
    }

    #[test]
    fn resolve_note_path_requires_inside_root() {
        let base = std::env::temp_dir().join(format!("aishell-dws-test-{}", std::process::id()));
        let root = base.join("notes");
        fs::create_dir_all(&root).unwrap();
        let note = root.join("a.md");
        fs::write(&note, "x").unwrap();
        assert!(resolve_note_path(&root, note.to_str().unwrap()).is_ok());
        assert!(resolve_note_path(&root, "relative.md").is_err());
        let outside = base.join("outside.md");
        fs::write(&outside, "x").unwrap();
        assert!(resolve_note_path(&root, outside.to_str().unwrap()).is_err());
        assert!(resolve_note_path(&root, root.join("missing.md").to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(&base);
    }
}
