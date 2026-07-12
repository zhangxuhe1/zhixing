#!/usr/bin/env bash
# Mac Catalyst Release 构建 + dmg 打包（docs/superpowers/specs/2026-07-12-mac-catalyst-dmg-design.md 第三节）。
#
# 默认 ad-hoc 签名（无 Apple 会员；Apple Silicon 可启动的最低要求，无需证书）。
# 将来办会员后零改动升级为可公开分发版：
#   MAC_SIGN_IDENTITY="Developer ID Application: ..." NOTARY_PROFILE=<notarytool store-credentials 的 profile 名> scripts/mac-dmg.sh
# 设了 MAC_SIGN_IDENTITY 即走 Developer ID 签名 + notarytool 公证 + 装订。
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT/apps/ios"
xcodegen generate

# 工程默认 CODE_SIGN_STYLE=Automatic 且无 Team：两个覆写缺一不可——只覆写身份不改风格，
# 会先死在"缺 development team"，根本到不了 ad-hoc（"-"）。
xcodebuild -project Zhixing.xcodeproj -scheme Zhixing -configuration Release \
  -destination 'generic/platform=macOS,variant=Mac Catalyst' \
  -derivedDataPath DerivedData/mac \
  CODE_SIGN_STYLE=Manual "CODE_SIGN_IDENTITY=${MAC_SIGN_IDENTITY:--}" \
  build

APP="DerivedData/mac/Build/Products/Release-maccatalyst/Zhixing.app"
# 版本号以产物 Info.plist 为准（不读 project.yml）——dmg 命名必须与实际装进盘里的一致
VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")

# 装盘布局：知行.app + /Applications 快捷方式（拖拽安装）。装盘前重命名不破坏签名，
# 且与 docs/mac-install.md 里的路径/xattr 命令保持一致。
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/知行.app"
ln -s /Applications "$STAGE/Applications"

mkdir -p "$ROOT/dist"
DMG="$ROOT/dist/Zhixing-$VERSION.dmg"
hdiutil create -volname "知行" -srcfolder "$STAGE" -ov -format UDZO "$DMG"

if [[ -n "${MAC_SIGN_IDENTITY:-}" ]]; then
  # Developer ID 路线：公证 + 装订（ad-hoc 构建不可公证，未设身份时不会走到这里）
  xcrun notarytool submit "$DMG" \
    --keychain-profile "${NOTARY_PROFILE:?设 MAC_SIGN_IDENTITY 时必须同时设 NOTARY_PROFILE}" --wait
  xcrun stapler staple "$DMG"
fi

echo "✅ $DMG"
