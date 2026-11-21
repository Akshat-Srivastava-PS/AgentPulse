import test, { before, after } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import crypto from 'node:crypto';
import { dispatchRequest } from './testHelper.js';
import { createIncident, resolveIncident, createBreakingChange } from '../src/db/index.js';
import { flushWebhookDeliveries } from '../src/workers/webhooks.js';

// Step 4: webhook alerts.
// Fully offline: deliveries go to a local HTTP receiver on an ephemeral
// port (the reason http:// is allowed for localhost). Retry delays are
// shrunk via env so the failing-receiver test stays fast.
process.env.WEBHOOK_RETRY_DELAYS_MS = '10,20';

const received = [];
let receiverStatus = 200;
let receiver;
let receiverUrl;

before(async () => {
  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(receiverStatus, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
  });
  await new Promise(resolve => receiver.listen(0, '127.0.0.1', resolve));
  receiverUrl = `http://127.0.0.1:${receiver.address().port}/hook`;
});

after(() => {
  receiver.close();
});

async function registerAgent(name) {
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/register',
    body: { agent_name: name, operator_url: 'https://github.com/myorg/webhook-test-bot' }
  });
  assert.strictEqual(res.status, 201);
  return (await res.json()).agent;
}

function authHeaders(agent) {
  return { 'Authorization': `Bearer ${agent.api_key}` };
}

async function createWebhook(agent, body) {
  const res = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/me/webhooks',
    headers: authHeaders(agent),
    body
  });
  assert.strictEqual(res.status, 201, `webhook create failed: ${res.status}`);
  return (await res.json()).webhook;
}

function findReceived(predicate) {
  return received
    .map(r => ({ headers: r.headers, raw: r.body, json: JSON.parse(r.body) }))
    .find(predicate);
}

test('34. Webhooks: create/list/delete round-trip; secret shown once only; ownership enforced', async () => {
  const agent = await registerAgent('WebhookCrudBot');
  const other = await registerAgent('WebhookOtherBot');

  const created = await createWebhook(agent, {
    url: receiverUrl,
    events: ['incident.created'],
    services: ['stripe']
  });
  assert.ok(created.id.startsWith('wh_'));
  assert.ok(typeof created.secret === 'string' && created.secret.startsWith('whsec_'),
    'Create response must include the signing secret');
  assert.deepStrictEqual(created.events, ['incident.created']);
  assert.deepStrictEqual(created.services, ['stripe']);
  assert.strictEqual(created.active, true);

  // List shows the webhook but never the secret
  const listRes = await dispatchRequest({
    url: '/v1/agents/me/webhooks',
    headers: authHeaders(agent)
  });
  assert.strictEqual(listRes.status, 200);
  const list = await listRes.json();
  assert.strictEqual(list.count, 1);
  assert.strictEqual(list.webhooks[0].id, created.id);
  assert.strictEqual(list.webhooks[0].secret, undefined, 'List responses must not include secrets');
  assert.ok(!(await listRes.text()).includes(created.secret), 'Secret must not appear anywhere in the list payload');

  // Another agent cannot delete it (404, not 403 — existence is not leaked)
  const foreignDelete = await dispatchRequest({
    method: 'DELETE',
    url: `/v1/agents/me/webhooks/${created.id}`,
    headers: authHeaders(other)
  });
  assert.strictEqual(foreignDelete.status, 404);

  // Nor read its delivery log
  const foreignLog = await dispatchRequest({
    url: `/v1/agents/me/webhooks/${created.id}/deliveries`,
    headers: authHeaders(other)
  });
  assert.strictEqual(foreignLog.status, 404);

  // The owner can delete it; afterwards the list is empty
  const deleteRes = await dispatchRequest({
    method: 'DELETE',
    url: `/v1/agents/me/webhooks/${created.id}`,
    headers: authHeaders(agent)
  });
  assert.strictEqual(deleteRes.status, 200);

  const emptyList = await (await dispatchRequest({
    url: '/v1/agents/me/webhooks',
    headers: authHeaders(agent)
  })).json();
  assert.strictEqual(emptyList.count, 0);
});

