/**
 * AIShell 联网扩展 —— web_search（联网搜索）+ web_fetch（网页抓取）工具。
 * 由 src-tauri/src/ai.rs 每次 spawn 重写进 agent_dir 并以 --extension 加载；
 * 密钥经 spawn 环境变量注入（keyring 保管，永不进 JSON / 不回传前端）。
 *
 * 搜索提供商（AISHELL_SEARCH_PROVIDER）：
 * - deepseek（默认）：DeepSeek 搜索 API，复用模型 API Key（AISHELL_DEEPSEEK_KEY/BASE）；
 * - brave：Brave Search 官方 API，BRAVE_API_KEY + X-Subscription-Token。
 * web_fetch 固定走 DeepSeek 网页抓取 API（同一把模型 Key）。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const PROVIDER = process.env.AISHELL_SEARCH_PROVIDER === "brave" ? "brave" : "deepseek";
const DEEPSEEK_KEY = process.env.AISHELL_DEEPSEEK_KEY;
const DEEPSEEK_BASE = process.env.AISHELL_DEEPSEEK_BASE;
const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;
const REQUEST_TIMEOUT_MS = 30_000;
/** 输出截断上限（pi docs 要求工具必须截断输出，防上下文溢出） */
const MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 700;
const MAX_TOTAL_CHARS = 8000;
const MAX_FETCH_CHARS = 16_000;

/** recency 枚举 → Brave freshness 参数 */
const RECENCY_FRESHNESS: Record<string, string> = {
	day: "pd",
	week: "pw",
	month: "pm",
	year: "py",
};

