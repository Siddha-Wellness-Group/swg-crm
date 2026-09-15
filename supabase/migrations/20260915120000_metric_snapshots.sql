-- Daily history for the Command Center's three state-based metrics.
--
-- New customers / New orders / Revenue are counted over a window, so
-- comparing a window to the window before it is free -- the orders and
-- customers rows are still there. To fulfill, Shipped and Attention are
-- not like that: they describe right now. "3 orders are Pending" is true
-- at the moment you look and nothing anywhere records that it was 9 last
-- Tuesday. order_events does not fill the gap either -- it only holds
-- transitions since it landed, and only for orders someone has touched
-- since, so counting backwards from it would undercount silently.
--
-- So the number has to be written down each day, on the day. This table is
-- that log, and everything in it is measured, never back-filled: a range
-- with no row behind it shows a plain number in the UI rather than an
-- invented trend (see fcSnapshotDelta in swg_crm.html).

create table if not exists metric_snapshots (
  id text primary key,
  created_at bigint not null,
  -- The local (Asia/Jerusalem) day this row describes. The business reads
  -- these numbers in Israel time; a UTC day would cut the evening off the
  -- wrong end.
  snapshot_date date not null unique,
  to_fulfill int not null,
  shipped int not null,
  attention int not null,
  -- The four attention buckets kept separately as well as summed. The sum
  -- is what the strip shows, but "the backlog doubled" is only actionable
  -- if you can see which bucket did the doubling.
  attn_waiting_fulfillment int not null,
  attn_missing_address int not null,
  attn_shipped_stale int not null,
  attn_open_tickets int not null
);

create index if not exists metric_snapshots_date_idx on metric_snapshots (snapshot_date desc);

alter table metric_snapshots enable row level security;

-- Same reasoning as order_events: the browser reads this and nothing else.
-- The rows are written by the cron job below, which runs as the function
-- owner, so anon needs select and nothing more. A compromised anon key
-- cannot forge a history that makes the backlog look better than it was.
do $policy$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'metric_snapshots' and policyname = 'metric_snapshots_anon_select'
  ) then
    create policy metric_snapshots_anon_select on metric_snapshots for select to anon, authenticated using (true);
  end if;
end $policy$;

-- The revoke is not redundant. Supabase's platform default ACL on schema
-- public grants ALL on every newly created table to anon and authenticated
-- before a line of this file runs -- confirmed against pg_default_acl, and
-- it is why order_events also carries insert/update/delete it never wanted.
-- RLS still blocks the writes (there is no insert/update/delete policy
-- here), so this is defence in depth rather than a fix for a hole; it just
-- means the grants say what the policy says, and a future "for all"
-- policy added in haste cannot quietly open writes.
revoke all on metric_snapshots from anon, authenticated;
grant select on metric_snapshots to anon, authenticated;
grant select, insert, update, delete on metric_snapshots to service_role;

-- Counts today exactly the way requiresAttention() in swg_crm.html counts
-- it, because a snapshot measured by different rules than the live number
-- is worse than no snapshot -- the delta would then report the difference
-- between two definitions, not a change in the business.
--
-- The two must be changed together. If FC_PENDING_STALE_MS or
-- FC_SHIPPED_STALE_MS moves in the JS, or a fifth attention bucket is
-- added, this function has to move with it, and older rows keep the old
-- definition (they are a record of what was true under the rules of the
-- day, and rewriting them would be fabrication).
create or replace function public.capture_metric_snapshot()
returns void
language plpgsql
security definer
set search_path = public
as $fn$
declare
  now_ms           bigint := (extract(epoch from now()) * 1000)::bigint;
  -- FC_PENDING_STALE_MS / FC_SHIPPED_STALE_MS in swg_crm.html.
  pending_stale_ms bigint := 48 * 3600 * 1000;
  shipped_stale_ms bigint := 5 * 24 * 3600 * 1000;
  v_to_fulfill int;
  v_shipped    int;
  v_waiting    int;
  v_missing    int;
  v_stale      int;
  v_tickets    int;
