//! pi sidecar 黑盒集成测试（pi v0.83.0 RPC + 本地 mock OpenAI 流式服务，不访问真实 LLM / keyring）。
//!
//! 验证 aishell-guard.ts 三模式权限边界（计划验证项 3）：
//! - suggest：越界写（含 `../`）被拒且项目外文件不变，.aishell/ 内放行，全程无审批请求；
//! - agent：受控工具逐调用产生 `extension_ui_request(method=confirm)`，拒绝无副作用，批准才落盘；
//! - yolo：不发 confirm 自动执行；`../` 越界仍拒绝；delete_path 在扩展内执行（无动作桥请求）；
//! - `/aishell-mode` 热切换：非法值保持原模式，合法值立即生效（后续工具调用按新模式审批）。
//!
//! mock 服务行为：请求末条消息 role=tool → 回最终文本；否则按脚本队列依次下发工具调用。
//! 测试目录用系统临时目录，测试结束清理；pi.exe 缺失时跳过（先跑 scripts/fetch-pi.sh）。

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

const GUARD_EXT: &str = include_str!("../src/pi_ext/aishell-guard.ts");
const PI_EXE: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/resources/pi/pi.exe");
const TURN_TIMEOUT: Duration = Duration::from_secs(45);

// ---------------------------------------------------------------- 事件队列

#[derive(Default)]
struct EventQueue {
    inner: Mutex<VecDeque<Value>>,
    cv: Condvar,
    /// 全量归档（超时诊断用）
    archive: Mutex<Vec<Value>>,
}

impl EventQueue {
    fn push(&self, v: Value) {
        self.archive.lock().unwrap().push(v.clone());
        self.inner.lock().unwrap().push_back(v);
        self.cv.notify_all();
    }

    fn next(&self, timeout: Duration) -> Option<Value> {
        let mut guard = self.inner.lock().unwrap();
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(v) = guard.pop_front() {
                return Some(v);
            }
            let now = Instant::now();
            if now >= deadline {
                return None;
            }
            let (g, _) = self.cv.wait_timeout(guard, deadline - now).unwrap();
            guard = g;
        }
    }

    /// 按序消费事件，返回第一个满足谓词的事件（不匹配的丢弃）。
    fn wait_event(&self, timeout: Duration, pred: impl Fn(&Value) -> bool) -> Option<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return None;
            }
            let ev = self.next(remaining)?;
            if pred(&ev) {
                return Some(ev);
            }
        }
    }
}

// ---------------------------------------------------------------- mock OpenAI 服务

/// 工具调用脚本（每条 = JSON `{"name":...,"arguments":...}` 或 "final"），按请求顺序消费。
#[derive(Default)]
struct MockState {
    script: Mutex<VecDeque<String>>,
    /// 收到的 role=tool 消息内容（断言越界拒绝错误用）
    tool_messages: Mutex<Vec<String>>,
    requests: AtomicUsize,
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

fn sse(data: &str) -> String {
    format!("data: {data}\n\n")
}

/// 流式最终文本响应（单块 content + stop）。
fn final_payload_streaming() -> String {
    let mut s = String::new();
    s.push_str(&sse(
        &json!({
            "id": "chatcmpl-final", "object": "chat.completion.chunk", "created": now_ts(),
            "model": "test-model",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": "完成"}, "finish_reason": null}],
        })
        .to_string(),
    ));
    s.push_str(&sse(
        &json!({
            "id": "chatcmpl-final", "object": "chat.completion.chunk", "created": now_ts(),
            "model": "test-model",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
        })
        .to_string(),
    ));
    s.push_str("data: [DONE]\n\n");
    s
}

/// 流式工具调用响应（arguments 单块下发，保证增量 JSON 合法）。
fn toolcall_payload_streaming(spec: &str) -> String {
    let v: Value = serde_json::from_str(spec).expect("脚本工具调用必须是 JSON");
    let name = v["name"].as_str().unwrap_or("write");
    let arguments = v["arguments"].as_str().unwrap_or("{}");
    let mut s = String::new();
    s.push_str(&sse(
        &json!({
            "id": "chatcmpl-tool", "object": "chat.completion.chunk", "created": now_ts(),
            "model": "test-model",
            "choices": [{"index": 0, "delta": {"role": "assistant", "content": null}, "finish_reason": null}],
        })
        .to_string(),
    ));
    s.push_str(&sse(
        &json!({
            "id": "chatcmpl-tool", "object": "chat.completion.chunk", "created": now_ts(),
            "model": "test-model",
            "choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 0, "id": "call_1", "type": "function", "function": {"name": name, "arguments": ""}}
            ]}, "finish_reason": null}],
        })
        .to_string(),
    ));
    s.push_str(&sse(
        &json!({
            "id": "chatcmpl-tool", "object": "chat.completion.chunk", "created": now_ts(),
            "model": "test-model",
            "choices": [{"index": 0, "delta": {"tool_calls": [
                {"index": 0, "function": {"arguments": arguments}}
            ]}, "finish_reason": null}],
        })
        .to_string(),
    ));
    s.push_str(&sse(
        &json!({
            "id": "chatcmpl-tool", "object": "chat.completion.chunk", "created": now_ts(),
            "model": "test-model",
            "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}],
        })
        .to_string(),
    ));
    s.push_str("data: [DONE]\n\n");
    s
}

