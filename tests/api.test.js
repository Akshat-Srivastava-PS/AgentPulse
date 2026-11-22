import test from 'node:test';
import assert from 'node:assert';
import { dispatchRequest, insertStripeIncidentFixture, insertOpenaiDeprecationFixture } from './testHelper.js';
import { estimateTokenCount } from '../src/engine/normalizer.js';

test('1. Discovery: GET /llms.txt adheres to llms.txt standard', async () => {
  const res = await dispatchRequest({ url: '/llms.txt' });
  assert.strictEqual(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/plain/);

  const text = await res.text();
  assert.ok(text.startsWith('# AgentPulse'), 'Must start with H1 title');
  assert.ok(text.includes('> Real-time ground-truth hub'), 'Must include blockquote summary');
  assert.ok(text.includes('/openapi.json'), 'Must link to openapi.json');
  assert.ok(text.includes('/mcp'), 'Must link to MCP server');
  assert.ok(text.includes('/v1/preflight'), 'Must link to preflight');
});

test('2. Discovery: GET /llms-full.txt returns full operational documentation', async () => {
  const res = await dispatchRequest({ url: '/llms-full.txt' });
  assert.strictEqual(res.status, 200);
  const text = await res.text();
  assert.ok(text.includes('Complete Agent Integration Guide'));
  assert.ok(text.includes('Good Citizen Protocol'));
  assert.ok(text.includes('mcpServers'));
});

test('3. Discovery: GET /openapi.json returns strict OpenAPI 3.1.0 schema', async () => {
  const res = await dispatchRequest({ url: '/openapi.json' });
  assert.strictEqual(res.status, 200);

  const schema = await res.json();
  assert.strictEqual(schema.openapi, '3.1.0');
  assert.strictEqual(schema.info.title, 'AgentPulse API & Cloud Status Oracle');
  assert.ok(schema.paths['/v1/status/{service}']);
  assert.ok(schema.paths['/v1/preflight']);
  assert.ok(schema.paths['/mcp']);
  assert.ok(schema.paths['/v1/agents/register']);
});

test('4. Bot Onboarding: POST /v1/agents/register issues API key with zero CAPTCHA', async () => {
  // Test invalid payload
  const badRes = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    body: { agent_name: '' }
  });
  assert.strictEqual(badRes.status, 400);

  // Test valid registration
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    headers: { 'User-Agent': 'Test-Agent-Runner/1.0' },
    body: {
      agent_name: 'Claude-Code-Bot-42',
      operator_url: 'https://github.com/myorg/claude-bot'
    }
  });

  assert.strictEqual(res.status, 201);
  const data = await res.json();
  assert.ok(data.agent);
  assert.strictEqual(data.agent.agent_name, 'Claude-Code-Bot-42');
  assert.ok(data.agent.api_key.startsWith('agp_live_'));
  assert.strictEqual(data.agent.tier, 'free_verified');
  assert.strictEqual(data.agent.daily_quota, 100);
  assert.strictEqual(data.agent.good_citizen_score, 100);
});

test('5. Core Query: GET /v1/status/stripe returns compact payload under 150 tokens', async () => {
  insertStripeIncidentFixture();
  const res = await dispatchRequest({ url: '/v1/status/stripe' });
  assert.strictEqual(res.status, 200);

  const etag = res.headers.get('etag');
  assert.ok(etag, 'Must return ETag header');

  const data = await res.json();
  assert.strictEqual(data.service, 'stripe');
  assert.strictEqual(data.status, 'degraded');
  assert.ok(Array.isArray(data.active_incidents));
  assert.ok(data.active_incidents.length > 0);

  const inc = data.active_incidents[0];
  assert.strictEqual(inc.id, 'inc_9821');
  assert.strictEqual(inc.severity, 'major');
  assert.strictEqual(inc.scope, 'POST /v1/payment_intents (us-east-1)');
  assert.ok(inc.summary.includes('502 error rate'));
  assert.ok(inc.agent_hint.includes('exponential backoff'));

  // Assert token count constraint strictly under 150 tokens
  const tokenEstimate = estimateTokenCount(data);
  assert.ok(tokenEstimate < 150, `Token count must be < 150, got ${tokenEstimate}`);
});

