-- swg-crm (jrsefbwmumoadncygjsz) — 2026-11-22
-- 1. Real CRM staff identity: Supabase Auth users listed in public.crm_staff may READ the CRM tables,
--    only with a two-step-verified session (aal2). No write access, no anon access (the 2026-11-12
--    containment stays in force). Replaces the browser-side shared password of swg_crm.html.
-- 2. MICHA summary gateway: public.micha_crm_summary() returns PII-free aggregates (counts, sums, months,
--    sources, statuses, product names, intake references) to MICHA's server only. Authorised by a
--    gateway key whose SHA-256 digest lives in a private schema, with an expiry and a revoke switch.
--    No name, email, phone, address, message or note column is ever read into the result.
-- Rollback: 20261122200001_rollback_crm_staff_read_and_micha_summary.sql (kept beside this file, not auto-applied).

BEGIN;

-- ── 1. Staff identity and read policies ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.crm_staff (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role       text NOT NULL CHECK (role IN ('admin','manager','viewer')),
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.crm_staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.crm_staff FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.crm_staff TO authenticated;
DROP POLICY IF EXISTS crm_staff_self ON public.crm_staff;
CREATE POLICY crm_staff_self ON public.crm_staff FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE OR REPLACE FUNCTION public.crm_is_staff() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT coalesce(auth.jwt()->>'aal', '') = 'aal2'
     AND EXISTS (SELECT 1 FROM public.crm_staff s WHERE s.user_id = auth.uid() AND s.active)
$$;
REVOKE ALL ON FUNCTION public.crm_is_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_is_staff() TO authenticated;

DO $grants$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['leads','contacts','customers','deals','orders','tickets','education_requests'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS crm_staff_read ON public.%I', t);
    EXECUTE format('CREATE POLICY crm_staff_read ON public.%I FOR SELECT TO authenticated USING (public.crm_is_staff())', t);
  END LOOP;
END $grants$;

-- ── 2. MICHA summary gateway ───────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS micha_gateway;
REVOKE ALL ON SCHEMA micha_gateway FROM PUBLIC, anon, authenticated;
CREATE TABLE IF NOT EXISTS micha_gateway.key (
  id             smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  digest         bytea NOT NULL CHECK (octet_length(digest) = 32),
  released_until timestamptz NOT NULL,
  revoked_at     timestamptz
);
CREATE TABLE IF NOT EXISTS micha_gateway.call_log (
  at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ok boolean NOT NULL
);
REVOKE ALL ON ALL TABLES IN SCHEMA micha_gateway FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.micha_crm_summary() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog SET statement_timeout = '4s' AS $fn$
DECLARE
  supplied text := current_setting('request.headers', true)::jsonb->>'x-micha-gateway-key';
  now_ms bigint := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  month_start_ms bigint := (extract(epoch FROM date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC') - interval '5 months') * 1000)::bigint;
  result jsonb;
BEGIN
  IF supplied IS NULL OR supplied !~ '^[A-Za-z0-9_-]{43,64}$' THEN RETURN NULL; END IF;
  IF NOT EXISTS (SELECT 1 FROM micha_gateway.key k
                 WHERE k.digest = sha256(convert_to(supplied, 'UTF8'))
                   AND k.revoked_at IS NULL AND k.released_until > clock_timestamp()) THEN
    INSERT INTO micha_gateway.call_log(ok) VALUES (false);
    RETURN NULL;
  END IF;
  IF (SELECT count(*) FROM micha_gateway.call_log WHERE at > clock_timestamp() - interval '1 hour') >= 240 THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'as_of', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'leads', (SELECT jsonb_build_object(
        'total', count(*),
        'last_30_days', count(*) FILTER (WHERE created_at > now_ms - 30::bigint*86400000),
        'last_90_days', count(*) FILTER (WHERE created_at > now_ms - 90::bigint*86400000),
        'newest_at', to_char(to_timestamp(max(created_at)/1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
        'by_status', coalesce((SELECT jsonb_object_agg(k, v) FROM (SELECT coalesce(status,'unknown') k, count(*) v FROM public.leads GROUP BY 1) s), '{}'::jsonb),
        'by_source', coalesce((SELECT jsonb_object_agg(k, v) FROM (SELECT coalesce(source,'unknown') k, count(*) v FROM public.leads GROUP BY 1) s), '{}'::jsonb),
        'by_month_last_6', coalesce((SELECT jsonb_agg(jsonb_build_object('month', m, 'count', c) ORDER BY m) FROM (
             SELECT to_char(to_timestamp(created_at/1000.0) AT TIME ZONE 'UTC', 'YYYY-MM') m, count(*) c
             FROM public.leads WHERE created_at >= month_start_ms GROUP BY 1) s), '[]'::jsonb))
      FROM public.leads),
    'orders', (SELECT jsonb_build_object(
        'total', count(*),
        'amount_total', coalesce(round(sum(amount), 2), 0),
        'currencies', coalesce((SELECT jsonb_agg(DISTINCT currency) FROM public.orders WHERE currency IS NOT NULL), '[]'::jsonb),
        'newest_at', to_char(to_timestamp(max(created_at)/1000.0) AT TIME ZONE 'UTC', 'YYYY-MM-DD'),
        'by_status', coalesce((SELECT jsonb_object_agg(k, v) FROM (SELECT coalesce(status,'unknown') k, count(*) v FROM public.orders GROUP BY 1) s), '{}'::jsonb),
        'by_source', coalesce((SELECT jsonb_object_agg(k, v) FROM (SELECT coalesce(source,'unknown') k, count(*) v FROM public.orders GROUP BY 1) s), '{}'::jsonb),
        'by_month_last_6', coalesce((SELECT jsonb_agg(jsonb_build_object('month', m, 'count', c, 'amount', a) ORDER BY m) FROM (
             SELECT to_char(to_timestamp(created_at/1000.0) AT TIME ZONE 'UTC', 'YYYY-MM') m, count(*) c, coalesce(round(sum(amount), 2), 0) a
             FROM public.orders WHERE created_at >= month_start_ms GROUP BY 1) s), '[]'::jsonb),
        'top_products', coalesce((SELECT jsonb_agg(jsonb_build_object('product', p, 'count', c, 'amount', a) ORDER BY a DESC) FROM (
             SELECT left(coalesce(product,'unknown'), 60) p, count(*) c, coalesce(round(sum(amount), 2), 0) a
             FROM public.orders GROUP BY 1 ORDER BY 3 DESC LIMIT 5) s), '[]'::jsonb))
      FROM public.orders),
    'site_enquiries', (SELECT jsonb_build_object(
        'total', count(*),
        'last_30_days', count(*) FILTER (WHERE created_at > now_ms - 30::bigint*86400000),
        'by_source', coalesce((SELECT jsonb_object_agg(k, v) FROM (SELECT coalesce(source,'unknown') k, count(*) v FROM public.tickets GROUP BY 1) s), '{}'::jsonb),
        'by_status', coalesce((SELECT jsonb_object_agg(k, v) FROM (SELECT coalesce(status,'unknown') k, count(*) v FROM public.tickets GROUP BY 1) s), '{}'::jsonb))
      FROM public.tickets),
    'education_requests', (SELECT jsonb_build_object(
        'total', count(*),
        'last_30_days', count(*) FILTER (WHERE created_at > now_ms - 30::bigint*86400000),
        'by_stage', coalesce((SELECT jsonb_object_agg(k, v) FROM (SELECT coalesce(stage,'New') k, count(*) v FROM public.education_requests GROUP BY 1) s), '{}'::jsonb))
      FROM public.education_requests)
  ) INTO result;

  INSERT INTO micha_gateway.call_log(ok) VALUES (true);
  RETURN result;
END $fn$;
REVOKE ALL ON FUNCTION public.micha_crm_summary() FROM PUBLIC, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.micha_crm_summary() TO anon;

COMMIT;
