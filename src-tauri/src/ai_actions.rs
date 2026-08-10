//! AI 动作执行桥 —— AI 发起动作的唯一后端入口。
//! 由 pi 门控扩展（aishell-guard.ts）经 RPC extension UI 内部协议（`AISHELL_ACTION:`）调用；
//! **禁止从前端直接调用普通 fs_* / term_input / sftp_* 代执行**。
//!
//! 硬边界（独立于扩展的二次校验）：
//! - 项目必须存在且 project.path 已配置、目录真实存在；
//! - 本地路径经词法归一（`.`, `..`）后必须位于项目根内（Windows 大小写不敏感前缀比较）；
//! - 远程动作在打开/复用连接**前**读取最新 `Store::server(id)`：不存在或 `locked` 直接拒绝。
//!   锁检查只放在本模块入口，不下沉到 SshManager——锁定不会关闭已有用户终端，
//!   也不影响用户手动 SSH/SFTP；动作开始后再切锁不强杀已在运行的单次动作。
//!
//! stdout/stderr/退出码；远程命令复用 `SshManager::exec_with_timeout`（russh channel，连接复用）。
//! run_command 默认 10 秒超时，模型可用 timeoutSeconds 覆盖（1–3600 秒）。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use crate::ssh::SshManager;
use crate::store::{DbKind, Store};

const DEFAULT_RUN_COMMAND_TIMEOUT_SECS: u64 = 10;
const MAX_RUN_COMMAND_TIMEOUT_SECS: u64 = 3600;

/// 命令执行结果（serde camelCase：stdout / stderr / exitCode / timedOut）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    /// 未收到 ExitStatus（通道异常关闭等）时为 null
    pub exit_code: Option<i32>,
    /// 整体执行是否触发调用方设置的超时。
    pub timed_out: bool,
}

/// AI 动作执行器（由 AiManager 持有并复用 Store + SshManager）。
pub struct AiActions {
    store: Arc<Store>,
    ssh: Arc<SshManager>,
}

impl AiActions {
    pub fn new(store: Arc<Store>, ssh: Arc<SshManager>) -> Self {
        AiActions { store, ssh }
    }

