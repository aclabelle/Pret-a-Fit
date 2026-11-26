/* ── api/paddle-webhook.js ────────────────────────────────────────────────
   Paddle sends a message here every time a subscription changes: someone
   subscribes, moves plan, cancels, or a payment fails.  This file checks the
   message really came from Paddle, then writes the result onto the person's
   Clerk account, in publicMetadata.  The app reads that to decide what the
   person has paid for.

   publicMetadata is the right place because only a server holding the Clerk
   secret key can write it.  The browser can read it but never change it, so
   nobody can grant themselves a subscription from the console.

   WHAT GETS WRITTEN (the contract index.html reads):
     subscriber            true while the subscription is active or trialing
     subscriptionStatus    Paddle's own word: active, past_due, canceled, paused…
     tier                  'standard' | 'premium'
     paddleCustomerId      ctm_…  — needed to open the billing portal
     paddleSubscriptionId  sub_…  — needed to change plan or cancel
     nextBilledAt          when the next charge happens (ISO date).  Also what
                           the renewal reminder emails will read.
     periodStart/periodEnd the current billing month.  The monthly search
                           allowance resets when periodStart changes.
     pendingTier/premiumUntil  set by api/billing.js when a Premium subscriber
                           moves down: they keep Premium until premiumUntil
                           (the end of the month they paid for) — see
                           applyDowngradeHold() below
     scheduledChange       e.g. { action: 'cancel', effectiveAt: '…' } after a
                           cancellation, so the app can say "ends on 3 Dec"
     paddleEventAt         time of the last event applied — used to ignore
                           messages that arrive out of order

   ENVIRONMENT VARIABLES (set in Vercel, never in this file):
     PADDLE_WEBHOOK_SECRET  from Paddle > Developer tools > Notifications
     PADDLE_API_KEY         from Paddle > Developer tools > Authentication
     CLERK_SECRET_KEY       from Clerk > API keys
     PADDLE_ENV             optional: 'sandbox' or 'production'.  If unset it
                            is worked out from the API key.
   ──────────────────────────────────────────────────────────────────────── */

import crypto from 'node:crypto';
import { createClerkClient } from '@clerk/backend';

// Which Paddle price is which plan.  Sandbox and live prices have DIFFERENT
// IDs — when you go live, add the live IDs here (and in api/billing.js and
// index.html).  Keeping the sandbox ones does no harm.
const PRICE_TIERS = {
  'pri_01m8ba2x02my54dypdpa1jqv2b': 'standard',   // sandbox, $14/month
  'pri_01m8ba46azz7g8j2bb1wjy0jq7': 'premium',    // sandbox, $29/month
};

// Statuses that unlock the paid features.  past_due (a failed payment) does
// not: access returns as soon as Paddle collects and sends 'active' again.
const PAID_STATUSES = new Set(['active', 'trialing']);

// A signed message older than this is refused, so a captured one can't be
// replayed later.  Paddle retries failed deliveries with a fresh signature.
const MAX_AGE_SECONDS = 5 * 60;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function paddleApiBase() {
  const env = (process.env.PADDLE_ENV || '').toLowerCase();
  if (env === 'production' || env === 'live') return 'https://api.paddle.com';
  if (env === 'sandbox') return 'https://sandbox-api.paddle.com';
  const key = process.env.PADDLE_API_KEY || '';
  return key.includes('_live_') ? 'https://api.paddle.com' : 'https://sandbox-api.paddle.com';
}

/* Paddle signs every message.  The Paddle-Signature header looks like
   "ts=1671552777;h1=eb4d0dc8…".  We rebuild the signature from the timestamp
   and the exact bytes received, using our secret, and compare.  If anything
   in the message was altered — or it never came from Paddle — they differ. */
export function verifyPaddleSignature(rawBody, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!header || !secret || !rawBody) return false;

  let ts = null;
  const signatures = [];
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 'ts') ts = value;
    else if (key === 'h1' && value) signatures.push(value);   // several during a key rotation
  }
  if (!ts || !/^\d+$/.test(ts) || !signatures.length) return false;
  if (Math.abs(nowSeconds - Number(ts)) > MAX_AGE_SECONDS) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const expected = crypto.createHmac('sha256', secret)
    .update(ts + ':')
    .update(body)
    .digest();

  return signatures.some((sig) => {
    if (!/^[0-9a-f]+$/i.test(sig)) return false;
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && crypto.timingSafeEqual(given, expected);
  });
}

/* Turns a Paddle subscription into the fields stored on the Clerk account. */
export function metadataFromSubscription(sub, occurredAt) {
  const priceId = sub?.items?.[0]?.price?.id || sub?.items?.[0]?.price_id || null;
  let tier = PRICE_TIERS[priceId] || null;
  if (!tier) {
    // A price we don't recognise — most likely a live price not yet added to
    // PRICE_TIERS.  Fall back to the smaller allowance rather than the larger,
    // and say so loudly in the logs.
    console.warn('[PADDLE] Unknown price ' + priceId + ' on ' + sub?.id + ' — treating as standard.  Add it to PRICE_TIERS.');
    tier = 'standard';
  }

  const sc = sub?.scheduled_change;
  return {
    subscriber: PAID_STATUSES.has(sub?.status),
    subscriptionStatus: sub?.status || null,
    tier,
    paddleCustomerId: sub?.customer_id || null,
    paddleSubscriptionId: sub?.id || null,
    nextBilledAt: sub?.next_billed_at || null,
    periodStart: sub?.current_billing_period?.starts_at || null,
    periodEnd: sub?.current_billing_period?.ends_at || null,
    scheduledChange: sc ? { action: sc.action || null, effectiveAt: sc.effective_at || null } : null,
    paddleEventAt: occurredAt || new Date().toISOString(),
  };
}

