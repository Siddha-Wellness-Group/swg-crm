/**
 * @file Copies the shared email pieces into the Edge Function directory.
 *
 * The email service is authored once, for Node, under `src/services/email`.
 * The Supabase Edge Function that actually sends in production runs on Deno
 * and is deployed as a self-contained bundle, so it cannot reach up and out
 * of its own directory for templates.
 *
 * Rather than maintain two copies by hand, this script generates the Deno
 * side from the Node side:
 *
 *   src/services/email/templates/*.html  ->  functions/email-worker/_templates.ts
 *   src/services/email/i18n.js           ->  functions/email-worker/_i18n.js
 *
 * Both outputs are committed so a deploy never depends on someone having run
 * this first, and both are marked generated so nobody edits them by mistake.
 *
 * Usage:
 *   node scripts/sync-edge-email.js
 *
 * @module scripts/sync-edge-email
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_TEMPLATES = join(ROOT, 'src', 'services', 'email', 'templates');
const SRC_I18N = join(ROOT, 'src', 'services', 'email', 'i18n.js');
const OUT_DIR = join(ROOT, 'supabase', 'functions', 'email-worker');

const BANNER =
  '// GENERATED FILE - DO NOT EDIT.\n' +
  '// Produced by scripts/sync-edge-email.js from src/services/email.\n' +
  '// Edit the source there and re-run: node scripts/sync-edge-email.js\n\n';

/**
 * Inlines every HTML template as a string export, so the Deno bundle carries
 * them without needing filesystem access at runtime.
 *
 * @returns {Promise<string[]>} Names of the templates that were inlined.
 */
async function buildTemplates() {
  const files = (await readdir(SRC_TEMPLATES)).filter((f) => f.endsWith('.html')).sort();
  const entries = [];
  for (const file of files) {
    const name = file.replace(/\.html$/, '');
    const html = await readFile(join(SRC_TEMPLATES, file), 'utf8');
    // Backtick-safe: the templates contain no backticks or ${, but escape anyway.
    const escaped = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
    entries.push('  ' + JSON.stringify(name) + ': `' + escaped + '`,');
  }
  const out =
    BANNER +
    '/** Every email template, inlined so the Edge Function bundle is self-contained. */\n' +
    'export const TEMPLATES: Record<string, string> = {\n' +
    entries.join('\n') +
    '\n};\n';
  await writeFile(join(OUT_DIR, '_templates.ts'), out, 'utf8');
  return files.map((f) => f.replace(/\.html$/, ''));
}

/**
 * Copies i18n.js verbatim. It is pure JavaScript with no Node built-ins, so
 * Deno imports it unchanged.
 *
 * @returns {Promise<void>} Resolves once the copy is written.
 */
async function buildI18n() {
  const src = await readFile(SRC_I18N, 'utf8');
  await writeFile(join(OUT_DIR, '_i18n.js'), BANNER + src, 'utf8');
}

const names = await buildTemplates();
await buildI18n();
console.log('Synced to supabase/functions/email-worker/:');
console.log('  _templates.ts  (' + names.join(', ') + ')');
console.log('  _i18n.js');
