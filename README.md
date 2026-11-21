# AgentPulse: Live API & Cloud Status / Breaking-Change Oracle

> **A real-time ground-truth hub and breaking-change oracle built for autonomous AI agents, coding assistants (Claude Code, Cursor, Windsurf, Cline), and CI/CD bots.**

Coding and DevOps agents constantly burn thousands of tokens in futile retry loops debugging "mysterious" 502s, auth timeouts, or silently deprecated SDK parameters. AgentPulse answers with **one sub-50ms token-optimized call (< 150 tokens)**:

```json
{
  "service": "stripe",
  "status": "degraded",
  "updated_at": "2026-11-20T22:55:00Z",
  "active_incidents": [
    {
      "id": "inc_9821",
      "severity": "major",
      "scope": "POST /v1/payment_intents (us-east-1)",
      "summary": "Elevated 502 error rate (~18%) starting 22:41 UTC.",
      "agent_hint": "Use exponential backoff (min 15s) or defer non-urgent retries."
    }
  ],
  "recent_breaking_changes": []
}
```

---

## 🏛️ System Architecture

```mermaid
flowchart TD
    subgraph Ingestion ["1. Ingestion Workers (Every 60s)"]
        A1["Vendor Status APIs (Stripe, OpenAI, GitHub, AWS, etc.)"]
        A2["OpenAPI Spec Diffs & SDK Changelogs"]
        A3["Synthetic HTTP Health Probes"]
        A4["Crowdsourced Agent Telemetry (5xx spikes)"]
    end

    subgraph Engine ["2. Normalizer & Diff Engine"]
        B1["Deduplication & Anomaly Scorer"]
        B2["Severity Normalizer (minor / major / critical)"]
        B3["Compact Agent Hint Synthesizer (< 120 tokens/event)"]
        B4["Deterministic SHA-256 ETag Generator"]
    end

    subgraph Storage ["3. Storage & Persistence"]
        C1["PostgreSQL / SQLite WAL Engine"]
        C2["ETag Cache & Good Citizen Score Registry"]
        C3["Event History & Breaking Changes Delta Log"]
    end

    subgraph Edge ["4. Edge API Gateway & MCP"]
        D1["GET /llms.txt & /llms-full.txt (Discovery)"]
        D2["GET /openapi.json (OpenAPI 3.1.0)"]
        D3["Stateless HTTP MCP Server (/mcp)"]
        D4["REST JSON Gateway (/v1/*)"]
        D5["Live SSE Event Stream (/v1/stream)"]
        D6["Cyber-Terminal Web Dashboard (/)"]
    end

    Ingestion --> Engine
    Engine --> Storage
    Storage --> Edge
```

---

## ⚡ Core Value Proposition for AI Agents

1. **Immediate ROI Per Call**: Preempts multi-minute hallucinated retry loops by giving coding agents a clear verdict before execution.
2. **Zero Scraping Overhead**: Replaces messy HTML/JS status pages and noisy RSS feeds with compact, deterministic JSON schemas.
3. **Token-Budgeted Guarantees**: All status payloads are strictly bounded to **< 150 tokens** to prevent context contamination.
4. **Good Citizen Protocol (ETag 304 Caching)**: Supports `If-None-Match`. When dependencies are stable, the server returns **304 Not Modified with 0 body bytes**, consuming **0 tokens** and rewarding the agent with higher daily quotas (+2 Good Citizen score).
5. **Zero-CAPTCHA Programmatic Onboarding**: Designed specifically for bots—no captchas or credit cards required.

---

## 🔌 Core Endpoints & MCP Tools

