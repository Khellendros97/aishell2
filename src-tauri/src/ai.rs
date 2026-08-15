//! AI 助手（pi 子进程 RPC 嵌入）。
//! 契约：命令 `ai_chat(key, prompt)` / `ai_abort(key)` / `ai_kill_project(project_id)` /
//! `ai_set_thinking(project_id, level)` / `set_ai_mode(project_id, mode)` /
//! `ai_respond_approval(key, request_id, confirmed)`；
//! 事件 `ai:event:<key>` payload：
//!   - `{type:"delta",text}` / `{type:"tool",tool,label}` / `{type:"segment"}`
//!   - `{type:"done"}` / `{type:"error",message}`
//!   - `{type:"approval",requestId,toolCallId,action,intent,summary}`
//!   - `{type:"actionStart",toolCallId,tool,args}` / `{type:"actionEnd",toolCallId,tool,isError,result}`
//!
//! 另发全局事件 `fs:changed` payload `{path}`：AI 的 write/edit 工具成功落盘后广播
//! 规范化绝对路径，前端编辑器据此刷新已打开的对应文件（见 editor.ts）。
//!
//! key = "<projectId>:<sessionId>"，每 key 一个长驻 pi 进程。
//!
//! 三档模式（按项目持久化，见 store.rs AiMode）：suggest / agent / yolo。权限事实源在
//! pi_ext/aishell-guard.ts（每次 spawn 重写进 agent_dir 并显式 --extension 加载）：
//!
//! - suggest：read/grep/find/ls/write/edit(+web_search)+request_agent_mode（申请切换工作模式），写仅限 .aishell/；
//! - agent/yolo：读写限项目根 + delete_path/run_command/sftp_upload/sftp_download；
//! - agent 对受控工具逐调用 `AISHELL_APPROVAL:` confirm 审批；yolo 跳过；suggest 直接阻止。
//!
//! 模式切换（set_ai_mode）：agent ↔ yolo 热推 `/aishell-mode`（guard 模式变量即时生效）；
//! suggest ↔ agent/yolo 因工具集/系统提示在 spawn 时固定而静默重启该项目全部 pi 进程，
//! 会话历史经 `--session <agent_dir>/sessions/<projectId>__<sessionId>.jsonl` 恢复。
//! AI 主动申请切到工作模式：suggest 下工具 request_agent_mode 发 `AISHELL_MODE_REQUEST:`
//! confirm，经 approval 事件转发前端确认框，同意后前端走 set_ai_mode 实时切换路径。
//!
//! 动作执行经内部协议 `AISHELL_ACTION:` input 交给 ai_actions.rs（唯一后端入口：项目根校验 +
//! 服务器 AI 锁检查，锁只拦 AI，不影响用户手动 SSH/SFTP）。
//!
//! 基础工具远程化（read/grep/find/ls/write/edit/delete_path 的可选 serverId 参数）：
//! 同名覆盖注册在 aishell-guard.ts，远程执行经本桥新增的 remote_* 动作（ai_actions.rs）；
//! 远程写/删在自动备份开启时执行前 ensure_snapshot（与 run_command 远程写入同一暂存区）。
//! 远程 write/edit 不登记 pending_paths（不发 fs:changed），前端凭 actionStart 的
//! args.serverId 区分并改发 staging-changed（见 ai.ts）。
//!
//! 与计划唯一偏差：`procs` 字段为 `Arc<Mutex<HashMap<...>>>`（计划给的是裸 `Mutex`）——
//! 因为 stdout 读取线程必须在进程退出/管道破裂时「从 map 摘除」条目，裸 Mutex 无法被线程共享。
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use base64::Engine as _;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, State};

use crate::ai_actions::AiActions;
use crate::ai_impact::{analyze_remote_command, merge_plans, validate_impact_plan, Effect, ImpactPlan};
use crate::skills::{SkillOrigin, SkillSummary};
use crate::store::{AiMode, ApprovalMode, Store};

/// suggest 模式的系统提示（保持现状：无 bash，写仅 .aishell/）。
const SYSTEM_PROMPT_SUGGEST: &str = "你是 AIShell 的内置终端助手。用户围绕本地/远程终端工作流提问，消息中可能附带终端快照（形如 [终端快照 命令: <cmd>] 加输出内容）。
文件工具边界（硬性，越界调用会被门控拒绝）：
- read/grep/find/ls：只能读当前项目目录内的文件，项目外一律不可读。
- write/edit：只能写项目下 .aishell/ 目录内的文件（可用于保存笔记、记忆、计划；父目录不存在会自动创建）。
- 没有 bash 工具，不能执行任何命令。
- request_agent_mode：当你需要执行命令或修改项目源码等 .aishell/ 之外的文件时，调用该工具向用户申请切换到工作(Agent)模式；需用户同意，不同意则继续给出建议。
- web_search：联网搜索（Brave Search）。涉及最新新闻、文档、报错信息、版本/依赖变化等时效性问题时使用；结果带来源链接，回复中引用关键来源。
- 用户要求修改项目源码等 .aishell/ 之外的文件时：不要调用 write/edit（会被拒），改为给出命令或补丁文本让用户自行处理。
输出协议（必须严格遵守）：
1. 建议用户在终端执行的命令：每条命令单独放在一个 ```command 围栏代码块中，块内只有命令本身，不加解释。
2. 给用户直接复用的文本（说明、模板等）：放在 ```text 围栏代码块中。
3. 普通代码示例使用对应语言的围栏代码块。
4. 用中文回复，简洁直接。";

/// agent / yolo 模式的系统提示（有执行权限；Agent 逐调用审批，YOLO 已获用户显式授权）。
const SYSTEM_PROMPT_AGENT: &str = "你是 AIShell 的内置终端助手。用户围绕本地/远程终端工作流提问，消息中可能附带终端快照（形如 [终端快照 命令: <cmd>] 加输出内容）。
你有执行权限（Agent 模式每次操作需用户批准；YOLO 模式自动执行，用户已显式授权）：
- run_command：在本地 shell（项目根目录）或远程服务器执行命令；调用时必须提供 intent（一句中文说明命令意图，会展示给用户审批）。默认 10 秒超时，可用 timeoutSeconds（1–3600 秒）覆盖；预计超过 10 秒的命令应主动设置合理超时。
- list_servers：查询当前项目绑定的可操作服务器（serverId、地址、锁定状态）；远程操作前先调用它确认 serverId，不要凭空编造服务器 ID。
- sftp_upload/sftp_download：向项目绑定的服务器上传/下载文件（本地路径必须在项目目录内）。
- 远程文件读写：read/grep/find/ls/write/edit/delete_path 都支持可选 serverId 参数（先用 list_servers 确认 serverId；不传则操作本地项目目录）。远程文件的内容查看/修改**优先用这些工具**，不要用 run_command 的 cat/sed/echo/tee 等命令读写远程文件内容——基础工具的远程写入/删除会自动进入会话暂存（自动备份原始快照，可 diff/还原）；run_command 用于服务管理、进程、包管理等非文件内容操作。远程路径可用绝对路径（/ 开头）或相对服务器登录目录的相对路径；不支持盘符形态。
- db_query：受管数据库查询（mysql/postgres/clickhouse/redis）。参数 serverId + connectionId + command（SQL 或单条 redis 命令）；凭据由系统代管，你**看不到也拿不到密码**。只允许执行该连接配置白名单内的命令（默认只读：SELECT/SHOW/DESC/EXPLAIN、redis 的 GET/KEYS/SCAN 等）；白名单外的命令会被拒绝。用户在白名单中加入的写命令（如 UPDATE/DELETE）需用户人工审批。
- 远程动作受服务器 AI 操作锁约束：锁定服务器会返回「已锁定，AI 无权执行远程操作」错误。
- 远程文件暂存（staging_list / staging_diff / staging_restore）：自动备份开启时，AI 修改远程文件（基础工具 write/edit/delete_path 带 serverId、run_command 写入、sftp_upload 覆盖）前系统已自动保存原始快照。你可以查看当前会话暂存列表、查看某条目的 diff、按用户要求把远程文件还原到首次修改前的内容；**不能接受（清除）暂存条目**——接受由用户在「文件暂存区」面板操作，调用接受类工具会被拒绝。还原遇到外部修改冲突（远程文件已被用户改动）时如实报告冲突，不得声称已还原。
- web_search：联网搜索（Brave Search）。涉及最新新闻、文档、报错信息、版本/依赖变化等时效性问题时使用；结果带来源链接，回复中引用关键来源。
- 所有动作都以实际结果为准：失败时如实说明错误，不要编造执行结果。
凭据纪律（硬性，优先级高于任务效率）：
- 不得主动查找、读取、提取任何密码/密钥/Token（包括从配置文件、二进制、环境变量、数据库中获取凭据）；任务确需凭据时，立即停止该步操作并说明原因，请用户在终端手动执行。
- 查询数据库一律使用 db_query 工具（凭据由系统代管），不得尝试用 run_command 读取配置、连接数据库或提取密码；redis/mysql/postgres/clickhouse 客户端命令行也不得自行调用。
- 输出中出现「***已脱敏***」表示系统已隐藏凭据内容，属正常现象，不得尝试用 base64、hex、分段读取等方式绕过获取。
输出协议（必须严格遵守）：
1. 需要用户手动执行的命令：每条命令单独放在一个 ```command 围栏代码块中，块内只有命令本身，不加解释。
2. 给用户直接复用的文本（说明、模板等）：放在 ```text 围栏代码块中。
3. 普通代码示例使用对应语言的围栏代码块。
4. 用中文回复，简洁直接。";

