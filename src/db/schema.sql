-- AgentPulse Minimal Data Model (PostgreSQL 14+)
-- Production Schema for Live API & Cloud Status / Breaking-Change Oracle

-- Enable UUID extension if on PostgreSQL
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Services Table
CREATE TABLE IF NOT EXISTS services (
    slug VARCHAR(64) PRIMARY KEY,
    name VARCHAR(128) NOT NULL,
    category VARCHAR(64) NOT NULL, -- e.g., payments, ai_models, cloud_infra, database, hosting
    current_status VARCHAR(32) NOT NULL DEFAULT 'operational', -- operational, degraded, outage
    etag VARCHAR(64) NOT NULL,
    provider_status_page VARCHAR(255),
    healthcheck_url VARCHAR(255),
    latency_ms REAL DEFAULT 0,
    uptime_percentage REAL DEFAULT 99.95,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_services_status ON services(current_status);
CREATE INDEX IF NOT EXISTS idx_services_category ON services(category);

-- 2. Incidents Table
CREATE TABLE IF NOT EXISTS incidents (
    id VARCHAR(64) PRIMARY KEY,
    service_slug VARCHAR(64) NOT NULL REFERENCES services(slug) ON DELETE CASCADE,
    severity VARCHAR(32) NOT NULL DEFAULT 'minor', -- minor, major, critical
    affected_scope VARCHAR(255) NOT NULL, -- e.g., POST /v1/payment_intents (us-east-1)
    agent_summary VARCHAR(280) NOT NULL, -- Compact summary under 120 tokens
    agent_hint VARCHAR(280) NOT NULL, -- Prescriptive agent instruction
    started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMPTZ -- Nullable when incident is ongoing
);

CREATE INDEX IF NOT EXISTS idx_incidents_service ON incidents(service_slug);
CREATE INDEX IF NOT EXISTS idx_incidents_active ON incidents(service_slug) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_incidents_started ON incidents(started_at DESC);

-- 3. Breaking Changes Table
CREATE TABLE IF NOT EXISTS breaking_changes (
    id VARCHAR(64) PRIMARY KEY,
    service_slug VARCHAR(64) NOT NULL REFERENCES services(slug) ON DELETE CASCADE,
    version_or_date VARCHAR(64) NOT NULL, -- e.g., 2026-11-01, v4.0.0
    change_type VARCHAR(64) NOT NULL, -- deprecation, schema_diff, rate_limit_change
    kind VARCHAR(64), -- structured diff kind (e.g. removed_response_property); NULL on legacy rows
    location TEXT, -- structured diff location (e.g. 'GET /v1/charges response property customer.email'); NULL on legacy rows
    diff_summary TEXT NOT NULL,
    migration_hint TEXT NOT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_breaking_changes_service ON breaking_changes(service_slug);
CREATE INDEX IF NOT EXISTS idx_breaking_changes_detected ON breaking_changes(detected_at DESC);

-- 4. Agent Clients Table (Zero-CAPTCHA Self-Serve Onboarding)
CREATE TABLE IF NOT EXISTS agent_clients (
    id VARCHAR(64) PRIMARY KEY,
    api_key_hash VARCHAR(128) UNIQUE NOT NULL,
    agent_name VARCHAR(128) NOT NULL,
    operator_url VARCHAR(255) NOT NULL,
    tier VARCHAR(32) NOT NULL DEFAULT 'free_verified', -- free_verified, pro, autonomous_fleet
    daily_quota INT NOT NULL DEFAULT 100,
    good_citizen_score INT NOT NULL DEFAULT 100, -- Increases when bot respects ETag & Retry-After
    requests_today INT NOT NULL DEFAULT 0,
    last_reset_date VARCHAR(10) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_clients_key_hash ON agent_clients(api_key_hash);

-- 5. Synthetic Probes History
CREATE TABLE IF NOT EXISTS synthetic_probes (
    id VARCHAR(64) PRIMARY KEY,
    service_slug VARCHAR(64) NOT NULL REFERENCES services(slug) ON DELETE CASCADE,
    probe_target VARCHAR(255) NOT NULL,
    status_code INT NOT NULL,
    latency_ms REAL NOT NULL,
    is_healthy BOOLEAN NOT NULL DEFAULT TRUE,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_probes_service_checked ON synthetic_probes(service_slug, checked_at DESC);

-- 6. Crowdsourced Outage Signals (Agent Telemetry)
CREATE TABLE IF NOT EXISTS outage_signals (
    id VARCHAR(64) PRIMARY KEY,
    service_slug VARCHAR(64) NOT NULL REFERENCES services(slug) ON DELETE CASCADE,
    agent_id VARCHAR(64) REFERENCES agent_clients(id),
    endpoint VARCHAR(255) NOT NULL,
    error_code INT NOT NULL,
    error_type VARCHAR(64),
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_signals_service_received ON outage_signals(service_slug, received_at DESC);

-- 7. OpenAPI Spec Snapshots (Step 1: real spec-diff ingestion)
-- One row per fetch of a tracked spec; the latest row per (service, URL) is the
-- baseline the next fetch is diffed against. The runtime SQLite schema in
-- src/db/index.js creates this with CREATE TABLE IF NOT EXISTS, so existing
-- databases gain the table on next boot without a destructive migration.
CREATE TABLE IF NOT EXISTS spec_snapshots (
    id VARCHAR(64) PRIMARY KEY,
    service_slug VARCHAR(64) NOT NULL REFERENCES services(slug) ON DELETE CASCADE,
    spec_url VARCHAR(512) NOT NULL,
    spec_hash VARCHAR(64) NOT NULL, -- SHA-256 of the raw spec document
    spec_json TEXT NOT NULL, -- Raw spec document as fetched
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_spec_snapshots_lookup ON spec_snapshots(service_slug, spec_url, fetched_at DESC);

-- Note on external incidents: Statuspage-sourced incidents keep their
-- deterministic primary key `sp_<service_slug>_<statuspage_incident_id>` in the
-- incidents table above; that key is the dedupe mechanism (no extra column).

-- 8. Agent Dependency Manifests (Step 2: per-agent "affected code" answers)
-- One row per (agent, service) the agent depends on. Written with replace-all
-- semantics via PUT /v1/agents/me/dependencies. package_name / package_version
-- are nullable: an agent may track a service without pinning an SDK package.
CREATE TABLE IF NOT EXISTS agent_dependencies (
    id VARCHAR(64) PRIMARY KEY,
    agent_id VARCHAR(64) NOT NULL REFERENCES agent_clients(id) ON DELETE CASCADE,
    service_slug VARCHAR(64) NOT NULL REFERENCES services(slug) ON DELETE CASCADE,
    package_name VARCHAR(255), -- e.g. npm/pip package name ("stripe", "openai")
    package_version VARCHAR(64), -- e.g. "14.5.0"
    endpoints TEXT, -- JSON array of declared endpoints ("GET /v1/charges" or "/v1/charges"); NULL = service-level relevance
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (agent_id, service_slug)
);

CREATE INDEX IF NOT EXISTS idx_agent_dependencies_agent ON agent_dependencies(agent_id);

-- 9. Agent Webhooks (Step 4: webhook alerts)
-- One row per subscription. `events` is a JSON array subset of
-- ('incident.created', 'incident.resolved', 'change.detected'); `services`
-- is a JSON array of service slugs, NULL meaning all services. `secret` is
-- the HMAC-SHA256 signing key for X-AgentPulse-Signature; it is returned
-- exactly once, in the create response, and stored in plaintext because it
-- must be recoverable to sign every delivery. The runtime SQLite schema in
-- src/db/index.js creates these tables with CREATE TABLE IF NOT EXISTS.
CREATE TABLE IF NOT EXISTS agent_webhooks (
    id VARCHAR(64) PRIMARY KEY,
    agent_id VARCHAR(64) NOT NULL REFERENCES agent_clients(id) ON DELETE CASCADE,
    url VARCHAR(1024) NOT NULL,
    events TEXT NOT NULL, -- JSON array of event types
    services TEXT, -- JSON array of service slugs; NULL = all services
    secret VARCHAR(128) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_agent_webhooks_agent ON agent_webhooks(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_webhooks_active ON agent_webhooks(active);

-- 10. Webhook Deliveries (Step 4)
-- One row per (webhook, event) delivery, updated in place across retries.
-- `payload` stores the exact JSON bytes that were signed and sent.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id VARCHAR(64) PRIMARY KEY,
    webhook_id VARCHAR(64) NOT NULL REFERENCES agent_webhooks(id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    payload TEXT NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending, delivered, failed
    attempts INT NOT NULL DEFAULT 0,
    last_status_code INT,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    delivered_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

-- 11. Request Log (owner visibility)
-- One row per /v1/* request (except /v1/admin/*) and per MCP tools/call.
-- agent_id / agent_name are NULL for anonymous and public reads; `counted`
-- is 1 only when the call consumed daily quota (set by recordAgentUsage at
-- the same place quota is consumed). Rows older than 7 days are pruned
-- opportunistically on insert. In the runtime SQLite schema (src/db/index.js)
-- `id` is INTEGER PRIMARY KEY AUTOINCREMENT and `counted` is INTEGER 0/1.
CREATE TABLE IF NOT EXISTS request_log (
    id INTEGER PRIMARY KEY,
    agent_id VARCHAR(64), -- NULL = anonymous / public read
    agent_name VARCHAR(128),
    method VARCHAR(8) NOT NULL,
    path VARCHAR(512) NOT NULL, -- actual request path, e.g. /v1/status/stripe
    status_code INT NOT NULL,
    counted BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_request_log_created ON request_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_log_agent ON request_log(agent_id, created_at DESC);
