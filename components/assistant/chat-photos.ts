/**
 * Which of the photos sent in the web chat go in the product form. On the
 * web, products are listed through the form; photos sent in the chat first
 * are answered with it ("📸 Got your photos … Open the form") and go on its
 * first card. They stay the form's however it's opened later: that message's
 * button again after the form was closed, a count, or New products (owner's
 * web chat, 2026-10-11: a sandal photo, the form closed, and every later
 * form came up empty).
 */

export type ChatPhoto = { mediaId: string; preview: string };

/** The parts of a chat message these read. */
export interface ChatMessage {
  direction: "inbound" | "outbound";
  type:      string;
  text:      string | null;
  payload:   Record<string, unknown> | null;
  at:        string;
  local?:    boolean;
}

/** How long photos sent in the chat wait for the form. */
const CHAT_PHOTOS_MS = 6 * 3600_000;
/** Jumia takes at most 8 photos a product. */
const MAX_PHOTOS = 8;

/** The product count of the bot's "Open the form" button on a message, or null when it has none. */
export function formButton(m: ChatMessage): number | null {
  const buttons = m.type === "button" && Array.isArray(m.payload?.buttons) ? (m.payload!.buttons as { id?: string }[]) : [];
  for (const b of buttons) {
    const hit = /^form(?:\s+(\d{1,2}))?$/i.exec(b?.id ?? "");
    if (hit) return hit[1] ? Number(hit[1]) : 1;
  }
  return null;
}

/**
 * The photos sent in the chat before message `upto` that the bot answered
 * with the form and that no form batch has taken since: oldest first, at
 * most 8, from the 6 hours before it. Photos the bot took for something
 * else (a live product's new photos, a polish) aren't these: its answer to
 * them wasn't the form.
 */
export function chatPhotos(list: ChatMessage[], upto: number): ChatPhoto[] {
  const end = Math.min(Math.max(upto, 0), list.length);
  const since = (end < list.length ? Date.parse(list[end].at) : Date.now()) - CHAT_PHOTOS_MS;
  const out: ChatPhoto[] = [];
  for (let i = end - 1; i >= 0 && out.length < MAX_PHOTOS; i--) {
    const m = list[i];
    if (Date.parse(m.at) < since) break;
    if (m.direction !== "inbound" || m.type !== "image" || m.local) continue;
    // A batch from the form (lib/whatsapp/intake.ts startBatchFromForm): the photos before it went in it.
    if ((m.text ?? "").startsWith("🧾")) break;
    const answer = list.slice(i + 1).find((x) => x.direction === "outbound");
    if (!answer || formButton(answer) == null) continue;
    const ids = Array.isArray(m.payload?.imageMediaIds) ? (m.payload!.imageMediaIds as unknown[])
      : typeof m.payload?.imageMediaId === "string" ? [m.payload.imageMediaId] : [];
    const links = Array.isArray(m.payload?.links) ? (m.payload!.links as unknown[]) : [m.payload?.link];
    const photos = ids.map((id, j) => ({ mediaId: id, preview: links[j] }))
      .filter((p): p is ChatPhoto => typeof p.mediaId === "string" && typeof p.preview === "string");
    out.unshift(...photos);
  }
  return out.slice(-MAX_PHOTOS);
}

/** A photo on one of the form's cards: the page's own copy until it's uploaded. */
export interface FormPhoto { key: string; preview: string; mediaId?: string; uploading: boolean; error?: string }
/** One product's card. Kept by the chat when the form is closed without drafting, so it opens again as it was. */
export interface FormDraft { key: string; photos: FormPhoto[]; price: string; quantity: string; sizes: string; colour: string; notes: string; polish: boolean }

export const newKey = () => crypto.randomUUID();
export const blankCard = (): FormDraft => ({ key: newKey(), photos: [], price: "", quantity: "", sizes: "", colour: "", notes: "", polish: false });
const fromChat = (p: ChatPhoto): FormPhoto => ({ key: newKey(), preview: p.preview, mediaId: p.mediaId, uploading: false });

/**
 * The cards the form opens with. Work kept from when it was closed comes
 * back as it was (owner, 2026-10-11: "when the listing form was closed,
 * opening that particular one did not reload the image in it"), without
 * photos that hadn't finished uploading; photos sent in the chat that
 * aren't on a card yet go on the first card without photos, or a new one.
 */
export function openingCards(kept: FormDraft[] | null | undefined, count: number, chat: ChatPhoto[], maxProducts: number): FormDraft[] {
  const cards: FormDraft[] = (kept ?? []).map((d) => ({ ...d, photos: d.photos.filter((p) => p.mediaId && !p.uploading && !p.error) }));
  const onCards = new Set(cards.flatMap((d) => d.photos.map((p) => p.mediaId)));
  const fresh = chat.filter((p) => !onCards.has(p.mediaId)).slice(0, MAX_PHOTOS);
  if (fresh.length > 0) {
    const empty = cards.find((d) => d.photos.length === 0);
    if (empty) empty.photos = fresh.map(fromChat);
    else if (cards.length < maxProducts) cards.push({ ...blankCard(), photos: fresh.map(fromChat) });
  }
  while (cards.length < Math.min(Math.max(1, count), maxProducts)) cards.push(blankCard());
  return cards;
}
