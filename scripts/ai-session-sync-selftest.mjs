// AI 分离窗口聚合的会话快照对账自测：node scripts/ai-session-sync-selftest.mjs
import { reconcileSessionSnapshot } from '../src/pages/workbench/ai/session-sync.ts';

let failures = 0;
function ok(cond, msg) {
  if (cond) console.log(`  ok  ${msg}`);
  else { failures++; console.error(`FAIL  ${msg}`); }
}
const msg = (role, content, ts) => ({ role, content, snapshots: [], fileRefs: [], serverRefs: [], pathRefs: [], skillRefs: [], noteRefs: [], actions: [], ts });

const current = { id: 's1', title: '旧标题', messages: [msg('user', '分离前', 1)], autoTitleTriggered: true };
const persisted = {
  id: 's1', title: '独立窗口标题', autoTitleTriggered: true,
  messages: [msg('user', '分离前', 1), msg('user', '分离时提问', 2), msg('assistant', '分离时回答', 3)],
};
reconcileSessionSnapshot(current, persisted, false);
ok(current.messages.length === 1, '普通加载不覆盖内存消息');
ok(current.title === '独立窗口标题', '普通加载仍同步标题');
reconcileSessionSnapshot(current, persisted, true);
ok(current.messages.length === 3, '聚合恢复独立窗口新增的用户与助手消息');
ok(current.messages[1].content === '分离时提问', '用户消息顺序保持一致');
ok(current.messages[2].content === '分离时回答', '助手消息顺序保持一致');

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\nAI 会话对账自测全部通过');
