#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
root="$PWD"

version="${G0D_VERSION:-$(node -p "JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version")}"
arch="${G0D_ARCH:-$(uname -m)}"
case "$arch" in
  arm64|aarch64)
    arch="arm64"
    swift_arch="arm64"
    node_arch="arm64"
    ;;
  x86_64|x64|amd64)
    arch="x64"
    swift_arch="x86_64"
    node_arch="x64"
    ;;
  *)
    echo "Unsupported macOS architecture: $arch" >&2
    exit 1
    ;;
esac

out_dir="${G0D_RELEASE_DIR:-$root/dist/release}"
stage_dir="${G0D_STAGE_DIR:-$root/dist/stage-macos-$arch}"
app="$stage_dir/G0DM0D3.app"
dmg="$out_dir/G0DM0D3-${version}-macos-${arch}.dmg"
cache="${TMPDIR:-/tmp}/g0dc0d3-swift-module-cache-${arch}"

rm -rf "$stage_dir"
mkdir -p "$out_dir" "$app/Contents/MacOS" "$app/Contents/Resources/Fonts" "$app/Contents/Resources/runtime/bench" "$cache"

echo "Building G0DM0D3.app v${version} (${arch})..."
xcrun swiftc -swift-version 5 -O -target "${swift_arch}-apple-macosx12.0" \
  -module-cache-path "$cache" \
  -framework Cocoa -framework WebKit -framework Quartz -framework Speech -framework AVFoundation -framework Security -framework UserNotifications \
  native/main.swift native/Dictation.swift native/ProviderKeychain.swift \
  -o "$app/Contents/MacOS/G0DM0D3"

cp public/brand-wordmark.ttf public/brand-wordmark-LICENSE.txt "$app/Contents/Resources/Fonts/"
cp native/Info.plist "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$app/Contents/Info.plist"
cp native/G0DC0D3.icns "$app/Contents/Resources/GodModeIcon.icns"
cp LICENSE THIRD_PARTY_LICENSES.md "$app/Contents/Resources/"

# Stage self-contained runtime (zero external npm dependencies)
rt="$app/Contents/Resources/runtime"
cp package.json LICENSE THIRD_PARTY_LICENSES.md "$rt/"
node -e "const fs=require('node:fs'),p=process.argv[1],v=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=v;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');" "$rt/package.json" "$version"
cp -R src public data fixtures "$rt/"
cp bench/*.mjs "$rt/bench/"

# Bundle Node.js 22.13+ binary matching target arch
node_bin="${G0D_NODE_BINARY:-}"
if [ -z "$node_bin" ]; then
  host_arch="$(uname -m)"
  if [ "$host_arch" = "$swift_arch" ] && command -v node >/dev/null 2>&1; then
    node_bin="$(command -v node)"
  else
    echo "G0D_NODE_BINARY is required when cross-packaging for $arch on $host_arch." >&2
    exit 1
  fi
fi

if [ ! -x "$node_bin" ]; then
  echo "Bundled Node binary is not executable: $node_bin" >&2
  exit 1
fi
cp "$node_bin" "$app/Contents/Resources/node"
chmod 755 "$app/Contents/Resources/node"

# Verify bundled Node matches target arch when lipo is available
if command -v lipo >/dev/null 2>&1; then
  node_archs="$(lipo -archs "$app/Contents/Resources/node" 2>/dev/null || true)"
  case " $node_archs " in
    *" $swift_arch "*) ;;
    *)
      echo "Bundled Node binary ($node_archs) does not contain $swift_arch slice." >&2
      exit 1
      ;;
  esac
fi

plutil -lint "$app/Contents/Info.plist"
plutil -lint native/G0DM0D3.entitlements
plutil -lint native/node.entitlements

sign_identity="${G0D_CODESIGN_IDENTITY:--}"
timestamp_flag=""
if [ "$sign_identity" != "-" ]; then
  timestamp_flag="--timestamp"
fi

# Sign inside-out: bundled Node binary first (with V8 JIT entitlements), then app bundle
# shellcheck disable=SC2086
codesign --force --options runtime $timestamp_flag --entitlements native/node.entitlements --sign "$sign_identity" "$app/Contents/Resources/node"
# shellcheck disable=SC2086
codesign --force --options runtime $timestamp_flag --entitlements native/G0DM0D3.entitlements --sign "$sign_identity" "$app"
codesign --verify --deep --strict --verbose=2 "$app"
touch "$app"

# Create compressed drag-to-Applications DMG
dmg_root="$stage_dir/dmg-root"
mkdir -p "$dmg_root"
cp -R "$app" "$dmg_root/G0DM0D3.app"
ln -s /Applications "$dmg_root/Applications"
rm -f "$dmg"
hdiutil create -volname "G0DM0D3" -srcfolder "$dmg_root" -ov -format UDZO "$dmg"

if [ "$sign_identity" != "-" ]; then
  codesign --force --timestamp --sign "$sign_identity" "$dmg"
fi

# Optional Apple notarization & stapling when Developer ID credentials are present
if [ "$sign_identity" != "-" ]; then
  if [ -n "${G0D_NOTARY_KEYCHAIN_PROFILE:-}" ]; then
    echo "Submitting $dmg for Apple notarization (profile: $G0D_NOTARY_KEYCHAIN_PROFILE)..."
    xcrun notarytool submit "$dmg" --keychain-profile "$G0D_NOTARY_KEYCHAIN_PROFILE" --wait
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg"
  elif [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ -n "${APPLE_APP_PASSWORD:-}" ]; then
    echo "Submitting $dmg for Apple notarization..."
    xcrun notarytool submit "$dmg" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
    xcrun stapler staple "$dmg"
    xcrun stapler validate "$dmg"
  fi
fi

echo "Packaged $dmg"
