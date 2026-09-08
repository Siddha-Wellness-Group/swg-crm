-- Delivery log for the automated email service (src/services/email).
-- One row per send attempt outcome, written by the Node service and read by
-- the Emails section of the CRM dashboard.
--
-- Column names mirror the structured log record the service already emits,
-- so a log shipper can insert straight from it without a mapping layer.

create table if not exists email_log (
  id text primary key,
  created_at bigint not null,
  -- Correlation id shared by every log line for one send.
  correlation_id text,
  -- Message id returned by the SMTP transport once accepted.
  message_id text,
  -- order_confirmation | shipping_update | internal_alert | auto_reply
  category text not null,
  -- Template that produced the body, without the .html suffix.
  template text,
  recipient text not null,
  subject text,
  -- sent | dry-run | failed | queued
  status text not null,
  attempts integer default 1,
  duration_ms integer,
  -- Populated only when status = 'failed'.
  reason text,
  -- Order, ticket or deal this message belongs to, when there is one.
  related_type text,
  related_id text
);

create index if not exists email_log_created_at_idx on email_log (created_at desc);
create index if not exists email_log_status_idx on email_log (status);
create index if not exists email_log_recipient_idx on email_log (recipient);

-- Same placeholder access model as the rest of the ledger: the app
-- authenticates in-page, not against Postgres. Replace with per-user
-- policies when the rest of the schema moves to Supabase Auth.
alter table email_log enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'email_log' and policyname = 'email_log_anon_all'
  ) then
    create policy email_log_anon_all on email_log for all to anon using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on email_log to anon, authenticated;
