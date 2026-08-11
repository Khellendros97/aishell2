/**
 * AIShell pi 门控扩展 —— 由 src-tauri/src/ai.rs 在每次 spawn 时重写进 agent_dir 并以 -e 加载。
 * 单一权限事实源（禁止另起第二套前端授权规则），三档模式：
 * - suggest：保持现状 —— 读限项目根，write/edit 仅 <项目>/.aishell/，不提供删除/命令/SFTP 工具；
 *   另提供 request_agent_mode 工具（经 `AISHELL_MODE_REQUEST:` confirm 由前端确认后切到工作模式）；
 * - agent  /yolo：读写均限项目根，启用 delete_path/run_command/sftp_upload/sftp_download；
 *   模式变化经 RPC prompt `/aishell-mode <suggest|agent|yolo>` 热切换（非法值保持原模式并抛错）。
 *   注意：RPC 模式下 setActiveTools 不影响模型请求的 tools（spawn 时 --tools 固定），
 *   agent ↔ yolo 热推即可；suggest 边界切换由 Rust set_ai_mode 重启进程完成（会话经 --session 恢复）。
 * 审批：agent 对受控工具（write/edit/delete_path/run_command/sftp_upload/sftp_download）
 * 每次调用单独 ctx.ui.confirm（title 固定 `AISHELL_APPROVAL:<toolCallId>`，message 为
 * `{action,intent,summary}`）；yolo 跳过；suggest 即使异常收到变更工具调用也直接阻止。
 * 动作执行：delete_path 在扩展内用 Node fs 执行（同一项目根校验）；run_command / sftp_upload /
 * sftp_download 经 `ctx.ui.input('AISHELL_ACTION:<toolCallId>', JSON.stringify(payload))`
 * 走 RPC extension UI 子协议交给 Rust 的 ai_actions（唯一执行入口，另有后端硬边界）。
 * 路径处理：path.resolve 归一（相对路径、`..`、绝对路径）后统一小写做前缀比较
 * （Windows 大小写不敏感）；8.3 短文件名等无法归一的形式会因前缀失配被拒（安全方向）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const VALID_MODES = ["suggest", "agent", "yolo"] as const;
type AiMode = (typeof VALID_MODES)[number];

/** 仅 agent/yolo 提供的变更工具（suggest 一律拒绝） */
const AI_ONLY_TOOLS = ["delete_path", "run_command", "sftp_upload", "sftp_download", "list_servers", "db_query"];
/** agent 模式逐调用审批的受控工具 */
const CONTROLLED_TOOLS = ["write", "edit", "delete_path", "run_command", "sftp_upload", "sftp_download"];

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

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const root = path.resolve(cwd).toLowerCase();
	const writableRoot = path.join(root, ".aishell");

	const inside = (dirLower: string, targetLower: string): boolean =>
		targetLower === dirLower || targetLower.startsWith(dirLower + path.sep);

	let mode: AiMode = VALID_MODES.includes((process.env.AISHELL_AI_MODE || "") as AiMode)
		? (process.env.AISHELL_AI_MODE as AiMode)
		: "suggest";

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
		switch (tool) {
			case "write":
				return { action: "write", intent: `写文件 ${raw}`, summary: `向 ${raw} 写入内容` };
			case "edit":
				return { action: "edit", intent: `编辑文件 ${raw}`, summary: `修改 ${raw} 中的文本` };
			case "delete_path":
				return { action: "delete_path", intent: `删除 ${raw}`, summary: `递归删除 ${raw}` };
			case "run_command": {
				const intent = typeof input.intent === "string" ? input.intent : "";
				const command = typeof input.command === "string" ? input.command : "";
				const target = input.target === "remote" ? `远程(${String(input.serverId || "")})` : "本地";
				const timeout = typeof input.timeoutSeconds === "number" ? input.timeoutSeconds : 10;
				return { action: "run_command", intent, summary: `执行命令（${target}，超时 ${timeout} 秒）：${command}` };
			}
			case "sftp_upload":
				return {
					action: "sftp_upload",
					intent: `上传 ${String(input.localPath || "")} 到 ${String(input.remoteDir || "")}${input.overwrite ? "（覆盖同名）" : ""}`,
					summary: `SFTP 上传到服务器 ${String(input.serverId || "")}${input.overwrite ? "（覆盖远端同名文件）" : "（重名自动创建副本）"}`,
				};
			case "sftp_download":
				return {
					action: "sftp_download",
					intent: `下载 ${String(input.remotePath || "")} 到 ${String(input.localDir || "")}`,
					summary: `SFTP 下载自服务器 ${String(input.serverId || "")}`,
				};
			case "db_query":
				return {
					action: "db_query",
					intent: `数据库写操作（连接 ${String(input.connectionId || "")}，服务器 ${String(input.serverId || "")}）`,
					summary: `db_query：${typeof input.command === "string" ? input.command : ""}`,
				};
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
				const raw = rawPath();
				const p = path.resolve(cwd, raw);
				if (!inside(root, p.toLowerCase())) {
					return { block: true, reason: `AIShell 权限边界:只能读项目目录内的文件(拒绝:${raw})。` };
				}
				return undefined;
			}
			case "write":
			case "edit": {
				const raw = rawPath();
				const p = path.resolve(cwd, raw);
				const limit = mode === "suggest" ? writableRoot : root;
				if (!inside(limit, p.toLowerCase())) {
					return {
						block: true,
						reason:
							mode === "suggest"
								? `AIShell 权限边界:只能写项目 .aishell/ 目录下的文件(拒绝:${raw})。修改项目文件请改为在回复中输出命令卡,让用户在终端执行。`
								: `AIShell 权限边界:只能写项目目录内的文件(拒绝:${raw})。`,
					};
				}
				return undefined;
			}
			case "delete_path": {
				const raw = rawPath();
				const p = path.resolve(cwd, raw);
				if (!inside(root, p.toLowerCase())) {
					return { block: true, reason: `AIShell 权限边界:只能删除项目目录内的文件或目录(拒绝:${raw})。` };
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
				const localPath = typeof input.localPath === "string" ? input.localPath.trim() : "";
				const remoteDir = typeof input.remoteDir === "string" ? input.remoteDir.trim() : "";
				if (!serverId) return { block: true, reason: "sftp_upload: 缺少 serverId。" };
				if (!localPath) return { block: true, reason: "sftp_upload: localPath 不能为空。" };
				if (!remoteDir) return { block: true, reason: "sftp_upload: remoteDir 不能为空。" };
				const p = path.resolve(cwd, localPath);
				if (!inside(root, p.toLowerCase())) {
					return { block: true, reason: `AIShell 权限边界:上传源必须在项目目录内(拒绝:${localPath})。` };
				}
				return undefined;
			}
			case "sftp_download": {
				const serverId = typeof input.serverId === "string" ? input.serverId.trim() : "";
				const remotePath = typeof input.remotePath === "string" ? input.remotePath.trim() : "";
				const localDir = typeof input.localDir === "string" ? input.localDir.trim() : "";
				if (!serverId) return { block: true, reason: "sftp_download: 缺少 serverId。" };
				if (!remotePath) return { block: true, reason: "sftp_download: remotePath 不能为空。" };
				if (!localDir) return { block: true, reason: "sftp_download: localDir 不能为空。" };
				const p = path.resolve(cwd, localDir);
				if (!inside(root, p.toLowerCase())) {
					return { block: true, reason: `AIShell 权限边界:下载目标必须在项目目录内(拒绝:${localDir})。` };
				}
				return undefined;
			}
			case "web_search":
				// 只读网络调用，无文件路径语义（aishell-search.ts 注册）
				return undefined;
			case "list_servers":
				// 只读查询：项目绑定的可操作服务器列表（无路径参数）
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
			case "request_agent_mode":
				// 仅建议模式专属工具（suggest 的 --tools 白名单才含它）：agent/yolo 下防御性阻止
				if (mode !== "suggest") {
					return { block: true, reason: "AIShell 权限边界:仅建议模式下才可申请切换工作模式。" };
				}
				return undefined;
			default:
				return { block: true, reason: `AIShell 权限边界:工具 ${tool} 不可用。` };
		}
	}

	/* ---------- 工具调用钩子：路径/参数校验 + Agent 逐调用审批 ---------- */
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
		if (blocked) return blocked;
		if (mode === "agent") {
			if (CONTROLLED_TOOLS.includes(tool)) {
				if (!(await approve(ctx, tool, input, event.toolCallId))) {
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

	/* ---------- 内部动作桥：run_command / sftp_upload / sftp_download 交 Rust ai_actions 执行 ---------- */
	async function rustAction(
		ctx: Parameters<Parameters<typeof pi.registerTool>[0]["execute"]>[4],
		toolCallId: string,
		payload: Record<string, unknown>,
	) {
		const raw = await ctx.ui.input("AISHELL_ACTION:" + toolCallId, JSON.stringify(payload));
		if (raw === undefined) throw new Error("操作已被取消");
		let result: { ok?: boolean; text?: string; error?: string };
		try {
			result = JSON.parse(raw);
		} catch {
			throw new Error("动作桥返回了非法结果");
		}
		if (!result.ok) throw new Error(result.error || "动作执行失败");
		return okResult(result.text ?? "");
	}

	/* ---------- 自定义工具注册（suggest 下不激活；tool_call 钩子仍兜底拒绝） ---------- */
	pi.registerTool({
		name: "delete_path",
		label: "Delete Path",
		description: "删除项目目录内的文件或目录（递归）。仅限当前项目目录内，越界会被拒绝。",
		promptSnippet: "删除项目内文件",
		promptGuidelines: [
			"使用 delete_path 删除项目内文件或目录时，必须先在回复中说明删除目标与原因。",
		],
		parameters: Type.Object({
			path: Type.String({ description: "要删除的文件或目录路径（相对当前项目根）" }),
		}),
		async execute(_toolCallId, params) {
			const raw = String(params.path || "").trim();
			const p = path.resolve(cwd, raw);
			if (!inside(root, p.toLowerCase())) {
				throw new Error(`AIShell 权限边界:只能删除项目目录内的文件或目录(拒绝:${raw})。`);
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
			};
			if (params.serverId) payload.serverId = params.serverId;
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
			"上传项目目录内的本地文件或目录到远程服务器的指定目录（默认重名自动创建副本并返回副本文件名；overwrite=true 时覆盖远端同名文件）。",
		promptSnippet: "上传文件到服务器",
		promptGuidelines: [
			"sftp_upload 的 localPath 必须是当前项目目录内的文件或目录；服务器受 AI 操作锁约束。",
			"更新远端已有文件时传 overwrite=true 直接覆盖，否则会生成副本文件；结果会返回远端实际文件名，回复用户时如实引用。",
		],
		parameters: Type.Object({
			serverId: Type.String({ description: "目标服务器 ID" }),
			localPath: Type.String({ description: "本地源路径（项目目录内）" }),
			remoteDir: Type.String({ description: "远端目标目录" }),
			overwrite: Type.Optional(
				Type.Boolean({ description: "是否覆盖远端同名文件：true 覆盖；默认 false（重名自动创建副本）" }),
			),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, {
				action: "sftp_upload",
				serverId: params.serverId,
				localPath: params.localPath,
				remoteDir: params.remoteDir,
				overwrite: params.overwrite === true,
			});
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
		name: "sftp_download",
		label: "SFTP Download",
		description: "从远程服务器下载文件或目录到项目目录内的已有目录（重名自动改名）。",
		promptSnippet: "从服务器下载文件",
		promptGuidelines: [
			"sftp_download 的 localDir 必须是项目目录内已存在的目录；服务器受 AI 操作锁约束。",
		],
		parameters: Type.Object({
			serverId: Type.String({ description: "源服务器 ID" }),
			remotePath: Type.String({ description: "远端源路径" }),
			localDir: Type.String({ description: "本地目标目录（项目目录内，必须已存在）" }),
		}),
		async execute(toolCallId, params, _signal, _onUpdate, ctx) {
			return await rustAction(ctx, toolCallId, {
				action: "sftp_download",
				serverId: params.serverId,
				remotePath: params.remotePath,
				localDir: params.localDir,
			});
		},
	});
}
