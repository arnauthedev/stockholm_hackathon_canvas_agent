/**
 * Widget actions — one reducer shared by the phone (optimistic taps) and the runner (taps,
 * voice and text). Interactive state lives in the widget's data under `_ui[component_id]`,
 * so it is the same on every device and visible to the agent. Pure functions only.
 */
export const UI_KEY = "_ui";

export const COMPONENT_ACTIONS = {
  CardStack: ["done", "later", "discard", "reset"],
  Checklist: ["check", "uncheck", "toggle", "add", "remove", "reset"],
  Notebook: ["append", "edit", "remove", "clear"],
  Form: ["set_field", "submit"],
} as const;
export type InteractiveType = keyof typeof COMPONENT_ACTIONS;
export const isInteractive = (t: string): t is InteractiveType => t in COMPONENT_ACTIONS;

export interface UiBase { applied?: string[] }
interface Card { id: string; title: string; body?: string; icon?: string }
interface CardStackUi extends UiBase { handled?: Record<string, "done" | "discard">; later?: string[] }
interface CheckItem { id: string; text: string; done?: boolean }
interface ChecklistUi extends UiBase { checked?: Record<string, boolean>; added?: CheckItem[]; removed?: string[] }
interface Line { id: string; text: string }
interface NotebookUi extends UiBase { lines?: Line[] }
interface FormUi extends UiBase { values?: Record<string, unknown>; submitted?: boolean }

const arr = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim();
let counter = 0;
const newId = () => `i${Date.now().toString(36)}${(counter++).toString(36)}`;

/** Find an item by id, exact text, or text containment (both directions). */
function pick<T extends { id: string }>(items: T[], text: (t: T) => string, args: Record<string, unknown>): T | undefined {
  const id = args.id ?? args.item_id ?? args.card_id;
  if (typeof id === "string") {
    const byId = items.find((i) => i.id === id);
    if (byId) return byId;
  }
  const q = typeof (args.text ?? args.title ?? id) === "string" ? norm(String(args.text ?? args.title ?? id)) : "";
  if (!q) return undefined;
  return items.find((i) => norm(text(i)) === q) ?? items.find((i) => norm(text(i)).includes(q) || q.includes(norm(text(i))));
}

// ---------------- effective state (what is shown / what the agent reads) ----------------
export function cardStackState(props: Record<string, unknown>, ui: CardStackUi) {
  const all = arr<Card>(props.cards);
  const handled = ui.handled ?? {};
  const later = ui.later ?? [];
  const open = all.filter((c) => !handled[c.id]);
  const remaining = [...open.filter((c) => !later.includes(c.id)), ...later.map((id) => open.find((c) => c.id === id)).filter((c): c is Card => !!c)];
  return { remaining, done: all.filter((c) => handled[c.id] === "done"), discarded: all.filter((c) => handled[c.id] === "discard"), total: all.length };
}
export function checklistState(props: Record<string, unknown>, ui: ChecklistUi) {
  const base = arr<{ id?: string; text?: string; title?: string; done?: boolean }>(props.items).map((it, i) => ({ id: it.id ?? `p${i}`, text: String(it.text ?? it.title ?? ""), done: !!it.done }));
  const items = [...base, ...(ui.added ?? [])].filter((i) => !(ui.removed ?? []).includes(i.id));
  return { items: items.map((i) => ({ ...i, done: ui.checked?.[i.id] ?? !!i.done })) };
}
export function notebookState(props: Record<string, unknown>, ui: NotebookUi) {
  const base = arr<string | Line>(props.lines).map((l, i) => (typeof l === "string" ? { id: `p${i}`, text: l } : { id: l.id ?? `p${i}`, text: String(l.text ?? "") }));
  return { lines: ui.lines ?? base };
}
export function formState(props: Record<string, unknown>, ui: FormUi) {
  const fields = arr<{ name: string; value?: unknown }>(props.fields);
  return { values: { ...Object.fromEntries(fields.map((f) => [f.name, f.value ?? ""])), ...(ui.values ?? {}) }, submitted: !!ui.submitted };
}

export function effectiveState(type: string, props: Record<string, unknown>, ui: unknown): Record<string, unknown> | null {
  const u = (ui ?? {}) as Record<string, unknown>;
  switch (type) {
    case "CardStack": return cardStackState(props, u);
    case "Checklist": return checklistState(props, u);
    case "Notebook": return notebookState(props, u);
    case "Form": return formState(props, u);
    default: return null;
  }
}

