// Shared helpers for the e2e regression harness.
// Everything runs against an ISOLATED runner (own port, fresh agent-home copy, built app),
// so the user's data and dev stack are never touched. Child processes are tracked by PID
// and stopped individually (never by name/pattern).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const E2E = path.join(ROOT, "tests", "e2e");
export const CACHE = path.join(E2E, ".cache");
export const WORK = path.join(E2E, ".work");
export const PORT = Number(process.env.E2E_PORT || 18790);
export const BASE = `http://127.0.0.1:${PORT}`;
export const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Read the repo .env without exporting it into this process. */
export function readEnv() {
  const out = {};
  const f = path.join(ROOT, ".env");
  if (!existsSync(f)) return out;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}
export const ENV = readEnv();
export const TOKEN = ENV.RUNNER_TOKEN;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function api(p, { method = "GET", json, timeout = 180_000 } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, ...(json !== undefined ? { "content-type": "application/json" } : {}) },
    body: json !== undefined ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(timeout),
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, text };
  }
}
export const tool = (name, args = {}) => api(`/api/tools/${name}`, { method: "POST", json: args });
export const chat = (text, session_id) => api("/api/chat", { method: "POST", json: { text, session_id, wait: true }, timeout: 240_000 });

export async function waitFor(fn, { timeout = 60_000, every = 500, label = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => undefined);
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${label}`);
    await sleep(every);
  }
}

/** Fresh isolated agent-home from the committed template. */
export async function freshHome(tag) {
  const dir = path.join(WORK, `home-${tag}-${Date.now()}`);
  await fs.mkdir(WORK, { recursive: true });
  await fs.cp(path.join(ROOT, "templates", "agent-home"), dir, { recursive: true });
  return dir;
}
export const homeFile = (home, rel) => path.join(home, rel);
export const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
export const readJsonSafe = (f) => {
  try {
    return readJson(f);
  } catch {
    return null;
  }
};

/** Start the isolated runner (serves app/dist). Returns {home, stop, logFile}. */
export async function startRunner({ home, extraEnv = {} } = {}) {
  home ??= await freshHome("run");
  const logFile = path.join(WORK, `runner-${Date.now()}.log`);
  const log = await fs.open(logFile, "w");
  const child = spawn(path.join(ROOT, "runner", "node_modules", ".bin", "tsx"), ["src/main.ts"], {
    cwd: path.join(ROOT, "runner"),
    env: { ...process.env, PORT: String(PORT), AGENT_HOME: home, HOST: "127.0.0.1", ...extraEnv },
    stdio: ["ignore", log.fd, log.fd],
  });
  const stop = async () => {
    if (child.exitCode == null) {
      child.kill("SIGTERM"); // our own child, by PID
      await Promise.race([new Promise((r) => child.once("exit", r)), sleep(4000)]);
      if (child.exitCode == null) child.kill("SIGKILL");
    }
    await log.close().catch(() => {});
  };
  try {
    await waitFor(async () => (await api("/api/health", { timeout: 2000 })).ok, { timeout: 40_000, label: "isolated runner" });
  } catch (e) {
    await stop();
    throw new Error(`runner failed to start; see ${logFile}\n${readFileSync(logFile, "utf8").slice(-1500)}`);
  }
  return { home, stop, logFile, pid: child.pid };
}

/** TTS → WAV (cached) with silence padding; used as a fake microphone. */
export async function speechWav(name, parts) {
  await fs.mkdir(CACHE, { recursive: true });
  const out = path.join(CACHE, `${name}.wav`);
  if (existsSync(out)) return out;
  const bufs = [];
  let header = null;
  let rate = 24000;
  for (const p of parts) {
    if (typeof p === "number") {
      bufs.push(Buffer.alloc(Math.round(rate * p) * 2));
      continue;
    }
    const cacheKey = path.join(CACHE, `tts-${Buffer.from(p).toString("base64url").slice(0, 60)}.wav`);
    let b;
    if (existsSync(cacheKey)) b = readFileSync(cacheKey);
    else {
      const res = await fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { authorization: `Bearer ${ENV.OPENAI_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "coral", input: p, response_format: "wav" }),
      });
      if (!res.ok) throw new Error(`TTS failed: ${res.status}`);
      b = Buffer.from(await res.arrayBuffer());
      writeFileSync(cacheKey, b);
    }
    rate = b.readUInt32LE(24);
    header ??= Buffer.from(b.subarray(0, 44));
    bufs.push(b.subarray(b.indexOf("data") + 8));
  }
  const data = Buffer.concat(bufs);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  header.writeUInt32LE(36 + data.length, 4);
  writeFileSync(out, Buffer.concat([header, data]));
  return out;
}

/** Browser page acting as the phone. `micWav` makes it a voice-capable phone. */
export async function phone({ micWav, persistentDir } = {}) {
  const { chromium, devices } = await import("playwright-core");
  const args = ["--autoplay-policy=no-user-gesture-required"];
  if (micWav) args.push("--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${micWav}%noloop`);
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args });
  const context = await browser.newContext({ ...devices["iPhone 13"], permissions: micWav ? ["microphone"] : [] });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const events = [];
  page.on("websocket", (ws) =>
    ws.on("framereceived", (f) => {
      try {
        events.push({ t: Date.now(), ...JSON.parse(f.payload) });
      } catch {}
    }),
  );
  await page.goto(`${BASE}/#token=${TOKEN}`);
  await page.waitForSelector(".conn.ok", { timeout: 20_000 });
  return { browser, context, page, errors, events, close: () => browser.close() };
}

/** Start a voice session on the phone page and wait until live. */
export async function startVoice(page) {
  await page.click(".talk-btn");
  await page.waitForFunction(() => document.querySelector(".talk-btn")?.classList.contains("live"), null, { timeout: 20_000 });
}
export async function stopVoice(page) {
  for (let i = 0; i < 3; i++) {
    const live = await page.locator(".talk-btn.live").count();
    if (!live) return;
    await page.click(".talk-btn").catch(() => {});
    await sleep(900);
  }
}
// only the voice session's own lines (session ids start with "live_"), not stray text-brain transcripts
export const finals = (events, role) => events.filter((e) => e.type === "transcript" && e.final && String(e.session_id ?? "").startsWith("live_") && (!role || e.role === role));
