/**
 * More of the Jumia API in chat (owner, 2026-10-07: "do all"): rules for many
 * products, a live product's content, reports from orders, payouts in
 * detail, brands, the shops under the account and Jumia's warehouse. Jumia's
 * answers follow the shapes in its spec (vendorcenter.jumia.com/api-docs).
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/jumia/oauth", () => ({ JUMIA_API_BASE: "https://vendor-api.jumia.com" }));
jest.mock("@/lib/jumia/api", () => ({
  COUNTRY_CURRENCY: { GH: "GHS", NG: "NGN" },
  getValidJumiaCredentials: async () => ({ accessToken: "tok", shopId: "shop-1", currency: "GHS", country: "GH" }),
  getFeedStatus: async () => null,
}));
jest.mock("@/lib/jumia/credentials", () => ({ getJumiaConnectionKind: async () => "connected" }));
jest.mock("@/lib/whatsapp/jumia-connect", () => ({ promptJumiaConnection: jest.fn() }));
jest.mock("@/lib/billing/features", () => ({
  hasFeature: async () => true,
  featureAccess: async () => ({ ok: true }),
  featureMinPackName: () => "Pro",
}));
let rewritten = "{}";
const aiPrompts: string[] = [];
// Each AI call's photos and whether it searched the web.
const aiCalls: { images: number; search: boolean }[] = [];
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (_model: string, parts: { text?: string; inlineData?: unknown }[], opts?: { groundWithSearch?: boolean }) => {
    aiPrompts.push(parts.map((p) => p.text ?? "").join("\n"));
    aiCalls.push({ images: parts.filter((p) => p.inlineData).length, search: opts?.groundWithSearch === true });
    return { text: rewritten };
  },
}));

type Sent = { kind: string; body: string; ids?: string[] };
const sent: Sent[] = [];
const richSent: { blocks: unknown[] }[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  LIST_MAX_ROWS: 10,
  sendTextIfConfigured: async (_to: string, body: string) => { sent.push({ kind: "text", body }); },
  // An answer laid out for the page (lib/whatsapp/rich.ts): its text, as sent.
  sendRichIfConfigured: async (_to: string, body: string, rich: { blocks: unknown[] }) => { sent.push({ kind: "text", body }); richSent.push(rich); },
  sendButtonsIfConfigured: async (_to: string, body: string, b: { id: string }[]) => { sent.push({ kind: "buttons", body, ids: b.map((x) => x.id) }); },
  sendListIfConfigured: async (_to: string, body: string) => { sent.push({ kind: "list", body }); },
  sendImagesIfConfigured: async (_to: string, links: string[], caption?: string) => { sent.push({ kind: "images", body: caption ?? "", ids: links }); },
  sendCtaUrlIfConfigured: async (_to: string, body: string) => { sent.push({ kind: "cta", body }); },
  sendButtonsWithDocumentIfConfigured: async () => {},
  sendTemplateIfConfigured: async () => {},
}));

import { changedPrice, contentItems, findProducts, pctPrice, productsFromCatalog, saveProducts, type ShopProduct } from "@/lib/jumia/shop";
import { answerProductPhotos, productDetailsLookup, productFactsText, whereLine } from "@/lib/whatsapp/shop";
import { answerProductText, answerProducts, answerStock, bulkTargets, handleShopTap, htmlToText, proposeAddSize, proposeBulkChange, proposeContentChange } from "@/lib/whatsapp/shop";
import { runApiChecks } from "@/lib/jumia/api-checks";
import { answerLiveValue } from "@/lib/whatsapp/assistant";
import { answerQcLive, fixRejected, keptQc, markQcAsked } from "@/lib/whatsapp/fix-rejected";
import { resetSession, updateSession } from "@/lib/whatsapp/session";
import type { QcLiveAsk } from "@/lib/whatsapp/session";
import {
  answerBrand, answerLinkedShops, answerPayoutDetail, answerReport, answerWarehouseStock, daysLeft, handleWarehouseTap, proposeWarehouseOrder,
  proposeWarehouseShipped, salesByProduct, statementLines,
} from "@/lib/whatsapp/shop-insights";
import { _resetPriceMinimumCache } from "@/lib/jumia/price-minimums";
import { _resetBillingModeCache } from "@/lib/billing/mode";

const USER = "seller";
const PHONE = "web:seller";
const PERFUME_50 = "aaaaaaaa-0000-4000-8000-000000000001";
const PERFUME_100 = "aaaaaaaa-0000-4000-8000-000000000002";
const KETTLE = "bbbbbbbb-0000-4000-8000-000000000001";
const BOOT = "cccccccc-0000-4000-8000-000000000001";

/** A product set as GET /catalog/products returns it: the whole product, as an update needs it. */
const set = (id: string, name: string, variations: { id: string; sku: string; variation?: string; status?: string; price?: number; jumiaSku?: string }[]) => ({
  id: `set-${id}`, name, description: `<p>${name}, the original description.</p>`, parentSku: `${id}-PARENT`,
  brand: { code: 1001, name: "Lattafa" }, category: { code: 1000844, name: "Eau de Parfum" }, createdAt: "2026-06-01T10:00:00Z",
  images: [{ url: `https://img/${id}-1.jpg`, primary: true }, { url: `https://img/${id}-2.jpg`, primary: false }],
  attributes: [{ id: "x1", name: "short_description", value: "<ul><li>Old point</li></ul>" }, { id: "x2", name: "color", value: "Brown" }],
  variations: variations.map((v) => ({
    id: v.id, sellerSku: v.sku, variation: v.variation ?? "...", barcodeEan: null,
    attributes: [{ id: "y1", name: "volume", value: v.variation ?? "" }],
    globalPrice: { currency: "USD", value: 9 },
    businessClients: [{ code: "jumia-gh", sku: v.jumiaSku ?? `JM-${v.sku}`, status: v.status ?? "ACTIVE", visible: true, qc: { status: "APPROVED" },
      price: { localValue: v.price ?? 100, localCurrency: "GHS", salePrice: null } }],
  })),
});

let catalog: unknown[] = [];
let stock: Record<string, number> = {};
let orders: Record<string, unknown>[] = [];
let orderItems: Record<string, Record<string, unknown>[]> = {};
let statements: Record<string, unknown>[] = [];
const calls: { method: string; path: string; query: URLSearchParams; body?: Record<string, unknown> }[] = [];

