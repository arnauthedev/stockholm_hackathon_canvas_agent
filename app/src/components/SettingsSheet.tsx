import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useStore } from "../lib/store.ts";

type TalkVoice = "openai" | "google";
const TALK_OPTIONS: [TalkVoice, string][] = [
  ["openai", "OpenAI"],
  ["google", "Gemini"],
];

/** Settings kept on the runner (agent-home/settings.json): for now, the Talk call's voice provider. */
export function SettingsSheet({ onClose }: { onClose(): void }) {
  const [talk, setTalk] = useState<TalkVoice | null>(null);
  const [saving, setSaving] = useState(false);
  const fail = (err: unknown) => useStore.getState().toast({ text: `Settings: ${err instanceof Error ? err.message : String(err)}`, kind: "error" });

  useEffect(() => {
    api<{ talkVoice: TalkVoice }>("/api/settings").then((s) => setTalk(s.talkVoice), fail);
  }, []);

  const choose = async (v: TalkVoice) => {
    if (v === talk || saving) return;
    const prev = talk;
    setTalk(v);
    setSaving(true);
    try {
      setTalk((await api<{ talkVoice: TalkVoice }>("/api/settings", { method: "PUT", json: { talkVoice: v } })).talkVoice);
    } catch (err) {
      setTalk(prev);
      fail(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet settings-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <h2>Settings</h2>
        <div className="setting">
          <div className="setting-label">
            Talk voice
            <small>Applies from the next call. Live vision always uses Gemini.</small>
          </div>
          <div className="segmented" role="radiogroup" aria-label="Talk voice">
            {TALK_OPTIONS.map(([v, label]) => (
              <button key={v} role="radio" aria-checked={talk === v} className={talk === v ? "on" : ""} disabled={!talk} onClick={() => void choose(v)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
