/**
 * SWG Receipts Robot — Google Apps Script
 *
 * Once a day:
 *   1. Finds new billing emails from SWG's subscription vendors in Gmail.
 *   2. Saves each receipt as a PDF in Drive:  SWG Receipts / YYYY-MM /
 *   3. Logs it in the "SWG Receipts Log" sheet (date, vendor, amount, PDF link).
 *   4. Emails Daniel one summary with all new receipts attached.
 *
 * Setup: paste into script.google.com, run `setup` once, approve permissions.
 * See README.md in this folder.
 */

const CONFIG = {
  // Who gets the receipts
  RECIPIENT: 'land.daniel@gmail.com',

  // Drive folder (created in My Drive if missing)
  ROOT_FOLDER_NAME: 'SWG Receipts',

  // Log spreadsheet (created inside the root folder if missing)
  LOG_SHEET_NAME: 'SWG Receipts Log',

  // Gmail label added to processed threads (visual marker only)
  PROCESSED_LABEL: 'SWG/Receipts-Sent',

  // How far back each run looks. Duplicates are prevented by the log sheet.
  LOOKBACK: 'newer_than:45d',

  // One entry per subscription. `query` is a normal Gmail search.
  // Adjust these if a vendor's receipts are missed — test them in the Gmail search bar first.
  VENDORS: [
    { name: 'Claude (Anthropic)', query: 'from:anthropic (receipt OR invoice OR payment)' },
    { name: 'Base44',             query: 'from:base44 (receipt OR invoice OR payment)' },
    { name: 'Google Workspace',   query: 'from:payments-noreply@google.com "Google Workspace"' },
    { name: 'GitHub',             query: 'from:github.com (receipt OR "payment receipt" OR invoice)' },
  ],
};

const LOG_HEADERS = ['Logged at', 'Email date', 'Vendor', 'Subject', 'Amount', 'Currency', 'PDF', 'Message ID'];

/* ------------------------------------------------------------------ */
/* Entry points                                                        */
/* ------------------------------------------------------------------ */

/** Run once: creates folder + log sheet + daily trigger, then does a first pass. */
function setup() {
  getRootFolder_();
  getLogSheet_();
  getOrCreateLabel_();

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processReceipts')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processReceipts').timeBased().everyDays(1).atHour(9).create();

  processReceipts();
  Logger.log('Setup done. Runs daily around 09:00 (script time zone).');
}

/** Shows what WOULD be sent, without saving, logging or emailing anything. */
function dryRun() {
  findNewReceipts_().forEach(r =>
    Logger.log(`${r.vendor} | ${r.date.toDateString()} | ${r.subject} | ${r.amount || '?'} ${r.currency || ''}`)
  );
}

/** Main job (called by the daily trigger). */
function processReceipts() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    const receipts = findNewReceipts_();
    if (!receipts.length) {
      Logger.log('No new receipts.');
      return;
    }

    const sheet = getLogSheet_();
    const label = getOrCreateLabel_();
    const attachments = [];

    receipts.forEach(r => {
      const pdf = toPdf_(r.message, r.vendor, r.date);
      const file = getMonthFolder_(r.date).createFile(pdf);
      attachments.push(file.getBlob());
      r.pdfUrl = file.getUrl();

      sheet.appendRow([
        new Date(), r.date, r.vendor, r.subject,
        r.amount === null ? '' : r.amount, r.currency || '',
        r.pdfUrl, r.message.getId(),
      ]);
      r.message.getThread().addLabel(label);
    });

    sendSummary_(receipts, attachments);
    Logger.log(`Sent ${receipts.length} receipt(s) to ${CONFIG.RECIPIENT}.`);
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ */
/* Gmail                                                               */
/* ------------------------------------------------------------------ */

function findNewReceipts_() {
  const seen = loggedMessageIds_();
  const found = [];

  CONFIG.VENDORS.forEach(v => {
    const threads = GmailApp.search(`${v.query} ${CONFIG.LOOKBACK}`, 0, 50);
    threads.forEach(thread => {
      thread.getMessages().forEach(msg => {
        const id = msg.getId();
        if (seen.has(id)) return;
        // Skip messages we sent ourselves (e.g. the summary email).
        if (msg.getFrom().indexOf(Session.getActiveUser().getEmail()) !== -1) return;
        seen.add(id);
        const { amount, currency } = extractAmount_(msg.getPlainBody() || '');
        found.push({
          message: msg, vendor: v.name, subject: msg.getSubject(),
          date: msg.getDate(), amount, currency,
        });
      });
    });
  });

  return found.sort((a, b) => a.date - b.date);
}

function getOrCreateLabel_() {
  return GmailApp.getUserLabelByName(CONFIG.PROCESSED_LABEL) ||
         GmailApp.createLabel(CONFIG.PROCESSED_LABEL);
}

