-- Each seller's own choices (owner, 2026-10-11: "they should have the
-- flexibility of choosing which they prefer"): the language PandaWorld
-- talks to them in (the web chat, the extension, the bot's messages) and
-- the language their Jumia listings are written in. Null: their market's
-- (lib/preferences/language.ts). Server-side only: no policies, so only the
-- service role reads and writes it.
create table if not exists public.seller_preferences (
  user_id          text primary key,
  ui_language      text check (ui_language in ('en', 'fr', 'ar')),
  listing_language text check (listing_language in ('en', 'fr')),
  updated_at       timestamptz not null default now()
);
alter table public.seller_preferences enable row level security;
