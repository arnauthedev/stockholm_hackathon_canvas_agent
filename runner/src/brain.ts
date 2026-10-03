import { randomBytes } from "node:crypto";
import { generateText, stepCountIs, type ModelMessage, type UserContent } from "ai";
import { TOOL_NAMES, type UiEvent } from "@canvas-agent/contract";
import { bus } from "./bus.ts";
import { hub } from "./events.ts";
import { lock } from "./fsutil.ts";
import { contractTools, helperTools, modelFor, webSearch } from "./llm.ts";
import { executeTool } from "./executor.ts";
import { brainInstructions } from "./prompts.ts";
import { logSession } from "./sessions.ts";
import { Activity } from "./activity.ts";
import { record } from "./monitor.ts";

/**
 * Session registry: async results and UI events are injected into the most
 * recently active session (a live voice session wins over text).
 */
export interface InjectTarget { kind: "voice" | "text"; id: string; inject(text: string): void }
const targets: InjectTarget[] = [];
export function registerTarget(t: InjectTarget) {
  targets.push(t);
  return () => {
    const i = targets.indexOf(t);
    if (i >= 0) targets.splice(i, 1);
  };
}
function activeTarget(prefer?: string): InjectTarget | undefined {
  return targets.find((t) => t.id === prefer) ?? [...targets].reverse().find((t) => t.kind === "voice") ?? targets[targets.length - 1];
}
export const hasLiveVoice = () => targets.some((t) => t.kind === "voice");
export const listTextSessions = () => targets.filter((t) => t.kind === "text").map((t) => t.id);

export function injectActive(text: string, prefer?: string) {
  const t = activeTarget(prefer);
  if (t) t.inject(text);
  else console.log("[brain] no active session for:", text);
}

// UI events worth telling the brain about (card swipes are logged, not injected)
const NOTABLE = /^(approval\.|form\.submit|list\.tap|stack\.empty|task\.tap)/;

hub.on("async", (r: { text: string; session_id?: string }) => injectActive(r.text, r.session_id));
hub.on("ui", (e: UiEvent) => {
  const t = activeTarget();
  if (t) void logSession(t.id, { ...e, type: "ui.event" });
  if (NOTABLE.test(e.event)) injectActive(`UI event on ${e.canvas_id ? `canvas ${e.canvas_id}` : `app ${e.app_id}`}: ${e.component_id} ${e.event} ${JSON.stringify(e.payload ?? {})}`);
});

// ---------------- text brain (/api/chat) ----------------
const histories = new Map<string, ModelMessage[]>();
let epoch = 0; // bumped on reset: turns started before a reset don't publish their results
const MAX_HISTORY = 40;

/** The last MAX_HISTORY messages, but never cut between a tool call and its result: start at a user turn. */
function recent(history: ModelMessage[]): ModelMessage[] {
  if (history.length <= MAX_HISTORY) return history;
  const cut = history.length - MAX_HISTORY;
  const userTurns = history.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
  const start = userTurns.find((i) => i >= cut) ?? userTurns.filter((i) => i < cut).pop() ?? 0;
  return history.slice(start);
}

export async function textTurn(session_id: string, content: UserContent, opts: { display?: string; notice?: boolean; job?: "brain" | "vision" } = {}): Promise<string> {
  return lock(`brain:${session_id}`, async () => {
    const history = histories.get(session_id) ?? [];
    histories.set(session_id, history);
    if (!opts.notice) bus.emit({ type: "transcript", role: "user", text: opts.display ?? (typeof content === "string" ? content : "📷"), final: true, session_id });
    await logSession(session_id, { type: opts.notice ? "notice" : "user", text: opts.display ?? content });
    history.push({ role: "user", content });
    bus.emit({ type: "busy", on: true, label: "Thinking…" });
    const turnStart = Date.now();
    const myEpoch = epoch;
    // notices (task completions etc.) aren't user requests → not tracked as tasks
    const activity = opts.notice ? null : new Activity(opts.display ?? (typeof content === "string" ? content : "Request"));
    try {
      const { model, route } = modelFor(opts.job ?? "brain");
      const result = await generateText({
        model,
        instructions: await brainInstructions(),
        messages: recent(history),
        tools: {
          ...contractTools(TOOL_NAMES, { session_id, actor: "text" }, (name, args, out) => {
            void logSession(session_id, { type: "tool", name, args, out });
            void activity?.tool(name, args, out);
          }),
          ...helperTools((n, a) => executeTool(n, a, { session_id, actor: "text" })),
          ...webSearch(),
        },
        stopWhen: stepCountIs(12),
        reasoning: (route.reasoning as "none" | "minimal" | "low" | "medium" | "high" | undefined) ?? "low",
      });
      if (myEpoch !== epoch) return ""; // a reset happened while this turn was running
      history.push(...result.response.messages);
      // keep images out of later turns' context: replace them with a short placeholder
      for (const m of history) {
        if (m.role === "user" && Array.isArray(m.content)) {
          m.content = m.content.map((p) => (p.type === "image" ? { type: "text" as const, text: "[photo shown earlier]" } : p));
        }
      }
      if (history.length > MAX_HISTORY * 2) history.splice(0, history.length - recent(history).length);
      const text = cleanReply(result.text);
      if (text) bus.emit({ type: "transcript", role: "agent", text, final: true, session_id });
      await logSession(session_id, { type: "agent", text });
      await activity?.finish(text);
      record({ kind: "text", title: opts.notice ? "notice turn" : "text turn", detail: text.slice(0, 160), ok: true, ms: Date.now() - turnStart, actor: session_id });
      return text;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[brain] error", msg);
      bus.emit({ type: "toast", text: `Brain error: ${msg.slice(0, 140)}`, kind: "error" });
      history.pop();
      record({ kind: "text", title: "text turn failed", detail: msg.slice(0, 160), ok: false, ms: Date.now() - turnStart, actor: session_id });
      await activity?.fail(msg.slice(0, 200));
      return "";
    } finally {
      bus.emit({ type: "busy", on: false });
    }
  });
}

/** Reset: forget text conversations (their logs are in the backup). */
export function clearTextSessions() {
  epoch++;
  histories.clear();
  for (const t of [...targets]) if (t.kind === "text") targets.splice(targets.indexOf(t), 1);
}

/** Strip web-search citation markers (U+E200…U+E201) and markdown links/emphasis from spoken/short replies. */
function cleanReply(t: string): string {
  return t
    .replace(/\uE200[^\uE201]*\uE201/g, "")
    .replace(/\(?\[([^\]]+)\]\([^)]+\)\)?/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\s+([.,;!?])/g, "$1")
    .trim();
}

export function textSession(id?: string): string {
  const sid = id && /^[\w-]{4,64}$/.test(id) ? id : `text-${new Date().toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
  if (!targets.some((t) => t.id === sid)) {
    registerTarget({
      kind: "text",
      id: sid,
      inject: (text) => void textTurn(sid, `(system notice, not from the user) ${text}`, { notice: true, display: text }),
    });
  }
  return sid;
}
