/**
 * What each category's quality check needs, learned from its rejections
 * (owner, 2026-10-13; docs/plan-2026-10-13-ask-what-jumia-needs.md step 5).
 * The reasons are the owner's rejected products' own words.
 */

import { FakeDb } from "./helpers/fake-supabase";

let db = new FakeDb();
jest.mock("@/lib/supabase/server", () => ({ createServerClient: () => db }));
jest.mock("@/lib/ai/gemini-client", () => ({ callGeminiBackend: async () => { throw new Error("no AI here"); } }));

import { _resetQcRequiredCache, learnQcRequirement, qcRequiredFor, qcRequirementOf, requirementsFromRejections } from "@/lib/jumia/qc-required";
import { qcActionFromTable, type QcAction, type QcContext } from "@/lib/jumia/qc-remedy";

beforeEach(() => { db = new FakeDb(); _resetQcRequiredCache(); });

const FDA = "Kindly Provide Product's Health/Food Regulation Registration Number. (Mandatory FDA registration number is missing.)";
const WEIGHT = "Please confirm and update the actual weight of the product, as the current weight information appears to be inaccurate or missing.";
const WARRANTY = "For listing this type of product requires a valid warranty as per our platform guidelines.";
const GENERIC = "Brand 'Generic' is not a recognized brand for a 20000mAh powerbank. Please list this product under a genuine, specific brand name.";
const USE_GENERIC = "Kindly avoid using Fashion on non-Fashion items instead use Generic as brand To create the actual brand name for this product, please fill out the form at: https://bit.ly/2kpjja8.";
const USE_FASHION = "Kindly avoid using Generic on Fashion items instead use Fashion as brand To create the actual brand name for this product, please fill out the form at: https://bit.ly/2kpjja8.";

const ctx = (comment: string, fields: QcContext["fields"] = []): QcContext =>
  ({ reason: null, comment, title: "A product", brand: "Generic", categoryPath: null, fields });
const act = (comment: string, fields: QcContext["fields"] = []) => qcActionFromTable(ctx(comment, fields))!;

describe("what a rejection says its category needs", () => {
  it("an FDA number: the category's field, or 'fda' (the description) where it has none", () => {
    expect(qcRequirementOf(act(FDA, [{ name: "fda", label: "FDA" }]), FDA)).toEqual({ field: "fda", label: "FDA", kind: "value" });
    expect(qcRequirementOf(act(FDA), FDA)).toEqual({ field: "fda", label: "FDA registration number", kind: "value" });
  });

  // The owner's shower cream, massager and perfume (1019709, 1016875, 1000844): no fda field,
  // only "certifications", a list of eco labels that won't take a number.
  it("an FDA number never goes in a certifications list", () => {
    const fields = [{ name: "certifications", label: "Certifications" }, { name: "product_weight", label: "Weight (kg)" }];
    expect(act(FDA, fields)).toMatchObject({ kind: "ask_value", field: null, fieldLabel: "FDA registration number" });
    expect(qcRequirementOf(act(FDA, fields), FDA)).toEqual({ field: "fda", label: "FDA registration number", kind: "value" });
    // A certificate asked for in so many words still goes there.
    expect(act("Please provide the product's safety certificate", fields)).toMatchObject({ field: "certifications" });
  });

  it("a warranty; a real brand; a name read as a brand", () => {
    expect(qcRequirementOf(act(WARRANTY, [{ name: "product_warranty", label: "Product warranty" }]), WARRANTY)).toEqual({ field: "product_warranty", label: "Warranty", kind: "value" });
    expect(qcRequirementOf(act(GENERIC), GENERIC)).toEqual({ field: "brand", label: "Brand", kind: "brand" });
    expect(qcRequirementOf({ kind: "rename", start: "Kinky Curly", why: "" }, "Kindly use the brand name on the package")).toEqual({ field: "brand", label: "Brand", kind: "brand" });
  });

  it("not the weight (required and estimated already), a placeholder brand, or a fix that asks nothing", () => {
    expect(qcRequirementOf(act(WEIGHT), WEIGHT)).toBeNull();
    expect(qcRequirementOf({ kind: "ask_value", field: null, fieldLabel: "Net weight", question: "What is it?" }, null)).toBeNull();
    expect(qcRequirementOf(act(USE_GENERIC), USE_GENERIC)).toBeNull();
    expect(qcRequirementOf(act(USE_FASHION), USE_FASHION)).toBeNull();
    for (const a of [{ kind: "redraft", why: "" }, { kind: "ask_photos", why: "" }, { kind: "remove_words", words: ["Nivea"], why: "" }, { kind: "ask_details" }] as QcAction[]) {
      expect(qcRequirementOf(a, "x")).toBeNull();
    }
  });
});

