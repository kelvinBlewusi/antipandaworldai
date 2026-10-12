import { NextRequest, NextResponse } from "next/server";
import { translateLines } from "@/lib/i18n/bot";
import { EDIT_HELP, MENU_ROWS, menuText } from "@/lib/whatsapp/chat-commands";
import { CLEAR_ON_WHATSAPP } from "@/lib/whatsapp/chat-clear";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── POST /api/worker/translation-check ──────────────────────────────────────
//
// A look at how the bot's own messages read in French and Arabic
// (lib/i18n/bot.ts), on real lines of the bot's, before a seller sees them:
// answers with each line and its translation (null where it stays English),
// for the pg_net response log. The lines it translates are cached as any
// other, so this also warms the cache. Sends nothing to anyone.
//
// Security: the same Bearer CRON_SECRET contract as the other workers.

/** Real lines of the bot's, with WhatsApp's length for their place. */
const LINES: { text: string; max: number; kind?: "body" | "label" }[] = [
  { text: menuText(), max: 1024 },
  { text: EDIT_HELP, max: 4096 },
  { text: CLEAR_ON_WHATSAPP, max: 4096 },
  { text: "🎉 Jumia connected!\n\nHow many products are you listing today? Reply with a number to get started, or ask me about your shop.", max: 1024 },
  { text: "✅ Product drafted: Nasco Electric Kettle 1.8L - Stainless Steel, Auto Shut-Off.\n\n*What variation(s) do you have?* Reply with them, e.g. *Small, Medium*.", max: 1024 },
  { text: "📦 Order 355926919: 2 items, GHS 1,250.00. Pack it, then tap *Ready to ship*. Details: https://pandaworldai.site/extension/orders", max: 1024 },
  { text: "Submit all ✅", max: 20, kind: "label" },
  { text: "Review listings", max: 20, kind: "label" },
  { text: "Start another ➕", max: 20, kind: "label" },
  { text: "OR Choose one", max: 20, kind: "label" },
  { text: "Edit product", max: 20, kind: "label" },
  ...MENU_ROWS.slice(0, 4).flatMap((r) => [{ text: r.title, max: 24, kind: "label" as const }, { text: r.description, max: 72, kind: "label" as const }]),
];

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return new NextResponse("Server not configured", { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) return new NextResponse("Unauthorized", { status: 401 });

  // The AI's own answers (the start of each), to see why a line stayed English.
  const answers: string[] = [];
  const keep = (raw: string) => { answers.push(raw.slice(0, 1500)); };
  const [fr, ar] = await Promise.all([translateLines("fr", LINES, null, keep), translateLines("ar", LINES, null, keep)]);
  return NextResponse.json({
    lines: LINES.map((l, i) => ({ en: l.text, fr: fr[i], ar: ar[i] })),
    englishKept: { fr: fr.filter((t) => t == null).length, ar: ar.filter((t) => t == null).length },
    answers,
  });
}
