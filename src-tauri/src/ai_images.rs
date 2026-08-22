//! AI 对话图片附件。
//! 契约（src/api.ts 的 ai 段）：
//! - `ai_attach_images`：按来源读取图片字节（本地 fs / 远程 SFTP / 剪贴板 base64），
//!   魔数嗅探校验后物化到 `<project>/.aishell/ai-images/`，返回落盘副本信息；
//!   前端拼成 ImageRef 存入 ChatMsg（aishell.json 只存路径不存 base64）。
//! - `ai_read_image`：回读落盘副本为 base64 供前端缩略图/预览（历史图片均为本地产物，永不走 SFTP）。
//!
//! 发送时前端把 mime+base64 经 ai_chat 的 images 参数传入 pi RPC images 字段（见 ai.rs）。
//! DeepSeek vision 按实际内容判定格式（不看扩展名），故入口必须魔数嗅探；
//! 单图上限 10MB（官方单图 base64 上限 32MiB、请求体 48MiB，留足多图余量）。

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::AsyncReadExt;
use tauri::State;

use crate::ssh::SshManager;
use crate::store::Store;

/// 单张图片大小上限（字节）。
const MAX_IMAGE_BYTES: u64 = 10 * 1024 * 1024;
/// 项目内图片附件目录（相对项目根）。
const AI_IMAGES_DIR: &str = ".aishell/ai-images";

/// attach 入参：source 标记来源，字段按来源互斥。
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "source", rename_all = "lowercase")]
pub enum AttachImageIn {
    /// 本地路径（fs 读取）
    Local { path: String },
    /// 远程路径（SFTP 读取，需 serverId）
    Remote { server_id: String, path: String },
    /// 剪贴板/OS 拖入的 base64（容忍 dataURL 前缀与空白）
    Clipboard { name: String, data: String },
}

/// attach 结果项：落盘副本信息（前端补 id/source/originPath 等组成 ImageRef）。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttachedImage {
    pub name: String,
    pub mime: String,
    pub path: String,
    pub size: i64,
}

/// 回读结果：data 为不带 dataURL 前缀的 base64。
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReadImageOut {
    pub mime: String,
    pub data: String,
}

/// 魔数嗅探（DeepSeek vision 按内容判定格式，扩展名/MIME 声明不作数）。
/// 返回 mime 与规范扩展名（jpeg 统一 .jpg）。
fn sniff_image(bytes: &[u8]) -> Option<(&'static str, &'static str)> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some(("image/png", "png"))
    } else if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        Some(("image/jpeg", "jpg"))
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some(("image/gif", "gif"))
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else {
        None
    }
}

/// 名称净化：替换 Windows/Unix 文件名非法字符与控制符，去首尾空白与开头的点；
/// 净化后只剩下划线/点（如原名是 "/"）时归为 image，防空名与无意义名。
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '_' || c == '.') {
        "image".to_string()
    } else {
        trimmed.to_string()
    }
}

/// 确保扩展名与嗅探格式一致（缺失或不相符时追加/改写为规范扩展名）。
fn ensure_ext(name: &str, ext: &str) -> String {
    let Some(i) = name.rfind('.').filter(|i| *i > 0) else {
        return format!("{name}.{ext}");
    };
    let stem = &name[..i];
    let cur = name[i + 1..].to_ascii_lowercase();
    let ok = cur == ext || (ext == "jpg" && (cur == "jpeg" || cur == "jpg"));
    if ok {
        name.to_string()
    } else {
        format!("{stem}.{ext}")
    }
}

