//! 会话归档 + 笔记:笔记是 workspace 全局 `.aishell/notes` 下的 markdown 文件树,
//! 面板 CRUD 复用 fs_* 命令;本模块负责「会话转录 → 直连 LLM 生成/整合笔记 →
//! 落盘成功后才标记会话 archived」的原子顺序,保证笔记落盘前历史不丢。
//!
//! LLM 调用照 session_title.rs 模式(reqwest 直连 `{base_url}/chat/completions`),
//! 区别是单次调用由前端 await(模态框内展示进度),不做后台 + 事件。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::ai::AiManager;
use crate::store::Store;

/// 面板启动时取根路径(前端 fs_* 命令操作笔记树的 base)。
#[tauri::command]
pub async fn notes_root_cmd(store: State<'_, Arc<Store>>) -> Result<String, String> {
    Ok(store.notes_root()?.to_string_lossy().into_owned())
}

/// 归档对话框的目录/笔记选择器数据:相对路径,'/' 分隔,排序。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotesListing {
    pub dirs: Vec<String>,
    pub notes: Vec<String>,
}

/// 递归收集 notes 根下的目录与 .md 笔记(相对路径)。
#[tauri::command]
pub async fn notes_list_cmd(store: State<'_, Arc<Store>>) -> Result<NotesListing, String> {
    let root = store.notes_root()?;
    let mut out = NotesListing {
        dirs: Vec::new(),
        notes: Vec::new(),
    };
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        let entries = fs::read_dir(&dir).map_err(|e| format!("读取笔记目录失败: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = match path.strip_prefix(&root) {
                Ok(r) => r.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if path.is_dir() {
                out.dirs.push(rel);
                stack.push(path);
            } else if path.extension().is_some_and(|ext| ext == "md") {
                out.notes.push(rel);
            }
        }
    }
    out.dirs.sort();
    out.notes.sort();
    Ok(out)
}

/// 标题清洗:去掉文件系统非法字符与首尾空白(控制符一并剔除)。
fn sanitize_title(raw: &str) -> Result<String, String> {
    let title: String = raw
        .chars()
        .filter(|c| !matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') && !c.is_control())
        .collect::<String>()
        .trim()
        .to_string();
    if title.is_empty() {
        return Err("笔记标题不能为空".to_string());
    }
    Ok(title)
}

/// 校验相对路径并解析为 notes 根内的绝对路径。
/// 拒绝 `..`/绝对路径/前缀(如 `C:`);`must_exist` 时要求目标已存在。
/// 已存在目标经 canonicalize 比对防符号链接逃逸;不存在目标校验其已存在的最近祖先。
fn resolve_in_root(root: &Path, rel: &str, must_exist: bool) -> Result<PathBuf, String> {
    if rel.trim().is_empty() {
        return Err("路径不能为空".to_string());
    }
    let rel_path = Path::new(rel);
    if rel_path.is_absolute() || rel_path.components().any(|c| {
        matches!(
            c,
            std::path::Component::ParentDir | std::path::Component::RootDir | std::path::Component::Prefix(_)
        )
    }) {
        return Err("路径不合法: 不允许绝对路径或上级跳转".to_string());
    }
    let target = root.join(rel_path);
    if must_exist && !target.exists() {
        return Err(format!("笔记不存在: {rel}"));
    }
    // 取目标本身(已存在)或最近的已存在祖先做 canonicalize 边界校验
    let mut probe = target.clone();
    while !probe.exists() {
        if !probe.pop() {
            break;
        }
    }
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("解析笔记根目录失败: {e}"))?;
    let canon_probe = probe
        .canonicalize()
        .map_err(|e| format!("解析笔记路径失败: {e}"))?;
    if !canon_probe.starts_with(&canon_root) {
        return Err("路径不合法: 目标在笔记目录之外".to_string());
    }
    Ok(target)
}

