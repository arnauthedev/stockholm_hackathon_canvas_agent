import { api } from "./api.ts";

/**
 * Web Push on the phone. iOS: only for the app installed to the Home Screen (iOS 16.4+),
 * and permission must be requested from a tap.
 */
export type PushState = "unsupported" | "needs-install" | "denied" | "off" | "on";

const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Dev: the push-only SW. Prod: the generated SW (which imports sw-push.js) is registered by vite-plugin-pwa. */
export async function swRegistration(): Promise<ServiceWorkerRegistration | null> {
  if (!("serviceWorker" in navigator)) return null;
  if (import.meta.env.DEV) {
    const regs = await navigator.serviceWorker.getRegistrations();
    // remove any caching SW left from older dev sessions; keep/attach the push-only one
    for (const r of regs) if (!r.active?.scriptURL.endsWith("/sw-push.js") && !r.installing?.scriptURL.endsWith("/sw-push.js")) await r.unregister();
    await navigator.serviceWorker.register("/sw-push.js");
  }
  return navigator.serviceWorker.ready;
}

export async function pushState(): Promise<PushState> {
  if (isIOS() && !standalone()) return "needs-install";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await swRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === "granted" ? "on" : "off";
}

function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Must be called from a user tap. */
export async function enablePush(): Promise<PushState> {
  const s = await pushState();
  if (s === "needs-install" || s === "unsupported" || s === "denied") return s;
  const perm = await Notification.requestPermission();
  if (perm !== "granted") return perm === "denied" ? "denied" : "off";
  const reg = await swRegistration();
  if (!reg) return "unsupported";
  const { publicKey } = await api<{ publicKey: string }>("/api/push/key");
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  await api("/api/push/subscribe", { method: "POST", json: { subscription: sub.toJSON() } });
  return "on";
}

export async function disablePush(): Promise<PushState> {
  const reg = await swRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) {
    await api("/api/push/unsubscribe", { method: "POST", json: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe();
  }
  return "off";
}

export const testPush = () => api<{ sent: number }>("/api/push/test", { method: "POST" });
