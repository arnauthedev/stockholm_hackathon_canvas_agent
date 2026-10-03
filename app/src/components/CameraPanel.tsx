import { useEffect, useRef } from "react";
import { useStore } from "../lib/store.ts";

const FRAME_EVERY = 1000; // ms; Gemini Live wants about one frame a second
const FRAME_MAX = 512; // px on the long side (media resolution is low on the server anyway)

/** Live camera during a Gemini call: a small preview, one JPEG frame a second to the voice session. */
export function CameraPanel({ send, onClose }: { send(jpeg: string): void; onClose(): void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    const canvas = document.createElement("canvas");
    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 640 }, height: { ideal: 480 } }, audio: false });
      } catch (err) {
        useStore.getState().toast({ text: `Camera: ${err instanceof Error ? err.message : String(err)}`, kind: "error" });
        onClose();
        return;
      }
      if (stopped || !video.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const v = video.current;
      v.srcObject = stream;
      await v.play().catch(() => {});
      timer = window.setInterval(() => {
        if (!v.videoWidth) return;
        const k = Math.min(1, FRAME_MAX / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * k);
        canvas.height = Math.round(v.videoHeight * k);
        canvas.getContext("2d")!.drawImage(v, 0, 0, canvas.width, canvas.height);
        const url = canvas.toDataURL("image/jpeg", 0.6);
        send(url.slice(url.indexOf(",") + 1));
      }, FRAME_EVERY);
    })();
    return () => {
      stopped = true;
      clearInterval(timer);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [send, onClose]);
  return (
    <div className="camera">
      <video ref={video} playsInline muted autoPlay />
      <button className="camera-close" aria-label="Close camera" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
