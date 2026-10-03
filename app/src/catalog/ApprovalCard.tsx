import { useEffect, useState } from "react";
import { useEmit } from "./context.ts";
import { MarkdownLite } from "./MarkdownLite.tsx";

interface Field { name: string; label: string; value: string; editable?: boolean }

export function ApprovalCard(p: {
  id: string; title?: string; body?: string; fields?: Field[]; actions?: string[];
  approval_id?: string; onDone?: () => void; committingUntil?: number;
}) {
  const emit = useEmit(p.id);
  const fields = Array.isArray(p.fields) ? p.fields : [];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, f.value ?? ""])));
  const actions = p.actions ?? ["accept", "modify", "reject"];
  // no "modify" action + an empty editable field → it's a question form: show the inputs right away
  const isForm = !actions.includes("modify") && fields.some((f) => f.editable !== false && !f.value);
  const [editing, setEditing] = useState(isForm);
  const [done, setDone] = useState<string | null>(null);
  // voice edits arrive as new field values: show them (unless the user is typing an edit right now)
  const fieldsKey = JSON.stringify(fields.map((f) => [f.name, f.value]));
  useEffect(() => {
    if (!editing || isForm) setValues(Object.fromEntries(fields.map((f) => [f.name, f.value ?? ""])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldsKey]);
  // "Approved by voice · Undo (Ns)" countdown
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!p.committingUntil) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [p.committingUntil]);
  const left = p.committingUntil ? Math.max(0, Math.ceil((p.committingUntil - now) / 1000)) : 0;

  const send = (action: string) => {
    emit(`approval.${action}`, { fields: values }, { approval_id: p.approval_id ?? p.id });
    setDone(action);
    p.onDone?.();
  };

  return (
    <div className="c-approval">
      <div className="c-approval-title">{p.title}</div>
      {p.body && <div className="c-approval-body"><MarkdownLite text={String(p.body)} /></div>}
      {fields.length > 0 && (
        <div className="c-fields">
          {fields.map((f) => (
            <label key={f.name} className="c-field">
              <span>{f.label}</span>
              {editing && f.editable !== false ? (
                f.name === "body" || (values[f.name]?.length ?? 0) > 60 ? (
                  <textarea rows={5} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
                ) : (
                  <input value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} />
                )
              ) : (
                <div className="c-field-value">{values[f.name]}</div>
              )}
            </label>
          ))}
        </div>
      )}
      {p.committingUntil ? (
        <div className="c-approval-commit">
          <span>Approved by voice · going ahead in {left}s</span>
          <button className="btn" onClick={() => emit("approval.undo", {}, { approval_id: p.approval_id ?? p.id })}>Undo</button>
        </div>
      ) : done ? (
        <div className="c-approval-done">{{ accept: "Approved", modify: "Sent with changes", reject: "Rejected" }[done] ?? done}</div>
      ) : (
        <div className="c-approval-actions">
          {actions.includes("reject") && <button className="btn danger" onClick={() => send("reject")}>Reject</button>}
          {actions.includes("modify") && fields.some((f) => f.editable !== false) && (
            editing ? <button className="btn" onClick={() => send("modify")}>Save &amp; approve</button> : <button className="btn" onClick={() => setEditing(true)}>Modify</button>
          )}
          {actions.includes("accept") && (!editing || isForm) && <button className="btn primary" onClick={() => send("accept")}>{isForm ? "Save" : "Accept"}</button>}
        </div>
      )}
    </div>
  );
}
