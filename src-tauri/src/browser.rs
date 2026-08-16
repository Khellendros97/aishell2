//! 内置浏览器：主窗口内嵌子 webview（WebView2），供侧栏浏览器面板与 AI 浏览器工具共用（共享单实例）。
//! 契约（与 src/api.ts / browser-engine.ts 严格对齐）：
//! - 命令 `browser_ensure` / `browser_set_rect` / `browser_set_visible` / `browser_navigate` /
//!   `browser_back` / `browser_forward` / `browser_reload` / `browser_set_inspect` / `browser_open_devtools`；
//! - 事件 `browser:event` payload `{ kind: 'url'|'title'|'element'|'ai-navigate', ... }`；
//! - AI 动作桥（ai.rs run_internal_action）：browser_open / browser_read / browser_console / browser_screenshot。
//!
//! 页面 → Rust 回传走 WebView2 原生 `window.chrome.webview.postMessage`（WebMessageReceived），
//! 对任意来源（含 file://）可用、不依赖 tauri capability。
//! 子 webview 全局单实例、跨面板切换与跨项目保留；位置由前端 BrowserPanel 的占位 div
//! 经 ResizeObserver 同步（逻辑坐标 —— 主 webview 铺满无边框窗口，与窗口坐标 1:1）。
//! 注意：Windows 上同步命令/事件处理器里创建 webview 会死锁（tauri 已知问题），触碰 webview 的命令一律 async。

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::webview::PageLoadEvent;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, Url, Webview, WebviewBuilder,
    WebviewUrl, Wry,
};
use tokio::sync::{oneshot, watch};

/// 子 webview 标签（区别于主窗口 "main"；不进 capability，页面无 IPC 权限，回传走 WebMessage）。
const BROWSER_LABEL: &str = "browser";
/// console 环形缓冲上限（AI browser_console 每次最多取 200 条）
const CONSOLE_CAP: usize = 500;
/// 截图保留张数上限（<workspace>/.aishell/tmp/screenshot，超出删最旧）
const SCREENSHOT_KEEP: usize = 20;

/// AppHandle 注入点（lib.rs setup 调 set_app；BrowserManager::new 无参，便于测试构造）。
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn set_app(app: AppHandle) {
    let _ = APP.set(app);
}

fn app_handle() -> Option<&'static AppHandle> {
    APP.get()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ---------------- 事件 payload（字段名与 src/api.ts 一一对应） ---------------- */

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEntry {
    pub level: String,
    pub text: String,
    pub ts: u64,
}

/// browser_ensure 返回值：面板重挂时恢复地址栏/标题/检查模式状态。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserState {
    pub url: String,
    pub title: String,
    pub inspect: bool,
}

struct BrowserInner {
    webview: Option<Webview<Wry>>,
    inspect: bool,
    url: String,
    title: String,
    console: VecDeque<ConsoleEntry>,
    /// webview 当前是否对用户可见（面板激活且无遮罩时前端置 true；截图后台渲染据此恢复）
    shown: bool,
    /// 面板占位区域最近一次同步的逻辑矩形 (x, y, w, h)
    rect: (f64, f64, f64, f64),
}

pub struct BrowserManager {
    inner: Mutex<BrowserInner>,
    /// 页面加载完成计数（on_page_load Finished 时 +1；browser_open 用 watch 等待）
    load_tx: watch::Sender<u64>,
}

impl Default for BrowserManager {
    fn default() -> Self {
        Self::new()
    }
}

impl BrowserManager {
    pub fn new() -> Self {
        let (load_tx, _) = watch::channel(0u64);
        Self {
            inner: Mutex::new(BrowserInner {
                webview: None,
                inspect: false,
                url: String::new(),
                title: String::new(),
                console: VecDeque::new(),
                shown: false,
                rect: (0.0, 0.0, 1280.0, 800.0),
            }),
            load_tx,
        }
    }

    fn webview(&self) -> Result<Webview<Wry>, String> {
        self.inner
            .lock()
            .unwrap()
            .webview
            .clone()
            .ok_or_else(|| "浏览器尚未创建".to_string())
    }

