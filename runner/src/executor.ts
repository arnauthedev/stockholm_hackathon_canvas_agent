import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  CanvasMeta, ToolArgs, mergePatch, resolvePointer, validateSpec,
  type AppJson, type CanvasSpec, type SourceRef, type Theme, type ToolArgsOf, type ToolName,
} from "@canvas-agent/contract";
import { approvalsForModel, cancelCommit, commitWithUndo, editApproval, findApproval, focusApproval, rejectApproval, requestApproval } from "./approvals.ts";
import { bus } from "./bus.ts";
import { env } from "./env.ts";
import { hub } from "./events.ts";
import { exists, lock, now, readJson, slugify, writeJson } from "./fsutil.ts";
import { runSource, scheduleApp, sourceRef, stageSource, syncCanvasJob, unscheduleApp } from "./jobs.ts";
import { runPython } from "./python.ts";
import {
  activeTheme, createCanvas, isCanvasId, latestCanvasId, listAppIds, listCanvasIds, listTaskIds, listThemes,
  paths, readApp, readCanvas, readScreens, readTask, readTheme, writeScreens, writeTask,
} from "./store.ts";
import { tasksApi } from "./tasks-hook.ts";
import { runHelper } from "./helpers.ts";
import { brief, record } from "./monitor.ts";
import { redact } from "./actions.ts";
import { findContact } from "./contacts.ts";
import { emailConfigured, findEmails } from "./email.ts";
import { evaluateAlerts, readRules, writeRules } from "./alerts.ts";
import { imageName, imageUrl, makeImage } from "./images.ts";
import { defaultSize, placeNew, pruneScreens, resize } from "./layout.ts";
import { cancelTrigger, createEmailTrigger, createTimeTrigger, listTriggers } from "./triggers.ts";
import { applyAction, readWidget } from "./uiactions.ts";
import { HelperArgs, type HelperName } from "@canvas-agent/contract";

export interface ToolCtx { session_id?: string; prompt?: string; actor?: string; task_id?: string }
type Handler<N extends ToolName> = (args: ToolArgsOf<N>, ctx: ToolCtx) => Promise<unknown>;

const OP_NAMES: Record<string, string> = { "<": "lt", "<=": "le", ">": "gt", ">=": "ge", "==": "eq", "!=": "ne", changed: "changed" };
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
const targetDir = (t: string) => (isCanvasId(t) ? paths.canvasDir(t) : paths.appDir(t));

async function resolveTarget(t?: string): Promise<string> {
  const id = t ?? (await latestCanvasId());
  if (!id) throw new Error("no canvas yet");
  if (!exists(targetDir(id))) throw new Error(`unknown target "${id}"`);
  return id;
}

