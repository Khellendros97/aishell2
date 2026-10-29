// SSH 终端语义高亮规则自测：node scripts/terminal-highlight-selftest.mjs
import { classifyTerminalLine, TERMINAL_HIGHLIGHT_COLORS } from '../src/pages/workbench/tabs/terminal-highlight.ts';

let failures = 0;
function equal(actual, expected, msg) {
  if (Object.is(actual, expected)) console.log(`  ok  ${msg}`);
  else {
    failures++;
    console.error(`FAIL  ${msg}: expected ${expected}, got ${actual}`);
  }
}

equal(classifyTerminalLine('ERROR upstream timeout'), 'error', 'ERROR 日志');
equal(classifyTerminalLine('ssh: connect to host: Connection refused'), 'error', '常见连接错误');
equal(classifyTerminalLine('bash: foo: command not found'), 'error', '命令不存在');
equal(classifyTerminalLine('执行失败：权限不足'), 'error', '中文错误');
equal(classifyTerminalLine('WARN slow query'), 'warn', 'WARN 日志');
equal(classifyTerminalLine('配置项已弃用'), 'warn', '中文警告');
equal(classifyTerminalLine('BUILD SUCCESSFUL'), 'success', '构建成功');
equal(classifyTerminalLine('12 tests passed'), 'success', '测试通过');
equal(classifyTerminalLine('部署成功'), 'success', '中文成功');
equal(classifyTerminalLine('WARNING then ERROR'), 'error', '错误优先于警告');
equal(classifyTerminalLine('ordinary build output'), null, '普通输出不高亮');
equal(classifyTerminalLine('error.log rotated'), null, '文件名不视为错误日志');
equal(classifyTerminalLine(''), null, '空行');

equal(TERMINAL_HIGHLIGHT_COLORS.dark.error === TERMINAL_HIGHLIGHT_COLORS.light.error, false, '明暗主题独立配色');

if (failures) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n终端高亮规则自测全部通过');
