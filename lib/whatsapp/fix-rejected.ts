/**
 * Fixing products Jumia's quality check rejected, from the chat (owner,
 * 2026-10-09: "can we be able to fix rejected products from the chat").
 *
 *   - "fix my rejected products": the rejected ones, each with Jumia's reason
 *     when its API gives one, as a list to tap.
 *   - One product listed through PandaWorld: its Fix & resubmit (the guided
 *     QC fix lib/whatsapp/intake.ts runs on `fix:<listingId>`): it's redrafted
 *     or asked about and sent to Jumia again as a new listing.
 *   - One listed some other way (Vendor Center, another tool): Jumia's
 *     reason is read the same way (lib/jumia/qc-remedy.ts decideQcAction),
 *     then what the API can fix is offered as a content change for one tap
 *     (POST /feeds/products/update; Jumia checks it again), what only the
 *     seller knows is asked for in the words that change it, and what the
 *     API can't change (category, main photo, price before approval) is said
 *     plainly with where to do it.
 */

import { createServerClient } from "@/lib/supabase/server";
import { sendButtonsIfConfigured, sendCtaUrlIfConfigured, sendListIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";
import { decideQcAction, type QcAction } from "@/lib/jumia/qc-remedy";
import { learnQcRequirement } from "@/lib/jumia/qc-required";
import { escapeHtml, parseBrandAnswer, parseWeightKg, valueFromReply, warrantyAnswer } from "@/lib/jumia/qc-answers";
import { fetchProductSet, findProducts, type ShopProduct } from "@/lib/jumia/shop";
import { getCategoryAttributes, getCategoryByCode } from "@/lib/jumia/categories";
import { removeWordsFromText } from "@/lib/ai/restricted-words";
import { categoryDetails } from "@/lib/whatsapp/live-details";
import { categoryPickerUrl } from "@/lib/whatsapp/category-question";
import { QC_KEEP_MS, updateSession, type QcLiveAsk } from "@/lib/whatsapp/session";
import { lastBotMessage } from "@/lib/whatsapp/message-log";
import { followupFor } from "@/lib/whatsapp/switches";
import { CHANGES, CHANGES_FEATURE, catalog, label, proposeContentChange, shopContext, shorten, type ContentRequest } from "@/lib/whatsapp/shop";

const VENDOR_CENTER = "https://vendorcenter.jumia.com";
const REJECTED_PATH = "Products → Manage Products → Rejected";

/**
 * What to do for one rejected product: a rewrite offered for a tap, words
 * taken out of its text and offered for a tap, or words to say (a question
 * gets its answer as the next message: QcLiveAsk).
 */
export type FixPlan =
  | { kind: "rewrite"; fields: ("name" | "description" | "highlights")[]; instructions: string; intro: string }
  | { kind: "remove"; words: string[]; intro: string }
  | { kind: "say"; text: string; vendorCenter?: boolean };

/** The product as the seller would say it, for the words that change it: "the neck fan". */
function shortName(name: string): string {
  const words = name.replace(/[–—-].*$/, "").replace(/\(.*?\)/g, "").split(/\s+/).filter(Boolean);
  return words.slice(0, 4).join(" ").toLowerCase();
}

type TextField = "name" | "description" | "highlights";

/** The text fields some words name ("the title is too long" → name), none when they name none. */
export function namedFields(words: string): TextField[] {
  const r = words.toLowerCase();
  const out: TextField[] = [];
  if (/\b(title|name)\b/.test(r)) out.push("name");
  if (/\bdescription\b/.test(r) && !/short description/.test(r)) out.push("description");
  if (/highlight|short description|key features/.test(r)) out.push("highlights");
  return out;
}

/** The fields Jumia's reason is about ("Wrong Title" → name). Both name and description when it doesn't say. */
export function fieldsFor(reason: string): TextField[] {
  const out = namedFields(reason);
  return out.length > 0 ? out : ["name", "description"];
}

/**
 * The plan for one rejected product, from what decideQcAction said. Pure.
 * `said` is the seller's own message (owner, 2026-10-11: the fix should come
 * from "the rejection reason and the seller's intent and command"): the
 * fields it names are rewritten too, and its words go to the writer with
 * Jumia's reason.
 */
export function fixPlan(action: QcAction, name: string, reason: string, pickerUrl?: string, said?: string | null, current?: string | null): FixPlan {
  const short = shortName(name);
  const findIt = pickerUrl ? ` Find the right category here and copy it: ${pickerUrl}` : "";
  const theirs = said?.trim() ? said.trim().slice(0, 400) : "";
  switch (action.kind) {
    case "redraft": {
      const named = Array.from(new Set([...namedFields(reason), ...namedFields(theirs)]));
      const fields = named.length > 0 ? named : fieldsFor(reason);
      const what = fields.join(" and ");
      return {
        kind: "rewrite", fields,
        instructions: [
          reason ? `Fix what Jumia's quality check rejected it for: ${reason}.` : "Fix it so Jumia's quality check approves it.",
          ...(theirs ? [`What the seller asked for: "${theirs}". Do that too, unless it goes against Jumia's reason.`] : []),
          "Keep every fact that is there and add none the seller didn't give.",
        ].join(" "),
        intro: `🔧 *${shorten(name, 60)}*: ${action.why} I've rewritten its ${what} to fix it${theirs ? ", as you asked" : ""}.`,
      };
    }
    case "remove_words":
      return {
        kind: "remove", words: action.words,
        intro: `🔧 *${shorten(name, 60)}*: ${action.why.replace(/\.$/, "")}. I've taken ${action.words.length === 1 ? "it" : "them"} out and changed nothing else.`,
      };
    case "rename":
      return {
        kind: "rewrite", fields: ["name"],
        instructions: [
          `Jumia's quality check read the name's first words "${action.start}" as a brand${action.why}.`,
          `The new name must NOT begin with "${action.start}": begin with what the product is (its type), and keep "${action.start}" later in the name only as a description of it.`,
          ...(theirs ? [`What the seller asked for: "${theirs}".`] : []),
          "Keep every fact that is there and add none.",
        ].join(" "),
        intro: `🔧 *${shorten(name, 60)}*: Jumia's quality check read "${action.start}" at the start of the name as a brand. I've reworded the name to start with what the product is. If its package does show a brand, reply with it instead (e.g. "the brand is …").`,
      };
    case "ask_brand":
      return { kind: "say", text: `🔍 *${shorten(name, 60)}*: Jumia's quality check says the brand is wrong${action.why}.${current ? ` Its brand on Jumia now is "${current}".` : ""} What brand is printed on the product or its package? Reply with just the brand, or *generic* if it has none, and I'll put it in and send it back to Jumia. A brand Jumia doesn't have yet needs Jumia's brand form first.` };
    case "ask_value": {
      const noFda = !action.about && /fda|registration/i.test(`${action.fieldLabel} ${action.question}`)
        ? "\n\nNo number? Jumia won't approve it until the product is registered. If it doesn't need registering, Jumia's seller support can confirm that."
        : "";
      // What Jumia has now (owner's web chat, 2026-10-12: "That is the
      // weight listed" answered a question that never said what was listed).
      const now = current ? `Jumia has ${current} as its ${fieldWords(action.about, action.fieldLabel)} now and turned that down. ` : "";
      return {
        kind: "say",
        text: `🔍 *${shorten(name, 60)}*: Jumia's quality check needs something only you have. ${now}${action.question}\n\n` +
          `Reply with it here and I'll put it in${action.about === "warranty" ? " (its warranty details and the description)" : ""} and send it back to Jumia.${noFda}`,
      };
    }
    case "ask_price":
      return { kind: "say", vendorCenter: true, text: `🔍 *${shorten(name, 60)}*: Jumia's quality check flagged the price${action.why}. Before a product is approved, Jumia only lets its price be changed in Vendor Center, so change the price there (${REJECTED_PATH}) and send it for checking again there.` };
    case "ask_photos":
      return { kind: "say", vendorCenter: true, text: `📷 *${shorten(name, 60)}*: Jumia's quality check rejected the photos${action.why}. Jumia only lets a product's main photo be changed in Vendor Center, so change them there (${REJECTED_PATH}), or list it again here with new photos (clear, well lit, plain background).` };
    case "switch_category":
      return { kind: "say", vendorCenter: true, text: `🗂️ *${shorten(name, 60)}*: Jumia's quality check says it belongs in "${action.path}". Jumia only lets a product move to another category in Vendor Center, so change it there (${REJECTED_PATH}), or list it again here and I'll put it there.${findIt}` };
    case "ask_category":
      return { kind: "say", vendorCenter: true, text: `🗂️ *${shorten(name, 60)}*: Jumia's quality check says the category is wrong, without saying which is right. Jumia only lets a product move to another category in Vendor Center, so change it there (${REJECTED_PATH}), or list it again here in the right one.${findIt}` };
    case "ask_details":
      return { kind: "say", vendorCenter: true, text: `🔍 *${shorten(name, 60)}*: Jumia didn't send why it was rejected with the product. Open it in Vendor Center (${REJECTED_PATH}), copy Jumia's reason, and send it here as "fix the ${short}: <the reason>". I'll work out the fix.` };
    case "cannot_fix":
      return { kind: "say", text: `⚠️ *${shorten(name, 60)}*: ${action.why}` };
  }
}

/** A field as said in a sentence: "weight", "FDA", "product warranty". Pure. */
function fieldWords(about: "weight" | "warranty" | null | undefined, fieldLabel: string): string {
  if (about === "weight") return "weight";
  const l = fieldLabel.replace(/\(.*?\)/g, "").trim();
  return /^[A-Z0-9]{2,}$/.test(l) ? l : l.toLowerCase();
}

/** How long the question waits for what Jumia has now. */
const CURRENT_VALUE_MS = 6_000;

/**
 * What Jumia has now in the field a question asks about: the weight with
 * its unit ("0.2 kg") or a detail's text. Null when it has none or can't be
 * read in time. Read once, when the question is asked.
 */
async function currentValue(token: string, sku: string, field: string | null, about: "weight" | "warranty" | null): Promise<string | null> {
  if (!field) return null;
  // The question isn't held up for it: without it in a few seconds, it's asked as before.
  const set = await Promise.race([
    fetchProductSet(token, sku).catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), CURRENT_VALUE_MS).unref?.()),
  ]);
  if (!set?.ok || !set.data) return null;
  const raw = set.data.attributes.find((a) => a.name === field)?.value
    ?? set.data.variations.flatMap((v) => v.attributes).find((a) => a.name === field)?.value ?? "";
  const v = raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  if (!v) return null;
  return about === "weight" && /^\d+(?:[.,]\d+)?$/.test(v) ? `${v} kg` : v;
}

