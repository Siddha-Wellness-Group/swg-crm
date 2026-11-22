-- swg-crm — 2026-11-22 — role-based access for the FULL SWG CRM app (swg_crm.html, The-Main-Sacred-Branch 7eec233)
-- Builds on 20261122200000 (crm_staff, crm_is_staff = listed staff + aal2). Every rule below also requires aal2.
--   viewer  : read everything the app reads
--   manager : + create/edit business records (no delete, no settings/team changes)
--   admin   : + delete business records, edit settings and team
-- order_events stays append-only (insert, no update/delete), email_log stays read-only (server writes it).
-- anon stays revoked (2026-11-12 containment). No customer data is changed by this migration.
-- Rollback: supabase/rollback/20261122230001_rollback_crm_full_app_staff_access.sql
BEGIN;

CREATE OR REPLACE FUNCTION public.crm_staff_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT s.role FROM public.crm_staff s
   WHERE s.user_id = auth.uid() AND s.active AND coalesce(auth.jwt()->>'aal', '') = 'aal2'
$$;
REVOKE ALL ON FUNCTION public.crm_staff_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_staff_role() TO authenticated;

DO $acl$
DECLARE
  t text;
  business text[] := ARRAY['contacts','leads','customers','distributors','suppliers','deals','orders','tasks','invoices','payments','tickets'];
  readonly text[] := ARRAY['email_log','metric_snapshots','education_requests'];
BEGIN
  -- read for every staff role, on every table the app loads
  FOREACH t IN ARRAY business || readonly || ARRAY['team','settings','order_events','email_outbox'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_read ON public.%I', t);
    EXECUTE format('CREATE POLICY crm_staff_read ON public.%I FOR SELECT TO authenticated USING (public.crm_is_staff())', t);
  END LOOP;

  -- business records: manager+admin create/edit, admin delete
  FOREACH t IN ARRAY business LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_delete ON public.%I', t);
    EXECUTE format($p$CREATE POLICY crm_staff_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.crm_staff_role() IN ('admin','manager'))$p$, t);
    EXECUTE format($p$CREATE POLICY crm_staff_update ON public.%I FOR UPDATE TO authenticated USING (public.crm_staff_role() IN ('admin','manager')) WITH CHECK (public.crm_staff_role() IN ('admin','manager'))$p$, t);
    EXECUTE format($p$CREATE POLICY crm_staff_delete ON public.%I FOR DELETE TO authenticated USING (public.crm_staff_role() = 'admin')$p$, t);
  END LOOP;

  -- settings and team: admin only
  FOREACH t IN ARRAY ARRAY['settings','team'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('GRANT INSERT, UPDATE, DELETE ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_admin_write ON public.%I', t);
    EXECUTE format($p$CREATE POLICY crm_admin_write ON public.%I FOR ALL TO authenticated USING (public.crm_staff_role() = 'admin') WITH CHECK (public.crm_staff_role() = 'admin')$p$, t);
  END LOOP;

  -- order_events: append-only for manager+admin
  IF to_regclass('public.order_events') IS NOT NULL THEN
    GRANT INSERT ON public.order_events TO authenticated;
    REVOKE UPDATE, DELETE ON public.order_events FROM authenticated;
    DROP POLICY IF EXISTS crm_staff_insert ON public.order_events;
    CREATE POLICY crm_staff_insert ON public.order_events FOR INSERT TO authenticated WITH CHECK (public.crm_staff_role() IN ('admin','manager'));
  END IF;

  -- email_outbox: manager+admin may queue mail (the server worker sends it)
  IF to_regclass('public.email_outbox') IS NOT NULL THEN
    GRANT INSERT ON public.email_outbox TO authenticated;
    DROP POLICY IF EXISTS crm_staff_insert ON public.email_outbox;
    CREATE POLICY crm_staff_insert ON public.email_outbox FOR INSERT TO authenticated WITH CHECK (public.crm_staff_role() IN ('admin','manager'));
  END IF;
END $acl$;

COMMIT;
