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
    // Without the filter: all ten just listed (the confirm tap shows them), not what they meant.
    const all = await read("live-approved-ones", [[{ name: "bulk", args: { scope: "listed", stock: 10, words: "approved" } }]]);
    expect(all).toMatchObject({ pass: false, actions: [{ type: "bulk", scope: "listed", change: { kind: "stock", stock: 10 } }] });
    expect(all.actions[0]).not.toHaveProperty("only");
    // With the group narrowed, and their own words for it copied.
    for (const id of ["live-approved-ones", "live-approved-on-or-off"]) {
      const approved = await read(id, [[{ name: "bulk", args: { scope: "listed", said: "the approved ones", only: "approved", stock: 10 } }]]);
      expect(approved).toMatchObject({ pass: true, actions: [{ type: "bulk", scope: "listed", only: "approved", change: { kind: "stock", stock: 10 } }] });
    }
    // No word gate on the products just listed (owner, 2026-10-11): with or without their words copied, it's the same group.
    const bare = await read("live-approved-ones", [[{ name: "bulk", args: { scope: "listed", only: "approved", stock: 10 } }]]);
    expect(bare).toMatchObject({ pass: true, actions: [{ type: "bulk", scope: "listed", only: "approved" }] });
    // Something else as "only" is no filter.
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

// The owner's web chat, 2026-10-12 17:05-17:11, with the agent's own calls
// from whatsapp_assistant_log.raw (docs/plan-2026-10-13-ask-what-jumia-needs.md
// step 7). These cases are read as where assistant_followup is on.
describe("agent mode's answers in the owner's 12 Oct weight chat", () => {
  const COLLAGEN = "Enhancement Dietary Supplement - Collagen Boosters, Lifts Buttocks";
  async function readOn(id: string, turns: Call[][], followup = true) {
    const c = ASSISTANT_CASES.find((x) => x.id === id);
    if (!c) throw new Error(`no case ${id}`);
    const r = await agentRead(agentInput(c), replay(turns), caseLookups(c), {}, { followup });
    return { ...scoreAgent(c, r), actions: r.actions, clarify: r.clarify };
  }
  const asksBack: Call[] = [{ name: "clarify", args: { question: "Jumia has 0.2 kg for it and turned that down. Send 0.2 kg again, or what does it weigh, packed as it ships?" } }];

  it("17:06 \"That is the weight listed\": the call it made gave the fixed question; told why, its question back passes", async () => {
    const call: Call[] = [{ name: "content_change", args: { product: COLLAGEN, details: [{ value: "That is the weight listed" }], rewrite: ["description"] } }];
    expect(await readOn("qc-weight-listed", [call], false)).toMatchObject({ pass: false, actions: [{ type: "reply", text: expect.stringContaining("What should I change on it?") }] });
    expect(await readOn("qc-weight-listed", [call, asksBack])).toMatchObject({ pass: true, asked: true });
  });

  it("17:07 \"…of the collagen booster\": a rewrite of the other collagen product never passes", async () => {
    const call: Call[] = [{ name: "content_change", args: { product: "Collagen Peptides Powder 1LB (454 G) – Grass Fed Bovine Collagen Hydrolysate (Unflavored)", asked: { description: "That is the weight of the collagen booster" }, rewrite: ["description"] } }];
    expect(await readOn("qc-weight-of-booster", [call])).toMatchObject({ pass: false, bare: false });
  });

  it("17:10 \"Update it for me…\": the right call with Jumia's 0.2 kg was dropped for not being said; told why, it asks", async () => {
    const call: Call[] = [{ name: "content_change", args: { product: COLLAGEN, details: [{ detail: "weight", value: "0.2 kg" }] } }];
    expect(await readOn("qc-update-it", [call], false)).toMatchObject({ pass: false });
    expect(await readOn("qc-update-it", [call, asksBack])).toMatchObject({ pass: true });
    // The same call again: no value said still, so today's question, and the case fails.
    expect(await readOn("qc-update-it", [call, call])).toMatchObject({ pass: false });
  });

  it("17:09 \"…what is the weight ?\": never sent to Drafts & Listings for a live product", async () => {
    const said: Call[] = [{ name: "reply", args: { text: `The weight currently on Jumia for *${COLLAGEN}* is *0.2 kg* (200 g). If you need to update it, you can check and edit it directly from your Drafts & Listings page.` } }];
    expect(await readOn("qc-what-weight", [said])).toMatchObject({ pass: false });
    expect(await readOn("qc-what-weight", [[{ name: "product_info", args: { product: COLLAGEN } }]])).toMatchObject({ pass: true });
  });
});
