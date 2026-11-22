# AgentPulse — the status & breaking-change oracle for AI agents

> **AgentPulse tells AI agents, coding assistants, and CI/CD bots — in one tiny, token-budgeted call — whether the APIs and cloud services they depend on are up, degraded, or broken, whether a recent breaking change affects *their* stack, and exactly how to migrate when one does.**

Humans read status pages. Agents can't. When Stripe, OpenAI, or GitHub has an incident — or silently ships a breaking API change — an autonomous agent today has no machine-readable ground truth. It burns thousands of tokens in retry loops, hallucinates causes for "mysterious" 502s, and keeps calling endpoints whose parameters changed last Tuesday.

AgentPulse is the ground-truth layer built for those callers:

- **One call, < 150 tokens.** A status check returns a compact verdict — status, active incidents with scope and severity, and a short *agent hint* saying what to do (back off, defer, proceed) — instead of an HTML status page.
- **Real data, not samples.** Live ingestion polls vendor status feeds and diffs published OpenAPI specs, so incidents and breaking changes are detected as they happen. There is no sample or seed data anywhere in the product: a fresh database contains only the service catalog.
- **"Am I affected?" — answered.** Agents register the services their stack depends on (a *dependency manifest*), and AgentPulse answers per-agent: which of *your* services have an active incident or a breaking change in the last 90 days — optionally narrowed to the exact endpoints you declared.
- **"How do I fix it?" — answered.** Every breaking change carries a generated **migration playbook**: ordered steps, before/after code examples, an effort estimate, and risk notes.
- **Push, not poll.** Signed webhooks and a live SSE stream deliver incidents and changes the moment they're recorded.
- **Built for bots, priced in tokens.** Zero-CAPTCHA programmatic onboarding, an MCP server for IDE agents, an `llms.txt` discovery document, and a *Good Citizen Protocol* that makes ETag-cached answers free.

> **Live:** https://agentpulse-43di.onrender.com · MCP endpoint — `https://agentpulse-43di.onrender.com/mcp` · Agent discovery — https://agentpulse-43di.onrender.com/llms.txt · Registry metadata — [`server.json`](server.json)

A status answer looks like this (shape-accurate; live answers carry only real ingested data):

```json
{
  "service": "stripe",
  "status": "operational",
  "updated_at": "2026-11-22T06:59:34.583Z",
  "active_incidents": [],
  "recent_breaking_changes": []
}
```

When something is wrong, `active_incidents` carries entries with `severity` (`minor` / `major` / `critical`), an affected `scope`, a plain-language `summary`, and an `agent_hint` — the prescriptive next step for an automated caller.

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
        A1["Vendor status feeds (Statuspage API)"]
        A2["OpenAPI spec diffs (hourly)"]
        A3["Synthetic HTTP health probes"]
        A4["Crowdsourced agent telemetry"]
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
- **OpenAPI spec-diff worker** — hourly, fetches tracked vendors' published OpenAPI specs, hashes them (SHA-256), and diffs any changed spec against the last snapshot (details in §2). The first fetch of a spec is a baseline — no changes are emitted.
- **Synthetic probes** — every ingestion cycle (60 seconds by default) issues a real HTTP health check per service against its healthcheck URL and records the measured latency; a failed probe against a service currently marked operational raises a `major` incident. Unreachable probes never overwrite the last real measurement.
- **Agent telemetry** — registered agents report runtime failures they observe (see §3); clustered reports trigger an out-of-cycle spec re-check.

All network workers fail gracefully: a failed fetch or parse is logged and skipped, never crashing the server.

**Tracked services — 37, status + incidents:** Stripe, OpenAI, Anthropic, GitHub, AWS, Supabase, Vercel, Cloudflare, Resend, Datadog, Pinecone, npm, Twilio, Discord, Sentry, MongoDB Atlas, DigitalOcean, CircleCI, Bitbucket, Zoom, Cohere, Clerk, Render, Fly.io, Snowflake, Elastic Cloud, Postman, Shopify, ElevenLabs, Convex, Linode, Atlassian, Jira, Dropbox, Box, Figma, Airtable. Every vendor was added only after its live `<base>/api/v2/summary.json` feed was fetched and verified to return valid Statuspage summary JSON.

### 2. Breaking-change detection — the spec differ

The differ compares each newly fetched OpenAPI spec against the stored snapshot and classifies every difference. **Fourteen breaking kinds** are detected and stored:

