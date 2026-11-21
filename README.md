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
| **Batch Preflight** | `POST /v1/preflight` | Agent sends a list of dependencies (`["stripe", "supabase", "resend"]`); gets single pass/degraded/block verdict. |
| **Delta Feed** | `GET /v1/changes?since={iso_ts}` | Returns only breaking API/SDK changes and deprecations since the agent's last checkpoint. |
| **MCP Tool** | `check_dependency_health` | MCP tool wrapper around `/v1/preflight` so IDE agents can check stack health mid-debugging. |
| **MCP Tool** | `lookup_breaking_changes` | MCP tool querying recent deprecations/schema diffs for a specific package or API. |
| **MCP Tool** | `get_service_status` | MCP tool returning real-time single-service health and agent action hint. |
| **MCP Tool** | `report_outage_signal` | MCP tool allowing agents to crowdsource observed 5xx spikes to detect early outages. |

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
Runs 14 automated unit and integration tests across the entire HTTP API, MCP tools, ETag caching, Good Citizen score tracking, and token budgets.

### 3. Docker Deployment
```bash
docker compose up -d
```

---

## 🗄️ Database Model (PostgreSQL & SQLite)

The schema is defined in [`src/db/schema.sql`](file:///Users/optimusprime/Projects/Bot-First-Outage/src/db/schema.sql):

- **`services`**: `slug` (PK), `name`, `category`, `current_status` (operational, degraded, outage), `etag`, `updated_at`.
- **`incidents`**: `id` (PK), `service_slug` (FK), `severity` (minor, major, critical), `affected_scope`, `agent_summary`, `agent_hint`, `started_at`, `resolved_at`.
- **`breaking_changes`**: `id` (PK), `service_slug` (FK), `version_or_date`, `change_type` (deprecation, schema_diff, rate_limit_change), `diff_summary`, `migration_hint`, `detected_at`.
- **`agent_clients`**: `id` (PK), `api_key_hash` (unique), `agent_name`, `operator_url`, `tier`, `daily_quota`, `good_citizen_score`.
- **`synthetic_probes`**: `id` (PK), `service_slug` (FK), `probe_target`, `status_code`, `latency_ms`, `is_healthy`, `checked_at`.
- **`outage_signals`**: `id` (PK), `service_slug` (FK), `endpoint`, `error_code`, `error_type`, `received_at`.

---

## 📜 License
MIT License. Crafted for the autonomous agent era.
