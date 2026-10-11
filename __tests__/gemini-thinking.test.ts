/**
 * How much the agent's model thinks before it answers (model comparison,
 * 2026-10-11): Gemini 3 and later take a level, 2.5 a token budget.
 */

import { thinkingConfig } from "@/lib/ai/gemini-client";

describe("thinking", () => {
  it("a level for Gemini 3 and later, a budget for 2.5", () => {
    expect(thinkingConfig("gemini-3.8-flash", "low")).toEqual({ thinkingLevel: "LOW" });
    expect(thinkingConfig("gemini-3.5-flash-lite", "minimal")).toEqual({ thinkingLevel: "MINIMAL" });
    expect(thinkingConfig("gemini-2.5-flash", "minimal")).toEqual({ thinkingBudget: 0 });
    expect(thinkingConfig("gemini-2.5-flash", "low")).toEqual({ thinkingBudget: 512 });
  });
});
