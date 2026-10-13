/**
 * Agent mode: the assistant reads a message with Gemini's function calling
 * (owner, 2026-10-10: "let's build the agent mode pilot with function
 * calling"). Since 11 Oct it reads every seller's messages first (app_settings
 * `assistant_agent` = "all"), and the front door (lib/assistant-v2/
 * front-door.ts) reads what it fails on. Its tools are the chat's actions,
 * each defined once in lib/assistant-v2/actions.ts.
 *
 * What changes from the front door:
 *   - One call, with every action as a tool, instead of sorting into an
 *     area first and reading within it.
 *   - It may look their products up before deciding (find_products: the
 *     shop's products matching some words, with where each is). At most two
 *     lookup rounds; the last call can only act. Counts and lists come from
 *     the actions that read them, never from a lookup.
 *   - It may do up to three things a message asks for ("restock the kettle
 *     to 10 and show me today's orders"), carried out in order.
 *
 * What doesn't: every action goes through the chat's own safety checks
 * (parseAction: each value in the message, products named, nothing
 * widened), a change to Jumia is offered for a confirm tap unless it's one
 * the owner made immediate (one named product's stock, ON/OFF or end of
 * sale: lib/whatsapp/shop.ts immediateChange), and what isn't possible is
 * answered by the capability list's fixed text (cannot). It never acts on a
 * lookup alone.
 *
 * Honest "can't" (owner, 2026-10-11): "can you…?" is answered from the
 * capability list (capability), what PandaWorld doesn't do gets one fixed
 * line and is noted (not_yet), and a reply in its own words that says it
 * can't is not sent: it's asked once more without reply.
 */

import { callGeminiWithTools, type GeminiTool, type GeminiTurn, type ThinkingLevelName } from "@/lib/ai/gemini-client";
import { withAiUsageContext } from "@/lib/ai/usage";
import { siteGuide } from "@/lib/whatsapp/site-guide";
import { canList, cannotAnswer, cannotList, capability } from "@/lib/jumia/capabilities";
import { capabilities, claimsInability, parseAction, type AssistantAction } from "@/lib/whatsapp/assistant";
import { findProducts, type ShopProduct } from "@/lib/jumia/shop";
import { EXAMPLES, NEVER_CANT, NOT_YET_EXAMPLES, contextText, type Clarify, type FrontDoorInput, type FrontDoorUsage } from "@/lib/assistant-v2/front-door";
import { actionJson, actionTools } from "@/lib/assistant-v2/actions";
import { qcOpenProduct } from "@/lib/whatsapp/qc-open-question";

// ─── Tools ───────────────────────────────────────────────────────────────────

/**
 * Look-ups: answered back to the model, which then decides. Only which
 * product they mean: counts and lists are the actions' to read (an agent
 * told "0 products" by a stale copy answered "You have 0 products": the
 * first test run, 10 Oct).
 */
export const LOOKUP_TOOLS: GeminiTool[] = [{
  name: "find_products",
  description: "Look up which of their Jumia products match some words: each one's full name, ON or OFF, quality check, stock and price, from PandaWorld's saved copy of their shop. Only to tell which product they mean when it isn't clear; never to answer them (the actions read Jumia). Never shown to the seller.",
  parameters: { type: "object", properties: { words: { type: "string", description: "Words from their message naming the product(s)." } }, required: ["words"] },
}, {
  // Owner, 2026-10-11: tools for what's possible, so a question about a
  // product doesn't need an action of its own ("what's in the box", "what
  // colour is it listed as", "why was it rejected").
  name: "product_details",
  description: "Read everything Jumia has on one of their products now, whatever its status (ON, OFF, rejected, waiting for quality check): name, brand, category, each size with its SKU, ON/OFF, quality check and Jumia's reason, price, sale and stock, the description, highlights, every detail, how many photos. To answer a question about that product, or to know what to change. Several matches: their names, to ask which. Never shown to the seller as it is.",
  parameters: { type: "object", properties: { words: { type: "string", description: "Their words for the product, or its SKU." } }, required: ["words"] },
}];

