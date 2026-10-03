import path from "node:path";
import { route } from "../../config/routes.ts";
import { env } from "./env.ts";
import { readJson, writeJson } from "./fsutil.ts";

/**
 * Settings changed from the phone, kept in agent-home/settings.json. `talkVoice` picks the provider of
 * the Talk call and wins over ROUTE_voice in .env: it is applied as that env override, which route()
 * reads every time a call starts, so a change applies from the next call without a restart.
 * Live vision (routes.liveVision) is not affected.
 */
export type TalkVoice = "openai" | "google";
export type Settings = { talkVoice?: TalkVoice };

const FILE = path.join(env.AGENT_HOME, "settings.json");
const TALK_ROUTE: Record<TalkVoice, string> = { openai: "openai/gpt-live-1", google: "google/gemini-3.8-live" };

export const isTalkVoice = (v: unknown): v is TalkVoice => v === "openai" || v === "google";

function apply(s: Settings) {
  if (s.talkVoice) process.env.ROUTE_voice = TALK_ROUTE[s.talkVoice];
}

export async function loadSettings() {
  apply((await readJson<Settings>(FILE)) ?? {});
}

/** What the phone shows: the provider Talk uses right now (settings, else .env, else the code default). */
export const currentSettings = () => ({ talkVoice: route("voice").provider as TalkVoice });

export async function saveSettings(patch: Settings) {
  const next = { ...((await readJson<Settings>(FILE)) ?? {}), ...patch };
  await writeJson(FILE, next);
  apply(next);
  return currentSettings();
}
