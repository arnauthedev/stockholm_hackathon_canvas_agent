import fs from "node:fs/promises";
import path from "node:path";
import { paths } from "./store.ts";

/** Append-only conversation log: sessions/<id>.jsonl */
export async function logSession(session_id: string, event: Record<string, unknown>) {
  const safe = session_id.replace(/[^a-zA-Z0-9_-]/g, "_");
  await fs.mkdir(paths.sessions, { recursive: true });
  await fs.appendFile(path.join(paths.sessions, `${safe}.jsonl`), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
}
