#!/usr/bin/env bash
# 下载 pi (earendil-works/pi) 分发版到 src-tauri/resources/pi/（按当前平台自动选资产）。
# 实现已收敛到 fetch-pi.mjs（跨平台，npm run fetch-pi 与 tauri beforeBuildCommand 均走它），
# 本脚本只是手动执行入口的薄封装。用法：scripts/fetch-pi.sh [--force]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$SCRIPT_DIR/fetch-pi.mjs" "$@"
