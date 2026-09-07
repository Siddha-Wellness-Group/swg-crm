/**
 * @file Automated transactional email service for the SWG CRM.
 *
 * One nodemailer transport, one Handlebars template cache, and four public
 * send functions. Every send is validated before a connection is opened,
 * retried with exponential backoff on transient failures, and logged as a
 * structured record carrying the messageId, recipient and status.
 *
 * All customer-facing mail leaves as
 * `Siddha Yoga Web Services <customer@siddhayogaweb.com>`.
 *
 * @module services/email/emailService
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

import Handlebars from 'handlebars';
import nodemailer from 'nodemailer';

import { getEmailConfig, isValidEmail } from '../../config/emailConfig.js';
import { logger } from './logger.js';

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

/** Public site shown in every customer-facing footer. */
const WEBSITE_URL = 'https://siddhayogaweb.com';

/** Support mailbox quoted in every footer. */
const SUPPORT_EMAIL = 'customer@siddhayogaweb.com';

/**
 * The footer line the business requires on every customer-facing message.
 * Kept as a single exported constant so wording changes happen in one place.
 */
export const FOOTER_NOTE_HE =
  'אם יש לך שאלות נוספות, ניתן להשיב למייל זה או ליצור קשר בכתובת customer@siddhayogaweb.com';

/** English companion to {@link FOOTER_NOTE_HE}. */
export const FOOTER_NOTE_EN =
  'If you have any further questions, simply reply to this email or write to us at customer@siddhayogaweb.com.';

/**
 * Thrown when caller-supplied arguments cannot produce a valid message.
 * Distinct from a transport failure: these are never retried.
 */
export class EmailValidationError extends Error {
  /**
   * @param {string[]} issues - Human-readable description of each problem found.
   */
  constructor(issues) {
    super('Invalid email request:\n  - ' + issues.join('\n  - '));
    this.name = 'EmailValidationError';
    /** @type {string[]} */
    this.issues = issues;
  }
}

/**
 * Thrown when every send attempt has been exhausted.
 */
export class EmailSendError extends Error {
  /**
   * @param {string} message - Summary of the failure.
   * @param {{attempts: number, cause?: unknown, template?: string, to?: string}} details - Failure context.
   */
  constructor(message, details) {
    super(message);
    this.name = 'EmailSendError';
    /** @type {number} */
    this.attempts = details.attempts;
    /** @type {unknown} */
    this.cause = details.cause;
    /** @type {string|undefined} */
    this.template = details.template;
    /** @type {string|undefined} */
    this.to = details.to;
  }
}

/* -------------------------------------------------------------------------- */
/* Template rendering                                                          */
/* -------------------------------------------------------------------------- */

/** @type {Map<string, HandlebarsTemplateDelegate>} */
const templateCache = new Map();

Handlebars.registerHelper('eq', (a, b) => a === b);

/**
 * Loads and compiles a template, caching the compiled function per process.
 *
 * @param {string} name - Template file name without the `.html` suffix.
 * @returns {Promise<HandlebarsTemplateDelegate>} The compiled template.
 * @throws {Error} When the template file cannot be read.
 */
async function loadTemplate(name) {
  const cached = templateCache.get(name);
  if (cached) return cached;

  const path = join(TEMPLATE_DIR, name + '.html');
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error('Email template "' + name + '" could not be read from ' + path, { cause });
  }

  const compiled = Handlebars.compile(source, { noEscape: false });
  templateCache.set(name, compiled);
  return compiled;
}

/**
 * Clears the compiled-template cache. Useful when editing templates in a
 * long-running dev process.
 *
 * @returns {void}
 */
export function clearTemplateCache() {
  templateCache.clear();
}

/**
 * Renders a template with the shared brand context merged in.
 *
 * @param {string} name - Template file name without the `.html` suffix.
 * @param {Record<string, unknown>} data - Template variables.
 * @returns {Promise<string>} The rendered HTML document.
 */