/** The PandaWorld listing behind one of these SKUs that Jumia's check rejected, or null. */
async function pandaListing(userId: string, skus: string[]): Promise<{ id: string } | null> {
  if (skus.length === 0) return null;
  const db = createServerClient();
  const { data: direct } = await db.from("listings").select("id, status, jumia_error")
    .eq("user_id", userId).in("sku", skus).order("created_at", { ascending: false }).limit(1);
  let row = ((direct ?? []) as { id: string; status: string | null; jumia_error: string | null }[])[0] ?? null;
  if (!row) {
    const { data: v } = await db.from("variants").select("listing_id").in("seller_sku", skus).limit(5);
    const ids = Array.from(new Set(((v ?? []) as { listing_id: string }[]).map((x) => x.listing_id))).filter(Boolean);
    if (ids.length > 0) {
      const { data: viaVariant } = await db.from("listings").select("id, status, jumia_error")
        .eq("user_id", userId).in("id", ids).order("created_at", { ascending: false }).limit(1);
      row = ((viaVariant ?? []) as { id: string; status: string | null; jumia_error: string | null }[])[0] ?? null;
    }
  }
  return row && row.jumia_error ? { id: row.id } : null;
}

/** One entry per product (its sizes are one product), rejected ones only. */
function rejectedSets(products: ShopProduct[]): ShopProduct[] {
  const rejected = products.filter((p) => p.status !== "DELETED" && p.qcStatus === "REJECTED");
  return Array.from(new Map(rejected.map((p) => [p.setSid ?? p.sid, p])).values());
}