beforeEach(() => {
  db = new FakeDb();
  sent.length = 0;
  calls.length = 0;
  rewritten = "{}";
  aiPrompts.length = 0;
  aiCalls.length = 0;
  _resetPriceMinimumCache();
  _resetBillingModeCache();
  catalog = [
    set("p", "Lattafa Eau de Parfum", [{ id: PERFUME_50, sku: "LAT-50", variation: "50ml", price: 150 }, { id: PERFUME_100, sku: "LAT-100", variation: "100ml", price: 240 }]),
    set("k", "Nasco Electric Kettle 1.7L", [{ id: KETTLE, sku: "NAS-K", price: 99.5 }]),
    set("b", "Wellington Rain Boot", [{ id: BOOT, sku: "WEL-B", status: "INACTIVE", price: 80 }]),
  ];
  stock = { [PERFUME_50]: 0, [PERFUME_100]: 4, [KETTLE]: 3, [BOOT]: 10 };
  orders = [];
  orderItems = {};
  statements = [];
  global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    // A product's photo (https://img/…): a PNG's first bytes.
    if (url.hostname === "img") return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), { status: 200 });
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: url.pathname, query: url.searchParams, body });
    let out: unknown = {};
    if (url.pathname === "/catalog/products") {
      const sku = url.searchParams.get("sellerSku");
      out = { products: sku ? catalog.filter((s) => (s as { variations: { sellerSku: string }[] }).variations.some((v) => v.sellerSku === sku)) : catalog, isLastPage: true };
    } else if (url.pathname === "/catalog/stock") {
      out = { products: Object.entries(stock).map(([id, n]) => ({ id, globalStock: n })), isLastPage: true };
    } else if (url.pathname.startsWith("/feeds/products/")) out = { feedId: "feed-1" };
    else if (url.pathname === "/orders") out = { orders, nextToken: null, isLastPage: true };
    else if (url.pathname === "/orders/items") out = url.searchParams.getAll("orderId").map((id) => ({ orderId: id, items: orderItems[id] ?? [] }));
    else if (url.pathname === "/payout-statement") out = { statements };
    else if (url.pathname === "/shops-of-master-shop") out = [
      { id: "shop-1", name: "GEM MALL", businessClients: [{ code: "jumia-gh", countryCode: "GH", status: "ACTIVE" }] },
      { id: "shop-2", name: "GEM MALL NG", businessClients: [{ code: "jumia-ng", countryCode: "NG", status: "INACTIVE" }] },
    ];
    else if (url.pathname === "/consignment-stock") out = { simpleSku: url.searchParams.get("sku"), received: 40, quarantined: 2, defective: 1, canceled: 0, returned: 0, failed: 0 };
    else if (url.pathname === "/consignment-order") out = { purchaseOrderNumber: "PO-7781" };
    return new Response(JSON.stringify(out), { status: method === "POST" && url.pathname === "/consignment-order" ? 201 : 200 });
  }) as unknown as typeof fetch;
});

const writes = () => calls.filter((c) => c.method !== "GET");
const last = () => sent[sent.length - 1];
const products = (): ShopProduct[] => productsFromCatalog({ products: catalog }, "GH").map((p) => ({ ...p, stock: stock[p.sid] ?? null }));

describe("prices by a percentage", () => {
  it("whole prices stay whole, others to the cent", () => {
    expect(pctPrice(150, 10)).toBe(165);
    expect(pctPrice(99.5, -10)).toBe(89.55);
    expect(changedPrice({ price: 200 }, { kind: "sale_pct", pct: 10, start: "2026-10-10", end: "2026-10-11" })).toBe(180);
    expect(changedPrice({ price: 200 }, { kind: "status", active: true })).toBeNull();
  });
});

describe("rules for many products", () => {
  it("picks by scope and leaves out what wouldn't change", () => {
    const all = products();
    expect(bulkTargets(all, "out_of_stock", null, { kind: "status", active: false }, null).targets.map((p) => p.sellerSku)).toEqual(["LAT-50"]);
    // Out of stock means what the stock list shows: on, with none left (owner, 2026-10-08: the list said 5, the rule changed 12).
    const offAndEmpty = [...all, { ...all[0], sid: "off-empty", sellerSku: "OFF-0", status: "INACTIVE", stock: 0 }];
    expect(bulkTargets(offAndEmpty, "out_of_stock", null, { kind: "stock", stock: 10 }, null).targets.map((p) => p.sellerSku)).not.toContain("OFF-0");
    const off = bulkTargets(all, "all", null, { kind: "status", active: false }, null);
    expect(off.targets.map((p) => p.sellerSku)).toEqual(["LAT-50", "LAT-100", "NAS-K"]);
    expect(off.skipped).toEqual([{ reason: "already off", count: 1 }]);
    expect(bulkTargets(all, "matching", "parfum", { kind: "price_pct", pct: 5 }, null).targets.map((p) => p.sellerSku)).toEqual(["LAT-50", "LAT-100"]);
    // "Those", "the last 10" (owner's web chat, 2026-10-08): only the products just listed.
    expect(bulkTargets(all, "listed", null, { kind: "stock", stock: 20 }, null, [PERFUME_50, KETTLE]).targets.map((p) => p.sellerSku)).toEqual(["LAT-50", "NAS-K"]);
    expect(bulkTargets(all, "listed", null, { kind: "stock", stock: 20 }, null).targets).toEqual([]);
    // "The approved ones" of those just listed (test runs of 11 Oct): Jumia's quality check, ON or OFF.
    const withRejected = [...all, { ...all[3], sid: "rej", sellerSku: "REJ", qcStatus: "REJECTED", status: "INACTIVE" }];
    const listed = [PERFUME_50, KETTLE, BOOT, "rej"];
    const pick = (only: "approved" | "on" | "off") => bulkTargets(withRejected, "listed", null, { kind: "stock", stock: 12 }, null, listed, only);
    expect(pick("approved").targets.map((p) => p.sellerSku)).toEqual(["LAT-50", "NAS-K", "WEL-B"]);
    expect(pick("approved").skipped).toEqual([]);
    expect(pick("on").targets.map((p) => p.sellerSku)).toEqual(["LAT-50", "NAS-K"]);
    // OFF: the boot, and the rejected one (OFF, and on Jumia in their country).
    expect(pick("off").targets.map((p) => p.sellerSku)).toEqual(["WEL-B", "REJ"]);
    // Below Jumia's lowest price: left out, said.
    const cut = bulkTargets(all, "all", null, { kind: "price_pct", pct: -50 }, 70);
    expect(cut.targets.map((p) => p.sellerSku)).toEqual(["LAT-50", "LAT-100"]);
    expect(cut.skipped).toEqual([{ reason: "would go below Jumia's lowest price", count: 2 }]);
  });

  it("is said in full, and one tap sends one feed with each product's own new price", async () => {
    expect(await proposeBulkChange(USER, PHONE, "matching", "lattafa parfum", { kind: "sale_pct", pct: 10, start: "2026-10-10", end: "2026-10-11" }))
      .toBe("offered bulk sale_pct for 2 (matching: lattafa parfum)");
    const offer = last();
    expect(offer.body).toContain("Change these 2 products on Jumia?");
    expect(offer.body).toContain("GHS 135 (10% off) from 2026-10-10 to 2026-10-11");
    expect(offer.body).toContain("GHS 216 (10% off)");
    expect(writes()).toHaveLength(0);

    await handleShopTap(USER, PHONE, offer.ids![0]);
    const feeds = writes().filter((c) => c.path === "/feeds/products/price");
    expect(feeds).toHaveLength(1);
    const items = (feeds[0].body as { products: { sellerSku: string; price: { value: number; salePrice: { value: number; startAt: string } } }[] }).products;
    expect(items.map((i) => [i.sellerSku, i.price.value, i.price.salePrice.value, i.price.salePrice.startAt])).toEqual([
      ["LAT-50", 150, 135, "2026-10-10 00:00"], ["LAT-100", 240, 216, "2026-10-10 00:00"],
    ]);
    expect(last().body).toContain("✅ Sent to Jumia for 2 products");
  });

  it("more than one tap's worth comes in parts, one tap each (owner's web chat, 2026-10-08: \"you may do it in batches\")", async () => {
    const id = (i: number) => `dddddddd-0000-4000-8000-${String(i).padStart(12, "0")}`;
    catalog = Array.from({ length: 250 }, (_, i) => set(`x${i}`, `Kettle number ${i + 1}`, [{ id: id(i), sku: `K-${i + 1}`, price: 100 }]));
    stock = Object.fromEntries(catalog.map((_, i) => [id(i), 5]));
    expect(await proposeBulkChange(USER, PHONE, "all", null, { kind: "stock", stock: 0 })).toBe("offered bulk stock for 250 in 2 parts (all)");
    const offers = sent.filter((m) => m.kind === "buttons");
    expect(sent.find((m) => m.kind === "text")!.body).toContain("That's 250 products, more than 200 for one tap, so it comes in 2 parts.");
    expect(offers.map((o) => o.body.split("\n")[0])).toEqual(["*Part 1 of 2*", "*Part 2 of 2*"]);
    expect(offers[0].body).toContain("Change these 200 products on Jumia?");
    expect(offers[1].body).toContain("Change these 50 products on Jumia?");
    expect(writes()).toHaveLength(0);
    // Each part is its own tap.
    await handleShopTap(USER, PHONE, offers[1].ids![0]);
    const feeds = writes().filter((c) => c.path === "/feeds/products/stock");
    expect(feeds).toHaveLength(1);
    expect((feeds[0].body as { products: unknown[] }).products).toHaveLength(50);
  });

  it("nothing to change is said, not offered", async () => {
    stock[PERFUME_50] = 5;
    expect(await proposeBulkChange(USER, PHONE, "out_of_stock", null, { kind: "status", active: false })).toBe("bulk none: out_of_stock");
    expect(last().body).toContain("Nothing to change");
  });

  // Owner, 2026-10-11: "let's add a 15inc variation" to the 17-inch dartboard, whose one size has no name ("...").
  it("a new size beside one with no name: the one it has is named first", async () => {
    expect(await proposeAddSize(USER, PHONE, "kettle", { size: "2.2L", stock: 5, price: 120 })).toBe("add size: name the current one first");
    expect(last().body).toContain('has one size, with no name on Jumia ("..."), so 2.2L can\'t be added beside it yet.');
    expect(last().body).toContain("current size is");
    expect(writes()).toHaveLength(0);
  });

  // Owner, 2026-10-11: "when users request an addition of a variant to a live or draft without price request for it".
  it("a new size with no price: asked, the others' price one tap away; with no stock, the stock first", async () => {
    db.tables.whatsapp_sessions = [{ phone_number: PHONE, user_id: USER, state: "idle", assistant_pending: null }];
    // Sizes at different prices: those are said, no one-tap price.
    expect(await proposeAddSize(USER, PHONE, "Eau de Parfum", { size: "200ml", stock: 3, price: null })).toBe("add size: asked price");
    expect(last()).toMatchObject({ kind: "text" });
    expect(last().body).toBe("What should *200ml* of *Lattafa Eau de Parfum* sell for? Send its price (its other sizes are GHS 150, GHS 240).");
    // One price between them: "Same price" is a tap.
    catalog[0] = set("p", "Lattafa Eau de Parfum", [{ id: PERFUME_50, sku: "LAT-50", variation: "50ml", price: 150 }, { id: PERFUME_100, sku: "LAT-100", variation: "100ml", price: 150 }]);
    db.tables.jumia_products = [];
    db.tables.jumia_catalog_syncs = [];
    expect(await proposeAddSize(USER, PHONE, "Eau de Parfum", { size: "200ml", stock: 3, price: null })).toBe("add size: asked price");
    expect(last()).toMatchObject({ kind: "buttons", ids: ["lval:same"] });
    expect(last().body).toBe("What should *200ml* of *Lattafa Eau de Parfum* sell for? Send its price, or tap *Same price* for GHS 150 like the others.");
    expect(db.tables.whatsapp_sessions[0].assistant_pending).toMatchObject({ kind: "live_value", field: "price", products: ["LAT-100"], addSize: { size: "200ml", stock: 3, price: null, same: 150 } });
    expect(writes()).toHaveLength(0);

    // The tap: offered at the others' price, for the usual confirm tap.
    const session = { ...db.tables.whatsapp_sessions[0], assistantPending: db.tables.whatsapp_sessions[0].assistant_pending } as never;
    expect(await answerLiveValue(USER, PHONE, session, "lval:same")).toBe(true);
    expect(last()).toMatchObject({ kind: "buttons" });
    expect(last().body).toContain("Add *200ml* to *Lattafa Eau de Parfum* on Jumia: 3 in stock at GHS 150?");
    expect(writes()).toHaveLength(0);

    expect(await proposeAddSize(USER, PHONE, "Eau de Parfum", { size: "200ml", stock: null, price: null })).toBe("add size: asked stock");
    expect(last().body).toBe("How many *200ml* of *Lattafa Eau de Parfum* do you have? Send the number.");
    const asked = { ...db.tables.whatsapp_sessions[0], assistantPending: db.tables.whatsapp_sessions[0].assistant_pending } as never;
    // Their number is the stock; the price is asked next.
    expect(await answerLiveValue(USER, PHONE, asked, "4")).toBe(true);
    expect(last().body).toContain("What should *200ml* of *Lattafa Eau de Parfum* sell for?");
    const priced = { ...db.tables.whatsapp_sessions[0], assistantPending: db.tables.whatsapp_sessions[0].assistant_pending } as never;
    expect(await answerLiveValue(USER, PHONE, priced, "GHS 260")).toBe(true);
    expect(last().body).toContain("4 in stock at GHS 260?");
  });

  it("only some of the products just listed: the approved ones, or the ones ON or OFF", async () => {
    expect(await proposeBulkChange(USER, PHONE, "listed", null, { kind: "stock", stock: 12 }, [PERFUME_50, KETTLE, BOOT], "off")).toBe("offered bulk stock for 1 (listed)");
    expect(last().body).toContain("Wellington Rain Boot");
    expect(last().body).not.toContain("Kettle");
    expect(await proposeBulkChange(USER, PHONE, "listed", null, { kind: "stock", stock: 12 }, [BOOT], "on")).toBe("bulk none: listed");
    expect(last().body).toBe("Nothing to change: I found no products I just listed that are ON.");
  });
});

