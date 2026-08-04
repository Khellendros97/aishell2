//! AI 助手（pi 子进程 RPC 嵌入）。
//! 契约：命令 `ai_chat(key, prompt)` / `ai_abort(key)` / `ai_kill_project(project_id)`；
//! 事件 `ai:event:<key>` payload `{type:"delta",text}|{type:"tool",tool,label}|{type:"segment"}|{type:"done"}|{type:"error",message}`；
//! key = "<projectId>:<sessionId>"，每 key 一个长驻 pi 进程。
//! 工具边界：read/grep/find/ls/write/edit/web_search 白名单（无 bash），由 pi_ext/aishell-guard.ts
//! 门控——写仅限项目 .aishell/ 目录，读仅限项目目录内；web_search 为只读联网搜索（Brave，
//! 见 pi_ext/aishell-search.ts）；扩展每次 spawn 重写进 agent_dir。
//!
//! 与计划唯一偏差：`procs` 字段为 `Arc<Mutex<HashMap<...>>>`（计划给的是裸 `Mutex`）——
//! 因为 stdout 读取线程必须在进程退出/管道破裂时「从 map 摘除」条目，裸 Mutex 无法被线程共享。
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::json;
use tauri::{AppHandle, Emitter, State};

use crate::store::Store;

/// `--append-system-prompt` 的值。
const SYSTEM_PROMPT: &str = "你是 AIShell 的内置终端助手。用户围绕本地/远程终端工作流提问，消息中可能附带终端快照（形如 [终端快照 命令: <cmd>] 加输出内容）。
文件工具边界（硬性，越界调用会被门控拒绝）：
- read/grep/find/ls：只能读当前项目目录内的文件，项目外一律不可读。
- write/edit：只能写项目下 .aishell/ 目录内的文件（可用于保存笔记、记忆、计划；父目录不存在会自动创建）。
- 没有 bash 工具，不能执行任何命令。
- web_search：联网搜索（Brave Search）。涉及最新新闻、文档、报错信息、版本/依赖变化等时效性问题时使用；结果带来源链接，回复中引用关键来源。
- 用户要求修改项目源码等 .aishell/ 之外的文件时：不要调用 write/edit（会被拒），改为给出命令或补丁文本让用户自行处理。
输出协议（必须严格遵守）：
1. 建议用户在终端执行的命令：每条命令单独放在一个 ```command 围栏代码块中，块内只有命令本身，不加解释。
2. 给用户直接复用的文本（说明、模板等）：放在 ```text 围栏代码块中。
3. 普通代码示例使用对应语言的围栏代码块。
4. 用中文回复，简洁直接。";

/// 门控扩展源码（spawn 时重写进 agent_dir，与 models.json 同模式）。
const GUARD_EXT: &str = include_str!("pi_ext/aishell-guard.ts");

/// 联网搜索扩展源码（web_search 工具，Brave Search；spawn 时重写进 agent_dir）。
const SEARCH_EXT: &str = include_str!("pi_ext/aishell-search.ts");

/// 默认工具白名单；settings.search.enabled 时追加 web_search。
const BASE_TOOLS: &str = "read,grep,find,ls,write,edit";

/// 单个 key 的 pi 进程。
pub struct AiProc {
    child: Child,
    stdin: ChildStdin,
    busy: Arc<AtomicBool>,
    killed: Arc<AtomicBool>,
}

/// AI 进程管理器：每 key 一个长驻 pi 进程，进程生命周随工作台（ai_kill_project / Drop）结束。
pub struct AiManager {
    pub store: Arc<Store>,
    pub pi_dir: PathBuf,
    pub agent_dir: PathBuf,
    pub procs: Arc<Mutex<HashMap<String, AiProc>>>,
}

