-- ─── The chat's weekly warning signs and test runs (step 4 of the plan) ──────
--
-- Every Monday at 06:41 UTC (06:41 in Ghana), app/api/worker/assistant-weekly
-- (lib/evals/weekly.ts): the week's warning signs to the owner on WhatsApp
-- (lib/evals/warning-signs.ts, /admin/warning-signs), and the week's test
-- runs queued (agent mode and the front door, note 'weekly'). A weekly run
-- that does worse than the run before it is sent to the owner when it
-- finishes. No table: the signs are read from whatsapp_assistant_log and
-- whatsapp_message_log, the runs are rows in assistant_eval_runs.

select cron.unschedule('assistant-weekly') where exists (select 1 from cron.job where jobname = 'assistant-weekly');
select cron.schedule(
  'assistant-weekly',
  '41 6 * * 1',
  $$
  select net.http_post(
    url     := 'https://pandaworldai.site/api/worker/assistant-weekly',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    timeout_milliseconds := 60000
  )
  $$
);
