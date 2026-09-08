// ============================================================
// STOREFRONT ORDER RECEIVER
// Public webhook target for storefronts (starting with the Siddha Yoga
// Base44 store's orderNotification function). Verifies a shared secret,
// finds-or-creates the matching Contact + Customer by email, and
// inserts/updates the Order -- keyed on (source, external order number)
// so a retried delivery updates the same row instead of duplicating it.
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const WEBHOOK_SECRET = Deno.env.get('STOREFRONT_WEBHOOK_SECRET');

function uid() {
  return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function mapStatus(base44Status) {
  if (base44Status === 'shipped') return 'Shipped';
  if (base44Status === 'delivered') return 'Delivered';
  if (base44Status === 'cancelled' || base44Status === 'refunded') return 'Cancelled';
  return 'Pending'; // pending / confirmed / processing
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
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

  const order = payload.data || payload;
  const source = payload.source || 'Website';
  const email = (order.customer_email || '').toLowerCase().trim();
  if (!email) return json({ error: 'missing customer_email' }, 400);

  const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let { data: contact } = await sb.from('contacts').select('*').ilike('email', email).eq('type', 'Customer').maybeSingle();
  if (!contact) {
    contact = {
      id: uid(), created_at: Date.now(), owner: 'Website',
      name: order.customer_name || email, kind: 'Individual', company: '',
      type: 'Customer', email, phone: order.customer_phone || '', notes: '',
    };
    const { error } = await sb.from('contacts').insert(contact);
    if (error) return json({ error: 'contact insert failed: ' + error.message }, 500);
  }

  const { data: existingCustomer } = await sb.from('customers').select('id').ilike('email', email).maybeSingle();
  if (!existingCustomer) {
    const { error } = await sb.from('customers').insert({
      id: uid(), created_at: Date.now(), owner: 'Website',
      name: order.customer_name || email, kind: 'Individual', company: '',
      email, phone: order.customer_phone || '',
      country: order.shipping_address?.country || '', city: order.shipping_address?.city || '',
      address: order.shipping_address?.line1 || '', notes: '', source,
    });
    if (error) return json({ error: 'customer insert failed: ' + error.message }, 500);
  }

  const orderFields = {
    contact_id: contact.id,
    product: (order.items || []).map((i) => i.product_name).filter(Boolean).join(', ') || 'Order',
    qty: (order.items || []).reduce((s, i) => s + (Number(i.quantity) || 0), 0) || 1,
    amount: Number(order.total) || 0,
    currencies: order.currency ? [order.currency] : [],
    status: mapStatus(order.status),
    source,
    external_order_number: order.order_number || null,
    payment_status: order.payment_status || null,
    payment_provider: order.payment_provider || null,
    payment_reference: order.payment_reference || null,
    shipping_address: order.shipping_address || null,
    items: order.items || [],
    currency: order.currency || null,
  };

  let existingOrder = null;
  if (order.order_number) {
    const { data } = await sb.from('orders').select('id').eq('source', source).eq('external_order_number', order.order_number).maybeSingle();
    existingOrder = data;
  }

  if (existingOrder) {
    const { error } = await sb.from('orders').update(orderFields).eq('id', existingOrder.id);
    if (error) return json({ error: 'order update failed: ' + error.message }, 500);
    return json({ success: true, orderId: existingOrder.id, action: 'updated' });
  } else {
    const newOrder = { id: uid(), created_at: Date.now(), owner: 'Website', ...orderFields };
    const { error } = await sb.from('orders').insert(newOrder);
    if (error) return json({ error: 'order insert failed: ' + error.message }, 500);
    const queued = await queueOrderConfirmation(sb, order, newOrder, email);
    return json({ success: true, orderId: newOrder.id, action: 'created', confirmationQueued: queued });
  }
});

/**
 * Queues the customer's order confirmation.
 *
 * Only on a newly created order -- a retried webhook delivery updates the
 * existing row instead, and must not email the customer twice.
 *
 * Note this is the customer's first and only confirmation: the storefront's
 * own orderNotification function emails the business, and
 * getOrderConfirmation is just an API for the thank-you page. Before this,
 * a customer who ordered received nothing at all.
 *
 * Queuing is best-effort by design. A failure here is logged and swallowed
 * so it can never reject an order that was already saved -- the same reason
 * the storefront wraps its own CRM sync in a try/catch.
 */
async function queueOrderConfirmation(sb, order, newOrder, email) {
  // Someone whose payment outright failed has not placed an order worth
  // confirming. Everything else -- unpaid, pending, paid -- gets the
  // "we have your order" message a checkout is expected to produce.
  if (order.payment_status === 'failed') return false;

  try {
    const { error } = await sb.from('email_outbox').insert({
      id: uid(),
      created_at: Date.now(),
      type: 'orderConfirmation',
      status: 'queued',
      related_type: 'orders',
      related_id: newOrder.id,
      payload: {
        to: email,
        customerName: order.customer_name || email,
        orderNumber: order.order_number || newOrder.id,
        items: order.items || [],
        totalAmount: Number(order.total) || 0,
        currency: order.currency || 'ILS',
        shippingAddress: order.shipping_address || null,
        phone: order.customer_phone || '',
      },
    });
    if (error) {
      console.error('order confirmation queue failed', error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error('order confirmation queue threw', e);
    return false;
  }
}