describe("a live product's content", () => {
  it("the new name is shown, and the tap sends the whole product with only the name changed", async () => {
    expect(await proposeContentChange(USER, PHONE, "kettle", { name: "Nasco 1.7L Cordless Electric Kettle - Silver" })).toBe("offered content (name) for NAS-K");
    expect(last().body).toContain('Update *Nasco Electric Kettle 1.7L* (SKU NAS-K) on Jumia: name → "Nasco 1.7L Cordless Electric Kettle - Silver"?');
    await handleShopTap(USER, PHONE, last().ids![0]);
    const feed = writes().find((c) => c.path === "/feeds/products/update")!;
    const item = (feed.body as { products: Record<string, unknown>[] }).products[0];
    expect(item).toMatchObject({
      id: KETTLE, sellerSku: "NAS-K", parentSku: "k-PARENT",
      name: { value: "Nasco 1.7L Cordless Electric Kettle - Silver" },
      description: { value: "<p>Nasco Electric Kettle 1.7L, the original description.</p>" },
      brand: { code: 1001, name: "Lattafa" }, category: { code: 1000844, name: "Eau de Parfum" },
      images: [{ url: "https://img/k-1.jpg", primary: true }, { url: "https://img/k-2.jpg", primary: false }],
    });
    expect(item).not.toHaveProperty("price");
    expect(item).not.toHaveProperty("stock");
  });

  it("every size of a product goes in the update, with new highlights in short_description", async () => {
    const r = await contentItems("tok", products().filter((p) => p.sellerSku === "LAT-50"), { highlights: "<ul><li>New</li></ul>" });
    expect(r.ok && r.data.map((i) => i.sellerSku)).toEqual(["LAT-50", "LAT-100"]);
    const attrs = r.ok ? (r.data[0].attributes as { name: string; value: string }[]) : [];
    expect(attrs.find((a) => a.name === "short_description")!.value).toBe("<ul><li>New</li></ul>");
    expect(attrs.find((a) => a.name === "volume")!.value).toBe("50ml");
  });

  it("a rewrite is written from what Jumia has now and shown before the tap", async () => {
    rewritten = '{"description":"<p>A sturdy rain boot.</p><ul><li>Waterproof</li></ul>"}';
    expect(await proposeContentChange(USER, PHONE, "wellington boot", { rewrite: ["description"], instructions: "rewrite it" })).toBe("offered content (description) for WEL-B");
    // Shown in full first, in WhatsApp's formatting, then the tap (owner, 2026-10-12: it read as plain text).
    expect(sent.at(-2)!.body).toBe("*New description:*\nA sturdy rain boot.\n\n• Waterproof");
    expect(last().body).toContain("The new description is above.");
    expect(last().body).toContain("Tap Yes to send it to Jumia.");
  });

  // Owner, 2026-10-11: "have a look at the pictures of it and rewrite the description yourself"; "does not follow the standard we have when drafting from scratch".
  it("a rewrite is written as a new listing is drafted: from its photos, with web search, to the same standard", async () => {
    rewritten = '{"description":"<p>A sturdy rain boot.</p>"}';
    await proposeContentChange(USER, PHONE, "wellington boot", { rewrite: ["description"], instructions: 'Description: "rewrite the description yourself"' });
    expect(aiCalls).toEqual([{ images: 2, search: true }]);
    const prompt = aiPrompts[0];
    expect(prompt).toContain("Its 2 photos are attached (the main one first).");
    expect(prompt).toContain("MINIMUM LENGTH: at least 1500 characters");
    expect(prompt).toContain("WEB SEARCH:");
    expect(prompt).toContain('What the seller asked for: Description: "rewrite the description yourself"');
    expect(prompt).toContain("a short or thin text now is no limit on the new one");
  });

  it("a rejected product is fixed the way the seller says, when Jumia sent no reason (owner, 2026-10-11)", async () => {
    const boot = catalog[2] as { variations: { businessClients: { qc: Record<string, unknown> }[] }[] };
    boot.variations[0].businessClients[0].qc = { status: "REJECTED" };
    rewritten = '{"description":"<p>A tall rubber rain boot for farm and garden.</p>"}';
    expect(await fixRejected(USER, PHONE, "wellington boot", null, "fix the wellington boot, the description is too short, say it's for farm and garden"))
      .toBe("fix: rewrite (offered content (description) for WEL-B)");
    expect(sent.find((m) => m.body.includes("I've rewritten its description to fix it, as you asked"))).toBeTruthy();
    expect(aiPrompts.join("\n")).toContain("say it's for farm and garden");
    expect(sent.at(-2)!.body).toContain("A tall rubber rain boot for farm and garden.");
    // Saying nothing of what to change still asks for Jumia's reason.
    expect(await fixRejected(USER, PHONE, "wellington boot", null, "fix the wellington boot")).toBe("fix: ask_details");
    expect(writes()).toHaveLength(0);
  });

  it("a brand Jumia doesn't have isn't sent; one it has is, with its code", async () => {
    db.tables.jumia_brands = [{ code: 2002, name: "Nasco" }];
    expect(await proposeContentChange(USER, PHONE, "kettle", { brand: "Nascoo" })).toBe("brand unknown");
    expect(last().body).toContain("isn't a brand on Jumia");
    expect(await proposeContentChange(USER, PHONE, "kettle", { brand: "nasco" })).toBe("offered content (brand) for NAS-K");
    expect(last().body).toContain("brand → Nasco");
  });

  // Owner's chat, 10 Oct: "show me the pictures for that product here" got its text.
  it("its photos are shown, the main one first, whatever its status", async () => {
    expect(await answerProductPhotos(USER, PHONE, "wellington boot")).toBe("photos of WEL-B (2)");
    expect(last()).toEqual({ kind: "images", body: expect.stringContaining("*Wellington Rain Boot* (SKU WEL-B): 2 photos, the main one first."), ids: ["https://img/b-1.jpg", "https://img/b-2.jpg"] });
    expect(last().body).toContain("OFF · approved");
    expect(writes()).toHaveLength(0);
  });

  it("several products that fit are asked as a list to tap, keeping what was asked", async () => {
    catalog.push(set("k2", "Nasco Electric Kettle 2L", [{ id: "bbbbbbbb-0000-4000-8000-000000000002", sku: "NAS-K2", price: 120 }]));
    const asked: string[][] = [];
    const which = async (sets: ShopProduct[]) => { asked.push(sets.map((s) => s.sellerSku)); return `asked which of ${sets.length}`; };
    expect(await answerProductPhotos(USER, PHONE, "nasco kettle", which)).toBe("asked which of 2");
    expect(await proposeContentChange(USER, PHONE, "nasco kettle", { rewrite: ["description"] }, which)).toBe("asked which of 2");
    expect(asked).toEqual([["NAS-K", "NAS-K2"], ["NAS-K", "NAS-K2"]]);
    // By its SKU, as typed: just that one.
    expect(findProducts(products(), "SKU NAS-K2").map((p) => p.sellerSku)).toEqual(["NAS-K2"]);
  });

  it("everything Jumia has on one product, for the agent to answer any question about it", async () => {
    const kettle = products().filter((p) => p.sellerSku === "NAS-K");
    expect(whereLine(kettle[0])).toBe("ON · approved · price GHS 99.5 · stock 3");
    await saveProducts(USER, products());
    const [facts] = await productDetailsLookup(USER)("kettle");
    expect(facts).toContain("Name: Nasco Electric Kettle 1.7L");
    expect(facts).toContain("Brand: Lattafa · Category: Eau de Parfum");
    expect(facts).toContain("SKU NAS-K · ON · approved · price GHS 99.5");
    expect(facts).toContain("Photos: 2 (the main one first)");
    expect(facts).toContain("Highlights: • Old point");
    expect(facts).toContain("Details: color=Brown");
    // Several fit: their names, to ask which.
    const several = await productDetailsLookup(USER)("lattafa");
    expect(several[0]).toContain("These 3 products fit");
    expect(several.join("\n")).toContain("- Lattafa Eau de Parfum (SKU LAT-100)\n- Nasco Electric Kettle 1.7L (SKU NAS-K)\n- Wellington Rain Boot (SKU WEL-B)");
    expect(await productDetailsLookup(USER)("nothing like it")).toEqual([]);
    expect(productFactsText).toBeInstanceOf(Function);
  });

  it("its text is shown as Jumia has it, to read or edit (owner's web chat, 2026-10-08: the AI wrote one itself)", async () => {
    expect(await answerProductText(USER, PHONE, "kettle")).toBe("text of NAS-K");
    expect(last().body).toContain("*Nasco Electric Kettle 1.7L* (SKU NAS-K)\n\n*Description:*\nNasco Electric Kettle 1.7L, the original description.");
    expect(last().body).toContain("*Highlights:*\n• Old point");
    expect(writes()).toHaveLength(0);
  });

  it("its other details, checked against its category, go in the update with the rest unchanged (owner, 2026-10-09)", async () => {
    db.tables.jumia_category_attributes = [
      { category_code: 1000844, name: "color", label: "Color", type: "enum", allowed_values: ["Brown", "Black", "Gold"], required: false, is_variant: false, sort_order: 1 },
      { category_code: 1000844, name: "main_material", label: "Main Material", type: "string", allowed_values: [], required: false, is_variant: false, sort_order: 2 },
    ];
    expect(await proposeContentChange(USER, PHONE, "kettle", { details: { colour: "purple" } })).toBe("details refused");
    expect(last().body).toContain("It takes: Brown, Black, Gold");
    expect(await proposeContentChange(USER, PHONE, "kettle", { details: { colour: "black", material: "steel" } })).toBe("offered content (attributes) for NAS-K");
    // The kettle is approved, and Jumia locks its colour then (owner, 2026-10-09: the neck fan's
    // "The [color] cannot be updated since the product has been already approved"): said first,
    // the rest offered.
    expect(sent[sent.length - 2].body).toContain("Jumia doesn't let a product's colour change once its quality check has approved it. To sell one in Black");
    expect(last().body).toContain("main material → steel");
    expect(last().body).not.toContain("color →");
    await handleShopTap(USER, PHONE, last().ids![0]);
    const item = (writes().find((c) => c.path === "/feeds/products/update")!.body as { products: Record<string, unknown>[] }).products[0];
    expect(item.attributes).toEqual(expect.arrayContaining([
      { name: "main_material", value: "steel" }, { name: "short_description", value: "<ul><li>Old point</li></ul>" },
    ]));
    expect(item.attributes).not.toContainEqual({ name: "color", value: "Black" });
    // Colour alone on an approved product: nothing offered.
    expect(await proposeContentChange(USER, PHONE, "kettle", { details: { colour: "gold" } })).toBe("details locked");
    expect(last().body).toContain("is approved on Jumia, so I haven't offered that.");
    expect(item.name).toEqual({ value: "Nasco Electric Kettle 1.7L" });
  });

  it("a size's new name and a barcode go on that variation only", async () => {
    db.tables.jumia_category_attributes = [
      { category_code: 1000844, name: "volume", label: "Volume", type: "enum", allowed_values: ["50ml", "100ml", "200ml"], required: false, is_variant: true, sort_order: 1 },
    ];
    expect(await proposeContentChange(USER, PHONE, "eau de parfum", { size: { from: "50ml", to: "200ml" } })).toMatch(/^offered content \(variations\) for LAT-/);
    await handleShopTap(USER, PHONE, last().ids![0]);
    const items = (writes().find((c) => c.path === "/feeds/products/update")!.body as { products: { sellerSku: string; variation?: string }[] }).products;
    expect(items.map((i) => [i.sellerSku, i.variation])).toEqual([["LAT-50", "200ml"], ["LAT-100", "100ml"]]);
  });

  it("descriptions are shown as plain lines", () => {
    expect(htmlToText("<p>One &amp; two</p><ul><li>A</li><li>B</li></ul>")).toBe("One & two\n• A\n• B");
  });
});

