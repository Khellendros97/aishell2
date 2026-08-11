//! 本地文件操作。
//! 契约（src/api.ts 的 fs 段）：fs_list/fs_read/fs_write/fs_create/fs_delete/fs_stat，
//! FsEntry 与 src/types.ts 对齐（sftp.rs 复用本结构，序列化 camelCase）；FsStat 亦与 src/types.ts 对齐。
//! 全部为同步 std::fs 实现；所有路径拒绝空串，错误以中文可读串返回。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
}

/// 单项属性快照（fs_stat 返回，属性对话框用）。
/// mode 仅 Unix 有值（Windows 本地为 None）；link_target 仅符号链接有值；
/// is_dir 为符号链接自身的类型（不跟随链接展开）。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    pub path: String,
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: i64,
    pub mode: Option<u32>,
    pub readonly: bool,
    pub link_target: Option<String>,
}

/// 读取单项属性：symlink_metadata 不跟随符号链接（链接显示为链接本身，另附 link_target）。
#[tauri::command]
pub fn fs_stat(path: String) -> Result<FsStat, String> {
    let file = non_empty(&path)?;
    let meta = fs::symlink_metadata(&file)
        .map_err(|e| format!("无法访问「{}」：{e}", file.display()))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        Some(meta.permissions().mode())
    };
    #[cfg(not(unix))]
    let mode = None;
    Ok(FsStat {
        path,
        name: file
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| file.display().to_string()),
        is_dir: meta.is_dir(),
        size: meta.len(),
        mtime,
        mode,
        readonly: meta.permissions().readonly(),
        link_target: if meta.file_type().is_symlink() {
            fs::read_link(&file).ok().map(|t| t.to_string_lossy().into_owned())
        } else {
            None
        },
    })
}

fn non_empty(path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() {
        return Err("路径不能为空".to_string());
    }
    Ok(PathBuf::from(path))
}

/// 列出目录内容：目录优先、名称（不区分大小写）排序；mtime 为 unix 秒。
#[tauri::command]
pub fn fs_list(path: String) -> Result<Vec<FsEntry>, String> {
    let dir = non_empty(&path)?;
    let mut entries: Vec<FsEntry> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("无法读取目录「{}」：{e}", dir.display()))? {
        let entry = entry.map_err(|e| format!("读取目录条目失败：{e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = entry.metadata().map_err(|e| format!("读取「{name}」属性失败：{e}"))?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        entries.push(FsEntry {
            name,
            is_dir: meta.is_dir(),
            size: meta.len(),
            mtime,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir.cmp(&a.is_dir).then_with(|| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
        })
    });
    Ok(entries)
}

/// 编辑器文件大小上限（sftp_read 复用同一约束）。
pub(crate) const MAX_EDIT_BYTES: u64 = 5 * 1024 * 1024;
/// 二进制探测字节数（sftp_read 复用同一约束）。
pub(crate) const BINARY_SCAN_BYTES: usize = 8 * 1024;

/// 读取文本文件；>5MB 或前 8KB 含 NUL 字节 → 报错（不可编辑）。
#[tauri::command]
pub fn fs_read(path: String) -> Result<String, String> {
    let file = non_empty(&path)?;
    let meta = fs::metadata(&file).map_err(|e| format!("无法访问「{}」：{e}", file.display()))?;
    if meta.is_dir() {
        return Err("不能读取目录".to_string());
    }
    if meta.len() > MAX_EDIT_BYTES {
        return Err("文件过大或为二进制，无法编辑".to_string());
    }
    let bytes = fs::read(&file).map_err(|e| format!("读取「{}」失败：{e}", file.display()))?;
    let head = &bytes[..bytes.len().min(BINARY_SCAN_BYTES)];
    if head.contains(&0) {
        return Err("文件过大或为二进制，无法编辑".to_string());
    }
    String::from_utf8(bytes).map_err(|_| "文件过大或为二进制，无法编辑".to_string())
}

/// 覆写文本文件（保存场景允许覆盖；目录目标报错）。
#[tauri::command]
pub fn fs_write(path: String, content: String) -> Result<(), String> {
    let file = non_empty(&path)?;
    if file.is_dir() {
        return Err("不能写入目录".to_string());
    }
    if let Some(parent) = file.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!("父目录不存在：{}", parent.display()));
        }
    }
    fs::write(&file, content).map_err(|e| format!("写入「{}」失败：{e}", file.display()))
}

