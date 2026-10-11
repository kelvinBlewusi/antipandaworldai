/**
 * Every action the assistant can take, defined once (part G of the
 * reliability plan, owner 2026-10-11: "one definition per action"). Before,
 * an action was described three times: agent mode's tool, the front door's
 * line, and a list of names in the tests; adding one could leave another
 * out of date. Each entry here is:
 *
 *   - name: its type in the chat's JSON, which parseAction checks and
 *     carryOut does (lib/whatsapp/assistant.ts), and its tool's name in
 *     agent mode;
 *   - line: how the front door's reading call is told about it (its JSON and
 *     what it means), or `lineIn` an area that reads it differently;
 *   - tool: agent mode's function (what it does, its fields);
 *   - toJson: the tool's arguments as the chat's JSON, where they differ;
 *   - sample: a message and the tool's arguments for it, which the chat's
 *     checks carry out (the tests run every one).
 *
 * The front door's areas (which actions each reading offers) and the worked
 * examples are in front-door.ts; the capability list (lib/jumia/
 * capabilities.ts) names the action behind each thing done on Jumia.
 * __tests__/assistant-actions.test.ts fails when an action is missing from
 * any of them, from the checks, or from what's carried out.
 */

import type { GeminiTool } from "@/lib/ai/gemini-client";

/** The front door's areas: its first call sorts a message into one. */
export type Area = "listing" | "drafts" | "live_products" | "shop_info" | "orders" | "money" | "account_help" | "chat";
export const AREAS: Area[] = ["listing", "drafts", "live_products", "shop_info", "orders", "money", "account_help", "chat"];

// ─── Fields ──────────────────────────────────────────────────────────────────

type Schema = Record<string, unknown>;
const str = (description: string, values?: string[]): Schema => ({ type: "string", description, ...(values ? { enum: values } : {}) });
const num = (description: string): Schema => ({ type: "number", description });
const int = (description: string): Schema => ({ type: "integer", description });
const bool = (description: string): Schema => ({ type: "boolean", description });
const arr = (items: Schema, description: string): Schema => ({ type: "array", items, description });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: "object", properties, ...(required.length ? { required } : {}) });

const PERIOD = ["today", "yesterday", "week", "month", "quarter"];
const PRODUCT = str("The product in their words, or as their shop names it.");
const STATUS = ["cancelled", "delivered", "returned", "failed", "pending", "ready_to_ship", "shipped"];

type Args = Record<string, unknown>;

export interface ActionDef {
  name: string;
  /** The front door: its JSON and what it means. */
  line: string[];
  /** Its lines in an area that reads it differently. */
  lineIn?: Partial<Record<Area, string[]>>;
  /** Agent mode: what it does, its fields, and the ones it needs. */
  tool: { does: string; fields?: Record<string, Schema>; required?: string[] };
  /** The tool's arguments as the chat's JSON, where they differ from {type, ...args}. */
  toJson?: (args: Args) => Args;
  /** A message and the tool's arguments for it, carried out by the chat's checks (not for clarify: the readers ask it themselves). */
  sample?: { message: string; args: Args };
}

/** "end_sale": true is the chat's "sale": "end". */
const endSale = (name: string) => (args: Args): Args => {
  const out: Args = { type: name, ...args };
  if (args.end_sale === true) out.sale = "end";
  delete out.end_sale;
  return out;
};

// ─── The actions ─────────────────────────────────────────────────────────────

