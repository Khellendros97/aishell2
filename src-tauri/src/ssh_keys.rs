//! SSH 私钥收编：密钥统一保管在 `<workspace>/.aishell/ssh-key/`，文件名 = 内容
//! SHA-256 前 16 位十六进制（同内容同名去重、异内容必不同名，天然防冲突）。
//! 保存密钥型凭据/服务器时由 store 把外部私钥「收编」复制进保管目录并改写 key_path
//! （复制非移动、幂等）；启动/切换 workspace 时由 store 的 `adopt_managed_ssh_keys`
//! 迁移存量外部密钥。
//!
//! 本模块同时承载「SSH 公钥(密钥对)」凭据的密钥对管理：目录内按 OpenSSH 标准命名
//! （id_ed25519 / id_rsa / id_ecdsa）探测密钥对、连接时推导私钥路径、为缺密钥对的
//! 用户生成一对（ed25519、无密码短语、防覆盖）。此类 key_path 存目录，**不进** `.aishell/ssh-key`。
//!
//! 接口点：仅被 store.rs / ssh.rs 调用（保存收编 + 迁移 + 认证 + 部署），
//! 以及前端三个命令（默认目录/探测/生成）。

use std::path::PathBuf;

use russh::keys::ssh_key;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::Manager;

use crate::store::AppState;

/// 私钥统一放在 `.aishell/ssh-key` 下（workspace 根目录内，凭据跨项目共享）。
const KEY_DIR_COMPONENTS: [&str; 2] = [".aishell", "ssh-key"];
const KEY_NAME_HEX_LEN: usize = 16;

/// 密钥对目录内的标准命名及探测优先级（OpenSSH 惯例；取第一个「私钥 + 同名 .pub 并存」的对）。
pub const KEYPAIR_PRIORITIES: [&str; 3] = ["id_ed25519", "id_rsa", "id_ecdsa"];

/// 探测到的密钥对（前端展示「已识别：id_ed25519」与连接认证共用的后端事实源）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyPairInfo {
    pub name: String,
    pub private_path: String,
    pub public_path: String,
}

/// 私钥文件名 = 内容 SHA-256 前 16 位十六进制：同内容得到同一个文件（去重），
/// 异内容必不同名（防冲突），与原文件名无关。
pub fn key_file_name_for_content(content: &[u8]) -> String {
    let hex = format!("{:x}", Sha256::digest(content));
    hex[..KEY_NAME_HEX_LEN].to_string()
}

/// workspace 下的私钥保管目录。
pub fn managed_key_dir(workspace: &str) -> PathBuf {
    let mut dir = PathBuf::from(workspace);
    dir.extend(KEY_DIR_COMPONENTS);
    dir
}

/// 从应用状态取保管目录；workspace 未配置时返回 None。
pub fn managed_key_dir_from_state(state: &AppState) -> Option<PathBuf> {
    let workspace = state
        .settings
        .workspace_dir
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())?;
    Some(managed_key_dir(workspace))
}

/// 路径比较键：分隔符与大小写归一（Windows 不区分大小写）。
fn path_key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// 路径是否已落在 workspace 的保管目录内（收编过的 key_path 无需再次复制）。
pub fn is_managed_path(path: &str, workspace: &str) -> bool {
    let dir = path_key(&managed_key_dir(workspace).to_string_lossy());
    let normalized = path_key(path.trim_end_matches(['/', '\\']));
    normalized.starts_with(&format!("{dir}/"))
}

/// 收编外部私钥：复制到 `<workspace>/.aishell/ssh-key/<内容哈希>` 并返回保管路径。
/// 以下情况返回 None（调用方保持 key_path 原值不变）：路径为空、已在保管目录内
/// （幂等）、文件不可读、复制失败。收编是「复制」而非移动，原文件保持不动。
pub fn adopt_key_into_workspace(workspace: &str, key_path: &str) -> Option<String> {
    let trimmed = key_path.trim();
    if trimmed.is_empty() || is_managed_path(trimmed, workspace) {
        return None;
    }
    let bytes = std::fs::read(trimmed).ok()?;
    let name = key_file_name_for_content(&bytes);
    let dir = managed_key_dir(workspace);
    let target = dir.join(&name);
    if !target.exists() {
        std::fs::create_dir_all(&dir).ok()?;
        std::fs::write(&target, &bytes).ok()?;
    }
    Some(target.to_string_lossy().into_owned())
}

