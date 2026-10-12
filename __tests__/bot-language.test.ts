/**
 * The bot's own messages in the seller's language (lib/i18n/bot.ts), and
 * choosing it on WhatsApp and in the web chat (lib/whatsapp/language-
 * command.ts): translated as sent, ids and numbers untouched, the English
 * kept in the log for the bot's own code, each line translated once.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));

/** The AI's translations: each item's text run through `translate`, or an error. */
let translate: ((s: string) => string) | Error = (s) => `FR(${s})`;
const prompts: string[] = [];
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (_model: string, parts: { text?: string }[]) => {
    const prompt = parts.map((p) => p.text ?? "").join("\n");
    prompts.push(prompt);
    if (translate instanceof Error) throw translate;
    const items = JSON.parse(prompt.slice(prompt.lastIndexOf("\n[") + 1)) as { text: string }[];
    const t = translate;
    return { text: JSON.stringify(items.map((i) => t(i.text))) };
  },
}));

// The web chat's module, without the bot behind it (as __tests__/listing-assistant.test.ts).
jest.mock("@/lib/whatsapp/intake", () => ({ handleLinkedMessage: async () => undefined }));
jest.mock("@/lib/actions/upload", () => ({ validateImageBuffer: async () => ({ mime: "image/jpeg", ext: "jpg" }) }));
jest.mock("@/lib/jumia/credentials", () => ({ getJumiaConnectionKind: async () => "connected" }));
jest.mock("@/lib/jumia/connect-token", () => ({ createConnectToken: async () => "tok" }));
jest.mock("@/lib/whatsapp/assistant", () => ({ assistantEnabled: async () => true }));

