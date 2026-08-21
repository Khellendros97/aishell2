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

/// 发起一次标题生成。所有失败路径静默结束，API Key 永不进入错误文本或事件。
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
    let body = json!({
        "model": cfg.model_id,
        "messages": [
            {"role": "system", "content": TITLE_SYSTEM_PROMPT},
            {"role": "user", "content": first_message},
        ],
        "temperature": 0,
        "max_tokens": 32,
    });
    let Ok(client) = reqwest::Client::builder().timeout(TITLE_TIMEOUT).build() else {
        crate::trace::log(&trace_key, "title_gen", json!({"kind": "error", "detail": "创建 HTTP 客户端失败"}));
        return;
    };
    let Ok(response) = client
        .post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
    else {
        crate::trace::log(&trace_key, "title_gen", json!({"kind": "error", "detail": "请求失败（网络/超时）"}));
        return;
    };
    if !response.status().is_success() {
        crate::trace::log(&trace_key, "title_gen", json!({"kind": "error", "detail": format!("HTTP {}", response.status())}));
        return;
    }
    let Ok(data) = response.json::<serde_json::Value>().await else {
        crate::trace::log(&trace_key, "title_gen", json!({"kind": "error", "detail": "响应 JSON 解析失败"}));
        return;
    };
    let Some(raw_title) = data["choices"][0]["message"]["content"].as_str() else {
        crate::trace::log(&trace_key, "title_gen", json!({"kind": "error", "detail": "响应缺少标题内容"}));
        return;
    };
    let Some(title) = clean_title(raw_title) else {
        crate::trace::log(&trace_key, "title_gen", json!({"kind": "error", "detail": "模型输出清洗后为空"}));
        return;
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
}
