import { randomBytes } from "node:crypto";
import path from "node:path";
import { applyUiAction, COMPONENT_ACTIONS, describeState, effectiveState, isInteractive, resolveProps, UI_KEY, type CanvasSpec } from "@canvas-agent/contract";
import { lock, readJson, writeJson } from "./fsutil.ts";
import { isCanvasId, latestCanvasId, paths, readApp, readCanvas } from "./store.ts";

/**
 * Widget actions on the runner: taps (ui.action from the phone), voice and text (ui_action tool)
 * all go through here. State is saved under data._ui[component_id] with the ids of applied
 * actions, so the phone can confirm its optimistic update and never apply anything twice.
 */
async function load(target?: string): Promise<{ id: string; dir: string; spec: CanvasSpec; data: Record<string, unknown> } | { error: string }> {
  const id = target ?? (await latestCanvasId());
  if (!id) return { error: "nothing on the canvas" };
  if (isCanvasId(id)) {
    const c = await readCanvas(id);
    return c ? { id, dir: paths.canvasDir(id), spec: c.spec, data: (c.data ?? {}) as Record<string, unknown> } : { error: `unknown canvas ${id}` };
  }
  const a = await readApp(id);
  return a ? { id, dir: paths.appDir(id), spec: a.spec, data: (a.data ?? {}) as Record<string, unknown> } : { error: `unknown widget ${id}` };
}

const interactive = (spec: CanvasSpec) => Object.entries(spec.components).filter(([, c]) => isInteractive(c.type));

export async function applyAction(o: { target?: string; component_id?: string; action: string; args?: Record<string, unknown>; action_id?: string }) {
  const t = await load(o.target);
  if ("error" in t) return t;
  const comps = interactive(t.spec);
  // explicit id, else the only interactive component, else the one whose type supports this action
  const entry = o.component_id
    ? comps.find(([cid]) => cid === o.component_id)
    : comps.length === 1
      ? comps[0]
      : comps.find(([, c]) => (COMPONENT_ACTIONS[c.type as keyof typeof COMPONENT_ACTIONS] as readonly string[]).includes(o.action));
  if (!entry) return { error: comps.length ? `which component? ${comps.map(([cid, c]) => `${cid} (${c.type})`).join(", ")}` : "no interactive widget here" };
  const [cid, comp] = entry;
  const actionId = o.action_id ?? `srv-${randomBytes(4).toString("hex")}`;
  return lock(`data:${t.dir}`, async () => {
    const file = path.join(t.dir, "data.json");
    const data = ((await readJson<Record<string, unknown>>(file)) ?? {}) as Record<string, unknown>;
    const uiAll = (data[UI_KEY] ?? {}) as Record<string, Record<string, unknown>>;
    const prev = uiAll[cid] ?? {};
    if ((prev.applied as string[] | undefined)?.includes(actionId)) return { ok: true, duplicate: true };
    const props = resolveProps(comp.props, data);
    const r = applyUiAction(comp.type, props, prev, o.action, o.args ?? {});
    if ("error" in r) return { error: r.error };
    const next = { ...r.ui, applied: [...((prev.applied as string[] | undefined) ?? []), actionId].slice(-40) };
    await writeJson(file, { ...data, [UI_KEY]: { ...uiAll, [cid]: next } });
    return { ok: true, target: t.id, component_id: cid, state: describeState(comp.type, effectiveState(comp.type, props, next)) };
  });
}

export async function readWidget(target?: string) {
  const t = await load(target);
  if ("error" in t) return t;
  const ui = (t.data[UI_KEY] ?? {}) as Record<string, unknown>;
  const widgets = interactive(t.spec).map(([cid, c]) => ({
    component_id: cid,
    type: c.type,
    state: describeState(c.type, effectiveState(c.type, resolveProps(c.props, t.data), ui[cid])),
  }));
  return { target: t.id, title: t.spec.title, widgets, note: widgets.length ? undefined : "no interactive widgets here" };
}