impl AiManager {
    pub fn new(store: Arc<Store>, pi_dir: PathBuf, agent_dir: PathBuf) -> Self {
        AiManager {
            store,
            pi_dir,
            agent_dir,
            procs: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// 重写 <agent_dir>/models.json（每次 spawn 都重写，内容与 settings 同步）。
    fn write_models_json(&self) -> Result<(), String> {
        let cfg = self.store.llm_config();
        let model_id = &cfg.model_id;
        // v4 系列与 reasoner 支持思考档位；deepseek-chat 等旧模型不支持（pi 会强制 thinking off）
        let reasoning = {
            let id = model_id.to_lowercase();
            id.contains("reasoner") || id.contains("v4")
        };
        let models = json!({
            "providers": {
                "deepseek": {
                    "baseUrl": cfg.base_url.trim_end_matches('/'),
                    "api": "openai-completions",
                    "apiKey": "$DEEPSEEK_API_KEY",
                    "models": [{
                        "id": model_id,
                        "name": model_id,
                        "reasoning": reasoning,
                        "contextWindow": 64000,
                    }],
                }
            }
        });
        std::fs::create_dir_all(&self.agent_dir)
            .map_err(|e| format!("创建 pi 配置目录失败: {e}"))?;
        let text = serde_json::to_string_pretty(&models).map_err(|e| e.to_string())?;
        std::fs::write(self.agent_dir.join("models.json"), text)
            .map_err(|e| format!("写入 models.json 失败: {e}"))?;
        Ok(())
    }

    /// 为 key 拉起 pi 进程并启动 stdout 读取线程（读线程负责 done/error 事件与异常退出摘除）。
    fn spawn(&self, app: &AppHandle, key: &str, project_id: &str) -> Result<(), String> {
        let pi_exe = self.pi_dir.join("pi.exe");
        if !pi_exe.is_file() {
            return Err("pi 运行时不存在，请先执行 scripts/fetch-pi.sh".to_string());
        }
        self.write_models_json()?;
        let api_key = self
            .store
            .read_secret("llm:apikey")
            .map_err(|_| "请先在设置中配置 DeepSeek API Key".to_string())?;
        let cfg = self.store.llm_config();
        let effort = serde_json::to_string(&cfg.effort)
            .map_err(|e| format!("effort 序列化失败: {e}"))?
            .trim_matches('"')
            .to_string();
        let cwd = self
            .store
            .project_path(project_id)
            .unwrap_or_else(|| self.agent_dir.to_string_lossy().into_owned());
        // 门控扩展落盘（每次 spawn 重写，内容与仓库内源码同步）
        std::fs::create_dir_all(&self.agent_dir).map_err(|e| format!("创建 pi 配置目录失败: {e}"))?;
        let guard_path = self.agent_dir.join("aishell-guard.ts");
        std::fs::write(&guard_path, GUARD_EXT).map_err(|e| format!("写入门控扩展失败: {e}"))?;
        // 联网搜索扩展落盘（enabled 开关决定是否挂载，与 key 是否配置无关）
        let search_path = self.agent_dir.join("aishell-search.ts");
        std::fs::write(&search_path, SEARCH_EXT).map_err(|e| format!("写入搜索扩展失败: {e}"))?;
        let search_enabled = self.store.settings().search.enabled;
        // 搜索 key 未配置时不注入 env：工具仍挂载，调用时由扩展返回中文引导错误
        let brave_key = self.store.read_secret("brave:apikey").ok();

        let mut cmd = Command::new(&pi_exe);
        cmd.args([
            "--mode",
            "rpc",
            "--provider",
            "deepseek",
            "--model",
            cfg.model_id.as_str(),
            "--thinking",
            &effort,
            "--tools",
        ])
        .arg(if search_enabled {
            format!("{BASE_TOOLS},web_search")
        } else {
            BASE_TOOLS.to_string()
        })
        .args(["--no-extensions", "--extension"])
        .arg(&guard_path)
        .args(["--extension"])
        .arg(&search_path)
        .args([
            "--no-approve",
            "--no-session",
            "--no-context-files",
            "--append-system-prompt",
            SYSTEM_PROMPT,
        ])
        .env("PI_CODING_AGENT_DIR", &self.agent_dir)
        .env("DEEPSEEK_API_KEY", &api_key);
        if let Some(key) = brave_key {
            cmd.env("BRAVE_API_KEY", key);
        }
        cmd.current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("启动 pi 进程失败: {e}"))?;
        let stdin = child.stdin.take().ok_or_else(|| "pi 进程 stdin 不可用".to_string())?;
        let stdout = child.stdout.take().ok_or_else(|| "pi 进程 stdout 不可用".to_string())?;

        let busy = Arc::new(AtomicBool::new(false));
        let killed = Arc::new(AtomicBool::new(false));
        let app2 = app.clone();
        let key2 = key.to_string();
        let event = format!("ai:event:{key2}");
        let busy2 = busy.clone();
        let killed2 = killed.clone();
        let procs2 = self.procs.clone();
        thread::spawn(move || {
            // 是否已收到过终止性事件（done/error）：正常收尾后退出不再报「异常退出」
            let mut settled = false;
            // 本轮生成是否已发过终态事件（done 或 error 只发一次；turn_start 重置）
            let mut terminal_emitted = false;
            // 当前 assistant 消息是否已流过文本增量（工具来回多段消息时分段用）
            let mut text_started = false;
            let reader = BufReader::new(stdout);
            // LF 是 pi RPC 协议唯一分隔符；BufRead::lines 按 \n 切行（并剥离 \r），勿换 U+2028 类切行器
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Ok(ev) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let Some(ty) = ev.get("type").and_then(serde_json::Value::as_str) else {
                    continue;
                };
                match ty {
                    "message_update" => {
                        let Some(ae) = ev.get("assistantMessageEvent") else { continue };
                        match ae.get("type").and_then(serde_json::Value::as_str) {
                            // 文本增量
                            Some("text_delta") => {
                                if let Some(delta) = ae.get("delta").and_then(serde_json::Value::as_str) {
                                    text_started = true;
                                    let _ = app2.emit(&event, json!({"type": "delta", "text": delta}));
                                }
                            }
                            // 生成出错（type=error 也在 message_update 信封里）
                            Some("error") => {
                                if terminal_emitted {
                                    continue;
                                }
                                terminal_emitted = true;
                                settled = true;
                                busy2.store(false, Ordering::SeqCst);
                                let msg = ae
                                    .get("message")
                                    .and_then(serde_json::Value::as_str)
                                    .or_else(|| ae.get("error").and_then(serde_json::Value::as_str))
                                    .unwrap_or("AI 回复出错");
                                let _ = app2.emit(&event, json!({"type": "error", "message": msg}));
                            }
                            // thinking_delta / toolcall_* 等丢弃
                            _ => {}
                        }
                    }
                    "agent_settled" => {
                        settled = true;
                        text_started = false;
                        busy2.store(false, Ordering::SeqCst);
                        if !terminal_emitted {
                            terminal_emitted = true;
                            let _ = app2.emit(&event, json!({"type": "done"}));
                        }
                    }
                    // 工具活动透传：前端在流式气泡里显示一行小字（只进瞬时 Pending，不落盘）
                    "tool_execution_start" => {
                        let tool = ev.get("toolName").and_then(serde_json::Value::as_str).unwrap_or("");
                        let label = ev
                            .get("args")
                            .and_then(|a| {
                                a.get("path")
                                    .or_else(|| a.get("pattern"))
                                    .or_else(|| a.get("command"))
                                    .or_else(|| a.get("query"))
                            })
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("");
                        let _ = app2.emit(&event, json!({"type": "tool", "tool": tool, "label": label}));
                    }
                    "turn_start" => {
                        terminal_emitted = false;
                    }
                    "message_start" => {
                        // 新 assistant 消息且上一条已流过文本：通知前端分段（工具来回时避免文本粘连）
                        let role = ev
                            .get("message")
                            .and_then(|m| m.get("role"))
                            .and_then(serde_json::Value::as_str);
                        if role == Some("assistant") && text_started {
                            text_started = false;
                            let _ = app2.emit(&event, json!({"type": "segment"}));
                        }
                        if terminal_emitted {
                            continue;
                        }
                        let msg = ev.get("message");
                        let stop = msg
                            .and_then(|m| m.get("stopReason"))
                            .and_then(serde_json::Value::as_str);
                        if stop == Some("error") {
                            terminal_emitted = true;
                            settled = true;
                            busy2.store(false, Ordering::SeqCst);
                            let emsg = msg
                                .and_then(|m| m.get("errorMessage"))
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("AI 回复出错");
                            let _ = app2.emit(&event, json!({"type": "error", "message": emsg}));
                        }
                    }
                    // 生成级错误（如 401 认证失败）：错误在 message.stopReason/errorMessage 上，
                    // 不走 message_update 信封。message_start/message_end/turn_end 任一捕获即可。
                    "message_end" | "turn_end" => {
                        if terminal_emitted {
                            continue;
                        }
                        let msg = ev.get("message");
                        let stop = msg
                            .and_then(|m| m.get("stopReason"))
                            .and_then(serde_json::Value::as_str);
                        if stop == Some("error") {
                            terminal_emitted = true;
                            settled = true;
                            busy2.store(false, Ordering::SeqCst);
                            let emsg = msg
                                .and_then(|m| m.get("errorMessage"))
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("AI 回复出错");
                            let _ = app2.emit(&event, json!({"type": "error", "message": emsg}));
                        }
                    }
                    "response" => {
                        if ev.get("success").and_then(serde_json::Value::as_bool) == Some(false)
                            && !terminal_emitted
                        {
                            terminal_emitted = true;
                            settled = true;
                            busy2.store(false, Ordering::SeqCst);
                            let _ = app2.emit(&event, json!({"type": "error", "message": err_message(&ev)}));
                        }
                    }
                    _ => {
                        // 兜底：非 message_update 信封里携带 assistantMessageEvent.error 的事件
                        if terminal_emitted {
                            continue;
                        }
                        if let Some(ae) = ev.get("assistantMessageEvent") {
                            if ae.get("type").and_then(serde_json::Value::as_str) == Some("error") {
                                terminal_emitted = true;
                                settled = true;
                                busy2.store(false, Ordering::SeqCst);
                                let msg = ae
                                    .get("message")
                                    .and_then(serde_json::Value::as_str)
                                    .or_else(|| ae.get("error").and_then(serde_json::Value::as_str))
                                    .unwrap_or("AI 回复出错");
                                let _ = app2.emit(&event, json!({"type": "error", "message": msg}));
                            }
                        }
                    }
                }
            }
            // stdout 关闭：进程退出或管道破裂
            busy2.store(false, Ordering::SeqCst);
            if !settled && !killed2.load(Ordering::SeqCst) {
                let _ = app2.emit(&event, json!({"type": "error", "message": "pi 进程异常退出"}));
            }
            procs2
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .remove(&key2);
        });

        self.procs
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(key.to_string(), AiProc { child, stdin, busy, killed });
        Ok(())
    }

