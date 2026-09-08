-- Support tickets. Hook 4 of the CRM <-> email integration needs somewhere
-- for an enquiry to live before an auto-reply means anything.
--
-- The storefront already collects these: it has a ContactMessage entity and
-- a Contact page, and src/pages/Contact.jsx does exactly one thing with a
-- submission -- ContactMessage.create(form). Nothing emails the customer,
-- and nothing tells the team. A message sits in the Base44 admin screen
-- until somebody happens to look. This table is the CRM's side of that, so
-- an enquiry becomes a tracked ticket that can be acknowledged and worked.

create table if not exists tickets (
  id text primary key,
  created_at bigint not null,
  owner text not null,
  -- Human reference quoted back to the customer, e.g. TCK-4A9F21.
  ticket_number text,
  -- Who asked. contact_id links to the ledger when we recognise the email.
  contact_id text references contacts(id) on delete set null,
  name text not null,
  email text not null,
  phone text,
  subject text,
  message text not null,
  -- new -> open -> resolved | closed
  status text not null default 'new',
  -- Website | Email | Phone | CRM
  source text,
  -- The storefront's own ContactMessage id, so a retried delivery updates
  -- the same ticket instead of creating a duplicate.
  external_id text,
  assigned_to text,
  notes text
);

create index if not exists tickets_status_idx on tickets (status, created_at desc);
create index if not exists tickets_email_idx on tickets (email);
create unique index if not exists tickets_source_external_key
  on tickets (source, external_id)
  where external_id is not null;

-- Same placeholder access model as the rest of the ledger.
alter table tickets enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'tickets' and policyname = 'tickets_anon_all'
  ) then
    create policy tickets_anon_all on tickets for all to anon using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on tickets to anon, authenticated, service_role;
