import { randomBytes } from "node:crypto";
import path from "node:path";
import { requestApproval, type ApprovalOutcome } from "./approvals.ts";
import { bus } from "./bus.ts";
import { findContact, nameForAddress, rememberChannel } from "./contacts.ts";
import { emailConfigured, replyContext, sendEmail } from "./email.ts";
import { env } from "./env.ts";
import { now, writeJson } from "./fsutil.ts";
import { paths } from "./store.ts";

/**
 * Real-world actions (call, email) run by the runner, not the model:
 * resolve the contact locally → ask the user for anything missing (and remember it) →
 * confirmation card with the real details → perform on accept. The model only ever gets
 * names and outcomes back; numbers and addresses stay on this machine and the phone.
 */
export type ActionDesc =
  | { type: "call"; contact: string; reason?: string }
  | { type: "email"; contact?: string; reply_to_uid?: number; subject: string; body: string };

export interface ActionOutcome { status: "done" | "rejected" | "failed"; summary: string; link?: { href: string; label: string; kind: string } }

/** Which card a flow is showing: a form asking for a missing detail, or the confirmation itself. */
export type CardKind = "ask_channel" | "confirm";
/** Hooks so a task can track each card (set by the task runner). */
export interface ActionHooks { onCard?(card: Record<string, unknown>, approval_id: string, kind: CardKind): void | Promise<void> }

async function ask(card: Record<string, unknown>, kind: CardKind, hooks: ActionHooks): Promise<ApprovalOutcome> {
  const { approval_id, promise } = requestApproval(card, { modal: true });
  await hooks.onCard?.(card, approval_id, kind);
  return promise;
}

const accepted = (o: ApprovalOutcome) => o.action === "accept" || o.action === "modify";

/** Ask for a missing phone/email; remembers it in contacts.json. */
async function askChannel(name: string, kind: "phone" | "email", why: string, hooks: ActionHooks): Promise<string | null> {
  const o = await ask(
    {
      title: kind === "phone" ? `${name}'s phone number?` : `${name}'s email?`,
      body: `I don't have ${kind === "phone" ? "a number" : "an email address"} for ${name} (${why}). Add it and I'll remember it on this device.`,
      fields: [{ name: kind, label: kind === "phone" ? "Phone" : "Email", value: "", editable: true, private: true }],
      actions: ["accept", "reject"],
    },
    "ask_channel",
    hooks,
  );
  const v = o.fields?.[kind]?.trim();
  if (!accepted(o) || !v) return null;
  await rememberChannel(name, kind, v);
  return v;
}

export async function runAction(desc: ActionDesc, hooks: ActionHooks = {}): Promise<ActionOutcome> {
  try {
    return desc.type === "call" ? await runCall(desc, hooks) : await runEmail(desc, hooks);
  } catch (err) {
    // never echo raw provider errors (they can contain addresses)
    const msg = (err instanceof Error ? err.message : String(err)).replace(/[\w.+-]+@[\w.-]+/g, "[address]").slice(0, 160);
    return { status: "failed", summary: `couldn't complete: ${msg}` };
  }
}

async function runCall(d: Extract<ActionDesc, { type: "call" }>, hooks: ActionHooks): Promise<ActionOutcome> {
  const c = await findContact(d.contact);
  const name = c?.name ?? d.contact;
  const phone = c?.phones[0] ?? (await askChannel(name, "phone", "to call them", hooks));
  if (!phone) return { status: "rejected", summary: `no number for ${name}; call cancelled` };
  const o = await ask(
    {
      title: `Call ${name}?`,
      body: d.reason ? `About: ${d.reason}` : "Tap Accept, then Call.",
      fields: [{ name: "phone", label: "Number", value: phone, editable: true, private: true }],
      actions: ["accept", "reject"],
    },
    "confirm",
    hooks,
  );
  if (!accepted(o)) return { status: "rejected", summary: `you declined calling ${name}` };
  const number = (o.fields?.phone ?? phone).replace(/[^\d+]/g, "");
  const link = { href: `tel:${number}`, label: `Call ${name}`, kind: "tel" };
  bus.emit({ type: "open_link", href: link.href, kind: "tel" }); // one-tap Call prompt on the phone
  return { status: "done", summary: `call to ${name} approved — tap Call on the phone`, link };
}

async function runEmail(d: Extract<ActionDesc, { type: "email" }>, hooks: ActionHooks): Promise<ActionOutcome> {
  let to: string | null = null;
  let name = d.contact ?? "recipient";
  let subject = d.subject;
  let headers: { inReplyTo?: string; references?: string } = {};
  if (d.reply_to_uid != null) {
    if (!emailConfigured()) return { status: "failed", summary: "email isn't set up, so I can't reply to a message" };
    const r = await replyContext(d.reply_to_uid);
    if (!r) return { status: "failed", summary: "couldn't find the message to reply to" };
    to = r.to;
    subject = d.subject || r.subject;
    headers = { inReplyTo: r.messageId, references: r.references };
    name = (await nameForAddress(r.to)) ?? d.contact ?? "the sender";
  }
  if (!to) {
    const c = d.contact ? await findContact(d.contact) : null;
    name = c?.name ?? d.contact ?? "recipient";
    to = c?.emails[0] ?? (await askChannel(name, "email", "to send the email", hooks));
  }
  if (!to) return { status: "rejected", summary: `no address for ${name}; email cancelled` };

  const live = emailConfigured() && env.ENABLE_SIDE_EFFECTS;
  const o = await ask(
    {
      title: d.reply_to_uid != null ? `Reply to ${name}?` : `Email ${name}?`,
      body: live ? "Accept sends it from your email account." : `Sending is off (${emailConfigured() ? "ENABLE_SIDE_EFFECTS=false" : "email not set up"}) — Accept saves the draft.`,
      fields: [
        { name: "to", label: "To", value: to, editable: true, private: true },
        { name: "subject", label: "Subject", value: subject, editable: true },
        { name: "body", label: "Message", value: d.body, editable: true },
      ],
      actions: ["accept", "modify", "reject"],
    },
    "confirm",
    hooks,
  );
  if (!accepted(o)) return { status: "rejected", summary: `you declined the email to ${name}` };
  const msg = { to: o.fields?.to?.trim() || to, subject: o.fields?.subject ?? subject, body: o.fields?.body ?? d.body, ...headers };
  if (live) {
    await sendEmail(msg);
    return { status: "done", summary: `email to ${name} sent${o.action === "modify" ? " (with your edits)" : ""}` };
  }
  // keep the draft locally (outbox) so nothing is lost
  await writeJson(path.join(paths.home, "outbox", `${now().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.json`), { ...msg, saved_at: now() });
  return { status: "done", summary: `email to ${name} approved; draft saved (sending is off)` };
}

/** Mask email addresses and phone numbers in text that goes back to a model; dates, prices and short codes stay. */
export function redact(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, (m) => (looksLikePhone(m) ? "[phone]" : m));
}
function looksLikePhone(m: string): boolean {
  const digits = m.replace(/\D/g, "").length;
  if (digits < 7 || digits > 15) return false; // outside the E.164 range: an order number, an IBAN…
  if (/\d{4}-\d{2}-\d{2}|\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/.test(m)) return false; // a date
  return true;
}
