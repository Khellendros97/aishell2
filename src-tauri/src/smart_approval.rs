//! 智能审批：受控工具调用直连 LLM 判定是否危险（不走 pi，独立轻量请求）。
//!
//! 契约：ai.rs 在 agent 模式收到 `AISHELL_APPROVAL:` confirm 时，若审批模式为智能审批，
//! 先调 [`judge`] 判定：`Ok(false)` 直接放行；`Ok(true)` / `Err`（网络、超时、解析失败）
//! 一律回退人工审批——判定失败宁可多打扰一次，也不放行危险操作。
//!
//! 思考强度固定 low（需求约定）：请求带 OpenAI 兼容 `reasoning_effort` 字段；
//! 不支持的兼容端点一般忽略未知字段，若报错则回退人工审批。
//! API 地址与模型复用设置里的 LLM 配置，密钥走 keyring（`llm:apikey`），不落盘不返回前端。

use std::sync::Arc;
use std::time::Duration;

use serde_json::json;

use crate::store::Store;

/// 判定超时：超时视为判定失败（回退人工审批）。
const JUDGE_TIMEOUT: Duration = Duration::from_secs(10);

/// 判定提示词：危险边界明确列举，输出严格 JSON（{dangerous, reason}）。
const SYSTEM_PROMPT: &str = r#"你是 AIShell 的 AI 助手操作安全审查器。根据 AI 助手发起的工具调用信息，判断该操作是否危险。

危险操作包括但不限于：
- 删除/覆盖/移动文件或目录（含 rm、mv、删除数据库/日志/备份）；
- 格式化磁盘、清空文件内容、截断文件（truncate、dd 等破坏性写入）；
- 启动/停止/重启服务或守护进程（systemctl、service、supervisorctl 等），重启/关机/睡眠；
- 修改文件权限、属主、ACL（chmod、chown）或执行提权操作（sudo 高风险命令）；
- 下载并执行未知来源的脚本或二进制（curl|sh、wget|bash、安装来历不明的包）；
- 清空数据库表、生产环境数据变更、批量修改配置；
- 推送/强推/删除远程 git 分支、覆盖他人工作、git reset --hard 等破坏性操作。

以下操作视为安全：
- 在项目目录内读取/新建/修改普通代码、文档、配置文件（write/edit 常规文件、创建目录）；
- 常规查询、构建、测试、格式检查（ls、cat、grep、npm/cargo build、test、lint）；
- 常规 git 操作（status、add、commit、log、diff、pull、checkout 普通分支、push 新分支）；
- 启动/停止项目内普通开发进程（如 dev server）、查看进程/端口、网络探测类只读命令。

只输出一个 JSON 对象，不要输出任何其他内容，格式：
{"dangerous": true 或 false, "reason": "一句中文理由"}"#;

/// 判定一次受控工具调用是否危险。
/// 返回 `Ok((dangerous, reason))`：dangerous=true 需人工审批，false 直接放行；
/// `Err` 表示判定失败（网络/状态码/解析），调用方按人工审批处理。
pub async fn judge(
    store: &Arc<Store>,
    action: &str,
    intent: &str,
    summary: &str,
) -> Result<(bool, String), String> {
    let api_key = store
        .read_secret("llm:apikey")
        .map_err(|_| "未配置 API Key，无法智能审批".to_string())?;
    let cfg = store.llm_config();
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let body = json!({
        "model": cfg.model_id,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": format!(
                "工具调用信息：\n工具：{action}\n意图：{intent}\n详情：{summary}"
            )},
        ],
        "temperature": 0,
        "max_tokens": 300,
        "reasoning_effort": "low",
    });
    let client = reqwest::Client::builder()
        .timeout(JUDGE_TIMEOUT)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("审批判定请求失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("审批判定接口返回 HTTP {}", resp.status()));
    }
    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("审批判定响应解析失败: {e}"))?;
    let content = data["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or("");
    parse_judgement(content)
}

/// 从模型输出中提取判定 JSON：宽松提取首个 `{` 到最后一个 `}`（容忍围栏/前后说明文字）。
/// 单独成函数便于单测。
pub fn parse_judgement(text: &str) -> Result<(bool, String), String> {
    let start = text.find('{').ok_or("判定结果缺少 JSON")?;
    let end = text.rfind('}').ok_or("判定结果缺少 JSON")?;
    let v: serde_json::Value = serde_json::from_str(&text[start..=end])
        .map_err(|e| format!("判定结果 JSON 解析失败: {e}"))?;
    let dangerous = v
        .get("dangerous")
        .and_then(serde_json::Value::as_bool)
        .ok_or("判定结果缺少 dangerous 布尔字段")?;
    let reason = v
        .get("reason")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok((dangerous, reason))
}

#[cfg(test)]
mod tests {
    use super::parse_judgement;

    #[test]
    fn parse_plain_json() {
        assert_eq!(
            parse_judgement(r#"{"dangerous": false, "reason": "常规查询"}"#).unwrap(),
            (false, "常规查询".to_string())
        );
        assert_eq!(
            parse_judgement(r#"{"dangerous": true, "reason": "删除文件"}"#).unwrap(),
            (true, "删除文件".to_string())
        );
    }

    #[test]
    fn parse_with_surrounding_text() {
        // 模型偶发在 JSON 前后附加说明：宽松提取首个 { 到最后一个 }
        let text = "好的，分析如下：\n```json\n{\"dangerous\": true, \"reason\": \"rm -rf 删除目录\"}\n```\n结论如上。";
        assert_eq!(
            parse_judgement(text).unwrap(),
            (true, "rm -rf 删除目录".to_string())
        );
    }

    #[test]
    fn parse_missing_fields() {
        assert!(parse_judgement(r#"{"dangerous": "yes"}"#).is_err());
        assert!(parse_judgement(r#"{"reason": "无判定字段"}"#).is_err());
        assert!(parse_judgement("没有任何 JSON").is_err());
    }
}
