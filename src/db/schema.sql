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
    daily_quota INT NOT NULL DEFAULT 1000,
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
