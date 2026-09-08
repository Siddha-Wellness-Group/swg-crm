/**
 * @file Outbox worker for the automated email service.
 *
 * This is item 2 of the CRM <-> email integration ("a server that exposes
 * the send functions"). Rather than an HTTP API — which would need a secret
 * embedded in `swg_crm.html`, the same exposure problem the anon key already
 * has — the browser writes a row to the `email_outbox` table using the anon
 * key it already holds. This worker, running with the Supabase *service
 * role* key and the real Gmail credentials, polls that table and does the
 * actual sending. No secret of any kind needs to reach the browser.
 *
 * The worker also satisfies item 5 (writing to `email_log`): it is the one
 * place that both sends the email and knows the outcome, so it writes both
 * tables in the same step.
 *
 * Safe to run as more than one instance: claiming a row is a conditional
 * update (`status = 'queued' -> 'processing'`), so two workers racing on the
 * same row only one of them wins it.
 *
 * @module server/emailWorker
 */

import { randomUUID } from 'node:crypto';

import { HANDLERS } from '../services/email/emailQueue.js';
import { logger } from '../services/email/logger.js';

/** Maps an outbox `type` to the `category` column used in `email_log`. */
const CATEGORY_BY_TYPE = {
  orderConfirmation: 'order_confirmation',
  shippingUpdate: 'shipping_update',
  internalAlert: 'internal_alert',
  autoReply: 'auto_reply',
};

/**
 * Best-effort extraction of a recipient to log, even from a failed or
 * malformed row. `internalAlert` payloads often omit `to` on purpose (it
 * falls back to the configured internal recipients inside the service).
 *
 * @param {{type: string, payload: Record<string, any>}} row - Outbox row.
 * @returns {string} A display recipient, never empty.
 */
function extractRecipient(row) {
  const to = row.payload && row.payload.to;
  if (Array.isArray(to)) return to.join(', ');
  if (to) return String(to);
  return row.type === 'internalAlert' ? '(configured internal recipients)' : '(unknown)';
}

/**
 * @typedef {object} EmailWorkerOptions
 * @property {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 *   Client authenticated with the service role key. Required — this worker
 *   must run somewhere the anon key's RLS restrictions don't apply.
 * @property {Record<string, (payload: any) => Promise<any>>} [handlers] - Job type to send function. Defaults to {@link HANDLERS}.
 * @property {number} [pollMs] - Delay between polls when the outbox was empty. Default 4000.
 * @property {number} [batchSize] - Rows claimed per poll. Default 5.
 * @property {number} [concurrency] - Rows sent in parallel within a batch. Default 2.
 * @property {string} [workerId] - Identifies this instance in logs and `claimed_by`.
 */

/**
 * Creates an outbox worker. Call `.start()` to begin polling.
 *
 * Constructed with dependency injection (a `supabaseClient` argument rather
 * than importing one) so the polling and claim logic can be unit tested with
 * an in-memory fake, without a live Supabase project.
 *
 * @param {EmailWorkerOptions} options - Worker configuration.
 * @returns {{start: () => void, stop: () => void, pollOnce: () => Promise<number>, workerId: string}}
 *   Controls for the worker. `pollOnce` runs a single poll/claim/process
 *   cycle and resolves with the number of rows processed — useful for tests
 *   and for a manual "process what's queued right now" run.
 * @throws {TypeError} When `supabaseClient` is missing.
 *
 * @example
 * const worker = createEmailWorker({ supabaseClient });
 * worker.start();
 * process.on('SIGTERM', worker.stop);
 */