/** Actions: each is one of the chat's own actions (lib/assistant-v2/actions.ts), checked and carried out by the chat. */
export const ACTION_TOOLS: GeminiTool[] = actionTools();
/** A tool call as the chat's own action JSON (what parseAction reads). */
export { actionJson };

const LOOKUPS = new Set(LOOKUP_TOOLS.map((t) => t.name));
/** A lookup that finds nothing: the saved copy can be behind, so it still acts on their words. */
export const NO_MATCH = "None of the products in PandaWorld's saved copy of their shop match these words. The copy can be out of date: act with their own words for the product (the action looks it up on Jumia). Never tell them it isn't in their shop.";
/**
 * Called only when asked whether anything they asked is left (a message of
 * several parts, owner's WhatsApp, 2026-10-11: six numbered changes, and the
 * sale among them was never called): nothing is.
 */
export const DONE_TOOL: GeminiTool = {
  name: "done",
  description: "Everything they asked for is covered by the calls you already made: nothing is left.",
  parameters: { type: "object", properties: { left: { type: "string", description: "Leave empty." } } },
};
/** Every tool, declared on every call (earlier turns call the lookups). */
export const AGENT_TOOLS: GeminiTool[] = [...LOOKUP_TOOLS, ...ACTION_TOOLS, DONE_TOOL];
/** The same, as offered where the switch assistant_followup is on (clarify may ask without buttons). Same names, same order. */
export const AGENT_TOOLS_FOLLOWUP: GeminiTool[] = [...LOOKUP_TOOLS, ...actionTools(true), DONE_TOOL];
const ACTION_NAMES = ACTION_TOOLS.map((t) => t.name);
/** A first turn: anything but done. */
const FIRST_NAMES = [...LOOKUP_TOOLS.map((t) => t.name), ...ACTION_NAMES];
/** After a reply that said it can't: every action but reply. */
const ACTION_NAMES_NO_REPLY = ACTION_NAMES.filter((n) => n !== "reply");
/** Asked whether anything is left: an action for it, or done. */
const CHECK_NAMES = [...ACTION_NAMES, DONE_TOOL.name];

/**
 * A message of several requests: on two or more lines, or numbered ("1. … 2.
 * …"). Its form, not its words. Pure.
 */
export function severalParts(message: string): boolean {
  const lines = message.split(/\n/).filter((l) => l.trim().length > 0);
  const numbered = message.match(/(?:^|\s)\d{1,2}[.)]\s+\S/g) ?? [];
  return lines.length >= 2 || numbered.length >= 2;
}

/** What the model is told after its calls on a message of several parts. */
export const ANYTHING_LEFT = "Noted: it's carried out when you finish. Before that, go through their message part by part. For each part none of your calls covers, call its tool now. Never call again for a part already covered. When everything is covered, call done.";

// ─── The prompt ──────────────────────────────────────────────────────────────

/**
 * What doesn't change from one seller or message to the next: the system
 * instruction, the same for everyone (with the tools, about 10k tokens), so
 * Gemini serves it from its cache instead of reading it each time. Pure.
 */
