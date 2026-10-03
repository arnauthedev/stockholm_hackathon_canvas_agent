import type { ServerEvent, StateSnapshot, UiAction, UiEvent } from "@canvas-agent/contract";
import { api, token } from "./api.ts";
import { useStore } from "./store.ts";

let ws: WebSocket | null = null;
let retry = 0;

/** One WS to /bus with auto-reconnect; on connect, GET /api/state to rehydrate. */
export function connectBus() {
  if (ws && ws.readyState <= WebSocket.OPEN) return; // one socket (StrictMode runs effects twice)
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/bus?token=${encodeURIComponent(token)}`);
  ws.onopen = async () => {
    retry = 0;
    sendPresence();
    useStore.getState().set({ connected: true });
    try {
      useStore.getState().hydrate(await api<StateSnapshot>("/api/state"));
    } catch (err) {
      console.warn("rehydrate failed", err);
    }
  };
  ws.onmessage = (m) => {
    try {
      useStore.getState().apply(JSON.parse(m.data) as ServerEvent);
    } catch (err) {
      console.warn("bad event", err);
    }
  };
  ws.onclose = () => {
    useStore.getState().set({ connected: false });
    const delay = Math.min(15_000, 500 * 2 ** retry++);
    setTimeout(connectBus, delay);
  };
}

export function sendUiAction(e: Omit<UiAction, "type">) {
  const msg: UiAction = { type: "ui.action", ...e };
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

export function sendUiEvent(e: Omit<UiEvent, "type" | "at">) {
  const msg: UiEvent = { type: "ui.event", at: new Date().toISOString(), ...e };
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Tell the runner whether the app is in the foreground (pushes are skipped while it is). */
function sendPresence() {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "presence", visible: document.visibilityState === "visible" }));
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ws && ws.readyState > WebSocket.OPEN) connectBus();
  sendPresence();
});
