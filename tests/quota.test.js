import test from 'node:test';
import assert from 'node:assert';
import { dispatchRequest } from './testHelper.js';
import { getDb, getAgentByApiKey } from '../src/db/index.js';

// Step 3: quota enforcement + auth hardening.
// Fully offline — all requests are dispatched in-process via testHelper.
// Quota exhaustion is arranged by direct DB manipulation of the test agent's
// own row (requests_today = daily_quota) instead of making 100 requests.

async function registerAgent(name) {
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    body: {
      agent_name: name,
      operator_url: 'https://github.com/myorg/quota-test-bot'
    }
  });
  assert.strictEqual(res.status, 201);
  const data = await res.json();
  return data.agent; // includes one-time api_key
}

function authHeaders(agent) {
  return { 'Authorization': `Bearer ${agent.api_key}` };
}

function exhaustQuota(agentId) {
  getDb().prepare('UPDATE agent_clients SET requests_today = daily_quota WHERE id = ?').run(agentId);
}

function expectedResetEpochSeconds() {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) / 1000);
}

test('28. Quota: agent exceeding its daily quota gets 429 with Retry-After and rate-limit headers', async () => {
  const agent = await registerAgent('QuotaExhaustedBot');
  exhaustQuota(agent.id);

  const res = await dispatchRequest({
    url: '/v1/status/openai',
    headers: authHeaders(agent)
  });
  assert.strictEqual(res.status, 429);

  const retryAfter = parseInt(res.headers.get('retry-after'), 10);
  assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 86400,
    `Retry-After must be seconds until UTC midnight, got ${res.headers.get('retry-after')}`);
  assert.strictEqual(res.headers.get('x-ratelimit-limit'), '100');
  assert.strictEqual(res.headers.get('x-ratelimit-remaining'), '0');
  const reset = parseInt(res.headers.get('x-ratelimit-reset'), 10);
  assert.ok(Math.abs(reset - expectedResetEpochSeconds()) <= 2,
    'X-RateLimit-Reset must be the next UTC midnight (epoch seconds)');

  const data = await res.json();
  assert.ok(data.error.includes('Rate limit exceeded'));
  assert.strictEqual(data.rate_limit.limit, 100);
  assert.strictEqual(data.rate_limit.remaining, 0);
  assert.ok(data.rate_limit.reset_at);

  // The gate is shared: preflight and telemetry reject the exhausted agent too
  const preflightRes = await dispatchRequest({
    method: 'POST',
    url: '/v1/preflight',
    headers: authHeaders(agent),
    body: { dependencies: ['openai'] }
  });
  assert.strictEqual(preflightRes.status, 429);

  const telemetryRes = await dispatchRequest({
    method: 'POST',
    url: '/v1/telemetry/report',
    headers: authHeaders(agent),
    body: { service: 'openai', endpoint: 'POST /v1/chat/completions', error_code: 503 }
  });
  assert.strictEqual(telemetryRes.status, 429);
});

test('29. Quota: 304 responses do not consume quota and are never blocked', async () => {
  const agent = await registerAgent('GoodCitizenQuotaBot');

  // One counted request to learn the ETag and baseline remaining quota
  const firstRes = await dispatchRequest({
    url: '/v1/status/openai',
    headers: authHeaders(agent)
  });
  assert.strictEqual(firstRes.status, 200);
  const etag = firstRes.headers.get('etag');
  assert.strictEqual(firstRes.headers.get('x-ratelimit-remaining'), '99');
  const scoreBefore = parseInt(firstRes.headers.get('x-good-citizen-score'), 10);

  // A 304 hit leaves remaining quota untouched but still pays the score reward
  const cachedRes = await dispatchRequest({
    url: '/v1/status/openai',
    headers: { ...authHeaders(agent), 'If-None-Match': etag }
  });
  assert.strictEqual(cachedRes.status, 304);
  assert.strictEqual(cachedRes.headers.get('x-ratelimit-remaining'), '99',
    '304 must not consume quota');
  const scoreAfter = parseInt(cachedRes.headers.get('x-good-citizen-score'), 10);
  assert.strictEqual(scoreAfter, scoreBefore + 2, '304 still grants the +2 Good Citizen reward');

  // Even with the quota fully exhausted, a conditional request is served 304
  exhaustQuota(agent.id);
  const blockedRes = await dispatchRequest({
    url: '/v1/status/openai',
    headers: authHeaders(agent)
  });
  assert.strictEqual(blockedRes.status, 429);
  const stillCachedRes = await dispatchRequest({
    url: '/v1/status/openai',
    headers: { ...authHeaders(agent), 'If-None-Match': etag }
  });
  assert.strictEqual(stillCachedRes.status, 304, '304 path is exempt from quota enforcement');
});

