// ============================================================
// EMAIL OUTBOX WORKER (Supabase Edge Function)
//
// The production sender. Drains `email_outbox`, sends through Gmail over
// SMTP, and records the outcome in `email_outbox` + `email_log`.
//
// This replaces running src/server/runEmailWorker.js on a server of our
// own. An Edge Function cannot poll forever, so instead of a loop it is
// woken up:
//
//   1. A database webhook on INSERT into email_outbox -> near-instant.
//   2. A pg_cron sweep every few minutes -> catches anything the webhook
//      missed, plus rows left stuck in 'processing' by a crashed run.
//
// Either way it does the same thing: claim what is queued, send it, record
// what happened. Claiming is a compare-and-swap, so a webhook and a sweep
// firing at the same moment cannot double-send the same row.
//
// The templates and the locale logic are generated from src/services/email
// by scripts/sync-edge-email.js -- edit them there, not here.
// ============================================================
import { createClient } from 'npm:@supabase/supabase-js@2';
import nodemailer from 'npm:nodemailer@6.9.14';
import Handlebars from 'npm:handlebars@4.7.8';

import { TEMPLATES } from './_templates.ts';
// @ts-ignore -- plain JS module, shared verbatim with the Node service.
import { copyFor, formatAmountFor, formatDateFor, resolveLocale } from './_i18n.js';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const EMAIL_HOST = Deno.env.get('EMAIL_HOST') ?? 'smtp.gmail.com';
const EMAIL_PORT = Number(Deno.env.get('EMAIL_PORT') ?? '465');
const EMAIL_USER = Deno.env.get('EMAIL_USER') ?? 'customer@siddhayogaweb.com';
const EMAIL_PASS = Deno.env.get('EMAIL_PASS')!;
const EMAIL_FROM_NAME = Deno.env.get('EMAIL_FROM_NAME') ?? 'Siddha Yoga Web Services';
const EMAIL_REPLY_TO = Deno.env.get('EMAIL_REPLY_TO') ?? EMAIL_USER;
const INTERNAL_RECIPIENTS = (Deno.env.get('EMAIL_INTERNAL_RECIPIENTS') ?? 'ariel@siddhayogaweb.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TEAM_LOCALE = Deno.env.get('EMAIL_TEAM_LOCALE') ?? 'en';
const MAX_ATTEMPTS = Number(Deno.env.get('EMAIL_MAX_ATTEMPTS') ?? '3');
const BATCH_SIZE = Number(Deno.env.get('EMAIL_WORKER_BATCH_SIZE') ?? '10');

const WEBSITE_URL = 'https://siddhayogaweb.com';
const SUPPORT_EMAIL = 'customer@siddhayogaweb.com';
const FROM = `${EMAIL_FROM_NAME} <${EMAIL_USER}>`;

/** Maps an outbox `type` to the `category` recorded in email_log. */
const CATEGORY_BY_TYPE: Record<string, string> = {
  orderConfirmation: 'order_confirmation',
  shippingUpdate: 'shipping_update',
  internalAlert: 'internal_alert',
  autoReply: 'auto_reply',
};

/** Rows left claimed for longer than this are treated as abandoned. */
const STUCK_AFTER_MS = 5 * 60 * 1000;

const transport = nodemailer.createTransport({
  host: EMAIL_HOST,
  port: EMAIL_PORT,
  secure: EMAIL_PORT === 465,
  auth: { user: EMAIL_USER, pass: EMAIL_PASS },
});

const sb = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

/** One structured log line, matching the Node service's format. */
function log(level: string, msg: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, service: 'email-worker', msg, ...fields }));
}

const compiled = new Map<string, HandlebarsTemplateDelegate>();

/**
 * Renders a template with the locale's brand context merged in. Mirrors
 * renderTemplate() in the Node service so both produce identical output.
 */
function render(name: string, data: Record<string, unknown>): string {
  if (!compiled.has(name)) {
    const src = TEMPLATES[name];
    if (!src) throw new Error(`Unknown template "${name}"`);
    compiled.set(name, Handlebars.compile(src));
  }
  const locale = (data.locale as string) || 'en';
  const copy = copyFor(locale);
  return compiled.get(name)!({
    lang: locale,
    dir: copy.dir,
    align: copy.align,
    alignOpposite: copy.alignOpposite,
    brandName: 'Siddha Yoga Web Services',
    brandTagline: copy.brandTagline,
    supportEmail: SUPPORT_EMAIL,
    websiteUrl: WEBSITE_URL,
    websiteLabel: 'siddhayogaweb.com',
    greeting: copy.greeting,
    footerNote: copy.footerNote,
    transactionalNotice: copy.transactionalNotice,
    ...data,
  });
}