describe("stock held by orders not shipped yet (owner, 2026-10-09)", () => {
  it("is said next to a product's stock", async () => {
    orders = [{ id: "o9", number: "9", createdAt: "2026-10-08 10:00:00" }];
    orderItems = { o9: [
      { id: "i1", status: "PENDING", product: { sellerSku: "NAS-K", name: "Nasco Electric Kettle 1.7L" } },
      { id: "i2", status: "READY_TO_SHIP", product: { sellerSku: "NAS-K", name: "Nasco Electric Kettle 1.7L" } },
      { id: "i3", status: "DELIVERED", product: { sellerSku: "NAS-K", name: "Nasco Electric Kettle 1.7L" } },
    ] };
    await answerStock(USER, PHONE, "kettle", null);
    expect(last().body).toContain("(2 in orders not shipped yet)");
    const asked = calls.find((c) => c.path === "/orders")!;
    expect(asked.query.get("status")).toBe("PENDING,READY_TO_SHIP");
  });
});

describe("the daily checks of every read request", () => {
  it("each read once, in order, nothing written; a failure is kept with Jumia's answer", async () => {
    db.tables.jumia_categories = [{ code: 1000844, name: "Eau de Parfum", path: "Beauty > Eau de Parfum", attribute_set_sid: "as-1" }];
    orders = [{ id: "o1", number: "1", createdAt: "2026-10-08 10:00:00" }];
    orderItems = { o1: [{ id: "i1", status: "PENDING", product: { sellerSku: "NAS-K" } }] };
    const r = await runApiChecks("tok", "GH", { feedId: "feed-1", paceMs: 0 });
    expect(r.map((x) => [x.check, x.ok, x.skipped])).toEqual([
      ["shops", true, false], ["linked_shops", true, false], ["brands", true, false], ["categories", true, false], ["products", true, false],
      ["product_set", true, false], ["stock", true, false], ["attribute_set", true, false], ["feed", true, false], ["orders", true, false],
      ["order_items", true, false], ["shipment_providers", true, false], ["payouts", true, false],
    ]);
    expect(writes()).toHaveLength(0);

    const realFetch = global.fetch;
    global.fetch = jest.fn(async (input: URL | string, init?: RequestInit) =>
      new URL(String(input)).pathname === "/payout-statement" ? new Response('{"message":"Forbidden"}', { status: 403 }) : realFetch(input, init)) as unknown as typeof fetch;
    orders = [];
    const again = await runApiChecks("tok", "GH", { paceMs: 0 });
    expect(again.find((x) => x.check === "payouts")).toMatchObject({ ok: false, detail: expect.stringContaining("403") });
    expect(again.find((x) => x.check === "feed")).toMatchObject({ ok: true, skipped: true });
    expect(again.find((x) => x.check === "order_items")).toMatchObject({ skipped: true });
  });
});

