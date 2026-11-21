import test from 'node:test';
import assert from 'node:assert';
import { diffOpenApiSpecs, hashSpecText, specChangeId } from '../src/workers/specDiff.js';
import { mapStatuspageSummary, mapStatuspageIncident, statuspageIncidentId } from '../src/workers/statuspage.js';

// --- Fixture OpenAPI specs (fully offline) ---

const oldSpec = {
  openapi: '3.0.0',
  info: { title: 'Fixture API', version: '1.0.0' },
  paths: {
    '/v1/charges': {
      get: {
        parameters: [
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer' } }
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    amount: { type: 'integer' },
                    receipt_url: { type: 'string' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  amount: { type: 'integer' },
                  currency: { type: 'string' }
                },
                required: ['amount']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string' } } }
              }
            }
          }
        }
      }
    },
    '/v1/legacy': {
      get: {
        responses: {
          '200': { description: 'OK' }
        }
      }
    }
  }
};

const newSpec = {
  openapi: '3.0.0',
  info: { title: 'Fixture API', version: '2.0.0' },
  paths: {
    '/v1/charges': {
      get: {
        parameters: [
          { name: 'limit', in: 'query', required: true, schema: { type: 'integer' } },
          { name: 'cursor', in: 'query', required: true, schema: { type: 'string' } },
          { name: 'expand', in: 'query', required: false, schema: { type: 'string' } }
        ],
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    amount: { type: 'integer' },
                    livemode: { type: 'boolean' }
                  }
                }
              }
            }
          }
        }
      },
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  amount: { type: 'integer' },
                  currency: { type: 'string' },
                  customer: { type: 'string' }
                },
                required: ['amount', 'customer']
              }
            }
          }
        },
        responses: {
          '200': {
            description: 'OK',
            content: {
              'application/json': {
                schema: { type: 'object', properties: { id: { type: 'string' } } }
              }
            }
          }
        }
      }
    },
    '/v1/refunds': {
      post: {
        responses: {
          '200': { description: 'OK' }
        }
      }
    }
  }
};

test('15. Spec Diff: removed operation and removed path are breaking', () => {
  const changes = diffOpenApiSpecs(oldSpec, newSpec);

  const removedPath = changes.find(c => c.kind === 'removed_path' && c.location === '/v1/legacy');
  assert.ok(removedPath, 'Removed /v1/legacy path must be detected');
  assert.strictEqual(removedPath.breaking, true);

  // Breaking changes must sort before non-breaking ones
  const firstNonBreaking = changes.findIndex(c => !c.breaking);
  const lastBreaking = changes.map(c => c.breaking).lastIndexOf(true);
  assert.ok(firstNonBreaking === -1 || lastBreaking < firstNonBreaking, 'Breaking changes must be listed first');
});

test('16. Spec Diff: newly required parameters are breaking', () => {
  const changes = diffOpenApiSpecs(oldSpec, newSpec);

  const nowRequired = changes.find(c => c.kind === 'parameter_now_required');
  assert.ok(nowRequired, 'limit becoming required must be detected');
  assert.strictEqual(nowRequired.breaking, true);
  assert.ok(nowRequired.summary.includes('limit'));

  const newRequired = changes.find(c => c.kind === 'new_required_parameter');
  assert.ok(newRequired, 'New required cursor parameter must be detected');
  assert.strictEqual(newRequired.breaking, true);
  assert.ok(newRequired.summary.includes('cursor'));
  assert.ok(newRequired.migration_hint.includes('cursor'));
});

test('17. Spec Diff: removed response property and new required request property are breaking', () => {
  const changes = diffOpenApiSpecs(oldSpec, newSpec);

  const removedProp = changes.find(c => c.kind === 'removed_response_property');
  assert.ok(removedProp, 'Removed receipt_url response property must be detected');
  assert.strictEqual(removedProp.breaking, true);
  assert.ok(removedProp.summary.includes('receipt_url'));

  const newReqProp = changes.find(c => c.kind === 'new_required_request_property');
  assert.ok(newReqProp, 'New required customer request property must be detected');
  assert.strictEqual(newReqProp.breaking, true);
  assert.ok(newReqProp.summary.includes('customer'));
});

