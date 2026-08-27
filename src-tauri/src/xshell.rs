//! Xshell 会话一键导入。
//!
//! 扫描「文档\NetSarang Computer\<版本>\Xshell\Sessions」下的 .xsh 会话文件
//! （通常为 UTF-16LE + BOM，兼容 UTF-16BE BOM 与 UTF-8），只读取白名单字段后
//! 批量合并进 aishell.json（一次原子持久化，不触碰 SecretStore）。
//!
//! 安全边界：
//! - Password / Passphrase / CapiPin / Pkcs11Pin 永不读取；
//! - UserKey 拒绝路径穿越（只允许单一文件名），keyPath 绝不逃逸 UserKeys 目录；
//! - NSSSH 专用私钥（首行含 NSSSH）AIShell 无法解析，计入 needsAttention 提示用户处理。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::State;

use crate::store::{AuthType, ScannedSession, Server, Store, XshellImportResult};

// ---------------------------------------------------------------- 解码

/// 解码 .xsh 内容：按 BOM 识别 UTF-16LE/BE；无 BOM 时先根据开头的 NUL 字节
/// 识别 UTF-16LE/BE，再尝试 UTF-8（容忍 UTF-8 BOM）。无法解码返回 None（计 skipped）。
fn decode_xsh(bytes: &[u8]) -> Option<String> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return decode_utf16(&bytes[2..], true);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return decode_utf16(&bytes[2..], false);
    }
    if bytes.len() >= 2 && bytes.len().is_multiple_of(2) {
        if bytes[1] == 0 {
            return decode_utf16(bytes, true);
        }
        if bytes[0] == 0 {
            return decode_utf16(bytes, false);
        }
    }
    std::str::from_utf8(bytes)
        .ok()
        .map(|s| s.strip_prefix('\u{feff}').unwrap_or(s).to_string())
}

/// UTF-16 解码（little=true 为 LE）；正确处理代理对，奇数长度返回 None。
fn decode_utf16(bytes: &[u8], little: bool) -> Option<String> {
    if !bytes.len().is_multiple_of(2) {
        return None;
    }
    let units = bytes.chunks_exact(2).map(move |c| {
        if little {
            u16::from_le_bytes([c[0], c[1]])
        } else {
            u16::from_be_bytes([c[0], c[1]])
        }
    });
    std::char::decode_utf16(units)
        .collect::<Result<String, _>>()
        .ok()
}

// ---------------------------------------------------------------- 白名单解析

/// .xsh 白名单字段（按小节归属，键名大小写不敏感）：
/// [CONNECTION] 只取 Protocol/Host/Port，[CONNECTION:AUTHENTICATION] 只取 UserName/UserKey；
/// 其余小节与键（Password / Passphrase / CapiPin / Pkcs11Pin 等）一律不读取。
#[derive(Debug, Default)]
struct XshFields {
    protocol: Option<String>,
    host: Option<String>,
    port: Option<u16>,
    username: Option<String>,
    user_key: Option<String>,
}

/// 逐行解析 INI：按小节名归属字段（节名大小写不敏感），忽略注释行，值取首个 = 之后的内容。
fn parse_xsh(text: &str) -> XshFields {
    let mut f = XshFields::default();
    let mut section = String::new();
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].trim().to_ascii_lowercase();
            continue;
        }
        let Some(eq) = line.find('=') else {
            continue;
        };
        let key = line[..eq].trim().to_ascii_lowercase();
        let value = line[eq + 1..].trim();
        match section.as_str() {
            "connection" => match key.as_str() {
                "protocol" => f.protocol = Some(value.to_string()),
                "host" => f.host = Some(value.to_string()),
                "port" => f.port = value.parse().ok(),
                _ => {}
            },
            "connection:authentication" => match key.as_str() {
                "username" => f.username = Some(value.to_string()),
                "userkey" => f.user_key = Some(value.to_string()),
                _ => {}
            },
            _ => {}
        }
    }
    f
}

// ---------------------------------------------------------------- 稳定 ID

