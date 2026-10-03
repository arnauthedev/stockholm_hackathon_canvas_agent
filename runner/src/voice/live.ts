import { randomBytes } from "node:crypto";
import OpenAI from "openai";
import WebSocket from "ws";
import { helperDefs, toolDefs, TOOL_NAMES, type StateSnapshot, type ToolDef, type VoiceSession } from "@canvas-agent/contract";
import { route } from "../../../config/routes.ts";
import { bus } from "../bus.ts";
import { env } from "../env.ts";
import { brainInstructions } from "../prompts.ts";
import { logSession } from "../sessions.ts";
import { voiceInstructions } from "./prompt.ts";
import { Activity } from "../activity.ts";
import { record } from "../monitor.ts";
import { T, VoiceCore, toolOutputText, voiceNameFor } from "./core.ts";

/**
 * GPT-Live, runner half (B9).
 * - The phone POSTs its SDP offer; the runner creates the session with the project key
 *   (GPT-Live has no ephemeral client secrets) and returns the SDP answer.
 * - The runner attaches the sideband WebSocket, owns all function calls (Responses
 *   delegation), returns outputs, and injects async results via session.commentary.append.
 * - The phone's data channel is restricted to lifecycle events (untrusted frontend).
 */

let _client: OpenAI | null = null;
const client = () => (_client ??= new OpenAI({ apiKey: env.OPENAI_API_KEY }));

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
    audio: { output: { voice: voiceNameFor(voice, "openai") } },
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
  record({ kind: "voice", title: "voice session started", detail: `${voice.model} · backend ${brain.model}`, ok: true, actor: session_id });
  await sb.connect({ tools: [], instructions: "", context: {} as StateSnapshot });
  return { session_id, sdp: res.transport.sdp };
}

type Envelope = { type: string; [k: string]: unknown };

class LiveSideband extends VoiceCore {
  private ws: WebSocket | null = null;
  // response bookkeeping: send response.create once every output of a response is in
  private pendingOutputs = new Set<string>();
  private responseDone = false;
  private hadCalls = false;
  private seenCalls = new Set<string>();

  constructor(id: string) {
    super(id, "openai");
  }

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
    this.attach({ model: route("voice").model, brain: route("brain").model });
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
        record({ kind: "voice", title: "delegated to backend", detail: this.currentUserText().slice(0, 160), ok: true, actor: this.id });
        void this.activity?.finish();
        this.activity = new Activity(this.currentUserText() || "Voice request");
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
        this.emitToolCall({ id: item.call_id, name: item.name, args });
      }
    } else if (ev.type === "response.completed" || ev.type === "response.failed" || ev.type === "response.incomplete") {
      this.responseDone = true;
      if (ev.type !== "response.completed") console.warn("[voice] backend", ev.type, JSON.stringify(ev).slice(0, 300));
      this.maybeContinue();
    }
  }

  sendToolResult(id: string, result: unknown, fact?: string | null) {
    this.send({ type: "response.item.create", item: { type: "function_call_output", call_id: id, output: toolOutputText(result) } });
    this.pendingOutputs.delete(id);
    this.maybeContinue();
    // Ground truth for the voice model about what the user can actually see.
    if (fact) this.send({ type: "session.thinking.append", content: fact, delegation_id: null });
  }

  private maybeContinue() {
    if (!this.responseDone) return;
    if (this.hadCalls && this.pendingOutputs.size === 0) {
      this.hadCalls = false;
      this.responseDone = false;
      this.send({ type: "response.create" }); // let the backend continue with the tool outputs
    } else if (!this.hadCalls && this.pendingOutputs.size === 0) {
      this.idle(); // backend idle: check coverage once the agent has spoken
    }
  }

  protected working() {
    return !!this.activity && Date.now() - this.lastDelegationAt < T.delegationTimeout;
  }

  protected sendSilent(text: string) {
    this.send({ type: "session.thinking.append", content: text, delegation_id: null });
  }

  protected sendSpoken(content: string) {
    this.send({ type: "session.commentary.append", content, delegation_id: null });
  }

  /** Hand a missed request straight to the backend, and tell the voice model it's being handled. */
  protected sendRecovery(request: string) {
    this.responseDone = false;
    this.hadCalls = false;
    this.send({
      type: "response.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text: `(From the voice conversation — this was asked but not handled yet) ${request}\nHandle it now with the appropriate tools. Don't redo what's already done. Never accept, reject or edit an approval card because of this note: only the user decides those, by tapping or by saying so themselves.` }] },
    });
    this.send({ type: "response.create" });
    this.send({ type: "session.thinking.append", content: `The backend is now taking care of: "${request.slice(0, 200)}" (it was missed earlier). Don't delegate it again; mention it once it's done.`, delegation_id: null });
  }

  /** Live is full-duplex (no response.cancel): steer it to stop speaking. */
  interrupt() {
    this.send({ type: "session.instructions.append", content: "The user tapped stop. Stop speaking now and wait silently for the user.", delegation_id: null });
  }

  async close() {
    this.send({ type: "session.close" });
    setTimeout(() => this.ws?.close(), T.closeGrace).unref();
  }
}
