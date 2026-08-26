//! Python3 运行时探测（py 工具：AI 执行 Python 脚本的解释器解析）。
//! 对照 .proto/ 交互规格：无对应条目——本模块是纯本地探测，不涉及前后端 IPC；
//! 与后端接口点：`find_python` 供 ai_actions 的 py 工具每次执行前解析解释器。
//!
//! 运行时来源两级：系统安装（官方安装器落地目录 / PATH 实测）→ 捆绑 embeddable
//! 免安装运行时（构建期 scripts/fetch-python.mjs 预解压进 resources/python-embed，
//! 随安装包分发、解压即用；fetch 时已删 python313._pth，PYTHONPATH 注入 pysdk 可用）。
//! 早先的「首启弹框静默装官方安装器」流程已随捆绑方案移除——安装包装完即自带运行时，
//! 不再需要安装引导。

use std::path::PathBuf;

#[cfg(windows)]
use std::os::windows::process::CommandExt; // creation_flags：探测不闪控制台窗口

/// 探测 Python3 解释器，返回 python.exe/python3 的绝对路径。
/// Windows 顺序：env AISHELL_PYTHON → %LOCALAPPDATA%\Programs\Python\Python3*\（取最高版本）
/// → %PROGRAMFILES%\Python3*\ → 捆绑 python-embed（resources/python-embed，免安装兜底，
/// 版本随构建锁定，不做 --version 实测）→ where.exe python（排除 WindowsApps 商店占位 stub，
/// 并执行 --version 实测）。macOS/Linux：env AISHELL_PYTHON → 常见安装路径 → PATH 上的 python3。
/// pub(crate)：ai_actions 的 py 工具每次执行前调用（结果不缓存，保证新装的解释器立即可用）。
#[cfg(windows)]
pub(crate) fn find_python() -> Option<PathBuf> {
    if let Some(p) = std::env::var("AISHELL_PYTHON").ok().map(|s| s.trim().to_string()) {
        if !p.is_empty() && PathBuf::from(&p).is_file() {
            return Some(PathBuf::from(p));
        }
    }
    // 官方安装器的标准落地目录（per-user 与 all-users 两种），按版本号取最高
    for var in ["LOCALAPPDATA", "PROGRAMFILES"] {
        if let Ok(base) = std::env::var(var) {
            let dir = PathBuf::from(base.trim_end_matches(|c: char| ['\\', '/'].contains(&c))).join("Python");
            if let Some(p) = latest_in_python_dir(&dir) {
                return Some(p);
            }
        }
    }
    // 捆绑 embeddable 运行时：系统未装时直接采用（优先于 PATH，避免命中过旧/未验证的
    // PATH 安装）；产物由构建期固定，免 --version 实测
    if let Some(dir) = crate::term::bundled_resource_dir("python-embed") {
        let p = dir.join("python.exe");
        if p.is_file() {
            return Some(p);
        }
    }
    // PATH 兜底：排除商店占位 stub（%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe，
    // 运行只会弹 Microsoft Store），命中后 --version 实测（stub 或坏安装会失败）
    let out = std::process::Command::new("where.exe")
        .arg("python")
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    text.lines()
        .map(str::trim)
        .filter(|line| {
            let lower = line.to_lowercase();
            !line.is_empty() && !lower.contains(r"\microsoft\windowsapps\")
        })
        .map(PathBuf::from)
        .find(|p| verify_python(p))
}

/// macOS/Linux 探测：env AISHELL_PYTHON → 常见绝对路径 → PATH 上的 python3。
#[cfg(not(windows))]
pub(crate) fn find_python() -> Option<PathBuf> {
    if let Some(p) = std::env::var("AISHELL_PYTHON").ok().map(|s| s.trim().to_string()) {
        if !p.is_empty() && PathBuf::from(&p).is_file() {
            return Some(PathBuf::from(p));
        }
    }
    for p in [
        "/usr/bin/python3",
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/bin/python3",
    ] {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    // PATH 兜底
    let out = std::process::Command::new("which").arg("python3").output().ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() {
        None
    } else {
        Some(PathBuf::from(p))
    }
}

/// 在 <base>\Python\ 下找 Python3xx 子目录中版本最高的 python.exe（目录名 Python313 > Python39，
/// 字符串排序对 3 位补丁号不可靠，提取数字段比较）。
#[cfg(windows)]
fn latest_in_python_dir(dir: &std::path::Path) -> Option<PathBuf> {
    let mut best: Option<(u64, PathBuf)> = None;
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let Some(digits) = name.strip_prefix("Python") else {
            continue;
        };
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(ver) = digits.parse::<u64>() else {
            continue;
        };
        let exe = e.path().join("python.exe");
        if exe.is_file() && best.as_ref().is_none_or(|(v, _)| ver > *v) {
            best = Some((ver, exe));
        }
    }
    best.map(|(_, p)| p)
}

/// 实测候选解释器：<path> --version 退出码成功且输出形如 "Python 3.x.y"。
#[cfg(windows)]
fn verify_python(path: &std::path::Path) -> bool {
    let out = std::process::Command::new(path)
        .arg("--version")
        .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
        .output();
    match out {
        Ok(o) => {
            o.status.success() && String::from_utf8_lossy(&o.stdout).trim().starts_with("Python 3.")
        }
        Err(_) => false,
    }
}
