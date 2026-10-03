import { useEffect, useState } from "react";
import type { TaskEntry } from "@canvas-agent/contract";
import { useStore } from "../lib/store.ts";
import { openLink } from "../lib/links.ts";
import { api } from "../lib/api.ts";
import { callTool } from "../lib/api.ts";
import type { TriggerJson } from "@canvas-agent/contract";

function when(t: TriggerJson, now: number) {
  if (t.source === "email") return "on new email";
  if (t.cron) return `repeats · ${t.cron}`;
  const s = Math.round((Date.parse(t.at ?? "") - now) / 1000);
  if (s <= 0) return "now";
  if (s < 90) return `in ${s}s`;
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  return new Date(t.at!).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function Scheduled() {
  const triggers = useStore((s) => s.triggers);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!triggers.length) return null;
  return (
    <div className="scheduled">
      <h3>Scheduled</h3>
      <ul>
        {triggers.map((t) => (
          <li key={t.id}>
            <span className="sched-icon">{t.source === "email" ? "📧" : t.action?.type === "speak" ? "🔊" : t.action?.type === "task" ? "⚙" : "⏰"}</span>
            <span className="grow"><b>{t.label}</b><span className="muted">{when(t, now)}</span></span>
            <button className="btn ghost" aria-label="Cancel" onClick={() => void callTool("cancel_trigger", { id: t.id })}>✕</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ORDER: Record<string, number> = { waiting_user: 0, running: 1, pending: 2, failed: 3, done: 4, cancelled: 5 };
const LABEL: Record<string, string> = { waiting_user: "needs you", running: "running", pending: "waiting", failed: "failed", done: "done", cancelled: "cancelled" };
const KIND_ICON: Record<string, string> = { handoff: "↗", approval: "✋", background: "⚙", helper: "🧩", answer: "💬", request: "▸" };

function TaskRow({ t }: { t: TaskEntry }) {
  const [open, setOpen] = useState(false);
  const set = useStore((s) => s.set);
  const ids = useStore((s) => s.canvasIds);
  const r = t.result;
  return (
    <li className={`task ${t.task.status}`}>
      <button className="task-main" onClick={() => setOpen(!open)}>
        <span className={`status-dot ${t.task.status}`} />
        <span className="task-text">
          <span className="task-title">{KIND_ICON[t.task.kind]} {t.task.title}</span>
          <span className="task-sub">{LABEL[t.task.status]}{t.task.summary ? ` · ${t.task.summary}` : ""}</span>
        </span>
      </button>
      {open && (
        <div className="task-detail">
          {t.task.status === "waiting_user" && r?.card && r.approval_id && (
            <button className="btn primary" onClick={() => {
              const s = useStore.getState();
              if (!s.modals.some((m) => m.approval_id === r.approval_id)) s.set({ modals: [...s.modals, { approval_id: r.approval_id!, card: r.card! }] });
            }}>Review</button>
          )}
          {r?.text && <p className="task-result">{r.text}</p>}
          {r?.link && <button className="btn primary" onClick={() => openLink(r.link!.href)}>{r.link.label ?? "Open link"}</button>}
          {r?.canvas_id && ids.includes(r.canvas_id) && (
            <button className="btn" onClick={() => {
              void api(`/api/canvas/${r.canvas_id}/show`, { method: "POST" });
              set({ page: 0, tasksOpen: false });
            }}>Show result</button>
          )}
          {!r && t.task.details && <p className="muted">{t.task.details}</p>}
          {t.task.depends_on.length > 0 && <p className="muted">after: {t.task.depends_on.join(", ")}</p>}
        </div>
      )}
    </li>
  );
}

export function TasksView() {
  const tasks = useStore((s) => s.tasks);
  const list = Object.values(tasks).sort(
    (a, b) => (ORDER[a.task.status] ?? 9) - (ORDER[b.task.status] ?? 9) || b.task.created_at.localeCompare(a.task.created_at),
  );
  const active = list.filter((t) => !["done", "cancelled", "failed"].includes(t.task.status)).length;
  return (
    <div className="tasks-panel">
      <Scheduled />
      <h2 className="panel-title">Tasks {list.length > 0 && <span className="muted">{active} open</span>}</h2>
      {list.length ? (
        <ul className="tasks">{list.map((t) => <TaskRow key={t.task.id} t={t} />)}</ul>
      ) : (
        <div className="empty tasks-empty"><div><div className="empty-title">No tasks yet</div><div className="empty-sub">Hold Talk and brain-dump your to-dos</div></div></div>
      )}
    </div>
  );
}

/** Tasks open as a sheet from the top bar's tasks button. */
export function TasksSheet() {
  const open = useStore((s) => s.tasksOpen);
  if (!open) return null;
  const close = () => useStore.getState().set({ tasksOpen: false });
  return (
    <div className="sheet-backdrop" onClick={close}>
      <div className="sheet tasks-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <TasksView />
      </div>
    </div>
  );
}
