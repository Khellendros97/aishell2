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

use regex::Regex;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::ai_impact::{analyze_remote_command, Effect, ImpactPlan};
use crate::ssh::SshManager;
use crate::staging::{RemoteStaging, StagedState};
use crate::store::{DbKind, Store};

const DEFAULT_RUN_COMMAND_TIMEOUT_SECS: u64 = 10;
const MAX_RUN_COMMAND_TIMEOUT_SECS: u64 = 3600;
/// 流式拷贝缓冲（与 sftp.rs / staging.rs 一致）。
const COPY_BUF: usize = 64 * 1024;
/// 返回给模型的文本上限（与 ai.rs MAX_RESULT_CHARS 一致）。
const AI_RESULT_CAP: usize = 30_000;
/// 远程 grep 整体超时（秒）。
const REMOTE_GREP_TIMEOUT_SECS: u64 = 30;
/// 远端 glob 递归上限：深度 / 目录扫描数（防失控 walk）。
const REMOTE_GLOB_MAX_DEPTH: usize = 12;
const REMOTE_GLOB_MAX_DIRS: usize = 2000;
/// 单次 AI SFTP 动作允许的根项数；目录内部递归不计入此项。
pub(crate) const MAX_SFTP_BATCH_ITEMS: usize = 32;

#[derive(Debug, Clone)]
pub(crate) struct SftpUploadItem {
    pub local_path: String,
    pub remote_dir: String,
    pub overwrite: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct SftpDownloadItem {
    pub remote_path: String,
    pub local_dir: String,
}

/// 判断 SFTP 错误是否为「文件不存在」（与 staging.rs 同语义）。
fn is_no_such_file(e: &russh_sftp::client::error::Error) -> bool {
    matches!(e, russh_sftp::client::error::Error::Status(s) if s.status_code == russh_sftp::protocol::StatusCode::NoSuchFile)
}

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

/// AI 动作执行器（由 AiManager 持有并复用 Store + SshManager + RemoteStaging + BrowserManager）。
pub struct AiActions {
    store: Arc<Store>,
    ssh: Arc<SshManager>,
    staging: Arc<RemoteStaging>,
    /// 内置浏览器（browser_open/read/console/screenshot 动作桥共用共享单实例）
    browser: Arc<crate::browser::BrowserManager>,
}

impl AiActions {
    pub fn new(
        store: Arc<Store>,
        ssh: Arc<SshManager>,
        staging: Arc<RemoteStaging>,
        browser: Arc<crate::browser::BrowserManager>,
    ) -> Self {
        AiActions { store, ssh, staging, browser }
    }

    /// 内置浏览器管理器（run_internal_action 的 browser_* 动作分发用）
    pub fn browser(&self) -> &Arc<crate::browser::BrowserManager> {
        &self.browser
    }

