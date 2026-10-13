/**
 * What Jumia's quality check said about the owner's 11 rejected products
 * (2026-10-12), read into the fix each needs; the seller's answers read into
 * what Jumia takes; a rewrite shown in WhatsApp's formatting.
 */

jest.mock("@/lib/ai/gemini-client", () => ({ callGeminiBackend: async () => { throw new Error("no AI here"); } }));

import { qcActionFromTable, type QcContext } from "@/lib/jumia/qc-remedy";
import { parseBrandAnswer, parseWeightKg, warrantyAnswer } from "@/lib/jumia/qc-answers";
import { htmlToWhatsApp } from "@/lib/whatsapp/html-text";
import { askedAbout, chatOnly, fixPlan, isAgreement, isTheQuestion, withoutWords } from "@/lib/whatsapp/fix-rejected";
import type { JumiaCategoryAttribute } from "@/lib/jumia/categories";

const fields = [
  { name: "product_weight", label: "Weight (kg)" }, { name: "product_warranty", label: "Product warranty" },
  { name: "warranty_duration", label: "Warranty Duration" }, { name: "warranty_type", label: "Warranty Type" }, { name: "fda", label: "FDA" },
];
const ctx = (comment: string, extra: Partial<QcContext> = {}): QcContext =>
  ({ reason: null, comment, title: "A product", brand: "Generic", categoryPath: null, fields, ...extra });

describe("the owner's rejected products (2026-10-12)", () => {
  it("weight: asked for, in kg, for the weight field; never a rewrite", () => {
    expect(qcActionFromTable(ctx("Please confirm and update the actual weight of the product, as the current weight information appears to be inaccurate or missing.\nFor example, a T-shirt listed as 15 kg instead of 150 g is incorrect and can lead to shipping and listing issues.\n\nProviding the accurate weight is essential for:\n\nCorrect product classification\n\nAccurate shipping fee calculation\n\nMake sure to enter the weight in kilograms (kg).")))
      .toMatchObject({ kind: "ask_value", about: "weight", field: "product_weight" });
  });

  it("warranty: asked for; the word 'description' in it no longer makes it a rewrite", () => {
    expect(qcActionFromTable(ctx("For listing this type of product requires a valid warranty as per our platform guidelines.\nTo proceed, please ensure the warranty details are clearly mentioned in:\n\nProduct Description tab\n\nWarranty Tab.")))
      .toMatchObject({ kind: "ask_value", about: "warranty", field: "product_warranty" });
  });

  it("a brand word in the description is taken out, not 'your shop can't sell this brand'", () => {
    expect(qcActionFromTable(ctx("Restricted Brand: Nivea in DESCRIPTION - Seller not in approved list")))
      .toMatchObject({ kind: "remove_words", words: ["Nivea"] });
  });

  it("a name Jumia read as a brand is reworded", () => {
    expect(qcActionFromTable(ctx("Kindly use the brand name on the package ... If not in the system, please fill out the form at: https://bit.ly/2kpjja8.\nYou will receive an email within the coming 48 working hours the result of your request (Brand field 'Fashion' but name starts with: Kinky Curly)")))
      .toMatchObject({ kind: "rename", start: "Kinky Curly" });
  });

  it("Generic not accepted: the brand is asked; FDA: its field; a suggested category, a missing reason: as before", () => {
    expect(qcActionFromTable(ctx("Brand 'Generic' is not a recognized brand for a 20000mAh powerbank. Please list this product under a genuine, specific brand name.")))
      .toMatchObject({ kind: "ask_brand" });
    expect(qcActionFromTable(ctx("Kindly Provide Product's Health/Food Regulation Registration Number. (Mandatory FDA registration number is missing.)")))
      .toMatchObject({ kind: "ask_value", field: "fda" });
    expect(qcActionFromTable(ctx("Category mismatch: AI suggests Grocery / Beverages / Bottled Beverages, Water & Drink Mixes / Soft Drinks (shares 3 path segments but leaf differs)")))
      .toMatchObject({ kind: "switch_category" });
    expect(qcActionFromTable(ctx("Rejected"))).toMatchObject({ kind: "ask_details" });
  });

  it("a restricted brand that is the product's own brand still can't be fixed by a word", () => {
    expect(qcActionFromTable(ctx("Restricted brand - seller not in approved list"))).toMatchObject({ kind: "cannot_fix" });
  });
});