    /// 懒创建子 webview（已存在直接返回）。初始离屏 + 隐藏：
    /// 面板挂载后 set_rect 归位；AI 后台使用时离屏渲染（截图不闪屏）。
    pub async fn ensure(self: &Arc<Self>) -> Result<(), String> {
        if self.inner.lock().unwrap().webview.is_some() {
            return Ok(());
        }
        let handle = app_handle().ok_or_else(|| "浏览器未初始化（应用句柄缺失）".to_string())?;
        let win = handle
            .get_window("main")
            .ok_or_else(|| "找不到主窗口".to_string())?;

        let mgr_load = Arc::clone(self);
        let mgr_title = Arc::clone(self);
        let builder = WebviewBuilder::new(
            BROWSER_LABEL,
            WebviewUrl::External(Url::parse("about:blank").map_err(|e| format!("初始地址非法: {e}"))?),
        )
        .initialization_script(INSPECTOR_JS)
        // 保留 WebView2 原生拖放行为（拖入 HTML 文件可直接打开），不走 tauri 的 OLE 拦截
        .disable_drag_drop_handler()
        .on_page_load(move |_wv, payload| {
            let url = payload.url().to_string();
            let finished = matches!(payload.event(), PageLoadEvent::Finished);
            let (inspect, wv) = {
                let mut inner = mgr_load.inner.lock().unwrap();
                inner.url = url.clone();
                if finished {
                    inner.console.clear();
                }
                (inner.inspect, inner.webview.clone())
            };
            if let Some(a) = app_handle() {
                let _ = a.emit("browser:event", json!({ "kind": "url", "url": url }));
            }
            if finished {
                mgr_load.load_tx.send_if_modified(|v| {
                    *v += 1;
                    true
                });
                // 检查模式跨导航保持：新页面重新激活检查器
                if inspect {
                    if let Some(wv) = wv {
                        let _ = wv.eval("window.__aishellInspector && window.__aishellInspector.enable();");
                    }
                }
            }
        })
        .on_document_title_changed(move |_wv, title| {
            mgr_title.inner.lock().unwrap().title = title.clone();
            if let Some(a) = app_handle() {
                let _ = a.emit("browser:event", json!({ "kind": "title", "title": title }));
            }
        });

        let wv = win
            .add_child(builder, LogicalPosition::new(-20000.0, 0.0), LogicalSize::new(1280.0, 800.0))
            .map_err(|e| format!("创建浏览器视图失败: {e}"))?;
        let _ = wv.hide();

        // 页面回传通道：element（检查器选中）/ console（钩子）经 WebMessageReceived 进入
        let mgr_msg = Arc::clone(self);
        let _ = wv.with_webview(move |pw| unsafe {
            use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs;
            use windows::core::PWSTR;
            use windows::Win32::System::Com::CoTaskMemFree;
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            let handler = webview2_com::WebMessageReceivedEventHandler::create(Box::new(
                move |_sender, args: Option<ICoreWebView2WebMessageReceivedEventArgs>| {
                    let Some(args) = args else { return Ok(()) };
                    let mut raw = PWSTR::null();
                    if args.TryGetWebMessageAsString(&mut raw).is_ok() && !raw.is_null() {
                        let msg = raw.to_string().unwrap_or_default();
                        CoTaskMemFree(Some(raw.as_ptr().cast()));
                        handle_page_message(&mgr_msg, &msg);
                    }
                    Ok(())
                },
            ));
            let mut token = 0i64;
            let _ = core.add_WebMessageReceived(&handler, &mut token);
        });

        {
            let mut inner = self.inner.lock().unwrap();
            if inner.webview.is_some() {
                // 并发 ensure 竞态：后建者直接丢弃
                let _ = wv.close();
                return Ok(());
            }
            inner.webview = Some(wv);
        }
        Ok(())
    }

    /// 归一化并导航（用户地址栏 / AI 工具共用核心）；返回归一化 URL。
    fn navigate_str(&self, input: &str) -> Result<String, String> {
        let url = normalize_input(input)?;
        let wv = self.webview()?;
        wv.navigate(url.clone())
            .map_err(|e| format!("导航失败: {e}"))?;
        {
            let mut inner = self.inner.lock().unwrap();
            inner.url = url.to_string();
            inner.console.clear();
        }
        Ok(url.to_string())
    }

