#!/usr/bin/env bash
# Scratch-PG acceptance for 20261122200000_crm_staff_read_and_micha_summary.sql.
# Creates a throwaway database crm_scratch_<pid> in the LOCAL MICHA Postgres container, a minimal auth shim
# (auth.users, auth.uid(), auth.jwt() from request.jwt.claims) and the seven CRM tables, applies the migration
# exactly as written, runs role-based assertions, then drops the database. Never touches a hosted project.
set -euo pipefail
C=${CRM_SCRATCH_CONTAINER:-supabase_db_siddha-yoga-agents}
DB=crm_scratch_$$
MIG="$(dirname "$0")/../migrations/20261122200000_crm_staff_read_and_micha_summary.sql"
RB="$(dirname "$0")/../rollback/20261122200001_rollback_crm_staff_read_and_micha_summary.sql"
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
CREATE TABLE public.leads (id text PRIMARY KEY, created_at bigint, owner text, name text, email text, phone text, notes text, source text, status text);
CREATE TABLE public.contacts (id text PRIMARY KEY, created_at bigint, name text, email text);
CREATE TABLE public.customers (id text PRIMARY KEY, created_at bigint, name text, email text);
CREATE TABLE public.deals (id text PRIMARY KEY, created_at bigint, title text, value numeric);
CREATE TABLE public.orders (id text PRIMARY KEY, created_at bigint, product text, amount numeric, currency text, status text, source text, shipping_address jsonb);
CREATE TABLE public.tickets (id text PRIMARY KEY, created_at bigint, ticket_number text, name text, email text, message text, status text, source text);
CREATE TABLE public.education_requests (id text PRIMARY KEY, created_at bigint, submission_id text, first_name text, phone text, stage text);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['leads','contacts','customers','deals','orders','tickets','education_requests'] LOOP
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('GRANT ALL ON public.%I TO anon', t); END LOOP; END $$;
INSERT INTO auth.users VALUES ('11111111-1111-1111-1111-111111111111'), ('22222222-2222-2222-2222-222222222222');
INSERT INTO public.leads VALUES ('l1', (extract(epoch FROM now())*1000)::bigint - 86400000, 'o', 'Secret Person', 'p@x.y', '050', 'n', 'Instagram', 'New'),
                                ('l2', 1784678400000, 'o', 'Old Person', 'q@x.y', '051', 'n', 'Ad', 'Converted');
INSERT INTO public.orders VALUES ('o1', (extract(epoch FROM now())*1000)::bigint, 'Lavender Oil', 120, 'ILS', 'paid', 'Siddha Yoga', '{"street":"secret"}');
INSERT INTO public.tickets VALUES ('t1', (extract(epoch FROM now())*1000)::bigint, 'TCK-64H312', 'Secret', 's@x.y', 'secret message', 'new', 'Cinnamor');
INSERT INTO public.education_requests VALUES ('e1', (extract(epoch FROM now())*1000)::bigint, 'abc3B57F9', 'Secret', '052', NULL);
SQL

psqlc < "$MIG"
psqlc -c "INSERT INTO public.crm_staff(user_id, role) VALUES ('11111111-1111-1111-1111-111111111111','admin')"
psqlc -c "INSERT INTO micha_gateway.key(digest, released_until) VALUES (sha256(convert_to('k_test_key_0123456789abcdefghijklmnopqrstuvwxyzAB','UTF8')), now() + interval '1 day')"

as() { # role claims sql -> first value
  local out
  out=$(psqlc -c "BEGIN; SET LOCAL ROLE $1; SELECT set_config('request.jwt.claims', '$2', true); SELECT set_config('request.headers', '$3', true); $4; COMMIT;" 2>&1 || true)
  if echo "$out" | grep -q 'ERROR'; then echo "$out" | grep -m1 'ERROR'; else echo "$out" | sed -n '3p'; fi
}
fail=0
check() { if [ "$2" == "$3" ]; then echo "PASS $1"; else echo "FAIL $1: expected [$3] got [$2]"; fail=1; fi; }
STAFF2='{"sub":"11111111-1111-1111-1111-111111111111","aal":"aal2","role":"authenticated"}'
STAFF1='{"sub":"11111111-1111-1111-1111-111111111111","aal":"aal1","role":"authenticated"}'
OTHER2='{"sub":"22222222-2222-2222-2222-222222222222","aal":"aal2","role":"authenticated"}'
KEY='{"x-micha-gateway-key":"k_test_key_0123456789abcdefghijklmnopqrstuvwxyzAB"}'
BAD='{"x-micha-gateway-key":"k_wrong_key_0123456789abcdefghijklmnopqrstuvwxyzA"}'

check "staff aal2 reads leads" "$(as authenticated "$STAFF2" '{}' 'SELECT count(*) FROM public.leads')" "2"
check "staff aal1 reads nothing" "$(as authenticated "$STAFF1" '{}' 'SELECT count(*) FROM public.leads')" "0"
check "non-staff aal2 reads nothing" "$(as authenticated "$OTHER2" '{}' 'SELECT count(*) FROM public.orders')" "0"
check "anon denied" "$(as anon '{}' '{}' 'SELECT count(*) FROM public.leads' | grep -c 'permission denied')" "1"
check "staff cannot write" "$(as authenticated "$STAFF2" '{}' "UPDATE public.leads SET status='x'" | grep -c 'permission denied')" "1"
check "staff sees own role" "$(as authenticated "$STAFF2" '{}' 'SELECT role FROM public.crm_staff')" "admin"
check "summary without key is NULL" "$(as anon '{}' '{}' 'SELECT public.micha_crm_summary() IS NULL')" "t"
check "summary with wrong key is NULL" "$(as anon '{}' "$BAD" 'SELECT public.micha_crm_summary() IS NULL')" "t"
SUM=$(as anon '{}' "$KEY" 'SELECT public.micha_crm_summary()::text')
check "summary with key returns leads total" "$(echo "$SUM" | grep -o '"total": 2' | head -1)" '"total": 2'
check "summary counts last 30 days" "$(echo "$SUM" | grep -o '"last_30_days": 1' | head -1)" '"last_30_days": 1'
check "summary has product aggregate" "$(echo "$SUM" | grep -c 'Lavender Oil')" "1"
for secret in 'Secret' 'p@x.y' '050' 'secret message' 'street'; do
  check "summary leaks no PII ($secret)" "$(echo "$SUM" | grep -c "$secret")" "0"
done
check "authenticated cannot call summary" "$(as authenticated "$STAFF2" '{}' 'SELECT public.micha_crm_summary()' | grep -c 'permission denied')" "1"
psqlc -c "UPDATE micha_gateway.key SET revoked_at = now()"
check "revoked key is NULL" "$(as anon '{}' "$KEY" 'SELECT public.micha_crm_summary() IS NULL')" "t"
psqlc < "$RB"
check "rollback removes staff read" "$(as authenticated "$STAFF2" '{}' 'SELECT count(*) FROM public.leads' | grep -c 'permission denied')" "1"
exit $fail
