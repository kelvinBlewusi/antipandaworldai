/**
 * Telling the owner while they're away (owner, 2026-10-11: "what is left to
 * do to leave the system on autopilot"): their WhatsApp inside its 24 hours,
 * else email (lib/ops/notify-owner.ts), and the AI budget warnings the
 * hourly health check sends (lib/ops/budget-guard.ts).
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
const sent: { to: string; body: string }[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured: async (to: string, body: string) => { sent.push({ to, body }); },
}));
const emails: { to: string | string[]; subject: string; text?: string }[] = [];
let emailWorks = true;
jest.mock("@/lib/email/send", () => ({
  sendEmail: async (o: { to: string | string[]; subject: string; text?: string }) => {
    emails.push(o);
    return emailWorks ? { success: true } : { success: false, error: "no key" };
  },
}));

import { notifyOwner } from "@/lib/ops/notify-owner";
import { budgetWarnings, spendSince } from "@/lib/ops/budget-guard";

const NOW = new Date("2026-10-11T15:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

beforeEach(() => {
  db = new FakeDb();
  sent.length = 0;
  emails.length = 0;
  emailWorks = true;
  db.tables.app_settings = [{ key: "api_check_user", value: "owner" }];
  db.tables.whatsapp_connections = [{ user_id: "owner", phone_number: "233200000000" }];
  db.tables.whatsapp_message_log = [];
  db.tables.whatsapp_assistant_log = [];
  db.tables.ai_usage = [];
});

describe("notifyOwner", () => {
  it("uses WhatsApp when the owner wrote to the bot within its 24 hours", async () => {
    db.tables.whatsapp_message_log = [{ created_at: hoursAgo(2), phone_number: "233200000000", direction: "inbound" }];
    expect(await notifyOwner("x", "hello", { now: NOW })).toBe("whatsapp");
    expect(sent).toEqual([{ to: "233200000000", body: "hello" }]);
    expect(emails).toHaveLength(0);
  });

  it("emails outside it, to owner_alert_email when set", async () => {
    db.tables.whatsapp_message_log = [{ created_at: hoursAgo(30), phone_number: "233200000000", direction: "inbound" }];
    db.tables.app_settings.push({ key: "owner_alert_email", value: "me@example.com" });
    expect(await notifyOwner("something is stuck", "a < b", { now: NOW })).toBe("email");
    expect(sent).toHaveLength(0);
    expect(emails[0]).toMatchObject({ to: ["me@example.com"], subject: "PandaWorld: something is stuck", text: "a < b" });
  });

  it("without owner_alert_email, both support inboxes get it", async () => {
    expect(await notifyOwner("x", "y", { now: NOW })).toBe("email");
    expect(emails[0].to).toEqual(["help@pandaworldai.site", "help.pandaworldai@gmail.com"]);
  });

  it("says none when the email can't go either", async () => {
    emailWorks = false;
    expect(await notifyOwner("x", "y", { key: "k", everyMs: 60_000, now: NOW })).toBe("none");
    // Not marked as told, so the next hour tries again.
    expect(db.tables.app_settings.find((r) => r.key === "owner_alert:k")).toBeUndefined();
  });

  it("holds the same alert inside everyMs", async () => {
    expect(await notifyOwner("x", "y", { key: "health", everyMs: 6 * 3_600_000, now: NOW })).toBe("email");
    expect(await notifyOwner("x", "y", { key: "health", everyMs: 6 * 3_600_000, now: new Date(NOW.getTime() + 3_600_000) })).toBe("held");
    expect(await notifyOwner("x", "y", { key: "health", everyMs: 6 * 3_600_000, now: new Date(NOW.getTime() + 7 * 3_600_000) })).toBe("email");
  });

  it("perDay: once a UTC day", async () => {
    expect(await notifyOwner("x", "y", { key: "budget:spend", perDay: true, now: NOW })).toBe("email");
    expect(await notifyOwner("x", "y", { key: "budget:spend", perDay: true, now: new Date("2026-10-11T23:30:00Z") })).toBe("held");
    expect(await notifyOwner("x", "y", { key: "budget:spend", perDay: true, now: new Date("2026-10-12T00:10:00Z") })).toBe("email");
  });
});

describe("budgetWarnings", () => {
  const turns = (n: number, at = hoursAgo(1)) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, created_at: at, raw: "{}" }));

  it("is quiet on a normal day", async () => {
    db.tables.whatsapp_assistant_log = turns(100);
    db.tables.ai_usage = [{ created_at: hoursAgo(1), feature: "assistant", cost_usd: 0.4 }, { created_at: hoursAgo(1), feature: "assistant_eval", cost_usd: 3 }];
    expect(await budgetWarnings(NOW)).toEqual([]);
  });

  it("warns at 80% of the day's AI turns, counting only today's turns the AI answered", async () => {
    db.tables.app_settings.push({ key: "assistant_daily_limit", value: 100 });
    db.tables.whatsapp_assistant_log = [...turns(79), ...turns(30, hoursAgo(20)), { id: "tap", created_at: hoursAgo(1), raw: null }];
    expect(await budgetWarnings(NOW)).toEqual([]);
    db.tables.whatsapp_assistant_log.push(...turns(1));
    const w = await budgetWarnings(NOW);
    expect(w.map((x) => x.key)).toEqual(["turns"]);
    expect(w[0].text).toContain("80 of today's 100 AI turns");
  });

  it("warns when sellers' spend or the test runs' spend pass their budgets", async () => {
    db.tables.app_settings.push({ key: "ai_daily_budget_usd", value: 1 }, { key: "ai_test_budget_usd", value: 2 });
    db.tables.ai_usage = [
      { created_at: hoursAgo(1), feature: "assistant", cost_usd: 0.7 },
      { created_at: hoursAgo(2), feature: "listing_draft", cost_usd: 0.5 },
      { created_at: hoursAgo(20), feature: "assistant", cost_usd: 50 },
      { created_at: hoursAgo(1), feature: "assistant_eval", cost_usd: 2.5 },
      { created_at: hoursAgo(1), feature: "other", cost_usd: null },
    ];
    const w = await budgetWarnings(NOW);
    expect(w.map((x) => x.key)).toEqual(["spend", "tests"]);
    expect(w[0].text).toContain("$1.20, over the $1.00 daily budget");
    expect(w[1].text).toContain("$2.50 today, over the $2.00 budget");
  });

  it("reads past Supabase's 1,000-row page", async () => {
    db.tables.ai_usage = Array.from({ length: 2500 }, () => ({ created_at: hoursAgo(1), feature: "assistant_eval", cost_usd: 0.01 }));
    expect((await spendSince("2026-10-11T00:00:00.000Z")).tests).toBeCloseTo(25, 6);
  });
});
