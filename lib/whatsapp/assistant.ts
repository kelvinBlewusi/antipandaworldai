/**
 * The assistant: free text understood by AI, carried out by our own code.
 * Since 2026-10-07 it reads every typed message first, for every seller, on
 * WhatsApp and the website (owner: "any reply or text to the bot is taken
 * afresh and the previous context is taken into consideration too";
 * lib/whatsapp/intake.ts handleLinkedMessage). So:
 *
 *   - It's told where the seller is (Stage), the bot's open question, the
 *     batch's products, the seller's facts, the last 20 messages and what it
 *     remembers of them (lib/whatsapp/seller-memory.ts), as context, never
 *     as a limit: a message may be about the current step, a draft, an
 *     earlier product, a live product, the shop, PandaWorld or something new.
 *   - What carries on the current step (an answer to the bot's question, a
 *     product's notes while its photos come in) it hands back as "step",
 *     and the usual handling takes it, as before. So does anything when the
 *     AI can't be reached.
 *   - Taps, plain numbers, a command's own words, "done" and a plain "2:
 *     price 150" never reach it (aiReadable in intake.ts): they mean one
 *     thing. Nor do messages while connecting Jumia (codes).
 *   - The AI only picks an action (agent mode, lib/assistant-v2/agent.ts,
 *     or the front door when the agent can't): our code checks every part
 *     of it and does the work, with the same rules as the rest of the bot.
 *     Every price, quantity and word it sets must be in the seller's own
 *     message (a variation may also be one of the category's options, so
 *     "Large" can become "L"), and a price under Jumia's minimum is refused.
 *   - When a change could be about more than one product ("change the
 *     quantity of the fridge to 20" with two fridges), it asks which,
 *     and the tap or the number applies it (answerPendingQuestion).
 *   - Submitting, starting over and changing live products are offered as a
 *     button to tap, never done on the AI's word alone.
 *   - Anything else gets the AI's own reply, not a set message: what it can
 *     do for this seller (from capabilities() and their pack, credits and
 *     country), an answer to a question about Jumia or PandaWorld, or "I
 *     don't understand that, try something different" for what's outside
 *     them. Links come only from assistantLinks, as a button; a web address
 *     it writes itself is removed.
 *
 * Every message it reads goes in whatsapp_assistant_log with what it made
 * of it, to see where it misunderstands. Calls are counted in ai_usage as
 * the "assistant" feature.
 */

import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { availableCredits, isUnmetered, listingCreditCost } from "@/lib/billing/extension-credits";
import { LABEL_CREDIT_COST, LIVE_CHANGE_CREDIT_COST, LIVE_LISTING_CREDIT_COST, NOTICE_CREDIT_COST, POLISH_CREDIT_COST, REPORT_CREDIT_COST } from "@/lib/billing/credit-packs";

/** Image polish makes four photos (lib/gemini-image.ts PRODUCT_SHOTS). */
const PRODUCT_SHOT_COUNT = 4;
import { creditReach } from "@/lib/billing/credit-status";
import { checkRestrictedBrand } from "@/lib/jumia/prohibited-catalog";
import { priceMinimumForUser, isBelowMinimum, money } from "@/lib/jumia/price-minimums";
import {
  sendButtonsIfConfigured, sendCtaUrlIfConfigured, sendListIfConfigured, sendTextIfConfigured,
} from "@/lib/whatsapp/client";
import {
  COUNT_QUICK_PICKS, MAX_BATCH_SIZE, buyCreditsUrl, extractDateRange, extractSalePrice, findDateIn, focusedEditorUrl, whatsappListingsUrl,
} from "@/lib/whatsapp/batch";
import { sendHelp } from "@/lib/whatsapp/help";
import { appUrl } from "@/lib/whatsapp/app-url";
import { CHROME_WEB_STORE_URL, COMMUNITY_WHATSAPP_URL } from "@/lib/constants/support";
import { jumiaCountryByCode } from "@/lib/marketing/countries";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";
import { getJumiaConnectionKind } from "@/lib/jumia/credentials";
import { currentPack, featureAccess, featureMinPackName, type FeatureId } from "@/lib/billing/features";
import {
  BULK_MAX, BULK_PARTS_MAX, MAX_GROUP, answerFees, answerListings, answerOrderStatus, answerPayouts, answerProductInfo, answerProductText, answerProducts,
  answerSales, answerStock, htmlToText, sendLong,
  proposeAddSize, proposeBulkChange, proposeContentChange, proposeLiveChange, type AddSizeRequest, type BulkScope, type ContentRequest,
} from "@/lib/whatsapp/shop";
import { fixRejected } from "@/lib/whatsapp/fix-rejected";
import {
  answerBrand, answerCategoryNeeds, answerLinkedShops, answerPayoutDetail, answerReport, answerWarehouseStock, proposeWarehouseOrder,
  proposeWarehouseShipped, type ReportKind,
} from "@/lib/whatsapp/shop-insights";
import { shopProducts, type LiveChange, type ShopProduct } from "@/lib/jumia/shop";
import { answerResearch, parseNeeds, type ResearchNeed } from "@/lib/whatsapp/shop-research";
import { cannotAnswer, capability, capabilityAnswer } from "@/lib/jumia/capabilities";
import { INTERACTIVE_BODY_MAX, splitForText } from "@/lib/whatsapp/text-limits";
import { assistantGate, assistantSwitchedOn } from "@/lib/whatsapp/assistant-limits";
import { blankCodes, noteSellerMessage, sellerMemory } from "@/lib/whatsapp/seller-memory";
import { isWebAddress } from "@/lib/whatsapp/channel";
import { chatClearedAt } from "@/lib/whatsapp/chat-clear";
import { handleOrderMessage } from "@/lib/whatsapp/orders";
import { resetSession, updateSession, type AssistantPending, type LiveValueAsk, type WhatsAppSession } from "@/lib/whatsapp/session";
import { parseVariations, saveVariations, sizeNamedIn, variationOptions, VARIATION_FIELD } from "@/lib/whatsapp/variation-question";
import { carryPriceToVariants, carrySaleToVariants, carryStockToVariants, chatPrice, shopCurrencyForUser } from "@/lib/whatsapp/listing-edits";
import type { ListingRow } from "@/lib/supabase/types";
import {
  FRONT_DOOR_LIMITS, FRONT_DOOR_ROUTER, frontDoor, namesInMessage, type Clarify, type FrontDoorInput,
} from "@/lib/assistant-v2/front-door";
import { agentModelSpec, agentRead, agentSystem, catalogLookups, geminiAgentCall } from "@/lib/assistant-v2/agent";

/** Small and quick, like the review step's older fallback (lib/whatsapp/intent.ts). */
export const ASSISTANT_MODEL = "gemini-2.5-flash-lite";

/** A "which product?" question older than this is no longer an answer's target. */
const PENDING_TTL_MS = 30 * 60_000;

/** The products the bot listed for them in the last 30 minutes, for "those" and "the last 10". */
function listedFresh(session: WhatsAppSession): { count: number; what: string } | null {
  const l = session.lastListed;
  if (!l || l.sids.length === 0 || Date.now() - new Date(l.at).getTime() > PENDING_TTL_MS) return null;
  return { count: l.sids.length, what: l.what };
}

/** Statuses a product can still be changed in chat: not sent yet, or held. */
const EDITABLE = new Set(["draft", "awaiting_review", "failed"]);

// ─── Who has it ───────────────────────────────────────────────────────────

/**
 * Every seller, on WhatsApp and the website (owner, 2026-10-07: "AI for all
 * sellers"; the pilot list, app_settings `assistant_users`, is gone). Only
 * the kill switch (lib/whatsapp/assistant-limits.ts) turns it off, for
 * everyone, admins included.
 */
export async function assistantEnabled(_userId: string): Promise<boolean> {
  return assistantSwitchedOn();
}

/** Whether the assistant reads this message (both channels, everyone, unless switched off). */
export async function assistantFor(userId: string, _phone: string): Promise<boolean> {
  return assistantEnabled(userId);
}

/**
 * Whether this seller's messages are read by agent mode
 * (lib/assistant-v2/agent.ts: one call with every action as a tool, lookups
 * of their products first when needed, up to three actions a message).
 * app_settings `assistant_agent`: "all", "admins" (the pilot, owner
 * 2026-10-10), or a list of user ids. Off without the row. When it fails,
 * the front door reads the message instead.
 */
export async function agentFor(userId: string): Promise<boolean> {
  return switchedOnFor("assistant_agent", userId);
}

/** An app_settings switch: "all", "admins", or a list of user ids. Off without the row or on error. */
async function switchedOnFor(key: string, userId: string): Promise<boolean> {
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", key).maybeSingle();
    const v = data?.value as unknown;
    if (v === "all") return true;
    if (v === "admins") return isAdmin(userId);
    return Array.isArray(v) && v.includes(userId);
  } catch {
    return false;
  }
}

// ─── What the AI is told ──────────────────────────────────────────────────

/**
 * Where the seller is: context for the AI, never a limit on what a message
 * can be about. review: drafts waiting to be submitted. sent: the whole
 * batch just went to Jumia. idle: between batches. starting: a batch was
 * just started and no photo has come yet. collecting: a batch's photos and
 * notes are coming in. drafting: the batch is being drafted.
 */
export type Stage = "review" | "sent" | "idle" | "starting" | "collecting" | "drafting";

export interface ProductFacts {
  seq:        number;
  listing:    ListingRow;
  variations: string[];
  /** The category's variation options (sizes, capacities...), empty when it takes any text. */
  options:    string[];
}

/** A change to one product, as checked: only what the seller asked for. */
export interface Changes {
  price?:      number;
  quantity?:   number;
  /** The full list the product should have afterwards, in the seller's words or the category's options. */
  variations?: string[];
  title?:      string;
  brand?:      string;
  color?:      string;
  /** A sale price: read from the message itself, with its dates (extractSalePrice). */
  sale?:       boolean;
  /** Something they want changed that chat can't change: sent to the editor. */
  other?:      string;
}

export interface EditPart {
  seqs:    number[];
  changes: Changes;
  /** The seller's words could mean any of `seqs`: asked which. */
  ask:     boolean;
}

export type AssistantAction =
  | { type: "edit"; edits: EditPart[]; dropped: string[] }
  | { type: "submit"; seqs: number[] | "all" }
  | { type: "list"; count: number }
  | { type: "restart" }
  | { type: "review" }
  | { type: "orders" }
  | { type: "credits" }
  | { type: "help" }
  /** `awaiting`: the reply asks for a live product's new stock or price, so a bare number next answers it. */
  | { type: "reply"; text: string; link: string | null; awaiting?: { field: "stock" | "price"; products: string[]; fromContext?: boolean } }
  /** `others`: more products for the same change (one tap, one feed); `all`: every product their words fit. */
  | { type: "live_change"; product: string; change: LiveChange; fromContext?: boolean; others?: string[]; all?: boolean }
  | { type: "product_info"; product: string }
  | { type: "product_text"; product: string }
  /** Drafts' own text as drafted (name, price, sizes, highlights, description), from the listing rows. */
  | { type: "draft_text"; seqs: number[] }
  /** Products Jumia's quality check rejected: the list (no product), or one's fix; `reason` is Jumia's, pasted by the seller. */
  | { type: "fix_rejected"; product: string | null; reason: string | null }
  /** A new size (or colour) for a live product, with its stock and price (lib/whatsapp/shop.ts proposeAddSize). */
  | { type: "add_size"; product: string; request: AddSizeRequest }
  /** More photos for a live product, sent next (lib/whatsapp/live-photos.ts). */
  | { type: "add_photos"; product: string }
  | { type: "fees"; product: string; price: number | null }
  | { type: "stock"; product: string | null; filter: "out" | "low" | null }
  | { type: "shop"; filter: "all" | "inactive" | "rejected" }
  | { type: "order_status"; number: string }
  /** One status ("CANCELED"), or several (["READY_TO_SHIP", "CANCELED"]). */
  | { type: "sales"; period: Period; status: string | string[] | null }
  | { type: "listings"; period: Period }
  | { type: "payouts" }
  /** Their statements one line each, or one in detail (fees, refunds). */
  | { type: "payout_detail"; mode: "history" | "breakdown"; statement: string | null }
  | { type: "report"; kind: ReportKind; period: Period }
  /** One change to every product a rule picks ("10% off all perfumes"). */
  | { type: "bulk"; scope: BulkScope; words: string | null; change: LiveChange }
  /** A live product's name, description, highlights or brand. */
  | { type: "content_change"; product: string; request: ContentRequest }
  | { type: "brand_check"; brand: string; product: string | null }
  | { type: "category_info"; product: string }
  | { type: "shops" }
  | { type: "warehouse_stock"; product: string }
  | { type: "warehouse_order"; items: { product: string; quantity: number }[]; date: string | null }
  | { type: "warehouse_shipped"; po: string; tracking: string; carrier: string | null }
  /** The chat's billed commands (owner, 2026-10-07): run when asked, charged when they run. */
  | { type: "polish"; seq: number | null }
  | { type: "health_report" }
  /** Several reads of their shop, answered together as asked (lib/whatsapp/shop-research.ts). */
  | { type: "research"; needs: ResearchNeed[] }
  | { type: "note" }
  /**
   * Something PandaWorld doesn't do (owner, 2026-10-11: "tell the user it can
   * not do that yet"): a fixed answer, and the request noted on the wish list
   * (assistant_wishes, /admin/wishes). `outside`: nothing to do with Jumia or
   * PandaWorld, answered but not noted. `text`: a fixed answer of its own (a
   * capability not built yet). `blocked`: the AI's own reply that said it
   * can't, stopped (claimsInability).
   */
  | { type: "not_yet"; what: string; outside: boolean; text?: string; blocked?: string }
  | { type: "unclear" };

/** "quarter" is the last 90 days: as far back as Jumia's orders go. */
export type Period = "today" | "yesterday" | "week" | "month" | "quarter";
const PERIODS = new Set<Period>(["today", "yesterday", "week", "month", "quarter"]);
const asPeriod = (v: unknown, fallback: Period): Period => (PERIODS.has(v as Period) ? (v as Period) : fallback);

/** The order statuses a seller can ask about, as Jumia names them. */
const ORDER_STATUSES: Record<string, string> = {
  cancelled: "CANCELED", canceled: "CANCELED", cancel: "CANCELED", delivered: "DELIVERED", returned: "RETURNED", returns: "RETURNED",
  return: "RETURNED", failed: "FAILED", failed_delivery: "FAILED", pending: "PENDING", shipped: "SHIPPED", ready_to_ship: "READY_TO_SHIP",
  ready: "READY_TO_SHIP", rts: "READY_TO_SHIP",
};

/** An order status in the seller's or the AI's words ("cancelled", "ready to ship") as Jumia names it. */
const asOrderStatus = (v: unknown) => (typeof v === "string" ? ORDER_STATUSES[v.toLowerCase().trim().replace(/[\s-]+/g, "_")] ?? null : null);

/**
 * What PandaWorld does, for the AI's replies: every line is something the
 * code does (lib/whatsapp/intake.ts, orders.ts, credit-gate.ts, the
 * extension), so the AI never promises what isn't there.
 */