describe("the seller's answers", () => {
  it("weights, in kg", () => {
    expect(parseWeightKg("350 g")).toEqual({ kg: "0.35" });
    expect(parseWeightKg("0.35kg")).toEqual({ kg: "0.35" });
    expect(parseWeightKg("1.2 kilos")).toEqual({ kg: "1.2" });
    expect(parseWeightKg("2")).toEqual({ kg: "2" });
    expect(parseWeightKg("1,500 grams")).toEqual({ kg: "1.5" });
    expect(parseWeightKg("it weighs 250g packed")).toEqual({ kg: "0.25" });
    expect(parseWeightKg("350")).toEqual({ unit: 350 });
    expect(parseWeightKg("heavy")).toBeNull();
  });

  it("brands: said in so many words, or the bare reply", () => {
    expect(parseBrandAnswer("Chnage the brant to pro", false)).toBeNull();
    expect(parseBrandAnswer("change the brand to pro", false)).toBe("pro");
    expect(parseBrandAnswer("the brand is Oraimo please", false)).toBe("Oraimo");
    expect(parseBrandAnswer("brand: Samsung", false)).toBe("Samsung");
    expect(parseBrandAnswer("fix the kinky curly wig", false)).toBeNull();
    expect(parseBrandAnswer("Oraimo", true)).toBe("Oraimo");
    expect(parseBrandAnswer("none", true)).toBe("Generic");
    expect(parseBrandAnswer("what was the old one?", true)).toBeNull();
  });

  it("a warranty: their words, and the options Jumia has for its length and kind", () => {
    const a = (name: string, type: string, allowed: string[] = []) => ({ name, label: name, type, allowed_values: allowed }) as unknown as JumiaCategoryAttribute;
    const attrs = [a("product_warranty", "textarea"), a("warranty_duration", "enum", ["1 Year", "6 Months", "2 Years"]), a("warranty_type", "multi", ["Repair by Vendor", "Replacement by Vendor"])];
    expect(warrantyAnswer("12 months replacement", attrs).details).toEqual({ product_warranty: "12 months replacement", warranty_duration: "1 Year", warranty_type: "Replacement by Vendor" });
    expect(warrantyAnswer("6 months, repair by the shop", attrs).details).toMatchObject({ warranty_duration: "6 Months", warranty_type: "Repair by Vendor" });
    // No option for 9 months: their words only.
    expect(warrantyAnswer("9 months", attrs).details).toEqual({ product_warranty: "9 months" });
  });
});

describe("fixes", () => {
  it("words come out of the name, description and highlights; what doesn't change isn't sent", () => {
    const set = { name: "Nivea Cocoa Body Lotion", description: "<p>Like Nivea, it softens.</p>", attributes: [{ name: "short_description", value: "<ul><li>Soft skin</li></ul>" }] };
    expect(withoutWords(set, ["Nivea"])).toEqual({ name: "Cocoa Body Lotion", description: "<p>Like, it softens.</p>" });
    expect(withoutWords(set, ["Dove"])).toEqual({});
  });

  it("the plans say what was done and what's next", () => {
    expect(fixPlan({ kind: "remove_words", words: ["Nivea"], why: "Jumia's quality check won't take \"Nivea\" in the listing from your shop." }, "Cocoa Body Lotion", ""))
      .toMatchObject({ kind: "remove", words: ["Nivea"], intro: expect.stringContaining("I've taken it out and changed nothing else.") });
    expect(fixPlan({ kind: "rename", start: "Kinky Curly", why: "" }, "Kinky Curly Wig", ""))
      .toMatchObject({ kind: "rewrite", fields: ["name"], instructions: expect.stringContaining('must NOT begin with "Kinky Curly"') });
  });
});

