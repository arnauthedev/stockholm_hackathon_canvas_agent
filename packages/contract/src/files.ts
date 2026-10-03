import { z } from "zod";
import { CanvasSpec } from "./canvas.ts";

export const SLOTS_PER_SCREEN = 4; // legacy 2×2 layout (migrated to grid layouts)
/** Home-screen grid: each screen is GRID_COLS × GRID_ROWS cells; widgets use named sizes. */
export const GRID_COLS = 4;
export const GRID_ROWS = 6;
export const WidgetSize = z.enum(["S", "W", "L", "T"]);
export type WidgetSize = z.infer<typeof WidgetSize>;
export const WIDGET_SIZES: Record<WidgetSize, { w: number; h: number; label: string }> = {
  S: { w: 2, h: 2, label: "Small" },
  W: { w: 4, h: 2, label: "Wide" },
  L: { w: 4, h: 4, label: "Large" },
  T: { w: 2, h: 4, label: "Tall" },
};
export const Layout = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  w: z.number().int().min(1),
  h: z.number().int().min(1),
  size: WidgetSize,
  /** set when the user moved/resized it by hand: automatic reflow never moves it */
  locked: z.boolean().optional(),
});
export type Layout = z.infer<typeof Layout>;
export const CANVAS_RING_SIZE = 10;

export const Source = z.discriminatedUnion("type", [
  z.object({ type: z.literal("python"), code: z.string(), refresh_s: z.number().int().min(30).max(86400) }),
  z.object({ type: z.literal("http"), url: z.string().url(), refresh_s: z.number().int().min(5).max(86400), json_path: z.string().optional() }),
  /** Real-time push over WebSocket: Binance preset (crypto, public, no key) or any WebSocket URL + field map. */
  z.object({
    type: z.literal("stream"),
    provider: z.enum(["binance"]).optional().describe("binance: symbol like BTCUSDT; fields price, change_pct, change, trend, high, low, symbol, currency"),
    symbol: z.string().optional(),
    url: z.string().optional().describe("generic WebSocket URL (when not using a provider)"),
    subscribe: z.unknown().optional().describe("message sent after connecting (generic)"),
    map: z.record(z.string(), z.string()).optional().describe("data field → JSON pointer into each message (generic)"),
  }),
]);
export type Source = z.infer<typeof Source>;

