import { useCallback, useEffect, useRef, useState } from "react";
import { BottomBar, type TalkState } from "./components/BottomBar.tsx";
import { CameraPanel } from "./components/CameraPanel.tsx";
import { CanvasView } from "./components/CanvasView.tsx";
import { LinkPrompt, ModalSheet, Toasts, TranscriptOverlay } from "./components/Overlay.tsx";
import { Pager } from "./components/Pager.tsx";
import { ScreenView } from "./components/ScreensView.tsx";
import { TasksView } from "./components/TasksView.tsx";
import { TextSheet } from "./components/TextSheet.tsx";
import { PhotoSheet } from "./components/PhotoSheet.tsx";
import { SettingsSheet } from "./components/SettingsSheet.tsx";
import { pairWith, token } from "./lib/api.ts";
import { connectBus } from "./lib/bus.ts";
import { useStore } from "./lib/store.ts";
import { applyTheme } from "./lib/theme.ts";
import { PhoneVoice, type CallMode } from "./lib/voice.ts";

export function App() {
  const theme = useStore((s) => s.theme);
  const connected = useStore((s) => s.connected);
  const screens = useStore((s) => s.screens);
  // One call at a time: `call` is its state, `mode` which button started it (Talk or Live vision).
  const [call, setCall] = useState<TalkState>("idle");
  const [mode, setMode] = useState<CallMode>("voice");
  const voice = useRef<PhoneVoice | null>(null);
  const transcript = useStore((s) => s.transcript);

  const phoneVoice = () => {
    if (!voice.current) {
      const v = new PhoneVoice();
      v.onState = (s, err) => {
        setCall(s);
        const live = s === "live";
        // Live vision opens the camera as soon as the call is up; any call ending closes it.
        useStore.getState().set({ voiceLive: live, voiceVideo: live && v.video, ...(live ? { trayOpen: false, lastTalkAt: Date.now(), cameraOpen: v.mode === "vision" } : { cameraOpen: false }) });
        if (err) useStore.getState().toast({ text: `${v.mode === "vision" ? "Live vision" : "Voice"}: ${err}`, kind: "error" });
      };
      voice.current = v;
    }
    return voice.current;
  };
  const onCall = (m: CallMode) => {
    const v = phoneVoice();
    if (call === "idle" || call === "error") return (setMode(m), void v.start(m));
    if (mode !== m) return (setMode(m), void v.stop().then(() => v.start(m))); // switch Talk ↔ Live vision
    if (call === "connecting") return void v.stop();
    // live Talk: if the agent is mid-sentence, interrupt; otherwise end the session
    const last = transcript[transcript.length - 1];
    if (m === "voice" && last?.role === "agent" && !last.final) v.interrupt();
    else void v.stop();
  };
  const [textOpen, setTextOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const voiceVideo = useStore((s) => s.voiceVideo);
  const cameraOpen = useStore((s) => s.cameraOpen);
  const sendFrame = useCallback((jpeg: string) => voice.current?.sendFrame(jpeg), []);
  // The camera is the point of a Live vision call: closing it ends the call.
  const closeCamera = useCallback(() => (voice.current?.mode === "vision" ? void voice.current.stop() : useStore.getState().set({ cameraOpen: false })), []);

  useEffect(() => {
    if (token) connectBus();
    // deep links from notifications: /#task=<id>, /#app=<slug>, /#approval
    const go = (url: string) => {
      const h = url.includes("#") ? url.slice(url.indexOf("#") + 1) : "";
      const s = useStore.getState();
      if (h.startsWith("task=")) s.set({ page: 0 });
      else if (h.startsWith("app=")) {
        const slug = decodeURIComponent(h.slice(4));
        const i = s.screens?.screens.findIndex((sc) => sc.id === s.apps[slug]?.app.screen) ?? -1;
        s.set({ page: i >= 0 ? 2 + i : 1 });
      } else if (h === "approval") s.set({ page: 1 });
    };
    if (/#(task|app)=|#approval/.test(location.hash)) {
      setTimeout(() => go(location.hash), 600); // after state hydrates
      history.replaceState(null, "", location.pathname);
    }
    const onMsg = (e: MessageEvent) => e.data?.type === "navigate" && go(String(e.data.url));
    navigator.serviceWorker?.addEventListener("message", onMsg);
    return () => navigator.serviceWorker?.removeEventListener("message", onMsg);
  }, []);
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  if (!token) return <PairScreen />;

  const screenList = screens?.screens ?? [{ id: "s1" }];
  const pages = [
    { key: "tasks", label: "Tasks", node: <TasksView /> },
    { key: "canvas", label: "Canvas", node: <CanvasView /> },
    ...screenList.map((s, i) => ({ key: s.id, label: `Screen ${i + 1}`, node: <ScreenView screenId={s.id} /> })),
  ];

  return (
    <div className="app">
      <div className={connected ? "conn ok" : "conn"} title={connected ? "Connected" : "Offline"} />
      <button className="settings-btn" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.6 7.6 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.6 7.6 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.5zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" /></svg>
      </button>
      <Toasts />
      <Pager pages={pages} />
      <TranscriptOverlay visible />
      <LinkPrompt />
      {cameraOpen && voiceVideo && <CameraPanel send={sendFrame} onClose={closeCamera} />}
      <BottomBar
        talk={mode === "voice" ? call : "idle"}
        onTalk={() => onCall("voice")}
        vision={mode === "vision" ? call : "idle"}
        onVision={() => onCall("vision")}
        onText={() => setTextOpen(true)}
        onImage={setPhoto}
      />
      <TextSheet open={textOpen} onClose={() => setTextOpen(false)} />
      <PhotoSheet file={photo} onClose={() => setPhoto(null)} />
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      <ModalSheet />
    </div>
  );
}

/** Unpaired device. A home-screen app on iOS starts with empty storage, so it pairs by pasting the link. */
function PairScreen() {
  const [link, setLink] = useState("");
  const [error, setError] = useState(false);
  const submit = (value: string) => setError(!pairWith(value));
  const paste = async () => {
    try {
      const t = await navigator.clipboard.readText();
      setLink(t);
      submit(t);
    } catch {
      setError(true);
    }
  };
  return (
    <main className="pair">
      <h1>Canvas Agent</h1>
      <p>Open the pairing link from your computer on this device.</p>
      <p>Added to the Home Screen? Paste the pairing link here once (Copy link in Safari, or copy it from the computer).</p>
      <form className="text-row" onSubmit={(e) => (e.preventDefault(), submit(link))}>
        <input value={link} onChange={(e) => (setLink(e.target.value), setError(false))} placeholder="https://…/#token=…" autoCapitalize="off" autoCorrect="off" spellCheck={false} />
        {link.trim() ? <button className="btn primary">Connect</button> : <button type="button" className="btn primary" onClick={() => void paste()}>Paste</button>}
      </form>
      {error && <p className="pair-error">That isn't a pairing link.</p>}
    </main>
  );
}