/// 物化一张图片到目标目录：嗅探 → 校验大小 → `<毫秒时间戳>_<净化名>.<规范扩展名>` 落盘。
/// 同名冲突由 unique_local_name 兜底（同批同毫秒同名的极端场景）。
pub(crate) fn materialize_image(dir: &Path, name: &str, bytes: &[u8]) -> Result<AttachedImage, String> {
    let Some((mime, ext)) = sniff_image(bytes) else {
        return Err(format!(
            "「{name}」不是支持的图片（仅 PNG/JPEG/GIF/WebP，按文件内容判定）"
        ));
    };
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(format!(
            "「{name}」超过 {}MB 上限，请压缩后再发送",
            MAX_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let safe_name = ensure_ext(&sanitize_file_name(name), ext);
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let final_name = crate::fsops::unique_local_name(dir, &format!("{ts}_{safe_name}"))
        .map_err(|e| format!("生成图片文件名失败: {e}"))?;
    let target = dir.join(&final_name);
    fs::write(&target, bytes).map_err(|e| format!("写入图片「{}」失败：{e}", target.display()))?;
    Ok(AttachedImage {
        name: safe_name,
        mime: mime.to_string(),
        path: target.to_string_lossy().into_owned(),
        size: bytes.len() as i64,
    })
}

/// 回读落盘图片为 base64（大小上限与 attach 一致；失败给中文可执行错误）。
pub(crate) fn read_image_file(path: &Path) -> Result<ReadImageOut, String> {
    let display = path.display();
    let meta = fs::metadata(path).map_err(|e| format!("读取图片「{display}」失败：{e}"))?;
    if meta.is_dir() {
        return Err(format!("「{display}」是目录，不是图片"));
    }
    if meta.len() > MAX_IMAGE_BYTES {
        return Err(format!("图片「{display}」超过 {}MB 上限", MAX_IMAGE_BYTES / 1024 / 1024));
    }
    let bytes = fs::read(path).map_err(|e| format!("读取图片「{display}」失败：{e}"))?;
    let Some((mime, _)) = sniff_image(&bytes) else {
        return Err(format!("「{display}」不是支持的图片（仅 PNG/JPEG/GIF/WebP）"));
    };
    Ok(ReadImageOut {
        mime: mime.to_string(),
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

/// 远程图片整读到内存（大小上限先经 metadata 拦截，避免白读大文件）。
async fn read_remote_image_bytes(
    sftp: &russh_sftp::client::SftpSession,
    remote_path: &str,
) -> Result<Vec<u8>, String> {
    let md = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| format!("读取远端 {remote_path} 属性失败: {e}"))?;
    if md.is_dir() {
        return Err(format!("远端 {remote_path} 是目录，不是图片"));
    }
    let size = md.size.unwrap_or(0);
    if size > MAX_IMAGE_BYTES {
        return Err(format!(
            "远端 {remote_path} 超过 {}MB 上限，请压缩后再发送",
            MAX_IMAGE_BYTES / 1024 / 1024
        ));
    }
    let mut f = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("打开远端 {remote_path} 失败: {e}"))?;
    let mut bytes: Vec<u8> = Vec::with_capacity(size as usize);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取远端 {remote_path} 失败: {e}"))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
        if bytes.len() as u64 > MAX_IMAGE_BYTES {
            return Err(format!(
                "远端 {remote_path} 超过 {}MB 上限，请压缩后再发送",
                MAX_IMAGE_BYTES / 1024 / 1024
            ));
        }
    }
    Ok(bytes)
}

/// base64 解码（容忍 dataURL 前缀与空白，与 fsops::fs_import 同规则）。
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    let cleaned: String = input
        .split_once(',')
        .map(|(_, b)| b)
        .unwrap_or(input)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|e| format!("图片数据解码失败：{e}"))
}

/// 读取图片并物化：前端 AI 面板粘贴/拖拽/右键添加统一入口。
/// 批量项逐个处理，任一失败整批报错（前端 toast 提示，未落盘的部分由毫秒时间戳天然隔离，不留半批引用）。
#[tauri::command]
pub async fn ai_attach_images(
    store: State<'_, Arc<Store>>,
    ssh: State<'_, Arc<SshManager>>,
    project_id: String,
    items: Vec<AttachImageIn>,
) -> Result<Vec<AttachedImage>, String> {
    if items.is_empty() {
        return Err("没有要添加的图片".to_string());
    }
    let root = store
        .project_path(&project_id)
        .map(PathBuf::from)
        .ok_or_else(|| "项目不存在或未设置路径，无法保存图片附件".to_string())?;
    let dir = root.join(AI_IMAGES_DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("创建图片附件目录失败：{e}"))?;

    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let (name, bytes) = match item {
            AttachImageIn::Local { path } => {
                let meta = fs::metadata(&path).map_err(|e| format!("读取 {path} 失败：{e}"))?;
                if meta.is_dir() {
                    return Err(format!("{path} 是目录，不是图片"));
                }
                if meta.len() > MAX_IMAGE_BYTES {
                    return Err(format!(
                        "{path} 超过 {}MB 上限，请压缩后再发送",
                        MAX_IMAGE_BYTES / 1024 / 1024
                    ));
                }
                let name = Path::new(&path)
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "image".to_string());
                let bytes = fs::read(&path).map_err(|e| format!("读取 {path} 失败：{e}"))?;
                (name, bytes)
            }
            AttachImageIn::Remote { server_id, path } => {
                let sftp = ssh.inner().open_sftp(&server_id).await?;
                let bytes = read_remote_image_bytes(&sftp, &path).await?;
                let name = path
                    .rsplit('/')
                    .next()
                    .filter(|n| !n.is_empty())
                    .unwrap_or("image")
                    .to_string();
                (name, bytes)
            }
            AttachImageIn::Clipboard { name, data } => {
                let bytes = decode_base64(&data)?;
                (name, bytes)
            }
        };
        out.push(materialize_image(&dir, &name, &bytes)?);
    }
    Ok(out)
}

