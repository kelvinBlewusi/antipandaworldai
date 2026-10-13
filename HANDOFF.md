# Handoff: where things stand (2026-10-13)

Read this first. Then use AGENTS.md (about 3,900 lines) as the reference:
search it, don't read it top to bottom. Its newest sections are near the
bottom, under "Outstanding work / known gaps". Among them: "The chat asks
what Jumia needs, and keeps the question open" (13 Oct), "Rejected products
fixed from Jumia's words…", "A batch Jumia turned down", "Autopilot", "Agent
mode for everyone" and the language sections.

## The product in five lines

- PandaWorld lists products on Jumia (Africa's marketplace) for sellers, from
  a photo.
- Three ways in: a WhatsApp bot, a web chat (the "Listing Assistant",
  `/extension/assistant`) and a Chrome extension that fills Vendor Center
  forms.
- Both chats run the same engine (lib/whatsapp/intake.ts). They also run a
  seller's live Jumia shop in plain words: stock, prices, sales, orders,
  labels, payouts, reports, fixing rejected products and rewrites.
- Sellers buy credit packs through Paystack.
- All sellers are in Ghana today (9 Jumia connections, 10 WhatsApp numbers).

## State right now

- `main` = `staging` = production at **c84b885** (the plan; code as at
  1ed56a9).
- Branch `claude/cool-brown-jjq19c`: the plan's 7 steps, one commit each,
  **not merged or deployed**. 2,202 jest tests pass, and `npm run build`
  and `npx tsc --noEmit -p .` are clean.
- The table `jumia_qc_required` is already live: the migration was applied
  and 22 rows seeded on 13 Oct.
- **Site:** https://pandaworldai.site.
- **Vercel:** project `prj_IrXq67lWrE27mqqkftA5Rq0k8MN0`, team
  `team_0gS0hzDkeGPYYv2b8Wwdemqj`, Pro **trial**, region arn1 (Stockholm).
- **Supabase:** `slxkgbuaszmrkxdewoar`, free plan: no backups, 227 MB of
  500 MB.
- **AI:** Gemini (Vertex, with AI Studio as fallback). The chat agent is
  3.5 Flash-Lite. Seller AI cost was about $2 over 7 days. Test runs
  (`assistant_eval`) are capped at $3 a day.

## How to work here

- **Checks before every push:** `npx tsc --noEmit -p .`, `npx jest`,
  `npm run build`. There's no ESLint config.
- **Deploy:** a push to `main` deploys production. Then sync `staging` to
  match:
  ```
  git fetch -q origin staging && git checkout -q staging && git reset -q --hard origin/staging \
    && git read-tree -u --reset origin/main && git commit -q -m "Sync staging with main: <what>" \
    && git push -q origin staging && git checkout -q main
  ```
  Verify with the Vercel connector (list_deployments, get_runtime_errors),
  or with `gh api repos/kelvinBlewusi/pandaworld-app/commits/<sha>/status`.
- **Live checks** call a worker with the cron secret, read by name inside
  SQL. Never print it or decrypt it anywhere else. Then read
  `net._http_response` by the returned id:
  ```sql
  select net.http_post(url := 'https://pandaworldai.site/api/worker/translation-check',
    headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' ||
      (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body := '{}'::jsonb, timeout_milliseconds := 60000) as request_id;
  ```
  DELETEs through the Supabase connector time out waiting for approval.
  Prefer versioned cache keys, or ask.
- **Extension release:**
  - Bump extension/manifest.json.
  - Zip it: `cd extension && zip -qr OUT manifest.json background content icons panel -x "*.DS_Store"`.
  - The owner uploads it to the Chrome Web Store.
  - Once Google publishes it, set app_settings `extension_latest_version`.
- **AGENTS.md:** add a dated section for each piece of work: what the owner
  saw, the cause, the fix, and the tests.

## The owner's standing rules

- Never ask the owner to paste tokens, keys or passwords. Never read or print
  secrets. Env var names are fine to list.
- Never add Chrome extension permissions.
- Packing, ready to ship and cancelling real orders happen only on the
  owner's explicit tap. No live change to the owner's own products without
  asking.
- Never say "Jumia API" in anything a seller sees.
- Never put AI model IDs in commits, PRs or code comments.
- Plans are "advice only, critique before committing": propose and wait for
  a go-ahead on big changes. Small, clear fixes from a bug report: just ship
  them.
- Don't push when the owner rejects or stops a push.
- Refer to sellers as they/them.
- **Reporting style:**
  - Short, plain words, real numbers, ✅/⚠️/❌ for lists.
  - Say exactly what was verified live, and what still needs the owner's own
    test.
  - Details are in AGENTS.md, "Communication style with this user".

## Connect these in the new account

- **GitHub:** access to `kelvinBlewusi/pandaworld-app`.
- **Supabase and Vercel connectors** (claude.ai Settings → Connectors).
  Without them you only have the code and the tests: no data, logs or deploy
  checks. Today's debugging depended on the data:
  - `whatsapp_message_log` holds the conversations; web chat numbers are
    `web:<userId>`.
  - `whatsapp_assistant_log` holds what the agent decided.
  - `jumia_product_changes` holds offered and applied live changes.
- The owner's own account is `user_3ELTiEPmV6I2pYCgXedoxbZsQgh` (shop "GEM
  MALL", Ghana).

## Shipped on 11–12 Oct, waiting for the owner's real test

| Commit | What | What to test |
|---|---|---|
| 1ed56a9 | Rejected products fixed from Jumia's words: weight, warranty and FDA asked and put in their fields; brand words removed; brand-like names reworded; the reply is the answer. Rewrites shown in full before the Yes tap. Order updates name the products. | "fix my rejected products" → the collagen supplement (weight). The Kinky Curly wig → "the brand is …". Any rewrite on WhatsApp and on the web. |
| a5c3b20 | /terms, /privacy and sign-up fit a phone; Tailwind typography plugin added | Done: checked live at 360px |
| e4e1f8b…ba548f8 | The bot's own messages in the seller's language (en/fr/ar), the *language* command, a translation cache | A French or Arabic seller on WhatsApp |
| c1a181d | Extension 0.2.59: panel in en/fr/ar; autofill uses the seller's own market | Waiting for the owner to upload it |
| a4fd436, 956e38c | Web chat language switch (RTL for Arabic); listings in French for CI/SN/MA | — |
| 4b113bd, ae4507f | Camera in the web chat, phones and tablets only | — |
| ef73e36 | Autopilot: owner alerts by email, AI budget guard, Stockholm region | — |

**Old offers from the owner's 12 Oct chats:** three `jumia_product_changes`
rows are still `pending`, and their old Yes buttons still work. The owner
decides whether to cancel them.

- `3b86a10f…`: the collagen rewrite. Wrong fix (it was a weight rejection).
- `74ce675b…`: the creatine rewrite. It names "Nutricost", which Jumia
  would reject.
- `321da3a5…` (17:07): a description rewrite of the *other* collagen
  product (Collagen Peptides), offered for "That is the weight of the
  collagen booster". It names "Nutricost" too.

## Open work, most important first

0. **docs/plan-2026-10-13-ask-what-jumia-needs.md: built** on
   `claude/cool-brown-jjq19c`, behind `assistant_followup` (AGENTS.md, "The
   chat asks what Jumia needs…"). For the owner to decide, in order:
   - merge and deploy (then sync staging);
   - set app_settings `assistant_followup` = "admins" and test:
     - fix a rejected product, replying in their own words;
     - change the subject mid-question;
     - draft a cosmetic and see the FDA question before submit;
   - run the test set's live_changes area in agent mode (about $0.30);
   - then "all".

   Two fixes go to every seller with the deploy:
   - a live weight is sent as kg;
   - an FDA number never goes into a certifications list.

   Not done: the optional thinking "low" for turns with an open question.
1. **Before inviting sellers.** The owner decides each of these; advise
   only:
   - **Supabase Pro**, for backups.
   - **Vercel:**
     - Keep Pro after the trial; Hobby isn't for commercial use.
     - Set a spend limit.
     - Then raise `maxDuration` on the 5 routes that timed out at 60 s:
       whatsapp webhook, order-alerts, assistant-eval, analyze-jobs,
       listing-assistant/message.
   - **Privacy policy** (app/privacy/page.tsx). It never mentions:
     - WhatsApp: phone numbers, message contents, photos, Meta as
       processor;
     - Resend (email);
     - Sentry.

     Draft the change for the owner's OK.
   - **WhatsApp:** the owner checks business verification and the messaging
     limit in Meta's WhatsApp Manager.
   - **Extension 0.2.59:** the owner uploads it. Once Google publishes it:
     `update app_settings set value = '"0.2.59"', updated_at = now() where key = 'extension_latest_version';`
2. **Web search while drafting is off.**
   - lib/ai/web-search.ts gets a 403. `GOOGLE_CSE_API_KEY` isn't set and the
     fallback key is blocked.
   - Google's Custom Search JSON API is closed to new customers and shuts
     down on 2027-01-01.
   - Proposed: move the gap-fill in lib/actions/auto-analyze.ts (~line 1560)
     to Gemini's own Google Search grounding. `callGeminiBackend(…,
     { groundWithSearch: true })` already exists and is used by
     `rewriteContent`.
3. **#241:** pack prices shown in the seller's own currency (approximate);
   payment stays in cedis.
4. **#245:** language switch on the dashboard and the public site. The chat,
   the bot and the extension are done.
5. **#89:** the WhatsApp order flow, tested on the owner's number.
6. **Noise to clean up when convenient:**
   - a `url.parse` deprecation warning (analyze-jobs);
   - a Server Action mismatch after deploys;
   - French translation still leaves about 3 short button labels in English
     (retried on the next send).

## Starting prompt for the new session

> Read HANDOFF.md, then the AGENTS.md sections it names. Check main is green
> (tsc, jest, build) and that the Supabase and Vercel connectors work. Then
> tell me in a few lines what you see and what you'd do first.