/** Stored form of a source (code lives in fetch.py next to it). */
export const SourceRef = z.object({
  type: z.enum(["python", "http", "stream"]),
  entry: z.string(),
  refresh_s: z.number().int(),
  json_path: z.string().optional(),
  stream: z.object({ provider: z.enum(["binance"]).optional(), symbol: z.string().optional(), url: z.string().optional(), subscribe: z.unknown().optional(), map: z.record(z.string(), z.string()).optional() }).optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const CanvasMeta = z.object({
  schema_version: z.literal(1).default(1),
  created_at: z.string(),
  prompt: z.string().optional(),
  session_id: z.string().optional(),
  title: z.string().optional(),
  theme: z.string().optional(),
  source: SourceRef.optional(),
  undo_of: z.string().optional(),
  task_id: z.string().optional(),
});
export type CanvasMeta = z.infer<typeof CanvasMeta>;

export const AppJson = z.object({
  schema_version: z.literal(1).default(1),
  id: z.string(),
  title: z.string(),
  screen: z.string(),
  slot: z.number().int().optional(), // legacy
  layout: Layout.optional(),
  pinned_at: z.string(),
  refresh_s: z.number().int().nullable(),
  source: SourceRef.optional(),
  from_canvas: z.string().optional(),
});
export type AppJson = z.infer<typeof AppJson>;

export const JobJson = z.object({
  last_run: z.string().nullable(),
  last_ok: z.string().nullable(),
  last_error: z.string().nullable(),
  runs: z.number().int(),
});
export type JobJson = z.infer<typeof JobJson>;

export const Screen = z.object({ id: z.string(), title: z.string().optional(), slots: z.array(z.string().nullable()).optional() /* legacy */ });
export const ScreensJson = z.object({
  schema_version: z.literal(1).default(1),
  active_theme: z.string(),
  screens: z.array(Screen),
});
export type ScreensJson = z.infer<typeof ScreensJson>;

export const TaskStatus = z.enum(["pending", "running", "waiting_user", "done", "failed", "cancelled"]);
export type TaskStatus = z.infer<typeof TaskStatus>;
export const TaskKind = z.enum(["handoff", "approval", "background", "helper", "answer"]);
export type TaskKind = z.infer<typeof TaskKind>;
/** Stored kinds: the brain's TaskKinds plus "request" (a foreground request tracked automatically by the runner). */
export const TaskRecordKind = z.enum([...TaskKind.options, "request"]);
export type TaskRecordKind = z.infer<typeof TaskRecordKind>;

export const TaskJson = z.object({
  schema_version: z.literal(1).default(1),
  id: z.string(),
  title: z.string(),
  status: TaskStatus,
  kind: TaskRecordKind,
  details: z.string().optional(),
  depends_on: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
  summary: z.string().optional(),
});
export type TaskJson = z.infer<typeof TaskJson>;

export const TaskResult = z.object({
  canvas_id: z.string().optional(),
  link: z.object({ href: z.string(), label: z.string().optional(), kind: z.string().optional() }).optional(),
  card: z.record(z.string(), z.unknown()).optional(),
  approval_id: z.string().optional(),
  /** runner-run action (call/email) to resume after a restart */
  action: z.record(z.string(), z.unknown()).optional(),
  text: z.string().optional(),
});
export type TaskResult = z.infer<typeof TaskResult>;

export const ThemeColors = z.object({
  bg: z.string(), surface: z.string(), surface2: z.string(), text: z.string(), muted: z.string(),
  accent: z.string(), accentText: z.string(), border: z.string(),
  success: z.string(), warn: z.string(), danger: z.string(),
  chart: z.array(z.string()),
});
export const Theme = z.object({
  schema_version: z.literal(1).default(1),
  name: z.string(),
  colors: ThemeColors,
  dark: ThemeColors.partial().optional(),
  radius: z.number(),
  font: z.string(),
  spacing: z.number(),
});
export type Theme = z.infer<typeof Theme>;

export interface CanvasEntry { id: string; spec: CanvasSpec; data: unknown; meta: CanvasMeta }
/** apps/<slug>/watch.json — declarative conditions evaluated after each refresh. */
export const WatchOp = z.enum(["<", "<=", ">", ">=", "==", "!=", "changed"]);
export const WatchRule = z.object({
  id: z.string(),
  path: z.string().describe("JSON pointer into data.json, e.g. /price"),
  op: WatchOp,
  value: z.union([z.number(), z.string(), z.boolean()]).optional(),
  message: z.string(),
  mode: z.enum(["cross", "once"]).default("cross"),
  cooldown_s: z.number().int().min(0).default(0),
  /** false: no notification, only the task (a silent automatic change) */
  notify: z.boolean().default(true),
  /** a background task started each time the condition becomes true ({value} in details → the value) */
  task: z.object({ title: z.string(), details: z.string(), kind: TaskKind.optional() }).optional(),
  created_at: z.string(),
});
export type WatchRule = z.infer<typeof WatchRule>;
export const WatchFile = z.object({ schema_version: z.literal(1).default(1), rules: z.array(WatchRule) });

export interface AppEntry { id: string; app: AppJson; spec: CanvasSpec; data: unknown; job?: JobJson; watches?: { rules: number; active: string[] } }
export interface TaskEntry { task: TaskJson; result?: TaskResult }

export interface StateSnapshot {
  canvas: CanvasEntry | null;
  canvas_ids: string[];
  apps: Record<string, AppEntry>;
  screens: ScreensJson;
  tasks: TaskEntry[];
  theme: Theme;
  triggers?: TriggerJson[];
  /** approval cards still waiting for the user (shown again after reconnect) */
  approvals: { approval_id: string; card: Record<string, unknown> }[];
}

/** identity/contacts.json — private: only the runner reads numbers/addresses; models see names + channel flags. */
export const Contact = z.object({
  id: z.string().optional(),
  name: z.string(),
  aliases: z.array(z.string()).optional(),
  relation: z.string().optional(),
  phones: z.array(z.object({ label: z.string().optional(), number: z.string() })).optional(),
  emails: z.array(z.object({ label: z.string().optional(), address: z.string() })).optional(),
  notes: z.string().optional(),
  // legacy single-value fields (still accepted)
  phone: z.string().optional(),
  email: z.string().optional(),
});
export type Contact = z.infer<typeof Contact>;

/** agent-home/triggers/<id>.json — scheduled or event-driven actions (survive restarts). */
export const TriggerAction = z.object({
  type: z.enum(["notify", "speak", "task"]),
  text: z.string().optional().describe("notify/speak: what to say"),
  title: z.string().optional().describe("task: title"),
  kind: TaskKind.optional().describe("task: kind (default background)"),
  details: z.string().optional().describe("task: everything the sub-agent needs"),
});
export type TriggerAction = z.infer<typeof TriggerAction>;
export const TriggerJson = z.object({
  schema_version: z.literal(1).default(1),
  id: z.string(),
  label: z.string(),
  source: z.enum(["time", "email"]),
  /** time: one-shot at `at`, or recurring `cron` */
  at: z.string().optional(),
  cron: z.string().optional(),
  action: TriggerAction.optional(),
  /** email: which incoming emails get a drafted reply */
  email: z.object({ from: z.string().optional(), contains: z.string().optional(), any: z.boolean().optional(), instructions: z.string().optional() }).optional(),
  status: z.enum(["active", "done", "missed", "cancelled"]),
  created_at: z.string(),
  last_fired: z.string().optional(),
  fired: z.number().int().default(0),
});
export type TriggerJson = z.infer<typeof TriggerJson>;
