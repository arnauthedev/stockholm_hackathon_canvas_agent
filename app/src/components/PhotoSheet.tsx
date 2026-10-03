import { useEffect, useState } from "react";
import { token } from "../lib/api.ts";
import { setTextSessionId, textSessionId } from "../lib/session.ts";
import { useStore } from "../lib/store.ts";

/** Downscale on the phone (max 1600 px JPEG) — faster upload, cheaper vision tokens. */
async function downscale(file: File, max = 1600): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("encode failed"))), "image/jpeg", 0.85));
  } catch {
    return file; // undecodable here (e.g. HEIC on some browsers): send the original
  }
}

export function PhotoSheet({ file, onClose }: { file: File | null; onClose(): void }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    if (!file) return;
    const u = URL.createObjectURL(file);
    setPreview(u);
    setText("");
    return () => URL.revokeObjectURL(u);
  }, [file]);
  if (!file) return null;

  const send = async () => {
    setSending(true);
    try {
      const blob = await downscale(file);
      const form = new FormData();
      form.append("file", new File([blob], blob === file ? file.name : "photo.jpg", { type: blob.type || file.type }));
      if (text.trim()) form.append("text", text.trim());
      const sid = textSessionId();
      if (sid) form.append("session_id", sid);
      const res = await fetch("/api/upload", { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
      const j = (await res.json()) as { error?: string; session_id?: string };
      if (!res.ok || j.error) throw new Error(j.error ?? res.statusText);
      if (j.session_id) setTextSessionId(j.session_id);
      useStore.getState().set({ page: 1 });
      onClose();
    } catch (e) {
      useStore.getState().toast({ text: `Photo: ${e instanceof Error ? e.message : String(e)}`, kind: "error" });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet photo-sheet" onClick={(e) => e.stopPropagation()} onSubmit={(e) => (e.preventDefault(), void send())}>
        <div className="sheet-grip" />
        {preview && <img className="photo-preview" src={preview} alt="Selected photo" />}
        <div className="text-row">
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Ask about this photo (optional)" enterKeyHint="send" />
          <button className="btn primary" disabled={sending}>{sending ? "…" : "Send"}</button>
        </div>
      </form>
    </div>
  );
}
