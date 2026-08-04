/**
 * AIShell pi 门控扩展 —— 由 src-tauri/src/ai.rs 在每次 spawn 时重写进 agent_dir 并以 -e 加载。
 * 权限边界(fail-closed):
 * - write/edit:仅 <项目>/.aishell/ 目录内
 * - read/grep/find/ls:仅项目目录内(可选 path 缺省按项目根处理)
 * - 其他工具(bash 等不在 --tools 白名单内的):一律拒绝
 * 路径处理:path.resolve 归一(相对路径、`..`、绝对路径)后统一小写做前缀比较
 * (Windows 大小写不敏感);8.3 短文件名等无法归一的形式会因前缀失配被拒(安全方向)。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const root = path.resolve(cwd).toLowerCase();
	const writableRoot = path.join(root, ".aishell");

	const inside = (dirLower: string, targetLower: string): boolean =>
		targetLower === dirLower || targetLower.startsWith(dirLower + path.sep);

	pi.on("tool_call", (event) => {
		const input = event.input as { path?: unknown };
		const raw = typeof input.path === "string" && input.path.trim() ? input.path : ".";
		const resolved = path.resolve(cwd, raw).toLowerCase();
		switch (event.toolName) {
			case "write":
			case "edit":
				if (!inside(writableRoot, resolved)) {
					return {
						block: true,
						reason: `AIShell 权限边界:只能写项目 .aishell/ 目录下的文件(拒绝:${raw})。修改项目文件请改为在回复中输出命令卡,让用户在终端执行。`,
					};
				}
				return undefined;
			case "read":
			case "grep":
			case "find":
			case "ls":
				if (!inside(root, resolved)) {
					return {
						block: true,
						reason: `AIShell 权限边界:只能读项目目录内的文件(拒绝:${raw})。`,
					};
				}
				return undefined;
			case "web_search":
				// 只读网络调用,无文件路径语义(aishell-search.ts 注册)
				return undefined;
			default:
				return { block: true, reason: `AIShell 权限边界:工具 ${event.toolName} 不可用。` };
		}
	});
}
