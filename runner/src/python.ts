import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { env } from "./env.ts";
import { paths } from "./store.ts";

const MAX_OUT = 64 * 1024;

export interface PyResult { stdout: string; stderr: string; exit_code: number | null; timed_out: boolean; ms: number }

/**
 * Run Python in ./.venv with cwd restricted to AGENT_HOME, a timeout, capped output,
 * and a scrubbed environment (no API keys, HOME redirected into agent-home/tmp so
 * library caches like yfinance's stay inside the repo).
 */
export async function runPython(opts: { code?: string; file?: string; cwd?: string; timeout_s?: number }): Promise<PyResult> {
  const cwd = path.resolve(opts.cwd ?? paths.tmp);
  if (!cwd.startsWith(paths.home)) throw new Error("cwd must be inside AGENT_HOME");
  let file = opts.file;
  let cleanup: string | null = null;
  if (!file) {
    file = path.join(paths.tmp, `run-${randomBytes(4).toString("hex")}.py`);
    await fs.writeFile(file, opts.code ?? "");
    cleanup = file;
  }
  const pyHome = path.join(paths.tmp, ".pyhome");
  await fs.mkdir(pyHome, { recursive: true });
  const python = path.join(env.VENV, "bin", "python");
  const timeoutMs = (opts.timeout_s ?? 30) * 1000;
  const started = Date.now();

  return new Promise((resolve) => {
    const child = spawn(python, ["-u", file!], {
      cwd,
      env: {
        PATH: `${path.join(env.VENV, "bin")}:/usr/bin:/bin`,
        HOME: pyHome,
        XDG_CACHE_HOME: path.join(pyHome, ".cache"),
        MPLCONFIGDIR: path.join(pyHome, ".mpl"),
        PYTHONPATH: env.PYTHON_LIB,
        PYTHONDONTWRITEBYTECODE: "1",
        LANG: "en_US.UTF-8",
        TZ: env.TIMEZONE,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.on("data", (d) => (stdout = (stdout + d).slice(-MAX_OUT)));
    child.stderr.on("data", (d) => (stderr = (stderr + d).slice(-MAX_OUT)));
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(t);
      if (cleanup) void fs.rm(cleanup, { force: true });
      resolve({ stdout, stderr: stderr.slice(-8000), exit_code: code, timed_out: timedOut, ms: Date.now() - started });
    });
    child.on("error", (err) => {
      clearTimeout(t);
      resolve({ stdout, stderr: String(err), exit_code: -1, timed_out: false, ms: Date.now() - started });
    });
  });
}

/** Last line of stdout that parses as a JSON object. */
export function lastJsonObject(stdout: string): Record<string, unknown> | null {
  const lines = stdout.trim().split("\n").reverse();
  for (const l of lines) {
    try {
      const v = JSON.parse(l);
      if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
    } catch {}
  }
  return null;
}