    /// 执行命令：target=local 走本地 shell（项目根 cwd），target=remote 走 SshManager。
    /// 空命令 / 空 intent / 非法超时在建进程或网络前拒绝；未传超时默认 10 秒。
    pub async fn run_command(
        &self,
        project_id: &str,
        intent: String,
        command: String,
        target: String,
        server_id: Option<String>,
        timeout_seconds: Option<u64>,
    ) -> Result<CommandResult, String> {
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err("命令不能为空".to_string());
        }
        if intent.trim().is_empty() {
            return Err("intent 不能为空，请说明命令意图".to_string());
        }
        let timeout = command_timeout(timeout_seconds)?;
        match target.as_str() {
            "local" => {
                if server_id.is_some() {
                    return Err("本地目标不得使用 serverId".to_string());
                }
                let root = self.project_root(project_id)?;
                self.run_local(&root, &command, timeout).await
            }
            "remote" => {
                let sid =
                    server_id.ok_or_else(|| "远程目标必须提供 serverId".to_string())?;
                self.ensure_ai_allowed(&sid)?;
                let result = self.ssh.exec_with_timeout(&sid, &command, timeout).await?;
                if result.timed_out {
                    return Err(format!(
                        "命令执行超时（{} 秒），已尝试终止远端命令",
                        timeout.as_secs()
                    ));
                }
                Ok(result)
            }
            other => Err(format!("未知命令目标：{other}")),
        }
    }

    /// SFTP 上传：本地源必须在项目根内且已存在（文件或目录），远端目录必填。
    /// overwrite=true 时远端同名直接覆盖；false 时重名自动创建副本。
    /// 返回给模型的落地说明：明确远端文件名，创建副本时显式提示。
    pub async fn sftp_upload(
        &self,
        project_id: &str,
        server_id: String,
        local_path: String,
        remote_dir: String,
        overwrite: bool,
    ) -> Result<String, String> {
        if local_path.trim().is_empty() {
            return Err("本地路径不能为空".to_string());
        }
        if remote_dir.trim().is_empty() {
            return Err("远端目录不能为空".to_string());
        }
        let root = self.project_root(project_id)?;
        self.ensure_ai_allowed(&server_id)?;
        let local = self.resolve_inside(&root, Path::new(&local_path))?;
        let md = std::fs::metadata(&local)
            .map_err(|e| format!("读取本地 {} 失败：{e}", local.display()))?;
        if !md.is_file() && !md.is_dir() {
            return Err(format!("上传源既不是文件也不是目录：{}", local.display()));
        }
        let sftp = self.ssh.open_sftp(&server_id).await?;
        let landed = crate::sftp::upload_one(&sftp, &local, &remote_dir, overwrite).await?;
        let full = format!(
            "{}/{}",
            remote_dir.trim_end_matches('/'),
            landed
        );
        // 顶层落地名与本地文件名不同 = 远端已有同名 → 自动创建了副本（upload_one 返回的落地名）
        let base_name = local
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if !overwrite && landed != base_name {
            Ok(format!("远端已存在同名文件，已创建副本：{full}（服务器 {server_id}）"))
        } else if overwrite {
            Ok(format!("上传完成（已覆盖远端同名文件）：{full}（服务器 {server_id}）"))
        } else {
            Ok(format!("上传完成：{full}（服务器 {server_id}）"))
        }
    }

    /// SFTP 下载：本地目标目录必须在项目根内且**已存在**（AI 不自动创建目录）。
    pub async fn sftp_download(
        &self,
        project_id: &str,
        server_id: String,
        remote_path: String,
        local_dir: String,
    ) -> Result<(), String> {
        if remote_path.trim().is_empty() {
            return Err("远端路径不能为空".to_string());
        }
        if local_dir.trim().is_empty() {
            return Err("本地目录不能为空".to_string());
        }
        let root = self.project_root(project_id)?;
        self.ensure_ai_allowed(&server_id)?;
        let dir = self.resolve_inside(&root, Path::new(&local_dir))?;
        let md = std::fs::metadata(&dir)
            .map_err(|e| format!("读取本地目录 {} 失败：{e}", dir.display()))?;
        if !md.is_dir() {
            return Err(format!("下载目标不是目录：{}", dir.display()));
        }
        let sftp = self.ssh.open_sftp(&server_id).await?;
        crate::sftp::download_one(&sftp, &remote_path, &dir)
            .await
            .map(|_| ())
    }

    /// 查询项目绑定的可操作服务器列表（只读；供 LLM 在远程动作前确认 serverId）。
    /// 输出含锁定状态标注；不返回密钥/密钥路径等敏感字段。
    pub fn list_servers(&self, project_id: &str) -> Result<String, String> {
        let project = self
            .store
            .project(project_id)
            .ok_or_else(|| format!("项目不存在：{project_id}"))?;
        let mut lines: Vec<String> = Vec::new();
        for sid in &project.server_ids {
            if let Some(sv) = self.store.server(sid) {
                let status = if sv.locked {
                    "已锁定（AI 无法执行远程操作）".to_string()
                } else {
                    "可用".to_string()
                };
                let auth = match sv.auth_type {
                    crate::store::AuthType::Password => "密码",
                    crate::store::AuthType::Key => "密钥",
                };
                lines.push(format!(
                    "- serverId={}，名称={}，地址={}:{}，用户={}，认证={}，状态={}",
                    sv.id, sv.name, sv.host, sv.port, sv.username, auth, status
                ));
                // 数据库连接（AI 受管查询通道）：connectionId 供 db_query 使用；禁用的连接对 AI 不可见
                let conns = self.store.db_connections(sid);
                let enabled: Vec<_> = conns.iter().filter(|c| c.enabled).collect();
                if enabled.is_empty() {
                    let note = if conns.is_empty() {
                        "无（需用户先在「服务器设置-数据库连接」中配置，AI 才能 db_query）".to_string()
                    } else {
                        format!("无启用中的连接（{} 条已禁用）", conns.len())
                    };
                    lines.push(format!("  - 数据库连接：{note}"));
                } else {
                    for c in &enabled {
                        let db = if c.database.is_empty() { "-".to_string() } else { c.database.clone() };
                        lines.push(format!(
                            "  - 数据库连接 connectionId={}，名称={}，类型={}，地址={}:{}，默认库={}，AI 可执行命令={}",
                            c.id,
                            c.name,
                            c.kind.as_str(),
                            c.host,
                            c.port,
                            db,
                            c.effective_commands().join("/")
                        ));
                    }
                }
            }
        }
        if lines.is_empty() {
            return Ok("项目未绑定任何远程服务器".to_string());
        }
        let mut text = format!("项目绑定服务器（{} 台）：\n{}", lines.len(), lines.join("\n"));
        text.push_str("\n提示：远程 run_command / sftp_upload / sftp_download 请使用上述 serverId；锁定服务器会返回「已锁定」错误。数据库查询用 db_query，connectionId 取上述「数据库连接」条目中的 connectionId。");
        Ok(text)
    }

    /// AI 受管数据库查询（db_query 工具的执行体）：
    /// 凭据由系统代管（keyring `db:<serverId>:<connId>`），经 SSH 在服务器本机执行客户端，
    /// 连接目标恒为服务器本机（数据库只对 127.0.0.1 开放也天然可达）。
    /// 命令白名单（连接配置，默认只读集）在此最终裁决；白名单外一律拒绝。
    pub async fn db_query(
        &self,
        server_id: String,
        connection_id: String,
        command: String,
    ) -> Result<CommandResult, String> {
        self.ensure_ai_allowed(&server_id)?;
        let conn = self
            .store
            .db_connection(&server_id, &connection_id)
            .ok_or_else(|| format!("数据库连接不存在：{connection_id}"))?;
        if !conn.enabled {
            return Err(format!(
                "数据库连接「{}」已禁用，请在「服务器设置-数据库连接」中启用",
                conn.name
            ));
        }
        let allowed = conn.effective_commands();
        validate_db_command(conn.kind, &command, &allowed)?;
        let pass = self
            .store
            .db_secret(&server_id, &connection_id)
            .map_err(|_| format!("数据库连接「{}」未配置密码，请先在服务器设置中配置", conn.name))?;
        let command = match conn.kind {
            DbKind::Mysql => embed_script(
                &[
                    ("DB_HOST", conn.host.as_str()),
                    ("DB_PORT", &conn.port.to_string()),
                    ("DB_USER", conn.user.as_str()),
                    ("DB_PASS", pass.as_str()),
                    ("DB_NAME", conn.database.as_str()),
                    ("DB_SQL", command.as_str()),
                ],
                MYSQL_SCRIPT_BODY,
                &[],
            ),
            DbKind::Clickhouse => embed_script(
                &[
                    ("CH_HOST", conn.host.as_str()),
                    ("CH_PORT", &conn.port.to_string()),
                    ("CH_USER", conn.user.as_str()),
                    ("CH_PASS", pass.as_str()),
                    ("CH_DB", conn.database.as_str()),
                    ("CH_SQL", command.as_str()),
                ],
                CLICKHOUSE_SCRIPT_BODY,
                &[],
            ),
            DbKind::Redis => embed_script(
                &[
                    ("R_HOST", conn.host.as_str()),
                    ("R_PORT", &conn.port.to_string()),
                    ("R_CMD", command.as_str()),
                    // 密码经 shell 内 export 传给 redis-cli（REDISCLI_AUTH 官方防泄漏通道，不进 argv）
                    ("REDISCLI_AUTH", pass.as_str()),
                ],
                REDIS_SCRIPT_BODY,
                &["REDISCLI_AUTH"],
            ),
        };
        self.ssh.exec(&server_id, &command).await
    }

    /* ---------- 内部 ---------- */

    /// 项目根：项目存在且路径已配置、目录真实存在。
    fn project_root(&self, project_id: &str) -> Result<PathBuf, String> {
        let path = self
            .store
            .project_path(project_id)
            .ok_or_else(|| format!("项目不存在：{project_id}"))?;
        let root = PathBuf::from(&path);
        if !root.is_dir() {
            return Err(format!("项目目录不存在：{path}"));
        }
        Ok(root)
    }

    /// 解析（相对项目根 / 绝对）并归一（`.`、`..`）后校验位于项目根内。
    fn resolve_inside(&self, root: &Path, target: &Path) -> Result<PathBuf, String> {
        let full = if target.is_absolute() {
            target.to_path_buf()
        } else {
            root.join(target)
        };
        let normalized = normalize_path(&full);
        ensure_inside(root, &normalized)?;
        Ok(normalized)
    }

    /// 本地命令：本地 shell `--login -c`，项目根 cwd，完整捕获 stdout/stderr/exit code；
    /// `kill_on_drop` 保证 timeout 丢弃 wait future 时终止子进程，避免后台残留。
    async fn run_local(
        &self,
        root: &Path,
        command: &str,
        timeout: Duration,
    ) -> Result<CommandResult, String> {
        let shell = crate::term::find_shell().ok_or_else(crate::term::shell_missing_msg)?;
        let mut cmd = tokio::process::Command::new(&shell);
        cmd.args(["--login", "-c", command])
            .current_dir(root)
            .kill_on_drop(true);
        // Windows 下隐藏 Git Bash 的临时控制台窗口（与 ai.rs 的 pi 启动一致）
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let out = tokio::time::timeout(timeout, cmd.output())
            .await
            .map_err(|_| {
                format!(
                    "命令执行超时（{} 秒），已尝试终止本地命令",
                    timeout.as_secs()
                )
            })?
            .map_err(|e| format!("启动本地 shell 失败：{e}"))?;
        Ok(CommandResult {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            exit_code: out.status.code(),
            timed_out: false,
        })
    }

    /// 远程动作前的锁检查（只放本模块入口）。
    fn ensure_ai_allowed(&self, server_id: &str) -> Result<(), String> {
        let server = self
            .store
            .server(server_id)
            .ok_or_else(|| format!("服务器不存在：{server_id}"))?;
        if server.locked {
            return Err(format!(
                "服务器「{}」已锁定，AI 无权执行远程操作",
                server.name
            ));
        }
        Ok(())
    }
}

