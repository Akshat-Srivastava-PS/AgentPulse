import test from 'node:test';
import assert from 'node:assert';
import { dispatchRequest } from './testHelper.js';

// Paid-tier plumbing: plan catalog, GET /v1/agents/me/plan, and the owner
// grant path PATCH /v1/admin/agents/:id. No live charging exists — paid
// plans are activated by the operator (admin token) after purchase.
// ADMIN_TOKEN is read from process.env at request time, so each test
// sets (or deletes) it explicitly; test files run in their own processes.

const ADMIN_TOKEN = 'test-admin-token-plans';

async function registerAgent(name) {
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    body: {
      agent_name: name,
      operator_url: 'https://github.com/myorg/plans-test-bot'
    }
  });
  assert.strictEqual(res.status, 201);
  const data = await res.json();
  return data.agent; // includes one-time api_key
}

function adminHeaders(token = ADMIN_TOKEN) {
  return { 'Authorization': `Bearer ${token}` };
}

async function patchAgentTier(agentId, tier, token = ADMIN_TOKEN) {
  return dispatchRequest({
    method: 'PATCH',
    url: `/v1/admin/agents/${agentId}`,
    headers: adminHeaders(token),
    body: tier === undefined ? {} : { tier }
  });
}

test('54. Plan: GET /v1/agents/me/plan requires auth and returns catalog + caller state', async () => {
  // Anonymous and bad-key callers are rejected
  const anon = await dispatchRequest({ url: '/v1/agents/me/plan' });
  assert.strictEqual(anon.status, 401);

  const badKey = await dispatchRequest({
    url: '/v1/agents/me/plan',
    headers: { 'Authorization': 'Bearer agp_live_not_a_real_key' }
  });
  assert.strictEqual(badKey.status, 401);

  const agent = await registerAgent('PlanStateBot');
  const auth = { 'Authorization': `Bearer ${agent.api_key}` };
  assert.strictEqual(agent.tier, 'free_verified');
  assert.strictEqual(agent.daily_quota, 100);

  // Fresh agent: zero usage, full catalog, honest upgrade instructions
  const fresh = await dispatchRequest({ url: '/v1/agents/me/plan', headers: auth });
  assert.strictEqual(fresh.status, 200);
  const freshBody = await fresh.json();
  assert.strictEqual(freshBody.tier, 'free_verified');
  assert.strictEqual(freshBody.daily_quota, 100);
  assert.strictEqual(freshBody.requests_today, 0);
  assert.strictEqual(freshBody.quota_remaining, 100);
  assert.strictEqual(fresh.headers.get('x-ratelimit-limit'), '100');

  assert.strictEqual(freshBody.plans.length, 3);
  const byTier = Object.fromEntries(freshBody.plans.map(p => [p.tier, p]));
  assert.strictEqual(byTier.free_verified.daily_quota, 100);
  assert.strictEqual(byTier.free_verified.price_usd_month, 0);
  assert.strictEqual(byTier.pro.daily_quota, 10000);
  assert.strictEqual(byTier.pro.price_usd_month, 29);
  assert.strictEqual(byTier.team.daily_quota, 50000);
  assert.strictEqual(byTier.team.price_usd_month, 99);

  assert.strictEqual(
    freshBody.upgrade.how,
    'Paid plans are activated by the operator after purchase — see website'
  );
  assert.strictEqual(freshBody.upgrade.url, 'https://agentpulse-43di.onrender.com');

  // One counted call moves the state; reading the plan itself does not count
  const status = await dispatchRequest({ url: '/v1/status/openai', headers: auth });
  assert.strictEqual(status.status, 200);

  const after = await dispatchRequest({ url: '/v1/agents/me/plan', headers: auth });
  const afterBody = await after.json();
  assert.strictEqual(afterBody.requests_today, 1);
  assert.strictEqual(afterBody.quota_remaining, 99);

  const again = await dispatchRequest({ url: '/v1/agents/me/plan', headers: auth });
  const againBody = await again.json();
  assert.strictEqual(againBody.requests_today, 1, 'plan reads do not consume quota');
  assert.strictEqual(againBody.quota_remaining, 99);
});

