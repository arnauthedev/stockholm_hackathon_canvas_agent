import { useEffect, useState } from "react";
import { pairingLink } from "../lib/api.ts";

type BIPEvent = Event & { prompt(): Promise<void>; userChoice: Promise<{ outcome: string }> };

// The browser offers the install prompt once, early: keep it until Settings is opened.
let deferred: BIPEvent | null = null;
const listeners = new Set<() => void>();
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferred = e as BIPEvent;
  listeners.forEach((f) => f());
});

const standalone = () =>
  matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Settings row: one-tap install where supported, otherwise copy the pairing link for the home-screen app. */
export function InstallSetting() {
  const [bip, setBip] = useState(deferred);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const f = () => setBip(deferred);
    listeners.add(f);
    return () => void listeners.delete(f);
  }, []);
  if (standalone()) return null;
  return (
    <div className="setting setting-row">
      <div className="setting-label">
        Install app
        <small>
          {bip ? (
            "Full-screen app on this device."
          ) : (
            // The home-screen app gets its own storage on iOS: it pairs by pasting this link once.
            <>Copy the link, then <b>Share</b> → <b>Add to Home Screen</b>, open it and paste.</>
          )}
        </small>
      </div>
      {bip ? (
        <button className="btn primary" onClick={() => void bip.prompt().then(() => bip.userChoice).then(() => setBip((deferred = null)))}>Install</button>
      ) : (
        <button className="btn" onClick={() => void navigator.clipboard.writeText(pairingLink()).then(() => setCopied(true), () => {})}>
          {copied ? "Copied" : "Copy link"}
        </button>
      )}
    </div>
  );
}
