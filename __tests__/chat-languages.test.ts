/**
 * The web chat in English, French and Arabic (owner, 2026-10-11): every
 * language says everything, the command menu is translated without changing
 * what's sent to the bot, and Arabic reads right to left.
 */

import { CHAT_TEXT, type ChatText } from "@/lib/i18n/chat";
import { directionOf, isUiLanguage, UI_LANGUAGES } from "@/lib/i18n/languages";
import { PALETTE, localPalette, matchingCommands, slashCommand, slashToText, unfinishedFill } from "@/components/assistant/chat-commands";

/** Every string in a language's words, functions called with sample values. */
function strings(t: unknown, path = ""): [string, string][] {
  if (typeof t === "string") return [[path, t]];
  if (typeof t === "function") return [[path, String((t as (...a: unknown[]) => unknown)(2, 3))]];
  if (Array.isArray(t)) return t.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (t && typeof t === "object") return Object.entries(t).flatMap(([k, v]) => strings(v, path ? `${path}.${k}` : k));
  return [];
}

describe("the chat's words", () => {
  it("every language has every word, none empty", () => {
    const keys = (t: ChatText) => strings({ ...t, commandText: {} }).map(([k]) => k);
    for (const lang of UI_LANGUAGES) {
      expect(keys(CHAT_TEXT[lang])).toEqual(keys(CHAT_TEXT.en));
      for (const [k, v] of strings(CHAT_TEXT[lang])) expect([k, v.trim().length > 0]).toEqual([k, true]);
    }
  });

  it("French and Arabic are translated, not copies of the English", () => {
    for (const lang of ["fr", "ar"] as const) {
      const t = CHAT_TEXT[lang];
      expect(t.title).not.toBe(CHAT_TEXT.en.title);
      expect(t.form.draft(3)).not.toBe(CHAT_TEXT.en.form.draft(3));
      expect(t.suggestions).toHaveLength(CHAT_TEXT.en.suggestions.length);
    }
    expect(CHAT_TEXT.fr.form.draft(1)).toBe("Rédiger 1 produit");
    expect(CHAT_TEXT.fr.form.draft(3)).toBe("Rédiger 3 produits");
    expect(CHAT_TEXT.ar.form.products(1)).toBe("منتج واحد");
    expect(CHAT_TEXT.ar.form.products(2)).toBe("منتجان");
    expect(CHAT_TEXT.ar.form.products(5)).toBe("5 منتجات");
    expect(CHAT_TEXT.ar.form.products(12)).toBe("12 منتجًا");
  });

  it("Arabic reads right to left; only the three languages are accepted", () => {
    expect(UI_LANGUAGES.map(directionOf)).toEqual(["ltr", "ltr", "rtl"]);
    expect(["en", "fr", "ar", "sw", "", null].map(isUiLanguage)).toEqual([true, true, true, false, false, false]);
  });
});

describe("the command menu in the seller's language", () => {
  it("names only commands that exist, with a fill only where the command has one", () => {
    for (const lang of ["fr", "ar"] as const) {
      const text = CHAT_TEXT[lang].commandText;
      expect(Object.keys(text).sort()).toEqual(PALETTE.map((c) => c.slash).sort());
      for (const c of PALETTE) {
        if (text[c.slash]?.fill) expect([c.slash, Boolean(c.fill)]).toEqual([c.slash, true]);
      }
    }
  });

  it("English is the palette itself", () => {
    expect(localPalette(CHAT_TEXT.en.commandText)).toBe(PALETTE);
  });

  it("titles translate; what's sent to the bot and the slash names don't", () => {
    const fr = localPalette(CHAT_TEXT.fr.commandText);
    const orders = fr.find((c) => c.slash === "orders")!;
    expect(orders).toMatchObject({ title: "Commandes", send: "orders" });
    expect(slashToText("/orders", fr)).toBe("orders");
    expect(slashToText("/polish 2", fr)).toBe("polish 2");
    expect(slashCommand("/clear", fr)?.action).toBe("clear");
  });

  it("finds a command by its translated title, accents or not", () => {
    const fr = localPalette(CHAT_TEXT.fr.commandText);
    expect(matchingCommands("/cred", fr).map((c) => c.slash)).toContain("credits");
    expect(matchingCommands("/ventes", fr).map((c) => c.slash)).toEqual(["sales", "week"]);
    const ar = localPalette(CHAT_TEXT.ar.commandText);
    expect(matchingCommands("/رصيدي", ar).map((c) => c.slash)).toEqual(["credits"]);
    // The English names still work in any language.
    expect(matchingCommands("/pay", ar).map((c) => c.slash)).toEqual(["payouts"]);
  });

  it("the edit fill is in their words, and a bare one asks what to change in their words", () => {
    const fr = localPalette(CHAT_TEXT.fr.commandText);
    expect(slashToText("/edit le prix de la médaille à 500", fr)).toBe("Modifier le prix de la médaille à 500");
    expect(slashToText("/change stock de GEMMALL5 à 10", fr)).toBe("Modifier stock de GEMMALL5 à 10");
    expect(unfinishedFill("Modifier", fr)?.example).toBe("Modifier le prix de la médaille en or à 500");
    expect(unfinishedFill("Change", fr)).toBeNull();
    const ar = localPalette(CHAT_TEXT.ar.commandText);
    expect(unfinishedFill("غيّر", ar)?.slash).toBe("edit");
  });
});
