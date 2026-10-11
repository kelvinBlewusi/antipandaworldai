/**
 * Jumia's published API spec (docs/jumia-api) against what PandaWorld says
 * about it (lib/jumia/capabilities.ts). Owner, 2026-10-11: "get the API doc
 * so we learn from there". When the spec is refreshed
 * (scripts/fetch-jumia-spec.mjs), this fails on whatever Jumia added or
 * changed, so it's placed on purpose: done in chat, Vendor Center only, or
 * not used and why.
 */

import { readFileSync } from "fs";
import path from "path";
import { CAPABILITIES, UNUSED_REQUESTS, UPDATE_TABLE } from "@/lib/jumia/capabilities";

const DOCS = path.join(__dirname, "..", "docs", "jumia-api");
const read = (rel: string) => readFileSync(path.join(DOCS, rel), "utf8");

/** Every documented request, as "METHOD /path". */
function documented(): string[] {
  const root = read("openapi.yaml");
  const ops: string[] = [];
  for (const m of Array.from(root.matchAll(/^ {2}(\/\S+):\n {4}\$ref: ['"]?([^'"\n]+)/gm))) {
    for (const method of Array.from(read(m[2]).matchAll(/^(get|post|put|patch|delete):/gm))) ops.push(`${method[1].toUpperCase()} ${m[1]}`);
  }
  return ops;
}

describe("Jumia's spec", () => {
  it("every documented request is behind a capability, or not used with a reason", () => {
    const ops = documented();
    expect(ops.length).toBeGreaterThanOrEqual(29);
    const used = new Set(CAPABILITIES.flatMap((c) => c.requests));
    for (const op of ops) expect({ op, placed: used.has(op) || op in UNUSED_REQUESTS }).toEqual({ op, placed: true });
    // And nothing named that Jumia doesn't document.
    for (const op of Array.from(used).concat(Object.keys(UNUSED_REQUESTS))) expect({ op, documented: ops.includes(op) }).toEqual({ op, documented: true });
  });

  it("what an update can touch is Jumia's own table, row for row", () => {
    const rows = Array.from(read("paths/feeds/feeds@products@update.yaml").matchAll(/^\s*\| ([^|]+?) \| (YES|NO) \|$/gm))
      .map((m) => ({ section: m[1], allowed: m[2] === "YES" }));
    expect(rows.length).toBe(11);
    expect(UPDATE_TABLE.map(({ section, allowed }) => ({ section, allowed }))).toEqual(rows);
  });

  it("a product read gives every photo and each country's QC reason and comment", () => {
    const products = read("paths/catalog/catalog@products.yaml");
    expect(products).toMatch(/^ {20}images:/m);
    expect(products).toContain("rejectionReason:");
    expect(products).toContain("rejectionComment:");
  });

  it("status takes ON and OFF only: there is no delete", () => {
    const status = read("paths/feeds/feeds@products@status.yaml");
    expect(Array.from(status.matchAll(/status: (\w+)/g)).map((m) => m[1]).sort()).toEqual(["ACTIVE", "INACTIVE"]);
    expect(CAPABILITIES.find((c) => c.id === "delete_product")).toMatchObject({ status: "vendor_center", requests: [] });
  });
});