/// FNV-1a 64 位哈希（offset basis 0xcbf29ce484222325，prime 0x100000001b3）。
fn fnv1a64(data: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in data {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// 相对 Sessions 的路径 → 名称：统一 / 分隔、去 .xsh 扩展名（大小写不敏感）、保留分组。
fn normalized_rel_name(rel: &Path) -> String {
    let mut s = String::new();
    for (i, comp) in rel.components().enumerate() {
        if i > 0 {
            s.push('/');
        }
        s.push_str(&comp.as_os_str().to_string_lossy());
    }
    if s.len() >= 4 && s.as_bytes()[s.len() - 4..].eq_ignore_ascii_case(b".xsh") {
        s.truncate(s.len() - 4);
    }
    s
}

/// 相对 Sessions 的路径 → 所属目录：父目录组件以 '/' 连接（如 "生产环境/Web"）；
/// 根目录下的文件返回空串（未分类）。
fn rel_folder(rel: &Path) -> String {
    let mut comps = rel.components();
    comps.next_back(); // 去掉文件名
    comps
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

/// 稳定 ID：名称统一分隔符、转小写后做 FNV-1a 64，格式 xshell-<16 位小写 hex>。
fn session_id(name: &str) -> String {
    format!(
        "xshell-{:016x}",
        fnv1a64(name.to_ascii_lowercase().as_bytes())
    )
}

// ---------------------------------------------------------------- 文件收集

/// 递归收集目录下的 .xsh 文件（扩展名严格大小写不敏感等于 .xsh，排除 default.xshf 等）；
/// 每次遍历按文件名排序，保证候选顺序确定性。
fn collect_xsh_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = rd.filter_map(|e| e.ok()).collect();
    entries.sort_by_key(|e| e.file_name());
    for e in entries {
        let p = e.path();
        if p.is_dir() {
            collect_xsh_files(&p, out);
        } else if p
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("xsh"))
        {
            out.push(p);
        }
    }
}

// ---------------------------------------------------------------- 密钥路径

/// UserKey → .pri 文件名：不带 .pri 扩展名时补上。
fn key_file_name(user_key: &str) -> String {
    let key = user_key.trim();
    if key.to_ascii_lowercase().ends_with(".pri") {
        key.to_string()
    } else {
        format!("{key}.pri")
    }
}

/// UserKey 必须为单一文件名：显式拒绝路径穿越（值含 ..、/、\ 或非单一组件的值一律拒绝）。
/// 返回安全的 .pri 文件名；不合法返回 None（会话仍导入，keyPath 留空并计 needsAttention）。
fn safe_user_key_name(user_key: &str) -> Option<String> {
    let key = user_key.trim();
    if key.is_empty() || key.contains("..") || key.contains('/') || key.contains('\\') {
        return None;
    }
    // 兜底：拦截其余异常组件（如 ":"、"."）
    if Path::new(key).file_name() != Some(std::ffi::OsStr::new(key)) {
        return None;
    }
    Some(key_file_name(key))
}

// ---------------------------------------------------------------- 会话解析

/// 解析单个 .xsh（rel 为相对 Sessions 目录的路径，用于生成名称与稳定 ID）：
/// 只导入 Protocol=SSH 且 Host 非空、Port 1..65535 的会话；其余返回 None（计 skipped）。
/// 返回 (ScannedSession, 是否需要用户处理)；所属目录随 ScannedSession.folder 携带，
/// 服务器本身不再存目录（目录只用于导入时按目录自动建项目）。
fn parse_session_file(path: &Path, rel: &Path, user_keys_dir: &Path) -> Option<(ScannedSession, bool)> {
    let bytes = fs::read(path).ok()?;
    let text = decode_xsh(&bytes)?;
    let fields = parse_xsh(&text);
    if !fields
        .protocol
        .as_deref()
        .is_some_and(|p| p.eq_ignore_ascii_case("SSH"))
    {
        return None;
    }
    let host_raw = fields.host?;
    let host = host_raw.trim();
    if host.is_empty() {
        return None;
    }
    let port = fields.port?;
    if port == 0 {
        return None;
    }
    let name = normalized_rel_name(rel);
    let user_key = fields.user_key.unwrap_or_default();
    let user_key = user_key.trim();
    let (auth_type, key_path) = if user_key.is_empty() {
        (AuthType::Password, String::new())
    } else {
        match safe_user_key_name(user_key) {
            Some(file_name) => (
                AuthType::Key,
                user_keys_dir.join(file_name).to_string_lossy().into_owned(),
            ),
            // 非法 UserKey（路径穿越）：仍导入会话，但 keyPath 留安全空值
            None => (AuthType::Key, String::new()),
        }
    };
    let server = Server {
        id: session_id(&name),
        name,
        host: host.to_string(),
        port,
        auth_type,
        username: fields.username.unwrap_or_default(),
        key_path,
        credential_id: None,
        // 新导入服务器默认未锁定（锁定是用户显式行为）
        locked: false,
        is_bastion: false,
        bastion_id: None,
        tags: Vec::new(),
    };
    let needs = session_needs_attention(&server, user_key, user_keys_dir);
    // 所属目录：会话文件相对 Sessions 根目录的父目录（'/' 连接）；根目录下为空串（未分类）
    let folder = rel_folder(rel);
    Some((ScannedSession { server, folder }, needs))
}

/// 判定会话是否需要用户后续处理（每会话最多计一次）：
/// 密码认证（密码无法导入）、用户名空、密钥缺失（含路径穿越的非法 UserKey）、
/// 密钥无法读取，或密钥首行是 NSSSH 专用格式（AIShell 的 russh-keys 无法解析）。
fn session_needs_attention(sv: &Server, user_key: &str, user_keys_dir: &Path) -> bool {
    if sv.username.trim().is_empty() {
        return true;
    }
    if user_key.is_empty() {
        return true;
    }
    let Some(file_name) = safe_user_key_name(user_key) else {
        return true;
    };
    let pri = user_keys_dir.join(file_name);
    let Some(bytes) = fs::read(&pri).ok() else {
        return true;
    };
    let Some(text) = decode_xsh(&bytes) else {
        return true;
    };
    if text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .is_some_and(|first| first.contains("NSSSH"))
    {
        return true;
    }
    false
}

// ---------------------------------------------------------------- 目录扫描

/// 扫描单个 Sessions 目录（递归含子分组），返回 (扫描产物列表, 需处理数, 跳过数)。
fn scan_sessions_dir(sessions_dir: &Path) -> (Vec<ScannedSession>, usize, usize) {
    // 密钥目录：<版本>/SECSH/UserKeys（与 Sessions 所在版本目录同级）
    let user_keys_dir = sessions_dir
        .parent()
        .and_then(Path::parent)
        .map(|v| v.join("SECSH").join("UserKeys"))
        .unwrap_or_default();
    let mut files = Vec::new();
    collect_xsh_files(sessions_dir, &mut files);
    files.sort();
    let mut sessions = Vec::with_capacity(files.len());
    let mut attention = 0usize;
    let mut skipped = 0usize;
    for f in &files {
        let rel = f.strip_prefix(sessions_dir).unwrap_or(f);
        match parse_session_file(f, rel, &user_keys_dir) {
            Some((scan, needs)) => {
                if needs {
                    attention += 1;
                }
                sessions.push(scan);
            }
            None => skipped += 1,
        }
    }
    (sessions, attention, skipped)
}

/// 目录名中的版本号（第一个数字串）；没有数字按 0。
fn version_number(name: &str) -> u64 {
    name.chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse()
        .unwrap_or(0)
}

/// 收集根目录下所有「含 Xshell/Sessions」的版本目录候选 (版本号, 目录名, 目录路径)，
/// 按版本号降序、目录名升序排序保证确定性。
fn collect_version_candidates(root: &Path) -> Vec<(u64, String, PathBuf)> {
    let Ok(rd) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out: Vec<(u64, String, PathBuf)> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| {
            let vdir = e.path();
            if vdir.join("Xshell").join("Sessions").is_dir() {
                let name = e.file_name().to_string_lossy().into_owned();
                Some((version_number(&name), name, vdir))
            } else {
                None
            }
        })
        .collect();
    out.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
    out
}

