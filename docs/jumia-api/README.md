# Jumia Vendor API spec (kept copy)

Jumia's published API documentation, from
https://vendorcenter.jumia.com/api-docs/openapi.yaml and every file it
references. Fetched 11 Oct 2026 (owner: "get the API doc so we learn from
there"). Refresh with `node scripts/fetch-jumia-spec.mjs`.

- `openapi.yaml`: the list of requests; each points to its file in `paths/`.
- `paths/`: each request, its parameters, what it returns, examples.
  - `feeds/feeds@products@update.yaml` holds Jumia's "Allow Update" table:
    what a change to an existing product can touch.
  - `catalog/catalog@products.yaml`: a product as Jumia returns it, with all
    its photos and each country's QC status, reason and comment.
- `components/`: shared response and error shapes.
- `text-files/`: Jumia's intro, the sign-in steps, and its list of error
  messages (kept as text, not the original web page).
- Left out: Jumia's code samples (`code-samples/`, referenced by
  `x-codeSamples` in the path files).

How PandaWorld uses it: every documented request is either behind a
capability in `lib/jumia/capabilities.ts` (`requests`) or in
`UNUSED_REQUESTS` with why, and `UPDATE_TABLE` mirrors the Allow Update
table. `__tests__/jumia-spec.test.ts` fails when the spec and those lists
disagree, so a refreshed spec shows what Jumia added or changed.

What the spec settles (11 Oct): reading a product returns every photo for
any status; there's no rule that only approved products can be updated (the
only approval rule is the reverse: some details lock once approved); the
main photo, main category and parent SKU can't change through an update;
products can't be deleted (status takes ACTIVE or INACTIVE only).
