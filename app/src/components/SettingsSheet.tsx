import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { isMacShell } from "../lib/shell.ts";
import { useStore } from "../lib/store.ts";
import { InstallSetting } from "./InstallSetting.tsx";
import { NotifyButton } from "./NotifyButton.tsx";

type TalkVoice = "openai" | "google";
const TALK_OPTIONS: [TalkVoice, string][] = [
  ["openai", "OpenAI"],
  ["google", "Gemini"],
];

/** Settings: the Talk voice (kept on the runner, agent-home/settings.json), notifications, install and reset. */
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
        {!isMacShell && (
          <div className="setting setting-row">
            <div className="setting-label">
              Notifications
              <small>Task results and reminders on this device.</small>
            </div>
            <NotifyButton />
          </div>
        )}
        {!isMacShell && <InstallSetting />}
        <ResetSetting />
      </div>
    </div>
  );
}

function ResetSetting() {
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    if (!confirm("Reset everything? Canvases, pinned widgets, tasks and conversations are cleared (a backup is kept on the computer). Your profile and themes stay.")) return;
    setBusy(true);
    try {
      await api("/api/reset", { method: "POST" });
      useStore.getState().toast({ text: "Fresh start", kind: "success" });
    } catch (e) {
      useStore.getState().toast({ text: String(e instanceof Error ? e.message : e), kind: "error" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="setting setting-row">
      <div className="setting-label">
        Reset
        <small>Clears canvases, widgets, tasks and conversations.</small>
      </div>
      <button className="btn danger" disabled={busy} onClick={() => void reset()}>{busy ? "Resetting…" : "Reset"}</button>
    </div>
  );
}