export async function renderTemplate(name, data) {
  const template = await loadTemplate(name);
  return template({
    lang: 'he',
    brandName: 'Siddha Yoga Web Services',
    brandTagline: 'Siddha Wellness Group',
    supportEmail: SUPPORT_EMAIL,
    websiteUrl: WEBSITE_URL,
    websiteLabel: 'siddhayogaweb.com',
    footerNoteHe: FOOTER_NOTE_HE,
    footerNoteEn: FOOTER_NOTE_EN,
    transactionalNotice:
      'This is a transactional message about your order or enquiry with Siddha Yoga Web Services.',
    ...data,
  });
}

/**
 * Produces a readable plain-text alternative from rendered HTML.
 * Good enough for the text/plain part of a multipart message; it is never the
 * primary rendering.
 *
 * @param {string} html - Rendered HTML document.
 * @returns {string} Collapsed plain text.
 */
export function htmlToText(html) {
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|h1|h2|h3|li)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&middot;/gi, '-')
    .replace(/&times;/gi, 'x')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#847;|&zwnj;/gi, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

/** @type {import('nodemailer').Transporter|null} */
let transporter = null;

/**
 * Returns the shared nodemailer transport, creating it on first use.
 *
 * Uses Google OAuth2 when the OAuth variables are configured, plain SMTP
 * authentication otherwise, and a local JSON transport in dry-run mode so
 * nothing leaves the process during testing.
 *
 * @returns {import('nodemailer').Transporter} The shared transport.
 */
export function getTransporter() {
  if (transporter) return transporter;

  const cfg = getEmailConfig();

  if (cfg.dryRun) {
    transporter = nodemailer.createTransport({ jsonTransport: true });
    logger.warn('transport.dry_run', { driver: 'json', from: cfg.from });
    return transporter;
  }

  /** @type {import('nodemailer').TransportOptions} */
  const options = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    pool: true,
    maxConnections: Math.max(1, cfg.queueConcurrency),
    maxMessages: 100,
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 30000,
  };

  options.auth =
    cfg.driver === 'oauth2'
      ? {
          type: 'OAuth2',
          user: cfg.user,
          clientId: cfg.oauth.clientId,
          clientSecret: cfg.oauth.clientSecret,
          refreshToken: cfg.oauth.refreshToken,
          accessUrl: cfg.oauth.accessUrl,
        }
      : { user: cfg.user, pass: cfg.pass };

  transporter = nodemailer.createTransport(options);
  logger.info('transport.created', {
    driver: cfg.driver,
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    from: cfg.from,
  });
  return transporter;
}

/**
 * Opens a connection and authenticates without sending anything.
 * Call it at boot to fail fast on bad credentials.
 *
 * @returns {Promise<boolean>} True when the transport is usable.
 * @throws {Error} When the transport cannot connect or authenticate.
 */
export async function verifyConnection() {
  const cfg = getEmailConfig();
  if (cfg.dryRun) {
    logger.info('transport.verify_skipped', { reason: 'dry_run' });
    return true;
  }
  await getTransporter().verify();
  logger.info('transport.verified', { driver: cfg.driver, host: cfg.host, user: cfg.user });
  return true;
}

/**
 * Closes the pooled transport so the process can exit cleanly.
 *
 * @returns {Promise<void>} Resolves once the pool is closed.
 */
export async function closeTransport() {
  if (!transporter) return;
  try {
    transporter.close();
  } finally {
    transporter = null;
    logger.info('transport.closed', {});
  }
}

/* -------------------------------------------------------------------------- */
/* Retry                                                                       */
/* -------------------------------------------------------------------------- */

/** SMTP reply codes and socket errors worth a second attempt. */
const RETRYABLE_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS', 'ETIMEOUT', 'EAI_AGAIN', 'EENVELOPE',
]);

