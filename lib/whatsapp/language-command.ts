/**
 * Choosing the language on WhatsApp and in the web chat (owner, 2026-10-12:
 * "go ahead"): *language* (or *langue*, *لغة*) shows the choices as a list,
 * the same two as Settings → Language and the web chat's globe button: what
 * PandaWorld talks to the seller in (English, Français, العربية) and what
 * their listings are written in (English, Français). A tapped row
 * ("lang:ui:fr") saves it and says so in the new language. "Speak French",
 * "parle-moi en français", "تحدث بالعربية" choose at once.
 *
 * Written in all three languages here, so these messages go untranslated
 * (lib/i18n/bot.ts `untranslated`): the rows keep each language's own name.
 */

import { sellerLanguages, setSellerLanguages, type SellerLanguages } from "@/lib/preferences/language";
import { forgetLanguage, untranslated } from "@/lib/i18n/bot";
import type { UiLanguage } from "@/lib/i18n/languages";
import { sendListIfConfigured, sendTextIfConfigured } from "@/lib/whatsapp/client";

export interface LanguageChoice { key: "ui" | "listing"; value: UiLanguage }

/** The list's rows: each id is what a tap sends back (parseGlobalCommand). */
export const LANGUAGE_ROWS = [
  { id: "lang:ui:en", title: "English", description: "Talk to me in English" },
  { id: "lang:ui:fr", title: "Français", description: "Me parler en français" },
  { id: "lang:ui:ar", title: "العربية", description: "تحدّث معي بالعربية" },
  { id: "lang:listing:en", title: "Listings: English", description: "Write my Jumia listings in English" },
  { id: "lang:listing:fr", title: "Annonces : français", description: "Rédiger mes annonces Jumia en français" },
];

/** Each language's name, in each language. */
const NAMES: Record<UiLanguage, Record<UiLanguage, string>> = {
  en: { en: "English", fr: "French", ar: "Arabic" },
  fr: { en: "anglais", fr: "français", ar: "arabe" },
  ar: { en: "الإنجليزية", fr: "الفرنسية", ar: "العربية" },
};

/** The menu's words, in the language the seller has now. Pure. */
export function languageMenu(langs: Pick<SellerLanguages, "ui" | "listing">): { body: string; button: string } {
  const n = NAMES[langs.ui];
  switch (langs.ui) {
    case "fr":
      return {
        body: `🌐 *Langue*\nJe vous parle en *${n.fr}* ; vos annonces Jumia sont rédigées en *${n[langs.listing]}*.\n\nAppuyez pour changer l'un ou l'autre.`,
        button: "Choisir",
      };
    case "ar":
      return {
        body: `🌐 *اللغة*\nأتحدث معك بـ*${n.ar}*، وتُكتب إعلاناتك على Jumia بـ*${n[langs.listing]}*.\n\nاضغط لتغيير أيٍّ منهما.`,
        button: "اختر",
      };
    default:
      return {
        body: `🌐 *Language*\nI talk to you in *${n.en}*; your Jumia listings are written in *${n[langs.listing]}*.\n\nTap to change either one.`,
        button: "Choose",
      };
  }
}

/** What's said once it's saved, in the language the seller has now. Pure. */
export function languageSaid(choice: LanguageChoice, langs: Pick<SellerLanguages, "ui" | "listing">): string {
  const n = NAMES[langs.ui];
  if (choice.key === "ui") {
    return langs.ui === "fr" ? "✅ Je vous parle désormais en français. Tapez *langue* à tout moment pour changer."
      : langs.ui === "ar" ? "✅ سأتحدث معك بالعربية من الآن. اكتب *لغة* في أي وقت لتغييرها."
        : "✅ I'll talk to you in English from now on. Type *language* any time to change it.";
  }
  return langs.ui === "fr" ? `✅ Vos nouvelles annonces Jumia seront rédigées en ${n[langs.listing]}.`
    : langs.ui === "ar" ? `✅ ستُكتب إعلاناتك الجديدة على Jumia بـ${n[langs.listing]}.`
      : `✅ Your new Jumia listings will be written in ${n[langs.listing]}.`;
}

/** The menu, or the choice saved and said. */
export async function runLanguageCommand(userId: string, phone: string, set?: LanguageChoice | null): Promise<void> {
  // Listings are English or French only; anything else shows the menu.
  const choice = set && (set.key === "ui" || set.value !== "ar") ? set : null;
  if (choice) {
    await setSellerLanguages(userId, choice.key === "ui" ? { ui: choice.value } : { listing: choice.value as "en" | "fr" });
    forgetLanguage(userId);
  }
  const langs = await sellerLanguages(userId);
  await untranslated(async () => {
    if (choice) {
      await sendTextIfConfigured(phone, languageSaid(choice, langs));
      return;
    }
    const menu = languageMenu(langs);
    await sendListIfConfigured(phone, menu.body, menu.button, LANGUAGE_ROWS);
  });
}
