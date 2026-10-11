/**
 * Step 4 of the reliability plan (owner, 2026-10-11): the chat's warning
 * signs for the week (lib/evals/warning-signs.ts), the Monday message and
 * test runs (lib/evals/weekly.ts), and the alert when a weekly run does
 * worse than the run before it (lib/evals/assistant-eval.ts).
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
const sent: { to: string; body: string }[] = [];
jest.mock("@/lib/whatsapp/client", () => ({
  sendTextIfConfigured: async (to: string, body: string) => { sent.push({ to, body }); },
  sendButtonsIfConfigured: async () => undefined,
  sendCtaUrlIfConfigured: async () => undefined,
  sendListIfConfigured: async () => undefined,
}));
let answer: (prompt: string) => string = () => '{"type":"reply","text":"Hi","link":null}';
jest.mock("@/lib/ai/gemini-client", () => ({
  callGeminiBackend: async (_m: string, parts: { text?: string }[]) => ({ text: answer(parts.map((p) => p.text ?? "").join("\n")) }),
}));

import { aiChoice, sameRequest, signsText, warningSigns, type MessageRow, type TurnRow } from "@/lib/evals/warning-signs";
import { WEEKLY, compareRuns, workOnRuns, type CaseResult } from "@/lib/evals/assistant-eval";
import { runWeekly } from "@/lib/evals/weekly";
import { ASSISTANT_CASES } from "@/lib/evals/assistant-cases";

beforeEach(() => {
  db = new FakeDb();
  sent.length = 0;
  db.tables.app_settings = [{ key: "api_check_user", value: "owner" }];
  db.tables.whatsapp_connections = [{ user_id: "owner", phone_number: "233200000000" }];
});

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const turn = (patch: Partial<TurnRow>): TurnRow => ({ created_at: ago(60), user_id: "s1", stage: "idle", message: "hi", action: { type: "reply" }, outcome: "replied", raw: null, ...patch });
const msg = (patch: Partial<MessageRow>): MessageRow => ({ created_at: ago(60), phone_number: "233111", direction: "inbound", message_type: "text", body_text: "hi", ...patch });

describe("reading the logs", () => {
  it("finds what the AI chose before the checks, in agent mode and the front door", () => {
    expect(aiChoice('[agent gemini-3.5-flash-lite] 1.2s, 2 calls, 14.8k in: find_products({"words":"kettle"}) → [...] live_change({"product":"kettle","stock":10})')).toBe("live_change");
    expect(aiChoice('[front door] 0.9s+1.2s {"area":"orders"} → {"type":"sales","period":"today"}')).toBe("sales");
    expect(aiChoice('[agent failed: took over 10 s] [front door] 0.9s+1.2s {"area":"chat"} → {"type":"reply","text":"x"} | its reply said it can\'t, read again (1.1s) → {"type":"not_yet","what":"x"}')).toBe("not_yet");
    expect(aiChoice(null)).toBeNull();
  });

  it("knows the same request said again", () => {
    expect(sameRequest("restock the kettle to 10", "restock the kettle to 10 please")).toBe(true);
    expect(sameRequest("Restock kettle to 10", "restock the kettle 10")).toBe(true);
    expect(sameRequest("show my orders", "how much did I make this week")).toBe(false);
    expect(sameRequest("ok", "ok")).toBe(true);
    expect(sameRequest("ok", "yes")).toBe(false);
  });
});

describe("the week's warning signs", () => {
  it("counts each sign, with the message behind it", () => {
    const turns = [
      turn({ outcome: "default", message: "do the thing", action: { type: "unclear" } }),
      turn({ raw: "[agent found nothing to do: x] [front door] 1s+1s {} → {\"type\":\"orders\"}", action: { type: "orders" }, outcome: "showed orders" }),
      turn({ outcome: "offered restart", action: { type: "restart" } }),
      turn({ outcome: "failed: timeout", action: null }),
      turn({ outcome: "not yet: post on Instagram", action: { type: "not_yet" } }),
      turn({ outcome: "not yet: book a truck (its reply said it can't)", action: { type: "not_yet" } }),
      // The AI chose product_info; the checks asked which product instead.
      turn({ raw: '[agent m] 0.8s, 1 call, 9k in: product_info({"product":"radio"})', action: { type: "reply" }, outcome: "replied", message: "is it on" }),
      // Not a sign: a step is the product's notes; a capability is a fixed reply.
      turn({ raw: "[agent m] 0.6s, 1 call, 9k in: step({})", action: { type: "note" }, outcome: "step" }),
      turn({ raw: '[agent m] 2.0s, 1 call, 9k in: capability({"what":"live_price"})', action: { type: "reply" }, outcome: "replied" }),
    ];
    const messages = [
      msg({ created_at: ago(30), direction: "outbound", body_text: "Change the kettle's price to 120? (now 100)" }),
      msg({ created_at: ago(29), body_text: "lchgno:abc" }),
      msg({ created_at: ago(20), body_text: "restock the kettle to 10" }),
      msg({ created_at: new Date(Date.parse(ago(20)) + 40_000).toISOString(), body_text: "restock the kettle to 10 please" }),
      // Two minutes apart: not a repeat.
      msg({ created_at: ago(10), body_text: "show my orders" }),
      msg({ created_at: ago(8), body_text: "show my orders" }),
    ];
    const r = warningSigns(turns, messages);
    expect(r.counts).toEqual({ not_understood: 1, fell_back: 1, restart: 1, said_no: 1, repeated: 1, overridden: 1, blocked: 1, failed: 1, wished: 2 });
    expect(r.turns).toBe(9);
    expect(r.agentSeconds).toEqual({ median: 0.8, p90: 2 });
    expect(r.signs.find((s) => s.kind === "said_no")).toMatchObject({ message: "Change the kettle's price to 120? (now 100)" });
    expect(r.signs.find((s) => s.kind === "overridden")).toMatchObject({ message: "is it on", detail: expect.stringContaining("AI: product_info → reply") });
  });

  it("goes to the owner as counts against the week before, with the page to look at", () => {
    const week = warningSigns([turn({ outcome: "default" }), turn({ outcome: "default" })], []);
    const before = warningSigns([turn({ outcome: "default" })], []);
    const text = signsText(week, before, "https://x/admin/warning-signs");
    expect(text).toContain("2 messages read from 1 seller (last week 1)");
    expect(text).toContain("• Read, nothing done: 2 (+1)");
    expect(text).toContain("• Restart offered: 0\n");
    expect(text).toContain("https://x/admin/warning-signs");
  });
});

describe("the Monday job", () => {
  it("sends the week to the owner and queues agent mode's run, then the front door's", async () => {
    db.tables.whatsapp_assistant_log = [
      { created_at: ago(60), user_id: "s1", stage: "idle", message: "do the thing", action: { type: "unclear" }, outcome: "default", raw: null },
      { created_at: ago(60 * 24 * 9), user_id: "s1", stage: "idle", message: "old", action: null, outcome: "default", raw: null },
    ];
    db.tables.whatsapp_message_log = [];
    db.tables.assistant_eval_runs = [];
    const r = await runWeekly();
    expect(r.sent).toBe(true);
    expect(r.signs.not_understood).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("233200000000");
    expect(sent[0].body).toContain("1 message read from 1 seller (last week 1)");
    expect(sent[0].body).toContain("• Agent mode (gemini-2.5-flash-lite): no run yet");
    const runs = db.tables.assistant_eval_runs as { pipeline: string; note: string; status: string }[];
    expect(runs.map((x) => [x.pipeline, x.note, x.status])).toEqual([["agent", WEEKLY, "queued"], ["front_door", WEEKLY, "queued"]]);
  });
});

describe("a weekly run that does worse than the last", () => {
  const all = (pass: boolean): CaseResult[] => ASSISTANT_CASES.map((c) => ({ id: c.id, area: c.area, pass, bare: pass, got: "", raw: "", ms: 1 }));

  it("compares on the cases both scored", () => {
    const before: CaseResult[] = [{ id: "a", area: "x", pass: true, bare: true, got: "", raw: "", ms: 1 }, { id: "b", area: "x", pass: false, bare: false, got: "", raw: "", ms: 1 }, { id: "c", area: "x", pass: true, bare: true, got: "", raw: "", ms: 1, error: "timeout" }];
    const now: CaseResult[] = [{ id: "a", area: "x", pass: false, bare: false, got: "", raw: "", ms: 1 }, { id: "b", area: "x", pass: true, bare: true, got: "", raw: "", ms: 1 }, { id: "c", area: "x", pass: false, bare: false, got: "", raw: "", ms: 1 }];
    expect(compareRuns(now, before)).toEqual({ cases: 2, passedNow: 1, passedBefore: 1, newlyWrong: ["a"], newlyRight: ["b"] });
  });

  it("is sent to the owner when it finishes", async () => {
    answer = (p) => (p.startsWith("You sort one message") ? '{"area":"chat"}' : '{"type":"reply","text":"Hi","link":null}');
    db.tables.assistant_eval_runs = [
      { id: "last", created_at: "2026-10-05T06:41:00Z", status: "done", model: "m", pipeline: "front_door", router_model: "m", note: WEEKLY, total: ASSISTANT_CASES.length, done: ASSISTANT_CASES.length, passed: ASSISTANT_CASES.length, errors: 0, results: all(true) },
      { id: "now", created_at: "2026-10-12T06:41:00Z", status: "queued", model: "m", pipeline: "front_door", router_model: "m", note: WEEKLY, total: ASSISTANT_CASES.length, done: 0, results: [], locked_until: null },
    ];
    await workOnRuns(10 * 60_000);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toMatch(/^⚠️ This week's test run of the front door \(m\) got \d+ of \d+ right, down from \d+ on the same cases\./);
    expect(sent[0].body).toContain("/admin/assistant-tests?run=now");
  });

  it("isn't sent when it holds, or for a run that isn't weekly", async () => {
    answer = (p) => (p.startsWith("You sort one message") ? '{"area":"chat"}' : '{"type":"reply","text":"Hi","link":null}');
    const replyOk = new Set(ASSISTANT_CASES.filter((c) => c.ok.some((s) => s.type === "reply" && Object.keys(s).length === 1)).map((c) => c.id));
    db.tables.assistant_eval_runs = [
      { id: "last", created_at: "2026-10-05T06:41:00Z", status: "done", model: "m", pipeline: "front_door", note: WEEKLY, results: all(false).map((r) => ({ ...r, pass: replyOk.has(r.id) })) },
      { id: "now", created_at: "2026-10-12T06:41:00Z", status: "queued", model: "m", pipeline: "front_door", router_model: "m", note: WEEKLY, total: ASSISTANT_CASES.length, done: 0, results: [], locked_until: null },
      { id: "manual", created_at: "2026-10-12T07:00:00Z", status: "queued", model: "m", pipeline: "front_door", router_model: "m", note: "from the admin page", total: ASSISTANT_CASES.length, done: 0, results: [], locked_until: null },
    ];
    await workOnRuns(10 * 60_000);
    await workOnRuns(10 * 60_000);
    expect((db.tables.assistant_eval_runs as { status: string }[]).map((r) => r.status)).toEqual(["done", "done", "done"]);
    expect(sent).toEqual([]);
  });
});
