#!/usr/bin/env bash
# Build, dev-sign, install and launch artipeek on an iPhone over the network (no cable): xcodebuild + `xcrun devicectl`.
#
# Once: pair the phone for wireless development (Xcode → Window → Devices and Simulators → "Connect via network").
# Then it shows as "available (paired)" in `xcrun devicectl list devices` while unlocked and on the same network.
#
# Device: DEVICE_ID=<identifier>, or DEVICE_NAME=<part of the name>, or the only available iPhone.
# Signing: development, -allowProvisioningUpdates with the App Store Connect API key from fastlane/.env if set.
# A development build registers its push token as "sandbox". SKIP_REGEN=1, SKIP_LAUNCH=1 skip those steps.
set -euo pipefail
cd "$(dirname "$0")/.."

SCHEME=Artipeek
PROJECT=Artipeek.xcodeproj
CONFIG="${CONFIG:-Debug}"
DERIVED="${DERIVED:-build/device}"
log() { printf '\033[36m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31merror: %s\033[0m\n' "$*" >&2; exit 1; }

BUNDLE_ID=$(sed -n 's/^[[:space:]]*ARTIPEEK_BUNDLE_ID[[:space:]]*=[[:space:]]*\([^[:space:]]*\).*/\1/p' Config/Local.xcconfig 2>/dev/null | tail -1)
[ -n "$BUNDLE_ID" ] || die "set ARTIPEEK_BUNDLE_ID in Config/Local.xcconfig"

resolve_device() {
  if [ -n "${DEVICE_ID:-}" ]; then echo "$DEVICE_ID"; return; fi
  local list ids n
  list="$(xcrun devicectl list devices 2>/dev/null | grep -i 'iphone' | grep -i 'available' || true)"
  [ -n "$list" ] || die "no available iPhone (unlocked, same network, paired for wireless development?)"
  if [ -n "${DEVICE_NAME:-}" ]; then
    list="$(printf '%s\n' "$list" | grep -i -- "$DEVICE_NAME")" || die "no available iPhone matching DEVICE_NAME='$DEVICE_NAME'"
  fi
  ids="$(printf '%s\n' "$list" | grep -oE '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}')"
  n="$(printf '%s\n' "$ids" | grep -c .)"
  [ "$n" -ge 1 ] || die "could not read a device identifier from devicectl"
  [ "$n" -eq 1 ] || { printf '%s\n' "$list" >&2; die "$n iPhones available: set DEVICE_NAME=… or DEVICE_ID=…"; }
  printf '%s\n' "$ids"
}

auth_args() {
  [ -f fastlane/.env ] || return 0
  set -a; . fastlane/.env; set +a
  [ -n "${ASC_KEY_ID:-}" ] && [ -n "${ASC_ISSUER_ID:-}" ] && [ -n "${ASC_KEY_PATH:-}" ] || return 0
  local key; key="$(cd "$(dirname "$ASC_KEY_PATH")" && pwd)/$(basename "$ASC_KEY_PATH")"
  [ -f "$key" ] || die "ASC_KEY_PATH points at a missing file"
  printf '%s' "-authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID -authenticationKeyPath $key"
}

DEV="$(resolve_device)"
log "Device: $DEV"
[ "${SKIP_REGEN:-0}" = 1 ] || { log "xcodegen"; xcodegen generate >/dev/null; }

# A local build counter in CFBundleVersion, so Settings shows which build is on the phone.
NUM=$(( $(cat .build-number 2>/dev/null || echo 0) + 1 )); echo "$NUM" > .build-number
log "Building ($CONFIG, build $NUM)"
# shellcheck disable=SC2046
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration "$CONFIG" -destination "id=$DEV" -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates $(auth_args) CURRENT_PROJECT_VERSION="$NUM" build -quiet

APP="$DERIVED/Build/Products/$CONFIG-iphoneos/$SCHEME.app"
[ -d "$APP" ] || die "built app not found at $APP"
log "Installing"
xcrun devicectl device install app --device "$DEV" "$APP"
[ "${SKIP_LAUNCH:-0}" = 1 ] || { log "Launching"; xcrun devicectl device process launch --device "$DEV" "$BUNDLE_ID"; }
log "Done"
