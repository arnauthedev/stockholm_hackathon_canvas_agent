import fs from "node:fs/promises";
import path from "node:path";
import type { AppJson, WidgetSize } from "@canvas-agent/contract";
import { env } from "./env.ts";
import { lock, now, writeJson } from "./fsutil.ts";
import { IMAGE_DIR } from "./images.ts";
import { placeNew } from "./layout.ts";
import { resetState } from "./reset.ts";
import { paths } from "./store.ts";

/**
 * Demo reset: a normal reset, then two hand-made widgets on the first screen (a leg-day workout and a
 * sneaker price watch). Their pictures ship in templates/demo/ and are copied into the image folder.
 */
const DEMO_DIR = path.join(path.dirname(env.TEMPLATE_HOME), "demo");

const BASE_CSS = `
.c{display:flex;flex-direction:column;gap:10px;min-height:100%;box-sizing:border-box}
.top{display:flex;align-items:center;gap:10px}
.ic{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;flex:none}
.k{font-size:10px;letter-spacing:.09em;text-transform:uppercase;color:var(--muted);font-weight:600}
.t{font-size:18px;font-weight:750;line-height:1.15;letter-spacing:-.01em}
.pill{align-self:flex-start;font-size:10px;font-weight:750;letter-spacing:.06em;text-transform:uppercase;padding:4px 9px;border-radius:999px}
.muted{color:var(--muted)}
button{font:inherit;color:inherit;cursor:pointer}
`;

const WORKOUT_HTML = `<style>${BASE_CSS}
.c{--tint:var(--success)}
.ic{background:color-mix(in srgb,var(--tint) 20%,transparent);color:var(--tint)}
.pill{background:color-mix(in srgb,var(--tint) 15%,transparent);color:var(--tint)}
ul{list-style:none;margin:2px 0 0;padding:0;display:flex;flex-direction:column;gap:9px}
li{display:flex;align-items:center;gap:9px;font-size:13.5px;cursor:pointer;user-select:none}
.box{width:20px;height:20px;border-radius:6px;border:1.5px solid color-mix(in srgb,var(--tint) 45%,var(--border));display:grid;place-items:center;flex:none;transition:background .2s,border-color .2s}
.box svg{opacity:0;transition:opacity .2s}
li.on .box{background:var(--tint);border-color:var(--tint)}
li.on .box svg{opacity:1}
.n{flex:1;min-width:0;line-height:1.2}
li.on .n{color:var(--muted)}
.r{color:var(--muted);font-size:12.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.pl{margin-top:auto;display:flex;align-items:center;gap:9px;padding:8px;border-radius:14px;background:var(--surface);border:1px solid var(--border)}
.art{position:relative;width:44px;height:44px;flex:none}
.cover{width:100%;height:100%;border-radius:10px;object-fit:cover;background:var(--surface2);display:block}
.pt{flex:1;min-width:0}
.pt b{display:block;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pt span{display:block;font-size:11.5px;color:var(--muted);line-height:1.25}
.play{position:absolute;right:-6px;bottom:-6px;width:26px;height:26px;border-radius:50%;border:2px solid var(--surface);background:var(--text);color:var(--bg);display:grid;place-items:center;padding:0}
</style>
<div class="c">
  <div class="top">
    <div class="ic"><svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M2 10h2V8h2v8H4v-2H2zm4-3h3v10H6zm4 4h4v2h-4zm5-4h3v10h-3zm3 1h2v2h2v4h-2v2h-2z"/></svg></div>
    <div><div class="k">Workout</div><div class="t" id="title"></div></div>
  </div>
  <div class="pill" id="status"></div>
  <ul id="list"></ul>
  <div class="pl">
    <div class="art"><img class="cover" id="cover" alt=""><button class="play" id="play" aria-label="Play"></button></div>
    <div class="pt"><b id="pltitle"></b><span id="plsub"></span></div>
  </div>
</div>
<script>
const PLAY = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4v16l13-8z"/></svg>';
const PAUSE = '<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>';
const CHECK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5L20 7"/></svg>';
let done = null, playing = false;
const $ = (id) => document.getElementById(id);
function draw(d) {
  done ??= (d.exercises || []).map((e) => !!e.done);
  $("title").textContent = d.title || "";
  const left = done.filter((x) => !x).length;
  $("status").textContent = left ? (done.some(Boolean) ? left + " to go" : "Plan ready") : "Done 💪";
  $("list").innerHTML = "";
  (d.exercises || []).forEach((e, i) => {
    const li = document.createElement("li");
    li.className = done[i] ? "on" : "";
    li.innerHTML = '<span class="box">' + CHECK + '</span><span class="n"></span><span class="r"></span>';
    li.querySelector(".n").textContent = e.name;
    li.querySelector(".r").textContent = e.sets;
    li.onclick = () => { done[i] = !done[i]; draw(card.data); };
    $("list").appendChild(li);
  });
  const p = d.playlist || {};
  if (p.cover && $("cover").getAttribute("src") !== p.cover) $("cover").src = p.cover;
  $("pltitle").textContent = p.name || "Playlist";
  $("plsub").textContent = (playing ? "Playing · " : "Ready · ") + (p.tracks || 0) + " tracks";
  $("play").innerHTML = playing ? PAUSE : PLAY;
}
$("play").onclick = () => { playing = !playing; draw(card.data); };
card.onData(draw);
</script>`;

