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
//! 与计划唯一偏差：`procs` 字段为 `Arc<Mutex<HashMap<...>>>`（计划给的是裸 `Mutex`）——
//! 因为 stdout 读取线程必须在进程退出/管道破裂时「从 map 摘除」条目，裸 Mutex 无法被线程共享。
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::ai_actions::AiActions;
use crate::skills::{SkillOrigin, SkillSummary};
use crate::store::{AiMode, ApprovalMode, CloudMode, Store};

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
- db_query：受管数据库查询（mysql/postgres/clickhouse/redis）。参数 serverId + connectionId + command（SQL 或单条 redis 命令）；凭据由系统代管，你**看不到也拿不到密码**。只允许执行该连接配置白名单内的命令（默认只读：SELECT/SHOW/DESC/EXPLAIN、redis 的 GET/KEYS/SCAN 等）；白名单外的命令会被拒绝。用户在白名单中加入的写命令（如 UPDATE/DELETE）需用户人工审批。
- 远程动作受服务器 AI 操作锁约束：锁定服务器会返回「已锁定，AI 无权执行远程操作」错误。
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

/// 需要动作卡 / 审批的受控工具（与 aishell-guard.ts 的 CONTROLLED_TOOLS 保持一致）。
const CONTROLLED_TOOLS: [&str; 6] = [
    "write",
    "edit",
    "delete_path",
    "run_command",
    "sftp_upload",
    "sftp_download",
];

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
    /// 最近一次发送的 user prompt（已脱敏）；读取线程在回合结束时上报记忆沉淀用。
    last_prompt: Arc<Mutex<String>>,
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
    /// 云会话（托管模式记忆沉淀上报用）；测试/个人构建为 None。
    cloud: Option<Arc<crate::cloud::CloudManager>>,
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

/// 托管模式 LLM 代理端点：{serverUrl}/api/proxy/llm/v1（开放 API 文档 §2）。
/// 独立成纯函数便于单测（server_url 来自编译期注入，测试环境不可用）。
fn hosted_llm_base(server_url: &str) -> String {
    format!("{}/api/proxy/llm/v1", server_url.trim_end_matches('/'))
}

