pub mod ai;
pub mod ai_actions;
pub mod ai_images;
pub mod ai_impact;
pub mod browser;
pub mod cloud;
pub mod cloud_sync;
pub mod dws;
pub mod fsops;
pub mod mcp;
pub mod notes;
pub mod redact;
pub mod session_title;
pub mod pythoninstall;
pub mod pysdk;
pub mod sftp;
pub mod skills;
pub mod smart_approval;
pub mod ssh;
pub mod staging;
pub mod store;
pub mod term;
pub mod update;
pub mod trace;
pub mod xshell;

use std::path::PathBuf;
use std::sync::Arc;
use tauri::Emitter;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// 打开 DevTools：浏览器快捷键（含 F12）已被禁用，前端监听 F12 调此命令。
#[tauri::command]
fn open_devtools(win: tauri::WebviewWindow) {
    win.open_devtools();
}

/// 删除项目前先回收该项目全部 pi，避免项目记录清除后遗留后台进程。
#[tauri::command(rename = "delete_project")]
async fn delete_project_with_ai(
    ai: tauri::State<'_, Arc<ai::AiManager>>,
    store: tauri::State<'_, Arc<store::Store>>,
    id: String,
) -> Result<(), String> {
    ai.kill_project(&id);
    store::delete_project(store, id).await
}

