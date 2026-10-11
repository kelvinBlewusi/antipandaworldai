/**
 * Runs the assistant's test set (lib/evals/assistant-cases.ts) against the
 * real AI (owner, 2026-10-08: "how do we make sure that the next solution we
 * offer for the problem does not conflict the past solution we gave").
 *
 * Each case goes through what production does with a message, with the
 * case's stage, conversation, drafts and the list just shown, and the
 * action that comes out is compared with the case's acceptable answers.
 * Two ways, as the chat reads messages since 11 Oct:
 *
 *   - agent mode (lib/assistant-v2/agent.ts: one call with every action as
 *     a tool, lookups of the case's catalog, up to three actions), the main
 *     reader. It passes when every action it takes is one of the case's
 *     answers; "bare" counts it when any one is.
 *   - the front door (lib/assistant-v2/front-door.ts: route to an area,
 *     then read within it, and ask back rather than guess), agent mode's
 *     automatic backup.
 *
 * Questions back are counted apart ("asked"): not wrong, but a tap more.
 * Runs of the old one-call reader (pipeline "current", gone with its word
 * rules on 11 Oct) stay in the table for comparison.
 *
 * Runs are rows in assistant_eval_runs, worked through by
 * app/api/worker/assistant-eval (pg_cron each minute while one is queued,
 * and nudged when one is queued from /admin/assistant-tests). Nothing a
 * seller sees changes, and no seller's credits or allowance are used: the
 * calls count as the "assistant_eval" feature.
 */

import { createServerClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/whatsapp/app-url";
import {
  agentModel, assistantLinks, assistantModel, routerModel, type ProductFacts,
} from "@/lib/whatsapp/assistant";
import { notifyOwner } from "@/lib/ops/notify-owner";
import { ASSISTANT_CASES, type EvalCase, type Shape } from "@/lib/evals/assistant-cases";
import { frontDoor, type FrontDoorInput } from "@/lib/assistant-v2/front-door";
import { agentRead, agentSystem, catalogLookups, geminiAgentCall, type AgentLookups } from "@/lib/assistant-v2/agent";
import { findProducts, fromRow } from "@/lib/jumia/shop";
import type { ListingRow } from "@/lib/supabase/types";

/** What the AI is told about the seller: the shape sellerFacts gives, for a Standard seller in Ghana. */
const SELLER = [
  "- Country: Ghana",
  "- Their Jumia shop: GEM MALL",
  "- WhatsApp: linked",
  "- Jumia: connected (GEM MALL)",
  "- Pack: Standard (the last one they bought)",
  "- The chat's shop features (products, orders, reports, payouts, fees): on",
  "- Changes to live Jumia products from the chat: on",
  "- Jumia QC rejection alerts and guided fixes: on",
  "- Shipping label PDFs on WhatsApp: on",
  "- Order alerts on WhatsApp (new orders, order updates, payouts): on",
  "- Credits: 80 available, enough for about 40 listings",
];

/** Cases asked of the AI at once. */
const PARALLEL = 10;
/** A run is held by one worker for this long at a time (renewed after each group). */
const LOCK_MS = 58_000;
/**
 * The longest one case may take. When Gemini is slow a group used to run
 * past the worker's time limit and be lost, again and again (8 Oct, 15:08
 * to 15:17 UTC): now a case still waiting at this point is recorded as an
 * error (not scored), and a group starts only if it can finish in time.
 */
const CASE_MS = 40_000;

/** "agent": function calling, the main reader. "front_door": sort, then read, its backup. */
export type Pipeline = "front_door" | "agent";
export const PIPELINES: Pipeline[] = ["agent", "front_door"];

export interface CaseResult {
  id: string;
  area: string;
  pass: boolean;
  /** Agent: at least one of its actions right. Old one-call runs: the AI's choice alone, without word rules. */
  bare: boolean;
  /** It asked the seller a question back instead of acting. */
  asked?: boolean;
  /** Front door: the area its first call sent the message to. */
  routed?: string;
  got: string;
  raw: string;
  error?: string;
  ms: number;
}

// ─── Comparing an action with an expected shape ──────────────────────────────

function at(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const key of path.split(".")) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(key) ? cur[Number(key)] : (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : typeof v === "number" ? String(v) : JSON.stringify(v));

function same(got: unknown, want: unknown): boolean {
  if (typeof want === "string" && want.startsWith("~")) {
    if (got == null) return false;
    const text = Array.isArray(got) ? got.join(" ") : typeof got === "object" ? JSON.stringify(got) : String(got);
    return text.toLowerCase().includes(want.slice(1).toLowerCase());
  }
  if (Array.isArray(want)) {
    const list = Array.isArray(got) ? got : got == null ? [] : [got];
    const a = new Set(list.map(norm));
    const b = new Set(want.map(norm));
    return a.size === b.size && Array.from(b).every((x) => a.has(x));
  }
  if (Array.isArray(got)) return got.length === 1 && same(got[0], want);
  if (typeof want === "number") return Number(got) === want;
  return got === want;
}

/** Whether the action is the shape: its type, and every field the shape names. Pure. */
export function matchesShape(action: unknown, shape: Shape): boolean {
  return Object.entries(shape).every(([path, want]) => same(at(action, path), want));
}

/** Whether the action is any of the case's acceptable answers. Pure. */
export const passes = (action: unknown, c: EvalCase) => c.ok.some((shape) => matchesShape(action, shape));

// ─── One case ────────────────────────────────────────────────────────────────

function facts(c: EvalCase): ProductFacts[] {
  return (c.drafts ?? []).map((d, i) => ({
    seq:        i + 1,
    listing:    { id: `draft-${i + 1}`, title: d.title, status: "draft", selling_price: d.price ?? null, quantity: null, category_path: null } as unknown as ListingRow,
    variations: d.variations ?? [],
    options:    d.options ?? [],
  }));
}

/** What the front door makes of the case's message. */
export async function understandFrontDoor(c: EvalCase, models: { router: string; reader: string }) {
  return frontDoor({
    stage: c.stage, message: c.msg, conversation: c.ctx ?? [], drafts: facts(c), listed: c.listed ?? null,
    waitingFor: c.waitingFor, seller: SELLER, links: assistantLinks(), currency: "GHS", web: c.web ?? true, shopNames: c.catalog,
  }, models);
}

/**
 * What agent mode makes of the case's message: its lookups answered from
 * the case's catalog. A product read (product_details) gives its name with
 * the same stand-in details for every product: the run scores what the
 * chat does with them, not the facts.
 */
export async function understandAgent(c: EvalCase, model: string) {
  return agentRead(agentInput(c), geminiAgentCall(model, agentSystem(2), { feature: "assistant_eval" }), caseLookups(c));
}

/** What agent mode is given for the case: its stage, conversation, drafts and the products just listed. */
export function agentInput(c: EvalCase): FrontDoorInput {
  return {
    stage: c.stage, message: c.msg, conversation: c.ctx ?? [], drafts: facts(c), listed: c.listed ?? null,
    waitingFor: c.waitingFor, seller: SELLER, links: assistantLinks(), currency: "GHS", web: c.web ?? true, shopNames: c.catalog, listingCost: 2,
  };
}

/** The case's lookups, from its catalog. */
export function caseLookups(c: EvalCase): AgentLookups {
  const shop = (c.catalog ?? []).map((name, i) => fromRow({ product_sid: `p${i + 1}`, seller_sku: `SKU-${i + 1}`, name }));
  const productDetails = async (words: string) => {
    const hits = findProducts(shop, words, 5);
    if (hits.length !== 1) return hits.map((p) => `- ${p.name} (SKU ${p.sellerSku})`);
    const p = hits[0];
    return [`Name: ${p.name}\nSKU ${p.sellerSku} · ON · approved · price GHS 100 · stock 5\nPhotos: 3 (the main one first)\nDetails: color=Black; material=Plastic; what_is_in_the_box=1 x ${p.name}`];
  };
  return { ...catalogLookups(shop), productDetails };
}

/** Whether agent mode's reading passes the case, as a run scores it. Pure. */
export function scoreAgent(c: EvalCase, read: { actions: unknown[]; clarify: unknown }): { pass: boolean; bare: boolean; asked: boolean } {
  const asked = read.clarify != null;
  const reply = c.ok.some((shape) => shape.type === "reply" && Object.keys(shape).length === 1);
  return {
    pass: asked ? reply : read.actions.every((a) => passes(a, c)),
    bare: asked ? reply : read.actions.some((a) => passes(a, c)),
    asked,
  };
}

const summary = (a: unknown) => JSON.stringify(a).slice(0, 400);

export async function runCase(c: EvalCase, model: string, opts: { pipeline?: Pipeline; router?: string | null } = {}): Promise<CaseResult> {
  const t0 = Date.now();
  let lastError = "";
  // One retry: a timeout isn't the assistant misunderstanding.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (opts.pipeline === "agent") {
        const { actions, clarify, raw } = await understandAgent(c, model);
        const { pass, bare, asked } = scoreAgent(c, { actions, clarify });
        return { id: c.id, area: c.area, pass, bare, asked, got: summary(clarify ?? (actions.length === 1 ? actions[0] : actions)), raw: raw.slice(0, 600), ms: Date.now() - t0 };
      }
      const { area, action, raw } = await understandFrontDoor(c, { router: opts.router || model, reader: model });
      // A question back is a reply with buttons: right where any reply is.
      const asked = action.type === "clarify";
      const pass = asked ? c.ok.some((shape) => shape.type === "reply" && Object.keys(shape).length === 1) : passes(action, c);
      return { id: c.id, area: c.area, pass, bare: pass, asked, routed: area, got: summary(action), raw: raw.slice(0, 600), ms: Date.now() - t0 };
    } catch (e) {
      lastError = (e as Error).message.slice(0, 200);
    }
  }
  return { id: c.id, area: c.area, pass: false, bare: false, got: "", raw: "", error: lastError, ms: Date.now() - t0 };
}

