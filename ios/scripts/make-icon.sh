#!/usr/bin/env bash
# Renders the app icon from artipeek's assets/icon.svg (the "peek" eye) at 1024 px, the one size Xcode needs.
# iOS rounds the corners itself, so the square is drawn full-bleed and without alpha (App Store rule).
# Needs rsvg-convert and ImageMagick (brew install librsvg imagemagick).
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=Artipeek/Assets.xcassets/AppIcon.appiconset/icon-1024.png
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
sed 's/ rx="14"//' ../assets/icon.svg > "$TMP/icon.svg"
rsvg-convert -w 1024 -h 1024 "$TMP/icon.svg" -o "$TMP/icon.png"
magick "$TMP/icon.png" -background '#0550ae' -alpha remove -alpha off "$OUT"
echo "wrote $OUT"
