import { randomBytes } from "node:crypto";
import OpenAI from "openai";
import WebSocket from "ws";
import { helperDefs, toolDefs, ToolMeta, TOOL_NAMES, type StateSnapshot, type ToolCall, type ToolDef, type Transcript, type VoiceSession } from "@canvas-agent/contract";
import { route } from "../../../config/routes.ts";
import { registerTarget } from "../brain.ts";
import { bus } from "../bus.ts";
import { env } from "../env.ts";
import { executeTool } from "../executor.ts";
import { brainInstructions } from "../prompts.ts";
import { logSession } from "../sessions.ts";
import { voiceInstructions } from "./prompt.ts";
import { generateText } from "ai";
import { modelFor } from "../llm.ts";
import { Activity } from "../activity.ts";
import { record } from "../monitor.ts";

/**
 * GPT-Live, runner half (B9).
 * - The phone POSTs its SDP offer; the runner creates the session with the project key
 *   (GPT-Live has no ephemeral client secrets) and returns the SDP answer.
 * - The runner attaches the sideband WebSocket, owns all function calls (Responses
 *   delegation), returns outputs, and injects async results via session.commentary.append.
 * - The phone's data channel is restricted to lifecycle events (untrusted frontend).
 */
/** Voice timing (ms), tuned on a phone over the quick tunnel. One place to change; see fixes.md. */
const T = {
  transcriptFlush: 1500, // silence that ends a transcript line (Live sends no "final" events)
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
  closeGrace: 3000, // wait for session.close before dropping the socket
};

let _client: OpenAI | null = null;
const client = () => (_client ??= new OpenAI({ apiKey: env.OPENAI_API_KEY }));
const sessions = new Map<string, LiveSideband>();
export const listLiveSessions = () => [...sessions.values()].map((s) => ({ id: s.id, started_at: s.startedAt }));

/** Strip JSON-schema keys the Responses function tool format doesn't need. */
function fnTool(d: ToolDef) {
  const { $schema: _s, ...parameters } = d.parameters as Record<string, unknown>;
  return { type: "function" as const, name: d.name, description: d.description, parameters, strict: false };
}

/** web_search is rejected by the Live Responses backend at effort none/minimal → floor at "low". */
function voiceEffort(configured: unknown): "low" | "medium" | "high" {
  return configured === "medium" || configured === "high" ? configured : "low";
}

export async function createLiveSession(sdp: string): Promise<{ session_id: string; sdp: string }> {
  const voice = route("voice");
  const brain = route("brain");
  const [instructions, backend] = await Promise.all([voiceInstructions(), brainInstructions()]);
  const base = {
    model: voice.model,
    instructions,
    audio: { output: { voice: String(voice.voice ?? "marin") } },
    delegation: {
      type: "responses" as const,
      responses: {
        model: brain.model,
        instructions: backend,
        tools: [...toolDefs(TOOL_NAMES).map(fnTool), ...helperDefs().map(fnTool), { type: "web_search" as const }],
        tool_choice: "auto" as const,
        parallel_tool_calls: true,
        reasoning: { effort: voiceEffort(brain.voiceReasoning) },
      },
    },
  };
  const restricted = {
    ...base,
    client: {
      data_channel: {
        allowed_client_events: ["session.close", "session.input_audio.mute", "session.input_audio.unmute"],
        allowed_server_events: [{ type: "session.started" }, { type: "session.closed" }, { type: "error" }],
      },
    },
  };
  let res;
  try {
    res = await client().live.create({ session: restricted, transport: { type: "webrtc", sdp } });
  } catch (err) {
    // If the frontend restriction config is rejected, fall back to the plain session (functions still run only here).
    if (err instanceof OpenAI.APIError && err.status === 400 && /client|data_channel/i.test(err.message)) {
      console.warn("[voice] client restriction rejected, retrying without:", err.message);
      res = await client().live.create({ session: base, transport: { type: "webrtc", sdp } });
    } else throw err;
  }
  const session_id = res.session.id;
  const sb = new LiveSideband(session_id);
  sessions.set(session_id, sb);
  record({ kind: "voice", title: "voice session started", detail: `${voice.model} · backend ${brain.model}`, ok: true, actor: session_id });
  await sb.connect({ tools: [], instructions: "", context: {} as StateSnapshot });
  return { session_id, sdp: res.transport.sdp };
}

export const getLiveSession = (id: string) => sessions.get(id);
export const closeAllLiveSessions = () => Promise.all([...sessions.values()].map((s) => s.close()));

type Envelope = { type: string; [k: string]: unknown };

