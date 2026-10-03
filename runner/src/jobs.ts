import path from "node:path";
import cron, { type ScheduledTask } from "node-cron";
import { mergePatch, resolvePointer, type JobJson, type Source, type SourceRef } from "@canvas-agent/contract";
import { atomicWrite, exists, lock, now, readJson, writeJson } from "./fsutil.ts";
import { lastJsonObject, runPython } from "./python.ts";
import { latestCanvasId, listAppIds, paths, readApp, readCanvas } from "./store.ts";
import { record } from "./monitor.ts";
import { evaluateAlerts, type ScriptAlert } from "./alerts.ts";
import { pushAll } from "./push.ts";
import { firstValue, startStream } from "./streams.ts";

/**
 * Live data sources: `fetch.py` (python) or an http JSON URL, run on a node-cron
 * schedule for pinned apps. Scripts only ever change data.json in their own folder.
 */
/** Running jobs: a cron task, an exact interval (sub-minute polling) or a live stream. */
const tasks = new Map<string, { stop(): void }>();

/** node-cron expression for a refresh period (sub-minute rounds to 30 s; else whole minutes/hours). */
export function cronExpr(refresh_s: number): string {
  if (refresh_s < 60) return "*/30 * * * * *";
  const m = Math.round(refresh_s / 60);
  if (m < 60) return `0 */${m} * * * *`;
  const h = Math.min(23, Math.round(m / 60));
  return `0 0 */${h} * * *`;
}

/** Stored reference for a source (python code itself lives in fetch.py). */
export function sourceRef(src: Source): SourceRef {
  if (src.type === "python") return { type: "python", entry: "fetch.py", refresh_s: src.refresh_s };
  if (src.type === "http") return { type: "http", entry: src.url, refresh_s: src.refresh_s, json_path: src.json_path };
  return { type: "stream", entry: src.provider ? `${src.provider}:${src.symbol ?? ""}` : String(src.url ?? ""), refresh_s: 1, stream: { provider: src.provider, symbol: src.symbol, url: src.url, subscribe: src.subscribe, map: src.map } };
}

/** Write the source into `dir` and return its stored reference. */
export async function stageSource(dir: string, src: Source): Promise<SourceRef> {
  if (src.type === "python") await atomicWrite(path.join(dir, "fetch.py"), src.code);
  return sourceRef(src);
}

export interface RunOutcome { ok: boolean; patch?: Record<string, unknown>; alerts?: ScriptAlert[]; data?: unknown; error?: string; stderr?: string; ms: number }

/** Run a folder's source once and merge its output into data.json. */
export async function runSource(dir: string, ref: SourceRef): Promise<RunOutcome> {
  const started = Date.now();
  let patch: Record<string, unknown> | null = null;
  try {
    if (ref.type === "stream") {
      const v = await firstValue(ref);
      if (!v) return { ok: false, error: "no data from the stream within 8 s", ms: Date.now() - started };
      patch = v;
    } else if (ref.type === "python") {
      const r = await runPython({ file: path.join(dir, ref.entry), cwd: dir, timeout_s: 30 });
      if (r.timed_out) return { ok: false, error: "timeout after 30 s", stderr: r.stderr, ms: r.ms };
      if (r.exit_code !== 0) return { ok: false, error: `exit ${r.exit_code}`, stderr: r.stderr, ms: r.ms };
      patch = lastJsonObject(r.stdout);
      if (!patch) return { ok: true, ms: r.ms }; // script wrote data.json itself
    } else {
      const res = await fetch(ref.entry, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "canvas-agent/0.1" } });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, ms: Date.now() - started };
      let v: unknown = await res.json();
      if (ref.json_path) v = ref.json_path.startsWith("/") ? resolvePointer(v, ref.json_path) : ref.json_path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], v);
      patch = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
    }
    // `_alerts` is a signal for the runner, not widget data
    const alerts = Array.isArray(patch._alerts) ? (patch._alerts as ScriptAlert[]) : [];
    delete patch._alerts;
    patch = { ...patch, updated_at: now() };
    let data: unknown;
    await lock(`data:${dir}`, async () => {
      const file = path.join(dir, "data.json");
      data = mergePatch((await readJson(file)) ?? {}, patch);
      await writeJson(file, data);
    });
    return { ok: true, patch, alerts, data, ms: Date.now() - started };
  } catch (err) {
    return { ok: false, error: String(err), ms: Date.now() - started };
  }
}

const running = new Set<string>();

/** Live view of jobs for the dashboard. */
export interface JobInfo { key: string; refresh_s: number; source: string; runs: number; last_run: string | null; last_ok: string | null; last_error: string | null; last_ms: number | null; running: boolean; failures?: number }
const info = new Map<string, JobInfo>();
export const listJobs = () => [...tasks.keys()].map((k) => ({ ...(info.get(k) as JobInfo), running: running.has(k) })).filter((j) => j.key);

