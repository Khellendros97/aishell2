#!/usr/bin/env node
/**
 * 拉取 pi (earendil-works/pi) 分发版到 src-tauri/resources/pi/。
 * 按当前平台自动选资产（见 TARGETS）：Windows 是 .zip（PowerShell Expand-Archive 解压），
 * macOS/Linux 是 .tar.gz（系统 tar 解压）；二进制名 Windows 为 pi.exe，其余为 pi。
 * 构建前门（tauri.conf.json beforeBuildCommand 调用）：
 * - 二进制已存在时跳过（幂等，本机构建零开销）；
 * - 缺失时自动下载并解压，保证干净环境也能出完整安装包。
 * 强制更新：node scripts/fetch-pi.mjs --force（等价于手动跑 fetch-pi.sh）。
 * 不依赖 Git Bash：下载走 Node fetch，解压走系统自带组件。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, cpSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 平台 → 上游 release 资产名与二进制名（与 earendil-works/pi release 资产一一对应）。 */
const TARGETS = {
  'win32-x64': { asset: 'pi-windows-x64.zip', bin: 'pi.exe' },
  'win32-arm64': { asset: 'pi-windows-arm64.zip', bin: 'pi.exe' },
  'darwin-arm64': { asset: 'pi-darwin-arm64.tar.gz', bin: 'pi' },
  'darwin-x64': { asset: 'pi-darwin-x64.tar.gz', bin: 'pi' },
  'linux-x64': { asset: 'pi-linux-x64.tar.gz', bin: 'pi' },
  'linux-arm64': { asset: 'pi-linux-arm64.tar.gz', bin: 'pi' },
};

const platformKey = `${process.platform}-${process.arch}`;
const target = TARGETS[platformKey];
if (!target) {
  console.error(`!! 当前平台无对应 pi 分发版：${platformKey}（支持：${Object.keys(TARGETS).join(', ')}）`);
  process.exit(1);
}

const FORCE = process.argv.includes('--force');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'src-tauri', 'resources', 'pi');
const PI_BIN = path.join(DEST, target.bin);

if (existsSync(PI_BIN) && !FORCE) {
  console.log(`==> ${PI_BIN} 已存在，跳过下载（强制更新请用 --force）`);
  process.exit(0);
}

const API = 'https://api.github.com/repos/earendil-works/pi/releases/latest';
// GitHub Actions 出口 IP 的匿名限流（60 次/小时/IP，共享 NAT 极易耗尽）会导致查询直接 403；
// workflow 注入 GITHUB_TOKEN 后走 1000 次/小时/仓库的认证额度。本机无 token 时匿名即可。
const GH_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const GH_HEADERS = {
  'User-Agent': 'aishell-build',
  ...(GH_TOKEN ? { Authorization: `Bearer ${GH_TOKEN}` } : {}),
};
/** HTTP 错误时输出状态码与响应体片段（GitHub 限流/鉴权错误的体里有明确原因）。 */
async function dumpHttpError(prefix, r) {
  const body = (await r.text().catch(() => '')).slice(0, 300);
  console.error(`!! ${prefix}：HTTP ${r.status}${body ? ` — ${body}` : ''}`);
}
console.log(`==> 查询 earendil-works/pi 最新 release（平台 ${platformKey}）...`);
const resp = await fetch(API, { headers: GH_HEADERS });
if (!resp.ok) {
  await dumpHttpError('release 查询失败（可能触发了 GitHub API 限流）', resp);
  process.exit(1);
}
const release = await resp.json();
const asset = (release.assets ?? []).find((a) => a.name === target.asset);
if (!asset?.browser_download_url) {
  console.error(`!! release 中未找到资产 ${target.asset}`);
  process.exit(1);
}
console.log(`==> 最新版本：${release.tag_name}`);

const isZip = target.asset.endsWith('.zip');
const pkgPath = path.join(tmpdir(), `pi-${Date.now()}${isZip ? '.zip' : '.tar.gz'}`);
const tmpDir = path.join(tmpdir(), `pi-extract-${Date.now()}`);
mkdirSync(tmpDir, { recursive: true });
try {
  console.log(`==> 下载 ${asset.browser_download_url}`);
  const dl = await fetch(asset.browser_download_url, { headers: GH_HEADERS });
  if (!dl.ok) {
    await dumpHttpError('下载失败', dl);
    process.exit(1);
  }
  writeFileSync(pkgPath, Buffer.from(await dl.arrayBuffer()));

  if (isZip) {
    console.log('==> 解压（PowerShell Expand-Archive）...');
    const r = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Force -LiteralPath '${pkgPath}' -DestinationPath '${tmpDir}'`,
    ], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('!! 解压失败');
      process.exit(1);
    }
  } else {
    console.log('==> 解压（tar）...');
    const r = spawnSync('tar', ['-xzf', pkgPath, '-C', tmpDir], { stdio: 'inherit' });
    if (r.status !== 0) {
      console.error('!! 解压失败');
      process.exit(1);
    }
  }

  // 包顶层若嵌套一层目录（如 pi-darwin-arm64/）则摊平，保证二进制直接位于 DEST 下
  const inner = readdirSync(tmpDir);
  if (inner.length === 1 && existsSync(path.join(tmpDir, inner[0], target.bin))) {
    const nested = path.join(tmpDir, inner[0]);
    for (const f of readdirSync(nested)) {
      cpSync(path.join(nested, f), path.join(tmpDir, f), { recursive: true, force: true });
    }
    rmSync(nested, { recursive: true, force: true });
  }

  if (!existsSync(path.join(tmpDir, target.bin))) {
    console.error(`!! 解压后未找到 ${target.bin}，请检查包内部结构`);
    process.exit(1);
  }

  // 整体替换 DEST：先清旧目录再搬入，保证旁车资源（theme/assets/node_modules）与二进制同级且无残留
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  for (const f of readdirSync(tmpDir)) {
    cpSync(path.join(tmpDir, f), path.join(DEST, f), { recursive: true, force: true });
  }
  // tar 通常保留执行位，保险起见显式补一次（Windows 无执行位概念，跳过）
  if (process.platform !== 'win32') {
    chmodSync(path.join(DEST, target.bin), 0o755);
  }
  writeFileSync(path.join(DEST, 'VERSION'), release.tag_name);
  console.log(`==> 完成：pi ${release.tag_name} -> ${PI_BIN}`);
} finally {
  rmSync(pkgPath, { force: true });
  rmSync(tmpDir, { recursive: true, force: true });
}
