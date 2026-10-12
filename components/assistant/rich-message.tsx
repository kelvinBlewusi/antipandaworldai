"use client";

/**
 * An answer laid out for reading (owner, 2026-10-09: "organized ... with
 * tables if needed or graphics if possible ... rich texts"): stat tiles,
 * tables with coloured statuses, bars and notes, from the blocks the bot
 * sent with its text (lib/whatsapp/rich.ts). Drawn from React nodes only.
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { htmlToWhatsApp } from "@/lib/whatsapp/html-text";
import type { RichBlock, RichCell, RichTone } from "@/lib/whatsapp/rich-blocks";

const VALUE_TONE: Record<RichTone, string> = {
  good: "text-emerald-600", bad: "text-red-600", warn: "text-amber-600", info: "text-sky-600", neutral: "text-zinc-900",
};
const PILL_TONE: Record<RichTone, string> = {
  good: "bg-emerald-50 text-emerald-700 ring-emerald-600/15", bad: "bg-red-50 text-red-700 ring-red-600/15",
  warn: "bg-amber-50 text-amber-800 ring-amber-600/20", info: "bg-sky-50 text-sky-700 ring-sky-600/15", neutral: "bg-zinc-100 text-zinc-600 ring-zinc-500/10",
};
const BAR_TONE: Record<RichTone, string> = {
  good: "bg-emerald-500", bad: "bg-red-500", warn: "bg-amber-500", info: "bg-sky-500", neutral: "bg-zinc-400",
};
const NOTE_TONE: Record<RichTone, string> = {
  good: "bg-emerald-50 text-emerald-800", bad: "bg-red-50 text-red-800", warn: "bg-amber-50 text-amber-900", info: "bg-sky-50 text-sky-900", neutral: "bg-white text-zinc-600 ring-1 ring-inset ring-zinc-200",
};

function Cell({ value }: { value: RichCell }) {
  if (typeof value === "string") return <>{value}</>;
  return (
    <span className={cn("inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", PILL_TONE[value.tone] ?? PILL_TONE.neutral)}>
      {value.text}
    </span>
  );
}

/**
 * A table: columns from sm up; on a phone each row is stacked (its first
 * cell, then the rest with their column names), so nothing hides off the
 * side of the screen.
 */