/// 新建文件或目录；父目录必须已存在，目标已存在则报错。
#[tauri::command]
pub fn fs_create(path: String, is_dir: bool) -> Result<(), String> {
    let target = non_empty(&path)?;
    if target.exists() {
        return Err(format!("「{}」已存在", target.display()));
    }
    let parent = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "路径缺少父目录".to_string())?;
    if !parent.is_dir() {
        return Err(format!("父目录不存在：{}", parent.display()));
    }
    if is_dir {
        fs::create_dir(&target).map_err(|e| format!("创建目录「{}」失败：{e}", target.display()))
    } else {
        // create_new：目标不存在才创建，避免覆盖竞态
        fs::File::create_new(&target)
            .map(|_| ())
            .map_err(|e| format!("创建文件「{}」失败：{e}", target.display()))
    }
}

/// 导入 OS 拖入的文件/目录：重名自动 `name (1).ext`；文件内容走 base64。
/// 返回最终落地的名称（前端据此递归子项）。
#[tauri::command]
pub fn fs_import(dir: String, name: String, is_dir: bool, data: Option<String>) -> Result<String, String> {
    let dir = non_empty(&dir)?;
    if !dir.is_dir() {
        return Err(format!("目标目录不存在：{}", dir.display()));
    }
    if name.trim().is_empty() || name.contains(['/', '\\']) {
        return Err("名称非法".to_string());
    }
    let final_name = unique_local_name(&dir, &name)?;
    let target = dir.join(&final_name);
    if is_dir {
        fs::create_dir(&target).map_err(|e| format!("创建目录「{}」失败：{e}", target.display()))?;
    } else {
        let b64 = data.ok_or_else(|| "缺少文件数据".to_string())?;
        let bytes = decode_base64(&b64)?;
        fs::write(&target, bytes).map_err(|e| format!("写入「{}」失败：{e}", target.display()))?;
    }
    Ok(final_name)
}

