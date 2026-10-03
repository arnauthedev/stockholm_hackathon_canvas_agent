import path from "node:path";
import { resolvePointer, WatchFile, type WatchRule } from "@canvas-agent/contract";
import { injectActive } from "./brain.ts";
import { bus } from "./bus.ts";
import { lock, now, readJson, writeJson } from "./fsutil.ts";
import { record } from "./monitor.ts";
import { pushAll } from "./push.ts";
import { paths, readApp } from "./store.ts";
import { tasksApi } from "./tasks-hook.ts";

/**
 * Conditions on live widgets, evaluated by the runner after every refresh (no model calls).
 * Two sources, one mechanism:
 *  - apps/<slug>/watch.json rules (path / op / value), written by the `watch` tool;
 *  - `_alerts: [{id, message, title?}]` printed by the fetch script for whatever is true right now
 *    (any logic the script wants).
 * An alert fires when it BECOMES true (rising edge) and re-arms when it clears; state is in
 * alerts.json so restarts don't re-fire.
 */
export interface ScriptAlert { id: string; message: string; title?: string }
interface AlertState { active: Record<string, string>; last_fired: Record<string, string>; last_values: Record<string, unknown> }

const watchFile = (id: string) => path.join(paths.appDir(id), "watch.json");
const stateFile = (id: string) => path.join(paths.appDir(id), "alerts.json");

export async function readRules(appId: string): Promise<WatchRule[]> {
  const r = WatchFile.safeParse(await readJson(watchFile(appId)));
  return r.success ? r.data.rules : [];
}
export const writeRules = (appId: string, rules: WatchRule[]) => writeJson(watchFile(appId), { schema_version: 1, rules });

const num = (v: unknown): number | null => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[^\d.+-eE]/g, ""));
    return Number.isFinite(n) && /\d/.test(v) ? n : null;
  }
  return null;
};

function holds(rule: WatchRule, v: unknown, prev: unknown): boolean {
  if (rule.op === "changed") return prev !== undefined && JSON.stringify(v) !== JSON.stringify(prev);
  if (v === undefined || v === null) return false;
  if (rule.op === "==" || rule.op === "!=") {
    const eq = num(v) != null && num(rule.value) != null ? num(v) === num(rule.value) : String(v) === String(rule.value);
    return rule.op === "==" ? eq : !eq;
  }
  const a = num(v);
  const b = num(rule.value);
  if (a == null || b == null) return false;
  return rule.op === "<" ? a < b : rule.op === "<=" ? a <= b : rule.op === ">" ? a > b : a >= b;
}

/** Called after an app's job run with its fresh data and any script alerts. */
export async function evaluateAlerts(appId: string, data: unknown, scriptAlerts: ScriptAlert[]) {
  await lock(`alerts:${appId}`, async () => {
    const rules = await readRules(appId);
    if (!rules.length && !scriptAlerts.length && !(await readJson(stateFile(appId)))) return;
    const st: AlertState = { active: {}, last_fired: {}, last_values: {}, ...((await readJson<AlertState>(stateFile(appId))) ?? {}) };
    const trueNow = new Map<string, { message: string; title?: string; rule?: WatchRule; value?: unknown }>();
    for (const rule of rules) {
      const v = resolvePointer(data, rule.path);
      if (holds(rule, v, st.last_values[rule.id])) trueNow.set(rule.id, { message: rule.message.replace("{value}", String(v)), rule, value: v });
      st.last_values[rule.id] = v;
    }
    for (const a of scriptAlerts) if (a?.id && a.message) trueNow.set(`script:${a.id}`, { message: a.message, title: a.title });

    const app = await readApp(appId);
    const title = app?.app.title ?? appId;
    let removeOnce: string[] = [];
    for (const [id, a] of trueNow) {
      const wasActive = id in st.active;
      const cooldown = (a.rule?.cooldown_s ?? 0) * 1000;
      const last = st.last_fired[id] ? Date.parse(st.last_fired[id]) : 0;
      if (!wasActive && Date.now() - last >= cooldown) {
        st.last_fired[id] = now();
        if (a.rule?.notify !== false) await fire(appId, title, id, a.title ?? title, a.message);
        if (a.rule?.task) await runRuleTask(appId, title, a.rule, a.value);
        if (a.rule?.mode === "once") removeOnce.push(id);
      }
    }
    // rising-edge state: "changed" is instantaneous, everything else stays active while true
    st.active = Object.fromEntries([...trueNow.keys()].filter((id) => rules.find((r) => r.id === id)?.op !== "changed").map((id) => [id, st.active[id] ?? now()]));
    if (removeOnce.length) await writeRules(appId, rules.filter((r) => !removeOnce.includes(r.id)));
    await writeJson(stateFile(appId), st);
  });
}

/** A rule's action: a background task (redraw a picture, update a card…), started on the rising edge. */
async function runRuleTask(appId: string, appTitle: string, rule: WatchRule, value: unknown) {
  const t = rule.task!;
  const details = `${t.details.replaceAll("{value}", String(value))}\n(Started automatically: on the "${appTitle}" widget, ${rule.path} ${rule.op} ${String(rule.value ?? "")} became true; the value is ${JSON.stringify(value)}.)`;
  record({ kind: "job", title: `condition → task: ${appTitle}`, detail: `${t.title} (${rule.path}=${String(value).slice(0, 24)})`, ok: true, actor: `app:${appId}` });
  await tasksApi.create({ tasks: [{ title: t.title, kind: t.kind ?? "background", details }] }, { actor: `watch:${appId}` }).catch((e: unknown) => console.warn("[alerts] task failed to start", e));
}

async function fire(appId: string, appTitle: string, ruleId: string, title: string, message: string) {
  bus.emit({ type: "alert", app_id: appId, rule_id: ruleId, title, message });
  bus.emit({ type: "toast", text: `🔔 ${message}`, kind: "warn", sound: "ding" });
  record({ kind: "job", title: `alert fired: ${appTitle}`, detail: message, ok: true, actor: `app:${appId}` });
  injectActive(`Alert from the "${appTitle}" widget: ${message}`);
  await pushAll({ title: `🔔 ${title}`, body: message, url: `/#app=${appId}`, tag: `alert-${appId}-${ruleId}` });
}
