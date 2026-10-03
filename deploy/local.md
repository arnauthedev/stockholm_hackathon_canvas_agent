# Running locally (Mac or Linux)

Requirements already on the machine: Node ≥ 22, pnpm (or npm), uv or python3. Nothing else is installed globally.

```bash
bash scripts/bootstrap.sh          # deps, .venv, ./bin/cloudflared if needed, .env + RUNNER_TOKEN, agent-home/
$EDITOR .env                       # set OPENAI_API_KEY
bash scripts/dev.sh                # runner + app + quick tunnel; prints pairing URL + QR
```

Scan the QR code with your phone. The link `https://<tunnel>/#token=…` stores the token in the browser. Then, on iOS, use Share → Add to Home Screen to install the app.

- Logs: `logs/dev.log`, `logs/tunnel.log` (when started via the commands above).
- A fixed URL (your own tunnel or domain): set `PUBLIC_URL` in `.env`. `dev.sh` then skips the quick tunnel.
- Ports: runner `PORT=18787`, app `APP_PORT=15180`, both bound to 127.0.0.1. `dev.sh` refuses to start if either is taken; change them in `.env`.
- Talk to the brain without the phone: `curl -X POST localhost:18787/api/chat -H "authorization: Bearer $RUNNER_TOKEN" -H 'content-type: application/json' -d '{"text":"weather in Lisbon next week","wait":true}'`
- Footprint check: `bash scripts/check-footprint.sh` (snapshot → bootstrap → verify).
- Reset runtime state: **Reset** button in the Tasks panel (left page), or `bash scripts/reset.sh` (works with the runner up or down). Canvases, widgets, tasks, sessions and screens move to `agent-home/.backups/<timestamp>/` (last 5 kept); `identity/` and `themes/` stay. To restore, stop dev and move the folders back.

## Email (optional, free)

1. Google Account → Security → turn on 2-Step Verification → **App passwords** → create one (16 characters).
2. In `.env`:
   ```
   EMAIL_USER=you@gmail.com
   EMAIL_PASSWORD=<app password, no spaces>
   EMAIL_FROM_NAME=Your Name
   ENABLE_SIDE_EFFECTS=true      # otherwise approved emails are only saved to agent-home/outbox/
   ```
3. The runner restarts automatically. "Reply to Laura's email…" now reads your inbox, and "Email Mark…" sends after you accept the card.

Contacts live in `agent-home/identity/contacts.json` (names, aliases, phones, emails). The agent only sees names; numbers and addresses stay on this machine.

## Notifications (push)

1. On iPhone: open the pairing link in Safari → Share → **Add to Home Screen**, then open the app from the icon (iOS 16.4+). Android/desktop Chrome work in the browser too.
2. Tasks panel (left page) → **🔕 Notify** → allow. When on, tapping **🔔 On** sends a test notification.
3. You'll get pushes for alerts ("tell me when Apple drops below 120"), approvals waiting, and background tasks finishing — only while the app isn't open on screen.

The quick tunnel URL changes on each `dev.sh` restart, and push subscriptions belong to one URL: after a restart, reinstall from the new link and enable again. A stable URL (Matrix OS) removes this step.
