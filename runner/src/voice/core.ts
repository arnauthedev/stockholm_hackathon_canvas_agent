import { ToolMeta, type ToolCall, type Transcript, type VoiceSession } from "@canvas-agent/contract";
import { generateText } from "ai";
import { registerTarget } from "../brain.ts";
import { bus } from "../bus.ts";
import { executeTool } from "../executor.ts";
import { logSession } from "../sessions.ts";
import { modelFor } from "../llm.ts";
import { Activity } from "../activity.ts";
import { record } from "../monitor.ts";

/**
 * Provider-independent half of a voice session (B9): transcript grouping, the notice queue,
 * tool execution with screen facts, the coverage check and the session registry.
 * A provider (GPT-Live in live.ts, Gemini Live in gemini.ts) only implements how text and
 * tool results reach its model.
 */

/** Voice timing (ms), tuned on a phone over the quick tunnel. One place to change; see fixes.md. */
export const T = {
  transcriptFlush: 1500, // silence that ends a transcript line (neither provider sends "final" events)
  checkEvery: 2000, // coverage-check loop
  checkAfterSpeech: 4000, // let a request be delegated normally before auditing it
  delegationTimeout: 20_000, // a delegation that never reports back doesn't block the check forever
  quietBeforeCheck: 2000, // nobody spoke for this long (a spoken answer counts as handling)
  settleAfterIdle: 6000, // backend just finished: let the agent speak its answer first
  speakingNow: 1500, // user input this recent → a notice goes in silently, not spoken
  noticeLoop: 500,
  noticeQuietUser: 1500, // both quiet before a notice is spoken…
  noticeQuietAgent: 1200,
  noticeMerge: 1200, // …and close-together notices merge into one
  closeGrace: 3000, // wait for the provider's close event before dropping the socket
};

const sessions = new Map<string, VoiceCore>();
export const getVoiceSession = (id: string) => sessions.get(id);
export const listVoiceSessions = () => [...sessions.values()].map((s) => ({ id: s.id, provider: s.provider, started_at: s.startedAt }));
export const closeAllVoiceSessions = () => Promise.all([...sessions.values()].map((s) => s.close()));

export abstract class VoiceCore implements VoiceSession {
  private transcriptCbs: ((t: Transcript) => void)[] = [];
  private toolCbs: ((c: ToolCall) => void)[] = [];
  private toolQueue: Promise<void> = Promise.resolve();
  private unregister: (() => void) | null = null;
  // transcript grouping (no final/done transcript events from either provider)
  private cur: { role: "user" | "agent"; text: string } | null = null;
  private flushTimer: NodeJS.Timeout | undefined;
  protected closed = false;
  // the request currently being worked on (auto-tracked as a task once it has a visible effect)
  protected activity: Activity | null = null;
  protected lastUser = "";
  // safety net against dropped requests: user speech after the last delegation that never got delegated
  protected lastDelegationAt = 0;
  // notices (task finished, approval waiting…) wait for a natural pause and are grouped
  protected lastInputAt = 0;
  protected lastOutputAt = 0;
  private notices: { text: string; at: number }[] = [];
  private noticeLoop: NodeJS.Timeout | undefined;
  // coverage check: what was said vs. what actually ran
  protected history: { kind: "user" | "agent" | "tool"; text: string; at: number }[] = [];
  private lastCheckAt = Date.now();
  private checkTimer: NodeJS.Timeout | undefined;
  protected lastIdleAt = 0;
  private checking = false;

  readonly startedAt = new Date().toISOString();
  constructor(
    readonly id: string,
    readonly provider: string,
  ) {
    sessions.set(id, this);
  }

  abstract connect(opts: Parameters<VoiceSession["connect"]>[0]): Promise<void>;
  /** Return a tool's output; `fact` is ground truth for the voice model about what the user can actually see. */
  abstract sendToolResult(id: string, result: unknown, fact?: string | null): void;
  abstract interrupt(): void;
  abstract close(): Promise<void>;
  /** Context the model should know but not react to right now (a fact, a note). */
  protected abstract sendSilent(text: string): void;
  /** A notice the model should mention at this natural pause. */
  protected abstract sendSpoken(text: string): void;
  /** A request the coverage check found unhandled: whoever runs tools must act on it now. */
  protected abstract sendRecovery(request: string): void;
  /** True while the model (or its backend) is still working on a request. */
  protected abstract working(): boolean;