test('35. Webhooks: incident.created, incident.resolved and change.detected deliver signed payloads', async () => {
  const agent = await registerAgent('WebhookDeliveryBot');
  const webhook = await createWebhook(agent, { url: receiverUrl, services: ['vercel'] });

  const incident = createIncident({
    id: 'whtest_inc_vercel',
    service_slug: 'vercel',
    severity: 'major',
    affected_scope: 'Edge Network (iad1)',
    agent_summary: 'Elevated edge 502s in iad1.',
    agent_hint: 'Fail over to a secondary region.'
  });
  await flushWebhookDeliveries();

  const createdHit = findReceived(r => r.json.type === 'incident.created' && r.json.data.id === incident.id);
  assert.ok(createdHit, 'incident.created delivery must arrive');
  assert.strictEqual(createdHit.headers['x-agentpulse-event'], 'incident.created');
  assert.strictEqual(createdHit.headers['x-agentpulse-delivery'], createdHit.json.id);
  assert.strictEqual(createdHit.json.data.service_slug, 'vercel');
  assert.ok(createdHit.json.created_at);

  // Signature: sha256=<HMAC-SHA256 hex of the raw body, keyed with the secret>
  const expected = 'sha256=' + crypto.createHmac('sha256', webhook.secret).update(createdHit.raw, 'utf8').digest('hex');
  assert.strictEqual(createdHit.headers['x-agentpulse-signature'], expected,
    'X-AgentPulse-Signature must be the HMAC-SHA256 of the raw body');

  // incident.resolved
  resolveIncident(incident.id);
  await flushWebhookDeliveries();
  const resolvedHit = findReceived(r => r.json.type === 'incident.resolved' && r.json.data.id === incident.id);
  assert.ok(resolvedHit, 'incident.resolved delivery must arrive');
  assert.ok(resolvedHit.json.data.resolved_at, 'Resolved payload carries resolved_at');

  // change.detected
  const change = createBreakingChange({
    id: 'whtest_bc_vercel',
    service_slug: 'vercel',
    version_or_date: '2026-11-21',
    change_type: 'schema_diff',
    diff_summary: 'Webhook test change.',
    migration_hint: 'No action needed.'
  });
  await flushWebhookDeliveries();
  const changeHit = findReceived(r => r.json.type === 'change.detected' && r.json.data.id === change.id);
  assert.ok(changeHit, 'change.detected delivery must arrive');

  // Delivery log records all three as delivered
  const logRes = await dispatchRequest({
    url: `/v1/agents/me/webhooks/${webhook.id}/deliveries`,
    headers: authHeaders(agent)
  });
  assert.strictEqual(logRes.status, 200);
  const log = await logRes.json();
  const mine = log.deliveries.filter(d => ['incident.created', 'incident.resolved', 'change.detected'].includes(d.event_type));
  assert.strictEqual(mine.length, 3);
  for (const d of mine) {
    assert.strictEqual(d.status, 'delivered');
    assert.strictEqual(d.attempts, 1);
    assert.strictEqual(d.last_status_code, 200);
    assert.ok(d.delivered_at);
  }
});

test('36. Webhooks: service filter excludes non-matching services', async () => {
  const agent = await registerAgent('WebhookServiceFilterBot');
  await createWebhook(agent, { url: receiverUrl, services: ['npm'] });

  const offFilter = createIncident({
      id: 'whtest_inc_cloudflare',
    service_slug: 'cloudflare',
    severity: 'minor',
    affected_scope: 'DNS API',
    agent_summary: 'Off-filter incident for the service-filter test.',
    agent_hint: 'Ignore.'
  });
  const onFilter = createIncident({
      id: 'whtest_inc_npm',
    service_slug: 'npm',
    severity: 'minor',
    affected_scope: 'Registry API',
    agent_summary: 'On-filter incident for the service-filter test.',
    agent_hint: 'Retry with backoff.'
  });
  await flushWebhookDeliveries();

  assert.ok(!findReceived(r => r.json.data.id === offFilter.id),
    'Incident on a non-matching service must not be delivered');
  assert.ok(findReceived(r => r.json.data.id === onFilter.id),
    'Incident on the filtered service must be delivered');

  resolveIncident(offFilter.id);
  resolveIncident(onFilter.id);
  await flushWebhookDeliveries();
});

