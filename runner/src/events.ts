import { EventEmitter } from "node:events";
import type { UiEvent } from "@canvas-agent/contract";

/**
 * In-process hub between the executor and whatever brain is active (voice sideband / text brain).
 * - "async"   : a long-running tool finished → inject into the session
 * - "ui"      : a component event from the phone
 */
export interface AsyncResult { ref: string; text: string; result?: unknown; session_id?: string }

class Hub extends EventEmitter {
  asyncResult(r: AsyncResult) {
    this.emit("async", r);
  }
  ui(e: UiEvent) {
    this.emit("ui", e);
  }
}
export const hub = new Hub();
hub.setMaxListeners(50);
