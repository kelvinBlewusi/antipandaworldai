/**
 * The bot's own messages in the seller's language (owner, 2026-10-11: "a
 * language switch ... that help all jumia countries sellers"; 2026-10-12: "go
 * ahead"). The bot's fixed messages are written in English all over
 * lib/whatsapp; rather than rewrite each one, every message is translated as
 * it's sent (lib/whatsapp/client.ts callGraphApi, the one place every send
 * goes through), for a seller whose language (lib/preferences/language.ts
 * `ui`) is French or Arabic. English sellers: nothing changes, no AI call.
 *
 *   - What's translated: the text, a caption, an interactive message's body,
 *     button titles, list rows and button, a link button's words, and the
 *     words of the web chat's tables and tiles. Ids never change: a tap still
 *     sends the English command.
 *   - Kept as they are: product names, prices, numbers, links, codes, and a
 *     word the seller is told to type ("Reply *done*"). A line whose numbers
 *     or links come back changed, or that's over WhatsApp's length for its
 *     place (20 for a button), is sent in English.
 *   - Each line is translated once (bot_translations), so a fixed message
 *     costs nothing after its first time. gemini-2.5-flash-lite, ~$0.0002 a
 *     new line, counted as "translation" in the cost log; 8 s at most, then
 *     English.
 *   - Not translated: what the AI wrote (already in the seller's language:
 *     `aiWritten`, and any line already in their language), templates (their
 *     own approved languages) and read receipts.
 *
 * The log keeps the English (the bot's code reads its own messages back:
 * lastBotMessage, sentRecently, the weekly warning signs); what the seller
 * saw is in payload.shown, which the web chat shows (assistantMessages).
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";
import { callGeminiBackend } from "@/lib/ai/gemini-client";
import { withAiUsageContext } from "@/lib/ai/usage";
import { isWebAddress, WEB_PREFIX } from "@/lib/whatsapp/channel";
import { sellerLanguages } from "@/lib/preferences/language";
import type { UiLanguage } from "@/lib/i18n/languages";

type Rec = Record<string, unknown>;
type Foreign = Exclude<UiLanguage, "en">;

// ─── Whose language ────────────────────────────────────────────────────────

/** Numbers from Côte d'Ivoire, Senegal and Morocco: French, before the seller has a Jumia market or a choice. */
const FRENCH_PREFIXES = ["225", "221", "212"];
export const languageOfNumber = (phone: string): UiLanguage =>
  FRENCH_PREFIXES.some((p) => phone.replace(/^\+/, "").startsWith(p)) ? "fr" : "en";

const LANGUAGE_TTL_MS = 60_000;
const known = new Map<string, { lang: UiLanguage; userId: string | null; at: number }>();

/** A choice just made counts at once (on this server; others within a minute). */
export function forgetLanguage(userId: string): void {
  known.forEach((v, to) => { if (v.userId === userId) known.delete(to); });
}

async function userOfNumber(phone: string): Promise<string | null> {
  const { data } = await createServerClient().from("whatsapp_connections").select("user_id").eq("phone_number", phone).limit(1);
  return ((data ?? [])[0] as { user_id?: string } | undefined)?.user_id ?? null;
}

/**
 * The language the bot talks to `to` in (a WhatsApp number or the web chat's
 * address): the seller's choice, else their Jumia market's, else their
 * number's country. English when anything fails.
 */
export async function recipientLanguage(to: string): Promise<UiLanguage> {
  const hit = known.get(to);
  if (hit && Date.now() - hit.at < LANGUAGE_TTL_MS) return hit.lang;
  let lang: UiLanguage = "en";
  let userId: string | null = null;
  try {
    userId = isWebAddress(to) ? to.slice(WEB_PREFIX.length) : await userOfNumber(to);
    if (userId) {
      const langs = await sellerLanguages(userId);
      lang = !langs.chosen.ui && !langs.country && !isWebAddress(to) ? languageOfNumber(to) : langs.ui;
    } else if (!isWebAddress(to)) {
      lang = languageOfNumber(to);
    }
  } catch {
    lang = "en";
  }
  known.set(to, { lang, userId, at: Date.now() });
  return lang;
}

// ─── What's already in their language ──────────────────────────────────────

/** "body": the AI wrote the message itself, only its buttons need translating. "all": nothing does. */
type AsWritten = "body" | "all";
const asWritten = new AsyncLocalStorage<AsWritten>();

