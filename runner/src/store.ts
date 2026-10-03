import fs from "node:fs/promises";
import path from "node:path";
import {
  AppJson, CANVAS_RING_SIZE, CanvasMeta, CanvasSpec, JobJson, ScreensJson, TaskJson, TaskResult, Theme,
  type AppEntry, type CanvasEntry, type StateSnapshot, type TaskEntry,
} from "@canvas-agent/contract";
import { env } from "./env.ts";
import { exists, listDirs, lock, now, readJson, writeJson } from "./fsutil.ts";
import { pendingApprovals } from "./approvals.ts";

/** File-backed state under AGENT_HOME (B4). Files are the state; this module only reads/writes them. */
const H = env.AGENT_HOME;
export const paths = {
  home: H,
  canvas: path.join(H, "canvas"),
  canvasDir: (id: string) => path.join(H, "canvas", id),
  apps: path.join(H, "apps"),
  appDir: (id: string) => path.join(H, "apps", id),
  trash: path.join(H, "apps", "_trash"),
  tasks: path.join(H, "tasks"),
  taskDir: (id: string) => path.join(H, "tasks", id),
  screens: path.join(H, "screens.json"),
  themes: path.join(H, "themes"),
  identity: path.join(H, "identity"),
  sessions: path.join(H, "sessions"),
  tmp: path.join(H, "tmp"),
  uploads: path.join(H, "uploads"),
};

export const isCanvasId = (s: string) => /^\d{4,}$/.test(s);

// ---------- canvas ----------
export const listCanvasIds = () => listDirs(paths.canvas).then((d) => d.filter(isCanvasId));

export async function readCanvas(id: string): Promise<CanvasEntry | null> {
  const dir = paths.canvasDir(id);
  const spec = await readJson(path.join(dir, "spec.json"));
  const meta = await readJson(path.join(dir, "meta.json"));
  if (!spec || !meta) return null;
  const s = CanvasSpec.safeParse(spec);
  const m = CanvasMeta.safeParse(meta);
  if (!s.success || !m.success) return null;
  return { id, spec: s.data, data: (await readJson(path.join(dir, "data.json"))) ?? {}, meta: m.data };
}

export async function latestCanvasId(): Promise<string | null> {
  const ids = await listCanvasIds();
  return ids[ids.length - 1] ?? null;
}

/** Create canvas/NNNN atomically (per-file) and trim the ring buffer. */
export function createCanvas(spec: CanvasSpec, data: unknown, meta: Omit<CanvasMeta, "schema_version" | "created_at">, extraFiles: Record<string, string> = {}) {
  return lock("canvas", async () => {
    const ids = await listCanvasIds();
    const next = String((ids.length ? Number(ids[ids.length - 1]) : 0) + 1).padStart(4, "0");
    const dir = paths.canvasDir(next);
    await fs.mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(extraFiles)) await fs.writeFile(path.join(dir, name), content);
    await writeJson(path.join(dir, "data.json"), data ?? {});
    await writeJson(path.join(dir, "meta.json"), { schema_version: 1, created_at: now(), ...meta });
    // spec last: a canvas is "complete" once spec.json + meta.json exist
    await writeJson(path.join(dir, "spec.json"), spec);
    const all = [...ids, next];
    for (const old of all.slice(0, Math.max(0, all.length - CANVAS_RING_SIZE))) {
      await fs.rm(paths.canvasDir(old), { recursive: true, force: true });
    }
    return next;
  });
}

// ---------- apps ----------
export const listAppIds = () => listDirs(paths.apps);

