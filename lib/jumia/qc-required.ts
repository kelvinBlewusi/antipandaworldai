/**
 * What each category's quality check needs that its category data doesn't
 * mark required (owner, 2026-10-13; docs/plan-2026-10-13-ask-what-jumia-needs.md
 * step 5): learned from every rejection the chat reads, and asked before a
 * draft in that category is sent (lib/whatsapp/readiness.ts, switch
 * assistant_followup). Table jumia_qc_required.
 */

import { createServerClient } from "@/lib/supabase/server";
import { qcActionFromTable, type QcAction, type QcContext } from "@/lib/jumia/qc-remedy";

export interface QcRequirement {
  categoryCode: number;
  /** The category's field ('fda', 'product_warranty'…), 'fda' where it has none (the description), or 'brand'. */
  field:        string;
  label:        string | null;
  kind:         "value" | "brand";
  /** Jumia's words, up to 300 characters. */
  example:      string | null;
  seen:         number;
}

/**
 * A brand rejection that asks for a placeholder, not a real brand ("Kindly
 * avoid using Fashion on non-Fashion items instead use Generic as brand",
 * "…on Fashion items instead use Fashion"): not a need for a real brand.
 */
const PLACEHOLDER_BRAND_RE = /\b(?:instead|please) use ['"]?(?:generic|fashion)\b|\buse ['"]?(?:generic|fashion)['"]? as (?:the )?brand\b|\bavoid using (?:generic|fashion) on\b/i;
/** "Don't use Generic…": the opposite (reviewing step 5). */
const NOT_PLACEHOLDER_RE = /\b(?:do not|don'?t|cannot|can'?t|never|not) use ['"]?(?:generic|fashion)\b/i;
const placeholderFix = (said: string) => PLACEHOLDER_BRAND_RE.test(said) && !NOT_PLACEHOLDER_RE.test(said);
/** An FDA number asked in so many words, not just "regulations" (reviewing step 5: "content regulations" isn't one). */
const FDA_ASKED_RE = /\b(?:fda|fdb|nafdac)\b|registration (?:number|no)|regulation registration/i;
/** A warranty asked for, not one to take out or put right ("remove warranty claims", "do not match"). */
const WARRANTY_ASKED_RE = /\b(?:requires?|provide|add|missing|valid|include|mention(?:ed)?|state)\b[^.;]{0,60}\bwarrant|\bwarrant\w*\b[^.;]{0,40}\b(?:is |are )?(?:required|missing|needed)\b/i;
const WARRANTY_NOT_RE = /\b(?:remove|delete|do not match|does not match|mismatch|inconsistent|false|misleading)\b/i;
/** A rejection that says the category is wrong: what it asks is for the right one, not this one. */
const WRONG_CATEGORY_RE = /\bwrong category\b|\bcategory mismatch\b|\bbelongs? in\b|\bfits? (?:better )?in the\b|\bshould be (?:listed )?(?:in|under)\b/i;
/** A rejection that wants the product's real brand, however its fix was read ("'Generic' brand is not allowed for core electronics… use the actual brand name"). */
const REAL_BRAND_RE = /\b(?:actual|genuine|specific|real) brand\b|\bbrand name on the package\b|\bnot a recognized brand\b/i;

/**
 * What a rejection's fix asked the seller for, as a requirement of its
 * category, or null when it's nothing to ask before submit: the weight
 * (required and estimated already), a rewrite, words taken out, a photo, a
 * category. Pure.
 */
export function qcRequirementOf(action: QcAction, said: string | null, whole: string | null = said): Pick<QcRequirement, "field" | "label" | "kind"> | null {
  // Nothing to check it against (a reason Jumia didn't send): nothing learned.
  const text = said ?? "";
  if (!text.trim()) return null;
  switch (action.kind) {
    case "ask_value": {
      if (action.about === "weight" || /weight/i.test(`${action.field ?? ""} ${action.fieldLabel}`)) return null;
      // Decided from Jumia's words, never from the fix's fallback label.
      if (FDA_ASKED_RE.test(text)) {
        return action.field ? { field: action.field, label: action.fieldLabel, kind: "value" } : { field: "fda", label: "FDA registration number", kind: "value" };
      }
      if (action.about === "warranty") {
        return WARRANTY_ASKED_RE.test(text) && !WARRANTY_NOT_RE.test(text) ? { field: action.field ?? "product_warranty", label: "Warranty", kind: "value" } : null;
      }
      // Another value Jumia named, in a field of its own (a licence number…).
      return action.field && !/fda|registration/i.test(action.fieldLabel) ? { field: action.field, label: action.fieldLabel, kind: "value" } : null;
    }
    case "ask_brand":
    case "rename":
      return placeholderFix(whole ?? text) ? null : { field: "brand", label: "Brand", kind: "brand" };
    default:
      return null;
  }
}

type Need = Pick<QcRequirement, "field" | "label" | "kind">;

/**
 * Everything a rejection says its category needs: its fix's (`action`), and
 * each of its reasons read on its own, since Jumia often gives several in
 * one ("Wrong Category: …; forbidden promotional word: 'Hot'; Kindly Provide
 * Product's Health/Food Regulation Registration Number"). Pure.
 */
export function requirementsIn(said: string, fields: QcContext["fields"], action?: QcAction | null): Need[] {
  // Jumia says the category is wrong: what else it asks belongs to the right
  // one, not this (reviewing step 5: hot wax in body groomers, rejected for
  // its FDA number too, would ask every beard trimmer there for one).
  if (WRONG_CATEGORY_RE.test(said) || action?.kind === "switch_category" || action?.kind === "ask_category") return [];
  const out = new Map<string, Need>();
  const add = (n: Need | null) => { if (n && !out.has(n.field)) out.set(n.field, n); };
  if (action) add(qcRequirementOf(action, said));
  for (const part of said.split(/;\s+|\n+/).map((p) => p.trim()).filter((p) => p.length > 5)) {
    const a = qcActionFromTable({ reason: null, comment: part, title: "", brand: null, categoryPath: null, fields });
    if (!a) continue;
    // A brand need from one part alone is only taken when the part asks for a
    // brand ("Kindly use the brand name on the package"), never from a part
    // that only mentions one; the whole rejection decides whether a
    // placeholder is the fix.
    if ((a.kind === "ask_brand" || a.kind === "rename") && !/\bbrand\b/i.test(part)) continue;
    add(qcRequirementOf(a, part, said));
  }
  if (REAL_BRAND_RE.test(said) && !placeholderFix(said)) add({ field: "brand", label: "Brand", kind: "brand" });
  return Array.from(out.values());
}

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<number, { at: number; rows: QcRequirement[] }>();

/** Tests only: forget what's been read. */
export function _resetQcRequiredCache(): void {
  cache.clear();
}

/**
 * Record what a rejection asked for, in its category. Best-effort: it runs
 * inside the fix of a rejected product, which must never fail because of it.
 */
export async function learnQcRequirement(
  categoryCode: number | null | undefined, action: QcAction, said: string | null, fields: QcContext["fields"] = [],
): Promise<void> {
  if (categoryCode == null || !Number.isFinite(categoryCode)) return;
  for (const need of requirementsIn(said ?? "", fields, action)) await record(categoryCode, need, said);
}

async function record(categoryCode: number, need: Need, said: string | null): Promise<void> {
  const example = said ? said.replace(/\s+/g, " ").trim().slice(0, 300) || null : null;
  const now = new Date().toISOString();
  try {
    const db = createServerClient();
    const { data, error } = await db.from("jumia_qc_required").select("seen")
      .eq("category_code", categoryCode).eq("field", need.field).maybeSingle();
    if (error) throw new Error(error.message);
    const write = data
      ? await db.from("jumia_qc_required").update({ seen: (Number((data as { seen?: number }).seen) || 1) + 1, last_seen: now, label: need.label, kind: need.kind, ...(example ? { example } : {}) })
        .eq("category_code", categoryCode).eq("field", need.field)
      : await db.from("jumia_qc_required").insert({ category_code: categoryCode, field: need.field, label: need.label, kind: need.kind, example, seen: 1, first_seen: now, last_seen: now });
    if (write.error) throw new Error(write.error.message);
    cache.delete(categoryCode);
  } catch (e) {
    console.warn(`[qc-required] couldn't record ${need.field} for ${categoryCode}: ${(e as Error).message}`);
  }
}

/** What this category's quality check has asked for, most often first. Empty when nothing yet or on error. */
export async function qcRequiredFor(categoryCode: number | null | undefined): Promise<QcRequirement[]> {
  if (categoryCode == null || !Number.isFinite(categoryCode)) return [];
  const hit = cache.get(categoryCode);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows;
  try {
    const { data, error } = await createServerClient().from("jumia_qc_required")
      .select("category_code, field, label, kind, example, seen").eq("category_code", categoryCode);
    if (error) throw new Error(error.message);
    // A need learned from a wrong-category rejection (before that was
    // skipped) belongs to another category: never asked here.
    const rows = ((data ?? []) as Record<string, unknown>[]).filter((r) => !WRONG_CATEGORY_RE.test(String(r.example ?? ""))).map((r) => ({
      categoryCode: Number(r.category_code), field: String(r.field), label: (r.label as string | null) ?? null,
      kind: r.kind === "brand" ? "brand" as const : "value" as const, example: (r.example as string | null) ?? null, seen: Number(r.seen) || 1,
    })).sort((a, b) => b.seen - a.seen);
    cache.set(categoryCode, { at: Date.now(), rows });
    return rows;
  } catch (e) {
    console.warn(`[qc-required] couldn't read ${categoryCode}: ${(e as Error).message}`);
    return [];
  }
}

/** One rejection to learn from: its category, Jumia's words, and the category's fields. */
export interface PastRejection {
  categoryCode: number;
  said:         string;
  fields:       { name: string; label: string | null }[];
}

/**
 * What past rejections say each category needs (the one-off seed,
 * scripts/seed-qc-required.ts): read the same way as a rejection in the
 * chat (qcActionFromTable, no AI), each rejection counted once. Pure.
 */
export function requirementsFromRejections(past: PastRejection[]): QcRequirement[] {
  const out = new Map<string, QcRequirement>();
  for (const r of past) {
    if (!Number.isFinite(r.categoryCode) || !r.said.trim()) continue;
    const whole = qcActionFromTable({ reason: null, comment: r.said, title: "", brand: null, categoryPath: null, fields: r.fields });
    for (const need of requirementsIn(r.said, r.fields, whole)) {
      const key = `${r.categoryCode}:${need.field}`;
      const had = out.get(key);
      out.set(key, had
        ? { ...had, seen: had.seen + 1 }
        : { categoryCode: r.categoryCode, ...need, example: r.said.replace(/\s+/g, " ").trim().slice(0, 300), seen: 1 });
    }
  }
  return Array.from(out.values()).sort((a, b) => a.categoryCode - b.categoryCode || a.field.localeCompare(b.field));
}