function truncate(s: string, max: number): string {
	return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** env 注入的模型 Base URL（默认 https://api.deepseek.com/v1）→ DeepSeek 工具端点 */
function deepseekToolURL(tool: "search" | "fetch"): string {
	let base = (DEEPSEEK_BASE || "https://api.deepseek.com/v1").trim().replace(/\/+$/, "");
	// 兼容把 base 配成完整 chat/completions 端点的情况
	base = base.replace(/\/chat\/completions$/, "");
	if (!/\/v1$/.test(base)) base += "/v1";
	return `${base}/tools/${tool}`;
}

/** 从各提供商错误体提取可读信息（DeepSeek `{"error":{"message"}}`、Brave `{"error":{"detail"}}`、纯文本） */
function extractErrorDetail(body: string): string {
	try {
		const parsed = JSON.parse(body) as {
			error?: string | { message?: string; detail?: string };
			message?: string;
			msg?: string;
		};
		if (typeof parsed.error === "string") return parsed.error;
		if (parsed.error?.message) return parsed.error.message;
		if (parsed.error?.detail) return parsed.error.detail;
		if (parsed.message) return parsed.message;
		if (parsed.msg) return parsed.msg;
	} catch { /* 非 JSON 时原样返回 */ }
	return body;
}

/** DeepSeek 状态码 → 中文可执行错误（返回给 LLM 由它转告用户） */
function formatDeepSeekError(action: string, status: number, detail: string): string {
	switch (status) {
		case 400:
			return `DeepSeek ${action}请求不合法（400）：${truncate(detail, 200)}`;
		case 401:
			return `DeepSeek ${action}鉴权失败（401），模型 API Key 无效，请检查设置中的模型 API Key`;
		case 402:
			return `DeepSeek 账户余额不足（402），无法使用${action}服务`;
		case 403:
			return `DeepSeek ${action}被安全策略拒绝（403）：${truncate(detail, 200)}`;
		case 404:
			return action === "网页抓取"
				? "该页面没有可用内容（404）：可能被站点拦截、需要登录或不是文本页面"
				: `DeepSeek 搜索无可用结果（404）：${truncate(detail, 200)}`;
		case 408:
			return `DeepSeek ${action}读取超时（408），请稍后重试`;
		case 413:
			return `DeepSeek ${action}请求体过大（413）`;
		case 429:
			return `DeepSeek ${action}请求过于频繁（429），请稍后再试`;
		case 500:
		case 504:
			return `DeepSeek ${action}服务暂时不可用（${status}），请稍后重试`;
		default:
			return `DeepSeek ${action}失败（${status}）：${truncate(detail, 200)}`;
	}
}

/** 状态码 → 中文可执行错误（Brave） */
function formatBraveError(status: number, detail: string): string {
	switch (status) {
		case 401:
		case 403:
			return `Brave 搜索鉴权失败（${status}），请检查设置中的 Brave API Key 是否正确`;
		case 422:
			// Brave 用 422 表示无效订阅 token（实测），其余 422 为参数问题
			if (/subscription token|api key|invalid/i.test(detail)) {
				return "Brave 搜索 API Key 无效，请检查设置中的 Brave Search API Key 是否正确";
			}
			return `Brave 搜索请求被拒绝（422）：${truncate(detail, 200)}`;
		case 429:
			return `Brave 搜索请求过于频繁或超出月度配额（429），请稍后再试`;
		default:
			return `Brave 搜索失败（${status}）：${truncate(detail, 200)}`;
	}
}

async function requestDeepSeek(
	tool: "search" | "fetch",
	payload: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<unknown> {
	if (!DEEPSEEK_KEY) {
		throw new Error(
			PROVIDER === "deepseek"
				? "DeepSeek 搜索需要复用模型 API Key，但当前模型配置不是 DeepSeek（或未配置 Key）。请改用 DeepSeek 模型，或在 设置 → API 接口 → 联网搜索 中选择 Brave Search"
				: "未配置 DeepSeek 模型 API Key，无法抓取网页；请改用 DeepSeek 模型后重试",
		);
	}
	const action = tool === "search" ? "搜索" : "网页抓取";
	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		response = await fetch(deepseekToolURL(tool), {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				Authorization: `Bearer ${DEEPSEEK_KEY}`,
			},
			body: JSON.stringify(payload),
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			throw new Error(`DeepSeek ${action}请求超时（30 秒），请稍后重试`);
		}
		if (err instanceof DOMException && err.name === "AbortError") {
			throw new Error("已取消");
		}
		throw new Error(`DeepSeek ${action}网络错误：${err instanceof Error ? err.message : String(err)}`);
	}
	if (!response.ok) {
		const detail = extractErrorDetail(await response.text().catch(() => ""));
		throw new Error(formatDeepSeekError(action, response.status, detail));
	}
	return response.json();
}

interface DeepSeekResult {
	title?: string | null;
	url?: string | null;
	snippet?: string | null;
	summary?: string | null;
	date?: string | null;
	site_name?: string | null;
}

async function searchDeepSeek(
	query: string,
	count: number,
	signal: AbortSignal | undefined,
): Promise<string> {
	const data = (await requestDeepSeek(
		"search",
		{ query, count, need_content: false },
		signal,
	)) as { results?: DeepSeekResult[] };

	const lines: string[] = [];
	let total = 0;
	for (const r of data.results ?? []) {
		if (!r.url) continue;
		const text = (r.summary?.trim() || r.snippet?.trim() || "").replace(/\s+/g, " ");
		const meta: string[] = [];
		if (r.site_name?.trim()) meta.push(r.site_name.trim());
		if (r.date?.trim()) meta.push(r.date.trim().slice(0, 10));
		const date = meta.length ? `（${meta.join("，")}）` : "";
		const entry = `${lines.length + 1}. ${r.title || r.url}${date}\n   ${r.url}\n   ${truncate(text, MAX_SNIPPET_CHARS)}`;
		if (lines.length >= MAX_RESULTS || (lines.length > 0 && total + entry.length > MAX_TOTAL_CHARS)) break;
		lines.push(entry);
		total += entry.length;
	}
	if (lines.length === 0) {
		return `未找到与「${truncate(query, 100)}」相关的搜索结果，可换关键词重试`;
	}
	return `DeepSeek 搜索结果（${lines.length} 条）：\n${lines.join("\n")}`;
}

interface BraveResult {
	title?: string | null;
	url?: string | null;
	description?: string | null;
	extra_snippets?: string[] | null;
	age?: string | null;
}

async function searchBrave(
	query: string,
	count: number,
	recency: string | undefined,
	signal: AbortSignal | undefined,
): Promise<string> {
	const apiKey = process.env.BRAVE_API_KEY;
	if (!apiKey) {
		throw new Error("未配置 Brave Search API Key，请前往 设置 → API 接口 → 联网搜索 填写后重试");
	}
	const url = new URL(BRAVE_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(count));
	url.searchParams.set("extra_snippets", "true");
	if (recency) {
		url.searchParams.set("freshness", RECENCY_FRESHNESS[recency]);
	}

	let response: Response;
	try {
		const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
		response = await fetch(url, {
			headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
			signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
		});
	} catch (err) {
		if (err instanceof DOMException && err.name === "TimeoutError") {
			throw new Error("Brave 搜索请求超时（30 秒），请稍后重试");
		}
		if (err instanceof DOMException && err.name === "AbortError") {
			throw new Error("已取消");
		}
		throw new Error(`Brave 搜索网络错误：${err instanceof Error ? err.message : String(err)}`);
	}

	if (!response.ok) {
		const detail = extractErrorDetail(await response.text().catch(() => ""));
		throw new Error(formatBraveError(response.status, detail));
	}

	const data = (await response.json()) as { web?: { results?: BraveResult[] } };
	const lines: string[] = [];
	let total = 0;
	for (const r of data.web?.results ?? []) {
		if (!r.url) continue;
		const snippets: string[] = [];
		if (r.description?.trim()) snippets.push(r.description.trim());
		for (const s of r.extra_snippets ?? []) {
			if (!s?.trim() || snippets.includes(s.trim())) continue;
			snippets.push(s.trim());
		}
		const age = r.age ? `（${r.age}）` : "";
		const entry = `${lines.length + 1}. ${r.title || r.url}${age}\n   ${r.url}\n   ${truncate(snippets.join("\n"), MAX_SNIPPET_CHARS)}`;
		if (lines.length >= MAX_RESULTS || (lines.length > 0 && total + entry.length > MAX_TOTAL_CHARS)) break;
		lines.push(entry);
		total += entry.length;
	}
	if (lines.length === 0) {
		return `未找到与「${truncate(query, 100)}」相关的搜索结果，可换关键词重试`;
	}
	return `Brave 搜索结果（${lines.length} 条）：\n${lines.join("\n")}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: `联网搜索（${PROVIDER === "deepseek" ? "DeepSeek" : "Brave Search"}）`,
		promptSnippet: "联网搜索最新信息",
		promptGuidelines: [
			"当问题涉及最新新闻、文档、报错信息、版本/依赖变化等时效性内容时使用 web_search，不要凭记忆编造。",
			"搜索结果带来源链接，回复时引用关键来源 URL。",
			"需要阅读某条结果的完整正文时，先用 web_search 取得链接，再调用 web_fetch。",
		],
		parameters: Type.Object({
			query: Type.String(),
			count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_COUNT })),
			recency: Type.Optional(StringEnum(["day", "week", "month", "year"] as const)),
		}),
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			const count = Math.min(Math.max(params.count ?? DEFAULT_COUNT, 1), MAX_COUNT);
			const text =
				PROVIDER === "brave"
					? await searchBrave(params.query, count, params.recency, signal)
					: await searchDeepSeek(params.query, count, signal);
			return { content: [{ type: "text", text }], details: {} };
		},
	});

	pi.registerTool({
		name: "web_fetch",
		label: "Web Fetch",
		description: "抓取网页正文（DeepSeek 网页抓取）",
		promptSnippet: "抓取网页正文",
		promptGuidelines: [
			"需要阅读网页全文时使用 web_fetch，参数 url 必须是 http/https 链接（通常来自 web_search 结果）。",
			"抓取结果已转为 Markdown，引用内容时注明来源 URL。",
			"PDF、图片、压缩包等非文本页面可能抓取失败，不要反复重试同一链接。",
		],
		parameters: Type.Object({
			url: Type.String(),
		}),
		async execute(_toolCallId, params, signal) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "已取消" }], details: {} };
			}
			let target: URL;
			try {
				target = new URL(params.url.trim());
			} catch {
				throw new Error("url 不是合法链接，请传入完整的 http/https 地址");
			}
			if (target.protocol !== "http:" && target.protocol !== "https:") {
				throw new Error("只支持抓取 http/https 链接");
			}
			if (target.username || target.password) {
				throw new Error("链接不能包含用户名或密码");
			}
			if (target.href.length > 8192) {
				throw new Error("链接过长（超过 8192 字符）");
			}
			const data = (await requestDeepSeek("fetch", { url: target.href }, signal)) as {
				title?: string | null;
				content?: string | null;
			};
			const content = (data.content ?? "").trim();
			if (!content) {
				return {
					content: [{ type: "text", text: `页面「${target.href}」没有抓取到正文内容（可能是动态渲染或非文本页面）` }],
					details: {},
				};
			}
			const title = data.title?.trim() || target.href;
			const body = truncate(content, MAX_FETCH_CHARS);
			const note = content.length > MAX_FETCH_CHARS ? "\n\n（正文过长已截断，如需后续内容请抓取相关分页或锚点链接）" : "";
			return {
				content: [{ type: "text", text: `标题：${title}\nURL：${target.href}\n\n${body}${note}` }],
				details: {},
			};
		},
	});
}
