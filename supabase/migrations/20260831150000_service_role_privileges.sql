-- The storefront-order Edge Function connects as service_role. Same class
-- of issue as the earlier anon/authenticated fix: RLS bypass alone isn't
-- enough, service_role still needs the base table GRANT.
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
