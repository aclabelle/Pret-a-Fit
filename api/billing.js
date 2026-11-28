/* ── api/billing.js ───────────────────────────────────────────────────────
   Jobs for a signed-in subscriber, all needing the private Paddle API key,
   which is why they run here and not in the browser:

     action: 'portal'       → a signed-in link to Paddle's billing page, where
                              they can cancel, change card or see receipts.
     action: 'upgrade'      → move from Standard to Premium straight away,
                              paying the difference for the rest of the month
                              (what the pricing page promises).
     action: 'downgrade'    → move from Premium to Standard AT THE NEXT RENEWAL
                              (also what the pricing page promises).
     action: 'keep-premium' → change their mind about a downgrade before it
                              happens.

   HOW "DOWN AT THE NEXT RENEWAL" WORKS.  Paddle can schedule a cancellation
   but not a plan change, so we do it in two halves:
     1. Paddle's side: the subscription is switched to the Standard price now,
        with proration 'do_not_bill' — no charge, no credit.  Paddle's next
        bill is therefore $14, and their billing page says so.
     2. Our side: publicMetadata keeps tier 'premium' plus a hold —
        pendingTier: 'standard', premiumUntil: <end of the paid month>.  The
        webhook respects the hold until the next billing period starts, and
        the app also checks the date, so they keep Premium for exactly the
        month they paid for.
   The hold is written BEFORE the Paddle change, so the webhook that change
   triggers always sees it, whichever arrives first.

   The browser proves who it is by sending its Clerk session token.  The
   Paddle IDs come from the account's publicMetadata, which only our server
   can write, so nobody can open someone else's billing page.

   Uses the same environment variables as api/paddle-webhook.js.
   ──────────────────────────────────────────────────────────────────────── */

import { createClerkClient, verifyToken } from '@clerk/backend';

// Keep in step with PRICE_TIERS in api/paddle-webhook.js and PADDLE_PRICES in
// index.html.  When you go live, switch these to the live price IDs.
// Sandbox and live prices have different IDs; the right pair is picked by
// which Paddle account the API key in Vercel belongs to (see paddleApiBase).
const PRICE_IDS = {
  sandbox: { standard: 'pri_01m8ba2x02my54dypdpa1jqv2b', premium: 'pri_01m8ba46azz7g8j2bb1wjy0jq7' },
  live:    { standard: 'pri_01m8bwv2nvjjajex8cjhatdqy7', premium: 'pri_01m8bwy8np0ckc893ecvyfdygy' },
};

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

function prices() {
  return paddleApiBase().includes('sandbox') ? PRICE_IDS.sandbox : PRICE_IDS.live;
}