const SNEAKER_HTML = `<style>${BASE_CSS}
.c{--tint:#e8735a;gap:8px}
.ic{background:color-mix(in srgb,var(--tint) 22%,transparent);color:var(--tint)}
.ph{border-radius:14px;overflow:hidden;background:color-mix(in srgb,var(--tint) 10%,var(--surface));aspect-ratio:4/3}
.c .t{font-size:17px}
.ph img{display:block;width:100%;height:100%;object-fit:cover}
.model{font-size:12px;color:var(--muted)}
.price{font-size:19px;font-weight:750;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--muted);padding:5px 9px;border-radius:999px;background:var(--surface);border:1px solid var(--border);align-self:flex-start}
.nt{margin-top:auto;display:flex;align-items:center;gap:7px;padding:7px 7px 7px 10px;border-radius:14px;background:var(--surface);border:1px solid var(--border);font-size:12.5px;font-weight:600;white-space:nowrap}
.nt span{flex:1}
.sw{width:38px;height:24px;border-radius:12px;border:0;padding:0;background:var(--border);position:relative;flex:none;transition:background .2s}
.sw::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgb(0 0 0/.25);transition:transform .2s}
.sw.on{background:var(--success)}
.sw.on::after{transform:translateX(14px)}
</style>
<div class="c">
  <div class="top">
    <div class="ic"><svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M5 8h14l-1 12H6zM9 8V6a3 3 0 0 1 6 0v2"/></svg></div>
    <div><div class="k">Shopping</div><div class="t" id="title"></div></div>
  </div>
  <div class="ph"><img id="img" alt=""></div>
  <div><div class="model" id="model"></div><div class="price" id="price"></div></div>
  <div class="chip"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M4 10v10h16V10M3 4h18l-1 6H4zM10 20v-5h4v5"/></svg><span id="stores"></span></div>
  <div class="nt">
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4"/></svg>
    <span>Sale alert</span>
    <button class="sw" id="sw" role="switch" aria-label="Notify me on sale"></button>
  </div>
</div>
<script>
let on = null;
const $ = (id) => document.getElementById(id);
function draw(d) {
  on ??= !!d.notify;
  $("title").textContent = d.title || "";
  if (d.img && $("img").getAttribute("src") !== d.img) $("img").src = d.img;
  $("model").textContent = d.model || "";
  $("price").textContent = d.price || "";
  $("stores").textContent = (d.stores || 0) + " stores checked";
  $("sw").className = on ? "sw on" : "sw";
  $("sw").setAttribute("aria-checked", String(on));
}
$("sw").onclick = () => { on = !on; draw(card.data); };
card.onData(draw);
</script>`;

const WIDGETS: { slug: string; title: string; size: WidgetSize; html: string; data: Record<string, unknown> }[] = [
  {
    slug: "leg-day",
    title: "Leg Day",
    size: "T",
    html: WORKOUT_HTML,
    data: {
      title: "Leg Day",
      exercises: [
        { name: "Squat", sets: "4 × 8", done: true },
        { name: "Romanian deadlift", sets: "4 × 8", done: true },
        { name: "Leg press", sets: "3 × 12" },
        { name: "Calf raises", sets: "4 × 15" },
      ],
      playlist: { name: "Beast Mode", tracks: 32, cover: "/files/images/demo-playlist.jpg" },
    },
  },
  {
    slug: "sneaker-watch",
    title: "Sneaker watch",
    size: "T",
    html: SNEAKER_HTML,
    data: { title: "Sneaker watch", model: "New Balance 530", price: "1,200 SEK", stores: 3, notify: true, img: "/files/images/demo-sneaker.jpg" },
  },
];

export async function resetDemo() {
  const out = await resetState();
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  for (const f of ["sneaker.jpg", "playlist.jpg"]) await fs.copyFile(path.join(DEMO_DIR, f), path.join(IMAGE_DIR, `demo-${f}`)).catch(() => {});
  await lock("screens", async () => {
    for (const w of WIDGETS) {
      const dir = paths.appDir(w.slug);
      await fs.mkdir(dir, { recursive: true });
      await writeJson(path.join(dir, "spec.json"), { title: w.title, root: "c", components: { c: { type: "Custom", props: { html: w.html } } } });
      await writeJson(path.join(dir, "data.json"), w.data);
      const app: AppJson = { schema_version: 1, id: w.slug, title: w.title, screen: "s1", pinned_at: now(), refresh_s: null };
      await writeJson(path.join(dir, "app.json"), app);
      await placeNew(w.slug, w.size);
    }
  });
  return out;
}