| # | Kind | # | Kind |
| :--- | :--- | :--- | :--- |
| 1 | `removed_path` | 8 | `removed_response_property` |
| 2 | `removed_operation` | 9 | `new_required_request_property` |
| 3 | `removed_parameter` | 10 | `request_property_now_required` |
| 4 | `new_required_parameter` | 11 | `request_property_type_changed` |
| 5 | `parameter_now_required` | 12 | `response_property_type_changed` |
| 6 | `parameter_type_changed` | 13 | `removed_response` (success response removed) |
| 7 | `removed_request_property` | 14 | `removed_enum_value` |

- **Recursive, not top-level.** Property diffing recurses into nested objects and array `items`, emitting dotted locations (`customer.email`, `line_items[].qty`), follows local `$ref`s to their real schemas (depth-capped, with circular-`$ref` protection), and detects enum values removed from properties *and* parameters. Dropping an enum entirely counts as widening, not breaking.
- **Structured storage.** Every stored breaking change carries its `kind` and `location` (e.g. `GET /v1/charges response property customer.email`) as first-class columns — the same precision the differ computed, not re-parsed from prose. Playbooks prefer the stored kind/location; a regex fallback classifies legacy rows.
- **Non-breaking changes** (added paths/operations/optional parameters, nested additions) are logged, not stored as breaking changes.

**Spec-diff coverage — 15 services:** Bitbucket, Box, CircleCI, Cloudflare, Discord, Elastic (Elasticsearch API), ElevenLabs, GitHub, Jira, Linode, OpenAI, Stripe, Supabase (Management API), Twilio, Vercel. Every registered spec URL was verified live to return a JSON OpenAPI document before being added. Coverage is bounded by what vendors publish: services whose vendors ship YAML-only specs (e.g. Datadog, MongoDB Atlas, DigitalOcean) or no OpenAPI spec at all are status-tracked only. The registry can be replaced wholesale via the `SPEC_SOURCES_JSON` env var (slug → spec URL map).

### 3. The telemetry feedback loop — runtime failures talk back

Specs and status pages don't catch everything: a vendor can silently tighten a rate limit or change an error shape while its spec and status stay green. Agents that observe runtime failures report them, and AgentPulse closes the loop:

- **Report** via the MCP tool `report_outage_signal` or `POST /v1/telemetry/report` (API key required; the call is quota-counted like other identified calls). Reports land in the `outage_signals` table.
- **Trigger:** when **≥ 5 signals from ≥ 3 distinct agents** for the same service arrive within **15 minutes**, the loop fires an immediate, out-of-cycle re-check of that service's spec (hash-gated, so an unchanged spec costs one fetch). Thresholds are env-tunable: `TELEMETRY_TRIGGER_MIN_SIGNALS`, `TELEMETRY_TRIGGER_MIN_AGENTS`, `TELEMETRY_TRIGGER_WINDOW_MS`, `TELEMETRY_TRIGGER_COOLDOWN_MS` (15-minute per-service cooldown by default).
- **Outcome:** if the spec changed, the resulting breaking changes flow through the normal pipeline (feeds, verdicts, webhooks). If the spec is **unchanged**, the loop raises exactly one `major` incident whose summary begins **"Behaviour changed, spec didn't: …"** — the failure is real, runtime-observed, and not explained by a spec change — deduplicated against an already-active behaviour incident for that service.

### 4. The engine — turning noise into verdicts

Raw vendor data is normalized into one model: services, incidents (severity `minor` / `major` / `critical`, affected scope, timestamps), and breaking changes (kind, location, summary, provider migration hint). Every status payload gets a SHA-256 **ETag** over its content, which powers the Good Citizen Protocol below. Breaking changes are classified by kind, which later drives the migration playbook template.

### 5. Identity, manifests, and per-agent impact

Any agent can **register** with one POST — no CAPTCHA, no card — and receives an API key (`agp_live_...`). A registered agent can store a **dependency manifest**: the services its stack uses, with optional package/version pins and an optional `endpoints` list — the operations it actually calls on a service, as `"METHOD /path"` or `"/path"` strings.

With a manifest in place, AgentPulse answers the question status pages can't:

> **Affected** = a service in your manifest has an **active incident**, or a **breaking change detected within the last 90 days** — on one of your declared endpoints, when that entry declares endpoints.

**Endpoint matching rule** (deliberately simple): the method must match when the declaration names one; the change's operation path must equal the declared path or sit under it (`/v1/charges` also covers `/v1/charges/{id}`); and a change with no recorded location (persisted before structured locations existed) always matches — history is never filtered away. Entries without endpoints keep service-level relevance.