begin
  select count(*) into v_to_fulfill from orders where status = 'Pending';
  select count(*) into v_shipped    from orders where status = 'Shipped';

  -- Bucket 1: Pending for longer than 48h.
  select count(*) into v_waiting
  from orders
  where status = 'Pending'
    and (now_ms - coalesce(created_at, 0)) > pending_stale_ms;

  -- Bucket 2: no usable shipping address, and not Cancelled. Mirrors
  -- fcOrderMissingAddress: absent, blank string, or an object whose every
  -- value is blank.
  select count(*) into v_missing
  from orders o
  where coalesce(o.status, '') <> 'Cancelled'
    and (
      o.shipping_address is null
      or jsonb_typeof(o.shipping_address) = 'null'
      or (jsonb_typeof(o.shipping_address) = 'string'
          and btrim(o.shipping_address #>> '{}') = '')
      or (jsonb_typeof(o.shipping_address) = 'object'
          and not exists (
            select 1 from jsonb_each_text(o.shipping_address) kv
            where btrim(coalesce(kv.value, '')) <> ''
          ))
    );

  -- Bucket 3: Shipped more than 5 days ago and still not Delivered. Ship
  -- date comes from the order_events log where there is one, falling back
  -- to created_at for orders shipped before that table existed -- the same
  -- fallback fcShippedSince() uses, so the two agree on the older orders
  -- rather than one of them quietly treating them as fresh.
  select count(*) into v_stale
  from orders o
  where o.status = 'Shipped'
    and (now_ms - coalesce(
           (select max(e.created_at) from order_events e
             where e.order_id = o.id and e.status = 'Shipped'),
           o.created_at, 0)) > shipped_stale_ms;

  -- Bucket 4: customers with an open enquiry. Counted per distinct email
  -- rather than per ticket, matching the JS, which dedupes to one entry per
  -- customer however many tickets that customer has open.
  select count(distinct lower(btrim(t.email))) into v_tickets
  from tickets t
  where t.status in ('new', 'open')
    and coalesce(btrim(t.email), '') <> ''
    and exists (
      select 1 from customers c
      where lower(btrim(coalesce(c.email, ''))) = lower(btrim(t.email))
    );

  -- attention is the plain sum, including the overlap: an order that is
  -- both stale and address-less counts twice. That is what the strip and
  -- the Requires Attention panel already show, and a snapshot that
  -- de-duplicated would not be comparable to the live number beside it.
  insert into metric_snapshots (
    id, created_at, snapshot_date, to_fulfill, shipped, attention,
    attn_waiting_fulfillment, attn_missing_address, attn_shipped_stale, attn_open_tickets
  )
  values (
    'snap_' || to_char((now() at time zone 'Asia/Jerusalem')::date, 'YYYYMMDD'),
    now_ms,
    (now() at time zone 'Asia/Jerusalem')::date,
    v_to_fulfill, v_shipped,
    v_waiting + v_missing + v_stale + v_tickets,
    v_waiting, v_missing, v_stale, v_tickets
  )
  -- Running twice in one day overwrites that day rather than adding a
  -- second row, so a manual run or a retried cron tick stays harmless.
  on conflict (id) do update set
    created_at               = excluded.created_at,
    to_fulfill               = excluded.to_fulfill,
    shipped                  = excluded.shipped,
    attention                = excluded.attention,
    attn_waiting_fulfillment = excluded.attn_waiting_fulfillment,
    attn_missing_address     = excluded.attn_missing_address,
    attn_shipped_stale       = excluded.attn_shipped_stale,
    attn_open_tickets        = excluded.attn_open_tickets;
end;
$fn$;

-- 20:00 UTC is 22:00 or 23:00 in Israel depending on daylight saving --
-- late enough that the day's work is done, early enough that it is still
-- the same local day either way, so the row never lands under tomorrow's
-- date. Unschedule first so re-running this file is safe, same as the
-- email-worker sweep.
do $sched$
begin
  if exists (select 1 from cron.job where jobname = 'metric-snapshot-daily') then
    perform cron.unschedule('metric-snapshot-daily');
  end if;
end $sched$;

select cron.schedule(
  'metric-snapshot-daily',
  '0 20 * * *',
  $job$select public.capture_metric_snapshot();$job$
);

-- One row from today, so the log starts now rather than tomorrow night.
select public.capture_metric_snapshot();

notify pgrst, 'reload schema';
