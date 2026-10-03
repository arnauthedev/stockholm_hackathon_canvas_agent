#!/usr/bin/env bash
# From the laptop: push a branch (default main), then on the Matrix computer pull it, install, rebuild the
# app and restart the runner. scripts/matrix-serve.sh brings the runner back up on the same tunnel URL (or is
# started if it is not running), and the runner resumes every live widget's cron job.
#   bash scripts/matrix-deploy.sh [branch]
# Needs the Matrix CLI logged in (`matrix login`). MATRIX_DIR is the checkout path in the Matrix home.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-main}"
MATRIX_DIR="${MATRIX_DIR:-projects/canvas-agent}"
say() { printf "\033[1;34m[deploy]\033[0m %s\n" "$*"; }

[ -z "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ] || say "note: uncommitted changes stay on the laptop"
say "pushing $BRANCH"
if command -v gh >/dev/null; then
  git -C "$ROOT" -c credential.helper= -c 'credential.helper=!gh auth git-credential' push -q origin "$BRANCH"
else
  git -C "$ROOT" push -q origin "$BRANCH"
fi

say "updating ~/$MATRIX_DIR on the Matrix computer"
matrix run -C . -- bash -lc "set -e; cd ~/$MATRIX_DIR; set -a; . ./.env; set +a
  health() { curl -sf -m 2 -o /dev/null -H \"authorization: Bearer \$RUNNER_TOKEN\" http://127.0.0.1:\${PORT:-18787}/api/health; }
  git fetch -q origin && git checkout -q $BRANCH && git merge -q --ff-only origin/$BRANCH
  echo \"[matrix] at \$(git log --oneline -1)\"
  pnpm install --frozen-lockfile --silent; mkdir -p logs
  pnpm --filter @canvas-agent/app build > logs/build.log 2>&1 || { tail -30 logs/build.log; exit 1; }
  echo '[matrix] app built'
  if [ -f logs/runner.pid ] && kill \$(cat logs/runner.pid) 2>/dev/null; then
    for i in \$(seq 1 30); do sleep 1; health && break; done
    health && echo '[matrix] runner restarted' || echo '[matrix] runner not healthy yet: see logs/serve.log'
  else
    echo '[matrix] serve loop not running; starting it'; bash scripts/matrix-serve.sh --detach | tail -3
  fi
  [ -f logs/public-url ] && echo \"[matrix] live at \$(cat logs/public-url)\""
