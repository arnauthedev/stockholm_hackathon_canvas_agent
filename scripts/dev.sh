#!/usr/bin/env bash
# Start runner + app (+ tunnel unless PUBLIC_URL is set), print the pairing URL/QR.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] || { echo "Run scripts/bootstrap.sh first"; exit 1; }
set -a; . ./.env; set +a
export PORT="${PORT:-18787}" APP_PORT="${APP_PORT:-15180}"
mkdir -p logs

# Refuse to start if another process already listens on our ports (any address):
# a server bound to 127.0.0.1:<port> would silently receive the tunnel's traffic.
for p in "$PORT" "$APP_PORT"; do
  if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[dev] port $p is already in use:"; lsof -nP -iTCP:"$p" -sTCP:LISTEN | tail -n +2
    echo "[dev] stop that process or change PORT/APP_PORT in .env"; exit 1
  fi
done
TUNNEL_PID=""
cleanup() { [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

if [ -z "${PUBLIC_URL:-}" ]; then
  : > logs/tunnel.log
  bash scripts/tunnel.sh "$APP_PORT" > logs/tunnel.log 2>&1 &
  TUNNEL_PID=$!
  printf "[dev] starting tunnel"
  for _ in $(seq 1 60); do
    URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.(trycloudflare\.com|ngrok-free\.app|ngrok\.app|ngrok\.io|ts\.net)' logs/tunnel.log | head -1 || true)"
    [ -n "$URL" ] && break
    printf "."; sleep 0.5
  done
  echo
  [ -n "${URL:-}" ] || { echo "[dev] tunnel did not report a URL; see logs/tunnel.log"; cat logs/tunnel.log | tail -20; exit 1; }
  export PUBLIC_URL="$URL"
fi

node scripts/pair.mjs "$PUBLIC_URL" "$RUNNER_TOKEN" "$APP_PORT"

node_modules/.bin/concurrently -k -n runner,app -c blue,magenta \
  "pnpm --filter @canvas-agent/runner dev" \
  "pnpm --filter @canvas-agent/app dev"
