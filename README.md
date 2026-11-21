# AgentPulse — the status & breaking-change oracle for AI agents

> **AgentPulse tells AI agents, coding assistants, and CI/CD bots — in one tiny, token-budgeted call — whether the APIs and cloud services they depend on are up, degraded, or broken, whether a recent breaking change affects *their* stack, and exactly how to migrate when one does.**

Humans read status pages. Agents can't. When Stripe, OpenAI, or GitHub has an incident — or silently ships a breaking API change — an autonomous agent today has no machine-readable ground truth. It burns thousands of tokens in retry loops, hallucinates causes for "mysterious" 502s, and keeps calling endpoints whose parameters changed last Tuesday.

AgentPulse is the ground-truth layer built for those callers:

- **One call, < 150 tokens.** A status check returns a compact verdict — status, active incidents with scope and severity, and a short *agent hint* saying what to do (back off, defer, proceed) — instead of an HTML status page.
- **Real data, not samples.** Live ingestion polls vendor status pages and diffs published OpenAPI specs, so incidents and breaking changes are detected as they happen.
- **"Am I affected?" — answered.** Agents register the services their stack depends on (a *dependency manifest*), and AgentPulse answers per-agent: which of *your* services have an active incident or a breaking change in the last 90 days.
- **"How do I fix it?" — answered.** Every breaking change carries a generated **migration playbook**: ordered steps, before/after code examples, an effort estimate, and risk notes.
- **Push, not poll.** Signed webhooks and a live SSE stream deliver incidents and changes the moment they're recorded.
- **Built for bots, priced in tokens.** Zero-CAPTCHA programmatic onboarding, an MCP server for IDE agents, an `llms.txt` discovery document, and a *Good Citizen Protocol* that rewards ETag caching with higher quotas.

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

## Who it's for

| Caller | How they use AgentPulse |
| :--- | :--- |
| **Coding assistants** (Claude Code, Cursor, Windsurf, Cline) | MCP tools: check dependency health mid-debugging instead of guessing why a call fails; look up breaking changes before writing integration code. |
| **Autonomous agents** (task runners, support bots, data pipelines) | REST preflight before a run: proceed, degrade gracefully, or defer — based on the health of the exact services in their manifest. |
| **CI/CD pipelines** | A preflight gate that fails (or warns) a deploy when a critical dependency is down or shipped a breaking change overnight. |
| **Agent platforms & frameworks** | The JavaScript SDK or the OpenAPI document for automated tool ingestion; webhooks to fan alerts out to every hosted agent. |

## The problem, concretely

1. **Status pages are for humans.** They're HTML, JavaScript-heavy, and each vendor formats incidents differently. Scraping them is slow, brittle, and token-expensive.
2. **Breaking changes are announced for humans.** Changelogs and blog posts don't tell an agent which of *its* calls just broke, or what the replacement call looks like.
3. **Agents retry blindly.** Without a verdict, the rational agent strategy is "retry and see" — the most expensive possible way to discover an outage.

AgentPulse collapses all three into deterministic JSON with bounded size, stable schemas, and content hashes (ETags) so unchanged answers cost **zero tokens**.

---

## How it works

```mermaid
flowchart TD
    subgraph Ingestion ["1. Ingestion workers"]
        A1["Vendor status pages (Statuspage API)"]
        A2["OpenAPI spec diffs"]
        A3["Synthetic HTTP health probes"]
        A4["Crowdsourced agent telemetry (5xx spikes)"]
    end

    subgraph Engine ["2. Normalizer & diff engine"]
        B1["Deduplication (deterministic IDs)"]
        B2["Severity normalizer (minor / major / critical)"]
        B3["Breaking-change classifier (13 diff kinds)"]
        B4["Agent-hint synthesizer"]
        B5["SHA-256 ETag generator"]
    end

    subgraph Storage ["3. Storage (SQLite, WAL mode)"]
        C1["Services, incidents, breaking changes"]
        C2["Agent registry, manifests, quotas, Good Citizen scores"]
        C3["Spec snapshots & webhook delivery log"]
    end

    subgraph Edge ["4. Agent-facing surfaces"]
        D1["REST API (/v1/*)"]
        D2["MCP server (/mcp) — 5 tools"]
        D3["SSE stream (/v1/stream)"]
        D4["Webhooks (HMAC-signed)"]
        D5["Discovery: /llms.txt, /openapi.json, dashboard (/)"]
    end

    Ingestion --> Engine --> Storage --> Edge
```

### 1. Ingestion — where the data comes from

