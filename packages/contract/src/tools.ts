import { z } from "zod";
import { ApprovalField, LinkKind } from "./canvas.ts";
import { Source, TaskKind, TaskResult, TaskStatus, ThemeColors, TriggerAction, WatchOp, WidgetSize } from "./files.ts";

/**
 * The brain-facing tool contract (B7). Single source of truth for the voice
 * session, the text brain and sub-agents.
 */
const SpecArg = z
  .object({
    title: z.string().optional(),
    root: z.string(),
    components: z.record(
      z.string(),
      z.object({ type: z.string(), props: z.record(z.string(), z.unknown()).optional(), children: z.array(z.string()).optional() }),
    ),
  })
  .describe("Canvas spec: flat component map keyed by id, `root` id. Props may be {\"$bind\":\"/pointer\"} into data.");

const ApprovalCardArg = z.object({
  title: z.string(),
  body: z.string(),
  fields: z.array(ApprovalField).optional(),
  actions: z.array(z.enum(["accept", "modify", "reject"])).optional(),
});

export const ToolArgs = {
  render: z.object({
    spec: SpecArg,
    data: z.record(z.string(), z.unknown()).describe("Data model the spec binds into."),
    title: z.string().optional(),
    source: Source.optional().describe("Optional live data source staged for pin/make_live."),
  }),
  update_data: z.object({
    target: z.string().describe("canvas id (e.g. 0042) or app id (slug)"),
    patch: z.record(z.string(), z.unknown()).describe("JSON Merge Patch applied to data.json"),
  }),
  pin: z.object({
    canvas_id: z.string().optional().describe("Defaults to the current canvas"),
    title: z.string().optional(),
    slug: z.string().optional().describe("Short kebab-case id, e.g. aapl-ticker"),
    size: WidgetSize.optional().describe("S small 2×2, W wide 4×2, L large 4×4, T tall 2×4 (grid 4×6). Omit to pick from the content (metric→S, chart→W, list/cards/form→L)."),
  }),
  resize_widget: z.object({ app_id: z.string(), size: WidgetSize.describe("S small, W wide, L large, T tall") }),
  unpin: z.object({ app_id: z.string() }),
  make_live: z.object({
    target: z.string().optional().describe("canvas id or app id; defaults to the current canvas"),
    source: Source.describe(
      "python: code that prints ONE JSON object to stdout (merged into data.json) — or writes data.json itself. http: URL fetched as JSON; json_path picks a sub-object.",
    ),
  }),
  undo: z.object({}),
  create_tasks: z.object({
    tasks: z
      .array(
        z.object({
          key: z.string().optional().describe("Short local key so other tasks can reference this one in depends_on"),
          title: z.string(),
          kind: TaskKind,
          details: z.string().describe("Everything a sub-agent needs to complete the task alone"),
          depends_on: z.array(z.string()).optional().describe("keys or existing task ids"),
        }),
      )
      .min(1),
  }),
  resolve_approval: z.object({
    approval: z.string().optional().describe("approval id, or words from its title that single out ONE card (every word you pass must be in that title, e.g. 'Call Mark'); omit for the most recent pending card. If none or several cards match, the candidates come back and you must pass an approval_id."),
    action: z.enum(["edit", "accept", "reject", "undo"]),
    fields: z.record(z.string(), z.string()).optional().describe("For edit (or accept with last-second edits): field name → full new value, e.g. {body: '…Sunday…'}. Private fields (to, phone) can't be changed by voice."),
  }),
  focus_approval: z.object({ approval: z.string().optional() }),
  amend_task: z.object({
    id: z.string().describe("Task id (from create_tasks results or get_state tasks)"),
    change: z.string().describe("What the user changed, in their words plus any detail needed (e.g. 'make it Sunday instead of Saturday')"),
  }),
  cancel_task: z.object({ id: z.string(), reason: z.string().optional() }),
  update_task: z.object({ id: z.string(), status: TaskStatus, summary: z.string().optional(), result: TaskResult.optional() }),
  get_state: z.object({ scope: z.enum(["tasks", "apps", "canvas", "screens", "approvals"]) }),
  ask_approval: z.object({ card: ApprovalCardArg, modal: z.boolean().optional() }),
  notify: z.object({
    text: z.string(),
    kind: z.enum(["info", "success", "warn", "error"]).optional(),
    sound: z.enum(["ding", "success", "error", "pop"]).optional(),
  }),
  set_theme: z.object({
    name: z.string().optional().describe("Existing theme name, or the name for new tokens"),
    tokens: z
      .object({
        colors: ThemeColors.partial().optional().describe("CSS colors (hex). chart = 5 series colors"),
        dark: ThemeColors.partial().optional().describe("Same keys for dark mode"),
        radius: z.number().optional().describe("Corner radius in px (0–32, default 16)"),
        font: z.string().optional().describe("CSS font-family stack"),
        spacing: z.number().optional().describe("Base spacing in px (12–24, default 16)"),
      })
      .optional(),
  }),
  open_link: z.object({ href: z.string(), kind: LinkKind }),
  fetch_json: z.object({ url: z.string().url(), headers: z.record(z.string(), z.string()).optional() }),
  run_python: z.object({ code: z.string(), timeout_s: z.number().int().min(1).max(120).optional() }),
  call_contact: z.object({
    contact: z.string().describe("The person's NAME as in contacts (never a number)"),
    reason: z.string().optional().describe("What the call is about (shown on the card)"),
  }),
  send_email: z.object({
    to: z.string().optional().describe("Recipient NAME as in contacts (never an address). Omit when replying."),
    reply_to_uid: z.number().int().optional().describe("uid from find_emails to reply to that message (recipient and subject come from it)"),
    subject: z.string().describe("Subject (for replies you may pass an empty string to reuse 'Re: …')"),
    body: z.string().describe("Plain-text email body, signed as the user"),
  }),
  watch: z.object({
    target: z.string().optional().describe("app id or canvas id (default: current canvas; a canvas gets pinned so it keeps checking)"),
    path: z.string().describe("JSON pointer of the value in the widget's data, e.g. /price (see the spec's $bind paths)"),
    op: WatchOp,
    value: z.union([z.number(), z.string(), z.boolean()]).optional().describe("Threshold (omit for 'changed')"),
    message: z.string().describe("Notification text, e.g. 'Apple dropped below $120'"),
    mode: z.enum(["cross", "once"]).optional().describe("cross (default): notify each time it becomes true; once: notify once then remove"),
    cooldown_s: z.number().int().min(0).optional(),
  }),
  unwatch: z.object({ target: z.string(), id: z.string().optional().describe("rule id; omit to remove all") }),
  schedule: z.object({
    when: z.object({
      in_s: z.number().min(1).optional().describe("seconds from now"),
      at: z.string().optional().describe("local time 'HH:MM' (next occurrence) or ISO date-time"),
      cron: z.string().optional().describe("recurring, cron syntax in local time, e.g. '0 8 * * 1-5' = weekdays 8:00"),
    }),
    action: TriggerAction,
    label: z.string().optional().describe("short name shown in the Scheduled list"),
  }),
  list_triggers: z.object({}),
  cancel_trigger: z.object({ id: z.string() }),
  watch_email: z.object({
    from: z.string().optional().describe("contact NAME whose emails should get a drafted reply"),
    contains: z.string().optional().describe("only emails mentioning these words"),
    any: z.boolean().optional().describe("every email that needs a reply (newsletters/spam are filtered)"),
    instructions: z.string().optional().describe("how to reply, e.g. 'keep it short, sign as Arnau'"),
  }),
  ui_action: z.object({
    target: z.string().optional().describe("canvas id or pinned app id (default: the current canvas)"),
    component_id: z.string().optional().describe("which component (default: the only interactive one)"),
    action: z.string().describe("CardStack: done|later|discard|reset · Checklist: check|uncheck|toggle|add|remove|reset · Notebook: append|edit|remove|clear · Form: set_field|submit"),
    args: z.record(z.string(), z.unknown()).optional().describe("item by text or id: {text:'Passport'}; add/append: {text} or {items:[…]}/{lines:[…]}; edit: {match, new_text}; set_field: {name, value}. Omit for the top card."),
  }),
  read_widget: z.object({ target: z.string().optional().describe("canvas id or app id (default: the current canvas)") }),
  find_emails: z.object({
    from: z.string().optional().describe("Sender NAME as in contacts"),
    query: z.string().optional().describe("Words to search for"),
    limit: z.number().int().min(1).max(10).optional(),
  }),
} as const;

