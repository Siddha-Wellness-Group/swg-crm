/**
 * @file Localisation for the automated email service.
 *
 * Each email goes out in ONE language, not bilingual. Layout lives in a
 * single template per email type; everything language-specific — copy,
 * text direction, alignment, date and money formatting — comes from here.
 * That way `he` and `en` can never drift apart structurally, which is what
 * happens once you maintain a separate HTML file per language.
 *
 * RTL rules applied (per the W3C bidi guidance and ItielMaN/rtl-guidelines):
 * the document gets `dir="rtl"`, alignment mirrors, but anything that must
 * stay left-to-right — tracking numbers, order numbers, addresses, URLs —
 * is wrapped in `dir="ltr"` inside the templates so the bidi algorithm
 * doesn't reorder it.
 *
 * @module services/email/i18n
 */

/** Languages the service can send in. */
export const LOCALES = ['he', 'en'];

/** Used when nothing about the recipient suggests a language. */
export const FALLBACK_LOCALE = 'en';

/**
 * The footer sentence the business requires on Hebrew customer mail.
 * Kept as an export so its exact wording lives in one place.
 */
export const FOOTER_NOTE_HE =
  'אם יש לך שאלות נוספות, ניתן להשיב למייל זה או ליצור קשר בכתובת customer@siddhayogaweb.com';

/** English counterpart to {@link FOOTER_NOTE_HE}. */
export const FOOTER_NOTE_EN =
  'If you have any further questions, simply reply to this email or write to us at customer@siddhayogaweb.com.';

/**
 * Every string the templates render, per locale.
 *
 * The brand name itself is deliberately NOT translated — real brands keep
 * their wordmark in its original script in every language.
 */
