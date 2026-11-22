-- Rollback for 20261122230000: back to the read-only staff state of 20261122200000 (7 tables) + containment.
BEGIN;
DO $r$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','leads','customers','distributors','suppliers','deals','orders','tasks','invoices','payments','tickets',
                           'email_log','metric_snapshots','education_requests','team','settings','order_events','email_outbox'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_delete ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_admin_write ON public.%I', t);
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE ON public.%I FROM authenticated', t);
    IF t NOT IN ('contacts','leads','customers','deals','orders','tickets','education_requests') THEN
      EXECUTE format('DROP POLICY IF EXISTS crm_staff_read ON public.%I', t);
      EXECUTE format('REVOKE SELECT ON public.%I FROM authenticated', t);
    END IF;
  END LOOP;
END $r$;
DROP FUNCTION IF EXISTS public.crm_staff_role();
COMMIT;
