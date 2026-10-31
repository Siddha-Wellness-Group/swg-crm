-- Departments + lead stage history.
--
-- 1. department (text, nullable) on every record table the CRM scopes by
--    department. The app stamps it on insert with the creator's department
--    (see stampDepartment in swg_crm.html); NULL means "unassigned", which
--    stays visible to everyone unless Strict mode is on.
--
-- 2. stage_history (jsonb) on leads: an append-only list of
--    {status, at, by} entries that powers the lead record page's pipeline
--    and lifespan view. Existing leads start with an empty list; the app
--    shows "history starts here" for them rather than inventing a past.
--
-- The app tolerates this migration not being applied yet (it drops unknown
-- columns and retries), but nothing is stored until it is.
--
-- Isolation note: the browser still talks to the database with the shared
-- publishable key, and the existing *_anon_all policies stay as they are,
-- so department isolation is enforced by the app, not by Postgres. Moving
-- it into row-level security needs per-user sign-in (Supabase Auth) first;
-- these columns and the index below are what those policies will key on.

do $$
declare
  t text;
begin
  foreach t in array array[
    'contacts','leads','customers','distributors','suppliers',
    'deals','orders','tasks','invoices','payments'
  ] loop
    if to_regclass(t) is not null then
      execute format('alter table %I add column if not exists department text', t);
      execute format('create index if not exists %I on %I (department)', t || '_department_idx', t);
    end if;
  end loop;
end $$;

alter table leads add column if not exists stage_history jsonb not null default '[]';