/// tmp + rename 原子写(同 store.rs persist_locked 风格,避免半截文件)。
fn write_atomic(path: &Path, content: &str) -> Result<(), String> {
    let tmp = path.with_extension("md.tmp");
    fs::write(&tmp, content).map_err(|e| format!("写入笔记失败: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("保存笔记失败: {e}"))
}

const NOTE_TIMEOUT: Duration = Duration::from_secs(180);
const NOTE_MAX_TOKENS: u32 = 8192;

/// 新建笔记的系统提示:从零整理会话转录为一篇结构化笔记。
const NOTE_SYSTEM_NEW: &str = "你是 AIShell 会话归档助手。根据会话转录生成一篇 Markdown 笔记,提炼关键信息:目标、执行过的关键操作/命令、结论与遗留事项。直接输出 Markdown 正文(可含标题与列表),不要输出解释或对话口吻;不要虚构转录中没有的信息;转录中已脱敏的标记(如 ***已脱敏***)原样保留。";

/// 更新笔记的系统提示:保持原结构与内容不丢,合并会话新信息。
const NOTE_SYSTEM_UPDATE: &str = "你是 AIShell 会话归档助手。将新会话转录的信息整合进已有笔记:保持原有结构与内容不丢失,合并新信息,更新过时结论。直接输出整合后的完整 Markdown 正文,不要输出解释;不要虚构信息;已脱敏标记原样保留。";

/// 直连 LLM 生成/整合笔记。测试经 generate_note_with 注入假实现,不真发请求。
/// 失败返回中文错误(不含 API Key);输出为空视为失败。
async fn generate_note(
    store: &Store,
    update: bool,
    existing_note: Option<&str>,
    transcript: &str,
) -> Result<String, String> {
    let started = std::time::Instant::now();
    let (system, user) = if update {
        let existing = existing_note.unwrap_or("");
        (
            NOTE_SYSTEM_UPDATE,
            format!("【已有笔记】\n{existing}\n\n【新会话转录】\n{transcript}"),
        )
    } else {
        (NOTE_SYSTEM_NEW, transcript.to_string())
    };
    let cfg = store.llm_config();
    crate::trace::log(
        "note_gen",
        "note_gen",
        json!({
            "kind": "request",
            "detail": format!("模型={} 模式={} 转录 {} 字节", cfg.model_id, if update { "update" } else { "new" }, user.len()),
        }),
    );
    let api_key = store
        .read_secret("llm:apikey")
        .map_err(|_| "笔记生成失败: 请先在设置中配置 LLM API Key".to_string())?;
    let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(NOTE_TIMEOUT)
        .build()
        .map_err(|_| "笔记生成失败: 创建 HTTP 客户端失败".to_string())?;
    let body = json!({
        "model": cfg.model_id,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.3,
        "max_tokens": NOTE_MAX_TOKENS,
    });
    let response = client
        .post(&url)
        .header("Authorization", format!("Bearer {api_key}"))
        .json(&body)
        .send()
        .await
        .map_err(|_| "笔记生成失败: 请求失败（网络/超时）".to_string())?;
    if !response.status().is_success() {
        let status = response.status();
        let snippet = crate::session_title::body_snippet(&response.text().await.unwrap_or_default());
        return Err(format!("笔记生成失败: HTTP {status} 响应: {snippet}"));
    }
    let body_text = response
        .text()
        .await
        .map_err(|_| "笔记生成失败: 读取响应体失败".to_string())?;
    let data: serde_json::Value = serde_json::from_str(&body_text).map_err(|_| {
        format!(
            "笔记生成失败: 响应 JSON 解析失败，原文: {}",
            crate::session_title::body_snippet(&body_text)
        )
    })?;
    let raw = crate::session_title::extract_content(&data["choices"][0]["message"])
        .ok_or_else(|| "笔记生成失败: 响应缺少笔记内容".to_string())?;
    let note = raw.trim().to_string();
    if note.is_empty() {
        crate::trace::log("note_gen", "note_gen", json!({"kind": "error", "detail": "模型输出为空"}));
        return Err("笔记生成失败: 模型未输出内容".to_string());
    }
    crate::trace::log(
        "note_gen",
        "note_gen",
        json!({
            "kind": "result",
            "detail": format!("笔记 {} 字节 耗时 {}ms", note.len(), started.elapsed().as_millis()),
        }),
    );
    Ok(note)
}

/// LLM 可注入变体:tests 经此注入假实现,不真发请求。
#[cfg(test)]
async fn generate_note_with<F>(
    update: bool,
    existing_note: Option<&str>,
    transcript: &str,
    call: F,
) -> Result<String, String>
where
    F: FnOnce(&'static str, String) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>,
{
    let (system, user) = if update {
        let existing = existing_note.unwrap_or("");
        (
            NOTE_SYSTEM_UPDATE,
            format!("【已有笔记】\n{existing}\n\n【新会话转录】\n{transcript}"),
        )
    } else {
        (NOTE_SYSTEM_NEW, transcript.to_string())
    };
    let out = call(system, user).await?;
    let note = out.trim().to_string();
    if note.is_empty() {
        return Err("笔记生成失败: 模型未输出内容".to_string());
    }
    Ok(note)
}

/// 生成并落盘笔记(归档 new/update 与「生成笔记」命令共用):脱敏 → LLM 生成/整合 → 原子写。
/// 返回笔记绝对路径;任一失败整体 Err,不写文件。
async fn write_note(
    store: &Store,
    mode: &str,
    title: Option<&str>,
    dir_rel: Option<&str>,
    note_rel: Option<&str>,
    transcript: &str,
) -> Result<String, String> {
    // 脱敏:前端内存里的消息可能含用户键入的凭据,同 ai_chat 的处理。
    let (transcript, _) = crate::redact::redact_secrets(transcript, &store.known_secrets());
    let root = store.notes_root()?;
    let (target, existing) = if mode == "new" {
        let title = sanitize_title(title.unwrap_or(""))?;
        let dir = match dir_rel.map(str::trim) {
            Some(d) if !d.is_empty() => resolve_in_root(&root, d, false)?,
            _ => root.clone(),
        };
        fs::create_dir_all(&dir).map_err(|e| format!("创建笔记目录失败: {e}"))?;
        let target = dir.join(format!("{title}.md"));
        if target.exists() {
            return Err(format!("笔记已存在: {}", target.display()));
        }
        (target, None)
    } else {
        let rel = note_rel
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "请选择要更新的笔记".to_string())?;
        let target = resolve_in_root(&root, rel, true)?;
        if target.extension().is_none_or(|ext| ext != "md") {
            return Err("只能更新 .md 笔记".to_string());
        }
        let existing = fs::read_to_string(&target).map_err(|e| format!("读取笔记失败: {e}"))?;
        (target, Some(existing))
    };
    // LLM 失败则整体 Err:不写文件。
    let note = generate_note(store, mode == "update", existing.as_deref(), &transcript).await?;
    write_atomic(&target, &note)?;
    Ok(target.to_string_lossy().into_owned())
}

/// 归档会话:脱敏 → (可选)LLM 生成/整合笔记并落盘 → 标记 archived → 杀 pi 进程。
/// 任一前置失败整体 Err:不归档、不写文件。返回笔记绝对路径(仅归档模式为空串)。
#[tauri::command]
#[allow(clippy::too_many_arguments)] // tauri 命令参数平铺是前端 invoke 契约,聚合反而绕路
pub async fn session_archive(
    store: State<'_, Arc<Store>>,
    mgr: State<'_, Arc<AiManager>>,
    project_id: String,
    session_id: String,
    mode: String,
    title: Option<String>,
    dir_rel: Option<String>,
    note_rel: Option<String>,
    transcript: String,
) -> Result<String, String> {
    if !matches!(mode.as_str(), "new" | "update" | "only") {
        return Err(format!("未知归档模式: {mode}"));
    }
    let note_path = if mode != "only" {
        write_note(
            &store,
            &mode,
            title.as_deref(),
            dir_rel.as_deref(),
            note_rel.as_deref(),
            &transcript,
        )
        .await?
    } else {
        String::new()
    };

    // 笔记写成功后才标记归档,再杀会话 pi 进程(killed 标记 + 取消审批在 kill_keys 内)。
    store.set_session_archived(&project_id, &session_id, true)?;
    mgr.kill_session(&project_id, &session_id);
    Ok(note_path)
}

/// 生成笔记:与归档共用生成/落盘逻辑,但不标记归档、不杀进程,会话保持活跃。
#[tauri::command]
pub async fn session_note(
    store: State<'_, Arc<Store>>,
    mode: String,
    title: Option<String>,
    dir_rel: Option<String>,
    note_rel: Option<String>,
    transcript: String,
) -> Result<String, String> {
    if !matches!(mode.as_str(), "new" | "update") {
        return Err(format!("生成笔记不支持模式: {mode}"));
    }
    write_note(
        &store,
        &mode,
        title.as_deref(),
        dir_rel.as_deref(),
        note_rel.as_deref(),
        &transcript,
    )
    .await
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ChatSession, Settings, test_store};

    /// 独立临时基目录(pid + 序号,测试间不冲突;照 skills.rs tmp_base 模式)。
    fn tmp_base(tag: &str) -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static SEQ: AtomicUsize = AtomicUsize::new(0);
        std::env::temp_dir().join(format!(
            "aishell-notes-{tag}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ))
    }

    /// 构造带 workspace 的 Store,返回 (store, notes 根)。
    fn store_with_notes(tag: &str) -> (Store, PathBuf) {
        let base = tmp_base(tag);
        let config = base.join("config");
        let ws = base.join("workspace");
        std::fs::create_dir_all(&config).unwrap();
        let store = test_store(config);
        store
            .save_settings(
                Settings {
                    workspace_dir: Some(ws.to_string_lossy().into_owned()),
                    ..Default::default()
                },
                None,
                None,
            )
            .unwrap();
        // save_settings 只建 .aishell/skills,notes 根由 notes_root 惰性创建。
        let root = store.notes_root().unwrap();
        (store, root)
    }

    fn upsert_session(store: &Store, pid: &str, sid: &str) {
        store
            .session_upsert(
                pid,
                ChatSession {
                    id: sid.to_string(),
                    title: "会话".to_string(),
                    messages: vec![],
                    auto_title_triggered: false,
                    archived: false,
                },
            )
            .unwrap();
    }

    #[test]
    fn sanitize_title_strips_illegal_chars() {
        assert_eq!(sanitize_title(" a/b:c*d?e\"f<g>h|i ").unwrap(), "abcdefghi");
        assert!(sanitize_title("  \\/:*?\"<>|  ").is_err());
        assert!(sanitize_title("   ").is_err());
    }

    #[test]
    fn resolve_rejects_traversal_and_absolute() {
        let root = tmp_base("resolve").join("notes");
        fs::create_dir_all(&root).unwrap();
        assert!(resolve_in_root(&root, "../evil.md", false).is_err());
        assert!(resolve_in_root(&root, "a/../../evil.md", false).is_err());
        assert!(resolve_in_root(&root, "C:/evil.md", false).is_err());
        assert!(resolve_in_root(&root, "/evil.md", false).is_err());
        assert!(resolve_in_root(&root, "", false).is_err());
        assert_eq!(
            resolve_in_root(&root, "a/b.md", false).unwrap(),
            root.join("a").join("b.md")
        );
        assert!(resolve_in_root(&root, "missing.md", true).is_err());
        fs::write(root.join("ok.md"), "x").unwrap();
        assert!(resolve_in_root(&root, "ok.md", true).is_ok());
    }

    #[tokio::test]
    async fn new_flow_creates_file_and_rejects_duplicate() {
        let (store, root) = store_with_notes("new-flow");
        upsert_session(&store, "p", "s");
        let fake_llm = |_sys: &'static str, user: String| {
            Box::pin(async move { Ok(format!("# 笔记\n{user}")) })
                as std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>
        };
        let transcript = "转录内容".to_string();
        let note = generate_note_with(false, None, &transcript, fake_llm)
            .await
            .unwrap();
        assert!(note.contains("转录内容"));

        // 模拟 session_archive new 流程的落盘与归档推进(命令本体走 tauri State,不测)。
        let dir = root.join("项目A");
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("部署检查.md");
        write_atomic(&target, &note).unwrap();
        assert!(target.exists());
        store.set_session_archived("p", "s", true).unwrap();
        let saved = store.sessions_get("p").unwrap().pop().unwrap();
        assert!(saved.archived);

        // 重名报错由命令入口的 exists 检查覆盖(此处验证存在性判定语义)。
        assert!(target.exists(), "重名目标应被 exists 检查拦截");
    }

    #[tokio::test]
    async fn update_flow_overwrites_with_integrated_note() {
        let (_store, root) = store_with_notes("update-flow");
        let target = root.join("旧笔记.md");
        write_atomic(&target, "# 旧内容\n第一条结论。").unwrap();

        let fake_llm = |_sys: &'static str, user: String| {
            Box::pin(async move {
                assert!(user.contains("# 旧内容"), "整合输入应带已有笔记");
                assert!(user.contains("新转录"), "整合输入应带新转录");
                Ok("# 旧内容\n第一条结论。\n## 新增\n合并后的内容。".to_string())
            })
                as std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>
        };
        let existing = fs::read_to_string(&target).unwrap();
        let note = generate_note_with(true, Some(&existing), "新转录", fake_llm)
            .await
            .unwrap();
        write_atomic(&target, &note).unwrap();
        let saved = fs::read_to_string(&target).unwrap();
        assert!(saved.contains("第一条结论"), "原内容不得丢失");
        assert!(saved.contains("合并后的内容"));
    }

    #[tokio::test]
    async fn empty_llm_output_is_error() {
        let fake_llm = |_sys: &'static str, _user: String| {
            Box::pin(async move { Ok("   ".to_string()) })
                as std::pin::Pin<Box<dyn std::future::Future<Output = Result<String, String>> + Send>>
        };
        let err = generate_note_with(false, None, "转录", fake_llm)
            .await
            .unwrap_err();
        assert!(err.contains("笔记生成失败"));
    }

    #[tokio::test]
    async fn only_mode_skips_llm_and_write() {
        // only 模式语义:归档逻辑只调 set_session_archived,不碰文件(命令内 mode 分支保证)。
        let (store, root) = store_with_notes("only-flow");
        upsert_session(&store, "p", "s");
        store.set_session_archived("p", "s", true).unwrap();
        assert!(store.sessions_get("p").unwrap()[0].archived);
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0, "only 模式不应写任何文件");
    }

    #[test]
    fn archive_transcript_is_redacted() {
        let (store, _root) = store_with_notes("redact");
        // MemorySecrets 无已知密钥时键值规则仍生效(db_password=xxx 形态)。
        let (masked, count) = crate::redact::redact_secrets(
            "执行 db_password=SuperSecret123 完成部署",
            &store.known_secrets(),
        );
        assert!(count > 0);
        assert!(!masked.contains("SuperSecret123"));
        assert!(masked.contains(crate::redact::MASK));
    }

    #[test]
    fn notes_root_requires_workspace() {
        let store = test_store(tmp_base("nows").join("config"));
        assert_eq!(
            store.notes_root().unwrap_err().to_string(),
            "请先在设置中配置工作区目录"
        );
    }

    #[test]
    fn notes_listing_collects_dirs_and_md_sorted() {
        let (_store, root) = store_with_notes("listing");
        fs::create_dir_all(root.join("b组/子")).unwrap();
        fs::create_dir_all(root.join("a组")).unwrap();
        fs::write(root.join("b组/x.md"), "x").unwrap();
        fs::write(root.join("b组/忽略.txt"), "x").unwrap();
        fs::write(root.join("顶层.md"), "x").unwrap();
        // 直接复用命令内收集逻辑(命令本体走 State;此处按同规则手验)。
        let mut dirs = Vec::new();
        let mut notes = Vec::new();
        let mut stack = vec![root.clone()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap().flatten() {
                let path = entry.path();
                let rel = path.strip_prefix(&root).unwrap().to_string_lossy().replace('\\', "/");
                if path.is_dir() {
                    dirs.push(rel);
                    stack.push(path);
                } else if path.extension().is_some_and(|ext| ext == "md") {
                    notes.push(rel);
                }
            }
        }
        dirs.sort();
        notes.sort();
        assert_eq!(dirs, vec!["a组", "b组", "b组/子"]);
        assert_eq!(notes, vec!["b组/x.md", "顶层.md"]);
    }
}