/**
 * "Fix my rejected products" / "fix the neck fan" / "fix the neck fan: <the
 * reason pasted from Vendor Center>". `query` null lists them to tap.
 */
export async function fixRejected(userId: string, phone: string, query: string | null, pasted: string | null = null, said: string | null = null): Promise<string> {
  const ctx = await shopContext(userId, phone, CHANGES_FEATURE, CHANGES);
  if (!ctx) return "blocked";
  const products = await catalog(ctx);
  if (!products) return "no catalog";
  const rejected = rejectedSets(products);

  if (!query) {
    if (rejected.length === 0) {
      await sendTextIfConfigured(phone, "✅ None of your Jumia products is rejected by Jumia's quality check right now.");
      return "none rejected";
    }
    const body = [
      `❌ ${rejected.length} product${rejected.length === 1 ? " was" : "s were"} rejected by Jumia's quality check. Tap one and I'll work out the fix:`,
      ...rejected.slice(0, 10).map((p) => `• ${shorten(label(p), 50)}${p.qcReason ? `: ${shorten(p.qcReason, 70)}` : ""}`),
      ...(rejected.length > 10 ? [`+${rejected.length - 10} more: say "fix the <name>" for any of them.`] : []),
    ].join("\n");
    await sendListIfConfigured(phone, body.slice(0, 1000), "Fix one", rejected.slice(0, 10).map((p) => ({
      id: `qcfix:${p.sellerSku}`.slice(0, 200),
      title: shorten(p.name, 24),
      description: shorten(p.qcReason ?? "Jumia didn't send the reason", 72),
    })));
    return `listed ${rejected.length} rejected`;
  }

  // The one they mean, among the rejected ones first.
  const hits = findProducts(rejected, query);
  if (hits.length === 0) {
    const any = findProducts(products, query);
    if (any.length > 0) {
      const p = any[0];
      const qc = p.qcStatus === "APPROVED" ? "approved" : p.qcStatus === "PENDING" || p.qcStatus === "NOT_READY_TO_QC" ? "waiting for Jumia's check" : (p.qcStatus ?? "not checked yet").toLowerCase();
      await sendTextIfConfigured(phone, `${shorten(label(p), 60)} isn't rejected: Jumia's quality check says ${qc}.`);
      return "not rejected";
    }
    await sendTextIfConfigured(phone, `I couldn't find "${shorten(query, 60)}" among your Jumia products. Try its name as it shows on Jumia, or say "fix my rejected products" to see them.`);
    return "not found";
  }
  const sets = Array.from(new Map(hits.map((p) => [p.setSid ?? p.sid, p])).values());
  if (sets.length > 1) {
    await sendListIfConfigured(phone, `"${shorten(query, 40)}" could be ${sets.length} rejected products. Which one?`, "Pick one",
      sets.slice(0, 10).map((p) => ({ id: `qcfix:${p.sellerSku}`.slice(0, 200), title: shorten(p.name, 24), description: shorten(p.qcReason ?? "", 72) })));
    return `fix unclear: ${sets.length}`;
  }
  const product = sets[0];
  const skus = products.filter((p) => (p.setSid ?? p.sid) === (product.setSid ?? product.sid)).map((p) => p.sellerSku);

  // Listed through PandaWorld: its own guided fix, which sends it again.
  const listing = await pandaListing(userId, skus);
  if (listing) {
    await sendButtonsIfConfigured(phone,
      `🔧 *${shorten(product.name, 60)}* was listed through PandaWorld${product.qcReason ? `, and Jumia's quality check rejected it: ${shorten(product.qcReason, 200)}` : ""}. Tap Fix & resubmit: I'll work out what Jumia wants, ask you for anything only you know, and send it again.`,
      [{ id: `fix:${listing.id}`, title: "Fix & resubmit" }]);
    return "offered panda fix";
  }

  const reason = [pasted?.trim(), product.qcReason].filter(Boolean).join(". ") || null;
  const code = product.categoryCode ? Number(product.categoryCode) : NaN;
  const [category, attrs] = Number.isFinite(code)
    ? await Promise.all([getCategoryByCode(code).catch(() => null), categoryDetails(ctx.token, code).catch(() => [])])
    : [null, []];
  const decided = await decideQcAction({
    reason, comment: null, title: product.name, brand: product.brand, categoryPath: category?.path ?? null,
    fields: attrs.map((a) => ({ name: a.name, label: a.label ?? null })),
  });
  // What this category's quality check needs, for drafts in it (plan step 5; never throws).
  await learnQcRequirement(Number.isFinite(code) ? code : null, decided.action, product.qcReason ?? null, attrs.map((a) => ({ name: a.name, label: a.label ?? null })));
  // Jumia sent no reason, but the seller says what to rewrite: their words are the fix.
  const action: QcAction = decided.action.kind === "ask_details" && said && namedFields(said).length > 0
    ? { kind: "redraft", why: "Jumia didn't send its reason with the product, so I went by what you said." }
    : decided.action;
  // The question stays open, and says what Jumia has now (switch assistant_followup).
  // A rename's brand question stays as it was: it rides along with the rewrite's tap.
  const keep = (action.kind === "ask_value" || action.kind === "ask_brand") && await followupFor(userId);
  const current = !keep ? null
    : action.kind === "ask_brand" ? product.brand?.trim().slice(0, 100) || null
    : action.kind === "ask_value" ? await currentValue(ctx.token, product.sellerSku, action.field, action.about ?? null)
    : null;
  const plan = fixPlan(action, product.name, reason ?? "", categoryPickerUrl(product.categoryCode, ctx.country), said, current);
  console.info(`[qc-chat] ${product.sellerSku}: ${action.kind} (${decided.source})`);
  const ask = (a: Pick<QcLiveAsk, "ask" | "field" | "fieldLabel" | "about">): QcLiveAsk => ({
    kind: "qc_live", sku: product.sellerSku, name: product.name, category: Number.isFinite(code) ? code : null, at: new Date().toISOString(), ...a,
    ...(keep ? {
      keep: true, jumiaSaid: reason ? reason.replace(/\s+/g, " ").trim().slice(0, 200) : null, current,
      ...(plan.kind === "say" ? { asked: plan.text.slice(0, 300) } : {}),
    } : {}),
  });

  // What Jumia asked for may be in their message already ("change the brand
  // to pro": owner's web chat, 2026-10-12, which got the question back three
  // times): put in and offered, not asked again.
  if (said && (action.kind === "ask_brand" || action.kind === "ask_value" || action.kind === "rename")) {
    const pending = action.kind !== "ask_value"
      ? ask({ ask: "brand", field: null, fieldLabel: "Brand", about: null })
      : ask({ ask: "value", field: action.field, fieldLabel: action.fieldLabel, about: action.about ?? null });
    const done = await applyQcAnswer(userId, phone, pending, said, false);
    if (done !== "not an answer") return `fix: ${action.kind} answered (${done})`;
  }
  if (plan.kind === "say") {
    if (plan.vendorCenter) await sendCtaUrlIfConfigured(phone, plan.text, "Vendor Center", VENDOR_CENTER);
    else await sendTextIfConfigured(phone, plan.text);
    // Their reply is the answer (answerQcLive).
    if (action.kind === "ask_brand") await updateSession(phone, { assistantPending: ask({ ask: "brand", field: null, fieldLabel: "Brand", about: null }) });
    if (action.kind === "ask_value") await updateSession(phone, { assistantPending: ask({ ask: "value", field: action.field, fieldLabel: action.fieldLabel, about: action.about ?? null }) });
    return `fix: ${action.kind}`;
  }
  if (plan.kind === "remove") {
    const set = await fetchProductSet(ctx.token, product.sellerSku);
    if (!set.ok || !set.data) {
      await sendTextIfConfigured(phone, `I couldn't read ${shorten(product.name, 60)} from Jumia just now${set.ok ? "" : `: ${set.message}`}. Try again in a minute.`);
      return "fix: remove, set unreadable";
    }
    const req = withoutWords(set.data, plan.words);
    if (Object.keys(req).length === 0) {
      await sendTextIfConfigured(phone, `🔍 *${shorten(product.name, 60)}*: Jumia's quality check objected to ${plan.words.map((w) => `"${w}"`).join(", ")}, but its name, description and highlights on Jumia don't have ${plan.words.length === 1 ? "it" : "them"} now. If you changed it in Vendor Center, send it for checking again there.`);
      return "fix: remove, nothing to remove";
    }
    await sendTextIfConfigured(phone, `${plan.intro} Check it below, then tap Yes to send it to Jumia, which checks it again.`);
    const offered = await proposeContentChange(userId, phone, product.sellerSku, req);
    return `fix: remove (${offered})`;
  }
  await sendTextIfConfigured(phone, `${plan.intro} Check it below, then tap Yes to send it to Jumia, which checks it again.`);
  const offered = await proposeContentChange(userId, phone, product.sellerSku, { rewrite: plan.fields, instructions: plan.instructions });
  // A brand-like start: a brand in their reply is taken too.
  if (action.kind === "rename") await updateSession(phone, { assistantPending: ask({ ask: "brand", field: null, fieldLabel: "Brand", about: null }) });
  return `fix: rewrite (${offered})`;
}