/**
 * Decides whether a failed attempt should be retried.
 * Permanent rejections (a 5xx reply, a rejected recipient) are not retried.
 *
 * @param {any} error - The error thrown by the transport.
 * @returns {boolean} True when another attempt is worthwhile.
 */
function isRetryable(error) {
  if (!error) return false;
  if (error instanceof EmailValidationError) return false;
  const status = Number(error.responseCode);
  if (Number.isFinite(status) && status >= 500 && status < 600) return false;
  if (Number.isFinite(status) && status >= 400 && status < 500) return true;
  return RETRYABLE_CODES.has(error.code) || error.code === undefined;
}

/**
 * Sleeps for a number of milliseconds.
 *
 * @param {number} ms - Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */
/* Core send                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} SendResult
 * @property {boolean} accepted   Whether the transport accepted the message.
 * @property {string} messageId   RFC message id assigned by the transport.
 * @property {string} to          Primary recipient.
 * @property {string} subject     Final subject line.
 * @property {string} template    Template that produced the body.
 * @property {number} attempts    How many attempts were made.
 * @property {number} durationMs  Wall time across all attempts.
 * @property {boolean} dryRun     True when nothing actually left the process.
 * @property {string} correlationId Id shared by the log records for this send.
 */

/**
 * Renders a template and sends it, retrying transient failures with
 * exponential backoff and full jitter.
 *
 * @param {object} params - Message description.
 * @param {string|string[]} params.to - Recipient address or addresses.
 * @param {string} params.subject - Subject line.
 * @param {string} params.template - Template name without the `.html` suffix.
 * @param {Record<string, unknown>} [params.data] - Template variables.
 * @param {string} [params.replyTo] - Reply-To override.
 * @param {string|string[]} [params.cc] - Carbon copy recipients.
 * @param {string|string[]} [params.bcc] - Blind carbon copy recipients.
 * @param {Record<string, string>} [params.headers] - Extra SMTP headers.
 * @param {string} [params.category] - Label recorded in the logs, e.g. `order_confirmation`.
 * @returns {Promise<SendResult>} Result of the accepted send.
 * @throws {EmailValidationError} When arguments cannot produce a valid message.
 * @throws {EmailSendError} When every attempt failed.
 */
