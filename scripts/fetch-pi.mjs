#!/usr/bin/env node
/**
 * 拉取 pi (earendil-works/pi) 的 Windows 分发版到 src-tauri/resources/pi/。
 * 构建前门（tauri.conf.json beforeBuildCommand 调用）：
 * - pi.exe 已存在时跳过（幂等，本机构建零开销）；
 * - 缺失时自动下载并解压，保证干净环境也能出完整安装包。
 * 强制更新：node scripts/fetch-pi.mjs --force（等价于手动跑 fetch-pi.sh）。
 * 不依赖 Git Bash：下载走 Node fetch，解压走系统自带 PowerShell Expand-Archive。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORCE = process.argv.includes('--force');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'src-tauri', 'resources', 'pi');
const PI_EXE = path.join(DEST, 'pi.exe');

if (existsSync(PI_EXE) && !FORCE) {
  console.log(`==> ${PI_EXE} 已存在，跳过下载（强制更新请用 --force）`);
  process.exit(0);
}

const API = 'https://api.github.com/repos/earendil-works/pi/releases/latest';
console.log('==> 查询 earendil-works/pi 最新 release ...');
const resp = await fetch(API, { headers: { 'User-Agent': 'aishell-build' } });
if (!resp.ok) {
  console.error(`!! release 查询失败：HTTP ${resp.status}（可能触发了 GitHub API 限流）`);
  process.exit(1);
}
const release = await resp.json();
const asset = (release.assets ?? []).find((a) => a.name === 'pi-windows-x64.zip');
if (!asset?.browser_download_url) {
  console.error('!! release 中未找到资产 pi-windows-x64.zip');
  process.exit(1);
}
console.log(`==> 最新版本：${release.tag_name}`);

const zipPath = path.join(tmpdir(), `pi-${Date.now()}.zip`);
const tmpDir = path.join(tmpdir(), `pi-extract-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
try {
  console.log(`==> 下载 ${asset.browser_download_url}`);
  const dl = await fetch(asset.browser_download_url, { headers: { 'User-Agent': 'aishell-build' } });
  if (!dl.ok) {
    console.error(`!! 下载失败：HTTP ${dl.status}`);
    process.exit(1);
  }
  writeFileSync(zipPath, Buffer.from(await dl.arrayBuffer()));

  console.log('==> 解压（PowerShell Expand-Archive）...');
  const r = spawnSync('powershell', [
    '-NoProfile',
    '-Command',
    `Expand-Archive -Force -LiteralPath '${zipPath}' -DestinationPath '${tmpDir}'`,
  ], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('!! 解压失败');
    process.exit(1);
  }

  // zip 顶层若嵌套一层目录（如 pi-win32-x64/）则摊平，保证 pi.exe 直接位于 DEST 下
  const inner = readdirSync(tmpDir);
  if (inner.length === 1 && existsSync(path.join(tmpDir, inner[0], 'pi.exe'))) {
    const nested = path.join(tmpDir, inner[0]);
    for (const f of readdirSync(nested)) {
      cpSync(path.join(nested, f), path.join(tmpDir, f), { recursive: true, force: true });
    }
    rmSync(nested, { recursive: true, force: true });
  }

  if (!existsSync(path.join(tmpDir, 'pi.exe'))) {
    console.error('!! 解压后未找到 pi.exe，请检查 zip 内部结构');
    process.exit(1);
  }

  // 整体替换 DEST：先清旧目录再搬入，保证旁车资源（theme/assets/node_modules）与 pi.exe 同级且无残留
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  for (const f of readdirSync(tmpDir)) {
    cpSync(path.join(tmpDir, f), path.join(DEST, f), { recursive: true, force: true });
  }
  writeFileSync(path.join(DEST, 'VERSION'), release.tag_name);
  console.log(`==> 完成：pi ${release.tag_name} -> ${DEST}\\pi.exe`);
} finally {
  rmSync(zipPath, { force: true });
  rmSync(tmpDir, { recursive: true, force: true });
}