/// 本地重名改名：`name (1).ext`；无扩展名（如目录）为 `name (1)`。sftp 下载复用。
pub(crate) fn unique_local_name(dir: &std::path::Path, name: &str) -> Result<String, String> {
    if !dir.join(name).exists() {
        return Ok(name.to_string());
    }
    let (stem, ext) = split_ext(name);
    for i in 1.. {
        let candidate = format!("{stem} ({i}){ext}");
        if !dir.join(&candidate).exists() {
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

/// base64 解码（标准字母表，容忍 dataURL 前缀与空白）。
fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let cleaned: String = input
        .split_once(',')
        .map(|(_, b)| b)
        .unwrap_or(input)
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    base64::engine::general_purpose::STANDARD
        .decode(cleaned.as_bytes())
        .map_err(|e| format!("文件数据解码失败：{e}"))
}

/// 移动/重命名：to 为完整目标路径；目标已存在报错；目录禁止移入自身或子孙。
/// Windows rename 跨卷会失败——工作台内移动均在同盘，跨卷场景由用户走系统拷贝。
#[tauri::command]
pub fn fs_move(from: String, to: String) -> Result<(), String> {
    let src = non_empty(&from)?;
    let dst = non_empty(&to)?;
    if !src.exists() {
        return Err(format!("源不存在:「{}」", src.display()));
    }
    if src == dst {
        return Ok(()); // 原地移动视为无操作
    }
    if dst.exists() {
        return Err(format!("目标已存在:「{}」", dst.display()));
    }
    // Path::starts_with 按路径组件比较，E:\a 不会误判 E:\ab
    if src.is_dir() && dst.starts_with(&src) {
        return Err("不能把目录移动到它自身内部".to_string());
    }
    let parent = dst.parent().ok_or_else(|| "目标路径无效".to_string())?;
    if !parent.is_dir() {
        return Err(format!("目标目录不存在:{}", parent.display()));
    }
    fs::rename(&src, &dst).map_err(|e| format!("移动「{}」失败:{e}", src.display()))
}

/// 复制文件/目录(递归):to_dir 内重名自动 `name (1)`;返回最终落地路径。
#[tauri::command]
pub fn fs_copy(from: String, to_dir: String) -> Result<String, String> {
    let src = non_empty(&from)?;
    let dir = non_empty(&to_dir)?;
    if !src.exists() {
        return Err(format!("源不存在:「{}」", src.display()));
    }
    if !dir.is_dir() {
        return Err(format!("目标目录不存在:{}", dir.display()));
    }
    if src.is_dir() && dir.starts_with(&src) {
        return Err("不能把目录复制到它自身内部".to_string());
    }
    let name = src
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "源路径无效".to_string())?;
    let final_name = unique_local_name(&dir, name)?;
    let dst = dir.join(&final_name);
    copy_recursive(&src, &dst)?;
    Ok(dst.to_string_lossy().into_owned())
}

/// 递归复制;调用方已保证 src 存在且 dst 不存在。
fn copy_recursive(src: &Path, dst: &Path) -> Result<(), String> {
    if src.is_dir() {
        fs::create_dir(dst).map_err(|e| format!("创建目录「{}」失败:{e}", dst.display()))?;
        let rd = fs::read_dir(src).map_err(|e| format!("读取目录「{}」失败:{e}", src.display()))?;
        for entry in rd {
            let entry = entry.map_err(|e| format!("读取目录项失败:{e}"))?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        fs::copy(src, dst)
            .map(|_| ())
            .map_err(|e| format!("复制「{}」失败:{e}", src.display()))
    }
}

/// 在系统文件资源管理器中定位该文件/目录(Windows:explorer /select,)。
/// explorer 退出码语义不可靠,spawn 成功即视为成功,不 wait。
#[tauri::command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    let p = non_empty(&path)?;
    if !p.exists() {
        return Err(format!("「{}」不存在", p.display()));
    }
    #[cfg(windows)]
    {
        // 两个坑:/select 与路径必须是同一个 argv token;explorer 不认正斜杠路径
        // (前端树内路径统一用 / 拼接,Path::display 不规范化分隔符,原样传给 explorer 会打开桌面)
        let win_path = p.to_string_lossy().replace('/', "\\");
        std::process::Command::new("explorer")
            .arg(format!("/select,{win_path}"))
            .spawn()
            .map_err(|e| format!("打开系统文件资源管理器失败:{e}"))?;
    }
    #[cfg(not(windows))]
    {
        // 非 Windows:文件打开其父目录,目录打开自身
        let dir = if p.is_dir() {
            p.as_path()
        } else {
            p.parent().unwrap_or(p.as_path())
        };
        let opener = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
        std::process::Command::new(opener)
            .arg(dir)
            .spawn()
            .map_err(|e| format!("打开系统文件管理器失败:{e}"))?;
    }
    Ok(())
}

/// 删除文件或目录（目录递归删除）。
#[tauri::command]
pub fn fs_delete(path: String) -> Result<(), String> {
    let target = non_empty(&path)?;
    if !target.exists() {
        return Err(format!("「{}」不存在", target.display()));
    }
    if target.is_dir() {
        fs::remove_dir_all(&target).map_err(|e| format!("删除目录「{}」失败：{e}", target.display()))
    } else {
        fs::remove_file(&target).map_err(|e| format!("删除文件「{}」失败：{e}", target.display()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime};

    fn tmp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "aishell-fsops-{tag}-{}-{:?}",
            std::process::id(),
            SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn move_rejects_existing_and_self_descendant() {
        let dir = tmp_dir("move");
        fs::write(dir.join("a.txt"), "a").unwrap();
        fs::write(dir.join("b.txt"), "b").unwrap();
        fs::create_dir_all(dir.join("sub/inner")).unwrap();
        let s = |p: &str| dir.join(p).to_string_lossy().into_owned();

        // 目标已存在报错
        assert!(fs_move(s("a.txt"), s("b.txt")).is_err());
        // 目录禁止移入自身子孙
        assert!(fs_move(s("sub"), s("sub/inner/sub")).is_err());
        // 同前缀但非子孙(E:\sub vs E:\subx)不应误判
        fs::create_dir(dir.join("subx")).unwrap();
        fs::write(dir.join("subx/c.txt"), "c").unwrap();
        fs_move(s("subx/c.txt"), s("sub/c.txt")).unwrap();
        // 正常移动 + 重命名
        fs_move(s("a.txt"), s("sub/a.txt")).unwrap();
        assert!(!dir.join("a.txt").exists() && dir.join("sub/a.txt").exists());
        fs_move(s("sub/a.txt"), s("sub/a2.txt")).unwrap();
        assert!(dir.join("sub/a2.txt").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn copy_file_and_dir_with_dedup() {
        let dir = tmp_dir("copy");
        fs::write(dir.join("f.txt"), "hello").unwrap();
        fs::create_dir_all(dir.join("d/nested")).unwrap();
        fs::write(dir.join("d/nested/g.txt"), "world").unwrap();
        fs::create_dir(dir.join("out")).unwrap();
        let s = |p: &str| dir.join(p).to_string_lossy().into_owned();

        // 文件复制 + 同目录重名自动改名
        let p1 = fs_copy(s("f.txt"), s("out")).unwrap();
        let p2 = fs_copy(s("f.txt"), s("out")).unwrap();
        assert!(PathBuf::from(&p1).ends_with("f.txt"));
        assert!(PathBuf::from(&p2).ends_with("f (1).txt"));
        assert_eq!(fs::read_to_string(&p2).unwrap(), "hello");
        // 目录递归复制,源不动
        let p3 = fs_copy(s("d"), s("out")).unwrap();
        assert_eq!(fs::read_to_string(PathBuf::from(&p3).join("nested/g.txt")).unwrap(), "world");
        assert!(dir.join("d/nested/g.txt").exists());
        // 目录禁止复制进自身子孙
        assert!(fs_copy(s("d"), s("d/nested")).is_err());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn list_sorts_dirs_first_then_name() {
        let dir = tmp_dir("list");
        fs::write(dir.join("b.txt"), "b").unwrap();
        fs::write(dir.join("A.txt"), "a").unwrap();
        fs::create_dir(dir.join("zdir")).unwrap();
        fs::create_dir(dir.join("adir")).unwrap();

        let entries = fs_list(dir.to_string_lossy().into_owned()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["adir", "zdir", "A.txt", "b.txt"]);
        assert!(entries.iter().all(|e| e.is_dir == entries[0].is_dir || !e.is_dir));
        assert!(entries.iter().all(|e| e.mtime > 0));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn read_rejects_binary_and_oversize() {
        let dir = tmp_dir("read");
        let bin = dir.join("bin.dat");
        let mut blob = vec![b'a'; 100];
        blob.push(0);
        fs::write(&bin, blob).unwrap();
        assert!(fs_read(bin.to_string_lossy().into_owned()).is_err());

        let big = dir.join("big.txt");
        fs::write(&big, vec![b'x'; (MAX_EDIT_BYTES + 1) as usize]).unwrap();
        assert!(fs_read(big.to_string_lossy().into_owned()).is_err());

        let ok = dir.join("ok.txt");
        fs::write(&ok, "你好\n世界").unwrap();
        assert_eq!(fs_read(ok.to_string_lossy().into_owned()).unwrap(), "你好\n世界");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn create_write_delete_roundtrip() {
        let dir = tmp_dir("rw");
        let f = dir.join("new.txt");
        fs_create(f.to_string_lossy().into_owned(), false).unwrap();
        assert!(fs_create(f.to_string_lossy().into_owned(), false).is_err()); // 已存在
        fs_write(f.to_string_lossy().into_owned(), "内容".into()).unwrap();
        assert_eq!(fs_read(f.to_string_lossy().into_owned()).unwrap(), "内容");
        fs_delete(f.to_string_lossy().into_owned()).unwrap();
        assert!(!f.exists());

        let sub = dir.join("ghost").join("sub");
        assert!(fs_create(sub.to_string_lossy().into_owned(), true).is_err()); // 父目录不存在
        let d = dir.join("d");
        fs_create(d.to_string_lossy().into_owned(), true).unwrap();
        fs_write(d.join("a.txt").to_string_lossy().into_owned(), "x".into()).unwrap();
        fs_delete(d.to_string_lossy().into_owned()).unwrap(); // 递归删除
        assert!(!d.exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn empty_path_rejected() {
        assert!(fs_list(String::new()).is_err());
        assert!(fs_read("  ".into()).is_err());
        assert!(fs_write(String::new(), "x".into()).is_err());
        assert!(fs_create(String::new(), false).is_err());
        assert!(fs_delete(String::new()).is_err());
    }

    #[test]
    fn mtime_roundtrip() {
        let dir = tmp_dir("mtime");
        let f = dir.join("m.txt");
        fs::write(&f, "x").unwrap();
        let t = SystemTime::now() - Duration::from_secs(120);
        let open = fs::File::options().write(true).open(&f).unwrap();
        if open
            .set_times(fs::FileTimes::new().set_modified(t))
            .is_ok()
        {
            let e = fs_list(dir.to_string_lossy().into_owned()).unwrap();
            assert_eq!(e[0].mtime, t.duration_since(UNIX_EPOCH).unwrap().as_secs() as i64);
        }
        fs::remove_dir_all(&dir).unwrap();
    }
}
