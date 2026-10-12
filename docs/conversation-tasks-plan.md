# Plan: the chat remembers the job it's doing, and asks its own questions

Owner, 2026-10-12: "why are we not able to make the system … understand what
the user wants … and ask questions when it is not sure, not just hard coded
questions". This is the plan for steps 1 and 2 of the answer. **Advice only:
nothing here is built until the owner says go.**

## What went wrong today (owner's web chat, 12 Oct 17:05–17:11)

| Time | Who | Message | What happened inside |
|---|---|---|---|
| 17:05 | Bot | "Collagen Boosters: … What does it weigh, packed as it ships?" | `fixRejected` set `assistantPending` = `QcLiveAsk` (weight) |
| 17:06 | Seller | "That is the weight listed" | `answerQcLive` **cleared the question first** (fix-rejected.ts:350), found no number, let it go. The agent read the message fresh, with no idea a question was open → `content_change` with no value → canned "What should I change on it? Write the new name…" (assistant.ts:1260) |
| 17:07 | Seller | "That is the weight of the collagen booster" | The agent looked up "collagen booster", picked a **different** product (Collagen Peptides, Nutricost) and offered a description rewrite that names "Nutricost". That offer is still pending (`321da3a5…`) |
| 17:09 | Seller | "… Is a rejected product what is the weight ?" | Answered: 0.2 kg, "edit it on your Drafts & Listings page" |
| 17:10 | Seller | "Update it for me on my JUMIA shop" | Same canned "What should I change on it?" |
| 17:10 | Seller | "Change the weight to 0.1kg" | Finally offered; tapped; sent |

It took six messages to fix one weight, and one wrong rewrite was offered on
the way. The same canned question went out to "FDA/SD.255-112170", "That's the
fda number", "it is a bluetooth lens" and "SKU GEMMALLUSBWF" in the past week.
Each of these was an answer to the bot's own question.

What the seller meant at 17:06: "0.2 kg, the weight on Jumia now, is right."
A person would have said: "Jumia has 0.2 kg for it and turned it down. Send
0.2 kg back as it is, or is the packed weight different?"

## Root cause in one line

The chat has **no record of the job it's in the middle of**, and **the model
isn't allowed to ask its own question**. When a check fails, a fixed sentence
replaces what the model understood.

---

## Step 1: an open task per seller

### What it is

One record for the job the bot is in the middle of, saved in the database and
shown to the agent on every message:

```ts
// lib/assistant-v2/task.ts (new)
interface OpenTask {
  id: string;
  kind: "fix_rejected" | "content_change" | "add_size" | "live_change" | "draft_edit" | "pick_product";
  product: { sku: string; name: string } | null;  // what "it" means while this is open
  goal: string;          // "Fix Jumia's rejection: weight"
  known: Record<string, string>;   // { "weight on Jumia now": "0.2 kg", "Jumia said": "Weight is wrong" }
  needed: { field: string; why: string }[];      // [{ field: "weight", why: "Jumia rejected 0.2 kg" }]
  asked: string;         // the last question we sent, word for word
  turns: number;         // seller messages since it opened
  status: "open" | "done" | "dropped" | "expired";
  openedAt: string; updatedAt: string;
}
```

Storage: a new table `assistant_tasks` (user_id, channel, the fields above).
Only one is `open` per seller and channel. Closed ones stay, so the weekly
report can count how many finished and in how many turns.

### When it opens, and when it closes

- **Opens** wherever the bot asks something it needs in order to finish:
  - `fixRejected` asking a value (weight, warranty, FDA, brand);
  - a content change with no value;
  - "which size?";
  - "which product?" (`ProductPickAsk`);
  - a live change with no value (`LiveValueAsk`).
- **Done** when the change is offered for the Yes tap, or applied.
- **Dropped** when the seller says stop or cancel, or the agent decides they
  moved on to something else (below).
- **Expired** after 24 h. It's mentioned once in `seller_memory` as
  unfinished, and is never acted on silently.