    /// 杀掉 key 以 `<projectId>:` 开头的全部进程并摘除。
    pub fn kill_project(&self, project_id: &str) {
        let prefix = format!("{project_id}:");
        self.kill_keys(|k| k.starts_with(&prefix));
    }

    /// 杀掉全部子进程（应用退出时调用；Drop 也会兜底）。
    pub fn kill_all(&self) {
        self.kill_keys(|_| true);
    }

    fn kill_keys(&self, select: impl Fn(&str) -> bool) {
        let mut procs = self.procs.lock().unwrap_or_else(|p| p.into_inner());
        let dead: Vec<String> = procs.keys().filter(|k| select(k)).cloned().collect();
        for key in dead {
            if let Some(mut proc) = procs.remove(&key) {
                proc.killed.store(true, Ordering::SeqCst);
                let _ = proc.child.kill();
                let _ = proc.child.wait();
            }
        }
    }
}

impl Drop for AiManager {
    fn drop(&mut self) {
        self.kill_all();
    }
}

/// 提取 `response` 事件里 error 字段原文。
fn err_message(ev: &serde_json::Value) -> String {
    match ev.get("error") {
        Some(v) => v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()),
        None => "未知错误".to_string(),
    }
}

/// 发送一条 prompt：进程不存在则先 spawn；上一轮未完成（busy）先写 abort 再发。
#[tauri::command]
pub async fn ai_chat(mgr: State<'_, Arc<AiManager>>, app: AppHandle, key: String, prompt: String) -> Result<(), String> {
    let project_id = key
        .split_once(':')
        .map(|(p, _)| p.to_string())
        .ok_or_else(|| "key 格式错误，应为 <projectId>:<sessionId>".to_string())?;

    let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
    // 旧进程已死但读取线程尚未摘除时，先清理再重起
    if let Some(p) = procs.get_mut(&key) {
        if let Ok(Some(_)) = p.child.try_wait() {
            procs.remove(&key);
        }
    }
    if !procs.contains_key(&key) {
        drop(procs);
        mgr.spawn(&app, &key, &project_id)?;
        procs = mgr.procs.lock().map_err(|e| e.to_string())?;
    }
    let Some(proc) = procs.get_mut(&key) else {
        return Err("pi 进程未就绪".to_string());
    };
    if proc.busy.swap(true, Ordering::SeqCst) {
        proc.stdin
            .write_all(b"{\"type\":\"abort\"}\n")
            .map_err(|e| format!("pi 进程已退出: {e}"))?;
    }
    // 用 JSON 序列化生成，勿手拼
    let mut buf = serde_json::to_vec(&json!({"type": "prompt", "message": prompt}))
        .map_err(|e| e.to_string())?;
    buf.push(b'\n');
    proc.stdin.write_all(&buf).map_err(|e| format!("pi 进程已退出: {e}"))?;
    Ok(())
}

