//! 系统通知（Windows toast）：AI 审批/ask/confirm/任务完成与耗时操作完成提醒。
//! 无 .proto 对照，全新功能；前端出口在 src/shared/notify.ts（开关/焦点过滤在前端做）。
//!
//! 直接用 tauri-winrt-notification 发 WinRT toast 而非 tauri-plugin-notification，三个原因：
//! 1. 插件 JS 端 sendNotification 走 WebView2 的 Web Notification API，重复通知会被吞（实测只弹第一条）；
//! 2. 插件 Rust 命令不接管 on_activated，点击通知无法聚焦窗口；
//! 3. 未注册 AUMID 时 notify-rust 缺省回退 PowerShell 的 app_id（图标/名称显示为 PowerShell）。
//!    本模块 app_id 用应用 identifier，并用 icons/icon.png（bundle.resources，dev 回退源码树）
//!    做 appLogoOverride 覆盖图标位。

use std::path::PathBuf;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_winrt_notification::{IconCrop, Toast};

/// 发送一条系统通知（前端 shared/notify.ts 调用）。
/// 点击 toast 聚焦主窗口（取消最小化 + 置前）；失败返回中文错误（前端静默降级）。
#[tauri::command]
pub async fn system_notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    let app_id = app.config().identifier.clone();
    let icon = logo_path(&app);
    let mut toast = Toast::new(&app_id)
        .title(&title)
        .text1(&body)
        .on_activated({
            let app = app.clone();
            move |_: Option<String>| {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.unminimize();
                    let _ = win.set_focus();
                }
                Ok(())
            }
        });
    if let Some(icon) = icon {
        toast = toast.icon(&icon, IconCrop::Circular, "AIShell");
    }
    toast.show().map_err(|e| format!("发送系统通知失败: {e}"))
}

/// toast 左侧 logo（icons/icon.png）：打包版取 bundle.resources 落地资源，
/// dev 回退源码树（exe 位于 src-tauri/target/debug）；都找不到则不覆盖（保持系统默认图标）。
fn logo_path(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(p) = app.path().resolve("icons/icon.png", BaseDirectory::Resource) {
        if p.is_file() {
            return Some(p);
        }
    }
    let dev = std::env::current_exe()
        .ok()?
        .parent()?
        .join("../../icons/icon.png");
    if dev.is_file() {
        Some(dev)
    } else {
        None
    }
}