export type ToolName = keyof typeof ToolArgs;
export type ToolArgsOf<N extends ToolName> = z.infer<(typeof ToolArgs)[N]>;
export const TOOL_NAMES = Object.keys(ToolArgs) as ToolName[];

export const ToolDescriptions: Record<ToolName, string> = {
  render:
    "Render UI on the user's canvas (creates a new canvas). Use the component catalog. Put values in `data` and bind with {\"$bind\":\"/path\"}. Returns {canvas_id}.",
  update_data: "Merge-patch the data of a canvas or pinned app; the UI re-renders.",
  pin: "Pin a canvas (default: current) as a persistent widget on the first free screen slot. Returns {app_id, screen, slot}.",
  unpin: "Remove a pinned widget (moves it to trash, stops its live job).",
  resize_widget:
    "Change a pinned widget's size when the user asks ('make it bigger/wider/smaller/taller'). Others are rearranged to fit; it may move to the next screen if there's no room.",
  make_live:
    "Make a canvas or pinned app update itself on a schedule (refresh_s 30–86400). Python code must print a single JSON object (a merge patch for data.json) to stdout. Runs once immediately and reports.",
  undo: "Show the previous canvas again.",
  create_tasks:
    "Create tasks from what the user asked. Find dependencies (depends_on). Independent tasks run in parallel in the background via sub-agents; you are told when each finishes.",
  resolve_approval:
    "The user answers a pending approval card by voice/text. edit = change fields (the card updates live, still pending). accept = approve: it runs after a 5-second Undo window shown on the card. reject = decline now. undo = cancel a voice approval still in its 5 s window. Only accept on a clear instruction ('send it', 'yes, call him'); if unsure, ask.",
  focus_approval: "Bring a pending approval card onto the user's screen (use when you start talking about it).",
  amend_task:
    "The user corrected something already delegated ('actually…', 'make it Sunday instead'). Updates that task and redoes it (stops the running work, withdraws a pending card). Use this instead of creating a duplicate task.",
  cancel_task: "The user called off something already delegated ('never mind the route'). Stops it and withdraws any pending card.",
  update_task: "Update a task's status, summary and result.",
  get_state: "Compact summary of tasks, pinned apps, the current canvas or screens.",
  ask_approval:
    "Show an approval card (accept / modify / reject) to the user for consents OTHER than calls/emails (those tools show their own card). Resolves later with the user's choice and edited fields.",
  notify: "Show a short toast on the phone, optionally with a sound.",
  set_theme: "Switch theme by name, or write new design tokens (colors etc.) under a name and switch to it.",
  open_link: "Open a deep link on the phone (Google Maps, tel:, mailto:, web).",
  fetch_json: "Fetch a JSON URL from the backend (10 s timeout).",
  run_python:
    "Run Python 3 in the backend venv (yfinance, requests, pandas available). Returns stdout/stderr/exit_code. Network allowed.",
  call_contact:
    "Prepare a phone call to a contact by NAME. The device fills in the number (asks the user if it's missing), shows a confirmation card, and gives the user a Call button. Returns immediately; the outcome is reported later.",
  send_email:
    "Send an email to a contact by NAME, or reply to a message from find_emails (reply_to_uid). The device fills in the address (asks if missing) and shows the full email for the user to accept/edit/reject; nothing is sent without approval. Returns immediately; the outcome is reported later.",
  watch:
    "Notify the user (push notification + in-app) when a live widget's value meets a condition, checked after every refresh. Needs a live source (make_live first if needed). For complex conditions instead write the fetch code so it prints `_alerts: [{id, message}]` for conditions currently true.",
  unwatch: "Remove a watch (condition) from a widget.",
  schedule:
    "Do something later or repeatedly: notify (push notification + toast), speak (said aloud if the user is in a voice call or has the app open; otherwise a notification), or task (run a background task). Persists across restarts.",
  list_triggers: "List scheduled and email triggers.",
  cancel_trigger: "Cancel a scheduled or email trigger.",
  watch_email: "When matching emails arrive, draft a reply automatically and put it on the user's screen for approval (never sent without approval).",
  ui_action:
    "Do what a tap on a widget does: mark a card done/later/discard, check or add checklist items, append to a notebook, fill a form. The phone updates instantly. Use read_widget first to see the items.",
  read_widget: "Read the current items/state of the interactive widgets on a canvas or pinned app (e.g. which cards are left, in order).",
  find_emails:
    "Read recent inbox emails (optionally from a contact by NAME, or matching words). Senders are shown by name; use the uid with send_email to reply.",
};

