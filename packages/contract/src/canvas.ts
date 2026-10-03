import { z } from "zod";

/** `{"$bind": "/json/pointer"}` into the canvas/app data model. */
export const Bind = z.object({ $bind: z.string() }).strict();
export type Bind = z.infer<typeof Bind>;

/** A prop that is either a literal of `s` or a binding into data. */
export const b = <T extends z.ZodTypeAny>(s: T) => z.union([Bind, s]);

export const Trend = z.enum(["up", "down", "flat"]);
export const LinkKind = z.enum(["maps", "web", "tel", "mailto"]);

export const ChartSeries = z.object({ name: z.string(), values: z.array(z.number().nullable()), color: z.string().optional() });
export const ListItem = z.object({
  id: z.string().optional(), title: z.string(), subtitle: z.string().optional(), icon: z.string().optional(), href: z.string().optional(),
});
export const StackCard = z.object({ id: z.string(), title: z.string(), body: z.string().optional(), icon: z.string().optional() });
export const ApprovalField = z.object({
  name: z.string(), label: z.string(), value: z.string(), editable: z.boolean().optional(),
  /** set by the device for values it filled in (numbers, addresses): hidden from the model, not editable by voice */
  private: z.boolean().optional(),
});
export const FormField = z.object({
  name: z.string(), label: z.string(), type: z.enum(["text", "number", "select", "toggle"]),
  value: z.unknown().optional(), options: z.array(z.string()).optional(),
});
export const TaskListItem = z.object({ id: z.string(), title: z.string(), status: z.string(), kind: z.string() });

/** Props for each catalog type (B6). Every prop may be a `$bind`. */
export const ComponentProps = {
  Column: z.object({ gap: b(z.number()).optional(), align: b(z.enum(["start", "center", "end", "stretch"])).optional() }),
  Row: z.object({ gap: b(z.number()).optional(), align: b(z.enum(["start", "center", "end", "stretch"])).optional() }),
  Heading: z.object({ text: b(z.string()), level: b(z.number().int().min(1).max(3)).optional() }),
  Text: z.object({ text: b(z.string()), muted: b(z.boolean()).optional(), size: b(z.enum(["sm", "md", "lg"])).optional() }),
  Metric: z.object({
    label: b(z.string()), value: b(z.union([z.string(), z.number()])), unit: b(z.string()).optional(),
    delta: b(z.union([z.string(), z.number()])).optional(), trend: b(Trend).optional(), note: b(z.string()).optional(),
  }),
  KeyValue: z.object({ items: b(z.array(z.object({ k: z.string(), v: z.union([z.string(), z.number()]) }))) }),
  Chart: z.object({
    kind: b(z.enum(["line", "bar"])), x: b(z.array(z.union([z.string(), z.number()]))), series: b(z.array(ChartSeries)), yUnit: b(z.string()).optional(),
  }),
  List: z.object({ items: b(z.array(ListItem)) }),
  Image: z.object({ src: b(z.string()), alt: b(z.string()).optional(), fit: b(z.enum(["cover", "contain"])).optional() }),
  Link: z.object({ label: b(z.string()), href: b(z.string()), kind: b(LinkKind) }),
  CardStack: z.object({ cards: b(z.array(StackCard)), actions: b(z.array(z.enum(["done", "later", "discard"]))).optional() }),
  ApprovalCard: z.object({
    title: b(z.string()), body: b(z.string()), fields: b(z.array(ApprovalField)).optional(),
    actions: b(z.array(z.enum(["accept", "modify", "reject"]))).optional(),
    accept_label: b(z.string()).optional(),
  }),
  TaskList: z.object({ tasks: b(z.array(TaskListItem)) }),
  Form: z.object({ fields: b(z.array(FormField)), submit: b(z.string()).optional() }),
  Checklist: z.object({ items: b(z.array(z.object({ id: z.string().optional(), text: z.string(), done: z.boolean().optional() }))), addable: b(z.boolean()).optional() }),
  Notebook: z.object({ lines: b(z.array(z.union([z.string(), z.object({ id: z.string().optional(), text: z.string() })]))).optional(), placeholder: b(z.string()).optional() }),
  Divider: z.object({}),
} as const;
export type ComponentType = keyof typeof ComponentProps;
export const COMPONENT_TYPES = Object.keys(ComponentProps) as ComponentType[];

export const Component = z.object({
  type: z.string(),
  props: z.record(z.string(), z.unknown()).optional(),
  children: z.array(z.string()).optional(),
});
export type Component = z.infer<typeof Component>;

export const CanvasSpec = z.object({
  schema_version: z.literal(1).default(1),
  title: z.string().optional(),
  root: z.string(),
  components: z.record(z.string(), Component),
});
export type CanvasSpec = z.infer<typeof CanvasSpec>;

/** Structural + per-type validation. Unknown types are allowed (rendered as "unsupported"). */
export function validateSpec(input: unknown): { ok: true; spec: CanvasSpec } | { ok: false; errors: string[] } {
  const parsed = CanvasSpec.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const spec = parsed.data;
  const errors: string[] = [];
  if (!spec.components[spec.root]) errors.push(`root "${spec.root}" is not in components`);
  for (const [id, c] of Object.entries(spec.components)) {
    for (const child of c.children ?? []) if (!spec.components[child]) errors.push(`${id}.children: unknown id "${child}"`);
    const schema = (ComponentProps as Record<string, z.ZodTypeAny>)[c.type];
    if (!schema) continue;
    const r = schema.safeParse(c.props ?? {});
    if (!r.success) for (const i of r.error.issues) errors.push(`${id} (${c.type}).${i.path.join(".")}: ${i.message}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, spec };
}

/** Resolve a JSON pointer (RFC 6901) against data. */
export function resolvePointer(data: unknown, pointer: string): unknown {
  if (pointer === "" || pointer === "/") return data;
  let cur: unknown = data;
  for (const raw of pointer.replace(/^\//, "").split("/")) {
    const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function isBind(v: unknown): v is Bind {
  return !!v && typeof v === "object" && typeof (v as Bind).$bind === "string" && Object.keys(v).length === 1;
}

/** Replace every `$bind` (deep) in props with its resolved value. */
export function resolveProps(props: Record<string, unknown> | undefined, data: unknown): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (isBind(v)) return resolvePointer(data, v.$bind);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return (walk(props ?? {}) as Record<string, unknown>) ?? {};
}

/** RFC 7386 JSON Merge Patch. */
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out: Record<string, unknown> =
    target && typeof target === "object" && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = mergePatch(out[k], v);
  }
  return out;
}
