-- The email-worker Edge Function connects as service_role and got
-- "permission denied for table email_outbox".
--
-- 20260831150000_service_role_privileges.sql already ran
--   grant ... on all tables in schema public to service_role;
-- but ALL TABLES only covers the tables that existed the moment it ran.
-- email_log and email_outbox were created afterwards, so they were never
-- covered. Same trap the anon grant hit before it.

grant select, insert, update, delete on email_log to service_role;
grant select, insert, update, delete on email_outbox to service_role;

-- Stop this from happening a third time: anything created in public from
-- now on grants these roles automatically, so a new table is usable without
-- remembering to come back here.
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant select, insert, update, delete on tables to anon, authenticated;
