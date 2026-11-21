import test from 'node:test';
import assert from 'node:assert';
import { dispatchRequest } from './testHelper.js';
import { createBreakingChange } from '../src/db/index.js';

// Step 2: per-agent dependency manifests + "affected code" answers.
// Fully offline — all requests are dispatched in-process via testHelper.

async function registerAgent(name) {
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    body: {
      agent_name: name,
      operator_url: 'https://github.com/myorg/manifest-test-bot'
    }
  });
  assert.strictEqual(res.status, 201);
  const data = await res.json();
  return data.agent; // includes one-time api_key
}

function authHeaders(agent) {
  return { 'Authorization': `Bearer ${agent.api_key}` };
}

async function putManifest(agent, dependencies) {
  return dispatchRequest({
    method: 'PUT',
    url: '/v1/agents/me/dependencies',
    headers: authHeaders(agent),
    body: { dependencies }
  });
}

test('21. Manifest: PUT/GET round-trip stores services, packages, and versions (replace-all)', async () => {
  const agent = await registerAgent('ManifestRoundTripBot');

  // Initially empty
  const emptyRes = await dispatchRequest({
    url: '/v1/agents/me/dependencies',
    headers: authHeaders(agent)
  });
  assert.strictEqual(emptyRes.status, 200);
  const emptyData = await emptyRes.json();
  assert.strictEqual(emptyData.count, 0);
  assert.deepStrictEqual(emptyData.dependencies, []);

  // PUT a manifest with package pins and a bare service
  const putRes = await putManifest(agent, [
    { service: 'stripe', package: 'stripe', version: '14.5.0' },
    { service: 'openai' }
  ]);
  assert.strictEqual(putRes.status, 200);
  const putData = await putRes.json();
  assert.strictEqual(putData.count, 2);

  const stripeDep = putData.dependencies.find(d => d.service === 'stripe');
  assert.ok(stripeDep);
  assert.strictEqual(stripeDep.package, 'stripe');
  assert.strictEqual(stripeDep.version, '14.5.0');
  const openaiDep = putData.dependencies.find(d => d.service === 'openai');
  assert.ok(openaiDep);
  assert.strictEqual(openaiDep.package, null);
  assert.strictEqual(openaiDep.version, null);

  // GET returns the same stored manifest
  const getRes = await dispatchRequest({
    url: '/v1/agents/me/dependencies',
    headers: authHeaders(agent)
  });
  assert.strictEqual(getRes.status, 200);
  const getData = await getRes.json();
  assert.strictEqual(getData.agent_id, agent.id);
  assert.strictEqual(getData.count, 2);
  assert.deepStrictEqual(
    getData.dependencies.map(d => d.service),
    ['openai', 'stripe'],
    'Manifest is returned ordered by service slug'
  );

  // Replace-all: a second PUT fully replaces the first manifest
  const replaceRes = await putManifest(agent, [{ service: 'github', package: '@octokit/rest', version: '20.0.0' }]);
  assert.strictEqual(replaceRes.status, 200);
  const afterRes = await dispatchRequest({
    url: '/v1/agents/me/dependencies',
    headers: authHeaders(agent)
  });
  const afterData = await afterRes.json();
  assert.strictEqual(afterData.count, 1);
  assert.strictEqual(afterData.dependencies[0].service, 'github');
  assert.strictEqual(afterData.dependencies[0].package, '@octokit/rest');

  // Replace-all with an empty array clears the manifest
  const clearRes = await putManifest(agent, []);
  assert.strictEqual(clearRes.status, 200);
  const clearedRes = await dispatchRequest({
    url: '/v1/agents/me/dependencies',
    headers: authHeaders(agent)
  });
  assert.strictEqual((await clearedRes.json()).count, 0);
});

