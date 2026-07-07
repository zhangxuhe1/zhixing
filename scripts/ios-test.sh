#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../apps/ios"
xcodegen generate
SIM=$(xcrun simctl list devices available | grep -oE "iPhone [^(]+" | head -1 | xargs)
echo "▶ simulator: $SIM"
xcodebuild -project Zhixing.xcodeproj -scheme Zhixing \
  -destination "platform=iOS Simulator,name=$SIM" test
