-- Outbox for the automated email service. This is item 2 of the CRM <-> email
-- integration: instead of the browser calling an HTTP endpoint that would
-- need a secret embedded in swg_crm.html (same exposure problem the anon key
-- already has -- see the note in 20260831120000_init_schema.sql), the browser
-- just inserts a row here with the anon key it already holds. A trusted Node
-- worker (src/server/emailWorker.js), which holds the real Gmail and
-- Supabase credentials, polls this table and does the actual sending. No
-- secret of any kind ever needs to reach swg_crm.html for this to work.

create table if not exists email_outbox (
  id text primary key,
  created_at bigint not null,
  -- orderConfirmation | shippingUpdate | internalAlert | autoReply
  type text not null,
  -- Exact arguments for the matching send function (see emailQueue.js HANDLERS).
  payload jsonb not null,
  -- queued -> processing -> sent | failed
  status text not null default 'queued',
  attempts integer not null default 0,
  last_error text,
  -- What in the ledger caused this email, for traceability. Optional.
  related_type text,
  related_id text,
  -- Set by whichever worker instance is currently processing the row.
  claimed_at bigint,
  claimed_by text,
  sent_at bigint
);

create index if not exists email_outbox_status_idx on email_outbox (status, created_at);

-- Lets the worker pick up new rows within ~1s over Realtime instead of
-- waiting for the next poll. The worker also polls on an interval regardless,
-- so this is a latency optimization, not a requirement.
alter publication supabase_realtime add table email_outbox;

-- Same placeholder access model as the rest of the ledger (see
-- 20260831120000_init_schema.sql): the app authenticates in-page, not
-- against Postgres. The worker itself never uses this policy -- it connects
-- with the service role key, which bypasses RLS entirely.
alter table email_outbox enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'email_outbox' and policyname = 'email_outbox_anon_all'
  ) then
    create policy email_outbox_anon_all on email_outbox for all to anon using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on email_outbox to anon, authenticated;