/** A job key is "app:<slug>" or "canvas:<id>"; both refresh their folder's data.json. */
async function runJob(key: string, dir: string, ref: SourceRef, writeJobFile: boolean) {
  if (running.has(key)) return;
  running.add(key);
  try {
    const out = await runSource(dir, ref);
    const i = info.get(key);
    if (i) {
      const at = now();
      Object.assign(i, { runs: i.runs + 1, last_run: at, last_ms: out.ms, failures: out.ok ? 0 : (i.failures ?? 0) + 1, ...(out.ok ? { last_ok: at, last_error: null } : { last_error: `${out.error ?? ""}`.slice(0, 200) }) });
      // a widget that keeps failing is worth one notification (not one per run)
      if (!out.ok && i.failures === 3 && key.startsWith("app:")) void pushAll({ title: "Live widget failing", body: `${key.slice(4)}: ${i.last_error ?? "error"}`, url: `/#app=${key.slice(4)}`, tag: `fail-${key}` });
    }
    if (out.ok && key.startsWith("app:")) await evaluateAlerts(key.slice(4), out.data ?? {}, out.alerts ?? []).catch((e) => console.warn("[alerts]", e));
    record({ kind: "job", title: key, detail: out.ok ? (out.patch ? Object.entries(out.patch).filter(([k]) => k !== "updated_at").slice(0, 3).map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join(" ") : "ok") : (out.error ?? "failed"), ok: out.ok, ms: out.ms });
    if (writeJobFile) {
      const prev = (await readJson<JobJson>(path.join(dir, "job.json"))) ?? { last_run: null, last_ok: null, last_error: null, runs: 0 };
      const at = now();
      await writeJson(path.join(dir, "job.json"), {
        last_run: at,
        last_ok: out.ok ? at : prev.last_ok,
        last_error: out.ok ? null : `${out.error ?? ""} ${out.stderr ?? ""}`.trim().slice(-500),
        runs: prev.runs + 1,
      } satisfies JobJson);
    }
    if (!out.ok) console.warn(`[jobs] ${key} failed:`, out.error);
  } finally {
    running.delete(key);
  }
}

function schedule(key: string, dir: string, ref: SourceRef, writeJobFile: boolean) {
  unschedule(key);
  let handle: { stop(): void };
  if (ref.type === "stream") {
    // real-time: values are saved as they arrive (throttled); alerts checked on each save
    handle = startStream(
      dir,
      ref,
      (data) => {
        const i = info.get(key);
        if (i) Object.assign(i, { runs: i.runs + 1, last_run: now(), last_ok: now(), last_error: null });
        if (key.startsWith("app:")) void evaluateAlerts(key.slice(4), data, []).catch(() => {});
      },
      (ok, err) => {
        const i = info.get(key);
        if (i && !ok) i.last_error = `stream: ${err ?? "disconnected"} (reconnecting)`;
        record({ kind: "job", title: `${key} stream ${ok ? "connected" : "disconnected"}`, detail: err, ok });
      },
    );
  } else if (ref.refresh_s < 60) {
    // sub-minute polling (http ≥ 5 s): an exact interval instead of cron rounding
    const t = setInterval(() => void runJob(key, dir, ref, writeJobFile), ref.refresh_s * 1000);
    handle = { stop: () => clearInterval(t) };
  } else {
    const t: ScheduledTask = cron.schedule(cronExpr(ref.refresh_s), () => void runJob(key, dir, ref, writeJobFile), { name: key, noOverlap: true });
    handle = { stop: () => (void t.stop(), void t.destroy()) };
  }
  tasks.set(key, handle);
  const prev = info.get(key);
  info.set(key, { key, refresh_s: ref.refresh_s, source: ref.type === "python" ? ref.entry : ref.entry.slice(0, 80), runs: prev?.runs ?? 0, last_run: prev?.last_run ?? null, last_ok: prev?.last_ok ?? null, last_error: prev?.last_error ?? null, last_ms: prev?.last_ms ?? null, running: false });
}

function unschedule(key: string) {
  const t = tasks.get(key);
  if (t) {
    t.stop();
    tasks.delete(key);
  }
}

export async function scheduleApp(appId: string, runNow = true) {
  unschedule(`app:${appId}`);
  const a = await readApp(appId);
  if (!a?.app.source || !a.app.refresh_s) return;
  const dir = paths.appDir(appId);
  schedule(`app:${appId}`, dir, a.app.source, true);
  if (runNow) await runJob(`app:${appId}`, dir, a.app.source, true);
}

export function unscheduleApp(appId: string) {
  unschedule(`app:${appId}`);
}

/**
 * Live canvas: only the CURRENT canvas refreshes (older canvases in the ring buffer
 * are history). Called whenever the current canvas may have changed.
 */
export async function syncCanvasJob(runNow = false) {
  const id = await latestCanvasId();
  const key = id ? `canvas:${id}` : null;
  for (const k of [...tasks.keys()]) if (k.startsWith("canvas:") && k !== key) unschedule(k);
  if (!id || !key) return;
  const c = await readCanvas(id);
  if (!c?.meta.source) return unschedule(key);
  if (!tasks.has(key)) schedule(key, paths.canvasDir(id), c.meta.source, false);
  if (runNow) await runJob(key, paths.canvasDir(id), c.meta.source, false);
}

/** Run an app's job right now (dashboard "refresh", tests). */
export async function runAppNow(appId: string) {
  const a = await readApp(appId);
  if (!a?.app.source) return { error: "not a live widget" };
  await runJob(`app:${appId}`, paths.appDir(appId), a.app.source, true);
  return { ok: true };
}

export function stopAllJobs() {
  for (const k of [...tasks.keys()]) unschedule(k);
}

/** On runner start: resume every pinned app that has a source, and the live current canvas. */
export async function resumeJobs() {
  for (const id of await listAppIds()) {
    if (exists(path.join(paths.appDir(id), "app.json"))) await scheduleApp(id, true).catch((e) => console.warn("[jobs]", id, e));
  }
  await syncCanvasJob(true).catch((e) => console.warn("[jobs] canvas", e));
  if (tasks.size) console.log(`[jobs] resumed ${tasks.size} live job(s)`);
}

export const jobCount = () => tasks.size;