    /// AI 动作 browser_open：后台导航（不切面板、不抢焦点），等页面加载完成（≤15s）。
    /// 共享单实例语义：面板正停留在浏览器时 emit ai-navigate，前端 toast 提示页面被替换。
    pub async fn open_for_ai(self: &Arc<Self>, input: &str) -> Result<String, String> {
        self.ensure().await?;
        let url = normalize_input(input)?;
        let before = *self.load_tx.borrow();
        let shown = self.inner.lock().unwrap().shown;
        let wv = self.webview()?;
        wv.navigate(url.clone())
            .map_err(|e| format!("导航失败: {e}"))?;
        {
            let mut inner = self.inner.lock().unwrap();
            inner.url = url.to_string();
            inner.console.clear();
        }
        if let Some(a) = app_handle() {
            let _ = a.emit("browser:event", json!({ "kind": "url", "url": url.as_str() }));
            if shown {
                let _ = a.emit("browser:event", json!({ "kind": "ai-navigate", "url": url.as_str() }));
            }
        }
        // 等待加载完成（watch 计数增长）；超时不报错，返回当前状态并注明
        let mut rx = self.load_tx.subscribe();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        let mut loaded = *rx.borrow_and_update() > before;
        while !loaded {
            if tokio::time::Instant::now() >= deadline {
                break;
            }
            if rx.changed().await.is_err() {
                break;
            }
            loaded = *rx.borrow_and_update() > before;
        }
        let (url_s, title) = {
            let i = self.inner.lock().unwrap();
            (i.url.clone(), i.title.clone())
        };
        Ok(format!(
            "已打开: {url_s}\n页面标题: {title}\n加载状态: {}",
            if loaded { "完成" } else { "等待超时（页面可能仍在加载），可继续读取内容" }
        ))
    }

