import test, { before, after } from 'node:test';
import assert from 'node:assert';
import { createServer } from '../src/server.js';
import { AgentPulseClient, AgentPulseError } from '../sdk/index.js';

// Step 6: the agentpulse-sdk package exercised against the REAL HTTP API —
// a local ephemeral server running the actual app (not the in-process
// dispatch helper), because the SDK speaks global fetch.

let server;
let baseUrl;

before(async () => {
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

async function registerAgent(name) {
  const res = await fetch(`${baseUrl}/v1/agents/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_name: name, operator_url: 'https://github.com/myorg/sdk-test-bot' })
  });
  assert.strictEqual(res.status, 201);
  const data = await res.json();
  return data.agent; // includes one-time api_key
}

test('45. SDK: status, preflight, and changes hit the real API; Authorization header is sent', async () => {
  const agent = await registerAgent('SdkSurfaceBot');
  const seenAuth = [];
  const spyFetch = async (url, init) => {
    if (init?.headers?.Authorization) seenAuth.push(init.headers.Authorization);
    return fetch(url, init);
  };
  const client = new AgentPulseClient({ baseUrl, apiKey: agent.api_key, fetch: spyFetch });

  const status = await client.getStatus('stripe');
  assert.strictEqual(status.service, 'stripe');
  assert.ok(['operational', 'degraded', 'outage'].includes(status.status));
  assert.ok(seenAuth.includes(`Bearer ${agent.api_key}`), 'SDK sends the Bearer API key');

  const preflight = await client.preflight(['stripe', 'openai']);
  assert.ok(['pass', 'degraded', 'block'].includes(preflight.verdict));
  assert.strictEqual(preflight.total_requested, 2);

  const feed = await client.getChanges();
  assert.ok(Array.isArray(feed.changes) && feed.changes.length >= 1);
  for (const change of feed.changes) {
    assert.strictEqual(change.playbook_url, `${baseUrl}/v1/changes/${change.id}/playbook`);
  }

  const playbook = await client.getPlaybook('bc_101');
  assert.strictEqual(playbook.change_id, 'bc_101');
  assert.strictEqual(playbook.kind, 'deprecation');
});

test('46. SDK: setDependencies + getMyImpact answer for the caller\'s stack; scope=mine is filtered', async () => {
  const agent = await registerAgent('SdkImpactBot');
  const client = new AgentPulseClient({ baseUrl, apiKey: agent.api_key });

  const stored = await client.setDependencies([
    { service: 'stripe', package: 'stripe', version: '14.5.0' },
    { service: 'openai' }
  ]);
  assert.strictEqual(stored.count, 2);

  const manifest = await client.getDependencies();
  assert.strictEqual(manifest.count, 2);

  const impact = await client.getMyImpact();
  assert.strictEqual(impact.agent_id, agent.id);
  assert.strictEqual(impact.manifest_count, 2);
  const stripeDep = impact.dependencies.find(d => d.service === 'stripe');
  assert.ok(stripeDep);
  assert.strictEqual(stripeDep.impact.affected, true, 'stripe has the seeded active incident inc_9821');

  const mine = await client.getChanges({ scope: 'mine' });
  assert.strictEqual(mine.scope, 'mine');
  assert.ok(mine.changes.length >= 1, 'seeded stripe/openai changes are in scope');
  assert.ok(mine.changes.every(c => ['stripe', 'openai'].includes(c.service_slug)));
  assert.ok(mine.changes.every(c => typeof c.playbook_url === 'string'));
});

test('47. SDK: ETag cache — repeat getStatus sends If-None-Match and returns the cached body on 304', async () => {
  let sentIfNoneMatch = false;
  let observed304 = false;
  const spyFetch = async (url, init) => {
    if (init?.headers?.['If-None-Match']) sentIfNoneMatch = true;
    const res = await fetch(url, init);
    if (res.status === 304) observed304 = true;
    return res;
  };
  const client = new AgentPulseClient({ baseUrl, fetch: spyFetch });

  // Retry a few prime/repeat pairs: a concurrent writer in another test
  // process could rotate the service ETag between the two calls of a pair.
  let matched = false;
  for (let attempt = 0; attempt < 8 && !observed304; attempt++) {
    const first = await client.getStatus('vercel');
    const second = await client.getStatus('vercel');
    if (observed304) {
      assert.deepStrictEqual(second, first, '304 returns the exact cached body');
      matched = true;
    }
  }
  assert.ok(sentIfNoneMatch, 'SDK sent If-None-Match on the repeat call');
  assert.ok(observed304 && matched, 'server answered 304 and the SDK served the cache');
  assert.ok(client.statusCache.has('vercel'), 'cache is inspectable via client.statusCache');
});

test('48. SDK: non-2xx responses throw a typed AgentPulseError with status and body', async () => {
  const client = new AgentPulseClient({ baseUrl });

  await assert.rejects(
    () => client.getStatus('not-a-real-service'),
    (err) => {
      assert.ok(err instanceof AgentPulseError);
      assert.strictEqual(err.name, 'AgentPulseError');
      assert.strictEqual(err.status, 404);
      assert.ok(err.body && typeof err.body.error === 'string');
      return true;
    }
  );

  // getMyImpact without an API key: MCP tool-level error -> typed SDK error
  await assert.rejects(
    () => client.getMyImpact(),
    (err) => {
      assert.ok(err instanceof AgentPulseError);
      assert.ok(/Unauthorized/.test(err.message));
      return true;
    }
  );

  // Authenticated write without a key: 401 typed error
  await assert.rejects(
    () => client.setDependencies([{ service: 'stripe' }]),
    (err) => {
      assert.ok(err instanceof AgentPulseError);
      assert.strictEqual(err.status, 401);
      return true;
    }
  );
});

test('49. SDK: registerWebhook returns the one-time secret; reportOutage is accepted', async () => {
  const agent = await registerAgent('SdkWebhookBot');
  const client = new AgentPulseClient({ baseUrl, apiKey: agent.api_key });

  const created = await client.registerWebhook({
    url: 'https://example.com/agentpulse-hook',
    events: ['change.detected'],
    services: ['stripe']
  });
  assert.ok(created.webhook);
  assert.match(created.webhook.secret, /^whsec_/);
  assert.deepStrictEqual(created.webhook.events, ['change.detected']);
  assert.deepStrictEqual(created.webhook.services, ['stripe']);

  const accepted = await client.reportOutage({
    service: 'github',
    endpoint: 'POST /repos/o/r/pulls',
    error_code: 502,
    error_type: '502_bad_gateway'
  });
  assert.ok(accepted.signal && accepted.signal.id, 'telemetry signal recorded');
});
