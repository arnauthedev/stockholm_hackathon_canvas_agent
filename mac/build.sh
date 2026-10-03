#!/usr/bin/env bash
# Builds "Canvas Agent.app", the Mac notch shell, with the Command Line Tools alone (no Xcode).
#   bash mac/build.sh          → mac/dist/Canvas Agent.app
# The icon is the PWA icon, converted with sips + iconutil (both ship with macOS). Signed ad hoc, so macOS
# asks for mic and camera again after a rebuild.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"
say() { printf "\033[1;34m[mac]\033[0m %s\n" "$*"; }

say "compiling (release)"
swift build -c release 2>&1 | grep -E "error|warning: unre|Compiling|Build complete" | tail -8

APP="$HERE/dist/Canvas Agent.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp .build/release/CanvasAgent "$APP/Contents/MacOS/CanvasAgent"
cp Info.plist "$APP/Contents/Info.plist"

ICONSET="$HERE/.build/AppIcon.iconset"
SRC="$HERE/../app/public/icons/icon-512.png"
if [ -f "$SRC" ]; then
  rm -rf "$ICONSET"; mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z "$s" "$s" "$SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    d=$((s * 2))
    [ "$d" -le 512 ] && sips -z "$d" "$d" "$SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
fi

codesign --force --sign - "$APP" 2>/dev/null
say "built $APP"
