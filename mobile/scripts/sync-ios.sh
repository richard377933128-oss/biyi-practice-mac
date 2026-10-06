#!/usr/bin/env bash
# Sync web → iOS，并把 symlink 题库/字体展开为真实文件
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
npx cap sync ios
PUB="$ROOT/ios/App/App/public"
WWW="$(cd "$ROOT/../www" && pwd)"
rm -rf "$PUB/data/banks" "$PUB/fonts"
mkdir -p "$PUB/data/banks" "$PUB/fonts"
rsync -a --copy-links "$WWW/data/banks/" "$PUB/data/banks/"
rsync -a --copy-links "$WWW/fonts/" "$PUB/fonts/"
if [[ -d "$WWW/models" ]]; then
  # iPhone WKWebView 跑不下 NLLB（约需 3GB 内存会被系统杀掉），模型不打进 iOS 包
  rm -rf "$PUB/models"
  echo "skip www/models on iOS (NLLB WASM OOMs in WKWebView; use Apple Translation locally)"
else
  rm -rf "$PUB/models"
  echo "WARN: www/models missing (desktop/web NLLB only)"
fi
echo "public size: $(du -sh "$PUB" | awk '{print $1}')"
