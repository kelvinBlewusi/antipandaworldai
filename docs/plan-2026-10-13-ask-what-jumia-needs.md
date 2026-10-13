# Plan: the chat asks what Jumia needs, and keeps the question open (2026-10-13)

For the Claude Code session picking this up. The owner asked for it to be
built ("write implementation plan for the second claude account",
2026-10-13). It's distilled from two critiques of earlier plans:

- "open task per seller" (12 Oct);
- "interactivity root cause" (13 Oct).

**Build in the order below.** Each step is one commit, with tests, and
everything is behind the switch. Steps marked ⚠️ touch the owner's live shop:
ask first.

## Why (the evidence, checked against the logs)

### 1. The owner's web chat, 12 Oct 17:05–17:11

Six messages to fix one weight, and one wrong rewrite offered on the way.
The agent's own calls are in `whatsapp_assistant_log.raw`:

| Seller said | The agent called | What went wrong |
|---|---|---|
| (bot asked) "What does it weigh, packed as it ships?" | — | `fixRejected` set `assistantPending` = `QcLiveAsk` |
| "That is the weight listed" | `content_change(collagen, details:[{value:"That is the weight listed"}], rewrite:[description])` | `answerQcLive` cleared the question first (fix-rejected.ts), found no number, and gave up. `contentAction` dropped the call, so the fixed "What should I change on it?" went out |
| "That is the weight of the collagen booster" | `content_change(Collagen Peptides…, asked:{description:"That is the weight of the collagen booster"})` | Wrong product, and a rewrite nobody asked for (offer `321da3a5…`) |
| "…what is the weight?" | `product_details` → reply "0.2 kg … edit it on your Drafts & Listings page" | Wrong place: it's a live product, so the bot should have offered the change |
| "Update it for me on my JUMIA shop" | `content_change(collagen, details: weight "0.2 kg")`, which was right | `saidInMessage` dropped "0.2 kg" because it wasn't typed in this message. The fixed question again |
| "Change the weight to 0.1kg" | `content_change(… weight "0.1kg")` | Sent. **Bug:** the weight field got the text `"0.1kg"`, not `0.1` (change `e46ddf10…`) |

Read together, these show the model mostly understood the seller. The three
failures were:

- the open question was thrown away;
- a failed check sent a fixed sentence instead of letting the model try
  again;
- a value from the bot's own question couldn't be agreed to.

### 2. The owner's 11 rejected products

All have PandaWorld SKUs (`PA-…`), so we drafted them. At least 7 failed on
something only the seller knows, which drafting guessed or never asked.

| Rejected for | Products (category code) | Why it wasn't asked |
|---|---|---|
| FDA number | shower cream 1019709, massager 1016875, perfume 1000844, wig 1001090 | `fda` is *optional* in Jumia's category data; only required fields are asked |
| Warranty | Galaxy A15 1002300 | The warranty fields are optional too |
| Brand ("Generic" not accepted, "Fashion") | power bank 1000279, wig 1018743 | The brand is filled automatically, never asked |
| Weight | collagen 1018796 | Required, but the AI estimated 0.2 kg |

The chat only asks about what Jumia's category data marks *required*. Jumia's
quality check enforces more than that.

## Ground rules for this work

- Read HANDOFF.md first: deploy flow, checks and the owner's standing rules.
- **Switch:** app_settings `assistant_followup`. Read it with the existing
  `switchedOnFor` (lib/whatsapp/assistant.ts:143): `"admins"` first, then
  `"all"`. When it's off, behaviour is exactly as today. Step 1 is a bug fix
  and isn't switched.
- **Don't build these** (both critiques rejected them):
  - a new `assistant_tasks` table;
  - new `ask` / `continue_task` / `drop_task` tools;
  - a separate intent-classifier call;
  - a clarification banner in the review form;
  - web-search self-correction (Custom Search is off and ends 2027-01-01);
  - rewriting all 28 fixed `ask(...)` sentences.
- The Yes tap before every live change stays exactly as it is.

## Steps

### 1. A weight goes to Jumia as kg (bug, every seller)

**Where:**
- lib/whatsapp/live-details.ts `checkDetailValue`.
- Check lib/jumia/preflight.ts for the same in the draft push.

**What:**
- For a weight detail (name `product_weight`, or label/name matching
  `/weight/` but not net/volume), run the value through `parseWeightKg`
  (lib/jumia/qc-answers.ts):
  - `"0.1kg"` → `"0.1"`;
  - `"200 g"` → `"0.2"`.
- When it returns `{unit}`, return `{ ok: false, why: "Is that 350 g or 350 kg?" }`.

**Tests** (live-details or qc-live-answers):
- "0.1kg", "0.1 kg" and "200g" become the number in kg.
- A bare "350" asks for the unit.
- A non-weight detail is untouched.