  /** Common wiring once the provider connection is up. */
  protected attach(models: Record<string, unknown>) {
    this.unregister = registerTarget({ kind: "voice", id: this.id, inject: (t) => this.inject(t) });
    // Screen tools run one at a time in the order asked: a render and the make_live/pin after it in the
    // same batch must see the new canvas (in parallel, make_live without a target hit the previous one).
    // They take milliseconds; everything else (lookups, code, tasks) still runs at once, so nothing waits on them.
    this.onToolCall((c) => {
      if (!ORDERED_TOOLS.has(c.name)) return void this.runTool(c);
      this.toolQueue = this.toolQueue.then(() => this.runTool(c)).catch(() => {});
    });
    this.onTranscript((t) => {
      bus.emit({ type: "transcript", role: t.role, text: t.text, final: t.final, session_id: this.id });
      if (t.final) void logSession(this.id, { type: t.role, text: t.text });
    });
    void logSession(this.id, { type: "session.start", provider: this.provider, ...models });
  }

  protected emitToolCall(c: ToolCall) {
    for (const cb of this.toolCbs) cb(c);
  }

  private async runTool(c: ToolCall) {
    bus.emit({ type: "busy", on: true, label: labelFor(c.name) });
    // listed before it runs (a check mid-flight must see it), then marked with the outcome
    const entry = { kind: "tool" as const, text: actionSummary(c.name, c.args), at: Date.now() };
    this.history.push(entry);
    const out = await executeTool(c.name, c.args, { session_id: this.id, actor: "voice" });
    const err = (out as { error?: unknown } | null)?.error;
    entry.text = err ? `${entry.text} → FAILED (${String(err).slice(0, 80)})` : `${entry.text} → ok`;
    void logSession(this.id, { type: "tool", name: c.name, args: c.args, out });
    void this.activity?.tool(c.name, c.args, out);
    this.sendToolResult(c.id, out, screenFact(c.name, c.args, out));
  }

