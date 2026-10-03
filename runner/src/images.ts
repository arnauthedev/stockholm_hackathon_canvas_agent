import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { route } from "../../config/routes.ts";
import { env } from "./env.ts";

/**
 * Image cards (routes.image, Nano Banana). Every picture is a file under agent-home/images with a long
 * random name, served at /files/images/<name> without the token (an <img> can't send it), like uploads.
 * Editing passes the current picture back to the model with the instruction.
 */
export const IMAGE_DIR = path.join(env.AGENT_HOME, "images");
const TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };

let _ai: GoogleGenAI | null = null;
const ai = () => (_ai ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }));

export const imageUrl = (name: string) => `/files/images/${name}`;
export const imageName = (src: unknown) => (typeof src === "string" ? /^\/files\/images\/([\w-]+\.(?:png|jpg|webp))$/.exec(src)?.[1] : undefined);

/** Generates a picture (or edits `from`, a file in IMAGE_DIR) and returns the new file's name. */
export async function makeImage(prompt: string, aspect: string, from?: string): Promise<string> {
  if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set in .env");
  const ext = from?.split(".").pop() ?? "png";
  const input = from
    ? [
        { type: "text" as const, text: prompt },
        { type: "image" as const, mime_type: TYPES[ext] ?? "image/png", data: (await fs.readFile(path.join(IMAGE_DIR, from))).toString("base64") },
      ]
    : prompt;
  const it = await ai().interactions.create({
    model: route("image").model,
    input,
    response_format: { type: "image", aspect_ratio: aspect },
    store: false, // a phone widget, not a conversation to keep on Google's side
  } as Parameters<GoogleGenAI["interactions"]["create"]>[0]);
  const img = (it as { output_image?: { data?: string; mime_type?: string } }).output_image;
  if (!img?.data) throw new Error("the image model returned no picture (it may have declined the prompt)");
  const out = Object.entries(TYPES).find(([, t]) => t === img.mime_type)?.[0] ?? "png";
  const name = `${randomBytes(16).toString("hex")}.${out}`;
  await fs.mkdir(IMAGE_DIR, { recursive: true });
  await fs.writeFile(path.join(IMAGE_DIR, name), Buffer.from(img.data, "base64"));
  return name;
}

export async function serveImage(name: string): Promise<{ body: Buffer; type: string } | null> {
  if (!/^[\w-]+\.(png|jpg|webp)$/.test(name)) return null;
  try {
    return { body: await fs.readFile(path.join(IMAGE_DIR, name)), type: TYPES[name.split(".").pop()!]! };
  } catch {
    return null;
  }
}