export async function readApp(id: string): Promise<AppEntry | null> {
  const dir = paths.appDir(id);
  const app = AppJson.safeParse(await readJson(path.join(dir, "app.json")));
  const spec = CanvasSpec.safeParse(await readJson(path.join(dir, "spec.json")));
  if (!app.success || !spec.success) return null;
  const job = JobJson.safeParse(await readJson(path.join(dir, "job.json")));
  const watch = (await readJson<{ rules?: unknown[] }>(path.join(dir, "watch.json")))?.rules?.length ?? 0;
  const active = Object.keys((await readJson<{ active?: Record<string, string> }>(path.join(dir, "alerts.json")))?.active ?? {});
  return {
    id, app: app.data, spec: spec.data, data: (await readJson(path.join(dir, "data.json"))) ?? {}, job: job.success ? job.data : undefined,
    ...(watch || active.length ? { watches: { rules: watch, active } } : {}),
  };
}

// ---------- screens ----------
export async function readScreens(): Promise<ScreensJson> {
  const r = ScreensJson.safeParse(await readJson(paths.screens));
  return r.success ? r.data : { schema_version: 1, active_theme: "default", screens: [{ id: "s1" }] };
}
export const writeScreens = (s: ScreensJson) => writeJson(paths.screens, s);

// ---------- tasks ----------
export const listTaskIds = () => listDirs(paths.tasks);

export async function readTask(id: string): Promise<TaskEntry | null> {
  const t = TaskJson.safeParse(await readJson(path.join(paths.taskDir(id), "task.json")));
  if (!t.success) return null;
  const r = TaskResult.safeParse(await readJson(path.join(paths.taskDir(id), "result.json")));
  return { task: t.data, result: r.success ? r.data : undefined };
}

export async function writeTask(t: TaskJson) {
  await writeJson(path.join(paths.taskDir(t.id), "task.json"), t);
}

export async function appendTaskLog(id: string, line: string) {
  await fs.mkdir(paths.taskDir(id), { recursive: true });
  await fs.appendFile(path.join(paths.taskDir(id), "log.md"), `- ${now()} ${line}\n`);
}

// ---------- themes ----------
export async function readTheme(name: string): Promise<Theme | null> {
  const r = Theme.safeParse(await readJson(path.join(paths.themes, `${name}.json`)));
  return r.success ? r.data : null;
}
export async function activeTheme(): Promise<Theme> {
  const s = await readScreens();
  return (await readTheme(s.active_theme)) ?? (await readTheme("default"))!;
}
export async function listThemes(): Promise<string[]> {
  try {
    return (await fs.readdir(paths.themes)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

// ---------- identity ----------
export async function readIdentity(): Promise<{ identity: string; user: string; contacts: unknown }> {
  const rd = (f: string) => fs.readFile(path.join(paths.identity, f), "utf8").catch(() => "");
  return { identity: await rd("identity.md"), user: await rd("user.md"), contacts: (await readJson(path.join(paths.identity, "contacts.json"))) ?? [] };
}

// ---------- snapshot ----------
export async function snapshot(): Promise<StateSnapshot> {
  const ids = await listCanvasIds();
  const last = ids[ids.length - 1];
  const apps: Record<string, AppEntry> = {};
  for (const id of await listAppIds()) {
    const a = await readApp(id);
    if (a) apps[id] = a;
  }
  const tasks: TaskEntry[] = [];
  for (const id of await listTaskIds()) {
    const t = await readTask(id);
    if (t) tasks.push(t);
  }
  const { listTriggers } = await import("./triggers.ts");
  const triggers = (await listTriggers()).filter((t) => t.status === "active");
  return { canvas: last ? await readCanvas(last) : null, canvas_ids: ids, apps, screens: await readScreens(), tasks, theme: await activeTheme(), approvals: pendingApprovals(), triggers };
}

/** Ensure base folders exist; clear tmp on start. */
export async function initHome() {
  if (!exists(paths.screens)) {
    await fs.cp(env.TEMPLATE_HOME, H, { recursive: true });
  }
  for (const d of [paths.canvas, paths.apps, paths.trash, paths.tasks, paths.sessions, paths.themes, paths.identity, paths.uploads]) await fs.mkdir(d, { recursive: true });
  await fs.rm(paths.tmp, { recursive: true, force: true });
  await fs.mkdir(paths.tmp, { recursive: true });
}
