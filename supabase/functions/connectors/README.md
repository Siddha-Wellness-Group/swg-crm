# connectors

Gateway behind the CRM's **Connectors** screen (sidebar, Admin group, admins only).
The browser never calls Gmail, WhatsApp, an AI provider or an MCP server itself;
it asks this function, which holds the tokens and makes the call.

## Deploy

```bash
supabase db push                       # creates connectors + connector_secrets
supabase functions deploy connectors
supabase functions deploy support-agent   # now forwards connector tools to Claude
```

Optional: `supabase secrets set CONNECTORS_ALLOWED_ORIGINS=https://your-crm-origin`
(falls back to `AGENT_ALLOWED_ORIGINS`).

## What a connector is

| Type | How it connects | Tools |
| --- | --- | --- |
| Custom / Base44 | Remote MCP server URL (Streamable HTTP), optional bearer token or API-key header | whatever the server lists |
| Gmail | Google OAuth client + refresh token (same as the email service) | `gmail_search`, `gmail_read`, `gmail_send` |
| Claude / ChatGPT / Gemini | API key (+ optional model name) | `ask_claude`, `ask_chatgpt`, `ask_gemini` |
| WhatsApp | Meta Cloud API access token + phone number ID | `whatsapp_send_text`, `whatsapp_send_template` |

Each tool is set to **Needs approval** (assistant shows Approve / Decline), **Always allow**, or **Off**.
Built-in read-only tools start at Always allow; everything else, and every tool of a custom server, starts at Needs approval.

## Security notes

* Tokens live in `connector_secrets`, which has no anon/authenticated grant. The browser can send a token in but never read one back.
* `connectors` is readable but not writable with the anon key; only this function writes it. Changing a connector's URL or sign-in method deletes its saved token, so a connector cannot be repointed at another server to collect it.
* Outbound MCP calls are https-only, refuse private / loopback / link-local addresses (including names that resolve to them) and never follow redirects.
* The CRM has no server-side user identity (everything uses the anon key), so "who can use it" and "Needs approval" are enforced in the browser. Anyone holding the anon key could call this function directly. Moving the app to Supabase Auth and turning `verify_jwt` on is the real fix.
* Connector output goes to Claude (via `support-agent`) as untrusted data.

## Not supported yet

Servers that require an OAuth browser sign-in, and the older HTTP+SSE MCP transport.

## Tests

```bash
npm run test:connectors
```
