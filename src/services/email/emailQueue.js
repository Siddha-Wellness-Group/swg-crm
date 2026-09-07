/**
 * @file Background email queue.
 *
 * API request threads should never wait on SMTP. Handlers push a job here and
 * return immediately; the queue drains it with bounded concurrency and emits
 * events the caller can subscribe to for logging or persistence.
 *
 * Built on Node's own `EventEmitter` with a small concurrency-limited
 * scheduler, so the CRM can deploy it into a serverless runtime without
 * pulling in `p-queue`.
 *
 * @module services/email/emailQueue
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

import { getEmailConfig } from '../../config/emailConfig.js';
import { logger } from './logger.js';
import {
  sendAutoReply,
  sendInternalAlert,
  sendOrderConfirmation,
  sendShippingUpdate,
} from './emailService.js';

/**
 * Job kinds every consumer of the email service knows how to run, mapped to
 * their send function. Shared with the outbox worker (src/server/emailWorker.js)
 * so the two never drift on what a "type" string means.
 * @type {Record<string, (payload: any) => Promise<import('./emailService.js').SendResult>>}
 */
export const HANDLERS = {
  orderConfirmation: sendOrderConfirmation,
  shippingUpdate: sendShippingUpdate,
  internalAlert: sendInternalAlert,
  autoReply: sendAutoReply,
};

/**
 * @typedef {object} QueueJob
 * @property {string} id        Unique job id, also used as the log correlation key.
 * @property {string} type      One of the keys of {@link HANDLERS}.
 * @property {object} payload   Arguments passed straight to the send function.
 * @property {number} enqueuedAt Epoch milliseconds when the job was accepted.
 */

/**
 * @typedef {object} QueueStats
 * @property {number} queued    Jobs waiting to start.
 * @property {number} running   Jobs currently in flight.
 * @property {number} completed Jobs that finished successfully this process.
 * @property {number} failed    Jobs that exhausted their retries this process.
 */

/**
 * An in-process, concurrency-limited email queue.
 *
 * Events emitted:
 * - `enqueued` `(job)` when a job is accepted.
 * - `sent` `(job, result)` when a job completes.
 * - `failed` `(job, error)` when a job exhausts the service's retries.
 * - `idle` `()` when the queue drains completely.
 *
 * @augments EventEmitter
 */
export class EmailQueue extends EventEmitter {
  /**
   * @param {object} [options] - Queue options.
   * @param {number} [options.concurrency] - Parallel sends. Defaults to `EMAIL_QUEUE_CONCURRENCY`.
   * @param {boolean} [options.autoStart] - Start draining as soon as jobs arrive. Defaults to true.
   */
  constructor(options = {}) {
    super();
    /** @type {QueueJob[]} */
    this.pending = [];
    /** @type {number} */
    this.running = 0;
    /** @type {number} */
    this.completed = 0;
    /** @type {number} */
    this.failed = 0;
    /** @type {boolean} */
    this.paused = options.autoStart === false;

    let concurrency = options.concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      try {
        concurrency = getEmailConfig().queueConcurrency;
      } catch {
        concurrency = 2;
      }
    }
    /** @type {number} */
    this.concurrency = concurrency;

    // Nothing should crash the process because no listener was attached.
    this.on('error', (error) => logger.error('queue.unhandled', { reason: error && error.message }));
  }

  /**
   * Accepts a job and returns immediately, without waiting for delivery.
   *
   * @param {string} type - Job kind. One of `orderConfirmation`, `shippingUpdate`, `internalAlert`, `autoReply`.
   * @param {object} payload - Arguments for the matching send function.
   * @returns {QueueJob} The accepted job, whose `id` correlates with the log records.
   * @throws {TypeError} When the job type is unknown.
   *
   * @example
   * emailQueue.enqueue('orderConfirmation', { to, customerName, orderNumber, items, totalAmount });
   */
  enqueue(type, payload) {
    if (!HANDLERS[type]) {
      throw new TypeError(
        'Unknown email job type "' + type + '". Expected one of: ' + Object.keys(HANDLERS).join(', '),
      );
    }
    /** @type {QueueJob} */
    const job = { id: randomUUID(), type, payload, enqueuedAt: Date.now() };
    this.pending.push(job);
    logger.info('queue.enqueued', {
      jobId: job.id,
      type,
      recipient: payload && payload.to,
      queued: this.pending.length,
      running: this.running,
    });
    this.emit('enqueued', job);
    if (!this.paused) queueMicrotask(() => this.#drain());
    return job;
  }

  /**
   * Starts draining a queue created with `autoStart: false`.
   *
   * @returns {void}
   */
  start() {
    this.paused = false;
    this.#drain();
  }

  /**
   * Stops picking up new jobs. Jobs already in flight run to completion.
   *
   * @returns {void}
   */
  pause() {
    this.paused = true;
  }

  /**
   * Current queue counters.
   *
   * @returns {QueueStats} A snapshot of the queue state.
   */
  stats() {
    return {
      queued: this.pending.length,
      running: this.running,
      completed: this.completed,
      failed: this.failed,
    };
  }

  /**
   * Resolves once the queue holds no pending or running jobs.
   * Call before process exit so nothing is dropped mid-flight.
   *
   * @returns {Promise<void>} Resolves when the queue is idle.
   */
  async onIdle() {
    if (!this.pending.length && !this.running) return;
    await new Promise((resolve) => this.once('idle', resolve));
  }

  /**
   * Fills the free concurrency slots with pending jobs.
   *
   * @returns {void}
   */
  #drain() {
    if (this.paused) return;
    while (this.running < this.concurrency && this.pending.length) {
      const job = this.pending.shift();
      this.running += 1;
      this.#run(job);
    }
    if (!this.running && !this.pending.length) this.emit('idle');
  }

  /**
   * Runs one job, then refills the slot it occupied.
   * A job failure is reported through the `failed` event and never rejects.
   *
   * @param {QueueJob} job - The job to run.
   * @returns {Promise<void>} Resolves once the slot is released.
   */
  async #run(job) {
    const waitedMs = Date.now() - job.enqueuedAt;
    try {
      const result = await HANDLERS[job.type](job.payload);
      this.completed += 1;
      logger.info('queue.job_sent', {
        jobId: job.id,
        type: job.type,
        messageId: result.messageId,
        recipient: result.to,
        status: result.dryRun ? 'dry-run' : 'sent',
        attempts: result.attempts,
        waitedMs,
      });
      this.emit('sent', job, result);
    } catch (error) {
      this.failed += 1;
      logger.error('queue.job_failed', {
        jobId: job.id,
        type: job.type,
        recipient: job.payload && job.payload.to,
        status: 'failed',
        waitedMs,
        reason: error && error.message,
      });
      this.emit('failed', job, error);
    } finally {
      this.running -= 1;
      this.#drain();
    }
  }
}

/**
 * Process-wide queue shared by the CRM's API handlers.
 * @type {EmailQueue}
 */
export const emailQueue = new EmailQueue();

/**
 * Convenience wrapper so request handlers read cleanly.
 *
 * @param {string} type - Job kind.
 * @param {object} payload - Arguments for the matching send function.
 * @returns {QueueJob} The accepted job.
 *
 * @example
 * queueEmail('autoReply', { to, customerName, ticketId });
 */
export function queueEmail(type, payload) {
  return emailQueue.enqueue(type, payload);
}

export default emailQueue;
