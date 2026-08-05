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
            // pi 运行时目录：安装版 <resource_dir>/pi；dev 回退 src-tauri/resources/pi
            let resource_pi = app
                .path()
                .resource_dir()
                .map(|d| d.join("pi"))
                .unwrap_or_default();
            let dev_pi = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("pi");
            let pi_dir = if resource_pi.join("pi.exe").exists() {
                resource_pi
            } else {
                dev_pi
            };
            let ai = Arc::new(ai::AiManager::new(
                store.clone(),
                pi_dir,
                config_dir.join("pi-agent"),
                ssh.clone(),
            ));
            app.manage(store);
            app.manage(ssh);
            app.manage(terms);
            app.manage(ai.clone());
            if let Some(win) = app.get_webview_window("main") {
                win.on_window_event(move |_ev| {
                    if let tauri::WindowEvent::Destroyed = _ev {
                        ai.kill_all();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            store::is_config_complete,
            store::get_state,
            store::get_config_dir,
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
            xshell::import_xshell_sessions,
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
            sftp::sftp_home,
            sftp::sftp_list,
            sftp::sftp_upload,
            sftp::sftp_download,
            ai::ai_chat,
            ai::ai_abort,
            ai::ai_kill_project,
            ai::ai_set_thinking,
            ai::set_ai_mode,
            ai::ai_respond_approval,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