  protected transcript(role: "user" | "agent", delta: string) {
    if (!delta) return;
    if (this.cur && this.cur.role !== role) this.flush();
    this.cur = this.cur ? { role, text: this.cur.text + delta } : { role, text: delta };
    for (const cb of this.transcriptCbs) cb({ role, text: this.cur.text.trim(), final: false });
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.cur && this.flushWhenHeard(this.cur.role), T.transcriptFlush);
  }

  /** End `role`'s line once the user has actually heard it (see speakingUntil); the user's line ends now. */
  protected flushWhenHeard(role: "user" | "agent") {
    const wait = this.speakingUntil() - Date.now();
    clearTimeout(this.flushTimer);
    if (role === "agent" && wait > 0) this.flushTimer = setTimeout(() => this.flush(role), wait);
    else this.flush(role);
  }

  /** Until when the phone is still playing the agent (a provider whose audio arrives ahead of playback overrides this). */
  protected speakingUntil() {
    return 0;
  }

  /** End the current transcript line now (optionally only if it belongs to `role`). */
  protected flush(role?: "user" | "agent") {
    if (role && this.cur?.role !== role) return;
    clearTimeout(this.flushTimer);
    if (!this.cur) return;
    const t = this.cur;
    this.cur = null;
    if (t.role === "user") this.lastUser = t.text.trim();
    if (t.text.trim()) {
      this.history.push({ kind: t.role, text: t.text.trim().slice(0, 400), at: Date.now() });
      if (this.history.length > 80) this.history.splice(0, this.history.length - 80);
      if (t.role === "user") this.scheduleCheck();
    }
    if (t.text.trim()) for (const cb of this.transcriptCbs) cb({ role: t.role, text: t.text.trim(), final: true });
  }

  /** What the user is saying right now, or the last thing they said. */
  protected currentUserText() {
    return this.cur?.role === "user" ? this.cur.text : this.lastUser;
  }

  /**
   * Coverage check (safety net for dropped requests). When the model is idle and the user said
   * something new, a cheap model compares what was said with the actions that actually ran. A request
   * nobody acted on is handed back (sendRecovery). No phrase matching: the checker decides whether an
   * utterance was a request at all.
   */
  /** Ensure the check loop runs (every 2 s while there is user speech not yet checked). */
  protected scheduleCheck() {
    this.checkTimer ??= setInterval(() => void this.runCheck(), T.checkEvery);
  }

  private async runCheck() {
    if (this.closed || this.checking) return;
    const pendingSpeech = this.history.some((h) => h.kind === "user" && h.at > this.lastCheckAt);
    if (!pendingSpeech) {
      clearInterval(this.checkTimer); // nothing new to check: stop the loop until the user speaks again
      this.checkTimer = undefined;
      return;
    }
    // wait 4 s after the user's last words, so a request can be delegated normally first
    if (Date.now() - Math.max(...this.history.filter((h) => h.kind === "user").map((h) => h.at)) < T.checkAfterSpeech) return;
    // only when the conversation is quiet: model idle, nobody spoke in the last 2 s (a spoken answer counts as handling)
    if (this.working() || Date.now() - this.lastInputAt < T.quietBeforeCheck || Date.now() - this.lastOutputAt < T.quietBeforeCheck) return; // next tick
    if (Date.now() - this.lastIdleAt < T.settleAfterIdle) return; // just finished: let the agent speak its answer first
    const since = this.lastCheckAt;
    const window = this.history.filter((h) => h.at > since);
    if (!window.some((h) => h.kind === "user")) return;
    this.checking = true;
    const started = Date.now();
    try {
      const { model } = modelFor("subagent");
      const r = await generateText({
        model,
        instructions:
          "You audit a voice assistant. Given the latest conversation and the backend actions that actually ran, find any REQUEST from the user that no action addressed. " +
          "Requests that need a backend action (showing something, making a list/checklist, a route, scheduling, calling, emailing, pinning, fetching data, operating a widget such as marking a card/item done, checking or adding list items…) are handled ONLY if a matching 'Action ran' line exists and did not FAIL — the assistant SAYING it did or will do it does not count (it may be mistaken). " +
          "When the assistant is walking the user through a list and the user confirms a step (e.g. that an item is done), that item must be marked by a ui_action; otherwise report it (name the item). " +
          "Also handled (not missing): small talk and thanks; questions answerable in words that the assistant answered (e.g. the time, counting, explanations); requests the user later stopped, cancelled or changed; requests the assistant asked a clarifying question about. " +
          "Report the request that is missing (only one, the clearest). " +
          'Reply with JSON only: {"unaddressed": "<the missing request in the user\'s words, with any details>"} or {"unaddressed": null}.',
        prompt: window.map((h) => `${h.kind === "user" ? "User" : h.kind === "agent" ? "Assistant" : "Action ran"}: ${h.text}`).join("\n"),
        reasoning: "low",
      });
      // Plain text + JSON parse on purpose: with a strict output schema this model reported a handled
      // request as missing in 3–5 of 8 runs (measured 2026-10-03); as free text, 0 of 8. Unparseable → nothing missing.
      const missing = parseUnaddressed(r.text);
      this.lastCheckAt = started;
      record({ kind: "voice", title: "coverage check", detail: missing ? `missing: ${missing}` : `all handled (${window.filter((h) => h.kind === "user").length} utterances, ${window.filter((h) => h.kind === "tool").length} actions)`, ok: true, ms: Date.now() - started, actor: this.id });
      void logSession(this.id, { type: "coverage", missing: missing ?? null, window: window.map((h) => `${h.kind}: ${h.text.slice(0, 120)}`) });
      if (missing && missing.trim()) this.recover(missing.trim());
    } catch (e) {
      console.warn("[voice] coverage check failed", String(e).slice(0, 160));
    } finally {
      this.checking = false;
    }
  }

  /** Hand a missed request to whoever runs tools, and track it as a request. */
  private recover(request: string) {
    record({ kind: "voice", title: "recovered a dropped request", detail: request.slice(0, 160), ok: true, actor: this.id });
    void logSession(this.id, { type: "recover", text: request });
    this.activity = new Activity(request);
    this.sendRecovery(request);
  }

  onTranscript(cb: (t: Transcript) => void) {
    this.transcriptCbs.push(cb);
  }
  onToolCall(cb: (c: ToolCall) => void) {
    this.toolCbs.push(cb);
  }

  /**
   * Async results ("task X finished", "approval waiting"). Never interrupt the user: while they speak
   * the notice is only added silently; speakable notices go out at the next natural pause (both quiet),
   * grouped when several arrive close together.
   */
  inject(text: string) {
    void logSession(this.id, { type: "inject", text });
    if (Date.now() - this.lastInputAt < T.speakingNow) this.sendSilent(text.slice(0, 1800));
    this.notices.push({ text, at: Date.now() });
    this.noticeLoop ??= setInterval(() => this.flushNotices(), T.noticeLoop);
  }

  private flushNotices() {
    const nowMs = Date.now();
    if (!this.notices.length) {
      clearInterval(this.noticeLoop);
      this.noticeLoop = undefined;
      return;
    }
    const quiet = nowMs - this.lastInputAt > T.noticeQuietUser && nowMs - this.lastOutputAt > T.noticeQuietAgent;
    const settled = nowMs - this.notices[this.notices.length - 1]!.at > T.noticeMerge;
    if (!quiet || !settled || this.closed) return;
    const batch = this.notices.splice(0);
    const content =
      batch.length === 1
        ? batch[0]!.text
        : `Several updates — mention them briefly and grouped (e.g. "two things need your OK: …"):\n${batch.map((b) => `- ${b.text}`).join("\n")}`;
    this.sendSpoken(content.slice(0, 1800));
    record({ kind: "voice", title: batch.length > 1 ? `injected ${batch.length} grouped notices` : "injected into voice", detail: content.slice(0, 160), ok: true, actor: this.id });
  }

  /** The model finished a request: clear the busy state and audit coverage once it has spoken. */
  protected idle() {
    bus.emit({ type: "busy", on: false });
    void this.activity?.finish();
    this.activity = null;
    this.lastIdleAt = Date.now();
    this.scheduleCheck();
  }

  protected finish() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.noticeLoop);
    clearInterval(this.checkTimer);
    void this.activity?.finish();
    this.flush();
    this.unregister?.();
    sessions.delete(this.id);
    record({ kind: "voice", title: "voice session ended", ok: true, actor: this.id });
    bus.emit({ type: "busy", on: false });
  }
}

