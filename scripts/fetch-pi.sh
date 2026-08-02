#!/usr/bin/env bash
# 下载 pi (earendil-works/pi) 的 Windows 分发版到 src-tauri/resources/pi/。
# 在 Git Bash 下执行：scripts/fetch-pi.sh
# zip 内全部旁车资源（theme/、assets/、node_modules/ 等）必须与 pi.exe 同级保留——整体解压即可满足。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="$ROOT_DIR/src-tauri/resources/pi"
TMP_ZIP="$(mktemp --suffix=.zip)"
trap 'rm -f "$TMP_ZIP"' EXIT

echo "==> 查询 earendil-works/pi 最新 release ..."
RELEASE_JSON="$(curl -fsSL https://api.github.com/repos/earendil-works/pi/releases/latest)"
TAG="$(printf '%s' "$RELEASE_JSON" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
if [ -z "$TAG" ]; then
  echo "!! 无法从 release 响应中解析 tag_name（可能触发了 GitHub API 限流）" >&2
  exit 1
fi
echo "==> 最新版本：$TAG"

if command -v jq >/dev/null 2>&1; then
  URL="$(printf '%s' "$RELEASE_JSON" | jq -r '.assets[] | select(.name == "pi-windows-x64.zip") | .browser_download_url' | head -n1)"
else
  URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*pi-windows-x64\.zip"' | sed -E 's/.*"[[:space:]]*:[[:space:]]*"([^"]*)"/\1/' | head -n1)"
fi
if [ -z "$URL" ]; then
  echo "!! release 中未找到资产 pi-windows-x64.zip" >&2
  exit 1
fi

echo "==> 下载 $URL"
curl -fsSL -o "$TMP_ZIP" "$URL"

echo "==> 解压到 $DEST_DIR"
mkdir -p "$DEST_DIR"
# Git Bash 的 /tmp 路径需要转成 Windows 路径再交给 powershell
WIN_ZIP="$(cygpath -w "$TMP_ZIP")"
WIN_DEST="$(cygpath -w "$DEST_DIR")"
powershell -NoProfile -Command "Expand-Archive -Force -LiteralPath '$WIN_ZIP' -DestinationPath '$WIN_DEST'"

# zip 顶层若嵌套一层目录（如 pi-win32-x64/）则摊平，保证 pi.exe 直接在 DEST_DIR 下
if [ ! -f "$DEST_DIR/pi.exe" ]; then
  shopt -s nullglob
  subdirs=( "$DEST_DIR"/*/ )
  if [ "${#subdirs[@]}" -eq 1 ] && [ -f "${subdirs[0]}pi.exe" ]; then
    inner="${subdirs[0]}"
    echo "==> 摊平嵌套目录：$inner"
    mv -f "$inner"* "$DEST_DIR"/
    mv -f "$inner".[!.]* "$DEST_DIR"/ 2>/dev/null || true
    rmdir "$inner" 2>/dev/null || true
  fi
fi

if [ ! -f "$DEST_DIR/pi.exe" ]; then
  echo "!! 解压后未找到 pi.exe，请检查 zip 内部结构" >&2
  exit 1
fi
printf '%s' "$TAG" > "$DEST_DIR/VERSION"
echo "==> 完成：pi $TAG -> $DEST_DIR/pi.exe（旁车资源同级保留）"
