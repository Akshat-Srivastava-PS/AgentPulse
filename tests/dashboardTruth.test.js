import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dispatchRequest } from './testHelper.js';
import { getDb, getService, getSystemMetrics, recordSyntheticProbe } from '../src/db/index.js';

// Dashboard truth pass: every number the dashboard/API presents as a
// measurement must be derived from real stored data — no seeded or
// hardcoded figures. These tests lock that in.

test('91. Truth: service payloads never carry an uptime figure (it was never measured)', async () => {
  const res = await dispatchRequest({ url: '/v1/services' });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(data.services.length > 0);
  for (const service of data.services) {
    assert.ok(!('uptime_percentage' in service), `${service.slug} still serves uptime_percentage`);
  }
  assert.ok(!('uptime_percentage' in getService('stripe')));
});

test('92. Truth: estimated_tokens_saved is derived only from today\'s request log (no constant base)', () => {
  const db = getDb();
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const countedToday = db.prepare('SELECT count(*) as count FROM request_log WHERE counted = 1 AND created_at >= ?').get(todayStart).count;
  const notModifiedToday = db.prepare('SELECT count(*) as count FROM request_log WHERE status_code = 304 AND created_at >= ?').get(todayStart).count;

  const metrics = getSystemMetrics();
  // Exact equality: any hardcoded base (the old +2,481,000) breaks this.
  assert.strictEqual(metrics.estimated_tokens_saved, (countedToday + notModifiedToday) * 340);
  if (countedToday + notModifiedToday === 0) {
    assert.strictEqual(metrics.estimated_tokens_saved, 0);
  }
});

test('93. Truth: an unmeasured probe (latency null) never overwrites the last measured latency', () => {
  const before = getService('stripe').latency_ms;

  recordSyntheticProbe({
    service_slug: 'stripe',
    probe_target: 'https://unreachable.invalid',
    status_code: 0,
    latency_ms: null,
    is_healthy: true
  });
  assert.strictEqual(getService('stripe').latency_ms, before);

  // A real measurement still flows through, and the original value is
  // restored so later tests see the latency they started with.
  recordSyntheticProbe({
    service_slug: 'stripe',
    probe_target: 'https://api.stripe.com/healthcheck',
    status_code: 200,
    latency_ms: 123,
    is_healthy: true
  });
  assert.strictEqual(getService('stripe').latency_ms, 123);

  recordSyntheticProbe({
    service_slug: 'stripe',
    probe_target: 'https://api.stripe.com/healthcheck',
    status_code: 200,
    latency_ms: before,
    is_healthy: true
  });
  assert.strictEqual(getService('stripe').latency_ms, before);
});

test('94. Truth: dashboard sources contain no fabricated figures or fallback dataset', () => {
  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');
  const dbJs = readFileSync(new URL('../src/db/index.js', import.meta.url), 'utf8');

  assert.ok(!html.includes('2,489,840'), 'index.html still hardcodes the old tokens-saved figure');
  assert.ok(!html.includes('Payment Intents degraded'), 'index.html still shows a fabricated incident');
  assert.ok(!appJs.includes('FALLBACK_SERVICES'), 'app.js still carries the fabricated fallback dataset');
  assert.ok(!dbJs.includes('2481000'), 'db layer still adds the constant tokens-saved base');
  assert.ok(!dbJs.includes('99.95'), 'db layer still seeds the invented uptime figure');
});

test('95. Truth: per-service incident visibility is rendered only from the live incidents response', async () => {
  const res = await dispatchRequest({ url: '/v1/incidents?status=active' });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.incidents));
  // The feed and the metrics counter read the same incidents table, so
  // the per-service breakdown can never disagree with the headline stat.
  assert.strictEqual(data.count, getSystemMetrics().active_incidents);
  for (const incident of data.incidents) {
    assert.ok(incident.service_slug, 'active incident is missing the service_slug the dashboard groups by');
  }

  const html = readFileSync(new URL('../src/public/index.html', import.meta.url), 'utf8');
  const appJs = readFileSync(new URL('../src/public/app.js', import.meta.url), 'utf8');

  assert.ok(html.includes('id="stat-incident-breakdown"'), 'index.html is missing the incident breakdown container');
  assert.ok(appJs.includes("/v1/incidents?status=active"), 'app.js does not fetch the live incidents feed');
  assert.ok(appJs.includes('incidentCountsByService'), 'app.js does not group incidents per service');
  // Breakdown rows ("Name · N") are produced by JS from the response —
  // the static HTML must never ship a baked-in per-service count.
  assert.ok(!/·\s*\d/.test(html), 'index.html hardcodes a per-service incident count');
});
