#!/usr/bin/env bash
# From the laptop: show the Matrix app's current URL, check that it answers, and print the pairing QR.
# The token comes from the local .env, which is the one uploaded to Matrix.
#   bash scripts/matrix-pair.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
MATRIX_DIR="${MATRIX_DIR:-projects/canvas-agent}"

URL="$(matrix run -C "$MATRIX_DIR" -- cat logs/public-url 2>/dev/null | tr -d '\r\n' || true)"
[ -n "$URL" ] || { echo "[pair] the serve loop is not running on Matrix: bash scripts/matrix-deploy.sh"; exit 1; }
TOKEN="$(grep '^RUNNER_TOKEN=' .env | cut -d= -f2-)"
if curl -sf -m 10 -o /dev/null -H "authorization: Bearer $TOKEN" "$URL/api/health"; then
  echo "[pair] $URL is up"
else
  echo "[pair] $URL is not answering (or the token differs from Matrix's .env): bash scripts/matrix-deploy.sh"
fi
node scripts/pair.mjs "$URL" "$TOKEN" "$(grep '^APP_PORT=' .env | cut -d= -f2- || echo 15180)"
