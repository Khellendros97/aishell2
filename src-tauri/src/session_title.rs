//! 会话首条消息自动标题：一次性领取、后台请求与条件落盘。
//!
//! 该模块独立于 ai.rs 的 pi 长驻进程，避免标题请求影响正常 AI 会话与审批流程。

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tauri::{AppHandle, Emitter, State};
use unicode_segmentation::UnicodeSegmentation;

use crate::store::Store;

const TITLE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_FIRST_MESSAGE_BYTES: usize = 4 * 1024;
const MAX_TITLE_GRAPHEMES: usize = 20;
/// 思考型模型（如 deepseek 带 reasoning 的型号）的思维链计入 max_tokens 预算，
/// 给太小会全部耗在思考上、正文为空，故放宽；标题本身仍由 clean_title 限 20 字素。
const TITLE_MAX_TOKENS: u32 = 1024;
/// 模型输出类失败的修复机会：首次请求 + 最多 2 次「错误反馈给模型修正」重试。
const TITLE_MAX_REPAIRS: usize = 2;

/// 标题请求的系统提示词：只输出标题本身，避免把解释文字落进会话标题。
const TITLE_SYSTEM_PROMPT: &str = "你是 AIShell 会话标题生成器。根据用户的第一条消息生成简洁中文标题。只输出标题本身，不要引号、Markdown、换行或解释；标题最多20个字。";

/// 清理模型输出并按用户可见的 Unicode 字素截断，避免中文/emoji 被从字素中间截断。
pub(crate) fn clean_title(raw: &str) -> Option<String> {
    let mut title = raw
        .trim()
        .trim_matches(|c| matches!(c, '"' | '\'' | '`' | '“' | '”' | '‘' | '’'))
        .trim()
        .lines()
        .next()
        .unwrap_or("")
        .chars()
        .filter(|c| !c.is_control())
        .collect::<String>();
    title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = title.graphemes(true).take(MAX_TITLE_GRAPHEMES).collect();
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

/// 从 OpenAI 兼容响应的 message 中提取正文：兼容字符串与 content parts 数组两种形态。
pub(crate) fn extract_content(message: &serde_json::Value) -> Option<String> {
    if let Some(s) = message["content"].as_str() {
        return Some(s.to_string());
    }
    let parts = message["content"].as_array()?;
    Some(
        parts
            .iter()
            .filter_map(|p| p["text"].as_str())
            .collect::<Vec<_>>()
            .join(""),
    )
}

/// 响应体诊断片段：压平空白成单行并按字素截断，避免错误页刷屏 trace。
pub(crate) fn body_snippet(body: &str) -> String {
    const MAX_GRAPHEMES: usize = 300;
    let flat = body.split_whitespace().collect::<Vec<_>>().join(" ");
    let snippet: String = flat.graphemes(true).take(MAX_GRAPHEMES).collect();
    if snippet.is_empty() {
        "（空响应体）".to_string()
    } else if flat.graphemes(true).count() > MAX_GRAPHEMES {
        format!("{snippet}…")
    } else {
        snippet
    }
}

/// 单次标题请求失败：detail 进 trace；feedback 是模型可修正失败时追加给模型的反馈
///（None = 网络/HTTP 等非模型问题，直接放弃）。
struct TitleFailure {
    detail: String,
    feedback: Option<String>,
}

/// 发起一次标题请求并清洗输出；模型输出类失败附带修正提示供上层重试。
async fn request_title(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    model_id: &str,
    messages: &[serde_json::Value],
) -> Result<String, TitleFailure> {
    let body = json!({
        "model": model_id,
        "messages": messages,
        "temperature": 0,
        "max_tokens": TITLE_MAX_TOKENS,
    });
    let response = client
        .post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|_| TitleFailure {
            detail: "请求失败（网络/超时）".to_string(),
            feedback: None,
        })?;
    if !response.status().is_success() {
        let status = response.status();
        let snippet = body_snippet(&response.text().await.unwrap_or_default());
        return Err(TitleFailure {
            detail: format!("HTTP {status} 响应: {snippet}"),
            feedback: None,
        });
    }
    let body_text = response.text().await.map_err(|_| TitleFailure {
        detail: "读取响应体失败".to_string(),
        feedback: None,
    })?;
    const RETRY_HINT: &str =
        "输出格式有误。请只输出会话标题本身（不超过20个字），不要引号、Markdown、换行或解释。";
    let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|_| TitleFailure {
        // 原文片段进 trace：上游网关返回错误页/空体时可直接看到内容定位。
        detail: format!("响应 JSON 解析失败，原文: {}", body_snippet(&body_text)),
        feedback: Some(RETRY_HINT.to_string()),
    })?;
    let raw_title = extract_content(&data["choices"][0]["message"]).ok_or_else(|| TitleFailure {
        detail: "响应缺少标题内容".to_string(),
        feedback: Some(RETRY_HINT.to_string()),
    })?;
    clean_title(&raw_title).ok_or_else(|| {
        // 诊断细节：思考型模型耗尽 max_tokens 时正文为空且 finish_reason=length。
        let finish = data["choices"][0]["finish_reason"].as_str().unwrap_or("?");
        let has_reasoning = data["choices"][0]["message"]["reasoning_content"]
            .as_str()
            .is_some_and(|s| !s.is_empty());
        TitleFailure {
            detail: format!(
                "模型输出清洗后为空（finish_reason={finish} 原文 {} 字节{}）",
                raw_title.len(),
                if has_reasoning { "，含思维链" } else { "" }
            ),
            feedback: Some(
                "上一次没有输出任何内容。请直接输出会话标题本身（不超过20个字），不要输出其他内容。"
                    .to_string(),
            ),
        }
    })
}