function Table({ block }: { block: Extract<RichBlock, { kind: "table" }> }) {
  const right = (i: number) => block.align?.[i] === "right";
  const empty = (v: RichCell) => (typeof v === "string" ? !v.trim() : !v.text.trim());
  return (
    <div className="rich-table overflow-hidden rounded-xl border border-zinc-200 bg-white">
      <ul className="divide-y divide-zinc-100 sm:hidden">
        {block.rows.map((row, r) => (
          <li key={r} className="px-3 py-2.5">
            <p className="text-sm font-medium leading-snug text-zinc-900"><Cell value={row[0]} /></p>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-zinc-600">
              {row.slice(1).map((v, i) => (empty(v) ? null : (
                <span key={i} className="inline-flex items-center gap-1">
                  {(typeof v === "string" || !/^(state|status|where it is)$/i.test(block.columns[i + 1] ?? "")) && <span className="text-zinc-400">{block.columns[i + 1]}</span>}
                  <span className={cn(typeof v === "string" && "font-medium tabular-nums text-zinc-800")}><Cell value={v} /></span>
                </span>
              )))}
            </div>
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto sm:block">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-zinc-50">
          <tr>
            {block.columns.map((c, i) => (
              <th key={i} scope="col" className={cn("whitespace-nowrap px-3 py-2 text-xs font-semibold text-zinc-500", right(i) && "text-right")}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, r) => (
            <tr key={r} className="border-t border-zinc-100 align-top hover:bg-zinc-50/60">
              {row.map((v, i) => (
                <td
                  key={i}
                  className={cn(
                    "px-3 py-2 leading-snug text-zinc-800",
                    i === 0 ? "min-w-[11rem] font-medium text-zinc-900" : "whitespace-nowrap",
                    right(i) && "text-right tabular-nums",
                  )}
                >
                  <Cell value={v} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {block.more && <p className="border-t border-zinc-100 px-3 py-2 text-xs text-zinc-500">{block.more}</p>}
    </div>
  );
}

function Bars({ block }: { block: Extract<RichBlock, { kind: "bars" }> }) {
  const max = Math.max(1, ...block.items.map((b) => b.value));
  return (
    <div className="space-y-2.5 rounded-xl border border-zinc-200 bg-white px-3.5 py-3">
      {block.items.map((b, i) => (
        <div key={i}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-zinc-700">{b.label}</span>
            <span className="shrink-0 font-medium tabular-nums text-zinc-900">{b.shown}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-zinc-100">
            <div
              className={cn("h-full origin-left animate-bar-grow rounded-full motion-reduce:animate-none", BAR_TONE[b.tone ?? "neutral"])}
              style={{ width: `${b.value > 0 ? Math.max(2, (b.value / max) * 100) : 0}%`, animationDelay: `${i * 60}ms` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Tags a listing's text may use, drawn as themselves; any other keeps only its text. */
const LISTING_TAGS = new Set(["p", "br", "strong", "b", "em", "i", "u", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "h2", "h3", "h4", "h5", "h6"]);
/** Tags whose content is never text for a reader. */
const DROPPED_TAGS = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math", "img", "video", "audio", "form", "input", "button", "select", "textarea"]);

/** One parsed node as React: allowed tags as themselves, no attributes but a cell's span. */
function listingNode(node: Node, key: string): ReactNode {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return null;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  if (DROPPED_TAGS.has(tag)) return null;
  const kids = Array.from(el.childNodes).map((c, i) => listingNode(c, `${key}.${i}`));
  if (tag === "br") return <br key={key} />;
  if (tag === "h1") return <h3 key={key}>{kids}</h3>;
  if (!LISTING_TAGS.has(tag)) return <Fragment key={key}>{kids}</Fragment>;
  if (tag === "td" || tag === "th") {
    const span = (name: string) => {
      const n = Number(el.getAttribute(name));
      return Number.isInteger(n) && n > 1 && n <= 12 ? n : undefined;
    };
    const Cell = tag;
    return <Cell key={key} colSpan={span("colspan")} rowSpan={span("rowspan")}>{kids}</Cell>;
  }
  const Tag = tag as keyof JSX.IntrinsicElements;
  return <Tag key={key}>{kids}</Tag>;
}

/**
 * A rewrite's description or highlights as it will read on Jumia (owner,
 * 2026-10-12: shown as plain text, it looked as if the bold, lists and
 * tables weren't there). Parsed in the browser and rebuilt from an
 * allow-list, so nothing in the text runs or links anywhere; until it's
 * parsed, the same text in WhatsApp's formatting.
 */
function ListingHtml({ block, renderText }: { block: Extract<RichBlock, { kind: "html" }>; renderText: (text: string) => ReactNode }) {
  const [nodes, setNodes] = useState<ReactNode[] | null>(null);
  useEffect(() => {
    if (typeof DOMParser === "undefined") return;
    const doc = new DOMParser().parseFromString(block.html, "text/html");
    setNodes(Array.from(doc.body.childNodes).map((n, i) => listingNode(n, String(i))));
  }, [block.html]);
  return (
    <div>
      {block.title && <p className="mb-1.5 text-sm font-medium text-zinc-700">{block.title}</p>}
      <div
        dir="auto"
        className="prose prose-sm prose-zinc max-h-[28rem] max-w-none overflow-y-auto rounded-xl border border-zinc-200 bg-white px-4 py-3 prose-p:my-2 prose-ul:my-2 prose-li:my-0.5 prose-table:my-2 prose-th:bg-zinc-50 prose-th:px-2 prose-td:px-2 [&_table]:block [&_table]:overflow-x-auto"
      >
        {nodes ?? <div className="whitespace-pre-wrap">{renderText(htmlToWhatsApp(block.html))}</div>}
      </div>
    </div>
  );
}

export function RichMessage({ blocks, renderText }: { blocks: RichBlock[]; renderText: (text: string) => ReactNode }) {
  return (
    <div className="space-y-3">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case "heading":
            return (
              <div key={i}>
                <p className="text-[17px] font-semibold leading-snug text-zinc-900">{b.text}</p>
                {b.sub && <p className="text-sm text-zinc-500">{b.sub}</p>}
              </div>
            );
          case "stats":
            return (
              <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))]">
                {b.items.map((s, j) => (
                  <div key={j} className="rounded-xl border border-zinc-200 bg-white px-3 py-2.5">
                    <p className="text-xs leading-tight text-zinc-500">{s.label}</p>
                    <p className={cn("mt-1 text-xl font-semibold leading-none tabular-nums", VALUE_TONE[s.tone ?? "neutral"])}>{s.value}</p>
                    {s.note && <p className="mt-1 text-[11px] leading-tight text-zinc-400">{s.note}</p>}
                  </div>
                ))}
              </div>
            );
          case "table":
            return b.folded ? (
              <details key={i} className="group overflow-hidden rounded-xl border border-zinc-200 bg-white [&_.rich-table]:rounded-none [&_.rich-table]:border-0 [&_.rich-table]:border-t">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-3.5 py-2.5 text-sm font-medium text-zinc-700 [&::-webkit-details-marker]:hidden">
                  <span className="min-w-0">{b.title ?? "Details"}</span>
                  <ChevronDown className="h-4 w-4 shrink-0 text-zinc-400 transition-transform group-open:rotate-180" />
                </summary>
                <Table block={b} />
              </details>
            ) : (
              <div key={i}>
                {b.title && <p className="mb-1.5 text-sm font-medium text-zinc-700">{b.title}</p>}
                <Table block={b} />
              </div>
            );
          case "bars":
            return <Bars key={i} block={b} />;
          case "note":
            return <p key={i} className={cn("rounded-lg px-3 py-2 text-sm leading-relaxed", NOTE_TONE[b.tone ?? "neutral"])}>{renderText(b.text)}</p>;
          case "text":
            return <div key={i} className="whitespace-pre-wrap break-words">{renderText(b.text)}</div>;
          case "html":
            return <ListingHtml key={i} block={b} renderText={renderText} />;
        }
      })}
    </div>
  );
}