export async function sendTemplatedMail({
  to,
  subject,
  template,
  data = {},
  replyTo,
  cc,
  bcc,
  headers = {},
  category = 'generic',
}) {
  const cfg = getEmailConfig();
  const correlationId = randomUUID();

  /** @type {string[]} */
  const issues = [];
  const recipients = (Array.isArray(to) ? to : [to]).map((a) => String(a || '').trim()).filter(Boolean);
  if (!recipients.length) issues.push('At least one recipient is required.');
  recipients.filter((a) => !isValidEmail(a)).forEach((a) => issues.push('Recipient is not a valid address: "' + a + '"'));
  if (!subject || !String(subject).trim()) issues.push('A subject line is required.');
  if (!template || !String(template).trim()) issues.push('A template name is required.');
  if (issues.length) {
    logger.error('email.invalid', { correlationId, category, issues });
    throw new EmailValidationError(issues);
  }

  const html = await renderTemplate(template, { subject, ...data });
  const text = htmlToText(html);

  const message = {
    from: cfg.from,
    to: recipients.join(', '),
    subject: String(subject).trim(),
    html,
    text,
    replyTo: replyTo || cfg.replyTo,
    headers: {
      'X-SWG-Category': category,
      'X-SWG-Correlation-Id': correlationId,
      'X-Entity-Ref-ID': correlationId,
      ...headers,
    },
  };
  if (cc) message.cc = Array.isArray(cc) ? cc.join(', ') : cc;
  if (bcc) message.bcc = Array.isArray(bcc) ? bcc.join(', ') : bcc;

  const startedAt = Date.now();
  let lastError = null;

  for (let attempt = 1; attempt <= cfg.maxAttempts; attempt += 1) {
    try {
      const info = await getTransporter().sendMail(message);
      const result = {
        accepted: true,
        messageId: info.messageId || correlationId,
        to: recipients[0],
        subject: message.subject,
        template,
        attempts: attempt,
        durationMs: Date.now() - startedAt,
        dryRun: cfg.dryRun,
        correlationId,
      };
      logger.info('email.sent', {
        correlationId,
        category,
        template,
        messageId: result.messageId,
        recipient: result.to,
        recipients: recipients.length,
        status: cfg.dryRun ? 'dry-run' : 'sent',
        attempts: attempt,
        durationMs: result.durationMs,
      });
      return result;
    } catch (error) {
      lastError = error;
      const retryable = isRetryable(error) && attempt < cfg.maxAttempts;
      logger.warn('email.attempt_failed', {
        correlationId,
        category,
        template,
        recipient: recipients[0],
        status: 'failed',
        attempt,
        maxAttempts: cfg.maxAttempts,
        retrying: retryable,
        code: error && error.code,
        responseCode: error && error.responseCode,
        reason: error && error.message,
      });
      if (!retryable) break;

      // Exponential backoff with full jitter: base * 2^(attempt-1), randomised.
      const ceiling = cfg.retryBaseMs * Math.pow(2, attempt - 1);
      await sleep(Math.round(Math.random() * ceiling) + Math.round(ceiling / 2));
    }
  }

  logger.error('email.failed', {
    correlationId,
    category,
    template,
    recipient: recipients[0],
    status: 'failed',
    attempts: cfg.maxAttempts,
    durationMs: Date.now() - startedAt,
    reason: lastError && lastError.message,
  });

  throw new EmailSendError(
    'Failed to send "' + template + '" to ' + recipients[0] + ' after ' + cfg.maxAttempts + ' attempt(s): ' +
      (lastError && lastError.message ? lastError.message : 'unknown error'),
    { attempts: cfg.maxAttempts, cause: lastError, template, to: recipients[0] },
  );
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Formats an amount for display in a message body.
 * Accepts a number, or a pre-formatted string which is returned untouched.
 *
 * @param {number|string} amount - Amount to format.
 * @param {string} [currency] - ISO 4217 code.
 * @returns {string} A display string such as `₪249.00`.
 */
export function formatAmount(amount, currency = 'ILS') {
  if (typeof amount === 'string') return amount;
  const value = Number(amount);
  if (!Number.isFinite(value)) return String(amount ?? '');
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return value.toFixed(2) + ' ' + currency;
  }
}

/**
 * Flattens a shipping address object into a display string.
 *
 * @param {string|Record<string, unknown>|null|undefined} address - Address to format.
 * @returns {string} Newline-free display string, or an empty string.
 */
export function formatAddress(address) {
  if (!address) return '';
  if (typeof address === 'string') return address.trim();
  const { line1, line2, city, state, postal_code: postal, postalCode, country } = address;
  return [line1, line2, [city, state].filter(Boolean).join(' '), postal || postalCode, country]
    .map((part) => (part == null ? '' : String(part).trim()))
    .filter(Boolean)
    .join(', ');
}

/**
 * Normalises a mixed-shape line item into what the templates expect.
 *
 * @param {Record<string, any>} item - Raw item from an order record.
 * @param {string} currency - ISO 4217 code used for the money columns.
 * @returns {{name: string, variant: string, quantity: number, lineTotal: string}} Template-ready item.
 */
function normaliseItem(item, currency) {
  const quantity = Number(item.quantity ?? item.qty ?? 1) || 1;
  const unit = Number(item.unit_price ?? item.unitPrice ?? item.price ?? 0);
  const subtotal = item.subtotal ?? item.lineTotal ?? unit * quantity;
  return {
    name: String(item.product_name ?? item.name ?? item.title ?? 'Item'),
    variant: [item.size, item.color, item.variant].filter(Boolean).join(' / '),
    quantity,
    lineTotal: formatAmount(subtotal, currency),
  };
}