| Interface | Path / Tool Name | Purpose & Bot Benefit |
| :--- | :--- | :--- |
| **Discovery** | `GET /llms.txt` | Plain-text Markdown map of capabilities, rate limits, and endpoints adhering to the `llms.txt` standard. |
| **Discovery** | `GET /openapi.json` | Strict OpenAPI 3.1 schema for automated tool ingestion by agent frameworks. |
| **Bot Onboarding** | `POST /v1/agents/register` | Zero-CAPTCHA self-serve registration returning free-tier API key (1,000 req/day). |
| **Core Query** | `GET /v1/status/{service}` | Returns health, active incidents, affected regions, and agent hint in < 150 tokens. Supports `If-None-Match` (304). |
| **Batch Preflight** | `POST /v1/preflight` | Agent sends a list of dependencies (`["stripe", "supabase", "resend"]`); gets single pass/degraded/block verdict. Authenticated callers with a manifest also get per-service `impact` (affected) verdicts. |
| **Delta Feed** | `GET /v1/changes?since={iso_ts}` | Returns only breaking API/SDK changes and deprecations since the agent's last checkpoint. `?scope=mine` (auth) restricts it to the caller's manifest services. |
| **My Manifest** | `PUT /v1/agents/me/dependencies` | Authenticated replace-all write of the caller's dependency manifest (`{service, package?, version?}` per entry; slugs validated). |
| **My Manifest** | `GET /v1/agents/me/dependencies` | Returns the caller's stored dependency manifest. |
| **MCP Tool** | `check_dependency_health` | MCP tool wrapper around `/v1/preflight` so IDE agents can check stack health mid-debugging. |
| **MCP Tool** | `get_my_impact` | Returns "affected code" verdicts for every service in the calling agent's stored manifest (identity via `Authorization: Bearer` header or `api_key` argument). |
| **MCP Tool** | `lookup_breaking_changes` | MCP tool querying recent deprecations/schema diffs for a specific package or API. |
| **MCP Tool** | `get_service_status` | MCP tool returning real-time single-service health and agent action hint. |
| **MCP Tool** | `report_outage_signal` | MCP tool allowing agents to crowdsource observed 5xx spikes to detect early outages. Requires the caller's API key since Step 3. |
| **Telemetry** | `POST /v1/telemetry/report` | REST crowdsourced outage signal. API key required since Step 3 (401 anonymously); counts toward daily quota. |
| **Probe Trigger** | `POST /v1/synthetic/probe` | Manually runs one synthetic health probe. API key required since Step 3; counts toward daily quota. |

---

## 🛠️ MCP Configuration (Cursor & Claude Code)

### Cursor (`.cursor/mcp.json`)
```json
{
  "mcpServers": {
    "agentpulse": {
      "url": "https://agentpulse.dev/mcp",
      "headers": {
        "Authorization": "Bearer agp_live_your_api_key_here"
      }
    }
  }
}
```

### Claude Code CLI
```bash
claude mcp add agentpulse https://agentpulse.dev/mcp \
  --header "Authorization: Bearer agp_live_your_api_key_here"
```

### Stateless HTTP Edge Routing
AgentPulse supports the stateless HTTP MCP specification where each request is self-contained and routable via headers without sticky sessions:
```bash
curl -X POST "http://localhost:3000/mcp" \
  -H "Mcp-Method: tools/call" \
  -H "Mcp-Name: check_dependency_health" \
  -H "Content-Type: application/json" \
  -d '{"dependencies": ["stripe", "openai", "aws"]}'
```

---

## 🚀 Quickstart & Development

### Prerequisites
- Node.js 22+ (Zero external npm dependencies needed!)

### 1. Run Locally
```bash
# Clone the repository
git clone https://github.com/myorg/agentpulse.git
cd agentpulse

# Start the server (runs on port 3000 by default)
npm start
```

Visit **`http://localhost:3000`** in your browser to open the Cyber-Terminal Web Dashboard.

### 2. Run Test Suite
```bash
npm test
```
Runs 33 automated unit and integration tests across the entire HTTP API, MCP tools, ETag caching, Good Citizen score tracking, token budgets, the Step 1 ingestion workers (spec-diff classification and Statuspage mapping, fully offline against fixtures), the Step 2 dependency manifests (round-trip, validation, auth, preflight impact verdicts, `scope=mine` filtering, MCP `get_my_impact`), and Step 3 quota enforcement & auth hardening (429 + `Retry-After`, 304 quota exemption, write authentication, demo-key removal, rate-limit headers, MCP quota).

### 3. Docker Deployment
```bash
docker compose up -d
```

---

## 📥 Real Ingestion (Step 1)

Alongside the synthetic probes, two real ingestion workers run on the scheduler (started by `startIngestionWorker` in `src/server.js`):