/// 发起一次标题生成。所有失败路径静默结束，API Key 永不进入错误文本或事件。
/// 模型输出类失败（格式错误/空输出）把原因反馈给模型修正，最多 TITLE_MAX_REPAIRS 次。
/// trace（title_gen 类）：记录请求/各失败阶段/成功标题与耗时（不经 pi 的直连 LLM 调用）。
async fn generate_title(
    store: Arc<Store>,
    app: AppHandle,
    project_id: String,
    session_id: String,
    first_message: String,
    expected_titles: Vec<String>,
) {
    let trace_key = format!("{project_id}:{session_id}");
    let started = std::time::Instant::now();
    if first_message.len() > MAX_FIRST_MESSAGE_BYTES {
        crate::trace::log(&trace_key, "title_gen", json!({"kind": "skip", "detail": "首条消息超长，跳过标题生成"}));
        return;
    }
    let Ok(api_key) = store.read_secret("llm:apikey") else {
        crate::trace::log(&trace_key, "title_gen", json!({"kind": "error", "detail": "读取 LLM API Key 失败"}));
        return;
    };
    let cfg = store.llm_config();
    crate::trace::log(&trace_key, "title_gen", json!({
        "kind": "request",
        "detail": format!("模型={} 首条消息: {}", cfg.model_id, first_message),
    }));
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let Ok(client) = reqwest::Client::builder().timeout(TITLE_TIMEOUT).build() else {
        crate::trace::log(&trace_key, "title_gen", json!({"kind": "error", "detail": "创建 HTTP 客户端失败"}));
        return;
    };
    let mut messages = vec![
        json!({"role": "system", "content": TITLE_SYSTEM_PROMPT}),
        json!({"role": "user", "content": first_message}),
    ];
    let title = 'retry: {
        for attempt in 0..=TITLE_MAX_REPAIRS {
            match request_title(&client, &url, &api_key, &cfg.model_id, &messages).await {
                Ok(title) => break 'retry title,
                Err(failure) => {
                    crate::trace::log(&trace_key, "title_gen", json!({
                        "kind": "error",
                        "detail": format!(
                            "第 {}/{} 次: {}",
                            attempt + 1,
                            TITLE_MAX_REPAIRS + 1,
                            failure.detail
                        ),
                    }));
                    let Some(feedback) = failure.feedback.filter(|_| attempt < TITLE_MAX_REPAIRS)
                    else {
                        return;
                    };
                    crate::trace::log(&trace_key, "title_gen", json!({
                        "kind": "retry",
                        "detail": "将失败原因反馈给模型，请求修正输出",
                    }));
                    messages.push(json!({"role": "user", "content": feedback}));
                }
            }
        }
        unreachable!("重试次数耗尽时已在循环内返回");
    };
    let Ok(updated) =
        store.update_session_title_if_expected(&project_id, &session_id, &expected_titles, &title)
    else {
        crate::trace::log(&trace_key, "title_gen", json!({"kind": "error", "detail": "标题落盘失败"}));
        return;
    };
    crate::trace::log(&trace_key, "title_gen", json!({
        "kind": "result",
        "detail": if updated {
            format!("标题: {title} 耗时 {}ms", started.elapsed().as_millis())
        } else {
            format!("标题已被用户修改，放弃覆盖（模型给出: {title}）")
        },
    }));
    if updated {
        // 事件只包含会话标识与标题，不包含用户消息或任何凭据；前端可据此刷新本地会话。
        let _ = app.emit(
            "ai:session-title",
            json!({
                "projectId": project_id,
                "sessionId": session_id,
                "title": title,
            }),
        );
    }
}

