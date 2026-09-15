//! AI 助手分离窗口（label = `ai-detach`）：把 AI 助手面板从宿主窗口（工作台/欢迎页）侧栏
//! 分离成独立 OS 窗口，聚合时还原。窗口加载同一份前端 index.html，由 initialization_script
//! 注入 hash 路由 `#/ai-window?project=<id>&session=<sid>&host=<workbench|welcome>`，
//! 前端 App.tsx 分支渲染 AiWindowPage（自绘迷你标题栏 + 全高 AiPanel）。
//!
//! 与后端的接口点（src/api.ts）：ai_window_open / ai_window_close / ai_any_busy /
//! ai_forward_ref 命令；`ai:window-changed`（分离状态广播，宿主窗口据此显隐 AI 面板）与
//! `ai:forward-ref:<projectId>`（「添加到对话」跨窗口转发，wbHandles.ai 转发桩发出）事件。
//!
//! 关键约束：
//! - Windows 上创建 webview 必须在 async 命令里（同步命令死锁，同 browser.rs 文件头）；
//! - 窗口 label 必须加进 capabilities/default.json 的 windows，否则 listen/窗口控制被 ACL 拒；
//! - 同一时刻只允许一个分离窗口（label 固定），异项目重复分离返回错误提示先聚合；
//! - pi 进程与会话快照是 app 级共享，分离窗口重新订阅同一 ai:event 即无缝续流（见 ai-engine.ts）。

use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WebviewUrl,
    WebviewWindowBuilder,
};

use crate::store::{AiWindowGeometry, Store};

/// 分离窗口固定 label（capabilities/default.json windows 同步放行）。
const AI_WINDOW_LABEL: &str = "ai-detach";

/// `ai:window-changed` 事件载荷（serde camelCase，与 src/types.ts AiWindowChangedEvent 对齐）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AiWindowChanged {
    project_id: String,
    detached: bool,
}

/// 分离窗口运行态（app.manage，不落盘）：当前分离的项目 id + 最近窗口几何缓存
/// （Moved/Resized 高频更新，Destroyed 时才落盘，避免拖拽期间频繁写 aishell.json）。
pub struct AiWindowState {
    project_id: Mutex<Option<String>>,
    geometry: Arc<Mutex<Option<AiWindowGeometry>>>,
}

impl Default for AiWindowState {
    fn default() -> Self {
        Self {
            project_id: Mutex::new(None),
            geometry: Arc::new(Mutex::new(None)),
        }
    }
}

/// 分离窗口加载的 hash 路由（project id / session id 均为 uid 生成，无特殊字符；
/// 注入 script 时再经 serde_json 转义一次兜底）。
fn window_hash(project_id: &str, session_id: Option<&str>, host: &str) -> String {
    let mut hash = format!("#/ai-window?project={project_id}&host={host}");
    if let Some(sid) = session_id {
        if !sid.trim().is_empty() {
            hash.push_str(&format!("&session={sid}"));
        }
    }
    hash
}

/// 窗口矩形（物理像素）是否与任一显示器相交：拔掉显示器/改布局后记住的位置可能完全出屏，
/// 此时放弃恢复改用默认尺寸居中。
fn visible_on_some_monitor(app: &AppHandle, geo: &AiWindowGeometry) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    if monitors.is_empty() {
        return true;
    }
    let (x0, y0) = (geo.x, geo.y);
    let (x1, y1) = (
        geo.x + geo.width as i32,
        geo.y + geo.height as i32,
    );
    monitors.iter().any(|m| {
        let mp = m.position();
        let ms = m.size();
        let (mx0, my0) = (mp.x, mp.y);
        let (mx1, my1) = (mx0 + ms.width as i32, my0 + ms.height as i32);
        x0 < mx1 && mx0 < x1 && y0 < my1 && my0 < y1
    })
}

/// 分离窗口的事件收尾：Moved/Resized 更新几何缓存；Destroyed 落盘几何并广播
/// `ai:window-changed {detached:false}`（宿主窗口据此还原 AI 面板——覆盖 X 关闭、
/// ai_window_close、程序退出等所有窗口消失路径）。
fn register_window_events(
    app: AppHandle,
    win: tauri::WebviewWindow,
    store: Arc<Store>,
    project_id: String,
    geometry: Arc<Mutex<Option<AiWindowGeometry>>>,
) {
    let win_cb = win.clone();
    win.on_window_event(move |ev| match ev {
        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
            if let (Ok(pos), Ok(size)) = (win_cb.outer_position(), win_cb.inner_size()) {
                *geometry.lock().unwrap_or_else(|p| p.into_inner()) =
                    Some(AiWindowGeometry {
                        x: pos.x,
                        y: pos.y,
                        width: size.width,
                        height: size.height,
                    });
            }
        }
        tauri::WindowEvent::Destroyed => {
            if let Some(geo) = *geometry.lock().unwrap_or_else(|p| p.into_inner()) {
                let _ = store.set_ai_window_geometry(geo);
            }
            // 分离窗口可能是最后关闭的窗口（主窗口先关的场景），兜底执行退出收尾
            crate::exit_cleanup_if_last_window(&app, AI_WINDOW_LABEL);
            let _ = app.emit(
                "ai:window-changed",
                AiWindowChanged {
                    project_id: project_id.clone(),
                    detached: false,
                },
            );
        }
        _ => {}
    });
}