/// 非流式回退（pi 若不带 stream 参数也能工作）。
fn final_payload_json() -> String {
    json!({
        "id": "chatcmpl-final", "object": "chat.completion", "created": now_ts(), "model": "test-model",
        "choices": [{"index": 0, "message": {"role": "assistant", "content": "完成"}, "finish_reason": "stop"}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
    })
    .to_string()
}

async fn handle_conn(mut stream: TcpStream, state: Arc<MockState>) -> std::io::Result<()> {
    eprintln!("[mock] connection accepted");
    // 读请求头 + body（Content-Length）
    let mut head = Vec::new();
    let mut tmp = [0u8; 1024];
    while !head.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut tmp).await?;
        if n == 0 {
            return Ok(());
        }
        head.extend_from_slice(&tmp[..n]);
        if let Some(pos) = find_subslice(&head, b"\r\n\r\n") {
            let header_text = String::from_utf8_lossy(&head[..pos]);
            let content_length: Option<usize> = header_text
                .lines()
                .find_map(|l| {
                    let lower = l.to_lowercase();
                    lower.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().ok())
                })
                .flatten();
            let body_start = pos + 4;
            let mut body = head[body_start..].to_vec();
            if let Some(len) = content_length {
                while body.len() < len {
                    let n = stream.read(&mut tmp).await?;
                    if n == 0 {
                        break;
                    }
                    body.extend_from_slice(&tmp[..n]);
                }
            }
            let body = String::from_utf8_lossy(&body).into_owned();
            state.requests.fetch_add(1, Ordering::SeqCst);
            eprintln!("[mock] request #{} len={}", state.requests.load(Ordering::SeqCst), body.len());

            let req: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({}));
            let tools: Vec<String> = req["tools"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t["function"]["name"].as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            eprintln!("[mock] request tools={tools:?}");
            let messages = req["messages"].as_array().cloned().unwrap_or_default();
            let last_role = messages.last().and_then(|m| m["role"].as_str()).unwrap_or("");
            // 记录 role=tool 的消息内容（工具执行/拒绝结果，供断言）
            for m in &messages {
                if m["role"] == "tool" {
                    state
                        .tool_messages
                        .lock()
                        .unwrap()
                        .push(m["content"].as_str().unwrap_or("").to_string());
                }
            }
            let streaming = req["stream"].as_bool().unwrap_or(false);

            let (content_type, payload) = if last_role == "tool" {
                // 工具结果已回传：本轮收尾（最终文本）
                (
                    "text/event-stream",
                    if streaming {
                        final_payload_streaming()
                    } else {
                        final_payload_json()
                    },
                )
            } else {
                // 新一轮：按脚本下发工具调用（脚本耗尽则直接收尾）
                let spec = state.script.lock().unwrap().pop_front();
                match spec {
                    Some(s) if s != "final" => {
                        let p = toolcall_payload_streaming(&s);
                        ("text/event-stream", p)
                    }
                    _ => (
                        "text/event-stream",
                        if streaming {
                            final_payload_streaming()
                        } else {
                            final_payload_json()
                        },
                    ),
                }
            };
            // 统一按 SSE 返回（pi 的 openai-completions 以 stream 方式解析）
            let _ = content_type;
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                payload.len()
            );
            eprintln!("[mock] respond last_role={last_role} payload_len={}", payload.len());
            stream.write_all(header.as_bytes()).await?;
            stream.write_all(payload.as_bytes()).await?;
            stream.flush().await?;
            return Ok(());
        }
    }
    Ok(())
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

