//! pcap 抓包查看器的读字节命令 —— pcap/pcapng 的解析与协议解码全部在前端（src/pcap/），
//! 后端只负责把本地或远端（SFTP）文件字节以 base64 交给前端（照 ai_images.rs 先例）。
//! 本地走 fs::read；远端复用 ssh::SshManager 连接池开 SftpSession 流式读。
//! 统一上限 128MB：前端整文件解析 + IPC base64 传输（约 1.33 倍体积）的折中；
//! 超限引导用户先用 tcpdump -r/-w 预过滤。

use std::path::Path;
use std::sync::Arc;

use base64::Engine;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::State;
use tokio::io::AsyncReadExt;

use crate::ssh::SshManager;

/// 抓包文件大小上限（128MB）。
const MAX_PCAP_BYTES: u64 = 128 * 1024 * 1024;

/// 流式读缓冲（与 sftp.rs 拷贝缓冲一致）。
const READ_BUF: usize = 64 * 1024;

/// pcap_read 结果：data 为不带 dataURL 前缀的 base64（与 src/types.ts PcapReadOut 对齐）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcapReadOut {
    pub data: String,
    pub size: u64,
}

/// 魔数嗅探：pcap（µs/ns × 大小端四种）或 pcapng（SHB 块类型 + 字节序魔数头两字节即 0x0A0D0D0A）。
fn is_capture_file(bytes: &[u8]) -> bool {
    let Some(head) = bytes.get(..4) else {
        return false;
    };
    matches!(
        head,
        [0xd4, 0xc3, 0xb2, 0xa1] // pcap 小端 µs
            | [0xa1, 0xb2, 0xc3, 0xd4] // pcap 大端 µs
            | [0x4d, 0x3c, 0xb2, 0xa1] // pcap 小端 ns
            | [0xa1, 0xb2, 0x3c, 0x4d] // pcap 大端 ns
            | [0x0a, 0x0d, 0x0d, 0x0a] // pcapng Section Header Block
    )
}

/// 大小检查：超限给中文可执行错误（引导 tcpdump 预过滤）。
fn ensure_size(display: &str, size: u64) -> Result<(), String> {
    if size > MAX_PCAP_BYTES {
        return Err(format!(
            "「{display}」超过 {}MB 上限，请先用 tcpdump 预过滤（如 tcpdump -r 源文件 -w 目标.pcap 'tcp port 80'）后再打开",
            MAX_PCAP_BYTES / 1024 / 1024
        ));
    }
    Ok(())
}

/// 读取本地抓包文件字节（目录/超限/不存在均报错）。
fn read_local(path: &str) -> Result<Vec<u8>, String> {
    if path.trim().is_empty() {
        return Err("路径不能为空".to_string());
    }
    let file = Path::new(path);
    let display = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());
    let meta = std::fs::metadata(file).map_err(|e| format!("读取「{display}」失败：{e}"))?;
    if meta.is_dir() {
        return Err("不能读取目录".to_string());
    }
    ensure_size(&display, meta.len())?;
    std::fs::read(file).map_err(|e| format!("读取「{display}」失败：{e}"))
}

/// 读取远端抓包文件字节（SftpSession 流式读，目录/超限报错；与 sftp.rs read_text 同结构）。
async fn read_remote(sftp: &SftpSession, remote_path: &str) -> Result<Vec<u8>, String> {
    if remote_path.trim().is_empty() {
        return Err("远端路径不能为空".to_string());
    }
    let md = sftp
        .metadata(remote_path)
        .await
        .map_err(|e| format!("读取远端 {remote_path} 失败: {e}"))?;
    if md.is_dir() {
        return Err(format!("远端 {remote_path} 是目录，不能打开"));
    }
    ensure_size(remote_path, md.size.unwrap_or(0))?;
    let mut f = sftp
        .open(remote_path)
        .await
        .map_err(|e| format!("打开远端 {remote_path} 失败: {e}"))?;
    let mut bytes: Vec<u8> = Vec::new();
    let mut buf = vec![0u8; READ_BUF];
    loop {
        let n = f
            .read(&mut buf)
            .await
            .map_err(|e| format!("读取远端 {remote_path} 失败: {e}"))?;
        if n == 0 {
            break;
        }
        bytes.extend_from_slice(&buf[..n]);
    }
    Ok(bytes)
}

/// 读取抓包文件（本地或远端）为 base64：server_id 为空 → 本地 path；
/// 否则 path 为远端路径、经 SshManager 连接池走 SFTP。
/// 魔数嗅探不符（非 pcap/pcapng）时报错——按内容判定，扩展名不作数。
#[tauri::command]
pub async fn pcap_read(
    ssh: State<'_, Arc<SshManager>>,
    path: String,
    server_id: Option<String>,
) -> Result<PcapReadOut, String> {
    let bytes = match server_id.as_deref() {
        Some(sid) => {
            let sftp = ssh.inner().open_sftp(sid).await?;
            read_remote(&sftp, &path).await?
        }
        None => read_local(&path)?,
    };
    if !is_capture_file(&bytes) {
        return Err("不是支持的抓包文件（仅 pcap/pcapng，按文件内容判定）".to_string());
    }
    Ok(PcapReadOut {
        size: bytes.len() as u64,
        data: base64::engine::general_purpose::STANDARD.encode(&bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_file(name: &str, bytes: &[u8]) -> std::path::PathBuf {
        let path = std::env::temp_dir().join(format!("aishell-pcap-test-{name}"));
        let mut f = std::fs::File::create(&path).unwrap();
        f.write_all(bytes).unwrap();
        path
    }

    #[test]
    fn sniff_pcap_and_pcapng() {
        assert!(is_capture_file(&[0xd4, 0xc3, 0xb2, 0xa1, 0, 0]));
        assert!(is_capture_file(&[0xa1, 0xb2, 0xc3, 0xd4, 0, 0]));
        assert!(is_capture_file(&[0x4d, 0x3c, 0xb2, 0xa1, 0, 0]));
        assert!(is_capture_file(&[0xa1, 0xb2, 0x3c, 0x4d, 0, 0]));
        assert!(is_capture_file(&[0x0a, 0x0d, 0x0d, 0x0a, 0, 0]));
        assert!(!is_capture_file(b"hello world"));
        assert!(!is_capture_file(&[0xd4, 0xc3]));
        assert!(!is_capture_file(&[]));
    }

    #[test]
    fn size_limit() {
        assert!(ensure_size("a.pcap", MAX_PCAP_BYTES).is_ok());
        let err = ensure_size("a.pcap", MAX_PCAP_BYTES + 1).unwrap_err();
        assert!(err.contains("tcpdump"));
    }

    #[test]
    fn read_local_ok() {
        let path = temp_file("ok.pcap", &[0xd4, 0xc3, 0xb2, 0xa1, 1, 2, 3]);
        let bytes = read_local(path.to_str().unwrap()).unwrap();
        assert_eq!(bytes, vec![0xd4, 0xc3, 0xb2, 0xa1, 1, 2, 3]);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_local_dir_and_empty() {
        assert_eq!(read_local("").unwrap_err(), "路径不能为空");
        assert_eq!(
            read_local(std::env::temp_dir().to_str().unwrap()).unwrap_err(),
            "不能读取目录"
        );
        assert!(read_local("C:\\不存在的路径\\x.pcap").is_err());
    }
}