const handlers: { [N in ToolName]: Handler<N> } = {
  async render(a, ctx) {
    const v = validateSpec({ schema_version: 1, ...a.spec, title: a.spec.title ?? a.title });
    if (!v.ok) return { error: "invalid spec", details: v.errors.slice(0, 20) };
    const extra: Record<string, string> = {};
    let source: SourceRef | undefined;
    if (a.source) {
      source = sourceRef(a.source);
      if (a.source.type === "python") extra["fetch.py"] = a.source.code;
    }
    const id = await createCanvas(v.spec, a.data, { title: a.title ?? v.spec.title, prompt: ctx.prompt, session_id: ctx.session_id, source, task_id: ctx.task_id }, extra);
    if (ctx.task_id) await tasksApi.attachResult(ctx.task_id, { canvas_id: id });
    void syncCanvasJob(!!source);
    return { canvas_id: id, live: source ? `refreshing every ${source.refresh_s}s while on screen` : undefined };
  },

  async update_data(a) {
    const id = await resolveTarget(a.target);
    const file = path.join(targetDir(id), "data.json");
    const data = await lock(`data:${targetDir(id)}`, async () => {
      const next = mergePatch((await readJson(file)) ?? {}, a.patch);
      await writeJson(file, next);
      return next;
    });
    // a pinned widget updated by a recurring task (no live job): its watches are checked here instead
    if (!isCanvasId(id)) await evaluateAlerts(id, data, []).catch((e) => console.warn("[alerts]", e));
    return { ok: true, target: id };
  },

  async generate_image(a, ctx) {
    if (!a.target) {
      if (!a.prompt) return { error: "prompt required for a new picture" };
      const aspect = a.aspect ?? "1:1";
      const spec = {
        root: "col",
        components: {
          col: { type: "Column", children: ["h", "img"] },
          h: { type: "Heading", props: { text: a.title ?? "Picture", level: 2 } },
          img: { type: "Image", props: { src: { $bind: "/src" }, alt: { $bind: "/prompt" }, fit: "contain", busy: { $bind: "/drawing" }, aspect: { $bind: "/aspect" } } },
        },
      };
      const out = (await handlers.render({ spec, data: { src: "", prompt: a.prompt, aspect, drawing: true, history: [] }, title: a.title ?? "Picture" }, ctx)) as { canvas_id?: string; error?: string };
      if (!out.canvas_id) return out;
      void drawImage(out.canvas_id, { prompt: a.prompt, fresh: true }, ctx);
      return { canvas_id: out.canvas_id, status: "drawing", note: "The card is on the screen; the picture fades in within a few seconds." };
    }
    const id = await resolveTarget(a.target);
    const k = imageKeys(a.field);
    const data = ((await readJson(path.join(targetDir(id), "data.json"))) ?? {}) as Record<string, unknown>;
    if (!a.field && data.aspect === undefined) return { error: `"${id}" is not an image card (make one with generate_image without target, or pass field for a Custom card)` };
    if (a.revert) {
      const [prev, ...rest] = (data[k.history] as string[] | undefined) ?? [];
      if (!prev) return { error: "no earlier picture to go back to" };
      await handlers.update_data({ target: id, patch: { [k.src]: prev, [k.history]: rest } }, ctx);
      return { ok: true, target: id, note: "The previous picture is fading back in." };
    }
    if (!a.prompt) return { error: "prompt required: what to change, or what to draw with fresh" };
    await handlers.update_data({ target: id, patch: { [k.drawing]: true, ...(a.field && a.aspect ? { [k.aspect]: a.aspect } : {}) } }, ctx);
    void drawImage(id, { prompt: a.prompt, fresh: !!a.fresh || !imageName(data[k.src]), field: a.field }, ctx);
    return { ok: true, target: id, status: "drawing", note: "The picture changes in place within a few seconds (a fade)." };
  },

  async pin(a) {
    const cid = await resolveTarget(a.canvas_id);
    if (!isCanvasId(cid)) throw new Error("pin takes a canvas id");
    const c = await readCanvas(cid);
    if (!c) throw new Error(`canvas ${cid} not found`);
    const title = a.title ?? c.meta.title ?? c.spec.title ?? "Widget";
    return lock("screens", async () => {
      // idempotent: the same canvas (or an undo copy of it) is pinned once
      const origin = c.meta.undo_of ?? cid;
      for (const id of await listAppIds()) {
        const ex = await readApp(id);
        if (ex && (ex.app.from_canvas === cid || ex.app.from_canvas === origin)) {
          return { app_id: id, screen: ex.app.screen, size: ex.app.layout?.size, live: !!ex.app.source, already_pinned: true };
        }
      }
      let slug = slugify(a.slug ?? title, 32);
      const taken = new Set(await listAppIds());
      if (taken.has(slug)) {
        let i = 2;
        while (taken.has(`${slug}-${i}`)) i++;
        slug = `${slug}-${i}`;
      }
      const dir = paths.appDir(slug);
      await fs.mkdir(dir, { recursive: true });
      const src = paths.canvasDir(cid);
      if (exists(path.join(src, "fetch.py"))) await fs.copyFile(path.join(src, "fetch.py"), path.join(dir, "fetch.py"));
      await writeJson(path.join(dir, "data.json"), c.data);
      await writeJson(path.join(dir, "spec.json"), c.spec);
      const size = a.size ?? defaultSize(c.spec);
      const app: AppJson = {
        schema_version: 1, id: slug, title, screen: "s1", pinned_at: now(),
        refresh_s: c.meta.source?.refresh_s ?? null, source: c.meta.source, from_canvas: cid,
      };
      await writeJson(path.join(dir, "app.json"), app);
      const placed = await placeNew(slug, size);
      if (app.source) void scheduleApp(slug, true);
      return { app_id: slug, screen: placed.screen, size, position: { x: placed.layout.x, y: placed.layout.y }, live: !!app.source };
    });
  },

  async resize_widget(a) {
    return lock("screens", () => resize(a.app_id, a.size));
  },

  async unpin(a) {
    const dir = paths.appDir(a.app_id);
    if (!exists(dir)) throw new Error(`unknown app "${a.app_id}"`);
    unscheduleApp(a.app_id);
    return lock("screens", async () => {
      const dest = path.join(paths.trash, `${a.app_id}-${Date.now()}`);
      await fs.mkdir(paths.trash, { recursive: true });
      await fs.rename(dir, dest);
      await pruneScreens();
      return { ok: true, trashed: path.relative(paths.home, dest) };
    });
  },

  async make_live(a) {
    const id = await resolveTarget(a.target);
    const dir = targetDir(id);
    const ref = await stageSource(dir, a.source);
    const first = await runSource(dir, ref);
    if (isCanvasId(id)) {
      const metaFile = path.join(dir, "meta.json");
      const meta = CanvasMeta.parse(await readJson(metaFile));
      await writeJson(metaFile, { ...meta, source: ref });
      await syncCanvasJob(false); // refreshes on the canvas now; pinning hands it to the widget
    } else {
      const appFile = path.join(dir, "app.json");
      const app = (await readJson<AppJson>(appFile))!;
      await writeJson(appFile, { ...app, source: ref, refresh_s: ref.refresh_s });
      await scheduleApp(id, false);
    }
    return {
      target: id,
      first_run: first.ok ? "ok" : "failed",
      ...(first.ok ? { data_patch: first.patch } : { error: first.error, stderr: first.stderr?.slice(-1500) }),
      note: isCanvasId(id) ? `live on the canvas now (every ${ref.refresh_s}s); if pinned, the widget keeps refreshing on its own` : `refreshing every ${ref.refresh_s}s`,
    };
  },

  async undo(_a, ctx) {
    const ids = await listCanvasIds();
    const cur = ids[ids.length - 1];
    if (!cur) return { error: "nothing to undo" };
    const meta = (await readCanvas(cur))?.meta;
    // if the current canvas is itself an undo copy, step back from the original
    const pos = ids.indexOf(meta?.undo_of ?? cur);
    const prev = pos > 0 ? ids[pos - 1] : undefined;
    if (!prev) return { error: "no previous canvas" };
    return showCanvas(prev, ctx);
  },

  async create_tasks(a, ctx) {
    return tasksApi.create(a, ctx);
  },

  async resolve_approval(a) {
    const found = findApproval(a.approval);
    if ("error" in found) return found;
    const id = found.id;
    const title = approvalsForModel().find((x) => x.approval_id === id)?.title;
    if (a.action === "undo") return cancelCommit(id) ? { ok: true, approval: title, note: "voice approval undone; the card is still pending" } : { error: "nothing to undo (not in an undo window)" };
    if (a.action === "reject") return rejectApproval(id) ? { ok: true, approval: title, rejected: true } : { error: "already resolved" };
    if (a.fields && Object.keys(a.fields).length) {
      const r = editApproval(id, a.fields);
      if (r.error) return { error: r.error, approval: title };
      if (a.action === "edit") return { ok: true, approval: title, changed: r.changed, note: "the card on the phone shows the edit; it is still pending" };
    } else if (a.action === "edit") return { error: "edit needs fields", fields: approvalsForModel().find((x) => x.approval_id === id)?.fields };
    focusApproval(id);
    const c = commitWithUndo(id);
    return c.error ? { error: c.error } : { ok: true, approval: title, accepted_after_undo_window: c.until, note: "tell the user it goes through in 5 seconds unless they say undo" };
  },

  async focus_approval(a) {
    const found = findApproval(a.approval);
    if ("error" in found) return found;
    return focusApproval(found.id) ? { ok: true } : { error: "no pending approval cards" };
  },

  async amend_task(a) {
    return tasksApi.amend(a.id, a.change);
  },

  async cancel_task(a) {
    return tasksApi.cancel(a.id, a.reason);
  },

  async update_task(a) {
    const t = await readTask(a.id);
    if (!t) throw new Error(`unknown task "${a.id}"`);
    await writeTask({ ...t.task, status: a.status, summary: a.summary ?? t.task.summary, updated_at: now() });
    if (a.result) await writeJson(path.join(paths.taskDir(a.id), "result.json"), { ...t.result, ...a.result });
    tasksApi.onUpdate(a.id);
    return { ok: true };
  },

  async get_state(a) {
    switch (a.scope) {
      case "tasks": {
        const out = [];
        for (const id of await listTaskIds()) {
          const t = await readTask(id);
          if (t) out.push({ id, title: t.task.title, status: t.task.status, kind: t.task.kind, depends_on: t.task.depends_on, summary: t.task.summary });
        }
        return { tasks: out };
      }
      case "apps": {
        const out = [];
        for (const id of await listAppIds()) {
          const x = await readApp(id);
          if (x) out.push({ id, title: x.app.title, screen: x.app.screen, size: x.app.layout?.size, live: x.app.refresh_s, last_ok: x.job?.last_ok, last_error: x.job?.last_error });
        }
        return { apps: out };
      }
      case "canvas": {
        const id = await latestCanvasId();
        const c = id ? await readCanvas(id) : null;
        if (!c) return { canvas: null };
        const types = Object.values(c.spec.components).map((x) => x.type);
        return { canvas: { id, title: c.meta.title ?? c.spec.title, components: types, live: !!c.meta.source, data_keys: Object.keys((c.data as object) ?? {}) }, history: await listCanvasIds() };
      }
      case "approvals":
        return { approvals: approvalsForModel() };
      case "screens": {
        const s = await readScreens();
        const apps: { id: string; screen: string; size?: string; x?: number; y?: number; user_placed: boolean }[] = [];
        for (const id of await listAppIds()) {
          const x = await readApp(id);
          if (x) apps.push({ id, screen: x.app.screen, size: x.app.layout?.size, x: x.app.layout?.x, y: x.app.layout?.y, user_placed: !!x.app.layout?.locked });
        }
        return { active_theme: s.active_theme, themes: await listThemes(), grid: "4 columns × 6 rows per screen; sizes S 2×2, W 4×2, L 4×4, T 2×4", screens: s.screens.map((sc) => ({ id: sc.id, widgets: apps.filter((a) => a.screen === sc.id) })) };
      }
    }
  },

  async ask_approval(a, ctx) {
    const { approval_id, promise } = requestApproval(a.card, { modal: a.modal !== false });
    if (ctx.task_id) {
      // task-owned approval: the task waits for the user and finishes with their choice
      await tasksApi.waitApproval(ctx.task_id, a.card, promise, approval_id);
      return { status: "started", ref: approval_id, note: "Shown to the user. The task now waits for their choice and is completed automatically — do not call update_task." };
    }
    void promise.then((o) =>
      hub.asyncResult({
        ref: approval_id,
        session_id: ctx.session_id,
        text: redact(`Approval "${a.card.title}": user chose ${o.action}${o.fields ? ` with fields ${JSON.stringify(o.fields)}` : ""}.`),
        result: o,
      }),
    );
    return { status: "started", ref: approval_id, note: "Shown to the user; the choice will be reported later." };
  },

  async notify(a) {
    bus.emit({ type: "toast", text: a.text, kind: a.kind ?? "info", sound: a.sound });
    return { ok: true };
  },

  async set_theme(a) {
    return lock("screens", async () => {
      const screens = await readScreens();
      let name = a.name ?? screens.active_theme;
      if (a.tokens) {
        const base: Theme = (await readTheme(name)) ?? (await activeTheme());
        if (!a.name) name = `custom-${Date.now().toString(36)}`;
        const theme: Theme = {
          ...base, name,
          colors: { ...base.colors, ...a.tokens.colors },
          dark: { ...base.dark, ...a.tokens.dark },
          // clamp layout tokens: models sometimes send rem-like values (spacing: 1) that break the layout
          radius: clamp(a.tokens.radius ?? base.radius, 0, 32), font: a.tokens.font ?? base.font, spacing: clamp(a.tokens.spacing ?? base.spacing, 12, 24),
        };
        await writeJson(path.join(paths.themes, `${slugify(name)}.json`), theme);
        name = slugify(name);
      } else if (!(await readTheme(name))) {
        return { error: `unknown theme "${name}"`, available: await listThemes() };
      }
      await writeScreens({ ...screens, active_theme: name });
      return { ok: true, active_theme: name };
    });
  },

  async open_link(a) {
    bus.emit({ type: "open_link", href: a.href, kind: a.kind });
    return { ok: true };
  },

  async fetch_json(a) {
    const res = await fetch(a.url, { headers: { "user-agent": "canvas-agent/0.1", ...a.headers }, signal: AbortSignal.timeout(10_000) });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {}
    const s = JSON.stringify(body);
    return { status: res.status, body: s.length > 20_000 ? `${s.slice(0, 20_000)}…(truncated)` : body };
  },

  async call_contact(a, ctx) {
    const id = await tasksApi.startAction({ type: "call", contact: a.contact, reason: a.reason }, `Call ${a.contact}`, ctx);
    return { status: "started", task: id, note: `The phone shows the confirmation card for calling ${a.contact} (asking for the number first if it's missing). You'll be told the outcome.` };
  },

  async send_email(a, ctx) {
    if (!a.to && a.reply_to_uid == null) return { error: "give `to` (a contact name) or `reply_to_uid`" };
    const who = a.to ?? "the sender";
    const id = await tasksApi.startAction(
      { type: "email", contact: a.to, reply_to_uid: a.reply_to_uid, subject: a.subject, body: a.body },
      a.reply_to_uid != null ? `Reply to ${who}` : `Email ${who}`,
      ctx,
    );
    return { status: "started", task: id, note: `The phone shows the email to ${who} for approval (asking for the address first if it's missing). You'll be told the outcome.` };
  },

  async watch(a, ctx) {
    let id = await resolveTarget(a.target);
    let pinned: unknown;
    if (isCanvasId(id)) {
      // a watch must keep checking after the canvas changes → it lives on a pinned widget
      const p = (await handlers.pin({ canvas_id: id }, ctx)) as { app_id: string };
      pinned = p;
      id = p.app_id;
    }
    const app = await readApp(id);
    if (!app) return { error: `unknown widget "${id}"` };
    const rules = await readRules(id);
    const rule = {
      id: [slugify(a.path, 20), OP_NAMES[a.op], String(a.value ?? "").replace(/\W/g, "")].filter(Boolean).join("-"),
      path: a.path, op: a.op, value: a.value, message: a.message, mode: a.mode ?? "cross", cooldown_s: a.cooldown_s ?? 0, created_at: now(),
    };
    await writeRules(id, [...rules.filter((r) => r.id !== rule.id), rule]);
    const current = resolvePointer(app.data, a.path);
    // without a live source the rule is checked whenever update_data changes the widget (e.g. a scheduled check)
    const checks = app.app.source ? `after every refresh (${app.app.refresh_s}s)` : "whenever update_data changes this widget — it has no live source, so schedule a recurring check that updates it (or make_live)";
    return { ok: true, app_id: id, rule_id: rule.id, current_value: current ?? null, checks, pinned };
  },

  async unwatch(a) {
    const rules = await readRules(a.target);
    const left = a.id ? rules.filter((r) => r.id !== a.id) : [];
    await writeRules(a.target, left);
    return { ok: true, removed: rules.length - left.length };
  },

  async schedule(a, ctx) {
    return createTimeTrigger(a, ctx.session_id);
  },

  async list_triggers() {
    return { triggers: (await listTriggers()).filter((t) => t.status === "active").map((t) => ({ id: t.id, label: t.label, source: t.source, at: t.at, cron: t.cron, action: t.action?.type, fired: t.fired })) };
  },

  async cancel_trigger(a) {
    return cancelTrigger(a.id);
  },

  async watch_email(a) {
    const r = await createEmailTrigger(a);
    return emailConfigured() ? r : { ...r, warning: "email isn't set up on this device yet (EMAIL_USER / EMAIL_PASSWORD); the trigger starts working once it is" };
  },

  async ui_action(a) {
    return applyAction({ target: a.target, component_id: a.component_id, action: a.action, args: a.args });
  },

  async read_widget(a) {
    return readWidget(a.target);
  },

  async find_emails(a) {
    if (!emailConfigured()) return { error: "email isn't set up on this device (EMAIL_USER / EMAIL_PASSWORD in .env)" };
    let fromAddress: string | undefined;
    if (a.from) {
      const c = await findContact(a.from);
      if (!c) return { error: `no contact named ${a.from}` };
      if (!c.emails[0]) return { error: `no email address on file for ${c.name}` };
      fromAddress = c.emails[0];
    }
    const list = await findEmails({ fromAddress, query: a.query, limit: a.limit });
    // bodies can contain signatures with numbers/addresses: mask them before they reach the model
    return { emails: list.map((m) => ({ ...m, subject: redact(m.subject), text: redact(m.text) })) };
  },

  async run_python(a) {
    const r = await runPython({ code: a.code, timeout_s: a.timeout_s ?? 30 });
    return { stdout: r.stdout.slice(-12_000), stderr: r.stderr.slice(-4000), exit_code: r.exit_code, timed_out: r.timed_out };
  },
};

