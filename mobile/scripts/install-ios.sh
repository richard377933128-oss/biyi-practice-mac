#!/usr/bin/env bash
# 一键装机：同步网页 → 编译 → 安装到 iPhone → 启动
#
# 用法：
#   bash scripts/install-ios.sh                  # 默认设备 Mr.lee 16 PM，含同步
#   bash scripts/install-ios.sh yida             # 指定设备（别名 / 名称片段 / devicectl ID / 硬件 UDID）
#   bash scripts/install-ios.sh --no-sync        # 跳过同步，直接编译 + 安装（快）
#   bash scripts/install-ios.sh --no-launch      # 装完不自动启动
#   bash scripts/install-ios.sh --list           # 列出已配对设备
#
# 注意：Capacitor 首次跑 sync 会弹匿名统计交互提示把脚本卡住，这里用 CI=1 屏蔽；
#       若仍被卡住，执行一次 `npx cap telemetry off` 即可永久关闭。
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"   # mobile/
cd "$ROOT"

SCHEME="App"
WORKSPACE="$ROOT/ios/App/App.xcworkspace"
DERIVED_DATA="$ROOT/ios/build/DerivedData"
APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphoneos/$SCHEME.app"
BUNDLE_ID="com.jinbaoli.biyixunlian"

DDL="xcrun devicectl"

# 别名|显示名|devicectl Identifier|xcodebuild 硬件 UDID
DEVICES=(
  "lee|Mr.lee 16 PM|9176CE34-9BF3-5ECE-814E-8034F7FF87E1|00008140-000139213AE0801C"
  "yida|益达的iPhone|D8B6372F-0A69-57F3-9728-B54F2BF54C81|00008110-0010382C2121A01E"
)

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
  echo
  echo "可用设备别名："
  for row in "${DEVICES[@]}"; do
    IFS='|' read -r alias name _ _ <<<"$row"
    printf '  %-6s %s\n' "$alias" "$name"
  done
}

list_devices() {
  echo "== devicectl 已配对设备 =="
  $DDL list devices 2>/dev/null || true
  echo
  echo "== 本脚本内置别名 =="
  for row in "${DEVICES[@]}"; do
    IFS='|' read -r alias name dcid udid <<<"$row"
    printf '  %-6s %-14s devicectl=%s  udid=%s\n' "$alias" "$name" "$dcid" "$udid"
  done
}

TARGET="lee"
DO_SYNC=1
DO_LAUNCH=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-sync)   DO_SYNC=0 ;;
    --no-launch) DO_LAUNCH=0 ;;
    --list|-l)   list_devices; exit 0 ;;
    --help|-h)   usage; exit 0 ;;
    -*)          echo "未知参数：$1" >&2; usage >&2; exit 1 ;;
    *)           TARGET="$1" ;;
  esac
  shift
done

# ---- 解析目标设备 ----
resolve_device() {
  local key="$1" row alias name dcid udid
  for row in "${DEVICES[@]}"; do
    IFS='|' read -r alias name dcid udid <<<"$row"
    if [[ "$key" == "$alias" || "$key" == "$dcid" || "$key" == "$udid" ]]; then
      echo "$row"; return 0
    fi
  done
  # 退化到名称模糊匹配
  local lower_key
  lower_key="$(printf '%s' "$key" | tr '[:upper:]' '[:lower:]')"
  for row in "${DEVICES[@]}"; do
    IFS='|' read -r alias name dcid udid <<<"$row"
    local lower_name
    lower_name="$(printf '%s' "$name" | tr '[:upper:]' '[:lower:]')"
    if [[ "$lower_name" == *"$lower_key"* ]]; then
      echo "$row"; return 0
    fi
  done
  return 1
}

if ! SELECTED="$(resolve_device "$TARGET")"; then
  echo "找不到设备：$TARGET" >&2
  echo >&2
  list_devices >&2
  exit 1
fi
IFS='|' read -r DEV_ALIAS DEV_NAME DEVICECTL_ID DEVICE_UDID <<<"$SELECTED"
echo "目标设备：$DEV_NAME  (alias=$DEV_ALIAS, udid=$DEVICE_UDID)"

# ---- 1. 同步网页 ----
if [[ "$DO_SYNC" == 1 ]]; then
  echo "==> [1/4] 同步网页到 iOS 工程"
  CI=1 npm run sync
else
  echo "==> [1/4] 跳过同步 (--no-sync)"
fi

# ---- 2. 编译 ----
echo "==> [2/4] 编译 $SCHEME"
xcodebuild \
  -workspace "$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Debug \
  -destination "id=$DEVICE_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -allowProvisioningUpdates \
  build \
  | tail -5

if [[ ! -d "$APP_PATH" ]]; then
  echo "构建产物不存在：$APP_PATH" >&2
  exit 1
fi
echo "    产物 $APP_PATH  ($(du -sh "$APP_PATH" | awk '{print $1}'))"

# ---- 3. 安装 ----
echo "==> [3/4] 安装到 $DEV_NAME"
$DDL device install app --device "$DEVICECTL_ID" "$APP_PATH"

# ---- 4. 启动 ----
if [[ "$DO_LAUNCH" == 1 ]]; then
  echo "==> [4/4] 启动 $BUNDLE_ID"
  $DDL device process launch --device "$DEVICECTL_ID" "$BUNDLE_ID"
else
  echo "==> [4/4] 跳过启动 (--no-launch)"
fi

echo
echo "完成：${DEV_NAME} 已安装最新版本（${BUNDLE_ID}）"
