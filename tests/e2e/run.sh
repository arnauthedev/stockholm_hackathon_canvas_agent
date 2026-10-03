#!/usr/bin/env bash
# Regression harness (isolated runner; never touches agent-home or a running dev stack).
#   bash tests/e2e/run.sh                     # everything (voice scenarios cost a few cents and ~3 min)
#   bash tests/e2e/run.sh --tags=tool,text,ui # skip email + voice
#   bash tests/e2e/run.sh --compare=tests/e2e/results/<file>.json
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
exec node tests/e2e/run.mjs "$@"
