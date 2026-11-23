-- Rollback of 20261123100000 (not auto-applied). Keeps micha_gateway.write_log for audit.
BEGIN;
DROP FUNCTION IF EXISTS public.micha_crm_gateway(text, text, jsonb);
DROP FUNCTION IF EXISTS micha_gateway.editable(text);
COMMIT;
