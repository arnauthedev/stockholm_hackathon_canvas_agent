import { existsSync } from "node:fs";
import type { Server } from "node:http";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { TOOL_NAMES, toolDefs } from "@canvas-agent/contract";
import { env } from "./env.ts";
import { bus } from "./bus.ts";
import { handleApprovalEvent } from "./approvals.ts";
import { hub } from "./events.ts";
import { executeTool, showCanvas } from "./executor.ts";
import { jobCount, resumeJobs } from "./jobs.ts";
import { initHome, snapshot } from "./store.ts";
import * as uiActions from "./uiactions.ts";
import { textSession, textTurn } from "./brain.ts";
import { createLiveSession } from "./voice/live.ts";
import { attachVoiceRelay } from "./voice/gemini.ts";
import { getVoiceSession, listVoiceSessions } from "./voice/core.ts";
import { recentActivity, startedAt } from "./monitor.ts";
import { listJobs } from "./jobs.ts";
import { listTextSessions } from "./brain.ts";
import { pendingApprovals } from "./approvals.ts";
import { route } from "../../config/routes.ts";
import { resetState } from "./reset.ts";
import { addSubscription, pushAll, removeSubscription, subscriptionCount, vapidPublicKey } from "./push.ts";
import { runAppNow } from "./jobs.ts";
import { handleUpload, serveUpload } from "./uploads.ts";
import { startWatcher } from "./watcher.ts";
import { resumeTasks } from "./taskrunner.ts";

// A background promise must never take the runner down (it serves the phone and live widgets).
process.on("unhandledRejection", (err) => console.error("[runner] unhandled rejection (kept running):", err));
process.on("uncaughtException", (err) => console.error("[runner] uncaught exception (kept running):", err));

await initHome();
await (await import("./layout.ts")).migrateLayouts();
const { resumeTriggers, listTriggers } = await import("./triggers.ts");
const { startEmailWatch, checkEmail } = await import("./emailwatch.ts");
void resumeTriggers();
startEmailWatch();
startWatcher();
void resumeJobs();
void resumeTasks();

// phone → runner: taps that change widget state (the phone already shows them optimistically)
bus.on((e) => {
  if (e.type !== "ui.action") return;
  const { applyAction } = uiActions;
  void applyAction({ target: e.canvas_id ?? e.app_id, component_id: e.component_id, action: e.action, args: e.args, action_id: e.action_id }).then((r) => {
    if ("error" in r) console.warn("[ui.action]", e.action, r.error);
  });
});

// phone → runner component events
bus.on((e) => {
  if (e.type !== "ui.event") return;
  if (handleApprovalEvent(e)) return;
  hub.ui(e);
});

const app = new Hono();

