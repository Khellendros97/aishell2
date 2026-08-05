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
//! 本地命令复用 term::find_bash（Git Bash，`--login -c`，项目根 cwd），完整捕获
//! stdout/stderr/退出码；远程命令复用 `SshManager::exec`（russh channel，连接复用）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Serialize;

use crate::ssh::SshManager;
use crate::store::Store;

/// 命令执行结果（serde camelCase：stdout / stderr / exitCode）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandResult {
    pub stdout: String,
    pub stderr: String,
    /// 未收到 ExitStatus（通道异常关闭等）时为 null
    pub exit_code: Option<i32>,
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

    /// 执行命令：target=local 走 Git Bash（项目根 cwd），target=remote 走 SshManager::exec。
    /// 空命令 / 空 intent 在建进程或网络前拒绝。
    pub async fn run_command(
        &self,
        project_id: &str,
        intent: String,
        command: String,
        target: String,
        server_id: Option<String>,
    ) -> Result<CommandResult, String> {
        let command = command.trim().to_string();
        if command.is_empty() {
            return Err("命令不能为空".to_string());
        }
        if intent.trim().is_empty() {
            return Err("intent 不能为空，请说明命令意图".to_string());
        }
        match target.as_str() {
            "local" => {
                if server_id.is_some() {
                    return Err("本地目标不得使用 serverId".to_string());
                }
                let root = self.project_root(project_id)?;
                self.run_local(&root, &command).await
            }
            "remote" => {
                let sid =
                    server_id.ok_or_else(|| "远程目标必须提供 serverId".to_string())?;
                self.ensure_ai_allowed(&sid)?;
                self.ssh.exec(&sid, &command).await
            }
            other => Err(format!("未知命令目标：{other}")),
        }
    }

    /// SFTP 上传：本地源必须在项目根内且已存在（文件或目录），远端目录必填。
    pub async fn sftp_upload(
        &self,
        project_id: &str,
        server_id: String,
        local_path: String,
        remote_dir: String,
    ) -> Result<(), String> {
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
        crate::sftp::upload_one(&sftp, &local, &remote_dir)
            .await
            .map(|_| ())
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
            }
        }
        if lines.is_empty() {
            return Ok("项目未绑定任何远程服务器".to_string());
        }
        let mut text = format!("项目绑定服务器（{} 台）：\n{}", lines.len(), lines.join("\n"));
        text.push_str("\n提示：远程 run_command / sftp_upload / sftp_download 请使用上述 serverId；锁定服务器会返回「已锁定」错误。");
        Ok(text)
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

    /// 本地命令：Git Bash `--login -c`，项目根 cwd，完整捕获 stdout/stderr/exit code。
    async fn run_local(&self, root: &Path, command: &str) -> Result<CommandResult, String> {
        let bash = crate::term::find_bash().ok_or_else(|| {
            "未找到 Git Bash，请安装 Git for Windows 或设置 AISHELL_GIT_BASH".to_string()
        })?;
        let out = tokio::process::Command::new(&bash)
            .args(["--login", "-c", command])
            .current_dir(root)
            .output()
            .await
            .map_err(|e| format!("启动 Git Bash 失败：{e}"))?;
        Ok(CommandResult {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            exit_code: out.status.code(),
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
                ai_mode: crate::store::AiMode::Suggest,
            })
            .unwrap();
        let text = actions.list_servers("proj-empty").unwrap();
        assert!(text.contains("项目未绑定任何远程服务器"), "实际: {text}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