/** Best-effort: finds the "Total"/"Amount" line, else the largest money value in the email. */
function extractAmount_(text) {
  const money = /(₪|\$|€|ILS|USD|EUR)\s?([0-9]{1,3}(?:[,][0-9]{3})*(?:\.[0-9]{1,2})?|[0-9]+(?:\.[0-9]{1,2})?)|([0-9]+(?:[.,][0-9]{1,2})?)\s?(₪|ILS|USD|EUR)/g;
  const symbolToCode = { '₪': 'ILS', '$': 'USD', '€': 'EUR' };

  const parse = m => {
    const cur = m[1] || m[4];
    const num = parseFloat(String(m[2] || m[3]).replace(/,/g, ''));
    return { amount: isNaN(num) ? null : num, currency: symbolToCode[cur] || cur };
  };

  // Prefer a line that says total / amount paid / amount charged.
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (/\b(total|amount (paid|charged|due)|charged)\b/i.test(line)) {
      const m = new RegExp(money.source).exec(line);
      if (m) return parse(m);
    }
  }

  let best = { amount: null, currency: null };
  let m;
  while ((m = money.exec(text)) !== null) {
    const p = parse(m);
    if (p.amount !== null && (best.amount === null || p.amount > best.amount)) best = p;
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* PDF + Drive                                                         */
/* ------------------------------------------------------------------ */

/** Uses the vendor's own PDF attachment if there is one, otherwise prints the email to PDF. */
function toPdf_(msg, vendor, date) {
  const stamp = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const base = `${stamp} - ${vendor}`;

  const pdfAttachment = msg.getAttachments().find(a => a.getContentType() === 'application/pdf');
  if (pdfAttachment) return pdfAttachment.copyBlob().setName(`${base}.pdf`);

  const html =
    `<div style="font-family:Arial,sans-serif;font-size:12px;color:#555;margin-bottom:12px">` +
    `<b>From:</b> ${escapeHtml_(msg.getFrom())}<br>` +
    `<b>Date:</b> ${escapeHtml_(String(msg.getDate()))}<br>` +
    `<b>Subject:</b> ${escapeHtml_(msg.getSubject())}</div><hr>` +
    msg.getBody();
  return Utilities.newBlob(html, 'text/html', `${base}.html`).getAs('application/pdf').setName(`${base}.pdf`);
}

function getRootFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('ROOT_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* deleted — recreate */ }
  }
  const it = DriveApp.getFoldersByName(CONFIG.ROOT_FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.ROOT_FOLDER_NAME);
  props.setProperty('ROOT_FOLDER_ID', folder.getId());
  return folder;
}

function getMonthFolder_(date) {
  const name = Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy-MM');
  const root = getRootFolder_();
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function getLogSheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('LOG_SHEET_ID');
  if (id) {
    try { return SpreadsheetApp.openById(id).getSheets()[0]; } catch (e) { /* deleted — recreate */ }
  }
  const ss = SpreadsheetApp.create(CONFIG.LOG_SHEET_NAME);
  const file = DriveApp.getFileById(ss.getId());
  file.moveTo(getRootFolder_());
  const sheet = ss.getSheets()[0];
  sheet.setName('Receipts');
  sheet.appendRow(LOG_HEADERS);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold');
  props.setProperty('LOG_SHEET_ID', ss.getId());
  return sheet;
}

function loggedMessageIds_() {
  const sheet = getLogSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return new Set();
  const col = LOG_HEADERS.indexOf('Message ID') + 1;
  return new Set(sheet.getRange(2, col, last - 1, 1).getValues().map(r => String(r[0])));
}

/* ------------------------------------------------------------------ */
/* Email to Daniel                                                     */
/* ------------------------------------------------------------------ */

function sendSummary_(receipts, attachments) {
  const tz = Session.getScriptTimeZone();
  const rows = receipts.map(r => `
    <tr>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${Utilities.formatDate(r.date, tz, 'dd MMM yyyy')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee">${escapeHtml_(r.vendor)}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${r.amount === null ? '—' : r.amount.toFixed(2) + ' ' + (r.currency || '')}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee"><a href="${r.pdfUrl}">PDF</a></td>
    </tr>`).join('');

  const logUrl = SpreadsheetApp.openById(
    PropertiesService.getScriptProperties().getProperty('LOG_SHEET_ID')).getUrl();

  const html = `
    <div style="font-family:Arial,sans-serif;font-size:14px;color:#222">
      <p>Hi Daniel,</p>
      <p>${receipts.length} new SWG subscription receipt${receipts.length > 1 ? 's' : ''} — PDFs attached.</p>
      <table style="border-collapse:collapse;font-size:13px">
        <tr style="background:#f5f5f5">
          <th style="padding:6px 10px;text-align:left">Date</th>
          <th style="padding:6px 10px;text-align:left">Vendor</th>
          <th style="padding:6px 10px;text-align:right">Amount</th>
          <th style="padding:6px 10px;text-align:left">File</th>
        </tr>${rows}
      </table>
      <p style="font-size:12px;color:#777">Full log: <a href="${logUrl}">${CONFIG.LOG_SHEET_NAME}</a><br>
      Sent automatically by the SWG Receipts Robot.</p>
    </div>`;

  const month = Utilities.formatDate(new Date(), tz, 'MMM yyyy');
  GmailApp.sendEmail(CONFIG.RECIPIENT,
    `SWG receipts — ${receipts.map(r => r.vendor).join(', ')} (${month})`,
    'New SWG receipts attached. Open in an HTML-capable mail client for the summary table.',
    { htmlBody: html, attachments, name: 'SWG Receipts Robot' });
}

function escapeHtml_(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
