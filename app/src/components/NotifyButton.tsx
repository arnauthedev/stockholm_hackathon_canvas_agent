import { useEffect, useState } from "react";
import { disablePush, enablePush, pushState, testPush, type PushState } from "../lib/push.ts";
import { useStore } from "../lib/store.ts";

const HINT: Partial<Record<PushState, string>> = {
  "needs-install": "On iPhone, notifications work only for the installed app: Share → Add to Home Screen, then open it from there.",
  unsupported: "This browser doesn't support push notifications.",
  denied: "Notifications are blocked for this app — allow them in the system settings.",
};

/** Settings row control: enable / test / disable push notifications. */
export function NotifyButton() {
  const [state, setState] = useState<PushState | null>(null);
  useEffect(() => {
    void pushState().then(setState).catch(() => setState("unsupported"));
  }, []);
  const toast = useStore.getState().toast;
  const onTap = async () => {
    try {
      if (state === "on") {
        const r = await testPush();
        toast({ text: r.sent ? "Test notification sent" : "No device received it", kind: r.sent ? "success" : "warn" });
        return;
      }
      const s = await enablePush();
      setState(s);
      toast({ text: s === "on" ? "Notifications on" : (HINT[s] ?? "Notifications not enabled"), kind: s === "on" ? "success" : "warn" });
    } catch (e) {
      toast({ text: `Notifications: ${e instanceof Error ? e.message : String(e)}`, kind: "error" });
    }
  };
  if (!state) return null;
  return (
    <span className="notify">
      <button className={`chip ${state === "on" ? "on" : ""}`} onClick={() => void onTap()} title={state === "on" ? "Send a test notification" : "Enable notifications"}>
        {state === "on" ? "🔔 On" : "🔕 Notify"}
      </button>
      {state === "on" && <button className="chip ghost" aria-label="Turn notifications off" onClick={() => void disablePush().then(setState)}>✕</button>}
    </span>
  );
}
