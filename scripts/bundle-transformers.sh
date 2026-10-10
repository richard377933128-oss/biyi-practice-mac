#!/usr/bin/env bash
# 重新打包 @huggingface/transformers 为 WKWebView 可用的自包含 ESM
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/www/js/vendor/transformers"
WORKDIR="${TMPDIR:-/tmp}/biyi-tf-bundle-$$"
mkdir -p "$OUT" "$WORKDIR"
cd "$WORKDIR"
npm init -y >/dev/null
npm install @huggingface/transformers@3.7.2 esbuild@0.25.0 --no-fund --no-audit
npx esbuild node_modules/@huggingface/transformers/dist/transformers.web.js \
  --bundle --format=esm --platform=browser \
  --outfile="$OUT/transformers.bundle.js" \
  --external:sharp --external:onnxruntime-node
cp -f node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm "$OUT/" || true
cp -f node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs "$OUT/" || true
cp -f node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm "$OUT/" || true
cp -f node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs "$OUT/" || true
echo "OK → $OUT/transformers.bundle.js ($(du -h "$OUT/transformers.bundle.js" | awk '{print $1}'))"
rm -rf "$WORKDIR"
