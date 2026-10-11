-- A test run of some areas of the test set only (owner, 2026-10-11:
-- "cheaper test runs - yes"): after a change to drafts, run the draft cases,
-- about a tenth of the cost of the whole set. Null: the whole set.
alter table public.assistant_eval_runs add column if not exists areas text[];