/// 分离 AI 助手：为项目打开独立窗口（已有分离窗口时同项目聚焦复用，异项目报错）。
#[tauri::command]
pub async fn ai_window_open(
    app: AppHandle,
    store: State<'_, Arc<Store>>,
    state: State<'_, AiWindowState>,
    project_id: String,
    session_id: Option<String>,
    host: String,
) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(AI_WINDOW_LABEL) {
        let same = state
            .project_id
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .as_deref()
            == Some(project_id.as_str());
        if same {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
            return Ok(());
        }
        return Err("已有分离的 AI 助手窗口，请先在原窗口聚合后再分离其他项目".to_string());
    }

    let saved_geometry = store.ai_window_geometry();
    let init_hash = window_hash(&project_id, session_id.as_deref(), &host);
    // hash 经 JSON 字符串字面量转义后内插进注入 script（JSON 字符串即合法 JS 字符串）
    let hash_literal = serde_json::to_string(&init_hash).unwrap_or_else(|_| "\"\"".to_string());
    let init_script = format!("window.location.hash = {hash_literal};");
    let win = WebviewWindowBuilder::new(&app, AI_WINDOW_LABEL, WebviewUrl::App("index.html".into()))
        .title("AIShell — AI 助手")
        .inner_size(460.0, 720.0)
        .min_inner_size(360.0, 480.0)
        .decorations(false)
        .visible(false)
        .center()
        // 与主窗口一致：wry 的 OS DropTarget 会截杀页面内 HTML5 拖拽（图片拖入输入框）
        .disable_drag_drop_handler()
        .initialization_script(init_script)
        .build()
        .map_err(|e| format!("创建 AI 助手窗口失败: {e}"))?;

    // 记住的几何（物理像素）仍在任一显示器上才恢复，否则保持居中默认尺寸
    if let Some(geo) = saved_geometry
        .filter(|g| g.width > 0 && g.height > 0 && visible_on_some_monitor(&app, g))
    {
        let _ = win.set_size(PhysicalSize::new(geo.width, geo.height));
        let _ = win.set_position(PhysicalPosition::new(geo.x, geo.y));
    }

    *state.project_id.lock().unwrap_or_else(|p| p.into_inner()) = Some(project_id.clone());
    *state.geometry.lock().unwrap_or_else(|p| p.into_inner()) = None;

    crate::disable_webview2_browser_keys(&win);
    register_window_events(
        app.clone(),
        win.clone(),
        store.inner().clone(),
        project_id.clone(),
        state.geometry.clone(),
    );

    let _ = win.show();
    let _ = win.set_focus();
    let _ = app.emit(
        "ai:window-changed",
        AiWindowChanged {
            project_id,
            detached: true,
        },
    );
    Ok(())
}

/// 聚合还原：优雅关闭分离窗口。close 触发分离窗口 JS closeRequested（直接放行，任务由
/// 宿主窗口的常驻上下文无缝接续），destroy 后 Destroyed 事件广播 ai:window-changed
/// {detached:false}，宿主据此重挂侧栏 AI 面板。
#[tauri::command]
pub async fn ai_window_close(app: AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(AI_WINDOW_LABEL) {
        win.close().map_err(|e| format!("关闭 AI 助手窗口失败: {e}"))?;
    }
    Ok(())
}

/// 是否有任一 pi 进程忙（生成/审批等待）。主窗口关闭守卫的跨窗口兜底：双端订阅下
/// 主窗口前端常驻上下文已覆盖分离窗口的忙态（anyAiBusy），本命令以进程表为准再查一道。
#[tauri::command]
pub async fn ai_any_busy(ai: State<'_, Arc<crate::ai::AiManager>>) -> Result<bool, String> {
    Ok(ai.any_busy())
}

/// 「添加到对话」跨窗口转发（wbHandles.ai 转发桩 → 分离窗口 AiHandle 实现）。
#[tauri::command]
pub async fn ai_forward_ref(
    app: AppHandle,
    project_id: String,
    payload: serde_json::Value,
) -> Result<(), String> {
    app.emit(&format!("ai:forward-ref:{project_id}"), payload)
        .map_err(|e| format!("转发引用失败: {e}"))
}
