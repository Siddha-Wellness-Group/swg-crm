-- Connectors: the CRM's version of Claude's "connectors" screen.
--
-- A connector is one outside service the in-app assistant may use: a remote
-- MCP server (custom, or the Base44 preset), or one of the built-in adapters
-- (Gmail, Claude, Gemini, ChatGPT, WhatsApp). Setup and calls go through the
-- `connectors` Edge Function; the browser never talks to those services.
--
-- Two tables on purpose:
--
--   connectors         what the screen shows. Readable with the anon key.
--                      NOT writable with it -- only the Edge Function
--                      (service role) writes, so a connector's URL cannot be
--                      repointed from the browser while its saved token stays
--                      attached.
--   connector_secrets  tokens / API keys. No anon or authenticated grant at
--                      all: the browser can neither read nor overwrite them.
--                      Only the Edge Function, running as service_role.

create table if not exists connectors (
  id text primary key,
  created_at bigint not null,
  updated_at bigint not null,
  owner text,
  -- mcp | gmail | claude | openai | gemini | whatsapp
  kind text not null,
  -- Catalog entry this was created from (base44, gmail, ...), null for custom.
  preset text,
  name text not null,
  -- mcp only: the remote server's Streamable-HTTP endpoint.
  url text,
  -- none | bearer | header   (mcp only; adapters always use their own scheme)
  auth_type text not null default 'none',
  -- header name when auth_type = 'header', e.g. x-api-key
  auth_header text,
  -- non-secret settings: model name, WhatsApp phone number id, ...
  config jsonb not null default '{}'::jsonb,
  -- Set by the Edge Function when a secret is stored / cleared.
  has_secret boolean not null default false,
  enabled boolean not null default true,
  -- admins | everyone -- who may use it through the assistant.
  audience text not null default 'admins',
  -- Tools found at the last "Test connection": [{name, description, input_schema, read_only}]
  tools jsonb not null default '[]'::jsonb,
  -- {toolName: 'ask' | 'allow' | 'off'}; missing = ask.
  tool_prefs jsonb not null default '{}'::jsonb,
  -- new | connected | error
  status text not null default 'new',
  status_detail text,
  checked_at bigint
);

alter table connectors enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'connectors' and policyname = 'connectors_anon_read'
  ) then
    create policy connectors_anon_read on connectors for select to anon, authenticated using (true);
  end if;
end $$;

grant select on connectors to anon, authenticated;
grant select, insert, update, delete on connectors to service_role;

create table if not exists connector_secrets (
  connector_id text primary key references connectors(id) on delete cascade,
  secret jsonb not null,
  updated_at bigint not null
);

-- RLS on with no policies and no grants for anon / authenticated: closed to
-- the browser. service_role bypasses RLS but still needs the table grant.
alter table connector_secrets enable row level security;
revoke all on connector_secrets from anon, authenticated;
grant select, insert, update, delete on connector_secrets to service_role;
