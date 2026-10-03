import { useEffect, useRef } from "react";
import { callTool } from "../lib/api.ts";
import { useStore } from "../lib/store.ts";
import { Renderer } from "../catalog/Renderer.tsx";

const CLOSE_PULL = 120; // px pulled down from the top of the canvas to fade it out

/** The canvas fades in over the home screens; pulling down from its top (or Esc) fades it out again. */
export function CanvasLayer() {
  const open = useStore((s) => s.canvasOpen);
  const ref = useRef<HTMLDivElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const close = () => useStore.getState().set({ canvasOpen: false });
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !document.querySelector(".sheet-backdrop") && close();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <div
      ref={ref}
      className={`canvas-layer ${open ? "open" : ""}`}
      inert={!open}
      onTouchStart={(e) => (start.current = ref.current!.scrollTop <= 0 ? { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY } : null)}
      onTouchEnd={(e) => {
        const s = start.current;
        start.current = null;
        if (!s) return;
        const dy = e.changedTouches[0]!.clientY - s.y;
        if (dy > CLOSE_PULL && dy > 2 * Math.abs(e.changedTouches[0]!.clientX - s.x)) close();
      }}
    >
      <CanvasView />
    </div>
  );
}

export function CanvasView() {
  const canvas = useStore((s) => s.canvas);
  const ids = useStore((s) => s.canvasIds);
  const busy = useStore((s) => s.busy);

  const undo = () => void callTool("undo", {}).catch((e) => useStore.getState().toast({ text: String(e), kind: "error" }));

  if (!canvas) {
    return (
      <div className="empty">
        <div>
          <div className="empty-title">Ask for anything</div>
          <div className="empty-sub">“What’s the weather in Lisbon next week?”</div>
        </div>
      </div>
    );
  }
  return (
    <div className="canvas">
      <div className="canvas-top">
        {ids.length > 1 && <button className="chip" onClick={undo}>↶ Undo</button>}
        {canvas.meta.source && <span className="chip live">● live · {canvas.meta.source.refresh_s}s</span>}
        {busy && <span className="chip busy">{busy}</span>}
      </div>
      <Renderer key={canvas.id} spec={canvas.spec} data={canvas.data} ctx={{ canvas_id: canvas.id }} />
    </div>
  );
}