import { aiWritten, alreadyIn, forgetLanguage, keepsEssentials, languageOfNumber, localizeText, recipientLanguage, slotsOf } from "@/lib/i18n/bot";
import { sendButtonsIfConfigured, sendRichIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";
import { assistantMessages } from "@/lib/whatsapp/listing-assistant";
import { parseGlobalCommand } from "@/lib/whatsapp/commands";
import { languageMenu, runLanguageCommand } from "@/lib/whatsapp/language-command";

/** Short labels as a translator would put them; anything else marked as translated. */
const LABELS: Record<string, string> = { "Submit all ✅": "Tout soumettre ✅", "Review listings": "Voir les annonces" };
const French = (s: string) => LABELS[s] ?? `Bonjour : ${s.replace(/Submit/g, "Soumettre")}`;

beforeEach(() => {
  db.tables.whatsapp_message_log = [];
  db.tables.seller_preferences = [];
  db.tables.jumia_connections = [];
  db.tables.whatsapp_connections = [];
  db.tables.bot_translations = [];
  prompts.length = 0;
  translate = French;
  ["u1", "u2", "gh"].forEach(forgetLanguage);
});

const outbound = () => db.tables.whatsapp_message_log.filter((r) => r.direction === "outbound");

describe("whose language", () => {
  it("their choice, else their Jumia market's, else their number's country", async () => {
    db.tables.seller_preferences = [{ user_id: "u1", ui_language: "ar" }];
    db.tables.jumia_connections = [{ user_id: "u2", country: "SN" }, { user_id: "gh", country: "GH" }];
    db.tables.whatsapp_connections = [{ user_id: "gh", phone_number: "225700000001" }];
    expect(await recipientLanguage("web:u1")).toBe("ar");
    expect(await recipientLanguage("web:u2")).toBe("fr");
    // A Ghana shop on an Ivorian number: the shop's market wins.
    expect(await recipientLanguage("225700000001")).toBe("en");
    // Not signed up: the number's country.
    expect(await recipientLanguage("221770000000")).toBe("fr");
    expect(["233241234567", "2250700000000", "212600000000", "+221770000000"].map(languageOfNumber)).toEqual(["en", "fr", "fr", "fr"]);
  });
});

describe("a message on its way", () => {
  it("an English seller's goes as it is, with no AI call", async () => {
    await sendButtonsIfConfigured("web:u1", "Your product is ready. Submit it?", [{ id: "submit all", title: "Submit all ✅" }]);
    expect(prompts).toHaveLength(0);
    expect(outbound()[0]).toMatchObject({ body_text: "Your product is ready. Submit it?" });
    expect((outbound()[0].payload as Record<string, unknown>).shown).toBeUndefined();
  });

  it("a French seller's is translated: the log keeps the English, the web chat shows the French, the ids stay", async () => {
    db.tables.seller_preferences = [{ user_id: "u1", ui_language: "fr" }];
    await sendButtonsIfConfigured("web:u1", "Your product is ready. Submit it?", [{ id: "submit all", title: "Submit all ✅" }]);
    const row = outbound()[0];
    expect(row.body_text).toBe("Your product is ready. Submit it?");
    const [shown] = await assistantMessages("u1");
    expect(shown.text).toBe("Bonjour : Your product is ready. Soumettre it?");
    expect(shown.payload).toEqual({ buttons: [{ id: "submit all", title: "Tout soumettre ✅" }] });
    expect(prompts[0]).toContain("into French");
    expect(prompts[0]).toContain("keep that word or phrase exactly as written, in English");
  });

  it("each line is translated once: the same message again needs no AI", async () => {
    db.tables.seller_preferences = [{ user_id: "u1", ui_language: "fr" }];
    await sendTextIfConfigured("web:u1", "Send the photos of product 2.");
    await sendTextIfConfigured("web:u1", "Send the photos of product 2.");
    expect(prompts).toHaveLength(1);
    expect(db.tables.bot_translations).toHaveLength(1);
    expect((await assistantMessages("u1")).map((m) => m.text)).toEqual(["Bonjour : Send the photos of product 2.", "Bonjour : Send the photos of product 2."]);
  });

  it("a line whose numbers, links or length change stays English; a failed call sends it all in English", async () => {
    db.tables.seller_preferences = [{ user_id: "u1", ui_language: "fr" }];
    translate = (s) => s.replace("150", "one hundred fifty").replace("Stock", "Le stock");
    await sendButtonsIfConfigured("web:u1", "Price GHS 150. Stock?", [{ id: "stock", title: "Stock" }]);
    const [m] = await assistantMessages("u1");
    expect(m.text).toBe("Price GHS 150. Stock?");
    expect(m.payload).toEqual({ buttons: [{ id: "stock", title: "Le stock" }] });

    translate = new Error("quota");
    await sendTextIfConfigured("web:u1", "Something else entirely.");
    expect((await assistantMessages("u1"))[1].text).toBe("Something else entirely.");
    expect(db.tables.bot_translations.map((r) => r.translated)).toEqual(["Le stock"]);
  });

  it("the AI's own reply goes as written; its buttons are translated", async () => {
    db.tables.seller_preferences = [{ user_id: "u1", ui_language: "fr" }];
    await aiWritten(() => sendButtonsIfConfigured("web:u1", "Your stock is low on 3 products.", [{ id: "review", title: "Review listings" }]));
    const [m] = await assistantMessages("u1");
    expect(m.text).toBe("Your stock is low on 3 products.");
    expect(m.payload).toEqual({ buttons: [{ id: "review", title: "Voir les annonces" }] });
  });

  it("a line already in their language, or with no words, isn't sent to the AI", async () => {
    db.tables.seller_preferences = [{ user_id: "u1", ui_language: "fr" }];
    await sendButtonsIfConfigured("web:u1", "Vous avez 3 produits dans votre boutique, et le stock est bon.", [{ id: "1", title: "1" }, { id: "2", title: "2" }]);
    expect(prompts).toHaveLength(0);
    expect(alreadyIn("ar", "لديك 3 منتجات")).toBe(true);
    expect(alreadyIn("ar", "You have 3 products")).toBe(false);
    expect(alreadyIn("fr", "You have 3 products in your shop")).toBe(false);
  });

  it("goes to WhatsApp in their language", async () => {
    process.env.WHATSAPP_ACCESS_TOKEN = "t";
    process.env.WHATSAPP_PHONE_NUMBER_ID = "p";
    const sent: Record<string, unknown>[] = [];
    const realFetch = global.fetch;
    global.fetch = (async (_url: string, init?: { body?: string }) => {
      sent.push(JSON.parse(init?.body ?? "{}"));
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    try {
      db.tables.whatsapp_connections = [{ user_id: "u2", phone_number: "221770000001" }];
      db.tables.seller_preferences = [{ user_id: "u2", ui_language: "fr" }];
      await sendTextIfConfigured("221770000001", "Your order is packed.");
      expect(sent[0]).toMatchObject({ to: "221770000001", text: { body: "Bonjour : Your order is packed." } });
      expect(outbound()[0]).toMatchObject({ body_text: "Your order is packed." });
    } finally {
      global.fetch = realFetch;
      delete process.env.WHATSAPP_ACCESS_TOKEN;
      delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    }
  });

  it("the web chat's tables: headings, column names and statuses, not names or numbers", async () => {
    db.tables.seller_preferences = [{ user_id: "u1", ui_language: "fr" }];
    await sendRichIfConfigured("web:u1", "Your products", {
      blocks: [
        { kind: "heading", text: "Your products" },
        { kind: "table", columns: ["Product", "Stock"], rows: [["Hisense 205L Fridge", { text: "Out of stock", tone: "bad" }]] },
      ],
    });
    const [m] = await assistantMessages("u1");
    expect(m.text).toBe("Bonjour : Your products");
    expect((m.payload as { rich: unknown }).rich).toEqual({
      blocks: [
        { kind: "heading", text: "Bonjour : Your products" },
        { kind: "table", columns: ["Bonjour : Product", "Bonjour : Stock"], rows: [["Hisense 205L Fridge", { text: "Bonjour : Out of stock", tone: "bad" }]] },
      ],
    });
  });

  it("a nudge added to the AI's reply is put in their language on its own", async () => {
    db.tables.seller_preferences = [{ user_id: "u1", ui_language: "fr" }];
    expect(await localizeText("web:u1", "Send product 1's photos.")).toBe("Bonjour : Send product 1's photos.");
    expect(await aiWritten(() => localizeText("web:u1", "Send product 2's photos."))).toBe("Bonjour : Send product 2's photos.");
  });
});

describe("the checks on a translation", () => {
  it("numbers, links, bold marks and length", () => {
    expect(keepsEssentials("Price GHS 1,200 for 2", "Prix GHS 1,200 pour 2", 100)).toBe(true);
    expect(keepsEssentials("Price GHS 1,200", "Prix GHS 1 200", 100)).toBe(false);
    expect(keepsEssentials("Open https://pandaworldai.site/x.", "Ouvrez https://pandaworldai.site/x", 100)).toBe(true);
    expect(keepsEssentials("Open https://pandaworldai.site/x", "Ouvrez le lien", 100)).toBe(false);
    expect(keepsEssentials("Reply *done*", "Répondez *done", 100)).toBe(false);
    expect(keepsEssentials("Submit all", "Soumettre toutes les annonces", 20)).toBe(false);
  });

  it("finds every place in a list message", () => {
    const body = {
      type: "interactive",
      interactive: { type: "list", body: { text: "Pick one" }, action: { button: "Choose", sections: [{ rows: [{ id: "a", title: "Orders", description: "To pack" }] }] } },
    };
    expect(slotsOf(body).map((s) => [s.text, s.max, s.kind])).toEqual([
      ["Pick one", 1024, "body"], ["Choose", 20, "label"], ["Orders", 24, "label"], ["To pack", 72, "label"],
    ]);
  });
});

describe("choosing the language", () => {
  it("the words that ask for it; never a bare language name", () => {
    const set = (t: string) => {
      const c = parseGlobalCommand(t);
      return c?.type === "language" ? c.set : undefined;
    };
    expect(["language", "Langue", "لغة", "change language"].map(set)).toEqual([null, null, null, null]);
    expect(set("lang:ui:fr")).toEqual({ key: "ui", value: "fr" });
    expect(set("lang:listing:en")).toEqual({ key: "listing", value: "en" });
    expect(set("speak French please")).toEqual({ key: "ui", value: "fr" });
    expect(set("parle-moi en français")).toEqual({ key: "ui", value: "fr" });
    expect(set("Répondez en anglais svp")).toEqual({ key: "ui", value: "en" });
    expect(set("تحدث معي بالعربية")).toEqual({ key: "ui", value: "ar" });
    expect(["English", "French", "Français", "the language is English"].map(set)).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("the menu goes as written, in the seller's language, rows in each language's own name", async () => {
    db.tables.seller_preferences = [{ user_id: "u1", ui_language: "fr", listing_language: "en" }];
    await runLanguageCommand("u1", "web:u1", null);
    expect(prompts).toHaveLength(0);
    const [m] = await assistantMessages("u1");
    expect(m.text).toBe(languageMenu({ ui: "fr", listing: "en" }).body);
    expect(m.text).toContain("Je vous parle en *français*");
    expect(m.text).toContain("rédigées en *anglais*");
    expect((m.payload as { rows: { title: string }[] }).rows.map((r) => r.title)).toEqual(["English", "Français", "العربية", "Listings: English", "Annonces : français"]);
  });

  it("a tapped row saves it and says so in the new language; the bot's next message follows", async () => {
    await runLanguageCommand("u1", "web:u1", { key: "ui", value: "ar" });
    expect(db.tables.seller_preferences).toMatchObject([{ user_id: "u1", ui_language: "ar" }]);
    expect((await assistantMessages("u1"))[0].text).toContain("سأتحدث معك بالعربية");
    expect(await recipientLanguage("web:u1")).toBe("ar");

    await runLanguageCommand("u1", "web:u1", { key: "listing", value: "fr" });
    expect((await assistantMessages("u1"))[1].text).toBe("✅ ستُكتب إعلاناتك الجديدة على Jumia بـالفرنسية.");
    // Listings in Arabic aren't offered: the menu instead.
    await runLanguageCommand("u1", "web:u1", { key: "listing", value: "ar" });
    expect((await assistantMessages("u1"))[2].type).toBe("list");
    expect(prompts).toHaveLength(0);
  });
});
