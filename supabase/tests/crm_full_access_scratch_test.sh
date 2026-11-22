#!/usr/bin/env bash
# Scratch-PG acceptance for 20261122200000 + 20261122230000 (role-based access for the full CRM app).
# Throwaway database in the LOCAL MICHA Postgres container; never touches a hosted project.
set -uo pipefail
C=${CRM_SCRATCH_CONTAINER:-supabase_db_siddha-yoga-agents}
DB=crm_full_scratch_$$
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
INSERT INTO auth.users VALUES ('a0000000-0000-0000-0000-000000000001'),('b0000000-0000-0000-0000-000000000002'),('c0000000-0000-0000-0000-000000000003'),('d0000000-0000-0000-0000-000000000004');
SQL
psqlc < "$DIR/migrations/20261122200000_crm_staff_read_and_micha_summary.sql" >/dev/null 2>&1
psqlc < "$DIR/migrations/20261122230000_crm_full_app_staff_access.sql" >/dev/null 2>&1
psqlc -c "INSERT INTO public.crm_staff(user_id, role) VALUES ('a0000000-0000-0000-0000-000000000001','admin'),('b0000000-0000-0000-0000-000000000002','manager'),('c0000000-0000-0000-0000-000000000003','viewer')"

claims() { echo "{\"sub\":\"$1\",\"aal\":\"$2\",\"role\":\"authenticated\"}"; }
ADMIN=$(claims a0000000-0000-0000-0000-000000000001 aal2); ADMIN1=$(claims a0000000-0000-0000-0000-000000000001 aal1)
MGR=$(claims b0000000-0000-0000-0000-000000000002 aal2); VIEW=$(claims c0000000-0000-0000-0000-000000000003 aal2)
NOSTAFF=$(claims d0000000-0000-0000-0000-000000000004 aal2)
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

check "viewer reads leads"            "$(run authenticated "$VIEW" 'SELECT count(*) FROM public.leads')" "OK:1"
check "viewer reads tasks"            "$(run authenticated "$VIEW" 'SELECT count(*) FROM public.tasks')" "OK:1"
check "viewer cannot insert lead"     "$(run authenticated "$VIEW" "$(ins leads)")" "DENIED"
check "manager inserts lead"          "$(run authenticated "$MGR" "$(ins leads)")" "OK:t1"
check "manager updates deal"          "$(run authenticated "$MGR" "UPDATE public.deals SET status='won' WHERE id='seed' RETURNING id")" "OK:seed"
check "manager delete removes nothing" "$(run authenticated "$MGR" "WITH d AS (DELETE FROM public.contacts WHERE id='seed' RETURNING 1) SELECT count(*) FROM d")" "OK:0"
check "manager cannot write settings" "$(run authenticated "$MGR" "$(ins settings)")" "DENIED"
check "manager cannot write team"     "$(run authenticated "$MGR" "UPDATE public.team SET name='x' WHERE id='seed' RETURNING id")" "OK:"
check "admin deletes contact"         "$(run authenticated "$ADMIN" "WITH d AS (DELETE FROM public.contacts WHERE id='seed' RETURNING 1) SELECT count(*) FROM d")" "OK:1"
check "admin writes settings"         "$(run authenticated "$ADMIN" "$(ins settings)")" "OK:t1"
check "admin aal1 reads nothing"      "$(run authenticated "$ADMIN1" 'SELECT count(*) FROM public.leads')" "OK:0"
check "admin aal1 cannot insert"      "$(run authenticated "$ADMIN1" "$(ins leads)")" "DENIED"
check "non-staff reads nothing"       "$(run authenticated "$NOSTAFF" 'SELECT count(*) FROM public.orders')" "OK:0"
check "non-staff cannot insert"       "$(run authenticated "$NOSTAFF" "$(ins orders)")" "DENIED"
check "order_events append ok"        "$(run authenticated "$MGR" "$(ins order_events)")" "OK:t1"
check "order_events no update"        "$(run authenticated "$ADMIN" "UPDATE public.order_events SET name='x' WHERE id='seed'")" "DENIED"
check "email_log read-only"           "$(run authenticated "$ADMIN" "$(ins email_log)")" "DENIED"
check "anon denied"                   "$(run anon '{}' 'SELECT count(*) FROM public.leads')" "DENIED"
check "anon cannot insert lead"       "$(run anon '{}' "$(ins leads)")" "DENIED"
psqlc < "$DIR/rollback/20261122230001_rollback_crm_full_app_staff_access.sql" >/dev/null 2>&1
check "rollback: tasks unreadable"    "$(run authenticated "$ADMIN" 'SELECT count(*) FROM public.tasks')" "DENIED"
check "rollback: leads still readable" "$(run authenticated "$ADMIN" 'SELECT count(*) FROM public.leads')" "OK:1"
check "rollback: manager cannot insert" "$(run authenticated "$MGR" "$(ins leads)")" "DENIED"
exit $fail
