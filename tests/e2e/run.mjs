// Regression harness: node tests/e2e/run.mjs [--tags=tool,text,ui,email,voice] [--only=substr] [--no-build] [--compare=results/x.json]
// Runs every scenario against an isolated runner and prints a pass/fail table.
import { execSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { E2E, ROOT, api, freshHome, startRunner } from "./lib.mjs";
import scenarios from "./scenarios/core.mjs";

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const tags = args.tags ? String(args.tags).split(",") : ["tool", "text", "ui", "email", "voice"];
const selected = scenarios.filter((s) => s.tags.some((t) => tags.includes(t)) && (!args.only || s.name.includes(String(args.only))));

// libraries come from the runner workspace (already installed there)
const req = createRequire(path.join(ROOT, "runner", "package.json"));

async function makeTestMailbox() {
  try {
    const nodemailer = req("nodemailer");
    const acct = await nodemailer.createTestAccount();
    const t = nodemailer.createTransport({ host: acct.smtp.host, port: acct.smtp.port, secure: acct.smtp.secure, auth: { user: acct.user, pass: acct.pass } });
    await t.sendMail({ from: '"Laura" <laura@example.com>', to: acct.user, subject: "Weekend plans?", text: "Hey! Are you free on Saturday or Sunday for a hike?\nIf easier, call me at +34 611 222 333.\n— Laura" });
    const env = {
      EMAIL_USER: acct.user, EMAIL_PASSWORD: acct.pass, EMAIL_SMTP_HOST: acct.smtp.host, EMAIL_SMTP_PORT: String(acct.smtp.port),
      EMAIL_IMAP_HOST: acct.imap.host, EMAIL_IMAP_PORT: String(acct.imap.port), EMAIL_FROM_NAME: "E2E User", ENABLE_SIDE_EFFECTS: "true",
      EMAIL_POLL_S: "3600", // scenarios trigger checks themselves; a background poll landing mid-scenario made the result racy
    };
    const inbox = async () => {
      const { ImapFlow } = req("imapflow");
      const { simpleParser } = req("mailparser");
      const c = new ImapFlow({ host: acct.imap.host, port: acct.imap.port, secure: true, auth: { user: acct.user, pass: acct.pass }, logger: false });
      await c.connect();
      const lock = await c.getMailboxLock("INBOX");
      const out = [];
      try {
        for await (const m of c.fetch("1:*", { source: true })) {
          const p = await simpleParser(m.source);
          out.push({ subject: p.subject ?? "", inReplyTo: p.inReplyTo ?? null, to: p.to?.text });
        }
      } finally {
        lock.release();
        await c.logout();
      }
      return out;
    };
    const send = (fromName, fromAddr, subject, text) => t.sendMail({ from: `"${fromName}" <${fromAddr}>`, to: acct.user, subject, text });
    return { env, inbox, send };
  } catch (e) {
    console.log("  (no test mailbox:", String(e).slice(0, 80), ")");
    return null;
  }
}

const t0 = Date.now();
if (!args["no-build"]) {
  process.stdout.write("building app… ");
  execSync("pnpm --filter @canvas-agent/app build", { cwd: ROOT, stdio: "ignore" });
  console.log("ok");
}
const email = tags.includes("email") ? await makeTestMailbox() : null;
const home = await freshHome("e2e");
const runner = await startRunner({ home, extraEnv: email?.env ?? {} });
console.log(`isolated runner pid ${runner.pid} on ${home}\n`);

const results = [];
try {
  for (const s of selected) {
    await api("/api/reset", { method: "POST" }).catch(() => {});
    const started = Date.now();
    let r;
    try {
      r = await Promise.race([s.run({ home, email }), new Promise((_, rej) => setTimeout(() => rej(new Error("scenario timeout (5 min)")), 300_000))]);
    } catch (e) {
      r = { pass: false, info: `ERROR ${String(e.message ?? e).slice(0, 200)}` };
    }
    const row = { name: s.name, tags: s.tags, pass: !!r.pass, skipped: !!r.skipped, info: r.info, ms: Date.now() - started, metrics: r.metrics ?? {} };
    results.push(row);
    console.log(`${row.skipped ? "SKIP" : row.pass ? "PASS" : "FAIL"}  ${s.name}  (${(row.ms / 1000).toFixed(1)}s)\n      ${row.info ?? ""}`);
  }
} finally {
  await runner.stop();
}

const branch = execSync("git branch --show-current", { cwd: ROOT }).toString().trim();
const commit = execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim();
mkdirSync(path.join(E2E, "results"), { recursive: true });
const file = path.join(E2E, "results", `${new Date().toISOString().replace(/[:.]/g, "-")}-${branch.replace(/\W/g, "_")}.json`);
writeFileSync(file, JSON.stringify({ branch, commit, at: new Date().toISOString(), results }, null, 2));
const passed = results.filter((r) => r.pass && !r.skipped).length;
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${passed} passed, ${failed} failed, ${results.filter((r) => r.skipped).length} skipped — ${branch}@${commit} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`results: ${path.relative(ROOT, file)}`);

if (args.compare && existsSync(String(args.compare))) {
  const prev = JSON.parse(readFileSync(String(args.compare), "utf8"));
  console.log(`\ncompared with ${prev.branch}@${prev.commit}:`);
  for (const r of results) {
    const p = prev.results.find((x) => x.name === r.name);
    if (!p) console.log(`  NEW   ${r.name}: ${r.pass ? "pass" : "FAIL"}`);
    else if (p.pass !== r.pass) console.log(`  ${r.pass ? "FIXED" : "REGRESSED"}  ${r.name}`);
  }
}
process.exit(failed ? 1 : 0);
