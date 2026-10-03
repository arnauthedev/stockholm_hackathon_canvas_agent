import path from "node:path";
import { GRID_COLS, GRID_ROWS, WIDGET_SIZES, type AppJson, type CanvasSpec, type Layout, type ScreensJson, type WidgetSize } from "@canvas-agent/contract";
import { readJson, writeJson } from "./fsutil.ts";
import { listAppIds, paths, readScreens, writeScreens } from "./store.ts";

/**
 * Home-screen layout: each screen is a GRID_COLS × GRID_ROWS grid; widgets take a named size
 * (S 2×2, W 4×2, L 4×4, T 2×4) at a cell position. Placement is first-fit, row by row; a new
 * screen is added when nothing fits. Widgets the user placed by hand (locked) are never moved
 * by automatic placement. Callers hold lock("screens").
 */
type Placed = { id: string; screen: string; layout: Layout };

const appFile = (id: string) => path.join(paths.appDir(id), "app.json");

/** Default size from what the widget shows. */
export function defaultSize(spec: CanvasSpec): WidgetSize {
  const types = Object.values(spec.components).map((c) => c.type);
  const has = (t: string) => types.includes(t);
  if (has("CardStack") || has("List") || has("Form") || has("Checklist") || has("Notebook") || has("TaskList") || has("Custom")) return "L";
  if (has("Chart")) return "W";
  if (has("KeyValue")) {
    const kv = Object.values(spec.components).find((c) => c.type === "KeyValue");
    const items = (kv?.props?.items as unknown[] | undefined)?.length ?? 0;
    return items > 4 ? "T" : "W";
  }
  if (has("Image")) return "L";
  return "S";
}

async function placedApps(): Promise<Placed[]> {
  const out: Placed[] = [];
  for (const id of await listAppIds()) {
    const a = await readJson<AppJson>(appFile(id));
    if (a?.layout) out.push({ id, screen: a.screen, layout: a.layout });
  }
  return out;
}

function occupied(apps: Placed[], screen: string, ignore?: string) {
  const grid: boolean[][] = Array.from({ length: GRID_ROWS }, () => Array(GRID_COLS).fill(false));
  for (const a of apps) {
    if (a.screen !== screen || a.id === ignore) continue;
    for (let y = a.layout.y; y < Math.min(GRID_ROWS, a.layout.y + a.layout.h); y++)
      for (let x = a.layout.x; x < Math.min(GRID_COLS, a.layout.x + a.layout.w); x++) grid[y]![x] = true;
  }
  return grid;
}

export function fits(grid: boolean[][], x: number, y: number, w: number, h: number) {
  if (x < 0 || y < 0 || x + w > GRID_COLS || y + h > GRID_ROWS) return false;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (grid[yy]![xx]) return false;
  return true;
}

function firstFit(grid: boolean[][], w: number, h: number): { x: number; y: number } | null {
  for (let y = 0; y + h <= GRID_ROWS; y++) for (let x = 0; x + w <= GRID_COLS; x++) if (fits(grid, x, y, w, h)) return { x, y };
  return null;
}

async function writeLayout(id: string, screen: string, layout: Layout) {
  const a = await readJson<AppJson>(appFile(id));
  if (a) await writeJson(appFile(id), { ...a, screen, layout, slot: undefined });
}

/** Find room for a widget of `size` (preferring `preferScreen`), creating a screen if needed. */
async function findRoom(screens: ScreensJson, apps: Placed[], size: WidgetSize, ignore?: string, preferScreen?: string) {
  const { w, h } = WIDGET_SIZES[size];
  const order = [...screens.screens.map((s) => s.id)];
  if (preferScreen && order.includes(preferScreen)) order.sort((a, b) => (a === preferScreen ? -1 : b === preferScreen ? 1 : 0));
  for (const sid of order) {
    const spot = firstFit(occupied(apps, sid, ignore), w, h);
    if (spot) return { screen: sid, ...spot };
  }
  const id = `s${Math.max(0, ...screens.screens.map((s) => Number(s.id.replace(/\D/g, "")) || 0)) + 1}`;
  screens.screens.push({ id });
  return { screen: id, x: 0, y: 0 };
}