    /// AI 动作 browser_read：无 selector 读 body innerText（截 10000 字符）；
    /// 给 selector 返回首个匹配元素 outerHTML（截 20000）—— 与 @browser: 元素引用呼应。
    pub async fn read_page(&self, selector: Option<&str>) -> Result<String, String> {
        let wv = self.webview()?;
        let js = match selector {
            Some(sel) if !sel.trim().is_empty() => {
                let sel_lit = serde_json::to_string(sel).unwrap_or_default();
                let not_found = serde_json::to_string(&format!("未找到匹配选择器的元素: {sel}"))
                    .unwrap_or_default();
                format!(
                    r#"(() => {{ try {{ const el = document.querySelector({sel_lit}); if (!el) return {{ error: {not_found} }}; let html = el.outerHTML || ''; if (html.length > 20000) html = html.slice(0, 20000) + '…[截断]'; return {{ url: location.href, title: document.title, name: el.id ? '#' + el.id : (el.tagName || '').toLowerCase(), html }}; }} catch (e) {{ return {{ error: String(e) }}; }} }})()"#
                )
            }
            _ => r#"(() => { try { let text = (document.body && document.body.innerText) || ''; if (text.length > 10000) text = text.slice(0, 10000) + '\n…[截断]'; return { url: location.href, title: document.title, text }; } catch (e) { return { error: String(e) }; } })()"#.to_string(),
        };
        // eval 回调是 Fn（可能多次调用）：Sender 放 Mutex<Option> 内一次性取出发送
        let (tx, rx) = oneshot::channel::<String>();
        let tx = Mutex::new(Some(tx));
        wv.eval_with_callback(js, move |result| {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(result);
            }
        })
        .map_err(|e| format!("读取页面失败: {e}"))?;
        let raw = tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| "读取页面超时".to_string())?
            .map_err(|_| "读取页面失败".to_string())?;
        let v: serde_json::Value =
            serde_json::from_str(&raw).map_err(|e| format!("读取结果解析失败: {e}"))?;
        if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
            return Err(err.to_string());
        }
        let url = v.get("url").and_then(|x| x.as_str()).unwrap_or("");
        let title = v.get("title").and_then(|x| x.as_str()).unwrap_or("");
        if let Some(html) = v.get("html").and_then(|x| x.as_str()) {
            let name = v.get("name").and_then(|x| x.as_str()).unwrap_or("");
            Ok(format!("页面: {title} ({url})\n元素 {name} HTML:\n{html}"))
        } else {
            let text = v.get("text").and_then(|x| x.as_str()).unwrap_or("");
            Ok(format!("页面: {title} ({url})\n正文文本:\n{text}"))
        }
    }

    /// AI 动作 browser_console：最近 limit 条（默认 200）console 日志。
    pub fn console_text(&self, limit: Option<usize>) -> String {
        let inner = self.inner.lock().unwrap();
        let limit = limit.unwrap_or(200).min(inner.console.len());
        let lines: Vec<String> = inner
            .console
            .iter()
            .rev()
            .take(limit)
            .rev()
            .map(|e| format!("[{}] {}", e.level, e.text))
            .collect();
        if lines.is_empty() {
            return "（暂无 console 输出）".to_string();
        }
        format!("最近 {} 条 console 日志:\n{}", lines.len(), lines.join("\n"))
    }

    /// AI 动作 browser_screenshot：CDP Page.captureScreenshot 截图存
    /// `<workspace>/.aishell/tmp/screenshot/<ms>.png`，仅保留最新 20 张，返回文件路径。
    /// 隐藏态先临时显示并移到屏幕外（离屏渲染，用户不可见），截完恢复。
    pub async fn screenshot(self: &Arc<Self>, project_path: &Path) -> Result<String, String> {
        self.ensure().await?;
        let wv = self.webview()?;
        let (was_shown, rect) = {
            let i = self.inner.lock().unwrap();
            (i.shown, i.rect)
        };
        if !was_shown {
            let _ = wv.show();
            let _ = wv.set_position(LogicalPosition::new(-20000.0, 0.0));
            let _ = wv.set_size(LogicalSize::new(rect.2.max(800.0), rect.3.max(600.0)));
            // 等渲染管线出帧后再截图
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        let (tx, rx) = oneshot::channel::<Result<Vec<u8>, String>>();
        let sent = wv.with_webview(move |pw| unsafe {
            use windows::core::PCWSTR;
            let Ok(core) = pw.controller().CoreWebView2() else { return };
            let method = windows::core::HSTRING::from("Page.captureScreenshot");
            let params = windows::core::HSTRING::from(r#"{"format":"png"}"#);
            let handler = webview2_com::CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                move |_err, result_json: String| {
                    let out = (|| {
                        let v: serde_json::Value = serde_json::from_str(&result_json)
                            .map_err(|e| format!("截图结果解析失败: {e}"))?;
                        let data = v.get("data").and_then(|d| d.as_str()).unwrap_or("");
                        if data.is_empty() {
                            return Err("截图返回空数据（页面可能尚未渲染）".to_string());
                        }
                        base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data)
                            .map_err(|e| format!("截图解码失败: {e}"))
                    })();
                    let _ = tx.send(out);
                    Ok(())
                },
            ));
            let _ = core.CallDevToolsProtocolMethod(
                PCWSTR::from_raw(method.as_ptr()),
                PCWSTR::from_raw(params.as_ptr()),
                &handler,
            );
        });
        let outcome = match sent {
            Err(e) => Err(format!("调用截图接口失败: {e}")),
            Ok(()) => match tokio::time::timeout(Duration::from_secs(10), rx).await {
                Ok(Ok(Ok(bytes))) => Ok(bytes),
                Ok(Ok(Err(e))) => Err(e),
                Ok(Err(_)) => Err("截图回调丢失".to_string()),
                Err(_) => Err("截图超时".to_string()),
            },
        };
        if !was_shown {
            let _ = wv.set_position(LogicalPosition::new(rect.0, rect.1));
            let _ = wv.set_size(LogicalSize::new(rect.2, rect.3));
            let _ = wv.hide();
        }
        let bytes = outcome?;
        save_screenshot(project_path, &bytes)
    }
}

/* ---------------- 页面消息（WebMessageReceived）分发 ---------------- */

