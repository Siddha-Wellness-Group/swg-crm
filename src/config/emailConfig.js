/**
 * @file Environment configuration for the SWG automated email service.
 *
 * Reads the process environment once, validates it strictly, and exposes a
 * frozen config object. Every problem found is reported together in a single
 * {@link EmailConfigError}, so a misconfigured deployment fails loudly at boot
 * instead of silently at the first send.
 *
 * @module config/emailConfig
 */

import { config as loadDotenv } from 'dotenv';

loadDotenv();

/** Address every customer-facing message is sent from. */
export const PRIMARY_SENDER_ADDRESS = 'customer@siddhayogaweb.com';

/** Display name paired with {@link PRIMARY_SENDER_ADDRESS}. */
export const PRIMARY_SENDER_NAME = 'Siddha Yoga Web Services';

/**
 * Thrown when the environment cannot produce a usable email configuration.
 */
export class EmailConfigError extends Error {
  /**
   * @param {string[]} issues - Human-readable description of each problem found.
   */
  constructor(issues) {
    super('Invalid email configuration:\n  - ' + issues.join('\n  - '));
    this.name = 'EmailConfigError';
    /** @type {string[]} */
    this.issues = issues;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Reads a variable, trimming whitespace and treating the empty string as unset.
 *
 * @param {NodeJS.ProcessEnv} env - Source environment.
 * @param {string} name - Environment variable name.
 * @param {string} [fallback] - Value returned when the variable is unset.
 * @returns {string} The trimmed value, or the fallback.
 */
function str(env, name, fallback = '') {
  const raw = env[name];
  if (raw === undefined || raw === null) return fallback;
  const trimmed = String(raw).trim();
  return trimmed === '' ? fallback : trimmed;
}

/**
 * Reads a variable as a bounded integer, recording a problem when malformed.
 *
 * @param {NodeJS.ProcessEnv} env - Source environment.
 * @param {string} name - Environment variable name.
 * @param {number} fallback - Value used when the variable is unset.
 * @param {{min?: number, max?: number}} bounds - Inclusive bounds.
 * @param {string[]} issues - Collector reported by the caller.
 * @returns {number} The parsed integer, or the fallback when invalid.
 */
function int(env, name, fallback, bounds, issues) {
  const raw = str(env, name);
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    issues.push(name + ' must be a whole number, received "' + raw + '"');
    return fallback;
  }
  const min = bounds.min === undefined ? -Infinity : bounds.min;
  const max = bounds.max === undefined ? Infinity : bounds.max;
  if (parsed < min || parsed > max) {
    issues.push(name + ' must be between ' + min + ' and ' + max + ', received ' + parsed);
    return fallback;
  }
  return parsed;
}

/**
 * Reads a variable as a boolean. Accepts true/1/yes/on in any casing.
 *
 * @param {NodeJS.ProcessEnv} env - Source environment.
 * @param {string} name - Environment variable name.
 * @param {boolean} [fallback] - Value used when the variable is unset.
 * @returns {boolean} The parsed flag.
 */
function bool(env, name, fallback = false) {
  const raw = str(env, name).toLowerCase();
  if (!raw) return fallback;
  return ['true', '1', 'yes', 'on'].includes(raw);
}

/**
 * Splits a comma-separated variable into a list of valid email addresses.
 *
 * @param {NodeJS.ProcessEnv} env - Source environment.
 * @param {string} name - Environment variable name.
 * @param {string[]} fallback - Value used when the variable is unset.
 * @param {string[]} issues - Collector reported by the caller.
 * @returns {string[]} Addresses, de-duplicated and lower-cased.
 */
function emailList(env, name, fallback, issues) {
  const raw = str(env, name);
  if (!raw) return fallback;
  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(Boolean);
  const bad = parts.filter((p) => !EMAIL_RE.test(p));
  if (bad.length) issues.push(name + ' contains invalid addresses: ' + bad.join(', '));
  return [...new Set(parts.filter((p) => EMAIL_RE.test(p)))];
}

/**
 * @typedef {object} EmailOAuthConfig
 * @property {string} clientId     Google OAuth2 client id.
 * @property {string} clientSecret Google OAuth2 client secret.
 * @property {string} refreshToken Long-lived refresh token for the sender mailbox.
 * @property {string} accessUrl    Token endpoint used to mint access tokens.
 */

/**
 * @typedef {object} EmailConfig
 * @property {'oauth2'|'smtp'} driver      Selected transport.
 * @property {boolean} dryRun              When true, nothing leaves the process.
 * @property {string} host                 SMTP host.
 * @property {number} port                 SMTP port.
 * @property {boolean} secure              Implicit TLS, true on port 465.
 * @property {string} user                 Authenticating mailbox.
 * @property {string} pass                 App password. Empty under OAuth2.
 * @property {EmailOAuthConfig} oauth      Google OAuth2 credentials.
 * @property {string} fromName             Sender display name.
 * @property {string} fromAddress          Sender address.
 * @property {string} from                 Fully formatted From header.
 * @property {string} replyTo              Reply-To offered to customers.
 * @property {string[]} internalRecipients Recipients of internal alerts.
 * @property {string} teamLocale           Language internal alerts are written in (`he`/`en`).
 * @property {number} maxAttempts          Total send attempts, first one included.
 * @property {number} retryBaseMs          Base delay for exponential backoff.
 * @property {number} queueConcurrency     Parallel sends in the background queue.
 * @property {string} logLevel             Structured log level.
 */

/**
 * Builds and validates the email configuration from an environment object.
 *
 * Transport selection: when `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET` and
 * `OAUTH_REFRESH_TOKEN` are all present the driver is `oauth2`. Otherwise it
 * falls back to `smtp`, which requires `EMAIL_PASS`. Dry-run mode requires
 * neither credential set.
 *
 * @param {NodeJS.ProcessEnv} [env] - Source environment. Injectable for tests.
 * @returns {Readonly<EmailConfig>} The validated, frozen configuration.
 * @throws {EmailConfigError} When any required value is missing or malformed.
 */
export function buildEmailConfig(env = process.env) {
  /** @type {string[]} */
  const issues = [];

  const dryRun = bool(env, 'EMAIL_DRY_RUN', false);

  const user = str(env, 'EMAIL_USER', PRIMARY_SENDER_ADDRESS).toLowerCase();
  if (!EMAIL_RE.test(user)) issues.push('EMAIL_USER is not a valid address: "' + user + '"');

  const host = str(env, 'EMAIL_HOST', 'smtp.gmail.com');
  const port = int(env, 'EMAIL_PORT', 465, { min: 1, max: 65535 }, issues);
  const pass = str(env, 'EMAIL_PASS');

  const clientId = str(env, 'OAUTH_CLIENT_ID');
  const clientSecret = str(env, 'OAUTH_CLIENT_SECRET');
  const refreshToken = str(env, 'OAUTH_REFRESH_TOKEN');
  const oauthPresent = [clientId, clientSecret, refreshToken].filter(Boolean);

  /** @type {'oauth2'|'smtp'} */
  let driver = 'smtp';
  if (oauthPresent.length === 3) {
    driver = 'oauth2';
  } else if (oauthPresent.length > 0) {
    issues.push(
      'OAuth2 is only partly configured. Set OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET and ' +
        'OAUTH_REFRESH_TOKEN together, or leave all three empty.',
    );
  }

  if (!dryRun && driver === 'smtp' && !pass) {
    issues.push(
      'No usable credentials. Set EMAIL_PASS for SMTP, or all three OAUTH_* variables ' +
        'for OAuth2, or EMAIL_DRY_RUN=true for local testing.',
    );
  }

  const replyTo = str(env, 'EMAIL_REPLY_TO', PRIMARY_SENDER_ADDRESS).toLowerCase();
  if (!EMAIL_RE.test(replyTo)) issues.push('EMAIL_REPLY_TO is not a valid address: "' + replyTo + '"');

  const internalRecipients = emailList(
    env,
    'EMAIL_INTERNAL_RECIPIENTS',
    ['ariel@siddhayogaweb.com'],
    issues,
  );
  if (!internalRecipients.length) {
    issues.push('EMAIL_INTERNAL_RECIPIENTS resolved to an empty list, so internal alerts would go nowhere.');
  }

  // Language internal team alerts are written in. Customer mail picks its own
  // language per recipient (see services/email/i18n.js resolveLocale).
  const teamLocale = ['he', 'en'].includes(str(env, 'EMAIL_TEAM_LOCALE', 'en').toLowerCase())
    ? str(env, 'EMAIL_TEAM_LOCALE', 'en').toLowerCase()
    : 'en';

  const maxAttempts = int(env, 'EMAIL_MAX_ATTEMPTS', 3, { min: 1, max: 10 }, issues);
  const retryBaseMs = int(env, 'EMAIL_RETRY_BASE_MS', 500, { min: 50, max: 60000 }, issues);
  const queueConcurrency = int(env, 'EMAIL_QUEUE_CONCURRENCY', 2, { min: 1, max: 20 }, issues);

  if (issues.length) throw new EmailConfigError(issues);

  const fromName = str(env, 'EMAIL_FROM_NAME', PRIMARY_SENDER_NAME);

  return Object.freeze({
    driver,
    dryRun,
    host,
    port,
    secure: port === 465,
    user,
    pass,
    oauth: Object.freeze({
      clientId,
      clientSecret,
      refreshToken,
      accessUrl: str(env, 'OAUTH_ACCESS_URL', 'https://oauth2.googleapis.com/token'),
    }),
    fromName,
    fromAddress: user,
    from: fromName + ' <' + user + '>',
    replyTo,
    internalRecipients: Object.freeze(internalRecipients),
    teamLocale,
    maxAttempts,
    retryBaseMs,
    queueConcurrency,
    logLevel: str(env, 'LOG_LEVEL', 'info'),
  });
}

/** @type {Readonly<EmailConfig>|null} */
let cached = null;

/**
 * Returns the process-wide email configuration, building it on first use.
 *
 * @returns {Readonly<EmailConfig>} The validated configuration.
 * @throws {EmailConfigError} When the environment is invalid.
 */
export function getEmailConfig() {
  if (!cached) cached = buildEmailConfig();
  return cached;
}

/**
 * Clears the cached configuration so the next read re-validates the environment.
 * Intended for tests and for reloading after a credential rotation.
 *
 * @returns {void}
 */
export function resetEmailConfig() {
  cached = null;
}

/**
 * Reports whether a value is syntactically usable as a recipient address.
 *
 * @param {unknown} value - Candidate address.
 * @returns {boolean} True when the value is a well-formed address.
 */
export function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}