/** Readable plain-text alternative, same rules as the Node service. */
function htmlToText(html: string): string {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h1|h2|h3|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&middot;/gi, '-').replace(/&times;/gi, 'x')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#847;|&zwnj;/gi, '')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n').map((l) => l.trim()).join('\n').trim();
}

/**
 * Formats an optional money field, empty when there is nothing to show, so
 * the template's {{#if}} omits the whole row instead of printing 0.00.
 */
function money(amount: unknown, currency: string, locale: string): string {
  if (amount === null || amount === undefined || amount === '') return '';
  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0) return '';
  return formatAmountFor(value, currency, locale);
}

function formatAddress(address: unknown): string {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();
  const a = address as Record<string, unknown>;
  return [a.line1, a.line2, [a.city, a.state].filter(Boolean).join(' '), a.postal_code ?? a.postalCode, a.country]
    .map((p) => (p == null ? '' : String(p).trim())).filter(Boolean).join(', ');
}

function normaliseItem(item: Record<string, any>, currency: string, locale: string) {
  const quantity = Number(item.quantity ?? item.qty ?? 1) || 1;
  const unit = Number(item.unit_price ?? item.unitPrice ?? item.price ?? 0);
  const subtotal = item.subtotal ?? item.lineTotal ?? unit * quantity;
  return {
    name: String(item.product_name ?? item.name ?? item.title ?? 'Item'),
    variant: [item.size, item.color, item.variant].filter(Boolean).join(' / '),
    quantity,
    lineTotal: formatAmountFor(subtotal, currency, locale),
  };
}

/**
 * Turns an outbox row's payload into a ready-to-send message. Kept in step
 * with the four send functions in the Node service.
 */
