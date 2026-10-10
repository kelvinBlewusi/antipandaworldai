import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { sendTemplateIfConfigured } from "@/lib/whatsapp/client";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

// ─── POST /api/worker/template-test ──────────────────────────────────────────
//
// One test of the new-order alert template once Meta approves it (owner,
// 2026-10-10: "whatsapp template id - 1080436151465743 active now"). Order
// alerts outside WhatsApp's 24 hours use app_settings `order_alert_template`
// ({ name, language }; lib/whatsapp/order-alerts.ts); this sends that
// template once, with sample values that say it's a test, to an admin's own
// WhatsApp, so a mismatch with what Meta approved (its number of values, its
// quick-reply button) shows here rather than on a seller's real order.
//
// app_settings `template_test` holds { userId }: an admin. It's emptied
// first. The button's payload is "orders": a tap shows their waiting orders,
// nothing more. Answers with what WhatsApp said, for the pg_net response log.
//
// Security: the same Bearer CRON_SECRET contract as the other workers, and
// admins only.

/** What the test sends: the template's four values (order number, items, total, delivery), all saying it's a test. */
const TEST_VALUES = ["TEST-0000", "A test of the new-order alert (not a real order)", "GHS 0", "Nothing to deliver"];

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return new NextResponse("Server not configured", { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) return new NextResponse("Unauthorized", { status: 401 });

  const db = createServerClient();
  const { data } = await db.from("app_settings").select("value").eq("key", "template_test").maybeSingle();
  const userId = typeof (data?.value as { userId?: unknown } | null)?.userId === "string" ? (data!.value as { userId: string }).userId : "";
  if (!userId) return NextResponse.json({ ok: false, error: "nothing asked" });
  // {} rather than null: app_settings.value can't be null.
  await db.from("app_settings").update({ value: {} }).eq("key", "template_test");
  if (!isAdmin(userId)) return NextResponse.json({ ok: false, error: "admins only" }, { status: 403 });

  const { data: t } = await db.from("app_settings").select("value").eq("key", "order_alert_template").maybeSingle();
  const template = (t?.value ?? null) as { name?: unknown; language?: unknown } | null;
  if (typeof template?.name !== "string" || typeof template.language !== "string") {
    return NextResponse.json({ ok: false, error: "order_alert_template isn't set" });
  }

  const { data: wa } = await db.from("whatsapp_connections").select("phone_number").eq("user_id", userId).limit(1);
  const to = ((wa ?? []) as { phone_number: string | null }[])[0]?.phone_number?.replace(/^\+/, "");
  if (!to) return NextResponse.json({ ok: false, error: "no WhatsApp linked" });
  try {
    await sendTemplateIfConfigured(to, template.name, template.language, TEST_VALUES, ["orders"]);
    return NextResponse.json({ ok: true, template, sent: true });
  } catch (e) {
    return NextResponse.json({ ok: false, template, sent: false, error: (e as Error).message.slice(0, 500) });
  }
}
