import path from "node:path";
import { ToolMeta, type TaskJson, type TaskResult } from "@canvas-agent/contract";
import { lock, now, slugify, writeJson } from "./fsutil.ts";
import { appendTaskLog, listTaskIds, paths, writeTask } from "./store.ts";

/**
 * Foreground requests tracked as tasks automatically (kind "request").
 * The runner — not the model — decides: a request becomes a task as soon as it has a
 * visible or lasting effect. Pure lookups answered in words (search, fetch, python,
 * weather) stay out, as do brain-dumps (create_tasks makes its own tasks).
 */
/** Tools with a visible or lasting effect: declared once in the contract (ToolMeta), not listed here. */
function hasEffect(name: string): boolean {
  const m = (ToolMeta as Record<string, { effect: "screen" | "state" | "none" } | undefined>)[name];
  return !!m && m.effect !== "none";
}

const short = (s: string, n = 60) => {
  const first = s.replace(/\s+/g, " ").trim().split(/(?<=[.?!])\s/)[0] ?? s;
  return first.length > n ? `${first.slice(0, n - 1).trimEnd()}…` : first;
};

export class Activity {
  private id: string | null = null;
  private title: string | null = null;
  private facts: string[] = [];
  private errors: string[] = [];
  private result: TaskResult = {};
  private created = now();
  private done = false;

  constructor(private readonly request: string) {}

  /** Record a tool outcome; creates/updates the task once there is a visible effect. */
  async tool(name: string, args: unknown, out: unknown) {
    if (this.done || !hasEffect(name)) return;
    const a = (args ?? {}) as Record<string, unknown>;
    const o = (out ?? {}) as Record<string, unknown>;
    if (o.error) {
      // a failed attempt alone doesn't make a task (the model often retries); kept for the summary
      this.errors.push(`${name} failed: ${String(o.error).slice(0, 120)}`);
      return this.id ? this.save("running") : undefined;
    }
    this.errors = this.errors.filter((e) => !e.startsWith(`${name} failed`)); // retried successfully
    switch (name) {
      case "render": {
        const t = String(a.title ?? (a.spec as { title?: string } | undefined)?.title ?? "New view");
        this.title = t;
        this.result.canvas_id = String(o.canvas_id);
        this.facts.push(`Showed “${t}”${o.live ? " (live)" : ""}`);
        break;
      }
      case "pin":
        this.title ??= `Pin ${String(a.title ?? o.app_id)}`;
        this.facts.push(o.already_pinned ? `Already pinned (${String(o.app_id)})` : `Pinned to screen ${String(o.screen).replace(/^s/, "")}`);
        break;
      case "unpin":
        this.title ??= `Unpin ${String(a.app_id)}`;
        this.facts.push("Removed widget");
        break;
      case "make_live":
        this.title ??= "Make it live";
        this.facts.push(o.first_run === "failed" ? "Live update failed on first run" : "Live updates on");
        break;
      case "set_theme":
        this.title ??= `Theme: ${String(o.active_theme ?? a.name ?? "custom")}`;
        this.facts.push(`Theme “${String(o.active_theme ?? a.name)}”`);
        break;
      case "open_link":
        this.result.link = { href: String(a.href), kind: String(a.kind ?? "web"), label: "Open link" };
        this.facts.push("Link ready");
        break;
      case "ask_approval":
        this.facts.push(`Asked for approval: ${String((a.card as { title?: string } | undefined)?.title ?? "")}`);
        break;
      case "watch":
        this.title ??= `Alert: ${String(a.message)}`;
        this.facts.push(`Watching ${String(o.app_id)} (${String(a.path)} ${String(a.op)} ${String(a.value ?? "")})${o.pinned ? " — pinned so it keeps checking" : ""}`);
        break;
      case "unwatch":
        this.title ??= "Remove alert";
        this.facts.push(`Removed ${String(o.removed)} alert(s)`);
        break;
      case "schedule":
        this.title ??= `Scheduled: ${String(o.label ?? "")}`;
        this.facts.push(o.fires_at ? `Fires at ${new Date(String(o.fires_at)).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}` : `Repeats (${String(o.cron)})`);
        break;
      case "cancel_trigger":
        this.title ??= "Cancel scheduled item";
        this.facts.push("Cancelled");
        break;
      case "watch_email":
        this.title ??= String(o.label ?? "Email replies");
        this.facts.push("Watching the inbox");
        break;
      case "update_data":
        this.facts.push("Updated the data");
        break;
      default:
        this.facts.push(`${name.replace(/_/g, " ")} done`); // a tool with an effect but no bespoke wording yet
    }
    await this.save("running");
  }

  /** End of the request: done (or failed if every effect failed). */
  async finish(reply?: string) {
    if (this.done) return;
    this.done = true;
    if (!this.id && this.errors.length === 0) return; // nothing visible happened → quick answer, not a task
    const failed = this.facts.length === 0 && this.errors.length > 0;
    if (reply) this.result.text = reply;
    await this.save(failed ? "failed" : "done");
  }

  async fail(error: string) {
    if (this.done) return;
    this.done = true;
    if (!this.id) return;
    this.errors.push(error);
    await this.save("failed");
  }

  private async save(status: TaskJson["status"]) {
    const title = this.title ?? short(this.request);
    if (!this.id) {
      const taken = new Set(await listTaskIds());
      const base = `${this.created.slice(0, 10)}-${slugify(title, 36)}`;
      let id = base;
      for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
      this.id = id;
      await appendTaskLog(id, `request: ${this.request.slice(0, 300)}`);
    }
    const id = this.id;
    await lock(`activity:${id}`, async () => {
      const task: TaskJson = {
        schema_version: 1, id, title, status, kind: "request", details: this.request.slice(0, 500),
        depends_on: [], created_at: this.created, updated_at: now(),
        summary: [...this.facts, ...this.errors].join(" · ") || undefined,
      };
      await writeTask(task);
      await writeJson(path.join(paths.taskDir(id), "result.json"), this.result);
    });
  }
}