const COPY = {
  he: {
    dir: 'rtl',
    align: 'right',
    alignOpposite: 'left',
    intlLocale: 'he-IL',
    brandTagline: 'קבוצת סידהה וולנס',
    footerNote: FOOTER_NOTE_HE,
    transactionalNotice: 'זהו מייל תפעולי בנוגע להזמנה או לפנייה שלך אל Siddha Yoga Web Services.',
    greeting: 'שלום',

    orderConfirmation: {
      subject: (n) => 'אישור הזמנה ' + n,
      preheader: (n) => 'קיבלנו את הזמנה ' + n + '. אלו הפרטים.',
      headline: 'תודה על ההזמנה',
      intro:
        'ההזמנה שלך התקבלה ואנחנו מכינים אותה עכשיו. ' +
        'ברגע שהיא תישלח, יגיע מייל נוסף עם פרטי המעקב.',
      ctaLabel: 'לצפייה בהזמנה',
      labels: {
        orderNumber: 'מספר הזמנה',
        orderDate: 'תאריך הזמנה',
        items: 'הפריטים שהזמנת',
        subtotal: 'סכום ביניים',
        shipping: 'משלוח',
        discount: 'הנחה',
        tax: 'מע״מ',
        total: 'סה״כ',
        shippingTo: 'כתובת למשלוח',
      },
    },

    shippingUpdate: {
      subject: (n) => 'ההזמנה שלך נשלחה · ' + n,
      preheader: (t, c) => 'מספר מעקב ' + t + ' עם ' + c + '.',
      statusLabel: 'נשלח',
      headline: 'ההזמנה שלך בדרך אליך',
      intro: 'החבילה יצאה מאיתנו ונמצאת אצל חברת השילוח. אפשר לעקוב אחריה בפרטים שלמטה.',
      ctaLabel: 'מעקב אחר המשלוח',
      labels: {
        orderNumber: 'מספר הזמנה',
        carrier: 'חברת שילוח',
        tracking: 'מספר מעקב',
        eta: 'הגעה משוערת',
      },
    },

    internalAlert: {
      subjectPrefix: 'התראה',
      alertKind: 'התראה אוטומטית',
      ctaLabel: 'פתיחה ב-CRM',
      internalNotice: 'התראה פנימית מתוך שירות המייל של ה-CRM. לא נשלחה ללקוח.',
      labels: { details: 'פרטים' },
      priority: { low: 'עדיפות נמוכה', normal: 'רגיל', high: 'עדיפות גבוהה', critical: 'קריטי' },
    },

    autoReply: {
      subject: (id) => 'קיבלנו את פנייתך [' + id + ']',
      preheader: (id) => 'הפנייה שלך נרשמה תחת ' + id + '.',
      headline: 'קיבלנו את פנייתך',
      intro: 'תודה שפנית אלינו. הפנייה נרשמה ואחד מאנשי הצוות יטפל בה אישית.',
      responseTimeNote:
        'בדרך כלל אנחנו חוזרים תוך יום עסקים אחד. כדאי לשמור את מספר הפנייה ולציין אותו בכל תכתובת נוספת.',
      labels: { ticket: 'מספר הפנייה שלך' },
    },
  },

  en: {
    dir: 'ltr',
    align: 'left',
    alignOpposite: 'right',
    intlLocale: 'en-US',
    brandTagline: 'Siddha Wellness Group',
    footerNote: FOOTER_NOTE_EN,
    transactionalNotice:
      'This is a transactional message about your order or enquiry with Siddha Yoga Web Services.',
    greeting: 'Hello',

    orderConfirmation: {
      subject: (n) => 'Order ' + n + ' confirmed',
      preheader: (n) => 'We received order ' + n + '. Here is what is on the way.',
      headline: 'Thank you for your order',
      intro:
        'We have received your order and it is now being prepared. ' +
        'You will get a second email with tracking details the moment it ships.',
      ctaLabel: 'View your order',
      labels: {
        orderNumber: 'Order number',
        orderDate: 'Order date',
        items: 'What you ordered',
        subtotal: 'Subtotal',
        shipping: 'Shipping',
        discount: 'Discount',
        tax: 'VAT',
        total: 'Total',
        shippingTo: 'Shipping to',
      },
    },

    shippingUpdate: {
      subject: (n) => 'Order ' + n + ' is on its way',
      preheader: (t, c) => 'Tracking ' + t + ' with ' + c + '.',
      statusLabel: 'Shipped',
      headline: 'Your order is on its way',
      intro:
        'Your parcel has left us and is now with the carrier. Use the tracking details below to follow it.',
      ctaLabel: 'Track your parcel',
      labels: {
        orderNumber: 'Order number',
        carrier: 'Carrier',
        tracking: 'Tracking number',
        eta: 'Estimated delivery',
      },
    },

    internalAlert: {
      subjectPrefix: 'SWG',
      alertKind: 'Automated alert',
      ctaLabel: 'Open in the CRM',
      internalNotice:
        'Internal notification generated by the SWG CRM email service. Not sent to the customer.',
      labels: { details: 'Details' },
      priority: { low: 'Low', normal: 'Normal', high: 'High priority', critical: 'Critical' },
    },

    autoReply: {
      subject: (id) => 'We received your message [' + id + ']',
      preheader: (id) => 'Your enquiry is logged as ' + id + '.',
      headline: 'We received your message',
      intro:
        'Thank you for getting in touch. Your enquiry is logged and a member of the team will look at it personally.',
      responseTimeNote:
        'We usually reply within one business day. Keep this reference in any follow-up so we can find your conversation quickly.',
      labels: { ticket: 'Your reference' },
    },
  },
};

/**
 * Returns the copy bundle for a locale, falling back rather than throwing.
 *
 * @param {string} locale - Requested locale.
 * @returns {typeof COPY.en} The copy bundle.
 */
export function copyFor(locale) {
  return COPY[locale] || COPY[FALLBACK_LOCALE];
}

/** Matches any character in the Hebrew Unicode block. */
const HEBREW_RE = /[֐-׿]/;

/** Country values that mean Israel, however they arrive from a storefront. */
const ISRAEL_COUNTRIES = new Set(['il', 'isr', 'israel', 'ישראל', 'state of israel']);