/** Messages sent inside `fn` were written by the AI in the seller's language: only their buttons and rows are translated. */
export const aiWritten = <T>(fn: () => Promise<T>): Promise<T> => asWritten.run("body", fn);
/** Messages sent inside `fn` are already in the seller's language, buttons and all (the language menu). */
export const untranslated = <T>(fn: () => Promise<T>): Promise<T> => asWritten.run("all", fn);

const FR_WORDS = new Set("le la les des du une est sont vous votre vos pour avec dans sur pas et aux cette ces qui nous ne plus été êtes ici déjà mais où".split(" "));
const EN_WORDS = new Set("the and you your to is are for with this that it of be will can here have has was what how".split(" "));

/** Whether a line already reads in `lang` (the AI's words, a product name in Arabic). Pure. */
export function alreadyIn(lang: Foreign, text: string): boolean {
  if (lang === "ar") {
    const ar = (text.match(/[؀-ۿ]/g) ?? []).length;
    const latin = (text.match(/[A-Za-z]/g) ?? []).length;
    return ar > 0 && ar >= latin;
  }
  let fr = 0;
  let en = 0;
  for (const w of text.toLowerCase().match(/[a-zàâçéèêëîïôûùüÿœ]+/g) ?? []) {
    if (FR_WORDS.has(w)) fr++;
    if (EN_WORDS.has(w)) en++;
  }
  return fr >= 2 && fr > en * 2;
}

/** Whether a line has words to translate at all ("1", "✅", "GH₵ 150" don't). Pure. */
const hasWords = (text: string) => (text.match(/[A-Za-z]{2,}/g) ?? []).length > 0;

// ─── The places in a message ───────────────────────────────────────────────

/** One string in a message: its words, its length limit, and whether it's the body or a label. */
export interface Slot { text: string; max: number; kind: "body" | "label"; set: (v: string) => void }

/** Every translatable string in a Graph API message body (or a web chat message's), on the object given. Pure. */
export function slotsOf(body: Rec): Slot[] {
  const slots: Slot[] = [];
  const add = (obj: unknown, key: string, max: number, kind: Slot["kind"]) => {
    const o = obj as Rec | null | undefined;
    const v = o?.[key];
    if (o && typeof v === "string" && v.trim()) slots.push({ text: v, max, kind, set: (t) => { o[key] = t; } });
  };
  const list = (v: unknown) => (Array.isArray(v) ? (v as Rec[]) : []);
  if (body.type === "text") add(body.text, "body", 4096, "body");
  if (body.type === "image") add(body.image, "caption", 1024, "body");
  if (body.type === "interactive") {
    const i = body.interactive as Rec | undefined;
    add(i?.body, "text", 1024, "body");
    add(i?.header, "text", 60, "label");
    add(i?.footer, "text", 60, "label");
    const a = i?.action as Rec | undefined;
    for (const b of list(a?.buttons)) add(b.reply, "title", 20, "label");
    add(a, "button", 20, "label");
    for (const s of list(a?.sections)) {
      add(s, "title", 24, "label");
      for (const r of list(s.rows)) { add(r, "title", 24, "label"); add(r, "description", 72, "label"); }
    }
    add(a?.parameters, "display_text", 20, "label");
  }
  // The web chat's tables and tiles (lib/whatsapp/rich-blocks.ts): their words, not product names or numbers.
  for (const b of list((body.rich as Rec | undefined)?.blocks)) {
    if (b.kind === "heading") { add(b, "text", 200, "body"); add(b, "sub", 300, "body"); }
    if (b.kind === "text" || b.kind === "note") add(b, "text", 4096, "body");
    if (b.kind === "stats") for (const it of list(b.items)) { add(it, "label", 60, "label"); add(it, "note", 120, "label"); }
    if (b.kind === "table") {
      const cols = Array.isArray(b.columns) ? (b.columns as unknown[]) : [];
      cols.forEach((c, n) => { if (typeof c === "string" && c.trim()) slots.push({ text: c, max: 40, kind: "label", set: (t) => { cols[n] = t; } }); });
      add(b, "title", 120, "label");
      add(b, "more", 200, "label");
      // A status cell ({ text, tone }) is a fixed word; a plain one is a name, a SKU or a number.
      for (const row of Array.isArray(b.rows) ? (b.rows as unknown[][]) : []) for (const cell of Array.isArray(row) ? row : []) {
        if (cell && typeof cell === "object") add(cell, "text", 40, "label");
      }
    }
  }
  return slots;
}

// ─── Translating ───────────────────────────────────────────────────────────

const TRANSLATE_MODEL = "gemini-2.5-flash-lite";
const TRANSLATE_TIMEOUT_MS = 8_000;
const BATCH = 40;

