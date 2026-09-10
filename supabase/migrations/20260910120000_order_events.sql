-- Order status history. Nothing about "when did this order become Shipped"
-- is recorded anywhere today -- see checkOrderStatusChange in swg_crm.html,
-- which reacts to a Pending->Shipped transition but discards it right after
-- sending the email. This is the durable log the Command Center's order
-- timeline reads from, going forward only: existing orders have zero rows
-- here, and the UI falls back to created_at + current status for those --
-- it must never fabricate intermediate history.

create table if not exists order_events (
  id text primary key,
  order_id text not null references orders(id) on delete cascade,
  status text not null,
  note text,
  created_at bigint not null
);

create index if not exists order_events_order_id_idx on order_events (order_id, created_at);

alter table order_events enable row level security;

-- Security model: this schema's usual pattern (see the comment in
-- 20260831120000_init_schema.sql) is a single "for all to anon" policy per
-- table, because the browser only ever holds the anon key and this is a
-- documented placeholder until real per-user auth lands -- removing anon
-- access entirely would just break the feature, not make it safer.
--
-- But unlike every other table here, nothing in the app ever needs to
-- UPDATE or DELETE an order_events row once it's written -- it's meant to
-- be an append-only audit trail (see requiresAttention()/orderEventsFor()
-- callers in swg_crm.html, which only ever select and insert). So this
-- table gets select+insert only for anon/authenticated; update and delete
-- are simply not granted. That's a real hardening over this schema's usual
-- "for all" default, at zero cost to the feature, and it means a compromised
-- anon key can add noise to the log but can't rewrite or erase order
-- history. service_role (used only by trusted backend code, never the
-- browser) keeps full access for any future admin/cleanup tooling.
do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'order_events' and policyname = 'order_events_anon_select'
  ) then
    create policy order_events_anon_select on order_events for select to anon, authenticated using (true);
  end if;
  if not exists (
    select 1 from pg_policies where tablename = 'order_events' and policyname = 'order_events_anon_insert'
  ) then
    create policy order_events_anon_insert on order_events for insert to anon, authenticated with check (true);
  end if;
end $$;

grant select, insert on order_events to anon, authenticated;
grant select, insert, update, delete on order_events to service_role;
