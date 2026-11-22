-- Rollback for 20261123010000: back to the coarse admin/manager rule of 20261122230000. Run only if no staff row
-- uses sales_rep / marketing / support (otherwise first move them to 'viewer' or 'manager' with owner approval).
BEGIN;
DO $r$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','customers','deals','distributors','invoices','leads','payments','suppliers','tasks','orders','tickets'] LOOP
    IF to_regclass('public.' || t) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_insert ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_update ON public.%I', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_delete ON public.%I', t);
    EXECUTE format($p$CREATE POLICY crm_staff_insert ON public.%I FOR INSERT TO authenticated WITH CHECK (public.crm_staff_role() IN ('admin','manager'))$p$, t);
    EXECUTE format($p$CREATE POLICY crm_staff_update ON public.%I FOR UPDATE TO authenticated USING (public.crm_staff_role() IN ('admin','manager')) WITH CHECK (public.crm_staff_role() IN ('admin','manager'))$p$, t);
    EXECUTE format($p$CREATE POLICY crm_staff_delete ON public.%I FOR DELETE TO authenticated USING (public.crm_staff_role() = 'admin')$p$, t);
  END LOOP;
END $r$;
DROP FUNCTION IF EXISTS public.crm_can(text, text);
DROP TABLE IF EXISTS public.crm_role_permissions;
ALTER TABLE public.crm_staff DROP CONSTRAINT IF EXISTS crm_staff_role_check;
ALTER TABLE public.crm_staff ADD CONSTRAINT crm_staff_role_check CHECK (role IN ('admin','manager','viewer'));
COMMIT;
