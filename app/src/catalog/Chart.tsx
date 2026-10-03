import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useStore } from "../lib/store.ts";
import { useRenderCtx } from "./context.ts";

interface Series { name: string; values: (number | null)[]; color?: string }

/** Theme chart colors resolved from CSS variables (SVG attributes can't use var()). */
function useChartColors() {
  const theme = useStore((s) => s.theme);
  const [colors, setColors] = useState<string[]>([]);
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      setColors([0, 1, 2, 3, 4].map((i) => cs.getPropertyValue(`--chart-${i}`).trim() || "#888"));
    };
    read();
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", read);
    const t = setTimeout(read, 50); // after theme vars apply
    return () => (mq.removeEventListener("change", read), clearTimeout(t));
  }, [theme]);
  return colors;
}

export function Chart(p: { kind?: string; x?: (string | number)[]; series?: Series[]; yUnit?: string }) {
  const { compact } = useRenderCtx();
  const colors = useChartColors();
  const x = Array.isArray(p.x) ? p.x : [];
  const series = Array.isArray(p.series) ? p.series : [];
  const rows = x.map((label, i) => Object.fromEntries([["x", label], ...series.map((s) => [s.name, s.values?.[i] ?? null])]));
  const unit = p.yUnit ?? "";
  const height = compact ? 120 : 260;
  const common = {
    data: rows,
    margin: { top: 8, right: compact ? 6 : 18, bottom: 0, left: compact ? 6 : -12 },
  };
  const isBar = p.kind === "bar";
  const axes = (
    <>
      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey="x" tick={{ fill: "currentColor", fontSize: compact ? 10 : 12 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
      <YAxis hide={compact} domain={isBar ? [0, "auto"] : ["auto", "auto"]} allowDecimals={false} tick={{ fill: "currentColor", fontSize: compact ? 10 : 12 }} tickLine={false} axisLine={false} unit={compact ? "" : unit} width={compact ? 40 : 52} />
      <Tooltip
        cursor={{ stroke: "currentColor", strokeOpacity: 0.25 }}
        formatter={(v) => (v == null ? "—" : `${v}${unit}`)}
        contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, color: "var(--text)" }}
        labelStyle={{ color: "var(--muted)" }}
      />
      {!compact && series.length > 1 && <Legend wrapperStyle={{ fontSize: 13 }} />}
    </>
  );
  const color = (s: Series, i: number) => s.color ?? colors[i % (colors.length || 1)] ?? "#888";
  return (
    // pan-y: horizontal drags scrub the tooltip instead of swiping the pager
    <div className="c-chart" style={{ height, touchAction: "pan-y" }}>
      <ResponsiveContainer width="100%" height="100%">
        {p.kind === "bar" ? (
          <BarChart {...common}>
            {axes}
            {series.map((s, i) => <Bar key={s.name} dataKey={s.name} fill={color(s, i)} radius={[4, 4, 0, 0]} isAnimationActive={!compact} />)}
          </BarChart>
        ) : (
          <LineChart {...common}>
            {axes}
            {series.map((s, i) => (
              <Line key={s.name} type="monotone" dataKey={s.name} stroke={color(s, i)} strokeWidth={2.5} dot={!compact && { r: 3 }} activeDot={{ r: 6 }} isAnimationActive={!compact} connectNulls />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
