#!/usr/bin/env node
/**
 * 拉取 Git for Windows 官方 64 位安装程序（Git-<version>-64-bit.exe）到 src-tauri/resources/git/。
 * 用途：应用首启检测不到 Git Bash 时，弹窗征求用户同意后静默安装
 * （src-tauri/src/gitinstall.rs 从该目录取 Git-*-64-bit.exe；目录不入库，见根 .gitignore）。
 * 构建前门（tauri.conf.json beforeBuildCommand 调用）：
 * - 已存在 Git-*-64-bit.exe 时跳过（幂等，本机构建零开销）；
 * - 缺失时抓 git-for-windows/git 最新 release 页（releases/latest 302 到最新 tag 页，
 *   不调 GitHub API，免鉴权免限流）。GitHub 现在不再服务端渲染资产下载链接，但 release
 *   正文带「Filename | SHA-256」表格：正则出完整安装器文件名（只匹配 Git-*-64-bit.exe，
 *   不匹配 MinGit/PortableGit/arm64/tar.bz2）与官方校验和，用 tag 拼直链下载并核验。
 *   若表格结构变化则退化为按命名约定（Git-<ver>-64-bit.exe）HEAD 探测。
 * 强制更新：node scripts/fetch-git.mjs --force（等价于手动跑 scripts/fetch-git.sh）。
 * 不依赖 Git Bash：下载走 Node fetch。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FORCE = process.argv.includes('--force');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'src-tauri', 'resources', 'git');

// 幂等：DEST 下已有安装器则跳过（--force 时先清空重下）
const existing = existsSync(DEST)
  ? readdirSync(DEST).filter((f) => f.startsWith('Git-') && f.endsWith('-64-bit.exe'))
  : [];
if (existing.length > 0 && !FORCE) {
  console.log(`==> ${path.join(DEST, existing[0])} 已存在，跳过下载（强制更新请用 --force）`);
  process.exit(0);
}

/** 失败输出：GHA 下用 ::error:: 工作流命令让原因进运行注解（无日志权限也能从注解定位）。
 * 必须用 writeSync 直写 fd：POSIX 下 console 写管道是异步的，随后 process.exit 会丢弃缓冲。 */
function fail(msg) {
  if (process.env.GITHUB_ACTIONS) writeSync(1, `::error::${msg}\n`);
  writeSync(2, `!! ${msg}\n`);
  process.exit(1);
}
// 兜底：任何未捕获异常/拒绝（如下载中断 arrayBuffer 抛错）都走 fail 进注解
process.on('unhandledRejection', (e) => fail(`未捕获异常：${e?.stack || e}`));
process.on('uncaughtException', (e) => fail(`未捕获异常：${e?.stack || e}`));

/** HTTP 错误时输出状态码与响应体片段（GitHub 限流/鉴权错误的体里有明确原因）。 */
async function dumpHttpError(prefix, r) {
  const body = (await r.text().catch(() => '')).slice(0, 300);
  fail(`${prefix}：HTTP ${r.status}${body ? ` — ${body}` : ''}`);
}

const LATEST_URL = 'https://github.com/git-for-windows/git/releases/latest';
const UA = { 'User-Agent': 'aishell-build' };
console.log('==> 解析最新 release 页...');
const page = await fetch(LATEST_URL, { headers: UA, redirect: 'follow' }).catch((e) => {
  fail(`release 页请求失败：${e.message}`);
});
if (!page.ok) {
  await dumpHttpError('release 页解析失败', page);
}
// redirect follow 后落在最新 tag 页，tag 从最终 URL 取
const tag = page.url.match(/\/releases\/tag\/([^/]+)/)?.[1] ?? 'unknown';
const html = await page.text();

// 主路径：release 正文「Filename | SHA-256」表格（GitHub 服务端渲染），取完整安装器与官方校验和
const table = html.match(/>(Git-[\d.]+?-64-bit\.exe)<\/td>\s*<td>([0-9a-f]{64})/);
let fileName, sha256;
if (table) {
  fileName = table[1];
  sha256 = table[2];
  console.log(`==> 最新版本：${tag}，资产：${fileName}（SHA-256 来自官方 release 表格）`);
} else {
  // 退化路径：表格结构变化时按命名约定探测（当前命名 Git-<ver>.<N>-64-bit.exe，
  // 旧版为 Git-<ver>-64-bit.exe，ver=tag 去 v/.windows.N，N=windows 补丁号）
  const ver = tag.replace(/^v/, '').replace(/\.windows\.\d+$/, '');
  const n = tag.match(/\.windows\.(\d+)$/)?.[1];
  const guesses = n ? [`Git-${ver}.${n}-64-bit.exe`, `Git-${ver}-64-bit.exe`] : [`Git-${ver}-64-bit.exe`];
  fileName = null;
  for (const g of guesses) {
    const probe = await fetch(
      `https://github.com/git-for-windows/git/releases/download/${tag}/${g}`,
      { headers: UA, method: 'HEAD', redirect: 'follow' },
    ).catch(() => null);
    if (probe?.ok) {
      fileName = g;
      break;
    }
  }
  sha256 = null;
  if (!fileName) {
    fail('release 表格未解析到资产且约定名探测全部失败（页面结构可能变化），请手动更新本脚本');
  }
  console.log(`==> release 表格未解析到资产（页面结构可能变化），按约定探测命中：${fileName}`);
}
const downloadUrl = `https://github.com/git-for-windows/git/releases/download/${tag}/${fileName}`;
console.log(`==> 下载 ${downloadUrl}`);

const pkgPath = path.join(tmpdir(), `git-${Date.now()}-${fileName}`);
try {
  const dl = await fetch(downloadUrl, { headers: UA }).catch((e) => fail(`下载请求失败：${e.message}`));
  if (!dl.ok) {
    await dumpHttpError('下载失败', dl);
  }
  const buf = Buffer.from(await dl.arrayBuffer());
  // 完整安装器约 60MB+；低于 10MB 视为错误页/限流页，拒绝落盘
  if (buf.length < 10 * 1024 * 1024) {
    fail(`下载内容异常偏小（${buf.length} 字节），疑似错误页/限流页`);
  }
  // 官方 release 表格自带 SHA-256，逐位核验后再落盘
  if (sha256) {
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== sha256) {
      fail(`SHA-256 校验失败：期望 ${sha256}，实际 ${actual}`);
    }
    console.log('==> SHA-256 校验通过');
  }
  // 先落盘到系统临时目录，校验全部通过后再搬入 DEST（避免 DEST 出现半截文件）
  writeFileSync(pkgPath, buf);

  // 整体替换 DEST：先清旧目录再搬入，避免残留旧版本安装器被 gitinstall 误取。
  // 用 copy 而非 rename：tmp 可能在别的盘符（跨卷 MoveFile 报 ENOENT）
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  copyFileSync(pkgPath, path.join(DEST, fileName));
  writeFileSync(path.join(DEST, 'VERSION'), tag);
  console.log(`==> 完成：${fileName}（${tag}）-> ${path.join(DEST, fileName)}`);
} finally {
  rmSync(pkgPath, { force: true });
}
