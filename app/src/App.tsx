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
import { pairWith, token } from "./lib/api.ts";
import { connectBus } from "./lib/bus.ts";
import { useStore } from "./lib/store.ts";
import { applyTheme } from "./lib/theme.ts";
import { PhoneVoice } from "./lib/voice.ts";

export function App() {
  const theme = useStore((s) => s.theme);
  const connected = useStore((s) => s.connected);
  const screens = useStore((s) => s.screens);
  const [talk, setTalk] = useState<TalkState>("idle");
  const voice = useRef<PhoneVoice | null>(null);
  const transcript = useStore((s) => s.transcript);

  const onTalk = () => {
    if (!voice.current) {
      voice.current = new PhoneVoice();
      voice.current.onState = (s, err) => {
        setTalk(s);
        const live = s === "live";
        useStore.getState().set({ voiceLive: live, voiceVideo: live && !!voice.current?.video, ...(live ? { trayOpen: false, lastTalkAt: Date.now() } : { cameraOpen: false }) });
        if (err) useStore.getState().toast({ text: `Voice: ${err}`, kind: "error" });
      };
    }
    const v = voice.current;
    if (talk === "idle" || talk === "error") return void v.start();
    if (talk === "connecting") return void v.stop();
    // live: if the agent is mid-sentence, interrupt; otherwise end the session
    const last = transcript[transcript.length - 1];
    if (last?.role === "agent" && !last.final) v.interrupt();
    else void v.stop();
  };
  const [textOpen, setTextOpen] = useState(false);
  const [photo, setPhoto] = useState<File | null>(null);
  const voiceVideo = useStore((s) => s.voiceVideo);
  const cameraOpen = useStore((s) => s.cameraOpen);
  const sendFrame = useCallback((jpeg: string) => voice.current?.sendFrame(jpeg), []);
  const closeCamera = useCallback(() => useStore.getState().set({ cameraOpen: false }), []);

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
      <Toasts />
      <Pager pages={pages} />
      <TranscriptOverlay visible />
      <LinkPrompt />
      {cameraOpen && voiceVideo && <CameraPanel send={sendFrame} onClose={closeCamera} />}
      <BottomBar
        talk={talk}
        onTalk={onTalk}
        onText={() => setTextOpen(true)}
        onImage={setPhoto}
        camera={talk === "live" && voiceVideo ? { open: cameraOpen, onToggle: () => useStore.getState().set({ cameraOpen: !cameraOpen }) } : null}
      />
      <TextSheet open={textOpen} onClose={() => setTextOpen(false)} />
      <PhotoSheet file={photo} onClose={() => setPhoto(null)} />
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
