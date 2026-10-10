#!/usr/bin/env bash
# 双击我 = 停止「笔译训练」网页版的全部本地服务
cd "$(dirname "$0")" || exit 1
exec bash scripts/web-stop.sh
