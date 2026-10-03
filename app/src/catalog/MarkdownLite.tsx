import { Fragment, type ReactNode } from "react";

/** **bold**, *italic*, `code`, line breaks and "- " bullets. No HTML. */
function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

export function MarkdownLite({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((l, i) =>
        /^\s*[-•]\s+/.test(l) ? (
          <div key={i} className="md-li">• {inline(l.replace(/^\s*[-•]\s+/, ""))}</div>
        ) : (
          <Fragment key={i}>
            {inline(l)}
            {i < lines.length - 1 && <br />}
          </Fragment>
        ),
      )}
    </>
  );
}
