// crm-invite-staff (2026-11-23): an active CRM ADMIN invites EXISTING team members by NAME.
// The server — never the caller — reads each member's email and original CRM role from public.team and maps it to
// the matching server role, so nobody can be elevated through this endpoint. Members without an original role
// (e.g. Ariel) are refused and stay pending separate authorization. Never creates duplicates: an existing confirmed
// account is left alone; an existing unconfirmed account gets a fresh invitation for the same user id.
// verify_jwt = true. Response contains names and statuses only (no email addresses).
import { createClient } from 'npm:@supabase/supabase-js@2';

const URL_ = Deno.env.get('SUPABASE_URL')!;
const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ALLOWED_ORIGINS = ['https://crm.micha-ai.com', 'https://full.swg-crm.pages.dev'];
const REDIRECT = 'https://full.swg-crm.pages.dev/';
const ROLE_MAP: Record<string, string> = { Admin: 'admin', Manager: 'manager', 'Sales Rep': 'sales_rep', Marketing: 'marketing', Support: 'support', 'Read Only': 'viewer' };

function cors(origin: string | null) {
  return { 'Access-Control-Allow-Origin': origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0], 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
}
const json = (b: unknown, s: number, o: string | null) => new Response(JSON.stringify(b), { status: s, headers: { ...cors(o), 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors(origin) });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405, origin);
  const auth = req.headers.get('authorization') ?? '';
  const caller = createClient(URL_, ANON, { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
  const { data: role, error: roleErr } = await caller.rpc('crm_staff_role');
  if (roleErr || role !== 'admin') return json({ error: 'CRM admin only' }, 403, origin);
  let names: unknown;
  try { names = (await req.json())?.names; } catch { return json({ error: 'invalid JSON' }, 400, origin); }
  if (!Array.isArray(names) || names.length < 1 || names.length > 20 || !names.every((n) => typeof n === 'string' && /^[\p{L} .'-]{1,60}$/u.test(n))) {
    return json({ error: 'names must be 1-20 team member names' }, 400, origin);
  }
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  const { data: team, error: teamErr } = await admin.from('team').select('name, email, role');
  if (teamErr) return json({ error: 'team unavailable' }, 500, origin);
  const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  const results: Array<{ name: string; status: string; role?: string }> = [];
  for (const name of names as string[]) {
    const member = (team ?? []).find((t) => t.name === name);
    if (!member?.email) { results.push({ name, status: 'not_in_team' }); continue; }
    const crmRole = ROLE_MAP[member.role ?? ''];
    if (!crmRole) { results.push({ name, status: 'no_original_role_pending_authorization' }); continue; }
    const existing = list?.users?.find((u) => (u.email ?? '').toLowerCase() === member.email.toLowerCase());
    let userId = existing?.id ?? null;
    if (existing?.email_confirmed_at) {
      results.push({ name, status: 'already_active', role: crmRole });
    } else {
      const { data, error } = await admin.auth.admin.inviteUserByEmail(member.email, { redirectTo: REDIRECT });
      if (error) { results.push({ name, status: 'invite_failed:' + (error.code ?? error.status ?? 'error') }); continue; }
      userId = data.user?.id ?? userId;
      results.push({ name, status: existing ? 'reinvited' : 'invited', role: crmRole });
    }
    if (userId) {
      const { error } = await admin.from('crm_staff').upsert({ user_id: userId, role: crmRole, active: true }, { onConflict: 'user_id', ignoreDuplicates: true });
      if (error) results[results.length - 1].status += '+staff_failed';
    }
  }
  console.info('[crm-invite-staff]', JSON.stringify(results.map((r) => r.status)));
  return json({ results }, 200, origin);
});