export function agentSystem(listingCost = 2): string {
  return [
    "You are PandaWorld's assistant for Jumia sellers, on WhatsApp or in the Jumia Listing Assistant chat on the PandaWorld website. PandaWorld lists sellers' products on Jumia and helps them run their Jumia shop.",
    "You act by calling tools. PandaWorld's code checks every call and carries it out; a change to their Jumia shop is shown to them first for a confirm tap, except one product's stock, ON/OFF or end of sale, which is done straight away.",
    "The first message tells you where the seller is, what they've been shown, who they are, and their new message.",
    "", "What PandaWorld can do (all true; nothing else is: there is no team doing things by hand):", capabilities(listingCost),
    "", "Not possible from here (answer these with cannot):", cannotList(),
    "", "What the chat does, by key (for capability):", canList(),
    "", siteGuide(),
    "",
    "Examples (message → the tool and its arguments, as JSON):",
    ...Object.values(EXAMPLES).flat(),
    ...NOT_YET_EXAMPLES,
    "",
    "Rules:",
    "- Call the tool that does what they ask. When they ask for two or three different things, call a tool for each (at most 3), in the order they asked. One request is one tool.",
    "- Read the message for what they want now. The open question is context: a message that answers it belongs with what the question was about (a description the bot asked for a live product is content_change); anything else is a new request.",
    "- Which product: from the products you last listed (\"the approved ones\" are those whose quality check passed, ON or OFF; \"my latest uploaded product\" is the first of a list of their newest), the products the message names, or the conversation (\"those products\" after an order: that order's products). Put their names in the tool. Only when you still can't tell, look it up (find_products), at most twice; then call the tool for what they asked.",
    "- find_products is never an answer: stock, prices, counts and lists come from the tools that read them (product_info, stock, shop, research). Never tell them a product isn't in their shop.",
    "- product_details is Jumia's own data on one product now: a question about that product (what's in the box, its colour or material, its sizes, its barcode, why it was rejected, what its description says) is answered from it with reply, in a line or two. To show its photos: product_photos; to show its description as Jumia has it: product_text; where it is (ON/OFF, stock, price): product_info. A new description or name for a product in their shop is content_change, never edit (edit is only for drafts).",
    "- Every number and word you put in a tool's arguments must be in their message (or, for which product, the recent conversation). Never guess or invent a value.",
    "- You don't have their products' descriptions, highlights, prices, stock or sales unless product_details just gave them: never make them up; read them (product_details, or the tool that shows them).",
    "- Drafts are only the ones listed under \"Drafts in their batch\": shown with draft_text, changed with edit, by their numbers (one edit call per different change: each entry of the examples' \"edits\" is one call). A product already in their shop is read with product_text or product_info and changed with live_change, bulk or content_change, even while drafts wait.",
    "- A change to a product (\"change the drone to 10\", \"restock the kettle\", \"set X to 50 pcs\") is a change, never listing new products. Changing a name, description or highlights with no new text means writing it (content_change with rewrite).",
    "- While a batch's products are being sent, their details (sizes, pieces, prices, SKUs, \"those are 3 different products\") are step: no lookup.",
    "- A product's name on its own after you listed products: product_info. An order number: order_status. How much they made or sold: sales. What PandaWorld listed for them (\"from this chat\"): research with pandaworld_listings.",
    "- Fixing rejected products: fix_rejected (no product to see them and pick one). Which ones are rejected: shop with rejected.",
    "- A question about what you can do (\"can you…?\"): when they say what to do and to which product, call the tool that does it; asked in general, capability with its key. Never send them to Vendor Center for something a tool does (a live product's name, description, highlights, details, stock, price, sale, ON/OFF, sizes, photos). Never say a team or a person will do something.",
    NEVER_CANT,
    "- Ask (clarify) only when you can't tell which action or which product, or a change has no value to set. Never ask for a detail that has a default: a period (the tool's usual one), a report's kind (best_sellers), the price for fees, how many to list (restart asks).",
    "- A reply never says you did, paused, stopped, changed or will change anything (\"I've paused the current draft\" did nothing). Only a tool does things: use it, or ask.",
    "- About themselves (pack, credits, shop, connections, extension use): only from About this seller.",
    "- You see the recent conversation, and what you remember of them from before: answer questions about what they asked or what you said from those (\"what did I ask you?\" lists their questions). Never say you don't keep a record or can't remember.",
    "- Replies: short and warm, *bold* with single asterisks, in the language they wrote in, never a web address (use link). A hello or \"what can you do\": a short list (\"• \" lines) of what you can do, then ask what they'd like. A product's status is ON or OFF, in capitals.",
  ].join("\n");
}

/** What changes with each message: the first user turn. Pure. */
export function agentContext(input: FrontDoorInput): string {
  return [
    input.web ? "Channel: the Jumia Listing Assistant chat on the PandaWorld website." : "Channel: WhatsApp.",
    "",
    contextText(input),
    // The record keeps 600 characters of it: a pasted description is copied whole.
    ...(input.message.length > 600 ? ["", "Their whole message:", input.message.slice(0, 5000)] : []),
    "", "About this seller:", ...input.seller,
    ...(input.memory ? ["", "What you remember about them from earlier (to understand them; never quote it):", input.memory] : []),
    "", "Links you can send with reply (the key in \"link\"):", ...Object.entries(input.links).map(([k, l]) => `- ${k}: ${l.what}`),
  ].join("\n");
}

