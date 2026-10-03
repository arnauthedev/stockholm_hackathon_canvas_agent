import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../lib/store.ts";
import { useRenderCtx } from "./context.ts";

/**
 * Custom card: a page a sub-agent wrote, run in a sandboxed iframe. `allow-scripts` without
 * `allow-same-origin` gives it an opaque origin (no token, storage or app DOM), and its CSP blocks the
 * network except this app's generated pictures (/files/images/), so the data only arrives from us: inlined at start, then posted on every update (live widgets).
 * It reports its height so the card fits its content on the canvas; in a pinned widget it is scaled
 * down to fit the slot when the page is taller.
 */
const THEME_VARS = ["--bg", "--surface", "--surface2", "--text", "--muted", "--accent", "--accent-text", "--border", "--danger", "--success"];
// Pictures may come only from this app's generated-image folder (generate_image with field); no other network.
const csp = () => `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: ${location.origin}/files/images/; font-src data:; media-src data: blob:`;

const json = (v: unknown) => JSON.stringify(v ?? {}).replace(/</g, "\\u003c"); // safe inside <script>

function runtime(data: unknown) {
  return `<script>(() => {
  // the sandbox has no storage (opaque origin): reading localStorage would throw, so pages get an in-memory one
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => void m.set(k, String(v)), removeItem: (k) => void m.delete(k), clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null, get length() { return m.size; } }; };
  for (const k of ["localStorage", "sessionStorage"]) { try { Object.defineProperty(window, k, { value: mem(), configurable: true }); } catch {} }
  let data = ${json(data)};
  const subs = [];
  window.card = {
    get data() { return data; },
    onData(fn) { subs.push(fn); try { fn(data); } catch (e) { report(e); } },
  };
  const report = (e) => parent.postMessage({ type: "error", message: String((e && e.message) || e) }, "*");
  addEventListener("error", (e) => report(e.error || e.message));
  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || e.data.type !== "data") return;
    data = e.data.data || {};
    for (const fn of subs) { try { fn(data); } catch (err) { report(err); } }
  });
  const height = () => parent.postMessage({ type: "height", h: Math.ceil(document.documentElement.getBoundingClientRect().height) }, "*");
  addEventListener("load", () => { height(); new ResizeObserver(height).observe(document.documentElement); });
})();</script>`;
}

export function CustomCard({ html, data }: { html?: string; data: unknown }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const { app_id, size } = useRenderCtx();
  const fill = !!(app_id && size); // a pinned widget: fit its slot
  const theme = useStore((s) => s.theme);
  const [height, setHeight] = useState(240);
  const [error, setError] = useState<string | null>(null);
  const first = useRef(data);
  const box = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState(0);

  // Rebuilt only when the page or the theme changes; data updates go in by postMessage (no reload).
  const doc = useMemo(() => {
    const css = getComputedStyle(document.documentElement);
    const vars = THEME_VARS.map((v) => `${v}:${css.getPropertyValue(v).trim()}`).join(";");
    return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp()}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>:root{${vars}}html,body{margin:0;background:transparent;color:var(--text);font:15px/1.4 -apple-system,system-ui,sans-serif;overflow-x:hidden}img,svg,video,canvas{max-width:100%}img{height:auto}</style>
${runtime(first.current)}</head><body>${html ?? ""}</body></html>`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, theme]);

  useEffect(() => setError(null), [doc]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || !e.data) return;
      if (e.data.type === "height" && typeof e.data.h === "number") setHeight(Math.min(Math.max(e.data.h, 60), 1200));
      if (e.data.type === "error") setError(String(e.data.message).slice(0, 160));
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, []);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ type: "data", data }, "*");
  }, [data]);
  useEffect(() => {
    if (!fill || !box.current) return;
    const ro = new ResizeObserver(([e]) => e && setSlot(e.contentRect.height));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, [fill]);
  const scale = fill && slot && height > slot ? slot / height : 1;

  if (!html) return <div className="c-unsupported">This custom card is empty.</div>;
  return (
    <div ref={box} className={fill ? "c-custom fill" : "c-custom"}>
      <iframe
        ref={frame}
        title="Custom card"
        sandbox="allow-scripts"
        srcDoc={doc}
        style={{ height, ...(scale < 1 ? { width: `${100 / scale}%`, transform: `scale(${scale})`, transformOrigin: "top left" } : {}) }}
      />
      {error && <div className="c-unsupported">Custom card error: {error}</div>}
    </div>
  );
}