⚠️ The collagen product (PA-MUTE4CYI) has `"0.1kg"` on Jumia now. Ask the
owner before offering to resend it as `0.1`.

### 2. A rejected product's question stays open until it's answered

**Where:**
- lib/whatsapp/fix-rejected.ts: `answerQcLive`, `fixRejected`, `QC_LIVE_TTL_MS`.
- lib/whatsapp/session.ts `QcLiveAsk`.
- lib/whatsapp/intake.ts: the `qc_live` branch (~line 784), the generic
  `assistantPending` branch right after it, the
  `if (session.assistantPending) { answerPendingQuestion … clear }` block
  (~line 3852), and `openQuestion()` (~line 664).

**What:**
- **Keep the question.**
  - `answerQcLive` no longer clears the question before reading the reply.
  - It clears it only when it handled the reply, on "stop"/"cancel", on a
    tapped button, or after expiry. Raise `QC_LIVE_TTL_MS` to 2 hours.
  - On a non-answer it returns false and **keeps** the question.
- **Don't let intake clear it either.**
  - After `answerQcLive` returns false, don't null `session.assistantPending`.
  - Leave `qc_live` out of the generic `answerLiveValue` branch.
  - Make sure the ~3852 block doesn't wipe it.
- **Store more on the question:**
  - `jumiaSaid`: Jumia's reason, up to 200 characters.
  - `current`: the value on Jumia now. Read it when asking, from
    `fetchProductSet(...).attributes` for `field`, or the brand.
- **Say the current value.** `fixRejected`'s question names it, e.g. "Jumia
  has 0.2 kg for it now and turned that down. What does it weigh, packed as
  it ships?"
- **Tell the agent.** intake's `openQuestion()` for `qc_live` becomes the
  `waitingFor` text: product name, SKU, field, value now, Jumia's words, and
  "'it' and 'this' mean this product".
- **Agreeing.**
  - When `current` is set, a reply matching an agree pattern
    (yes / that's right / correct / it is correct / same / keep it / update it
    / send it, typos tolerated) offers the change with `current` (Jumia will
    re-check it).
  - Anything else that isn't an answer goes to the agent with the question
    still open.

**Tests** (jumia-shop-more.test.ts, describe "rejected products, fixed…"):
- 17:06 replay: "That is the weight listed" returns false, and
  `assistant_pending` is still `qc_live`.
- "update it" offers `product_weight` with the current value.
- "stop" clears the question; so does a tap; so does expiry after 2 h.
- "show me today's sales" while it's open is handled elsewhere, and the
  question stays.

### 3. A failed check goes back to the model, once (behind the switch)

**Where:**
- lib/whatsapp/assistant.ts `contentAction` (~line 1178): its two `ask(...)`,
  "Which product?" and "What should I change on it?".
- lib/assistant-v2/agent.ts `agentRead`: `parseAction` currently runs after
  the loop (~line 395).
- Wherever actions are carried out.

**What:**
- **A new action type.** In those two places `contentAction` returns
  `{ type: "needs", text, why }`. `text` is today's sentence (the fallback);
  `why` is for the model, e.g.:

  > content_change not sent: no value for weight was in the seller's message. Ask them with clarify (no options needed), quoting what The bot's open question says Jumia has now, or call content_change with the value they gave.

- **Check inside the loop.** In `agentRead`, run the `parseAction` checks on
  the finals inside the loop. If one is `needs` and no retry was used yet,
  answer that tool call with `why` as its result and call once more, with
  the same budget pattern as `cant`/`CANT_NOT_SENT`.
- **Fall back.** Out of time, a second `needs`, the switch off, or the front
  door path: `needs` is carried out as `reply` with `text`, exactly as today.
- Start with these two asks only. More can move later, one at a time, each
  with tests.

**Tests** (agent tests with the injectable `AgentCall`):
- First call `content_change` without a value, second call `clarify` → the
  result is the clarify.
- First call without a value, then time runs out → the fallback sentence.
- Switch off → today's behaviour.

### 4. `clarify` can ask without buttons

**Where:** lib/assistant-v2/actions.ts, the `clarify` entry (~line 519).

**What:**
- `required: ["question"]`, so `options` becomes optional.
- New wording: "leave options out when the answer is a value or a name (a
  weight, a brand, a number)".
- `sendClarify` (assistant.ts:1891) already sends plain text when there are
  fewer than 2 options.

**Tests:** a clarify with no options is sent as text.

### 5. Learn what each category's quality check needs

