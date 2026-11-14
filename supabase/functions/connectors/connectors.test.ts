// Run with:  npm run test:connectors
// No network: every outbound call goes to a fake fetch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, callMcpTool, ConnectorError, extractRpcMessage, listMcpTools } from './_mcp.ts';
import { ADAPTERS } from './_adapters.ts';

const publicDns = async () => ['93.184.216.34'];
const URL_OK = 'https://mcp.example.com/mcp';

/** A tiny in-process MCP server. `mode` picks plain JSON or SSE replies. */
function fakeMcp(opts: { mode?: 'json' | 'sse'; pages?: boolean; requireToken?: string; status?: number } = {}) {
  const seen: { method: string; headers: Record<string, string>; body: any }[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ method: init.method, headers, body });
    if (opts.status) return new Response('nope', { status: opts.status, headers: opts.status === 302 ? { location: 'http://169.254.169.254/' } : {} });
    if (opts.requireToken && headers.authorization !== `Bearer ${opts.requireToken}`) return new Response('', { status: 401 });
    if (init.method === 'DELETE') return new Response('', { status: 200 });
    if (body.method === 'notifications/initialized') return new Response('', { status: 202 });
    let result: any;
    if (body.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } };
    if (body.method === 'tools/list') {
      result = opts.pages && !body.params.cursor
        ? { tools: [{ name: 'a', description: 'tool a', inputSchema: { type: 'object', properties: {} } }], nextCursor: 'p2' }
        : { tools: [{ name: 'b', description: 'tool b', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: true } }] };
    }
    if (body.method === 'tools/call') result = { content: [{ type: 'text', text: `ran ${body.params.name} ${JSON.stringify(body.params.arguments)}` }, { type: 'image', data: 'x' }], isError: body.params.name === 'boom' };
    const rpcMsg = JSON.stringify({ jsonrpc: '2.0', id: body.id, result });
    const h: Record<string, string> = body.method === 'initialize' ? { 'mcp-session-id': 'sess-1' } : {};
    if (opts.mode === 'sse') {
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })}\n\nevent: message\ndata: ${rpcMsg}\n\n`, { headers: { ...h, 'content-type': 'text/event-stream' } });
    }
    return new Response(rpcMsg, { headers: { ...h, 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

test('assertPublicUrl refuses anything that is not a public https URL', async () => {
  for (const bad of [
    'http://mcp.example.com/mcp', 'https://localhost/mcp', 'https://127.0.0.1/mcp', 'https://10.0.0.5/mcp',
    'https://169.254.169.254/latest/meta-data', 'https://192.168.1.1/', 'https://172.20.0.1/', 'https://100.64.0.1/',
    'https://[::1]/', 'https://[fd00::1]/', 'https://[::ffff:127.0.0.1]/', 'https://[::ffff:7f00:1]/',
    'https://intranet/', 'https://printer.local/', 'https://svc.internal/', 'https://user:pw@mcp.example.com/', 'not a url',
  ]) {
    await assert.rejects(() => assertPublicUrl(bad, publicDns), ConnectorError, bad);
  }
  await assert.rejects(() => assertPublicUrl(URL_OK, async () => ['10.1.2.3']), /private network/);
  await assert.rejects(() => assertPublicUrl(URL_OK, async () => ['fe80::1']), /private network/);
  await assert.rejects(() => assertPublicUrl(URL_OK, async () => []), /look up/);
  assert.equal((await assertPublicUrl(URL_OK, publicDns)).hostname, 'mcp.example.com');
});

test('lists tools: handshake order, bearer token, session id and negotiated version carried through', async () => {
  const s = fakeMcp({ requireToken: 'tok' });
  const tools = await listMcpTools(URL_OK, { type: 'bearer', token: 'tok' }, { fetchImpl: s.fetchImpl, resolve: publicDns });
  assert.deepEqual(s.seen.map((r) => r.body?.method ?? r.method), ['initialize', 'notifications/initialized', 'tools/list', 'DELETE']);
  assert.equal(s.seen[1].headers['mcp-session-id'], 'sess-1');
  assert.equal(s.seen[2].headers['mcp-protocol-version'], '2025-03-26');
  assert.ok(s.seen.every((r) => r.headers.authorization === 'Bearer tok'));
  assert.deepEqual(tools.map((t) => [t.name, t.read_only]), [['b', true]]);
});

test('custom header auth and pagination', async () => {
  const s = fakeMcp({ pages: true });
  const tools = await listMcpTools(URL_OK, { type: 'header', header: 'x-api-key', token: 'k' }, { fetchImpl: s.fetchImpl, resolve: publicDns });
  assert.deepEqual(tools.map((t) => t.name), ['a', 'b']);
  assert.equal(s.seen[0].headers['x-api-key'], 'k');
  assert.equal(s.seen[0].headers.authorization, undefined);
});

test('reads SSE replies and ignores unrelated events', async () => {
  const s = fakeMcp({ mode: 'sse' });
  const tools = await listMcpTools(URL_OK, { type: 'none' }, { fetchImpl: s.fetchImpl, resolve: publicDns });
  assert.equal(tools[0].name, 'b');
  assert.equal(extractRpcMessage('text/event-stream', 'data: {"id":2,"result":1}\n\n', 3), null);
});

test('calls a tool and flattens its content', async () => {
  const s = fakeMcp();
  const r = await callMcpTool(URL_OK, { type: 'none' }, 'echo', { q: 'hi' }, { fetchImpl: s.fetchImpl, resolve: publicDns });
  assert.equal(r.text, 'ran echo {"q":"hi"}\n[image content not shown]');
  assert.equal(r.isError, false);
  assert.equal((await callMcpTool(URL_OK, { type: 'none' }, 'boom', {}, { fetchImpl: s.fetchImpl, resolve: publicDns })).isError, true);
});

test('explains auth failures and refuses redirects', async () => {
  await assert.rejects(
    () => listMcpTools(URL_OK, { type: 'none' }, { fetchImpl: fakeMcp({ requireToken: 'tok' }).fetchImpl, resolve: publicDns }),
    /wants a token/,
  );
  await assert.rejects(
    () => listMcpTools(URL_OK, { type: 'bearer', token: 'wrong' }, { fetchImpl: fakeMcp({ requireToken: 'tok' }).fetchImpl, resolve: publicDns }),
    /rejected the token/,
  );
  await assert.rejects(() => listMcpTools(URL_OK, { type: 'none' }, { fetchImpl: fakeMcp({ status: 302 }).fetchImpl, resolve: publicDns }), /redirected/);
  await assert.rejects(() => listMcpTools(URL_OK, { type: 'none' }, { fetchImpl: fakeMcp({ status: 500 }).fetchImpl, resolve: publicDns }), /answered 500/);
});

/* ---------- adapters ---------- */

function recorder(reply: (url: string, init: any) => any) {
  const calls: { url: string; init: any }[] = [];
  const f = (async (url: any, init: any) => {
    calls.push({ url: String(url), init });
    const out = reply(String(url), init);
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, calls };
}

test('Claude / ChatGPT / Gemini adapters build the right request', async () => {
  let r = recorder(() => ({ content: [{ type: 'text', text: 'hello from claude' }] }));
  assert.equal(await ADAPTERS.claude.call('ask_claude', { prompt: 'hi', system: 'be brief' }, { api_key: 'sk-a' }, {}, r.f), 'hello from claude');
  assert.equal(r.calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(r.calls[0].init.headers['x-api-key'], 'sk-a');
  const cb = JSON.parse(r.calls[0].init.body);
  assert.equal(cb.model, 'claude-sonnet-5-5'); assert.equal(cb.system, 'be brief');

  r = recorder(() => ({ choices: [{ message: { content: 'hello from gpt' } }] }));
  assert.equal(await ADAPTERS.openai.call('ask_chatgpt', { prompt: 'hi' }, { api_key: 'sk-o' }, { model: 'gpt-x' }, r.f), 'hello from gpt');
  assert.equal(r.calls[0].init.headers.authorization, 'Bearer sk-o');
  assert.equal(JSON.parse(r.calls[0].init.body).model, 'gpt-x');

  r = recorder(() => ({ candidates: [{ content: { parts: [{ text: 'hello ' }, { text: 'from gemini' }] } }] }));
  assert.equal(await ADAPTERS.gemini.call('ask_gemini', { prompt: 'hi' }, { api_key: 'g' }, { model: 'gemini/../x' }, r.f), 'hello from gemini');
  assert.equal(r.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini..x:generateContent'); // slashes stripped
  assert.equal(r.calls[0].init.headers['x-goog-api-key'], 'g');
});

test('WhatsApp adapter validates the number and builds text and template messages', async () => {
  const r = recorder(() => ({ messages: [{ id: 'wamid.1' }] }));
  const cfg = { phone_number_id: '12345' };
  assert.match(await ADAPTERS.whatsapp.call('whatsapp_send_text', { to: '+972 50-123-4567', text: 'shalom' }, { access_token: 't' }, cfg, r.f), /wamid\.1/);
  assert.equal(r.calls[0].url, 'https://graph.facebook.com/v21.0/12345/messages');
  assert.deepEqual(JSON.parse(r.calls[0].init.body), { messaging_product: 'whatsapp', to: '972501234567', type: 'text', text: { body: 'shalom' } });
  await ADAPTERS.whatsapp.call('whatsapp_send_template', { to: '972501234567', template_name: 'order_ready', language: 'he', body_params: ['Dana'] }, { access_token: 't' }, cfg, r.f);
  assert.deepEqual(JSON.parse(r.calls[1].init.body).template, { name: 'order_ready', language: { code: 'he' }, components: [{ type: 'body', parameters: [{ type: 'text', text: 'Dana' }] }] });
  await assert.rejects(() => ADAPTERS.whatsapp.call('whatsapp_send_text', { to: '12', text: 'x' }, { access_token: 't' }, cfg, r.f), /7-15 digits/);
  await assert.rejects(() => ADAPTERS.whatsapp.call('whatsapp_send_text', { to: '972501234567', text: 'x' }, { access_token: 't' }, {}, r.f), /phone number ID/);
});

test('Gmail adapter: token refresh, search, read, and a Hebrew subject on send', async () => {
  const b64u = (s: string) => Buffer.from(s).toString('base64url');
  const r = recorder((url, init) => {
    if (url.includes('oauth2.googleapis.com')) return { access_token: 'at' };
    if (url.endsWith('/messages/send')) return { id: 'sent-1' };
    if (url.includes('/messages?')) return { messages: [{ id: 'm1' }] };
    if (url.includes('format=metadata')) return { id: 'm1', snippet: 'hello', payload: { headers: [{ name: 'From', value: 'a@b.co' }, { name: 'Subject', value: 'Hi' }, { name: 'Date', value: 'Mon' }] } };
    if (url.includes('format=full')) return { id: 'm1', payload: { headers: [{ name: 'Subject', value: 'Hi' }], parts: [{ mimeType: 'text/plain', body: { data: b64u('plain body') } }] } };
    throw new Error('unexpected ' + url);
  });
  const secret = { client_id: 'c', client_secret: 's', refresh_token: 'rt' };
  const found = JSON.parse(await ADAPTERS.gmail.call('gmail_search', { query: 'from:a newer_than:7d', max_results: 3 }, secret, {}, r.f));
  assert.deepEqual(found.messages[0], { id: 'm1', from: 'a@b.co', subject: 'Hi', date: 'Mon', snippet: 'hello' });
  assert.match(String(r.calls[0].init.body), /grant_type=refresh_token/);
  assert.equal(r.calls[1].init.headers.authorization, 'Bearer at');
  assert.equal(JSON.parse(await ADAPTERS.gmail.call('gmail_read', { message_id: 'm1' }, secret, {}, r.f)).body, 'plain body');

  await ADAPTERS.gmail.call('gmail_send', { to: 'dana@example.com', subject: 'שלום', body: 'גוף ההודעה' }, secret, {}, r.f);
  const sendCall = r.calls.find((c) => c.url.endsWith('/messages/send'))!;
  const mime = Buffer.from(JSON.parse(sendCall.init.body).raw, 'base64url').toString();
  assert.match(mime, /^To: dana@example\.com\r\n/);
  const subj = /Subject: =\?UTF-8\?B\?(.+)\?=/.exec(mime)!;
  assert.equal(Buffer.from(subj[1], 'base64').toString(), 'שלום');
  assert.equal(Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString(), 'גוף ההודעה');

  // Header injection through the recipient or subject is not possible.
  await assert.rejects(() => ADAPTERS.gmail.call('gmail_send', { to: 'a@b.co\r\nBcc: x@y.co', subject: 's', body: 'b' }, secret, {}, r.f), /valid recipient/);
  await ADAPTERS.gmail.call('gmail_send', { to: 'a@b.co', subject: 'one\r\nBcc: x@y.co', body: 'b' }, secret, {}, r.f);
  const last = Buffer.from(JSON.parse(r.calls.at(-1)!.init.body).raw, 'base64url').toString();
  assert.equal(last.split('\r\n\r\n')[0].split('\r\n').filter((l) => /^bcc:/i.test(l)).length, 0);
});

test('adapters turn upstream failures into readable errors', async () => {
  const f = (async () => new Response(JSON.stringify({ error: { message: 'invalid x-api-key' } }), { status: 401 })) as typeof fetch;
  await assert.rejects(() => ADAPTERS.claude.call('ask_claude', { prompt: 'x' }, { api_key: 'bad' }, {}, f), /rejected the credentials. invalid x-api-key/);
  await assert.rejects(() => ADAPTERS.claude.call('nope', {}, { api_key: 'k' }, {}, f), /Unknown tool/);
});
