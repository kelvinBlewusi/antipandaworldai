/**
 * The language a seller's listings are written in: their Jumia market's
 * (owner, 2026-10-11: "let's make sure all other countries are supported";
 * "The market's language"). Jumia's sites in Côte d'Ivoire, Senegal and
 * Morocco are in French; the other markets in English.
 *
 * Drafting stays in English: the category search, the attribute values and
 * the content rules all work on English text. The seller-facing copy (name,
 * description, highlights) is translated as the last step, so a French
 * market gets French copy without the pipeline changing.
 */

import { callGeminiBackend } from "@/lib/ai/gemini-client";

export type ListingLanguage = "en" | "fr";

/** Jumia markets whose listings are in French. */
export const FRENCH_MARKETS = new Set(["CI", "SN", "MA"]);

export function listingLanguageFor(country: string | null | undefined): ListingLanguage {
  return country && FRENCH_MARKETS.has(country.toUpperCase()) ? "fr" : "en";
}

/** A cheap, fast model that translates well; one call per listing. */
const TRANSLATE_MODEL = "gemini-2.5-flash-lite";

export interface ListingCopy { title?: string | null; description?: string | null; highlights?: string | null }

export function translationPrompt(copy: ListingCopy): string {
  return [
    "Translate this Jumia product listing from English into French, as a seller on Jumia Côte d'Ivoire, Sénégal or Maroc would write it.",
    "Rules:",
    "- Keep brand names, model numbers, sizes, units, numbers and codes exactly as they are.",
    "- Keep every HTML tag and the structure (lists, tables, line breaks) exactly; translate only the text between tags.",
    "- Natural, persuasive French for shoppers; no notes, no quotes around the result, nothing added or left out.",
    "- The name stays a product name (no full sentence), about as long as the English one.",
    "Return JSON only: {\"title\": string|null, \"description\": string|null, \"highlights\": string|null}, null where the input is null.",
    "",
    JSON.stringify({ title: copy.title ?? null, description: copy.description ?? null, highlights: copy.highlights ?? null }),
  ].join("\n");
}

/** Whether a translation kept the HTML tags of the original (same tags, same order). */
export function sameTags(original: string, translated: string): boolean {
  const tags = (s: string) => (s.match(/<\/?[a-z][a-z0-9]*\b/gi) ?? []).map((t) => t.toLowerCase()).join(" ");
  return tags(original) === tags(translated);
}

/**
 * The copy in `lang`, field by field; a field that fails a check (empty,
 * HTML changed, a name grown past twice its length) keeps its English. Null
 * when nothing needs translating or the call fails: the English stands.
 */
export async function translateListingCopy(copy: ListingCopy, lang: ListingLanguage): Promise<ListingCopy | null> {
  if (lang === "en") return null;
  const fields = (["title", "description", "highlights"] as const).filter((f) => typeof copy[f] === "string" && copy[f]!.trim());
  if (fields.length === 0) return null;
  try {
    const { text } = await callGeminiBackend(TRANSLATE_MODEL, [{ text: translationPrompt(copy) }], { json: true });
    const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, "")) as Record<string, unknown>;
    const out: ListingCopy = {};
    for (const f of fields) {
      const original = copy[f]!;
      const v = typeof parsed[f] === "string" ? (parsed[f] as string).trim() : "";
      if (!v || !sameTags(original, v)) continue;
      if (f === "title" && v.length > Math.max(original.length * 2, 40)) continue;
      out[f] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (e) {
    console.warn(`[listing-language] translation to ${lang} failed, English kept: ${(e as Error).message}`);
    return null;
  }
}