/// 本地终端环境说明（注入系统提示词开头）：明确 shell 类型，避免模型按错误 shell 语法
/// 执行本地 run_command（Windows 是 Git Bash，macOS/Linux 是 zsh）。
#[cfg(windows)]
fn local_env_note() -> &'static str {
    "本地终端环境：Windows + Git Bash（Bash 语法）。本地 run_command 在项目根目录的 Git Bash 中执行，命令必须使用 Bash 语法，不是 cmd/PowerShell 语法；远程命令按目标服务器的默认 shell 执行。"
}

#[cfg(not(windows))]
fn local_env_note() -> &'static str {
    "本地终端环境：macOS/Linux + zsh（POSIX Shell 语法）。本地 run_command 在项目根目录的默认 shell 中执行；远程命令按目标服务器的默认 shell 执行。"
}

/// 门控扩展源码（spawn 时重写进 agent_dir，与 models.json 同模式）。
const GUARD_EXT: &str = include_str!("pi_ext/aishell-guard.ts");

/// 联网搜索扩展源码（web_search 工具，Brave Search；spawn 时重写进 agent_dir）。
const SEARCH_EXT: &str = include_str!("pi_ext/aishell-search.ts");

/// 默认工具白名单；settings.search.enabled 时追加 web_search。
const BASE_TOOLS: &str = "read,grep,find,ls,write,edit";

/// 需要动作卡 / 审批的受控工具。
/// 注意：ai.rs 侧（动作卡渲染）与 aishell-guard.ts 侧（逐调用审批）不再完全一致——
/// staging_list / staging_diff 只读不入审批（guard 侧不在 CONTROLLED_TOOLS），但执行时
/// 仍经动作桥并在 ai.rs 侧渲染小字活动行；staging_restore 两侧都要（审批 + 卡片）。
const CONTROLLED_TOOLS: [&str; 7] = [
    "write",
    "edit",
    "delete_path",
    "run_command",
    "sftp_upload",
    "sftp_download",
    "staging_restore",
];

/// 影响计划跟踪条目（tool_execution_start 登记 → 审批补充 → AISHELL_ACTION 消费）。
/// 存于单个 pi 进程的 stdout 读取线程（审批与动作桥在同一线程按序处理，无需跨线程锁）。
#[derive(Clone)]
struct ImpactEntry {
    /// run_command | sftp_upload
    tool: String,
    /// 登记时的结构化 args（执行时语义比对防篡改）
    payload: serde_json::Value,
    /// 审批阶段解析的远程工作目录（执行时复用，保证分析与 exec 环境一致）
    cwd: Option<String>,
    /// 审批绑定指纹 sha256(command+target+serverId+cwd)；无审批（yolo）为 None
    fingerprint: Option<String>,
    /// 审批后确定的计划（确定性 或 确定性+LLM 合并）；None = 执行时现算
    plan: Option<ImpactPlan>,
}

/// 审批与执行的绑定指纹：sha256(command+target+serverId+cwd)，payload 不一致直接拒绝。
fn impact_fingerprint(command: &str, target: &str, server_id: &str, cwd: &str) -> String {
    let mut h = Sha256::new();
    h.update(command.as_bytes());
    h.update([0u8]);
    h.update(target.as_bytes());
    h.update([0u8]);
    h.update(server_id.as_bytes());
    h.update([0u8]);
    h.update(cwd.as_bytes());
    hex::encode(h.finalize())
}

/// 动作参数语义指纹：只比较影响执行的字段——guard 的动作桥会在 payload 上附加
/// `action` / `sessionId` 等桥字段（tool_execution_start 的 args 里没有），直接整体比较
/// 必然误报。按工具关键字段判定（登记 args 无 action 字段，动作桥 payload 有）；
/// 其余动作按全量序列化（serde_json 的 Map 为 BTreeMap，对象键序无关）。
fn payload_fingerprint(p: &serde_json::Value) -> String {
    let get = |k: &str| p.get(k).and_then(serde_json::Value::as_str).unwrap_or("").to_string();
    let core = if p.get("command").is_some() && p.get("target").is_some() {
        // run_command：命令/目标/服务器/超时
        format!(
            "run_command|{}|{}|{}|{}",
            get("command"),
            get("target"),
            get("serverId"),
            p.get("timeoutSeconds").map(|v| v.to_string()).unwrap_or_default()
        )
    } else if p.get("localPath").is_some() && p.get("remoteDir").is_some() {
        // sftp_upload：服务器/本地源/远端目录/覆盖开关
        format!(
            "sftp_upload|{}|{}|{}|{}",
            get("serverId"),
            get("localPath"),
            get("remoteDir"),
            p.get("overwrite").and_then(serde_json::Value::as_bool).unwrap_or(false)
        )
    } else {
        p.to_string()
    };
    let mut h = Sha256::new();
    h.update(core.as_bytes());
    hex::encode(h.finalize())
}

/// 影响计划 → 前端审批事件透传 JSON（effect / changes / reason）。
fn impact_event_json(plan: &ImpactPlan) -> serde_json::Value {
    json!({
        "effect": plan.effect,
        "changes": plan.changes,
        "reason": plan.reason,
    })
}

/// pi 二进制名：Windows 发行版是 pi.exe，macOS/Linux 无扩展名。
/// lib.rs 的资源目录探测与本模块 spawn 共用（与 scripts/fetch-pi.mjs 的 TARGETS 对应）。
#[cfg(windows)]
pub(crate) const PI_BIN_NAME: &str = "pi.exe";
#[cfg(not(windows))]
pub(crate) const PI_BIN_NAME: &str = "pi";

/// 内部动作返回给模型的结果截断上限（pi docs 要求工具必须截断输出，防上下文溢出）。
const MAX_RESULT_CHARS: usize = 30_000;

/// 单个 key 的 pi 进程。
pub struct AiProc {
    child: Child,
    /// stdin 可被读取线程（动作结果回写）与 Tauri 命令（审批回复/abort/热推）共享。
    stdin: Arc<Mutex<ChildStdin>>,
    busy: Arc<AtomicBool>,
    killed: Arc<AtomicBool>,
    /// 待处理审批：extension_ui_request id -> toolCallId（ai_respond_approval 校验用）。
    approvals: Arc<Mutex<HashMap<String, String>>>,
    /// 启动时技能快照指纹（origin|name|enabled|scope|正文 稳定序列化）；ai_chat 发现
    /// 该项目指纹变化时 kill/wait/摘除后按同一 session 文件重生，下一条消息即生效。
    skill_fingerprint: String,
}

/// AI 进程管理器：每 key 一个长驻 pi 进程，进程生命周随工作台（ai_kill_project / Drop）结束。
pub struct AiManager {
    pub store: Arc<Store>,
    pub pi_dir: PathBuf,
    pub agent_dir: PathBuf,
    /// pi 运行时诊断（lib.rs 探测候选的命中情况 + resource_dir 实际内容）；
    /// spawn 报错与 ai_debug_info 命令输出,便于排查安装版资源布局差异。
    pub pi_debug: String,
    pub procs: Arc<Mutex<HashMap<String, AiProc>>>,
    actions: Arc<AiActions>,
    /// 最近一次 load_skills 中被项目同名技能覆盖的全局技能（name + 路径），ai_debug_info 输出用。
    covered_skills: Mutex<Vec<String>>,
}

/// 最终启用技能集合：先分别过滤 enabled=true，再按「项目技能在前、全局技能在后；各组按 name 排序」。
/// 同名时项目技能覆盖全局技能（被覆盖的全局项返回给调用方写入 AI 诊断，避免 pi 的
/// 「同名保留第一个」行为依赖未声明的扫描顺序）；项目同名项被禁用时不参与候选，全局启用项恢复加载。
fn select_enabled_skills(
    global: Vec<SkillSummary>,
    project: Vec<SkillSummary>,
) -> (Vec<SkillSummary>, Vec<SkillSummary>) {
    let mut global_enabled: Vec<SkillSummary> = global.into_iter().filter(|s| s.enabled).collect();
    let mut project_enabled: Vec<SkillSummary> = project.into_iter().filter(|s| s.enabled).collect();
    global_enabled.sort_by(|a, b| a.name.cmp(&b.name));
    project_enabled.sort_by(|a, b| a.name.cmp(&b.name));
    let project_names: HashSet<&str> = project_enabled.iter().map(|s| s.name.as_str()).collect();
    let (covered, rest): (Vec<_>, Vec<_>) = global_enabled
        .into_iter()
        .partition(|s| project_names.contains(s.name.as_str()));
    let mut final_list = project_enabled;
    final_list.extend(rest);
    (final_list, covered)
}

/// 稳定「Skill 作用域提示」区：追加在系统提示尾部。scope 只提示何时优先使用，不是权限或加载过滤；
/// 所有启用技能始终传给 pi，切换本地/远程工作区域不得重建或增删 --skill 参数（本区与指纹均不含
/// 工作区域）。scope 摘要不得包含技能正文或任意密钥值。
fn scope_prompt(skills: &[SkillSummary]) -> String {
    if skills.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "\n\n[Skill 作用域提示]\n以下为当前项目已启用的 AIShell Skill（name => scope）。scope 仅提示何时优先使用，不是权限或加载过滤：local 对应当前工作区域为本地，remote:<主机名称> 对应当前工作区域服务器的 Server.name，all 始终适用。所有已启用 Skill 均已加载，切换本地/远程工作区域不会改变本列表：\n",
    );
    for s in skills {
        out.push_str(&format!("- {} => {}\n", s.name, s.scope.join(", ")));
    }
    out
}

/// 技能快照指纹：最终加载项按固定顺序（列表序）拼接 origin|name|enabled|scope|SKILL.md 正文。
/// 直接比较稳定序列化字节即可，不新增散列依赖；工作区域变化不参与指纹。
fn skill_fingerprint(skills: &[SkillSummary], contents: &[String]) -> String {
    let mut out = String::new();
    for (s, c) in skills.iter().zip(contents) {
        out.push_str(s.origin.as_str());
        out.push('|');
        out.push_str(&s.name);
        out.push('|');
        out.push_str(if s.enabled { "1" } else { "0" });
        out.push('|');
        out.push_str(&s.scope.join(","));
        out.push('|');
        out.push_str(c);
        out.push('\n');
    }
    out
}