test('6. ETag Caching: GET /v1/status/stripe with If-None-Match returns 304 Not Modified', async () => {
  insertStripeIncidentFixture();
  // First fetch to obtain current ETag
  const res1 = await dispatchRequest({ url: '/v1/status/stripe' });
  const etag = res1.headers.get('etag');
  assert.ok(etag);

  // Second fetch with If-None-Match
  const res2 = await dispatchRequest({
    url: '/v1/status/stripe',
    headers: {
      'If-None-Match': etag
    }
  });

  assert.strictEqual(res2.status, 304, 'Must return 304 Not Modified');
  const body = await res2.text();
  assert.strictEqual(body, '', '304 response body must be empty (0 tokens!)');
});

test('7. Good Citizen Protocol: 304 response increases agent good_citizen_score', async () => {
  // 1. Register an agent
  const regRes = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    body: {
      agent_name: 'GoodCitizenBot',
      operator_url: 'https://github.com/myorg/good-bot'
    }
  });
  const { agent } = await regRes.json();
  const apiKey = agent.api_key;
  const initialScore = agent.good_citizen_score;

  // 2. Query status to get ETag
  const statusRes = await dispatchRequest({
    url: '/v1/status/openai',
    headers: { 'Authorization': `Bearer ${apiKey}` }
  });
  const etag = statusRes.headers.get('etag');

  // 3. Query status again with ETag
  const cachedRes = await dispatchRequest({
    url: '/v1/status/openai',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'If-None-Match': etag
    }
  });

  assert.strictEqual(cachedRes.status, 304);
  const newScore = parseInt(cachedRes.headers.get('x-good-citizen-score'), 10);
  assert.ok(newScore > initialScore, `Good citizen score must increase: was ${initialScore}, now ${newScore}`);
});

test('8. Batch Preflight: POST /v1/preflight evaluates dependency health correctly', async () => {
  insertStripeIncidentFixture();
  // Case A: includes degraded dependency (stripe)
  const res1 = await dispatchRequest({
    method: 'POST',
    url: '/v1/preflight',
    body: {
      dependencies: ['stripe', 'supabase', 'resend']
    }
  });

  assert.strictEqual(res1.status, 200);
  const data1 = await res1.json();
  assert.strictEqual(data1.verdict, 'degraded');
  assert.strictEqual(data1.healthy, false);
  assert.strictEqual(data1.degraded_count, 1);
  assert.ok(data1.recommendation.includes('stripe'));
  assert.strictEqual(data1.services.stripe.status, 'degraded');
  assert.strictEqual(data1.services.supabase.status, 'operational');

  // Case B: all dependencies operational
  const res2 = await dispatchRequest({
    method: 'POST',
    url: '/v1/preflight',
    body: {
      dependencies: ['supabase', 'resend', 'github']
    }
  });

  assert.strictEqual(res2.status, 200);
  const data2 = await res2.json();
  assert.strictEqual(data2.verdict, 'pass');
  assert.strictEqual(data2.healthy, true);
  assert.strictEqual(data2.degraded_count, 0);

  // Case C: unknown dependency handling
  const res3 = await dispatchRequest({
    method: 'POST',
    url: '/v1/preflight',
    body: {
      dependencies: ['some_nonexistent_service_xyz']
    }
  });
  assert.strictEqual(res3.status, 200);
  const data3 = await res3.json();
  assert.strictEqual(data3.services.some_nonexistent_service_xyz.tracked, false);
});

