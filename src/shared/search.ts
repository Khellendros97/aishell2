// 搜索查询解析与匹配：#tag 筛选语法 + 文本子串匹配。
// 对照 .proto/：无（原型无此功能，搜索语法为新增需求）。
// 使用方：ServersPanel（工作台侧栏）、Welcome（服务器多选 / 项目搜索）。
import type { Project, Server } from '../types';

export interface ParsedQuery {
  /** #tag 条件（已去 #、小写归一），多个 tag 之间取 AND */
  tags: string[];
  /** 剩余文本条件（小写归一），空串 = 无文本条件 */
  text: string;
}

/** 把输入按空白拆 token：# 开头的是 tag 条件，其余拼回文本条件 */
export function parseSearchQuery(query: string): ParsedQuery {
  const tags: string[] = [];
  const words: string[] = [];
  for (const token of query.trim().split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith('#') && token.length > 1) {
      const tag = token.slice(1).toLowerCase();
      if (!tags.includes(tag)) tags.push(tag);
    } else {
      words.push(token);
    }
  }
  return { tags, text: words.join(' ').toLowerCase() };
}

/** 查询串中已选中的 tag（供 chips 行高亮） */
export function queryTags(query: string): string[] {
  return parseSearchQuery(query).tags;
}

/** 把 #tag 切换进/出查询串：已存在则移除，否则追加到末尾 */
export function toggleTagInQuery(query: string, tag: string): string {
  const parsed = parseSearchQuery(query);
  const lower = tag.toLowerCase();
  const tags = parsed.tags.includes(lower)
    ? parsed.tags.filter((t) => t !== lower)
    : [...parsed.tags, lower];
  return [...tags.map((t) => `#${t}`), ...(parsed.text ? [parsed.text] : [])].join(' ');
}

function serverHasAllTags(server: Server, tags: string[]): boolean {
  if (tags.length === 0) return true;
  const own = server.tags.map((t) => t.toLowerCase());
  return tags.every((t) => own.includes(t));
}

/** 服务器匹配：tag 条件 AND 命中 + 文本对 name/host/username 子串匹配 */
export function matchServer(server: Server, parsed: ParsedQuery): boolean {
  if (!serverHasAllTags(server, parsed.tags)) return false;
  if (!parsed.text) return true;
  return [server.name, server.host, server.username].some((v) =>
    v.toLowerCase().includes(parsed.text),
  );
}

/** 项目匹配：文本匹配 name/path/folder；tag 条件 = 绑定的服务器里至少一台命中全部 tag */
export function matchProject(
  project: Project,
  serversById: ReadonlyMap<string, Server>,
  parsed: ParsedQuery,
): boolean {
  if (parsed.tags.length > 0) {
    const hit = project.serverIds.some((id) => {
      const s = serversById.get(id);
      return s !== undefined && serverHasAllTags(s, parsed.tags);
    });
    if (!hit) return false;
  }
  if (!parsed.text) return true;
  return [project.name, project.path ?? '', project.folder].some((v) =>
    v.toLowerCase().includes(parsed.text),
  );
}

/** 统计服务器列表的 tag 引用次数，返回 top N（次数降序，同次按名称中文排序） */
export function topTags(servers: readonly Server[], n = 8): string[] {
  const counts = new Map<string, number>();
  for (const s of servers) {
    for (const t of s.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .slice(0, n)
    .map(([t]) => t);
}
