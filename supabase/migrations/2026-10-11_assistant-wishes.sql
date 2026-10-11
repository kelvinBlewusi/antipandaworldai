-- ─── What sellers asked the assistant for that PandaWorld doesn't do ─────────
--
-- Owner, 2026-10-11: "be able to tell the user it can not do that yet when
-- it is asked to perform a task it does not have the capability to". The
-- assistant answers "I can't do that yet. I've noted it." (the not_yet
-- action, lib/whatsapp/assistant.ts) and notes the request here, for the
-- wish list on /admin/wishes. Questions outside Jumia and PandaWorld (the
-- weather) are answered but not noted.
--
--   request:        the AI's words for what they asked ("post products on Instagram")
--   message:        the seller's own message
--   blocked_reply:  the AI's reply that said it can't, stopped before it was
--                   sent (claimsInability), when that's how it got here
--
-- Service role only, like every table here.

create table if not exists public.assistant_wishes (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  user_id       text        not null,
  channel       text        not null check (channel in ('whatsapp', 'web')),
  request       text        not null,
  message       text        not null,
  blocked_reply text
);

create index if not exists assistant_wishes_created_idx on public.assistant_wishes (created_at desc);

alter table public.assistant_wishes enable row level security;

comment on table public.assistant_wishes is
  'Requests the assistant could not do (not_yet), for the wish list on /admin/wishes. See lib/whatsapp/assistant.ts.';
