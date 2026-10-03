import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import { TriggerJson, type TriggerAction, type ToolArgsOf } from "@canvas-agent/contract";
import { hasLiveVoice, injectActive } from "./brain.ts";
import { bus } from "./bus.ts";
import { env } from "./env.ts";
import { now, readJson, slugify, writeJson } from "./fsutil.ts";
import { record } from "./monitor.ts";
import { pushAll } from "./push.ts";
import { paths } from "./store.ts";
import { tasksApi } from "./tasks-hook.ts";

/**
 * Triggers: source → action. Time triggers fire once (`at`) or repeatedly (`cron`); email triggers
 * are evaluated by the email watcher. Each trigger is a file in agent-home/triggers/ so they survive
 * restarts; one-shots missed while the runner was down fire on start if late by < 10 min, otherwise
 * they're marked missed and the user is told.
 */
const DIR = () => path.join(paths.home, "triggers");
const file = (id: string) => path.join(DIR(), `${id}.json`);
const timers = new Map<string, NodeJS.Timeout | ScheduledTask>();
const LATE_OK_MS = 10 * 60_000;
const MAX_TIMEOUT = 2 ** 31 - 1; // ~24.8 days

export async function listTriggers(): Promise<TriggerJson[]> {
  const out: TriggerJson[] = [];
  for (const f of await fs.readdir(DIR()).catch(() => [])) {
    if (!f.endsWith(".json") || f.startsWith("_")) continue;
    const t = TriggerJson.safeParse(await readJson(path.join(DIR(), f)));
    if (t.success) out.push(t.data);
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function save(t: TriggerJson) {
  await writeJson(file(t.id), t);
  await broadcast();
}
async function broadcast() {
  bus.emit({ type: "triggers", triggers: (await listTriggers()).filter((t) => t.status === "active") });
}

/** "HH:MM" → next occurrence today/tomorrow (local time); ISO stays as is. */
export function resolveAt(at: string): Date | null {
  const hm = at.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (hm) {
    const d = new Date();
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d;
  }
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function createTimeTrigger(a: ToolArgsOf<"schedule">, session_id?: string) {
  const w = a.when;
  if (!w.in_s && !w.at && !w.cron) return { error: "give when.in_s, when.at or when.cron" };
  if (w.cron && !cron.validate(w.cron)) return { error: `invalid cron "${w.cron}"` };
  let at: string | undefined;
  if (!w.cron) {
    const d = w.in_s ? new Date(Date.now() + w.in_s * 1000) : resolveAt(w.at!);
    if (!d) return { error: `can't read the time "${w.at}"` };
    at = d.toISOString();
  }
  const label = a.label ?? (a.action.text ?? a.action.title ?? a.action.type).slice(0, 60);
  const id = `${slugify(label, 24)}-${randomBytes(3).toString("hex")}`;
  const t: TriggerJson = { schema_version: 1, id, label, source: "time", at, cron: w.cron, action: a.action, status: "active", created_at: now(), fired: 0 };
  await save(t);
  if (session_id) origins.set(id, session_id);
  arm(t);
  return { ok: true, id, label, ...(at ? { fires_at: at, in_s: Math.round((Date.parse(at) - Date.now()) / 1000) } : { cron: w.cron }) };
}

export async function createEmailTrigger(a: ToolArgsOf<"watch_email">) {
  if (!a.from && !a.contains && !a.any) return { error: "say whose emails (from), which (contains) or any: true" };
  const label = `Reply drafts: ${a.from ? `from ${a.from}` : a.contains ? `mentioning "${a.contains}"` : "any email needing a reply"}`;
  const id = `email-${slugify(a.from ?? a.contains ?? "any", 20)}-${randomBytes(3).toString("hex")}`;
  const t: TriggerJson = { schema_version: 1, id, label, source: "email", email: { from: a.from, contains: a.contains, any: a.any, instructions: a.instructions }, status: "active", created_at: now(), fired: 0 };
  await save(t);
  return { ok: true, id, label, note: "Checked about every minute while the runner is on; each drafted reply waits for the user's approval." };
}

export async function cancelTrigger(id: string) {
  const t = TriggerJson.safeParse(await readJson(file(id)));
  if (!t.success) return { error: `unknown trigger "${id}"` };
  disarm(id);
  await save({ ...t.data, status: "cancelled" });
  return { ok: true, id };
}

const origins = new Map<string, string>(); // trigger → session that created it (for speak/notices)

function disarm(id: string) {
  const h = timers.get(id);
  if (!h) return;
  if (typeof (h as ScheduledTask).stop === "function") {
    void (h as ScheduledTask).stop();
    void (h as ScheduledTask).destroy();
  } else clearTimeout(h as NodeJS.Timeout);
  timers.delete(id);
}

function arm(t: TriggerJson) {
  disarm(t.id);
  if (t.status !== "active" || t.source !== "time") return;
  if (t.cron) {
    timers.set(t.id, cron.schedule(t.cron, () => void fire(t.id), { name: `trigger:${t.id}`, noOverlap: true, timezone: env.TIMEZONE }));
    return;
  }
  const due = Date.parse(t.at ?? "");
  const wait = due - Date.now();
  if (wait <= 0) {
    void fire(t.id, -wait);
    return;
  }
  // long waits are re-armed in steps (setTimeout max ~24.8 days)
  timers.set(t.id, setTimeout(() => (wait > MAX_TIMEOUT ? arm(t) : void fire(t.id)), Math.min(wait, MAX_TIMEOUT)));
}

async function fire(id: string, lateMs = 0) {
  const r = TriggerJson.safeParse(await readJson(file(id)));
  if (!r.success || r.data.status !== "active") return;
  const t = r.data;
  if (!t.cron && lateMs > LATE_OK_MS) {
    await save({ ...t, status: "missed" });
    bus.emit({ type: "toast", text: `Missed while offline: ${t.label}`, kind: "warn" });
    record({ kind: "system", title: `trigger missed: ${t.label}`, detail: `${Math.round(lateMs / 60000)} min late`, ok: false });
    return;
  }
  record({ kind: "system", title: `trigger fired: ${t.label}`, detail: t.action?.type, ok: true });
  if (t.action) await perform(t.action, t, origins.get(id));
  await save({ ...t, fired: t.fired + 1, last_fired: now(), status: t.cron ? "active" : "done" });
  if (!t.cron) timers.delete(id);
}

async function perform(a: TriggerAction, t: TriggerJson, session_id?: string) {
  const text = a.text ?? t.label;
  if (a.type === "notify") {
    bus.emit({ type: "toast", text: `⏰ ${text}`, kind: "info", sound: "ding" });
    await pushAll({ title: "⏰ Reminder", body: text, url: "/", tag: `trigger-${t.id}` });
    return;
  }
  if (a.type === "speak") {
    // said aloud where possible: live voice call → the app on screen → otherwise a notification
    if (hasLiveVoice()) injectActive(`Say this to the user now (it's a scheduled message): "${text}"`, session_id);
    else if (bus.anyVisible()) bus.emit({ type: "speak", text });
    else await pushAll({ title: "🔊 Message", body: text, url: "/", tag: `trigger-${t.id}` });
    return;
  }
  await tasksApi.create({ tasks: [{ title: a.title ?? t.label, kind: a.kind ?? "background", details: a.details ?? text }] }, { session_id, actor: `trigger:${t.id}` });
}

/** On start: arm every active time trigger (late one-shots fire or are marked missed). */
export async function resumeTriggers() {
  await fs.mkdir(DIR(), { recursive: true });
  const all = await listTriggers();
  for (const t of all) if (t.status === "active" && t.source === "time") arm(t);
  const n = all.filter((t) => t.status === "active").length;
  if (n) console.log(`[triggers] ${n} active trigger(s)`);
}

export function stopAllTriggers() {
  for (const id of [...timers.keys()]) disarm(id);
}

export const activeEmailTriggers = async () => (await listTriggers()).filter((t) => t.source === "email" && t.status === "active");
export async function markEmailFired(t: TriggerJson) {
  await save({ ...t, fired: t.fired + 1, last_fired: now() });
}
