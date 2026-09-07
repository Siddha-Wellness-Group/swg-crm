/**
 * @file Manual smoke test for the SWG automated email service.
 *
 * Renders and sends one of every template, exercising both the direct send
 * path and the background queue.
 *
 * Usage:
 *   node test-email.js --dry-run                  render only, no SMTP connection
 *   node test-email.js --to you@example.com       real send to one address
 *   node test-email.js --dry-run --save out/      also write each rendered .html
 *
 * @module test-email
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Parses `--flag value` and `--flag` pairs out of argv.
 *
 * @param {string[]} argv - Raw arguments, typically `process.argv.slice(2)`.
 * @returns {Record<string, string|boolean>} Parsed flags.
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// Must be set before the config module is imported, since it reads env at load.
if (args['dry-run']) process.env.EMAIL_DRY_RUN = 'true';
if (args.to) process.env.EMAIL_INTERNAL_RECIPIENTS = String(args.to);

const { getEmailConfig } = await import('./src/config/emailConfig.js');
const service = await import('./src/services/email/emailService.js');
const { EmailQueue } = await import('./src/services/email/emailQueue.js');

const cfg = getEmailConfig();
const recipient = String(args.to || cfg.user);
const saveDir = typeof args.save === 'string' ? args.save : null;

/**
 * Writes a rendered template to disk when `--save` was given.
 *
 * @param {string} name - Template name, used as the file name.
 * @param {Record<string, unknown>} data - Template variables.
 * @returns {Promise<void>} Resolves once the file is written, or immediately.
 */
async function savePreview(name, data) {
  if (!saveDir) return;
  await mkdir(saveDir, { recursive: true });
  const html = await service.renderTemplate(name, data);
  const path = join(saveDir, name + '.html');
  await writeFile(path, html, 'utf8');
  console.log('  saved preview -> ' + path);
}

/**
 * Runs one labelled step and reports its outcome without aborting the run.
 *
 * @param {string} label - Step name shown in the output.
 * @param {() => Promise<any>} fn - Work to run.
 * @returns {Promise<boolean>} True when the step succeeded.
 */
async function step(label, fn) {
  process.stdout.write('\n--- ' + label + '\n');
  try {
    const result = await fn();
    if (result && result.messageId) {
      console.log('  OK  messageId=' + result.messageId + '  attempts=' + result.attempts);
    } else {
      console.log('  OK');
    }
    return true;
  } catch (error) {
    console.error('  FAILED  ' + (error && error.message));
    return false;
  }
}

const sampleItems = [
  { product_name: 'Cinnamor Oregano Oil 30ml', quantity: 2, unit_price: 89, size: '30ml' },
  { product_name: 'Lavender Calm Blend 15ml', quantity: 1, unit_price: 64, size: '15ml' },
];

console.log('SWG email service smoke test');
console.log('  driver      : ' + cfg.driver + (cfg.dryRun ? ' (dry run, nothing is sent)' : ''));
console.log('  from        : ' + cfg.from);
console.log('  recipient   : ' + recipient);
console.log('  retries     : up to ' + cfg.maxAttempts + ' attempts, base ' + cfg.retryBaseMs + 'ms');
console.log('  concurrency : ' + cfg.queueConcurrency);

/** @type {boolean[]} */
const outcomes = [];

outcomes.push(await step('Verify transport', () => service.verifyConnection()));

outcomes.push(
  await step('Order confirmation', async () => {
    const data = {
      to: recipient,
      customerName: 'דנה כהן',
      orderNumber: 'SY-10241',
      items: sampleItems,
      totalAmount: 242,
      shippingAddress: { line1: 'הרצל 12', city: 'תל אביב', postal_code: '6688218', country: 'Israel' },
    };
    await savePreview('orderConfirmation', {
      subject: 'preview',
      headline: 'Thank you for your order',
      greeting: 'Hello',
      intro: 'We have received your order and it is now being prepared.',
      customerName: data.customerName,
      orderNumber: data.orderNumber,
      orderDate: new Date().toLocaleDateString('en-GB'),
      items: sampleItems.map((i) => ({
        name: i.product_name,
        variant: i.size,
        quantity: i.quantity,
        lineTotal: service.formatAmount(i.unit_price * i.quantity),
      })),
      totalAmount: service.formatAmount(242),
      shippingAddress: service.formatAddress(data.shippingAddress),
      ctaLabel: 'View your order',
      labels: { orderNumber: 'Order number', orderDate: 'Order date', items: 'What you ordered', total: 'Total', shippingTo: 'Shipping to' },
    });
    return service.sendOrderConfirmation(data);
  }),
);

outcomes.push(
  await step('Shipping update', () =>
    service.sendShippingUpdate({
      to: recipient,
      customerName: 'Dana Cohen',
      orderNumber: 'SY-10241',
      trackingNumber: 'IL748291043',
      carrierName: 'Israel Post',
      trackingUrl: 'https://israelpost.co.il/itemtrace?itemcode=IL748291043',
      estimatedDelivery: 'Thursday, 4 September',
    }),
  ),
);

outcomes.push(
  await step('Internal alert', () =>
    service.sendInternalAlert({
      subject: 'High-value wholesale order SY-10241',
      message:
        'A wholesale order above the review threshold arrived from the storefront.\nOps should confirm stock before the order is picked.',
      payloadData: {
        order: 'SY-10241',
        total: '₪4,820',
        customer: 'Dana Cohen',
        channel: 'Website',
        owner: 'Omri',
      },
      priority: 'high',
      to: recipient,
      alertKind: 'High-priority order',
    }),
  ),
);

outcomes.push(
  await step('Support auto-reply', () =>
    service.sendAutoReply({ to: recipient, customerName: 'Dana', ticketId: 'TCK-4471' }),
  ),
);

outcomes.push(
  await step('Background queue (3 jobs)', async () => {
    const queue = new EmailQueue({ concurrency: 2 });
    queue.on('failed', (job, error) => console.error('  queue job failed: ' + job.type + ' - ' + error.message));
    queue.enqueue('autoReply', { to: recipient, customerName: 'Queued One', ticketId: 'TCK-9001' });
    queue.enqueue('autoReply', { to: recipient, customerName: 'Queued Two', ticketId: 'TCK-9002' });
    queue.enqueue('internalAlert', {
      subject: 'Queue drain check',
      message: 'Three jobs were pushed and drained without blocking the caller.',
      payloadData: { source: 'test-email.js' },
      to: recipient,
    });
    await queue.onIdle();
    const stats = queue.stats();
    console.log('  queue stats: completed=' + stats.completed + ' failed=' + stats.failed);
    if (stats.failed) throw new Error(stats.failed + ' queued job(s) failed');
    return null;
  }),
);

outcomes.push(
  await step('Validation rejects a bad request', async () => {
    try {
      await service.sendOrderConfirmation({ to: 'not-an-address', customerName: '', orderNumber: '', items: [] });
    } catch (error) {
      if (error.name === 'EmailValidationError') {
        console.log('  rejected as expected: ' + error.issues.length + ' issue(s)');
        return null;
      }
      throw error;
    }
    throw new Error('Expected an EmailValidationError but the send was accepted');
  }),
);

await service.closeTransport();

const passed = outcomes.filter(Boolean).length;
console.log('\n' + passed + '/' + outcomes.length + ' steps passed.');
process.exit(passed === outcomes.length ? 0 : 1);
