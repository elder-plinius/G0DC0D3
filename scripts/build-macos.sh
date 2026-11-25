#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
app="${G0D_APP_OUTPUT:-$PWD/dist/G0DM0D3.app}"
cache="${TMPDIR:-/tmp}/g0dc0d3-swift-module-cache"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources" "$cache"
xcrun swiftc -swift-version 5 -O -target "$(uname -m)-apple-macosx12.0" -module-cache-path "$cache" -framework Cocoa -framework WebKit -framework Quartz -framework Speech -framework AVFoundation -framework Security native/main.swift native/Dictation.swift native/ProviderKeychain.swift -o "$app/Contents/MacOS/G0DM0D3"
mkdir -p "$app/Contents/Resources/Fonts"
cp public/brand-wordmark.ttf public/brand-wordmark-LICENSE.txt "$app/Contents/Resources/Fonts/"
cp native/Info.plist "$app/Contents/Info.plist"
cp native/G0DC0D3.icns "$app/Contents/Resources/GodModeIcon.icns"
cp LICENSE THIRD_PARTY_LICENSES.md "$app/Contents/Resources/"
plutil -lint "$app/Contents/Info.plist"
plutil -lint native/G0DM0D3.entitlements
sign_identity="${G0D_CODESIGN_IDENTITY:--}"
codesign --force --options runtime --entitlements native/G0DM0D3.entitlements --sign "$sign_identity" "$app"
codesign --verify --deep --strict "$app"
# Finder caches bundle icons by path. Mark the rebuilt package as changed.
touch "$app"
echo "Built $app"
