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
import {
  FOOTER_NOTE_EN,
  FOOTER_NOTE_HE,
  copyFor,
  formatAmountFor,
  formatDateFor,
  resolveLocale,
} from './i18n.js';

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates');

/** Public site shown in every customer-facing footer. */
const WEBSITE_URL = 'https://siddhayogaweb.com';

/** Support mailbox quoted in every footer. */
const SUPPORT_EMAIL = 'customer@siddhayogaweb.com';

export { FOOTER_NOTE_HE, FOOTER_NOTE_EN, resolveLocale };

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
 * Renders a template with the locale's brand context merged in.
 *
 * Direction and alignment come from the locale, so one template file serves
 * both languages instead of a per-language copy that can drift.
 *
 * @param {string} name - Template file name without the `.html` suffix.
 * @param {Record<string, unknown>} data - Template variables. `locale` selects the language.
 * @returns {Promise<string>} The rendered HTML document.
 */
export async function renderTemplate(name, data = {}) {
  const template = await loadTemplate(name);
  const locale = data.locale || 'en';
  const copy = copyFor(locale);
  return template({
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

/**
 * HTML entities that appear in the templates or in escaped caller copy.
 * `&quot;` matters more than it looks: Handlebars escapes every quote in a
 * value, so a deal title in quotes reached the text/plain part as
 * `&quot;Wholesale bulk&quot;` until this was handled.
 */
const ENTITIES = {
  '&nbsp;': ' ',
  '&middot;': '-',
  '&times;': 'x',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&lt;': '<',
  '&gt;': '>',
  '&amp;': '&', // last by construction: decoded via the map, not chained
};
const ENTITY_RE = new RegExp(Object.keys(ENTITIES).join('|'), 'gi');

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
    .replace(/&#847;|&zwnj;/gi, '')
    .replace(ENTITY_RE, (m) => ENTITIES[m.toLowerCase()] ?? m)
    // Any remaining numeric entity, so nothing leaks through as raw markup.
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)))
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
 * @param {string} [params.locale] - Language the body was rendered in, for the logs and headers.
 * @param {string} [params.localeReason] - Which signal chose that locale, for the logs.
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
  locale,
  localeReason,
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
      ...(locale ? { 'Content-Language': locale } : {}),
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
        locale,
        localeReason,
        messageId: result.messageId,
        recipient: result.to,
        recipients: recipients.length,
        status: cfg.dryRun ? 'dry-run' : 'sent',
        attempts: attempt,
        durationMs: result.durationMs,
        // What the receiving server actually said. messageId alone is
        // generated locally and proves nothing about acceptance -- these are
        // the fields that distinguish "handed over" from "quietly dropped".
        smtpResponse: info.response,
        acceptedCount: Array.isArray(info.accepted) ? info.accepted.length : undefined,
        rejected: Array.isArray(info.rejected) && info.rejected.length ? info.rejected : undefined,
      });
      // A resolved send with nothing accepted is not a success.
      if (Array.isArray(info.accepted) && info.accepted.length === 0) {
        logger.error('email.accepted_none', {
          correlationId, category, recipient: result.to, smtpResponse: info.response,
        });
      }
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
 * @param {string} [locale] - Target locale, for symbol placement and separators.
 * @returns {string} A display string such as `₪249.00`.
 */
export function formatAmount(amount, currency = 'ILS', locale = 'en') {
  return formatAmountFor(amount, currency, locale);
}

/**
 * Formats an optional money field, returning an empty string when there is
 * nothing to show. The templates use `{{#if}}` on the result, so a zero or
 * absent amount omits its whole row rather than printing a bare 0.00.
 *
 * @param {number|string|null|undefined} amount - Amount to format, if any.
 * @param {string} currency - ISO 4217 code.
 * @param {string} locale - Target locale.
 * @returns {string} Formatted amount, or '' when absent or zero.
 */
