import { useEffect, useState } from "react";
import { openLink } from "../lib/links.ts";
import { useEmit, useRenderCtx, useWidgetUi } from "./context.ts";

const str = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

export function Heading(p: { text?: unknown; level?: number }) {
  const L = Math.min(3, Math.max(1, Number(p.level) || 1));
  const Tag = (`h${L}` as "h1" | "h2" | "h3");
  return <Tag className={`c-h c-h${L}`}>{str(p.text)}</Tag>;
}

export function Text(p: { text?: unknown; muted?: boolean; size?: string }) {
  return <p className={`c-text ${p.muted ? "muted" : ""} ${p.size ?? ""}`}>{str(p.text)}</p>;
}

export function Metric(p: { label?: unknown; value?: unknown; unit?: unknown; delta?: unknown; trend?: string; note?: unknown }) {
  const trend = p.trend ?? (typeof p.delta === "number" ? (p.delta > 0 ? "up" : p.delta < 0 ? "down" : "flat") : undefined);
  const arrow = trend === "up" ? "▲" : trend === "down" ? "▼" : trend === "flat" ? "▬" : "";
  const delta = p.delta == null || p.delta === "" ? null : typeof p.delta === "number" && p.delta > 0 ? `+${p.delta}` : str(p.delta);
  return (
    <div className="c-metric">
      <div className="c-metric-label">{str(p.label)}</div>
      <div className="c-metric-value">
        {str(p.value)}
        {p.unit != null && <span className="c-metric-unit">{str(p.unit)}</span>}
      </div>
      {delta != null && <div className={`c-metric-delta ${trend ?? ""}`}>{arrow} {delta}</div>}
      {p.note != null && p.note !== "" && <div className="c-metric-note">{str(p.note)}</div>}
    </div>
  );
}

export function KeyValue(p: { items?: unknown }) {
  return (
    <dl className="c-kv">
      {arr<{ k: string; v: unknown }>(p.items).map((it, i) => (
        <div key={i} className="c-kv-row">
          <dt>{str(it.k)}</dt>
          <dd>{str(it.v)}</dd>
        </div>
      ))}
    </dl>
  );
}

export function List(p: { id: string; items?: unknown }) {
  const emit = useEmit(p.id);
  return (
    <ul className="c-list">
      {arr<{ id?: string; title: string; subtitle?: string; icon?: string; href?: string }>(p.items).map((it, i) => (
        <li key={it.id ?? i}>
          <button
            onClick={() => {
              emit("list.tap", { id: it.id ?? String(i), title: it.title });
              if (it.href) openLink(it.href);
            }}
          >
            {it.icon && <span className="c-list-icon">{it.icon}</span>}
            <span className="c-list-text">
              <span className="c-list-title">{str(it.title)}</span>
              {it.subtitle && <span className="c-list-sub">{str(it.subtitle)}</span>}
            </span>
            {it.href && <span className="c-list-chev">›</span>}
          </button>
        </li>
      ))}
    </ul>
  );
}

const FADE_MS = 900; // matches .c-img-next's transition

/**
 * Image. A new src crossfades over the old one once it has loaded (image cards change in place);
 * `busy` shows a shimmer before the first picture and a "Drawing…" veil while it is being redrawn.
 */
export function Image(p: { src?: unknown; alt?: unknown; fit?: string; busy?: unknown; aspect?: unknown }) {
  const src = str(p.src);
  const [shown, setShown] = useState(src);
  const [next, setNext] = useState<{ src: string; in: boolean } | null>(null);
  useEffect(() => {
    if (src !== shown && src !== next?.src) setNext(src ? { src, in: false } : null);
  }, [src, shown, next?.src]);
  // finish on a timer, not transitionend: a picture that loads within the same frame never transitions
  useEffect(() => {
    if (!next?.in) return;
    const t = setTimeout(() => (setShown(next.src), setNext(null)), FADE_MS + 50);
    return () => clearTimeout(t);
  }, [next]);
  const fadeIn = () => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return next && (setShown(next.src), setNext(null));
    // two frames so the browser has painted it at opacity 0 before it fades in
    requestAnimationFrame(() => requestAnimationFrame(() => setNext((n) => (n ? { ...n, in: true } : n))));
  };
  const fit = { objectFit: p.fit === "contain" ? "contain" : "cover" } as const;
  const ratio = /^\d+:\d+$/.test(str(p.aspect)) ? str(p.aspect).replace(":", " / ") : undefined;
  const busy = !!p.busy;
  if (!shown && !next) return <div className={`c-img c-img-empty ${busy ? "shimmer" : ""}`} style={{ aspectRatio: ratio ?? "1 / 1" }}>{busy && <span className="c-img-busy">Drawing…</span>}</div>;
  return (
    <div className="c-img-wrap">
      {shown && <img className="c-img" src={shown} alt={str(p.alt)} style={fit} />}
      {next && (
        <img
          className={`c-img c-img-next ${next.in ? "in" : ""} ${shown ? "" : "first"}`}
          src={next.src}
          alt={str(p.alt)}
          style={fit}
          onLoad={fadeIn}
        />
      )}
      {busy && shown && <span className="c-img-busy veil">Drawing…</span>}
    </div>
  );
}

