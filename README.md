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

> **Get it:** Live MCP endpoint — `https://agentpulse-43di.onrender.com/mcp` · Agent discovery — https://agentpulse-43di.onrender.com/llms.txt · Registry metadata — [`server.json`](server.json)

A status answer looks like this (illustrative example — live answers carry only real ingested data):

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
        B3["Breaking-change classifier (14 diff kinds)"]
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
- **OpenAPI spec-diff worker** — hourly, fetches tracked vendors' published OpenAPI specs, hashes them (SHA-256), and diffs any changed spec against the last snapshot. Fourteen kinds of breaking change are detected (removed path/operation/parameter, parameter becoming required, type/format changes, removed request/response properties — including nested fields, followed through $refs and array items — removed enum values, removed success responses, and more); non-breaking changes are logged, not stored. The first fetch of a spec is a baseline — no changes are emitted.
- **Synthetic probes** — periodic HTTP health checks per service.
- **Agent telemetry** — registered agents report observed 5xx spikes; enough corroborating signals surface an incident before any vendor posts one.

Both network workers fail gracefully: a failed fetch or parse is logged and skipped, never crashing the server.

**Tracked vendors** (status, 30 total): OpenAI, Anthropic, GitHub, AWS, Vercel, Cloudflare, Supabase, Datadog, Resend, npm, Pinecone, Twilio, Discord, Sentry, MongoDB Atlas, DigitalOcean, CircleCI, Bitbucket, Zoom, Cohere, Clerk, Render, Fly.io, Snowflake, Elastic Cloud, Postman, Shopify, ElevenLabs, Convex — plus Stripe behind the same generic Statuspage mechanism (its feed is polled when the payload shape matches). Every Statuspage-backed vendor above was added only after its live `<base>/api/v2/summary.json` feed was fetched and verified to return valid Statuspage summary JSON. **Tracked specs** (diff): Stripe and GitHub publish JSON specs; OpenAI's canonical spec is YAML and is skipped until a JSON mirror is configured via `SPEC_SOURCES_JSON`.

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
- The score is reputational only — the free-tier quota is a **flat 100 counted calls/day at every score**. Higher volume is a paid tier. (The caching benefit is the 304 exemption itself: unchanged answers are free and uncounted, so 100 counted calls stretch far.)

### 6. Quotas & authentication

- Counted calls (1 unit each): authenticated status reads answered 200, preflight, manifest reads/writes, the `scope=mine` feed, telemetry, synthetic probes, and identified MCP tool calls. Unauthenticated public reads (status, services, incidents, changes, metrics, stream, discovery) are the product's discovery surface and stay open and uncounted.
- Exhaustion returns **429** with a `rate_limit` object, a `Retry-After` header (seconds to the UTC-midnight reset), and `X-RateLimit-Limit` / `-Remaining` / `-Reset` headers on authenticated responses.
- **All writes require an API key.** Telemetry and probes reject anonymous callers (401). Registration stays open — onboarding *is* the product.

**Plans** (single source of truth: `src/engine/plans.js`):

| Plan | Tier id | Daily quota | Price |
| :--- | :--- | :--- | :--- |
| Free | `free_verified` | 100 counted calls/day | $0 |
| Pro | `pro` | 10,000 counted calls/day | $29/month |
| Team | `team` | 50,000 counted calls/day | $99/month |

Registration always lands on Free. An agent can read its current tier, usage, and the full catalog at `GET /v1/agents/me/plan` (auth required; the read itself is not counted). Paid plans activate one of two ways: automatically, when Stripe billing is configured (next section), or by the operator — the owner grants a plan with `PATCH /v1/admin/agents/{id}` (admin token required), which sets the agent's tier and daily quota from the catalog in one step.

### Billing — Stripe Payment Links (optional)

Checkout is via **Stripe Payment Links** — one link per paid plan, created in the Stripe dashboard with a recurring price and `subscription_data` metadata `tier=pro` / `tier=team`. Configuration is env-only (never hardcoded):

