import path from "node:path";
import { watch } from "chokidar";
import type { ServerEvent } from "@canvas-agent/contract";
import { bus } from "./bus.ts";
import { activeTheme, isCanvasId, paths, readApp, readCanvas, readScreens, readTask } from "./store.ts";

/** Every write under canvas/, apps/, tasks/, screens.json, themes/ becomes a bus event (B4). */
export function startWatcher() {
  const pending = new Map<string, NodeJS.Timeout>();
  let lastTheme = "";

  const schedule = (key: string, fn: () => Promise<ServerEvent | ServerEvent[] | null>) => {
    clearTimeout(pending.get(key));
    pending.set(
      key,
      setTimeout(async () => {
        pending.delete(key);
        try {
          const ev = await fn();
          for (const e of Array.isArray(ev) ? ev : ev ? [ev] : []) bus.emit(e);
        } catch (err) {
          console.warn("[watcher]", key, err);
        }
      }, 40),
    );
  };

  const themeEvent = async (): Promise<ServerEvent | null> => {
    const t = await activeTheme();
    const sig = JSON.stringify(t);
    if (sig === lastTheme) return null;
    lastTheme = sig;
    return { type: "theme", theme: t };
  };
  void activeTheme().then((t) => (lastTheme = JSON.stringify(t)));

  const onPath = (abs: string) => {
    const rel = path.relative(paths.home, abs).split(path.sep);
    const [top, id] = rel;
    const base = rel[rel.length - 1] ?? "";
    if (base.startsWith(".tmp-") || base.startsWith(".")) return;
    if (top === "canvas" && id && isCanvasId(id)) {
      schedule(`canvas:${id}`, async () => {
        const c = await readCanvas(id);
        return c ? { type: "canvas", canvas: c } : { type: "canvas.removed", id };
      });
    } else if (top === "apps" && id && !id.startsWith("_")) {
      schedule(`app:${id}`, async () => {
        const a = await readApp(id);
        return a ? { type: "app", app: a } : { type: "app.removed", id };
      });
    } else if (top === "tasks" && id) {
      schedule(`task:${id}`, async () => {
        const t = await readTask(id);
        return t ? { type: "task", task: t } : { type: "task.removed", id };
      });
    } else if (top === "screens.json") {
      schedule("screens", async () => {
        const t = await themeEvent();
        return [{ type: "screens", screens: await readScreens() }, ...(t ? [t] : [])];
      });
    } else if (top === "themes") {
      schedule("theme", themeEvent);
    }
  };

  const w = watch(paths.home, {
    ignoreInitial: true,
    ignored: (p) => {
      const rel = path.relative(paths.home, p);
      return rel.startsWith("tmp") || rel.startsWith("sessions") || rel.startsWith("uploads") || rel.startsWith(".backups") || rel.startsWith(path.join("apps", "_trash")) || path.basename(p).startsWith(".tmp-");
    },
  });
  w.on("all", (_ev, p) => onPath(p));
  w.on("error", (err) => console.warn("[watcher] error", err));
  return w;
}
