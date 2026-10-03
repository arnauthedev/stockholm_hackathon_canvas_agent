import path from "node:path";
import { Contact } from "@canvas-agent/contract";
import { lock, readJson, slugify, writeJson } from "./fsutil.ts";
import { paths } from "./store.ts";

/**
 * Contacts privacy layer. identity/contacts.json stays on this machine:
 * models only ever see names, relation/notes and which channels exist (phone ✓ / email ✓).
 * Numbers and addresses are resolved here, at the moment an approved action runs.
 */
const FILE = () => path.join(paths.identity, "contacts.json");

export interface ResolvedContact { id: string; name: string; phones: string[]; emails: string[]; relation?: string; notes?: string; aliases: string[] }

function normalize(c: Contact): ResolvedContact {
  const phones = [...(c.phones ?? []).map((p) => p.number), ...(c.phone ? [c.phone] : [])].filter(Boolean);
  const emails = [...(c.emails ?? []).map((e) => e.address), ...(c.email ? [c.email] : [])].filter(Boolean);
  return { id: c.id ?? slugify(c.name), name: c.name, phones: [...new Set(phones)], emails: [...new Set(emails)], relation: c.relation, notes: c.notes, aliases: c.aliases ?? [] };
}

export async function loadContacts(): Promise<ResolvedContact[]> {
  const raw = (await readJson<unknown[]>(FILE())) ?? [];
  return raw.flatMap((r) => {
    const p = Contact.safeParse(r);
    return p.success ? [normalize(p.data)] : [];
  });
}

/** What the model may see. */
export async function publicContacts() {
  return (await loadContacts()).map((c) => ({
    name: c.name,
    ...(c.aliases.length ? { aliases: c.aliases } : {}),
    ...(c.relation ? { relation: c.relation } : {}),
    ...(c.notes ? { notes: c.notes } : {}),
    phone: c.phones.length > 0,
    email: c.emails.length > 0,
  }));
}

const norm = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * Find a contact by name or alias. The model sees every contact's name and picks one, so this is a
 * faithful lookup: exact name/alias, then every word of the query as a whole word of a name
 * ("Johnson" → "Mark Johnson"), then the same first name. No substring matching: "Alice" must never
 * resolve to a contact called "Al". Unknown names return null and the flow asks the user.
 */
export async function findContact(query: string): Promise<ResolvedContact | null> {
  const q = norm(query);
  if (!q) return null;
  const all = await loadContacts();
  const names = (c: ResolvedContact) => [c.name, ...c.aliases].map(norm);
  const words = (s: string) => s.split(/\s+/).filter(Boolean);
  const qw = words(q);
  return (
    all.find((c) => names(c).includes(q)) ??
    all.find((c) => names(c).some((n) => qw.every((w) => words(n).includes(w)))) ??
    all.find((c) => names(c).some((n) => words(n)[0] === qw[0])) ??
    null
  );
}

/** Save a missing phone/email the user provided (runner-only; never via the model). */
export async function rememberChannel(name: string, kind: "phone" | "email", value: string) {
  await lock("contacts", async () => {
    const raw = ((await readJson<Record<string, unknown>[]>(FILE())) ?? []) as Contact[];
    const q = norm(name);
    let c = raw.find((x) => norm(x.name) === q || (x.aliases ?? []).some((a) => norm(a) === q));
    if (!c) {
      c = { name };
      raw.push(c);
    }
    if (kind === "phone") c.phones = [...(c.phones ?? []), { number: value }];
    else c.emails = [...(c.emails ?? []), { address: value }];
    await writeJson(FILE(), raw);
  });
}

/** Display name for an email address if it belongs to a contact (used to redact senders). */
export async function nameForAddress(address: string): Promise<string | null> {
  const a = address.toLowerCase();
  return (await loadContacts()).find((c) => c.emails.some((e) => e.toLowerCase() === a))?.name ?? null;
}