| Env var | Purpose |
| :--- | :--- |
| `STRIPE_PAYMENT_LINK_PRO` | Checkout URL for the Pro payment link. |
| `STRIPE_PAYMENT_LINK_TEAM` | Checkout URL for the Team payment link. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret (`whsec_...`) for the webhook endpoint below. |

How it works:

- `GET /v1/agents/me/plan` adds a per-plan `checkout_url`: the plan's payment link plus `?client_reference_id=<agent id>`, so the payment can be mapped back to the agent. (Free's `checkout_url` is always `null`; without the env vars, every `checkout_url` is `null` and the upgrade text keeps the operator wording.)
- Stripe sends events to **`POST /v1/billing/webhook`**. The endpoint verifies the `Stripe-Signature` header (HMAC-SHA256 over `<timestamp>.<raw body>`, 5-minute tolerance) against `STRIPE_WEBHOOK_SECRET` — when the secret is unset it answers `503 { "error": "billing_disabled" }`. It is not agent-authenticated, never quota-counted, and excluded from the request log. Event ids are recorded in `billing_events`, so redeliveries are acknowledged as duplicates without reprocessing.
- **Activation:** `checkout.session.completed` carries the `client_reference_id` (agent id) and the subscription id; `customer.subscription.created` / `updated` carries the tier in the subscription's metadata. The two halves are stored in `billing_links` keyed by subscription id, so **either arrival order works**: once both halves are present and the subscription is `active`/`trialing`, the agent's tier and daily quota are set from the plan catalog and its Stripe customer/subscription ids are stored on the agent row.
- **Deactivation:** `customer.subscription.deleted` — or an `updated` event with status `canceled`, `unpaid`, or `incomplete_expired` — downgrades the linked agent back to `free_verified` (100/day) and clears its stored subscription id. `invoice.payment_failed` is acknowledged only; Stripe's retries and the follow-up subscription events drive the outcome.
- **Without the env vars**, none of this is active: plans remain operator-granted via the admin API/page, exactly as before.

### 7. Webhooks — push alerts

Subscribe a URL once; AgentPulse POSTs signed events as they happen: `incident.created`, `incident.resolved`, `change.detected`. Filters: an explicit `services` list wins; no list means all services (the filter is deliberately *not* intersected with your manifest — set it to your manifest's services if that's what you want). Payloads are HMAC-SHA256 signed (`X-AgentPulse-Signature`), delivered with a 5-second timeout and up to 3 attempts with backoff, and every attempt is recorded in a delivery log you can inspect. URLs must be `https://` (plain `http://` only for localhost, for development). The signing secret is shown **once**, in the create response.

---

## Interfaces at a glance

| Interface | Path / tool | Purpose |
| :--- | :--- | :--- |
| Discovery | `GET /llms.txt`, `GET /llms-full.txt` | Plain-text capability map for LLM/agent ingestion. |
| Discovery | `GET /openapi.json` | OpenAPI 3.1 schema for automated tool ingestion. |
| Dashboard | `GET /` | Human-facing web dashboard (service grid, incident feed, telemetry form). |
| Onboarding | `POST /v1/agents/register` | Zero-CAPTCHA registration → free-tier API key (100 req/day). |
| Status | `GET /v1/status/{service}` | Compact health verdict (< 150 tokens), ETag/304 supported. |
| Status | `GET /v1/services`, `GET /v1/incidents`, `GET /v1/metrics` | Catalog, incident list, aggregate metrics. |
| Preflight | `POST /v1/preflight` | Batch verdict for a list of services; manifest-aware impact for identified callers. |
| Changes | `GET /v1/changes?since=&service=&scope=mine` | Breaking-change delta feed; every change carries `playbook_url`. |
| Playbook | `GET /v1/changes/{id}/playbook` | Full migration playbook for one change (public, cacheable). |
| Manifest | `GET` / `PUT /v1/agents/me/dependencies` | Read / replace-all write of your dependency manifest (auth required). |
| Plan | `GET /v1/agents/me/plan` | Your tier, quota usage, and the plan catalog with per-plan `checkout_url` (auth required; not counted). |
| Billing | `POST /v1/billing/webhook` | Stripe event receiver (signature-authenticated; activates/downgrades plans). |
| Webhooks | `POST` / `GET /v1/agents/me/webhooks`, `DELETE /v1/agents/me/webhooks/{id}`, `GET /v1/agents/me/webhooks/{id}/deliveries` | Manage subscriptions and inspect delivery attempts (auth required). |
| Telemetry | `POST /v1/telemetry/report` | Report an observed outage signal (auth required). |
| Probes | `POST /v1/synthetic/probe` | Trigger one synthetic health probe (auth required). |
| Stream | `GET /v1/stream` | Server-Sent Events: live incident/change events. |
| MCP | `POST /mcp` | Stateless HTTP MCP server — tools below. |
| SDK | `sdk/` (`@sriakshat/agentpulse`) | Zero-dependency JavaScript client. |

