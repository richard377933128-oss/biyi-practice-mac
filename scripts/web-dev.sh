#!/usr/bin/env bash
# 网页调试：静态站 + TTS + 输入法代理 + 词典代理
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cleanup() {
  [[ -n "${IME_PID:-}" ]] && kill "$IME_PID" 2>/dev/null || true
  [[ -n "${TTS_PID:-}" ]] && kill "$TTS_PID" 2>/dev/null || true
  [[ -n "${DICT_PID:-}" ]] && kill "$DICT_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

python3 "$ROOT/desktop/scripts/ime.py" --listen 8765 &
IME_PID=$!
node "$ROOT/desktop/edge-tts-node.mjs" --listen 8767 &
TTS_PID=$!
node "$ROOT/scripts/dict-proxy.mjs" &
DICT_PID=$!
sleep 0.3
echo "web  http://127.0.0.1:8766/"
echo "ime  http://127.0.0.1:8765/__pte/ime-english"
echo "tts  http://127.0.0.1:8767/tts"
echo "dict http://127.0.0.1:8768/api/en-dict?q=hello"
# 静态站同域无 /api，页面里会回退直连有道/FreeDict；另开 8768 供手动调试
exec python3 -m http.server 8766 --directory "$ROOT/www"
