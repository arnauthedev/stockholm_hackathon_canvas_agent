import { useEffect, useRef, useState } from "react";
import { useEmit } from "./context.ts";
import { MarkdownLite } from "./MarkdownLite.tsx";

interface Field { name: string; label: string; value: string; editable?: boolean }

const LONG = /^(body|message|text|notes?)$/i;

/**
 * Approval card: editable from the start (no "Modify" step). Bottom row: ✕ Reject (left) ·
 * ✓ Send / Call / Accept (right) — whatever is in the inputs when you press ✓ is what's used.
 * During a voice approval the row becomes "Approved by voice · Ns" + Cancel.
 * Cards with an empty editable field and no "modify" action are question forms ("Save").
 */
export function ApprovalCard(p: {
  id: string; title?: string; body?: string; fields?: Field[]; actions?: string[]; accept_label?: string;
  approval_id?: string; onDone?: () => void; committingUntil?: number;
}) {
  const emit = useEmit(p.id);
  const fields = Array.isArray(p.fields) ? p.fields : [];
  const original = Object.fromEntries(fields.map((f) => [f.name, f.value ?? ""]));
  const [values, setValues] = useState<Record<string, string>>(original);
  const touched = useRef(new Set<string>()); // fields the user typed in: voice edits don't overwrite them
  const actions = p.actions ?? ["accept", "modify", "reject"];
  const isForm = !actions.includes("modify") && fields.some((f) => f.editable !== false && !f.value);
  const [done, setDone] = useState<string | null>(null);

  // voice edits arrive as new field values
  const fieldsKey = JSON.stringify(fields.map((f) => [f.name, f.value]));
  useEffect(() => {
    setValues((v) => ({ ...v, ...Object.fromEntries(fields.filter((f) => !touched.current.has(f.name)).map((f) => [f.name, f.value ?? ""])) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsKey]);

  // "Approved by voice" countdown
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!p.committingUntil) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [p.committingUntil]);
  const left = p.committingUntil ? Math.max(0, Math.ceil((p.committingUntil - now) / 1000)) : 0;

  const send = (action: "accept" | "reject") => {
    const edited = fields.some((f) => values[f.name] !== original[f.name]);
    const a = action === "accept" && edited && !isForm ? "modify" : action;
    emit(`approval.${a}`, { fields: values }, { approval_id: p.approval_id ?? p.id });
    setDone(a);
    p.onDone?.();
  };
  const set = (name: string, v: string) => {
    touched.current.add(name);
    setValues({ ...values, [name]: v });
  };

  // the body is a short hint when the card already shows the text in a field (no duplication)
  const hasLongField = fields.some((f) => LONG.test(f.name));
  const acceptLabel = isForm ? "Save" : p.accept_label ?? "Accept";

  return (
    <div className="c-approval">
      <div className="c-approval-title">{p.title}</div>
      {p.body && (hasLongField ? <div className="c-approval-hint">{p.body}</div> : <div className="c-approval-body"><MarkdownLite text={String(p.body)} /></div>)}
      {fields.length > 0 && (
        <div className="c-fields">
          {fields.map((f) => (
            <label key={f.name} className={`c-field ${LONG.test(f.name) ? "long" : ""}`}>
              <span>{f.label}</span>
              {f.editable === false ? (
                <div className="c-field-value">{values[f.name]}</div>
              ) : LONG.test(f.name) || (values[f.name]?.length ?? 0) > 60 ? (
                <textarea rows={Math.min(10, Math.max(4, (values[f.name] ?? "").split("\n").length + 1))} value={values[f.name]} onChange={(e) => set(f.name, e.target.value)} />
              ) : (
                <input value={values[f.name]} onChange={(e) => set(f.name, e.target.value)} />
              )}
            </label>
          ))}
        </div>
      )}
      {p.committingUntil ? (
        <div className="c-approval-actions commit">
          <span className="c-approval-commit-text">Approved by voice · {left}s</span>
          <button className="btn" onClick={() => emit("approval.undo", {}, { approval_id: p.approval_id ?? p.id })}>Cancel</button>
        </div>
      ) : done ? (
        <div className="c-approval-done">{{ accept: isForm ? "Saved" : "Approved", modify: "Sent with your edits", reject: "Rejected" }[done] ?? done}</div>
      ) : (
        <div className="c-approval-actions">
          {actions.includes("reject") && <button className="btn reject" onClick={() => send("reject")}>✕ {isForm ? "Cancel" : "Reject"}</button>}
          {actions.includes("accept") && <button className="btn primary accept" onClick={() => send("accept")}>✓ {acceptLabel}</button>}
        </div>
      )}
    </div>
  );
}
