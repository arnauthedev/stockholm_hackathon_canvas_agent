import { z } from "zod";
import type { AppEntry, CanvasEntry, ScreensJson, TaskEntry, Theme, TriggerJson } from "./files.ts";

/** Server activity entry (dashboard). */
export interface ActivityEntry {
  id: number;
  at: string;
  kind: "tool" | "job" | "voice" | "text" | "task" | "system";
  title: string;
  detail?: string;
  ok: boolean;
  ms?: number;
  actor?: string;
}

/** runner → phone */
export type ServerEvent =
  | { type: "hello"; at: string }
  | { type: "reset" }
  | { type: "triggers"; triggers: TriggerJson[] }
  | { type: "speak"; text: string }
  | { type: "activity"; entry: ActivityEntry }
  | { type: "alert"; app_id: string; rule_id: string; title: string; message: string }
  | { type: "canvas"; canvas: CanvasEntry }
  | { type: "canvas.removed"; id: string }
  | { type: "app"; app: AppEntry }
  | { type: "app.removed"; id: string }
  | { type: "screens"; screens: ScreensJson }
  | { type: "task"; task: TaskEntry }
  | { type: "task.removed"; id: string }
  | { type: "theme"; theme: Theme }
  | { type: "toast"; text: string; kind: "info" | "success" | "warn" | "error"; sound?: string }
  | { type: "sound"; name: string }
  | { type: "modal"; approval_id: string; card: Record<string, unknown> }
  | { type: "modal.close"; approval_id: string }
  | { type: "modal.update"; approval_id: string; card: Record<string, unknown> }
  | { type: "modal.commit"; approval_id: string; until: string }
  | { type: "modal.commit_cancel"; approval_id: string }
  | { type: "modal.focus"; approval_id: string }
  | { type: "open_link"; href: string; kind: string }
  | { type: "transcript"; role: "user" | "agent"; text: string; final: boolean; session_id?: string }
  | { type: "busy"; on: boolean; label?: string };

/** phone → runner */
export const UiEvent = z.object({
  type: z.literal("ui.event"),
  canvas_id: z.string().optional(),
  app_id: z.string().optional(),
  approval_id: z.string().optional(),
  component_id: z.string(),
  event: z.string(),
  payload: z.unknown().optional(),
  at: z.string(),
});
export type UiEvent = z.infer<typeof UiEvent>;

export const Presence = z.object({ type: z.literal("presence"), visible: z.boolean() });
/** A tap that changes widget state (applied optimistically on the phone, confirmed by the runner). */
export const UiAction = z.object({
  type: z.literal("ui.action"),
  canvas_id: z.string().optional(),
  app_id: z.string().optional(),
  component_id: z.string(),
  action: z.string(),
  args: z.record(z.string(), z.unknown()).optional(),
  action_id: z.string(),
});
export type UiAction = z.infer<typeof UiAction>;
export const ClientEvent = z.discriminatedUnion("type", [UiEvent, z.object({ type: z.literal("ping") }), Presence, UiAction]);
export type ClientEvent = z.infer<typeof ClientEvent>;
