/**
 * Agent mode (lib/assistant-v2/agent.ts): Gemini's function calling, with
 * a stand-in model. Each tool call becomes the chat's own action and goes
 * through the same checks as the front door's reading; lookups are answered
 * back before it acts; it may do up to three things a message asks for.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async () => { throw new Error("not in these tests"); },
  callGeminiWithTools: async () => { throw new Error("not in these tests"); },
}));

import {
  ACTION_TOOLS, AGENT_TOOLS, AGENT_TOOLS_FOLLOWUP, LOOKUP_TOOLS, NO_MATCH, actionJson, agentContext, agentModelSpec, agentPrompt, agentRead, agentSystem, catalogLookups, lookupLine, type AgentCall,
} from "@/lib/assistant-v2/agent";
import type { FrontDoorInput } from "@/lib/assistant-v2/front-door";
import { assistantLinks, parseAction } from "@/lib/whatsapp/assistant";
import { fromRow } from "@/lib/jumia/shop";
import type { GeminiTurn } from "@/lib/ai/gemini-client";

beforeEach(() => { db = new FakeDb(); });

const input = (message: string, patch: Partial<FrontDoorInput> = {}): FrontDoorInput => ({
  stage: "idle", message, conversation: [], drafts: [], listed: null, seller: ["- Country: Ghana"], links: assistantLinks(),
  currency: "GHS", web: true, ...patch,
});

type Step = { calls: { name: string; args: Record<string, unknown>; id?: string }[]; text?: string };

/** A stand-in model answering each turn in order; records what it was sent. */
function scripted(steps: Step[]) {
  const seen: { turns: GeminiTurn[]; onlyAct: boolean }[] = [];
  const call: AgentCall = async (turns, onlyAct) => {
    seen.push({ turns: JSON.parse(JSON.stringify(turns)) as GeminiTurn[], onlyAct });
    const step = steps.shift();
    if (!step) throw new Error("no turn scripted");
    return {
      calls: step.calls, text: step.text ?? "",
      turn: { role: "model", parts: step.calls.map((c) => ({ functionCall: { name: c.name, args: c.args }, thoughtSignature: "sig" })) },
    };
  };
  return { call, seen };
}

const noLookups = { findProducts: async () => [] as string[] };

const KETTLE = fromRow({ product_sid: "p1", seller_sku: "KET-1", name: "Nasco Electric Kettle 1.7L", status: "ACTIVE", qc_status: "APPROVED", stock: 0, price: 250, currency: "GHS" });
const FAN = fromRow({ product_sid: "p2", seller_sku: "FAN-1", name: "Pedestal Fan - 5-Blade", status: "INACTIVE", qc_status: "REJECTED", stock: 4 });
const GONE = fromRow({ product_sid: "p3", seller_sku: "OLD-1", name: "Old Kettle", status: "DELETED" });

