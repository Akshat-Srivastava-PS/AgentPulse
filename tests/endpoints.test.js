import test, { before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import { dispatchRequest } from './testHelper.js';
import { createBreakingChange, getBreakingChanges } from '../src/db/index.js';
import { classifyBreakingChange, buildPlaybook } from '../src/engine/playbooks.js';
import { processFetchedSpec } from '../src/workers/specDiff.js';
import { flushWebhookDeliveries } from '../src/workers/webhooks.js';

// Endpoint-level relevance: manifest entries may declare the endpoints an
// agent actually calls; impact verdicts, the scope=mine feed, and
// change.detected webhooks then only count changes on matching operations.
// Fully offline — requests are dispatched in-process via testHelper and
// webhook deliveries go to a local HTTP receiver. Breaking-change fixtures
// carry explicit ids: the default id is millisecond-derived and back-to-back
// inserts in one test would collide.
process.env.WEBHOOK_RETRY_DELAYS_MS = '10,20';

async function registerAgent(name) {
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    body: { agent_name: name, operator_url: 'https://github.com/myorg/endpoints-test-bot' }
  });
  assert.strictEqual(res.status, 201);
  return (await res.json()).agent; // includes one-time api_key
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

async function preflightImpact(agent, service) {
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/preflight',
    headers: authHeaders(agent),
    body: { dependencies: [service] }
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  return data.services[service].impact;
}

test('83. Endpoints: manifest stores normalized endpoints and returns them; invalid shapes are 400', async () => {
  const agent = await registerAgent('EndpointsRoundTripBot');

  const putRes = await putManifest(agent, [
    { service: 'pinecone', endpoints: ['post /v1/upsert', '/v1/stats/', 'GET /v1/query', 'POST /v1/upsert'] },
    { service: 'openai' }
  ]);
  assert.strictEqual(putRes.status, 200);
  const putData = await putRes.json();
  const pinecone = putData.dependencies.find(d => d.service === 'pinecone');
  assert.deepStrictEqual(
    pinecone.endpoints,
    ['POST /v1/upsert', '/v1/stats', 'GET /v1/query'],
    'Endpoints are normalized (method uppercased, trailing slash stripped) and deduped'
  );
  const openai = putData.dependencies.find(d => d.service === 'openai');
  assert.strictEqual(openai.endpoints, null, 'No declared endpoints reads back as null');

  const getRes = await dispatchRequest({
    url: '/v1/agents/me/dependencies',
    headers: authHeaders(agent)
  });
  const getData = await getRes.json();
  assert.deepStrictEqual(getData.dependencies.find(d => d.service === 'pinecone').endpoints, pinecone.endpoints);

  // Invalid endpoint shapes are rejected and store nothing
  const badString = await putManifest(agent, [{ service: 'pinecone', endpoints: 'GET /v1/query' }]);
  assert.strictEqual(badString.status, 400);
  const badEntry = await putManifest(agent, [{ service: 'pinecone', endpoints: ['not-a-path'] }]);
  assert.strictEqual(badEntry.status, 400);
  assert.ok((await badEntry.json()).error.includes('endpoints'));
  const afterRes = await dispatchRequest({
    url: '/v1/agents/me/dependencies',
    headers: authHeaders(agent)
  });
  assert.strictEqual((await afterRes.json()).count, 2, 'Rejected PUTs leave the stored manifest untouched');
});

test('84. Endpoints: impact verdict counts only changes on declared endpoints', async () => {
  const matching = createBreakingChange({
    id: 'bc_ep_pinecone_match',
    service_slug: 'pinecone',
    version_or_date: '2026-11-22',
    change_type: 'schema_diff',
    kind: 'removed_response_property',
    location: 'POST /v1/upsert response property vector.values',
    diff_summary: "Removed response property 'vector.values' from POST /v1/upsert success responses.",
    migration_hint: 'Stop reading vector.values from upsert responses.'
  });
  const other = createBreakingChange({
    id: 'bc_ep_pinecone_other',
    service_slug: 'pinecone',
    version_or_date: '2026-11-22',
    change_type: 'schema_diff',
    kind: 'removed_response_property',
    location: 'GET /v1/query response property matches.score',
    diff_summary: "Removed response property 'matches.score' from GET /v1/query success responses.",
    migration_hint: 'Stop reading matches.score from query responses.'
  });

  // Exact method+path declaration: only the matching change counts
  const exactAgent = await registerAgent('EndpointsExactBot');
  await putManifest(exactAgent, [{ service: 'pinecone', endpoints: ['POST /v1/upsert'] }]);
  const exactImpact = await preflightImpact(exactAgent, 'pinecone');
  assert.strictEqual(exactImpact.affected, true);
  assert.ok(exactImpact.change_ids.includes(matching.id));
  assert.ok(!exactImpact.change_ids.includes(other.id), 'Change on an undeclared endpoint must not count');

  // Path-only declaration matches any method on that path (and subpaths)
  const pathAgent = await registerAgent('EndpointsPathBot');
  await putManifest(pathAgent, [{ service: 'pinecone', endpoints: ['/v1/query'] }]);
  const pathImpact = await preflightImpact(pathAgent, 'pinecone');
  assert.strictEqual(pathImpact.affected, true);
  assert.ok(pathImpact.change_ids.includes(other.id));
  assert.ok(!pathImpact.change_ids.includes(matching.id));

  // Declared endpoints with no matching change: not affected
  const noneAgent = await registerAgent('EndpointsNoneBot');
  await putManifest(noneAgent, [{ service: 'pinecone', endpoints: ['DELETE /v1/delete'] }]);
  const noneImpact = await preflightImpact(noneAgent, 'pinecone');
  assert.strictEqual(noneImpact.affected, false);
  assert.deepStrictEqual(noneImpact.change_ids, []);

  // No endpoints declared: service-level behaviour, both changes count
  const plainAgent = await registerAgent('EndpointsPlainBot');
  await putManifest(plainAgent, [{ service: 'pinecone' }]);
  const plainImpact = await preflightImpact(plainAgent, 'pinecone');
  assert.strictEqual(plainImpact.affected, true);
  assert.ok(plainImpact.change_ids.includes(matching.id));
  assert.ok(plainImpact.change_ids.includes(other.id));
});