fn handle_page_message(mgr: &BrowserManager, msg: &str) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(msg) else { return };
    match v.get("kind").and_then(|k| k.as_str()).unwrap_or("") {
        "console" => {
            let entry = ConsoleEntry {
                level: v.get("level").and_then(|x| x.as_str()).unwrap_or("log").to_string(),
                text: v.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                ts: v.get("ts").and_then(|x| x.as_u64()).unwrap_or_else(now_ms),
            };
            let mut inner = mgr.inner.lock().unwrap();
            if inner.console.len() >= CONSOLE_CAP {
                inner.console.pop_front();
            }
            inner.console.push_back(entry);
        }
        "element" => {
            let mut v = v;
            if v.get("ts").and_then(|x| x.as_u64()).is_none() {
                v["ts"] = json!(now_ms());
            }
            if let Some(a) = app_handle() {
                let _ = a.emit("browser:event", v);
            }
        }
        _ => {}
    }
}

/* ---------------- 地址归一化（纯函数，单测覆盖） ---------------- */

/// 地址栏/AI 工具输入归一化：本地路径（盘符 / UNC）→ file:// URL；
/// 含 scheme 原样解析；无 scheme 补 https://。
pub fn normalize_input(input: &str) -> Result<Url, String> {
    let s = input.trim();
    if s.is_empty() {
        return Err("地址不能为空".to_string());
    }
    let bytes = s.as_bytes();
    let drive_path = bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/');
    let unc_path = s.starts_with("\\\\");
    if drive_path || unc_path {
        let p = Path::new(s);
        if !p.exists() {
            return Err(format!("本地路径不存在: {s}"));
        }
        return Url::from_file_path(p).map_err(|_| format!("无法把路径转为文件地址: {s}"));
    }
    if s.contains("://") || s.starts_with("about:") {
        return Url::parse(s).map_err(|_| format!("无法解析地址: {s}"));
    }
    Url::parse(&format!("https://{s}")).map_err(|_| format!("无法解析地址: {s}"))
}

fn save_screenshot(project_path: &Path, bytes: &[u8]) -> Result<String, String> {
    let dir = project_path.join(".aishell").join("tmp").join("screenshot");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建截图目录失败: {e}"))?;
    let path = dir.join(format!("{}.png", now_ms()));
    std::fs::write(&path, bytes).map_err(|e| format!("写入截图失败: {e}"))?;
    // 仅保留最新 SCREENSHOT_KEEP 张（文件名为毫秒时间戳，字典序即时间序）
    let mut names: Vec<String> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("png")))
            .filter_map(|e| e.file_name().into_string().ok())
            .collect(),
        Err(e) => return Err(format!("读取截图目录失败: {e}")),
    };
    names.sort();
    while names.len() > SCREENSHOT_KEEP {
        let oldest = names.remove(0);
        let _ = std::fs::remove_file(dir.join(oldest));
    }
    Ok(format!("截图已保存: {}", path.display()))
}

/* ---------------- 前端命令（一律 async：Windows 同步路径创建/触碰 webview 会死锁） ---------------- */

#[tauri::command]
pub async fn browser_ensure(mgr: State<'_, Arc<BrowserManager>>) -> Result<BrowserState, String> {
    mgr.ensure().await?;
    let i = mgr.inner.lock().unwrap();
    Ok(BrowserState {
        url: i.url.clone(),
        title: i.title.clone(),
        inspect: i.inspect,
    })
}

