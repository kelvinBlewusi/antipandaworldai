-- Where a live change's result is told (owner, 2026-10-11: a sale refused
-- for a change made in the web chat was told on WhatsApp, not in the chat).
-- The address the change was sent from: a WhatsApp number or the web chat's
-- "web:<user id>". Empty on rows from before: those go to the seller's WhatsApp.
alter table public.jumia_product_changes add column if not exists reply_to text;
