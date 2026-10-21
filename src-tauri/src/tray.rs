//! 系统托盘（设置-功能特性「关闭窗口时最小化到托盘」）。
//!
//! 托盘图标只在开关开启时存在：启动与保存设置后由 [`sync`] 创建/移除（TrayIcon 引用计数，
//! drop 即从系统托盘消失）。主窗口 CloseRequested 由 lib.rs 拦截并 hide（终端/AI 会话继续
//! 在后台运行），前端关闭守卫按 `closeToTray` 与 [`is_active`] 查询拦下 JS 默认 destroy
//! 并跳过 AI 忙确认（见 main.tsx）。
//!
//! 托盘交互：左键单击恢复主窗口，右键菜单「显示主界面 / 退出 AIShell」。
//! 退出不直接 app.exit——先显示主窗口再向前端发 `tray:exit-request`，复用窗口关闭守卫的
//! AI 忙确认与未定稿正文落盘，最后由前端 destroy() 触发 Destroyed 收尾（录制 footer、
//! 隧道禁用、杀 pi 进程），与手动关窗走同一条路径。

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// 托盘图标持有者（TrayIcon drop 即移除图标，必须长期持有一份）。
#[derive(Default)]
pub struct TrayState(Mutex<Option<TrayIcon>>);

/// 按设置同步托盘图标（启动时与 save_settings 保存后调用）。
/// 创建失败（无系统托盘的环境等）只返回错误由调用方记录，不影响保存/启动主流程。
///
/// 注意：不持锁调用 [`build`] / `set_visible` —— 二者内部经 run_on_main_thread 同步调度，
/// 主线程若同时执行 [`is_active`] 会等锁，持锁等待主线程将互相死锁（保存设置与关窗并发时）。
pub fn sync(app: &AppHandle, enabled: bool) -> tauri::Result<()> {
    let state = app.state::<TrayState>();
    let exists = state.0.lock().unwrap_or_else(|p| p.into_inner()).is_some();
    match (enabled, exists) {
        (true, false) => {
            let mut icon = Some(build(app)?);
            {
                let mut guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
                // 构建期间可能已被并发调用创建：多建的那份不装入，锁外丢弃
                if guard.is_none() {
                    *guard = icon.take();
                }
            }
            drop(icon); // TrayIcon drop 也可能经主线程派发，勿持锁
        }
        (false, true) => {
            let removed = state.0.lock().unwrap_or_else(|p| p.into_inner()).take();
            if let Some(icon) = removed {
                // 显式隐藏再 drop，避免个别平台移除时残留一帧
                let _ = icon.set_visible(false);
            }
        }
        _ => {}
    }
    Ok(())
}

/// 托盘图标是否实际存在（创建失败或被移除时为 false）。
/// lib.rs 的关窗守卫必须同时检查它：托盘不可用时把窗口藏起来将无法再恢复。
pub fn is_active(app: &AppHandle) -> bool {
    app.try_state::<TrayState>()
        .map(|state| state.0.lock().unwrap_or_else(|p| p.into_inner()).is_some())
        .unwrap_or(false)
}

fn build(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let show = MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出 AIShell", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    let mut builder = TrayIconBuilder::with_id("aishell-tray")
        .menu(&menu)
        // 左键恢复窗口（默认左键弹菜单）；右键照常弹菜单
        .show_menu_on_left_click(false)
        .tooltip("AIShell")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => request_exit(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)
}

/// 恢复并聚焦主窗口（hide 与最小化两种状态都还原）。
fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// 托盘「退出」：先显示主窗口，再交给前端关闭守卫（AI 忙确认 → 落盘 → destroy）。
fn request_exit(app: &AppHandle) {
    show_main(app);
    let _ = app.emit("tray:exit-request", ());
}