- **Statuspage poller** — every 5 minutes (configurable), polls the public Statuspage summary API of each tracked vendor and maps live incidents into AgentPulse's model. Incidents get deterministic IDs (`sp_<service>_<vendor incident id>`), so repeat polls are no-ops, and an incident that vanishes from a vendor's active list is resolved automatically.
- **OpenAPI spec-diff worker** — hourly, fetches tracked vendors' published OpenAPI specs, hashes them (SHA-256), and diffs any changed spec against the last snapshot. Thirteen kinds of breaking change are detected (removed path/operation/parameter, parameter becoming required, type/format changes, removed request/response properties, removed success responses, and more); non-breaking changes are logged, not stored. The first fetch of a spec is a baseline — no changes are emitted.
- **Synthetic probes** — periodic HTTP health checks per service.
- **Agent telemetry** — registered agents report observed 5xx spikes; enough corroborating signals surface an incident before any vendor posts one.

Both network workers fail gracefully: a failed fetch or parse is logged and skipped, never crashing the server.

**Tracked vendors** (status): OpenAI, Anthropic, GitHub, Vercel, Cloudflare, Supabase, Datadog, Resend, npm, Pinecone — plus Stripe and Twilio behind the same generic Statuspage mechanism (their feeds are polled when the payload shape matches). **Tracked specs** (diff): Stripe and GitHub publish JSON specs; OpenAI's canonical spec is YAML and is skipped until a JSON mirror is configured via `SPEC_SOURCES_JSON`.

### 2. The engine — turning noise into verdicts

Raw vendor data is normalized into one model: services, incidents (severity `minor` / `major` / `critical`, affected scope, timestamps), and breaking changes (kind, summary, provider migration hint). Every status payload gets a SHA-256 **ETag** over its content, which powers the Good Citizen Protocol below. Breaking changes are classified by kind, which later drives the migration playbook template.

### 3. Identity, manifests, and impact

Any agent can **register** with one POST — no CAPTCHA, no card — and receives an API key (`agp_live_...`). A registered agent can store a **dependency manifest**: the services its stack uses, with optional package/version pins.

With a manifest in place, AgentPulse answers the question status pages can't:

> **Affected** = a service in your manifest has an **active incident**, or a **breaking change detected within the last 90 days**.

That verdict appears in preflight responses, in the `scope=mine` changes feed, and in the MCP `get_my_impact` tool. *(Honest scope note: impact is computed at **service level**. Package/version pins are stored and echoed, but not yet matched against per-version change data.)*

### 4. Migration playbooks — from "it broke" to "here's the fix"