/** The whole of what the agent reads, for logs and tests. Pure. */
export function agentPrompt(input: FrontDoorInput): string {
  return `${agentSystem(input.listingCost ?? 2)}\n\n${agentContext(input)}`;
}

// ─── The read ────────────────────────────────────────────────────────────────

/** What the agent can look up while deciding. */
export interface AgentLookups {
  findProducts: (words: string) => Promise<string[]>;
  /** Everything Jumia has on one product (lib/whatsapp/shop.ts productDetailsLookup); absent in the test set. */
  productDetails?: (words: string) => Promise<string[]>;
}

const QC: Record<string, string> = { APPROVED: "approved", PENDING: "waiting for quality check", NOT_READY_TO_QC: "waiting for quality check", REJECTED: "rejected by quality check" };

/** One product as a lookup answers it: only what the shop's copy knows. Pure. */
export function lookupLine(p: ShopProduct): string {
  const variation = p.variation && p.variation !== "..." ? ` (${p.variation})` : "";
  return [
    `"${p.name}${variation}"`,
    p.status === "ACTIVE" ? "ON" : p.status === "INACTIVE" ? "OFF" : null,
    p.qcStatus ? QC[p.qcStatus] ?? p.qcStatus.toLowerCase() : null,
    p.stock != null ? `stock ${p.stock}` : null,
    p.price != null ? `price ${p.currency ? `${p.currency} ` : ""}${p.price}` : null,
    p.salePrice != null && (!p.saleEnd || new Date(p.saleEnd).getTime() > Date.now()) ? `on sale at ${p.salePrice}` : null,
  ].filter(Boolean).join(" · ");
}

/** Lookups over their shop's local copy (jumia_products), as the chat's own product search finds them. */
export function catalogLookups(products: ShopProduct[]): AgentLookups {
  return {
    findProducts: async (words) => findProducts(products, words, 12).map(lookupLine),
  };
}

export interface AgentResult {
  /** What to carry out, in order (one or more), or a question back. */
  actions: AssistantAction[];
  clarify: Clarify | null;
  raw:     string;
  /** Model calls made. */
  calls:   number;
}

/**
 * The longest one call may take, and a message in all: inside the 60 s a
 * request has, with time left to carry the actions out. Failing within
 * 15 s, the front door reads it instead (runAssistant).
 */
export const AGENT_LIMITS = { callMs: 10_000, totalMs: 25_000 };
const MAX_LOOKUP_ROUNDS = 2;
const MAX_ACTIONS = 3;

async function timed<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

type ToolCall = { name: string; args: Record<string, unknown>; id?: string };

/**
 * One model turn (`onlyAct`: the lookups may not be called; `noReply`: nor
 * reply, after one that said it can't): injectable for tests.
 */
export type AgentCall = (turns: GeminiTurn[], onlyAct: boolean, noReply?: boolean, checking?: boolean) => Promise<{
  calls: ToolCall[]; text: string; turn: GeminiTurn; usage?: { prompt: number; cached: number };
}>;

/**
 * A model as the agent's settings name it: its id, and after a colon how much
 * it thinks ("gemini-3.8-flash:low"; the model's own default without one).
 * Null for anything else. Pure.
 */
const THINKING_LEVELS: ThinkingLevelName[] = ["minimal", "low", "medium", "high"];
export function agentModelSpec(spec: string): { model: string; thinking?: ThinkingLevelName } | null {
  const [model, level, ...rest] = spec.trim().split(":");
  if (!/^gemini-[a-z0-9.-]+$/.test(model) || rest.length > 0) return null;
  if (level === undefined) return { model };
  return THINKING_LEVELS.includes(level as ThinkingLevelName) ? { model, thinking: level as ThinkingLevelName } : null;
}