describe("reports from their orders", () => {
  const item = (sku: string, name: string, status: string, paid = 100) => ({ id: `${sku}-${Math.random()}`, status, paidPriceLocal: paid, country: { currencyCode: "GHS" }, product: { sellerSku: sku, name } });

  it("sales by product: sold, returned, failed and cancelled apart", () => {
    const s = salesByProduct([item("A", "a", "DELIVERED"), item("A", "a", "returned"), item("A", "a", "Failed Delivery"), item("A", "a", "CANCELED"), item("A", "a", "SHIPPED", 50)] as never);
    expect(s.get("A")).toMatchObject({ sold: 2, revenue: 150, returned: 1, failed: 1, cancelled: 1 });
    expect(daysLeft(10, 30, 30)).toBe(10);
    expect(daysLeft(10, 0, 30)).toBeNull();
  });

  beforeEach(() => {
    orders = [{ id: "o1", number: "1", createdAt: "2026-10-01 10:00:00" }, { id: "o2", number: "2", createdAt: "2026-10-02 10:00:00" }];
    orderItems = {
      o1: [item("NAS-K", "Nasco Electric Kettle 1.7L", "DELIVERED"), item("NAS-K", "Nasco Electric Kettle 1.7L", "DELIVERED"), item("LAT-100", "Lattafa Eau de Parfum", "RETURNED", 240)],
      o2: [item("NAS-K", "Nasco Electric Kettle 1.7L", "SHIPPED"), item("LAT-100", "Lattafa Eau de Parfum", "DELIVERED", 240)],
    };
  });

  it("best sellers", async () => {
    await answerReport(USER, PHONE, "best_sellers", "month");
    expect(last().body).toContain("🏆 Your best sellers in the last 30 days");
    expect(last().body).toContain("1. Nasco Electric Kettle 1.7L: 3 sold · GHS 300");
    expect(last().body).toContain("2. Lattafa Eau de Parfum: 1 sold · GHS 240");
  });

  it("restock: what runs out within two weeks at the rate it sold", async () => {
    await answerReport(USER, PHONE, "restock", "month");
    // Kettle: 3 left, 3 sold in 30 days → about 30 days, not listed. Perfume 100ml: 4 left, 1 sold → not soon.
    expect(last().body).toContain("Nothing runs out in the next 2 weeks");
    stock[KETTLE] = 1;
    orderItems.o2.push(...Array.from({ length: 20 }, () => item("NAS-K", "Nasco Electric Kettle 1.7L", "DELIVERED")));
    db = new FakeDb();
    await answerReport(USER, PHONE, "restock", "month");
    expect(last().body).toContain("• Nasco Electric Kettle 1.7L: 1 left, about 1 day · sold 23");
  });

  it("products with no sale, and returns", async () => {
    await answerReport(USER, PHONE, "slow_movers", "month");
    expect(last().body).toBe("✅ Every product that's on sold at least once in the last 30 days.");
    catalog.push(set("x", "Silver Crest Blender 1.5L", [{ id: "dddddddd-0000-4000-8000-000000000001", sku: "SC-BL" }]));
    stock["dddddddd-0000-4000-8000-000000000001"] = 6;
    db = new FakeDb();
    await answerReport(USER, PHONE, "slow_movers", "month");
    // The boot is off and the 50ml is out of stock: neither is listed.
    expect(last().body).toContain("🐢 1 product on Jumia with no sale in the last 30 days, most stock first:\n• Silver Crest Blender 1.5L: 6 in stock");
    expect(last().body).not.toContain("Wellington");
    await answerReport(USER, PHONE, "returns", "month");
    expect(last().body).toContain("↩️ Returns and failed deliveries in the last 30 days: 1 of 5 items (20%)");
    expect(last().body).toContain("• Lattafa Eau de Parfum: 1 returned of 2 (50%)");
  });
});