/**
 * Per-tool metadata the runner derives behaviour from. TypeScript makes every new tool declare it,
 * so nothing has to be registered by hand in activity.ts or the voice code.
 *  effect — "screen": changes what the user sees; "state": a lasting change (pins, schedules, watches);
 *           "none": a lookup, a message, or something tracked elsewhere (tasks, calls/emails, widget taps).
 *           A request becomes a tracked task once a tool with an effect succeeds (runner/src/activity.ts).
 *  busy   — label shown on the phone while the tool runs (default "Working…").
 */
export const ToolMeta: Record<ToolName, { effect: "screen" | "state" | "none"; busy?: string }> = {
  render: { effect: "screen", busy: "Drawing…" },
  update_data: { effect: "screen" },
  pin: { effect: "state", busy: "Pinning…" },
  resize_widget: { effect: "none" },
  unpin: { effect: "state" },
  make_live: { effect: "state", busy: "Making it live…" },
  undo: { effect: "none" },
  create_tasks: { effect: "none", busy: "Planning tasks…" },
  resolve_approval: { effect: "none" },
  focus_approval: { effect: "none" },
  amend_task: { effect: "none" },
  cancel_task: { effect: "none" },
  update_task: { effect: "none" },
  get_state: { effect: "none" },
  ask_approval: { effect: "screen" },
  notify: { effect: "none" },
  set_theme: { effect: "screen" },
  open_link: { effect: "screen" },
  fetch_json: { effect: "none", busy: "Fetching…" },
  run_python: { effect: "none", busy: "Running code…" },
  call_contact: { effect: "none" },
  send_email: { effect: "none" },
  watch: { effect: "state" },
  unwatch: { effect: "state" },
  schedule: { effect: "state" },
  list_triggers: { effect: "none" },
  cancel_trigger: { effect: "state" },
  watch_email: { effect: "state" },
  ui_action: { effect: "none" },
  read_widget: { effect: "none" },
  find_emails: { effect: "none" },
};

