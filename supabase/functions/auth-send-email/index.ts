// Supabase Auth "Send Email" hook for swg-crm (2026-11-23).
// Auth calls this function (Standard Webhooks signature) instead of its built-in mailer, so CRM account emails
// go through the CRM's EXISTING SMTP account (the same EMAIL_* secrets the email-worker already uses) and use
// scanner-safe links: the link opens the CRM with token_hash + type, and the one-time token is redeemed only when
// the person clicks "Activate account" (sb.auth.verifyOtp) — a mail scanner that merely opens the link cannot burn it.
// Secrets: SEND_EMAIL_HOOK_SECRET ("v1,whsec_..."), EMAIL_HOST/PORT/USER/PASS/FROM_NAME/REPLY_TO. Nothing is logged
// except a fixed outcome token and the action type (no address, no token).
import nodemailer from 'npm:nodemailer@6.9.14';
import { Webhook } from 'npm:standardwebhooks@1.0.0';

const HOOK_SECRET = (Deno.env.get('SEND_EMAIL_HOOK_SECRET') ?? '').replace(/^v1,whsec_/, '');
const EMAIL_HOST = Deno.env.get('EMAIL_HOST') ?? 'smtp.gmail.com';
const EMAIL_PORT = Number(Deno.env.get('EMAIL_PORT') ?? '465');
const EMAIL_USER = Deno.env.get('EMAIL_USER') ?? '';
const EMAIL_PASS = Deno.env.get('EMAIL_PASS') ?? '';
const EMAIL_FROM_NAME = Deno.env.get('EMAIL_FROM_NAME') ?? 'SWG CRM';
const EMAIL_REPLY_TO = Deno.env.get('EMAIL_REPLY_TO') ?? EMAIL_USER;
const ALLOWED_SITES = ['https://crm.micha-ai.com', 'https://swg-crm.pages.dev', 'https://full.swg-crm.pages.dev'];
const DEFAULT_SITE = 'https://swg-crm.pages.dev';

const transport = nodemailer.createTransport({ host: EMAIL_HOST, port: EMAIL_PORT, secure: EMAIL_PORT === 465, auth: { user: EMAIL_USER, pass: EMAIL_PASS } });

const COPY: Record<string, { subject: string; he: string; en: string; cta: string }> = {
  invite: { subject: 'SWG CRM — הפעלת חשבון / Activate your account', he: 'הוזמנת ל־SWG CRM. לחצו על הקישור ואז על "Activate account" כדי לבחור סיסמה.', en: 'You have been invited to SWG CRM. Open the link and click "Activate account" to choose your password.', cta: 'Activate / הפעלת החשבון' },
  recovery: { subject: 'SWG CRM — קביעת סיסמה / Set your password', he: 'לחצו על הקישור ואז על "Activate account" כדי לבחור סיסמה חדשה. אם לא ביקשתם — התעלמו מהמייל.', en: 'Open the link and click "Activate account" to choose a new password. If you did not ask for this, ignore this email.', cta: 'Set password / קביעת סיסמה' },
  signup: { subject: 'SWG CRM — אישור כתובת / Confirm your email', he: 'לחצו על הקישור ואז על "Activate account".', en: 'Open the link and click "Activate account".', cta: 'Confirm / אישור' },
  magiclink: { subject: 'SWG CRM — קישור כניסה / Sign-in link', he: 'לחצו על הקישור ואז על "Activate account".', en: 'Open the link and click "Activate account".', cta: 'Sign in / כניסה' },
};

function siteFor(redirectTo: string | undefined): string {
  try { const o = new URL(redirectTo ?? '').origin; if (ALLOWED_SITES.includes(o)) return o; } catch { /* default */ }
  return DEFAULT_SITE;
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const hookError = (status: number, message: string) =>
  new Response(JSON.stringify({ error: { http_code: status, message } }), { status, headers: { 'content-type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return hookError(405, 'method not allowed');
  if (!HOOK_SECRET || !EMAIL_PASS || !EMAIL_USER) { console.error('[auth-send-email] not_configured'); return hookError(500, 'email hook not configured'); }
  const raw = await req.text();
  let payload: { user?: { email?: string }; email_data?: { token_hash?: string; email_action_type?: string; redirect_to?: string } };
  try {
    payload = new Webhook(HOOK_SECRET).verify(raw, Object.fromEntries(req.headers)) as typeof payload;
  } catch { console.error('[auth-send-email] bad_signature'); return hookError(401, 'invalid signature'); }
  const to = payload.user?.email ?? '';
  const type = payload.email_data?.email_action_type ?? '';
  const tokenHash = payload.email_data?.token_hash ?? '';
  const copy = COPY[type];
  if (!copy || !/^[^@\s]+@[^@\s]+$/.test(to) || !/^[A-Za-z0-9_-]{10,200}$/.test(tokenHash)) {
    console.error('[auth-send-email] unsupported', type || '-'); return hookError(400, 'unsupported email action');
  }
  const link = `${siteFor(payload.email_data?.redirect_to)}/?token_hash=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(type)}`;
  const html = `<div dir="rtl" style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6">
<h2>SWG CRM</h2><p>${esc(copy.he)}</p>
<p><a href="${esc(link)}" style="display:inline-block;padding:10px 16px;background:#2563eb;color:#fff;border-radius:8px;text-decoration:none">${esc(copy.cta)}</a></p>
<p style="color:#666;font-size:13px">הקישור חד־פעמי ופג תוקף לאחר זמן קצר. / One-time link; it expires soon.</p>
<hr><p dir="ltr">${esc(copy.en)}</p></div>`;
  try {
    await transport.sendMail({ from: `${EMAIL_FROM_NAME} <${EMAIL_USER}>`, replyTo: EMAIL_REPLY_TO, to, subject: copy.subject, html, text: `${copy.en}\n${link}` });
    console.info('[auth-send-email] sent', type);
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  } catch {
    console.error('[auth-send-email] smtp_failed', type);
    return hookError(500, 'email could not be sent');
  }
});
