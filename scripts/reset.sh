#!/usr/bin/env bash
# Reset runtime state (canvases, widgets, tasks, sessions, screens). Identity and themes are kept;
# the old state goes to agent-home/.backups/<timestamp>/ (last 5 kept).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; . "$ROOT/.env"; set +a
if curl -sf -m 3 -o /dev/null -H "authorization: Bearer $RUNNER_TOKEN" "http://127.0.0.1:${PORT:-18787}/api/health"; then
  curl -s -X POST -H "authorization: Bearer $RUNNER_TOKEN" "http://127.0.0.1:${PORT:-18787}/api/reset"; echo
else
  cd "$ROOT/runner" && node --import tsx src/reset-cli.ts
fi