const LANGUAGE_FOR: Record<Foreign, string> = {
  fr: "French, as a seller in Côte d'Ivoire, Senegal or Morocco would read it",
  ar: "Modern Standard Arabic",
};

export function translationPrompt(lang: Foreign, items: { text: string; max: number; kind?: Slot["kind"] }[]): string {
  return [
    `You translate the messages of a WhatsApp assistant for online sellers on Jumia from English into ${LANGUAGE_FOR[lang]}.`,
    "Translate each item of the JSON array below. Rules:",
    "- Every item is translated, including short ones: an item with \"kind\": \"label\" is a button, a list row or a column name (\"Submit all\", \"Sales today\"), never a command to keep.",
    "- Keep WhatsApp formatting exactly: *bold*, _italic_, ~strike~, line breaks, bullets (•, -), numbering (\"1.\") and every emoji, in the same places. Text in *bold* is translated like the rest.",
    "- Keep exactly as written, never translated: a product's name (the words after \"Product drafted:\", \"Product 2:\" and the like), brand names, SKUs, order and product numbers, prices, amounts, currency codes and symbols, dates, every number, links, email addresses, codes, and anything in quotes.",
    "- Keep these words as they are: Jumia, PandaWorld, Vendor Center, Seller Center, WhatsApp, ON, OFF, Client ID, token.",
    "- Only when a message explicitly tells the seller to type, reply, say or send a word (Reply *done*, type *restart*, say *menu*), keep that one word or phrase in English.",
    ...(lang === "ar" ? ["- Write numbers with the digits 0-9, never Arabic-Indic digits."] : ["- French punctuation: a space before : ; ! ?"]),
    "- Each item has \"max\": the translation must be at most that many characters; use shorter words if needed.",
    "- Natural, friendly and as short as the original; add nothing, leave nothing out.",
    "Return JSON only: an array of strings (just the translated text, not objects), one per item, in the same order.",
    "",
    JSON.stringify(items.map((i) => ({ text: i.text, max: i.max, kind: i.kind ?? "message" }))),
  ].join("\n");
}

/**
 * Whether a translation kept what mustn't change: every number and link, the
 * *bold* marks paired, and its place's length. Pure.
 */
export function keepsEssentials(source: string, out: string, max: number, lang?: Foreign): boolean {
  if (!out.trim() || out.length > max) return false;
  // Not translated at all: tried again next time rather than kept as the translation.
  if (out.trim() === source.trim() && hasWords(source)) return false;
  if (lang === "ar" && hasWords(source) && !/[\u0600-\u06FF]/.test(out)) return false;
  const urls = source.match(/https?:\/\/[^\s)]+/g) ?? [];
  if (urls.some((u) => !out.includes(u.replace(/[.,!?]+$/, "")))) return false;
  const numbers = source.match(/\d+(?:[.,]\d+)*/g) ?? [];
  if (numbers.some((n) => !out.includes(n))) return false;
  const stars = (s: string) => (s.match(/\*/g) ?? []).length;
  if (stars(source) % 2 === 0 && stars(out) % 2 !== 0) return false;
  return true;
}

/** Bumped when what makes a good translation changes, so older cached ones aren't read again (v2: 2026-10-12, labels). */
const CACHE_VERSION = "v2";
const hashOf = (text: string, max: number) => createHash("sha256").update(`${CACHE_VERSION}\n${max}\n${text}`).digest("hex").slice(0, 40);

async function askModel(lang: Foreign, items: { text: string; max: number; kind?: Slot["kind"] }[], userId: string | null, onAnswer?: (raw: string) => void): Promise<(string | null)[]> {
  const call = withAiUsageContext({ feature: "translation", userId }, () =>
    callGeminiBackend(TRANSLATE_MODEL, [{ text: translationPrompt(lang, items) }], { json: true }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), TRANSLATE_TIMEOUT_MS); });
  const res = await Promise.race([call, timeout]).finally(() => clearTimeout(timer));
  if (!res) throw new Error(`no answer in ${TRANSLATE_TIMEOUT_MS / 1000} s`);
  onAnswer?.(res.text);
  const parsed = JSON.parse(res.text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as unknown;
  const list = Array.isArray(parsed) ? parsed : (parsed as { translations?: unknown } | null)?.translations;
  if (!Array.isArray(list) || list.length !== items.length) throw new Error("answer isn't one line per item");
  // Each a string, or the item's own shape back ({ text }), as the model sometimes answers.
  const lines = list.map((v) => (typeof v === "string" ? v : typeof (v as { text?: unknown })?.text === "string" ? (v as { text: string }).text : "").trim());
  const kept = lines.map((v, i) => (v && keepsEssentials(items[i].text, v, items[i].max, lang) ? v : null));
  const failed = kept.filter((v) => v == null).length;
  if (failed > 0) console.warn(`[bot-language] ${failed} of ${items.length} line(s) failed the checks for ${lang}; they stay English`);
  return kept;
}

