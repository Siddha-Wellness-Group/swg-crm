-- Rollback for 20261123000000: restore the aal2 (two-step verification) requirement for CRM staff.
BEGIN;
CREATE OR REPLACE FUNCTION public.crm_is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT coalesce(auth.jwt()->>'aal', '') = 'aal2'
     AND EXISTS (SELECT 1 FROM public.crm_staff s WHERE s.user_id = auth.uid() AND s.active)
$$;
CREATE OR REPLACE FUNCTION public.crm_staff_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT s.role FROM public.crm_staff s
   WHERE s.user_id = auth.uid() AND s.active AND coalesce(auth.jwt()->>'aal', '') = 'aal2'
$$;
REVOKE ALL ON FUNCTION public.crm_is_staff(), public.crm_staff_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_is_staff(), public.crm_staff_role() TO authenticated;
COMMIT;