/** Its name, description and highlights with `words` taken out: only the ones that change. Pure. */
export function withoutWords(set: { name: string; description: string; attributes: { name: string; value: string }[] }, words: string[]): ContentRequest {
  const req: ContentRequest = {};
  const name = removeWordsFromText(set.name, words, { line: true });
  if (name && name !== set.name) req.name = name;
  const description = removeWordsFromText(set.description, words);
  if (description && description !== set.description) req.description = description;
  const now = set.attributes.find((a) => a.name === "short_description")?.value ?? "";
  const highlights = removeWordsFromText(now, words);
  if (highlights && highlights !== now) req.highlights = highlights;
  return req;
}

/** How long a rejected product's question waits for its answer. */
const QC_LIVE_TTL_MS = 60 * 60_000;
/** How long one that stays open (`keep`) waits: other requests can come in between. */
export const QC_LIVE_KEEP_MS = QC_KEEP_MS;

/**
 * The seller's answer to what Jumia's quality check asked for, put in the
 * product and offered for its tap (proposeContentChange; Jumia checks it
 * again). `reply`: it's the reply to the question, so a bare "Pro" is the
 * brand; otherwise (their own message) only words that say it count.
 * "not an answer" when it isn't one; "again" when it was, but needs saying
 * again (a weight without its unit).
 */
