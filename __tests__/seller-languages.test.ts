/**
 * Each seller's languages (owner, 2026-10-11): listings in their market's
 * language unless they choose otherwise (French in Côte d'Ivoire, Senegal
 * and Morocco), and the checks a translated listing passes before it's used.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
let reply: string | Error = "{}";
const prompts: string[] = [];
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (_model: string, parts: { text?: string }[]) => {
    prompts.push(parts.map((p) => p.text ?? "").join("\n"));
    if (reply instanceof Error) throw reply;
    return { text: reply };
  },
}));

import { listingLanguageFor, sameTags, translateListingCopy } from "@/lib/ai/listing-language";
import { marketLanguages, sellerLanguages, setSellerLanguages } from "@/lib/preferences/language";

beforeEach(() => {
  db.tables.jumia_connections = [];
  db.tables.seller_preferences = [];
  prompts.length = 0;
  reply = "{}";
});

describe("the language a market lists in", () => {
  it("French in Côte d'Ivoire, Senegal and Morocco; English elsewhere and when unknown", () => {
    expect(["CI", "SN", "MA", "ma"].map(listingLanguageFor)).toEqual(["fr", "fr", "fr", "fr"]);
    expect(["GH", "NG", "KE", "EG", "UG", null, undefined].map(listingLanguageFor)).toEqual(["en", "en", "en", "en", "en", "en", "en"]);
    expect(marketLanguages("SN")).toEqual({ ui: "fr", listing: "fr" });
  });
});

describe("a seller's choice", () => {
  it("follows their Jumia market until they choose, then keeps each choice on its own", async () => {
    db.tables.jumia_connections = [{ user_id: "s1", country: "CI" }];
    expect(await sellerLanguages("s1")).toEqual({ ui: "fr", listing: "fr", chosen: { ui: false, listing: false } });
    await setSellerLanguages("s1", { listing: "en" });
    expect(await sellerLanguages("s1")).toEqual({ ui: "fr", listing: "en", chosen: { ui: false, listing: true } });
    await setSellerLanguages("s1", { ui: "ar" });
    expect(await sellerLanguages("s1")).toEqual({ ui: "ar", listing: "en", chosen: { ui: true, listing: true } });
  });

  it("a Ghana seller can choose French listings; nonsense is ignored", async () => {
    db.tables.jumia_connections = [{ user_id: "s2", country: "GH" }];
    await setSellerLanguages("s2", { listing: "fr", ui: "xx" as never });
    expect(await sellerLanguages("s2")).toMatchObject({ ui: "en", listing: "fr" });
  });
});

describe("translating a listing", () => {
  const copy = { title: "Wireless Earbuds Bluetooth 5.3", description: "<p>Clear sound.</p><ul><li>30 h battery</li></ul>", highlights: "<ul><li>Bluetooth 5.3</li></ul>" };

  it("keeps HTML tags in place, or the field stays English", () => {
    expect(sameTags(copy.description, "<p>Son clair.</p><ul><li>Batterie 30 h</li></ul>")).toBe(true);
    expect(sameTags(copy.description, "<p>Son clair. Batterie 30 h</p>")).toBe(false);
  });

  it("uses the French fields that pass, and keeps the English of one that doesn't", async () => {
    reply = JSON.stringify({ title: "Écouteurs sans fil Bluetooth 5.3", description: "<p>Son clair, batterie 30 h</p>", highlights: "<ul><li>Bluetooth 5.3</li></ul>" });
    expect(await translateListingCopy(copy, "fr")).toEqual({ title: "Écouteurs sans fil Bluetooth 5.3", highlights: "<ul><li>Bluetooth 5.3</li></ul>" });
    expect(prompts[0]).toContain("into French");
    expect(prompts[0]).toContain("Keep every HTML tag");
  });

  it("English needs no call; a failed call or a name grown too long keeps the English", async () => {
    expect(await translateListingCopy(copy, "en")).toBeNull();
    expect(prompts).toHaveLength(0);
    reply = new Error("quota");
    expect(await translateListingCopy(copy, "fr")).toBeNull();
    reply = JSON.stringify({ title: "x".repeat(200), description: null, highlights: null });
    expect(await translateListingCopy({ title: "Short name here" }, "fr")).toBeNull();
  });
});
