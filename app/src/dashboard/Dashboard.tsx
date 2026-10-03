import { useEffect, useState } from "react";
import type { ActivityEntry } from "@canvas-agent/contract";
import { api, token } from "../lib/api.ts";
import { connectBus } from "../lib/bus.ts";
import { useStore } from "../lib/store.ts";
import { applyTheme } from "../lib/theme.ts";
import "./dashboard.css";

interface Job { key: string; refresh_s: number; source: string; runs: number; last_run: string | null; last_ok: string | null; last_error: string | null; last_ms: number | null; running: boolean }
interface Monitor {
  started_at: string;
  clients: number;
  routes: Record<string, { model: string; reasoning: string | null }>;
  jobs: Job[];
  sessions: { voice: { id: string; started_at: string }[]; text: string[] };
  approvals: { approval_id: string; title: string }[];
  activity: ActivityEntry[];
}

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const ago = (iso: string | null | undefined, now: number) => {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};
const dur = (iso: string, now: number) => {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clock = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour12: false });
const STATUS_ORDER: Record<string, number> = { running: 0, waiting_user: 1, pending: 2, failed: 3, done: 4, cancelled: 5 };

/** Server dashboard: what the runner is doing, live. Same origin + token as the app. */
export function Dashboard() {
  const connected = useStore((s) => s.connected);
  const tasks = useStore((s) => s.tasks);
  const apps = useStore((s) => s.apps);
  const canvas = useStore((s) => s.canvas);
  const theme = useStore((s) => s.theme);
  const live = useStore((s) => s.activity);
  const triggers = useStore((s) => s.triggers);
  const [mon, setMon] = useState<Monitor | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const now = useNow();

  useEffect(() => {
    if (!token) return;
    connectBus();
    const load = () =>
      api<Monitor>("/api/monitor")
        .then((m) => (setMon(m), setErr(null)))
        .catch((e) => setErr(String(e instanceof Error ? e.message : e)));
    void load();
    const t = setInterval(load, 4000); // jobs/sessions snapshot; activity itself streams on the bus
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  if (!token) return <main className="db-empty">Open the pairing link once on this device (it stores the token), then go to <code>/dashboard</code>.</main>;

  // merge the initial snapshot with live entries (dedupe by id)
  const seen = new Set<number>();
  const activity = [...(mon?.activity ?? []), ...live]
    .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    .sort((a, b) => b.id - a.id)
    .slice(0, 200);
  const taskList = Object.values(tasks).sort(
    (a, b) => (STATUS_ORDER[a.task.status] ?? 9) - (STATUS_ORDER[b.task.status] ?? 9) || b.task.updated_at.localeCompare(a.task.updated_at),
  );
  const fresh = (iso: string) => now - Date.parse(iso) < 4000;

  return (
    <div className="db">
      <header className="db-head">
        <h1>Canvas Agent <span>server</span></h1>
        <div className="db-pills">
          <span className={`pill ${connected ? "ok" : "bad"}`}>{connected ? "● live" : "○ offline"}</span>
          {mon && <span className="pill">{mon.clients} connection{mon.clients === 1 ? "" : "s"}</span>}
          {mon && <span className="pill">up {dur(mon.started_at, now)}</span>}
          {mon && Object.entries(mon.routes).map(([k, r]) => <span key={k} className="pill muted">{k}: {r.model}{r.reasoning ? `@${r.reasoning}` : ""}</span>)}
          {err && <span className="pill bad">{err}</span>}
        </div>
      </header>

      <main className="db-grid">
        <section className="db-card db-activity">
          <h2>Activity <small>{activity.length}</small></h2>
          <ol>
            {activity.map((e) => (
              <li key={e.id} className={`act ${e.kind} ${e.ok ? "" : "err"} ${fresh(e.at) ? "fresh" : ""}`}>
                <time>{clock(e.at)}</time>
                <span className="badge">{e.kind}</span>
                <span className="act-main">
                  <b>{e.title}</b>
                  {e.detail && <span className="act-detail">{e.detail}</span>}
                </span>
                <span className="act-meta">{e.ms != null ? `${e.ms} ms` : ""}{e.actor ? <em>{e.actor.replace(/^live_/, "voice ").slice(0, 22)}</em> : null}</span>
              </li>
            ))}
            {!activity.length && <li className="db-none">Nothing yet — talk to the app.</li>}
          </ol>
        </section>

        <section className="db-card">
          <h2>Tasks <small>{taskList.filter((t) => t.task.status !== "done").length} open · {taskList.length} total</small></h2>
          <ul className="db-list">
            {taskList.map((t) => (
              <li key={t.task.id} className={fresh(t.task.updated_at) ? "fresh" : ""}>
                <span className={`status-dot ${t.task.status}`} />
                <span className="grow">
                  <b>{t.task.title}</b>
                  <span className="muted">{t.task.status.replace("_", " ")} · {t.task.kind}{t.task.summary ? ` · ${t.task.summary}` : ""}</span>
                </span>
                <span className="muted small">{ago(t.task.updated_at, now)}</span>
              </li>
            ))}
            {!taskList.length && <li className="db-none">No tasks</li>}
          </ul>
          {!!mon?.approvals.length && (
            <>
              <h3>Waiting for approval</h3>
              <ul className="db-list">{mon.approvals.map((a) => <li key={a.approval_id}><span className="status-dot waiting_user" /><b className="grow">{a.title}</b></li>)}</ul>
            </>
          )}
        </section>

        <section className="db-card">
          <h2>Live jobs <small>{mon?.jobs.length ?? 0}</small></h2>
          <ul className="db-list">
            {mon?.jobs.map((j) => {
              const since = j.last_run ? (now - Date.parse(j.last_run)) / 1000 : 0;
              const pct = Math.min(100, (since / j.refresh_s) * 100);
              return (
                <li key={j.key} className={`job ${j.running ? "running" : ""} ${j.last_error ? "err" : ""}`}>
                  <span className={`live-dot ${j.last_error ? "err" : ""}`} />
                  <span className="grow">
                    <b>{j.key}</b>
                    <span className="muted">every {j.refresh_s}s · {j.runs} runs · last {ago(j.last_run, now)}{j.last_ms != null ? ` (${j.last_ms} ms)` : ""}</span>
                    {j.last_error && <span className="err-text">{j.last_error}</span>}
                    <span className="bar"><span style={{ width: `${pct}%` }} /></span>
                  </span>
                </li>
              );
            })}
            {!mon?.jobs.length && <li className="db-none">No live data sources</li>}
          </ul>

          <h3>Scheduled</h3>
          <ul className="db-list">
            {triggers.map((t) => (
              <li key={t.id}><span className="status-dot running" /><span className="grow"><b>{t.label}</b><span className="muted">{t.source} · {t.cron ?? (t.at ? `at ${new Date(t.at).toLocaleTimeString("en-GB")}` : "on email")} · fired {t.fired}×</span></span></li>
            ))}
            {!triggers.length && <li className="db-none">Nothing scheduled</li>}
          </ul>

          <h3>Sessions</h3>
          <ul className="db-list">
            {mon?.sessions.voice.map((v) => (
              <li key={v.id}><span className="live-dot" /><span className="grow"><b>Voice</b><span className="muted">{v.id.slice(0, 24)}</span></span><span className="muted small">{dur(v.started_at, now)}</span></li>
            ))}
            <li><span className="status-dot pending" /><span className="grow"><b>Text</b><span className="muted">{mon?.sessions.text.length ?? 0} conversation(s) this run</span></span></li>
          </ul>

          <h3>On screen</h3>
          <ul className="db-list">
            <li><span className="status-dot done" /><span className="grow"><b>Canvas {canvas?.id ?? "—"}</b><span className="muted">{canvas?.meta.title ?? canvas?.spec.title ?? "empty"}{canvas?.meta.source ? ` · live every ${canvas.meta.source.refresh_s}s` : ""}</span></span></li>
            {Object.values(apps).map((a) => (
              <li key={a.id}><span className={a.app.refresh_s ? "live-dot" : "status-dot pending"} /><span className="grow"><b>{a.app.title}</b><span className="muted">widget · screen {a.app.screen.replace(/^s/, "")} · {a.app.layout?.size ?? "S"}{a.job?.last_ok ? ` · updated ${ago(a.job.last_ok, now)}` : ""}</span></span></li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
