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
// Fallback for testing only. It works solely because the ledger's RLS is
// still the placeholder `to anon using (true)` policy, so anon can reach
// email_outbox and email_log. The moment RLS is tightened to real per-user
// policies this stops working, which is the correct outcome -- a background
// worker should hold the service role key, not the key that ships publicly
// inside swg_crm.html.
const ANON_KEY = process.env.SUPABASE_ANON_KEY;
const key = SERVICE_ROLE_KEY || ANON_KEY;

if (!SUPABASE_URL || !key) {
  console.error(
    'Missing SUPABASE_URL and/or SUPABASE_SERVICE_ROLE_KEY in .env.\n' +
      'The worker needs the service role key (not the anon key from swg_crm.html) ' +
      'to read and write email_outbox / email_log regardless of RLS.\n' +
      'Find it in the Supabase dashboard: Project Settings -> API -> service_role secret.\n' +
      'For a local test only, SUPABASE_ANON_KEY also works while RLS stays permissive.',
  );
  process.exit(1);
}

if (!SERVICE_ROLE_KEY) {
  logger.warn('worker.using_anon_key', {
    reason: 'SUPABASE_SERVICE_ROLE_KEY not set; falling back to the anon key',
    note: 'Testing only. Set the service role key before running this anywhere permanent.',
  });
}

const supabaseClient = createClient(SUPABASE_URL, key, {
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