/// 中止当前生成（进程不存在时静默成功）。
#[tauri::command]
pub async fn ai_abort(mgr: State<'_, Arc<AiManager>>, key: String) -> Result<(), String> {
    let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
    if let Some(proc) = procs.get_mut(&key) {
        proc.stdin
            .write_all(b"{\"type\":\"abort\"}\n")
            .map_err(|e| format!("pi 进程已退出: {e}"))?;
    }
    Ok(())
}

/// 工作台卸载/切换项目时调用：杀掉该项目全部 pi 进程。
#[tauri::command]
pub async fn ai_kill_project(mgr: State<'_, Arc<AiManager>>, project_id: String) -> Result<(), String> {
    mgr.kill_project(&project_id);
    Ok(())
}

/// 动态切换项目内全部 pi 进程的思考强度（RPC set_thinking_level，立即生效且不打断当前生成、
/// 不丢对话上下文）；无存活进程时静默成功，下次 spawn 时按 settings 里的新档位启动。
#[tauri::command]
pub async fn ai_set_thinking(
    mgr: State<'_, Arc<AiManager>>,
    project_id: String,
    level: String,
) -> Result<(), String> {
    if !matches!(level.as_str(), "low" | "high" | "max") {
        return Err(format!("未知思考强度档位: {level}"));
    }
    let msg = serde_json::to_vec(&json!({"type": "set_thinking_level", "level": level}))
        .map_err(|e| format!("set_thinking_level 序列化失败: {e}"))?;
    let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
    let prefix = format!("{project_id}:");
    for (key, proc) in procs.iter_mut() {
        if key.starts_with(&prefix) {
            let mut buf = msg.clone();
            buf.push(b'\n');
            // 写失败（进程已死）忽略，读取线程会自行摘除
            let _ = proc.stdin.write_all(&buf);
        }
    }
    Ok(())
}
