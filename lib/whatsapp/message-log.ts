/**
 * Logs every WhatsApp message — inbound and outbound — to
 * whatsapp_message_log, so a real conversation can be reviewed later
 * instead of only existing on the seller's phone. Closes a gap hit
 * repeatedly live: neither the app nor Vercel's runtime logs kept a
 * queryable record of what was actually said, and Vercel's own logs are
 * ephemeral, rate-limited, and never captured message bodies at all.
 *
 * Both log functions are fire-and-forget and swallow their own errors —
 * a logging hiccup must never slow down or break an actual send/receive,
 * the same rule deductCredits follows elsewhere in this codebase.
 */

import { createServerClient } from "@/lib/supabase/server";

interface LogFields {
  phoneNumber: string;
  direction:   "inbound" | "outbound";
  messageType: string;
  bodyText?:   string | null;
  wamid?:      string | null;
  payload?:    Record<string, unknown> | null;
}

async function insertLog(fields: LogFields): Promise<void> {
  try {
    const db = createServerClient();
    const { error } = await db.from("whatsapp_message_log").insert({
      phone_number: fields.phoneNumber,
      direction:    fields.direction,
      message_type: fields.messageType,
      body_text:    fields.bodyText ?? null,
      wamid:        fields.wamid ?? null,
      payload:      fields.payload ?? null,
    });
    if (error) console.warn(`[whatsapp] message log insert failed: ${error.message}`);
  } catch (e) {
    console.warn(`[whatsapp] message log insert threw: ${(e as Error).message}`);
  }
}

/**
 * Whether `phoneNumber` was sent a message containing `text` in the last
 * `withinMs` — for a reply that should go out once, not on every message
 * (the walkthrough video to a number that isn't linked). Answers false on
 * any error, so the message is sent again rather than never.
 */
export async function sentRecently(phoneNumber: string, text: string, withinMs: number): Promise<boolean> {
  try {
    const db = createServerClient();
    const { data, error } = await db
      .from("whatsapp_message_log")
      .select("id")
      .eq("phone_number", phoneNumber)
      .eq("direction", "outbound")
      .like("body_text", `%${text}%`)
      .gt("created_at", new Date(Date.now() - withinMs).toISOString())
      .limit(1);
    if (error) {
      console.warn(`[whatsapp] message log lookup failed: ${error.message}`);
      return false;
    }
    return (data?.length ?? 0) > 0;
  } catch (e) {
    console.warn(`[whatsapp] message log lookup threw: ${(e as Error).message}`);
    return false;
  }
}

/** Log an inbound message — call with the same normalized shape
 *  contentOf() already produces, so the webhook route doesn't need to
 *  re-derive anything just to log it. */
export function logInboundMessage(
  phoneNumber: string,
  wamid:       string,
  messageType: string,
  bodyText:    string | null,
  payload?:    Record<string, unknown>,
): void {
  void insertLog({ phoneNumber, direction: "inbound", messageType, bodyText, wamid, payload });
}

/**
 * Pure extraction: what callGraphApi's `body` (the exact object about to
 * be POSTed to the Graph API) says about the message being sent, or null
 * for the mark-read/typing-indicator call (`status: "read"`), which
 * carries no message content of its own. Split out from
 * logOutboundMessage so the branching per Graph API message shape
 * (text/image/button/list/cta_url) has a return value a test can assert on,
 * rather than only being reachable through a fire-and-forget DB insert.
 */