test('85. Endpoints: scope=mine feed excludes changes on undeclared endpoints', async () => {
  const matching = createBreakingChange({
    id: 'bc_ep_mongo_match',
    service_slug: 'mongodb',
    version_or_date: '2026-11-22',
    change_type: 'schema_diff',
    kind: 'removed_response_property',
    location: 'GET /v1/projects response property name',
    diff_summary: "Removed response property 'name' from GET /v1/projects success responses.",
    migration_hint: 'Stop reading name from project responses.'
  });
  const other = createBreakingChange({
    id: 'bc_ep_mongo_other',
    service_slug: 'mongodb',
    version_or_date: '2026-11-22',
    change_type: 'schema_diff',
    kind: 'new_required_request_property',
    location: 'POST /v1/clusters request property size',
    diff_summary: "New required request property 'size' on POST /v1/clusters.",
    migration_hint: 'Always send size when creating a cluster.'
  });

  const scopedAgent = await registerAgent('EndpointsFeedBot');
  await putManifest(scopedAgent, [{ service: 'mongodb', endpoints: ['GET /v1/projects'] }]);
  const scopedRes = await dispatchRequest({
    url: '/v1/changes?scope=mine',
    headers: authHeaders(scopedAgent)
  });
  const scopedData = await scopedRes.json();
  const scopedIds = scopedData.changes.map(c => c.id);
  assert.ok(scopedIds.includes(matching.id));
  assert.ok(!scopedIds.includes(other.id), 'scope=mine must exclude changes on undeclared endpoints');

  const plainAgent = await registerAgent('EndpointsFeedPlainBot');
  await putManifest(plainAgent, [{ service: 'mongodb' }]);
  const plainRes = await dispatchRequest({
    url: '/v1/changes?scope=mine',
    headers: authHeaders(plainAgent)
  });
  const plainIds = (await plainRes.json()).changes.map(c => c.id);
  assert.ok(plainIds.includes(matching.id) && plainIds.includes(other.id),
    'Without declared endpoints the feed keeps both changes (service-level)');
});

// --- Webhook receiver (two paths so the two owners' deliveries separate) ---
const hookHits = [];
let receiver;
let receiverBase;

before(async () => {
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      hookHits.push({ path: req.url, json: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  receiverBase = `http://127.0.0.1:${receiver.address().port}`;
});

after(() => { receiver.close(); });

async function createWebhook(agent, url) {
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/me/webhooks',
    headers: authHeaders(agent),
    body: { url, events: ['change.detected'], services: ['sentry'] }
  });
  assert.strictEqual(res.status, 201);
  return (await res.json()).webhook;
}