export function capabilities(listingCost = LIVE_LISTING_CREDIT_COST): string {
  return [
    `- List products on Jumia from WhatsApp: the seller says how many (1 to ${MAX_BATCH_SIZE}), sends each product's photos with the price and notes as the caption, and AI drafts each listing (name, description, category, details) for them to check and submit. Two ways to send: all at once, or guided step by step.`,
    "- Ask for what Jumia needs that the photos don't show: a missing price, weight or other required detail, the variation, the category when unsure.",
    "- Show drafts in chat as drafted (name, price, sizes, highlights, description), and edit them before they're submitted: price, quantity, variations or sizes, name, brand, colour, a sale price with its dates. Anything else in the editor on the review page.",
    "- Chatting is free on every pack. Every pack, free credits included: listing, orders (see, pack, ready to ship, cancel), reading their shop (products, stock, sales, reports, payouts, fees), image polish and the shop health report; only the commands below that cost credits are charged. Only these need a pack: changes to live Jumia products from the chat, Jumia QC rejection alerts and guided fixes and shipping label PDFs on WhatsApp (Standard and up); order alerts on WhatsApp and the extension's fee calculator (Pro and up). Everything pauses at 0 credits.",
    "- Submit to Jumia and report back when each product goes live or is rejected; fix common rejections itself (banned words, restricted brands) and guide the seller through the rest with Fix & resubmit. After Jumia accepts a listing, its quality-check verdict is followed up (and the credits returned if QC rejects it) with the Standard pack and up.",
    "- Orders: \"orders\" shows orders waiting to be packed; pack them, mark them ready to ship, or cancel, here or on WhatsApp; where any order is, by its number; orders and sales for today, the week, the month or 90 days. Shipping label PDFs only on WhatsApp (Standard pack and up). Pro and up also: alerts for new Jumia orders on WhatsApp, grouped and quiet at night, and a message when orders are delivered, returned, fail delivery or are cancelled.",
    `- Their live Jumia products, found by name among everything in their shop: change a product's stock, price, a sale price with its dates, end its sale, or turn it on or off, for one product or several named together (up to ${MAX_GROUP}). One product's stock, ON/OFF or ending its sale is done straight away when they name it; a price, a sale, a product taken from the conversation, or several products wait for one tap to confirm; where a product is (on or off, Jumia's quality check, price, sale, stock); how many are left; what's out of stock or low; which products are turned off or rejected by Jumia's quality check.`,
    `- Rules for many products at once, shown in full before one tap: prices up or down by a percentage, a sale a percentage off (with dates), a stock or price, ending sales, turning on or off; for all their products, the ones out of stock, low, off or on, or all that match words ("all perfumes"); up to ${BULK_MAX} products per tap, and a bigger rule in parts of ${BULK_MAX}, one tap each (up to ${BULK_MAX * BULK_PARTS_MAX}).`,
    "- A live product's name, description and highlights shown as Jumia has them now (product_text). Changing them, or the brand: the seller's own text, or rewritten by AI from what Jumia has now with their instructions (\"remove the word X from the name\"), shown before one tap. Also its other details (colour, material, weight, model and whatever its category takes, checked against Jumia's options), its barcode, or a size's name. Jumia checks content changes again. More photos after its main one (add_photos: they send them, then Done, and they go to Jumia), and a new size or colour with its own stock and price (add_size: one tap; Jumia's quality check looks at it like a new product). Its main photo and category are changed in Vendor Center.",
    "- Reports: best sellers, products with no sale, what runs out soon at the rate it sells, returns and failed deliveries, for the last 7, 30 or 90 days.",
    "- Products rejected by Jumia's quality check: which ones, with Jumia's reason when its API gives one (often it doesn't: then the reason is only in Vendor Center, never guessed). Fixing them (fix_rejected): one listed through PandaWorld gets its Fix & resubmit (redrafted, or the seller asked for what only they know, and sent again); one listed another way gets a rewritten name or description, a brand or a detail from the seller, shown before one tap, and Jumia checks it again. Its category, main photo or price before approval can't change through Jumia's API: those are changed in Vendor Center, or it is listed again here.",
    "- Payouts: the last Jumia payout and the statement not yet paid; every statement of the last 90 days; one statement's fees, refunds and balances. A message when Jumia pays: Pro and up.",
    "- Lists of products show up to 30 at a time, so a message stays readable on a phone; \"more\" shows the next 30. The shop overview also counts the products deleted on Jumia.",
    "- What PandaWorld keeps itself: every product listed through it (from WhatsApp, the website or the extension), with its status and date; the chat's own history of the last messages.",
    "- Questions that need several reads of their shop, answered together the way they ask: the last products they uploaded (with price, variations, stock, on or off, quality check, date added), products sorted or filtered (by price, stock, on sale, rejected, matching words), orders with what was in them, sales by product, payout statements, what they listed with PandaWorld; read from Jumia just now, free.",
    "- Before listing: whether a brand is on Jumia and allowed in a category; what a kind of product needs on Jumia (its category, the details asked, variation options, commission).",
    "- The shops under their Jumia account. Jumia's warehouse (for sellers who stock it): what it holds of a product, a delivery order into it (products and quantities, with a tap), and telling Jumia one has shipped with its tracking number.",
    "- Fees: what Jumia takes when one of their products sells (commission for its category, the per-item shipping contribution) and what they receive, at its price or a price they give.",
    `- Credits: tell the balance; a WhatsApp listing or an extension autofill costs ${listingCost} credits for this seller, a listing charged only when it goes live on Jumia; a shipping label ${LABEL_CREDIT_COST} credits (the same label again is free), a change to live products ${LIVE_CHANGE_CREDIT_COST} (back if Jumia refuses it), an order-updates message ${NOTICE_CREDIT_COST}; new-order alerts, payout messages and chatting are free (no limit on chatting); warn when running low. Credits are bought on the dashboard.`,
    "- The PandaWorld Chrome extension fills Jumia's Vendor Center product form on a laptop; image polish and a fee calculator in it on Pro.",
    "- A free Jumia price calculator, Jumia commission rates, how-to guides and an FAQ on the website.",
    `- Image polish: ${PRODUCT_SHOT_COUNT} product photos made from the seller's own (main on white, angle, lifestyle, detail), ${POLISH_CREDIT_COST} credits each, for a product being listed (\"polish 2\"), or by itself when the product's note asks for polished photos. They go first on the listing, the seller's own after.`,
    `- The shop health report: a full check of their shop from live Jumia data, a score out of 100, what's working, what isn't and what to do, ${REPORT_CREDIT_COST} credits.`,
    "- Commands (type / in the Listing Assistant or tap +; \"menu\" on WhatsApp): orders, sales today, sales week, shop, out of stock, payouts, report, polish and a product number, credits, status, restart, how it works, disconnect. Only polish, the report and changes to live products cost credits; chatting and everything else is free.",
    "- Words the bot always knows: \"status\" (where they are), \"restart\", \"help\", \"menu\", \"orders\", \"disconnect\" (Jumia).",
  ].join("\n");
}

/** A page the assistant can send as a button. */
export interface AssistantLink { label: string; url: string; what: string }

/**
 * The only links the assistant sends ("send me the link to your home
 * page", owner 2026-10-06). It picks one by key and the seller gets a
 * button; a web address it writes itself is removed (cleanReply).
 */
export function assistantLinks(opts: { batchId?: string | null; countrySlug?: string | null } = {}): Record<string, AssistantLink> {
  const base = appUrl();
  return {
    home:            { label: "Home page",         url: `${base}/`, what: "PandaWorld's home page" },
    pricing:         { label: "Credit packs",      url: `${base}/pricing`, what: "credit packs and what each one includes" },
    dashboard:       { label: "Dashboard",         url: buyCreditsUrl(), what: "their dashboard: credits, buying credits, notices" },
    assistant:       { label: "Listing Assistant", url: `${base}/extension/assistant`, what: "the Jumia Listing Assistant: this chat on the website" },
    listings:        { label: "Autofill activity", url: `${base}/extension/listings`, what: "the products the Chrome extension autofilled" },
    calculator_app:  { label: "Calculator",        url: `${base}/extension/calculator`, what: "the fee calculator in their dashboard" },
    connect_jumia:   { label: "Connect Jumia",     url: `${base}/onboarding/connect`, what: "the page to connect their Jumia account" },
    review:          { label: "Review listings",   url: whatsappListingsUrl(opts.batchId ?? undefined), what: opts.batchId ? "this batch's drafts, to check and edit" : "their WhatsApp drafts" },
    settings:        { label: "Settings",          url: `${base}/extension/settings`, what: "settings: the Jumia connection, WhatsApp, the API key" },
    faq:             { label: "FAQ",               url: `${base}/faq`, what: "frequently asked questions" },
    guides:          { label: "How-to guides",     url: `${base}/how-to`, what: "all the step-by-step guides" },
    guide_whatsapp:  { label: "WhatsApp guide",    url: `${base}/how-to/list-on-jumia-from-whatsapp`, what: "how to list from WhatsApp, with an example" },
    guide_connect:   { label: "Connect guide",     url: `${base}/how-to/connect-jumia-vendor-center`, what: "how to connect Jumia Vendor Center" },
    guide_link_whatsapp: { label: "Link WhatsApp guide", url: `${base}/how-to/link-whatsapp`, what: "how to link a WhatsApp number" },
    guide_extension: { label: "Extension guide",   url: `${base}/how-to/chrome-extension-autofill`, what: "how to list from a laptop with the extension" },
    extension:       { label: "Get the extension", url: CHROME_WEB_STORE_URL, what: "the PandaWorld Chrome extension on the Chrome Web Store" },
    calculator:      { label: "Price calculator",  url: `${base}/jumia-price-calculator`, what: "Jumia selling price and fee calculator" },
    commission:      { label: "Commission rates",  url: `${base}/jumia-commission-rates`, what: "Jumia's commission rates by category" },
    ...(opts.countrySlug ? { country: { label: "Selling on Jumia", url: `${base}/sell-on-jumia/${opts.countrySlug}`, what: "selling on Jumia in their country" } } : {}),
    vendor_center:   { label: "Vendor Center",     url: "https://vendorcenter.jumia.com", what: "Jumia Vendor Center, only with an answer from Not possible from here" },
    privacy:         { label: "Privacy policy",    url: `${base}/privacy`, what: "privacy policy" },
    terms:           { label: "Terms",             url: `${base}/terms`, what: "terms of service" },
    community:       { label: "Community group",   url: COMMUNITY_WHATSAPP_URL, what: "PandaWorld's community WhatsApp group" },
  };
}

/** What's true for this seller: their pack, what it gives them, their credits and country. Best-effort. */
export async function sellerFacts(userId: string): Promise<{ lines: string[]; countrySlug: string | null }> {
  const lines: string[] = [];
  let countrySlug: string | null = null;
  try {
    const country = jumiaCountryByCode(await sellerCountry(userId).catch(() => null));
    if (country) { lines.push(`- Country: ${country.name}`); countrySlug = country.slug; }
    const { data: conn } = await createServerClient().from("jumia_connections").select("store_name, seller_name").eq("user_id", userId).maybeSingle();
    const shopName = (conn as { store_name?: string | null; seller_name?: string | null } | null)?.store_name
      ?? (conn as { seller_name?: string | null } | null)?.seller_name;
    if (shopName) lines.push(`- Their Jumia shop: ${shopName}`);
    // What's connected, as it is: asked "is my WhatsApp connected?", the AI
    // said yes and made up the rest (owner's test, 2026-10-07).
    const [{ data: wa }, jumia] = await Promise.all([
      createServerClient().from("whatsapp_connections").select("phone_number").eq("user_id", userId).limit(1),
      getJumiaConnectionKind(userId).catch(() => null),
    ]);
    const waNumber = ((wa ?? []) as { phone_number: string | null }[])[0]?.phone_number ?? null;
    lines.push(waNumber ? `- WhatsApp: linked, number ${waNumber}` : "- WhatsApp: not linked (Settings → WhatsApp → Connect WhatsApp)");
    lines.push(
      jumia === "connected" ? `- Jumia: connected${shopName ? ` (${shopName})` : ""}`
        : jumia == null ? "- Jumia: couldn't check just now"
        : "- Jumia: not connected (Settings → Jumia, or paste the Client ID and token in the chat)",
    );
    if (await isUnmetered(userId)) {
      lines.push("- Not charged credits: every feature is on for them.");
      return { lines, countrySlug };
    }
    const pack = await currentPack(userId).catch(() => null);
    lines.push(pack ? `- Pack: ${capitalise(pack.id)} (the last one they bought)` : "- Pack: none bought yet, on their free sign-up credits (they have what every pack has).");
    const access = async (f: FeatureId) => {
      const a = await featureAccess(userId, f).catch(() => ({ ok: false as const, blockedBy: "pack" as const }));
      return a.ok ? "on" : a.blockedBy === "credits" ? "paused until they buy credits" : `not on their pack (${featureMinPackName(f)} and up)`;
    };
    // Every plan reads its shop and handles its orders (owner, 2026-10-07); live changes, QC, labels and the alerts need a pack.
    lines.push(`- The chat's shop features (products, orders, reports, payouts, fees): ${await access("shop_whatsapp")}`);
    lines.push(`- Changes to live Jumia products from the chat: ${await access("shop_changes")}`);
    lines.push(`- Jumia QC rejection alerts and guided fixes: ${await access("qc_fix")}`);
    lines.push(`- Shipping label PDFs on WhatsApp: ${await access("shipping_labels")}`);
    lines.push(`- Order alerts on WhatsApp (new orders, order updates, payouts): ${await access("order_alerts")}`);
    const credits = Math.max(0, Math.round((await availableCredits(userId)) * 100) / 100);
    lines.push(`- Credits: ${credits} available, ${creditReach(credits, await listingCreditCost(userId))}`);
    lines.push(...await activityFacts(userId));
  } catch (e) {
    console.warn(`[assistant] seller facts for ${userId}: ${(e as Error).message}`);
  }
  return { lines, countrySlug };
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const LISTING_WORDS: Record<string, string> = {
  live: "live on Jumia", pending_approval: "waiting for Jumia", processing: "waiting for Jumia", draft: "drafts not sent", awaiting_review: "drafts not sent", failed: "held or rejected",
};

/**
 * What they've done with PandaWorld (owner, 2026-10-10: "the chat should know
 * everything about the user's account, his activities"): what they listed
 * and where from (this website's chat or WhatsApp), their drafts not sent
 * yet with where each was made, the extension's autofills and the image
 * polishes they paid for. Best-effort: nothing on a failure.
 */
export async function activityFacts(userId: string, now = new Date()): Promise<string[]> {
  try {
    const db = createServerClient();
    const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
    const [{ data: listings }, { count: fills }, { data: lastFill }, { data: spends }] = await Promise.all([
      db.from("listings").select("title, status, chat_channel, created_at").eq("user_id", userId).gt("created_at", since).order("created_at", { ascending: false }).limit(500),
      db.from("extension_fill_events").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("mock", false),
      db.from("extension_fill_events").select("created_at").eq("user_id", userId).eq("mock", false).order("created_at", { ascending: false }).limit(1),
      db.from("extension_credit_transactions").select("amount, description, created_at").eq("user_id", userId).gt("created_at", since).limit(1000),
    ]);
    const rows = (listings ?? []) as { title: string | null; status: string; chat_channel: string | null; created_at: string }[];
    const out: string[] = [];
    if (rows.length > 0) {
      const web = rows.filter((r) => r.chat_channel === "web").length;
      const byStatus = new Map<string, number>();
      for (const r of rows) {
        const w = LISTING_WORDS[r.status] ?? r.status;
        byStatus.set(w, (byStatus.get(w) ?? 0) + 1);
      }
      out.push(`- Listed with PandaWorld in the last 90 days: ${rows.length} (${web} from this website's chat, ${rows.length - web} from WhatsApp); now ${Array.from(byStatus.entries()).map(([w, n]) => `${n} ${w}`).join(", ")}`);
      const unsent = rows.filter((r) => r.status === "draft" || r.status === "awaiting_review");
      if (unsent.length > 0) {
        out.push(`- Drafts not sent yet: ${unsent.slice(0, 5).map((r) => `"${(r.title ?? "untitled").slice(0, 50)}" (made on ${r.chat_channel === "web" ? "the website chat" : "WhatsApp"})`).join(", ")}${unsent.length > 5 ? ` and ${unsent.length - 5} more` : ""}`);
      }
    } else {
      out.push("- Listed with PandaWorld in the last 90 days: nothing yet");
    }
    const lastFillAt = ((lastFill ?? []) as { created_at: string }[])[0]?.created_at;
    out.push(`- The Chrome extension's autofills: ${fills ?? 0} in all${lastFillAt ? `, the last on ${lastFillAt.slice(0, 10)}` : ""}`);
    const tx = (spends ?? []) as { amount: number; description: string | null; created_at: string }[];
    const polishes = tx.filter((t) => /polish/i.test(t.description ?? "") && Number(t.amount) < 0);
    if (polishes.length > 0) {
      out.push(`- Image polishes in the last 90 days: ${polishes.length} charge${polishes.length === 1 ? "" : "s"}, ${Math.round(polishes.reduce((n, t) => n - Number(t.amount), 0) * 100) / 100} credits`);
    }
    const bought = tx.filter((t) => Number(t.amount) > 0 && /purchase|bought|pack/i.test(t.description ?? "")).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
    if (bought) out.push(`- Last credits bought: ${bought.created_at.slice(0, 10)}`);
    return out;
  } catch {
    return [];
  }
}

/**
 * Drafts not sent yet, from either chat, when this conversation has none of
 * its own: the newest such batch in 14 days, and where it was made. So
 * "change the gown's price to 150" or "submit them" on the website works for
 * drafts made on WhatsApp, and the other way round (owner, 2026-10-10).
 */
export async function openDraftBatch(userId: string, now = new Date()): Promise<{ batchId: string; channel: "web" | "whatsapp" } | null> {
  const { data } = await createServerClient().from("listings")
    .select("whatsapp_batch_id, chat_channel").eq("user_id", userId).in("status", ["draft", "awaiting_review"])
    .not("whatsapp_batch_id", "is", null).gt("created_at", new Date(now.getTime() - 14 * 86_400_000).toISOString())
    .order("created_at", { ascending: false }).limit(1);
  const row = ((data ?? []) as { whatsapp_batch_id: string | null; chat_channel: string | null }[])[0];
  return row?.whatsapp_batch_id ? { batchId: row.whatsapp_batch_id, channel: row.chat_channel === "web" ? "web" : "whatsapp" } : null;
}

// ─── Checking what the AI said ────────────────────────────────────────────

/** Every number written in the message: "1,500" is 1500, "2k" is 2000 (and 2). */
export function messageNumbers(text: string): number[] {
  const out: number[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,(?=\d{3}\b)/g, ""));
    if (!Number.isFinite(n)) continue;
    out.push(n);
    if (m[2]) out.push(n * 1000);
  }
  return out;
}