export const ACTION_DEFS: ActionDef[] = [
  // Listing new products
  {
    name: "list",
    line: ['{"type":"list","count":<number>} - they want to list new products now and give how many ("2 shirts and a fridge" is 3).'],
    tool: { does: "They want to list new products now and say how many (\"2 shirts and a fridge\" is 3). Not while a batch is being sent: its products' details are step.", fields: { count: int("How many products.") }, required: ["count"] },
    sample: { message: "I want to list 3 products", args: { count: 3 } },
  },
  {
    name: "restart",
    line: ['{"type":"restart"} - they want to list but give no number, or start a new batch, or stop or start over the batch they are sending.'],
    lineIn: { drafts: ['{"type":"restart"} - start a new batch, or stop this one.'] },
    tool: { does: "They want to list but give no number (never ask how many: this asks), start a new listing or batch, put this one on hold to list another, or stop or start over the batch they are sending." },
    sample: { message: "let's list some products", args: {} },
  },
  {
    name: "step",
    line: ['{"type":"step"} - while a product is being sent: its details (price, sizes, colours, quantity, brand, condition, SKU, "use as note"), or that its photos are done.'],
    tool: { does: "While a batch's products are being sent: a product's details (price, sizes, colours, pieces, quantity, brand, condition, SKU, notes, \"use as note\"), that its photos are done, or anything about the product being sent." },
    sample: { message: "price 200, sizes M and L", args: {} },
  },
  {
    name: "category_info",
    line: ['{"type":"category_info","product":"<the kind of product>"} - which category, or what Jumia needs, for a kind of product.'],
    tool: { does: "Which category, or what Jumia needs, for a kind of product.", fields: { product: str("The kind of product.") }, required: ["product"] },
    sample: { message: "what does Jumia need to list a perfume?", args: { product: "perfume" } },
  },

  // Drafts
  {
    name: "edit",
    line: [
      '{"type":"edit","edits":[{"products":[<draft numbers>],"said":"<their words for which draft, or null>","changes":{...},"ask":false}]} - change drafts. "changes" holds ONLY what they asked to change:',
      '  "price" (number), "quantity" (whole number), "variations" (the full list the draft should have; where its category lists options, each as',
      '  {"said":"<their words>","option":"<the ONE option they mean>"}: "Large" is L), "title", "brand", "color" (copied from the message),',
      '  "sale": true, "other": "<a field name>". Every number and word from the message. "ask": true when their words fit more than one draft.',
    ],
    // One change a call, not a list of them: with a list, draft edits ran to
    // 10 s writing empty {"products":[1],"changes":{}} entries again and again
    // (test runs of 10 and 11 Oct; with maxItems on the lists, every call got a 400). Two
    // different changes are two calls.
    tool: {
      does: "Change drafts in their batch (only the drafts listed in the context): one change to the drafts it names; a different change to other drafts is another edit call. Only what they asked to change, every value from the message, in changes (price, variations, colour…), never in said.",
      fields: {
        products: arr(int("A draft number."), "The drafts it applies to (\"Product 1 …\" is [1]; the only draft is [1])."),
        said: str("Only their words naming which draft (\"the wig\"), never the values; leave it out when they gave the number or there is one draft."),
        changes: obj({
          price: num("New price."), quantity: int("New quantity."),
          variations: arr(obj({ said: str("Their words."), option: str("The one category option they mean, e.g. \"Large\" is L.") }), "The full list of variations the draft should have."),
          title: str("New name, copied."), brand: str("New brand, copied."), color: str("Colour, copied."),
          sale: bool("A sale price with dates (read from the message)."), other: str("Another field they want changed."),
        }),
        ask: bool("True when their words fit more than one draft and they didn't say all."),
      },
      required: ["products", "changes"],
    },
    // The tool takes one change; the chat's edit action, a list of them.
    toJson: (args) => (Array.isArray(args.edits) ? { type: "edit", ...args }
      : { type: "edit", edits: [{ products: args.products, said: args.said ?? null, changes: args.changes ?? {}, ask: args.ask === true }] }),
    sample: { message: "make product 1 150", args: { products: [1], changes: { price: 150 } } },
  },
  {
    name: "submit",
    line: ['{"type":"submit","products":"all" or [<numbers>]} - send drafts to Jumia.'],
    tool: { does: "Send drafts to Jumia.", fields: { all: bool("All the drafts."), products: arr(int("A draft number."), "The drafts to send, when not all.") } },
    toJson: (args) => {
      const out: Args = { type: "submit", ...args, products: args.all === true || !Array.isArray(args.products) || args.products.length === 0 ? "all" : args.products };
      delete out.all;
      return out;
    },
    sample: { message: "submit them all", args: { all: true } },
  },
  {
    name: "polish",
    line: ['{"type":"polish","product":<draft number or null>} - make polished photos for a draft.'],
    tool: { does: "Make polished photos for a draft.", fields: { product: int("The draft number, if they named one.") } },
    toJson: (args) => ({ type: "polish", ...args, product: args.product ?? null }),
    sample: { message: "polish the photos of product 1", args: { product: 1 } },
  },
  {
    name: "review",
    line: ['{"type":"review"} - open their drafts.'],
    tool: { does: "Open their drafts or listings page." },
    sample: { message: "open my drafts", args: {} },
  },
  {
    name: "draft_text",
    line: ['{"type":"draft_text","products":[<draft numbers>]} - show drafts as drafted: name, price, sizes, highlights and description. A product already on Jumia is product_text.'],
    tool: {
      does: "Show drafts as drafted: name, price, sizes, highlights and description (\"show me the highlights you wrote for the first one\", \"what did you write for draft 2\"). Drafts only: a product already on Jumia is product_text.",
      fields: { products: arr(int("A draft number."), "The drafts to show (\"the first one\" is 1).") }, required: ["products"],
    },
    sample: { message: "show me what you wrote for draft 1", args: { products: [1] } },
  },

  // Live products
  {
    name: "live_change",
    line: [
      '{"type":"live_change","product":"<their words for the product>","stock":<number>} - change one product already on Jumia. Instead of "stock",',
      '  exactly one of: "price":<number>, "sale_price":<number> (dates are read from the message), "sale":"end", "active":true or false.',
      '  Several products, the same change: "products":["<words>","<words>"]. Values from the message.',
    ],
    tool: {
      does: "Change one or several products already on Jumia: exactly one of stock, price, sale_price, end_sale or active. One product's stock, ON/OFF or end of sale is done straight away; the rest is offered for a confirm tap.",
      fields: {
        product: PRODUCT, products: arr(str("A product."), "Several products, the same change."),
        stock: int("New stock."), price: num("New price (\"sell it at 120\", \"make it 120\")."),
        sale_price: num("A sale price, only when they say sale, discount, promo or off (dates are read from the message)."),
        end_sale: bool("End its sale."), active: bool("true to turn it ON, false to turn it OFF."), all: bool("Every product their words fit (\"all the hard hats\")."),
      },
    },
    toJson: endSale("live_change"),
    sample: { message: "set the kettle stock to 5", args: { product: "kettle", stock: 5 } },
  },
  {
    name: "bulk",
    line: [
      '{"type":"bulk","scope":"all" or "out_of_stock" or "low_stock" or "inactive" or "active" or "matching" or "listed","words":"<their words, for matching>" or null,',
      '  plus one of "price_pct", "sale_pct", "stock", "price", "sale_price", "sale":"end", "active"} - one change to many products by a rule;',
      '  "listed" is the products you last listed for them ("those", "the last 10", "all" right after your list).',
    ],
    tool: {
      does: "One change to many products by a rule, shown before one tap: prices or a sale by a percentage, a stock, a price, ending sales, ON or OFF.",
      fields: {
        scope: str("Which products. \"listed\": the products you last listed for them (\"those\", \"them\", \"the last 10\", and \"all\" right after your list). \"matching\": the products their words name.", ["all", "out_of_stock", "low_stock", "inactive", "active", "matching", "listed"]),
        words: str("Their words for the products, for matching."),
        price_pct: num("Prices up (+) or down (-) by this %."), sale_pct: num("A sale this % off."),
        stock: int("Stock to set."), price: num("Price to set."), sale_price: num("Sale price to set."),
        end_sale: bool("End sales."), active: bool("true ON, false OFF."),
      },
      required: ["scope"],
    },
    toJson: endSale("bulk"),
    sample: { message: "raise all my prices by 5%", args: { scope: "all", price_pct: 5 } },
  },
  {
    name: "content_change",
    line: [
      '{"type":"content_change","product":"<the product>","name":"<copied>" or null,"description":"<copied>" or null,"highlights":null,"brand":null,"rewrite":["name","description","highlights"] or []} - a live product\'s',
      '  name, description or highlights: their own text copied whole, or "rewrite" for what they ask YOU to write (PandaWorld writes it with AI and shows it before one tap).',
      '  Its other details go in the same action: "details":{"<the detail in their words: colour, material, weight, model…>":"<value copied>"},',
      '  "barcode":"<digits copied>", "size":{"from":"<the size now, or null>","to":"<the new size name>"} (renaming one of its sizes).',
    ],
    tool: {
      does: "A live product's name, description, highlights, brand, other details, barcode or a size's name. Their own text copied, or rewrite for what they ask you to write.",
      fields: {
        product: PRODUCT, name: str("New name, copied."), description: str("New description, copied whole."), highlights: str("New highlights, copied."),
        brand: str("New brand, copied."), rewrite: arr(str("A field.", ["name", "description", "highlights"]), "Fields they ask you to write or improve."),
        details: arr(obj({ detail: str("The detail in their words: colour, material, weight, model…"), value: str("The value, copied.") }), "Other details."),
        barcode: str("Barcode digits, copied."), size: obj({ from: str("The size now."), to: str("The new size name.") }),
      },
      required: ["product"],
    },
    // Details come as a list of {detail, value}; the chat takes a record.
    toJson: (args) => {
      const details = Array.isArray(args.details) ? args.details as { detail?: unknown; value?: unknown }[] : [];
      return {
        type: "content_change", ...args,
        details: details.length
          ? Object.fromEntries(details.filter((d) => typeof d.detail === "string" && typeof d.value === "string").map((d) => [d.detail as string, d.value as string]))
          : undefined,
        rewrite: Array.isArray(args.rewrite) ? args.rewrite : [],
      };
    },
    sample: { message: "rewrite the description of the kettle", args: { product: "kettle", rewrite: ["description"] } },
  },
  {
    name: "add_size",
    line: ['{"type":"add_size","product":"<their words>","size":"<the new size or colour, copied>","stock":<number> or null,"price":<number> or null} - a new size or colour for a product already on Jumia, its stock and price from the message.'],
    tool: {
      does: "A new size or colour for a product already on Jumia, with its stock and price from the message.",
      fields: { product: PRODUCT, size: str("The new size or colour, copied."), stock: int("Stock, from the message."), price: num("Price, from the message.") },
      required: ["product", "size"],
    },
    sample: { message: "add size XL to the gown, 4 pieces at 150", args: { product: "gown", size: "XL", stock: 4, price: 150 } },
  },
  {
    name: "add_photos",
    line: ['{"type":"add_photos","product":"<their words>"} - more photos for a product already on Jumia (they send them next).'],
    tool: { does: "More photos for a product already on Jumia (they send them next).", fields: { product: PRODUCT }, required: ["product"] },
    sample: { message: "I want to add more pictures to the neck fan", args: { product: "neck fan" } },
  },
  {
    name: "fix_rejected",
    line: ['{"type":"fix_rejected","product":"<their words>" or null,"reason":"<Jumia\'s reason as they pasted it>" or null} - fix products Jumia\'s quality check rejected: null product to see them and pick one.'],
    tool: {
      does: "Fix products Jumia's quality check rejected. Leave product out when they mean all of them or none in particular (they see the list and pick one).",
      fields: { product: str("One rejected product in their words; never \"rejected\" or \"all\"."), reason: str("Jumia's reason as they pasted it.") },
    },
    sample: { message: "fix my rejected products", args: {} },
  },
  {
    name: "warehouse_order",
    line: ['{"type":"warehouse_order","items":[{"product":"<their words>","quantity":<number>}]} - send stock to Jumia\'s warehouse.'],
    tool: { does: "Send stock to Jumia's warehouse.", fields: { items: arr(obj({ product: PRODUCT, quantity: int("How many.") }), "Products and quantities.") }, required: ["items"] },
    sample: { message: "send 10 kettles to the Jumia warehouse", args: { items: [{ product: "kettles", quantity: 10 }] } },
  },
  {
    name: "warehouse_shipped",
    line: ['{"type":"warehouse_shipped","po":"<from the message>","tracking":"<from the message>","carrier":null} - a warehouse delivery has shipped.'],
    tool: { does: "A delivery to Jumia's warehouse has shipped.", fields: { po: str("Purchase order number."), tracking: str("Tracking number."), carrier: str("Carrier.") }, required: ["po", "tracking"] },
    sample: { message: "PO 4500123 has shipped, tracking TRK998877", args: { po: "4500123", tracking: "TRK998877" } },
  },

  // Their shop
  {
    name: "product_info",
    line: ['{"type":"product_info","product":"<their words for the product>"} - where one product is: on or off, quality check, price, sale, stock.'],
    lineIn: { live_products: ['{"type":"product_info","product":"<their words>"} - when it is really a question about a product (is it on, approved, in stock).'] },
    tool: { does: "Where one product is: ON or OFF, quality check, price, sale, stock.", fields: { product: PRODUCT }, required: ["product"] },
    sample: { message: "is the kettle live?", args: { product: "kettle" } },
  },
  {
    name: "product_text",
    line: ['{"type":"product_text","product":"<their words>"} - one product\'s name, description and highlights as Jumia has them now ("show me its description", "print the description so I can edit it").'],
    lineIn: { live_products: ['{"type":"product_text","product":"<their words>"} - show a product\'s name, description and highlights as Jumia has them now, so they can read or edit them.'] },
    tool: { does: "A product's name, description and highlights as Jumia has them, to read or edit.", fields: { product: PRODUCT }, required: ["product"] },
    sample: { message: "show me the kettle's description", args: { product: "kettle" } },
  },
  {
    name: "stock",
    line: ['{"type":"stock","product":"<their words>" or null,"filter":"out" or "low" or null} - how many are left of a product, or what is out of stock or low.'],
    tool: { does: "How many are left of a product, or what is out of stock or low.", fields: { product: PRODUCT, filter: str("Which.", ["out", "low"]) } },
    sample: { message: "what's out of stock?", args: { filter: "out" } },
  },
  {
    name: "shop",
    line: ['{"type":"shop","filter":"all" or "inactive" or "rejected"} - an overview with counts (on, off, out of stock, waiting, rejected, deleted), or the products turned off, or rejected by quality check.'],
    tool: { does: "An overview with counts, or the products turned OFF, or rejected by quality check.", fields: { filter: str("Which.", ["all", "inactive", "rejected"]) } },
    sample: { message: "how many of my products are on?", args: { filter: "all" } },
  },
  {
    name: "research",
    line: [
      '{"type":"research","needs":[<up to 4 reads>]} - read their shop and answer with what it shows, organised as asked: their newest or oldest',
      '  products, products sorted or filtered, orders with their items, sales by product, or several at once. Reads:',
      '  {"source":"products","sort":"newest" or "oldest" or "price_high" or "price_low" or "stock_low" or "stock_high" or "name","filter":"all" or',
      '  "active" or "inactive" or "rejected" or "pending" or "out_of_stock" or "low_stock" or "on_sale","words":"<their words>" or null,',
      '  "limit":<up to 30; 10 if not said; 30 for "all" of a group>,"since":null or a period}; {"source":"orders","period":<period>,"status":null,"limit":<up to 30>};',
      '  A list longer than 30 comes 30 at a time: give the first 30 (the answer tells them to say "more" for the next).',
      '  {"source":"product_sales","period":<period>}; {"source":"sales_summary","period":<period>}; {"source":"payouts"};',
      '  {"source":"pandaworld_listings","period":<period>}. A period is "today", "yesterday", "week", "month" or "quarter".',
    ],
    tool: {
      does: "Read their shop and answer as asked: products sorted or filtered, orders with items, sales by product, payouts, what PandaWorld listed; up to 4 reads.",
      fields: {
        needs: arr(obj({
          source: str("What to read.", ["products", "orders", "product_sales", "sales_summary", "payouts", "pandaworld_listings"]),
          sort: str("Products: order.", ["newest", "oldest", "price_high", "price_low", "stock_low", "stock_high", "name"]),
          filter: str("Products: which.", ["all", "active", "inactive", "rejected", "pending", "out_of_stock", "low_stock", "on_sale"]),
          words: str("Products: their words to match."),
          limit: int("How many (up to 30; 10 if not said)."),
          since: str("Products: added in this period.", PERIOD),
          period: str("Orders and sales: the period.", PERIOD),
          status: str("Orders: one status.", STATUS),
        }, ["source"]), "The reads."),
      },
      required: ["needs"],
    },
    sample: { message: "my last 10 products", args: { needs: [{ source: "products", sort: "newest", limit: 10 }] } },
  },
  {
    name: "report",
    line: ['{"type":"report","kind":"best_sellers" or "slow_movers" or "restock" or "returns","period":"week" or "month" or "quarter"} - one report.'],
    tool: {
      does: "One report on what sells: best sellers, slow movers, restock, returns (\"reports\" on its own: best_sellers). How the shop is doing overall is health_report.",
      fields: { kind: str("Which.", ["best_sellers", "slow_movers", "restock", "returns"]), period: str("Period.", ["week", "month", "quarter"]) }, required: ["kind"],
    },
    sample: { message: "my best sellers this month", args: { kind: "best_sellers", period: "month" } },
  },
  {
    name: "health_report",
    line: ['{"type":"health_report"} - a full health check of their shop ("write a report on my shop", "how is my shop doing").'],
    tool: { does: "A full health check of their shop: \"how is my shop doing\", \"insight into my shop's performance\", \"write a report on my shop\"." },
    sample: { message: "how is my shop doing?", args: {} },
  },
  {
    name: "listings",
    line: ['{"type":"listings","period":"today" or "yesterday" or "week" or "month" or "quarter"} - how many they listed with PandaWorld.'],
    tool: { does: "How many products they listed with PandaWorld in a period.", fields: { period: str("Period.", PERIOD) } },
    sample: { message: "how many listings have I done today?", args: { period: "today" } },
  },
  {
    name: "brand_check",
    line: ['{"type":"brand_check","brand":"<from the message>","product":null} - whether a brand is on Jumia and allowed.'],
    tool: { does: "Whether a brand is on Jumia and allowed.", fields: { brand: str("The brand, copied."), product: str("The kind of product.") }, required: ["brand"] },
    sample: { message: "is Lattafa a brand on Jumia?", args: { brand: "Lattafa" } },
  },
  {
    name: "shops",
    line: ['{"type":"shops"} - the shops under their Jumia account.'],
    tool: { does: "The shops under their Jumia account." },
    sample: { message: "which shops are under my account?", args: {} },
  },
  {
    name: "warehouse_stock",
    line: ['{"type":"warehouse_stock","product":"<their words>"} - what Jumia\'s warehouse holds.'],
    tool: { does: "What Jumia's warehouse holds of a product.", fields: { product: PRODUCT }, required: ["product"] },
    sample: { message: "how many kettles does the Jumia warehouse have?", args: { product: "kettles" } },
  },

  // Orders
  {
    name: "orders",
    line: ['{"type":"orders"} - orders waiting to be packed.'],
    tool: { does: "Orders waiting to be packed." },
    sample: { message: "orders", args: {} },
  },
  {
    name: "order_status",
    line: ['{"type":"order_status","number":"<the order number from the message or the conversation>"} - one order.'],
    tool: { does: "One order, by its number (\"#394666919\", \"tell me about this one #394666919 · GHS 94\").", fields: { number: str("The order number from the message or the conversation, digits only.") }, required: ["number"] },
    sample: { message: "where is order 355926919", args: { number: "355926919" } },
  },
  {
    name: "sales",
    line: [
      '{"type":"sales","period":"today" or "yesterday" or "week" or "month" or "quarter","status":null or one or a list of "cancelled",',
      '  "delivered","returned","failed","pending","ready_to_ship","shipped"} - their orders and sales in a period; "quarter" is 90 days, also "ever".',
    ],
    tool: { does: "Their orders and sales in a period, optionally with statuses.", fields: { period: str("Period.", PERIOD), status: arr(str("A status.", STATUS), "Statuses.") } },
    // Statuses come as a list; the chat takes none, one, or a list.
    toJson: (args) => (Array.isArray(args.status)
      ? { type: "sales", ...args, status: args.status.length === 0 ? null : args.status.length === 1 ? args.status[0] : args.status }
      : { type: "sales", ...args }),
    sample: { message: "how did I do today", args: { period: "today" } },
  },

  // Money and account
  {
    name: "credits",
    line: ['{"type":"credits"} - their credit balance.'],
    tool: { does: "Their credit balance, with a button to buy more: always this for \"my credits\", \"how many credits\", even when About this seller shows a number." },
    sample: { message: "how many credits do I have?", args: {} },
  },
  {
    name: "payouts",
    line: ['{"type":"payouts"} - the last Jumia payout and what is not paid yet.'],
    tool: { does: "The last Jumia payout and what isn't paid yet." },
    sample: { message: "has jumia paid me?", args: {} },
  },
  {
    name: "payout_detail",
    line: ['{"type":"payout_detail","mode":"history" or "breakdown","statement":"<a statement number from the message>" or null} - every statement, or one in detail.'],
    tool: { does: "Every statement (history), or one statement's fees and refunds (breakdown).", fields: { mode: str("Which.", ["history", "breakdown"]), statement: str("A statement number from the message.") }, required: ["mode"] },
    sample: { message: "show my payout history", args: { mode: "history" } },
  },
  {
    name: "fees",
    line: ['{"type":"fees","product":"<their words>","price":<a number from the message> or null} - what Jumia takes and what they receive when it sells.'],
    tool: { does: "What Jumia takes and what they receive when a product sells (\"how much will I receive if it sells\").", fields: { product: PRODUCT, price: num("A price from the message.") }, required: ["product"] },
    sample: { message: "what does jumia charge if I sell the boot at 120", args: { product: "boot", price: 120 } },
  },
  {
    name: "help",
    line: ['{"type":"help"} - what PandaWorld can do, when they ask in general.'],
    tool: { does: "What PandaWorld can do, when they ask in general." },
    sample: { message: "what can you do?", args: {} },
  },

  // Saying, not doing: in every reading.
  {
    name: "cannot",
    line: ['{"type":"cannot","what":"<a key from Not possible from here>"} - they ask for (or ask whether you can do) one of these: PandaWorld gives the true answer and what it can do instead.'],
    tool: { does: "They ask for something on the Not possible list: PandaWorld gives the true answer.", fields: { what: str("A key from Not possible from here.") }, required: ["what"] },
    sample: { message: "delete the kettle from my shop", args: { what: "delete_product" } },
  },
  {
    // "Can you…?" answered from the capability list, and what PandaWorld
    // doesn't do answered with one fixed line and noted (owner, 2026-10-11).
    name: "capability",
    line: ['{"type":"capability","what":"<a key from What the chat does>"} - they ask whether you can do something ("can you…?", "is it possible to…?", "do you do…?") without saying what to do it to: PandaWorld answers from its list, with the words that do it. When they say what to do and to which product ("can you set the kettle\'s stock to 20?", "can you fix my rejected products?"), do it with its action instead.'],
    tool: {
      does: "They ask whether you can do something (\"can you…?\", \"is it possible to…?\", \"do you do…?\") without saying what to do it to: PandaWorld answers from its list, with the words that do it. When they say what to do and to which product, call the tool that does it instead.",
      fields: { what: str("A key from What the chat does.") }, required: ["what"],
    },
    sample: { message: "can you change prices?", args: { what: "live_price" } },
  },
  {
    name: "not_yet",
    line: ['{"type":"not_yet","what":"<what they asked for, in a few words>","outside":false} - they ask for something no action here does and that isn\'t on Not possible: PandaWorld says it can\'t do that yet and notes the request. "outside":true when it has nothing to do with Jumia, selling or PandaWorld (the weather, football, homework).'],
    tool: {
      does: "They ask for something no tool does and that isn't on Not possible: PandaWorld says it can't do that yet and notes the request. outside: true when it has nothing to do with Jumia, selling or PandaWorld.",
      fields: { what: str("What they asked for, in a few words."), outside: bool("Nothing to do with Jumia, selling or PandaWorld (the weather, football, homework).") },
      required: ["what"],
    },
    sample: { message: "can you post my products on instagram?", args: { what: "post products on Instagram" } },
  },
  {
    name: "reply",
    line: ['{"type":"reply","text":"<your message>","link":"<a link key, or null>"} - a question you answer in a line or two; a hello; anything this area\'s actions don\'t cover.'],
    tool: {
      does: "A short answer in your words: a hello, thanks, a question about PandaWorld or their account, anything the other tools don't cover. Never says you did, paused, stopped, changed or will change anything, never gives a number about their shop or credits (tools read them), and never says PandaWorld can't do something or sends them to Vendor Center for it (what isn't possible is cannot; what PandaWorld doesn't do, not_yet; the rest has a tool).",
      fields: { text: str("Your message."), link: str("A link key, if one fits.") }, required: ["text"],
    },
    sample: { message: "thanks", args: { text: "You're welcome! 🙌" } },
  },
  {
    name: "clarify",
    line: ['{"type":"clarify","question":"<one short question, ending with ?>","options":["<2 or 3 answers they can tap, each up to 20 characters and clear on its own, e.g. \\"Stock to 10\\", not \\"10\\">"]} - only when you can\'t tell which action or which product they mean, or a change is missing the value to set (e.g. "change the drone to 10": its stock or its price?).'],
    tool: {
      does: "Only when you can't tell which action or which product, or a change has no value: one short question with 2 or 3 answers to tap.",
      fields: { question: str("The question, ending with ?"), options: arr(str("An answer they can tap, up to 20 characters, clear on its own."), "2 or 3 answers.") },
      required: ["question", "options"],
    },
  },
];

const BY_NAME = new Map(ACTION_DEFS.map((d) => [d.name, d]));

/** One action's definition, or undefined for a name that isn't one. */
export const actionDef = (name: string): ActionDef | undefined => BY_NAME.get(name);

/** In every front door reading, after the area's own actions: what it says rather than does, and asking back. */
export const EVERY_READING = ["reply", "cannot", "capability", "not_yet", "clarify"];

/** The lines the front door's reading call is shown for these actions in this area, in order. */
export function actionLines(names: string[], area?: Area): string[] {
  return names.flatMap((n) => {
    const d = BY_NAME.get(n);
    if (!d) throw new Error(`no action "${n}"`);
    return (area && d.lineIn?.[area]) || d.line;
  });
}

/** Every action as agent mode's tool, in the registry's order. */
export function actionTools(): GeminiTool[] {
  return ACTION_DEFS.map((d) => ({ name: d.name, description: d.tool.does, parameters: obj(d.tool.fields ?? {}, d.tool.required ?? []) }));
}

/** A tool call as the chat's own action JSON (what parseAction reads). Pure. */
export function actionJson(name: string, args: Args): Args {
  const d = BY_NAME.get(name);
  return d?.toJson ? d.toJson(args) : { type: name, ...args };
}
