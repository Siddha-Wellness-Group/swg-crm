#!/usr/bin/env bash
# Scratch-PG acceptance for 20261122200000 + 20261122230000 (role-based access for the full CRM app).
# Throwaway database in the LOCAL MICHA Postgres container; never touches a hosted project.
set -uo pipefail
C=${CRM_SCRATCH_CONTAINER:-supabase_db_siddha-yoga-agents}
DB=crm_profile_scratch_$$
DIR="$(dirname "$0")/.."
psqlc() { docker exec -i "$C" psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -qAt "$@"; }
docker exec "$C" psql -U postgres -qc "CREATE DATABASE $DB" >/dev/null
trap 'docker exec "$C" psql -U postgres -qc "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null' EXIT

psqlc <<'SQL'
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(auth.jwt()->>'sub', '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid() TO anon, authenticated;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['contacts','leads','customers','distributors','suppliers','deals','orders','tasks','invoices','payments','tickets',
                           'email_log','metric_snapshots','education_requests','team','settings','order_events','email_outbox'] LOOP
    EXECUTE format('CREATE TABLE public.%I (id text PRIMARY KEY, created_at bigint, owner text, name text, email text, phone text, notes text, source text, status text, product text, amount numeric, currency text, ticket_number text, stage text, submission_id text)', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT ALL ON public.%I TO anon', t);
    EXECUTE format('INSERT INTO public.%I(id, created_at, name) VALUES (''seed'', 1, ''seed'')', t);
  END LOOP; END $$;
INSERT INTO auth.users VALUES ('a0000000-0000-0000-0000-000000000001'),('b0000000-0000-0000-0000-000000000002'),('c0000000-0000-0000-0000-000000000003'),('d0000000-0000-0000-0000-000000000004'),('e0000000-0000-0000-0000-000000000005'),('f0000000-0000-0000-0000-000000000006'),('a1000000-0000-0000-0000-000000000007');
SQL
psqlc < "$DIR/migrations/20261122200000_crm_staff_read_and_micha_summary.sql" >/dev/null 2>&1
psqlc < "$DIR/migrations/20261122230000_crm_full_app_staff_access.sql" >/dev/null 2>&1
psqlc < "$DIR/migrations/20261123000000_crm_remove_mfa_requirement.sql" >/dev/null 2>&1
psqlc < "$DIR/migrations/20261123010000_crm_role_permissions_from_profiles.sql" >/dev/null 2>&1
psqlc -c "INSERT INTO public.crm_staff(user_id, role) VALUES ('a0000000-0000-0000-0000-000000000001','admin'),('b0000000-0000-0000-0000-000000000002','manager'),('c0000000-0000-0000-0000-000000000003','viewer'),('e0000000-0000-0000-0000-000000000005','marketing'),('f0000000-0000-0000-0000-000000000006','support'),('a1000000-0000-0000-0000-000000000007','sales_rep')"
claims() { echo "{\"sub\":\"$1\",\"aal\":\"$2\",\"role\":\"authenticated\"}"; }
ADMIN=$(claims a0000000-0000-0000-0000-000000000001 aal2); ADMIN1=$(claims a0000000-0000-0000-0000-000000000001 aal1)
MGR=$(claims b0000000-0000-0000-0000-000000000002 aal2); VIEW=$(claims c0000000-0000-0000-0000-000000000003 aal2)
NOSTAFF=$(claims d0000000-0000-0000-0000-000000000004 aal1)
MKT=$(claims e0000000-0000-0000-0000-000000000005 aal1); SUP=$(claims f0000000-0000-0000-0000-000000000006 aal1); REP=$(claims a1000000-0000-0000-0000-000000000007 aal1)
MGR=$(claims b0000000-0000-0000-0000-000000000002 aal1); VIEW=$(claims c0000000-0000-0000-0000-000000000003 aal1); ADMIN=$(claims a0000000-0000-0000-0000-000000000001 aal1)
# run SQL as role+claims; print "OK:<rowcount/value>" or "DENIED"
run() {
  local out
  out=$(docker exec -i "$C" psql -U postgres -d "$DB" -qAt -v ON_ERROR_STOP=1 2>&1 <<EOSQL
BEGIN;
SET LOCAL ROLE $1;
SELECT set_config('request.jwt.claims', '$2', true) IS NULL AS ignore_me \g /dev/null
$3;
ROLLBACK;
EOSQL
)
  if echo "$out" | grep -qE 'permission denied|violates row-level security'; then echo DENIED; else echo "OK:$(echo "$out" | tail -1)"; fi
}
fail=0
check() { if [ "$2" == "$3" ]; then echo "PASS $1"; else echo "FAIL $1: expected [$3] got [$2]"; fail=1; fi; }
ins() { echo "INSERT INTO public.$1(id, created_at, name) VALUES ('t1', 2, 'x') RETURNING id"; }


check "viewer reads leads (no MFA)"     "$(run authenticated "$VIEW" 'SELECT count(*) FROM public.leads')" "OK:1"
check "viewer cannot create task"       "$(run authenticated "$VIEW" "$(ins tasks)")" "DENIED"
check "manager deletes contact"         "$(run authenticated "$MGR" "WITH d AS (DELETE FROM public.contacts WHERE id='seed' RETURNING 1) SELECT count(*) FROM d")" "OK:1"
check "manager cannot delete order"     "$(run authenticated "$MGR" "WITH d AS (DELETE FROM public.orders WHERE id='seed' RETURNING 1) SELECT count(*) FROM d")" "OK:0"
check "manager cannot write settings"   "$(run authenticated "$MGR" "$(ins settings)")" "DENIED"
check "marketing creates lead"          "$(run authenticated "$MKT" "$(ins leads)")" "OK:t1"
check "marketing deletes lead"          "$(run authenticated "$MKT" "WITH d AS (DELETE FROM public.leads WHERE id='seed' RETURNING 1) SELECT count(*) FROM d")" "OK:1"
check "marketing creates contact"       "$(run authenticated "$MKT" "$(ins contacts)")" "OK:t1"
check "marketing cannot create deal"    "$(run authenticated "$MKT" "$(ins deals)")" "DENIED"
check "marketing cannot delete contact" "$(run authenticated "$MKT" "WITH d AS (DELETE FROM public.contacts WHERE id='seed' RETURNING 1) SELECT count(*) FROM d")" "OK:0"
check "support edits contact"           "$(run authenticated "$SUP" "WITH u AS (UPDATE public.contacts SET name='x' WHERE id='seed' RETURNING 1) SELECT count(*) FROM u")" "OK:1"
check "support cannot create contact"   "$(run authenticated "$SUP" "$(ins contacts)")" "DENIED"
check "support creates task"            "$(run authenticated "$SUP" "$(ins tasks)")" "OK:t1"
check "support cannot edit deal"        "$(run authenticated "$SUP" "WITH u AS (UPDATE public.deals SET name='x' WHERE id='seed' RETURNING 1) SELECT count(*) FROM u")" "OK:0"
check "sales_rep creates customer"      "$(run authenticated "$REP" "$(ins customers)")" "OK:t1"
check "sales_rep cannot delete lead"    "$(run authenticated "$REP" "WITH d AS (DELETE FROM public.leads WHERE id='seed' RETURNING 1) SELECT count(*) FROM d")" "OK:0"
check "admin deletes order"             "$(run authenticated "$ADMIN" "WITH d AS (DELETE FROM public.orders WHERE id='seed' RETURNING 1) SELECT count(*) FROM d")" "OK:1"
check "admin writes settings"           "$(run authenticated "$ADMIN" "$(ins settings)")" "OK:t1"
check "non-staff reads nothing"         "$(run authenticated "$NOSTAFF" 'SELECT count(*) FROM public.leads')" "OK:0"
check "non-staff cannot create"         "$(run authenticated "$NOSTAFF" "$(ins leads)")" "DENIED"
check "anon denied"                     "$(run anon '{}' 'SELECT count(*) FROM public.leads')" "DENIED"
check "order_events stays append-only"  "$(run authenticated "$ADMIN" "UPDATE public.order_events SET name='x' WHERE id='seed'")" "DENIED"
psqlc -c "UPDATE public.crm_staff SET role='viewer' WHERE role IN ('marketing','support','sales_rep')"
psqlc < "$DIR/rollback/20261123010001_rollback_crm_role_permissions_from_profiles.sql" >/dev/null 2>&1
check "rollback: manager delete back to none" "$(run authenticated "$MGR" "WITH d AS (DELETE FROM public.contacts WHERE id='seed' RETURNING 1) SELECT count(*) FROM d")" "OK:0"
check "rollback: manager still creates" "$(run authenticated "$MGR" "$(ins leads)")" "OK:t1"
exit $fail