That verdict appears in preflight responses, in the `scope=mine` changes feed, and in the MCP `get_my_impact` tool; `change.detected` webhook deliveries are narrowed the same way. *(Honest scope note: package/version pins are stored and echoed, but not yet matched against per-version change data. Incidents are matched at service level — endpoint filtering applies to breaking changes.)*

### 6. Migration playbooks — from "it broke" to "here's the fix"

Every breaking change has a playbook at `GET /v1/changes/{id}/playbook`: ordered steps (review the provider's hint → find call sites → apply the fix → add a fallback for removals → add a regression test), before/after code examples **built only from the change's own fields** — replacement endpoints and new semantics are never invented; the playbook defers to the provider's recorded hint — plus an effort estimate (`low` / `medium` / `high`) and risk notes. Change feeds carry only a `playbook_url` pointer, keeping feed payloads inside the token budget.

### 7. The Good Citizen Protocol

Agents that cache politely get rewarded:

- Send `If-None-Match` with the ETag from your last response. If nothing changed, you get **304 Not Modified — 0 body bytes, 0 tokens** — and **+2 Good Citizen score**.
- 304s **never consume quota** and are served even when your quota is exhausted.
- The score is reputational only — it never raises quota at any tier. The free-tier quota is a **flat 100 counted calls/day at every score**; higher volume is a paid tier. (The caching benefit is the 304 exemption itself: unchanged answers are free and uncounted, so 100 counted calls stretch far.)

### 8. Quotas & authentication

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
- **Without the env vars**, none of this is active: plans remain operator-granted via the admin API/page, exactly as before. (The public deployment has live Payment Links configured for Pro and Team.)

### 9. Webhooks — push alerts

Subscribe a URL once; AgentPulse POSTs signed events as they happen: `incident.created`, `incident.resolved`, `change.detected`. Filters: an explicit `services` list wins; no list means all services (the services filter is deliberately *not* intersected with your manifest — set it to your manifest's services if that's what you want). One manifest interaction does apply: for `change.detected`, if your manifest entry for that service declares `endpoints`, only changes on matching operations are delivered. Payloads are HMAC-SHA256 signed (`X-AgentPulse-Signature`), delivered with a 5-second timeout and up to 3 attempts with backoff, and every attempt is recorded in a delivery log you can inspect. URLs must be `https://` (plain `http://` only for localhost, for development). The signing secret is shown **once**, in the create response.

### 10. The dashboard — live data only

The public dashboard at `/` renders **only live-derived data** — a deliberate product rule, enforced by tests:

- The service grid, incident counts, and metrics come from the same `/v1/*` APIs agents use. There are no baked-in placeholder statistics and no fallback dataset: if the API is unreachable, the page shows an explicit "live data unavailable" state rather than invented numbers.
- **Per-service incident visibility:** each service card carries a live incident-count badge when that service has active incidents, and the Active Incidents stat carries a per-service breakdown (e.g. Twilio · 3, Linode · 2) derived from the same incidents payload — so the headline incident total and the number of impacted services always reconcile.
- There is **no uptime figure anywhere**: uptime was never measured, so none is stored or served. Latency shown per service is the last real probe measurement (unmeasured services show none).
- The owner-only `/admin` page (see Owner visibility) renders fleet totals, per-agent usage, and plan controls from the admin APIs.

---

## Interfaces at a glance

| Interface | Path / tool | Purpose |
| :--- | :--- | :--- |
| Discovery | `GET /llms.txt`, `GET /llms-full.txt` | Plain-text capability map for LLM/agent ingestion. |
| Discovery | `GET /openapi.json` | OpenAPI 3.1 schema for automated tool ingestion. |
| Dashboard | `GET /` | Human-facing web dashboard (service grid with per-service incident badges, incident breakdown, telemetry form). |
| Onboarding | `POST /v1/agents/register` | Zero-CAPTCHA registration → free-tier API key (100 req/day). |
| Status | `GET /v1/status/{service}` | Compact health verdict (< 150 tokens), ETag/304 supported. |
| Status | `GET /v1/services`, `GET /v1/incidents`, `GET /v1/metrics` | Catalog (37 services), incident list, aggregate metrics. |
| Preflight | `POST /v1/preflight` | Batch verdict for a list of services; manifest-aware impact for identified callers. |
| Changes | `GET /v1/changes?since=&service=&scope=mine` | Breaking-change delta feed; every change carries `playbook_url`. |
| Playbook | `GET /v1/changes/{id}/playbook` | Full migration playbook for one change (public, cacheable). |
| Manifest | `GET` / `PUT /v1/agents/me/dependencies` | Read / replace-all write of your dependency manifest (auth required). Entries accept `service`, optional `package`/`version`, and optional `endpoints`. |
| Plan | `GET /v1/agents/me/plan` | Your tier, quota usage, and the plan catalog with per-plan `checkout_url` (auth required; not counted). |
| Billing | `POST /v1/billing/webhook` | Stripe event receiver (signature-authenticated; activates/downgrades plans). |
| Webhooks | `POST` / `GET /v1/agents/me/webhooks`, `DELETE /v1/agents/me/webhooks/{id}`, `GET /v1/agents/me/webhooks/{id}/deliveries` | Manage subscriptions and inspect delivery attempts (auth required). |
| Telemetry | `POST /v1/telemetry/report` | Report an observed outage signal (auth required); feeds the telemetry loop in §3. |
| Probes | `POST /v1/synthetic/probe` | Trigger one synthetic health probe (auth required). |
| Stream | `GET /v1/stream` | Server-Sent Events: live incident/change events. |
| MCP | `POST /mcp` | Stateless HTTP MCP server — tools below. |
| SDK | npm `@sriakshat/agentpulse` (source in `sdk/`) | Zero-dependency JavaScript client, published on npm. |

**MCP tools (5):** `check_dependency_health` (batch status), `get_service_status` (single service), `lookup_breaking_changes` (recent changes for a service), `get_my_impact` (manifest-wide affected verdicts), `report_outage_signal` (crowdsourced telemetry; identified caller required). Identity is read from the `Authorization: Bearer <api key>` header (an `api_key` tool argument is accepted as a fallback).

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

```bash
npm install @sriakshat/agentpulse
```

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

Zero dependencies (global `fetch`, Node ≥ 18); non-2xx responses throw `AgentPulseError` with `.status` and `.body`. See [`sdk/README.md`](sdk/README.md).

### Listings

- **Official MCP Registry** — `io.github.Akshat-Srivastava-PS/agentpulse` (v0.1.0), published.
- **Glama** — listed (GitHub connector and hosted-server listings).
- **npm** — SDK published as [`@sriakshat/agentpulse`](https://www.npmjs.com/package/@sriakshat/agentpulse) (v0.1.0).

---

## Quickstart

**Prerequisites:** Node.js 22+. No `npm install` step — the server has **zero external dependencies** (it uses Node's built-in `node:sqlite`).

```bash
git clone https://github.com/Akshat-Srivastava-PS/AgentPulse.git
cd AgentPulse
npm start            # http://localhost:3000 — dashboard at /, API at /v1, MCP at /mcp
npm test             # 95 automated tests (see below)
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
| `PATCH /v1/admin/agents/{id}` | Grant a plan: body `{ "tier": "pro" }` sets the agent's tier and daily quota from the plan catalog (`free_verified` / `pro` / `team`). Unknown tier → 400; unknown agent → 404. |

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
| `TELEMETRY_TRIGGER_MIN_SIGNALS` | `5` | Telemetry loop: signals needed inside the window to trigger a re-check. |
| `TELEMETRY_TRIGGER_MIN_AGENTS` | `3` | Telemetry loop: distinct reporting agents needed. |
| `TELEMETRY_TRIGGER_WINDOW_MS` | `900000` | Telemetry loop: clustering window (15 minutes). |
| `TELEMETRY_TRIGGER_COOLDOWN_MS` | `900000` | Telemetry loop: per-service cooldown between triggers. |
| `WEBHOOK_RETRY_DELAYS_MS` | `1000,5000` | Webhook backoff delays (attempts = delays + 1). |
| `WEBHOOK_TIMEOUT_MS` | `5000` | Per-attempt webhook delivery timeout. |
| `ADMIN_TOKEN` | *(unset)* | Bearer token for the owner-visibility endpoints (`/v1/admin/*`) and the `/admin` page. Unset = admin API disabled (503). |
| `STRIPE_WEBHOOK_SECRET` | *(unset)* | Stripe webhook signing secret for `POST /v1/billing/webhook`. Unset = billing webhook disabled (503). |
| `STRIPE_PAYMENT_LINK_PRO` / `STRIPE_PAYMENT_LINK_TEAM` | *(unset)* | Stripe Payment Link checkout URLs served as per-agent `checkout_url`s by the plan endpoint. Unset = plans stay operator-granted. |

### Tests

`npm test` runs **95 tests** covering: the HTTP API surface, MCP tools, ETag/304 behavior, Good Citizen scoring, token budgets; ingestion (spec-diff classification across all breaking kinds — including recursive nested-property and enum-value diffing — Statuspage mapping, and the registry's shape, fully offline against fixtures); the telemetry feedback loop (threshold clustering, cooldown, unchanged-spec incident); manifests (round-trip, validation, auth, preflight impact, endpoint-level filtering, `scope=mine` filtering, MCP `get_my_impact`); quota enforcement (429 + `Retry-After`, 304 exemption, rate-limit headers, write authentication); webhooks (CRUD, secret handling, HMAC-signed deliveries to a local receiver, filters, endpoint narrowing, retries); dashboard truth (no fabricated metrics, no seeded uptime, per-service incident consistency); and playbooks + the SDK exercised end-to-end against a real local HTTP server.

---

## Data model

Defined in `src/db/schema.sql` (SQLite, WAL mode):

- **`services`** — slug (PK), name, category, current status, last measured latency, ETag, updated_at. (No uptime column — uptime is not measured, so it is not stored.)
- **`incidents`** — id (PK), service, severity, affected scope, agent summary + hint, started/resolved timestamps.
- **`breaking_changes`** — id (PK), service, change type, structured `kind` + `location`, diff summary, migration hint, detected_at.
- **`spec_snapshots`** — service, spec URL, SHA-256 hash, raw spec; latest row per service/URL is the diff baseline.
- **`agent_clients`** — id (PK), API-key hash, agent name, operator URL, tier, daily quota, Good Citizen score, Stripe customer/subscription ids (set by billing activation).
- **`agent_dependencies`** — agent × service manifest rows (optional package/version pins, optional JSON `endpoints` list), unique per pair.
- **`agent_webhooks`** — agent, URL, event/service filters, signing secret, active flag.
- **`webhook_deliveries`** — per-attempt delivery log: exact signed payload, status, attempts, last HTTP status/error.
- **`synthetic_probes`** / **`outage_signals`** — probe results and crowdsourced telemetry (the telemetry loop reads `outage_signals` for clustering).
- **`request_log`** — one row per API/MCP call for owner visibility: agent (null when anonymous), method, path, status, quota-counted flag, timestamp; pruned to 7 days.
- **`billing_links`** — subscription id (PK) → Stripe customer id, tier, agent id: the two event halves of a paid plan, joined by the webhook.
- **`billing_events`** — processed Stripe event ids (PK) + received-at timestamp, for webhook dedupe.

## Project layout

```
src/
  server.js          HTTP server, routing, quota/auth middleware
  db/                SQLite layer + schema.sql
  engine/            diff engine, severity/hints, playbooks, plans, endpoint matching
  workers/           statuspage poller, spec-diff, telemetry loop, webhook dispatcher, probes
  discovery/         llms.txt + OpenAPI generators
  mcp/               MCP server (5 tools)
  public/            dashboard + admin page (live data only)
sdk/                 @sriakshat/agentpulse (zero-dependency JS client, published on npm)
tests/               node:test suites (95 tests)
Dockerfile           node:22-alpine, non-root, healthcheck on /v1/metrics
```

## Status & honest limitations

AgentPulse is live and fully tested (95/95 tests). Known limitations, stated plainly:

- **Hosting:** the public deployment runs on Render's free tier — it **sleeps when idle** (first request after a nap takes ~a minute) and the local SQLite database is **ephemeral across redeploys**. A paid tier / external database is the production path.
- **Incident relevance is service-level.** Endpoint-level filtering applies to *breaking changes* (impact verdicts, `scope=mine`, webhooks); an incident on any part of a service in your manifest still marks that service affected.
- **Spec-diff coverage is partial**: 15 of the 37 tracked services publish a JSON OpenAPI spec and are diffed hourly; the rest are status-tracked only (YAML-only or no published spec).
- **Impact is not version-level**: package/version pins in manifests are stored and echoed, but not yet matched against per-version change data.
- **No sample data, ever.** The service serves only live-ingested data: a fresh install's catalog starts with zero incidents and zero breaking changes, and the first Statuspage poll (within one poll interval — 5 minutes by default) populates real incidents, while the spec-diff worker adds real breaking changes as vendor specs change. Until the first poll lands, services honestly report `operational` with empty incident lists, and dashboard counters derived from real request logs read 0.

## License

MIT. Crafted for the autonomous agent era.
