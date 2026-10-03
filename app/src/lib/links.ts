/** Open a deep link (maps / tel / mailto / web). */
export function openLink(href: string) {
  if (/^(tel|mailto|sms):/i.test(href)) {
    location.href = href;
    return;
  }
  const w = window.open(href, "_blank", "noopener");
  if (!w) location.href = href;
}
