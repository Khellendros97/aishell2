//! Git Bash 检测与捆绑安装引导（Windows 首启流程，对应 docs/待优化内容260807.md 第 1 项）。
//! 对照 .proto/ 交互规格：无对应条目——本模块是纯本地安装引导，不涉及前后端 IPC；
//! 与后端接口点：lib.rs setup 起后台线程调用 `ensure_on_startup`，诊断日志复用 term::diag。
//!
//! 方案取舍（本模块选「首启检测 + 捆绑安装器」而非打包期预装）：
//! - 构建期 scripts/fetch-git.sh 把官方 64 位安装器拉进 src-tauri/resources/git/，
//!   tauri.conf.json bundle.resources 已含 resources/git，随安装包分发；
//! - 首启检测复用 term::find_shell（优先 %PROGRAMFILES%\Git\bin\bash.exe，
//!   并排除 System32 的 WSL bash）；未找到时弹中文确认框，用户同意后
//!   /VERYSILENT /NORESTART /SP- 静默运行捆绑安装器（Inno Setup 参数），
//!   装完重新检测并弹结果框；全程日志进 debug 面板（term::diag，即「debug:log」事件流）。
//! - 备选「打包期用 NSIS/WiX 自定义动作预装 Git」需要安装器提权到机器级、维护自定义
//!   bootstrapper，WiX 资源路径与权限问题风险高，故不采用。本方案仅在用户同意后触发
//!   一次 UAC 提权（Git for Windows 默认装到 Program Files），失败时给出可执行的中文提示。

use std::os::windows::process::CommandExt; // creation_flags：安装器启动不闪控制台窗口
use std::path::PathBuf;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::term;

/// 安装器文件名模式：Git-<version>-64-bit.exe（与 scripts/fetch-git.mjs 产物一致）。
fn is_installer_name(name: &str) -> bool {
    name.starts_with("Git-") && name.ends_with("-64-bit.exe")
}

/// 在候选目录中找捆绑安装器（取第一个文件名匹配 Git-*-64-bit.exe 的普通文件）。
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

/// 首启入口：lib.rs setup 起后台线程、延迟调用（等主事件循环跑起来、窗口显示后再弹框）。
/// 已检测到 Git Bash 或没有捆绑安装器时静默返回；否则弹中文确认框。
pub fn ensure_on_startup(app: &AppHandle) {
    if term::find_shell().is_some() {
        return;
    }
    // 资源探测顺序与 lib.rs 的 pi 运行时一致：安装布局 → 扁平布局（兼容）→ dev 源目录
    let resource_dir = app.path().resource_dir().unwrap_or_default();
    let dev_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("git");
    let candidates = [
        resource_dir.join("resources").join("git"),
        resource_dir.join("git"),
        dev_dir,
    ];
    let Some(installer) = find_installer(&candidates) else {
        let cands: Vec<String> = candidates.iter().map(|p| p.display().to_string()).collect();
        term::diag(&format!(
            "未检测到 Git Bash，且未找到捆绑安装器（候选：{}），跳过自动安装",
            cands.join("；")
        ));
        return;
    };
    term::diag(&format!(
        "未检测到 Git Bash，弹出安装确认框（捆绑安装器：{}）",
        installer.display()
    ));

    let app = app.clone();
    app.dialog()
        .message("未检测到 Git Bash（C:\\Program Files\\Git\\bin\\bash.exe）。\n\nAIShell 的本地终端依赖 Git Bash 运行。是否立即静默安装捆绑的 Git for Windows？")
        .title("安装 Git Bash")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("立即安装".into(), "暂不安装".into()))
        .show(move |ok| {
            if ok {
                install_and_monitor(app, installer);
            } else {
                term::diag("用户选择暂不安装 Git Bash");
            }
        });
}

/// 后台线程：静默运行捆绑安装器 → 轮询重新检测 → 弹结果框（成功/失败都给可执行提示）。
fn install_and_monitor(app: AppHandle, installer: PathBuf) {
    std::thread::spawn(move || {
        term::diag(&format!("开始静默安装 Git：{}", installer.display()));
        // Inno Setup 静默参数：/VERYSILENT 无界面、/NORESTART 不重启、/SP- 跳过
        // "This will install..." 确认页；机器级安装可能触发一次 UAC 提权。
        // CREATE_NO_WINDOW：避免安装器启动瞬间闪现控制台窗口。
        let run = std::process::Command::new(&installer)
            .args(["/VERYSILENT", "/NORESTART", "/SP-"])
            .creation_flags(0x0800_0000)
            .status();
        let exit_code = match run {
            Ok(st) => st.code(),
            Err(e) => {
                term::diag(&format!("无法启动 Git 安装器：{e}"));
                result_dialog(
                    &app,
                    false,
                    &format!("无法启动 Git 安装器：{e}\n请手动安装 Git for Windows（https://git-scm.com/download/win），或设置环境变量 AISHELL_GIT_BASH 指向 bash.exe 后重启 AIShell。"),
                );
                return;
            }
        };
        term::diag(&format!("安装器退出码：{exit_code:?}，重新检测 Git Bash…"));
        // 安装器进程退出后可能仍有收尾（文件锁释放等），最多再轮询 90 秒
        let deadline = Instant::now() + Duration::from_secs(90);
        let mut shell = term::find_shell();
        while shell.is_none() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_secs(2));
            shell = term::find_shell();
        }
        match shell {
            Some(p) => {
                term::diag(&format!("Git Bash 安装成功：{p}"));
                result_dialog(
                    &app,
                    true,
                    &format!("Git Bash 安装完成，路径：{p}\n本地终端现在可以正常使用了。"),
                );
            }
            None => {
                term::diag(&format!(
                    "Git Bash 安装后仍未检测到（安装器退出码：{exit_code:?}）"
                ));
                result_dialog(
                    &app,
                    false,
                    &format!(
                        "Git Bash 安装未完成（安装器退出码：{exit_code:?}）。\n请手动安装 Git for Windows（https://git-scm.com/download/win），或设置环境变量 AISHELL_GIT_BASH 指向 bash.exe 后重启 AIShell。"
                    ),
                );
            }
        }
    });
}

/// 结果弹框（可后台线程调用：dialog 插件内部会 run_on_main_thread 切回主线程展示）。
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