/**
 * Decides which language to write to a recipient in.
 *
 * Ordered by how much the signal is actually *evidence* rather than a guess
 * about someone based on where they live:
 *
 * 1. An explicit `language` on the record — a human said so, it wins.
 * 2. **The script the customer typed in themselves.** If they wrote their own
 *    name or address in Hebrew letters, they read Hebrew. This is behaviour,
 *    not demographics, which makes it the strongest signal available.
 * 3. The shipping destination is Israel.
 * 4. An Israeli phone number (+972, or a local 0-prefixed mobile).
 * 5. Otherwise English — the safer default for an unknown international
 *    recipient, since a Hebrew email is unreadable to someone who doesn't
 *    read it, while English is widely understood in SWG's other markets.
 *
 * @param {object} signals - What is known about the recipient.
 * @param {string} [signals.language] - Explicit locale from the contact record.
 * @param {string} [signals.customerName] - Name as the customer entered it.
 * @param {string|Record<string, any>} [signals.shippingAddress] - Address as entered.
 * @param {string} [signals.country] - Country from the order or customer record.
 * @param {string} [signals.phone] - Phone number as entered.
 * @param {string} [signals.fallback] - Locale to use when nothing matches.
 * @returns {{locale: string, reason: string}} The chosen locale and why, for the logs.
 *
 * @example
 * resolveLocale({ customerName: 'דנה כהן' });
 * // => { locale: 'he', reason: 'hebrew-script-in-name' }
 * resolveLocale({ country: 'United States' });
 * // => { locale: 'en', reason: 'fallback' }
 */
export function resolveLocale(signals = {}) {
  const { language, customerName, shippingAddress, country, phone } = signals;
  const fallback = LOCALES.includes(signals.fallback) ? signals.fallback : FALLBACK_LOCALE;

  if (language && LOCALES.includes(String(language).toLowerCase().slice(0, 2))) {
    return { locale: String(language).toLowerCase().slice(0, 2), reason: 'explicit' };
  }

  if (customerName && HEBREW_RE.test(String(customerName))) {
    return { locale: 'he', reason: 'hebrew-script-in-name' };
  }

  const addressText =
    typeof shippingAddress === 'string'
      ? shippingAddress
      : shippingAddress
        ? Object.values(shippingAddress).filter((v) => typeof v === 'string').join(' ')
        : '';
  if (addressText && HEBREW_RE.test(addressText)) {
    return { locale: 'he', reason: 'hebrew-script-in-address' };
  }

  const countryText = String(
    country || (shippingAddress && typeof shippingAddress === 'object' ? shippingAddress.country : '') || '',
  )
    .trim()
    .toLowerCase();
  if (countryText && ISRAEL_COUNTRIES.has(countryText)) {
    return { locale: 'he', reason: 'shipping-to-israel' };
  }

  const digits = String(phone || '').replace(/[^\d+]/g, '');
  if (/^(\+?972|0(5|7|2|3|4|8|9))/.test(digits) && digits.length >= 9) {
    return { locale: 'he', reason: 'israeli-phone-number' };
  }

  return { locale: fallback, reason: 'fallback' };
}

/**
 * Formats a money amount for a locale.
 *
 * @param {number|string} amount - Amount to format. A string is passed through.
 * @param {string} currency - ISO 4217 code.
 * @param {string} locale - Target locale.
 * @returns {string} A display string, e.g. `₪242.00` or `242.00 ₪`.
 */
export function formatAmountFor(amount, currency, locale) {
  if (typeof amount === 'string') return amount;
  const value = Number(amount);
  if (!Number.isFinite(value)) return String(amount ?? '');
  try {
    return new Intl.NumberFormat(copyFor(locale).intlLocale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(value);
  } catch {
    return value.toFixed(2) + ' ' + currency;
  }
}

/**
 * Formats a date for a locale.
 *
 * @param {Date|string|number} [date] - Date to format. Defaults to now.
 * @param {string} locale - Target locale.
 * @returns {string} A short display date.
 */
export function formatDateFor(date, locale) {
  const d = date ? new Date(date) : new Date();
  if (Number.isNaN(d.getTime())) return String(date);
  try {
    return d.toLocaleDateString(copyFor(locale).intlLocale, {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  } catch {
    return d.toISOString().slice(0, 10);
  }
}
