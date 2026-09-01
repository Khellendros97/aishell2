//! SSH 私钥云同步的落盘策略：密钥统一保管在 `<workspace>/.aishell/ssh-key/`，
//! 文件名 = 内容 SHA-256 前 16 位十六进制（同内容同名去重、异内容必不同名，天然防冲突）。
//! 保存密钥型凭据时由 store 把外部私钥「收编」复制进保管目录并改写 key_path；
//! 云同步上传保管文件内容（随凭据端到端加密），恢复时按哈希名写回同一目录并回填 key_path。

use std::path::{Path, PathBuf};

use super::crypto::sha256_hex;
use crate::store::{AppState, Store};

/// 私钥统一放在 `.aishell/ssh-key` 下（workspace 根目录内，凭据跨项目共享）。
const KEY_DIR_COMPONENTS: [&str; 2] = [".aishell", "ssh-key"];
const KEY_NAME_HEX_LEN: usize = 16;
const MAX_NAME_COLLISIONS: u32 = 1000;

/// 私钥文件名 = 内容 SHA-256 前 16 位十六进制：同内容得到同一个文件（去重），
/// 异内容必不同名（防冲突），与原文件名无关。
pub fn key_file_name_for_content(content: &[u8]) -> String {
    sha256_hex(content)[..KEY_NAME_HEX_LEN].to_string()
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

/// 清洗私钥文件名（仅作为恢复侧对旧载荷/异常载荷的兜底）：替换路径分隔符与
/// Windows 非法字符，去掉首尾的点与空白；清洗后为空时回退 `id_key`。
pub fn sanitize_key_file_name(name: &str) -> String {
    let cleaned: String = name
        .trim()
        .chars()
        .map(|c| {
            if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control()
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_end_matches(['.', ' ']).trim_start_matches('.');
    if cleaned.is_empty() {
        "id_key".into()
    } else {
        cleaned.into()
    }
}

fn key_file_matches(path: &Path, content: &str) -> bool {
    std::fs::read(path)
        .map(|bytes| bytes == content.as_bytes())
        .unwrap_or(false)
}

/// 在 dir 下为私钥分配落盘路径：同名同内容直接复用（幂等），同名异内容追加 -2/-3…。
pub fn alloc_key_path(dir: &Path, file_name: &str, content: &str) -> Result<PathBuf, String> {
    let (stem, extension) = match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), Some(ext.to_string())),
        _ => (file_name.to_string(), None),
    };
    let mut candidate = dir.join(file_name);
    let mut suffix = 2;
    while candidate.exists() && !key_file_matches(&candidate, content) {
        if suffix > MAX_NAME_COLLISIONS {
            return Err(format!("目录 {} 下私钥文件名冲突过多", dir.to_string_lossy()));
        }
        candidate = dir.join(match &extension {
            Some(ext) => format!("{stem}-{suffix}.{ext}"),
            None => format!("{stem}-{suffix}"),
        });
        suffix += 1;
    }
    Ok(candidate)
}