test('55. Plan: admin PATCH grants a plan — tier and quota change together and rate-limit headers follow', async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  const agent = await registerAgent('PlanGrantBot');
  const auth = { 'Authorization': `Bearer ${agent.api_key}` };

  // Grant Pro
  const proRes = await patchAgentTier(agent.id, 'pro');
  assert.strictEqual(proRes.status, 200);
  const pro = await proRes.json();
  // Response is the updated agent row in the admin list shape
  assert.strictEqual(pro.id, agent.id);
  assert.strictEqual(pro.agent_name, 'PlanGrantBot');
  assert.strictEqual(pro.operator_url, agent.operator_url);
  assert.strictEqual(pro.tier, 'pro');
  assert.strictEqual(pro.daily_quota, 10000);
  assert.strictEqual(pro.requests_today, 0);
  assert.strictEqual(pro.quota_remaining, 10000);
  assert.ok('good_citizen_score' in pro);
  assert.ok('total_requests' in pro);
  assert.ok('last_seen_at' in pro);
  assert.ok(Array.isArray(pro.top_endpoints));
  assert.ok(pro.created_at);

  // The agent now sees the new plan, and its rate-limit limit follows
  const planRes = await dispatchRequest({ url: '/v1/agents/me/plan', headers: auth });
  assert.strictEqual(planRes.status, 200);
  const plan = await planRes.json();
  assert.strictEqual(plan.tier, 'pro');
  assert.strictEqual(plan.daily_quota, 10000);
  assert.strictEqual(plan.quota_remaining, 10000);
  assert.strictEqual(planRes.headers.get('x-ratelimit-limit'), '10000');
  assert.strictEqual(planRes.headers.get('x-ratelimit-remaining'), '10000');

  // Counted calls also report the new limit
  const statusRes = await dispatchRequest({ url: '/v1/status/openai', headers: auth });
  assert.strictEqual(statusRes.status, 200);
  assert.strictEqual(statusRes.headers.get('x-ratelimit-limit'), '10000');

  // Grant Team, then downgrade back to Free — both fields move each time
  const teamRes = await patchAgentTier(agent.id, 'team');
  assert.strictEqual(teamRes.status, 200);
  const team = await teamRes.json();
  assert.strictEqual(team.tier, 'team');
  assert.strictEqual(team.daily_quota, 50000);

  const freeRes = await patchAgentTier(agent.id, 'free_verified');
  assert.strictEqual(freeRes.status, 200);
  const free = await freeRes.json();
  assert.strictEqual(free.tier, 'free_verified');
  assert.strictEqual(free.daily_quota, 100);

  const finalPlan = await dispatchRequest({ url: '/v1/agents/me/plan', headers: auth });
  assert.strictEqual(finalPlan.headers.get('x-ratelimit-limit'), '100');
});

test('56. Plan: admin PATCH rejects unknown tiers with 400 and unknown agents with 404', async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  const agent = await registerAgent('PlanErrorBot');

  const badTier = await patchAgentTier(agent.id, 'enterprise');
  assert.strictEqual(badTier.status, 400);
  const badTierBody = await badTier.json();
  assert.ok(badTierBody.error.includes('Invalid tier'));
  assert.deepStrictEqual(badTierBody.allowed_tiers, ['free_verified', 'pro', 'team']);

  const missingTier = await patchAgentTier(agent.id, undefined);
  assert.strictEqual(missingTier.status, 400);

  const wrongType = await dispatchRequest({
    method: 'PATCH',
    url: `/v1/admin/agents/${agent.id}`,
    headers: adminHeaders(),
    body: { tier: 42 }
  });
  assert.strictEqual(wrongType.status, 400);

  const unknownAgent = await patchAgentTier('agent_doesnotexist', 'pro');
  assert.strictEqual(unknownAgent.status, 404);

  // None of the failed calls changed the agent
  const auth = { 'Authorization': `Bearer ${agent.api_key}` };
  const planRes = await dispatchRequest({ url: '/v1/agents/me/plan', headers: auth });
  const plan = await planRes.json();
  assert.strictEqual(plan.tier, 'free_verified');
  assert.strictEqual(plan.daily_quota, 100);
});

test('57. Plan: admin PATCH follows the same ADMIN_TOKEN auth as the other admin endpoints', async () => {
  const agent = await registerAgent('PlanAuthBot');

  // Unset token: admin surface disabled entirely
  const saved = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  try {
    const disabled = await patchAgentTier(agent.id, 'pro', 'anything');
    assert.strictEqual(disabled.status, 503);
    assert.strictEqual((await disabled.json()).error, 'admin_disabled');
  } finally {
    if (saved !== undefined) process.env.ADMIN_TOKEN = saved;
  }

  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

  const noToken = await dispatchRequest({
    method: 'PATCH',
    url: `/v1/admin/agents/${agent.id}`,
    body: { tier: 'pro' }
  });
  assert.strictEqual(noToken.status, 401);

  const wrongToken = await patchAgentTier(agent.id, 'pro', 'not-the-admin-token');
  assert.strictEqual(wrongToken.status, 401);
  assert.strictEqual((await wrongToken.json()).error, 'unauthorized');

  // And the agent is still on the free plan after all that
  const auth = { 'Authorization': `Bearer ${agent.api_key}` };
  const planRes = await dispatchRequest({ url: '/v1/agents/me/plan', headers: auth });
  const plan = await planRes.json();
  assert.strictEqual(plan.tier, 'free_verified');
  assert.strictEqual(plan.daily_quota, 100);
});
