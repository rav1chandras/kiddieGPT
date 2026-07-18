#!/usr/bin/env bash
# Build a Chrome Web Store submission zip containing ONLY runtime files.
#
# Why this exists: the working folder holds dev-only files that must never ship —
# most importantly local-settings.js, which sets portalBaseUrl to localhost and
# would silently send every portal call to a dead address in the shipped build.
#
#   ./build.sh          -> dist/kiddiegpt-<version>.zip
set -euo pipefail

cd "$(dirname "$0")"
VERSION=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
OUT_DIR="dist"
STAGE="$OUT_DIR/kiddiegpt-$VERSION"
ZIP="$OUT_DIR/kiddiegpt-$VERSION.zip"

# Everything the extension needs at runtime. Anything not listed here is excluded
# by construction (allowlist, not denylist — new dev files can't leak in).
FILES=(manifest.json background.js sidepanel.html sidepanel.js styles.css tutor-voice.js)
DIRS=(icons katex vendor)

rm -rf "$STAGE" "$ZIP"
mkdir -p "$STAGE"

for f in "${FILES[@]}"; do
  [ -f "$f" ] || { echo "ERROR: missing required file: $f" >&2; exit 1; }
  cp "$f" "$STAGE/"
done
for d in "${DIRS[@]}"; do
  [ -d "$d" ] || { echo "ERROR: missing required dir: $d" >&2; exit 1; }
  cp -R "$d" "$STAGE/"
done

# --- guards: fail loudly rather than ship something broken ---------------------
if [ -e "$STAGE/local-settings.js" ]; then
  echo "ERROR: local-settings.js made it into the build (would override the portal URL)." >&2
  exit 1
fi
if grep -rqE "sk-[A-Za-z0-9_-]{20,}" "$STAGE"; then
  echo "ERROR: an API key is present in the build output." >&2
  exit 1
fi
if grep -rqE "localhost:[0-9]+|127\.0\.0\.1" "$STAGE" --include="*.js" --include="*.html"; then
  echo "WARNING: build references localhost — check this is intentional." >&2
fi
# sidepanel.html loads local-settings.js; absent in the build it 404s harmlessly and
# portalBaseUrl() falls back to PORTAL_BASE_URL. Just confirm that fallback exists.
grep -q "PORTAL_BASE_URL" "$STAGE/sidepanel.js" || {
  echo "ERROR: PORTAL_BASE_URL fallback missing from sidepanel.js." >&2; exit 1; }

( cd "$STAGE" && zip -qr "../kiddiegpt-$VERSION.zip" . -x ".*" -x "__MACOSX/*" )

echo "Built $ZIP"
echo "  version : $VERSION"
echo "  size    : $(du -h "$ZIP" | cut -f1)"
echo "  files   : $(unzip -l "$ZIP" | tail -1 | awk '{print $2}')"
echo
echo "Load $STAGE unpacked at chrome://extensions to verify before uploading."
