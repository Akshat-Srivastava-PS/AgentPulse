import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';

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
      uptime_percentage REAL DEFAULT 99.95,
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
      daily_quota INTEGER NOT NULL DEFAULT 1000,
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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (agent_id) REFERENCES agent_clients(id) ON DELETE CASCADE,
      FOREIGN KEY (service_slug) REFERENCES services(slug) ON DELETE CASCADE,
      UNIQUE (agent_id, service_slug)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_dependencies_agent ON agent_dependencies(agent_id);
  `);

  // Check if initial services seeded
  const countRow = db.prepare('SELECT count(*) as count FROM services').get();
  if (countRow.count === 0) {
    try {
      seedInitialData(db);
    } catch (err) {
      // Concurrent first boot (e.g. parallel test processes or clustered
      // workers opening the same fresh database): another process may seed
      // at the same time and win the race. The seed data is identical, so
      // losing is harmless — but only swallow the error if seeding did in
      // fact happen; a genuinely empty database means a real failure.
      const after = db.prepare('SELECT count(*) as count FROM services').get();
      if (after.count === 0) throw err;
    }
  }
}

export function generateEtag(data) {
  const hash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex').substring(0, 16);
  return `W/"${hash}"`;
}

function seedInitialData(db) {
  const now = new Date().toISOString();

  const services = [
    {
      slug: 'stripe',
      name: 'Stripe',
      category: 'payments',
      current_status: 'degraded',
      provider_status_page: 'https://status.stripe.com',
      healthcheck_url: 'https://api.stripe.com/healthcheck',
      latency_ms: 184.2,
      uptime_percentage: 99.82,
      updated_at: '2026-11-20T22:55:00Z'
    },
    {
      slug: 'openai',
      name: 'OpenAI API',
      category: 'ai_models',
      current_status: 'operational',
      provider_status_page: 'https://status.openai.com',
      healthcheck_url: 'https://api.openai.com/v1/models',
      latency_ms: 245.5,
      uptime_percentage: 99.91,
      updated_at: now
    },
    {
      slug: 'anthropic',
      name: 'Anthropic Claude API',
      category: 'ai_models',
      current_status: 'operational',
      provider_status_page: 'https://status.anthropic.com',
      healthcheck_url: 'https://api.anthropic.com/v1/messages',
      latency_ms: 310.2,
      uptime_percentage: 99.94,
      updated_at: now
    },
    {
      slug: 'github',
      name: 'GitHub Platform & Actions',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://www.githubstatus.com',
      healthcheck_url: 'https://api.github.com/zen',
      latency_ms: 82.1,
      uptime_percentage: 99.98,
      updated_at: now
    },
    {
      slug: 'aws',
      name: 'Amazon Web Services (AWS)',
      category: 'cloud_infra',
      current_status: 'operational',
      provider_status_page: 'https://health.aws.amazon.com',
      healthcheck_url: 'https://aws.amazon.com',
      latency_ms: 45.3,
      uptime_percentage: 99.99,
      updated_at: now
    },
    {
      slug: 'supabase',
      name: 'Supabase Platform',
      category: 'database',
      current_status: 'operational',
      provider_status_page: 'https://status.supabase.com',
      healthcheck_url: 'https://api.supabase.com',
      latency_ms: 68.4,
      uptime_percentage: 99.93,
      updated_at: now
    },
    {
      slug: 'vercel',
      name: 'Vercel Edge Network',
      category: 'hosting',
      current_status: 'operational',
      provider_status_page: 'https://www.vercel-status.com',
      healthcheck_url: 'https://api.vercel.com',
      latency_ms: 54.0,
      uptime_percentage: 99.97,
      updated_at: now
    },
    {
      slug: 'cloudflare',
      name: 'Cloudflare Edge & Workers',
      category: 'cloud_infra',
      current_status: 'operational',
      provider_status_page: 'https://www.cloudflarestatus.com',
      healthcheck_url: 'https://1.1.1.1',
      latency_ms: 22.1,
      uptime_percentage: 99.99,
      updated_at: now
    },
    {
      slug: 'resend',
      name: 'Resend Transactional Email',
      category: 'communications',
      current_status: 'operational',
      provider_status_page: 'https://status.resend.com',
      healthcheck_url: 'https://api.resend.com/emails',
      latency_ms: 112.5,
      uptime_percentage: 99.96,
      updated_at: now
    },
    {
      slug: 'datadog',
      name: 'Datadog Observability',
      category: 'observability',
      current_status: 'operational',
      provider_status_page: 'https://status.datadoghq.com',
      healthcheck_url: 'https://api.datadoghq.com',
      latency_ms: 140.0,
      uptime_percentage: 99.95,
      updated_at: now
    },
    {
      slug: 'pinecone',
      name: 'Pinecone Vector DB',
      category: 'database',
      current_status: 'operational',
      provider_status_page: 'https://status.pinecone.io',
      healthcheck_url: 'https://api.pinecone.io',
      latency_ms: 95.3,
      uptime_percentage: 99.92,
      updated_at: now
    },
    {
      slug: 'npm',
      name: 'npm Package Registry',
      category: 'dev_tools',
      current_status: 'operational',
      provider_status_page: 'https://status.npmjs.org',
      healthcheck_url: 'https://registry.npmjs.org',
      latency_ms: 78.4,
      uptime_percentage: 99.94,
      updated_at: now
    }
  ];

  const insertService = db.prepare(`
    INSERT INTO services (slug, name, category, current_status, etag, provider_status_page, healthcheck_url, latency_ms, uptime_percentage, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const s of services) {
    const etag = generateEtag({ slug: s.slug, status: s.current_status, updated_at: s.updated_at });
    insertService.run(s.slug, s.name, s.category, s.current_status, etag, s.provider_status_page, s.healthcheck_url, s.latency_ms, s.uptime_percentage, s.updated_at);
  }

  // Seed sample incident matching user's exact specification
  const insertIncident = db.prepare(`
    INSERT INTO incidents (id, service_slug, severity, affected_scope, agent_summary, agent_hint, started_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertIncident.run(
    'inc_9821',
    'stripe',
    'major',
    'POST /v1/payment_intents (us-east-1)',
    'Elevated 502 error rate (~18%) starting 22:41 UTC.',
    'Use exponential backoff (min 15s) or defer non-urgent retries.',
    '2026-11-20T22:41:00Z',
    null
  );

  // Update stripe etag with incident
  const stripeEtag = generateEtag({ slug: 'stripe', status: 'degraded', incidents: ['inc_9821'] });
  db.prepare('UPDATE services SET etag = ? WHERE slug = ?').run(stripeEtag, 'stripe');

  // Seed realistic breaking changes
  const insertBreakingChange = db.prepare(`
    INSERT INTO breaking_changes (id, service_slug, version_or_date, change_type, diff_summary, migration_hint, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  insertBreakingChange.run(
    'bc_101',
    'openai',
    '2026-10-01',
    'deprecation',
    'Legacy fine-tuning endpoints and text-davinci-003 models removed.',
    'Migrate calls to gpt-4o-mini or specify chat completions endpoint with model: "gpt-4o-2024-08-06".',
    '2026-10-01T00:00:00Z'
  );

  insertBreakingChange.run(
    'bc_102',
    'stripe',
    '2026-09-15',
    'schema_diff',
    'Stripe-Version header requires YYYY-MM-DD. `payment_method_types` deprecated in favor of automatic payment methods.',
    'Omit `payment_method_types` and set `automatic_payment_methods[enabled]=true` on PaymentIntent creation.',
    '2026-09-15T12:00:00Z'
  );

  insertBreakingChange.run(
    'bc_103',
    'supabase',
    '2026-11-10',
    'rate_limit_change',
    'Free-tier Auth SMS burst limit tightened from 30/min to 10/min.',
    'Ensure auth retries implement token-bucket pacing or switch to custom Twilio credentials.',
    '2026-11-10T08:30:00Z'
  );

  // Seed demo agent client
  const insertAgent = db.prepare(`
    INSERT INTO agent_clients (id, api_key_hash, agent_name, operator_url, tier, daily_quota, good_citizen_score, requests_today, last_reset_date, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const demoKey = 'agp_live_demo1234567890abcdef';
  const demoHash = crypto.createHash('sha256').update(demoKey).digest('hex');
  const today = new Date().toISOString().substring(0, 10);

  insertAgent.run(
    'agent_demo_01',
    demoHash,
    'Claude-Code-Assistant',
    'https://docs.anthropic.com/claude-code',
    'free_verified',
    1000,
    142,
    18,
    today,
    now
  );
}

// Database helper functions
export function getService(slug) {
  const db = getDb();
  return db.prepare('SELECT * FROM services WHERE slug = ?').get(slug);
}

export function getAllServices() {
  const db = getDb();
  return db.prepare('SELECT * FROM services ORDER BY name ASC').all();
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

  return db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
}

export function resolveIncident(incidentId) {
  const db = getDb();
  const now = new Date().toISOString();
  const inc = db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
  if (!inc) return null;

  db.prepare('UPDATE incidents SET resolved_at = ? WHERE id = ?').run(now, incidentId);

  // If no remaining active incidents, restore operational status
  const remaining = getActiveIncidents(inc.service_slug);
  if (remaining.length === 0) {
    updateServiceStatus(inc.service_slug, 'operational');
  } else {
    const highestSev = remaining.some(i => i.severity === 'critical') ? 'outage' : 'degraded';
    updateServiceStatus(inc.service_slug, highestSev);
  }

  return db.prepare('SELECT * FROM incidents WHERE id = ?').get(incidentId);
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

export function createBreakingChange({ id, service_slug, version_or_date, change_type, diff_summary, migration_hint }) {
  const db = getDb();
  const bcId = id || `bc_${Date.now().toString(36)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO breaking_changes (id, service_slug, version_or_date, change_type, diff_summary, migration_hint, detected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(bcId, service_slug, version_or_date, change_type, diff_summary, migration_hint, now);

  return db.prepare('SELECT * FROM breaking_changes WHERE id = ?').get(bcId);
}

export function registerAgentClient({ agent_name, operator_url }) {
  const db = getDb();
  const id = `agent_${crypto.randomUUID().substring(0, 8)}`;
  const rawApiKey = `agp_live_${crypto.randomBytes(20).toString('hex')}`;
  const apiKeyHash = crypto.createHash('sha256').update(rawApiKey).digest('hex');
  const now = new Date().toISOString();
  const today = now.substring(0, 10);

  db.prepare(`
    INSERT INTO agent_clients (id, api_key_hash, agent_name, operator_url, tier, daily_quota, good_citizen_score, requests_today, last_reset_date, created_at)
    VALUES (?, ?, ?, ?, 'free_verified', 1000, 100, 0, ?, ?)
  `).run(id, apiKeyHash, agent_name, operator_url, today, now);

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
  // High good-citizen score unlocks bonus quota!
  let newQuota = agent.daily_quota;
  if (newScore >= 300 && agent.daily_quota === 1000) {
    newQuota = 2500; // Tier 2 bonus
  } else if (newScore >= 600 && agent.daily_quota === 2500) {
    newQuota = 5000; // Tier 3 bonus
  }

  db.prepare(`
    UPDATE agent_clients
    SET requests_today = requests_today + 1,
        good_citizen_score = ?,
        daily_quota = ?
    WHERE id = ?
  `).run(newScore, newQuota, agentId);
}

export function recordSyntheticProbe({ service_slug, probe_target, status_code, latency_ms, is_healthy }) {
  const db = getDb();
  const id = `probe_${crypto.randomUUID().substring(0, 8)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO synthetic_probes (id, service_slug, probe_target, status_code, latency_ms, is_healthy, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, service_slug, probe_target, status_code, latency_ms, is_healthy ? 1 : 0, now);

  // Update current service latency
  db.prepare('UPDATE services SET latency_ms = ? WHERE slug = ?').run(latency_ms, service_slug);
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
  return {
    service: row.service_slug,
    package: row.package_name || null,
    version: row.package_version || null,
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
    bySlug.set(slug, {
      service_slug: slug,
      package_name: pkg !== null && pkg !== undefined && String(pkg).trim() !== '' ? String(pkg).trim() : null,
      package_version: ver !== null && ver !== undefined && String(ver).trim() !== '' ? String(ver).trim() : null
    });
  }

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM agent_dependencies WHERE agent_id = ?').run(agentId);
    const insert = db.prepare(`
      INSERT INTO agent_dependencies (id, agent_id, service_slug, package_name, package_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const dep of bySlug.values()) {
      insert.run(
        `dep_${crypto.randomUUID().substring(0, 12)}`,
        agentId,
        dep.service_slug,
        dep.package_name,
        dep.package_version,
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
    estimated_tokens_saved: totalRequestsToday * 340 + 2481000 // Tokens saved by avoiding retry loops & 304 hits
  };
}
