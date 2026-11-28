/* ── api/gift.js ──────────────────────────────────────────────────────────
   Gifts: someone pays once for 3, 6 or 12 months of Standard or Premium for
   a friend.  Added 28 Nov 2026.

   HOW A GIFT WORKS
   • Buying.  The gift page opens a normal Paddle checkout for a one-off
     (non-renewing) price, with customData.gift = 'true'.  When Paddle says
     the payment is complete, api/paddle-webhook.js hands the transaction to
     recordGiftPurchase() below, which stores the gift on the BUYER's account
     (privateMetadata.giftsSent — never readable from a browser) and emails
     the claim link: to the friend, the buyer, or both.
   • The claim link is  https://pret-a-fit.com/?gift=<buyer's user id>.<gift id>
     The gift id is 16 random characters (80 bits), so links can't be guessed.
   • Claiming (action 'redeem', signed in).  Nothing renews and the friend is
     never asked for a card.  What happens depends on who claims it:
       – No subscription (or one that's ending): "prepaid access".  The gift is
         written to the friend's publicMetadata.gifts as kind 'access', from
         now (or from the day their paid month ends, or the day an earlier gift
         ends) for N months.  The app treats them as a subscriber at that tier.
       – An active subscription: the gift pays for their next N renewals.  A
         Paddle discount is created and added to their subscription from the
         next billing period, for N billing periods, then stops by itself.
         It is a percentage of THEIR plan's price matching the gift's value:
         Standard gift on Standard 100%, Premium gift on Standard 100% (and the
         app gives them Premium for those months), Standard gift on Premium
         ~48% (they pay $15 instead of $29).  Recorded as kind 'discount'.
         Plan changes wait until it ends (api/billing.js), because a
         percentage worked out for one price would be wrong on another.
   • Single use: the buyer's record is marked claimed BEFORE anything is
     granted, and put back if granting fails.  Before claiming, Paddle is
     asked whether the purchase was refunded; a refunded gift can't be claimed.
   • A buyer can't claim their own gift — so clicking the link in their own
     confirmation email can't use it up by accident.

   WHICH PAYMENT IS WHICH GIFT.  Worked out from the price's amount in USD
   (GIFT_AMOUNTS below), never from the checkout's custom data — a buyer
   could alter that, but not what they paid for.  If the prices ever change,
   change GIFT_AMOUNTS (and GIFT_PRICE_IDS in index.html) to match.

   ACTIONS (POST, JSON):
     { action: 'lookup', token }        no sign-in: what the gift is, who it's
                                        from, the message, whether it's claimed
     { action: 'redeem', token }        signed in (Bearer Clerk token)
     { action: 'sent' }                 signed in: the gifts I've given

   ENVIRONMENT VARIABLES: CLERK_SECRET_KEY, PADDLE_API_KEY, RESEND_API_KEY
   (all already set), REMINDER_FROM (optional, as for the reminder emails).
   The Paddle API key needs Discounts (write) for gifts to subscribers.
   ──────────────────────────────────────────────────────────────────────── */

import crypto from 'node:crypto';
import { createClerkClient, verifyToken } from '@clerk/backend';
import { Resend } from 'resend';
import { render, dayMonth } from './renewal-reminders.js';

const SITE = 'https://pret-a-fit.com';
const SUPPORT = 'support@pret-a-fit.com';
const DAY = 24 * 60 * 60 * 1000;

export const TIERS = {
  standard: { name: 'Standard', monthly: 1400, searches: 20 },
  premium:  { name: 'Premium',  monthly: 2900, searches: 50 },
};
export const GIFT_MONTHS = [3, 6, 12];

/* USD cents → what was bought.  Straight multiples of the monthly price, no
   discount built in (special offers are Paddle discount codes at checkout,
   which lower what's paid but not the price's own amount). */
