import type { Theme } from "@canvas-agent/contract";

const kebab = (s: string) => s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);

/** Theme colours → CSS custom-property declarations (`--bg: …; --accent-text: …; --chart-0: …`). */
export function cssVars(colors: Record<string, unknown>): string {
  return Object.entries(colors)
    .map(([k, v]) =>
      Array.isArray(v) ? v.map((c, i) => `--chart-${i}: ${c};`).join(" ") : `--${kebab(k)}: ${String(v)};`,
    )
    .join(" ");
}

/** Design tokens → CSS variables on :root, with a dark-mode override block. */
export function applyTheme(t: Theme) {
  let el = document.getElementById("theme-vars") as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = "theme-vars";
    document.head.appendChild(el);
  }
  const base = `--radius: ${t.radius}px; --space: ${t.spacing}px; --font: ${t.font}; ${cssVars(t.colors)}`;
  const dark = t.dark ? `@media (prefers-color-scheme: dark) { :root { ${cssVars(t.dark)} } }` : "";
  el.textContent = `:root { ${base} } ${dark}`;
  const meta = document.querySelector('meta[name="theme-color"]');
  const isDark = matchMedia("(prefers-color-scheme: dark)").matches;
  meta?.setAttribute("content", (isDark && t.dark?.bg) || t.colors.bg);
}
