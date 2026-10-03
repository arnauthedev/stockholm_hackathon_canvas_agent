/** Short local sounds; only plays after a user gesture unlocked audio. */
let unlocked = false;
const cache = new Map<string, HTMLAudioElement>();

export function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  for (const n of ["ding", "success", "error", "pop"]) {
    const a = new Audio(`/sounds/${n}.wav`);
    a.preload = "auto";
    a.volume = 0;
    void a.play().then(() => a.pause()).catch(() => {});
    cache.set(n, a);
  }
}

/** Say a scheduled message aloud (TTS from the runner). Before audio is unlocked: show it instead. */
export async function speak(text: string) {
  const { token } = await import("./api.ts");
  const { useStore } = await import("./store.ts");
  if (!unlocked) {
    useStore.getState().toast({ text: `🔊 ${text}`, kind: "info" });
    return;
  }
  try {
    const res = await fetch(`/api/tts?text=${encodeURIComponent(text)}`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(String(res.status));
    const url = URL.createObjectURL(await res.blob());
    const a = new Audio(url);
    a.onended = () => URL.revokeObjectURL(url);
    await a.play();
  } catch {
    useStore.getState().toast({ text: `🔊 ${text}`, kind: "info" });
  }
}

export function play(name: string) {
  if (!unlocked) return;
  const src = cache.get(name) ?? new Audio(`/sounds/${name}.wav`);
  const a = src.cloneNode(true) as HTMLAudioElement;
  a.volume = 0.6;
  void a.play().catch(() => {});
}
