import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { handleRequest } from '../src/server.js';
import { getDb, updateServiceStatus } from '../src/db/index.js';

// --- Test fixtures --------------------------------------------------------
// The app seeds NO sample incidents or breaking changes: a fresh database
// contains only the services catalog. Tests that need a known incident or
// breaking change insert it explicitly through these helpers. INSERT OR
// IGNORE keeps each fixture idempotent when several test files share one
// database file, and the fixture rows carry the same ids/content the old
// global seeds used so assertions stay unchanged.

export function insertStripeIncidentFixture() {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO incidents (id, service_slug, severity, affected_scope, agent_summary, agent_hint, started_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(
    'inc_9821',
    'stripe',
    'major',
    'POST /v1/payment_intents (us-east-1)',
    'Elevated 502 error rate (~18%) starting 22:41 UTC.',
    'Use exponential backoff (min 15s) or defer non-urgent retries.',
    '2026-11-20T22:41:00Z'
  );
  updateServiceStatus('stripe', 'degraded');
}

export function insertOpenaiDeprecationFixture() {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO breaking_changes (id, service_slug, version_or_date, change_type, diff_summary, migration_hint, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'bc_101',
    'openai',
    '2026-10-01',
    'deprecation',
    'Legacy fine-tuning endpoints and text-davinci-003 models removed.',
    'Migrate calls to gpt-4o-mini or specify chat completions endpoint with model: "gpt-4o-2024-08-06".',
    '2026-10-01T00:00:00Z'
  );
}

export function insertStripeChangeFixture() {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO breaking_changes (id, service_slug, version_or_date, change_type, diff_summary, migration_hint, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    'bc_102',
    'stripe',
    '2026-09-15',
    'schema_diff',
    'Stripe-Version header requires YYYY-MM-DD. `payment_method_types` deprecated in favor of automatic payment methods.',
    'Omit `payment_method_types` and set `automatic_payment_methods[enabled]=true` on PaymentIntent creation.',
    '2026-09-15T12:00:00Z'
  );
}

export function dispatchRequest({ method = 'GET', url = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const normHeaders = {};
    for (const [k, v] of Object.entries(headers)) {
      normHeaders[k.toLowerCase()] = String(v);
    }
    if (!normHeaders['host']) {
      normHeaders['host'] = 'localhost:3000';
    }

    const payloadStr = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    if (payloadStr && !normHeaders['content-type']) {
      normHeaders['content-type'] = 'application/json';
    }

    const req = new Readable({
      read() {
        if (payloadStr) {
          this.push(payloadStr);
        }
        this.push(null);
      }
    });

    req.method = method;
    req.url = url;
    req.headers = normHeaders;

    const res = new EventEmitter();
    res.headers = {};
    res.statusCode = 200;
    res.body = '';

    res.setHeader = (k, v) => {
      res.headers[k.toLowerCase()] = String(v);
    };

    res.getHeader = (k) => {
      return res.headers[k.toLowerCase()];
    };

    res.writeHead = (status, extraHeaders = {}) => {
      res.statusCode = status;
      for (const [k, v] of Object.entries(extraHeaders)) {
        res.setHeader(k, v);
      }
    };

    res.write = (chunk) => {
      res.body += chunk ? chunk.toString() : '';
    };

    res.end = (chunk) => {
      if (chunk) {
        res.body += chunk.toString();
      }

      const responseObj = {
        status: res.statusCode,
        headers: {
          get: (k) => res.headers[k.toLowerCase()]
        },
        text: async () => res.body,
        json: async () => JSON.parse(res.body)
      };

      resolve(responseObj);
    };

    handleRequest(req, res).catch(reject);
  });
}
