import fs from "node:fs/promises";
import path from "node:path";
import { clearApprovals } from "./approvals.ts";
import { clearTextSessions } from "./brain.ts";
import { bus } from "./bus.ts";
import { env } from "./env.ts";
import { lock } from "./fsutil.ts";
import { stopAllJobs } from "./jobs.ts";
import { stopAllTriggers } from "./triggers.ts";
import { paths, readScreens, writeScreens } from "./store.ts";
import { stopAllTasks } from "./taskrunner.ts";
import { closeAllLiveSessions } from "./voice/live.ts";

const STATE = ["canvas", "apps", "tasks", "sessions", "uploads", "triggers", "screens.json"] as const;
const KEEP_BACKUPS = 5;

/**
 * Reset runtime state to a fresh agent-home. Identity and themes (your profile and
 * design tokens) are kept; canvases, widgets, tasks, sessions and screens are moved to
 * agent-home/.backups/<timestamp>/ (restorable by moving them back) and reseeded.
 */
export async function moveStateToBackup(): Promise<string> {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(paths.home, ".backups", stamp);
  await fs.mkdir(dest, { recursive: true });
  for (const name of STATE) {
    await fs.rename(path.join(paths.home, name), path.join(dest, name)).catch(() => {});
  }
  // reseed from template (empty folders + default screens), keep the active theme
  for (const d of ["canvas", "apps/_trash", "tasks", "sessions", "uploads", "triggers"]) await fs.mkdir(path.join(paths.home, d), { recursive: true });
  await fs.copyFile(path.join(env.TEMPLATE_HOME, "screens.json"), paths.screens);
  // prune old backups
  const all = (await fs.readdir(path.join(paths.home, ".backups"))).sort();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) await fs.rm(path.join(paths.home, ".backups", old), { recursive: true, force: true });
  return path.relative(paths.home, dest);
}

export async function resetState() {
  return lock("screens", async () => {
    const theme = (await readScreens()).active_theme;
    stopAllJobs();
    stopAllTriggers();
    stopAllTasks();
    clearApprovals();
    clearTextSessions();
    await closeAllLiveSessions().catch(() => {});
    const backup = await moveStateToBackup();
    await writeScreens({ ...(await readScreens()), active_theme: theme });
    bus.emit({ type: "reset" });
    console.log(`[reset] state moved to ${backup}`);
    return { ok: true, backup };
  });
}
