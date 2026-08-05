//! SFTP 文件管理 —— sftp_home / sftp_list / sftp_upload / sftp_download。
//! 连接一律经 ssh::SshManager::open_sftp 获取（连接复用由 SshManager 负责）；
//! SftpSession 每次命令新建、用完即弃。目录递归在后端完成，重名自动 `name (1).ext`。
//! FsEntry 复用 fsops::FsEntry（serde camelCase，与 src/types.ts 对齐）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use russh_sftp::client::SftpSession;
use tauri::State;
use tokio::io::{AsyncWriteExt, BufReader};

use crate::fsops::{unique_local_name, FsEntry};
use crate::ssh::SshManager;

/// 流式拷贝缓冲大小（64KB）。
const COPY_BUF: usize = 64 * 1024;

/// 解析远端会话的 home 目录（canonicalize(".")）：前端初始定位与 home 按钮都指向它。
#[tauri::command]
pub async fn sftp_home(
    ssh: State<'_, Arc<SshManager>>,
    server_id: String,
) -> Result<String, String> {
    let sftp = ssh.inner().open_sftp(&server_id).await?;
    sftp.canonicalize(".")
        .await
        .map_err(|e| format!("解析远端 home 失败: {e}"))
}

/// 列出远端目录。path 为 "." 或空串时先 canonicalize(".") 取远端 home。
#[tauri::command]
pub async fn sftp_list(
    ssh: State<'_, Arc<SshManager>>,
    server_id: String,
    path: String,
) -> Result<Vec<FsEntry>, String> {
    let sftp = ssh.inner().open_sftp(&server_id).await?;
    let dir = if path.is_empty() || path == "." {
        sftp.canonicalize(".")
            .await
            .map_err(|e| format!("解析远端 home 失败: {e}"))?
    } else {
        path
    };
    let mut entries: Vec<FsEntry> = Vec::new();
    let rd = sftp
        .read_dir(&dir)
        .await
        .map_err(|e| format!("读取远端目录 {dir} 失败: {e}"))?;
    for entry in rd {
        let md = entry.metadata();
        entries.push(FsEntry {
            name: entry.file_name(),
            is_dir: md.is_dir(),
            size: md.size.unwrap_or(0),
            mtime: md.mtime.unwrap_or(0) as i64,
        });
    }
    // 目录优先，再按名称排序（与原型 listChildren 行为一致）
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

/// 上传本地文件/目录到远端目录：目录递归（本地 walk + 远端逐层建目录），文件流式拷贝；
/// 目标重名自动改 `name (1).ext`（目录同理 `name (1)`）。
#[tauri::command]
pub async fn sftp_upload(
    ssh: State<'_, Arc<SshManager>>,
    server_id: String,
    local_path: String,
    remote_dir: String,
) -> Result<(), String> {
    if local_path.trim().is_empty() {
        return Err("本地路径不能为空".to_string());
    }
    let target = if remote_dir.trim().is_empty() || remote_dir == "." {
        ssh.inner().open_sftp(&server_id).await?.canonicalize(".").await
            .map_err(|e| format!("解析远端目录失败: {e}"))?
    } else {
        remote_dir
    };
    let sftp = ssh.inner().open_sftp(&server_id).await?;
    upload_one(&sftp, Path::new(&local_path), &target).await
}

/// 递归上传一个本地文件或目录（async 递归需装箱，见 inner）。
/// pub(crate)：ai_actions 的 AI 上传复用（不改变手动 sftp_upload 语义）。
pub(crate) async fn upload_one(sftp: &SftpSession, local: &Path, remote_dir: &str) -> Result<(), String> {
    async fn inner(sftp: &SftpSession, local: &Path, remote_dir: &str) -> Result<(), String> {
        let md = std::fs::metadata(local)
            .map_err(|e| format!("读取本地 {} 失败: {e}", local.display()))?;
        let name = local
            .file_name()
            .and_then(|n| n.to_str())
            .filter(|n| !n.is_empty())
            .unwrap_or("upload")
            .to_string();
        if md.is_dir() {
            let dir_name = unique_remote_name(sftp, remote_dir, &name).await?;
            let dir_path = join_remote(remote_dir, &dir_name);
            mkdir_ignore_exists(sftp, &dir_path).await?;
            let rd = std::fs::read_dir(local)
                .map_err(|e| format!("读取本地目录 {} 失败: {e}", local.display()))?;
            for ent in rd {
                let ent = ent.map_err(|e| format!("读取本地目录 {} 失败: {e}", local.display()))?;
                Box::pin(inner(sftp, &ent.path(), &dir_path)).await?;
            }
        } else {
            let file_name = unique_remote_name(sftp, remote_dir, &name).await?;
            let file_path = join_remote(remote_dir, &file_name);
            let mut src = tokio::fs::File::open(local)
                .await
                .map_err(|e| format!("打开本地 {} 失败: {e}", local.display()))?;
            let mut dst = sftp
                .create(&file_path)
                .await
                .map_err(|e| format!("创建远端文件 {file_path} 失败: {e}"))?;
            let mut buf = BufReader::with_capacity(COPY_BUF, &mut src);
            tokio::io::copy_buf(&mut buf, &mut dst)
                .await
                .map_err(|e| format!("上传 {} → {file_path} 中断: {e}", local.display()))?;
            // shutdown 排空写队列并关闭远端 handle
            dst.shutdown()
                .await
                .map_err(|e| format!("关闭远端文件 {file_path} 失败: {e}"))?;
        }
        Ok(())
    }
    Box::pin(inner(sftp, local, remote_dir)).await
}

/// 下载远端文件/目录到本地目录：对称递归，本地重名同样自动 `name (1).ext`。
#[tauri::command]
pub async fn sftp_download(
    ssh: State<'_, Arc<SshManager>>,
    server_id: String,
    remote_path: String,
    local_dir: String,
) -> Result<(), String> {
    if remote_path.trim().is_empty() {
        return Err("远端路径不能为空".to_string());
    }
    let local = PathBuf::from(local_dir);
    std::fs::create_dir_all(&local)
        .map_err(|e| format!("创建本地目录 {} 失败: {e}", local.display()))?;
    let sftp = ssh.inner().open_sftp(&server_id).await?;
    download_one(&sftp, &remote_path, &local).await
}

/// 递归下载一个远端文件或目录（async 递归需装箱，见 inner）。
/// pub(crate)：ai_actions 的 AI 下载复用（不改变手动 sftp_download 语义）。
pub(crate) async fn download_one(
    sftp: &SftpSession,
    remote_path: &str,
    local_dir: &Path,
) -> Result<(), String> {
    async fn inner(
        sftp: &SftpSession,
        remote_path: &str,
        local_dir: &Path,
    ) -> Result<(), String> {
        let md = sftp
            .metadata(remote_path)
            .await
            .map_err(|e| format!("读取远端 {} 失败: {e}", remote_path))?;
        let name = remote_path
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or("download")
            .to_string();
        if md.is_dir() {
            let dir_name = unique_local_name(local_dir, &name)?;
            let dir_path = local_dir.join(&dir_name);
            std::fs::create_dir_all(&dir_path)
                .map_err(|e| format!("创建本地目录 {} 失败: {e}", dir_path.display()))?;
            let rd = sftp
                .read_dir(remote_path)
                .await
                .map_err(|e| format!("读取远端目录 {remote_path} 失败: {e}"))?;
            for ent in rd {
                Box::pin(inner(sftp, &ent.path(), &dir_path)).await?;
            }
        } else {
            let file_name = unique_local_name(local_dir, &name)?;
            let file_path = local_dir.join(&file_name);
            let mut src = sftp
                .open(remote_path)
                .await
                .map_err(|e| format!("打开远端 {remote_path} 失败: {e}"))?;
            let mut dst = tokio::fs::File::create(&file_path)
                .await
                .map_err(|e| format!("创建本地 {} 失败: {e}", file_path.display()))?;
            let mut buf = BufReader::with_capacity(COPY_BUF, &mut src);
            tokio::io::copy_buf(&mut buf, &mut dst)
                .await
                .map_err(|e| format!("下载 {remote_path} → {} 中断: {e}", file_path.display()))?;
            dst.flush()
                .await
                .map_err(|e| format!("写入本地 {} 失败: {e}", file_path.display()))?;
        }
        Ok(())
    }
    Box::pin(inner(sftp, remote_path, local_dir)).await
}

/// 远端路径 join：处理 "/" 根目录与尾部斜杠。
fn join_remote(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// 创建远端目录；若已存在（重试/并发）且确为目录，则视为成功。
async fn mkdir_ignore_exists(sftp: &SftpSession, path: &str) -> Result<(), String> {
    match sftp.create_dir(path).await {
        Ok(()) => Ok(()),
        Err(e) => match sftp.metadata(path).await {
            Ok(md) if md.is_dir() => Ok(()),
            _ => Err(format!("创建远端目录 {path} 失败: {e}")),
        },
    }
}

/// 检查远端路径是否存在。
async fn exists_remote(sftp: &SftpSession, dir: &str, name: &str) -> Result<bool, String> {
    let full = join_remote(dir, name);
    sftp.try_exists(&full)
        .await
        .map_err(|e| format!("检查远端 {full} 失败: {e}"))
}

/// 远端重名改名：`name (1).ext`；无扩展名（如目录）为 `name (1)`。
async fn unique_remote_name(sftp: &SftpSession, dir: &str, name: &str) -> Result<String, String> {
    if !exists_remote(sftp, dir, name).await? {
        return Ok(name.to_string());
    }
    let (stem, ext) = split_ext(name);
    for i in 1.. {
        let candidate = format!("{stem} ({i}){ext}");
        if !exists_remote(sftp, dir, &candidate).await? {
            return Ok(candidate);
        }
    }
    unreachable!("重名探测循环必然返回")
}

/// 拆出「最后一个点之前」与「最后一个点及扩展名」；无扩展名时 (name, "")。
fn split_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    }
}
