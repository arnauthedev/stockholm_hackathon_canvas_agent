import { api, token } from "./api.ts";

export type VoiceState = "connecting" | "live" | "idle" | "error";
/** voice: the Talk button (routes.voice). vision: the Live vision button (routes.liveVision, Gemini, camera on). */
export type CallMode = "voice" | "vision";

/**
 * Phone half of a voice call (B9). The runner's `voice` route picks the provider (`liveVision` for a Live
 * vision call, always one that takes video):
 * - openai: mic → WebRTC → OpenAI (GPT-Live); the runner holds the sideband.
 * - google: mic → PCM over the runner's /voice WebSocket → Gemini Live; agent audio comes back the
 *   same way, and camera frames can go up while the camera is open.
 * Transcripts and tool activity arrive over the bus from the runner either way.
 */
export class PhoneVoice {
  private impl: WebRtcVoice | RelayVoice | null = null;
  /** The provider accepts camera frames (set once the call is live). */
  video = false;
  /** Which button started the current (or last) call. */
  mode: CallMode = "voice";
  onState: (s: VoiceState, err?: string) => void = () => {};

  get sessionId() {
    return this.impl?.sessionId ?? null;
  }

  async start(mode: CallMode = "voice") {
    this.mode = mode;
    this.onState("connecting");
    // Created inside the tap's task so iOS lets it play later (the provider lookup below is async).
    const ctx = new AudioContext();
    void ctx.resume().catch(() => {});
    let p: { provider: string; model: string; video: boolean; ready: boolean };
    try {
      p = await api(`/api/voice/provider${mode === "vision" ? "?mode=vision" : ""}`);
    } catch (err) {
      void ctx.close();
      return this.onState("error", err instanceof Error ? err.message : String(err));
    }
    if (!p.ready) {
      void ctx.close();
      return this.onState("error", `${p.provider === "google" ? "GEMINI_API_KEY" : "OPENAI_API_KEY"} is not set in .env`);
    }
    if (mode === "vision" && !p.video) {
      void ctx.close();
      return this.onState("error", `Live vision needs a provider that takes video (ROUTE_liveVision is ${p.provider})`);
    }
    this.video = p.video;
    const impl = p.provider === "google" ? new RelayVoice(ctx, mode) : (void ctx.close(), new WebRtcVoice());
    this.impl = impl;
    impl.onState = (s, err) => {
      if (this.impl !== impl) return; // a call we already left (stop() cleans up ~400 ms later)
      if (s === "idle" || s === "error") {
        this.impl = null;
        this.video = false;
      }
      this.onState(s, err);
    };
    await impl.start();
  }

  interrupt() {
    this.impl?.interrupt();
  }

  /** Ends the call and reports idle right away, so another call can start without waiting for cleanup. */
  async stop() {
    const impl = this.impl;
    if (!impl) return;
    this.impl = null;
    this.video = false;
    await impl.stop();
    this.onState("idle");
  }

  /** A camera frame (base64 JPEG) for providers that take video. */
  sendFrame(jpeg: string) {
    this.impl?.sendFrame?.(jpeg);
  }
}

class WebRtcVoice {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement;
  sessionId: string | null = null;
  onState: (s: VoiceState, err?: string) => void = () => {};
  sendFrame?: (jpeg: string) => void; // GPT-Live has no image input

  constructor() {
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.setAttribute("playsinline", "");
    document.body.appendChild(this.audio);
  }

  async start() {
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const pc = new RTCPeerConnection();
      this.pc = pc;
      pc.ontrack = (e) => {
        this.audio.srcObject = e.streams[0] ?? null;
        void this.audio.play().catch(() => {});
      };
      for (const t of this.mic.getAudioTracks()) pc.addTrack(t, this.mic);
      this.dc = pc.createDataChannel("oai-events"); // must exist before the offer
      this.dc.onmessage = (m) => {
        try {
          const e = JSON.parse(m.data) as { type: string; error?: { message?: string } };
          if (e.type === "session.closed") this.cleanup("idle");
          if (e.type === "error") console.warn("[voice]", e.error?.message);
        } catch {}
      };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === "connected") this.onState("live");
        if (pc.connectionState === "failed" || pc.connectionState === "closed") this.cleanup(pc.connectionState === "failed" ? "error" : "idle");
      };
      await pc.setLocalDescription(await pc.createOffer());
      await waitIce(pc);
      const res = await api<{ session_id: string; sdp: string }>("/api/voice/session", { method: "POST", json: { sdp: pc.localDescription!.sdp } });
      this.sessionId = res.session_id;
      await pc.setRemoteDescription({ type: "answer", sdp: res.sdp });
    } catch (err) {
      this.cleanup("error", err instanceof Error ? err.message : String(err));
    }
  }

  /** Stop the agent talking right now: mute playback locally and tell the session. */
  interrupt() {
    this.audio.muted = true;
    setTimeout(() => (this.audio.muted = false), 700);
    if (this.sessionId) void api(`/api/voice/${this.sessionId}/interrupt`, { method: "POST" }).catch(() => {});
  }

  async stop() {
    try {
      if (this.dc?.readyState === "open") this.dc.send(JSON.stringify({ type: "session.close" }));
      if (this.sessionId) await api(`/api/voice/${this.sessionId}/close`, { method: "POST" }).catch(() => {});
    } finally {
      setTimeout(() => this.cleanup("idle"), 400);
    }
  }

  private cleanup(state: "idle" | "error", err?: string) {
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    try {
      this.pc?.close();
    } catch {}
    this.pc = null;
    this.dc = null;
    this.sessionId = null;
    this.audio.srcObject = null;
    this.audio.remove();
    this.onState(state, err);
  }
}

