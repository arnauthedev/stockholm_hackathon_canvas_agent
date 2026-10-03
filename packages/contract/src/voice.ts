import type { StateSnapshot } from "./files.ts";
import type { ToolDef } from "./tools.ts";

export interface Transcript { role: "user" | "agent"; text: string; final: boolean }
export interface ToolCall { id: string; name: string; args: unknown }

/** B9. App and runner each implement the half they need; unused methods may be no-ops. */
export interface VoiceSession {
  connect(opts: { tools: ToolDef[]; instructions: string; context: StateSnapshot }): Promise<void>;
  onTranscript(cb: (t: Transcript) => void): void;
  onToolCall(cb: (call: ToolCall) => void): void;
  sendToolResult(id: string, result: unknown): void;
  inject(text: string): void;
  interrupt(): void;
  close(): Promise<void>;
}