/** Place a newly pinned widget. */
export async function placeNew(id: string, size: WidgetSize): Promise<{ screen: string; layout: Layout }> {
  const screens = await readScreens();
  const room = await findRoom(screens, await placedApps(), size);
  const layout: Layout = { x: room.x, y: room.y, ...WIDGET_SIZES[size], size };
  delete (layout as { label?: string }).label;
  await writeLayout(id, room.screen, layout);
  await writeScreens(screens);
  return { screen: room.screen, layout };
}

/** Change size: keep the position if it fits, else the first spot on the same screen, else elsewhere. */
export async function resize(id: string, size: WidgetSize): Promise<{ screen: string; layout: Layout; moved: boolean } | { error: string }> {
  const screens = await readScreens();
  const apps = await placedApps();
  const me = apps.find((a) => a.id === id);
  if (!me) return { error: `unknown widget "${id}"` };
  const { w, h } = WIDGET_SIZES[size];
  let screen = me.screen;
  let pos: { x: number; y: number } | null = fits(occupied(apps, screen, id), me.layout.x, me.layout.y, w, h) ? { x: me.layout.x, y: me.layout.y } : null;
  pos ??= firstFit(occupied(apps, screen, id), w, h);
  if (!pos) {
    const room = await findRoom(screens, apps, size, id);
    screen = room.screen;
    pos = { x: room.x, y: room.y };
  }
  // keep "locked" (user-placed) — the user asked for this size
  const layout: Layout = { x: pos.x, y: pos.y, w, h, size, ...(me.layout.locked ? { locked: true } : {}) };
  await writeLayout(id, screen, layout);
  await writeScreens(screens);
  await pruneScreens();
  return { screen, layout, moved: screen !== me.screen || pos.x !== me.layout.x || pos.y !== me.layout.y };
}

/** Manual move/resize from edit mode: must fit exactly where dropped; marks the widget locked. */
export async function moveTo(id: string, screen: string, x: number, y: number, size?: WidgetSize): Promise<{ ok: true; layout: Layout } | { error: string }> {
  const screens = await readScreens();
  if (!screens.screens.some((s) => s.id === screen)) return { error: "unknown screen" };
  const apps = await placedApps();
  const me = apps.find((a) => a.id === id);
  if (!me) return { error: `unknown widget "${id}"` };
  const sz = size ?? me.layout.size;
  const { w, h } = WIDGET_SIZES[sz];
  if (!fits(occupied(apps, screen, id), x, y, w, h)) return { error: "doesn't fit there" };
  const layout: Layout = { x, y, w, h, size: sz, locked: true };
  await writeLayout(id, screen, layout);
  await pruneScreens();
  return { ok: true, layout };
}

/** Drop trailing empty screens (keep at least one). */
export async function pruneScreens() {
  const screens = await readScreens();
  const apps = await placedApps();
  const used = new Set(apps.map((a) => a.screen));
  let changed = false;
  while (screens.screens.length > 1 && !used.has(screens.screens[screens.screens.length - 1]!.id)) {
    screens.screens.pop();
    changed = true;
  }
  if (changed) await writeScreens(screens);
}

/** One-time migration: legacy 2×2 slots → grid layouts (slot n → a Small widget at column (n%2)*2, row ⌊n/2⌋*2). */
export async function migrateLayouts() {
  let n = 0;
  for (const id of await listAppIds()) {
    const a = await readJson<AppJson>(appFile(id));
    if (!a || a.layout) continue;
    const slot = a.slot ?? 0;
    await writeJson(appFile(id), { ...a, layout: { x: (slot % 2) * 2, y: Math.floor(slot / 2) * 2, w: 2, h: 2, size: "S" }, slot: undefined });
    n++;
  }
  const screens = await readScreens();
  if (screens.screens.some((s) => s.slots)) await writeScreens({ ...screens, screens: screens.screens.map((s) => ({ id: s.id, ...(s.title ? { title: s.title } : {}) })) });
  if (n) console.log(`[layout] migrated ${n} widget(s) to the grid layout`);
}