describe("the tools", () => {
  it("has every action once, with the lookups apart", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(LOOKUP_TOOLS.map((t) => t.name)).toEqual(["find_products", "product_details"]);
    for (const t of ACTION_TOOLS) expect(t.parameters).toMatchObject({ type: "object" });
    expect(names).toEqual(expect.arrayContaining(["live_change", "bulk", "content_change", "fix_rejected", "add_size", "add_photos", "draft_text", "clarify", "reply", "cannot"]));
  });

  it("asks for a draft edit's values in changes, never in said (10 Oct runs: \"Price: 130gh, Sizes: …\" landed in said)", () => {
    const edit = ACTION_TOOLS.find((t) => t.name === "edit")!;
    expect((edit.parameters as { required?: string[] }).required).toEqual(["products", "changes"]);
  });

  it("an edit is one change a call, put back as the chat's list of them (a list ran to 10 s of empty entries, 11 Oct)", () => {
    const edit = ACTION_TOOLS.find((t) => t.name === "edit")!;
    expect(Object.keys((edit.parameters as { properties: object }).properties)).not.toContain("edits");
    expect(actionJson("edit", { products: [1], changes: { price: 130 } }))
      .toEqual({ type: "edit", edits: [{ products: [1], said: null, changes: { price: 130 }, ask: false }] });
    // The old shape still reads.
    expect(actionJson("edit", { edits: [{ products: [2], changes: { price: 5 } }] })).toEqual({ type: "edit", edits: [{ products: [2], changes: { price: 5 } }] });
  });

  it("puts a call back in the chat's own action shape", () => {
    expect(actionJson("live_change", { product: "kettle", end_sale: true })).toEqual({ type: "live_change", product: "kettle", sale: "end" });
    expect(actionJson("live_change", { product: "kettle", stock: 10, end_sale: false })).toEqual({ type: "live_change", product: "kettle", stock: 10 });
    expect(actionJson("submit", { all: true })).toEqual({ type: "submit", products: "all" });
    expect(actionJson("submit", { products: [1, 3] })).toEqual({ type: "submit", products: [1, 3] });
    expect(actionJson("content_change", { product: "fan", details: [{ detail: "colour", value: "white" }, { detail: 3 }] }))
      .toEqual({ type: "content_change", product: "fan", details: { colour: "white" }, rewrite: [] });
    expect(actionJson("sales", { period: "week", status: ["delivered"] })).toEqual({ type: "sales", period: "week", status: "delivered" });
    expect(actionJson("sales", { period: "week", status: ["delivered", "returned"] })).toEqual({ type: "sales", period: "week", status: ["delivered", "returned"] });
    expect(actionJson("polish", {})).toEqual({ type: "polish", product: null });
  });

  // Owner's chat, 11 Oct 06:13: the hello came out as "…for your shop:\n• List new products…".
  // A tool's arguments are already decoded; the model writes JSON's escapes
  // out as it sees them in the examples.
  it("a \\n the model writes in an argument is a new line, in a reply or text sent to Jumia", () => {
    expect(actionJson("reply", { text: "Hi! 👋 Here's what I can do:\\n• List products\\n• Orders\\n\\nWhat would you like?" }))
      .toEqual({ type: "reply", text: "Hi! 👋 Here's what I can do:\n• List products\n• Orders\n\nWhat would you like?" });
    expect(actionJson("content_change", { product: "fan", description: 'Quiet.\\r\\nSays \\"cool\\"\\tand it\\\'s light' }))
      .toMatchObject({ description: 'Quiet.\nSays "cool"\tand it\'s light' });
    // Real new lines stay as they are.
    expect(actionJson("reply", { text: "a\nb" })).toEqual({ type: "reply", text: "a\nb" });
  });

  // Test run e14c46b9 (11 Oct): 3.5 Flash-Lite filled every field of bulk with
  // zero, and the chat read a 0% price change ("By what percentage?").
  it("a change of 0% or to a price of 0 is no change: left out, so the one asked for is read", () => {
    const args = { scope: "all", words: "", end_sale: false, sale_price: 0, stock: 0, price_pct: 0, price: 0, active: false, sale_pct: 0 };
    expect(actionJson("bulk", args)).toEqual({ type: "bulk", scope: "all", words: "", stock: 0, active: false });
    expect(parseAction(JSON.stringify(actionJson("bulk", args)), "reduce all the stock of the entire shop to 0 you may do it in badges", [], assistantLinks()))
      .toEqual({ type: "bulk", scope: "all", words: null, change: { kind: "stock", stock: 0 } });
    expect(actionJson("live_change", { product: "kettle", price: 0, sale_price: 0, stock: 5 })).toEqual({ type: "live_change", product: "kettle", stock: 5 });
    // A real one stays.
    expect(actionJson("bulk", { scope: "all", price_pct: -10 })).toEqual({ type: "bulk", scope: "all", price_pct: -10 });
  });

  it("tells the model where the seller is, what's possible and the rules", () => {
    const p = agentPrompt(input("restock the electric kettle to 10", { shopNames: ["Nasco Electric Kettle 1.7L"] }));
    expect(p).toContain("Where they are: Between batches");
    expect(p).toContain('Products in their Jumia shop the message names: "Nasco Electric Kettle 1.7L"');
    expect(p).toContain("Not possible from here");
    expect(p).toContain("at most 3");
    expect(p).toContain("ON or OFF, in capitals");
  });
});

