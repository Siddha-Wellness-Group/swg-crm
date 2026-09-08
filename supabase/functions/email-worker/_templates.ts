// GENERATED FILE - DO NOT EDIT.
// Produced by scripts/sync-edge-email.js from src/services/email.
// Edit the source there and re-run: node scripts/sync-edge-email.js

/** Every email template, inlined so the Edge Function bundle is self-contained. */
export const TEMPLATES: Record<string, string> = {
  "autoReply": `<!doctype html>
<html dir="{{dir}}" lang="{{lang}}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>{{subject}}</title>
    <style>
      body { margin: 0; padding: 0; background: #f6f1e7; }
      table { border-collapse: collapse; }
      .swg-card { width: 600px; max-width: 100%; }
      @media only screen and (max-width: 620px) {
        .swg-card { width: 100% !important; }
        .swg-pad { padding-left: 24px !important; padding-right: 24px !important; }
        .swg-h1 { font-size: 21px !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; background:#f6f1e7;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0;">
      {{preheader}}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e7;">
      <tr>
        <td align="center" style="padding:40px 12px;">
          <table role="presentation" class="swg-card" width="600" cellpadding="0" cellspacing="0"
                 style="width:600px; max-width:100%; background:#ffffff; border:1px solid #e4dfd3;">

            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:28px 34px;">
                <span style="font-family:Georgia,'Times New Roman',serif; font-size:16px; font-weight:600; color:#2a2820;">{{brandName}}</span>
                <span style="font-family:Helvetica,Arial,sans-serif; font-size:13px; color:#9a937f;"> &middot; {{brandTagline}}</span>
              </td>
            </tr>
            <tr><td style="border-top:1px solid #e4dfd3; font-size:0; line-height:0;">&nbsp;</td></tr>

            <tr>
              <td class="swg-pad" dir="auto" style="padding:32px 34px 4px; unicode-bidi:plaintext;">
                <h1 class="swg-h1" style="margin:0; font-family:Helvetica,Arial,sans-serif; font-size:23px; line-height:1.35; font-weight:700; letter-spacing:-.3px; color:#2a2820;">
                  {{headline}}
                </h1>
                <p style="margin:14px 0 0; font-family:Helvetica,Arial,sans-serif; font-size:14px; line-height:1.7; color:#6b6553;">
                  {{greeting}} {{customerName}},<br />
                  {{intro}}
                </p>
              </td>
            </tr>

            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:26px 34px 0;">
                <div style="font-size:13px; font-weight:700; color:#2a2820; font-family:Helvetica,Arial,sans-serif;">{{labels.ticket}}</div>
                <div dir="ltr" style="font-size:16px; color:#a8703c; font-weight:700; margin-top:5px; font-family:Helvetica,Arial,sans-serif; text-align:{{align}};">{{ticketId}}</div>
              </td>
            </tr>

            <tr>
              <td class="swg-pad" dir="auto" style="padding:22px 34px 0; unicode-bidi:plaintext;">
                <p style="margin:0; font-family:Helvetica,Arial,sans-serif; font-size:14px; line-height:1.75; color:#6b6553;">
                  {{responseTimeNote}}
                </p>
              </td>
            </tr>

            <tr><td style="padding:8px 34px 0;"><div style="border-top:1px solid #e4dfd3; font-size:0; line-height:0; margin-top:24px;">&nbsp;</div></td></tr>
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:22px 34px 30px;">
                <p dir="auto" style="margin:0 0 16px; font-family:Helvetica,Arial,sans-serif; font-size:12.5px; line-height:1.7; color:#9a937f; unicode-bidi:plaintext;">
                  {{footerNote}}
                </p>
                <p style="margin:0; font-family:Helvetica,Arial,sans-serif; font-size:12.5px; line-height:1.8; color:#9a937f;">
                  {{brandName}}
                  &nbsp;&middot;&nbsp;
                  <a dir="ltr" href="mailto:{{supportEmail}}" style="color:#9a937f;">{{supportEmail}}</a>
                  {{#if websiteUrl}}
                  &nbsp;&middot;&nbsp;
                  <a dir="ltr" href="{{websiteUrl}}" style="color:#9a937f;">{{websiteLabel}}</a>
                  {{/if}}
                </p>
              </td>
            </tr>
          </table>

          <div style="font-family:Helvetica,Arial,sans-serif; font-size:11.5px; color:#9a937f; padding:18px 10px 0; max-width:600px;">
            {{transactionalNotice}}
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>
`,
  "internalAlert": `<!doctype html>
<html dir="{{dir}}" lang="{{lang}}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>{{subject}}</title>
    <style>
      body { margin: 0; padding: 0; background: #f6f1e7; }
      table { border-collapse: collapse; }
      .swg-card { width: 600px; max-width: 100%; }
      @media only screen and (max-width: 640px) {
        .swg-card { width: 100% !important; }
        .swg-pad { padding-left: 24px !important; padding-right: 24px !important; }
        .swg-h1 { font-size: 19px !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; background:#f6f1e7;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0;">
      {{preheader}}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e7;">
      <tr>
        <td align="center" style="padding:40px 12px;">
          <table role="presentation" class="swg-card" width="600" cellpadding="0" cellspacing="0"
                 style="width:600px; max-width:100%; background:#ffffff; border:1px solid #e4dfd3;">

            <!-- Priority stripe -->
            <tr>
              <td style="height:3px; background:{{priorityColor}}; font-size:0; line-height:0;">&nbsp;</td>
            </tr>

            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:24px 34px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="font-family:Helvetica,Arial,sans-serif; font-size:13px; color:#9a937f;">
                      {{brandName}} &middot; {{alertKind}}
                    </td>
                    <td align="right" style="font-family:Helvetica,Arial,sans-serif; font-size:13px; font-weight:700; color:{{priorityColor}};">
                      {{priorityLabel}}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr><td class="swg-pad" style="text-align:{{align}}; padding:0 34px;"><div style="border-top:1px solid #e4dfd3; font-size:0; line-height:0; margin-top:18px;">&nbsp;</div></td></tr>

            <tr>
              <td class="swg-pad" dir="auto" style="padding:24px 34px 0; unicode-bidi:plaintext;">
                <h1 class="swg-h1" style="margin:0; font-family:Helvetica,Arial,sans-serif; font-size:21px; line-height:1.4; font-weight:700; letter-spacing:-.2px; color:#2a2820;">
                  {{alertTitle}}
                </h1>
                <p style="margin:12px 0 0; font-family:Helvetica,Arial,sans-serif; font-size:14px; line-height:1.7; color:#6b6553; white-space:pre-line;">
                  {{message}}
                </p>
              </td>
            </tr>

            <!-- Payload -->
            {{#if payloadRows.length}}
            <tr><td class="swg-pad" style="text-align:{{align}}; padding:0 34px;"><div style="border-top:1px solid #e4dfd3; font-size:0; line-height:0; margin-top:22px;">&nbsp;</div></td></tr>
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:22px 34px 0;">
                <div style="font-family:Helvetica,Arial,sans-serif; font-size:13px; font-weight:700; color:#2a2820; padding-bottom:12px;">
                  {{labels.details}}
                </div>
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  {{#each payloadRows}}
                  <tr>
                    <td dir="auto" width="34%" style="padding:9px 0; border-top:1px solid #eee7d8; font-family:Helvetica,Arial,sans-serif; font-size:13px; color:#9a937f; vertical-align:top; unicode-bidi:plaintext;">
                      {{this.key}}
                    </td>
                    <td dir="auto" style="padding:9px 0; border-top:1px solid #eee7d8; font-family:Helvetica,Arial,sans-serif; font-size:13.5px; color:#2a2820; word-break:break-word; unicode-bidi:plaintext;">
                      {{this.value}}
                    </td>
                  </tr>
                  {{/each}}
                </table>
              </td>
            </tr>
            {{/if}}

            {{#if ctaUrl}}
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:26px 34px 0;">
                <a href="{{ctaUrl}}"
                   style="display:inline-block; background:#2a2820; color:#ffffff; text-decoration:none; font-family:Helvetica,Arial,sans-serif; font-size:13.5px; font-weight:700; padding:12px 26px;">
                  {{ctaLabel}}
                </a>
              </td>
            </tr>
            {{/if}}

            <tr><td style="padding:8px 34px 0;"><div style="border-top:1px solid #e4dfd3; font-size:0; line-height:0; margin-top:24px;">&nbsp;</div></td></tr>
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:20px 34px 28px;">
                <p style="margin:0 0 12px; font-family:Helvetica,Arial,sans-serif; font-size:12.5px; line-height:1.7; color:#9a937f;">
                  {{internalNotice}}
                </p>
                <p dir="auto" style="margin:0 0 12px; font-family:Helvetica,Arial,sans-serif; font-size:12.5px; line-height:1.7; color:#6b6553; unicode-bidi:plaintext;">
                  {{footerNote}}
                </p>
                <p style="margin:0; font-family:Helvetica,Arial,sans-serif; font-size:12.5px; line-height:1.8; color:#9a937f;">
                  {{brandName}}
                  &nbsp;&middot;&nbsp;
                  <a dir="ltr" href="mailto:{{supportEmail}}" style="color:#9a937f;">{{supportEmail}}</a>
                  &nbsp;&middot;&nbsp;<span dir="ltr">{{generatedAt}}</span>
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`,
  "orderConfirmation": `<!doctype html>
<html dir="{{dir}}" lang="{{lang}}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>{{subject}}</title>
    <style>
      /* Clients that support <style> get the polish; the rest fall back to inline styles. */
      body { margin: 0; padding: 0; background: #f6f1e7; }
      table { border-collapse: collapse; }
      img { border: 0; outline: none; display: block; }
      .swg-wrap { width: 100%; background: #f6f1e7; }
      .swg-card { width: 600px; max-width: 100%; }
      .swg-text { unicode-bidi: plaintext; }
      @media only screen and (max-width: 620px) {
        .swg-card { width: 100% !important; }
        .swg-pad { padding-left: 24px !important; padding-right: 24px !important; }
        .swg-h1 { font-size: 21px !important; }
        .swg-cta { display: block !important; text-align: center !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; background:#f6f1e7;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0;">
      {{preheader}}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
    </div>

    <table role="presentation" class="swg-wrap" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e7;">
      <tr>
        <td align="center" style="padding:40px 12px;">
          <table role="presentation" class="swg-card" width="600" cellpadding="0" cellspacing="0"
                 style="width:600px; max-width:100%; background:#ffffff; border:1px solid #e4dfd3;">

            <!-- Masthead -->
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:28px 34px;">
                <span style="font-family:Georgia,'Times New Roman',serif; font-size:16px; font-weight:600; color:#2a2820;">{{brandName}}</span>
                <span style="font-family:Helvetica,Arial,sans-serif; font-size:13px; color:#9a937f;"> &middot; {{brandTagline}}</span>
              </td>
            </tr>
            <tr><td style="border-top:1px solid #e4dfd3; font-size:0; line-height:0;">&nbsp;</td></tr>

            <!-- Headline -->
            <tr>
              <td class="swg-pad swg-text" dir="auto" style="text-align:{{align}}; padding:32px 34px 4px; unicode-bidi:plaintext;">
                <h1 class="swg-h1" style="margin:0; font-family:Helvetica,Arial,sans-serif; font-size:24px; line-height:1.35; font-weight:700; letter-spacing:-.3px; color:#2a2820;">
                  {{headline}}
                </h1>
                <p style="margin:14px 0 0; font-family:Helvetica,Arial,sans-serif; font-size:14px; line-height:1.7; color:#6b6553;">
                  {{greeting}} {{customerName}},<br />
                  {{intro}}
                </p>
              </td>
            </tr>

            <!-- Order meta -->
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:28px 34px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td dir="auto" width="50%" style="padding:0 0 22px; font-family:Helvetica,Arial,sans-serif; unicode-bidi:plaintext;">
                      <div style="font-size:13px; font-weight:700; color:#2a2820;">{{labels.orderNumber}}</div>
                      <div dir="ltr" style="font-size:14px; color:#6b6553; margin-top:5px; text-align:{{align}};">{{orderNumber}}</div>
                    </td>
                    <td dir="auto" width="50%" style="padding:0 0 22px; font-family:Helvetica,Arial,sans-serif; unicode-bidi:plaintext;">
                      <div style="font-size:13px; font-weight:700; color:#2a2820;">{{labels.orderDate}}</div>
                      <div style="font-size:14px; color:#6b6553; margin-top:5px;">{{orderDate}}</div>
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr><td class="swg-pad" style="text-align:{{align}}; padding:0 34px;"><div style="border-top:1px solid #e4dfd3; font-size:0; line-height:0;">&nbsp;</div></td></tr>

            <!-- Items -->
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:22px 34px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  {{#each items}}
                  <tr>
                    <td dir="auto" style="padding:14px 0; border-top:1px solid #eee7d8; font-family:Helvetica,Arial,sans-serif; font-size:14px; color:#2a2820; unicode-bidi:plaintext;">
                      {{this.name}}
                      {{#if this.variant}}
                      <div style="font-size:13px; color:#9a937f; margin-top:3px;">{{this.variant}}</div>
                      {{/if}}
                      <div style="font-size:13px; color:#9a937f; margin-top:3px;">&times; {{this.quantity}}</div>
                    </td>
                    <td dir="ltr" align="{{alignOpposite}}" style="padding:14px 0; border-top:1px solid #eee7d8; font-family:Helvetica,Arial,sans-serif; font-size:14px; color:#2a2820; white-space:nowrap; vertical-align:top;">
                      {{this.lineTotal}}
                    </td>
                  </tr>
                  {{/each}}
                  <tr>
                    <td dir="auto" style="padding:16px 0 0; border-top:1px solid #2a2820; font-family:Helvetica,Arial,sans-serif; font-size:15px; font-weight:700; color:#2a2820; unicode-bidi:plaintext;">
                      {{labels.total}}
                    </td>
                    <td dir="ltr" align="{{alignOpposite}}" style="padding:16px 0 0; border-top:1px solid #2a2820; font-family:Helvetica,Arial,sans-serif; font-size:15px; font-weight:700; color:#2a2820; white-space:nowrap;">
                      {{totalAmount}}
                    </td>
                  </tr>
                </table>
              </td>
            </tr>

            <!-- Shipping address -->
            {{#if shippingAddress}}
            <tr><td class="swg-pad" style="text-align:{{align}}; padding:0 34px;"><div style="border-top:1px solid #e4dfd3; font-size:0; line-height:0; margin-top:22px;">&nbsp;</div></td></tr>
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:22px 34px 0;">
                <div dir="auto" style="font-family:Helvetica,Arial,sans-serif; font-size:13px; font-weight:700; color:#2a2820; unicode-bidi:plaintext;">
                  {{labels.shippingTo}}
                </div>
                <div dir="auto" style="font-family:Helvetica,Arial,sans-serif; font-size:14px; line-height:1.6; color:#6b6553; margin-top:5px; unicode-bidi:plaintext;">
                  {{shippingAddress}}
                </div>
              </td>
            </tr>
            {{/if}}

            <!-- CTA -->
            {{#if ctaUrl}}
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:32px 34px 8px;">
                <a class="swg-cta" href="{{ctaUrl}}"
                   style="display:inline-block; background:#a8703c; color:#ffffff; text-decoration:none; font-family:Helvetica,Arial,sans-serif; font-size:14px; font-weight:700; padding:13px 28px; unicode-bidi:plaintext;">
                  {{ctaLabel}}
                </a>
              </td>
            </tr>
            {{/if}}

            <!-- Footer -->
            <tr><td style="padding:8px 34px 0;"><div style="border-top:1px solid #e4dfd3; font-size:0; line-height:0; margin-top:24px;">&nbsp;</div></td></tr>
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:22px 34px 30px;">
                <p dir="auto" style="margin:0 0 16px; font-family:Helvetica,Arial,sans-serif; font-size:12.5px; line-height:1.7; color:#9a937f; unicode-bidi:plaintext;">
                  {{footerNote}}
                </p>
                <p style="margin:0; font-family:Helvetica,Arial,sans-serif; font-size:12.5px; line-height:1.8; color:#9a937f;">
                  {{brandName}}
                  &nbsp;&middot;&nbsp;
                  <a dir="ltr" href="mailto:{{supportEmail}}" style="color:#9a937f;">{{supportEmail}}</a>
                  {{#if websiteUrl}}
                  &nbsp;&middot;&nbsp;
                  <a dir="ltr" href="{{websiteUrl}}" style="color:#9a937f;">{{websiteLabel}}</a>
                  {{/if}}
                </p>
              </td>
            </tr>
          </table>

          <div style="font-family:Helvetica,Arial,sans-serif; font-size:11.5px; color:#9a937f; padding:18px 10px 0; max-width:600px;">
            {{transactionalNotice}}
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>
`,
  "shippingUpdate": `<!doctype html>
<html dir="{{dir}}" lang="{{lang}}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>{{subject}}</title>
    <style>
      body { margin: 0; padding: 0; background: #f6f1e7; }
      table { border-collapse: collapse; }
      img { border: 0; outline: none; display: block; }
      .swg-card { width: 600px; max-width: 100%; }
      @media only screen and (max-width: 620px) {
        .swg-card { width: 100% !important; }
        .swg-pad { padding-left: 24px !important; padding-right: 24px !important; }
        .swg-h1 { font-size: 21px !important; }
        .swg-cta { display: block !important; text-align: center !important; }
      }
    </style>
  </head>
  <body style="margin:0; padding:0; background:#f6f1e7;">
    <div style="display:none; max-height:0; overflow:hidden; opacity:0;">
      {{preheader}}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
    </div>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f1e7;">
      <tr>
        <td align="center" style="padding:40px 12px;">
          <table role="presentation" class="swg-card" width="600" cellpadding="0" cellspacing="0"
                 style="width:600px; max-width:100%; background:#ffffff; border:1px solid #e4dfd3;">

            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:28px 34px;">
                <span style="font-family:Georgia,'Times New Roman',serif; font-size:16px; font-weight:600; color:#2a2820;">{{brandName}}</span>
                <span style="font-family:Helvetica,Arial,sans-serif; font-size:13px; color:#9a937f;"> &middot; {{brandTagline}}</span>
              </td>
            </tr>
            <tr><td style="border-top:1px solid #e4dfd3; font-size:0; line-height:0;">&nbsp;</td></tr>

            <tr>
              <td class="swg-pad" dir="auto" style="padding:32px 34px 4px; unicode-bidi:plaintext;">
                <div style="font-family:Helvetica,Arial,sans-serif; font-size:12.5px; font-weight:700; color:#5b6b4c; text-transform:uppercase; letter-spacing:.4px;">
                  {{statusLabel}}
                </div>
                <h1 class="swg-h1" style="margin:8px 0 0; font-family:Helvetica,Arial,sans-serif; font-size:24px; line-height:1.35; font-weight:700; letter-spacing:-.3px; color:#2a2820;">
                  {{headline}}
                </h1>
                <p style="margin:14px 0 0; font-family:Helvetica,Arial,sans-serif; font-size:14px; line-height:1.7; color:#6b6553;">
                  {{greeting}} {{customerName}},<br />
                  {{intro}}
                </p>
              </td>
            </tr>

            <!-- Tracking block -->
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:28px 34px 0;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td dir="auto" width="50%" style="padding:0 0 22px; font-family:Helvetica,Arial,sans-serif; unicode-bidi:plaintext;">
                      <div style="font-size:13px; font-weight:700; color:#2a2820;">{{labels.orderNumber}}</div>
                      <div dir="ltr" style="font-size:14px; color:#6b6553; margin-top:5px; text-align:{{align}};">{{orderNumber}}</div>
                    </td>
                    <td dir="auto" width="50%" style="padding:0 0 22px; font-family:Helvetica,Arial,sans-serif; unicode-bidi:plaintext;">
                      <div style="font-size:13px; font-weight:700; color:#2a2820;">{{labels.carrier}}</div>
                      <div style="font-size:14px; color:#6b6553; margin-top:5px;">{{carrierName}}</div>
                    </td>
                  </tr>
                  <tr><td colspan="2" style="border-top:1px solid #e4dfd3; padding:0; font-size:0; line-height:0;">&nbsp;</td></tr>
                  <tr>
                    <td dir="auto" width="50%" style="padding:18px 0 0; font-family:Helvetica,Arial,sans-serif; unicode-bidi:plaintext;">
                      <div style="font-size:13px; font-weight:700; color:#2a2820;">{{labels.tracking}}</div>
                      <div dir="ltr" style="font-size:15px; color:#5b6b4c; font-weight:600; margin-top:5px; text-align:{{align}};">{{trackingNumber}}</div>
                    </td>
                    {{#if estimatedDelivery}}
                    <td dir="auto" width="50%" style="padding:18px 0 0; font-family:Helvetica,Arial,sans-serif; unicode-bidi:plaintext;">
                      <div style="font-size:13px; font-weight:700; color:#2a2820;">{{labels.eta}}</div>
                      <div style="font-size:14px; color:#6b6553; margin-top:5px;">{{estimatedDelivery}}</div>
                    </td>
                    {{/if}}
                  </tr>
                </table>
              </td>
            </tr>

            {{#if trackingUrl}}
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:30px 34px 4px;">
                <a class="swg-cta" href="{{trackingUrl}}"
                   style="display:inline-block; background:#5b6b4c; color:#ffffff; text-decoration:none; font-family:Helvetica,Arial,sans-serif; font-size:14px; font-weight:700; padding:13px 28px;">
                  {{ctaLabel}}
                </a>
              </td>
            </tr>
            {{/if}}

            <tr><td style="padding:8px 34px 0;"><div style="border-top:1px solid #e4dfd3; font-size:0; line-height:0; margin-top:24px;">&nbsp;</div></td></tr>
            <tr>
              <td class="swg-pad" style="text-align:{{align}}; padding:22px 34px 30px;">
                <p dir="auto" style="margin:0 0 16px; font-family:Helvetica,Arial,sans-serif; font-size:12.5px; line-height:1.7; color:#9a937f; unicode-bidi:plaintext;">
                  {{footerNote}}
                </p>
                <p style="margin:0; font-family:Helvetica,Arial,sans-serif; font-size:12.5px; line-height:1.8; color:#9a937f;">
                  {{brandName}}
                  &nbsp;&middot;&nbsp;
                  <a dir="ltr" href="mailto:{{supportEmail}}" style="color:#9a937f;">{{supportEmail}}</a>
                  {{#if websiteUrl}}
                  &nbsp;&middot;&nbsp;
                  <a dir="ltr" href="{{websiteUrl}}" style="color:#9a937f;">{{websiteLabel}}</a>
                  {{/if}}
                </p>
              </td>
            </tr>
          </table>

          <div style="font-family:Helvetica,Arial,sans-serif; font-size:11.5px; color:#9a937f; padding:18px 10px 0; max-width:600px;">
            {{transactionalNotice}}
          </div>
        </td>
      </tr>
    </table>
  </body>
</html>
`,
};