export const GIFT_AMOUNTS = {};
for (const [tier, t] of Object.entries(TIERS)) {
  for (const m of GIFT_MONTHS) GIFT_AMOUNTS[t.monthly * m] = { tier, months: m };
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function paddleApiBase() {
  const env = (process.env.PADDLE_ENV || '').toLowerCase();
  if (env === 'production' || env === 'live') return 'https://api.paddle.com';
  if (env === 'sandbox') return 'https://sandbox-api.paddle.com';
  return (process.env.PADDLE_API_KEY || '').includes('_live_') ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
}

async function paddle(method, path, body) {
  const res = await fetch(paddleApiBase() + path, {
    method,
    headers: { Authorization: 'Bearer ' + process.env.PADDLE_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const detail = data?.error?.detail || data?.error?.code || ('HTTP ' + res.status);
    console.error('[GIFT] Paddle ' + method + ' ' + path + ' failed: ' + detail);
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ── Small helpers (exported for the tests) ── */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function newGiftId() {
  const bytes = crypto.randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) out += B32[bytes[i] % 32];
  return out;
}

export function giftLink(buyerId, giftId) {
  return SITE + '/?gift=' + encodeURIComponent(buyerId + '.' + giftId);
}

export function parseToken(token) {
  const m = /^([A-Za-z0-9_]{2,64})\.([A-Z2-7]{16})$/.exec(String(token || '').trim());
  return m ? { buyerId: m[1], giftId: m[2] } : null;
}

/* Same day N months later; the 31st becomes the last day of a shorter month. */
export function addMonths(iso, months) {
  const d = new Date(iso);
  const day = d.getUTCDate();
  const out = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1,
    d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds()));
  const last = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
  out.setUTCDate(Math.min(day, last));
  return out.toISOString();
}

export function cleanText(s, max) {
  return String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function validEmail(s) {
  const e = String(s || '').trim();
  return e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

function firstNameOf(user) {
  return cleanText(user?.firstName, 40);
}

function emailOf(user) {
  return user?.primaryEmailAddress?.emailAddress
    || user?.emailAddresses?.find(e => e.id === user.primaryEmailAddressId)?.emailAddress
    || user?.emailAddresses?.[0]?.emailAddress || '';
}

/* What a gift is worth against a subscriber's own plan, as a percentage of
   their price (2 decimal places, at most 100). */
export function giftPercent(giftTier, subTier) {
  const g = TIERS[giftTier]?.monthly, s = TIERS[subTier]?.monthly;
  if (!g || !s) return 100;
  return Math.min(100, Math.round((g / s) * 10000) / 100);
}

/* Which payment is which gift — from the transaction itself. */
export function giftsFromTransaction(txn) {
  if (!txn || txn.subscription_id) return [];      // a subscription payment, not a gift
  const out = [];
  for (const item of txn.items || []) {
    const price = item.price || {};
    if (price.billing_cycle) continue;               // recurring price: not a gift
    const unit = price.unit_price || {};
    if ((unit.currency_code || 'USD') !== 'USD') continue;
    const g = GIFT_AMOUNTS[Number(unit.amount)];
    if (!g) continue;
    const qty = Math.max(1, Math.min(10, Number(item.quantity) || 1));
    for (let i = 0; i < qty; i++) out.push({ ...g });
  }
  return out;
}

/* The access window a new claim would get, for someone without an active
   subscription.  Starts now, or when their paid month ends (they cancelled),
   or when their latest prepaid gift ends — whichever is latest. */
export function accessStart(pub, nowIso) {
  let start = Date.parse(nowIso);
  const ending = pub?.scheduledChange?.action === 'cancel' && pub?.subscriber === true;
  if (ending) {
    const end = Date.parse(pub.scheduledChange.effectiveAt || pub.periodEnd || '');
    if (Number.isFinite(end) && end > start) start = end;
  }
  for (const g of (pub?.gifts || [])) {
    if (g.kind !== 'access') continue;
    const e = Date.parse(g.end);
    if (Number.isFinite(e) && e > start) start = e;
  }
  return new Date(start).toISOString();
}

export function hasActiveSubscription(pub) {
  return !!(pub && pub.paddleSubscriptionId && pub.subscriptionStatus === 'active' && pub.subscriber === true
    && !(pub.scheduledChange && pub.scheduledChange.action === 'cancel'));
}

/* A gift already paying for this subscriber's renewals (or about to). */
export function runningDiscountGift(pub, now) {
  return (pub?.gifts || []).find(g => g.kind === 'discount' && Date.parse(g.end) > now) || null;
}

/* ── Emails ── */

export function buildGiftEmails({ fromName, toName, toEmail, deliver, tier, months, message, link, buyerFirst }) {
  const plan = TIERS[tier];
  const from = fromName || 'Someone';
  const lines = [
    toName ? 'Hello ' + toName + ',' : 'Hello,',
    from + ' has given you ' + months + ' months of Prêt-à-Fit ' + plan.name + ': ' + plan.searches +
      ' searches a month, photo body and colour analysis, unlimited fit checks and your own shopping guide.',
  ];
  if (message) lines.push('“' + message + '” — ' + from);
  lines.push("Nothing renews, and you won't be asked for a card.  If you already subscribe, it pays for your next " + months + ' renewals instead.');
  const toFriend = {
    subject: 'A gift from ' + from,
    ...render(lines, 'Claim your gift', link, "This link is just for you, so keep it to yourself until you've claimed it."),
  };

  const bl = [
    buyerFirst ? 'Hello ' + buyerFirst + ',' : 'Hello,',
    'Thank you.  Your gift of ' + months + ' months of ' + plan.name + (toName ? ' for ' + toName : '') + ' is ready.',
    deliver === 'them' && toEmail
      ? "We've emailed it to " + toEmail + ".  If it doesn't arrive, send them this link yourself:"
      : "Here's the link to pass on — by message, in a card, however you like:",
    link,
    "Please don't open it yourself: it's for " + (toName || 'them') + ' to claim.  You can find it again on your Profile, under Gifts.',
    "Changed your mind?  Gifts can be refunded within 14 days, as long as they haven't been claimed — just reply to this email.",
  ];
  const toBuyer = {
    subject: 'Your gift' + (toName ? ' for ' + toName : ''),
    ...render(bl, 'See your gifts', SITE + '/?open=gifts', null),
  };
  return { toFriend, toBuyer };
}

export function buildGiftEndingEmail({ firstName, tier, fromName, end }) {
  const plan = TIERS[tier] || TIERS.standard;
  const lines = [
    firstName ? 'Hello ' + firstName + ',' : 'Hello,',
    'Your ' + plan.name + ' gift' + (fromName ? ' from ' + fromName : '') + ' ends on ' + dayMonth(end) + '.  Nothing will be charged — gifts never renew.',
    "If you'd like to carry on, you can subscribe from your Profile from the " + dayMonth(end) +
      ': Standard is $14 a month for 20 searches, Premium $29 for 50.  Your profile, saved pieces and searches stay with you either way.',
  ];
  return { subject: 'Your gift ends on ' + dayMonth(end), ...render(lines, 'Your profile', SITE + '/?open=plan', null) };
}

/* Sent 7 days before a prepaid gift runs out, once, to anyone not paying by
   then.  Pure decision, tested on its own; called from the daily reminders job. */
export function giftEndingDecision(pub, now, daysAhead = 7) {
  const access = (pub?.gifts || []).filter(g => g.kind === 'access');
  if (!access.length) return { send: false, why: 'no prepaid gift' };
  const last = access.reduce((a, b) => (Date.parse(b.end) > Date.parse(a.end) ? b : a));
  const end = Date.parse(last.end);
  if (!Number.isFinite(end) || end <= now) return { send: false, why: 'ended' };
  if (end > now + daysAhead * DAY) return { send: false, why: 'not due yet' };
  if (pub.lastGiftReminderFor === last.end) return { send: false, why: 'already reminded' };
  if (hasActiveSubscription(pub)) return { send: false, why: 'subscribes already' };
  return { send: true, gift: last };
}

/* ── Called by api/paddle-webhook.js on transaction.completed ── */
export async function recordGiftPurchase(clerk, txn) {
  const cd = txn?.custom_data || {};
  const buyerId = cd.clerk_user_id;
  const bought = giftsFromTransaction(txn);
  if (!bought.length) {
    console.error('[GIFT] Transaction ' + txn?.id + ' is marked as a gift but its price is not a gift price.  Check GIFT_AMOUNTS.');
    return { ok: false, why: 'not a gift price' };
  }
  if (!buyerId) {
    console.error('[GIFT] Gift transaction ' + txn?.id + ' has no clerk_user_id.  Sort out by hand.');
    return { ok: false, why: 'no buyer' };
  }
  const buyer = await clerk.users.getUser(buyerId);     // throws → webhook returns 500 → Paddle retries
  const existing = Array.isArray(buyer.privateMetadata?.giftsSent) ? buyer.privateMetadata.giftsSent : [];
  if (existing.some(g => g.txn === txn.id)) return { ok: true, duplicate: true };   // Paddle sent it twice

  const toName = cleanText(cd.gift_to_name, 40);
  const toEmail = validEmail(cd.gift_to_email);
  const deliver = cd.gift_deliver === 'them' && toEmail ? 'them' : 'me';
  const message = cleanText(cd.gift_message, 200);
  const createdAt = new Date().toISOString();
  const made = bought.map(b => ({
    id: newGiftId(), txn: txn.id, tier: b.tier, months: b.months,
    toName, toEmail, deliver, message, createdAt, redeemedBy: null, redeemedAt: null,
  }));
  await clerk.users.updateUserMetadata(buyerId, { privateMetadata: { giftsSent: [...existing, ...made] } });
  console.log('[GIFT] Recorded ' + made.length + ' gift(s) from ' + buyerId + ' (' + txn.id + ')');

  // Emails.  A failure here must not fail the webhook: the gift is safely
  // recorded, and the buyer can always copy the link from their Profile.
  if (process.env.RESEND_API_KEY) {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from = process.env.REMINDER_FROM || 'Prêt-à-Fit <' + SUPPORT + '>';
    const buyerEmail = emailOf(buyer);
    for (const g of made) {
      const emails = buildGiftEmails({
        fromName: firstNameOf(buyer), buyerFirst: firstNameOf(buyer), toName, toEmail, deliver,
        tier: g.tier, months: g.months, message, link: giftLink(buyerId, g.id),
      });
      try {
        if (deliver === 'them') {
          const r = await resend.emails.send({ from, to: toEmail, replyTo: buyerEmail || SUPPORT, ...pick(emails.toFriend) });
          if (r?.error) throw new Error(r.error.message || 'send failed');
        }
        if (buyerEmail) {
          const r = await resend.emails.send({ from, to: buyerEmail, replyTo: SUPPORT, ...pick(emails.toBuyer) });
          if (r?.error) throw new Error(r.error.message || 'send failed');
        }
      } catch (e) {
        console.error('[GIFT] Email for gift ' + g.id + ' failed: ' + (e?.message || e));
      }
    }
  }
  return { ok: true, made: made.length };
}

function pick(e) { return { subject: e.subject, text: e.text, html: e.html }; }

/* ── The endpoint ── */
export async function POST(request) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey) return json({ error: 'Gifts are not set up yet.' }, 500);
  const clerk = createClerkClient({ secretKey });

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const action = body?.action;

  // Who is asking (only 'redeem' and 'sent' need it).
  async function signedInUserId() {
    const auth = request.headers.get('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) return null;
    try { return (await verifyToken(token, { secretKey })).sub; } catch (e) { return null; }
  }

  async function loadGift(token) {
    const t = parseToken(token);
    if (!t) return { error: json({ error: "That gift link doesn't look right.  Please check it was copied in full." }, 400) };
    let buyer;
    try { buyer = await clerk.users.getUser(t.buyerId); }
    catch (e) { return { error: json({ error: "We couldn't find that gift." }, 404) }; }
    const list = Array.isArray(buyer.privateMetadata?.giftsSent) ? buyer.privateMetadata.giftsSent : [];
    const gift = list.find(g => g.id === t.giftId);
    if (!gift) return { error: json({ error: "We couldn't find that gift." }, 404) };
    return { buyer, list, gift, buyerId: t.buyerId };
  }

  try {
    if (action === 'lookup') {
      const r = await loadGift(body.token);
      if (r.error) return r.error;
      const { buyer, gift } = r;
      return json({
        tier: gift.tier, months: gift.months, tierName: TIERS[gift.tier]?.name,
        searches: TIERS[gift.tier]?.searches,
        fromName: firstNameOf(buyer) || 'Someone', toName: gift.toName || '', message: gift.message || '',
        claimed: !!gift.redeemedBy, refunded: !!gift.void,
      });
    }

    if (action === 'sent') {
      const userId = await signedInUserId();
      if (!userId) return json({ error: 'Please sign in first.' }, 401);
      const me = await clerk.users.getUser(userId);
      const list = Array.isArray(me.privateMetadata?.giftsSent) ? me.privateMetadata.giftsSent : [];
      return json({ gifts: list.slice().reverse().map(g => ({
        tier: g.tier, months: g.months, toName: g.toName || '', createdAt: g.createdAt,
        claimed: !!g.redeemedBy, claimedAt: g.redeemedAt || null, refunded: !!g.void,
        link: giftLink(userId, g.id),
      })) });
    }

    if (action === 'redeem') {
      const userId = await signedInUserId();
      if (!userId) return json({ error: 'Please sign in to claim your gift.' }, 401);
      const r = await loadGift(body.token);
      if (r.error) return r.error;
      const { buyer, buyerId, gift } = r;

      if (buyerId === userId) {
        return json({ error: "This is a gift you gave, so it can't be claimed on your own account.  Pass the link on to " + (gift.toName || 'them') + '.' }, 409);
      }
      if (gift.redeemedBy === userId) return json({ ok: true, already: true });
      if (gift.redeemedBy) return json({ error: 'This gift has already been claimed.' }, 409);
      if (gift.void) return json({ error: 'This gift was refunded, so it can no longer be claimed.' }, 409);

      // Refunded since it was bought?  Paddle's adjusted totals say so.
      if (process.env.PADDLE_API_KEY && gift.txn) {
        try {
          const t = await paddle('GET', '/transactions/' + encodeURIComponent(gift.txn));
          const total = Number(t?.data?.details?.totals?.total);
          const adjusted = Number(t?.data?.details?.adjusted_totals?.total);
          if (Number.isFinite(total) && Number.isFinite(adjusted) && adjusted < total) {
            await markGift(clerk, buyerId, gift.id, { void: true });
            return json({ error: 'This gift was refunded, so it can no longer be claimed.' }, 409);
          }
        } catch (e) {
          console.warn('[GIFT] Could not check refunds for ' + gift.txn + ': ' + e.message);
        }
      }

      const me = await clerk.users.getUser(userId);
      const pub = me.publicMetadata || {};
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const fromName = firstNameOf(buyer) || 'a friend';

      if (pub.paddleSubscriptionId && pub.subscriptionStatus === 'past_due') {
        return json({ error: "Your last payment didn't go through.  Please update your card from your Profile first, then claim your gift — it will pay for your next renewals." }, 409);
      }

      // Claim first, so two tabs can't both spend it.
      await markGift(clerk, buyerId, gift.id, { redeemedBy: userId, redeemedAt: nowIso });
      try {
        let record;
        if (hasActiveSubscription(pub)) {
          const running = runningDiscountGift(pub, now);
          if (running) {
            const e = new Error('running');
            e.userMessage = 'You already have a gift paying for your renewals until ' + dayMonth(running.end) +
              '.  Keep this link and claim it after that — it will still work.';
            throw e;
          }
          const start = pub.nextBilledAt;
          if (!start || Date.parse(start) - now < 31 * 60 * 1000) {
            const e = new Error('too close');
            e.userMessage = 'Your subscription is renewing right now.  Please try again in an hour.';
            throw e;
          }
          const subTier = pub.pendingTier || pub.tier || 'standard';
          const pct = giftPercent(gift.tier, subTier);
          const dsc = await paddle('POST', '/discounts', {
            description: 'Gift ' + gift.id + ' (' + gift.months + ' months ' + gift.tier + ') for ' + userId,
            type: 'percentage', amount: String(pct),
            enabled_for_checkout: false, recur: true, maximum_recurring_intervals: gift.months,
            usage_limit: 1, custom_data: { gift_id: gift.id },   // visible under Catalog → Discounts
          });
          await paddle('PATCH', '/subscriptions/' + encodeURIComponent(pub.paddleSubscriptionId), {
            discount: { id: dsc.data.id, effective_from: 'next_billing_period' },
          });
          record = { id: gift.id, kind: 'discount', tier: gift.tier, months: gift.months, from: fromName,
            start, end: addMonths(start, gift.months), percent: pct, discountId: dsc.data.id };
        } else {
          const start = accessStart(pub, nowIso);
          record = { id: gift.id, kind: 'access', tier: gift.tier, months: gift.months, from: fromName,
            start, end: addMonths(start, gift.months) };
        }
        const gifts = Array.isArray(pub.gifts) ? pub.gifts : [];
        await clerk.users.updateUserMetadata(userId, { publicMetadata: { gifts: [...gifts, record] } });
        console.log('[GIFT] ' + gift.id + ' claimed by ' + userId + ' as ' + record.kind + ' ' + record.start + ' → ' + record.end);
        return json({ ok: true, gift: record });
      } catch (e) {
        await markGift(clerk, buyerId, gift.id, { redeemedBy: null, redeemedAt: null });
        if (e.userMessage) return json({ error: e.userMessage }, 409);
        console.error('[GIFT] Claim of ' + gift.id + ' by ' + userId + ' failed: ' + (e?.message || e));
        return json({ error: "Something went wrong claiming your gift.  Nothing has been used up — please try again in a few minutes." }, 502);
      }
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    console.error('[GIFT] ' + action + ' failed: ' + (e?.message || e));
    return json({ error: 'Something went wrong on our side.  Please try again in a few minutes.' }, 500);
  }
}

/* Update one gift on the buyer's list, re-reading the list first so nothing
   written in between is lost. */
async function markGift(clerk, buyerId, giftId, changes) {
  const buyer = await clerk.users.getUser(buyerId);
  const list = Array.isArray(buyer.privateMetadata?.giftsSent) ? buyer.privateMetadata.giftsSent : [];
  const next = list.map(g => (g.id === giftId ? { ...g, ...changes } : g));
  await clerk.users.updateUserMetadata(buyerId, { privateMetadata: { giftsSent: next } });
}
