#!/usr/bin/env bash
# Asserts nothing was written outside the repo: snapshots $HOME dotfiles + sensitive dirs
# (mtime list) and global npm packages before/after running bootstrap, then diffs.
#   scripts/check-footprint.sh            # snapshot → bootstrap → snapshot → diff
#   scripts/check-footprint.sh snapshot   # save "before"
#   scripts/check-footprint.sh verify     # compare current state to the saved "before"
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SNAP="$ROOT/.footprint"; mkdir -p "$SNAP"

# Tool-owned caches and noisy app/editor state are allowed to change.
ALLOW='^(\.npm|\.cache|\.pnpm-store|\.local|\.Trash|\.DS_Store|\.zsh_history|\.bash_history|\.zsh_sessions|\.node_repl_history|\.python_history|\.lesshst|\.viminfo|\.vscode|\.vscode-server|\.cursor|\.claude|\.claude\.json.*|\.CFUserTextEncoding)$'
WATCH_DIRS=(.cloudflared .config .ssh .ngrok2 .gnupg Library/LaunchAgents Library/pnpm/global .nvm/versions)

snapshot() {
  {
    for f in "$HOME"/.[!.]*; do
      n="$(basename "$f")"
      [[ "$n" =~ $ALLOW ]] && continue
      [ -d "$f" ] && continue   # directory mtimes are covered by WATCH_DIRS below
      stat -f '%m %N' "$f" 2>/dev/null || stat -c '%Y %n' "$f"
    done
    for d in "${WATCH_DIRS[@]}"; do
      [ -e "$HOME/$d" ] || { echo "absent $HOME/$d"; continue; }
      # Global installs show up as new dirs under lib/node_modules; depth-limited for speed.
      find "$HOME/$d" -maxdepth 4 \( -name node_modules -prune -o -print \) 2>/dev/null | sort
    done
    for d in "$HOME"/.nvm/versions/node/*/lib/node_modules; do [ -d "$d" ] && ls -1 "$d" | sed "s|^|global-npm: |"; done
    echo "npm-global: $(npm ls -g --depth=0 --parseable 2>/dev/null | sort | tr '\n' ' ')"
  } | sort
}

case "${1:-full}" in
  snapshot) snapshot > "$SNAP/before.txt"; echo "[footprint] snapshot saved" ;;
  verify)
    snapshot > "$SNAP/after.txt"
    if diff -u "$SNAP/before.txt" "$SNAP/after.txt" > "$SNAP/diff.txt"; then
      echo "[footprint] PASS — nothing written outside the repo (except allowed tool caches)"
    else
      echo "[footprint] FAIL — changes outside the repo:"; grep -E '^[+-][^+-]' "$SNAP/diff.txt"; exit 1
    fi ;;
  full) "$0" snapshot; bash "$ROOT/scripts/bootstrap.sh"; "$0" verify ;;
  *) echo "usage: $0 [snapshot|verify]"; exit 2 ;;
esac