/// 词法归一：折叠 `.` 与 `..`（不触碰磁盘，纯路径计算）。
fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// run_command 超时：未传使用 10 秒，避免命令无界挂起；显式值限制为 1–3600 秒。
fn command_timeout(timeout_seconds: Option<u64>) -> Result<Duration, String> {
    let seconds = timeout_seconds.unwrap_or(DEFAULT_RUN_COMMAND_TIMEOUT_SECS);
    if !(1..=MAX_RUN_COMMAND_TIMEOUT_SECS).contains(&seconds) {
        return Err(format!(
            "timeoutSeconds 必须在 1–{MAX_RUN_COMMAND_TIMEOUT_SECS} 秒之间"
        ));
    }
    Ok(Duration::from_secs(seconds))
}

/// 项目根内判断：统一小写前缀比较（Windows 大小写不敏感）。
fn ensure_inside(root: &Path, target: &Path) -> Result<(), String> {
    let root_l = root.to_string_lossy().to_lowercase();
    let target_l = target.to_string_lossy().to_lowercase();
    let sep = std::path::MAIN_SEPARATOR;
    if target_l == root_l || target_l.starts_with(&format!("{root_l}{sep}")) {
        Ok(())
    } else {
        Err(format!(
            "AIShell 权限边界：目标不在项目目录内（{}）",
            target.display()
        ))
    }
}

