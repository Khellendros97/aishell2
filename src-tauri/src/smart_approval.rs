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
use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
use serde_json::json;

use crate::store::Store;

/// 判定超时：超时视为判定失败（回退人工审批）。
const JUDGE_TIMEOUT: Duration = Duration::from_secs(10);

/// 凭据文件（basename 形态）：命中即人工审批。普通 *.conf 读取不拦，避免审批疲劳——
/// 配置内容里的密码由 redact 在输出侧脱敏兜底。
static RE_CRED_FILE_BASE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?:^|[\s/"'=])[\w./-]*(?:rad_db_setup\.conf|redis_acl\.conf|my\.cnf|\.netrc|\.pgpass|\.env|htpasswd|id_rsa|id_dsa|id_ed25519|shadow|gshadow)\b"#,
    )
    .unwrap()
});

/// 凭据文件（srun 部署 etc/ 路径锚定）：/srun3/etc/srun.conf、/srun3/etc/system.conf 等。
static RE_CRED_FILE_ETC: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)etc/(?:srun\.conf|system\.conf)\b").unwrap());

/// 密钥材料扩展名：ssl.key、ca.pem、*.p12/*.pfx/*.keystore/*.jks。
static RE_CRED_EXT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)(?:^|[\s/"'=])[\w./-]*\.(?:key|pem|p12|pfx|keystore|jks)(?:\s|$|["')|;&`])"#).unwrap()
});

/// 检索/提取工具名。
static RE_TOOL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:grep|egrep|fgrep|rg|sed|awk|gawk|mawk|perl|ruby|python\d*|strings|jq|yq)\b").unwrap()
});

/// 凭据关键词（提取/注入判定共用；pwd 太常用故不收）。
static RE_CRED_WORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:passw[o0]rd|passwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|requirepass|masterauth)")
        .unwrap()
});

/// 命令替换携带凭据：`-p'$(grep … password …)'`、`$(cat db_secret)` 等。
static RE_SUBST: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\$\([^)]{0,300}?(?:passw[o0]rd|passwd|secret|token|api[_-]?key|requirepass|masterauth)")
        .unwrap()
});

/// 凭据前置规则（确定性，先于 LLM 判定）：命中即视为危险转人工审批。
/// 三类：已知凭据文件、命令替换注入凭据、检索工具+凭据关键词的提取形态。
/// 普通 cat/读配置不命中——由 redact 输出脱敏兜底，避免审批疲劳。
pub fn precheck_credential_access(command: &str) -> Option<String> {
    if let Some(m) = RE_CRED_FILE_BASE.find(command).or_else(|| RE_CRED_FILE_ETC.find(command)).or_else(|| RE_CRED_EXT.find(command)) {
        return Some(format!("命令涉及凭据文件（{}），读取需人工确认", m.as_str().trim()));
    }
    if RE_SUBST.is_match(command) {
        return Some("命令将凭据内容注入命令行（命令替换），需人工确认".to_string());
    }
    if RE_TOOL.is_match(command) && RE_CRED_WORD.is_match(command) {
        return Some("命令疑似提取凭据（检索工具+凭据关键词），需人工确认".to_string());
    }
    None
}

/// 判定提示词：危险边界明确列举，输出严格 JSON（{dangerous, reason}）。
const SYSTEM_PROMPT: &str = r#"你是 AIShell 的 AI 助手操作安全审查器。根据 AI 助手发起的工具调用信息，判断该操作是否危险。

危险操作包括但不限于：
- 删除/覆盖/移动文件或目录（含 rm、mv、删除数据库/日志/备份）；
- 格式化磁盘、清空文件内容、截断文件（truncate、dd 等破坏性写入）；
- 启动/停止/重启服务或守护进程（systemctl、service、supervisorctl 等），重启/关机/睡眠；
- 修改文件权限、属主、ACL（chmod、chown）或执行提权操作（sudo 高风险命令）；
- 下载并执行未知来源的脚本或二进制（curl|sh、wget|bash、安装来历不明的包）；
- 清空数据库表、生产环境数据变更、批量修改配置；
- 推送/强推/删除远程 git 分支、覆盖他人工作、git reset --hard 等破坏性操作；
- 读取或提取密码、密钥、Token 等凭据内容（含从配置文件、二进制、环境变量中检索凭据）。

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
    // 凭据前置规则：确定性命中即转人工，不消耗 LLM 判定请求（offline、零误放行）。
    if let Some(reason) = precheck_credential_access(summary) {
        return Ok((true, reason));
    }
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
    use super::{parse_judgement, precheck_credential_access};

    #[test]
    fn precheck_flags_qa01_real_command() {
        // QA-01 实测形态：命令替换从配置文件提取密码拼进 mysql 参数
        let cmd = r#"执行命令（远程(srv-uhc04e)）：mysql -uroot -p'$(grep -oP "(?<=password=).*" /srun3/etc/rad_db_setup.conf 2>/dev/null)' -e "SELECT 1""#;
        assert!(precheck_credential_access(cmd).is_some());
    }

    #[test]
    fn precheck_flags_named_credential_files() {
        for cmd in [
            "cat /srun3/etc/srun.conf",
            "cat /srun3/etc/system.conf",
            "less /srun4k/etc/system.conf",
            "cat /srun3/etc/rad_db_setup.conf",
            "cat /srun3/etc/redis_acl.conf",
            "cat /root/.my.cnf",
            "cat /app/.env",
            "cat /etc/shadow",
            "cat /root/.ssh/id_rsa",
            "cat /srun3/etc/ssl.key",
            "cat ca.pem",
            "grep -i user /srun3/etc/srun.conf.bak",
        ] {
            assert!(precheck_credential_access(cmd).is_some(), "应拦截: {cmd}");
        }
    }

    #[test]
    fn precheck_flags_extraction_patterns() {
        for cmd in [
            "strings /srun3/bin/rad_auth | grep -i password",
            "grep -rn secret /srun3/www",
            "sed -n /token/p app.log",
            "echo $(cat db_secret)",
            "mysql -p$(cat /root/pw_token.txt) -e 'select 1'",
        ] {
            assert!(precheck_credential_access(cmd).is_some(), "应拦截: {cmd}");
        }
    }

    #[test]
    fn precheck_allows_normal_ops_reads() {
        for cmd in [
            "执行命令（远程(srv-uhc04e)）：cat /srun3/etc/flow_log.conf",
            "grep drop_cause /srun3/log/rad_auth/2026-08-05.log",
            "df -h",
            "tail -20 /srun3/log/watch_bas.log",
            "ls /srun3/etc/",
            "cat /srun3/etc/netmgr.conf",
            "pwd",
            "echo $HOME",
        ] {
            assert!(precheck_credential_access(cmd).is_none(), "应放行: {cmd}");
        }
    }

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
