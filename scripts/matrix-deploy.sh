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

# Three short calls: one long `matrix run` can outlive the gateway's request timeout ("Request failed")
# even though the work finishes on the Matrix side.
remote() { matrix run -C "$MATRIX_DIR" -- bash -lc "set -e; $1"; }
say "updating ~/$MATRIX_DIR on the Matrix computer"
remote "git fetch -q origin && git checkout -q $BRANCH && git merge -q --ff-only origin/$BRANCH
  echo \"[matrix] at \$(git log --oneline -1)\"
  pnpm install --frozen-lockfile --silent"
remote "mkdir -p logs; pnpm --filter @canvas-agent/app build > logs/build.log 2>&1 || { tail -30 logs/build.log; exit 1; }
  echo '[matrix] app built'"
remote "if [ -f logs/runner.pid ] && kill \$(cat logs/runner.pid) 2>/dev/null; then
    . ./.env  # not exported: only for the health check below
    ok=0; for i in \$(seq 1 30); do sleep 1; curl -sf -m 2 -o /dev/null -H \"authorization: Bearer \$RUNNER_TOKEN\" http://127.0.0.1:\${PORT:-18787}/api/health && { ok=1; break; }; done
    [ \$ok = 1 ] && echo '[matrix] runner restarted' || echo '[matrix] runner not healthy yet: see logs/serve.log'
  else
    echo '[matrix] serve loop not running; starting it'; bash scripts/matrix-serve.sh --detach | tail -3
  fi
  [ -f logs/public-url ] && echo \"[matrix] live at \$(cat logs/public-url)\""
