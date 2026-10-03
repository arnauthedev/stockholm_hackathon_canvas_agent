import type { ToolArgsOf } from "@canvas-agent/contract";
import type { ActionDesc } from "./actions.ts";
import type { ToolCtx } from "./executor.ts";

/** Indirection so the task runner (M5) can plug in without a circular import. */
export const tasksApi: {
  create(a: ToolArgsOf<"create_tasks">, ctx: ToolCtx): Promise<unknown>;
  onUpdate(id: string): void;
  attachResult(id: string, r: Record<string, unknown>): Promise<void>;
  /** Run a call/email action owned by a task (creates an approval task when task_id is absent). */
  startAction(desc: ActionDesc, title: string, ctx: ToolCtx): Promise<string>;
  amend(id: string, change: string): Promise<unknown>;
  cancel(id: string, reason?: string): Promise<unknown>;
  waitApproval(id: string, card: Record<string, unknown>, p: Promise<{ action: string; fields?: Record<string, string> }>, approval_id: string): Promise<void>;
} = {
  create: async () => ({ error: "task runner not started" }),
  onUpdate: () => {},
  attachResult: async () => {},
  waitApproval: async () => {},
  startAction: async () => "",
  amend: async () => ({ error: "task runner not started" }),
  cancel: async () => ({ error: "task runner not started" }),
};