impl AiManager {
    pub fn new(
        store: Arc<Store>,
        pi_dir: PathBuf,
        agent_dir: PathBuf,
        ssh: Arc<crate::ssh::SshManager>,
        pi_debug: String,
        cloud: Option<Arc<crate::cloud::CloudManager>>,
    ) -> Self {
        let actions = Arc::new(AiActions::new(Arc::clone(&store), ssh));
        AiManager {
            store,
            pi_dir,
            agent_dir,
            pi_debug,
            procs: Arc::new(Mutex::new(HashMap::new())),
            actions,
            covered_skills: Mutex::new(Vec::new()),
            cloud,
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
        // 托管模式（CR-3.1）：provider 指向公司服务器代理端点，apiKey 用 $AISHELL_CLOUD_TOKEN
        // （spawn 时注入当前 access_token）；个人模式维持现状（本地 baseUrl + $DEEPSEEK_API_KEY）。
        // 已知限制：开放 API 文档 §2.1/§6.6 建议 LLM 请求体顶层携带 sessionId/projectName 以便
        // 服务端按会话聚合自动沉淀记忆，但 pi 的 provider 配置不支持注入任意请求体字段
        // （仅 baseUrl/apiKey/headers，session-affinity 走请求头与 prompt_cache_key，非 body 顶层）。
        // memoryScope 服务端可推断，客户端不传。待云服务端新增「对话历史」专用接口后另行对接
        // （届时由 ai.rs 按 key 的 sessionId 维度上报，见服务端变更）。
        let hosted = self.store.cloud_mode() == CloudMode::Hosted;
        let (base_url, api_key_env) = if hosted {
            let server = crate::cloud::server_url()
                .ok_or_else(|| "当前构建未配置云服务，无法使用托管模式".to_string())?;
            (hosted_llm_base(&server), "$AISHELL_CLOUD_TOKEN")
        } else {
            (
                cfg.base_url.trim_end_matches('/').to_string(),
                "$DEEPSEEK_API_KEY",
            )
        };
        let models = json!({
            "providers": {
                "deepseek": {
                    "baseUrl": base_url,
                    "api": "openai-completions",
                    "apiKey": api_key_env,
                    // 托管模式：云平台服务端不接受 developer role（实测 400 unknown variant），
                    // pi docs models.md：compat.supportsDeveloperRole=false → 系统提示走 system role；
                    // 个人模式保持默认（DeepSeek 官方支持 developer）
                    "compat": if hosted {
                        json!({"supportsDeveloperRole": false})
                    } else {
                        json!({})
                    },
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
    /// `cloud_token`：托管模式下的 access_token（ai_chat 在 spawn 前 async 续期保证未过期）；
    /// 个人模式传 None。
    fn spawn(
        &self,
        app: &AppHandle,
        key: &str,
        project_id: &str,
        cloud_token: Option<String>,
    ) -> Result<(), String> {
        let pi_bin = self.pi_dir.join(PI_BIN_NAME);
        if !pi_bin.is_file() {
            return Err(format!(
                "pi 运行时不存在：{}（安装可能不完整，请重新安装；以下诊断信息可反馈给开发者）\n{}",
                pi_bin.display(),
                self.pi_debug
            ));
        }
        self.write_models_json()?;
        let hosted = self.store.cloud_mode() == CloudMode::Hosted;
        // 托管模式：LLM 走公司服务器代理（token 由调用方续期传入，缺失即登录失效）
        let api_key = if hosted {
            cloud_token.ok_or_else(|| {
                "登录已过期，请前往账号页重新登录后使用公司服务".to_string()
            })?
        } else {
            self.store
                .read_secret("llm:apikey")
                .map_err(|_| "请先在设置中配置 DeepSeek API Key".to_string())?
        };
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
        // 搜索能力：托管模式以服务端能力清单为准（CR-4.3）；个人模式按本地设置。
        // 搜索 key 未配置时不注入 env：工具仍挂载，调用时由扩展返回中文引导错误
        let (search_enabled, brave_key) = if hosted {
            let caps = self.store.cloud_profile().1;
            (caps.map(|c| c.search).unwrap_or(false), None)
        } else {
            (
                self.store.settings().search.enabled,
                self.store.read_secret("brave:apikey").ok(),
            )
        };

        // 初始工具集按模式下发（agent/yolo 直接启用变更工具，避免依赖扩展加载期 setActiveTools）；
        // 热切换仍由 /aishell-mode 命令 + 扩展 applyToolset 增量同步。
        // 注意：RPC 模式下工具集在 spawn 时经 --tools 固定（setActiveTools 不影响模型请求），
        // 跨 suggest 边界切换模式需重启进程（见 set_ai_mode）。
        let mut tools = if mode == AiMode::Suggest {
            format!("{BASE_TOOLS},request_agent_mode")
        } else {
            format!("{BASE_TOOLS},delete_path,run_command,sftp_upload,sftp_download,list_servers,db_query")
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
        cmd.env("PI_CODING_AGENT_DIR", &self.agent_dir)
            .env("AISHELL_AI_MODE", mode.as_str())
            .env("AISHELL_SKILL_DIRS", enc(&skill_dirs))
            .env("AISHELL_GLOBAL_SKILLS_DIR", enc(&global_skills));
        if hosted {
            // 托管模式（CR-3.1 / CR-4.1）：models.json 引用 $AISHELL_CLOUD_TOKEN；
            // 搜索扩展读 $AISHELL_SEARCH_URL + $AISHELL_SEARCH_TOKEN 走公司服务器代理
            cmd.env("AISHELL_CLOUD_TOKEN", &api_key);
            if let Some(server) = crate::cloud::server_url() {
                cmd.env("AISHELL_SEARCH_URL", format!("{server}/api/proxy/search"));
            }
            cmd.env("AISHELL_SEARCH_TOKEN", &api_key);
        } else {
            cmd.env("DEEPSEEK_API_KEY", &api_key);
            if let Some(key) = brave_key {
                cmd.env("BRAVE_API_KEY", key);
            }
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
        let last_prompt = Arc::new(Mutex::new(String::new()));
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
        let store2 = Arc::clone(&self.store);
        let cloud2 = self.cloud.clone();
        let last_prompt2 = Arc::clone(&last_prompt);
        thread::spawn(move || {
            // 已开始执行的 write/edit 工具 → 规范化绝对路径（end 成功时据此发 fs:changed）
            let mut pending_paths: HashMap<String, String> = HashMap::new();
            // 是否已收到过终止性事件（done/error）：正常收尾后退出不再报「异常退出」
            let mut settled = false;
            // 本轮生成是否已发过终态事件（done 或 error 只发一次；turn_start 重置）
            let mut terminal_emitted = false;
            // 当前 assistant 消息是否已流过文本增量（工具来回多段消息时分段用）
            let mut text_started = false;
            // 当前回合 assistant 文本累计（跨工具循环 turn 累积；回合结束上报沉淀后清空）
            let mut turn_text = String::new();
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
                                    turn_text.push_str(delta);
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
                            // 托管模式回合结束：上报本回合对话历史触发云记忆自动沉淀
                            // （服务器按 sessionId 聚合缓冲，客户端只推送、不感知缓存细节）
                            let user = last_prompt2.lock().map(|g| g.clone()).unwrap_or_default();
                            report_sediment(
                                &mut rt,
                                &cloud2,
                                &store2,
                                &project_id2,
                                &key2,
                                &user,
                                &turn_text,
                            );
                            turn_text.clear();
                        }
                    }
                    // 工具活动：受控工具在 agent/yolo 下以动作卡（actionStart/actionEnd）呈现，
                    // 其余工具仍走瞬时小字行（tool）。
                    "tool_execution_start" => {
                        let tool = ev.get("toolName").and_then(serde_json::Value::as_str).unwrap_or("");
                        // write/edit 的目标路径（相对项目根）先登记：end 成功时据此广播 fs:changed
                        if tool == "write" || tool == "edit" {
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
                    last_prompt,
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
        let result = runtime.block_on(run_internal_action(actions, store2, project_id, &payload));
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

        // 智能审批判定为危险的拦截理由（人工审批卡展示「为何被拦」）
        let mut flagged_reason: Option<String> = None;
        if store2.approval_mode() == ApprovalMode::Smart {
            let runtime = rt.get_or_insert_with(|| {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("创建智能审批 runtime 失败")
            });
            let cloud_mgr = app2.state::<Arc<crate::cloud::CloudManager>>();
            match runtime.block_on(crate::smart_approval::judge(
                store2,
                &cloud_mgr,
                &action,
                &intent,
                &summary,
            )) {
                // 非危险：直接放行，并向前端发带 smart 标记的 approval 事件（渲染「已智能放行」卡）
                Ok((false, reason)) => {
                    write_stdin_json(
                        stdin2,
                        &json!({"type": "extension_ui_response", "id": id, "confirmed": true}),
                    );
                    let _ = app2.emit(
                        event,
                        json!({
                            "type": "approval",
                            "requestId": id,
                            "toolCallId": tool_call_id,
                            "action": action,
                            "intent": intent,
                            "summary": summary,
                            "smart": true,
                            "smartReason": reason,
                        }),
                    );
                    return;
                }
                // 危险：照常人工审批，判定理由随事件透传（卡片展示拦截原因）
                Ok((true, reason)) => {
                    flagged_reason = Some(reason);
                }
                // 判定失败：回退人工审批（危险方向保守）
                Err(_) => {}
            }
        }

        if let Ok(mut map) = approvals2.lock() {
            map.insert(id.clone(), tool_call_id.clone());
        }
        let _ = app2.emit(
            event,
            json!({
                "type": "approval",
                "requestId": id,
                "toolCallId": tool_call_id,
                "action": action,
                "intent": intent,
                "summary": summary,
                "smartReason": flagged_reason,
            }),
        );
    }
    // 其余 UI 请求（notify/setStatus 等）不转发也不响应（fire-and-forget）
}

/// 执行扩展内部动作请求，返回回写扩展的结果 JSON（{ok:true,text}|{ok:false,error}）。
async fn run_internal_action(
    actions: &Arc<AiActions>,
    store: &Arc<Store>,
    project_id: &str,
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
            actions
                .run_command(
                    project_id,
                    intent,
                    command,
                    target,
                    server_id,
                    timeout_seconds,
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
            actions
                .sftp_upload(
                    project_id,
                    server_id.clone(),
                    local_path.clone(),
                    remote_dir.clone(),
                    overwrite,
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
        other => Err(format!("未知动作：{other}")),
    };
    match result {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
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

/// 托管模式回合结束：把本回合（脱敏后的 user prompt + assistant 全文）上报云记忆沉淀接口
/// （POST /api/memories/sediment，默认 flush=true；服务器按 sessionId 聚合缓冲去重）。
/// 仅托管模式且云会话存在时上报；失败只记诊断日志，绝不打断对话或影响前端。
fn report_sediment(
    rt: &mut Option<tokio::runtime::Runtime>,
    cloud: &Option<Arc<crate::cloud::CloudManager>>,
    store: &Arc<Store>,
    project_id: &str,
    key: &str,
    user_text: &str,
    assistant_text: &str,
) {
    let Some(cloud) = cloud else { return };
    if store.cloud_mode() != CloudMode::Hosted {
        return;
    }
    let user_text = user_text.trim();
    if user_text.is_empty() {
        return;
    }
    let session_id = key.split_once(':').map(|(_, s)| s.to_string());
    let project_name = store.project(project_id).map(|p| p.name);
    let mut messages = vec![json!({"role": "user", "content": user_text})];
    let assistant = assistant_text.trim();
    if !assistant.is_empty() {
        messages.push(json!({"role": "assistant", "content": assistant}));
    }
    let rt = rt.get_or_insert_with(|| {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("构建记忆沉淀上报 runtime 失败")
    });
    let res = rt.block_on(crate::cloud::sediment_dialogue(
        cloud,
        store,
        messages,
        session_id.as_deref(),
        project_name.as_deref(),
    ));
    if let Err(e) = res {
        crate::term::diag(&format!("[cloud] 记忆沉淀上报失败: {e}"));
    }
}

/// 发送一条 prompt：进程不存在则先 spawn；上一轮未完成（busy）先取消审批并写 abort 再发。
#[tauri::command]
pub async fn ai_chat(
    mgr: State<'_, Arc<AiManager>>,
    cloud: State<'_, Arc<crate::cloud::CloudManager>>,
    app: AppHandle,
    key: String,
    prompt: String,
) -> Result<(), String> {
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

    // 进程就绪检查：guard 限定在块内，避免跨 await 持有（MutexGuard 非 Send）
    let need_spawn = {
        let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
        // 旧进程已死但读取线程尚未摘除时，先清理再重起
        if let Some(p) = procs.get_mut(&key) {
            if let Ok(Some(_)) = p.child.try_wait() {
                procs.remove(&key);
            }
        }
        !procs.contains_key(&key)
    };
    if need_spawn {
        // 托管模式：spawn 前确保 access_token 有效（CR-1.6 请求前续期，避免请求中途 401）；
        // 刷新失败（吊销/禁用）在此返回中文引导错误（CR-3.4）
        let cloud_token = if mgr.store.cloud_mode() == crate::store::CloudMode::Hosted {
            Some(cloud.valid_access_token(&mgr.store).await?)
        } else {
            None
        };
        mgr.spawn(&app, &key, &project_id, cloud_token)?;
    }
    // 进程就绪与技能快照指纹判断：guard 收进块内，await（token 续期/spawn）前全部释放
    // （MutexGuard 非 Send，不能跨 await 持有）。指纹：UI/AI 修改、启停、增删技能后
    // 下一条消息即生效；工作区域切换不影响指纹。
    let needs_restart = {
        let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
        // 旧进程已死但读取线程尚未摘除时，先清理再重起
        if let Some(p) = procs.get_mut(&key) {
            if let Ok(Some(_)) = p.child.try_wait() {
                procs.remove(&key);
            }
        }
        // 锁外计算指纹（文件 I/O），锁内仅比较
        let fingerprint = mgr.load_skills(&project_id)?.fingerprint;
        match procs.get(&key) {
            None => true,
            Some(p) => p.skill_fingerprint != fingerprint,
        }
    };
    if needs_restart {
        // 沿用 kill_keys 的取消审批 + kill/wait + 摘除流程；随后按同一 session 文件 spawn
        {
            let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
            if let Some(mut old) = procs.remove(&key) {
                cancel_approvals(&mut old);
                old.killed.store(true, Ordering::SeqCst);
                let _ = old.child.kill();
                let _ = old.child.wait();
            }
        }
        // 托管模式：spawn 前同样确保 access_token 有效（与首次 spawn 同语义）
        let cloud_token = if mgr.store.cloud_mode() == crate::store::CloudMode::Hosted {
            Some(cloud.valid_access_token(&mgr.store).await?)
        } else {
            None
        };
        mgr.spawn(&app, &key, &project_id, cloud_token)?;
    }
    let mut procs = mgr.procs.lock().map_err(|e| e.to_string())?;
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
    // 记录本次脱敏后的 user prompt：回合结束时读取线程上报记忆沉淀用
    *proc.last_prompt.lock().map_err(|e| e.to_string())? = prompt.clone();
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{test_store, CloudCapabilities, CloudUser};

    fn temp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("aishell-ai-test-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn manager(store: Arc<Store>, tag: &str) -> AiManager {
        let agent_dir = temp_dir(tag);
        AiManager::new(
            store.clone(),
            PathBuf::from("pi-unused"),
            agent_dir,
            Arc::new(crate::ssh::SshManager::new(store)),
            String::new(),
            None, // 测试构造不注入云会话
        )
    }

    /// CR-3.1：托管模式代理端点拼接（serverUrl 可能带尾斜杠，需规范化）。
    #[test]
    fn hosted_llm_base_normalizes_server_url() {
        assert_eq!(
            hosted_llm_base("https://cloud.example.com"),
            "https://cloud.example.com/api/proxy/llm/v1"
        );
        assert_eq!(
            hosted_llm_base("http://localhost:8080/"),
            "http://localhost:8080/api/proxy/llm/v1",
            "尾斜杠应去除，避免双斜杠"
        );
    }

    /// CR-3.1：托管模式但构建未注入 serverUrl → write_models_json 报错（云功能未接入）。
    /// 注：注入源 = 环境变量或 release.env（build.rs），此测试仅在本机无任何注入时成立，
    /// 已由 hosted_llm_base 纯函数测试覆盖拼接语义，此处保留托管态 smoke（编译期行为）。
    #[test]
    fn write_models_json_hosted_mode_smoke() {
        let store = Arc::new(test_store(temp_dir("models-hosted-smoke")));
        store.cloud_set_tokens("acc", "ref").unwrap();
        store
            .cloud_login_info(
                CloudUser {
                    id: None,
                    name: "张三".into(),
                    avatar: None,
                    dept: None,
                },
                CloudCapabilities::default(),
            )
            .unwrap();
        let ai = manager(store, "models-hosted-smoke");
        // 注入存在（本机 release.env）→ 成功写出代理配置；缺失 → 报「未配置云服务」。
        // 两条路径均不 panic，验证托管分支可执行。
        match ai.write_models_json() {
            Ok(()) => {
                let text =
                    std::fs::read_to_string(ai.agent_dir.join("models.json")).unwrap();
                assert!(
                    text.contains("/api/proxy/llm/v1") || text.contains("$AISHELL_CLOUD_TOKEN"),
                    "托管模式应指向代理端点或使用 token env: {text}"
                );
            }
            Err(e) => assert!(e.contains("未配置云服务"), "报错应为未注入: {e}"),
        }
    }

    /// CR-3.1：个人模式 models.json 维持本地 baseUrl + $DEEPSEEK_API_KEY，不含代理痕迹。
    #[test]
    fn write_models_json_personal_keeps_local_config() {
        let store = Arc::new(test_store(temp_dir("models-personal")));
        let ai = manager(store, "models-personal");
        ai.write_models_json().unwrap();
        let text = std::fs::read_to_string(ai.agent_dir.join("models.json")).unwrap();
        assert!(
            text.contains("https://api.deepseek.com/v1"),
            "个人模式 baseUrl 保持本地: {text}"
        );
        assert!(text.contains("$DEEPSEEK_API_KEY"));
        assert!(!text.contains("AISHELL_CLOUD_TOKEN"));
        assert!(!text.contains("/api/proxy/"), "个人模式不应出现代理地址: {text}");
    }

    /// 托管模式不注入无意义类型（构造 smoke：类型可编译、SshManager 空实例可构造）。
    #[test]
    fn manager_constructs_with_cloud_config_types() {
        let store = Arc::new(test_store(temp_dir("smoke")));
        store.cloud_set_mode(crate::store::CloudMode::Hosted).unwrap();
        let _ = manager(store, "smoke");
    }

    // ---------------------------------------------------------------- 技能纯函数测试

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
}
