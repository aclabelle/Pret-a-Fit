/* ── api/renewal-reminders.js ─────────────────────────────────────────────
   Runs once a day (see "crons" in vercel.json) and emails subscribers before
   they're charged.

   WHY THIS EXISTS.  The Terms (section 7) and the refund policy both promise a
   reminder before renewal, and Paddle doesn't send one for monthly plans — its
   own auto-renewal reminder only covers plans of six months or longer.  A
   periodic billing notice is also a legal requirement in the UK (from
   January 2027), the EU and several US states.

   WHO GETS ONE.  Every active subscriber whose next charge is within the next
   7 days and who hasn't already been reminded about that charge.  Anyone set
   to end (they cancelled) is skipped, because nothing will be charged.

   HOW OFTEN.  Each subscriber chooses on their Profile:
     'every'     — before every charge (the default)
     'biannual'  — twice a year, which is the legal floor
   There is deliberately no "never".  "Twice a year" sends before the first
   charge that falls at least ~6 months after the last reminder (or after they
   subscribed).

   NEVER TWICE FOR THE SAME CHARGE.  After sending, the charge date is recorded
   on the account (publicMetadata.lastReminderFor), and anyone already reminded
   for that date is skipped.  If a daily run is ever missed, the next one still
   catches everyone due — just with a little less notice.

   ENVIRONMENT VARIABLES (Vercel):
     CRON_SECRET           required.  Vercel sends it with each scheduled run;
                           without it this file refuses to run at all.
     RESEND_API_KEY        already set (used by the contact and waitlist forms)
     CLERK_SECRET_KEY, PADDLE_API_KEY   already set
     REMINDER_FROM         optional.  Default: Prêt-à-Fit <support@pret-a-fit.com>.
                           Must be an address on a domain verified in Resend.
     REMINDERS_DRY_RUN     optional.  '1' = log who WOULD be emailed, send nothing.
     REMINDER_DAYS_AHEAD   optional.  Default 7.  Set to 31 briefly to send
                           yourself a real test before your test renewal is near.
   ──────────────────────────────────────────────────────────────────────── */

import { createClerkClient } from '@clerk/backend';
import { Resend } from 'resend';

const SITE = 'https://pret-a-fit.com';
const SUPPORT = 'support@pret-a-fit.com';
const DAY = 24 * 60 * 60 * 1000;
// "Twice a year": ~5.7 months, so the reminder lands before the charge that
// falls around the six-month mark rather than the one after it.
const BIANNUAL_GAP_DAYS = 173;

// Fallback wording if Paddle can't be asked for the exact amount.
const PLANS = {
  standard: { name: 'Standard', price: '$14' },
  premium:  { name: 'Premium',  price: '$29' },
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function paddleApiBase() {
  const env = (process.env.PADDLE_ENV || '').toLowerCase();
  if (env === 'production' || env === 'live') return 'https://api.paddle.com';
  if (env === 'sandbox') return 'https://sandbox-api.paddle.com';
  return (process.env.PADDLE_API_KEY || '').includes('_live_') ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
}

async function paddleGet(path) {
  const res = await fetch(paddleApiBase() + path, { headers: { Authorization: 'Bearer ' + process.env.PADDLE_API_KEY } });
  if (!res.ok) throw new Error('Paddle ' + res.status + ' on ' + path);
  return res.json();
}

/* ── Small formatting helpers ── */
export function formatMoney(minorUnits, currency) {
  const code = currency || 'USD';
  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: code });
  const digits = fmt.resolvedOptions().maximumFractionDigits;
  let s = fmt.format(Number(minorUnits) / Math.pow(10, digits));
  // Whole amounts read better without ".00" — "$14", not "$14.00".
  if (digits > 0) s = s.replace(/[.,]00(?=\D*$)/, '');
  return s;
}

export function dayMonth(iso) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
}