const squashSpaces = (s: string) => s.toLowerCase().replace(/[\s"'“”‘’]+/g, " ").trim();

/** Whether `value` is written in the message (any case, any spacing). */
export function saidInMessage(value: string, message: string): boolean {
  const v = squashSpaces(value);
  return v.length > 0 && squashSpaces(message).includes(v);
}

/** Whether `word` is a whole word of the message ("L" is not in "Large", "S" is not in "it's"). */
function wordInMessage(word: string, message: string): boolean {
  const w = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // An apostrophe joins a word only between letters: "it's", not "'Large'".
  return w.length > 0 && new RegExp(`(?<![\\p{L}\\p{N}])(?<![\\p{L}\\p{N}]['’])${w}(?![\\p{L}\\p{N}])(?!['’][\\p{L}\\p{N}])`, "iu").test(message);
}

/**
 * The changes, keeping only what the message backs up. `dropped` names
 * what the AI gave that the message doesn't say, so the seller can be
 * asked to say it plainly.
 */
export function verifyChanges(
  raw: unknown,
  message: string,
  known: { options: string[]; variations: string[] },
): { changes: Changes; dropped: string[] } {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const changes: Changes = {};
  const dropped: string[] = [];
  const numbers = messageNumbers(message);
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" ? parseFloat(v.replace(/,/g, "")) : NaN);

  if (r.price != null) {
    const n = num(r.price);
    if (n > 0 && numbers.includes(n)) changes.price = n; else dropped.push("price");
  }
  if (r.quantity != null) {
    const n = num(r.quantity);
    if (Number.isInteger(n) && n > 0 && numbers.includes(n)) changes.quantity = n; else dropped.push("quantity");
  }
  if (Array.isArray(r.variations)) {
    const lower = (xs: string[]) => xs.map((x) => x.toLowerCase());
    const isOption = (v: string) => known.options.find((o) => o.toLowerCase() === v.toLowerCase());
    const isCurrent = (v: string) => lower(known.variations).includes(v.toLowerCase());
    const backed: string[] = [];
    let given = 0;
    // At least one must come from this message: the product's current
    // variations alone are no change ("my message count so far" came back
    // as its sizes again, and was applied, 2026-10-08).
    let fromMessage = false;
    // The options each phrase of the seller's was read as.
    const read = new Map<string, { said: string; options: string[] }>();
    for (const item of r.variations) {
      if (typeof item === "string") {
        const w = item.trim().slice(0, 60);
        if (!w) continue;
        given++;
        // Written in the message, a size name for it ("Large" for "L"), or
        // one the product has (kept when adding). Being one of the
        // category's options isn't enough: the AI once sent all 54 of a
        // category's sizes for "Sizes: Large, Medium, Small" (owner's web
        // chat, 2026-10-07).
        const said = wordInMessage(w, message) || (isOption(w) != null && sizeNamedIn(w, message));
        if (said || isCurrent(w)) backed.push(w);
        fromMessage ||= said;
        continue;
      }
      if (!item || typeof item !== "object") continue;
      // {"said","option"}: the AI's reading of the seller's words as one of
      // the category's options ("free size" is One Size). The words must be
      // in the message (or be a current variation), the option on the list.
      const pair = item as Record<string, unknown>;
      const said = typeof pair.said === "string" ? pair.said.trim().slice(0, 60) : "";
      const option = typeof pair.option === "string" ? pair.option.trim().slice(0, 60) : "";
      if (!said && !option) continue;
      given++;
      // Whole words: "S" isn't in "message".
      const inMessage = wordInMessage(said, message) || (said.length >= 4 && saidInMessage(said, message));
      if (said === "" || !(inMessage || isCurrent(said))) continue;
      fromMessage ||= inMessage;
      if (known.options.length === 0) { backed.push(said); continue; }
      const match = isOption(option) ?? (isCurrent(option) ? option : null);
      if (!match) continue;
      const entry = read.get(said.toLowerCase()) ?? { said, options: [] };
      if (!entry.options.includes(match)) entry.options.push(match);
      read.set(said.toLowerCase(), entry);
    }
    // One phrase is one option, or one per item it lists ("Large, Medium,
    // Small"), or a few for a range ("S to XL"). Read as more, it's the AI
    // filling in: none of that phrase's options are kept.
    for (const { said, options } of Array.from(read.values())) {
      const parts = said.split(/\s*(?:,|;|&|\+|\band\b)\s*/i).filter(Boolean).length;
      const limit = /\bto\b|[-–]|\bthrough\b|\btill\b|\buntil\b|\ball\b/i.test(said) ? 8 : Math.max(1, parts);
      if (options.length <= limit || isCurrent(said)) backed.push(...options);
    }
    if (backed.length > 0 && fromMessage) changes.variations = Array.from(new Set(backed));
    else if (given > 0 && !(backed.length > 0)) dropped.push("variations");
  }
  for (const key of ["title", "brand", "color"] as const) {
    const v = r[key];
    if (typeof v !== "string" || !v.trim()) continue;
    if (saidInMessage(v, message)) { changes[key] = v.trim().replace(/\s+/g, " "); continue; }
    // "Colors: cream, black and brown" came back as "Beige, Black, Brown":
    // the seller's own words, from their "colour:" line, stand instead.
    const own = key === "color" ? colourLine(message) : null;
    if (own) changes.color = own;
    else dropped.push(key === "title" ? "name" : key === "color" ? "colour" : key);
  }
  if (r.sale === true) changes.sale = true;
  // A field's name ("material", "weight"), not a sentence: "Don't list this
  // again pls" once came back as the field to change.
  if (typeof r.other === "string" && r.other.trim() && r.other.trim().split(/\s+/).length <= 3) changes.other = r.other.trim().slice(0, 40);
  return { changes, dropped };
}

/** What follows "colour:" / "colors -" in the message, on its own line. */
function colourLine(message: string): string | null {
  const m = message.match(/\bcolou?rs?\s*[:=-]\s*([^\n]+)/i);
  const v = m?.[1]?.trim().replace(/[.!]+$/, "").replace(/\s+/g, " ").slice(0, 60);
  return v ? v : null;
}

/** The draft a phrase names by number ("product 3", "#2", "item 1"), when it's one of these. */
export function draftNumberIn(said: string, products: { seq: number }[]): number | null {
  const m = said.match(/\b(?:product|item|draft|no\.?|number)\s*#?\s*(\d{1,2})\b/i) ?? said.match(/^\s*#?(\d{1,2})\s*$/);
  const n = m ? Number(m[1]) : NaN;
  return products.some((p) => p.seq === n) ? n : null;
}

/** Whether the message is about a product's details at all: a number, or a field's name. */
function namesAField(message: string): boolean {
  return /\d/.test(message)
    || /\b(?:price|cost|cheaper|dearer|expensive|discount|sale|reduce|increase|lower|raise|colou?rs?|sizes?|variations?|variants?|name|rename|title|brand|quantity|qty|stock|pieces?)\b/i.test(message);
}

/**
 * Whether the AI's "said" (the seller's words for which product) is only
 * the new values themselves: "Large, Medium, Small." came back as the
 * product named, for "Sizes: Large, Medium, Small" (owner, 2026-10-07).
 */
export function saidIsValues(said: string, changes: unknown): boolean {
  const words = (t: string) => t.toLowerCase().split(new RegExp("[^\\p{L}\\p{N}]+", "u")).filter((w) => w && !DRAFT_STOP.has(w));
  const values = new Set(words(JSON.stringify(changes ?? {})));
  const named = words(said);
  return named.length > 0 && named.every((w) => values.has(w));
}

const hasChanges = (c: Changes) => Object.keys(c).length > 0;

const COUNT_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

/**
 * Whether the message gives this many products: the number is in it (as
 * digits or a word), or its numbers add up to it, counting "a"/"an" as
 * one ("2 shirts and a fridge" is 3).
 */
export function countBacked(count: number, message: string): boolean {
  const lower = message.toLowerCase();
  const words = (lower.match(/[a-z]+/g) ?? []).filter((w) => w in COUNT_WORDS).map((w) => COUNT_WORDS[w]);
  const values = [...messageNumbers(message).filter((n) => Number.isInteger(n)), ...words];
  if (values.includes(count)) return true;
  const sum = values.reduce((a, b) => a + b, 0);
  const articles = (lower.match(/\b(?:an?|another)\s+(?!few\b|lot\b|bit\b|couple\b|number\b)[a-z]/g) ?? []).length;
  return values.length + articles >= 1 && (sum === count || sum + articles === count);
}

/**
 * The AI's own message, made safe to send: markdown bold and headings as
 * WhatsApp writes them, any web address that isn't one of our links removed
 * (it could be made up), and cut to fit a WhatsApp message with a button.
 */
export function cleanReply(text: string, links: Record<string, AssistantLink>): string {
  const allowed = new Set(Object.values(links).map((l) => l.url.replace(/\/$/, "")));
  const cleaned = text
    // WhatsApp's bold is one asterisk; a model's markdown has two, and headings.
    .replace(/\*\*(.+?)\*\*/g, "*$1*")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\b(?:https?:\/\/|www\.)[^\s)]+/gi, (u) => {
      const bare = u.replace(/[.,!?;:]+$/, "");
      return allowed.has(bare.replace(/\/$/, "")) ? u : "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?])/g, "$1")
    .trim();
  // Under WhatsApp's 1,024 for a message with a button: steps (site-guide.ts) can run to 900.
  return cleaned.length > 1000 ? `${cleaned.slice(0, 999).replace(/\s+\S*$/, "")}…` : cleaned;
}

const DRAFT_STOP = new Set([
  "the", "my", "a", "an", "of", "for", "to", "on", "in", "and", "with", "it", "its", "this", "that", "these", "those", "product",
  "products", "item", "items", "one", "ones", "you", "drafted", "draft", "just", "submitted", "please", "first", "second", "third",
  "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "last", "number", "no",
]);
const draftWords = (s: string) =>
  s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2 && !DRAFT_STOP.has(w)).map((w) => (w.length > 3 ? w.replace(/s$/, "") : w));

/**
 * Whether the seller's words for a product fit this draft's name: more than
 * half of them are in it ("the wigs" fits "Kinky Curly Wig"; "gold medal"
 * doesn't fit "… Earrings - Shell Inlay, Gold Tone"). Words like "the
 * second one" name no product and fit any.
 */
export function fitsDraft(said: string, title: string | null): boolean {
  const want = draftWords(said);
  if (want.length === 0) return true;
  const have = draftWords(title ?? "");
  const hits = want.filter((w) => have.some((h) => h === w || (w.length >= 4 && h.length >= 4 && (h.startsWith(w) || w.startsWith(h)))));
  return hits.length / want.length > 0.5;
}

/** "this month", "you choose the dates": a sale window the seller leaves to us. */
const DELEGATED_MONTH = /\b(this|the|current)\s+month\b|\bend of (the )?month\b|\byou (can )?(choose|pick|decide|set)\b|\bany dates?\b|\bchoose (your own|the|any)\b/i;
const DELEGATED_WEEK = /\b(this|the|current)\s+week\b|\bfor (a|one) week\b/i;
const WEEKEND = /\b(this|the|coming|next)\s+weekend\b|\bover the weekend\b/i;

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** The sale window from the message: its dates, or one the seller left to us (to the end of this month or week). */
export function saleWindow(message: string, now: Date): { start: string; end: string } | null {
  const r = extractDateRange(message, now);
  if (r.startDate && r.endDate) return { start: r.startDate, end: r.endDate };
  if (r.endDate && r.endDate >= isoDay(now)) return { start: isoDay(now), end: r.endDate };
  if (WEEKEND.test(message)) {
    // Saturday to Sunday; from today when it's already the weekend.
    const day = now.getUTCDay();
    const toSat = day === 6 || day === 0 ? 0 : 6 - day;
    const toSun = day === 0 ? 0 : 7 - day;
    return { start: isoDay(new Date(now.getTime() + toSat * 86_400_000)), end: isoDay(new Date(now.getTime() + toSun * 86_400_000)) };
  }
  if (DELEGATED_WEEK.test(message)) return { start: isoDay(now), end: isoDay(new Date(now.getTime() + 6 * 86_400_000)) };
  if (DELEGATED_MONTH.test(message)) {
    return { start: isoDay(now), end: isoDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0))) };
  }
  return null;
}

const END_SALE_WORDS = /\b(end|ends|stop|remove|cancel|no longer|take off|turn off)\b[^.?!]*\b(sale|discount|promo)|\b(sale|discount|promo)\b[^.?!]*\b(end|ended|off|over|stop)\b/i;
const OFF_WORDS = /\b(off|deactivate|disable|hide|unpublish|inactive|pause|stop selling|unlist)\b/i;
/** Typos included: "also tun on the drone" was refused (live, 2026-10-07). Not "on sale". */
// "On them", "on all the products that are off": "on" as the verb, as sellers
// write it (owner's web chat, 2026-10-08).
const ON_WORDS = /^\s*on\s+(?:all|them|those|these|the|it|every|everything|my)\b|\b(turn|tun|trun|tur|switch|put|set|get|bring)\b[^.?!]*\bon\b(?!\s+(sale|discount|promo))|\b(back on|on again)\b|\b(activate|enable|unhide|publish|republish|reactivate|resume|unpause)\b|\b(active|live|visible) again\b|\bmake (it |them )?(active|live|visible)\b|\bgo live\b/i;

/**
 * A question about a product's state ("is the drone live?", "is the dron
 * active"), not a request to change it: answered with product_info. "Can you
 * turn on the drone?" is a request.
 */
export function isStateQuestion(text: string): boolean {
  const t = text.trim();
  if (/^(is|are|was|were|has|have|does|do|did|check if|check whether)\b/i.test(t)) return true;
  return /\?\s*$/.test(t) && !/^(can|could|would|will|please|pls|kindly)\b/i.test(t)
    && !/\b(turn|tun|switch|activate|enable|deactivate|disable|put|set|make|change)\b/i.test(t);
}

/**
 * Whether the seller's message names the product: at least one of its words
 * is in it, or starts the same for 4 letters or more ("dron" for "drones").
 */
export function productBacked(product: string, message: string): boolean {
  const said = new Set(message.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2));
  const typed = Array.from(said).filter((s) => s.length >= 4);
  return product.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 2 && (
    said.has(w) || said.has(w.replace(/s$/, "")) || said.has(`${w}s`)
    || (w.length >= 4 && typed.some((s) => w.startsWith(s) || s.startsWith(w)))));
}

/** Words that name no product: "those products", "all of them", "the other ones". */
const FILLER = new Set([
  "the", "my", "a", "an", "of", "those", "these", "that", "this", "them", "it", "its", "they", "their", "products", "product", "items",
  "item", "listings", "listing", "ones", "one", "shop", "store", "jumia", "on", "in", "all", "every", "everything", "other", "others",
  "rest", "apart", "from", "except", "each", "both", "stuff", "things", "thing", "remaining",
]);
const BULK_WORDS = /\b(all|every|everything|other|others|rest|remaining)\b/i;
const NAME_GAPS = new RegExp("[^\\p{L}\\p{N}]+", "gu");
const nameKey = (t: string) => t.toLowerCase().replace(NAME_GAPS, " ").trim();
/**
 * Whether `said` is the product named `name`: the whole name, or its name
 * before the " - " details ("3-Piece Thong Bodysuit" for "3-Piece Thong
 * Bodysuit - Adjustable Straps, Tummy Control"), three words or more. Pure.
 */
export function sameName(name: string, said: string): boolean {
  const s = nameKey(said);
  if (!s) return false;
  if (nameKey(name) === s) return true;
  const head = nameKey(name.split(/\s[-–—]\s/)[0] ?? "");
  return head.split(" ").length >= 3 && head === s;
}

/** Whether the words name a product at all. */
export function namesAProduct(words: string): boolean {
  return words.toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length >= 2 && !FILLER.has(w));
}

/**
 * "the freezer and the blender, chainsaw": each product of a list the AI gave
 * as one. "And" splits only before "the"/"my"/"also", so "Salt and Pepper
 * Grinder" stays one product.
 */
export const splitProducts = (s: string) =>
  s.split(/\s*[,;]\s*|\s+and\s+(?=(?:the|my|also|a|an)\b)/i).map((x) => x.replace(/^(?:and|also)\s+/i, "").trim()).filter((x) => namesAProduct(x));

/** The seller's own last few messages in the conversation ("Seller: …" lines). */
const sellerLines = (context: string, n = 3) =>
  context.split("\n").filter((l) => l.startsWith("Seller:")).slice(-n).map((l) => l.slice(7)).join("\n");

/**
 * A live change, checked: the products (named in the message, or in the
 * conversation when it says "it"/"them"), and the value, from the message,
 * or from the seller's own recent messages when this one only names the
 * products ("update those to 10 each", then "the freezer and the blender").
 */
