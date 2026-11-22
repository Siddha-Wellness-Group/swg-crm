-- swg-crm — 2026-11-23 — server-side permissions that MIRROR the CRM's own role profiles (settings.profiles),
-- so the database ceiling preserves each user's original authorized rights instead of a coarse 3-level model.
-- Roles: admin (everything + settings/team), manager, sales_rep, marketing, support, viewer (Read Only).
-- Object rights copied from the live 'profiles' setting on 2026-11-23:
--   Manager   : contacts customers deals distributors invoices leads payments suppliers tasks = C/E/D
--   Sales Rep : contacts C/E, customers C/E, leads C/E, tasks C/E/D
--   Marketing : contacts C/E, leads C/E/D, tasks C/E/D
--   Support   : contacts E, customers E, tasks C/E/D
--   Read Only : nothing
-- Objects the profiles do not cover (orders, tickets) keep the previous rule: admin + manager write, admin delete.
-- Reads stay "any active staff". anon stays revoked. Rollback: ../rollback/20261123010001_*.sql
BEGIN;

ALTER TABLE public.crm_staff DROP CONSTRAINT IF EXISTS crm_staff_role_check;
ALTER TABLE public.crm_staff ADD CONSTRAINT crm_staff_role_check
  CHECK (role IN ('admin','manager','sales_rep','marketing','support','viewer'));

CREATE TABLE IF NOT EXISTS public.crm_role_permissions (
  role       text NOT NULL,
  object     text NOT NULL,
  can_create boolean NOT NULL DEFAULT false,
  can_edit   boolean NOT NULL DEFAULT false,
  can_delete boolean NOT NULL DEFAULT false,
  PRIMARY KEY (role, object)
);
ALTER TABLE public.crm_role_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_role_permissions FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.crm_role_permissions TO authenticated;
DROP POLICY IF EXISTS crm_role_permissions_read ON public.crm_role_permissions;
CREATE POLICY crm_role_permissions_read ON public.crm_role_permissions FOR SELECT TO authenticated USING (public.crm_is_staff());

DELETE FROM public.crm_role_permissions;
INSERT INTO public.crm_role_permissions(role, object, can_create, can_edit, can_delete)
SELECT 'admin', o, true, true, true FROM unnest(ARRAY['contacts','customers','deals','distributors','invoices','leads','payments','suppliers','tasks','orders','tickets']) o
UNION ALL
SELECT 'manager', o, true, true, true FROM unnest(ARRAY['contacts','customers','deals','distributors','invoices','leads','payments','suppliers','tasks']) o
UNION ALL
SELECT 'manager', o, true, true, false FROM unnest(ARRAY['orders','tickets']) o
UNION ALL
VALUES ('sales_rep','contacts',true,true,false), ('sales_rep','customers',true,true,false), ('sales_rep','leads',true,true,false), ('sales_rep','tasks',true,true,true),
       ('marketing','contacts',true,true,false), ('marketing','leads',true,true,true), ('marketing','tasks',true,true,true),
       ('support','contacts',false,true,false), ('support','customers',false,true,false), ('support','tasks',true,true,true);

CREATE OR REPLACE FUNCTION public.crm_can(p_object text, p_op text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT coalesce((SELECT CASE p_op WHEN 'create' THEN p.can_create WHEN 'edit' THEN p.can_edit WHEN 'delete' THEN p.can_delete ELSE false END
                     FROM public.crm_role_permissions p WHERE p.role = public.crm_staff_role() AND p.object = p_object), false)
$$;
REVOKE ALL ON FUNCTION public.crm_can(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_can(text, text) TO authenticated;

DO $acl$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','customers','deals','distributors','invoices','leads','payments','suppliers','tasks','orders','tickets'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_delete ON public.%I', t);
    EXECUTE format($p$CREATE POLICY crm_staff_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.crm_can(%L, 'create'))$p$, t, t);
    EXECUTE format($p$CREATE POLICY crm_staff_update ON public.%I FOR UPDATE TO authenticated USING (public.crm_can(%L, 'edit')) WITH CHECK (public.crm_can(%L, 'edit'))$p$, t, t, t);
    EXECUTE format($p$CREATE POLICY crm_staff_delete ON public.%I FOR DELETE TO authenticated USING (public.crm_can(%L, 'delete'))$p$, t, t);
  END LOOP;
END $acl$;

COMMIT;