/* -------------------------------------------------------------------------- */
/* Public send functions                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Sends the order confirmation a customer receives immediately after checkout.
 *
 * @param {object} params - Order details.
 * @param {string} params.to - Customer email address.
 * @param {string} params.customerName - Name shown in the greeting.
 * @param {string} params.orderNumber - Human-readable order reference.
 * @param {Array<Record<string, any>>} params.items - Line items. Accepts the storefront `Order.items` shape.
 * @param {number|string} params.totalAmount - Order total.
 * @param {string|Record<string, unknown>} [params.shippingAddress] - Delivery address.
 * @param {string} [params.currency] - ISO 4217 code. Defaults to `ILS`.
 * @param {string} [params.orderDate] - Display date. Defaults to today.
 * @param {string} [params.ctaUrl] - Link behind the primary button.
 * @returns {Promise<SendResult>} Result of the accepted send.
 * @throws {EmailValidationError} When required order details are missing.
 * @throws {EmailSendError} When every attempt failed.
 *
 * @example
 * await sendOrderConfirmation({
 *   to: 'dana@example.com',
 *   customerName: 'דנה כהן',
 *   orderNumber: 'SY-10241',
 *   items: [{ product_name: 'Cinnamor Oregano 30ml', quantity: 2, unit_price: 89 }],
 *   totalAmount: 178,
 *   shippingAddress: { line1: 'הרצל 12', city: 'תל אביב', country: 'Israel' },
 * });
 */
export async function sendOrderConfirmation({
  to,
  customerName,
  orderNumber,
  items,
  totalAmount,
  shippingAddress,
  currency = 'ILS',
  orderDate,
  ctaUrl,
}) {
  /** @type {string[]} */
  const issues = [];
  if (!customerName || !String(customerName).trim()) issues.push('customerName is required.');
  if (!orderNumber || !String(orderNumber).trim()) issues.push('orderNumber is required.');
  if (!Array.isArray(items) || items.length === 0) issues.push('items must be a non-empty array.');
  if (totalAmount === undefined || totalAmount === null || totalAmount === '') {
    issues.push('totalAmount is required.');
  }
  if (issues.length) throw new EmailValidationError(issues);

  return sendTemplatedMail({
    to,
    subject: 'Order ' + orderNumber + ' confirmed | אישור הזמנה ' + orderNumber,
    template: 'orderConfirmation',
    category: 'order_confirmation',
    data: {
      preheader: 'We received order ' + orderNumber + '. Here is what is on the way.',
      headline: 'Thank you for your order',
      greeting: 'Hello',
      intro:
        'We have received your order and it is now being prepared. ' +
        'You will get a second email with tracking details the moment it ships.',
      customerName: String(customerName).trim(),
      orderNumber: String(orderNumber).trim(),
      orderDate: orderDate || new Date().toLocaleDateString('en-GB'),
      items: items.map((item) => normaliseItem(item, currency)),
      totalAmount: formatAmount(totalAmount, currency),
      shippingAddress: formatAddress(shippingAddress),
      ctaUrl: ctaUrl || '',
      ctaLabel: 'View your order',
      labels: {
        orderNumber: 'Order number',
        orderDate: 'Order date',
        items: 'What you ordered',
        total: 'Total',
        shippingTo: 'Shipping to',
      },
    },
  });
}

/**
 * Sends the tracking notification once an order leaves the warehouse.
 *
 * @param {object} params - Shipment details.
 * @param {string} params.to - Customer email address.
 * @param {string} params.customerName - Name shown in the greeting.
 * @param {string} params.orderNumber - Human-readable order reference.
 * @param {string} params.trackingNumber - Carrier tracking reference.
 * @param {string} params.carrierName - Carrier handling the shipment.
 * @param {string} [params.trackingUrl] - Direct link to the carrier tracking page.
 * @param {string} [params.estimatedDelivery] - Display date for the expected arrival.
 * @returns {Promise<SendResult>} Result of the accepted send.
 * @throws {EmailValidationError} When required shipment details are missing.
 * @throws {EmailSendError} When every attempt failed.
 *
 * @example
 * await sendShippingUpdate({
 *   to: 'dana@example.com',
 *   customerName: 'Dana',
 *   orderNumber: 'SY-10241',
 *   trackingNumber: 'IL123456789',
 *   carrierName: 'Israel Post',
 *   trackingUrl: 'https://israelpost.co.il/track/IL123456789',
 * });
 */
