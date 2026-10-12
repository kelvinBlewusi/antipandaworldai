/**
 * Each seller's languages (owner, 2026-10-11: "let's add a language switch
 * ... that help all jumia countries sellers", and "they should have the
 * flexibility of choosing which they prefer"):
 *
 *   - `ui`: what PandaWorld talks to them in (the web chat, the extension,
 *     the bot's own messages): English, French or Arabic.
 *   - `listing`: what their Jumia listings are written in: English or French.
 *
 * Unset, both follow their Jumia market: French in Côte d'Ivoire, Senegal
 * and Morocco, English elsewhere (FRENCH_MARKETS). Kept in
 * seller_preferences (migration 2026-10-11_seller-preferences.sql).
 */

import { createServerClient } from "@/lib/supabase/server";
import { sellerCountry } from "@/lib/jumia/unlistable-categories";
import { listingLanguageFor, type ListingLanguage } from "@/lib/ai/listing-language";
import { isUiLanguage, type UiLanguage } from "@/lib/i18n/languages";

export { LANGUAGE_NAMES, UI_LANGUAGES, isUiLanguage, type UiLanguage } from "@/lib/i18n/languages";
export const LISTING_LANGUAGES: ListingLanguage[] = ["en", "fr"];

export const isListingLanguage = (v: unknown): v is ListingLanguage => typeof v === "string" && (LISTING_LANGUAGES as string[]).includes(v);

export interface SellerLanguages {
  ui: UiLanguage;
  listing: ListingLanguage;
  /** Whether each was chosen by the seller (false: their market's). */
  chosen: { ui: boolean; listing: boolean };
  /** Their Jumia market, when connected. */
  country: string | null;
}

/** Their market's languages, before any choice. */
export function marketLanguages(country: string | null | undefined): { ui: UiLanguage; listing: ListingLanguage } {
  const listing = listingLanguageFor(country);
  return { ui: listing, listing };
}

export async function sellerLanguages(userId: string): Promise<SellerLanguages> {
  const [{ data }, country] = await Promise.all([
    createServerClient().from("seller_preferences").select("ui_language, listing_language").eq("user_id", userId).maybeSingle(),
    sellerCountry(userId).catch(() => null),
  ]);
  const row = (data ?? {}) as { ui_language?: unknown; listing_language?: unknown };
  const market = marketLanguages(country);
  return {
    ui: isUiLanguage(row.ui_language) ? row.ui_language : market.ui,
    listing: isListingLanguage(row.listing_language) ? row.listing_language : market.listing,
    chosen: { ui: isUiLanguage(row.ui_language), listing: isListingLanguage(row.listing_language) },
    country: country ?? null,
  };
}

/** Save a seller's choice; only the languages given change. */
export async function setSellerLanguages(userId: string, choice: { ui?: UiLanguage; listing?: ListingLanguage }): Promise<void> {
  const patch: Record<string, string> = {};
  if (choice.ui && isUiLanguage(choice.ui)) patch.ui_language = choice.ui;
  if (choice.listing && isListingLanguage(choice.listing)) patch.listing_language = choice.listing;
  if (Object.keys(patch).length === 0) return;
  const { error } = await createServerClient().from("seller_preferences")
    .upsert({ user_id: userId, ...patch, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw new Error(`Couldn't save the language: ${error.message}`);
}