// Auth: every /api/* request needs RUNNER_TOKEN (header or ?token=).
app.use("/api/*", async (c, next) => {
  const h = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? c.req.header("x-runner-token") ?? c.req.query("token");
  if (h !== env.RUNNER_TOKEN) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.get("/api/health", (c) => c.json({ ok: true, agent_home: env.AGENT_HOME, clients: bus.clients, jobs: jobCount(), openai: !!env.OPENAI_API_KEY, gemini: !!env.GEMINI_API_KEY }));
app.get("/api/state", async (c) => c.json(await snapshot()));
// Dashboard: what the server is doing right now (activity also streams live on the bus).
app.get("/api/monitor", (c) =>
  c.json({
    started_at: startedAt,
    clients: bus.clients,
    routes: Object.fromEntries((["voice", "brain", "subagent", "vision"] as const).map((j) => [j, { model: route(j).model, reasoning: route(j).reasoning ?? null }])),
    jobs: listJobs(),
    sessions: { voice: listVoiceSessions(), text: listTextSessions() },
    approvals: pendingApprovals().map((a) => ({ approval_id: a.approval_id, title: String(a.card.title ?? "") })),
    activity: recentActivity(),
  }),
);
app.get("/api/tools", (c) => c.json(toolDefs()));
app.post("/api/tools/:name", async (c) => {
  const name = c.req.param("name");
  if (!(TOOL_NAMES as string[]).includes(name)) return c.json({ error: `unknown tool ${name}` }, 404);
  const args = await c.req.json().catch(() => ({}));
  return c.json(await executeTool(name, args, { actor: "http" }));
});

// Text brain: returns immediately; the reply arrives as transcript events on the bus.
app.post("/api/chat", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { text?: string; session_id?: string; wait?: boolean };
  const text = body.text?.trim();
  if (!text) return c.json({ error: "text required" }, 400);
  if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY is not set in .env" }, 503);
  const session_id = textSession(body.session_id);
  const p = textTurn(session_id, text);
  if (body.wait) return c.json({ session_id, text: await p });
  return c.json({ session_id, status: "started" });
});

// Which realtime provider the phone should connect to (routes.voice, or routes.liveVision with ?mode=vision):
// openai → WebRTC via POST /api/voice/session; google → audio over the /voice WebSocket (camera frames allowed).
app.get("/api/voice/provider", (c) => {
  const v = route(c.req.query("mode") === "vision" ? "liveVision" : "voice");
  const key = v.provider === "google" ? env.GEMINI_API_KEY : env.OPENAI_API_KEY;
  return c.json({ provider: v.provider, model: v.model, video: v.provider === "google", ready: !!key });
});
// Voice (GPT-Live): phone sends its SDP offer, runner creates the session and attaches the sideband.
app.post("/api/voice/session", async (c) => {
  if (route("voice").provider !== "openai") return c.json({ error: `voice provider is ${route("voice").provider}: connect to /voice instead` }, 409);
  if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY is not set in .env" }, 503);
  const { sdp } = (await c.req.json().catch(() => ({}))) as { sdp?: string };
  if (!sdp) return c.json({ error: "sdp required" }, 400);
  try {
    return c.json(await createLiveSession(sdp));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[voice] create failed:", msg);
    return c.json({ error: msg }, 502);
  }
});
app.post("/api/voice/:id/interrupt", (c) => (getVoiceSession(c.req.param("id"))?.interrupt(), c.json({ ok: true })));
app.post("/api/voice/:id/close", async (c) => (await getVoiceSession(c.req.param("id"))?.close(), c.json({ ok: true })));

// Camera / gallery: multipart {file, text?, session_id?}
app.post("/api/upload", async (c) => {
  if (!env.OPENAI_API_KEY) return c.json({ error: "OPENAI_API_KEY is not set in .env" }, 503);
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return c.json({ error: "file required" }, 400);
  const out = await handleUpload(file, String(form?.get("text") ?? ""), String(form?.get("session_id") ?? "") || undefined);
  return c.json(out, "error" in out ? 400 : 200);
});
// Uploaded photos: capability URLs (unguessable names) so <img> works without the token.
app.get("/files/uploads/:name", async (c) => {
  const f = await serveUpload(c.req.param("name"));
  if (!f) return c.notFound();
  return c.body(new Uint8Array(f.body), 200, { "content-type": f.type, "cache-control": "private, max-age=86400" });
});

// Web Push: public key, (un)subscribe, test
app.get("/api/push/key", async (c) => c.json({ publicKey: await vapidPublicKey(), devices: await subscriptionCount() }));
app.post("/api/push/subscribe", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { subscription?: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } };
  const s = body.subscription;
  if (!s?.endpoint || !s.keys?.p256dh || !s.keys.auth) return c.json({ error: "subscription required" }, 400);
  await addSubscription(s as never, c.req.header("user-agent"));
  return c.json({ ok: true, devices: await subscriptionCount() });
});
app.post("/api/push/unsubscribe", async (c) => {
  const { endpoint } = (await c.req.json().catch(() => ({}))) as { endpoint?: string };
  if (endpoint) await removeSubscription(endpoint);
  return c.json({ ok: true });
});
app.post("/api/push/test", async (c) => c.json(await pushAll({ title: "Canvas Agent", body: "Notifications are on 👍", url: "/" }, { force: true })));
// Edit mode on the phone: move/resize a widget by hand (must fit; marks it user-placed)
app.post("/api/apps/:id/layout", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { screen?: string; x?: number; y?: number; size?: "S" | "W" | "L" | "T" };
  const { lock } = await import("./fsutil.ts");
  const { moveTo } = await import("./layout.ts");
  const id = c.req.param("id");
  if (b.size && (b.screen == null || b.x == null || b.y == null)) {
    // size chip in edit mode: resize where it fits, then mark it user-placed
    const { resize } = await import("./layout.ts");
    const r = await lock("screens", async () => {
      const rs = await resize(id, b.size!);
      return "error" in rs ? rs : moveTo(id, rs.screen, rs.layout.x, rs.layout.y, b.size);
    });
    return c.json(r, "error" in r ? 409 : 200);
  }
  if (b.screen == null || b.x == null || b.y == null) return c.json({ error: "screen, x, y required" }, 400);
  const r = await lock("screens", () => moveTo(id, b.screen!, b.x!, b.y!, b.size));
  return c.json(r, "error" in r ? 409 : 200);
});
app.get("/api/triggers", async (c) => c.json((await listTriggers()).filter((t) => t.status === "active")));
app.post("/api/email/check", async (c) => c.json(await checkEmail()));
// Text-to-speech for "speak" triggers when there's no voice call (the phone plays it)
app.get("/api/tts", async (c) => {
  const text = (c.req.query("text") ?? "").slice(0, 600);
  if (!text) return c.json({ error: "text required" }, 400);
  const { route } = await import("../../config/routes.ts");
  const r = route("tts");
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: r.model, voice: String(r.voice ?? "coral"), input: text, response_format: "mp3" }),
  });
  if (!res.ok) return c.json({ error: `tts ${res.status}` }, 502);
  return c.body(new Uint8Array(await res.arrayBuffer()), 200, { "content-type": "audio/mpeg" });
});
app.post("/api/apps/:id/refresh", async (c) => c.json(await runAppNow(c.req.param("id"))));

// Reset runtime state (backup kept in agent-home/.backups/).
app.post("/api/reset", async (c) => c.json(await resetState()));

app.post("/api/canvas/:id/show", async (c) => c.json(await showCanvas(c.req.param("id"))));

// Production / Matrix: serve the built PWA from the runner (B14).
if (existsSync(env.APP_DIST)) {
  app.use("/*", serveStatic({ root: env.APP_DIST }));
  app.get("*", serveStatic({ path: `${env.APP_DIST}/index.html` }));
}

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST }, (info) => {
  console.log(`[runner] listening on :${info.port}  AGENT_HOME=${env.AGENT_HOME}`);
});
bus.attach(server as Server);
attachVoiceRelay(server as Server);
