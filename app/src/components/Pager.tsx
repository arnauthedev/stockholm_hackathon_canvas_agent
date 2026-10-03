import { useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { useStore } from "../lib/store.ts";

const PULL_TALK = 90; // px pulled down on a home screen to start talking
const SWIPE_OPEN = 60; // px swiped up on a home screen to bring the canvas in

/**
 * Home screens: a full-screen horizontal pager with CSS scroll-snap.
 * Vertical gestures: swipe up → canvas fades in; pull down → start a Talk call.
 */
export function Pager({ pages, onPullTalk }: { pages: { key: string; label: string; node: ReactNode }[]; onPullTalk(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const page = useStore((s) => s.page);
  const editMode = useStore((s) => s.editMode);
  const set = useStore((s) => s.set);
  const fromScroll = useRef(false);
  const touch = useRef<{ x: number; y: number; top: boolean; bottom: boolean; axis: "x" | "y" | null } | null>(null);
  const [pull, setPull] = useState(0); // 0‥1 progress of a pull-to-talk; ≥1 = release to talk

  // store → scroll position
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (fromScroll.current) {
      fromScroll.current = false;
      return;
    }
    el.scrollTo({ left: page * el.clientWidth, behavior: "smooth" });
  }, [page]);

  // initial position without animation
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollLeft = useStore.getState().page * el.clientWidth;
  }, []);

  const onScroll = () => {
    const el = ref.current;
    if (!el) return;
    const i = Math.round(el.scrollLeft / el.clientWidth);
    if (i !== useStore.getState().page) {
      fromScroll.current = true;
      set({ page: i });
    }
  };

  const onTouchStart = (e: TouchEvent) => {
    if (editMode) return;
    const t = e.touches[0]!;
    const pg = (e.target as HTMLElement).closest(".page");
    touch.current = {
      x: t.clientX,
      y: t.clientY,
      top: !pg || pg.scrollTop <= 0,
      bottom: !pg || pg.scrollTop + pg.clientHeight >= pg.scrollHeight - 2,
      axis: null,
    };
  };
  const onTouchMove = (e: TouchEvent) => {
    const s = touch.current;
    if (!s) return;
    const t = e.touches[0]!;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (!s.axis && Math.hypot(dx, dy) > 10) s.axis = Math.abs(dy) > Math.abs(dx) ? "y" : "x";
    const p = s.axis === "y" && s.top && dy > 0 ? dy / PULL_TALK : 0;
    if (p >= 1 && pull < 1) navigator.vibrate?.(10);
    setPull(p);
  };
  const onTouchEnd = (e: TouchEvent) => {
    const s = touch.current;
    touch.current = null;
    setPull(0);
    if (!s || s.axis !== "y") return;
    const dy = e.changedTouches[0]!.clientY - s.y;
    if (s.top && dy >= PULL_TALK) onPullTalk();
    else if (s.bottom && dy <= -SWIPE_OPEN) set({ canvasOpen: true });
  };

  return (
    <>
      <div className={`pager ${editMode ? "locked" : ""}`} ref={ref} onScroll={onScroll} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={() => ((touch.current = null), setPull(0))}>
        {pages.map((p) => (
          <section className="page" key={p.key} aria-label={p.label}>
            {p.node}
          </section>
        ))}
      </div>
      <nav className="dots" aria-label="Screens">
        {pages.map((p, i) => (
          <button key={p.key} className={i === page ? "dot on" : "dot"} aria-label={p.label} onClick={() => set({ page: i })} />
        ))}
      </nav>
      {pull > 0 && (
        <div className={`pull-talk ${pull >= 1 ? "ready" : ""}`} style={{ opacity: Math.min(pull * 1.5, 1), transform: `translate(-50%, ${Math.min(pull, 1) * 24 - 24}px)` }}>
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12z" /></svg>
          {pull >= 1 ? "Release to talk" : "Pull to talk"}
        </div>
      )}
      <button className="home-handle" aria-label="Open the canvas" onClick={() => set({ canvasOpen: true })} />
    </>
  );
}
