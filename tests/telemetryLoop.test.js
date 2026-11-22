import test from 'node:test';
import assert from 'node:assert';
import { recordOutageSignal, getRecentOutageSignalStats, getActiveIncidents } from '../src/db/index.js';
import {
  evaluateTelemetryTrigger,
  scheduleTelemetryEvaluation,
  resetTelemetryLoopState,
  getTelemetryLoopConfig,
  BEHAVIOUR_CHANGED_MARKER
} from '../src/workers/telemetryLoop.js';

// Step 2 telemetry loop: recorded outage signals are aggregated per service;
// a cluster (>= 5 reports from >= 3 distinct agents within 15 minutes) fires
// an out-of-cycle spec re-check, and an unchanged spec raises exactly one
// "behaviour changed, spec didn't" incident. All polls are injected fakes —
// fully offline. Each test uses its own service slug so the shared test
// database cannot leak counts between tests.

const CONFIG = { minSignals: 5, minDistinctAgents: 3, windowMs: 15 * 60 * 1000, cooldownMs: 15 * 60 * 1000 };

function registryFor(...slugs) {
  const registry = {};
  for (const slug of slugs) registry[slug] = `https://example.com/${slug}.json`;
  return () => registry;
}

function recordSignals(serviceSlug, agentIds, endpoint = 'POST /v1/example') {
  for (const agentId of agentIds) {
    recordOutageSignal({
      service_slug: serviceSlug,
      agent_id: agentId,
      endpoint,
      error_code: 502,
      error_type: '502_bad_gateway'
    });
  }
}

function pollSpy(result) {
  const calls = [];
  const fn = async (slug) => { calls.push(slug); return result; };
  fn.calls = calls;
  return fn;
}

function behaviourIncidents(serviceSlug) {
  return getActiveIncidents(serviceSlug)
    .filter(i => typeof i.agent_summary === 'string' && i.agent_summary.includes(BEHAVIOUR_CHANGED_MARKER));
}

test('68. Telemetry Loop: signal stats aggregate totals, distinct agents and endpoints', () => {
  recordSignals('vercel', ['agent_tl_a', 'agent_tl_a'], 'POST /v1/deployments');
  recordSignals('vercel', ['agent_tl_b'], 'GET /v1/projects');

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const stats = getRecentOutageSignalStats('vercel', since);
  assert.strictEqual(stats.total, 3);
  assert.strictEqual(stats.distinct_agents, 2);
  assert.strictEqual(stats.distinct_endpoints, 2);
  assert.ok(stats.latest_at);
});

test('69. Telemetry Loop: below threshold (count or distinct agents) triggers no re-check', async () => {
  const poll = pollSpy({ service: 'vercel', changed: false, baseline: false, inserted: 0 });

  // 3 signals so far (< 5): no trigger.
  let outcome = await evaluateTelemetryTrigger('vercel', {
    config: CONFIG, getSpecRegistry: registryFor('vercel'), pollSpecService: poll
  });
  assert.strictEqual(outcome.triggered, false);
  assert.strictEqual(outcome.reason, 'below_threshold');
  assert.strictEqual(poll.calls.length, 0);

  // Push the count past 5 but keep it to 2 distinct agents: still no trigger.
  recordSignals('vercel', ['agent_tl_a', 'agent_tl_a', 'agent_tl_a']);
  outcome = await evaluateTelemetryTrigger('vercel', {
    config: CONFIG, getSpecRegistry: registryFor('vercel'), pollSpecService: poll
  });
  assert.strictEqual(outcome.triggered, false);
  assert.strictEqual(outcome.reason, 'below_threshold');
  assert.strictEqual(outcome.stats.total, 6);
  assert.strictEqual(outcome.stats.distinct_agents, 2);
  assert.strictEqual(poll.calls.length, 0);
});

test('70. Telemetry Loop: at threshold with unchanged spec raises exactly one behaviour-changed incident', async () => {
  resetTelemetryLoopState();
  recordSignals('supabase', ['agent_tl_a', 'agent_tl_a', 'agent_tl_b', 'agent_tl_b', 'agent_tl_c']);
  const poll = pollSpy({ service: 'supabase', changed: false, baseline: false, inserted: 0, duplicates: 0, changes: [] });

  const outcome = await evaluateTelemetryTrigger('supabase', {
    config: CONFIG, getSpecRegistry: registryFor('supabase'), pollSpecService: poll
  });

  assert.strictEqual(outcome.triggered, true);
  assert.strictEqual(outcome.rechecked, true);
  assert.strictEqual(outcome.spec_changed, false);
  assert.strictEqual(outcome.incident_created, true);
  assert.deepStrictEqual(poll.calls, ['supabase']);

  const incidents = behaviourIncidents('supabase');
  assert.strictEqual(incidents.length, 1);
  assert.ok(incidents[0].agent_summary.includes('published supabase OpenAPI spec unchanged'));
});

