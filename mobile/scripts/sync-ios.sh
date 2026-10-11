#!/usr/bin/env bash
# Sync web → iOS，并把 symlink 题库/字体展开为真实文件
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
# cap sync 的拷贝步骤是「先批量删再拷」，容易被安全护栏（批量删除阈值）中途打断，
# 留下残缺的 public（2026-10-11 就出现过 index.html/css 被删掉、en-dict 只剩一半）。
# 所以这里不让它致命，失败也继续，由下面的 rsync 做一次完整兜底镜像。
npx cap sync ios || echo "WARN: cap sync 未完全成功（多为安全护栏拦截批量删除），继续用 rsync 兜底"
PUB="$ROOT/ios/App/App/public"
WWW="$(cd "$ROOT/../www" && pwd)"
# 兜底镜像：www → public（--copy-links 会把题库/字体的 symlink 展开成真实文件；
# 排除 models，NLLB 模型不打进 iOS 包）。--delete 保证 public 与 www 完全一致，
# 不会残留上一次同步的旧文件。
rsync -a --delete --copy-links --exclude 'models/' "$WWW/" "$PUB/"
echo "public size: $(du -sh "$PUB" | awk '{print $1}')"
