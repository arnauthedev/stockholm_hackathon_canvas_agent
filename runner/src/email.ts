import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { nameForAddress } from "./contacts.ts";

/**
 * Email over plain SMTP + IMAP (free). Defaults are Gmail with an App Password:
 *   EMAIL_USER=you@gmail.com  EMAIL_PASSWORD=<16-char app password>
 * Any provider works by overriding EMAIL_SMTP_HOST/PORT and EMAIL_IMAP_HOST/PORT.
 * Addresses never go to the model: senders are shown as the contact's name or display name.
 */
const cfg = () => ({
  user: process.env.EMAIL_USER ?? "",
  pass: process.env.EMAIL_PASSWORD ?? "",
  smtpHost: process.env.EMAIL_SMTP_HOST || "smtp.gmail.com",
  smtpPort: Number(process.env.EMAIL_SMTP_PORT || 465),
  imapHost: process.env.EMAIL_IMAP_HOST || "imap.gmail.com",
  imapPort: Number(process.env.EMAIL_IMAP_PORT || 993),
  fromName: process.env.EMAIL_FROM_NAME || "",
});

export const emailConfigured = () => !!(cfg().user && cfg().pass);

export interface OutgoingEmail { to: string; subject: string; body: string; inReplyTo?: string; references?: string }

export async function sendEmail(m: OutgoingEmail): Promise<{ messageId: string }> {
  const c = cfg();
  const t = nodemailer.createTransport({ host: c.smtpHost, port: c.smtpPort, secure: c.smtpPort === 465, auth: { user: c.user, pass: c.pass } });
  const info = await t.sendMail({
    from: c.fromName ? `"${c.fromName}" <${c.user}>` : c.user,
    to: m.to,
    subject: m.subject,
    text: m.body,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: m.references ?? m.inReplyTo } : {}),
  });
  return { messageId: info.messageId };
}

async function withImap<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const c = cfg();
  const client = new ImapFlow({ host: c.imapHost, port: c.imapPort, secure: true, auth: { user: c.user, pass: c.pass }, logger: false });
  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
}

export interface EmailSummary { uid: number; from: string; subject: string; date: string; text: string }

/** Recent inbox messages, optionally from one address. Sender redacted to a name. */
export async function findEmails(opts: { fromAddress?: string; query?: string; limit?: number }): Promise<EmailSummary[]> {
  const limit = Math.min(10, opts.limit ?? 5);
  return withImap(async (client) => {
    const q: Record<string, unknown> = {};
    if (opts.fromAddress) q.from = opts.fromAddress;
    if (opts.query) q.text = opts.query;
    const uids = (await client.search(Object.keys(q).length ? q : { all: true }, { uid: true })) || [];
    const pick = uids.slice(-limit).reverse();
    const out: EmailSummary[] = [];
    for (const uid of pick) {
      const msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const parsed = await simpleParser(msg.source);
      const addr = parsed.from?.value[0]?.address ?? "";
      const display = (await nameForAddress(addr)) ?? parsed.from?.value[0]?.name ?? "unknown sender";
      out.push({ uid, from: display, subject: parsed.subject ?? "", date: (parsed.date ?? new Date()).toISOString(), text: (parsed.text ?? "").trim().slice(0, 2000) });
    }
    return out;
  });
}

/** Runner-only: reply headers + the original sender's address for a message uid. */
export async function replyContext(uid: number): Promise<{ to: string; subject: string; messageId?: string; references?: string } | null> {
  return withImap(async (client) => {
    const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
    if (!msg || !msg.source) return null;
    const p = await simpleParser(msg.source);
    const to = p.replyTo?.value[0]?.address ?? p.from?.value[0]?.address;
    if (!to) return null;
    const refs = [p.references].flat().filter(Boolean).join(" ");
    return { to, subject: /^re:/i.test(p.subject ?? "") ? (p.subject ?? "") : `Re: ${p.subject ?? ""}`, messageId: p.messageId, references: [refs, p.messageId].filter(Boolean).join(" ") || undefined };
  });
}

export interface IncomingEmail { uid: number; fromAddress: string; fromName: string; subject: string; text: string }

/** Highest UID in the inbox (baseline for the watcher). */
export async function maxUid(): Promise<number> {
  return withImap(async (client) => {
    const uids = (await client.search({ all: true }, { uid: true })) || [];
    return uids.length ? Math.max(...uids) : 0;
  });
}

/** Messages with UID > after (runner-only: includes the sender address for matching). */
export async function messagesSince(after: number): Promise<IncomingEmail[]> {
  return withImap(async (client) => {
    const uids = ((await client.search({ uid: `${after + 1}:*` }, { uid: true })) || []).filter((u) => u > after);
    const out: IncomingEmail[] = [];
    for (const uid of uids.slice(0, 20)) {
      const msg = await client.fetchOne(String(uid), { source: true }, { uid: true });
      if (!msg || !msg.source) continue;
      const p = await simpleParser(msg.source);
      const addr = p.from?.value[0]?.address ?? "";
      out.push({ uid, fromAddress: addr, fromName: (await nameForAddress(addr)) ?? p.from?.value[0]?.name ?? "someone", subject: p.subject ?? "", text: (p.text ?? "").slice(0, 4000) });
    }
    return out;
  });
}