function waitIce(pc: RTCPeerConnection, timeoutMs = 2500): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") {
        clearTimeout(t);
        resolve();
      }
    });
  });
}

const OUT_RATE = 24000; // Gemini speaks PCM16 at 24 kHz; the context resamples to the device rate
const PLAY_LEAD = 0.15; // s of buffer when a reply starts (queue empty): absorbs tunnel/phone jitter so chunks don't leave gaps
const PLAY_MIN = 0.03; // a chunk arriving with less headroom than this restarts the buffer instead of playing with a gap
// Echo gate. Gemini's turn detector fires on the agent's own voice even 30 dB down (measured 2026-10-03),
// which no browser echo canceller guarantees on a speakerphone; each false start cut the reply and the
// model answered its own words. While agent audio plays, mic chunks quieter than GATE_DB go out as
// silence; a chunk above it (the user talking over the agent) opens the mic for a while.
const GATE_TAIL = 0.35; // s after the last scheduled agent sample during which the gate still applies (acoustic + canceller tail)
const GATE_OPEN_MS = 400; // once the user is clearly heard over the agent, keep the mic open this long
const GATE_DB = -26; // dBFS RMS a mic chunk must reach while the agent plays; tune on the device: localStorage.voiceGateDb = "-20"

/** Barge-in level: localStorage.voiceGateDb (dBFS) or GATE_DB, as int16 RMS. */
function gateLevel(): { db: number; rms: number } {
  let db = GATE_DB;
  try {
    const v = Number(localStorage.getItem("voiceGateDb"));
    if (v && Number.isFinite(v)) db = v;
  } catch {}
  return { db, rms: Math.pow(10, db / 20) * 32768 };
}
function rmsInt16(buf: ArrayBuffer): number {
  const a = new Int16Array(buf);
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * a[i]!;
  return a.length ? Math.sqrt(s / a.length) : 0;
}
const toDb = (rms: number) => (rms > 0 ? Math.round(20 * Math.log10(rms / 32768)) : -120);

/**
 * Plays a Web Audio stream through a local WebRTC loopback into an <audio> element. Browsers' echo
 * cancellation only subtracts audio it knows is playing — WebRTC remote audio is; plain Web Audio
 * output often isn't (the agent heard itself and cut its own sentences). GPT-Live gets this for free.
 */
async function loopbackPlayer(stream: MediaStream): Promise<{ el: HTMLAudioElement; close(): void }> {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && void b.addIceCandidate(e.candidate).catch(() => {});
  b.onicecandidate = (e) => e.candidate && void a.addIceCandidate(e.candidate).catch(() => {});
  const el = document.createElement("audio");
  el.autoplay = true;
  el.setAttribute("playsinline", "");
  document.body.appendChild(el);
  const close = () => {
    a.close();
    b.close();
    el.srcObject = null;
    el.remove();
  };
  try {
    const got = new Promise<MediaStream>((res) => (b.ontrack = (e) => res(e.streams[0] ?? new MediaStream([e.track]))));
    for (const t of stream.getAudioTracks()) a.addTrack(t, stream);
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);
    el.srcObject = await Promise.race([got, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("loopback timeout")), 3000))]);
    await el.play();
    return { el, close };
  } catch (err) {
    close();
    throw err;
  }
}

/** Gemini via the runner: PCM both ways over one WebSocket; the mic is gated while agent audio plays (GATE_DB). */
class RelayVoice {
  private ws: WebSocket | null = null;
  private mic: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private capture: AudioWorkletNode | null = null;
  private playAt = 0; // when the next chunk starts (gapless playback)
  private playing = new Set<AudioBufferSourceNode>();
  private out: AudioNode; // where agent audio goes: the loopback (echo-cancelled) or, failing that, the speakers
  private loopback: { close(): void } | null = null;
  private done = false;
  sessionId: string | null = null;
  onState: (s: VoiceState, err?: string) => void = () => {};

  constructor(
    private readonly ctx: AudioContext,
    private readonly mode: CallMode = "voice",
  ) {
    this.out = ctx.destination;
  }

