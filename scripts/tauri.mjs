#!/usr/bin/env node
/**
 * `npm run tauri` 的包装入口：支持 `--env <文件>` 切换构建期云配置的 env 文件，
 * 其余参数原样转给 tauri CLI。
 *
 * 用法：
 *   npm run tauri dev                          # 默认：debug 构建读项目根 dev.env
 *   npm run tauri -- dev --env release.env     # 本地起 dev 但注入 release.env 的云配置
 *   npm run tauri -- dev --env=release.env     # 等价写法
 *   npm run tauri -- build --env release.env   # release 构建同样可覆盖
 * 注意切文件时必须带 `--` 分隔：不带时 npm 会把 --env 当作自己的 flag 拦截，
 * 不透传给脚本。
 *
 * 实现：把文件名写入环境变量 AISHELL_ENV_FILE（进程内，随 tauri dev 传给 cargo），
 * 由 src-tauri/build.rs 读取，值按**仓库根相对路径**解释。本脚本不设默认值——
 * 不带 --env 时沿用 build.rs 的 PROFILE 默认（debug → dev.env，release → release.env）。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const root = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

/** 从参数中剥离 `--env <文件>` / `--env=<文件>`，返回 [剩余参数, env文件名|null] */
function extractEnvFile(args) {
  const rest = [];
  let envFile = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--env') {
      const v = args[i + 1];
      if (!v || v.startsWith('--')) {
        console.error('[tauri] --env 后面要跟 env 文件名（仓库根相对路径），如 --env release.env');
        process.exit(1);
      }
      envFile = v;
      i++;
    } else if (a.startsWith('--env=')) {
      envFile = a.slice('--env='.length);
    } else {
      rest.push(a);
    }
  }
  return [rest, envFile];
}

const [rest, envFile] = extractEnvFile(process.argv.slice(2));
if (envFile) {
  if (!existsSync(path.join(root, envFile))) {
    console.warn(`[tauri] 警告：仓库根下没有 ${envFile}，云配置将缺失（debug 下云功能会隐藏）`);
  }
  process.env.AISHELL_ENV_FILE = envFile;
  console.error(`[tauri] 使用云配置文件：${envFile}`);
}

// 调起 node_modules 里 tauri CLI 的 JS 入口（比 .bin shim 跨平台可靠）
const require = createRequire(import.meta.url);
const cliPkgPath = require.resolve('@tauri-apps/cli/package.json');
const cliPkg = require('@tauri-apps/cli/package.json');
const binRel = typeof cliPkg.bin === 'string' ? cliPkg.bin : (cliPkg.bin?.tauri ?? 'tauri.js');
const binAbs = path.join(path.dirname(cliPkgPath), binRel);
const r = spawnSync(process.execPath, [binAbs, ...rest], { stdio: 'inherit' });
process.exit(r.status ?? 1);
