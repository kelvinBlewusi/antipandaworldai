import { createServerClient } from "@/lib/supabase/server";
import { SIGN_KINDS, SIGN_NAMES, weekOfSigns, type SignKind } from "@/lib/evals/warning-signs";
import { WEEKLY, compareRuns, previousRun, type EvalRun } from "@/lib/evals/assistant-eval";

export const dynamic = "force-dynamic";

// ─── /admin/warning-signs ────────────────────────────────────────────────────
//
// The weekly look at where the chat may have misunderstood a seller (step 4
// of the reliability plan, owner 2026-10-11; lib/evals/warning-signs.ts),
// for the 7 days before now (or before ?to=YYYY-MM-DD), against the week
// before, with every message behind each sign. Each misread found becomes a
// case in lib/evals/assistant-cases.ts with its right answer, never a word
// rule. The weekly test runs and how each compares with the run before are
// at the bottom. The same counts go to the owner on WhatsApp every Monday.

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" });

export default async function WarningSignsPage({ searchParams }: { searchParams: Promise<{ to?: string; kind?: string }> }) {
  const { to, kind } = await searchParams;
  const end = to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? new Date(`${to}T23:59:59Z`) : new Date();
  const { week, before } = await weekOfSigns(end);
  const shown = SIGN_KINDS.includes(kind as SignKind) ? [kind as SignKind] : SIGN_KINDS;

  const { data } = await createServerClient().from("assistant_eval_runs").select("*").eq("note", WEEKLY).order("created_at", { ascending: false }).limit(6);
  const runs = (data ?? []) as EvalRun[];
  const compared = await Promise.all(runs.filter((r) => r.status === "done").map(async (r) => {
    const prev = await previousRun(r);
    return { run: r, prev, c: prev ? compareRuns(r.results, prev.results ?? []) : null };
  }));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-bold">Warning signs</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          Where the chat may have misunderstood a seller, in the 7 days to {when(end.toISOString())}: {week.turns} messages read from {week.sellers} seller{week.sellers === 1 ? "" : "s"} (the week before: {before.turns}).
          Each misread is a test case to add with its right answer, never a word rule.
          {week.agentSeconds && <> Agent mode took {week.agentSeconds.median.toFixed(1)} s, the slowest tenth {week.agentSeconds.p90.toFixed(1)} s.</>}
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
            <tr><th className="px-4 py-2">Sign</th><th className="px-4 py-2">This week</th><th className="px-4 py-2">The week before</th></tr>
          </thead>
          <tbody>
            {SIGN_KINDS.map((k) => (
              <tr key={k} className="border-t border-zinc-100">
                <td className="px-4 py-2"><a href={`?kind=${k}${to ? `&to=${to}` : ""}`} className="underline decoration-zinc-300 hover:decoration-zinc-900">{SIGN_NAMES[k]}</a></td>
                <td className="px-4 py-2 font-semibold tabular-nums">{week.counts[k]}</td>
                <td className="px-4 py-2 tabular-nums text-zinc-600">{before.counts[k]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shown.map((k) => {
        const signs = week.signs.filter((s) => s.kind === k);
        if (signs.length === 0) return null;
        return (
          <section key={k}>
            <h2 className="mb-2 text-sm font-semibold">{SIGN_NAMES[k]} ({signs.length})</h2>
            <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                  <tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Who</th><th className="px-4 py-2">{k === "said_no" ? "What was offered" : "Their message"}</th><th className="px-4 py-2">What happened</th></tr>
                </thead>
                <tbody>
                  {signs.slice(0, 100).map((s, i) => (
                    <tr key={`${s.at}-${i}`} className="border-t border-zinc-100 align-top">
                      <td className="px-4 py-2 whitespace-nowrap text-zinc-500">{when(s.at)}</td>
                      <td className="px-4 py-2 font-mono text-[11px] text-zinc-500">{s.who}</td>
                      <td className="px-4 py-2">{s.message}</td>
                      <td className="px-4 py-2 text-zinc-600">{s.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}

      <section>
        <h2 className="mb-2 text-sm font-semibold">Weekly test runs</h2>
        <p className="mb-2 text-xs text-zinc-500">Queued every Monday with this report. A run that gets 3 or more fewer right than the run before it (the same way and model, on the cases both scored) is sent to the owner on WhatsApp.</p>
        {runs.length === 0 ? <p className="text-sm text-zinc-500">None yet: the first ones start next Monday.</p> : (
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Way</th><th className="px-4 py-2">Model</th><th className="px-4 py-2">Score</th><th className="px-4 py-2">Against the run before</th></tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const cmp = compared.find((x) => x.run.id === r.id);
                  return (
                    <tr key={r.id} className="border-t border-zinc-100 align-top">
                      <td className="px-4 py-2 whitespace-nowrap"><a href={`/admin/assistant-tests?run=${r.id}`} className="underline decoration-zinc-300 hover:decoration-zinc-900">{when(r.created_at)}</a></td>
                      <td className="px-4 py-2">{r.pipeline === "agent" ? "Agent" : "Front door"}</td>
                      <td className="px-4 py-2 font-mono text-xs">{r.model}</td>
                      <td className="px-4 py-2 tabular-nums">{r.status === "done" ? `${r.passed}/${r.done - r.errors}` : `${r.status} ${r.done}/${r.total}`}</td>
                      <td className="px-4 py-2 text-zinc-600">
                        {!cmp ? "–" : !cmp.c ? "no run before" : (
                          <>
                            {cmp.c.passedNow}/{cmp.c.cases} against {cmp.c.passedBefore}
                            {cmp.c.newlyWrong.length > 0 && <span className="text-rose-700"> · now wrong: {cmp.c.newlyWrong.join(", ")}</span>}
                            {cmp.c.newlyRight.length > 0 && <span className="text-emerald-700"> · now right: {cmp.c.newlyRight.join(", ")}</span>}
                          </>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