test('71. Telemetry Loop: cooldown suppresses repeat triggers', async () => {
  const poll = pollSpy({ service: 'supabase', changed: false, baseline: false, inserted: 0 });

  const outcome = await evaluateTelemetryTrigger('supabase', {
    config: CONFIG, getSpecRegistry: registryFor('supabase'), pollSpecService: poll
  });

  assert.strictEqual(outcome.triggered, false);
  assert.strictEqual(outcome.reason, 'cooldown');
  assert.strictEqual(poll.calls.length, 0);
  assert.strictEqual(behaviourIncidents('supabase').length, 1);
});

test('72. Telemetry Loop: after cooldown, an active behaviour incident suppresses duplicates', async () => {
  resetTelemetryLoopState();
  const poll = pollSpy({ service: 'supabase', changed: false, baseline: false, inserted: 0 });

  const outcome = await evaluateTelemetryTrigger('supabase', {
    config: CONFIG, getSpecRegistry: registryFor('supabase'), pollSpecService: poll
  });

  assert.strictEqual(outcome.triggered, true);
  assert.deepStrictEqual(poll.calls, ['supabase']);
  assert.strictEqual(outcome.incident_created, false);
  assert.strictEqual(outcome.reason, 'incident_already_active');
  assert.strictEqual(behaviourIncidents('supabase').length, 1);
});

test('73. Telemetry Loop: changed spec on re-check raises no behaviour incident', async () => {
  resetTelemetryLoopState();
  recordSignals('datadog', ['agent_tl_a', 'agent_tl_a', 'agent_tl_b', 'agent_tl_b', 'agent_tl_c']);
  const poll = pollSpy({ service: 'datadog', changed: true, baseline: false, inserted: 2, duplicates: 0, changes: [] });

  const outcome = await evaluateTelemetryTrigger('datadog', {
    config: CONFIG, getSpecRegistry: registryFor('datadog'), pollSpecService: poll
  });

  assert.strictEqual(outcome.triggered, true);
  assert.strictEqual(outcome.spec_changed, true);
  assert.strictEqual(outcome.incident_created, false);
  assert.strictEqual(behaviourIncidents('datadog').length, 0);
});

test('74. Telemetry Loop: service outside the spec registry is a quiet no-op (signals still recorded)', async () => {
  resetTelemetryLoopState();
  recordSignals('resend', ['agent_tl_a', 'agent_tl_a', 'agent_tl_b', 'agent_tl_b', 'agent_tl_c']);
  const poll = pollSpy({ service: 'resend', changed: false, baseline: false, inserted: 0 });

  const outcome = await evaluateTelemetryTrigger('resend', {
    config: CONFIG, getSpecRegistry: registryFor(), pollSpecService: poll
  });

  assert.strictEqual(outcome.triggered, false);
  assert.strictEqual(outcome.reason, 'not_in_spec_registry');
  assert.strictEqual(poll.calls.length, 0);

  const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  assert.strictEqual(getRecentOutageSignalStats('resend', since).total, 5);
});

test('75. Telemetry Loop: config defaults, env overrides, and the fire-and-forget hook never throws', async () => {
  const defaults = getTelemetryLoopConfig({});
  assert.strictEqual(defaults.minSignals, 5);
  assert.strictEqual(defaults.minDistinctAgents, 3);
  assert.strictEqual(defaults.windowMs, 15 * 60 * 1000);
  assert.strictEqual(defaults.cooldownMs, 15 * 60 * 1000);

  const overridden = getTelemetryLoopConfig({ TELEMETRY_TRIGGER_MIN_SIGNALS: '9', TELEMETRY_TRIGGER_WINDOW_MS: '60000' });
  assert.strictEqual(overridden.minSignals, 9);
  assert.strictEqual(overridden.windowMs, 60000);

  // Unknown / unregistered service: scheduling must be a silent no-op.
  assert.doesNotThrow(() => scheduleTelemetryEvaluation('resend'));
  await new Promise(resolve => setTimeout(resolve, 25));
});
