-- Initial schema for the SWG CRM, mirroring the current in-app data model
-- (contacts, deals, orders, customers, suppliers, distributors, products, leads, tasks, invoices).
-- IDs stay TEXT to match the app's existing uid() format (id_<timestamp><random>),
-- so any future import of existing localStorage/Artifact data doesn't need re-keying.

create table if not exists contacts (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  name text not null,
  kind text,
  company text,
  type text,
  email text,
  phone text,
  notes text
);

create table if not exists customers (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  name text not null,
  kind text,
  company text,
  email text,
  phone text,
  country text,
  city text,
  address text,
  notes text
);

create table if not exists suppliers (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  name text not null,
  company text,
  email text,
  phone text,
  notes text
);

create table if not exists distributors (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  name text not null,
  company text,
  continents jsonb not null default '[]',
  subregions jsonb not null default '[]',
  email text,
  phone text,
  notes text
);

create table if not exists products (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  name text not null,
  serial text,
  unit text,
  sizes jsonb not null default '[]',
  currencies jsonb not null default '[]',
  price numeric not null default 0,
  stock text,
  notes text
);

create table if not exists leads (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  name text not null,
  kind text,
  company text,
  sources jsonb not null default '[]',
  source text,
  status text,
  email text,
  phone text,
  notes text
);

create table if not exists deals (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  title text not null,
  contact_id text references contacts(id) on delete set null,
  currencies jsonb not null default '[]',
  value numeric not null default 0,
  stage text,
  notes text
);

create table if not exists orders (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  contact_id text references contacts(id) on delete set null,
  product text not null,
  qty numeric not null default 1,
  amount numeric not null default 0,
  currencies jsonb not null default '[]',
  status text
);

create table if not exists tasks (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  title text not null,
  due_date date,
  status text,
  link_type text,
  link_id text,
  notes text
);

create table if not exists invoices (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  customer_id text references customers(id) on delete set null,
  order_id text references orders(id) on delete set null,
  amount numeric not null default 0,
  currencies jsonb not null default '[]',
  status text,
  due_date date,
  notes text
);

-- RLS: enabled on every table. Policies below allow full access to the
-- 'anon' role, matching today's security model (one shared password, no
-- per-user enforcement). This is a placeholder, not a real security
-- boundary -- see the follow-up task to replace it with Supabase Auth +
-- per-row policies before real customer data goes in, since the anon key
-- ships inside swg_crm.html in a PUBLIC GitHub repo.
do $$
declare
  t text;
begin
  for t in select unnest(array[
    'contacts','customers','suppliers','distributors','products',
    'leads','deals','orders','tasks','invoices'
  ])
  loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy %I on %I for all to anon using (true) with check (true);',
      t || '_anon_all', t
    );
  end loop;
end $$;
