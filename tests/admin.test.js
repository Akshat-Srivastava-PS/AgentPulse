import test from 'node:test';
import assert from 'node:assert';
import { dispatchRequest } from './testHelper.js';
import { getDb } from '../src/db/index.js';

// Owner visibility: request logging + admin endpoints + /admin page.
// Fully offline — all requests are dispatched in-process via testHelper.
// ADMIN_TOKEN is read from process.env at request time, so each test sets
// (or deletes) it explicitly; test files run in their own processes.

const ADMIN_TOKEN = 'test-admin-token-visibility';

async function registerAgent(name) {
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    body: {
      agent_name: name,
      operator_url: 'https://github.com/myorg/visibility-test-bot'
    }
  });
  assert.strictEqual(res.status, 201);
  const data = await res.json();
  return data.agent; // includes one-time api_key
}

function adminHeaders(token = ADMIN_TOKEN) {
  return { 'Authorization': `Bearer ${token}` };
}

function logRowsForAgent(agentId) {
  return getDb().prepare('SELECT * FROM request_log WHERE agent_id = ? ORDER BY id ASC').all(agentId);
}

test('50. Admin: endpoints return 503 admin_disabled when ADMIN_TOKEN is unset', async () => {
  const saved = process.env.ADMIN_TOKEN;
  delete process.env.ADMIN_TOKEN;
  try {
    const agentsRes = await dispatchRequest({ url: '/v1/admin/agents' });
    assert.strictEqual(agentsRes.status, 503);
    assert.strictEqual((await agentsRes.json()).error, 'admin_disabled');

    const requestsRes = await dispatchRequest({ url: '/v1/admin/requests' });
    assert.strictEqual(requestsRes.status, 503);
    assert.strictEqual((await requestsRes.json()).error, 'admin_disabled');

    // Even a bearer token does not help while disabled
    const withToken = await dispatchRequest({
      url: '/v1/admin/agents',
      headers: adminHeaders('anything')
    });
    assert.strictEqual(withToken.status, 503);
  } finally {
    if (saved !== undefined) process.env.ADMIN_TOKEN = saved;
  }
});

test('51. Admin: wrong or missing token gets 401, correct token gets 200', async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;

  const noToken = await dispatchRequest({ url: '/v1/admin/agents' });
  assert.strictEqual(noToken.status, 401);

  const wrongToken = await dispatchRequest({
    url: '/v1/admin/agents',
    headers: adminHeaders('not-the-admin-token')
  });
  assert.strictEqual(wrongToken.status, 401);
  assert.strictEqual((await wrongToken.json()).error, 'unauthorized');

  const wrongRequests = await dispatchRequest({
    url: '/v1/admin/requests',
    headers: adminHeaders('not-the-admin-token')
  });
  assert.strictEqual(wrongRequests.status, 401);

  const ok = await dispatchRequest({
    url: '/v1/admin/agents',
    headers: adminHeaders()
  });
  assert.strictEqual(ok.status, 200);
  const data = await ok.json();
  assert.ok(data.generated_at);
  assert.ok(data.totals);
  assert.ok(Number.isInteger(data.totals.agents));
  assert.ok(Number.isInteger(data.totals.requests_today));
  assert.ok(Number.isInteger(data.totals.requests_24h));
  assert.ok(Number.isInteger(data.totals.counted_today));
  assert.ok(Array.isArray(data.agents));
});

