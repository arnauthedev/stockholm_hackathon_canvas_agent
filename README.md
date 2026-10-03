# Canvas Agent

A mobile PWA that is almost nothing on its own. It has an empty canvas, a Talk button, a Text button and a Camera button. An OpenAI voice/text **brain** talks with you and builds the interface through tool calls: it renders UI, pins widgets, runs tasks, and keeps widgets live.

- Spec: [docs/SPEC.md](docs/SPEC.md) · Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
- Run locally: [deploy/local.md](deploy/local.md)

```
app/                PWA (Vite + React)
runner/             Hono runner: tools, WS bus, file watcher, cron, sub-agents, voice sideband
packages/contract/  zod schemas: tool contract, canvas spec, file formats, bus events
config/routes.ts    provider routing table
python/             venv deps + helpers for generated fetch scripts
templates/agent-home/  seed for runtime data (agent-home/ is gitignored)
scripts/            bootstrap, dev, tunnel, check-footprint
```
