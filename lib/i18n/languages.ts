/**
 * The languages PandaWorld talks to sellers in (owner, 2026-10-11): English,
 * French and Arabic. Safe for the browser: no server imports, so the chat's
 * switch and the server's preferences (lib/preferences/language.ts) share it.
 */

export type UiLanguage = "en" | "fr" | "ar";
export const UI_LANGUAGES: UiLanguage[] = ["en", "fr", "ar"];

/** Each language's own name, for the switch. */
export const LANGUAGE_NAMES: Record<UiLanguage, string> = { en: "English", fr: "Français", ar: "العربية" };

export const isUiLanguage = (v: unknown): v is UiLanguage => typeof v === "string" && (UI_LANGUAGES as string[]).includes(v);

/** Arabic reads right to left. */
export const directionOf = (lang: UiLanguage): "rtl" | "ltr" => (lang === "ar" ? "rtl" : "ltr");
