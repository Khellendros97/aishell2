#!/usr/bin/env node
/**
 * 拉取 Python 官方 64 位安装程序（python-<version>-amd64.exe）到 src-tauri/resources/python/。
 * 用途：应用首启检测不到 Python3 时，弹窗征求用户同意后静默 per-user 安装
 * （src-tauri/src/pythoninstall.rs 从该目录取 python-*-amd64.exe；目录不入库，见根 .gitignore）。
 * 构建前门（tauri.conf.json beforeBuildCommand 调用）：
 * - 已存在 python-*-amd64.exe 时跳过（幂等，本机构建零开销）；
 * - 缺失时从 python.org FTP 直链下载固定版本，SHA-256 与脚本内硬编码值核验
 *   （硬编码值取自 https://www.python.org/downloads/release/python-31315/ 官方 Files 表格；
 *   升级版本时同步更新 PY_VERSION 与 PY_SHA256 两个常量）。
 * 强制更新：node scripts/fetch-python.mjs --force。
 * 不依赖 Git Bash：下载走 Node fetch。
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 固定版本 + 官方 SHA-256（python.org release 页 Files 表格），升级时两个常量一起改
const PY_VERSION = '3.13.15';
const PY_SHA256 = 'edec09c4853aeae9ac36efb8c9f95b6b8e2fee65eee56d9767a8b7c69c574403';
const FILE_NAME = `python-${PY_VERSION}-amd64.exe`;

const FORCE = process.argv.includes('--force');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'src-tauri', 'resources', 'python');

// 幂等：DEST 下已有安装器则跳过（--force 时先清空重下）
const existing = existsSync(DEST)
  ? readdirSync(DEST).filter((f) => f.startsWith('python-') && f.endsWith('-amd64.exe'))
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

const downloadUrl = `https://www.python.org/ftp/python/${PY_VERSION}/${FILE_NAME}`;
console.log(`==> 下载 ${downloadUrl}`);

const pkgPath = path.join(tmpdir(), `python-${Date.now()}-${FILE_NAME}`);
try {
  const dl = await fetch(downloadUrl).catch((e) => fail(`下载请求失败：${e.message}`));
  if (!dl.ok) {
    const body = (await dl.text().catch(() => '')).slice(0, 300);
    fail(`下载失败：HTTP ${dl.status}${body ? ` — ${body}` : ''}`);
  }
  const buf = Buffer.from(await dl.arrayBuffer());
  // 安装器约 28MB；低于 10MB 视为错误页，拒绝落盘
  if (buf.length < 10 * 1024 * 1024) {
    fail(`下载内容异常偏小（${buf.length} 字节），疑似错误页`);
  }
  // 与官方发布页 SHA-256 逐位核验后再落盘
  const actual = createHash('sha256').update(buf).digest('hex');
  if (actual !== PY_SHA256) {
    fail(`SHA-256 校验失败：期望 ${PY_SHA256}，实际 ${actual}`);
  }
  console.log('==> SHA-256 校验通过');
  // 先落盘到系统临时目录，校验全部通过后再搬入 DEST（避免 DEST 出现半截文件）
  writeFileSync(pkgPath, buf);

  // 整体替换 DEST：先清旧目录再搬入，避免残留旧版本安装器被 pythoninstall 误取。
  // 用 copy 而非 rename：tmp 可能在别的盘符（跨卷 MoveFile 报 ENOENT）
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  copyFileSync(pkgPath, path.join(DEST, FILE_NAME));
  writeFileSync(path.join(DEST, 'VERSION'), PY_VERSION);
  console.log(`==> 完成：${FILE_NAME} -> ${path.join(DEST, FILE_NAME)}`);
} finally {
  rmSync(pkgPath, { force: true });
}