async function applyQcAnswer(userId: string, phone: string, q: QcLiveAsk, text: string, reply: boolean): Promise<string> {
  const t = text.trim();
  if (q.ask === "brand") {
    const brand = parseBrandAnswer(t, reply);
    if (!brand) return "not an answer";
    const outcome = await proposeContentChange(userId, phone, q.sku, { brand });
    // A brand Jumia doesn't have: they can send it again.
    if (outcome === "brand unknown" || outcome === "brand forbidden") {
      await updateSession(phone, { assistantPending: { ...q, at: new Date().toISOString(), ...(q.keep ? { asked: outcome === "brand unknown" ? "isn't a brand on Jumia" : "isn't allowed in this product's category" } : {}) } });
    }
    return outcome;
  }
  if (q.about === "weight") {
    const w = parseWeightKg(t);
    if (!w || (!reply && !/\b(weigh\w*|kg|kgs|kilo\w*|g|grams?)\b/i.test(t))) return "not an answer";
    if ("unit" in w) {
      const again = `Is that ${w.unit} g or ${w.unit} kg? Reply with the unit, e.g. "${w.unit} g".`;
      await updateSession(phone, { assistantPending: { ...q, at: new Date().toISOString(), ...(q.keep ? { asked: again } : {}) } });
      await sendTextIfConfigured(phone, again);
      return "again";
    }
    return proposeContentChange(userId, phone, q.sku, { details: { [q.field ?? "product_weight"]: w.kg } });
  }
  if (q.about === "warranty") {
    if (!reply || t.length < 3 || t.length > 300) return "not an answer";
    const attrs = q.category != null ? await getCategoryAttributes(q.category).catch(() => []) : [];
    const w = warrantyAnswer(t, attrs);
    const req: ContentRequest = { appendDescription: `<p><strong>Warranty:</strong> ${escapeHtml(w.line)}</p>` };
    if (Object.keys(w.details).length > 0) req.details = w.details;
    return proposeContentChange(userId, phone, q.sku, req);
  }
  // A number Jumia asked for (an FDA registration number, a certificate):
  // only from the reply, never guessed out of another message.
  if (!reply || t.length < 2 || t.length > 300) return "not an answer";
  if (/fda|registration/i.test(q.fieldLabel) && !/\d/.test(t)) return "not an answer";
  const value = valueFromReply(t);
  return proposeContentChange(userId, phone, q.sku, q.field
    ? { details: { [q.field]: value.slice(0, 200) } }
    : { appendDescription: `<p><strong>${escapeHtml(q.fieldLabel)}:</strong> ${escapeHtml(value.slice(0, 200))}</p>` });
}

