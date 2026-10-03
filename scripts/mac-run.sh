#!/usr/bin/env bash
# Builds the Mac notch app and launches it paired to a runner. The pairing link is passed to the app, never printed.
#   bash scripts/mac-run.sh            # the laptop's dev stack: http://127.0.0.1:$APP_PORT (start scripts/dev.sh first)
#   bash scripts/mac-run.sh --matrix   # the Matrix instance (its URL from logs/public-url on the Matrix computer)
#   bash scripts/mac-run.sh <link>     # an explicit pairing link (https://…/#token=…)
# Needs the Command Line Tools (xcode-select --install); no Xcode. See deploy/mac.md.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
say() { printf "\033[1;34m[mac]\033[0m %s\n" "$*"; }

envval() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
LINK=""
case "${1:-}" in
  --matrix)
    URL="$(matrix run -C "${MATRIX_DIR:-projects/canvas-agent}" -- cat logs/public-url 2>/dev/null | tr -d '\r\n' || true)"
    [ -n "$URL" ] || { say "no Matrix URL: bash scripts/matrix-deploy.sh first"; exit 1; } ;;
  http://*|https://*) LINK="$1" ;;
  "")
    PORT="$(envval APP_PORT)"; URL="http://127.0.0.1:${PORT:-15180}"
    lsof -nP -iTCP:"${PORT:-15180}" -sTCP:LISTEN >/dev/null 2>&1 || say "note: nothing listens on $URL yet (bash scripts/dev.sh); the app retries until it does" ;;
  *) say "usage: bash scripts/mac-run.sh [--matrix | <pairing link>]"; exit 1 ;;
esac
if [ -z "$LINK" ]; then
  TOKEN="$(envval RUNNER_TOKEN)"
  [ -n "$TOKEN" ] || { say "RUNNER_TOKEN missing from .env (bash scripts/bootstrap.sh)"; exit 1; }
  LINK="$URL/#token=$TOKEN"
fi

bash mac/build.sh
pkill -x CanvasAgent 2>/dev/null && sleep 0.5 || true
say "launching, paired to ${LINK%%#*}"
open -n "$ROOT/mac/dist/Canvas Agent.app" --args --pair "$LINK"