/** `system` is agentSystem(): the same for every seller, so it's cached. `spec` as agentModelSpec reads it. */
export function geminiAgentCall(spec: string, system: string, usage: FrontDoorUsage, tools: GeminiTool[] = AGENT_TOOLS): AgentCall {
  const { model, thinking } = agentModelSpec(spec) ?? { model: spec };
  return (turns, onlyAct, noReply, checking) => withAiUsageContext(usage, () => callGeminiWithTools(model, turns, {
    system, tools, mode: "ANY",
    allowed: checking ? CHECK_NAMES : noReply ? ACTION_NAMES_NO_REPLY : onlyAct ? ACTION_NAMES : FIRST_NAMES,
    // AI Studio for every model: Vertex refuses these tools for 2.5 Flash
    // ("too much branching for serving", the model comparison of 11 Oct),
    // and Gemini 3 needs it for its thought signatures.
    preferBackend: "ai-studio" as const,
    ...(thinking ? { thinking } : {}),
  }));
}

const brief = (calls: ToolCall[]) => calls.map((c) => `${c.name}(${JSON.stringify(c.args).slice(0, 200)})`).join(" + ");

/**
 * The calls for what's left of a message of several parts: the model is told
 * its calls are noted and asked to go through the message part by part
 * (ANYTHING_LEFT). A call of the same tool for the same product as one it
 * made is the same part again, left out. Never throws: on any failure,
 * nothing more.
 */
async function askWhatsLeft(call: AgentCall, turns: GeminiTurn[], made: GeminiTurn, finals: ToolCall[], ms: number, log: string[]): Promise<ToolCall[]> {
  const noted = finals.map((c, i) => ({
    functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: { result: i === finals.length - 1 ? ANYTHING_LEFT : "Noted: it's carried out when you finish." } },
  }));
  try {
    const r = await timed(call([...turns, made, { role: "user", parts: noted }], true, false, true), ms, "anything-left call");
    const same = (a: ToolCall, b: ToolCall) => a.name === b.name && String(a.args.product ?? "") === String(b.args.product ?? "");
    const more = r.calls.filter((c) => c.name !== DONE_TOOL.name && !LOOKUPS.has(c.name) && !finals.some((f) => same(f, c)));
    log.push(more.length > 0 ? `(anything left?) ${brief(more)}` : "(anything left? done)");
    return more;
  } catch (e) {
    log.push(`(anything left? ${(e as Error).message.slice(0, 80)})`);
    return [];
  }
}

/** What the model is told when its reply said it can't (claimsInability). */
/**
 * `cannot` with a key that isn't on Not possible but on What the chat does
 * ("labels"), or a link's key ("vendor_center"): the test runs of 11 Oct
 * after the tools for what Jumia allows. What it names can be done, so it's
 * told which list the key is on and asked once more. A key on neither list
 * stays what PandaWorld doesn't do (not_yet).
 */
export function misnamedCannot(key: string, links: Record<string, unknown>): string | null {
  if (!key || cannotAnswer(key)) return null;
  const c = capability(key);
  if (c && (c.status === "chat" || c.status === "whatsapp")) {
    return `Not sent: "${key}" is on What the chat does, not on Not possible. Call the tool that does what they ask, or capability when they ask whether you can.`;
  }
  if (key in links) return `Not sent: "${key}" is a link, not a key on Not possible. To send it, reply with it in link.`;
  return null;
}

export const CANT_NOT_SENT = "Not sent: that reply says PandaWorld can't do something, or sends them to Vendor Center. Call the tool that does what they ask; cannot when it is on Not possible; capability when they ask whether you can; not_yet when PandaWorld doesn't do it (outside: true when it has nothing to do with Jumia, selling or PandaWorld).";

/**
 * What the agent makes of a message: the actions to carry out (checked by
 * the chat's own rules) or a question back. Throws when the model fails or
 * runs out of time: the caller reads it the front door's way instead.
 */
