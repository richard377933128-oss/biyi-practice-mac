#!/usr/bin/env bash
# 笔译训练 · 网页版一键启动（只监听 127.0.0.1，仅本机可访问）
# 双击项目根目录的「启动网页版.command」，或命令行：bash scripts/web-launch.sh
# 可重复双击：已在运行则直接打开浏览器，不会重复起服务
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

STATIC_PORT=8766
IME_PORT=8765
TTS_PORT=8767
DICT_PORT=8768
URL="http://127.0.0.1:${STATIC_PORT}/"

PY="$(command -v python3 || true)"
NODE="$(command -v node || true)"

port_up() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }

printf '\033]0;笔译训练 · 网页版\007'
echo "笔译训练 · 网页版"
echo "目录  ${ROOT}"
echo ""

if port_up "$STATIC_PORT"; then
  echo "网页版已经在运行了 → 直接打开浏览器"
  open "$URL"
  echo ""
  echo "地址：${URL}"
  echo "停止：双击「停止网页版.command」，或在运行它的终端窗口按 Control-C。"
  exit 0
fi

if [ -z "$PY" ]; then
  echo "找不到 python3，无法启动。请先安装 Xcode 命令行工具：xcode-select --install"
  read -r -p "按回车退出…" _
  exit 1
fi
if [ -z "$NODE" ]; then
  echo "找不到 node，无法启动朗读/词典代理。请先安装 Node.js：brew install node"
  read -r -p "按回车退出…" _
  exit 1
fi

PIDS=()
cleanup() {
  trap - EXIT INT TERM
  echo ""
  echo "正在停止服务…"
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  for pid in "${PIDS[@]:-}"; do [ -n "$pid" ] && wait "$pid" 2>/dev/null; done
  echo "已停止。"
}
trap cleanup EXIT INT TERM

# 名称 端口 命令…；端口已被占用则直接复用（例如桌面版已经起过）
start_service() {
  local name="$1" port="$2"; shift 2
  if port_up "$port"; then
    echo "· ${name}  端口 ${port} 已在运行，复用"
    return 0
  fi
  echo "· ${name}  端口 ${port}"
  "$@" &
  PIDS+=("$!")
}

start_service "输入法代理" "$IME_PORT" "$PY" "$ROOT/desktop/scripts/ime.py" --listen "$IME_PORT"
start_service "朗读代理" "$TTS_PORT" "$NODE" "$ROOT/desktop/edge-tts-node.mjs" --listen "$TTS_PORT"
start_service "词典代理" "$DICT_PORT" "$NODE" "$ROOT/scripts/dict-proxy.mjs"
start_service "网页静态站" "$STATIC_PORT" "$PY" -m http.server "$STATIC_PORT" --bind 127.0.0.1 --directory "$ROOT/www"
STATIC_PID="${PIDS[${#PIDS[@]}-1]}"

# 等静态站就绪（最多 8 秒）
for _ in 1 2 3 4 5 6 7 8; do port_up "$STATIC_PORT" && break; sleep 1; done
if ! port_up "$STATIC_PORT"; then
  echo ""
  echo "静态站没能起来，端口 ${STATIC_PORT} 可能被占用。先跑「停止网页版.command」再试。"
  read -r -p "按回车退出…" _
  exit 1
fi

open "$URL"
echo ""
echo "网页版已启动：${URL}"
echo "在这个窗口按 Control-C 可停止全部服务（或双击「停止网页版.command」）。"
echo "----------------------------------------"

wait "$STATIC_PID"
code=$?
if [ "$code" -ne 0 ]; then
  echo ""
  echo "静态站已退出（代码 ${code}）。"
  read -r -p "按回车退出…" _
fi
