// ============================================================
// Minimal MCP client over Streamable HTTP (spec 2025-06-18), plus the
// guard that keeps the gateway from being used to reach private networks.
//
// Deliberately dependency-free and Deno-agnostic (plain fetch), so the
// same file runs in the Edge Function and in the Node tests.
//
// Not supported: the older HTTP+SSE transport (2024-11-05) and servers
// that require an OAuth flow. A server that accepts a static bearer
// token or API-key header works.
// ============================================================

export type McpTool = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  read_only: boolean;
};

export type McpAuth = { type: 'none' | 'bearer' | 'header'; header?: string; token?: string };

export class ConnectorError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

const PROTOCOL_VERSION = '2025-06-18';
const MAX_RESPONSE_BYTES = 2_000_000;
const DEFAULT_TIMEOUT_MS = 25_000;

/* ---------- SSRF guard ---------- */

function ipv4ToParts(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n >= 0 && n <= 255) ? parts : null;
}

export function isPrivateIPv4(parts: number[]): boolean {
  const [a, b] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224; // multicast + reserved
}

export function isPrivateIPv6(addr: string): boolean {
  const a = addr.toLowerCase().replace(/^\[|\]$/g, '');
  if (a === '::' || a === '::1') return true;
  if (/^f[cd]/.test(a)) return true; // fc00::/7 unique local
  if (/^fe[89ab]/.test(a)) return true; // fe80::/10 link-local
  const mapped = /^::ffff:(?:(\d{1,3}(?:\.\d{1,3}){3})|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(a);
  if (mapped) {
    if (mapped[1]) {
      const p = ipv4ToParts(mapped[1]);
      return !p || isPrivateIPv4(p);
    }
    const hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16);
    return isPrivateIPv4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return false;
}

/** Throws ConnectorError unless `raw` is a public https URL. `resolve`, when
 *  given, returns the host's A/AAAA records so a public-looking name that
 *  points at a private address is refused too. */
export async function assertPublicUrl(
  raw: string,
  resolve?: (host: string) => Promise<string[]>,
): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new ConnectorError('That is not a valid URL.', 400); }
  if (u.protocol !== 'https:') throw new ConnectorError('The server URL must start with https://', 400);
  if (u.username || u.password) throw new ConnectorError('Do not put credentials inside the URL; use the token field.', 400);
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || (!host.includes('.') && !host.includes(':'))) {
    throw new ConnectorError('That address is not reachable from the internet.', 400);
  }
  const v4 = ipv4ToParts(host);
  if (v4 && isPrivateIPv4(v4)) throw new ConnectorError('That address is on a private network.', 400);
  if (host.includes(':') && isPrivateIPv6(host)) throw new ConnectorError('That address is on a private network.', 400);
  if (resolve && !v4 && !host.includes(':')) {
    let addrs: string[] = [];
    try { addrs = await resolve(host); } catch { throw new ConnectorError('Could not look up that server name.', 400); }
    if (!addrs.length) throw new ConnectorError('Could not look up that server name.', 400);
    for (const ip of addrs) {
      const p = ipv4ToParts(ip);
      if ((p && isPrivateIPv4(p)) || (!p && isPrivateIPv6(ip))) throw new ConnectorError('That server name points at a private network.', 400);
    }
  }
  return u;
}

/* ---------- transport ---------- */

type Ctx = {
  url: URL;
  auth: McpAuth;
  fetchImpl: typeof fetch;
  sessionId?: string;
  protocolVersion: string;
  timeoutMs: number;
  nextId: number;
};

function authHeaders(auth: McpAuth): Record<string, string> {
  if (auth.type === 'bearer' && auth.token) return { authorization: `Bearer ${auth.token}` };
  if (auth.type === 'header' && auth.token && auth.header) return { [auth.header]: auth.token };
  return {};
}

async function readLimited(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new ConnectorError('The server sent too much data.'); }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.byteLength; }
  return new TextDecoder().decode(all);
}

/** Pulls the JSON-RPC message with `id` out of either a plain JSON body or an SSE stream. */
export function extractRpcMessage(contentType: string, text: string, id: number | null): any {
  if (/text\/event-stream/i.test(contentType)) {
    let found: any = null;
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
      if (!data) continue;
      let msg: any;
      try { msg = JSON.parse(data); } catch { continue; }
      if (id === null || msg.id === id) found = msg;
    }
    return found;
  }
  try {
    const msg = JSON.parse(text);
    return Array.isArray(msg) ? (msg.find((m) => m.id === id) ?? null) : msg;
  } catch {
    return null;
  }
}

