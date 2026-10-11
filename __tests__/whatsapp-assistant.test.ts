/**
 * The WhatsApp assistant (lib/whatsapp/assistant.ts): the AI only picks an
 * action, and our code checks every part of it before anything changes.
 * The review step's flows run end to end in whatsapp-intake-flow.test.ts
 * ("the assistant, on the pilot's accounts"); this covers the checks
 * themselves and the steps between batches.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/auth/is-admin", () => ({ isAdmin: (id: string) => id === "admin" }));
let billingOn = true;
jest.mock("@/lib/billing/mode", () => ({ isBillingEnabled: async () => billingOn }));

const sent: { kind: string; body: string; rows?: string[]; button?: string; url?: string }[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured:    async (_to: string, body: string) => { sent.push({ kind: "text", body }); },
  sendButtonsIfConfigured: async (_to: string, body: string, b: { id: string }[]) => { sent.push({ kind: "buttons", body, rows: b.map((x) => x.id) }); },
  sendCtaUrlIfConfigured:  async (_to: string, body: string, button: string, url: string) => { sent.push({ kind: "cta", body, button, url }); },
  sendListIfConfigured:    async (_to: string, body: string, _b: string, r: { id: string }[]) => { sent.push({ kind: "list", body, rows: r.map((x) => x.id) }); },
  sendImagesIfConfigured:  async (_to: string, urls: string[], caption: string) => { sent.push({ kind: "images", body: caption, rows: urls }); },
}));

const orderCalls: string[] = [];
jest.mock("@/lib/whatsapp/orders", () => ({
  handleOrderMessage: async (_u: string, _p: string, text: string) => { orderCalls.push(text); return true; },
}));

const aiReplies: string[] = [];
const aiPrompts: string[] = [];
let aiCalls = 0;
// Agent mode's turns: each the tool calls it makes.
const toolReplies: { name: string; args: Record<string, unknown> }[][] = [];
// The tools each agent turn could call (null: any).
const toolAllowed: (string[] | null)[] = [];
// What each agent turn was given, as JSON: the conversation and the lookups' answers.
const toolTurns: string[] = [];
// The front door's sorting calls, answered "chat" unless a test scripts the area.
const routerPrompts: string[] = [];
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (model: string, parts: { text?: string }[]) => {
    const prompt = parts.map((p) => p.text ?? "").join("\n");
    if (prompt.startsWith("You sort one message") && !(aiReplies[0] ?? "").includes('"area"')) {
      routerPrompts.push(prompt);
      return { text: '{"area":"chat","also":null}', model, backend: "vertex" };
    }
    aiCalls++;
    aiPrompts.push(prompt);
    const text = aiReplies.shift();
    if (text == null) throw new Error("no AI reply scripted");
    return { text, model, backend: "vertex" };
  },
  callGeminiWithTools: async (_model: string, turns: unknown[], opts: { system: string; allowed?: string[] }) => {
    aiCalls++;
    aiPrompts.push(opts.system);
    toolTurns.push(JSON.stringify(turns));
    toolAllowed.push(opts.allowed ?? null);
    const calls = toolReplies.shift();
    if (calls == null) throw new Error("no tool calls scripted");
    return { calls, text: "", turn: { role: "model", parts: calls.map((c) => ({ functionCall: c })) }, backend: "ai-studio" };
  },
}));

const shopCalls: unknown[][] = [];
jest.mock("@/lib/whatsapp/shop", () => ({
  proposeLiveChange: async (...a: unknown[]) => { shopCalls.push(["proposeLiveChange", ...a.slice(2)]); return "offered"; },
  answerStock:       async (...a: unknown[]) => { shopCalls.push(["answerStock", ...a.slice(2)]); return "stock"; },
  answerProducts:    async (...a: unknown[]) => { shopCalls.push(["answerProducts", ...a.slice(2)]); return "overview"; },
  answerOrderStatus: async (...a: unknown[]) => { shopCalls.push(["answerOrderStatus", ...a.slice(2)]); return "order"; },
  answerSales:       async (...a: unknown[]) => { shopCalls.push(["answerSales", ...a.slice(2)]); return "sales"; },
  answerPayouts:     async (...a: unknown[]) => { shopCalls.push(["answerPayouts", ...a.slice(2)]); return "payouts"; },
  answerProductInfo: async (...a: unknown[]) => { shopCalls.push(["answerProductInfo", ...a.slice(2)]); return "info"; },
  answerFees:        async (...a: unknown[]) => { shopCalls.push(["answerFees", ...a.slice(2)]); return "fees"; },
  proposeBulkChange: async (...a: unknown[]) => { shopCalls.push(["proposeBulkChange", ...a.slice(2)]); return "bulk"; },
  proposeContentChange: async (...a: unknown[]) => { shopCalls.push(["proposeContentChange", ...a.slice(2)]); return "content"; },
  answerProductText: async (...a: unknown[]) => { shopCalls.push(["answerProductText", ...a.slice(2, 3)]); return "text"; },
  // Two sets fit "nasco kettle": the "which one?" the shop module would ask.
  answerProductPhotos: async (...a: unknown[]) => {
    shopCalls.push(["answerProductPhotos", ...a.slice(2, 3)]);
    const which = a[3] as ((sets: unknown[]) => Promise<string>) | undefined;
    return a[2] === "nasco kettle" && which
      ? which([{ sellerSku: "NAS-K", name: "Nasco Electric Kettle 1.7L" }, { sellerSku: "NAS-K2", name: "Nasco Electric Kettle 2.2L Stainless" }])
      : "photos";
  },
  productDetailsLookup: () => async (words: string) => (words.includes("kettle") ? ["Name: Nasco Electric Kettle 1.7L\nDetails: color=Silver; what_is_in_the_box=1 kettle, 1 base"] : []),
  whereLine: () => "ON · approved · price GHS 100 · stock 3",
  shorten: (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`),
  sendLong:          async (_to: string, body: string) => { sent.push({ kind: "text", body }); },
  htmlToText:        (html: string) => html.replace(/<li>/g, "• ").replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").trim(),
  MAX_GROUP: 20,
  BULK_MAX: 200,
}));

const SIZES = ["S", "M", "L", "XL", "XXL"];
jest.mock("@/lib/jumia/categories", () => ({
  getCategoryAttributes: async (code: number) =>
    code === 100 ? [{ name: "variation", label: "Size", type: "enum", allowed_values: SIZES, is_variant: true }] : [],
}));

import {
  NOT_YET_TEXT, OUTSIDE_TEXT, agentFor, agentModel, aiSaleWindow, answerLiveValue, answerProductPick, claimsInability, assistantEnabled, assistantFor, assistantLinks, cleanReply, countBacked, fitsDraft, isStateQuestion, looksLikeQuestion, messageNumbers,
   draftNumberIn, draftTextLines,  sameName, namesAProduct, contentAction, stockListWords, variationPricesIn, newestWithin, recentConversation, saidIsValues, saleWindow, salePriceIn, splitProducts, parseAction, plainQuickEdit, runAssistant, verifyChanges, type ProductFacts,
} from "@/lib/whatsapp/assistant";
import { assistantGate } from "@/lib/whatsapp/assistant-limits";
import { parseVariations } from "@/lib/whatsapp/variation-question";
import type { ListingRow } from "@/lib/supabase/types";
import type { WhatsAppSession } from "@/lib/whatsapp/session";

const product = (seq: number, title: string, extra: Partial<ProductFacts> = {}): ProductFacts => ({
  seq, listing: { id: `l${seq}`, title, status: "draft" } as ListingRow, variations: [], options: [], ...extra,
});
const FRIDGE = product(1, "Hisense 205L Double Door Fridge");
const SHIRT  = product(2, "Men's Cotton T-Shirt", { variations: ["M"], options: SIZES });

beforeEach(() => {
  db = new FakeDb();
  billingOn = true;
  sent.length = 0;
  orderCalls.length = 0;
  aiReplies.length = 0;
  aiPrompts.length = 0;
  routerPrompts.length = 0;
  toolReplies.length = 0;
  toolAllowed.length = 0;
  toolTurns.length = 0;
  shopCalls.length = 0;
  aiCalls = 0;
});

describe("what the message backs up", () => {
  it("reads the numbers a seller writes", () => {
    expect(messageNumbers("quantity 20")).toEqual([20]);
    expect(messageNumbers("make it 1,500 cedis")).toEqual([1500]);
    expect(messageNumbers("2.5k")).toEqual([2.5, 2500]);
    expect(messageNumbers("no numbers")).toEqual([]);
  });

  it("keeps a price or quantity only when the message says it", () => {
    expect(verifyChanges({ price: 1500, quantity: 20 }, "price 1,500 and 20 pieces", { options: [], variations: [] }))
      .toEqual({ changes: { price: 1500, quantity: 20 }, dropped: [] });
    expect(verifyChanges({ price: 999 }, "make it cheaper", { options: [], variations: [] }))
      .toEqual({ changes: {}, dropped: ["price"] });
    expect(verifyChanges({ quantity: 2.5 }, "quantity 2.5", { options: [], variations: [] }).dropped).toEqual(["quantity"]);
  });

  it("keeps a name, brand or colour only when it's written in the message", () => {
    const msg = "rename it to Hisense 205L Double Door Refrigerator and the colour is silver";
    expect(verifyChanges({ title: "Hisense 205L Double Door Refrigerator", color: "Silver" }, msg, { options: [], variations: [] }))
      .toEqual({ changes: { title: "Hisense 205L Double Door Refrigerator", color: "Silver" }, dropped: [] });
    expect(verifyChanges({ brand: "Samsung" }, msg, { options: [], variations: [] }).dropped).toEqual(["brand"]);
  });

  it("takes a variation the seller wrote, one of the category's options, or one the product has", () => {
    const known = { options: SIZES, variations: ["M"] };
    // In the category's own spelling: its "L".
    expect(verifyChanges({ variations: ["Large"] }, "change the variation to Large", known).changes).toEqual({ variations: ["L"] });
    expect(verifyChanges({ variations: ["L"] }, "change the variation to Large", known).changes).toEqual({ variations: ["L"] });
    expect(verifyChanges({ variations: ["M", "XL"] }, "add XL too", known).changes).toEqual({ variations: ["M", "XL"] });
  });

  it("keeps the variations the message backs, and leaves out one the AI made up", () => {
    expect(verifyChanges({ variations: ["Huge", "Large"] }, "make it Large", { options: [], variations: [] }))
      .toEqual({ changes: { variations: ["Large"] }, dropped: [] });
    // "Can you add Blue variant to the wig" (live, 2026-10-07): the current one and the new one.
    expect(verifyChanges({ variations: ["24 Inch", "Blue"] }, "Can you add Blue variant to the wig product you drafted?", { options: [], variations: ["24 Inch"] }))
      .toEqual({ changes: { variations: ["24 Inch", "Blue"] }, dropped: [] });
    expect(verifyChanges({ variations: ["Huge"] }, "make it Large", { options: [], variations: [] })).toEqual({ changes: {}, dropped: ["variations"] });
  });

  // The owner's web chat, 2026-10-07, answering "What variation(s) do you have?".
  const BODYSUIT_MSG = "Price: 130gh \nSizes: Large, Medium, Small.\nColors: cream, black and brown";

  it("takes only the sizes the seller named, never the category's whole list", () => {
    const options = ["S", "M", "L", "XS", "XXL", "XS AB", "S-M", "L/XL", "ONE SIZE FITS ALL", "EU XS", "UK 4"];
    // The AI sent every option back; only the three named stay.
    expect(verifyChanges({ variations: options }, BODYSUIT_MSG, { options, variations: [] }).changes).toEqual({ variations: ["S", "M", "L"] });
    // "it's" isn't an "S".
    expect(verifyChanges({ variations: ["S"] }, "it's lovely", { options, variations: [] }).changes).toEqual({});
    expect(verifyChanges({ variations: ["L"] }, "change the variation to 'L'", { options, variations: [] }).changes).toEqual({ variations: ["L"] });
  });

  // Owner, 2026-10-07: "what if it was a different word with its
  // interpretation in the variation list acceptable for that category".
  it("takes the AI's reading of the seller's words as one of the category's options, checked both ways", () => {
    const options = ["XS", "S", "M", "L", "XL", "ONE SIZE FITS ALL", "EU 40", "EU 42", "UK 10", "3-4 Years", "1L", "Black and White"];
    const known = { options, variations: [] };
    const pairs = (...p: [string, string][]) => ({ variations: p.map(([said, option]) => ({ said, option })) });
    expect(verifyChanges(pairs(["free size", "ONE SIZE FITS ALL"]), "it's free size", known).changes).toEqual({ variations: ["ONE SIZE FITS ALL"] });
    expect(verifyChanges(pairs(["size 42", "EU 42"], ["size 40", "EU 40"]), "she has size 40 and size 42", known).changes).toEqual({ variations: ["EU 42", "EU 40"] });
    expect(verifyChanges(pairs(["ages 3 to 4", "3-4 Years"]), "for ages 3 to 4", known).changes).toEqual({ variations: ["3-4 Years"] });
    expect(verifyChanges(pairs(["one litre", "1L"]), "one litre bottle", known).changes).toEqual({ variations: ["1L"] });
    expect(verifyChanges(pairs(["black & white", "Black and White"]), "black & white", known).changes).toEqual({ variations: ["Black and White"] });
    // The AI's option in another spelling is the category's own (test runs of
    // 11 Oct: "Small, medium and, Large" came back as Small/Medium/Large and was dropped).
    expect(verifyChanges(pairs(["Small", "Small"], ["medium", "Medium"], ["Large", "Large"]), "change the variation to Small, medium and, Large", known).changes)
      .toEqual({ variations: ["S", "M", "L"] });
    expect(verifyChanges(pairs(["Large", "Large"], ["Medium", "Medium"], ["Small", "Small"]), "Chanage the draft variation to Large, Medium, Small.", known).changes)
      .toEqual({ variations: ["L", "M", "S"] });
    // An option that isn't on the list, or words the seller didn't write, aren't taken.
    expect(verifyChanges(pairs(["free size", "Free Size"]), "it's free size", known)).toEqual({ changes: {}, dropped: ["variations"] });
    expect(verifyChanges(pairs(["extra small", "XS"]), "make it large", known)).toEqual({ changes: {}, dropped: ["variations"] });
    // One phrase read as the whole list: none of it.
    expect(verifyChanges(pairs(...options.map((o): [string, string] => ["sizes", o])), "sizes please", known)).toEqual({ changes: {}, dropped: ["variations"] });
    // One phrase listing three is three; a range can be several.
    expect(verifyChanges(pairs(["Large, Medium, Small", "L"], ["Large, Medium, Small", "M"], ["Large, Medium, Small", "S"]), "Sizes: Large, Medium, Small", known).changes)
      .toEqual({ variations: ["L", "M", "S"] });
    expect(verifyChanges(pairs(["S to XL", "S"], ["S to XL", "M"], ["S to XL", "L"], ["S to XL", "XL"]), "S to XL", known).changes)
      .toEqual({ variations: ["S", "M", "L", "XL"] });
  });

  // Owner's web chat, 2026-10-08: "my message count so far" came back as
  // the draft's own sizes again, and the bot applied them.
  it("an edit needs something from this message: the product's current values alone are no change", () => {
    const BODY = product(1, "3-Piece Thong Bodysuit", { options: SIZES, variations: ["L", "M", "S"] });
    const raw = '{"type":"edit","edits":[{"products":[1],"said":null,"changes":{"variations":[{"said":"L","option":"L"},{"said":"M","option":"M"},{"said":"S","option":"S"}],"color":"cream, black and brown"},"ask":false}]}';
    expect(parseAction(raw, "my message count so far", [BODY], assistantLinks())).toEqual({ type: "unclear" });
    // Adding to them still keeps them.
    expect(verifyChanges({ variations: ["L", "M", "S", "XL"] }, "add XL too", { options: SIZES, variations: ["L", "M", "S"] }).changes)
      .toEqual({ variations: ["L", "M", "S", "XL"] });
  });

  // Same chat: "No the 150 is product 3 price" went to the live products on Jumia.
  it("a draft named by its number in the sentence is that draft", () => {
    const drafts = [product(1, "Thong Bodysuit"), product(2, "Vintage Radio Eau de Parfum"), product(3, "White Maple Leaf Flower Earrings")];
    expect(draftNumberIn("the 150 is product 3 price", drafts)).toBe(3);
    expect(draftNumberIn("#2", drafts)).toBe(2);
    expect(draftNumberIn("product 9", drafts)).toBeNull();
    const raw = '{"type":"edit","edits":[{"products":[3],"said":"the 150 is product 3 price","changes":{"price":150},"ask":false}]}';
    expect(parseAction(raw, "No the 150 is product 3 price", drafts, assistantLinks())).toEqual({
      type: "edit", edits: [{ seqs: [3], changes: { price: 150 }, ask: false }], dropped: [],
    });
  });

  it("keeps the seller's own colour words when the AI renames them", () => {
    expect(verifyChanges({ color: "Beige, Black, Brown" }, BODYSUIT_MSG, { options: [], variations: [] }))
      .toEqual({ changes: { color: "cream, black and brown" }, dropped: [] });
    expect(verifyChanges({ color: "Beige" }, "make it nicer", { options: [], variations: [] }).dropped).toEqual(["colour"]);
  });

  it("a sentence isn't a field to change", () => {
    expect(verifyChanges({ other: "Don't list tbis again pls" }, "Don't list tbis again pls", { options: [], variations: [] }).changes).toEqual({});
    expect(verifyChanges({ other: "material" }, "change the material", { options: [], variations: [] }).changes).toEqual({ other: "material" });
  });

  it("the new values given as the product's name don't make it another product", () => {
    expect(saidIsValues("Large, Medium, Small.", { variations: ["Large", "Medium", "Small"], color: "cream, black and brown" })).toBe(true);
    expect(saidIsValues("gold medal", { price: 25 })).toBe(false);
    const BODYSUIT = product(1, "3-Piece Thong Bodysuit - Seamless, Tummy Control, Adjustable Straps", { options: SIZES });
    const first = '{"type":"edit","edits":[{"products":[1],"said":"Large, Medium, Small.","changes":{"variations":["Large","Medium","Small"],"color":"cream, black and brown"},"ask":false}]}';
    expect(parseAction(first, BODYSUIT_MSG, [BODYSUIT], assistantLinks())).toEqual({
      type: "edit", edits: [{ seqs: [1], changes: { variations: ["L", "M", "S"], color: "cream, black and brown" }, ask: false }], dropped: [],
    });
  });

  it("a size's name becomes the category's own spelling of it, both ways", () => {
    expect(parseVariations(SIZES, "Large")).toEqual({ ok: true, values: ["L"] });
    expect(parseVariations(SIZES, "medium and extra large")).toEqual({ ok: true, values: ["M", "XL"] });
    expect(parseVariations(SIZES, "2XL")).toEqual({ ok: true, values: ["XXL"] });
    expect(parseVariations(["Small", "Medium", "Large", "Extra Large"], "S, XL")).toEqual({ ok: true, values: ["Small", "Extra Large"] });
    expect(parseVariations(SIZES, "Huge")).toEqual({ ok: false, unknown: ["Huge"] });
  });
});

describe("reading the AI's reply", () => {
  const products = [FRIDGE, SHIRT];

  it("an edit of the product named", () => {
    expect(parseAction('{"type":"edit","edits":[{"products":[1],"changes":{"quantity":20},"ask":false}]}', "fridge quantity 20", products))
      .toEqual({ type: "edit", edits: [{ seqs: [1], changes: { quantity: 20 }, ask: false }], dropped: [] });
  });

  it("asks which when no product is named in a batch of several", () => {
    expect(parseAction('{"type":"edit","edits":[{"products":[],"changes":{"quantity":20}}]}', "quantity 20", products))
      .toEqual({ type: "edit", edits: [{ seqs: [1, 2], changes: { quantity: 20 }, ask: true }], dropped: [] });
  });

  it("with one product, it is that one", () => {
    expect(parseAction('{"type":"edit","edits":[{"products":[],"changes":{"quantity":20},"ask":true}]}', "quantity 20", [FRIDGE]))
      .toEqual({ type: "edit", edits: [{ seqs: [1], changes: { quantity: 20 }, ask: false }], dropped: [] });
  });

  it("ignores product numbers that aren't in the batch", () => {
    expect(parseAction('{"type":"submit","products":[2,7]}', "submit the shirt", products)).toEqual({ type: "submit", seqs: [2] });
    expect(parseAction('{"type":"submit","products":[7]}', "submit 7", products)).toEqual({ type: "unclear" });
  });

  it("anything malformed is unclear", () => {
    expect(parseAction("I think they want to submit", "x", products)).toEqual({ type: "unclear" });
    expect(parseAction('{"type":"delete_everything"}', "x", products)).toEqual({ type: "unclear" });
    expect(parseAction('{"type":"answer","text":""}', "x", products)).toEqual({ type: "unclear" });
    expect(parseAction('{"type":"edit","edits":[{"products":[1],"changes":{}}]}', "x", products)).toEqual({ type: "unclear" });
  });

  it("reads JSON wrapped in a code fence", () => {
    expect(parseAction('```json\n{"type":"orders"}\n```', "my orders?", products)).toEqual({ type: "orders" });
  });
});

describe("a sale's price given as the price (test runs of 11 Oct)", () => {
  it("is the sale's when the number sits beside sale, promo, discount or deal", () => {
    expect(salePriceIn("Set sale price @150 for men’s safety shoe with start and end date in this month", 150)).toBe(true);
    expect(salePriceIn("put the kettle on promo at 100 this weekend", 100)).toBe(true);
    expect(salePriceIn("Set sale price to 150 for pa-mou7Izdd", 150)).toBe(true);
    expect(salePriceIn("100 promo on the kettle", 100)).toBe(true);
    expect(salePriceIn("set the kettle price to 100", 100)).toBe(false);
    expect(salePriceIn("price 250, end the sale", 250)).toBe(false);
    expect(salePriceIn("sale 1500 on the fridge", 150)).toBe(false);
  });

  it("becomes a sale, never a price change; with no dates, they're asked", () => {
    const now = new Date("2026-10-11T12:00:00Z");
    const month = parseAction('{"type":"live_change","product":"men’s safety shoe","price":150}',
      "Set sale price @150 for men’s safety shoe with start and end date in this month", [], undefined, "GHS", { now });
    expect(month).toMatchObject({ type: "live_change", change: { kind: "sale", sale: { price: 150 } } });
    const bare = parseAction('{"type":"live_change","product":"pa-mou7Izdd","price":150}', "Set sale price to 150 for pa-mou7Izdd", [], undefined, "GHS", { now });
    expect(bare).toMatchObject({ type: "reply", text: expect.stringContaining("A sale on Jumia needs its dates") });
    // "10% off all perfumes this weekend": a sale, not prices up 10%.
    const pct = parseAction('{"type":"bulk","scope":"matching","words":"perfumes","price_pct":10}', "10% off all perfumes this weekend", [], undefined, "GHS", { now });
    expect(pct).toMatchObject({ type: "bulk", change: { kind: "sale_pct", pct: 10 } });
    expect(parseAction('{"type":"bulk","scope":"matching","words":"perfumes","price_pct":10}', "take 10% off all perfumes for good", [], undefined, "GHS", { now }))
      .toMatchObject({ type: "bulk", change: { kind: "price_pct", pct: -10 } });
    // A plain price stays a price.
    expect(parseAction('{"type":"live_change","product":"kettle","price":100}', "set the kettle price to 100", [], undefined, "GHS", { now }))
      .toMatchObject({ type: "live_change", change: { kind: "price", price: 100 } });
  });
});

describe("a count of products to list", () => {
  it("must be in the message, as digits or a word, or add up from it", () => {
    expect(countBacked(5, "I want to list 5 products")).toBe(true);
    expect(countBacked(5, "can I list five things")).toBe(true);
    expect(countBacked(3, "2 shirts and a fridge")).toBe(true);
    expect(countBacked(4, "two shoes and two bags")).toBe(true);
    expect(countBacked(1, "I want to list a fridge")).toBe(true);
    expect(countBacked(3, "I want to list a few things")).toBe(false);
    expect(countBacked(6, "I want to list 5 products")).toBe(false);
    // The owner's web chat, 2026-10-11: one product, after sending its photo.
    expect(countBacked(1, "let list this product")).toBe(true);
    expect(countBacked(1, "list it")).toBe(true);
    expect(countBacked(2, "let list this product")).toBe(false);
  });

  it("is read from the AI only when the message backs it", () => {
    expect(parseAction('{"type":"list","count":3}', "2 shirts and a fridge please", [])).toEqual({ type: "list", count: 3 });
    // A count the message doesn't give is still a wish to list: offered like "restart" (2026-10-08).
    expect(parseAction('{"type":"list","count":4}', "a few shirts", [])).toEqual({ type: "restart" });
    expect(parseAction('{"type":"list","count":1}', "let's list new products", [])).toEqual({ type: "restart" });
  });
});

describe("when the usual edit is enough", () => {
  it("a price, stock or sale on its own", () => {
    expect(plainQuickEdit("price 150", true)).toBe(true);
    expect(plainQuickEdit("price 150 and quantity 20", true)).toBe(true);
  });
  it("not when something else is named, or nothing was found", () => {
    expect(plainQuickEdit("price 150 and size Large", true)).toBe(false);
    expect(plainQuickEdit("change the colour to red", false)).toBe(false);
    expect(plainQuickEdit("price 150 for all of them", true)).toBe(false);
  });
});

describe("who has it", () => {
  // Owner, 2026-10-07: "AI for all sellers".
  it("every seller, on WhatsApp and the web, unless the kill switch is off", async () => {
    expect(await assistantEnabled("admin")).toBe(true);
    expect(await assistantEnabled("seller")).toBe(true);
    expect(await assistantFor("seller", "233200000000")).toBe(true);
    expect(await assistantFor("seller", "web:seller")).toBe(true);
    db.tables.app_settings = [{ key: "assistant_enabled", value: false }];
    expect(await assistantFor("seller", "233200000000")).toBe(false);
  });
});

describe("between batches", () => {
  const session = (patch: Partial<WhatsAppSession> = {}) =>
    ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null, ...patch }) as WhatsAppSession;

  it("answers a question about credits", async () => {
    db.tables.extension_credits = [{ user_id: "seller", balance: 9 }];
    aiReplies.push('{"type":"credits"}');
    expect(await runAssistant("seller", "233", session(), "how many credits do i have left", "idle")).toBe("handled");
    expect(sent).toEqual([{ kind: "cta", body: "You have 9 credits: enough for about 4 WhatsApp listings. A listing costs 2 credits when it goes live on Jumia.", button: "Buy credits", url: "https://pandaworld.gh/extension/dashboard" }]);
  });

  it("shows the orders", async () => {
    aiReplies.push('{"type":"orders"}');
    expect(await runAssistant("seller", "233", session(), "any new orders for me?", "idle")).toBe("handled");
    expect(orderCalls).toEqual(["orders"]);
  });

  it("answers from what the bot does, in its own words", async () => {
    aiReplies.push('{"type":"reply","text":"A WhatsApp listing costs 2 credits, charged only when it goes live.","link":null}');
    expect(await runAssistant("seller", "233", session(), "how much does a listing cost", "idle")).toBe("handled");
    expect(sent[0]).toEqual({ kind: "text", body: "A WhatsApp listing costs 2 credits, charged only when it goes live." });
  });

  it("hands a count back so the batch starts the usual way", async () => {
    aiReplies.push('{"type":"list","count":3}');
    expect(await runAssistant("seller", "233", session(), "I'd like to list 2 shirts and a fridge", "idle")).toEqual({ list: 3 });
    expect(sent).toEqual([]);
    expect(db.tables.whatsapp_assistant_log[0]).toMatchObject({ outcome: "list 3" });
  });

  it("offers to start listing", async () => {
    aiReplies.push('{"type":"restart"}');
    await runAssistant("seller", "233", session(), "i want to list some shoes", "idle");
    expect(sent[0]).toMatchObject({ kind: "buttons", rows: ["1", "2", "3"] });
  });

  it("leaves a change to products already with Jumia to the usual reply", async () => {
    db.tables.listings = [{ id: "l1", user_id: "seller", whatsapp_batch_id: "b1", whatsapp_seq: 1, title: "Hisense Fridge", status: "pending_approval" }];
    aiReplies.push('{"type":"edit","edits":[{"products":[1],"changes":{"quantity":20}}]}');
    expect(await runAssistant("seller", "233", session({ lastSubmittedBatchId: "b1" }), "quantity 20 for the fridge", "sent")).toBe("default");
    expect(sent).toEqual([]);
    expect(db.tables.listings[0].quantity).toBeUndefined();
  });

  it("leaves a reply it can't read to the usual one", async () => {
    aiReplies.push('{"type":"unclear"}');
    expect(await runAssistant("seller", "233", session(), "good morning", "idle")).toBe("default");
    expect(db.tables.whatsapp_assistant_log[0]).toMatchObject({ stage: "idle", message: "good morning", outcome: "default" });
  });

  it("doesn't ask the AI about a button id from an older message", async () => {
    expect(await runAssistant("seller", "233", session(), "apick:2", "idle")).toBe("default");
    expect(aiCalls).toBe(0);
  });

  it("says when the AI couldn't be reached", async () => {
    expect(await runAssistant("seller", "233", session(), "what can you do", "idle")).toBe("failed");
    expect(sent).toEqual([]);
  });
});

describe("the front door (step 2, owner 2026-10-08)", () => {
  const session = () => ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null }) as WhatsAppSession;

  it("reads every message agent mode doesn't, with no switch: sorts it, then reads it (11 Oct)", async () => {
    aiReplies.push('{"area":"orders"}', '{"type":"orders"}');
    expect(await runAssistant("seller", "233", session(), "show me my orders", "idle")).toBe("handled");
    expect(aiPrompts[0]).toContain('Reply with JSON only: {"area"');
    expect(aiPrompts[1]).toContain("This message is about: orders.");
    expect(orderCalls).toEqual(["orders"]);
  });

  it("knows the shop's products the message names, and carries out a live change", async () => {
    db.tables.jumia_products = [{ user_id: "seller", name: "Foldable Drone with HD Camera" }, { user_id: "seller", name: "Pedestal Fan" }];
    aiReplies.push('{"area":"live_products"}', '{"type":"live_change","product":"Foldable Drone","stock":10}');
    expect(await runAssistant("seller", "233", session(), "Change Foldable Drone with HD Camera to 10", "idle")).toBe("handled");
    expect(aiPrompts[0]).toContain('Products in their Jumia shop the message names: "Foldable Drone with HD Camera"');
    expect(aiPrompts[0]).not.toContain("Pedestal Fan");
    expect(shopCalls[0]).toEqual(["proposeLiveChange", "Foldable Drone", { kind: "stock", stock: 10 }, { preferSid: null }]);
  });

  it("long answers go as a list to choose from", async () => {
    aiReplies.push('{"area":"live_products"}', '{"type":"clarify","question":"Which products should stay on?","options":["I\'ll name the ones to keep on","None, turn everything off"]}');
    expect(await runAssistant("seller", "233", session(), "off all other products apart from the ones i asked you turn on", "idle")).toBe("handled");
    expect(sent[0]).toMatchObject({ kind: "list", body: "Which products should stay on?", rows: ["answer:@live_products:I'll name the ones to keep on", "answer:@live_products:None, turn everything off"] });
  });
});

describe("agent mode (the pilot, owner 2026-10-10)", () => {
  const session = () => ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null }) as WhatsAppSession;

  it("its model comes from the setting, with a thinking level if one is named", async () => {
    db.tables.app_settings = [{ key: "assistant_agent_model", value: "gemini-3.8-flash:low" }];
    expect(await agentModel()).toBe("gemini-3.8-flash:low");
    db.tables.app_settings = [{ key: "assistant_agent_model", value: "gemini-3.5-flash-lite" }];
    expect(await agentModel()).toBe("gemini-3.5-flash-lite");
    db.tables.app_settings = [{ key: "assistant_agent_model", value: "gemini-3.8-flash:lots" }];
    expect(await agentModel()).toBe("gemini-2.5-flash-lite");
  });

  it("is on for the accounts the switch names", async () => {
    expect(await agentFor("admin")).toBe(false);
    db.tables.app_settings = [{ key: "assistant_agent", value: "admins" }];
    expect(await agentFor("admin")).toBe(true);
    expect(await agentFor("seller")).toBe(false);
    db.tables.app_settings = [{ key: "assistant_agent", value: ["seller"] }];
    expect(await agentFor("seller")).toBe(true);
  });

  it("carries out several things asked at once, in order", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    db.tables.jumia_products = [{ user_id: "seller", product_sid: "p1", seller_sku: "KET", name: "Nasco Electric Kettle 1.7L", status: "ACTIVE" }];
    toolReplies.push(
      [{ name: "find_products", args: { words: "kettle" } }],
      [{ name: "live_change", args: { product: "Nasco Electric Kettle 1.7L", stock: 10 } }, { name: "sales", args: { period: "today" } }],
    );
    expect(await runAssistant("seller", "233", session(), "restock the kettle to 10 and show me today's sales", "idle")).toBe("handled");
    expect(shopCalls.map((c) => c[0])).toEqual(["proposeLiveChange", "answerSales"]);
    expect(shopCalls[0]).toEqual(["proposeLiveChange", "Nasco Electric Kettle 1.7L", { kind: "stock", stock: 10 }, { preferSid: null }]);
    const log = db.tables.whatsapp_assistant_log as { outcome: string; raw?: string }[];
    expect(log.map((l) => l.outcome)).toEqual(["offered", "sales"]);
    expect(log[0].raw).toContain("[agent ");
    expect(log[1].raw).toBeUndefined();
  });

  it("starts a batch after answering the rest", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    toolReplies.push([{ name: "list", args: { count: 3 } }, { name: "credits", args: {} }]);
    expect(await runAssistant("seller", "233", session(), "I want to list 3 products, how many credits do I have?", "idle")).toEqual({ list: 3 });
    expect(sent.length).toBeGreaterThan(0);
  });

  it("asks back with answers to tap", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    toolReplies.push([{ name: "clarify", args: { question: "Which kettle?", options: ["Nasco 1.7L", "Binatone 2L"] } }]);
    expect(await runAssistant("seller", "233", session(), "restock the kettle to 10", "idle")).toBe("handled");
    expect(sent[0]).toMatchObject({ kind: "buttons", body: "Which kettle?", rows: ["answer:Nasco 1.7L", "answer:Binatone 2L"] });
  });

  it("the front door reads what it found nothing to do with", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    toolReplies.push([{ name: "capability", args: { what: "teleport" } }]);
    aiReplies.push('{"area":"orders"}', '{"type":"orders"}');
    expect(await runAssistant("seller", "233", session(), "show me my orders", "idle")).toBe("handled");
    expect(orderCalls).toEqual(["orders"]);
    expect((db.tables.whatsapp_assistant_log as { raw: string }[])[0].raw).toMatch(/^\[agent found nothing to do: /);
  });

  // Test runs of 11 Oct: "download a label" read as cannot("labels"), "link to vendor center" as cannot("vendor_center").
  it("a \"can't\" for something the chat does, or a link, is sent back once with which list it's on", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    toolReplies.push(
      [{ name: "cannot", args: { what: "vendor_center" } }],
      [{ name: "reply", args: { text: "Here's Vendor Center:", link: "vendor_center" } }],
    );
    expect(await runAssistant("seller", "233", session(), "link to vendor center", "idle")).toBe("handled");
    expect(toolTurns[1]).toContain('\\"vendor_center\\" is a link, not a key on Not possible');
    expect(sent.at(-1)).toMatchObject({ kind: "cta", body: "Here's Vendor Center:" });

    toolReplies.push([{ name: "cannot", args: { what: "labels" } }], [{ name: "capability", args: { what: "labels" } }]);
    sent.length = 0;
    expect(await runAssistant("seller", "233", session(), "download a label", "idle")).toBe("handled");
    expect(toolTurns.at(-1)).toContain('\\"labels\\" is on What the chat does');
    expect(sent.at(-1)?.body).toContain("I send its shipping label as a PDF");
    // A real "can't" is answered straight away; a key on neither list is what PandaWorld doesn't do.
    const calls = aiCalls;
    toolReplies.push([{ name: "cannot", args: { what: "delete_product" } }]);
    await runAssistant("seller", "233", session(), "delete the kettle", "idle");
    expect(aiCalls).toBe(calls + 1);
  });

  // Owner's WhatsApp, 2026-10-11: six numbered changes to the dartboard; the sale was never called.
  it("a message of several parts: asked once whether any part is left, before anything is done", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    const msg = "1. change the brand of the 17 inc dart to generic\n2. add sale price 200 start and end is 20th october to 27th october";
    toolReplies.push(
      [{ name: "content_change", args: { product: "17 inc dart", brand: "generic" } }],
      [{ name: "live_change", args: { product: "17 inc dart", sale_price: 200, sale_start: "2026-10-20", sale_end: "2026-10-27", dates_said: "20th october to 27th october" } }],
    );
    expect(await runAssistant("seller", "233", session(), msg, "idle")).toBe("handled");
    expect(toolAllowed[0]).not.toContain("done");
    expect(toolAllowed[1]).toContain("done");
    expect(toolTurns[1]).toContain("go through their message part by part");
    expect(shopCalls.map((c) => c[0])).toEqual(["proposeContentChange", "proposeLiveChange"]);

    // Done: only what it did. The same tool for the same product again is the same part.
    shopCalls.length = 0;
    toolReplies.push([{ name: "content_change", args: { product: "17 inc dart", brand: "generic" } }], [{ name: "done", args: {} }]);
    await runAssistant("seller", "233", session(), msg, "idle");
    expect(shopCalls.map((c) => c[0])).toEqual(["proposeContentChange"]);
    shopCalls.length = 0;
    toolReplies.push([{ name: "content_change", args: { product: "17 inc dart", brand: "generic" } }], [{ name: "content_change", args: { product: "17 inc dart", brand: "Generic" } }]);
    await runAssistant("seller", "233", session(), msg, "idle");
    expect(shopCalls.map((c) => c[0])).toEqual(["proposeContentChange"]);

    // One line, one request: no extra call.
    const calls = aiCalls;
    toolReplies.push([{ name: "content_change", args: { product: "17 inc dart", brand: "generic" } }]);
    await runAssistant("seller", "233", session(), "change the brand of the 17 inc dart to generic", "idle");
    expect(aiCalls).toBe(calls + 1);
  });

  it("falls back to the front door when it fails", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    aiReplies.push('{"area":"orders"}', '{"type":"orders"}');
    expect(await runAssistant("seller", "233", session(), "show me my orders", "idle")).toBe("handled");
    expect(orderCalls.length + shopCalls.length + sent.length).toBeGreaterThan(0);
    expect((db.tables.whatsapp_assistant_log as { raw: string }[])[0].raw).toMatch(/^\[agent failed: no tool calls scripted\] \[front door\]/);
  });
});

describe("a draft's own text (owner's WhatsApp, 2026-10-10)", () => {
  const THONG = "3-Piece Thong Bodysuit - Adjustable Straps, Tummy Control";
  const DRAFT1 = product(1, THONG, {
    listing: { id: "l1", title: THONG, status: "draft", selling_price: 120, highlights: "<ul><li>Tummy control</li><li>Adjustable straps</li></ul>", description: "<p>Soft and stretchy.</p>" } as ListingRow,
    variations: ["S", "M"],
  });
  const DRAFT2 = product(2, "Round Neck Short Sleeve Top & High Waist Shorts Set - Activewear, Athleisure");

  it("knows a product by its whole name, or its name before the details", () => {
    expect(sameName(THONG, "3-piece thong bodysuit - adjustable straps, tummy control")).toBe(true);
    expect(sameName(THONG, "3-Piece Thong Bodysuit")).toBe(true);
    expect(sameName(THONG, "Thong Bodysuit")).toBe(false);
    expect(sameName(THONG, "Backless Thong Bodysuit")).toBe(false);
    expect(sameName("Hisense Fridge", "Hisense Fridge")).toBe(true);
  });

  it("shows drafts by their numbers; asks which when there are several and none is named", () => {
    const links = assistantLinks();
    expect(parseAction('{"type":"draft_text","products":[1]}', "show me the highlights you wrote for the first one", [DRAFT1, DRAFT2], links))
      .toEqual({ type: "draft_text", seqs: [1] });
    expect(parseAction('{"type":"draft_text","products":[7]}', "show me draft 7", [DRAFT1, DRAFT2], links))
      .toMatchObject({ type: "reply", text: expect.stringContaining("Which draft?") });
    expect(parseAction('{"type":"draft_text"}', "show me what you wrote", [DRAFT1], links)).toEqual({ type: "draft_text", seqs: [1] });
  });

  it("reads a draft's own name as that draft, never a product on Jumia", () => {
    const links = assistantLinks();
    expect(parseAction(`{"type":"product_text","product":"${THONG}"}`, "How me highlight you write for the first one", [DRAFT1, DRAFT2], links))
      .toEqual({ type: "draft_text", seqs: [1] });
    expect(parseAction('{"type":"product_info","product":"3-Piece Thong Bodysuit"}', "is the 3-Piece Thong Bodysuit live?", [DRAFT1, DRAFT2], links))
      .toEqual({ type: "draft_text", seqs: [1] });
    expect(parseAction('{"type":"product_text","product":"Backless Thong Bodysuit"}', "show me the Backless Thong Bodysuit's description", [DRAFT1, DRAFT2], links))
      .toEqual({ type: "product_text", product: "Backless Thong Bodysuit" });
  });

  it("lays a draft out as drafted", () => {
    expect(draftTextLines(DRAFT1, "GHS", 2)).toEqual([
      `*Draft 1 of 2: ${THONG}*`, "Price: GHS 120 · S, M",
      "", "*Highlights:*", "• Tummy control • Adjustable straps",
      "", "*Description:*", "Soft and stretchy.",
    ]);
    expect(draftTextLines(DRAFT2, "GHS", 1)).toContain("(none written yet)");
  });

  it("answers the owner's message with the draft, through agent mode, and a way to change it", async () => {
    const now = new Date().toISOString();
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    db.tables.listings = [
      { id: "l1", user_id: "seller", whatsapp_batch_id: "b1", whatsapp_seq: 1, title: THONG, status: "draft", created_at: now, highlights: "<ul><li>Tummy control</li></ul>", description: "<p>Soft and stretchy.</p>" },
      { id: "l2", user_id: "seller", whatsapp_batch_id: "b1", whatsapp_seq: 2, title: "Round Neck Short Sleeve Top & High Waist Shorts Set", status: "draft", created_at: now },
    ];
    // What the agent did on 10 Oct: the draft's name, read as a product on Jumia.
    toolReplies.push([{ name: "product_text", args: { product: THONG } }]);
    const session = { phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null } as WhatsAppSession;
    expect(await runAssistant("seller", "233", session, "How me highlight you write for the first one", "idle")).toBe("handled");
    expect(shopCalls).toEqual([]);
    expect(sent[0].body).toContain(`*Draft 1 of 2: ${THONG}*`);
    expect(sent[0].body).toContain("Tummy control");
    expect(sent[0].body).toContain("Soft and stretchy.");
    expect(sent[1]).toMatchObject({ kind: "cta", button: "Review listings" });
  });
});

describe("the owner's dartboard, all in one message (2026-10-11)", () => {
  const MSG = "1. change the brand of the 17 inc dart to generic\n2. the weight to 0.9\n3. warranty address to north legon\n4. edit the tittle to be abit longer\n5. add sale price 200 start and end is 20th october to 27th october\n6. add rubber to the material family";
  const read = (json: Record<string, unknown>, message = MSG) => parseAction(JSON.stringify({ type: "content_change", ...json }), message, [], assistantLinks());

  it("a rewrite asked for in any words, with their words as what to do", () => {
    // "tittle" and "longer" weren't on the word list: the name was dropped.
    expect(read({ product: "17 inc dart", brand: "generic", rewrite: ["name"], asked: { name: "edit the tittle to be abit longer" } }))
      .toEqual({ type: "content_change", product: "17 inc dart", request: { brand: "generic", rewrite: ["name"], instructions: 'Name: "edit the tittle to be abit longer"' } });
    // Words that aren't theirs ask for nothing.
    expect(read({ product: "17 inc dart", brand: "generic", rewrite: ["name"], asked: { name: "make the title more catchy" } }))
      .toEqual({ type: "content_change", product: "17 inc dart", request: { brand: "generic" } });
  });

  it("only the fields they asked about are rewritten", () => {
    const msg = "okay the description for it is too short and not SEO friendly kindly have a look at the pictures of it and rewrite the description yourself";
    // 10:01: a new name came with it, unasked.
    expect(read({ product: "dartboard", rewrite: ["description", "name"], asked: { description: "rewrite the description yourself" } }, "the dartboard: " + msg))
      .toMatchObject({ request: { rewrite: ["description"], instructions: 'Description: "rewrite the description yourself"' } });
  });

  it("a sale's dates in their words: \"start and end is 20th october to 27th october\"", () => {
    const now = new Date("2026-10-11T10:00:00Z");
    const args = { sale_price: 200, sale_start: "2026-10-20", sale_end: "2026-10-27", dates_said: "20th october to 27th october" };
    expect(aiSaleWindow(args, MSG, now)).toEqual({ start: "2026-10-20", end: "2026-10-27" });
    // The year is the next time that day comes, whatever year the AI wrote.
    expect(aiSaleWindow({ ...args, sale_start: "2024-10-20", sale_end: "2024-10-27" }, MSG, now)).toEqual({ start: "2026-10-20", end: "2026-10-27" });
    expect(aiSaleWindow({ ...args, sale_start: "2026-12-28", sale_end: "2026-01-04", dates_said: "28th december to 4th january" }, "sale from 28th december to 4th january", now))
      .toEqual({ start: "2026-12-28", end: "2027-01-04" });
    // Not their words, or days that aren't in them: no dates.
    expect(aiSaleWindow({ ...args, dates_said: "next week" }, MSG, now)).toBeNull();
    expect(aiSaleWindow({ ...args, sale_end: "2026-10-29" }, MSG, now)).toBeNull();
    // As the chat reads it: a sale of 200 from the 20th to the 27th.
    expect(read({ product: "17 inc dart", brand: "generic" })).toMatchObject({ type: "content_change" });
    expect(parseAction(JSON.stringify({ type: "live_change", product: "17 inc dart", ...args }), MSG, [], assistantLinks()))
      .toMatchObject({ type: "live_change", change: { kind: "sale", sale: { price: 200, end: expect.stringMatching(/-10-27$/) } } });
  });

  it("a detail added to keeps what it has", () => {
    expect(read({ product: "17 inc dart", details: { "material family": "rubber", weight: "0.9" }, adding: ["material family"] }))
      .toEqual({ type: "content_change", product: "17 inc dart", request: { details: { "material family": "rubber", weight: "0.9" }, adding: ["material family"] } });
    // A detail not in the change isn't "added".
    expect(read({ product: "17 inc dart", details: { weight: "0.9" }, adding: ["colour"] }))
      .toEqual({ type: "content_change", product: "17 inc dart", request: { details: { weight: "0.9" } } });
  });
});

describe("a product's photos, anything about it, and which one when several fit (owner, 2026-10-11)", () => {
  const session = (extra: Partial<WhatsAppSession> = {}) =>
    ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null, ...extra }) as WhatsAppSession;

  it("reads the owner's two messages as photos of a product in the shop, whatever its status", () => {
    const links = assistantLinks();
    expect(parseAction('{"type":"product_photos","product":"wellington boot"}', "show me the images of the wellington boot in the shop", [], links))
      .toEqual({ type: "product_photos", product: "wellington boot" });
    expect(parseAction('{"type":"product_photos","product":"fan"}', "i HAVE a fan in the shop kindly show me the pictures for that product here", [], links))
      .toEqual({ type: "product_photos", product: "fan" });
    expect(parseAction('{"type":"product_photos","product":"the product"}', "show me the pictures", [], links))
      .toMatchObject({ type: "reply", text: expect.stringContaining("Which product's photos?") });
  });

  it("a draft's photos are the ones it was drafted from", async () => {
    const now = new Date().toISOString();
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    db.tables.listings = [
      { id: "l1", user_id: "seller", whatsapp_batch_id: "b1", whatsapp_seq: 1, title: "Pedestal Fan", status: "draft", created_at: now, images: ["https://img/1.jpg", "https://img/2.jpg"] },
    ];
    toolReplies.push([{ name: "product_photos", args: { product: "draft 1" } }]);
    expect(await runAssistant("seller", "233", session({ batchId: "b1" }), "show me the photos of draft 1", "review")).toBe("handled");
    expect(shopCalls).toEqual([]);
    expect(sent[0]).toMatchObject({ kind: "images", body: "Product 1 (Pedestal Fan): 2 photos, as drafted.", rows: ["https://img/1.jpg", "https://img/2.jpg"] });
  });

  it("several fit: a list to tap, and the photos of the one picked, with no new message to the AI", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    db.tables.whatsapp_sessions = [{ phone_number: "233", user_id: "seller", state: "awaiting_count" }];
    toolReplies.push([{ name: "product_photos", args: { product: "nasco kettle" } }]);
    expect(await runAssistant("seller", "233", session(), "show me the pictures of the nasco kettle", "idle")).toBe("handled");
    expect(sent[0]).toMatchObject({ kind: "list", body: "2 of your products fit. Which one do you mean?", rows: ["ppick:0", "ppick:1"] });
    const pending = (db.tables.whatsapp_sessions as { assistant_pending: Record<string, unknown> }[])[0].assistant_pending;
    expect(pending).toMatchObject({ kind: "product_pick", action: { type: "product_photos", product: "nasco kettle" }, skus: ["NAS-K", "NAS-K2"] });

    const calls = aiCalls;
    const asked = session({ assistantPending: pending as never });
    expect(await answerProductPick("seller", "233", asked, "ppick:1")).toBe(true);
    expect(shopCalls.at(-1)).toEqual(["answerProductPhotos", "NAS-K2"]);
    // Typed as the row's number, or as the SKU.
    expect(await answerProductPick("seller", "233", asked, "1")).toBe(true);
    expect(shopCalls.at(-1)).toEqual(["answerProductPhotos", "NAS-K"]);
    expect(await answerProductPick("seller", "233", asked, "sku nas-k2")).toBe(true);
    expect(shopCalls.at(-1)).toEqual(["answerProductPhotos", "NAS-K2"]);
    expect(aiCalls).toBe(calls);
    expect((db.tables.whatsapp_assistant_log as { outcome: string }[]).at(-1)?.outcome).toBe("picked NAS-K2: photos");
    // Anything else: the question goes and the message is read as usual.
    expect(await answerProductPick("seller", "233", asked, "actually show me my orders")).toBe(false);
    expect(await answerProductPick("seller", "233", session(), "1")).toBe(false);
  });

  it("an old list isn't answered", async () => {
    const at = new Date(Date.now() - 2 * 24 * 3600_000).toISOString();
    const old = session({ assistantPending: { kind: "product_pick", action: { type: "product_photos", product: "nasco kettle" }, skus: ["NAS-K"], at } });
    expect(await answerProductPick("seller", "233", old, "1")).toBe(false);
    expect(shopCalls).toEqual([]);
  });

  it("agent mode reads the product from Jumia to answer a question about it", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    toolReplies.push(
      [{ name: "product_details", args: { words: "kettle" } }],
      [{ name: "reply", args: { text: "It's silver, and the box has the kettle and its base." } }],
    );
    expect(await runAssistant("seller", "233", session(), "what colour is my kettle and what comes in the box?", "idle")).toBe("handled");
    expect(toolTurns[1]).toContain("color=Silver; what_is_in_the_box=1 kettle, 1 base");
    expect(sent.at(-1)?.body).toBe("It's silver, and the box has the kettle and its base.");
    expect(shopCalls).toEqual([]);
  });
});

describe("its own replies (owner, 2026-10-06)", () => {
  const session = (patch: Partial<WhatsAppSession> = {}) =>
    ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null, ...patch }) as WhatsAppSession;

  // Owner, 2026-10-07: "let the chat know our site very well ... connect WhatsApp, use extension, regenerate key".
  it("knows the website, page by page, and how each thing is done, with the page to send", async () => {
    aiReplies.push('{"type":"reply","text":"1. Open your Extension Dashboard.\\n2. Tap *Regenerate key*.","link":"dashboard"}');
    await runAssistant("seller", "233", session(), "how do I regenerate my api key", "idle");
    const prompt = aiPrompts[0];
    expect(prompt).toContain("The website (pandaworld's dashboard, after signing in");
    expect(prompt).toContain("- Link WhatsApp [guide_link_whatsapp]: Settings → WhatsApp → \"Connect WhatsApp\"");
    expect(prompt).toContain("- Connect Jumia [guide_connect]");
    expect(prompt).toContain("- Use the Chrome extension [guide_extension]");
    expect(prompt).toContain("- Regenerate the API key");
    expect(prompt).toContain("+233548534323");
    for (const key of ["assistant", "calculator_app", "connect_jumia", "guide_link_whatsapp", "community", "settings", "dashboard"]) {
      expect(prompt).toContain(`- ${key}: `);
    }
    expect(sent[0]).toMatchObject({ kind: "cta", body: "1. Open your Extension Dashboard.\n2. Tap *Regenerate key*." });
  });

  it("is told what PandaWorld does, and what this seller's pack and credits give them", async () => {
    db.tables.extension_credits = [{ user_id: "seller", balance: 9 }];
    db.tables.jumia_connections = [{ user_id: "seller", country: "GH" }];
    aiReplies.push('{"type":"reply","text":"Hi! I can list your products on Jumia, edit your drafts and tell you your credits. What would you like to do for your Jumia shop?","link":null}');

    expect(await runAssistant("seller", "233", session(), "hello", "idle")).toBe("handled");

    const prompt = aiPrompts[0];
    expect(prompt).toContain("- List products on Jumia from WhatsApp");
    expect(prompt).toContain("pack them, mark them ready to ship, or cancel, here or on WhatsApp");
    expect(prompt).toContain("Shipping label PDFs only on WhatsApp (every pack, credits each). Every pack also: alerts for new Jumia orders on WhatsApp");
    expect(prompt).toContain("- Chatting is free on every pack.");
    expect(prompt).toContain("- Changes to live Jumia products from the chat: not on their pack (Standard and up)");
    expect(prompt).toContain("up to 200 products");
    expect(prompt).toContain("- Country: Ghana");
    expect(prompt).toContain("- Pack: none bought yet, on their free sign-up credits");
    // Every plan since 2026-10-07: the chat's features; labels and alerts keep their packs.
    expect(prompt).toContain("- The chat's shop features (products, orders, reports, payouts, fees): on");
    expect(prompt).toContain("- Jumia QC rejection alerts and guided fixes: not on their pack (Standard and up)");
    expect(prompt).toContain("- Shipping label PDFs on WhatsApp: on");
    expect(prompt).toContain("- Order alerts on WhatsApp (new orders, order updates, payouts): on");
    expect(prompt).toContain("a shipping label 0.5 credits (the same label again is free)");
    expect(prompt).toContain("- Credits: 9 available, enough for about 4 WhatsApp listings");
    expect(prompt).toContain("- home: PandaWorld's home page");
    expect(prompt).toContain("- country: selling on Jumia in their country");
    expect(prompt).toContain("in the language they wrote in.");
    expect(sent).toEqual([{ kind: "text", body: "Hi! I can list your products on Jumia, edit your drafts and tell you your credits. What would you like to do for your Jumia shop?" }]);
  });

  it("knows the pack bought last", async () => {
    db.tables.extension_credit_transactions = [{ user_id: "seller", type: "purchase", amount: 440, created_at: "2026-10-01T00:00:00Z" }];
    db.tables.extension_credits = [{ user_id: "seller", balance: 400 }];
    aiReplies.push('{"type":"reply","text":"Hello!","link":null}');
    await runAssistant("seller", "233", session(), "hi", "idle");
    expect(aiPrompts[0]).toContain("- Pack: Pro (the last one they bought)");
    expect(aiPrompts[0]).toContain("- Shipping label PDFs on WhatsApp: on");
    expect(aiPrompts[0]).toContain("- Order alerts on WhatsApp (new orders, order updates, payouts): on");
    expect(aiPrompts[0]).toContain("- Changes to live Jumia products from the chat: on");
  });

  it("an account that isn't charged has everything on", async () => {
    aiReplies.push('{"type":"reply","text":"Hello!","link":null}');
    await runAssistant("admin", "233", session({ userId: "admin" }), "hi", "idle");
    expect(aiPrompts[0]).toContain("- Not charged credits: every feature is on for them.");
  });

  it("sends a page it's asked for as a button", async () => {
    aiReplies.push('{"type":"reply","text":"Here\'s our home page 🐼","link":"home"}');
    await runAssistant("seller", "233", session(), "send me the link to your home page", "idle");
    expect(sent).toEqual([{ kind: "cta", body: "Here's our home page 🐼", button: "Home page", url: "https://pandaworld.gh/" }]);
  });

  it("removes a web address it made up, and keeps ours", () => {
    const links = assistantLinks();
    expect(cleanReply("See https://jumia-fees.example.com/ghana or https://pandaworld.gh/pricing.", links))
      .toBe("See or https://pandaworld.gh/pricing.");
    expect(parseAction('{"type":"reply","text":"Try www.madeup.com","link":"nope"}', "link?", [], links))
      .toEqual({ type: "reply", text: "Try", link: null });
    expect(parseAction('{"type":"reply","text":"","link":"faq"}', "faq?", [], links))
      .toEqual({ type: "reply", text: "Here's the faq:", link: "faq" });
  });

  it("writes the model's markdown the WhatsApp way: one asterisk for bold, no headings", () => {
    const links = assistantLinks();
    expect(cleanReply("## Your shop\nI can show **orders** and **sales**.", links)).toBe("Your shop\nI can show *orders* and *sales*.");
  });

  it("asks for choices as bullets, never numbered", async () => {
    aiReplies.push('{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", session(), "what can you do?", "idle");
    const prompt = aiPrompts.at(-1)!;
    expect(prompt).toContain("never numbered");
    expect(prompt).not.toContain("a short numbered list");
  });

  it("keeps the review step's buttons under a reply there", async () => {
    db.tables.listings = [{ id: "l1", user_id: "seller", whatsapp_batch_id: "b1", whatsapp_seq: 1, title: "Hisense 205L Fridge", status: "draft" }];
    aiReplies.push('{"type":"reply","text":"Jumia\'s couriers deliver your orders. I can change your fridge\'s price, quantity or size, or submit it.","link":null}');
    await runAssistant("seller", "233", session({ state: "awaiting_confirmation", batchId: "b1" }), "who delivers my orders?", "review");
    expect(sent).toEqual([{ kind: "buttons", body: "Jumia's couriers deliver your orders. I can change your fridge's price, quantity or size, or submit it.", rows: ["submit all", "review"] }]);
  });
});

describe("the live shop, through the assistant (owner, 2026-10-07)", () => {
  const session = () => ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null }) as WhatsAppSession;

  it("hands a live change, and each question, to the shop module", async () => {
    aiReplies.push('{"type":"live_change","product":"Hisense fridge","stock":20}');
    expect(await runAssistant("seller", "233", session(), "set the Hisense fridge stock to 20", "idle")).toBe("handled");
    aiReplies.push('{"type":"order_status","number":"355926919"}');
    await runAssistant("seller", "233", session(), "where is order 355926919", "idle");
    aiReplies.push('{"type":"sales","period":"today"}');
    await runAssistant("seller", "233", session(), "how did I do today", "idle");
    aiReplies.push('{"type":"payouts"}');
    await runAssistant("seller", "233", session(), "has jumia paid me", "idle");
    expect(shopCalls).toEqual([
      ["proposeLiveChange", "Hisense fridge", { kind: "stock", stock: 20 }, { preferSid: null }],
      ["answerOrderStatus", "355926919"],
      ["answerSales", "today", null],
      ["answerPayouts"],
    ]);
    expect(db.tables.whatsapp_assistant_log[0]).toMatchObject({ outcome: "offered" });
  });

  it("is told what the live shop can do, and whether the seller's pack has it", async () => {
    aiReplies.push('{"area":"live_products"}', '{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", session(), "hi", "idle");
    const prompt = aiPrompts.at(-1)!;
    expect(prompt).toContain("- Their live Jumia products, found by name");
    expect(prompt).toContain("- The chat's shop features (products, orders, reports, payouts, fees): on");
    expect(prompt).toContain('{"type":"live_change"');
  });

  it("everyone", async () => {
    expect(await assistantEnabled("anyone")).toBe(true);
  });
});

describe("what the owner's live test showed (2026-10-07)", () => {
  const EARRINGS = product(1, "Asymmetrical Irregular Statement Earrings - Shell Inlay, Gold Tone");
  const WIG = product(2, "Kinky Curly Wig - 24 Inch Length, Full Lace");

  it("a draft is only changed when the seller's words name it", () => {
    expect(fitsDraft("gold medal", EARRINGS.listing.title)).toBe(false);
    expect(fitsDraft("the wigs", WIG.listing.title)).toBe(true);
    expect(fitsDraft("the second one", WIG.listing.title)).toBe(true);
  });

  it("\"set the gold medal to 25\" in review is a live product, not the gold-tone earrings draft", () => {
    expect(parseAction(
      '{"type":"edit","edits":[{"products":[1],"said":"gold medal","changes":{"price":25},"ask":false}]}',
      "Set the gold medal to 25", [EARRINGS, WIG],
    )).toEqual({ type: "live_change", product: "gold medal", change: { kind: "price", price: 25 } });
    expect(parseAction(
      '{"type":"edit","edits":[{"products":[2],"said":"wigs","changes":{"price":10},"ask":false}]}',
      "Change the wigs price to Ghs10", [EARRINGS, WIG],
    )).toEqual({ type: "edit", edits: [{ seqs: [2], changes: { price: 10 }, ask: false }], dropped: [] });
  });

  it("the sale window a seller leaves to us", () => {
    const now = new Date("2026-10-07T10:00:00Z");
    expect(saleWindow("sale 80 from 20 Oct to 30 Oct", now)).toEqual({ start: "2026-10-20", end: "2026-10-30" });
    expect(saleWindow("choose your own start and end date within this month", now)).toEqual({ start: "2026-10-07", end: "2026-10-31" });
    expect(saleWindow("just for this week", now)).toEqual({ start: "2026-10-07", end: "2026-10-13" });
    expect(saleWindow("make it 100", now)).toBeNull();
  });

  it("a question to the bot, not a product's notes", () => {
    for (const t of ["Has JUMIA payed me ?", "I won't list again", "You remember which one I last used?", "cancel"]) expect(looksLikeQuestion(t)).toBe(true);
    for (const t of ["Price 200, sizes M and L", "Brand new, black", "150"]) expect(looksLikeQuestion(t)).toBe(false);
  });

  it("reads the recent conversation, oldest first, without the message being answered", async () => {
    db.tables.whatsapp_message_log = [
      { phone_number: "233", direction: "outbound", message_type: "button", body_text: "⚠️ 30 is more than I can draft in one go — the most is 20 at a time.", created_at: "2026-10-07T01:29:10Z" },
      { phone_number: "233", direction: "inbound", message_type: "text", body_text: "I would like to list like 30 products", created_at: "2026-10-07T01:28:56Z" },
      { phone_number: "233", direction: "inbound", message_type: "interactive", body_text: "lpick:565dc00b-32d4-4737-a553-d08991fc0508:2", created_at: "2026-10-07T01:29:20Z" },
      { phone_number: "233", direction: "inbound", message_type: "text", body_text: "Let's do five then", created_at: "2026-10-07T01:29:38Z" },
    ];
    expect(await recentConversation("233", "Let's do five then")).toEqual([
      "Seller: I would like to list like 30 products",
      "Bot: ⚠️ 30 is more than I can draft in one go — the most is 20 at a time.",
      "Seller: [tapped a button]",
    ]);
  });

  // Owner, 2026-10-11: "the first one" and "the questions I asked" were lost at 300 characters and 6 messages.
  it("keeps long messages whole up to 1,200 characters, and the newest that fit in 12,000", async () => {
    const long = `Here are your drafts: ${"a fairly long product name, ".repeat(30)}the end`;
    db.tables.whatsapp_message_log = [
      { phone_number: "233", direction: "outbound", message_type: "text", body_text: long, created_at: "2026-10-11T01:00:00Z" },
      { phone_number: "233", direction: "inbound", message_type: "text", body_text: "the first one", created_at: "2026-10-11T01:01:00Z" },
    ];
    const lines = await recentConversation("233", "something new");
    expect(lines[0].length).toBeGreaterThan(800);
    expect(lines[0]).toContain("the end");
    expect(newestWithin(["Seller: a", "Bot: " + "x".repeat(50), "Seller: c"], 30)).toEqual(["Seller: c"]);
    expect(newestWithin(["Seller: a", "Seller: b"], 100)).toEqual(["Seller: a", "Seller: b"]);
  });

  it("the prompt carries the conversation, the rules and the examples", async () => {
    db.tables.whatsapp_message_log = [
      { phone_number: "233", direction: "outbound", message_type: "text", body_text: "the most is 20 at a time", created_at: "2026-10-07T01:29:10Z" },
    ];
    aiReplies.push('{"type":"list","count":5}');
    const session = { phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: "b0" } as WhatsAppSession;
    expect(await runAssistant("seller", "233", session, "Let's do five then", "sent")).toEqual({ list: 5 });
    expect(aiPrompts[0]).toContain("Recent conversation (oldest first):\nBot: the most is 20 at a time");
    expect(aiPrompts[0]).toContain("A reply never says you changed, will change or are changing anything");
    expect(aiPrompts[0]).toContain('"thanks" → {"type":"reply"');
    expect(db.tables.whatsapp_assistant_log[0]).toMatchObject({ raw: expect.stringContaining('{"type":"list","count":5}') });
  });

  it("the model can be switched in app_settings, to known ones only", async () => {
    const { assistantModel } = await import("@/lib/whatsapp/assistant");
    expect(await assistantModel()).toBe("gemini-2.5-flash-lite");
    db.tables.app_settings = [{ key: "assistant_model", value: "gemini-2.5-flash" }];
    expect(await assistantModel()).toBe("gemini-2.5-flash");
    db.tables.app_settings = [{ key: "assistant_model", value: "some-other-model" }];
    expect(await assistantModel()).toBe("gemini-2.5-flash-lite");
  });

  it("starting a batch: a note stays a note; a question is answered with where they are", async () => {
    const session = { phoneNumber: "233", userId: "seller", state: "awaiting_photos", batchId: "b1", batchSize: 2, batchSeq: 1, lastSubmittedBatchId: null } as WhatsAppSession;
    aiReplies.push('{"type":"note"}');
    expect(await runAssistant("seller", "233", session, "is it ok if the price is 200?", "starting")).toBe("step");
    expect(sent).toEqual([]);
    aiReplies.push('{"type":"payouts"}');
    expect(await runAssistant("seller", "233", session, "Has JUMIA payed me ?", "starting")).toBe("handled");
    expect(shopCalls).toEqual([["answerPayouts"]]);
    expect(sent.at(-1)!.body).toBe("📸 I'm still ready for product 1 of 2: send its photos when you're ready, or say *restart* to stop.");
    // A reply carries it in the same message.
    sent.length = 0;
    aiReplies.push('{"type":"reply","text":"Fashion > Shoes fits boots.","link":null}');
    await runAssistant("seller", "233", session, "what category should we use?", "starting");
    expect(sent).toEqual([{ kind: "text", body: "Fashion > Shoes fits boots.\n\n📸 I'm still ready for product 1 of 2: send its photos when you're ready, or say *restart* to stop." }]);
  });
});

describe("what the owner's second test showed (2026-10-07, round 3)", () => {
  const ctx = (lines: string[]) => lines.join("\n");
  const idle = () => ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null }) as WhatsAppSession;

  it("several products, one change: one action for all of them", () => {
    expect(parseAction('{"type":"live_change","products":["Mounted freezer","blender","chainsaw"],"stock":10}',
      "change the stock of the Mounted freezer and the blender and the chainsaw on my shop to 10", []))
      .toEqual({ type: "live_change", product: "Mounted freezer", others: ["blender", "chainsaw"], change: { kind: "stock", stock: 10 } });
    // A product the AI added that the seller never named is left out.
    expect(parseAction('{"type":"live_change","products":["freezer","kettle"],"stock":10}', "set the freezer to 10", []))
      .toEqual({ type: "live_change", product: "freezer", change: { kind: "stock", stock: 10 } });
    // "All the hard hats": every product it fits.
    expect(parseAction('{"type":"live_change","product":"hard hats","stock":0,"all":true}', "set all the hard hats to 0", []))
      .toEqual({ type: "live_change", product: "hard hats", change: { kind: "stock", stock: 0 }, all: true });
  });

  it("the value from the seller's own last message, when this one only names the products", () => {
    const context = ctx(["Seller: update the stock of those products to 10 each", "Bot: Which products do you mean?"]);
    expect(parseAction('{"type":"live_change","product":"Mounted freezer - 65 Ltrs","stock":10}', "okay the Mounted freezer and the blender and the chainsaw", [], {}, "GHS", { context }))
      .toEqual({ type: "live_change", product: "Mounted freezer - 65 Ltrs", change: { kind: "stock", stock: 10 } });
    // Not a number the bot said.
    expect(parseAction('{"type":"live_change","product":"freezer","stock":43}', "okay the freezer", [], {}, "GHS", { context: "Bot: the boot has 43 left" }))
      .toMatchObject({ type: "reply", awaiting: { field: "stock", products: ["freezer"] } });
  });

  it("an edit with no drafts around is a change to their Jumia products", () => {
    expect(parseAction('{"type":"edit","edits":[{"products":[1,2,3],"said":"Mounted freezer and the blender and the chainsaw","changes":{"quantity":10},"ask":false}]}',
      "i meant the stock of the Mounted freezer and the blender and the chainsaw should be made 10", []))
      .toEqual({ type: "live_change", product: "Mounted freezer", others: ["the blender", "the chainsaw"], change: { kind: "stock", stock: 10 } });
    expect(splitProducts("Salt and Pepper Grinder")).toEqual(["Salt and Pepper Grinder"]);
    expect(splitProducts("the kettle, the drill and the boot")).toEqual(["the kettle", "the drill", "the boot"]);
  });

  it("\"is the drone live?\" is a question, never a change", () => {
    expect(parseAction('{"type":"live_change","product":"drone","active":true}', "is the drone live?", [])).toEqual({ type: "product_info", product: "drone" });
    expect(parseAction('{"type":"live_change","product":"drones","active":true}', "is the dron active", [])).toEqual({ type: "product_info", product: "drones" });
    expect(parseAction('{"type":"product_info","product":"drone"}', "is the drone live?", [])).toEqual({ type: "product_info", product: "drone" });
    expect(isStateQuestion("can you turn on the drone?")).toBe(false);
    expect(isStateQuestion("the drone is on?")).toBe(true);
  });

  it("\"tun on\" and other ways of saying on; not \"on sale\"", () => {
    const on = (msg: string) => parseAction('{"type":"live_change","product":"drone","active":true}', msg, []);
    for (const msg of ["also tun on the drone", "turn the drone back on", "activate the drone", "make the drone live again"]) {
      expect(on(msg)).toEqual({ type: "live_change", product: "drone", change: { kind: "status", active: true } });
    }
    expect(on("put the drone on sale")).toEqual({ type: "unclear" });
  });

  it("the whole shop at once by live_change is asked as a rule, not attempted", () => {
    expect(parseAction('{"type":"live_change","product":null,"active":false}', "off all products", []))
      .toMatchObject({ type: "reply", text: expect.stringContaining("Say it as a rule") });
    expect(parseAction('{"type":"live_change","product":"other products","active":false}', "off all other products apart from the ones i asked you turn on", []))
      .toMatchObject({ type: "reply", text: expect.stringContaining("I'll show you the list before anything changes") });
    expect(parseAction('{"type":"live_change","product":"those products","stock":10}', "update the stock of those products to 10 each", []))
      .toMatchObject({ type: "reply", text: expect.stringContaining("Which products do you mean?") });
    expect(namesAProduct("the other ones")).toBe(false);
    expect(namesAProduct("the blender")).toBe(true);
  });

  it("several statuses, and as far back as Jumia goes", () => {
    expect(parseAction('{"type":"sales","period":"yesterday","status":["ready_to_ship","cancelled"]}', "check for ready to ship and cancelled order yesterday", []))
      .toEqual({ type: "sales", period: "yesterday", status: ["READY_TO_SHIP", "CANCELED"] });
    expect(parseAction('{"type":"sales","period":"all","status":"delivered"}', "any delivered orders past time?", []))
      .toEqual({ type: "sales", period: "quarter", status: "DELIVERED" });
    expect(parseAction('{"type":"sales","period":"quarter","status":null}', "how much has my shop made in 90days", []))
      .toEqual({ type: "sales", period: "quarter", status: null });
    expect(parseAction('{"type":"sales","period":"month","status":"returns"}', "returns", []))
      .toEqual({ type: "sales", period: "month", status: "RETURNED" });
  });

  it("fees: for a product they name, at a price from their message only", () => {
    expect(parseAction('{"type":"fees","product":"creatine","price":null}', "my creatine product how much will i recieve if it is sold?", []))
      .toEqual({ type: "fees", product: "creatine", price: null });
    expect(parseAction('{"type":"fees","product":"boot","price":120}', "what does jumia charge if I sell the boot at 120", []))
      .toEqual({ type: "fees", product: "boot", price: 120 });
    expect(parseAction('{"type":"fees","product":"boot","price":99}', "what does jumia charge for the boot", []))
      .toEqual({ type: "fees", product: "boot", price: null });
    // The AI's own name for it, seen live.
    expect(parseAction('{"type":"calculator","product":"creatine"}', "how much will I get for the creatine", [])).toEqual({ type: "fees", product: "creatine", price: null });
  });

  it("the prompt says: no promises, questions are product_info", async () => {
    aiReplies.push('{"area":"shop_info","also":"money"}', '{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", idle(), "hi there", "idle");
    const prompt = aiPrompts.at(-1)!;
    expect(prompt).toContain("A reply never says you changed, will change or are changing anything");
    expect(prompt).toContain('{"type":"product_info"');
    expect(prompt).toContain('{"type":"fees"');
    expect(prompt).toContain("- The chat's shop features (products, orders, reports, payouts, fees): on");
  });

  it("a bare number answers \"What should its stock be?\"", async () => {
    db.tables.whatsapp_sessions = [{ phone_number: "233", user_id: "seller", state: "awaiting_count" }];
    aiReplies.push('{"type":"live_change","product":"freezer","stock":7}');
    await runAssistant("seller", "233", idle(), "and the freezer", "idle");
    expect(sent.at(-1)!.body).toBe('What should its stock be? Send the number, e.g. "10".');
    const asked = db.tables.whatsapp_sessions[0].assistant_pending as Record<string, unknown>;
    expect(asked).toMatchObject({ kind: "live_value", field: "stock", products: ["freezer"] });

    const withAsk = { ...idle(), assistantPending: asked } as unknown as WhatsAppSession;
    expect(await answerLiveValue("seller", "233", withAsk, "10")).toBe(true);
    expect(shopCalls.at(-1)).toEqual(["proposeLiveChange", "freezer", { kind: "stock", stock: 10 }, { preferSid: null }]);
    expect(db.tables.whatsapp_sessions[0].assistant_pending).toBeNull();
    // Anything else drops the question.
    expect(await answerLiveValue("seller", "233", withAsk, "what about the kettle")).toBe(false);
    // A stale one is no longer an answer.
    const stale = { ...withAsk, assistantPending: { ...asked, at: "2026-01-01T00:00:00Z" } } as unknown as WhatsAppSession;
    expect(await answerLiveValue("seller", "233", stale, "10")).toBe(false);
  });

  it("hands several products and \"all\" to the shop module", async () => {
    aiReplies.push('{"type":"live_change","products":["freezer","blender"],"stock":10}');
    await runAssistant("seller", "233", idle(), "set the freezer and the blender to 10", "idle");
    aiReplies.push('{"type":"product_info","product":"drone"}');
    await runAssistant("seller", "233", idle(), "is the drone live?", "idle");
    aiReplies.push('{"type":"fees","product":"creatine","price":null}');
    await runAssistant("seller", "233", idle(), "how much do I get when the creatine sells", "idle");
    expect(shopCalls).toEqual([
      ["proposeLiveChange", ["freezer", "blender"], { kind: "stock", stock: 10 }, { preferSid: null }],
      ["answerProductInfo", "drone"],
      ["answerFees", "creatine", null, undefined],
    ]);
  });
});

describe("each seller's daily limit, by pack (owner, 2026-10-11: \"make the baseline 250\")", () => {
  const session = () => ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null }) as WhatsAppSession;
  const turns = (n: number, userId = "seller") => {
    db.tables.whatsapp_assistant_log = Array.from({ length: n }, (_, i) => ({
      id: i + 1, user_id: userId, stage: "idle", message: "hi", raw: "{}", outcome: "replied", created_at: new Date().toISOString(),
    }));
  };

  const bought = (credits: number) => {
    db.tables.extension_credit_transactions = [{ user_id: "seller", type: "purchase", amount: credits, created_at: "2026-10-01T00:00:00Z" }];
  };

  it("250 a day on free credits and Standard; only their own AI turns today count", async () => {
    db.tables.extension_credit_transactions = [];
    turns(249);
    db.tables.whatsapp_assistant_log.push(
      { id: 900, user_id: "someone-else", stage: "idle", message: "hi", raw: "{}", outcome: "replied", created_at: new Date().toISOString() },
      { id: 901, user_id: "seller", stage: "idle", message: "tap", raw: null, outcome: "replied", created_at: new Date().toISOString() },
      { id: 902, user_id: "seller", stage: "idle", message: "old", raw: "{}", outcome: "replied", created_at: new Date(Date.now() - 2 * 86_400_000).toISOString() },
    );
    expect(await assistantGate("seller")).toEqual({ ok: true });
    turns(250);
    expect(await assistantGate("seller")).toEqual({ ok: false, reason: "seller", limit: 250, pack: null });
    bought(210);
    expect(await assistantGate("seller")).toEqual({ ok: false, reason: "seller", limit: 250, pack: "standard" });
  });

  it("500 on Pro, none on Business, none for admins", async () => {
    bought(440);
    turns(499);
    expect(await assistantGate("seller")).toEqual({ ok: true });
    turns(500);
    expect(await assistantGate("seller")).toEqual({ ok: false, reason: "seller", limit: 500, pack: "pro" });
    bought(940);
    turns(3000);
    expect(await assistantGate("seller")).toEqual({ ok: true });
    turns(3000, "admin");
    expect(await assistantGate("admin")).toEqual({ ok: true });
  });

  it("told once a day, with the bigger packs; after that the fixed flow answers, with no AI call", async () => {
    db.tables.extension_credit_transactions = [];
    turns(250);
    expect(await runAssistant("seller", "233", session(), "what else", "idle")).toBe("handled");
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toBe("You've reached today's 250 chat messages, so I'll answer questions again after midnight (GMT). Until then, type *menu* for the commands: listing products and the buttons work as usual. The Pro pack gets 500 a day, and Business has no limit.");
    expect(await runAssistant("seller", "233", session(), "and now?", "idle")).toBe("limited");
    expect(sent).toHaveLength(1);
    expect(aiCalls).toBe(0);
  });

  it("the global ceiling rests it for everyone but admins, with no AI call", async () => {
    db.tables.app_settings = [{ key: "assistant_daily_limit", value: 3 }];
    turns(3, "someone-else");
    expect(await assistantGate("seller")).toEqual({ ok: false, reason: "ceiling" });
    expect(await assistantGate("admin")).toEqual({ ok: true });
    expect(await runAssistant("seller", "233", session(), "what else", "idle")).toBe("limited");
    expect(sent).toEqual([]);
    expect(aiCalls).toBe(0);
  });

  it("the kill switch turns it off, admins included", async () => {
    db.tables.app_settings = [{ key: "assistant_enabled", value: false }];
    expect(await assistantEnabled("admin")).toBe(false);
    db.tables.app_settings = [];
    expect(await assistantEnabled("admin")).toBe(true);
  });

});

describe("more of the Jumia API (owner, 2026-10-07: \"do all\")", () => {
  const NOW = new Date("2026-10-07T10:00:00Z"); // a Wednesday
  const parse = (json: string, msg: string) => parseAction(json, msg, [], {}, "GHS", { now: NOW });

  // The word rules that used to correct the AI's choice went with the old
  // one-call reader (11 Oct): a misreading is a test case, never a rule.
  it("the AI's choice stands, checked for safety only", () => {
    expect(parse('{"type":"shop","filter":"all"}', "How many of my products are on")).toEqual({ type: "shop", filter: "all" });
    // A product the message doesn't name is asked about, never looked up.
    expect(parse('{"type":"product_info","product":"Vintage Radio"}', "How many of my products are on")).toMatchObject({ type: "reply", text: expect.stringContaining("Which product?") });
    expect(parse('{"type":"listings","period":"today"}', "how many listings have I done today")).toEqual({ type: "listings", period: "today" });
  });

  it("rules for many products: the scope and every number from the message", () => {
    expect(parse('{"type":"bulk","scope":"all","price_pct":5}', "raise all my prices by 5%"))
      .toEqual({ type: "bulk", scope: "all", words: null, change: { kind: "price_pct", pct: 5 } });
    expect(parse('{"type":"bulk","scope":"all","price_pct":10}', "reduce all prices by 10%"))
      .toEqual({ type: "bulk", scope: "all", words: null, change: { kind: "price_pct", pct: -10 } });
    expect(parse('{"type":"bulk","scope":"matching","words":"perfumes","sale_pct":10}', "10% off all perfumes this weekend"))
      .toEqual({ type: "bulk", scope: "matching", words: "perfumes", change: { kind: "sale_pct", pct: 10, start: "2026-10-10", end: "2026-10-11" } });
    expect(parse('{"type":"bulk","scope":"out_of_stock","active":false}', "turn off everything that's out of stock"))
      .toEqual({ type: "bulk", scope: "out_of_stock", words: null, change: { kind: "status", active: false } });
    expect(parse('{"type":"bulk","scope":"all","sale":"end"}', "end the sale on all products"))
      .toEqual({ type: "bulk", scope: "all", words: null, change: { kind: "sale", sale: null } });
  });

  it("reads a follow-up that points back to the rule before it (owner's web chat, 2026-10-08)", () => {
    const ctx = "Seller: on all the products that are off\nBot: What should their stock be?";
    expect(parseAction('{"type":"bulk","scope":"inactive","words":null,"active":true}', "on them and keet their current stock", [], {}, "GHS", { context: ctx }))
      .toEqual({ type: "bulk", scope: "inactive", words: null, change: { kind: "status", active: true } });
    // Without the rule before it, "them" alone isn't many products.
    expect(parseAction('{"type":"bulk","scope":"inactive","words":null,"active":true}', "on them", [], {}, "GHS", { context: "" })).toEqual({ type: "unclear" });
  });

  it("\"change the description of X\" with no new text asks for one to be written", () => {
    expect(parseAction('{"type":"content_change","product":"wellington boot","description":null,"rewrite":["description"]}', "change the description of the wellington boot", [], {}, "GHS"))
      .toMatchObject({ type: "content_change", product: "wellington boot", request: { rewrite: ["description"] } });
  });

  it("a rule the message doesn't back isn't carried out", () => {
    // No "all" or percentage: not a rule.
    expect(parse('{"type":"bulk","scope":"all","price_pct":5}', "raise the kettle price")).toEqual({ type: "unclear" });
    // A percentage that isn't in the message.
    expect(parse('{"type":"bulk","scope":"all","price_pct":5}', "raise all my prices a bit")).toMatchObject({ type: "reply", text: expect.stringContaining("By what percentage") });
    // A sale with no dates is asked for them.
    expect(parse('{"type":"bulk","scope":"all","sale_pct":10}', "10% off everything")).toMatchObject({ type: "reply", text: expect.stringContaining("needs its dates") });
    // "out of stock" the AI made up becomes all only when the message says the whole shop.
    expect(parse('{"type":"bulk","scope":"out_of_stock","active":true}', "turn on all products")).toMatchObject({ type: "bulk", scope: "all" });
    // Otherwise it's asked, never widened on a guess.
    expect(parse('{"type":"bulk","scope":"out_of_stock","stock":10}', "set all back to 10")).toMatchObject({ type: "reply", text: expect.stringContaining("Every product in your shop, or only the ones out of stock?") });
    // Products it can't name from the message.
    expect(parse('{"type":"bulk","scope":"matching","words":"shoes","price_pct":5}', "raise all prices by 5%")).toMatchObject({ type: "reply" });
  });

  it("content: copied from the message, or a rewrite they asked for", () => {
    expect(parse('{"type":"content_change","product":"blender","name":"Silver Crest 3 in 1 Blender 1.5L","rewrite":[]}', "change the blender's name to Silver Crest 3 in 1 Blender 1.5L"))
      .toEqual({ type: "content_change", product: "blender", request: { name: "Silver Crest 3 in 1 Blender 1.5L" } });
    expect(parse('{"type":"content_change","product":"wellington boot","rewrite":["description"]}', "rewrite the description of the wellington boot"))
      .toEqual({ type: "content_change", product: "wellington boot", request: { rewrite: ["description"], instructions: "rewrite the description of the wellington boot" } });
    // A name it made up is never sent: asked to change the name, PandaWorld
    // writes one from what Jumia has, with their words as the instructions.
    expect(parse('{"type":"content_change","product":"blender","name":"Best Blender Ever","rewrite":[]}', "change the blender's name"))
      .toEqual({ type: "content_change", product: "blender", request: { rewrite: ["name"], instructions: "change the blender's name" } });
    // Owner's WhatsApp, 2026-10-08: removing a word, the name not even said.
    const bodysuit = "Backless Thong Bodysuit - Adjustable Straps, Thong Design";
    expect(parseAction(`{"type":"content_change","product":"${bodysuit}","name":"Backless Bodysuit - Adjustable Straps","rewrite":[]}`,
      "Just redraft the name yourself for the last submitted product \nIt has the name thong in it just remove that word", [], {}, "GHS", { now: NOW, context: `Bot: The '${bodysuit}' was listed from our chat` }))
      .toMatchObject({ type: "content_change", product: bodysuit, request: { rewrite: ["name"] } });
    expect(parseAction(`{"type":"content_change","product":"${bodysuit}","rewrite":["name"]}`, "Okay it is not a Thong so change that", [], {}, "GHS", { now: NOW, context: `Bot: The '${bodysuit}' was listed from our chat` }))
      .toMatchObject({ type: "content_change", request: { rewrite: ["name"], instructions: "Okay it is not a Thong so change that" } });
    // Without asking for a change, a made-up name still gets the question.
    expect(parse('{"type":"content_change","product":"blender","name":"Best Blender Ever","rewrite":[]}', "the blender"))
      .toMatchObject({ type: "reply", text: expect.stringContaining("What should I change on it?") });
  });

  it("reports, payouts in detail, brands, categories, shops and the warehouse", () => {
    expect(parse('{"type":"report","kind":"best_sellers","period":"month"}', "my best sellers")).toEqual({ type: "report", kind: "best_sellers", period: "month" });
    expect(parse('{"type":"report","kind":"top"}', "top")).toEqual({ type: "unclear" });
    expect(parse('{"type":"payout_detail","mode":"breakdown","statement":"GH11-20261005"}', "fees on statement GH11-20261005"))
      .toEqual({ type: "payout_detail", mode: "breakdown", statement: "GH11-20261005" });
    expect(parse('{"type":"payout_detail","mode":"breakdown","statement":"X99"}', "fees on my last statement"))
      .toEqual({ type: "payout_detail", mode: "breakdown", statement: null });
    expect(parse('{"type":"brand_check","brand":"Lattafa","product":null}', "is Lattafa a brand on jumia?")).toEqual({ type: "brand_check", brand: "Lattafa", product: null });
    expect(parse('{"type":"category_info","product":"perfume"}', "what does jumia need to list a perfume")).toEqual({ type: "category_info", product: "perfume" });
    expect(parse('{"type":"shops"}', "which shops do I have")).toEqual({ type: "shops" });
    expect(parse('{"type":"warehouse_order","items":[{"product":"kettle","quantity":50}]}', "send 50 of the kettle to jumia warehouse on 20 Oct"))
      .toEqual({ type: "warehouse_order", items: [{ product: "kettle", quantity: 50 }], date: "2026-10-20" });
    expect(parse('{"type":"warehouse_order","items":[{"product":"kettle","quantity":60}]}', "send 50 of the kettle to jumia warehouse"))
      .toMatchObject({ type: "reply" });
    expect(parse('{"type":"warehouse_shipped","po":"123AB","tracking":"DHL998877","carrier":null}', "PO 123AB shipped, tracking DHL998877"))
      .toEqual({ type: "warehouse_shipped", po: "123AB", tracking: "DHL998877", carrier: null });
    expect(parse('{"type":"warehouse_shipped","po":"123AB","tracking":"XYZ"}', "PO 123AB shipped")).toMatchObject({ type: "reply" });
  });
});

describe("the chat's billed commands, understood (owner, 2026-10-07)", () => {
  it("polish and the shop health report are actions", () => {
    expect(parseAction('{"type":"polish","product":2}', "can you polish the photos of product 2", [])).toEqual({ type: "polish", seq: 2 });
    // A number the seller didn't write isn't taken.
    expect(parseAction('{"type":"polish","product":3}', "polish my photos", [])).toEqual({ type: "polish", seq: null });
    expect(parseAction('{"type":"health_report"}', "how is my shop doing?", [])).toEqual({ type: "health_report" });
  });

  it("the prompt lists them with their prices, and the commands", async () => {
    aiReplies.push('{"area":"shop_info"}', '{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", { phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null } as never, "hi", "idle");
    const prompt = aiPrompts.at(-1)!;
    expect(prompt).toContain("3 credits each");
    expect(prompt).toContain('{"type":"health_report"}');
    expect(prompt).toContain("Only polish, the report and changes to live products cost credits");
  });
});

// The owner's web chat, 2026-10-07: the bot asked "What variation(s) do you
// have?" for a drafted bodysuit, and the answer carried the price, the sizes
// and the colours. It was refused once ("isn't one of the drafts here") and
// then set all 54 of the category's sizes.
describe("one message with a draft's price, sizes and colours", () => {
  const MSG = "Price: 130gh \nSizes: Large, Medium, Small.\nColors: cream, black and brown";
  const asked = { listingId: "l1", field: "__variation" };
  const session = () =>
    ({ phoneNumber: "233", userId: "seller", state: "awaiting_confirmation", batchId: "b1", lastSubmittedBatchId: null, awaitingValueFor: asked }) as unknown as WhatsAppSession;

  beforeEach(() => {
    db.tables.listings = [{
      id: "l1", user_id: "seller", whatsapp_batch_id: "b1", whatsapp_seq: 1, status: "draft", category_code: 100,
      title: "3-Piece Thong Bodysuit - Seamless, Tummy Control, Adjustable Straps", selling_price: 130, color: "Beige, Black, Brown",
    }];
    db.tables.variants = [];
    db.tables.whatsapp_sessions = [{ phone_number: "233", user_id: "seller", state: "awaiting_confirmation", awaiting_value_for: asked }];
  });

  it("sets the sizes it names and the colours in the seller's words, and closes the size question", async () => {
    aiReplies.push('{"type":"edit","edits":[{"products":[1],"said":"Large, Medium, Small.","changes":{"variations":["Large","Medium","Small"],"color":"cream, black and brown"},"ask":false}]}');
    expect(await runAssistant("seller", "233", session(), MSG, "review")).toBe("handled");
    expect((db.tables.variants as { variation: string }[]).map((v) => v.variation)).toEqual(["L", "M", "S"]);
    expect(db.tables.listings[0].color).toBe("cream, black and brown");
    expect(db.tables.whatsapp_sessions[0].awaiting_value_for).toBeNull();
    expect(sent.at(-1)!.body).not.toContain("isn't one of the drafts");
  });

  it("saves the options the AI matched the seller's words to", async () => {
    aiReplies.push('{"type":"edit","edits":[{"products":[1],"said":null,"changes":{"variations":[{"said":"Large","option":"L"},{"said":"Medium","option":"M"},{"said":"Small","option":"S"}]},"ask":false}]}');
    await runAssistant("seller", "233", session(), MSG, "review");
    expect((db.tables.variants as { variation: string }[]).map((v) => v.variation)).toEqual(["L", "M", "S"]);
    expect(db.tables.whatsapp_sessions[0].awaiting_value_for).toBeNull();
  });

  it("the AI's copy of every option still sets only the three", async () => {
    aiReplies.push('{"type":"edit","edits":[{"products":[1],"said":"3-Piece Thong Bodysuit","changes":{"variations":["S","M","L","XL","XXL"],"color":"Beige, Black, Brown"},"ask":false}]}');
    await runAssistant("seller", "233", session(), MSG, "review");
    expect((db.tables.variants as { variation: string }[]).map((v) => v.variation)).toEqual(["S", "M", "L"]);
    expect(db.tables.listings[0].color).toBe("cream, black and brown");
  });
});

// Owner, 2026-10-08: "let it be able to make a number of Different API calls
// to the vendor shop and get info and data and organize them to fit the
// sellers request". The reads themselves are in shop-research.test.ts.
describe("research: several reads of the shop, answered together", () => {
  const links = assistantLinks();
  const newest = (limit: number) => ({
    type: "research", needs: [{ source: "products", sort: "newest", filter: "all", words: null, limit, since: null }],
  });

  it("\"the last 10 products uploaded\": the AI's research, as it read it", () => {
    const msg = "the full list of the last 10products uploaded on my shop";
    expect(parseAction(JSON.stringify(newest(10)), msg, [], links)).toEqual(newest(10));
    expect(parseAction('{"type":"reply","text":"x","link":null}', "thanks", [], links)).toEqual({ type: "reply", text: "x", link: null });
    expect(parseAction("nonsense", "what are the 5 items I added recently", [], links)).toEqual({ type: "unclear" });
  });

  it("listing new products now stays listing", () => {
    expect(parseAction('{"type":"list","count":5}', "I want to list 5 new products", [], links)).toEqual({ type: "list", count: 5 });
    expect(parseAction('{"type":"list","count":3}', "let's list my last 3 products", [], links)).toEqual({ type: "list", count: 3 });
  });

  it("keeps known reads only, at most four, with the seller's own words", () => {
    const raw = JSON.stringify({ type: "research", needs: [
      { source: "products", sort: "price_high", filter: "on_sale", words: "perfumes", limit: 99 },
      { source: "products", sort: "newest", words: "gold medals" },
      { source: "orders", period: "week", status: "cancelled", limit: 5 },
      { source: "orders", period: "week", status: "cancelled", limit: 5 },
      { source: "secrets" },
      { source: "payouts" },
      { source: "product_sales", period: "fortnight" },
      { source: "pandaworld_listings", period: "today" },
    ] });
    expect(parseAction(raw, "my priciest perfumes on sale, cancelled orders this week, payouts and sales", [], links)).toEqual({
      type: "research", needs: [
        { source: "products", sort: "price_high", filter: "on_sale", words: "perfumes", limit: 30, since: null },
        // "gold medals" isn't in the message: not searched for.
        { source: "products", sort: "newest", filter: "all", words: null, limit: 10, since: null },
        { source: "orders", period: "week", status: "CANCELED", limit: 5 },
        { source: "payouts" },
      ],
    });
    expect(parseAction('{"type":"research","needs":[{"source":"secrets"}]}', "anything", [], links)).toEqual({ type: "unclear" });
  });

  it("a product's name on its own: the reading is told it's one of their products", async () => {
    const name = "Malta Guinness Soft Drink - 330ml Bottles, Pack of 6 (6 Bottles)";
    db.tables.jumia_products = [{ user_id: "seller", product_sid: "x", seller_sku: "MALTA-6", name }];
    aiReplies.push('{"area":"shop_info"}', '{"type":"product_info","product":"Malta Guinness Soft Drink - 330ml Bottles, Pack of 6"}');
    shopCalls.length = 0;
    await runAssistant("seller", "233", { phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null } as never, "Malta Guinness Soft Drink - 330ml Bottles, Pack of 6", "idle");
    expect(aiPrompts.at(-1)).toContain(`Products in their Jumia shop the message names: "${name}"`);
    expect(shopCalls).toEqual([["answerProductInfo", "Malta Guinness Soft Drink - 330ml Bottles, Pack of 6"]]);
  });

  it("is in the prompt, with the owner's question as its example", async () => {
    aiReplies.push('{"area":"shop_info"}', '{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", { phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null } as never, "hello", "idle");
    const prompt = aiPrompts[aiPrompts.length - 1];
    expect(prompt).toContain('{"type":"research","needs":[');
    expect(prompt).toContain('"the full list of the last 10 products uploaded on my shop" → {"type":"research"');
  });
});

// The owner's web chat, 2026-10-08 (09:34 to 10:04): after the bot asked
// how many products they're listing, product changes were read as counts.
describe("a change to a product is never a count", () => {
  const links = assistantLinks();
  const stock = (product: string, n: number) => ({ type: "live_change", product, change: { kind: "stock", stock: n } });

  it("a change the AI reads is carried out as it read it, values from the message", () => {
    expect(parseAction('{"type":"live_change","product":"foladable drone","stock":10}', "restock the foladable drone to. 10", [], links)).toEqual(stock("foladable drone", 10));
    expect(parseAction('{"type":"live_change","product":"drone","stock":10}', "Change drone to 10 psc", [], links)).toEqual(stock("drone", 10));
    // A value the message doesn't give isn't set.
    expect(parseAction('{"type":"live_change","product":"drone","stock":12}', "Change drone to 10 psc", [], links)).not.toEqual(stock("drone", 12));
  });

  it("\"those\" and \"the last 10\" are the products the bot just listed, never the whole shop", () => {
    const listed = (n: number) => ({ type: "bulk", scope: "listed", words: null, change: { kind: "stock", stock: n } });
    // The AI's own "listed" for "restock all": only those.
    expect(parseAction('{"type":"bulk","scope":"listed","words":null,"stock":10}', "restock all back to 10", [], links, "GHS", { listed: true })).toEqual(listed(10));
    expect(parseAction('{"type":"bulk","scope":"listed","words":null,"stock":20}', "change the stock of the lat 10 to 20", [], links, "GHS", { listed: true })).toEqual(listed(20));
    // Nothing listed lately: it asks which.
    expect(parseAction('{"type":"bulk","scope":"listed","words":null,"stock":10}', "set those to 10 pcs", [], links)).toMatchObject({ type: "reply", text: expect.stringContaining("Which products?") });
  });

  it("carries a change to the listed products out on exactly those", async () => {
    aiReplies.push('{"type":"bulk","scope":"listed","words":null,"stock":20}');
    shopCalls.length = 0;
    const at = new Date().toISOString();
    await runAssistant("seller", "233", {
      phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null,
      lastListed: { sids: ["s1", "s2"], what: "The 10 newest products", at },
    } as never, "change the stock of the last 10 to 20", "idle");
    expect(shopCalls).toEqual([["proposeBulkChange", "listed", null, { kind: "stock", stock: 20 }, ["s1", "s2"], null]]);
    expect(aiPrompts[aiPrompts.length - 1]).toContain("Products you last listed for them: 2 (The 10 newest products).");
  });

  it("a count the message doesn't give is only a wish to list", () => {
    expect(parseAction('{"type":"list","count":3}', "let's enter listing mode", [], links)).toEqual({ type: "restart" });
    expect(parseAction('{"type":"restart"}', "Stop listing", [], links)).toEqual({ type: "restart" });
  });

  it("no colour warning when the message doesn't mention colour", () => {
    const raw = '{"type":"edit","edits":[{"products":[2],"said":null,"changes":{"variations":[{"said":"Large","option":"L"},{"said":"Medium","option":"M"}],"color":"Navy Blue"},"ask":false}]}';
    expect(parseAction(raw, "Large and Medium", [SHIRT], links)).toEqual({ type: "edit", edits: [{ seqs: [2], changes: { variations: ["L", "M"] }, ask: false }], dropped: [] });
    expect(parseAction(raw, "Large and Medium, colour navy", [SHIRT], links)).toMatchObject({ dropped: ["colour"] });
  });
});

describe("honest \"can't\" (owner, 2026-10-11)", () => {
  const session = () => ({ phoneNumber: "233", userId: "seller", state: "awaiting_count", batchId: null, lastSubmittedBatchId: null }) as WhatsAppSession;
  const links = assistantLinks();
  const wishes = () => (db.tables.assistant_wishes ?? []) as { user_id: string; channel: string; request: string; message: string; blocked_reply: string | null }[];

  it("knows a reply that says PandaWorld can't, or sends them to Vendor Center to do it", () => {
    for (const t of [
      "Sorry, I can't book deliveries.", "I’m unable to do that from here.", "I don't keep a record of our chats.", "We cannot change that.",
      "You'll need to use Vendor Center for that.", "Please update the price in Vendor Center.", "That's not possible here.", "PandaWorld doesn't have the ability to do this.",
    ]) expect({ t, can: claimsInability(t) }).toEqual({ t, can: true });
    for (const t of [
      "You're welcome! 🙌", "Jumia's couriers deliver your orders.", "Your pack isn't shown here: see Settings.",
      "1. In Jumia Vendor Center, open Settings → Applications → Create Application.\n2. Copy the Client ID and the token.",
      "Log in to Vendor Center, create a Self Authorization application and paste its token here.",
    ]) expect({ t, can: claimsInability(t) }).toEqual({ t, can: false });
  });

  it("a reply that says it can't is stopped: not_yet, with their message as the request", () => {
    expect(parseAction('{"type":"reply","text":"Sorry, I can\'t book deliveries.","link":null}', "book me a delivery truck", [], links))
      .toEqual({ type: "not_yet", what: "book me a delivery truck", outside: false, blocked: "Sorry, I can't book deliveries." });
    expect(parseAction('{"type":"reply","text":"I can\'t help with that, I only help with your Jumia shop.","link":null}', "what's the weather", [], links))
      .toMatchObject({ type: "not_yet", outside: true });
  });

  it("\"can you…?\" is answered from the capability list, word for word", () => {
    expect(parseAction('{"type":"capability","what":"live_price"}', "can you change prices?", [], links))
      .toEqual({ type: "reply", text: expect.stringMatching(/^Yes: .*make the kettle 150/), link: null });
    expect(parseAction('{"type":"capability","what":"delete_product"}', "can you delete products?", [], links))
      .toEqual({ type: "reply", text: expect.stringContaining("Jumia only lets a product be deleted in Vendor Center"), link: "vendor_center" });
    // Not built yet: its own answer, and noted.
    expect(parseAction('{"type":"capability","what":"translations"}', "can you list in french?", [], links))
      .toMatchObject({ type: "not_yet", outside: false, text: expect.stringContaining("in English for now") });
    expect(parseAction('{"type":"cannot","what":"translations"}', "list it in french", [], links)).toMatchObject({ type: "not_yet" });
    expect(parseAction('{"type":"capability","what":"teleport"}', "can you teleport?", [], links)).toEqual({ type: "unclear" });
  });

  it("not_yet answers with one line and notes the request; outside Jumia it isn't noted", async () => {
    aiReplies.push('{"type":"not_yet","what":"post products on Instagram","outside":false}');
    expect(await runAssistant("seller", "233", session(), "can you post my products on instagram?", "idle")).toBe("handled");
    expect(sent).toEqual([{ kind: "text", body: NOT_YET_TEXT }]);
    expect(wishes()).toEqual([expect.objectContaining({ user_id: "seller", channel: "whatsapp", request: "post products on Instagram", message: "can you post my products on instagram?", blocked_reply: null })]);

    sent.length = 0;
    aiReplies.push('{"type":"not_yet","what":"the weather","outside":true}');
    await runAssistant("seller", "233", session(), "what's the weather in accra", "idle");
    expect(sent).toEqual([{ kind: "text", body: OUTSIDE_TEXT }]);
    expect(wishes()).toHaveLength(1);
  });

  // Owner, 2026-10-11: "if our system has no way to do the thing, how do we show it the way to do what is possible".
  it("not_yet offers the nearest thing the chat does, in the list's own words", async () => {
    const links = assistantLinks();
    const read = parseAction('{"type":"not_yet","what":"other sellers\' prices","outside":false,"instead":"fees"}', "what do other sellers charge for the kettle?", [], links);
    expect(read).toMatchObject({ type: "not_yet", what: "other sellers' prices", text: expect.stringMatching(/^I can't do that yet\. I've noted it\. What I can do instead: ask e\.g\. "how much will I receive/) });
    // A key the chat doesn't do, or something outside Jumia: just the line.
    expect(parseAction('{"type":"not_yet","what":"x","outside":false,"instead":"delete_product"}', "x", [], links)).toEqual({ type: "not_yet", what: "x", outside: false });
    expect(parseAction('{"type":"not_yet","what":"the weather","outside":true,"instead":"sales"}', "what's the weather", [], links)).toEqual({ type: "not_yet", what: "the weather", outside: true });

    aiReplies.push('{"type":"not_yet","what":"other sellers\' prices","outside":false,"instead":"fees"}');
    expect(await runAssistant("seller", "233", session(), "what do other sellers charge for the kettle?", "idle")).toBe("handled");
    expect(sent[0].body).toContain("What I can do instead:");
    expect(wishes()).toEqual([expect.objectContaining({ request: "other sellers' prices" })]);
  });

  it("agent mode: a reply that says it can't isn't sent; it's asked once more without reply", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    toolReplies.push(
      [{ name: "reply", args: { text: "Sorry, I can't change stock from here. Use Vendor Center." } }],
      [{ name: "live_change", args: { product: "kettle", stock: 10 } }],
    );
    expect(await runAssistant("seller", "233", session(), "set the kettle stock to 10", "idle")).toBe("handled");
    expect(toolAllowed[1]).not.toContain("reply");
    expect(toolAllowed[1]).toContain("not_yet");
    expect(shopCalls[0]).toEqual(["proposeLiveChange", "kettle", { kind: "stock", stock: 10 }, { preferSid: null }]);
    expect((db.tables.whatsapp_assistant_log as { raw: string }[])[0].raw).toContain("(said it can't: not sent)");
  });

  it("agent mode: what PandaWorld doesn't do gets the fixed line and goes on the wish list", async () => {
    db.tables.app_settings = [{ key: "assistant_agent", value: "all" }];
    toolReplies.push([{ name: "not_yet", args: { what: "design a logo", outside: false } }]);
    await runAssistant("seller", "233", session(), "can you design a logo for my shop", "idle");
    expect(sent).toEqual([{ kind: "text", body: NOT_YET_TEXT }]);
    expect(wishes().map((w) => w.request)).toEqual(["design a logo"]);
  });

  it("the front door reads it again when its reply said it can't", async () => {
    aiReplies.push('{"area":"chat"}', '{"type":"reply","text":"I can\'t post to Instagram.","link":null}', '{"type":"not_yet","what":"post to Instagram","outside":false}');
    await runAssistant("seller", "233", session(), "post my kettle on instagram", "idle");
    expect(aiPrompts[2]).toContain("It was NOT sent");
    expect(sent).toEqual([{ kind: "text", body: NOT_YET_TEXT }]);
    expect(wishes().map((w) => w.request)).toEqual(["post to Instagram"]);
  });

  it("every prompt has the new actions and the list of what the chat does", async () => {
    aiReplies.push('{"type":"reply","text":"Hi!","link":null}');
    await runAssistant("seller", "233", session(), "hello", "idle");
    const prompt = aiPrompts.at(-1)!;
    expect(prompt).toContain('{"type":"capability"');
    expect(prompt).toContain('{"type":"not_yet"');
    expect(prompt).toContain("- live_price: Change a product's price");
    expect(prompt).not.toContain("can't help with it");
  });
});

describe("misses from 2026-10-11", () => {
  it("variationPricesIn: a variation with its price after it, never a quantity or another size", () => {
    const o = ["50ml", "100ml", "10ml", "M"];
    expect(variationPricesIn("10ml 3000", o)).toEqual([{ option: "10ml", price: 3000 }]);
    expect(variationPricesIn("50ml: GHS 4,500 and 100ml at 6000", o)).toEqual([{ option: "50ml", price: 4500 }, { option: "100ml", price: 6000 }]);
    expect(variationPricesIn("set 50ml to 4500", o)).toEqual([{ option: "50ml", price: 4500 }]);
    expect(variationPricesIn("change 50ml to 100ml", o)).toEqual([]);
    expect(variationPricesIn("10ml 30 pieces", o)).toEqual([]);
    expect(variationPricesIn("stock: M 20", o)).toEqual([]);
    expect(variationPricesIn("add a 10ml variation", o)).toEqual([]);
  });

  it("a size and a price isn't a product's name", () => {
    expect(saidIsValues("10ml 3000", { variations: ["50ml", "100ml", "10ml"] })).toBe(true);
    expect(saidIsValues("iphone 13", { price: 13 })).toBe(false);
    expect(saidIsValues("3000", { price: 5 })).toBe(false);
  });

  it("\"stock checklist\" is the whole stock list, and low only when they say so", () => {
    expect(parseAction('{"type":"stock","product":"checklist","filter":"low"}', "Can you get me the stock checklist", [])).toEqual({ type: "stock", product: null, filter: null });
    expect(parseAction('{"type":"stock","product":null,"filter":"low"}', "what is running low", [])).toEqual({ type: "stock", product: null, filter: "low" });
    expect(parseAction('{"type":"stock","product":null,"filter":"low"}', "which products need restocking", [])).toEqual({ type: "stock", product: null, filter: "low" });
    expect(parseAction('{"type":"stock","product":"kettle","filter":null}', "stock of the kettle", [])).toEqual({ type: "stock", product: "kettle", filter: null });
    expect(stockListWords("full inventory report")).toBe(true);
    expect(stockListWords("checklist pad")).toBe(false);
  });

  it("a rewrite asked in the message before, with this one saying which product, is kept", () => {
    const context = "Seller: I have a spectacle product i want to rewrite the description\nBot: I couldn't find spectacle in your shop.";
    expect(contentAction({ product: "Wireless Eyewear Audio Glasses - Bluetooth 5.0", rewrite: ["description"] }, "it is a bluetooth lens", context)).toEqual({
      type: "content_change", product: "Wireless Eyewear Audio Glasses - Bluetooth 5.0",
      request: { rewrite: ["description"], instructions: "I have a spectacle product i want to rewrite the description it is a bluetooth lens" },
    });
    // Asked by no one: still a question.
    expect(contentAction({ product: "Wireless Eyewear Audio Glasses - Bluetooth 5.0", rewrite: ["description"] }, "it is a bluetooth lens", "Seller: hi\nBot: Hello")).toMatchObject({ type: "reply" });
  });
});