- **Never cleared by a message that isn't an answer.** Today's
  `answerQcLive` clears it before reading (fix-rejected.ts:350). That one line
  is why 17:06 lost the thread.

### How it's read

1. **Fast path, unchanged and free.** The existing answer parsers
   (`parseWeightKg`, `parseBrandAnswer`, `warrantyAnswer`, a picked number)
   run first. If one gets the answer, there's no AI call.
2. **Otherwise the agent reads the message with the task at the top of its
   context** (`agentContext`, before the conversation):

   ```
   Open task (you are in the middle of this):
   Fixing Jumia's rejection of *Enhancement Dietary Supplement - Collagen Boosters* (SKU PA-MUTE4CYI).
   Jumia said: the weight is wrong. Weight on Jumia now: 0.2 kg.
   Still needed: the packed weight.
   You asked: "What does it weigh, packed as it ships? …"
   "It", "this", "the product" mean this product while the task is open.
   ```
3. **New agent tools:**
   - `continue_task {values, note}`: the message answers or moves the open
     task forward. The values go through the same checks as today (see step 2
     for the one change).
   - `drop_task {reason}`: they've clearly moved on, or said no.
   - Every other tool still works. "Show me today's sales" while a task is
     open is answered, and the task stays open. The agent is told: decide
     first whether this message continues the task, starts something else, or
     both.
4. **The task's product comes first for "it".** `find_products` is called
   only when they name a different product. This alone stops 17:07's switch to
   the Nutricost collagen.

### What it replaces

The pilot covers `QcLiveAsk` (rejected products) and the content-change "no
value" question only. They write and read an `OpenTask`. The old
`assistantPending` kinds (`LiveValueAsk`, `ProductPickAsk`, `AddPhotosAsk`)
move over one at a time after the pilot works. `awaitingPriceFor`,
`awaitingValueFor` and `awaitingQcAnswer` in the draft flow stay as they are
for now. They're inside the fixed listing flow, which the owner wants kept.

---

## Step 2: the model asks; the checks become a gate

### Today

- The agent must call an action (`mode: "ANY"`).
- `parseAction` drops any value not typed in **this** message
  (`saidInMessage`).
- If nothing is left, a fixed sentence goes out. There are 28 of these in assistant.ts, plus more in shop.ts:
  `ask("…")` lines.

The model never gets to say "I see you mean the weight on Jumia is right".

### Change

1. **A new `ask` tool**, separate from `clarify`'s buttons:
   `ask {question, about}`.
   - The model writes the question about *this* product and *this* missing
     detail, in one or two lines, in the seller's language.
   - It goes through `claimsInability` like any reply, and is capped at 300
     characters.
   - It updates the task's `asked`.
2. **A failed check goes back to the model instead of out to the seller.**
   - When `parseAction` would return a canned `ask(...)`, the agent loop gets
     it as the tool's answer, e.g. "weight: no value was said by the seller;
     ask them, quoting what Jumia has (0.2 kg)".
   - The model makes one more call, using the same budget it uses today when a
     reply says it can't (`CANT_NOT_SENT`).
   - The canned sentence stays only as the fallback when time runs out, or on
     the front door path.
3. **One loosening of "values from the message", kept safe.**
   - A value counts as the seller's when either:
     - they typed it, as today; or
     - the bot's own **last question quoted it** and they agreed. For
       example, the bot asks "Send 0.2 kg back as it is?" and the seller
       answers "yes" or "that's right".
   - The value must appear word for word in `task.asked`. So nothing reaches
     Jumia that the seller didn't see and agree to.
   - The Yes tap before any live change stays exactly as it is.
