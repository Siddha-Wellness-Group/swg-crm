/**
 * @file One-time helper that mints a Gmail OAuth2 refresh token.
 *
 * Run this once per sender mailbox. It opens the Google consent screen for
 * `customer@siddhayogaweb.com`, catches the redirect on a local loopback
 * server, and exchanges the authorization code for a refresh token that
 * never needs to be minted again (as long as the OAuth consent screen is
 * "Internal", or the app is out of Testing mode — see the README).
 *
 * Prerequisites (see src/services/email/README.md "Getting real OAuth2
 * credentials" for the full walkthrough):
 *   1. A Google Cloud project with the Gmail API enabled.
 *   2. An OAuth client of type "Desktop app", giving OAUTH_CLIENT_ID and
 *      OAUTH_CLIENT_SECRET. Put both in .env before running this.
 *
 * Usage:
 *   node scripts/get-oauth-refresh-token.js
 *
 * @module scripts/get-oauth-refresh-token
 */

import { createServer } from 'node:http';
import { config as loadDotenv } from 'dotenv';

loadDotenv();

const CLIENT_ID = process.env.OAUTH_CLIENT_ID;
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET;
const PORT = 53682;
const REDIRECT_URI = 'http://127.0.0.1:' + PORT + '/oauth2callback';
const SCOPE = 'https://mail.google.com/';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    'Missing OAUTH_CLIENT_ID and/or OAUTH_CLIENT_SECRET in .env.\n' +
      'Create a "Desktop app" OAuth client in Google Cloud Console first ' +
      '(see src/services/email/README.md), then put both values in .env and re-run this.',
  );
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // required to receive a refresh_token
    prompt: 'consent', // forces a refresh_token even on repeat runs
    login_hint: 'customer@siddhayogaweb.com',
  });

console.log('\nSWG Gmail OAuth2 setup\n');
console.log('1. Open this URL and sign in as customer@siddhayogaweb.com:\n');
console.log('   ' + authUrl + '\n');
console.log('2. Approve access. You will land on a "connection refused" looking page —');
console.log('   that is expected, this script is the thing listening on that port.\n');
console.log('Waiting for the redirect on ' + REDIRECT_URI + ' ...\n');

/**
 * Exchanges an authorization code for tokens.
 *
 * @param {string} code - The `code` query parameter from the OAuth redirect.
 * @returns {Promise<{refresh_token?: string, access_token?: string, error?: string, error_description?: string}>} Google's token response.
 */
async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });
  return res.json();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  if (url.pathname !== '/oauth2callback') {
    res.writeHead(404).end();
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  if (error) {
    res.writeHead(200, { 'content-type': 'text/html' }).end('<h1>Denied</h1><p>' + error + '</p>');
    console.error('\nGoogle returned an error: ' + error);
    server.close();
    process.exit(1);
  }

  if (!code) {
    res.writeHead(400).end('Missing code');
    return;
  }

  res.writeHead(200, { 'content-type': 'text/html' }).end(
    '<h1>Done</h1><p>You can close this tab and go back to the terminal.</p>',
  );

  try {
    const tokens = await exchangeCode(code);
    server.close();

    if (!tokens.refresh_token) {
      console.error('\nNo refresh_token in the response:\n', tokens);
      console.error(
        '\nThis usually means you already authorized this app once before without ' +
          '"prompt=consent" taking effect, or you approved with an account other than ' +
          'customer@siddhayogaweb.com. Revoke access at ' +
          'https://myaccount.google.com/permissions and run this script again.',
      );
      process.exit(1);
    }

    console.log('\nSuccess. Add this line to your .env:\n');
    console.log('OAUTH_REFRESH_TOKEN=' + tokens.refresh_token);
    console.log('\nThen verify the connection with:\n');
    console.log('  node test-email.js --to customer@siddhayogaweb.com\n');
    process.exit(0);
  } catch (err) {
    console.error('\nToken exchange failed:', err);
    process.exit(1);
  }
});

server.listen(PORT);
