import { useEffect, useRef, useState } from "react";
import { useStore } from "../lib/store.ts";
import { openLink } from "../lib/links.ts";
import { ApprovalCard } from "../catalog/ApprovalCard.tsx";
import { Ctx } from "../catalog/context.ts";

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
    </div>
  );
}

const IDLE_OPEN_MS = 4000;

export function ModalSheet() {
  const modals = useStore((s) => s.modals);
  const voiceLive = useStore((s) => s.voiceLive);
  const trayOpen = useStore((s) => s.trayOpen);
  const trayDismissed = useStore((s) => s.trayDismissed);
  // during a voice call: a compact pill; the sheet opens on a definite signal —
  // conversation idle, a voice edit/approval/focus (store sets trayOpen), or the call ending
  useEffect(() => {
    if (!voiceLive || trayOpen || trayDismissed || !modals.length) return;
    const t = setInterval(() => {
      const s = useStore.getState();
      if (Date.now() - s.lastTalkAt > IDLE_OPEN_MS) s.set({ trayOpen: true });
    }, 500);
    return () => clearInterval(t);
  }, [voiceLive, trayOpen, trayDismissed, modals.length]);
  const m = modals[0];
  if (!m) return null;
  if (voiceLive && !trayOpen) {
    return (
      <button className="approval-pill" onClick={() => useStore.getState().set({ trayOpen: true })}>
        ✋ {modals.length === 1 ? `${String(m.card.title ?? "1 needs your OK")}` : `${modals.length} need your OK`}
      </button>
    );
  }
  const close = () => useStore.getState().set({ modals: useStore.getState().modals.filter((x) => x.approval_id !== m.approval_id) });
  const card = m.card as Record<string, never>;
  return (
    <div className="sheet-backdrop">
      <div className="sheet" role="dialog" aria-modal="true">
        <div className="sheet-grip" />
        {voiceLive && <button className="btn ghost sheet-min" aria-label="Minimize" onClick={() => useStore.getState().set({ trayOpen: false, trayDismissed: true })}>⌄</button>}
        {modals.length > 1 && <div className="sheet-count">1 of {modals.length}</div>}
        <Ctx.Provider value={{}}>
          <ApprovalCard key={m.approval_id} id={m.approval_id} approval_id={m.approval_id} {...card} committingUntil={m.committingUntil} onDone={() => setTimeout(close, 500)} />
        </Ctx.Provider>
      </div>
    </div>
  );
}

export function LinkPrompt() {
  const link = useStore((s) => s.link);
  if (!link) return null;
  const close = () => useStore.getState().set({ link: null });
  const label = { maps: "Open in Maps", tel: "Call", mailto: "Open Mail", web: "Open link" }[link.kind] ?? "Open link";
  return (
    <div className="link-prompt">
      <span className="link-prompt-href">{link.href.replace(/^https?:\/\//, "").slice(0, 48)}</span>
      <button className="btn primary" onClick={() => (openLink(link.href), close())}>{label}</button>
      <button className="btn ghost" aria-label="Dismiss" onClick={close}>✕</button>
    </div>
  );
}

const LINGER_MS = 8000;

/** Live transcript bubbles; final lines fade out after a few seconds so the canvas stays visible. */
export function TranscriptOverlay({ visible }: { visible: boolean }) {
  const lines = useStore((s) => s.transcript);
  const [now, setNow] = useState(Date.now());
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
    const t = setTimeout(() => setNow(Date.now()), LINGER_MS + 50);
    return () => clearTimeout(t);
  }, [lines]);
  const shown = lines.filter((l) => !l.final || now - l.at < LINGER_MS || Date.now() - l.at < LINGER_MS).slice(-3);
  if (!visible || !shown.length) return null;
  return (
    <div className="transcript" ref={ref}>
      {shown.map((l) => (
        <div key={l.id} className={`tl ${l.role} ${l.final ? "" : "partial"}`}>{l.text}</div>
      ))}
    </div>
  );
}
