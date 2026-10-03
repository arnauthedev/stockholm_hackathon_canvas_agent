import { useRef, useState, type PointerEvent as RPointerEvent } from "react";
import { GRID_COLS, GRID_ROWS, WIDGET_SIZES, type AppEntry, type WidgetSize } from "@canvas-agent/contract";
import { api, callTool } from "../lib/api.ts";
import { useStore } from "../lib/store.ts";
import { Renderer } from "../catalog/Renderer.tsx";

const SIZES: WidgetSize[] = ["S", "W", "L", "T"];

function Widget({ app, edit, onDragStart }: { app: AppEntry; edit: boolean; onDragStart(e: RPointerEvent, app: AppEntry): void }) {
  const L = app.app.layout ?? { x: 0, y: 0, w: 2, h: 2, size: "S" as WidgetSize };
  const stale = app.job?.last_error && app.job.last_ok == null;
  const setSize = (size: WidgetSize) =>
    void api(`/api/apps/${app.id}/layout`, { method: "POST", json: { size } }).catch(() => useStore.getState().toast({ text: "No room for that size", kind: "warn" }));
  return (
    <div
      className={`slot widget size-${L.size} ${edit ? "editing" : ""}`}
      style={{ gridColumn: `${L.x + 1} / span ${L.w}`, gridRow: `${L.y + 1} / span ${L.h}` }}
      onPointerDown={edit ? (e) => onDragStart(e, app) : undefined}
    >
      <div className="widget-head">
        <span className="widget-title">{app.app.title}</span>
        {app.watches?.rules ? <span className={`bell ${app.watches.active.length ? "ringing" : ""}`} title={`${app.watches.rules} alert(s)`}>🔔</span> : null}
        {app.app.refresh_s ? <span className={stale ? "live-dot err" : "live-dot"} title={`live · every ${app.app.refresh_s}s`} /> : null}
      </div>
      <Renderer spec={app.spec} data={app.data} ctx={{ app_id: app.id, compact: L.size !== "L", size: L.size }} />
      {edit && (
        <div className="widget-edit" onPointerDown={(e) => e.stopPropagation()}>
          <button className="widget-x" aria-label="Unpin" onClick={() => void callTool("unpin", { app_id: app.id })}>✕</button>
          <div className="size-chips">
            {SIZES.map((s) => (
              <button key={s} className={s === L.size ? "on" : ""} title={WIDGET_SIZES[s].label} onClick={() => setSize(s)}>{s}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** One home screen: a GRID_COLS × GRID_ROWS grid. ✎ toggles edit mode (sizes, move by dragging, unpin). */
export function ScreenView({ screenId }: { screenId: string }) {
  const apps = useStore((s) => s.apps);
  const edit = useStore((s) => s.editMode);
  const set = useStore((s) => s.set);
  const grid = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ id: string; w: number; h: number; dx: number; dy: number; x: number; y: number } | null>(null);
  const mine = Object.values(apps).filter((a) => a.app.screen === screenId);

  const cellAt = (e: { clientX: number; clientY: number }) => {
    const r = grid.current!.getBoundingClientRect();
    return { col: Math.floor(((e.clientX - r.left) / r.width) * GRID_COLS), row: Math.floor(((e.clientY - r.top) / r.height) * GRID_ROWS) };
  };
  const onDragStart = (e: RPointerEvent, app: AppEntry) => {
    const L = app.app.layout;
    if (!L || !grid.current) return;
    const c = cellAt(e);
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ id: app.id, w: L.w, h: L.h, dx: c.col - L.x, dy: c.row - L.y, x: L.x, y: L.y });
  };
  const onMove = (e: RPointerEvent) => {
    if (!drag) return;
    const c = cellAt(e);
    const x = Math.max(0, Math.min(GRID_COLS - drag.w, c.col - drag.dx));
    const y = Math.max(0, Math.min(GRID_ROWS - drag.h, c.row - drag.dy));
    if (x !== drag.x || y !== drag.y) setDrag({ ...drag, x, y });
  };
  const onUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    const L = apps[d.id]?.app.layout;
    if (L && L.x === d.x && L.y === d.y) return;
    void api(`/api/apps/${d.id}/layout`, { method: "POST", json: { screen: screenId, x: d.x, y: d.y } }).catch(() =>
      useStore.getState().toast({ text: "Doesn't fit there", kind: "warn" }),
    );
  };

  return (
    <div className="screen">
      <div className="screen-top">
        <button className={`chip ${edit ? "on" : ""}`} onClick={() => set({ editMode: !edit })}>{edit ? "Done" : "✎ Edit"}</button>
      </div>
      <div className={`screen-grid ${edit ? "editing" : ""}`} ref={grid} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
        {mine.map((a) => <Widget key={a.id} app={a} edit={edit} onDragStart={onDragStart} />)}
        {drag && <div className="drop-ghost" style={{ gridColumn: `${drag.x + 1} / span ${drag.w}`, gridRow: `${drag.y + 1} / span ${drag.h}` }} />}
        {!mine.length && <div className="screen-empty">Pinned widgets appear here</div>}
      </div>
    </div>
  );
}
