/**
 * A listing's HTML (as Jumia keeps descriptions and highlights) in
 * WhatsApp's own formatting, for showing a rewrite before it's sent (owner,
 * 2026-10-12: the preview was plain text, so a rewrite with bold, lists
 * and tables read as if it had none): <strong> as *bold*, <em> as
 * _italic_, list items as "• ", headings bold on their own line, a table's
 * rows as "Cell · Cell". Pure.
 */

const ENTITIES: Record<string, string> = { "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&#39;": "'", "&apos;": "'" };

/** *x* for WhatsApp: no space just inside the marks, or WhatsApp shows them as they are. */
function marked(mark: string, inner: string): string {
  const t = inner.replace(/\s+/g, " ").trim();
  if (!t) return "";
  const lead = /^\s/.test(inner) ? " " : "";
  const trail = /\s$/.test(inner) ? " " : "";
  return `${lead}${mark}${t}${mark}${trail}`;
}

export function htmlToWhatsApp(html: string): string {
  if (!html) return "";
  let s = html.replace(/\r/g, "").replace(/\n/g, " ");
  // A table: each row on its own line, its cells joined; header cells bold.
  s = s.replace(/<tr[^>]*>([\s\S]*?)<\/tr>/gi, (_, row: string) => {
    const cells: string[] = [];
    row.replace(/<(t[hd])[^>]*>([\s\S]*?)<\/t[hd]>/gi, (_m: string, tag: string, inner: string) => {
      const text = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (text) cells.push(tag.toLowerCase() === "th" ? marked("*", text) : text);
      return "";
    });
    return cells.length > 0 ? `\n${cells.join(" · ")}` : "";
  });
  s = s
    .replace(/<\/?(table|thead|tbody|tfoot)[^>]*>/gi, "\n")
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, (_, inner: string) => `\n\n${marked("*", inner.replace(/<[^>]+>/g, ""))}\n`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t: string, inner: string) => marked("*", inner.replace(/<[^>]+>/g, "")))
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _t: string, inner: string) => marked("_", inner.replace(/<[^>]+>/g, "")))
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<\/li>/gi, "")
    .replace(/<\/?(ul|ol)[^>]*>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  for (const [k, v] of Object.entries(ENTITIES)) s = s.split(k).join(v);
  return s
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
