//! AI 助手（pi 子进程 RPC 嵌入）。
//! 契约：命令 `ai_chat(key, prompt)` / `ai_abort(key)` / `ai_kill_project(project_id)`；
//! 事件 `ai:event:<key>` payload `{type:"delta",text}|{type:"done"}|{type:"error",message}`；
//! key = "<projectId>:<sessionId>"，每 key 一个长驻 pi 进程（--no-tools 只对话不改文件不执行命令）。
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

/// `--append-system-prompt` 的值（逐字，见计划步骤 9）。
const SYSTEM_PROMPT: &str = "你是 AIShell 的内置终端助手。用户围绕本地/远程终端工作流提问，消息中可能附带终端快照（形如 [终端快照 命令: <cmd>] 加输出内容）。
输出协议（必须严格遵守）：
1. 建议用户在终端执行的命令：每条命令单独放在一个 ```command 围栏代码块中，块内只有命令本身，不加解释。
2. 给用户直接复用的文本（说明、模板等）：放在 ```text 围栏代码块中。
3. 普通代码示例使用对应语言的围栏代码块。
4. 用中文回复，简洁直接。";

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
        let models = json!({
            "providers": {
                "deepseek": {
                    "baseUrl": cfg.base_url.trim_end_matches('/'),
                    "api": "openai-completions",
                    "apiKey": "$DEEPSEEK_API_KEY",
                    "models": [{
                        "id": model_id,
                        "name": model_id,
                        "reasoning": model_id.to_lowercase().contains("reasoner"),
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
            "--no-tools",
            "--no-session",
            "--no-context-files",
            "--append-system-prompt",
            SYSTEM_PROMPT,
        ])
        .env("PI_CODING_AGENT_DIR", &self.agent_dir)
        .env("DEEPSEEK_API_KEY", &api_key)
        .current_dir(&cwd)
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
                        busy2.store(false, Ordering::SeqCst);
                        if !terminal_emitted {
                            terminal_emitted = true;
                            let _ = app2.emit(&event, json!({"type": "done"}));
                        }
                    }
                    // 生成级错误（如 401 认证失败）：错误在 message.stopReason/errorMessage 上，
                    // 不走 message_update 信封。message_start/message_end/turn_end 任一捕获即可。
                    "turn_start" => {
                        terminal_emitted = false;
                    }
                    "message_start" | "message_end" | "turn_end" => {
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