4. **Nothing else moves.**
   - The immediate kinds (one product's stock, ON/OFF, ending a sale) and
     every confirm tap work as today.
   - So do the reply guard, `not_yet`, `capability` and the 3-action limit.

### Today's chat, replayed with steps 1 and 2

> **Bot:** Collagen Boosters: Jumia's quality check needs something only you have. What does it weigh, packed as it ships?
> **Seller:** That is the weight listed
> **Bot:** Jumia has 0.2 kg for it now, and turned that down. Should I send 0.2 kg back as it is, or is the packed weight different (with the jar and box)?
> **Seller:** it's 0.1kg
> **Bot:** Update *Collagen Boosters* on Jumia: weight → 0.1 kg? [Yes] [No]

That's 3 messages instead of 6, with no wrong product and no canned text.

---

## How we'd know it works

- **Conversation tests** (new, in lib/evals): a case is several turns, and
  it passes when the job ends right within N turns. The first 6 come from real
  logs:
  1. "That is the weight listed" (above);
  2. "FDA/SD.255-112170", then "That's the fda number" (another seller,
     11 Oct);
  3. "I have a spectacle product i want to rewrite the description", then
     "it is a bluetooth lens";
  4. "let's add a 15inc variation", then "price is 200 and the qty is 10";
  5. "edit the discription live", then "of what we just spole about", then
     "SKU GEMMALLUSBWF";
  6. while a task is open, "show me today's sales": answered, and the task
     stays open.
- **The single-message test set (248)** must not drop. It's checked as today.
- **Live, weekly** (warning-signs report, two new counts):
  - canned questions sent (should fall towards 0);
  - tasks finished and the median turns to finish.

  The existing "repeated" count should fall.

## Rollout

1. Build behind app_settings `assistant_tasks` = `"admins"` (the owner's
   account first), the same switch pattern as `assistant_agent`.
2. The owner tests: fix rejected products, a content change with no value,
   and changing the subject mid-task.
3. Then `"all"`. To go back, delete the row.

## Cost and size

- **AI cost:**
  - Most turns are unchanged.
  - A turn with an open task adds about 200 tokens of context.
  - A failed check adds one call (about 1 s).
  - At today's volume, that's cents a week.
- **Work:** about 2–3 days. Files:
  - migration (`assistant_tasks`);
  - `lib/assistant-v2/task.ts` (new);
  - `agent.ts` (context, two tools, the failed-check loop);
  - `actions.ts`;
  - `assistant.ts` (the `ask(...)` sites return a "needs" result);
  - `fix-rejected.ts`;
  - `intake.ts:791`;
  - evals, tests;
  - an AGENTS.md section.

## Critique: what could go wrong

- ⚠️ **A task that won't let go.** The seller changes the subject and the bot
  keeps steering back. Mitigations:
  - the agent decides continue/switch every turn;
  - "both" is allowed;
  - 24 h expiry;
  - a conversation test for changing the subject.
- ⚠️ **The loosened value rule.**
  - It's the only change to safety. It's limited to a value quoted word for
    word in our own last question.
  - Every live change still needs the Yes tap.
  - If the owner prefers, step 2.3 can be left out at first. The bot would
    then ask "Send 0.2 kg?", and the seller would type "0.2 kg".
- ⚠️ **Questions are harder to test than fixed sentences.** The conversation
  tests check the outcome and that the question names the product and the
  field, not its exact words.
- ⚠️ **Two systems for a while** (the old pending fields and tasks). Keep the
  pilot to two flows and move the rest one at a time, each with its tests.
- ⚠️ **Model strength.** Flash-Lite with minimal thinking might still miss
  "that is the weight listed". The option, not part of this plan unless asked:
  use thinking "low" only on turns with an open task. That's about 1 s slower
  on those turns only.

## Not in this plan (later steps from the same answer)

- The multi-step loop with a turn budget instead of a 10 s cap (step 3).
- Moving every `assistantPending` kind to tasks.
- Retiring the canned `ask(...)` sentences altogether.

## Found while writing this

The 17:07 Nutricost description rewrite for *Collagen Peptides Powder* is
still a pending offer (`jumia_product_changes` `321da3a5…`). Its Yes button
still works, and it names a brand Jumia rejects. It's the same issue as
`3b86a10f…` and `74ce675b…` in HANDOFF.md. The owner decides whether to cancel
them.