**MCP tools:** `check_dependency_health` (batch status), `get_service_status` (single service), `lookup_breaking_changes` (recent changes for a service), `get_my_impact` (manifest-wide affected verdicts), `report_outage_signal` (crowdsourced telemetry; identified caller required). Identity is read from the `Authorization: Bearer <api key>` header (an `api_key` tool argument is accepted as a fallback).

### MCP configuration

**Cursor** (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "agentpulse": {
      "url": "https://agentpulse-43di.onrender.com/mcp",
      "headers": { "Authorization": "Bearer agp_live_your_api_key_here" }
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add agentpulse https://agentpulse-43di.onrender.com/mcp \
  --header "Authorization: Bearer agp_live_your_api_key_here"
```

### JavaScript SDK

```js
import { AgentPulseClient, AgentPulseError } from '@sriakshat/agentpulse';

const client = new AgentPulseClient({
  baseUrl: 'https://agentpulse-43di.onrender.com',
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
  -d '{"dependencies": ["stripe", "openai"]}'
```

### Owner visibility

The owner can see **which agents are using the service and how many requests each one makes**. Every `/v1/*` request (except the admin endpoints themselves) and every MCP `tools/call` is written to a `request_log` table — identified calls with the agent's id and name, anonymous/public reads with a null agent — with a `counted` flag set at the exact place quota is consumed, so the log and the quota counter never disagree. Rows older than 7 days are pruned opportunistically.

Owner-only endpoints expose it:

| Endpoint | Returns |
| :--- | :--- |
| `GET /v1/admin/agents` | Fleet totals (agents, requests today, requests in the last 24h, counted requests today) plus one row per agent: requests today, quota remaining, Good Citizen score, lifetime logged requests, last-seen time, and its top 3 endpoints. |
| `GET /v1/admin/requests?limit=50` | The most recent request-log rows (limit clamped to 1–200). |
| `GET /v1/admin/plans` | The plan catalog from `src/engine/plans.js` — every tier with its daily quota and monthly price. The `/admin` page renders its Plans section and per-agent plan controls from this; the catalog is never hardcoded in the page. |
| `PATCH /v1/admin/agents/{id}` | Grant a plan: body `{ "tier": "pro" }` sets the agent's tier and daily quota from the plan catalog (`free_verified` / `pro` / `team`). Unknown tier → 400; unknown agent → 404. This is how paid plans are activated until a payment provider is connected. |

There is also a human page at **`GET /admin`**: paste the admin token (kept only in the tab's session storage) and it renders the totals, a **Plans** section (the full catalog with daily quotas and prices), the per-agent table, and a recent-requests feed, auto-refreshing every 30 seconds. Each agent row shows its current plan with a Free / Pro / Team select and an Apply button, so the owner can grant or change a plan in the page itself — Apply calls the `PATCH` endpoint above, and an un-applied selection survives the auto-refresh.

Access is controlled by the **`ADMIN_TOKEN`** environment variable: send it as `Authorization: Bearer <ADMIN_TOKEN>`. When `ADMIN_TOKEN` is unset or empty, the admin endpoints return `503 { "error": "admin_disabled" }` — the admin surface is off by default, and it is never advertised in `llms.txt` or the OpenAPI document agents read.

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
| `ADMIN_TOKEN` | *(unset)* | Bearer token for the owner-visibility endpoints (`/v1/admin/*`) and the `/admin` page. Unset = admin API disabled (503). |
| `STRIPE_WEBHOOK_SECRET` | *(unset)* | Stripe webhook signing secret for `POST /v1/billing/webhook`. Unset = billing webhook disabled (503). |
| `STRIPE_PAYMENT_LINK_PRO` / `STRIPE_PAYMENT_LINK_TEAM` | *(unset)* | Stripe Payment Link checkout URLs served as per-agent `checkout_url`s by the plan endpoint. Unset = plans stay operator-granted. |

### Tests

`npm test` runs **49 tests** covering: the HTTP API surface, MCP tools, ETag/304 behavior, Good Citizen scoring, token budgets; ingestion (spec-diff classification across all breaking kinds, Statuspage mapping — fully offline against fixtures); manifests (round-trip, validation, auth, preflight impact, `scope=mine` filtering, MCP `get_my_impact`); quota enforcement (429 + `Retry-After`, 304 exemption, rate-limit headers, write authentication); webhooks (CRUD, secret handling, HMAC-signed deliveries to a local receiver, filters, retries); and playbooks + the SDK exercised end-to-end against a real local HTTP server.

---

## Data model

Defined in `src/db/schema.sql` (SQLite, WAL mode):

- **`services`** — slug (PK), name, category, current status, ETag, updated_at.
- **`incidents`** — id (PK), service, severity, affected scope, agent summary + hint, started/resolved timestamps.
- **`breaking_changes`** — id (PK), service, change type, diff summary, migration hint, detected_at.
- **`spec_snapshots`** — service, spec URL, SHA-256 hash, raw spec; latest row per service/URL is the diff baseline.
- **`agent_clients`** — id (PK), API-key hash, agent name, operator URL, tier, daily quota, Good Citizen score, Stripe customer/subscription ids (set by billing activation).
- **`agent_dependencies`** — agent × service manifest rows (optional package/version pins), unique per pair.
- **`agent_webhooks`** — agent, URL, event/service filters, signing secret, active flag.
- **`webhook_deliveries`** — per-attempt delivery log: exact signed payload, status, attempts, last HTTP status/error.
- **`synthetic_probes`** / **`outage_signals`** — probe results and crowdsourced telemetry.
- **`request_log`** — one row per API/MCP call for owner visibility: agent (null when anonymous), method, path, status, quota-counted flag, timestamp; pruned to 7 days.
- **`billing_links`** — subscription id (PK) → Stripe customer id, tier, agent id: the two event halves of a paid plan, joined by the webhook.
- **`billing_events`** — processed Stripe event ids (PK) + received-at timestamp, for webhook dedupe.

## Project layout

```
src/
  server.js          HTTP server, routing, quota/auth middleware
  db/                SQLite layer + schema.sql
  engine/            diff engine, severity/hints, playbooks, event bus
  workers/           statuspage poller, spec-diff, webhook dispatcher, probes
  discovery/         llms.txt + OpenAPI generators
sdk/                 @sriakshat/agentpulse (zero-dependency JS client)
tests/               node:test suites (49 tests)
Dockerfile           node:22-alpine, non-root, healthcheck on /v1/metrics
```

## Status & honest limitations

AgentPulse is a working, fully tested implementation (49/49 tests) being deployed publicly for the first time. Known limitations, stated plainly:

- **Impact is service-level**, not version-level (see §3 above).
- **OpenAI's spec** is YAML-only today; its diff feed activates when a JSON mirror is configured.
- **Free-tier hosting sleeps when idle** and the local SQLite file resets on redeploy — fine for evaluation; a paid tier / external database is the production path.
- The **SDK is not on npm yet**; use it from `sdk/` until it's published.
- **No sample data, ever.** The service serves only live-ingested data: a fresh install's catalog starts with zero incidents and zero breaking changes, and the first Statuspage poll (within one poll interval — 5 minutes by default) populates real incidents, while the spec-diff worker adds real breaking changes as vendor specs change. Until the first poll lands, services honestly report `operational` with empty incident lists.

## License

MIT. Crafted for the autonomous agent era.