/* A Premium subscriber who moved down is switched to the Standard price in
   Paddle straight away (so the next bill is $14), but has paid for Premium
   until the end of this billing month.  While the billing period is still the
   one they paid for, keep them on Premium.  Once a new period starts — or if
   they're back on the Premium price — the hold is cleared. */
export function applyDowngradeHold(existing, incoming) {
  if (!existing || existing.pendingTier !== 'standard' || !existing.premiumUntil) return incoming;
  if (incoming.tier === 'premium') {
    return { ...incoming, pendingTier: null, premiumUntil: null };
  }
  const until = Date.parse(existing.premiumUntil);
  const start = Date.parse(incoming.periodStart);
  const samePaidPeriod = Number.isFinite(until) && (!Number.isFinite(start) || start < until - 60 * 1000);
  if (samePaidPeriod && incoming.subscriber) {
    return { ...incoming, tier: 'premium' };
  }
  return { ...incoming, pendingTier: null, premiumUntil: null };
}

/* True if the account already holds a newer event for this same subscription.
   Paddle doesn't promise delivery order, and applying an old "past_due" after
   a newer "active" would lock a paying customer out. */
export function isStale(existing, incoming) {
  if (!existing || !existing.paddleEventAt) return false;
  if (existing.paddleSubscriptionId && incoming.paddleSubscriptionId
      && existing.paddleSubscriptionId !== incoming.paddleSubscriptionId) {
    return false;   // a different (newer) subscription — always apply
  }
  const a = Date.parse(existing.paddleEventAt);
  const b = Date.parse(incoming.paddleEventAt);
  return Number.isFinite(a) && Number.isFinite(b) && b < a;
}

async function paddleCustomerEmail(customerId) {
  const key = process.env.PADDLE_API_KEY;
  if (!customerId || !key) return null;
  try {
    const res = await fetch(paddleApiBase() + '/customers/' + encodeURIComponent(customerId), {
      headers: { Authorization: 'Bearer ' + key },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data?.email || null;
  } catch (e) {
    return null;
  }
}

/* Which Clerk account is this subscription for?  The checkout passes the
   Clerk user ID through as custom data, and Paddle copies it onto the
   subscription.  If that's missing for any reason, fall back to matching the
   email address the customer paid with. */
async function findClerkUser(clerk, sub) {
  const id = sub?.custom_data?.clerk_user_id;
  if (id) {
    try { return await clerk.users.getUser(id); }
    catch (e) { console.warn('[PADDLE] custom_data user ' + id + ' not found, trying email'); }
  }
  const email = await paddleCustomerEmail(sub?.customer_id);
  if (email) {
    const list = await clerk.users.getUserList({ emailAddress: [email] });
    const users = Array.isArray(list) ? list : (list?.data || []);
    if (users.length) return users[0];
  }
  return null;
}

export async function POST(request) {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  const clerkKey = process.env.CLERK_SECRET_KEY;
  if (!secret || !clerkKey) {
    console.error('[PADDLE] PADDLE_WEBHOOK_SECRET or CLERK_SECRET_KEY is not set in Vercel.');
    return json({ error: 'Server not configured' }, 500);   // 500 makes Paddle retry later
  }

  // The signature is over the exact bytes Paddle sent, so read them raw and
  // only parse the JSON after the signature has been checked.
  const raw = Buffer.from(await request.arrayBuffer());
  if (!verifyPaddleSignature(raw, request.headers.get('paddle-signature'), secret)) {
    console.warn('[PADDLE] Rejected a message with a missing or invalid signature.');
    return json({ error: 'Invalid signature' }, 401);
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch (e) { return json({ error: 'Invalid JSON' }, 400); }

  const type = event?.event_type || '';
  // Only subscription events change what someone has access to.  Everything
  // else (transactions, customers, addresses) is acknowledged and ignored.
  if (!type.startsWith('subscription.')) {
    return json({ received: true, ignored: type });
  }

  const sub = event.data;
  const clerk = createClerkClient({ secretKey: clerkKey });

  let user;
  try {
    user = await findClerkUser(clerk, sub);
  } catch (e) {
    console.error('[PADDLE] Clerk lookup failed:', e?.message || e);
    return json({ error: 'Lookup failed' }, 500);   // temporary — let Paddle retry
  }
  if (!user) {
    // Permanent: retrying won't help.  Logged so it can be fixed by hand.
    console.error('[PADDLE] No Clerk account for subscription ' + sub?.id + ' (customer ' + sub?.customer_id + ').');
    return json({ received: true, matched: false });
  }

  const incoming = applyDowngradeHold(user.publicMetadata, metadataFromSubscription(sub, event.occurred_at));
  if (isStale(user.publicMetadata, incoming)) {
    console.log('[PADDLE] Skipped out-of-order ' + type + ' for ' + user.id);
    return json({ received: true, skipped: 'stale' });
  }

  // Record the immediate-access consent from the checkout, once.  Paddle also
  // keeps it on the transaction; this is a second copy on our side.
  const consent = sub?.custom_data?.immediate_access_consent_at;
  if (consent && !user.publicMetadata?.immediateAccessConsentAt) {
    incoming.immediateAccessConsentAt = consent;
  }

  try {
    // updateUserMetadata merges, so anything else in publicMetadata survives.
    await clerk.users.updateUserMetadata(user.id, { publicMetadata: incoming });
  } catch (e) {
    console.error('[PADDLE] Could not update Clerk user ' + user.id + ':', e?.message || e);
    return json({ error: 'Update failed' }, 500);
  }

  console.log('[PADDLE] ' + type + ' → ' + user.id + ' ' + incoming.tier + ' ' + incoming.subscriptionStatus);
  return json({ received: true });
}
