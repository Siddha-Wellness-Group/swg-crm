// ============================================================
// Built-in connectors that are plain REST APIs rather than MCP servers.
// Each adapter exposes its tools in the same shape an MCP server would
// (name, description, JSON schema, read_only), so the CRM treats every
// connector the same way.
//
// Secrets arrive decrypted from connector_secrets; config is the
// non-secret part of the connector row.
// ============================================================
import { ConnectorError, type McpTool } from './_mcp.ts';

type Json = Record<string, unknown>;
type Secret = Record<string, string>;
export type Adapter = {
  label: string;
  /** Secret fields the adapter needs; all must be present to count as connected. */
  secretFields: string[];
  tools: McpTool[];
  /** A free, read-only request that proves the credentials work. Returns a short note for the UI. */
  check: (secret: Secret, config: Json, f: typeof fetch) => Promise<string>;
  call: (tool: string, args: Json, secret: Secret, config: Json, f: typeof fetch) => Promise<string>;
};

const TIMEOUT_MS = 45_000;
const str = (v: unknown, max = 20_000) => String(v ?? '').slice(0, max);

async function jfetch(f: typeof fetch, url: string, init: RequestInit): Promise<any> {
  let res: Response;
  try {
    res = await f(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const n = (e as Error)?.name;
    throw new ConnectorError(n === 'TimeoutError' || n === 'AbortError' ? 'The service took too long to answer.' : 'Could not reach the service.', n === 'TimeoutError' ? 504 : 502);
  }
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const detail = body?.error?.message || body?.error_description || body?.message || (typeof body?.error === 'string' ? body.error : '') || text.slice(0, 200);
    if (res.status === 401 || res.status === 403) throw new ConnectorError(`The service rejected the credentials. ${str(detail, 200)}`.trim(), 401);
    throw new ConnectorError(`The service answered ${res.status}. ${str(detail, 200)}`.trim());
  }
  return body;
}

const promptSchema = {
  type: 'object',
  properties: {
    prompt: { type: 'string', description: 'What to ask. Include any CRM facts the model needs; it cannot see the CRM.' },
    system: { type: 'string', description: 'Optional instructions for how to answer.' },
  },
  required: ['prompt'],
  additionalProperties: false,
};

/* ---------- Claude (Anthropic API) ---------- */
const claude: Adapter = {
  label: 'Claude',
  secretFields: ['api_key'],
  tools: [{
    name: 'ask_claude',
    description: 'Send a prompt to Claude (a separate model, via the Anthropic API) and get its answer back. Use for a second opinion, drafting or analysis.',
    input_schema: promptSchema, read_only: false,
  }],
  async check(secret, _config, f) {
    await jfetch(f, 'https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': secret.api_key, 'anthropic-version': '2023-06-01' } });
    return 'API key accepted';
  },
  async call(tool, args, secret, config, f) {
    if (tool !== 'ask_claude') throw new ConnectorError(`Unknown tool ${tool}`, 400);
    const data = await jfetch(f, 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': secret.api_key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: str(config.model) || 'claude-sonnet-5-5',
        max_tokens: 2048,
        ...(args.system ? { system: str(args.system, 8000) } : {}),
        messages: [{ role: 'user', content: str(args.prompt, 30_000) }],
      }),
    });
    return (data?.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n') || '(empty reply)';
  },
};

