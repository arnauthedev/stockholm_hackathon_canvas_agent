import { Component as ReactComponent, type ReactNode } from "react";
import { resolveProps, type CanvasSpec } from "@canvas-agent/contract";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { CardStack } from "./CardStack.tsx";
import { Chart } from "./Chart.tsx";
import { Checklist, Notebook } from "./Lists.tsx";
import { Ctx, type RenderCtx } from "./context.ts";
import { CustomCard } from "./CustomCard.tsx";
import * as B from "./basic.tsx";

class Boundary extends ReactComponent<{ type: string; children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? e.message : String(e) };
  }
  render() {
    return this.state.err ? <div className="c-unsupported">{this.props.type} failed: {this.state.err}</div> : this.props.children;
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyProps = Record<string, any>;

function Node({ id, spec, data, seen }: { id: string; spec: CanvasSpec; data: unknown; seen: Set<string> }) {
  const c = spec.components[id];
  if (!c) return <div className="c-unsupported">missing: {id}</div>;
  if (seen.has(id)) return <div className="c-unsupported">cycle: {id}</div>;
  const next = new Set(seen).add(id);
  const p: AnyProps = resolveProps(c.props, data);
  const kids = (c.children ?? []).map((cid) => <Node key={cid} id={cid} spec={spec} data={data} seen={next} />);
  let el: ReactNode;
  switch (c.type) {
    case "Column":
    case "Row":
      el = (
        <div className={c.type === "Row" ? "c-row" : "c-col"} style={{ gap: p.gap, alignItems: p.align === "stretch" ? "stretch" : p.align }}>
          {kids}
        </div>
      );
      break;
    case "Heading": el = <B.Heading {...p} />; break;
    case "Text": el = <B.Text {...p} />; break;
    case "Metric": el = <B.Metric {...p} />; break;
    case "KeyValue": el = <B.KeyValue {...p} />; break;
    case "Chart": el = <Chart {...p} />; break;
    case "List": el = <B.List id={id} {...p} />; break;
    case "Image": el = <B.Image {...p} />; break;
    case "Link": el = <B.Link id={id} {...p} />; break;
    case "CardStack": el = <CardStack id={id} {...p} />; break;
    case "ApprovalCard": el = <ApprovalCard id={id} {...p} />; break;
    case "TaskList": el = <B.TaskList id={id} {...p} />; break;
    case "Form": el = <B.Form id={id} {...p} />; break;
    case "Checklist": el = <Checklist id={id} {...p} />; break;
    case "Notebook": el = <Notebook id={id} {...p} />; break;
    case "Divider": el = <B.Divider />; break;
    case "Custom": el = <CustomCard html={p.html} data={data} />; break;
    default: el = <B.Unsupported type={c.type} />;
  }
  return <Boundary type={c.type}>{el}</Boundary>;
}

export function Renderer({ spec, data, ctx }: { spec: CanvasSpec; data: unknown; ctx: RenderCtx }) {
  return (
    <Ctx.Provider value={{ ...ctx, data }}>
      <div className={`render ${ctx.compact ? "compact" : ""} ${ctx.size ? `size-${ctx.size}` : ""}`}>
        <Node id={spec.root} spec={spec} data={data} seen={new Set()} />
      </div>
    </Ctx.Provider>
  );
}