test('86. Endpoints: change.detected webhooks respect the owner\'s declared endpoints', async () => {
  const scopedAgent = await registerAgent('EndpointsHookScopedBot');
  await putManifest(scopedAgent, [{ service: 'sentry', endpoints: ['POST /v1/events'] }]);
  await createWebhook(scopedAgent, `${receiverBase}/scoped`);

  const plainAgent = await registerAgent('EndpointsHookPlainBot');
  await putManifest(plainAgent, [{ service: 'sentry' }]);
  await createWebhook(plainAgent, `${receiverBase}/plain`);

  const offTarget = createBreakingChange({
    id: 'bc_ep_sentry_off',
    service_slug: 'sentry',
    version_or_date: '2026-11-22',
    change_type: 'schema_diff',
    kind: 'removed_response_property',
    location: 'GET /v1/projects response property id',
    diff_summary: "Removed response property 'id' from GET /v1/projects success responses.",
    migration_hint: 'Stop reading id from project responses.'
  });
  await flushWebhookDeliveries();
  assert.strictEqual(hookHits.filter(h => h.path === '/scoped').length, 0,
    'Scoped owner must not be delivered changes on undeclared endpoints');
  assert.strictEqual(hookHits.filter(h => h.path === '/plain' && h.json.data.id === offTarget.id).length, 1,
    'Owner without endpoints still receives every change on the service');

  const onTarget = createBreakingChange({
    id: 'bc_ep_sentry_on',
    service_slug: 'sentry',
    version_or_date: '2026-11-22',
    change_type: 'schema_diff',
    kind: 'removed_response_property',
    location: 'POST /v1/events response property id',
    diff_summary: "Removed response property 'id' from POST /v1/events success responses.",
    migration_hint: 'Stop reading id from event responses.'
  });
  await flushWebhookDeliveries();
  assert.strictEqual(hookHits.filter(h => h.path === '/scoped' && h.json.data.id === onTarget.id).length, 1,
    'Scoped owner receives changes on declared endpoints');
  assert.strictEqual(hookHits.filter(h => h.path === '/plain' && h.json.data.id === onTarget.id).length, 1);
});

test('87. Endpoints: legacy rows without a location still count at service level', async () => {
  const legacy = createBreakingChange({
    id: 'bc_ep_zoom_legacy',
    service_slug: 'zoom',
    version_or_date: '2026-11-22',
    change_type: 'schema_diff',
    diff_summary: 'Zoom API removed the `join_url` field from meeting responses.',
    migration_hint: 'Read meeting links from the `links` object instead.'
  });
  assert.strictEqual(legacy.kind, null);
  assert.strictEqual(legacy.location, null);

  const agent = await registerAgent('EndpointsLegacyBot');
  await putManifest(agent, [{ service: 'zoom', endpoints: ['GET /v1/meetings'] }]);

  const impact = await preflightImpact(agent, 'zoom');
  assert.strictEqual(impact.affected, true, 'A legacy row must still mark the dependency affected');
  assert.ok(impact.change_ids.includes(legacy.id));

  const feedRes = await dispatchRequest({
    url: '/v1/changes?scope=mine',
    headers: authHeaders(agent)
  });
  const feedIds = (await feedRes.json()).changes.map(c => c.id);
  assert.ok(feedIds.includes(legacy.id), 'scope=mine must not drop legacy rows');
});

test('88. Playbooks: stored kind/location are preferred; legacy rows still classify from summary', () => {
  // New-style row: kind/location columns set, summary deliberately matches
  // no regex — classification must come from the stored columns.
  const storedRow = {
    id: 'bc_stored_kind',
    service_slug: 'stripe',
    change_type: 'schema_diff',
    kind: 'removed_response_property',
    location: 'GET /v1/charges response property customer.email',
    diff_summary: 'Provider note: something about charges changed.',
    migration_hint: 'Stop reading customer.email.'
  };
  const stored = classifyBreakingChange(storedRow);
  assert.strictEqual(stored.kind, 'removed_response_property');
  assert.strictEqual(stored.details.operation, 'GET /v1/charges');
  assert.strictEqual(stored.details.name, 'customer.email');
  assert.strictEqual(buildPlaybook(storedRow).kind, 'removed_response_property');

  // Legacy row: no kind/location — the summary regex path still classifies.
  const legacy = classifyBreakingChange({
    id: 'bc_legacy_kind',
    service_slug: 'stripe',
    change_type: 'schema_diff',
    kind: null,
    location: null,
    diff_summary: 'Removed operation GET /v1/charges.',
    migration_hint: 'Remove all calls to GET /v1/charges.'
  });
  assert.strictEqual(legacy.kind, 'removed_operation');
  assert.strictEqual(legacy.details.operation, 'GET /v1/charges');
});

test('89. SpecDiff: processFetchedSpec persists the structured kind and location', () => {
  const specUrl = 'https://specs.example.test/cohere.json';
  const baseSpec = {
    info: { version: '1.0.0' },
    paths: {
      '/v1/generate': {
        post: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      text: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
  const changedSpec = JSON.parse(JSON.stringify(baseSpec));
  delete changedSpec.paths['/v1/generate'].post.responses['200'].content['application/json'].schema.properties.text;

  const baseline = processFetchedSpec('cohere', specUrl, JSON.stringify(baseSpec));
  assert.strictEqual(baseline.baseline, true);

  const result = processFetchedSpec('cohere', specUrl, JSON.stringify(changedSpec));
  assert.strictEqual(result.inserted, 1);

  const rows = getBreakingChanges('cohere').filter(c => c.kind === 'removed_response_property');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].location, 'POST /v1/generate response property text');
  assert.strictEqual(rows[0].change_type, 'schema_diff');
});
