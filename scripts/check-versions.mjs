#!/usr/bin/env node
/**
 * 版本一致性校验（发布指南 §2.1 / 自动更新开发文档 §3：单一版本源）。
 * 自动更新的版本比较依赖同一 SemVer，发布 tag 前三处版本必须一致：
 *   package.json.version == src-tauri/tauri.conf.json.version == src-tauri/Cargo.toml.version
 *
 * 用法：
 *   node scripts/check-versions.mjs                  # 校验三处一致
 *   node scripts/check-versions.mjs --expect 0.4.2   # 额外校验与发布 tag（去掉 v）一致（CI 用）
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const readJson = (rel) => JSON.parse(readFileSync(path.join(root, rel), 'utf8'));

const pkg = readJson('package.json').version;
const tauri = readJson('src-tauri/tauri.conf.json').version;

const cargoText = readFileSync(path.join(root, 'src-tauri/Cargo.toml'), 'utf8');
const cargoMatch = cargoText.match(/^version\s*=\s*"([^"]+)"/m);
if (!cargoMatch) {
  console.error('[check-versions] src-tauri/Cargo.toml 未找到 [package] version 字段');
  process.exit(1);
}
const cargo = cargoMatch[1];

const expectIdx = process.argv.indexOf('--expect');
const expect = expectIdx >= 0 ? process.argv[expectIdx + 1] : null;

const problems = [];
if (pkg !== tauri) problems.push(`package.json (${pkg}) != tauri.conf.json (${tauri})`);
if (tauri !== cargo) problems.push(`tauri.conf.json (${tauri}) != Cargo.toml (${cargo})`);
if (expect && expect !== tauri) problems.push(`Git tag v${expect} != tauri.conf.json (${tauri})`);

if (problems.length > 0) {
  console.error('[check-versions] 版本不一致，发布前必须统一（未统一禁止创建发布 tag）：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`[check-versions] 版本一致：${tauri}${expect ? `（tag v${expect}）` : ''}`);
