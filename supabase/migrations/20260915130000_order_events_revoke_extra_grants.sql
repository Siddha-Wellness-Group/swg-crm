-- order_events was meant to be select+insert only for anon/authenticated
-- (see the comment in 20260910120000_order_events.sql) -- but Supabase's
-- platform default ACL on schema public grants ALL on every newly created
-- table to anon/authenticated before a migration's own grants even run
-- (confirmed against pg_default_acl while building metric_snapshots). So
-- the table has carried unwanted update/delete grants since it was
-- created. RLS already blocks those writes -- there is no update/delete
-- policy on this table -- so this is defence in depth, not a fix for a
-- live hole: it just makes the grants agree with the policy, the same
-- revoke already applied to metric_snapshots in
-- 20260915120000_metric_snapshots.sql.

revoke all on order_events from anon, authenticated;
grant select, insert on order_events to anon, authenticated;