/**
 * A message while a rejected product's question is open (QcLiveAsk): true
 * when it was the answer and was handled. A tap, a question back or
 * anything else lets the question go, and the message is handled as usual.
 * One that stays open (`keep`) goes on waiting instead: see answerKeptQc.
 */
export async function answerQcLive(userId: string, phone: string, q: QcLiveAsk, text: string | undefined): Promise<boolean> {
  if (q.keep) return answerKeptQc(userId, phone, q, text);
  const t = (text ?? "").trim();
  await updateSession(phone, { assistantPending: null });
  if (!t || Date.now() - new Date(q.at).getTime() > QC_LIVE_TTL_MS) return false;
  if (/^(?!https?:)[a-z_]+:\S/i.test(t)) return false; // a tapped button
  if (STOP_RE.test(t)) {
    await sendTextIfConfigured(phone, `OK, I've left *${shorten(q.name, 60)}* as it is. Say "fix my rejected products" any time to come back to it.`);
    return true;
  }
  if (QUESTION_RE.test(t)) return false;
  const outcome = await applyQcAnswer(userId, phone, q, t, true);
  console.info(`[qc-chat] answer for ${q.sku}: ${outcome}`);
  return outcome !== "not an answer";
}

const STOP_RE = /^(cancel|stop|never ?mind|forget it|not now|leave it|later)\b/i;
/** A tap answering the chat's own question back (`answer:@<area>:<words>`). */
const ANSWER_TAP_RE = /^answer:/i;
const QUESTION_RE = /\?\s*$|^(what|which|why|how|who|where|when|can|could|do|does|did|should|is|are|show|list|fix|rewrite)\b/i;

