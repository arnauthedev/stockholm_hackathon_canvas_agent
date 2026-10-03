import { randomBytes } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import { ActivityHandling, Behavior, GoogleGenAI, MediaResolution, Modality, StartSensitivity, ThinkingLevel, type FunctionCall, type FunctionDeclaration, type LiveConnectConfig, type LiveServerMessage, type Session } from "@google/genai";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { helperDefs, toolDefs, TOOL_NAMES, type ToolDef, type VoiceSession } from "@canvas-agent/contract";
import { route, type Route } from "../../../config/routes.ts";
import { bus } from "../bus.ts";
import { env } from "../env.ts";
import { logSession } from "../sessions.ts";
import { geminiInstructions } from "./prompt.ts";
import { Activity } from "../activity.ts";
import { record } from "../monitor.ts";
import { T, VoiceCore, toolOutputText, voiceNameFor } from "./core.ts";

/**
 * Gemini Live, runner half (B9). The runner owns the Gemini session and the phone only streams
 * audio to it over /voice (a WebSocket on the runner, RUNNER_TOKEN like /bus): keys and tools stay
 * here, and notices, facts, transcripts and the coverage check work as with GPT-Live. There is no
 * backend model: the Live model holds the whole tool set and Google Search. Tools are BLOCKING on
 * gemini-3.8-live: every tool returns within ~1 s (slow work is create_tasks, which returns "started"),
 * and with NON_BLOCKING + WHEN_IDLE the model sometimes never resumed after a result (30 s of silence
 * on the phone). Extended thinking only supports NON_BLOCKING.
 *
 * Echo: the phone gates its mic while agent audio plays (app voice.ts, GATE_DB). Gemini's turn detector
 * fires on the agent's own voice even 30 dB down, then cuts the reply and answers itself; a low start
 * sensitivity and prefixPaddingMs do not help (measured 2026-10-03). VOICE_NO_BARGE_IN=1 is the blunt
 * fallback (NO_INTERRUPTION): immune to echo, but anything said while the agent talks is dropped.
 * Timing: a sentence arrives in a burst (3 s of audio in ~0.7 s), so "the agent is speaking" is the
 * phone's projected playback end (playbackEndsAt), not the arrival of chunks.
 *
 * Phone → runner: binary = PCM16 mono 16 kHz; JSON {type:"video", data} (JPEG base64, while the
 *   camera is open), {type:"audio_end"} (mic paused), {type:"interrupt"}, {type:"close"}.
 * Runner → phone: binary = PCM16 mono 24 kHz; JSON {type:"ready", session_id}, {type:"interrupted"}
 *   (drop queued playback), {type:"error", message}, {type:"closed"}.
 */

const RECONNECT_TRIES = 3; // resumes after GoAway / the ~10 min connection limit, with the last handle
const DEBUG = process.env.VOICE_DEBUG === "1";
const NO_BARGE_IN = process.env.VOICE_NO_BARGE_IN === "1";
const PHONE_LAG = 300; // ms from sending a chunk to the phone starting to play it (tunnel + its playback lead)
const BYTES_PER_MS = 48; // PCM16 mono 24 kHz

let _ai: GoogleGenAI | null = null;
const ai = () => (_ai ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }));

