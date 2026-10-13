-- What each category's quality check has asked sellers for, learned from
-- its rejections (owner, 2026-10-13; docs/plan-2026-10-13-ask-what-jumia-needs.md
-- step 5).
--
-- Jumia's category data marks the FDA number, the warranty and the like as
-- optional, so a draft never asked for them; Jumia's quality check then
-- rejected the product for them (the owner's shower cream, massager,
-- perfume and wig for an FDA number, a phone for its warranty, a power bank
-- and a wig for a real brand). Each rejection the chat reads records what it
-- asked for here, and a draft in that category is asked for it before it's
-- sent (switch assistant_followup).
--
-- `field` is the category's own field ('fda', 'product_warranty', …), or
-- 'fda' for an FDA number in a category without such a field (it goes in
-- the description), or 'brand'. Not the weight: that one is required and
-- estimated, never left unasked.
--
-- Written by lib/jumia/qc-required.ts learnQcRequirement (fix-rejected and
-- intake's Fix & resubmit), read by qcRequiredFor (lib/whatsapp/readiness.ts).

create table if not exists public.jumia_qc_required (
  category_code integer     not null,
  field         text        not null,
  label         text,
  kind          text        not null check (kind in ('value', 'brand')),
  example       text,
  seen          integer     not null default 1,
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  primary key (category_code, field)
);

-- Service-role only, like every other table here.
alter table public.jumia_qc_required enable row level security;
comment on table public.jumia_qc_required is 'What each category''s quality check has asked for (FDA number, warranty, a real brand). Service role only.';
