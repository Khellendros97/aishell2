/**
 * AIShell pi 门控扩展 —— 由 src-tauri/src/ai.rs 在每次 spawn 时重写进 agent_dir 并以 -e 加载。
 * 单一权限事实源（禁止另起第二套前端授权规则），三档模式：
 * - suggest：保持现状 —— 读限项目根（+ AISHELL_SKILL_DIRS 技能目录），write/edit 仅
 *   <项目>/.aishell/ 与全局技能根（AISHELL_GLOBAL_SKILLS_DIR），不提供删除/命令/SFTP 工具；
 *   另提供 request_agent_mode 工具（经 `AISHELL_MODE_REQUEST:` confirm 由前端确认后切到工作模式）；
 * - agent  /yolo：读写均限项目根（+ 技能目录），启用 delete_path/run_command/sftp_upload/sftp_download；
 *   模式变化经 RPC prompt `/aishell-mode <suggest|agent|yolo>` 热切换（非法值保持原模式并抛错）。
 *   注意：RPC 模式下 setActiveTools 不影响模型请求的 tools（spawn 时 --tools 固定），
 *   agent ↔ yolo 热推即可；suggest 边界切换由 Rust set_ai_mode 重启进程完成（会话经 --session 恢复）。
 * 基础工具远程化（read/grep/find/ls/write/edit/delete_path 的可选 serverId 参数）：
 * - 同名覆盖注册 createXxxTool(cwd, {operations})，无 serverId 时委托本地实例（行为与内置一致）；
 *   带 serverId 时经假路径映射（path.resolve(cwd, p) 与工具 core 同源）把远程路径还原后
 *   走 AISHELL_ACTION 桥交给 Rust ai_actions 的 remote_* 动作（连接复用 / AI 锁 / 暂存自动备份）。
 * - 仅 agent/yolo 可用：suggest 下 validate() 对带 serverId 的调用直接阻止（提示申请工作模式）。
 * - 远程 grep 无法复用内置 core（强制本地 rg 进程），自定义 execute 走受管模板命令（见 ai_actions）。
 * 技能权限：两个环境变量均为 JSON 数组（AISHELL_SKILL_DIRS = 本次最终启用技能目录清单；
 * AISHELL_GLOBAL_SKILLS_DIR = 全局技能根），解析失败 fail-closed 只保留项目根权限。
 * read/grep/find/ls 允许项目根 + AISHELL_SKILL_DIRS；write/edit 只额外允许全局技能根
 * （项目技能本就在 <项目>/.aishell/skills 范围内），suggest 下全局技能根内写沿用「.aishell 内
 * 可写且无需受控审批」语义；delete_path 仅 agent/yolo 激活并允许全局技能根。绝不因项目技能
 * 覆盖而扩大到其它路径。
 * 审批：agent 对受控工具（write/edit/delete_path/run_command/sftp_upload/sftp_download）
 * 每次调用单独 ctx.ui.confirm（title 固定 `AISHELL_APPROVAL:<toolCallId>`，message 为
 * `{action,intent,summary}`）；yolo 跳过；suggest 即使异常收到变更工具调用也直接阻止。
 * 申请数据库连接（request_db_connection）：工具 execute 内自带 ctx.ui.input
 * （`AISHELL_DB_REQUEST:<toolCallId>`，消息为 `{action,intent,summary,connection}`），
 * 经 Rust 转发前端审批对话框，用户补密码并授权后回执 `{approved,connectionId}`；
 * 不参与逐调用审批/智能审批（授予凭据必须人工填密码），suggest 不提供。
 * 动作执行：delete_path 在扩展内用 Node fs 执行（同一项目根校验）；run_command / sftp_upload /
 * sftp_download 及远程文件工具（remote_*）经 `ctx.ui.input('AISHELL_ACTION:<toolCallId>',
 * JSON.stringify(payload))` 走 RPC extension UI 子协议交给 Rust 的 ai_actions（唯一执行入口，
 * 另有后端硬边界）。
 * 会话级文件暂存（staging_list / staging_diff / staging_restore / staging_add / staging_clear）：
 * 只读列表/diff + 主动暂存（staging_add：文件或目录递归备份，更新补丁前用）+ 还原
 * （agent 下还原逐调用审批）+ 清理无变更条目（staging_clear：只移除远端现状与首次快照一致的
 * 条目，有变更的保留），**不能接受/清除仍有变更的暂存条目**（staging_accept 只在前端面板，
 * 绝不注册为 AI 工具）；project/session 不接受任意参数——后端从当前 pi 进程 key 推导，
 * 扩展仅携带会话身份环境变量。
 * 内置浏览器四件套（browser_open/browser_read/browser_console/browser_screenshot）：只读、
 * 免审批，三档模式都可用（不进 AI_ONLY_TOOLS）；经 AISHELL_ACTION 桥交给 Rust browser.rs 的
 * 共享单实例 webview（后台打开不切面板不抢焦点；截图存 <workspace>/.aishell/tmp/screenshot）。
 * py（本机执行 Python 脚本）：仅 agent/yolo，逐调用审批（受控）；code 内联脚本 / path 项目内
 * .py 文件二选一，经 AISHELL_ACTION 桥（run_py）交 Rust 执行——执行前 Rust 起一次性 SDK 桥
 * （127.0.0.1 ephemeral 端口 + 内存 token，进程结束销毁），脚本内 import aishell 即经此桥
 * 调用 ssh/sftp/数据库能力（用法见内置技能 python-script）。
 * 系统任务上下文（AISHELL_TASK_CONTEXT=1，欢迎页迁移等本地任务）例外：探查类 py 脚本
 * 免逐条审批自动放行；但脚本引用 aishell.config 导入族（写 AIShell 配置）时仍回退人工审批，
 * path 源码读不到同样 fail-closed 回退人工。
 * ask / confirm（通用交互工具，三档模式可用、免审批）：execute 内经 AISHELL_ASK: /
 * AISHELL_CONFIRM: 通道把问题转发前端问答/确认卡片，用户提交后的回答文本/布尔作为
 * 工具结果返回给模型；不进 CONTROLLED_TOOLS（交互即授权，避免双重审批）。
 * 路径处理：path.resolve 归一（相对路径、`..`、绝对路径）后统一小写做前缀比较
 * （Windows 大小写不敏感）；8.3 短文件名等无法归一的形式会因前缀失配被拒（安全方向）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type EditOperations,
	type FindOperations,
	type LsOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const VALID_MODES = ["suggest", "agent", "yolo"] as const;
type AiMode = (typeof VALID_MODES)[number];

/** 仅 agent/yolo 提供的变更工具（suggest 一律拒绝） */
const AI_ONLY_TOOLS = ["delete_path", "run_command", "sftp_upload", "sftp_download", "list_servers", "db_query", "staging_list", "staging_diff", "staging_restore", "staging_add", "staging_clear", "request_db_connection", "py"];
/** agent 模式逐调用审批的受控工具：staging_restore 为远程写操作需审批；
 *  staging_list / staging_diff 只读、staging_add 主动备份（只读远端）/ staging_clear 只清
 *  无变更条目，均不经审批（与 ai.rs CONTROLLED_TOOLS 注释一致，两侧列表已分化）。 */
const CONTROLLED_TOOLS = ["write", "edit", "delete_path", "run_command", "sftp_upload", "sftp_download", "staging_restore", "py"];
/** 单次 AI SFTP 动作最多传输的根项数；目录内部递归仍由后端统一处理。 */
const MAX_SFTP_BATCH_ITEMS = 32;

/** db_query 只读首词（union 表，与 Rust ai_actions::is_db_read_only 语义一致，见 store.rs DbKind::default_read_commands）。
 *  guard 侧无法感知连接类型，故用并集静态分类：命中 → 读（放行）；未命中 → 写（agent 模式人工审批）。
 *  权威白名单校验仍在 Rust（ai_actions::validate_db_command），此处误判最坏只是多一次审批或少一次提示。 */
const DB_READ_KEYWORDS: Record<string, true> = {
	SELECT: true, SHOW: true, DESC: true, DESCRIBE: true, EXPLAIN: true,
	GET: true, MGET: true, KEYS: true, SCAN: true, TYPE: true, TTL: true, PTTL: true,
	EXISTS: true, DBSIZE: true, INFO: true, PING: true, STRLEN: true, LLEN: true,
	SCARD: true, ZCARD: true, HLEN: true, HGET: true, HGETALL: true, HKEYS: true,
	HVALS: true, SMEMBERS: true, LRANGE: true, ZRANGE: true, SISMEMBER: true,
	HEXISTS: true, SRANDMEMBER: true, RANDOMKEY: true, ZSCORE: true, HSTRLEN: true, GETRANGE: true,
};
function isDbReadCommand(command: string): boolean {
	const first = (command.trim().split(/\s+/)[0] || "").toUpperCase();
	return first in DB_READ_KEYWORDS;
}

