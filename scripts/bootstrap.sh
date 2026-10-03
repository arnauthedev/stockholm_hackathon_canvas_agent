#!/usr/bin/env bash
# Detect tools, install project-local deps, create .venv, download missing bins into ./bin,
# seed agent-home, generate RUNNER_TOKEN. Writes nothing outside the repo except tool caches.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
say() { printf "\033[1;34m[bootstrap]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[bootstrap]\033[0m %s\n" "$*" >&2; exit 1; }

# --- Node ---
command -v node >/dev/null || die "Node >= 22 is required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "Node >= 22 required (found $(node -v))"
say "node $(node -v) at $(command -v node)"

# --- JS deps (pnpm preferred; fallback runs pnpm via npx, no global install) ---
if command -v pnpm >/dev/null; then PNPM=(pnpm); else PNPM=(npx -y pnpm@10); fi
say "installing JS deps with ${PNPM[*]}"
"${PNPM[@]}" install --silent

# --- .env + RUNNER_TOKEN ---
[ -f .env ] || { cp .env.example .env; say "created .env from .env.example"; }
if ! grep -qE '^RUNNER_TOKEN=.+' .env; then
  TOKEN="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
  if grep -q '^RUNNER_TOKEN=' .env; then
    node -e 'const fs=require("fs");const f=".env";fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/^RUNNER_TOKEN=.*$/m,"RUNNER_TOKEN="+process.argv[1]))' "$TOKEN"
  else
    echo "RUNNER_TOKEN=$TOKEN" >> .env
  fi
  say "generated RUNNER_TOKEN"
fi
grep -qE '^OPENAI_API_KEY=.+' .env || say "NOTE: OPENAI_API_KEY is empty in .env (needed for voice/brain from M2)"

# --- Python venv (./.venv) ---
PYPKGS=(yfinance requests pandas)
if command -v uv >/dev/null; then
  export UV_PYTHON_DOWNLOADS=never   # use the installed python, never download one into ~
  [ -x .venv/bin/python ] || uv venv -q .venv --python "$(command -v python3)"
  say "installing python deps with uv"
  uv pip install -q --python .venv/bin/python -r python/pyproject.toml
elif command -v python3 >/dev/null; then
  [ -x .venv/bin/python ] || python3 -m venv .venv
  say "installing python deps with pip"
  .venv/bin/pip install -q "${PYPKGS[@]}"
else
  die "python3 (or uv) is required"
fi

# --- Tunnel tool: use an installed one, else download cloudflared into ./bin ---
mkdir -p bin logs
# cloudflared needs no account; ngrok/tailscale count only when configured (a bare ngrok binary is not enough).
if command -v cloudflared >/dev/null || [ -x bin/cloudflared ] || { command -v ngrok >/dev/null && ngrok config check >/dev/null 2>&1; } || { command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; }; then
  say "tunnel tool present"
else
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"; ARCH="$(uname -m)"
  case "$ARCH" in arm64|aarch64) ARCH=arm64 ;; x86_64|amd64) ARCH=amd64 ;; *) die "unsupported arch $ARCH" ;; esac
  BASE="https://github.com/cloudflare/cloudflared/releases/latest/download"
  say "downloading cloudflared ($OS-$ARCH) into ./bin"
  if [ "$OS" = darwin ]; then
    curl -fsSL "$BASE/cloudflared-darwin-$ARCH.tgz" | tar -xz -C bin
  else
    curl -fsSL -o bin/cloudflared "$BASE/cloudflared-linux-$ARCH"
  fi
  chmod +x bin/cloudflared
fi

# --- Seed agent-home ---
set -a; . ./.env; set +a
AH="${AGENT_HOME:-./agent-home}"
if [ ! -f "$AH/screens.json" ]; then
  mkdir -p "$AH"
  cp -R templates/agent-home/. "$AH/"
  find "$AH" -name .gitkeep -delete
  say "seeded $AH from templates/agent-home"
fi

say "done. Next: scripts/dev.sh"