function liveChangeAction(
  parsed: Record<string, unknown>, message: string, context: string, now: Date, currency: string,
): AssistantAction {
  const ask = (text: string, awaiting?: { field: "stock" | "price"; products: string[]; fromContext?: boolean }): AssistantAction =>
    ({ type: "reply", text, link: null, ...(awaiting ? { awaiting } : {}) });
  const raw = [
    ...(Array.isArray(parsed.products) ? parsed.products : []),
    ...(typeof parsed.product === "string" ? [parsed.product] : []),
  ].filter((p): p is string => typeof p === "string").map((p) => p.trim().slice(0, 120)).filter(Boolean);
  const named = Array.from(new Set(raw.flatMap((p) => (namesAProduct(p) ? [p] : []))));
  const all = parsed.all === true || BULK_WORDS.test(message);

  // "off all products", "turn off all the other products": the whole shop.
  if (named.length === 0) {
    if (all || raw.some((p) => BULK_WORDS.test(p))) {
      return ask(`Which products? Say it as a rule, e.g. "turn off everything out of stock", "raise all prices by 5%" or "10% off all perfumes this weekend", and I'll show you the list before anything changes.`);
    }
    return ask("Which products do you mean? Tell me their names as they show on Jumia, e.g. \"set the stock of the freezer and the blender to 10\".");
  }
  const inMessage = named.filter((p) => productBacked(p, message));
  const inContext = named.filter((p) => !inMessage.includes(p) && productBacked(p, context));
  const products = [...inMessage, ...inContext];
  const fromContext = inMessage.length === 0 && inContext.length > 0;
  if (products.length === 0) return ask("Which product do you mean? Tell me its name as it shows on Jumia, e.g. \"set the Hisense fridge's stock to 20\".");
  const [product, ...others] = products;
  const live = (change: LiveChange): AssistantAction => ({
    type: "live_change", product, change,
    ...(fromContext ? { fromContext } : {}),
    ...(others.length > 0 ? { others } : {}),
    // "all the hard hats": every product it fits. Said in the message, not only the AI's word.
    ...(/\b(all|every)\b/i.test(message) ? { all: true } : {}),
  });
  const own = messageNumbers(message);
  const numbers = own.length > 0 ? own : messageNumbers(sellerLines(context));
  const awaiting = (field: "stock" | "price") => ({ field, products, ...(fromContext ? { fromContext } : {}) });
  const it = products.length > 1 ? "their" : "its";

  if (parsed.stock != null) {
    const n = Number(parsed.stock);
    const outWords = /\b(out of stock|sold out|none left|finished|no more)\b/i.test(message);
    return Number.isInteger(n) && n >= 0 && (numbers.includes(n) || (n === 0 && outWords))
      ? live({ kind: "stock", stock: n }) : ask(`What should ${it} stock be? Send the number, e.g. "10".`, awaiting("stock"));
  }
  if (parsed.price != null) {
    const n = Number(parsed.price);
    return n > 0 && numbers.includes(n) ? live({ kind: "price", price: n }) : ask(`What should ${it} price be? Send the number, e.g. "150".`, awaiting("price"));
  }
  if (parsed.sale === "end") {
    return END_SALE_WORDS.test(message) ? live({ kind: "sale", sale: null }) : { type: "unclear" };
  }
  if (parsed.sale_price != null || parsed.sale === true) {
    const n = Number(parsed.sale_price);
    const price = n > 0 && numbers.includes(n) ? n : extractSalePrice(message, now, currency)?.salePrice ?? null;
    if (price == null) return ask("What sale price? e.g. \"put it on sale at 80 from 10 Oct to 20 Oct\".");
    const window = saleWindow(message, now) ?? (own.length === 0 ? saleWindow(sellerLines(context, 2), now) : null);
    if (!window) return ask(`A sale on Jumia needs its dates. Send them with the price, e.g. "sale ${price} from 10 Oct to 20 Oct", or say "sale ${price} this month".`);
    return live({ kind: "sale", sale: { price, start: window.start, end: window.end } });
  }
  if (parsed.active === true || parsed.active === false) {
    // "is the drone live?": a question, answered, nothing changed.
    if (isStateQuestion(message)) return { type: "product_info", product };
    if (parsed.active === false) return OFF_WORDS.test(message) ? live({ kind: "status", active: false }) : { type: "unclear" };
    return ON_WORDS.test(message) ? live({ kind: "status", active: true }) : { type: "unclear" };
  }
  return ask("What should I change on it? Its stock, price, a sale price with dates, or turning it on or off.");
}

const PCT_RE = /(\d+(?:\.\d+)?)\s*(?:%|percent|per cent|pct)/i;
const DOWN_WORDS = /\b(reduce|lower|cut|decrease|drop|down|less|slash|minus)\b/i;
const UP_WORDS = /\b(raise|increase|up|more|add|higher|hike|plus)\b/i;
const RULE_WORDS = /\b(all|every|everything|whole|entire|each)\b|%|\bpercent\b/i;
/** Words for products the bot just listed: "those", "them", "the last 10". */
const LISTED_WORDS = /\b(those|these|them|they|the ones?|above|listed|the list|all of them|each of them|(?:last|lat|latest|first|top)\s+\d{1,3})\b/i;
const BULK_SCOPES = new Set<BulkScope>(["all", "out_of_stock", "low_stock", "inactive", "active", "matching"]);
/** What a scope must be backed by in the message (the AI's word alone isn't enough). */
const SCOPE_WORDS_RE: Partial<Record<BulkScope, RegExp>> = {
  out_of_stock: /\b(out of stock|sold out|no stock|zero stock|0 stock|finished)\b/i,
  low_stock:    /\blow\b/i,
  inactive:     /\b(off|inactive|disabled|hidden|deactivated|paused)\b/i,
  active:       /\b(on|active|live|enabled|visible)\b/i,
};
/** The message says it's for every product in the shop, not just "all" of some group. */
const WHOLE_SHOP_RE = /\b(all (?:of )?(?:my |the )?(?:products|items|listings|prices|stock)|every (?:product|item|listing)|everything|whole shop|entire shop)\b/i;
const SCOPE_GROUP: Partial<Record<BulkScope, string>> = {
  out_of_stock: "the ones out of stock", low_stock: "the ones running low", inactive: "the ones turned off", active: "the ones that are on",
};

/**
 * A rule for many products ("10% off all perfumes this weekend"), checked:
 * the message must say it's for many (all, every, a percentage), its scope
 * must be in the message, and every number and date must be written in it.
 */
export function bulkAction(
  parsed: Record<string, unknown>, message: string, now: Date, currency: string,
  opts: { listed?: boolean; restock?: boolean; many?: boolean; previous?: string } = {},
): AssistantAction {
  const ask = (text: string): AssistantAction => ({ type: "reply", text, link: null });
  // "On them and keep their stock" after "on all the products that are off"
  // (owner's web chat, 2026-10-08): the rule and its group are in the message
  // before, which this one points back to. Values still come from this one.
  // So is a bare value answering "What should their stock be?" ("0").
  const rule = opts.previous && (LISTED_WORDS.test(message) || /^\s*\S+(?:\s+\S+){0,2}\s*$/.test(message)) ? `${message}\n${opts.previous}` : message;
  let scope: BulkScope;
  if (parsed.scope === "listed") {
    // "Those", "the last 10", "all" after a list: the products the bot just
    // listed (session.lastListed), only while it's fresh. Never widened to
    // the whole shop.
    if (!opts.listed) return ask("Which products? Ask me to list them first (e.g. \"my last 10 products\" or \"what's out of stock\"), then say what to change on them.");
    if (!LISTED_WORDS.test(message) && !RULE_WORDS.test(message) && !opts.many) return { type: "unclear" };
    scope = "listed";
  } else {
    if (!RULE_WORDS.test(rule) && !opts.many) return { type: "unclear" };
    scope = BULK_SCOPES.has(parsed.scope as BulkScope) ? (parsed.scope as BulkScope) : "all";
  }
  const words = typeof parsed.words === "string" && parsed.words.trim() ? parsed.words.trim().slice(0, 80) : null;
  if (scope === "matching") {
    if (!words || !namesAProduct(words) || !productBacked(words, message)) {
      return ask("Which products? Say it as a rule, e.g. \"10% off all perfumes\" or \"turn off everything out of stock\".");
    }
  } else {
    const backed = SCOPE_WORDS_RE[scope];
    // A group the message doesn't name is never widened to the whole shop on
    // a guess (owner, 2026-10-08: "restock all back to 10" read as out of
    // stock became every product). Only "all products", "everything" make it
    // the whole shop; otherwise ask which they mean. "Restock all" is what's
    // out of stock.
    if (backed && !backed.test(rule) && !(scope === "out_of_stock" && opts.restock)) {
      if (!WHOLE_SHOP_RE.test(rule)) {
        return ask(`Every product in your shop, or only ${SCOPE_GROUP[scope] ?? "some of them"}? Say it with the change, e.g. "set the stock of everything out of stock to 10" or "set all products' stock to 10".`);
      }
      scope = "all";
    }
  }
  const numbers = messageNumbers(message);
  const pctMatch = message.match(PCT_RE);
  const pctValue = pctMatch ? parseFloat(pctMatch[1]) : null;
  let change: LiveChange | null = null;

  if (parsed.price_pct != null) {
    if (pctValue == null || !(pctValue > 0) || pctValue > 90) return ask("By what percentage? e.g. \"raise all prices by 5%\".");
    const sign = DOWN_WORDS.test(message) ? -1 : UP_WORDS.test(message) ? 1 : Math.sign(Number(parsed.price_pct)) || 1;
    change = { kind: "price_pct", pct: sign * pctValue };
  } else if (parsed.sale_pct != null) {
    if (pctValue == null || !(pctValue > 0) || pctValue > 90) return ask("How much off? e.g. \"10% off all perfumes this weekend\".");
    const window = saleWindow(message, now);
    if (!window) return ask(`A sale on Jumia needs its dates. Say them with it, e.g. "${pctValue}% off ${words ? `all ${words}` : "everything"} from 10 Oct to 20 Oct", or "this weekend".`);
    change = { kind: "sale_pct", pct: pctValue, start: window.start, end: window.end };
  } else if (parsed.stock != null) {
    const n = Number(parsed.stock);
    const outWords = /\b(out of stock|sold out|none left|finished|no more)\b/i.test(message);
    if (!(Number.isInteger(n) && n >= 0 && (numbers.includes(n) || (n === 0 && outWords)))) return ask("What should their stock be? Send it with the rule, e.g. \"set all the kettles' stock to 10\".");
    change = { kind: "stock", stock: n };
  } else if (parsed.price != null) {
    const n = Number(parsed.price);
    if (!(n > 0 && numbers.includes(n)) || pctValue != null) return ask("What price? e.g. \"set all the phone cases to 50\".");
    change = { kind: "price", price: n };
  } else if (parsed.sale_price != null) {
    const n = Number(parsed.sale_price);
    const price = n > 0 && numbers.includes(n) ? n : extractSalePrice(message, now, currency)?.salePrice ?? null;
    if (price == null) return ask("What sale price? e.g. \"all the phone cases on sale at 40 this weekend\".");
    const window = saleWindow(message, now);
    if (!window) return ask(`A sale on Jumia needs its dates, e.g. "sale ${price} from 10 Oct to 20 Oct".`);
    change = { kind: "sale", sale: { price, start: window.start, end: window.end } };
  } else if (parsed.sale === "end") {
    if (!END_SALE_WORDS.test(message)) return { type: "unclear" };
    change = { kind: "sale", sale: null };
  } else if (parsed.active === true || parsed.active === false) {
    if (parsed.active === false ? !OFF_WORDS.test(message) : !ON_WORDS.test(message)) return { type: "unclear" };
    change = { kind: "status", active: parsed.active };
  }
  if (!change) return ask("What should change on them? e.g. \"raise all prices by 5%\", \"turn off everything out of stock\", \"10% off all perfumes this weekend\".");
  return { type: "bulk", scope, words: scope === "matching" ? words : null, change };
}

const CHANGE_WORDS = /\b(change|update|edit|modify|new|another|remove|delete|take (?:out|off)|drop|replace|rename|redraft|re-draft|correct)\b/i;
const REWRITE_WORDS = /\b(rewrite|re-write|improve|better|write|redo|re-do|optimi[sz]e|polish|fix|make (it|the \w+) (better|nicer|attractive|catchy|professional))\b/i;

/** A live product's content change, checked: its text copied from the message, or a rewrite they asked for. */
export function contentAction(parsed: Record<string, unknown>, message: string, context: string): AssistantAction {
  const ask = (text: string): AssistantAction => ({ type: "reply", text, link: null });
  const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
  if (!namesAProduct(product) || !(productBacked(product, message) || productBacked(product, context))) {
    return ask("Which product? Tell me its name as it shows on Jumia, e.g. \"rewrite the description of the Hisense fridge\".");
  }
  const request: ContentRequest = {};
  for (const key of ["name", "description", "highlights", "brand"] as const) {
    const v = parsed[key];
    if (typeof v === "string" && v.trim() && saidInMessage(v, message)) request[key] = v.trim();
  }
  const TEXT_FIELDS = ["name", "description", "highlights"] as const;
  // A text the AI wrote itself for a field (not copied from the message) is
  // never sent: it becomes a rewrite, which reads what Jumia has now and takes
  // their words as the instructions ("just redraft the name yourself, it has
  // the word thong in it, just remove that word": owner's WhatsApp, 2026-10-08).
  const guessed = TEXT_FIELDS.filter((f) => typeof parsed[f] === "string" && (parsed[f] as string).trim() && !request[f]);
  const rewrite = Array.from(new Set([
    ...(Array.isArray(parsed.rewrite) ? parsed.rewrite : []).filter((f): f is (typeof TEXT_FIELDS)[number] => (TEXT_FIELDS as readonly unknown[]).includes(f)),
    ...guessed,
  ])).filter((f) => !request[f]);
  // "Change the description of the boot" with no new text in it asks for one
  // to be written, like "rewrite" (owner's web chat, 2026-10-08). A word of
  // its name said with the change is about the name ("it is not a Thong so
  // change that").
  const inName = nameWords(product).some((w) => w.length >= 4 && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(message));
  const named = rewrite.some((f) => f === "name" ? /\b(name|title)\b/i.test(message) || inName : new RegExp(`\\b${f}\\b`, "i").test(message));
  if (rewrite.length > 0 && (REWRITE_WORDS.test(message) || (named && CHANGE_WORDS.test(message)))) {
    request.rewrite = rewrite; request.instructions = message.slice(0, 400);
  }
  // Its other details, barcode or a size's name (owner, 2026-10-09): each
  // value copied from the message; which detail, and whether Jumia takes
  // the value, is checked against the product's category when it's offered.
  const details: Record<string, string> = {};
  if (parsed.details && typeof parsed.details === "object" && !Array.isArray(parsed.details)) {
    for (const [k, v] of Object.entries(parsed.details as Record<string, unknown>).slice(0, 6)) {
      if (typeof v === "string" && v.trim() && k.trim() && saidInMessage(v, message)) details[k.trim().slice(0, 40)] = v.trim().slice(0, 200);
    }
  }
  if (Object.keys(details).length > 0) request.details = details;
  const barcode = typeof parsed.barcode === "string" ? parsed.barcode.replace(/[\s-]/g, "") : "";
  if (/^\d{8,14}$/.test(barcode) && message.replace(/[\s-]/g, "").includes(barcode)) request.barcode = barcode;
  const size = (parsed.size ?? null) as { from?: unknown; to?: unknown } | null;
  if (size && typeof size.to === "string" && size.to.trim() && saidInMessage(size.to, message)) {
    const from = typeof size.from === "string" && size.from.trim() && (saidInMessage(size.from, message) || saidInMessage(size.from, context)) ? size.from.trim() : null;
    request.size = { from, to: size.to.trim().slice(0, 40) };
  }
  if (Object.keys(request).length === 0) {
    return ask("What should I change on it? Write the new name, or say \"rewrite its description\", e.g. \"change the blender's name to Silver Crest 3 in 1 Blender 1.5L\" or \"set the fan's colour to black\".");
  }
  return { type: "content_change", product, request };
}

const NAME_STOP = new Set(["the", "a", "an", "of", "and", "with", "for", "in", "to", "my"]);
const nameWords = (s: string) =>
  s.toLowerCase().replace(/…$/, "").split(new RegExp("[^\\p{L}\\p{N}]+", "u")).filter((w) => w.length >= 2 && !NAME_STOP.has(w));

export interface ParseOpts {
  context?: string;
  stage?: Stage;
  now?: Date;
  /** The bot listed products for them in the last 30 minutes (session.lastListed): "those" can mean them. */
  listed?: boolean;
}

// ─── Honest "can't" ───────────────────────────────────────────────────────

/** What PandaWorld doesn't do: one answer, never the AI's own words (owner, 2026-10-11). */
export const NOT_YET_TEXT = "I can't do that yet. I've noted it.";
/** Nothing to do with Jumia, selling or PandaWorld. */
export const OUTSIDE_TEXT = "That's outside what I do: I help with your Jumia shop and PandaWorld. Ask me about your products, orders, sales or payouts, or list something new.";