    /// 执行命令：target=local 走本地 shell（项目根 cwd），target=remote 走 SshManager。
    /// 空命令 / 空 intent / 非法超时在建进程或网络前拒绝；未传超时默认 10 秒。
    ///
    /// 远程分支（自动备份流程）：
    /// - `working_directory` 为后端解析的远程工作目录（绝对路径；None 时经 SFTP canonicalize(".") 现取）；
    ///   实际 exec 用同一绝对 cwd 以 `cd <cwd> && <command>` 包装（前一次独立调用的 cd 不保留），
    ///   cwd 解析失败或 `cd` 失败不得执行原命令。
    /// - `impact` 为审批阶段确定的影响计划（None = 执行时按 command+cwd 现算，yolo 路径）。
    ///
    /// 自动备份开启时：bounded → 执行前逐项 ensure_snapshot（全部成功才执行，失败阻止写入）；
    /// 执行后逐项刷新 current 状态。none/unbounded 不在此处拦截（unbounded 的拒绝/人工确认在
    /// 审批与动作桥层处理）。
    #[allow(clippy::too_many_arguments)]
    pub async fn run_command(
        &self,
        project_id: &str,
        session_id: &str,
        intent: String,
        command: String,
        target: String,
        server_id: Option<String>,
        timeout_seconds: Option<u64>,
        working_directory: Option<String>,
        impact: Option<ImpactPlan>,
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
                // 有效工作目录：调用方解析结果优先（与审批分析同源），否则现取
                let effective_cwd = match &working_directory {
                    Some(c) if c.starts_with('/') => c.clone(),
                    Some(_) => return Err("工作目录必须是绝对路径".to_string()),
                    None => self.remote_home(&sid).await?,
                };
                let auto_backup = self.staging.auto_backup_enabled();
                let plan = match impact {
                    Some(p) => p,
                    None => analyze_remote_command(&command, &effective_cwd),
                };
                // 自动备份：bounded → 执行前逐文件快照（任一失败即阻止执行）
                if auto_backup && plan.effect == Effect::Bounded {
                    let mut paths: Vec<&str> = Vec::new();
                    for c in &plan.changes {
                        if !paths.contains(&c.path.as_str()) {
                            paths.push(c.path.as_str());
                        }
                        if let Some(d) = &c.destination {
                            if !paths.contains(&d.as_str()) {
                                paths.push(d.as_str());
                            }
                        }
                    }
                    for p in &paths {
                        self.staging
                            .ensure_snapshot(project_id, session_id, &sid, p)
                            .await?;
                    }
                }
                // 用同一绝对 cwd 包装命令（保证分析路径与实际执行环境一致）
                let wrapped = format!("cd {} && {}", shell_quote(&effective_cwd), command);
                let result = self.ssh.exec_with_timeout(&sid, &wrapped, timeout).await?;
                if result.timed_out {
                    return Err(format!(
                        "命令执行超时（{} 秒），已尝试终止远端命令",
                        timeout.as_secs()
                    ));
                }
                // 执行后刷新 current 状态（best-effort：刷新失败不掩盖命令结果）
                if auto_backup && plan.effect == Effect::Bounded {
                    for c in &plan.changes {
                        let _ = self
                            .staging
                            .refresh_current(project_id, session_id, &sid, &c.path)
                            .await;
                        if let Some(d) = &c.destination {
                            let _ = self
                                .staging
                                .refresh_current(project_id, session_id, &sid, d)
                                .await;
                        }
                    }
                }
                Ok(result)
            }
            other => Err(format!("未知命令目标：{other}")),
        }
    }

    /// SFTP 上传：本地源必须在项目根内且已存在（文件或目录），远端目录必填。
    /// overwrite=true 时远端同名直接覆盖；false 时重名自动创建副本。
    /// 返回给模型的落地说明：明确远端文件名，创建副本时显式提示。
    ///
    /// 自动备份：overwrite=true 时在 `upload_one` 前快照最终远程目标；目录覆盖时枚举本地
    /// 每个文件逐一快照，无法枚举（权限等）返回错误拒绝（已获「不保证完整备份」人工确认的
    /// agent 场景除外——`impact` 为审批阶段 unbounded 计划时按用户确认放行）。overwrite=false
    /// 创建新副本，不备份原同名文件。
    #[allow(clippy::too_many_arguments)]
    pub async fn sftp_upload(
        &self,
        project_id: &str,
        session_id: &str,
        server_id: String,
        local_path: String,
        remote_dir: String,
        overwrite: bool,
        impact: Option<ImpactPlan>,
    ) -> Result<String, String> {
        self.sftp_upload_batch(
            project_id,
            session_id,
            &server_id,
            &[SftpUploadItem { local_path, remote_dir, overwrite }],
            impact,
        )
        .await
    }

    /// 覆盖上传的最终远程目标清单：文件 → 单一目标；目录 → 递归枚举本地文件映射远端相对路径。
    /// 枚举失败返回 Err（调用方按 unbounded/拒绝处理）。
    async fn upload_targets(&self, local: &Path, remote_dir: &str, server_id: &str) -> Result<Vec<String>, String> {
        let md = std::fs::metadata(local)
            .map_err(|e| format!("读取本地 {} 失败: {e}", local.display()))?;
        if !md.is_file() && !md.is_dir() {
            return Err(format!("上传源既不是文件也不是目录：{}", local.display()));
        }
        // 远端目录解析为绝对形态（快照要求绝对路径；相对目录相对 home 解析）
        let base = if remote_dir.starts_with('/') {
            remote_dir.trim_end_matches('/').to_string()
        } else {
            let home = self.remote_home(server_id).await?;
            format!("{}/{}", home.trim_end_matches('/'), remote_dir.trim_end_matches('/'))
        };
        if md.is_file() {
            let name = local
                .file_name()
                .and_then(|n| n.to_str())
                .filter(|n| !n.is_empty())
                .ok_or_else(|| "无法确定本地文件名".to_string())?;
            return Ok(vec![format!("{}/{}", base.trim_end_matches('/'), name)]);
        }
        // 目录：递归枚举
        let mut out: Vec<String> = Vec::new();
        let mut stack: Vec<(PathBuf, String)> = vec![(local.to_path_buf(), base.clone())];
        while let Some((dir, remote_dir_cur)) = stack.pop() {
            let rd = std::fs::read_dir(&dir)
                .map_err(|e| format!("枚举本地目录 {} 失败: {e}", dir.display()))?;
            for ent in rd {
                let ent = ent.map_err(|e| format!("枚举本地目录 {} 失败: {e}", dir.display()))?;
                let path = ent.path();
                let name = ent.file_name().to_string_lossy().into_owned();
                let remote = format!("{}/{}", remote_dir_cur, name);
                if path.is_dir() {
                    stack.push((path, remote));
                } else {
                    out.push(remote);
                }
            }
        }
        Ok(out)
    }

    /// SFTP 下载单项：本地目标目录必须在项目根内且**已存在**（AI 不自动创建目录）。
    pub async fn sftp_download(
        &self,
        project_id: &str,
        server_id: String,
        remote_path: String,
        local_dir: String,
    ) -> Result<(), String> {
        self.sftp_download_batch(project_id, &server_id, &[SftpDownloadItem { remote_path, local_dir }]).await.map(|_| ())
    }

    /// AI 批量上传：先完成全部覆盖目标的备份预检，再按顺序执行，返回逐项结果汇总。
    pub(crate) async fn sftp_upload_batch(
        &self,
        project_id: &str,
        session_id: &str,
        server_id: &str,
        items: &[SftpUploadItem],
        impact: Option<ImpactPlan>,
    ) -> Result<String, String> {
        if items.is_empty() || items.len() > MAX_SFTP_BATCH_ITEMS {
            return Err(format!("SFTP 批量上传项数必须在 1–{MAX_SFTP_BATCH_ITEMS} 之间"));
        }
        let root = self.project_root(project_id)?;
        self.ensure_ai_allowed(server_id)?;
        let mut resolved = Vec::with_capacity(items.len());
        let mut remote_dirs = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            if item.local_path.trim().is_empty() || item.remote_dir.trim().is_empty() {
                return Err(format!("第 {} 项上传参数不能为空", index + 1));
            }
            let local = self.resolve_inside(&root, Path::new(&item.local_path))?;
            let md = std::fs::metadata(&local)
                .map_err(|e| format!("读取本地 {} 失败：{e}", local.display()))?;
            if !md.is_file() && !md.is_dir() {
                return Err(format!("第 {} 项上传源既不是文件也不是目录：{}", index + 1, local.display()));
            }
            resolved.push(local);
            remote_dirs.push(self.resolve_remote_path(server_id, &item.remote_dir).await?);
        }
        if self.staging.auto_backup_enabled() {
            for (index, item) in items.iter().enumerate() {
                if !item.overwrite { continue; }
                match self.upload_targets(&resolved[index], &remote_dirs[index], server_id).await {
                    Ok(paths) => {
                        for path in paths {
                            self.staging.ensure_snapshot(project_id, session_id, server_id, &path).await?;
                        }
                    }
                    Err(reason) => {
                        let approved_unbounded = matches!(impact.as_ref().map(|p| p.effect), Some(Effect::Unbounded));
                        if !approved_unbounded {
                            return Err(format!("批量上传覆盖范围无法完整枚举：{reason}，已拒绝写入"));
                        }
                    }
                }
            }
        }
        let sftp = self.ssh.open_sftp(server_id).await?;
        let mut failures = Vec::new();
        for (index, item) in items.iter().enumerate() {
            if let Err(error) = crate::sftp::upload_one(&sftp, &resolved[index], &remote_dirs[index], item.overwrite).await {
                failures.push(format!("第 {} 项失败：{}", index + 1, error));
            }
        }
        let succeeded = items.len() - failures.len();
        if failures.is_empty() {
            Ok(format!("批量上传完成：成功 {succeeded} 项（服务器 {server_id}）"))
        } else {
            Err(format!("批量上传部分成功：成功 {succeeded} 项，失败 {} 项\n{}", failures.len(), failures.join("\n")))
        }
    }

    /// AI 批量下载：每项独立校验本地目录并串行落地，返回逐项结果汇总。
    pub(crate) async fn sftp_download_batch(
        &self,
        project_id: &str,
        server_id: &str,
        items: &[SftpDownloadItem],
    ) -> Result<String, String> {
        if items.is_empty() || items.len() > MAX_SFTP_BATCH_ITEMS {
            return Err(format!("SFTP 批量下载项数必须在 1–{MAX_SFTP_BATCH_ITEMS} 之间"));
        }
        let root = self.project_root(project_id)?;
        self.ensure_ai_allowed(server_id)?;
        let mut dirs = Vec::with_capacity(items.len());
        let mut remote_paths = Vec::with_capacity(items.len());
        for (index, item) in items.iter().enumerate() {
            if item.remote_path.trim().is_empty() || item.local_dir.trim().is_empty() {
                return Err(format!("第 {} 项下载参数不能为空", index + 1));
            }
            let dir = self.resolve_inside(&root, Path::new(&item.local_dir))?;
            let md = std::fs::metadata(&dir)
                .map_err(|e| format!("读取本地目录 {} 失败：{e}", dir.display()))?;
            if !md.is_dir() {
                return Err(format!("第 {} 项下载目标不是目录：{}", index + 1, dir.display()));
            }
            dirs.push(dir);
            remote_paths.push(self.resolve_remote_path(server_id, &item.remote_path).await?);
        }
        let sftp = self.ssh.open_sftp(server_id).await?;
        let mut failures = Vec::new();
        for (index, _item) in items.iter().enumerate() {
            if let Err(error) = crate::sftp::download_one(&sftp, &remote_paths[index], &dirs[index]).await {
                failures.push(format!("第 {} 项失败：{}", index + 1, error));
            }
        }
        let succeeded = items.len() - failures.len();
        if failures.is_empty() {
            Ok(format!("批量下载完成：成功 {succeeded} 项（服务器 {server_id}）"))
        } else {
            Err(format!("批量下载部分成功：成功 {succeeded} 项，失败 {} 项\n{}", failures.len(), failures.join("\n")))
        }
    }

    /// 解析远端 home（canonicalize(".")）：审批/执行两阶段共用的远程工作目录事实源。
    /// 供 ai.rs 审批流（影响分析、LLM 上下文）与 run_command 包装使用。
    pub async fn remote_home(&self, server_id: &str) -> Result<String, String> {
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        sftp.canonicalize(".")
            .await
            .map_err(|e| format!("解析远程工作目录失败: {e}"))
    }

    // ---------------------------------------------------------------- 远程文件工具（基础工具 serverId 模式）
    // 权限契约与 guard 侧一致：仅 agent/yolo 可用（suggest 由 guard validate 阻止）；
    // 全部入口先过服务器 AI 锁（ensure_ai_allowed）；写操作在自动备份开启时执行前
    // ensure_snapshot（同一会话首次修改记录原始字节，暂存面板可 diff/还原）。

    /// 解析远程路径为绝对 POSIX 路径：绝对路径词法折叠；相对路径拼远端 home；
    /// 拒绝 Windows 盘符形态（远程是 POSIX 文件系统）。与暂存键的路径归一保持一致。
    async fn resolve_remote_path(&self, server_id: &str, path: &str) -> Result<String, String> {
        let path = path.trim();
        if path.is_empty() {
            return Err("远程路径不能为空".to_string());
        }
        if path.starts_with('\\') || (path.len() >= 2 && path.as_bytes()[1] == b':') {
            return Err(format!(
                "远程路径必须是 POSIX 绝对路径（/ 开头）或相对路径，不接受盘符形态：{path}"
            ));
        }
        if path.starts_with('/') {
            crate::staging::canonical_remote_path(path)
        } else {
            let home = self.remote_home(server_id).await?;
            crate::staging::canonical_remote_path(&format!("{}/{}", home.trim_end_matches('/'), path))
        }
    }

    /// 远端单条目属性（ls/read/write 的 exists/stat/access 语义）：
    /// 返回 JSON `{exists,isDir,size,mtime}`；文件不存在 → exists:false（不报错）。
    pub async fn remote_stat(&self, server_id: &str, path: &str) -> Result<String, String> {
        self.ensure_ai_allowed(server_id)?;
        let resolved = self.resolve_remote_path(server_id, path).await?;
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        match sftp.metadata(&resolved).await {
            Ok(md) => Ok(json!({
                "exists": true,
                "isDir": md.is_dir(),
                "size": md.size.unwrap_or(0),
                "mtime": md.mtime.unwrap_or(0) as i64,
            })
            .to_string()),
            Err(e) if is_no_such_file(&e) => {
                Ok(json!({"exists": false, "isDir": false, "size": 0, "mtime": 0}).to_string())
            }
            Err(e) => Err(format!("读取远端 {resolved} 属性失败: {e}")),
        }
    }

    /// 读取远端文本文件字节：>MAX_EDIT_BYTES、前 8KB 含 NUL 或非 UTF-8 → 中文错误
    /// （远程暂不支持大文件/二进制/图片，与编辑器 sftp_read 同一套约束）。
    /// 不脱敏：与本地 read 一致，脱敏会破坏 edit 的 oldText 精确匹配。
    pub async fn remote_read(&self, server_id: &str, path: &str) -> Result<Vec<u8>, String> {
        self.ensure_ai_allowed(server_id)?;
        let resolved = self.resolve_remote_path(server_id, path).await?;
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        let md = sftp
            .metadata(&resolved)
            .await
            .map_err(|e| format!("读取远端 {resolved} 失败: {e}"))?;
        if md.is_dir() {
            return Err(format!("远端 {resolved} 是目录，不能读取"));
        }
        if md.size.unwrap_or(0) > crate::fsops::MAX_EDIT_BYTES {
            return Err(format!(
                "远端 {resolved} 超过 {}MB，无法读取（远程暂不支持大文件/二进制/图片）",
                crate::fsops::MAX_EDIT_BYTES / 1024 / 1024
            ));
        }
        let mut f = sftp
            .open(&resolved)
            .await
            .map_err(|e| format!("打开远端 {resolved} 失败: {e}"))?;
        let mut bytes: Vec<u8> = Vec::new();
        let mut buf = vec![0u8; COPY_BUF];
        let mut scanned = 0usize;
        loop {
            let n = f
                .read(&mut buf)
                .await
                .map_err(|e| format!("读取远端 {resolved} 失败: {e}"))?;
            if n == 0 {
                break;
            }
            if scanned < crate::fsops::BINARY_SCAN_BYTES {
                let head = &buf[..n.min(crate::fsops::BINARY_SCAN_BYTES - scanned)];
                if head.contains(&0) {
                    return Err(format!("远端 {resolved} 为二进制文件，无法读取（远程暂不支持二进制/图片）"));
                }
                scanned += head.len();
            }
            bytes.extend_from_slice(&buf[..n]);
        }
        std::str::from_utf8(&bytes)
            .map_err(|_| format!("远端 {resolved} 不是有效的 UTF-8 文本，无法读取"))?;
        Ok(bytes)
    }

    /// 远端写文件（write/edit 工具的执行体）：
    /// 目录目标拒绝；自动备份开启时写前 ensure_snapshot（任一失败阻止写入）；
    /// 父目录不存在自动创建（write 语义）；写后刷新暂存 current 状态。
    pub async fn remote_write(
        &self,
        project_id: &str,
        session_id: &str,
        server_id: &str,
        path: &str,
        content: &str,
    ) -> Result<String, String> {
        self.ensure_ai_allowed(server_id)?;
        if content.len() > crate::fsops::MAX_EDIT_BYTES as usize {
            return Err(format!(
                "写入内容超过 {}MB，请拆分后重试",
                crate::fsops::MAX_EDIT_BYTES / 1024 / 1024
            ));
        }
        let resolved = self.resolve_remote_path(server_id, path).await?;
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        // 目录目标拒绝（无论自动备份开关）
        if let Ok(md) = sftp.metadata(&resolved).await {
            if md.is_dir() {
                return Err(format!("远端 {resolved} 是目录，不能写入"));
            }
        }
        let auto_backup = self.staging.auto_backup_enabled();
        if auto_backup {
            self.staging
                .ensure_snapshot(project_id, session_id, server_id, &resolved)
                .await?;
        }
        // 父目录自动创建（write 语义：父目录不存在会自动创建）
        if let Some(parent) = resolved.rsplit_once('/').map(|(p, _)| if p.is_empty() { "/" } else { p }) {
            remote_mkdir_impl(&sftp, parent).await?;
        }
        let mut f = sftp
            .create(&resolved)
            .await
            .map_err(|e| format!("创建远端文件 {resolved} 失败: {e}"))?;
        f.write_all(content.as_bytes())
            .await
            .map_err(|e| format!("写入远端 {resolved} 失败: {e}"))?;
        f.shutdown()
            .await
            .map_err(|e| format!("关闭远端文件 {resolved} 失败: {e}"))?;
        if auto_backup {
            let _ = self
                .staging
                .refresh_current(project_id, session_id, server_id, &resolved)
                .await;
        }
        Ok(format!("写入完成：{resolved}（服务器 {server_id}）"))
    }

    /// 远端目录创建（write 的 mkdir 语义：父目录不存在自动创建；已存在且是目录则跳过）。
    pub async fn remote_mkdir(&self, server_id: &str, dir: &str) -> Result<(), String> {
        self.ensure_ai_allowed(server_id)?;
        let resolved = self.resolve_remote_path(server_id, dir).await?;
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        remote_mkdir_impl(&sftp, &resolved).await
    }

    /// 远端目录列表（ls 的 readdir 语义）：返回 JSON 数组
    /// `[{name,isDir,size,mtime}]`，供扩展侧 stat 缓存，避免逐条目往返。
    pub async fn remote_listdir(&self, server_id: &str, path: &str) -> Result<String, String> {
        self.ensure_ai_allowed(server_id)?;
        let resolved = self.resolve_remote_path(server_id, path).await?;
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        let rd = sftp
            .read_dir(&resolved)
            .await
            .map_err(|e| format!("读取远端目录 {resolved} 失败: {e}"))?;
        let mut entries: Vec<serde_json::Value> = Vec::new();
        for entry in rd {
            let md = entry.metadata();
            entries.push(json!({
                "name": entry.file_name(),
                "isDir": md.is_dir(),
                "size": md.size.unwrap_or(0),
                "mtime": md.mtime.unwrap_or(0) as i64,
            }));
        }
        serde_json::to_string(&entries).map_err(|e| format!("序列化远端目录失败: {e}"))
    }

    /// 远端 glob 搜索（find 工具的 glob 语义）：
    /// SFTP 递归 walk，glob→regex 匹配「相对 base」的 POSIX 路径（含 '/' 匹配完整相对路径，
    /// 不含 '/' 只匹配末段）；跳过 ignore 目录（core 默认传 node_modules/.git）；
    /// 深度/目录数上限防失控；limit 截断。返回相对路径（find core 会相对化展示）。
    pub async fn remote_glob(
        &self,
        server_id: &str,
        base: &str,
        pattern: &str,
        ignore: &[String],
        limit: usize,
    ) -> Result<Vec<String>, String> {
        self.ensure_ai_allowed(server_id)?;
        let base = self.resolve_remote_path(server_id, base).await?;
        let re = glob_to_regex(pattern)?;
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        let mut out: Vec<String> = Vec::new();
        let mut stack: Vec<(String, usize)> = vec![(base.clone(), 0)];
        let mut scanned = 0usize;
        while let Some((dir, depth)) = stack.pop() {
            if depth > REMOTE_GLOB_MAX_DEPTH {
                continue;
            }
            scanned += 1;
            if scanned > REMOTE_GLOB_MAX_DIRS {
                break;
            }
            let rd = match sftp.read_dir(&dir).await {
                Ok(rd) => rd,
                Err(_) => continue, // 无权限/已删除目录跳过，不中断整个搜索
            };
            for entry in rd {
                if out.len() >= limit {
                    return Ok(out);
                }
                let name = entry.file_name();
                let full = format!("{}/{}", dir.trim_end_matches('/'), name);
                let md = entry.metadata();
                let rel = full
                    .strip_prefix(&base)
                    .unwrap_or(&full)
                    .trim_start_matches('/')
                    .to_string();
                if md.is_dir() {
                    if ignore.iter().any(|g| ignore_dir_match(g, &name)) {
                        continue;
                    }
                    stack.push((full, depth + 1));
                    if glob_matches(&re, pattern, &rel) {
                        out.push(rel);
                    }
                } else if glob_matches(&re, pattern, &rel) {
                    out.push(rel);
                }
            }
        }
        Ok(out)
    }

    /// 远端 grep（read-only）：服务端固定模板 grep（全参数 shell_quote，无模型自由注入面），
    /// 30s 超时；退出码 1 = 无匹配；127 = 服务器未装 grep（中文降级指引）；
    /// 输出脱敏 + 截断（与 run_command 输出同标准）。
    #[allow(clippy::too_many_arguments)]
    pub async fn remote_grep(
        &self,
        server_id: &str,
        pattern: &str,
        path: &str,
        glob: Option<&str>,
        ignore_case: bool,
        literal: bool,
        context: Option<u32>,
    ) -> Result<String, String> {
        self.ensure_ai_allowed(server_id)?;
        if pattern.trim().is_empty() {
            return Err("搜索模式不能为空".to_string());
        }
        let resolved = self.resolve_remote_path(server_id, path).await?;
        let cmd = build_remote_grep_command(pattern, &resolved, glob, ignore_case, literal, context);
        let result = self
            .ssh
            .exec_with_timeout(server_id, &cmd, Duration::from_secs(REMOTE_GREP_TIMEOUT_SECS))
            .await?;
        if result.timed_out {
            return Err(format!(
                "远程 grep 超时（{REMOTE_GREP_TIMEOUT_SECS} 秒），已终止；可改用 find/read 缩小范围"
            ));
        }
        match result.exit_code {
            Some(0) => {}
            Some(1) => return Ok("No matches found".to_string()),
            Some(127) => {
                return Err("服务器未安装 grep，无法远程搜索；请改用 read/find/ls 工具".to_string());
            }
            Some(2) => {
                let stderr = result.stderr.trim();
                return Err(if stderr.is_empty() {
                    "远程 grep 执行出错（退出码 2），请确认搜索路径存在且可读".to_string()
                } else {
                    format!("远程 grep 失败：{stderr}")
                });
            }
            _ => return Err(format!("远程 grep 异常退出（code={:?}）", result.exit_code)),
        }
        let mut text = result.stdout;
        if !result.stderr.is_empty() {
            text.push_str(&format!("\n{}", result.stderr));
        }
        // 输出脱敏（先于截断）：配置里的密码不进 LLM 上下文，也不进 pi 会话落盘
        let (masked, redacted) = crate::redact::redact_secrets(&text, &self.store.known_secrets());
        text = masked;
        if redacted > 0 {
            text.push_str(&format!("\n[AIShell：输出含 {redacted} 处凭据，已脱敏；如需凭据请用户手动操作]"));
        }
        if text.len() > AI_RESULT_CAP {
            text.truncate(AI_RESULT_CAP);
            text.push_str("\n…(输出已截断)");
        }
        if text.trim().is_empty() {
            return Ok("No matches found".to_string());
        }
        Ok(text)
    }

    /// 远端删除（delete_path 工具的 serverId 模式）：仅文件（目录删除走 run_command，
    /// 其影响分析会枚举目录内文件并逐一快照）；自动备份开启时删除前快照（可还原）。
    pub async fn remote_delete(
        &self,
        project_id: &str,
        session_id: &str,
        server_id: &str,
        path: &str,
    ) -> Result<String, String> {
        self.ensure_ai_allowed(server_id)?;
        let resolved = self.resolve_remote_path(server_id, path).await?;
        let sftp = self
            .ssh
            .open_sftp(server_id)
            .await
            .map_err(|e| format!("打开服务器 SFTP 会话失败：{e}"))?;
        let md = sftp
            .metadata(&resolved)
            .await
            .map_err(|e| format!("读取远端 {resolved} 失败: {e}"))?;
        if md.is_dir() {
            return Err(format!(
                "远端 {resolved} 是目录；远程删除工具仅支持文件。删除目录请用 run_command（审批时会展示影响范围并自动备份）"
            ));
        }
        let auto_backup = self.staging.auto_backup_enabled();
        if auto_backup {
            self.staging
                .ensure_snapshot(project_id, session_id, server_id, &resolved)
                .await?;
        }
        sftp.remove_file(&resolved)
            .await
            .map_err(|e| format!("删除远端 {resolved} 失败: {e}"))?;
        if auto_backup {
            let _ = self
                .staging
                .refresh_current(project_id, session_id, server_id, &resolved)
                .await;
        }
        Ok(format!("已删除远程文件：{resolved}（服务器 {server_id}）"))
    }

    /// 覆盖上传的影响计划（审批阶段计算，供合并/展示/执行确认）。
    pub async fn upload_impact(
        &self,
        project_id: &str,
        server_id: &str,
        local_path: &str,
        remote_dir: &str,
        overwrite: bool,
    ) -> Result<ImpactPlan, String> {
        self.upload_impact_batch(project_id, server_id, &[SftpUploadItem {
            local_path: local_path.to_string(),
            remote_dir: remote_dir.to_string(),
            overwrite,
        }]).await
    }

    /// 批量上传的合并影响计划：所有覆盖项的远端目标必须完整枚举，否则为 unbounded。
    pub(crate) async fn upload_impact_batch(
        &self,
        project_id: &str,
        server_id: &str,
        items: &[SftpUploadItem],
    ) -> Result<ImpactPlan, String> {
        if items.is_empty() || items.len() > MAX_SFTP_BATCH_ITEMS {
            return Err(format!("SFTP 批量上传项数必须在 1–{MAX_SFTP_BATCH_ITEMS} 之间"));
        }
        let root = self.project_root(project_id)?;
        let mut changes = Vec::new();
        for item in items {
            if !item.overwrite { continue; }
            let local = self.resolve_inside(&root, Path::new(&item.local_path))?;
            let remote_dir = self.resolve_remote_path(server_id, &item.remote_dir).await?;
            match self.upload_targets(&local, &remote_dir, server_id).await {
                Ok(targets) => changes.extend(targets.into_iter().map(|path| crate::ai_impact::FileChange {
                    operation: crate::ai_impact::Operation::Modify,
                    path,
                    destination: None,
                })),
                Err(reason) => return Ok(ImpactPlan::unbounded(&format!("{reason}；不保证完整备份"))),
            }
        }
        if changes.is_empty() {
            Ok(ImpactPlan::none("批量上传均为新建副本，不覆盖已有文件"))
        } else {
            Ok(ImpactPlan::bounded(changes, "批量覆盖上传目标已完整枚举"))
        }
    }


    /// AI 查看当前会话暂存列表（只读工具；不经前端 Tauri 命令）。
    pub async fn staging_list(&self, project_id: &str, session_id: &str) -> Result<String, String> {
        let entries = self.staging.list(project_id, session_id).await?;
        if entries.is_empty() {
            return Ok("当前会话暂存区为空（自动备份开启后，AI 修改远程文件前会自动保存原始快照，可在此查看、diff、还原）".to_string());
        }
        let mut lines: Vec<String> = Vec::new();
        for e in &entries {
            let orig = match e.original_state {
                StagedState::Existing => "已有文件",
                StagedState::Absent => "新建文件",
            };
            let cur = match e.current_state {
                StagedState::Existing => "存在",
                StagedState::Absent => "已不存在",
            };
            lines.push(format!(
                "- entryId={}，服务器={}，路径={}，原始状态={}，当前状态={}，首次快照时间={}",
                e.entry_id,
                e.server_id,
                e.remote_path,
                orig,
                cur,
                format_staged_ts(e.staged_at)
            ));
        }
        Ok(format!("当前会话暂存条目（{} 个）：\n{}", entries.len(), lines.join("\n")))
    }

    /// AI 查看某条目 diff（只读工具）。
    pub async fn staging_diff(
        &self,
        project_id: &str,
        session_id: &str,
        entry_id: &str,
    ) -> Result<String, String> {
        let d = self.staging.diff(project_id, session_id, entry_id).await?;
        if let Some(meta) = &d.meta {
            let s = &meta.snapshot;
            let c = &meta.current;
            let fmt = |sha: &Option<String>, size: &Option<u64>, mtime: &Option<i64>| {
                format!(
                    "sha256={} size={} mtime={}",
                    sha.as_deref().unwrap_or("-"),
                    size.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string()),
                    mtime.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string())
                )
            };
            return Ok(format!(
                "暂存条目 {entry_id} 为二进制或超大文件，无法显示文本 diff：\n快照：{}\n当前：{}",
                fmt(&s.sha256, &s.size, &s.mtime),
                fmt(&c.sha256, &c.size, &c.mtime)
            ));
        }
        let mut lines = Vec::new();
        if d.snapshot_absent {
            lines.push("（原始状态：文件不存在——首次修改前为空）".to_string());
        }
        if d.current_absent {
            lines.push("（当前：远端文件已不存在）".to_string());
        }
        for l in &d.left {
            lines.push(format!("{} {}", if l.kind == "del" { "-" } else { " " }, l.text));
        }
        lines.push("─".repeat(40));
        for l in &d.right {
            lines.push(format!("{} {}", if l.kind == "add" { "+" } else { " " }, l.text));
        }
        Ok(format!("暂存条目 {entry_id} diff（上：首次快照；下：当前）：\n{}", lines.join("\n")))
    }

    /// AI 还原某条目（force 恒 false：外部修改冲突如实报告，不静默覆盖）。
    /// 仍执行服务器 AI 锁检查与外部修改冲突检查。
    pub async fn staging_restore(
        &self,
        project_id: &str,
        session_id: &str,
        entry_id: &str,
    ) -> Result<String, String> {
        // 先定位条目所属服务器（AI 锁检查需要）
        let entries = self.staging.list(project_id, session_id).await?;
        let entry = entries
            .iter()
            .find(|e| e.entry_id == entry_id)
            .ok_or_else(|| format!("暂存条目不存在：{entry_id}"))?;
        self.ensure_ai_allowed(&entry.server_id)?;
        let out = self
            .staging
            .restore(project_id, session_id, entry_id, false)
            .await?;
        if out.restored {
            let e = out.entry.as_ref().unwrap();
            let verb = match e.original_state {
                StagedState::Existing => "已把远程文件还原到首次修改前的内容",
                StagedState::Absent => "已删除当前远程文件（原始状态为不存在）",
            };
            Ok(format!("还原完成：{verb}（{}）", e.remote_path))
        } else if let Some(c) = out.conflict {
            Err(format!(
                "还原冲突：远程文件已被外部修改（size={}，mtime={}，sha256={}），未执行还原。\
                 如需强制还原请用户在暂存面板确认",
                c.current_size.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string()),
                c.current_mtime.map(|v| v.to_string()).unwrap_or_else(|| "-".to_string()),
                c.current_sha256.as_deref().unwrap_or("-")
            ))
        } else {
            Err("还原失败：暂存状态异常".to_string())
        }
    }

    /// AI 主动暂存文件/目录（备份用途：应用补丁前先把目标备份进会话暂存区，可 diff/还原）。
    /// 目录递归暂存全部文件；只读远端内容，不修改远程。
    pub async fn staging_add(
        &self,
        project_id: &str,
        session_id: &str,
        server_id: &str,
        remote_path: &str,
    ) -> Result<String, String> {
        self.ensure_ai_allowed(server_id)?;
        let entries = self
            .staging
            .add_path(project_id, session_id, server_id, remote_path)
            .await?;
        if entries.len() == 1 {
            Ok(format!("已暂存 1 个文件（{}）", entries[0].remote_path))
        } else {
            Ok(format!("已暂存目录 {remote_path} 下的 {} 个文件", entries.len()))
        }
    }

    /// AI 清理无变更暂存条目：只移除「远端现状与首次快照完全一致」的条目（相当于自动接受），
    /// 有变更或检查失败的保留并如实报告。不触碰远程内容。
    pub async fn staging_clear(&self, project_id: &str, session_id: &str) -> Result<String, String> {
        let out = self.staging.clear_unchanged(project_id, session_id).await?;
        if out.removed.is_empty() {
            return Ok(format!(
                "暂存区没有可清理的条目（{} 个条目仍有变更或检查失败被保留）",
                out.kept.len()
            ));
        }
        let mut lines: Vec<String> = out
            .removed
            .iter()
            .map(|e| format!("- {}（服务器 {}）", e.remote_path, e.server_id))
            .collect();
        if !out.kept.is_empty() {
            lines.push(format!("另有 {} 个条目仍有变更，已保留", out.kept.len()));
        }
        for e in &out.errors {
            lines.push(format!("检查失败（已保留）：{e}"));
        }
        Ok(format!("已清理 {} 个无变更暂存条目：\n{}", out.removed.len(), lines.join("\n")))
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
            DbKind::Postgres => embed_script(
                &[
                    ("PG_HOST", conn.host.as_str()),
                    ("PG_PORT", &conn.port.to_string()),
                    ("PG_USER", conn.user.as_str()),
                    ("PG_PASS", pass.as_str()),
                    ("PG_DB", conn.database.as_str()),
                    ("PG_SQL", command.as_str()),
                ],
                POSTGRES_SCRIPT_BODY,
                &[],
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
/// pub(crate)：mcp.rs 传输目录边界校验复用。
pub(crate) fn normalize_path(p: &Path) -> PathBuf {
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

/// 单引号 shell 引用（`'` → `'\''`）：远程 cwd 含空格/特殊字符时安全包装 exec 命令。
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// 暂存时间展示（本地时间 HH:MM:SS）。
fn format_staged_ts(ts: i64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = ts.max(0) as u64;
    let base = UNIX_EPOCH + std::time::Duration::from_secs(secs);
    match SystemTime::now().duration_since(base) {
        Ok(d) => format!("{} 秒前", d.as_secs()),
        Err(_) => "-".to_string(),
    }
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
/// pub(crate)：mcp.rs 传输目录边界校验复用。
pub(crate) fn ensure_inside(root: &Path, target: &Path) -> Result<(), String> {
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

// ---------------------------------------------------------------- 远程文件工具辅助

/// 逐级创建远端目录：已存在且是目录 → 跳过；已存在但不是目录 → 错误；
/// 递归创建父目录后创建自身。纯 SFTP，不依赖 shell。
/// async 递归需装箱（与 sftp.rs delete_one 同模式）。
async fn remote_mkdir_impl(sftp: &SftpSession, dir: &str) -> Result<(), String> {
    async fn inner(sftp: &SftpSession, dir: &str) -> Result<(), String> {
        match sftp.metadata(dir).await {
            Ok(md) if md.is_dir() => return Ok(()),
            Ok(_) => return Err(format!("远端 {dir} 已存在但不是目录")),
            Err(e) if !is_no_such_file(&e) => return Err(format!("读取远端 {dir} 失败: {e}")),
            Err(_) => {}
        }
        let parent = dir
            .rsplit_once('/')
            .map(|(p, _)| if p.is_empty() { "/" } else { p })
            .unwrap_or("/");
        if parent != dir {
            Box::pin(inner(sftp, parent)).await?;
        }
        sftp.create_dir(dir)
            .await
            .map_err(|e| format!("创建远端目录 {dir} 失败: {e}"))
    }
    Box::pin(inner(sftp, dir)).await
}

/// glob → 正则（find 工具语义）：
/// `*` → `[^/]*`；`**` → `.*`（`**/` 额外允许零级目录）；`?` → `[^/]`；
/// `[...]` 字符类原样透传（不嵌套）；其余正则元字符转义。锚定 ^…$。
fn glob_to_regex(pattern: &str) -> Result<Regex, String> {
    let mut re = String::from("^");
    let chars: Vec<char> = pattern.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    re.push_str(".*");
                    i += 2;
                    // `**/`：匹配零或多级目录（`/` 本身可选）
                    if i < chars.len() && chars[i] == '/' {
                        re.push_str("/?");
                        i += 1;
                    }
                } else {
                    re.push_str("[^/]*");
                    i += 1;
                }
            }
            '?' => {
                re.push_str("[^/]");
                i += 1;
            }
            '[' => {
                // 字符类原样透传直到 `]`；无闭合 `]` 按字面处理
                if let Some(off) = pattern[i + 1..].find(']') {
                    re.push_str(&pattern[i..=i + 1 + off]);
                    i += off + 2;
                } else {
                    re.push_str("\\[");
                    i += 1;
                }
            }
            c => {
                if "\\^$.|+(){}".contains(c) {
                    re.push('\\');
                }
                re.push(c);
                i += 1;
            }
        }
    }
    re.push('$');
    Regex::new(&re).map_err(|e| format!("glob 解析失败（{pattern}）：{e}"))
}

/// glob 匹配（对齐 rg/find 惯例）：pattern 含 '/' → 匹配相对完整路径；
/// 不含 '/' → 只匹配末段（basename，任意层级）。
fn glob_matches(re: &Regex, pattern: &str, rel: &str) -> bool {
    if pattern.contains('/') {
        re.is_match(rel)
    } else {
        rel.rsplit('/')
            .next()
            .map(|b| re.is_match(b))
            .unwrap_or(false)
    }
}

/// ignore 目录判定（core 默认传 `**/node_modules/**`、`**/.git/**`）：
/// 剥掉 `**/` 前缀与 `/**` 后缀后按名称 glob 匹配。
fn ignore_dir_match(glob: &str, name: &str) -> bool {
    let g = glob.trim().trim_start_matches("**/").trim_end_matches("/**");
    if g.is_empty() || g == "**" || g.contains('/') {
        return false;
    }
    glob_to_regex(g).map(|re| re.is_match(name)).unwrap_or(false)
}

/// 组装远端 grep 命令：固定模板 + 全参数 shell_quote（模式/路径/glob 无注入面）。
/// 只读搜索：`grep -rn --color=never [-i] [-F] [-C n] [--include=glob] -e <pattern> -- <path>`
fn build_remote_grep_command(
    pattern: &str,
    resolved: &str,
    glob: Option<&str>,
    ignore_case: bool,
    literal: bool,
    context: Option<u32>,
) -> String {
    let mut cmd = String::from("grep -rn --color=never");
    if ignore_case {
        cmd.push_str(" -i");
    }
    if literal {
        cmd.push_str(" -F");
    }
    if let Some(c) = context {
        cmd.push_str(&format!(" -C {c}"));
    }
    if let Some(g) = glob {
        cmd.push_str(&format!(" --include={}", shell_quote(g)));
    }
    cmd.push_str(&format!(" -e {} -- {}", shell_quote(pattern), shell_quote(resolved)));
    cmd
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

/// postgres 执行：密码经 PGPASSWORD 环境变量（libpq 官方防泄漏通道，不进 argv，ps 不可见）；
/// SQL 走临时文件 + `psql -f`（同 mysql 模式，避免 stdin 交互异常）；`-X` 跳过 psqlrc、
/// `-v ON_ERROR_STOP=1` 遇错即停、`-P pager=off` 关闭分页；statement_timeout 经 PGOPTIONS
/// 注入（libpq 透传给服务端，55s < 外层 timeout 60）；客户端 PATH 无关探测。
const POSTGRES_SCRIPT_BODY: &str = r#"SQL=$(mktemp /tmp/aishell-db-pg.XXXXXX.sql); chmod 600 "$SQL"; printf '%s' "$PG_SQL" > "$SQL"; CLI=$(command -v psql 2>/dev/null || find /srun3 /usr/local/bin /usr/bin /opt -maxdepth 4 -name psql -type f 2>/dev/null | head -1); if [ -z "$CLI" ]; then echo "psql 未找到，请确认服务器已安装" >&2; rm -f "$SQL"; exit 127; fi; export PGPASSWORD="$PG_PASS"; timeout 60 env PGOPTIONS="-c statement_timeout=55s" "$CLI" -X -h "$PG_HOST" -p "$PG_PORT" -U "$PG_USER" ${PG_DB:+-d "$PG_DB"} -v ON_ERROR_STOP=1 -P pager=off -f "$SQL"; RC=$?; rm -f "$SQL"; exit $RC"#;

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
/// - mysql/clickhouse/postgres：按 `;` 分段逐段校验首词（防 `SELECT 1; DROP TABLE x` 多语句绕过）；
/// - redis：单命令，首词在白名单且不含 shell 元字符（防御纵深）。
fn validate_db_command(kind: DbKind, command: &str, allowed: &[String]) -> Result<(), String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("SQL/命令不能为空".to_string());
    }
    let allowed_upper: Vec<String> = allowed.iter().map(|s| s.to_uppercase()).collect();
    let mut segments: Vec<String> = Vec::new();
    match kind {
        DbKind::Mysql | DbKind::Clickhouse | DbKind::Postgres => {
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

    /// 测试用 AiActions：临时暂存根 + test_store（不碰真实 keyring / Store::new）。
    fn test_actions(store: Arc<Store>) -> AiActions {
        let dir = std::env::temp_dir().join(format!(
            "aishell-ai-actions-staging-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let ssh = Arc::new(SshManager::new(Arc::clone(&store)));
        let staging = Arc::new(RemoteStaging::new(dir, Arc::clone(&ssh), Arc::clone(&store)));
        // 浏览器管理器无 AppHandle（未 set_app）时 webview 懒创建会报中文错误，不影响其余动作
        AiActions::new(store, ssh, staging, Arc::new(crate::browser::BrowserManager::new()))
    }

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
        // postgres 与 mysql 同为 SQL 分段校验：白名单内通过
        assert!(validate_db_command(DbKind::Postgres, "SELECT id FROM users LIMIT 3", &allowed).is_ok());
        assert!(validate_db_command(DbKind::Postgres, "SELECT 1; SHOW search_path", &allowed).is_ok());
        // 多语句绕过：分段逐段校验，写命令拒绝
        let err = validate_db_command(DbKind::Postgres, "SELECT 1; DROP TABLE users", &allowed).unwrap_err();
        assert!(err.contains("DROP"), "应拒绝白名单外的 DROP: {err}");
        assert!(validate_db_command(DbKind::Postgres, "   ", &allowed).is_err());
    }

    #[test]
    fn is_db_read_only_accepts_postgres_read_words() {
        use crate::store::DbKind;
        assert!(is_db_read_only(DbKind::Postgres, "SELECT * FROM t"));
        assert!(is_db_read_only(DbKind::Postgres, "explain analyze select 1"));
        assert!(!is_db_read_only(DbKind::Postgres, "UPDATE t SET a=1"));
        assert!(!is_db_read_only(DbKind::Postgres, "VACUUM"));
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
        let actions = test_actions(Arc::clone(&store));
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
        let actions = test_actions(Arc::clone(&store));
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

    #[test]
    fn glob_to_regex_matches_find_semantics() {
        // 基本 *：不跨 /
        let re = glob_to_regex("*.ts").unwrap();
        assert!(re.is_match("a.ts"));
        assert!(!re.is_match("a.txt"));
        assert!(!re.is_match("sub/a.ts"), "无 '/' 的 pattern 由 glob_matches 按 basename 匹配");
        // ** 跨目录
        let re = glob_to_regex("**/*.spec.ts").unwrap();
        assert!(re.is_match("a.spec.ts"));
        assert!(re.is_match("src/a/b.spec.ts"));
        // **/ 允许零级目录
        let re = glob_to_regex("src/**/*.ts").unwrap();
        assert!(re.is_match("src/a.ts"));
        assert!(re.is_match("src/sub/b.ts"));
        assert!(!re.is_match("lib/b.ts"));
        // ? 单字符
        let re = glob_to_regex("?.ts").unwrap();
        assert!(re.is_match("a.ts"));
        assert!(!re.is_match("ab.ts"));
        // 正则元字符转义
        let re = glob_to_regex("a.b").unwrap();
        assert!(re.is_match("a.b"));
        assert!(!re.is_match("axb"));
        // 字符类
        let re = glob_to_regex("[ab]c.txt").unwrap();
        assert!(re.is_match("ac.txt"));
        assert!(re.is_match("bc.txt"));
        assert!(!re.is_match("cc.txt"));
        // 未闭合 [ 按字面处理不报错
        assert!(glob_to_regex("a[b").is_ok());
    }

    #[test]
    fn glob_matches_basename_rule_for_slashless_patterns() {
        let re = glob_to_regex("*.ts").unwrap();
        assert!(glob_matches(&re, "*.ts", "src/sub/a.ts"), "无 '/' 的 pattern 匹配任意层级 basename");
        assert!(!glob_matches(&re, "*.ts", "src/a.txt"));
        let re2 = glob_to_regex("src/**/*.ts").unwrap();
        assert!(glob_matches(&re2, "src/**/*.ts", "src/sub/b.ts"));
        assert!(!glob_matches(&re2, "src/**/*.ts", "lib/b.ts"));
    }

    #[test]
    fn ignore_dir_match_strips_wrapper_glob() {
        assert!(ignore_dir_match("**/node_modules/**", "node_modules"));
        assert!(ignore_dir_match("**/.git/**", ".git"));
        assert!(!ignore_dir_match("**/node_modules/**", "src"));
        assert!(!ignore_dir_match("**", "x"));
        assert!(!ignore_dir_match("**/dist/**", "dist-2"));
    }

    #[test]
    fn build_remote_grep_command_quotes_all_params() {
        let cmd = build_remote_grep_command("foo bar", "/var/www/app", None, false, false, None);
        assert!(cmd.starts_with("grep -rn --color=never"), "{cmd}");
        assert!(cmd.contains("-e 'foo bar' -- '/var/www/app'"), "参数必须 shell_quote: {cmd}");
        // 选项组合
        let cmd2 = build_remote_grep_command("FIXME", "/etc", Some("*.conf"), true, true, Some(2));
        assert!(cmd2.contains(" -i"), "{cmd2}");
        assert!(cmd2.contains(" -F"), "{cmd2}");
        assert!(cmd2.contains(" -C 2"), "{cmd2}");
        assert!(cmd2.contains("--include='*.conf'"), "{cmd2}");
        // 单引号转义
        let cmd3 = build_remote_grep_command("it's", "/a", None, false, false, None);
        assert!(cmd3.contains("-e 'it'\\''s'"), "{cmd3}");
    }

    #[test]
    fn resolve_remote_path_rejects_drive_forms_and_folds_absolute() {
        let dir = std::env::temp_dir().join(format!(
            "aishell-ai-actions-resolve-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Arc::new(crate::store::test_store(dir.clone()));
        let actions = test_actions(Arc::clone(&store));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        // 盘符形态拒绝（不触碰网络）
        let err = rt.block_on(actions.resolve_remote_path("srv-a", r"C:\etc\hosts"));
        assert!(err.is_err());
        assert!(err.unwrap_err().contains("盘符"), "应拒绝盘符形态");
        let err2 = rt.block_on(actions.resolve_remote_path("srv-a", "C:/x"));
        assert!(err2.is_err());
        // 反斜杠开头（UNC 形态）拒绝
        let err3 = rt.block_on(actions.resolve_remote_path("srv-a", r"\\srv\share"));
        assert!(err3.is_err());
        // 绝对路径词法折叠（无网络）
        let ok = rt.block_on(actions.resolve_remote_path("srv-a", "/var/www/./app/../app2"));
        assert_eq!(ok.unwrap(), "/var/www/app2");
        // 空路径
        let err4 = rt.block_on(actions.resolve_remote_path("srv-a", "  "));
        assert!(err4.is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
