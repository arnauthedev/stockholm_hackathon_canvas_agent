# Running on Matrix OS

Matrix OS gives you an always-on Linux computer (Node, Python 3 + uv, home folder at `~` = `/home/matrix/home`). The runner serves the built PWA, `/api/*` and the `/bus` WebSocket on one port, so the whole app is one process plus an HTTPS tunnel.

The laptop stays the place where you write code. Matrix runs `main` from GitHub; runtime data (`agent-home/`) and secrets (`.env`) live only on the Matrix computer and are never in git.

## What goes where

| | How it gets to Matrix |
|---|---|
| Code | `git clone` / `git pull` from GitHub over a read-only deploy key (`~/.ssh/canvas_agent`) |
| `.env` | `matrix upload --secret`, once; edit it there afterwards |
| `agent-home/` | optional tarball, once; after that the server owns it |
| `full_specs/`, `docs/`, `Ideas.md`, `fixes.md`, `canvas-agent-SPEC.md` | never; they are gitignored and stay on the laptop |

The checkout lives at `~/projects/canvas-agent`. Don't `matrix sync` the laptop's project folder: it would upload the gitignored files too.

## One-time setup

On the laptop:

```bash
npm i -g @finnaai/matrix && matrix login     # device flow in the browser
COPYFILE_DISABLE=1 tar czf /tmp/agent-home.tgz --exclude 'agent-home/tmp/*' agent-home
```

On the Matrix computer (`matrix run -it -C . -- bash`):

```bash
ssh-keygen -q -t ed25519 -N '' -f ~/.ssh/canvas_agent -C matrix-canvas-agent
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts
cat ~/.ssh/canvas_agent.pub
# laptop: gh repo deploy-key add canvas_agent.pub -t "Matrix OS (read-only)"
GIT_SSH_COMMAND='ssh -i ~/.ssh/canvas_agent -o IdentitiesOnly=yes' \
  git clone git@github.com:arnauthedev/stockholm_hackathon_canvas_agent.git ~/projects/canvas-agent
cd ~/projects/canvas-agent
git config core.sshCommand 'ssh -i ~/.ssh/canvas_agent -o IdentitiesOnly=yes'
corepack enable --install-directory ~/.local/bin pnpm    # Matrix has Node but no pnpm
bash scripts/bootstrap.sh                 # deps, .venv, Linux cloudflared into bin/, placeholder .env
pnpm --filter @canvas-agent/app build
```

Then from the laptop, replace the placeholder `.env` and add the data:

```bash
matrix upload .env projects/canvas-agent/.env --secret --force
matrix upload /tmp/agent-home.tgz projects/canvas-agent/agent-home.tgz
matrix run -C projects/canvas-agent -- bash -lc 'tar xzf agent-home.tgz && rm agent-home.tgz'
```

Start the serve loop by deploying once from the laptop: it installs a cron watchdog that starts it (and restarts it after a crash or reboot):

```bash
bash scripts/matrix-deploy.sh
```

`scripts/matrix-serve.sh` opens a Cloudflare quick tunnel to the runner, prints the pairing link and QR, and restarts the runner whenever it exits. The URL is written to `logs/public-url` and the output to `logs/serve.log`. Open the link on the phone and Add to Home Screen.

`matrix run` quirk (CLI 0.3.21): always pass `-C <dir>`, relative to the Matrix home (`-C .` for home). Without it the gateway rejects the request with "Request failed".

## Iterating

Work and commit on the laptop as usual, then:

```bash
bash scripts/matrix-deploy.sh            # or: bash scripts/matrix-deploy.sh <branch>
```

It pushes the branch, then on Matrix pulls it, runs `pnpm install`, rebuilds the app and restarts the runner (starting the serve loop if it isn't running). The tunnel URL does not change, the phone picks up the new app on its next load, and live widgets resume their cron jobs.

- `.env` changes: edit `~/projects/canvas-agent/.env` on Matrix (or re-upload with `--force`), then redeploy. The runner re-reads `.env` on every restart.
- Current URL, health check and pairing QR: `bash scripts/matrix-pair.sh`.
- Logs: `matrix run -C projects/canvas-agent -- tail -50 logs/serve.log`.
- Stop: `matrix run -C projects/canvas-agent -- bash -lc 'kill $(cat logs/serve.pid)'`.
- The laptop and Matrix are separate instances with separate `agent-home/`, pairing and push keys. Avoid running both with the same API keys if you don't want widgets to poll twice.

## Limits

- **Quick-tunnel URL**: it changes when `matrix-serve.sh` itself restarts (Matrix reboot, loop killed), and then the phone has to be re-paired. For a fixed URL, set `PUBLIC_URL` and run a named Cloudflare tunnel (`cloudflared tunnel run`) or `tailscale funnel 18787` instead; `matrix-serve.sh` skips its own tunnel when `PUBLIC_URL` is set.
- **Watchdog**: `scripts/matrix-deploy.sh` installs a cron job that starts the serve loop within a minute whenever it isn't running (crash, reboot). Don't start the loop through `matrix run` yourself: processes started that way live in Matrix's gateway service and are killed whenever Matrix restarts the gateway. After a restart the quick-tunnel URL is new, so re-pair the phone (`bash scripts/matrix-pair.sh`).
- **Self-hosted Matrix**: instead of the tunnel you can proxy the instance's nginx to `127.0.0.1:$PORT` (WebSocket upgrade headers, `proxy_read_timeout 3600s`). That location must skip Matrix's Basic Auth because the PWA sends its own bearer token.

## Partner extras (no core code changes)

- **File browser:** `agent-home/apps/<slug>/` folders are editable in the Matrix file browser and terminal. Edits to `spec.json` / `data.json` show up on the phone live via the watcher.
- **Telegram channel → `/api/chat`:** POST `{text, session_id}` with `Authorization: Bearer $RUNNER_TOKEN`. Replies arrive on the bus, or pass `"wait": true` to get the text back in the response.
- **Gmail for the email task:** Pipedream Connect as an extra sub-agent tool behind `ENABLE_SIDE_EFFECTS=true`. The approval gate stays in front.