/**
 * Each line in `lang`, or null where it stays English (failed a check, or
 * the call did): from bot_translations, else one AI call for the rest.
 */
export async function translateLines(
  lang: Foreign, items: { text: string; max: number; kind?: Slot["kind"] }[], userId: string | null = null,
  /** The AI's raw answer, for /api/worker/translation-check. */
  onAnswer?: (raw: string) => void,
): Promise<(string | null)[]> {
  const out: (string | null)[] = items.map(() => null);
  if (items.length === 0) return out;
  const hashes = items.map((i) => hashOf(i.text, i.max));
  const db = createServerClient();
  try {
    const { data } = await db.from("bot_translations").select("source_hash, translated").eq("lang", lang).in("source_hash", Array.from(new Set(hashes)));
    const cached = new Map(((data ?? []) as { source_hash: string; translated: string }[]).map((r) => [r.source_hash, r.translated]));
    // A cached line still has to pass the checks: a bad one is translated again (and replaced).
    hashes.forEach((h, i) => {
      const t = cached.get(h);
      out[i] = t && keepsEssentials(items[i].text, t, items[i].max, lang) ? t : null;
    });
  } catch {
    // Not cached: translated below.
  }
  const todo = new Map<string, number>(); // hash → first item with it
  hashes.forEach((h, i) => { if (out[i] == null && !todo.has(h)) todo.set(h, i); });
  const firsts = Array.from(todo.values());
  for (let at = 0; at < firsts.length; at += BATCH) {
    const chunk = firsts.slice(at, at + BATCH);
    try {
      const fresh = await askModel(lang, chunk.map((i) => items[i]), userId, onAnswer);
      const rows: { lang: string; source_hash: string; translated: string }[] = [];
      chunk.forEach((i, n) => {
        const t = fresh[n];
        if (!t) return;
        hashes.forEach((h, j) => { if (h === hashes[i]) out[j] = t; });
        rows.push({ lang, source_hash: hashes[i], translated: t });
      });
      if (rows.length > 0) {
        await db.from("bot_translations").upsert(rows, { onConflict: "lang,source_hash" })
          .then(({ error }) => { if (error) console.warn(`[bot-language] cache write failed: ${error.message}`); }, () => undefined);
      }
    } catch (e) {
      console.warn(`[bot-language] ${chunk.length} line(s) stay English for ${lang}: ${(e as Error).message}`);
    }
  }
  return out;
}

/**
 * The message as it goes to `to`, in their language, or null when it goes as
 * it is (English seller, nothing to translate, or the translation failed).
 * Never throws.
 */
export const localizeOutbound = (to: string, body: Rec): Promise<Rec | null> => localizeWith(to, body, asWritten.getStore());

async function localizeWith(to: string, body: Rec, mode: AsWritten | undefined): Promise<Rec | null> {
  try {
    if (mode === "all" || body.status === "read" || !["text", "image", "interactive"].includes(String(body.type))) return null;
    const lang = await recipientLanguage(to);
    if (lang === "en") return null;
    const copy = structuredClone(body);
    const slots = slotsOf(copy).filter((s) => !(mode === "body" && s.kind === "body") && hasWords(s.text) && !alreadyIn(lang, s.text));
    if (slots.length === 0) return null;
    const userId = isWebAddress(to) ? to.slice(WEB_PREFIX.length) : known.get(to)?.userId ?? null;
    const done = await translateLines(lang, slots.map((s) => ({ text: s.text, max: s.max, kind: s.kind })), userId);
    let changed = false;
    slots.forEach((s, i) => {
      const t = done[i];
      if (t && t !== s.text) { s.set(t); changed = true; }
    });
    return changed ? copy : null;
  } catch (e) {
    console.warn(`[bot-language] sent in English: ${(e as Error).message}`);
    return null;
  }
}

/** One of the bot's lines in `to`'s language (a nudge added to the AI's reply). English when anything fails. */
export async function localizeText(to: string, text: string): Promise<string> {
  const shown = await localizeWith(to, { type: "text", text: { body: text } }, undefined);
  const body = (shown?.text as Rec | undefined)?.body;
  return typeof body === "string" ? body : text;
}