test('22. Manifest: unknown service slug is rejected with 400 naming the slug', async () => {
  const agent = await registerAgent('ManifestValidationBot');

  const res = await putManifest(agent, [
    { service: 'stripe' },
    { service: 'not_a_real_service_xyz' }
  ]);
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.ok(data.error.includes('not_a_real_service_xyz'), 'Error must name the bad slug');
  assert.strictEqual(data.unknown_service, 'not_a_real_service_xyz');

  // The rejected PUT must not have stored a partial manifest
  const getRes = await dispatchRequest({
    url: '/v1/agents/me/dependencies',
    headers: authHeaders(agent)
  });
  assert.strictEqual((await getRes.json()).count, 0);

  // Malformed bodies are also 400
  const badBody = await dispatchRequest({
    method: 'PUT',
    url: '/v1/agents/me/dependencies',
    headers: authHeaders(agent),
    body: { dependencies: 'stripe' }
  });
  assert.strictEqual(badBody.status, 400);
});

test('23. Manifest: unauthenticated and bad-key requests are rejected with 401', async () => {
  const getRes = await dispatchRequest({ url: '/v1/agents/me/dependencies' });
  assert.strictEqual(getRes.status, 401);
  assert.ok((await getRes.json()).error.includes('Unauthorized'));

  const putRes = await dispatchRequest({
    method: 'PUT',
    url: '/v1/agents/me/dependencies',
    body: { dependencies: [{ service: 'stripe' }] }
  });
  assert.strictEqual(putRes.status, 401);

  const badKeyRes = await dispatchRequest({
    url: '/v1/agents/me/dependencies',
    headers: { 'Authorization': 'Bearer agp_live_totally_invalid_key' }
  });
  assert.strictEqual(badKeyRes.status, 401);
});

test('24. Preflight enrichment: manifest services gain affected verdicts (incident-driven)', async () => {
  const agent = await registerAgent('PreflightImpactBot');
  const putRes = await putManifest(agent, [{ service: 'stripe' }, { service: 'github' }]);
  assert.strictEqual(putRes.status, 200);

  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/preflight',
    headers: authHeaders(agent),
    body: { dependencies: ['stripe', 'github'] }
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();

  // stripe has the seeded active incident inc_9821 -> affected
  const stripe = data.services.stripe;
  assert.ok(stripe.impact, 'Manifest service must carry an impact verdict');
  assert.strictEqual(stripe.impact.affected, true);
  assert.ok(stripe.impact.incident_ids.includes('inc_9821'));
  assert.ok(stripe.impact.reason.includes('inc_9821'));

  // github is clean (no incidents, no breaking changes) -> not affected
  const github = data.services.github;
  assert.ok(github.impact);
  assert.strictEqual(github.impact.affected, false);
  assert.deepStrictEqual(github.impact.incident_ids, []);
  assert.deepStrictEqual(github.impact.change_ids, []);

  assert.strictEqual(data.affected_count, 1);

  // Backward compatibility: unauthenticated preflight has no impact fields
  const anonRes = await dispatchRequest({
    method: 'POST',
    url: '/v1/preflight',
    body: { dependencies: ['stripe', 'github'] }
  });
  const anonData = await anonRes.json();
  assert.strictEqual(anonData.services.stripe.impact, undefined);
  assert.strictEqual(anonData.affected_count, undefined);

  // Authenticated but manifest-less agent: also unchanged
  const noManifestAgent = await registerAgent('PreflightNoManifestBot');
  const plainRes = await dispatchRequest({
    method: 'POST',
    url: '/v1/preflight',
    headers: authHeaders(noManifestAgent),
    body: { dependencies: ['stripe'] }
  });
  const plainData = await plainRes.json();
  assert.strictEqual(plainData.services.stripe.impact, undefined);
});

test('25. Preflight enrichment: a fresh breaking change marks its service affected', async () => {
  const change = createBreakingChange({
    service_slug: 'vercel',
    version_or_date: '2026-11-21',
    change_type: 'schema_diff',
    diff_summary: 'Vercel API removed the `alias` field from deployment responses.',
    migration_hint: 'Read deployment URLs from the `url` field instead.'
  });
  assert.ok(change.id);

  const agent = await registerAgent('ChangeImpactBot');
  await putManifest(agent, [{ service: 'vercel' }]);

  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/preflight',
    headers: authHeaders(agent),
    body: { dependencies: ['vercel'] }
  });
  const data = await res.json();
  const vercel = data.services.vercel;
  assert.ok(vercel.impact);
  assert.strictEqual(vercel.impact.affected, true);
  assert.deepStrictEqual(vercel.impact.incident_ids, []);
  assert.ok(vercel.impact.change_ids.includes(change.id));
  assert.ok(vercel.impact.reason.includes(change.id));
});

