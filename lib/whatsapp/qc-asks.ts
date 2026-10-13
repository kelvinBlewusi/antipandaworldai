/**
 * What a draft is asked before it's sent, because its category's quality
 * check has turned products down without it (owner, 2026-10-13;
 * docs/plan-2026-10-13-ask-what-jumia-needs.md step 6): an FDA number, a
 * warranty, a real brand, learned from rejections (lib/jumia/qc-required.ts).
 * Jumia's category data calls them optional, so nothing asked before.
 * Switch assistant_followup.
 *
 * Each comes back as a missing field (readiness' missingFields) carrying
 * `qc`, and askForNextMissingValue asks it like a required one, with the
 * reason and Skip. A skip is kept on the draft (field_sources
 * "qc_skipped.<field>"): it's sent as it is.
 */

import { createServerClient } from "@/lib/supabase/server";
import { columnFor, readAttributeValue } from "@/lib/jumia/attribute-mapping";
import { getCategoryAttributes, type JumiaCategoryAttribute } from "@/lib/jumia/categories";
import { qcRequiredFor, type QcRequirement } from "@/lib/jumia/qc-required";
import { followupFor } from "@/lib/whatsapp/switches";
import type { ListingRow } from "@/lib/supabase/types";

export interface QcAskInfo {
  kind:        "value" | "brand";
  /** Where they'll find it, for the question. */
  where:       string;
  /** The category has the field: its value goes there (and autofill may read it off a label). */
  inCategory:  boolean;
  /** The answer also goes in the description (a warranty; an FDA number with no field of its own). */
  description: boolean;
}

/** A field a draft is held without: one its category requires, or one its quality check asks for (`qc`). */
export type MissingField = JumiaCategoryAttribute & { qc?: QcAskInfo };

/** A value that says nothing: what drafting puts in a field it doesn't know. */
const PLACEHOLDER_VALUE = /^(?:n\/?a|none|nil|null|no|not applicable|no warranty|-+|\.+|0)$/i;
/** A brand that isn't one: the placeholders Jumia's check turned down. */
const PLACEHOLDER_BRAND = /^(?:generic|fashion|no brand|unbranded|none|n\/?a)?$/i;

const isFda = (r: Pick<QcRequirement, "field" | "label">) => /\bfda\b|registration/i.test(`${r.field} ${r.label ?? ""}`);

/** The field as a question asks it ("FDA registration number", "warranty", "brand"). Pure. */
export function qcFieldLabel(r: Pick<QcRequirement, "field" | "label" | "kind">, attr?: JumiaCategoryAttribute): string {
  if (r.kind === "brand") return "brand";
  if (isFda(r)) return "FDA registration number";
  if (/warrant/i.test(r.field)) return "warranty";
  return attr?.label || r.label || r.field.replace(/_/g, " ");
}

/**
 * What this draft lacks of what its category's quality check asks for. Pure.
 * - A value in the category's own field: missing when empty or a
 *   placeholder ("N/A", "None"); a warranty also when the seller didn't
 *   give it (drafting writes one: Jumia turned the Galaxy A15 down with it).
 * - A value with no field of its own (an FDA number in 1019709): missing
 *   until the seller gives it (field_sources "qc_given.<field>").
 * - A brand: missing while it's Generic, Fashion or empty.
 * Skipped ones aren't (field_sources "qc_skipped.<field>").
 */
export function qcMissingFields(
  reqs: QcRequirement[], attrs: JumiaCategoryAttribute[], row: ListingRow, builtBrand: string | null | undefined,
): MissingField[] {
  const sources = ((row as ListingRow & { field_sources?: Record<string, string> | null }).field_sources ?? {}) as Record<string, string>;
  const out: MissingField[] = [];
  for (const r of reqs) {
    if (sources[`qc_skipped.${r.field}`] === "user") continue;
    if (r.kind === "brand") {
      const brand = String(builtBrand ?? row.brand ?? "").trim();
      if (!PLACEHOLDER_BRAND.test(brand)) continue;
      out.push({
        name: "brand", label: "Brand", type: "string", allowed_values: [], required: false, is_variant: false, max_length: 60,
        qc: { kind: "brand", where: "the brand printed on the product or its box", inCategory: false, description: false },
      });
      continue;
    }
    const attr = attrs.find((a) => a.name === r.field);
    const warranty = /warrant/i.test(r.field);
    const where = isFda(r) ? "it's on the label or the pack" : warranty ? "e.g. \"1 year, repair by vendor\"" : "";
    if (attr) {
      const value = readAttributeValue(row, attr.name).trim();
      const key = columnFor(attr.name) ?? `dynamic_attributes.${attr.name}`;
      const given = value && !PLACEHOLDER_VALUE.test(value) && (!warranty || sources[key] === "user");
      if (given) continue;
      out.push({ ...attr, qc: { kind: "value", where, inCategory: true, description: warranty } });
      continue;
    }
    if (sources[`qc_given.${r.field}`] === "user") continue;
    out.push({
      name: r.field, label: qcFieldLabel(r), type: "string", allowed_values: [], required: false, is_variant: false, max_length: 200,
      qc: { kind: "value", where, inCategory: false, description: true },
    });
  }
  return out;
}

/** What this draft lacks of what its category's quality check asks for, where the switch is on for the seller. */
export async function qcAsksFor(userId: string, listingId: string, categoryCode: number, builtBrand: string | null | undefined): Promise<MissingField[]> {
  if (!Number.isFinite(categoryCode) || !(await followupFor(userId))) return [];
  const reqs = await qcRequiredFor(categoryCode);
  if (reqs.length === 0) return [];
  const [{ data }, attrs] = await Promise.all([
    createServerClient().from("listings").select("*").eq("id", listingId).maybeSingle(),
    getCategoryAttributes(categoryCode).catch(() => [] as JumiaCategoryAttribute[]),
  ]);
  return data ? qcMissingFields(reqs, attrs, data as ListingRow, builtBrand) : [];
}

/** Whether a draft in this category may be asked anything before it's sent (a cheap look, before the full check). */
export async function qcMayAsk(userId: string, categoryCode: number): Promise<boolean> {
  return Number.isFinite(categoryCode) && (await followupFor(userId)) && (await qcRequiredFor(categoryCode)).length > 0;
}
