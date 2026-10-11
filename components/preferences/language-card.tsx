"use client";

/**
 * Settings → Language (owner, 2026-10-11: "they should have the flexibility
 * of choosing which they prefer"): what PandaWorld talks to the seller in,
 * and what their Jumia listings are written in. Both start as their
 * market's (French in Côte d'Ivoire, Senegal and Morocco, English elsewhere).
 */

import { useEffect, useState } from "react";
import { Check, Languages, Loader2 } from "lucide-react";

type Ui = "en" | "fr" | "ar";
type Listing = "en" | "fr";
interface Languages { ui: Ui; listing: Listing }

const UI_OPTIONS: { value: Ui; label: string }[] = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
  { value: "ar", label: "العربية" },
];
const LISTING_OPTIONS: { value: Listing; label: string }[] = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
];

export function LanguageCard() {
  const [langs, setLangs] = useState<Languages | null>(null);
  const [saving, setSaving] = useState<keyof Languages | null>(null);
  const [saved, setSaved] = useState<keyof Languages | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/preferences/language").then((r) => (r.ok ? r.json() : null)).then((d) => d && setLangs({ ui: d.ui, listing: d.listing })).catch(() => undefined);
  }, []);

  async function choose(key: keyof Languages, value: string) {
    setSaving(key); setSaved(null); setError(null);
    try {
      const res = await fetch("/api/preferences/language", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ [key]: value }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Couldn't save that.");
      setLangs({ ui: data.ui, listing: data.listing });
      setSaved(key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  }

  const row = (key: keyof Languages, title: string, hint: string, options: { value: string; label: string }[]) => (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <p className="text-sm font-medium text-zinc-900">{title}</p>
        <p className="text-xs text-zinc-500">{hint}</p>
      </div>
      <div className="flex items-center gap-2">
        {saving === key && <Loader2 className="h-4 w-4 animate-spin text-zinc-400" />}
        {saved === key && <Check className="h-4 w-4 text-emerald-500" />}
        <div className="flex overflow-hidden rounded-lg border border-zinc-200" role="radiogroup" aria-label={title}>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={langs?.[key] === o.value}
              disabled={!langs || saving !== null}
              onClick={() => void choose(key, o.value)}
              className={`px-3 py-1.5 text-sm transition-colors ${langs?.[key] === o.value ? "bg-zinc-900 font-semibold text-white" : "bg-white text-zinc-700 hover:bg-zinc-50"}`}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <Languages className="h-4 w-4 text-zinc-500" />
        <h2 className="text-sm font-semibold text-zinc-700">Language</h2>
      </div>
      <div className="mt-2 divide-y divide-zinc-100">
        {row("ui", "Talk to me in", "The chat, the Chrome extension and the bot's messages on WhatsApp.", UI_OPTIONS)}
        {row("listing", "Write my listings in", "The name, description and highlights of the products PandaWorld drafts for Jumia.", LISTING_OPTIONS)}
      </div>
      {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