async function paddle(method, path, body) {
  const res = await fetch(paddleApiBase() + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + process.env.PADDLE_API_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    const detail = data?.error?.detail || data?.error?.code || ('HTTP ' + res.status);
    console.error('[BILLING] Paddle ' + method + ' ' + path + ' failed: ' + detail);
    const err = new Error(detail);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function POST(request) {
  const secretKey = process.env.CLERK_SECRET_KEY;
  if (!secretKey || !process.env.PADDLE_API_KEY) {
    console.error('[BILLING] CLERK_SECRET_KEY or PADDLE_API_KEY is not set in Vercel.');
    return json({ error: 'Billing is not set up yet.' }, 500);
  }

  // Who is asking?
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return json({ error: 'Please sign in first.' }, 401);

  let userId;
  try {
    const claims = await verifyToken(token, { secretKey });
    userId = claims.sub;
  } catch (e) {
    return json({ error: 'Your sign-in has expired — please refresh the page.' }, 401);
  }

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const action = body?.action;

  const clerk = createClerkClient({ secretKey });
  const user = await clerk.users.getUser(userId);
  const pub = user.publicMetadata || {};

  // A gift is paying for some renewals (see api/gift.js).  Its discount is a
  // percentage of THIS plan's price, so changing plan in the middle would
  // make it cover the wrong amount.  Plan changes wait until it ends.
  const giftRunning = (Array.isArray(pub.gifts) ? pub.gifts : [])
    .find(g => g.kind === 'discount' && Date.parse(g.end) > Date.now());
  if (giftRunning && (action === 'upgrade' || action === 'downgrade' || action === 'keep-premium')) {
    const until = new Date(giftRunning.end).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
    return json({ error: 'Your gift is paying for your renewals until ' + until + ', so plan changes can wait until then.' }, 409);
  }

  try {
    if (action === 'portal') {
      if (!pub.paddleCustomerId) {
        return json({ error: "We can't find a subscription on this account." }, 404);
      }
      const session = await paddle('POST',
        '/customers/' + encodeURIComponent(pub.paddleCustomerId) + '/portal-sessions',
        { subscription_ids: pub.paddleSubscriptionId ? [pub.paddleSubscriptionId] : [] });
      const url = session?.data?.urls?.general?.overview;
      if (!url) return json({ error: 'Paddle did not return a link.' }, 502);
      return json({ url });
    }

    // Undo a pending downgrade: back to the Premium price, nothing charged —
    // they have already paid for Premium this month.  'upgrade' lands here too
    // when a downgrade is pending, so nobody pays twice for the same month.
    if (action === 'keep-premium' || (action === 'upgrade' && pub.pendingTier === 'standard')) {
      if (pub.pendingTier !== 'standard' || !pub.paddleSubscriptionId) {
        return json({ ok: true, tier: pub.tier || null });   // nothing pending
      }
      await paddle('PATCH', '/subscriptions/' + encodeURIComponent(pub.paddleSubscriptionId), {
        items: [{ price_id: prices().premium, quantity: 1 }],
        proration_billing_mode: 'do_not_bill',
      });
      await clerk.users.updateUserMetadata(userId, {
        publicMetadata: { tier: 'premium', pendingTier: null, premiumUntil: null },
      });
      return json({ ok: true, tier: 'premium' });
    }

    if (action === 'downgrade') {
      if (!pub.paddleSubscriptionId || pub.subscriptionStatus !== 'active') {
        return json({ error: 'There is no active subscription to change.' }, 400);
      }
      if (pub.tier !== 'premium') return json({ error: "You're already on Standard." }, 400);
      if (pub.pendingTier === 'standard') return json({ ok: true, premiumUntil: pub.premiumUntil });
      if (pub.scheduledChange && pub.scheduledChange.action === 'cancel') {
        return json({ error: 'This subscription is already set to end, so there is nothing to change.' }, 400);
      }
      const until = pub.periodEnd || pub.nextBilledAt;
      if (!until) return json({ error: "We couldn't find your renewal date.  Please try again in a minute." }, 409);

      // 1. The hold first (see the note at the top of this file).
      await clerk.users.updateUserMetadata(userId, {
        publicMetadata: { tier: 'premium', pendingTier: 'standard', premiumUntil: until },
      });
      // 2. Then Paddle.  If Paddle refuses, take the hold away again.
      try {
        await paddle('PATCH', '/subscriptions/' + encodeURIComponent(pub.paddleSubscriptionId), {
          items: [{ price_id: prices().standard, quantity: 1 }],
          proration_billing_mode: 'do_not_bill',
        });
      } catch (e) {
        await clerk.users.updateUserMetadata(userId, {
          publicMetadata: { pendingTier: null, premiumUntil: null },
        });
        throw e;
      }
      return json({ ok: true, premiumUntil: until });
    }

    if (action === 'upgrade') {
      if (!pub.paddleSubscriptionId || pub.subscriptionStatus !== 'active') {
        return json({ error: 'There is no active subscription to upgrade.' }, 400);
      }
      if (pub.tier === 'premium') {
        return json({ ok: true, tier: 'premium' });   // nothing to do
      }
      if (pub.scheduledChange && pub.scheduledChange.action === 'cancel') {
        return json({ error: 'This subscription is set to end.  Restart it from the billing page first, then move up.' }, 400);
      }
      await paddle('PATCH', '/subscriptions/' + encodeURIComponent(pub.paddleSubscriptionId), {
        items: [{ price_id: prices().premium, quantity: 1 }],
        // Charge the difference for the rest of this month now, then the new
        // price from the next renewal.
        proration_billing_mode: 'prorated_immediately',
        // If that charge fails, leave them on Standard rather than switching.
        on_payment_failure: 'prevent_change',
      });
      // The webhook will confirm this in a moment; writing it now means the
      // app shows the new allowance straight away.
      await clerk.users.updateUserMetadata(userId, { publicMetadata: { tier: 'premium' } });
      return json({ ok: true, tier: 'premium' });
    }

    return json({ error: 'Unknown action.' }, 400);
  } catch (e) {
    const msg = e?.status === 402 || /payment/i.test(e?.message || '')
      ? "The payment for the upgrade didn't go through, so you're still on Standard."
      : 'Something went wrong talking to our payment provider.  Please try again.';
    return json({ error: msg }, 502);
  }
}