**What to add:**
- **Migration** `supabase/migrations/2026-10-13_jumia-qc-required.sql`:

  ```sql
  create table if not exists jumia_qc_required (
    category_code integer not null,
    field         text    not null,   -- 'fda', 'product_warranty', 'brand', …
    label         text,
    kind          text    not null check (kind in ('value','brand')),
    example       text,               -- Jumia's words, up to 300 chars
    seen          integer not null default 1,
    first_seen    timestamptz not null default now(),
    last_seen     timestamptz not null default now(),
    primary key (category_code, field)
  );
  alter table jumia_qc_required enable row level security;  -- service role only, like the other jumia_ tables
  ```
- **lib/jumia/qc-required.ts** (new):
  - `learnQcRequirement(categoryCode, action, said)` upserts and adds 1 to
    `seen`. It records only `ask_value` with a `field`, and `ask_brand`.
    **Not weight:** that's a required field the AI estimates, not one that
    goes unasked.
  - `qcRequiredFor(categoryCode)` caches for 10 minutes, like
    learned-restricted-words.ts.

**Where to call it:** every place `decideQcAction` runs:
- lib/whatsapp/fix-rejected.ts `fixRejected`;
- lib/whatsapp/intake.ts `fixQcRejection`;
- any other caller found with `grep -rn decideQcAction lib`.

Never let it throw into the flow.

**Seed it** once from existing rejections with a script
(`scripts/seed-qc-required.ts`):
- Run `qcActionFromTable` over `jumia_products` where
  `qc_status = 'REJECTED'`, and over `listings.jumia_qc_comment`.
- Expect at least:
  - fda: 1019709, 1016875, 1000844, 1001090;
  - product_warranty: 1002300;
  - brand: 1000279, 1018743.

**Tests:**
- A rejection with an FDA reason records (category, fda).
- A weight rejection records nothing.
- Recording twice makes `seen` 2.

### 6. Ask those fields before a draft is sent (behind the switch)

**Where:** lib/whatsapp/readiness.ts `assessListingPushReadiness`, after
`missingFields` (~line 306).

**What:**
- For each `qcRequiredFor(category)` field that's empty in
  `dynamic_attributes` and exists in the category's attributes, add it to
  `missingFields` with the reason "Jumia's quality check needs its FDA number
  in this category". The existing `askForNextMissingValue` then asks it, one
  field at a time, and the answer carries on to the next.
- For a `brand` requirement, do the same only when the draft's brand is
  "Generic" or empty.
- Wording: give the reason, say where to find it ("it's on the label"), and
  say that *skip* sends it anyway but Jumia will likely turn it down.
- `autoFillMissingFields` (lib/whatsapp/missing-value.ts) may read an FDA
  number off a label photo. Keep that, and ask only if it's still empty.

**Tests** (whatsapp-intake-flow or readiness tests):
- A draft in 1019709 without `fda` is Held with the FDA reason.
- The answer goes in `dynamic_attributes.fda` and the submit goes ahead.
- With the switch off, there's no new question.

Out of scope: the Chrome extension's autofill.

### 7. Conversation checks and the test set

- **Jest, deterministic:** the replays in steps 2–3.
- **lib/evals/assistant-cases.ts:**
  - Add cases with an open question in their context. First check how a
    case carries `waitingFor`/conversation; add a field if it can't.
  - "That is the weight listed" → clarify naming the current weight, or the
    change with it.
  - "That is the weight of the collagen booster" → never a description
    rewrite of another product.
  - "Update it for me on my JUMIA shop" with the question open → the change
    with the current value.
  - The 17:09 case → offer the change, never "Drafts & Listings" for a live
    product.
- **Run the set in agent mode.** It must not fall below the last recorded
  result (agent mode 253/262, AGENTS.md). Test runs stop at $3 a day, so run
  only the affected areas.
- **Optional, only if the set says so:** thinking "low" on turns with an
  open question (`agentModelSpec` takes `model:low`). It costs about 1 s on
  those turns only.

### 8. Docs

- Add an AGENTS.md section: the evidence, each change, the switch and the
  tests.
- Update HANDOFF.md: the state, and this plan's progress.

## Rollout

1. `assistant_followup` = `"admins"`. Deploy, then sync staging.
2. The owner tests on the web chat and WhatsApp:
   - fix a rejected product and reply in their own words ("that's the weight
     listed", "update it");
   - change the subject mid-question;
   - draft a cosmetic and see the FDA question before submit.
3. If it holds, set `"all"`. To roll back, delete the row.

## Ask the owner; never do these silently

- Cancel the stale pending offers: `321da3a5…` (Nutricost description, wrong
  product), `3b86a10f…` and `74ce675b…` (12 Oct morning).
- Resend the collagen weight as `0.1` (step 1).

## Size

- About 1.5 days in all.
- Steps 1–4: about half a day.
- Steps 5–6: about half a day.
- Step 7 (eval runs) and docs: the rest.
