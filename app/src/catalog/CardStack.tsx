import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, type PanInfo } from "framer-motion";
import { useEmit, useWidgetUi } from "./context.ts";

interface Card { id: string; title: string; body?: string; icon?: string }

/**
 * Tinder-style stack: swipe right = done, left = discard, "later" moves the card to the back.
 * Progress lives in the widget's data (data._ui) via the shared reducer — the same on every device,
 * readable and operable by the agent (voice: "next one", "done"). Taps update instantly (optimistic).
 */
export function CardStack(p: { id: string; cards?: Card[]; actions?: string[] }) {
  const emit = useEmit(p.id);
  const { state, dispatch } = useWidgetUi(p.id, "CardStack", p as unknown as Record<string, unknown>);
  const cards = (state.remaining as Card[] | undefined) ?? [];
  const total = (state.total as number | undefined) ?? 0;
  const done = ((state.done as Card[] | undefined) ?? []).length;
  const discarded = ((state.discarded as Card[] | undefined) ?? []).length;
  const [exit, setExit] = useState<1 | -1 | 0>(0);
  const actions = p.actions ?? ["done", "later", "discard"];
  // tell the agent once when the last card is handled (by tap or by voice)
  const wasEmpty = useRef(cards.length === 0);
  useEffect(() => {
    if (total && cards.length === 0 && !wasEmpty.current) emit("stack.empty", { done, discard: discarded });
    wasEmpty.current = cards.length === 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cards.length]);

  const act = (action: "done" | "later" | "discard") => {
    const top = cards[0];
    if (!top) return;
    setExit(action === "done" ? 1 : action === "discard" ? -1 : 0);
    emit(`card.${action}`, { card_id: top.id, title: top.title });
    dispatch(action, { id: top.id });
  };

  const onDragEnd = (_: unknown, info: PanInfo) => {
    // a real swipe: far enough, or a fast flick that still travelled a bit (no velocity-only triggers)
    const dx = info.offset.x;
    if (dx > 100 || (dx > 40 && info.velocity.x > 600)) act("done");
    else if (dx < -100 || (dx < -40 && info.velocity.x < -600)) act("discard");
  };

  if (!total) return null;
  if (!cards.length) {
    return (
      <div className="c-stack-done">
        <span className="c-stack-check">✓</span>
        <span>All sorted · {done} done{discarded ? `, ${discarded} skipped` : ""}</span>
        <button className="btn ghost small" onClick={() => dispatch("reset")}>Again</button>
      </div>
    );
  }

  return (
    <div className="c-stack">
      <div className="c-stack-area" style={{ touchAction: "pan-y" }}>
        <AnimatePresence initial={false} custom={exit}>
          {cards.slice(0, 3).reverse().map((c, i, arr) => {
            const depth = arr.length - 1 - i;
            const isTop = depth === 0;
            return (
              <motion.div
                key={c.id}
                className="c-card"
                custom={exit}
                style={{ zIndex: 10 - depth }}
                initial={{ scale: 0.9, y: 24, opacity: 0 }}
                animate={{ scale: 1 - depth * 0.05, y: depth * 12, opacity: 1, x: 0, rotate: 0 }}
                variants={{ gone: (d: number) => ({ x: d * 400, rotate: d * 20, opacity: 0, transition: { duration: 0.25 } }) }}
                exit="gone"
                drag={isTop ? "x" : false}
                dragSnapToOrigin
                whileDrag={{ rotate: 0 }}
                onDragEnd={isTop ? onDragEnd : undefined}
              >
                {c.icon && <div className="c-card-icon">{c.icon}</div>}
                <div className="c-card-title">{c.title}</div>
                {c.body && <div className="c-card-body">{c.body}</div>}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
      <div className="c-stack-actions">
        {actions.includes("discard") && <button className="btn danger" onClick={() => act("discard")}>✕ Discard</button>}
        {actions.includes("later") && <button className="btn" onClick={() => act("later")}>Later</button>}
        {actions.includes("done") && <button className="btn success" onClick={() => act("done")}>✓ Done</button>}
      </div>
      <div className="c-stack-count">{cards.length} left</div>
    </div>
  );
}