// ---------------------------------------------------------------- pi 进程句柄

struct Pi {
    child: Child,
    stdin: ChildStdin,
    queue: Arc<EventQueue>,
    confirm_count: Arc<AtomicUsize>,
    action_count: Arc<AtomicUsize>,
}

impl Pi {
    fn spawn(project_dir: &Path, agent_dir: &Path, mock_url: &str, mode: &str) -> Option<Pi> {
        if !Path::new(PI_EXE).is_file() {
            eprintln!("跳过：pi.exe 不存在（{}），先运行 scripts/fetch-pi.sh", PI_EXE);
            return None;
        }
        std::fs::create_dir_all(agent_dir).ok()?;
        // models.json：走本地 mock 服务（api=openai-completions）
        let models = json!({
            "providers": {
                "mock": {
                    "baseUrl": mock_url,
                    "api": "openai-completions",
                    "apiKey": "$DEEPSEEK_API_KEY",
                    "models": [{
                        "id": "test-model",
                        "name": "test-model",
                        "reasoning": false,
                        "contextWindow": 64000,
                    }],
                }
            }
        });
        std::fs::write(agent_dir.join("models.json"), serde_json::to_string_pretty(&models).unwrap()).ok()?;
        std::fs::write(agent_dir.join("aishell-guard.ts"), GUARD_EXT).ok()?;
        eprintln!(
            "[pi] spawn mode={mode} cwd={} agent={} mock={}",
            project_dir.display(),
            agent_dir.display(),
            mock_url
        );

        let mut cmd = Command::new(PI_EXE);
        // 初始工具集按模式下发（与 ai.rs spawn 同语义；热切换由 /aishell-mode 命令增量同步）
        let tools = if mode == "suggest" {
            "read,write,edit,ls,find,grep".to_string()
        } else {
            "read,write,edit,ls,find,grep,delete_path,run_command,sftp_upload,sftp_download,list_servers".to_string()
        };
        cmd.args([
            "--mode", "rpc",
            "--provider", "mock",
            "--model", "test-model",
            "--thinking", "off",
            "--tools", &tools,
            "--no-extensions",
            "--extension",
        ])
        .arg(agent_dir.join("aishell-guard.ts"))
        .args(["--no-approve", "--no-session", "--no-context-files"])
        .env("PI_CODING_AGENT_DIR", agent_dir)
        .env("DEEPSEEK_API_KEY", "test-key")
        .env("AISHELL_AI_MODE", mode)
        .current_dir(project_dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        let mut child = cmd.spawn().expect("启动 pi 失败");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        // stderr 透出（仅诊断；正常路径为空）
        if let Some(stderr) = child.stderr.take() {
            std::thread::spawn(move || {
                let reader = BufReader::new(stderr);
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    eprintln!("[pi-stderr] {line}");
                }
            });
        }
        let queue = Arc::new(EventQueue::default());
        let confirm_count = Arc::new(AtomicUsize::new(0));
        let action_count = Arc::new(AtomicUsize::new(0));
        let q2 = Arc::clone(&queue);
        let c2 = Arc::clone(&confirm_count);
        let a2 = Arc::clone(&action_count);
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                let Ok(ev) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                // 统计审批 / 内部动作请求（即使测试不消费对应事件也要计数）
                if ev["type"] == "extension_ui_request" {
                    let method = ev["method"].as_str().unwrap_or("");
                    let title = ev["title"].as_str().unwrap_or("");
                    if method == "confirm" && title.starts_with("AISHELL_APPROVAL:") {
                        c2.fetch_add(1, Ordering::SeqCst);
                    } else if method == "input" && title.starts_with("AISHELL_ACTION:") {
                        a2.fetch_add(1, Ordering::SeqCst);
                    }
                }
                q2.push(ev);
            }
        });
        Some(Pi { child, stdin, queue, confirm_count, action_count })
    }

    fn write(&mut self, v: &Value) {
        let mut buf = serde_json::to_vec(v).unwrap();
        buf.push(b'\n');
        self.stdin.write_all(&buf).unwrap();
        self.stdin.flush().unwrap();
    }

    fn prompt(&mut self, text: &str) {
        self.write(&json!({"type": "prompt", "message": text}));
    }

    fn respond_confirm(&mut self, request_id: &str, confirmed: bool) {
        self.write(&json!({
            "type": "extension_ui_response",
            "id": request_id,
            "confirmed": confirmed,
        }));
    }

    fn wait_event(&self, pred: impl Fn(&Value) -> bool) -> Value {
        self.queue.wait_event(TURN_TIMEOUT, pred).unwrap_or_else(|| {
            let archive = self.queue.archive.lock().unwrap();
            let types: Vec<String> = archive.iter().map(|v| {
                let t = v["type"].as_str().unwrap_or("?");
                if t == "extension_ui_request" {
                    format!("{t}:{}:{}", v["method"].as_str().unwrap_or(""), v["title"].as_str().unwrap_or(""))
                } else {
                    t.to_string()
                }
            }).collect();
            panic!("等待 pi 事件超时（{TURN_TIMEOUT:?}）。已收事件：\n{}", types.join("\n"));
        })
    }

    fn wait_settled(&self) {
        self.wait_event(|ev| ev["type"] == "agent_settled");
    }

    fn wait_confirm_request(&self) -> Value {
        self.wait_event(|ev| {
            ev["type"] == "extension_ui_request"
                && ev["method"].as_str() == Some("confirm")
                && ev["title"].as_str().unwrap_or("").starts_with("AISHELL_APPROVAL:")
        })
    }

    fn confirm_count(&self) -> usize {
        self.confirm_count.load(Ordering::SeqCst)
    }

    fn action_count(&self) -> usize {
        self.action_count.load(Ordering::SeqCst)
    }
}