Every breaking change has a playbook at `GET /v1/changes/{id}/playbook`: ordered steps (review the provider's hint → find call sites → apply the fix → add a fallback for removals → add a regression test), before/after code examples **built only from the change's own fields** — replacement endpoints and new semantics are never invented; the playbook defers to the provider's recorded hint — plus an effort estimate (`low` / `medium` / `high`) and risk notes. Change feeds carry only a `playbook_url` pointer, keeping feed payloads inside the token budget.

### 5. The Good Citizen Protocol

Agents that cache politely get rewarded:

- Send `If-None-Match` with the ETag from your last response. If nothing changed, you get **304 Not Modified — 0 body bytes, 0 tokens** — and **+2 Good Citizen score**.
- 304s **never consume quota** and are served even when your quota is exhausted.
- Score **300** raises your daily quota from 1,000 to **2,500** calls; score **600** raises it to **5,000**.

### 6. Quotas & authentication

- Counted calls (1 unit each): authenticated status reads answered 200, preflight, manifest reads/writes, the `scope=mine` feed, telemetry, synthetic probes, and identified MCP tool calls. Unauthenticated public reads (status, services, incidents, changes, metrics, stream, discovery) are the product's discovery surface and stay open and uncounted.
- Exhaustion returns **429** with a `rate_limit` object, a `Retry-After` header (seconds to the UTC-midnight reset), and `X-RateLimit-Limit` / `-Remaining` / `-Reset` headers on authenticated responses.
- **All writes require an API key.** Telemetry and probes reject anonymous callers (401). Registration stays open — onboarding *is* the product.

### 7. Webhooks — push alerts

Subscribe a URL once; AgentPulse POSTs signed events as they happen: `incident.created`, `incident.resolved`, `change.detected`. Filters: an explicit `services` list wins; no list means all services (the filter is deliberately *not* intersected with your manifest — set it to your manifest's services if that's what you want). Payloads are HMAC-SHA256 signed (`X-AgentPulse-Signature`), delivered with a 5-second timeout and up to 3 attempts with backoff, and every attempt is recorded in a delivery log you can inspect. URLs must be `https://` (plain `http://` only for localhost, for development). The signing secret is shown **once**, in the create response.

---

## Interfaces at a glance

| Interface | Path / tool | Purpose |
| :--- | :--- | :--- |
| Discovery | `GET /llms.txt`, `GET /llms-full.txt` | Plain-text capability map for LLM/agent ingestion. |
| Discovery | `GET /openapi.json` | OpenAPI 3.1 schema for automated tool ingestion. |
| Dashboard | `GET /` | Human-facing web dashboard (service grid, incident feed, telemetry form). |
| Onboarding | `POST /v1/agents/register` | Zero-CAPTCHA registration → free-tier API key (1,000 req/day). |
| Status | `GET /v1/status/{service}` | Compact health verdict (< 150 tokens), ETag/304 supported. |
| Status | `GET /v1/services`, `GET /v1/incidents`, `GET /v1/metrics` | Catalog, incident list, aggregate metrics. |
| Preflight | `POST /v1/preflight` | Batch verdict for a list of services; manifest-aware impact for identified callers. |
| Changes | `GET /v1/changes?since=&service=&scope=mine` | Breaking-change delta feed; every change carries `playbook_url`. |
| Playbook | `GET /v1/changes/{id}/playbook` | Full migration playbook for one change (public, cacheable). |
| Manifest | `GET` / `PUT /v1/agents/me/dependencies` | Read / replace-all write of your dependency manifest (auth required). |
| Webhooks | `POST` / `GET /v1/agents/me/webhooks`, `DELETE /v1/agents/me/webhooks/{id}`, `GET /v1/agents/me/webhooks/{id}/deliveries` | Manage subscriptions and inspect delivery attempts (auth required). |
| Telemetry | `POST /v1/telemetry/report` | Report an observed outage signal (auth required). |
| Probes | `POST /v1/synthetic/probe` | Trigger one synthetic health probe (auth required). |
| Stream | `GET /v1/stream` | Server-Sent Events: live incident/change events. |
| MCP | `POST /mcp` | Stateless HTTP MCP server — tools below. |
| SDK | `sdk/` (`agentpulse-sdk`) | Zero-dependency JavaScript client. |

**MCP tools:** `check_dependency_health` (batch status), `get_service_status` (single service), `lookup_breaking_changes` (recent changes for a service), `get_my_impact` (manifest-wide affected verdicts), `report_outage_signal` (crowdsourced telemetry; identified caller required). Identity is read from the `Authorization: Bearer <api key>` header (an `api_key` tool argument is accepted as a fallback).

### MCP configuration

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "agentpulse": {
      "url": "https://agentpulse.onrender.com/mcp",
      "headers": { "Authorization": "Bearer agp_live_your_api_key_here" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add agentpulse https://agentpulse.onrender.com/mcp \
  --header "Authorization: Bearer agp_live_your_api_key_here"
```

### JavaScript SDK

```js
import { AgentPulseClient, AgentPulseError } from 'agentpulse-sdk';

const client = new AgentPulseClient({
  baseUrl: 'https://agentpulse.onrender.com',
  apiKey: process.env.AGENTPULSE_API_KEY,
});

const status   = await client.getStatus('stripe');            // ETag-cached; 304 returns the cached body
const verdict  = await client.preflight(['stripe', 'openai']);
await client.setDependencies([{ service: 'stripe', package: 'stripe', version: '14.5.0' }]);
const impact   = await client.getMyImpact();                  // manifest verdicts
const feed     = await client.getChanges({ scope: 'mine' });  // each change carries playbook_url
const playbook = await client.getPlaybook(feed.changes[0].id);
const hook     = await client.registerWebhook({ url: 'https://bots.example.com/agentpulse', services: ['stripe'] });
await client.reportOutage({ service: 'github', endpoint: 'POST /repos/o/r/pulls', error_code: 502 });
```

Zero dependencies (global `fetch`, Node ≥ 18); non-2xx responses throw `AgentPulseError` with `.status` and `.body`. See [`sdk/README.md`](sdk/README.md). *(Not yet published to npm — `cd sdk && npm publish` once the deployment is confirmed.)*

---

## Quickstart

**Prerequisites:** Node.js 22+. No `npm install` step — the server has **zero external dependencies** (it uses Node's built-in `node:sqlite`).

```bash
git clone https://github.com/Akshat-Srivastava-PS/AgentPulse.git
cd AgentPulse
npm start            # http://localhost:3000 — dashboard at /, API at /v1, MCP at /mcp
npm test             # 49 automated tests (see below)
docker compose up -d # or run the included Dockerfile
```

**Try it in 30 seconds:**

```bash
# 1. Register (open, no CAPTCHA) — save the api_key from the response
curl -X POST http://localhost:3000/v1/agents/register \
  -H "Content-Type: application/json" \
  -d '{"agent_name": "my-agent", "operator_url": "https://example.com"}'

# 2. Declare your stack
curl -X PUT http://localhost:3000/v1/agents/me/dependencies \
  -H "Authorization: Bearer agp_live_..." -H "Content-Type: application/json" \
  -d '{"dependencies": [{"service": "stripe"}, {"service": "openai"}]}'

# 3. Preflight before a run — impact verdicts included because you have a manifest
curl -X POST http://localhost:3000/v1/preflight \
  -H "Authorization: Bearer agp_live_..." -H "Content-Type: application/json" \
  -d '{"services": ["stripe", "openai"]}'
```

### Configuration

| Env var | Default | Purpose |
| :--- | :--- | :--- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address. |
| `DB_PATH` | `./agentpulse.sqlite` | SQLite database location. |
| `STATUSPAGE_POLL_INTERVAL_MS` | `300000` | Statuspage polling interval. |
| `SPEC_DIFF_POLL_INTERVAL_MS` | `3600000` | OpenAPI spec-diff interval. |
| `STATUSPAGE_SOURCES_JSON` | built-in registry | Override slug → Statuspage base URL map. |
| `SPEC_SOURCES_JSON` | built-in registry | Override slug → OpenAPI spec URL map. |
| `WEBHOOK_RETRY_DELAYS_MS` | `1000,5000` | Webhook backoff delays (attempts = delays + 1). |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Per-attempt webhook delivery timeout. |

### Tests

`npm test` runs **49 tests** covering: the HTTP API surface, MCP tools, ETag/304 behavior, Good Citizen scoring, token budgets; ingestion (spec-diff classification across all breaking kinds, Statuspage mapping — fully offline against fixtures); manifests (round-trip, validation, auth, preflight impact, `scope=mine` filtering, MCP `get_my_impact`); quota enforcement (429 + `Retry-After`, 304 exemption, rate-limit headers, write authentication); webhooks (CRUD, secret handling, HMAC-signed deliveries to a local receiver, filters, retries); and playbooks + the SDK exercised end-to-end against a real local HTTP server.

---

## Data model

Defined in `src/db/schema.sql` (SQLite, WAL mode):

- **`services`** — slug (PK), name, category, current status, ETag, updated_at.
- **`incidents`** — id (PK), service, severity, affected scope, agent summary + hint, started/resolved timestamps.
- **`breaking_changes`** — id (PK), service, change type, diff summary, migration hint, detected_at.
- **`spec_snapshots`** — service, spec URL, SHA-256 hash, raw spec; latest row per service/URL is the diff baseline.
- **`agent_clients`** — id (PK), API-key hash, agent name, operator URL, tier, daily quota, Good Citizen score.
- **`agent_dependencies`** — agent × service manifest rows (optional package/version pins), unique per pair.
- **`agent_webhooks`** — agent, URL, event/service filters, signing secret, active flag.
- **`webhook_deliveries`** — per-attempt delivery log: exact signed payload, status, attempts, last HTTP status/error.
- **`synthetic_probes`** / **`outage_signals`** — probe results and crowdsourced telemetry.

## Project layout

```
src/
  server.js          HTTP server, routing, quota/auth middleware
  db/                SQLite layer + schema.sql
  engine/            diff engine, severity/hints, playbooks, event bus
  workers/           statuspage poller, spec-diff, webhook dispatcher, probes
  discovery/         llms.txt + OpenAPI generators
sdk/                 agentpulse-sdk (zero-dependency JS client)
tests/               node:test suites (49 tests)
Dockerfile           node:22-alpine, non-root, healthcheck on /v1/metrics
```

## Status & honest limitations

AgentPulse is a working, fully tested implementation (49/49 tests) being deployed publicly for the first time. Known limitations, stated plainly:

- **Impact is service-level**, not version-level (see §3 above).
- **OpenAI's spec** is YAML-only today; its diff feed activates when a JSON mirror is configured.
- **Free-tier hosting sleeps when idle** and the local SQLite file resets on redeploy — fine for evaluation; a paid tier / external database is the production path.
- The **SDK is not on npm yet**; use it from `sdk/` until it's published.
- Seeded sample data ships as a fallback so a fresh install is explorable before the first real poll completes.

## License

MIT. Crafted for the autonomous agent era.
