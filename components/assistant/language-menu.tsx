"use client";

/**
 * The chat's language switch (owner, 2026-10-11: "a language switch button
 * to the extension and the webchat"): what PandaWorld talks to the seller in
 * (English, French, Arabic) and what their listings are written in (English,
 * French), the same two choices as Settings → Language. The chat changes at
 * once; the choice is saved for the AI, WhatsApp and the extension too.
 */

import { useEffect, useRef, useState } from "react";
import { Check, Languages, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { LANGUAGE_NAMES, UI_LANGUAGES, type UiLanguage } from "@/lib/i18n/languages";
import type { ChatText } from "@/lib/i18n/chat";

export interface ChatLanguages { ui: UiLanguage; listing: "en" | "fr" }

/** On the button: short, in the language itself. */
const SHORT: Record<UiLanguage, string> = { en: "EN", fr: "FR", ar: "عربي" };
const LISTING: ChatLanguages["listing"][] = ["en", "fr"];

export function LanguageMenu({ t, value, onChange }: {
  t: ChatText;
  value: ChatLanguages;
  /** Called at once with the choice, then with what was saved (or the old one back if it wasn't). */
  onChange: (v: ChatLanguages) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<keyof ChatLanguages | null>(null);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", down); document.removeEventListener("keydown", key); };
  }, [open]);

  async function choose<K extends keyof ChatLanguages>(key: K, v: ChatLanguages[K]) {
    if (value[key] === v || saving) return;
    const before = value;
    setSaving(key);
    setError(null);
    onChange({ ...value, [key]: v });
    try {
      const res = await fetch("/api/preferences/language", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: v }),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<ChatLanguages>;
      if (!res.ok || !data.ui || !data.listing) throw new Error("not saved");
      onChange({ ui: data.ui, listing: data.listing });
    } catch {
      onChange(before);
      setError(t.saveFailed);
    } finally {
      setSaving(null);
    }
  }

  const option = (selected: boolean, label: string, lang: string, onClick: () => void) => (
    <button
      key={lang}
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={saving !== null}
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-start text-sm transition-colors disabled:opacity-60",
        selected ? "bg-orange-50 font-semibold text-orange-700" : "text-zinc-700 hover:bg-zinc-50",
      )}
    >
      <span lang={lang} dir="auto">{label}</span>
      {selected && <Check className="h-4 w-4 shrink-0" />}
    </button>
  );

  return (
    <div ref={box} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={t.language}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          "flex h-10 items-center gap-1.5 rounded-xl px-2.5 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100",
          open && "bg-zinc-100",
        )}
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Languages className="h-4 w-4" />}
        <span lang={value.ui}>{SHORT[value.ui]}</span>
      </button>
      {open && (
        <div role="menu" aria-label={t.language} className="absolute end-0 top-full z-20 mt-1 w-60 rounded-xl border border-zinc-200 bg-white p-2 shadow-lg">
          <p className="px-2.5 pb-1 pt-0.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t.talkToMeIn}</p>
          {UI_LANGUAGES.map((l) => option(value.ui === l, LANGUAGE_NAMES[l], l, () => void choose("ui", l)))}
          <p className="mt-2 border-t border-zinc-100 px-2.5 pb-1 pt-2.5 text-xs font-semibold uppercase tracking-wide text-zinc-500">{t.listingsIn}</p>
          {LISTING.map((l) => option(value.listing === l, LANGUAGE_NAMES[l], l, () => void choose("listing", l)))}
          {error && <p className="mt-2 px-2.5 text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
