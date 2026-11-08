-- Finance Dashboard: a standalone ledger for income and expenses that the
-- rest of the CRM does not record -- marketing spend, logistics, operating
-- costs, other income. Purely additive: two new tables, no change to any
-- existing table, column, policy or function.
--
-- What it deliberately does NOT hold: sales the CRM already knows about.
-- Paid invoices, paid storefront orders and paid payments are shown in the
-- Finance Dashboard read-only, derived live from their own tables by the
-- same rules as financeData() in swg_crm.html. Copying them in here would
-- mean two sources of truth for the same money and a double count the
-- moment either side changed. `source` / `source_id` exist so a future
-- sync can link rows to their origin, and the unique index on that pair
-- makes the same origin record impossible to import twice.

create table if not exists finance_categories (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  name text not null,
  kind text not null check (kind in ('income','expense')),
  -- Reporting group a category rolls up into (Revenue, Operating, ...).
  group_name text not null,
  color text,
  -- Archived rather than deleted once anything uses it: see the FK below.
  archived boolean not null default false
);

create unique index if not exists finance_categories_kind_name_key
  on finance_categories (kind, lower(name));

create table if not exists finance_transactions (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  -- The business date of the movement, which is not necessarily the day
  -- someone typed it in (that is created_at).
  occurred_on date not null,
  kind text not null check (kind in ('income','expense')),
  -- Always positive; direction comes from `kind`, so a sum by kind can
  -- never be thrown off by a stray minus sign.
  amount numeric(14,2) not null check (amount > 0),
  currency text not null default 'USD',
  -- restrict, not set null: deleting a category that money is filed under
  -- would silently move that money to "uncategorised" and change every
  -- report. The UI archives used categories instead.
  category_id text references finance_categories(id) on delete restrict,
  description text not null,
  counterparty text,
  status text not null default 'cleared' check (status in ('cleared','pending')),
  notes text,
  source text not null default 'manual' check (source in ('manual','invoice','order','payment')),
  source_id text
);

create index if not exists finance_transactions_occurred_on_idx on finance_transactions (occurred_on);
create index if not exists finance_transactions_category_idx on finance_transactions (category_id);
create unique index if not exists finance_transactions_source_key
  on finance_transactions (source, source_id) where source_id is not null;

-- Starter categories: a taxonomy, not financial records. Deterministic ids
-- and do-nothing on conflict, so re-running this file never duplicates
-- them or overwrites a category someone has since renamed or recoloured.
insert into finance_categories (id, created_at, owner, name, kind, group_name, color) values
  ('fcat_revenue',        1794096000000, 'system', 'Revenue',                'income',  'Revenue',                '#16805A'),
  ('fcat_other_income',   1794096000000, 'system', 'Other income',           'income',  'Revenue',                '#0F766E'),
  ('fcat_operating',      1794096000000, 'system', 'Operating expenses',     'expense', 'Operating',              '#2563EB'),
  ('fcat_marketing',      1794096000000, 'system', 'Marketing expenses',     'expense', 'Marketing',              '#BE185D'),
  ('fcat_logistics',      1794096000000, 'system', 'Logistics & operations', 'expense', 'Logistics & operations', '#C4670F'),
  ('fcat_other_expenses', 1794096000000, 'system', 'Other expenses',         'expense', 'Other',                  '#6E6759')
on conflict do nothing;

-- Security: the same placeholder model as every other table here (the
-- browser holds only the anon key; there is no per-user auth yet), with
-- the 2026-09-15 hardening applied from the start -- revoke the platform's
-- default ALL grant, then grant exactly what the UI uses. The Finance
-- Dashboard's viewer list is enforced in the UI, which, as for invoices
-- and payments today, is not a database security boundary.
alter table finance_categories enable row level security;
alter table finance_transactions enable row level security;

do $policies$
begin
  if not exists (select 1 from pg_policies where tablename = 'finance_categories' and policyname = 'finance_categories_anon_all') then
    create policy finance_categories_anon_all on finance_categories for all to anon, authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where tablename = 'finance_transactions' and policyname = 'finance_transactions_anon_all') then
    create policy finance_transactions_anon_all on finance_transactions for all to anon, authenticated using (true) with check (true);
  end if;
end $policies$;

revoke all on finance_categories, finance_transactions from anon, authenticated;
grant select, insert, update, delete on finance_categories, finance_transactions to anon, authenticated;
grant select, insert, update, delete on finance_categories, finance_transactions to service_role;

notify pgrst, 'reload schema';