/// 扫描给定根目录列表：跨所有根**全局**只选版本号最高的一个版本目录
/// （避免 Documents 与 OneDrive 并存时重复导入；版本并列按目录名、路径排序确定），
/// 返回 (扫描产物列表, 需处理数, 跳过数)。无任何可用会话目录时返回中文可执行错误。
fn scan_roots(roots: &[PathBuf]) -> Result<(Vec<ScannedSession>, usize, usize), String> {
    let mut candidates: Vec<(u64, String, PathBuf)> = Vec::new();
    for root in roots {
        candidates.extend(collect_version_candidates(root));
    }
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(&b.2)));
    let Some((_, _, vdir)) = candidates.into_iter().next() else {
        return Err(format!(
            "未找到 Xshell 会话目录（已检查 {}），请确认已安装 Xshell，默认会话位置为「文档\\NetSarang Computer\\<版本>\\Xshell\\Sessions」",
            roots
                .iter()
                .map(|p| p.display().to_string())
                .collect::<Vec<_>>()
                .join("、")
        ));
    };
    Ok(scan_sessions_dir(&vdir.join("Xshell").join("Sessions")))
}

/// 候选根目录：常规 Documents 与 OneDrive 重定向后的 Documents。
fn xshell_roots() -> Vec<PathBuf> {
    let Some(profile) = std::env::var_os("USERPROFILE") else {
        return Vec::new();
    };
    let profile = PathBuf::from(profile);
    let mut roots = vec![profile.join("Documents").join("NetSarang Computer")];
    let onedrive_docs = profile.join("OneDrive").join("Documents");
    if onedrive_docs.is_dir() {
        roots.push(onedrive_docs.join("NetSarang Computer"));
    }
    roots
}