describe("what it's told", () => {
  it("is the same for every seller and message, so Gemini can cache it; what changes goes in the first turn", () => {
    const a = input("restock the kettle to 10", { seller: ["- Country: Ghana", "- Their Jumia shop: GEM MALL"], memory: "likes short replies" });
    const b = input("hello", { web: false, seller: ["- Country: Nigeria"] });
    expect(agentSystem(2)).toBe(agentSystem(2));
    expect(agentSystem(2)).not.toContain("GEM MALL");
    expect(agentContext(a)).toContain("GEM MALL");
    expect(agentContext(a)).toContain("likes short replies");
    expect(agentContext(a)).toContain('Their new message: "restock the kettle to 10"');
    expect(agentContext(b)).toContain("Channel: WhatsApp.");
    expect(agentPrompt(a).startsWith(agentSystem(2))).toBe(true);
  });

  it("gets a long pasted text whole, not just the first 600 characters", () => {
    const long = `change the kettle's description to ${"Boils fast and quietly. ".repeat(40)}The end.`;
    expect(agentContext(input(long))).toContain("The end.");
  });

  it("sends the context as the first turn and records what was cached", async () => {
    const seen: GeminiTurn[][] = [];
    const call: AgentCall = async (turns) => {
      seen.push(turns);
      return { calls: [{ name: "orders", args: {} }], text: "", turn: { role: "model", parts: [] }, usage: { prompt: 10_400, cached: 9_800 } };
    };
    const r = await agentRead(input("ordrs"), call, noLookups);
    expect((seen[0][0].parts[0] as { text: string }).text).toBe(agentContext(input("ordrs")));
    expect(r.raw).toContain("10.4k in (9.8k cached)");
  });
});

describe("its lookups", () => {
  it("shows a product with only what the shop's copy knows", () => {
    expect(lookupLine(KETTLE)).toBe('"Nasco Electric Kettle 1.7L" · ON · approved · stock 0 · price GHS 250');
    expect(lookupLine(fromRow({ product_sid: "x", seller_sku: "X", name: "Wig" }))).toBe('"Wig"');
  });

  it("finds products the way the chat's own search does", async () => {
    const look = catalogLookups([KETTLE, FAN, GONE]);
    expect(await look.findProducts("the kettle")).toEqual([lookupLine(KETTLE)]);
    expect(await look.findProducts("blender")).toEqual([]);
  });
});

