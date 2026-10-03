import { useState } from "react";
import { useWidgetUi } from "./context.ts";

type Item = { id: string; text: string; done: boolean };

/** Tickable list the user (or the agent, by voice) can add to. */
export function Checklist(p: { id: string; items?: unknown; addable?: boolean }) {
  const { state, dispatch } = useWidgetUi(p.id, "Checklist", p as Record<string, unknown>);
  const items = (state.items as Item[] | undefined) ?? [];
  const [text, setText] = useState("");
  const left = items.filter((i) => !i.done).length;
  return (
    <div className="c-checklist">
      <ul>
        {items.map((i) => (
          <li key={i.id} className={i.done ? "done" : ""}>
            <button className="c-check" aria-pressed={i.done} onClick={() => dispatch("toggle", { id: i.id })}>
              <span className="box">{i.done ? "✓" : ""}</span>
              <span className="txt">{i.text}</span>
            </button>
            <button className="c-rm" aria-label={`Remove ${i.text}`} onClick={() => dispatch("remove", { id: i.id })}>✕</button>
          </li>
        ))}
      </ul>
      {p.addable !== false && (
        <form className="c-add" onSubmit={(e) => (e.preventDefault(), text.trim() && (dispatch("add", { text }), setText("")))}>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add item" enterKeyHint="done" />
        </form>
      )}
      <div className="c-list-foot">{items.length ? `${left} left of ${items.length}` : "Empty"}</div>
    </div>
  );
}

/** Free notes: lines the user types or dictates. */
export function Notebook(p: { id: string; lines?: unknown; placeholder?: string }) {
  const { state, dispatch } = useWidgetUi(p.id, "Notebook", p as Record<string, unknown>);
  const lines = (state.lines as { id: string; text: string }[] | undefined) ?? [];
  const [text, setText] = useState("");
  return (
    <div className="c-notebook">
      {lines.map((l) => (
        <div key={l.id} className="c-line">
          <span>{l.text}</span>
          <button className="c-rm" aria-label="Remove line" onClick={() => dispatch("remove", { id: l.id })}>✕</button>
        </div>
      ))}
      <form className="c-add" onSubmit={(e) => (e.preventDefault(), text.trim() && (dispatch("append", { text }), setText("")))}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={p.placeholder ?? "Write a note"} enterKeyHint="done" />
      </form>
    </div>
  );
}
