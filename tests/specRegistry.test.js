import test from 'node:test';
import assert from 'node:assert';
import { SPEC_REGISTRY, getSpecRegistry } from '../src/workers/specDiff.js';
import { getDb } from '../src/db/index.js';

// Offline shape test for the spec-diff registry (Step 5). The live
// fetch/parse verification of every registered URL is a one-off audit pass,
// not a unit test — this test only guarantees the registry stays well-formed:
// slug keys, https URL values, no duplicate URLs, and every slug present in
// the seeded services catalog (a registry entry for an unknown slug would
// silently never diff, because the poller iterates catalog services).

test('90. SpecDiff registry: well-formed entries keyed by catalog slugs', () => {
  const entries = Object.entries(SPEC_REGISTRY);
  assert.ok(entries.length > 0, 'registry must not be empty');

  const catalog = new Set(
    getDb().prepare('SELECT slug FROM services').all().map(r => r.slug)
  );
  assert.ok(catalog.size > 0, 'services catalog must be seeded');

  const seenUrls = new Set();
  for (const [slug, url] of entries) {
    assert.match(slug, /^[a-z0-9]+$/, `registry key "${slug}" must be a service slug`);
    assert.ok(catalog.has(slug), `registry slug "${slug}" must exist in the services catalog`);
    assert.equal(typeof url, 'string', `registry entry "${slug}" must map to a URL string`);
    const parsed = new URL(url);
    assert.equal(parsed.protocol, 'https:', `registry URL for "${slug}" must be https`);
    assert.ok(!seenUrls.has(url), `registry URL for "${slug}" must not be duplicated`);
    seenUrls.add(url);
  }

  // With no env override, getSpecRegistry() returns the built-in registry.
  delete process.env.SPEC_SOURCES_JSON;
  assert.deepEqual(getSpecRegistry(), { ...SPEC_REGISTRY });
});
