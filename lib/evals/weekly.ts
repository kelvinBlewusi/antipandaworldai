/**
 * Every Monday (step 4 of the reliability plan, owner 2026-10-11): the
 * week's warning signs to the owner on WhatsApp, with the test set's latest
 * scores, then this week's test runs queued (agent mode and the front door,
 * one after the other). A weekly run that falls behind the last one is sent
 * to the owner when it finishes (lib/evals/assistant-eval.ts alertOnDrop).
 * Called by app/api/worker/assistant-weekly (pg_cron).
 */

import { createServerClient } from "@/lib/supabase/server";
import { sendTextIfConfigured } from "@/lib/whatsapp/client";
import { appUrl } from "@/lib/whatsapp/app-url";
import { agentModel, assistantModel } from "@/lib/whatsapp/assistant";
import { nudgeEvalWorker, queueWeeklyRuns, type EvalRun } from "@/lib/evals/assistant-eval";
import { ownerWhatsApp, signsText, weekOfSigns } from "@/lib/evals/warning-signs";

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

export async function runWeekly(): Promise<{ sent: boolean; queued: string[]; signs: Record<string, number> }> {
  const { week, before } = await weekOfSigns();
  const [agent, door] = await Promise.all([agentModel(), assistantModel()]);
  const [agentScore, doorScore] = await Promise.all([lastScore("agent", agent), lastScore("front_door", door)]);
  const text = [
    signsText(week, before, `${appUrl()}/admin/warning-signs`),
    "",
    "Test set, latest runs:",
    `• Agent mode (${agent}): ${agentScore ?? "no run yet"}`,
    `• Front door (${door}): ${doorScore ?? "no run yet"}`,
    "This week's runs start now; I'll tell you if either does worse than its last.",
  ].join("\n");
  const phone = await ownerWhatsApp();
  if (phone) await sendTextIfConfigured(phone, text).catch(() => undefined);
  const queued = await queueWeeklyRuns();
  await nudgeEvalWorker();
  return { sent: !!phone, queued, signs: week.counts };
}
