-- The bot's own messages in the seller's language (lib/i18n/bot.ts): each
-- line translated once, then read from here. Keyed by the language and a
-- hash of the English line and its length limit. Server-only (service role):
-- RLS on, no policies.
create table if not exists public.bot_translations (
  lang        text not null check (lang in ('fr', 'ar')),
  source_hash text not null,
  translated  text not null,
  created_at  timestamptz not null default now(),
  primary key (lang, source_hash)
);

alter table public.bot_translations enable row level security;