// docs/plan-2026-10-13-ask-what-jumia-needs.md step 4.
describe("asking without buttons (switch assistant_followup)", () => {
  const clarifyOf = (tools: typeof AGENT_TOOLS) => tools.find((t) => t.name === "clarify")!;

  it("where it's on, clarify needs only the question, and is told to leave options out for a value", () => {
    expect((clarifyOf(AGENT_TOOLS_FOLLOWUP).parameters as { required?: string[] }).required).toEqual(["question"]);
    expect(clarifyOf(AGENT_TOOLS_FOLLOWUP).description).toContain("leave options out when the answer is a value or a name (a weight, a brand, a number)");
  });

  it("elsewhere it's as before, and every other tool is the same in both", () => {
    expect((clarifyOf(AGENT_TOOLS).parameters as { required?: string[] }).required).toEqual(["question", "options"]);
    expect(AGENT_TOOLS_FOLLOWUP.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
    expect(AGENT_TOOLS_FOLLOWUP.filter((t) => t.name !== "clarify")).toEqual(AGENT_TOOLS.filter((t) => t.name !== "clarify"));
  });

  it("a question with no options comes back with none", async () => {
    const { call } = scripted([{ calls: [{ name: "clarify", args: { question: "What does it weigh, packed as it ships?" } }] }]);
    const r = await agentRead(input("the weight is wrong"), call, noLookups);
    expect(r.clarify).toEqual({ type: "clarify", question: "What does it weigh, packed as it ships?", options: [] });
  });
});

describe("reading a message", () => {
  it("looks a product up, answers the model, then acts", async () => {
    const { call, seen } = scripted([
      { calls: [{ name: "find_products", args: { words: "kettle" }, id: "c1" }] },
      { calls: [{ name: "live_change", args: { product: "Nasco Electric Kettle 1.7L", stock: 10 } }] },
    ]);
    const r = await agentRead(input("restock the kettle to 10"), call, catalogLookups([KETTLE]));
    expect(r.actions).toEqual([expect.objectContaining({ type: "live_change", product: "Nasco Electric Kettle 1.7L", change: { kind: "stock", stock: 10 } })]);
    expect(r.calls).toBe(2);
    // Its own turn goes back as it came (thought signatures included), then the answer.
    const second = seen[1].turns;
    expect(second[1]).toEqual({ role: "model", parts: [{ functionCall: { name: "find_products", args: { words: "kettle" } }, thoughtSignature: "sig" }] });
    expect(second[2]).toEqual({ role: "user", parts: [{ functionResponse: { id: "c1", name: "find_products", response: { result: [lookupLine(KETTLE)] } } }] });
    expect(r.raw).toContain("find_products");
  });

  it("with nothing found, acts on their words anyway; only acts on the last round after two lookups", async () => {
    const { call, seen } = scripted([
      { calls: [{ name: "find_products", args: { words: "blender" } }] },
      { calls: [{ name: "find_products", args: { words: "blender robot" } }] },
      { calls: [{ name: "product_info", args: { product: "blender" } }] },
    ]);
    const r = await agentRead(input("is my blender on?"), call, catalogLookups([KETTLE]));
    expect(seen.map((s) => s.onlyAct)).toEqual([false, false, true]);
    expect(seen[1].turns[2].parts[0]).toEqual({ functionResponse: { name: "find_products", response: { result: NO_MATCH } } });
    expect(NO_MATCH).toContain("Never tell them it isn't in their shop");
    expect(r.actions).toEqual([{ type: "product_info", product: "blender" }]);
  });

  it("stops when it only looks up on the last round", async () => {
    const { call } = scripted([
      { calls: [{ name: "find_products", args: { words: "kettle" } }] },
      { calls: [{ name: "find_products", args: { words: "kettle" } }] },
      { calls: [{ name: "find_products", args: { words: "kettle" } }] },
    ]);
    const r = await agentRead(input("how is my kettle"), call, noLookups);
    expect(r.calls).toBe(3);
    expect(r.actions).toEqual([{ type: "unclear" }]);
  });

  it("does up to three things asked at once, in order", async () => {
    const { call } = scripted([{ calls: [
      { name: "live_change", args: { product: "kettle", stock: 10 } },
      { name: "orders", args: {} },
      { name: "credits", args: {} },
      { name: "help", args: {} },
    ] }]);
    const r = await agentRead(input("restock the kettle to 10, show me my orders, and my credits"), call, noLookups);
    expect(r.actions.map((a) => a.type)).toEqual(["live_change", "orders", "credits"]);
  });

  it("drops a step beside an edit: the details were the edit", async () => {
    const { call } = scripted([{ calls: [
      { name: "edit", args: { edits: [{ products: [1], changes: { price: 130 } }] } },
      { name: "step", args: {} },
    ] }]);
    const drafts = [{ seq: 1, listing: { id: "l1", title: "Bodysuit", status: "draft" }, variations: [], options: [] }] as unknown as FrontDoorInput["drafts"];
    const r = await agentRead(input("Product 1 Price: 130gh", { stage: "review", drafts }), call, noLookups);
    expect(r.actions.map((a) => a.type)).toEqual(["edit"]);
  });

  it("lists rather than starting over twice: \"start a new batch of 5\"", async () => {
    const { call } = scripted([{ calls: [{ name: "restart", args: {} }, { name: "list", args: { count: 5 } }] }]);
    const r = await agentRead(input("start a new batch of 5 products"), call, noLookups);
    expect(r.actions).toEqual([{ type: "list", count: 5 }]);
  });

  it("drops its own words beside actions, and the same action twice", async () => {
    const { call } = scripted([{ calls: [
      { name: "reply", args: { text: "Done! I've restocked it." } },
      { name: "orders", args: {} },
      { name: "orders", args: {} },
    ] }]);
    const r = await agentRead(input("show me my orders"), call, noLookups);
    expect(r.actions).toEqual([{ type: "orders" }]);
  });

  it("asks back with answers to tap", async () => {
    const { call } = scripted([{ calls: [{ name: "clarify", args: { question: "Which kettle?", options: ["Nasco 1.7L", "Binatone 2L", "Both", "Neither"] } }] }]);
    const r = await agentRead(input("restock the kettle to 10"), call, noLookups);
    expect(r.actions).toEqual([]);
    expect(r.clarify).toEqual({ type: "clarify", question: "Which kettle?", options: ["Nasco 1.7L", "Binatone 2L", "Both"] });
  });

  it("keeps the chat's checks: a value not in the message is never used", async () => {
    const { call } = scripted([{ calls: [{ name: "live_change", args: { product: "kettle", stock: 50 } }] }]);
    const r = await agentRead(input("restock the kettle to 10"), call, noLookups);
    expect(r.actions.some((a) => a.type === "live_change" && JSON.stringify(a).includes("50"))).toBe(false);
  });

  // Owner's web chat, 2026-10-12 17:06-17:10: "That is the weight listed" and
  // "Update it for me on my JUMIA shop" each got the fixed "What should I
  // change on it?" (docs/plan-2026-10-13-ask-what-jumia-needs.md step 3).
  describe("a change the checks can't send goes back to the model once (switch assistant_followup)", () => {
    const OPEN = "Jumia's quality check rejected their product \"Collagen Boosters\" (SKU PA-MUTE4CYI) and needs its weight (in kg, packed as it ships); Jumia has 0.2 kg for it now";
    const msg = (m: string) => input(m, {
      conversation: ["Bot: 🔍 *Collagen Boosters*: Jumia's quality check needs something only you have. What does it weigh, packed as it ships?", "Seller: That is the weight listed"],
      waitingFor: OPEN, waitingStays: true,
    });
    const noValue = { name: "content_change", args: { product: "Collagen Boosters", details: [{ detail: "weight", value: "0.2 kg" }] }, id: "c1" };

    it("told why, it asks the seller instead of the fixed question", async () => {
      const { call, seen } = scripted([
        { calls: [noValue] },
        { calls: [{ name: "clarify", args: { question: "Jumia has 0.2 kg for it and turned that down. Send 0.2 kg again, or what does it weigh packed?" } }] },
      ]);
      const r = await agentRead(msg("Update it for me on my JUMIA shop"), call, noLookups, {}, { followup: true });
      expect(r.clarify).toEqual({ type: "clarify", question: expect.stringContaining("Send 0.2 kg again"), options: [] });
      expect(r.actions).toEqual([]);
      expect(r.calls).toBe(2);
      expect(seen[1].onlyAct).toBe(true);
      expect(seen[1].turns[2]).toEqual({ role: "user", parts: [{ functionResponse: { id: "c1", name: "content_change", response: { result: expect.stringContaining("no value for weight was in the seller's message") } } }] });
      expect(r.raw).toContain("content_change not sent: asked again");
    });

    it("a value as they wrote it is the change at once; one written its own way is sent back, then called as they wrote it", async () => {
      const once = scripted([{ calls: [{ name: "content_change", args: { product: "Collagen Boosters", details: [{ detail: "weight", value: "0.1kg" }] } }] }]);
      const r1 = await agentRead(msg("it's 0.1kg"), once.call, noLookups, {}, { followup: true });
      expect(r1.calls).toBe(1);
      expect(r1.actions).toEqual([expect.objectContaining({ type: "content_change", product: "Collagen Boosters", request: { details: { weight: "0.1kg" } } })]);

      const twice = scripted([
        { calls: [{ name: "content_change", args: { product: "Collagen Boosters", details: [{ detail: "weight", value: "0.1 kg" }] } }] },
        { calls: [{ name: "content_change", args: { product: "Collagen Boosters", details: [{ detail: "weight", value: "0.1kg" }] } }] },
      ]);
      const r2 = await agentRead(msg("it's 0.1kg"), twice.call, noLookups, {}, { followup: true });
      expect(r2.calls).toBe(2);
      expect(r2.actions).toEqual([expect.objectContaining({ type: "content_change", request: { details: { weight: "0.1kg" } } })]);
    });

    it("the product named only by the bot's open question counts", async () => {
      const lone = input("that is the weight of the collagen booster", { waitingFor: OPEN, waitingStays: true });
      const { call } = scripted([
        { calls: [{ name: "content_change", args: { product: "Collagen Boosters", details: [{ detail: "weight", value: "0.2 kg" }] } }] },
        { calls: [{ name: "clarify", args: { question: "Send 0.2 kg again?" } }] },
      ]);
      const r = await agentRead(lone, call, noLookups, {}, { followup: true });
      expect(r.clarify?.question).toBe("Send 0.2 kg again?");
    });

    it("when the second call fails or is slow, the fixed question goes out", async () => {
      const slow: AgentCall = (() => {
        let n = 0;
        return async () => {
          if (n++ === 0) return { calls: [noValue], text: "", turn: { role: "model", parts: [{ functionCall: { name: noValue.name, args: noValue.args } }] } };
          return new Promise(() => {});
        };
      })() as AgentCall;
      const r = await agentRead(msg("Update it for me on my JUMIA shop"), slow, noLookups, { callMs: 30, totalMs: 5_000 }, { followup: true });
      expect(r.actions).toEqual([{ type: "reply", text: expect.stringContaining("What should I change on it?"), link: null }]);
      expect(r.raw).toContain("(asked again: agent call took over");
    });

    it("asked again, it still sends no value: the fixed question, never a second retry", async () => {
      const { call } = scripted([{ calls: [noValue] }, { calls: [{ ...noValue, id: "c2" }] }]);
      const r = await agentRead(msg("Update it for me on my JUMIA shop"), call, noLookups, {}, { followup: true });
      expect(r.calls).toBe(2);
      expect(r.actions).toEqual([{ type: "reply", text: expect.stringContaining("What should I change on it?"), link: null }]);
    });

    it("switched off: as before, one call and the fixed question", async () => {
      const { call } = scripted([{ calls: [noValue] }]);
      const r = await agentRead(msg("Update it for me on my JUMIA shop"), call, noLookups);
      expect(r.calls).toBe(1);
      expect(r.actions).toEqual([{ type: "reply", text: expect.stringContaining("What should I change on it?"), link: null }]);
    });

    it("needs comes only from the agent's own check, never from the model or the front door", () => {
      expect(parseAction('{"type":"needs","text":"x","why":"y"}', "hello", [], assistantLinks())).toEqual({ type: "unclear" });
      expect(parseAction(JSON.stringify(actionJson(noValue.name, noValue.args)), "update it", [], assistantLinks(), "GHS", { context: OPEN }))
        .toMatchObject({ type: "reply", text: expect.stringContaining("What should I change on it?") });
      expect(parseAction(JSON.stringify(actionJson(noValue.name, noValue.args)), "update it", [], assistantLinks(), "GHS", { context: OPEN, needs: true }))
        .toMatchObject({ type: "needs", text: expect.stringContaining("What should I change on it?"), why: expect.stringContaining("Ask them with clarify") });
    });
  });

  it("throws when the model is slow, so the front door reads it instead", async () => {
    const call: AgentCall = () => new Promise(() => {});
    await expect(agentRead(input("hello"), call, noLookups, { callMs: 30, totalMs: 5_000 })).rejects.toThrow(/took over/);
  });

  it("throws when the model fails", async () => {
    const call: AgentCall = async () => { throw new Error("404 model not found"); };
    await expect(agentRead(input("hello"), call, noLookups)).rejects.toThrow("404");
  });
});

describe("the agent's model (model comparison, 2026-10-11)", () => {
  it("is a model id, with how much it thinks after a colon", () => {
    expect(agentModelSpec("gemini-3.1-flash-lite")).toEqual({ model: "gemini-3.1-flash-lite" });
    expect(agentModelSpec("gemini-3.8-flash:low")).toEqual({ model: "gemini-3.8-flash", thinking: "low" });
    expect(agentModelSpec(" gemini-2.5-flash:minimal ")).toEqual({ model: "gemini-2.5-flash", thinking: "minimal" });
    expect(agentModelSpec("gemini-3.8-flash:lots")).toBeNull();
    expect(agentModelSpec("gpt-4:low")).toBeNull();
    expect(agentModelSpec("gemini-3.8-flash:low:x")).toBeNull();
  });
});