export async function agentRead(
  input: FrontDoorInput, call: AgentCall, lookups: AgentLookups, limits: Partial<typeof AGENT_LIMITS> = {},
  opts: { followup?: boolean } = {},
): Promise<AgentResult> {
  const lim = { ...AGENT_LIMITS, ...limits };
  const t0 = Date.now();
  // The same checks as the front door's reading: values from the message,
  // products named. The bot's open question names a product too (switch
  // assistant_followup: a rejected product's question that stays open).
  const context = [
    ...input.conversation, ...(input.listed?.items ?? []).map((l) => `Bot: ${l}`),
    ...(opts.followup && qcOpenProduct(input.waitingFor) ? [`Bot: ${qcOpenProduct(input.waitingFor)}`] : []),
  ].join("\n");
  const asked = input.answered ? [...input.conversation].reverse().find((l) => l.startsWith("Bot:"))?.slice(4).trim() : undefined;
  const said = asked ? `${asked}\n${input.message}` : input.message;
  let needsAsked = false;
  /** The first change's own question: what the seller gets if the second try comes to nothing. */
  let needsText = "";
  // contextText ends with their new message.
  const turns: GeminiTurn[] = [{ role: "user", parts: [{ text: agentContext(input) }] }];
  const log: string[] = [];
  let finals: ToolCall[] = [];
  let calls = 0;
  let cant = false;
  let renamed = false;
  const tokens = { prompt: 0, cached: 0 };
  for (let round = 0; ; round++) {
    const last = round >= MAX_LOOKUP_ROUNDS || cant || renamed || needsAsked;
    const left = lim.totalMs - (Date.now() - t0);
    if (left <= 1000) {
      // Out of time after a reply that said it can't: it isn't sent (not_yet).
      // After a change it couldn't send: today's question (below).
      if (cant || needsAsked) break;
      throw new Error(`agent ran out of time after ${calls} calls`);
    }
    let r: Awaited<ReturnType<AgentCall>>;
    try {
      r = await timed(call(turns, last, cant), Math.min(lim.callMs, left), "agent call");
    } catch (e) {
      // The second try failed: the first one's change gets today's question.
      if (needsAsked) { log.push(`(asked again: ${e instanceof Error ? e.message : "failed"})`); break; }
      throw e;
    }
    calls++;
    tokens.prompt += r.usage?.prompt ?? 0;
    tokens.cached += r.usage?.cached ?? 0;
    const looked = r.calls.filter((c) => LOOKUPS.has(c.name));
    const acted = r.calls.filter((c) => !LOOKUPS.has(c.name));
    log.push(brief(r.calls) || `text: ${r.text.slice(0, 200)}`);
    // Acted, wrote instead, or looked again when it may only act: done.
    if (acted.length > 0 || looked.length === 0 || last) {
      finals = acted.length > 0 ? acted : r.text.trim() ? [{ name: "reply", args: { text: r.text.trim() } }] : [];
      // Its own words said PandaWorld can't (owner, 2026-10-11: blocked
      // before it's sent): told so, and asked once more without reply.
      const only = finals.length === 1 && finals[0].name === "reply" ? finals[0] : null;
      if (!cant && only && claimsInability(String(only.args.text ?? ""))) {
        cant = true;
        log.push("(said it can't: not sent)");
        const answer = acted.length > 0
          ? [{ functionResponse: { ...(only.id ? { id: only.id } : {}), name: "reply", response: { result: CANT_NOT_SENT } } }]
          : [{ text: CANT_NOT_SENT }];
        turns.push(r.turn, { role: "user", parts: answer });
        continue;
      }
      // "cannot" for something the chat does, or a link: told which list it's on, asked once more.
      const cannot = finals.length === 1 && finals[0].name === "cannot" ? finals[0] : null;
      const misnamed = !renamed && !cant && cannot ? misnamedCannot(String(cannot.args.what ?? ""), input.links) : null;
      if (cannot && misnamed) {
        renamed = true;
        log.push("(cannot with a key that isn't on Not possible: asked again)");
        turns.push(r.turn, { role: "user", parts: [{ functionResponse: { ...(cannot.id ? { id: cannot.id } : {}), name: "cannot", response: { result: misnamed } } }] });
        continue;
      }
      // A change the checks can't send (no product named, no value said):
      // the model is told why and called once more, instead of the fixed
      // question going out (owner's web chat, 2026-10-12; switch
      // assistant_followup). Only a turn of that one call, so its answer is
      // the turn's only one.
      const change = opts.followup && !needsAsked && r.calls.length === 1 && finals.length === 1 && finals[0].name === "content_change" ? finals[0] : null;
      if (change) {
        const checked = parseAction(JSON.stringify(actionJson(change.name, change.args)), said, input.drafts, input.links, input.currency, {
          context, stage: input.stage, listed: !!input.listed, needs: true,
        });
        if (checked.type === "needs") {
          needsAsked = true;
          needsText = checked.text;
          log.push("(content_change not sent: asked again)");
          turns.push(r.turn, { role: "user", parts: [{ functionResponse: { ...(change.id ? { id: change.id } : {}), name: "content_change", response: { result: checked.why } } }] });
          continue;
        }
      }
      // A message of several parts: asked once whether any part is left
      // (owner's WhatsApp, 2026-10-11: brand, weight, warranty, title and
      // material went into one change; the sale was never called).
      const acting = acted.length > 0 && finals.every((c) => c.name !== "clarify" && c.name !== "reply" && c.name !== DONE_TOOL.name);
      if (acting && finals.length < MAX_ACTIONS && severalParts(input.message) && Date.now() - t0 < lim.totalMs - lim.callMs) {
        const more = await askWhatsLeft(call, turns, r.turn, finals, Math.min(lim.callMs, lim.totalMs - (Date.now() - t0)), log);
        calls++;
        finals = [...finals, ...more].slice(0, MAX_ACTIONS);
      }
      break;
    }
    // Look it up, answer the model, and let it decide.
    const answers = await Promise.all(looked.map(async (c) => {
      const words = typeof c.args.words === "string" ? c.args.words : "";
      const read = c.name === "product_details"
        ? (lookups.productDetails ?? (async (w: string) => (await lookups.findProducts(w)).map((l) => `${l} (its details can't be read here)`)))
        : lookups.findProducts;
      const found = (await read(words).catch(() => [] as string[])).slice(0, 12);
      return { functionResponse: { ...(c.id ? { id: c.id } : {}), name: c.name, response: { result: found.length > 0 ? found : NO_MATCH } } };
    }));
    log.push(`→ ${JSON.stringify(answers.map((a) => a.functionResponse.response.result)).slice(0, 300)}`);
    turns.push(r.turn, { role: "user", parts: answers });
  }
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`;
  const read = tokens.prompt ? `, ${k(tokens.prompt)} in${tokens.cached ? ` (${k(tokens.cached)} cached)` : ""}` : "";
  const raw = `${((Date.now() - t0) / 1000).toFixed(1)}s, ${calls} call${calls === 1 ? "" : "s"}${read}: ${log.join(" ")}`;

  const asking = finals.find((c) => c.name === "clarify");
  if (asking) {
    const ask = actionJson("clarify", asking.args);
    const options = (Array.isArray(ask.options) ? ask.options : []).filter((o): o is string => typeof o === "string").map((o) => o.slice(0, 40)).slice(0, 3);
    return { actions: [], clarify: { type: "clarify", question: String(ask.question ?? "").slice(0, 300), options }, raw, calls };
  }

  const many = finals.length > 1;
  const actions: AssistantAction[] = [];
  const seen = new Set<string>();
  for (const c of finals.slice(0, MAX_ACTIONS)) {
    // Beside actions, its own words and "a detail of the product being sent"
    // add nothing; nor does starting over beside listing (the list starts it).
    if (many && (c.name === "reply" || c.name === "step")) continue;
    if (c.name === "restart" && finals.some((f) => f.name === "list")) continue;
    const action = parseAction(JSON.stringify(actionJson(c.name, c.args)), said, input.drafts, input.links, input.currency, {
      context, stage: input.stage, listed: !!input.listed,
    });
    const key = JSON.stringify(action);
    if (action.type === "unclear" || seen.has(key)) continue;
    seen.add(key);
    actions.push(action);
  }
  // Sent back once and the second try came to nothing (nothing to do, or its
  // reply said it can't and the third call failed): today's question, as
  // the first change would have had (reviewing step 3).
  if (needsText && actions.every((a) => a.type === "unclear" || (a.type === "not_yet" && !!a.blocked))) {
    return { actions: [{ type: "reply", text: needsText, link: null }], clarify: null, raw, calls };
  }
  return { actions: actions.length > 0 ? actions : [{ type: "unclear" }], clarify: null, raw, calls };
}
