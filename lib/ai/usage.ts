/**
 * What each AI call actually costs, recorded per call — so credit prices
 * are set from measured spend rather than guesses (requested 2026-09-28:
 * "check how much we are spending on listings before we price credits").
 *
 * callGeminiBackend reports every call's token counts here. Calls are
 * tagged with the run they belong to (one extension autofill, one listing
 * draft) via withAiUsageContext, so the admin billing page can show the
 * average cost of a run, not just of a call. Rows land in ai_usage
 * (supabase/migrations/2026-09-28_ai-usage.sql).
 *
 * Best-effort and never throws: cost logging must not fail a listing.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@/lib/supabase/server";

/** assistant_eval: the assistant's test set (lib/evals/assistant-eval.ts), never a seller's. */
export type AiFeature = "extension_fill" | "listing_draft" | "category_refill" | "assistant" | "assistant_eval" | "other";

interface UsageContext {
  feature:    AiFeature;
  runId:      string;
  userId?:    string | null;
  listingId?: string | null;
}

const storage = new AsyncLocalStorage<UsageContext>();

/** Run `fn` with every AI call inside it counted as one run of `feature`. */
export function withAiUsageContext<T>(
  ctx: { feature: AiFeature; userId?: string | null; listingId?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  // Nested runs (a refill inside a draft) keep the outer run's tag.
  if (storage.getStore()) return fn();
  return storage.run({ ...ctx, runId: randomUUID() }, fn);
}

/**
 * USD per 1M tokens, from ai.google.dev/gemini-api/docs/pricing (paid
 * tier, standard, checked 2026-09-28). Thinking tokens bill as output. A
 * model missing here is still logged, with a null cost.
 */
export const MODEL_PRICES_USD_PER_M: Record<string, { input: number; output: number }> = {
  // Checked 2026-10-11: 3.8 and 3.6 Flash at their introductory price to
  // 31 Dec 2026 ($1.50 / $7.50 from 1 Jan 2027).
  "gemini-3.8-flash":      { input: 0.75, output: 3.75 },
  "gemini-3.6-flash":      { input: 0.75, output: 3.75 },
  "gemini-3.5-flash-lite": { input: 0.30, output: 2.50 },
  "gemini-3-flash-preview": { input: 0.50, output: 3.00 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.50 },
  "gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
  "gemini-2.5-flash":      { input: 0.30, output: 2.50 },
  "gemini-2.5-pro":        { input: 1.25, output: 10.00 },
};

/**
 * Input tokens Google served from its cache (implicit caching: the same
 * opening of a prompt sent again, as the agent's instructions are every
 * turn) bill at a tenth of the input price, on every model above
 * (ai.google.dev pricing, "context caching", checked 2026-10-11). Until
 * 2026-10-11 the log charged them in full, so the agent's cost read high.
 */
export const CACHED_INPUT_SHARE = 0.1;

/** Grounding with Google Search on Gemini 3: 5,000 free a month, then $14 per 1,000 queries. */
export const SEARCH_QUERY_USD = 0.014;

export interface UsageNumbers {
  model:         string;
  backend:       "vertex" | "ai-studio";
  promptTokens:  number;
  outputTokens:  number;
  thoughtTokens: number;
  searchQueries: number;
  /** Of promptTokens, how many came from Google's cache. */
  cachedTokens?: number;
}

/** Token cost in USD, or null for a model without a known price. Search is reported separately. */
export function tokenCostUsd(u: Pick<UsageNumbers, "model" | "promptTokens" | "outputTokens" | "thoughtTokens" | "cachedTokens">): number | null {
  const price = MODEL_PRICES_USD_PER_M[u.model];
  if (!price) return null;
  const cached = Math.min(Math.max(0, u.cachedTokens ?? 0), u.promptTokens);
  const input = (u.promptTokens - cached + cached * CACHED_INPUT_SHARE) * price.input;
  return (input + (u.outputTokens + u.thoughtTokens) * price.output) / 1_000_000;
}

/**
 * Pull token counts out of either SDK's response. Both put them on
 * `usageMetadata` (on the result for @google/genai, on `result.response`
 * for @google/generative-ai); thinking tokens are only broken out by the
 * newer SDK, so they're derived from the total where missing. Cached input
 * (cachedContentTokenCount) is counted inside the prompt's tokens.
 */
export function readUsage(raw: unknown): Omit<UsageNumbers, "model" | "backend"> {
  const r = (raw ?? {}) as Record<string, unknown>;
  const meta = (r.usageMetadata ?? {}) as Record<string, number | undefined>;
  const prompt = meta.promptTokenCount ?? 0;
  const output = meta.candidatesTokenCount ?? 0;
  const thoughts = meta.thoughtsTokenCount ?? Math.max(0, (meta.totalTokenCount ?? 0) - prompt - output);
  const candidates = (r.candidates ?? []) as { groundingMetadata?: { webSearchQueries?: unknown[] } }[];
  const searchQueries = candidates[0]?.groundingMetadata?.webSearchQueries?.length ?? 0;
  // Part of promptTokenCount, not on top of it.
  const cachedTokens = meta.cachedContentTokenCount ?? 0;
  return { promptTokens: prompt, outputTokens: output, thoughtTokens: thoughts, searchQueries, cachedTokens };
}

/** Record one call. Fire-and-forget from the caller's point of view. */
export async function recordAiUsage(u: UsageNumbers): Promise<void> {
  try {
    const ctx = storage.getStore();
    const db = createServerClient();
    await db.from("ai_usage").insert({
      feature:        ctx?.feature ?? "other",
      run_id:         ctx?.runId ?? null,
      user_id:        ctx?.userId ?? null,
      listing_id:     ctx?.listingId ?? null,
      model:          u.model,
      backend:        u.backend,
      prompt_tokens:  u.promptTokens,
      output_tokens:  u.outputTokens,
      thought_tokens: u.thoughtTokens,
      search_queries: u.searchQueries,
      cost_usd:       tokenCostUsd(u),
    });
  } catch (e) {
    console.warn(`[ai-usage] failed to record a ${u.model} call: ${(e as Error).message}`);
  }
}