test('37. Webhooks: event filter excludes non-matching event types', async () => {
  const agent = await registerAgent('WebhookEventFilterBot');
  await createWebhook(agent, {
    url: receiverUrl,
    events: ['change.detected'],
    services: ['resend']
  });

  const incident = createIncident({
      id: 'whtest_inc_resend',
    service_slug: 'resend',
    severity: 'minor',
    affected_scope: 'Email API',
    agent_summary: 'Incident the change-only webhook must not receive.',
    agent_hint: 'Ignore.'
  });
  await flushWebhookDeliveries();
  assert.ok(!findReceived(r => r.json.data.id === incident.id),
    'incident.created must be excluded by the event filter');

  const change = createBreakingChange({
    id: 'whtest_bc_resend',
    service_slug: 'resend',
    version_or_date: '2026-11-21',
    change_type: 'deprecation',
    diff_summary: 'Change the change-only webhook must receive.',
    migration_hint: 'No action needed.'
  });
  await flushWebhookDeliveries();
  assert.ok(findReceived(r => r.json.type === 'change.detected' && r.json.data.id === change.id),
    'change.detected must pass the event filter');

  resolveIncident(incident.id);
  await flushWebhookDeliveries();
});

test('38. Webhooks: failing receiver is retried and the delivery is recorded as failed', async () => {
  const agent = await registerAgent('WebhookFailingBot');
  const webhook = await createWebhook(agent, { url: receiverUrl, services: ['datadog'] });

  receiverStatus = 500;
  try {
    const incident = createIncident({
        id: 'whtest_inc_datadog',
    service_slug: 'datadog',
      severity: 'major',
      affected_scope: 'Metrics API',
      agent_summary: 'Incident delivered to a failing receiver.',
      agent_hint: 'Back off.'
    });
    await flushWebhookDeliveries();

    const logRes = await dispatchRequest({
      url: `/v1/agents/me/webhooks/${webhook.id}/deliveries`,
      headers: authHeaders(agent)
    });
    const log = await logRes.json();
    const failed = log.deliveries.find(d => d.event_type === 'incident.created');
    assert.ok(failed, 'A delivery row must exist for the failed delivery');
    assert.strictEqual(failed.status, 'failed');
    assert.strictEqual(failed.attempts, 3, 'Initial attempt + 2 retries (WEBHOOK_RETRY_DELAYS_MS=10,20)');
    assert.strictEqual(failed.last_status_code, 500);
    assert.ok(failed.last_error && failed.last_error.includes('500'));
    assert.strictEqual(failed.delivered_at, null);

    resolveIncident(incident.id);
  } finally {
    receiverStatus = 200;
  }
  await flushWebhookDeliveries();
});

test('39. Webhooks: unauthenticated create is 401; invalid url/events/services are 400', async () => {
  const anon = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/me/webhooks',
    body: { url: receiverUrl }
  });
  assert.strictEqual(anon.status, 401);
  assert.ok((await anon.json()).error.includes('Unauthorized'));

  const agent = await registerAgent('WebhookValidationBot');

  // Non-https URL off localhost
  const badUrl = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/me/webhooks',
    headers: authHeaders(agent),
    body: { url: 'http://example.com/hook' }
  });
  assert.strictEqual(badUrl.status, 400);

  // Unknown event type
  const badEvent = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/me/webhooks',
    headers: authHeaders(agent),
    body: { url: receiverUrl, events: ['incident.exploded'] }
  });
  assert.strictEqual(badEvent.status, 400);
  assert.ok((await badEvent.json()).allowed_events.includes('incident.created'));

  // Unknown service slug
  const badService = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/me/webhooks',
    headers: authHeaders(agent),
    body: { url: receiverUrl, services: ['not_a_service'] }
  });
  assert.strictEqual(badService.status, 400);
  assert.strictEqual((await badService.json()).unknown_service, 'not_a_service');

  // https URLs are accepted in shape (no delivery is triggered by creating)
  const okRes = await dispatchRequest({
    method: 'POST',
    url: '/v1/agents/me/webhooks',
    headers: authHeaders(agent),
    body: { url: 'https://bots.example.com/agentpulse' }
  });
  assert.strictEqual(okRes.status, 201);
});