/* ---------- ChatGPT (OpenAI API) ---------- */
const openai: Adapter = {
  label: 'ChatGPT',
  secretFields: ['api_key'],
  tools: [{
    name: 'ask_chatgpt',
    description: 'Send a prompt to ChatGPT (OpenAI API) and get its answer back. Use for a second opinion, drafting or analysis.',
    input_schema: promptSchema, read_only: false,
  }],
  async check(secret, _config, f) {
    await jfetch(f, 'https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${secret.api_key}` } });
    return 'API key accepted';
  },
  async call(tool, args, secret, config, f) {
    if (tool !== 'ask_chatgpt') throw new ConnectorError(`Unknown tool ${tool}`, 400);
    const messages: Json[] = [];
    if (args.system) messages.push({ role: 'system', content: str(args.system, 8000) });
    messages.push({ role: 'user', content: str(args.prompt, 30_000) });
    const data = await jfetch(f, 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret.api_key}` },
      body: JSON.stringify({ model: str(config.model) || 'gpt-4.1', messages }),
    });
    return str(data?.choices?.[0]?.message?.content) || '(empty reply)';
  },
};

/* ---------- Gemini (Google AI API) ---------- */
const gemini: Adapter = {
  label: 'Google Gemini',
  secretFields: ['api_key'],
  tools: [{
    name: 'ask_gemini',
    description: 'Send a prompt to Google Gemini and get its answer back. Use for a second opinion, drafting or analysis.',
    input_schema: promptSchema, read_only: false,
  }],
  async check(secret, _config, f) {
    await jfetch(f, 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': secret.api_key } });
    return 'API key accepted';
  },
  async call(tool, args, secret, config, f) {
    if (tool !== 'ask_gemini') throw new ConnectorError(`Unknown tool ${tool}`, 400);
    const model = (str(config.model) || 'gemini-2.5-flash').replace(/[^a-zA-Z0-9._-]/g, '');
    const data = await jfetch(f, `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': secret.api_key },
      body: JSON.stringify({
        ...(args.system ? { systemInstruction: { parts: [{ text: str(args.system, 8000) }] } } : {}),
        contents: [{ role: 'user', parts: [{ text: str(args.prompt, 30_000) }] }],
      }),
    });
    return (data?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('') || '(empty reply)';
  },
};

