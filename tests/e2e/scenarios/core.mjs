// Regression scenarios. Each returns { pass, info, metrics? }.
// Tags: tool (deterministic, no LLM), text (text brain), ui (browser), email, voice (TTS mic, slowest).
import path from "node:path";
import fs from "node:fs/promises";
import { api, chat, finals, homeFile, openCanvas, phone, readJsonSafe, sleep, speechWav, startVoice, stopVoice, tool, touchDrag, waitFor } from "../lib.mjs";

const listTasks = async (home) => {
  const dir = homeFile(home, "tasks");
  const ids = await fs.readdir(dir).catch(() => []);
  return ids.map((id) => ({ id, ...(readJsonSafe(path.join(dir, id, "task.json")) ?? {}), result: readJsonSafe(path.join(dir, id, "result.json")) })).filter((t) => t.title);
};
const listApps = async (home) => (await fs.readdir(homeFile(home, "apps")).catch(() => [])).filter((x) => !x.startsWith("_"));
const latestCanvas = async () => (await tool("get_state", { scope: "canvas" })).canvas;

export default [
  // ---------------- deterministic (no model) ----------------
  {
    name: "tool: render + ring buffer + undo",
    tags: ["tool"],
    async run() {
      for (let i = 1; i <= 12; i++) await tool("render", { spec: { root: "t", components: { t: { type: "Text", props: { text: `n${i}` } } } }, data: {} });
      const st = await tool("get_state", { scope: "canvas" });
      const u1 = await tool("undo");
      const u2 = await tool("undo");
      const ok = st.history.length === 10 && u1.restored && u2.restored && u2.restored < u1.restored;
      return { pass: ok, info: `history=${st.history.length} undo→${u1.restored},${u2.restored}` };
    },
  },
  {
    name: "tool: approval lookup never guesses; contact lookup is whole-word",
    tags: ["tool"],
    async run() {
      // two generic cards pending: words must single out ONE card; nothing matching → candidates, never the latest card
      await tool("ask_approval", { card: { title: "Email Laura?", body: "x", fields: [{ name: "body", label: "Message", value: "hi", editable: true }] }, modal: false });
      await tool("ask_approval", { card: { title: "Book the table?", body: "y" }, modal: false });
      const none = await tool("focus_approval", { approval: "the call to Mark" });
      const one = await tool("focus_approval", { approval: "table" });
      const tie = await tool("focus_approval", { approval: "laura table" });
      const rej = await tool("resolve_approval", { approval: "laura", action: "reject" });
      const left = (await tool("get_state", { scope: "approvals" })).approvals;
      // contacts: "Mo" must not resolve to "Mom" by substring; the flow asks for Mo's number instead
      await tool("call_contact", { contact: "Mo" });
      const pending = async () => (await tool("get_state", { scope: "approvals" })).approvals;
      const mo = await waitFor(async () => (await pending()).find((a) => /^Mo's phone number\?/.test(a.title)), { timeout: 5000, label: "Mo card" }).catch(() => null);
      const wrongMom = (await pending()).some((a) => /^Call Mom\?/.test(a.title));
      // an alias ("Mum") still resolves exactly
      await tool("call_contact", { contact: "Mum" });
      const mum = await waitFor(async () => (await pending()).find((a) => /^Call Mom\?/.test(a.title)), { timeout: 5000, label: "Mom card" }).catch(() => null);
      const ok = !!none.error && none.candidates?.length === 2 && one.ok === true && !!tie.error && rej.ok === true && left.length === 1 && left[0].title === "Book the table?" && !!mo && !wrongMom && !!mum;
      return { pass: ok, info: `none=${!!none.error}/${none.candidates?.length} one=${one.ok} tie=${!!tie.error} reject=${rej.ok} left=${left.map((a) => a.title).join("|")} mo=${!!mo} wrongMom=${wrongMom} mum=${!!mum}` };
    },
  },
  {
    name: "tool: pin idempotent + sizes by content + new screen when full",
    tags: ["tool"],
    async run() {
      const metric = (i) => ({ title: `W${i}`, spec: { root: "m", components: { m: { type: "Metric", props: { label: `W${i}`, value: i } } } }, data: {} });
      for (let i = 1; i <= 6; i++) {
        await tool("render", metric(i));
        await tool("pin", { slug: `w${i}` });
      }
      const again = await tool("pin", {});
      let st = (await tool("get_state", { scope: "screens" })).screens;
      const oneScreen = st.length === 1 && st[0].widgets.length === 6 && st[0].widgets.every((w) => w.size === "S");
      await tool("render", { title: "Chart", spec: { root: "c", components: { c: { type: "Chart", props: { kind: "line", x: ["a"], series: [{ name: "s", values: [1] }] } } } }, data: {} });
      const chart = await tool("pin", { slug: "chart" });
      await tool("render", { title: "Pack", spec: { root: "s", components: { s: { type: "CardStack", props: { cards: [{ id: "a", title: "A" }] } } } }, data: {} });
      const pack = await tool("pin", { slug: "pack" });
      st = (await tool("get_state", { scope: "screens" })).screens;
      const ok = again.already_pinned === true && oneScreen && chart.size === "W" && pack.size === "L" && chart.screen === "s2" && st.length === 2;
      return { pass: ok, info: `6 small on one screen=${oneScreen} chart=${chart.size}@${chart.screen} pack=${pack.size}@${pack.screen} screens=${st.length}` };
    },
  },
  {
    name: "tool: resize keeps place if it fits, else moves; layout survives",
    tags: ["tool"],
    async run({ home }) {
      const pinMetric = async (slug) => {
        await tool("render", { title: slug, spec: { root: "m", components: { m: { type: "Metric", props: { label: slug, value: 1 } } } }, data: {} });
        return tool("pin", { slug });
      };
      await pinMetric("a"); // S at 0,0
      await pinMetric("b"); // S at 2,0
      const r1 = await tool("resize_widget", { app_id: "a", size: "T" }); // 2×4 at 0,0 fits
      const r2 = await tool("resize_widget", { app_id: "b", size: "L" }); // 4×4 can't stay at 2,0 → moves
      const lay = (id) => readJsonSafe(homeFile(home, `apps/${id}/app.json`))?.layout;
      const a = lay("a"), b = lay("b");
      const sameScreen = readJsonSafe(homeFile(home, "apps/a/app.json")).screen === readJsonSafe(homeFile(home, "apps/b/app.json")).screen;
      const overlap = sameScreen && !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);
      const ok = !r1.moved && r1.layout.size === "T" && r2.moved && !overlap;
      return { pass: ok, info: `a=${JSON.stringify(a)} b=${JSON.stringify(b)} (b moved to ${r2.screen}) overlap=${overlap}` };
    },
  },
  {
    name: "tool: watch rule + script _alerts rising edge",
    tags: ["tool"],
    async run({ home }) {
      const valFile = path.join(home, "tmp-val.txt");
      await fs.writeFile(valFile, "150");
      const code = `import json\nv=float(open(${JSON.stringify(valFile)}).read())\nout={'price': v}\nif v < 100: out['_alerts']=[{'id':'deep','message':'below 100'}]\nprint(json.dumps(out))`;
      await tool("render", { title: "E2E price", spec: { root: "m", components: { m: { type: "Metric", props: { label: "p", value: { $bind: "/price" } } } } }, data: { price: 150 }, source: { type: "python", refresh_s: 3600, code } });
      const w = await tool("watch", { path: "/price", op: "<", value: 120, message: "below 120" });
      const seq = [];
      const runs = () => readJsonSafe(homeFile(home, `apps/${w.app_id}/job.json`))?.runs ?? 0;
      await waitFor(async () => runs() >= 1, { timeout: 30_000, label: "first run" }); // the pin's own run
      for (const v of [150, 110, 110, 130, 90]) {
        await fs.writeFile(valFile, String(v));
        const before = runs();
        await api(`/api/apps/${w.app_id}/refresh`, { method: "POST" });
        await waitFor(async () => runs() > before, { timeout: 30_000, label: "refresh run" });
        const st = readJsonSafe(homeFile(home, `apps/${w.app_id}/alerts.json`)) ?? {};
        seq.push(`${v}:${Object.keys(st.active ?? {}).sort().join("+") || "-"}`);
      }
      const fired = ((await api("/api/monitor")).activity ?? []).filter((a) => a.title.startsWith("alert fired")).length;
      const data = readJsonSafe(homeFile(home, `apps/${w.app_id}/data.json`));
      const ok = fired === 3 && !("_alerts" in data) && seq.join(" ") === "150:- 110:price-lt-120 110:price-lt-120 130:- 90:price-lt-120+script:deep";
      return { pass: ok, info: `fired=${fired} ${seq.join(" ")}` };
    },
  },

  {
    name: "tool: schedule notify fires once, listed until then",
    tags: ["tool", "ui"],
    async run() {
      const p = await phone();
      try {
        const bad = await tool("schedule", { when: { cron: "not a cron" }, action: { type: "notify", text: "x" } });
        const r = await tool("schedule", { when: { in_s: 3 }, action: { type: "notify", text: "Stretch now" }, label: "Stretch" });
        await p.page.click('[aria-label^="Tasks"]');
        const listed = await p.page.waitForSelector(".scheduled li", { timeout: 3000 }).then(() => true).catch(() => false);
        const toast = await waitFor(async () => p.events.find((e) => e.type === "toast" && /Stretch now/.test(e.text)), { timeout: 8000, label: "toast" }).catch(() => null);
        await sleep(800);
        const after = (await api("/api/triggers")).length;
        const ok = !!bad.error && r.ok && listed && !!toast && after === 0;
        return { pass: ok, info: `badCronRejected=${!!bad.error} listed=${listed} fired=${!!toast} activeAfter=${after}` };
      } finally {
        await p.close();
      }
    },
  },
  {
    name: "ui: speak trigger with the app open plays (or shows) the message",
    tags: ["ui"],
    async run() {
      const p = await phone();
      try {
        const tts = [];
        p.page.on("response", (r) => r.url().includes("/api/tts") && tts.push(r.status()));
        await openCanvas(p.page);
        await p.page.locator(".side-btn").first().click(); // a tap unlocks audio
        await p.page.keyboard.press("Escape");
        await p.page.locator(".sheet-backdrop").click({ position: { x: 5, y: 5 } }).catch(() => {});
        await tool("schedule", { when: { in_s: 2 }, action: { type: "speak", text: "It is time to leave" } });
        const ev = await waitFor(async () => p.events.find((e) => e.type === "speak"), { timeout: 8000, label: "speak" }).catch(() => null);
        await sleep(3000);
        const toast = await p.page.locator(".toast", { hasText: "time to leave" }).count();
        return { pass: !!ev && (tts.includes(200) || toast > 0), info: `speakEvent=${!!ev} tts=${JSON.stringify(tts)} toastFallback=${toast}` };
      } finally {
        await p.close();
      }
    },
  },

  {
    name: "tool: ui_action / read_widget on card stack, checklist, notebook",
    tags: ["tool"],
    async run() {
      await tool("render", { title: "Packing", spec: { root: "s", components: { s: { type: "CardStack", props: { cards: { $bind: "/items" } } } } }, data: { items: [{ id: "p", title: "Passport", icon: "🛂" }, { id: "c", title: "Charger", icon: "🔌" }, { id: "r", title: "Raincoat", icon: "🧥" }] } });
      const a = await tool("ui_action", { action: "done", args: { text: "charger" } });
      const b = await tool("ui_action", { action: "later" }); // top card (Passport) to the back
      const rw = await tool("read_widget", {});
      const order = rw.widgets?.[0]?.state?.remaining_in_order?.join(",");
      const bad = await tool("ui_action", { action: "explode" });
      await tool("render", { title: "Shop", spec: { root: "col", components: { col: { type: "Column", children: ["l", "n"] }, l: { type: "Checklist", props: { items: [{ text: "Bread" }] } }, n: { type: "Notebook", props: {} } } }, data: {} });
      await tool("ui_action", { component_id: "l", action: "add", args: { items: ["Oat milk", "Eggs"] } });
      await tool("ui_action", { action: "check", args: { text: "bread" } });
      await tool("ui_action", { action: "append", args: { text: "Call the plumber" } });
      const rw2 = await tool("read_widget", {});
      const list = rw2.widgets.find((w) => w.type === "Checklist").state.items.join("|");
      const note = rw2.widgets.find((w) => w.type === "Notebook").state.lines.join("|");
      const ok = a.ok && b.ok && order === "Raincoat,Passport" && !!bad.error && list === "[x] Bread|[ ] Oat milk|[ ] Eggs" && note === "Call the plumber";
      return { pass: ok, info: `order=${order} bad=${!!bad.error} list=${list} note=${note}` };
    },
  },
  {
    name: "ui: tap is instant, confirmed by the runner, survives reload, syncs to a 2nd device",
    tags: ["ui"],
    async run() {
      await tool("render", { title: "List", spec: { root: "l", components: { l: { type: "Checklist", props: { items: [{ id: "a", text: "Apples" }, { id: "b", text: "Bread" }] } } } }, data: {} });
      const p1 = await phone();
      const p2 = await phone();
      try {
        await openCanvas(p1.page);
        await openCanvas(p2.page);
        await p1.page.waitForSelector(".c-check");
        const t0 = Date.now();
        await p1.page.locator(".c-check", { hasText: "Apples" }).tap();
        await p1.page.waitForSelector(".c-checklist li.done", { timeout: 2000 });
        const tapMs = Date.now() - t0;
        const synced = await p2.page.waitForSelector(".c-checklist li.done", { timeout: 4000 }).then(() => true).catch(() => false);
        await sleep(500);
        const st = (await tool("read_widget", {})).widgets[0].state.items.join("|");
        await p1.page.reload();
        await p1.page.waitForSelector(".conn.ok");
        await openCanvas(p1.page);
        await p1.page.waitForSelector(".c-check");
        const afterReload = await p1.page.locator(".c-checklist li.done").count();
        const ok = tapMs < 400 && synced && st === "[x] Apples|[ ] Bread" && afterReload === 1 && !p1.errors.length;
        return { pass: ok, info: `tap→shown ${tapMs}ms, 2nd device=${synced}, runner=${st}, after reload=${afterReload}` };
      } finally {
        await p1.close();
        await p2.close();
      }
    },
  },

  {
    name: "tool: binance stream updates live; pin keeps streaming; alert fires once; unpin stops",
    tags: ["tool"],
    async run({ home }) {
      const r = await tool("render", { title: "BTC", spec: { root: "m", components: { m: { type: "Metric", props: { label: "BTC", value: { $bind: "/price" }, unit: { $bind: "/currency" }, delta: { $bind: "/change_pct" }, trend: { $bind: "/trend" } } } } }, data: {}, source: { type: "stream", provider: "binance", symbol: "BTCUSDT" } });
      const file = homeFile(home, `canvas/${r.canvas_id}/data.json`);
      const seen = new Set();
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        const d = readJsonSafe(file);
        if (d?.updated_at) seen.add(d.updated_at);
        await sleep(250);
      }
      const d = readJsonSafe(file);
      const pin = await tool("pin", { slug: "btc" });
      const w = await tool("watch", { target: "btc", path: "/price", op: ">", value: 1, message: "BTC above 1" });
      // the pinned widget opens its own connection (Binance can take ~3 s to send the first message)
      await waitFor(async () => ((await api("/api/monitor")).activity ?? []).some((a) => a.title === "alert fired: BTC"), { timeout: 10_000, label: "alert" }).catch(() => {});
      await sleep(2500); // and it must not fire again while it stays true
      const fired = ((await api("/api/monitor")).activity ?? []).filter((a) => a.title === "alert fired: BTC").length;
      const jobs1 = (await api("/api/monitor")).jobs.map((j) => j.key);
      await tool("unpin", { app_id: "btc" });
      await sleep(500);
      const jobs2 = (await api("/api/monitor")).jobs.map((j) => j.key);
      const ok = seen.size >= 4 && typeof d.price === "number" && /%$/.test(d.change_pct) && pin.live && w.ok && fired === 1 && jobs1.includes("app:btc") && !jobs2.includes("app:btc");
      return { pass: ok, info: `updates in 6s=${seen.size} price=${d.price} ${d.change_pct} alertFired=${fired} jobs before/after unpin=${jobs1.join(",")} / ${jobs2.join(",")}` };
    },
  },
  {
    name: "tool: http source polls every 5 s",
    tags: ["tool"],
    async run({ home }) {
      const r = await tool("render", { title: "BTC http", spec: { root: "m", components: { m: { type: "Metric", props: { label: "BTC", value: { $bind: "/price" } } } } }, data: {}, source: { type: "http", url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT", refresh_s: 5 } });
      const file = homeFile(home, `canvas/${r.canvas_id}/data.json`);
      const first = readJsonSafe(file)?.updated_at;
      await sleep(11_500);
      const runs = (await api("/api/monitor")).jobs.find((j) => j.key === `canvas:${r.canvas_id}`)?.runs ?? 0;
      const d = readJsonSafe(file);
      return { pass: runs >= 2 && d.updated_at !== first && !!d.price, info: `runs in 11.5s=${runs} price=${d.price}` };
    },
  },
  {
    name: "ui: streamed price changes on the phone in real time",
    tags: ["ui"],
    async run() {
      await tool("render", { title: "BTC", spec: { root: "m", components: { m: { type: "Metric", props: { label: "BTC", value: { $bind: "/price" }, unit: { $bind: "/currency" }, delta: { $bind: "/change_pct" }, trend: { $bind: "/trend" } } } } }, data: {}, source: { type: "stream", provider: "binance", symbol: "BTCUSDT" } });
      const p = await phone();
      try {
        await openCanvas(p.page);
        await p.page.waitForSelector(".c-metric-value");
        const n0 = p.events.length;
        await sleep(5000);
        const updates = p.events.slice(n0).filter((e) => e.type === "canvas").length;
        const text = await p.page.locator(".c-metric-value").textContent();
        return { pass: updates >= 4 && /\d/.test(text), info: `canvas updates in 5s=${updates} shown=${text}` };
      } finally {
        await p.close();
      }
    },
  },

  // ---------------- text brain ----------------
  {
    name: "text: quick question → no task",
    tags: ["text"],
    async run({ home }) {
      const t0 = Date.now();
      const r = await chat("What is 15 percent of 80?", "e2e-quick");
      const tasks = await listTasks(home);
      return { pass: /12/.test(r.text ?? "") && tasks.length === 0, info: `"${(r.text ?? "").slice(0, 60)}" tasks=${tasks.length}`, metrics: { ms: Date.now() - t0 } };
    },
  },
  {
    name: "text: weather chart via Open-Meteo → auto task",
    tags: ["text"],
    async run({ home }) {
      const t0 = Date.now();
      await chat("What will the weather be next week in Lisbon?", "e2e-weather");
      const c = await latestCanvas();
      const tasks = await listTasks(home);
      const ok = !!c && c.components.includes("Chart") && tasks.some((t) => t.kind === "request" && t.result?.canvas_id);
      return { pass: ok, info: `canvas=${c?.title} comps=${c?.components?.join(",")} tasks=${tasks.map((t) => t.title).join("|")}`, metrics: { ms: Date.now() - t0 } };
    },
  },
  {
    name: "text: make live on canvas, then pin keeps job",
    tags: ["text"],
    async run() {
      await chat("Show Apple's stock price and keep it updating live", "e2e-live");
      const c = await latestCanvas();
      const jobs1 = (await api("/api/monitor")).jobs.map((j) => j.key);
      await chat("Pin it", "e2e-live");
      const jobs2 = (await api("/api/monitor")).jobs.map((j) => j.key);
      const ok = c?.live === true && jobs1.some((k) => k.startsWith("canvas:")) && jobs2.some((k) => k.startsWith("app:"));
      return { pass: ok, info: `live=${c?.live} jobs1=${jobs1.join(",")} jobs2=${jobs2.join(",")}` };
    },
  },
  {
    name: "text: brain-dump → parallel tasks with right kinds",
    tags: ["text"],
    async run({ home }) {
      const t0 = Date.now();
      await chat("A bunch of things: call Mark about the 5 euros, a route to the airport, what's the weather in Spain this weekend, and help me pack for London on Monday.", "e2e-dump");
      const tasks = await waitFor(async () => {
        const ts = (await listTasks(home)).filter((t) => t.kind !== "request");
        return ts.length >= 4 && ts.every((t) => ["done", "waiting_user", "failed"].includes(t.status)) ? ts : null;
      }, { timeout: 150_000, label: "tasks settle" });
      const kinds = tasks.map((t) => `${t.kind}:${t.status}`).sort();
      const ok = tasks.some((t) => t.kind === "approval" && t.status === "waiting_user") && tasks.some((t) => t.result?.link?.href?.includes("google.com/maps")) && !tasks.some((t) => t.status === "failed");
      return { pass: ok, info: kinds.join(" "), metrics: { ms: Date.now() - t0 } };
    },
  },

  {
    name: "text: correction amends the pending email (no duplicate)",
    tags: ["text"],
    async run({ home }) {
      const pending = async () => (await api("/api/state")).approvals ?? [];
      await chat("Email Laura that I can do Saturday for the hike", "e2e-amend");
      const first = await waitFor(async () => ((await pending()).length ? await pending() : null), { timeout: 90_000, label: "first card" });
      await chat("Actually, make it Sunday instead", "e2e-amend");
      const card = await waitFor(async () => {
        const p = await pending();
        const txt = JSON.stringify(p);
        return p.length === 1 && /sunday/i.test(txt) && !/saturday works|can do saturday/i.test(txt) ? p[0] : null;
      }, { timeout: 120_000, label: "amended card" }).catch(() => null);
      const emailTasks = (await listTasks(home)).filter((t) => t.kind === "approval");
      const ok = !!card && emailTasks.length === 1;
      return { pass: ok, info: `first="${first[0]?.card?.title}" amended=${!!card} approvalTasks=${emailTasks.length} (${emailTasks.map((t) => t.status).join(",")})` };
    },
  },
  {
    name: "text: cancel withdraws the pending call",
    tags: ["text"],
    async run({ home }) {
      const pending = async () => (await api("/api/state")).approvals ?? [];
      await chat("Call Mark about the 5 euros", "e2e-cancel");
      await waitFor(async () => ((await pending()).length ? true : null), { timeout: 90_000, label: "call card" });
      await chat("Never mind, cancel the call to Mark", "e2e-cancel");
      const done = await waitFor(async () => {
        const ts = (await listTasks(home)).filter((t) => t.kind === "approval");
        return ts.length && ts.every((t) => t.status === "cancelled") && (await pending()).length === 0 ? ts : null;
      }, { timeout: 60_000, label: "cancelled" }).catch(() => null);
      const ts = (await listTasks(home)).filter((t) => t.kind === "approval");
      return { pass: !!done, info: `tasks=${ts.map((t) => `${t.title}:${t.status}`).join(" | ")} pendingCards=${(await pending()).length}` };
    },
  },

  {
    name: "text: edit a card in chat, then 'send it' waits out the undo window",
    tags: ["text"],
    async run() {
      const p = await phone();
      try {
        const pending = async () => (await api("/api/state")).approvals ?? [];
        await chat("Email Mark that dinner is at 8 tonight", "e2e-voiceapprove");
        await waitFor(async () => ((await pending()).length ? true : null), { timeout: 90_000, label: "card" });
        await chat("Change it to 9 instead", "e2e-voiceapprove");
        const edited = await waitFor(async () => {
          const ps = await pending();
          return ps.length === 1 && /\b9\b|nine/i.test(JSON.stringify(ps[0].card)) ? ps[0] : null;
        }, { timeout: 90_000, label: "edited card" }).catch(() => null);
        await chat("Great, send it", "e2e-voiceapprove");
        const commit = await waitFor(async () => p.events.find((e) => e.type === "modal.commit"), { timeout: 60_000, label: "commit" }).catch(() => null);
        const close = commit && (await waitFor(async () => p.events.find((e) => e.type === "modal.close" && e.t >= commit.t), { timeout: 15_000, label: "close" }).catch(() => null));
        const windowMs = commit && close ? close.t - commit.t : null;
        const ok = !!edited && !!commit && windowMs != null && windowMs >= 4000 && windowMs <= 8000;
        return { pass: ok, info: `edited=${!!edited} commit=${!!commit} closedAfter=${windowMs}ms` };
      } finally {
        await p.close();
      }
    },
  },

  {
    name: "text: 'remind me in 10 seconds' schedules and fires",
    tags: ["text"],
    async run() {
      const p = await phone();
      try {
        await chat("Remind me in 10 seconds to drink water", "e2e-remind");
        const list = await api("/api/triggers");
        const toast = await waitFor(async () => p.events.find((e) => e.type === "toast" && /water/i.test(e.text)), { timeout: 25_000, label: "reminder" }).catch(() => null);
        return { pass: list.length === 1 && !!toast, info: `scheduled=${list.map((t) => `${t.label}@${t.at}`).join(",")} fired=${!!toast}` };
      } finally {
        await p.close();
      }
    },
  },

  {
    name: "text: operate widgets by request (mark a card, add to a pinned list)",
    tags: ["text"],
    async run() {
      await tool("render", { title: "Packing", spec: { root: "s", components: { s: { type: "CardStack", props: { cards: { $bind: "/items" } } } } }, data: { items: [{ id: "p", title: "Passport", icon: "🛂" }, { id: "c", title: "Charger", icon: "🔌" }, { id: "r", title: "Raincoat", icon: "🧥" }] } });
      await chat("Mark the passport as packed", "e2e-ui-text");
      const s1 = (await tool("read_widget", {})).widgets[0].state;
      await tool("render", { title: "Shopping", spec: { root: "l", components: { l: { type: "Checklist", props: { items: [{ text: "Bread" }] } } } }, data: {} });
      const pin = await tool("pin", { slug: "shopping" });
      await tool("render", { title: "Other", spec: { root: "t", components: { t: { type: "Text", props: { text: "something else" } } } }, data: {} });
      await chat("Add oat milk and eggs to my shopping list", "e2e-ui-text");
      const s2 = (await tool("read_widget", { target: pin.app_id })).widgets[0].state.items.join("|").toLowerCase();
      const ok = s1.done.includes("Passport") && /oat milk/.test(s2) && /eggs/.test(s2);
      return { pass: ok, info: `done=${s1.done.join(",")} shopping=${s2}` };
    },
  },

  {
    name: "text: 'Bitcoin price in real time' uses a stream",
    tags: ["text"],
    async run() {
      await chat("Show me the Bitcoin price in real time", "e2e-stream");
      const c = await tool("get_state", { scope: "canvas" });
      const id = c.canvas?.id;
      const job = (await api("/api/monitor")).jobs.find((j) => j.key === `canvas:${id}`);
      return { pass: !!job && /binance/.test(job.source), info: `canvas=${c.canvas?.title} job=${job?.key} source=${job?.source}` };
    },
  },

  // ---------------- UI ----------------
  {
    name: "ui: card stack done/later survives re-render + reload, collapses",
    tags: ["ui"],
    async run() {
      await tool("render", { title: "Pack", spec: { root: "s", components: { s: { type: "CardStack", props: { cards: { $bind: "/items" } } } } }, data: { items: [{ id: "a", title: "A" }, { id: "b", title: "B" }, { id: "c", title: "C" }], n: 0 } });
      const p = await phone();
      try {
        const { page } = p;
        await openCanvas(page);
        await page.waitForSelector(".c-card");
        await page.locator(".c-stack-actions .btn.success").tap();
        await sleep(400);
        await page.locator(".c-stack-actions .btn", { hasText: "Later" }).tap();
        await sleep(400);
        const cid = (await latestCanvas()).id;
        await tool("update_data", { target: cid, patch: { n: 1 } });
        await sleep(600);
        const left1 = await page.locator(".c-stack-count").textContent();
        await page.reload();
        await page.waitForSelector(".conn.ok");
        await openCanvas(page);
        await page.waitForSelector(".c-card");
        const left2 = await page.locator(".c-stack-count").textContent();
        for (let i = 0; i < 2; i++) {
          await page.locator(".c-stack-actions .btn.success").tap();
          await sleep(400);
        }
        const done = await page.locator(".c-stack-done").count();
        return { pass: left1 === "2 left" && left2 === "2 left" && done === 1 && !p.errors.length, info: `${left1} / ${left2} / collapsed=${done} errors=${p.errors.length}` };
      } finally {
        await p.close();
      }
    },
  },
  {
    name: "ui: voice approval shows undo countdown; Undo keeps it; edits update the card",
    tags: ["ui"],
    async run() {
      const p = await phone();
      try {
        const { page } = p;
        await tool("ask_approval", { card: { title: "Email Test?", body: "x", fields: [{ name: "to", label: "To", value: "t@example.com" }, { name: "body", label: "Message", value: "Dinner at 8", editable: true }] } });
        await page.waitForSelector(".sheet .c-approval-title");
        const ed = await tool("resolve_approval", { action: "edit", fields: { body: "Dinner at 9" } });
        await sleep(500);
        const shown = await page.locator(".sheet .c-field input, .sheet .c-field textarea").evaluateAll((els) => els.map((e) => e.value));
        const priv = await tool("resolve_approval", { action: "edit", fields: { to: "x@y.z" } });
        await tool("resolve_approval", { action: "accept" });
        await page.waitForSelector(".c-approval-actions.commit", { timeout: 3000 });
        await page.locator(".c-approval-actions.commit .btn").tap();
        await sleep(6500);
        const stillPending = (await api("/api/state")).approvals.length;
        await tool("resolve_approval", { action: "reject" });
        const ok = ed.ok && shown.join("|").includes("Dinner at 9") && !!priv.error && stillPending === 1 && !p.errors.length;
        return { pass: ok, info: `edit=${!!ed.ok} shown="${shown.join("|")}" privateBlocked=${!!priv.error} pendingAfterUndo=${stillPending}` };
      } finally {
        await p.close();
      }
    },
  },
  {
    name: "ui: edit mode — size chip and drag move a widget (user-placed)",
    tags: ["ui"],
    async run({ home }) {
      for (const slug of ["m1", "m2"]) {
        await tool("render", { title: slug, spec: { root: "m", components: { m: { type: "Metric", props: { label: slug, value: 1 } } } }, data: {} });
        await tool("pin", { slug });
      }
      const p = await phone();
      try {
        const { page } = p;
        await page.locator(".dot").nth(0).click();
        await sleep(700);
        await page.locator(".screen-top .chip").first().click();
        await page.waitForSelector(".widget.editing");
        // size chip: m1 → Wide (fits at row 0? no: m2 at 2,0 → moves to first free row)
        await page.locator(".widget", { hasText: "m1" }).locator(".size-chips button", { hasText: "W" }).click({ force: true });
        await sleep(900);
        const m1 = readJsonSafe(homeFile(home, "apps/m1/app.json")).layout;
        // drag m2 to the bottom-left cell
        const g = await page.locator(".screen-grid").boundingBox();
        const w = await page.locator(".widget", { hasText: "m2" }).boundingBox();
        await page.mouse.move(w.x + w.width / 2, w.y + w.height / 2);
        await page.mouse.down();
        await page.mouse.move(g.x + g.width * 0.25, g.y + g.height * 0.88, { steps: 8 });
        await page.mouse.up();
        await sleep(900);
        const m2 = readJsonSafe(homeFile(home, "apps/m2/app.json")).layout;
        await page.locator(".screen-top .chip").first().click();
        const ok = m1.size === "W" && m1.locked && m2.y === 4 && m2.x === 0 && m2.locked && !p.errors.length;
        return { pass: ok, info: `m1=${JSON.stringify(m1)} m2=${JSON.stringify(m2)} errors=${p.errors.length}` };
      } finally {
        await p.close();
      }
    },
  },
  {
    name: "ui: approval card is editable at once, no duplicate text, ✕ left / ✓ right, edits are sent",
    tags: ["ui"],
    async run() {
      const p = await phone();
      try {
        const { page } = p;
        const sent = [];
        page.on("websocket", (ws) => ws.on("framesent", (f) => { try { const e = JSON.parse(f.payload); if (e.type === "ui.event") sent.push(e); } catch {} }));
        await page.reload();
        await page.waitForSelector(".conn.ok");
        await tool("ask_approval", { card: { title: "Email Mark?", body: "Sends from your email account as shown.", accept_label: "Send", fields: [{ name: "to", label: "To", value: "mark@example.com", editable: true }, { name: "subject", label: "Subject", value: "Dinner", editable: true }, { name: "body", label: "Message", value: "See you at 8", editable: true }] } });
        await page.waitForSelector(".sheet textarea");
        const modify = await page.locator(".sheet .btn", { hasText: "Modify" }).count();
        const sheetText = await page.locator(".sheet").innerText();
        const dup = (sheetText.match(/See you at 8/g) ?? []).length; // textarea values aren't in innerText: should be 0
        const btns = await page.locator(".sheet .c-approval-actions .btn").allTextContents();
        await page.locator(".sheet textarea").fill("See you at 9 instead");
        await page.locator(".sheet .btn.accept").tap();
        await sleep(600);
        const ev = sent.find((e) => e.event.startsWith("approval."));
        const ok = modify === 0 && dup === 0 && /Reject/.test(btns[0] ?? "") && /Send/.test(btns[btns.length - 1] ?? "") && ev?.event === "approval.modify" && ev.payload?.fields?.body === "See you at 9 instead";
        return { pass: ok, info: `modifyBtn=${modify} dupText=${dup} buttons=${JSON.stringify(btns)} sent=${ev?.event} body="${ev?.payload?.fields?.body}"` };
      } finally {
        await p.close();
      }
    },
  },
  {
    name: "ui: dashboard loads and streams activity",
    tags: ["ui"],
    async run() {
      const { chromium } = await import("playwright-core");
      const { CHROME, BASE, TOKEN } = await import("../lib.mjs");
      const browser = await chromium.launch({ executablePath: CHROME, headless: true });
      try {
        const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
        await page.goto(`${BASE}/dashboard#token=${TOKEN}`);
        await page.waitForSelector(".pill.ok", { timeout: 15_000 });
        const before = await page.locator(".act").count();
        await tool("render", { spec: { root: "t", components: { t: { type: "Text", props: { text: "x" } } } }, data: {} });
        await tool("notify", { text: "hi" });
        await sleep(800);
        const after = await page.locator(".act").count();
        return { pass: after > before, info: `activity rows ${before}→${after}` };
      } finally {
        await browser.close();
      }
    },
  },
  {
    name: "ui: reset clears state",
    tags: ["ui"],
    async run({ home }) {
      await tool("render", { title: "R", spec: { root: "t", components: { t: { type: "Text", props: { text: "r" } } } }, data: {} });
      await tool("pin", { slug: "r" });
      await api("/api/reset", { method: "POST" });
      const apps = await listApps(home);
      const c = await latestCanvas();
      return { pass: apps.length === 0 && !c, info: `apps=${apps.length} canvas=${c?.id ?? "none"}` };
    },
  },

  // ---------------- email / calls / privacy ----------------
  {
    name: "email+call: reply threaded, missing number asked, no leaks",
    tags: ["email"],
    async run({ home, email }) {
      if (!email) return { pass: true, skipped: true, info: "no test mailbox (Ethereal unavailable)" };
      const p = await phone();
      const seen = [];
      try {
        const { page } = p;
        const handle = async (max, phoneNo) => {
          for (let i = 0; i < max; i++) {
            const ok = await page.waitForSelector(".sheet .c-approval-title", { timeout: 90_000 }).then(() => true).catch(() => false);
            if (!ok) return;
            await sleep(300);
            const title = await page.locator(".sheet .c-approval-title").textContent();
            seen.push(title);
            if (/phone number|email\?/i.test(title)) {
              await page.locator(".sheet input").first().fill(phoneNo);
              await page.locator(".sheet .btn.primary").tap();
            } else {
              await page.locator(".sheet .btn.primary").tap();
              return;
            }
            await sleep(1200);
          }
        };
        const r1 = chat("Reply to Laura's latest email saying Saturday works for me", "e2e-mail");
        await handle(2);
        await r1;
        const r2 = chat("Call Laura about the hike", "e2e-mail");
        await handle(3, "+34 699 888 777");
        await r2;
        await sleep(1500);
        const sent = await email.inbox();
        const replied = sent.some((m) => /^Re:/i.test(m.subject) && m.inReplyTo);
        const saved = JSON.stringify(readJsonSafe(homeFile(home, "identity/contacts.json"))).includes("699 888 777");
        const logs = (await fs.readdir(homeFile(home, "sessions"))).map((f) => f);
        let leak = false;
        for (const f of logs) {
          const txt = await fs.readFile(homeFile(home, `sessions/${f}`), "utf8");
          for (const line of txt.trim().split("\n")) {
            const e = JSON.parse(line);
            const s = JSON.stringify({ a: e.args, o: e.out, t: e.text });
            if (/laura@example\.com|611 222 333|699 888 777/.test(s)) leak = true;
          }
        }
        return { pass: replied && saved && !leak, info: `cards=${seen.join(" → ")} replied=${replied} saved=${saved} leak=${leak}` };
      } finally {
        await p.close();
      }
    },
  },

  {
    name: "email: watch_email drafts a reply to a new email for approval",
    tags: ["email"],
    async run({ home, email }) {
      if (!email) return { pass: true, skipped: true, info: "no test mailbox" };
      const w = await tool("watch_email", { from: "Laura", instructions: "keep it short" });
      await api("/api/email/check", { method: "POST" }); // first check sets the baseline (old mail ignored)
      await email.send("Laura", "laura@example.com", "Dinner on Friday?", "Hi! Want to have dinner on Friday at 9? — Laura");
      await sleep(4000);
      const r = await waitFor(async () => {
        const c = await api("/api/email/check", { method: "POST" });
        return c.drafted ? c : null;
      }, { timeout: 60_000, every: 3000, label: "drafted" }).catch(() => null);
      const card = await waitFor(async () => {
        const ap = (await api("/api/state")).approvals ?? [];
        return ap.find((a) => /laura/i.test(String(a.card.title))) ?? null;
      }, { timeout: 90_000, label: "reply card" }).catch(() => null);
      const tasks = await listTasks(home);
      // the card + task are the outcome; `drafted` is informational (a check that raced an earlier one reports 0)
      const ok = w.ok && !!card && tasks.some((t) => /reply to laura/i.test(t.title));
      return { pass: ok, info: `trigger=${!!w.ok} drafted=${r?.drafted ?? 0} card="${card?.card?.title ?? "-"}" tasks=${tasks.map((t) => t.title).join(" | ")}` };
    },
  },

  {
    name: "ui: home ↔ canvas — swipe up fades the canvas in, pull down from its top fades it out",
    tags: ["ui"],
    async run() {
      await tool("render", { title: "Hello", spec: { root: "m", components: { m: { type: "Metric", props: { label: "Hello", value: 1 } } } }, data: {} });
      const p = await phone();
      try {
        const { page } = p;
        const cls = () => page.evaluate(() => document.querySelector(".app").className);
        const startsHome = /\bhome\b/.test(await cls()) && (await page.locator(".bottombar.away").count()) === 1;
        await touchDrag(page, 190, 600, 400);
        await sleep(450);
        const opened = /canvas-open/.test(await cls()) && (await page.locator(".c-metric-value").isVisible()) && (await page.locator(".bottombar.away").count()) === 0;
        await touchDrag(page, 190, 250, 450);
        await sleep(450);
        const closed = /\bhome\b/.test(await cls()) && !(await page.locator(".c-metric-value").isVisible());
        await page.click(".home-handle");
        await sleep(450);
        const handle = /canvas-open/.test(await cls());
        const ok = startsHome && opened && closed && handle && !p.errors.length;
        return { pass: ok, info: `startsHome=${startsHome} swipeUp=${opened} pullDown=${closed} handle=${handle} errors=${p.errors.length}` };
      } finally {
        await p.close();
      }
    },
  },

  {
    name: "ui: reset demo — two demo widgets side by side, pictures load, checklist taps",
    tags: ["ui"],
    async run({ home }) {
      const r = await api("/api/reset-demo", { method: "POST" });
      const p = await phone();
      try {
        const { page } = p;
        await page.waitForSelector(".widget iframe", { timeout: 8000 });
        await sleep(1500);
        const apps = await listApps(home);
        const frames = page.frames().filter((f) => f !== page.mainFrame());
        let imgs = 0;
        for (const f of frames) imgs += await f.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth > 0).length).catch(() => 0);
        let tapped = false;
        for (const f of frames) {
          const li = f.locator("li").nth(2);
          if (await li.count()) { await li.click(); tapped = (await li.getAttribute("class")) === "on"; }
        }
        if (process.env.E2E_SHOTS) await page.screenshot({ path: process.env.E2E_SHOTS + "/demo.png" });
        const boxes = await page.locator(".widget").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((b) => [Math.round(b.x), Math.round(b.y)]));
        const sideBySide = boxes.length === 2 && boxes[0][1] === boxes[1][1] && boxes[0][0] !== boxes[1][0];
        const ok = r.ok && apps.sort().join() === "leg-day,sneaker-watch" && imgs === 2 && tapped && sideBySide && !p.errors.length;
        return { pass: ok, info: `apps=${apps} imgs=${imgs} tapped=${tapped} sideBySide=${sideBySide} boxes=${JSON.stringify(boxes)} errors=${p.errors.length}` };
      } finally {
        await p.close();
      }
    },
  },

  // ---------------- voice (slowest; real GPT-Live) ----------------
  {
    name: "voice: pull down on home starts Talk; the canvas fades in when the agent answers",
    tags: ["voice"],
    async run() {
      const wav = await speechWav("pull-talk", [4, "Hi! What is two plus two?", 25]);
      const p = await phone({ micWav: wav });
      try {
        const { page } = p;
        const cls = () => page.evaluate(() => document.querySelector(".app").className);
        await touchDrag(page, 190, 250, 420);
        const live = await page.waitForFunction(() => document.querySelector(".talk-btn")?.classList.contains("live"), null, { timeout: 20_000 }).then(() => true).catch(() => false);
        const homeWhileListening = /\bhome\b/.test(await cls()) && (await page.locator(".bottombar.away").count()) === 0;
        const answered = await waitFor(async () => finals(p.events, "agent").length > 0 || p.events.some((e) => e.type === "transcript" && e.role === "agent"), { timeout: 45_000, label: "agent answer" }).then(() => true).catch(() => false);
        await sleep(500);
        const canvasIn = /canvas-open/.test(await cls());
        await stopVoice(page);
        const ok = live && homeWhileListening && answered && canvasIn && !p.errors.length;
        return { pass: ok, info: `live=${live} homeWhileListening=${homeWhileListening} answered=${answered} canvasIn=${canvasIn} errors=${p.errors.length}` };
      } finally {
        await p.close();
      }
    },
  },
  {
    name: "voice: weather → chart while speaking",
    tags: ["voice"],
    async run() {
      const wav = await speechWav("weather", [4, "Hi! Show me the weather in Lisbon for next week, please.", 40]);
      const p = await phone({ micWav: wav });
      try {
        await startVoice(p.page);
        const t0 = Date.now();
        await waitFor(async () => p.events.some((e) => e.type === "canvas"), { timeout: 60_000, label: "canvas" });
        const tCanvas = Date.now() - t0;
        await sleep(6000);
        const agent = finals(p.events, "agent").map((e) => e.text).join(" / ");
        await stopVoice(p.page);
        return { pass: !!agent, info: `agent: ${agent.slice(0, 120)}`, metrics: { msToCanvas: tCanvas } };
      } finally {
        await p.close();
      }
    },
  },
  {
    name: "voice: approval arrives as a pill, opens when the conversation is idle",
    tags: ["voice"],
    async run() {
      const wav = await speechWav("tray", [4, "Please email Mark that dinner is at eight tonight.", 45]);
      const p = await phone({ micWav: wav });
      try {
        const { page } = p;
        await startVoice(page);
        const modal = await waitFor(async () => p.events.find((e) => e.type === "modal"), { timeout: 60_000, label: "card" });
        await sleep(300);
        const pillFirst = (await page.locator(".approval-pill").count()) === 1 && (await page.locator(".sheet .c-approval-title").count()) === 0;
        const opened = await waitFor(async () => (await page.locator(".sheet .c-approval-title").count()) > 0, { timeout: 25_000, label: "sheet opens" }).then(() => Date.now()).catch(() => null);
        // speech before the sheet opened (speech that starts after it opened doesn't count)
        const lastTalk = Math.max(...p.events.filter((e) => e.type === "transcript" && (!opened || e.t <= opened)).map((e) => e.t), modal.t);
        await stopVoice(page);
        const ok = pillFirst && !!opened && opened - lastTalk >= 3000;
        return { pass: ok, info: `pillFirst=${pillFirst} opened=${!!opened} quietBeforeOpen=${opened ? opened - lastTalk : "-"}ms` };
      } finally {
        await p.close();
      }
    },
  },
  {
    name: "voice: go through a list one by one, marking each when the user confirms",
    tags: ["voice"],
    async run() {
      await tool("render", { title: "Packing", spec: { root: "s", components: { s: { type: "CardStack", props: { cards: { $bind: "/items" } } } } }, data: { items: [{ id: "p", title: "Passport", icon: "🛂" }, { id: "c", title: "Charger", icon: "🔌" }, { id: "r", title: "Raincoat", icon: "🧥" }] } });
      const wav = await speechWav("dictate", [4, "Go through my packing list one by one, and wait until I say it's packed.", 9, "Packed.", 8, "Packed.", 8, "Okay, that one is packed too.", 25]);
      const p = await phone({ micWav: wav });
      try {
        await startVoice(p.page);
        const done = await waitFor(async () => {
          const st = (await tool("read_widget", {})).widgets[0].state;
          return st.done.length >= 2 ? st : null;
        }, { timeout: 75_000, label: "2 cards done by voice" }).catch(async () => (await tool("read_widget", {})).widgets[0].state);
        await stopVoice(p.page);
        const agent = finals(p.events, "agent").map((e) => e.text).join(" / ").slice(0, 160);
        return { pass: done.done.length >= 2, info: `done=${done.done.join(",")} left=${done.remaining_in_order.join(",")} agent: ${agent}` };
      } finally {
        await p.close();
      }
    },
  },
  {
    name: "voice: barge-in stops speech",
    tags: ["voice"],
    async run() {
      const wav = await speechWav("bargein", [4, "Please count slowly from one to forty, one number per sentence.", 12, "Stop! Wait a second. Actually, what time is it in Tokyo?", 30]);
      const p = await phone({ micWav: wav });
      try {
        await startVoice(p.page);
        await sleep(42_000);
        const agent = finals(p.events, "agent").map((e) => e.text);
        const counting = agent.find((t) => /one\b.*two\b/i.test(t)) ?? "";
        const stopped = !/thirty|forty/i.test(counting);
        const answered = agent.some((t) => /tokyo|:\d\d|\d\d:\d\d/i.test(t));
        await stopVoice(p.page);
        return { pass: stopped && answered, info: `stopped=${stopped} answered=${answered}` };
      } finally {
        await p.close();
      }
    },
  },
  {
    name: "voice: brain-dump with a pause → every request handled",
    tags: ["voice"],
    async run({ home }) {
      const wav = await speechWav("dump", [4, "Okay, a bunch of things. I need to call Mark about the five euros he lent me. Get me a route to the airport. What's the weather in Spain this weekend?", 1.2, "And help me pack for my London trip on Monday.", 60]);
      const p = await phone({ micWav: wav });
      // judge outcomes, not mechanism: each intent must be handled by some tool call (direct or via a task)
      const evidence = async () => {
        const dir = homeFile(home, "sessions");
        let txt = "";
        for (const f of await fs.readdir(dir).catch(() => [])) txt += await fs.readFile(path.join(dir, f), "utf8");
        const tools = txt.split("\n").filter((l) => l.includes('"type":"tool"')).join("\n").toLowerCase();
        const tasks = JSON.stringify(await listTasks(home)).toLowerCase();
        const all = tools + tasks;
        return {
          call: /call_contact|"kind":"approval"[^}]*mark|call mark/.test(all),
          route: /maps_link|airport/.test(all),
          weather: /"weather"|weather/.test(all),
          packing: /pack/.test(all),
        };
      };
      try {
        await startVoice(p.page);
        const ev = await waitFor(async () => {
          const e = await evidence();
          return Object.values(e).every(Boolean) ? e : null;
        }, { timeout: 90_000, label: "all 4 handled" }).catch(() => evidence());
        await sleep(3000);
        await stopVoice(p.page);
        const missing = Object.entries(ev).filter(([, v]) => !v).map(([k]) => k);
        return { pass: missing.length === 0, info: missing.length ? `missing: ${missing.join(", ")}` : "call, route, weather, packing all handled" };
      } finally {
        await p.close();
      }
    },
  },
];
