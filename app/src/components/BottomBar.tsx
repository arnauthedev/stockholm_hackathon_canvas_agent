import { useRef } from "react";
import { unlockAudio } from "../lib/sound.ts";

export type TalkState = "idle" | "connecting" | "live" | "error";

export function BottomBar(props: {
  /** faded out: the home screens show without the buttons */
  away: boolean;
  talk: TalkState;
  onTalk(): void;
  onText(): void;
  onImage(file: File): void;
  /** Live vision call (Gemini with the camera streaming): its own state, started by the video-camera button. */
  vision: TalkState;
  onVision(): void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const label = { idle: "Talk", connecting: "Connecting…", live: "Listening — tap to stop", error: "Retry" }[props.talk];
  const visionLabel = { idle: "Live vision: talk while showing the camera", connecting: "Connecting live vision…", live: "Stop live vision", error: "Retry live vision" }[props.vision];
  return (
    <footer className={`bottombar ${props.away ? "away" : ""}`} inert={props.away}>
      <button className="side-btn" aria-label="Type a message" onClick={() => (unlockAudio(), props.onText())}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M4 5h16v2H4zm0 6h16v2H4zm0 6h10v2H4z" /></svg>
      </button>
      <button className={`talk-btn ${props.talk}`} aria-pressed={props.talk === "live"} onClick={() => (unlockAudio(), props.onTalk())}>
        <span className="talk-ring" />
        <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
          <path fill="currentColor" d="M12 15a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-2.08A7 7 0 0 0 19 12z" />
        </svg>
        <span className="sr">{label}</span>
      </button>
      <button className={`side-btn vision ${props.vision}`} aria-label={visionLabel} aria-pressed={props.vision === "live"} onClick={() => (unlockAudio(), props.onVision())}>
        <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path fill="currentColor" d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11z" /></svg>
      </button>
      <button className="side-btn" aria-label="Camera or gallery" onClick={() => (unlockAudio(), file.current?.click())}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="currentColor" d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z" /></svg>
      </button>
      <input
        ref={file}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) props.onImage(f);
          e.target.value = "";
        }}
      />
    </footer>
  );
}
