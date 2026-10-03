#!/usr/bin/env bash
# Production serve loop for the Matrix computer (or any always-on box).
# Starts one HTTPS tunnel to the runner (unless PUBLIC_URL is set), prints the pairing URL, then keeps the
# runner alive: when it exits (crash, or scripts/matrix-deploy.sh killing it after a pull) it is restarted
# on the same tunnel URL and re-reads .env.
#   bash scripts/matrix-serve.sh            # foreground
#   bash scripts/matrix-serve.sh --detach   # background, survives the terminal; output in logs/serve.log
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f .env ] || { echo "Run scripts/bootstrap.sh first"; exit 1; }
mkdir -p logs

if [ -f logs/serve.pid ] && kill -0 "$(cat logs/serve.pid)" 2>/dev/null; then
  echo "[serve] already running (pid $(cat logs/serve.pid)); live at $(cat logs/public-url 2>/dev/null)"; exit 0
fi
if [ "${1:-}" = "--detach" ]; then
  rm -f logs/public-url
  setsid nohup bash "$0" > logs/serve.log 2>&1 < /dev/null &
  for _ in $(seq 1 60); do [ -s logs/public-url ] && break; sleep 0.5; done
  cat logs/serve.log; exit 0
fi
echo $$ > logs/serve.pid
rm -f logs/public-url

# Not exported: the runner loads .env itself on every start, so edits apply after a restart.
. ./.env
PORT="${PORT:-18787}"
[ -f app/dist/index.html ] || pnpm --filter @canvas-agent/app build

TUNNEL_PID=""; RUNNER_PID=""
cleanup() { for p in "$RUNNER_PID" "$TUNNEL_PID"; do [ -n "$p" ] && kill "$p" 2>/dev/null || true; done; rm -f logs/runner.pid logs/serve.pid; }
trap cleanup EXIT
trap 'exit 0' INT TERM

if [ -z "${PUBLIC_URL:-}" ]; then
  : > logs/tunnel.log
  bash scripts/tunnel.sh "$PORT" > logs/tunnel.log 2>&1 &
  TUNNEL_PID=$!
  printf "[serve] starting tunnel"
  for _ in $(seq 1 60); do
    URL="$(grep -oE 'https://[a-zA-Z0-9.-]+\.(trycloudflare\.com|ngrok-free\.app|ngrok\.app|ngrok\.io|ts\.net)' logs/tunnel.log | head -1 || true)"
    [ -n "$URL" ] && break
    printf "."; sleep 0.5
  done
  echo
  [ -n "${URL:-}" ] || { echo "[serve] tunnel did not report a URL; see logs/tunnel.log"; tail -20 logs/tunnel.log; exit 1; }
  PUBLIC_URL="$URL"
fi
node scripts/pair.mjs "$PUBLIC_URL" "$RUNNER_TOKEN" "$PORT"
echo "$PUBLIC_URL" > logs/public-url

SERVE_URL="$PUBLIC_URL"
while true; do
  # The runner must read .env itself (process.loadEnvFile never overrides), so drop any inherited copy of
  # its keys, e.g. from a caller that exported .env. tsx forwards SIGTERM, so killing this PID stops it.
  ENV_KEYS=$(grep -oE '^[A-Za-z_][A-Za-z0-9_]*=' .env | tr -d =)
  (cd runner && unset $ENV_KEYS && PUBLIC_URL="$SERVE_URL" exec ./node_modules/.bin/tsx src/main.ts) &
  RUNNER_PID=$!
  echo "$RUNNER_PID" > logs/runner.pid
  wait "$RUNNER_PID" || true
  echo "[serve] runner exited; restarting in 2s ($(date '+%H:%M:%S'))"
  sleep 2
done
