# Automated Email Service

Transactional email for the SWG CRM. Everything customer-facing leaves as
`Siddha Yoga Web Services <customer@siddhayogaweb.com>`.

## Layout

| File | Role |
| --- | --- |
| `../../config/emailConfig.js` | Reads and validates the environment. Fails at boot, not at first send. |
| `emailService.js` | Transport, template rendering, retries, the four send functions. |
| `emailQueue.js` | Background queue so API handlers never wait on SMTP. |
| `logger.js` | One JSON line per event, with credentials redacted. |
| `templates/*.html` | Responsive Handlebars templates. |
| `../../server/emailWorker.js` | Outbox worker factory (pure, dependency-injected — see below). |
| `../../server/runEmailWorker.js` | Process entry point: real Supabase client, graceful shutdown. |

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`. Two ways to authenticate:

- **OAuth2 (production).** Set `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` and
  `OAUTH_REFRESH_TOKEN` together. The service picks OAuth2 automatically.
- **App password (testing).** Leave the OAuth variables empty and set
  `EMAIL_PASS` to a Google App Password.

Setting only some of the OAuth variables is rejected, so a half-finished
rotation cannot silently fall back to a password.

### Getting real OAuth2 credentials

This requires signing in to the Google account that owns
`customer@siddhayogaweb.com`, so it can't be scripted end-to-end — do this
once, by hand:

1. **Create a Cloud project.** [console.cloud.google.com](https://console.cloud.google.com) →
   create a project (e.g. "SWG Email Service"). If `siddhayogaweb.com` is a
   Google Workspace domain and you're signed in as an admin, create it
   *inside that org* rather than a personal account — this matters in step 3.
2. **Enable the Gmail API.** APIs & Services → Library → search "Gmail API" → Enable.
3. **Configure the OAuth consent screen.** APIs & Services → OAuth consent screen.
   - If the project lives inside the `siddhayogaweb.com` Workspace org, choose
     **Internal**. The refresh token you get in step 5 then never expires.
   - Otherwise you're stuck with **External** + **Testing** mode, and Google
     expires refresh tokens minted this way after **7 days** unless the app
     goes through verification. Fine for a first test, not for production —
     flag this to Kfir if it's the only option.
4. **Create the OAuth client.** APIs & Services → Credentials → Create
   Credentials → OAuth client ID → Application type **Desktop app**. Copy the
   Client ID and Client secret into `.env` as `OAUTH_CLIENT_ID` /
   `OAUTH_CLIENT_SECRET`.
5. **Mint the refresh token.** Run the helper script and follow its prompts:
   ```bash
   node scripts/get-oauth-refresh-token.js
   ```
   It opens a consent URL for you to visit as `customer@siddhayogaweb.com`,
   catches the redirect on a local port, and prints the line to add to
   `.env`: `OAUTH_REFRESH_TOKEN=...`.
6. **Verify it actually works.**
   ```bash
   node test-email.js --to customer@siddhayogaweb.com
   ```
   Without `--dry-run`, this opens a real connection and sends five real
   emails. `Verify transport` is the step that proves the OAuth2 credentials
   are valid; if it fails, re-check steps 3-5 rather than the code.

## Running the smoke test

Render everything without opening a connection:

```bash
node test-email.js --dry-run
```

Add `--save email-previews` to also write each rendered template to disk, then
open the files in a browser to check them.

Send for real to one address:

```bash
node test-email.js --to you@siddhayogaweb.com
```

The run covers transport verification, all four templates, a three-job queue
drain and a validation rejection. It exits non-zero if any step fails.

## The outbox worker (how the CRM triggers a send without a secret in the browser)

`swg_crm.html` only ever holds the Supabase **anon** key — that's already a
known, accepted exposure (see the comment in `20260831120000_init_schema.sql`).
Giving the browser a second secret to call an email API directly would repeat
that problem for something more sensitive: Gmail credentials.

Instead, anything that wants to trigger an email — the CRM, a future
storefront webhook — just inserts a row into `email_outbox` (migration
`20260902090000_email_outbox.sql`) using the anon key it already has:

```js
await sb.from('email_outbox').insert({
  id: uid(),
  created_at: Date.now(),
  type: 'shippingUpdate', // orderConfirmation | shippingUpdate | internalAlert | autoReply
  payload: { to, customerName, orderNumber, trackingNumber, carrierName, trackingUrl },
  status: 'queued',
  related_type: 'orders',
  related_id: order.id,
});
```

A separate trusted process — the worker — holds the real secrets (Gmail
OAuth2, and the Supabase **service role** key, which bypasses RLS) and is the
only thing that ever calls Gmail:

```bash
node src/server/runEmailWorker.js
```

It polls `email_outbox` for `status = 'queued'` rows (every
`EMAIL_WORKER_POLL_MS`, default 4s), claims a batch with a compare-and-swap
update so two worker instances never double-send the same row, sends each
through the same `emailService.js` functions the rest of this README
describes, and writes the outcome to both `email_outbox.status` and
`email_log` — satisfying the delivery log in one place.

`createEmailWorker()` in `emailWorker.js` takes its Supabase client as an
argument rather than importing one, so the claim/process/log logic can be
tested against an in-memory fake without a live project or real credentials.

**Running it long-term** is a deployment decision, not a code one — this repo
only provides the process. `node src/server/runEmailWorker.js` under `pm2` or
as a small container works anywhere Node runs; it needs `SUPABASE_URL`,
`SUPABASE_SERVICE_ROLE_KEY`, and the OAuth2/SMTP variables from `.env`.

## Use from application code

Fire and forget, which is what a request handler should do:

```js
import { queueEmail } from './src/services/email/emailQueue.js';

queueEmail('orderConfirmation', {
  to: order.customer_email,
  customerName: order.customer_name,
  orderNumber: order.order_number,
  items: order.items,
  totalAmount: order.total,
  shippingAddress: order.shipping_address,
});
```

Await the result when the caller needs to know the outcome:

```js
import { sendShippingUpdate } from './src/services/email/emailService.js';

const result = await sendShippingUpdate({ to, customerName, orderNumber, trackingNumber, carrierName, trackingUrl });
console.log(result.messageId, result.attempts);
```

Call `verifyConnection()` once at boot to fail fast on bad credentials, and
`emailQueue.onIdle()` before exit so nothing is dropped mid-flight.

## Behaviour worth knowing

- **Retries.** Up to `EMAIL_MAX_ATTEMPTS` (default 3) with exponential backoff
  and full jitter. A 5xx SMTP reply is permanent and is not retried.
- **Validation.** Bad arguments raise `EmailValidationError` before any
  connection is opened, so they never burn a retry.
- **Direction.** Templates use `dir="auto"` with `unicode-bidi: plaintext`, so
  Hebrew and English render correctly in the same message.
- **Logging.** Every send emits `email.sent` or `email.failed` carrying
  `messageId`, `recipient`, `status` and `attempts`. The `email_log` table
  (see `supabase/migrations`) mirrors those fields, and the Emails section of
  the CRM reads it.
