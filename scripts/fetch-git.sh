#!/usr/bin/env bash
# 下载 Git for Windows 官方 64 位安装程序到 src-tauri/resources/git/（首启静默安装 Git Bash 用）。
# 实现已收敛到 fetch-git.mjs（跨平台，npm run fetch-git 与 tauri beforeBuildCommand 均走它），
# 本脚本只是手动执行入口的薄封装。用法：scripts/fetch-git.sh [--force]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/fetch-git.mjs" "$@"
