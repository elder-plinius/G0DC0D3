#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
root="$PWD"

version="${G0D_VERSION:-$(node -p "JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version")}"
arch="${G0D_ARCH:-$(uname -m)}"
case "$arch" in
  x86_64|x64|amd64)
    arch="x64"
    deb_arch="amd64"
    ;;
  arm64|aarch64)
    arch="arm64"
    deb_arch="arm64"
    ;;
  *)
    echo "Unsupported Linux architecture: $arch" >&2
    exit 1
    ;;
esac

node_bin="${G0D_NODE_BINARY:-$(command -v node || true)}"
if [ -z "$node_bin" ] || [ ! -x "$node_bin" ]; then
  echo "G0D_NODE_BINARY (or node in PATH) is required to package Linux bundles." >&2
  exit 1
fi

out_dir="${G0D_RELEASE_DIR:-$root/dist/release}"
stage_dir="${G0D_STAGE_DIR:-$root/dist/stage-linux-$arch}"
pkg_name="g0dm0d3-${version}-linux-${arch}"
bundle="$stage_dir/$pkg_name"

rm -rf "$stage_dir"
mkdir -p "$out_dir" "$bundle/bin" "$bundle/runtime/bench" \
  "$bundle/share/applications" "$bundle/share/icons/hicolor/scalable/apps"

echo "Packaging G0DM0D3 v${version} for Linux (${arch})..."

# Stage self-contained runtime + Node 22.13+ binary
cp "$node_bin" "$bundle/bin/node"
chmod 755 "$bundle/bin/node"

rt="$bundle/runtime"
cp package.json LICENSE THIRD_PARTY_LICENSES.md "$rt/"
node -e "const fs=require('node:fs'),p=process.argv[1],v=process.argv[2],j=JSON.parse(fs.readFileSync(p,'utf8'));j.version=v;fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');" "$rt/package.json" "$version"
cp -R src public data fixtures "$rt/"
cp bench/*.mjs "$rt/bench/"

# Launcher script (works from both extracted tarball and /opt/g0dm0d3 .deb install)
cat > "$bundle/bin/g0dm0d3" <<'LAUNCHER'
#!/bin/sh
set -eu

resolve_dir() {
  target="$1"
  while [ -L "$target" ]; do
    link="$(readlink "$target")"
    case "$link" in
      /*) target="$link" ;;
      *) target="$(dirname "$target")/$link" ;;
    esac
  done
  cd "$(dirname "$target")/.." && pwd
}

prefix="$(resolve_dir "$0")"
export DO_NOT_TRACK=1
export OTEL_SDK_DISABLED=true
export DISABLE_TELEMETRY=1
export G0D_DATA_DIR="${G0D_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/g0dc0d3}"
mkdir -p "$G0D_DATA_DIR"
chmod 700 "$G0D_DATA_DIR" 2>/dev/null || true

if [ "${1:-}" = "cli" ]; then
  shift
  exec "$prefix/bin/node" "$prefix/runtime/src/cli.mjs" "$@"
fi

if ! command -v bwrap >/dev/null 2>&1; then
  printf '%s\n' "Tip: install bubblewrap (e.g. sudo apt install bubblewrap) to enable scoped Linux command sandboxing." >&2
fi

cd "$prefix/runtime"
exec "$prefix/bin/node" "$prefix/runtime/src/server.mjs" "$@"
LAUNCHER
chmod 755 "$bundle/bin/g0dm0d3"

cp public/lysios-mark-canonical-ink.svg "$bundle/share/icons/hicolor/scalable/apps/g0dm0d3.svg"

cat > "$bundle/share/applications/g0dm0d3.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=G0DM0D3
GenericName=Local Coding Harness
Comment=Local-first coding harness and prompt-transparency studio
Exec=g0dm0d3
Icon=g0dm0d3
Terminal=true
Categories=Development;IDE;
StartupNotify=false
DESKTOP

tarball="$out_dir/${pkg_name}.tar.gz"
rm -f "$tarball"
tar -C "$stage_dir" -czf "$tarball" "$pkg_name"
echo "Packaged $tarball"

# Build .deb package when dpkg-deb is available
if command -v dpkg-deb >/dev/null 2>&1; then
  deb_root="$stage_dir/deb-root"
  mkdir -p "$deb_root/DEBIAN" "$deb_root/opt/g0dm0d3" "$deb_root/usr/bin" \
    "$deb_root/usr/share/applications" "$deb_root/usr/share/icons/hicolor/scalable/apps"
  cp -R "$bundle/bin" "$bundle/runtime" "$deb_root/opt/g0dm0d3/"
  ln -s /opt/g0dm0d3/bin/g0dm0d3 "$deb_root/usr/bin/g0dm0d3"
  cp "$bundle/share/applications/g0dm0d3.desktop" "$deb_root/usr/share/applications/g0dm0d3.desktop"
  cp "$bundle/share/icons/hicolor/scalable/apps/g0dm0d3.svg" "$deb_root/usr/share/icons/hicolor/scalable/apps/g0dm0d3.svg"

  installed_kb="$(du -sk "$deb_root/opt/g0dm0d3" | awk '{print $1}')"
  cat > "$deb_root/DEBIAN/control" <<CONTROL
Package: g0dm0d3
Version: ${version}
Section: devel
Priority: optional
Architecture: ${deb_arch}
Installed-Size: ${installed_kb}
Maintainer: G0DC0D3 Maintainers <https://github.com/elder-plinius/G0DC0D3>
Homepage: https://github.com/elder-plinius/G0DC0D3
Recommends: bubblewrap, libsecret-tools, xdg-utils
Description: Local-first durable coding harness and prompt-transparency studio
 Self-contained G0DM0D3 / G0DC0D3 runtime with bundled Node.js 22,
 zero telemetry, and scoped Linux bubblewrap execution.
CONTROL

  deb_path="$out_dir/g0dm0d3_${version}_${deb_arch}.deb"
  rm -f "$deb_path"
  dpkg-deb --build --root-owner-group "$deb_root" "$deb_path"
  echo "Packaged $deb_path"
fi
