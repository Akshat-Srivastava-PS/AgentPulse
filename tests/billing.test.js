import test from 'node:test';
import assert from 'node:assert';
import crypto from 'node:crypto';
import { dispatchRequest } from './testHelper.js';
import { getAgentClientById } from '../src/db/index.js';

// Stripe billing: Payment Link checkout + webhook activation.
// STRIPE_* env vars are read at request time, so each test sets (or
// deletes) them explicitly; test files run in their own processes.

const SECRET = 'whsec_test_billing_secret_0123456789';
const PRO_LINK = 'https://buy.stripe.com/test_pro_link';
const TEAM_LINK = 'https://buy.stripe.com/test_team_link?src=site';

function sign(raw, secret = SECRET, ts = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${raw}`, 'utf8').digest('hex');
  return `t=${ts},v1=${v1}`;
}

async function postWebhook(raw, signatureHeader) {
  const headers = {};
  if (signatureHeader !== undefined) headers['stripe-signature'] = signatureHeader;
  return dispatchRequest({
    method: 'POST',
    url: '/v1/billing/webhook',
    headers,
    body: raw
  });
}

function eventRaw(id, type, object) {
  return JSON.stringify({ id, type, data: { object } });
}

async function registerAgent(name) {
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    body: {
      agent_name: name,
      operator_url: 'https://github.com/myorg/billing-test-bot'
    }
  });
  assert.strictEqual(res.status, 201);
  const data = await res.json();
  return data.agent; // includes one-time api_key
}

async function getPlan(agent) {
  const res = await dispatchRequest({
    url: '/v1/agents/me/plan',
    headers: { 'Authorization': `Bearer ${agent.api_key}` }
  });
  assert.strictEqual(res.status, 200);
  return res.json();
}

// Shared across tests 61 → 63 → 64 (same subscription lifecycle)
let proAgent;
let proCheckoutRaw;
let proCheckoutSig;
const PRO_SUB = 'sub_billing_pro';
const PRO_CUS = 'cus_billing_pro';

// Shared across tests 62 → 65
let teamAgent;
const TEAM_SUB = 'sub_billing_team';
const TEAM_CUS = 'cus_billing_team';

test('59. Billing: webhook returns 503 billing_disabled when STRIPE_WEBHOOK_SECRET is unset', async () => {
  const saved = process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    const raw = eventRaw('evt_disabled_check', 'invoice.payment_failed', { id: 'in_x' });
    const res = await postWebhook(raw, sign(raw));
    assert.strictEqual(res.status, 503);
    assert.strictEqual((await res.json()).error, 'billing_disabled');
  } finally {
    if (saved !== undefined) process.env.STRIPE_WEBHOOK_SECRET = saved;
  }
});

test('60. Billing: webhook rejects bad, missing, and stale signatures with 400', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  const raw = eventRaw('evt_bad_sig', 'invoice.payment_failed', { id: 'in_x' });

  const wrongSecret = await postWebhook(raw, sign(raw, 'whsec_some_other_secret'));
  assert.strictEqual(wrongSecret.status, 400);

  const missing = await postWebhook(raw, undefined);
  assert.strictEqual(missing.status, 400);

  const garbage = await postWebhook(raw, 'not-a-signature');
  assert.strictEqual(garbage.status, 400);

  const staleTs = Math.floor(Date.now() / 1000) - 3600;
  const stale = await postWebhook(raw, sign(raw, SECRET, staleTs));
  assert.strictEqual(stale.status, 400);

  // A correctly signed event is accepted (and not recorded by the failed
  // attempts above, which were rejected before parsing)
  const ok = await postWebhook(raw, sign(raw));
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(await ok.json(), { received: true });
});

test('61. Billing: checkout.session.completed then subscription.created activates Pro', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  proAgent = await registerAgent('BillingProBot');

  // Checkout half first: agent id known, tier not yet — nothing applies
  proCheckoutRaw = eventRaw('evt_checkout_pro', 'checkout.session.completed', {
    client_reference_id: proAgent.id,
    customer: PRO_CUS,
    subscription: PRO_SUB,
    mode: 'subscription'
  });
  proCheckoutSig = sign(proCheckoutRaw);
  const checkoutRes = await postWebhook(proCheckoutRaw, proCheckoutSig);
  assert.strictEqual(checkoutRes.status, 200);
  assert.deepStrictEqual(await checkoutRes.json(), { received: true });

  let plan = await getPlan(proAgent);
  assert.strictEqual(plan.tier, 'free_verified');
  assert.strictEqual(plan.daily_quota, 100);

  // Subscription half: tier arrives via metadata, status active → applies
  const subRaw = eventRaw('evt_sub_created_pro', 'customer.subscription.created', {
    id: PRO_SUB,
    customer: PRO_CUS,
    status: 'active',
    metadata: { tier: 'pro' },
    items: { data: [{ price: { id: 'price_pro_test' } }] }
  });
  const subRes = await postWebhook(subRaw, sign(subRaw));
  assert.strictEqual(subRes.status, 200);

  plan = await getPlan(proAgent);
  assert.strictEqual(plan.tier, 'pro');
  assert.strictEqual(plan.daily_quota, 10000);
  assert.strictEqual(plan.quota_remaining, 10000);

  const row = getAgentClientById(proAgent.id);
  assert.strictEqual(row.stripe_customer_id, PRO_CUS);
  assert.strictEqual(row.stripe_subscription_id, PRO_SUB);
});

test('62. Billing: subscription.created then checkout.session.completed also activates (reverse order, Team)', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  teamAgent = await registerAgent('BillingTeamBot');

  // Subscription half first: tier known, agent not yet — nothing applies
  const subRaw = eventRaw('evt_sub_created_team', 'customer.subscription.created', {
    id: TEAM_SUB,
    customer: TEAM_CUS,
    status: 'active',
    metadata: { tier: 'team' },
    items: { data: [{ price: { id: 'price_team_test' } }] }
  });
  const subRes = await postWebhook(subRaw, sign(subRaw));
  assert.strictEqual(subRes.status, 200);

  let plan = await getPlan(teamAgent);
  assert.strictEqual(plan.tier, 'free_verified');

  // Checkout half completes the mapping → applies
  const checkoutRaw = eventRaw('evt_checkout_team', 'checkout.session.completed', {
    client_reference_id: teamAgent.id,
    customer: TEAM_CUS,
    subscription: TEAM_SUB,
    mode: 'subscription'
  });
  const checkoutRes = await postWebhook(checkoutRaw, sign(checkoutRaw));
  assert.strictEqual(checkoutRes.status, 200);

  plan = await getPlan(teamAgent);
  assert.strictEqual(plan.tier, 'team');
  assert.strictEqual(plan.daily_quota, 50000);

  const row = getAgentClientById(teamAgent.id);
  assert.strictEqual(row.stripe_customer_id, TEAM_CUS);
  assert.strictEqual(row.stripe_subscription_id, TEAM_SUB);
});

test('63. Billing: a duplicate event id is acknowledged with duplicate:true and not reprocessed', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;

  const dup = await postWebhook(proCheckoutRaw, proCheckoutSig);
  assert.strictEqual(dup.status, 200);
  assert.deepStrictEqual(await dup.json(), { received: true, duplicate: true });

  // State is untouched by the redelivery
  const plan = await getPlan(proAgent);
  assert.strictEqual(plan.tier, 'pro');
  assert.strictEqual(plan.daily_quota, 10000);
});

test('64. Billing: customer.subscription.deleted downgrades back to free_verified / 100', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;

  const raw = eventRaw('evt_sub_deleted_pro', 'customer.subscription.deleted', {
    id: PRO_SUB,
    customer: PRO_CUS,
    status: 'canceled'
  });
  const res = await postWebhook(raw, sign(raw));
  assert.strictEqual(res.status, 200);
  assert.deepStrictEqual(await res.json(), { received: true });

  const plan = await getPlan(proAgent);
  assert.strictEqual(plan.tier, 'free_verified');
  assert.strictEqual(plan.daily_quota, 100);
  assert.strictEqual(plan.quota_remaining, 100);

  const row = getAgentClientById(proAgent.id);
  assert.strictEqual(row.stripe_subscription_id, null);
});

test('65. Billing: subscription.updated with status canceled also downgrades', async () => {
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;

  const raw = eventRaw('evt_sub_updated_canceled_team', 'customer.subscription.updated', {
    id: TEAM_SUB,
    customer: TEAM_CUS,
    status: 'canceled',
    metadata: { tier: 'team' },
    items: { data: [{ price: { id: 'price_team_test' } }] }
  });
  const res = await postWebhook(raw, sign(raw));
  assert.strictEqual(res.status, 200);

  const plan = await getPlan(teamAgent);
  assert.strictEqual(plan.tier, 'free_verified');
  assert.strictEqual(plan.daily_quota, 100);

  const row = getAgentClientById(teamAgent.id);
  assert.strictEqual(row.stripe_subscription_id, null);
});

test('66. Billing: plan checkout_url carries client_reference_id when links are set, null when unset', async () => {
  const agent = await registerAgent('BillingCheckoutBot');
  const savedPro = process.env.STRIPE_PAYMENT_LINK_PRO;
  const savedTeam = process.env.STRIPE_PAYMENT_LINK_TEAM;
  try {
    process.env.STRIPE_PAYMENT_LINK_PRO = PRO_LINK;
    process.env.STRIPE_PAYMENT_LINK_TEAM = TEAM_LINK;

    const plan = await getPlan(agent);
    const byTier = Object.fromEntries(plan.plans.map(p => [p.tier, p]));
    assert.strictEqual(byTier.free_verified.checkout_url, null);
    assert.strictEqual(byTier.pro.checkout_url, `${PRO_LINK}?client_reference_id=${agent.id}`);
    // A link that already has a query string gets '&', not a second '?'
    assert.strictEqual(byTier.team.checkout_url, `${TEAM_LINK}&client_reference_id=${agent.id}`);
    assert.ok(plan.upgrade.how.includes('checkout_url'));
    assert.ok(plan.upgrade.how.includes('activates automatically'));

    // llms.txt advertises both links with the client_reference_id instruction
    const llms = await dispatchRequest({ url: '/llms.txt' });
    assert.strictEqual(llms.status, 200);
    const txt = await llms.text();
    assert.ok(txt.includes(PRO_LINK));
    assert.ok(txt.includes(TEAM_LINK));
    assert.ok(txt.includes('client_reference_id'));

    delete process.env.STRIPE_PAYMENT_LINK_PRO;
    delete process.env.STRIPE_PAYMENT_LINK_TEAM;

    const unset = await getPlan(agent);
    const unsetByTier = Object.fromEntries(unset.plans.map(p => [p.tier, p]));
    assert.strictEqual(unsetByTier.free_verified.checkout_url, null);
    assert.strictEqual(unsetByTier.pro.checkout_url, null);
    assert.strictEqual(unsetByTier.team.checkout_url, null);
    assert.strictEqual(
      unset.upgrade.how,
      'Paid plans are activated by the operator after purchase — see website'
    );

    const llmsUnset = await dispatchRequest({ url: '/llms.txt' });
    const txtUnset = await llmsUnset.text();
    assert.ok(txtUnset.includes('activated by the operator after purchase'));
    assert.ok(!txtUnset.includes(PRO_LINK));
  } finally {
    if (savedPro !== undefined) process.env.STRIPE_PAYMENT_LINK_PRO = savedPro;
    else delete process.env.STRIPE_PAYMENT_LINK_PRO;
    if (savedTeam !== undefined) process.env.STRIPE_PAYMENT_LINK_TEAM = savedTeam;
    else delete process.env.STRIPE_PAYMENT_LINK_TEAM;
  }
});
