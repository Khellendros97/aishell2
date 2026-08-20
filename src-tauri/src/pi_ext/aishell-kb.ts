/**
 * AIShell 知识库检索扩展 —— kb_search 工具。
 * 由 src-tauri/src/ai.rs 每次 spawn 重写进 agent_dir 并以 --extension 加载；凭据经 spawn
 * 环境变量注入（永不进 JSON / 不回传前端）。
 *
 * 知识库是云平台只读中转（开放 API 文档 §4）：零凭证透传，命中带相关度 score；
 * 由 ai.rs 在托管模式且平台启用了 knowledge 能力时挂载（不受自动注入开关影响——
 * 自动注入是前置客户端检索，与本工具并存）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/** 云平台中转地址（ai.rs 托管模式注入；缺失即未挂载） */
const KB_URL = process.env.AISHELL_KB_URL;
const KB_TOKEN = process.env.AISHELL_KB_TOKEN;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 30_000;
/** 输出截断上限（pi docs 要求工具必须截断输出，防上下文溢出） */
const MAX_RESULTS = 10;
const MAX_ENTRY_CHARS = 500;
const MAX_TOTAL_CHARS = 4000;

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 从错误体提取可读信息：兼容云平台 `{"error":"中文"}` 与通用 message 字段。 */
function extractErrorDetail(body: string): string {
	try {
		const parsed = JSON.parse(body) as { error?: string | { detail?: string }; message?: string };
		if (typeof parsed.error === "string") return parsed.error;
		if (parsed.error?.detail) return parsed.error.detail;
		if (parsed.message) return parsed.message;
	} catch { /* 非 JSON 时原样返回 */ }
	return body;
}

function formatHttpError(status: number, detail: string): string {
	switch (status) {
		case 400: return `知识库检索参数错误（400）：${truncate(detail, 200)}`;
		case 401: return `公司账号登录已过期，请前往账号页重新登录后使用知识库`;
		case 403: return `账号无权访问知识库（403）：${truncate(detail, 200)}`;
		case 503: return "知识库未配置或已停用（503），如需使用请联系平台管理员开启";
		case 502: return `知识库服务暂不可用（502）：${truncate(detail, 200)}`;
		default: return `知识库检索失败（${status}）：${truncate(detail, 200)}`;
	}
}

/** 归一化后的单条命中：来源 + 相关度 + 可用作上下文的片段/预览。 */
interface ParsedHit {
	title: string;
	heading: string;
	score: number;
	text: string;
}

/** 解析命中数组（顶层数组，字段容错：缺失按空串/0）。 */
function parseHits(data: unknown): ParsedHit[] {
	if (!Array.isArray(data)) return [];
	const out: ParsedHit[] = [];
	for (const raw of data) {
		const r = (raw ?? {}) as Record<string, unknown>;
		const title = typeof r.document_title === "string" ? r.document_title : "";
		const heading = typeof r.heading_path === "string" ? r.heading_path : "";
		const text = typeof r.content_preview === "string" && r.content_preview
			? r.content_preview
			: typeof r.snippet === "string"
				? r.snippet
				: "";
		const score = typeof r.score === "number" ? r.score : 0;
		out.push({ title, heading, score, text });
	}
	// 相关度降序（分数高的知识库记录优先）
	out.sort((a, b) => b.score - a.score);
	return out;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "kb_search",
		label: "Knowledge Search",
		description: "知识库检索（企业知识库只读中转）",
		promptSnippet: "检索企业知识库",
		promptGuidelines: [
			"当问题涉及企业内部规范、部署说明、产品文档、FAQ 等沉淀知识时使用 kb_search，优先于凭记忆作答。",
			"检索命中带相关度分数与来源（文档标题/章节路径），回复时可结合命中内容并注明来源。",
		],
		parameters: Type.Object({
			query: Type.String(),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIMIT })),
			workspace_id: Type.Optional(Type.Integer()),
		}),
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			if (!KB_URL || !KB_TOKEN) {
				throw new Error("公司账号登录已过期或知识库未启用，请前往账号页确认登录状态");
			}
			const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
			const url = new URL(KB_URL);
			url.searchParams.set("q", params.query);
			url.searchParams.set("limit", String(limit));
			if (typeof params.workspace_id === "number") {
				url.searchParams.set("workspace_id", String(params.workspace_id));
			}

			let response: Response;
			try {
				const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
				response = await fetch(url, {
					headers: { Accept: "application/json", Authorization: `Bearer ${KB_TOKEN}` },
					signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
				});
			} catch (err) {
				if (err instanceof DOMException && err.name === "TimeoutError") {
					throw new Error("知识库检索请求超时（30 秒），请稍后重试");
				}
				if (err instanceof DOMException && err.name === "AbortError") {
					return { content: [{ type: "text", text: "已取消" }], details: {} };
				}
				throw new Error(`知识库检索网络错误：${err instanceof Error ? err.message : String(err)}`);
			}

			if (!response.ok) {
				const detail = extractErrorDetail(await response.text().catch(() => ""));
				throw new Error(formatHttpError(response.status, detail));
			}

			const hits = parseHits(await response.json().catch(() => null));

			const lines: string[] = [];
			let total = 0;
			for (const h of hits) {
				if (!h.title && !h.text) continue;
				const source = h.heading ? `${h.title}（${h.heading}）` : (h.title || "未知来源");
				const entry = `${lines.length + 1}. [${source}]（相关度 ${h.score.toFixed(0)}）\n   ${truncate(h.text, MAX_ENTRY_CHARS)}`;
				if (lines.length >= MAX_RESULTS || (lines.length > 0 && total + entry.length > MAX_TOTAL_CHARS)) break;
				lines.push(entry);
				total += entry.length;
			}

			if (lines.length === 0) {
				return {
					content: [{ type: "text", text: `知识库未检索到与「${truncate(params.query, 100)}」相关的内容，可换关键词重试` }],
					details: {},
				};
			}
			return {
				content: [{ type: "text", text: `知识库命中（${lines.length} 条）：\n${lines.join("\n")}` }],
				details: {},
			};
		},
	});
}
