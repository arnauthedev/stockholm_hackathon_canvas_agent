import { useCallback, useEffect, useRef, useState } from "react";
import { BottomBar, type TalkState } from "./components/BottomBar.tsx";
import { CameraPanel } from "./components/CameraPanel.tsx";
import { CanvasLayer } from "./components/CanvasView.tsx";
import { LinkPrompt, ModalSheet, Toasts, TranscriptOverlay } from "./components/Overlay.tsx";
import { Pager } from "./components/Pager.tsx";
import { ScreenView } from "./components/ScreensView.tsx";
import { TasksSheet } from "./components/TasksView.tsx";
import { TextSheet } from "./components/TextSheet.tsx";
import { PhotoSheet } from "./components/PhotoSheet.tsx";
import { SettingsSheet } from "./components/SettingsSheet.tsx";
import { pairWith, token } from "./lib/api.ts";
import { connectBus } from "./lib/bus.ts";
import { unlockAudio } from "./lib/sound.ts";
import { useStore } from "./lib/store.ts";
import { applyTheme } from "./lib/theme.ts";
import { PhoneVoice, type CallMode } from "./lib/voice.ts";

export function App() {
  const theme = useStore((s) => s.theme);
  const screens = useStore((s) => s.screens);
  const canvasOpen = useStore((s) => s.canvasOpen);
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
      if (h.startsWith("task=")) s.set({ tasksOpen: true });
      else if (h.startsWith("app=")) {
        const slug = decodeURIComponent(h.slice(4));
        const i = s.screens?.screens.findIndex((sc) => sc.id === s.apps[slug]?.app.screen) ?? -1;
        s.set({ page: Math.max(i, 0), canvasOpen: false });
      } // #approval: the approval sheet shows over whatever is on screen
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
  const pages = screenList.map((s, i) => ({ key: s.id, label: `Screen ${i + 1}`, node: <ScreenView screenId={s.id} /> }));
  // the buttons belong to the canvas; on the home screens they show only while a call is up
  const inCall = call === "connecting" || call === "live";
  const pullTalk = () => {
    if (inCall) return;
    unlockAudio();
    onCall("voice");
  };

  return (
    <div className={`app ${canvasOpen ? "canvas-open" : "home"}`}>
      <TopBar onSettings={() => setSettingsOpen(true)} />
      <Toasts />
      <Pager pages={pages} onPullTalk={pullTalk} />
      <CanvasLayer />
      <TranscriptOverlay visible />
      <LinkPrompt />
      {cameraOpen && voiceVideo && <CameraPanel send={sendFrame} onClose={closeCamera} />}
      <BottomBar
        away={!canvasOpen && !inCall}
        talk={mode === "voice" ? call : "idle"}
        onTalk={() => onCall("voice")}
        vision={mode === "vision" ? call : "idle"}
        onVision={() => onCall("vision")}
        onText={() => setTextOpen(true)}
        onImage={setPhoto}
      />
      <TextSheet open={textOpen} onClose={() => setTextOpen(false)} />
      <PhotoSheet file={photo} onClose={() => setPhoto(null)} />
      <TasksSheet />
      {settingsOpen && <SettingsSheet onClose={() => setSettingsOpen(false)} />}
      <ModalSheet />
    </div>
  );
}

// touch devices open/close the canvas by swiping; mouse and trackpad get a top-bar button
const coarse = matchMedia("(pointer: coarse)").matches;

/** Top-left buttons: settings, tasks with a badge for open ones (red when something needs you), canvas toggle without touch. */
function TopBar({ onSettings }: { onSettings(): void }) {
  const connected = useStore((s) => s.connected);
  const tasks = Object.values(useStore((s) => s.tasks));
  const open = tasks.filter((t) => !["done", "cancelled", "failed"].includes(t.task.status)).length;
  const needsYou = tasks.some((t) => t.task.status === "waiting_user");
  const canvasOpen = useStore((s) => s.canvasOpen);
  return (
    <>
      <div className={connected ? "conn ok" : "conn"} title={connected ? "Connected" : "Offline"} />
      <div className="top-btns">
        <button className="top-btn" aria-label="Settings" title="Settings" onClick={onSettings}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
            <circle cx="15" cy="7" r="2" />
            <circle cx="9" cy="17" r="2" />
          </svg>
        </button>
        <button className="top-btn" aria-label={`Tasks${open ? `, ${open} open` : ""}`} title="Tasks" onClick={() => useStore.getState().set({ tasksOpen: true })}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m3 6 2 2 3-3M3 16l2 2 3-3M12 7h9M12 17h9" />
          </svg>
          {open > 0 && <span className={`top-badge ${needsYou ? "alert" : ""}`}>{open}</span>}
        </button>
        {!coarse && (
          <button className="top-btn" aria-label={canvasOpen ? "Back to screens" : "Open the canvas"} title={canvasOpen ? "Back to screens" : "Open the canvas"} aria-pressed={canvasOpen} onClick={() => useStore.getState().set({ canvasOpen: !canvasOpen })}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              {canvasOpen ? <path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" /> : <path d="M4 5h16v14H4zM8 9h8M8 13h5" />}
            </svg>
          </button>
        )}
      </div>
    </>
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
