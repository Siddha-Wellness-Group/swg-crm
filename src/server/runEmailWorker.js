/**
 * @file Process entry point that runs the email outbox worker.
 *
 * Kept separate from `emailWorker.js` so that module stays a pure factory
 * (importable and unit-testable with a fake Supabase client) while this file
 * owns the process-level concerns: reading real environment variables,
 * creating a real Supabase client, and shutting down cleanly on SIGINT/SIGTERM.
 *
 * Usage:
 *   node src/server/runEmailWorker.js
 *
 * @module server/runEmailWorker
 */

import { createClient } from '@supabase/supabase-js';
import { config as loadDotenv } from 'dotenv';

import { createEmailWorker } from './emailWorker.js';
import { verifyConnection, closeTransport } from '../services/email/emailService.js';
import { getEmailConfig } from '../config/emailConfig.js';
import { logger } from '../services/email/logger.js';

loadDotenv();

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(
    'Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in .env.\n' +
      'The worker needs the service role key (not the anon key from swg_crm.html) ' +
      'to read and write email_outbox / email_log regardless of RLS.\n' +
      'Find it in the Supabase dashboard: Project Settings -> API -> service_role secret.',
  );
  process.exit(1);
}

const supabaseClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const pollMs = Number(process.env.EMAIL_WORKER_POLL_MS) || 4000;
const batchSize = Number(process.env.EMAIL_WORKER_BATCH_SIZE) || 5;
const concurrency = Number(process.env.EMAIL_WORKER_CONCURRENCY) || 2;

const worker = createEmailWorker({ supabaseClient, pollMs, batchSize, concurrency });

async function main() {
  const cfg = getEmailConfig();
  logger.info('worker.boot', {
    driver: cfg.driver,
    dryRun: cfg.dryRun,
    from: cfg.from,
    pollMs,
    batchSize,
    concurrency,
  });

  try {
    await verifyConnection();
  } catch (error) {
    logger.error('worker.boot_verify_failed', { reason: error && error.message });
    console.error(
      '\nCould not verify the email transport at boot. The worker will still start and ' +
        'retry per-message, but nothing will send until this is fixed:\n  ' +
        (error && error.message),
    );
  }

  worker.start();
  console.log('Email outbox worker running (' + worker.workerId + '). Ctrl+C to stop.');
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('worker.shutdown', { signal });
  worker.stop();
  await closeTransport();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((error) => {
  logger.error('worker.boot_failed', { reason: error && error.message });
  console.error(error);
  process.exit(1);
});