// ─── Runs ────────────────────────────────────────────────────────────────────

export interface EvalRun {
  id: string; created_at: string; status: string; model: string; note: string | null; total: number; done: number;
  passed: number; passed_bare: number; errors: number; results: CaseResult[]; finished_at: string | null;
  /** "current" or none: the old one-call reader (runs before 11 Oct). */
  pipeline?: Pipeline | "current" | null; router_model?: string | null; asked?: number | null;
}

/**
 * Queue a run of the whole set through agent mode (the main reader) or the
 * front door (its backup, whose first call uses `router`, the same model
 * unless named), with the model that way uses unless one is named.
 * Returns its id.
 */
export async function queueRun(opts: { model?: string; note?: string; pipeline?: Pipeline; router?: string } = {}): Promise<string> {
  const pipeline = opts.pipeline ?? "agent";
  const model = opts.model ?? (pipeline === "agent" ? await agentModel() : await assistantModel());
  const { data, error } = await createServerClient()
    .from("assistant_eval_runs")
    .insert({
      model, note: opts.note ?? null, total: ASSISTANT_CASES.length, status: "queued", pipeline,
      router_model: pipeline === "front_door" ? opts.router ?? model : null,
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`couldn't queue a run: ${error?.message ?? "no row"}`);
  return (data as { id: string }).id;
}

/** Start the worker now rather than at pg_cron's next minute. Never throws. */
export async function nudgeEvalWorker(): Promise<void> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  try {
    await fetch(`${appUrl()}/api/worker/assistant-eval`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(2_000) });
  } catch {
    // Timed out (it's working) or unreachable: pg_cron picks it up within the minute.
  }
}