#[tauri::command]
pub async fn browser_set_rect(
    mgr: State<'_, Arc<BrowserManager>>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let (w, h) = (w.max(1.0), h.max(1.0));
    let wv = mgr.webview()?;
    mgr.inner.lock().unwrap().rect = (x, y, w, h);
    wv.set_position(LogicalPosition::new(x, y))
        .map_err(|e| format!("同步浏览器位置失败: {e}"))?;
    wv.set_size(LogicalSize::new(w, h))
        .map_err(|e| format!("同步浏览器尺寸失败: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn browser_set_visible(
    mgr: State<'_, Arc<BrowserManager>>,
    visible: bool,
) -> Result<(), String> {
    let wv = mgr.webview()?;
    mgr.inner.lock().unwrap().shown = visible;
    let r = if visible { wv.show() } else { wv.hide() };
    r.map_err(|e| format!("切换浏览器显示失败: {e}"))
}

#[tauri::command]
pub async fn browser_navigate(
    mgr: State<'_, Arc<BrowserManager>>,
    input: String,
) -> Result<String, String> {
    mgr.navigate_str(&input)
}

#[tauri::command]
pub async fn browser_back(mgr: State<'_, Arc<BrowserManager>>) -> Result<(), String> {
    mgr.webview()?
        .eval("history.back();")
        .map_err(|e| format!("后退失败: {e}"))
}

#[tauri::command]
pub async fn browser_forward(mgr: State<'_, Arc<BrowserManager>>) -> Result<(), String> {
    mgr.webview()?
        .eval("history.forward();")
        .map_err(|e| format!("前进失败: {e}"))
}

#[tauri::command]
pub async fn browser_reload(mgr: State<'_, Arc<BrowserManager>>) -> Result<(), String> {
    mgr.webview()?
        .reload()
        .map_err(|e| format!("刷新失败: {e}"))
}

#[tauri::command]
pub async fn browser_set_inspect(
    mgr: State<'_, Arc<BrowserManager>>,
    enabled: bool,
) -> Result<(), String> {
    mgr.inner.lock().unwrap().inspect = enabled;
    let js = if enabled {
        "window.__aishellInspector && window.__aishellInspector.enable();"
    } else {
        "window.__aishellInspector && window.__aishellInspector.disable();"
    };
    mgr.webview()?
        .eval(js)
        .map_err(|e| format!("切换检查模式失败: {e}"))
}

#[tauri::command]
pub async fn browser_open_devtools(mgr: State<'_, Arc<BrowserManager>>) -> Result<(), String> {
    let wv = mgr.webview()?;
    wv.open_devtools();
    Ok(())
}

/* ---------------- 注入脚本：console 钩子（常开）+ 检查元素（休眠态，Rust eval 激活） ---------------- */

const INSPECTOR_JS: &str = r##"(function () {
  if (window.__aishellInjected) return;
  window.__aishellInjected = true;

  function post(obj) {
    try {
      if (window.chrome && window.chrome.webview && window.chrome.webview.postMessage) {
        window.chrome.webview.postMessage(JSON.stringify(obj));
      }
    } catch (e) { /* 回传失败静默 */ }
  }

  /* ---------- console 钩子：包装 log/info/warn/error + 全局错误（每秒限 100 条防刷爆） ---------- */
  function fmt(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  var quota = { start: 0, count: 0 };
  function allow() {
    var now = Date.now();
    if (now - quota.start >= 1000) { quota.start = now; quota.count = 0; }
    quota.count += 1;
    return quota.count <= 100;
  }
  ['log', 'info', 'warn', 'error'].forEach(function (level) {
    var orig = console[level] ? console[level].bind(console) : function () {};
    console[level] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) {
        var s = fmt(arguments[i]);
        if (s.length > 2000) s = s.slice(0, 2000) + '…[截断]';
        parts.push(s);
      }
      if (allow()) post({ kind: 'console', level: level, text: parts.join(' '), ts: Date.now() });
      orig.apply(null, arguments);
    };
  });
  window.addEventListener('error', function (e) {
    if (allow()) post({ kind: 'console', level: 'error', text: (e.message || 'Script error') + ' (' + (e.filename || '') + ':' + (e.lineno || 0) + ')', ts: Date.now() });
  });
  window.addEventListener('unhandledrejection', function (e) {
    if (allow()) post({ kind: 'console', level: 'error', text: 'Unhandled rejection: ' + fmt(e.reason), ts: Date.now() });
  });

  /* ---------- 检查元素：默认休眠，__aishellInspector.enable()/disable() 激活 ---------- */
  var overlay = null, label = null, active = false;
  function ensureOverlay() {
    if (overlay) return;
    overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #2563eb;background:rgba(37,99,235,.12);border-radius:2px;box-sizing:border-box;display:none;';
    label = document.createElement('div');
    label.style.cssText = 'position:absolute;left:-2px;top:-24px;white-space:nowrap;font:12px/18px Consolas,monospace;background:#2563eb;color:#fff;padding:0 6px;border-radius:3px;';
    overlay.appendChild(label);
    document.documentElement.appendChild(overlay);
  }
  function describe(el) {
    var r = el.getBoundingClientRect();
    var name = el.tagName ? el.tagName.toLowerCase() : '';
    if (el.id) name += '#' + el.id;
    else if (typeof el.className === 'string' && el.className.trim()) name += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    label.textContent = name + '  ' + Math.round(r.width) + '×' + Math.round(r.height);
    overlay.style.left = r.left + 'px';
    overlay.style.top = r.top + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
    overlay.style.display = 'block';
  }
  function serialize(el) {
    var id = el.id || '';
    var tag = el.tagName ? el.tagName.toLowerCase() : '';
    var name = id ? '#' + id : tag;
    var html = '';
    try { html = el.outerHTML || ''; } catch (err) { html = ''; }
    if (html.length > 20000) html = html.slice(0, 20000) + '…[截断]';
    return { kind: 'element', name: name, tagName: tag, elementId: id, outerHTML: html, url: location.href, title: document.title, ts: Date.now() };
  }
  function onMove(e) {
    if (!(e.target instanceof Element)) return;
    describe(e.target);
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    if (e.target instanceof Element) post(serialize(e.target));
    disable();
  }
  function onKey(e) {
    if (e.key === 'Escape') disable();
  }
  function enable() {
    if (active) return;
    active = true;
    ensureOverlay();
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    overlay.style.display = 'block';
  }
  function disable() {
    if (!active) return;
    active = false;
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    if (overlay) overlay.style.display = 'none';
  }
  window.__aishellInspector = { enable: enable, disable: disable };
})();"##;

