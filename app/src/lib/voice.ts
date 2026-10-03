import { api } from "./api.ts";

/**
 * Phone half of the GPT-Live session (B9): mic → WebRTC → OpenAI, agent audio ← WebRTC.
 * The SDP offer goes to the runner, which creates the session (no keys on the phone).
 * Transcripts and tool activity arrive over the bus from the runner's sideband.
 */
export class PhoneVoice {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement;
  sessionId: string | null = null;
  onState: (s: "connecting" | "live" | "idle" | "error", err?: string) => void = () => {};

  constructor() {
    this.audio = document.createElement("audio");
    this.audio.autoplay = true;
    this.audio.setAttribute("playsinline", "");
    document.body.appendChild(this.audio);
  }

  async start() {
    this.onState("connecting");
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