function money(amount, currency, locale) {
  if (amount === null || amount === undefined || amount === '') return '';
  const value = Number(amount);
  if (!Number.isFinite(value) || value === 0) return '';
  return formatAmountFor(value, currency, locale);
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
function normaliseItem(item, currency, locale = 'en') {
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
 * @param {string} [params.orderDate] - Display date. Defaults to today, formatted for the locale.
 * @param {string} [params.ctaUrl] - Link behind the primary button.
 * @param {string} [params.language] - Force a locale (`he`/`en`). Otherwise resolved from the recipient.
 * @param {string} [params.phone] - Customer phone, used only as a locale signal.
 * @returns {Promise<SendResult>} Result of the accepted send.
 * @throws {EmailValidationError} When required order details are missing.
 * @throws {EmailSendError} When every attempt failed.
 *
 * @example
 * await sendOrderConfirmation({
 *   to: 'dana@example.com',
 *   customerName: 'דנה כהן',       // Hebrew script -> the email goes out in Hebrew
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
  language,
  phone,
  subtotal,
  shippingCost,
  discountAmount,
  taxAmount,
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

  const { locale, reason } = resolveLocale({ language, customerName, shippingAddress, phone });
  const copy = copyFor(locale);
  const t = copy.orderConfirmation;
  const number = String(orderNumber).trim();

  return sendTemplatedMail({
    to,
    subject: t.subject(number),
    template: 'orderConfirmation',
    category: 'order_confirmation',
    locale,
    localeReason: reason,
    data: {
      locale,
      preheader: t.preheader(number),
      headline: t.headline,
      intro: t.intro,
      customerName: String(customerName).trim(),
      orderNumber: number,
      orderDate: orderDate || formatDateFor(new Date(), locale),
      items: items.map((item) => normaliseItem(item, currency, locale)),
      // Only rendered when the order actually carries them, so a plain order
      // shows just items and a total. Without these the customer sees an
      // item at 148 and a total of 183 with the shipping unexplained.
      subtotalAmount: money(subtotal, currency, locale),
      shippingAmount: money(shippingCost, currency, locale),
      discountAmountText: discountAmount ? '-' + formatAmountFor(Math.abs(Number(discountAmount)), currency, locale) : '',
      taxAmountText: money(taxAmount, currency, locale),
      totalAmount: formatAmountFor(totalAmount, currency, locale),
      shippingAddress: formatAddress(shippingAddress),
      ctaUrl: ctaUrl || '',
      ctaLabel: t.ctaLabel,
      labels: t.labels,
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
 * @param {string} [params.language] - Force a locale (`he`/`en`). Otherwise resolved from the recipient.
 * @param {string|Record<string, unknown>} [params.shippingAddress] - Used only as a locale signal.
 * @param {string} [params.phone] - Customer phone, used only as a locale signal.
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
  language,
  shippingAddress,
  phone,
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

  const { locale, reason } = resolveLocale({ language, customerName, shippingAddress, phone });
  const copy = copyFor(locale);
  const t = copy.shippingUpdate;
  const number = String(orderNumber).trim();
  const tracking = String(trackingNumber).trim();
  const carrier = String(carrierName).trim();

  return sendTemplatedMail({
    to,
    subject: t.subject(number),
    template: 'shippingUpdate',
    category: 'shipping_update',
    locale,
    localeReason: reason,
    data: {
      locale,
      preheader: t.preheader(tracking, carrier),
      statusLabel: t.statusLabel,
      headline: t.headline,
      intro: t.intro,
      customerName: String(customerName).trim(),
      orderNumber: number,
      trackingNumber: tracking,
      carrierName: carrier,
      trackingUrl: trackingUrl || '',
      estimatedDelivery: estimatedDelivery || '',
      ctaLabel: t.ctaLabel,
      labels: t.labels,
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
  alertKind,
  ctaUrl,
  ctaLabel,
  language,
}) {
  /** @type {string[]} */
  const issues = [];
  if (!subject || !String(subject).trim()) issues.push('subject is required.');
  if (!message || !String(message).trim()) issues.push('message is required.');
  if (issues.length) throw new EmailValidationError(issues);

  const cfg = getEmailConfig();
  // Internal mail is for the SWG team, so it follows the configured team
  // language rather than trying to infer anything from a customer record.
  const { locale, reason } = resolveLocale({ language, fallback: cfg.teamLocale });
  const copy = copyFor(locale);
  const t = copy.internalAlert;

  const palette = {
    low: { color: '#7a7462', bg: '#e9e3d3' },
    normal: { color: '#5b6b4c', bg: '#e1e6d5' },
    high: { color: '#b98a2e', bg: '#f1e3c4' },
    critical: { color: '#a6472b', bg: '#f0ddd5' },
  };
  const tone = palette[priority] || palette.normal;
  const priorityLabel = t.priority[priority] || t.priority.normal;

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
    subject: '[' + t.subjectPrefix + ' ' + priorityLabel + '] ' + String(subject).trim(),
    template: 'internalAlert',
    category: 'internal_alert',
    replyTo: cfg.replyTo,
    locale,
    localeReason: reason,
    headers: { 'X-SWG-Priority': priority },
    data: {
      locale,
      preheader: String(message).trim().slice(0, 120),
      alertKind: alertKind || t.alertKind,
      alertTitle: String(subject).trim(),
      message: String(message).trim(),
      payloadRows,
      priorityLabel,
      priorityColor: tone.color,
      priorityBg: tone.bg,
      ctaUrl: ctaUrl || '',
      ctaLabel: ctaLabel || t.ctaLabel,
      generatedAt: new Date().toISOString(),
      internalNotice: t.internalNotice,
      labels: t.labels,
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
 * @param {string} [params.language] - Force a locale (`he`/`en`). Otherwise resolved from the recipient.
 * @param {string} [params.phone] - Customer phone, used only as a locale signal.
 * @returns {Promise<SendResult>} Result of the accepted send.
 * @throws {EmailValidationError} When required ticket details are missing.
 * @throws {EmailSendError} When every attempt failed.
 *
 * @example
 * await sendAutoReply({ to: 'dana@example.com', customerName: 'Dana', ticketId: 'TCK-4471' });
 */
export async function sendAutoReply({ to, customerName, ticketId, responseTimeNote, language, phone }) {
  /** @type {string[]} */
  const issues = [];
  if (!customerName || !String(customerName).trim()) issues.push('customerName is required.');
  if (!ticketId || !String(ticketId).trim()) issues.push('ticketId is required.');
  if (issues.length) throw new EmailValidationError(issues);

  const { locale, reason } = resolveLocale({ language, customerName, phone });
  const copy = copyFor(locale);
  const t = copy.autoReply;
  const ticket = String(ticketId).trim();

  return sendTemplatedMail({
    to,
    subject: t.subject(ticket),
    template: 'autoReply',
    category: 'auto_reply',
    locale,
    localeReason: reason,
    headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All' },
    data: {
      locale,
      preheader: t.preheader(ticket),
      headline: t.headline,
      intro: t.intro,
      customerName: String(customerName).trim(),
      ticketId: ticket,
      responseTimeNote: responseTimeNote || t.responseTimeNote,
      labels: t.labels,
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
