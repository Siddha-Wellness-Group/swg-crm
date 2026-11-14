# Connectors

Admin-only screen (sidebar, Admin > Connectors) that lets the in-app assistant use outside services, like connectors in Claude.

**Built in:** Gmail, Claude, Google Gemini, ChatGPT, WhatsApp. **MCP:** Base44 preset and any custom remote MCP server (Streamable HTTP, with no auth, a bearer token, or an API-key header).

## Deploy

```bash
supabase db push                       # adds connectors + connector_secrets
supabase functions deploy connectors
supabase functions deploy support-agent  # now forwards connector tools to Claude
```

Optional secret: `CONNECTORS_ALLOWED_ORIGINS` (comma-separated; falls back to `AGENT_ALLOWED_ORIGINS`).

## How it works

- Browser never calls the outside service. It calls the `connectors` Edge Function, which holds the tokens in `connector_secrets` (no anon access; the browser can send a token in but never read one back).
- **Save & test connection** logs in, lists the tools, and stores them. Each tool is **Needs approval** (default), **Always allow**, or **Off**. Built-in read-only tools (Gmail search/read) default to Always allow; a custom server's own "read only" claim is not trusted.
- The assistant gets the enabled tools on every message. Tools set to Needs approval show the exact arguments with Approve / Decline before running.
- Per connector: "Admins only" (default) or "Everyone" decides who sees its tools in the assistant.

## Setup per connector

| Connector | You need |
|---|---|
| Gmail | The same OAuth client ID/secret and refresh token as the email service (`npm run email:oauth-setup`) |
| Claude / Gemini / ChatGPT | An API key (model name optional) |
| WhatsApp | Meta Cloud API access token + Phone number ID. Free text only reaches people who wrote in within 24h; otherwise use a template |
| Base44 / custom | The MCP server URL (https) and token if required |

## Limits and security notes

- Not supported yet: MCP servers that need a browser OAuth sign-in, and the older HTTP+SSE transport.
- URLs must be public https. The gateway refuses private/loopback addresses, hostnames that resolve to them, and redirects. Changing a connector's URL or sign-in method deletes its saved token.
- Like `support-agent`, the function is called with the publishable key (`verify_jwt = false`), and the CRM's login is client-side. Anyone who has that key and a connector id can call a tool the admin left enabled. Set `CONNECTORS_ALLOWED_ORIGINS`, and treat real Supabase Auth plus JWT verification as the proper fix.
- Connector results are passed to Claude (Anthropic) as part of the conversation.

## Tests

```bash
npm run test:connectors   # gateway logic, no network
```
