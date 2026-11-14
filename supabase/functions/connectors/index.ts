// ============================================================
// CONNECTORS GATEWAY (Supabase Edge Function)
//
// The server half of the CRM's Connectors screen. The browser never talks
// to Gmail, WhatsApp, an MCP server and so on directly: it asks this
// function, which holds the tokens (table connector_secrets, readable only
// by the service role) and makes the outbound call.
//
// POST { action, ... }  ->  { ok: true, ... } | { ok: false, error }
//   save_connector  create or update a connector row
//   save_secret     store its token / API key (write-only from the browser)
//   clear_secret    forget the token
//   delete_connector
//   discover        "Test connection": log in and list the tools
//   call            run one tool
//
// Operational failures come back as HTTP 200 with ok:false so the browser
// can show the message; only malformed requests get 4xx.
//
// Secrets:  none of its own. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
//           injected by Supabase.
//           CONNECTORS_ALLOWED_ORIGINS (optional, comma-separated; falls back
//           to AGENT_ALLOWED_ORIGINS)
// Deploy:   supabase functions deploy connectors
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import { ADAPTERS } from './_adapters.ts';
import { assertPublicUrl, callMcpTool, ConnectorError, listMcpTools, type McpAuth, type McpTool } from './_mcp.ts';

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

const ALLOWED_ORIGINS = (Deno.env.get('CONNECTORS_ALLOWED_ORIGINS') || Deno.env.get('AGENT_ALLOWED_ORIGINS') || '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const MAX_BODY_BYTES = 100_000;
const KINDS = ['mcp', ...Object.keys(ADAPTERS)];
const AUTH_TYPES = ['none', 'bearer', 'header'];
const AUDIENCES = ['admins', 'everyone'];
const PREFS = ['ask', 'allow', 'off'];
const CONFIG_KEYS = ['model', 'phone_number_id'];

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = !ALLOWED_ORIGINS.length ? '*' : (origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]);
  return {
    'access-control-allow-origin': allow,
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'vary': 'origin',
  };
}
function reply(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...corsHeaders(origin) } });
}

// Public-DNS check so a name that points at a private address is refused.
async function resolveHost(host: string): Promise<string[]> {
  const [a, aaaa] = await Promise.all([
    Deno.resolveDns(host, 'A').catch(() => [] as string[]),
    Deno.resolveDns(host, 'AAAA').catch(() => [] as string[]),
  ]);
  return [...a, ...aaaa];
}

type Row = Record<string, any>;
const cleanStr = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);

async function getRow(id: unknown): Promise<Row> {
  if (typeof id !== 'string' || !id) throw new ConnectorError('Missing connector id.', 400);
  const { data, error } = await sb.from('connectors').select('*').eq('id', id).maybeSingle();
  if (error) throw new ConnectorError('Could not read the connector.', 500);
  if (!data) throw new ConnectorError('Connector not found.', 404);
  return data;
}
async function getSecret(id: string): Promise<Record<string, string>> {
  const { data } = await sb.from('connector_secrets').select('secret').eq('connector_id', id).maybeSingle();
  return (data?.secret ?? {}) as Record<string, string>;
}
function mcpAuth(row: Row, secret: Record<string, string>): McpAuth {
  return { type: row.auth_type, header: row.auth_header || undefined, token: secret.token };
}