function buildMessage(type: string, p: Record<string, any>) {
  if (type === 'orderConfirmation') {
    const { locale, reason } = resolveLocale({
      language: p.language, customerName: p.customerName, shippingAddress: p.shippingAddress, phone: p.phone,
    });
    const t = copyFor(locale).orderConfirmation;
    const currency = p.currency || 'ILS';
    return {
      locale, reason, to: p.to, subject: t.subject(p.orderNumber), template: 'orderConfirmation',
      data: {
        locale, preheader: t.preheader(p.orderNumber), headline: t.headline, intro: t.intro,
        customerName: p.customerName, orderNumber: p.orderNumber,
        orderDate: p.orderDate || formatDateFor(new Date(), locale),
        items: (p.items || []).map((i: any) => normaliseItem(i, currency, locale)),
        // Only rendered when the order carries them, so a plain order shows
        // just items and a total. Without these the customer sees an item at
        // 148 and a total of 183 with the shipping unexplained.
        subtotalAmount: money(p.subtotal, currency, locale),
        shippingAmount: money(p.shippingCost, currency, locale),
        discountAmountText: p.discountAmount
          ? '-' + formatAmountFor(Math.abs(Number(p.discountAmount)), currency, locale)
          : '',
        taxAmountText: money(p.taxAmount, currency, locale),
        totalAmount: formatAmountFor(p.totalAmount, currency, locale),
        shippingAddress: formatAddress(p.shippingAddress),
        ctaUrl: p.ctaUrl || '', ctaLabel: t.ctaLabel, labels: t.labels,
      },
    };
  }

  if (type === 'shippingUpdate') {
    const { locale, reason } = resolveLocale({
      language: p.language, customerName: p.customerName, shippingAddress: p.shippingAddress, phone: p.phone,
    });
    const t = copyFor(locale).shippingUpdate;
    return {
      locale, reason, to: p.to, subject: t.subject(p.orderNumber), template: 'shippingUpdate',
      data: {
        locale, preheader: t.preheader(p.trackingNumber, p.carrierName),
        statusLabel: t.statusLabel, headline: t.headline, intro: t.intro,
        customerName: p.customerName, orderNumber: p.orderNumber,
        trackingNumber: p.trackingNumber, carrierName: p.carrierName,
        trackingUrl: p.trackingUrl || '', estimatedDelivery: p.estimatedDelivery || '',
        ctaLabel: t.ctaLabel, labels: t.labels,
      },
    };
  }

  if (type === 'autoReply') {
    const { locale, reason } = resolveLocale({ language: p.language, customerName: p.customerName, phone: p.phone });
    const t = copyFor(locale).autoReply;
    return {
      locale, reason, to: p.to, subject: t.subject(p.ticketId), template: 'autoReply',
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
      data: {
        locale, preheader: t.preheader(p.ticketId), headline: t.headline, intro: t.intro,
        customerName: p.customerName, ticketId: p.ticketId,
        responseTimeNote: p.responseTimeNote || t.responseTimeNote, labels: t.labels,
      },
    };
  }

  if (type === 'internalAlert') {
    const { locale, reason } = resolveLocale({ language: p.language, fallback: TEAM_LOCALE });
    const t = copyFor(locale).internalAlert;
    const palette: Record<string, { color: string; bg: string }> = {
      low: { color: '#7a7462', bg: '#e9e3d3' }, normal: { color: '#5b6b4c', bg: '#e1e6d5' },
      high: { color: '#b98a2e', bg: '#f1e3c4' }, critical: { color: '#a6472b', bg: '#f0ddd5' },
    };
    const tone = palette[p.priority] || palette.normal;
    const priorityLabel = t.priority[p.priority as string] || t.priority.normal;
    return {
      locale, reason,
      to: p.to || INTERNAL_RECIPIENTS,
      subject: `[${t.subjectPrefix} ${priorityLabel}] ${p.subject}`,
      template: 'internalAlert',
      headers: { 'X-SWG-Priority': String(p.priority || 'normal') },
      data: {
        locale, preheader: String(p.message || '').slice(0, 120),
        alertKind: p.alertKind || t.alertKind, alertTitle: p.subject, message: p.message,
        payloadRows: Object.entries(p.payloadData || {}).map(([key, value]) => ({
          key, value: value == null ? '-' : typeof value === 'object' ? JSON.stringify(value) : String(value),
        })),
        priorityLabel, priorityColor: tone.color, priorityBg: tone.bg,
        ctaUrl: p.ctaUrl || '', ctaLabel: p.ctaLabel || t.ctaLabel,
        generatedAt: new Date().toISOString(), internalNotice: t.internalNotice, labels: t.labels,
      },
    };
  }

  throw new Error(`Unknown job type "${type}"`);
}

/** Best-effort recipient for the log, even when a row is malformed. */
function logRecipient(row: Record<string, any>): string {
  const to = row.payload?.to;
  if (Array.isArray(to)) return to.join(', ');
  if (to) return String(to);
  return row.type === 'internalAlert' ? '(configured internal recipients)' : '(unknown)';
}

async function writeLog(row: Record<string, any>, outcome: Record<string, any>) {
  try {
    const { error } = await sb.from('email_log').insert({
      id: crypto.randomUUID(), created_at: Date.now(),
      correlation_id: outcome.correlationId ?? null, message_id: outcome.messageId ?? null,
      category: CATEGORY_BY_TYPE[row.type] ?? row.type, template: row.type,
      recipient: outcome.recipient, subject: outcome.subject ?? null, status: outcome.status,
      attempts: outcome.attempts ?? row.attempts ?? 1, duration_ms: outcome.durationMs ?? null,
      reason: outcome.reason ?? null, related_type: row.related_type ?? null, related_id: row.related_id ?? null,
    });
    if (error) log('error', 'log_write_failed', { jobId: row.id, reason: error.message });
  } catch (e) {
    log('error', 'log_write_failed', { jobId: row.id, reason: String(e) });
  }
}