class LiveSideband implements VoiceSession {
  private ws: WebSocket | null = null;
  private transcriptCbs: ((t: Transcript) => void)[] = [];
  private toolCbs: ((c: ToolCall) => void)[] = [];
  private unregister: (() => void) | null = null;
  // response bookkeeping: send response.create once every output of a response is in
  private pendingOutputs = new Set<string>();
  private responseDone = false;
  private hadCalls = false;
  private seenCalls = new Set<string>();
  // transcript grouping (Live has no final/done transcript events)
  private cur: { role: "user" | "agent"; text: string } | null = null;
  private flushTimer: NodeJS.Timeout | undefined;
  private closed = false;
  // the request currently being worked on (auto-tracked as a task once it has a visible effect)
  private activity: Activity | null = null;
  private lastUser = "";
  // safety net against dropped requests: user speech after the last delegation that never got delegated
  private lastDelegationAt = 0;
  // notices (task finished, approval waiting…) wait for a natural pause and are grouped
  private lastInputAt = 0;
  private lastOutputAt = 0;
  private notices: { text: string; at: number }[] = [];
  private noticeLoop: NodeJS.Timeout | undefined;
  // coverage check: what was said vs. what actually ran
  private history: { kind: "user" | "agent" | "tool"; text: string; at: number }[] = [];
  private lastCheckAt = Date.now();
  private checkTimer: NodeJS.Timeout | undefined;
  private lastIdleAt = 0;
  private checking = false;

  readonly startedAt = new Date().toISOString();
  constructor(readonly id: string) {}

