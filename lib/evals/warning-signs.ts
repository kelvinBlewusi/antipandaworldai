/**
 * The weekly look at the warning signs (step 4 of the reliability plan,
 * owner 2026-10-11): where the chat may have misunderstood a seller, from
 * its own logs (whatsapp_assistant_log, whatsapp_message_log). Each one
 * found is a candidate test case (lib/evals/assistant-cases.ts): a misread
 * becomes a case with its right answer, never a word rule.
 *
 * The signs:
 *   - not_understood: a message read and nothing done (outcome "default");
 *   - fell_back: agent mode failed or found nothing to do, and the front
 *     door read it;
 *   - restart: "start over / list new products?" offered;
 *   - said_no: a "No" tapped on a change the chat offered;
 *   - repeated: a seller sending much the same message again within a
 *     minute;
 *   - overridden: the chat's checks turned the AI's choice into something
 *     else (a question back, another action);
 *   - blocked: a reply that said PandaWorld can't, stopped before sending;
 *   - failed: the AI couldn't be reached in time;
 *   - wished: something PandaWorld doesn't do yet (the wish list).
 *
 * Sent to the owner on WhatsApp every Monday with the week's test runs
 * (app/api/worker/assistant-weekly), and shown on /admin/warning-signs.
 */

import { createServerClient } from "@/lib/supabase/server";
import { checkAccount } from "@/lib/jumia/api-checks";

export type SignKind = "not_understood" | "fell_back" | "restart" | "said_no" | "repeated" | "overridden" | "blocked" | "failed" | "wished";

export const SIGN_KINDS: SignKind[] = ["not_understood", "fell_back", "restart", "said_no", "repeated", "overridden", "blocked", "failed", "wished"];

/** What each sign means, for the report. */
export const SIGN_NAMES: Record<SignKind, string> = {
  not_understood: "Read, nothing done",
  fell_back:      "Agent mode needed the front door",
  restart:        "Restart offered",
  said_no:        "\"No\" tapped on an offered change",
  repeated:       "Same message again within a minute",
  overridden:     "Checks changed the AI's choice",
  blocked:        "A \"can't\" reply stopped",
  failed:         "AI not reached in time",
  wished:         "Asked for what isn't built (wish list)",
};

export interface TurnRow {
  created_at: string; user_id: string | null; stage: string | null; message: string | null;
  action: { type?: string } | null; outcome: string | null; raw: string | null;
}
export interface MessageRow { created_at: string; phone_number: string; direction: string; message_type: string | null; body_text: string | null }

export interface Sign { kind: SignKind; at: string; who: string; message: string; detail: string }

export interface SignsSummary {
  turns: number;
  sellers: number;
  counts: Record<SignKind, number>;
  /** Agent mode's reading time, median and slowest tenth, in seconds (from `raw`). */
  agentSeconds: { median: number; p90: number } | null;
  signs: Sign[];
}

// ─── Reading the logs ────────────────────────────────────────────────────────