/** /voice upgrade: one Gemini session per phone socket. */
export function attachVoiceRelay(server: Server) {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname !== "/voice") return;
    const refuse = (status: number, text: string) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\n\r\n`);
      socket.destroy();
    };
    if (url.searchParams.get("token") !== env.RUNNER_TOKEN) return refuse(401, "Unauthorized");
    if (route("voice").provider !== "google") return refuse(409, "Conflict: voice provider is not google");
    if (!env.GEMINI_API_KEY) return refuse(503, "Service Unavailable: GEMINI_API_KEY is not set in .env");
    wss.handleUpgrade(req, socket, head, (ws) => void createGeminiSession(ws));
  });
}

async function createGeminiSession(phone: WebSocket) {
  const voice = route("voice");
  const s = new GeminiLiveSession(`gem_${randomBytes(6).toString("hex")}`, phone, voice);
  try {
    await s.connect({ tools: [], instructions: "", context: {} as never });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[voice] gemini connect failed:", msg);
    s.abort(`Gemini: ${msg.slice(0, 160)}`);
  }
}

/** Contract tool → Live function declaration (JSON schema as-is). */
function fnDecl(d: ToolDef, behavior: Behavior): FunctionDeclaration {
  const { $schema: _s, ...parametersJsonSchema } = d.parameters as Record<string, unknown>;
  return { name: d.name, description: d.description, behavior, parametersJsonSchema };
}

/** @effort on the route → thinking level (extended-thinking models only; MINIMAL is not supported there). */
function thinkingLevel(effort: unknown): ThinkingLevel {
  return effort === "high" ? ThinkingLevel.HIGH : effort === "medium" ? ThinkingLevel.MEDIUM : ThinkingLevel.LOW;
}

/**
 * Gemini quotes "$"-prefixed keys in function arguments ({"\"$bind\"": "/days"} instead of
 * {"$bind": "/days"}), so every bound chart failed validation and the model retried (seconds each).
 * Strip quotes wrapped around any key, and accept the two misplaced-root shapes the model produces.
 */
export function cleanArgs(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(cleanArgs);
  if (!v || typeof v !== "object") return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) out[k.replace(/^"(.*)"$/, "$1")] = cleanArgs(val);
  const comps = out.components as Record<string, unknown> | undefined;
  if (comps && typeof comps === "object" && out.root === undefined && "root" in comps) {
    if (typeof comps.root === "string") {
      out.root = comps.root; // {"components": {"root": "col", …}}: the root id ended up among the components
      delete comps.root;
    } else out.root = "root"; // the root container itself is keyed "root"
  }
  return out;
}

const asBuffer = (raw: RawData) => (Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw));

class GeminiLiveSession extends VoiceCore {
  private session: Session | null = null;
  private config: LiveConnectConfig = {};
  // tool calls the model is waiting on (id → name: Gemini wants the name on the response)
  private pending = new Map<string, string>();
  private generating = false;
  private spoke = false;
  private playbackEndsAt = 0; // when the phone will have played everything sent so far
  private muted = false; // the user tapped stop: the rest of this turn's audio is dropped
  private readonly t0 = Date.now();
  private status: "IN_PROGRESS" | "IDLE" = "IDLE"; // extended thinking: turnComplete alone doesn't mean idle
  private resumeHandle: string | undefined;
  private reconnects = 0;
  private closing = false;
  private readonly extended: boolean;

  constructor(
    id: string,
    private readonly phone: WebSocket,
    private readonly cfg: Route,
  ) {
    super(id, "google");
    this.extended = cfg.model.includes("extended-thinking");
  }

  async connect(_opts: Parameters<VoiceSession["connect"]>[0]) {
    const behavior = this.extended ? Behavior.NON_BLOCKING : Behavior.BLOCKING;
    const declarations = [...toolDefs(TOOL_NAMES), ...helperDefs()].map((d) => fnDecl(d, behavior));
    this.config = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: [{ text: await geminiInstructions() }] },
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceNameFor(this.cfg, "google") } } },
      tools: [{ googleSearch: {} }, { functionDeclarations: declarations }],
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} }, // calls longer than 15 min
      sessionResumption: {}, // handles for reconnecting
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW, // camera frames: enough for "what is this", cheap
      // a little less trigger-happy; the real protection against the agent's own echo is the phone's mic gate (header)
      realtimeInputConfig: {
        automaticActivityDetection: { startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW },
        ...(NO_BARGE_IN ? { activityHandling: ActivityHandling.NO_INTERRUPTION } : {}),
      },
      ...(this.extended ? { thinkingConfig: { thinkingLevel: thinkingLevel(this.cfg.voiceReasoning) } } : {}),
    };
    this.bindPhone(); // before the upstream connect: the phone starts streaming as soon as its socket opens
    await this.open(); // resolves after Gemini's setup handshake
    this.attach({ model: this.cfg.model });
    this.toPhone({ type: "ready", session_id: this.id });
    record({ kind: "voice", title: "voice session started", detail: `${this.cfg.model} · tools in the voice model`, ok: true, actor: this.id });
    console.log(`[voice] gemini ${this.id} ready (${this.cfg.model})`);
  }

  private async open(handle?: string) {
    this.session = await ai().live.connect({
      model: this.cfg.model,
      config: { ...this.config, sessionResumption: { handle } },
      callbacks: {
        onmessage: (m) => this.onMessage(m),
        onerror: (e) => {
          console.warn("[voice] gemini error", e.message);
          bus.emit({ type: "toast", text: `Voice: ${String(e.message ?? "error").slice(0, 140)}`, kind: "error" });
          void logSession(this.id, { type: "error", error: String(e.message) });
        },
        onclose: (e) => this.onUpstreamClose(e.code, e.reason),
      },
    });
  }

  private onUpstreamClose(code: number, reason: string) {
    console.log(`[voice] gemini ${this.id} closed (${code} ${reason})`);
    if (this.closing) return this.finish();
    // Not our doing (GoAway, the connection limit, network): resume with the last handle, audio keeps flowing.
    if (this.resumeHandle && this.reconnects++ < RECONNECT_TRIES) {
      void this.open(this.resumeHandle)
        .then(() => record({ kind: "voice", title: "voice session resumed", detail: reason || String(code), ok: true, actor: this.id }))
        .catch((err: unknown) => this.abort(`Voice connection lost (${err instanceof Error ? err.message : String(err)})`));
      return;
    }
    this.abort(`Voice connection lost (${reason || code})`);
  }

  private bindPhone() {
    let audioIn = 0;
    this.phone.on("message", (raw, isBinary) => {
      if (isBinary) {
        const buf = asBuffer(raw);
        if (!audioIn) console.log(`[voice] gemini ${this.id}: first audio from the phone (${buf.length} B)`);
        audioIn += buf.length;
        this.session?.sendRealtimeInput({ audio: { data: buf.toString("base64"), mimeType: "audio/pcm;rate=16000" } });
        return;
      }
      let m: { type?: string; data?: string };
      try {
        m = JSON.parse(String(raw)) as typeof m;
      } catch {
        return;
      }
      switch (m.type) {
        case "video":
          if (m.data) this.session?.sendRealtimeInput({ video: { data: m.data, mimeType: "image/jpeg" } });
          break;
        case "audio_end":
          this.session?.sendRealtimeInput({ audioStreamEnd: true });
          break;
        case "interrupt":
          this.interrupt();
          break;
        case "close":
          void this.close();
          break;
      }
    });
    this.phone.on("close", () => {
      if (!this.closing) void this.close();
    });
    this.phone.on("error", (e) => console.warn("[voice] phone socket", e.message));
  }

  private toPhone(e: Record<string, unknown>) {
    if (this.phone.readyState === WebSocket.OPEN) this.phone.send(JSON.stringify(e));
  }

  private onMessage(m: LiveServerMessage) {
    if (DEBUG) this.debug(m);
    if (m.sessionResumptionUpdate?.resumable && m.sessionResumptionUpdate.newHandle) this.resumeHandle = m.sessionResumptionUpdate.newHandle;
    if (m.goAway) console.log(`[voice] gemini ${this.id} goAway in ${m.goAway.timeLeft}`);
    const c = m.serverContent;
    if (c) {
      if (c.interactionStatus === "IDLE" || c.interactionStatus === "IN_PROGRESS") this.status = c.interactionStatus;
      if (c.interrupted) {
        this.toPhone({ type: "interrupted" }); // the user spoke over the agent: drop queued playback
        this.playbackEndsAt = this.lastOutputAt = Date.now();
        this.flush("agent");
      }
      for (const p of c.modelTurn?.parts ?? []) {
        if (!p.inlineData?.data) continue;
        this.generating = true;
        if (this.muted) continue; // the user tapped stop: the rest of this turn is not played
        if (!this.spoke) console.log(`[voice] gemini ${this.id}: first audio from the model`);
        this.spoke = true;
        const chunk = Buffer.from(p.inlineData.data, "base64");
        this.playbackEndsAt = Math.max(this.playbackEndsAt, Date.now() + PHONE_LAG) + chunk.length / BYTES_PER_MS;
        this.lastOutputAt = this.playbackEndsAt; // "speaking" lasts until the phone has played it, not until it arrived
        if (this.phone.readyState === WebSocket.OPEN) this.phone.send(chunk, { binary: true });
      }
      if (c.inputTranscription?.text) {
        this.lastInputAt = Date.now();
        this.transcript("user", c.inputTranscription.text);
      }
      if (c.outputTranscription?.text) {
        this.lastOutputAt = Math.max(this.lastOutputAt, Date.now());
        this.transcript("agent", c.outputTranscription.text);
      }
      if (c.turnComplete) {
        this.generating = false;
        this.muted = false;
        this.flushWhenHeard("agent"); // the line ends when the phone finishes playing: the stop button reads "mid-sentence" from it
        this.maybeIdle();
      }
    }
    if (m.toolCall?.functionCalls?.length) this.onToolCalls(m.toolCall.functionCalls);
    if (m.toolCallCancellation?.ids?.length) {
      for (const id of m.toolCallCancellation.ids) this.pending.delete(id); // result no longer wanted (user moved on)
      this.maybeIdle();
    }
  }

  /** VOICE_DEBUG=1: one line per server message (what Gemini sent, when). */
  private debug(m: LiveServerMessage) {
    const c = m.serverContent;
    const bits: string[] = [];
    if (c) {
      const audio = (c.modelTurn?.parts ?? []).filter((p) => p.inlineData?.data).length;
      if (audio) bits.push(`audio×${audio}`);
      for (const p of c.modelTurn?.parts ?? []) if (p.text) bits.push(`text:"${p.text.slice(0, 80)}"`);
      if (c.inputTranscription?.text) bits.push(`in:"${c.inputTranscription.text}"`);
      if (c.outputTranscription?.text) bits.push(`out:"${c.outputTranscription.text}"`);
      for (const k of ["turnComplete", "generationComplete", "interrupted", "waitingForInput"] as const) if (c[k]) bits.push(k);
      if (c.turnCompleteReason) bits.push(`reason=${c.turnCompleteReason}`);
      if (c.interactionStatus) bits.push(`status=${c.interactionStatus}`);
    }
    if (m.toolCall) bits.push(`toolCall ${m.toolCall.functionCalls?.map((f) => `${f.name}#${f.id ?? "NO-ID"} ${JSON.stringify(f.args ?? null).slice(0, 80)}`).join(" | ")}`);
    if (m.toolCallCancellation) bits.push(`cancel ${m.toolCallCancellation.ids?.join(",")}`);
    if (m.sessionResumptionUpdate) bits.push("resumption");
    if (m.goAway) bits.push(`goAway ${m.goAway.timeLeft}`);
    if (m.voiceActivityDetectionSignal || m.voiceActivity) bits.push(`vad ${JSON.stringify(m.voiceActivityDetectionSignal ?? m.voiceActivity)}`);
    if (m.usageMetadata) bits.push(`usage ${m.usageMetadata.totalTokenCount}`);
    if (bits.length) console.log(`[voice] ${this.id} +${((Date.now() - this.t0) / 1000).toFixed(1)}s ${bits.join(" ")}`);
  }

  private onToolCalls(calls: FunctionCall[]) {
    this.lastDelegationAt = Date.now();
    if (!this.activity) {
      record({ kind: "voice", title: "voice model called tools", detail: `${calls.map((c) => c.name).join(", ")} · "${this.currentUserText().slice(0, 120)}"`, ok: true, actor: this.id });
      this.activity = new Activity(this.currentUserText() || "Voice request");
    }
    for (const fc of calls) {
      if (!fc.id || !fc.name) continue;
      this.pending.set(fc.id, fc.name);
      this.emitToolCall({ id: fc.id, name: fc.name, args: cleanArgs(fc.args ?? {}) });
    }
  }

  /** The model finished a turn with nothing outstanding: the request is done. */
  private maybeIdle() {
    if (this.pending.size || (this.extended && this.status === "IN_PROGRESS")) return;
    if (this.activity) this.idle();
    else bus.emit({ type: "busy", on: false });
  }

  sendToolResult(id: string, result: unknown, fact?: string | null) {
    const name = this.pending.get(id);
    this.pending.delete(id);
    if (!name || !this.session) return; // cancelled by the model meanwhile
    const text = toolOutputText(result);
    const response: Record<string, unknown> = { result: text.length < 16_000 ? (result ?? {}) : text };
    if (fact) response.note = fact; // what is really on the screen, with the result it refers to
    this.session.sendToolResponse({
      functionResponses: [{ id, name, response }], // no scheduling: BLOCKING ignores it, extended thinking rejects it
    });
  }

  protected working() {
    return this.pending.size > 0 || this.generating || (!!this.activity && Date.now() - this.lastDelegationAt < T.delegationTimeout);
  }

  protected speakingUntil() {
    return this.playbackEndsAt;
  }

  /** Added to the context; the model responds to it with the user's next turn, not now. */
  protected sendSilent(text: string) {
    this.session?.sendClientContent({ turns: [{ role: "user", parts: [{ text: `(System note, not the user speaking.) ${text}` }] }], turnComplete: false });
  }

  /** turnComplete makes the model respond now; the notice queue only sends this when nobody is talking. */
  protected sendSpoken(text: string) {
    this.session?.sendClientContent({ turns: [{ role: "user", parts: [{ text: `(System notice, not the user speaking — mention it to the user briefly.) ${text}` }] }], turnComplete: true });
  }

  protected sendRecovery(request: string) {
    this.lastDelegationAt = Date.now();
    this.session?.sendClientContent({
      turns: [{ role: "user", parts: [{ text: `(From the conversation — this was asked but not handled yet.) ${request}\nHandle it now with the appropriate tools. Don't redo what's already done. Never accept, reject or edit an approval card because of this note: only the user decides those, by tapping or by saying so themselves.` }] }],
      turnComplete: true,
    });
  }

  /** The stop button: the phone drops its queue, the rest of this turn is not forwarded, and the model is told without being asked to answer (a completed client turn made it reply again). */
  interrupt() {
    this.toPhone({ type: "interrupted" });
    this.muted = this.generating;
    this.playbackEndsAt = this.lastOutputAt = Date.now();
    this.flush("agent");
    this.sendSilent("The user tapped stop while you were speaking; they did not hear the rest. Wait for them.");
  }

  /** Tell the phone, end the call, and drop the session even if Gemini never says goodbye. */
  abort(message: string) {
    this.toPhone({ type: "error", message });
    void this.close();
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.toPhone({ type: "closed" });
    try {
      this.session?.close();
    } catch {}
    setTimeout(() => {
      this.finish();
      if (this.phone.readyState === WebSocket.OPEN) this.phone.close();
    }, T.closeGrace).unref();
  }
}