pub fn run() {
    tauri::Builder::default()
        // 内置浏览器自行接管 target=_blank / window.open；全局注入会让远程子 webview
        // 误调 opener IPC 并被 ACL 拒绝。显式 openUrl 命令仍由插件提供。
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        // 客户端自动更新（update.rs）：公钥经插件初始化注入（endpoints 运行期按
        // AISHELL_SERVER_URL 拼接，不落在静态配置里）；JS 侧不走插件命令，无需 capability
        .plugin(
            tauri_plugin_updater::Builder::new()
                .pubkey(update::UPDATER_PUBKEY)
                .build(),
        )
        // 内置浏览器本地 HTML 协议（browser.rs serve_local_html）：
        // 本地文件统一走 localhtml://，规避 file:// 空 host 触发的 wry ipc 处理器崩溃
        .register_uri_scheme_protocol("localhtml", |_ctx, request| {
            browser::serve_local_html(request)
        })
        .setup(|app| {
            let config_dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
            let store =
                Arc::new(store::Store::new(config_dir.clone()).map_err(std::io::Error::other)?);
            let ssh = Arc::new(ssh::SshManager::new(store.clone()));
            // 会话级远程文件暂存（自动备份）：config_dir/remote-staging
            let staging = Arc::new(staging::RemoteStaging::new(
                config_dir.join("remote-staging"),
                Arc::clone(&ssh),
                Arc::clone(&store),
            ));
            // 递归暂存目录的进度事件（staging.rs add_path 逐文件 emit，前端右下角进度弹窗消费）
            {
                let app2 = app.handle().clone();
                staging.set_progress_emitter(Arc::new(move |p| {
                    let _ = app2.emit("staging:progress", p);
                }));
            }
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
let cloud_mgr = Arc::new(cloud::CloudManager::default());
            // 内置浏览器（主窗口内嵌多子 webview，按页面懒创建）：先注入 AppHandle（事件发射/建视图用），
            // AiActions 的 browser_* 动作桥与前端 browser_* 命令共用同一管理器（多页面共享）
            browser::set_app(app.handle().clone());
            let browser = Arc::new(browser::BrowserManager::new());
            let ai = Arc::new(ai::AiManager::new(
                store.clone(),
                pi_dir,
                config_dir.join("pi-agent"),
                ssh.clone(),
                staging.clone(),
                browser.clone(),
                pi_debug,
                Some(cloud_mgr.clone()),
            ));
            {
                let app2 = app.handle().clone();
                ai.set_config_changed_emitter(Arc::new(move |event| {
                    let _ = app2.emit("config:changed", event);
                }));
            }
            // MCP 服务端：按已启用设备自动监听 127.0.0.1:<port>/mcp（见 mcp.rs）
            let mcp = Arc::new(mcp::McpService::new(
                store.clone(),
                ssh.clone(),
                staging.clone(),
            ));
            // AI 会话 trace：注入日志目录与持久化开关初值（需在 manage(store) 移动前读取）
            trace::init(config_dir.join("ai-trace"), store.trace_enabled());
            app.manage(store);
            app.manage(ssh);
            app.manage(terms);
            app.manage(ai.clone());
            app.manage(staging);
            // 云服务 OAuth2 会话（登录 state + 令牌内存缓存；令牌权威存储在 keyring）
            app.manage(cloud_mgr);
            // 启动异步刷新：已登录则重拉 me（用户资料/能力清单），服务端配置变更无需重登
            let cloud_mgr = app.state::<Arc<cloud::CloudManager>>().inner().clone();
            let store2 = app.state::<Arc<store::Store>>().inner().clone();
            // 用户数据云同步与文件备份：密码/vaultKey/凭据明文只存在于 Rust 端；
            // 后台 worker 负责 dirty 防抖与 5 分钟周期兜底。
            if let Ok(sync_manager) = cloud_sync::manager::CloudSyncManager::new(
                app.handle().clone(),
                store2.clone(),
                cloud_mgr.clone(),
            ) {
                let backup_manager = cloud_sync::backup::BackupManager::new(sync_manager.clone());
                cloud_sync::manager::CloudSyncManager::start_background(sync_manager.clone());
                app.manage(sync_manager);
                app.manage(backup_manager);
            }
            let app2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                cloud::refresh_on_startup(&app2, &store2, &cloud_mgr).await;
            });
            app.manage(mcp.clone());
            app.manage(browser);
            // 启动时按持久化配置同步监听（有已启用设备则自动拉起）
            tauri::async_runtime::spawn(async move {
                mcp.sync().await;
            });
            term::set_debug_app(app.handle().clone());
            // 客户端自动更新状态机（update.rs）：命令 + 事件 + 延迟后台检查（未注入
            // AISHELL_SERVER_URL 的个人构建内部自动禁用）
            let updater = Arc::new(update::UpdateManager::new(
                app.handle().clone(),
                config_dir.clone(),
            ));
            app.manage(updater.clone());
            update::start_background(app.handle().clone());
            // AI 会话 trace：启动 7 天过期清理任务（启动即清一次 + 每 24h）
            trace::spawn_cleanup_task();
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
            store::get_task_project,
            store::save_settings,
            store::set_theme,
            store::upsert_server,
            store::upsert_credential,
            store::delete_credential,
            store::clear_unreferenced_credentials,
            store::delete_server,
            store::upsert_project,
            delete_project_with_ai,
            store::ensure_project_dirs,
            store::sessions_get,
            store::session_upsert,
            store::set_server_locked,
            store::save_db_connection,
            store::delete_db_connection,
            mcp::mcp_set_device,
            mcp::mcp_set_port,
            mcp::mcp_status,
            mcp::mcp_ensure_token,
            mcp::mcp_reset_token,
            store::create_project_folder,
            store::rename_project_folder,
            store::delete_project_folder,
            store::delete_folder_with_projects,
            store::create_command_folder,
            store::rename_command_folder,
            store::delete_command_folder,
            store::set_ui_expanded,
            store::set_sftp_history,
            store::set_sftp_favorites,
            store::clear_unreferenced_servers,
            xshell::import_xshell_sessions,
            xshell::import_xshell_from_dir,
            term::term_create,
            term::term_input,
            term::term_resize,
            term::term_close,
            term::term_record_start,
            term::term_record_stop,
            term::debug_export,
            fsops::fs_list,
            fsops::fs_is_text,
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
            ssh::ssh_exec,
            skills::skills_list,
            skills::skill_read,
            skills::skill_save,
            skills::skill_delete,
            skills::skill_set_enabled,
            skills::skill_pack_upload,
            cloud::skillhub_list,
            cloud::skillhub_detail,
            cloud::skillhub_version_detail,
            cloud::skillhub_download,
            ai::ai_chat,
            ai::ai_abort,
            ai::ai_debug_info,
            ai::ai_kill_project,
            ai::ai_set_thinking,
            ai_images::ai_attach_images,
            ai_images::ai_read_image,
            ai::set_ai_mode,
            ai::ai_respond_approval,
            cloud::cloud_begin_login,
            cloud::cloud_cancel_login,
            cloud::cloud_logout,
            cloud::cloud_status,
            cloud::cloud_set_mode,
            cloud::cloud_usage,
            cloud::memories_list,
            cloud::memory_create,
            cloud::memory_update,
            cloud::memory_delete,
            cloud::memory_history,
            cloud::memory_search,
            cloud::memory_promote,
            cloud::kb_search,
            cloud::feedback_submit,
            cloud::feedback_list,
            cloud::feedback_detail,
            cloud::feedback_download_attachment,
            cloud_sync::cloud_sync_status,
            cloud_sync::cloud_sync_initialize,
            cloud_sync::cloud_sync_unlock,
            cloud_sync::cloud_sync_lock,
            cloud_sync::cloud_sync_now,
            cloud_sync::cloud_sync_resolve_conflict,
            cloud_sync::cloud_sync_change_password,
            cloud_sync::cloud_sync_delete_all,
            cloud_sync::cloud_sync_devices,
            cloud_sync::cloud_sync_rename_device,
            cloud_sync::cloud_sync_revoke_device,
            cloud_sync::cloud_sync_reregister_device,
            cloud_sync::cloud_backups_list,
            cloud_sync::cloud_backup_start,
            cloud_sync::cloud_backup_cancel,
            cloud_sync::cloud_backup_resume,
            cloud_sync::cloud_backup_interrupted,
            cloud_sync::cloud_backup_abandon,
            cloud_sync::cloud_backup_restore,
            cloud_sync::cloud_backup_delete,
            ai::ai_respond_db_request,
            ai::ai_respond_ask,
            ai::ai_respond_confirm,
            session_title::ai_generate_session_title,
            notes::notes_root_cmd,
            notes::notes_list_cmd,
            notes::session_archive,
            notes::session_note,
            dws::dws_auth_status,
            dws::dws_report_templates,
            dws::dws_report_generate,
            dws::dws_report_submit,
            trace::trace_status,
            trace::trace_set_enabled,
            trace::trace_read,
            trace::trace_export,
            trace::trace_clear,
            staging::staging_add,
            staging::staging_list,
            staging::staging_snapshot_read,
            staging::staging_current_read,
            staging::staging_accept,
            staging::staging_restore,
            staging::staging_diff,
            staging::staging_clear,
            staging::staging_export,
            browser::browser_ensure,
            browser::browser_set_rect,
            browser::browser_set_visible,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_set_inspect,
            browser::browser_open_devtools,
            browser::browser_close_view,
            browser::browser_publish_skillhub,
            browser::browser_history_add,
            browser::browser_history_list,
            update::update_status,
            update::update_check,
            update::update_download,
            update::update_install,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