/* ---------------- SSH 公钥(密钥对) ---------------- */

/// 目录内按标准命名探测密钥对（私钥 + 同名 .pub 均存在才算一对）；目录为空不存在返回 None。
pub fn detect_keypair(dir: &str) -> Option<KeyPairInfo> {
    let dir = dir.trim();
    if dir.is_empty() {
        return None;
    }
    let base = PathBuf::from(dir);
    for name in KEYPAIR_PRIORITIES {
        let private = base.join(name);
        let public = base.join(format!("{name}.pub"));
        if private.is_file() && public.is_file() {
            return Some(KeyPairInfo {
                name: name.to_string(),
                private_path: private.to_string_lossy().into_owned(),
                public_path: public.to_string_lossy().into_owned(),
            });
        }
    }
    None
}

/// 连接认证用：从密钥对目录推导私钥路径；未发现时给出可执行中文错误。
pub fn derive_private_key_path(dir: &str) -> Result<String, String> {
    detect_keypair(dir)
        .map(|kp| kp.private_path)
        .ok_or_else(|| {
            let names = KEYPAIR_PRIORITIES.join(" / ");
            format!(
                "密钥对目录 {dir} 下未发现可用的 SSH 密钥对（按 {names} 顺序探测，私钥与同名 .pub 需同时存在）；\
                 请先在凭据设置中补全密钥对目录，或点击「立即生成」创建密钥对"
            )
        })
}

/// 读取密钥对公钥（OpenSSH one-line 格式原文，带注释）供服务器部署。
/// 以 ssh-key 解析校验格式，失败给出中文错误。
pub fn read_public_key_line(dir: &str) -> Result<String, String> {
    let kp = detect_keypair(dir).ok_or_else(|| {
        format!(
            "密钥对目录 {dir} 下未发现可用的 SSH 密钥对（私钥与同名 .pub 需同时存在）；\
             请先在凭据设置中补全密钥对目录，或点击「立即生成」创建密钥对"
        )
    })?;
    let content = std::fs::read_to_string(&kp.public_path)
        .map_err(|e| format!("读取公钥文件 {} 失败: {e}", kp.public_path))?;
    let line = content
        .lines()
        .next()
        .ok_or_else(|| format!("公钥文件 {} 为空", kp.public_path))?
        .trim_end();
    // 原文写入 authorized_keys（保留注释），此处仅校验 OpenSSH 一行公钥格式。
    ssh_key::PublicKey::from_openssh(line)
        .map_err(|e| format!("公钥文件 {} 不是有效的 OpenSSH 公钥: {e}", kp.public_path))?;
    Ok(line.to_string())
}

/// 生成密钥对默认注释(OpenSSH 惯例 user@host,仅标识归属,不参与认证)。
fn default_comment() -> String {
    let user = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "user".into());
    let host = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "localhost".into());
    format!("{user}@{host}")
}