const LINK_ICON: Record<string, string> = { maps: "🗺️", tel: "📞", mailto: "✉️", web: "↗" };
export function Link(p: { id: string; label?: unknown; href?: unknown; kind?: string }) {
  const emit = useEmit(p.id);
  const href = str(p.href);
  return (
    <a
      className="c-link"
      href={href}
      target={/^(tel|mailto):/.test(href) ? undefined : "_blank"}
      rel="noopener"
      onClick={() => emit("link.open", { href })}
    >
      <span className="c-link-icon">{LINK_ICON[p.kind ?? "web"] ?? "↗"}</span>
      <span>{str(p.label)}</span>
    </a>
  );
}

export function TaskList(p: { id: string; tasks?: unknown }) {
  const emit = useEmit(p.id);
  return (
    <ul className="c-list">
      {arr<{ id: string; title: string; status: string; kind: string }>(p.tasks).map((t) => (
        <li key={t.id}>
          <button onClick={() => emit("task.tap", { id: t.id })}>
            <span className={`status-dot ${t.status}`} />
            <span className="c-list-text">
              <span className="c-list-title">{t.title}</span>
              <span className="c-list-sub">{t.status.replace("_", " ")} · {t.kind}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Form(p: { id: string; fields?: unknown; submit?: unknown }) {
  const emit = useEmit(p.id);
  const fields = arr<{ name: string; label: string; type: string; value?: unknown; options?: string[] }>(p.fields);
  // saved values (incl. ones the agent filled in by voice) come from the widget state; typing stays local until submit
  const { state, dispatch } = useWidgetUi(p.id, "Form", p as unknown as Record<string, unknown>);
  const saved = (state.values ?? {}) as Record<string, unknown>;
  const [edits, setEdits] = useState<Record<string, unknown>>({});
  const values = { ...saved, ...edits };
  const sent = !!state.submitted;
  const set = (k: string, v: unknown) => setEdits({ ...edits, [k]: v });
  return (
    <form
      className="c-form"
      onSubmit={(e) => {
        e.preventDefault();
        for (const [name, value] of Object.entries(edits)) dispatch("set_field", { name, value });
        dispatch("submit");
        emit("form.submit", { values });
        setEdits({});
      }}
    >
      {fields.map((f) => (
        <label key={f.name} className={`c-field ${f.type === "toggle" ? "toggle" : ""}`}>
          <span>{f.label}</span>
          {f.type === "select" ? (
            <select value={str(values[f.name])} onChange={(e) => set(f.name, e.target.value)}>
              {(f.options ?? []).map((o) => <option key={o}>{o}</option>)}
            </select>
          ) : f.type === "toggle" ? (
            <input type="checkbox" checked={!!values[f.name]} onChange={(e) => set(f.name, e.target.checked)} />
          ) : (
            <input type={f.type === "number" ? "number" : "text"} inputMode={f.type === "number" ? "decimal" : undefined} value={str(values[f.name])} onChange={(e) => set(f.name, f.type === "number" ? Number(e.target.value) : e.target.value)} />
          )}
        </label>
      ))}
      <button className="btn primary" type="submit" disabled={sent && !Object.keys(edits).length}>{sent && !Object.keys(edits).length ? "Sent" : str(p.submit) || "Submit"}</button>
    </form>
  );
}

export function Divider() {
  return <hr className="c-divider" />;
}

export function Unsupported({ type }: { type: string }) {
  const { compact } = useRenderCtx();
  return <div className="c-unsupported">{compact ? "?" : `unsupported: ${type}`}</div>;
}