/// 写入私钥文件：内容相同则跳过（幂等）；unix 下收紧为 0600。
pub fn write_key_file(path: &Path, content: &str) -> Result<(), String> {
    if key_file_matches(path, content) {
        return Ok(());
    }
    let parent = path
        .parent()
        .ok_or_else(|| format!("私钥路径不合法：{}", path.to_string_lossy()))?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("创建私钥目录 {} 失败: {error}", parent.to_string_lossy()))?;
    std::fs::write(path, content)
        .map_err(|error| format!("写入私钥文件 {} 失败: {error}", path.to_string_lossy()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// 把恢复出的私钥路径回填到凭据与其引用的服务器（二者保存时互为镜像 key_path）。
pub fn backfill_key_path(store: &Store, credential_id: &str, key_path: &str) -> Result<(), String> {
    store.with_candidate_state(|state| {
        let Some(credential) = state
            .credentials
            .iter_mut()
            .find(|credential| credential.id == credential_id)
        else {
            return Err(format!("凭据 {credential_id} 不存在，无法回填 SSH 私钥路径"));
        };
        credential.key_path = key_path.to_string();
        for server in &mut state.servers {
            if server.credential_id.as_deref() == Some(credential_id) {
                server.key_path = key_path.to_string();
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{AppState, AuthType, Credential, Server, Settings};
    use uuid::Uuid;

    fn temp_dir() -> PathBuf {
        std::env::temp_dir().join(format!("aishell-ssh-keys-{}", Uuid::new_v4()))
    }

    fn key_credential(id: &str, key_path: &str) -> Credential {
        Credential {
            id: id.into(),
            name: id.into(),
            auth_type: AuthType::Key,
            username: "u".into(),
            key_path: key_path.into(),
        }
    }

    fn key_server(id: &str, credential_id: &str, key_path: &str) -> Server {
        Server {
            id: id.into(),
            name: id.into(),
            host: "h".into(),
            port: 22,
            auth_type: AuthType::Key,
            username: "u".into(),
            key_path: key_path.into(),
            credential_id: Some(credential_id.into()),
            locked: false,
            is_bastion: false,
            bastion_id: None,
            tags: Vec::new(),
        }
    }

    fn state_with_workspace(workspace: Option<&Path>) -> AppState {
        AppState {
            settings: Settings {
                workspace_dir: workspace.map(|path| path.to_string_lossy().into_owned()),
                ..Settings::default()
            },
            ..AppState::default()
        }
    }

    #[test]
    fn sanitize_replaces_illegal_chars_and_falls_back() {
        assert_eq!(sanitize_key_file_name("id_ed25519"), "id_ed25519");
        assert_eq!(sanitize_key_file_name(" a:b\\c?.pem "), "a_b_c_.pem");
        assert_eq!(sanitize_key_file_name(".."), "id_key");
        assert_eq!(sanitize_key_file_name("密钥/文件"), "密钥_文件");
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
            &PathBuf::from(workspace).join(".aishell").join("ssh-key-other").join("k").to_string_lossy(),
            workspace
        ));
    }

    #[test]
    fn managed_dir_comes_from_workspace_only() {
        let root = temp_dir();
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
    fn alloc_reuses_same_content_and_suffixes_conflicts() {
        let dir = temp_dir();
        std::fs::create_dir_all(&dir).unwrap();
        let first = alloc_key_path(&dir, "id_ed25519", "KEY-1").unwrap();
        write_key_file(&first, "KEY-1").unwrap();
        // 同内容复用同一路径（幂等）。
        assert_eq!(alloc_key_path(&dir, "id_ed25519", "KEY-1").unwrap(), first);
        // 异内容换名，保留扩展名。
        let second = alloc_key_path(&dir, "id_ed25519", "KEY-2").unwrap();
        assert_eq!(second.file_name().unwrap(), "id_ed25519-2");
        let third = alloc_key_path(&dir, "noext", "KEY-3").unwrap();
        write_key_file(&third, "KEY-3").unwrap();
        assert_eq!(
            alloc_key_path(&dir, "noext", "KEY-4").unwrap().file_name().unwrap(),
            "noext-2"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn backfill_updates_credential_and_referencing_servers_only() {
        let dir = temp_dir();
        let store = crate::store::test_store(dir.clone());
        store
            .with_candidate_state(|state| {
                state.credentials.push(key_credential("c1", ""));
                state.credentials.push(key_credential("c2", ""));
                state.servers.push(key_server("s1", "c1", ""));
                state.servers.push(key_server("s2", "c2", ""));
                Ok(())
            })
            .unwrap();
        backfill_key_path(&store, "c1", "D:/keys/id_ed25519").unwrap();
        let snapshot = store.sync_snapshot().unwrap();
        assert_eq!(snapshot.credentials[0].key_path, "D:/keys/id_ed25519");
        assert_eq!(snapshot.credentials[1].key_path, "");
        assert_eq!(snapshot.servers[0].key_path, "D:/keys/id_ed25519");
        assert_eq!(snapshot.servers[1].key_path, "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
