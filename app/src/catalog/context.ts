import { createContext, useContext } from "react";
import { sendUiEvent } from "../lib/bus.ts";

export interface RenderCtx { canvas_id?: string; app_id?: string; compact?: boolean; size?: string; data?: unknown }
export const Ctx = createContext<RenderCtx>({});
export const useRenderCtx = () => useContext(Ctx);

/** Emit a component event (phone → runner → brain). */
export function useEmit(component_id: string) {
  const ctx = useRenderCtx();
  return (event: string, payload?: unknown, extra?: { approval_id?: string }) =>
    sendUiEvent({ canvas_id: ctx.canvas_id, app_id: ctx.app_id, component_id, event, payload, ...extra });
}

// ---------------- widget actions (optimistic taps, confirmed by the runner) ----------------
import { useEffect } from "react";
import { applyUiAction, effectiveState, UI_KEY } from "@canvas-agent/contract";
import { sendUiAction } from "../lib/bus.ts";
import { useStore } from "../lib/store.ts";

/**
 * State + dispatch for an interactive component. A tap applies the shared reducer locally at once
 * (no lag) and sends the action with an id; the runner applies the same reducer, saves it in
 * data._ui and the update comes back — once it contains our action ids the local overlay is dropped.
 */
export function useWidgetUi(componentId: string, type: string, props: Record<string, unknown>) {
  const ctx = useRenderCtx();
  const target = ctx.canvas_id ?? ctx.app_id ?? "";
  const key = `${target}:${componentId}`;
  const server = ((((ctx.data ?? {}) as Record<string, unknown>)[UI_KEY] ?? {}) as Record<string, Record<string, unknown>>)[componentId] ?? {};
  const pending = useStore((s) => s.optimistic[key]);
  const applied = (server.applied as string[] | undefined) ?? [];
  const confirmed = !pending || pending.ids.every((id) => applied.includes(id));
  const ui = confirmed ? server : pending.ui;
  useEffect(() => {
    if (pending && confirmed) useStore.getState().clearOptimistic(key);
  }, [pending, confirmed, key]);
  const dispatch = (action: string, args: Record<string, unknown> = {}) => {
    const r = applyUiAction(type, props, ui, action, args);
    if ("error" in r) return useStore.getState().toast({ text: r.error, kind: "warn" });
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    useStore.getState().setOptimistic(key, { ui: r.ui, ids: [...(pending && !confirmed ? pending.ids : []), id] });
    sendUiAction({ ...(ctx.canvas_id ? { canvas_id: ctx.canvas_id } : { app_id: ctx.app_id }), component_id: componentId, action, args, action_id: id });
  };
  return { state: effectiveState(type, props, ui) ?? {}, dispatch };
}
