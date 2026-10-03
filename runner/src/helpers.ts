import { HelperArgs, type HelperName } from "@canvas-agent/contract";
import { z } from "zod";
import { env } from "./env.ts";

/** Sub-agent helper tools (B11). Free sources only. */
const UA = { "user-agent": "canvas-agent/0.1" };

async function geocode(place: string) {
  const u = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place)}&count=1&language=en&format=json`;
  const j = (await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) })).json()) as { results?: { name: string; country?: string; latitude: number; longitude: number }[] };
  const r = j.results?.[0];
  if (!r) throw new Error(`place not found: ${place}`);
  return { name: `${r.name}${r.country ? `, ${r.country}` : ""}`, lat: r.latitude, lon: r.longitude };
}

export async function weather(a: z.infer<(typeof HelperArgs)["weather"]>) {
  let loc = a.lat != null && a.lon != null ? { name: `${a.lat},${a.lon}`, lat: a.lat, lon: a.lon } : null;
  if (!loc) {
    if (!a.place) throw new Error("place or lat/lon required");
    loc = await geocode(a.place);
  }
  const range = a.start ? `&start_date=${a.start}&end_date=${a.end ?? a.start}` : `&forecast_days=${a.days ?? 7}`;
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code&timezone=auto${range}`;
  const j = (await (await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000) })).json()) as {
    daily: { time: string[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[]; weather_code: number[] };
  };
  if (!j.daily) throw new Error(`Open-Meteo: ${JSON.stringify(j).slice(0, 200)}`);
  const d = j.daily;
  const wd = (s: string) => new Date(`${s}T12:00:00`).toLocaleDateString(env.LOCALE, { weekday: "short" });
  return {
    place: loc.name,
    days: d.time.map(wd),
    dates: d.time,
    max: d.temperature_2m_max.map(Math.round),
    min: d.temperature_2m_min.map(Math.round),
    rain_pct: d.precipitation_probability_max,
    conditions: d.weather_code.map(wmo),
    chart_data: { days: d.time.map(wd), series: [{ name: "Max", values: d.temperature_2m_max.map(Math.round) }, { name: "Min", values: d.temperature_2m_min.map(Math.round) }] },
  };
}

function wmo(c: number): string {
  if (c === 0) return "clear";
  if (c <= 3) return "partly cloudy";
  if (c <= 48) return "fog";
  if (c <= 67) return "rain";
  if (c <= 77) return "snow";
  if (c <= 82) return "showers";
  return "thunderstorm";
}

export function mapsLink(a: z.infer<(typeof HelperArgs)["maps_link"]>) {
  // no travel-mode default here: the model passes the user's preference (profile), else Maps decides
  const p = new URLSearchParams({ api: "1", destination: a.to });
  if (a.mode) p.set("travelmode", a.mode);
  if (a.from) p.set("origin", a.from);
  return { href: `https://www.google.com/maps/dir/?${p.toString()}`, label: `Directions to ${a.to}`, kind: "maps" };
}

export async function runHelper(name: HelperName, raw: unknown): Promise<unknown> {
  const parsed = HelperArgs[name].safeParse(raw ?? {});
  if (!parsed.success) return { error: "invalid arguments", details: parsed.error.issues.map((i) => i.message) };
  try {
    switch (name) {
      case "weather": return await weather(parsed.data as never);
      case "maps_link": return mapsLink(parsed.data as never);
    }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
