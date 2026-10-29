/**
 * AI 会话快照对账（无 .proto 对照；供 ai-engine 分离窗口聚合时恢复持久化消息）。
 * 普通加载只同步标题元数据，聚合重对账才采用持久化消息，避免常规加载覆盖流式回合。
 */
import type { ChatSession } from '../../../types';

export function reconcileSessionSnapshot(current: ChatSession, persisted: ChatSession, adoptMessages: boolean): void {
  current.title = persisted.title;
  current.autoTitleTriggered = persisted.autoTitleTriggered === true;
  if (adoptMessages) current.messages = persisted.messages;
}
