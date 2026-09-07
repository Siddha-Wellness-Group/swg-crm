/**
 * @file Structured logger for the email service.
 *
 * Emits one JSON object per line so the output drops straight into any log
 * collector. Kept dependency-free on purpose: the service must be able to run
 * inside a serverless function with nothing installed but its mail deps. Swap
 * {@link emit} for a pino or winston call if the CRM later standardises on one.
 *
 * @module services/email/logger
 */

/** Numeric severity for each supported level, used for threshold filtering. */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Keys whose values are redacted before anything is written. */
const SECRET_KEYS = ['pass', 'password', 'clientSecret', 'refreshToken', 'accessToken', 'authorization'];

/**
 * Replaces secret-looking values so credentials never reach the log stream.
 *
 * @param {Record<string, unknown>} fields - Fields supplied by the caller.
 * @returns {Record<string, unknown>} A shallow copy with secrets masked.
 */
function redact(fields) {
  /** @type {Record<string, unknown>} */
  const safe = {};
  for (const [key, value] of Object.entries(fields || {})) {
    safe[key] = SECRET_KEYS.includes(key) ? '[redacted]' : value;
  }
  return safe;
}

/**
 * Writes one structured record.
 *
 * @param {'debug'|'info'|'warn'|'error'} level - Severity of the record.
 * @param {string} message - Short, stable, human-readable event name.
 * @param {Record<string, unknown>} [fields] - Structured context for the event.
 * @returns {void}
 */
function emit(level, message, fields = {}) {
  const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
  if (LEVELS[level] < threshold) return;

  const record = {
    time: new Date().toISOString(),
    level,
    service: 'email',
    msg: message,
    ...redact(fields),
  };

  const line = JSON.stringify(record, (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message, code: value.code } : value,
  );

  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

/** Structured logger used across the email service. */
export const logger = {
  /**
   * @param {string} message - Event name.
   * @param {Record<string, unknown>} [fields] - Structured context.
   * @returns {void}
   */
  debug: (message, fields) => emit('debug', message, fields),
  /**
   * @param {string} message - Event name.
   * @param {Record<string, unknown>} [fields] - Structured context.
   * @returns {void}
   */
  info: (message, fields) => emit('info', message, fields),
  /**
   * @param {string} message - Event name.
   * @param {Record<string, unknown>} [fields] - Structured context.
   * @returns {void}
   */
  warn: (message, fields) => emit('warn', message, fields),
  /**
   * @param {string} message - Event name.
   * @param {Record<string, unknown>} [fields] - Structured context.
   * @returns {void}
   */
  error: (message, fields) => emit('error', message, fields),
};

export default logger;
