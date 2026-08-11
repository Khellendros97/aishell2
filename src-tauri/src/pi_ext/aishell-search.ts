/**
 * AIShell 联网搜索扩展 —— web_search 工具。
 * 由 src-tauri/src/ai.rs 每次 spawn 重写进 agent_dir 并以 --extension 加载；密钥经 spawn
 * 环境变量注入（永不进 JSON / 不回传前端）。
 *
 * 两种模式（由 ai.rs 按设置决定注入哪组 env）：
 * - 个人模式（默认）：Brave Search 官方 API，`BRAVE_API_KEY` + `X-Subscription-Token`；
 * - 托管模式（公司服务器代理）：注入 `AISHELL_SEARCH_URL` + `AISHELL_SEARCH_TOKEN`，
 *   请求带 `Authorization: Bearer <token>` 打到云平台 `/api/proxy/search`（开放 API 文档 §3）。
 * 请求实现移植自 omp（@oh-my-pi/pi-coding-agent）src/web/search/providers/brave.ts。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
/** 托管模式代理地址（ai.rs 注入；存在即托管模式） */
const PROXY_URL = process.env.AISHELL_SEARCH_URL;
const PROXY_TOKEN = process.env.AISHELL_SEARCH_TOKEN;
const HOSTED = !!PROXY_URL;
const DEFAULT_COUNT = 10;
const MAX_COUNT = 20;
const REQUEST_TIMEOUT_MS = 30_000;
/** 输出截断上限（pi docs 要求工具必须截断输出，防上下文溢出） */
const MAX_RESULTS = 10;
const MAX_SNIPPET_CHARS = 300;
const MAX_TOTAL_CHARS = 4000;

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

/** 从错误体提取可读信息：兼容云平台 `{"error":"中文"}` 与 Brave `{"error":{"detail":…}}` */
function extractErrorDetail(body: string): string {
    try {
        const parsed = JSON.parse(body) as { error?: string | { detail?: string } };
        if (typeof parsed.error === "string") return parsed.error;
        if (parsed.error?.detail) return parsed.error.detail;
    } catch { /* 非 JSON 时原样返回 */ }
    return body;
}

/** 状态码 → 中文可执行错误（返回给 LLM 由它转告用户）。
 *  托管模式走云平台错误语义（开放 API 文档 §3.2：服务端错误已为中文 JSON）；个人模式维持 Brave 映射。 */
function formatHttpError(status: number, detail: string): string {
    if (HOSTED) {
        switch (status) {
            case 401:
                return "公司账号登录已过期，请前往账号页重新登录后重试";
            case 403:
                return "公司账号被禁用，请联系管理员";
            case 429:
                return `搜索配额已达上限（429）：${truncate(detail, 200)}`;
            case 502:
                return "搜索服务上游暂时不可用（502），请稍后重试";
            case 503:
                return `搜索服务尚未配置或已停用（503）：${truncate(detail, 200)}`;
            default:
                return `搜索失败（${status}）：${truncate(detail, 200)}`;
        }
    }
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

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "联网搜索（Brave Search）",
		promptSnippet: "联网搜索最新信息",
		promptGuidelines: [
			"当问题涉及最新新闻、文档、报错信息、版本/依赖变化等时效性内容时使用 web_search，不要凭记忆编造。",
			"搜索结果带来源链接，回复时引用关键来源 URL。",
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
			// 托管模式：无 token = 登录失效；个人模式：无 Brave key = 未配置
			const token = HOSTED ? PROXY_TOKEN : process.env.BRAVE_API_KEY;
			if (!token) {
				throw new Error(
					HOSTED
						? "公司账号登录已过期，请前往账号页重新登录后使用公司搜索服务"
						: "未配置 Brave Search API Key，请前往 设置 → 系统设置 → 联网搜索 填写后重试",
				);
			}
			const count = Math.min(Math.max(params.count ?? DEFAULT_COUNT, 1), MAX_COUNT);
			const url = new URL(HOSTED ? PROXY_URL! : BRAVE_SEARCH_URL);
			url.searchParams.set("q", params.query);
			url.searchParams.set("count", String(count));
			url.searchParams.set("extra_snippets", "true");
			if (params.recency && !HOSTED) {
				// freshness 为 Brave 私有参数；托管模式由服务端透传解析，不附加
				url.searchParams.set("freshness", RECENCY_FRESHNESS[params.recency]);
			}

			let response: Response;
			try {
				const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
				response = await fetch(url, {
					headers: HOSTED
						? { Accept: "application/json", Authorization: `Bearer ${token}` }
						: { Accept: "application/json", "X-Subscription-Token": token },
					signal: signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal,
				});
			} catch (err) {
				if (err instanceof DOMException && err.name === "TimeoutError") {
					throw new Error(
						HOSTED
							? "搜索请求超时（30 秒），请稍后重试"
							: "Brave 搜索请求超时（30 秒），请稍后重试",
					);
				}
				if (err instanceof DOMException && err.name === "AbortError") {
					return { content: [{ type: "text", text: "已取消" }], details: {} };
				}
				throw new Error(
					`${HOSTED ? "搜索" : "Brave 搜索"}网络错误：${err instanceof Error ? err.message : String(err)}`,
				);
			}

			if (!response.ok) {
				const detail = extractErrorDetail(await response.text().catch(() => ""));
				throw new Error(formatHttpError(response.status, detail));
			}

			interface BraveResult {
				title?: string | null;
				url?: string | null;
				description?: string | null;
				extra_snippets?: string[] | null;
				age?: string | null;
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
				if (lines.length >= MAX_RESULTS || (lines.length > 0 && total + entry.length > MAX_TOTAL_CHARS)) {
					break;
				}
				lines.push(entry);
				total += entry.length;
			}

			if (lines.length === 0) {
				return {
					content: [{ type: "text", text: `未找到与「${truncate(params.query, 100)}」相关的搜索结果，可换关键词重试` }],
					details: {},
				};
			}
			return {
				content: [{ type: "text", text: `Brave 搜索结果（${lines.length} 条）：\n${lines.join("\n")}` }],
				details: {},
			};
		},
	});
}