const INABILITY = new RegExp([
  // "I can't", "we cannot", "PandaWorld is unable to", "I don't keep a record"
  "\\b(?:i|we|pandaworld)(?: (?:currently|still|really|just|unfortunately|actually|also))? (?:can't|cannot|can not|am unable|are unable|is unable|am not able|are not able|"
    + "(?:don't|do not|doesn't|does not) have (?:the |a |any )?(?:ability|capability|access|way|option|feature)|have no (?:way|ability|access|option)|"
    + "(?:don't|do not) (?:keep|store|save|remember|record|track)|(?:won't|will not) be able)\\b",
  "\\bi'm (?:currently |still |unfortunately |afraid i'm )?(?:unable|not able)\\b",
  "\\b(?:that|this|it)(?:'s| is) not (?:possible|something (?:i|we) can)\\b",
  "\\bisn't (?:possible|something (?:i|we) can)\\b",
  "\\bnot (?:supported|available) (?:here|in this chat|on whatsapp|yet)\\b",
].join("|"), "i");
// Sent to Vendor Center for something to be done there.
const TO_VENDOR_CENTER = new RegExp([
  "\\b(?:change|update|edit|delete|remove|do|manage|set|turn|adjust|modify|add|upload)\\b[^.!?\\n]{0,60}\\b(?:in|on|via|through|from|using|at) (?:the |your )?(?:jumia )?vendor ?cent(?:er|re)\\b",
  "\\b(?:use|(?:need|have) to (?:use|go to|log ?in(?:to| to)|open|visit)|go to|head to|head over to|visit) (?:the |your )?(?:jumia )?vendor ?cent(?:er|re)\\b",
].join("|"), "i");
// Steps that happen in Vendor Center: connecting Jumia, the extension.
const VENDOR_CENTER_STEPS = /\b(?:token|client id|self.?authori[sz]ation|applications?|api key|extension|autofill|add products)\b/i;
const OUTSIDE_SCOPE = /\b(?:only (?:help|assist)(?: you)? with|outside (?:of )?(?:jumia|pandaworld|what i|my)|not related to (?:jumia|your shop|pandaworld|selling)|unrelated to|but i can help (?:you )?with your (?:jumia|shop))\b/i;

/**
 * A reply in the AI's own words that says PandaWorld can't do something, or
 * sends them to Vendor Center to do it: stopped before it's sent (owner,
 * 2026-10-11: "Any reply that claims 'I can't' or 'use Vendor Center' for
 * something on the can-do list is blocked"). What truly isn't possible has
 * its fixed answer (cannot), and what isn't built, not_yet. Pure.
 */
export function claimsInability(text: string): boolean {
  const t = text.replace(/[‘’]/g, "'");
  return INABILITY.test(t) || (TO_VENDOR_CENTER.test(t) && !VENDOR_CENTER_STEPS.test(t));
}

/** A reply that claimed it can't, as not_yet: their message is the request. */
function blockedReply(text: string, message: string): AssistantAction {
  const t = text.replace(/[‘’]/g, "'");
  return { type: "not_yet", what: message.trim().slice(0, 200), outside: OUTSIDE_SCOPE.test(t), blocked: text.slice(0, 500) };
}

/**
 * The AI's reply as an action our code can carry out, or unclear: checked
 * for safety only (every value in the message, products named, nothing
 * widened, a reply that says it can't stopped). The word rules that used to
 * correct the AI's choice here are gone with the old one-call reader (step 2
 * of the plan, 11 Oct): a misread becomes a test case
 * (lib/evals/assistant-cases.ts), never a rule.
 */
export function parseAction(
  raw: string, message: string, products: ProductFacts[], links: Record<string, AssistantLink> = {}, currency = "GHS",
  opts: ParseOpts = {},
): AssistantAction {
  return parseActionRaw(raw, message, products, links, currency, opts);
}

function parseActionRaw(
  raw: string, message: string, products: ProductFacts[], links: Record<string, AssistantLink> = {}, currency = "GHS",
  opts: ParseOpts = {},
): AssistantAction {
  const now = opts.now ?? new Date();
  const context = opts.context ?? "";
  const ask = (text: string): AssistantAction => ({ type: "reply", text, link: null });
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { type: "unclear" };
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(match[0]) as Record<string, unknown>; } catch { return { type: "unclear" }; }

  const known = new Set(products.map((p) => p.seq));
  const seqsOf = (v: unknown): number[] =>
    Array.isArray(v) ? Array.from(new Set(v.map(Number).filter((n) => known.has(n)))) : [];
  // A draft's own name given to a read of their Jumia shop is that draft:
  // "show me the highlights you wrote for the first one" read draft 1's name
  // as a live product and showed a different bodysuit (owner, 2026-10-10).
  const draftNamed = (product: string): number | null =>
    products.find((p) => p.listing.title && sameName(p.listing.title, product))?.seq ?? null;

  switch (parsed.type) {
    case "restart": case "review": case "orders": case "credits": case "help":
      return { type: parsed.type as "restart" | "review" | "orders" | "credits" | "help" };
    case "reply":
    case "answer": {
      const link = typeof parsed.link === "string" && parsed.link in links ? parsed.link : null;
      const text = typeof parsed.text === "string" ? cleanReply(parsed.text, links) : "";
      if (!text) return link ? { type: "reply", text: `Here's the ${links[link].label.toLowerCase()}:`, link } : { type: "unclear" };
      if (claimsInability(text)) return blockedReply(text, message);
      return { type: "reply", text, link };
    }
    case "not_yet": {
      const what = typeof parsed.what === "string" && parsed.what.trim() ? parsed.what.trim().slice(0, 200) : message.trim().slice(0, 200);
      return { type: "not_yet", what, outside: parsed.outside === true };
    }
    case "capability":
    case "can": {
      // "Can you…?": the list's own answer, never the AI's words about it.
      const id = String(parsed.what ?? parsed.id ?? "");
      const a = capabilityAnswer(id);
      if (!a) return { type: "unclear" };
      if (a.wish) return { type: "not_yet", what: capability(id)?.what ?? id, outside: false, text: a.text };
      return { type: "reply", text: a.text, link: a.link && a.link in links ? a.link : null };
    }
    case "live_change":
      return liveChangeAction(parsed, message, context, now, currency);
    case "product_info":
    case "info": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      const draft = draftNamed(product);
      if (draft != null) return { type: "draft_text", seqs: [draft] };
      if (!namesAProduct(product)) return ask("Which product? Tell me its name as it shows on Jumia, e.g. \"is the Hisense fridge live?\".");
      return productBacked(product, message) || productBacked(product, context)
        ? { type: "product_info", product } : ask("Which product? Tell me its name as it shows on Jumia, e.g. \"is the Hisense fridge live?\".");
    }
    case "cannot": {
      // Something Jumia's API doesn't allow: its fixed, true answer
      // (lib/jumia/capabilities.ts), never the AI's own words about it.
      const id = String(parsed.what ?? "");
      const a = cannotAnswer(id);
      // Not built yet: its answer, and the request noted.
      if (a && capability(id)?.status === "not_built") return { type: "not_yet", what: capability(id)?.what ?? id, outside: false, text: a.text };
      if (a) return { type: "reply", text: a.text, link: a.link && a.link in links ? a.link : null };
      // A key that isn't on the list ("invoice", "competitor_prices": the
      // test run of 11 Oct): something PandaWorld doesn't do, so not_yet;
      // one it does has its own key and never lands here.
      if (capability(id)) return { type: "unclear" };
      return { type: "not_yet", what: id ? id.replace(/_/g, " ").slice(0, 200) : message.trim().slice(0, 200), outside: false };
    }
    case "draft_text": {
      // Reading a draft changes nothing: any of theirs, said or not; the only one when none is named.
      const seqs = seqsOf(Array.isArray(parsed.products) ? parsed.products : [parsed.products ?? parsed.product]).slice(0, 3);
      if (seqs.length > 0) return { type: "draft_text", seqs };
      if (products.length === 1) return { type: "draft_text", seqs: [products[0].seq] };
      return products.length > 1 ? ask(`Which draft? Say its number (1 to ${products.length}), e.g. "show me draft 1".`) : { type: "unclear" };
    }
    case "product_text": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      const draft = draftNamed(product);
      if (draft != null) return { type: "draft_text", seqs: [draft] };
      return namesAProduct(product) && (productBacked(product, message) || productBacked(product, context))
        ? { type: "product_text", product } : ask("Which product? Tell me its name as it shows on Jumia, e.g. \"show me the neck fan's description\".");
    }
    case "add_size": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      if (!namesAProduct(product) || !(productBacked(product, message) || productBacked(product, context))) {
        return ask("Which product gets the new size? Tell me its name as it shows on Jumia, e.g. \"add size XL to the gown, 5 in stock\".");
      }
      const size = typeof parsed.size === "string" ? parsed.size.trim().slice(0, 40) : "";
      if (!size || !saidInMessage(size, message)) return ask("Which size should I add? E.g. \"add size XL to the gown, 5 in stock\".");
      const said = messageNumbers(message);
      const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && said.includes(v) ? v : null);
      const stock = n(parsed.stock);
      const price = n(parsed.price);
      return { type: "add_size", product, request: { size, stock: stock != null && Number.isInteger(stock) ? stock : null, price: price != null && price > 0 ? price : null } };
    }
    case "add_photos": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      return namesAProduct(product) && (productBacked(product, message) || productBacked(product, context))
        ? { type: "add_photos", product } : ask("Which product gets the photos? Tell me its name as it shows on Jumia, e.g. \"add photos to the neck fan\".");
    }
    case "fix_rejected": {
      // A product only when it's named here or just before; Jumia's reason only as they pasted it.
      const named = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      const product = named && namesAProduct(named) && (productBacked(named, message) || productBacked(named, context)) ? named : null;
      const said = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 600) : "";
      const reason = said.length >= 4 && message.toLowerCase().includes(said.toLowerCase().slice(0, 40)) ? said : null;
      return { type: "fix_rejected", product, reason };
    }
    case "fees":
    case "calculator": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      const n = Number(parsed.price);
      const price = n > 0 && messageNumbers(message).includes(n) ? n : null;
      if (!namesAProduct(product) || !(productBacked(product, message) || productBacked(product, context))) {
        return ask("Which product? Tell me its name, e.g. \"how much do I get if the creatine sells\", or send its price and category to the calculator.");
      }
      return { type: "fees", product, price };
    }
    case "stock": {
      // "What is the stock of this product" names it in the conversation
      // (owner's web chat, 2026-10-08: it got the whole low-stock list).
      const product = typeof parsed.product === "string" && parsed.product.trim()
        && (productBacked(parsed.product, message) || (namesAProduct(parsed.product) && productBacked(parsed.product, context)))
        ? parsed.product.trim().slice(0, 120) : null;
      const filter = parsed.filter === "out" || parsed.filter === "low" ? parsed.filter : null;
      return { type: "stock", product, filter };
    }
    case "shop":
      return { type: "shop", filter: parsed.filter === "inactive" || parsed.filter === "rejected" ? parsed.filter : "all" };
    case "order_status": {
      const number = String(parsed.number ?? "").replace(/\D/g, "");
      const said = (t: string) => t.replace(/\D/g, " ").split(/\s+/).includes(number);
      return number.length >= 5 && (said(message) || said(context))
        ? { type: "order_status", number } : ask("Which order? Send its number, e.g. \"where is order 355926919\".");
    }
    case "sales": {
      const list = Array.from(new Set((Array.isArray(parsed.status) ? parsed.status : [parsed.status]).map(asOrderStatus).filter((s): s is string => !!s)));
      // "past time", "ever": as far back as Jumia goes.
      const period = parsed.period === "all" || parsed.period === "ever" || parsed.period === "90days" ? "quarter" : asPeriod(parsed.period, "week");
      return { type: "sales", period, status: list.length === 0 ? null : list.length === 1 ? list[0] : list };
    }
    case "listings":
      return { type: "listings", period: asPeriod(parsed.period, "today") };
    case "note":
    case "step":
      return { type: "note" };
    case "payouts":
      return { type: "payouts" };
    case "payout_detail": {
      const statement = typeof parsed.statement === "string" && parsed.statement.trim() && saidInMessage(parsed.statement, message)
        ? parsed.statement.trim().slice(0, 40) : null;
      return { type: "payout_detail", mode: parsed.mode === "history" ? "history" : "breakdown", statement };
    }
    case "report": {
      const kinds = new Set<ReportKind>(["best_sellers", "slow_movers", "restock", "returns"]);
      if (!kinds.has(parsed.kind as ReportKind)) return { type: "unclear" };
      return { type: "report", kind: parsed.kind as ReportKind, period: asPeriod(parsed.period, "month") };
    }
    case "bulk":
      return bulkAction(parsed, message, now, currency, { listed: opts.listed, previous: lastSellerLine(context) });
    case "content_change":
      return contentAction(parsed, message, context);
    case "brand_check": {
      const brand = typeof parsed.brand === "string" ? parsed.brand.trim().slice(0, 60) : "";
      if (!brand || !saidInMessage(brand, message)) return ask("Which brand? e.g. \"is Lattafa a brand on Jumia?\".");
      const product = typeof parsed.product === "string" && parsed.product.trim() && productBacked(parsed.product, message) ? parsed.product.trim().slice(0, 80) : null;
      return { type: "brand_check", brand, product };
    }
    case "category_info": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 80) : "";
      return product && productBacked(product, message) ? { type: "category_info", product } : ask("What kind of product? e.g. \"what does Jumia need to list a perfume?\".");
    }
    case "shops":
      return { type: "shops" };
    case "polish": {
      const n = typeof parsed.product === "number" ? parsed.product : parseInt(String(parsed.product ?? ""), 10);
      return { type: "polish", seq: Number.isInteger(n) && n > 0 && new RegExp(`\\b${n}\\b`).test(message) ? n : null };
    }
    case "health_report": case "health": case "shop_health":
      return { type: "health_report" };
    case "research": {
      const needs = parseNeeds(parsed.needs, {
        backed: (words) => namesAProduct(words) && (productBacked(words, message) || productBacked(words, context)),
        asStatus: asOrderStatus,
      });
      return needs.length > 0 ? { type: "research", needs } : { type: "unclear" };
    }
    case "warehouse_stock": {
      const product = typeof parsed.product === "string" ? parsed.product.trim().slice(0, 120) : "";
      return namesAProduct(product) && productBacked(product, message)
        ? { type: "warehouse_stock", product } : ask("Which product? e.g. \"how many kettles are in Jumia's warehouse?\".");
    }
    case "warehouse_order": {
      const numbers = messageNumbers(message);
      const items = (Array.isArray(parsed.items) ? parsed.items : []).flatMap((i) => {
        const r = (i && typeof i === "object" ? i : {}) as Record<string, unknown>;
        const product = typeof r.product === "string" ? r.product.trim().slice(0, 120) : "";
        const quantity = Number(r.quantity);
        return namesAProduct(product) && productBacked(product, message) && Number.isInteger(quantity) && quantity > 0 && numbers.includes(quantity)
          ? [{ product, quantity }] : [];
      });
      if (items.length === 0) return ask("Which products, and how many of each? e.g. \"send 50 of the kettle to Jumia's warehouse on 20 Oct\".");
      return { type: "warehouse_order", items, date: findDateIn(message, now) };
    }
    case "warehouse_shipped": {
      const po = typeof parsed.po === "string" ? parsed.po.trim().slice(0, 40) : "";
      const tracking = typeof parsed.tracking === "string" ? parsed.tracking.trim().slice(0, 60) : "";
      if (!po || !tracking || !saidInMessage(po, message) || !saidInMessage(tracking, message)) {
        return ask("Send the delivery order's number and its tracking number, e.g. \"PO 123AB shipped, tracking DHL998877\".");
      }
      const carrier = typeof parsed.carrier === "string" && parsed.carrier.trim() && saidInMessage(parsed.carrier, message) ? parsed.carrier.trim().slice(0, 60) : null;
      return { type: "warehouse_shipped", po, tracking, carrier };
    }
    case "list": {
      const count = Number(parsed.count);
      // A count the message doesn't give is the AI's guess: still a wish to
      // list, so it's offered like "restart" (owner's web chat, 2026-10-08:
      // "let's list new products" came back as a count of 1 and got the
      // review step's help instead).
      return Number.isInteger(count) && count >= 1 && countBacked(count, message) ? { type: "list", count } : { type: "restart" };
    }
    case "submit": {
      if (parsed.products === "all") return { type: "submit", seqs: "all" };
      const seqs = seqsOf(parsed.products);
      return seqs.length > 0 ? { type: "submit", seqs: seqs.sort((a, b) => a - b) } : { type: "unclear" };
    }
    case "edit": {
      if (!Array.isArray(parsed.edits)) return { type: "unclear" };
      if (products.length === 0) {
        // No drafts here: "the stock of the freezer, the blender and the
        // chainsaw should be made 10" came back as an edit (live,
        // 2026-10-07). It's about products in their Jumia shop.
        const e = (parsed.edits as Record<string, unknown>[]).find((x) => x && typeof x.said === "string" && x.changes && typeof x.changes === "object");
        if (!e) return { type: "unclear" };
        const c = e.changes as Record<string, unknown>;
        const value = c.quantity != null ? { stock: c.quantity } : c.price != null ? { price: c.price } : null;
        return value ? liveChangeAction({ products: splitProducts(String(e.said)), ...value }, message, context, now, currency) : { type: "unclear" };
      }
      const edits: EditPart[] = [];
      const dropped = new Set<string>();
      const misnamed: { said: string; changes: unknown }[] = [];
      for (const e of parsed.edits as Record<string, unknown>[]) {
        if (!e || typeof e !== "object") continue;
        let seqs = seqsOf(e.products);
        // The draft must be the product they named: "set the gold medal to
        // 25" once changed a draft of gold-tone earrings (live, 2026-10-07).
        let said = typeof e.said === "string" && !saidIsValues(e.said, e.changes) ? e.said.trim() : "";
        // "the 150 is product 3 price": a draft named by its number is that
        // draft, never a live product (owner's web chat, 2026-10-08, where
        // it went to the live products on Jumia).
        const byNumber = draftNumberIn(said, products);
        if (byNumber != null) { seqs = [byNumber]; said = ""; }
        if (said && seqs.length > 0) {
          const fits = seqs.filter((seq) => fitsDraft(said, products.find((p) => p.seq === seq)?.listing.title ?? null));
          if (fits.length === 0) { misnamed.push({ said, changes: e.changes }); continue; }
          seqs = fits;
        }
        // Nothing named: the only product, or any of them.
        if (seqs.length === 0) seqs = products.map((p) => p.seq);
        const of = products.filter((p) => seqs.includes(p.seq));
        const { changes, dropped: d } = verifyChanges(e.changes, message, {
          options:    of.flatMap((p) => p.options),
          variations: of.flatMap((p) => p.variations),
        });
        d.forEach((x) => dropped.add(x));
        if (!hasChanges(changes)) continue;
        const ask = seqs.length > 1 && (e.ask === true || seqsOf(e.products).length === 0);
        edits.push({ seqs: seqs.sort((a, b) => a - b), changes, ask });
      }
      if (edits.length === 0 && misnamed.length > 0) {
        // Not one of the drafts: a product already in their Jumia shop.
        const m = misnamed[0];
        const c = (m.changes && typeof m.changes === "object" ? m.changes : {}) as Record<string, unknown>;
        const numbers = messageNumbers(message);
        const price = Number(c.price);
        const qty = Number(c.quantity);
        if (productBacked(m.said, message)) {
          if (price > 0 && numbers.includes(price)) return { type: "live_change", product: m.said, change: { kind: "price", price } };
          if (Number.isInteger(qty) && qty >= 0 && numbers.includes(qty)) return { type: "live_change", product: m.said, change: { kind: "stock", stock: qty } };
        }
        return ask(`"${m.said.slice(0, 60)}" isn't one of the drafts here. Say which draft by its number, or, for a product already on Jumia, e.g. "set the ${m.said.slice(0, 40)}'s price to 150".`);
      }
      // A colour, brand or name the AI added that the message doesn't even
      // mention isn't worth a warning ("Large, Medium and Small" got "I
      // couldn't see the new colour", owner's web chat, 2026-10-08).
      const NAMED: Record<string, RegExp> = { colour: /colou?rs?/i, brand: /\bbrand/i, name: /\b(name|title|rename|call(?:ed)? it)\b/i };
      for (const d of Array.from(dropped)) if (NAMED[d] && !NAMED[d].test(message)) dropped.delete(d);
      if (edits.length > 0) return { type: "edit", edits, dropped: Array.from(dropped) };
      // Nothing it gave is in the message, and the message names no field
      // or number: not an edit at all ("my message count so far" came back
      // as the last edit again, 2026-10-08).
      return dropped.size > 0 && namesAField(message) ? { type: "edit", edits, dropped: Array.from(dropped) } : { type: "unclear" };
    }
    default:
      return { type: "unclear" };
  }
}

