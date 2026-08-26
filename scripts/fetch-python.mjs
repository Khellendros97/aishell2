#!/usr/bin/env node
/**
 * 拉取 Python 官方 embeddable 包并预解压到 src-tauri/resources/python-embed/。
 * 用途：作为 Windows 免安装内置运行时随安装包分发（pythoninstall.rs find_python 探测兜底，
 * ai_actions 的 py 工具经 PYTHONPATH 注入 pysdk——故解压后删除 python313._pth，
 * 否则 embeddable 忽略 PYTHONPATH，SDK 不可导入）。
 * 目录不入库，见根 .gitignore；非 Windows 平台直接跳过（macOS/Linux 走系统 python3）。
 * 构建前门（tauri.conf.json beforeBuildCommand 调用）：
 * - 已存在同版本产物（python.exe + VERSION 匹配）时跳过（幂等，本机构建零开销）；
 * - 缺失时按镜像顺序下载固定版本：npmmirror → 华为云 → python.org（国内网络优先命中镜像），
 *   SHA-256 与脚本内硬编码值核验后解压
 *   （硬编码值取自 https://www.python.org/downloads/release/python-31315/ 官方 Files 表格；
 *   升级版本时同步更新 PY_VERSION 与 PY_SHA256 两个常量）。
 * 强制更新：node scripts/fetch-python.mjs --force。
 * 不依赖 Git Bash：下载走 Node fetch，解压走系统 PowerShell Expand-Archive。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 固定版本 + 官方 SHA-256（python.org release 页 Files 表格的 embed-amd64.zip），升级时两个常量一起改
const PY_VERSION = '3.13.15';
const PY_SHA256 = 'd1f04d990aee1253d8569e8e5104e30fa9f5fa830899f14843448872d936a2cf';
const FILE_NAME = `python-${PY_VERSION}-embed-amd64.zip`;

// 下载源按序回退：npmmirror（国内快）→ 华为云 → python.org 官方
const DOWNLOAD_URLS = [
  `https://registry.npmmirror.com/-/binary/python/${PY_VERSION}/${FILE_NAME}`,
  `https://mirrors.huaweicloud.com/python/${PY_VERSION}/${FILE_NAME}`,
  `https://www.python.org/ftp/python/${PY_VERSION}/${FILE_NAME}`,
];

const FORCE = process.argv.includes('--force');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'src-tauri', 'resources', 'python-embed');

// 内置运行时只在 Windows 打包/开发用到，其余平台直接跳过（避免 mac 构建白拉 11MB）
if (process.platform !== 'win32') {
  console.log(`==> 非 Windows 平台（${process.platform}），跳过 Python 内置运行时拉取`);
  process.exit(0);
}

// 幂等：DEST 下已有同版本产物则跳过（--force 时先清空重下）
function readText(p) {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}
const versionFile = path.join(DEST, 'VERSION');
if (
  !FORCE &&
  existsSync(path.join(DEST, 'python.exe')) &&
  existsSync(versionFile) &&
  readText(versionFile) === PY_VERSION
) {
  console.log(`==> ${DEST} 已是 ${PY_VERSION}，跳过（强制更新请用 --force）`);
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

/** 逐源尝试下载，全部失败时 fail（带每个源的失败原因） */
async function download() {
  const errors = [];
  for (const url of DOWNLOAD_URLS) {
    console.log(`==> 尝试下载 ${url}`);
    const dl = await fetch(url).catch((e) => {
      errors.push(`${url}：${e.message}`);
      return null;
    });
    if (!dl || !dl.ok) {
      if (dl) errors.push(`${url}：HTTP ${dl.status}`);
      continue;
    }
    const buf = Buffer.from(await dl.arrayBuffer());
    // embed zip 约 11MB；低于 5MB 视为错误页，拒绝落盘
    if (buf.length < 5 * 1024 * 1024) {
      errors.push(`${url}：内容异常偏小（${buf.length} 字节）`);
      continue;
    }
    // 与官方发布页 SHA-256 逐位核验（镜像只当加速，完整性仍以官方值为准）
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== PY_SHA256) {
      errors.push(`${url}：SHA-256 校验失败（实际 ${actual}）`);
      continue;
    }
    console.log('==> SHA-256 校验通过');
    return buf;
  }
  fail(`全部下载源失败：\n  ${errors.join('\n  ')}`);
}

const buf = await download();

// 先落盘到系统临时目录，再整体替换 DEST（避免 DEST 出现半截解压）
const zipPath = path.join(tmpdir(), `python-embed-${Date.now()}-${FILE_NAME}`);
writeFileSync(zipPath, buf);
try {
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  // 用 PowerShell Expand-Archive 解压：不能用 tar——npm 脚本常跑在 Git Bash 里，
  // PATH 上的 GNU tar 会把 "C:" 盘符当远程主机名（"Cannot connect to C"），
  // 而 System32 bsdtar 与 GNU tar 参数又不兼容；Expand-Archive 在 Win10+ 恒可用
  console.log(`==> 解压到 ${DEST}`);
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'Expand-Archive',
      '-LiteralPath', zipPath, '-DestinationPath', DEST, '-Force'],
    { stdio: 'inherit' },
  );
  // 删除 python313._pth：embeddable 默认隔离模式会忽略 PYTHONPATH，py 工具的
  // pysdk 注入（ai_actions PYTHONPATH）必须走常规路径解析
  const pthFiles = readdirSync(DEST).filter((f) => /^python\d+\._pth$/i.test(f));
  for (const f of pthFiles) unlinkSync(path.join(DEST, f));
  if (pthFiles.length > 0) console.log(`==> 已删除 ${pthFiles.join('、')}（恢复 PYTHONPATH 支持）`);
  if (!existsSync(path.join(DEST, 'python.exe'))) {
    fail('解压后未找到 python.exe，产物结构异常');
  }
  writeFileSync(path.join(DEST, 'VERSION'), PY_VERSION);
  console.log(`==> 完成：${FILE_NAME} -> ${DEST}（${PY_VERSION}）`);
} finally {
  rmSync(zipPath, { force: true });
}
