#!/usr/bin/env bash
# Quick HTTPS tunnel to localhost:$1 with whatever tool exists. Prints the tool's log to stdout.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${1:-15180}"
if [ -x "$ROOT/bin/cloudflared" ]; then CF="$ROOT/bin/cloudflared"; elif command -v cloudflared >/dev/null; then CF="$(command -v cloudflared)"; else CF=""; fi

if [ -n "$CF" ]; then
  # Quick tunnel: no login, no ~/.cloudflared writes. Empty config avoids reading ~/.cloudflared/config.yml.
  exec "$CF" tunnel --no-autoupdate --config /dev/null --url "http://127.0.0.1:$PORT"
elif command -v ngrok >/dev/null; then
  exec ngrok http "$PORT" --log stdout --log-format logfmt
elif command -v tailscale >/dev/null; then
  exec tailscale funnel "$PORT"
else
  echo "No tunnel tool found. Run scripts/bootstrap.sh." >&2; exit 1
fi
