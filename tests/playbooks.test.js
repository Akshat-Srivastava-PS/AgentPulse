import test from 'node:test';
import assert from 'node:assert';
import { dispatchRequest } from './testHelper.js';
import { buildPlaybook, classifyBreakingChange } from '../src/engine/playbooks.js';
import { createBreakingChange } from '../src/db/index.js';

// Step 6: migration playbooks generated from breaking changes.
// Fully offline — unit tests over row-shaped fixtures plus in-process
// dispatch for the playbook endpoint.

function assertPlaybookShape(playbook, { kind, effort }) {
  assert.strictEqual(playbook.kind, kind);
  assert.strictEqual(playbook.effort_estimate, effort);
  assert.ok(Array.isArray(playbook.steps) && playbook.steps.length >= 3, 'playbook has at least 3 steps');
  for (const step of playbook.steps) {
    assert.strictEqual(typeof step.action, 'string');
    assert.ok(step.action.length > 0);
    assert.strictEqual(typeof step.detail, 'string');
    assert.ok(step.detail.length > 0);
    if (step.code_example !== undefined) {
      assert.strictEqual(typeof step.code_example.before, 'string');
      assert.strictEqual(typeof step.code_example.after, 'string');
    }
  }
  assert.ok(Array.isArray(playbook.risk_notes) && playbook.risk_notes.length >= 1);
}

test('40. Playbook: removed operation yields a high-effort rewiring playbook', () => {
  const playbook = buildPlaybook({
    id: 'bc_test_removed_op',
    service_slug: 'stripe',
    change_type: 'schema_diff',
    version_or_date: '2026-11-01',
    diff_summary: 'Removed operation DELETE /v1/subscriptions/{subscription}. (source: https://example.com/spec.json)',
    migration_hint: "Remove all calls to DELETE /v1/subscriptions/{subscription}; migrate to the provider's replacement operation.",
    detected_at: '2026-11-01T00:00:00Z'
  });

  assert.strictEqual(playbook.change_id, 'bc_test_removed_op');
  assert.strictEqual(playbook.service, 'stripe');
  assertPlaybookShape(playbook, { kind: 'removed_operation', effort: 'high' });
  const actions = playbook.steps.map(s => s.action);
  assert.ok(actions.includes('find_call_sites'));
  assert.ok(actions.includes('add_fallback'));
  assert.ok(playbook.steps.some(s => s.detail.includes('DELETE /v1/subscriptions/{subscription}')));
});

test('41. Playbook: parameter now required yields a low-effort playbook with a before/after example', () => {
  const playbook = buildPlaybook({
    id: 'bc_test_param_required',
    service_slug: 'stripe',
    change_type: 'schema_diff',
    version_or_date: '2026-11-01',
    diff_summary: "Parameter 'account' (in: query) on GET /v1/charges is now required.",
    migration_hint: "Always send 'account' when calling GET /v1/charges.",
    detected_at: '2026-11-01T00:00:00Z'
  });

  assertPlaybookShape(playbook, { kind: 'parameter_now_required', effort: 'low' });
  const addStep = playbook.steps.find(s => s.action === 'add_parameter');
  assert.ok(addStep, 'has an add_parameter step');
  assert.ok(addStep.code_example, 'add_parameter step carries a code example');
  assert.ok(!addStep.code_example.before.includes('account='), 'before example omits the parameter');
  assert.ok(addStep.code_example.after.includes('account='), 'after example sends the parameter');
  assert.ok(addStep.code_example.after.includes('/v1/charges'), 'example is built from the change\'s own path');
});

test('42. Playbook: removed response property yields a medium-effort playbook that stops reads', () => {
  const playbook = buildPlaybook({
    id: 'bc_test_removed_resp_prop',
    service_slug: 'stripe',
    change_type: 'schema_diff',
    version_or_date: '2026-11-01',
    diff_summary: "Removed response property 'receipt_url' from GET /v1/charges success responses.",
    migration_hint: "Stop reading 'receipt_url' from GET /v1/charges responses; it is no longer returned.",
    detected_at: '2026-11-01T00:00:00Z'
  });

  assertPlaybookShape(playbook, { kind: 'removed_response_property', effort: 'medium' });
  const stopStep = playbook.steps.find(s => s.action === 'stop_reading');
  assert.ok(stopStep, 'has a stop_reading step');
  assert.ok(stopStep.code_example.before.includes('receipt_url'));
  assert.ok(stopStep.code_example.after.includes('receipt_url'), 'after example still names the property in the guard');
  assert.ok(stopStep.code_example.after.includes('??'), 'after example guards the read');
});

