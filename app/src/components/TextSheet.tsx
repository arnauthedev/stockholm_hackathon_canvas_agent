import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api.ts";
import { useStore } from "../lib/store.ts";
import { useEscape } from "./Overlay.tsx";

import { setTextSessionId, textSessionId } from "../lib/session.ts";

export function TextSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => input.current?.focus(), 50);
  }, [open]);
  useEscape(open ? onClose : null);
  if (!open) return null;
  const send = async () => {
    const t = text.trim();
    if (!t || sending) return;
    setSending(true);
    try {
      const r = await api<{ session_id: string }>("/api/chat", { method: "POST", json: { text: t, session_id: textSessionId() } });
      setTextSessionId(r.session_id);
      setText("");
      onClose();
    } catch (e) {
      useStore.getState().toast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    } finally {
      setSending(false);
    }
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet text-sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => (e.preventDefault(), void send())}>
        <div className="sheet-grip" />
        <div className="text-row">
          <input ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask or tell me anything…" enterKeyHint="send" />
          <button className="btn primary" disabled={!text.trim() || sending}>{sending ? "…" : "Send"}</button>
        </div>
      </form>
    </div>
  );
}