  private async setupOutput() {
    const dest = this.ctx.createMediaStreamDestination();
    try {
      this.loopback = await loopbackPlayer(dest.stream);
      this.out = dest;
    } catch (err) {
      console.warn("[voice] echo-cancelled playback unavailable, using the speakers directly:", err);
    }
  }

  async start() {
    try {
      const [mic] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }),
        this.ctx.audioWorklet.addModule("/pcm-worklet.js"),
        this.setupOutput(),
      ]);
      if (this.done) return void mic.getTracks().forEach((t) => t.stop()); // stopped while connecting
      this.mic = mic;
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/voice?token=${encodeURIComponent(token)}${this.mode === "vision" ? "&mode=vision" : ""}`);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("voice socket failed"));
        ws.onclose = (e) => reject(new Error(e.reason || `voice socket closed (${e.code})`));
      });
      if (this.done) return void ws.close();
      ws.onerror = null;
      ws.onclose = () => this.cleanup("idle");
      ws.onmessage = (m) => (m.data instanceof ArrayBuffer ? this.play(m.data) : this.onControl(String(m.data)));
      // mic → worklet (PCM16 16 kHz) → socket. A muted path to the output keeps the worklet scheduled.
      this.source = this.ctx.createMediaStreamSource(mic);
      this.capture = new AudioWorkletNode(this.ctx, "pcm16-capture", { processorOptions: { targetRate: 16000 } });
      const gate = gateLevel();
      let openUntil = 0;
      let lastLog = 0;
      this.capture.port.onmessage = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const buf = e.data as ArrayBuffer;
        if (this.ctx.currentTime >= this.playAt + GATE_TAIL) return ws.send(buf); // nothing of ours is playing: the mic goes through as is
        const rms = rmsInt16(buf);
        const t = performance.now();
        if (rms >= gate.rms) openUntil = t + GATE_OPEN_MS;
        const open = t < openUntil;
        if (t - lastLog > 1000) {
          lastLog = t;
          console.log(`[voice] gate ${open ? "open" : "closed"} while the agent plays: mic ${toDb(rms)} dBFS, barge-in at ${gate.db} dBFS`);
        }
        ws.send(open ? buf : new ArrayBuffer(buf.byteLength)); // silence keeps the stream continuous for the server's turn detector
      };
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.source.connect(this.capture).connect(mute).connect(this.ctx.destination);
      document.addEventListener("visibilitychange", this.onVisibility);
    } catch (err) {
      this.cleanup("error", err instanceof Error ? err.message : String(err));
    }
  }

  private onVisibility = () => {
    // backgrounded: the mic stops delivering; tell the server the stream paused (VAD) instead of leaving it hanging
    if (document.hidden) this.send({ type: "audio_end" });
  };

  private onControl(raw: string) {
    let e: { type?: string; session_id?: string; message?: string };
    try {
      e = JSON.parse(raw) as typeof e;
    } catch {
      return;
    }
    switch (e.type) {
      case "ready":
        this.sessionId = e.session_id ?? null;
        this.onState("live");
        break;
      case "interrupted":
        this.clearPlayback();
        break;
      case "error":
        this.cleanup("error", e.message);
        break;
      case "closed":
        this.cleanup("idle");
        break;
    }
  }

  private play(buf: ArrayBuffer) {
    if (this.done) return;
    const i16 = new Int16Array(buf.byteLength & 1 ? buf.slice(0, buf.byteLength - 1) : buf);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i]! / 32768;
    const ab = this.ctx.createBuffer(1, f32.length, OUT_RATE);
    ab.getChannelData(0).set(f32);
    const s = this.ctx.createBufferSource();
    s.buffer = ab;
    s.connect(this.out);
    const now = this.ctx.currentTime;
    const at = this.playAt - now < PLAY_MIN ? now + PLAY_LEAD : this.playAt;
    s.start(at);
    this.playAt = at + ab.duration;
    this.playing.add(s);
    s.onended = () => this.playing.delete(s);
  }

  private clearPlayback() {
    for (const s of this.playing) {
      try {
        s.stop();
      } catch {}
    }
    this.playing.clear();
    this.playAt = 0;
  }

  private send(e: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(e));
  }

  sendFrame(jpeg: string) {
    this.send({ type: "video", data: jpeg });
  }

  /** Stop the agent talking right now: drop queued audio and tell the session. */
  interrupt() {
    this.clearPlayback();
    this.send({ type: "interrupt" });
  }

  async stop() {
    this.send({ type: "close" });
    setTimeout(() => this.cleanup("idle"), 400);
  }

  private cleanup(state: "idle" | "error", err?: string) {
    if (this.done) return;
    this.done = true;
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.clearPlayback();
    this.loopback?.close();
    this.loopback = null;
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    try {
      this.source?.disconnect();
      this.capture?.disconnect();
    } catch {}
    void this.ctx.close().catch(() => {});
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) {
      this.ws.onclose = null;
      this.ws.close();
    }
    this.ws = null;
    this.sessionId = null;
    this.onState(state, err);
  }
}
