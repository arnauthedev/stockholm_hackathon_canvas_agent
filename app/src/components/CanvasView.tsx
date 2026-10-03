import { useRef } from "react";
import { callTool } from "../lib/api.ts";
import { useStore } from "../lib/store.ts";
import { Renderer } from "../catalog/Renderer.tsx";
import { InstallHint } from "./InstallHint.tsx";

export function CanvasView() {
  const canvas = useStore((s) => s.canvas);
  const ids = useStore((s) => s.canvasIds);
  const busy = useStore((s) => s.busy);
  const startY = useRef<number | null>(null);

  const undo = () => void callTool("undo", {}).catch((e) => useStore.getState().toast({ text: String(e), kind: "error" }));

  if (!canvas) {
    return (
      <div className="empty">
        <InstallHint />
        <div>
          <div className="empty-title">Ask for anything</div>
          <div className="empty-sub">“What’s the weather in Lisbon next week?”</div>
        </div>
      </div>
    );
  }
  return (
    <div
      className="canvas"
      // swipe down from the top of the canvas → undo
      onTouchStart={(e) => (startY.current = e.currentTarget.parentElement!.scrollTop <= 0 ? e.touches[0]!.clientY : null)}
      onTouchEnd={(e) => {
        if (startY.current != null && e.changedTouches[0]!.clientY - startY.current > 140) undo();
        startY.current = null;
      }}
    >
      <InstallHint />
      <div className="canvas-top">
        {ids.length > 1 && <button className="chip" onClick={undo}>↶ Undo</button>}
        {canvas.meta.source && <span className="chip live">● live · {canvas.meta.source.refresh_s}s</span>}
        {busy && <span className="chip busy">{busy}</span>}
      </div>
      <Renderer key={canvas.id} spec={canvas.spec} data={canvas.data} ctx={{ canvas_id: canvas.id }} />
    </div>
  );
}