- **Statuspage poller** (`src/workers/statuspage.js`): polls `<base>/api/v2/summary.json` for every vendor with an Atlassian Statuspage (OpenAI, Anthropic, GitHub, Supabase, Vercel, Cloudflare, Datadog, Resend, npm, Pinecone; Stripe and Twilio are registered behind the same generic mechanism). Live incidents are mapped into the `incidents` model with the existing severity normalizer and agent-hint generator, attributed `source: 'statuspage'`. **Dedupe:** each incident is stored under the deterministic id `sp_<service>_<statuspage_incident_id>` — repeat polls are no-ops, and an incident that disappears from the vendor's active list is resolved locally.
- **OpenAPI spec-diff worker** (`src/workers/specDiff.js`): fetches tracked JSON specs (Stripe and GitHub publish theirs on GitHub raw; OpenAI's canonical spec is YAML and is skipped until a JSON mirror is configured), SHA-256 hashes them, and diffs changed specs against the last snapshot in the new `spec_snapshots` table. Breaking changes are inserted as real `breaking_changes` rows (`change_type: 'schema_diff'`, deterministic ids, source URL in the summary). The first fetch of a spec is a baseline and produces no changes.

Both workers fail gracefully offline: a failed fetch or parse is logged and skipped, never crashing the server. Seeded sample data remains as fallback.

| Env var | Default | Purpose |
| :--- | :--- | :--- |
| `STATUSPAGE_POLL_INTERVAL_MS` | `300000` (5 min) | Statuspage polling interval |
| `SPEC_DIFF_POLL_INTERVAL_MS` | `3600000` (1 h) | Spec-diff polling interval |
| `STATUSPAGE_SOURCES_JSON` | built-in registry | Override slug → Statuspage base URL map |
| `SPEC_SOURCES_JSON` | built-in registry | Override slug → OpenAPI spec URL map |

---

## 📦 Dependency Manifests & Affected Answers (Step 2)

Until Step 2, AgentPulse could only say "Stripe is degraded" — not whether *your* code is affected. Now every registered agent can store a **dependency manifest**: the services its stack actually depends on, with optional package/version pins.

```bash
# Store (replace-all) — slugs validated against the catalog, unknown slug → 400 naming it
curl -X PUT https://agentpulse.dev/v1/agents/me/dependencies \
  -H "Authorization: Bearer agp_live_..." \
  -H "Content-Type: application/json" \
  -d '{"dependencies": [
        {"service": "stripe", "package": "stripe", "version": "14.5.0"},
        {"service": "openai"}
      ]}'

# Read it back
curl https://agentpulse.dev/v1/agents/me/dependencies \
  -H "Authorization: Bearer agp_live_..."
```

Both endpoints require the agent's API key (401 otherwise). Manifests live in the new `agent_dependencies` table (one row per agent+service, `UNIQUE(agent_id, service_slug)`).

With a manifest in place, three surfaces answer "is my code affected?":

- **Preflight** — `POST /v1/preflight` with your key adds a compact verdict to each requested service that is in your manifest, plus a top-level `affected_count`:
  ```json
  "impact": {
    "affected": true,
    "incident_ids": ["inc_9821"],
    "change_ids": [],
    "reason": "Active major incident inc_9821 on stripe: Elevated 502 error rate (~18%)..."
  }
  ```
  A service is **affected** iff it has any active incident **or** any breaking change detected in the last **90 days**. Unauthenticated and manifest-less calls return exactly the pre-Step-2 payload.
- **Delta feed** — `GET /v1/changes?scope=mine` returns only breaking changes for your manifest services (401 without a key). Composes with the existing `since`/`service` filters.
- **MCP** — the new `get_my_impact` tool returns verdicts for your whole manifest in one call. Identity is resolved from the same `Authorization: Bearer` header the REST layer and the documented MCP client config already use; an `api_key` tool argument is accepted as a fallback for clients that cannot set headers. `check_dependency_health` is manifest-aware for identified callers too.

---

## 🚦 Quotas & Auth (Step 3)

Through Step 2, usage was counted but never enforced, telemetry accepted anonymous writes, and every fresh install seeded a well-known demo API key. Step 3 closes all three gaps.

### Quota enforcement

Daily quotas (free tier **1,000/day**, Good Citizen upgrades to **2,500** at score 300 and **5,000** at score 600, resetting at **UTC midnight**) are now enforced for identified agents on both REST and MCP:

- **Counted** (1 unit each): authenticated `GET /v1/status/{service}` answered 200, `POST /v1/preflight`, manifest `GET`/`PUT /v1/agents/me/dependencies`, `GET /v1/changes?scope=mine`, `POST /v1/telemetry/report`, `POST /v1/synthetic/probe`, and identified MCP `tools/call` executions.
- **Never counted**: responses answered **304** (the Good Citizen incentive — a 304 still earns its +2 score and is served even when the quota is exhausted), and all **unauthenticated public reads** (`/v1/status/*`, `/v1/services`, `/v1/incidents`, `/v1/changes`, `/v1/metrics`, `/v1/stream`, discovery documents, anonymous MCP read tools). Public status reads are the product's discovery surface and stay open.
- **Exhaustion** returns `429` in the standard error format plus a `rate_limit` object, a `Retry-After` header (seconds to the UTC-midnight reset), and the rate-limit headers below. MCP callers get HTTP 429 with a JSON-RPC error (`code: -32029`) instead of a tool result.
- **Headers**: every authenticated response carries `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and `X-RateLimit-Reset` (Unix epoch seconds of the next reset) — the headers the OpenAPI document always advertised are now real.

### Write authentication

Every mutating route now requires a valid `Authorization: Bearer agp_live_...` key, so each write is attributable to a registered agent:

| Route | Before Step 3 | Now |
| :--- | :--- | :--- |
| `POST /v1/agents/register` | open | **open** (zero-CAPTCHA onboarding is the product) |
| `PUT /v1/agents/me/dependencies` | auth (Step 2) | auth + quota |
| `POST /v1/telemetry/report` | anonymous accepted | **auth required** (401 anonymously) |
| `POST /v1/synthetic/probe` | anonymous accepted | **auth required** (401 anonymously) |
| MCP `report_outage_signal` | anonymous accepted | **identified caller required** (Authorization header or `api_key` argument — the same identity path `get_my_impact` uses since Step 2) |

### Demo key removal

Fresh databases no longer seed the demo agent (`agent_demo_01` / `agp_live_demo...`) — a predictable credential in every install is a standing backdoor. Register a real agent via `POST /v1/agents/register` instead.

> **Existing databases:** no destructive migration is run automatically; the demo row is simply left in place. To retire it from an existing install, run once against that database:
> ```sql
> DELETE FROM agent_clients WHERE id = 'agent_demo_01';
> ```
> (Its manifest rows, if any, are removed by the `ON DELETE CASCADE` foreign key.)

---

## 🗄️ Database Model (PostgreSQL & SQLite)

The schema is defined in [`src/db/schema.sql`](file:///Users/optimusprime/Projects/Bot-First-Outage/src/db/schema.sql):

- **`services`**: `slug` (PK), `name`, `category`, `current_status` (operational, degraded, outage), `etag`, `updated_at`.
- **`incidents`**: `id` (PK), `service_slug` (FK), `severity` (minor, major, critical), `affected_scope`, `agent_summary`, `agent_hint`, `started_at`, `resolved_at`.
- **`breaking_changes`**: `id` (PK), `service_slug` (FK), `version_or_date`, `change_type` (deprecation, schema_diff, rate_limit_change), `diff_summary`, `migration_hint`, `detected_at`.
- **`agent_clients`**: `id` (PK), `api_key_hash` (unique), `agent_name`, `operator_url`, `tier`, `daily_quota`, `good_citizen_score`.
- **`synthetic_probes`**: `id` (PK), `service_slug` (FK), `probe_target`, `status_code`, `latency_ms`, `is_healthy`, `checked_at`.
- **`outage_signals`**: `id` (PK), `service_slug` (FK), `endpoint`, `error_code`, `error_type`, `received_at`.
- **`spec_snapshots`**: `id` (PK), `service_slug` (FK), `spec_url`, `spec_hash` (SHA-256 of the raw spec), `spec_json` (raw spec), `fetched_at`. Latest row per service/URL is the diff baseline.
- **`agent_dependencies`**: `id` (PK), `agent_id` (FK → `agent_clients`), `service_slug` (FK), `package_name` (nullable), `package_version` (nullable), `created_at`, `updated_at`. Unique per (agent, service); written with replace-all semantics by `PUT /v1/agents/me/dependencies`.

---

## 📜 License
MIT License. Crafted for the autonomous agent era.
