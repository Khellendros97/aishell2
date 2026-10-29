/**
 * SSH 终端语义高亮规则（无 .proto 对照，新增展示增强；不接触后端与原始输出字节）。
 * 输入为 xterm buffer 已解析的纯文本行，输出只决定装饰底色，避免改写 ANSI、复制或导出内容。
 */

export type TerminalHighlightLevel = 'error' | 'warn' | 'success';

const ERROR_RE = /(?:\b(?:error|fatal|failed|failure|exception|panic|traceback)\b(?!\.\w)|\b(?:command not found|permission denied|no such file or directory|connection refused|segmentation fault)\b|错误|失败|异常|崩溃|拒绝连接|权限不足)/i;
const WARN_RE = /(?:\b(?:warn|warning|deprecated)\b(?!\.\w)|警告|告警|弃用)/i;
const SUCCESS_RE = /(?:\b(?:success|successful|succeeded|passed|completed)\b(?!\.\w)|成功)/i;

/** 一行同时含多类关键词时按 错误 > 警告 > 成功 取最高优先级。 */
export function classifyTerminalLine(line: string): TerminalHighlightLevel | null {
  const text = line.trim();
  if (!text) return null;
  if (ERROR_RE.test(text)) return 'error';
  if (WARN_RE.test(text)) return 'warn';
  if (SUCCESS_RE.test(text)) return 'success';
  return null;
}

/** xterm decoration 只接受 #RRGGBB；低饱和底色保留行内原有 ANSI 前景色。 */
export const TERMINAL_HIGHLIGHT_COLORS: Record<'dark' | 'light', Record<TerminalHighlightLevel, string>> = {
  dark: {
    error: '#3d1f27',
    warn: '#3a321f',
    success: '#173529',
  },
  light: {
    error: '#fde8ea',
    warn: '#fff3d6',
    success: '#e3f5eb',
  },
};