test('9. Delta Feed: GET /v1/changes returns recent breaking changes', async () => {
  insertOpenaiDeprecationFixture();
  const res = await dispatchRequest({ url: '/v1/changes' });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.changes));
  assert.ok(data.changes.length > 0);

  const openaiChange = data.changes.find(c => c.service_slug === 'openai');
  assert.ok(openaiChange);
  assert.strictEqual(openaiChange.change_type, 'deprecation');
});

test('10. Catalog & Incidents: GET /v1/services and GET /v1/incidents', async () => {
  insertStripeIncidentFixture();
  const servicesRes = await dispatchRequest({ url: '/v1/services' });
  assert.strictEqual(servicesRes.status, 200);
  const servicesData = await servicesRes.json();
  assert.strictEqual(servicesData.count, 37);

  const incRes = await dispatchRequest({ url: '/v1/incidents' });
  assert.strictEqual(incRes.status, 200);
  const incData = await incRes.json();
  assert.ok(incData.incidents.length >= 1);
  assert.strictEqual(incData.incidents[0].service_slug, 'stripe');
});

test('11. Telemetry: POST /v1/telemetry/report logs crowdsourced outage signal (auth required since Step 3)', async () => {
  // Anonymous reports are rejected — writes must be attributable to an agent
  const anonRes = await dispatchRequest({
    method: 'POST',
    url: '/v1/telemetry/report',
    body: {
      service: 'github',
      endpoint: 'POST /repos/owner/repo/pulls',
      error_code: 502,
      error_type: '502_bad_gateway'
    }
  });
  assert.strictEqual(anonRes.status, 401);

  const regRes = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    body: {
      agent_name: 'TelemetryBot',
      operator_url: 'https://github.com/myorg/telemetry-bot'
    }
  });
  const { agent } = await regRes.json();

  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/telemetry/report',
    headers: { 'Authorization': `Bearer ${agent.api_key}` },
    body: {
      service: 'github',
      endpoint: 'POST /repos/owner/repo/pulls',
      error_code: 502,
      error_type: '502_bad_gateway'
    }
  });

  assert.strictEqual(res.status, 202);
  const data = await res.json();
  assert.strictEqual(data.signal.service_slug, 'github');
});

test('12. Metrics: GET /v1/metrics returns system health and token economy metrics', async () => {
  const res = await dispatchRequest({ url: '/v1/metrics' });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.services.total, 37);
  assert.ok(data.estimated_tokens_saved > 0);
});

test('13. MCP Server: Standard JSON-RPC 2.0 initialize, tools/list, and tools/call', async () => {
  insertStripeIncidentFixture();
  // initialize
  const initRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize'
    }
  });
  assert.strictEqual(initRes.status, 200);
  const initData = await initRes.json();
  assert.strictEqual(initData.result.serverInfo.name, 'agentpulse-oracle');

  // tools/list
  const listRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    }
  });
  assert.strictEqual(listRes.status, 200);
  const listData = await listRes.json();
  const tools = listData.result.tools;
  assert.ok(tools.some(t => t.name === 'check_dependency_health'));
  assert.ok(tools.some(t => t.name === 'lookup_breaking_changes'));
  assert.ok(tools.some(t => t.name === 'get_service_status'));

  // tools/call -> check_dependency_health
  const callRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    body: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'check_dependency_health',
        arguments: {
          dependencies: ['stripe', 'openai']
        }
      }
    }
  });
  assert.strictEqual(callRes.status, 200);
  const callData = await callRes.json();
  assert.ok(callData.result.content[0].text);
  const content = JSON.parse(callData.result.content[0].text);
  assert.strictEqual(content.verdict, 'degraded');
});

test('14. MCP Server: Stateless HTTP Header-based Routing (Mcp-Method / Mcp-Name)', async () => {
  insertStripeIncidentFixture();
  const res = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    headers: {
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'get_service_status'
    },
    body: {
      service: 'stripe'
    }
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(data.content[0].text);
  const statusPayload = JSON.parse(data.content[0].text);
  assert.strictEqual(statusPayload.service, 'stripe');
  assert.strictEqual(statusPayload.status, 'degraded');
});
