//! 输出脱敏：命令结果、终端快照、文件引用等内容在进入 LLM 上下文与落盘前屏蔽凭据。
//!
//! 两类规则：
//! 1. 键值形态：key 含 password|passwd|pwd|secret|token|api_key|requirepass 等（`\w*` 前后缀
//!    兼容 db_password / main_server_pwd / redis_password 等变体），支持 `k=v`、`k: v`、
//!    `"k":"v"`、单双引号与裸值；redis 配置的 `requirepass <值>`（空格分隔）单列。
//! 2. 已知密钥字面量：keyring 中的服务器密码与 API Key（长度 ≥4 才替换，避免误伤短词）。
//!
//! 边界：防「顺带泄露」不防主动绕过（base64/分段读取等编码通道不在规则覆盖内）——
//! 意图层约束见 ai.rs 系统提示的凭据纪律，门禁层见 smart_approval 的凭据前置规则。

use std::sync::LazyLock;

use regex::Regex;

/// 脱敏标记：已同步写进系统提示，模型见到应停止而非绕过（见 ai.rs 凭据纪律）。
pub const MASK: &str = "***已脱敏***";

/// 凭据键名（大小写不敏感；前后缀变体如 db_password / main_server_pwd 均命中）。
/// 不含 pwd 单词外的短词（user/account 等不算凭据）。
const KEY: &str = r"\w*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|requirepass|masterauth)\w*";

/// 双引号值：`db_password="xxx"` / `"api_key": "xxx"`
static RE_DOUBLE_QUOTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)({KEY}["']?\s*[:=]\s*")([^"\r\n]{{1,256}})(")"#
    ))
    .unwrap()
});

/// 单引号值：`db_password='xxx'`
static RE_SINGLE_QUOTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)({KEY}["']?\s*[:=]\s*')([^'\r\n]{{1,256}})(')"#
    ))
    .unwrap()
});

