#!/usr/bin/env node
/**
 * release 构建入口：注入云服务配置后执行 `tauri build`（CR-1.8 构建期注入）。
 *
 * 云配置（服务器地址 / client_id / client_secret）从**环境变量**读取，缺失时给出中文提示并
 * 退出——client_secret 属敏感凭据，禁止写入代码库；构建期由 CI Secrets 或本地环境变量注入。
 * 换地址/换凭据 = 换环境变量重新构建，客户端无修改入口。
 *
 * 用法：
 *   node scripts/build-release.mjs            # 完整 release 构建（环境变量已配置时）
 *   node scripts/build-release.mjs --check    # 只校验云配置是否完整，不构建
 *   node scripts/build-release.mjs -- --verbose   # 其余参数透传给 tauri build
 *
 * 环境变量（三选一来源）：
 *   - 已设置的进程/用户环境变量；
 *   - Windows：`setx AISHELL_SERVER_URL=... AISHELL_CLIENT_ID=... AISHELL_CLIENT_SECRET=...`；
 *   - CI：GitHub Actions 项目级 variables/secrets 注入。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 云配置取值顺序：进程/用户环境变量优先，其次项目根 release.env（gitignore 本地文件，不入库）。
 *  release.env 格式：`KEY=VALUE` 每行，# 开头为注释；供 VS Code 集成终端等
 *  无法继承 setx 新变量的场景，任何终端跑本脚本都能读到。 */
function loadReleaseEnv() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  let text;
  try {
    text = readFileSync(path.join(root, 'release.env'), 'utf8');
  } catch {
    return; // 无本地文件：仅用环境变量
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k && !(k in process.env)) process.env[k] = v;
  }
}
loadReleaseEnv();

const REQUIRED = [
  ['AISHELL_SERVER_URL', '云平台服务器地址'],
  ['AISHELL_CLIENT_ID', 'OAuth 应用 client_id'],
  ['AISHELL_CLIENT_SECRET', 'OAuth 应用 client_secret'],
];

const missing = REQUIRED.filter(([k]) => !(process.env[k] ?? '').trim());
if (missing.length > 0) {
  console.error(`[build-release] 缺少云服务配置：${missing.map(([k, d]) => `${k}（${d}）`).join('、')}`);
  console.error('[build-release] 请在构建前设置环境变量，例如（PowerShell）：');
  for (const [k] of missing) {
    console.error(`  $env:${k} = "<值>"`);
  }
  console.error('[build-release] 或一次性写入用户环境变量：');
  console.error('  setx AISHELL_SERVER_URL "https://aishell.srun.com:18002"');
  console.error('  setx AISHELL_CLIENT_ID "<client_id>"');
  console.error('  setx AISHELL_CLIENT_SECRET "<client_secret>"');
  process.exit(1);
}

if (process.argv.includes('--check')) {
  console.log('[build-release] 云服务配置完整：');
  console.log(`  AISHELL_SERVER_URL = ${process.env.AISHELL_SERVER_URL}`);
  console.log(`  AISHELL_CLIENT_ID  = ${process.env.AISHELL_CLIENT_ID.slice(0, 8)}…`);
  console.log(`  AISHELL_CLIENT_SECRET = ${process.env.AISHELL_CLIENT_SECRET.slice(0, 8)}…`);
  process.exit(0);
}

// 透传额外参数给 tauri build（去掉 --check 自身）
const extra = process.argv.slice(2).filter((a) => a !== '--check');
// Windows 下 npm 是 .cmd，Node 无法直接 spawn（静默 ENOENT）→ 经 cmd /c 执行；
// POSIX 直接 spawn npm（可执行文件）。
const r =
  process.platform === 'win32'
    ? spawnSync('cmd.exe', ['/c', 'npm', 'run', 'tauri', 'build', ...extra], { stdio: 'inherit' })
    : spawnSync('npm', ['run', 'tauri', 'build', ...extra], { stdio: 'inherit' });
if (r.error) {
  console.error(`[build-release] 启动构建失败: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
