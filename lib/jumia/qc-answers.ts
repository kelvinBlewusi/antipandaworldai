/**
 * Reading a seller's answer to what Jumia's quality check asked for
 * (lib/jumia/qc-remedy.ts ask_value / ask_brand): a weight in kg, a brand,
 * a warranty. Shared by the fix of a product listed through PandaWorld
 * (lib/whatsapp/intake.ts applyQcAnswer) and of one listed any other way
 * (lib/whatsapp/fix-rejected.ts). Pure.
 */

import { allowedValueFor } from "@/lib/jumia/preflight";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

/**
 * A weight in kg as Jumia's weight field takes it ("0.35"), from "350 g",
 * "0.35kg", "1.2 kilos". A bare number under 10 is kg; a bare bigger one
 * could be grams or kilos, so the unit is asked (`unit`). Null when there's
 * no number in it.
 */
export function parseWeightKg(text: string): { kg: string } | { unit: number } | null {
  const m = /(\d+(?:[.,]\d+)?)\s*(kgs?|kilo(?:gram)?s?|kilogrammes?|g|gr|grams?|grammes?|gms?)?\b/i.exec(text.replace(/(\d),(\d{3})\b/g, "$1$2"));
  if (!m) return null;
  const n = parseFloat(m[1].replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  let kg: number;
  if (unit.startsWith("k")) kg = n;
  else if (unit) kg = n / 1000;
  else if (n < 10) kg = n;
  else return { unit: n };
  if (kg > 2000) return null;
  return { kg: String(Math.round(kg * 1000) / 1000) };
}

/**
 * A number Jumia asked for (an FDA registration number, a certificate), as
 * the seller replied it: "FDA number is …" loses its lead-in; "FDA/SD.255-
 * 112170" (a seller's, 2026-10-11) is the number itself and keeps its
 * "FDA". Pure.
 */
export function valueFromReply(text: string): string {
  const t = text.trim();
  return t.replace(/^(?:(?:the|its|it'?s|my)\s+)?(?:fda\b(?!\s*[/.-])\s*)?(?:reg(?:istration)?\.?\s*)?(?:no\.?|number|num)?\s*(?:is|:|=)?\s*/i, "").trim() || t;
}

const GENERIC = /^(generic|none|no brand|unbranded|no name|n\/?a)[.!]*$/i;

/**
 * The brand in the seller's words: "change the brand to Pro", "the brand is
 * Pro", "brand: Pro", or, when it's the reply to the question (`reply`),
 * just "Pro". "Generic" for none. Null when it names none.
 */
export function parseBrandAnswer(text: string, reply: boolean): string | null {
  const t = text.trim().replace(/[.!]+$/, "");
  const said = /\bbrand(?:\s+name)?\s*(?:to|is|should be|=|:|as|into)\s*["'“]?([^"'”\n,;?]{1,40})/i.exec(t)
    ?? /\b(?:change|set|make|put|use)\s+(?:it|the brand|its brand)\s+(?:to|as)\s*["'“]?([^"'”\n,;?]{1,40})/i.exec(t);
  const raw = said ? said[1].trim() : reply && t.split(/\s+/).length <= 4 && !/\?$/.test(t) ? t : null;
  if (!raw) return null;
  const brand = raw.replace(/^(?:the\s+)?brand\s+/i, "").replace(/\s+(?:please|pls|plz)$/i, "").trim();
  if (!brand) return null;
  return GENERIC.test(brand) ? "Generic" : brand.slice(0, 40);
}

/** "1 year", "6 months", "12 months" → the duration spelled as Jumia's options are ("1 Year", "6 Months"). */
function durationWords(text: string): string | null {
  const m = /(\d{1,2})\s*(years?|yrs?|months?|mos?)\b/i.exec(text) ?? /\b(one|two|three|six)\s*(years?|months?)\b/i.exec(text);
  if (!m) return null;
  const words: Record<string, number> = { one: 1, two: 2, three: 3, six: 6 };
  let n = /^\d+$/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()];
  let years = /^y/i.test(m[2]);
  if (!years && n % 12 === 0) { n = n / 12; years = true; }
  return years ? `${n} Year${n === 1 ? "" : "s"}` : `${n} Month${n === 1 ? "" : "s"}`;
}

/**
 * A warranty in the seller's words, as the category's warranty fields take
 * it: their words in the free-text one, its length and kind in the choice
 * ones when Jumia has an option for them (never a guess), and a line for
 * the description (Jumia asks for both).
 */
export function warrantyAnswer(text: string, attrs: JumiaCategoryAttribute[]): { details: Record<string, string>; line: string } {
  const words = text.trim().replace(/\s+/g, " ").slice(0, 300);
  const details: Record<string, string> = {};
  const has = (name: string) => attrs.find((a) => a.name === name);
  const free = has("product_warranty") ?? attrs.find((a) => /warrant/i.test(a.name) && a.allowed_values.length === 0 && !/address/i.test(a.name));
  if (free) details[free.name] = words;
  const duration = has("warranty_duration");
  const said = durationWords(words);
  if (duration && said) {
    const v = allowedValueFor(said, duration);
    if (v) details[duration.name] = v;
  }
  const type = has("warranty_type");
  if (type) {
    const kind = /replac/i.test(words) ? "Replacement by Vendor" : /repair/i.test(words) ? "Repair by Vendor" : null;
    const v = kind ? allowedValueFor(kind, type) : null;
    if (v) details[type.name] = v;
  }
  return { details, line: words };
}

/** Text for HTML. */
export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