/// 裸值：`db_password=xxx` / `token: xxx`（值到空白/常见分隔符为止，≥2 字符降低误报）
static RE_BARE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"(?i)({KEY}["']?\s*[:=]\s*)([^\s,;&|"'`]{{2,256}})"#
    ))
    .unwrap()
});

/// redis 配置的空格分隔形态：`requirepass xxx` / `masterauth xxx`（空白收进组 1，替换不丢分隔）
static RE_SPACE_SEP: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b((?:requirepass|masterauth)\s+)(\S{2,256})").unwrap());

/// 对文本脱敏：返回 (脱敏后文本, 替换处数)。幂等：已脱敏内容再次处理结果不变。
///
/// 流程：先按键值规则替换；再做「值收集」——把本文本里 KV 形态出现的值当作临时密钥，
/// 掩盖其裸文本形态（命令行 `-p'值'`、正文复述等跨行重复出现）。known_secrets 为外部
/// 已知密钥（keyring 的服务器密码 / API Key）。
pub fn redact_secrets(text: &str, known_secrets: &[String]) -> (String, usize) {
    let mut count = 0usize;
    let mut out = text.to_string();
    // (正则, 替换模板)：模板保留键名与闭合界符，只抹掉值（${1}=键+分隔+开引号，${3}=闭引号）
    let rules: [(&LazyLock<Regex>, &str); 4] = [
        (&RE_DOUBLE_QUOTED, "${1}***已脱敏***${3}"),
        (&RE_SINGLE_QUOTED, "${1}***已脱敏***${3}"),
        (&RE_BARE, "${1}***已脱敏***"),
        (&RE_SPACE_SEP, "${1}***已脱敏***"),
    ];
    // 值收集先于替换（替换后只能看到 MASK）；随后与外部已知密钥一起按字面量掩盖
    let mut literals: Vec<String> = known_secrets.to_vec();
    harvest_secrets(text, &mut literals);
    for (re, template) in rules {
        // 空值（password=""）不匹配；已脱敏值保持原样但计入，幂等
        count += re.captures_iter(&out).count();
        out = re.replace_all(&out, template).into_owned();
    }
    for secret in &literals {
        if secret.len() < 4 {
            continue;
        }
        let hits = out.matches(secret.as_str()).count();
        if hits > 0 {
            out = out.replace(secret.as_str(), MASK);
            count += hits;
        }
    }
    (out, count)
}

/// 从文本的 KV 形态中收集凭据值（追加到 out，调用方负责去重）。
/// 过滤：长度 <6、纯数字/点分（IP、版本号）、MASK 本身、纯星号——降低误伤面。
pub fn harvest_secrets(text: &str, out: &mut Vec<String>) {
    for re in [
        &*RE_DOUBLE_QUOTED,
        &*RE_SINGLE_QUOTED,
        &*RE_BARE,
        &*RE_SPACE_SEP,
    ] {
        for caps in re.captures_iter(text) {
            let v = caps[2].to_string();
            if v.len() < 6
                || v == MASK
                || v.chars().all(|c| c == '*')
                || v.chars().all(|c| c.is_ascii_digit() || c == '.')
            {
                continue;
            }
            out.push(v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn redact(text: &str) -> (String, usize) {
        redact_secrets(text, &[])
    }

    #[test]
    fn masks_quoted_kv_and_preserves_key() {
        let (out, n) = redact(r#"db_password="Srun4000@srun.com""#);
        assert_eq!(out, r#"db_password="***已脱敏***""#);
        assert_eq!(n, 1);
    }

    #[test]
    fn masks_prefixed_key_variants() {
        let (out, n) = redact("main_server_pwd=\"abc123\"\nredis_password=\"xyz789\"");
        assert!(!out.contains("abc123") && !out.contains("xyz789"));
        assert!(out.contains("main_server_pwd=") && out.contains("redis_password="));
        assert_eq!(n, 2);
    }

    #[test]
    fn keeps_empty_value_visible() {
        // 空密码是有用信息（说明未设密码），不应被脱敏成"看似有值"
        let (out, n) = redact(r#"db_password="""#);
        assert_eq!(out, r#"db_password="""#);
        assert_eq!(n, 0);
    }

    #[test]
    fn masks_bare_and_yaml_forms() {
        let (out, n) = redact("token: abc123def\napi_key=sk-abcdef");
        assert_eq!(out, "token: ***已脱敏***\napi_key=***已脱敏***");
        assert_eq!(n, 2);
    }

    #[test]
    fn masks_json_form() {
        let (out, n) = redact(r#"{"db_user":"icc","db_password":"Srun4000@srun.com"}"#);
        assert!(out.contains(r#""db_user":"icc""#), "用户名非凭据应保留");
        assert!(!out.contains("Srun4000@srun.com"));
        assert_eq!(n, 1);
    }

    #[test]
    fn masks_redis_requirepass_line() {
        let (out, n) = redact("requirepass srun_3000@redis");
        assert_eq!(out, "requirepass ***已脱敏***");
        assert_eq!(n, 1);
    }

    #[test]
    fn harvests_kv_values_and_masks_bare_repetition() {
        // 同一凭据的裸文本形态：命令行 -p'值'、正文复述，均应被值收集掩盖
        let text = "db_password=\"Srun4000@srun.com\"\n正文复述：密码 Srun4000@srun.com 请保管好\nmysql -uicc -p'Srun4000@srun.com' -e 'select 1'";
        let (out, n) = redact(text);
        assert!(!out.contains("Srun4000@srun.com"));
        assert!(out.contains("mysql -uicc -p'***已脱敏***'"));
        assert!(n >= 3);
    }

    #[test]
    fn harvest_skips_short_numeric_and_masked_values() {
        // 短值/纯数字/IP 不参与值收集，避免误伤正文普通词
        let text = "password=\"1234\"\ntoken=\"***已脱敏***\"\n普通文本 1234 保留";
        let (out, _) = redact(text);
        assert!(out.contains("普通文本 1234 保留"));
    }

    #[test]
    fn masks_known_secret_literals_anywhere() {
        let known = vec!["Srun4000@srun.com".to_string(), "sk".to_string()];
        let (out, n) = redact_secrets("mysql -uicc -p'Srun4000@srun.com' -e 'select 1'", &known);
        assert!(!out.contains("Srun4000@srun.com"));
        assert_eq!(n, 1, "sk 长度 <4 不应参与替换");
    }

    #[test]
    fn leaves_normal_output_untouched() {
        let text =
            "Filesystem Size Used Avail Use%\ndevtmpfs 16G 0 16G 0%\ndb_user=icc\ndb_port=3506";
        let (out, n) = redact(text);
        assert_eq!(out, text);
        assert_eq!(n, 0);
    }

    #[test]
    fn idempotent_on_already_masked() {
        let once = redact(r#"db_password="Srun4000@srun.com""#).0;
        let twice = redact(&once).0;
        assert_eq!(once, twice);
    }

    #[test]
    fn masks_inside_log_lines() {
        let line = r#"2026-08-09 conn failed: password="hunter2" retry=3"#;
        let (out, n) = redact(line);
        assert!(!out.contains("hunter2"));
        assert!(out.contains("retry=3"));
        assert_eq!(n, 1);
    }
}