// ─── Reading the products ─────────────────────────────────────────────────

async function batchListings(batchId: string, userId: string): Promise<ListingRow[]> {
  const { data, error } = await createServerClient()
    .from("listings")
    .select("*")
    .eq("whatsapp_batch_id", batchId)
    .eq("user_id", userId)
    .order("whatsapp_seq", { ascending: true });
  if (error) console.warn(`[assistant] loading batch ${batchId} failed: ${error.message}`);
  return ((data ?? []) as ListingRow[]).sort((a, b) => (a.whatsapp_seq ?? 0) - (b.whatsapp_seq ?? 0));
}

export async function productFacts(listings: ListingRow[]): Promise<ProductFacts[]> {
  if (listings.length === 0) return [];
  const { data } = await createServerClient()
    .from("variants")
    .select("listing_id, variation")
    .in("listing_id", listings.map((l) => l.id));
  const byListing = new Map<string, string[]>();
  for (const v of (data ?? []) as { listing_id: string; variation: string | null }[]) {
    if (!v.variation?.trim() || v.variation === "...") continue;
    byListing.set(v.listing_id, [...(byListing.get(v.listing_id) ?? []), v.variation.trim()]);
  }
  return Promise.all(listings.map(async (l, i) => ({
    seq:        l.whatsapp_seq ?? i + 1,
    listing:    l,
    variations: byListing.get(l.id) ?? [],
    options:    await variationOptions(Number(l.category_code)).catch(() => [] as string[]),
  })));
}

// ─── Asking the AI ────────────────────────────────────────────────────────

/** Models app_settings `assistant_model` may switch to; anything else is ignored. */
const MODELS = new Set(["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite"]);
/** And agent mode's (`assistant_agent_model`), with a thinking level after a colon if wanted ("gemini-3.8-flash:low"). */
const AGENT_MODELS = new Set([...Array.from(MODELS), "gemini-3-flash-preview", "gemini-3.6-flash", "gemini-3.8-flash"]);

/**
 * The front door's sorting model: app_settings `assistant_router_model`, else
 * FRONT_DOOR_ROUTER. Both on Gemini 3.1 Flash-Lite since 9 Oct (owner: "let's
 * switch to Gemini 3.1 Flash-Lite"; 211 of 224 against 213, a third faster,
 * 40% cheaper).
 */
export async function routerModel(): Promise<string> {
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", "assistant_router_model").maybeSingle();
    return typeof data?.value === "string" && MODELS.has(data.value) ? data.value : FRONT_DOOR_ROUTER;
  } catch {
    return FRONT_DOOR_ROUTER;
  }
}

/** Agent mode's model: app_settings `assistant_agent_model`, else the one the assistant uses. */
export async function agentModel(): Promise<string> {
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", "assistant_agent_model").maybeSingle();
    const spec = typeof data?.value === "string" ? agentModelSpec(data.value) : null;
    return spec && AGENT_MODELS.has(spec.model) ? (data!.value as string).trim() : await assistantModel();
  } catch {
    return assistantModel();
  }
}

/** The model the assistant uses: app_settings `assistant_model`, else ASSISTANT_MODEL. */
export async function assistantModel(): Promise<string> {
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", "assistant_model").maybeSingle();
    return typeof data?.value === "string" && MODELS.has(data.value) ? data.value : ASSISTANT_MODEL;
  } catch {
    return ASSISTANT_MODEL;
  }
}

/** One message of the conversation, at most this long. */
export const CONVERSATION_LINE_MAX = 1_200;
/** The whole conversation, at most this long: the newest messages are kept. */
export const CONVERSATION_MAX = 12_000;

/**
 * The newest lines that fit in `budget` characters, oldest first. Pure.
 */
export function newestWithin(lines: string[], budget = CONVERSATION_MAX): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    used += lines[i].length + 1;
    if (used > budget && kept.length > 0) break;
    kept.unshift(lines[i]);
  }
  return kept;
}

/**
 * The last messages with this seller, oldest first, as "Seller: …" / "Bot:
 * …" lines, without the one being answered. Taps on buttons read as such;
 * a pasted code (Client ID, token, key) as "[a code]". Twenty since the
 * assistant reads every message (owner, 2026-10-07), with what came before
 * in the seller's memory (lib/whatsapp/seller-memory.ts). Each up to
 * CONVERSATION_LINE_MAX characters (300 until 2026-10-11, when "the first
 * one" and "the questions I asked" were lost), CONVERSATION_MAX in all.
 */
export async function recentConversation(phone: string, current: string, max = 20): Promise<string[]> {
  try {
    // A cleared web chat starts its conversation again (lib/whatsapp/chat-clear.ts).
    const cleared = await chatClearedAt(phone);
    let q = createServerClient()
      .from("whatsapp_message_log")
      .select("direction, message_type, body_text, created_at")
      .eq("phone_number", phone);
    if (cleared) q = q.gt("created_at", cleared);
    const { data } = await q
      .order("created_at", { ascending: false })
      .limit(max + 1);
    const rows = ((data ?? []) as { direction: string; message_type: string | null; body_text: string | null; created_at: string }[])
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    const lastIn = rows[rows.length - 1];
    if (lastIn && lastIn.direction === "inbound" && (lastIn.body_text ?? "").trim() === current.trim()) rows.pop();
    return newestWithin(rows.slice(-max).map((r) => {
      // A tapped answer to the front door's question reads as the answer.
      const body = (r.body_text ?? "").trim().replace(/^answer:(?:@[a-z_]+:)?/, "");
      const shown = !body ? (r.message_type === "image" ? "[a photo]" : "[a message]")
        : /^[a-z_]+:\S+$/i.test(body) ? "[tapped a button]" : blankCodes(body.replace(/\s+/g, " ").slice(0, CONVERSATION_LINE_MAX));
      return `${r.direction === "inbound" ? "Seller" : "Bot"}: ${shown}`;
    }));
  } catch {
    return [];
  }
}

/** One line for a product the bot listed: where it is, as the front door reads it. */
function listedLine(p: ShopProduct): string {
  const qc = p.qcStatus === "REJECTED" ? "rejected by quality check" : p.qcStatus === "APPROVED" ? "approved" : p.qcStatus ? "waiting for quality check" : "quality check unknown";
  const variation = p.variation && p.variation !== "..." ? ` (${p.variation})` : "";
  return `"${p.name}${variation}" · ${p.status === "ACTIVE" ? "on" : p.status === "INACTIVE" ? "off" : (p.status ?? "?").toLowerCase()} · ${qc} · stock ${p.stock ?? "?"}`;
}

/** From the shop's local copy: the products the message names, and the ones the bot just listed, as lines. */
async function shopFacts(userId: string, message: string, listedSids: string[]): Promise<{ names: string[]; listed: string[] }> {
  try {
    const products = (await shopProducts(userId)).filter((p) => p.status !== "DELETED");
    const bySid = new Map(products.map((p) => [p.sid, p]));
    return {
      names:  namesInMessage(message, products.map((p) => p.name).filter(Boolean)),
      listed: listedSids.map((sid) => bySid.get(sid)).filter((p): p is ShopProduct => !!p).slice(0, 30).map(listedLine),
    };
  } catch {
    return { names: [], listed: [] };
  }
}

/**
 * The front door: the seller's facts, read in two small steps (the area,
 * then the action within it), with no word rules.
 * It may answer with a question back (`clarify`) instead of an action.
 */
export async function interpretThroughFrontDoor(
  userId: string,
  stage: Stage,
  products: ProductFacts[],
  message: string,
  opts: {
    batchId?: string | null; conversation?: string[]; web?: boolean; position?: string; waitingFor?: string;
    listed?: { count: number; what: string } | null; listedSids?: string[]; answered?: { area?: string };
  } = {},
): Promise<{ area: string; action: AssistantAction | Clarify; links: Record<string, AssistantLink>; raw: string }> {
  const [currency, seller, reader, listingCost, memory, shop] = await Promise.all([
    shopCurrencyForUser(userId), sellerFacts(userId), assistantModel(), listingCreditCost(userId).catch(() => LIVE_LISTING_CREDIT_COST),
    sellerMemory(userId), shopFacts(userId, message, opts.listed ? opts.listedSids ?? [] : []),
  ]);
  const links = assistantLinks({ batchId: opts.batchId, countrySlug: seller.countrySlug });
  const { area, action, raw } = await frontDoor({
    stage, message, conversation: opts.conversation ?? [], drafts: products, waitingFor: opts.waitingFor,
    listed: opts.listed ? { ...opts.listed, items: shop.listed } : null,
    seller: seller.lines, links, currency, web: opts.web ?? false, shopNames: shop.names, listingCost, position: opts.position, memory,
    ...(opts.answered ? { answered: opts.answered } : {}),
  }, { router: await routerModel(), reader }, { feature: "assistant", userId }, FRONT_DOOR_LIMITS);
  return { area, action, links, raw: `[front door] ${raw}` };
}

/**
 * Agent mode: the same facts as the front door,
 * read in one call with every action as a tool, looking up their products
 * (the shop's local copy) when it needs to. One to three actions, or a
 * question back. Throws when the model fails or runs out of time.
 */
export async function interpretThroughAgent(
  userId: string,
  stage: Stage,
  products: ProductFacts[],
  message: string,
  opts: {
    batchId?: string | null; conversation?: string[]; web?: boolean; position?: string; waitingFor?: string;
    listed?: { count: number; what: string } | null; listedSids?: string[]; answered?: { area?: string };
  } = {},
): Promise<{ actions: AssistantAction[]; clarify: Clarify | null; links: Record<string, AssistantLink>; raw: string }> {
  const [currency, seller, model, listingCost, memory, shop] = await Promise.all([
    shopCurrencyForUser(userId), sellerFacts(userId), agentModel(), listingCreditCost(userId).catch(() => LIVE_LISTING_CREDIT_COST),
    sellerMemory(userId), shopProducts(userId).then((all) => all.filter((p) => p.status !== "DELETED")).catch(() => [] as ShopProduct[]),
  ]);
  const links = assistantLinks({ batchId: opts.batchId, countrySlug: seller.countrySlug });
  const bySid = new Map(shop.map((p) => [p.sid, p]));
  const listedItems = opts.listed
    ? (opts.listedSids ?? []).map((sid) => bySid.get(sid)).filter((p): p is ShopProduct => !!p).slice(0, 30).map(listedLine)
    : [];
  const input: FrontDoorInput = {
    stage, message, conversation: opts.conversation ?? [], drafts: products, waitingFor: opts.waitingFor,
    listed: opts.listed ? { ...opts.listed, items: listedItems } : null,
    seller: seller.lines, links, currency, web: opts.web ?? false, shopNames: shop.map((p) => p.name).filter(Boolean), listingCost,
    position: opts.position, memory, ...(opts.answered ? { answered: opts.answered } : {}),
  };
  const read = await agentRead(input, geminiAgentCall(model, agentSystem(listingCost), { feature: "assistant", userId }), catalogLookups(shop));
  return { actions: read.actions, clarify: read.clarify, links, raw: `[agent ${model}] ${read.raw}` };
}

/**
 * The front door's question back, with its answers to tap. A tap comes back
 * as "answer:@<area>:<words>" and is read as if typed (lib/whatsapp/intake.ts
 * aiReadable), in the question's area, with the question in the conversation.
 */
export async function sendClarify(phone: string, clarify: Clarify, area?: string): Promise<void> {
  const question = clarify.question.trim() || "What would you like me to do?";
  // A bare number would read as a count once tapped: it must say what it is.
  const options = clarify.options.map((o) => o.trim()).filter((o) => o && !/^\d+$/.test(o)).slice(0, 3);
  if (options.length < 2) {
    await sendTextIfConfigured(phone, question);
    return;
  }
  if (options.every((o) => o.length <= 20)) {
    await sendButtonsIfConfigured(phone, question, options.map((o) => ({ id: `answer:${area ? `@${area}:` : ""}${o}`, title: o })));
    return;
  }
  await sendListIfConfigured(phone, question, "Choose", options.map((o) => ({
    id: `answer:${area ? `@${area}:` : ""}${o}`, title: o.slice(0, 24), ...(o.length > 24 ? { description: o.slice(0, 72) } : {}),
  })));
}

// ─── Carrying it out ──────────────────────────────────────────────────────

/** The seller's message before this one, from the conversation ("Seller: …" lines). */
export function lastSellerLine(context: string): string | undefined {
  const lines = context.split("\n").filter((l) => l.startsWith("Seller:"));
  return lines.length ? lines[lines.length - 1].slice(7).trim() || undefined : undefined;
}

/** "quantity 20", "variation L", for the reply and the "which?" question. */
function describeChanges(c: Changes): string {
  return [
    c.price != null ? `price ${c.price}` : null,
    c.quantity != null ? `quantity ${c.quantity}` : null,
    c.variations ? `variation${c.variations.length > 1 ? "s" : ""} ${c.variations.join(", ")}` : null,
    c.title ? `name "${c.title}"` : null,
    c.brand ? `brand ${c.brand}` : null,
    c.color ? `colour ${c.color}` : null,
    c.sale ? "sale price" : null,
  ].filter(Boolean).join(", ");
}

export interface ApplyResult { done: string[]; problems: string[]; editor: boolean }

