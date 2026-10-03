import type { ActivityEntry } from "@canvas-agent/contract";
import { bus } from "./bus.ts";

/** Server activity for the dashboard: an in-memory ring buffer + a live bus event per entry. */
const MAX = 300;
const entries: ActivityEntry[] = [];
let seq = 0;
export const startedAt = new Date().toISOString();

export function record(e: Omit<ActivityEntry, "id" | "at">) {
  const entry: ActivityEntry = { id: ++seq, at: new Date().toISOString(), ...e };
  entries.push(entry);
  if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  bus.emit({ type: "activity", entry });
}

export const recentActivity = () => [...entries];

/** One-line description of a tool result for the activity stream (no full payloads). */
export function brief(out: unknown): string {
  const o = (out ?? {}) as Record<string, unknown>;
  if (o.error) return String(o.error).slice(0, 140);
  const keys = ["canvas_id", "app_id", "active_theme", "status", "target", "first_run", "place", "href"].filter((k) => o[k] != null);
  return keys.map((k) => `${k}=${String(o[k]).slice(0, 60)}`).join(" ") || "ok";
}