// ---------------------------------------------------------------- 受管数据库查询

/// 值经 base64 内嵌进命令串（base64 字符集对 shell 安全，无注入面；不依赖 SSH env——
/// OpenSSH 默认 AcceptEnv 为空，set_env 会被服务端静默丢弃，实测 env 全丢导致连接参数失效）。
fn b64(v: &str) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(v)
}

/// mysql/mariadb 执行：临时 defaults-file（0600）承载凭据（ps 不可见）并**独占**（--defaults-file
/// 不读 ~/.my.cnf，避免其 [client] user=root 覆盖连接用户，实测坑）；SQL 走临时文件，用完即删。
/// 客户端 PATH 无关探测（command -v 失败时在 /srun3、/usr、/opt 常见部署目录查找）。
const MYSQL_SCRIPT_BODY: &str = r#"CFG=$(mktemp /tmp/aishell-db.XXXXXX.conf); SQL=$(mktemp /tmp/aishell-db.XXXXXX.sql); chmod 600 "$CFG" "$SQL"; printf '[client]\nhost=%s\nport=%s\nuser=%s\npassword=%s\n' "$DB_HOST" "$DB_PORT" "$DB_USER" "$DB_PASS" > "$CFG"; printf '%s' "$DB_SQL" > "$SQL"; CLI=$(command -v mariadb 2>/dev/null || command -v mysql 2>/dev/null || find /srun3 /usr/local/bin /usr/bin /opt -maxdepth 4 \( -name mariadb -o -name mysql \) -type f 2>/dev/null | head -1); if [ -z "$CLI" ]; then echo "数据库客户端未找到（mariadb/mysql），请确认服务器已安装" >&2; rm -f "$CFG" "$SQL"; exit 127; fi; if [ -n "$DB_NAME" ]; then timeout 60 "$CLI" --defaults-file="$CFG" -D "$DB_NAME" < "$SQL"; else timeout 60 "$CLI" --defaults-file="$CFG" < "$SQL"; fi; RC=$?; rm -f "$CFG" "$SQL"; exit $RC"#;

