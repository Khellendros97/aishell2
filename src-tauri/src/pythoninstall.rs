//! Python3 检测与捆绑安装引导（对应 py 工具：AI 执行 Python 脚本的运行时依赖）。
//! 对照 .proto/ 交互规格：无对应条目——本模块是纯本地检测/安装引导，不涉及前后端 IPC；
//! 与后端接口点：lib.rs setup 起后台线程调用 `ensure_on_startup`（仅 Windows），
//! `find_python` 供 ai_actions 的 py 工具运行时解析解释器；诊断日志复用 term::diag。
//!
//! 方案取舍与 gitinstall.rs 一致：「首启检测 + 捆绑安装器」而非打包期预装——
//! 构建期 scripts/fetch-python.mjs 把官方安装器拉进 src-tauri/resources/python/，
//! tauri.conf.json bundle.resources 已含 resources/python，随安装包分发；
//! 首启未检测到 Python3 时弹中文确认框，用户同意后 /quiet 静默 per-user 安装
//! （InstallAllUsers=0 不触发 UAC），装完重新检测并弹结果框。

use std::path::PathBuf;

#[cfg(windows)]
use std::os::windows::process::CommandExt; // creation_flags：探测/安装不闪控制台窗口
#[cfg(windows)]
use std::time::{Duration, Instant};
#[cfg(windows)]
use tauri::{AppHandle, Manager};
#[cfg(windows)]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

/// 探测 Python3 解释器，返回 python.exe/python3 的绝对路径。
/// Windows 顺序：env AISHELL_PYTHON → %LOCALAPPDATA%\Programs\Python\Python3*\（取最高版本）
/// → %PROGRAMFILES%\Python3*\ → where.exe python（排除 WindowsApps 商店占位 stub，
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
            let dir = PathBuf::from(base.trim_end_matches(|c| ['\\', '/'].contains(&c))).join("Python");
            if let Some(p) = latest_in_python_dir(&dir) {
                return Some(p);
            }
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

/* ---------------- Windows 首启安装引导 ---------------- */

/// 安装器文件名模式：python-<version>-amd64.exe（与 scripts/fetch-python.mjs 产物一致）。
#[cfg(windows)]
fn is_installer_name(name: &str) -> bool {
    name.starts_with("python-") && name.ends_with("-amd64.exe")
}

/// 在候选目录中找捆绑安装器（取第一个文件名匹配的普通文件）。
#[cfg(windows)]
fn find_installer(candidates: &[PathBuf]) -> Option<PathBuf> {
    candidates.iter().find_map(|dir| {
        std::fs::read_dir(dir)
            .ok()?
            .flatten()
            .map(|e| (e.file_name().to_string_lossy().into_owned(), e.path()))
            .find(|(name, p)| is_installer_name(name) && p.is_file())
            .map(|(_, p)| p)
    })
}

/// 首启入口：lib.rs setup 起后台线程、延迟调用。已检测到 Python3 或没有捆绑安装器时
/// 静默返回；否则弹中文确认框。
#[cfg(windows)]
pub fn ensure_on_startup(app: &AppHandle) {
    if find_python().is_some() {
        return;
    }
    // 资源探测顺序与 lib.rs 的 pi 运行时一致：安装布局 → 扁平布局（兼容）→ dev 源目录
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("python");
    let candidates = [
        resource_dir.join("resources").join("python"),
        resource_dir.join("python"),
        dev_dir,
    ];
    let Some(installer) = find_installer(&candidates) else {
        let cands: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
        crate::term::diag(&format!(
            "未检测到 Python3，且未找到捆绑安装器（候选：{}），跳过自动安装",
            cands.join("；")
        ));
        return;
    };
    crate::term::diag(&format!(
        "未检测到 Python3，弹出安装确认框（捆绑安装器：{}）",
        installer.display()
    ));

    let app = app.clone();
    app.dialog()
        .message("未检测到 Python3。\n\nAIShell 的 AI 脚本工具（py）依赖 Python3 运行。是否立即静默安装捆绑的官方 Python（仅当前用户，含 pip）？")
        .title("安装 Python3")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("立即安装".into(), "暂不安装".into()))
        .show(move |ok| {
            if ok {
                install_and_monitor(app, installer);
            } else {
                crate::term::diag("用户选择暂不安装 Python3");
            }
        });
}

/// 后台线程：静默运行捆绑安装器 → 轮询重新检测 → 弹结果框（成功/失败都给可执行提示）。
#[cfg(windows)]
fn install_and_monitor(app: AppHandle, installer: PathBuf) {
    std::thread::spawn(move || {
        crate::term::diag(&format!("开始静默安装 Python3：{}", installer.display()));
        // python.org 安装器静默参数：/quiet 无界面；InstallAllUsers=0 仅当前用户（免 UAC）；
        // PrependPath=1 加 PATH；Include_pip=1 装 pip；Include_launcher=1 装 py 启动器。
        // CREATE_NO_WINDOW：避免安装器启动瞬间闪现控制台窗口。
        let run = std::process::Command::new(&installer)
            .args([
                "/quiet",
                "InstallAllUsers=0",
                "PrependPath=1",
                "Include_pip=1",
                "Include_launcher=1",
            ])
            .creation_flags(0x0800_0000)
            .status();
        let exit_code = match run {
            Ok(st) => st.code(),
            Err(e) => {
                crate::term::diag(&format!("无法启动 Python 安装器：{e}"));
                result_dialog(
                    &app,
                    false,
                    &format!("无法启动 Python 安装器：{e}\n请手动安装 Python3（https://www.python.org/downloads/），或设置环境变量 AISHELL_PYTHON 指向 python.exe 后重启 AIShell。"),
                );
                return;
            }
        };
        crate::term::diag(&format!("安装器退出码：{exit_code:?}，重新检测 Python3…"));
        // 安装器进程退出后可能仍有收尾（文件锁释放等），最多再轮询 120 秒
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut py = find_python();
        while py.is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_secs(2));
            py = find_python();
        }
        match py {
            Some(p) => {
                crate::term::diag(&format!("Python3 安装成功：{}", p.display()));
                result_dialog(
                    &app,
                    true,
                    &format!("Python3 安装完成，路径：{}\nAI 脚本工具（py）现在可以正常使用了。", p.display()),
                );
            }
            None => {
                crate::term::diag(&format!(
                    "Python3 安装后仍未检测到（安装器退出码：{exit_code:?}）"
                ));
                result_dialog(
                    &app,
                    false,
                    &format!(
                        "Python3 安装未完成（安装器退出码：{exit_code:?}）。\n请手动安装 Python3（https://www.python.org/downloads/），或设置环境变量 AISHELL_PYTHON 指向 python.exe 后重启 AIShell。"
                    ),
                );
            }
        }
    });
}

/// 结果弹框（可后台线程调用：dialog 插件内部会 run_on_main_thread 切回主线程展示）。
#[cfg(windows)]
fn result_dialog(app: &AppHandle, ok: bool, msg: &str) {
    app.dialog()
        .message(msg.to_string())
        .title(if ok { "安装完成" } else { "安装失败" }.to_string())
        .kind(if ok {
            MessageDialogKind::Info
        } else {
            MessageDialogKind::Error
        })
        .buttons(MessageDialogButtons::OkCustom("知道了".into()))
        .show(|_| {});
}
