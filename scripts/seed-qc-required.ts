/**
 * One-off (and safely re-runnable) seed of jumia_qc_required from the
 * rejections already on record (owner, 2026-10-13;
 * docs/plan-2026-10-13-ask-what-jumia-needs.md step 5): what each
 * category's quality check asked sellers for (an FDA number, a warranty, a
 * real brand), read the same way the chat reads a rejection
 * (lib/jumia/qc-required.ts requirementsFromRejections, no AI).
 *
 * Rows already in the table are kept as they are (the chat counts them).
 *
 * Sources: jumia_products rejected by Jumia's quality check (one per
 * product, its sizes counted once; deleted ones too, since what Jumia asked
 * for still holds for the category) and PandaWorld listings Jumia rejected
 * (listings.jumia_qc_comment). Each row is upserted with the count seen;
 * a later rejection read by the chat adds to it.
 *
 * Run:
 *   npm run seed-qc-required            (prints what it would write)
 *   npm run seed-qc-required -- --write (writes it)
 *
 * Required env vars: NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY.
 */

import { createClient } from "@supabase/supabase-js";
import { requirementsFromRejections, type PastRejection } from "../lib/jumia/qc-required";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("✗ Missing Supabase credentials. Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local or your shell environment.");
  process.exit(1);
}
const WRITE = process.argv.includes("--write");
const PAGE_SIZE = 1000;

async function main() {
  const db = createClient(SUPABASE_URL!, SUPABASE_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });

  const seen = new Set<string>();
  const said: { code: number; text: string }[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db.from("jumia_products").select("user_id, set_sid, product_sid, category_code, qc_reason")
      .eq("qc_status", "REJECTED").range(from, from + PAGE_SIZE - 1);
    if (error) { console.error("✗ jumia_products:", error.message); process.exit(2); }
    for (const r of (data ?? []) as Record<string, string | null>[]) {
      const key = `${r.user_id}:${r.set_sid ?? r.product_sid}`;
      if (seen.has(key) || !r.qc_reason || !r.category_code) continue;
      seen.add(key);
      said.push({ code: parseInt(r.category_code, 10), text: r.qc_reason });
    }
    if ((data ?? []).length < PAGE_SIZE) break;
  }
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data: listings, error: le } = await db.from("listings").select("category_code, jumia_qc_reason, jumia_qc_comment")
      .eq("jumia_qc_status", "rejected").range(from, from + PAGE_SIZE - 1);
    if (le) { console.error("✗ listings:", le.message); process.exit(2); }
    for (const r of (listings ?? []) as Record<string, string | null>[]) {
      const text = [r.jumia_qc_reason, r.jumia_qc_comment].filter(Boolean).join(": ");
      if (text && r.category_code) said.push({ code: parseInt(r.category_code, 10), text });
    }
    if ((listings ?? []).length < PAGE_SIZE) break;
  }

  const codes = Array.from(new Set(said.map((s) => s.code).filter(Number.isFinite)));
  const fields = new Map<number, PastRejection["fields"]>();
  for (let i = 0; i < codes.length; i += 200) {
    const { data, error } = await db.from("jumia_category_attributes").select("category_code, name, label").in("category_code", codes.slice(i, i + 200));
    if (error) { console.error("✗ jumia_category_attributes:", error.message); process.exit(2); }
    for (const a of (data ?? []) as { category_code: number; name: string; label: string | null }[]) {
      fields.set(a.category_code, [...(fields.get(a.category_code) ?? []), { name: a.name, label: a.label }]);
    }
  }

  const rows = requirementsFromRejections(said.map((s) => ({ categoryCode: s.code, said: s.text, fields: fields.get(s.code) ?? [] })));
  console.log(`${said.length} rejections → ${rows.length} requirements`);
  for (const r of rows) console.log(`  ${r.categoryCode}  ${r.field.padEnd(18)} ${r.kind.padEnd(5)} seen ${r.seen}`);
  if (!WRITE) { console.log("(dry run: add --write to save them)"); return; }

  const now = new Date().toISOString();
  // Rows already there are left as they are: the chat has been counting them since.
  const { error } = await db.from("jumia_qc_required").upsert(rows.map((r) => ({
    category_code: r.categoryCode, field: r.field, label: r.label, kind: r.kind, example: r.example, seen: r.seen, last_seen: now,
  })), { onConflict: "category_code,field", ignoreDuplicates: true });
  if (error) { console.error("✗ jumia_qc_required:", error.message); process.exit(2); }
  console.log(`✓ wrote ${rows.length}`);
}

main().catch((e) => { console.error(e); process.exit(3); });
