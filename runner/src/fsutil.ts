import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

/** Atomic write: temp file in the same dir + rename. Temp names start with `.tmp-` (ignored by the watcher). */
export async function atomicWrite(file: string, content: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.tmp-${randomBytes(6).toString("hex")}`);
  await fs.writeFile(tmp, content);
  await fs.rename(tmp, file);
}

export const writeJson = (file: string, obj: unknown) => atomicWrite(file, JSON.stringify(obj, null, 2) + "\n");

export async function readJson<T = unknown>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

export const exists = (p: string) => existsSync(p);

export async function listDirs(dir: string): Promise<string[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".") && !d.name.startsWith("_")).map((d) => d.name).sort();
  } catch {
    return [];
  }
}

export function slugify(s: string, max = 40): string {
  return (
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/, "") || "item"
  );
}

/** Serialize async critical sections (per key). */
const chains = new Map<string, Promise<unknown>>();
export function lock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.catch(() => {}));
  return next;
}

export const now = () => new Date().toISOString();
