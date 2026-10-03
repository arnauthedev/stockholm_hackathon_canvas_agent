import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root, derived from this file's location (no machine-specific paths). */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const envFile = path.join(REPO_ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const abs = (p: string) => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

function validTimezone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz });
    return tz;
  } catch {
    console.warn(`[runner] TIMEZONE "${tz}" is not a valid IANA zone; using the machine's`);
    return undefined;
  }
}

export const env = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "",
  // Gemini (realtime voice when routes.voice is google). GOOGLE_API_KEY is the SDK's own name for it.
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
  RUNNER_TOKEN: process.env.RUNNER_TOKEN ?? "",
  AGENT_HOME: abs(process.env.AGENT_HOME || "./agent-home"),
  PORT: Number(process.env.PORT || 18787),
  // 127.0.0.1 by default: a port clash then fails loudly instead of another local server silently taking our traffic
  HOST: process.env.HOST || "127.0.0.1",
  PUBLIC_URL: process.env.PUBLIC_URL ?? "",
  ENABLE_SIDE_EFFECTS: process.env.ENABLE_SIDE_EFFECTS === "true",
  VENV: abs(process.env.VENV || "./.venv"),
  PYTHON_LIB: path.join(REPO_ROOT, "python", "lib"),
  APP_DIST: path.join(REPO_ROOT, "app", "dist"),
  TEMPLATE_HOME: path.join(REPO_ROOT, "templates", "agent-home"),
  // The user's timezone and locale (.env TIMEZONE / LOCALE). "Local time" everywhere — reminders, cron,
  // Python, date labels — means this timezone, not the machine's (which is UTC on a server).
  TIMEZONE: validTimezone(process.env.TIMEZONE) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  LOCALE: process.env.LOCALE || "en-GB",
};
// Node re-reads TZ at runtime: from here on, local Date methods use the user's timezone.
process.env.TZ = env.TIMEZONE;

if (!env.RUNNER_TOKEN) {
  console.error("[runner] RUNNER_TOKEN is not set. Run scripts/bootstrap.sh first.");
  process.exit(1);
}