describe("recording and reading it", () => {
  it("records once, counts each time it's seen, and keeps Jumia's words", async () => {
    await learnQcRequirement(1019709, act(FDA), FDA);
    await learnQcRequirement(1019709, act(FDA), FDA);
    expect(db.tables.jumia_qc_required).toEqual([expect.objectContaining({
      category_code: 1019709, field: "fda", label: "FDA registration number", kind: "value", seen: 2, example: expect.stringContaining("Mandatory FDA registration number"),
    })]);
    expect(await qcRequiredFor(1019709)).toEqual([{ categoryCode: 1019709, field: "fda", label: "FDA registration number", kind: "value", example: expect.any(String), seen: 2 }]);
  });

  it("records nothing for a weight, an unknown category or a placeholder brand", async () => {
    await learnQcRequirement(1018796, act(WEIGHT), WEIGHT);
    await learnQcRequirement(null, act(FDA), FDA);
    await learnQcRequirement(NaN, act(FDA), FDA);
    await learnQcRequirement(1005888, act(USE_GENERIC), USE_GENERIC);
    expect(db.tables.jumia_qc_required ?? []).toEqual([]);
    expect(await qcRequiredFor(1018796)).toEqual([]);
  });

  it("a new one is read at once, not after the cache", async () => {
    expect(await qcRequiredFor(1000279)).toEqual([]);
    await learnQcRequirement(1000279, act(GENERIC), GENERIC);
    expect((await qcRequiredFor(1000279)).map((r) => r.field)).toEqual(["brand"]);
  });

  it("never fails the fix it runs in", async () => {
    const broken = { from: () => { throw new Error("relation \"jumia_qc_required\" does not exist"); } };
    const real = db;
    db = broken as unknown as FakeDb;
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    await expect(learnQcRequirement(1019709, act(FDA), FDA)).resolves.toBeUndefined();
    expect(await qcRequiredFor(1019709)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    db = real;
  });
});

// Seeding from the live rejections (2026-10-13): Jumia often gives several reasons in one.
describe("every reason in a rejection", () => {
  it("an FDA number asked beside a wrong category and a promotional word is learned", () => {
    const said = "Wrong Category: The product is a hot wax for hair removal, which does not fit in the body groomers category.; Product title contains forbidden promotional word: 'Hot'; Kindly Provide Product's Health/Food Regulation Registration Number";
    expect(requirementsFromRejections([{ categoryCode: 1005104, said, fields: [{ name: "fda", label: "FDA" }] }]).map((r) => r.field)).toEqual(["fda"]);
  });

  it("a real brand asked however the fix read it; a placeholder fix in any part of it is never one", () => {
    const core = "'Generic' brand is not allowed for core electronics (Phones, Tablets, Laptops, Desktops, TVs) — use the actual brand name";
    const books = "Kindly request for the creation of this product's actual brand name by filling this form: https://bit.ly/2kpjja8: Wrong Brand for Books: Please use Publisher's name as brand for Books";
    const fashionOk = "Generic brand is not allowed for fashion items — please use 'Fashion' or the actual brand name.";
    const outside = `${USE_GENERIC}\nYou will receive an email within the coming 48 working hours the result of your request — whether it's approved or rejected, along with the reason (Brand 'Fashion' used outside Fashion category: 1005888)`;
    const rows = requirementsFromRejections([
      { categoryCode: 1003018, said: core, fields: [] },
      { categoryCode: 1001422, said: books, fields: [] },
      { categoryCode: 1016521, said: fashionOk, fields: [] },
      { categoryCode: 1005888, said: outside, fields: [] },
    ]);
    expect(rows.map((r) => [r.categoryCode, r.field])).toEqual([[1001422, "brand"], [1003018, "brand"]]);
  });

  it("the live path learns them too", async () => {
    const said = "Restricted Brand: Product title contains forbidden promotional word: 'Quality'; Kindly Provide Product's Health/Food Regulation Registration Number";
    await learnQcRequirement(1005580, act(said), said);
    expect(db.tables.jumia_qc_required).toEqual([expect.objectContaining({ category_code: 1005580, field: "fda", label: "FDA registration number" })]);
  });
});

describe("the seed from past rejections", () => {
  it("each category's needs from the owner's rejected products, counted once each", () => {
    const fda = [{ name: "fda", label: "FDA" }, { name: "certifications", label: "Certifications" }];
    const certOnly = [{ name: "certifications", label: "Certifications" }];
    const rows = requirementsFromRejections([
      { categoryCode: 1019709, said: FDA, fields: certOnly },     // shower cream
      { categoryCode: 1001090, said: FDA, fields: fda },          // wig
      { categoryCode: 1029504, said: FDA, fields: fda },          // hard wax, three sizes listed apart
      { categoryCode: 1029504, said: FDA, fields: fda },
      { categoryCode: 1002300, said: WARRANTY, fields: [{ name: "product_warranty", label: "Product warranty" }] },
      { categoryCode: 1000279, said: GENERIC, fields: [] },       // power bank
      { categoryCode: 1018796, said: WEIGHT, fields: [] },        // collagen: not learned
      { categoryCode: 1005888, said: USE_GENERIC, fields: [] },   // baby carrier: a placeholder is the fix
      { categoryCode: 1013693, said: "Duplicate (same image): 'Leather Slide Sandals'", fields: [] },
    ]);
    expect(rows.map((r) => [r.categoryCode, r.field, r.kind, r.seen])).toEqual([
      [1000279, "brand", "brand", 1],
      [1001090, "fda", "value", 1],
      [1002300, "product_warranty", "value", 1],
      [1019709, "fda", "value", 1],
      [1029504, "fda", "value", 2],
    ]);
  });
});
