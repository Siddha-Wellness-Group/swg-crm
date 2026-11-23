-- Scratch-database test for 20261123100000 (run setup, then the migration, then this file). Result: 23/23 t (23.11.2026).
-- SETUP
CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid primary key, email text);
DO $r$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
END $r$;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE public.crm_staff(user_id uuid primary key references auth.users(id), role text, active boolean default true);
CREATE TABLE public.crm_role_permissions(role text, object text, can_create boolean, can_edit boolean, can_delete boolean);
INSERT INTO public.crm_role_permissions VALUES ('admin','tickets',true,true,true),('admin','tasks',true,true,true),('admin','leads',true,true,true),
 ('marketing','leads',true,true,true),('marketing','tasks',true,true,true),('marketing','contacts',true,true,false);
CREATE TABLE public.tickets(id text primary key, created_at bigint, owner text, ticket_number text, contact_id text, name text, email text, phone text, subject text, message text, status text, source text, external_id text, assigned_to text, notes text);
CREATE TABLE public.tasks(id text primary key, created_at bigint, owner text, title text, due_date date, status text, link_type text, link_id text, notes text, department text);
CREATE TABLE public.leads(id text primary key, created_at bigint, owner text, name text, status text, notes text, email text, phone text, company text, department text);
CREATE TABLE public.education_requests(id text primary key, created_at bigint, first_name text, last_name text, phone text, org text, org_other text, location text, location_other text, participants text, format text, timing text, recommended_service_name text, stage text, owner text, notes text, source text, ip_hash text);
CREATE SCHEMA micha_gateway;
CREATE TABLE micha_gateway.key(id smallint primary key default 1, digest bytea not null, released_until timestamptz not null, revoked_at timestamptz);
CREATE TABLE micha_gateway.call_log(at timestamptz not null default clock_timestamp(), ok boolean not null);
INSERT INTO micha_gateway.key(digest, released_until) VALUES (digest('TESTKEY_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','sha256'), now()+interval '1 day');
INSERT INTO auth.users VALUES ('00000000-0000-0000-0000-0000000000a1','admin@x.test'),('00000000-0000-0000-0000-0000000000b2','mkt@x.test'),('00000000-0000-0000-0000-0000000000c3','gone@x.test');
INSERT INTO public.crm_staff VALUES ('00000000-0000-0000-0000-0000000000a1','admin',true),('00000000-0000-0000-0000-0000000000b2','marketing',true),('00000000-0000-0000-0000-0000000000c3','admin',false);
INSERT INTO public.tickets VALUES ('t1',(extract(epoch from now()-interval '10 minutes')*1000)::bigint,null,'TCK-NEW001',null,'Dana Test','dana@example.com','050','Q','Hello lavender','new','LYNVAH',null,null,null),
 ('t2',(extract(epoch from now()-interval '5 hours')*1000)::bigint,null,'TCK-OLD002',null,'Old','o@example.com',null,'Q','old','closed','Cinnamor',null,null,null);
INSERT INTO public.education_requests(id, created_at, first_name, last_name, stage, source) VALUES ('edu_abc',(extract(epoch from now()-interval '20 minutes')*1000)::bigint,'Avi','Edu','New','Siddha Education');