/// clickhouse-client 执行：临时 config.xml（0600）承载凭据，SQL 走 stdin；客户端 PATH 无关探测。
const CLICKHOUSE_SCRIPT_BODY: &str = r#"CFG=$(mktemp /tmp/aishell-db-ch.XXXXXX.xml); SQL=$(mktemp /tmp/aishell-db-ch.XXXXXX.sql); chmod 600 "$CFG" "$SQL"; printf '<config><host>%s</host><port>%s</port><user>%s</user><password>%s</password><database>%s</database></config>' "$CH_HOST" "$CH_PORT" "$CH_USER" "$CH_PASS" "$CH_DB" > "$CFG"; printf '%s' "$CH_SQL" > "$SQL"; CLI=$(command -v clickhouse-client 2>/dev/null || find /srun3 /usr/local/bin /usr/bin /opt -maxdepth 4 -name clickhouse-client -type f 2>/dev/null | head -1); if [ -z "$CLI" ]; then echo "clickhouse-client 未找到，请确认服务器已安装" >&2; rm -f "$CFG" "$SQL"; exit 127; fi; timeout 60 "$CLI" --config-file="$CFG" < "$SQL"; RC=$?; rm -f "$CFG" "$SQL"; exit $RC"#;

/// redis-cli 执行：密码经 REDISCLI_AUTH（shell 内 export，不进 argv）；客户端 PATH 无关探测；
/// 命令按空白拆成独立参数（redis-cli 每个 argv 是一个命令 token，单 argv 多词会被当作
/// 一个未知命令，实测 SCAN 0 COUNT 20 报错）；空命令直接报错防交互挂起；整体 timeout 防通道滞留。
const REDIS_SCRIPT_BODY: &str = r#"if [ -z "$R_CMD" ]; then echo "redis 命令为空" >&2; exit 2; fi; CLI=$(command -v redis-cli 2>/dev/null || find /srun3 /usr/local/bin /usr/bin /opt -maxdepth 4 -name redis-cli -type f 2>/dev/null | head -1); if [ -z "$CLI" ]; then echo "redis-cli 未找到，请确认服务器已安装" >&2; exit 127; fi; read -r -a R_ARGS <<< "$R_CMD"; exec timeout 60 env REDISCLI_AUTH="$REDISCLI_AUTH" "$CLI" -h "$R_HOST" -p "$R_PORT" "${R_ARGS[@]}""#;

/// 把键值对 base64 内嵌为「变量=$(echo '<b64>' | base64 -d)」前缀 + 脚本主体。
/// redis 的 REDISCLI_AUTH 需 export 进环境（子进程可见），其余为普通 shell 变量。
fn embed_script(values: &[(&str, &str)], body: &str, export_keys: &[&str]) -> String {
    let mut s = String::new();
    for (k, v) in values {
        let prefix = if export_keys.contains(k) { "export " } else { "" };
        s.push_str(&format!("{prefix}{k}=$(echo '{}' | base64 -d 2>/dev/null || true); ", b64(v)));
    }
    s.push_str(body);
    s
}

/// 提取命令首词（大写）：SQL/redis 命令关键字均大小写不敏感。
fn first_token_upper(command: &str) -> String {
    command
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_uppercase()
}