/* ---------------- 单测 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_completes_scheme() {
        assert_eq!(
            normalize_input("example.com").unwrap().as_str(),
            "https://example.com/"
        );
        assert_eq!(
            normalize_input("  example.com/path?q=1 ").unwrap().as_str(),
            "https://example.com/path?q=1"
        );
        assert_eq!(
            normalize_input("http://example.com").unwrap().as_str(),
            "http://example.com/"
        );
        assert_eq!(
            normalize_input("about:blank").unwrap().as_str(),
            "about:blank"
        );
    }

    #[test]
    fn normalize_rejects_empty_and_garbage() {
        assert!(normalize_input("   ").is_err());
        assert!(normalize_input("https://###").is_err());
        // 不存在的本地路径给中文报错
        let err = normalize_input("Z:\\definitely\\not\\exist.html").unwrap_err();
        assert!(err.contains("不存在"), "unexpected: {err}");
    }

    #[test]
    fn normalize_local_file_to_file_url() {
        let dir = std::env::temp_dir().join(format!("aishell-browser-test-{}", now_ms()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("page.html");
        std::fs::write(&file, "<html></html>").unwrap();
        let url = normalize_input(file.to_string_lossy().as_ref()).unwrap();
        assert_eq!(url.scheme(), "file");
        assert!(url.path().ends_with("page.html"));
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn screenshot_prune_keeps_latest() {
        let root = std::env::temp_dir().join(format!("aishell-shot-test-{}", now_ms()));
        let dir = root.join(".aishell").join("tmp").join("screenshot");
        std::fs::create_dir_all(&dir).unwrap();
        // 预置 25 张旧截图（递减时间戳命名，字典序即时间序）
        for i in 0..25 {
            std::fs::write(dir.join(format!("100{:03}.png", 24 - i)), b"x").unwrap();
        }
        let text = save_screenshot(&root, b"new-png-bytes").unwrap();
        assert!(text.contains(&format!("{}", dir.display())));
        let names: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("png")))
            .filter_map(|e| e.file_name().into_string().ok())
            .collect();
        assert_eq!(names.len(), SCREENSHOT_KEEP);
        assert!(names.iter().any(|n| n == "100024.png"), "最新的旧截图应保留");
        assert!(!names.iter().any(|n| n == "100000.png"), "最旧的旧截图应被清理");
        let _ = std::fs::remove_dir_all(&root);
    }
}