/** Whether the question is still open. Pure. */
export function isQcOpen(q: QcLiveAsk, now = Date.now()): boolean {
  return now - new Date(q.at).getTime() <= (q.keep ? QC_LIVE_KEEP_MS : QC_LIVE_TTL_MS);
}

/**
 * Whether the question is still open after answerQcLive let the message go
 * on: one that stays open (`keep`), unless it expired or a button was
 * tapped. Pure.
 */
export function keptQc(q: QcLiveAsk, text: string | undefined, now = Date.now()): boolean {
  const t = (text ?? "").trim();
  return !!q.keep && isQcOpen(q, now) && (ANSWER_TAP_RE.test(t) || !/^(?!https?:)[a-z_]+:\S/i.test(t));
}

/**
 * The question that stays open (owner's web chat, 2026-10-12 17:06: "That
 * is the weight listed" let it go, and five messages later the weight was
 * still being asked). It closes when it's answered, on stop, on a tapped
 * button, when its change is offered, or after QC_LIVE_KEEP_MS.
 *
 * A message is read here, word by word, only as the reply to the question
 * itself: while the bot's last message is it, or the agent's own question
 * back about it (isTheQuestion). Anything else goes to the agent with the
 * question open, which can still call the change for this product; so
 * "yes" to another offer, "make it 5" about another product's stock or
 * "stop the sale on the kettle" are never taken as this question's answer
 * (reviewing step 2).
 */
async function answerKeptQc(userId: string, phone: string, q: QcLiveAsk, text: string | undefined): Promise<boolean> {
  const t = (text ?? "").trim();
  if (!isQcOpen(q)) {
    await updateSession(phone, { assistantPending: null });
    return false;
  }
  if (!t) return false; // a photo: the question waits
  // A tap on the agent's own question back is read by the agent, with this question.
  if (ANSWER_TAP_RE.test(t)) return false;
  if (/^(?!https?:)[a-z_]+:\S/i.test(t)) {
    await updateSession(phone, { assistantPending: null });
    return false;
  }
  const bot = await lastBotMessage(phone);
  if (!bot || !isTheQuestion(q, bot.body)) return false;
  if (STOP_ONLY_RE.test(t)) {
    await updateSession(phone, { assistantPending: null });
    await sendTextIfConfigured(phone, `OK, I've left *${shorten(q.name, 60)}* as it is. Say "fix my rejected products" any time to come back to it.`);
    return true;
  }
  if (QUESTION_RE.test(t)) return false;
  // "Yes", "that's right", "update it": what Jumia has now, sent back for it to check again.
  if (isAgreement(t)) {
    if (q.ask !== "value" || !q.current) return false;
    await updateSession(phone, { assistantPending: null });
    const outcome = await proposeContentChange(userId, phone, q.sku, q.field
      ? { details: { [q.field]: q.current } }
      : { appendDescription: `<p><strong>${escapeHtml(q.fieldLabel)}:</strong> ${escapeHtml(q.current)}</p>` });
    console.info(`[qc-chat] agreed for ${q.sku}: ${outcome}`);
    return true;
  }
  if (chatOnly(t)) return false;
  await updateSession(phone, { assistantPending: null });
  const outcome = await applyQcAnswer(userId, phone, q, t, true);
  console.info(`[qc-chat] answer for ${q.sku}: ${outcome}`);
  if (outcome !== "not an answer") return true;
  await updateSession(phone, { assistantPending: q });
  return false;
}

/** "stop", "cancel", "never mind" as the whole message. */
const STOP_ONLY_RE = /^(?:cancel|stop|never ?mind|forget it|not now|leave it|later)[\s.!]*$/i;

const flat = (t: string) => t.toLowerCase().replace(/[*_~]/g, "").replace(/\s+/g, " ").trim();

