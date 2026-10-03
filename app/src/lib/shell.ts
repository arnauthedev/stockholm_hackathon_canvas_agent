import { setShellVisible } from "./bus.ts";
import { useStore } from "./store.ts";

/** Inside the Mac notch app (mac/): a WKWebView with its own user agent. `?mac` fakes it in a desktop browser. */
/** A runner restart in dev (tsx watch) is back in 1–3 s; a deploy is away far longer. */
const DEPLOY_GAP_MS = 8000;

export const isMacShell = /CanvasAgentMac/.test(navigator.userAgent) || new URLSearchParams(location.search).has("mac");

type Bridge = { postMessage(msg: unknown): void };
const bridge = () => (window as Window & { webkit?: { messageHandlers?: { shell?: Bridge } } }).webkit?.messageHandlers?.shell;

/**
 * Mac notch mode. The native shell is thin: the page tells it whether the runner is connected and a call is
 * live (the folded pill shows a dot) and whether the user is typing (the panel then stays open while the mouse
 * wanders). The page stays visible to WebKit while folded (so the connection and a call carry on), so the shell
 * says when it is folded and that becomes the presence the runner uses for notifications. A WKWebView has no
 * service worker, so a deploy — the runner gone for several seconds, then back — reloads the page instead, once no
 * call is live.
 */
export function initMacShell() {
  if (!isMacShell) return;
  document.documentElement.classList.add("shell-mac");
  let editing = false;
  const post = () => {
    const s = useStore.getState();
    bridge()?.postMessage({ type: "state", connected: s.connected, live: s.voiceLive, editing, handlesEsc: true, visibility: document.visibilityState });
  };
  document.addEventListener("visibilitychange", post);
  window.addEventListener("shell:folded", (e) => setShellVisible(!(e as CustomEvent<boolean>).detail));
  const isField = (t: EventTarget | null) =>
    t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable);
  document.addEventListener("focusin", (e) => {
    if (!isField(e.target)) return;
    editing = true;
    post();
  });
  document.addEventListener("focusout", (e) => {
    if (!isField(e.target)) return;
    editing = false;
    post();
  });
  // Escape: a sheet or the canvas closes itself (their own listeners run after this one, so the check sees
  // the state before they act); with nothing open, the panel folds. Old shells intercept Esc natively instead.
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    if (document.querySelector(".sheet-backdrop") || useStore.getState().canvasOpen) return;
    bridge()?.postMessage({ type: "fold" });
  });
  let was = { connected: false, live: false };
  let droppedAt = 0;
  useStore.subscribe((s) => {
    if (s.connected === was.connected && s.voiceLive === was.live) return;
    if (was.connected && !s.connected) droppedAt = Date.now();
    if (!was.connected && s.connected && droppedAt && Date.now() - droppedAt > DEPLOY_GAP_MS) reloadWhenQuiet();
    was = { connected: s.connected, live: s.voiceLive };
    post();
  });
  post();
}

function reloadWhenQuiet() {
  if (!useStore.getState().voiceLive) return location.reload();
  const stop = useStore.subscribe((s) => {
    if (s.voiceLive) return;
    stop();
    location.reload();
  });
}
