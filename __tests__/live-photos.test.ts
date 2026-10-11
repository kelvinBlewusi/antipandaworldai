/**
 * More photos for a live product (lib/whatsapp/live-photos.ts): once the
 * seller taps Done, the photos go to Jumia without a second tap (owner,
 * 2026-10-11: "Safe to make immediate").
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
const sent: { kind: string; body: string }[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured:    async (_to: string, body: string) => { sent.push({ kind: "text", body }); },
  sendButtonsIfConfigured: async (_to: string, body: string) => { sent.push({ kind: "buttons", body }); },
}));
jest.mock("@/lib/whatsapp/media", () => ({ ingestWhatsAppImage: async (id: string) => `https://cdn/${id}.jpg` }));
jest.mock("@/lib/whatsapp/session", () => ({ updateSession: async () => {} }));
const made: unknown[][] = [];
jest.mock("@/lib/whatsapp/shop", () => ({
  CHANGES: "changes", CHANGES_FEATURE: "shop_changes",
  catalog: async () => [], sendLong: async () => {}, shopContext: async () => null,
  shorten: (t: string) => t,
  makeChange: async (...a: unknown[]) => { made.push(a); return "sent"; },
}));

import { answerAddPhotos } from "@/lib/whatsapp/live-photos";
import type { AddPhotosAsk } from "@/lib/whatsapp/session";

const CHANGE = "44444444-0000-4000-8000-000000000001";
const ask = (): AddPhotosAsk => ({ kind: "add_photos", changeId: CHANGE, name: "Neck Fan", room: 3, at: new Date().toISOString() });

beforeEach(() => {
  db = new FakeDb();
  sent.length = 0;
  made.length = 0;
  db.tables.jumia_product_changes = [{ id: CHANGE, user_id: "seller", product_sid: "p1", seller_sku: "FAN-1", status: "collecting", change: { kind: "content", fields: { images: [] } } }];
  db.tables.jumia_products = [{ user_id: "seller", product_sid: "p1", seller_sku: "FAN-1", name: "Neck Fan" }];
});

describe("more photos for a live product", () => {
  it("keeps each photo, and on Done sends them to Jumia with no second tap", async () => {
    expect(await answerAddPhotos("seller", "233", ask(), { imageMediaId: "m1" })).toBe(true);
    expect(await answerAddPhotos("seller", "233", ask(), { imageMediaId: "m2" })).toBe(true);
    expect(await answerAddPhotos("seller", "233", ask(), { text: "done" })).toBe(true);
    expect(made).toHaveLength(1);
    const [userId, , id, product, change] = made[0] as [string, string, string, { sellerSku: string }, unknown];
    expect([userId, id, product.sellerSku]).toEqual(["seller", CHANGE, "FAN-1"]);
    expect(change).toEqual({ kind: "content", fields: { images: ["https://cdn/m1.jpg", "https://cdn/m2.jpg"] } });
    expect(sent.some((m) => /Yes, update/.test(m.body))).toBe(false);
  });

  it("Done with no photos yet asks for them, and sends nothing", async () => {
    await answerAddPhotos("seller", "233", ask(), { text: "done" });
    expect(made).toHaveLength(0);
    expect(sent.at(-1)!.body).toContain("I haven't got any photos");
  });
});