test('52. Admin: identified calls are logged and reflected in per-agent totals and top endpoints', async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  const agent = await registerAgent('VisibilityBot');
  const auth = { 'Authorization': `Bearer ${agent.api_key}` };

  // Two counted identified calls + one more counted call on another path
  const s1 = await dispatchRequest({ url: '/v1/status/openai', headers: auth });
  assert.strictEqual(s1.status, 200);
  const s2 = await dispatchRequest({ url: '/v1/status/openai', headers: auth });
  assert.strictEqual(s2.status, 200);
  const deps = await dispatchRequest({ url: '/v1/agents/me/dependencies', headers: auth });
  assert.strictEqual(deps.status, 200);

  // Anonymous public read: logged with a null agent
  const anon = await dispatchRequest({ url: '/v1/services' });
  assert.strictEqual(anon.status, 200);

  // Request log rows for this agent
  const rows = logRowsForAgent(agent.id);
  assert.strictEqual(rows.length, 3, 'exactly the three identified calls are logged for the agent');
  assert.ok(rows.every(r => r.agent_name === 'VisibilityBot'));
  assert.ok(rows.every(r => r.counted === 1), 'quota-consuming calls are flagged counted');
  assert.strictEqual(rows.filter(r => r.path === '/v1/status/openai').length, 2);
  assert.strictEqual(rows.filter(r => r.path === '/v1/agents/me/dependencies').length, 1);

  // Anonymous read is in the log with null agent fields
  const anonRow = getDb().prepare(
    "SELECT * FROM request_log WHERE agent_id IS NULL AND path = '/v1/services' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.ok(anonRow, 'anonymous /v1/services read is logged');
  assert.strictEqual(anonRow.agent_name, null);
  assert.strictEqual(anonRow.counted, 0);
  assert.strictEqual(anonRow.status_code, 200);

  // Admin overview reflects the same numbers
  const overviewRes = await dispatchRequest({
    url: '/v1/admin/agents',
    headers: adminHeaders()
  });
  assert.strictEqual(overviewRes.status, 200);
  const overview = await overviewRes.json();
  const mine = overview.agents.find(a => a.id === agent.id);
  assert.ok(mine, 'registered agent appears in admin overview');
  assert.strictEqual(mine.agent_name, 'VisibilityBot');
  assert.strictEqual(mine.requests_today, 3);
  assert.strictEqual(mine.quota_remaining, 97);
  assert.strictEqual(mine.daily_quota, 100);
  assert.strictEqual(mine.total_requests, 3);
  assert.ok(mine.last_seen_at, 'last_seen_at is populated');
  assert.ok(Array.isArray(mine.top_endpoints) && mine.top_endpoints.length >= 2);
  assert.deepStrictEqual(mine.top_endpoints[0], { path: '/v1/status/openai', count: 2 });
  assert.ok(overview.totals.counted_today >= 3);
  assert.ok(overview.totals.requests_24h >= 4, 'anonymous reads count toward fleet request totals');
  assert.ok(overview.totals.agents >= 1);

  // Agents are sorted by requests_today desc
  const todays = overview.agents.map(a => a.requests_today);
  const sorted = [...todays].sort((a, b) => b - a);
  assert.deepStrictEqual(todays, sorted);

  // Recent-requests feed carries the row shape and includes our agent
  const feedRes = await dispatchRequest({
    url: '/v1/admin/requests?limit=50',
    headers: adminHeaders()
  });
  assert.strictEqual(feedRes.status, 200);
  const feed = await feedRes.json();
  assert.ok(Array.isArray(feed.requests));
  const myRow = feed.requests.find(r => r.agent_name === 'VisibilityBot' && r.path === '/v1/status/openai');
  assert.ok(myRow, 'feed includes the identified status call');
  assert.strictEqual(myRow.method, 'GET');
  assert.strictEqual(myRow.status_code, 200);
  assert.strictEqual(myRow.counted, true);
  assert.ok(myRow.created_at);
  const anonFeedRow = feed.requests.find(r => r.path === '/v1/services');
  assert.ok(anonFeedRow, 'feed includes the anonymous read');
  assert.strictEqual(anonFeedRow.agent_name, null);
  assert.strictEqual(anonFeedRow.counted, false);

  // Admin calls themselves are never written to the request log
  const adminRows = getDb().prepare(
    "SELECT count(*) as count FROM request_log WHERE path LIKE '/v1/admin/%'"
  ).get();
  assert.strictEqual(adminRows.count, 0);
});

test('53. Admin: MCP tools/call is logged (tools/list is not), and the /admin page serves', async () => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  const agent = await registerAgent('VisibilityMcpBot');
  const auth = { 'Authorization': `Bearer ${agent.api_key}` };

  // tools/list is protocol chatter: not logged even when identified
  const listRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    headers: auth,
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  });
  assert.strictEqual(listRes.status, 200);
  assert.strictEqual(logRowsForAgent(agent.id).length, 0, 'tools/list must not be logged');

  // tools/call is agent usage: logged once, counted
  const callRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    headers: auth,
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_service_status', arguments: { service: 'openai' } }
    }
  });
  assert.strictEqual(callRes.status, 200);
  const rows = logRowsForAgent(agent.id);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].path, '/mcp');
  assert.strictEqual(rows[0].method, 'POST');
  assert.strictEqual(rows[0].counted, 1);
  assert.strictEqual(rows[0].agent_name, 'VisibilityMcpBot');

  // Anonymous tools/call is logged with a null agent
  const anonCall = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    body: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_service_status', arguments: { service: 'openai' } }
    }
  });
  assert.strictEqual(anonCall.status, 200);
  const anonMcpRow = getDb().prepare(
    "SELECT * FROM request_log WHERE agent_id IS NULL AND path = '/mcp' ORDER BY id DESC LIMIT 1"
  ).get();
  assert.ok(anonMcpRow, 'anonymous MCP tools/call is logged');
  assert.strictEqual(anonMcpRow.counted, 0);

  // The owner page itself is public HTML (data behind it is token-gated)
  const page = await dispatchRequest({ url: '/admin' });
  assert.strictEqual(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('Owner Visibility'));
  assert.ok(html.includes('/v1/admin/agents'));
  assert.ok(html.includes('sessionStorage'), 'token is kept in sessionStorage only');
});
