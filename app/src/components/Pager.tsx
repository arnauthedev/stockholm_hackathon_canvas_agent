import { useEffect, useRef, type ReactNode } from "react";
import { useStore } from "../lib/store.ts";

/** Full-screen horizontal pager with CSS scroll-snap. */
export function Pager({ pages }: { pages: { key: string; label: string; node: ReactNode }[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const page = useStore((s) => s.page);
  const editMode = useStore((s) => s.editMode);
  const set = useStore((s) => s.set);
  const fromScroll = useRef(false);

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

  return (
    <>
      <div className={`pager ${editMode ? "locked" : ""}`} ref={ref} onScroll={onScroll}>
        {pages.map((p) => (
          <section className="page" key={p.key} aria-label={p.label}>
            {p.node}
          </section>
        ))}
      </div>
      <nav className="dots" aria-label="Pages">
        {pages.map((p, i) => (
          <button key={p.key} className={i === page ? "dot on" : "dot"} aria-label={p.label} onClick={() => set({ page: i })} />
        ))}
      </nav>
    </>
  );
}
