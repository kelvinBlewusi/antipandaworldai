/**
 * POST /api/extension/language — the extension panel's language switch
 * (panels from 0.2.59): { ui?: "en"|"fr"|"ar", listing?: "en"|"fr" }, the
 * same choice as Settings → Language and the web chat's globe button
 * (lib/preferences/language.ts). Answers with both languages as saved.
 *
 * API-key-authed, like /api/extension/account (the panel has no Clerk session).
 */

import { NextResponse } from "next/server";
import { authenticateExtensionKey } from "@/lib/security/extension-keys";
import { isListingLanguage, isUiLanguage, sellerLanguages, setSellerLanguages } from "@/lib/preferences/language";
import { forgetLanguage } from "@/lib/i18n/bot";

export const runtime = "nodejs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: Request) {
  const authResult = await authenticateExtensionKey(req.headers.get("authorization"));
  if (!authResult.ok) return NextResponse.json({ error: authResult.error }, { status: 401, headers: CORS });
  const body = (await req.json().catch(() => null)) as { ui?: unknown; listing?: unknown } | null;
  const ui = isUiLanguage(body?.ui) ? body.ui : undefined;
  const listing = isListingLanguage(body?.listing) ? body.listing : undefined;
  if (!ui && !listing) return NextResponse.json({ error: "That isn't a language PandaWorld offers." }, { status: 400, headers: CORS });
  try {
    await setSellerLanguages(authResult.userId, { ui, listing });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500, headers: CORS });
  }
  // The bot's next message is in it too (lib/i18n/bot.ts).
  forgetLanguage(authResult.userId);
  const langs = await sellerLanguages(authResult.userId);
  return NextResponse.json({ ui: langs.ui, listing: langs.listing }, { status: 200, headers: CORS });
}
