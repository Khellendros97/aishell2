#!/usr/bin/env node
/**
 * 拉取 Git for Windows 官方便携版（PortableGit-<version>-64-bit.7z.exe，自解压档案）
 * 并预解压到 src-tauri/resources/git-portable/。
 * 用途：作为 Windows 免安装内置 bash 随安装包分发（term.rs find_shell 探测兜底，
 * 解压即用、免管理员权限、不写注册表）。目录不入库，见根 .gitignore；
 * 非 Windows 平台直接跳过（macOS/Linux 走系统 shell）。
 * 构建前门（tauri.conf.json beforeBuildCommand 调用）：
 * - 已存在同版本产物（bin/bash.exe + VERSION 匹配）时跳过（幂等，本机构建零开销）；
 * - 缺失时按镜像顺序下载固定版本：npmmirror → 清华 tuna → GitHub 官方
 *   （国内网络优先命中镜像），SHA-256 与脚本内硬编码值核验后静默解压
 *   （SFX 参数 -o <目录> -y；硬编码值取自官方 release 页，升级时同步更新
 *   GIT_TAG / GIT_FILE / GIT_SHA256 三个常量——不再运行时解析 latest，
 *   可复现且国内网络无需访问 GitHub 页面）。
 * 强制更新：node scripts/fetch-git.mjs --force（等价于手动跑 scripts/fetch-git.sh）。
 * 不依赖 Git Bash：下载走 Node fetch，解压走 SFX 自身。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 固定版本 + 官方 SHA-256（git-for-windows release 页资产 digest），升级时三个常量一起改
const GIT_TAG = 'v2.55.0.windows.5';
const GIT_FILE = 'PortableGit-2.55.0.5-64-bit.7z.exe';
const GIT_SHA256 = '5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290';

// 下载源按序回退：npmmirror（国内快）→ 清华 tuna github-release 镜像 → GitHub 官方
const DOWNLOAD_URLS = [
  `https://registry.npmmirror.com/-/binary/git-for-windows/${GIT_TAG}/${GIT_FILE}`,
  `https://mirrors.tuna.tsinghua.edu.cn/github-release/git-for-windows/git/${GIT_TAG}/${GIT_FILE}`,
  `https://github.com/git-for-windows/git/releases/download/${GIT_TAG}/${GIT_FILE}`,
];

const FORCE = process.argv.includes('--force');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'src-tauri', 'resources', 'git-portable');

// 内置 bash 只在 Windows 打包/开发用到，其余平台直接跳过（避免 mac 构建白拉 59MB）
if (process.platform !== 'win32') {
  console.log(`==> 非 Windows 平台（${process.platform}），跳过 PortableGit 拉取`);
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

function readText(p) {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
}

// 幂等：DEST 下已有同版本产物则跳过（--force 时清空重下）
const versionFile = path.join(DEST, 'VERSION');
if (
  !FORCE &&
  existsSync(path.join(DEST, 'bin', 'bash.exe')) &&
  existsSync(versionFile) &&
  readText(versionFile) === GIT_TAG
) {
  console.log(`==> ${DEST} 已是 ${GIT_TAG}，跳过（强制更新请用 --force）`);
  process.exit(0);
}

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
    // SFX 约 59MB；低于 10MB 视为错误页/限流页，拒绝落盘
    if (buf.length < 10 * 1024 * 1024) {
      errors.push(`${url}：内容异常偏小（${buf.length} 字节）`);
      continue;
    }
    // 与官方 release 页 SHA-256 逐位核验（镜像只当加速，完整性仍以官方值为准）
    const actual = createHash('sha256').update(buf).digest('hex');
    if (actual !== GIT_SHA256) {
      errors.push(`${url}：SHA-256 校验失败（实际 ${actual}）`);
      continue;
    }
    console.log('==> SHA-256 校验通过');
    return buf;
  }
  fail(`全部下载源失败：\n  ${errors.join('\n  ')}`);
}

const buf = await download();

// 先落盘到系统临时目录，校验全部通过后再解压（避免 DEST 出现半截解压）
const sfxPath = path.join(tmpdir(), `portablegit-${Date.now()}-${GIT_FILE}`);
writeFileSync(sfxPath, buf);
try {
  rmSync(DEST, { recursive: true, force: true });
  mkdirSync(DEST, { recursive: true });
  // SFX 静默解压：-o 指定目标目录、-y 全部确认（git-for-windows 官方程序化解压用法），
  // 输出直通终端便于 CI 观察进度；解压约 30–90 秒
  console.log(`==> 解压到 ${DEST}（约 30–90 秒）`);
  execFileSync(sfxPath, ['-o', DEST, '-y'], { stdio: 'inherit' });
  if (!existsSync(path.join(DEST, 'bin', 'bash.exe'))) {
    fail('解压后未找到 bin/bash.exe，产物结构异常');
  }
  writeFileSync(path.join(DEST, 'VERSION'), GIT_TAG);
  console.log(`==> 完成：${GIT_FILE}（${GIT_TAG}）-> ${DEST}`);
} finally {
  rmSync(sfxPath, { force: true });
}
