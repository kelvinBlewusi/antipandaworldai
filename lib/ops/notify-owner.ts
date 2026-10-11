/**
 * Telling the owner something while they're away (owner, 2026-10-11: "what
 * is left to do to leave the system on autopilot"). WhatsApp delivers our
 * own message only inside 24 hours of their last one, so the weekly report
 * and the alerts went nowhere on a quiet week. Now: their WhatsApp when
 * they wrote to the bot in the last 23 hours, else email, to app_settings
 * `owner_alert_email` or the support inbox (SUPPORT_EMAIL).
 *
 * `key` with `everyMs`: the same alert at most that often (the hourly
 * health check would otherwise send one an hour for one stuck job), kept
 * in app_settings `owner_alert:<key>`; with `perDay`, once a UTC day.
 * Never throws.
 */

import { createServerClient } from "@/lib/supabase/server";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { sendEmail } from "@/lib/email/send";
import { SUPPORT_EMAIL } from "@/lib/constants/support";
import { ownerWhatsApp } from "@/lib/evals/warning-signs";
import { lastInboundAt, WINDOW_MS } from "@/lib/whatsapp/order-alerts";

export type OwnerChannel = "whatsapp" | "email" | "held" | "none";

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function setting(key: string): Promise<unknown> {
  const { data } = await createServerClient().from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value;
}

/** The address the owner's emails go to. */
export async function ownerEmail(): Promise<string> {
  const set = await setting("owner_alert_email").catch(() => null);
  return typeof set === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(set) ? set : SUPPORT_EMAIL;
}

export async function notifyOwner(
  subject: string, text: string, opts: { key?: string; everyMs?: number; perDay?: boolean; now?: Date } = {},
): Promise<OwnerChannel> {
  try {
    const now = opts.now ?? new Date();
    const db = createServerClient();
    const marker = opts.key ? `owner_alert:${opts.key}` : null;
    if (marker && (opts.everyMs || opts.perDay)) {
      const last = (await setting(marker)) as { at?: string } | null | undefined;
      if (last?.at && opts.everyMs && now.getTime() - Date.parse(last.at) < opts.everyMs) return "held";
      if (last?.at && opts.perDay && last.at.slice(0, 10) === now.toISOString().slice(0, 10)) return "held";
    }
    const phone = await ownerWhatsApp().catch(() => null);
    const inbound = phone ? await lastInboundAt(phone).catch(() => null) : null;
    let channel: OwnerChannel = "none";
    if (phone && inbound != null && now.getTime() - inbound < WINDOW_MS) {
      await sendTextIfConfigured(phone, text);
      channel = "whatsapp";
    } else {
      const sent = await sendEmail({
        to: await ownerEmail(), subject: `PandaWorld: ${subject}`, category: "owner-alert",
        text, html: `<div style="font-family:system-ui,sans-serif;white-space:pre-wrap;line-height:1.5">${escape(text)}</div>`,
      });
      channel = sent.success ? "email" : "none";
    }
    if (marker && channel !== "none") {
      await db.from("app_settings").upsert({ key: marker, value: { at: now.toISOString() }, updated_at: now.toISOString() }, { onConflict: "key" });
    }
    return channel;
  } catch (e) {
    console.warn(`[owner alert] ${subject}: ${(e as Error).message}`);
    return "none";
  }
}