/// 在目录下生成一对 ed25519 无密码短语密钥(文件名恒为 id_ed25519 / id_ed25519.pub)。
/// 任一已存在即拒绝生成(绝不静默覆盖既有密钥);Unix 下私钥 chmod 600。
pub fn generate_keypair_files(dir: &str) -> Result<KeyPairInfo, String> {
    let dir = dir.trim();
    if dir.is_empty() {
        return Err("密钥对目录不能为空".to_string());
    }
    let name = KEYPAIR_PRIORITIES[0];
    let base = PathBuf::from(dir);
    let private = base.join(name);
    let public = base.join(format!("{name}.pub"));
    if private.exists() || public.exists() {
        return Err(format!(
            "{dir} 下已存在 {name} 密钥对，本次未生成（如需重建请先手动删除原文件）"
        ));
    }
    let mut rng = rand::rng();
    let key = ssh_key::PrivateKey::random(&mut rng, ssh_key::Algorithm::Ed25519)
        .map_err(|e| format!("生成 ed25519 密钥对失败: {e}"))?;
    let private_text = key
        .to_openssh(ssh_key::LineEnding::LF)
        .map_err(|e| format!("编码私钥失败: {e}"))?;
    let public_key = key
        .public_key()
        .to_openssh()
        .map_err(|e| format!("编码公钥失败: {e}"))?;
    std::fs::create_dir_all(dir).map_err(|e| format!("创建密钥对目录 {dir} 失败: {e}"))?;
    std::fs::write(&private, private_text.as_str())
        .map_err(|e| format!("写入私钥文件 {} 失败: {e}", private.to_string_lossy()))?;
    std::fs::write(
        &public,
        format!("{public_key} {}\n", default_comment()),
    )
    .map_err(|e| format!("写入公钥文件 {} 失败: {e}", public.to_string_lossy()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o600));
    }
    Ok(KeyPairInfo {
        name: name.to_string(),
        private_path: private.to_string_lossy().into_owned(),
        public_path: public.to_string_lossy().into_owned(),
    })
}

/// 密钥对目录默认值:用户主目录下的 `.ssh`(不存在也返回,由探测/生成按需创建)。
#[tauri::command]
pub fn ssh_default_keypair_dir(app: tauri::AppHandle) -> Result<String, String> {
    let home = app.path().home_dir().map_err(|e| format!("获取用户主目录失败: {e}"))?;
    Ok(home.join(".ssh").to_string_lossy().into_owned())
}

/// 探测目录下是否存在标准命名密钥对(表单「已识别」/「未发现」按钮的判定依据)。
#[tauri::command]
pub fn ssh_detect_keypair(dir: String) -> Option<KeyPairInfo> {
    detect_keypair(&dir)
}

