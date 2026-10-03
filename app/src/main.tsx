import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Dashboard } from "./dashboard/Dashboard.tsx";
import { initMacShell, isMacShell } from "./lib/shell.ts";
import { keepFresh } from "./lib/update.ts";
import "./styles.css";

// Dev: only the push-only SW (no caching); leftover caching SWs from older sessions are removed.
if (import.meta.env.DEV && !isMacShell && "serviceWorker" in navigator) void import("./lib/push.ts").then((m) => m.swRegistration());
// Prod: reload into a new deploy as soon as its service worker takes over (not during a call).
if (import.meta.env.PROD && !isMacShell) keepFresh();
// Mac notch app: no service worker; the page reports its state to the native shell instead.
initMacShell();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname.startsWith("/dashboard") ? <Dashboard /> : <App />}
  </StrictMode>,
);