export async function sendShippingUpdate({
  to,
  customerName,
  orderNumber,
  trackingNumber,
  carrierName,
  trackingUrl,
  estimatedDelivery,
}) {
  /** @type {string[]} */
  const issues = [];
  if (!customerName || !String(customerName).trim()) issues.push('customerName is required.');
  if (!orderNumber || !String(orderNumber).trim()) issues.push('orderNumber is required.');
  if (!trackingNumber || !String(trackingNumber).trim()) issues.push('trackingNumber is required.');
  if (!carrierName || !String(carrierName).trim()) issues.push('carrierName is required.');
  if (trackingUrl && !/^https?:\/\//i.test(String(trackingUrl))) {
    issues.push('trackingUrl must be an absolute http(s) URL.');
  }
  if (issues.length) throw new EmailValidationError(issues);

  return sendTemplatedMail({
    to,
    subject: 'Order ' + orderNumber + ' is on its way | ההזמנה שלך נשלחה',
    template: 'shippingUpdate',
    category: 'shipping_update',
    data: {
      preheader: 'Tracking ' + trackingNumber + ' with ' + carrierName + '.',
      statusLabel: 'Shipped',
      headline: 'Your order is on its way',
      greeting: 'Hello',
      intro: 'Your parcel has left us and is now with the carrier. Use the tracking details below to follow it.',
      customerName: String(customerName).trim(),
      orderNumber: String(orderNumber).trim(),
      trackingNumber: String(trackingNumber).trim(),
      carrierName: String(carrierName).trim(),
      trackingUrl: trackingUrl || '',
      estimatedDelivery: estimatedDelivery || '',
      ctaLabel: 'Track your parcel',
      labels: {
        orderNumber: 'Order number',
        carrier: 'Carrier',
        tracking: 'Tracking number',
        eta: 'Estimated delivery:',
      },
    },
  });
}

/**
 * Sends an operational alert to the SWG team.
 * Recipients come from `EMAIL_INTERNAL_RECIPIENTS` unless overridden.
 *
 * @param {object} params - Alert details.
 * @param {string} params.subject - Subject line and headline of the alert.
 * @param {string} params.message - Body copy. Newlines are preserved.
 * @param {Record<string, unknown>} [params.payloadData] - Key/value context rendered as a table.
 * @param {'low'|'normal'|'high'|'critical'} [params.priority] - Drives the colour stripe and the priority header.
 * @param {string|string[]} [params.to] - Recipient override.
 * @param {string} [params.alertKind] - Short label, e.g. `High-priority order`.
 * @param {string} [params.ctaUrl] - Link behind the button.
 * @param {string} [params.ctaLabel] - Button label.
 * @returns {Promise<SendResult>} Result of the accepted send.
 * @throws {EmailValidationError} When the subject or message is missing.
 * @throws {EmailSendError} When every attempt failed.
 *
 * @example
 * await sendInternalAlert({
 *   subject: 'High-value order SY-10241',
 *   message: 'A wholesale order above the review threshold just came in.',
 *   payloadData: { order: 'SY-10241', total: '₪4,820', customer: 'Nishant' },
 *   priority: 'high',
 * });
 */