const tally = (results: CaseResult[]) => ({
  done:        results.length,
  passed:      results.filter((r) => r.pass).length,
  passed_bare: results.filter((r) => r.bare).length,
  errors:      results.filter((r) => r.error).length,
  asked:       results.filter((r) => r.asked).length,
});

/**
 * Work on the oldest unfinished run until `budgetMs` is spent: claims it
 * (so two workers never run the same cases), asks PARALLEL cases at a
 * time, saves after each group, and marks it done once every case has a
 * result. Cases removed from the set since it was queued are skipped.
 */
const capped = (c: EvalCase, work: Promise<CaseResult>): Promise<CaseResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<CaseResult>((resolve) => {
    timer = setTimeout(() => resolve({ id: c.id, area: c.area, pass: false, bare: false, got: "", raw: "", error: `no answer within ${CASE_MS / 1000} s`, ms: CASE_MS }), CASE_MS);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
};

export async function workOnRuns(budgetMs = 100_000): Promise<{ runId: string | null; done: number; total: number }> {
  const db = createServerClient();
  const deadline = Date.now() + budgetMs;
  const now = new Date().toISOString();
  // One run at a time, oldest first: two at once (the weekly agent and front
  // door runs) would hit Gemini's per-minute quota together.
  const { data: open } = await db.from("assistant_eval_runs").select("id, locked_until")
    .in("status", ["queued", "running"]).order("created_at", { ascending: true }).limit(1);
  const free = ((open ?? []) as { id: string; locked_until: string | null }[]).find((r) => !r.locked_until || r.locked_until < now);
  if (!free) return { runId: null, done: 0, total: 0 };
  // Claimed only if no other worker took it since it was read.
  const claim = db.from("assistant_eval_runs")
    .update({ status: "running", locked_until: new Date(Date.now() + LOCK_MS).toISOString() })
    .eq("id", free.id);
  const { data: claimed } = await (free.locked_until ? claim.eq("locked_until", free.locked_until) : claim.is("locked_until", null)).select("*");
  const run = ((claimed ?? []) as EvalRun[])[0];
  if (!run) return { runId: null, done: 0, total: 0 };

  const results: CaseResult[] = Array.isArray(run.results) ? [...run.results] : [];
  const done = new Set(results.map((r) => r.id));
  const left = ASSISTANT_CASES.filter((c) => !done.has(c.id));
  while (left.length > 0 && Date.now() + CASE_MS < deadline) {
    const group = left.splice(0, PARALLEL);
    results.push(...(await Promise.all(group.map((c) => capped(c, runCase(c, run.model, { pipeline: run.pipeline === "agent" ? "agent" : "front_door", router: run.router_model }))))));
    await db.from("assistant_eval_runs").update({
      ...tally(results), results, locked_until: new Date(Date.now() + LOCK_MS).toISOString(),
    }).eq("id", run.id);
  }
  const finished = left.length === 0;
  await db.from("assistant_eval_runs").update({
    ...tally(results), results, total: ASSISTANT_CASES.length, locked_until: null,
    ...(finished ? { status: "done", finished_at: new Date().toISOString() } : {}),
  }).eq("id", run.id);
  if (finished && run.note === WEEKLY) await alertOnDrop({ ...run, results });
  return { runId: run.id, done: results.length, total: ASSISTANT_CASES.length };
}

// ─── The weekly run (step 4 of the plan, owner 2026-10-11) ───────────────────

/** The note on the runs app/api/worker/assistant-weekly queues each Monday. */
export const WEEKLY = "weekly";
/** A weekly run this many cases below the last run of the same way and model, on the cases both scored, is sent to the owner. */
export const DROP_ALERT_CASES = 3;

/** The week's runs: agent mode and the front door, each with the model the chat uses. One at a time (workOnRuns). */
export async function queueWeeklyRuns(): Promise<string[]> {
  return [
    await queueRun({ pipeline: "agent", note: WEEKLY }),
    await queueRun({ pipeline: "front_door", router: await routerModel(), note: WEEKLY }),
  ];
}

/** One run against an earlier one, on the cases both scored. Pure. */
export function compareRuns(now: CaseResult[], before: CaseResult[]): { cases: number; passedNow: number; passedBefore: number; newlyWrong: string[]; newlyRight: string[] } {
  const prev = new Map(before.filter((r) => !r.error).map((r) => [r.id, r]));
  const both = now.filter((r) => !r.error && prev.has(r.id));
  return {
    cases:        both.length,
    passedNow:    both.filter((r) => r.pass).length,
    passedBefore: both.filter((r) => prev.get(r.id)!.pass).length,
    newlyWrong:   both.filter((r) => !r.pass && prev.get(r.id)!.pass).map((r) => r.id),
    newlyRight:   both.filter((r) => r.pass && !prev.get(r.id)!.pass).map((r) => r.id),
  };
}

/** The finished run before this one, the same way and model. */
export async function previousRun(run: Pick<EvalRun, "id" | "created_at" | "model" | "pipeline">): Promise<EvalRun | null> {
  const { data } = await createServerClient().from("assistant_eval_runs").select("*")
    .eq("status", "done").eq("model", run.model).eq("pipeline", run.pipeline ?? "front_door")
    .lt("created_at", run.created_at).order("created_at", { ascending: false }).limit(1);
  return ((data ?? []) as EvalRun[])[0] ?? null;
}

/** A weekly run that fell DROP_ALERT_CASES or more below the last one: sent to the owner on WhatsApp. Never throws. */
async function alertOnDrop(run: EvalRun): Promise<void> {
  try {
    const before = await previousRun(run);
    if (!before) return;
    const c = compareRuns(run.results, before.results ?? []);
    if (c.passedBefore - c.passedNow < DROP_ALERT_CASES) return;
    const way = run.pipeline === "agent" ? "agent mode" : "the front door";
    console.error(`[assistant eval] weekly run ${run.id} (${way}, ${run.model}) ${c.passedNow}/${c.cases}, was ${c.passedBefore}: ${c.newlyWrong.join(", ")}`);
    // WhatsApp, or email when they haven't written to the bot in 24 hours (lib/ops/notify-owner.ts).
    await notifyOwner(`test run of ${way} got worse`, [
      `⚠️ This week's test run of ${way} (${run.model}) got ${c.passedNow} of ${c.cases} right, down from ${c.passedBefore} on the same cases.`,
      `Now wrong: ${c.newlyWrong.slice(0, 12).join(", ")}${c.newlyWrong.length > 12 ? ` and ${c.newlyWrong.length - 12} more` : ""}.`,
      "", `Details: ${appUrl()}/admin/assistant-tests?run=${run.id}`,
    ].join("\n"));
  } catch (e) {
    console.warn(`[assistant eval] couldn't check run ${run.id} against the last: ${(e as Error).message}`);
  }
}

/** A run's results by area: cases, passed as deployed, passed on the AI's choice alone, asked back. Pure. */
export function byArea(results: CaseResult[]): { area: string; cases: number; passed: number; bare: number; asked: number }[] {
  const rows = new Map<string, { area: string; cases: number; passed: number; bare: number; asked: number }>();
  for (const r of results) {
    const row = rows.get(r.area) ?? { area: r.area, cases: 0, passed: 0, bare: 0, asked: 0 };
    row.cases++;
    if (r.pass) row.passed++;
    if (r.bare) row.bare++;
    if (r.asked) row.asked++;
    rows.set(r.area, row);
  }
  return Array.from(rows.values()).sort((a, b) => a.passed / a.cases - b.passed / b.cases);
}

const AREA_OF: Record<string, string> = { live_changes: "live_products" };

/** Front door runs: of the cases routed, how many went to the case's own area. Pure. */
export function routing(results: CaseResult[]): { routed: number; right: number } {
  const routed = results.filter((r) => r.routed);
  return { routed: routed.length, right: routed.filter((r) => r.routed === (AREA_OF[r.area] ?? r.area)).length };
}
