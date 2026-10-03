import { createOpenAI } from "@ai-sdk/openai";
import { jsonSchema, tool, type ToolSet } from "ai";
import { HelperArgs, HelperDescriptions, ToolArgs, ToolDescriptions, type HelperName, type ToolName } from "@canvas-agent/contract";
import { z } from "zod";
import { route, type RouteJob } from "../../config/routes.ts";
import { env } from "./env.ts";
import { executeTool, type ToolCtx } from "./executor.ts";

export const openaiProvider = createOpenAI({ apiKey: env.OPENAI_API_KEY });

/** Resolve a route (with ROUTE_<job> overrides) to an AI SDK model. */
export function modelFor(job: RouteJob) {
  const r = route(job);
  if (!r.enabled) throw new Error(`route ${job} is disabled`);
  if (r.provider !== "openai") throw new Error(`provider ${r.provider} for ${job} not wired yet (see config/routes.ts)`);
  return { model: openaiProvider.responses(r.model), route: r };
}

const schemaOf = (s: z.ZodTypeAny) => jsonSchema(z.toJSONSchema(s, { io: "input" }) as Parameters<typeof jsonSchema>[0]);

/** Contract tools as AI SDK tools, executed by the runner executor. */
export function contractTools(names: readonly ToolName[], ctx: ToolCtx, onCall?: (name: string, args: unknown, out: unknown) => void): ToolSet {
  const set: ToolSet = {};
  for (const n of names) {
    set[n] = tool({
      description: ToolDescriptions[n],
      inputSchema: schemaOf(ToolArgs[n]),
      execute: async (args: unknown) => {
        const out = await executeTool(n, args, ctx);
        onCall?.(n, args, out);
        return out;
      },
    });
  }
  return set;
}

export function helperTools(exec: (name: HelperName, args: unknown) => Promise<unknown>): ToolSet {
  const set: ToolSet = {};
  for (const n of Object.keys(HelperArgs) as HelperName[]) {
    set[n] = tool({ description: HelperDescriptions[n], inputSchema: schemaOf(HelperArgs[n]), execute: (args: unknown) => exec(n, args) });
  }
  return set;
}

export const webSearch = () => ({ web_search: openaiProvider.tools.webSearch({}) });