/// 命令白名单校验（权威，最终裁决）：
/// - mysql/clickhouse：按 `;` 分段逐段校验首词（防 `SELECT 1; DROP TABLE x` 多语句绕过）；
/// - redis：单命令，首词在白名单且不含 shell 元字符（防御纵深）。
fn validate_db_command(kind: DbKind, command: &str, allowed: &[String]) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("SQL/命令不能为空".to_string());
    }
    let allowed_upper: Vec<String> = allowed.iter().map(|s| s.to_uppercase()).collect();
    let mut segments: Vec<String> = Vec::new();
    match kind {
        DbKind::Mysql | DbKind::Clickhouse => {
            segments = trimmed.split(';').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        }
        DbKind::Redis => {
            // redis 命令不应含 shell 元字符（$ 命令替换、` 反引号、| 管道、&&、; 等）
            if trimmed.contains([';', '|', '&', '>', '<', '`', '$', '(', ')']) {
                return Err("redis 命令包含非法字符（; | & < > 反引号 $ 等），仅允许单条命令".to_string());
            }
            segments.push(trimmed.to_string());
        }
    }
    if segments.is_empty() {

        return Err("SQL/命令不能为空".to_string());
    }
    for seg in &segments {
        let tok = first_token_upper(seg);
        if !allowed_upper.contains(&tok) {
            return Err(format!(
                "命令「{}」不在该连接的允许列表内。允许：{}。如需执行请先在服务器设置-数据库连接中配置",
                tok,
                allowed_upper.join(" / ")
            ));
        }
    }
    Ok(())
}