  async connect(_opts: Parameters<VoiceSession["connect"]>[0]) {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`wss://api.openai.com/v1/live/sessions/${encodeURIComponent(this.id)}/attach`, {
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      });
      this.ws = ws;
      ws.once("open", () => resolve());
      ws.once("error", (e) => reject(e));
      ws.on("message", (raw) => {
        try {
          this.onEvent(JSON.parse(String(raw)) as Envelope);
        } catch (e) {
          console.warn("[voice] bad event", e);
        }
      });
      ws.on("close", (code) => {
        console.log(`[voice] sideband ${this.id} closed (${code})`);
        this.finish();
      });
    });
    this.unregister = registerTarget({ kind: "voice", id: this.id, inject: (t) => this.inject(t) });
    this.onToolCall((c) => void this.runTool(c));
    this.onTranscript((t) => {
      bus.emit({ type: "transcript", role: t.role, text: t.text, final: t.final, session_id: this.id });
      if (t.final) void logSession(this.id, { type: t.role, text: t.text });
    });
    void logSession(this.id, { type: "session.start", model: route("voice").model, brain: route("brain").model });
    console.log(`[voice] sideband attached to ${this.id}`);
  }

  private send(e: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ event_id: `evt_${randomBytes(6).toString("hex")}`, ...e }));
  }

  private onEvent(e: Envelope) {
    switch (e.type) {
      case "session.input_transcript.delta":
        this.lastInputAt = Date.now();
        this.transcript("user", String(e.delta ?? ""));
        break;
      case "session.output_transcript.delta":
        this.lastOutputAt = Date.now();
        this.transcript("agent", String(e.delta ?? ""));
        break;
      case "session.delegation.created":
        this.lastDelegationAt = Date.now();
        record({ kind: "voice", title: "delegated to backend", detail: (this.cur?.role === "user" ? this.cur.text : this.lastUser).slice(0, 160), ok: true, actor: this.id });
        void this.activity?.finish();
        this.activity = new Activity(this.cur?.role === "user" ? this.cur.text : this.lastUser || "Voice request");
        this.responseDone = false;
        this.hadCalls = false;
        bus.emit({ type: "busy", on: true, label: "Working…" });
        break;
      case "response.event":
        this.onResponseEvent((e.event ?? {}) as Envelope);
        break;
      case "error":
        console.warn("[voice] error", JSON.stringify(e).slice(0, 500));
        bus.emit({ type: "toast", text: `Voice backend: ${String((e.error as { message?: string })?.message ?? "error").slice(0, 140)}`, kind: "error" });
        void logSession(this.id, { type: "error", error: e });
        break;
      case "session.closed":
        void logSession(this.id, { type: "session.closed", usage: e.usage });
        this.finish();
        break;
    }
  }

  private onResponseEvent(ev: Envelope) {
    if (ev.type === "response.output_item.done") {
      const item = (ev.item ?? {}) as { type?: string; call_id?: string; name?: string; arguments?: string };
      if (item.type === "function_call" && item.call_id && item.name && !this.seenCalls.has(item.call_id)) {
        this.seenCalls.add(item.call_id);
        this.hadCalls = true;
        this.pendingOutputs.add(item.call_id);
        let args: unknown = {};
        try {
          args = JSON.parse(item.arguments || "{}");
        } catch {}
        for (const cb of this.toolCbs) cb({ id: item.call_id, name: item.name, args });
      }
    } else if (ev.type === "response.completed" || ev.type === "response.failed" || ev.type === "response.incomplete") {
      this.responseDone = true;
      if (ev.type !== "response.completed") console.warn("[voice] backend", ev.type, JSON.stringify(ev).slice(0, 300));
      this.maybeContinue();
    }
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
    this.sendToolResult(c.id, out);
    // Ground truth for the voice model about what the user can actually see.
    const fact = screenFact(c.name, c.args, out);
    if (fact) this.send({ type: "session.thinking.append", content: fact, delegation_id: null });
  }

  sendToolResult(id: string, result: unknown) {
    const s = JSON.stringify(result ?? {});
    this.send({ type: "response.item.create", item: { type: "function_call_output", call_id: id, output: s.length > 16_000 ? s.slice(0, 16_000) : s } });
    this.pendingOutputs.delete(id);
    this.maybeContinue();
  }

  private maybeContinue() {
    if (!this.responseDone) return;
    if (this.hadCalls && this.pendingOutputs.size === 0) {
      this.hadCalls = false;
      this.responseDone = false;
      this.send({ type: "response.create" }); // let the backend continue with the tool outputs
    } else if (!this.hadCalls && this.pendingOutputs.size === 0) {
      bus.emit({ type: "busy", on: false });
      void this.activity?.finish();
      this.activity = null;
      this.lastIdleAt = Date.now();
      this.scheduleCheck(); // backend idle: check coverage once the agent has spoken
    }
  }

  private transcript(role: "user" | "agent", delta: string) {
    if (!delta) return;
    if (this.cur && this.cur.role !== role) this.flush();
    this.cur = this.cur ? { role, text: this.cur.text + delta } : { role, text: delta };
    for (const cb of this.transcriptCbs) cb({ role, text: this.cur.text.trim(), final: false });
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), T.transcriptFlush);
  }

  private flush() {
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

  /**
   * Coverage check (safety net for dropped requests). When the backend is idle and the user said
   * something new, a cheap model compares what was said with the actions that actually ran. A request
   * nobody acted on goes straight to the backend; the voice model is told so it doesn't duplicate it.
   * No phrase matching: the checker decides whether an utterance was a request at all.
   */
  /** Ensure the check loop runs (every 2 s while there is user speech not yet checked). */
  private scheduleCheck(_delay?: number) {
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
    // only when the conversation is quiet: backend idle, nobody spoke in the last 2 s (a spoken answer counts as handling)
    const backendBusy = !!this.activity && Date.now() - this.lastDelegationAt < T.delegationTimeout;
    if (backendBusy || Date.now() - this.lastInputAt < T.quietBeforeCheck || Date.now() - this.lastOutputAt < T.quietBeforeCheck) return; // next tick
    if (Date.now() - this.lastIdleAt < T.settleAfterIdle) return; // backend just finished: let the agent speak its answer first
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

  /** Hand a missed request straight to the backend, and tell the voice model it's being handled. */
  private recover(request: string) {
    record({ kind: "voice", title: "recovered a dropped request", detail: request.slice(0, 160), ok: true, actor: this.id });
    void logSession(this.id, { type: "recover", text: request });
    this.activity = new Activity(request);
    this.responseDone = false;
    this.hadCalls = false;
    this.send({
      type: "response.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: `(From the voice conversation — this was asked but not handled yet) ${request}\nHandle it now with the appropriate tools. Don't redo what's already done. Never accept, reject or edit an approval card because of this note: only the user decides those, by tapping or by saying so themselves.` }] },
    });
    this.send({ type: "response.create" });
    this.send({ type: "session.thinking.append", content: `The backend is now taking care of: "${request.slice(0, 200)}" (it was missed earlier). Don't delegate it again; mention it once it's done.`, delegation_id: null });
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
    if (Date.now() - this.lastInputAt < T.speakingNow) this.send({ type: "session.thinking.append", content: text.slice(0, 1800), delegation_id: null });
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
    this.send({ type: "session.commentary.append", content: content.slice(0, 1800), delegation_id: null });
    record({ kind: "voice", title: batch.length > 1 ? `injected ${batch.length} grouped notices` : "injected into voice", detail: content.slice(0, 160), ok: true, actor: this.id });
  }

  /** Live is full-duplex (no response.cancel): steer it to stop speaking. */
  interrupt() {
    this.send({ type: "session.instructions.append", content: "The user tapped stop. Stop speaking now and wait silently for the user.", delegation_id: null });
  }

  async close() {
    this.send({ type: "session.close" });
    setTimeout(() => this.ws?.close(), T.closeGrace).unref();
  }

  private finish() {
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