export function ordinalDay(iso) {
  const d = new Date(iso).getUTCDate();
  const s = (d % 100 >= 11 && d % 100 <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th');
  return d + s;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ── Who is due? ──────────────────────────────────────────────────────────
   Pure decision, kept separate so it can be tested on its own. Returns
   'every' | 'biannual' to send that kind of email, or a reason to skip. */
export function reminderDecision(pub, pref, now, daysAhead) {
  if (!pub || !pub.paddleSubscriptionId) return { send: false, why: 'not a subscriber' };
  if (pub.subscriptionStatus !== 'active') return { send: false, why: 'status ' + pub.subscriptionStatus };
  if (pub.scheduledChange && pub.scheduledChange.action === 'cancel') return { send: false, why: 'cancelling — no charge coming' };
  const due = Date.parse(pub.nextBilledAt);
  if (!Number.isFinite(due)) return { send: false, why: 'no renewal date' };
  if (due <= now) return { send: false, why: 'renewal date has passed' };
  if (due > now + daysAhead * DAY) return { send: false, why: 'not due yet' };
  if (pub.lastReminderFor === pub.nextBilledAt) return { send: false, why: 'already reminded for this charge' };

  if (pref === 'biannual') {
    const anchor = Date.parse(pub.lastReminderSentAt || pub.subscribedAt || '');
    // No history at all: send now (the safe side of a legal minimum), and the
    // six-month clock starts from this one.
    if (Number.isFinite(anchor) && now - anchor < BIANNUAL_GAP_DAYS * DAY) {
      return { send: false, why: 'twice-a-year: next one not due yet' };
    }
    return { send: true, kind: 'biannual' };
  }
  return { send: true, kind: 'every' };
}

/* ── What will they be charged, and how? ──
   Asks Paddle for the exact next charge (tax included, and in the currency
   they pay in).  Falls back to the plan's list price if Paddle can't say. */
async function chargeDetails(pub) {
  const tier = pub.pendingTier || pub.tier;    // a pending move down renews at Standard
  const plan = PLANS[tier] || PLANS.standard;
  const out = { planName: plan.name, amount: plan.price, method: 'your saved payment method' };

  try {
    const sub = await paddleGet('/subscriptions/' + encodeURIComponent(pub.paddleSubscriptionId) + '?include=next_transaction');
    const t = sub?.data?.next_transaction?.details?.totals;
    if (t && t.grand_total != null) {
      out.amount = formatMoney(t.grand_total, t.currency_code || sub.data.currency_code);
    }
  } catch (e) {
    console.warn('[REMINDERS] Could not get the exact amount for ' + pub.paddleSubscriptionId + ': ' + e.message);
  }

  // The card's last four digits come from their latest payment.  This needs
  // the "Transaction (read)" permission on the Paddle API key; without it the
  // email says "your saved payment method" instead, which is still correct.
  try {
    const tx = await paddleGet('/transactions?subscription_id=' + encodeURIComponent(pub.paddleSubscriptionId) +
      '&status=completed&order_by=billed_at[DESC]&per_page=1');
    const m = tx?.data?.[0]?.payments?.find(p => p.method_details)?.method_details;
    if (m?.card?.last4) out.method = 'the card ending ' + m.card.last4;
    else if (m?.type === 'paypal') out.method = 'your PayPal account';
  } catch (e) { /* keep the generic wording */ }

  return out;
}

/* ── The two emails (approved copy, 22 Nov 2026) ──
   Subject lines carry no brand name: the sender address already does. */
export function buildEmail(kind, { firstName, date, amount, planName, method }) {
  const hello = firstName ? 'Hello ' + firstName + ',' : 'Hello,';
  const manageUrl = SITE + '/?open=plan';
  const day = ordinalDay(date);
  const dm = dayMonth(date);

  if (kind === 'biannual') {
    const subject = 'Your Six-Month Check-In';
    const lines = [
      hello,
      "A quick note, because we said we'd check in twice a year.",
      "You're on " + planName + ', ' + amount + ' a month, renewing on the ' + day + '.',
      "If that still feels worth it, there's nothing to do.  If it doesn't, cancelling takes a couple of taps and you'll keep access to the end of the month you've paid for.",
    ];
    return { subject, ...render(lines, 'Manage subscription', manageUrl, null) };
  }

  const subject = 'Reminder: your monthly charge, ' + dm;
  const lines = [
    hello,
    amount + ' on ' + dm + ', to ' + method + ".  That's your " + planName + ' plan renewing.',
    "Nothing to do if that suits.  If it doesn't, cancel any time before then and you'll keep everything until the " + day + '.',
  ];
  return { subject, ...render(lines, 'Cancel or change plan', manageUrl,
    'Too many emails?  You can set these to twice a year instead, from your profile.') };
}

function render(lines, buttonText, buttonUrl, footnote) {
  const text = lines.join('\n\n') + '\n\n' + buttonText + ': ' + buttonUrl +
    (footnote ? '\n\n' + footnote : '') +
    '\n\n—\nPrêt-à-Fit · Questions? Just reply, or write to ' + SUPPORT;

  const para = (s) => '<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#3D3530;">' + esc(s) + '</p>';
  const html =
    '<div style="background:#F5F0E8;padding:32px 16px;font-family:system-ui,-apple-system,Segoe UI,sans-serif;">' +
      '<div style="max-width:520px;margin:0 auto;background:#F9F6F0;border:0.5px solid #EDE6D6;padding:32px 28px;">' +
        '<div style="font-family:Georgia,serif;font-size:18px;color:#1C1712;margin-bottom:24px;">prêt-à-<em style="color:#8B6F47;">fit</em></div>' +
        lines.map(para).join('') +
        '<p style="margin:24px 0;"><a href="' + esc(buttonUrl) + '" style="display:inline-block;padding:12px 28px;background:#1C1712;color:#F5F0E8;text-decoration:none;font-size:11px;letter-spacing:0.18em;text-transform:uppercase;">' + esc(buttonText) + '</a></p>' +
        (footnote ? '<p style="margin:0;font-size:12px;line-height:1.7;color:#8B6F47;">' + esc(footnote) + '</p>' : '') +
      '</div>' +
      '<p style="max-width:520px;margin:16px auto 0;font-size:11px;line-height:1.7;color:#8B6F47;text-align:center;">Questions?  Just reply, or write to ' + SUPPORT + '.</p>' +
    '</div>';
  return { text, html };
}

async function allUsers(clerk) {
  const users = [];
  for (let offset = 0; ; offset += 500) {
    const page = await clerk.users.getUserList({ limit: 500, offset });
    const batch = Array.isArray(page) ? page : (page?.data || []);
    users.push(...batch);
    if (batch.length < 500) break;
  }
  return users;
}

export async function GET(request) {
  // Only Vercel's scheduler (which sends CRON_SECRET) may run this — and if
  // the secret isn't set at all, nobody can.
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== 'Bearer ' + secret) {
    return json({ error: 'Unauthorized' }, 401);
  }
  if (!process.env.CLERK_SECRET_KEY || !process.env.RESEND_API_KEY) {
    console.error('[REMINDERS] CLERK_SECRET_KEY or RESEND_API_KEY missing.');
    return json({ error: 'Not configured' }, 500);
  }

  const dryRun = process.env.REMINDERS_DRY_RUN === '1';
  const daysAhead = Number(process.env.REMINDER_DAYS_AHEAD) > 0 ? Number(process.env.REMINDER_DAYS_AHEAD) : 7;
  const from = process.env.REMINDER_FROM || 'Prêt-à-Fit <' + SUPPORT + '>';
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const resend = new Resend(process.env.RESEND_API_KEY);
  const now = Date.now();
  const summary = { checked: 0, sent: 0, failed: 0, dryRun, daysAhead };

  for (const user of await allUsers(clerk)) {
    const pub = user.publicMetadata || {};
    if (!pub.paddleSubscriptionId) continue;
    summary.checked++;

    const pref = user.unsafeMetadata?.pretafit_profile?.billingEmails === 'biannual' ? 'biannual' : 'every';
    const decision = reminderDecision(pub, pref, now, daysAhead);
    if (!decision.send) continue;

    const to = user.primaryEmailAddress?.emailAddress
      || user.emailAddresses?.find(e => e.id === user.primaryEmailAddressId)?.emailAddress
      || user.emailAddresses?.[0]?.emailAddress;
    if (!to) { console.warn('[REMINDERS] No email address for ' + user.id); continue; }

    try {
      const d = await chargeDetails(pub);
      const email = buildEmail(decision.kind, {
        firstName: (user.firstName || '').trim(),
        date: pub.nextBilledAt,
        amount: d.amount,
        planName: d.planName,
        method: d.method,
      });

      if (dryRun) {
        console.log('[REMINDERS] DRY RUN would send "' + email.subject + '" to ' + user.id + ' (' + decision.kind + ')');
        summary.sent++;
        continue;
      }

      const { error } = await resend.emails.send({
        from, to, replyTo: SUPPORT, subject: email.subject, text: email.text, html: email.html,
      });
      if (error) throw new Error(error.message || JSON.stringify(error));

      // Record it, so this charge is never reminded twice.
      await clerk.users.updateUserMetadata(user.id, {
        publicMetadata: { lastReminderFor: pub.nextBilledAt, lastReminderSentAt: new Date(now).toISOString(), lastReminderKind: decision.kind },
      });
      summary.sent++;
      console.log('[REMINDERS] Sent ' + decision.kind + ' reminder to ' + user.id + ' for ' + pub.nextBilledAt);
    } catch (e) {
      summary.failed++;
      console.error('[REMINDERS] Failed for ' + user.id + ': ' + (e?.message || e));
    }
  }

  console.log('[REMINDERS] ' + JSON.stringify(summary));
  return json(summary);
}
