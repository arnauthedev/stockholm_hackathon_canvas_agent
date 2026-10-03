# Moving to Matrix OS

Matrix OS is a Linux VPS (Node 24, Hono gateway, cron, nginx) where generated apps are real files in a home folder. The runner and `agent-home/` already have that shape, so the move is "copy the folder, change one URL".

Nothing in the code depends on the Mac: there are no absolute paths, the tunnel is only used by `scripts/dev.sh`, and the runner finds the repo root from its own location.

## 1. Copy

```bash
# on the laptop (stop scripts/dev.sh first so agent-home is quiescent)
rsync -a --exclude node_modules --exclude .venv --exclude bin --exclude logs ./ <matrix-host>:~/canvas-agent/
# or from inside a Matrix terminal: matrix run --session agent, then git clone + scp agent-home/
```

`agent-home/` holds the canvases, pinned widgets (with their `fetch.py`), tasks, themes and sessions. Copy it as-is.

## 2. Configure `.env` on the VPS

```bash
cd ~/canvas-agent
bash scripts/bootstrap.sh          # installs deps, .venv; seeds agent-home only if missing
```

Then edit `.env`:

```
OPENAI_API_KEY=sk-...
RUNNER_TOKEN=<keep the old one so the phone stays paired, or generate a new one>
AGENT_HOME=./agent-home            # or an absolute path in the Matrix home folder
PUBLIC_URL=https://<instance-domain>
PORT=18787
HOST=127.0.0.1                     # nginx proxies to it
```

## 3. Build the app and run the runner in a persistent terminal

```bash
pnpm --filter @canvas-agent/app build      # → app/dist, served by the runner itself
pnpm --filter @canvas-agent/runner start   # in a named persistent Matrix terminal session
```

The runner serves `app/dist` plus `/api/*` and `/bus` (WebSocket) on one origin. On start it resumes every live widget's cron job, so pinned widgets keep updating with the laptop closed.

nginx (instance config), proxying everything to the runner, WebSocket included:

```nginx
location / {
  proxy_pass http://127.0.0.1:18787;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 3600s;
}
```

## 4. Re-pair the phone

Open `https://<instance-domain>/#token=<RUNNER_TOKEN>` once (or `node scripts/pair.mjs https://<instance-domain> <token> 0` to get a QR code), then Add to Home Screen again. The phone keeps the token in localStorage.

## Optional partner extras (no core code changes)

- **File browser:** `agent-home/apps/<slug>/` folders are browsable and editable in the Matrix file browser and terminal. Edits to `spec.json` / `data.json` show up on the phone live via the watcher.
- **Telegram channel → `/api/chat`:** POST `{text, session_id}` with `Authorization: Bearer $RUNNER_TOKEN`. Replies arrive on the bus, or pass `"wait": true` to get the text back in the response.
- **Gmail for the email task:** use Pipedream Connect as an extra sub-agent tool behind `ENABLE_SIDE_EFFECTS=true`. The approval gate stays in front.

## Checklist (M7 "done when")

- [ ] Same phone, new URL, laptop closed.
- [ ] A pinned live widget still updates (check `apps/<slug>/job.json` → `last_ok` advancing).