test('18. Spec Diff: added optional parameter, endpoint, and response property are non-breaking', () => {
  const changes = diffOpenApiSpecs(oldSpec, newSpec);

  const addedParam = changes.find(c => c.kind === 'added_optional_parameter');
  assert.ok(addedParam, 'Added optional expand parameter must be detected');
  assert.strictEqual(addedParam.breaking, false);

  const addedPath = changes.find(c => c.kind === 'added_path' && c.location === '/v1/refunds');
  assert.ok(addedPath, 'Added /v1/refunds path must be detected');
  assert.strictEqual(addedPath.breaking, false);

  const addedProp = changes.find(c => c.kind === 'added_response_property');
  assert.ok(addedProp, 'Added livemode response property must be detected');
  assert.strictEqual(addedProp.breaking, false);

  // Identical specs produce no changes, and hashing/ids are deterministic
  assert.deepStrictEqual(diffOpenApiSpecs(oldSpec, oldSpec), []);
  assert.strictEqual(hashSpecText('{"a":1}'), hashSpecText('{"a":1}'));
  const change = changes.find(c => c.breaking);
  assert.strictEqual(
    specChangeId('stripe', 'https://example.com/spec.json', change),
    specChangeId('stripe', 'https://example.com/spec.json', change)
  );
});

// --- Fixture Statuspage payload (fully offline) ---

const statuspageSummaryFixture = {
  page: { id: 'page1', name: 'OpenAI', url: 'https://status.openai.com' },
  status: { indicator: 'major_outage', description: 'Partial System Outage' },
  components: [
    { id: 'comp1', name: 'Chat Completions API', status: 'major_outage' }
  ],
  incidents: [
    {
      id: 'abc123XYZ',
      name: 'Elevated errors on Chat Completions',
      status: 'investigating',
      impact: 'major',
      created_at: '2026-11-21T10:00:00Z',
      shortlink: 'https://stspg.io/example',
      components: [{ id: 'comp1', name: 'Chat Completions API' }],
      incident_updates: [
        {
          body: 'We are investigating elevated 5xx errors across the API.',
          status: 'investigating',
          created_at: '2026-11-21T10:05:00Z'
        }
      ]
    },
    {
      id: 'old999',
      name: 'Yesterday latency blip',
      status: 'resolved',
      impact: 'minor',
      created_at: '2026-11-20T09:00:00Z',
      components: [],
      incident_updates: [{ body: 'Resolved.', status: 'resolved' }]
    }
  ]
};

test('19. Statuspage: summary payload maps into the incidents model', () => {
  const { incidents, indicator } = mapStatuspageSummary('openai', statuspageSummaryFixture);

  assert.strictEqual(indicator, 'major_outage');
  assert.strictEqual(incidents.length, 1, 'Resolved incidents must be filtered out');

  const inc = incidents[0];
  assert.strictEqual(inc.id, 'sp_openai_abc123xyz');
  assert.strictEqual(inc.source, 'statuspage');
  assert.strictEqual(inc.service_slug, 'openai');
  assert.strictEqual(inc.severity, 'major');
  assert.strictEqual(inc.affected_scope, 'Chat Completions API');
  assert.ok(inc.agent_summary.includes('Elevated errors on Chat Completions'));
  assert.ok(inc.agent_summary.includes('elevated 5xx errors'));
  assert.ok(inc.agent_hint.length > 0);
  assert.strictEqual(inc.started_at, '2026-11-21T10:00:00Z');
});

test('20. Statuspage: deterministic ids dedupe repeat polls; severity normalization applies', () => {
  const first = mapStatuspageSummary('openai', statuspageSummaryFixture);
  const second = mapStatuspageSummary('openai', statuspageSummaryFixture);
  assert.deepStrictEqual(
    first.incidents.map(i => i.id),
    second.incidents.map(i => i.id),
    'Same payload must map to the same incident ids (dedupe key)'
  );
  assert.strictEqual(statuspageIncidentId('openai', 'abc123XYZ'), 'sp_openai_abc123xyz');

  const critical = mapStatuspageIncident('github', {
    id: 'zz42',
    name: 'Actions unavailable',
    status: 'investigating',
    impact: 'critical',
    components: [{ id: 'c9', name: 'Actions' }],
    incident_updates: []
  });
  assert.strictEqual(critical.severity, 'critical');
  assert.strictEqual(critical.id, 'sp_github_zz42');

  // Malformed payloads map to empty results instead of throwing
  assert.deepStrictEqual(mapStatuspageSummary('openai', null).incidents, []);
  assert.deepStrictEqual(mapStatuspageSummary('openai', {}).incidents, []);
});
