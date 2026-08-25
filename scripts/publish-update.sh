#!/usr/bin/env bash
# 上传签名 updater 制品到 AIShell 云服务（自动更新开发文档 §8.3，仅 CI 的 publish-update 任务使用）。
#
# 流程：创建 draft → 逐平台上传（raw 制品字节 + .sig 的 base64 + SHA-256）→ complete 校验。
# 首期发布模式是「CI 上传 draft → 管理员在云服务 ReleasePanel 核对 → 管理员发布频道」，
# 本脚本不调用 publish。
#
# 用法：bash scripts/publish-update.sh <win制品> <mac-arm64制品> <mac-x64制品> <版本(不含v)> <更新说明文件> <完整commit>
# 环境变量（GitHub Secrets 注入）：
#   AISHELL_UPDATE_SERVER_URL     云服务地址（https，不带尾斜杠亦可）
#   AISHELL_UPDATE_PUBLISH_TOKEN  CI 发布令牌（明文只存在于受保护 Secret；日志绝不回显）
#
# 签名头说明：X-Update-Signature 是 .sig 文件内容原样透传 —— tauri bundler 写出的 .sig 本身
# 就是单行 base64（minisign 多行内容的整体编码），与 tauri-plugin-updater manifest 的
# signature 字段格式一致（插件验签时 base64 解码后按 minisign 格式解析）。切勿二次编码。
# 服务端保存 .sig 文本与制品 SHA-256，不保存私钥。
set -euo pipefail

WIN=$1; MAC_ARM=$2; MAC_X64=$3; VERSION=$4; NOTES_FILE=$5; COMMIT=$6

SERVER=${AISHELL_UPDATE_SERVER_URL:?缺少 AISHELL_UPDATE_SERVER_URL}
TOKEN=${AISHELL_UPDATE_PUBLISH_TOKEN:?缺少 AISHELL_UPDATE_PUBLISH_TOKEN}
SERVER=${SERVER%/}
CHANNEL=stable
REPO=khellendros97/aishell-cloud-enhance

fail() { echo "[publish-update] $*" >&2; exit 1; }

# 制品文件必须存在且带同名 .sig
require_pkg() {
  local label=$1 file=$2
  [ -n "$file" ] || fail "未找到 $label 的 updater 制品（构建是否未签名？tag 构建必须配置 TAURI_SIGNING_PRIVATE_KEY）"
  [ -f "$file" ] || fail "$label 制品文件不存在: $file"
  [ -f "${file}.sig" ] || fail "缺少签名文件 ${file}.sig"
}

require_pkg windows-x86_64 "$WIN"
require_pkg darwin-aarch64 "$MAC_ARM"
require_pkg darwin-x86_64 "$MAC_X64"

# 统一请求出口：--fail-with-body 让 4xx/5xx 的服务端中文错误直接进日志（令牌不回显）；
# --connect-timeout/--max-time 防止服务端接受连接但不响应时 curl 无限挂起（曾卡住 40+ 分钟）
api() {
  local method=$1 api_path=$2; shift 2
  curl -sS --connect-timeout 30 --max-time 900 --fail-with-body -X "$method" "$SERVER$api_path" \
    -H "Authorization: Bearer $TOKEN" "$@"
}

echo "[publish-update] 服务器: $SERVER  版本: $VERSION  频道: $CHANNEL  commit: ${COMMIT:0:12}…"

# 1. 创建 draft（重复版本号会被服务端拒绝——已发布版本不可覆盖）
NOTES_JSON=$(jq -Rs . < "$NOTES_FILE")
api POST /api/internal/updates/releases \
  -H 'Content-Type: application/json' \
  --data "{\"version\":\"$VERSION\",\"channel\":\"$CHANNEL\",\"notes\":$NOTES_JSON,\"sourceRepository\":\"$REPO\",\"sourceCommit\":\"$COMMIT\"}"
echo

# 2. 逐平台上传 raw updater 字节
upload() {
  local target=$1 file=$2
  local sig_file="${file}.sig" sha filename sig_b64
  sha=$(sha256sum "$file" | cut -d' ' -f1)
  filename=$(basename "$file")
  # 去掉可能的行尾换行，保持单行 base64 原样（见文件头说明）
  sig_b64=$(tr -d '\r\n' < "$sig_file")
  echo "[publish-update] 上传 $target <- $filename ($(du -h "$file" | cut -f1), sha256=${sha:0:12}…)"
  api PUT "/api/internal/updates/releases/$VERSION/artifacts/$target" \
    -H "X-Update-Channel: $CHANNEL" \
    -H "X-Update-Filename: $filename" \
    -H "X-Update-Signature: $sig_b64" \
    -H "X-Update-SHA256: $sha" \
    -H 'Content-Type: application/octet-stream' \
    --data-binary "@$file"
  echo
}

upload windows-x86_64 "$WIN"
upload darwin-aarch64 "$MAC_ARM"
upload darwin-x86_64 "$MAC_X64"

# 3. complete：服务端校验三个 target 的制品/签名/SHA-256/大小齐全，缺一即拒绝
api POST "/api/internal/updates/releases/$VERSION/complete" \
  -H "X-Update-Channel: $CHANNEL"
echo
echo "[publish-update] draft v$VERSION 已上传并通过 complete 校验；等待管理员在云服务 ReleasePanel 发布频道。"
