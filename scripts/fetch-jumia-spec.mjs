#!/usr/bin/env node
// Refreshes docs/jumia-api from Jumia's published API docs
// (https://vendorcenter.jumia.com/api-docs/openapi.yaml): the root file and
// every file it references (paths, components, text files). Code samples are
// left out; the error-message page is kept as a plain list.
//
//   node scripts/fetch-jumia-spec.mjs
//
// Then run `npx jest __tests__/jumia-spec.test.ts`: it fails when Jumia has
// documented a request PandaWorld hasn't placed in lib/jumia/capabilities.ts,
// or changed what an update can touch.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const BASE = "https://vendorcenter.jumia.com/api-docs/";
const OUT = path.resolve("docs/jumia-api");
const seen = new Set();
const queue = ["openapi.yaml"];

const htmlToList = (html) => {
  const rows = [...html.replace(/<(script|style)[\s\S]*?<\/\1>/g, "").matchAll(/<tr[\s\S]*?<\/tr>/g)]
    .map((m) => m[0].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return ["# Jumia Vendor API: error messages", "", "From vendorcenter.jumia.com/api-docs/text-files/error-messages.html (kept as text).", "", ...rows.map((r) => `- ${r}`)].join("\n") + "\n";
};

while (queue.length) {
  const rel = path.posix.normalize(queue.shift());
  if (seen.has(rel) || rel.startsWith("..") || rel.startsWith("code-samples/")) continue;
  seen.add(rel);
  const res = await fetch(new URL(encodeURI(rel), BASE), { headers: { "User-Agent": "curl/8.5.0", Accept: "*/*" } });
  if (!res.ok) { console.warn(`skip ${rel}: ${res.status}`); continue; }
  let text = await res.text();
  let file = rel;
  if (rel.endsWith("error-messages.html")) { text = htmlToList(text); file = rel.replace(/\.html$/, ".md"); }
  if (rel === "openapi.yaml") text = text.replace("./text-files/error-messages.html", "./text-files/error-messages.md");
  await mkdir(path.dirname(path.join(OUT, file)), { recursive: true });
  await writeFile(path.join(OUT, file), text);
  if (/\.(ya?ml|json)$/.test(rel)) {
    for (const m of text.matchAll(/\$ref:\s*['"]?([^'"#\s]+)/g)) {
      if (!/^https?:/.test(m[1])) queue.push(path.posix.join(path.posix.dirname(rel), m[1]));
    }
  }
}
console.log(`${seen.size} files in ${path.relative(process.cwd(), OUT)}`);