/// 回读落盘图片为 base64（前端缩略图/预览用）。
#[tauri::command]
pub fn ai_read_image(path: String) -> Result<ReadImageOut, String> {
    read_image_file(Path::new(&path))
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    /// 最小合法 PNG 头（嗅探只看魔数，后续字节不参与校验）。
    const PNG_HEAD: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    const JPEG_HEAD: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0];
    const GIF_HEAD: &[u8] = b"GIF89a";
    /// RIFF....WEBPVP8 前缀
    const WEBP_HEAD: &[u8] = b"RIFF\x00\x00\x00\x00WEBPVP8 ";

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aishell-ai-images-test-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn sniff_accepts_four_formats_and_rejects_non_image() {
        assert_eq!(sniff_image(PNG_HEAD).unwrap().0, "image/png");
        assert_eq!(sniff_image(JPEG_HEAD).unwrap().0, "image/jpeg");
        assert_eq!(sniff_image(GIF_HEAD).unwrap().0, "image/gif");
        assert_eq!(sniff_image(WEBP_HEAD).unwrap().0, "image/webp");
        assert!(sniff_image(b"hello world").is_none(), "文本应被拒绝");
        assert!(sniff_image(b"").is_none(), "空内容应被拒绝");
        assert!(sniff_image(b"RIFF\x00\x00\x00\x00XXXX").is_none(), "RIFF 非 WEBP 应被拒绝");
        assert!(sniff_image(b"GIF88a").is_none(), "GIF88a 不是合法魔数");
    }

    #[test]
    fn sanitize_replaces_illegal_chars() {
        assert_eq!(sanitize_file_name("截图 v2.png"), "截图 v2.png");
        assert_eq!(sanitize_file_name("a/b\\c:d*e?f\"g<h>i|j.png"), "a_b_c_d_e_f_g_h_i_j.png");
        assert_eq!(sanitize_file_name("  ..隐藏..png"), "隐藏..png");
        assert_eq!(sanitize_file_name(""), "image");
        assert_eq!(sanitize_file_name("/"), "image");
    }

    #[test]
    fn ensure_ext_matches_sniffed_format() {
        assert_eq!(ensure_ext("截图", "png"), "截图.png");
        assert_eq!(ensure_ext("a.jpeg", "jpg"), "a.jpeg", "jpeg 与 jpg 视为一致");
        assert_eq!(ensure_ext("a.png", "jpg"), "a.jpg", "扩展名与内容不符时改写");
        assert_eq!(ensure_ext("a.tar.gz", "png"), "a.tar.png");
        assert_eq!(ensure_ext(".png", "png"), ".png.png", "开头即点的名不再当扩展名拆");
    }

    #[test]
    fn materialize_then_read_roundtrip() {
        let dir = temp_dir("roundtrip");
        let mut png = PNG_HEAD.to_vec();
        png.extend_from_slice(b"fake-body");
        let attached = materialize_image(&dir, "屏幕截图 2026.png", &png).unwrap();
        assert_eq!(attached.mime, "image/png");
        assert_eq!(attached.size, png.len() as i64);
        assert!(attached.path.contains("屏幕截图 2026.png"), "落盘名应含净化后的原名: {}", attached.path);
        assert_eq!(fs::read(&attached.path).unwrap(), png, "落盘内容应与输入一致");

        // 回读：mime 与 base64 往返
        let out = read_image_file(Path::new(&attached.path)).unwrap();
        assert_eq!(out.mime, "image/png");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(out.data.as_bytes())
            .unwrap();
        assert_eq!(decoded, png);
    }

    #[test]
    fn materialize_rejects_bad_content_and_oversize() {
        let dir = temp_dir("reject");
        let err = materialize_image(&dir, "a.txt", b"not an image").unwrap_err();
        assert!(err.contains("不是支持的图片"), "错误串不符: {err}");

        let mut big = PNG_HEAD.to_vec();
        big.resize(MAX_IMAGE_BYTES as usize + 1, 0);
        let err = materialize_image(&dir, "big.png", &big).unwrap_err();
        assert!(err.contains("上限"), "错误串不符: {err}");
        assert!(dir.read_dir().unwrap().next().is_none(), "拒绝项不应落盘");
    }

    #[test]
    fn materialize_appends_missing_ext_and_dedups() {
        let dir = temp_dir("ext");
        let a = materialize_image(&dir, "pasted", PNG_HEAD).unwrap();
        assert!(a.name.ends_with(".png"), "缺失扩展名应补全: {}", a.name);
        // 同批同毫秒同名的极端场景：unique_local_name 兜底，两次落盘路径必须不同
        let b = materialize_image(&dir, "pasted", PNG_HEAD).unwrap();
        assert_ne!(a.path, b.path, "同名图片不应相互覆盖");
        assert!(Path::new(&a.path).is_file() && Path::new(&b.path).is_file());
    }

    #[test]
    fn clipboard_base64_tolerates_dataurl_prefix() {
        let png = PNG_HEAD.to_vec();
        let b64 = base64::engine::general_purpose::STANDARD.encode(&png);
        assert_eq!(decode_base64(&b64).unwrap(), png);
        assert_eq!(decode_base64(&format!("data:image/png;base64,{b64}")).unwrap(), png);
        assert_eq!(decode_base64(&format!("{b64}\n")).unwrap(), png, "容忍空白");
        assert!(decode_base64("!!!not-base64!!!").is_err());
    }
}
