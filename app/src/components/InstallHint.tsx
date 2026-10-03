import { useEffect, useState } from "react";
import { pairingLink } from "../lib/api.ts";

const KEY = "canvas-agent.install-dismissed";
type BIPEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

const standalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

/** "Add to Home Screen" hint: one-tap install where supported, instructions on iOS. */
export function InstallHint() {
  const [bip, setBip] = useState<BIPEvent | null>(null);
  const [copied, setCopied] = useState(false);
  const [hidden, setHidden] = useState(() => {
    try {
      return standalone() || localStorage.getItem(KEY) === "1";
    } catch {
      return standalone();
    }
  });
  useEffect(() => {
    const on = (e: Event) => (e.preventDefault(), setBip(e as BIPEvent));
    window.addEventListener("beforeinstallprompt", on);
    return () => window.removeEventListener("beforeinstallprompt", on);
  }, []);
  if (hidden || (!bip && !isIOS())) return null;
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, "1");
    } catch {}
    setHidden(true);
  };
  return (
    <div className="install-hint">
      <span>
        {bip ? (
          "Install Canvas on this device for a full-screen app."
        ) : (
          // The home-screen app gets its own storage on iOS: it pairs by pasting this link once.
          <>Install: tap <b>Copy link</b>, then <b>Share</b> <span aria-hidden>⬆︎</span> → <b>Add to Home Screen</b>, open it and paste.</>
        )}
      </span>
      {!bip && (
        <button className="btn small" onClick={() => void navigator.clipboard.writeText(pairingLink()).then(() => setCopied(true), () => {})}>
          {copied ? "Copied" : "Copy link"}
        </button>
      )}
      {bip && (
        <button className="btn primary" onClick={() => void bip.prompt().then(() => bip.userChoice).then(dismiss)}>Install</button>
      )}
      <button className="btn ghost" aria-label="Dismiss" onClick={dismiss}>✕</button>
    </div>
  );
}