export function describeOutboundMessage(
  to:   string,
  body: Record<string, unknown>,
): Omit<LogFields, "wamid"> | null {
  if (body.status === "read") return null;

  const type = body.type as string | undefined;
  if (type === "text") {
    const text = (body.text as { body?: string } | undefined)?.body;
    // An answer laid out for the Listing Assistant's page (lib/whatsapp/rich.ts).
    const rich = body.rich && typeof body.rich === "object" ? body.rich : null;
    return { phoneNumber: to, direction: "outbound", messageType: "text", bodyText: text ?? null, ...(rich ? { payload: { rich } } : {}) };
  }

  if (type === "image") {
    const image = body.image as { link?: string; caption?: string; album?: string[] } | undefined;
    return {
      phoneNumber: to, direction: "outbound", messageType: "image", bodyText: image?.caption ?? null,
      payload: { link: image?.link, ...(Array.isArray(image?.album) && image.album.length > 1 ? { links: image.album } : {}) },
    };
  }

  if (type === "interactive") {
    const interactive = body.interactive as {
      type?:   string;
      body?:   { text?: string };
      action?: {
        buttons?:  { reply?: { id?: string; title?: string } }[];
        button?:   string;
        sections?: { rows?: { id?: string; title?: string; description?: string }[] }[];
        name?:     string;
        parameters?: { display_text?: string; url?: string };
      };
    } | undefined;
    const bodyText = interactive?.body?.text ?? null;
    const kind = interactive?.type;

    if (kind === "button") {
      const buttons = (interactive?.action?.buttons ?? []).map((b) => b.reply);
      return { phoneNumber: to, direction: "outbound", messageType: "button", bodyText, payload: { buttons } };
    }
    if (kind === "list") {
      const rows = interactive?.action?.sections?.[0]?.rows ?? [];
      return { phoneNumber: to, direction: "outbound", messageType: "list", bodyText, payload: { buttonText: interactive?.action?.button, rows } };
    }
    if (kind === "cta_url") {
      const params = interactive?.action?.parameters;
      return { phoneNumber: to, direction: "outbound", messageType: "cta_url", bodyText, payload: { buttonText: params?.display_text, url: params?.url } };
    }
  }

  return null;
}

/**
 * Log an outbound message from the exact body callGraphApi is about to
 * POST to the Graph API — one call site covers every send helper in
 * client.ts (text, image, buttons, list, cta_url) with no per-caller wiring.
 */
export function logOutboundMessage(to: string, body: Record<string, unknown>, shown?: Record<string, unknown> | null): void {
  const fields = withShown(describeOutboundMessage(to, body), to, shown);
  if (fields) void insertLog(fields);
}

/**
 * The message as the seller got it, in their language (lib/i18n/bot.ts), kept
 * beside the English as payload.shown: its words, and its buttons, rows, link
 * words or tables. The web chat shows it (lib/whatsapp/listing-assistant.ts).
 */
function withShown(fields: Omit<LogFields, "wamid"> | null, to: string, shown?: Record<string, unknown> | null): Omit<LogFields, "wamid"> | null {
  if (!fields || !shown) return fields;
  const s = describeOutboundMessage(to, shown);
  if (!s) return fields;
  return { ...fields, payload: { ...(fields.payload ?? {}), shown: { text: s.bodyText ?? null, ...(s.payload ?? {}) } } };
}

/**
 * The same record, awaited: for the Listing Assistant (lib/whatsapp/
 * channel.ts) the record IS the delivery, read back by its page, so it must
 * be written, and in order, before the next message.
 */
export async function recordOutboundMessage(to: string, body: Record<string, unknown>, shown?: Record<string, unknown> | null): Promise<void> {
  const fields = withShown(describeOutboundMessage(to, body), to, shown);
  if (fields) await insertLog(fields);
}

/** An inbound message from the Listing Assistant's page, awaited (see recordOutboundMessage). */
export async function recordInboundMessage(
  address: string, id: string, messageType: string, bodyText: string | null, payload?: Record<string, unknown>,
): Promise<void> {
  await insertLog({ phoneNumber: address, direction: "inbound", messageType, bodyText, wamid: id, payload: payload ?? null });
}

/** The bot's last message here, when it's the newest row or just before this message. */
export async function lastBotMessage(phoneNumber: string): Promise<{ type: string | null; body: string } | null> {
  try {
    const { data } = await createServerClient()
      .from("whatsapp_message_log")
      .select("direction, message_type, body_text")
      .eq("phone_number", phoneNumber)
      .order("created_at", { ascending: false })
      .limit(2);
    const rows = (data ?? []) as { direction: string; message_type: string | null; body_text: string | null }[];
    // The newest row can be this very message, logged as it arrived.
    const bot = rows[0]?.direction === "outbound" ? rows[0] : rows[0]?.direction === "inbound" ? rows[1] : undefined;
    return bot && bot.direction === "outbound" ? { type: bot.message_type, body: (bot.body_text ?? "").trim() } : null;
  } catch {
    return null;
  }
}