describe("payouts in detail", () => {
  beforeEach(() => {
    statements = [
      { statementNumber: "GH11-20261005", createdAt: "2026-10-05 03:00:00", updatedAt: null, openingBalance: 0, itemRevenue: 1200, feesTotal: 180, shipmentFee: 40,
        refunds: 100, closingBalance: 920, payout: { amount: 920, currency: "GHS" }, paid: false, paymentReference: null },
      { statementNumber: "GH11-20260928", createdAt: "2026-09-28 03:00:00", updatedAt: "2026-10-01 09:00:00", itemRevenue: 500, feesTotal: 75,
        payout: { amount: 425, currency: "GHS" }, paid: true, paymentReference: "TRX-9" },
    ];
  });

  it("every statement, one line each", async () => {
    await answerPayoutDetail(USER, PHONE, "history", null);
    expect(last().body).toContain("• 2026-10-05 · GH11-20261005 · *GHS 920* · not paid yet");
    expect(last().body).toContain("• 2026-10-01 · GH11-20260928 · *GHS 425* · paid (ref TRX-9)");
  });

  it("one statement line by line, by its number", async () => {
    await answerPayoutDetail(USER, PHONE, "breakdown", "GH11-20260928");
    expect(last().body).toContain("🧾 Statement GH11-20260928 (2026-10-01)");
    expect(last().body).toContain("• Sales: GHS 500");
    expect(last().body).toContain("• All fees: -GHS 75");
    expect(statementLines({ number: "x", createdAt: null, updatedAt: null, paid: false, reference: null, amount: 0, currency: "GHS", openingBalance: 0, itemRevenue: 0, feesTotal: null, refunds: null, closingBalance: null }, String)).toEqual([]);
  });
});

describe("brands, shops and Jumia's warehouse", () => {
  it("a brand on Jumia, or the close ones", async () => {
    db.tables.jumia_brands = [{ code: 1001, name: "Lattafa" }, { code: 1002, name: "Lattafa Pride" }];
    await answerBrand(USER, PHONE, "lattafa", null);
    expect(last().body).toBe("✅ *Lattafa* is a brand on Jumia.");
    await answerBrand(USER, PHONE, "Lattafah", null);
    expect(last().body).toContain('"Lattafah" isn\'t in Jumia\'s brand list. Close ones: Lattafa, Lattafa Pride.');
  });

  it("the shops under the account", async () => {
    await answerLinkedShops(USER, PHONE);
    expect(last().body).toContain("• *GEM MALL*: Ghana");
    expect(last().body).toContain("• *GEM MALL NG*: Nigeria (inactive)");
  });

  it("what the warehouse holds, by Jumia's own SKU", async () => {
    await answerWarehouseStock(USER, PHONE, "kettle");
    expect(calls.find((c) => c.path === "/consignment-stock")!.query.get("sku")).toBe("JM-NAS-K");
    expect(last().body).toContain("• Nasco Electric Kettle 1.7L (SKU NAS-K): 40 received · 2 in quarantine · 1 defective");
  });

  it("a delivery order is made only on the tap, and marking it shipped too", async () => {
    await proposeWarehouseOrder(USER, PHONE, [{ product: "kettle", quantity: 50 }], "2026-10-20");
    expect(last().body).toContain("• Nasco Electric Kettle 1.7L (SKU NAS-K): 50");
    expect(last().body).toContain("Shipping on 2026-10-20.");
    expect(writes()).toHaveLength(0);
    await handleWarehouseTap(USER, PHONE, last().ids![0]);
    expect(writes()[0]).toMatchObject({ method: "POST", path: "/consignment-order",
      body: { shopId: "shop-1", businessClientCode: "jumia-gh", shippingDate: "2026-10-20 09:00:00", products: [{ sku: "JM-NAS-K", quantity: 50 }] } });
    expect(last().body).toContain("Delivery order *PO-7781* created");
    // Tapped again: already done.
    await handleWarehouseTap(USER, PHONE, sent[sent.length - 2].ids![0]);
    expect(last().body).toBe("That was already handled.");

    await proposeWarehouseShipped(USER, PHONE, "PO-7781", "DHL998877", null);
    await handleWarehouseTap(USER, PHONE, last().ids![0]);
    expect(writes()[1]).toMatchObject({ method: "PATCH", path: "/consignment-order/PO-7781", body: { isShipped: true, trackingNumber: "DHL998877" } });
  });

  it("No leaves Jumia alone", async () => {
    await proposeWarehouseOrder(USER, PHONE, [{ product: "kettle", quantity: 5 }], null);
    await handleWarehouseTap(USER, PHONE, last().ids![1]);
    expect(last().body).toBe("OK, nothing sent to Jumia.");
    expect(writes()).toHaveLength(0);
  });
});