/** The checker's {"unaddressed": …} from its reply; anything unparseable counts as "nothing missing" (never recover on a guess). */
function parseUnaddressed(text: string): string | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const v = (JSON.parse(m[0]) as { unaddressed?: unknown }).unaddressed;
    return typeof v === "string" && v.trim() ? v : null;
  } catch {
    return null;
  }
}

/** What an action did, for the coverage check: task titles in full, other args briefly. */
/** Tools that read or change "the current canvas" (or widgets): order matters between them. */
const ORDERED_TOOLS = new Set(["render", "generate_image", "update_data", "make_live", "pin", "unpin", "resize_widget", "undo", "watch", "unwatch", "ui_action"]);

function actionSummary(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (name === "create_tasks" && Array.isArray(a.tasks)) return `create_tasks: ${(a.tasks as { title?: string }[]).map((t) => `"${t.title}"`).join(", ")}`;
  if (name === "render") return `render: "${String(a.title ?? (a.spec as { title?: string } | undefined)?.title ?? "")}"`;
  return `${name} ${JSON.stringify(a).slice(0, 240)}`;
}

function screenFact(name: string, args: unknown, out: unknown): string | null {
  const o = (out ?? {}) as Record<string, unknown>;
  const a = (args ?? {}) as Record<string, unknown>;
  if (o.error) return name === "render" || name === "pin" ? `Fact: ${name} FAILED (${String(o.error)}); nothing new is on the user's screen.` : null;
  if (name === "render") return `Fact: the canvas now shows "${String(a.title ?? (a.spec as { title?: string })?.title ?? "a new view")}"${o.live ? " (live)" : ""}.`;
  if (name === "pin") return `Fact: pinned as widget "${String(o.app_id)}" on screen ${String(o.screen)}${o.already_pinned ? " (it was already pinned)" : ""}.`;
  if (name === "unpin") return `Fact: widget "${String(a.app_id)}" removed.`;
  if (name === "notify") return `Fact: a toast saying "${String(a.text)}" was shown.`;
  if (name === "generate_image" && !o.error) return a.target ? `Fact: the picture in ${String(o.target)} ${a.revert ? "went back to the previous one" : "is being redrawn; it fades in within a few seconds"}.` : `Fact: an image card is on the screen; the picture fades in within a few seconds.`;
  if (name === "make_live") return `Fact: ${String(o.target)} is now live (${String(o.note ?? "updating")}). Only that canvas or widget updates itself.`;
  // data lookups draw nothing: the model sometimes said "it's on your screen" right after one
  if (name === "weather" || name === "fetch_json" || name === "run_python") return `Fact: this is data only; nothing new is on the user's screen until you render it.`;
  // widget contents: the voice model must speak from the real list, never invent items
  if (name === "read_widget" || name === "ui_action") {
    const ws = (name === "read_widget" ? (o.widgets as { type: string; state: unknown }[] | undefined) ?? [] : [{ type: "", state: o.state }]).filter((w) => w.state);
    if (!ws.length) return null;
    return `Fact: ${name === "ui_action" ? "after that action, " : ""}the widget now shows: ${ws.map((w) => JSON.stringify(w.state)).join(" ; ").slice(0, 700)}. Speak only from these items.`;
  }
  return null;
}

function labelFor(tool: string): string {
  return (ToolMeta as Record<string, { busy?: string } | undefined>)[tool]?.busy ?? "Working…";
}

const DEFAULT_VOICES: Record<string, string> = { openai: "marin", google: "Kore" };

/** The voice name for a provider from a route's `voice` field (a per-provider map, or one name). */
export function voiceNameFor(r: Record<string, unknown>, provider: string): string {
  if (typeof r.voice === "string") return r.voice;
  return String((r.voice as Record<string, string> | undefined)?.[provider] ?? DEFAULT_VOICES[provider] ?? "");
}

/** Tool output as the model receives it (capped; a huge result is truncated, not dropped). */
export function toolOutputText(result: unknown, max = 16_000): string {
  const s = JSON.stringify(result ?? {});
  return s.length > max ? s.slice(0, max) : s;
}