/// 一次技能装载结果（spawn / ai_chat 指纹共用）。
struct LoadedSkills {
    /// 最终传给 pi 的启用技能（项目在前、全局在后）。
    final_list: Vec<SkillSummary>,
    /// 稳定指纹（技能集合 + 正文）。
    fingerprint: String,
    /// 全局技能根（AISHELL_GLOBAL_SKILLS_DIR）。
    global_root: PathBuf,
}

impl AiManager {
    pub fn new(
        store: Arc<Store>,
        pi_dir: PathBuf,
        agent_dir: PathBuf,
        ssh: Arc<crate::ssh::SshManager>,
        staging: Arc<crate::staging::RemoteStaging>,
        pi_debug: String,
    ) -> Self {
        let actions = Arc::new(AiActions::new(Arc::clone(&store), ssh, staging));
        AiManager {
            store,
            pi_dir,
            agent_dir,
            pi_debug,
            procs: Arc::new(Mutex::new(HashMap::new())),
            actions,
            covered_skills: Mutex::new(Vec::new()),
        }
    }

    /// 读取并校验本项目技能集合：任何 SKILL.md 解析失败都返回含路径的中文错误，
    /// 阻止 spawn（不能退化为无技能启动）。
    fn load_skills(&self, project_id: &str) -> Result<LoadedSkills, String> {
        let all = crate::skills::list_skills(&self.store, project_id)?;
        let (global, project): (Vec<_>, Vec<_>) = all
            .into_iter()
            .partition(|s| s.origin == SkillOrigin::Global);
        let (final_list, covered) = select_enabled_skills(global, project);
        let mut contents = Vec::with_capacity(final_list.len());
        for s in &final_list {
            let c = std::fs::read_to_string(&s.path)
                .map_err(|e| format!("SKILL.md 读取失败（{}）: {e}", s.path))?;
            contents.push(c);
        }
        let fingerprint = skill_fingerprint(&final_list, &contents);
        let global_root = crate::skills::global_skills_root(&self.store)?;
        *self
            .covered_skills
            .lock()
            .unwrap_or_else(|p| p.into_inner()) = covered
            .iter()
            .map(|s| format!("{}（{}）", s.name, s.path))
            .collect();
        Ok(LoadedSkills { final_list, fingerprint, global_root })
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

    /// 为 key 拉起 pi 进程并启动 stdout 读取线程（读线程负责 done/error 事件、审批转发、
    /// 内部动作执行与异常退出摘除）。
    fn spawn(&self, app: &AppHandle, key: &str, project_id: &str) -> Result<(), String> {
        let pi_bin = self.pi_dir.join(PI_BIN_NAME);
        if !pi_bin.is_file() {
            return Err(format!(
                "pi 运行时不存在：{}（安装可能不完整，请重新安装；以下诊断信息可反馈给开发者）\n{}",
                pi_bin.display(),
                self.pi_debug
            ));
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
        let mode = self.store.ai_mode(project_id).unwrap_or_default();
        // 技能装载（失败阻止 spawn，含损坏路径的中文错误；正文不拼入系统提示，由 pi 按需 read）
        let loaded = self.load_skills(project_id)?;
        // 本地终端环境说明注入提示词：让模型用对 shell 语法（Windows 是 Git Bash，不是 cmd/PowerShell）
        let system_prompt = format!(
            "{}\n{}{}",
            local_env_note(),
            match mode {
                AiMode::Suggest => SYSTEM_PROMPT_SUGGEST,
                AiMode::Agent | AiMode::Yolo => SYSTEM_PROMPT_AGENT,
            },
            scope_prompt(&loaded.final_list)
        );
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

        // 初始工具集按模式下发（agent/yolo 直接启用变更工具，避免依赖扩展加载期 setActiveTools）；
        // 热切换仍由 /aishell-mode 命令 + 扩展 applyToolset 增量同步。
        // 注意：RPC 模式下工具集在 spawn 时经 --tools 固定（setActiveTools 不影响模型请求），
        // 跨 suggest 边界切换模式需重启进程（见 set_ai_mode）。
        let mut tools = if mode == AiMode::Suggest {
            format!("{BASE_TOOLS},request_agent_mode")
        } else {
            format!("{BASE_TOOLS},delete_path,run_command,sftp_upload,sftp_download,list_servers,db_query,staging_list,staging_diff,staging_restore")
        };
        if search_enabled {
            tools.push_str(",web_search");
        }

        // 会话持久化（每 key 固定路径）：pi 自动把对话条目落盘到此 jsonl；
        // 模式跨 suggest 边界切换时重启进程，凭同一路径恢复完整对话历史（探针验证）。
        let session_dir = self.agent_dir.join("sessions");
        std::fs::create_dir_all(&session_dir).map_err(|e| format!("创建 pi 会话目录失败: {e}"))?;
        let session_id = key.split_once(':').map(|(_, s)| s).unwrap_or("default");
        let session_path = session_dir.join(format!("{project_id}__{session_id}.jsonl"));

        let mut cmd = Command::new(&pi_bin);
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
        .arg(tools)
        .args(["--no-extensions", "--extension"])
        .arg(&guard_path)
        .args(["--extension"])
        .arg(&search_path)
        .args(["--no-approve", "--session"])
        .arg(&session_path)
        .args([
            "--no-context-files",
            "--append-system-prompt",
            &system_prompt,
        ])
        // 阻断 ~/.pi/agent/skills、~/.agents/skills 等非 AIShell 技能泄漏；只挂载本项目启用技能
        .args(["--no-skills"]);
        for s in &loaded.final_list {
            cmd.args(["--skill"]).arg(&s.path);
        }
        cmd.env("PI_CODING_AGENT_DIR", &self.agent_dir)
            .env("DEEPSEEK_API_KEY", &api_key)
            .env("AISHELL_AI_MODE", mode.as_str())
            // 会话身份注入 guard：staging / run_command 动作桥据此携带当前会话（guard 工具不暴露
            // 任意 project/session 参数，后端动作桥以 key 推导为准、payload 仅作一致性参考）
            .env("AISHELL_PROJECT_ID", project_id)
            .env("AISHELL_SESSION_ID", session_id);
        // AI 读写技能所需目录（JSON 数组编码，guard 严格解析，失败 fail-closed 只保留项目根）：
        // 只读允许根 = 最终启用技能目录清单；write/edit/delete 额外允许全局技能根
        let skill_dirs: Vec<String> = loaded
            .final_list
            .iter()
            .map(|s| {
                Path::new(&s.path)
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_else(|| s.path.clone())
            })
            .collect();
        let global_skills = vec![loaded.global_root.to_string_lossy().into_owned()];
        let enc = |v: &[String]| serde_json::to_string(v).unwrap_or_else(|_| "[]".to_string());
        cmd.env("AISHELL_SKILL_DIRS", enc(&skill_dirs))
            .env("AISHELL_GLOBAL_SKILLS_DIR", enc(&global_skills));
        if let Some(key) = brave_key {
            cmd.env("BRAVE_API_KEY", key);
        }
        cmd.current_dir(&cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        // Windows 下隐藏 pi 的控制台窗口（pi.exe 是控制台程序，不设标志会弹出黑色终端窗口）
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = cmd.spawn().map_err(|e| format!("启动 pi 进程失败: {e}"))?;
        let stdin = Arc::new(Mutex::new(
            child.stdin.take().ok_or_else(|| "pi 进程 stdin 不可用".to_string())?,
        ));
        let stdout = child.stdout.take().ok_or_else(|| "pi 进程 stdout 不可用".to_string())?;

        let busy = Arc::new(AtomicBool::new(false));
        let killed = Arc::new(AtomicBool::new(false));
        let approvals: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
        let app2 = app.clone();
        let key2 = key.to_string();
        let event = format!("ai:event:{key2}");
        let cwd2 = cwd.clone();
        let busy2 = busy.clone();
        let killed2 = killed.clone();
        let procs2 = self.procs.clone();
        let stdin2 = Arc::clone(&stdin);
        let approvals2 = Arc::clone(&approvals);
        let actions = Arc::clone(&self.actions);
        let project_id2 = project_id.to_string();
        let session_id2 = session_id.to_string();
        let store2 = Arc::clone(&self.store);
        thread::spawn(move || {
            // 影响计划跟踪：tool_execution_start 登记 → 审批补充 → AISHELL_ACTION 消费
            let mut impact_tracker: HashMap<String, ImpactEntry> = HashMap::new();
            // 已开始执行的 write/edit 工具 → 规范化绝对路径（end 成功时据此发 fs:changed）
            let mut pending_paths: HashMap<String, String> = HashMap::new();
            // 是否已收到过终止性事件（done/error）：正常收尾后退出不再报「异常退出」
            let mut settled = false;
            // 本轮生成是否已发过终态事件（done 或 error 只发一次；turn_start 重置）
            let mut terminal_emitted = false;
            // 当前 assistant 消息是否已流过文本增量（工具来回多段消息时分段用）
            let mut text_started = false;
            // 内部动作需要 async 执行：懒建 tokio runtime（进程内动作次数极少）
            let mut rt: Option<tokio::runtime::Runtime> = None;
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
                    // 工具活动：受控工具在 agent/yolo 下以动作卡（actionStart/actionEnd）呈现，
                    // 其余工具仍走瞬时小字行（tool）。
                    "tool_execution_start" => {
                        let tool = ev.get("toolName").and_then(serde_json::Value::as_str).unwrap_or("");
                        // write/edit 的目标路径（相对项目根）先登记：end 成功时据此广播 fs:changed。
                        // 远程模式（args 带 serverId）跳过：改的是远端文件，不发本地 fs:changed
                        //（前端凭 args.serverId 区分并改发 staging-changed）。
                        if tool == "write" || tool == "edit" {
                            let is_remote = ev
                                .get("args")
                                .and_then(|a| a.get("serverId"))
                                .and_then(serde_json::Value::as_str)
                                .map(|s| !s.is_empty())
                                .unwrap_or(false);
                            if !is_remote {
                                let raw = ev
                                    .get("args")
                                    .and_then(|a| a.get("path"))
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("");
                                if !raw.is_empty() {
                                    let abs = std::path::absolute(Path::new(&cwd2).join(raw))
                                        .map(|p| p.to_string_lossy().into_owned())
                                        .unwrap_or_else(|_| Path::new(&cwd2).join(raw).to_string_lossy().into_owned());
                                    let id = ev
                                        .get("toolCallId")
                                        .and_then(serde_json::Value::as_str)
                                        .unwrap_or("")
                                        .to_string();
                                    pending_paths.insert(id, abs);
                                }
                            }
                        }
                        if mode != AiMode::Suggest && CONTROLLED_TOOLS.contains(&tool) {
                            let tool_call_id = ev
                                .get("toolCallId")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            // args 剥离 content（文件正文不进事件，避免 UI/审计膨胀）
                            let mut args = ev.get("args").cloned().unwrap_or_else(|| json!({}));
                            if let Some(obj) = args.as_object_mut() {
                                obj.remove("content");
                            }
                            // 影响计划登记（yolo 也走：执行时按确定性计划快照/拒绝 unbounded）：
                            // run_command（仅远程）与 sftp_upload 在 AISHELL_ACTION 前需要
                            // 会话级暂存信息；其余受控工具不涉及远程文件。
                            let target = args
                                .get("target")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("");
                            let is_remote_cmd = tool == "run_command" && target == "remote";
                            if is_remote_cmd || tool == "sftp_upload" {
                                impact_tracker.insert(
                                    tool_call_id.clone(),
                                    ImpactEntry {
                                        tool: tool.to_string(),
                                        payload: args.clone(),
                                        cwd: None,
                                        fingerprint: None,
                                        plan: None,
                                    },
                                );
                            }
                            let _ = app2.emit(
                                &event,
                                json!({"type": "actionStart", "toolCallId": tool_call_id, "tool": tool, "args": args}),
                            );
                        } else {
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
                    }
                    "tool_execution_end" => {
                        let tool = ev.get("toolName").and_then(serde_json::Value::as_str).unwrap_or("");
                        // AI 写文件成功落盘 → 全局广播，前端刷新已打开的对应编辑器标签
                        if (tool == "write" || tool == "edit")
                            && !ev.get("isError").and_then(serde_json::Value::as_bool).unwrap_or(false)
                        {
                            let id = ev
                                .get("toolCallId")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            if let Some(abs) = pending_paths.remove(&id) {
                                let _ = app2.emit("fs:changed", json!({"path": abs}));
                            }
                        }
                        if mode != AiMode::Suggest && CONTROLLED_TOOLS.contains(&tool) {
                            let tool_call_id = ev
                                .get("toolCallId")
                                .and_then(serde_json::Value::as_str)
                                .unwrap_or("")
                                .to_string();
                            let is_error = ev.get("isError").and_then(serde_json::Value::as_bool).unwrap_or(false);
                            // 结果正文：优先 result.content[0].text；错误时回退 errorMessage
                            let result = ev
                                .get("result")
                                .and_then(|r| r.get("content"))
                                .and_then(|c| c.as_array())
                                .and_then(|arr| arr.first())
                                .and_then(|b| b.get("text"))
                                .and_then(serde_json::Value::as_str)
                                .or_else(|| ev.get("errorMessage").and_then(serde_json::Value::as_str))
                                .unwrap_or(if is_error { "动作执行失败" } else { "" })
                                .to_string();
                            let _ = app2.emit(
                                &event,
                                json!({"type": "actionEnd", "toolCallId": tool_call_id, "tool": tool, "isError": is_error, "result": result}),
                            );
                        }
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
                    // 扩展 UI 请求：`AISHELL_APPROVAL:` confirm 转发前端审批；
                    // `AISHELL_ACTION:` input 为内部动作桥，就地执行并回写（不透传前端）。
                    "extension_ui_request" => {
                        handle_extension_ui_request(
                            &ev,
                            &event,
                            &app2,
                            &stdin2,
                            &approvals2,
                            &actions,
                            &store2,
                            &project_id2,
                            &session_id2,
                            &mut impact_tracker,
                            &mut rt,
                        );
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
            .insert(
                key.to_string(),
                AiProc {
                    child,
                    stdin,
                    busy,
                    killed,
                    approvals,
                    skill_fingerprint: loaded.fingerprint,
                },
            );
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

/// 处理 pi 发来的 extension_ui_request（审批转发 + 内部动作桥）。
#[allow(clippy::too_many_arguments)]
fn handle_extension_ui_request(
    ev: &serde_json::Value,
    event: &str,
    app2: &AppHandle,
    stdin2: &Arc<Mutex<ChildStdin>>,
    approvals2: &Arc<Mutex<HashMap<String, String>>>,
    actions: &Arc<AiActions>,
    store2: &Arc<Store>,
    project_id: &str,
    session_id: &str,
    impact_tracker: &mut HashMap<String, ImpactEntry>,
    rt: &mut Option<tokio::runtime::Runtime>,
) {
    let Some(id) = ev.get("id").and_then(serde_json::Value::as_str).map(str::to_string) else {
        return;
    };
    let method = ev.get("method").and_then(serde_json::Value::as_str).unwrap_or("");
    let title = ev.get("title").and_then(serde_json::Value::as_str).unwrap_or("");

    if method == "input" && title.starts_with("AISHELL_ACTION:") {
        // 内部动作：执行并回写结果（不透传前端）。
        // ctx.ui.input(title, placeholder) → extension_ui_request 的默认值在 placeholder 字段
        let tool_call_id = title["AISHELL_ACTION:".len()..].to_string();
        let payload: serde_json::Value = ev
            .get("placeholder")
            .and_then(serde_json::Value::as_str)
            .and_then(|m| serde_json::from_str(m).ok())
            .unwrap_or_else(|| json!({}));
        let runtime = rt.get_or_insert_with(|| {
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("创建动作执行 runtime 失败")
        });
        let result = runtime.block_on(run_internal_action(
            actions,
            store2,
            project_id,
            session_id,
            &tool_call_id,
            impact_tracker,
            &payload,
        ));
        write_stdin_json(stdin2, &json!({"type": "extension_ui_response", "id": id, "value": result.to_string()}));
    } else if method == "confirm" && title.starts_with("AISHELL_MODE_REQUEST:") {
        // AI 申请切换到工作模式（suggest 模式的 request_agent_mode 工具）：
        // 与审批同通道转发前端（action=request_agent_mode），前端确认后经
        // ai_respond_approval 回复 extension_ui_response(confirmed:true/false)。
        let tool_call_id = title["AISHELL_MODE_REQUEST:".len()..].to_string();
        if let Ok(mut map) = approvals2.lock() {
            map.insert(id.clone(), tool_call_id.clone());
        }
        let reason = ev
            .get("message")
            .and_then(serde_json::Value::as_str)
            .and_then(|m| serde_json::from_str::<serde_json::Value>(m).ok())
            .and_then(|v| v.get("reason").and_then(serde_json::Value::as_str).map(str::to_string))
            .unwrap_or_default();
        let _ = app2.emit(
            event,
            json!({
                "type": "approval",
                "requestId": id,
                "toolCallId": tool_call_id,
                "action": "request_agent_mode",
                "intent": "AI 申请切换到工作模式",
                "summary": reason,
            }),
        );
    } else if method == "confirm" && title.starts_with("AISHELL_APPROVAL:") {
        // 审批：默认登记待处理项并转发前端；智能审批模式下先由 LLM 判定，
        // 非危险直接放行（extension_ui_response confirmed:true，不登记），
        // 危险或判定失败（网络/超时/解析）回退人工审批。
        let tool_call_id = title["AISHELL_APPROVAL:".len()..].to_string();
        let info: serde_json::Value = ev
            .get("message")
            .and_then(serde_json::Value::as_str)
            .and_then(|m| serde_json::from_str(m).ok())
            .unwrap_or_else(|| json!({}));
        let action = info.get("action").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        let intent = info.get("intent").and_then(serde_json::Value::as_str).unwrap_or("").to_string();
        let summary = info.get("summary").and_then(serde_json::Value::as_str).unwrap_or("").to_string();

        // 自动备份开关（决定是否做影响分析与快照）
        let auto_backup = store2.settings().auto_backup_remote_files;
        // 确定性影响计划（审批阶段计算；agent+all 直接采用，agent+smart 与 LLM 合并）
        let mut deterministic_plan: Option<ImpactPlan> = None;
        // 智能审批判定为危险的拦截理由（人工审批卡展示「为何被拦」）
        let mut flagged_reason: Option<String> = None;

        if auto_backup {
            let entry = impact_tracker.get(&tool_call_id).cloned();
            if let Some(entry) = &entry {
                if matches!(entry.tool.as_str(), "run_command" | "sftp_upload") {
                    let runtime = rt.get_or_insert_with(|| {
                        tokio::runtime::Builder::new_current_thread()
                            .enable_all()
                            .build()
                            .expect("创建影响分析 runtime 失败")
                    });
                    let (plan, cwd) = compute_approval_impact(actions, entry, project_id, runtime);
                    if let (Some(_p), Some(c)) = (&plan, &cwd) {
                        if entry.tool == "run_command" {
                            if let Some(e) = impact_tracker.get_mut(&tool_call_id) {
                                e.cwd = Some(c.clone());
                                // 审批/执行绑定指纹（含 cwd）：执行时 payload 不一致直接拒绝
                                let command = e
                                    .payload
                                    .get("command")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("");
                                let target = e
                                    .payload
                                    .get("target")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("");
                                let sid = e
                                    .payload
                                    .get("serverId")
                                    .and_then(serde_json::Value::as_str)
                                    .unwrap_or("");
                                e.fingerprint = Some(impact_fingerprint(command, target, sid, c));
                            }
                        }
                    }
                    if let Some(p) = plan {
                        deterministic_plan = Some(p);
                    }
                }
            }
        }

        // 智能审批判定（影响 unbounded 时即使 LLM 判安全也转人工——「不保证完整备份」）
        if store2.approval_mode() == ApprovalMode::Smart {
            let runtime = rt.get_or_insert_with(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("创建智能审批 runtime 失败")
            });
            let (command, target, server_id, cwd) = approval_context(impact_tracker.get(&tool_call_id), &action);
            let judge_result = runtime.block_on(crate::smart_approval::judge(
                store2, &action, &intent, &summary, &command, &target, &server_id, &cwd,
            ));
            match judge_result {
                Ok(out) => {
                    // LLM 补充的路径分析：格式非法按 unbounded（绝不降级为 none）
                    let effective_plan = match &deterministic_plan {
                        Some(det) => {
                            let llm_plan = match validate_impact_plan(&out.to_plan()) {
                                Ok(p) => p,
                                Err(e) => ImpactPlan::unbounded(&e),
                            };
                            Some(merge_plans(det, &llm_plan))
                        }
                        None => deterministic_plan.clone(),
                    };
                    let merged_unbounded = effective_plan
                        .as_ref()
                        .map(|p| p.effect == Effect::Unbounded)
                        .unwrap_or(false);
                    // 非危险且影响可控（或未启用影响分析）：直接放行
                    if !out.dangerous && !merged_unbounded {
                        write_stdin_json(
                            stdin2,
                            &json!({"type": "extension_ui_response", "id": id, "confirmed": true}),
                        );
                        let mut ev_json = json!({
                            "type": "approval",
                            "requestId": id,
                            "toolCallId": tool_call_id,
                            "action": action,
                            "intent": intent,
                            "summary": summary,
                            "smart": true,
                            "smartReason": out.reason,
                        });
                        if let Some(p) = &effective_plan {
                            ev_json["impact"] = impact_event_json(p);
                            if let Some(e) = impact_tracker.get_mut(&tool_call_id) {
                                e.plan = Some(p.clone());
                            }
                        }
                        let _ = app2.emit(event, ev_json);
                        return;
                    }
                    // 危险 / 影响 unbounded（无法保证完整备份）：照常人工审批
                    if out.dangerous {
                        flagged_reason = Some(out.reason);
                    } else if merged_unbounded {
                        flagged_reason = Some(
                            effective_plan
                                .as_ref()
                                .map(|p| p.reason.clone())
                                .unwrap_or_else(|| "命令影响范围无法完整确定，不保证完整备份".to_string()),
                        );
                    }
                    // 落盘计划（人工确认后执行时消费；unbounded 由用户确认后放行）
                    if let Some(p) = &effective_plan {
                        if let Some(e) = impact_tracker.get_mut(&tool_call_id) {
                            e.plan = Some(p.clone());
                        }
                    }
                }
                // 判定失败：回退人工审批（危险方向保守；失败原因透传前端卡片便于排查）
                Err(e) => {
                    flagged_reason = Some(format!("智能审批判定失败，已转人工（{e}）"));
                    // 确定性计划照常落盘（人工确认后执行时消费）
                    if let Some(p) = &deterministic_plan {
                        if let Some(e) = impact_tracker.get_mut(&tool_call_id) {
                            e.plan = Some(p.clone());
                        }
                    }
                }
            }
        } else {
            // agent + 全部审批：确定性计划直接落盘（卡片展示影响，执行时消费）
            if let Some(p) = &deterministic_plan {
                if let Some(e) = impact_tracker.get_mut(&tool_call_id) {
                    e.plan = Some(p.clone());
                }
            }
        }

        if let Ok(mut map) = approvals2.lock() {
            map.insert(id.clone(), tool_call_id.clone());
        }
        let mut ev_json = json!({
            "type": "approval",
            "requestId": id,
            "toolCallId": tool_call_id,
            "action": action,
            "intent": intent,
            "summary": summary,
            "smartReason": flagged_reason,
        });
        if let Some(p) = &deterministic_plan {
            ev_json["impact"] = impact_event_json(p);
        }
        let _ = app2.emit(event, ev_json);
    }
    // 其余 UI 请求（notify/setStatus 等）不转发也不响应（fire-and-forget）
}

/// 审批上下文：run_command 取命令/目标/服务器/工作目录（LLM 判定输入）；其余动作空串。
fn approval_context(
    entry: Option<&ImpactEntry>,
    action: &str,
) -> (String, String, String, String) {
    if action == "run_command" {
        if let Some(e) = entry {
            let strf = |k: &str| {
                e.payload
                    .get(k)
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("")
                    .to_string()
            };
            return (strf("command"), strf("target"), strf("serverId"), e.cwd.clone().unwrap_or_default());
        }
    }
    (String::new(), String::new(), String::new(), String::new())
}

/// 审批阶段确定性影响计划（run_command 远程 / sftp_upload）：解析远程 cwd 并返回
/// (plan, cwd)。cwd 解析失败返回 (None, None)（执行时再解析、影响不随审批事件展示）。
fn compute_approval_impact(
    actions: &Arc<AiActions>,
    entry: &ImpactEntry,
    project_id: &str,
    runtime: &tokio::runtime::Runtime,
) -> (Option<ImpactPlan>, Option<String>) {
    let strf = |k: &str| {
        entry
            .payload
            .get(k)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match entry.tool.as_str() {
        "run_command" => {
            let command = strf("command");
            let server_id = strf("serverId");
            let cwd = match &entry.cwd {
                Some(c) => Some(c.clone()),
                None => runtime
                    .block_on(actions.remote_home(&server_id))
                    .ok()
                    .filter(|c| !c.is_empty()),
            };
            match &cwd {
                Some(c) => (Some(analyze_remote_command(&command, c)), cwd),
                None => (None, None),
            }
        }
        "sftp_upload" => {
            let server_id = strf("serverId");
            let local_path = strf("localPath");
            let remote_dir = strf("remoteDir");
            let overwrite = entry
                .payload
                .get("overwrite")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let plan = runtime.block_on(actions.upload_impact(
                project_id,
                &server_id,
                &local_path,
                &remote_dir,
                overwrite,
            ));
            match plan {
                Ok(p) => (Some(p), None),
                Err(e) => (Some(ImpactPlan::unbounded(&format!("无法枚举上传覆盖范围：{e}"))), None),
            }
        }
        _ => (None, None),
    }
}

/// 执行扩展内部动作请求，返回回写扩展的结果 JSON（{ok:true,text}|{ok:false,error}）。
/// 会话级暂存动作（staging_*）与 run_command/sftp_upload 的自动备份都以 key 推导的
/// session_id 为准（guard 不暴露任意 project/session 参数）。
#[allow(clippy::too_many_arguments)]
async fn run_internal_action(
    actions: &Arc<AiActions>,
    store: &Arc<Store>,
    project_id: &str,
    session_id: &str,
    tool_call_id: &str,
    impact_tracker: &mut HashMap<String, ImpactEntry>,
    payload: &serde_json::Value,
) -> serde_json::Value {
    let action = payload.get("action").and_then(serde_json::Value::as_str).unwrap_or("");
    let str_field = |k: &str| {
        payload
            .get(k)
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    // 消费登记的计划（tool_execution_start 登记的结构化 args 语义比对；不一致直接拒绝）
    let entry = impact_tracker.remove(tool_call_id);
    if let Some(entry) = &entry {
        if payload_fingerprint(&entry.payload) != payload_fingerprint(payload) {
            return json!({"ok": false, "error": "动作参数与审批不一致，已拒绝执行"});
        }
    }
    let auto_backup = store.settings().auto_backup_remote_files;
    let result = match action {
        "list_servers" => actions
            .list_servers(project_id)
            .map(|text| json!({"ok": true, "text": text})),
        "run_command" => {
            let intent = str_field("intent");
            let command = str_field("command");
            let target = str_field("target");
            let server_id = payload
                .get("serverId")
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let timeout_seconds = match payload.get("timeoutSeconds") {
                None => None,
                Some(v) => match v.as_u64() {
                    Some(seconds) => Some(seconds),
                    None => {
                        return json!({
                            "ok": false,
                            "error": "timeoutSeconds 必须是 1–3600 之间的整数秒"
                        });
                    }
                },
            };
            // 执行环境：复用审批阶段解析的工作目录（保证分析与 exec 一致）；无登记时现取
            let (cwd, plan) = resolve_exec_plan(actions, &entry, &command, &target, &server_id, session_id, auto_backup).await;
            let (cwd, plan) = match (cwd, plan) {
                (Ok(c), Ok(p)) => (c, p),
                (Err(e), _) | (_, Err(e)) => {
                    return json!({"ok": false, "error": e});
                }
            };
            // 审批/执行绑定：sha256(command+target+serverId+cwd)（仅审批过的条目）
            if let Some(e) = &entry {
                if let Some(fp) = &e.fingerprint {
                    let sid = server_id.as_deref().unwrap_or("");
                    if impact_fingerprint(&command, &target, sid, &cwd) != *fp {
                        return json!({"ok": false, "error": "命令参数与审批不一致，已拒绝执行"});
                    }
                }
            }
            // yolo + 自动备份 + unbounded：直接拒绝，避免绕过保护（agent 已在审批卡确认放行）
            if auto_backup && plan.effect == Effect::Unbounded && store.ai_mode(project_id) == Some(AiMode::Yolo) {
                return json!({
                    "ok": false,
                    "error": "该命令的影响范围无法完整确定（不保证完整备份），已拒绝自动执行。请改用受管文件操作（sftp_upload 等），或切换到工作模式由用户确认后执行"
                });
            }
            actions
                .run_command(
                    project_id,
                    session_id,
                    intent,
                    command,
                    target,
                    server_id,
                    timeout_seconds,
                    Some(cwd),
                    Some(plan),
                )
                .await
                .map(|r| json!({"ok": true, "text": assemble_command_text(store, r)}))
        }
        "db_query" => {
            let server_id = str_field("serverId");
            let connection_id = str_field("connectionId");
            let command = str_field("command");
            actions
                .db_query(server_id, connection_id, command)
                .await
                .map(|r| json!({"ok": true, "text": assemble_command_text(store, r)}))
        }
        "sftp_upload" => {
            let server_id = str_field("serverId");
            let local_path = str_field("localPath");
            let remote_dir = str_field("remoteDir");
            let overwrite = payload
                .get("overwrite")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let plan = entry.as_ref().and_then(|e| e.plan.clone());
            actions
                .sftp_upload(
                    project_id,
                    session_id,
                    server_id.clone(),
                    local_path.clone(),
                    remote_dir.clone(),
                    overwrite,
                    plan,
                )
                .await
                .map(|text| json!({"ok": true, "text": text}))
        }
        "sftp_download" => {
            let server_id = str_field("serverId");
            let remote_path = str_field("remotePath");
            let local_dir = str_field("localDir");
            actions
                .sftp_download(project_id, server_id.clone(), remote_path.clone(), local_dir.clone())
                .await
                .map(|_| {
                    json!({"ok": true, "text": format!("下载完成：{remote_path} → {local_dir}（服务器 {server_id}）")})
                })
        }
        // AI 暂存工具：只读列表/diff + 还原（force 恒 false）；接受绝不提供
        "staging_list" => actions
            .staging_list(project_id, session_id)
            .await
            .map(|text| json!({"ok": true, "text": text})),
        "staging_diff" => {
            let entry_id = str_field("entryId");
            actions
                .staging_diff(project_id, session_id, &entry_id)
                .await
                .map(|text| json!({"ok": true, "text": text}))
        }
        "staging_restore" => {
            let entry_id = str_field("entryId");
            actions
                .staging_restore(project_id, session_id, &entry_id)
                .await
                .map(|text| json!({"ok": true, "text": text}))
        }
        // 基础工具远程化：read/grep/find/ls/write/edit/delete_path 的 serverId 模式
        // （guard 覆盖版工具经动作桥调用；远程写入/删除的自动备份在 ai_actions 内完成）
        "remote_stat" => {
            let server_id = str_field("serverId");
            let path = str_field("path");
            actions
                .remote_stat(&server_id, &path)
                .await
                .map(|text| json!({"ok": true, "text": text}))
        }
        "remote_read" => {
            let server_id = str_field("serverId");
            let path = str_field("path");
            actions
                .remote_read(&server_id, &path)
                .await
                .map(|bytes| {
                    json!({"ok": true, "b64": base64::engine::general_purpose::STANDARD.encode(bytes)})
                })
        }
        "remote_mkdir" => {
            let server_id = str_field("serverId");
            let dir = str_field("dir");
            actions
                .remote_mkdir(&server_id, &dir)
                .await
                .map(|_| json!({"ok": true, "text": format!("目录已就绪：{dir}")}))
        }
        "remote_write" => {
            let server_id = str_field("serverId");
            let path = str_field("path");
            let content = str_field("content");
            actions
                .remote_write(project_id, session_id, &server_id, &path, &content)
                .await
                .map(|text| json!({"ok": true, "text": text}))
        }
        "remote_listdir" => {
            let server_id = str_field("serverId");
            let path = str_field("path");
            actions
                .remote_listdir(&server_id, &path)
                .await
                .map(|text| json!({"ok": true, "text": text}))
        }
        "remote_glob" => {
            let server_id = str_field("serverId");
            let base = str_field("base");
            let pattern = str_field("pattern");
            let ignore: Vec<String> = payload
                .get("ignore")
                .and_then(serde_json::Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            let limit = payload
                .get("limit")
                .and_then(serde_json::Value::as_u64)
                .unwrap_or(100)
                .max(1) as usize;
            actions
                .remote_glob(&server_id, &base, &pattern, &ignore, limit)
                .await
                .map(|paths| {
                    let text = serde_json::to_string(&paths).unwrap_or_else(|_| "[]".to_string());
                    json!({"ok": true, "text": text})
                })
        }
        "remote_grep" => {
            let server_id = str_field("serverId");
            let pattern = str_field("pattern");
            let path = str_field("path");
            let glob = payload
                .get("glob")
                .and_then(serde_json::Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_string);
            let ignore_case = payload
                .get("ignoreCase")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let literal = payload
                .get("literal")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let context = payload
                .get("context")
                .and_then(serde_json::Value::as_u64)
                .map(|c| c as u32);
            actions
                .remote_grep(
                    &server_id,
                    &pattern,
                    &path,
                    glob.as_deref(),
                    ignore_case,
                    literal,
                    context,
                )
                .await
                .map(|text| json!({"ok": true, "text": text}))
        }
        "remote_delete" => {
            let server_id = str_field("serverId");
            let path = str_field("path");
            actions
                .remote_delete(project_id, session_id, &server_id, &path)
                .await
                .map(|text| json!({"ok": true, "text": text}))
        }
        other => Err(format!("未知动作：{other}")),
    };
    match result {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
    }
}

/// 执行前的 (cwd, plan) 解析：复用审批阶段解析的 cwd / 计划；无则现取现算（yolo 路径）。
async fn resolve_exec_plan(
    actions: &Arc<AiActions>,
    entry: &Option<ImpactEntry>,
    command: &str,
    target: &str,
    server_id: &Option<String>,
    _session_id: &str,
    _auto_backup: bool,
) -> (Result<String, String>, Result<ImpactPlan, String>) {
    if target != "remote" {
        // 本地命令：无远程工作目录/影响分析（run_command 本地分支不使用）
        return (Ok(String::new()), Ok(ImpactPlan::none("本地命令")));
    }
    let sid = match server_id {
        Some(s) => s.clone(),
        None => return (Err("远程目标必须提供 serverId".to_string()), Err("远程目标必须提供 serverId".to_string())),
    };
    match entry {
        Some(e) if e.tool == "run_command" => {
            let cwd = match &e.cwd {
                Some(c) => Ok(c.clone()),
                None => actions.remote_home(&sid).await,
            };
            match cwd {
                Ok(c) => {
                    let plan = e.plan.clone().unwrap_or_else(|| analyze_remote_command(command, &c));
                    (Ok(c), Ok(plan))
                }
                Err(err) => {
                    let e2 = err.clone();
                    (Err(err), Err(e2))
                }
            }
        }
        _ => {
            match actions.remote_home(&sid).await {
                Ok(c) => {
                    let plan = analyze_remote_command(command, &c);
                    (Ok(c), Ok(plan))
                }
                Err(err) => {
                    let e2 = err.clone();
                    (Err(err), Err(e2))
                }
            }
        }
    }
}

/// 命令类结果组装（run_command / db_query 共用）：stdout+stderr → 脱敏 → 截断 → 退出码。
fn assemble_command_text(store: &Arc<Store>, r: crate::ai_actions::CommandResult) -> String {
    let mut text = String::new();
    if !r.stdout.is_empty() {
        text.push_str(&r.stdout);
    }
    if !r.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&r.stderr);
    }
    // 输出脱敏（先于截断）：配置里的密码不进 LLM 上下文，也不进 pi 会话落盘
    let (masked, redacted) = crate::redact::redact_secrets(&text, &store.known_secrets());
    text = masked;
    if redacted > 0 {
        text.push_str(&format!("\n[AIShell：输出含 {redacted} 处凭据，已脱敏；如需凭据请用户手动操作]"));
    }
    if text.len() > MAX_RESULT_CHARS {
        text.truncate(MAX_RESULT_CHARS);
        text.push_str("\n…(输出已截断)");
    }
    if text.is_empty() {
        text = "（命令无输出）".to_string();
    }
    let code = r
        .exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "null".to_string());
    format!("退出码 {code}\n{text}")
}

/// 向 pi stdin 写一条 JSONL（严格单个 LF 结尾；不手拼 JSON）。
fn write_stdin_json(stdin: &Arc<Mutex<ChildStdin>>, value: &serde_json::Value) {    let mut buf = serde_json::to_vec(value).unwrap_or_default();
    buf.push(b'\n');
    if let Ok(mut w) = stdin.lock() {
        let _ = w.write_all(&buf);
    }
}

/// 对该 key 所有待审批项回复 cancelled:true（避免 pi 永久等待）。
fn cancel_approvals(proc: &mut AiProc) {
    let ids: Vec<String> = proc
        .approvals
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .drain()
        .map(|(id, _)| id)
        .collect();
    for id in ids {
        write_stdin_json(
            &proc.stdin,
            &json!({"type": "extension_ui_response", "id": id, "cancelled": true}),
        );
    }
}

/// 提取 `response` 事件里 error 字段原文。
fn err_message(ev: &serde_json::Value) -> String {
    match ev.get("error") {
        Some(v) => v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string()),
        None => "未知错误".to_string(),
    }
}

/// 发送一条 prompt：进程不存在则先 spawn；上一轮未完成（busy）先取消审批并写 abort 再发。
#[tauri::command]
pub async fn ai_chat(mgr: State<'_, Arc<AiManager>>, app: AppHandle, key: String, prompt: String) -> Result<(), String> {
    let project_id = key
        .split_once(':')
        .map(|(p, _)| p.to_string())
        .ok_or_else(|| "key 格式错误，应为 <projectId>:<sessionId>".to_string())?;

    // prompt 脱敏：终端快照/文件引用全文由前端拼入 prompt，可能含配置里读到的凭据；
    // 在进入 pi（及其会话落盘）前屏蔽，命中时附提示防模型误解为「密码为空」而换姿势重读。
    let known = mgr.store.known_secrets();
    let (masked, redacted) = crate::redact::redact_secrets(&prompt, &known);
    let prompt = if redacted > 0 {
        format!("{masked}\n\n[AIShell 提示：以上内容有 {redacted} 处凭据已脱敏，属正常安全机制，请勿尝试绕过获取。]")
    } else {
        masked
    };

    let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
    // 旧进程已死但读取线程尚未摘除时，先清理再重起
    if let Some(p) = procs.get_mut(&key) {
        if let Ok(Some(_)) = p.child.try_wait() {
            procs.remove(&key);
        }
    }
    // 技能快照指纹：UI/AI 修改、启停、增删技能后下一条消息即生效；工作区域切换不影响指纹。
    // 锁外计算（文件 I/O），锁内仅比较。
    let fingerprint = mgr.load_skills(&project_id)?.fingerprint;
    let needs_restart = match procs.get(&key) {
        None => true,
        Some(p) => p.skill_fingerprint != fingerprint,
    };
    if needs_restart {
        // 沿用 kill_keys 的取消审批 + kill/wait + 摘除流程；随后释放锁，按同一 session 文件 spawn
        if let Some(mut old) = procs.remove(&key) {
            cancel_approvals(&mut old);
            old.killed.store(true, Ordering::SeqCst);
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        drop(procs);
        mgr.spawn(&app, &key, &project_id)?;
        procs = mgr.procs.lock().map_err(|e| e.to_string())?;
    }
    let Some(proc) = procs.get_mut(&key) else {
        return Err("pi 进程未就绪".to_string());
    };
    if proc.busy.swap(true, Ordering::SeqCst) {
        cancel_approvals(proc);
        let mut w = proc.stdin.lock().map_err(|e| e.to_string())?;
        w.write_all(b"{\"type\":\"abort\"}\n")
            .map_err(|e| format!("pi 进程已退出: {e}"))?;
    }
    // 用 JSON 序列化生成，勿手拼
    let mut buf = serde_json::to_vec(&json!({"type": "prompt", "message": prompt}))
        .map_err(|e| e.to_string())?;
    buf.push(b'\n');
    proc.stdin
        .lock()
        .map_err(|e| e.to_string())?
        .write_all(&buf)
        .map_err(|e| format!("pi 进程已退出: {e}"))?;
    Ok(())
}

/// 中止当前生成（进程不存在时静默成功）；顺带取消该 key 待审批项。
#[tauri::command]
pub async fn ai_abort(mgr: State<'_, Arc<AiManager>>, key: String) -> Result<(), String> {
    let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
    if let Some(proc) = procs.get_mut(&key) {
        cancel_approvals(proc);
        let mut w = proc.stdin.lock().map_err(|e| e.to_string())?;
        w.write_all(b"{\"type\":\"abort\"}\n")
            .map_err(|e| format!("pi 进程已退出: {e}"))?;
    }
    Ok(())
}

/// pi 运行时诊断信息：前端控制台输出，用于排查安装版资源布局问题。
/// 附带最近一次技能装载中被项目同名技能覆盖的全局技能（避免 pi「同名保留第一个」依赖未声明顺序）。
#[tauri::command]
pub async fn ai_debug_info(mgr: State<'_, Arc<AiManager>>) -> Result<String, String> {
    let covered = mgr
        .covered_skills
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let mut out = mgr.pi_debug.clone();
    if !covered.is_empty() {
        out.push_str(&format!("\n被项目同名技能覆盖的全局技能: {}\n", covered.join(", ")));
    }
    Ok(out)
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
            let _ = proc.stdin.lock().ok().and_then(|mut w| w.write_all(&buf).ok());
        }
    }
    Ok(())
}

/// 原子切换项目 AI 模式：先落盘（store.set_ai_mode），再处理存活 pi 进程。
/// - agent ↔ yolo（同侧）：工具集与系统提示相同，热推 `/aishell-mode <mode>`（扩展命令，
///   流式期间也能立即执行），guard 模式变量即时生效（审批/跳过审批）。
/// - suggest ↔ agent/yolo（跨边界）：pi RPC 模式下模型可见工具集由 spawn 时 --tools 固定
///   （setActiveTools 不影响模型请求），系统提示也不同，无法热切换 → 静默重启该项目全部
///   pi 进程：会话历史经 --session 文件恢复（每 key 固定路径），下次 ai_chat 按新模式惰性
///   重生；生成中的回合被打断，前端在 setAiMode 成功后自行定稿/清理。
#[tauri::command]
pub async fn set_ai_mode(
    mgr: State<'_, Arc<AiManager>>,
    project_id: String,
    mode: String,
) -> Result<(), String> {
    let parsed: AiMode = serde_json::from_str(&format!("\"{mode}\""))
        .map_err(|_| format!("未知 AI 模式: {mode}，可选 suggest|agent|yolo"))?;
    let old = mgr.store.ai_mode(&project_id).unwrap_or_default();
    mgr.store.set_ai_mode(&project_id, parsed)?;
    let on_suggest_side = |m: AiMode| m == AiMode::Suggest;
    if on_suggest_side(old) != on_suggest_side(parsed) {
        mgr.kill_project(&project_id);
        return Ok(());
    }
    let msg = serde_json::to_vec(&json!({
        "type": "prompt",
        "message": format!("/aishell-mode {}", parsed.as_str()),
    }))
    .map_err(|e| format!("aishell-mode 序列化失败: {e}"))?;
    let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
    let prefix = format!("{project_id}:");
    for (key, proc) in procs.iter_mut() {
        if key.starts_with(&prefix) {
            let mut buf = msg.clone();
            buf.push(b'\n');
            // 写失败（进程已死）忽略，读取线程会自行摘除
            let _ = proc.stdin.lock().ok().and_then(|mut w| w.write_all(&buf).ok());
        }
    }
    Ok(())
}

/// 回复待审批动作：仅接受该 key 当前待处理 requestId；重复或过期回复返回中文错误。
/// confirmed=true 回复批准；false 回复拒绝（扩展以「用户拒绝了该操作」阻止工具）。
#[tauri::command]
pub async fn ai_respond_approval(
    mgr: State<'_, Arc<AiManager>>,
    key: String,
    request_id: String,
    confirmed: bool,
) -> Result<(), String> {
    let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
    let Some(proc) = procs.get_mut(&key) else {
        return Err("pi 进程不存在".to_string());
    };
    let mut approvals = proc.approvals.lock().map_err(|e| e.to_string())?;
    let Some(_tool_call_id) = approvals.remove(&request_id) else {
        return Err("审批请求已过期或不存在".to_string());
    };
    drop(approvals);
    let mut w = proc.stdin.lock().map_err(|e| e.to_string())?;
    let mut buf = serde_json::to_vec(&json!({
        "type": "extension_ui_response",
        "id": request_id,
        "confirmed": confirmed,
    }))
    .map_err(|e| e.to_string())?;
    buf.push(b'\n');
    w.write_all(&buf).map_err(|e| format!("pi 进程已退出: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------- tests

#[cfg(test)]
mod tests {
    use super::*;

    fn summary(name: &str, enabled: bool, scope: &[&str], origin: SkillOrigin) -> SkillSummary {
        SkillSummary {
            id: format!("{}:{name}", origin.as_str()),
            name: name.to_string(),
            description: format!("描述 {name}"),
            scope: scope.iter().map(|s| s.to_string()).collect(),
            enabled,
            origin,
            path: format!("C:/skills/{name}/SKILL.md"),
        }
    }

    #[test]
    fn skill_selection_filters_enabled_and_orders() {
        let global = vec![
            summary("z-global", true, &["all"], SkillOrigin::Global),
            summary("a-disabled", false, &["all"], SkillOrigin::Global),
            summary("a-global", true, &["local"], SkillOrigin::Global),
        ];
        let project = vec![
            summary("b-proj", true, &["all"], SkillOrigin::Project),
            summary("a-disabled-proj", false, &["all"], SkillOrigin::Project),
        ];
        let (final_list, covered) = select_enabled_skills(global, project);
        let names: Vec<&str> = final_list.iter().map(|s| s.name.as_str()).collect();
        // 项目在前、全局在后，各组按 name 排序；禁用项不进候选
        assert_eq!(names, vec!["b-proj", "a-global", "z-global"], "顺序/过滤不符: {names:?}");
        assert!(covered.is_empty(), "不应有覆盖");
    }

    #[test]
    fn project_overrides_global_and_disabled_project_restores_global() {
        let global = vec![summary("dup", true, &["all"], SkillOrigin::Global)];
        let project = vec![summary("dup", true, &["local"], SkillOrigin::Project)];
        let (final_list, covered) = select_enabled_skills(global.clone(), project.clone());
        // 同名：项目覆盖全局，只传最终项
        assert_eq!(final_list.len(), 1);
        assert_eq!(final_list[0].origin, SkillOrigin::Project);
        assert_eq!(final_list[0].scope, vec!["local"]);
        assert_eq!(covered.len(), 1);
        assert_eq!(covered[0].name, "dup");
        // 项目同名项被禁用 → 全局启用项恢复加载
        let project_disabled = vec![summary("dup", false, &["local"], SkillOrigin::Project)];
        let (final_list, covered) = select_enabled_skills(global, project_disabled);
        assert_eq!(final_list.len(), 1);
        assert_eq!(final_list[0].origin, SkillOrigin::Global);
        assert!(covered.is_empty(), "禁用项目项不应覆盖全局");
    }

    #[test]
    fn scope_prompt_lists_names_only() {
        assert_eq!(scope_prompt(&[]), "", "空集合不应产生提示区");
        let skills = vec![
            summary("skill-a", true, &["local", "all"], SkillOrigin::Global),
            summary("skill-b", true, &["remote:生产-Web-01"], SkillOrigin::Project),
        ];
        let prompt = scope_prompt(&skills);
        assert!(prompt.contains("skill-a => local, all"), "缺少 skill-a: {prompt}");
        assert!(prompt.contains("skill-b => remote:生产-Web-01"), "缺少 skill-b: {prompt}");
        assert!(prompt.contains("不是权限或加载过滤"), "缺少语义说明");
        assert!(prompt.contains("Server.name"), "缺少 remote 语义");
        // 不得包含技能正文或任意密钥值
        assert!(!prompt.contains("SKILL.md"));
        assert!(!prompt.contains("apiKey") && !prompt.contains("描述"), "提示区泄漏了摘要外内容: {prompt}");
    }

    #[test]
    fn fingerprint_changes_on_scope_or_content_but_not_workdir() {
        let skills = vec![summary("a", true, &["all"], SkillOrigin::Global)];
        let fp1 = skill_fingerprint(&skills, &["正文1".to_string()]);
        // 稳定：同输入同指纹
        assert_eq!(fp1, skill_fingerprint(&skills, &["正文1".to_string()]));
        // scope 改动改变指纹
        let skills_scope = vec![summary("a", true, &["local"], SkillOrigin::Global)];
        assert_ne!(fp1, skill_fingerprint(&skills_scope, &["正文1".to_string()]));
        // 正文改动改变指纹
        assert_ne!(fp1, skill_fingerprint(&skills, &["正文2".to_string()]));
        // enabled 改动改变指纹
        let skills_off = vec![summary("a", false, &["all"], SkillOrigin::Global)];
        assert_ne!(fp1, skill_fingerprint(&skills_off, &["正文1".to_string()]));
        // 指纹不含工作区域：无任何路径/工作区输入（构造已证明）；追加技能改变指纹
        let skills2 = vec![
            summary("a", true, &["all"], SkillOrigin::Global),
            summary("b", true, &["all"], SkillOrigin::Project),
        ];
        assert_ne!(fp1, skill_fingerprint(&skills2, &["正文1".to_string(), "正文2".to_string()]));
        // 同 list 序稳定（skill_fingerprint 固定字段顺序，不依赖 hash 随机性）
        let fp_repeated = skill_fingerprint(&skills2, &["正文1".to_string(), "正文2".to_string()]);
        assert_eq!(fp_repeated, skill_fingerprint(&skills2, &["正文1".to_string(), "正文2".to_string()]));
    }

    #[test]
    fn impact_fingerprint_is_stable_and_input_sensitive() {
        let fp1 = impact_fingerprint("echo x > f", "remote", "srv-a", "/root");
        // 稳定：同输入同指纹
        assert_eq!(fp1, impact_fingerprint("echo x > f", "remote", "srv-a", "/root"));
        // 任一维度变化 → 指纹变化（审批/执行绑定）
        assert_ne!(fp1, impact_fingerprint("echo x > g", "remote", "srv-a", "/root"));
        assert_ne!(fp1, impact_fingerprint("echo x > f", "local", "srv-a", "/root"));
        assert_ne!(fp1, impact_fingerprint("echo x > f", "remote", "srv-b", "/root"));
        assert_ne!(fp1, impact_fingerprint("echo x > f", "remote", "srv-a", "/var/www"));
    }

    #[test]
    fn payload_fingerprint_ignores_bridge_fields() {
        use serde_json::json;
        // 登记 args（tool_execution_start，无 action/sessionId）与动作桥 payload 必须同指纹
        let registered = json!({
            "intent": "清空配置", "command": "cd /var/www/app && : > config.json",
            "target": "remote", "serverId": "srv-a", "timeoutSeconds": 10,
        });
        let bridge = json!({
            "action": "run_command", "intent": "清空配置",
            "command": "cd /var/www/app && : > config.json",
            "target": "remote", "sessionId": "sess-1", "serverId": "srv-a", "timeoutSeconds": 10,
        });
        assert_eq!(payload_fingerprint(&registered), payload_fingerprint(&bridge));
        // 关键字段变化 → 指纹不同（防篡改）
        let tampered = json!({
            "action": "run_command", "command": "cd /var/www/app && : > other.json",
            "target": "remote", "serverId": "srv-a",
        });
        assert_ne!(payload_fingerprint(&registered), payload_fingerprint(&tampered));
        // sftp_upload：登记（无 action/sessionId）与桥 payload 同指纹；overwrite 缺省=false
        let reg_up = json!({ "serverId": "s", "localPath": "a.txt", "remoteDir": "/tmp" });
        let bridge_up = json!({ "action": "sftp_upload", "serverId": "s", "localPath": "a.txt", "remoteDir": "/tmp", "sessionId": "x", "overwrite": false });
        assert_eq!(payload_fingerprint(&reg_up), payload_fingerprint(&bridge_up));
        let overwrite = json!({ "serverId": "s", "localPath": "a.txt", "remoteDir": "/tmp", "overwrite": true });
        assert_ne!(payload_fingerprint(&reg_up), payload_fingerprint(&overwrite));
    }

    #[test]
    fn guard_extension_has_staging_tools_but_never_accept() {
        // 探针：AI 工具清单有 staging_list/diff/restore，绝无 staging_accept（接受只在前端面板）
        assert!(GUARD_EXT.contains("staging_list"), "guard 应注册 staging_list");
        assert!(GUARD_EXT.contains("staging_diff"), "guard 应注册 staging_diff");
        assert!(GUARD_EXT.contains("staging_restore"), "guard 应注册 staging_restore");
        // 探针核心：AI 工具清单/受控列表绝无 staging_accept（引号形态 = 工具/列表注册；
        // 注释里的裸词说明文字不算注册）
        assert!(!GUARD_EXT.contains("\"staging_accept\""), "guard 绝不可注册 staging_accept");
        assert!(!GUARD_EXT.contains("staging_accept\"}"), "guard 绝不可出现 staging_accept 工具定义");
        // 还原属受控工具（逐调用审批）；只读列表/diff 不入审批
        assert!(GUARD_EXT.contains("\"staging_restore\""), "staging_restore 应受控审批");
        // suggest 模式不提供受控远程工具（工具集变量中无 staging_*）
        let tools_suggest = format!("{BASE_TOOLS},request_agent_mode");
        assert!(!tools_suggest.contains("staging_"), "suggest 工具集不应含暂存工具");
        let tools_agent = format!("{BASE_TOOLS},delete_path,run_command,sftp_upload,sftp_download,list_servers,db_query,staging_list,staging_diff,staging_restore");
        assert!(tools_agent.contains("staging_list"));
        assert!(tools_agent.contains("staging_restore"));
        // ai.rs 侧动作卡列表：staging_restore 有卡片，但接受类动作绝不入列
        assert!(CONTROLLED_TOOLS.contains(&"staging_restore"));
        assert!(!CONTROLLED_TOOLS.iter().any(|t| t.contains("staging_accept")));
    }

    #[test]
    fn guard_extension_registers_remote_basic_tool_overrides() {
        // 基础工具远程化探针：guard 必须同名覆盖六基础工具 + delete_path（createXxxTool 工厂），
        // 带 serverId 参数 schema；远程动作经动作桥（remote_*）；suggest 远程调用被阻止
        assert!(GUARD_EXT.contains("createReadTool"), "guard 应覆盖 read");
        assert!(GUARD_EXT.contains("createWriteTool"), "guard 应覆盖 write");
        assert!(GUARD_EXT.contains("createEditTool"), "guard 应覆盖 edit");
        assert!(GUARD_EXT.contains("createLsTool"), "guard 应覆盖 ls");
        assert!(GUARD_EXT.contains("createFindTool"), "guard 应覆盖 find");
        assert!(GUARD_EXT.contains("createGrepTool"), "guard 应覆盖 grep");
        assert!(GUARD_EXT.contains("SERVER_ID_PARAM"), "guard 应定义 serverId 参数");
        assert!(GUARD_EXT.contains("remote_grep"), "grep 远程分支应走 remote_grep 动作");
        assert!(GUARD_EXT.contains("remote_write"), "写远程应经 remote_write 动作");
        assert!(GUARD_EXT.contains("remote_read"), "读远程应经 remote_read 动作");
        assert!(GUARD_EXT.contains("remote_delete"), "远程删除应经 remote_delete 动作");
        // suggest 阻止文案（远程能力仅 agent/yolo）
        assert!(GUARD_EXT.contains("仅建议模式不能操作远程文件"), "suggest 远程调用应被阻止");
        // 覆盖后仍保留本地分支：委托本地实例执行
        assert!(GUARD_EXT.contains("localRead.execute"), "无 serverId 应委托本地 read");
        assert!(GUARD_EXT.contains("localGrep.execute"), "无 serverId 应委托本地 grep");
    }

    #[test]
    fn session_key_derives_project_and_session() {
        // key = "<projectId>:<sessionId>"：会话级暂存以进程 key 为准（guard 不接受任意参数）
        let key = "proj-1:sess_abc";
        let (p, s) = key.split_once(':').unwrap();
        assert_eq!(p, "proj-1");
        assert_eq!(s, "sess_abc");
        // 空 key / 无冒号 → 默认会话（spawn 兜底），但正常路径恒带冒号
        let key2 = "proj-1";
        let s2 = key2.split_once(':').map(|(_, s)| s).unwrap_or("default");
        assert_eq!(s2, "default");
    }
}