// Owner's web chat, 2026-10-12: a weight rejection got its name and
// description rewritten, and "change the brand to pro" got the brand
// question back three times. "Fix what we can, ask for what only the seller
// has, then put it in and send it back."
describe("rejected products, fixed from what Jumia's quality check said", () => {
  const reject = (i: number, reason: string) => {
    const s = catalog[i] as { variations: { businessClients: { qc: Record<string, unknown> }[] }[] };
    s.variations[0].businessClients[0].qc = { status: "REJECTED", rejectionReason: reason };
  };
  const pending = () => db.tables.whatsapp_sessions[0].assistant_pending as QcLiveAsk;
  const attr = (name: string, label: string, type: string, allowed: string[] = []) =>
    ({ category_code: 1000844, name, label, type, allowed_values: allowed, required: false, is_variant: false, sort_order: 1 });
  beforeEach(() => {
    db.tables.whatsapp_sessions = [{ phone_number: PHONE, user_id: USER, state: "idle", assistant_pending: null }];
    db.tables.jumia_category_attributes = [
      attr("product_weight", "Weight (kg)", "string"),
      attr("product_warranty", "Product warranty", "textarea"),
      attr("warranty_duration", "Warranty Duration", "enum", ["1 Year", "6 Months", "2 Years", "None"]),
      attr("warranty_type", "Warranty Type", "multi", ["Repair by Vendor", "Replacement by Vendor"]),
      attr("fda", "FDA", "string"),
    ];
  });
  const updated = () => (writes().find((c) => c.path === "/feeds/products/update")!.body as { products: Record<string, unknown>[] }).products[0];

  it("a weight Jumia doubts: asked, never rewritten; the reply goes in its weight field in kg", async () => {
    reject(2, "Please confirm and update the actual weight of the product, as the current weight information appears to be inaccurate or missing. 150 g should be entered as 0.15 kg");
    expect(await fixRejected(USER, PHONE, "wellington boot")).toBe("fix: ask_value");
    expect(last().body).toContain("What does it weigh, packed as it ships?");
    expect(aiPrompts).toHaveLength(0);
    expect(pending()).toMatchObject({ kind: "qc_live", sku: "WEL-B", ask: "value", about: "weight", field: "product_weight" });
    // A bare big number could be grams or kilos: asked.
    expect(await answerQcLive(USER, PHONE, pending(), "1200")).toBe(true);
    expect(last().body).toContain("Is that 1200 g or 1200 kg?");
    expect(await answerQcLive(USER, PHONE, pending(), "1200 g")).toBe(true);
    expect(last().body).toContain("weight → 1.2");
    await handleShopTap(USER, PHONE, last().ids![0]);
    expect(updated().attributes).toContainEqual({ name: "product_weight", value: "1.2" });
    expect(updated().description).toEqual({ value: "<p>Wellington Rain Boot, the original description.</p>" });
  });

  it("the brand in their own message is put in, not asked again", async () => {
    db.tables.jumia_brands = [{ code: 1001, name: "Lattafa" }];
    reject(2, "Brand 'Generic' is not a recognized brand for a rain boot. Please list this product under a genuine, specific brand name.");
    expect(await fixRejected(USER, PHONE, "wellington boot")).toBe("fix: ask_brand");
    expect(await fixRejected(USER, PHONE, "wellington boot", null, "change the brand to lattafa")).toBe("fix: ask_brand answered (offered content (brand) for WEL-B)");
    expect(last().body).toContain("brand → Lattafa");
    // A brand Jumia doesn't have: said, and the next reply is still the answer.
    expect(await answerQcLive(USER, PHONE, { ...pending(), at: new Date().toISOString() }, "Pro")).toBe(true);
    expect(sent.some((m) => m.body.includes("\"Pro\" isn't a brand on Jumia"))).toBe(true);
    expect(pending()).toMatchObject({ kind: "qc_live", ask: "brand" });
  });

  it("a name Jumia read as a brand is reworded to start with what it is; a brand reply still counts", async () => {
    reject(2, "Kindly use the brand name on the package ... (Brand field 'Fashion' but name starts with: Wellington Rain)");
    rewritten = '{"name":"Rain Boot - Wellington Style, Green Rubber"}';
    expect(await fixRejected(USER, PHONE, "wellington boot")).toBe("fix: rewrite (offered content (name) for WEL-B)");
    expect(aiPrompts[0]).toContain('The new name must NOT begin with "Wellington Rain"');
    expect(last().body).toContain('name → "Rain Boot - Wellington Style, Green Rubber"');
    expect(pending()).toMatchObject({ kind: "qc_live", ask: "brand" });
  });

  it("a brand word in the description is taken out, and nothing else changes", async () => {
    const boot = catalog[2] as { description: string };
    boot.description = "<p>Tough like Nivea boots, made for rain.</p>";
    reject(2, "Restricted Brand: Nivea in DESCRIPTION - Seller not in approved list");
    expect(await fixRejected(USER, PHONE, "wellington boot")).toBe("fix: remove (offered content (description) for WEL-B)");
    expect(aiPrompts).toHaveLength(0);
    await handleShopTap(USER, PHONE, last().ids![0]);
    expect(updated().description).toEqual({ value: "<p>Tough like boots, made for rain.</p>" });
    expect(updated().name).toEqual({ value: "Wellington Rain Boot" });
  });

  it("a warranty: its fields and a line in the description", async () => {
    reject(2, "For listing this type of product requires a valid warranty as per our platform guidelines. Please ensure the warranty details are clearly mentioned in: Product Description tab, Warranty Tab.");
    expect(await fixRejected(USER, PHONE, "wellington boot")).toBe("fix: ask_value");
    expect(pending()).toMatchObject({ about: "warranty", field: "product_warranty" });
    expect(await answerQcLive(USER, PHONE, pending(), "12 months, replacement by vendor")).toBe(true);
    await handleShopTap(USER, PHONE, last().ids![0]);
    expect(updated().attributes).toEqual(expect.arrayContaining([
      { name: "product_warranty", value: "12 months, replacement by vendor" },
      { name: "warranty_duration", value: "1 Year" },
      { name: "warranty_type", value: "Replacement by Vendor" },
    ]));
    expect(updated().description).toEqual({ value: "<p>Wellington Rain Boot, the original description.</p><p><strong>Warranty:</strong> 12 months, replacement by vendor</p>" });
  });

  it("an FDA number goes in its field; a question back lets the question go", async () => {
    reject(2, "Kindly Provide Product's Health/Food Regulation Registration Number. (Mandatory FDA registration number is missing.)");
    expect(await fixRejected(USER, PHONE, "wellington boot")).toBe("fix: ask_value");
    expect(last().body).toContain("No number? Jumia won't approve it until the product is registered.");
    // Learned for drafts in its category (plan step 5).
    expect(db.tables.jumia_qc_required).toEqual([expect.objectContaining({ category_code: 1000844, field: "fda", label: "FDA", kind: "value", seen: 1 })]);
    expect(await answerQcLive(USER, PHONE, pending(), "where do I find it?")).toBe(false);
    db.tables.whatsapp_sessions[0].assistant_pending = { kind: "qc_live", sku: "WEL-B", name: "Wellington Rain Boot", ask: "value", field: "fda", fieldLabel: "FDA", about: null, category: 1000844, at: new Date().toISOString() };
    expect(await answerQcLive(USER, PHONE, pending(), "FDA number is FDA/CS/24-1234")).toBe(true);
    await handleShopTap(USER, PHONE, last().ids![0]);
    expect(updated().attributes).toContainEqual({ name: "fda", value: "FDA/CS/24-1234" });
  });

  // A seller, 2026-10-11: "FDA/SD.255-112170" is the number itself; its "FDA" isn't a lead-in to strip.
  it("an FDA number that starts with FDA keeps it", async () => {
    reject(2, "Kindly Provide Product's Health/Food Regulation Registration Number. (Mandatory FDA registration number is missing.)");
    await fixRejected(USER, PHONE, "wellington boot");
    expect(await answerQcLive(USER, PHONE, pending(), "FDA/SD.255-112170")).toBe(true);
    await handleShopTap(USER, PHONE, last().ids![0]);
    expect(updated().attributes).toContainEqual({ name: "fda", value: "FDA/SD.255-112170" });
  });

  // Owner's web chat, 2026-10-12 17:05–17:11 (docs/plan-2026-10-13-ask-what-jumia-needs.md step 2).
  describe("the question stays open (switch assistant_followup)", () => {
    const WEIGHT_REASON = "Please confirm and update the actual weight of the product, as the current weight information appears to be inaccurate or missing.";
    const botSaid = (body: string) => { db.tables.whatsapp_message_log = [{ phone_number: PHONE, direction: "outbound", message_type: "text", body_text: body }]; };
    beforeEach(() => {
      db.tables.app_settings = [{ key: "assistant_followup", value: "all" }];
      (catalog[2] as { attributes: { name: string; value: string }[] }).attributes.push({ name: "product_weight", value: "0.2" });
      reject(2, WEIGHT_REASON);
    });

    it("the question says what Jumia has now, and keeps Jumia's words", async () => {
      expect(await fixRejected(USER, PHONE, "wellington boot")).toBe("fix: ask_value");
      expect(last().body).toContain("Jumia has 0.2 kg as its weight now and turned that down. What does it weigh, packed as it ships?");
      expect(pending()).toMatchObject({ kind: "qc_live", sku: "WEL-B", keep: true, current: "0.2 kg", jumiaSaid: expect.stringContaining("current weight information appears to be inaccurate") });
    });

    it("17:06 \"That is the weight listed\": not an answer, and the question stays", async () => {
      await fixRejected(USER, PHONE, "wellington boot");
      botSaid(last().body);
      const before = sent.length;
      expect(await answerQcLive(USER, PHONE, pending(), "That is the weight listed")).toBe(false);
      expect(pending()).toMatchObject({ kind: "qc_live", sku: "WEL-B", about: "weight" });
      expect(sent.length).toBe(before);
    });

    it("17:10 \"Update it for me on my JUMIA shop\": what Jumia has now, offered again for the tap", async () => {
      await fixRejected(USER, PHONE, "wellington boot");
      botSaid(last().body);
      expect(await answerQcLive(USER, PHONE, pending(), "That is the weight listed")).toBe(false);
      expect(await answerQcLive(USER, PHONE, pending(), "Update it for me on my JUMIA shop")).toBe(true);
      expect(last().body).toContain("weight → 0.2");
      expect(db.tables.whatsapp_sessions[0].assistant_pending).toBeNull();
      await handleShopTap(USER, PHONE, last().ids![0]);
      expect(updated().attributes).toContainEqual({ name: "product_weight", value: "0.2" });
    });

    it("a new weight right after the question is its answer, in kg", async () => {
      await fixRejected(USER, PHONE, "wellington boot");
      botSaid(last().body);
      expect(await answerQcLive(USER, PHONE, pending(), "0.1")).toBe(true);
      expect(last().body).toContain("weight → 0.1");
      expect(db.tables.whatsapp_sessions[0].assistant_pending).toBeNull();
    });

    it("another request in between is left to the chat, and the question stays; once the chat has moved on, nothing is read as its answer", async () => {
      await fixRejected(USER, PHONE, "wellington boot");
      botSaid(last().body);
      expect(await answerQcLive(USER, PHONE, pending(), "show me today's sales")).toBe(false);
      expect(pending()).toMatchObject({ kind: "qc_live", sku: "WEL-B" });
      // The chat answered something else (reviewing step 2: each of these was
      // taken as the boot's answer while the question stayed open).
      for (const [bot, said] of [
        ["How many products are you listing now?", "5"],
        ["Wellington Rain Boot has 10 in stock on Jumia.", "make it 5"],
        ["Update *Nasco Electric Kettle 1.7L* on Jumia: price → GHS 120? Tap Yes to send it.", "yes"],
        ["Here are today's sales.", "change the weight of the Nasco kettle to 1.5 kg"],
        ["Here are today's sales.", "it weighs 150 g"],
        ["Here are today's sales.", "stop the sale on the Nasco kettle"],
        ["Here are today's sales.", "stop"],
      ]) {
        botSaid(bot);
        expect({ said, read: await answerQcLive(USER, PHONE, pending(), said) }).toEqual({ said, read: false });
      }
      expect(pending()).toMatchObject({ kind: "qc_live", sku: "WEL-B" });
      expect(sent.filter((m) => m.body.includes("Wellington Rain Boot") && m.body.includes("weight →"))).toHaveLength(0);
      // The agent's own question about the weight is the question again: its reply is read.
      await markQcAsked(PHONE, pending(), "Jumia has 0.2 kg for it and turned that down. What does it weigh, packed as it ships?");
      botSaid("Jumia has 0.2 kg for it and turned that down. What does it weigh, packed as it ships?");
      expect(await answerQcLive(USER, PHONE, pending(), "150 g")).toBe(true);
      expect(last().body).toContain("weight → 0.15");
    });

    it("on the question itself: a question back, or chat words, are left to the chat", async () => {
      await fixRejected(USER, PHONE, "wellington boot");
      botSaid(last().body);
      for (const said of ["is that correct?", "Is it right?", "ok?", "ok thanks", "No", "it's wrong"]) {
        expect({ said, read: await answerQcLive(USER, PHONE, pending(), said) }).toEqual({ said, read: false });
      }
      expect(pending()).toMatchObject({ kind: "qc_live", sku: "WEL-B" });
      expect(sent.filter((m) => m.body.includes("weight →"))).toHaveLength(0);
    });

    it("a question the chat asks about something else holds it, and it comes back after", async () => {
      await fixRejected(USER, PHONE, "wellington boot");
      const q = pending();
      await updateSession(PHONE, { assistantPending: { kind: "live_value", field: "stock", products: ["kettle"], preferSid: null, at: new Date().toISOString() } });
      expect(db.tables.whatsapp_sessions[0].assistant_pending).toMatchObject({ kind: "live_value", heldQc: { kind: "qc_live", sku: "WEL-B" } });
      await updateSession(PHONE, { assistantPending: null });
      expect(db.tables.whatsapp_sessions[0].assistant_pending).toEqual(q);
      // Clearing it itself clears it; a restart clears both.
      await updateSession(PHONE, { assistantPending: null });
      expect(db.tables.whatsapp_sessions[0].assistant_pending).toBeNull();
      await updateSession(PHONE, { assistantPending: q });
      await updateSession(PHONE, { assistantPending: { kind: "live_value", field: "stock", products: ["kettle"], preferSid: null, at: new Date().toISOString() } });
      await resetSession(PHONE);
      expect(db.tables.whatsapp_sessions[0].assistant_pending).toBeNull();
    });

    it("stop, a tapped button or 2 hours close it; a photo or the agent's own question back don't", async () => {
      await fixRejected(USER, PHONE, "wellington boot");
      const q = pending();
      expect(await answerQcLive(USER, PHONE, q, undefined)).toBe(false);
      expect(keptQc(q, undefined)).toBe(true);
      expect(await answerQcLive(USER, PHONE, q, "answer:@live_changes:Send 0.2 kg again")).toBe(false);
      expect(keptQc(q, "answer:@live_changes:Send 0.2 kg again")).toBe(true);
      expect(pending()).toMatchObject({ kind: "qc_live" });

      expect(await answerQcLive(USER, PHONE, q, "lchgno:abc")).toBe(false);
      expect(keptQc(q, "lchgno:abc")).toBe(false);
      expect(db.tables.whatsapp_sessions[0].assistant_pending).toBeNull();

      const old = { ...q, at: new Date(Date.now() - 121 * 60_000).toISOString() };
      expect(keptQc(old, "0.1")).toBe(false);
      expect(await answerQcLive(USER, PHONE, old, "0.1")).toBe(false);
      expect(db.tables.whatsapp_sessions[0].assistant_pending).toBeNull();
      // Within the 2 hours it's still open (an hour was the limit before).
      expect(keptQc({ ...q, at: new Date(Date.now() - 90 * 60_000).toISOString() }, "0.1")).toBe(true);

      db.tables.whatsapp_sessions[0].assistant_pending = q;
      botSaid(q.asked!);
      expect(await answerQcLive(USER, PHONE, q, "stop")).toBe(true);
      expect(last().body).toContain("I've left");
      expect(db.tables.whatsapp_sessions[0].assistant_pending).toBeNull();
    });

    it("a brand: \"ok\" or \"thanks\" is never the brand; agreeing doesn't send back the brand Jumia refused", async () => {
      reject(2, "Brand 'Generic' is not a recognized brand for a rain boot. Please list this product under a genuine, specific brand name.");
      expect(await fixRejected(USER, PHONE, "wellington boot")).toBe("fix: ask_brand");
      expect(last().body).toContain("Its brand on Jumia now is \"Lattafa\".");
      botSaid(last().body);
      for (const t of ["ok", "thanks", "yes that's right", "ok thanks", "thank you so much", "No", "That's the brand"]) expect(await answerQcLive(USER, PHONE, pending(), t)).toBe(false);
      expect(pending()).toMatchObject({ kind: "qc_live", ask: "brand" });
      expect(sent.filter((m) => m.body.includes("isn't a brand on Jumia"))).toHaveLength(0);
    });

    it("switched off: asked and let go as before", async () => {
      db.tables.app_settings = [];
      await fixRejected(USER, PHONE, "wellington boot");
      expect(last().body).not.toContain("Jumia has 0.2 kg");
      expect(pending().keep).toBeUndefined();
      expect(await answerQcLive(USER, PHONE, pending(), "That is the weight listed")).toBe(false);
      expect(db.tables.whatsapp_sessions[0].assistant_pending).toBeNull();
    });
  });
});