// ---------------- reducer ----------------
export type ActionResult = { ui: Record<string, unknown> } | { error: string };

export function applyUiAction(type: string, props: Record<string, unknown>, ui: unknown, action: string, args: Record<string, unknown> = {}): ActionResult {
  if (!isInteractive(type)) return { error: `${type} has no actions` };
  if (!(COMPONENT_ACTIONS[type] as readonly string[]).includes(action)) return { error: `${type} actions are: ${COMPONENT_ACTIONS[type].join(", ")}` };
  const u = structuredClone((ui ?? {}) as Record<string, unknown>);

  if (type === "CardStack") {
    const s = u as CardStackUi;
    if (action === "reset") return { ui: { applied: s.applied } };
    const st = cardStackState(props, s);
    // default target: the card on top
    const card = args.id || args.card_id || args.text || args.title ? pick(st.remaining, (c) => c.title, args) : st.remaining[0];
    if (!card) return { error: st.remaining.length ? "no matching card" : "no cards left" };
    if (action === "later") s.later = [...(s.later ?? []).filter((id) => id !== card.id), card.id];
    else {
      s.handled = { ...(s.handled ?? {}), [card.id]: action as "done" | "discard" };
      s.later = (s.later ?? []).filter((id) => id !== card.id);
    }
    return { ui: s as Record<string, unknown> };
  }

  if (type === "Checklist") {
    const s = u as ChecklistUi;
    if (action === "reset") return { ui: { applied: s.applied } };
    if (action === "add") {
      const texts = arr<string>(args.items).length ? arr<string>(args.items) : [String(args.text ?? "")];
      const add = texts.map((t) => t.trim()).filter(Boolean).map((text) => ({ id: newId(), text, done: false }));
      if (!add.length) return { error: "nothing to add (give text)" };
      s.added = [...(s.added ?? []), ...add];
      return { ui: s as Record<string, unknown> };
    }
    const item = pick(checklistState(props, s).items, (i) => i.text, args);
    if (!item) return { error: "no matching item" };
    if (action === "remove") s.removed = [...(s.removed ?? []), item.id];
    else s.checked = { ...(s.checked ?? {}), [item.id]: action === "toggle" ? !item.done : action === "check" };
    return { ui: s as Record<string, unknown> };
  }

  if (type === "Notebook") {
    const s = u as NotebookUi;
    const lines = notebookState(props, s).lines;
    if (action === "clear") return { ui: { ...s, lines: [] } };
    if (action === "append") {
      const texts = arr<string>(args.lines).length ? arr<string>(args.lines) : [String(args.text ?? "")];
      const add = texts.map((t) => t.trim()).filter(Boolean).map((text) => ({ id: newId(), text }));
      if (!add.length) return { error: "nothing to append (give text)" };
      return { ui: { ...s, lines: [...lines, ...add] } };
    }
    const line = pick(lines, (l) => l.text, args.match ? { text: args.match } : args);
    if (!line) return { error: "no matching line" };
    if (action === "remove") return { ui: { ...s, lines: lines.filter((l) => l.id !== line.id) } };
    return { ui: { ...s, lines: lines.map((l) => (l.id === line.id ? { ...l, text: String(args.new_text ?? args.text ?? l.text) } : l)) } };
  }

  // Form
  const s = u as FormUi;
  if (action === "set_field") {
    if (typeof args.name !== "string") return { error: "set_field needs name" };
    return { ui: { ...s, values: { ...(s.values ?? {}), [args.name]: args.value } } };
  }
  return { ui: { ...s, submitted: true } };
}

/** Compact, model-friendly summary of a component's state. */
export function describeState(type: string, state: Record<string, unknown> | null): unknown {
  if (!state) return null;
  if (type === "CardStack") {
    const s = state as ReturnType<typeof cardStackState>;
    return { remaining_in_order: s.remaining.map((c) => c.title), done: s.done.map((c) => c.title), discarded: s.discarded.map((c) => c.title) };
  }
  if (type === "Checklist") return { items: (state as ReturnType<typeof checklistState>).items.map((i) => `${i.done ? "[x]" : "[ ]"} ${i.text}`) };
  if (type === "Notebook") return { lines: (state as ReturnType<typeof notebookState>).lines.map((l) => l.text) };
  return state;
}