/**
 * Whether the bot's last message is the question: its own words (`asked`),
 * or the agent's question back about it (marked when sent: markQcAsked).
 * Pure.
 */
export function isTheQuestion(q: Pick<QcLiveAsk, "asked">, bot: string): boolean {
  const asked = flat(q.asked ?? "").slice(0, 80);
  return asked.length >= 12 && flat(bot).includes(asked);
}

/** Whether a question is about the field this one asks for (the weight, the brand, the FDA number…). Pure. */
export function askedAbout(q: Pick<QcLiveAsk, "ask" | "about" | "fieldLabel">, bot: string): boolean {
  const b = bot.toLowerCase();
  if (q.ask === "brand") return /\bbrand/.test(b);
  if (q.about === "weight") return /weigh|\bkg\b/.test(b);
  if (q.about === "warranty") return /warrant/.test(b);
  if (/fda|registration/i.test(q.fieldLabel)) return /fda|registration/.test(b);
  return b.includes(q.fieldLabel.toLowerCase());
}

/**
 * The agent's question back about the open question (a clarify on its
 * field, while it's open) becomes the question a reply answers. Best-effort.
 */
export async function markQcAsked(phone: string, pending: unknown, question: string): Promise<void> {
  const q = pending as QcLiveAsk | null;
  if (!q || q.kind !== "qc_live" || !q.keep || !isQcOpen(q) || !askedAbout(q, question)) return;
  await updateSession(phone, { assistantPending: { ...q, asked: question.slice(0, 300) } }).catch(() => undefined);
}

/** Words that are chat, not a value or a brand: "ok thanks", "no", "that's the brand", "it's wrong". */
const CHAT_WORDS = new Set([
  "ok", "okay", "k", "thanks", "thank", "thx", "tnx", "you", "u", "so", "much", "a", "lot", "noted", "great", "cool", "nice", "alright", "fine",
  "no", "nope", "not", "wrong", "that", "thats", "this", "it", "its", "is", "the", "brand", "weight", "number", "one", "right", "correct",
  "yes", "yeah", "same", "good", "well", "done", "very", "i", "see", "got", "understood", "sure", "please", "pls",
]);
/** Only chat words. Pure. */
export function chatOnly(text: string): boolean {
  const words = text.toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  return words.length > 0 && words.every((w) => CHAT_WORDS.has(w));
}

/** Words that carry no yes or no of their own: "update it for me on my Jumia shop" is "update". */
const AGREE_FILLER = new Set(["please", "pls", "plz", "for", "me", "now", "again", "back", "on", "my", "jumia", "shop", "it", "its", "is", "the", "that", "thats", "this", "as", "just", "then", "and", "so", "to", "there", "fine", "go", "ahead", "do", "with", "value", "one"]);
const AGREE_WORDS = ["yes", "yeah", "yea", "ya", "yep", "yup", "ok", "okay", "sure", "correct", "right", "same", "keep", "send", "resend", "update", "use", "exactly", "true", "confirm", "confirmed", "good"];
const squeeze = (w: string) => w.replace(/(.)\1+/g, "$1");
const SQUEEZED = new Set(AGREE_WORDS.map(squeeze));

/** One edit apart (a typo): "updte", "corect". Pure. */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Agreeing with what Jumia has now: "yes", "that's right", "it is correct",
 * "same", "keep it", "update it for me on my Jumia shop", typos and all.
 * Every word must agree or be filler: "yes but 0.1" and "that is the weight
 * listed" don't. A question ("is that correct?") isn't agreeing. Pure.
 */
export function isAgreement(text: string): boolean {
  if (QUESTION_RE.test(text.trim())) return false;
  const words = text.toLowerCase().replace(/[’']/g, "").split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0 || words.length > 12) return false;
  const core = words.filter((w) => !AGREE_FILLER.has(w));
  if (core.length === 0) return false;
  return core.every((w) => {
    const s = squeeze(w);
    if (SQUEEZED.has(s)) return true;
    // A typo of a long word only: "right" is one letter from "night", "light", "eight".
    return s.length >= 5 && Array.from(SQUEEZED).some((a) => a.length >= 6 && oneEditApart(s, a));
  });
}

/** A tap on the rejected list (`qcfix:<sku>`), or null when it isn't one. Cheap: no I/O. */
export function parseFixTap(text: string | undefined): string | null {
  const m = (text ?? "").trim().match(/^qcfix:(\S{1,190})$/i);
  return m ? m[1] : null;
}