async function saveConnector(input: Row, ownerHint: string): Promise<Row> {
  const kind = cleanStr(input.kind, 20);
  if (!KINDS.includes(kind)) throw new ConnectorError('Unknown connector type.', 400);
  const name = cleanStr(input.name, 60);
  if (!name) throw new ConnectorError('Give the connector a name.', 400);

  const authType = kind === 'mcp' ? cleanStr(input.auth_type || 'none', 10) : 'none';
  if (!AUTH_TYPES.includes(authType)) throw new ConnectorError('Unknown sign-in method.', 400);
  const authHeader = authType === 'header' ? cleanStr(input.auth_header, 100) : '';
  if (authType === 'header' && !/^[A-Za-z0-9-]{1,100}$/.test(authHeader)) throw new ConnectorError('The header name may only contain letters, digits and dashes.', 400);
  if (authType === 'header' && /^(host|content-type|content-length|mcp-session-id|mcp-protocol-version|accept)$/i.test(authHeader)) throw new ConnectorError('That header name is reserved.', 400);

  let url: string | null = null;
  if (kind === 'mcp') {
    url = (await assertPublicUrl(cleanStr(input.url, 500), resolveHost)).toString();
  }
  const config: Record<string, string> = {};
  for (const k of CONFIG_KEYS) if (input.config && typeof input.config[k] === 'string' && input.config[k].trim()) config[k] = cleanStr(input.config[k], 200);
  const audience = AUDIENCES.includes(input.audience) ? input.audience : 'admins';
  const prefs: Record<string, string> = {};
  if (input.tool_prefs && typeof input.tool_prefs === 'object') {
    for (const [k, v] of Object.entries(input.tool_prefs)) if (k.length <= 128 && PREFS.includes(v as string)) prefs[k] = v as string;
  }
  const now = Date.now();

  if (input.id) {
    const existing = await getRow(input.id);
    // A saved token only ever goes to the address and sign-in method it was
    // saved for. Changing either drops it, so nobody can repoint a connector
    // at their own server and collect the stored token.
    const moved = existing.kind !== kind || (existing.url ?? null) !== url || existing.auth_type !== authType || (existing.auth_header || '') !== authHeader;
    if (moved) await sb.from('connector_secrets').delete().eq('connector_id', existing.id);
    const patch = {
      name, url, auth_type: authType, auth_header: authHeader || null, config, audience,
      enabled: input.enabled !== false, tool_prefs: prefs, updated_at: now,
      ...(moved ? { has_secret: false, tools: [], status: 'new', status_detail: null, checked_at: null } : {}),
    };
    const { data, error } = await sb.from('connectors').update(patch).eq('id', existing.id).select('*').single();
    if (error) throw new ConnectorError('Could not save the connector.', 500);
    return data;
  }
  const row = {
    id: 'cn_' + crypto.randomUUID().replace(/-/g, '').slice(0, 16), created_at: now, updated_at: now, owner: cleanStr(ownerHint, 60) || null,
    kind, preset: cleanStr(input.preset, 30) || null, name, url, auth_type: authType, auth_header: authHeader || null,
    config, audience, enabled: input.enabled !== false, tool_prefs: prefs,
  };
  const { data, error } = await sb.from('connectors').insert(row).select('*').single();
  if (error) throw new ConnectorError('Could not save the connector.', 500);
  return data;
}

async function saveSecret(id: unknown, secret: unknown): Promise<Row> {
  const row = await getRow(id);
  if (!secret || typeof secret !== 'object') throw new ConnectorError('Missing credentials.', 400);
  const fields = row.kind === 'mcp' ? (row.auth_type === 'none' ? [] : ['token']) : ADAPTERS[row.kind].secretFields;
  if (!fields.length) throw new ConnectorError('This connector does not use a token.', 400);
  const clean: Record<string, string> = {};
  for (const f of fields) {
    const v = cleanStr((secret as Row)[f], 4000);
    if (!v) throw new ConnectorError(`Fill in ${f.replace(/_/g, ' ')}.`, 400);
    if (/[\r\n]/.test(v)) throw new ConnectorError(`${f.replace(/_/g, ' ')} must be a single line.`, 400);
    clean[f] = v;
  }
  const { error } = await sb.from('connector_secrets').upsert({ connector_id: row.id, secret: clean, updated_at: Date.now() }, { onConflict: 'connector_id' });
  if (error) throw new ConnectorError('Could not store the credentials.', 500);
  const { data, error: e2 } = await sb.from('connectors').update({ has_secret: true, status: 'new', status_detail: null, updated_at: Date.now() }).eq('id', row.id).select('*').single();
  if (e2) throw new ConnectorError('Could not update the connector.', 500);
  return data;
}

