-- Storage for the Setup features, which have been writing into a void.
--
-- swg_crm.html calls saveKey(KEYS.x, value) in 27 places, but neither
-- saveKey nor KEYS is defined anywhere in the file, so every one of those
-- calls throws ReferenceError -- and because the throw aborts the rest of
-- its function, the damage goes well past "settings do not persist":
--
--   * dragging a deal across the pipeline never saved (reverted on reload)
--   * marking a deal Won never reached createPaidOrderAndInvoice, so
--     auto-invoicing never happened
--   * tasks created by automations and flows were never saved
--   * team role changes were never saved
--   * checkBigDealAlert aborted before its own toast, so the Big Deal
--     Alert feature never worked at all
--
-- Eleven of the fourteen keys are settings-shaped: arrays and objects with
-- no table of their own (validation rules, dashboards, flows, automations,
-- and so on). This table is where they belong. The other three -- deals,
-- tasks and team -- already have real tables and are switched over to the
-- existing db helpers instead, in swg_crm.html.

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at bigint not null
);

alter table settings enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where tablename = 'settings' and policyname = 'settings_anon_all'
  ) then
    create policy settings_anon_all on settings for all to anon using (true) with check (true);
  end if;
end $$;

grant select, insert, update, delete on settings to anon, authenticated, service_role;

-- The Setup > Roles screen sets rec.role and tries to persist it, but team
-- has no such column, so the change had nowhere to go even before saveKey
-- failed.
--
-- NOTE FOR REVIEW: adding this column makes the screen remember the choice.
-- It does NOT make it take effect. Permissions still come from the
-- hardcoded name lists in swg_crm.html (FULL_ADMIN, CO_ADMINS,
-- PRIVILEGED, LEAD_HIDDEN_FOR), which ignore this field entirely. Making
-- role the actual source of permissions is a separate decision -- it
-- changes who can do what -- and is deliberately not taken here.
alter table team add column if not exists role text;
