import { NextRequest, NextResponse } from "next/server";
import { runWeekly } from "@/lib/evals/weekly";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// ─── POST /api/worker/assistant-weekly ───────────────────────────────────────
//
// Every Monday morning (pg_cron, supabase/migrations/2026-10-11_assistant-weekly.sql):
// the chat's warning signs for the week to the owner on WhatsApp, and the
// week's test runs queued (lib/evals/weekly.ts). Step 4 of the reliability
// plan.
//
// Security: the same Bearer CRON_SECRET contract as the other workers, and
// fail-secure without it.

export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error("[assistant weekly] CRON_SECRET is not set — refusing to run.");
    return new NextResponse("Server not configured", { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  return NextResponse.json({ ok: true, ...(await runWeekly()) });
}