/* ---------- WhatsApp (Meta Cloud API) ---------- */
const GRAPH = 'https://graph.facebook.com/v21.0';
const whatsapp: Adapter = {
  label: 'WhatsApp',
  secretFields: ['access_token'],
  tools: [
    {
      name: 'whatsapp_send_text',
      description: 'Send a WhatsApp text message. WhatsApp only delivers free-form text if the person messaged the business in the last 24 hours; otherwise use whatsapp_send_template.',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Phone number in international format, digits only, e.g. 972501234567.' },
          text: { type: 'string' },
        },
        required: ['to', 'text'], additionalProperties: false,
      },
      read_only: false,
    },
    {
      name: 'whatsapp_send_template',
      description: 'Send a pre-approved WhatsApp template message (works outside the 24-hour window).',
      input_schema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'International format, digits only.' },
          template_name: { type: 'string' },
          language: { type: 'string', description: 'Template language code, e.g. en_US or he.' },
          body_params: { type: 'array', items: { type: 'string' }, description: 'Values for {{1}}, {{2}}... in the template body.' },
        },
        required: ['to', 'template_name', 'language'], additionalProperties: false,
      },
      read_only: false,
    },
  ],
  async check(secret, config, f) {
    const phoneId = str(config.phone_number_id).replace(/\D/g, '');
    if (!phoneId) throw new ConnectorError('Set the WhatsApp phone number ID first.', 400);
    const d = await jfetch(f, `${GRAPH}/${phoneId}?fields=display_phone_number,verified_name`, { headers: { authorization: `Bearer ${secret.access_token}` } });
    return `Number ${d?.display_phone_number ?? phoneId} accepted`;
  },
  async call(tool, args, secret, config, f) {
    const phoneId = str(config.phone_number_id).replace(/\D/g, '');
    if (!phoneId) throw new ConnectorError('Set the WhatsApp phone number ID in this connector first.', 400);
    const to = str(args.to).replace(/\D/g, '');
    if (to.length < 7 || to.length > 15) throw new ConnectorError('The phone number must be 7-15 digits in international format.', 400);
    let message: Json;
    if (tool === 'whatsapp_send_text') {
      message = { type: 'text', text: { body: str(args.text, 4000) } };
    } else if (tool === 'whatsapp_send_template') {
      const params = Array.isArray(args.body_params) ? args.body_params.slice(0, 20).map((p) => ({ type: 'text', text: str(p, 1000) })) : [];
      message = {
        type: 'template',
        template: {
          name: str(args.template_name, 512), language: { code: str(args.language, 20) },
          ...(params.length ? { components: [{ type: 'body', parameters: params }] } : {}),
        },
      };
    } else throw new ConnectorError(`Unknown tool ${tool}`, 400);
    const data = await jfetch(f, `${GRAPH}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${secret.access_token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, ...message }),
    });
    return `Sent. WhatsApp message id: ${data?.messages?.[0]?.id ?? 'unknown'}`;
  },
};

/* ---------- Gmail (Gmail API, OAuth refresh token) ---------- */
async function gmailToken(secret: Secret, f: typeof fetch): Promise<string> {
  const data = await jfetch(f, 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: secret.client_id, client_secret: secret.client_secret,
      refresh_token: secret.refresh_token, grant_type: 'refresh_token',
    }),
  });
  if (!data?.access_token) throw new ConnectorError('Google did not return an access token.');
  return data.access_token;
}
const b64urlDecode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
function b64(bytes: Uint8Array) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const header = (v: string) => v.replace(/[\r\n]+/g, ' ').trim();
// RFC 2047, so Hebrew or accented subjects survive.
const encodeSubject = (s: string) => /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(new TextEncoder().encode(s))}?=`;

function bodyText(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) return b64urlDecode(payload.body.data);
  for (const p of payload.parts ?? []) { const t = bodyText(p); if (t) return t; }
  if (payload.mimeType === 'text/html' && payload.body?.data) return b64urlDecode(payload.body.data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  return '';
}
const hdr = (msg: any, name: string) => (msg?.payload?.headers ?? []).find((h: any) => h.name.toLowerCase() === name)?.value ?? '';

const gmail: Adapter = {
  label: 'Gmail',
  secretFields: ['client_id', 'client_secret', 'refresh_token'],
  tools: [
    {
      name: 'gmail_search',
      description: 'Search the connected Gmail mailbox (same syntax as the Gmail search box, e.g. "from:anna newer_than:7d"). Returns sender, subject, date and a snippet.',
      input_schema: {
        type: 'object',
        properties: { query: { type: 'string' }, max_results: { type: 'integer', description: '1-10, default 5.' } },
        required: ['query'], additionalProperties: false,
      },
      read_only: true,
    },
    {
      name: 'gmail_read',
      description: 'Read one email by id (from gmail_search): headers and plain-text body.',
      input_schema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'], additionalProperties: false },
      read_only: true,
    },
    {
      name: 'gmail_send',
      description: 'Send a plain-text email from the connected mailbox.',
      input_schema: {
        type: 'object',
        properties: { to: { type: 'string', description: 'One recipient address.' }, subject: { type: 'string' }, body: { type: 'string' } },
        required: ['to', 'subject', 'body'], additionalProperties: false,
      },
      read_only: false,
    },
  ],
  async check(secret, _config, f) {
    const token = await gmailToken(secret, f);
    const p = await jfetch(f, 'https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { authorization: `Bearer ${token}` } });
    return `Signed in as ${p?.emailAddress ?? 'the mailbox'}`;
  },
  async call(tool, args, secret, _config, f) {
    const token = await gmailToken(secret, f);
    const auth = { authorization: `Bearer ${token}` };
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me';
    if (tool === 'gmail_search') {
      const max = Math.min(10, Math.max(1, Number(args.max_results) || 5));
      const list = await jfetch(f, `${base}/messages?${new URLSearchParams({ q: str(args.query, 500), maxResults: String(max) })}`, { headers: auth });
      const out = [];
      for (const m of (list?.messages ?? []).slice(0, max)) {
        const msg = await jfetch(f, `${base}/messages/${encodeURIComponent(m.id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, { headers: auth });
        out.push({ id: m.id, from: hdr(msg, 'from'), subject: hdr(msg, 'subject'), date: hdr(msg, 'date'), snippet: msg.snippet });
      }
      return JSON.stringify({ total_returned: out.length, messages: out });
    }
    if (tool === 'gmail_read') {
      const msg = await jfetch(f, `${base}/messages/${encodeURIComponent(str(args.message_id, 100))}?format=full`, { headers: auth });
      return JSON.stringify({
        id: msg.id, from: hdr(msg, 'from'), to: hdr(msg, 'to'), subject: hdr(msg, 'subject'), date: hdr(msg, 'date'),
        body: bodyText(msg.payload).slice(0, 15_000),
      });
    }
    if (tool === 'gmail_send') {
      const to = header(str(args.to, 320));
      if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to)) throw new ConnectorError('Give exactly one valid recipient email address.', 400);
      const raw = [
        `To: ${to}`,
        `Subject: ${encodeSubject(header(str(args.subject, 500)))}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        b64(new TextEncoder().encode(str(args.body, 50_000))).replace(/(.{76})/g, '$1\r\n'),
      ].join('\r\n');
      const sent = await jfetch(f, `${base}/messages/send`, {
        method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ raw: b64url(new TextEncoder().encode(raw)) }),
      });
      return `Sent to ${to}. Gmail message id: ${sent?.id ?? 'unknown'}`;
    }
    throw new ConnectorError(`Unknown tool ${tool}`, 400);
  },
};

export const ADAPTERS: Record<string, Adapter> = { claude, openai, gemini, whatsapp, gmail };