async function discover(id: unknown): Promise<Row> {
  const row = await getRow(id);
  const secret = await getSecret(row.id);
  let tools: McpTool[] = [];
  let detail = '';
  let failure: string | null = null;
  try {
    if (row.kind === 'mcp') {
      if (row.auth_type !== 'none' && !secret.token) throw new ConnectorError('Add the token first.', 400);
      tools = await listMcpTools(row.url, mcpAuth(row, secret), { resolve: resolveHost });
      detail = `${tools.length} tool${tools.length === 1 ? '' : 's'} found`;
    } else {
      const a = ADAPTERS[row.kind];
      const missing = a.secretFields.filter((f) => !secret[f]);
      if (missing.length) throw new ConnectorError('Add the credentials first.', 400);
      detail = await a.check(secret, row.config ?? {}, fetch);
      tools = a.tools;
    }
  } catch (e) {
    failure = e instanceof ConnectorError ? e.message : 'Unexpected error while connecting.';
    if (!(e instanceof ConnectorError)) console.error('discover failed', e);
  }
  const patch = failure
    ? { status: 'error', status_detail: failure, checked_at: Date.now() }
    : { status: 'connected', status_detail: detail, checked_at: Date.now(), tools };
  const { data, error } = await sb.from('connectors').update(patch).eq('id', row.id).select('*').single();
  if (error) throw new ConnectorError('Could not save the result.', 500);
  return data;
}

async function callTool(id: unknown, tool: unknown, args: unknown): Promise<{ text: string; is_error: boolean }> {
  const row = await getRow(id);
  if (!row.enabled) throw new ConnectorError('This connector is turned off.', 403);
  if (typeof tool !== 'string' || !tool) throw new ConnectorError('Missing tool name.', 400);
  const known = (row.kind === 'mcp' ? (row.tools as McpTool[]) : ADAPTERS[row.kind].tools).some((t) => t.name === tool);
  if (!known) throw new ConnectorError('That tool is not on this connector. Run Test connection first.', 400);
  if ((row.tool_prefs ?? {})[tool] === 'off') throw new ConnectorError('That tool is turned off.', 403);
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const secret = await getSecret(row.id);
  if (row.kind === 'mcp') {
    const r = await callMcpTool(row.url, mcpAuth(row, secret), tool, input, { resolve: resolveHost });
    return { text: r.text, is_error: r.isError };
  }
  const a = ADAPTERS[row.kind];
  if (a.secretFields.some((f) => !secret[f])) throw new ConnectorError('Add the credentials first.', 400);
  return { text: await a.call(tool, input, secret, row.config ?? {}, fetch), is_error: false };
}

Deno.serve(async (req) => {
  const origin = req.headers.get('origin');
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(origin) });
  if (req.method !== 'POST') return reply({ ok: false, error: 'method not allowed' }, 405, origin);
  if (ALLOWED_ORIGINS.length && (!origin || !ALLOWED_ORIGINS.includes(origin))) return reply({ ok: false, error: 'origin not allowed' }, 403, origin);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return reply({ ok: false, error: 'request too large' }, 413, origin);
  let body: Row;
  try { body = JSON.parse(raw); } catch { return reply({ ok: false, error: 'invalid JSON' }, 400, origin); }
  if (!body || typeof body !== 'object') return reply({ ok: false, error: 'invalid request' }, 400, origin);

  try {
    switch (body.action) {
      case 'save_connector':
        return reply({ ok: true, connector: await saveConnector(body.connector ?? {}, body.owner) }, 200, origin);
      case 'save_secret':
        return reply({ ok: true, connector: await saveSecret(body.connector_id, body.secret) }, 200, origin);
      case 'clear_secret': {
        const row = await getRow(body.connector_id);
        await sb.from('connector_secrets').delete().eq('connector_id', row.id);
        const { data } = await sb.from('connectors').update({ has_secret: false, status: 'new', status_detail: null, tools: [], updated_at: Date.now() }).eq('id', row.id).select('*').single();
        return reply({ ok: true, connector: data }, 200, origin);
      }
      case 'delete_connector': {
        const row = await getRow(body.connector_id);
        const { error } = await sb.from('connectors').delete().eq('id', row.id); // secrets cascade
        if (error) throw new ConnectorError('Could not delete the connector.', 500);
        return reply({ ok: true }, 200, origin);
      }
      case 'discover':
        return reply({ ok: true, connector: await discover(body.connector_id) }, 200, origin);
      case 'call': {
        const r = await callTool(body.connector_id, body.tool, body.arguments);
        return reply({ ok: true, ...r }, 200, origin);
      }
      default:
        return reply({ ok: false, error: 'unknown action' }, 400, origin);
    }
  } catch (e) {
    if (e instanceof ConnectorError) return reply({ ok: false, error: e.message }, 200, origin);
    console.error('connectors failed', e);
    return reply({ ok: false, error: 'Unexpected error' }, 200, origin);
  }
});