/// 扫描本机所有候选根目录。
fn scan_all() -> Result<(Vec<ScannedSession>, usize, usize), String> {
    scan_roots(&xshell_roots())
}

/// 扫描用户手动指定的目录：自动定位 Sessions 会话目录。
///
/// 探测顺序（dir 为任意深度均可）：
///   1. dir 本身是 Sessions 目录（目录名不区分大小写）；
///   2. dir/Xshell/Sessions（版本目录，如「文档\NetSarang Computer\7」）；
///   3. dir/Sessions；
///   4. dir 是 NetSarang Computer 根（其直接子目录为版本目录），取版本号最高者。
///
/// 全部未命中时返回中文可执行错误（说明应选择哪个目录）。
fn scan_from_dir(dir: &Path) -> Result<(Vec<ScannedSession>, usize, usize), String> {
    let is_sessions_dir = |p: &Path| {
        p.file_name()
            .map(|n| n.to_string_lossy().eq_ignore_ascii_case("Sessions"))
            .unwrap_or(false)
    };
    let dir_sessions = dir.join("Sessions");
    let sessions = if is_sessions_dir(dir) {
        Some(dir.to_path_buf())
    } else if dir.join("Xshell").join("Sessions").is_dir() {
        Some(dir.join("Xshell").join("Sessions"))
    } else if dir_sessions.is_dir() {
        Some(dir_sessions)
    } else {
        None
    };
    if let Some(s) = sessions {
        return Ok(scan_sessions_dir(&s));
    }
    // 兜底：当作 NetSarang Computer 根目录（直接子目录为版本目录）
    if let Some((_, _, vdir)) = collect_version_candidates(dir).into_iter().next() {
        return Ok(scan_sessions_dir(&vdir.join("Xshell").join("Sessions")));
    }
    Err(format!(
        "所选目录「{}」下未找到 Xshell 会话目录。请选择包含 .xsh 会话文件的目录，例如「文档\\NetSarang Computer\\<版本>\\Xshell\\Sessions」或其上级目录",
        dir.display()
    ))
}

// ---------------------------------------------------------------- Tauri 命令

/// 一键导入 Xshell 会话：扫描 → 解析 → 批量合并进 aishell.json（一次原子持久化，不触碰密钥库）。
#[tauri::command]
pub async fn import_xshell_sessions(
    store: State<'_, Arc<Store>>,
) -> Result<XshellImportResult, String> {
    let (sessions, attention, skipped) = scan_all()?;
    let mut result = store.merge_xshell_servers(&sessions)?;
    result.needs_attention = attention;
    result.skipped = skipped;
    Ok(result)
}

