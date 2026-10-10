#!/usr/bin/env bash
# 笔译训练 · 网页版停止：按端口找到本机服务并优雅结束
# 双击项目根目录的「停止网页版.command」，或命令行：bash scripts/web-stop.sh
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

PORTS=(8766 8765 8767 8768)
NAMES=(网页静态站 输入法代理 朗读代理 词典代理)

found=0
for i in "${!PORTS[@]}"; do
  port="${PORTS[$i]}"
  pids="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ -z "$pids" ] && continue
  found=1
  for pid in $pids; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-90)"
    echo "· 停止 ${NAMES[$i]}（端口 ${port}，PID ${pid}）"
    echo "  ${cmd}"
    kill "$pid" 2>/dev/null
  done
done

if [ "$found" -eq 0 ]; then
  echo "网页版没有在运行。"
  exit 0
fi

sleep 1
for port in "${PORTS[@]}"; do
  leftover="$(lsof -nP -iTCP:"${port}" -sTCP:LISTEN -t 2>/dev/null || true)"
  for pid in $leftover; do
    echo "· 仍未退出，强制结束 PID ${pid}（端口 ${port}）"
    kill -9 "$pid" 2>/dev/null
  done
done
echo "已全部停止。"