/** Helper tools only available to sub-agents (B11). */
export const HelperArgs = {
  weather: z.object({
    place: z.string().optional(),
    lat: z.number().optional(),
    lon: z.number().optional(),
    days: z.number().int().min(1).max(16).optional().describe("Days from today (default 7). Ignored when start/end are set."),
    start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD, e.g. next Monday for 'next week' (max 15 days ahead)"),
    end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD inclusive"),
  }),
  maps_link: z.object({ from: z.string().optional(), to: z.string(), mode: z.enum(["driving", "walking", "bicycling", "transit"]).optional() }),
} as const;
export type HelperName = keyof typeof HelperArgs;
export const HelperDescriptions: Record<HelperName, string> = {
  weather: "Daily forecast from Open-Meteo for a place name or lat/lon, for the next N days or a start/end date range (e.g. next week = next Monday..Sunday). Returns days, max/min °C, rain %, conditions and chart_data {days, series} ready for a Chart.",
  maps_link: "Build a Google Maps directions deep link. `from` defaults to the user's current location; pass the travel mode the user prefers (see their profile) or omit it for the Maps default.",
};

export interface ToolDef { name: string; description: string; parameters: Record<string, unknown> }

export function toolDefs(names: readonly ToolName[] = TOOL_NAMES): ToolDef[] {
  return names.map((n) => ({ name: n, description: ToolDescriptions[n], parameters: z.toJSONSchema(ToolArgs[n], { io: "input" }) as Record<string, unknown> }));
}
export function helperDefs(): ToolDef[] {
  return (Object.keys(HelperArgs) as HelperName[]).map((n) => ({
    name: n, description: HelperDescriptions[n], parameters: z.toJSONSchema(HelperArgs[n], { io: "input" }) as Record<string, unknown>,
  }));
}

/** Tools that may exceed ~1 s: they return {status:"started", ref} and inject the result later. */
export const ASYNC_TOOLS: readonly ToolName[] = ["create_tasks", "ask_approval", "call_contact", "send_email"];
