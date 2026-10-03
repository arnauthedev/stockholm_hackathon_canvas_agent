import { randomBytes } from "node:crypto";
import type { UiEvent } from "@canvas-agent/contract";
import { bus } from "./bus.ts";
import { pushAll } from "./push.ts";

export interface ApprovalOutcome { action: "accept" | "modify" | "reject" | "dismiss"; fields?: Record<string, string> }

interface Field { name: string; label?: string; value: string; editable?: boolean; private?: boolean }
interface Pending {
  resolve: (o: ApprovalOutcome) => void;
  card: Record<string, unknown>;
  created: number;
  commit?: { timer: NodeJS.Timeout; until: number }; // voice approval waiting out its undo window
}

/** Pending approval cards. Resolved by taps (ui.event approval.*) or by voice (resolve_approval). */
const pending = new Map<string, Pending>();
export const UNDO_MS = 5000;
/**
 * Private fields (values the runner filled in: numbers, addresses) are never shown to or changed by the
 * model. The runner marks them explicitly (`private: true`, see actions.ts); the name list is only a
 * fallback for cards that carry no flag.
 */
const PRIVATE_NAMES = /^(to|phone|number|email|address|cc|bcc)$/i;
const isPrivate = (f: Field) => f.private ?? PRIVATE_NAMES.test(f.name);

export function requestApproval(card: Record<string, unknown>, opts: { modal?: boolean; id?: string } = {}) {
  const approval_id = opts.id ?? `ap-${randomBytes(4).toString("hex")}`;
  const promise = new Promise<ApprovalOutcome>((resolve) => pending.set(approval_id, { resolve, card, created: Date.now() }));
  if (opts.modal !== false) {
    bus.emit({ type: "modal", approval_id, card });
    void pushAll({ title: "Needs your OK", body: String(card.title ?? "Approval waiting"), url: "/#approval", tag: `approval-${approval_id}` });
  }
  return { approval_id, promise };
}

function settle(id: string, o: ApprovalOutcome) {
  const p = pending.get(id);
  if (!p) return false;
  if (p.commit) clearTimeout(p.commit.timer);
  pending.delete(id);
  p.resolve(o);
  bus.emit({ type: "modal.close", approval_id: id });
  return true;
}

const fieldsOf = (p: Pending) => ((p.card.fields as Field[] | undefined) ?? []);
const valuesOf = (p: Pending) => Object.fromEntries(fieldsOf(p).map((f) => [f.name, f.value]));

/** Taps from the phone. Returns true if the event concerned a pending approval. */
export function handleApprovalEvent(e: UiEvent): boolean {
  if (!e.event.startsWith("approval.")) return false;
  const id = e.approval_id ?? e.component_id;
  if (!pending.has(id)) return false;
  const action = e.event.slice("approval.".length);
  if (action === "undo") return cancelCommit(id), true;
  const payload = (e.payload ?? {}) as { fields?: Record<string, string> };
  settle(id, { action: action as ApprovalOutcome["action"], fields: payload.fields });
  return true;
}

export type ApprovalLookup = { id: string } | { error: string; candidates: { approval_id: string; title: string }[] };

/**
 * Which pending card the model means: an approval id, nothing (= the most recent card), "latest",
 * or words from a title. Every word given must appear in the title, and exactly one card may match;
 * otherwise the candidates come back instead of a guess, so "reject the email" can never hit a
 * different card. (Counting overlapping words was tried first: a shared "the" picked the wrong card.)
 */
export function findApproval(q?: string): ApprovalLookup {
  const all = [...pending.entries()].sort((a, b) => b[1].created - a[1].created);
  const candidates = all.map(([approval_id, p]) => ({ approval_id, title: String(p.card.title ?? "") }));
  if (!all.length) return { error: "no pending approval cards", candidates };
  const query = (q ?? "").trim();
  if (!query || /^(latest|last)$/i.test(query)) return { id: all[0]![0] };
  if (pending.has(query)) return { id: query };
  const tokens = (s: string) => s.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const words = tokens(query);
  const matches = words.length ? candidates.filter((c) => words.every((w) => tokens(c.title).includes(w))) : [];
  if (matches.length === 1) return { id: matches[0]!.approval_id };
  if (matches.length === 0) return { error: `no pending card's title contains all of "${query}"; pass its approval_id`, candidates };
  return { error: `"${query}" matches several cards; pass the approval_id`, candidates };
}

/** Edit fields of a pending card (voice): the phone's card updates live; it stays pending. */
export function editApproval(id: string, fields: Record<string, string>): { error?: string; changed?: string[] } {
  const p = pending.get(id);
  if (!p) return { error: "no such pending approval" };
  const blocked = Object.keys(fields).filter((k) => {
    const f = fieldsOf(p).find((x) => x.name === k);
    return f ? isPrivate(f) : PRIVATE_NAMES.test(k);
  });
  if (blocked.length) return { error: `can't change private field(s) ${blocked.join(", ")} by voice — the user can edit them on the card` };
  const changed: string[] = [];
  const next = fieldsOf(p).map((f) => {
    if (fields[f.name] === undefined || f.editable === false) return f;
    changed.push(f.name);
    return { ...f, value: fields[f.name]! };
  });
  if (!changed.length) return { error: `no editable field among ${Object.keys(fields).join(", ")}; fields are ${fieldsOf(p).map((f) => f.name).join(", ")}` };
  p.card = { ...p.card, fields: next };
  if (p.commit) cancelCommit(id); // an edit during the undo window restarts the decision
  bus.emit({ type: "modal.update", approval_id: id, card: p.card });
  return { changed };
}

/** Voice approval: accept after an undo window the phone shows ("Approved by voice · Undo"). */
export function commitWithUndo(id: string): { error?: string; until?: string } {
  const p = pending.get(id);
  if (!p) return { error: "no such pending approval" };
  if (p.commit) return { until: new Date(p.commit.until).toISOString() };
  const until = Date.now() + UNDO_MS;
  p.commit = { until, timer: setTimeout(() => settle(id, { action: "accept", fields: valuesOf(p) }), UNDO_MS) };
  bus.emit({ type: "modal.commit", approval_id: id, until: new Date(until).toISOString() });
  return { until: new Date(until).toISOString() };
}

export function cancelCommit(id: string): boolean {
  const p = pending.get(id);
  if (!p?.commit) return false;
  clearTimeout(p.commit.timer);
  p.commit = undefined;
  bus.emit({ type: "modal.commit_cancel", approval_id: id });
  return true;
}

export const rejectApproval = (id: string) => settle(id, { action: "reject" });
export const focusApproval = (id: string) => pending.has(id) && (bus.emit({ type: "modal.focus", approval_id: id }), true);

export const pendingApprovals = () => [...pending.entries()].map(([approval_id, p]) => ({ approval_id, card: p.card }));

/** What the model may see about pending cards: titles + non-private field values. */
export const approvalsForModel = () =>
  [...pending.entries()].map(([approval_id, p]) => ({
    approval_id,
    title: String(p.card.title ?? ""),
    fields: Object.fromEntries(fieldsOf(p).map((f) => [f.name, isPrivate(f) ? "(private)" : f.value.slice(0, 1200)])),
    voice_approved_undo_until: p.commit ? new Date(p.commit.until).toISOString() : undefined,
  }));

/** Withdraw one pending card (task amended/cancelled). */
export const withdrawApproval = (id: string) => settle(id, { action: "dismiss" });

/** Reset: dismiss every pending card (resolves as "dismiss"). */
export function clearApprovals() {
  for (const id of [...pending.keys()]) settle(id, { action: "dismiss" });
}