impl Drop for Pi {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

// ---------------------------------------------------------------- 测试骨架

struct Env {
    mock_state: Arc<MockState>,
    project_dir: PathBuf,
    _agent_dir: PathBuf,
}

/// 起 mock 服务 + pi 进程（suggest/agent/yolo 模式）。
async fn setup(mode: &str, script: &[&str]) -> (Env, Option<Pi>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.expect("绑定 mock 端口失败");
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(MockState::default());
    *state.script.lock().unwrap() = script.iter().map(|s| s.to_string()).collect();
    let st = Arc::clone(&state);
    tokio::spawn(async move {
        eprintln!("[mock] accepting on {}", addr);
        loop {
            match listener.accept().await {
                Ok((stream, _)) => {
                    let st = Arc::clone(&st);
                    tokio::spawn(async move {
                        let _ = handle_conn(stream, st).await;
                    });
                }
                Err(e) => {
                    eprintln!("[mock] accept error: {e}");
                    break;
                }
            }
        }
    });

    // 全局序号：并发测试（同毫秒/纳秒）也绝不共用临时目录（models.json 端口会互相覆盖）
    static SEQ: AtomicUsize = AtomicUsize::new(0);
    let base = std::env::temp_dir().join(format!(
        "aishell-pi-guard-{}-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),
        SEQ.fetch_add(1, Ordering::SeqCst),
    ));
    let project_dir = base.join("proj");
    let agent_dir = base.join("agent");
    std::fs::create_dir_all(project_dir.join(".aishell")).unwrap();
    std::fs::create_dir_all(&agent_dir).unwrap();

    let pi = Pi::spawn(&project_dir, &agent_dir, &format!("http://127.0.0.1:{}", addr.port()), mode);
    let env = Env { mock_state: state, project_dir, _agent_dir: agent_dir };
    (env, pi)
}

/// 断言 mock 收到的工具结果里包含指定错误文案。
fn assert_tool_error(env: &Env, needle: &str) {
    let msgs = env.mock_state.tool_messages.lock().unwrap();
    assert!(
        msgs.iter().any(|m| m.contains(needle)),
        "工具结果应包含 {needle:?}，实际：{msgs:?}"
    );
}

const WRITE_OUTSIDE: &str = r#"{"name":"write","arguments":"{\"path\":\"../outside.txt\",\"content\":\"pwned\"}"}"#;
const LIST_SERVERS: &str = r#"{"name":"list_servers","arguments":"{}"}"#;
const WRITE_AISHELL_NOTE: &str = r#"{"name":"write","arguments":"{\"path\":\".aishell/note.md\",\"content\":\"hi\"}"}"#;
const WRITE_PROJECT_TXT: &str = r#"{"name":"write","arguments":"{\"path\":\"project.txt\",\"content\":\"w\"}"}"#;
const WRITE_BLOCKED_TXT: &str = r#"{"name":"write","arguments":"{\"path\":\"blocked.txt\",\"content\":\"x\"}"}"#;
const WRITE_ALLOWED_TXT: &str = r#"{"name":"write","arguments":"{\"path\":\"allowed.txt\",\"content\":\"y\"}"}"#;
const WRITE_AUTO_TXT: &str = r#"{"name":"write","arguments":"{\"path\":\"auto.txt\",\"content\":\"z\"}"}"#;
const WRITE_SECOND_TXT: &str = r#"{"name":"write","arguments":"{\"path\":\"second.txt\",\"content\":\"s\"}"}"#;
const DELETE_OUTSIDE2: &str = r#"{"name":"delete_path","arguments":"{\"path\":\"../outside2.txt\"}"}"#;
const DELETE_AUTO: &str = r#"{"name":"delete_path","arguments":"{\"path\":\"auto.txt\"}"}"#;

// ---------------------------------------------------------------- 测试用例

/// suggest：越界写被拒且磁盘不变，.aishell/ 内放行；list_servers 不可用；全程无审批。
#[tokio::test(flavor = "multi_thread")]
async fn suggest_mode_blocks_outside_writes_but_allows_aishell() {
    let (env, pi) = setup("suggest", &[WRITE_OUTSIDE, WRITE_AISHELL_NOTE, LIST_SERVERS]).await;
    let Some(mut pi) = pi else { return };

    pi.prompt("请写入 ../outside.txt");
    pi.wait_settled();
    pi.prompt("请写入 .aishell/note.md");
    pi.wait_settled();
    pi.prompt("查询可操作的服务器");
    pi.wait_settled();

    assert!(
        !env.project_dir.join("outside.txt").exists(),
        "suggest 越界写必须被拒（项目外文件不变）"
    );
    assert!(
        env.project_dir.join(".aishell").join("note.md").is_file(),
        "suggest 写 .aishell/ 内应放行"
    );
    assert_eq!(pi.confirm_count(), 0, "suggest 模式不应产生任何审批请求");
    assert_eq!(pi.action_count(), 0, "suggest 模式不应产生任何动作桥请求");
    assert_tool_error(&env, "权限边界");
    assert_tool_error(&env, "Tool list_servers not found");
}

/// agent：每次受控工具调用单独审批；拒绝无副作用，批准才落盘。
#[tokio::test(flavor = "multi_thread")]
async fn agent_mode_asks_approval_per_tool_call() {
    let (env, pi) = setup("agent", &[WRITE_BLOCKED_TXT, WRITE_ALLOWED_TXT]).await;
    let Some(mut pi) = pi else { return };

    // 第一轮：拒绝
    pi.prompt("写入 blocked.txt");
    let req = pi.wait_confirm_request();
    assert!(req["title"].as_str().unwrap().starts_with("AISHELL_APPROVAL:"));
    pi.respond_confirm(req["id"].as_str().unwrap(), false);
    pi.wait_settled();
    assert!(
        !env.project_dir.join("blocked.txt").exists(),
        "拒绝后不得产生任何副作用"
    );
    assert_tool_error(&env, "用户拒绝了该操作");

    // 第二轮：批准
    pi.prompt("写入 allowed.txt");
    let req = pi.wait_confirm_request();
    pi.respond_confirm(req["id"].as_str().unwrap(), true);
    pi.wait_settled();
    assert!(
        env.project_dir.join("allowed.txt").is_file(),
        "批准后应写入项目内文件"
    );
    assert_eq!(
        std::fs::read_to_string(env.project_dir.join("allowed.txt")).unwrap(),
        "y"
    );
    assert_eq!(pi.confirm_count(), 2, "agent 每次受控调用都应产生一次审批");
}

/// yolo：不发 confirm 自动执行；`../` 越界仍拒绝；delete_path 在扩展内执行。
#[tokio::test(flavor = "multi_thread")]
async fn yolo_mode_auto_executes_without_approval_and_blocks_escape() {
    let (env, pi) = setup("yolo", &[WRITE_AUTO_TXT, DELETE_OUTSIDE2, DELETE_AUTO]).await;
    let Some(mut pi) = pi else { return };

    pi.prompt("写入 auto.txt");
    pi.wait_settled();
    assert!(env.project_dir.join("auto.txt").is_file(), "yolo 应自动执行写入");

    pi.prompt("删除 ../outside2.txt");
    pi.wait_settled();
    assert!(
        !env.project_dir.join("outside2.txt").exists(),
        "yolo 越界删除必须被拒"
    );
    assert_tool_error(&env, "权限边界");

    pi.prompt("删除 auto.txt");
    pi.wait_settled();
    assert!(
        !env.project_dir.join("auto.txt").exists(),
        "yolo 应自动执行删除"
    );

    assert_eq!(pi.confirm_count(), 0, "yolo 不应产生任何审批请求");
    assert_eq!(pi.action_count(), 0, "delete_path 在扩展内执行，不应有动作桥请求");
}

/// /aishell-mode 热切换：非法值保持原模式；合法值立即生效（suggest→agent 后出现审批）。
/// 注：RPC 模式下 setActiveTools 不影响模型请求的 tools（pi 限制），自定义工具
/// （delete_path/run_command/sftp_*）在下次 spawn 按新模式激活；此处验证基础工具审批切换。
#[tokio::test(flavor = "multi_thread")]
async fn mode_hot_switch_via_command() {
    let (env, pi) = setup(
        "suggest",
        &[WRITE_PROJECT_TXT, WRITE_PROJECT_TXT, WRITE_SECOND_TXT],
    )
    .await;
    let Some(mut pi) = pi else { return };

    // suggest：写项目根文件被拒
    pi.prompt("写入 project.txt");
    pi.wait_settled();
    assert!(!env.project_dir.join("project.txt").exists());
    assert_eq!(pi.confirm_count(), 0);

    // 热切到 agent：下一轮出现审批，批准后落盘
    pi.write(&json!({"type": "prompt", "message": "/aishell-mode agent"}));
    pi.prompt("写入 project.txt");
    let req = pi.wait_confirm_request();
    pi.respond_confirm(req["id"].as_str().unwrap(), true);
    pi.wait_settled();
    assert!(env.project_dir.join("project.txt").is_file());
    assert_eq!(pi.confirm_count(), 1);

    // 非法模式：保持 agent（下一轮仍出现审批）
    pi.write(&json!({"type": "prompt", "message": "/aishell-mode bogus"}));
    pi.prompt("写入 second.txt");
    let req = pi.wait_confirm_request();
    pi.respond_confirm(req["id"].as_str().unwrap(), true);
    pi.wait_settled();
    assert!(env.project_dir.join("second.txt").is_file());
    assert_eq!(pi.confirm_count(), 2, "非法模式不应改变当前模式");
}
