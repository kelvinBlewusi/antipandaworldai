/**
 * Warnings before the AI money runs away (owner, 2026-10-11: "what is left
 * to do to leave the system on autopilot"). Read by the hourly health check
 * (app/api/cron/health-check), which sends them with notifyOwner, once a day
 * each:
 *
 *   - turns: the day's AI turns at 80% of the ceiling (app_settings
 *     `assistant_daily_limit`), before the assistant rests for everyone.
 *   - spend: what sellers' AI cost today (ai_usage, everything but the test
 *     set) over app_settings `ai_daily_budget_usd` (DEFAULT_DAILY_BUDGET_USD).
 *     A normal day is under $1 (2026-10-11: $0.15 to $0.55).
 *   - tests: the test set's runs today over `ai_test_budget_usd`
 *     (DEFAULT_TEST_BUDGET_USD). One full run is about $1; 2026-10-11's
 *     25 runs (comparing models) cost $22.
 *
 * Nothing is stopped here: the ceiling does that. These only say it's coming.
 */

import { createServerClient } from "@/lib/supabase/server";
import { DEFAULT_DAILY_CEILING } from "@/lib/whatsapp/assistant-limits";

export const DEFAULT_DAILY_BUDGET_USD = 5;
export const DEFAULT_TEST_BUDGET_USD = 10;
/** The share of the ceiling that warns. */
export const TURNS_WARN_AT = 0.8;

export interface BudgetWarning { key: "turns" | "spend" | "tests"; text: string }

const PAGE = 1000;

async function setting(key: string): Promise<unknown> {
  const { data } = await createServerClient().from("app_settings").select("value").eq("key", key).maybeSingle();
  return data?.value;
}

const positive = (v: unknown, fallback: number) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);

/** Today's logged AI cost (UTC), sellers' and the test set's apart. Paged: Supabase returns 1,000 rows at most. */
export async function spendSince(since: string): Promise<{ sellers: number; tests: number }> {
  const db = createServerClient();
  const out = { sellers: 0, tests: 0 };
  for (let page = 0; page < 100; page++) {
    const { data, error } = await db.from("ai_usage").select("feature, cost_usd").gte("created_at", since)
      .order("created_at", { ascending: true }).range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`Couldn't read ai_usage: ${error.message}`);
    const rows = (data ?? []) as { feature: string; cost_usd: number | null }[];
    for (const r of rows) out[r.feature === "assistant_eval" ? "tests" : "sellers"] += Number(r.cost_usd) || 0;
    if (rows.length < PAGE) break;
  }
  return out;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

export async function budgetWarnings(now = new Date()): Promise<BudgetWarning[]> {
  const db = createServerClient();
  const midnight = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
  const [limit, budget, testBudget, turnsRes, spend] = await Promise.all([
    setting("assistant_daily_limit"), setting("ai_daily_budget_usd"), setting("ai_test_budget_usd"),
    db.from("whatsapp_assistant_log").select("id", { count: "exact", head: true }).gt("created_at", midnight).not("raw", "is", null),
    spendSince(midnight),
  ]);
  const out: BudgetWarning[] = [];
  const ceiling = positive(limit, DEFAULT_DAILY_CEILING);
  const turns = turnsRes.count ?? 0;
  if (turns >= ceiling * TURNS_WARN_AT) {
    out.push({
      key: "turns",
      text: `The chat has used ${turns.toLocaleString("en-US")} of today's ${ceiling.toLocaleString("en-US")} AI turns. ` +
        "At the limit it stops answering questions for every seller (commands still work) until midnight UTC. " +
        "If this is real use, raise assistant_daily_limit; if not, look for a seller or loop sending a flood.",
    });
  }
  const daily = positive(budget, DEFAULT_DAILY_BUDGET_USD);
  if (spend.sellers > daily) {
    out.push({
      key: "spend",
      text: `Sellers' AI cost today is ${usd(spend.sellers)}, over the ${usd(daily)} daily budget (a normal day is under $1). ` +
        "See /admin/billing for which feature it is. The budget is ai_daily_budget_usd in app_settings.",
    });
  }
  const tests = positive(testBudget, DEFAULT_TEST_BUDGET_USD);
  if (spend.tests > tests) {
    out.push({
      key: "tests",
      text: `The chat's test runs cost ${usd(spend.tests)} today, over the ${usd(tests)} budget for tests ` +
        "(a full run is about $1). Check /admin/assistant-tests for runs queued again and again.",
    });
  }
  return out;
}
