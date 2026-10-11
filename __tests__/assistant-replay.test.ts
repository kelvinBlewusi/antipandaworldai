/**
 * Agent mode's answers as the test runs recorded them, replayed through our
 * own checks with no AI call. A case that went wrong because our code
 * turned down a right reading (a size spelled "Small" where the category
 * says "S", a group of products it couldn't name) is fixed in the code and
 * pinned here with the AI's exact words, so the next run's model can't hide
 * whether the code still takes them.
 */

import { FakeDb } from "./helpers/fake-supabase";

const db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));

import { ASSISTANT_CASES } from "@/lib/evals/assistant-cases";
import { agentInput, caseLookups, scoreAgent } from "@/lib/evals/assistant-eval";
import { agentRead, type AgentCall } from "@/lib/assistant-v2/agent";

type Call = { name: string; args: Record<string, unknown> };

/** An AgentCall that gives the recorded turns, one per call. */
function replay(turns: Call[][]): AgentCall {
  const left = [...turns];
  return async () => {
    const calls = left.shift();
    if (!calls) throw new Error("no recorded turn left");
    return { calls, text: "", turn: { role: "model", parts: calls.map((c) => ({ functionCall: c })) } };
  };
}

async function read(id: string, turns: Call[][]) {
  const c = ASSISTANT_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`no case ${id}`);
  const r = await agentRead(agentInput(c), replay(turns), caseLookups(c));
  return { ...scoreAgent(c, r), actions: r.actions };
}

describe("agent mode's recorded answers (test runs of 11 Oct)", () => {
  it("sizes written out are the category's own: Small, medium and Large are S, M, L", async () => {
    const order = await read("draft-variation-order", [[{ name: "edit", args: { products: [1], changes: { variations: [
      { said: "Small", option: "Small" }, { option: "Medium", said: "medium" }, { said: "Large", option: "Large" },
    ] } } }]]);
    expect(order).toMatchObject({ pass: true, actions: [{ type: "edit", edits: [{ seqs: [1], changes: { variations: ["S", "M", "L"] } }] }] });
    // The run before: the right options, with "and, Large" as the words for L.
    const options = await read("draft-variation-order", [[{ name: "edit", args: { said: "the variation", products: [1], changes: { variations: [
      { said: "Small", option: "S" }, { option: "M", said: "medium" }, { option: "L", said: "and, Large" },
    ] } } }]]);
    expect(options).toMatchObject({ pass: true, actions: [{ type: "edit", edits: [{ seqs: [1], changes: { variations: ["S", "M", "L"] } }] }] });
    const typo = await read("draft-variation-typo", [[{ name: "edit", args: { said: "the draft variation", products: [1], changes: { variations: [
      { option: "Large", said: "Large" }, { option: "Medium", said: "Medium" }, { said: "Small", option: "Small" },
    ] } } }]]);
    expect(typo).toMatchObject({ pass: true, actions: [{ type: "edit", edits: [{ changes: { variations: ["L", "M", "S"] } }] }] });
  });

  it("\"the approved ones\" of the products just listed: the group, narrowed", async () => {
    // What the runs did, with no way to say "only the approved ones": all 10 listed, or a search for "approved".
    // ("the approved ones" isn't one of the words for the products just listed, so it was turned down.)
    const all = await read("live-approved-ones", [[{ name: "bulk", args: { scope: "listed", stock: 10, words: "approved" } }]]);
    expect(all).toMatchObject({ pass: false, actions: [{ type: "unclear" }] });
    // With the group narrowed, and their own words for it copied.
    for (const id of ["live-approved-ones", "live-approved-on-or-off"]) {
      const approved = await read(id, [[{ name: "bulk", args: { scope: "listed", said: "the approved ones", only: "approved", stock: 10 } }]]);
      expect(approved).toMatchObject({ pass: true, actions: [{ type: "bulk", scope: "listed", only: "approved", change: { kind: "stock", stock: 10 } }] });
    }
    // Words that aren't in the message back nothing; something else as "only" is no filter.
    const made = await read("live-approved-ones", [[{ name: "bulk", args: { scope: "listed", said: "the good ones", only: "approved", stock: 10 } }]]);
    expect(made.actions).toEqual([{ type: "unclear" }]);
    const odd = await read("live-approved-ones", [[{ name: "bulk", args: { scope: "listed", said: "the approved ones", only: "cheap", stock: 10 } }]]);
    expect(odd.actions[0]).toMatchObject({ type: "bulk", scope: "listed" });
    expect(odd.actions[0]).not.toHaveProperty("only");
  });

  it("all their products that are off is one group, however the AI puts it", async () => {
    // The run after `only` came in: all + only off, where the set has scope "inactive".
    for (const id of ["live-on-all-off", "live-on-them-keep-stock"]) {
      const r = await read(id, [[{ name: "bulk", args: { scope: "all", active: true, only: "off", words: "off" } }]]);
      expect(r).toMatchObject({ pass: true, actions: [{ type: "bulk", scope: "inactive", change: { kind: "status", active: true } }] });
      expect(r.actions[0]).not.toHaveProperty("only");
    }
  });
});
