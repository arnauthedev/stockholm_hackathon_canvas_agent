import { useStore } from "./store.ts";

/** Inside the Mac notch app (mac/): a WKWebView with its own user agent. `?mac` fakes it in a desktop browser. */
export const isMacShell = /CanvasAgentMac/.test(navigator.userAgent) || new URLSearchParams(location.search).has("mac");

type Bridge = { postMessage(msg: unknown): void };
const bridge = () => (window as Window & { webkit?: { messageHandlers?: { shell?: Bridge } } }).webkit?.messageHandlers?.shell;

/**
 * Mac notch mode. The native shell is thin: the page tells it whether the runner is connected and a call is
 * live (the folded pill shows a dot) and whether the user is typing (the panel then stays open while the mouse
 * wanders). A WKWebView has no service worker, so a deploy — the runner gone for a few seconds, then back —
 * reloads the page instead, once no call is live.
 */
export function initMacShell() {
  if (!isMacShell) return;
  document.documentElement.classList.add("shell-mac");
  let editing = false;
  const post = () => {
    const s = useStore.getState();
    bridge()?.postMessage({ type: "state", connected: s.connected, live: s.voiceLive, editing });
  };
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
  let was = { connected: false, live: false };
  let droppedAt = 0;
  useStore.subscribe((s) => {
    if (s.connected === was.connected && s.voiceLive === was.live) return;
    if (was.connected && !s.connected) droppedAt = Date.now();
    if (!was.connected && s.connected && droppedAt && Date.now() - droppedAt > 3000) reloadWhenQuiet();
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