test('26. Delta Feed: scope=mine filters to manifest services and requires auth', async () => {
  // Unauthenticated scope=mine -> 401
  const anonRes = await dispatchRequest({ url: '/v1/changes?scope=mine' });
  assert.strictEqual(anonRes.status, 401);

  // Agent whose manifest is only stripe sees only stripe changes
  const stripeAgent = await registerAgent('DeltaMineStripeBot');
  await putManifest(stripeAgent, [{ service: 'stripe' }]);
  const mineRes = await dispatchRequest({
    url: '/v1/changes?scope=mine',
    headers: authHeaders(stripeAgent)
  });
  assert.strictEqual(mineRes.status, 200);
  const mineData = await mineRes.json();
  assert.strictEqual(mineData.scope, 'mine');
  assert.ok(mineData.count >= 1, 'Seeded stripe breaking change bc_102 must be included');
  assert.ok(mineData.changes.every(c => c.service_slug === 'stripe'));
  assert.ok(mineData.changes.some(c => c.id === 'bc_102'));

  // Agent whose manifest has no recorded changes sees an empty feed
  const githubAgent = await registerAgent('DeltaMineGithubBot');
  await putManifest(githubAgent, [{ service: 'github' }]);
  const emptyRes = await dispatchRequest({
    url: '/v1/changes?scope=mine',
    headers: authHeaders(githubAgent)
  });
  const emptyData = await emptyRes.json();
  assert.strictEqual(emptyData.count, 0);
  assert.deepStrictEqual(emptyData.changes, []);
});

test('27. MCP: get_my_impact returns manifest verdicts via header auth and api_key fallback', async () => {
  const agent = await registerAgent('McpImpactBot');
  await putManifest(agent, [{ service: 'stripe' }, { service: 'github' }]);

  // tools/list advertises the new tool
  const listRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }
  });
  const listData = await listRes.json();
  assert.ok(listData.result.tools.some(t => t.name === 'get_my_impact'));

  // Header-authenticated JSON-RPC call
  const callRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    headers: authHeaders(agent),
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_my_impact', arguments: {} }
    }
  });
  assert.strictEqual(callRes.status, 200);
  const callData = await callRes.json();
  assert.ok(!callData.result.isError);
  const impact = JSON.parse(callData.result.content[0].text);
  assert.strictEqual(impact.agent_id, agent.id);
  assert.strictEqual(impact.manifest_count, 2);
  assert.strictEqual(impact.affected_count, 1);
  assert.deepStrictEqual(impact.affected_services, ['stripe']);
  const stripeDep = impact.dependencies.find(d => d.service === 'stripe');
  assert.strictEqual(stripeDep.impact.affected, true);
  assert.ok(stripeDep.impact.incident_ids.includes('inc_9821'));
  const githubDep = impact.dependencies.find(d => d.service === 'github');
  assert.strictEqual(githubDep.impact.affected, false);

  // api_key argument fallback (no Authorization header)
  const argRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    body: {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'get_my_impact', arguments: { api_key: agent.api_key } }
    }
  });
  const argData = await argRes.json();
  const argImpact = JSON.parse(argData.result.content[0].text);
  assert.strictEqual(argImpact.agent_id, agent.id);
  assert.strictEqual(argImpact.affected_count, 1);

  // No identity at all -> tool-level error, not a crash
  const anonRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    body: {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'get_my_impact', arguments: {} }
    }
  });
  const anonData = await anonRes.json();
  assert.strictEqual(anonData.result.isError, true);
  assert.ok(JSON.parse(anonData.result.content[0].text).error.includes('Unauthorized'));

  // check_dependency_health is manifest-aware for identified callers
  const healthRes = await dispatchRequest({
    method: 'POST',
    url: '/mcp',
    headers: authHeaders(agent),
    body: {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'check_dependency_health', arguments: { dependencies: ['stripe', 'github'] } }
    }
  });
  const healthData = await healthRes.json();
  const health = JSON.parse(healthData.result.content[0].text);
  assert.strictEqual(health.services.stripe.impact.affected, true);
  assert.strictEqual(health.services.github.impact.affected, false);
});
