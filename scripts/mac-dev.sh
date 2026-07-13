#!/usr/bin/env bash
# Mac Catalyst Debug 构建 + 启动。用于界面调整后的快速本机走查，不生成 dmg。
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
IOS_DIR="$ROOT/apps/ios"
DERIVED_DATA="$IOS_DIR/DerivedData/mac-dev"
APP="$DERIVED_DATA/Build/Products/Debug-maccatalyst/Zhixing.app"
APP_EXECUTABLE="$APP/Contents/MacOS/Zhixing"
API_HEALTH_URL="${ZHIXING_DEV_API_HEALTH_URL:-http://localhost:8787/health}"

if curl --silent --fail --max-time 2 "$API_HEALTH_URL" >/dev/null; then
  echo "✅ 本地 API 可用：$API_HEALTH_URL"
else
  echo "⚠️  本地 API 尚未运行；App 仍会启动，但开发登录和数据请求不可用。"
  echo "   另开终端运行：ZHIXING_DEV_AUTH=1 pnpm --filter @zhixing/api dev"
fi

cd "$IOS_DIR"
xcodegen generate

xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -configuration Debug \
  -destination 'generic/platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath "$DERIVED_DATA" \
  CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY="-" \
  build

if [[ ! -d "$APP" ]]; then
  echo "❌ 构建完成但未找到 App：$APP" >&2
  exit 1
fi

# 旧 Debug 实例可能仍指向上一版二进制；只匹配本次 DerivedData 产物的完整路径，
# 避免误关 /Applications 里安装的正式版或其他同名进程。
if pgrep -f -x "$APP_EXECUTABLE" >/dev/null; then
  echo "⏹  正在退出旧的 Zhixing 实例…"
  pkill -TERM -f -x "$APP_EXECUTABLE"
  for _ in {1..30}; do
    if ! pgrep -f -x "$APP_EXECUTABLE" >/dev/null; then break; fi
    sleep 0.1
  done
  if pgrep -f -x "$APP_EXECUTABLE" >/dev/null; then
    echo "❌ 旧的 Zhixing 实例未能退出，请手动关闭后重试。" >&2
    exit 1
  fi
fi

open -n "$APP"
for _ in {1..30}; do
  if pgrep -f -x "$APP_EXECUTABLE" >/dev/null; then
    echo "✅ 已启动 Debug Catalyst App：$APP"
    exit 0
  fi
  sleep 0.1
done

echo "❌ App 未成功启动，请检查 macOS 弹窗或系统日志。" >&2
exit 1
