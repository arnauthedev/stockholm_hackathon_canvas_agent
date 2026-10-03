import path from "node:path";
import WebSocket from "ws";
import { mergePatch, resolvePointer, type SourceRef } from "@canvas-agent/contract";
import { lock, now, readJson, writeJson } from "./fsutil.ts";

/**
 * Real-time sources over WebSocket. One connection per live widget; values are merged into
 * data.json at most every FLUSH_MS (the watcher pushes them to the phone), with reconnect +
 * backoff. Binance preset: public, no key — trades for the price, 24 h ticker for the change.
 */
const FLUSH_MS = 500;
export interface StreamHandle { stop(): void }

/** Drop a socket for good. Closing one that is still connecting emits "error"; with no listener left that would crash the runner. */
function discard(ws: WebSocket) {
  ws.removeAllListeners();
  ws.on("error", () => {});
  ws.close();
}

export function streamUrl(ref: SourceRef): string {
  const s = ref.stream ?? {};
  if (s.provider === "binance") {
    const sym = String(s.symbol ?? "BTCUSDT").toLowerCase().replace(/[^a-z0-9]/g, "");
    return `wss://stream.binance.com:9443/stream?streams=${sym}@aggTrade/${sym}@ticker`;
  }
  return String(s.url ?? ref.entry);
}

/** Turn one message into a data patch (null = nothing useful in it). */
export function toPatch(ref: SourceRef, raw: unknown): Record<string, unknown> | null {
  const s = ref.stream ?? {};
  if (s.provider === "binance") {
    const d = ((raw as { data?: Record<string, string> }).data ?? raw) as Record<string, string>;
    const sym = String(s.symbol ?? "BTCUSDT").toUpperCase();
    const quote = sym.endsWith("USDT") ? "USDT" : sym.endsWith("EUR") ? "EUR" : sym.endsWith("BTC") ? "BTC" : "";
    if (d.e === "aggTrade") return { price: Number(Number(d.p).toFixed(2)), symbol: sym, currency: quote, note: "Live · Binance" };
    if (d.e === "24hrTicker") {
      const pct = Number(d.P);
      return { change_pct: `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`, change: Number(Number(d.p).toFixed(2)), trend: pct > 0 ? "up" : pct < 0 ? "down" : "flat", high: Number(d.h), low: Number(d.l), price: Number(Number(d.c).toFixed(2)), symbol: sym, currency: quote };
    }
    return null;
  }
  if (!s.map) return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  const out: Record<string, unknown> = {};
  for (const [field, ptr] of Object.entries(s.map)) {
    const v = resolvePointer(raw, ptr);
    if (v !== undefined) out[field] = v;
  }
  return Object.keys(out).length ? out : null;
}

export function startStream(dir: string, ref: SourceRef, onFlush?: (data: unknown) => void, onState?: (ok: boolean, err?: string) => void): StreamHandle {
  let ws: WebSocket | null = null;
  let stopped = false;
  let retry = 0;
  let pending: Record<string, unknown> | null = null;
  const flusher = setInterval(() => void flush(), FLUSH_MS);

  async function flush() {
    if (!pending) return;
    const patch = { ...pending, updated_at: now() };
    pending = null;
    await lock(`data:${dir}`, async () => {
      const file = path.join(dir, "data.json");
      const data = mergePatch((await readJson(file)) ?? {}, patch);
      await writeJson(file, data);
      onFlush?.(data);
    });
  }

  function connect() {
    if (stopped) return;
    ws = new WebSocket(streamUrl(ref));
    ws.on("open", () => {
      retry = 0;
      onState?.(true);
      if (ref.stream?.subscribe !== undefined) ws?.send(typeof ref.stream.subscribe === "string" ? ref.stream.subscribe : JSON.stringify(ref.stream.subscribe));
    });
    ws.on("message", (m) => {
      try {
        const p = toPatch(ref, JSON.parse(String(m)));
        if (p) pending = { ...(pending ?? {}), ...p };
      } catch {}
    });
    const reconnect = (why: string) => {
      if (stopped) return;
      onState?.(false, why);
      const wait = Math.min(30_000, 1000 * 2 ** retry++);
      setTimeout(connect, wait);
    };
    ws.on("close", () => reconnect("closed"));
    ws.on("error", (e) => {
      ws?.removeAllListeners("close");
      reconnect(String(e.message ?? e));
    });
  }
  connect();
  return {
    stop() {
      stopped = true;
      clearInterval(flusher);
      if (ws) discard(ws);
    },
  };
}

/** One value right away (make_live's first run): connect, take the first useful message, close. */
export function firstValue(ref: SourceRef, timeoutMs = 8000): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(streamUrl(ref));
    let acc: Record<string, unknown> | null = null;
    const done = (v: Record<string, unknown> | null) => {
      clearTimeout(t);
      discard(ws);
      resolve(v);
    };
    const t = setTimeout(() => done(acc), timeoutMs);
    ws.on("open", () => {
      if (ref.stream?.subscribe !== undefined) ws.send(typeof ref.stream.subscribe === "string" ? ref.stream.subscribe : JSON.stringify(ref.stream.subscribe));
    });
    ws.on("message", (m) => {
      try {
        const p = toPatch(ref, JSON.parse(String(m)));
        if (p) acc = { ...(acc ?? {}), ...p };
        if (acc && "price" in acc && (ref.stream?.provider !== "binance" || "change_pct" in acc)) done(acc);
        else if (acc && ref.stream?.provider !== "binance") done(acc);
      } catch {}
    });
    ws.on("error", () => done(acc));
  });
}