/** One product's changes, with the same rules as the rest of the bot. */
export async function applyChanges(userId: string, listing: ListingRow, changes: Changes, message: string): Promise<ApplyResult> {
  const result: ApplyResult = { done: [], problems: [], editor: false };
  if (!EDITABLE.has(listing.status)) {
    result.problems.push("it's already with Jumia, so it's changed in Jumia Vendor Center");
    return result;
  }

  const update: Record<string, unknown> = {};
  const sources = { ...((listing.field_sources as Record<string, string> | null) ?? {}) };

  if (changes.price != null) {
    const minimum = await priceMinimumForUser(userId);
    if (!(changes.price > 0)) {
      result.problems.push("a price has to be more than 0, so the price stays as it was");
    } else if (isBelowMinimum(changes.price, minimum)) {
      result.problems.push(`${money(changes.price, minimum.currency)} is below the lowest price Jumia allows (${money(minimum.min, minimum.currency)}), so the price stays as it was`);
    } else {
      update.selling_price = changes.price;
      result.done.push(`price ${await chatPrice(userId, changes.price)}`);
    }
  }
  if (changes.quantity != null) {
    update.quantity = changes.quantity;
    result.done.push(`quantity ${changes.quantity}`);
  }
  if (changes.title) {
    if (changes.title.length < 15) result.problems.push(`Jumia needs a name of at least 15 characters, and "${changes.title}" has ${changes.title.length}`);
    else { update.title = changes.title.slice(0, 255); sources.title = "user"; result.done.push(`name "${changes.title}"`); }
  }
  if (changes.brand) {
    if (checkRestrictedBrand(changes.brand, listing.category_path).status === "forbidden") {
      result.problems.push(`Jumia doesn't allow the brand ${changes.brand} in this category`);
    } else {
      update.brand = changes.brand.slice(0, 100); sources.brand = "user"; result.done.push(`brand ${changes.brand}`);
    }
  }
  if (changes.color) {
    update.color = changes.color.slice(0, 60); sources.color = "user"; result.done.push(`colour ${changes.color}`);
  }
  if (changes.sale) {
    // Jumia needs the sale price and both dates together, as in handleEdit.
    const sale = extractSalePrice(message, new Date(), await shopCurrencyForUser(userId));
    if (sale && sale.startDate && sale.endDate) {
      update.sale_price = sale.salePrice; update.sale_start_date = sale.startDate; update.sale_end_date = sale.endDate;
      result.done.push(`sale price ${await chatPrice(userId, sale.salePrice)} from ${sale.startDate} to ${sale.endDate}`);
    } else {
      result.problems.push(sale
        ? "a sale price needs its start and end dates with it, e.g. \"sale 80 from 20 Oct to 30 Oct\""
        : "I couldn't read the sale price: send it like \"sale 80 from 20 Oct to 30 Oct\"");
    }
  }

  if (Object.keys(update).length > 0) {
    const { error } = await createServerClient()
      .from("listings")
      .update({ ...update, field_sources: sources, updated_at: new Date().toISOString() })
      .eq("id", listing.id)
      .eq("user_id", userId);
    if (error) {
      console.warn(`[assistant] saving listing ${listing.id} failed: ${error.message}`);
      return { done: [], problems: ["I couldn't save that just now. Send it again in a moment"], editor: false };
    }
    if (update.selling_price != null) await carryPriceToVariants(listing.id, listing.selling_price, changes.price!);
    if (update.quantity != null) {
      const followed = await carryStockToVariants(listing.id, listing.quantity, changes.quantity!);
      if (followed > 1) result.done[result.done.indexOf(`quantity ${changes.quantity}`)] = `quantity ${changes.quantity} for each of its ${followed} variations`;
    }
    if (update.sale_price != null) {
      await carrySaleToVariants(listing.id, listing, {
        salePrice: update.sale_price as number, startDate: update.sale_start_date as string, endDate: update.sale_end_date as string,
      });
    }
  }

  // Variations last, so new rows take the price and stock just set.
  if (changes.variations) {
    const options = await variationOptions(Number(listing.category_code)).catch(() => [] as string[]);
    // One at a time: an option itself ("Black and White") stays whole.
    const each = changes.variations.map((v) => options.find((o) => o.toLowerCase() === v.toLowerCase()) ?? parseVariations(options, v));
    const parsed: ReturnType<typeof parseVariations> = each.some((e) => typeof e !== "string" && !e.ok)
      ? { ok: false, unknown: each.flatMap((e) => (typeof e !== "string" && !e.ok ? e.unknown : [])) }
      : { ok: true, values: Array.from(new Set(each.flatMap((e) => (typeof e === "string" ? [e] : e.ok ? e.values : [])))) };
    if (!parsed.ok) {
      const shown = options.length > 12 ? `${options.slice(0, 12).join(", ")}...` : options.join(", ");
      result.problems.push(`${parsed.unknown.join(", ")} isn't one of this category's options${shown ? ` (${shown})` : ""}`);
    } else if (await saveVariations(listing.id, parsed.values)) {
      result.done.push(`variation${parsed.values.length > 1 ? "s" : ""} ${parsed.values.join(", ")}`);
    } else {
      result.problems.push("I couldn't save the variations just now. Send them again in a moment");
    }
  }

  if (changes.other) {
    result.problems.push(`I can't change the ${changes.other} in chat yet: tap *Edit product*`);
    result.editor = true;
  }
  return result;
}

function productLabel(p: ProductFacts, total: number): string {
  const name = p.listing.title ? ` (${p.listing.title.length > 40 ? `${p.listing.title.slice(0, 39)}…` : p.listing.title})` : "";
  return total > 1 ? `Product ${p.seq}${name}` : (p.listing.title ?? "Your product");
}

/** Apply `changes` to these products; the reply lines and the product to open in the editor, if any. */
async function applyToProducts(
  userId: string, products: ProductFacts[], seqs: number[], changes: Changes, message: string,
): Promise<{ lines: string[]; editorFor: string | null; changed: number; variationsSaved: string[] }> {
  const lines: string[] = [];
  let editorFor: string | null = null;
  let changed = 0;
  const variationsSaved: string[] = [];
  for (const seq of seqs) {
    const p = products.find((x) => x.seq === seq);
    if (!p) continue;
    const r = await applyChanges(userId, p.listing, changes, message);
    const label = productLabel(p, products.length);
    if (r.done.length > 0) { lines.push(`✅ ${label}: ${r.done.join(", ")}.`); changed++; }
    for (const problem of r.problems) lines.push(`⚠️ ${label}: ${problem}.`);
    if (r.editor) editorFor = p.listing.id;
    if (r.done.some((d) => d.startsWith("variation"))) variationsSaved.push(p.listing.id);
  }
  return { lines, editorFor, changed, variationsSaved };
}

const SUBMIT_ALL   = { id: "submit all", title: "Submit all ✅" };
const REVIEW       = { id: "review", title: "Review listings" };
const START_ANOTHER = { id: "start another", title: "Start another ➕" };

/** Over Meta's 1,024 characters an interactive message fails: the lines go first as text. */
async function fitBody(phone: string, lines: string[], short: string): Promise<string> {
  const body = lines.join("\n");
  if (body.length <= INTERACTIVE_BODY_MAX) return body;
  for (const part of splitForText(body)) await sendTextIfConfigured(phone, part);
  return short;
}

async function sendEditReply(phone: string, lines: string[], editorFor: string | null): Promise<void> {
  const body = await fitBody(phone, lines, editorFor ? "For the rest, edit it here:" : "Anything else to change?");
  if (editorFor) await sendCtaUrlIfConfigured(phone, body, "Edit product", focusedEditorUrl(editorFor));
  else await sendButtonsIfConfigured(phone, body, [SUBMIT_ALL, REVIEW]);
}

/** "Which product do you mean?", with the change kept until the answer comes. */
async function askWhich(
  phone: string, batchId: string, products: ProductFacts[], part: EditPart, message: string, lead: string[],
): Promise<void> {
  const candidates = products.filter((p) => part.seqs.includes(p.seq));
  const change = describeChanges(part.changes);
  const pending: AssistantPending = { batchId, seqs: candidates.map((p) => p.seq), changes: part.changes as Record<string, unknown>, message, at: new Date().toISOString() };
  // The other questions' pointers go: a number now answers this one.
  await updateSession(phone, { assistantPending: pending, awaitingPriceFor: null, awaitingValueFor: null });

  const short = (t: string | null) => !t ? "(no name yet)" : t.length > 40 ? `${t.slice(0, 39)}…` : t;
  const question = [
    `Which product do you mean${change ? ` (${change})` : ""}?`,
    ...candidates.map((p) => `${p.seq}. ${short(p.listing.title)}`),
    "",
    "Tap it, or reply with its number.",
  ];
  let body = [...lead, ...(lead.length > 0 ? [""] : []), ...question].join("\n");
  if (body.length > INTERACTIVE_BODY_MAX) {
    // What was changed goes first as text; the question stays with its taps.
    if (lead.length > 0) for (const part of splitForText(lead.join("\n"))) await sendTextIfConfigured(phone, part);
    body = await fitBody(phone, question, `Which product do you mean${change ? ` (${change})` : ""}? Tap it, or reply with its number.`);
  }
  const all = candidates.length === 2 ? "Both" : `All ${candidates.length}`;
  if (candidates.length === 2) {
    await sendButtonsIfConfigured(phone, body, [
      ...candidates.map((p) => ({ id: `apick:${p.seq}`, title: `${p.seq}. ${p.listing.title ?? "Product"}`.slice(0, 20) })),
      { id: "apick:all", title: all },
    ]);
    return;
  }
  const rows = candidates.slice(0, 9).map((p) => ({
    id: `apick:${p.seq}`,
    title: `Product ${p.seq}`,
    description: (p.listing.title ?? "").slice(0, 72) || undefined,
  }));
  await sendListIfConfigured(phone, body, "Choose product", [...rows, { id: "apick:all", title: all }]);
}

