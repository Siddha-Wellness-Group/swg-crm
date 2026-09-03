-- Catches the ledger up to the Payments & Team tabs, generalized invoices,
-- and auto-invoice-on-Won-deal work that landed in parallel.

alter table orders add column if not exists related_type text;
alter table orders add column if not exists related_id text;

alter table invoices add column if not exists related_type text;
alter table invoices add column if not exists related_id text;
alter table invoices alter column owner drop not null; -- auto-generated invoices don't set an owner

alter table deals add column if not exists auto_invoiced boolean not null default false;

create table if not exists payments (
  id text primary key,
  created_at bigint not null,
  owner text,
  payee_type text,
  payee text,
  purpose text,
  amount numeric not null default 0,
  currencies jsonb not null default '[]',
  status text,
  due_date date,
  notes text
);

create table if not exists team (
  id text primary key,
  created_at bigint not null,
  name text not null,
  email text unique
);

do $$
declare
  t text;
begin
  for t in select unnest(array['payments','team'])
  loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy %I on %I for all to anon using (true) with check (true);',
      t || '_anon_all', t
    );
  end loop;
end $$;

grant select, insert, update, delete on payments, team to anon, authenticated, service_role;