export async function sendInternalAlert({
  subject,
  message,
  payloadData = {},
  priority = 'normal',
  to,
  alertKind = 'Automated alert',
  ctaUrl,
  ctaLabel = 'Open in the CRM',
}) {
  /** @type {string[]} */
  const issues = [];
  if (!subject || !String(subject).trim()) issues.push('subject is required.');
  if (!message || !String(message).trim()) issues.push('message is required.');
  if (issues.length) throw new EmailValidationError(issues);

  const cfg = getEmailConfig();
  const palette = {
    low: { color: '#7a7462', bg: '#e9e3d3', label: 'Low' },
    normal: { color: '#5b6b4c', bg: '#e1e6d5', label: 'Normal' },
    high: { color: '#b98a2e', bg: '#f1e3c4', label: 'High priority' },
    critical: { color: '#a6472b', bg: '#f0ddd5', label: 'Critical' },
  };
  const tone = palette[priority] || palette.normal;

  const payloadRows = Object.entries(payloadData || {}).map(([key, value]) => ({
    key,
    value:
      value === null || value === undefined
        ? '-'
        : typeof value === 'object'
          ? JSON.stringify(value)
          : String(value),
  }));

  return sendTemplatedMail({
    to: to || [...cfg.internalRecipients],
    subject: '[SWG ' + tone.label + '] ' + String(subject).trim(),
    template: 'internalAlert',
    category: 'internal_alert',
    replyTo: cfg.replyTo,
    headers: { 'X-SWG-Priority': priority },
    data: {
      preheader: String(message).trim().slice(0, 120),
      alertKind,
      alertTitle: String(subject).trim(),
      message: String(message).trim(),
      payloadRows,
      priorityLabel: tone.label,
      priorityColor: tone.color,
      priorityBg: tone.bg,
      ctaUrl: ctaUrl || '',
      ctaLabel,
      generatedAt: new Date().toISOString(),
      internalNotice: 'Internal notification generated by the SWG CRM email service. Not sent to the customer.',
      labels: { details: 'Details' },
    },
  });
}

/**
 * Sends the acknowledgement a customer receives when a support ticket opens.
 *
 * @param {object} params - Ticket details.
 * @param {string} params.to - Customer email address.
 * @param {string} params.customerName - Name shown in the greeting.
 * @param {string} params.ticketId - Reference the customer can quote back.
 * @param {string} [params.responseTimeNote] - Override for the expected-response sentence.
 * @returns {Promise<SendResult>} Result of the accepted send.
 * @throws {EmailValidationError} When required ticket details are missing.
 * @throws {EmailSendError} When every attempt failed.
 *
 * @example
 * await sendAutoReply({ to: 'dana@example.com', customerName: 'Dana', ticketId: 'TCK-4471' });
 */
export async function sendAutoReply({ to, customerName, ticketId, responseTimeNote }) {
  /** @type {string[]} */
  const issues = [];
  if (!customerName || !String(customerName).trim()) issues.push('customerName is required.');
  if (!ticketId || !String(ticketId).trim()) issues.push('ticketId is required.');
  if (issues.length) throw new EmailValidationError(issues);

  return sendTemplatedMail({
    to,
    subject: 'We received your message | קיבלנו את פנייתך [' + ticketId + ']',
    template: 'autoReply',
    category: 'auto_reply',
    headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
    data: {
      preheader: 'Your enquiry is logged as ' + ticketId + '.',
      headline: 'We received your message',
      greeting: 'Hello',
      intro:
        'Thank you for getting in touch. Your enquiry is logged and a member of the team will look at it personally.',
      customerName: String(customerName).trim(),
      ticketId: String(ticketId).trim(),
      responseTimeNote:
        responseTimeNote ||
        'We usually reply within one business day. Keep this reference in any follow-up so we can find your conversation quickly.',
      labels: { ticket: 'Your reference' },
    },
  });
}

export default {
  sendOrderConfirmation,
  sendShippingUpdate,
  sendInternalAlert,
  sendAutoReply,
  sendTemplatedMail,
  renderTemplate,
  verifyConnection,
  closeTransport,
};
