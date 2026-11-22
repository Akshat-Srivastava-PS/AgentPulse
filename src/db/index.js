import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { domainEvents } from '../engine/events.js';
import { normalizeEndpoints, changeMatchesEndpoints } from '../engine/endpoints.js';
import { getRequestLogContext } from '../engine/requestContext.js';
import { PLANS, getPlan } from '../engine/plans.js';

const DB_PATH = process.env.DB_PATH || path.resolve(process.cwd(), 'agentpulse.sqlite');

let dbInstance = null;

export function getDb() {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    dbInstance.exec('PRAGMA synchronous = NORMAL;');
    dbInstance.exec('PRAGMA busy_timeout = 5000;');
    initSchema(dbInstance);
  }
  return dbInstance;
}

/**
 * Close and discard the current database connection so the next getDb()
 * call opens a fresh one. Used by the test harness to ensure each test
 * file starts with a clean, deterministic database (the SQLite file is
 * deleted externally between runs). Has no effect in production.
 */
export function resetDb() {
  if (dbInstance) {
    try { dbInstance.close(); } catch { /* already closed */ }
    dbInstance = null;
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS services (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL,
      current_status TEXT NOT NULL DEFAULT 'operational',
      etag TEXT NOT NULL,
      provider_status_page TEXT,
      healthcheck_url TEXT,
      latency_ms REAL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_services_status ON services(current_status);
    CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);

    CREATE TABLE IF NOT EXISTS incidents (
      id TEXT PRIMARY KEY,
      service_slug TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'minor',
      affected_scope TEXT NOT NULL,
      agent_summary TEXT NOT NULL,
      agent_hint TEXT NOT NULL,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TEXT,
      FOREIGN KEY (service_slug) REFERENCES services(slug) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_incidents_service ON incidents(service_slug);
    CREATE INDEX IF NOT EXISTS idx_incidents_active ON incidents(service_slug, resolved_at);

    CREATE TABLE IF NOT EXISTS breaking_changes (
      id TEXT PRIMARY KEY,
      service_slug TEXT NOT NULL,
      version_or_date TEXT NOT NULL,
      change_type TEXT NOT NULL,
      kind TEXT,
      location TEXT,
      diff_summary TEXT NOT NULL,
      migration_hint TEXT NOT NULL,
      detected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_slug) REFERENCES services(slug) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_breaking_changes_service ON breaking_changes(service_slug);

    CREATE TABLE IF NOT EXISTS agent_clients (
      id TEXT PRIMARY KEY,
      api_key_hash TEXT UNIQUE NOT NULL,
      agent_name TEXT NOT NULL,
      operator_url TEXT NOT NULL,
      tier TEXT NOT NULL DEFAULT 'free_verified',
      daily_quota INTEGER NOT NULL DEFAULT 100,
      good_citizen_score INTEGER NOT NULL DEFAULT 100,
      requests_today INTEGER NOT NULL DEFAULT 0,
      last_reset_date TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_agent_clients_key_hash ON agent_clients(api_key_hash);

    CREATE TABLE IF NOT EXISTS synthetic_probes (
      id TEXT PRIMARY KEY,
      service_slug TEXT NOT NULL,
      probe_target TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      latency_ms REAL NOT NULL,
      is_healthy INTEGER NOT NULL DEFAULT 1,
      checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_slug) REFERENCES services(slug) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS outage_signals (
      id TEXT PRIMARY KEY,
      service_slug TEXT NOT NULL,
      agent_id TEXT,
      endpoint TEXT NOT NULL,
      error_code INTEGER NOT NULL,
      error_type TEXT,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_slug) REFERENCES services(slug) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS spec_snapshots (
      id TEXT PRIMARY KEY,
      service_slug TEXT NOT NULL,
      spec_url TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (service_slug) REFERENCES services(slug) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_spec_snapshots_lookup ON spec_snapshots(service_slug, spec_url, fetched_at DESC);

    CREATE TABLE IF NOT EXISTS agent_dependencies (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      service_slug TEXT NOT NULL,
      package_name TEXT,
      package_version TEXT,
      endpoints TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agent_clients(id) ON DELETE CASCADE,
      FOREIGN KEY (service_slug) REFERENCES services(slug) ON DELETE CASCADE,
      UNIQUE (agent_id, service_slug)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_dependencies_agent ON agent_dependencies(agent_id);

    CREATE TABLE IF NOT EXISTS agent_webhooks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      url TEXT NOT NULL,
      events TEXT NOT NULL,
      services TEXT,
      secret TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agent_clients(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_agent_webhooks_agent ON agent_webhooks(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_webhooks_active ON agent_webhooks(active);

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id TEXT PRIMARY KEY,
      webhook_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      last_status_code INTEGER,
      last_error TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      delivered_at TEXT,
      FOREIGN KEY (webhook_id) REFERENCES agent_webhooks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS request_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      agent_name TEXT,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      counted INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_request_log_agent ON request_log(agent_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS billing_links (
      subscription_id TEXT PRIMARY KEY,
      customer_id TEXT,
      tier TEXT,
      agent_id TEXT
    );

    CREATE TABLE IF NOT EXISTS billing_events (
      event_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );
  `);

  addColumnIfMissing(db, 'agent_clients', 'stripe_customer_id', 'TEXT');
  addColumnIfMissing(db, 'agent_clients', 'stripe_subscription_id', 'TEXT');
  // Endpoint-level relevance: structured diff kind/location on breaking
  // changes (rows written before this stay NULL and keep legacy behaviour),
  // and the optional declared-endpoints list (JSON) on manifest entries.
  addColumnIfMissing(db, 'breaking_changes', 'kind', 'TEXT');
  addColumnIfMissing(db, 'breaking_changes', 'location', 'TEXT');
  addColumnIfMissing(db, 'agent_dependencies', 'endpoints', 'TEXT');

  // Seed the services catalog on first boot. The catalog is configuration
  // (the registry of tracked vendors) — no incidents, breaking changes, or
  // any other sample data are seeded; those come only from the live
  // ingestion workers, synthetic probes, and agent telemetry.
  const countRow = db.prepare('SELECT count(*) as count FROM services').get();
  if (countRow.count === 0) {
    try {
      seedServiceCatalog(db);
    } catch (err) {
      // Concurrent first boot (e.g. parallel test processes or clustered
      // workers opening the same fresh database): another process may seed
      // the catalog at the same time and win the race. The catalog rows are
      // identical, so losing is harmless — but only swallow the error if
      // seeding did in fact happen; a genuinely empty database means a
      // real failure.
      const after = db.prepare('SELECT count(*) as count FROM services').get();
      if (after.count === 0) throw err;
    }
  }
}

/**
 * Add a column to an existing table when it is not already there, so
 * databases created by earlier versions gain new columns on boot without
 * a destructive migration.
 */
function addColumnIfMissing(db, table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(c => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function generateEtag(data) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').substring(0, 16);
  return `W/"${hash}"`;
}

function seedServiceCatalog(db) {
  const now = new Date().toISOString();

  // Registry of tracked vendors. Every service starts 'operational' with
  // no latency measurement (latency_ms 0 = not yet measured) — real values
  // are written by the ingestion workers and synthetic probes as they run.
  // There is deliberately no uptime figure: uptime was never measured, so
  // none is stored or served.
  const services = [
    {
      slug: 'stripe',
      name: 'Stripe',
      category: 'payments',
      current_status: 'operational',
      provider_status_page: 'https://status.stripe.com',
      healthcheck_url: 'https://api.stripe.com/healthcheck',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'openai',
      name: 'OpenAI API',
      category: 'ai_models',
      current_status: 'operational',
      provider_status_page: 'https://status.openai.com',
      healthcheck_url: 'https://api.openai.com/v1/models',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'anthropic',
      name: 'Anthropic Claude API',
      category: 'ai_models',
      current_status: 'operational',
      provider_status_page: 'https://status.anthropic.com',
      healthcheck_url: 'https://api.anthropic.com/v1/messages',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'github',
      name: 'GitHub Platform & Actions',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://www.githubstatus.com',
      healthcheck_url: 'https://api.github.com/zen',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'aws',
      name: 'Amazon Web Services (AWS)',
      category: 'cloud_infra',
      current_status: 'operational',
      provider_status_page: 'https://health.aws.amazon.com',
      healthcheck_url: 'https://aws.amazon.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'supabase',
      name: 'Supabase Platform',
      category: 'database',
      current_status: 'operational',
      provider_status_page: 'https://status.supabase.com',
      healthcheck_url: 'https://api.supabase.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'vercel',
      name: 'Vercel Edge Network',
      category: 'hosting',
      current_status: 'operational',
      provider_status_page: 'https://www.vercel-status.com',
      healthcheck_url: 'https://api.vercel.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'cloudflare',
      name: 'Cloudflare Edge & Workers',
      category: 'cloud_infra',
      current_status: 'operational',
      provider_status_page: 'https://www.cloudflarestatus.com',
      healthcheck_url: 'https://1.1.1.1',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'resend',
      name: 'Resend Transactional Email',
      category: 'communications',
      current_status: 'operational',
      provider_status_page: 'https://status.resend.com',
      healthcheck_url: 'https://api.resend.com/emails',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'datadog',
      name: 'Datadog Observability',
      category: 'observability',
      current_status: 'operational',
      provider_status_page: 'https://status.datadoghq.com',
      healthcheck_url: 'https://api.datadoghq.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'pinecone',
      name: 'Pinecone Vector DB',
      category: 'database',
      current_status: 'operational',
      provider_status_page: 'https://status.pinecone.io',
      healthcheck_url: 'https://api.pinecone.io',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'npm',
      name: 'npm Package Registry',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://status.npmjs.org',
      healthcheck_url: 'https://registry.npmjs.org',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'twilio',
      name: 'Twilio',
      category: 'communications',
      current_status: 'operational',
      provider_status_page: 'https://status.twilio.com',
      healthcheck_url: 'https://api.twilio.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'discord',
      name: 'Discord',
      category: 'communications',
      current_status: 'operational',
      provider_status_page: 'https://discordstatus.com',
      healthcheck_url: 'https://discord.com/api/v10',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'sentry',
      name: 'Sentry',
      category: 'observability',
      current_status: 'operational',
      provider_status_page: 'https://status.sentry.io',
      healthcheck_url: 'https://sentry.io',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'mongodb',
      name: 'MongoDB Atlas',
      category: 'database',
      current_status: 'operational',
      provider_status_page: 'https://status.mongodb.com',
      healthcheck_url: 'https://cloud.mongodb.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'digitalocean',
      name: 'DigitalOcean',
      category: 'cloud_infra',
      current_status: 'operational',
      provider_status_page: 'https://status.digitalocean.com',
      healthcheck_url: 'https://api.digitalocean.com/v2',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'circleci',
      name: 'CircleCI',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://status.circleci.com',
      healthcheck_url: 'https://circleci.com/api/v2',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'bitbucket',
      name: 'Atlassian Bitbucket',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://bitbucket.status.atlassian.com',
      healthcheck_url: 'https://api.bitbucket.org/2.0',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'zoom',
      name: 'Zoom',
      category: 'communications',
      current_status: 'operational',
      provider_status_page: 'https://status.zoom.us',
      healthcheck_url: 'https://api.zoom.us/v2',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'cohere',
      name: 'Cohere API',
      category: 'ai_models',
      current_status: 'operational',
      provider_status_page: 'https://status.cohere.com',
      healthcheck_url: 'https://api.cohere.com/v2',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'clerk',
      name: 'Clerk',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://status.clerk.com',
      healthcheck_url: 'https://api.clerk.com/v1',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'render',
      name: 'Render',
      category: 'hosting',
      current_status: 'operational',
      provider_status_page: 'https://status.render.com',
      healthcheck_url: 'https://api.render.com/v1',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'flyio',
      name: 'Fly.io',
      category: 'hosting',
      current_status: 'operational',
      provider_status_page: 'https://status.flyio.net',
      healthcheck_url: 'https://api.fly.io',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'snowflake',
      name: 'Snowflake',
      category: 'database',
      current_status: 'operational',
      provider_status_page: 'https://status.snowflake.com',
      healthcheck_url: 'https://status.snowflake.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'elastic',
      name: 'Elastic Cloud',
      category: 'observability',
      current_status: 'operational',
      provider_status_page: 'https://status.elastic.co',
      healthcheck_url: 'https://cloud.elastic.co',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'postman',
      name: 'Postman',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://status.postman.com',
      healthcheck_url: 'https://api.getpostman.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'shopify',
      name: 'Shopify',
      category: 'payments',
      current_status: 'operational',
      provider_status_page: 'https://www.shopifystatus.com',
      healthcheck_url: 'https://www.shopify.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'elevenlabs',
      name: 'ElevenLabs',
      category: 'ai_models',
      current_status: 'operational',
      provider_status_page: 'https://status.elevenlabs.io',
      healthcheck_url: 'https://api.elevenlabs.io/v1',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'convex',
      name: 'Convex',
      category: 'database',
      current_status: 'operational',
      provider_status_page: 'https://status.convex.dev',
      healthcheck_url: 'https://api.convex.dev',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'linode',
      name: 'Linode',
      category: 'cloud_infra',
      current_status: 'operational',
      provider_status_page: 'https://status.linode.com',
      healthcheck_url: 'https://api.linode.com/v4',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'atlassian',
      name: 'Atlassian',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://status.atlassian.com',
      healthcheck_url: 'https://api.atlassian.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'jira',
      name: 'Jira',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://jira-software.status.atlassian.com',
      healthcheck_url: 'https://api.atlassian.com',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'dropbox',
      name: 'Dropbox',
      category: 'cloud_infra',
      current_status: 'operational',
      provider_status_page: 'https://status.dropbox.com',
      healthcheck_url: 'https://api.dropboxapi.com/2',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'box',
      name: 'Box',
      category: 'cloud_infra',
      current_status: 'operational',
      provider_status_page: 'https://status.box.com',
      healthcheck_url: 'https://api.box.com/2.0',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'figma',
      name: 'Figma',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://status.figma.com',
      healthcheck_url: 'https://api.figma.com/v1',
      latency_ms: 0,
      updated_at: now
    },
    {
      slug: 'airtable',
      name: 'Airtable',
      category: 'database',
      current_status: 'operational',
      provider_status_page: 'https://status.airtable.com',
      healthcheck_url: 'https://api.airtable.com/v0',
      latency_ms: 0,
      updated_at: now
    }
  ];

  const insertService = db.prepare(`
    INSERT INTO services (slug, name, category, current_status, etag, provider_status_page, healthcheck_url, latency_ms, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const s of services) {
    const etag = generateEtag({ slug: s.slug, status: s.current_status, updated_at: s.updated_at });
    insertService.run(s.slug, s.name, s.category, s.current_status, etag, s.provider_status_page, s.healthcheck_url, s.latency_ms, s.updated_at);
  }

  // No incidents or breaking changes are seeded — ever. A fresh database
  // has zero incidents and zero breaking changes; the Statuspage poller,
  // the OpenAPI spec-diff worker, synthetic probes, and agent telemetry
  // are the only sources of that data.

  // NOTE (Step 3): no demo agent is seeded anymore. Earlier versions seeded a
  // well-known demo key (agp_live_demo...); a predictable credential in every
  // fresh install is a standing backdoor, so fresh databases start with zero
  // agents — register via POST /v1/agents/register instead. Existing databases
  // keep their rows; see README "Quotas & Auth (Step 3)" for the one-line SQL
  // to retire the demo agent from an existing install.
}

// Database helper functions
// Databases created before the truth pass may still carry a legacy
// uptime_percentage column (a seeded constant, never measured or
// updated). It is never served: strip it from every row leaving here.
function stripUnmeasuredFields(row) {
  if (row) delete row.uptime_percentage;
  return row;
}

export function getService(slug) {
  const db = getDb();
  return stripUnmeasuredFields(db.prepare('SELECT * FROM services WHERE slug = ?').get(slug));
}

export function getAllServices() {
  const db = getDb();
  return db.prepare('SELECT * FROM services ORDER BY name ASC').all().map(stripUnmeasuredFields);
}

export function updateServiceStatus(slug, current_status, latency_ms = null) {
  const db = getDb();
  const now = new Date().toISOString();
  const service = getService(slug);
  if (!service) return null;

  const incidents = getActiveIncidents(slug);
  const newEtag = generateEtag({ slug, status: current_status, incidents: incidents.map(i => i.id), now });

  if (latency_ms !== null) {
    db.prepare('UPDATE services SET current_status = ?, latency_ms = ?, etag = ?, updated_at = ? WHERE slug = ?')
      .run(current_status, latency_ms, newEtag, now, slug);
  } else {
    db.prepare('UPDATE services SET current_status = ?, etag = ?, updated_at = ? WHERE slug = ?')
      .run(current_status, newEtag, now, slug);
  }

  return getService(slug);
}

export function getActiveIncidents(serviceSlug = null) {
  const db = getDb();
  if (serviceSlug) {
    return db.prepare('SELECT * FROM incidents WHERE service_slug = ? AND resolved_at IS NULL ORDER BY started_at DESC').all(serviceSlug);
  }
  return db.prepare('SELECT i.*, s.name as service_name FROM incidents i JOIN services s ON i.service_slug = s.slug WHERE i.resolved_at IS NULL ORDER BY i.started_at DESC').all();
}

export function getRecentIncidents(limit = 20) {
  const db = getDb();
  return db.prepare('SELECT i.*, s.name as service_name FROM incidents i JOIN services s ON i.service_slug = s.slug ORDER BY i.started_at DESC LIMIT ?').all(limit);
}

export function createIncident({ id, service_slug, severity, affected_scope, agent_summary, agent_hint }) {
  const db = getDb();
  const incidentId = id || `inc_${Date.now().toString(36)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO incidents (id, service_slug, severity, affected_scope, agent_summary, agent_hint, started_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
  `).run(incidentId, service_slug, severity, affected_scope, agent_summary, agent_hint, now);

  // Automatically update service status to degraded or outage
  const status = severity === 'critical' ? 'outage' : 'degraded';
  updateServiceStatus(service_slug, status);

  const incident = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
  // Step 4: domain event for webhook dispatch (see src/engine/events.js).
  domainEvents.emit('incident.created', incident);
  return incident;
}

export function resolveIncident(incidentId) {
  const db = getDb();
  const now = new Date().toISOString();
  const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
  if (!inc) return null;
  const wasActive = inc.resolved_at === null;

  db.prepare('UPDATE incidents SET resolved_at = ? WHERE id = ?').run(now, incidentId);

  // If no remaining active incidents, restore operational status
  const remaining = getActiveIncidents(inc.service_slug);
  if (remaining.length === 0) {
    updateServiceStatus(inc.service_slug, 'operational');
  } else {
    const highestSev = remaining.some(i => i.severity === 'critical') ? 'outage' : 'degraded';
    updateServiceStatus(inc.service_slug, highestSev);
  }

  const resolved = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
  // Step 4: only a live -> resolved transition is an event; re-resolving an
  // already-resolved incident must not re-alert subscribers.
  if (wasActive) {
    domainEvents.emit('incident.resolved', resolved);
  }
  return resolved;
}

export function getBreakingChanges(serviceSlug = null, sinceTs = null) {
  const db = getDb();
  let query = 'SELECT b.*, s.name as service_name FROM breaking_changes b JOIN services s ON b.service_slug = s.slug WHERE 1=1';
  const params = [];

  if (serviceSlug) {
    query += ' AND b.service_slug = ?';
    params.push(serviceSlug);
  }

  if (sinceTs) {
    query += ' AND b.detected_at >= ?';
    params.push(sinceTs);
  }

  query += ' ORDER BY b.detected_at DESC';
  return db.prepare(query).all(...params);
}

export function createBreakingChange({ id, service_slug, version_or_date, change_type, diff_summary, migration_hint, kind = null, location = null }) {
  const db = getDb();
  const bcId = id || `bc_${Date.now().toString(36)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO breaking_changes (id, service_slug, version_or_date, change_type, kind, location, diff_summary, migration_hint, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bcId, service_slug, version_or_date, change_type, kind, location, diff_summary, migration_hint, now);

  const change = db.prepare('SELECT * FROM breaking_changes WHERE id = ?').get(bcId);
  // Step 4: domain event for webhook dispatch (see src/engine/events.js).
  domainEvents.emit('change.detected', change);
  return change;
}

export function registerAgentClient({ agent_name, operator_url }) {
  const db = getDb();
  const id = `agent_${crypto.randomUUID().substring(0, 8)}`;
  const rawApiKey = `agp_live_${crypto.randomBytes(20).toString('hex')}`;
  const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
  const now = new Date().toISOString();
  const today = now.substring(0, 10);

  // Registration always lands on the free plan (see src/engine/plans.js).
  const freePlan = PLANS.free_verified;
  db.prepare(`
    INSERT INTO agent_clients (id, api_key_hash, agent_name, operator_url, tier, daily_quota, good_citizen_score, requests_today, last_reset_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 100, 0, ?, ?)
  `).run(id, apiKeyHash, agent_name, operator_url, freePlan.tier, freePlan.daily_quota, today, now);

  const client = db.prepare('SELECT id, agent_name, operator_url, tier, daily_quota, good_citizen_score FROM agent_clients WHERE id = ?').get(id);

  return {
    ...client,
    api_key: rawApiKey // Provided strictly once during creation
  };
}

export function getAgentByApiKey(rawApiKey) {
  if (!rawApiKey) return null;
  const db = getDb();
  const hash = crypto.createHash('sha256').update(rawApiKey.trim()).digest('hex');
  const today = new Date().toISOString().substring(0, 10);

  const agent = db.prepare('SELECT * FROM agent_clients WHERE api_key_hash = ?').get(hash);
  if (!agent) return null;

  // Check if daily quota needs reset
  if (agent.last_reset_date !== today) {
    db.prepare('UPDATE agent_clients SET requests_today = 0, last_reset_date = ? WHERE id = ?').run(today, agent.id);
    agent.requests_today = 0;
    agent.last_reset_date = today;
  }

  return agent;
}

export function recordAgentUsage(agentId, isEtag304 = false) {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agent_clients WHERE id = ?').get(agentId);
  if (!agent) return;

  let scoreDelta = 0;
  if (isEtag304) {
    // Reward good citizen: respecting ETag saves tokens and compute!
    scoreDelta = 2;
  }

  const newScore = Math.min(1000, agent.good_citizen_score + scoreDelta);
  // Pricing policy (owner decision, Nov 2026): the free tier is a FLAT
  // 100 counted requests/day for every agent. The Good Citizen score is
  // reputational only — it never raises the daily quota. Anything above
  // 100/day is a paid tier. (The 304 exemption below is the caching
  // benefit: conditional requests are free, so a well-behaved agent's
  // 100 counted calls stretch much further.)
  const newQuota = agent.daily_quota;

  if (isEtag304) {
    // Step 3: a 304 Not Modified response does NOT consume daily quota —
    // that exemption is the Good Citizen incentive. The score reward is
    // still applied; the quota itself does not change.
    db.prepare(`
      UPDATE agent_clients
      SET good_citizen_score = ?,
          daily_quota = ?
      WHERE id = ?
    `).run(newScore, newQuota, agentId);
    return;
  }

  db.prepare(`
    UPDATE agent_clients
    SET requests_today = requests_today + 1,
        good_citizen_score = ?,
        daily_quota = ?
    WHERE id = ?
  `).run(newScore, newQuota, agentId);

  // Owner visibility: this call consumed one unit of quota, so flag the
  // in-flight request's log context as counted (and attribute it, for the
  // MCP api_key-argument path where the HTTP layer may not have resolved
  // the agent yet). The 304 path above returns earlier and never counts.
  const logCtx = getRequestLogContext();
  if (logCtx) {
    logCtx.counted = 1;
    if (!logCtx.agentId) {
      logCtx.agentId = agentId;
      logCtx.agentName = agent.agent_name || logCtx.agentName || null;
    }
  }
}

/**
 * Step 3: current quota state for an agent, used for enforcement and for the
 * X-RateLimit-* response headers. The daily window resets at UTC midnight.
 * If the stored reset date is stale (new UTC day, agent not yet re-fetched
 * through getAgentByApiKey), usage is reported as 0 — getAgentByApiKey
 * performs the persisted reset on the auth path before this is consulted.
 */
export function getAgentQuotaState(agentId) {
  const db = getDb();
  const agent = db.prepare('SELECT * FROM agent_clients WHERE id = ?').get(agentId);
  if (!agent) return null;

  const now = new Date();
  const today = now.toISOString().substring(0, 10);
  const used = agent.last_reset_date === today ? agent.requests_today : 0;
  const limit = agent.daily_quota;
  const remaining = Math.max(0, limit - used);

  const resetAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const retryAfterSeconds = Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000));

  return {
    allowed: remaining > 0,
    limit,
    used,
    remaining,
    reset_at: resetAt.toISOString(),
    reset_epoch_seconds: Math.floor(resetAt.getTime() / 1000),
    retry_after_seconds: retryAfterSeconds
  };
}

export function recordSyntheticProbe({ service_slug, probe_target, status_code, latency_ms, is_healthy }) {
  const db = getDb();
  const id = `probe_${crypto.randomUUID().substring(0, 8)}`;
  const now = new Date().toISOString();

  // latency_ms null means the probe produced no measurement (target
  // unreachable from this host). The probe row records 0 (unmeasured, the
  // same convention as the service seed) and the service's last measured
  // latency is left untouched — an invented number is never written.
  const measured = typeof latency_ms === 'number';

  db.prepare(`
    INSERT INTO synthetic_probes (id, service_slug, probe_target, status_code, latency_ms, is_healthy, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, service_slug, probe_target, status_code, measured ? latency_ms : 0, is_healthy ? 1 : 0, now);

  // Update current service latency only from a real measurement
  if (measured) {
    db.prepare('UPDATE services SET latency_ms = ? WHERE slug = ?').run(latency_ms, service_slug);
  }
}

export function recordOutageSignal({ service_slug, agent_id, endpoint, error_code, error_type }) {
  const db = getDb();
  const id = `sig_${crypto.randomUUID().substring(0, 8)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO outage_signals (id, service_slug, agent_id, endpoint, error_code, error_type, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, service_slug, agent_id || null, endpoint, error_code, error_type || '5xx_error', now);

  return { id, service_slug, received_at: now };
}

/**
 * Aggregates recorded outage signals for one service since an ISO timestamp:
 * total count, distinct reporting agents, distinct endpoints, latest report.
 * This is the read side consumed by the telemetry feedback loop
 * (src/workers/telemetryLoop.js). COUNT(DISTINCT agent_id) ignores the NULL
 * agent_id of any unattributed row.
 */
export function getRecentOutageSignalStats(serviceSlug, sinceIso) {
  const db = getDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS total,
           COUNT(DISTINCT agent_id) AS distinct_agents,
           COUNT(DISTINCT endpoint) AS distinct_endpoints,
           MAX(received_at) AS latest_at
    FROM outage_signals
    WHERE service_slug = ? AND received_at >= ?
  `).get(serviceSlug, sinceIso);

  return {
    total: row?.total ?? 0,
    distinct_agents: row?.distinct_agents ?? 0,
    distinct_endpoints: row?.distinct_endpoints ?? 0,
    latest_at: row?.latest_at ?? null
  };
}

export function getIncidentById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM incidents WHERE id = ?').get(id);
}

export function getBreakingChangeById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM breaking_changes WHERE id = ?').get(id);
}

// --- OpenAPI spec snapshots (Step 1: real spec-diff ingestion) ---

export function getLatestSpecSnapshot(serviceSlug, specUrl) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM spec_snapshots
    WHERE service_slug = ? AND spec_url = ?
    ORDER BY fetched_at DESC, rowid DESC
    LIMIT 1
  `).get(serviceSlug, specUrl);
}

export function saveSpecSnapshot({ service_slug, spec_url, spec_hash, spec_json }) {
  const db = getDb();
  const id = `snap_${crypto.randomUUID().substring(0, 12)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO spec_snapshots (id, service_slug, spec_url, spec_hash, spec_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, service_slug, spec_url, spec_hash, spec_json, now);

  return db.prepare('SELECT * FROM spec_snapshots WHERE id = ?').get(id);
}

// --- Per-agent dependency manifests (Step 2: "affected code" answers) ---

function formatDependency(row) {
  if (!row) return null;
  const endpoints = parseJsonArray(row.endpoints);
  return {
    service: row.service_slug,
    package: row.package_name || null,
    version: row.package_version || null,
    endpoints: endpoints && endpoints.length > 0 ? endpoints : null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export function getAgentDependencies(agentId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_dependencies WHERE agent_id = ? ORDER BY service_slug ASC').all(agentId);
  return rows.map(formatDependency);
}

/**
 * Replace-all semantics: the agent's manifest becomes exactly `dependencies`.
 * Entries are normalized (slug lowercased) and deduped by slug (last wins).
 * Callers are responsible for validating slugs against the services table.
 */
export function setAgentDependencies(agentId, dependencies = []) {
  const db = getDb();
  const now = new Date().toISOString();

  const bySlug = new Map();
  for (const dep of dependencies || []) {
    if (!dep) continue;
    const slug = String(dep.service || dep.service_slug || '').trim().toLowerCase();
    if (!slug) continue;
    const pkg = dep.package ?? dep.package_name ?? null;
    const ver = dep.version ?? dep.package_version ?? null;
    const endpoints = normalizeEndpoints(dep.endpoints);
    bySlug.set(slug, {
      service_slug: slug,
      package_name: pkg !== null && pkg !== undefined && String(pkg).trim() !== '' ? String(pkg).trim() : null,
      package_version: ver !== null && ver !== undefined && String(ver).trim() !== '' ? String(ver).trim() : null,
      endpoints: endpoints && endpoints.length > 0 ? endpoints : null
    });
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM agent_dependencies WHERE agent_id = ?').run(agentId);
    const insert = db.prepare(`
      INSERT INTO agent_dependencies (id, agent_id, service_slug, package_name, package_version, endpoints, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const dep of bySlug.values()) {
      insert.run(
        `dep_${crypto.randomUUID().substring(0, 12)}`,
        agentId,
        dep.service_slug,
        dep.package_name,
        dep.package_version,
        dep.endpoints ? JSON.stringify(dep.endpoints) : null,
        now,
        now
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  return getAgentDependencies(agentId);
}

export function deleteAgentDependencies(agentId) {
  const db = getDb();
  const removed = getAgentDependencies(agentId).length;
  db.prepare('DELETE FROM agent_dependencies WHERE agent_id = ?').run(agentId);
  return removed;
}

// --- Webhook subscriptions & deliveries (Step 4: webhook alerts) ---

export const WEBHOOK_EVENT_TYPES = ['incident.created', 'incident.resolved', 'change.detected'];

function parseJsonArray(text) {
  if (text === null || text === undefined) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Public shape of a webhook row. The signing secret is only ever included
 * when `includeSecret` is true — that happens exactly once, in the create
 * response. The secret is stored in plaintext because it is needed to sign
 * every delivery (unlike API keys, which are only ever verified).
 */
export function formatWebhook(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    agent_id: row.agent_id,
    url: row.url,
    events: parseJsonArray(row.events) || [],
    services: parseJsonArray(row.services), // null = all services
    active: row.active === 1 || row.active === true,
    created_at: row.created_at
  };
  if (includeSecret) out.secret = row.secret;
  return out;
}

export function createAgentWebhook({ agent_id, url, events, services }) {
  const db = getDb();
  const id = `wh_${crypto.randomUUID().substring(0, 12)}`;
  const secret = `whsec_${crypto.randomBytes(24).toString('hex')}`;
  const now = new Date().toISOString();
  const eventList = Array.isArray(events) && events.length > 0 ? events : [...WEBHOOK_EVENT_TYPES];
  const serviceList = Array.isArray(services) && services.length > 0 ? services : null;

  db.prepare(`
    INSERT INTO agent_webhooks (id, agent_id, url, events, services, secret, active, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?)
  `).run(id, agent_id, url, JSON.stringify(eventList), serviceList ? JSON.stringify(serviceList) : null, secret, now);

  const row = db.prepare('SELECT * FROM agent_webhooks WHERE id = ?').get(id);
  return formatWebhook(row, { includeSecret: true });
}

export function getAgentWebhooks(agentId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_webhooks WHERE agent_id = ? ORDER BY created_at ASC, rowid ASC').all(agentId);
  return rows.map(row => formatWebhook(row));
}

/** Internal lookup (includes the secret) for the dispatcher. */
export function getWebhookRowById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM agent_webhooks WHERE id = ?').get(id) || null;
}

/** Ownership-scoped lookup for the REST layer: null when not the agent's. */
export function getAgentWebhookById(agentId, id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM agent_webhooks WHERE id = ? AND agent_id = ?').get(id, agentId);
  return formatWebhook(row);
}

export function deleteAgentWebhook(agentId, id) {
  const db = getDb();
  const info = db.prepare('DELETE FROM agent_webhooks WHERE id = ? AND agent_id = ?').run(id, agentId);
  return info.changes > 0;
}

/**
 * Active webhooks whose event filter includes `eventType` and whose service
 * filter matches `serviceSlug` (null/empty filter = all services). Returns
 * raw rows (with secrets) for the dispatcher.
 */
export function getMatchingWebhooks(eventType, serviceSlug, change = null) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM agent_webhooks WHERE active = 1').all();
  return rows.filter(row => {
    const events = parseJsonArray(row.events) || [];
    if (!events.includes(eventType)) return false;
    const services = parseJsonArray(row.services);
    if (services && services.length > 0 && !services.includes(serviceSlug)) return false;
    // Endpoint-level relevance: for change.detected, when the webhook's
    // owner declared endpoints for this service in their dependency
    // manifest, only changes on matching operations are delivered.
    // Owners without a manifest entry (or without endpoints on it) keep
    // the service-level behaviour above.
    if (eventType === 'change.detected' && change) {
      const dep = db.prepare(
        'SELECT endpoints FROM agent_dependencies WHERE agent_id = ? AND service_slug = ?'
      ).get(row.agent_id, serviceSlug);
      const endpoints = dep ? parseJsonArray(dep.endpoints) : null;
      if (endpoints && endpoints.length > 0 && !changeMatchesEndpoints(change, endpoints)) return false;
    }
    return true;
  });
}

export function createWebhookDelivery({ webhook_id, event_type, payload }) {
  const db = getDb();
  const id = `whd_${crypto.randomUUID().substring(0, 12)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO webhook_deliveries (id, webhook_id, event_type, payload, status, attempts, created_at)
    VALUES (?, ?, ?, ?, 'pending', 0, ?)
  `).run(id, webhook_id, event_type, payload, now);

  return db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id);
}

export function updateWebhookDelivery(id, { status, attempts, last_status_code, last_error, delivered_at }) {
  const db = getDb();
  db.prepare(`
    UPDATE webhook_deliveries
    SET status = ?, attempts = ?, last_status_code = ?, last_error = ?, delivered_at = ?
    WHERE id = ?
  `).run(status, attempts, last_status_code ?? null, last_error ?? null, delivered_at ?? null, id);
  return db.prepare('SELECT * FROM webhook_deliveries WHERE id = ?').get(id);
}

export function getWebhookDeliveries(webhookId, limit = 20) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM webhook_deliveries
    WHERE webhook_id = ?
    ORDER BY created_at DESC, rowid DESC
    LIMIT ?
  `).all(webhookId, limit);
  return rows.map(row => ({
    id: row.id,
    webhook_id: row.webhook_id,
    event_type: row.event_type,
    status: row.status,
    attempts: row.attempts,
    last_status_code: row.last_status_code,
    last_error: row.last_error,
    created_at: row.created_at,
    delivered_at: row.delivered_at
  }));
}

// --- Request log & owner visibility (admin) ---

/**
 * Append one row to the request log. Called exactly once per logged
 * request by the HTTP layer when the response ends. Never throws: a
 * logging failure must not break the request that produced it.
 */
export function logRequest({ agent_id = null, agent_name = null, method, path: reqPath, status_code, counted = 0 }) {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO request_log (agent_id, agent_name, method, path, status_code, counted, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(agent_id, agent_name, method, reqPath, status_code, counted ? 1 : 0, now);

    // Opportunistic pruning (~1 in 100 inserts): keep the log bounded to
    // the last 7 days without a background job. The retention window is
    // configurable via REQUEST_LOG_RETENTION_DAYS (default 7).
    if (Math.random() < 0.01) {
      const retentionDays = parseInt(process.env.REQUEST_LOG_RETENTION_DAYS || '7', 10) || 7;
      const cutoff = new Date(Date.now() - retentionDays * 24 * 3600 * 1000).toISOString();
      db.prepare('DELETE FROM request_log WHERE created_at < ?').run(cutoff);
    }
  } catch (err) {
    console.error('[RequestLog] failed to record request:', err.message);
  }
}

export function getAgentClientById(id) {
  const db = getDb();
  return db.prepare('SELECT * FROM agent_clients WHERE id = ?').get(id) || null;
}

export function getRecentRequestLog(limit = 50) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT agent_name, method, path, status_code, counted, created_at
    FROM request_log
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
  return rows.map(row => ({
    agent_name: row.agent_name,
    method: row.method,
    path: row.path,
    status_code: row.status_code,
    counted: row.counted === 1,
    created_at: row.created_at
  }));
}

/**
 * One agent row in the admin shape: quota state from the same helper the
 * enforcement path uses, usage aggregates from the request log. Shared by
 * the admin overview and the plan-grant path so both always agree.
 */
function buildAdminAgentRow(row) {
  const db = getDb();
  const state = getAgentQuotaState(row.id);
  const total = db.prepare('SELECT count(*) as count FROM request_log WHERE agent_id = ?').get(row.id).count;
  const lastSeen = db.prepare('SELECT MAX(created_at) as last_seen FROM request_log WHERE agent_id = ?').get(row.id).last_seen;
  const top = db.prepare(`
    SELECT path, count(*) as count FROM request_log
    WHERE agent_id = ?
    GROUP BY path
    ORDER BY count DESC, path ASC
    LIMIT 3
  `).all(row.id);
  return {
    id: row.id,
    agent_name: row.agent_name,
    operator_url: row.operator_url,
    tier: row.tier,
    daily_quota: row.daily_quota,
    requests_today: state ? state.used : row.requests_today,
    quota_remaining: state ? state.remaining : Math.max(0, row.daily_quota - row.requests_today),
    good_citizen_score: row.good_citizen_score,
    total_requests: total,
    last_seen_at: lastSeen || null,
    top_endpoints: top.map(t => ({ path: t.path, count: t.count })),
    created_at: row.created_at
  };
}

/**
 * Owner dashboard payload: fleet totals plus one row per registered agent,
 * sorted by requests_today desc.
 */
export function getAdminOverview() {
  const db = getDb();
  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const since24h = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

  const totals = {
    agents: db.prepare('SELECT count(*) as count FROM agent_clients').get().count,
    requests_today: db.prepare('SELECT count(*) as count FROM request_log WHERE created_at >= ?').get(todayStart).count,
    requests_24h: db.prepare('SELECT count(*) as count FROM request_log WHERE created_at >= ?').get(since24h).count,
    counted_today: db.prepare('SELECT count(*) as count FROM request_log WHERE counted = 1 AND created_at >= ?').get(todayStart).count
  };

  const agents = db.prepare('SELECT * FROM agent_clients ORDER BY created_at ASC').all().map(buildAdminAgentRow);

  agents.sort((a, b) => b.requests_today - a.requests_today);

  return { totals, agents };
}

/**
 * Owner plan grant: move an agent to a plan from the catalog
 * (src/engine/plans.js), setting BOTH tier and daily_quota from the plan
 * so the two can never drift apart. This is how paid plans are activated
 * today — by the operator, after purchase; there is no self-serve
 * checkout. Returns the updated agent in the admin row shape, or null
 * when the agent does not exist or the tier is unknown.
 */
export function setAgentTier(agentId, tier) {
  const plan = getPlan(tier);
  if (!plan) return null;
  const db = getDb();
  const existing = getAgentClientById(agentId);
  if (!existing) return null;

  db.prepare('UPDATE agent_clients SET tier = ?, daily_quota = ? WHERE id = ?')
    .run(plan.tier, plan.daily_quota, agentId);

  return buildAdminAgentRow(getAgentClientById(agentId));
}

// --- Stripe billing links & events ---
// Buyers pay through Stripe Payment Links. Two kinds of Stripe events
// carry the two halves of the mapping (checkout.session.completed carries
// client_reference_id = the agent id; subscription events carry the tier
// in metadata), and they can arrive in either order — so each half is
// stored in billing_links keyed by subscription id, and tryApplyBilling
// joins them whenever both halves are present.

/**
 * Record a Stripe event id for dedupe. Returns true when the event is
 * new, false when it was already recorded (Stripe redelivery).
 */
export function recordBillingEvent(eventId) {
  const db = getDb();
  const info = db.prepare('INSERT OR IGNORE INTO billing_events (event_id, received_at) VALUES (?, ?)')
    .run(eventId, new Date().toISOString());
  return info.changes > 0;
}

export function getBillingLink(subscriptionId) {
  const db = getDb();
  return db.prepare('SELECT * FROM billing_links WHERE subscription_id = ?').get(subscriptionId) || null;
}

/**
 * Merge the known halves of a subscription mapping. Fields left
 * null/undefined keep their stored values, so the checkout and
 * subscription events commute in either arrival order.
 */
export function upsertBillingLink({ subscription_id, customer_id = null, tier = null, agent_id = null }) {
  const db = getDb();
  const existing = getBillingLink(subscription_id);
  const merged = {
    subscription_id,
    customer_id: customer_id ?? (existing ? existing.customer_id : null),
    tier: tier ?? (existing ? existing.tier : null),
    agent_id: agent_id ?? (existing ? existing.agent_id : null)
  };
  db.prepare(`
    INSERT INTO billing_links (subscription_id, customer_id, tier, agent_id)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(subscription_id) DO UPDATE SET
      customer_id = excluded.customer_id,
      tier = excluded.tier,
      agent_id = excluded.agent_id
  `).run(merged.subscription_id, merged.customer_id, merged.tier, merged.agent_id);
  return getBillingLink(subscription_id);
}

/**
 * When the billing link for a subscription has both an agent and a paid
 * tier, apply that plan to the agent (tier + quota from the catalog, plus
 * the Stripe customer/subscription ids). No-op otherwise. Returns the
 * updated agent row, or null when nothing was applied.
 */
export function tryApplyBilling(subscriptionId) {
  const link = getBillingLink(subscriptionId);
  if (!link || !link.agent_id || !link.tier) return null;
  const plan = getPlan(link.tier);
  if (!plan || plan.tier === 'free_verified') return null;
  const db = getDb();
  const agent = getAgentClientById(link.agent_id);
  if (!agent) return null;

  db.prepare(`
    UPDATE agent_clients
    SET tier = ?, daily_quota = ?, stripe_customer_id = ?, stripe_subscription_id = ?
    WHERE id = ?
  `).run(plan.tier, plan.daily_quota, link.customer_id, subscriptionId, link.agent_id);

  return getAgentClientById(link.agent_id);
}

/**
 * Downgrade the agent linked to a subscription back to the free plan and
 * clear its stored subscription id. The agent is found through
 * billing_links, falling back to agent_clients.stripe_subscription_id.
 * The billing link row (when present) is marked free_verified. Returns
 * the downgraded agent row, or null when no agent is linked.
 */
export function downgradeBillingAgent(subscriptionId) {
  const db = getDb();
  const link = getBillingLink(subscriptionId);
  let agent = link && link.agent_id ? getAgentClientById(link.agent_id) : null;
  if (!agent) {
    agent = db.prepare('SELECT * FROM agent_clients WHERE stripe_subscription_id = ?').get(subscriptionId) || null;
  }
  if (link) {
    db.prepare('UPDATE billing_links SET tier = ? WHERE subscription_id = ?')
      .run(PLANS.free_verified.tier, subscriptionId);
  }
  if (!agent) return null;

  const freePlan = PLANS.free_verified;
  db.prepare(`
    UPDATE agent_clients
    SET tier = ?, daily_quota = ?, stripe_subscription_id = NULL
    WHERE id = ?
  `).run(freePlan.tier, freePlan.daily_quota, agent.id);

  return getAgentClientById(agent.id);
}

// Documented saving assumption behind estimated_tokens_saved: one compact
// AgentPulse check (a <150-token payload, or a zero-body 304) replaces the
// full status-page fetch and retry loop an agent would otherwise burn when
// a dependency misbehaves — estimated at 340 tokens per check. The figure
// is derived ONLY from real request_log rows for the current day (counted
// requests + 304 responses). There is no constant base: a deployment with
// no traffic today honestly reports 0.
const TOKENS_SAVED_PER_CHECK = 340;

export function getSystemMetrics() {
  const db = getDb();
  const totalServices = db.prepare('SELECT count(*) as count FROM services').get().count;
  const operationalCount = db.prepare("SELECT count(*) as count FROM services WHERE current_status = 'operational'").get().count;
  const degradedCount = db.prepare("SELECT count(*) as count FROM services WHERE current_status = 'degraded'").get().count;
  const outageCount = db.prepare("SELECT count(*) as count FROM services WHERE current_status = 'outage'").get().count;
  const activeIncidents = db.prepare('SELECT count(*) as count FROM incidents WHERE resolved_at IS NULL').get().count;
  const totalBreakingChanges = db.prepare('SELECT count(*) as count FROM breaking_changes').get().count;
  const totalAgents = db.prepare('SELECT count(*) as count FROM agent_clients').get().count;
  const totalRequestsToday = db.prepare('SELECT COALESCE(SUM(requests_today), 0) as total FROM agent_clients').get().total;

  const now = new Date();
  const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const countedToday = db.prepare('SELECT count(*) as count FROM request_log WHERE counted = 1 AND created_at >= ?').get(todayStart).count;
  const notModifiedToday = db.prepare('SELECT count(*) as count FROM request_log WHERE status_code = 304 AND created_at >= ?').get(todayStart).count;

  return {
    services: {
      total: totalServices,
      operational: operationalCount,
      degraded: degradedCount,
      outage: outageCount
    },
    active_incidents: activeIncidents,
    total_breaking_changes: totalBreakingChanges,
    registered_agents: totalAgents,
    requests_today: totalRequestsToday,
    estimated_tokens_saved: (countedToday + notModifiedToday) * TOKENS_SAVED_PER_CHECK
  };
}
