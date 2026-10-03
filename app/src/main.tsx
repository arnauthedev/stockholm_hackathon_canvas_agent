import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { Dashboard } from "./dashboard/Dashboard.tsx";
import { keepFresh } from "./lib/update.ts";
import "./styles.css";

// Dev: only the push-only SW (no caching); leftover caching SWs from older sessions are removed.
if (import.meta.env.DEV && "serviceWorker" in navigator) void import("./lib/push.ts").then((m) => m.swRegistration());
// Prod: reload into a new deploy as soon as its service worker takes over (not during a call).
if (import.meta.env.PROD) keepFresh();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {location.pathname.startsWith("/dashboard") ? <Dashboard /> : <App />}
  </StrictMode>,
);
