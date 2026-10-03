#!/usr/bin/env bash
# Call a runner tool directly: scripts/tool.sh <name> '<json args>' | @file.json
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a; . "$ROOT/.env"; set +a
ARGS="${2:-{\}}"
if [[ "$ARGS" == @* ]]; then DATA=(--data-binary "$ARGS"); else DATA=(-d "$ARGS"); fi
curl -s -X POST "http://127.0.0.1:${PORT:-18787}/api/tools/$1" -H "authorization: Bearer $RUNNER_TOKEN" -H "content-type: application/json" "${DATA[@]}"
echo
