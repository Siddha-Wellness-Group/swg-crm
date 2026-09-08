// ============================================================
// STOREFRONT CONTACT RECEIVER
//
// Public webhook target for the storefront's contact form. Mirrors
// storefront-order: verifies the shared secret, finds-or-creates the
// Contact by email, and inserts/updates a ticket keyed on
// (source, external id) so a retried delivery updates the same row.
//
// It then queues two emails on a new ticket:
//   - autoReply    -> the customer, so they know it arrived
//   - internalAlert -> the team, so somebody actually knows it exists
//
// Both were missing entirely. src/pages/Contact.jsx on the storefront does
// one thing with a submission -- ContactMessage.create(form) -- so until
// now a customer who wrote in got no acknowledgement and no one was told.
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const WEBHOOK_SECRET = Deno.env.get('STOREFRONT_WEBHOOK_SECRET');

function uid() {
  return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Short reference the customer can quote back. */
function ticketNumber(id: string) {
  return 'TCK-' + id.slice(-6).toUpperCase();
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  if (req.headers.get('x-webhook-secret') !== WEBHOOK_SECRET) {
    return json({ error: 'unauthorized' }, 401);
  }

  let payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const msg = payload.data || payload;
  const source = payload.source || 'Website';
  const email = String(msg.email || '').toLowerCase().trim();
  const name = String(msg.name || '').trim() || email;
  const body = String(msg.message || '').trim();

  if (!email) return json({ error: 'missing email' }, 400);
  if (!body) return json({ error: 'missing message' }, 400);

  const sb = createClient(SUPABASE_URL!, SERVICE_ROLE_KEY!);

  // Link to the ledger when we already know this person, so a ticket sits
  // against their history rather than floating free.
  let { data: contact } = await sb.from('contacts').select('*').ilike('email', email).maybeSingle();
  if (!contact) {
    contact = {
      id: uid(), created_at: Date.now(), owner: 'Website',
      name, kind: 'Individual', company: '', type: 'Customer',
      email, phone: msg.phone || '', notes: 'Created from a website enquiry',
    };
    const { error } = await sb.from('contacts').insert(contact);
    if (error) return json({ error: 'contact insert failed: ' + error.message }, 500);
  }

  // Existing ticket for this submission? Then this is a retry, not a new one.
  let existing = null;
  if (msg.id) {
    const { data } = await sb.from('tickets').select('id,ticket_number')
      .eq('source', source).eq('external_id', String(msg.id)).maybeSingle();
    existing = data;
  }

  const fields = {
    contact_id: contact.id,
    name,
    email,
    phone: msg.phone || null,
    subject: msg.subject || null,
    message: body,
    status: msg.status === 'replied' ? 'resolved' : msg.status === 'read' ? 'open' : 'new',
    source,
    external_id: msg.id ? String(msg.id) : null,
  };

  if (existing) {
    const { error } = await sb.from('tickets').update(fields).eq('id', existing.id);
    if (error) return json({ error: 'ticket update failed: ' + error.message }, 500);
    return json({ success: true, ticketId: existing.id, action: 'updated', emailsQueued: false });
  }

  const id = uid();
  const number = ticketNumber(id);
  const { error } = await sb.from('tickets').insert({
    id, created_at: Date.now(), owner: 'Website', ticket_number: number, ...fields,
  });
  if (error) return json({ error: 'ticket insert failed: ' + error.message }, 500);

  const queued = await queueTicketEmails(sb, { id, number, name, email, body, phone: msg.phone || '' });
  return json({ success: true, ticketId: id, ticketNumber: number, action: 'created', emailsQueued: queued });
});

/**
 * Queues the customer's acknowledgement and the team's heads-up.
 *
 * Best-effort by design: a queuing failure is logged and swallowed rather
 * than rejecting an enquiry that has already been saved. Losing the ticket
 * would be worse than losing the email, and the ticket is safe by this
 * point.
 */
async function queueTicketEmails(
  sb: ReturnType<typeof createClient>,
  t: { id: string; number: string; name: string; email: string; body: string; phone: string },
) {
  const rows = [
    {
      id: uid(), created_at: Date.now(), type: 'autoReply', status: 'queued',
      related_type: 'tickets', related_id: t.id,
      payload: { to: t.email, customerName: t.name, ticketId: t.number, phone: t.phone },
    },
    {
      id: uid(), created_at: Date.now() + 1, type: 'internalAlert', status: 'queued',
      related_type: 'tickets', related_id: t.id,
      payload: {
        subject: `New enquiry ${t.number} from ${t.name}`,
        message: t.body,
        payloadData: { ticket: t.number, from: t.name, email: t.email, phone: t.phone || '-', source: 'Website contact form' },
        priority: 'normal',
        alertKind: 'Customer enquiry',
      },
    },
  ];

  try {
    const { error } = await sb.from('email_outbox').insert(rows);
    if (error) {
      console.error('ticket email queue failed', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error('ticket email queue threw', e);
    return false;
  }
}
