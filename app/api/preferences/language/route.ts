import { NextRequest, NextResponse } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { isListingLanguage, isUiLanguage, sellerLanguages, setSellerLanguages } from "@/lib/preferences/language";

export const dynamic = "force-dynamic";

// ─── /api/preferences/language ───────────────────────────────────────────────
//
// The signed-in seller's languages (lib/preferences/language.ts): what
// PandaWorld talks to them in, and what their listings are written in. GET
// reads them (their market's until chosen); POST { ui?, listing? } chooses.

export async function GET() {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.json(await sellerLanguages(userId));
}

export async function POST(req: NextRequest) {
  const { userId } = await auth();
  if (!userId) return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  let body: { ui?: unknown; listing?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Send the language to use." }, { status: 400 });
  }
  const ui = isUiLanguage(body.ui) ? body.ui : undefined;
  const listing = isListingLanguage(body.listing) ? body.listing : undefined;
  if (!ui && !listing) return NextResponse.json({ error: "That isn't a language PandaWorld offers." }, { status: 400 });
  await setSellerLanguages(userId, { ui, listing });
  return NextResponse.json(await sellerLanguages(userId));
}
