// Stripe subscriptions.
//
// Setup (once, ~15 minutes, all in the Stripe dashboard):
//   1. Products -> Add product "IronScout" -> recurring price (e.g. $49/month).
//      Copy the price id (price_...) into STRIPE_PRICE_ID.
//   2. Developers -> API keys -> copy the secret key into STRIPE_SECRET_KEY.
//   3. Developers -> Webhooks -> Add endpoint: https://YOUR_DOMAIN/api/billing/webhook
//      Events: checkout.session.completed, customer.subscription.updated,
//              customer.subscription.deleted, invoice.payment_failed
//      Copy the signing secret (whsec_...) into STRIPE_WEBHOOK_SECRET.
//   4. Settings -> Billing -> Customer portal -> enable it (lets users cancel/update card).
//
// Flow: user clicks Subscribe -> POST /checkout -> redirected to Stripe's hosted page
//       -> pays -> Stripe calls /webhook -> we flip users.subscription_status -> access on.
//       Cancel / card failure also arrive via webhook and flip it back.
//
// POST /api/billing/checkout        -> { url } to redirect the browser to
// POST /api/billing/portal          -> { url } Stripe-hosted "manage subscription" page
// POST /api/billing/webhook         -> Stripe calls this (raw body; mounted specially in server.js)
// GET  /api/billing/status          -> plan info for the account page

const express = require('express');
const router = express.Router();
const pool = require('../lib/db');
const { requireLogin } = require('../lib/auth');

const stripe = () => {
  if (!process.env.STRIPE_SECRET_KEY) throw Object.assign(new Error('Billing is not configured (STRIPE_SECRET_KEY missing)'), { status: 503 });
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
};
const APP_URL = () => (process.env.APP_URL || 'http://localhost:3000').replace(/\/$/, '');
const TRIAL_DAYS = () => Number(process.env.TRIAL_DAYS ?? 7);

async function ensureCustomer(user) {
  if (user.stripe_customer_id) return user.stripe_customer_id;
  const c = await stripe().customers.create({ email: user.email, name: user.name || undefined, metadata: { user_id: String(user.id) } });
  await pool.query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [c.id, user.id]);
  return c.id;
}

router.post('/checkout', requireLogin, async (req, res, next) => {
  try {
    if (!process.env.STRIPE_PRICE_ID) throw Object.assign(new Error('STRIPE_PRICE_ID missing'), { status: 503 });
    const customer = await ensureCustomer(req.user);
    const session = await stripe().checkout.sessions.create({
      mode: 'subscription',
      customer,
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: TRIAL_DAYS() > 0 ? { trial_period_days: TRIAL_DAYS() } : undefined,
      allow_promotion_codes: true,
      success_url: `${APP_URL()}/account.html?subscribed=1`,
      cancel_url: `${APP_URL()}/account.html`,
      metadata: { user_id: String(req.user.id) },
    });
    res.json({ url: session.url });
  } catch (e) { next(e); }
});

router.post('/portal', requireLogin, async (req, res, next) => {
  try {
    const customer = await ensureCustomer(req.user);
    const portal = await stripe().billingPortal.sessions.create({ customer, return_url: `${APP_URL()}/account.html` });
    res.json({ url: portal.url });
  } catch (e) { next(e); }
});

router.get('/status', requireLogin, async (req, res, next) => {
  try {
    const r = await pool.query(
      'SELECT role, subscription_status, subscription_ends_at, stripe_customer_id IS NOT NULL AS has_stripe FROM users WHERE id = $1',
      [req.user.id]);
    res.json({ ...r.rows[0], has_access: req.user.has_access, trial_days: TRIAL_DAYS(),
               billing_configured: Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID) });
  } catch (e) { next(e); }
});

// ---- webhook ---------------------------------------------------------------
// Mounted in server.js with express.raw() BEFORE the JSON parser, because Stripe's
// signature check needs the untouched body.
async function applySubscription(sub) {
  const status = sub.status;                               // trialing | active | past_due | canceled | unpaid | incomplete...
  const endsAt = sub.current_period_end ? new Date(sub.current_period_end * 1000) : null;
  await pool.query(
    `UPDATE users SET subscription_status = $1, subscription_ends_at = $2, stripe_subscription_id = $3
     WHERE stripe_customer_id = $4`,
    [status, endsAt, sub.id, sub.customer]);
}

async function webhook(req, res) {
  let event;
  try {
    event = stripe().webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    console.error('Stripe webhook signature failed:', e.message);
    return res.status(400).send(`Webhook error: ${e.message}`);
  }
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object;
        if (s.mode === 'subscription' && s.subscription) {
          const sub = await stripe().subscriptions.retrieve(s.subscription);
          await applySubscription(sub);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await applySubscription(event.data.object);
        break;
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        if (inv.subscription) await applySubscription(await stripe().subscriptions.retrieve(inv.subscription));
        break;
      }
      default: break;   // ignore everything else
    }
    res.json({ received: true });
  } catch (e) {
    console.error('Stripe webhook handling failed:', e);
    res.status(500).json({ error: e.message });
  }
}

module.exports = { router, webhook };
