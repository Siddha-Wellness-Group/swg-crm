-- Rollback for 20261122200000_crm_staff_read_and_micha_summary.sql (swg-crm). Restores the 2026-11-12 containment state.
BEGIN;
DO $r$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads','contacts','customers','deals','orders','tickets','education_requests'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_read ON public.%I', t);
    EXECUTE format('REVOKE SELECT ON public.%I FROM authenticated', t);
  END LOOP;
END $r$;
DROP FUNCTION IF EXISTS public.micha_crm_summary();
DROP FUNCTION IF EXISTS public.crm_is_staff();
DROP TABLE IF EXISTS public.crm_staff;
DROP SCHEMA IF EXISTS micha_gateway CASCADE;
COMMIT;
