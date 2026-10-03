import { useStore } from "./store.ts";

/**
 * Production: show a deploy without relaunching the app twice. The generated service worker skips
 * waiting and claims open pages, so a new version takes control in the background; reload then, but
 * never in the middle of a call. iOS resumes Home Screen apps instead of relaunching them, so also
 * look for a new service worker every time the app comes back to the foreground.
 */
export function keepFresh() {
  if (!("serviceWorker" in navigator)) return;
  const hadController = !!navigator.serviceWorker.controller; // first install: nothing old to replace
  let waiting = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) return;
    if (!useStore.getState().voiceLive) return location.reload();
    if (waiting) return;
    waiting = true;
    const unsubscribe = useStore.subscribe((s) => {
      if (s.voiceLive) return;
      unsubscribe();
      location.reload();
    });
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    void navigator.serviceWorker
      .getRegistration()
      .then((r) => r?.update())
      .catch(() => {});
  });
}