/// 首条用户消息标题命令。前端仅在新会话第一条用户消息时调用。
#[tauri::command]
pub async fn ai_generate_session_title(
    store: State<'_, Arc<Store>>,
    app: AppHandle,
    project_id: String,
    session_id: String,
    first_message: String,
    expected_title: Option<String>,
) -> Result<(), String> {
    if project_id.is_empty() || session_id.is_empty() {
        return Ok(());
    }
    let Ok(claimed_title) = store.try_claim_session_title(&project_id, &session_id, &first_message)
    else {
        return Ok(());
    };
    let Some(claimed_title) = claimed_title else {
        return Ok(());
    };
    let mut expected_titles = vec![claimed_title];
    if let Some(expected_title) = expected_title.filter(|title| !title.is_empty()) {
        if !expected_titles.contains(&expected_title) {
            expected_titles.push(expected_title);
        }
    }
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn(generate_title(
        store,
        app,
        project_id,
        session_id,
        first_message,
        expected_titles,
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::clean_title;

    #[test]
    fn title_uses_grapheme_limit_and_removes_wrapping() {
        let title =
            clean_title("  “中文标题😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀”\n解释").unwrap();
        assert_eq!(title.graphemes(true).count(), 20);
        assert!(!title.starts_with('“'));
    }

    #[test]
    fn empty_or_control_only_title_is_rejected() {
        assert!(clean_title("\n\t").is_none());
    }

    use unicode_segmentation::UnicodeSegmentation;

    #[test]
    fn body_snippet_flattens_and_truncates() {
        use super::body_snippet;
        assert_eq!(body_snippet(""), "（空响应体）");
        assert_eq!(body_snippet("  <html>\n  错误页 </html>"), "<html> 错误页 </html>");
        let long = "字".repeat(400);
        let snippet = body_snippet(&long);
        assert!(snippet.ends_with('…'));
        assert_eq!(snippet.graphemes(true).count(), 301);
    }

    #[test]
    fn extract_content_supports_string_and_parts_array() {
        use super::extract_content;
        let msg = serde_json::json!({"content": "直接标题"});
        assert_eq!(extract_content(&msg).as_deref(), Some("直接标题"));
        let msg = serde_json::json!({"content": [{"type": "text", "text": "部分"}, {"type": "text", "text": "标题"}]});
        assert_eq!(extract_content(&msg).as_deref(), Some("部分标题"));
        let msg = serde_json::json!({});
        assert!(extract_content(&msg).is_none());
    }
}