/** Re-render an existing canvas as the new current one (canvas folders are immutable). */
export async function showCanvas(id: string, ctx: ToolCtx = {}) {
  const p = await readCanvas(id);
  if (!p) return { error: `canvas ${id} not found` };
  const extra: Record<string, string> = {};
  const fp = path.join(paths.canvasDir(id), "fetch.py");
  if (exists(fp)) extra["fetch.py"] = await fs.readFile(fp, "utf8");
  const nid = await createCanvas(p.spec, p.data, { title: p.meta.title, prompt: p.meta.prompt, session_id: ctx.session_id, source: p.meta.source, undo_of: id }, extra);
  void syncCanvasJob(!!p.meta.source);
  return { canvas_id: nid, restored: id };
}

/** Validate + execute a tool call. Never throws: errors are returned to the model as data. */
export async function executeTool(name: string, rawArgs: unknown, ctx: ToolCtx = {}): Promise<unknown> {
  if (name in HelperArgs) {
    const t0 = Date.now();
    const out = await runHelper(name as HelperName, rawArgs);
    console.log(`[tool] ${name} ${Date.now() - t0}ms${ctx.actor ? ` (${ctx.actor})` : ""}`);
    record({ kind: "tool", title: name, detail: brief(out), ok: !(out as { error?: unknown })?.error, ms: Date.now() - t0, actor: ctx.actor });
    return out;
  }
  if (!(name in handlers)) return { error: `unknown tool "${name}"` };
  const n = name as ToolName;
  const parsed = (ToolArgs[n] as z.ZodTypeAny).safeParse(rawArgs ?? {});
  if (!parsed.success) return { error: "invalid arguments", details: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".")}: ${i.message}`) };
  const t0 = Date.now();
  try {
    const out = await (handlers[n] as Handler<ToolName>)(parsed.data as never, ctx);
    console.log(`[tool] ${n} ${Date.now() - t0}ms${ctx.actor ? ` (${ctx.actor})` : ""}`);
    // calls without an actor are the runner's own (e.g. building prompts) — not agent activity
    if (ctx.actor) record({ kind: "tool", title: n, detail: brief(out), ok: !(out as { error?: unknown })?.error, ms: Date.now() - t0, actor: ctx.actor });
    return out;
  } catch (err) {
    console.warn(`[tool] ${n} failed:`, err);
    record({ kind: "tool", title: n, detail: err instanceof Error ? err.message : String(err), ok: false, ms: Date.now() - t0, actor: ctx.actor });
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export const sideEffectsEnabled = () => env.ENABLE_SIDE_EFFECTS;
export type { CanvasSpec };

/** Data keys of one picture: an image card uses src/prompt/…; a Custom card names a field (img → img, img_prompt, …). */
function imageKeys(field?: string) {
  const f = field ? `${field}_` : "";
  return { src: field ?? "src", prompt: `${f}prompt`, aspect: `${f}aspect`, drawing: field ? `${f}drawing` : "drawing", history: `${f}history` };
}

/**
 * Background half of generate_image: one picture at a time per card, each edit starting from the latest
 * picture (so "darker" then "add a hat" stack). The card's data gets the new src and the old one goes to
 * history (last 10, for revert).
 */
async function drawImage(id: string, job: { prompt: string; fresh: boolean; field?: string }, ctx: ToolCtx) {
  const k = imageKeys(job.field);
  await lock(`image:${id}`, async () => {
    const file = path.join(targetDir(id), "data.json");
    const data = ((await readJson(file)) ?? {}) as Record<string, unknown>;
    const src = typeof data[k.src] === "string" ? (data[k.src] as string) : "";
    const oldPrompt = typeof data[k.prompt] === "string" ? (data[k.prompt] as string) : "";
    const history = (data[k.history] as string[] | undefined) ?? [];
    const t0 = Date.now();
    try {
      const from = job.fresh ? undefined : imageName(src);
      const name = await makeImage(job.fresh ? job.prompt : `Edit this picture: ${job.prompt}. Keep everything else the same.`, String(data[k.aspect] ?? "1:1"), from);
      const prompt = job.fresh || !oldPrompt ? job.prompt : `${oldPrompt} · ${job.prompt}`.slice(-400);
      const patch = { [k.src]: imageUrl(name), [k.prompt]: prompt, [k.drawing]: false, [k.history]: src ? [src, ...history].slice(0, 10) : history };
      await handlers.update_data({ target: id, patch }, ctx);
      // pinned while this first picture was still being drawn: the widget copied the empty card, so it gets it too
      if (isCanvasId(id)) {
        for (const appId of await listAppIds()) {
          const app = await readApp(appId);
          const d = (app?.data ?? {}) as Record<string, unknown>;
          if (app?.app.from_canvas === id && d[k.drawing] && !imageName(d[k.src])) await handlers.update_data({ target: appId, patch }, ctx);
        }
      }
      record({ kind: "tool", title: `image ${from ? "edited" : "drawn"}`, detail: job.prompt.slice(0, 80), ok: true, ms: Date.now() - t0, actor: ctx.actor });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await handlers.update_data({ target: id, patch: { [k.drawing]: false } }, ctx).catch(() => {});
      bus.emit({ type: "toast", text: `Picture: ${msg.slice(0, 140)}`, kind: "error" });
      record({ kind: "tool", title: "image failed", detail: msg.slice(0, 160), ok: false, ms: Date.now() - t0, actor: ctx.actor });
    }
  });
}
