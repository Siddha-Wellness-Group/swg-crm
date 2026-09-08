-- Wakes the email-worker Edge Function. Without this, rows land in
-- email_outbox and nothing ever sends them.
--
-- Two ways in, on purpose:
--
--   1. A trigger on INSERT -> the function is called the moment a row is
--      queued, so a customer gets their email in seconds.
--   2. A cron sweep every 2 minutes -> catches whatever the trigger missed
--      (a dropped request, a redeploy mid-call) and re-queues rows a
--      crashed run left sitting in 'processing'. A webhook that silently
--      fails once would otherwise mean an email nobody ever receives and
--      nobody notices.
--
-- Both call the same endpoint and the function claims rows with a
-- compare-and-swap, so the two firing together cannot double-send.
--
-- PREREQUISITE -- run this once first, with your own service role key
-- (Project Settings -> API -> service_role). It goes straight into Vault;
-- it is never written into this file:
--
--   select vault.create_secret('PASTE_SERVICE_ROLE_KEY_HERE', 'service_role_key');
--
-- To rotate it later:
--   select vault.update_secret(
--     (select id from vault.secrets where name = 'service_role_key'),
--     'NEW_KEY_HERE');

create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron;

-- Reads the key back out of Vault at call time, so it lives in exactly one
-- place and rotating it needs no code change.
create or replace function public.email_worker_invoke()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  key text;
begin
  select decrypted_secret into key
  from vault.decrypted_secrets
  where name = 'service_role_key'
  limit 1;

  if key is null then
    raise warning 'email_worker_invoke: no service_role_key in vault, skipping';
    return;
  end if;

  perform net.http_post(
    url     := 'https://jrsefbwmumoadncygjsz.supabase.co/functions/v1/email-worker',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'Authorization', 'Bearer ' || key
               ),
    body    := '{}'::jsonb
  );
end;
$$;

-- 1. The doorbell.
create or replace function public.email_outbox_notify()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only a genuinely new job is worth waking the worker for. Status changes
  -- the worker itself makes (queued -> processing -> sent) must not
  -- re-trigger it.
  if new.status = 'queued' then
    perform public.email_worker_invoke();
  end if;
  return new;
end;
$$;

drop trigger if exists email_outbox_queued on email_outbox;
create trigger email_outbox_queued
  after insert on email_outbox
  for each row
  execute function public.email_outbox_notify();

-- 2. The safety net. Unschedule first so re-running this file is safe.
do $$
begin
  if exists (select 1 from cron.job where jobname = 'email-worker-sweep') then
    perform cron.unschedule('email-worker-sweep');
  end if;
end $$;

select cron.schedule(
  'email-worker-sweep',
  '*/2 * * * *',
  $$select public.email_worker_invoke();$$
);
