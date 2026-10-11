/**
 * Every Monday (step 4 of the reliability plan, owner 2026-10-11): the
 * week's warning signs to the owner on WhatsApp, with the test set's latest
 * scores, then this week's test run queued (agent mode; the front door, its
 * backup, only by hand since 2026-10-11). A weekly run that falls behind the last one is sent
 * to the owner when it finishes (lib/evals/assistant-eval.ts alertOnDrop).
 * Called by app/api/worker/assistant-weekly (pg_cron).
 *
 * The runs are skipped on a week nothing in the chat's AI changed (owner,
 * 2026-10-11, the test runs were the biggest AI cost): the same code
 * (AI_FINGERPRINT, hashed at build by next.config.mjs) and the same agent
 * model as the last weekly run, kept in app_settings `assistant_weekly_fingerprint`.
 * Every 4 weeks they run anyway, as Google's models change under one name.
 */

import { createServerClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/whatsapp/app-url";
import { agentModel, assistantModel } from "@/lib/whatsapp/assistant";
import { nudgeEvalWorker, queueWeeklyRuns, type EvalRun } from "@/lib/evals/assistant-eval";
import { signsText, weekOfSigns } from "@/lib/evals/warning-signs";
import { notifyOwner } from "@/lib/ops/notify-owner";

/** The newest finished run of a way and model, as "235/248 (95%) on 11 Oct", or null. */
async function lastScore(pipeline: "agent" | "front_door", model: string): Promise<string | null> {
  const { data } = await createServerClient().from("assistant_eval_runs").select("passed, done, errors, created_at")
    .eq("status", "done").eq("pipeline", pipeline).eq("model", model).order("created_at", { ascending: false }).limit(1);
  const run = ((data ?? []) as Pick<EvalRun, "passed" | "done" | "errors" | "created_at">[])[0];
  if (!run) return null;
  const scored = run.done - run.errors;
  const day = new Date(run.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Accra" });
  return `${run.passed}/${scored} (${scored ? Math.round((run.passed / scored) * 100) : 0}%) on ${day}`;
}

/** The longest the weekly runs are skipped for. */
export const RUN_AT_LEAST_EVERY_MS = 28 * 24 * 60 * 60_000;
const FINGERPRINT_KEY = "assistant_weekly_fingerprint";

/**
 * The last weekly runs' date when nothing in the chat's AI changed since,
 * so this week's can be skipped; null when they should run.
 */
export async function unchangedSince(fingerprint: string | null, now = new Date()): Promise<Date | null> {
  if (!fingerprint) return null;
  const { data } = await createServerClient().from("app_settings").select("value").eq("key", FINGERPRINT_KEY).maybeSingle();
  const last = data?.value as { fingerprint?: string; at?: string } | undefined;
  if (last?.fingerprint !== fingerprint || !last.at) return null;
  const at = new Date(last.at);
  return now.getTime() - at.getTime() < RUN_AT_LEAST_EVERY_MS ? at : null;
}

export async function runWeekly(now = new Date()): Promise<{ sent: boolean; queued: string[]; signs: Record<string, number> }> {
  const { week, before } = await weekOfSigns();
  const [agent, door] = await Promise.all([agentModel(), assistantModel()]);
  const [agentScore, doorScore] = await Promise.all([lastScore("agent", agent), lastScore("front_door", door)]);
  const code = process.env.AI_FINGERPRINT;
  const fingerprint = code ? [code, agent].join("|") : null;
  const since = await unchangedSince(fingerprint, now);
  const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Accra" });
  const text = [
    signsText(week, before, `${appUrl()}/admin/warning-signs`),
    "",
    "Test set, latest runs:",
    `• Agent mode (${agent}): ${agentScore ?? "no run yet"}`,
    `• Front door (${door}): ${doorScore ?? "no run yet"}`,
    since
      ? `Nothing in the chat's AI changed since the run on ${day(since)}, so none this week (it runs by ${day(new Date(since.getTime() + RUN_AT_LEAST_EVERY_MS))} at the latest).`
      : "This week's run of agent mode starts now; I'll tell you if it does worse than its last.",
  ].join("\n");
  // WhatsApp, or email on a week they haven't written to the bot (lib/ops/notify-owner.ts).
  const channel = await notifyOwner("weekly report", text);
  let queued: string[] = [];
  if (!since) {
    queued = await queueWeeklyRuns();
    await nudgeEvalWorker();
    if (fingerprint) {
      await createServerClient().from("app_settings").upsert(
        { key: FINGERPRINT_KEY, value: { fingerprint, at: now.toISOString() }, updated_at: now.toISOString() }, { onConflict: "key" });
    }
  }
  return { sent: channel === "whatsapp" || channel === "email", queued, signs: week.counts };
}
