/**
 * What keeps the assistant in bounds. Since 2026-10-07 every seller has it,
 * on WhatsApp and the website, with no daily allowance (owner: "AI for all
 * sellers and remove daily limit"): it reads every typed message
 * (lib/whatsapp/intake.ts), and chatting is free. What's left:
 *
 *   - A kill switch: app_settings `assistant_enabled` false turns the
 *     assistant off for everyone, admins included; the fixed flow and its
 *     commands carry on alone.
 *   - A ceiling on all sellers' AI turns in a UTC day (app_settings
 *     `assistant_daily_limit`, else DEFAULT_DAILY_CEILING): past it the
 *     assistant rests for everyone but admins until midnight UTC, whatever
 *     goes wrong (a loop, a flood). The fixed flow answers meanwhile.
 *   - Each seller's own daily limit, by pack (SELLER_DAILY_LIMITS, owner
 *     2026-10-11: "a per-seller daily limit ... let the biggest package not
 *     have any and the pro has higher daily limit than the standard, make
 *     the baseline 250"), so one account can't use up the ceiling for
 *     everyone. Told once a day (lib/whatsapp/assistant.ts runAssistant).
 *
 * A turn is a whatsapp_assistant_log row with the AI's answer in `raw`: what
 * was asked of the AI, not the taps and numbers answered without it.
 */

import { createServerClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth/is-admin";
import { currentPack } from "@/lib/billing/features";

/**
 * All sellers' AI turns in a UTC day, unless app_settings
 * `assistant_daily_limit` says otherwise. About $0.001 a turn, so the
 * ceiling caps a bad day near $20.
 */
export const DEFAULT_DAILY_CEILING = 20_000;

async function setting(key: string): Promise<unknown> {
  try {
    const { data } = await createServerClient().from("app_settings").select("value").eq("key", key).maybeSingle();
    return data?.value;
  } catch {
    return undefined;
  }
}

/** The kill switch: false only when app_settings `assistant_enabled` is false. */
export async function assistantSwitchedOn(): Promise<boolean> {
  return (await setting("assistant_enabled")) !== false;
}

async function turnsSince(since: string): Promise<number> {
  const { count } = await createServerClient()
    .from("whatsapp_assistant_log")
    .select("id", { count: "exact", head: true })
    .gt("created_at", since)
    .not("raw", "is", null);
  return count ?? 0;
}

/**
 * AI messages one seller gets in a UTC day (midnight in Ghana), by the pack
 * they last bought; free sign-up credits count as the baseline. Null: no
 * limit. A real seller sent 13 to 28 a week in October 2026.
 */
export const SELLER_DAILY_LIMITS: Record<string, number | null> = {
  free: 250, starter: 250, standard: 250, pro: 500, business: null,
};

export function sellerDailyLimit(packId: string | null | undefined): number | null {
  const key = packId ?? "free";
  return key in SELLER_DAILY_LIMITS ? SELLER_DAILY_LIMITS[key] : SELLER_DAILY_LIMITS.free;
}

async function sellerTurnsSince(userId: string, since: string): Promise<number> {
  const { count } = await createServerClient()
    .from("whatsapp_assistant_log")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gt("created_at", since)
    .not("raw", "is", null);
  return count ?? 0;
}

export type AssistantGate =
  | { ok: true }
  | { ok: false; reason: "ceiling" }
  | { ok: false; reason: "seller"; limit: number; pack: string | null };

/** Whether the assistant may take another turn now: the day's ceiling for everyone, then the seller's own limit. */
export async function assistantGate(userId: string, now = new Date()): Promise<AssistantGate> {
  if (isAdmin(userId)) return { ok: true };
  const utcMidnight = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const ceiling = Number(await setting("assistant_daily_limit"));
  if ((await turnsSince(utcMidnight)) >= (Number.isFinite(ceiling) && ceiling > 0 ? ceiling : DEFAULT_DAILY_CEILING)) {
    return { ok: false, reason: "ceiling" };
  }
  const pack = (await currentPack(userId).catch(() => null))?.id ?? null;
  const limit = sellerDailyLimit(pack);
  if (limit != null && (await sellerTurnsSince(userId, utcMidnight)) >= limit) {
    return { ok: false, reason: "seller", limit, pack };
  }
  return { ok: true };
}

/** The one message when a seller reaches their day's limit; after it, the fixed flow answers until midnight. */
export function sellerLimitText(limit: number, pack: string | null, web = false): string {
  const more = pack === "pro"
    ? "The Business pack has no daily limit."
    : `The Pro pack gets ${SELLER_DAILY_LIMITS.pro} a day, and Business has no limit.`;
  return `You've reached today's ${limit} chat messages, so I'll answer questions again after midnight (GMT). ` +
    `Until then, ${commandsHint(web)}: listing products and the buttons work as usual. ${more}`;
}

/** Where the commands are: the / menu and + on the web, "menu" on WhatsApp. */
const commandsHint = (web: boolean) => (web ? "type */* or tap *+* for the commands" : "type *menu* for the commands");

/**
 * When the assistant is resting (the ceiling) and a question reaches the
 * fixed flow, which can't answer it: the commands still work.
 */
export function limitedText(web = false): string {
  return `I can't answer questions right now. The commands still work: ${commandsHint(web)}, or tell me how many products you're listing (e.g. *3*).`;
}