/// 在目录下生成密钥对(ed25519、无密码短语、防覆盖)。
#[tauri::command]
pub fn ssh_generate_keypair(dir: String) -> Result<KeyPairInfo, String> {
    generate_keypair_files(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{AppState, Settings};

    fn temp_dir(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("aishell-ssh-keys-{tag}-{}", std::process::id()))
    }

    fn state_with_workspace(workspace: Option<&PathBuf>) -> AppState {
        AppState {
            settings: Settings {
                workspace_dir: workspace.map(|path| path.to_string_lossy().into_owned()),
                ..Settings::default()
            },
            ..AppState::default()
        }
    }

    #[test]
    fn key_file_name_is_content_hash_and_dedups() {
        let first = key_file_name_for_content(b"KEY-1");
        let same = key_file_name_for_content(b"KEY-1");
        let other = key_file_name_for_content(b"KEY-2");
        assert_eq!(first, same);
        assert_ne!(first, other);
        assert_eq!(first.len(), KEY_NAME_HEX_LEN);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
    }

    #[test]
    fn managed_path_detection_covers_workspace_prefix() {
        let workspace = "E:\\workspace";
        let managed = managed_key_dir(workspace);
        assert!(is_managed_path(&managed.join("ab12").to_string_lossy(), workspace));
        // 大小写与分隔符差异仍视为已收编。
        assert!(is_managed_path("e:/workspace/.aishell/ssh-key/ab12", workspace));
        assert!(!is_managed_path("C:\\Users\\me\\.ssh\\id_rsa", workspace));
        assert!(!is_managed_path(
            &PathBuf::from(workspace)
                .join(".aishell")
                .join("ssh-key-other")
                .join("k")
                .to_string_lossy(),
            workspace
        ));
    }

    #[test]
    fn adopt_copies_key_once_and_is_idempotent() {
        let root = temp_dir("adopt");
        std::fs::create_dir_all(&root).unwrap();
        let external = root.join("origin-key");
        std::fs::write(&external, "KEY-CONTENT").unwrap();
        // 收编：返回保管路径，内容一致，原文件保持不动（复制而非移动）。
        let adopted = adopt_key_into_workspace(
            root.to_string_lossy().as_ref(),
            external.to_string_lossy().as_ref(),
        )
        .unwrap();
        assert_eq!(
            adopted,
            managed_key_dir(root.to_string_lossy().as_ref())
                .join(key_file_name_for_content(b"KEY-CONTENT"))
                .to_string_lossy()
                .into_owned()
        );
        assert_eq!(std::fs::read(&adopted).unwrap(), b"KEY-CONTENT");
        assert!(external.exists());
        // 再收编保管路径本身 → None（幂等，key_path 不变）。
        assert!(adopt_key_into_workspace(root.to_string_lossy().as_ref(), &adopted).is_none());
        // 不可读路径 → None。
        assert!(adopt_key_into_workspace(
            root.to_string_lossy().as_ref(),
            root.join("missing").to_string_lossy().as_ref()
        )
        .is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn managed_dir_comes_from_workspace_only() {
        let root = temp_dir("wsdir");
        let mut state = state_with_workspace(Some(&root));
        assert_eq!(
            managed_key_dir_from_state(&state).unwrap(),
            root.join(".aishell").join("ssh-key")
        );
        state.settings.workspace_dir = Some("  ".into());
        assert!(managed_key_dir_from_state(&state).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn detect_prefers_ed25519_and_requires_pub() {
        let root = temp_dir("detect");
        std::fs::create_dir_all(&root).unwrap();
        // 只有私钥没有同名 .pub，不算密钥对。
        std::fs::write(root.join("id_rsa"), "PRIVATE").unwrap();
        assert!(detect_keypair(root.to_str().unwrap()).is_none());
        // 补上 .pub → 识别为 id_rsa；再加 ed25519 对 → 优先级最高。
        std::fs::write(root.join("id_rsa.pub"), "PUB").unwrap();
        assert_eq!(detect_keypair(root.to_str().unwrap()).unwrap().name, "id_rsa");
        std::fs::write(root.join("id_ed25519"), "PRIVATE").unwrap();
        std::fs::write(root.join("id_ed25519.pub"), "PUB").unwrap();
        assert_eq!(
            detect_keypair(root.to_str().unwrap()).unwrap().name,
            "id_ed25519"
        );
        // 空目录 / 不存在目录 → None。
        assert!(detect_keypair("").is_none());
        assert!(detect_keypair(root.join("missing").to_str().unwrap()).is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn derive_provides_actionable_error() {
        let root = temp_dir("derive");
        let err = derive_private_key_path(root.to_str().unwrap()).unwrap_err();
        assert!(err.contains("未发现可用的 SSH 密钥对"));
        assert!(err.contains("立即生成"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn generate_writes_openssh_pair_and_refuses_overwrite() {
        let root = temp_dir("gen");
        let kp = generate_keypair_files(root.to_str().unwrap()).unwrap();
        assert_eq!(kp.name, "id_ed25519");
        let private_text = std::fs::read_to_string(&kp.private_path).unwrap();
        assert!(private_text.contains("OPENSSH PRIVATE KEY"));
        let public_text = std::fs::read_to_string(&kp.public_path).unwrap();
        assert!(public_text.starts_with("ssh-ed25519 "));
        // 防覆盖：已存在时拒绝生成。
        let err = generate_keypair_files(root.to_str().unwrap()).unwrap_err();
        assert!(err.contains("已存在 id_ed25519 密钥对"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn read_public_key_line_validates_and_roundtrips() {
        let root = temp_dir("readpub");
        let kp = generate_keypair_files(root.to_str().unwrap()).unwrap();
        let line = read_public_key_line(root.to_str().unwrap()).unwrap();
        assert_eq!(
            line,
            std::fs::read_to_string(&kp.public_path).unwrap().trim_end()
        );
        // 非法内容 → Err。
        std::fs::write(&kp.public_path, "NOT A KEY").unwrap();
        assert!(read_public_key_line(root.to_str().unwrap()).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