test('43. Playbook: classification covers the remaining spec-diff kinds and fallbacks', () => {
  const cases = [
    ["Removed path /v1/legacy entirely.", 'removed_path'],
    ["Removed parameter 'expand' (in: query) from GET /v1/charges.", 'removed_parameter'],
    ["Parameter 'limit' (in: query) on GET /v1/charges changed type from string to integer.", 'parameter_type_changed'],
    ["New required parameter 'version' (in: header) on POST /v1/charges.", 'new_required_parameter'],
    ["Removed request property 'memo' from POST /v1/charges.", 'removed_request_property'],
    ["Request property 'amount' on POST /v1/charges is now required.", 'request_property_now_required'],
    ["New required request property 'currency' on POST /v1/charges.", 'new_required_request_property'],
    ["Request property 'amount' on POST /v1/charges changed type from string to integer.", 'request_property_type_changed'],
    ["Response property 'total' on GET /v1/charges changed type from string to integer.", 'response_property_type_changed'],
    ["Success response 201 removed from POST /v1/charges.", 'removed_response']
  ];
  for (const [summary, kind] of cases) {
    const result = classifyBreakingChange({ change_type: 'schema_diff', diff_summary: summary });
    assert.strictEqual(result.kind, kind, `summary classified: ${summary}`);
  }

  // Fallbacks by stored change_type
  assert.strictEqual(classifyBreakingChange({ change_type: 'deprecation', diff_summary: 'Legacy endpoints removed.' }).kind, 'deprecation');
  assert.strictEqual(classifyBreakingChange({ change_type: 'rate_limit_change', diff_summary: 'Burst limit tightened.' }).kind, 'rate_limit_change');
  assert.strictEqual(classifyBreakingChange({ change_type: 'schema_diff', diff_summary: 'Prose schema note with no diff pattern.' }).kind, 'schema_change');

  // Raw diff-change objects (pre-persistence) classify by their own kind
  const raw = classifyBreakingChange({
    kind: 'removed_operation',
    location: 'DELETE /v1/subscriptions/{subscription}',
    summary: 'Removed operation DELETE /v1/subscriptions/{subscription}.',
    migration_hint: 'Remove all calls.'
  });
  assert.strictEqual(raw.kind, 'removed_operation');
  assert.strictEqual(raw.details.operation, 'DELETE /v1/subscriptions/{subscription}');
});

test('44. Playbook endpoint: 200 for a real change id (fixture + spec-diff), 404 for unknown id', async () => {
  // A stored deprecation change, inserted as a fixture (the app seeds none)
  const fixture = createBreakingChange({
    id: 'bc_test_deprecation_fixture',
    service_slug: 'openai',
    version_or_date: '2026-10-01',
    change_type: 'deprecation',
    diff_summary: 'Legacy fine-tuning endpoints and text-davinci-003 models removed.',
    migration_hint: 'Migrate calls to gpt-4o-mini or specify chat completions endpoint with model: "gpt-4o-2024-08-06".'
  });
  const fixtureRes = await dispatchRequest({ url: `/v1/changes/${fixture.id}/playbook` });
  assert.strictEqual(fixtureRes.status, 200);
  const fixtureData = await fixtureRes.json();
  assert.strictEqual(fixtureData.playbook.change_id, fixture.id);
  assert.strictEqual(fixtureData.playbook.service, 'openai');
  assertPlaybookShape(fixtureData.playbook, { kind: 'deprecation', effort: 'medium' });

  // A fresh schema_diff change written the way the Step 1 worker writes it
  const created = createBreakingChange({
    id: 'bc_test_endpoint_removed_op',
    service_slug: 'github',
    version_or_date: '2026-11-21',
    change_type: 'schema_diff',
    diff_summary: 'Removed operation GET /repos/{owner}/{repo}/hooks. (source: https://example.com/spec.json)',
    migration_hint: "Remove all calls to GET /repos/{owner}/{repo}/hooks; migrate to the provider's replacement operation."
  });
  const res = await dispatchRequest({ url: `/v1/changes/${created.id}/playbook` });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.playbook.change_id, created.id);
  assertPlaybookShape(data.playbook, { kind: 'removed_operation', effort: 'high' });

  // Unknown id
  const missing = await dispatchRequest({ url: '/v1/changes/bc_does_not_exist/playbook' });
  assert.strictEqual(missing.status, 404);
  const missingData = await missing.json();
  assert.ok(missingData.error.includes('bc_does_not_exist'));
});
