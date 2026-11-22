-- swg-crm — 2026-11-22/23 — OWNER DECISION (explicitly approved): no mandatory MFA/TOTP in the SWG CRM for any role.
-- Access still requires a signed-in Supabase Auth user (authenticated role, valid JWT) who is an ACTIVE row in
-- public.crm_staff; roles (viewer/manager/admin) and every RLS policy are unchanged; anon stays revoked.
-- Only the aal2 condition is removed from the two helper functions every policy and RPC uses.
-- MICHA's own Brain/Admin MFA policies are NOT affected (different project).
-- Rollback: supabase/rollback/20261123000001_rollback_crm_remove_mfa_requirement.sql (restores aal2).
BEGIN;

CREATE OR REPLACE FUNCTION public.crm_is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.crm_staff s WHERE s.user_id = auth.uid() AND s.active)
$$;

CREATE OR REPLACE FUNCTION public.crm_staff_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT s.role FROM public.crm_staff s
   WHERE s.user_id = auth.uid() AND s.active
$$;

REVOKE ALL ON FUNCTION public.crm_is_staff(), public.crm_staff_role() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_is_staff(), public.crm_staff_role() TO authenticated;

COMMIT;