/// 从用户手动指定的目录导入 Xshell 会话（自动定位 Sessions 子目录，失败时给出可执行提示）。
#[tauri::command]
pub async fn import_xshell_from_dir(
    store: State<'_, Arc<Store>>,
    dir: String,
) -> Result<XshellImportResult, String> {
    if dir.trim().is_empty() {
        return Err("未选择目录".to_string());
    }
    let (sessions, attention, skipped) = scan_from_dir(Path::new(dir.trim()))?;
    let mut result = store.merge_xshell_servers(&sessions)?;
    result.needs_attention = attention;
    result.skipped = skipped;
    Ok(result)
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::test_store;

    /// 独立临时目录（按 pid+tag 命名，测试间不冲突；绝不触碰真实用户配置）。
    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("aishell-xshell-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// UTF-16LE + BOM 编码（Xshell 默认写盘格式）。
    fn utf16le_bom(text: &str) -> Vec<u8> {
        let mut out = vec![0xFF, 0xFE];
        for u in text.encode_utf16() {
            out.extend_from_slice(&u.to_le_bytes());
        }
        out
    }

    #[test]
    fn fnv1a64_known_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
    }

    #[test]
    fn session_id_is_stable_lowercased_hex() {
        let id = session_id("Prod/Web-01");
        assert_eq!(session_id("Prod/Web-01"), id);
        // 统一转小写：大小写不同的相对路径得到同一 ID
        assert_eq!(session_id("prod/web-01"), id);
        assert!(id.starts_with("xshell-"));
        assert_eq!(id.len(), 7 + 16);
        assert!(id[7..].chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn decode_handles_utf16_le_be_and_utf8() {
        // UTF-16LE + BOM（Xshell 默认）
        let s = decode_xsh(&utf16le_bom("[CONNECTION]\nHost=中文主机\n")).unwrap();
        assert!(s.contains("Host=中文主机"));
        // UTF-16BE + BOM
        let mut be = vec![0xFE, 0xFF];
        for u in "Host=ok".encode_utf16() {
            be.extend_from_slice(&u.to_be_bytes());
        }
        assert_eq!(decode_xsh(&be).as_deref(), Some("Host=ok"));
        // UTF-8 明文
        assert_eq!(decode_xsh(b"Host=plain").as_deref(), Some("Host=plain"));
        // UTF-8 BOM
        let mut bom = vec![0xEF, 0xBB, 0xBF];
        bom.extend_from_slice(b"Host=bom");
        assert_eq!(decode_xsh(&bom).as_deref(), Some("Host=bom"));
        // 无 BOM 的 UTF-16LE 兜底
        let mut le = Vec::new();
        for u in "Host=fallback".encode_utf16() {
            le.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(decode_xsh(&le).as_deref(), Some("Host=fallback"));
        // 奇数长度 / 孤立代理项 → 无法解码
        assert!(decode_xsh(&[0xFF, 0x00, 0xFF]).is_none());
        assert!(decode_xsh(&[0x3D, 0xD8, 0x00, 0x00]).is_none());
    }

    #[test]
    fn parse_xsh_reads_only_whitelist() {
        let text = "[CONNECTION]\nHost=10.0.0.1\nPort = 2202\nProtocol=SSH\n\
                    UserName=wrong-section\nUserKey=leak\n\
                    [CONNECTION:AUTHENTICATION]\nUserName=admin\nUserKey=mykey\n\
                    Password=super-secret\nPassphrase=phrase-1\nCapiPin=pin-2\nPkcs11Pin=pin-3\n\
                    AuthMethodList=00,01\n; 注释行\n# 注释行";
        let f = parse_xsh(text);
        assert_eq!(f.host.as_deref(), Some("10.0.0.1"));
        assert_eq!(f.port, Some(2202));
        assert_eq!(f.protocol.as_deref(), Some("SSH"));
        assert_eq!(f.username.as_deref(), Some("admin"));
        assert_eq!(f.user_key.as_deref(), Some("mykey"));
        // 小节归属严格：CONNECTION 下的 UserName/UserKey 不生效
        assert_ne!(f.username.as_deref(), Some("wrong-section"));
        assert_ne!(f.user_key.as_deref(), Some("leak"));
        // 敏感键不进入任何解析结构（白名单之外一概不读取）
        let dbg = format!("{f:?}");
        assert!(!dbg.contains("super-secret") && !dbg.contains("phrase-1"));
        assert!(!dbg.contains("pin-2") && !dbg.contains("pin-3"));
        // 键名与节名大小写不敏感
        let f2 = parse_xsh("[connection]\nhost=1.2.3.4\nport=22\nprotocol=ssh\n[CONNECTION:AUTHENTICATION]\nusername=root\nuserkey=k\n");
        assert_eq!(f2.host.as_deref(), Some("1.2.3.4"));
        assert_eq!(f2.port, Some(22));
        assert_eq!(f2.protocol.as_deref(), Some("ssh"));
        assert_eq!(f2.username.as_deref(), Some("root"));
        assert_eq!(f2.user_key.as_deref(), Some("k"));
    }

    #[test]
    fn invalid_sessions_are_skipped() {
        let root = temp_dir("skip");
        let sessions = root.join("Sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("telnet.xsh"),
            "[CONNECTION]\nHost=1.1.1.1\nPort=23\nProtocol=TELNET\n",
        )
        .unwrap();
        fs::write(
            sessions.join("nohost.xsh"),
            "[CONNECTION]\nPort=22\nProtocol=SSH\n",
        )
        .unwrap();
        fs::write(
            sessions.join("badport.xsh"),
            "[CONNECTION]\nHost=2.2.2.2\nPort=65536\nProtocol=SSH\n",
        )
        .unwrap();
        fs::write(
            sessions.join("zeroport.xsh"),
            "[CONNECTION]\nHost=3.3.3.3\nPort=0\nProtocol=SSH\n",
        )
        .unwrap();
        fs::write(sessions.join("garbage.xsh"), [0x80, 0x81, 0x82]).unwrap();
        // default.xshf（会话文件夹文件）不是会话，不应被当作候选
        fs::write(
            sessions.join("default.xshf"),
            "[CONNECTION]\nHost=4.4.4.4\nPort=22\nProtocol=SSH\n",
        )
        .unwrap();
        let (scanned, attention, skipped) = scan_sessions_dir(&sessions);
        assert!(scanned.is_empty());
        assert_eq!(attention, 0);
        assert_eq!(skipped, 5);
    }

    #[test]
    fn attention_flags_password_empty_user_missing_and_nsssh_keys() {
        let root = temp_dir("attn");
        let vdir = root.join("7");
        let sessions = vdir.join("Xshell").join("Sessions");
        let keys = vdir.join("SECSH").join("UserKeys");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&keys).unwrap();
        // 密码认证（无 UserKey）→ 需处理
        fs::write(sessions.join("pw.xsh"), "[CONNECTION]\nHost=1.1.1.1\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=root\n").unwrap();
        // 用户名空 → 需处理
        fs::write(sessions.join("nouser.xsh"), "[CONNECTION]\nHost=2.2.2.2\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserKey=good\n").unwrap();
        // 密钥缺失 → 需处理
        fs::write(sessions.join("missing-key.xsh"), "[CONNECTION]\nHost=3.3.3.3\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=root\nUserKey=nonexistent\n").unwrap();
        // NSSSH 专用格式 → 需处理（AIShell 的 russh-keys 无法解析）
        fs::write(keys.join("nsssh.pri"), "---- BEGIN NSSSH PRIVATE KEY ----\nKey: 7, ssh-rsa\nAAAA\n---- END NSSSH PRIVATE KEY ----\n").unwrap();
        fs::write(sessions.join("nsssh-key.xsh"), "[CONNECTION]\nHost=4.4.4.4\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=root\nUserKey=nsssh\n").unwrap();
        // 正常 OpenSSH 密钥 → 不需处理
        fs::write(
            keys.join("good.pri"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();
        fs::write(sessions.join("good-key.xsh"), "[CONNECTION]\nHost=5.5.5.5\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=root\nUserKey=good\n").unwrap();
        // 同一会话命中多种问题也只计一次（用户名空 + 密钥缺失）
        fs::write(sessions.join("multi.xsh"), "[CONNECTION]\nHost=6.6.6.6\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserKey=nonexistent\n").unwrap();

        let (scanned, attention, skipped) = scan_sessions_dir(&sessions);
        assert_eq!(skipped, 0);
        assert_eq!(scanned.len(), 6);
        assert_eq!(
            attention, 5,
            "pw、nouser、missing-key、nsssh-key、multi 各计一次"
        );
        assert_eq!(
            scanned
                .iter()
                .find(|s| s.server.name == "pw")
                .unwrap()
                .server
                .auth_type,
            AuthType::Password
        );
        assert_eq!(
            scanned
                .iter()
                .find(|s| s.server.name == "good-key")
                .unwrap()
                .server
                .auth_type,
            AuthType::Key
        );
    }

    #[test]
    fn user_key_path_traversal_is_rejected() {
        let root = temp_dir("traversal");
        let vdir = root.join("Xshell 7");
        let sessions = vdir.join("Xshell").join("Sessions");
        let keys = vdir.join("SECSH").join("UserKeys");
        fs::create_dir_all(&sessions).unwrap();
        fs::create_dir_all(&keys).unwrap();
        // 陷阱：真实密钥文件放在 UserKeys 之外，若 UserKey 被拼接就会逃逸目录
        fs::write(
            root.join("evil.pri"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();
        fs::write(sessions.join("dotdot.xsh"), "[CONNECTION]\nHost=1.1.1.1\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=root\nUserKey=..\\evil\n").unwrap();
        fs::write(sessions.join("slash.xsh"), "[CONNECTION]\nHost=2.2.2.2\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=root\nUserKey=sub\\key\n").unwrap();
        fs::write(sessions.join("dots.xsh"), "[CONNECTION]\nHost=3.3.3.3\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=root\nUserKey=a..b\n").unwrap();
        let (scanned, attention, skipped) = scan_sessions_dir(&sessions);
        assert_eq!(skipped, 0);
        assert_eq!(scanned.len(), 3, "穿越 UserKey 的会话仍应导入");
        for s in &scanned {
            assert_eq!(s.server.auth_type, AuthType::Key);
            assert!(
                s.server.key_path.is_empty(),
                "keyPath 必须留安全空值: {}",
                s.server.key_path
            );
        }
        assert_eq!(attention, 3, "无法定位密钥需计 needsAttention");
    }

    #[test]
    fn picks_only_highest_version_globally_across_roots() {
        let root1 = temp_dir("versions-a");
        let v6 = root1.join("6");
        fs::create_dir_all(v6.join("Xshell").join("Sessions")).unwrap();
        fs::write(
            v6.join("Xshell").join("Sessions").join("old.xsh"),
            "[CONNECTION]\nHost=1.1.1.1\nPort=22\nProtocol=SSH\n",
        )
        .unwrap();
        let v7 = root1.join("Xshell 7");
        fs::create_dir_all(v7.join("Xshell").join("Sessions")).unwrap();
        fs::write(
            v7.join("Xshell").join("Sessions").join("new.xsh"),
            "[CONNECTION]\nHost=2.2.2.2\nPort=22\nProtocol=SSH\n",
        )
        .unwrap();
        // 无 Sessions 的产品目录（如 Xftp 7）不应影响版本选择
        fs::create_dir_all(root1.join("Xftp 7").join("Xftp")).unwrap();
        // 第二个根（如 OneDrive 重定向）含更高版本：全局只取最高者
        let root2 = temp_dir("versions-b");
        let v8 = root2.join("8");
        fs::create_dir_all(v8.join("Xshell").join("Sessions")).unwrap();
        fs::write(
            v8.join("Xshell").join("Sessions").join("newest.xsh"),
            "[CONNECTION]\nHost=9.9.9.9\nPort=22\nProtocol=SSH\n",
        )
        .unwrap();

        let (scanned, _a, _s) = scan_roots(&[root1.clone(), root2.clone()]).unwrap();
        assert_eq!(scanned.len(), 1, "跨根只应扫一个最高版本目录");
        assert_eq!(scanned[0].server.name, "newest");
        assert_eq!(scanned[0].server.host, "9.9.9.9");
    }

    #[test]
    fn missing_root_returns_chinese_actionable_error() {
        let root = temp_dir("missing");
        let err = scan_roots(&[root.join("NetSarang Computer")]).unwrap_err();
        assert!(err.contains("未找到 Xshell 会话目录"), "{err}");
        assert!(err.contains("文档"), "{err}");
        assert!(err.contains("Sessions"), "{err}");
    }

    #[test]
    fn import_scan_and_merge_end_to_end_idempotent() {
        let root = temp_dir("e2e");
        let sessions = root
            .join("NetSarang Computer")
            .join("Xshell 7")
            .join("Xshell")
            .join("Sessions");
        fs::create_dir_all(sessions.join("prod")).unwrap();
        let user_keys = root
            .join("NetSarang Computer")
            .join("Xshell 7")
            .join("SECSH")
            .join("UserKeys");
        fs::create_dir_all(&user_keys).unwrap();
        // 典型 Xshell 写盘格式：UTF-16LE + BOM；Password 字段必须被忽略
        fs::write(
            sessions.join("prod").join("web-01.xsh"),
            utf16le_bom("[CONNECTION]\nHost=47.102.118.66\nPort=22\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=deploy\nPassword=secret-never-read\n"),
        )
        .unwrap();
        // UTF-8 明文 + UserKey 指向可用密钥
        fs::write(
            sessions.join("prod").join("web-02.xsh"),
            "[CONNECTION]\nHost=1.2.3.4\nPort=2222\nProtocol=SSH\n[CONNECTION:AUTHENTICATION]\nUserName=ubuntu\nUserKey=mykey\n",
        )
        .unwrap();
        // 非 SSH → skipped
        fs::write(
            sessions.join("telnet-1.xsh"),
            "[CONNECTION]\nHost=5.6.7.8\nPort=23\nProtocol=TELNET\n",
        )
        .unwrap();
        // 端口越界 → skipped
        fs::write(
            sessions.join("bad-port.xsh"),
            "[CONNECTION]\nHost=5.6.7.8\nPort=70000\nProtocol=SSH\n",
        )
        .unwrap();
        // 无法解析 → skipped
        fs::write(sessions.join("garbage.xsh"), [0x00, 0x01, 0x02]).unwrap();
        fs::write(
            user_keys.join("mykey.pri"),
            "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n",
        )
        .unwrap();

        let (scanned, attention, skipped) =
            scan_roots(&[root.join("NetSarang Computer")]).unwrap();
        assert_eq!(scanned.len(), 2);
        assert_eq!(attention, 1); // web-01 是密码认证
        assert_eq!(skipped, 3);

        // 嵌套会话保留分组名称、ID 稳定且为 16 位小写 hex；目录随 ScannedSession.folder 携带
        let web01 = scanned
            .iter()
            .find(|s| s.server.name == "prod/web-01")
            .unwrap();
        assert_eq!(web01.folder, "prod");
        assert_eq!(web01.server.host, "47.102.118.66");
        assert_eq!(web01.server.port, 22);
        assert_eq!(web01.server.auth_type, AuthType::Password);
        assert!(web01.server.key_path.is_empty());
        assert!(
            web01.server.id.starts_with("xshell-") && web01.server.id.len() == 23
        );

        let web02 = scanned
            .iter()
            .find(|s| s.server.name == "prod/web-02")
            .unwrap();
        assert_eq!(web02.folder, "prod");
        assert_eq!(web02.server.auth_type, AuthType::Key);
        assert_eq!(
            web02.server.key_path,
            user_keys.join("mykey.pri").to_string_lossy().into_owned()
        );

        // 合并进测试 Store（内存密钥，绝不触碰真实 keyring）：按目录自动建项目
        let store = test_store(temp_dir("e2e-store"));
        let r = store.merge_xshell_servers(&scanned).unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (2, 0, 0));
        assert_eq!(r.projects_created, 1, "目录 prod 应自动新建项目");
        // 重复导入幂等：全部 unchanged，不重复建项目
        let r = store.merge_xshell_servers(&scanned).unwrap();
        assert_eq!((r.imported, r.updated, r.unchanged), (0, 0, 2));
        assert_eq!(r.projects_created, 0, "重复导入不重复建项目");
        // 导入后自动创建凭据并回填 credentialId；其余连接字段保持扫描结果。
        for scanned in [web01, web02] {
            let stored = store.server(&scanned.server.id).unwrap();
            assert_eq!(
                stored.credential_id.as_deref(),
                Some(format!("credential-{}", scanned.server.id).as_str())
            );
            assert_eq!(stored.name, scanned.server.name);
            assert_eq!(stored.host, scanned.server.host);
            assert_eq!(stored.auth_type, scanned.server.auth_type);
            assert_eq!(stored.username, scanned.server.username);
            assert_eq!(stored.key_path, scanned.server.key_path);
        }
    }

    #[test]
    fn scan_from_dir_locates_sessions_at_any_depth() {
        let root = temp_dir("fromdir");
        let sessions = root
            .join("NetSarang Computer")
            .join("Xshell 7")
            .join("Xshell")
            .join("Sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("a.xsh"),
            "[CONNECTION]\nHost=1.1.1.1\nPort=22\nProtocol=SSH\n",
        )
        .unwrap();
        fs::write(
            sessions.join("b.xsh"),
            "[CONNECTION]\nHost=2.2.2.2\nPort=22\nProtocol=SSH\n",
        )
        .unwrap();

        // 选到 Sessions 目录本身
        let (scanned, _, _) = scan_from_dir(&sessions).unwrap();
        assert_eq!(scanned.len(), 2);
        // 选到版本目录（...\Xshell 7）
        let (scanned, _, _) = scan_from_dir(sessions.parent().unwrap().parent().unwrap()).unwrap();
        assert_eq!(scanned.len(), 2);
        // 选到 NetSarang Computer 根（版本目录是其直接子目录）
        let (scanned, _, _) = scan_from_dir(&root.join("NetSarang Computer")).unwrap();
        assert_eq!(scanned.len(), 2);
        // 选到完全无关的目录 → 可执行错误
        let err = scan_from_dir(&root).unwrap_err();
        assert!(err.contains("未找到 Xshell 会话目录"), "{err}");
        assert!(err.contains("Sessions"), "{err}");
    }

    #[test]
    fn scan_from_dir_accepts_bare_sessions_subdir() {
        let root = temp_dir("fromdir-bare");
        let sessions = root.join("Sessions");
        fs::create_dir_all(&sessions).unwrap();
        fs::write(
            sessions.join("c.xsh"),
            "[CONNECTION]\nHost=3.3.3.3\nPort=22\nProtocol=SSH\n",
        )
        .unwrap();
        let (scanned, _, _) = scan_from_dir(&root).unwrap();
        assert_eq!(scanned.len(), 1);
        assert_eq!(scanned[0].server.host, "3.3.3.3");
    }
}