async function logTurn(userId: string, stage: Stage, message: string, action: AssistantAction | null, outcome: string, raw?: string): Promise<void> {
  try {
    await createServerClient().from("whatsapp_assistant_log").insert({
      user_id: userId, stage, message: message.slice(0, 1000), action, outcome, ...(raw != null ? { raw: raw.slice(0, 2000) } : {}),
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn(`[assistant] log failed: ${(e as Error).message}`);
  }
}

/** The live product the seller last changed (or chose to), within half an hour: what "it" means next. */
async function lastChangedSid(userId: string): Promise<string | null> {
  const { data } = await createServerClient().from("jumia_product_changes").select("product_sid, created_at").eq("user_id", userId)
    .order("created_at", { ascending: false }).limit(5);
  const rows = ((data ?? []) as { product_sid: string | null; created_at: string }[])
    .filter((r) => r.product_sid && Date.now() - new Date(r.created_at).getTime() < 30 * 60_000)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return rows[0]?.product_sid ?? null;
}

export async function creditsReply(userId: string, phone: string): Promise<void> {
  if (await isUnmetered(userId)) {
    await sendTextIfConfigured(phone, "Your account isn't charged credits right now, so list as much as you like.");
    return;
  }
  const available = Math.max(0, await availableCredits(userId));
  const shown = Math.round(available * 100) / 100;
  const cost = await listingCreditCost(userId);
  await sendCtaUrlIfConfigured(
    phone,
    `You have ${shown} credit${shown === 1 ? "" : "s"}: ${creditReach(shown, cost)}. A listing costs ${cost} credits when it goes live on Jumia.`,
    "Buy credits",
    buyCreditsUrl(),
  );
}

/** A draft as drafted, for "show me the highlights you wrote for the first one". Pure. */
export function draftTextLines(p: ProductFacts, currency: string, of: number): string[] {
  const l = p.listing;
  const highlights = htmlToText(l.highlights ?? "");
  const description = htmlToText(l.description ?? "");
  return [
    `*Draft ${p.seq}${of > 1 ? ` of ${of}` : ""}: ${l.title ?? "(no name yet)"}*`,
    `Price: ${l.selling_price != null ? `${currency} ${l.selling_price}` : "not set yet"}${p.variations.length ? ` · ${p.variations.join(", ")}` : ""}`,
    "", "*Highlights:*", highlights || "(none written yet)",
    "", "*Description:*", description || "(none written yet)",
  ];
}

/**
 * handled: the assistant replied. default: nothing it should do here, so
 * the usual reply for this step goes out. failed: the AI couldn't be
 * reached, so the usual handling runs instead. step: the message carries
 * on what the seller is doing (an answer to the bot's question, a product's
 * notes), so the usual handling takes it. limited: past the day's global
 * ceiling, so the usual handling runs, saying the commands still work
 * where it has nothing else to say. { list }: between batches,
 * the seller wants to list this many products; the caller starts the
 * batch the usual way (credits checked, then the photo flow).
 */
export type AssistantOutcome = "handled" | "default" | "step" | "failed" | "limited" | { list: number };

/**
 * Understand `text` and act on it. `stage` says where the seller is (see
 * Stage); `hintSeq`, the product number they started the message with.
 */
export async function runAssistant(
  userId: string,
  phone: string,
  session: WhatsAppSession,
  text: string,
  stage: Stage,
  hintSeq?: number,
  opts: { position?: string; waitingFor?: string; answered?: { area?: string } } = {},
): Promise<AssistantOutcome> {
  // A button id from an older message ("apick:2", "value:3") isn't words to understand.
  if (/^[a-z_]+:\S+$/i.test(text.trim())) return "default";

  // The day's ceiling for everyone (lib/whatsapp/assistant-limits.ts): past
  // it, the fixed flow answers ("limited" runs the usual handling, which
  // says the commands still work where it has nothing else to say).
  const gate = await assistantGate(userId).catch(() => ({ ok: true }) as const);
  if (!gate.ok) {
    console.info(`[assistant] ${userId}: daily ceiling reached, fixed flow`);
    return "limited";
  }
  // Every few messages, what it remembers of the seller is brought up to date.
  await noteSellerMessage(userId);

  // Between batches, drafts not sent yet from either chat are theirs to edit or submit here.
  const borrowed = stage === "idle" ? await openDraftBatch(userId).catch(() => null) : null;
  const batchId = borrowed?.batchId ?? (stage === "sent" ? session.lastSubmittedBatchId : stage === "idle" ? null : session.batchId);
  const here = isWebAddress(phone) ? "web" : "whatsapp";
  const position = borrowed
    ? `drafts made ${borrowed.channel === here ? "here earlier" : borrowed.channel === "web" ? "on the website chat" : "on WhatsApp"} that aren't sent yet (listed below: they can edit, polish or submit them here)`
    : opts.position;
  // Agent mode reads first where it's on (every seller since 11 Oct, owner:
  // "make agent mode the main reader for everyone and keep the front door as
  // its automatic backup"); the front door reads what it can't. The old
  // one-call reader and its word rules are gone (step 2 of the plan).
  const viaAgent = await agentFor(userId);
  let actions: AssistantAction[];
  let links: Record<string, AssistantLink>;
  let raw: string;
  let products: ProductFacts[] = [];
  try {
    const conversation = await recentConversation(phone, text);
    products = batchId ? await productFacts(await batchListings(batchId, userId)) : [];
    const facts = {
      batchId, hintSeq, conversation, web: isWebAddress(phone), position, waitingFor: opts.waitingFor,
      listed: listedFresh(session),
    };
    const more = { ...facts, listedSids: session.lastListed?.sids, ...(opts.answered ? { answered: opts.answered } : {}) };
    let agentNote = "";
    let read: { actions: AssistantAction[]; links: Record<string, AssistantLink>; raw: string } | null = null;
    if (viaAgent) {
      const t0 = Date.now();
      try {
        const agent = await interpretThroughAgent(userId, stage, products, text, more);
        if (agent.clarify) {
          await sendClarify(phone, agent.clarify);
          await logTurn(userId, stage, text, agent.clarify as unknown as AssistantAction, `asked: ${agent.clarify.question}`.slice(0, 300), agent.raw);
          return "handled";
        }
        // Nothing it could do (every call failed the checks): the front door
        // reads it, rather than the message going unanswered.
        if (agent.actions.every((a) => a.type === "unclear") && Date.now() - t0 < 15_000) {
          agentNote = `[agent found nothing to do: ${agent.raw.slice(0, 160)}] `;
        } else {
          read = agent;
        }
      } catch (e) {
        // Slow or refused: the front door reads it, while there's time left in the request.
        if (Date.now() - t0 > 15_000) throw e;
        console.warn(`[assistant] agent failed for ${userId}, reading it through the front door: ${(e as Error).message}`);
        agentNote = `[agent failed: ${(e as Error).message.slice(0, 120)}] `;
      }
    }
    if (!read) {
      // The front door has its own backups (another model sorts or reads
      // when one fails); if it still fails, the turn fails to the flow.
      const door = await interpretThroughFrontDoor(userId, stage, products, text, more);
      if (door.action.type === "clarify") {
        await sendClarify(phone, door.action, door.area || undefined);
        await logTurn(userId, stage, text, door.action as unknown as AssistantAction, `asked: ${door.action.question}`.slice(0, 300), agentNote + door.raw);
        return "handled";
      }
      read = { actions: [door.action as AssistantAction], links: door.links, raw: agentNote + door.raw };
    }
    ({ actions, links, raw } = read);
  } catch (e) {
    console.warn(`[assistant] interpreting for ${userId} failed: ${(e as Error).message}`);
    await logTurn(userId, stage, text, null, `failed: ${(e as Error).message}`);
    return "failed";
  }
  console.info(`[assistant] ${userId} (${stage}): ${actions.map((a) => a.type).join(" + ")}`);

  // Several things asked at once (agent mode): each carried out in order, as
  // if asked one after the other. Listing new products comes last: the
  // caller starts the batch once the rest is answered.
  let outcome = "default";
  let list: number | null = null;
  for (let i = 0; i < actions.length; i++) {
    const action = actions[i];
    const why = i === 0 ? raw : undefined;
    if (action.type === "list" && (stage === "idle" || stage === "sent")) {
      await logTurn(userId, stage, text, action, `list ${action.count}`, why);
      list = action.count;
      continue;
    }
    // Drafts from the other chat (or an earlier batch) are edited and submitted as a review.
    const actStage: Stage = borrowed && (action.type === "edit" || action.type === "submit" || action.type === "review" || action.type === "polish") ? "review" : stage;
    const done = await carryOut(userId, phone, actStage, batchId, products, action, text, links, actStage !== stage && batchId ? { ...session, batchId } : session);
    await logTurn(userId, stage, text, action, done, why);
    // With others beside it, a step or "nothing to do here" doesn't hand the message back to the flow.
    if (actions.length === 1 || (done !== "default" && done !== "step")) outcome = actions.length === 1 ? done : "handled";
    // Starting a batch: after answering, where they are (a reply carries it already).
    if (stage === "starting" && action.type !== "reply" && action.type !== "not_yet" && done !== "default" && done !== "step" && done !== "stopped batch" && done !== "kept batch"
      && i === actions.length - 1) {
      await sendTextIfConfigured(phone, startingNudge(session));
    }
  }
  if (list != null) return { list };
  return outcome === "default" ? "default" : outcome === "step" ? "step" : "handled";
}

async function carryOut(
  userId: string, phone: string, stage: Stage, batchId: string | null, products: ProductFacts[], action: AssistantAction, text: string,
  links: Record<string, AssistantLink>, session: WhatsAppSession,
): Promise<string> {
  switch (action.type) {
    case "note":
      return "step";
    case "listings":
      return answerListings(userId, phone, action.period);
    case "edit": {
      if (stage !== "review" || !batchId) return "default";
      const clear = action.edits.filter((e) => !e.ask);
      const ambiguous = action.edits.find((e) => e.ask);
      const lines: string[] = [];
      let editorFor: string | null = null;
      const variationsSaved: string[] = [];
      for (const part of clear) {
        const r = await applyToProducts(userId, products, part.seqs, part.changes, text);
        lines.push(...r.lines);
        editorFor = r.editorFor ?? editorFor;
        variationsSaved.push(...r.variationsSaved);
      }
      // The bot's "What variation(s) do you have?" is answered.
      const asked = session.awaitingValueFor;
      if (asked?.field === VARIATION_FIELD && variationsSaved.includes(asked.listingId)) await updateSession(phone, { awaitingValueFor: null });
      if (action.dropped.length > 0) {
        const EXAMPLES: Record<string, string> = {
          price: "price 150", quantity: "quantity 20", variations: "variation Large", name: "name Hisense 205L Double Door Fridge",
          colour: "colour Blue", brand: "brand Hisense",
        };
        const examples = action.dropped.map((d) => `"${EXAMPLES[d] ?? d}"`).join(" or ");
        lines.push(`⚠️ I couldn't see the new ${action.dropped.join(" or ")} in your message. Write it out, e.g. ${examples}.`);
      }
      if (ambiguous) {
        await askWhich(phone, batchId, products, ambiguous, text, lines);
        return `asked which of ${ambiguous.seqs.join(", ")}`;
      }
      if (lines.length === 0) return "default";
      await sendEditReply(phone, lines, editorFor);
      return lines.join(" | ");
    }
    case "submit": {
      if (stage !== "review") return "default";
      const all = action.seqs === "all" || action.seqs.length === products.length;
      const which = all ? (products.length === 1 ? "your product" : `all ${products.length} products`) : `product${(action.seqs as number[]).length > 1 ? "s" : ""} ${(action.seqs as number[]).join(", ")}`;
      await sendButtonsIfConfigured(phone, `Send ${which} to Jumia?`, [
        { id: all ? "submit all" : `submit ${(action.seqs as number[]).join(" ")}`, title: "Yes, submit ✅" },
        REVIEW,
      ]);
      return "offered submit";
    }
    case "list":   // in review: like starting over, offered as a tap
    case "restart": {
      // Mid-batch, asked before anything stops (the photos so far stay with their products).
      if (stage === "collecting" || stage === "drafting") {
        await sendButtonsIfConfigured(phone, "Stop this batch and start over? Anything already drafted stays on the review page.", [
          { id: "restart", title: "Yes, start over" },
          { id: "status", title: "No, keep going" },
        ]);
        return "offered restart";
      }
      if (stage === "starting") {
        if (action.type === "list") {
          await sendTextIfConfigured(phone, `You're set up for ${session.batchSize ?? 1} product${session.batchSize === 1 ? "" : "s"}. Say *restart* to change the number.`);
          return "kept batch";
        }
        await resetSession(phone);
        await sendTextIfConfigured(phone, "OK, I've stopped this batch. Tell me what you'd like to do for your Jumia shop, or how many products you're listing when you're ready.");
        return "stopped batch";
      }
      if (stage === "review") {
        // A count they gave starts that batch on the tap; a count typed
        // after this offer does too (lib/whatsapp/intake.ts).
        const count = action.type === "list" ? action.count : null;
        await sendButtonsIfConfigured(
          phone,
          count ? `Start a new batch of ${count}? Drafts you haven't sent stay on your review page.` : "Start a new batch? Drafts you haven't sent stay on your review page.",
          [count ? { id: `start another ${count}`, title: `Yes, list ${count}` } : START_ANOTHER, REVIEW],
        );
      } else {
        await sendButtonsIfConfigured(phone, "Let's list! How many products are you listing today?", COUNT_QUICK_PICKS);
      }
      return "offered restart";
    }
    case "review": {
      if (!batchId) return "default";
      await sendCtaUrlIfConfigured(phone, stage === "review" ? "Here's your batch:" : "Here are the products you sent:", "Review listings", whatsappListingsUrl(batchId));
      return "sent review link";
    }
    case "orders":
      return (await handleOrderMessage(userId, phone, "orders")) ? "showed orders" : "default";
    case "credits":
      await creditsReply(userId, phone);
      return "sent credits";
    case "help":
      await sendHelp(userId, phone);
      return "sent help";
    case "live_change":
      return proposeLiveChange(userId, phone, action.others ? [action.product, ...action.others] : action.product, action.change, {
        preferSid: action.fromContext ? await lastChangedSid(userId) : null,
        ...(action.fromContext ? { fromContext: true } : {}),
        ...(action.all ? { all: true } : {}),
      });
    case "product_info":
      return answerProductInfo(userId, phone, action.product);
    case "product_text":
      return answerProductText(userId, phone, action.product);
    case "draft_text": {
      const shown = products.filter((p) => action.seqs.includes(p.seq));
      if (!batchId || shown.length === 0) return "default";
      const currency = await shopCurrencyForUser(userId).catch(() => "GHS");
      await sendLong(phone, shown.map((p) => draftTextLines(p, currency, products.length).join("\n")).join("\n\n———\n\n"));
      await sendCtaUrlIfConfigured(phone, `To change ${shown.length === 1 ? "it" : "them"}, tell me here (e.g. "change draft ${shown[0].seq}'s name to …"), or edit on the review page:`, "Review listings", whatsappListingsUrl(batchId));
      return `draft text ${shown.map((p) => p.seq).join(", ")}`;
    }
    case "fix_rejected":
      return fixRejected(userId, phone, action.product, action.reason);
    case "add_size":
      return proposeAddSize(userId, phone, action.product, action.request);
    case "add_photos": {
      const { startAddPhotos } = await import("@/lib/whatsapp/live-photos");
      return startAddPhotos(userId, phone, action.product);
    }
    case "fees": {
      // A draft here ("what will I get for the wig?") is worked out from the draft.
      const draft = products.find((p) => fitsDraft(action.product, p.listing.title) && namesAProduct(action.product) && draftWords(action.product).length > 0);
      return answerFees(userId, phone, action.product, action.price, draft ? {
        name: draft.listing.title ?? "Your product", price: draft.listing.selling_price ?? null, categoryPath: draft.listing.category_path ?? null,
      } : undefined);
    }
    case "stock":
      return answerStock(userId, phone, action.product, action.filter);
    case "shop":
      return answerProducts(userId, phone, action.filter);
    case "order_status":
      return answerOrderStatus(userId, phone, action.number);
    case "sales":
      return answerSales(userId, phone, action.period, action.status);
    case "payouts":
      return answerPayouts(userId, phone);
    case "payout_detail":
      return answerPayoutDetail(userId, phone, action.mode, action.statement);
    case "report":
      return answerReport(userId, phone, action.kind, action.period);
    case "bulk":
      return proposeBulkChange(userId, phone, action.scope, action.words, action.change, action.scope === "listed" ? session.lastListed?.sids ?? [] : []);
    case "content_change":
      return proposeContentChange(userId, phone, action.product, action.request);
    case "brand_check":
      return answerBrand(userId, phone, action.brand, action.product);
    case "category_info":
      return answerCategoryNeeds(userId, phone, action.product);
    case "shops":
      return answerLinkedShops(userId, phone);
    case "polish": {
      const { runChatCommand } = await import("@/lib/whatsapp/chat-commands");
      await runChatCommand({ type: "polish", seq: action.seq }, userId, phone, session);
      return "polish";
    }
    case "health_report": {
      const { answerHealthReport } = await import("@/lib/whatsapp/shop-health");
      return answerHealthReport(userId, phone);
    }
    case "research":
      return answerResearch(userId, phone, text, action.needs);
    case "warehouse_stock":
      return answerWarehouseStock(userId, phone, action.product);
    case "warehouse_order":
      return proposeWarehouseOrder(userId, phone, action.items, action.date);
    case "warehouse_shipped":
      return proposeWarehouseShipped(userId, phone, action.po, action.tracking, action.carrier);
    case "reply": {
      // The AI's own words. With a link, it's the button; in review, the
      // reply keeps the step's own two buttons. Starting a batch, where
      // they are goes in the same message (one message, not two).
      const link = action.link ? links[action.link] : null;
      const text = stage === "starting" ? `${action.text}\n\n${startingNudge(session)}`
        : stage === "collecting" ? `${action.text}\n\n${collectingNudge(session)}` : action.text;
      if (action.awaiting) {
        const ask: LiveValueAsk = {
          kind: "live_value", field: action.awaiting.field, products: action.awaiting.products,
          preferSid: action.awaiting.fromContext ? await lastChangedSid(userId) : null, at: new Date().toISOString(),
        };
        await updateSession(phone, { assistantPending: ask });
      }
      if (link) await sendCtaUrlIfConfigured(phone, text, link.label, link.url);
      else if (stage === "review") await sendButtonsIfConfigured(phone, text, [SUBMIT_ALL, REVIEW]);
      else await sendTextIfConfigured(phone, text);
      return link ? `replied with ${action.link}` : action.awaiting ? `asked for ${action.awaiting.field}` : "replied";
    }
    case "not_yet": {
      // A fixed answer, sent the way a reply is (with where they are while a batch is on).
      const answer = action.outside ? OUTSIDE_TEXT : action.text ?? NOT_YET_TEXT;
      if (!action.outside) await noteWish(userId, phone, action, text);
      await carryOut(userId, phone, stage, batchId, products, { type: "reply", text: answer, link: null }, text, links, session);
      return `${action.outside ? "outside" : "not yet"}: ${action.what}${action.blocked ? " (its reply said it can't)" : ""}`.slice(0, 300);
    }
    case "unclear":
      return "default";
  }
  return "default";
}

/**
 * What a seller asked for that PandaWorld doesn't do, for the wish list
 * (/admin/wishes): the AI's words for it, their message, and the reply that
 * was stopped when it said it can't. Best-effort: the answer goes either way.
 */
async function noteWish(userId: string, phone: string, action: Extract<AssistantAction, { type: "not_yet" }>, message: string): Promise<void> {
  try {
    const { error } = await createServerClient().from("assistant_wishes").insert({
      user_id: userId, channel: isWebAddress(phone) ? "web" : "whatsapp", request: action.what.slice(0, 200), message: message.slice(0, 1000),
      blocked_reply: action.blocked ?? null,
    });
    if (error) console.warn(`[assistant] noting a wish for ${userId} failed: ${error.message}`);
  } catch (e) {
    console.warn(`[assistant] noting a wish for ${userId} failed: ${(e as Error).message}`);
  }
}

/** While a batch's photos come in: where they are, after an answer to something else. */
function collectingNudge(session: WhatsAppSession): string {
  const seq = session.batchSeq ?? 1;
  const size = session.batchSize ?? 1;
  const quiet = session.batchQuiet ?? (size > 1 ? session.preferredBatchQuiet : null) ?? false;
  return `_Still on product ${seq}${size > 1 ? ` of ${size}` : ""}: send its photos and details, then ${quiet ? `*${seq}*` : "*done*"}._`;
}

const startingNudge = (session: WhatsAppSession) =>
  `📸 I'm still ready for product ${session.batchSeq ?? 1} of ${session.batchSize ?? 1}: send its photos when you're ready, or say *restart* to stop.`;

/** A "What should its stock be?" older than this is no longer what a number answers. */
const LIVE_VALUE_TTL_MS = 10 * 60_000;

/**
 * The answer to the assistant's "What should its stock be?" about live
 * products: a bare number ("10", "stock 10", "GHS 150"). The change is then
 * offered for its tap as usual. Anything else drops the question (false):
 * the message is handled as usual. A bare "10" used to start a batch of 10
 * here (owner's second test, 2026-10-07).
 */
export async function answerLiveValue(userId: string, phone: string, session: WhatsAppSession, text: string | undefined): Promise<boolean> {
  const pending = session.assistantPending;
  if (!pending || !("kind" in pending) || pending.kind !== "live_value") return false;
  const fresh = Date.now() - new Date(pending.at).getTime() < LIVE_VALUE_TTL_MS;
  const m = (text ?? "").trim().match(/^(?:(?:stock|qty|quantity|price|make it|set it to|to|it'?s|=)\s*:?\s*)?(?:[a-z]{3}|gh₵|₦|₵)?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:pcs|pieces|units|each|cedis|naira)?\s*[.!]?$/i);
  await updateSession(phone, { assistantPending: null });
  if (!fresh || !m) return false;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const change: LiveChange | null = pending.field === "stock"
    ? (Number.isInteger(n) && n >= 0 ? { kind: "stock", stock: n } : null)
    : (n > 0 ? { kind: "price", price: n } : null);
  if (!change) return false;
  const outcome = await proposeLiveChange(userId, phone, pending.products.length === 1 ? pending.products[0] : pending.products, change, { preferSid: pending.preferSid });
  await logTurn(userId, "idle", text ?? "", null, `answered ${pending.field}: ${outcome}`);
  return true;
}

/**
 * The answer to askWhich's question: a tap (`apick:2`, `apick:all`), a
 * product number or several, or "both"/"all". False for anything else:
 * the caller drops the question and handles the message as usual.
 */
export async function answerPendingQuestion(
  userId: string, phone: string, session: WhatsAppSession, text: string,
): Promise<boolean> {
  const pending = session.assistantPending;
  if (!pending || "kind" in pending) return false;
  if (pending.batchId !== session.batchId || Date.now() - new Date(pending.at).getTime() > PENDING_TTL_MS) return false;

  const t = text.trim();
  const listings = await batchListings(pending.batchId, userId);
  const inBatch = new Set(listings.map((l, i) => l.whatsapp_seq ?? i + 1));
  let seqs: number[] | null = null;
  if (/^apick:all$/i.test(t) || /^(all|both|all of them|all \d+|each|each of them|every one|everything)[.!]?$/i.test(t)) {
    seqs = pending.seqs;
  } else {
    const tap = /^apick:(\d+)$/i.exec(t);
    const typed = /^(?:products?\s*)?#?\d{1,2}(?:\s*(?:,|&|and)\s*#?\d{1,2})*[.!]?$/i.test(t) ? (t.match(/\d{1,2}/g) ?? []).map(Number) : null;
    const picked = tap ? [Number(tap[1])] : typed;
    if (picked) seqs = picked.filter((n) => inBatch.has(n));
  }
  if (!seqs || seqs.length === 0) return false;

  await updateSession(phone, { assistantPending: null });
  const products = await productFacts(listings);
  const r = await applyToProducts(userId, products, seqs, pending.changes as Changes, pending.message);
  const lines = r.lines.length > 0 ? r.lines : ["Nothing changed there."];
  await sendEditReply(phone, lines, r.editorFor);
  await logTurn(userId, "review", text, null, `answered which: ${seqs.join(", ")}: ${lines.join(" | ")}`);
  return true;
}

// ─── A question, not a product's notes ────────────────────────────────────

const QUESTION_START = /^(has|have|what|how|when|where|why|who|which|can|could|do|does|did|is|are|will|would|should|i won'?t|i don'?t|i do not|never ?mind|cancel|stop|forget it|no more|not now|i changed my mind)\b/i;

/**
 * Whether a message sent while starting a batch reads as something said to
 * the bot rather than about the product: a question, or calling it off.
 * "Price 200, sizes M and L" isn't; "Has Jumia paid me?" is.
 */
export function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  return t.includes("?") || QUESTION_START.test(t);
}

// ─── When the usual edit is enough ────────────────────────────────────────

/** Words naming something handleEdit can't change: these go to the assistant. */
const OTHER_FIELD_RE = /\b(variations?|variants?|sizes?|colou?rs?|title|name|rename|brand|material|model|weight|description|category|all|both|each)\b/i;

/**
 * Whether the review step's usual edit (handleEdit: price, stock, a sale
 * price) covers this text on its own, so it stays the instant, free path
 * the seller already knows: "2: price 150", "quantity 20". Given whether
 * handleEdit's own extractors found anything in it.
 */
export function plainQuickEdit(text: string, found: boolean): boolean {
  return found && !OTHER_FIELD_RE.test(text);
}
