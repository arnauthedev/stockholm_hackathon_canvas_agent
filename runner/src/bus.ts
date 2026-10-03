import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { ClientEvent, type ServerEvent } from "@canvas-agent/contract";
import { env } from "./env.ts";

type Listener = (e: ClientEvent) => void;

/** WebSocket bus at /bus: state events → phone, UI events → runner. */
class Bus {
  private wss = new WebSocketServer({ noServer: true });
  private listeners = new Set<Listener>();
  private visible = new Map<WebSocket, boolean>();

  attach(server: Server) {
    server.on("upgrade", (req: IncomingMessage, socket, head) => {
      const url = new URL(req.url ?? "/", "http://x");
      if (url.pathname !== "/bus") return;
      if (url.searchParams.get("token") !== env.RUNNER_TOKEN) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws));
    });
    // keepalive so tunnels don't drop idle sockets
    setInterval(() => this.wss.clients.forEach((c) => c.readyState === WebSocket.OPEN && c.ping()), 25_000).unref();
  }

  private onConnection(ws: WebSocket) {
    ws.on("close", () => this.visible.delete(ws));
    this.sendTo(ws, { type: "hello", at: new Date().toISOString() });
    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      const parsed = ClientEvent.safeParse(msg);
      if (!parsed.success) return;
      if (parsed.data.type === "ping") return;
      if (parsed.data.type === "presence") {
        this.visible.set(ws, parsed.data.visible);
        return;
      }
      for (const l of this.listeners) l(parsed.data);
    });
  }

  private sendTo(ws: WebSocket, e: ServerEvent) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(e));
  }

  emit(e: ServerEvent) {
    const s = JSON.stringify(e);
    for (const c of this.wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
  }

  on(l: Listener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** True when some connected app reports it is in the foreground. */
  anyVisible() {
    for (const [ws, v] of this.visible) if (v && ws.readyState === WebSocket.OPEN) return true;
    return false;
  }

  get clients() {
    return this.wss.clients.size;
  }
}

export const bus = new Bus();
