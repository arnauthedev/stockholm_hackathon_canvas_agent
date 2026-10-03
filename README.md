# Canvas Agent

A mobile PWA that is almost nothing on its own. It has an empty canvas, a Talk button, a Text button and a Camera button. An OpenAI voice/text **brain** talks with you and builds the interface through tool calls: it renders UI, pins widgets, runs tasks, and keeps widgets live.

- Spec: [docs/SPEC.md](docs/SPEC.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
- Run locally: [deploy/local.md](deploy/local.md)
- Run on Matrix OS: [deploy/matrix.md](deploy/matrix.md) (setup, limits, troubleshooting)

## Demo on Matrix OS

The demo instance runs on a Matrix OS cloud computer, in `~/projects/canvas-agent`, tracking `main`. The laptop is where code gets written. All commands below run on the laptop, from the repo root, with the Matrix CLI logged in (`matrix login`).

| Command | What it does |
|---|---|
| `bash scripts/matrix-pair.sh` | Shows the live URL, checks it answers, prints the pairing QR |
| `bash scripts/matrix-deploy.sh` | Pushes `main`, then on Matrix: pull, install, build, restart (the URL stays the same) |

### Set up the phone (once, and again whenever the URL changes)

1. Delete any old Canvas icon from the Home Screen.
2. Run `bash scripts/matrix-pair.sh` and scan the QR code with the phone camera. It opens in Safari.
3. In Safari, tap **Copy link** in the install hint, then Share → **Add to Home Screen**.
4. Open the new Home Screen app and tap **Paste**.

Step 4 is needed because iOS gives Home Screen apps their own storage: the token Safari saved never reaches the installed app.

### Before the demo

- Run `bash scripts/matrix-pair.sh`. If the URL is the same as before and it says "is up", you're set. If the URL changed (Matrix restarted the computer), set up the phone again.
- Open the app and do one short voice exchange, so the mic permission and connection are warmed up.
- Stop the laptop's `scripts/dev.sh`, so widgets don't run twice and you can't open the wrong instance.
- Don't deploy in the last hour before the demo.

### Good to know

- The realtime conversation uses OpenAI (`ROUTE_voice=openai/gpt-live-1` in `.env`). Remove that line to go back to the code default, Gemini Live.
- New app versions reach the phone on their own. A changed URL does not: the Home Screen app is tied to its URL.
- The URL is a free Cloudflare quick tunnel. It survives deploys and changes only when the serve loop restarts (a Matrix reboot). For a URL that never changes, use a Cloudflare tunnel on your own domain (see [deploy/matrix.md](deploy/matrix.md#limits)).
- `.env` on Matrix is separate from the laptop's. After changing a key locally, upload it with `matrix upload .env projects/canvas-agent/.env --secret --force`, then run `bash scripts/matrix-deploy.sh`.

```
app/                PWA (Vite + React)
runner/             Hono runner: tools, WS bus, file watcher, cron, sub-agents, voice sideband
packages/contract/  zod schemas: tool contract, canvas spec, file formats, bus events
config/routes.ts    provider routing table
python/             venv deps + helpers for generated fetch scripts
templates/agent-home/  seed for runtime data (agent-home/ is gitignored)
scripts/            bootstrap, dev, tunnel, check-footprint
```