test('30. Auth hardening: unauthenticated writes are rejected; MCP report_outage_signal requires identity', async () => {
  // REST telemetry without a key -> 401 (also with a bogus key)
  const anonTelemetry = await dispatchRequest({
    method: 'POST',
    url: '/v1/telemetry/report',
    body: { service: 'github', endpoint: 'GET /repos', error_code: 502 }
  });
  assert.strictEqual(anonTelemetry.status, 401);
  assert.ok((await anonTelemetry.json()).error.includes('Unauthorized'));

  const badKeyTelemetry = await dispatchRequest({
    method: 'POST',
    url: '/v1/telemetry/report',
    headers: { 'Authorization': 'Bearer agp_live_not_a_real_key' },
    body: { service: 'github', endpoint: 'GET /repos', error_code: 502 }
  });
  assert.strictEqual(badKeyTelemetry.status, 401);

  // Synthetic probe trigger is a write too -> 401 without a key
  const anonProbe = await dispatchRequest({
    method: 'POST',
    url: '/v1/synthetic/probe',
    body: { service: 'stripe' }
  });
  assert.strictEqual(anonProbe.status, 401);

  // MCP report_outage_signal: anonymous -> tool-level Unauthorized error
  const anonMcp = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'report_outage_signal',
        arguments: { service: 'github', endpoint: 'GET /repos', error_code: 502 }
      }
    }
  });
  assert.strictEqual(anonMcp.status, 200);
  const anonMcpData = await anonMcp.json();
  assert.strictEqual(anonMcpData.result.isError, true);
  assert.ok(JSON.parse(anonMcpData.result.content[0].text).error.includes('Unauthorized'));

  // MCP report_outage_signal: identified caller (api_key argument) still works
  const agent = await registerAgent('McpTelemetryBot');
  const okMcp = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'report_outage_signal',
        arguments: { service: 'github', endpoint: 'GET /repos', error_code: 502, api_key: agent.api_key }
      }
    }
  });
  const okMcpData = await okMcp.json();
  assert.ok(!okMcpData.result.isError);
  const recorded = JSON.parse(okMcpData.result.content[0].text);
  assert.strictEqual(recorded.status, 'recorded');
  assert.ok(recorded.signal_id);
});

test('31. Demo key removal: the old seeded demo key no longer authenticates on a fresh DB', async () => {
  assert.strictEqual(getAgentByApiKey('agp_live_demo1234567890abcdef'), null,
    'Demo key must not resolve to an agent');
  const row = getDb().prepare("SELECT id FROM agent_clients WHERE id = 'agent_demo_01'").get();
  assert.strictEqual(row, undefined, 'Fresh databases must not seed agent_demo_01');

  const res = await dispatchRequest({
    url: '/v1/agents/me/dependencies',
    headers: { 'Authorization': 'Bearer agp_live_demo1234567890abcdef' }
  });
  assert.strictEqual(res.status, 401);
});

test('32. Rate-limit headers: present on authenticated responses, absent on public ones', async () => {
  const agent = await registerAgent('RateLimitHeaderBot');

  const statusRes = await dispatchRequest({
    url: '/v1/status/openai',
    headers: authHeaders(agent)
  });
  assert.strictEqual(statusRes.status, 200);
  assert.strictEqual(statusRes.headers.get('x-ratelimit-limit'), '100');
  assert.strictEqual(statusRes.headers.get('x-ratelimit-remaining'), '99');
  const reset = parseInt(statusRes.headers.get('x-ratelimit-reset'), 10);
  assert.ok(Math.abs(reset - expectedResetEpochSeconds()) <= 2);

  const manifestRes = await dispatchRequest({
    url: '/v1/agents/me/dependencies',
    headers: authHeaders(agent)
  });
  assert.strictEqual(manifestRes.status, 200);
  assert.strictEqual(manifestRes.headers.get('x-ratelimit-limit'), '100');
  assert.strictEqual(manifestRes.headers.get('x-ratelimit-remaining'), '98',
    'Each counted authenticated request decrements remaining quota');

  // Public, unauthenticated reads carry no rate-limit headers and stay open
  const publicRes = await dispatchRequest({ url: '/v1/status/openai' });
  assert.strictEqual(publicRes.status, 200);
  assert.strictEqual(publicRes.headers.get('x-ratelimit-limit'), undefined);
});

test('33. MCP quota: identified tool calls count toward quota and are rejected once exhausted', async () => {
  const agent = await registerAgent('McpQuotaBot');

  // One identified MCP call consumes one unit of quota
  const callRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    headers: authHeaders(agent),
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_service_status', arguments: { service: 'openai' } }
    }
  });
  assert.strictEqual(callRes.status, 200);
  assert.strictEqual(callRes.headers.get('x-ratelimit-remaining'), '99');

  // Exhaust the quota: the next identified MCP call is rejected pre-execution
  exhaustQuota(agent.id);
  const blockedRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    headers: authHeaders(agent),
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_service_status', arguments: { service: 'openai' } }
    }
  });
  assert.strictEqual(blockedRes.status, 429);
  assert.ok(parseInt(blockedRes.headers.get('retry-after'), 10) > 0);
  const blockedData = await blockedRes.json();
  assert.strictEqual(blockedData.error.code, -32029);
  assert.ok(blockedData.error.message.includes('Rate limit exceeded'));

  // Anonymous MCP reads stay open even so
  const anonRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    body: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_service_status', arguments: { service: 'openai' } }
    }
  });
  assert.strictEqual(anonRes.status, 200);
});