export function createEmailWorker(options = {}) {
  const {
    supabaseClient,
    handlers = HANDLERS,
    pollMs = 4000,
    batchSize = 5,
    concurrency = 2,
    workerId = 'worker-' + randomUUID().slice(0, 8),
  } = options;

  if (!supabaseClient) {
    throw new TypeError('createEmailWorker requires a supabaseClient (service role, not anon).');
  }

  /** @type {NodeJS.Timeout|null} */
  let timer = null;
  let stopped = true;
  let polling = false;

  /**
   * Claims up to `batchSize` queued rows, oldest first.
   *
   * @returns {Promise<Array<Record<string, any>>>} Rows this instance won the claim on.
   */
  async function claimBatch() {
    const { data: candidates, error } = await supabaseClient
      .from('email_outbox')
      .select('*')
      .eq('status', 'queued')
      .order('created_at', { ascending: true })
      .limit(batchSize);

    if (error) {
      logger.error('worker.claim_query_failed', { workerId, reason: error.message });
      return [];
    }
    if (!candidates || !candidates.length) return [];

    const claimed = [];
    for (const row of candidates) {
      const { data: updated, error: claimError } = await supabaseClient
        .from('email_outbox')
        .update({ status: 'processing', claimed_at: Date.now(), claimed_by: workerId })
        .eq('id', row.id)
        .eq('status', 'queued') // compare-and-swap: loses the race gracefully to another worker
        .select();

      if (claimError) {
        logger.error('worker.claim_failed', { workerId, jobId: row.id, reason: claimError.message });
        continue;
      }
      if (updated && updated.length) claimed.push(row);
    }
    return claimed;
  }

  /**
   * Sends one row and records the outcome in both `email_outbox` and `email_log`.
   *
   * @param {Record<string, any>} row - A claimed outbox row.
   * @returns {Promise<void>} Resolves once the row's outcome is persisted.
   */
  async function processRow(row) {
    const handler = handlers[row.type];
    const recipient = extractRecipient(row);

    if (!handler) {
      const reason = 'Unknown job type "' + row.type + '"';
      await supabaseClient
        .from('email_outbox')
        .update({ status: 'failed', attempts: (row.attempts || 0) + 1, last_error: reason })
        .eq('id', row.id);
      await logDelivery(row, { status: 'failed', recipient, reason });
      logger.error('worker.unknown_type', { workerId, jobId: row.id, type: row.type });
      return;
    }

    try {
      const result = await handler(row.payload);
      await supabaseClient
        .from('email_outbox')
        .update({ status: 'sent', attempts: result.attempts, sent_at: Date.now(), last_error: null })
        .eq('id', row.id);
      await logDelivery(row, {
        status: result.dryRun ? 'dry-run' : 'sent',
        recipient: result.to,
        messageId: result.messageId,
        correlationId: result.correlationId,
        subject: result.subject,
        attempts: result.attempts,
        durationMs: result.durationMs,
      });
      logger.info('worker.job_sent', { workerId, jobId: row.id, type: row.type, messageId: result.messageId });
    } catch (error) {
      const attempts = typeof error.attempts === 'number' ? error.attempts : (row.attempts || 0) + 1;
      await supabaseClient
        .from('email_outbox')
        .update({ status: 'failed', attempts, last_error: String(error && error.message) })
        .eq('id', row.id);
      await logDelivery(row, { status: 'failed', recipient, attempts, reason: error && error.message });
      logger.error('worker.job_failed', { workerId, jobId: row.id, type: row.type, reason: error && error.message });
    }
  }

  /**
   * Writes a best-effort row to `email_log`. Never throws — a logging
   * failure must not be mistaken for a delivery failure.
   *
   * @param {Record<string, any>} row - The outbox row this delivery came from.
   * @param {Record<string, any>} outcome - Fields describing what happened.
   * @returns {Promise<void>} Always resolves.
   */
  async function logDelivery(row, outcome) {
    try {
      const { error } = await supabaseClient.from('email_log').insert({
        id: randomUUID(),
        created_at: Date.now(),
        correlation_id: outcome.correlationId || null,
        message_id: outcome.messageId || null,
        category: CATEGORY_BY_TYPE[row.type] || row.type,
        template: row.type,
        recipient: outcome.recipient,
        subject: outcome.subject || null,
        status: outcome.status,
        attempts: outcome.attempts ?? row.attempts ?? 1,
        duration_ms: outcome.durationMs ?? null,
        reason: outcome.reason || null,
        related_type: row.related_type || null,
        related_id: row.related_id || null,
      });
      if (error) logger.error('worker.log_write_failed', { workerId, jobId: row.id, reason: error.message });
    } catch (error) {
      logger.error('worker.log_write_failed', { workerId, jobId: row.id, reason: error && error.message });
    }
  }

  /**
   * Runs one claim-and-process cycle.
   *
   * @returns {Promise<number>} Number of rows processed this cycle.
   */
  async function pollOnce() {
    if (polling) return 0; // a slow previous cycle is still running; skip this tick rather than overlap
    polling = true;
    try {
      const rows = await claimBatch();
      if (!rows.length) return 0;

      const pending = [...rows];
      const lanes = Array.from({ length: Math.min(concurrency, rows.length) }, async () => {
        let row;
        // eslint-disable-next-line no-cond-assign
        while ((row = pending.shift())) await processRow(row);
      });
      await Promise.all(lanes);
      return rows.length;
    } finally {
      polling = false;
    }
  }

  /**
   * Starts polling on an interval. Idempotent — calling it while already
   * running does nothing.
   *
   * @returns {void}
   */
  function start() {
    if (!stopped) return;
    stopped = false;
    logger.info('worker.started', { workerId, pollMs, batchSize, concurrency });

    const tick = async () => {
      if (stopped) return;
      try {
        await pollOnce();
      } catch (error) {
        logger.error('worker.tick_failed', { workerId, reason: error && error.message });
      }
      if (!stopped) timer = setTimeout(tick, pollMs);
    };
    tick();
  }

  /**
   * Stops polling. Any row currently mid-send finishes; no new batch is claimed.
   *
   * @returns {void}
   */
  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
    logger.info('worker.stopped', { workerId });
  }

  return { start, stop, pollOnce, workerId };
}

export default createEmailWorker;
