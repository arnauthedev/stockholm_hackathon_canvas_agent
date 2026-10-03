import { create } from "zustand";
import { api } from "./api.ts";
import { play } from "./sound.ts";
import type { ActivityEntry, AppEntry, TriggerJson, CanvasEntry, ScreensJson, ServerEvent, StateSnapshot, TaskEntry, Theme } from "@canvas-agent/contract";

export interface Toast { id: number; text: string; kind: "info" | "success" | "warn" | "error" }
export interface TranscriptLine { id: number; role: "user" | "agent"; text: string; final: boolean; at: number }
export interface Modal { approval_id: string; card: Record<string, unknown>; committingUntil?: number }

interface State {
  connected: boolean;
  hydrated: boolean;
  canvas: CanvasEntry | null;
  canvasIds: string[];
  apps: Record<string, AppEntry>;
  screens: ScreensJson | null;
  tasks: Record<string, TaskEntry>;
  theme: Theme | null;
  toasts: Toast[];
  transcript: TranscriptLine[];
  modals: Modal[];
  voiceLive: boolean;
  editMode: boolean;
  optimistic: Record<string, { ui: Record<string, unknown>; ids: string[] }>;
  setOptimistic(key: string, v: { ui: Record<string, unknown>; ids: string[] }): void;
  clearOptimistic(key: string): void;
  trayOpen: boolean;
  trayDismissed: boolean;
  lastTalkAt: number;
  link: { href: string; kind: string } | null;
  busy: string | null;
  activity: ActivityEntry[];
  triggers: TriggerJson[];
  page: number; // pager index
  hydrate(s: StateSnapshot): void;
  apply(e: ServerEvent): void;
  set(p: Partial<State>): void;
  toast(t: Omit<Toast, "id">): void;
  addTranscript(role: "user" | "agent", text: string, final: boolean): void;
}

let seq = 0;

export const useStore = create<State>((set, get) => ({
  connected: false,
  hydrated: false,
  canvas: null,
  canvasIds: [],
  apps: {},
  screens: null,
  tasks: {},
  theme: null,
  toasts: [],
  transcript: [],
  modals: [],
  voiceLive: false,
  editMode: false,
  optimistic: {},
  setOptimistic: (key, v) => set({ optimistic: { ...get().optimistic, [key]: v } }),
  clearOptimistic: (key) => {
    const { [key]: _gone, ...rest } = get().optimistic;
    set({ optimistic: rest });
  },
  trayOpen: false,
  trayDismissed: false,
  lastTalkAt: 0,
  link: null,
  busy: null,
  activity: [],
  triggers: [],
  page: 1,
  set: (p) => set(p),
  hydrate: (s) =>
    set({
      hydrated: true,
      canvas: s.canvas,
      canvasIds: s.canvas_ids,
      apps: s.apps,
      screens: s.screens,
      tasks: Object.fromEntries(s.tasks.map((t) => [t.task.id, t])),
      theme: s.theme,
      modals: s.approvals ?? [],
      triggers: s.triggers ?? [],
    }),
  toast: (t) => {
    const id = ++seq;
    set({ toasts: [...get().toasts, { ...t, id }] });
    setTimeout(() => set({ toasts: get().toasts.filter((x) => x.id !== id) }), 3500);
  },
  addTranscript: (role, text, final) => {
    const lines = get().transcript;
    const last = lines[lines.length - 1];
    // streaming: replace the last non-final line of the same role
    if (last && last.role === role && !last.final) {
      set({ transcript: [...lines.slice(0, -1), { ...last, text, final, at: Date.now() }] });
    } else {
      set({ transcript: [...lines, { id: ++seq, role, text, final, at: Date.now() }].slice(-30) });
    }
  },
  apply: (e) => {
    const s = get();
    switch (e.type) {
      case "canvas": {
        const ids = s.canvasIds.includes(e.canvas.id) ? s.canvasIds : [...s.canvasIds, e.canvas.id].sort();
        const latest = ids[ids.length - 1];
        // results produced by background tasks show up without yanking the user to the canvas page
        const jump = e.canvas.id !== s.canvas?.id && !e.canvas.meta.task_id;
        if (!s.canvas || e.canvas.id === latest) set({ canvas: e.canvas, canvasIds: ids, page: jump ? 1 : s.page });
        else set({ canvasIds: ids });
        break;
      }
      case "canvas.removed":
        set({ canvasIds: s.canvasIds.filter((i) => i !== e.id) });
        break;
      case "app":
        set({ apps: { ...s.apps, [e.app.id]: e.app } });
        break;
      case "app.removed": {
        const { [e.id]: _gone, ...rest } = s.apps;
        set({ apps: rest });
        break;
      }
      case "screens":
        set({ screens: e.screens });
        break;
      case "task":
        set({ tasks: { ...s.tasks, [e.task.task.id]: e.task } });
        break;
      case "task.removed": {
        const { [e.id]: _gone, ...rest } = s.tasks;
        set({ tasks: rest });
        break;
      }
      case "theme":
        set({ theme: e.theme });
        break;
      case "toast":
        s.toast({ text: e.text, kind: e.kind });
        if (e.sound) play(e.sound);
        break;
      case "sound":
        play(e.name);
        break;
      case "modal":
        if (!s.modals.some((m) => m.approval_id === e.approval_id)) set({ modals: [...s.modals, { approval_id: e.approval_id, card: e.card }], trayDismissed: false });
        play("ding");
        break;
      case "modal.close": {
        const left = s.modals.filter((m) => m.approval_id !== e.approval_id);
        set({ modals: left, trayOpen: left.length ? s.trayOpen : false });
        break;
      }
      case "modal.update":
      case "modal.commit":
      case "modal.commit_cancel":
      case "modal.focus": {
        // bring the card to the front and show it (voice edits/approvals are always visible)
        const m = s.modals.find((x) => x.approval_id === e.approval_id);
        if (!m) break;
        const next: Modal = {
          ...m,
          ...(e.type === "modal.update" ? { card: e.card } : {}),
          ...(e.type === "modal.commit" ? { committingUntil: Date.parse(e.until) } : {}),
          ...(e.type === "modal.commit_cancel" ? { committingUntil: undefined } : {}),
        };
        set({ modals: [next, ...s.modals.filter((x) => x.approval_id !== e.approval_id)], trayOpen: true });
        break;
      }
      case "open_link":
        // iOS blocks window.open without a gesture: show a one-tap prompt instead
        set({ link: { href: e.href, kind: e.kind } });
        break;
      case "transcript":
        set({ lastTalkAt: Date.now() });
        s.addTranscript(e.role, e.text, e.final);
        break;
      case "busy":
        set({ busy: e.on ? (e.label ?? "Working…") : null });
        break;
      case "hello":
        break;
      case "triggers":
        set({ triggers: e.triggers });
        break;
      case "speak":
        void import("./sound.ts").then((m) => m.speak(e.text));
        break;
      case "activity":
        set({ activity: [...s.activity, e.entry].slice(-300) });
        break;
      case "reset":
        set({ transcript: [], modals: [], link: null, busy: null, page: 1, canvas: null, canvasIds: [], apps: {}, tasks: {} });
        void api<StateSnapshot>("/api/state").then((st) => get().hydrate(st));
        break;
    }
  },
}));
