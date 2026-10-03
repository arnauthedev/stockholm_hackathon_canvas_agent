/** Pairing token + REST helpers. The token arrives once via `#token=…` and is kept in localStorage. */
const KEY = "canvas-agent.token";

function readToken(): string {
  const m = location.hash.match(/token=([^&#]+)/);
  if (m?.[1]) {
    try {
      localStorage.setItem(KEY, decodeURIComponent(m[1]));
    } catch {}
    history.replaceState(null, "", location.pathname + location.search);
  }
  try {
    return localStorage.getItem(KEY) ?? "";
  } catch {
    return "";
  }
}

export const token = readToken();

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const res = await fetch(path, { ...init, headers, body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export const callTool = (name: string, args: unknown) => api(`/api/tools/${name}`, { method: "POST", json: args });
