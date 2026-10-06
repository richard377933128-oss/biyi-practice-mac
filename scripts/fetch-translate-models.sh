#!/usr/bin/env bash
# 下载内置 NLLB 本地翻译模型到 www/models/（网页调试 + iOS 打包）
# 国内可：HF_ENDPOINT=https://hf-mirror.com bash scripts/fetch-translate-models.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/www/models"
ENDPOINT="${HF_ENDPOINT:-https://huggingface.co}"
ENDPOINT="${ENDPOINT%/}"
mkdir -p "$OUT"

download_file() {
  local repo="$1"
  local path="$2"
  local dest="$OUT/$repo/$path"
  mkdir -p "$(dirname "$dest")"
  if [[ -f "$dest" && -s "$dest" ]]; then
    echo "  skip $path"
    return 0
  fi
  local url="$ENDPOINT/$repo/resolve/main/$path"
  echo "  get  $path"
  curl -fL --retry 3 --retry-delay 2 -A 'biyi-practice-fetch' -o "$dest.partial" "$url"
  mv "$dest.partial" "$dest"
}

download_repo_files() {
  local repo="$1"
  shift
  echo "==> $repo"
  for path in "$@"; do
    download_file "$repo" "$path" || echo "  WARN fail $path"
  done
}

download_repo_files "Xenova/nllb-200-distilled-600M" \
  config.json tokenizer.json tokenizer_config.json special_tokens_map.json generation_config.json \
  onnx/encoder_model_quantized.onnx \
  onnx/decoder_model_merged_quantized.onnx

# 清掉不再使用的模型，避免打进 App
rm -rf \
  "$OUT/Xenova/opus-mt-zh-en" \
  "$OUT/Xenova/opus-mt-en-zh" \
  "$OUT/Xenova/m2m100_418M"

echo "models size: $(du -sh "$OUT" 2>/dev/null | awk '{print $1}')"
echo "OK → $OUT"
