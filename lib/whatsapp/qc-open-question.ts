/**
 * A rejected product's question that stays open (switch assistant_followup;
 * lib/whatsapp/fix-rejected.ts), as the agent is told it: intake's open
 * question, and the test set's cases (lib/evals/assistant-cases.ts). Its
 * own module, with no imports but types, so the cases stay plain data.
 */

import type { QcLiveAsk } from "@/lib/whatsapp/session";

/**
 * A rejected product's question that stays open, as the agent is told it
 * (intake's open question; the test set's cases use it too): the product,
 * its SKU, the field, what Jumia has now and its words, and that "it" means
 * this product. Pure.
 */
export function qcOpenQuestion(q: Pick<QcLiveAsk, "name" | "sku" | "ask" | "about" | "field" | "fieldLabel" | "current" | "jumiaSaid">): string {
  const field = q.ask === "brand" ? "brand" : q.about === "weight" ? "weight (in kg, packed as it ships)" : q.fieldLabel;
  return [
    `Jumia's quality check rejected their product "${q.name}" (SKU ${q.sku}) and needs its ${field}`,
    q.current ? `; Jumia has ${q.current} for it now` : "",
    q.jumiaSaid ? `; Jumia said: "${q.jumiaSaid}"` : "",
    `. While this is open, "it", "this" and "the product" mean this product`,
    `; the change it needs is content_change for this product with its ${q.ask === "brand" ? "brand" : q.field ? `${q.fieldLabel} detail` : `${q.fieldLabel} in the description`}`,
  ].join("");
}
