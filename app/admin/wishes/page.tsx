import { createServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// ─── /admin/wishes ───────────────────────────────────────────────────────────
//
// What sellers asked the assistant for that PandaWorld doesn't do yet (the
// not_yet action, lib/whatsapp/assistant.ts): most asked first, then every
// request of the last 90 days. Owner, 2026-10-11: "tell the user it can not
// do that yet". A request whose "Its reply said" column is filled came from a
// reply in the AI's own words that said it can't, stopped before it was sent:
// often something the chat does do, worth a look.

interface Wish {
  id: number;
  created_at: string;
  user_id: string;
  channel: "whatsapp" | "web";
  request: string;
  message: string;
  blocked_reply: string | null;
}

const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Accra" });
/** Requests counted together: the same words, any case or spacing. */
const GAPS = new RegExp("[^\\p{L}\\p{N}]+", "gu");
const key = (request: string) => request.toLowerCase().replace(GAPS, " ").trim();

export default async function WishesPage() {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60_000).toISOString();
  const { data, error } = await createServerClient().from("assistant_wishes").select("*")
    .gte("created_at", since).order("created_at", { ascending: false }).limit(2000);
  const wishes = (data ?? []) as Wish[];

  const groups = new Map<string, { request: string; count: number; sellers: Set<string>; last: string; example: string }>();
  for (const w of wishes) {
    const k = key(w.request);
    const g = groups.get(k);
    if (g) {
      g.count++;
      g.sellers.add(w.user_id);
    } else {
      groups.set(k, { request: w.request, count: 1, sellers: new Set([w.user_id]), last: w.created_at, example: w.message });
    }
  }
  const ranked = Array.from(groups.values()).sort((a, b) => b.sellers.size - a.sellers.size || b.count - a.count || b.last.localeCompare(a.last));

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-bold">Wish list</h1>
        <p className="mt-1 max-w-3xl text-sm text-zinc-500">
          What sellers asked the assistant for that PandaWorld doesn&apos;t do yet, from the last 90 days. They were told
          &ldquo;I can&apos;t do that yet. I&apos;ve noted it.&rdquo; Questions outside Jumia and PandaWorld aren&apos;t noted.
        </p>
        {error && <p className="mt-2 text-sm text-rose-600">Couldn&apos;t read the list: {error.message}</p>}
      </div>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Most asked</h2>
        {ranked.length === 0 ? (
          <p className="text-sm text-zinc-500">Nothing yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr><th className="px-4 py-2">Request</th><th className="px-4 py-2">Sellers</th><th className="px-4 py-2">Times</th><th className="px-4 py-2">Last</th><th className="px-4 py-2">One seller&apos;s words</th></tr>
              </thead>
              <tbody>
                {ranked.slice(0, 50).map((g) => (
                  <tr key={g.request} className="border-t border-zinc-100 align-top">
                    <td className="px-4 py-2 font-medium">{g.request}</td>
                    <td className="px-4 py-2">{g.sellers.size}</td>
                    <td className="px-4 py-2">{g.count}</td>
                    <td className="px-4 py-2 whitespace-nowrap text-zinc-500">{when(g.last)}</td>
                    <td className="px-4 py-2 text-zinc-600">{g.example.slice(0, 200)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold">Every request</h2>
        {wishes.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-zinc-500">
                <tr><th className="px-4 py-2">When</th><th className="px-4 py-2">Where</th><th className="px-4 py-2">Seller</th><th className="px-4 py-2">Their message</th><th className="px-4 py-2">Its reply said</th></tr>
              </thead>
              <tbody>
                {wishes.slice(0, 200).map((w) => (
                  <tr key={w.id} className="border-t border-zinc-100 align-top">
                    <td className="px-4 py-2 whitespace-nowrap text-zinc-500">{when(w.created_at)}</td>
                    <td className="px-4 py-2">{w.channel === "web" ? "Website" : "WhatsApp"}</td>
                    <td className="px-4 py-2 font-mono text-[11px] text-zinc-500">{w.user_id}</td>
                    <td className="px-4 py-2">{w.message.slice(0, 300)}</td>
                    <td className="px-4 py-2 text-zinc-600">{w.blocked_reply ? w.blocked_reply.slice(0, 300) : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
