pub mod ai;
pub mod ai_actions;
pub mod fsops;
pub mod sftp;
pub mod ssh;
pub mod store;
pub mod term;
pub mod xshell;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 打开 DevTools：浏览器快捷键（含 F12）已被禁用，前端监听 F12 调此命令。
#[tauri::command]
fn open_devtools(win: tauri::WebviewWindow) {
    win.open_devtools();
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
            let store = Arc::new(
                store::Store::new(config_dir.clone())
                    .map_err(std::io::Error::other)?,
            );
            let ssh = Arc::new(ssh::SshManager::new(store.clone()));
            let terms = Arc::new(term::TermManager::new(ssh.clone()));
            // pi 运行时目录：Windows 安装版把 bundle.resources 装到 exe 旁 resources/ 子目录，
            // macOS 装到 AIShell.app/Contents/Resources/resources/ 子目录；resource_dir() 在各
            // 平台都返回其根。依次探测：安装布局 → 扁平布局（兼容）→ dev 源目录
            let resource_dir = app.path().resource_dir().unwrap_or_default();
            let dev_pi = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("pi");
            let candidates = [
                resource_dir.join("resources").join("pi"),
                resource_dir.join("pi"),
                dev_pi.clone(),
            ];
            let pi_dir = candidates
                .iter()
                .find(|p| p.join(ai::PI_BIN_NAME).is_file())
                .cloned()
                .unwrap_or(dev_pi);
            // pi 诊断：候选命中情况 + resource_dir 实际内容（排查安装版「pi 运行时不存在」）
            let pi_debug = {
                let mut s = format!("resource_dir: {}\n", resource_dir.display());
                for c in &candidates {
                    s.push_str(&format!(
                        "候选: {} ({} 存在: {})\n",
                        c.display(),
                        ai::PI_BIN_NAME,
                        c.join(ai::PI_BIN_NAME).is_file()
                    ));
                }
                s.push_str(&format!("选中: {}\n", pi_dir.display()));
                match std::fs::read_dir(&resource_dir) {
                    Ok(rd) => {
                        let names: Vec<String> = rd
                            .flatten()
                            .take(30)
                            .map(|e| e.file_name().to_string_lossy().into_owned())
                            .collect();
                        s.push_str(&format!("resource_dir 内容: {}\n", names.join(", ")));
                    }
                    Err(e) => s.push_str(&format!("resource_dir 读取失败: {e}\n")),
                }
                s
            };
            let ai = Arc::new(ai::AiManager::new(
                store.clone(),
                pi_dir,
                config_dir.join("pi-agent"),
                ssh.clone(),
                pi_debug,
            ));
            app.manage(store);
            app.manage(ssh);
            app.manage(terms);
            app.manage(ai.clone());
            if let Some(win) = app.get_webview_window("main") {
                // 禁用 WebView2 浏览器快捷键（Ctrl+Shift+C 开 DevTools、Ctrl+滚轮缩放、F5 刷新等）：
                // 它们在页面 keydown 之前的 accelerator 阶段被宿主拦截，JS 无法阻止，
                // 会劫持终端的 Ctrl+Shift+C/V。F12 DevTools 改由前端监听 + open_devtools 命令。
                #[cfg(windows)]
                {
                    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
                    use windows::core::Interface;
                    let _ = win.with_webview(|wv| unsafe {
                        if let Ok(core) = wv.controller().CoreWebView2() {
                            if let Ok(settings) = core.Settings() {
                                if let Ok(s3) = settings.cast::<ICoreWebView2Settings3>() {
                                    let _ = s3.SetAreBrowserAcceleratorKeysEnabled(false);
                                }
                            }
                        }
                    });
                }
                win.on_window_event(move |_ev| {
                    if let tauri::WindowEvent::Destroyed = _ev {
                        ai.kill_all();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_devtools,
            store::is_config_complete,
            store::get_state,
            store::save_settings,
            store::set_theme,
            store::upsert_server,
            store::delete_server,
            store::upsert_project,
            store::delete_project,
            store::ensure_project_dirs,
            store::sessions_get,
            store::session_upsert,
            store::set_server_locked,
            store::create_server_folder,
            store::rename_server_folder,
            store::delete_server_folder,
            store::clear_all_servers,
            xshell::import_xshell_sessions,
            xshell::import_xshell_from_dir,
            term::term_create,
            term::term_input,
            term::term_resize,
            term::term_close,
            fsops::fs_list,
            fsops::fs_read,
            fsops::fs_write,
            fsops::fs_create,
            fsops::fs_delete,
            fsops::fs_import,
            fsops::fs_move,
            fsops::fs_copy,
            fsops::fs_reveal,
            fsops::fs_stat,
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_stat,
            sftp::sftp_read,
            sftp::sftp_write,
            sftp::sftp_upload,
            sftp::sftp_download,
            sftp::sftp_rename,
            sftp::sftp_copy,
            sftp::sftp_delete,
            sftp::sftp_unique_name,
            sftp::sftp_create,
            ai::ai_chat,
            ai::ai_abort,
            ai::ai_debug_info,
            ai::ai_kill_project,
            ai::ai_set_thinking,
            ai::set_ai_mode,
            ai::ai_respond_approval,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