async function post(ctx: Ctx, body: unknown, expectReply: boolean): Promise<any> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': ctx.protocolVersion,
    ...authHeaders(ctx.auth),
  };
  if (ctx.sessionId) headers['mcp-session-id'] = ctx.sessionId;
  let res: Response;
  try {
    res = await ctx.fetchImpl(ctx.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual', // a redirect could point somewhere the guard never saw
      signal: AbortSignal.timeout(ctx.timeoutMs),
    });
  } catch (e) {
    const name = (e as Error)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new ConnectorError('The server took too long to answer.', 504);
    throw new ConnectorError('Could not reach the server.');
  }
  if (res.status >= 300 && res.status < 400) throw new ConnectorError('The server redirected the request; use its final URL.', 400);
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new ConnectorError(ctx.auth.type === 'none' || !ctx.auth.token
      ? 'The server wants a token. Choose a sign-in method and paste the token.'
      : 'The server rejected the token.', 401);
  }
  if (!res.ok) {
    const t = await readLimited(res).catch(() => '');
    throw new ConnectorError(`The server answered ${res.status}. ${t.slice(0, 200)}`.trim());
  }
  const sid = res.headers.get('mcp-session-id');
  if (sid) ctx.sessionId = sid;
  if (!expectReply) { await res.body?.cancel(); return null; }
  const text = await readLimited(res);
  const msg = extractRpcMessage(res.headers.get('content-type') || '', text, (body as any).id ?? null);
  if (!msg) throw new ConnectorError('The server did not send a valid MCP reply. It may use the older SSE transport, which is not supported.');
  if (msg.error) throw new ConnectorError(`The server returned an error: ${String(msg.error.message || msg.error.code).slice(0, 300)}`);
  return msg.result;
}

async function rpc(ctx: Ctx, method: string, params?: unknown): Promise<any> {
  const id = ctx.nextId++;
  return post(ctx, { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, true);
}

async function open(
  rawUrl: string,
  auth: McpAuth,
  opts: { fetchImpl?: typeof fetch; resolve?: (h: string) => Promise<string[]>; timeoutMs?: number },
): Promise<Ctx> {
  const url = await assertPublicUrl(rawUrl, opts.resolve);
  const ctx: Ctx = {
    url, auth, fetchImpl: opts.fetchImpl ?? fetch, protocolVersion: PROTOCOL_VERSION,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS, nextId: 1,
  };
  const init = await rpc(ctx, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'swg-crm', version: '1.0.0' },
  });
  // Use the version the server settled on for every later request.
  if (init && typeof init.protocolVersion === 'string') ctx.protocolVersion = init.protocolVersion;
  await post(ctx, { jsonrpc: '2.0', method: 'notifications/initialized' }, false);
  return ctx;
}

async function close(ctx: Ctx) {
  if (!ctx.sessionId) return;
  try {
    await ctx.fetchImpl(ctx.url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': ctx.sessionId, 'mcp-protocol-version': ctx.protocolVersion, ...authHeaders(ctx.auth) },
      redirect: 'manual',
      signal: AbortSignal.timeout(5_000),
    }).then((r) => r.body?.cancel());
  } catch { /* closing is best effort */ }
}

/* ---------- public API ---------- */

type Opts = { fetchImpl?: typeof fetch; resolve?: (h: string) => Promise<string[]>; timeoutMs?: number };

export async function listMcpTools(rawUrl: string, auth: McpAuth, opts: Opts = {}): Promise<McpTool[]> {
  const ctx = await open(rawUrl, auth, opts);
  try {
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await rpc(ctx, 'tools/list', cursor ? { cursor } : {});
      for (const t of (r?.tools ?? [])) {
        if (!t || typeof t.name !== 'string') continue;
        tools.push({
          name: t.name.slice(0, 128),
          description: String(t.description ?? t.title ?? '').slice(0, 1000),
          input_schema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : { type: 'object', properties: {} },
          read_only: t.annotations?.readOnlyHint === true,
        });
      }
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return tools.slice(0, 100);
  } finally {
    await close(ctx);
  }
}

/** Runs one tool and returns its text output (plus isError). */
export async function callMcpTool(
  rawUrl: string,
  auth: McpAuth,
  tool: string,
  args: Record<string, unknown>,
  opts: Opts = {},
): Promise<{ text: string; isError: boolean }> {
  const ctx = await open(rawUrl, auth, opts);
  try {
    const r = await rpc(ctx, 'tools/call', { name: tool, arguments: args });
    const parts: string[] = [];
    for (const c of (r?.content ?? [])) {
      if (c?.type === 'text') parts.push(String(c.text));
      else if (c?.type === 'resource' && c.resource?.text) parts.push(String(c.resource.text));
      else if (c?.type) parts.push(`[${c.type} content not shown]`);
    }
    if (!parts.length && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent));
    return { text: parts.join('\n').slice(0, 50_000), isError: r?.isError === true };
  } finally {
    await close(ctx);
  }
}