/** Sends one claimed row and records the outcome. Never throws. */
async function processRow(row: Record<string, any>) {
  const startedAt = Date.now();
  const correlationId = crypto.randomUUID();
  try {
    const built = buildMessage(row.type, row.payload || {});
    const html = render(built.template, built.data);
    const recipients = Array.isArray(built.to) ? built.to : [built.to];

    const info = await transport.sendMail({
      from: FROM,
      to: recipients.join(', '),
      subject: built.subject,
      html,
      text: htmlToText(html),
      replyTo: EMAIL_REPLY_TO,
      headers: {
        'X-SWG-Category': CATEGORY_BY_TYPE[row.type] ?? row.type,
        'X-SWG-Correlation-Id': correlationId,
        'Content-Language': built.locale,
        ...(built.headers || {}),
      },
    });

    const durationMs = Date.now() - startedAt;
    await sb.from('email_outbox')
      .update({ status: 'sent', attempts: (row.attempts || 0) + 1, sent_at: Date.now(), last_error: null })
      .eq('id', row.id);
    await writeLog(row, {
      status: 'sent', recipient: recipients[0], messageId: info.messageId, correlationId,
      subject: built.subject, attempts: (row.attempts || 0) + 1, durationMs,
    });
    log('info', 'job_sent', {
      jobId: row.id, type: row.type, locale: built.locale, localeReason: built.reason,
      messageId: info.messageId, recipient: recipients[0], durationMs,
    });
  } catch (error) {
    const attempts = (row.attempts || 0) + 1;
    const message = error instanceof Error ? error.message : String(error);
    // Give up only once the attempts are spent; otherwise put it back in the
    // queue so the next webhook or sweep retries it.
    const exhausted = attempts >= MAX_ATTEMPTS;
    await sb.from('email_outbox')
      .update({ status: exhausted ? 'failed' : 'queued', attempts, last_error: message, claimed_by: null, claimed_at: null })
      .eq('id', row.id);
    await writeLog(row, {
      status: exhausted ? 'failed' : 'retrying', recipient: logRecipient(row),
      attempts, reason: message, correlationId, durationMs: Date.now() - startedAt,
    });
    log('error', exhausted ? 'job_failed' : 'job_retrying', { jobId: row.id, type: row.type, attempts, reason: message });
  }
}

/**
 * Claims up to `limit` queued rows with a compare-and-swap, so two
 * concurrent invocations never win the same row.
 */
async function claimBatch(workerId: string, limit: number) {
  // Release anything a previous run claimed and never finished.
  await sb.from('email_outbox')
    .update({ status: 'queued', claimed_by: null, claimed_at: null })
    .eq('status', 'processing')
    .lt('claimed_at', Date.now() - STUCK_AFTER_MS);

  const { data: candidates, error } = await sb.from('email_outbox')
    .select('*').eq('status', 'queued').order('created_at', { ascending: true }).limit(limit);
  if (error) {
    log('error', 'claim_query_failed', { reason: error.message });
    return [];
  }

  const claimed: Record<string, any>[] = [];
  for (const row of candidates ?? []) {
    const { data: updated } = await sb.from('email_outbox')
      .update({ status: 'processing', claimed_at: Date.now(), claimed_by: workerId })
      .eq('id', row.id).eq('status', 'queued').select();
    if (updated && updated.length) claimed.push(row);
  }
  return claimed;
}

Deno.serve(async (req) => {
  // ?diag=1 reports what the function can see, so a misconfigured deploy can
  // be diagnosed without shipping secrets anywhere. Reports presence and
  // error text only -- never a secret's value.
  if (new URL(req.url).searchParams.get('diag') === '1') {
    const probe = await sb.from('email_outbox').select('id,status').eq('status', 'queued').limit(5);
    return Response.json({
      env: {
        SUPABASE_URL: Boolean(SUPABASE_URL),
        SUPABASE_SERVICE_ROLE_KEY: Boolean(SERVICE_ROLE_KEY),
        EMAIL_PASS: Boolean(EMAIL_PASS),
        EMAIL_USER,
        EMAIL_HOST,
      },
      queuedProbe: { error: probe.error?.message ?? null, count: probe.data?.length ?? null },
      templates: Object.keys(TEMPLATES),
    });
  }

  if (!EMAIL_PASS) {
    return Response.json({ error: 'EMAIL_PASS secret is not set' }, { status: 500 });
  }

  const workerId = 'edge-' + crypto.randomUUID().slice(0, 8);
  // The body is ignored on purpose. A database webhook tells us a row was
  // inserted, a cron sweep tells us nothing at all -- either way the job is
  // the same: drain whatever is queued right now.
  await req.text().catch(() => '');

  const rows = await claimBatch(workerId, BATCH_SIZE);
  if (!rows.length) {
    log('info', 'nothing_queued', { workerId });
    return Response.json({ processed: 0 });
  }

  for (const row of rows) await processRow(row);

  log('info', 'drained', { workerId, processed: rows.length });
  return Response.json({ processed: rows.length });
});