/// 读/写判定（供 guard 审批分流与测试；只读 = 命令首词在默认只读集中）。
/// 用户扩展白名单里的写命令（如 UPDATE）不在此列——它们由 guard 人工审批放行。
pub fn is_db_read_only(kind: DbKind, command: &str) -> bool {
    let default_read = kind.default_read_commands();
    let tok = first_token_upper(command);
    default_read.iter().any(|c| c.eq_ignore_ascii_case(&tok))
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_collapses_dots_and_parents() {
        let p = normalize_path(Path::new(r"C:\proj\sub\..\a\.\b.txt"));
        assert_eq!(p, PathBuf::from(r"C:\proj\a\b.txt"));
        // 越过根后继续 pop 不 panic（停在根）
        let p2 = normalize_path(Path::new(r"C:\proj\..\..\..\x"));
        assert_eq!(p2, PathBuf::from(r"C:\x"));
        // 相对路径
        let p3 = normalize_path(Path::new(r"sub/../a.txt"));
        assert_eq!(p3, PathBuf::from(r"a.txt"));
    }

    #[test]
    fn command_timeout_defaults_and_validates_bounds() {
        assert_eq!(
            command_timeout(None).unwrap(),
            Duration::from_secs(DEFAULT_RUN_COMMAND_TIMEOUT_SECS)
        );
        assert_eq!(
            command_timeout(Some(30)).unwrap(),
            Duration::from_secs(30)
        );
        assert!(command_timeout(Some(0)).is_err());
        assert!(command_timeout(Some(MAX_RUN_COMMAND_TIMEOUT_SECS + 1)).is_err());
    }

    #[test]
    fn ensure_inside_accepts_descendants_only() {
        let root = Path::new(r"D:\proj");
        assert!(ensure_inside(root, Path::new(r"D:\proj")).is_ok());
        assert!(ensure_inside(root, Path::new(r"D:\proj\src\a.ts")).is_ok());
        // 大小写不敏感（Windows）
        assert!(ensure_inside(root, Path::new(r"d:\PROJ\src\a.ts")).is_ok());
        // 前缀失配：兄弟目录 / 项目外
        assert!(ensure_inside(root, Path::new(r"D:\proj2\a.ts")).is_err());
        assert!(ensure_inside(root, Path::new(r"D:\other\a.ts")).is_err());
        assert!(ensure_inside(root, Path::new(r"D:\proj-x\a.ts")).is_err());
    }

    #[test]
    fn validate_db_command_enforces_whitelist_per_segment() {
        use crate::store::DbKind;
        let allowed: Vec<String> = ["SELECT", "SHOW", "DESC"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        // 合法只读
        assert!(validate_db_command(DbKind::Mysql, "SELECT * FROM online_radius LIMIT 5", &allowed).is_ok());
        assert!(validate_db_command(DbKind::Mysql, "show databases;", &allowed).is_ok());
        assert!(validate_db_command(DbKind::Mysql, "SELECT 1; SELECT 2", &allowed).is_ok());
        // 多语句夹写操作：第二段 DROP 不在白名单 → 拒绝（防绕过）
        assert!(validate_db_command(DbKind::Mysql, "SELECT 1; DROP TABLE users", &allowed).is_err());
        // 首词不在白名单
        assert!(validate_db_command(DbKind::Mysql, "UPDATE t SET a=1", &allowed).is_err());
        assert!(validate_db_command(DbKind::Mysql, "DELETE FROM t", &allowed).is_err());
        // 空命令
        assert!(validate_db_command(DbKind::Mysql, "   ", &allowed).is_err());
    }

    #[test]
    fn validate_db_command_redis_single_command_no_shell_metachars() {
        use crate::store::DbKind;
        let allowed: Vec<String> = ["GET", "KEYS", "HGETALL"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert!(validate_db_command(DbKind::Redis, "GET user:1", &allowed).is_ok());
        assert!(validate_db_command(DbKind::Redis, "KEYS user:*", &allowed).is_ok());
        assert!(validate_db_command(DbKind::Redis, "HGETALL hash:1", &allowed).is_ok());
        // shell 元字符一律拒绝（防管道/命令替换注入）
        assert!(validate_db_command(DbKind::Redis, "GET a | cat /etc/passwd", &allowed).is_err());
        assert!(validate_db_command(DbKind::Redis, "GET a; echo x", &allowed).is_err());
        assert!(validate_db_command(DbKind::Redis, "GET $(id)", &allowed).is_err());
        // 首词不在白名单
        assert!(validate_db_command(DbKind::Redis, "SET a 1", &allowed).is_err());
    }

    #[test]
    fn is_db_read_only_classifies_by_first_token() {
        use crate::store::DbKind;
        assert!(is_db_read_only(DbKind::Mysql, "SELECT 1"));
        assert!(is_db_read_only(DbKind::Mysql, "show tables"));
        assert!(!is_db_read_only(DbKind::Mysql, "UPDATE t SET a=1"));
        assert!(!is_db_read_only(DbKind::Mysql, "INSERT INTO t VALUES (1)"));
        assert!(is_db_read_only(DbKind::Redis, "GET k"));
        assert!(is_db_read_only(DbKind::Redis, "HGETALL h"));
        assert!(!is_db_read_only(DbKind::Redis, "SET k v"));
        assert!(is_db_read_only(DbKind::Clickhouse, "SELECT * FROM t LIMIT 1"));
    }

    #[test]
    fn db_query_rejects_unknown_connection_and_missing_secret() {
        let dir = std::env::temp_dir().join(format!(
            "aishell-ai-actions-db-query-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(crate::store::test_store(dir.clone()));
        store
            .upsert_server(
                crate::store::Server {
                    id: "srv-a".to_string(),
                    name: "计费机".to_string(),
                    host: "10.0.0.1".to_string(),
                    port: 22,
                    auth_type: crate::store::AuthType::Password,
                    username: "root".to_string(),
                    key_path: String::new(),
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                },
                None,
            )
            .unwrap();
        let actions = AiActions::new(Arc::clone(&store), Arc::new(crate::ssh::SshManager::new(Arc::clone(&store))));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        // 连接不存在
        let err = rt.block_on(actions.db_query(
            "srv-a".to_string(),
            "db-missing".to_string(),
            "SELECT 1".to_string(),
        ));
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("数据库连接不存在"));
        // 存在但未配密码
        store
            .save_db_connection(
                "srv-a",
                crate::store::DbConnection {
                    id: "db-1".to_string(),
                    name: "计费库".to_string(),
                    kind: crate::store::DbKind::Mysql,
                    host: "127.0.0.1".to_string(),
                    port: 3506,
                    user: "icc".to_string(),
                    database: "srun4k".to_string(),
                    allowed_commands: vec![],
                    enabled: true,
                },
                None,
            )
            .unwrap();
        let err2 = rt.block_on(actions.db_query(
            "srv-a".to_string(),
            "db-1".to_string(),
            "SELECT 1".to_string(),
        ));
        assert!(err2.is_err());
        assert!(err2.unwrap_err().contains("未配置密码"));
        // 白名单外命令（未配密码前也会先过白名单？——顺序：白名单先于密码，见实现）
        let err3 = rt.block_on(actions.db_query(
            "srv-a".to_string(),
            "db-1".to_string(),
            "DROP TABLE x".to_string(),
        ));
        assert!(err3.is_err());
        // 禁用连接：白名单/密码之前先拒绝
        let mut disabled = store.db_connection("srv-a", "db-1").unwrap();
        disabled.enabled = false;
        store.save_db_connection("srv-a", disabled, None).unwrap();
        let err4 = rt.block_on(actions.db_query(
            "srv-a".to_string(),
            "db-1".to_string(),
            "SELECT 1".to_string(),
        ));
        assert!(err4.is_err());
        assert!(err4.unwrap_err().contains("已禁用"));
    }

    #[test]
    fn list_servers_reports_binding_and_lock_status() {
        let dir = std::env::temp_dir().join(format!(
            "aishell-ai-actions-list-servers-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = crate::store::test_store(dir.clone());
        store
            .upsert_server(
                crate::store::Server {
                    id: "srv-a".to_string(),
                    name: "生产机".to_string(),
                    host: "10.0.0.1".to_string(),
                    port: 22,
                    auth_type: crate::store::AuthType::Password,
                    username: "root".to_string(),
                    key_path: String::new(),
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                },
                None,
            )
            .unwrap();
        store
            .upsert_server(
                crate::store::Server {
                    id: "srv-b".to_string(),
                    name: "测试机".to_string(),
                    host: "10.0.0.2".to_string(),
                    port: 2222,
                    auth_type: crate::store::AuthType::Key,
                    username: "ubuntu".to_string(),
                    key_path: "C:\\key".to_string(),
                    locked: true,
                    is_bastion: false,
                    bastion_id: None,
                },
                None,
            )
            .unwrap();
        // 未绑定服务器不入列（存在但不在项目 serverIds 中）
        store
            .upsert_server(
                crate::store::Server {
                    id: "srv-unbound".to_string(),
                    name: "未绑定".to_string(),
                    host: "10.0.0.3".to_string(),
                    port: 22,
                    auth_type: crate::store::AuthType::Password,
                    username: "u".to_string(),
                    key_path: String::new(),
                    locked: false,
                    is_bastion: false,
                    bastion_id: None,
                },
                None,
            )
            .unwrap();
        store
            .upsert_project(crate::store::Project {
                id: "proj-x".to_string(),
                name: "P".to_string(),
                path: Some("D:\\proj".to_string()),
                server_ids: vec!["srv-a".to_string(), "srv-b".to_string()],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: crate::store::AiMode::Agent,
            })
            .unwrap();

        let store = Arc::new(store);
        let actions = AiActions::new(Arc::clone(&store), Arc::new(SshManager::new(Arc::new(
            crate::store::test_store(std::env::temp_dir().join(format!(
                "aishell-ai-actions-ssh-{}",
                std::process::id()
            ))),
        ))));
        let text = actions.list_servers("proj-x").unwrap();
        assert!(text.contains("serverId=srv-a"), "应列出绑定服务器: {text}");
        assert!(text.contains("生产机"));
        assert!(text.contains("10.0.0.1:22"));
        assert!(text.contains("状态=可用"), "未锁定应标可用: {text}");
        assert!(text.contains("serverId=srv-b"));
        assert!(text.contains("状态=已锁定（AI 无法执行远程操作）"), "锁定应标注: {text}");
        assert!(!text.contains("srv-unbound"), "未绑定服务器不应出现: {text}");
        assert!(!text.contains("C:\\key"), "不得泄露密钥路径: {text}");
        // 项目不存在 → 中文错误
        let err = actions.list_servers("proj-missing").unwrap_err();
        assert!(err.contains("项目不存在：proj-missing"), "错误串不符: {err}");
        // 无绑定 → 明确提示
        store
            .upsert_project(crate::store::Project {
                id: "proj-empty".to_string(),
                name: "E".to_string(),
                path: None,
                server_ids: vec![],
                quick_commands: vec![],
                folder: String::new(),
                ai_mode: crate::store::AiMode::Suggest,
            })
            .unwrap();
        let text = actions.list_servers("proj-empty").unwrap();
        assert!(text.contains("项目未绑定任何远程服务器"), "实际: {text}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