/** What the AI chose before the chat's checks, from a turn's `raw`: agent mode's first action tool, or the front door's last reading. */
export function aiChoice(raw: string | null): string | null {
  if (!raw) return null;
  const door = raw.indexOf("[front door]");
  if (door >= 0) {
    const reads = Array.from(raw.slice(door).matchAll(/→\s*\[?\{"type":"([a-z_]+)"/g));
    return reads.length ? reads[reads.length - 1][1] : null;
  }
  if (raw.startsWith("[agent ")) {
    const tools = Array.from(raw.matchAll(/\b([a-z_]+)\(\{/g)).map((m) => m[1]).filter((n) => n !== "find_products");
    return tools[0] ?? null;
  }
  return null;
}

/** The AI's choice and what the checks made of it are the same thing in other words. */
const SAME: Record<string, string[]> = {
  step: ["note"], note: ["note"], capability: ["reply", "not_yet"], cannot: ["reply", "not_yet"],
  // A reply that said it can't is counted as blocked.
  reply: ["not_yet"],
  clarify: ["clarify"],
};

const TAP_RE = /^[a-z_]+:\S+$/i;
const NO_TAP_RE = /^(lchgno|lgrpno|whno):/;
const NOT_WORD = new RegExp("[^\\p{L}\\p{N}]+", "u");
const words = (t: string) => new Set(t.toLowerCase().split(NOT_WORD).filter((w) => w.length >= 2));

/** Two messages that say much the same: half or more of their words shared, or one inside the other. Pure. */
export function sameRequest(a: string, b: string): boolean {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  const wa = words(x);
  const wb = words(y);
  if (wa.size < 2 || wb.size < 2) return false;
  if (x.includes(y) || y.includes(x)) return true;
  const shared = Array.from(wa).filter((w) => wb.has(w)).length;
  return shared / new Set([...Array.from(wa), ...Array.from(wb)]).size >= 0.5;
}

const quantile = (xs: number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

/** The warning signs in a week's turns and messages. Pure. */
export function warningSigns(turns: TurnRow[], messages: MessageRow[]): SignsSummary {
  const signs: Sign[] = [];
  const add = (kind: SignKind, at: string, who: string, message: string, detail: string) =>
    signs.push({ kind, at, who, message: message.slice(0, 300), detail: detail.slice(0, 300) });
  const seconds: number[] = [];

  for (const t of turns) {
    const outcome = t.outcome ?? "";
    const raw = t.raw ?? "";
    const who = t.user_id ?? "?";
    const msg = t.message ?? "";
    const type = t.action?.type ?? null;
    const timed = raw.match(/^\[agent [^\]]+\] (\d+(?:\.\d+)?)s/);
    if (timed) seconds.push(Number(timed[1]));
    if (outcome === "default") add("not_understood", t.created_at, who, msg, `${type ?? "no action"} (${t.stage ?? "?"})`);
    if (/^\[agent (failed|found nothing to do)/.test(raw)) add("fell_back", t.created_at, who, msg, raw.slice(0, 160));
    if (outcome.startsWith("offered restart")) add("restart", t.created_at, who, msg, `stage ${t.stage ?? "?"}`);
    if (outcome.startsWith("failed")) add("failed", t.created_at, who, msg, outcome);
    if (outcome.includes("(its reply said it can't)") || raw.includes("(said it can't: not sent)")) add("blocked", t.created_at, who, msg, outcome);
    if (outcome.startsWith("not yet:")) add("wished", t.created_at, who, msg, outcome.slice(9));
    const chose = aiChoice(raw);
    if (chose && type && chose !== type && !(SAME[chose] ?? []).includes(type)) {
      add("overridden", t.created_at, who, msg, `AI: ${chose} → ${type}${outcome ? ` (${outcome.slice(0, 80)})` : ""}`);
    }
  }

  // Messages, phone by phone, oldest first.
  const byPhone = new Map<string, MessageRow[]>();
  for (const m of messages) byPhone.set(m.phone_number, [...(byPhone.get(m.phone_number) ?? []), m]);
  for (const [phone, rows] of Array.from(byPhone.entries())) {
    rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
    let lastIn: MessageRow | null = null;
    let lastOut: MessageRow | null = null;
    for (const m of rows) {
      const body = (m.body_text ?? "").trim();
      if (m.direction !== "inbound") { lastOut = m; continue; }
      if (NO_TAP_RE.test(body)) add("said_no", m.created_at, phone, (lastOut?.body_text ?? "").replace(/\s+/g, " "), "tapped No");
      if (body && !TAP_RE.test(body) && !/^\d+$/.test(body)) {
        if (lastIn && Date.parse(m.created_at) - Date.parse(lastIn.created_at) <= 60_000 && sameRequest(lastIn.body_text ?? "", body)) {
          add("repeated", m.created_at, phone, body, `after "${(lastIn.body_text ?? "").replace(/\s+/g, " ").slice(0, 120)}"`);
        }
        lastIn = m;
      }
    }
  }

  const counts = Object.fromEntries(SIGN_KINDS.map((k) => [k, signs.filter((s) => s.kind === k).length])) as Record<SignKind, number>;
  return {
    turns: turns.length,
    sellers: new Set(turns.map((t) => t.user_id).filter(Boolean)).size,
    counts,
    agentSeconds: seconds.length ? { median: quantile(seconds, 0.5), p90: quantile(seconds, 0.9) } : null,
    signs: signs.sort((a, b) => b.at.localeCompare(a.at)),
  };
}

// ─── A week ──────────────────────────────────────────────────────────────────

async function allRows<T>(query: (from: number, to: number) => PromiseLike<{ data: unknown[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < 20_000; from += 1000) {
    const { data } = await query(from, from + 999);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < 1000) break;
  }
  return out;
}

/** The warning signs between two times (the last 7 days unless given). */
export async function signsBetween(from: Date, to: Date = new Date()): Promise<SignsSummary> {
  const db = createServerClient();
  const [turns, messages] = await Promise.all([
    allRows<TurnRow>((a, b) => db.from("whatsapp_assistant_log").select("created_at, user_id, stage, message, action, outcome, raw")
      .gte("created_at", from.toISOString()).lt("created_at", to.toISOString()).order("created_at", { ascending: true }).range(a, b)),
    allRows<MessageRow>((a, b) => db.from("whatsapp_message_log").select("created_at, phone_number, direction, message_type, body_text")
      .gte("created_at", from.toISOString()).lt("created_at", to.toISOString()).order("created_at", { ascending: true }).range(a, b)),
  ]);
  return warningSigns(turns, messages);
}

const DAY = 86_400_000;

/** This week's signs and last week's, for the report. */
export async function weekOfSigns(now = new Date()): Promise<{ week: SignsSummary; before: SignsSummary }> {
  const start = new Date(now.getTime() - 7 * DAY);
  const [week, before] = await Promise.all([signsBetween(start, now), signsBetween(new Date(start.getTime() - 7 * DAY), start)]);
  return { week, before };
}

/** The week's report as a WhatsApp message. Pure. */
export function signsText(week: SignsSummary, before: SignsSummary, link: string): string {
  const change = (k: SignKind) => {
    const d = week.counts[k] - before.counts[k];
    return d === 0 ? "" : ` (${d > 0 ? "+" : ""}${d})`;
  };
  return [
    `📋 *The chat's week*: ${week.turns} message${week.turns === 1 ? "" : "s"} read from ${week.sellers} seller${week.sellers === 1 ? "" : "s"} (last week ${before.turns}).`,
    ...(week.agentSeconds ? [`Agent mode took ${week.agentSeconds.median.toFixed(1)} s (slowest tenth ${week.agentSeconds.p90.toFixed(1)} s).`] : []),
    "",
    "Warning signs (change on last week):",
    ...SIGN_KINDS.map((k) => `• ${SIGN_NAMES[k]}: ${week.counts[k]}${change(k)}`),
    "",
    `Each one to look at, with the message: ${link}`,
  ].join("\n");
}

/** The owner's WhatsApp number: the account the daily Jumia checks run as (lib/jumia/api-checks.ts). Null when it has none. */
export async function ownerWhatsApp(): Promise<string | null> {
  const userId = await checkAccount();
  if (!userId) return null;
  const { data } = await createServerClient().from("whatsapp_connections").select("phone_number").eq("user_id", userId).limit(1);
  return ((data ?? [])[0] as { phone_number: string } | undefined)?.phone_number ?? null;
}
