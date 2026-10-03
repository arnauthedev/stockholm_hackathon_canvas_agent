import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { injectActive, textTurn, textSession, hasLiveVoice } from "./brain.ts";
import { paths } from "./store.ts";

const MAX_BYTES = 8 * 1024 * 1024;
const TYPES: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/heic": "heic", "image/gif": "gif" };

/**
 * Camera/gallery upload (B8/B9): stored under agent-home/uploads with an unguessable name
 * (served at /files/uploads/<name> so <img> tags work without the token), then sent to the
 * brain as an image turn on the vision route. If a voice session is live, the answer is
 * also injected so the voice agent speaks it.
 */
export async function handleUpload(file: File, question: string | undefined, session_id: string | undefined) {
  if (file.size > MAX_BYTES) return { error: "image too large (max 8 MB)" };
  const ext = TYPES[file.type];
  if (!ext) return { error: `unsupported type ${file.type || "unknown"}` };
  const name = `${Date.now()}-${randomBytes(16).toString("hex")}.${ext}`;
  const buf = Buffer.from(await file.arrayBuffer());
  await fs.mkdir(paths.uploads, { recursive: true });
  await fs.writeFile(path.join(paths.uploads, name), buf);
  const url = `/files/uploads/${name}`;
  const sid = textSession(session_id);
  const q = question?.trim() || "What is this? Help me with it.";
  void (async () => {
    const text = await textTurn(
      sid,
      [
        { type: "text", text: `${q}\n(The user just took/chose this photo. If showing it helps, use an Image component with src "${url}".)` },
        { type: "image", image: buf, mediaType: file.type },
      ],
      { job: "vision", display: `📷 ${q}` },
    );
    if (text && hasLiveVoice()) injectActive(`The user sent a photo ("${q}"). The backend answered: ${text}`);
  })();
  return { ok: true, url, session_id: sid };
}

export async function serveUpload(name: string): Promise<{ body: Buffer; type: string } | null> {
  if (!/^[\w-]+\.(jpg|png|webp|heic|gif)$/.test(name)) return null;
  try {
    const body = await fs.readFile(path.join(paths.uploads, name));
    const ext = name.split(".").pop()!;
    const type = Object.entries(TYPES).find(([, e]) => e === ext)?.[0] ?? "application/octet-stream";
    return { body, type };
  } catch {
    return null;
  }
}
