-- RLS policies alone don't grant table access -- Postgres also requires
-- the base GRANT. Without this, 'anon' gets "permission denied" before
-- RLS is even evaluated.
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
