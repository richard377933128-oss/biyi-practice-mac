#!/usr/bin/env bash
# 双击我 = 启动「笔译训练」网页版（自动打开浏览器）
cd "$(dirname "$0")" || exit 1
exec bash scripts/web-launch.sh
