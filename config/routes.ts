/**
 * Provider routing table (B10). Switch providers/models here or with
 * env overrides: ROUTE_<job>=provider/model[@effort]
 *   e.g. ROUTE_brain=openai/gpt-6-astra   ROUTE_brain=openai/gpt-6-luna@minimal
 * Model picks are documented in docs/DECISIONS.md. Policy: cheapest, then fastest, then best quality.
 */
export const routes = {
  voice: { provider: "openai", session: "gpt-live", model: "gpt-live-1", voice: "marin", enabled: true },
  voiceFallback: { provider: "openai", session: "realtime", model: "gpt-realtime-2.1", voice: "marin", enabled: true },
  brain: { provider: "openai", model: "gpt-6-luna", reasoning: "minimal", voiceReasoning: "minimal", tools: ["web_search"], enabled: true },
  subagent: { provider: "openai", model: "gpt-6-luna", reasoning: "minimal", tools: ["web_search"], enabled: true },
  vision: { provider: "openai", model: "gpt-6-luna", enabled: true },
  tts: { provider: "openai", model: "gpt-4o-mini-tts", voice: "coral", enabled: true },
  image: { provider: "openai", model: "gpt-image-2.5-flare", enabled: false },
  decide: { provider: "typesafe", model: "jev-latest", enabled: false }, // via Vercel AI Gateway if a key is added
  // Gemini rows present but disabled; enable when GOOGLE_API_KEY exists
  grounding: { provider: "google", model: "gemini-3-flash", native: ["google_search", "google_maps"], enabled: false },
} as const;

export type RouteJob = keyof typeof routes;
export type Route = { provider: string; model: string; enabled: boolean } & Record<string, unknown>;

/** Resolve a route with ROUTE_<job> env override applied. */
export function route(job: RouteJob, env: Record<string, string | undefined> = process.env): Route {
  const base = { ...(routes[job] as unknown as Route) };
  const override = env[`ROUTE_${job}`];
  if (override) {
    const [spec, effort] = override.split("@");
    const [provider, ...rest] = (spec ?? "").split("/");
    if (provider && rest.length) Object.assign(base, { provider, model: rest.join("/") });
    // one effort for both text and voice backends when overridden
    if (effort) Object.assign(base, { reasoning: effort, voiceReasoning: effort });
  }
  return base;
}