/** 工具结果统一形态（pi docs：execute 返回 content/details） */
function okResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/* ---------- 基础工具远程化 schema（内置 schema + 可选 serverId） ---------- */
/** serverId 参数：不传 = 本地项目目录操作；仅工作/全自动模式可用（suggest 由 validate 阻止）。 */
const SERVER_ID_PARAM = Type.Optional(
	Type.String({
		description: "目标远程服务器 ID（先用 list_servers 获取；不传则操作本地项目目录；仅工作/全自动模式可用）",
	}),
);
const REMOTE_READ_SCHEMA = Type.Object({
	path: Type.String({ description: "要读取的文件路径（本地为相对项目根的路径；远程为服务器上的绝对或相对路径）" }),
	offset: Type.Optional(Type.Number({ description: "起始行号（1 起始）" })),
	limit: Type.Optional(Type.Number({ description: "最大读取行数" })),
	serverId: SERVER_ID_PARAM,
});
const REMOTE_WRITE_SCHEMA = Type.Object({
	path: Type.String({ description: "要写入的文件路径（本地为相对项目根的路径；远程为服务器上的绝对或相对路径，父目录不存在会自动创建）" }),
	content: Type.String({ description: "写入的完整内容（新文件或整体覆盖）" }),
	serverId: SERVER_ID_PARAM,
});
const REMOTE_EDIT_SCHEMA = Type.Object({
	path: Type.String({ description: "要编辑的文件路径（本地为相对项目根的路径；远程为服务器上的绝对或相对路径）" }),
	edits: Type.Array(
		Type.Object({
			oldText: Type.String({ description: "要替换的精确文本，必须在原文件中唯一且不与同次调用其它编辑重叠" }),
			newText: Type.String({ description: "替换后的文本" }),
		}),
		{ description: "一次或多次精确替换（每项都基于原文件匹配，不是增量匹配）" },
	),
	serverId: SERVER_ID_PARAM,
});
const REMOTE_LS_SCHEMA = Type.Object({
	path: Type.Optional(Type.String({ description: "目录路径（默认当前目录；远程缺省为服务器登录目录）" })),
	limit: Type.Optional(Type.Number({ description: "最大条目数" })),
	serverId: SERVER_ID_PARAM,
});
const REMOTE_FIND_SCHEMA = Type.Object({
	pattern: Type.String({ description: "glob 模式，如 '*.ts' 或 '**/*.spec.ts'" }),
	path: Type.Optional(Type.String({ description: "搜索起始目录（默认当前目录；远程缺省为服务器登录目录）" })),
	limit: Type.Optional(Type.Number({ description: "最大结果数" })),
	serverId: SERVER_ID_PARAM,
});
const SFTP_UPLOAD_ITEM_SCHEMA = Type.Object({
	localPath: Type.String({ description: "本地源路径（项目目录内）" }),
	remoteDir: Type.String({ description: "远端目标目录" }),
	overwrite: Type.Optional(Type.Boolean({ description: "是否覆盖远端同名文件：true 覆盖；默认 false（重名自动创建副本）" })),
});
const SFTP_DOWNLOAD_ITEM_SCHEMA = Type.Object({
	remotePath: Type.String({ description: "远端源路径" }),
	localDir: Type.String({ description: "本地目标目录（项目目录内，必须已存在）" }),
});
// 注意：pi 工具注册器要求参数 schema 顶层必须有 `type:"object"`，因此批量形态
// 不能写成 Type.Union（生成 anyOf、无顶层 type 会被 oai 工具 schema 校验拒绝）。
// 单项字段与 items 并存于同一 Object，运行时按「items 存在 → 批量，否则 → 单项」区分。
const SFTP_UPLOAD_SCHEMA = Type.Object({
	serverId: Type.String({ description: "目标服务器 ID（批量时整批共用）" }),
	localPath: Type.Optional(Type.String({ description: "本地源路径（项目目录内）；与 items 二选一" })),
	remoteDir: Type.Optional(Type.String({ description: "远端目标目录；与 items 二选一" })),
	overwrite: Type.Optional(Type.Boolean({ description: "是否覆盖远端同名文件：true 覆盖；默认 false（重名自动创建副本）" })),
	items: Type.Optional(Type.Array(SFTP_UPLOAD_ITEM_SCHEMA, { minItems: 1, maxItems: MAX_SFTP_BATCH_ITEMS, description: "批量上传项（最多 32 项，优先于单项字段）；每项独立校验并返回结果" })),
});
const SFTP_DOWNLOAD_SCHEMA = Type.Object({
	serverId: Type.String({ description: "源服务器 ID（批量时整批共用）" }),
	remotePath: Type.Optional(Type.String({ description: "远端源路径；与 items 二选一" })),
	localDir: Type.Optional(Type.String({ description: "本地目标目录（项目目录内，必须已存在）；与 items 二选一" })),
	items: Type.Optional(Type.Array(SFTP_DOWNLOAD_ITEM_SCHEMA, { minItems: 1, maxItems: MAX_SFTP_BATCH_ITEMS, description: "批量下载项（最多 32 项，优先于单项字段）；每项独立校验并返回结果" })),
});
const REMOTE_GREP_SCHEMA = Type.Object({
	pattern: Type.String({ description: "搜索模式（正则或字面量）" }),
	path: Type.Optional(Type.String({ description: "搜索目录或文件（默认当前目录；远程缺省为服务器登录目录）" })),
	glob: Type.Optional(Type.String({ description: "按 glob 过滤文件，如 '*.ts'" })),
	ignoreCase: Type.Optional(Type.Boolean({ description: "忽略大小写（默认 false）" })),
	literal: Type.Optional(Type.Boolean({ description: "按字面量匹配而非正则（默认 false）" })),
	context: Type.Optional(Type.Number({ description: "匹配行前后各显示的上下文行数（默认 0）" })),
	limit: Type.Optional(Type.Number({ description: "最大匹配数（远程按输出截断近似生效）" })),
	serverId: SERVER_ID_PARAM,
});

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const root = path.resolve(cwd).toLowerCase();
	const writableRoot = path.join(root, ".aishell");

	const inside = (dirLower: string, targetLower: string): boolean =>
		targetLower === dirLower || targetLower.startsWith(dirLower + path.sep);

	/** 剥掉 Windows verbatim 前缀（`\\?\C:\` → `C:\`、`\\?\UNC\srv\` → `\\srv\`），
	 *  与 path.resolve 的常规输出对齐，避免 Rust canonicalize 的 `\\?\` 形式导致前缀失配误拒。 */
	function stripVerbatim(p: string): string {
		const lower = p.toLowerCase();
		if (lower.startsWith("\\\\?\\unc\\")) return p.slice(8);
		if (lower.startsWith("\\\\?\\")) return p.slice(4);
		return p;
	}

	/** JSON 数组编码的环境变量目录清单（spawn 时由 ai.rs 注入）；解析失败 fail-closed → 空（只保留项目根权限） */
	function envDirs(name: string): string[] {
		try {
			const raw = process.env[name];
			if (!raw) return [];
			const parsed = JSON.parse(raw);
			if (!Array.isArray(parsed)) return [];
			return parsed
				.filter((x): x is string => typeof x === "string" && x.length > 0)
				.map((x) => stripVerbatim(path.resolve(x)).toLowerCase());
		} catch {
			return [];
		}
	}
	/** 全局技能根（write/edit/delete 额外允许；suggest 沿用 .aishell 内可写且无需受控审批的语义） */
	const globalSkillsDir = envDirs("AISHELL_GLOBAL_SKILLS_DIR");
	/** 本次最终加载的启用技能目录清单（read/grep/find/ls 额外允许根，含全局技能目录） */
	const skillDirs = envDirs("AISHELL_SKILL_DIRS");
	/** 笔记根（工作区全局 <workspace>/.aishell/notes）：AI 读/写/列笔记的额外允许目录；工作区未配置时为空 */
	const notesDirs = envDirs("AISHELL_NOTES_DIR");
	const insideAny = (dirs: string[], targetLower: string): boolean =>
		dirs.some((d) => inside(d, targetLower));

	let mode: AiMode = VALID_MODES.includes((process.env.AISHELL_AI_MODE || "") as AiMode)
		? (process.env.AISHELL_AI_MODE as AiMode)
		: "suggest";

	/** 系统任务上下文（欢迎页「从其他 SSH 工具导入」等本地迁移任务）：探查类 py 脚本
	 *  免逐条审批；含 aishell.config 配置写入的脚本仍需人工批准（见 pyNeedsApproval）。 */
	const taskContext = process.env.AISHELL_TASK_CONTEXT === "1";
	/** 命中即视为「写 AIShell 配置」的脚本特征（导入项目/命令/技能/笔记）。 */
	const CONFIG_IMPORT_RE = /from\s+aishell\s+import[^\n]*\bconfig\b|\baishell\s*\.\s*config\b|\bconfig\s*\.\s*import_(project|commands|skill|note)\b/;
	/** 任务上下文 py 免审批判定：仅探查类脚本自动放行；引用配置导入族或源码读不到
	 *  （path 越界/读取失败）时 fail-closed 回退人工审批。 */
	async function pyNeedsApproval(input: Record<string, unknown>): Promise<boolean> {
		let code = typeof input.code === "string" ? input.code : "";
		if (!code && typeof input.path === "string" && input.path.trim()) {
			const abs = path.resolve(cwd, input.path).toLowerCase();
			if (!inside(root, abs)) return true;
			try {
				code = await fs.readFile(abs, "utf8");
			} catch {
				return true;
			}
		}
		return CONFIG_IMPORT_RE.test(code);
	}

	/** 增量切换工具集：只增删本扩展的工具，绝不碰 read/grep/web_search 等既有激活工具。
	 *  注意：RPC 模式下 setActiveTools 不影响模型请求的 tools（pi 限制），初始工具集
	 *  由 Rust spawn 时按模式经 --tools 下发；此处仅作防御与 TUI 模式下的最佳努力。 */
	function applyToolset() {
		let active: string[] = [];
		try {
			active = pi.getActiveTools();
		} catch {
			// 加载早期不可用时跳过；/aishell-mode 再同步（tool_call 钩子始终 fail-closed）
			return;
		}
		if (mode === "suggest") {
			pi.setActiveTools(active.filter((t) => !AI_ONLY_TOOLS.includes(t)));
		} else {
			pi.setActiveTools([...new Set([...active, ...AI_ONLY_TOOLS])]);
		}
	}
	applyToolset();

	/* ---------- /aishell-mode 热切换（Rust set_ai_mode 成功后推送；非法值保持原模式） ---------- */
	pi.registerCommand("aishell-mode", {
		description: "切换 AIShell AI 模式（suggest|agent|yolo）",
		handler: async (args: string | undefined) => {
			const next = (args || "").trim();
			// 非法值：静默保持原模式。注意不能 throw / notify——RPC 模式下会产生
			// extension_error 或挂起后续回合；非法值在 Rust set_ai_mode 处已被拦截。
			if (!VALID_MODES.includes(next as AiMode)) {
				return;
			}
			mode = next as AiMode;
			applyToolset();
		},
	});

	/* ---------- 审批信息（文件操作用明确动作文案；命令用模型提供的 intent） ---------- */
	function approvalInfo(tool: string, input: Record<string, unknown>): { action: string; intent: string; summary: string } {
		const raw = typeof input.path === "string" && input.path.trim() ? input.path : "";
		// 远程模式标注（基础工具 serverId 参数）：审批/动作卡上区分远程操作
		const remote = typeof input.serverId === "string" && input.serverId.trim() ? input.serverId.trim() : "";
		const remoteSuffix = remote ? `（服务器 ${remote}）` : "";
		switch (tool) {
			case "write":
				return {
					action: "write",
					intent: `写${remote ? "远程" : ""}文件 ${raw}${remoteSuffix}`,
					summary: `向 ${raw} 写入内容${remote ? `（服务器 ${remote}，写入前自动备份原文件到会话暂存区）` : ""}`,
				};
			case "edit":
				return {
					action: "edit",
					intent: `编辑${remote ? "远程" : ""}文件 ${raw}${remoteSuffix}`,
					summary: `修改 ${raw} 中的文本${remote ? `（服务器 ${remote}，修改前自动备份原文件到会话暂存区）` : ""}`,
				};
			case "delete_path":
				return {
					action: "delete_path",
					intent: `删除${remote ? "远程" : ""} ${raw}${remoteSuffix}`,
					summary: `${remote ? "远程删除" : "递归删除"} ${raw}${remote ? `（服务器 ${remote}，删除前自动备份原文件到会话暂存区）` : ""}`,
				};
			case "run_command": {
				const intent = typeof input.intent === "string" ? input.intent : "";
				const command = typeof input.command === "string" ? input.command : "";
				const target = input.target === "remote" ? `远程(${String(input.serverId || "")})` : "本地";
				const timeout = typeof input.timeoutSeconds === "number" ? input.timeoutSeconds : 10;
				return { action: "run_command", intent, summary: `执行命令（${target}，超时 ${timeout} 秒）：${command}` };
			}
			case "py": {
				const p = typeof input.path === "string" ? input.path.trim() : "";
				if (p) {
					return {
						action: "py",
						intent: `执行 Python 脚本 ${p}`,
						summary: `py：在本机运行项目内脚本文件 ${p}（脚本可经内置 SDK 调用服务器 SSH/SFTP/数据库能力，SDK 单项调用不再逐次审批）`,
					};
				}
				const code = typeof input.code === "string" ? input.code.trim() : "";
				const lines = code ? code.split("\n") : [];
				const preview = lines.slice(0, 5).join("\n");
				return {
					action: "py",
					intent: `执行内联 Python 脚本（${lines.length} 行）`,
					summary: `py：在本机执行内联 Python 脚本（脚本可经内置 SDK 调用服务器 SSH/SFTP/数据库能力，SDK 单项调用不再逐次审批）：\n${preview}${lines.length > 5 ? "\n…" : ""}`,
				};
			}
				case "sftp_upload": {
					const items = Array.isArray(input.items) ? input.items : [];
					if (items.length > 0) {
						const first = (items[0] || {}) as Record<string, unknown>;
						const overwrite = items.some((item) => (item as Record<string, unknown>)?.overwrite === true);
						return {
							action: "sftp_upload",
							intent: `批量上传 ${items.length} 项${first.localPath ? `（首项：${String(first.localPath)}）` : ""} 到 ${String(first.remoteDir || "")}${overwrite ? "（含覆盖项）" : ""}`,
							summary: `SFTP 批量上传 ${items.length} 项到服务器 ${String(input.serverId || "")}；逐项返回成功或失败结果`,
						};
					}
					return {
						action: "sftp_upload",
						intent: `上传 ${String(input.localPath || "")} 到 ${String(input.remoteDir || "")}${input.overwrite ? "（覆盖同名）" : ""}`,
						summary: `SFTP 上传到服务器 ${String(input.serverId || "")}${input.overwrite ? "（覆盖远端同名文件）" : "（重名自动创建副本）"}`,
					};
				}
				case "sftp_download": {
					const items = Array.isArray(input.items) ? input.items : [];
					if (items.length > 0) {
						const first = (items[0] || {}) as Record<string, unknown>;
						return {
							action: "sftp_download",
							intent: `批量下载 ${items.length} 项${first.remotePath ? `（首项：${String(first.remotePath)}）` : ""} 到 ${String(first.localDir || "")}`,
							summary: `SFTP 批量下载 ${items.length} 项自服务器 ${String(input.serverId || "")}；逐项返回成功或失败结果`,
						};
					}
					return {
						action: "sftp_download",
						intent: `下载 ${String(input.remotePath || "")} 到 ${String(input.localDir || "")}`,
						summary: `SFTP 下载自服务器 ${String(input.serverId || "")}`,
					};
				}

			case "db_query":
				return {
					action: "db_query",
					intent: `数据库写操作（连接 ${String(input.connectionId || "")}，服务器 ${String(input.serverId || "")}）`,
					summary: `db_query：${typeof input.command === "string" ? input.command : ""}`,
				};
			case "staging_list":
				return { action: "staging_list", intent: "查看当前会话文件暂存列表", summary: "staging_list：只读查看暂存区" };
			case "staging_diff":
				return {
					action: "staging_diff",
					intent: `查看暂存条目 diff（${String(input.entryId || "")}）`,
					summary: `staging_diff：查看快照与当前内容差异（entryId=${String(input.entryId || "")}）`,
				};
			case "staging_restore":
				return {
					action: "staging_restore",
					intent: `还原暂存条目（${String(input.entryId || "")}）`,
					summary: `staging_restore：把远程文件还原到首次修改前的内容（entryId=${String(input.entryId || "")}）`,
				};
			case "staging_add":
				return {
					action: "staging_add",
					intent: `主动暂存 ${String(input.remotePath || "")}（服务器 ${String(input.serverId || "")}）`,
					summary: `staging_add：暂存文件/目录到当前会话暂存区（备份）`,
				};
			case "staging_clear":
				return { action: "staging_clear", intent: "清理暂存区无变更条目", summary: "staging_clear：接受并清除远端现状与首次快照一致的条目" };
			default:
				return { action: tool, intent: "执行操作", summary: "" };
		}
	}

	/* ---------- 参数/路径校验（fail-closed；返回 block 或 undefined 放行） ---------- */
	function validate(tool: string, input: Record<string, unknown>): { block: true; reason: string } | undefined {
		const rawPath = (): string => {
			const p = input.path;
			return typeof p === "string" && p.trim() ? p : ".";
		};
		switch (tool) {
			case "read":
			case "grep":
			case "find":
			case "ls": {
				const serverId = typeof input.serverId === "string" ? input.serverId.trim() : "";
				if (serverId) {
					// 远程读：仅 agent/yolo；路径边界由 Rust 侧（服务器 AI 锁 + POSIX 路径校验）把关
					if (mode === "suggest") {
						return { block: true, reason: "AIShell 权限边界:仅建议模式不能操作远程文件，请调用 request_agent_mode 申请切换到工作模式。" };
					}
					const raw = rawPath();
					if (!raw.trim()) {
						return { block: true, reason: `${tool}: 路径不能为空。` };
					}
					return undefined;
				}
				const raw = rawPath();
				const p = path.resolve(cwd, raw);
				const lower = p.toLowerCase();
				// 项目根 + 最终启用技能目录（含全局技能目录；技能正文按绝对 SKILL.md 路径 read）+ 笔记根
				if (!inside(root, lower) && !insideAny(skillDirs, lower) && !insideAny(notesDirs, lower)) {
					return { block: true, reason: `AIShell 权限边界:只能读项目目录内的文件(拒绝:${raw})。` };
				}
				return undefined;
			}
			case "write":
			case "edit": {
				const serverId = typeof input.serverId === "string" ? input.serverId.trim() : "";
				if (serverId) {
					if (mode === "suggest") {
						return { block: true, reason: "AIShell 权限边界:仅建议模式不能操作远程文件，请调用 request_agent_mode 申请切换到工作模式。" };
					}
					const raw = rawPath();
					if (!raw.trim()) {
						return { block: true, reason: `${tool}: 路径不能为空。` };
					}
					return undefined;
				}
				const raw = rawPath();
				const p = path.resolve(cwd, raw);
				const lower = p.toLowerCase();
				const limit = mode === "suggest" ? writableRoot : root;
				// 全局技能根与笔记根内 write/edit 在 suggest 沿用「.aishell 内可写且无需受控审批」语义；
				// agent/yolo 照常由 CONTROLLED_TOOLS 触发审批
				if (!inside(limit, lower) && !insideAny(globalSkillsDir, lower) && !insideAny(notesDirs, lower)) {
					return {
						block: true,
						reason:
							mode === "suggest"
								? `AIShell 权限边界:只能写项目 .aishell/、全局技能目录或笔记目录下的文件(拒绝:${raw})。修改项目文件请改为在回复中输出命令卡,让用户在终端执行。`
								: `AIShell 权限边界:只能写项目目录、全局技能目录或笔记目录内的文件(拒绝:${raw})。`,
					};
				}
				return undefined;
			}
			case "delete_path": {
				const serverId = typeof input.serverId === "string" ? input.serverId.trim() : "";
				if (serverId) {
					if (mode === "suggest") {
						return { block: true, reason: "AIShell 权限边界:仅建议模式不能操作远程文件，请调用 request_agent_mode 申请切换到工作模式。" };
					}
					const raw = rawPath();
					if (!raw.trim()) {
						return { block: true, reason: `${tool}: 路径不能为空。` };
					}
					return undefined;
				}
				const raw = rawPath();
				const p = path.resolve(cwd, raw);
				const lower = p.toLowerCase();
				// 项目根 + 全局技能根（仅 agent/yolo 激活 delete_path；suggest 无删除工具）
				if (!inside(root, lower) && !insideAny(globalSkillsDir, lower)) {
					return { block: true, reason: `AIShell 权限边界:只能删除项目目录或全局技能目录内的文件或目录(拒绝:${raw})。` };
				}
				return undefined;
			}
			case "run_command": {
				const intent = typeof input.intent === "string" ? input.intent.trim() : "";
				const command = typeof input.command === "string" ? input.command.trim() : "";
				if (!intent) return { block: true, reason: "run_command: intent 不能为空，请说明命令意图。" };
				if (!command) return { block: true, reason: "run_command: command 不能为空。" };
				if (input.target === "remote" && !(typeof input.serverId === "string" && input.serverId.trim())) {
					return { block: true, reason: "run_command: 远程目标必须提供 serverId。" };
				}
				if (input.target === "local" && typeof input.serverId === "string" && input.serverId.trim()) {
					return { block: true, reason: "run_command: 本地目标不得使用 serverId。" };
				}
				if (input.timeoutSeconds !== undefined
					&& !(Number.isInteger(input.timeoutSeconds) && Number(input.timeoutSeconds) >= 1 && Number(input.timeoutSeconds) <= 3600)) {
					return { block: true, reason: "run_command: timeoutSeconds 必须是 1–3600 之间的整数秒。" };
				}
				return undefined;
			}
				case "sftp_upload": {
					const serverId = typeof input.serverId === "string" ? input.serverId.trim() : "";
					if (!serverId) return { block: true, reason: "sftp_upload: 缺少 serverId。" };
					const items = Array.isArray(input.items) ? input.items : [{ localPath: input.localPath, remoteDir: input.remoteDir, overwrite: input.overwrite }];
					if (items.length === 0 || items.length > MAX_SFTP_BATCH_ITEMS) return { block: true, reason: `sftp_upload: items 必须包含 1–${MAX_SFTP_BATCH_ITEMS} 项。` };
					for (const [index, raw] of items.entries()) {
						const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
						const localPath = typeof item.localPath === "string" ? item.localPath.trim() : "";
						const remoteDir = typeof item.remoteDir === "string" ? item.remoteDir.trim() : "";
						if (!localPath) return { block: true, reason: `sftp_upload: 第 ${index + 1} 项 localPath 不能为空。` };
						if (!remoteDir) return { block: true, reason: `sftp_upload: 第 ${index + 1} 项 remoteDir 不能为空。` };
						const p = path.resolve(cwd, localPath);
						if (!inside(root, p.toLowerCase())) return { block: true, reason: `AIShell 权限边界:第 ${index + 1} 项上传源必须在项目目录内(拒绝:${localPath})。` };
					}
					return undefined;
				}
				case "sftp_download": {
					const serverId = typeof input.serverId === "string" ? input.serverId.trim() : "";
					if (!serverId) return { block: true, reason: "sftp_download: 缺少 serverId。" };
					const items = Array.isArray(input.items) ? input.items : [{ remotePath: input.remotePath, localDir: input.localDir }];
					if (items.length === 0 || items.length > MAX_SFTP_BATCH_ITEMS) return { block: true, reason: `sftp_download: items 必须包含 1–${MAX_SFTP_BATCH_ITEMS} 项。` };
					for (const [index, raw] of items.entries()) {
						const item = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
						const remotePath = typeof item.remotePath === "string" ? item.remotePath.trim() : "";
						const localDir = typeof item.localDir === "string" ? item.localDir.trim() : "";
						if (!remotePath) return { block: true, reason: `sftp_download: 第 ${index + 1} 项 remotePath 不能为空。` };
						if (!localDir) return { block: true, reason: `sftp_download: 第 ${index + 1} 项 localDir 不能为空。` };
						const p = path.resolve(cwd, localDir);
						if (!inside(root, p.toLowerCase())) return { block: true, reason: `AIShell 权限边界:第 ${index + 1} 项下载目标必须在项目目录内(拒绝:${localDir})。` };
					}
					return undefined;
				}

			case "web_search":
				// 只读网络调用，无文件路径语义（aishell-search.ts 注册）
				return undefined;
			case "list_servers":
				// 只读查询：项目绑定的可操作服务器列表（无路径参数）
				return undefined;
			case "notes_list":
				// 只读查询：工作区全局笔记清单（目录 + .md 文件，相对路径）；三档模式可用
				return undefined;
			case "db_query": {
				// 仅工作/全自动模式提供；参数校验（白名单权威裁决在 Rust）
				if (mode === "suggest") {
					return { block: true, reason: "AIShell 权限边界:仅建议模式不提供数据库查询。" };
				}
				if (!(typeof input.serverId === "string" && input.serverId.trim())) {
					return { block: true, reason: "db_query: 缺少 serverId。" };
				}
				if (!(typeof input.connectionId === "string" && input.connectionId.trim())) {
					return { block: true, reason: "db_query: 缺少 connectionId。" };
				}
				if (!(typeof input.command === "string" && input.command.trim())) {
					return { block: true, reason: "db_query: command 不能为空。" };
				}
				return undefined;
			}
			case "py": {
				// 本机执行 Python 脚本（可经 SDK 触达远程）：仅 agent/yolo；code/path 恰传其一
				if (mode === "suggest") {
					return { block: true, reason: "AIShell 权限边界:仅建议模式不能执行 Python 脚本，请调用 request_agent_mode 申请切换到工作模式。" };
				}
				const code = typeof input.code === "string" && input.code.trim() ? input.code : "";
				const p = typeof input.path === "string" && input.path.trim() ? input.path : "";
				if (!code && !p) return { block: true, reason: "py: code 与 path 必须传其一。" };
				if (code && p) return { block: true, reason: "py: code 与 path 只能二选一，不能同时传。" };
				if (p) {
					const resolved = path.resolve(cwd, p).toLowerCase();
					if (!inside(root, resolved)) {
						return { block: true, reason: `AIShell 权限边界:脚本文件必须在项目目录内(拒绝:${p})。` };
					}
				}
				if (input.timeoutSeconds !== undefined
					&& !(Number.isInteger(input.timeoutSeconds) && Number(input.timeoutSeconds) >= 1 && Number(input.timeoutSeconds) <= 3600)) {
					return { block: true, reason: "py: timeoutSeconds 必须是 1–3600 之间的整数秒。" };
				}
				return undefined;
			}
			case "staging_list":
				// 只读：当前 pi 会话的暂存区（project/session 由后端从进程 key 推导，不接受任意参数）
				if (mode === "suggest") {
					return { block: true, reason: "AIShell 权限边界:仅建议模式不提供远程文件暂存工具。" };
				}
				return undefined;
			case "staging_diff": {
				if (mode === "suggest") {
					return { block: true, reason: "AIShell 权限边界:仅建议模式不提供远程文件暂存工具。" };
				}
				if (!(typeof input.entryId === "string" && input.entryId.trim())) {
					return { block: true, reason: "staging_diff: 缺少 entryId。" };
				}
				return undefined;
			}
			case "staging_restore": {
				if (mode === "suggest") {
					return { block: true, reason: "AIShell 权限边界:仅建议模式不提供远程文件暂存工具。" };
				}
				if (!(typeof input.entryId === "string" && input.entryId.trim())) {
					return { block: true, reason: "staging_restore: 缺少 entryId。" };
				}
				return undefined;
			}
			case "staging_add": {
				if (mode === "suggest") {
					return { block: true, reason: "AIShell 权限边界:仅建议模式不提供远程文件暂存工具。" };
				}
				if (!(typeof input.serverId === "string" && input.serverId.trim())) {
					return { block: true, reason: "staging_add: 缺少 serverId（先调用 list_servers 获取）。" };
				}
				if (!(typeof input.remotePath === "string" && input.remotePath.trim())) {
					return { block: true, reason: "staging_add: 缺少 remotePath（要暂存的远程文件或目录绝对路径）。" };
				}
				return undefined;
			}
			case "staging_clear": {
				if (mode === "suggest") {
					return { block: true, reason: "AIShell 权限边界:仅建议模式不提供远程文件暂存工具。" };
				}
				return undefined;
			}
			case "browser_open": {
				// 内置浏览器（只读、免审批、三档模式可用）：后台打开指定 URL/本地 HTML
				if (!(typeof input.url === "string" && input.url.trim())) {
					return { block: true, reason: "browser_open: 缺少 url（网页地址或本地 HTML 文件路径）。" };
				}
				return undefined;
			}
			case "browser_read": {
				if (input.selector !== undefined && typeof input.selector !== "string") {
					return { block: true, reason: "browser_read: selector 必须是字符串。" };
				}
				return undefined;
			}
			case "browser_console": {
				if (input.limit !== undefined
					&& (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > 500)) {
					return { block: true, reason: "browser_console: limit 必须是 1–500 之间的整数。" };
				}
				return undefined;
			}
			case "browser_screenshot": {
				return undefined;
			}
			case "ask": {
				// 通用问答工具（三档模式可用、免审批）：只校验问题结构，交互本身即授权
				const qs = input.questions;
				if (!Array.isArray(qs) || qs.length === 0) {
					return { block: true, reason: "ask: questions 至少包含一个问题。" };
				}
				for (const q of qs) {
					const item = q as Record<string, unknown> | null;
					if (!item || !(typeof item.question === "string" && item.question.trim())) {
						return { block: true, reason: "ask: 每个问题都必须包含非空的 question 文本。" };
					}
				}
				return undefined;
			}
			case "confirm": {
				// 通用确认工具（三档模式可用、免审批）：单一是非问题
				if (!(typeof input.question === "string" && input.question.trim())) {
					return { block: true, reason: "confirm: 缺少非空的 question 文本。" };
				}
				return undefined;
			}
			case "request_agent_mode":
				// 仅建议模式专属工具（suggest 的 --tools 白名单才含它）：agent/yolo 下防御性阻止
				if (mode !== "suggest") {
					return { block: true, reason: "AIShell 权限边界:仅建议模式下才可申请切换工作模式。" };
				}
				return undefined;
			case "request_db_connection": {
				// 申请数据库连接：用户需人工补密码并授权（工具 execute 内自带交互，
				// 不参与逐调用审批 / 智能审批）；suggest 无此工具（与 db_query 同边界）
				if (mode === "suggest") {
					return { block: true, reason: "AIShell 权限边界:仅建议模式不能申请数据库连接，请先调用 request_agent_mode 申请切换到工作模式。" };
				}
				if (!(typeof input.serverId === "string" && input.serverId.trim())) {
					return { block: true, reason: "request_db_connection: 缺少 serverId（先调用 list_servers 获取）。" };
				}
				if (!(typeof input.name === "string" && input.name.trim())) {
					return { block: true, reason: "request_db_connection: 缺少连接名称（name）。" };
				}
				if (!(typeof input.kind === "string" && input.kind.trim())) {
					return { block: true, reason: "request_db_connection: 缺少数据库类型（kind）。" };
				}
				if (!(typeof input.host === "string" && input.host.trim())) {
					return { block: true, reason: "request_db_connection: 缺少主机（host，相对服务器，本机库填 127.0.0.1）。" };
				}
				if (input.port !== undefined
					&& !(Number.isInteger(input.port) && Number(input.port) >= 1 && Number(input.port) <= 65535)) {
					return { block: true, reason: "request_db_connection: port 必须是 1–65535 之间的整数。" };
				}
				return undefined;
			}
			default:
				return { block: true, reason: `AIShell 权限边界:工具 ${tool} 不可用。` };
		}
	}

	/* ---------- 工具调用钩子：路径/参数校验 + Agent 逐调用审批 ---------- */
	/** trace 上报（validate 门禁拒绝等 Rust 侧不可见事件）：经 AISHELL_TRACE 桥落日志，失败静默。 */
	function traceReport(ctx: Parameters<typeof pi.on>[1], toolCallId: string, kind: string, detail: string): void {
		void ctx.ui.input("AISHELL_TRACE:" + toolCallId, JSON.stringify({ kind, detail: detail.slice(0, 2000) })).catch(() => {});
	}
	async function approve(ctx: Parameters<typeof pi.on>[1], tool: string, input: Record<string, unknown>, toolCallId: string): Promise<boolean> {
		const info = approvalInfo(tool, input);
		let ok = false;
		try {
			ok = await ctx.ui.confirm("AISHELL_APPROVAL:" + toolCallId, JSON.stringify(info));
		} catch {
			// 中止/窗口卸载/客户端取消（cancelled:true）统一按拒绝
			ok = false;
		}
		return ok;
	}
	pi.on("tool_call", async (event, ctx) => {
		const tool = event.toolName;
		const input = event.input as Record<string, unknown>;
		const blocked = validate(tool, input);
		if (blocked) {
			traceReport(ctx, event.toolCallId, "validate_block", `工具=${tool} 参数=${JSON.stringify(input)} 原因=${blocked.reason}`);
			return blocked;
		}
		if (mode === "agent") {
			if (CONTROLLED_TOOLS.includes(tool)) {
				// 系统任务上下文：探查类 py 脚本免逐条审批（写配置的脚本仍回退人工）
				if (tool === "py" && taskContext && !(await pyNeedsApproval(input))) {
					traceReport(ctx, event.toolCallId, "task_py_auto", "任务上下文探查脚本自动放行（未涉及 AIShell 配置写入）");
				} else if (!(await approve(ctx, tool, input, event.toolCallId))) {
					return { block: true, reason: "用户拒绝了该操作" };
				}
			} else if (tool === "db_query" && !isDbReadCommand(String(input.command || ""))) {
				// 数据库写命令（用户加入白名单的 UPDATE/DELETE 等）：agent 模式人工审批
				if (!(await approve(ctx, tool, input, event.toolCallId))) {
					return { block: true, reason: "用户拒绝了该操作" };
				}
			}
		}
		return undefined;
	});

	/* ---------- 内部动作桥：run_command / sftp_upload / sftp_download / remote_* 交 Rust ai_actions 执行 ---------- */
	/** 桥调用（结果支持 text / b64 两种载荷；remote_read 用 b64 传字节）。 */
	async function rustActionEx(
		ctx: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4],
		toolCallId: string,
		payload: Record<string, unknown>,
	): Promise<{ text?: string; b64?: string }> {
		const raw = await ctx.ui.input("AISHELL_ACTION:" + toolCallId, JSON.stringify(payload));
		if (raw === undefined) throw new Error("操作已被取消");
		let result: { ok?: boolean; text?: string; b64?: string; error?: string };
		try {
			result = JSON.parse(raw);
		} catch {
			throw new Error("动作桥返回了非法结果");
		}
		if (!result.ok) throw new Error(result.error || "动作执行失败");
		return { text: result.text, b64: result.b64 };
	}

	/** 桥调用（文本结果，直接作为工具 content）。 */
	async function rustAction(
		ctx: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4],
		toolCallId: string,
		payload: Record<string, unknown>,
	) {
		const r = await rustActionEx(ctx, toolCallId, payload);
		return okResult(r.text ?? "");
	}

	/* ---------- 基础工具远程化：假路径映射 + 远程 operations ---------- */
	/** 单次工具调用的假路径映射：工具 core 用 path.resolve(cwd, p) 解析路径后传给
	 *  operations，我们用同一确定性计算预建 fake→原始远程路径 的反查表（Windows 键小写）。
	 *  同时登记父目录（write 的 mkdir 语义）。 */
	function makePathMap(remotePath: string): { fake: string; toRemote: (p: string) => string } {
		const map = new Map<string, string>();
		const fake = path.resolve(cwd, remotePath);
		map.set(fake.toLowerCase(), remotePath);
		const parent = remoteParentOf(remotePath);
		if (parent !== null) {
			map.set(path.dirname(fake).toLowerCase(), parent);
		}
		return {
			fake,
			toRemote: (p: string) => map.get(p.toLowerCase()) ?? p,
		};
	}

	/** 远程路径的父目录（POSIX 语义）：无 '/'（单段/根）→ null（无需创建）。 */
	function remoteParentOf(p: string): string | null {
		const t = p.replace(/\/+$/, "");
		const idx = t.lastIndexOf("/");
		if (idx <= 0) return null;
		return t.slice(0, idx) || "/";
	}

	/** 远端 stat（JSON {exists,isDir,size,mtime}）。 */
	async function remoteStat(
		ctx: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4],
		toolCallId: string,
		serverId: string,
		remotePath: string,
	): Promise<{ exists: boolean; isDir: boolean; size: number; mtime: number }> {
		const r = await rustActionEx(ctx, toolCallId, { action: "remote_stat", serverId, path: remotePath });
		return JSON.parse(r.text ?? "{}");
	}

	/** 诊断日志（AISHELL_DEBUG=1 时输出 ops 收到的路径，验证假路径映射；平时静默）。 */
	function debugLog(...args: unknown[]) {
		if (process.env.AISHELL_DEBUG === "1") console.error("[aishell-remote]", ...args);
	}

	function makeRemoteReadOps(
		ctx: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4],
		serverId: string,
		map: { toRemote: (p: string) => string },
		toolCallId: string,
	): ReadOperations {
		return {
			access: async (p) => {
				debugLog("read.access", p, "->", map.toRemote(p));
				const st = await remoteStat(ctx, toolCallId, serverId, map.toRemote(p));
				if (!st.exists) throw new Error(`Path not found: ${p}`);
			},
			readFile: async (p) => {
				debugLog("read.readFile", p, "->", map.toRemote(p));
				const r = await rustActionEx(ctx, toolCallId, {
					action: "remote_read",
					serverId,
					path: map.toRemote(p),
				});
				return Buffer.from(r.b64 ?? "", "base64");
			},
			// 远程暂不支持图片（Rust remote_read 会拒绝二进制）；返回 null 走文本分支
			detectImageMimeType: async () => null,
		};
	}

	function makeRemoteWriteOps(
		ctx: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4],
		serverId: string,
		map: { toRemote: (p: string) => string },
		toolCallId: string,
	): WriteOperations {
		return {
			writeFile: async (p, content) => {
				debugLog("write.writeFile", p, "->", map.toRemote(p));
				await rustActionEx(ctx, toolCallId, {
					action: "remote_write",
					serverId,
					path: map.toRemote(p),
					content,
				});
			},
			mkdir: async (dir) => {
				const remoteDir = map.toRemote(dir);
				if (remoteDir === dir) return; // 未映射（单段相对路径无父目录）→ 无需创建
				debugLog("write.mkdir", dir, "->", remoteDir);
				await rustActionEx(ctx, toolCallId, { action: "remote_mkdir", serverId, dir: remoteDir });
			},
		};
	}

	function makeRemoteEditOps(
		ctx: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4],
		serverId: string,
		map: { toRemote: (p: string) => string },
		toolCallId: string,
	): EditOperations {
		return {
			access: async (p) => {
				debugLog("edit.access", p, "->", map.toRemote(p));
				const st = await remoteStat(ctx, toolCallId, serverId, map.toRemote(p));
				if (!st.exists) throw new Error(`Path not found: ${p}`);
			},
			readFile: async (p) => {
				debugLog("edit.readFile", p, "->", map.toRemote(p));
				const r = await rustActionEx(ctx, toolCallId, {
					action: "remote_read",
					serverId,
					path: map.toRemote(p),
				});
				return Buffer.from(r.b64 ?? "", "base64");
			},
			writeFile: async (p, content) => {
				debugLog("edit.writeFile", p, "->", map.toRemote(p));
				await rustActionEx(ctx, toolCallId, {
					action: "remote_write",
					serverId,
					path: map.toRemote(p),
					content,
				});
			},
		};
	}

	/** 远端 stat 对象（ls core 需要 isDirectory()）。 */
	function statLike(st: { exists: boolean; isDir: boolean; size: number; mtime: number }) {
		return {
			isDirectory: () => st.isDir,
			isFile: () => !st.isDir,
			size: st.size,
			mtime: st.mtime,
		};
	}

	function makeRemoteLsOps(
		ctx: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4],
		serverId: string,
		map: { toRemote: (p: string) => string },
		toolCallId: string,
	): LsOperations {
		// readdir 响应带每个条目的 isDir，缓存供随后的逐条目 stat（免 N 次往返）
		let statCache = new Map<string, { isDir: boolean }>();
		return {
			exists: async (p) => {
				debugLog("ls.exists", p, "->", map.toRemote(p));
				return (await remoteStat(ctx, toolCallId, serverId, map.toRemote(p))).exists;
			},
			stat: async (p) => {
				const cached = statCache.get(p.toLowerCase());
				if (cached) return statLike({ exists: true, isDir: cached.isDir, size: 0, mtime: 0 });
				debugLog("ls.stat", p, "->", map.toRemote(p));
				const st = await remoteStat(ctx, toolCallId, serverId, map.toRemote(p));
				if (!st.exists) throw new Error(`Path not found: ${p}`);
				return statLike(st);
			},
			readdir: async (p) => {
				debugLog("ls.readdir", p, "->", map.toRemote(p));
				const r = await rustActionEx(ctx, toolCallId, {
					action: "remote_listdir",
					serverId,
					path: map.toRemote(p),
				});
				const entries = JSON.parse(r.text ?? "[]") as Array<{ name: string; isDir: boolean }>;
				statCache = new Map();
				for (const e of entries) {
					statCache.set(path.join(p, e.name).toLowerCase(), { isDir: e.isDir });
				}
				return entries.map((e) => e.name);
			},
		};
	}

	function makeRemoteFindOps(
		ctx: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4],
		serverId: string,
		map: { toRemote: (p: string) => string },
		toolCallId: string,
	): FindOperations {
		return {
			exists: async (p) => {
				debugLog("find.exists", p, "->", map.toRemote(p));
				return (await remoteStat(ctx, toolCallId, serverId, map.toRemote(p))).exists;
			},
			glob: async (pattern, searchPath, opts) => {
				debugLog("find.glob", pattern, searchPath, "->", map.toRemote(searchPath));
				const r = await rustActionEx(ctx, toolCallId, {
					action: "remote_glob",
					serverId,
					base: map.toRemote(searchPath),
					pattern,
					ignore: opts?.ignore ?? [],
					limit: opts?.limit ?? 100,
				});
				const rels = JSON.parse(r.text ?? "[]") as string[];
				// 还原成 core 的本地形态路径：core 会把结果相对化展示（startsWith searchPath）
				return rels.map((rel) => path.join(searchPath, rel));
			},
		};
	}

	/* ---------- 自定义工具注册（suggest 下不激活；tool_call 钩子仍兜底拒绝） ---------- */
	pi.registerTool({
		name: "delete_path",
		label: "Delete Path",
		description:
			"删除项目目录或全局技能目录内的文件或目录（递归）。仅限当前项目目录与全局技能根内，越界会被拒绝。可选 serverId 参数删除远程服务器上的文件（仅工作/全自动模式；仅支持文件，目录删除请用 run_command）。",
		promptSnippet: "删除项目内文件",
		promptGuidelines: [
			"使用 delete_path 删除项目内文件或目录时，必须先在回复中说明删除目标与原因。",
			"远程删除（带 serverId）只支持文件；删除远程目录请用 run_command（审批时会展示影响并自动备份）。",
		],
		parameters: Type.Object({
			path: Type.String({ description: "要删除的文件或目录路径（本地相对当前项目根；远程为服务器上的绝对或相对路径）" }),
			serverId: SERVER_ID_PARAM,
		}),
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			const raw = String(params.path || "").trim();
			const serverId = typeof params.serverId === "string" && params.serverId.trim() ? params.serverId.trim() : "";
			if (serverId) {
				// 远程删除：经动作桥（Rust 侧 AI 锁 + 删除前自动备份快照）
				await rustAction(ctx, toolCallId, { action: "remote_delete", serverId, path: raw });
				return okResult(`已删除远程文件：${raw}（服务器 ${serverId}）`);
			}
			const p = path.resolve(cwd, raw);
			const lower = p.toLowerCase();
			if (!inside(root, lower) && !insideAny(globalSkillsDir, lower)) {
				throw new Error(`AIShell 权限边界:只能删除项目目录或全局技能目录内的文件或目录(拒绝:${raw})。`);
			}
			try {
				await fs.rm(p, { recursive: true, force: false });
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === "ENOENT") throw new Error(`删除失败:路径不存在(${raw})`);
				throw new Error(`删除失败:${err instanceof Error ? err.message : String(err)}`);
			}
			return okResult(`已删除 ${raw}`);
		},
	});

	pi.registerTool({
		name: "list_servers",
		label: "List Servers",
		description:
			"查询当前项目绑定的远程服务器列表（serverId、名称、地址、用户、是否被 AI 操作锁锁定）。远程命令/SFTP 前先用它确认可操作的 serverId。",
		promptSnippet: "查询可操作的服务器列表",
		promptGuidelines: [
			"需要远程执行命令或 SFTP 上传下载时，先调用 list_servers 获取可操作的服务器与 serverId；锁定服务器会返回「已锁定」错误。",
		],
		parameters: Type.Object({}),
		async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, { action: "list_servers" });
		},
	});

	pi.registerTool({
		name: "notes_list",
		label: "列出笔记",
		description:
			"查询工作区全局笔记清单：返回笔记绝对根目录（<workspace>/.aishell/notes）与其中的目录、.md 笔记相对路径（按名称排序）。帮助 AI 找到用户可能引用的笔记；拿到笔记相对或绝对路径后，用 read 读取笔记正文（笔记目录已加入读白名单）。",
		promptSnippet: "列出工作区全局笔记",
		promptGuidelines: [
			"用户提到某篇笔记、或需要基于笔记内容作答/创建 Skill 时，先调用 notes_list 拿到笔记清单与绝对根目录，再 read 读取对应 .md 文件正文（read 传 <笔记绝对根目录>/<相对路径>）。",
			"相对路径形如 部署/deploy.md（根为 <workspace>/.aishell/notes）；read 时直接用结果给出的绝对根目录拼接相对路径，避免受当前工作目录影响。",
		],
		parameters: Type.Object({}),
		async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, { action: "notes_list" });
		},
	});

	pi.registerTool({
		name: "run_command",
		label: "Run Command",
		description:
			"在本地 shell（项目根目录）或远程服务器上执行命令，返回 stdout/stderr/退出码。必须提供 intent；默认 10 秒超时，可用 timeoutSeconds（1–3600 秒）覆盖。",
		promptSnippet: "执行本地或远程命令",
		promptGuidelines: [
			"使用 run_command 时，intent 字段必须用一句中文说明本次命令的意图（会展示给用户审批）。",
			"命令默认 10 秒超时；预计超过 10 秒时主动设置合理的 timeoutSeconds（1–3600），不要无界等待。",
			"远程执行（target=remote）需要服务器 ID，且受服务器 AI 操作锁约束；锁定服务器会返回拒绝错误。",
		],
		parameters: Type.Object({
			intent: Type.String({ description: "命令意图（中文，展示给用户审批）" }),
			command: Type.String({ description: "要执行的命令" }),
			target: StringEnum(["local", "remote"] as const),
			serverId: Type.Optional(Type.String({ description: "target=remote 时必填：服务器 ID" })),
			timeoutSeconds: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: 3600,
				description: "命令整体超时秒数；不传默认 10 秒",
			})),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const payload: Record<string, unknown> = {
				action: "run_command",
				intent: params.intent,
				command: params.command,
				target: params.target,
				sessionId: process.env.AISHELL_SESSION_ID || "",
			};
			if (params.serverId) payload.serverId = params.serverId;
			if (params.timeoutSeconds !== undefined) payload.timeoutSeconds = params.timeoutSeconds;
			return await rustAction(ctx, toolCallId, payload);
		},
	});

	pi.registerTool({
		name: "py",
		label: "Python 脚本",
		description:
			"在本机执行 Python 脚本：code 内联脚本或 path 项目内 .py 文件（二选一），args 传命令行参数；默认 60 秒超时，可用 timeoutSeconds（1–3600 秒）覆盖。脚本内可 import aishell 使用内置 SDK：servers.list() 服务器清单、ssh.exec() 远程命令、sftp.* 远程文件操作、db.connections()/db.query() 数据库管道（API 用法见 python-script 技能）。适合批量/程序化操作（遍历多台服务器执行同一命令、批量传输、结果加工）；单次简单操作优先用对应专用工具。",
		promptSnippet: "执行 Python 脚本（可经内置 SDK 调用服务器能力）",
		promptGuidelines: [
			"py 工具适合批量/程序化场景（遍历多台服务器、批量传输、结果加工汇总）；单次简单操作仍优先用 run_command/sftp_upload/db_query 等专用工具。",
			"脚本内 import aishell 使用 SDK 前，先 read 读取 python-script 技能的 SKILL.md 获取 API 用法与示例；SDK 调用受服务器锁与数据库白名单约束，凭据由系统代管、脚本拿不到密码。",
			"脚本默认 60 秒超时；预计更久时主动设置 timeoutSeconds（1–3600）。脚本的 print 输出即工具结果，保持简洁（大输出会被截断）。",
		],
		parameters: Type.Object({
			code: Type.Optional(Type.String({ description: "内联 Python 脚本源码；与 path 二选一（恰传其一）" })),
			path: Type.Optional(Type.String({ description: "项目目录内的 .py 文件路径（相对项目根或绝对路径）；与 code 二选一" })),
			args: Type.Optional(Type.Array(Type.String(), { description: "传给脚本的命令行参数（sys.argv[1:]）" })),
			timeoutSeconds: Type.Optional(Type.Integer({
				minimum: 1,
				maximum: 3600,
				description: "脚本整体超时秒数；不传默认 60 秒",
			})),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const payload: Record<string, unknown> = { action: "run_py" };
			if (params.code) payload.code = params.code;
			if (params.path) payload.path = params.path;
			if (params.args) payload.args = params.args;
			if (params.timeoutSeconds !== undefined) payload.timeoutSeconds = params.timeoutSeconds;
			return await rustAction(ctx, toolCallId, payload);
		},
	});

	pi.registerTool({
		name: "db_query",
		label: "数据库查询",
		description:
			"受管数据库查询（mysql/clickhouse/postgres/redis，凭据由系统代管，AI 拿不到密码）。serverId + connectionId 指定连接，command 为 SQL 或单条 redis 命令。仅允许执行该连接配置白名单内的命令（默认只读：SELECT/SHOW/DESC/EXPLAIN 及 redis 的 GET/KEYS/SCAN 等）；白名单外命令会被拒绝，写命令需用户审批。",
		promptSnippet: "查询数据库",
		promptGuidelines: [
			"查询数据库前先调用 list_servers 获取 serverId；connectionId 从该服务器配置的数据库连接中选择（用户可在服务器设置-数据库连接中查看/配置）。",
			"凭据由系统代管，禁止用 run_command 自行连接数据库、读取配置文件或提取密码。",
			"命令被拒绝时如实说明原因，改用允许的命令重试；不确定允许哪些命令时先问用户。",
		],
		parameters: Type.Object({
			serverId: Type.String({ description: "目标服务器 ID" }),
			connectionId: Type.String({ description: "数据库连接 ID（服务器设置-数据库连接中配置）" }),
			command: Type.String({ description: "SQL 语句或单条 redis 命令（如 SELECT * FROM t LIMIT 10 / GET user:1）" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, {
				action: "db_query",
				serverId: params.serverId,
				connectionId: params.connectionId,
				command: params.command,
			});
		},
	});

	pi.registerTool({
		name: "sftp_upload",
		label: "SFTP Upload",
			description:
				"上传项目目录内的本地文件或目录到远程服务器的指定目录；支持单项字段或 items 数组批量上传（最多 32 项，串行执行并返回逐项结果；默认重名自动创建副本，overwrite=true 时覆盖远端同名文件）。",

		promptSnippet: "上传文件到服务器",
		promptGuidelines: [
				"单项调用时 localPath 必须是当前项目目录内的文件或目录；批量调用时 items 的每个 localPath 都必须在项目目录内，所有项共用 serverId。",
				"更新远端已有文件时传 overwrite=true 直接覆盖，否则会生成副本文件；批量结果逐项返回，部分失败时如实说明，不能声称全部成功。",

		],
			parameters: SFTP_UPLOAD_SCHEMA,

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, {
					action: "sftp_upload",
					serverId: params.serverId,
					...(Array.isArray(params.items)
						? { items: params.items.map((item) => ({ ...item, overwrite: item.overwrite === true })) }
						: { localPath: params.localPath, remoteDir: params.remoteDir, overwrite: params.overwrite === true }),

			});
		},
	});

	/* ---------- 通用交互工具（ask / confirm）：三档模式可用、免审批（交互即授权） ----------
	 *  execute 内经 AISHELL_ASK: / AISHELL_CONFIRM: 通道把问题转发前端卡片，用户提交后
	 *  Rust 经 ai_respond_ask / ai_respond_confirm 回执；回答文本/布尔作为工具结果返回模型。 */
	pi.registerTool({
		name: "ask",
		label: "向用户提问",
		description:
			"向用户提出一个或多个问题并等待回答（一次调用可含多个问题，避免多轮往返）。每个问题可附 2–4 个候选选项供点选；界面会为每个问题自动附带自由输入框，用户可点选选项或直接输入自定义回答。适合需要用户决策或补充信息的场景（方案选择、缺失参数、偏好确认）；用户的回答以「问/答」文本形式作为工具结果返回。",
		promptSnippet: "向用户提问（可一次多问，可带选项）",
		promptGuidelines: [
			"需要用户做决定或补充信息时，用 ask 一次性问清，不要只在回复正文里罗列问题等用户打字回复。",
			"options 只放真实候选答案（2–4 个）；不要放「其他」「由你来指定」之类占位项——界面已为每个问题自动提供自由输入框。",
			"只需用户对单一事项做是/否确认时（如执行前最终确认），改用 confirm 工具。",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "问题正文（中文，一句话说清要用户决定什么）" }),
					options: Type.Optional(Type.Array(Type.String(), { description: "供用户点选的候选答案（2–4 个，简洁）；不要包含「其他/由你指定」类占位项——界面已自动提供自由输入" })),
				}),
				{ minItems: 1, description: "问题列表（一次可提多个）" },
			),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			let raw: string | undefined;
			try {
				raw = await ctx.ui.input(
					"AISHELL_ASK:" + toolCallId,
					JSON.stringify({ questions: params.questions }),
				);
			} catch {
				// 中止/窗口卸载/客户端取消（cancelled:true）统一按取消
				raw = undefined;
			}
			if (raw === undefined || !raw.trim()) {
				return okResult("用户取消了回答（未作答）。请改用其它方式继续，或在回复正文中向用户说明需要哪些信息。");
			}
			return okResult(raw);
		},
	});

	pi.registerTool({
		name: "confirm",
		label: "请求用户确认",
		description:
			"向用户提出单一的是非问题并等待「确认/取消」（如执行前的最终确认、方案是否可行的单一抉择）。工具结果返回用户是否确认。有多个问题或需要选项/补充信息时用 ask 工具。",
		promptSnippet: "请求用户确认（确认/取消）",
		promptGuidelines: [
			"confirm 只用于单一是非确认；question 用一句中文说清要确认什么（可附关键影响）。",
			"用户取消时不要反复重试同一确认，先在回复中说明影响并与用户沟通下一步。",
		],
		parameters: Type.Object({
			question: Type.String({ description: "要用户确认的问题（中文，一句话；可附关键影响说明）" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			let ok = false;
			try {
				ok = await ctx.ui.confirm(
					"AISHELL_CONFIRM:" + toolCallId,
					JSON.stringify({ question: String(params.question || "") }),
				);
			} catch {
				// 中止/窗口卸载/客户端取消（cancelled:true）统一按未确认
				ok = false;
			}
			return okResult(ok
				? "用户已确认。"
				: "用户已取消（未确认）。请停止当前操作，在回复中说明影响并与用户确认下一步。");
		},
	});

	pi.registerTool({
		name: "request_agent_mode",
		label: "申请切换到工作模式",
		description:
			"仅建议模式下使用：向用户申请切换到工作（Agent）模式，需用户同意；用户拒绝则继续提供建议。不可申请切换到全自动（YOLO）模式。",
		promptSnippet: "申请切换到工作模式",
		promptGuidelines: [
			"当你需要执行命令、修改项目源码等仅建议模式无法完成的操作时，先调用 request_agent_mode 用一句中文说明理由，用户同意后即可获得执行类工具。",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "申请理由（中文，展示给用户确认）" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			if (mode !== "suggest") {
				return okResult("当前已是工作/全自动模式，无需申请切换。");
			}
			let ok = false;
			try {
				ok = await ctx.ui.confirm(
					"AISHELL_MODE_REQUEST:" + toolCallId,
					JSON.stringify({ reason: String(params.reason || "") }),
				);
			} catch {
				// 中止/窗口卸载/客户端取消（cancelled:true）统一按拒绝
				ok = false;
			}
			if (!ok) {
				return okResult("用户拒绝了切换到工作模式的申请，请继续以建议方式提供帮助。");
			}
			return okResult("用户已同意切换到工作模式。");
		},
	});

	pi.registerTool({
		name: "request_db_connection",
		label: "申请数据库连接",
		description:
			"向用户申请添加一条受管数据库连接（mysql/clickhouse/postgres/redis）。当任务需要查询数据库、但 list_servers 显示目标服务器没有可用的数据库连接时调用：把已知的连接信息填进参数（serverId 取自 list_servers），用户会在审批对话框中补充密码并勾选查询权限，批准后连接永久保存，工具结果直接返回 connectionId，随后用 db_query 查询。",
		promptSnippet: "申请数据库连接",
		promptGuidelines: [
			"查询数据库前先调用 list_servers 确认目标服务器的 serverId 与既有连接，避免重复申请同一数据库。",
			"主机（host）相对目标服务器：数据库在服务器本机填 127.0.0.1；redis 可不填用户名与默认库。",
			"申请理由（reason）用一句中文说明用途，会展示给用户；被拒绝时不要反复重试，向用户说明需要哪些信息，或请其在「服务器设置-数据库连接」中手动配置。",
			"凭据由系统代管，禁止用 run_command 自行连接数据库、读取配置文件或提取密码。",
		],
		parameters: Type.Object({
			serverId: Type.String({ description: "目标服务器 ID（先调用 list_servers 获取；db_query 经该服务器 SSH 执行客户端）" }),
			name: Type.String({ description: "连接名称（中文，如：计费库）" }),
			kind: StringEnum(["mysql", "clickhouse", "redis", "postgres"] as const),
			host: Type.String({ description: "数据库主机（相对目标服务器；数据库在服务器本机填 127.0.0.1）" }),
			port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535, description: "端口，缺省按类型默认（mysql 3306 / clickhouse 9000 / redis 6379 / postgres 5432）" })),
			user: Type.Optional(Type.String({ description: "用户名（redis 可省略）" })),
			database: Type.Optional(Type.String({ description: "默认库（mysql/clickhouse/postgres 用；redis 忽略）" })),
			reason: Type.String({ description: "申请理由（中文，展示给用户确认）" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const connection: Record<string, unknown> = {
				serverId: params.serverId,
				name: params.name,
				kind: params.kind,
				host: params.host,
				port: typeof params.port === "number" ? params.port : undefined,
				user: typeof params.user === "string" && params.user.trim() ? params.user.trim() : "",
				database: typeof params.database === "string" && params.database.trim() ? params.database.trim() : "",
			};
			// 与审批同通道（input 子协议）转发前端审批对话框；回执为
			// {approved, connectionId?} JSON 串（见 ai.rs ai_respond_db_request）
			let raw: string | undefined;
			try {
				raw = await ctx.ui.input(
					"AISHELL_DB_REQUEST:" + toolCallId,
					JSON.stringify({
						action: "request_db_connection",
						intent: `申请连接数据库 ${params.database || params.name}`,
						summary: String(params.reason || ""),
						connection,
					}),
				);
			} catch {
				// 中止/窗口卸载/客户端取消（cancelled:true）统一按拒绝
				raw = undefined;
			}
			if (raw === undefined) {
				return okResult("用户取消了数据库连接申请，请向用户说明需要哪些信息，或请其在「服务器设置-数据库连接」中手动配置。");
			}
			let result: { approved?: boolean; connectionId?: string };
			try {
				result = JSON.parse(raw);
			} catch {
				return okResult("用户拒绝了数据库连接申请，请向用户说明需要哪些信息，或请其在「服务器设置-数据库连接」中手动配置。");
			}
			if (result.approved && typeof result.connectionId === "string" && result.connectionId) {
				return okResult(
					`用户已批准数据库连接申请（connectionId=${result.connectionId}，名称=${String(params.name)}）。请直接用 db_query 查询（serverId=${String(params.serverId)}）。`,
				);
			}
			return okResult("用户拒绝了数据库连接申请，请向用户说明需要哪些信息，或请其在「服务器设置-数据库连接」中手动配置。");
		},
	});

	pi.registerTool({
		name: "sftp_download",
		label: "SFTP Download",
			description: "从远程服务器下载文件或目录到项目目录内的已有目录；支持单项字段或 items 数组批量下载（最多 32 项，串行执行并返回逐项结果，重名自动改名）。",

		promptSnippet: "从服务器下载文件",
		promptGuidelines: [
				"单项调用时 localDir 必须是项目目录内已存在的目录；批量调用时 items 的每个 localDir 都必须满足该边界，所有项共用 serverId。",
				"批量下载逐项返回成功或失败结果，部分失败时如实说明，不能声称全部成功。",

		],
			parameters: SFTP_DOWNLOAD_SCHEMA,

		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, {
					action: "sftp_download",
					serverId: params.serverId,
					...(Array.isArray(params.items)
						? { items: params.items }
						: { remotePath: params.remotePath, localDir: params.localDir }),

			});
		},
	});

	/* ---------- 内置浏览器（只读、免审批、三档模式可用；后台打开不打扰用户） ---------- */
	pi.registerTool({
		name: "browser_open",
		label: "打开网页",
		description:
			"用内置浏览器在后台打开指定 URL（或本地 HTML 文件路径），等待页面加载完成后返回地址与标题。不切换面板、不抢占用户焦点；用户正停留在浏览器面板时会收到提示。之后可用 browser_read / browser_console / browser_screenshot 读取该页面。",
		promptSnippet: "用内置浏览器打开网页",
		promptGuidelines: [
			"需要查阅网页文档、接口说明或复现用户描述的页面问题时，先用 browser_open 打开，再用 browser_read 读取内容。",
			"本地 HTML 文件可直接传绝对路径（如 D:\\site\\index.html）。",
		],
		parameters: Type.Object({
			url: Type.String({ description: "网页地址（无协议默认 https）或本地 HTML 文件绝对路径" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, { action: "browser_open", url: params.url });
		},
	});

	pi.registerTool({
		name: "browser_read",
		label: "读取浏览器页面",
		description:
			"读取内置浏览器当前页面的正文文本（默认截取前 10000 字符，附页面标题与地址）。可选 selector（CSS 选择器）返回首个匹配元素的完整 HTML——用户对话中的 @browser:{#id 或标签名} 引用给出的名称可直接用作 selector（如 #login、button），便于定位到具体元素。",
		promptSnippet: "读取浏览器当前页面内容",
		promptGuidelines: [
			"查整页内容不带 selector；用户引用了页面元素（@browser: 标签）时，把元素名称作为 selector 读取该元素的完整 HTML 再分析。",
			"页面大量内容在前 10000 字符之外时，可用 selector 按区域（如 main、#content）分段读取。",
		],
		parameters: Type.Object({
			selector: Type.Optional(Type.String({ description: "CSS 选择器；给定时返回首个匹配元素的 outerHTML 而非整页文本" })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const payload: Record<string, unknown> = { action: "browser_read" };
			if (typeof params.selector === "string" && params.selector.trim()) payload.selector = params.selector.trim();
			return await rustAction(ctx, toolCallId, payload);
		},
	});

	pi.registerTool({
		name: "browser_console",
		label: "读取浏览器日志",
		description:
			"读取内置浏览器当前页面最近捕获的 console 输出（log/info/warn/error 与全局未捕获错误；页面加载时自动开始捕获，导航后清空）。默认返回最近 200 条。",
		promptSnippet: "读取浏览器 console 日志",
		promptGuidelines: [
			"排查页面行为异常（脚本报错、接口失败提示）时，结合 browser_read 与 browser_console 一起看。",
		],
		parameters: Type.Object({
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "返回最近多少条，默认 200" })),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			const payload: Record<string, unknown> = { action: "browser_console" };
			if (params.limit !== undefined) payload.limit = params.limit;
			return await rustAction(ctx, toolCallId, payload);
		},
	});

	pi.registerTool({
		name: "browser_screenshot",
		label: "浏览器截图",
		description:
			"对内置浏览器当前页面截图（整页视口 PNG），保存到项目目录 <workspace>/.aishell/tmp/screenshot/ 下（最多保留最新 20 张），返回截图文件的绝对路径。截图是给用户看页面现状用的，你看不到图片内容，需要结合 browser_read 分析。",
		promptSnippet: "截取浏览器当前页面",
		promptGuidelines: [
			"向用户报告页面问题（布局错乱、报错页面等）时截图留证，并在回复中给出截图路径。",
			"你看不到截图内容；分析页面内容请用 browser_read，截图仅供用户核对。",
		],
		parameters: Type.Object({}),
		async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, { action: "browser_screenshot" });
		},
	});

	/* ---------- 会话级远程文件暂存（只读列表/diff + 还原；接受只在前端面板，绝不提供给 AI） ----------
	   project/session 不接受任意参数：后端从当前 pi 进程的 key（<projectId>:<sessionId>）推导，
	   本扩展只把会话身份环境变量一并带上供后端一致性校验。 */
	const sessionCtx = {
		projectId: process.env.AISHELL_PROJECT_ID || "",
		sessionId: process.env.AISHELL_SESSION_ID || "",
	};

	pi.registerTool({
		name: "staging_list",
		label: "查看文件暂存区",
		description:
			"查看当前会话的远程文件暂存列表（自动备份开启时，AI 修改远程文件前已保存原始快照）。返回每个条目的 entryId、服务器、远程路径、原始/当前状态与首次快照时间。",
		promptSnippet: "查看当前会话的文件暂存区",
		promptGuidelines: [
			"远程文件修改（run_command 写入 / sftp_upload 覆盖）前系统会自动暂存原始快照；需要向用户展示改过哪些文件或确认还原目标时调用本工具。",
			"staging_list / staging_diff / staging_restore 都只能作用于当前 AI 会话的暂存区，不接受任意 project/session 参数。",
		],
		parameters: Type.Object({}),
		async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, {
				action: "staging_list",
				projectId: sessionCtx.projectId,
				sessionId: sessionCtx.sessionId,
			});
		},
	});

	pi.registerTool({
		name: "staging_diff",
			label: "查看暂存 diff",
			description:
				"查看某条暂存条目「首次快照 vs 当前内容」的差异（entryId 来自 staging_list）。文本文件仅返回 unified diff 差异块，每块保留前后 3 行上下文；二进制或超大文件返回 hash/size/mtime 元数据。",
			promptSnippet: "查看某个暂存条目的 diff",
			promptGuidelines: [
				"diff 内容已由系统脱敏且仅包含差异块；还原前建议先 diff 确认影响，并向用户说明差异。",
			],
		parameters: Type.Object({
			entryId: Type.String({ description: "暂存条目 ID（staging_list 返回的 entryId）" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, {
				action: "staging_diff",
				entryId: params.entryId,
				projectId: sessionCtx.projectId,
				sessionId: sessionCtx.sessionId,
			});
		},
	});

	pi.registerTool({
		name: "staging_restore",
		label: "还原暂存文件",
		description:
			"把某条暂存条目对应的远程文件还原到首次修改前的内容（entryId 来自 staging_list）。仅限用户明确要求的还原；外部修改冲突时如实报告冲突，不静默覆盖。不能接受（清除）仍有变更的暂存条目。",
		promptSnippet: "还原某个暂存条目",
		promptGuidelines: [
			"还原是远程写操作，Agent 模式需用户审批；仅当用户明确要求还原某文件时才调用。",
			"还原遇到「远程文件已被外部修改」冲突时如实报告，不得声称已还原。",
			"你只能查看、diff、还原暂存条目、主动暂存（staging_add）或清理无变更条目（staging_clear）；接受（清除）仍有变更的暂存由用户在文件暂存区面板操作，调用会被拒绝。",
		],
		parameters: Type.Object({
			entryId: Type.String({ description: "暂存条目 ID（staging_list 返回的 entryId）" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, {
				action: "staging_restore",
				entryId: params.entryId,
				projectId: sessionCtx.projectId,
				sessionId: sessionCtx.sessionId,
			});
		},
	});

	pi.registerTool({
		name: "staging_add",
		label: "主动暂存文件/目录",
		description:
			"把远端文件或目录暂存到当前会话暂存区（保存完整原始快照，可 diff / 还原）。目录会递归暂存全部文件（跳过符号链接）。用于应用更新补丁、批量修改前的主动备份。",
		promptSnippet: "暂存文件/目录作为修改前备份",
		promptGuidelines: [
			"应用更新补丁、批量修改远程文件前，先用 staging_add 把目标文件或目录暂存起来，作为可还原的备份。",
			"目录递归暂存全部文件（上限 2000 个）；已暂存过的路径不会重复存快照（复用原条目）。",
			"staging_add 只读远端内容并保存到本地暂存区，不修改远程文件，无需审批。",
		],
		parameters: Type.Object({
			serverId: Type.String({ description: "服务器 ID（先调用 list_servers 获取）" }),
			remotePath: Type.String({ description: "要暂存的远端文件或目录绝对路径（/ 开头）" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, {
				action: "staging_add",
				serverId: params.serverId,
				remotePath: params.remotePath,
				projectId: sessionCtx.projectId,
				sessionId: sessionCtx.sessionId,
			});
		},
	});

	pi.registerTool({
		name: "staging_clear",
		label: "清理无变更暂存条目",
		description:
			"清理当前会话暂存区中「远端现状与首次快照完全一致」的条目（备份已冗余，自动接受并清除本地记录，不触碰远程内容）；仍有变更或检查失败的条目保留。适合批量修改后清理无用的备份。",
		promptSnippet: "清理暂存区中无变更的条目",
		promptGuidelines: [
			"staging_clear 只清除「远端文件与首次快照完全一致」的条目（此时备份已冗余）；有变更的条目会保留并如实报告。",
			"不能清除仍有变更的暂存条目——那需要用户在文件暂存区面板「接受」操作。",
			"清理后暂存列表会更新；如需还原仍然完整可用的备份不受影响。",
		],
		parameters: Type.Object({}),
		async execute(toolCallId, _params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, {
				action: "staging_clear",
				projectId: sessionCtx.projectId,
				sessionId: sessionCtx.sessionId,
			});
		},
	});

	/* ---------- 基础工具远程化：同名覆盖（无 serverId 委托本地实例，行为与内置一致） ----------
	   覆盖后 promptSnippet/promptGuidelines 不继承内置，description 与指南在此显式重建；
	   远程分支经假路径映射 + AISHELL_ACTION 桥（rustActionEx）执行（ai_actions.rs remote_*）。 */
	const localRead = createReadTool(cwd);
	const localWrite = createWriteTool(cwd);
	const localEdit = createEditTool(cwd);
	const localLs = createLsTool(cwd);
	const localFind = createFindTool(cwd);
	const localGrep = createGrepTool(cwd);

	/** 覆盖版 execute 的远程分支判定：serverId 非空 → 返回该 id，否则 null（本地）。 */
	function remoteCallOf(input: Record<string, unknown>): string | null {
		const sid = typeof input.serverId === "string" ? input.serverId.trim() : "";
		return sid || null;
	}

	pi.registerTool({
		...localRead,
		description:
			localRead.description +
			" 可选 serverId 参数读取远程服务器文件（仅工作/全自动模式；远程路径为服务器上的绝对路径或相对登录目录的相对路径；远程暂不支持二进制/图片）。",
		promptGuidelines: [
			"远程文件用 read（带 serverId）而非 run_command cat——远程读取受限且不绕开受管文件操作。",
		],
		parameters: REMOTE_READ_SCHEMA,
		async execute(id, params, signal, onUpdate, ctx) {
			const serverId = remoteCallOf(params);
			if (serverId) {
				const map = makePathMap(String(params.path ?? "."));
				const tool = createReadTool(cwd, { operations: makeRemoteReadOps(ctx, serverId, map, id) });
				return tool.execute(id, params, signal, onUpdate, ctx);
			}
			return localRead.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localWrite,
		description:
			localWrite.description +
			" 可选 serverId 参数写入远程服务器文件（仅工作/全自动模式；写入/覆盖前自动备份原文件到会话暂存区，可 diff/还原）。",
		promptGuidelines: [
			"远程写文件用 write（带 serverId）而非 run_command echo/tee——工具写入会自动进入暂存自动备份。",
			"远程路径为服务器上的绝对路径或相对登录目录的相对路径；父目录不存在会自动创建。",
		],
		parameters: REMOTE_WRITE_SCHEMA,
		async execute(id, params, signal, onUpdate, ctx) {
			const serverId = remoteCallOf(params);
			if (serverId) {
				const map = makePathMap(String(params.path ?? ""));
				const tool = createWriteTool(cwd, { operations: makeRemoteWriteOps(ctx, serverId, map, id) });
				return tool.execute(id, params, signal, onUpdate, ctx);
			}
			return localWrite.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localEdit,
		description:
			localEdit.description +
			" 可选 serverId 参数编辑远程服务器文件（仅工作/全自动模式；修改前自动备份原文件到会话暂存区，可 diff/还原）。",
		promptGuidelines: [
			"远程改文件用 edit（带 serverId）而非 run_command sed——工具修改会自动进入暂存自动备份。",
			"远程路径为服务器上的绝对路径或相对登录目录的相对路径。",
		],
		parameters: REMOTE_EDIT_SCHEMA,
		async execute(id, params, signal, onUpdate, ctx) {
			const serverId = remoteCallOf(params);
			if (serverId) {
				const map = makePathMap(String(params.path ?? ""));
				const tool = createEditTool(cwd, { operations: makeRemoteEditOps(ctx, serverId, map, id) });
				return tool.execute(id, params, signal, onUpdate, ctx);
			}
			return localEdit.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localLs,
		description: localLs.description + " 可选 serverId 参数列出远程服务器目录（仅工作/全自动模式；远程路径缺省为服务器登录目录）。",
		parameters: REMOTE_LS_SCHEMA,
		async execute(id, params, signal, onUpdate, ctx) {
			const serverId = remoteCallOf(params);
			if (serverId) {
				const map = makePathMap(String(params.path ?? "."));
				const tool = createLsTool(cwd, { operations: makeRemoteLsOps(ctx, serverId, map, id) });
				return tool.execute(id, params, signal, onUpdate, ctx);
			}
			return localLs.execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.registerTool({
		...localFind,
		description:
			localFind.description +
			" 可选 serverId 参数在远程服务器上搜索文件（仅工作/全自动模式；远程路径缺省为服务器登录目录）。",
		parameters: REMOTE_FIND_SCHEMA,
		async execute(id, params, signal, onUpdate, ctx) {
			const serverId = remoteCallOf(params);
			if (serverId) {
				const map = makePathMap(String(params.path ?? "."));
				const tool = createFindTool(cwd, { operations: makeRemoteFindOps(ctx, serverId, map, id) });
				return tool.execute(id, params, signal, onUpdate, ctx);
			}
			return localFind.execute(id, params, signal, onUpdate, ctx);
		},
	});

	// 远程 grep：内置 grep core 强制 spawn 本地 rg，无法复用 → 自定义 execute 走受管模板命令
	// （ai_actions::remote_grep：grep -rn 固定 argv、全参数 shell_quote、只读、30s 超时、输出脱敏）
	pi.registerTool({
		...localGrep,
		description:
			localGrep.description +
			" 可选 serverId 参数在远程服务器上搜索（仅工作/全自动模式；服务器需安装 grep；远程路径缺省为服务器登录目录）。",
		promptGuidelines: [
			"远程搜索用 grep（带 serverId）——只读受管执行，服务器未安装 grep 时降级报错并建议改用 read/find。",
		],
		parameters: REMOTE_GREP_SCHEMA,
		async execute(id, params, signal, onUpdate, ctx) {
			const serverId = remoteCallOf(params);
			if (serverId) {
				const r = await rustActionEx(ctx, id, {
					action: "remote_grep",
					serverId,
					pattern: String(params.pattern ?? ""),
					path: String(params.path ?? "."),
					glob: typeof params.glob === "string" && params.glob.trim() ? params.glob.trim() : undefined,
					ignoreCase: params.ignoreCase === true,
					literal: params.literal === true,
					context: typeof params.context === "number" ? params.context : undefined,
				});
				return okResult(r.text ?? "");
			}
			return localGrep.execute(id, params, signal, onUpdate, ctx);
		},
	});
}