// Owner's web chat, 2026-10-12 17:10: "Update it for me on my JUMIA shop"
// after the weight question meant "send what Jumia has" (switch assistant_followup).
describe("agreeing with what Jumia has now", () => {
  it("yes, that's right, update it: typos and filler words too", () => {
    for (const t of ["yes", "Yess", "yeah", "ok", "that's right", "That is correct", "it is correct", "correct", "corect", "same",
      "it's the same", "keep it", "keep it as it is", "update it", "updte it", "Update it for me on my JUMIA shop", "send it", "yes update it please", "resend it"]) {
      expect({ t, agrees: isAgreement(t) }).toEqual({ t, agrees: true });
    }
  });

  it("anything with its own content isn't agreeing", () => {
    for (const t of ["That is the weight listed", "That is the weight of the collagen booster", "yes but 0.1", "0.1kg", "no", "stop",
      "it is", "show me today's sales", "the brand is Pro", "Pro", "change the weight to 0.1kg",
      // Reviewing step 2: questions, and words one letter from "right".
      "is that correct?", "Is it right?", "is it the same?", "ok?", "right?", "good night", "it is light", "eight"]) {
      expect({ t, agrees: isAgreement(t) }).toEqual({ t, agrees: false });
    }
  });

  it("a question back is about it when it asks for its field, never just for naming the product", () => {
    const q = { ask: "value" as const, about: "weight" as const, fieldLabel: "Weight (kg)" };
    expect(askedAbout(q, "Jumia has 0.2 kg for it. Is the packed weight different?")).toBe(true);
    expect(askedAbout(q, "How many products are you listing now?")).toBe(false);
    expect(askedAbout(q, "Which Enhancement Dietary Supplement - Collagen Boosters do you mean?")).toBe(false);
    expect(askedAbout({ ...q, ask: "brand", about: null, fieldLabel: "Brand" }, "What brand is printed on it?")).toBe(true);
    expect(askedAbout({ ...q, about: null, fieldLabel: "FDA" }, "What is its FDA registration number?")).toBe(true);
    expect(askedAbout({ ...q, about: null, fieldLabel: "FDA" }, "Here are today's sales.")).toBe(false);
  });

  it("the bot's last message is the question when it carries the question's own words", () => {
    const asked = "🔍 *Collagen Boosters*: Jumia's quality check needs something only you have. What does it weigh, packed as it ships?";
    expect(isTheQuestion({ asked }, asked)).toBe(true);
    expect(isTheQuestion({ asked }, asked.replace(/\*/g, "").replace(/ /g, "  "))).toBe(true);
    expect(isTheQuestion({ asked }, "Collagen Boosters has 10 in stock on Jumia.")).toBe(false);
    expect(isTheQuestion({}, asked)).toBe(false);
  });

  it("chat words are never a value or a brand", () => {
    for (const t of ["ok thanks", "thank you so much", "ok noted", "No", "That's the brand", "it's wrong", "ok"]) expect({ t, chat: chatOnly(t) }).toEqual({ t, chat: true });
    for (const t of ["Pro", "Nasco", "0.1", "FDA/SD.255-112170", "12 months replacement"]) expect({ t, chat: chatOnly(t) }).toEqual({ t, chat: false });
  });

  it("the question names what Jumia has now, when it's known", () => {
    const weight = { kind: "ask_value" as const, field: "product_weight", fieldLabel: "Weight (kg)", about: "weight" as const, question: "What does it weigh, packed as it ships?" };
    expect(fixPlan(weight, "Collagen Boosters", "", undefined, null, "0.2 kg"))
      .toMatchObject({ kind: "say", text: expect.stringContaining("Jumia has 0.2 kg as its weight now and turned that down. What does it weigh") });
    expect(fixPlan(weight, "Collagen Boosters", "")).toMatchObject({ kind: "say", text: expect.not.stringContaining("Jumia has") });
    expect(fixPlan({ ...weight, field: "fda", fieldLabel: "FDA", about: undefined, question: "What is its FDA registration number?" }, "Shower Cream", "", undefined, null, "FDA/123"))
      .toMatchObject({ text: expect.stringContaining("Jumia has FDA/123 as its FDA now") });
  });
});

describe("a rewrite in WhatsApp's formatting", () => {
  it("bold, lists, headings and tables", () => {
    expect(htmlToWhatsApp("<p>Meet the <strong>Nasco Kettle</strong>, <em>fast</em>.</p><h3>Specs</h3><table><tr><th>Capacity</th><th>Power</th></tr><tr><td>1.7 L</td><td>2200 W</td></tr></table><ul><li><strong>Fast:</strong> boils in 3 minutes</li></ul>"))
      .toBe("Meet the *Nasco Kettle*, _fast_.\n\n*Specs*\n\n*Capacity* · *Power*\n1.7 L · 2200 W\n\n• *Fast:* boils in 3 minutes");
    expect(htmlToWhatsApp("<p>Tom &amp; Jerry&nbsp;mug</p><strong> </strong>")).toBe("Tom & Jerry mug");
  });
});
